//! LAN sharing changes only the registered private configuration. Server keys
//! never leave this module; the application's client credential is independent.
use crate::{external_management, network, storage, types::ServiceProfile, RuntimeState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    net::IpAddr,
    sync::{atomic::Ordering, Arc},
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceSharingStatus {
    pub profile_id: String,
    pub config_revision: String,
    pub host: String,
    pub port: u16,
    pub has_server_key: bool,
    pub key_count: usize,
    pub running: bool,
    pub owned: bool,
    pub restart_required: bool,
    pub live_host: Option<String>,
    pub live_port: Option<u16>,
    pub lan_addresses: Vec<String>,
    pub management_url: String,
}

// Do not derive Debug: this request contains a new credential.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetServiceAuthRequest {
    pub expected_revision: String,
    pub host: String,
    pub port: u16,
    pub key_action: KeyAction,
    pub server_key: Option<String>,
}
#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum KeyAction {
    Keep,
    Set,
    Clear,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceAuthResult {
    pub status: ServiceSharingStatus,
    pub restart_required: bool,
    pub client_credential_needs_update: bool,
}

fn key_count(config: &Value) -> usize {
    match config.get("api_key") {
        Some(Value::String(key)) => usize::from(!key.trim().is_empty()),
        Some(Value::Array(keys)) => keys
            .iter()
            .filter(|key| key.as_str().is_some_and(|value| !value.trim().is_empty()))
            .count(),
        _ => 0,
    }
}
fn local_lan_addresses() -> Vec<String> {
    let networks = sysinfo::Networks::new_with_refreshed_list();
    let mut addresses: Vec<_> = networks
        .values()
        .flat_map(|network| network.ip_networks())
        .map(|network| network.addr)
        .filter(|ip| match ip {
            IpAddr::V4(ip) => !ip.is_loopback() && (ip.is_private() || ip.is_link_local()),
            IpAddr::V6(ip) => ip.segments()[0] & 0xfe00 == 0xfc00,
        })
        .map(|ip| ip.to_string())
        .collect();
    addresses.sort();
    addresses.dedup();
    addresses
}
fn selected(state: &RuntimeState, incoming: &ServiceProfile) -> Result<ServiceProfile, String> {
    let profile = state.registered_profile(&incoming.id)?;
    if !profile.managed {
        return Err("SHARING_NOT_OWNED: 此配置不是本应用管理的本机配置".into());
    }
    external_management::assert_profile_manager_owned(state, &profile)?;
    if dunce::canonicalize(storage::config_path(incoming)?)
        .map_err(|_| "SHARING_CONFIG_UNAVAILABLE")?
        != dunce::canonicalize(storage::config_path(&profile)?)
            .map_err(|_| "SHARING_CONFIG_UNAVAILABLE")?
    {
        return Err("PROFILE_CONFIG_CHANGED: 目标配置已变化，请重新选择".into());
    }
    Ok(profile)
}
fn lease(state: &RuntimeState, profile: &ServiceProfile) -> Result<Option<(u32, u64)>, String> {
    let mut processes = state
        .processes
        .lock()
        .map_err(|_| "SHARING_STATE_UNAVAILABLE")?;
    if let Some(process) = processes.get_mut(&profile.id) {
        let status = process.refresh()?;
        if status.running {
            if !status.owned
                || process.profile.as_ref().is_none_or(|owned| {
                    owned.config_path != profile.config_path
                        || owned.install_dir != profile.install_dir
                        || owned.base_url != profile.base_url
                })
            {
                return Err("SHARING_NOT_OWNED: 运行进程不属于当前配置，未修改服务".into());
            }
            return Ok(Some((
                status.pid.ok_or("SHARING_STATE_UNAVAILABLE")?,
                status.started_at.ok_or("SHARING_STATE_UNAVAILABLE")?,
            )));
        }
    }
    Ok(None)
}
fn available(state: &RuntimeState) -> Result<(), String> {
    crate::runtime_upgrade::assert_available(state)?;
    crate::tuning::assert_available(state)?;
    if state.recovery_is_deferred()
        || state.selection_changing.load(Ordering::Acquire)
        || state.shutting_down.load(Ordering::Acquire)
    {
        return Err("SHARING_BUSY: 后台正在切换、交接或退出，未修改配置".into());
    }
    let tasks = state
        .tasks
        .lock()
        .map_err(|_| "SHARING_STATE_UNAVAILABLE")?;
    if tasks.values().any(|task| {
        !matches!(
            task.status.state.as_str(),
            "completed" | "failed" | "cancelled"
        ) || task.process.is_some()
    }) {
        return Err("SHARING_BUSY: 后台仍有模型准备或安装任务，未修改配置".into());
    }
    Ok(())
}

