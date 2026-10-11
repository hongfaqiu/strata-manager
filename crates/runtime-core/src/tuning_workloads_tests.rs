use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
};

struct Request {
    path: String,
    body: Value,
    raw: String,
}
struct Response {
    mime: &'static str,
    body: String,
    delay: Duration,
}
impl Response {
    fn json(body: Value) -> Self {
        Self {
            mime: "application/json",
            body: body.to_string(),
            delay: Duration::ZERO,
        }
    }
    fn sse(body: String) -> Self {
        Self {
            mime: "text/event-stream",
            body,
            delay: Duration::from_millis(20),
        }
    }
}
struct Fixture {
    address: String,
    stop: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
}
impl Fixture {
    fn serve(handler: impl Fn(Request) -> Response + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let handler = Arc::new(handler);
        let join = thread::spawn(move || {
            let mut workers = vec![];
            while !worker_stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        let handler = handler.clone();
                        workers.push(thread::spawn(move||{
                            socket.set_nonblocking(false).unwrap();
                            socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                            let mut bytes=vec![];
                            let mut buf=[0u8;4096];
                            let (header_end,length)=loop {
                                let count=socket.read(&mut buf).unwrap();
                                if count==0 { return; }
                                bytes.extend_from_slice(&buf[..count]);
                                if let Some(pos)=bytes.windows(4).position(|window|window==b"\r\n\r\n") {
                                    let headers=String::from_utf8_lossy(&bytes[..pos]);
                                    let length=headers.lines().find_map(|line|line.to_ascii_lowercase().strip_prefix("content-length:").map(|v|v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                                    break (pos+4,length);
                                }
                                assert!(bytes.len()<16*1024);
                            };
                            while bytes.len()<header_end+length {
                                let count=socket.read(&mut buf).unwrap();
                                if count==0 { return; }
                                bytes.extend_from_slice(&buf[..count]);
                                assert!(bytes.len()<2*1024*1024);
                            }
                            let raw=String::from_utf8_lossy(&bytes).to_string();
                            let path=raw.lines().next().unwrap().split_whitespace().nth(1).unwrap().to_string();
                            let body=if length==0 {Value::Null}else{serde_json::from_slice(&bytes[header_end..header_end+length]).unwrap()};
                            let response=handler(Request{path,body,raw});
                            let header=format!("HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",response.mime,response.body.len());
                            if socket.write_all(header.as_bytes()).is_err() {return;}
                            thread::sleep(response.delay);
                            // Real TCP fragmentation cuts JSON and UTF-8 bytes.
                            for chunk in response.body.as_bytes().chunks(3) {
                                if socket.write_all(chunk).is_err(){break;}
                            }
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(error) => panic!("fixture accept: {error}"),
                }
            }
            for worker in workers {
                worker.join().unwrap();
            }
        });
        Self {
            address,
            stop,
            join: Some(join),
        }
    }
    fn profile(&self) -> ServiceProfile {
        ServiceProfile {
            id: uuid::Uuid::new_v4().to_string(),
            name: "isolated-workload-fixture".into(),
            base_url: format!("http://{}", self.address),
            install_dir: String::new(),
            python_path: String::new(),
            config_path: String::new(),
            managed: true,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(join) = self.join.take() {
            let result = join.join();
            if !thread::panicking() {
                result.unwrap();
            }
        }
    }
}
fn event(value: Value) -> String {
    format!("data: {value}\r\n\r\n")
}
fn text_sse(text: &str, cached: u64) -> String {
    event(json!({"choices":[{"delta":{"reasoning_content":"检查🙂"},"finish_reason":null}]}))
        + &event(json!({"choices":[{"delta":{"content":text},"finish_reason":null}]}))
        + &event(
            json!({"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":200,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":cached}},"timings":{"prompt_ms":12,"predicted_ms":24,"predicted_per_second":40}}),
        )
        + "data: [DONE]\r\n\r\n"
}
fn tool_sse(name: &str, id: &str, args: Value) -> String {
    let arguments = args.to_string();
    let half = arguments.len() / 2;
    event(
        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":id,"type":"function","function":{"name":name,"arguments":&arguments[..half]}}]},"finish_reason":null}]}),
    ) + &event(
        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":&arguments[half..]}}]},"finish_reason":null}]}),
    ) + &event(
        json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":300,"completion_tokens":120,"prompt_tokens_details":{"cached_tokens":180}}}),
    ) + "data: [DONE]\r\n\r\n"
}
fn metrics() -> Response {
    Response::json(
        json!({"hardware":{"ram_used":123456789,"gpu_mem_used":98765432},"history":[{"prompt":"SHOULD_NEVER_ENTER_REPORT","gpu_mem_used":99999999999u64}]}),
    )
}
fn options(use_case: UseCase) -> WorkloadOptions {
    WorkloadOptions {
        use_case,
        context_limit: 131072,
        include_vision: false,
        max_output_tokens: 2048,
    }
}
async fn run(fixture: &Fixture, options: &WorkloadOptions, kind: WorkloadKind) -> Value {
    let temporary = tempfile::tempdir().unwrap();
    let state = RuntimeState::open(temporary.path().into()).unwrap();
    let profile = fixture.profile();
    let spec = plan(options)
        .unwrap()
        .into_iter()
        .find(|spec| spec.kind == kind)
        .unwrap();
    run_workload(
        &state,
        &profile,
        Parameters {
            pcie_frac: 0.2,
            spec_min_p: 0.5,
        },
        "fixture-maintenance",
        &spec,
        options,
        &CancellationToken::new(),
        true,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn complete_agent_preserves_tool_ids_and_arguments_across_real_http_turns() {
    let stage = Arc::new(AtomicUsize::new(0));
    let observer = stage.clone();
    let fixture = Fixture::serve(move |request| {
        if request.path == "/metrics" {
            return metrics();
        }
        assert_eq!(request.path, "/v1/chat/completions");
        assert!(request
            .raw
            .to_lowercase()
            .contains("x-strata-manager-tuning-id: fixture-maintenance"));
        assert!(request.body.get("strata_checkpoint").is_none());
        assert_eq!(request.body["strata_tune"]["pcie_frac"], 0.2);
        let stage = observer.fetch_add(1, Ordering::SeqCst);
        let messages = request.body["messages"].as_array().unwrap();
        if stage > 0 {
            let previous = &messages[messages.len() - 2];
            let tool = &messages[messages.len() - 1];
            assert_eq!(previous["role"], "assistant");
            assert_eq!(tool["role"], "tool");
            assert_eq!(previous["tool_calls"][0]["id"], tool["tool_call_id"]);
            let args: Value = serde_json::from_str(
                previous["tool_calls"][0]["function"]["arguments"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(args["file"], "merge.py");
        }
        Response::sse(match stage {
            0 => {
                assert_eq!(messages.len(), 2);
                tool_sse("read_fixture", "call-read", json!({"file":"merge.py"}))
            }
            1 => {
                let result: Value =
                    serde_json::from_str(messages.last().unwrap()["content"].as_str().unwrap())
                        .unwrap();
                assert!(result["source"].as_str().unwrap().contains("return []"));
                tool_sse(
                    "patch_fixture",
                    "call-patch",
                    json!({"file":"merge.py","source":CORRECT_SOURCE}),
                )
            }
            2 => {
                let result: Value =
                    serde_json::from_str(messages.last().unwrap()["content"].as_str().unwrap())
                        .unwrap();
                assert_eq!(result["patched"], true);
                tool_sse("test_fixture", "call-test", json!({"file":"merge.py"}))
            }
            3 => {
                assert!(request.body.get("tools").is_none());
                let result: Value =
                    serde_json::from_str(messages.last().unwrap()["content"].as_str().unwrap())
                        .unwrap();
                assert_eq!(result["passed"], true);
                text_sse(
                    "{\"status\":\"fixed\",\"file\":\"merge.py\",\"tests\":\"passed\"}",
                    180,
                )
            }
            _ => panic!("unbounded agent"),
        })
    });
    let report = run(&fixture, &options(UseCase::Agent), WorkloadKind::FullAgent).await;
    assert_eq!(stage.load(Ordering::SeqCst), 4);
    assert_eq!(report["qualityPassed"], true);
    assert_eq!(report["complete"], true);
    assert_eq!(report["requestCount"], 4);
    assert_eq!(report["turns"].as_array().unwrap().len(), 4);
    assert_eq!(report["cachedTokens"], 720);
    assert!(report["fullAgentWallMs"].as_f64().unwrap() > 0.0);
    let serialized = report.to_string();
    for forbidden in [
        "def merge_sorted",
        "return []",
        "call-patch",
        "SHOULD_NEVER_ENTER_REPORT",
        "reasoning_content",
        "\"source\":",
    ] {
        assert!(!serialized.contains(forbidden), "{forbidden}");
    }
    assert_eq!(report["resourcePeak"]["scope"], "workload");
    assert_eq!(report["resourcePeak"]["dataScope"], "systemAndPrimaryGpu");
    assert_eq!(report["resourcePeak"]["ramUsedBytes"], 123456789);
    assert_eq!(report["resourcePeak"]["gpuMemoryUsedBytes"], 98765432);
}

#[tokio::test]
async fn executable_patch_and_unknown_file_are_rejected_before_another_tool_turn() {
    for malicious in [
        json!({"file":"../../secret.py","source":CORRECT_SOURCE}),
        json!({"file":"merge.py","source":"import os\nos.system('DO_NOT_PERSIST_SECRET')"}),
        json!({"file":"merge.py","source":BROKEN_SOURCE}),
    ] {
        let stage = Arc::new(AtomicUsize::new(0));
        let observer = stage.clone();
        let fixture = Fixture::serve(move |request| {
            if request.path == "/metrics" {
                return metrics();
            }
            let index = observer.fetch_add(1, Ordering::SeqCst);
            Response::sse(if index == 0 {
                tool_sse("read_fixture", "read", json!({"file":"merge.py"}))
            } else {
                assert_eq!(index, 1);
                tool_sse("patch_fixture", "patch", malicious.clone())
            })
        });
        let report = run(&fixture, &options(UseCase::Agent), WorkloadKind::FullAgent).await;
        assert_eq!(report["qualityPassed"], false);
        assert_eq!(report["requestCount"], 2);
        assert_eq!(stage.load(Ordering::SeqCst), 2);
        assert!(!report.to_string().contains("DO_NOT_PERSIST_SECRET"));
    }
}

#[tokio::test]
async fn bilingual_multiturn_constraints_and_hot_prefix_cache_are_real_metadata() {
    let stage = Arc::new(AtomicUsize::new(0));
    let observer = stage.clone();
    let fixture = Fixture::serve(move |request| {
        if request.path == "/metrics" {
            return metrics();
        }
        let index = observer.fetch_add(1, Ordering::SeqCst);
        let messages = request.body["messages"].as_array().unwrap();
        Response::sse(if index == 0 {
            assert_eq!(messages.len(), 2);
            text_sse("{\"ticket\":\"N7\",\"owner\":\"Mira\",\"count\":3}", 0)
        } else {
            assert_eq!(messages.len(), 4);
            assert!(messages.last().unwrap()["content"]
                .as_str()
                .unwrap()
                .contains("数量加二"));
            assert_eq!(messages[2]["role"], "assistant");
            text_sse("{\"编号\":\"N7\",\"负责人\":\"Mira\",\"数量\":5}", 160)
        })
    });
    let report = run(&fixture, &options(UseCase::Chat), WorkloadKind::ColdInput).await;
    assert_eq!(report["qualityPassed"], true);
    assert_eq!(report["cachedTokens"], 160);
    assert_eq!(report["coldModelVerified"], true);
    let requests = Arc::new(Mutex::new(vec![]));
    let captured = requests.clone();
    let fixture = Fixture::serve(move |request| {
        if request.path == "/metrics" {
            return Response::json(json!({}));
        }
        captured
            .lock()
            .unwrap()
            .push(request.body["messages"].clone());
        Response::sse(text_sse(
            "{\"ticket\":\"N7\",\"owner\":\"Mira\",\"count\":3}",
            0,
        ))
    });
    let report = run(&fixture, &options(UseCase::Chat), WorkloadKind::HotPrefix).await;
    assert_eq!(report["qualityPassed"], true);
    assert_eq!(report["cachedTokens"], 0); // zero observed cache is never fabricated into a hit
    assert_eq!(
        run(&fixture, &options(UseCase::Chat), WorkloadKind::HotPrefix).await["qualityPassed"],
        true
    );
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert_eq!(requests[0], requests[1]);
    assert_eq!(requests[2], requests[3]);
    assert_ne!(requests[0], requests[2]);
    assert_eq!(report["resourcePeak"]["ramUsedBytes"], Value::Null);
    assert_eq!(report["resourcePeak"]["gpuMemoryUsedBytes"], Value::Null);
    assert_eq!(report["resourcePeak"]["telemetryAvailable"], false);
}

#[tokio::test]
async fn long_document_uses_actual_token_count_and_identical_messages_for_generation() {
    let counted = Arc::new(Mutex::new(None::<Value>));
    let captured = counted.clone();
    let fixture = Fixture::serve(move |request| {
        if request.path == "/metrics" {
            return metrics();
        }
        if request.path == "/v1/messages/count_tokens" {
            assert!(request.body.get("stream").is_none());
            assert_eq!(request.body["thinking"], json!({"type":"disabled"}));
            let text = request.body["messages"][0]["content"].as_str().unwrap();
            let a = text.find("FACT_A: ticket").unwrap();
            let b = text.find("FACT_B: linked").unwrap();
            let c = text.find("FACT_C: the audit").unwrap();
            assert!(a < b && b < c);
            assert!(a < text.len() / 3 && c > text.len() * 2 / 3);
            *captured.lock().unwrap() = Some(request.body["messages"].clone());
            return Response::json(json!({"input_tokens":16400}));
        }
        assert_eq!(request.path, "/v1/messages");
        assert_eq!(
            request.body["messages"],
            captured.lock().unwrap().as_ref().unwrap().clone()
        );
        assert_eq!(request.body["enable_thinking"], false);
        assert_eq!(request.body["thinking"], json!({"type":"disabled"}));
        let text="{\"ownerA\":\"Mira\",\"ownerB\":\"Theo\",\"linkedTicket\":\"Z9\",\"total\":100,\"audit\":\"LIME-73\",\"citations\":[\"FACT_A\",\"FACT_B\",\"FACT_C\"]}";
        Response::sse(
            event(
                json!({"type":"message_start","message":{"usage":{"input_tokens":16300,"cache_read_input_tokens":100}}}),
            ) + &event(
                json!({"type":"content_block_delta","delta":{"type":"text_delta","text":text}}),
            ) + &event(
                json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":120}}),
            ) + &event(json!({"type":"message_stop"})),
        )
    });
    let report = run(
        &fixture,
        &options(UseCase::LongDocument),
        WorkloadKind::LongRetrieval,
    )
    .await;
    assert_eq!(report["qualityPassed"], true, "{report}");
    assert_eq!(report["actualContextTokens"], 16400, "{report}");
    assert_eq!(report["inputTokens"], 16400);
    assert_eq!(report["cachedTokens"], 100);
    assert_eq!(report["targetInputTokens"], 16384);
    assert_eq!(report["tokenCountRequests"], 1);
    assert!(!report.to_string().contains("inventory review"));
}

#[tokio::test]
async fn wrong_retrieval_or_count_mismatch_cannot_qualify() {
    for (actual, owner) in [(16400, "Wrong"), (16500, "Mira")] {
        let fixture = Fixture::serve(move |request| {
            if request.path == "/metrics" {
                return metrics();
            }
            if request.path == "/v1/messages/count_tokens" {
                return Response::json(json!({"input_tokens":16400}));
            }
            let text=json!({"ownerA":owner,"ownerB":"Theo","linkedTicket":"Z9","total":100,"audit":"LIME-73","citations":["FACT_A","FACT_B","FACT_C"]}).to_string();
            Response::sse(
                event(
                    json!({"type":"message_start","message":{"usage":{"input_tokens":actual,"cache_read_input_tokens":0}}}),
                ) + &event(json!({"type":"content_block_delta","delta":{"text":text}}))
                    + &event(
                        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":100}}),
                    )
                    + &event(json!({"type":"message_stop"})),
            )
        });
        let report = run(
            &fixture,
            &options(UseCase::LongDocument),
            WorkloadKind::LongRetrieval,
        )
        .await;
        assert_eq!(report["qualityPassed"], false);
        assert_eq!(report["complete"], true);
        assert!(report["qualityReason"]
            .as_str()
            .unwrap()
            .starts_with("quality"));
    }
}

#[tokio::test]
async fn actual_token_overflow_is_rejected_before_generation() {
    let generations = Arc::new(AtomicUsize::new(0));
    let capture = generations.clone();
    let fixture = Fixture::serve(move |request| {
        if request.path == "/metrics" {
            return metrics();
        }
        if request.path == "/v1/messages/count_tokens" {
            return Response::json(json!({"input_tokens":131073}));
        }
        capture.fetch_add(1, Ordering::SeqCst);
        panic!("overflow must not reach generation");
    });
    let report = run(
        &fixture,
        &options(UseCase::LongDocument),
        WorkloadKind::LongRetrieval,
    )
    .await;
    assert_eq!(report["qualityPassed"], false);
    assert_eq!(report["qualityReason"], "workloadContextWouldOverflow");
    assert_eq!(report["tokenCountRequests"], 1);
    assert_eq!(report["requestCount"], 0);
    assert_eq!(generations.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn stream_identity_change_truncation_and_missing_done_fail_closed() {
    let bad = vec![
        event(
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"first","function":{"name":"read_fixture","arguments":"{"}}]},"finish_reason":null}]}),
        ) + &event(
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"different","function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}]}),
        ) + "data: [DONE]\n\n",
        event(json!({"choices":[{"delta":{"content":"{}"},"finish_reason":"length"}]}))
            + "data: [DONE]\n\n",
        event(json!({"choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]})),
    ];
    for body in bad {
        let fixture = Fixture::serve(move |request| {
            if request.path == "/metrics" {
                metrics()
            } else {
                Response::sse(body.clone())
            }
        });
        let report = run(&fixture, &options(UseCase::Chat), WorkloadKind::HotPrefix).await;
        assert_eq!(report["qualityPassed"], false);
        assert_eq!(report["requestCount"], 1);
        assert_eq!(report["complete"], false);
    }
}

#[tokio::test]
async fn cancellation_closes_only_this_stream_and_does_not_send_global_cancel() {
    let requests = Arc::new(Mutex::new(vec![]));
    let capture = requests.clone();
    let fixture = Fixture::serve(move |request| {
        capture.lock().unwrap().push(request.path.clone());
        if request.path == "/metrics" {
            return metrics();
        }
        let mut response = Response::sse(text_sse(
            "{\"ticket\":\"N7\",\"owner\":\"Mira\",\"count\":3}",
            0,
        ));
        response.delay = Duration::from_millis(300);
        response
    });
    let temp = tempfile::tempdir().unwrap();
    let state = RuntimeState::open(temp.path().into()).unwrap();
    let profile = fixture.profile();
    let options = options(UseCase::Chat);
    let spec = plan(&options)
        .unwrap()
        .into_iter()
        .find(|v| v.kind == WorkloadKind::HotPrefix)
        .unwrap();
    let cancel = CancellationToken::new();
    let child = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(80)).await;
        child.cancel();
    });
    let started = Instant::now();
    let report = run_workload(
        &state,
        &profile,
        Parameters {
            pcie_frac: 0.2,
            spec_min_p: 0.5,
        },
        "token",
        &spec,
        &options,
        &cancel,
        false,
    )
    .await
    .unwrap();
    assert!(started.elapsed() < Duration::from_millis(250));
    assert_eq!(report["qualityReason"], "workloadCanceled");
    assert_eq!(report["coldModelVerified"], false);
    assert!(!requests
        .lock()
        .unwrap()
        .iter()
        .any(|path| path.contains("cancel")));
    // A separate admitted request remains usable after cancellation.
    let response = state
        .client
        .get(format!("{}/metrics", profile.base_url))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
}

#[test]
fn plans_bound_capacity_and_do_not_mark_unconfigured_vision_as_pass() {
    let all = plan(&options(UseCase::LongDocument)).unwrap();
    assert_eq!(
        all.iter()
            .filter(|spec| spec.kind == WorkloadKind::LongRetrieval)
            .filter_map(|spec| spec.target_input_tokens)
            .collect::<Vec<_>>(),
        vec![16384, 32768, 65536]
    );
    assert!(!all.iter().any(|spec| spec.kind == WorkloadKind::Vision));
    let mut config = options(UseCase::LongDocument);
    config.context_limit = 32768;
    assert_eq!(
        plan(&config)
            .unwrap()
            .iter()
            .filter(|spec| spec.kind == WorkloadKind::LongRetrieval)
            .filter_map(|spec| spec.target_input_tokens)
            .collect::<Vec<_>>(),
        vec![16384]
    );
    config.context_limit = 8192;
    assert!(plan(&config).is_err());
    config = options(UseCase::Chat);
    config.include_vision = true;
    assert!(plan(&config)
        .unwrap()
        .iter()
        .any(|spec| spec.kind == WorkloadKind::Vision));
    config.max_output_tokens = 512;
    assert!(plan(&config).is_err());
    assert_eq!(
        &include_bytes!("tuning_workload_fixtures/vision-n7.png")[..8],
        b"\x89PNG\r\n\x1a\n"
    );
}

#[tokio::test]
async fn configured_vision_uses_bundled_image_without_remote_or_filesystem_urls() {
    let fixture = Fixture::serve(|request| {
        if request.path == "/metrics" {
            return metrics();
        }
        let url = request.body["messages"][0]["content"][0]["image_url"]["url"]
            .as_str()
            .unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        let bytes = STANDARD
            .decode(url.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        assert_eq!(
            bytes,
            include_bytes!("tuning_workload_fixtures/vision-n7.png")
        );
        Response::sse(text_sse(
            "{\"left\":\"red\",\"right\":\"blue\",\"label\":\"N7\"}",
            0,
        ))
    });
    let mut config = options(UseCase::Chat);
    config.include_vision = true;
    assert_eq!(
        run(&fixture, &config, WorkloadKind::Vision).await["qualityPassed"],
        true
    );
}

#[tokio::test]
async fn session_switch_uses_separate_history_then_returns_to_original_session() {
    let counter = Arc::new(AtomicUsize::new(0));
    let captured = counter.clone();
    let fixture = Fixture::serve(move |request| {
        if request.path == "/metrics" {
            return metrics();
        }
        let index = captured.fetch_add(1, Ordering::SeqCst);
        let messages = request.body["messages"].as_array().unwrap();
        let text = match index {
            0 => "{\"ticket\":\"N7\",\"owner\":\"Mira\",\"count\":3}",
            1 => {
                assert!(!messages
                    .iter()
                    .any(|m| m["content"].as_str().unwrap_or("").contains("Mira")));
                "{\"ticket\":\"Z9\",\"owner\":\"Theo\",\"count\":8}"
            }
            2 => {
                assert_eq!(messages.len(), 4);
                assert!(!messages
                    .iter()
                    .any(|m| m["content"].as_str().unwrap_or("").contains("Theo")));
                "{\"ticket\":\"N7\",\"owner\":\"Mira\",\"count\":5}"
            }
            _ => panic!("unexpected request"),
        };
        Response::sse(text_sse(text, if index == 2 { 170 } else { 0 }))
    });
    let report = run(
        &fixture,
        &options(UseCase::Chat),
        WorkloadKind::SessionSwitch,
    )
    .await;
    assert_eq!(report["qualityPassed"], true);
    assert_eq!(report["cachedTokens"], 170);
    assert_eq!(report["requestCount"], 3);
}

#[tokio::test]
async fn sustained_generation_requires_entire_sequence_and_sum() {
    for valid in [false, true] {
        let fixture = Fixture::serve(move |request| {
            if request.path == "/metrics" {
                return metrics();
            }
            let values: Vec<u64> = (1..=if valid { 128 } else { 127 }).collect();
            Response::sse(text_sse(
                &json!({"values":values,"total":8256}).to_string(),
                0,
            ))
        });
        let report = run(
            &fixture,
            &options(UseCase::Chat),
            WorkloadKind::SustainedGeneration,
        )
        .await;
        assert_eq!(report["qualityPassed"], valid);
    }
}

#[tokio::test]
async fn long_hot_and_session_switch_reuse_counted_long_documents_not_short_probes() {
    for kind in [WorkloadKind::HotPrefix, WorkloadKind::SessionSwitch] {
        let counted = Arc::new(Mutex::new(std::collections::HashMap::<String, u64>::new()));
        let captured = counted.clone();
        let generations = Arc::new(Mutex::new(Vec::<Value>::new()));
        let observed = generations.clone();
        let fixture = Fixture::serve(move |request| {
            if request.path == "/metrics" {
                return metrics();
            }
            let messages = request.body["messages"].clone();
            let text = messages[0]["content"].as_str().unwrap();
            assert!(text.starts_with("Benchmark identifier "));
            assert!(
                text.len() > 32 * 1024,
                "long workload must contain the actual document"
            );
            let key = messages.to_string();
            if request.path == "/v1/messages/count_tokens" {
                let count = if messages.as_array().unwrap().len() == 3 {
                    16480
                } else {
                    16400
                };
                captured.lock().unwrap().insert(key, count);
                return Response::json(json!({"input_tokens":count}));
            }
            assert_eq!(request.path, "/v1/messages");
            let count = *captured
                .lock()
                .unwrap()
                .get(&key)
                .expect("generate exactly a counted message");
            let index = observed.lock().unwrap().len();
            observed.lock().unwrap().push(messages.clone());
            let alternate = text.contains("FACT_A: ticket P4");
            let answer = if alternate {
                json!({"ownerA":"Nora","ownerB":"Owen","linkedTicket":"R2","total":100,"audit":"AMBER-42","citations":["FACT_A","FACT_B","FACT_C"]})
            } else {
                json!({"ownerA":"Mira","ownerB":"Theo","linkedTicket":"Z9","total":100,"audit":"LIME-73","citations":["FACT_A","FACT_B","FACT_C"]})
            };
            let cache = if index
                == if kind == WorkloadKind::HotPrefix {
                    1
                } else {
                    2
                } {
                16000
            } else {
                0
            };
            Response::sse(
                event(
                    json!({"type":"message_start","message":{"usage":{"input_tokens":count,"cache_read_input_tokens":0}}}),
                ) + &event(
                    json!({"type":"content_block_delta","delta":{"text":answer.to_string()}}),
                ) + &event(
                    json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":count-cache,"cache_read_input_tokens":cache,"output_tokens":120}}),
                ) + &event(json!({"type":"message_stop"})),
            )
        });
        let mut config = options(UseCase::LongDocument);
        config.context_limit = 32768;
        let report = run(&fixture, &config, kind).await;
        assert_eq!(report["qualityPassed"], true, "{report}");
        assert_eq!(report["cachedTokens"], 16000);
        assert_eq!(report["targetInputTokens"], 16384);
        let requests = generations.lock().unwrap();
        if kind == WorkloadKind::HotPrefix {
            assert_eq!(requests.len(), 2);
            assert_eq!(requests[0], requests[1]);
            assert_eq!(report["actualContextTokens"], 16400);
        } else {
            assert_eq!(requests.len(), 3);
            assert_ne!(requests[0], requests[1]);
            assert_eq!(requests[0][0], requests[2][0]);
            assert_eq!(requests[2].as_array().unwrap().len(), 3);
            assert_eq!(report["actualContextTokens"], 16480);
        }
    }
}
