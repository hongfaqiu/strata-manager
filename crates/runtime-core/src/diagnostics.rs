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

/// How a failed start relates to an unwritable engine log: `None` when it does
/// not, `Some(false)` when the engine itself reported `PermissionError` (a new
/// log file can help) and `Some(true)` when Manager's own preflight found no
/// writable file (a retry cannot help).
pub fn log_unwritable(raw: &str) -> Option<bool> {
    let (code, message, _, _, value) = parsed_error(raw);
    if code != crate::engine_log::CODE {
        return None;
    }
    let reported = crate::engine_log::is_permission_error(&message)
        || value["details"]["startupDiagnostic"]["evidence"]
            .as_array()
            .is_some_and(|items| {
                items.iter().any(|item| {
                    item["message"]
                        .as_str()
                        .is_some_and(crate::engine_log::is_permission_error)
                })
            });
    Some(!reported)
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

/// What an engine memory line says ran out. Order matters: a Windows commit
/// line also names `cudaMalloc ... out of memory`, and its fix differs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum MemoryReport {
    /// Only a bare "out of memory": RAM or VRAM, the line does not say.
    Generic,
    /// The GPU allocation failed (generate.cpp vram_free_note, cudaMalloc, HIP).
    Vram,
    /// Windows commit (RAM + page file) ran out; generate.cpp ~7205-7225.
    Commit,
}

pub const VRAM_INSUFFICIENT: &str = "STARTUP_VRAM_INSUFFICIENT";
pub const WINDOWS_COMMIT_LOW: &str = "STARTUP_WINDOWS_COMMIT_LOW";
/// Windows 11 Smart App Control (or WDAC) blocked the engine / vision binary (#5619).
pub const WINDOWS_SAC_BLOCKED: &str = "STARTUP_WINDOWS_SAC_BLOCKED";
pub const WINDOWS_SAC_MESSAGE: &str = "Windows 智能应用控制拦截了引擎或图像程序（WinError 4551）。请在「Windows 安全中心 › 应用和浏览器控制」中关闭智能应用控制，或等待已签名版本后再试。 / Windows Smart App Control blocked the engine or vision program (WinError 4551). Turn off Smart App Control under Windows Security › App & browser control, or wait for a signed build.";

fn memory_report(message: &str) -> Option<MemoryReport> {
    let lower = message.to_ascii_lowercase();
    if lower.contains("commit left")
        || lower.contains("room in the page file")
        || lower.contains("paging file is too small")
        || lower.contains("os error 1455")
    {
        return Some(MemoryReport::Commit);
    }
    let gpu = ["cuda", "hip", "vram", "gpu", "expertcache", "expert cache"]
        .iter()
        .any(|token| lower.contains(token));
    if resource_report(message)
        || lower.contains("vram free on this gpu")
        || lower.contains("expertcache: cudamalloc failed")
        || (gpu && lower.contains("out of memory"))
    {
        return Some(MemoryReport::Vram);
    }
    lower
        .contains("out of memory")
        .then_some(MemoryReport::Generic)
}

/// The engine log named in upstream's EngineDied text: "... (see PATH)".
/// A path may contain ')' (Program Files (x86)), so take the first candidate ending in ".log".
fn engine_log_path(message: &str) -> Option<std::path::PathBuf> {
    let start = message.find("(see ")? + 5;
    let rest = &message[start..];
    rest.char_indices()
        .filter(|(_, c)| *c == ')')
        .map(|(index, _)| rest[..index].trim())
        .find(|candidate| candidate.to_ascii_lowercase().ends_with(".log"))
        .map(std::path::PathBuf::from)
}

