//! Installed Strata runtimes: inventory, safe deletion, cleanup and switching.
//!
//! Only folders the Manager itself created (direct children of its `runtimes`
//! folders) can be deleted. The runtime in use, a running one, the rollback
//! version, one referenced by a saved configuration (unless that registration
//! is confirmed for removal too) and a switch target are never deleted.
//! Shared data (`Strata-data`), models and packs are never touched.
use super::release_zip;
use crate::{installation, processes, types::*, RuntimeState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc, Mutex, OnceLock},
    time::UNIX_EPOCH,
};

/// Store key: delete old versions after a successful update (default on).
pub const AUTO_CLEANUP_KEY: &str = "runtimeAutoCleanup";
/// Store key: the runtime the user last switched away from (the rollback version).
const PREVIOUS_KEY: &str = "runtimePreviousInstallDir";
/// Store key: { installDir: lastUsedAtMs } recorded when a runtime stops being current.
const LAST_USED_KEY: &str = "runtimeLastUsedAt";
/// Store key: { installDir: python } of runtimes used before, so a version no
/// configuration references any more stays listed and switchable.
const KNOWN_KEY: &str = "runtimeKnownInstallDirs";
const TRASH_PREFIX: &str = ".strata-trash-";
/// Shared data next to Manager runtimes; never a cleanup candidate.
const SHARED_DATA: &str = "Strata-data";
const MODEL_EXTENSIONS: [&str; 4] = ["gguf", "safetensors", "bin", "pt"];

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeReference {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRuntime {
    pub install_dir: String,
    pub python_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_version: Option<String>,
    pub readiness: String,
    /// Created by the Manager in its own runtimes folder; only these can be deleted.
    pub owned: bool,
    /// The runtime of the configuration in use.
    pub current: bool,
    /// A service from this folder is running.
    pub running: bool,
    /// Kept as the version to switch back to.
    pub rollback: bool,
    /// The target of a switch in progress.
    pub switching: bool,
    pub profiles: Vec<RuntimeReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<u64>,
    /// Selected by 一键清理 (keep current + 1).
    pub cleanup: bool,
    /// Why 删除 is unavailable; `None` when it can be deleted (maybe with confirmation).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protected_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLeftover {
    pub path: String,
    /// `partialDownload`, `archive`, `failedInstall`, `trash` or `updateWork`.
    pub kind: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInventory {
    pub runtimes: Vec<InstalledRuntime>,
    pub leftovers: Vec<RuntimeLeftover>,
    pub auto_cleanup: bool,
    /// A runtime task (update, install or switch) is running; deletion waits.
    pub busy: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCleanupResult {
    pub removed: Vec<String>,
    pub skipped: Vec<RuntimeCleanupSkip>,
    pub freed_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCleanupSkip {
    pub path: String,
    pub reason: String,
}

/// Switch targets in progress, by Manager data folder. Cleanup never deletes these.
fn switch_targets() -> &'static Mutex<HashMap<PathBuf, PathBuf>> {
    static TARGETS: OnceLock<Mutex<HashMap<PathBuf, PathBuf>>> = OnceLock::new();
    TARGETS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct SwitchGuard(PathBuf);
impl SwitchGuard {
    fn claim(state: &RuntimeState, target: &Path) -> Result<Self, String> {
        let mut targets = switch_targets().lock().map_err(|e| e.to_string())?;
        if targets.contains_key(state.data_dir()) {
            return Err("已有版本切换任务，请完成后重试".into());
        }
        targets.insert(state.data_dir().to_path_buf(), target.to_path_buf());
        Ok(Self(state.data_dir().to_path_buf()))
    }
}
impl Drop for SwitchGuard {
    fn drop(&mut self) {
        if let Ok(mut targets) = switch_targets().lock() {
            targets.remove(&self.0);
        }
    }
}

fn switching_target(state: &RuntimeState) -> Option<PathBuf> {
    switch_targets()
        .lock()
        .ok()
        .and_then(|targets| targets.get(state.data_dir()).cloned())
}

fn canonical(path: &Path) -> Option<PathBuf> {
    dunce::canonicalize(path).ok()
}

/// The `runtimes` folders the Manager installs into (default and chosen location).
fn owned_roots(state: &RuntimeState) -> Vec<PathBuf> {
    let mut roots = vec![state.data_dir().join("runtimes")];
    if let Ok(Some(custom)) = crate::storage_location::custom_engine_root(state) {
        roots.push(custom.join("runtimes"));
    }
    let mut seen = HashSet::new();
    roots
        .into_iter()
        .filter(|root| !root.is_symlink())
        .filter_map(|root| canonical(&root))
        .filter(|root| seen.insert(root.clone()))
        .collect()
}

fn is_owned(roots: &[PathBuf], dir: &Path) -> bool {
    !dir.is_symlink()
        && dir.file_name().and_then(|n| n.to_str()) != Some(SHARED_DATA)
        && dir
            .parent()
            .is_some_and(|parent| roots.iter().any(|r| r == parent))
}

fn installed_at(root: &Path) -> Option<u64> {
    let meta = fs::metadata(root.join(crate::discovery::RELEASE_MARKER))
        .or_else(|_| fs::metadata(root.join("setup.py")))
        .ok()?;
    let time = meta.created().or_else(|_| meta.modified()).ok()?;
    Some(time.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

fn last_used(state: &RuntimeState) -> HashMap<String, u64> {
    crate::store_get(state, LAST_USED_KEY.into())
        .ok()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

fn known(state: &RuntimeState) -> HashMap<String, String> {
    crate::store_get(state, KNOWN_KEY.into())
        .ok()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

/// Remembers a runtime and the Python its configurations use, before a switch
/// moves those configurations away from it.
pub(super) fn remember(state: &RuntimeState, dir: &Path) {
    let Some(dir) = canonical(dir) else {
        return;
    };
    let python = release_zip::profiles(state, &dir)
        .ok()
        .and_then(|profiles| {
            profiles
                .into_iter()
                .map(|p| p.python_path)
                .find(|p| !p.is_empty())
        })
        .unwrap_or_default();
    let mut map = known(state);
    map.insert(dir.to_string_lossy().into(), python);
    let _ = crate::store_set(state, KNOWN_KEY.into(), json!(map));
}

fn forget(state: &RuntimeState, dir: &Path) {
    let mut map = known(state);
    if map.remove(&*dir.to_string_lossy()).is_some() {
        let _ = crate::store_set(state, KNOWN_KEY.into(), json!(map));
    }
}

fn running_task(state: &RuntimeState) -> Result<bool, String> {
    Ok(state.runtime_upgrading.load(Ordering::Acquire)
        || state
            .tasks
            .lock()
            .map_err(|e| e.to_string())?
            .values()
            .any(|task| task.status.state == "running"))
}

/// Install folders with a live Manager-owned service.
fn running_dirs(state: &RuntimeState) -> Result<HashSet<PathBuf>, String> {
    let mut dirs = HashSet::new();
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
    for process in processes.values_mut() {
        if process.refresh()?.running {
            if let Some(dir) = process
                .profile
                .as_ref()
                .and_then(|p| canonical(Path::new(&p.install_dir)))
            {
                dirs.insert(dir);
            }
        }
    }
    Ok(dirs)
}

fn semver(value: Option<&str>) -> Vec<u32> {
    value
        .unwrap_or_default()
        .trim_start_matches('v')
        .split(|c: char| !c.is_ascii_digit())
        .take(4)
        .map(|part| part.parse().unwrap_or(0))
        .collect()
}

/// Which runtimes 一键清理 removes: keep the current one plus one to switch back
/// to (`previous`, else the newest other ready version). Never selects a
/// non-owned, running, referenced or switching runtime.
pub fn plan_cleanup(runtimes: &mut [InstalledRuntime], previous: Option<&Path>) {
    let previous = previous.and_then(canonical);
    let rollback = runtimes
        .iter()
        .position(|r| {
            !r.current
                && previous.is_some()
                && previous.as_deref() == canonical(Path::new(&r.install_dir)).as_deref()
        })
        .or_else(|| {
            let mut others: Vec<usize> = (0..runtimes.len())
                .filter(|&i| !runtimes[i].current && runtimes[i].readiness == "ready")
                .collect();
            others.sort_by(|&a, &b| {
                let key = |r: &InstalledRuntime| {
                    (
                        semver(r.release_version.as_deref().or(r.engine_version.as_deref())),
                        r.installed_at.unwrap_or(0),
                    )
                };
                key(&runtimes[b]).cmp(&key(&runtimes[a]))
            });
            others.first().copied()
        });
    for (index, runtime) in runtimes.iter_mut().enumerate() {
        runtime.rollback = Some(index) == rollback;
        runtime.protected_reason = if !runtime.owned {
            Some("不是 Manager 安装的目录，不会删除".into())
        } else if runtime.current {
            Some("当前正在使用".into())
        } else if runtime.running {
            Some("服务正在运行".into())
        } else if runtime.switching {
            Some("正在切换到此版本".into())
        } else {
            None
        };
        runtime.cleanup =
            runtime.protected_reason.is_none() && !runtime.rollback && runtime.profiles.is_empty();
    }
}

fn leftovers(state: &RuntimeState, roots: &[PathBuf]) -> Vec<RuntimeLeftover> {
    let mut found = Vec::new();
    let mut push = |path: PathBuf, kind: &str| {
        found.push(RuntimeLeftover {
            path: path.to_string_lossy().into(),
            kind: kind.into(),
        })
    };
    for root in roots {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.take(512).flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_symlink() || !path.is_dir() {
                continue;
            }
            if name.starts_with(TRASH_PREFIX) {
                push(path, "trash");
            } else if name.starts_with("release-")
                && !(path.join("setup.py").is_file() && path.join("serve/server.py").is_file())
            {
                push(path, "failedInstall");
            }
        }
    }
    let downloads = state.data_dir().join("downloads");
    if let Ok(entries) = fs::read_dir(&downloads) {
        for entry in entries.take(512).flatten() {
            let path = entry.path();
            if path.is_symlink() || !path.is_file() {
                continue;
            }
            let partial = path.extension().is_some_and(|ext| ext == "part");
            push(
                path,
                if partial {
                    "partialDownload"
                } else {
                    "archive"
                },
            );
        }
    }
    // Update work folders of updates that ended without changing program files.
    // Completed ones hold the in-place backup and are kept.
    let phases = update_phases(state);
    if let Ok(entries) = fs::read_dir(state.data_dir().join("zu")) {
        for entry in entries.take(512).flatten() {
            let path = entry.path();
            let id = entry.file_name().to_string_lossy().to_string();
            if path.is_symlink() || !path.is_dir() || uuid::Uuid::parse_str(&id).is_err() {
                continue;
            }
            if matches!(
                phases.get(&id).map(String::as_str),
                None | Some("rolledBack" | "cancelled" | "failed")
            ) {
                push(path, "updateWork");
            }
        }
    }
    found
}

fn update_phases(state: &RuntimeState) -> HashMap<String, String> {
    let Ok(db) = state.database.lock() else {
        return HashMap::new();
    };
    let Ok(mut statement) =
        db.prepare("SELECT task_id, json_extract(journal,'$.phase') FROM runtime_zip_updates")
    else {
        return HashMap::new();
    };
    statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map(|rows| {
            rows.flatten()
                .map(|(id, phase)| (id, phase.unwrap_or_default()))
                .collect()
        })
        .unwrap_or_default()
}

pub fn inventory(state: &RuntimeState) -> Result<RuntimeInventory, String> {
    let profiles = state.registered_profiles()?;
    let roots = owned_roots(state);
    let remembered: HashMap<PathBuf, String> = known(state)
        .into_iter()
        .map(|(dir, python)| (PathBuf::from(dir), python))
        .filter(|(dir, _)| dir.is_dir())
        .collect();
    let detected = crate::discovery::discover_runtimes_with_known(
        &profiles,
        state.data_dir(),
        crate::storage_location::custom_engine_root(state)?.map(|root| root.join("runtimes")),
        &remembered,
    );
    let active = crate::store_get(state, "activeLocalInstallation".into())?;
    let current_dir = active
        .as_str()
        .and_then(|id| profiles.iter().find(|p| p.id == id))
        .and_then(|p| canonical(Path::new(&p.install_dir)));
    let running = running_dirs(state)?;
    let switching = switching_target(state);
    let used = last_used(state);
    let mut seen = HashSet::new();
    let mut runtimes = Vec::new();
    for runtime in detected {
        let Some(dir) = canonical(Path::new(&runtime.install_dir)) else {
            continue;
        };
        if !seen.insert(dir.clone()) {
            continue;
        }
        let references = release_zip::profiles(state, &dir)
            .unwrap_or_default()
            .into_iter()
            .map(|p| RuntimeReference {
                id: p.id,
                name: p.name,
            })
            .collect();
        let key = dir.to_string_lossy().to_string();
        runtimes.push(InstalledRuntime {
            python_path: runtime.python_path,
            release_version: runtime.release_version,
            engine_version: runtime.runtime_version,
            readiness: runtime.readiness,
            owned: is_owned(&roots, &dir),
            current: current_dir.as_deref() == Some(&dir),
            running: running.contains(&dir),
            rollback: false,
            switching: switching.as_deref() == Some(&dir),
            profiles: references,
            installed_at: installed_at(&dir),
            last_used_at: used.get(&key).copied(),
            cleanup: false,
            protected_reason: None,
            install_dir: key,
        });
    }
    let previous = crate::store_get(state, PREVIOUS_KEY.into())?;
    plan_cleanup(&mut runtimes, previous.as_str().map(Path::new));
    let busy = running_task(state)?;
    Ok(RuntimeInventory {
        runtimes,
        // Leftovers may belong to the running task; they are listed once it ends.
        leftovers: if busy {
            vec![]
        } else {
            leftovers(state, &roots)
        },
        auto_cleanup: auto_cleanup_enabled(state),
        busy,
    })
}

pub fn auto_cleanup_enabled(state: &RuntimeState) -> bool {
    crate::store_get(state, AUTO_CLEANUP_KEY.into())
        .ok()
        .and_then(|value| value.as_bool())
        .unwrap_or(true)
}

/// Size of a listed runtime or leftover; anything else is refused.
pub async fn size(state: Arc<RuntimeState>, path: String) -> Result<u64, String> {
    let wanted = canonical(Path::new(&path)).ok_or("目录不存在")?;
    let inventory = inventory(&state)?;
    let listed = inventory
        .runtimes
        .iter()
        .map(|r| r.install_dir.as_str())
        .chain(inventory.leftovers.iter().map(|l| l.path.as_str()))
        .any(|p| canonical(Path::new(p)).as_deref() == Some(&wanted));
    if !listed {
        return Err("只能计算已安装版本或可清理项目的大小".into());
    }
    tokio::task::spawn_blocking(move || crate::storage_location::tree_size(&wanted))
        .await
        .map_err(|e| e.to_string())
}

/// Model files directly in the folder or one level down: never delete those.
fn holds_models(root: &Path) -> Option<PathBuf> {
    let mut stack = vec![(root.to_path_buf(), 0)];
    let mut seen = 0;
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen > 20_000 {
                return None;
            }
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if meta.is_dir() && depth < 2 && !name.starts_with('.') && name != "engine" {
                if matches!(name.as_str(), "models" | "packs" | "strata-data") {
                    return Some(path);
                }
                stack.push((path, depth + 1));
            } else if meta.is_file()
                && meta.len() > 64 * 1024 * 1024
                && path
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| MODEL_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
            {
                return Some(path);
            }
        }
    }
    None
}

/// Moves the folder aside in one rename (nothing changes if that fails, e.g. a
/// file is still open on Windows), then removes it. A failed removal leaves a
/// `.strata-trash-*` folder that is listed for cleanup later.
fn trash_and_remove(path: &Path) -> Result<u64, String> {
    let parent = path.parent().ok_or("目录无效")?;
    let trash = parent.join(format!("{TRASH_PREFIX}{}", uuid::Uuid::new_v4()));
    let bytes = crate::storage_location::tree_size(path);
    fs::rename(path, &trash).map_err(|e| {
        format!(
            "无法删除 {}：目录或其中的文件正在被使用（{e}）；未做任何修改，请关闭相关程序后重试",
            path.display()
        )
    })?;
    fs::remove_dir_all(&trash).map_err(|e| {
        format!(
            "{} 已移出，但部分文件未能删除（{e}）；剩余内容会在「清理」中再次列出",
            path.display()
        )
    })?;
    Ok(bytes)
}

/// Checks shared by manual delete and cleanup. `confirmed` are the
/// registrations the user agreed to remove together with the folder.
fn check_deletable(runtime: &InstalledRuntime, confirmed: &[String]) -> Result<(), String> {
    if let Some(reason) = &runtime.protected_reason {
        return Err(format!("未删除：{reason}"));
    }
    let dir = Path::new(&runtime.install_dir);
    if crate::discovery::has_running_installation(dir).unwrap_or(true) {
        return Err("未删除：此版本仍有服务在运行，请先停止".into());
    }
    let mut wanted: Vec<&str> = runtime.profiles.iter().map(|p| p.id.as_str()).collect();
    wanted.sort_unstable();
    let mut given: Vec<&str> = confirmed.iter().map(String::as_str).collect();
    given.sort_unstable();
    given.dedup();
    if wanted != given {
        let names: Vec<&str> = runtime.profiles.iter().map(|p| p.name.as_str()).collect();
        return Err(format!(
            "未删除：此版本仍被配置引用（{}）；请先将这些配置切换到其他版本，或确认一并移除这些配置的登记",
            names.join("、")
        ));
    }
    if let Some(found) = holds_models(dir) {
        return Err(format!(
            "未删除：目录里有模型或共享数据（{}），为避免误删请手动处理",
            found.display()
        ));
    }
    Ok(())
}

fn remove_registrations(state: &RuntimeState, ids: &[String]) -> Result<(), String> {
    let db = state.database.lock().map_err(|e| e.to_string())?;
    for id in ids {
        db.execute("DELETE FROM local_installations WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn find<'a>(inventory: &'a RuntimeInventory, path: &str) -> Option<&'a InstalledRuntime> {
    let wanted = canonical(Path::new(path))?;
    inventory
        .runtimes
        .iter()
        .find(|r| canonical(Path::new(&r.install_dir)).as_deref() == Some(&wanted))
}

fn assert_idle(state: &RuntimeState) -> Result<(), String> {
    if running_task(state)? || switching_target(state).is_some() {
        return Err("有安装、更新或切换任务正在进行，请完成后再删除".into());
    }
    Ok(())
}

/// Deletes one Manager-installed version. Referenced configurations must be
/// listed in `remove_profiles` (their registrations are removed with it).
pub fn delete(
    state: &RuntimeState,
    install_dir: String,
    remove_profiles: Vec<String>,
) -> Result<u64, String> {
    let _operation = state.runtime_operations.lock().map_err(|e| e.to_string())?;
    assert_idle(state)?;
    let inventory = inventory(state)?;
    let runtime = find(&inventory, &install_dir).ok_or("没有找到这个已安装版本，请刷新后重试")?;
    check_deletable(runtime, &remove_profiles)?;
    let freed = trash_and_remove(Path::new(&runtime.install_dir));
    // The folder is gone once the rename succeeded; drop the registrations too.
    if !matches!(&freed, Err(e) if e.starts_with("无法删除")) {
        forget(state, Path::new(&runtime.install_dir));
        remove_registrations(state, &remove_profiles)?;
        installation::invalidate_discovery(state.data_dir());
    }
    freed
}

fn delete_leftover(path: &Path) -> Result<u64, String> {
    if path.is_dir() {
        trash_and_remove(path)
    } else {
        let bytes = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        fs::remove_file(path).map_err(|e| format!("无法删除 {}：{e}", path.display()))?;
        Ok(bytes)
    }
}

/// 一键清理: deletes exactly the confirmed `paths`, each re-checked against
/// the current plan (cleanup runtimes and leftovers); anything else is skipped.
pub fn cleanup(state: &RuntimeState, paths: Vec<String>) -> Result<RuntimeCleanupResult, String> {
    let _operation = state.runtime_operations.lock().map_err(|e| e.to_string())?;
    assert_idle(state)?;
    let inventory = inventory(state)?;
    let mut result = RuntimeCleanupResult::default();
    for path in paths {
        let outcome = if let Some(runtime) = find(&inventory, &path) {
            if runtime.cleanup {
                let removed = check_deletable(runtime, &[])
                    .and_then(|()| trash_and_remove(Path::new(&runtime.install_dir)));
                if removed.is_ok() {
                    forget(state, Path::new(&runtime.install_dir));
                }
                removed
            } else {
                Err(runtime
                    .protected_reason
                    .clone()
                    .unwrap_or_else(|| "保留为可回退版本或被配置引用".into()))
            }
        } else if let Some(leftover) = canonical(Path::new(&path)).and_then(|wanted| {
            inventory
                .leftovers
                .iter()
                .find(|l| canonical(Path::new(&l.path)).as_deref() == Some(&wanted))
        }) {
            delete_leftover(Path::new(&leftover.path))
        } else {
            Err("不在可清理列表中".into())
        };
        match outcome {
            Ok(bytes) => {
                result.freed_bytes += bytes;
                result.removed.push(path);
            }
            Err(reason) => result.skipped.push(RuntimeCleanupSkip { path, reason }),
        }
    }
    installation::invalidate_discovery(state.data_dir());
    Ok(result)
}

/// After a successful update or switch: remembers the version switched away
/// from, and (when enabled) deletes older Manager versions, keeping current + 1.
pub(super) fn after_switch(state: &RuntimeState, task_id: &str, source: &Path) {
    let key = source.to_string_lossy().to_string();
    let mut used = last_used(state);
    used.insert(key.clone(), now());
    let _ = crate::store_set(state, LAST_USED_KEY.into(), json!(used));
    let _ = crate::store_set(state, PREVIOUS_KEY.into(), Value::String(key));
    installation::invalidate_discovery(state.data_dir());
    if !auto_cleanup_enabled(state) {
        return;
    }
    let Ok(inventory) = inventory(state) else {
        return;
    };
    for runtime in inventory.runtimes.iter().filter(|r| r.cleanup) {
        let message = match check_deletable(runtime, &[])
            .and_then(|()| trash_and_remove(Path::new(&runtime.install_dir)))
        {
            Ok(bytes) => {
                forget(state, Path::new(&runtime.install_dir));
                format!(
                    "已自动清理旧版本 {}（释放 {} MB；保留当前版本和一个可回退版本）",
                    runtime.install_dir,
                    bytes / 1024 / 1024
                )
            }
            Err(error) => format!("旧版本 {} 未自动清理：{error}", runtime.install_dir),
        };
        processes::log(&state.logs, task_id, "info", message);
    }
    installation::invalidate_discovery(state.data_dir());
}

/// 切换到此版本: moves every configuration of the runtime in use to an
/// installed version (no download) through the verified switch, which restores
/// the previous runtime if the new one fails its health check. The version
/// switched away from stays installed.
pub fn start_switch(
    state: Arc<RuntimeState>,
    install_dir: String,
    request_id: Option<String>,
) -> Result<TaskStatus, String> {
    let task_id = request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    uuid::Uuid::parse_str(&task_id).map_err(|_| "切换请求标识必须为 UUID")?;
    let operation = state.runtime_operations.lock().map_err(|e| e.to_string())?;
    if let Some(existing) = state.tasks.lock().map_err(|e| e.to_string())?.get(&task_id) {
        return Ok(existing.status.clone());
    }
    let inventory = inventory(&state)?;
    let target = find(&inventory, &install_dir).ok_or("没有找到这个已安装版本，请刷新后重试")?;
    if target.current {
        return Err("已经在使用此版本".into());
    }
    if target.readiness != "ready" || target.python_path.is_empty() {
        return Err("此版本不完整或缺少 Python，不能切换；可重新安装此版本".into());
    }
    let source = inventory
        .runtimes
        .iter()
        .find(|r| r.current)
        .ok_or("还没有正在使用的配置，无需切换；启动配置时会使用所选版本")?;
    if state.shutting_down.load(Ordering::Acquire)
        || state.selection_changing.load(Ordering::Acquire)
    {
        return Err("正在退出或切换模型，请稍后重试".into());
    }
    crate::tuning::assert_no_active_tuning(&state)?;
    let source = PathBuf::from(&source.install_dir);
    remember(&state, &source);
    let target_root = PathBuf::from(&target.install_dir);
    let label = target
        .release_version
        .clone()
        .or_else(|| target.engine_version.clone())
        .unwrap_or_default();
    let switch = super::runtime_switch::SwitchTarget {
        root: target_root.clone(),
        python: target.python_path.clone(),
    };
    let mut tasks = state.tasks.lock().map_err(|e| e.to_string())?;
    if tasks.values().any(|t| t.status.state == "running") {
        return Err("已有模型准备、安装或更新任务，请完成后重试".into());
    }
    let guard = SwitchGuard::claim(&state, &target_root)?;
    state
        .runtime_upgrading
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "已有运行环境更新任务")?;
    let flag = super::UpgradeFlag(state.clone());
    let status = TaskStatus {
        id: task_id,
        kind: "update".into(),
        state: "running".into(),
        message: format!("正在切换到已安装的 v{label}（无需下载）；切换失败会自动恢复当前版本"),
        started_at: now(),
        finished_at: None,
    };
    processes::admit_task_logs(&mut tasks, &state.logs, &status.id)?;
    tasks.insert(
        status.id.clone(),
        processes::TaskRecord {
            status: status.clone(),
            profile_id: None,
            runtime_path: Some(target_root),
            cancelled: false,
            process: None,
        },
    );
    if let Err(error) = processes::persist_task(
        &state.database,
        tasks.get(&status.id).ok_or("切换任务不存在")?,
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
    drop(tasks);
    drop(operation);
    let id = status.id.clone();
    tokio::spawn(async move {
        let result =
            super::runtime_switch::switch_profiles(state.clone(), &id, &source, &switch).await;
        drop(guard);
        let result = match result {
            Ok(summary) => {
                after_switch(&state, &id, &source);
                Ok(format!(
                    "已切换到 v{label}（{summary}）；原版本 {} 保留，可随时切换回去",
                    source.display()
                ))
            }
            Err(error) => Err(format!("切换未完成，已恢复原版本：{error}")),
        };
        drop(flag);
        finish(&state, &id, result);
    });
    Ok(status)
}

fn finish(state: &RuntimeState, id: &str, result: Result<String, String>) {
    let Ok(mut tasks) = state.tasks.lock() else {
        return;
    };
    let Some(task) = tasks.get_mut(id) else {
        return;
    };
    task.status.finished_at = Some(now());
    task.status.state = if result.is_ok() {
        "completed"
    } else {
        "failed"
    }
    .into();
    task.status.message = match result {
        Ok(message) | Err(message) => message,
    };
    processes::log(&state.logs, id, &task.status.state, &task.status.message);
    let _ = processes::persist_task(&state.database, task);
    let _ = processes::persist_task_logs(&state.database, &state.logs, id);
    installation::invalidate_discovery(state.data_dir());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime(dir: &str, release: &str) -> InstalledRuntime {
        InstalledRuntime {
            install_dir: dir.into(),
            release_version: Some(release.into()),
            readiness: "ready".into(),
            owned: true,
            ..Default::default()
        }
    }

    #[test]
    fn cleanup_keeps_current_and_the_newest_other_version() {
        let mut list = vec![
            runtime("/m/a", "0.2.0"),
            runtime("/m/b", "0.2.3"),
            runtime("/m/c", "0.2.2"),
            runtime("/m/d", "0.1.44"),
        ];
        list[1].current = true;
        plan_cleanup(&mut list, None);
        let picked: Vec<_> = list
            .iter()
            .filter(|r| r.cleanup)
            .map(|r| &r.install_dir[..])
            .collect();
        assert_eq!(picked, ["/m/a", "/m/d"]);
        assert!(list[2].rollback);
        assert!(!list[1].cleanup && list[1].protected_reason.is_some());
    }

    #[test]
    fn cleanup_never_selects_foreign_running_referenced_or_switching_versions() {
        let mut list = vec![
            runtime("/m/current", "0.2.3"),
            runtime("/m/rollback", "0.2.2"),
            runtime("/user/strata", "0.2.0"),
            runtime("/m/running", "0.1.9"),
            runtime("/m/referenced", "0.1.8"),
            runtime("/m/switching", "0.1.7"),
            runtime("/m/old", "0.1.6"),
        ];
        list[0].current = true;
        list[2].owned = false;
        list[3].running = true;
        list[4].profiles = vec![RuntimeReference {
            id: "p".into(),
            name: "配置".into(),
        }];
        list[5].switching = true;
        plan_cleanup(&mut list, None);
        let picked: Vec<_> = list
            .iter()
            .filter(|r| r.cleanup)
            .map(|r| &r.install_dir[..])
            .collect();
        assert_eq!(picked, ["/m/old"]);
        assert!(list[1].rollback);
        assert_eq!(
            list[2].protected_reason.as_deref(),
            Some("不是 Manager 安装的目录，不会删除")
        );
        assert!(
            list[4].protected_reason.is_none(),
            "deletable after confirming the configuration"
        );
    }

    #[test]
    fn the_version_switched_away_from_is_the_rollback_even_if_older() {
        let temp = tempfile::tempdir().unwrap();
        let old = temp.path().join("old");
        fs::create_dir(&old).unwrap();
        let mut list = vec![
            runtime(&temp.path().join("new").to_string_lossy(), "0.2.3"),
            runtime("/m/newer-other", "0.2.2"),
            runtime(&old.to_string_lossy(), "0.2.0"),
        ];
        list[0].current = true;
        plan_cleanup(&mut list, Some(&old));
        assert!(list[2].rollback && !list[2].cleanup);
        assert!(list[1].cleanup);
    }

    fn install(root: &Path, release: &str) {
        fs::create_dir_all(root.join("serve")).unwrap();
        fs::write(root.join("setup.py"), "#").unwrap();
        fs::write(root.join("serve/server.py"), "#").unwrap();
        fs::write(
            root.join(crate::discovery::RELEASE_MARKER),
            json!({"version": release}).to_string(),
        )
        .unwrap();
    }

    fn register(state: &RuntimeState, id: &str, dir: &Path) {
        let profile = ServiceProfile {
            id: id.into(),
            name: format!("配置 {id}"),
            base_url: "http://127.0.0.1:1".into(),
            install_dir: dir.to_string_lossy().into(),
            python_path: String::new(),
            config_path: dir.join("c.json").to_string_lossy().into(),
            managed: true,
        };
        let text = serde_json::to_string(&profile).unwrap();
        state
            .database
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO local_installations VALUES(?1,?2,?3,?4)",
                rusqlite::params![id, text, text, now() as i64],
            )
            .unwrap();
    }

    fn entry(state: &RuntimeState, dir: &Path) -> InstalledRuntime {
        let dir = canonical(dir).unwrap();
        inventory(state)
            .unwrap()
            .runtimes
            .into_iter()
            .find(|r| Path::new(&r.install_dir) == dir)
            .unwrap()
    }

    #[test]
    fn only_manager_folders_are_owned_and_shared_data_is_never_listed() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let runtimes = installation::owned_directory(state.data_dir(), &["runtimes"]).unwrap();
        let roots = owned_roots(&state);
        assert!(is_owned(&roots, &runtimes.join("release-a")));
        assert!(!is_owned(&roots, &runtimes.join(SHARED_DATA)));
        assert!(!is_owned(&roots, &temp.path().join("user/strata")));
        assert!(!is_owned(&roots, &runtimes.join("release-a/nested")));
        fs::create_dir_all(runtimes.join(SHARED_DATA).join("models")).unwrap();
        fs::create_dir_all(runtimes.join("release-broken")).unwrap();
        fs::create_dir_all(runtimes.join(".strata-trash-x")).unwrap();
        let kinds: Vec<_> = leftovers(&state, &roots)
            .into_iter()
            .map(|l| {
                (
                    Path::new(&l.path)
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .to_string(),
                    l.kind,
                )
            })
            .collect();
        assert!(kinds.contains(&("release-broken".into(), "failedInstall".into())));
        assert!(kinds.contains(&(".strata-trash-x".into(), "trash".into())));
        assert!(!kinds.iter().any(|(name, _)| name == SHARED_DATA));
    }

    #[test]
    fn delete_refuses_foreign_current_referenced_and_model_folders() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let runtimes = installation::owned_directory(state.data_dir(), &["runtimes"]).unwrap();
        let user = temp.path().join("user-strata");
        install(&user, "0.2.0");
        let current = runtimes.join("release-current");
        install(&current, "0.2.3");
        let referenced = runtimes.join("release-referenced");
        install(&referenced, "0.2.1");
        let models = runtimes.join("release-models");
        install(&models, "0.1.9");
        fs::create_dir_all(models.join("models")).unwrap();
        register(&state, "cur", &current);
        register(&state, "ref", &referenced);
        register(&state, "user", &user);
        crate::store_set(&state, "activeLocalInstallation".into(), json!("cur")).unwrap();

        let dir = |p: &Path| canonical(p).unwrap().to_string_lossy().to_string();
        let error = delete(&state, dir(&user), vec!["user".into()]).unwrap_err();
        assert!(error.contains("不是 Manager 安装"), "{error}");
        assert!(user.is_dir());
        let error = delete(&state, dir(&current), vec!["cur".into()]).unwrap_err();
        assert!(error.contains("当前正在使用"), "{error}");
        let error = delete(&state, dir(&referenced), vec![]).unwrap_err();
        assert!(error.contains("配置 ref"), "{error}");
        assert!(referenced.is_dir());
        let error = delete(&state, dir(&models), vec![]).unwrap_err();
        assert!(error.contains("模型或共享数据"), "{error}");
        assert!(models.is_dir());

        delete(&state, dir(&referenced), vec!["ref".into()]).unwrap();
        assert!(!referenced.exists());
        assert!(state
            .registered_profiles()
            .unwrap()
            .iter()
            .all(|p| p.id != "ref"));
        assert!(user.is_dir() && current.is_dir());
    }

    #[test]
    fn delete_and_cleanup_wait_for_running_tasks_and_switches() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let runtimes = installation::owned_directory(state.data_dir(), &["runtimes"]).unwrap();
        let old = runtimes.join("release-old");
        install(&old, "0.1.9");
        let old = canonical(&old).unwrap();
        let guard = SwitchGuard::claim(&state, &old).unwrap();
        assert!(entry(&state, &old).switching);
        assert!(!entry(&state, &old).cleanup);
        let error = delete(&state, old.to_string_lossy().into(), vec![]).unwrap_err();
        assert!(error.contains("切换任务"), "{error}");
        drop(guard);
        state.runtime_upgrading.store(true, Ordering::Release);
        let error = cleanup(&state, vec![old.to_string_lossy().into()]).unwrap_err();
        assert!(error.contains("请完成后再删除"), "{error}");
        state.runtime_upgrading.store(false, Ordering::Release);
        assert!(old.is_dir());
    }

    #[test]
    fn cleanup_deletes_only_confirmed_planned_items() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let runtimes = installation::owned_directory(state.data_dir(), &["runtimes"]).unwrap();
        let current = runtimes.join("release-current");
        install(&current, "0.2.3");
        let rollback = runtimes.join("release-rollback");
        install(&rollback, "0.2.2");
        let old = runtimes.join("release-old");
        install(&old, "0.2.0");
        fs::write(old.join("big.bin"), vec![0u8; 4096]).unwrap();
        register(&state, "cur", &current);
        crate::store_set(&state, "activeLocalInstallation".into(), json!("cur")).unwrap();
        let downloads = installation::owned_directory(state.data_dir(), &["downloads"]).unwrap();
        fs::write(downloads.join("abc.part"), "partial").unwrap();

        let listed = inventory(&state).unwrap();
        assert!(entry(&state, &rollback).rollback);
        let planned: Vec<String> = listed
            .runtimes
            .iter()
            .filter(|r| r.cleanup)
            .map(|r| r.install_dir.clone())
            .chain(listed.leftovers.iter().map(|l| l.path.clone()))
            .collect();
        assert_eq!(planned.len(), 2, "{planned:?}");
        let mut asked = planned.clone();
        asked.push(canonical(&rollback).unwrap().to_string_lossy().into());
        let result = cleanup(&state, asked).unwrap();
        assert_eq!(result.removed, planned);
        assert_eq!(result.skipped.len(), 1);
        assert!(result.freed_bytes >= 4096);
        assert!(!old.exists() && !downloads.join("abc.part").exists());
        assert!(current.is_dir() && rollback.is_dir());
    }

    #[test]
    fn a_folder_in_use_is_left_unchanged() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("gone");
        let error = trash_and_remove(&missing).unwrap_err();
        assert!(error.contains("未做任何修改"), "{error}");
    }
}
