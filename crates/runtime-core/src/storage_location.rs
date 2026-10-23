//! Where engines and model files live, and moving the model data folder to another drive
//! (user feedback: "the engine and models can only go on C:").
//!
//! - Model files (GGUF / packs / MTP, 70–120 GB) follow upstream Strata's remembered data
//!   folder: `data_dir` in its per-user `settings.json`, which `setup.py --data-dir` and
//!   Manager's disk preflight both read. Changing it is the same as upstream's
//!   `--set-default-data-dir`; moving copies, verifies, repoints run configurations, then
//!   deletes the old copies. Any failure before the switch leaves the old files and setting.
//! - Engines installed by Manager go to `<chosen folder>/runtimes/…` once a folder is chosen;
//!   existing engines stay where they are (profiles, journals and venvs record their paths).
use crate::{
    byte_size, disk,
    processes::{self, TaskRecord},
    types::{now, ServiceProfile, TaskStatus},
    RuntimeState,
};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};

pub const ENGINE_ROOT_KEY: &str = "engineInstallRoot";
pub const MOVE_TASK_KIND: &str = "move-model-data";
const DATA_ITEMS: [&str; 3] = ["models", "packs", "mtp"];
const MAX_WALK: usize = 200_000;
/// Windows paths below the engine root are long already (#62); keep the chosen folder short.
const MAX_ROOT_CHARS: usize = 120;
const BUFFER: usize = 4 * 1024 * 1024;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub path: String,
    /// `remembered` (upstream settings.json), `default`, or `custom` (chosen in Manager).
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mount_point: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageLocations {
    /// Where new model downloads go (and where existing ones are, unless kept elsewhere).
    pub model: Location,
    /// Where Manager installs new engines.
    pub engine: Location,
    /// The engine currently selected in the UI, when one was named.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_engine: Option<Location>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moving_task_id: Option<String>,
    /// Free space where a folder the user is choosing would go (nothing is created).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probe: Option<Location>,
}

fn measure(path: &Path, source: &str, used: bool) -> Location {
    let mut location = Location {
        path: path.to_string_lossy().into_owned(),
        source: source.into(),
        ..Location::default()
    };
    match disk::read_space(path) {
        Ok((mount, available)) => {
            location.available_bytes = Some(available);
            location.mount_point = Some(mount.to_string_lossy().into_owned());
        }
        Err(error) => location.error = Some(error),
    }
    if used {
        location.used_bytes = Some(
            DATA_ITEMS
                .iter()
                .map(|item| tree_size(&path.join(item)))
                .sum(),
        );
    }
    location
}

/// Bytes of regular files below `root`; links are not followed. Bounded walk.
pub(crate) fn tree_size(root: &Path) -> u64 {
    let mut total = 0;
    let mut seen = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(path) = stack.pop() {
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        seen += 1;
        if seen > MAX_WALK {
            break;
        }
        if meta.is_file() {
            total += meta.len();
        } else if meta.is_dir() {
            if let Ok(entries) = fs::read_dir(&path) {
                stack.extend(entries.flatten().map(|entry| entry.path()));
            }
        }
    }
    total
}

/// The folder chosen for new engine installs, if any.
pub fn custom_engine_root(state: &RuntimeState) -> Result<Option<PathBuf>, String> {
    Ok(crate::store_get(state, ENGINE_ROOT_KEY.into())?
        .as_str()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute()))
}

