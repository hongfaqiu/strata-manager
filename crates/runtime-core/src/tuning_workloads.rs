//! Bounded complete workloads used by the journaled tuning orchestrator.
//! Responses, prompts, images and tool arguments exist only in memory. Reports
//! contain timings, usage and quality outcomes, never generated source/text.
use crate::{http, types::ServiceProfile, RuntimeState};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, time::Duration};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::Parameters;

pub const VERSION: &str = "complete-workloads-v2";
const MAX_STREAM_BYTES: usize = 2 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 256 * 1024;
const MAX_TOOL_BYTES: usize = 24 * 1024;
const MAX_TOOLS: usize = 4;
const MAX_DOCUMENT_BYTES: usize = 1024 * 1024;
#[cfg(test)]
const CORRECT_SOURCE: &str = "def merge_sorted(a, b):\n    \"\"\"Merge sorted integer lists without modifying inputs.\"\"\"\n    out = []\n    i = j = 0\n    while i < len(a) and j < len(b):\n        if a[i] <= b[j]:\n            out.append(a[i]); i += 1\n        else:\n            out.append(b[j]); j += 1\n    return out + a[i:] + b[j:]\nassert merge_sorted([1], [1]) == [1, 1]\nassert merge_sorted([], [1]) == [1]\n";
const BROKEN_SOURCE: &str = "def merge_sorted(a, b):\n    \"\"\"Merge sorted lists without changing their inputs.\"\"\"\n    return []\nassert merge_sorted([], []) == []\nassert merge_sorted([], []) == []\n";
const AGENT_FINAL_INSTRUCTION: &str = "The test_fixture tool has now reported passed=true for all 46 cases. The coding task is finished. Your next and final assistant response must be exactly {\"status\":\"fixed\",\"file\":\"merge.py\",\"tests\":\"passed\"}. Return only this JSON object, with no Markdown, explanation, code, extra fields or further tool calls.";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UseCase {
    Chat,
    Agent,
    LongDocument,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkloadKind {
    ColdInput,
    HotPrefix,
    SessionSwitch,
    SustainedGeneration,
    FullAgent,
    LongRetrieval,
    Vision,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadOptions {
    pub use_case: UseCase,
    pub context_limit: usize,
    pub include_vision: bool,
    pub max_output_tokens: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadSpec {
    pub id: String,
    pub use_case: UseCase,
    pub kind: WorkloadKind,
    pub target_input_tokens: Option<usize>,
}

pub fn plan(options: &WorkloadOptions) -> Result<Vec<WorkloadSpec>, String> {
    if !(1024..=4096).contains(&options.max_output_tokens)
        || !(4096..=1_048_576).contains(&options.context_limit)
    {
        return Err("完整场景需要 1024–4096 输出预算及有效上下文上限".into());
    }
    let long_targets: Vec<_> = [16_384usize, 32_768, 65_536]
        .into_iter()
        .filter(|target| target + options.max_output_tokens + 1024 <= options.context_limit)
        .collect();
    if options.use_case == UseCase::LongDocument && long_targets.is_empty() {
        return Err("现有上下文不足以完成 16K 长文及回答预算，请先选择容量方案".into());
    }
    let kinds = match options.use_case {
        UseCase::Chat => vec![
            WorkloadKind::ColdInput,
            WorkloadKind::HotPrefix,
            WorkloadKind::SessionSwitch,
            WorkloadKind::SustainedGeneration,
        ],
        UseCase::Agent => vec![WorkloadKind::FullAgent, WorkloadKind::SessionSwitch],
        UseCase::LongDocument => vec![WorkloadKind::HotPrefix, WorkloadKind::SessionSwitch],
    };
    let mut specs: Vec<_> = kinds
        .into_iter()
        .map(|kind| WorkloadSpec {
            id: serde_json::to_value(kind)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned(),
            use_case: options.use_case,
            kind,
            target_input_tokens: if options.use_case == UseCase::LongDocument {
                long_targets.last().copied()
            } else {
                None
            },
        })
        .collect();
    if options.use_case == UseCase::LongDocument {
        for target in long_targets {
            specs.push(WorkloadSpec {
                id: format!("long-retrieval-{target}"),
                use_case: options.use_case,
                kind: WorkloadKind::LongRetrieval,
                target_input_tokens: Some(target),
            });
        }
    }
    if options.include_vision {
        specs.push(WorkloadSpec {
            id: "vision-quadrants-n7".into(),
            use_case: options.use_case,
            kind: WorkloadKind::Vision,
            target_input_tokens: None,
        });
    }
    Ok(specs)
}

/// Generation calls; token-count calibration and resource GETs are separately
/// reported because their count depends on the installed tokenizer and latency.
pub fn expected_request_count(spec: &WorkloadSpec) -> usize {
    match spec.kind {
        WorkloadKind::ColdInput | WorkloadKind::HotPrefix => 2,
        WorkloadKind::SessionSwitch => 3,
        WorkloadKind::FullAgent => 4,
        _ => 1,
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Turn {
    wall_ms: f64,
    first_token_ms: Option<f64>,
    first_visible_ms: Option<f64>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cached_tokens: Option<u64>,
    prompt_ms: Option<f64>,
    decode_ms: Option<f64>,
    decode_tok_s: Option<f64>,
    finish: Option<String>,
    complete: bool,
}

#[derive(Default)]
struct Collected {
    turn: Turn,
    text: String,
    tools: BTreeMap<u64, ToolCall>,
    done: bool,
}

#[derive(Default)]
struct ToolCall {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Clone, Copy)]
enum Dialect {
    OpenAi,
    OpenAiJson,
    Anthropic,
}

struct Execution<'a> {
    state: &'a RuntimeState,
    profile: &'a ServiceProfile,
    parameters: Parameters,
    maintenance_token: &'a str,
    options: &'a WorkloadOptions,
    cancel: &'a CancellationToken,
    turns: Vec<Turn>,
    request_count: usize,
    count_requests: usize,
    actual_context_tokens: Option<u64>,
    quality_diagnostic: Option<QualityDiagnostic>,
    nonce: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QualityDiagnostic {
    stage: &'static str,
    code: &'static str,
    detail: &'static str,
}

fn validate_agent_source(
    execution: &mut Execution<'_>,
    source: &str,
    stage: &'static str,
) -> Result<(), String> {
    super::quality::validate_merge_sorted(source).map_err(|error| {
        execution.quality_diagnostic = Some(QualityDiagnostic {
            stage,
            code: error.code(),
            detail: error.reason(),
        });
        "qualityAgentPatchFailed".into()
    })
}

fn finite(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite() && *n >= 0.0)
}

fn strict_object<'a>(
    value: &'a Value,
    keys: &[&str],
) -> Result<&'a serde_json::Map<String, Value>, String> {
    let object = value.as_object().ok_or("qualityObjectRequired")?;
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return Err("qualityUnexpectedFields".into());
    }
    Ok(object)
}

