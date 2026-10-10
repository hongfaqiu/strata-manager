use crate::types::{now, LocalModel, ServiceProfile};
use serde_json::Value;
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

pub fn engine_logs(
    profile: &ServiceProfile,
    limit: usize,
) -> Result<Vec<crate::types::LogEntry>, String> {
    let config = match read(profile) {
        Ok(config) => config,
        Err(_) => return Ok(vec![]),
    };
    let Some(log) = config.get("log").and_then(Value::as_str) else {
        return Ok(vec![]);
    };
    let mut path = PathBuf::from(log);
    if !path.is_absolute() {
        let cwd = config
            .get("cwd")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(&profile.install_dir));
        path = (if cwd.is_absolute() {
            cwd
        } else {
            PathBuf::from(&profile.install_dir).join(cwd)
        })
        .join(path);
    }
    if !path.is_file() {
        return Ok(vec![]);
    }
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    let timestamp = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or_else(now);
    let start = metadata.len().saturating_sub(256 * 1024);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(256 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<_> = text.lines().collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    Ok(lines
        .iter()
        .skip(lines.len().saturating_sub(limit.min(2000)))
        .map(|line| crate::types::LogEntry {
            timestamp,
            level: "engine".into(),
            message: line.chars().take(8192).collect(),
        })
        .collect())
}