/// The `runtimes` folder new engines are installed into, created when missing.
pub fn engine_runtimes_root(state: &RuntimeState) -> Result<PathBuf, String> {
    let Some(chosen) = custom_engine_root(state)? else {
        return crate::installation::owned_directory(state.data_dir(), &["runtimes"]);
    };
    let path = chosen.join("runtimes");
    fs::create_dir_all(&path).map_err(|e| {
        format!(
            "无法使用所选引擎安装位置 {}：{e} / Cannot use the chosen engine folder",
            chosen.display()
        )
    })?;
    reject_link(&path)?;
    let canonical = dunce::canonicalize(&path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&canonical, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    Ok(canonical)
}

/// The engine root for display: never creates folders.
fn engine_root_for_display(state: &RuntimeState) -> Result<(PathBuf, &'static str), String> {
    Ok(match custom_engine_root(state)? {
        Some(chosen) => (chosen, "custom"),
        None => (state.data_dir().join("runtimes"), "default"),
    })
}

/// The model data folder: upstream's remembered `data_dir`, else `Strata-data` beside the engine.
pub fn model_directory(
    state: &RuntimeState,
    install_dir: Option<&Path>,
) -> Result<(PathBuf, &'static str), String> {
    let settings = disk::settings()?;
    if let Some(directory) = settings.data_dir {
        if directory.is_absolute() {
            return Ok((directory, "remembered"));
        }
        if let Some(root) = install_dir {
            return Ok((root.join(directory), "remembered"));
        }
    }
    let parent = match install_dir {
        Some(root) => root.parent().unwrap_or(root).to_path_buf(),
        None => match custom_engine_root(state)? {
            Some(chosen) => chosen.join("runtimes"),
            None => state.data_dir().join("runtimes"),
        },
    };
    Ok((parent.join("Strata-data"), "default"))
}

pub fn locations(
    state: &RuntimeState,
    install_dir: Option<String>,
    probe: Option<String>,
) -> Result<StorageLocations, String> {
    let install = install_dir
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    let (model, model_source) = model_directory(state, install.as_deref())?;
    let (engine, engine_source) = engine_root_for_display(state)?;
    let current_engine = install.as_ref().map(|root| {
        let mut location = measure(root, "current", false);
        location.used_bytes = Some(tree_size(root));
        location
    });
    Ok(StorageLocations {
        model: measure(&model, model_source, true),
        engine: measure(&engine, engine_source, false),
        current_engine,
        moving_task_id: running_move(state)?,
        probe: probe
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .map(|path| measure(&path, "probe", false)),
    })
}

fn running_move(state: &RuntimeState) -> Result<Option<String>, String> {
    Ok(state
        .tasks
        .lock()
        .map_err(|e| e.to_string())?
        .values()
        .find(|task| task.status.kind == MOVE_TASK_KIND && task.status.state == "running")
        .map(|task| task.status.id.clone()))
}

fn reject_link(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let reparse = false;
    if meta.file_type().is_symlink() || reparse {
        return Err(
            "所选目录是符号链接或重定向目录，请直接选择实际目录 / Choose the real folder, not a link"
                .into(),
        );
    }
    if !meta.is_dir() {
        return Err("所选路径不是目录 / The chosen path is not a folder".into());
    }
    Ok(())
}

/// Absolute, short enough, a real folder (created when missing) and writable by this user.
/// A drive root gets `default_name` appended so files never land loose in `D:\`.
pub fn prepare_target(raw: &str, default_name: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("请选择目录 / Choose a folder".into());
    }
    let mut path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("请填写完整的绝对路径 / Use an absolute path".into());
    }
    if path.parent().is_none() {
        path = path.join(default_name);
    }
    if path.to_string_lossy().chars().count() > MAX_ROOT_CHARS {
        return Err(format!(
            "路径过长（超过 {MAX_ROOT_CHARS} 个字符），请选择更短的目录，例如 D:\\{default_name} / The path is too long; choose a shorter folder"
        ));
    }
    fs::create_dir_all(&path).map_err(|e| {
        format!(
            "无法创建目录 {}：{e} / Cannot create the folder",
            path.display()
        )
    })?;
    reject_link(&path)?;
    let canonical = dunce::canonicalize(&path).map_err(|e| e.to_string())?;
    let probe = canonical.join(format!(".strata-manager-write-{}", uuid::Uuid::new_v4()));
    let written = File::create(&probe)
        .and_then(|mut file| file.write_all(b"ok").and_then(|_| file.sync_all()));
    let _ = fs::remove_file(&probe);
    written.map_err(|e| {
        format!(
            "目录不可写：{}（{e}）。请换一个当前用户有写入权限的目录 / The folder is not writable",
            canonical.display()
        )
    })?;
    Ok(canonical)
}

pub fn set_engine_root(
    state: &RuntimeState,
    directory: Option<String>,
) -> Result<Location, String> {
    crate::runtime_upgrade::assert_available(state)?;
    match directory.filter(|value| !value.trim().is_empty()) {
        None => crate::store_set(state, ENGINE_ROOT_KEY.into(), Value::Null)?,
        Some(raw) => {
            let target = prepare_target(&raw, "Strata")?;
            if target == dunce::canonicalize(state.data_dir()).unwrap_or_default() {
                crate::store_set(state, ENGINE_ROOT_KEY.into(), Value::Null)?;
            } else {
                crate::store_set(
                    state,
                    ENGINE_ROOT_KEY.into(),
                    json!(target.to_string_lossy()),
                )?;
            }
        }
    }
    let (root, source) = engine_root_for_display(state)?;
    Ok(measure(&root, source, false))
}

/// Remember `directory` as upstream's data folder, keeping every other setting.
fn write_upstream_data_dir(directory: &Path) -> Result<(), String> {
    remember_data_dir(
        &disk::upstream_settings_path()?,
        disk::upstream_app_settings_path().as_deref(),
        directory,
    )
}

/// Write the choice with the time it was made (`data_dir_at`, seconds), so upstream's
/// "the newer choice wins" sync between the Terminal's settings.json and the app's
/// app-settings.json (Strata 0.2.2) keeps it instead of an older choice. The app's file is
/// only updated when it already exists, and best effort: the Terminal file is the contract.
fn remember_data_dir(
    settings: &Path,
    app_settings: Option<&Path>,
    directory: &Path,
) -> Result<(), String> {
    let at = now_seconds();
    write_data_dir_at(settings, directory, at)?;
    if let Some(app) = app_settings.filter(|path| path.is_file()) {
        if let Err(error) = write_data_dir_at(app, directory, at) {
            eprintln!("[storage] could not update {}: {error}", app.display());
        }
    }
    Ok(())
}

fn now_seconds() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn write_data_dir_at(path: &Path, directory: &Path, at: f64) -> Result<(), String> {
    let path = path.to_path_buf();
    let mut settings = match fs::read(&path) {
        Ok(bytes) if bytes.len() <= 1024 * 1024 => {
            serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null)
        }
        Ok(_) => {
            return Err("Strata settings.json 过大，未修改 / settings.json is too large".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Null,
        Err(error) => return Err(format!("无法读取 {}：{error}", path.display())),
    };
    if !settings.is_object() {
        settings = json!({});
    }
    settings["data_dir"] = json!(directory.to_string_lossy());
    settings["data_dir_at"] = json!(at);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temporary = path.with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4()));
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("无法写入 Strata settings.json：{e}"))?;
    fs::rename(&temporary, &path).map_err(|e| {
        let _ = fs::remove_file(&temporary);
        format!("无法写入 Strata settings.json：{e}")
    })
}

fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let text = text.trim_end_matches('/').to_owned();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

/// `child` is `parent` or below it.
fn within(child: &Path, parent: &Path) -> bool {
    let (child, parent) = (path_key(child), path_key(parent));
    child == parent || child.starts_with(&format!("{parent}/"))
}

/// Rewrite string values that point into `from` so they point into `to`. Returns whether anything changed.
pub fn repoint_value(value: &mut Value, from: &Path, to: &Path) -> bool {
    match value {
        Value::String(text) => {
            let candidate = Path::new(text.as_str());
            if !candidate.is_absolute() || !within(candidate, from) {
                return false;
            }
            let normalized = text.replace('\\', "/");
            let prefix = from
                .to_string_lossy()
                .replace('\\', "/")
                .trim_end_matches('/')
                .chars()
                .count();
            let rest: String = normalized.chars().skip(prefix).collect();
            let rest = rest.trim_start_matches('/');
            let mut next = to.to_path_buf();
            for part in rest.split('/').filter(|part| !part.is_empty()) {
                next.push(part);
            }
            *text = next.to_string_lossy().into_owned();
            true
        }
        // Every nested value is visited; `any` would stop at the first change.
        Value::Array(items) => {
            items
                .iter_mut()
                .map(|item| repoint_value(item, from, to))
                .filter(|changed| *changed)
                .count()
                > 0
        }
        Value::Object(map) => {
            map.values_mut()
                .map(|item| repoint_value(item, from, to))
                .filter(|changed| *changed)
                .count()
                > 0
        }
        _ => false,
    }
}

fn run_configs(state: &RuntimeState) -> Vec<PathBuf> {
    let mut folders: Vec<PathBuf> = Vec::new();
    let profiles: Vec<ServiceProfile> = state.registered_profiles().unwrap_or_default();
    for profile in profiles.iter().filter(|profile| profile.managed) {
        folders.push(PathBuf::from(&profile.install_dir));
        if let Some(parent) = Path::new(&profile.config_path).parent() {
            folders.push(parent.to_path_buf());
        }
    }
    if let Ok(settings) = disk::settings() {
        folders.extend(settings.installs);
    }
    let mut files: Vec<PathBuf> = Vec::new();
    for folder in folders.into_iter().filter(|folder| folder.is_absolute()) {
        let Ok(entries) = fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten().take(512) {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name.starts_with("strata-")
                && name.ends_with(".json")
                && !name.ends_with(".shared-settings.json")
                && entry.file_type().is_ok_and(|kind| kind.is_file())
                && !files.iter().any(|known| path_key(known) == path_key(&path))
            {
                files.push(path);
            }
        }
    }
    files
}

#[derive(Clone)]
struct MovePlan {
    source: PathBuf,
    target: PathBuf,
    files: Vec<(PathBuf, u64)>,
    total: u64,
    same_volume: bool,
    /// Upstream settings.json that remembers the data folder.
    settings_path: PathBuf,
    /// The upstream app's app-settings.json, updated too when it exists.
    app_settings_path: Option<PathBuf>,
    /// Run configurations whose model paths follow the files.
    configs: Vec<PathBuf>,
}

fn plan_move(source: &Path, target: &Path) -> Result<MovePlan, String> {
    let mut files = Vec::new();
    let mut stack: Vec<PathBuf> = DATA_ITEMS.iter().map(PathBuf::from).collect();
    while let Some(relative) = stack.pop() {
        let path = source.join(&relative);
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("无法读取 {}：{error}", path.display())),
        };
        if meta.file_type().is_symlink() {
            return Err(format!(
                "{} 是符号链接，无法安全移动；请手动处理后重试 / A link cannot be moved safely",
                path.display()
            ));
        }
        if meta.is_dir() {
            for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
                stack.push(relative.join(entry.map_err(|e| e.to_string())?.file_name()));
            }
        } else if meta.is_file() {
            if target.join(&relative).exists() {
                return Err(format!(
                    "新位置已有同名文件 {}；请选择空目录，或选择「仅新下载使用新位置」 / The new folder already has {}",
                    target.join(&relative).display(),
                    relative.display()
                ));
            }
            files.push((relative, meta.len()));
        }
        if files.len() > MAX_WALK {
            return Err("模型目录文件过多，无法安全移动 / Too many files to move".into());
        }
    }
    files.sort();
    let total = files.iter().map(|(_, size)| size).sum();
    let source_mount = disk::read_space(source).map(|(mount, _)| mount);
    let (target_mount, available) = disk::read_space(target)?;
    let same_volume = source_mount.as_ref().ok() == Some(&target_mount);
    if !same_volume && total > available.saturating_sub(1024 * 1024 * 1024) {
        return Err(format!(
            "新位置剩余空间不足：需要 {}，可用 {}；旧文件未改动 / Not enough free space on the new drive",
            byte_size::human_bytes(total),
            byte_size::human_bytes(available)
        ));
    }
    Ok(MovePlan {
        source: source.to_path_buf(),
        target: target.to_path_buf(),
        files,
        total,
        same_volume,
        settings_path: disk::upstream_settings_path()?,
        app_settings_path: disk::upstream_app_settings_path(),
        configs: Vec::new(),
    })
}

