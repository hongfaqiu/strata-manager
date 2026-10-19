//! Bounded startup evidence. Classification never performs recovery or repairs.
use crate::{
    processes,
    types::{LogEntry, ProcessStatus},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StartupCategory {
    Resource,
    Port,
    Files,
    Config,
    Auth,
    Timeout,
    Engine,
    Python,
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StartupConfidence {
    Confirmed,
    Suspected,
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StartupAction {
    OpenResources,
    OpenNetwork,
    OpenFiles,
    OpenConfig,
    OpenCredentials,
    CheckStatus,
    ViewLogs,
    ExportDiagnostics,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupEvidence {
    pub source: String,
    pub at: u64,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupFailureDiagnostic {
    pub profile_id: String,
    pub attempt_started_at: u64,
    pub failed_at: u64,
    pub phase: String,
    pub category: StartupCategory,
    pub confidence: StartupConfidence,
    pub code: String,
    pub message: String,
    pub evidence: Vec<StartupEvidence>,
    pub actions: Vec<StartupAction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_running: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

pub fn error(code: &str, message: impl Into<String>, phase: &str) -> String {
    json!({"code": code, "message": message.into(), "details": {"startupPhase": phase}}).to_string()
}

pub fn io_error(error: &std::io::Error, label: &str, phase: &str) -> String {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => "STARTUP_FILE_MISSING",
        std::io::ErrorKind::PermissionDenied => "STARTUP_PERMISSION_DENIED",
        std::io::ErrorKind::AddrInUse => "STARTUP_PORT_IN_USE",
        _ => "STARTUP_IO_ERROR",
    };
    self::error(code, format!("{label}: {error}"), phase)
}

fn safe(text: &str) -> String {
    processes::redact_log(text).chars().take(1024).collect()
}

fn bounded_code(code: &str) -> String {
    if !code.is_empty()
        && code.len() <= 80
        && code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
    {
        code.into()
    } else {
        "STARTUP_UNKNOWN".into()
    }
}

fn parsed_error(raw: &str) -> (String, String, String, Option<u16>, Value) {
    let mut body = raw;
    let mut http_status = None;
    if let Some(rest) = raw.strip_prefix("HTTP ") {
        if let Some((head, tail)) = rest.split_once(':') {
            http_status = head
                .split_whitespace()
                .next()
                .and_then(|value| value.parse().ok());
            body = tail.trim();
        }
    }
    let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let inner = &value["error"];
    let code = value["code"]
        .as_str()
        .or_else(|| inner["code"].as_str())
        .unwrap_or("STARTUP_UNKNOWN")
        .to_string();
    let message = value["message"]
        .as_str()
        .or_else(|| inner["message"].as_str())
        .unwrap_or(body)
        .to_string();
    let phase = value["details"]["startupPhase"]
        .as_str()
        .unwrap_or("prepare")
        .to_string();
    http_status =
        http_status.or_else(|| value["status"].as_u64().and_then(|n| u16::try_from(n).ok()));
    (code, message, phase, http_status, value)
}

pub fn message(raw: &str) -> String {
    parsed_error(raw).1
}

/// Attach the operation stage while retaining a native HTTP status and code.
pub fn during(raw: &str, phase: &str) -> String {
    let (code, message, _, status, parsed) = parsed_error(raw);
    let mut value = if parsed.is_object() {
        parsed
    } else {
        json!({})
    };
    value["code"] = json!(code);
    value["message"] = json!(message);
    if !value["details"].is_object() {
        // Upstream errors can use a scalar or array here. Retain its shape,
        // never arbitrary detail contents, before adding our structured stage.
        let shape = match &value["details"] {
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Number(_) => "number",
            Value::Bool(_) => "boolean",
            _ => "null",
        };
        value["details"] = if shape == "null" {
            json!({})
        } else {
            json!({"upstreamDetailsType":shape})
        };
    }
    value["details"]["startupPhase"] = json!(phase);
    if let Some(status) = status {
        value["status"] = json!(status);
    }
    if value["details"]["startupDiagnostic"].is_object() {
        value["details"]["startupDiagnostic"]["phase"] = json!(phase);
    }
    value.to_string()
}

pub fn with_context(raw: &str, context: &str) -> String {
    let (code, message, phase, status, parsed) = parsed_error(raw);
    let mut value = if parsed.is_object() {
        parsed
    } else {
        json!({"code":code,"message":message,"details":{"startupPhase":phase}})
    };
    if let Some(status) = status {
        value["status"] = json!(status);
    }
    let message = format!("{context}: {message}");
    value["message"] = json!(message);
    if value["details"]["startupDiagnostic"].is_object() {
        value["details"]["startupDiagnostic"]["message"] = value["message"].clone();
    }
    value.to_string()
}

fn resource_report(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    // An engine allocation report is a clue, never proof of an OS OOM kill.
    (lower.contains("cudamalloc") && lower.contains("out of memory"))
        || lower.contains("cuda_error_out_of_memory")
        || lower.contains("hiperroroutofmemory")
        || lower.contains("verify: batch instantiate: out of memory")
        || lower.contains("pageable resident complement allocation failed")
}

pub fn build(
    profile_id: &str,
    attempt_started_at: u64,
    failed_at: u64,
    raw: &str,
    logs: &[LogEntry],
    process: Option<&ProcessStatus>,
) -> StartupFailureDiagnostic {
    let (mut code, mut message, mut phase, http_status, value) = parsed_error(raw);
    // The outer selection wrapper must preserve an already correlated inner attempt.
    if let Ok(mut previous) = serde_json::from_value::<StartupFailureDiagnostic>(
        value["details"]["startupDiagnostic"].clone(),
    ) {
        if previous.profile_id == profile_id
            && previous.attempt_started_at >= attempt_started_at
            && previous.attempt_started_at <= previous.failed_at
            && previous.failed_at <= failed_at
        {
            previous.message = safe(&previous.message);
            previous.code = bounded_code(&previous.code);
            if !matches!(previous.phase.as_str(), "prepare" | "starting" | "loading") {
                previous.phase = "prepare".into();
            }
            previous.evidence.retain(|item| {
                item.at >= previous.attempt_started_at
                    && item.at <= previous.failed_at
                    && matches!(
                        item.source.as_str(),
                        "startupError" | "httpStatus" | "serviceLog" | "process"
                    )
            });
            previous.evidence.truncate(6);
            for item in &mut previous.evidence {
                item.message = safe(&item.message);
            }
            if previous.category == StartupCategory::Auth {
                previous.message =
                    "连接鉴权失败；请检查本应用的连接凭据，未保留服务响应正文".into();
                previous.evidence.retain(|item| {
                    item.source == "httpStatus"
                        && matches!(item.message.as_str(), "HTTP 401" | "HTTP 403")
                });
            }
            return previous;
        }
    }
    let http_status = http_status.or(match code.as_str() {
        "STARTUP_AUTH_REQUIRED" | "UNAUTHORIZED" => Some(401),
        "STARTUP_FORBIDDEN" | "FORBIDDEN" => Some(403),
        _ => None,
    });
    let (mut category, mut confidence) = match code.as_str() {
        "STARTUP_PORT_IN_USE" => (StartupCategory::Port, StartupConfidence::Confirmed),
        "STARTUP_FILE_MISSING" => (StartupCategory::Files, StartupConfidence::Confirmed),
        "STARTUP_CONFIG_INVALID"
        | "STARTUP_CONFIG_INCOMPATIBLE"
        | "STARTUP_EXTERNAL_CONFIG_MISMATCH"
        | "STARTUP_RUNTIME_ALREADY_MANAGED" => {
            (StartupCategory::Config, StartupConfidence::Confirmed)
        }
        "STARTUP_AUTH_REQUIRED" | "STARTUP_FORBIDDEN" | "UNAUTHORIZED" | "FORBIDDEN" => {
            (StartupCategory::Auth, StartupConfidence::Confirmed)
        }
        "STARTUP_API_TIMEOUT" | "STARTUP_LOAD_TIMEOUT" => {
            (StartupCategory::Timeout, StartupConfidence::Confirmed)
        }
        "STARTUP_ENGINE_CRASHED" => (StartupCategory::Engine, StartupConfidence::Confirmed),
        "STARTUP_ENGINE_MISSING" => (StartupCategory::Files, StartupConfidence::Confirmed),
        "STARTUP_PYTHON_ENV_MISMATCH" | "STARTUP_PYTHON_UNAVAILABLE" => {
            (StartupCategory::Python, StartupConfidence::Confirmed)
        }
        _ if matches!(http_status, Some(401 | 403)) => {
            (StartupCategory::Auth, StartupConfidence::Confirmed)
        }
        _ => (StartupCategory::Unknown, StartupConfidence::Unknown),
    };
    let current: Vec<_> = logs
        .iter()
        .filter(|entry| entry.timestamp >= attempt_started_at && entry.timestamp <= failed_at)
        .collect();
    if category == StartupCategory::Unknown
        && current.iter().any(|entry| resource_report(&entry.message))
    {
        category = StartupCategory::Resource;
        confidence = StartupConfidence::Suspected;
        // Keep a structured original error code where available.
        if code == "STARTUP_UNKNOWN" {
            code = "STARTUP_RESOURCE_REPORTED".into();
        }
    }
    if !matches!(phase.as_str(), "prepare" | "starting" | "loading") {
        phase = "prepare".into();
    }
    if category == StartupCategory::Auth {
        // Even a marker-free response could echo the caller's key. Keep only
        // fixed authentication diagnostics, never the response or child output.
        message = "连接鉴权失败；请检查本应用的连接凭据，未保留服务响应正文".into();
    }
    let mut evidence = vec![StartupEvidence {
        source: "startupError".into(),
        at: failed_at,
        message: safe(&message),
    }];
    if let Some(status) = http_status {
        evidence.push(StartupEvidence {
            source: "httpStatus".into(),
            at: failed_at,
            message: format!("HTTP {status}"),
        });
    }
    if confidence == StartupConfidence::Suspected {
        if let Some(entry) = current
            .iter()
            .rev()
            .find(|entry| resource_report(&entry.message))
        {
            evidence.push(StartupEvidence {
                source: "serviceLog".into(),
                at: entry.timestamp,
                message: safe(&entry.message),
            });
        }
    }
    let remaining = if category == StartupCategory::Auth {
        0
    } else {
        6usize.saturating_sub(evidence.len())
    };
    let recent: Vec<_> = current
        .iter()
        .rev()
        .filter(|entry| {
            !evidence.iter().any(|item| {
                item.source == "serviceLog"
                    && item.at == entry.timestamp
                    && item.message == safe(&entry.message)
            })
        })
        .take(remaining)
        .collect();
    for entry in recent.iter().rev() {
        evidence.push(StartupEvidence {
            source: "serviceLog".into(),
            at: entry.timestamp,
            message: safe(&entry.message),
        });
    }
    let primary = match category {
        StartupCategory::Resource => StartupAction::OpenResources,
        StartupCategory::Port => StartupAction::OpenNetwork,
        StartupCategory::Files | StartupCategory::Python => StartupAction::OpenFiles,
        StartupCategory::Config
            if matches!(
                code.as_str(),
                "STARTUP_EXTERNAL_CONFIG_MISMATCH" | "STARTUP_RUNTIME_ALREADY_MANAGED"
            ) =>
        {
            StartupAction::CheckStatus
        }
        StartupCategory::Config => StartupAction::OpenConfig,
        StartupCategory::Auth => StartupAction::OpenCredentials,
        StartupCategory::Timeout if process.is_some_and(|status| status.running) => {
            StartupAction::CheckStatus
        }
        _ => StartupAction::ViewLogs,
    };
    let mut actions = vec![primary];
    if !actions.contains(&StartupAction::ViewLogs) {
        actions.push(StartupAction::ViewLogs);
    }
    actions.push(StartupAction::ExportDiagnostics);
    StartupFailureDiagnostic {
        profile_id: profile_id.into(),
        attempt_started_at,
        failed_at,
        phase,
        category,
        confidence,
        code: bounded_code(&code),
        message: safe(&message),
        evidence,
        actions,
        process_running: process.map(|status| status.running),
        pid: process.and_then(|status| status.pid),
        exit_code: process.and_then(|status| status.exit_code),
    }
}

pub fn encode(diagnostic: &StartupFailureDiagnostic) -> String {
    json!({"code":diagnostic.code,"message":diagnostic.message,"details":{"startupDiagnostic":diagnostic}}).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runtime_lease_conflict_is_confirmed_and_points_to_existing_backend() {
        let raw = error(
            "STARTUP_RUNTIME_ALREADY_MANAGED",
            "该 Strata 运行环境已由另一后台托管，请连接已有后台；未停止现有服务",
            "prepare",
        );
        let diagnostic = build("selected", 10, 20, &raw, &[], None);
        assert_eq!(diagnostic.code, "STARTUP_RUNTIME_ALREADY_MANAGED");
        assert_eq!(diagnostic.phase, "prepare");
        assert_eq!(diagnostic.category, StartupCategory::Config);
        assert_eq!(diagnostic.confidence, StartupConfidence::Confirmed);
        assert_eq!(
            diagnostic.actions,
            [
                StartupAction::CheckStatus,
                StartupAction::ViewLogs,
                StartupAction::ExportDiagnostics,
            ]
        );
    }
    #[test]
    fn external_configuration_mismatch_is_confirmed_and_guides_to_running_status() {
        let raw = error(
            "STARTUP_EXTERNAL_CONFIG_MISMATCH",
            "已有 Strata 实例使用其他配置；请在正在运行该实例的 Manager 窗口切换模型",
            "prepare",
        );
        let diagnostic = build("selected", 10, 20, &raw, &[], None);
        assert_eq!(diagnostic.code, "STARTUP_EXTERNAL_CONFIG_MISMATCH");
        assert_eq!(diagnostic.phase, "prepare");
        assert_eq!(diagnostic.category, StartupCategory::Config);
        assert_eq!(diagnostic.confidence, StartupConfidence::Confirmed);
        assert_eq!(
            diagnostic.actions,
            [
                StartupAction::CheckStatus,
                StartupAction::ViewLogs,
                StartupAction::ExportDiagnostics,
            ]
        );
        let encoded: Value = serde_json::from_str(&encode(&diagnostic)).unwrap();
        assert_eq!(encoded["code"], "STARTUP_EXTERNAL_CONFIG_MISMATCH");
        assert_eq!(
            encoded["details"]["startupDiagnostic"]["category"],
            "config"
        );
        assert_eq!(
            encoded["details"]["startupDiagnostic"]["confidence"],
            "confirmed"
        );
        assert_eq!(
            encoded["details"]["startupDiagnostic"]["actions"],
            json!(["checkStatus", "viewLogs", "exportDiagnostics"])
        );
    }
    #[test]
    fn loading_phase_accepts_nonobject_details_without_panicking_or_echoing_them() {
        for details in [
            json!("private-upstream-detail"),
            json!(["private-upstream-detail"]),
            json!(123),
            json!(true),
        ] {
            let expected_shape = match &details {
                Value::String(_) => "string",
                Value::Array(_) => "array",
                Value::Number(_) => "number",
                Value::Bool(_) => "boolean",
                _ => unreachable!(),
            };
            let raw = format!(
                "HTTP 500: {}",
                json!({"code":"LOAD_FAILED","message":"load failed","details":details})
            );
            let wrapped = std::panic::catch_unwind(|| during(&raw, "loading"))
                .expect("valid JSON error details must not panic the startup task");
            let value: Value = serde_json::from_str(&wrapped).unwrap();
            assert_eq!(value["code"], "LOAD_FAILED");
            assert_eq!(value["message"], "load failed");
            assert_eq!(value["status"], 500);
            assert_eq!(value["details"]["startupPhase"], "loading");
            assert_eq!(value["details"]["upstreamDetailsType"], expected_shape);
            assert!(!wrapped.contains("private-upstream-detail"));
        }
    }
    #[test]
    fn loading_phase_keeps_existing_object_metadata_and_accepts_missing_details() {
        let wrapped = during(
            r#"HTTP 401: {"code":"UNAUTHORIZED","message":"denied","details":{"retryAfterMs":1200,"startupDiagnostic":{"phase":"prepare","code":"UNAUTHORIZED"}}}"#,
            "loading",
        );
        let value: Value = serde_json::from_str(&wrapped).unwrap();
        assert_eq!(value["code"], "UNAUTHORIZED");
        assert_eq!(value["status"], 401);
        assert_eq!(value["details"]["retryAfterMs"], 1200);
        assert_eq!(value["details"]["startupDiagnostic"]["phase"], "loading");
        assert_eq!(
            value["details"]["startupDiagnostic"]["code"],
            "UNAUTHORIZED"
        );
        for raw in [
            r#"{"message":"old error"}"#,
            r#"{"message":"old error","details":null}"#,
        ] {
            let value: Value = serde_json::from_str(&during(raw, "loading")).unwrap();
            assert_eq!(value["message"], "old error");
            assert_eq!(value["details"], json!({"startupPhase":"loading"}));
        }
    }
    // Port-zero reservations are released before the Python fixture binds. Keep
    // these two endpoint fixtures sequential so one cannot reuse the other's
    // reserved port during its interpreter probe or process-tree cleanup.
    static FIXTURE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[cfg(target_os = "linux")]
    fn register_fixture_credential(profile_id: &str) {
        use keyring::credential::{Credential, CredentialBuilder, CredentialBuilderApi};
        use std::collections::HashSet;
        use std::sync::{Arc, Mutex, OnceLock};
        static IDS: OnceLock<Arc<Mutex<HashSet<String>>>> = OnceLock::new();
        struct FixtureCredentials {
            ids: Arc<Mutex<HashSet<String>>>,
            platform: Box<CredentialBuilder>,
        }
        impl CredentialBuilderApi for FixtureCredentials {
            fn build(
                &self,
                target: Option<&str>,
                service: &str,
                user: &str,
            ) -> keyring::Result<Box<Credential>> {
                if service == "io.strata.manager" && self.ids.lock().unwrap().contains(user) {
                    keyring::mock::default_credential_builder().build(target, service, user)
                } else {
                    self.platform.build(target, service, user)
                }
            }
            fn as_any(&self) -> &dyn std::any::Any {
                self
            }
        }
        let ids = IDS.get_or_init(|| {
            let ids = Arc::new(Mutex::new(HashSet::new()));
            // This UUID was just generated for the isolated fixture and cannot
            // contain an existing password. Log only the infrastructure error.
            if let Err(error) = keyring::default::default_credential_builder()
                .build(None, "io.strata.manager", profile_id)
                .and_then(|credential| credential.get_password())
            {
                if !matches!(error, keyring::Error::NoEntry) {
                    eprintln!("private startup fixture platform credential backend: {error}");
                }
            }
            keyring::set_default_credential_builder(Box::new(FixtureCredentials {
                ids: ids.clone(),
                platform: keyring::default::default_credential_builder(),
            }));
            ids
        });
        ids.lock().unwrap().insert(profile_id.into());
    }

    #[test]
    fn permission_and_exit_137_are_not_missing_files_or_oom() {
        let permission = io_error(
            &std::io::Error::from(std::io::ErrorKind::PermissionDenied),
            "read config",
            "prepare",
        );
        let one = build("profile", 10, 20, &permission, &[], None);
        assert_eq!(one.category, StartupCategory::Unknown);
        let two = build(
            "profile",
            10,
            20,
            "exit 137: OOM?",
            &[],
            Some(&ProcessStatus {
                exit_code: Some(137),
                ..Default::default()
            }),
        );
        assert_eq!(two.category, StartupCategory::Unknown);
        assert_eq!(two.confidence, StartupConfidence::Unknown);
    }

    #[test]
    fn only_current_engine_allocations_are_suspected_and_evidence_is_bounded() {
        let logs = vec![LogEntry {
            timestamp: 9,
            level: "error".into(),
            message: "cudaMalloc: out of memory".into(),
        }];
        assert_eq!(
            build("p", 10, 20, "exit 1", &logs, None).category,
            StartupCategory::Unknown
        );
        let mut logs: Vec<_> = (10..20)
            .map(|timestamp| LogEntry {
                timestamp,
                level: "error".into(),
                message: "cudaMalloc: out of memory".into(),
            })
            .collect();
        logs.push(LogEntry {
            timestamp: 19,
            level: "error".into(),
            message: "Authorization: Bearer secret-value".into(),
        });
        let result = build("p", 10, 20, "exit 1", &logs, None);
        assert_eq!(result.category, StartupCategory::Resource);
        assert_eq!(result.confidence, StartupConfidence::Suspected);
        assert!(result.evidence.len() <= 6);
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("secret-value"));
    }

    #[test]
    fn auth_status_and_live_timeout_keep_safe_actions() {
        assert_eq!(
            build("p", 10, 20, "HTTP 401: denied", &[], None).category,
            StartupCategory::Auth
        );
        let result = build(
            "p",
            10,
            20,
            &error("STARTUP_API_TIMEOUT", "not ready", "starting"),
            &[],
            Some(&ProcessStatus {
                running: true,
                owned: true,
                ..Default::default()
            }),
        );
        assert_eq!(result.actions[0], StartupAction::CheckStatus);
        assert_eq!(result.process_running, Some(true));
        assert!(result
            .actions
            .iter()
            .all(|action| !format!("{action:?}").contains("Restart")));
        let loading = build(
            "p",
            10,
            20,
            &during("HTTP 401: denied", "loading"),
            &[],
            None,
        );
        assert_eq!(loading.phase, "loading");
        assert_eq!(loading.category, StartupCategory::Auth);
        let echoed = build(
            "p",
            10,
            20,
            "HTTP 401: plain-value-with-no-sensitive-marker",
            &[LogEntry {
                timestamp: 15,
                level: "error".into(),
                message: "plain-value-with-no-sensitive-marker".into(),
            }],
            None,
        );
        let serialized = serde_json::to_string(&echoed).unwrap();
        assert!(!serialized.contains("plain-value-with-no-sensitive-marker"));
        assert!(echoed
            .evidence
            .iter()
            .any(|item| item.message == "HTTP 401"));
    }

    #[test]
    fn startup_failure_store_survives_reopen_and_success_clears_it() {
        let temp = tempfile::tempdir().unwrap();
        let state = crate::RuntimeState::open(temp.path().into()).unwrap();
        let raw = error(
            "STARTUP_CONFIG_INVALID",
            "invalid model configuration",
            "prepare",
        );
        let result = state
            .record_startup_result("fixture", 10, Err(raw))
            .unwrap();
        assert!(result.is_err());
        let first = state.status().unwrap()["startupFailures"].clone();
        assert_eq!(first[0]["category"], "config");
        assert_eq!(first[0]["profileId"], "fixture");
        drop(state);
        let reopened = crate::RuntimeState::open(temp.path().into()).unwrap();
        assert_eq!(reopened.status().unwrap()["startupFailures"], first);
        reopened
            .record_startup_result(
                "fixture",
                30,
                Ok(ProcessStatus {
                    running: true,
                    owned: true,
                    ..Default::default()
                }),
            )
            .unwrap()
            .unwrap();
        assert!(reopened.status().unwrap()["startupFailures"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn rollback_context_handles_old_scalar_errors_and_preserves_http_auth() {
        for raw in ["null", "42", "\"old error\"", "[]"] {
            let encoded = with_context(raw, "selection failed; original restored");
            assert!(serde_json::from_str::<Value>(&encoded).unwrap().is_object());
        }
        let encoded = with_context("HTTP 401: plain-value-with-no-prefix", "original restored");
        let result = build("p", 10, 20, &encoded, &[], None);
        assert_eq!(result.category, StartupCategory::Auth);
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("plain-value-with-no-prefix"));
    }

    fn select_fixture_python(
        explicit: Option<&std::path::Path>,
        location: Option<&std::path::Path>,
        windows: bool,
        mut probe: impl FnMut(&str) -> Option<String>,
    ) -> Option<String> {
        // Match the capture fixture's setup-python selection without requiring
        // its third-party MockEngine dependencies for this stdlib-only server.
        // Explicit selections must fail rather than silently use another Python.
        if let Some(interpreter) = explicit {
            return interpreter
                .is_absolute()
                .then(|| interpreter.to_str())
                .flatten()
                .and_then(probe);
        }
        if let Some(directory) = location {
            if !directory.is_absolute() || !directory.is_dir() {
                return None;
            }
            return directory
                .join(if windows { "python.exe" } else { "bin/python" })
                .to_str()
                .and_then(probe);
        }
        let candidates = if windows {
            ["python", "py"]
        } else {
            ["python3", "python"]
        };
        candidates.into_iter().find_map(&mut probe)
    }

    #[test]
    fn fixture_python_uses_explicit_interpreter_without_path_launcher() {
        let directory = tempfile::tempdir().unwrap();
        let interpreter = directory.path().join("python.exe");
        let selected = select_fixture_python(Some(&interpreter), None, true, |program| {
            (std::path::Path::new(program) == interpreter)
                .then(|| interpreter.to_string_lossy().into_owned())
        });
        assert_eq!(selected.as_deref(), interpreter.to_str());
    }

    #[test]
    fn fixture_python_honors_ci_location_and_rejects_broken_explicit_selection() {
        let directory = tempfile::tempdir().unwrap();
        for windows in [false, true] {
            let expected = directory
                .path()
                .join(if windows { "python.exe" } else { "bin/python" });
            let mut calls = Vec::new();
            let selected =
                select_fixture_python(None, Some(directory.path()), windows, |program| {
                    calls.push(program.to_owned());
                    Some(program.to_owned())
                });
            assert_eq!(selected.as_deref(), expected.to_str());
            assert_eq!(calls, [expected.to_string_lossy()]);
        }
        let interpreter = directory.path().join("missing-python.exe");
        let mut calls = Vec::new();
        assert!(select_fixture_python(
            Some(&interpreter),
            Some(directory.path()),
            true,
            |program| {
                calls.push(program.to_owned());
                None
            }
        )
        .is_none());
        assert_eq!(calls, [interpreter.to_string_lossy()]);
        assert!(select_fixture_python(
            Some(std::path::Path::new("relative-python")),
            None,
            true,
            |_| { panic!("relative explicit paths must not run") }
        )
        .is_none());
    }

    #[test]
    fn fixture_python_falls_back_when_default_interpreter_is_unavailable() {
        for (windows, expected) in [(true, ["python", "py"]), (false, ["python3", "python"])] {
            let mut calls = Vec::new();
            let selected = select_fixture_python(None, None, windows, |program| {
                calls.push(program.to_owned());
                (program == expected[1]).then(|| "selected-interpreter".into())
            });
            assert_eq!(selected.as_deref(), Some("selected-interpreter"));
            assert_eq!(calls, expected);
        }
    }

    fn fixture() -> (
        tempfile::TempDir,
        std::sync::Arc<crate::RuntimeState>,
        crate::types::ServiceProfile,
    ) {
        use crate::*;
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("state")).unwrap();
        let root = temp.path().join("runtime");
        fs::create_dir_all(root.join("serve")).unwrap();
        fs::write(root.join("setup.py"), b"").unwrap();
        fs::write(
            root.join("serve/server.py"),
            br#"
import argparse, json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--host');p.add_argument('--port',type=int)
a,_=p.parse_known_args()
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  status=int(Path('status.txt').read_text());self.send_response(status);self.end_headers()
  self.wfile.write(json.dumps({'service':'strata','status':'ok','loaded':True}).encode())
 def log_message(self,*args): pass
ThreadingHTTPServer((a.host,a.port),Handler).serve_forever()
"#,
        )
        .unwrap();
        fs::write(root.join("status.txt"), b"401").unwrap();
        let explicit = std::env::var_os("STRATA_MANAGER_TEST_PYTHON").map(std::path::PathBuf::from);
        let location = std::env::var_os("pythonLocation").map(std::path::PathBuf::from);
        let python = select_fixture_python(
            explicit.as_deref(),
            location.as_deref(),
            cfg!(windows),
            |program| output(program, &["-c", "import sys;print(sys.executable)"]),
        )
        .expect("isolated fixture needs Python 3");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let config = root.join("fixture.json");
        // The configured engine must exist: startup checks it like server.py starts it (#78).
        fs::write(root.join("fixture.exe"), b"engine fixture, never started").unwrap();
        fs::write(
            &config,
            serde_json::to_vec(&json!({"exe":"fixture.exe","args":[],"port":port})).unwrap(),
        )
        .unwrap();
        let profile = types::ServiceProfile {
            id: format!("diagnostic-{}", uuid::Uuid::new_v4()),
            name: "startup diagnostic fixture".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            install_dir: root.to_string_lossy().into(),
            config_path: config.to_string_lossy().into(),
            python_path: python,
            managed: true,
        };
        // The headless Linux test host need not run a desktop Secret Service.
        // Only this newly generated fixture ID gets an empty mock credential;
        // all other profiles retain the platform backend, including its errors.
        #[cfg(target_os = "linux")]
        register_fixture_credential(&profile.id);
        state.database.lock().unwrap().execute("INSERT INTO local_installations(id,profile,original_profile,imported_at) VALUES(?1,?2,?2,0)",
            rusqlite::params![profile.id,serde_json::to_string(&profile).unwrap()]).unwrap();
        (temp, state, profile)
    }

    struct Cleanup(std::sync::Arc<crate::RuntimeState>);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            self.0.cleanup();
        }
    }

    #[tokio::test]
    async fn owned_startup_auth_fails_promptly_preserves_child_and_success_clears_diagnostic() {
        let _serial = FIXTURE_LOCK.lock().await;
        let (_temp, state, profile) = fixture();
        let _cleanup = Cleanup(state.clone());
        for status in [401, 403] {
            std::fs::write(
                std::path::Path::new(&profile.install_dir).join("status.txt"),
                status.to_string(),
            )
            .unwrap();
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                state.clone().ensure_runtime(profile.id.clone(), true),
            )
            .await
            .unwrap()
            .unwrap_err();
            let value: Value = serde_json::from_str(&result).unwrap();
            assert_eq!(
                value["details"]["startupDiagnostic"]["category"], "auth",
                "{result}"
            );
            assert_eq!(
                value["details"]["startupDiagnostic"]["processRunning"],
                true
            );
            assert_ne!(value["code"], "STARTUP_API_TIMEOUT");
            assert!(
                state
                    .processes
                    .lock()
                    .unwrap()
                    .get_mut(&profile.id)
                    .unwrap()
                    .refresh()
                    .unwrap()
                    .running
            );
        }
        std::fs::write(
            std::path::Path::new(&profile.install_dir).join("status.txt"),
            b"200",
        )
        .unwrap();
        assert!(
            state
                .clone()
                .ensure_runtime(profile.id.clone(), true)
                .await
                .unwrap()
                .running
        );
        assert!(state.status().unwrap()["startupFailures"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn startup_timeout_and_port_conflict_preserve_existing_processes() {
        let _serial = FIXTURE_LOCK.lock().await;
        let (_temp, state, profile) = fixture();
        let _cleanup = Cleanup(state.clone());
        std::fs::write(
            std::path::Path::new(&profile.install_dir).join("status.txt"),
            b"503",
        )
        .unwrap();
        let attempt = crate::now();
        let raw = state
            .clone()
            .ensure_runtime_inner_with_deadline(
                profile.id.clone(),
                true,
                std::time::Duration::from_millis(50),
            )
            .await;
        let result = state
            .record_startup_result(&profile.id, attempt, raw)
            .unwrap()
            .unwrap_err();
        let value: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(value["details"]["startupDiagnostic"]["category"], "timeout");
        assert!(
            state
                .processes
                .lock()
                .unwrap()
                .get_mut(&profile.id)
                .unwrap()
                .refresh()
                .unwrap()
                .running
        );

        let (_other_temp, other_state, mut other_profile) = fixture();
        let _other_cleanup = Cleanup(other_state.clone());
        let foreign = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = foreign.local_addr().unwrap().port();
        other_profile.base_url = format!("http://127.0.0.1:{port}");
        std::fs::write(
            &other_profile.config_path,
            serde_json::to_vec(&json!({"exe":"fixture.exe","args":[],"port":port})).unwrap(),
        )
        .unwrap();
        let plan =
            crate::prepare_startup(&other_profile, &other_state.processes, &other_state.tasks)
                .unwrap();
        let raw = crate::start_prepared_service(&other_state, other_profile.clone(), plan, None)
            .unwrap_err();
        assert_eq!(
            build(&other_profile.id, 0, crate::now(), &raw, &[], None).category,
            StartupCategory::Port
        );
        assert!(foreign.local_addr().is_ok());
        assert!(other_state.processes.lock().unwrap().is_empty());
    }

    #[test]
    fn load_failure_codes_from_issue_78_have_their_own_categories() {
        for (code, category, action) in [
            (
                "STARTUP_ENGINE_CRASHED",
                StartupCategory::Engine,
                StartupAction::ViewLogs,
            ),
            (
                "STARTUP_PYTHON_ENV_MISMATCH",
                StartupCategory::Python,
                StartupAction::OpenFiles,
            ),
            (
                "STARTUP_PYTHON_UNAVAILABLE",
                StartupCategory::Python,
                StartupAction::OpenFiles,
            ),
            (
                "STARTUP_ENGINE_MISSING",
                StartupCategory::Files,
                StartupAction::OpenFiles,
            ),
        ] {
            let raw = error(code, "x", "loading");
            let diagnostic = build("p", 1, 2, &raw, &[], None);
            assert_eq!(diagnostic.category, category, "{code}");
            assert_eq!(
                diagnostic.confidence,
                StartupConfidence::Confirmed,
                "{code}"
            );
            assert_eq!(diagnostic.actions[0], action, "{code}");
            assert_eq!(
                serde_json::to_value(&diagnostic).unwrap()["category"],
                serde_json::to_value(&category).unwrap()
            );
        }
    }
}
