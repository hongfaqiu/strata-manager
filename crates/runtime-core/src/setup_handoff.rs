//! Durable setup-to-registration handoff. This module never starts a service.
use crate::{
    discovery::LocalCandidate, disk::dsv41, processes::TaskRecord, types::*, RuntimeState,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS setup_handoffs(task_id TEXT PRIMARY KEY,intent TEXT NOT NULL,commands_succeeded INTEGER NOT NULL DEFAULT 0,result TEXT NOT NULL);";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupIntent {
    pub profile: ServiceProfile,
    pub family: String,
    pub quant: String,
    pub context: u32,
    pub images: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HandoffResult {
    pub task_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<ConfigChoice>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConfigChoice {
    pub config_path: String,
    pub name: String,
}

pub struct SetupHook {
    pub state: Arc<RuntimeState>,
    pub intent: SetupIntent,
}

fn result(task_id: &str, status: &str, error: Option<String>) -> HandoffResult {
    HandoffResult {
        task_id: task_id.into(),
        status: status.into(),
        profile_id: None,
        error,
        choices: Vec::new(),
    }
}

fn write_result(connection: &Connection, value: &HandoffResult) -> Result<(), String> {
    connection
        .execute(
            "UPDATE setup_handoffs SET result=?2 WHERE task_id=?1",
            params![
                value.task_id,
                serde_json::to_string(value).map_err(|e| e.to_string())?
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Both the task and its full setup intent commit before any child is spawned.
pub fn persist_launch(hook: &SetupHook, record: &TaskRecord) -> Result<(), String> {
    let mut database = hook.state.database.lock().map_err(|e| e.to_string())?;
    database.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    let transaction = database.transaction().map_err(|e| e.to_string())?;
    crate::processes::persist_task_connection(&transaction, record)?;
    transaction
        .execute(
            "INSERT INTO setup_handoffs(task_id,intent,result) VALUES(?1,?2,?3)",
            params![
                record.status.id,
                serde_json::to_string(&hook.intent).map_err(|e| e.to_string())?,
                serde_json::to_string(&result(&record.status.id, "pending", None))
                    .map_err(|e| e.to_string())?
            ],
        )
        .map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())
}

fn read_entry(
    state: &RuntimeState,
    task_id: &str,
) -> Result<(SetupIntent, bool, HandoffResult), String> {
    let database = state.database.lock().map_err(|e| e.to_string())?;
    let (intent, succeeded, value): (String, bool, String) = database
        .query_row(
            "SELECT intent,commands_succeeded,result FROM setup_handoffs WHERE task_id=?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|e| format!("模型准备任务未登记: {e}"))?;
    Ok((
        serde_json::from_str(&intent).map_err(|e| e.to_string())?,
        succeeded,
        serde_json::from_str(&value).map_err(|e| e.to_string())?,
    ))
}

/// Serialize against cancellation until the durable command-success point and
/// registration have completed. No request can cancel after this commit point.
pub fn commands_completed(hook: &SetupHook, task_id: &str) -> Result<(), String> {
    let _operation = hook
        .state
        .runtime_operations
        .lock()
        .map_err(|e| e.to_string())?;
    let mut tasks = hook.state.tasks.lock().map_err(|e| e.to_string())?;
    let record = tasks.get_mut(task_id).ok_or("模型准备任务不存在")?;
    if record.cancelled {
        return Err("任务已取消；没有自动登记模型".into());
    }
    record.status.state = "completed".into();
    record.status.finished_at = Some(now());
    record.status.message = "模型文件准备完成，正在验证并登记".into();
    {
        let mut database = hook.state.database.lock().map_err(|e| e.to_string())?;
        let transaction = database.transaction().map_err(|e| e.to_string())?;
        transaction
            .execute(
                "UPDATE setup_handoffs SET commands_succeeded=1 WHERE task_id=?1",
                [task_id],
            )
            .map_err(|e| e.to_string())?;
        crate::processes::persist_task_connection(&transaction, record)?;
        transaction.commit().map_err(|e| e.to_string())?;
    }
    let value = resolve_locked(&hook.state, task_id, None)?;
    record.status.message = match value.status.as_str() {
        "registered" => "模型准备完成并已加入本机模型；可选择使用".into(),
        _ => format!(
            "模型文件准备完成；{}",
            value.error.as_deref().unwrap_or("登记需要处理")
        ),
    };
    crate::processes::persist_task(&hook.state.database, record)?;
    Ok(())
}

pub fn terminated(hook: &SetupHook, task: &TaskStatus) -> Result<(), String> {
    if task.state == "completed" {
        return Ok(());
    }
    let (_, succeeded, _) = read_entry(&hook.state, &task.id)?;
    if succeeded {
        return Ok(());
    }
    let value = result(
        &task.id,
        if task.state == "cancelled" {
            "cancelled"
        } else {
            "failed"
        },
        Some(task.message.clone()),
    );
    write_result(
        &*hook.state.database.lock().map_err(|e| e.to_string())?,
        &value,
    )
}

pub fn list(state: &RuntimeState) -> Result<Vec<HandoffResult>, String> {
    let database = state.database.lock().map_err(|e| e.to_string())?;
    database.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    let mut query = database.prepare("SELECT h.result FROM setup_handoffs h JOIN tasks t ON t.id=h.task_id ORDER BY t.rowid DESC LIMIT 100").map_err(|e|e.to_string())?;
    let values = query
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .map(|row| {
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect();
    values
}

pub fn resolve(
    state: &RuntimeState,
    task_id: &str,
    config_path: Option<&str>,
) -> Result<HandoffResult, String> {
    let _operation = state.runtime_operations.lock().map_err(|e| e.to_string())?;
    let (intent, _, previous) = read_entry(state, task_id)?;
    if previous.status == "registered" || previous.status == "cancelled" {
        return Ok(previous);
    }
    let root = dunce::canonicalize(&intent.profile.install_dir).map_err(|e| e.to_string())?;
    if state
        .tasks
        .lock()
        .map_err(|e| e.to_string())?
        .values()
        .any(|task| task.status.state == "running" && task.runtime_path.as_ref() == Some(&root))
    {
        return Err("该运行环境仍在准备文件，请等待当前任务结束再重新检测".into());
    }
    resolve_locked(state, task_id, config_path)
}

fn resolve_locked(
    state: &RuntimeState,
    task_id: &str,
    config_path: Option<&str>,
) -> Result<HandoffResult, String> {
    let (intent, succeeded, previous) = read_entry(state, task_id)?;
    if previous.status == "registered" || previous.status == "cancelled" {
        return Ok(previous);
    }
    if !succeeded {
        return Err("准备命令尚未成功结束；不会登记失败或取消任务的文件".into());
    }
    let value = match find_and_register(state, &intent, config_path) {
        Ok(profile_id) => HandoffResult {
            task_id: task_id.into(),
            status: "registered".into(),
            profile_id: Some(profile_id),
            error: None,
            choices: Vec::new(),
        },
        Err((status, profile_id, error, choices)) => HandoffResult {
            task_id: task_id.into(),
            status: status.into(),
            profile_id,
            error: Some(error),
            choices,
        },
    };
    write_result(&*state.database.lock().map_err(|e| e.to_string())?, &value)?;
    Ok(value)
}

type RegistrationError = (&'static str, Option<String>, String, Vec<ConfigChoice>);
fn failure(error: impl Into<String>) -> RegistrationError {
    ("failed", None, error.into(), Vec::new())
}

fn family_name(family: &str) -> Option<&'static str> {
    match family {
        "qwen" => Some("qwen3.8-flash-next"),
        "swift" => Some("swift-1.5"),
        "coder" => Some("qwen3.8-flash-next-coder"),
        "unsloth" => Some("qwen3.8-flash-next-unsloth"),
        "qwen36" => Some("qwen3.6-35b-a3b"), // setup.py OWN_PATH_FAMILIES name
        // Manager's ORCA.md import (orca_import.rs), not a setup.py family.
        "orca" => Some("orcarouter-qwen3.8-flash-next-uncensored"),
        _ => None,
    }
}

/// The model_name a finished setup task registers: setup.py's `<family name>-<quant>`, or Manager's
/// `community-<slug>-<quant>` for a community model (community_model.rs renames the config to it).
fn expected_model_name(intent: &SetupIntent) -> Option<String> {
    if let Some(slug) = intent
        .family
        .strip_prefix(crate::community_model::FAMILY_PREFIX)
    {
        return Some(crate::community_model::model_name(slug, &intent.quant));
    }
    // setup.py MULTI_FILE_FAMILIES: one model_name for every DeepSeek-V4.1-Flash set; the set is in the file name.
    if intent.family == dsv41::FAMILY {
        return Some(dsv41::MODEL_NAME.into());
    }
    family_name(&intent.family).map(|name| format!("{name}-{}", intent.quant.to_ascii_lowercase()))
}

/// The config file a family that shares one model_name across sets writes: `strata-<tag lower>.json` (setup.py cfg_path).
fn expected_config_file(intent: &SetupIntent) -> Option<String> {
    (intent.family == dsv41::FAMILY)
        .then(|| dsv41::set(&intent.quant))
        .flatten()
        .map(|set| format!("strata-{}.json", set.tag().to_lowercase()))
}

fn context(value: &Value) -> Option<u32> {
    let args = value.get("args")?.as_array()?;
    let indices: Vec<_> = args
        .iter()
        .enumerate()
        .filter(|(_, arg)| arg.as_str() == Some("--max-context"))
        .map(|(index, _)| index)
        .collect();
    if indices.len() != 1 {
        return None;
    }
    args.get(indices[0] + 1)?.as_str()?.parse().ok()
}

fn checked_config(path: &Path) -> Result<Value, String> {
    if path.is_symlink() {
        return Err("配置文件不能是符号链接".into());
    }
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 2 * 1024 * 1024 {
        return Err("模型配置不存在或大小异常".into());
    }
    let value: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    crate::storage::validate(&value)?;
    Ok(value)
}

fn compatible(value: &Value, intent: &SetupIntent) -> bool {
    let expected = expected_model_name(intent);
    value
        .get("model_name")
        .and_then(Value::as_str)
        .zip(expected)
        .is_some_and(|(name, expected)| name.eq_ignore_ascii_case(&expected))
        && context(value) == Some(intent.context)
        && value.get("vision").is_some_and(Value::is_object) == intent.images
}

fn model_references(value: &Value, root: &Path) -> Result<Vec<PathBuf>, String> {
    let cwd = value
        .get("cwd")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| root.into());
    let cwd = if cwd.is_absolute() {
        cwd
    } else {
        root.join(cwd)
    };
    let args = value
        .get("args")
        .and_then(Value::as_array)
        .ok_or("配置没有模型参数")?;
    let mut paths = Vec::new();
    for flag in ["--native", "--model", "-m", "--pack", "--ple-gguf"] {
        for pair in args
            .windows(2)
            .filter(|pair| pair[0].as_str() == Some(flag))
        {
            let path = PathBuf::from(pair[1].as_str().ok_or("模型文件路径无效")?);
            paths.push(
                dunce::canonicalize(if path.is_absolute() {
                    path
                } else {
                    cwd.join(path)
                })
                .map_err(|e| e.to_string())?,
            );
        }
    }
    if paths.is_empty() {
        return Err("配置没有模型权重路径".into());
    }
    Ok(paths)
}

fn asset_check(value: &Value, root: &Path) -> Result<(), String> {
    let cwd = value
        .get("cwd")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| root.into());
    let cwd = if cwd.is_absolute() {
        cwd
    } else {
        root.join(cwd)
    };
    let resolve = |text: &str| {
        let path = PathBuf::from(text);
        if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        }
    };
    let engine = value
        .get("exe")
        .and_then(Value::as_str)
        .ok_or("配置没有引擎文件")?;
    if !fs::metadata(resolve(engine)).is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
    {
        return Err("模型引擎文件不完整".into());
    }
    let tokenizer = value
        .get("tokenizer")
        .and_then(Value::as_str)
        .ok_or("配置没有tokenizer")?;
    for name in ["vocab.json", "merges.txt", "token_type.json"] {
        if !resolve(tokenizer).join(name).is_file() {
            return Err(format!("tokenizer缺少{name}"));
        }
    }
    if let Some(vision) = value.get("vision").and_then(Value::as_object) {
        for field in ["exe", "model", "mmproj"] {
            let path = vision
                .get(field)
                .and_then(Value::as_str)
                .ok_or_else(|| format!("图片配置缺少{field}"))?;
            if !fs::metadata(resolve(path))
                .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
            {
                return Err(format!("图片{field}文件不完整"));
            }
        }
    }
    let args = value
        .get("args")
        .and_then(Value::as_array)
        .ok_or("配置没有引擎参数")?;
    for flag in [
        "--native",
        "--model",
        "-m",
        "--pack",
        "--ple-gguf",
        "--mtp",
        "--expert-profile",
    ] {
        for pair in args
            .windows(2)
            .filter(|pair| pair[0].as_str() == Some(flag))
        {
            let value = pair[1].as_str().ok_or("模型资源路径类型无效")?;
            // Qwen3.6 own-path uses --mtp <count> (drafts per step), not a draft-file path.
            if flag == "--mtp" && value.parse::<u32>().is_ok() {
                continue;
            }
            let path = PathBuf::from(value);
            let path = if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            };
            let metadata =
                fs::metadata(&path).map_err(|_| format!("{flag} 指向的模型资源不完整"))?;
            if metadata.is_file() && metadata.len() == 0 {
                return Err(format!("{flag} 指向的模型资源为空，未登记"));
            }
        }
    }
    Ok(())
}

fn find_and_register(
    state: &RuntimeState,
    intent: &SetupIntent,
    chosen: Option<&str>,
) -> Result<String, RegistrationError> {
    let root =
        dunce::canonicalize(&intent.profile.install_dir).map_err(|e| failure(e.to_string()))?;
    let expected =
        expected_model_name(intent).ok_or_else(|| failure("未知的模型family，未登记"))?;
    let mut candidates = Vec::new();
    let mut incomplete = Vec::new();
    for directory in [root.clone(), root.join("configs")] {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        let paths: Vec<_> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension().and_then(|v| v.to_str()) == Some("json")
                    && !path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .ends_with(".shared-settings.json")
            })
            .filter(|path| {
                expected_config_file(intent).is_none_or(|name| {
                    path.file_name()
                        .is_some_and(|file| file.to_string_lossy().eq_ignore_ascii_case(&name))
                })
            })
            .take(129)
            .collect();
        if paths.len() > 128 {
            return Err(failure("模型配置数量过多，请选择本次准备的配置"));
        }
        for path in paths {
            let Ok(value) = checked_config(&path) else {
                continue;
            };
            if value
                .get("model_name")
                .and_then(Value::as_str)
                .is_some_and(|name| name.eq_ignore_ascii_case(&expected))
            {
                if let Err(error) = asset_check(&value, &root) {
                    incomplete.push(error);
                    continue;
                }
                let path = dunce::canonicalize(&path).map_err(|e| failure(e.to_string()))?;
                if path.starts_with(&root) {
                    candidates.push((path, value));
                }
            }
        }
    }
    candidates.sort_by(|a, b| a.0.cmp(&b.0));
    candidates.dedup_by(|a, b| a.0 == b.0);
    let selected = if let Some(chosen) = chosen {
        let chosen = dunce::canonicalize(chosen).map_err(|e| failure(e.to_string()))?;
        candidates
            .into_iter()
            .find(|(path, _)| *path == chosen)
            .ok_or_else(|| failure("所选配置不属于本次准备的模型family/quant"))?
    } else {
        if candidates.len() > 1 {
            let choices = candidates
                .iter()
                .map(|(path, value)| ConfigChoice {
                    config_path: path.to_string_lossy().into(),
                    name: format!(
                        "{} · {} tokens{}",
                        expected,
                        context(value)
                            .map(|v| v.to_string())
                            .unwrap_or_else(|| "?".into()),
                        if value.get("vision").is_some_and(Value::is_object) {
                            " · images"
                        } else {
                            ""
                        }
                    ),
                })
                .collect();
            return Err((
                "needs-choice",
                None,
                format!(
                    "找到 {} 份同型号配置，请选择本次准备的配置；当前模型保持不变",
                    candidates.len()
                ),
                choices,
            ));
        }
        candidates.pop().ok_or_else(|| {
            failure(incomplete.into_iter().next().unwrap_or_else(|| {
                "准备命令结束，但没有找到对应family/quant的有效模型配置；请查看任务日志".into()
            }))
        })?
    };
    let (path, value) = selected;
    if !compatible(&value, intent) {
        return Err((
            "needs-choice",
            None,
            "输出配置的上下文或图片能力与本次选择不同；请核对配置，未自动登记".into(),
            Vec::new(),
        ));
    }
    asset_check(&value, &root).map_err(failure)?;
    let candidate = LocalCandidate {
        id: String::new(),
        name: expected,
        install_dir: root.to_string_lossy().into(),
        python_path: String::new(),
        config_path: path.to_string_lossy().into(),
        model_path: String::new(),
        model_bytes: None,
        model_group_key: None,
        config_modified_at: None,
        config: None,
        detected_port: None,
        running: None,
        reason: None,
        runtime_version: None,
        release_version: None,
        source: None,
        availability: None,
        pid: None,
    };
    let prepared =
        crate::discovery::prepare_import(&candidate, &state.data_dir, None).map_err(failure)?;
    // An existing original-to-managed mapping wins even though discover_local
    // intentionally omits registered configurations. Never replace its snapshot.
    let original = state
        .original_profiles()
        .map_err(failure)?
        .into_iter()
        .find(|original| {
            dunce::canonicalize(&original.config_path).ok() == Some(path.clone())
                && dunce::canonicalize(&original.install_dir).ok() == Some(root.clone())
        });
    let registered = original
        .map(|original| state.registered_profile(&original.id))
        .transpose()
        .map_err(failure)?;
    let profile = registered.as_ref().unwrap_or(&prepared.profile);
    let existing = checked_config(Path::new(&profile.config_path)).map_err(failure)?;
    if !compatible(&existing, intent)
        || model_references(&existing, &root).map_err(failure)?
            != model_references(&value, &root).map_err(failure)?
    {
        return Err(("needs-choice",registered.as_ref().map(|profile|profile.id.clone()),"已有受管快照的型号、权重路径、上下文或图片能力不同，保留其配置。可使用已有模型，或在参数页面明确修改后重试".into(),Vec::new()));
    }
    asset_check(&existing, &root).map_err(failure)?;
    if let Some(profile) = registered {
        return Ok(profile.id);
    }
    state
        .register_import(prepared, None)
        .map(|profile| profile.id)
        .map_err(failure)
}

/// A UI restart does not affect registration. A supervisor crash after command
/// success resumes this idempotent step; interrupted downloads remain failed.
pub fn recover(state: &RuntimeState) -> Result<(), String> {
    {
        let database = state.database.lock().map_err(|e| e.to_string())?;
        database.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    }
    for entry in list(state)? {
        if entry.status != "pending" {
            continue;
        }
        let (_, succeeded, _) = read_entry(state, &entry.task_id)?;
        if succeeded {
            resolve(state, &entry.task_id, None)?;
        } else {
            let status = state
                .tasks
                .lock()
                .map_err(|e| e.to_string())?
                .get(&entry.task_id)
                .map(|task| task.status.clone());
            if let Some(status) = status.filter(|status| status.state != "running") {
                let value = result(
                    &entry.task_id,
                    if status.state == "cancelled" {
                        "cancelled"
                    } else {
                        "failed"
                    },
                    Some(status.message),
                );
                write_result(&*state.database.lock().map_err(|e| e.to_string())?, &value)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::processes::Step;
    use serde_json::json;
    use std::time::{Duration, Instant};

    struct Fixture {
        _temp: tempfile::TempDir,
        state: Arc<RuntimeState>,
        intent: SetupIntent,
    }
    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runtime");
        for directory in ["serve", "engine", "tokenizer", "configs"] {
            fs::create_dir_all(root.join(directory)).unwrap();
        }
        fs::write(
            root.join("serve/server.py"),
            b"# Never run this server fixture",
        )
        .unwrap();
        fs::write(
            root.join("engine/strata.exe"),
            b"Never execute this fixture engine",
        )
        .unwrap();
        fs::write(root.join("tokenizer/vocab.json"), b"{}").unwrap();
        fs::write(root.join("tokenizer/merges.txt"), b"").unwrap();
        fs::write(root.join("tokenizer/token_type.json"), b"[]").unwrap();
        fs::write(root.join("part-1.gguf"), b"fixture model bytes, never load").unwrap();
        fs::write(
            root.join("part-2.gguf"),
            b"fixture second shard, never load",
        )
        .unwrap();
        fs::write(
            root.join("setup.py"),
            br#"import json,pathlib,sys,time
root=pathlib.Path(__file__).parent
spec=json.loads((root/'fixture-spec.json').read_text())
for name,config in spec.get('configs',[]):
    (root/name).write_text(json.dumps(config),encoding='utf-8')
print('fixture files prepared',flush=True)
time.sleep(spec.get('delay',0))
sys.exit(spec.get('exit',0))
"#,
        )
        .unwrap();
        #[cfg(windows)]
        let programs = ["py", "python"];
        #[cfg(not(windows))]
        let programs = ["python3", "python"];
        let python = programs
            .into_iter()
            .find_map(|program| {
                crate::output(
                    program,
                    &["-I", "-S", "-c", "import sys;print(sys.executable)"],
                )
            })
            .expect("Python3 required for CPU-only setup fixture");
        let state = RuntimeState::open(temp.path().join("manager-data")).unwrap();
        let profile = ServiceProfile {
            id: "setup-fixture".into(),
            name: "Strata".into(),
            base_url: "http://127.0.0.1:19883".into(),
            install_dir: root.to_string_lossy().into(),
            config_path: String::new(),
            python_path: python,
            managed: true,
        };
        Fixture {
            _temp: temp,
            state,
            intent: SetupIntent {
                profile,
                family: "qwen".into(),
                quant: "IQ2_XS".into(),
                context: 8192,
                images: false,
            },
        }
    }
    fn config(context: u32) -> Value {
        json!({"exe":"engine/strata.exe","cwd":".","tokenizer":"tokenizer","model_name":"qwen3.8-flash-next-iq2_xs","port":19883,"args":["--native","part-1.gguf","--ple-gguf","part-2.gguf","--max-context",context.to_string()],"sampling":{"temperature":0.6}})
    }
    fn spec(fixture: &Fixture, configs: Vec<(&str, Value)>, delay: f32, exit: i32) {
        fs::write(
            Path::new(&fixture.intent.profile.install_dir).join("fixture-spec.json"),
            serde_json::to_vec(&json!({"configs":configs,"delay":delay,"exit":exit})).unwrap(),
        )
        .unwrap();
    }
    fn launch(fixture: &Fixture) -> TaskStatus {
        let step = Step {
            program: fixture.intent.profile.python_path.clone(),
            args: vec!["-u".into(), "setup.py".into()],
            cwd: fixture.intent.profile.install_dir.clone().into(),
            env: Default::default(),
        };
        crate::processes::launch_setup_task(
            fixture.state.clone(),
            fixture.intent.clone(),
            vec![step],
        )
        .unwrap()
    }
    fn wait(state: &RuntimeState, id: &str) -> TaskStatus {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let status = state.tasks.lock().unwrap()[id].status.clone();
            if status.state != "running" {
                return status;
            }
            assert!(Instant::now() < deadline, "setup fixture never finished");
            std::thread::sleep(Duration::from_millis(30));
        }
    }
    fn handoff(state: &RuntimeState, id: &str) -> HandoffResult {
        list(state)
            .unwrap()
            .into_iter()
            .find(|entry| entry.task_id == id)
            .unwrap()
    }
    fn saved_record(fixture: &Fixture, id: &str, state: &str) -> SetupHook {
        let hook = SetupHook {
            state: fixture.state.clone(),
            intent: fixture.intent.clone(),
        };
        let record = TaskRecord {
            status: TaskStatus {
                id: id.into(),
                kind: "setup".into(),
                state: state.into(),
                message: "fixture saved task".into(),
                started_at: now(),
                finished_at: None,
            },
            profile_id: Some(fixture.intent.profile.id.clone()),
            runtime_path: Some(PathBuf::from(&fixture.intent.profile.install_dir)),
            cancelled: false,
            process: None,
        };
        persist_launch(&hook, &record).unwrap();
        fixture
            .state
            .tasks
            .lock()
            .unwrap()
            .insert(id.into(), record);
        hook
    }

    #[test]
    fn automatically_registers_without_switching_and_is_repeatable() {
        let fixture = fixture();
        crate::store_set(
            &fixture.state,
            "activeLocalInstallation".into(),
            json!("existing-user-model"),
        )
        .unwrap();
        crate::store_set(&fixture.state, "localServiceDesired".into(), json!(false)).unwrap();
        spec(&fixture, vec![("strata-iq2_xs.json", config(8192))], 0.2, 0);
        let task = launch(&fixture);
        assert_eq!(
            read_entry(&fixture.state, &task.id).unwrap().0.context,
            8192
        );
        assert_eq!(wait(&fixture.state, &task.id).state, "completed");
        let first = handoff(&fixture.state, &task.id);
        assert_eq!(first.status, "registered", "{first:?}");
        let source = Path::new(&fixture.intent.profile.install_dir).join("strata-iq2_xs.json");
        let source_bytes = fs::read(&source).unwrap();
        let asset = Path::new(&fixture.intent.profile.install_dir).join("part-1.gguf");
        let asset_bytes = fs::read(&asset).unwrap();
        assert_eq!(
            resolve(&fixture.state, &task.id, None).unwrap().profile_id,
            first.profile_id
        );
        let profile = fixture.state.registered_profiles().unwrap().pop().unwrap();
        let mut snapshot = checked_config(Path::new(&profile.config_path)).unwrap();
        snapshot["sampling"]["temperature"] = json!(0.2);
        fs::write(&profile.config_path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
        let private_bytes = fs::read(&profile.config_path).unwrap();
        let second = launch(&fixture);
        assert_eq!(wait(&fixture.state, &second.id).state, "completed");
        assert_eq!(
            handoff(&fixture.state, &second.id).profile_id,
            first.profile_id
        );
        assert_eq!(fixture.state.registered_profiles().unwrap().len(), 1);
        assert_eq!(fs::read(&profile.config_path).unwrap(), private_bytes);
        assert_eq!(fs::read(&source).unwrap(), source_bytes);
        assert_eq!(fs::read(&asset).unwrap(), asset_bytes);
        assert!(fixture.state.processes.lock().unwrap().is_empty());
        assert_eq!(
            crate::store_get(&fixture.state, "activeLocalInstallation".into()).unwrap(),
            json!("existing-user-model")
        );
        assert_eq!(
            crate::store_get(&fixture.state, "localServiceDesired".into()).unwrap(),
            json!(false)
        );
    }

    #[test]
    fn orca_import_registers_only_the_orcarouter_config() {
        let mut fixture = fixture();
        fixture.intent.family = "orca".into();
        fixture.intent.quant = "IQ3_XXS".into();
        fixture.intent.context = 32768;
        let mut orca = config(32768);
        orca["model_name"] = json!("orcarouter-qwen3.8-flash-next-uncensored-iq3_xxs");
        let mut official = config(32768);
        official["model_name"] = json!("qwen3.8-flash-next-iq3_xxs");
        spec(
            &fixture,
            vec![
                ("strata-iq3_xxs.json", official),
                ("strata-orca-iq3_xxs.json", orca),
            ],
            0.0,
            0,
        );
        let task = launch(&fixture);
        assert_eq!(wait(&fixture.state, &task.id).state, "completed");
        let result = handoff(&fixture.state, &task.id);
        assert_eq!(result.status, "registered", "{result:?}");
        let profiles = fixture.state.registered_profiles().unwrap();
        assert_eq!(profiles.len(), 1);
        let registered = checked_config(Path::new(&profiles[0].config_path)).unwrap();
        assert_eq!(
            registered["model_name"],
            "orcarouter-qwen3.8-flash-next-uncensored-iq3_xxs"
        );
    }

    #[test]
    fn deepseek41_registers_the_config_of_the_chosen_set_only() {
        let mut fixture = fixture();
        fixture.intent.family = "deepseek41".into();
        fixture.intent.quant = "IST-DAS-2.00bpw".into();
        let mut chosen = config(8192);
        chosen["model_name"] = json!("deepseek-v4.1-flash");
        chosen["arch"] = json!("deepseek41");
        let mut other = chosen.clone();
        other["args"][1] = json!("part-2.gguf");
        spec(
            &fixture,
            vec![
                ("strata-deepseek-v4.1-flash-ist-das-1.75bpw.json", other),
                ("strata-deepseek-v4.1-flash-ist-das-2.00bpw.json", chosen),
            ],
            0.0,
            0,
        );
        let task = launch(&fixture);
        assert_eq!(wait(&fixture.state, &task.id).state, "completed");
        let result = handoff(&fixture.state, &task.id);
        assert_eq!(result.status, "registered", "{result:?}");
        let profiles = fixture.state.registered_profiles().unwrap();
        assert_eq!(profiles.len(), 1);
        let registered = checked_config(Path::new(&profiles[0].config_path)).unwrap();
        assert_eq!(registered["args"][1], "part-1.gguf");
        assert_eq!(
            expected_config_file(&fixture.intent).as_deref(),
            Some("strata-deepseek-v4.1-flash-ist-das-2.00bpw.json")
        );
    }

    #[test]
    fn failed_intent_commit_rolls_back_task_and_never_spawns_setup() {
        let fixture = fixture();
        spec(&fixture, vec![("strata-iq2_xs.json", config(8192))], 0.0, 0);
        fixture.state.database.lock().unwrap().execute_batch("CREATE TRIGGER reject_fixture_intent BEFORE INSERT ON setup_handoffs BEGIN SELECT RAISE(ABORT,'fixture rejects intent'); END;").unwrap();
        let step = Step {
            program: fixture.intent.profile.python_path.clone(),
            args: vec!["-u".into(), "setup.py".into()],
            cwd: fixture.intent.profile.install_dir.clone().into(),
            env: Default::default(),
        };
        assert!(crate::processes::launch_setup_task(
            fixture.state.clone(),
            fixture.intent.clone(),
            vec![step]
        )
        .is_err());
        assert!(fixture.state.tasks.lock().unwrap().is_empty());
        let count: i64 = fixture
            .state
            .database
            .lock()
            .unwrap()
            .query_row("SELECT count(*) FROM tasks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        assert!(!Path::new(&fixture.intent.profile.install_dir)
            .join("strata-iq2_xs.json")
            .exists());
        assert!(fixture.state.registered_profiles().unwrap().is_empty());
    }

    #[test]
    fn cancelled_and_failed_setup_never_register_even_complete_leftovers() {
        for cancelled in [false, true] {
            let fixture = fixture();
            let path = Path::new(&fixture.intent.profile.install_dir).join("strata-iq2_xs.json");
            fs::write(&path, serde_json::to_vec(&config(8192)).unwrap()).unwrap();
            spec(
                &fixture,
                vec![],
                if cancelled { 2.0 } else { 0.0 },
                if cancelled { 0 } else { 7 },
            );
            let task = launch(&fixture);
            if cancelled {
                crate::cancel_task(&fixture.state, task.id.clone()).unwrap();
            }
            assert_eq!(
                wait(&fixture.state, &task.id).state,
                if cancelled { "cancelled" } else { "failed" }
            );
            assert_eq!(
                handoff(&fixture.state, &task.id).status,
                if cancelled { "cancelled" } else { "failed" }
            );
            assert!(fixture.state.registered_profiles().unwrap().is_empty());
            assert!(resolve(&fixture.state, &task.id, None).is_err() || cancelled);
        }
    }

    #[test]
    fn complete_command_marker_recovers_after_supervisor_reopen() {
        let fixture = fixture();
        let path = Path::new(&fixture.intent.profile.install_dir).join("strata-iq2_xs.json");
        fs::write(&path, serde_json::to_vec(&config(8192)).unwrap()).unwrap();
        let hook = saved_record(&fixture, "crash-between-command-and-import", "completed");
        fixture
            .state
            .database
            .lock()
            .unwrap()
            .execute(
                "UPDATE setup_handoffs SET commands_succeeded=1 WHERE task_id=?1",
                ["crash-between-command-and-import"],
            )
            .unwrap();
        let data_dir = fixture.state.data_dir.clone();
        drop(hook);
        let reopened = RuntimeState::open(data_dir.clone()).unwrap();
        let recovered = handoff(&reopened, "crash-between-command-and-import");
        assert_eq!(recovered.status, "registered", "{recovered:?}");
        assert_eq!(reopened.registered_profiles().unwrap().len(), 1);
        drop(reopened);
        let twice = RuntimeState::open(data_dir).unwrap();
        assert_eq!(
            handoff(&twice, "crash-between-command-and-import").profile_id,
            recovered.profile_id
        );
        assert_eq!(twice.registered_profiles().unwrap().len(), 1);
        assert!(twice.processes.lock().unwrap().is_empty());
    }

    #[test]
    fn interrupted_uncommitted_command_is_not_adopted_on_reopen() {
        let fixture = fixture();
        fs::write(
            Path::new(&fixture.intent.profile.install_dir).join("strata-iq2_xs.json"),
            serde_json::to_vec(&config(8192)).unwrap(),
        )
        .unwrap();
        let hook = saved_record(&fixture, "interrupted-before-command-success", "running");
        drop(hook);
        let reopened = RuntimeState::open(fixture.state.data_dir.clone()).unwrap();
        assert_eq!(
            handoff(&reopened, "interrupted-before-command-success").status,
            "failed"
        );
        assert!(reopened.registered_profiles().unwrap().is_empty());
    }

    #[test]
    fn ambiguous_configs_require_choice_and_external_configs_cannot_be_selected() {
        let fixture = fixture();
        spec(
            &fixture,
            vec![
                ("strata-iq2_xs.json", config(8192)),
                ("configs/another.json", config(8192)),
            ],
            0.0,
            0,
        );
        let task = launch(&fixture);
        assert_eq!(wait(&fixture.state, &task.id).state, "completed");
        let ambiguous = handoff(&fixture.state, &task.id);
        assert_eq!(ambiguous.status, "needs-choice");
        assert_eq!(ambiguous.choices.len(), 2);
        assert!(fixture.state.registered_profiles().unwrap().is_empty());
        let outside = fixture._temp.path().join("outside.json");
        fs::write(&outside, serde_json::to_vec(&config(8192)).unwrap()).unwrap();
        assert_eq!(
            resolve(&fixture.state, &task.id, Some(&outside.to_string_lossy()))
                .unwrap()
                .status,
            "failed"
        );
        let selected = resolve(
            &fixture.state,
            &task.id,
            Some(&ambiguous.choices[0].config_path),
        )
        .unwrap();
        assert_eq!(selected.status, "registered", "{selected:?}");
        assert_eq!(fixture.state.registered_profiles().unwrap().len(), 1);
    }

    #[test]
    fn missing_or_empty_model_assets_do_not_become_usable_models() {
        for empty in [false, true] {
            let fixture = fixture();
            let part = Path::new(&fixture.intent.profile.install_dir).join("part-2.gguf");
            if empty {
                fs::write(&part, b"").unwrap();
            } else {
                fs::remove_file(&part).unwrap();
            }
            spec(&fixture, vec![("strata-iq2_xs.json", config(8192))], 0.0, 0);
            let task = launch(&fixture);
            assert_eq!(wait(&fixture.state, &task.id).state, "completed");
            assert_eq!(handoff(&fixture.state, &task.id).status, "failed");
            assert!(fixture.state.registered_profiles().unwrap().is_empty());
        }
    }

    #[test]
    fn changed_setup_context_never_overwrites_registered_snapshot() {
        let mut fixture = fixture();
        spec(&fixture, vec![("strata-iq2_xs.json", config(8192))], 0.0, 0);
        let first = launch(&fixture);
        assert_eq!(wait(&fixture.state, &first.id).state, "completed");
        let original = fixture.state.registered_profiles().unwrap().pop().unwrap();
        let saved = fs::read(&original.config_path).unwrap();
        fixture.intent.context = 16384;
        spec(
            &fixture,
            vec![("strata-iq2_xs.json", config(16384))],
            0.0,
            0,
        );
        let second = launch(&fixture);
        assert_eq!(wait(&fixture.state, &second.id).state, "completed");
        let conflict = handoff(&fixture.state, &second.id);
        assert_eq!(conflict.status, "needs-choice");
        assert_eq!(conflict.profile_id.as_deref(), Some(original.id.as_str()));
        assert_eq!(fs::read(&original.config_path).unwrap(), saved);
        assert_eq!(fixture.state.registered_profiles().unwrap().len(), 1);
    }

    #[test]
    fn retained_snapshot_after_removing_registration_is_not_reapplied_with_wrong_context() {
        let mut fixture = fixture();
        spec(&fixture, vec![("strata-iq2_xs.json", config(8192))], 0.0, 0);
        let first = launch(&fixture);
        let first_status = wait(&fixture.state, &first.id);
        let first_handoff = handoff(&fixture.state, &first.id);
        let profile = fixture
            .state
            .registered_profiles()
            .unwrap()
            .pop()
            .unwrap_or_else(|| {
                panic!(
                    "first preparation did not register: task state={}, message={}; handoff={first_handoff:?}",
                    first_status.state, first_status.message,
                )
            });
        let saved = fs::read(&profile.config_path).unwrap();
        fixture.state.remove_local_installation(profile.id).unwrap();
        fixture.intent.context = 16384;
        spec(
            &fixture,
            vec![("strata-iq2_xs.json", config(16384))],
            0.0,
            0,
        );
        let second = launch(&fixture);
        wait(&fixture.state, &second.id);
        assert_eq!(handoff(&fixture.state, &second.id).status, "needs-choice");
        assert!(fixture.state.registered_profiles().unwrap().is_empty());
        assert_eq!(fs::read(&profile.config_path).unwrap(), saved);
    }

    #[tokio::test]
    async fn run_setup_rpc_uses_durable_handoff_contract() {
        let fixture = fixture();
        // This CPU-only handoff test reuses fixture assets. A fresh 68 GB
        // download/pack estimate must not be charged to a small CI filesystem.
        // Production disk checks remain active; these files are never loaded.
        let root = Path::new(&fixture.intent.profile.install_dir);
        let models = root.join("models/IQ2_XS");
        let pack = root.join("packs/iq2_xs");
        let mtp = root.join("mtp/rt");
        for directory in [&models, &pack, &mtp] {
            fs::create_dir_all(directory).unwrap();
        }
        for shard in [
            "Qwen3.8-Flash-Next-GSQ-RCO-IQ2_XS-00001-of-00002.gguf",
            "Qwen3.8-Flash-Next-GSQ-RCO-IQ2_XS-00002-of-00002.gguf",
        ] {
            fs::write(models.join(shard), b"CPU-only fixture, never load").unwrap();
        }
        fs::write(pack.join("experts.bin"), b"CPU-only fixture").unwrap();
        fs::write(pack.join("index.txt"), b"CPU-only fixture").unwrap();
        fs::write(mtp.join("experts.bin"), b"CPU-only fixture").unwrap();
        spec(&fixture, vec![("strata-iq2_xs.json", config(8192))], 0.0, 0);
        let task:TaskStatus=serde_json::from_value(fixture.state.clone().dispatch("run_setup",json!({"profile":fixture.intent.profile,"model":"qwen","quant":"IQ2_XS","context":8192,"images":false})).await.unwrap()).unwrap();
        let state = fixture.state.clone();
        let id = task.id.clone();
        let status = tokio::task::spawn_blocking(move || wait(&state, &id))
            .await
            .unwrap();
        assert_eq!(status.state, "completed", "{}", status.message);
        let returned = fixture
            .state
            .clone()
            .dispatch("list_setup_handoffs", json!({}))
            .await
            .unwrap();
        assert_eq!(returned[0]["status"], "registered", "{returned}");
        let resolved = fixture
            .state
            .clone()
            .dispatch("resolve_setup_handoff", json!({"taskId":task.id}))
            .await
            .unwrap();
        assert_eq!(resolved["profileId"], returned[0]["profileId"]);
        assert!(fixture.state.processes.lock().unwrap().is_empty());
    }
}