/// Pure metadata read. No health probe, load, key readback or lifecycle operation.
pub fn status(
    state: &RuntimeState,
    incoming: &ServiceProfile,
) -> Result<ServiceSharingStatus, String> {
    let profile = selected(state, incoming)?;
    let snapshot = storage::read_snapshot(&profile)?;
    let configured = network::endpoint(&snapshot.config, &profile)?;
    let live = lease(state, &profile)?;
    let live_endpoint = if live.is_some() {
        state
            .owned_listeners
            .lock()
            .map_err(|_| "SHARING_STATE_UNAVAILABLE")?
            .get(&profile.id)
            .copied()
    } else {
        None
    };
    let config_modified = std::fs::metadata(&profile.config_path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|time| time.as_millis() as u64);
    let restart_required = live
        .is_some_and(|(_, started)| config_modified.is_some_and(|modified| modified > started))
        || live_endpoint.is_some_and(|endpoint| endpoint != configured.listen_address);
    let key_count = key_count(&snapshot.config);
    Ok(ServiceSharingStatus {
        profile_id: profile.id,
        config_revision: snapshot.revision,
        host: configured.host,
        port: configured.port,
        has_server_key: key_count > 0,
        key_count,
        running: live.is_some(),
        owned: live.is_some(),
        restart_required,
        live_host: live_endpoint.map(|endpoint| endpoint.ip().to_string()),
        live_port: live_endpoint.map(|endpoint| endpoint.port()),
        lan_addresses: local_lan_addresses(),
        management_url: profile.base_url,
    })
}

fn edited(config: &Value, request: &SetServiceAuthRequest) -> Result<Value, String> {
    if request.expected_revision.len() != 64
        || !request
            .expected_revision
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("CONFIG_REVISION_INVALID: 请重新读取配置".into());
    }
    if request.port == 0 {
        return Err("SHARING_PORT_INVALID: 端口需为 1–65535".into());
    }
    let ip = network::listen_ip(&request.host)?;
    let mut next = config.clone();
    let object = next.as_object_mut().ok_or("SHARING_CONFIG_INVALID")?;
    object.insert("host".into(), json!(request.host));
    object.insert("port".into(), json!(request.port));
    match request.key_action {
        KeyAction::Keep => {
            if request.server_key.is_some() {
                return Err("SHARING_OPTIONS_INVALID".into());
            }
        }
        KeyAction::Clear => {
            if request.server_key.is_some() {
                return Err("SHARING_OPTIONS_INVALID".into());
            }
            object.remove("api_key");
        }
        KeyAction::Set => {
            let key = request
                .server_key
                .as_deref()
                .ok_or("SHARING_KEY_INVALID: 新密钥为空")?;
            if key.trim().is_empty() || key.len() > 4096 || key.chars().any(char::is_control) {
                return Err(
                    "SHARING_KEY_INVALID: 密钥需为不含控制字符的非空文本，最多 4096 字节".into(),
                );
            }
            object.insert("api_key".into(), json!(key));
        }
    }
    if !ip.is_loopback() && key_count(&next) == 0 {
        return Err("SHARING_KEY_REQUIRED: 局域网监听需先设置服务端密钥".into());
    }
    Ok(next)
}