fn json_answer(text: &str) -> Result<Value, String> {
    serde_json::from_str(text.trim()).map_err(|_| "qualityInvalidJson".into())
}

fn apply_event(
    collected: &mut Collected,
    event: &Value,
    dialect: Dialect,
    start: Instant,
) -> Result<(), String> {
    if event.get("error").is_some() || event["type"] == "error" {
        return Err("workloadStreamError".into());
    }
    let elapsed = || start.elapsed().as_secs_f64() * 1000.0;
    match dialect {
        Dialect::OpenAi | Dialect::OpenAiJson => {
            if let Some(choice) = event
                .get("choices")
                .and_then(Value::as_array)
                .and_then(|choices| choices.first())
            {
                let delta = &choice["delta"];
                let text = delta["content"].as_str().unwrap_or("");
                let reasoning = delta["reasoning_content"].as_str().unwrap_or("");
                let calls = delta["tool_calls"].as_array();
                if !text.is_empty() || !reasoning.is_empty() {
                    super::live::on_delta();
                }
                if (!text.is_empty()
                    || !reasoning.is_empty()
                    || calls.is_some_and(|v| !v.is_empty()))
                    && collected.turn.first_token_ms.is_none()
                {
                    collected.turn.first_token_ms = Some(elapsed());
                }
                if !text.is_empty() {
                    collected.turn.first_visible_ms.get_or_insert_with(elapsed);
                    collected.text.push_str(text);
                }
                if let Some(calls) = calls {
                    for call in calls {
                        let index = call["index"].as_u64().ok_or("workloadToolIndexRequired")?;
                        if index >= MAX_TOOLS as u64 {
                            return Err("workloadTooManyTools".into());
                        }
                        let existing = collected.tools.entry(index).or_default();
                        if let Some(id) = call["id"].as_str() {
                            if id.is_empty()
                                || id.len() > 256
                                || (!existing.id.is_empty() && existing.id != id)
                            {
                                return Err("workloadToolIdentityChanged".into());
                            }
                            existing.id = id.into();
                        }
                        if let Some(name) = call["function"]["name"].as_str() {
                            existing.name.push_str(name);
                        }
                        if let Some(arguments) = call["function"]["arguments"].as_str() {
                            existing.arguments.push_str(arguments);
                        }
                        if existing.name.len() > 64 || existing.arguments.len() > MAX_TOOL_BYTES {
                            return Err("workloadToolTooLarge".into());
                        }
                    }
                }
                if let Some(finish) = choice["finish_reason"].as_str() {
                    collected.turn.finish = Some(finish.into());
                }
            }
            if let Some(usage) = event.get("usage") {
                collected.turn.input_tokens = usage["prompt_tokens"].as_u64();
                collected.turn.output_tokens = usage["completion_tokens"].as_u64();
                collected.turn.cached_tokens =
                    usage["prompt_tokens_details"]["cached_tokens"].as_u64();
            }
            if let Some(timings) = event.get("timings") {
                collected.turn.prompt_ms = finite(&timings["prompt_ms"]);
                collected.turn.decode_ms = finite(&timings["predicted_ms"]);
                collected.turn.decode_tok_s = finite(&timings["predicted_per_second"]);
            }
        }
        Dialect::Anthropic => match event["type"].as_str().unwrap_or("") {
            "message_start" => {
                let usage = &event["message"]["usage"];
                let uncached = usage["input_tokens"].as_u64();
                let cache = usage["cache_read_input_tokens"].as_u64();
                collected.turn.input_tokens =
                    uncached.map(|n| n.saturating_add(cache.unwrap_or(0)));
                collected.turn.cached_tokens = cache;
            }
            "content_block_delta" => {
                let delta = &event["delta"];
                let text = delta["text"].as_str().unwrap_or("");
                let thinking = delta["thinking"].as_str().unwrap_or("");
                if !text.is_empty() || !thinking.is_empty() {
                    super::live::on_delta();
                }
                if (!text.is_empty() || !thinking.is_empty())
                    && collected.turn.first_token_ms.is_none()
                {
                    collected.turn.first_token_ms = Some(elapsed());
                }
                if !text.is_empty() {
                    collected.turn.first_visible_ms.get_or_insert_with(elapsed);
                    collected.text.push_str(text);
                }
            }
            "message_delta" => {
                if let Some(stop) = event["delta"]["stop_reason"].as_str() {
                    collected.turn.finish = Some(if stop == "end_turn" {
                        "stop".into()
                    } else {
                        stop.into()
                    });
                }
                if let Some(output) = event["usage"]["output_tokens"].as_u64() {
                    collected.turn.output_tokens = Some(output);
                }
                if let Some(cache) = event["usage"]["cache_read_input_tokens"].as_u64() {
                    collected.turn.cached_tokens = Some(cache);
                    if let Some(input) = event["usage"]["input_tokens"].as_u64() {
                        collected.turn.input_tokens = Some(input.saturating_add(cache));
                    }
                }
                if let Some(timings) = event.get("timings") {
                    collected.turn.prompt_ms = finite(&timings["prompt_ms"]);
                    collected.turn.decode_ms = finite(&timings["predicted_ms"]);
                    collected.turn.decode_tok_s = finite(&timings["predicted_per_second"]);
                }
            }
            "message_stop" => collected.done = true,
            _ => {}
        },
    }
    if collected.text.len() > MAX_TEXT_BYTES {
        return Err("workloadTextTooLarge".into());
    }
    Ok(())
}

