//! Persistent lifecycle handoff, scoped to the installation root shared by profiles.
//! No handoff operation starts/stops a service or changes the global background policy.
use crate::{
    discovery, external, mcp_probe, runtime_upgrade, tuning, types::ServiceProfile, RuntimeState,
};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::atomic::Ordering,
};

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS external_management(install_root TEXT PRIMARY KEY,profile_id TEXT NOT NULL,external INTEGER NOT NULL CHECK(external IN(0,1)),updated_at INTEGER NOT NULL);";
fn root_key(profile: &ServiceProfile) -> Result<String, String> {
    let supplied = Path::new(&profile.install_dir);
    if supplied.as_os_str().is_empty() {
        return Err("安装目录不能为空".into());
    }
    // Resolve relative setup inputs against this process' workspace. For missing
    // paths, canonicalize the nearest existing ancestor before appending the
    // remainder, so aliases and ./.. cannot bypass an installation's ownership.
    if !supplied.is_absolute()
        && supplied
            .components()
            .any(|part| matches!(part, std::path::Component::Prefix(_)))
    {
        return Err("安装目录不能使用不明确的盘符相对路径".into());
    }
    let absolute = if supplied.is_absolute() {
        supplied.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(supplied)
    };
    let root = if let Ok(canonical) = dunce::canonicalize(&absolute) {
        canonical
    } else {
        let mut normalized = PathBuf::new();
        for part in absolute.components() {
            match part {
                std::path::Component::CurDir => (),
                std::path::Component::ParentDir => {
                    normalized.pop();
                }
                other => normalized.push(other.as_os_str()),
            }
        }
        let mut ancestor = normalized.clone();
        let mut suffix = Vec::new();
        loop {
            if let Ok(mut canonical) = dunce::canonicalize(&ancestor) {
                for part in suffix.iter().rev() {
                    canonical.push(part);
                }
                break canonical;
            }
            let name = ancestor
                .file_name()
                .ok_or("无法判定安装目录的绝对位置")?
                .to_owned();
            suffix.push(name);
            if !ancestor.pop() {
                return Err("无法判定安装目录的绝对位置".into());
            }
        }
    };
    let key = root.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        Ok(key.to_lowercase())
    }
    #[cfg(not(windows))]
    {
        Ok(key)
    }
}
fn external_root(state: &RuntimeState, profile: &ServiceProfile) -> Result<Option<String>, String> {
    let root = root_key(profile)?;
    let database = state.database.lock().map_err(|e| e.to_string())?;
    let exists: bool = database.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='external_management')", [], |row| row.get(0)).map_err(|e| e.to_string())?;
    if !exists {
        return Ok(None);
    }
    let external: Option<i64> = database
        .query_row(
            "SELECT external FROM external_management WHERE install_root=?1",
            [&root],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(value) = external {
        return Ok((value == 1).then_some(root));
    }
    // A moved/reused ID must not silently re-enable the old installation. The
    // exact root above always takes precedence; fallback ordering is explicit.
    database.query_row("SELECT install_root FROM external_management WHERE profile_id=?1 AND external=1 ORDER BY updated_at DESC,install_root LIMIT 1", [&profile.id], |r| r.get(0)).optional().map_err(|e| e.to_string())
}
/// Read-only; intentionally does not require registration or acquire operation
/// locks. Lifecycle callers hold runtime_operations across this check and spawn.
pub fn is_profile_external(state: &RuntimeState, profile: &ServiceProfile) -> Result<bool, String> {
    Ok(external_root(state, profile)?.is_some())
}
pub fn assert_profile_manager_owned(
    state: &RuntimeState,
    profile: &ServiceProfile,
) -> Result<(), String> {
    if is_profile_external(state, profile)? {
        Err("该 Strata 安装已交给外部助手管理；请先停止外部服务并显式恢复本应用管理".into())
    } else {
        Ok(())
    }
}
pub fn is_external(state: &RuntimeState, profile_id: &str) -> Result<bool, String> {
    is_profile_external(state, &state.registered_profile(profile_id)?)
}
pub fn assert_manager_owned(state: &RuntimeState, profile_id: &str) -> Result<(), String> {
    assert_profile_manager_owned(state, &state.registered_profile(profile_id)?)
}
fn no_pending_operations(state: &RuntimeState) -> Result<(), String> {
    runtime_upgrade::assert_available(state)?;
    tuning::assert_no_active_tuning(state)?;
    if state.selection_changing.load(Ordering::Acquire) {
        return Err("正在切换模型，请完成后再变更管理归属".into());
    }
    let locks = state
        .ensure_locks
        .try_lock()
        .map_err(|_| "服务启动锁正在变更，请稍后重试")?;
    if locks.values().any(|lock| lock.try_lock().is_err()) {
        return Err("服务正在启动或加载，请完成后再变更管理归属".into());
    }
    if state
        .tasks
        .lock()
        .map_err(|e| e.to_string())?
        .values()
        .any(|task| {
            !matches!(
                task.status.state.as_str(),
                "completed" | "failed" | "cancelled"
            ) || task.status.finished_at.is_none()
                || task.process.is_some()
        })
    {
        return Err("后台有安装或维护任务，请完成或取消后再变更管理归属".into());
    }
    Ok(())
}
fn listener_absent(profile: &ServiceProfile) -> Result<(), String> {
    // Windows queries the real TCP listener table rather than mistaking a
    // connect timeout after close for an active socket. Other platforms keep
    // the existing conservative listener check and propagate uncertainty.
    if external::port_accepting(profile)? {
        Err("服务端口仍有进程监听。请在当前管理者中停止服务后重试；本操作不会自动停止进程".into())
    } else {
        Ok(())
    }
}
fn related_profiles(
    state: &RuntimeState,
    selected: &ServiceProfile,
) -> Result<Vec<ServiceProfile>, String> {
    let key = root_key(selected)?;
    let mut profiles = Vec::new();
    for profile in state.registered_profiles()? {
        if root_key(&profile)? == key {
            profiles.push(profile);
        }
    }
    if !profiles.iter().any(|profile| profile.id == selected.id) {
        profiles.push(selected.clone());
    }
    Ok(profiles)
}
fn stopped_installation(state: &RuntimeState, selected: &ServiceProfile) -> Result<(), String> {
    if discovery::has_running_installation(Path::new(&selected.install_dir))? {
        return Err(
            "此安装仍有 Strata 服务进程，请在当前管理者中停止后重试；本操作不会停止进程".into(),
        );
    }
    if discovery::has_running_management(Path::new(&selected.install_dir))? {
        return Err("此安装的外部 MCP 客户端或安装脚本仍在运行。请断开外部助手的 Strata MCP 连接，并等待安装结束后重试；本操作不会停止进程".into());
    }
    let related = related_profiles(state, selected)?;
    {
        let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
        for profile in &related {
            if processes
                .get_mut(&profile.id)
                .map(|process| process.tree_running())
                .transpose()?
                .unwrap_or(false)
            {
                return Err("本应用仍有此安装的服务进程或子进程，请先显式停止再交接".into());
            }
        }
    }
    for profile in &related {
        listener_absent(profile)?;
    }
    Ok(())
}
pub fn status(state: &RuntimeState, profile_id: &str) -> Result<Value, String> {
    let profile = state.registered_profile(profile_id)?;
    let ownership_root = external_root(state, &profile)?;
    let external = ownership_root.is_some();
    let available = if state.runtime_operations.try_lock().is_err()
        || state.selection_lock.try_lock().is_err()
    {
        Err("后台操作正在运行，请完成后再变更管理归属".into())
    } else {
        no_pending_operations(state)
            .and_then(|_| stopped_ownership_roots(state, &profile, ownership_root.as_deref()))
            .and_then(|_| {
                if external {
                    Ok(())
                } else {
                    mcp_probe::verify_registered_script(&profile)
                }
            })
    };
    Ok(
        json!({"profileId":profile_id,"external":external,"canHandoff":!external&&available.is_ok(),"canResume":external&&available.is_ok(),"reason":available.err(),"scope":"installation","installDir":ownership_root.unwrap_or(profile.install_dir)}),
    )
}
fn stopped_ownership_roots(
    state: &RuntimeState,
    profile: &ServiceProfile,
    ownership_root: Option<&str>,
) -> Result<(), String> {
    stopped_installation(state, profile)?;
    if let Some(root) = ownership_root {
        if root != root_key(profile)? {
            let mut original = profile.clone();
            original.install_dir = root.into();
            stopped_installation(state, &original)?;
        }
    }
    Ok(())
}
pub fn set(state: &RuntimeState, profile_id: &str, external: bool) -> Result<Value, String> {
    let _operation = state
        .runtime_operations
        .try_lock()
        .map_err(|_| "后台操作正在运行，请完成后再变更管理归属")?;
    let _selection = state
        .selection_lock
        .try_lock()
        .map_err(|_| "正在切换模型，请完成后再变更管理归属")?;
    let _files =
        strata_local_ipc::SingleInstance::acquire_scoped(&state.data_dir, "managed-file-operation")
            .map_err(|_| "文件操作正在进行，请完成后再变更管理归属")?;
    let profile = state.registered_profile(profile_id)?;
    let ownership_root = external_root(state, &profile)?;
    let current = ownership_root.is_some();
    if current == external {
        return Ok(json!({"profileId":profile_id,"external":external,"scope":"installation"}));
    }
    no_pending_operations(state)?;
    stopped_ownership_roots(state, &profile, ownership_root.as_deref())?;
    if external {
        mcp_probe::verify_registered_script(&profile)?;
    }
    let mut target = profile.clone();
    if !external {
        if let Some(root) = ownership_root {
            target.install_dir = root;
        }
    }
    persist(state, &target, external)?;
    let remaining = external_root(state, &profile)?.is_some();
    Ok(json!({"profileId":profile_id,"external":remaining,"scope":"installation"}))
}
fn persist(state: &RuntimeState, profile: &ServiceProfile, external: bool) -> Result<(), String> {
    let key = root_key(profile)?;
    let mut db = state.database.lock().map_err(|e| e.to_string())?;
    db.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    let transaction = db.transaction().map_err(|e| e.to_string())?;
    if external {
        transaction.execute("INSERT INTO external_management(install_root,profile_id,external,updated_at) VALUES(?1,?2,1,?3) ON CONFLICT(install_root) DO UPDATE SET profile_id=excluded.profile_id,external=1,updated_at=excluded.updated_at", rusqlite::params![key, profile.id, crate::types::now() as i64]).map_err(|e| e.to_string())?;
    } else {
        transaction
            .execute(
                "DELETE FROM external_management WHERE install_root=?1",
                [key],
            )
            .map_err(|e| e.to_string())?;
    }
    transaction.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};
    fn register(state: &RuntimeState, profile: &ServiceProfile) {
        let value = serde_json::to_string(profile).unwrap();
        state.database.lock().unwrap().execute("INSERT INTO local_installations(id,profile,original_profile,imported_at) VALUES(?1,?2,?2,0)",rusqlite::params![profile.id,value]).unwrap();
    }
    fn profile(root: &Path, id: &str, port: u16) -> ServiceProfile {
        ServiceProfile {
            id: id.into(),
            name: id.into(),
            install_dir: root.to_string_lossy().into(),
            python_path: "unused-python".into(),
            config_path: root.join(format!("{id}.json")).to_string_lossy().into(),
            base_url: format!("http://127.0.0.1:{port}"),
            managed: true,
        }
    }
    #[test]
    fn ownership_persists_and_applies_to_every_profile_in_one_installation() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("state")).unwrap();
        let a = profile(temp.path(), "a", 18941);
        let b = profile(temp.path(), "b", 18942);
        register(&state, &a);
        register(&state, &b);
        persist(&state, &a, true).unwrap();
        assert!(assert_manager_owned(&state, "b").is_err());
        drop(state);
        let reopened = RuntimeState::open(temp.path().join("state")).unwrap();
        assert!(is_external(&reopened, "a").unwrap());
        persist(&reopened, &b, false).unwrap();
        assert!(assert_manager_owned(&reopened, "a").is_ok());
    }
    #[test]
    fn root_identity_blocks_unregistered_aliases_and_preserves_moved_id_ownership() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("state")).unwrap();
        let a = profile(temp.path(), "a", 18951);
        register(&state, &a);
        persist(&state, &a, true).unwrap();
        let alias = profile(
            &temp.path().join("missing").join("..").join("."),
            "unregistered",
            18952,
        );
        assert!(is_profile_external(&state, &alias).unwrap());
        assert!(assert_profile_manager_owned(&state, &alias).is_err());
        let untouched = profile(&temp.path().join("other"), "new-id", 18953);
        assert!(assert_profile_manager_owned(&state, &untouched).is_ok());
        let moved = profile(&temp.path().join("other"), "a", 18954);
        assert!(is_profile_external(&state, &moved).unwrap());
        // Clearing a different root never clears the old installation's flag.
        persist(&state, &moved, false).unwrap();
        assert!(is_profile_external(&state, &a).unwrap());
        persist(&state, &a, false).unwrap();
        assert!(!is_profile_external(&state, &moved).unwrap());
    }
    #[test]
    fn listening_external_service_prevents_resume_and_never_stops_it() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("state")).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let a = profile(temp.path(), "a", listener.local_addr().unwrap().port());
        register(&state, &a);
        persist(&state, &a, true).unwrap();
        assert!(set(&state, "a", false).unwrap_err().contains("监听"));
        assert!(is_external(&state, "a").unwrap());
        assert!(TcpStream::connect(listener.local_addr().unwrap()).is_ok());
        drop(listener);
        assert_eq!(set(&state, "a", false).unwrap()["external"], false);
    }
    #[test]
    fn unregistered_or_busy_handoff_is_rejected_without_mutating_ownership() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("state")).unwrap();
        assert!(set(&state, "missing", true).is_err());
        let a = profile(temp.path(), "a", 18943);
        register(&state, &a);
        let guard = state.runtime_operations.lock().unwrap();
        assert!(set(&state, "a", true).is_err());
        drop(guard);
        let file_guard = strata_local_ipc::SingleInstance::acquire_scoped(
            state.data_dir(),
            "managed-file-operation",
        )
        .unwrap();
        assert!(set(&state, "a", true).unwrap_err().contains("文件操作"));
        assert!(!is_external(&state, "a").unwrap());
        drop(file_guard);
        assert!(!is_external(&state, "a").unwrap());
        assert!(set(&state, "a", true).is_err());
        assert!(!is_external(&state, "a").unwrap());
    }

    #[tokio::test]
    async fn file_management_rpc_checks_incoming_and_registered_targets() {
        let temp = tempfile::tempdir().unwrap();
        let managed_root = temp.path().join("managed");
        let external_root = temp.path().join("external");
        std::fs::create_dir(&managed_root).unwrap();
        std::fs::create_dir(&external_root).unwrap();
        let state = RuntimeState::open(temp.path().join("state")).unwrap();
        let managed = profile(&managed_root, "managed-profile", 18961);
        let external = profile(&external_root, "external-profile", 18962);
        let config = b"{\"port\":18961,\"args\":[]}";
        std::fs::write(&managed.config_path, config).unwrap();
        std::fs::write(&external.config_path, config).unwrap();
        register(&state, &managed);
        register(&state, &external);
        persist(&state, &external, true).unwrap();

        let accepted = state
            .clone()
            .dispatch("assert_profile_management", json!({"profile":managed}))
            .await
            .unwrap();
        assert_eq!(accepted["managed"], true);

        // The file path still matches registration, but its supplied root must
        // not borrow a managed profile's ID to bypass external ownership.
        let mut root_drift = managed.clone();
        root_drift.install_dir = external.install_dir.clone();
        assert!(state
            .clone()
            .dispatch("assert_profile_management", json!({"profile":root_drift}))
            .await
            .unwrap_err()
            .contains("外部助手"));

        // Local Tauri IO would use this supplied file, so registration binding
        // must reject the different target before authorizing that IO.
        let mut file_drift = managed.clone();
        file_drift.config_path = external.config_path.clone();
        assert!(state
            .clone()
            .dispatch("assert_profile_management", json!({"profile":file_drift}))
            .await
            .unwrap_err()
            .contains("PROFILE_CONFIG_CHANGED"));

        let mut alias = external.clone();
        alias.id = "unregistered-external-alias".into();
        alias.install_dir = external_root
            .join("missing")
            .join("..")
            .join(".")
            .to_string_lossy()
            .into_owned();
        assert!(state
            .clone()
            .dispatch("assert_profile_management", json!({"profile":alias}))
            .await
            .unwrap_err()
            .contains("外部助手"));

        assert!(!is_external(&state, &managed.id).unwrap());
        assert!(is_external(&state, &external.id).unwrap());
        assert_eq!(std::fs::read(&managed.config_path).unwrap(), config);
        assert_eq!(std::fs::read(&external.config_path).unwrap(), config);
    }
}
