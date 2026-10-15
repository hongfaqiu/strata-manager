//! Official tag source + SHA256-published engine ZIPs, merged transactionally.
//! No upstream updater scripts, model downloads, directory clears or external stops.
use super::{cancelled, RuntimeReleaseAsset, RuntimeUpdateInfo, SelectionFlag, UpgradeFlag};
use crate::{http, installation, maintenance, processes, storage, types::*, RuntimeState};
use futures_util::StreamExt;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS runtime_zip_updates(task_id TEXT PRIMARY KEY,journal TEXT NOT NULL,updated_at INTEGER NOT NULL);";
const MAX_SOURCE: u64 = 128 * 1024 * 1024;
const MAX_EXPANDED: u64 = 3 * 1024 * 1024 * 1024;
const RELEASE_MARKER: &str = ".strata-manager-release.json";
const OBSERVER_COMPAT: &str =
    include_str!("../../../../apps/supervisor/resources/observer_compat.json");

mod download_check;
mod download_source;
pub use download_check::{
    resolve_release_download_asset, test_release_download, RuntimeZipDownloadCheckResult,
};
pub use download_source::RuntimeZipDownloadOptions;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Change {
    relative: String,
    original_sha256: Option<String>,
    replacement_sha256: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Restart {
    profile: ServiceProfile,
    loaded: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Migration {
    old: ServiceProfile,
    new: ServiceProfile,
    config_sha256: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    task_id: String,
    install_dir: PathBuf,
    phase: String,
    new_install: bool,
    asset_name: Option<String>,
    #[serde(default)]
    requested_asset_name: Option<String>,
    #[serde(default)]
    requested_stop_current_service: bool,
    #[serde(default)]
    download: RuntimeZipDownloadOptions,
    version: Option<String>,
    revision: Option<String>,
    changes: Vec<Change>,
    running: Vec<Restart>,
    #[serde(default)]
    migrations: Vec<Migration>,
    error: Option<String>,
    updated_at: u64,
}
fn persist(state: &RuntimeState, j: &Journal) -> Result<(), String> {
    let db = state.database.lock().map_err(|e| e.to_string())?;
    persist_locked(&db, j)
}
fn persist_locked(db: &rusqlite::Connection, j: &Journal) -> Result<(), String> {
    db.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    db.execute("INSERT INTO runtime_zip_updates VALUES(?1,?2,?3) ON CONFLICT(task_id) DO UPDATE SET journal=excluded.journal,updated_at=excluded.updated_at",params![j.task_id,serde_json::to_string(j).map_err(|e|e.to_string())?,j.updated_at as i64]).map_err(|e|e.to_string())?;
    Ok(())
}
fn progress(
    state: &RuntimeState,
    j: &mut Journal,
    phase: &str,
    message: &str,
) -> Result<(), String> {
    j.phase = phase.into();
    j.updated_at = now();
    persist(state, j)?;
    let mut tasks = state.tasks.lock().map_err(|e| e.to_string())?;
    let task = tasks.get_mut(&j.task_id).ok_or("ZIP更新任务不存在")?;
    task.status.message = message.into();
    processes::persist_task(&state.database, task)?;
    processes::log(&state.logs, &j.task_id, "info", message);
    processes::persist_task_logs(&state.database, &state.logs, &j.task_id)
}

/// The installation result and successful update journal become visible together.
/// A crash before this transaction is committed restores all program files.
fn complete(
    state: &RuntimeState,
    j: &mut Journal,
    result: Option<Value>,
    message: &str,
) -> Result<(), String> {
    let previous = j.phase.clone();
    j.phase = "completed".into();
    j.updated_at = now();
    let commit = (|| {
        let mut db = state.database.lock().map_err(|e| e.to_string())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        if let Some(result) = result {
            tx.execute("INSERT INTO kv(key,value) VALUES('automaticRuntimeInstallation',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[serde_json::to_string(&result).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        }
        tx.execute(
            "UPDATE runtime_zip_updates SET journal=?1,updated_at=?2 WHERE task_id=?3",
            params![
                serde_json::to_string(j).map_err(|e| e.to_string())?,
                j.updated_at as i64,
                j.task_id
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    })();
    if let Err(error) = commit {
        j.phase = previous;
        return Err(error);
    }
    if let Ok(mut tasks) = state.tasks.lock() {
        if let Some(task) = tasks.get_mut(&j.task_id) {
            task.status.message = message.into();
            let _ = processes::persist_task(&state.database, task);
        }
    }
    processes::log(&state.logs, &j.task_id, "info", message);
    Ok(())
}
fn work_dir(state: &RuntimeState, id: &str) -> Result<PathBuf, String> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err("ZIP更新日志标识无效".into());
    }
    let root = installation::owned_directory(state.data_dir(), &["zip-updates"])?;
    let path = root.join(id);
    if path.exists() {
        reject_link(&path)?;
    } else {
        fs::create_dir(&path).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

pub fn start_release(
    state: Arc<RuntimeState>,
    install_dir: String,
    asset_name: Option<String>,
) -> Result<TaskStatus, String> {
    start_release_request(state, install_dir, asset_name, None, false)
}

pub fn start_release_request(
    state: Arc<RuntimeState>,
    install_dir: String,
    asset_name: Option<String>,
    request_id: Option<String>,
    stop_current_service: bool,
) -> Result<TaskStatus, String> {
    start_release_request_with_download(
        state,
        install_dir,
        asset_name,
        request_id,
        stop_current_service,
        RuntimeZipDownloadOptions::default(),
    )
}

pub fn start_release_request_with_download(
    state: Arc<RuntimeState>,
    install_dir: String,
    asset_name: Option<String>,
    request_id: Option<String>,
    stop_current_service: bool,
    download: RuntimeZipDownloadOptions,
) -> Result<TaskStatus, String> {
    let root = dunce::canonicalize(&install_dir).map_err(|_| "Strata安装目录不存在，未启动更新")?;
    if !root.join("setup.py").is_file() || !root.join("serve/server.py").is_file() {
        return Err("此目录没有完整Strata服务源码，请选择已检测到的运行环境".into());
    }
    start(
        state,
        root,
        asset_name,
        false,
        request_id,
        stop_current_service,
        download,
    )
}
pub fn start_install_release(state: Arc<RuntimeState>) -> Result<TaskStatus, String> {
    let root = installation::owned_directory(state.data_dir(), &["runtimes"])?
        .join(format!("release-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).map_err(|e| e.to_string())?;
    start(
        state,
        root,
        None,
        true,
        None,
        false,
        RuntimeZipDownloadOptions::default(),
    )
}
fn start(
    state: Arc<RuntimeState>,
    root: PathBuf,
    asset_name: Option<String>,
    new_install: bool,
    request_id: Option<String>,
    stop_current_service: bool,
    download: RuntimeZipDownloadOptions,
) -> Result<TaskStatus, String> {
    let download = download.validate(asset_name.as_deref())?;
    let task_id = request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    uuid::Uuid::parse_str(&task_id).map_err(|_| "更新请求标识必须为 UUID")?;
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Err("官方引擎ZIP自动安装目前支持Windows x64；可使用源码安装方式".into());
    }
    if asset_name.as_deref().is_some_and(|name| {
        !matches!(
            name,
            "strata-windows-x64.zip"
                | "strata-windows-x64-cuda12.zip"
                | "strata-windows-x64-hip.zip"
        )
    }) {
        return Err("不是支持的官方Strata ZIP资产".into());
    }
    let operation = state.runtime_operations.lock().map_err(|e| e.to_string())?;
    for profile in state.registered_profiles()? {
        if dunce::canonicalize(&profile.install_dir).ok() == dunce::canonicalize(&root).ok() {
            crate::external_management::assert_profile_manager_owned(&state, &profile)?;
        }
    }
    if let Some(existing) = state.tasks.lock().map_err(|e| e.to_string())?.get(&task_id) {
        let db = state.database.lock().map_err(|e| e.to_string())?;
        db.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        let saved: String = db
            .query_row(
                "SELECT journal FROM runtime_zip_updates WHERE task_id=?1",
                [&task_id],
                |row| row.get(0),
            )
            .map_err(|_| "更新请求标识已被另一项任务使用")?;
        let saved: Journal = serde_json::from_str(&saved).map_err(|e| e.to_string())?;
        if saved.install_dir != root
            || saved.new_install != new_install
            || saved.requested_asset_name != asset_name
            || saved.requested_stop_current_service != stop_current_service
            || saved.download != download
        {
            return Err("相同更新请求标识的目录或 ZIP 参数不一致，未重复执行".into());
        }
        return Ok(existing.status.clone());
    }
    download.validate_local_file()?;
    if !new_install && !stop_current_service {
        let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
        for process in processes.values_mut() {
            if process.refresh()?.running {
                return Err("当前模型服务正在运行，请确认停止服务后再更新".into());
            }
        }
        drop(processes);
        if crate::discovery::has_running_installation(&root)? {
            return Err(
                "此 Strata 仍有服务运行，请确认停止受管服务后再更新；外部服务不会自动停止".into(),
            );
        }
    }
    if state.shutting_down.load(Ordering::Acquire)
        || state.selection_changing.load(Ordering::Acquire)
    {
        return Err("正在退出或切换模型，请稍后重试".into());
    }
    crate::tuning::assert_no_active_tuning(&state)?;
    let db = state.database.lock().map_err(|e| e.to_string())?;
    db.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    let blocked:i64=db.query_row("SELECT COUNT(*) FROM runtime_zip_updates WHERE json_extract(journal,'$.phase')='rollbackFailed' AND json_extract(journal,'$.installDir')=?1",[root.to_string_lossy().as_ref()],|r|r.get(0)).map_err(|e|e.to_string())?;
    drop(db);
    if blocked > 0 {
        return Err("此目录上次更新尚未完整回滚，请查看任务日志并修复后重新打开应用".into());
    }
    let mut tasks = state.tasks.lock().map_err(|e| e.to_string())?;
    if tasks.values().any(|t| t.status.state == "running") {
        return Err("已有模型准备、安装或更新任务，请完成后重试".into());
    }
    state
        .runtime_upgrading
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "已有运行环境更新任务")?;
    let flag = UpgradeFlag(state.clone());
    let status = TaskStatus {
        id: task_id,
        kind: if new_install { "install" } else { "update" }.into(),
        state: "running".into(),
        message: "正在获取官方Release和同版本源码；保留模型及配置".into(),
        started_at: now(),
        finished_at: None,
    };
    let journal = Journal {
        task_id: status.id.clone(),
        install_dir: root.clone(),
        phase: "checking".into(),
        new_install,
        requested_asset_name: asset_name.clone(),
        requested_stop_current_service: stop_current_service,
        download,
        asset_name,
        version: None,
        revision: None,
        changes: vec![],
        running: vec![],
        migrations: vec![],
        error: None,
        updated_at: now(),
    };
    persist(&state, &journal)?;
    processes::admit_task_logs(&mut tasks, &state.logs, &status.id)?;
    tasks.insert(
        status.id.clone(),
        processes::TaskRecord {
            status: status.clone(),
            profile_id: None,
            runtime_path: Some(root),
            cancelled: false,
            process: None,
        },
    );
    if let Err(error) = processes::persist_task(
        &state.database,
        tasks.get(&status.id).ok_or("安装任务不存在")?,
    ) {
        processes::abandon_unstarted_task(
            &state.database,
            &mut tasks,
            &state.logs,
            &status.id,
            &error,
        );
        return Err(error);
    }
    if new_install {
        if let Err(error) = crate::store_set(
            &state,
            "automaticRuntimeInstallation".into(),
            json!({"taskId":status.id}),
        ) {
            processes::abandon_unstarted_task(
                &state.database,
                &mut tasks,
                &state.logs,
                &status.id,
                &error,
            );
            return Err(error);
        }
    }
    drop(tasks);
    drop(operation);
    tokio::spawn(async move {
        let _flag = flag;
        let mut j = journal;
        let result = execute(state.clone(), &mut j).await;
        if let Err(error) = &result {
            j.error = Some(error.clone());
            if !matches!(j.phase.as_str(), "rolledBack" | "rollbackFailed") {
                j.phase = if cancelled(&state, &j.task_id).is_err() {
                    "cancelled"
                } else {
                    "failed"
                }
                .into();
            }
            j.updated_at = now();
            let _ = persist(&state, &j);
        }
        if let Ok(mut tasks) = state.tasks.lock() {
            if let Some(task) = tasks.get_mut(&j.task_id) {
                task.process.take();
                task.status.finished_at = Some(now());
                task.status.state = if result.is_ok() {
                    "completed"
                } else if task.cancelled {
                    "cancelled"
                } else {
                    "failed"
                }
                .into();
                task.status.message = match result {
                    Ok(message) => message,
                    Err(error) => error,
                };
                processes::log(
                    &state.logs,
                    &j.task_id,
                    &task.status.state,
                    &task.status.message,
                );
                let _ = processes::persist_task(&state.database, task);
                let _ = processes::persist_task_logs(&state.database, &state.logs, &j.task_id);
            }
        }
    });
    Ok(status)
}

fn variant(root: &Path) -> Option<&'static str> {
    for directory in crate::discovery::known_engine_dir_names() {
        if let Some(value) = directory_variant(&root.join(directory)) {
            return Some(value);
        }
    }
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.take(32).flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.to_ascii_lowercase().starts_with("engine") {
                continue;
            }
            let path = entry.path();
            if path.is_dir() && !path.is_symlink() {
                if let Some(value) = directory_variant(&path) {
                    return Some(value);
                }
            }
        }
    }
    None
}

fn directory_variant(directory: &Path) -> Option<&'static str> {
    let build: Value =
        serde_json::from_slice(&fs::read(directory.join("BUILD.json")).ok()?).ok()?;
    if build["backend"]
        .as_str()
        .is_some_and(|s| s.eq_ignore_ascii_case("hip"))
    {
        return Some("hip");
    }
    if build["backend"]
        .as_str()
        .is_some_and(|backend| !backend.eq_ignore_ascii_case("cuda"))
    {
        return None;
    }
    let major = build["cuda"].as_u64().or_else(|| {
        let value = build["cuda"].as_str()?;
        if !value
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        {
            return None;
        }
        value.split('.').next()?.parse().ok()
    });
    match major {
        Some(12) => Some("cuda12"),
        Some(13) => Some("cuda13"),
        _ => None,
    }
}
fn choose_asset(
    info: &RuntimeUpdateInfo,
    root: &Path,
    requested: Option<&str>,
) -> Result<RuntimeReleaseAsset, String> {
    let previous = variant(root);
    let asset = if let Some(name) = requested {
        info.assets.iter().find(|a| a.name == name)
    } else {
        let wanted = previous.unwrap_or("cuda13");
        info.assets.iter().find(|a| a.variant == wanted)
    }
    .ok_or("此Release没有匹配当前运行环境的可校验官方ZIP")?;
    if previous.is_some_and(|v| v != asset.variant) {
        return Err(
            "所选ZIP与当前CUDA/HIP环境不匹配；请保留当前运行环境类型，避免破坏已有模型配置".into(),
        );
    }
    Ok(asset.clone())
}

fn version_parts(version: &str) -> Option<Vec<u32>> {
    version
        .trim_start_matches('v')
        .split('.')
        .map(|part| part.parse::<u32>().ok())
        .collect()
}

fn prevent_downgrade(root: &Path, version: &str) -> Result<(), String> {
    let release = version_parts(version).ok_or("Release版本无效")?;
    let mut checked = Vec::new();
    for name in crate::discovery::known_engine_dir_names() {
        checked.push(root.join(name).join("BUILD.json"));
    }
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.take(32).flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.to_ascii_lowercase().starts_with("engine") {
                continue;
            }
            let path = entry.path();
            if path.is_dir() && !path.is_symlink() {
                let build = path.join("BUILD.json");
                if !checked.iter().any(|existing| existing == &build) {
                    checked.push(build);
                }
            }
        }
    }
    for path in checked {
        if let Ok(bytes) = fs::read(&path) {
            if let Ok(build) = serde_json::from_slice::<Value>(&bytes) {
                if build["version"]
                    .as_str()
                    .and_then(version_parts)
                    .is_some_and(|installed| installed > release)
                {
                    return Err("当前本机引擎比最新正式Release更新，未降级或修改运行环境".into());
                }
            }
        }
    }
    Ok(())
}
async fn source_archive(
    state: &RuntimeState,
    id: &str,
    url: &str,
    revision: &str,
) -> Result<PathBuf, String> {
    if !super::valid_revision(revision)
        || url != format!("https://codeload.github.com/Niko1221/Strata/zip/{revision}")
    {
        return Err("官方源码URL或提交无效".into());
    }
    let directory = installation::owned_directory(state.data_dir(), &["downloads"])?;
    let mut output = tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(url)
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| format!("官方源码下载失败：{e}"))?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    if response.content_length().is_some_and(|n| n > MAX_SOURCE) {
        return Err("源码ZIP超过安全上限".into());
    }
    let mut stream = response.bytes_stream();
    let mut received = 0u64;
    let mut hash = Sha256::new();
    let mut at = Instant::now();
    loop {
        cancelled(state, id)?;
        tokio::select! {
            bytes=stream.next()=>{let Some(bytes)=bytes else{break};let bytes=bytes.map_err(|e|e.to_string())?;received=received.checked_add(bytes.len() as u64).ok_or("源码体积无效")?;if received>MAX_SOURCE{return Err("源码ZIP超过安全上限".into());}hash.update(&bytes);output.write_all(&bytes).map_err(|e|e.to_string())?;
                if at.elapsed()>Duration::from_secs(1){processes::log(&state.logs,id,"info",format!("官方同版本源码已下载 {received} 字节"));at=Instant::now();}}
            _=tokio::time::sleep(Duration::from_millis(100))=>{}
        }
    }
    cancelled(state, id)?;
    output.as_file().sync_all().map_err(|e| e.to_string())?;
    let digest = format!("{:x}", hash.finalize());
    let target = directory.join(format!("source-{revision}-{digest}.zip"));
    if target.exists() {
        if installation::file_hash(&target)? != digest {
            return Err("已有源码缓存被修改".into());
        }
        return Ok(target);
    }
    output
        .persist_noclobber(&target)
        .map_err(|e| e.to_string())?;
    processes::log(&state.logs,id,"info",format!("同版本源码来自官方HTTPS提交 {revision}；本地SHA256 {digest}（上游没有发布源码ZIP摘要）"));
    Ok(target)
}