fn assert_idle(state: &RuntimeState) -> Result<(), String> {
    crate::runtime_upgrade::assert_available(state)?;
    crate::tuning::assert_no_active_tuning(state)?;
    if state
        .tasks
        .lock()
        .map_err(|e| e.to_string())?
        .values()
        .any(|task| task.status.state == "running")
    {
        return Err(
            "有任务正在进行，请等它完成后再移动模型 / Wait for running tasks to finish".into(),
        );
    }
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
    for process in processes.values_mut() {
        if process.refresh()?.running {
            return Err(
                "请先停止正在运行的模型服务，再移动模型文件 / Stop the running model service first"
                    .into(),
            );
        }
    }
    Ok(())
}

/// Blocks starts, setups and updates while the files move (they all check `runtime_upgrading`).
struct MoveGuard(Arc<RuntimeState>);
impl Drop for MoveGuard {
    fn drop(&mut self) {
        self.0.runtime_upgrading.store(false, Ordering::Release);
    }
}

pub fn set_model_directory(
    state: Arc<RuntimeState>,
    directory: String,
    install_dir: Option<String>,
    move_files: bool,
) -> Result<Value, String> {
    let install = install_dir
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    let (source, _) = model_directory(&state, install.as_deref())?;
    let target = prepare_target(&directory, "Strata-data")?;
    let source_key = dunce::canonicalize(&source).unwrap_or_else(|_| source.clone());
    if path_key(&source_key) == path_key(&target) {
        write_upstream_data_dir(&target)?;
        return Ok(json!({"changed": false, "path": target, "moving": false}));
    }
    if within(&target, &source_key) || within(&source_key, &target) {
        return Err("新位置不能是当前模型目录的上级或下级目录 / The new folder cannot contain, or sit inside, the current one".into());
    }
    let has_files = DATA_ITEMS
        .iter()
        .any(|item| tree_size(&source.join(item)) > 0);
    if !move_files || !has_files {
        crate::runtime_upgrade::assert_available(&state)?;
        write_upstream_data_dir(&target)?;
        return Ok(json!({"changed": true, "path": target, "moving": false}));
    }
    assert_idle(&state)?;
    let mut plan = plan_move(&source_key, &target)?;
    plan.configs = run_configs(&state);
    if state
        .runtime_upgrading
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(
            "Strata 运行时正在准备或切换，请稍后再移动 / Another runtime operation is running"
                .into(),
        );
    }
    let guard = MoveGuard(state.clone());
    let id = uuid::Uuid::new_v4().to_string();
    let task = TaskStatus {
        id: id.clone(),
        kind: MOVE_TASK_KIND.into(),
        state: "running".into(),
        message: format!(
            "正在准备移动模型文件（{}）/ Preparing to move model files",
            byte_size::human_bytes(plan.total)
        ),
        started_at: now(),
        finished_at: None,
    };
    {
        let mut tasks = state.tasks.lock().map_err(|e| e.to_string())?;
        processes::admit_task_logs(&mut tasks, &state.logs, &id)?;
        tasks.insert(
            id.clone(),
            TaskRecord {
                status: task.clone(),
                profile_id: None,
                runtime_path: None,
                cancelled: false,
                process: None,
            },
        );
        if let Err(error) =
            processes::persist_task(&state.database, tasks.get(&id).ok_or("任务不存在")?)
        {
            processes::abandon_unstarted_task(
                &state.database,
                &mut tasks,
                &state.logs,
                &id,
                &error,
            );
            return Err(error);
        }
    }
    let task_state = state.clone();
    let task_id = id.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let outcome = execute_move(&task_state, &task_id, &plan);
        finish(&task_state, &task_id, outcome);
    });
    Ok(json!({"changed": true, "path": target, "moving": true, "task": task}))
}

fn finish(state: &RuntimeState, id: &str, outcome: Result<String, String>) {
    let Ok(mut tasks) = state.tasks.lock() else {
        return;
    };
    let Some(record) = tasks.get_mut(id) else {
        return;
    };
    record.status.finished_at = Some(now());
    let (status, message) = match outcome {
        Ok(message) => ("completed", message),
        Err(error) if record.cancelled => ("cancelled", error),
        Err(error) => ("failed", error),
    };
    record.status.state = status.into();
    record.status.message = message.clone();
    processes::log(&state.logs, id, status, message);
    let _ = processes::persist_task(&state.database, record);
    let _ = processes::persist_task_logs(&state.database, &state.logs, id);
}

fn cancelled(state: &RuntimeState, id: &str) -> Result<(), String> {
    let tasks = state.tasks.lock().map_err(|e| e.to_string())?;
    if tasks.get(id).is_none_or(|record| record.cancelled) {
        return Err(
            "已取消移动；旧位置的模型文件和设置保持不变 / Move cancelled; nothing changed".into(),
        );
    }
    Ok(())
}

fn progress(state: &RuntimeState, id: &str, message: String) {
    processes::log(&state.logs, id, "info", &message);
    if let Ok(mut tasks) = state.tasks.lock() {
        if let Some(record) = tasks.get_mut(id) {
            record.status.message = message;
            let _ = processes::persist_task(&state.database, record);
        }
    }
}

struct Meter {
    started: Instant,
    last: Instant,
    done: u64,
}

impl Meter {
    fn tick(&mut self, state: &RuntimeState, id: &str, label: &str, total: u64, force: bool) {
        if !force && self.last.elapsed() < Duration::from_millis(800) {
            return;
        }
        self.last = Instant::now();
        let seconds = self.started.elapsed().as_secs_f64();
        let speed = (seconds > 0.5).then(|| self.done as f64 / seconds);
        progress(
            state,
            id,
            format!(
                "{label}：{}",
                byte_size::progress_amount(self.done, Some(total), speed)
            ),
        );
    }
}