async fn consume(
    response: reqwest::Response,
    dialect: Dialect,
    start: Instant,
    cancel: &CancellationToken,
) -> Result<Collected, String> {
    if !response.status().is_success() {
        return Err(format!("workloadHttp{}", response.status().as_u16()));
    }
    if !response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/event-stream"))
    {
        return Err("workloadSseRequired".into());
    }
    let mut collected = Collected::default();
    let mut stream = response.bytes_stream();
    let mut utf8 = Vec::new();
    let mut pending = String::new();
    let mut data = String::new();
    let mut total = 0;
    loop {
        let next = tokio::select! { _ = cancel.cancelled() => return Err("workloadCanceled".into()), next = stream.next() => next };
        let Some(next) = next else { break };
        let bytes = next.map_err(|_| "workloadDisconnected")?;
        total += bytes.len();
        if total > MAX_STREAM_BYTES {
            return Err("workloadStreamTooLarge".into());
        }
        pending.push_str(&http::decode_utf8(&mut utf8, &bytes, false)?);
        while let Some(end) = pending.find('\n') {
            let line = pending[..end].trim_end_matches('\r').to_owned();
            pending.drain(..=end);
            if line.is_empty() {
                if data.trim() == "[DONE]" {
                    collected.done = true;
                } else if !data.is_empty() {
                    let event: Value =
                        serde_json::from_str(data.trim()).map_err(|_| "workloadInvalidSseJson")?;
                    apply_event(&mut collected, &event, dialect, start)?;
                }
                data.clear();
            } else if let Some(fragment) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(fragment.trim_start_matches(' '));
            }
        }
    }
    http::decode_utf8(&mut utf8, &[], true)?;
    collected.turn.wall_ms = start.elapsed().as_secs_f64() * 1000.0;
    collected.turn.complete = collected.done
        && matches!(
            collected.turn.finish.as_deref(),
            Some("stop" | "tool_calls")
        );
    if !collected.done || !pending.trim().is_empty() || !data.is_empty() {
        return Err("workloadIncompleteStream".into());
    }
    if !collected.turn.complete {
        return Err("workloadTruncated".into());
    }
    Ok(collected)
}

impl Execution<'_> {
    async fn request(
        &mut self,
        messages: Value,
        tools: Option<Value>,
        dialect: Dialect,
    ) -> Result<Collected, String> {
        let mut body = json!({"messages":messages,"stream":true,"max_tokens":self.options.max_output_tokens,"temperature":0,"top_p":1,"top_k":1,"seed":1,"enable_thinking":false,"reasoning_effort":"none","reasoning_budget_tokens":0,"strata_tune":{"pcie_frac":self.parameters.pcie_frac,"spec_min_p":self.parameters.spec_min_p}});
        if matches!(dialect, Dialect::OpenAiJson) {
            if tools.is_some() {
                return Err("workloadStructuredOutputWithTools".into());
            }
            // Strata 0.1.43 supports json_object without optional jsonschema.
            // Only the tool-free final Agent round uses its format contract;
            // require_answer still checks the complete exact semantic object.
            body["response_format"] = json!({"type":"json_object"});
        }
        if matches!(dialect, Dialect::Anthropic) {
            body["model"] = json!("strata");
            body["thinking"] = json!({"type":"disabled"});
            body.as_object_mut().unwrap().remove("reasoning_effort");
        }
        if let Some(tools) = tools {
            body["tools"] = tools;
            body["tool_choice"] = json!("auto");
        }
        let path = match dialect {
            Dialect::OpenAi | Dialect::OpenAiJson => "/v1/chat/completions",
            Dialect::Anthropic => "/v1/messages",
        };
        let start = Instant::now();
        let builder =
            http::request_builder(&self.state.client, self.profile, path, "POST", Some(body))?
                .header("X-Strata-Manager-Tuning-Id", self.maintenance_token)
                .header("X-Strata-Client", "strata-manager.tuning")
                .timeout(Duration::from_secs(1200));
        self.request_count += 1;
        let response = tokio::select! { _=self.cancel.cancelled()=>return Err("workloadCanceled".into()), result=builder.send()=>result.map_err(|_|"workloadConnectionFailed")? };
        let collected = consume(response, dialect, start, self.cancel).await?;
        self.turns.push(collected.turn.clone_metadata());
        Ok(collected)
    }
}