fn reject_link(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Err(format!("拒绝经过符号链接写入：{}", path.display()));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("拒绝经过目录联接或重解析点写入".into());
        }
    }
    Ok(())
}
fn safe_relative(name: &str) -> Result<PathBuf, String> {
    if name.is_empty()
        || name.contains('\\')
        || name.starts_with('/')
        || name.contains(':')
        || name.contains('\0')
    {
        return Err("ZIP含非安全相对路径".into());
    }
    let mut path = PathBuf::new();
    for part in name.trim_end_matches('/').split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || part.chars().any(|c| c.is_control())
        {
            return Err("ZIP含目录穿越或Windows路径别名".into());
        }
        let stem = part
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.len() == 4
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err("ZIP含Windows保留路径".into());
        }
        path.push(part);
    }
    Ok(path)
}
fn safe_target(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = safe_relative(relative)?;
    let mut current = root.to_path_buf();
    reject_link(root)?;
    for part in path.components() {
        current.push(part);
        if current.exists() {
            reject_link(&current)?;
        }
    }
    Ok(current)
}
fn source_file(relative: &str) -> bool {
    let mut parts = relative.split('/');
    let first = parts.next().unwrap_or_default();
    if parts.next().is_some() {
        matches!(
            first,
            "serve" | "tools" | "data" | "src" | "include" | "cmake" | "ref" | "sycl" | "docs"
        ) || relative.starts_with("third_party/ggml/")
    } else {
        relative.ends_with(".py")
            || matches!(
                relative,
                "requirements.txt"
                    | "CMakeLists.txt"
                    | "START-HERE.bat"
                    | "SETUP.bat"
                    | "UPDATE.bat"
                    | "setup.sh"
                    | "update.sh"
                    | "LICENSE"
            )
            || relative.starts_with("README")
    }
}
fn extract(
    archive: &Path,
    destination: &Path,
    source: bool,
    check: impl Fn() -> Result<(), String>,
) -> Result<Vec<String>, String> {
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    reject_link(destination)?;
    let mut zip = zip::ZipArchive::new(File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if zip.len() > 30_000 {
        return Err("ZIP文件数超过安全上限".into());
    }
    let mut prefix = None;
    let mut names = HashSet::new();
    let mut entries = Vec::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        check()?;
        let file = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name();
        safe_relative(name)?;
        if file
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("ZIP包含符号链接".into());
        }
        let relative = if source {
            let (parent, leaf) = name.split_once('/').ok_or("官方源码ZIP缺少唯一顶层目录")?;
            if prefix.as_deref().is_some_and(|known| known != parent) {
                return Err("源码ZIP包含多个根目录".into());
            }
            prefix = Some(parent.to_owned());
            leaf
        } else {
            name
        };
        if relative.is_empty() || file.is_dir() {
            continue;
        }
        let relative = relative.to_owned();
        safe_relative(&relative)?;
        if !names.insert(relative.to_ascii_lowercase()) {
            return Err("ZIP包含重复或大小写冲突路径".into());
        }
        total = total.checked_add(file.size()).ok_or("ZIP展开体积无效")?;
        if total > MAX_EXPANDED || file.size() > 1024 * 1024 * 1024 {
            return Err("ZIP展开体积超过安全上限".into());
        }
        if source && !source_file(&relative) {
            continue;
        }
        // The engine ZIP must not supply configs, models, Python or unknown root files.
        if !source
            && !(relative == "BUILD.json"
                || relative == "strata.exe"
                || relative == "strata-vision.exe"
                || relative == "strata-device.exe"
                || relative.to_ascii_lowercase().ends_with(".dll")
                || relative.to_ascii_lowercase().ends_with(".hsaco")
                || relative.starts_with("kernels/")
                || relative.starts_with("licenses/")
                || relative.starts_with("lib/")
                || relative.starts_with("rocm/"))
        {
            return Err(format!("引擎ZIP含未识别的运行文件：{relative}"));
        }
        entries.push((i, relative, file.size()));
    }
    let mut files = Vec::new();
    for (i, name, size) in entries {
        check()?;
        let target = safe_target(destination, &name)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let mut output =
            tempfile::NamedTempFile::new_in(target.parent().ok_or("ZIP目标缺少父目录")?)
                .map_err(|e| e.to_string())?;
        let mut received = 0u64;
        let mut bytes = [0u8; 65536];
        loop {
            check()?;
            let n = entry.read(&mut bytes).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            received += n as u64;
            if received > size {
                return Err("ZIP展开长度与清单不符".into());
            }
            output.write_all(&bytes[..n]).map_err(|e| e.to_string())?;
        }
        if received != size {
            return Err("ZIP文件被截断".into());
        }
        output.as_file().sync_all().map_err(|e| e.to_string())?;
        output
            .persist_noclobber(&target)
            .map_err(|e| e.to_string())?;
        files.push(name);
    }
    let required = if source {
        vec![
            "setup.py",
            "serve/server.py",
            "requirements.txt",
            "CMakeLists.txt",
        ]
    } else {
        vec!["strata.exe", "BUILD.json"]
    };
    if required
        .into_iter()
        .any(|name| !destination.join(name).is_file())
    {
        return Err("官方ZIP缺少必要程序文件，未修改当前安装".into());
    }
    Ok(files)
}
fn portable(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
fn normalized_requirements(path: &Path) -> Result<Vec<String>, String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut rows = text
        .lines()
        .map(|s| s.split('#').next().unwrap_or_default().trim())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    rows.sort();
    Ok(rows)
}
/// Reviewed upstream `serve/server.py` hashes from the shared observer_compat.json.
pub(crate) fn reviewed_observer_hashes() -> HashSet<String> {
    serde_json::from_str::<Value>(OBSERVER_COMPAT)
        .ok()
        .and_then(|v| v.get("reviewed").cloned())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|e| e.get("serverPySha256").and_then(Value::as_array))
        .flatten()
        .filter_map(|h| h.as_str().map(str::to_owned))
        .collect()
}
/// Whether the release source is a reviewed observer fast path. An unreviewed
/// source no longer blocks the update: the observer analyses it structurally at
/// import time and degrades or disables itself, leaving the API unchanged.
fn verify_observer_source(server: &Path) -> Result<bool, String> {
    let hash = super::canonical_hash(server)?;
    Ok(reviewed_observer_hashes().contains(&hash))
}
fn profiles(state: &RuntimeState, root: &Path) -> Result<Vec<ServiceProfile>, String> {
    Ok(state
        .registered_profiles()?
        .into_iter()
        .filter(|p| {
            if dunce::canonicalize(&p.install_dir).is_ok_and(|dir| dir == root) {
                return true;
            }
            let Ok(config) = storage::read(p) else {
                return false;
            };
            let Some(exe) = config["exe"].as_str() else {
                return false;
            };
            let Ok(cwd) = super::config_cwd(p, &config) else {
                return false;
            };
            let exe = super::resolve(&cwd, exe);
            exe.parent()
                .and_then(|dir| dunce::canonicalize(dir).ok())
                .is_some_and(|dir| dir.starts_with(root))
        })
        .collect())
}

/// Several saved configurations can point at the same API endpoint. A listening
/// port does not make each saved configuration a separate running instance.
/// Authorize only the real, running processes owned by this update and verify
/// every native listener, including other listeners sharing that port.
struct OwnedUpdateProfile {
    profile: ServiceProfile,
    child_id: u32,
    started_at: Option<u64>,
    #[cfg(windows)]
    child_handle: usize,
    #[cfg(windows)]
    creation_time: u64,
    #[cfg(windows)]
    image: PathBuf,
}

fn same_profile(left: &ServiceProfile, right: &ServiceProfile) -> Result<bool, String> {
    Ok(serde_json::to_value(left).map_err(|e| e.to_string())?
        == serde_json::to_value(right).map_err(|e| e.to_string())?)
}

