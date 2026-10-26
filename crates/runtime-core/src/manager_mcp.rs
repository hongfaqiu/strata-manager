//! A narrow MCP facade over the authoritative, already-running Supervisor.
//! Client input never supplies an executable, installation root, profile or RPC method.
use crate::{external_management, http, store_get, RuntimeState};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};

pub const SERVER_NAME: &str = "strata-manager";
pub const PROTOCOL_VERSION: &str = "2025-06-18";

const TOOLS: [(&str, bool, &str); 8] = [
    (
        "strata_status",
        true,
        "查看绑定模型的受管服务状态；查询不会启动模型。",
    ),
    (
        "strata_models",
        true,
        "查看同一安装目录已登记的模型配置及本地模型文件。",
    ),
    (
        "strata_start",
        false,
        "通过本应用后台准备并启动绑定模型；沿用单模型约束和自动恢复策略。",
    ),
    (
        "strata_stop",
        false,
        "通过本应用后台安全停止绑定模型，并保存未启动状态。",
    ),
    (
        "strata_logs",
        true,
        "查看最近服务日志；API 密钥、凭据行及 URL 凭据经过脱敏。",
    ),
    (
        "strata_install",
        false,
        "默认检查安装磁盘计划；用户明确同意后传 confirm=true，才提交官方模型安装任务。先停止服务。",
    ),
    (
        "strata_connect_info",
        true,
        "获取本机推理 API 地址；API 密钥不通过 MCP 返回。",
    ),
    (
        "strata_task_status",
        true,
        "查询绑定模型的安装或维护任务状态。",
    ),
];

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}

/// Shared by the stdio bridge and the backend connection preview.
pub fn tool_definitions() -> Vec<Value> {
    TOOLS.iter().map(|(name, read_only, description)| {
        let input = match *name {
            "strata_logs" => schema(json!({"limit":{"type":"integer","minimum":1,"maximum":500,"default":100}}), &[]),
            "strata_install" => schema(json!({
                "family":{"type":"string","enum":["qwen","swift","coder","unsloth","qwen36","deepseek41"]},
                "quant":{"type":"string","enum":["Q2_0","IQ2_XS","IQ3_XXS","IQ3_S","IQ1_M","UD-IQ4_XS","UD-Q4_K_XL","UD-Q5_K_XL","UD-Q6_K_XL","Q8_0","IST-DAS-2.00bpw","IST-DAS-1.75bpw","IST-DAS-2.25bpw"]},
                "context":{"type":"integer","minimum":512,"maximum":1048576,"default":8192},
                "images":{"type":"boolean","default":false},
                "confirm":{"type":"boolean","default":false}
            }), &["family", "quant"]),
            "strata_task_status" => schema(json!({"taskId":{"type":"string","minLength":1,"maxLength":128}}), &[]),
            _ => schema(json!({}), &[]),
        };
        json!({"name":name,"description":description,"inputSchema":input,"annotations":{"readOnlyHint":read_only,"destructiveHint":false,"openWorldHint":!*read_only,"idempotentHint":*read_only}})
    }).collect()
}

pub fn connection(state: &RuntimeState, profile_id: &str) -> Result<Value, String> {
    validate_id(profile_id)?;
    let profile = state.registered_profile(profile_id)?;
    http::endpoint(&profile, "/health")?;
    if !state.executable_path.is_absolute() || !state.data_dir.is_absolute() {
        return Err("后台可执行文件和数据目录必须为绝对路径".into());
    }
    Ok(json!({
        "serverName":SERVER_NAME,"protocolVersion":PROTOCOL_VERSION,
        "tools":TOOLS.iter().map(|(name,read_only,_)| json!({"name":name,"readOnly":read_only})).collect::<Vec<_>>(),
        "command":state.executable_path,
        "args":["--mcp-server","--data-dir",state.data_dir,"--profile-id",profile_id],
        "profileId":profile_id,"installDir":profile.install_dir,
        "management":if external_management::is_profile_external(state,&profile)? {"external"} else {"application"}
    }))
}

