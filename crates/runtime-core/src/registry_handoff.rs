//! Restore only the registration and selection held by a stopped supervisor.
//! Files and credentials stay in place; this path never prepares or starts a model.
use crate::{external, http, types::ServiceProfile, RuntimeState};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::atomic::Ordering,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrySnapshot {
    profiles: Vec<ServiceProfile>,
    originals: Option<Vec<ServiceProfile>>,
    active_local_installation: Value,
    active_profile: Value,
    local_service_desired: Value,
}

pub(super) fn allowed_while_deferred(method: &str, params: &Value) -> bool {
    matches!(
        method,
        "hello"
            | "supervisor_status"
            | "service_status"
            | "store_get"
            | "store_set"
            | "local_installations"
            | "local_installation_details"
            | "local_runtime_installation"
            | "discover_local"
            | "read_logs"
            | "list_tasks"
            | "list_setup_handoffs"
            | "read_config"
            | "list_local_models"
            | "has_api_key"
            | "environment_info"
            | "get_background_policy"
            | "runtime_upgrade_status"
            | "tuning_status"
            | "request_capture_status"
            | "restore_local_registry"
            | "resume_supervisor"
    ) || (method == "strata_request" && params.get("method").and_then(Value::as_str) == Some("GET"))
}

fn validate_profile(profile: &ServiceProfile, primary: bool) -> Result<(), String> {
    if profile.id.is_empty()
        || profile.id.len() > 80
        || !profile
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || profile.name.trim().is_empty()
        || profile.name.chars().count() > 100
        || (primary && !profile.managed)
    {
        return Err("交接档案标识、名称或本机管理状态无效".into());
    }
    http::endpoint(profile, "/health")?;
    let root = Path::new(&profile.install_dir);
    let python = Path::new(&profile.python_path);
    if !root.is_absolute() || !root.is_dir() || !python.is_absolute() || !python.is_file() {
        return Err("交接运行环境与 Python 必须是已有的绝对路径".into());
    }
    // Re-read only the JSON envelope. Missing weights do not justify changing
    // the model identifier or copying a replacement configuration.
    if !crate::storage::read(profile)?.is_object() {
        return Err("交接配置必须为已有 JSON 对象".into());
    }
    Ok(())
}

fn assert_idle(state: &RuntimeState) -> Result<(), String> {
    crate::runtime_upgrade::assert_available(state)?;
    crate::tuning::assert_available(state)?;
    if state.shutting_down.load(Ordering::Acquire) {
        return Err("后台正在退出，未交接模型登记".into());
    }
    if state
        .tasks
        .lock()
        .map_err(|e| e.to_string())?
        .values()
        .any(|record| record.status.state == "running")
    {
        return Err("后台仍有运行任务，未交接模型登记".into());
    }
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
    for process in processes.values_mut() {
        if process.refresh()?.running {
            return Err("后台仍有运行服务，未交接模型登记".into());
        }
    }
    Ok(())
}

fn validate_selection(value: &Value, key: &str, ids: &HashSet<String>) -> Result<(), String> {
    if value.is_null()
        || value
            .as_str()
            .is_some_and(|id| id.is_empty() || ids.contains(id))
    {
        Ok(())
    } else {
        Err(format!("交接 {key} 没有对应的已登记档案"))
    }
}