fn registered_update_profiles(db: &rusqlite::Connection) -> Result<Vec<ServiceProfile>, String> {
    let mut query = db
        .prepare("SELECT profile FROM local_installations ORDER BY imported_at,id")
        .map_err(|e| e.to_string())?;
    let records = query
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    records
        .map(|record| {
            serde_json::from_str(&record.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
}

fn verify_owned_update_profile(
    actual: &ServiceProfile,
    registered: &ServiceProfile,
    root: &Path,
) -> Result<(), String> {
    if !actual.managed
        || !registered.managed
        || actual.id != registered.id
        || actual.base_url != registered.base_url
        || actual.python_path != registered.python_path
        || dunce::canonicalize(&actual.install_dir).map_err(|e| e.to_string())? != root
        || dunce::canonicalize(&registered.install_dir).map_err(|e| e.to_string())? != root
        || storage::config_path(actual)? != storage::config_path(registered)?
    {
        return Err("运行进程身份或安装根与更新登记不一致，未停止服务".into());
    }
    Ok(())
}

fn owned_update_profiles(
    state: &RuntimeState,
    root: &Path,
    associated: &[ServiceProfile],
) -> Result<Vec<OwnedUpdateProfile>, String> {
    let registered = state.registered_profiles()?;
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
    collect_owned_update_profiles(&mut processes, root, associated, &registered)
}

fn collect_owned_update_profiles(
    processes: &mut std::collections::HashMap<String, processes::OwnedProcess>,
    root: &Path,
    associated: &[ServiceProfile],
    registered: &[ServiceProfile],
) -> Result<Vec<OwnedUpdateProfile>, String> {
    let root = dunce::canonicalize(root).map_err(|e| e.to_string())?;
    let mut owned = Vec::new();
    let mut ids = HashSet::new();
    for profile in associated {
        let current = registered
            .iter()
            .find(|current| current.id == profile.id)
            .ok_or("更新准备期间安装登记已移除，未停止服务")?;
        if !same_profile(current, profile)? {
            return Err("更新准备期间安装登记发生变化，未停止服务".into());
        }
        if let Some(process) = processes.get_mut(&profile.id) {
            let status = process.refresh()?;
            if status.running {
                if !status.owned || status.pid != Some(process.child.id()) {
                    return Err("无法核验更新进程的自有身份，未停止服务".into());
                }
                let actual = process
                    .profile
                    .as_ref()
                    .ok_or("更新进程缺少实际启动身份，未停止服务")?;
                verify_owned_update_profile(actual, current, &root)?;
                if ids.insert(profile.id.clone()) {
                    #[cfg(windows)]
                    use std::os::windows::io::AsRawHandle;
                    #[cfg(windows)]
                    let (creation_time, image) =
                        crate::external::identity(process.child.as_raw_handle())?;
                    owned.push(OwnedUpdateProfile {
                        profile: current.clone(),
                        child_id: process.child.id(),
                        started_at: status.started_at,
                        #[cfg(windows)]
                        child_handle: process.child.as_raw_handle() as usize,
                        #[cfg(windows)]
                        creation_time,
                        #[cfg(windows)]
                        image,
                    });
                }
            }
        }
    }
    #[cfg(windows)]
    {
        let mut ports = HashSet::new();
        for profile in associated {
            let port = crate::external::local_port(profile)?;
            if !ports.insert(port) {
                continue;
            }
            for pid in crate::external::listener_ids(profile)? {
                let mut is_owned = false;
                for owner in &owned {
                    let process = processes
                        .get(&owner.profile.id)
                        .ok_or("受管服务清单已变化，未停止服务")?;
                    if process.owns_pid(pid)? {
                        is_owned = true;
                        break;
                    }
                }
                if !is_owned {
                    return Err(
                        "此运行环境由外部程序使用；更新不会停止外部服务，请先自行停止它".into(),
                    );
                }
            }
        }
    }
    #[cfg(not(windows))]
    for profile in associated {
        if !owned.iter().any(|owner| owner.profile.id == profile.id)
            && crate::external::port_accepting(profile)?
        {
            return Err("此运行环境由外部程序使用；更新不会停止外部服务，请先自行停止它".into());
        }
    }
    Ok(owned)
}

/// An outer error guarantees that no stop was attempted. A stop error is returned
/// separately so only a transaction that really crossed that boundary rolls back.
fn stop_drained_owned_profiles(
    state: &RuntimeState,
    root: &Path,
    associated: &[ServiceProfile],
    expected: &[OwnedUpdateProfile],
    journal: Option<&mut Journal>,
) -> Result<Option<String>, String> {
    let _operation = state
        .runtime_operations
        .try_lock()
        .map_err(|_| "后台操作正在进行，未停止服务")?;
    // Keep cancellation and registry writers outside the final validation/stop
    // boundary. try_lock on processes prevents a DB -> process lock wait cycle.
    let tasks = state
        .tasks
        .try_lock()
        .map_err(|_| "任务状态正在变化，未停止服务")?;
    if state.shutting_down.load(Ordering::Acquire)
        || journal
            .as_ref()
            .is_some_and(|j| tasks.get(&j.task_id).is_none_or(|task| task.cancelled))
    {
        return Err("运行时更新已取消，未停止服务".into());
    }
    let db = state.database.lock().map_err(|e| e.to_string())?;
    let registered = registered_update_profiles(&db)?;
    let mut processes = state
        .processes
        .try_lock()
        .map_err(|_| "服务进程清单正在变化，未停止服务")?;
    // This repeats the native IPv4/IPv6 listener scan after every async drain.
    let current = collect_owned_update_profiles(&mut processes, root, associated, &registered)?;
    if current.len() != expected.len() {
        return Err("排空期间受管服务清单发生变化，未停止服务".into());
    }
    for (current, expected) in current.iter().zip(expected) {
        if !same_profile(&current.profile, &expected.profile)?
            || current.child_id != expected.child_id
            || current.started_at != expected.started_at
        {
            return Err("排空期间实际受管进程发生变化，未停止服务".into());
        }
        #[cfg(windows)]
        if current.child_handle != expected.child_handle
            || current.creation_time != expected.creation_time
            || current.image != expected.image
        {
            return Err("排空期间实际受管进程句柄发生变化，未停止服务".into());
        }
    }
    if state.shutting_down.load(Ordering::Acquire) {
        return Err("后台正在退出，未停止服务".into());
    }
    // Validation refusals retain a preparation phase. A crash can only recover
    // replacing after all checks passed and durable intent preceded the stop.
    if let Some(journal) = journal {
        let previous = journal.phase.clone();
        journal.phase = "replacing".into();
        journal.updated_at = now();
        if let Err(error) = persist_locked(&db, journal) {
            journal.phase = previous;
            return Err(error);
        }
    }
    for owner in current {
        let Some(process) = processes.get_mut(&owner.profile.id) else {
            return Ok(Some("受管服务清单已变化，停止未完成".into()));
        };
        if let Err(error) = process.stop() {
            return Ok(Some(error));
        }
    }
    Ok(None)
}

fn engine_directories(
    root: &Path,
    asset: &RuntimeReleaseAsset,
    profiles: &[ServiceProfile],
) -> Result<Vec<PathBuf>, String> {
    let default_name = if asset.variant == "cuda12" {
        if root.join("engine_cuda12").is_dir() && !root.join("engine-cuda12").is_dir() {
            "engine_cuda12"
        } else {
            "engine-cuda12"
        }
    } else {
        "engine"
    };
    let mut directories = vec![PathBuf::from(default_name)];
    for profile in profiles {
        let config = storage::read(profile)?;
        if let Some(exe) = config["exe"].as_str() {
            let cwd = super::config_cwd(profile, &config)?;
            let executable = super::resolve(&cwd, exe);
            let parent = executable.parent().ok_or("配置的引擎路径没有父目录")?;
            let parent =
                dunce::canonicalize(parent).map_err(|_| "配置引擎目录不存在，不能安全替换")?;
            if directory_variant(&parent).is_some_and(|variant| variant != asset.variant) {
                return Err("此目录的模型配置使用不同CUDA/HIP引擎；所选ZIP不会替换不匹配的引擎，请分别准备对应运行环境".into());
            }
            let relative = parent
                .strip_prefix(root)
                .map_err(|_| "引擎在所选运行环境目录之外；为保留配置请更新该引擎所属运行环境")?;
            if relative.as_os_str().is_empty() {
                return Err("引擎与源码共用根目录，无法安全合并ZIP，请先整理引擎目录".into());
            }
            if !directories.contains(&relative.to_path_buf()) {
                directories.push(relative.to_path_buf());
            }
        }
    }
    Ok(directories)
}
fn target_profile(j: &Journal, profile: &ServiceProfile) -> ServiceProfile {
    j.migrations
        .iter()
        .find(|migration| migration.old.id == profile.id)
        .map(|migration| migration.new.clone())
        .unwrap_or_else(|| profile.clone())
}
fn migrate_registry(state: &RuntimeState, j: &Journal) -> Result<(), String> {
    for migration in &j.migrations {
        if installation::file_hash(&storage::config_path(&migration.old)?)?
            != migration.config_sha256
        {
            return Err("等待更新期间模型配置发生变化，拒绝切换登记".into());
        }
        if serde_json::to_value(&migration.old).map_err(|e| e.to_string())?
            != serde_json::to_value(&migration.new).map_err(|e| e.to_string())?
        {
            super::registry_replace(state, &migration.old, &migration.new)?;
        }
    }
    Ok(())
}
fn rollback_registry(state: &RuntimeState, j: &Journal) -> Result<(), String> {
    let mut errors = Vec::new();
    for migration in j.migrations.iter().rev() {
        let result = (|| {
            let current = state.registered_profile(&migration.old.id)?;
            if serde_json::to_value(&current).map_err(|e| e.to_string())?
                == serde_json::to_value(&migration.old).map_err(|e| e.to_string())?
            {
                return Ok(());
            }
            super::registry_replace(state, &migration.new, &migration.old)
        })();
        if let Err(error) = result {
            errors.push(error);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}
async fn start_lazy_service(
    state: Arc<RuntimeState>,
    profile: ServiceProfile,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let _operation = state.runtime_operations.lock().map_err(|e| e.to_string())?;
        // cleanup takes this same lock. A restart queued before window close
        // must not create a new owned process after cleanup has finished.
        if state.shutting_down.load(Ordering::Acquire) {
            return Err("后台正在退出，程序已恢复且不会重新启动模型服务".into());
        }
        state.assert_single_model(&profile.id)?;
        let tasks: processes::Tasks =
            Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
        let mut plan = crate::prepare_startup(&profile, &state.processes, &tasks)?;
        // The update restores loading deliberately after health passes, so an
        // unloaded service cannot eagerly reload a model merely because it restarts.
        plan.lazy_cli = true;
        let secret = http::key(&profile.id)?;
        crate::start_prepared_service(&state, profile, plan, secret)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
fn add_change(
    root: &Path,
    work: &Path,
    relative: &str,
    source: &Path,
    changes: &mut Vec<Change>,
) -> Result<(), String> {
    let target = safe_target(root, relative)?;
    let replacement = installation::file_hash(source)?;
    let original = if target.exists() {
        if !target.is_file() {
            return Err("程序更新目标不是普通文件".into());
        }
        Some(installation::file_hash(&target)?)
    } else {
        None
    };
    if original.as_deref() == Some(&replacement) {
        return Ok(());
    }
    let staged = safe_target(&work.join("replacement"), relative)?;
    if let Some(parent) = staged.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::copy(source, &staged).map_err(|e| e.to_string())?;
    if let Some(old) = &original {
        let backup = safe_target(&work.join("backup"), relative)?;
        if let Some(parent) = backup.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(&target, &backup).map_err(|e| e.to_string())?;
        fs::OpenOptions::new()
            .write(true)
            .open(&backup)
            .map_err(|e| e.to_string())?
            .sync_all()
            .map_err(|e| e.to_string())?;
        if installation::file_hash(&backup)? != *old {
            return Err("原文件备份校验失败".into());
        }
    }
    changes.push(Change {
        relative: relative.into(),
        original_sha256: original,
        replacement_sha256: replacement,
    });
    Ok(())
}
fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    let parent = target.parent().ok_or("程序文件没有父目录")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    let mut file = File::open(source).map_err(|e| e.to_string())?;
    std::io::copy(&mut file, &mut temp).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(target).map_err(|e| e.to_string())?;
    Ok(())
}
fn apply(
    root: &Path,
    work: &Path,
    changes: &[Change],
    check: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    for change in changes {
        check()?;
        let target = safe_target(root, &change.relative)?;
        let current = if target.exists() {
            Some(installation::file_hash(&target)?)
        } else {
            None
        };
        if current != change.original_sha256 {
            return Err(format!("准备期间文件已改变，拒绝覆盖：{}", change.relative));
        }
        let replacement = safe_target(&work.join("replacement"), &change.relative)?;
        if installation::file_hash(&replacement)? != change.replacement_sha256 {
            return Err("候选程序文件已改变".into());
        }
        replace_file(&replacement, &target)?;
    }
    Ok(())
}
fn rollback_files(root: &Path, work: &Path, changes: &[Change]) -> Result<(), String> {
    let mut errors = Vec::new();
    for change in changes.iter().rev() {
        let result = (|| {
            let target = safe_target(root, &change.relative)?;
            let current = if target.exists() {
                Some(installation::file_hash(&target)?)
            } else {
                None
            };
            if current == change.original_sha256 {
                return Ok(());
            }
            if current.as_deref() != Some(&change.replacement_sha256) {
                return Err(format!(
                    "回滚时程序文件被外部修改，已保留：{}",
                    change.relative
                ));
            }
            if let Some(original) = &change.original_sha256 {
                let backup = safe_target(&work.join("backup"), &change.relative)?;
                if installation::file_hash(&backup)? != *original {
                    return Err("备份文件校验失败，已保留当前文件".into());
                }
                replace_file(&backup, &target)?;
            } else {
                fs::remove_file(&target).map_err(|e| e.to_string())?;
            }
            Ok::<(), String>(())
        })();
        if let Err(error) = result {
            errors.push(error);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

async fn prepare_python(
    state: &RuntimeState,
    j: &mut Journal,
    asset: &RuntimeReleaseAsset,
) -> Result<String, String> {
    let base = installation::ensure_python(state, &j.task_id).await?;
    let venv = j.install_dir.join(".venv");
    if venv.exists() {
        return Err("新安装目录已有Python环境，拒绝覆盖".into());
    }
    let mut command = Command::new(base);
    command
        .args(["-I", "-m", "venv"])
        .arg(&venv)
        .current_dir(&j.install_dir);
    installation::run_owned(state, &j.task_id, command, "正在创建新Strata私有Python环境").await?;
    let python = venv.join("Scripts/python.exe");
    let mut pip = Command::new(&python);
    pip.args([
        "-I",
        "-m",
        "pip",
        "--isolated",
        "install",
        "--disable-pip-version-check",
        "--index-url",
        "https://pypi.org/simple",
        "--only-binary=:all:",
        "-r",
    ])
    .arg(j.install_dir.join("requirements.txt"))
    .current_dir(&j.install_dir);
    installation::run_owned(state, &j.task_id, pip, "正在安装此Release的Python依赖").await?;
    if matches!(asset.variant.as_str(), "cuda12" | "cuda13") {
        let packages = if asset.variant == "cuda12" {
            [
                "nvidia-cublas-cu12==12.9.1.4",
                "nvidia-cuda-runtime-cu12==12.9.79",
            ]
        } else {
            ["nvidia-cublas==13.0.2.14", "nvidia-cuda-runtime==13.0.96"]
        };
        let mut pip = Command::new(&python);
        pip.args([
            "-I",
            "-m",
            "pip",
            "--isolated",
            "install",
            "--disable-pip-version-check",
            "--index-url",
            "https://pypi.org/simple",
            "--only-binary=:all:",
        ])
        .args(packages)
        .current_dir(&j.install_dir);
        installation::run_owned(state, &j.task_id, pip, "正在安装匹配引擎ZIP的CUDA运行库").await?;
    }
    Ok(python.to_string_lossy().into())
}
const PYTHON_PROBE: &str = "import pathlib,sys; root=pathlib.Path(sys.argv[1]); [compile(p.read_bytes(),str(p),'exec') for p in (root/'serve').rglob('*.py')]; exec('import numpy,PIL' if sys.argv[2]=='dependencies' else ''); print('Strata source and Python dependencies OK')";

async fn check_python(
    state: &RuntimeState,
    id: &str,
    python: &str,
    source: &Path,
) -> Result<(), String> {
    let mut probe = Command::new(python);
    probe
        .args(["-I", "-c", PYTHON_PROBE])
        .arg(source)
        .arg("dependencies")
        .current_dir(source);
    installation::run_owned(state, id, probe, "正在验证Python依赖及新版服务源码语法").await
}
async fn execute(state: Arc<RuntimeState>, j: &mut Journal) -> Result<String, String> {
    cancelled(&state, &j.task_id)?;
    let info = super::update_info_for_installation(&state).await?;
    if info.error.is_some() || !info.installable {
        return Err(info
            .error
            .unwrap_or("官方Release暂没有可验证的Windows ZIP".into()));
    }
    let asset = choose_asset(&info, &j.install_dir, j.asset_name.as_deref())?;
    let revision = info.source_revision.clone().ok_or("发布源码提交未核验")?;
    let version = info.latest_version.clone().ok_or("发布版本缺失")?;
    if !j.new_install {
        prevent_downgrade(&j.install_dir, &version)?;
    }
    j.version = Some(version.clone());
    j.revision = Some(revision.clone());
    j.asset_name = Some(asset.name.clone());
    let work = work_dir(&state, &j.task_id)?;
    for part in ["source", "engine", "replacement", "backup"] {
        fs::create_dir(work.join(part)).map_err(|e| e.to_string())?;
    }
    progress(
        &state,
        j,
        "downloading",
        &format!(
            "正在下载官方Release v{version}：{}（{}字节）及同提交源码",
            asset.name, asset.size
        ),
    )?;
    let source = source_archive(
        &state,
        &j.task_id,
        info.source_archive_url
            .as_deref()
            .ok_or("同版本源码地址缺失")?,
        &revision,
    )
    .await?;
    progress(
        &state,
        j,
        "extracting",
        "正在安全解包同版本源码并核验统计观察器兼容性",
    )?;
    let source_files = extract(&source, &work.join("source"), true, || {
        cancelled(&state, &j.task_id)
    })?;
    if !verify_observer_source(&work.join("source/serve/server.py"))? {
        progress(
            &state,
            j,
            "extracting",
            "此Release服务源码不在已审查清单中：统计观察器将在启动时按结构自动探测，必要时降级为公开接口监控",
        )?;
    }
    progress(
        &state,
        j,
        "downloadingEngine",
        &format!(
            "源码兼容检查通过；正在下载官方{}（{}字节），完成后核验官方SHA256",
            asset.name, asset.size
        ),
    )?;
    let engine =
        download_source::engine_archive(&state, &j.task_id, &asset, &j.download, &work).await?;
    if fs::metadata(&engine).map_err(|e| e.to_string())?.len() != asset.size {
        return Err("官方ZIP精确长度与Release清单不符".into());
    }
    progress(
        &state,
        j,
        "extractingEngine",
        "官方引擎SHA256和精确长度通过；正在安全解包运行文件",
    )?;
    let engine_files = extract(&engine, &work.join("engine"), false, || {
        cancelled(&state, &j.task_id)
    })?;
    let build: Value = serde_json::from_slice(
        &fs::read(work.join("engine/BUILD.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if build["version"].as_str() != Some(&version) {
        return Err("引擎ZIP内部版本与Release不一致，未停止服务".into());
    }
    let associated = profiles(&state, &j.install_dir)?;
    if !j.new_install
        && normalized_requirements(&j.install_dir.join("requirements.txt"))?
            != normalized_requirements(&work.join("source/requirements.txt"))?
    {
        return Err("此Release改变了Python依赖；现有Python环境保持原位。请先准备新的独立运行环境后再迁移，当前服务未停止".into());
    }
    for profile in &associated {
        if normalized_requirements(&Path::new(&profile.install_dir).join("requirements.txt"))?
            != normalized_requirements(&work.join("source/requirements.txt"))?
        {
            return Err(
                "关联服务的Python依赖与新版不同；保留其原环境，未停止服务，请先准备独立环境迁移"
                    .into(),
            );
        }
        let mut target = profile.clone();
        target.install_dir = j.install_dir.to_string_lossy().into();
        target.config_path = storage::config_path(profile)?.to_string_lossy().into();
        if !Path::new(&profile.python_path).is_absolute() && !profile.python_path.is_empty() {
            target.python_path = Path::new(&profile.install_dir)
                .join(&profile.python_path)
                .to_string_lossy()
                .into();
        }
        j.migrations.push(Migration {
            old: profile.clone(),
            new: target,
            config_sha256: installation::file_hash(&storage::config_path(profile)?)?,
        });
    }
    let mut python = associated
        .first()
        .map(|p| p.python_path.clone())
        .filter(|s| !s.is_empty());
    if python.is_none() && !j.new_install {
        python = crate::discovery::discover_runtimes(&associated)
            .into_iter()
            .find(|r| dunce::canonicalize(&r.install_dir).is_ok_and(|p| p == j.install_dir))
            .map(|r| r.python_path);
    }
    if let Some(python) = &python {
        check_python(&state, &j.task_id, python, &work.join("source")).await?;
    }
    let directories = engine_directories(&j.install_dir, &asset, &associated)?;
    for relative in source_files {
        // Existing data files may be user-supplied expert profiles or models.
        // Never overwrite them without a previous manager-owned manifest.
        if relative.starts_with("data/") && j.install_dir.join(&relative).exists() {
            continue;
        }
        if associated.iter().any(|p| {
            dunce::canonicalize(&p.config_path).is_ok_and(|p| p == j.install_dir.join(&relative))
        }) {
            continue;
        }
        add_change(
            &j.install_dir,
            &work,
            &relative,
            &work.join("source").join(&relative),
            &mut j.changes,
        )?;
    }
    for directory in directories {
        for file in &engine_files {
            let relative = portable(&directory.join(file));
            add_change(
                &j.install_dir,
                &work,
                &relative,
                &work.join("engine").join(file),
                &mut j.changes,
            )?;
        }
    }
    let marker = work.join("release-marker.json");
    fs::write(&marker,serde_json::to_vec_pretty(&json!({"version":version,"revision":revision,"assetName":asset.name,"sha256":asset.sha256,"sourceSha256":installation::file_hash(&source)?,"updatedAt":now()})).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    add_change(
        &j.install_dir,
        &work,
        RELEASE_MARKER,
        &marker,
        &mut j.changes,
    )?;
    let old_marker = j.install_dir.join(".strata-manager-runtime.json");
    if old_marker.exists() {
        let mut metadata: Value =
            serde_json::from_slice(&fs::read(&old_marker).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        metadata["revision"] = json!(revision);
        if metadata["result"].is_object() {
            metadata["result"]["sourceRevision"] = json!(revision);
        }
        if let Some(hashes) = metadata["criticalHashes"].as_object_mut() {
            for change in &j.changes {
                if hashes.contains_key(&change.relative) {
                    hashes.insert(change.relative.clone(), json!(change.replacement_sha256));
                }
            }
        }
        let temp = work.join("runtime-marker.json");
        fs::write(
            &temp,
            serde_json::to_vec_pretty(&metadata).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        add_change(
            &j.install_dir,
            &work,
            ".strata-manager-runtime.json",
            &temp,
            &mut j.changes,
        )?;
    }
    progress(
        &state,
        j,
        "prepared",
        "同版本源码、引擎和原文件备份已准备；配置及模型文件保持原位",
    )?;
    let _selection = state.selection_lock.lock().await;
    state
        .selection_changing
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "正在切换模型")?;
    let _selection_flag = SelectionFlag(state.clone());
    let mut guards = Vec::new();
    let owned = owned_update_profiles(&state, &j.install_dir, &associated)?;
    for owner in &owned {
        let profile = &owner.profile;
        if !j.requested_stop_current_service {
            return Err("检测到更新准备期间启动的模型服务；尚未确认停止，原服务保持运行".into());
        }
        let gate = maintenance::begin(&state, &profile.id, None, "drain")?;
        progress(
            &state,
            j,
            "waitingIdle",
            "正在等待受管服务请求完成；准备停止本应用拥有的服务",
        )?;
        tokio::select! {result=maintenance::wait_idle(&state,profile)=>result?,_=super::wait_cancel(&state,&j.task_id)=>return Err("更新已取消，原服务保持运行".into())};
        let health = http::strata_request(
            &state,
            profile.clone(),
            "/health".into(),
            "GET".into(),
            None,
        )
        .await?;
        j.running.push(Restart {
            profile: profile.clone(),
            loaded: health["loaded"].as_bool().ok_or("服务加载状态无法核验")?,
        });
        guards.push(gate);
    }
    cancelled(&state, &j.task_id)?;
    // Refusals occur outside rollback, with no replacing intent and no stop.
    let install_dir = j.install_dir.clone();
    let stop_error =
        stop_drained_owned_profiles(&state, &install_dir, &associated, &owned, Some(j))?;
    let result = async {
        if let Some(error) = stop_error {
            return Err(error);
        }
        if crate::discovery::has_running_installation(&j.install_dir)? {
            return Err("检测到其它程序仍在运行此目录，未替换文件".into());
        }
        apply(&j.install_dir, &work, &j.changes, || {
            cancelled(&state, &j.task_id)
        })?;
        if j.new_install {
            progress(
                &state,
                j,
                "preparingPython",
                "运行程序已解包，正在准备独立Python环境和依赖；不会启动模型",
            )?;
            python = Some(prepare_python(&state, j, &asset).await?);
        }
        if let Some(python) = &python {
            check_python(&state, &j.task_id, python, &j.install_dir).await?;
        }
        progress(
            &state,
            j,
            "verifying",
            "源码与引擎已同步替换；正在恢复原受管服务状态",
        )?;
        migrate_registry(&state,j)?;
        // Keep supervisor-owned admission guards until the new service has
        // passed verification. Controlled /load carries the matching token.
        for (index,running) in j.running.iter().enumerate() {
            let target=target_profile(j,&running.profile);
            start_lazy_service(state.clone(), target.clone()).await?;
            wait_health(&state, &j.task_id, &target, false).await?;
            if running.loaded {
                super::post(&state, &target, "/load", json!({}), guards.get(index).map(|guard|guard.token()), 1200).await?;
                wait_health(&state, &j.task_id, &target, true).await?;
            }
        }
        cancelled(&state, &j.task_id)?;
        let publication=if j.new_install {
            let python=python.clone().ok_or("新安装Python结果缺失")?;
            let installation_id=uuid::Uuid::new_v4().to_string();
            let result=installation::PreparedRuntime{installation_id:installation_id.clone(),source_revision:revision.clone(),install_dir:j.install_dir.to_string_lossy().into(),python_path:python.clone(),prepared_at:now(),profile:ServiceProfile{id:format!("runtime-{installation_id}"),name:"Strata".into(),base_url:"http://127.0.0.1:18081".into(),install_dir:j.install_dir.to_string_lossy().into(),python_path:python,config_path:String::new(),managed:true}};
            Some(json!({"taskId":j.task_id,"result":result}))
        } else {
            let mut status=crate::store_get(&state,"automaticRuntimeInstallation".into())?;
            if status["result"]["installDir"].as_str().is_some_and(|p|dunce::canonicalize(p).is_ok_and(|p|p==j.install_dir)) {status["result"]["sourceRevision"]=json!(revision);Some(status)} else {None}
        };
        complete(&state,j,publication,&format!("已安装官方Release v{version}同版本源码及{}；模型、配置、会话保留，原程序备份位于 {}",asset.name,work.join("backup").display()))?;
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = result {
        progress(
            &state,
            j,
            "rollingBack",
            "更新未完成，正在恢复原程序文件和受管服务",
        )?;
        for running in &j.running {
            let _ = super::owned_stop(&state, &running.profile.id).await;
        }
        let rollback = rollback_files(&j.install_dir, &work, &j.changes)
            .and_then(|_| rollback_registry(&state, j));
        if let Err(rollback) = rollback {
            j.phase = "rollbackFailed".into();
            j.error = Some(format!("{error}；回滚未完成：{rollback}"));
            persist(&state, j)?;
            crate::store_set(&state, "localServiceDesired".into(), json!(false))?;
            return Err(j.error.clone().unwrap_or_default());
        }
        if !state.shutting_down.load(Ordering::Acquire) {
            for (index, running) in j.running.iter().enumerate() {
                if let Err(restart) =
                    start_lazy_service(state.clone(), running.profile.clone()).await
                {
                    j.phase = "rolledBack".into();
                    persist(&state, j)?;
                    return Err(format!(
                        "{error}；程序文件已恢复，原服务启动失败：{restart}"
                    ));
                }
                if running.loaded {
                    let _ = super::post(
                        &state,
                        &running.profile,
                        "/load",
                        json!({}),
                        guards.get(index).map(|guard| guard.token()),
                        1200,
                    )
                    .await;
                }
            }
        }
        progress(
            &state,
            j,
            "rolledBack",
            "原程序文件已恢复，模型与配置保持原位；更新可重试",
        )?;
        return Err(format!("{error}；已恢复原程序版本"));
    }
    Ok(format!(
        "Strata已{}至官方Release v{version}；模型、配置及会话已保留",
        if j.new_install { "安装" } else { "更新" }
    ))
}
async fn wait_health(
    state: &RuntimeState,
    id: &str,
    profile: &ServiceProfile,
    loaded: bool,
) -> Result<(), String> {
    let deadline = Instant::now()
        + if loaded {
            Duration::from_secs(1200)
        } else {
            Duration::from_secs(45)
        };
    loop {
        cancelled(state, id)?;
        if let Ok(health) =
            http::strata_request(state, profile.clone(), "/health".into(), "GET".into(), None).await
        {
            if health["service"] == "strata"
                && health["status"] == "ok"
                && (!loaded || health["loaded"] == true)
            {
                return Ok(());
            }
        }
        if Instant::now() > deadline {
            return Err("新版受管服务健康/加载验收超时".into());
        }
        tokio::time::sleep(Duration::from_millis(350)).await;
    }
}

pub(super) fn recover(state: &RuntimeState) -> Result<(), String> {
    let rows = {
        let db = state.database.lock().map_err(|e| e.to_string())?;
        db.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        let mut query = db
            .prepare("SELECT journal FROM runtime_zip_updates ORDER BY updated_at,task_id")
            .map_err(|e| e.to_string())?;
        let rows = query
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    for data in rows {
        let mut j: Journal = serde_json::from_str(&data).map_err(|e| e.to_string())?;
        if matches!(
            j.phase.as_str(),
            "completed" | "failed" | "cancelled" | "rolledBack"
        ) {
            continue;
        }
        if matches!(
            j.phase.as_str(),
            "replacing" | "preparingPython" | "verifying" | "rollingBack" | "rollbackFailed"
        ) {
            let result = if crate::discovery::has_running_installation(&j.install_dir)? {
                Err("目录仍由外部服务使用，不能回滚程序文件".into())
            } else {
                rollback_files(&j.install_dir, &work_dir(state, &j.task_id)?, &j.changes)
                    .and_then(|_| rollback_registry(state, &j))
            };
            match result {
                Ok(()) => {
                    j.phase = "rolledBack".into();
                    j.error = Some("后台在更新验收前退出，已从备份恢复原程序文件".into());
                    if crate::store_get(state, "localServiceDesired".into())?.as_bool()
                        == Some(false)
                    {
                        crate::store_set(state, "runtimeUpgradeRecoveryLoad".into(), Value::Null)?;
                    } else if let Some(running) = j.running.first() {
                        crate::store_set(
                            state,
                            "runtimeUpgradeRecoveryLoad".into(),
                            json!({"profileId":running.profile.id,"loaded":running.loaded}),
                        )?;
                    }
                }
                Err(error) => {
                    j.phase = "rollbackFailed".into();
                    j.error = Some(format!(
                        "中断更新回滚未完成：{error}；程序及备份保留，修复后重新打开应用可重试恢复"
                    ));
                    crate::store_set(state, "localServiceDesired".into(), json!(false))?;
                }
            }
        } else {
            j.phase = "cancelled".into();
            j.error = Some("后台在ZIP准备阶段退出，原程序尚未替换".into());
        }
        j.updated_at = now();
        persist(state, &j)?;
        if let Some(task) = state
            .tasks
            .lock()
            .map_err(|e| e.to_string())?
            .get_mut(&j.task_id)
        {
            task.status.state = "failed".into();
            task.status.finished_at = Some(now());
            task.status.message = j.error.clone().unwrap_or_default();
            processes::persist_task(&state.database, task)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    #[ignore = "Child-only isolated TCP listener fixture; started by ownership regression tests"]
    fn zip_update_listener_fixture() {
        use std::net::TcpListener;
        let port: u16 = std::env::var("STRATA_ZIP_LISTENER_FIXTURE_PORT")
            .expect("fixture port")
            .parse()
            .unwrap();
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).unwrap();
        for mut stream in listener.incoming().flatten() {
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let _ = stream.read(&mut [0; 4096]);
            let body = br#"{"service":"strata","status":"ok","loaded":false,"activity":{"in_flight":0},"live":{"state":"idle","queued":0,"running":0,"waiting":0,"outside_slots":0}}"#;
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(body);
        }
    }

    #[cfg(windows)]
    fn zip_listener_profile(state: &RuntimeState, id: &str, port: u16) -> ServiceProfile {
        ServiceProfile {
            id: id.into(),
            name: id.into(),
            base_url: format!("http://127.0.0.1:{port}"),
            install_dir: state.data_dir().to_string_lossy().into(),
            python_path: String::new(),
            config_path: state
                .data_dir()
                .join(format!("{id}.json"))
                .to_string_lossy()
                .into(),
            managed: true,
        }
    }

    #[cfg(windows)]
    fn register_zip_profile(state: &RuntimeState, profile: &ServiceProfile) {
        let serialized = serde_json::to_string(profile).unwrap();
        state.database.lock().unwrap().execute(
            "INSERT INTO local_installations(id,profile,original_profile,imported_at) VALUES(?1,?2,?2,0) ON CONFLICT(id) DO UPDATE SET profile=excluded.profile",
            params![profile.id, serialized],
        ).unwrap();
    }

    #[cfg(windows)]
    fn owned_zip_listener(state: &RuntimeState, id: &str) -> ServiceProfile {
        use std::net::{Ipv4Addr, TcpListener};
        let reservation = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = reservation.local_addr().unwrap().port();
        drop(reservation);
        let profile = zip_listener_profile(state, id, port);
        fs::write(&profile.config_path, b"{}").unwrap();
        register_zip_profile(state, &profile);
        spawn_zip_listener(state, &profile);
        profile
    }

    #[cfg(windows)]
    fn spawn_zip_listener(state: &RuntimeState, profile: &ServiceProfile) {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--ignored",
                "--exact",
                "runtime_upgrade::release_zip::tests::zip_update_listener_fixture",
                "--nocapture",
            ])
            .env(
                "STRATA_ZIP_LISTENER_FIXTURE_PORT",
                crate::external::local_port(profile).unwrap().to_string(),
            );
        let mut process =
            processes::OwnedProcess::spawn(command, state.logs.clone(), &profile.id).unwrap();
        process.profile = Some(profile.clone());
        let pid = process.child.id();
        state
            .processes
            .lock()
            .unwrap()
            .insert(profile.id.clone(), process);
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if crate::external::listener_ids(profile)
                .unwrap()
                .contains(&pid)
            {
                break;
            }
            assert!(
                state
                    .processes
                    .lock()
                    .unwrap()
                    .get_mut(&profile.id)
                    .unwrap()
                    .refresh()
                    .unwrap()
                    .running,
                "fixture exited before listening"
            );
            assert!(Instant::now() < deadline, "fixture listener timed out");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(windows)]
    #[test]
    fn zip_shared_endpoint_alias_is_not_a_second_running_service() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("app")).unwrap();
        let owner = owned_zip_listener(&state, "owned-current");
        let mut alias = owner.clone();
        alias.id = "old-saved-configuration".into();
        alias.config_path = state
            .data_dir()
            .join("old-saved.json")
            .to_string_lossy()
            .into();
        fs::write(&alias.config_path, b"{}").unwrap();
        alias.base_url = format!(
            "http://localhost:{}/",
            crate::external::local_port(&owner).unwrap()
        );
        register_zip_profile(&state, &alias);
        let owned =
            owned_update_profiles(&state, state.data_dir(), &[alias, owner.clone()]).unwrap();
        assert_eq!(
            owned
                .iter()
                .map(|owner| owner.profile.id.as_str())
                .collect::<Vec<_>>(),
            vec![owner.id.as_str()]
        );
        assert!(
            state
                .processes
                .lock()
                .unwrap()
                .get_mut(&owner.id)
                .unwrap()
                .refresh()
                .unwrap()
                .running
        );
    }

    #[cfg(windows)]
    #[test]
    fn zip_shared_endpoint_still_rejects_external_listener_in_other_address_family() {
        use std::net::{Ipv6Addr, TcpListener};
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("app")).unwrap();
        let owner = owned_zip_listener(&state, "owned-current");
        let port = crate::external::local_port(&owner).unwrap();
        let external = TcpListener::bind((Ipv6Addr::LOCALHOST, port)).unwrap();
        let mut alias = owner.clone();
        alias.id = "old-saved-configuration".into();
        register_zip_profile(&state, &alias);
        assert!(crate::external::listener_ids(&alias)
            .unwrap()
            .contains(&std::process::id()));
        assert!(
            owned_update_profiles(&state, state.data_dir(), &[alias, owner.clone()])
                .err()
                .unwrap()
                .contains("外部程序")
        );
        assert!(
            state
                .processes
                .lock()
                .unwrap()
                .get_mut(&owner.id)
                .unwrap()
                .refresh()
                .unwrap()
                .running
        );
        assert_eq!(external.local_addr().unwrap().port(), port);
    }

    #[cfg(windows)]
    #[test]
    fn zip_shared_endpoint_preserves_all_real_owned_jobs_once() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("app")).unwrap();
        let first = owned_zip_listener(&state, "owned-first");
        let second = owned_zip_listener(&state, "owned-second");
        let mut alias = first.clone();
        alias.id = "old-saved-configuration".into();
        register_zip_profile(&state, &alias);
        let owned = owned_update_profiles(
            &state,
            state.data_dir(),
            &[alias, first.clone(), second.clone()],
        )
        .unwrap();
        assert_eq!(
            owned
                .iter()
                .map(|owner| owner.profile.id.as_str())
                .collect::<Vec<_>>(),
            vec![first.id.as_str(), second.id.as_str()]
        );
        assert!(state
            .processes
            .lock()
            .unwrap()
            .values_mut()
            .all(|process| process.refresh().unwrap().running));
    }

    #[cfg(windows)]
    fn zip_waiting_journal(state: &RuntimeState, profile: &ServiceProfile) -> Journal {
        let journal = Journal {
            task_id: "isolated-stop-boundary".into(),
            install_dir: state.data_dir().into(),
            phase: "waitingIdle".into(),
            new_install: false,
            asset_name: None,
            requested_asset_name: None,
            requested_stop_current_service: true,
            download: RuntimeZipDownloadOptions::default(),
            version: None,
            revision: None,
            changes: vec![],
            running: vec![Restart {
                profile: profile.clone(),
                loaded: false,
            }],
            migrations: vec![],
            error: None,
            updated_at: now(),
        };
        persist(state, &journal).unwrap();
        let task = processes::TaskRecord {
            status: TaskStatus {
                id: journal.task_id.clone(),
                kind: "update".into(),
                state: "running".into(),
                message: "isolated fixture".into(),
                started_at: now(),
                finished_at: None,
            },
            profile_id: None,
            runtime_path: Some(journal.install_dir.clone()),
            cancelled: false,
            process: None,
        };
        processes::persist_task(&state.database, &task).unwrap();
        state
            .tasks
            .lock()
            .unwrap()
            .insert(journal.task_id.clone(), task);
        journal
    }

    #[cfg(windows)]
    fn assert_zip_owner_running(state: &RuntimeState, profile: &ServiceProfile) {
        let mut processes = state.processes.lock().unwrap();
        let process = processes.get_mut(&profile.id).unwrap();
        assert!(process.refresh().unwrap().running);
        assert!(process.owns_pid(process.child.id()).unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn zip_same_id_registry_drift_refuses_stop_and_reopen_never_rolls_back() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("app")).unwrap();
        let owner = owned_zip_listener(&state, "owned-current");
        let associated = vec![owner.clone()];
        let expected = owned_update_profiles(&state, state.data_dir(), &associated).unwrap();
        let original = state.data_dir().join("program.py");
        fs::write(&original, b"original program").unwrap();
        let mut journal = zip_waiting_journal(&state, &owner);
        let mut changed = owner.clone();
        changed.config_path = state
            .data_dir()
            .join("changed.json")
            .to_string_lossy()
            .into();
        fs::write(&changed.config_path, b"{} ").unwrap();
        register_zip_profile(&state, &changed);
        let error = stop_drained_owned_profiles(
            &state,
            state.data_dir(),
            &associated,
            &expected,
            Some(&mut journal),
        )
        .unwrap_err();
        assert!(error.contains("登记发生变化"));
        assert_eq!(journal.phase, "waitingIdle");
        assert_zip_owner_running(&state, &owner);
        assert_eq!(fs::read(&original).unwrap(), b"original program");
        let reopened = RuntimeState::open(state.data_dir().into()).unwrap();
        let phase: String = reopened
            .database
            .lock()
            .unwrap()
            .query_row(
                "SELECT json_extract(journal,'$.phase') FROM runtime_zip_updates WHERE task_id=?1",
                [&journal.task_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(phase, "cancelled");
        assert_eq!(fs::read(&original).unwrap(), b"original program");
        assert_eq!(
            reopened.registered_profile(&owner.id).unwrap().config_path,
            changed.config_path
        );
        assert_zip_owner_running(&state, &owner);
    }

    #[cfg(windows)]
    #[test]
    fn zip_actual_owner_requires_managed_matching_config_python_endpoint_and_identity() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("app")).unwrap();
        let owner = owned_zip_listener(&state, "owned-current");
        let associated = vec![owner.clone()];
        let mut invalid = vec![];
        let mut profile = owner.clone();
        profile.managed = false;
        invalid.push(Some(profile));
        let mut profile = owner.clone();
        profile.id = "different-id".into();
        invalid.push(Some(profile));
        let mut profile = owner.clone();
        profile.python_path = "different-python".into();
        invalid.push(Some(profile));
        let mut profile = owner.clone();
        profile.base_url = "http://127.0.0.1:1".into();
        invalid.push(Some(profile));
        let mut profile = owner.clone();
        profile.config_path = state
            .data_dir()
            .join("different.json")
            .to_string_lossy()
            .into();
        invalid.push(Some(profile));
        invalid.push(None);
        for actual in invalid {
            state
                .processes
                .lock()
                .unwrap()
                .get_mut(&owner.id)
                .unwrap()
                .profile = actual;
            assert!(owned_update_profiles(&state, state.data_dir(), &associated).is_err());
            assert_zip_owner_running(&state, &owner);
            assert_eq!(fs::read(&owner.config_path).unwrap(), b"{}");
        }
        state
            .processes
            .lock()
            .unwrap()
            .get_mut(&owner.id)
            .unwrap()
            .profile = Some(owner.clone());
        for unknown_pid in [false, true] {
            {
                let mut processes = state.processes.lock().unwrap();
                let process = processes.get_mut(&owner.id).unwrap();
                process.status.owned = unknown_pid;
                process.status.pid = if unknown_pid {
                    None
                } else {
                    Some(process.child.id())
                };
            }
            assert!(owned_update_profiles(&state, state.data_dir(), &associated).is_err());
            assert_zip_owner_running(&state, &owner);
        }
    }

    #[cfg(windows)]
    #[test]
    fn zip_replaced_owned_child_with_unchanged_registration_refuses_final_stop() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("app")).unwrap();
        let owner = owned_zip_listener(&state, "owned-current");
        let associated = vec![owner.clone()];
        let expected = owned_update_profiles(&state, state.data_dir(), &associated).unwrap();
        let mut journal = zip_waiting_journal(&state, &owner);
        state
            .processes
            .lock()
            .unwrap()
            .get_mut(&owner.id)
            .unwrap()
            .stop()
            .unwrap();
        spawn_zip_listener(&state, &owner);
        assert!(stop_drained_owned_profiles(
            &state,
            state.data_dir(),
            &associated,
            &expected,
            Some(&mut journal)
        )
        .unwrap_err()
        .contains("实际受管进程"));
        assert_eq!(journal.phase, "waitingIdle");
        assert_zip_owner_running(&state, &owner);
        assert_eq!(fs::read(&owner.config_path).unwrap(), b"{}");
    }

    #[cfg(windows)]
    #[test]
    fn zip_native_generation_and_image_mismatch_refuse_stop_without_pid_or_handle_change() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("app")).unwrap();
        let owner = owned_zip_listener(&state, "owned-current");
        let associated = vec![owner.clone()];
        let mut journal = zip_waiting_journal(&state, &owner);
        for different_image in [false, true] {
            let mut expected =
                owned_update_profiles(&state, state.data_dir(), &associated).unwrap();
            assert_ne!(expected[0].creation_time, 0);
            assert!(expected[0].image.is_absolute());
            if different_image {
                expected[0].image = temp.path().join("another-generation.exe");
            } else {
                expected[0].creation_time ^= 1;
            }
            assert!(stop_drained_owned_profiles(
                &state,
                state.data_dir(),
                &associated,
                &expected,
                Some(&mut journal)
            )
            .unwrap_err()
            .contains("句柄"));
            assert_eq!(journal.phase, "waitingIdle");
            assert_zip_owner_running(&state, &owner);
        }
    }

    #[cfg(windows)]
    #[test]
    fn zip_foreign_root_engine_consumer_never_authorizes_its_owned_job() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("app")).unwrap();
        let mut owner = owned_zip_listener(&state, "foreign-root");
        let foreign = temp.path().join("another-installation");
        fs::create_dir(&foreign).unwrap();
        owner.install_dir = foreign.to_string_lossy().into();
        register_zip_profile(&state, &owner);
        state
            .processes
            .lock()
            .unwrap()
            .get_mut(&owner.id)
            .unwrap()
            .profile = Some(owner.clone());
        fs::write(
            &owner.config_path,
            serde_json::to_vec(
                &json!({"exe":state.data_dir().join("strata.exe"),"cwd":state.data_dir()}),
            )
            .unwrap(),
        )
        .unwrap();
        let associated = profiles(&state, &dunce::canonicalize(state.data_dir()).unwrap()).unwrap();
        assert!(associated.iter().any(|profile| profile.id == owner.id));
        assert!(owned_update_profiles(&state, state.data_dir(), &associated)
            .err()
            .unwrap()
            .contains("安装根"));
        assert_zip_owner_running(&state, &owner);
        assert!(foreign.is_dir());
    }

    #[cfg(windows)]
    #[test]
    fn zip_changed_actual_identity_and_queued_operation_refuse_final_stop() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("app")).unwrap();
        let owner = owned_zip_listener(&state, "owned-current");
        let associated = vec![owner.clone()];
        let expected = owned_update_profiles(&state, state.data_dir(), &associated).unwrap();
        let mut journal = zip_waiting_journal(&state, &owner);
        {
            let _operation = state.runtime_operations.lock().unwrap();
            assert!(stop_drained_owned_profiles(
                &state,
                state.data_dir(),
                &associated,
                &expected,
                Some(&mut journal)
            )
            .is_err());
        }
        assert_zip_owner_running(&state, &owner);
        assert_eq!(journal.phase, "waitingIdle");
        state
            .processes
            .lock()
            .unwrap()
            .get_mut(&owner.id)
            .unwrap()
            .profile = None;
        assert!(stop_drained_owned_profiles(
            &state,
            state.data_dir(),
            &associated,
            &expected,
            Some(&mut journal)
        )
        .unwrap_err()
        .contains("实际启动身份"));
        assert_eq!(journal.phase, "waitingIdle");
        assert_zip_owner_running(&state, &owner);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn zip_foreign_listener_during_real_drain_refuses_stop_and_reopen_preserves_both() {
        use std::net::{Ipv6Addr, TcpListener};
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("app")).unwrap();
        let owner = owned_zip_listener(&state, "owned-current");
        let associated = vec![owner.clone()];
        let expected = owned_update_profiles(&state, state.data_dir(), &associated).unwrap();
        let directory = state.data_dir().join("analytics");
        fs::create_dir_all(&directory).unwrap();
        let activity = rusqlite::Connection::open(directory.join("journal.sqlite3")).unwrap();
        activity.execute_batch("CREATE TABLE active_requests(request_id TEXT PRIMARY KEY,service_id TEXT NOT NULL,session_id TEXT NOT NULL,started_ms INTEGER NOT NULL);").unwrap();
        activity
            .execute(
                "INSERT INTO active_requests VALUES('pending',?1,'isolated',0)",
                [&owner.id],
            )
            .unwrap();
        let pid = state
            .processes
            .lock()
            .unwrap()
            .get(&owner.id)
            .unwrap()
            .child
            .id();
        fs::write(directory.join(format!("status-{}.json", owner.id)), serde_json::to_vec(&json!({"serviceId":owner.id,"pid":pid,"updatedAtMs":crate::now(),"supported":true,"observerActive":true,"journalWriteFailed":false,"error":null})).unwrap()).unwrap();
        let _gate = maintenance::begin(&state, &owner.id, None, "drain").unwrap();
        let drain_state = state.clone();
        let drain_profile = owner.clone();
        let mut drain =
            tokio::spawn(async move { maintenance::wait_idle(&drain_state, &drain_profile).await });
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut drain)
                .await
                .is_err(),
            "active request must keep drain pending"
        );
        let external = TcpListener::bind((
            Ipv6Addr::LOCALHOST,
            crate::external::local_port(&owner).unwrap(),
        ))
        .unwrap();
        activity
            .execute("DELETE FROM active_requests WHERE request_id='pending'", [])
            .unwrap();
        match tokio::time::timeout(Duration::from_secs(5), &mut drain).await {
            Ok(result) => result.unwrap().unwrap(),
            Err(error) => {
                drain.abort();
                let _ = drain.await;
                panic!("isolated drain did not complete: {error}");
            }
        }
        let mut journal = zip_waiting_journal(&state, &owner);
        assert!(stop_drained_owned_profiles(
            &state,
            state.data_dir(),
            &associated,
            &expected,
            Some(&mut journal)
        )
        .unwrap_err()
        .contains("外部程序"));
        assert_eq!(journal.phase, "waitingIdle");
        assert_zip_owner_running(&state, &owner);
        let reopened = RuntimeState::open(state.data_dir().into()).unwrap();
        let phase: String = reopened
            .database
            .lock()
            .unwrap()
            .query_row(
                "SELECT json_extract(journal,'$.phase') FROM runtime_zip_updates WHERE task_id=?1",
                [&journal.task_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(phase, "cancelled");
        assert_zip_owner_running(&state, &owner);
        assert!(crate::external::listener_ids(&owner)
            .unwrap()
            .contains(&std::process::id()));
        assert_eq!(
            external.local_addr().unwrap().port(),
            crate::external::local_port(&owner).unwrap()
        );
    }

    #[cfg(windows)]
    #[test]
    fn zip_verified_stop_persists_intent_and_preserves_unrelated_owned_job() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("app")).unwrap();
        let owner = owned_zip_listener(&state, "owned-current");
        let unrelated = owned_zip_listener(&state, "unrelated-owned");
        let associated = vec![owner.clone()];
        let expected = owned_update_profiles(&state, state.data_dir(), &associated).unwrap();
        let mut journal = zip_waiting_journal(&state, &owner);
        state
            .tasks
            .lock()
            .unwrap()
            .get_mut(&journal.task_id)
            .unwrap()
            .cancelled = true;
        assert!(stop_drained_owned_profiles(
            &state,
            state.data_dir(),
            &associated,
            &expected,
            Some(&mut journal)
        )
        .is_err());
        assert_eq!(journal.phase, "waitingIdle");
        assert_zip_owner_running(&state, &owner);
        state
            .tasks
            .lock()
            .unwrap()
            .get_mut(&journal.task_id)
            .unwrap()
            .cancelled = false;
        assert!(stop_drained_owned_profiles(
            &state,
            state.data_dir(),
            &associated,
            &expected,
            Some(&mut journal)
        )
        .unwrap()
        .is_none());
        assert_eq!(journal.phase, "replacing");
        assert!(
            !state
                .processes
                .lock()
                .unwrap()
                .get_mut(&owner.id)
                .unwrap()
                .refresh()
                .unwrap()
                .running
        );
        assert_zip_owner_running(&state, &unrelated);
        let phase: String = state
            .database
            .lock()
            .unwrap()
            .query_row(
                "SELECT json_extract(journal,'$.phase') FROM runtime_zip_updates WHERE task_id=?1",
                [&journal.task_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(phase, "replacing");
    }

    #[test]
    fn request_id_reuses_existing_zip_task_and_rejects_changed_confirmation_or_asset() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let root = temp.path().join("runtime");
        fs::create_dir_all(root.join("serve")).unwrap();
        fs::write(root.join("setup.py"), "# not executed").unwrap();
        fs::write(root.join("serve/server.py"), "# not executed").unwrap();
        let root = dunce::canonicalize(root).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let status = TaskStatus {
            id: id.clone(),
            kind: "update".into(),
            state: "running".into(),
            message: "existing isolated task".into(),
            started_at: now(),
            finished_at: None,
        };
        let journal = Journal {
            task_id: id.clone(),
            install_dir: root.clone(),
            phase: "checking".into(),
            new_install: false,
            asset_name: None,
            requested_asset_name: None,
            requested_stop_current_service: false,
            download: RuntimeZipDownloadOptions::default(),
            version: None,
            revision: None,
            changes: vec![],
            running: vec![],
            migrations: vec![],
            error: None,
            updated_at: now(),
        };
        persist(&state, &journal).unwrap();
        state.tasks.lock().unwrap().insert(
            id.clone(),
            processes::TaskRecord {
                status: status.clone(),
                profile_id: None,
                runtime_path: Some(root.clone()),
                cancelled: false,
                process: None,
            },
        );
        state.runtime_upgrading.store(true, Ordering::Release);
        if cfg!(all(windows, target_arch = "x86_64")) {
            let cached = start_release_request(
                state.clone(),
                root.to_string_lossy().into(),
                None,
                Some(id.clone()),
                false,
            )
            .unwrap();
            assert_eq!(cached.id, status.id);
            assert_eq!(cached.message, status.message);
            assert!(start_release_request(
                state.clone(),
                root.to_string_lossy().into(),
                Some("strata-windows-x64-cuda12.zip".into()),
                Some(id.clone()),
                false
            )
            .err()
            .unwrap()
            .contains("不一致"));
            assert!(start_release_request(
                state.clone(),
                root.to_string_lossy().into(),
                None,
                Some(id.clone()),
                true
            )
            .err()
            .unwrap()
            .contains("不一致"));
        } else {
            // A stored Windows request never bypasses the local platform guard.
            for (asset, confirmed) in [
                (None, false),
                (Some("strata-windows-x64-cuda12.zip".into()), false),
                (None, true),
            ] {
                let error = start_release_request(
                    state.clone(),
                    root.to_string_lossy().into(),
                    asset,
                    Some(id.clone()),
                    confirmed,
                )
                .err()
                .expect("unsupported platforms must refuse even a cached ZIP request");
                assert_eq!(
                    error,
                    "官方引擎ZIP自动安装目前支持Windows x64；可使用源码安装方式"
                );
            }
        }
        let unchanged: String = state
            .database
            .lock()
            .unwrap()
            .query_row(
                "SELECT journal FROM runtime_zip_updates WHERE task_id=?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(unchanged, serde_json::to_string(&journal).unwrap());
        assert_eq!(fs::read(root.join("setup.py")).unwrap(), b"# not executed");
        assert_eq!(
            fs::read(root.join("serve/server.py")).unwrap(),
            b"# not executed"
        );
        assert_eq!(state.tasks.lock().unwrap().len(), 1);
        assert!(state.processes.lock().unwrap().is_empty());
        assert!(!state.data_dir().join("zip-updates").exists());
    }

    use std::io::Cursor;
    fn archive(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
        for (name, value) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(value.as_bytes()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }
    #[cfg(all(windows, target_arch = "x86_64"))]
    #[test]
    fn custom_zip_request_remains_idempotent_after_original_archive_moves() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let root = temp.path().join("runtime");
        fs::create_dir_all(root.join("serve")).unwrap();
        fs::write(root.join("setup.py"), "# not executed").unwrap();
        fs::write(root.join("serve/server.py"), "# not executed").unwrap();
        let root = dunce::canonicalize(root).unwrap();
        let archive = temp.path().join("engine.zip");
        fs::write(&archive, "local bytes").unwrap();
        let options = RuntimeZipDownloadOptions {
            local_archive_path: Some(archive.to_string_lossy().into()),
            download_url: None,
        };
        let name = "strata-windows-x64.zip";
        let id = uuid::Uuid::new_v4().to_string();
        let status = TaskStatus {
            id: id.clone(),
            kind: "update".into(),
            state: "running".into(),
            message: "accepted local ZIP".into(),
            started_at: now(),
            finished_at: None,
        };
        let journal: Journal = serde_json::from_value(json!({
            "taskId": id, "installDir": root, "phase": "checking", "newInstall": false,
            "assetName": name, "requestedAssetName": name, "requestedStopCurrentService": false,
            "download": options, "changes": [], "running": [], "error": null, "updatedAt": now()
        }))
        .unwrap();
        persist(&state, &journal).unwrap();
        state.tasks.lock().unwrap().insert(
            id.clone(),
            processes::TaskRecord {
                status: status.clone(),
                profile_id: None,
                runtime_path: Some(root.clone()),
                cancelled: false,
                process: None,
            },
        );
        fs::remove_file(&archive).unwrap();
        let repeated = start_release_request_with_download(
            state.clone(),
            root.to_string_lossy().into(),
            Some(name.into()),
            Some(id.clone()),
            false,
            options,
        )
        .unwrap();
        assert_eq!(repeated.id, status.id);
        assert_eq!(repeated.message, status.message);
        let different = RuntimeZipDownloadOptions {
            local_archive_path: None,
            download_url: Some("https://mirror.example/engine.zip".into()),
        };
        assert!(start_release_request_with_download(
            state.clone(),
            root.to_string_lossy().into(),
            Some(name.into()),
            Some(id),
            false,
            different
        )
        .err()
        .unwrap()
        .contains("不一致"));
        assert_eq!(state.tasks.lock().unwrap().len(), 1);
        assert!(state.processes.lock().unwrap().is_empty());
        assert!(!state.data_dir().join("zip-updates").exists());
        let mut old = serde_json::to_value(&journal).unwrap();
        old.as_object_mut().unwrap().remove("download");
        assert_eq!(
            serde_json::from_value::<Journal>(old).unwrap().download,
            RuntimeZipDownloadOptions::default()
        );
    }

    fn write_zip(root: &Path, name: &str, entries: &[(&str, &str)]) -> PathBuf {
        let path = root.join(name);
        fs::write(&path, archive(entries)).unwrap();
        path
    }
    #[test]
    fn release_zip_rejects_traversal_aliases_case_collisions_and_cancellation() {
        let temp = tempfile::tempdir().unwrap();
        for name in [
            "../escape",
            "/absolute",
            "C:/escape",
            "dir\\escape",
            "CON.txt",
            "serve/../escape",
            "serve/a. ",
        ] {
            assert!(safe_relative(name).is_err(), "{name}");
        }
        let zip = write_zip(
            temp.path(),
            "conflict.zip",
            &[
                ("strata.exe", "a"),
                ("STRATA.EXE", "b"),
                ("BUILD.json", "{}"),
            ],
        );
        assert!(extract(&zip, &temp.path().join("case"), false, || Ok(()))
            .unwrap_err()
            .contains("冲突"));
        let zip = write_zip(
            temp.path(),
            "valid.zip",
            &[("strata.exe", "new"), ("BUILD.json", "{}")],
        );
        assert!(extract(&zip, &temp.path().join("cancel"), false, || Err(
            "cancelled".into()
        ))
        .is_err());
        assert!(!temp.path().join("cancel/strata.exe").exists());
    }
    #[test]
    fn runtime_merge_and_rollback_preserve_models_configs_python_and_unknown_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runtime");
        let work = temp.path().join("work");
        for path in [
            &root,
            &work,
            &work.join("replacement"),
            &work.join("backup"),
        ] {
            fs::create_dir_all(path).unwrap();
        }
        fs::create_dir_all(root.join("serve")).unwrap();
        fs::create_dir_all(root.join("engine")).unwrap();
        fs::create_dir_all(root.join("models")).unwrap();
        fs::create_dir_all(root.join(".venv/Scripts")).unwrap();
        for (name, bytes) in [
            ("serve/server.py", "old-server"),
            ("engine/strata.exe", "old-engine"),
            ("strata-user.json", "config"),
            ("models/model.gguf", "model"),
            (".venv/Scripts/python.exe", "python"),
            ("custom.txt", "custom"),
            ("config.shared-settings.json", "settings"),
        ] {
            fs::write(root.join(name), bytes).unwrap();
        }
        let source = work.join("new-server.py");
        fs::write(&source, "new-server").unwrap();
        let engine = work.join("new-engine.exe");
        fs::write(&engine, "new-engine").unwrap();
        let mut changes = vec![];
        add_change(&root, &work, "serve/server.py", &source, &mut changes).unwrap();
        add_change(&root, &work, "engine/strata.exe", &engine, &mut changes).unwrap();
        apply(&root, &work, &changes, || Ok(())).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("serve/server.py")).unwrap(),
            "new-server"
        );
        for (name, bytes) in [
            ("strata-user.json", "config"),
            ("models/model.gguf", "model"),
            (".venv/Scripts/python.exe", "python"),
            ("custom.txt", "custom"),
            ("config.shared-settings.json", "settings"),
        ] {
            assert_eq!(fs::read_to_string(root.join(name)).unwrap(), bytes);
        }
        rollback_files(&root, &work, &changes).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("serve/server.py")).unwrap(),
            "old-server"
        );
        assert_eq!(
            fs::read_to_string(root.join("engine/strata.exe")).unwrap(),
            "old-engine"
        );
    }
    #[test]
    fn partial_replacement_rolls_back_and_external_edits_are_not_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runtime");
        let work = temp.path().join("work");
        for path in [
            &root,
            &work,
            &work.join("replacement"),
            &work.join("backup"),
        ] {
            fs::create_dir_all(path).unwrap();
        }
        fs::write(root.join("setup.py"), "old").unwrap();
        let source = work.join("new.py");
        fs::write(&source, "new").unwrap();
        let mut changes = vec![];
        add_change(&root, &work, "setup.py", &source, &mut changes).unwrap();
        add_change(&root, &work, "new-module.py", &source, &mut changes).unwrap();
        let count = std::cell::Cell::new(0usize);
        let result = apply(&root, &work, &changes, || {
            count.set(count.get() + 1);
            if count.get() == 2 {
                Err("fixture interrupted".into())
            } else {
                Ok(())
            }
        });
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(root.join("setup.py")).unwrap(), "new");
        rollback_files(&root, &work, &changes).unwrap();
        assert!(!root.join("new-module.py").exists());
        assert_eq!(fs::read_to_string(root.join("setup.py")).unwrap(), "old");
        apply(&root, &work, &changes, || Ok(())).unwrap();
        fs::write(root.join("setup.py"), "user edit").unwrap();
        assert!(rollback_files(&root, &work, &changes).is_err());
        assert_eq!(
            fs::read_to_string(root.join("setup.py")).unwrap(),
            "user edit"
        );
    }
    #[test]
    fn variant_recognizes_self_extracted_engine_cuda12_underscore() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("engine_cuda12")).unwrap();
        fs::write(
            temp.path().join("engine_cuda12/BUILD.json"),
            r#"{"version":"0.1.44.1","backend":"cuda","cuda":"12.9"}"#,
        )
        .unwrap();
        assert!(!temp.path().join("engine").exists());
        assert!(!temp.path().join("engine-cuda12").exists());
        assert_eq!(variant(temp.path()), Some("cuda12"));
        prevent_downgrade(temp.path(), "0.1.44").unwrap_err();
        prevent_downgrade(temp.path(), "0.1.45").unwrap();
    }

    #[test]
    fn newest_asset_selection_preserves_cuda12_and_rejects_backend_switch() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("engine-cuda12")).unwrap();
        fs::write(
            temp.path().join("engine-cuda12/BUILD.json"),
            r#"{"version":"0.1.41","backend":"cuda","cuda":"12.9"}"#,
        )
        .unwrap();
        let mut info=super::super::release_update_info(&json!({"tag_name":"v0.1.42","assets":[{"name":"strata-windows-x64.zip","size":12,"browser_download_url":"https://github.com/Niko1221/Strata/releases/download/v0.1.42/strata-windows-x64.zip","digest":format!("sha256:{}","a".repeat(64))},{"name":"strata-windows-x64-cuda12.zip","size":12,"browser_download_url":"https://github.com/Niko1221/Strata/releases/download/v0.1.42/strata-windows-x64-cuda12.zip","digest":format!("sha256:{}","b".repeat(64))}]})).unwrap();
        assert_eq!(info.installable, cfg!(all(windows, target_arch = "x86_64")));
        assert_eq!(info.latest_version.as_deref(), Some("0.1.42"));
        assert_eq!(info.assets.len(), 2);
        // Metadata discovery and safe CUDA selection remain available on Linux;
        // selecting a Windows asset does not authorize installing it there.
        let selected = choose_asset(&info, temp.path(), None).unwrap();
        assert_eq!(selected.variant, "cuda12");
        assert_eq!(selected.name, "strata-windows-x64-cuda12.zip");
        assert_eq!(selected.sha256, "b".repeat(64));
        assert!(choose_asset(&info, temp.path(), Some("strata-windows-x64.zip")).is_err());
        info.assets.clear();
        assert!(choose_asset(&info, temp.path(), None).is_err());
    }

    #[test]
    fn cuda13_build_without_backend_never_selects_or_accepts_cuda12() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("engine")).unwrap();
        fs::create_dir(temp.path().join("engine-cuda12")).unwrap();
        fs::write(
            temp.path().join("engine/BUILD.json"),
            r#"{"version":"0.1.41","cuda":"13.0","archs":["89"]}"#,
        )
        .unwrap();
        fs::write(
            temp.path().join("engine-cuda12/BUILD.json"),
            r#"{"version":"0.1.41","cuda":"12.9"}"#,
        )
        .unwrap();
        assert_eq!(variant(temp.path()), Some("cuda13"));
        assert_eq!(
            directory_variant(&temp.path().join("engine")),
            Some("cuda13")
        );
        let info=super::super::release_update_info(&json!({"tag_name":"v0.1.42","assets":[{"name":"strata-windows-x64.zip","size":12,"browser_download_url":"https://github.com/Niko1221/Strata/releases/download/v0.1.42/strata-windows-x64.zip","digest":format!("sha256:{}","a".repeat(64))},{"name":"strata-windows-x64-cuda12.zip","size":12,"browser_download_url":"https://github.com/Niko1221/Strata/releases/download/v0.1.42/strata-windows-x64-cuda12.zip","digest":format!("sha256:{}","b".repeat(64))}]})).unwrap();
        assert_eq!(
            choose_asset(&info, temp.path(), None).unwrap().variant,
            "cuda13"
        );
        assert!(choose_asset(&info, temp.path(), Some("strata-windows-x64-cuda12.zip")).is_err());
        assert!(prevent_downgrade(temp.path(), "0.1.40").is_err());
        assert!(prevent_downgrade(temp.path(), "0.1.42").is_ok());
    }
    #[test]
    fn official_source_zip_ignores_models_configs_and_python_environments() {
        let temp = tempfile::tempdir().unwrap();
        let zip = write_zip(
            temp.path(),
            "source.zip",
            &[
                ("Strata-commit/setup.py", "print('setup')"),
                (
                    "Strata-commit/serve/server.py",
                    "from http.server import ThreadingHTTPServer",
                ),
                ("Strata-commit/requirements.txt", "numpy\npillow"),
                ("Strata-commit/CMakeLists.txt", "project(Strata)"),
                ("Strata-commit/strata-user.json", "never overwrite"),
                ("Strata-commit/run-user.bat", "never overwrite"),
                ("Strata-commit/models/model.gguf", "model"),
                ("Strata-commit/.venv/Scripts/python.exe", "python"),
                (
                    "Strata-commit/data/draft_vocab.bin",
                    "official-runtime-data",
                ),
            ],
        );
        let destination = temp.path().join("stage");
        let files = extract(&zip, &destination, true, || Ok(())).unwrap();
        assert!(files.contains(&"data/draft_vocab.bin".into()));
        assert!(destination.join("serve/server.py").is_file());
        for file in [
            "strata-user.json",
            "run-user.bat",
            "models/model.gguf",
            ".venv/Scripts/python.exe",
        ] {
            assert!(!destination.join(file).exists());
        }
    }
    #[test]
    #[ignore = "requires a separately downloaded official source ZIP fixture"]
    fn official_source_zip_fixture_from_environment() {
        let archive = PathBuf::from(
            std::env::var_os("STRATA_MANAGER_SOURCE_ZIP_FIXTURE")
                .expect("set STRATA_MANAGER_SOURCE_ZIP_FIXTURE to an official commit source ZIP"),
        );
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("source");
        let files = extract(&archive, &destination, true, || Ok(())).unwrap();
        let mut zip = zip::ZipArchive::new(File::open(&archive).unwrap()).unwrap();
        let mut runtime_count = 0;
        let mut serve_count = 0;
        let mut web_count = 0;
        for index in 0..zip.len() {
            let mut entry = zip.by_index(index).unwrap();
            if entry.is_dir() {
                continue;
            }
            let relative = entry.name().split_once('/').unwrap().1.to_owned();
            if !source_file(&relative) {
                assert!(!destination.join(&relative).exists(), "{relative}");
                continue;
            }
            runtime_count += 1;
            serve_count += usize::from(relative.starts_with("serve/"));
            web_count += usize::from(relative.starts_with("serve/web/"));
            assert!(files.contains(&relative), "missing source leaf: {relative}");
            let mut original = Vec::new();
            entry.read_to_end(&mut original).unwrap();
            assert_eq!(fs::read(destination.join(&relative)).unwrap(), original);
        }
        assert_eq!(runtime_count, files.len());
        assert!(serve_count > 0);
        for relative in [
            "serve/web/index.html",
            "serve/web/app.js",
            "serve/web/app.css",
            "serve/web/monitor.html",
            "serve/web/monitor.js",
            "serve/web/fonts/outfit-latin-wght.woff2",
        ] {
            assert!(destination.join(relative).is_file(), "{relative}");
        }
        let mut command = Command::new(if cfg!(windows) { "py" } else { "python3" });
        command
            .args(["-I", "-S", "-c", PYTHON_PROBE])
            .arg(&destination)
            .arg("syntax-only");
        processes::hidden(&mut command);
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(verify_observer_source(&destination.join("serve/server.py")).unwrap());
        // Windows line endings represent the same reviewed code. Any other source
        // change leaves the reviewed fast path (structural detection then applies).
        let server_bytes = fs::read_to_string(destination.join("serve/server.py")).unwrap();
        let compatibility_fixture = temp.path().join("server-compatibility.py");
        fs::write(
            &compatibility_fixture,
            server_bytes.replace("\r\n", "\n").replace('\n', "\r\n"),
        )
        .unwrap();
        assert!(verify_observer_source(&compatibility_fixture).unwrap());
        fs::write(
            &compatibility_fixture,
            format!("{server_bytes}\n# unreviewed source change\n"),
        )
        .unwrap();
        assert!(!verify_observer_source(&compatibility_fixture).unwrap());
        println!(
            "Official source archive validated: {} runtime leaves, {} serve leaves, {} web assets; source SHA256={}; server canonical SHA256={}",
            runtime_count, serve_count, web_count,
            installation::file_hash(&archive).unwrap(),
            super::super::canonical_hash(&destination.join("serve/server.py")).unwrap()
        );
    }
    #[test]
    fn reviewed_hashes_come_from_the_shared_compat_file() {
        let hashes = reviewed_observer_hashes();
        // 0.1.44.1, plus every earlier reviewed source.
        assert!(hashes.contains("6c45c639e28a873b854606719d9ce2bb2e0df666f105164e78e2735878b9aa8f"));
        assert!(hashes.contains("2aa0d2060766799be2ea7045dc13ca5bab2cec39ad5c29bc8a54d816ed246e7c"));
        assert!(hashes.len() >= 7 && hashes.iter().all(|h| h.len() == 64));
    }
    #[test]
    fn python_probe_accepts_standard_library_http_server_without_web_frameworks() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("serve")).unwrap();
        let server = temp.path().join("serve/server.py");
        fs::write(&server, "from http.server import ThreadingHTTPServer\n").unwrap();
        let run = || {
            let mut command = Command::new(if cfg!(windows) { "py" } else { "python3" });
            command
                .args(["-I", "-S", "-c", PYTHON_PROBE])
                .arg(temp.path())
                .arg("syntax-only");
            processes::hidden(&mut command);
            command.output().unwrap()
        };
        let output = run();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        fs::write(&server, "def invalid syntax:").unwrap();
        assert!(!run().status.success());
        assert!(!verify_observer_source(&server).unwrap());
    }
    #[test]
    fn cross_root_service_registry_migrates_with_configuration_and_python_preserved_and_recovers() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("app")).unwrap();
        let root = temp.path().join("global");
        let private = temp.path().join("private");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&private).unwrap();
        fs::create_dir(root.join("engine")).unwrap();
        fs::write(root.join("engine/strata.exe"), "fixture-engine").unwrap();
        let config = private.join("managed-config.json");
        fs::write(
            &config,
            serde_json::to_vec(
                &json!({"cwd":root,"exe":root.join("engine/strata.exe"),"unknown":"keep"}),
            )
            .unwrap(),
        )
        .unwrap();
        let old = ServiceProfile {
            id: "zip-cross-root".into(),
            name: "fixture".into(),
            base_url: "http://127.0.0.1:18081".into(),
            install_dir: private.to_string_lossy().into(),
            python_path: private
                .join(".venv/Scripts/python.exe")
                .to_string_lossy()
                .into(),
            config_path: config.to_string_lossy().into(),
            managed: true,
        };
        let bytes = serde_json::to_string(&old).unwrap();
        state
            .database
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO local_installations VALUES(?1,?2,?2,?3)",
                params![old.id, bytes, now() as i64],
            )
            .unwrap();
        assert_eq!(
            profiles(&state, &dunce::canonicalize(&root).unwrap())
                .unwrap()
                .len(),
            1
        );
        let mut target = old.clone();
        target.install_dir = root.to_string_lossy().into();
        let mut j = Journal {
            task_id: uuid::Uuid::new_v4().to_string(),
            install_dir: root,
            phase: "verifying".into(),
            new_install: false,
            asset_name: None,
            requested_asset_name: None,
            requested_stop_current_service: false,
            download: RuntimeZipDownloadOptions::default(),
            version: Some("0.1.42".into()),
            revision: None,
            changes: vec![],
            running: vec![],
            migrations: vec![Migration {
                old: old.clone(),
                new: target.clone(),
                config_sha256: installation::file_hash(&config).unwrap(),
            }],
            error: None,
            updated_at: now(),
        };
        persist(&state, &j).unwrap();
        migrate_registry(&state, &j).unwrap();
        let migrated = state.registered_profile(&old.id).unwrap();
        assert_eq!(migrated.install_dir, target.install_dir);
        assert_eq!(migrated.python_path, old.python_path);
        assert_eq!(migrated.config_path, old.config_path);
        drop(state);
        let reopened = RuntimeState::open(temp.path().join("app")).unwrap();
        assert_eq!(
            reopened.registered_profile(&old.id).unwrap().install_dir,
            old.install_dir
        );
        assert_eq!(storage::read(&old).unwrap()["unknown"], "keep");
        assert!(reopened.processes.lock().unwrap().is_empty());
        j.phase = "completed".into();
    }
    #[test]
    fn interrupted_zip_update_recovers_files_without_starting_a_model() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("app")).unwrap();
        let root = temp.path().join("runtime");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("setup.py"), "old").unwrap();
        let task_id = uuid::Uuid::new_v4().to_string();
        let work = work_dir(&state, &task_id).unwrap();
        for part in ["replacement", "backup"] {
            fs::create_dir(work.join(part)).unwrap();
        }
        let source = work.join("new.py");
        fs::write(&source, "new").unwrap();
        let mut changes = vec![];
        add_change(&root, &work, "setup.py", &source, &mut changes).unwrap();
        let j = Journal {
            task_id,
            install_dir: root.clone(),
            phase: "replacing".into(),
            new_install: false,
            asset_name: None,
            requested_asset_name: None,
            requested_stop_current_service: false,
            download: RuntimeZipDownloadOptions::default(),
            version: Some("0.1.42".into()),
            revision: None,
            changes,
            running: vec![],
            migrations: vec![],
            error: None,
            updated_at: now(),
        };
        persist(&state, &j).unwrap();
        apply(&root, &work, &j.changes, || Ok(())).unwrap();
        drop(state);
        let reopened = RuntimeState::open(temp.path().join("app")).unwrap();
        assert_eq!(fs::read_to_string(root.join("setup.py")).unwrap(), "old");
        assert!(reopened.processes.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn closing_during_replacement_recovers_without_restarting_or_scheduling_model_load() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("app")).unwrap();
        let root = temp.path().join("runtime");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("setup.py"), "old").unwrap();
        let task_id = uuid::Uuid::new_v4().to_string();
        let work = work_dir(&state, &task_id).unwrap();
        for part in ["replacement", "backup"] {
            fs::create_dir(work.join(part)).unwrap();
        }
        let source = work.join("new.py");
        fs::write(&source, "new").unwrap();
        let mut changes = vec![];
        add_change(&root, &work, "setup.py", &source, &mut changes).unwrap();
        add_change(&root, &work, "new-module.py", &source, &mut changes).unwrap();
        let profile = ServiceProfile {
            id: "zip-close-fixture".into(),
            name: "fixture".into(),
            base_url: "http://127.0.0.1:18081".into(),
            install_dir: root.to_string_lossy().into(),
            python_path: "does-not-exist.exe".into(),
            config_path: "does-not-exist.json".into(),
            managed: true,
        };
        let j = Journal {
            task_id,
            install_dir: root.clone(),
            phase: "replacing".into(),
            new_install: false,
            asset_name: None,
            requested_asset_name: None,
            requested_stop_current_service: false,
            download: RuntimeZipDownloadOptions::default(),
            version: Some("0.1.42".into()),
            revision: None,
            changes,
            running: vec![Restart {
                profile: profile.clone(),
                loaded: true,
            }],
            migrations: vec![],
            error: None,
            updated_at: now(),
        };
        persist(&state, &j).unwrap();
        let count = std::cell::Cell::new(0usize);
        let result = apply(&root, &work, &j.changes, || {
            count.set(count.get() + 1);
            if count.get() == 2 {
                state.shutting_down.store(true, Ordering::Release);
                crate::store_set(&state, "localServiceDesired".into(), json!(false)).unwrap();
            }
            if state.shutting_down.load(Ordering::Acquire) {
                Err("window closed".into())
            } else {
                Ok(())
            }
        });
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(root.join("setup.py")).unwrap(), "new");
        assert!(start_lazy_service(state.clone(), profile)
            .await
            .unwrap_err()
            .contains("退出"));
        assert!(state.processes.lock().unwrap().is_empty());
        drop(state);
        let reopened = RuntimeState::open(temp.path().join("app")).unwrap();
        assert_eq!(fs::read_to_string(root.join("setup.py")).unwrap(), "old");
        assert!(!root.join("new-module.py").exists());
        assert_eq!(
            crate::store_get(&reopened, "localServiceDesired".into()).unwrap(),
            json!(false)
        );
        assert!(
            crate::store_get(&reopened, "runtimeUpgradeRecoveryLoad".into())
                .unwrap()
                .is_null()
        );
        reopened.clone().restore_default().await.unwrap();
        assert!(reopened.processes.lock().unwrap().is_empty());
    }
}