pub fn config_path(profile: &ServiceProfile) -> Result<PathBuf, String> {
    let path = Path::new(&profile.config_path);
    if !path.is_absolute() || path.extension().and_then(|x| x.to_str()) != Some("json") {
        return Err("配置文件必须为绝对路径的 .json 文件".into());
    }
    let parent = dunce::canonicalize(path.parent().ok_or("配置文件缺少父目录")?)
        .map_err(|e| e.to_string())?;
    let result = parent.join(path.file_name().ok_or("配置文件名为空")?);
    if result.is_symlink() {
        return Err("配置文件不能是符号链接".into());
    }
    Ok(result)
}
pub fn read(profile: &ServiceProfile) -> Result<Value, String> {
    let path = config_path(profile)?;
    let meta = fs::metadata(&path).map_err(|e| format!("配置读取失败: {e}"))?;
    if meta.len() > 4 * 1024 * 1024 {
        return Err("配置文件超过 4 MB".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("配置 JSON 无效: {e}"))
}
pub fn validate(config: &Value) -> Result<(), String> {
    let object = config.as_object().ok_or("配置必须是 JSON 对象")?;
    for key in [
        "exe",
        "cwd",
        "tokenizer",
        "model_name",
        "log",
        "host",
        "api_key",
    ] {
        if let Some(value) = object.get(key) {
            if !value.is_string() {
                return Err(format!("{key} 必须是字符串"));
            }
        }
    }
    if let Some(args) = object.get("args") {
        if !args
            .as_array()
            .map(|a| a.iter().all(Value::is_string))
            .unwrap_or(false)
        {
            return Err("args 必须是字符串数组".into());
        }
    }
    if let Some(port) = object.get("port") {
        if !port
            .as_u64()
            .map(|x| (1..=65535).contains(&x))
            .unwrap_or(false)
        {
            return Err("port 必须为 1–65535".into());
        }
    }
    for key in [
        "sampling",
        "env",
        "vision",
        "mcp_servers",
        "mcpServers",
        "mcp",
    ] {
        if let Some(value) = object.get(key) {
            if !value.is_object() && !value.is_null() {
                return Err(format!("{key} 必须是对象或 null"));
            }
        }
    }
    for key in ["api_monitor", "open_browser"] {
        if let Some(value) = object.get(key) {
            if !value.is_boolean() {
                return Err(format!("{key} 必须是布尔值"));
            }
        }
    }
    if let Some(parallel) = object.get("parallel") {
        if !parallel
            .as_u64()
            .map(|n| (1..=64).contains(&n))
            .unwrap_or(false)
        {
            return Err("parallel 必须为 1–64".into());
        }
    }
    Ok(())
}
pub fn backup(path: &Path) -> Result<(), String> {
    if path.exists() {
        let destination = path.with_file_name(format!(
            "{}.{}-{}.bak",
            path.file_name().unwrap_or_default().to_string_lossy(),
            now(),
            uuid::Uuid::new_v4()
        ));
        fs::copy(path, destination).map_err(|e| format!("配置备份失败: {e}"))?;
    }
    Ok(())
}
pub fn write(profile: &ServiceProfile, config: &Value) -> Result<(), String> {
    validate(config)?;
    let path = config_path(profile)?;
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().ok_or("配置父目录无效")?)
        .map_err(|e| e.to_string())?;
    temp.write_all(&serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    backup(&path)?;
    temp.persist(&path)
        .map_err(|e| format!("配置原子替换失败（原文件保留）: {e}"))?;
    Ok(())
}

pub fn write_markdown_export(path: &Path, content: &str) -> Result<(), String> {
    if !path.is_absolute()
        || !path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
    {
        return Err("导出文件必须为绝对路径的 .md 文件".into());
    }
    if content.len() > 16 * 1024 * 1024 {
        return Err("导出内容超过 16 MiB".into());
    }
    if path.is_dir() || path.is_symlink() {
        return Err("导出目标不能是目录或符号链接".into());
    }
    let parent = dunce::canonicalize(path.parent().ok_or("导出文件缺少父目录")?)
        .map_err(|e| format!("导出目录不可用: {e}"))?;
    let destination = parent.join(path.file_name().ok_or("导出文件名为空")?);
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temporary
        .write_all(content.as_bytes())
        .map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary
        .persist(destination)
        .map_err(|e| format!("Markdown 保存失败: {e}"))?;
    Ok(())
}
pub fn local_models(profile: &ServiceProfile) -> Result<Vec<LocalModel>, String> {
    let mut local_profile = profile.clone();
    local_profile.managed = true; // Listing a selected local runtime is a read-only operation.
    let root = crate::processes::runtime_dir(&local_profile)?;
    let mut paths = if profile.config_path.trim().is_empty() {
        vec![]
    } else {
        vec![config_path(profile)?]
    };
    for item in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let path = item.map_err(|e| e.to_string())?.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        if name.starts_with("strata-")
            && name.ends_with(".json")
            && !name.ends_with(".shared-settings.json")
            && !paths.contains(&path)
        {
            paths.push(path);
        }
    }
    let mut models = Vec::new();
    for path in paths {
        if !path.is_file() {
            continue;
        }
        let config: Value = match fs::read(&path)
            .ok()
            .and_then(|v| serde_json::from_slice(&v).ok())
        {
            Some(v) => v,
            None => continue,
        };
        if !config.get("exe").is_some_and(Value::is_string) {
            continue;
        }
        let Some(args) = config.get("args").and_then(Value::as_array) else {
            continue;
        };
        let Some(model) = ["--native", "--model", "-m", "--pack"]
            .iter()
            .find_map(|flag| {
                args.windows(2)
                    .find(|v| v[0] == *flag)
                    .and_then(|v| v[1].as_str())
            })
        else {
            continue;
        };
        let mut model_path = PathBuf::from(model);
        if !model_path.is_absolute() {
            let cwd = config
                .get("cwd")
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .unwrap_or(root.clone());
            model_path = (if cwd.is_absolute() {
                cwd
            } else {
                root.join(cwd)
            })
            .join(model_path);
        }
        models.push(LocalModel {
            name: config
                .get("model_name")
                .and_then(Value::as_str)
                .unwrap_or(model)
                .into(),
            config_path: path.to_string_lossy().into(),
            model_path: model_path.to_string_lossy().into(),
            size_bytes: fs::metadata(model_path)
                .ok()
                .filter(|m| m.is_file())
                .map(|m| m.len()),
        });
    }
    Ok(models)
}
pub fn redact(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                let key = key.to_ascii_lowercase();
                if ["env", "headers", "args"].contains(&key.as_str()) {
                    // MCP credentials may use arbitrary argument or environment names.
                    *value = Value::String("[REDACTED]".into());
                } else if [
                    "key",
                    "token",
                    "secret",
                    "password",
                    "authorization",
                    "cookie",
                ]
                .iter()
                .any(|part| key.contains(part))
                {
                    *value = Value::String("[REDACTED]".into());
                } else {
                    redact(value);
                }
            }
        }
        Value::Array(array) => {
            for value in array {
                redact(value);
            }
        }
        Value::String(text) => {
            // URLs can embed passwords, query-string tokens or paths to personal data.
            if let Ok(mut url) = url::Url::parse(text) {
                if ["http", "https"].contains(&url.scheme()) {
                    let _ = url.set_username("");
                    let _ = url.set_password(None);
                    url.set_query(None);
                    url.set_fragment(None);
                    *text = url.to_string();
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn markdown_export_writes_exact_utf8_and_rejects_invalid_targets_without_changes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("conversation.md");
        let content = "# 对话🙂\n\n**助手**：你好\n";
        write_markdown_export(&path, content).unwrap();
        assert_eq!(fs::read(&path).unwrap(), content.as_bytes());
        assert!(write_markdown_export(Path::new("relative.md"), "fail").is_err());
        assert!(write_markdown_export(&temp.path().join("config.json"), "fail").is_err());
        let directory = temp.path().join("directory.md");
        fs::create_dir(&directory).unwrap();
        assert!(write_markdown_export(&directory, "fail").is_err());
        assert!(write_markdown_export(&path, &"x".repeat(16 * 1024 * 1024 + 1)).is_err());
        assert_eq!(fs::read(&path).unwrap(), content.as_bytes());
        write_markdown_export(&path, "replacement\n").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"replacement\n");
    }
    #[test]
    fn validates_typed_fields() {
        assert!(validate(&serde_json::json!({"port":0})).is_err());
        assert!(validate(&serde_json::json!({"args":["--model","a"],"port":8080})).is_ok());
    }
    #[test]
    fn recursively_redacts_credentials() {
        let mut v = serde_json::json!({"api_key":"secret","mcp_servers":{"a":{"env":{"TOKEN":"secret","ARBITRARY":"secret"},"args":["secret"],"headers":{"X-Custom":"secret"}}},"url":"https://user:password@host/api?token=secret"});
        redact(&mut v);
        assert!(!v.to_string().contains("secret"));
        assert!(!v.to_string().contains("password@"));
    }
    #[test]
    fn config_write_is_atomic_and_keeps_backup() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("strata-test.json");
        let profile = ServiceProfile {
            id: "test".into(),
            name: "test".into(),
            base_url: "http://127.0.0.1:8080".into(),
            install_dir: directory.path().to_string_lossy().into(),
            python_path: "".into(),
            config_path: path.to_string_lossy().into(),
            managed: true,
        };
        let original = serde_json::json!({"args":["--native","weights.gguf"],"port":8080});
        fs::write(&path, serde_json::to_vec(&original).unwrap()).unwrap();
        write(&profile, &serde_json::json!({"port":8081})).unwrap();
        assert_eq!(read(&profile).unwrap()["port"], 8081);
        let backup_path = fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.path())
            .find(|p| p.extension().is_some_and(|x| x == "bak"))
            .unwrap();
        let backed_up: Value = serde_json::from_slice(&fs::read(backup_path).unwrap()).unwrap();
        assert_eq!(backed_up, original);
        assert!(write(&profile, &serde_json::json!({"port":0})).is_err());
        assert_eq!(read(&profile).unwrap()["port"], 8081);
    }
}