/// Copy one file, hashing what was read; returns the SHA-256 of the source bytes.
fn copy_hashed(
    from: &Path,
    to: &Path,
    meter: &mut Meter,
    mut each: impl FnMut(&mut Meter) -> Result<(), String>,
) -> Result<[u8; 32], String> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut input = File::open(from).map_err(|e| format!("无法读取 {}：{e}", from.display()))?;
    let mut output = File::options()
        .write(true)
        .create_new(true)
        .open(to)
        .map_err(|e| format!("无法写入 {}：{e}", to.display()))?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; BUFFER];
    loop {
        let read = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
        output
            .write_all(&buffer[..read])
            .map_err(|e| format!("写入 {} 失败：{e}", to.display()))?;
        meter.done += read as u64;
        each(meter)?;
    }
    output.sync_all().map_err(|e| e.to_string())?;
    Ok(hash.finalize().into())
}

fn hash_file(
    path: &Path,
    meter: &mut Meter,
    mut each: impl FnMut(&mut Meter) -> Result<(), String>,
) -> Result<[u8; 32], String> {
    let mut input = File::open(path).map_err(|e| format!("无法读取 {}：{e}", path.display()))?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; BUFFER];
    loop {
        let read = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
        meter.done += read as u64;
        each(meter)?;
    }
    Ok(hash.finalize().into())
}

/// Remove now-empty folders below `root/item`, deepest first.
fn prune_empty(root: &Path) {
    for item in DATA_ITEMS {
        let mut folders = Vec::new();
        let mut stack = vec![root.join(item)];
        while let Some(path) = stack.pop() {
            if fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_dir()) {
                if let Ok(entries) = fs::read_dir(&path) {
                    stack.extend(entries.flatten().map(|entry| entry.path()));
                }
                folders.push(path);
            }
        }
        folders.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
        for folder in folders {
            let _ = fs::remove_dir(folder);
        }
    }
}

fn execute_move(state: &RuntimeState, id: &str, plan: &MovePlan) -> Result<String, String> {
    let placed = if plan.same_volume {
        rename_into_place(state, id, plan)?
    } else {
        copy_into_place(state, id, plan)?
    };
    // Point run configurations at the new copies, remembering the originals to restore.
    let mut originals: Vec<(PathBuf, Vec<u8>)> = Vec::new();
    let switched = (|| -> Result<usize, String> {
        cancelled(state, id)?;
        progress(
            state,
            id,
            "正在更新模型配置里的文件路径 / Updating paths in run configurations".into(),
        );
        for path in plan.configs.iter() {
            let bytes = fs::read(path).map_err(|e| format!("无法读取 {}：{e}", path.display()))?;
            let Ok(mut config) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            if !repoint_value(&mut config, &plan.source, &plan.target) {
                continue;
            }
            crate::storage::backup(path)?;
            originals.push((path.clone(), bytes));
            let temporary = path.with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4()));
            fs::write(
                &temporary,
                serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?,
            )
            .map_err(|e| format!("无法写入 {}：{e}", path.display()))?;
            fs::rename(&temporary, path).map_err(|e| {
                let _ = fs::remove_file(&temporary);
                format!("无法写入 {}：{e}", path.display())
            })?;
        }
        remember_data_dir(
            &plan.settings_path,
            plan.app_settings_path.as_deref(),
            &plan.target,
        )?;
        Ok(originals.len())
    })();
    let configs = match switched {
        Ok(count) => count,
        Err(error) => {
            for (path, bytes) in &originals {
                let _ = fs::write(path, bytes);
            }
            undo_placement(plan, &placed);
            return Err(format!(
                "{error}；已撤销，模型文件仍在原位置 {} / Undone; the files stay where they were",
                plan.source.display()
            ));
        }
    };
    let mut leftovers = 0;
    if !plan.same_volume {
        progress(
            state,
            id,
            "正在删除旧位置的副本 / Removing the old copies".into(),
        );
        for (relative, _) in &plan.files {
            if fs::remove_file(plan.source.join(relative)).is_err() {
                leftovers += 1;
            }
        }
    }
    prune_empty(&plan.source);
    let mut message = format!(
        "模型文件已移动到 {}（{}，{} 个配置已更新）/ Model files moved",
        plan.target.display(),
        byte_size::human_bytes(plan.total),
        configs
    );
    if leftovers > 0 {
        message.push_str(&format!(
            "；旧位置有 {leftovers} 个文件未能删除，可手动删除 {} / Some old copies could not be removed",
            plan.source.display()
        ));
    }
    Ok(message)
}

enum Placement {
    /// Whole items renamed on one volume: (from, to).
    Renamed(Vec<(PathBuf, PathBuf)>),
    /// Verified copies now at their final place below the target.
    Copied(Vec<PathBuf>),
}

fn undo_placement(plan: &MovePlan, placed: &Placement) {
    match placed {
        Placement::Renamed(moves) => {
            for (from, to) in moves.iter().rev() {
                let _ = fs::rename(to, from);
            }
        }
        Placement::Copied(files) => {
            for file in files {
                let _ = fs::remove_file(file);
            }
            prune_empty(&plan.target);
        }
    }
}