impl Turn {
    fn clone_metadata(&self) -> Self {
        Self {
            wall_ms: self.wall_ms,
            first_token_ms: self.first_token_ms,
            first_visible_ms: self.first_visible_ms,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cached_tokens: self.cached_tokens,
            prompt_ms: self.prompt_ms,
            decode_ms: self.decode_ms,
            decode_tok_s: self.decode_tok_s,
            finish: self.finish.clone(),
            complete: self.complete,
        }
    }
}

fn ticket_messages(nonce: &str, owner: &str, ticket: &str, count: u64) -> Value {
    json!([{"role":"system","content":format!("Benchmark identifier {nonce}. Ignore that identifier in the answer. You are testing a local model. Follow the explicit constraints. Reply only with the requested JSON, without markdown or extra keys.")},
        {"role":"user","content":format!("Remember ticket {ticket}, owner {owner}, count {count}. Return exactly a JSON object with keys ticket, owner, count and these values.")}])
}

fn require_answer(collected: &Collected, expected: &Value) -> Result<(), String> {
    if !collected.tools.is_empty() || collected.turn.finish.as_deref() != Some("stop") {
        return Err("qualityUnexpectedToolOrFinish".into());
    }
    if json_answer(&collected.text)? != *expected {
        return Err("qualityAnswerMismatch".into());
    }
    Ok(())
}

async fn daily_chat(execution: &mut Execution<'_>) -> Result<(), String> {
    let mut messages = ticket_messages(&execution.nonce, "Mira", "N7", 3);
    let first = execution
        .request(messages.clone(), None, Dialect::OpenAi)
        .await?;
    require_answer(&first, &json!({"ticket":"N7","owner":"Mira","count":3}))?;
    let messages = messages.as_array_mut().unwrap();
    messages.push(json!({"role":"assistant","content":first.text}));
    messages.push(json!({"role":"user","content":"继续使用刚才的信息，数量加二，负责人和编号不变。只返回JSON，三个键必须是编号、负责人、数量；不要英文键或额外说明。"}));
    let second = execution
        .request(Value::Array(messages.clone()), None, Dialect::OpenAi)
        .await?;
    require_answer(&second, &json!({"编号":"N7","负责人":"Mira","数量":5}))
}

async fn hot_prefix(execution: &mut Execution<'_>) -> Result<(), String> {
    let messages = ticket_messages(&execution.nonce, "Mira", "N7", 3);
    for _ in 0..2 {
        let result = execution
            .request(messages.clone(), None, Dialect::OpenAi)
            .await?;
        require_answer(&result, &json!({"ticket":"N7","owner":"Mira","count":3}))?;
    }
    Ok(())
}

async fn session_switch(execution: &mut Execution<'_>) -> Result<(), String> {
    let mut session_a = ticket_messages(&execution.nonce, "Mira", "N7", 3);
    let a = execution
        .request(session_a.clone(), None, Dialect::OpenAi)
        .await?;
    require_answer(&a, &json!({"ticket":"N7","owner":"Mira","count":3}))?;
    let b = execution
        .request(
            ticket_messages(&uuid::Uuid::new_v4().to_string(), "Theo", "Z9", 8),
            None,
            Dialect::OpenAi,
        )
        .await?;
    require_answer(&b, &json!({"ticket":"Z9","owner":"Theo","count":8}))?;
    session_a.as_array_mut().unwrap().extend([
        json!({"role":"assistant","content":a.text}),
        json!({"role":"user","content":"Return the original ticket and owner from THIS conversation, increasing its original count by two. Keep exactly ticket, owner, count JSON keys."}),
    ]);
    let a_followup = execution.request(session_a, None, Dialect::OpenAi).await?;
    require_answer(
        &a_followup,
        &json!({"ticket":"N7","owner":"Mira","count":5}),
    )
}

async fn sustained(execution: &mut Execution<'_>) -> Result<(), String> {
    let response = execution.request(json!([{"role":"user","content":format!("Benchmark identifier {}. Ignore it in the answer. Return only JSON with keys values and total. values must contain all integers from 1 through 128 inclusive, ascending, without omissions or repetition. total must equal their sum. Write the entire array, never use ellipses.",execution.nonce)}]), None, Dialect::OpenAi).await?;
    let answer = json_answer(&response.text)?;
    let object = strict_object(&answer, &["values", "total"])?;
    let values = object["values"]
        .as_array()
        .ok_or("qualitySequenceRequired")?;
    if values.len() != 128
        || values
            .iter()
            .enumerate()
            .any(|(index, value)| value.as_u64() != Some(index as u64 + 1))
        || object["total"].as_u64() != Some(8256)
        || !response.tools.is_empty()
    {
        return Err("qualitySequenceMismatch".into());
    }
    Ok(())
}