fn validate_id(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err("绑定模型 ID 无效".into());
    }
    Ok(())
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LogArguments {
    #[serde(default = "default_log_limit")]
    limit: usize,
}
fn default_log_limit() -> usize {
    100
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskArguments {
    task_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InstallArguments {
    family: String,
    quant: String,
    #[serde(default = "default_context")]
    context: u32,
    #[serde(default)]
    images: bool,
    #[serde(default)]
    confirm: bool,
}
fn default_context() -> u32 {
    8192
}
impl InstallArguments {
    fn validate(&self) -> Result<(), String> {
        let supported = match self.family.as_str() {
            "qwen" => ["Q2_0", "IQ2_XS", "IQ3_XXS", "IQ3_S"].contains(&self.quant.as_str()),
            "swift" => ["IQ2_XS", "IQ3_XXS", "IQ3_S"].contains(&self.quant.as_str()),
            "coder" => self.quant == "IQ1_M",
            "unsloth" => [
                "UD-IQ4_XS",
                "UD-Q4_K_XL",
                "UD-Q5_K_XL",
                "UD-Q6_K_XL",
                "Q8_0",
            ]
            .contains(&self.quant.as_str()),
            "qwen36" => ["UD-Q4_K_XL", "UD-Q6_K_XL", "Q8_0"].contains(&self.quant.as_str()),
            // DeepSeek-V4.1-Flash: the engine was checked at 8K only, and it reads no pictures.
            "deepseek41" => {
                crate::disk::dsv41::set(&self.quant).is_some()
                    && self.context == crate::disk::dsv41::CONTEXT
                    && !self.images
            }
            _ => false,
        };
        if !supported || !(512..=1_048_576).contains(&self.context) {
            return Err(
                "安装参数无效；请使用已支持的 family / quant 和 512–1048576 context".into(),
            );
        }
        Ok(())
    }
}
fn arguments<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
    if !value.is_object() {
        return Err("工具参数必须是 JSON 对象".into());
    }
    serde_json::from_value(value).map_err(|error| format!("工具参数无效: {error}"))
}

async fn dispatch(state: Arc<RuntimeState>, method: &str, params: Value) -> Result<Value, String> {
    // dispatch also routes manager_mcp_call; box this edge to keep a finite future.
    Box::pin(state.dispatch(method, params)).await
}

fn same_installation(left: &str, right: &str) -> bool {
    let a = dunce::canonicalize(left).unwrap_or_else(|_| Path::new(left).to_path_buf());
    let b = dunce::canonicalize(right).unwrap_or_else(|_| Path::new(right).to_path_buf());
    #[cfg(windows)]
    {
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

/// Restrict tool calls to one registered profile. Existing dispatch retains all
/// lifecycle guards, installation locks and persistent desired-state behavior.
pub async fn call(
    state: Arc<RuntimeState>,
    profile_id: String,
    name: String,
    input: Value,
) -> Result<Value, String> {
    validate_id(&profile_id)?;
    let (_, read_only, _) = TOOLS
        .iter()
        .find(|(tool, _, _)| *tool == name)
        .ok_or("未知 MCP 工具")?;
    let profile = state.registered_profile(&profile_id)?;
    http::endpoint(&profile, "/health")?;
    if !read_only {
        external_management::assert_profile_manager_owned(&state, &profile)?;
    }
    match name.as_str() {
        "strata_status" => {
            let _: Empty = arguments(input)?;
            let process = dispatch(
                state.clone(),
                "service_status",
                json!({"profileId":profile_id,"profile":profile}),
            )
            .await?;
            Ok(
                json!({"profileId":profile_id,"name":profile.name,"management":if external_management::is_profile_external(&state,&profile)? {"external"} else {"application"},"desired":store_get(&state,"activeLocalInstallation".into())?.as_str()==Some(&profile_id) && store_get(&state,"localServiceDesired".into())?.as_bool()!=Some(false),"process":process}),
            )
        }
        "strata_models" => {
            let _: Empty = arguments(input)?;
            let active = store_get(&state, "activeLocalInstallation".into())?;
            let profiles = state.registered_profiles()?.into_iter()
                .filter(|candidate| same_installation(&candidate.install_dir,&profile.install_dir))
                .map(|candidate| Ok(json!({"profileId":candidate.id,"name":candidate.name,"baseUrl":candidate.base_url,"configPath":candidate.config_path,"selected":active.as_str()==Some(&candidate.id),"bound":candidate.id==profile_id,"managedBy":if external_management::is_profile_external(&state,&candidate)? {"external"} else {"application"}})))
                .collect::<Result<Vec<_>,String>>()?;
            let installed =
                dispatch(state, "list_local_models", json!({"profile":profile})).await?;
            Ok(json!({"profileId":profile_id,"profiles":profiles,"installed":installed}))
        }
        "strata_start" => {
            let _: Empty = arguments(input)?;
            let status = dispatch(
                state.clone(),
                "ensure_local_service",
                json!({"profileId":profile_id}),
            )
            .await?;
            record_successful_activation(&state, &profile_id, &status)?;
            Ok(status)
        }
        "strata_stop" => {
            let _: Empty = arguments(input)?;
            dispatch(state, "stop_service", json!({"profileId":profile_id})).await
        }
        "strata_logs" => {
            let args: LogArguments = arguments(input)?;
            if !(1..=500).contains(&args.limit) {
                return Err("日志数量必须为 1–500".into());
            }
            let secret = http::key(&profile_id)?;
            let logs = dispatch(
                state,
                "read_logs",
                json!({"profile":profile,"limit":args.limit}),
            )
            .await?;
            let entries: Vec<Value> = logs.as_array().ok_or("后台日志响应无效")?.iter()
                .map(|entry| json!({"timestamp":entry.get("timestamp"),"level":entry.get("level"),"message":redact_log(entry.get("message").and_then(Value::as_str).unwrap_or(""),secret.as_deref())})).collect();
            Ok(json!({"profileId":profile_id,"entries":entries,"redacted":true}))
        }
        "strata_install" => {
            let args: InstallArguments = arguments(input)?;
            args.validate()?;
            if !args.confirm {
                let preflight = dispatch(state,"setup_disk_preflight",json!({"profile":profile,"model":args.family,"quant":args.quant,"images":args.images})).await?;
                Ok(
                    json!({"confirmed":false,"action":"plan","profileId":profile_id,"family":args.family,"quant":args.quant,"context":args.context,"images":args.images,"preflight":preflight,"message":"此调用仅检查计划。用户明确同意并停止服务后，使用相同参数和 confirm=true 提交安装任务。"}),
                )
            } else {
                let task = dispatch(state,"run_setup",json!({"profile":profile,"model":args.family,"quant":args.quant,"context":args.context,"images":args.images})).await?;
                Ok(json!({"confirmed":true,"action":"task","task":task}))
            }
        }
        "strata_connect_info" => {
            let _: Empty = arguments(input)?;
            let models = http::endpoint(&profile, "/v1/models")?;
            let chat = http::endpoint(&profile, "/v1/chat/completions")?;
            let mut base = models.clone();
            base.set_path("/v1");
            Ok(
                json!({"profileId":profile_id,"baseUrl":base.as_str(),"modelsUrl":models.as_str(),"chatCompletionsUrl":chat.as_str(),"apiKey":"[请在本应用的 API 连接设置中获取]","transport":"stdio","management":if external_management::is_profile_external(&state,&profile)? {"external"} else {"application"}}),
            )
        }
        "strata_task_status" => {
            let args: TaskArguments = arguments(input)?;
            if let Some(id) = &args.task_id {
                validate_id(id)?;
            }
            let secret = http::key(&profile_id)?;
            let mut tasks: Vec<_> = state
                .tasks
                .lock()
                .map_err(|error| error.to_string())?
                .values()
                .filter(|task| task.profile_id.as_deref() == Some(&profile_id))
                .filter(|task| args.task_id.as_ref().is_none_or(|id| task.status.id == *id))
                .map(|task| {
                    let mut status = task.status.clone();
                    status.message = redact_log(&status.message, secret.as_deref());
                    status
                })
                .collect();
            tasks.sort_by_key(|task| std::cmp::Reverse(task.started_at));
            if args.task_id.is_some() && tasks.is_empty() {
                return Err("任务不存在或不属于绑定模型".into());
            }
            tasks.truncate(100);
            Ok(json!({"profileId":profile_id,"tasks":tasks}))
        }
        _ => unreachable!("tool was validated above"),
    }
}

fn record_successful_activation(
    state: &RuntimeState,
    profile_id: &str,
    status: &Value,
) -> Result<(), String> {
    if status.get("running").and_then(Value::as_bool) != Some(true)
        || status.get("owned").and_then(Value::as_bool) != Some(true)
    {
        return Ok(());
    }
    let mut database = state.database.lock().map_err(|error| error.to_string())?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    let mut timestamps = crate::store::get(&transaction, "localConfigurationLastActivatedAt")?
        .as_object()
        .cloned()
        .unwrap_or_default();
    timestamps.insert(profile_id.into(), json!(crate::types::now()));
    let value = serde_json::to_string(&timestamps).map_err(|error| error.to_string())?;
    transaction.execute(
        "INSERT INTO kv(key,value) VALUES('localConfigurationLastActivatedAt',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [value],
    ).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn redact_log(message: &str, secret: Option<&str>) -> String {
    let message = if let Some(secret) = secret.filter(|secret| !secret.is_empty()) {
        message.replace(secret, "[redacted API key]")
    } else {
        message.to_owned()
    };
    crate::processes::redact_log(&message)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn schemas_are_closed_and_mutations_explicit() {
        let defs = tool_definitions();
        assert_eq!(defs.len(), 8);
        for tool in &defs {
            assert_eq!(tool["inputSchema"]["additionalProperties"], false);
        }
        assert_eq!(
            defs.iter()
                .filter(|tool| tool["annotations"]["readOnlyHint"] == false)
                .count(),
            3
        );
        assert_eq!(
            defs.iter()
                .find(|tool| tool["name"] == "strata_install")
                .unwrap()["inputSchema"]["properties"]["confirm"]["default"],
            false
        );
    }
    #[test]
    fn caller_cannot_inject_profile_rpc_or_paths() {
        assert!(arguments::<Empty>(json!({"profileId":"other"})).is_err());
        assert!(arguments::<Empty>(json!({"method":"write_config"})).is_err());
        assert!(arguments::<InstallArguments>(
            json!({"family":"qwen","quant":"IQ3_S","directory":"C:\\other"})
        )
        .is_err());
        assert!(arguments::<InstallArguments>(
            json!({"family":"qwen","quant":"IQ3_S","options":{"python":"bad"}})
        )
        .is_err());
        assert!(arguments::<Empty>(Value::Null).is_err());
    }
    #[test]
    fn installation_requires_validated_combinations_and_real_boolean() {
        let plan: InstallArguments = arguments(json!({"family":"qwen","quant":"IQ3_S"})).unwrap();
        assert!(!plan.confirm);
        assert_eq!(plan.context, 8192);
        assert!(plan.validate().is_ok());
        assert!(arguments::<InstallArguments>(
            json!({"family":"qwen","quant":"IQ3_S","confirm":"true"})
        )
        .is_err());
        let invalid: InstallArguments =
            arguments(json!({"family":"qwen","quant":"--config","context":8192})).unwrap();
        assert!(invalid.validate().is_err());
    }
    #[test]
    fn logs_hide_keys_credentials_and_url_queries() {
        assert!(!redact_log("unmarked abc123 value", Some("abc123")).contains("abc123"));
        assert!(!redact_log("Authorization: Bearer credential", None).contains("credential"));
        assert!(!redact_log(
            "download https://user:pass@example.test/path?token=private",
            None
        )
        .contains("private"));
        assert_eq!(
            redact_log("model loaded successfully", None),
            "model loaded successfully"
        );
    }
    #[tokio::test]
    async fn only_registered_profiles_can_authorize_tools() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        assert!(connection(&state, "unregistered").is_err());
        assert!(call(
            state,
            "unregistered".into(),
            "strata_start".into(),
            json!({})
        )
        .await
        .is_err());
    }
    #[test]
    fn only_successful_owned_activation_updates_recent_model_history() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        crate::store_set(
            &state,
            "localConfigurationLastActivatedAt".into(),
            json!({"previous":123}),
        )
        .unwrap();
        for status in [
            json!({"running":false,"owned":true}),
            json!({"running":true,"owned":false}),
            Value::Null,
        ] {
            record_successful_activation(&state, "target", &status).unwrap();
            assert_eq!(
                crate::store_get(&state, "localConfigurationLastActivatedAt".into()).unwrap(),
                json!({"previous":123})
            );
        }
        let before = crate::types::now();
        record_successful_activation(&state, "target", &json!({"running":true,"owned":true}))
            .unwrap();
        let timestamps =
            crate::store_get(&state, "localConfigurationLastActivatedAt".into()).unwrap();
        assert_eq!(timestamps["previous"], 123);
        assert!(timestamps["target"].as_u64().unwrap() >= before);
    }
}
