//! Plain-text diagnostics for clipboard paste into support chats.
use crate::types::{now, ServiceProfile};
use crate::{cached_environment, output, read_logs, storage, RuntimeState};
use serde_json::Value;

fn gb(bytes: u64) -> String {
    format!("{:.1}", bytes as f64 / 1_073_741_824.0)
}

fn clip(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_owned();
    }
    trimmed.chars().take(max).collect::<String>() + "…"
}

/// Build a credential-safe plain-text report for support.
pub fn support_diagnostics_text(
    state: &RuntimeState,
    profile: Option<&ServiceProfile>,
    extras: &Value,
) -> Result<String, String> {
    let env = cached_environment(state);
    let mut lines = Vec::new();
    lines.push("Strata Manager 诊断信息 / Diagnostics".into());
    lines.push(format!("生成时间 / Generated: {}", now()));
    lines.push(format!("应用版本 / App: {}", env.app_version));
    lines.push(format!("系统 / OS: {} ({})", env.os, env.arch));
    lines.push(format!("处理器 / CPU: {}", env.cpu_name));
    lines.push(format!(
        "内存 / RAM: {} GB 总计 · {} GB 可用",
        gb(env.total_memory),
        gb(env.available_memory)
    ));
    if env.gpus.is_empty() {
        lines.push("GPU: （未检测到 nvidia-smi 输出）".into());
    } else if !env.gpu_details.is_empty() {
        for (index, gpu) in env.gpu_details.iter().enumerate() {
            lines.push(format!(
                "GPU[{index}]: {}",
                crate::apple_gpu::diagnostic_line(gpu)
            ));
        }
    } else {
        for (index, gpu) in env.gpus.iter().enumerate() {
            lines.push(format!("GPU[{index}]: {gpu}"));
        }
    }
    if let Some(python) = &env.python {
        lines.push(format!("系统 Python / System Python: {python}"));
    }

    let install = extras
        .get("installDir")
        .and_then(Value::as_str)
        .or_else(|| profile.map(|item| item.install_dir.as_str()))
        .unwrap_or("")
        .trim();
    let python_path = extras
        .get("pythonPath")
        .and_then(Value::as_str)
        .or_else(|| profile.map(|item| item.python_path.as_str()))
        .unwrap_or("")
        .trim();
    let config_path = extras
        .get("configPath")
        .and_then(Value::as_str)
        .or_else(|| profile.map(|item| item.config_path.as_str()))
        .unwrap_or("")
        .trim();
    let name = extras
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| profile.map(|item| item.name.as_str()))
        .unwrap_or("")
        .trim();
    let reason = extras
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let runtime_version = extras
        .get("runtimeVersion")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();

    if !name.is_empty() {
        lines.push(format!("模型 / Model: {name}"));
    }
    if !install.is_empty() {
        lines.push(format!("安装目录 / Install dir: {install}"));
    }
    if !config_path.is_empty() {
        lines.push(format!("配置路径 / Config: {config_path}"));
    }
    if !python_path.is_empty() {
        lines.push(format!("检测的 Python / Probed Python: {python_path}"));
    }
    // The release users install (v0.2.2) is reported apart from the engine build (0.1.47).
    let release_version = extras
        .get("releaseVersion")
        .and_then(Value::as_str)
        .map(|value| value.trim().trim_start_matches('v').to_owned())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            (!install.is_empty())
                .then(|| {
                    crate::discovery::release_version(
                        std::path::Path::new(install),
                        (!runtime_version.is_empty()).then_some(runtime_version),
                    )
                })
                .flatten()
        });
    if let Some(release) = release_version.filter(|value| value.len() <= 80) {
        lines.push(format!("Strata Release: v{release}"));
    }
    if !runtime_version.is_empty() {
        lines.push(format!("引擎版本 / Engine: {runtime_version}"));
    } else if !install.is_empty() {
        if let Some(revision) = output("git", &["-C", install, "rev-parse", "--short", "HEAD"]) {
            lines.push(format!("引擎 git / Engine git: {}", revision.trim()));
        }
    }
    if !reason.is_empty() {
        lines.push(format!("发现问题 / Issue: {reason}"));
    }

    if let Some(profile) = profile {
        if let Ok(mut map) = state.processes.lock() {
            if let Some(process) = map.get_mut(&profile.id) {
                if let Ok(status) = process.refresh() {
                    lines.push(format!(
                        "进程 / Process: running={} owned={} pid={:?}",
                        status.running, status.owned, status.pid
                    ));
                }
            }
        }
        if let Ok(entries) = read_logs(state, profile.clone(), 30) {
            lines.push(
                "近期日志（已截断，不含请求正文）/ Recent logs (truncated, no request bodies):"
                    .into(),
            );
            for entry in entries.iter().rev().take(20).rev() {
                lines.push(format!("  [{}] {}", entry.level, clip(&entry.message, 240)));
            }
        }
        if let Ok(mut config) = storage::read(profile) {
            storage::redact(&mut config);
            if let Some(model) = config.get("model_name").and_then(Value::as_str) {
                lines.push(format!("配置模型名 / config.model_name: {model}"));
            }
            if let Some(engine) = config.get("engine").and_then(Value::as_str) {
                lines.push(format!("配置引擎 / config.engine: {engine}"));
            }
        }
    }

    lines.push("（已省略 API 密钥与请求正文 / API keys and request bodies omitted）".into());
    Ok(lines.join("\n"))
}