fn tool_schema(name: &str, stage: usize) -> Value {
    let (description, properties, required) = match stage {
        0 => ("Read the immutable in-memory merge.py fixture; no filesystem access.", json!({"file":{"type":"string","enum":["merge.py"]}}), json!(["file"])),
        1 => ("Replace the complete in-memory merge.py source, not a diff. source must contain only def merge_sorted(a, b): with no type annotations, a short first docstring, the function body, then exactly two top-level tests of the form assert merge_sorted([integers], [integers]) == [integers]. Use the finite Python subset: integers, lists, local assignments, comparisons, and/or, if/else, while or for, len(), indexing, slices, list append()/extend(), +, +=, and return. No imports, other functions or calls, comprehensions, break/continue, or extra top-level statements. Return plain Python without markdown or explanation. Merge in linear time, preserve inputs, and handle duplicates and empty lists.", json!({"file":{"type":"string","enum":["merge.py"]},"source":{"type":"string","maxLength":16384}}), json!(["file","source"])),
        _ => ("Check the in-memory fixture with a bounded interpreter and deterministic cases; never run a shell or Python process.", json!({"file":{"type":"string","enum":["merge.py"]}}), json!(["file"])),
    };
    json!([{"type":"function","function":{"name":name,"description":description,"parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}}}])
}

async fn full_agent(execution: &mut Execution<'_>) -> Result<(), String> {
    let mut messages = json!([
        {"role":"system","content":format!("Benchmark identifier {}. Ignore it in the answer. Complete this coding task with the offered in-memory tools. You may only call read_fixture, patch_fixture, test_fixture on merge.py. Read before patching, patch before testing. No shell, imports, network, or external files. After a passing test return only {{\"status\":\"fixed\",\"file\":\"merge.py\",\"tests\":\"passed\"}}.",execution.nonce)},
        {"role":"user","content":"Fix merge_sorted in merge.py so it merges sorted integer lists in linear time without modifying inputs; duplicates and empty lists must work. Use the tools and finish after tests pass."}
    ]).as_array().unwrap().clone();
    let mut source = BROKEN_SOURCE.to_owned();
    let mut passed = false;
    let mut ids = std::collections::HashSet::new();
    for (stage, name) in ["read_fixture", "patch_fixture", "test_fixture"]
        .into_iter()
        .enumerate()
    {
        let response = execution
            .request(
                Value::Array(messages.clone()),
                Some(tool_schema(name, stage)),
                Dialect::OpenAi,
            )
            .await?;
        if response.turn.finish.as_deref() != Some("tool_calls") || response.tools.len() != 1 {
            return Err("qualityAgentExpectedTool".into());
        }
        let call = response.tools.values().next().unwrap();
        if call.id.is_empty() || !ids.insert(call.id.clone()) || call.name != name {
            return Err("qualityAgentToolIdentity".into());
        }
        let arguments: Value =
            serde_json::from_str(&call.arguments).map_err(|_| "qualityAgentToolArguments")?;
        let object = strict_object(
            &arguments,
            if stage == 1 {
                &["file", "source"]
            } else {
                &["file"]
            },
        )?;
        if object["file"] != "merge.py" {
            return Err("qualityAgentUnknownFixture".into());
        }
        let result = match stage {
            0 => json!({"file":"merge.py","source":source,"immutableFilesystem":true}),
            1 => {
                let patch = object["source"]
                    .as_str()
                    .ok_or("qualityAgentSourceRequired")?;
                if patch.len() > 16 * 1024 {
                    return Err("qualityAgentSourceTooLarge".into());
                }
                // Validation is the existing finite interpreter, not execution
                // of generated Python. Reject imports/eval/IO before storage.
                validate_agent_source(execution, patch, "patch_fixture")?;
                source = patch.into();
                json!({"file":"merge.py","patched":true})
            }
            _ => {
                passed = validate_agent_source(execution, &source, "test_fixture").is_ok();
                json!({"file":"merge.py","passed":passed,"interpreter":"bounded","cases":46})
            }
        };
        messages.push(json!({"role":"assistant","content":if response.text.is_empty(){Value::Null}else{json!(response.text)},"tool_calls":[{"id":call.id,"type":"function","function":{"name":call.name,"arguments":call.arguments}}]}));
        messages.push(json!({"role":"tool","tool_call_id":call.id,"content":result.to_string()}));
    }
    if !passed {
        return Err("qualityAgentTestsFailed".into());
    }
    let system = messages[0]["content"]
        .as_str()
        .ok_or("qualityAgentFinalContract")?;
    messages[0]["content"] = json!(format!("{system}\n{AGENT_FINAL_INSTRUCTION}"));
    let final_response = execution
        .request(Value::Array(messages), None, Dialect::OpenAiJson)
        .await?;
    require_answer(
        &final_response,
        &json!({"status":"fixed","file":"merge.py","tests":"passed"}),
    )
}

fn document(lines: usize) -> Result<String, String> {
    if !(16..=16_000).contains(&lines) {
        return Err("workloadDocumentBounds".into());
    }
    let mut text = String::new();
    for index in 0..lines {
        if index == lines / 10 {
            text.push_str(
                "FACT_A: ticket N7 belongs to Mira; units are 41; its linked ticket is Z9.\n",
            );
        } else if index == lines / 2 {
            text.push_str("FACT_B: linked ticket Z9 belongs to Theo; units are 59.\n");
        } else if index == lines * 9 / 10 {
            text.push_str(
                "FACT_C: the audit label is LIME-73; final approval cites FACT_A and FACT_B.\n",
            );
        } else {
            text.push_str(&format!("Row {index:05}: inventory review contains routine notes; no ticket, owner, audit or quantity facts are recorded here.\n"));
        }
        if text.len() > MAX_DOCUMENT_BYTES {
            return Err("workloadDocumentTooLarge".into());
        }
    }
    Ok(text)
}

fn document_messages(lines: usize, nonce: &str, alternate: bool) -> Result<Value, String> {
    let mut text = document(lines)?;
    if alternate {
        text = text
            .replace("N7", "P4")
            .replace("Z9", "R2")
            .replace("Mira", "Nora")
            .replace("Theo", "Owen")
            .replace("units are 41", "units are 17")
            .replace("units are 59", "units are 83")
            .replace("LIME-73", "AMBER-42");
    }
    let ticket = if alternate { "P4" } else { "N7" };
    Ok(
        json!([{"role":"user","content":format!("Benchmark identifier {nonce}. Ignore it in the answer. Read the entire document below. Return ONLY JSON with keys ownerA, ownerB, linkedTicket, total, audit, citations. Retrieve ticket {ticket}'s owner, its linked ticket's owner, the linked ticket code, the sum of both quantities, and the audit label. citations must be exactly [\"FACT_A\",\"FACT_B\",\"FACT_C\"]. Do not infer facts from filler.\n<DOCUMENT>\n{text}</DOCUMENT>")}]),
    )
}

async fn bounded_json(
    mut response: reqwest::Response,
    max: usize,
    cancel: &CancellationToken,
) -> Result<Value, String> {
    if !response.status().is_success() {
        return Err("workloadMetadataHttpFailed".into());
    }
    let mut bytes = Vec::new();
    loop {
        let next = tokio::select! { _=cancel.cancelled()=>return Err("workloadCanceled".into()), result=response.chunk()=>result.map_err(|_|"workloadMetadataDisconnected")? };
        let Some(chunk) = next else { break };
        if bytes.len() + chunk.len() > max {
            return Err("workloadMetadataTooLarge".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "workloadMetadataInvalidJson".into())
}

impl Execution<'_> {
    async fn count_tokens(&mut self, messages: &Value) -> Result<u64, String> {
        let body = json!({"model":"strata","messages":messages,"max_tokens":self.options.max_output_tokens,"temperature":0,"enable_thinking":false,"thinking":{"type":"disabled"},"reasoning_budget_tokens":0});
        let request = http::request_builder(
            &self.state.client,
            self.profile,
            "/v1/messages/count_tokens",
            "POST",
            Some(body),
        )?
        .header("X-Strata-Manager-Tuning-Id", self.maintenance_token)
        .header("X-Strata-Client", "strata-manager.tuning")
        .timeout(Duration::from_secs(30));
        self.count_requests += 1;
        let response = tokio::select! { _=self.cancel.cancelled()=>return Err("workloadCanceled".into()), result=request.send()=>result.map_err(|_|"workloadCountFailed")? };
        bounded_json(response, 4096, self.cancel).await?["input_tokens"]
            .as_u64()
            .filter(|n| *n > 0)
            .ok_or("workloadCountMissing".into())
    }
}

async fn prepare_document(
    execution: &mut Execution<'_>,
    target: usize,
    alternate: bool,
    nonce: &str,
) -> Result<(Value, u64), String> {
    let mut lines = (target / 30).max(16);
    let mut selected = None;
    // Calibrate with the actual installed tokenizer. The same message value is
    // then handed to generation; no byte-count token estimate is reported.
    for _ in 0..6 {
        let messages = document_messages(lines, nonce, alternate)?;
        let count = execution.count_tokens(&messages).await?;
        if count as usize + execution.options.max_output_tokens + 256
            > execution.options.context_limit
        {
            return Err("workloadContextWouldOverflow".into());
        }
        if count >= target as u64 && count <= (target + target / 10) as u64 {
            selected = Some((messages, count));
            break;
        }
        let next = ((lines as u128 * target as u128 * 102) / (count as u128 * 100)) as usize;
        lines = if next == lines {
            lines + 1
        } else {
            next.clamp(16, 16_000)
        };
    }
    let (messages, counted) = selected.ok_or("workloadTokenTargetNotReached")?;
    execution.actual_context_tokens =
        Some(execution.actual_context_tokens.unwrap_or(0).max(counted));
    Ok((messages, counted))
}

fn check_document(response: &Collected, counted: u64, alternate: bool) -> Result<(), String> {
    let expected = if alternate {
        json!({"ownerA":"Nora","ownerB":"Owen","linkedTicket":"R2","total":100,"audit":"AMBER-42","citations":["FACT_A","FACT_B","FACT_C"]})
    } else {
        json!({"ownerA":"Mira","ownerB":"Theo","linkedTicket":"Z9","total":100,"audit":"LIME-73","citations":["FACT_A","FACT_B","FACT_C"]})
    };
    require_answer(response, &expected)?;
    if response.turn.input_tokens != Some(counted) {
        return Err("qualityCountGenerationMismatch".into());
    }
    Ok(())
}

async fn long_retrieval(execution: &mut Execution<'_>, target: usize) -> Result<(), String> {
    let nonce = execution.nonce.clone();
    let (messages, counted) = prepare_document(execution, target, false, &nonce).await?;
    let response = execution
        .request(messages, None, Dialect::Anthropic)
        .await?;
    check_document(&response, counted, false)
}

async fn long_hot_prefix(execution: &mut Execution<'_>, target: usize) -> Result<(), String> {
    let nonce = execution.nonce.clone();
    let (messages, counted) = prepare_document(execution, target, false, &nonce).await?;
    for _ in 0..2 {
        let response = execution
            .request(messages.clone(), None, Dialect::Anthropic)
            .await?;
        check_document(&response, counted, false)?;
    }
    Ok(())
}

async fn long_session_switch(execution: &mut Execution<'_>, target: usize) -> Result<(), String> {
    let nonce = execution.nonce.clone();
    let (mut a, counted_a) = prepare_document(execution, target, false, &nonce).await?;
    let response_a = execution
        .request(a.clone(), None, Dialect::Anthropic)
        .await?;
    check_document(&response_a, counted_a, false)?;
    let (b, counted_b) =
        prepare_document(execution, target, true, &uuid::Uuid::new_v4().to_string()).await?;
    let response_b = execution.request(b, None, Dialect::Anthropic).await?;
    check_document(&response_b, counted_b, true)?;
    a.as_array_mut().unwrap().extend([
        json!({"role":"assistant","content":response_a.text}),
        json!({"role":"user","content":"Repeat the same original document facts and their citations. Return exactly the same JSON keys and values, using THIS conversation's document."}),
    ]);
    let count = execution.count_tokens(&a).await?;
    if count as usize + execution.options.max_output_tokens + 256 > execution.options.context_limit
    {
        return Err("workloadContextWouldOverflow".into());
    }
    execution.actual_context_tokens = Some(execution.actual_context_tokens.unwrap_or(0).max(count));
    let response = execution.request(a, None, Dialect::Anthropic).await?;
    check_document(&response, count, false)?;
    Ok(())
}

async fn vision(execution: &mut Execution<'_>) -> Result<(), String> {
    let encoded = STANDARD.encode(include_bytes!("tuning_workload_fixtures/vision-n7.png"));
    let response = execution.request(json!([{"role":"user","content":[
        {"type":"image_url","image_url":{"url":format!("data:image/png;base64,{encoded}")}},
        {"type":"text","text":"Inspect the picture. Reply only JSON with exactly left, right, label. Name the left and right background colors in English lowercase, and transcribe the two white characters."}
    ]}]), None, Dialect::OpenAi).await?;
    require_answer(
        &response,
        &json!({"left":"red","right":"blue","label":"N7"}),
    )
}

async fn dispatch(execution: &mut Execution<'_>, spec: &WorkloadSpec) -> Result<(), String> {
    match spec.kind {
        WorkloadKind::ColdInput => daily_chat(execution).await,
        WorkloadKind::HotPrefix => {
            if let Some(target) = spec.target_input_tokens {
                long_hot_prefix(execution, target).await
            } else {
                hot_prefix(execution).await
            }
        }
        WorkloadKind::SessionSwitch => {
            if let Some(target) = spec.target_input_tokens {
                long_session_switch(execution, target).await
            } else {
                session_switch(execution).await
            }
        }
        WorkloadKind::SustainedGeneration => sustained(execution).await,
        WorkloadKind::FullAgent => full_agent(execution).await,
        WorkloadKind::LongRetrieval => {
            long_retrieval(
                execution,
                spec.target_input_tokens.ok_or("workloadTargetRequired")?,
            )
            .await
        }
        WorkloadKind::Vision => vision(execution).await,
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Resources {
    scope: &'static str,
    data_scope: &'static str,
    sample_count: usize,
    ram_used_bytes: Option<u64>,
    gpu_memory_used_bytes: Option<u64>,
    telemetry_available: bool,
}

async fn sample_resources(
    state: &RuntimeState,
    profile: &ServiceProfile,
    token: &str,
    done: &CancellationToken,
    cancel: &CancellationToken,
) -> Resources {
    let mut result = Resources {
        scope: "workload",
        data_scope: "systemAndPrimaryGpu",
        ..Resources::default()
    };
    loop {
        if done.is_cancelled() || cancel.is_cancelled() {
            break;
        }
        let request =
            http::request_builder(&state.client, profile, "/metrics", "GET", None).map(|request| {
                request
                    .header("X-Strata-Manager-Tuning-Id", token)
                    .timeout(Duration::from_secs(2))
            });
        if let Ok(request) = request {
            let response = tokio::select! { _=done.cancelled()=>break, _=cancel.cancelled()=>break, response=request.send()=>response };
            if let Ok(response) = response {
                let metrics = tokio::select! {
                    _ = done.cancelled() => break,
                    result = bounded_json(response, 256 * 1024, cancel) => result
                };
                if let Ok(metrics) = metrics {
                    result.sample_count += 1;
                    let ram = metrics["hardware"]["ram_used"].as_u64();
                    let gpu = metrics["hardware"]["gpu_mem_used"].as_u64();
                    result.telemetry_available |= ram.is_some() || gpu.is_some();
                    if let Some(ram) = ram {
                        result.ram_used_bytes = Some(result.ram_used_bytes.unwrap_or(0).max(ram));
                    }
                    if let Some(gpu) = gpu {
                        result.gpu_memory_used_bytes =
                            Some(result.gpu_memory_used_bytes.unwrap_or(0).max(gpu));
                    }
                }
            }
        }
        tokio::select! { _=done.cancelled()=>break, _=cancel.cancelled()=>break, _=tokio::time::sleep(Duration::from_secs(2))=>{} }
    }
    result
}

fn total_known(turns: &[Turn], field: impl Fn(&Turn) -> Option<u64>) -> Option<u64> {
    let mut total = 0u64;
    for turn in turns {
        total = total.checked_add(field(turn)?)?;
    }
    (!turns.is_empty()).then_some(total)
}

/// The caller owns admission, identity checks, configuration journal and model
/// reloads. `freshly_loaded` must describe an actually verified caller reload.
/// This function never loads/unloads, restarts, or cancels somebody else's work.
#[allow(clippy::too_many_arguments)]
pub async fn run_workload(
    state: &RuntimeState,
    profile: &ServiceProfile,
    parameters: Parameters,
    maintenance_token: &str,
    spec: &WorkloadSpec,
    options: &WorkloadOptions,
    cancel: &CancellationToken,
    freshly_loaded: bool,
) -> Result<Value, String> {
    let valid = plan(options)?;
    if !valid.iter().any(|item| {
        item.id == spec.id
            && item.use_case == spec.use_case
            && item.kind == spec.kind
            && item.target_input_tokens == spec.target_input_tokens
    }) {
        return Err("workloadOutsidePlan".into());
    }
    if ![parameters.pcie_frac, parameters.spec_min_p]
        .into_iter()
        .all(|n| n.is_finite() && (0.0..=1.0).contains(&n))
    {
        return Err("workloadInvalidParameters".into());
    }
    let mut execution = Execution {
        state,
        profile,
        parameters,
        maintenance_token,
        options,
        cancel,
        turns: vec![],
        request_count: 0,
        count_requests: 0,
        actual_context_tokens: None,
        quality_diagnostic: None,
        nonce: uuid::Uuid::new_v4().to_string(),
    };
    let start = Instant::now();
    let done = CancellationToken::new();
    let deadline = Duration::from_secs(if spec.target_input_tokens.is_some() {
        1200
    } else {
        600
    });
    let work = async {
        let result = tokio::time::timeout(deadline, dispatch(&mut execution, spec))
            .await
            .unwrap_or_else(|_| Err("workloadDeadlineExceeded".into()));
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        done.cancel();
        (result, elapsed)
    };
    let ((result, wall_ms), resources) = tokio::join!(
        work,
        sample_resources(state, profile, maintenance_token, &done, cancel)
    );
    let complete = execution.turns.len() == expected_request_count(spec)
        && execution.turns.iter().all(|turn| turn.complete);
    let passed = result.is_ok() && complete;
    Ok(json!({
        "benchmarkVersion":VERSION,"workloadId":spec.id,"useCase":spec.use_case,"kind":spec.kind,
        "qualityPassed":passed,"complete":complete,"qualityReason":result.err(),"wallMs":wall_ms,
        "qualityDetail":execution.quality_diagnostic.as_ref().map(|diagnostic|diagnostic.detail),
        "qualityDiagnostic":execution.quality_diagnostic,
        "fullAgentWallMs":if spec.kind==WorkloadKind::FullAgent {Some(wall_ms)}else{None},
        "coldModelVerified":freshly_loaded && matches!(spec.kind,WorkloadKind::ColdInput|WorkloadKind::SessionSwitch|WorkloadKind::LongRetrieval),
        "firstTokenMs":execution.turns.first().and_then(|turn|turn.first_token_ms),
        "firstVisibleMs":execution.turns.first().and_then(|turn|turn.first_visible_ms),
        "inputTokens":total_known(&execution.turns,|turn|turn.input_tokens),
        "outputTokens":total_known(&execution.turns,|turn|turn.output_tokens),
        "cachedTokens":total_known(&execution.turns,|turn|turn.cached_tokens),
        "finish":execution.turns.last().and_then(|turn|turn.finish.as_deref()),
        "actualContextTokens":execution.actual_context_tokens,"targetInputTokens":spec.target_input_tokens,
        "resourcePeak":resources,"requestCount":execution.request_count,"tokenCountRequests":execution.count_requests,
        "turns":execution.turns,
        "limits":{"maxGenerationRequests":expected_request_count(spec),"deadlineSeconds":deadline.as_secs(),"resourcesAreSampled":true,"modelColdDoesNotProveOsCacheCold":true}
    }))
}

#[cfg(test)]
#[path = "tuning_workloads_tests.rs"]
mod tests;

#[cfg(test)]
mod final_agent_contract_tests {
    use super::*;

    #[test]
    fn final_confirmation_requires_the_entire_exact_object() {
        let expected = json!({"status":"fixed","file":"merge.py","tests":"passed"});
        let response = |text: &str| {
            let mut collected = Collected::default();
            collected.turn.finish = Some("stop".into());
            collected.text = text.into();
            collected
        };
        assert!(require_answer(&response(&expected.to_string()), &expected).is_ok());
        for text in [
            "All 46 tests passed.",
            "All 46 tests passed. {\"status\":\"fixed\",\"file\":\"merge.py\",\"tests\":\"passed\"}",
            "```json\n{\"status\":\"fixed\",\"file\":\"merge.py\",\"tests\":\"passed\"}\n```",
            "{\"status\":\"fixed\",\"file\":\"merge.py\",\"tests\":\"passed\"}{}",
            "{\"status\":\"fixed\",\"file\":\"merge.py\",\"tests\":\"failed\"}",
            "{\"status\":\"fixed\",\"file\":\"merge.py\",\"tests\":\"passed\",\"note\":\"ok\"}",
        ] {
            assert!(require_answer(&response(text), &expected).is_err());
        }
        let mut unexpected_tool = response(&expected.to_string());
        unexpected_tool.tools.insert(0, ToolCall::default());
        assert!(require_answer(&unexpected_tool, &expected).is_err());
    }

    #[tokio::test]
    async fn final_json_format_cannot_be_combined_with_another_tool_request() {
        let temporary = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temporary.path().into()).unwrap();
        let profile: ServiceProfile = serde_json::from_value(json!({"id":"final-json-fixture","name":"fixture","baseUrl":"http://127.0.0.1:1","installDir":"fixture","pythonPath":"fixture","configPath":"fixture","managed":true})).unwrap();
        let options = WorkloadOptions {
            use_case: UseCase::Agent,
            context_limit: 8192,
            include_vision: false,
            max_output_tokens: 1024,
        };
        let cancel = CancellationToken::new();
        let mut execution = Execution {
            state: &state,
            profile: &profile,
            parameters: Parameters {
                pcie_frac: 0.5,
                spec_min_p: 0.5,
            },
            maintenance_token: "fixture",
            options: &options,
            cancel: &cancel,
            turns: vec![],
            request_count: 0,
            count_requests: 0,
            actual_context_tokens: None,
            quality_diagnostic: None,
            nonce: "fixture".into(),
        };
        let error = execution
            .request(
                json!([]),
                Some(tool_schema("test_fixture", 2)),
                Dialect::OpenAiJson,
            )
            .await
            .err()
            .unwrap();
        assert_eq!(error, "workloadStructuredOutputWithTools");
        assert_eq!(execution.request_count, 0);
    }
}