fn rename_into_place(state: &RuntimeState, id: &str, plan: &MovePlan) -> Result<Placement, String> {
    cancelled(state, id)?;
    progress(
        state,
        id,
        "同一磁盘，直接移动文件夹 / Same drive: moving folders in place".into(),
    );
    let mut moves: Vec<(PathBuf, PathBuf)> = Vec::new();
    let result = (|| -> Result<(), String> {
        for item in DATA_ITEMS {
            let from = plan.source.join(item);
            if !from.exists() {
                continue;
            }
            let to = plan.target.join(item);
            if to.exists() {
                // Merge file by file into an existing folder (conflicts were refused in the plan).
                for (relative, _) in plan.files.iter().filter(|(rel, _)| rel.starts_with(item)) {
                    let (from, to) = (plan.source.join(relative), plan.target.join(relative));
                    if let Some(parent) = to.parent() {
                        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    }
                    fs::rename(&from, &to)
                        .map_err(|e| format!("移动 {} 失败：{e}", from.display()))?;
                    moves.push((from, to));
                }
            } else {
                fs::rename(&from, &to).map_err(|e| format!("移动 {} 失败：{e}", from.display()))?;
                moves.push((from, to));
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        for (from, to) in moves.iter().rev() {
            let _ = fs::rename(to, from);
        }
        return Err(format!("{error}；已撤销，文件仍在原位置 / Undone"));
    }
    Ok(Placement::Renamed(moves))
}

fn copy_into_place(state: &RuntimeState, id: &str, plan: &MovePlan) -> Result<Placement, String> {
    // Copies land in a staging folder first, so an interruption never leaves half-written
    // files where setup or the engine would read them.
    for entry in fs::read_dir(&plan.target)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(".strata-move-")
        {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
    let staging = plan.target.join(format!(".strata-move-{id}"));
    let result = (|| -> Result<Vec<PathBuf>, String> {
        let mut digests = Vec::with_capacity(plan.files.len());
        let mut meter = Meter {
            started: Instant::now(),
            last: Instant::now(),
            done: 0,
        };
        let copy_label = "正在复制模型文件 / Copying model files";
        for (relative, size) in &plan.files {
            cancelled(state, id)?;
            let digest = copy_hashed(
                &plan.source.join(relative),
                &staging.join(relative),
                &mut meter,
                |meter| {
                    meter.tick(state, id, copy_label, plan.total, false);
                    cancelled(state, id)
                },
            )?;
            if fs::metadata(staging.join(relative))
                .map_err(|e| e.to_string())?
                .len()
                != *size
            {
                return Err(format!(
                    "{} 复制后大小不一致 / Size mismatch after copying",
                    relative.display()
                ));
            }
            digests.push(digest);
        }
        meter.tick(state, id, copy_label, plan.total, true);
        let mut check = Meter {
            started: Instant::now(),
            last: Instant::now(),
            done: 0,
        };
        let check_label = "正在逐字节核对新副本 / Verifying the new copies";
        for ((relative, _), expected) in plan.files.iter().zip(&digests) {
            cancelled(state, id)?;
            let actual = hash_file(&staging.join(relative), &mut check, |meter| {
                meter.tick(state, id, check_label, plan.total, false);
                cancelled(state, id)
            })?;
            if &actual != expected {
                return Err(format!(
                    "{} 新副本与原文件不一致（SHA-256），已停止 / The new copy does not match",
                    relative.display()
                ));
            }
        }
        check.tick(state, id, check_label, plan.total, true);
        let mut placed = Vec::with_capacity(plan.files.len());
        for (relative, _) in &plan.files {
            let to = plan.target.join(relative);
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            if let Err(error) = fs::rename(staging.join(relative), &to) {
                for file in &placed {
                    let _ = fs::remove_file(file);
                }
                return Err(format!("无法放入新位置 {}：{error}", to.display()));
            }
            placed.push(to);
        }
        Ok(placed)
    })();
    let _ = fs::remove_dir_all(&staging);
    match result {
        Ok(placed) => Ok(Placement::Copied(placed)),
        Err(error) => {
            prune_empty(&plan.target);
            Err(format!(
                "{error}；旧位置的模型文件和设置保持不变 / The old files and setting are unchanged"
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remembered_data_dir_is_stamped_and_never_creates_the_app_file() {
        let temp = tempfile::tempdir().unwrap();
        let settings = temp.path().join("strata").join("settings.json");
        let app = temp.path().join("share").join("app-settings.json");
        let target = temp.path().join("models");
        remember_data_dir(&settings, Some(&app), &target).unwrap();
        let written: Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
        assert_eq!(written["data_dir"], json!(target));
        assert!(written["data_dir_at"].as_f64().unwrap() > 1_700_000_000.0);
        // The upstream app has not been set up here: its file stays absent.
        assert!(!app.exists());
        // A stale stamp left by the Terminal is refreshed, never kept.
        fs::write(&settings, br#"{"data_dir":"old","data_dir_at":5}"#).unwrap();
        remember_data_dir(&settings, None, &target).unwrap();
        let written: Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
        assert!(written["data_dir_at"].as_f64().unwrap() > 5.0);
    }

    #[test]
    fn repoint_rewrites_only_paths_inside_the_old_folder() {
        let from = if cfg!(windows) {
            PathBuf::from("C:\\Data\\Strata-data")
        } else {
            PathBuf::from("/data/Strata-data")
        };
        let to = if cfg!(windows) {
            PathBuf::from("D:\\Strata-data")
        } else {
            PathBuf::from("/mnt/d/Strata-data")
        };
        let inside = from.join("models").join("qwen").join("a.gguf");
        let sibling = PathBuf::from(format!("{}-old", from.display())).join("x.gguf");
        let mut config = json!({
            "model": inside.to_string_lossy(),
            "args": ["--mtp", from.join("mtp").join("rt").to_string_lossy(), "--ctx", "8192"],
            "other": sibling.to_string_lossy(),
            "relative": "models/a.gguf",
            "n": 3
        });
        assert!(repoint_value(&mut config, &from, &to));
        assert_eq!(
            config["model"],
            json!(to
                .join("models")
                .join("qwen")
                .join("a.gguf")
                .to_string_lossy())
        );
        assert_eq!(
            config["args"][1],
            json!(to.join("mtp").join("rt").to_string_lossy())
        );
        assert_eq!(config["other"], json!(sibling.to_string_lossy()));
        assert_eq!(config["relative"], "models/a.gguf");
        let mut untouched = json!({"model": sibling.to_string_lossy()});
        assert!(!repoint_value(&mut untouched, &from, &to));
    }

    #[test]
    fn target_must_be_absolute_and_writable_and_drive_roots_get_a_folder() {
        assert!(prepare_target("relative/folder", "Strata-data").is_err());
        assert!(prepare_target("  ", "Strata-data").is_err());
        let temp = tempfile::tempdir().unwrap();
        let chosen = temp.path().join("models here");
        let prepared = prepare_target(&chosen.to_string_lossy(), "Strata-data").unwrap();
        assert!(prepared.is_dir());
        assert_eq!(
            fs::read_dir(&prepared).unwrap().count(),
            0,
            "the write probe is removed"
        );
        let long = temp.path().join("x".repeat(MAX_ROOT_CHARS));
        assert!(prepare_target(&long.to_string_lossy(), "Strata-data").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn links_are_refused() {
        let temp = tempfile::tempdir().unwrap();
        let real = temp.path().join("real");
        fs::create_dir(&real).unwrap();
        let link = temp.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(prepare_target(&link.to_string_lossy(), "Strata-data").is_err());
    }

    #[test]
    fn plan_refuses_conflicts_and_lists_only_data_items() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("old");
        let target = temp.path().join("new");
        fs::create_dir_all(source.join("models/qwen")).unwrap();
        fs::create_dir_all(source.join("mtp/rt")).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(source.join("models/qwen/a.gguf"), b"abc").unwrap();
        fs::write(source.join("mtp/rt/b.bin"), b"de").unwrap();
        fs::write(source.join("notes.txt"), b"keep").unwrap();
        let plan = plan_move(&source, &target).unwrap();
        assert_eq!(plan.total, 5);
        assert_eq!(plan.files.len(), 2);
        fs::create_dir_all(target.join("models/qwen")).unwrap();
        fs::write(target.join("models/qwen/a.gguf"), b"zzz").unwrap();
        assert!(plan_move(&source, &target).is_err());
    }

    #[test]
    fn copy_then_verify_places_files_and_undo_restores_nothing_lost() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("old");
        let target = temp.path().join("new");
        fs::create_dir_all(source.join("models/qwen")).unwrap();
        fs::create_dir_all(&target).unwrap();
        let data: Vec<u8> = (0..(BUFFER + 17)).map(|i| (i % 251) as u8).collect();
        fs::write(source.join("models/qwen/a.gguf"), &data).unwrap();
        let mut meter = Meter {
            started: Instant::now(),
            last: Instant::now(),
            done: 0,
        };
        let digest = copy_hashed(
            &source.join("models/qwen/a.gguf"),
            &target.join("models/qwen/a.gguf"),
            &mut meter,
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(meter.done, data.len() as u64);
        let mut check = Meter {
            started: Instant::now(),
            last: Instant::now(),
            done: 0,
        };
        assert_eq!(
            hash_file(&target.join("models/qwen/a.gguf"), &mut check, |_| Ok(())).unwrap(),
            digest
        );
        let plan = MovePlan {
            source: source.clone(),
            target: target.clone(),
            files: vec![],
            total: 0,
            same_volume: false,
            settings_path: temp.path().join("settings.json"),
            app_settings_path: None,
            configs: vec![],
        };
        undo_placement(
            &plan,
            &Placement::Copied(vec![target.join("models/qwen/a.gguf")]),
        );
        assert!(!target.join("models").exists());
        assert_eq!(fs::read(source.join("models/qwen/a.gguf")).unwrap(), data);
    }

    fn move_fixture(
        same_volume: bool,
    ) -> (tempfile::TempDir, Arc<RuntimeState>, MovePlan, Vec<u8>) {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("manager")).unwrap();
        let source = temp.path().join("C").join("Strata-data");
        let target = temp.path().join("D").join("Strata-data");
        let install = temp.path().join("C").join("Strata");
        fs::create_dir_all(source.join("models/qwen")).unwrap();
        fs::create_dir_all(source.join("mtp/rt")).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&install).unwrap();
        let shard: Vec<u8> = (0..(BUFFER * 2 + 5)).map(|i| (i % 253) as u8).collect();
        fs::write(source.join("models/qwen/a-00001-of-00002.gguf"), &shard).unwrap();
        fs::write(source.join("models/qwen/a-00002-of-00002.gguf"), b"tail").unwrap();
        fs::write(source.join("mtp/rt/experts.bin"), b"mtp").unwrap();
        let config = install.join("strata-qwen.json");
        fs::write(
            &config,
            serde_json::to_vec(&json!({
                "model": source.join("models/qwen/a-00001-of-00002.gguf"),
                "mtp": source.join("mtp/rt"),
                "port": 8080
            }))
            .unwrap(),
        )
        .unwrap();
        let settings_path = temp.path().join("config").join("settings.json");
        fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
        fs::write(
            &settings_path,
            br#"{"data_dir":"old","installs":["x"],"lang":"zh"}"#,
        )
        .unwrap();
        let mut plan = plan_move(&source, &target).unwrap();
        plan.same_volume = same_volume;
        plan.settings_path = settings_path;
        let app_settings = temp.path().join("app").join("app-settings.json");
        fs::create_dir_all(app_settings.parent().unwrap()).unwrap();
        fs::write(
            &app_settings,
            br#"{"data_dir":"old","data_dir_at":1,"theme":"dark"}"#,
        )
        .unwrap();
        plan.app_settings_path = Some(app_settings.clone());
        plan.configs = vec![config];
        let id = "move-test".to_owned();
        state.tasks.lock().unwrap().insert(
            id.clone(),
            TaskRecord {
                status: TaskStatus {
                    id,
                    kind: MOVE_TASK_KIND.into(),
                    state: "running".into(),
                    message: String::new(),
                    started_at: now(),
                    finished_at: None,
                },
                profile_id: None,
                runtime_path: None,
                cancelled: false,
                process: None,
            },
        );
        (temp, state, plan, shard)
    }

    #[test]
    fn moving_copies_verifies_repoints_and_removes_the_old_copies() {
        for same_volume in [false, true] {
            let (_temp, state, plan, shard) = move_fixture(same_volume);
            let message = execute_move(&state, "move-test", &plan).unwrap();
            assert!(message.contains("1 个配置已更新"), "{message}");
            assert_eq!(
                fs::read(plan.target.join("models/qwen/a-00001-of-00002.gguf")).unwrap(),
                shard
            );
            assert_eq!(
                fs::read(plan.target.join("mtp/rt/experts.bin")).unwrap(),
                b"mtp"
            );
            assert!(!plan.source.join("models").exists() && !plan.source.join("mtp").exists());
            let config: Value =
                serde_json::from_slice(&fs::read(&plan.configs[0]).unwrap()).unwrap();
            // Built per component so the expectation uses the platform separator.
            let model = plan
                .target
                .join("models")
                .join("qwen")
                .join("a-00001-of-00002.gguf");
            assert_eq!(config["model"], json!(model));
            assert_eq!(config["mtp"], json!(plan.target.join("mtp").join("rt")));
            assert_eq!(config["port"], 8080);
            let settings: Value =
                serde_json::from_slice(&fs::read(&plan.settings_path).unwrap()).unwrap();
            assert_eq!(settings["data_dir"], json!(plan.target));
            assert_eq!(settings["installs"], json!(["x"]));
            assert_eq!(settings["lang"], "zh");
            // Stamped, so upstream's newer-choice-wins sync keeps it (Strata 0.2.2).
            let at = settings["data_dir_at"].as_f64().unwrap();
            assert!(at > 1_700_000_000.0, "{at}");
            let app: Value = serde_json::from_slice(
                &fs::read(plan.app_settings_path.as_ref().unwrap()).unwrap(),
            )
            .unwrap();
            assert_eq!(app["data_dir"], json!(plan.target));
            assert_eq!(app["data_dir_at"], json!(at));
            assert_eq!(app["theme"], "dark");
            assert!(fs::read_dir(&plan.target)
                .unwrap()
                .flatten()
                .all(|e| !e.file_name().to_string_lossy().starts_with(".strata-move-")));
        }
    }

    #[test]
    fn a_failed_switch_leaves_the_old_files_configs_and_setting() {
        for same_volume in [false, true] {
            let (_temp, state, mut plan, shard) = move_fixture(same_volume);
            let config_before = fs::read(&plan.configs[0]).unwrap();
            let settings_before = fs::read(&plan.settings_path).unwrap();
            // settings.json cannot be written: its "parent" is a file.
            let blocker = plan.settings_path.with_file_name("blocker");
            fs::write(&blocker, b"").unwrap();
            plan.settings_path = blocker.join("settings.json");
            let error = execute_move(&state, "move-test", &plan).unwrap_err();
            assert!(error.contains("已撤销"), "{error}");
            assert_eq!(
                fs::read(plan.source.join("models/qwen/a-00001-of-00002.gguf")).unwrap(),
                shard
            );
            assert_eq!(fs::read(&plan.configs[0]).unwrap(), config_before);
            assert_eq!(
                fs::read(
                    plan.settings_path
                        .parent()
                        .unwrap()
                        .with_file_name("settings.json")
                )
                .unwrap(),
                settings_before
            );
            assert!(
                !plan.target.join("models").exists(),
                "no copies left behind"
            );
        }
    }

    #[test]
    fn cancelling_keeps_everything_in_place() {
        let (_temp, state, plan, shard) = move_fixture(false);
        state
            .tasks
            .lock()
            .unwrap()
            .get_mut("move-test")
            .unwrap()
            .cancelled = true;
        assert!(execute_move(&state, "move-test", &plan).is_err());
        assert_eq!(
            fs::read(plan.source.join("models/qwen/a-00001-of-00002.gguf")).unwrap(),
            shard
        );
        assert!(!plan.target.join("models").exists());
    }

    #[test]
    fn within_matches_whole_components() {
        assert!(within(Path::new("/a/b/c"), Path::new("/a/b")));
        assert!(within(Path::new("/a/b"), Path::new("/a/b/")));
        assert!(!within(Path::new("/a/bc"), Path::new("/a/b")));
    }
}