/// Single CAS mutation: authoritative config + key stay in Rust. No automatic
/// restart, loading, firewall change, key-vault write or client credential sync.
pub async fn set_auth(
    state: Arc<RuntimeState>,
    incoming: ServiceProfile,
    request: SetServiceAuthRequest,
) -> Result<ServiceAuthResult, String> {
    available(&state)?;
    let profile = selected(&state, &incoming)?;
    let before = lease(&state, &profile)?;
    // Refuse unknown/external listeners even when the GUI reports a stopped model.
    if before.is_none()
        && (crate::external::port_accepting(&profile)?
            || crate::discovery::has_running_installation(std::path::Path::new(
                &profile.install_dir,
            ))?)
    {
        return Err("SHARING_NOT_OWNED: 检测到未接管的运行进程，未修改配置".into());
    }
    let gate = if before.is_some() {
        // Inspect first, then close admission and re-check, avoiding modifications during inference.
        crate::inspect_idle_http(&state, &profile).await?;
        let guard = crate::maintenance::begin(&state, &profile.id, None, "drain")?;
        crate::maintenance::wait_idle(&state, &profile).await?;
        Some(guard)
    } else {
        None
    };
    tokio::task::spawn_blocking(move || {
        let _gate = gate;
        let _operation = state
            .runtime_operations
            .try_lock()
            .map_err(|_| "SHARING_BUSY: 其它后台操作正在进行，未保存配置")?;
        available(&state)?;
        let current_profile = selected(&state, &incoming)?;
        if serde_json::to_value(&current_profile).map_err(|_| "SHARING_STATE_UNAVAILABLE")?
            != serde_json::to_value(&profile).map_err(|_| "SHARING_STATE_UNAVAILABLE")?
            || lease(&state, &profile)? != before
        {
            return Err("SHARING_STATE_CHANGED: 服务归属或运行状态已改变，未保存配置".into());
        }
        if before.is_none()
            && (crate::external::port_accepting(&profile)?
                || crate::discovery::has_running_installation(std::path::Path::new(
                    &profile.install_dir,
                ))?)
        {
            return Err("SHARING_STATE_CHANGED: 保存前检测到运行进程，未保存配置".into());
        }
        let snapshot = storage::read_snapshot(&profile)?;
        let next = edited(&snapshot.config, &request)?;
        // Existing writer provides byte revision CAS, serialized writes, backup and atomic replace.
        storage::write_cas(&profile, &next, &request.expected_revision)?;
        state.config_endpoint_after_save(&profile, &next)?;
        let refreshed = state.registered_profile(&profile.id)?;
        let status = status(&state, &refreshed)?;
        Ok(ServiceAuthResult {
            restart_required: before.is_some(),
            client_credential_needs_update: request.key_action != KeyAction::Keep,
            status,
        })
    })
    .await
    .map_err(|_| "SHARING_OPERATION_FAILED".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(revision: String) -> SetServiceAuthRequest {
        SetServiceAuthRequest {
            expected_revision: revision,
            host: "127.0.0.1".into(),
            port: 19019,
            key_action: KeyAction::Keep,
            server_key: None,
        }
    }
    #[test]
    fn keep_preserves_arrays_and_unrelated_secret_configuration() {
        let config = json!({"api_key":["first-secret","second-secret"],"env":{"ACCESS_TOKEN":"third-secret"},"args":["--native","weights"],"unknown":{"a":1}});
        let next = edited(&config, &request("a".repeat(64))).unwrap();
        for key in ["api_key", "env", "args", "unknown"] {
            assert_eq!(next[key], config[key]);
        }
        assert_eq!(key_count(&next), 2);
    }
    #[test]
    fn single_key_change_is_explicit_and_lan_requires_auth() {
        let mut change = request("a".repeat(64));
        change.host = "0.0.0.0".into();
        assert!(edited(&json!({}), &change)
            .unwrap_err()
            .contains("SHARING_KEY_REQUIRED"));
        change.key_action = KeyAction::Set;
        change.server_key = Some("new-secret".into());
        assert_eq!(
            edited(&json!({"api_key":["old","other"]}), &change).unwrap()["api_key"],
            "new-secret"
        );
        change.key_action = KeyAction::Clear;
        change.server_key = None;
        assert!(edited(&json!({"api_key":"old"}), &change).is_err());
        change.host = "127.0.0.1".into();
        assert!(edited(&json!({"api_key":"old"}), &change)
            .unwrap()
            .get("api_key")
            .is_none());
        change.key_action = KeyAction::Set;
        change.server_key = Some("secret\r\nvalue".into());
        assert!(!edited(&json!({}), &change).unwrap_err().contains("secret"));
    }
    fn fixture() -> (tempfile::TempDir, Arc<RuntimeState>, ServiceProfile) {
        let directory = tempfile::tempdir().unwrap();
        let runtime = directory.path().join("runtime");
        std::fs::create_dir(&runtime).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let config_path = runtime.join("fixture.json");
        std::fs::write(&config_path, serde_json::to_vec(&json!({"host":"127.0.0.1","port":port,"api_key":["first-secret","second-secret"],"env":{"TOKEN":"hidden"}})).unwrap()).unwrap();
        let state = RuntimeState::open_deferred(directory.path().join("data")).unwrap();
        // Enable only the fixture's mutation path without starting recovery or any model.
        state.recovery_deferred.store(false, Ordering::Release);
        let profile = ServiceProfile {
            id: "sharing-fixture".into(),
            name: "fixture".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            install_dir: runtime.to_string_lossy().into(),
            python_path: "".into(),
            config_path: config_path.to_string_lossy().into(),
            managed: true,
        };
        state.database.lock().unwrap().execute("INSERT INTO local_installations(id,profile,original_profile,imported_at) VALUES(?1,?2,?2,0)", rusqlite::params![profile.id, serde_json::to_string(&profile).unwrap()]).unwrap();
        (directory, state, profile)
    }
    #[tokio::test]
    async fn stopped_save_has_backup_cas_and_never_spawns_or_reads_keys_back() {
        let (_directory, state, profile) = fixture();
        let initial = status(&state, &profile).unwrap();
        let serialized = serde_json::to_string(&initial).unwrap();
        assert!(!serialized.contains("secret"));
        assert_eq!(initial.key_count, 2);
        let mut change = request(initial.config_revision.clone());
        change.port = initial.port;
        let saved = set_auth(state.clone(), profile.clone(), change)
            .await
            .unwrap();
        assert!(!saved.restart_required);
        assert!(!saved.status.running);
        assert!(!saved.client_credential_needs_update);
        assert!(state.processes.lock().unwrap().is_empty());
        let configuration = storage::read(&profile).unwrap();
        assert_eq!(
            configuration["api_key"],
            json!(["first-secret", "second-secret"])
        );
        assert_eq!(configuration["env"]["TOKEN"], "hidden");
        let parent = std::path::Path::new(&profile.config_path).parent().unwrap();
        assert_eq!(
            std::fs::read_dir(parent)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "bak"))
                .count(),
            1
        );
        let mut stale = request(initial.config_revision);
        stale.port = initial.port;
        assert!(set_auth(state.clone(), profile.clone(), stale)
            .await
            .unwrap_err()
            .contains("CONFIG_REVISION_CONFLICT"));
        assert!(state.processes.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn stale_config_target_and_unregistered_profiles_are_rejected_without_writes() {
        let (_directory, state, profile) = fixture();
        let initial = status(&state, &profile).unwrap();
        let other = std::path::Path::new(&profile.config_path).with_file_name("other.json");
        std::fs::write(&other, "{}").unwrap();
        let mut wrong = profile.clone();
        wrong.config_path = other.to_string_lossy().into();
        assert!(set_auth(
            state.clone(),
            wrong,
            request(initial.config_revision.clone())
        )
        .await
        .is_err());
        let mut unknown = profile.clone();
        unknown.id = "unknown".into();
        assert!(set_auth(
            state.clone(),
            unknown,
            request(initial.config_revision.clone())
        )
        .await
        .is_err());
        assert_eq!(
            status(&state, &profile).unwrap().config_revision,
            initial.config_revision
        );
    }
    #[tokio::test]
    // This fixture intentionally holds the production operation lock across
    // set_auth's await to prove its spawn_blocking try_lock refuses a busy save.
    #[allow(clippy::await_holding_lock)]
    async fn foreign_listener_and_concurrent_operations_cannot_save_configuration() {
        let (_directory, state, profile) = fixture();
        let initial = status(&state, &profile).unwrap();
        let listener = std::net::TcpListener::bind(format!("127.0.0.1:{}", initial.port)).unwrap();
        assert!(set_auth(
            state.clone(),
            profile.clone(),
            request(initial.config_revision.clone())
        )
        .await
        .unwrap_err()
        .contains("SHARING_NOT_OWNED"));
        drop(listener);
        assert_eq!(
            status(&state, &profile).unwrap().config_revision,
            initial.config_revision
        );
        let _operation = state.runtime_operations.lock().unwrap();
        assert!(set_auth(
            state.clone(),
            profile.clone(),
            request(initial.config_revision.clone())
        )
        .await
        .unwrap_err()
        .contains("SHARING_BUSY"));
        assert_eq!(
            status(&state, &profile).unwrap().config_revision,
            initial.config_revision
        );
        assert!(state.processes.lock().unwrap().is_empty());
    }
}