pub(super) async fn restore(
    state: &std::sync::Arc<RuntimeState>,
    params: Value,
) -> Result<Value, String> {
    let snapshot: RegistrySnapshot =
        serde_json::from_value(params).map_err(|e| format!("登记快照无效: {e}"))?;
    if snapshot.profiles.len() > 256
        || snapshot
            .originals
            .as_ref()
            .is_some_and(|items| items.len() > 256)
    {
        return Err("登记快照最多包含 256 个档案".into());
    }
    if !snapshot.local_service_desired.is_null() && !snapshot.local_service_desired.is_boolean() {
        return Err("交接 localServiceDesired 必须为布尔值或空值".into());
    }
    let _selection = state.selection_lock.lock().await;
    let _operation = state.runtime_operations.lock().map_err(|e| e.to_string())?;
    assert_idle(state)?;
    let mut ids = HashSet::new();
    for profile in &snapshot.profiles {
        validate_profile(profile, true)?;
        if !ids.insert(profile.id.clone()) {
            return Err("登记快照包含重复档案标识".into());
        }
    }
    let mut originals = HashMap::new();
    for original in snapshot.originals.unwrap_or_default() {
        validate_profile(&original, false)?;
        if !ids.contains(&original.id) || originals.insert(original.id.clone(), original).is_some()
        {
            return Err("原配置快照与登记档案不一致或重复".into());
        }
    }
    let existing = state.registered_profiles()?;
    for profile in existing.iter().chain(snapshot.profiles.iter()) {
        // An already listening external service must be re-detected, never
        // silently authorized by a metadata-only registry transfer.
        if external::port_accepting(profile)? {
            return Err("模型端口仍在运行，未交接模型登记".into());
        }
        ids.insert(profile.id.clone());
    }
    validate_selection(
        &snapshot.active_local_installation,
        "activeLocalInstallation",
        &ids,
    )?;
    validate_selection(&snapshot.active_profile, "activeProfile", &ids)?;
    let mut database = state.database.lock().map_err(|e| e.to_string())?;
    let transaction = database.transaction().map_err(|e| e.to_string())?;
    for profile in &snapshot.profiles {
        let incoming = serde_json::to_value(profile).map_err(|e| e.to_string())?;
        let existing: Option<(String, String)> = transaction
            .query_row(
                "SELECT profile,original_profile FROM local_installations WHERE id=?1",
                [&profile.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some((registered, original)) = existing {
            if serde_json::from_str::<Value>(&registered).map_err(|e| e.to_string())? != incoming
                || originals.get(&profile.id).is_some_and(|p| {
                    serde_json::to_value(p).ok() != serde_json::from_str::<Value>(&original).ok()
                })
            {
                return Err(format!(
                    "档案 {} 已被不同配置占用，未覆盖已有登记",
                    profile.id
                ));
            }
        } else {
            let original = originals.get(&profile.id).unwrap_or(profile);
            transaction.execute(
                "INSERT INTO local_installations(id,profile,original_profile,imported_at) VALUES(?1,?2,?3,?4)",
                params![profile.id, incoming.to_string(), serde_json::to_string(original).map_err(|e| e.to_string())?, crate::types::now() as i64],
            ).map_err(|e| e.to_string())?;
        }
    }
    for (key, value) in [
        (
            "activeLocalInstallation",
            &snapshot.active_local_installation,
        ),
        ("activeProfile", &snapshot.active_profile),
        ("localServiceDesired", &snapshot.local_service_desired),
    ] {
        transaction
            .execute(
                "INSERT OR REPLACE INTO kv(key,value) VALUES(?1,?2)",
                params![key, value.to_string()],
            )
            .map_err(|e| e.to_string())?;
    }
    transaction.commit().map_err(|e| e.to_string())?;
    drop(database);
    Ok(
        json!({"profiles":state.registered_profiles()?,"originals":state.original_profiles()?,
        "activeLocalInstallation":snapshot.active_local_installation,"activeProfile":snapshot.active_profile,
        "localServiceDesired":snapshot.local_service_desired,"recoveryDeferred":state.recovery_is_deferred()}),
    )
}

pub(super) async fn resume(state: &std::sync::Arc<RuntimeState>) -> Result<Value, String> {
    let _selection = state.selection_lock.lock().await;
    if state.recovery_is_deferred() {
        {
            let _operation = state.runtime_operations.lock().map_err(|e| e.to_string())?;
            assert_idle(state)?;
        }
        // Startup recovery may acquire runtime_operations while resolving an
        // old setup handoff. The deferred RPC gate still blocks service changes.
        state.finish_startup_recovery()?;
        state.recovery_deferred.store(false, Ordering::Release);
        state.recovery_resumed.notify_waiters();
    }
    Ok(json!({"resumed":true,"recoveryDeferred":false}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store;
    use std::{fs, net::TcpListener, sync::Arc};

    fn fixture() -> (
        tempfile::TempDir,
        Arc<RuntimeState>,
        ServiceProfile,
        ServiceProfile,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Strata");
        fs::create_dir(&root).unwrap();
        let python = root.join("python-fixture");
        fs::write(&python, "unused").unwrap();
        let managed = root.join("private-config.json");
        let original = root.join("strata-context-131072.json");
        fs::write(
            &managed,
            r#"{"model_name":"old-model","args":"--ctx-size 131072"}"#,
        )
        .unwrap();
        fs::write(
            &original,
            r#"{"model_name":"old-model","args":"--ctx-size 131072","log":"original.log"}"#,
        )
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let profile = ServiceProfile {
            id: "legacy-id-keep".into(),
            name: "existing model".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            install_dir: root.to_string_lossy().into(),
            python_path: python.to_string_lossy().into(),
            config_path: managed.to_string_lossy().into(),
            managed: true,
        };
        let mut source = profile.clone();
        source.config_path = original.to_string_lossy().into();
        let state = RuntimeState::open_deferred(temp.path().join("data")).unwrap();
        (temp, state, profile, source)
    }
    fn snapshot(profile: &ServiceProfile, source: &ServiceProfile) -> Value {
        json!({"profiles":[profile],"originals":[source],"activeLocalInstallation":profile.id,
            "activeProfile":profile.id,"localServiceDesired":false})
    }
    #[tokio::test]
    async fn preserves_identifiers_paths_originals_and_stopped_selection() {
        let (_temp, state, profile, source) = fixture();
        let current_bytes = fs::read(&profile.config_path).unwrap();
        let source_bytes = fs::read(&source.config_path).unwrap();
        let result = state
            .clone()
            .dispatch("restore_local_registry", snapshot(&profile, &source))
            .await
            .unwrap();
        assert_eq!(result["profiles"][0]["id"], profile.id);
        assert_eq!(result["profiles"][0]["configPath"], profile.config_path);
        assert_eq!(result["originals"][0]["configPath"], source.config_path);
        assert_eq!(result["localServiceDesired"], false);
        // Repeating the handshake is idempotent and does not prepare a new copy.
        state
            .clone()
            .dispatch("restore_local_registry", snapshot(&profile, &source))
            .await
            .unwrap();
        assert_eq!(state.registered_profiles().unwrap().len(), 1);
        assert_eq!(fs::read(&profile.config_path).unwrap(), current_bytes);
        assert_eq!(fs::read(&source.config_path).unwrap(), source_bytes);
        assert!(!state.data_dir.join("imports").exists());
        assert!(state.processes.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn conflict_rolls_back_every_profile_and_all_selection_values() {
        let (_temp, state, profile, source) = fixture();
        state
            .clone()
            .dispatch("restore_local_registry", snapshot(&profile, &source))
            .await
            .unwrap();
        let mut conflict = profile.clone();
        conflict.name = "conflicting replacement".into();
        let mut other = profile.clone();
        other.id = "must-not-appear".into();
        let request = json!({"profiles":[other,conflict],"activeLocalInstallation":"must-not-appear",
            "activeProfile":"must-not-appear","localServiceDesired":true});
        assert!(state
            .clone()
            .dispatch("restore_local_registry", request)
            .await
            .unwrap_err()
            .contains("未覆盖"));
        assert_eq!(state.registered_profiles().unwrap().len(), 1);
        assert_eq!(state.registered_profiles().unwrap()[0].name, profile.name);
        let db = state.database.lock().unwrap();
        assert_eq!(
            store::get(&db, "activeLocalInstallation").unwrap(),
            profile.id
        );
        assert_eq!(store::get(&db, "localServiceDesired").unwrap(), false);
    }
    #[tokio::test]
    async fn deferred_recovery_and_mutations_cannot_start_default_service() {
        let (_temp, state, profile, source) = fixture();
        let mut request = snapshot(&profile, &source);
        request["localServiceDesired"] = json!(true);
        state
            .clone()
            .dispatch("restore_local_registry", request)
            .await
            .unwrap();
        state.clone().restore_default().await.unwrap();
        state.clone().recover_tick().await.unwrap();
        assert!(state.processes.lock().unwrap().is_empty());
        let error = state
            .clone()
            .dispatch("ensure_local_service", json!({"profileId":profile.id}))
            .await
            .unwrap_err();
        assert!(error.contains("交接"));
        assert!(!state.data_dir.join("observer-v1").exists());
        // Resume with the desired-stopped state does not itself spawn a model.
        state
            .clone()
            .dispatch(
                "store_set",
                json!({"key":"localServiceDesired","value":false}),
            )
            .await
            .unwrap();
        state
            .clone()
            .dispatch("resume_supervisor", json!({}))
            .await
            .unwrap();
        state.wait_for_recovery_resume().await;
        assert!(!state.recovery_is_deferred());
        state.clone().restore_default().await.unwrap();
        assert!(state.processes.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn listening_service_and_upgrade_flag_reject_snapshot() {
        let (_temp, state, mut profile, mut source) = fixture();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        profile.base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        source.base_url = profile.base_url.clone();
        assert!(state
            .clone()
            .dispatch("restore_local_registry", snapshot(&profile, &source))
            .await
            .unwrap_err()
            .contains("端口"));
        drop(listener);
        state.runtime_upgrading.store(true, Ordering::Release);
        assert!(state
            .clone()
            .dispatch("restore_local_registry", snapshot(&profile, &source))
            .await
            .is_err());
        assert!(state.registered_profiles().unwrap().is_empty());
    }
    #[tokio::test]
    async fn running_task_rejects_handoff_and_resume_without_mutation() {
        let (_temp, state, profile, source) = fixture();
        state.tasks.lock().unwrap().insert(
            "active-task".into(),
            crate::processes::TaskRecord {
                status: crate::types::TaskStatus {
                    id: "active-task".into(),
                    kind: "update".into(),
                    state: "running".into(),
                    message: "fixture".into(),
                    started_at: 0,
                    finished_at: None,
                },
                profile_id: None,
                runtime_path: None,
                cancelled: false,
                process: None,
            },
        );
        assert!(state
            .clone()
            .dispatch("restore_local_registry", snapshot(&profile, &source))
            .await
            .unwrap_err()
            .contains("运行任务"));
        assert!(state
            .clone()
            .dispatch("resume_supervisor", json!({}))
            .await
            .unwrap_err()
            .contains("运行任务"));
        assert!(state.recovery_is_deferred());
        assert!(state.registered_profiles().unwrap().is_empty());
    }
    #[tokio::test]
    async fn invalid_selection_and_duplicate_ids_leave_registry_empty() {
        let (_temp, state, profile, source) = fixture();
        let mut unknown = snapshot(&profile, &source);
        unknown["activeLocalInstallation"] = json!("unknown-model");
        assert!(state
            .clone()
            .dispatch("restore_local_registry", unknown)
            .await
            .unwrap_err()
            .contains("没有对应"));
        let mut duplicate = snapshot(&profile, &source);
        duplicate["profiles"] = json!([profile, profile]);
        assert!(state
            .clone()
            .dispatch("restore_local_registry", duplicate)
            .await
            .unwrap_err()
            .contains("重复"));
        assert!(state.registered_profiles().unwrap().is_empty());
        assert_eq!(
            state.clone().dispatch("hello", json!({})).await.unwrap()["recoveryDeferred"],
            true
        );
    }
}