/// At most the last 64 KiB / 200 lines of the engine log, from this start's
/// "[strata] ... engine started:" line on. Missing, unreadable or older-than-the-attempt
/// files give nothing; reading never fails a diagnostic.
fn engine_log_tail(path: &std::path::Path, attempt_started_at: u64) -> Vec<String> {
    use std::io::{Read, Seek, SeekFrom};
    const LIMIT: u64 = 64 * 1024;
    let Ok(mut file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let Ok(metadata) = file.metadata() else {
        return Vec::new();
    };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64);
    // One second of slack for coarse file-system timestamps.
    if modified.is_some_and(|modified| modified + 1000 < attempt_started_at) {
        return Vec::new();
    }
    let start = metadata.len().saturating_sub(LIMIT);
    let mut bytes = Vec::new();
    if file.seek(SeekFrom::Start(start)).is_err()
        || file.take(LIMIT).read_to_end(&mut bytes).is_err()
    {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<&str> = text.lines().collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // a partial first line
    }
    if let Some(marker) = lines
        .iter()
        .rposition(|line| line.starts_with("[strata]") && line.contains("engine started:"))
    {
        lines.drain(..marker);
    }
    let keep = lines.len().saturating_sub(200);
    lines[keep..]
        .iter()
        .map(|line| line.trim_end().to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

/// The line Strata 0.2.2 exits with when every card in "gpu_roles" is Off.
fn all_cards_off(text: &str) -> bool {
    text.contains("every graphics card is set to Off")
}

/// Win11 Smart App Control / WDAC blocked an engine or vision executable (upstream #5619).
fn windows_sac_blocked(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("winerror 4551")
        || lower.contains("os error 4551")
        || lower.contains("smart app control")
        || lower.contains("application control policy")
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
    // Memory lines the engine wrote during this attempt: the service log (its stderr,
    // which carries upstream's 20-line EngineDied tail) and, when the error names it,
    // the engine log itself. Lines from the file have no time; they get `failed_at`.
    let engine_crashed = code == "STARTUP_ENGINE_CRASHED";
    let mut memory_lines: Vec<(u64, String, MemoryReport)> = Vec::new();
    if category == StartupCategory::Unknown || engine_crashed {
        for entry in &current {
            if let Some(kind) = memory_report(&entry.message) {
                memory_lines.push((entry.timestamp, entry.message.clone(), kind));
            }
        }
        if let Some(path) = engine_log_path(&message) {
            for line in engine_log_tail(&path, attempt_started_at) {
                if let Some(kind) = memory_report(&line) {
                    if !memory_lines.iter().any(|(_, seen, _)| seen.trim() == line) {
                        memory_lines.push((failed_at, line, kind));
                    }
                }
            }
        }
    }
    let memory = memory_lines.iter().map(|(_, _, kind)| *kind).max();
    if let Some(kind) = memory {
        // The engine named the allocation that failed: that is the reason it exited.
        let reported = engine_crashed && kind != MemoryReport::Generic;
        category = StartupCategory::Resource;
        confidence = if reported {
            StartupConfidence::Confirmed
        } else {
            StartupConfidence::Suspected
        };
        // Keep a structured original error code where available.
        if code == "STARTUP_UNKNOWN" || engine_crashed {
            code = match kind {
                MemoryReport::Commit => WINDOWS_COMMIT_LOW,
                MemoryReport::Vram => VRAM_INSUFFICIENT,
                MemoryReport::Generic if engine_crashed => VRAM_INSUFFICIENT,
                MemoryReport::Generic => "STARTUP_RESOURCE_REPORTED",
            }
            .into();
        }
    }
    // Strata 0.2.2 serve/server.py card_roles_lines: every card in "gpu_roles" is Off and the
    // CUDA/HIP/SYCL engine refuses to start. Say so instead of a generic engine exit.
    if matches!(category, StartupCategory::Unknown | StartupCategory::Engine)
        && (all_cards_off(&message) || current.iter().any(|entry| all_cards_off(&entry.message)))
    {
        category = StartupCategory::Config;
        confidence = StartupConfidence::Confirmed;
        code = "STARTUP_GPU_ALL_OFF".into();
        message = "显卡角色全部为「关闭」，此引擎至少需要一张主卡或辅助卡才能启动。请在启动配置的「显卡角色」中打开一张卡。 / Every graphics card is set to Off, and this engine needs a Main or Helper card to start. Turn a card on under GPU roles in the startup settings.".into();
    }
    // Win11 Smart App Control / WDAC: strata-vision.exe or the main engine is blocked (#5619).
    if matches!(category, StartupCategory::Unknown | StartupCategory::Engine)
        && (windows_sac_blocked(&message)
            || current
                .iter()
                .any(|entry| windows_sac_blocked(&entry.message)))
    {
        category = StartupCategory::Engine;
        confidence = StartupConfidence::Confirmed;
        code = WINDOWS_SAC_BLOCKED.into();
        message = WINDOWS_SAC_MESSAGE.into();
    }
    // Upstream server.py opens config["log"] for appending; a locked, read-only
    // or ACL-denied file ends the start with PermissionError [Errno 13].
    let mut log_evidence: Option<(u64, String)> = current
        .iter()
        .rev()
        .find(|entry| crate::engine_log::is_permission_error(&entry.message))
        .map(|entry| (entry.timestamp, entry.message.clone()));
    if crate::engine_log::is_permission_error(&message) {
        log_evidence = Some((failed_at, message.clone()));
    }
    if code == crate::engine_log::CODE
        || (matches!(
            category,
            StartupCategory::Unknown | StartupCategory::Engine | StartupCategory::Timeout
        ) && log_evidence.is_some())
    {
        if code != crate::engine_log::CODE {
            message = crate::engine_log::UNWRITABLE_MESSAGE.into();
        }
        category = StartupCategory::Files;
        confidence = StartupConfidence::Confirmed;
        code = crate::engine_log::CODE.into();
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
    if code == crate::engine_log::CODE {
        if let Some((at, text)) = &log_evidence {
            evidence.push(StartupEvidence {
                source: "serviceLog".into(),
                at: *at,
                message: safe(text),
            });
        }
    }
    if category == StartupCategory::Resource {
        // The strongest kind first, newest line of it; at most three lines.
        let strongest = memory.unwrap_or(MemoryReport::Generic);
        let mut picked: Vec<_> = memory_lines
            .iter()
            .rev()
            .filter(|(_, _, kind)| *kind == strongest)
            .chain(
                memory_lines
                    .iter()
                    .rev()
                    .filter(|(_, _, kind)| *kind != strongest),
            )
            .take(3)
            .collect();
        picked.sort_by_key(|(at, _, _)| *at);
        for (at, text, _) in picked {
            evidence.push(StartupEvidence {
                source: "serviceLog".into(),
                at: *at,
                message: safe(text),
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
    fn engine_log_permission_error_is_classified_with_repair_steps() {
        // Strata 0.2.1.x serve/server.py on Windows: open(cfg["log"], "a").
        let logs = vec![LogEntry {
            timestamp: 15,
            level: "error".into(),
            message: r"PermissionError: [Errno 13] Permission denied: 'C:\Users\u\AppData\Roaming\io.strata.manager\imports\local-7d19ff0a\engine.log'".into(),
        }];
        for raw in [
            "exit 1",
            &error("STARTUP_ENGINE_CRASHED", "engine exited", "starting"),
            &error("STARTUP_API_TIMEOUT", "timed out", "starting"),
        ] {
            let result = build("p", 10, 20, raw, &logs, None);
            assert_eq!(result.code, crate::engine_log::CODE);
            assert_eq!(result.category, StartupCategory::Files);
            assert_eq!(result.confidence, StartupConfidence::Confirmed);
            assert_eq!(result.actions[0], StartupAction::OpenFiles);
            for step in [
                "日志文件被占用或无权限",
                "残留",
                "只读",
                "权限",
                "360",
                "火绒",
                "Read-only",
            ] {
                assert!(result.message.contains(step), "{step}");
            }
            assert!(result
                .evidence
                .iter()
                .any(|item| item.source == "serviceLog" && item.message.contains("Errno 13")));
        }
        let direct = build(
            "p",
            10,
            20,
            &error(
                "STARTUP_ENGINE_CRASHED",
                "PermissionError: [Errno 13] Permission denied: '/data/engine.log'",
                "starting",
            ),
            &[],
            None,
        );
        assert_eq!(direct.code, crate::engine_log::CODE);
        // Manager's own preflight keeps its message (with the attempted paths).
        let preflight = build(
            "p",
            10,
            20,
            &error(
                crate::engine_log::CODE,
                "no writable log: /a/engine.log",
                "prepare",
            ),
            &[],
            None,
        );
        assert_eq!(preflight.category, StartupCategory::Files);
        assert_eq!(preflight.message, "no writable log: /a/engine.log");
        // Other permission errors and earlier sessions are not this failure.
        let model = vec![LogEntry {
            message: "PermissionError: [Errno 13] Permission denied: 'model.gguf'".into(),
            ..logs[0].clone()
        }];
        assert_eq!(
            build("p", 10, 20, "exit 1", &model, None).code,
            "STARTUP_UNKNOWN"
        );
        let old = vec![LogEntry {
            timestamp: 5,
            ..logs[0].clone()
        }];
        assert_eq!(
            build("p", 10, 20, "exit 1", &old, None).code,
            "STARTUP_UNKNOWN"
        );
        // A port conflict stays a port conflict.
        assert_eq!(
            build(
                "p",
                10,
                20,
                &error("STARTUP_PORT_IN_USE", "busy", "prepare"),
                &logs,
                None
            )
            .code,
            "STARTUP_PORT_IN_USE"
        );
    }

    #[test]
    fn log_unwritable_separates_the_preflight_from_an_engine_report() {
        assert_eq!(
            log_unwritable(&error("STARTUP_ENGINE_CRASHED", "x", "starting")),
            None
        );
        assert_eq!(
            log_unwritable(&error(crate::engine_log::CODE, "x", "prepare")),
            Some(true)
        );
        let reported = build(
            "p",
            10,
            20,
            "exit 1",
            &[LogEntry {
                timestamp: 15,
                level: "error".into(),
                message: "PermissionError: [Errno 13] Permission denied: 'engine.log'".into(),
            }],
            None,
        );
        assert_eq!(log_unwritable(&encode(&reported)), Some(false));
        let preflight = build(
            "p",
            10,
            20,
            &error(
                crate::engine_log::CODE,
                "Permission denied (os error 13)",
                "prepare",
            ),
            &[],
            None,
        );
        assert_eq!(log_unwritable(&encode(&preflight)), Some(true));
    }

    #[test]
    fn strata_022_all_cards_off_exit_points_to_the_gpu_roles() {
        // serve/server.py card_roles_lines (v0.2.2), printed before the engine starts.
        let logs = vec![LogEntry {
            timestamp: 15,
            level: "error".into(),
            message: "[strata] every graphics card is set to Off, and this engine cannot start without one. Turn a card on (Main or Helper) in the app or with strata launch --gpu-roles.".into(),
        }];
        for raw in [
            "exit 1",
            &error("STARTUP_ENGINE_CRASHED", "engine exited", "starting"),
        ] {
            let result = build("p", 10, 20, raw, &logs, None);
            assert_eq!(result.category, StartupCategory::Config);
            assert_eq!(result.confidence, StartupConfidence::Confirmed);
            assert_eq!(result.code, "STARTUP_GPU_ALL_OFF");
            assert_eq!(result.actions[0], StartupAction::OpenConfig);
            assert!(result.message.contains("显卡角色") && result.message.contains("GPU roles"));
        }
        // An older log line before this attempt is not this failure.
        let old = vec![LogEntry {
            timestamp: 5,
            ..logs[0].clone()
        }];
        assert_eq!(
            build("p", 10, 20, "exit 1", &old, None).code,
            "STARTUP_UNKNOWN"
        );
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

    fn engine_line(timestamp: u64, message: &str) -> LogEntry {
        LogEntry {
            timestamp,
            level: "stderr".into(),
            message: message.into(),
        }
    }

    fn engine_died(log: &str) -> String {
        error(
            "STARTUP_ENGINE_CRASHED",
            format!("引擎在加载模型时崩溃：EngineDied: the engine exited before it was ready (see {log})。完整报错见启动日志 / See the startup log for the full traceback"),
            "loading",
        )
    }

    #[test]
    fn engine_crash_with_vram_free_note_is_a_confirmed_vram_shortage() {
        // generate.cpp vram_free_note() and the auto expert cache's own lines (#4781).
        let logs = vec![
            engine_line(11, "strata generate: expert cache auto: 14.80 GiB free, 700 MiB reserved -> 112 slots"),
            engine_line(12, "strata generate: only 220 MiB free once the slots are written (reserve 700 MiB); shrinking the expert cache"),
            engine_line(13, "strata generate: the logits buffer failed (310 MiB of 16303 MiB VRAM free on this GPU)"),
        ];
        let result = build(
            "p",
            10,
            20,
            &engine_died(r"C:\Users\Koidz\strata\engine.log"),
            &logs,
            None,
        );
        assert_eq!(result.code, VRAM_INSUFFICIENT);
        assert_eq!(result.category, StartupCategory::Resource);
        assert_eq!(result.confidence, StartupConfidence::Confirmed);
        assert_eq!(result.actions[0], StartupAction::OpenResources);
        assert_eq!(result.phase, "loading");
        assert_eq!(result.evidence[0].source, "startupError");
        assert_eq!(result.evidence[1].message, logs[2].message);
        // The normal shrink line is not an allocation failure.
        assert!(memory_report(&logs[1].message).is_none());
        assert!(memory_report(&logs[0].message).is_none());
    }

    #[test]
    fn upstream_memory_lines_are_classified_by_what_ran_out() {
        for (line, kind) in [
            ("strata generate: ExpertCache: cudaMalloc failed: out of memory (Windows has 1.2 GiB of commit left: RAM + page file); trying a smaller expert cache: 64 slots", MemoryReport::Commit),
            ("strata generate: on Windows the graphics card's memory also needs room in the page file: set it to \"System managed\" (System > About > Advanced system settings > Performance > Advanced > Virtual memory), or lower --expert-cache", MemoryReport::Commit),
            ("OSError: [WinError 1455] The paging file is too small for this operation to complete", MemoryReport::Commit),
            ("strata generate: ExpertCache: cudaMalloc failed: out of memory", MemoryReport::Vram),
            ("native head upload: out of memory (180 MiB of 16303 MiB VRAM free on this GPU)", MemoryReport::Vram),
            ("CUDA error: out of memory", MemoryReport::Vram),
            ("hipErrorOutOfMemory", MemoryReport::Vram),
            ("fatal: out of memory", MemoryReport::Generic),
        ] {
            assert_eq!(memory_report(line), Some(kind), "{line}");
        }
        assert_eq!(memory_report("strata generate: loading layer 12/48"), None);
    }

    #[test]
    fn windows_commit_exhaustion_wins_over_the_cuda_line_it_contains() {
        let logs = vec![
            engine_line(11, "strata generate: ExpertCache: cudaMalloc failed: out of memory (Windows has 0.8 GiB of commit left: RAM + page file); trying a smaller expert cache: 32 slots"),
            engine_line(12, "strata generate: the logits buffer failed (300 MiB of 16303 MiB VRAM free on this GPU)"),
            engine_line(13, "strata generate: on Windows the graphics card's memory also needs room in the page file: set it to \"System managed\" (System > About > Advanced system settings > Performance > Advanced > Virtual memory), or lower --expert-cache"),
        ];
        let result = build("p", 10, 20, &engine_died("engine.log"), &logs, None);
        assert_eq!(result.code, WINDOWS_COMMIT_LOW);
        assert_eq!(result.category, StartupCategory::Resource);
        assert_eq!(result.confidence, StartupConfidence::Confirmed);
        let shown: Vec<_> = result
            .evidence
            .iter()
            .map(|item| item.message.as_str())
            .collect();
        assert!(shown.iter().any(|line| line.contains("commit left")));
        assert!(shown
            .iter()
            .any(|line| line.contains("room in the page file")));
    }

    #[test]
    fn a_bare_out_of_memory_in_an_engine_crash_is_suspected() {
        let logs = vec![engine_line(12, "fatal: out of memory")];
        let crashed = build("p", 10, 20, &engine_died("engine.log"), &logs, None);
        assert_eq!(crashed.code, VRAM_INSUFFICIENT);
        assert_eq!(crashed.confidence, StartupConfidence::Suspected);
        let unknown = build("p", 10, 20, "exit 1", &logs, None);
        assert_eq!(unknown.code, "STARTUP_RESOURCE_REPORTED");
        // An engine crash with no memory line stays an engine crash.
        let plain = build(
            "p",
            10,
            20,
            &engine_died("engine.log"),
            &[engine_line(12, "Traceback (most recent call last):")],
            None,
        );
        assert_eq!(plain.code, "STARTUP_ENGINE_CRASHED");
        assert_eq!(plain.category, StartupCategory::Engine);
    }

    #[test]
    fn the_engine_log_named_in_engine_died_is_read_from_this_start_only() {
        let directory = tempfile::tempdir().unwrap();
        let folder = directory.path().join("Program Files (x86)");
        std::fs::create_dir_all(&folder).unwrap();
        let log = folder.join("engine.log");
        std::fs::write(
            &log,
            "[strata] 2026-10-31 09:00:00 engine started: strata.exe --serve\n\
             strata generate: ExpertCache: cudaMalloc failed: out of memory (Windows has 0.5 GiB of commit left: RAM + page file); trying a smaller expert cache: 8 slots\n\
             [strata] 2026-11-01 09:00:00 engine started: strata.exe --serve\n\
             strata generate: expert cache auto: 14.80 GiB free, 700 MiB reserved -> 112 slots\n\
             native head upload: out of memory (120 MiB of 16303 MiB VRAM free on this GPU)\n",
        )
        .unwrap();
        let path = log.to_string_lossy().to_string();
        assert_eq!(
            engine_log_path(&format!("x (see {path}) exit 3221225477")),
            Some(log.clone())
        );
        let tail = engine_log_tail(&log, 0);
        assert!(tail[0].contains("2026-11-01"));
        assert!(!tail.iter().any(|line| line.contains("commit left")));
        // Nothing from the service log: the file alone is the evidence.
        let result = build("p", 10, 20, &engine_died(&path), &[], None);
        assert_eq!(result.code, VRAM_INSUFFICIENT);
        assert!(result
            .evidence
            .iter()
            .any(|item| item.source == "serviceLog"
                && item.at == 20
                && item.message.contains("VRAM free on this GPU")));
        // A log not written since the attempt began belongs to an earlier start.
        assert!(engine_log_tail(&log, u64::MAX / 2).is_empty());
        // A missing file is not an error.
        let missing = build(
            "p",
            10,
            20,
            &engine_died(r"C:\nowhere\engine.log"),
            &[],
            None,
        );
        assert_eq!(missing.code, "STARTUP_ENGINE_CRASHED");
        assert!(engine_log_tail(&directory.path().join("missing.log"), 0).is_empty());
    }

    #[test]
    fn a_large_engine_log_is_read_as_a_bounded_tail() {
        let directory = tempfile::tempdir().unwrap();
        let log = directory.path().join("engine.log");
        let mut text = "strata generate: CUDA error: out of memory\n".repeat(4000);
        text.push_str("strata generate: loading layer 48/48\n");
        std::fs::write(&log, text).unwrap();
        let tail = engine_log_tail(&log, 0);
        assert!(tail.len() <= 200);
        assert_eq!(tail.last().unwrap(), "strata generate: loading layer 48/48");
    }

    #[test]
    fn windows_sac_lines_are_recognized() {
        for line in [
            "OSError: [WinError 4551] An Application Control policy has blocked this file.",
            r"PermissionError: [WinError 4551] An Application Control policy has blocked this file: 'C:\Program Files\Strata\strata-vision.exe'",
            "failed to start strata-vision.exe: os error 4551",
            "Smart App Control blocked strata-vision.exe",
        ] {
            assert!(windows_sac_blocked(line), "{line}");
        }
        assert!(!windows_sac_blocked(
            "OSError: [WinError 1455] The paging file is too small for this operation to complete"
        ));
        assert!(!windows_sac_blocked("FileNotFoundError: [WinError 2]"));
    }

    #[test]
    fn windows_sac_block_is_classified_instead_of_a_generic_engine_crash() {
        // Upstream #5619: Win11 SAC On blocks strata-vision.exe (and can block the main engine).
        let logs = vec![LogEntry {
            timestamp: 15,
            level: "error".into(),
            message: r"OSError: [WinError 4551] An Application Control policy has blocked this file: 'D:\AI\Strata\strata-vision.exe'".into(),
        }];
        for raw in [
            "exit 1",
            &error("STARTUP_ENGINE_CRASHED", "engine exited", "loading"),
            &error(
                "STARTUP_ENGINE_CRASHED",
                "OSError: [WinError 4551] An Application Control policy has blocked this file.",
                "loading",
            ),
        ] {
            let result = build("p", 10, 20, raw, &logs, None);
            assert_eq!(result.code, WINDOWS_SAC_BLOCKED);
            assert_eq!(result.category, StartupCategory::Engine);
            assert_eq!(result.confidence, StartupConfidence::Confirmed);
            assert_eq!(result.actions[0], StartupAction::ViewLogs);
            assert!(
                result.message.contains("智能应用控制")
                    && result.message.contains("Smart App Control"),
                "{}",
                result.message
            );
            assert!(
                result.message.contains("应用和浏览器控制")
                    || result.message.contains("App & browser control")
            );
        }
        // An older log line before this attempt is not this failure.
        let old = vec![LogEntry {
            timestamp: 5,
            ..logs[0].clone()
        }];
        assert_eq!(
            build("p", 10, 20, "exit 1", &old, None).code,
            "STARTUP_UNKNOWN"
        );
        // A bare engine crash without SAC wording stays an engine crash.
        assert_eq!(
            build(
                "p",
                10,
                20,
                &error("STARTUP_ENGINE_CRASHED", "engine exited", "loading"),
                &[engine_line(12, "Traceback (most recent call last):")],
                None,
            )
            .code,
            "STARTUP_ENGINE_CRASHED"
        );
    }
}
