//! Connect the UI to an existing Manager backend without migrating or stopping a model.
use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use strata_runtime_core::{discovery::LocalCandidate, types::ServiceProfile};

const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const CONNECTION_FILE: &str = "backend-connection.json";
const CACHE_TTL: Duration = Duration::from_millis(750);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    pub data_dir: PathBuf,
    pub profile_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_path: Option<PathBuf>,
}

pub async fn active_data_directory(default: &Path) -> PathBuf {
    // An explicitly selected store also isolates tests and recovery tools.
    if std::env::var_os("STRATA_MANAGER_DATA_DIR").is_some() {
        return default.to_owned();
    }
    match rpc(default, "hello", json!({})).await {
        Ok(hello) if hello["activeServices"].as_u64() == Some(0) => {}
        Ok(_) => return default.to_owned(), // Active or incomplete default evidence wins.
        Err(_) => {}
    }
    if let Some(saved) = remembered_owner(default) {
        // A stopped model keeps its registered backend selected. Reading this
        // preference must never request model startup or service takeover.
        return saved.data_dir;
    }
    let discovered = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::task::spawn_blocking(|| strata_runtime_core::discovery::discover_local(&[], &[])),
    )
    .await;
    let Ok(Ok(Ok(candidates))) = discovered else {
        return default.to_owned();
    };
    let mut seen = HashSet::new();
    let running: Vec<_> = candidates
        .into_iter()
        .filter(|candidate| {
            candidate.running == Some(true)
                && seen.insert(path_key(Path::new(&candidate.config_path)))
        })
        .collect();
    // A second running configuration is an actual ambiguity, even if both are
    // registered in one backend. Do not change which store the UI controls.
    if running.len() != 1 {
        return default.to_owned();
    }
    let owners = stream::iter(
        running
            .into_iter()
            .map(|candidate| async move { owner(&candidate).await }),
    )
    .buffer_unordered(4)
    .collect::<Vec<_>>()
    .await;
    let selected = selected_directory(default, false, &owners);
    if !same_path(default, &selected) {
        let Some(Ok(selected_owner)) = owners.first() else {
            return default.to_owned();
        };
        if remember_owner(default, selected_owner).is_err() {
            return default.to_owned();
        }
    }
    selected
}

pub async fn owner(candidate: &LocalCandidate) -> Result<Owner, String> {
    let data_dir = candidate_directory(candidate)?;
    if candidate.running != Some(true) {
        return Err("候选服务当前未运行，未更改托管关系".into());
    }
    // Identical UI requests share the in-flight read-only probe. A short cache
    // avoids repeated named-pipe traffic during discovery and card rendering.
    type CachedProbe = Option<(Instant, Result<Owner, String>)>;
    type ProbeEntry = (Instant, Arc<tokio::sync::Mutex<CachedProbe>>);
    static PROBES: OnceLock<Mutex<HashMap<String, ProbeEntry>>> = OnceLock::new();
    let key = format!(
        "{}:{:?}:{:?}",
        path_key(Path::new(&candidate.config_path)),
        candidate.pid,
        candidate.detected_port
    );
    let gate = {
        let mut probes = PROBES
            .get_or_init(Default::default)
            .lock()
            .map_err(|e| e.to_string())?;
        probes.retain(|_, (created, gate)| {
            created.elapsed() < Duration::from_secs(5) || Arc::strong_count(gate) > 1
        });
        if let Some((_, gate)) = probes.get(&key) {
            gate.clone()
        } else {
            let gate = Arc::new(tokio::sync::Mutex::new(None));
            if probes.len() < 128 {
                probes.insert(key, (Instant::now(), gate.clone()));
            }
            gate
        }
    };
    let mut cached = gate.lock().await;
    if let Some((_, result)) = cached.as_ref().filter(|(at, _)| at.elapsed() < CACHE_TTL) {
        return result.clone();
    }
    static ADMISSION: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    let permit = tokio::time::timeout(
        PROBE_TIMEOUT,
        ADMISSION
            .get_or_init(|| tokio::sync::Semaphore::new(4))
            .acquire(),
    )
    .await
    .map_err(|_| "核验管理后台排队超时")?
    .map_err(|e| e.to_string())?;
    let result = probe_owner(candidate, &data_dir).await;
    drop(permit);
    *cached = Some((Instant::now(), result.clone()));
    result
}

pub fn remember_owner(default: &Path, owner: &Owner) -> Result<(), String> {
    if std::env::var_os("STRATA_MANAGER_DATA_DIR").is_some() {
        return Err("当前窗口已显式指定数据目录，不能保存跨目录后台连接".into());
    }
    let owner = valid_remembered_owner(default, owner)?;
    fs::create_dir_all(default).map_err(|e| e.to_string())?;
    let target = default.join(CONNECTION_FILE);
    if fs::symlink_metadata(&target).is_ok_and(|meta| !meta.is_file() || reparse(&meta)) {
        return Err("后台连接偏好不能写入符号链接或特殊文件".into());
    }
    let mut temporary = tempfile::NamedTempFile::new_in(default).map_err(|e| e.to_string())?;
    temporary
        .write_all(&serde_json::to_vec(&owner).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    temporary
        .as_file_mut()
        .sync_all()
        .map_err(|e| e.to_string())?;
    temporary.persist(&target).map_err(|e| e.to_string())?;
    Ok(())
}

fn remembered_owner(default: &Path) -> Option<Owner> {
    let path = default.join(CONNECTION_FILE);
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || reparse(&metadata) || metadata.len() > 16 * 1024 {
        return None;
    }
    let owner: Owner = serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
    valid_remembered_owner(default, &owner).ok()
}

fn verified_owner(
    candidate: &LocalCandidate,
    data_dir: &Path,
    hello: &Value,
    profiles: &[ServiceProfile],
    statuses: &[(String, Value)],
) -> Result<Owner, String> {
    if candidate.running != Some(true) {
        return Err("候选服务当前未运行，未更改托管关系".into());
    }
    validate_hello(data_dir, hello)?;
    if hello["activeServices"]
        .as_u64()
        .is_none_or(|active| active == 0)
    {
        return Err("该管理后台没有可核验的运行中受管服务".into());
    }
    let profile = matching_profile(candidate, data_dir, profiles)?;
    let status = statuses
        .iter()
        .find(|(id, _)| *id == profile.id)
        .map(|(_, status)| status)
        .ok_or("后台未返回所选配置的服务状态")?;
    if status["running"] != true || status["owned"] != true {
        return Err("运行实例尚未由该管理后台托管，未移动或停止服务".into());
    }
    let _owned_pid = status["pid"]
        .as_u64()
        .filter(|pid| *pid > 0 && *pid <= u32::MAX as u64)
        .ok_or("后台没有返回可核验的运行进程 PID")? as u32;
    if candidate.pid == Some(0) {
        return Err("检测候选 PID 无效，请重新检测".into());
    }
    Ok(Owner {
        data_dir: dunce::canonicalize(data_dir).map_err(|e| e.to_string())?,
        profile_id: profile.id.clone(),
        config_path: Some(dunce::canonicalize(&profile.config_path).map_err(|e| e.to_string())?),
    })
}

fn selected_directory(
    default: &Path,
    default_active: bool,
    owners: &[Result<Owner, String>],
) -> PathBuf {
    if !default_active && owners.len() == 1 {
        if let Ok(owner) = &owners[0] {
            return owner.data_dir.clone();
        }
    }
    default.to_owned()
}

async fn rpc(data_dir: &Path, method: &str, params: Value) -> Result<Value, String> {
    tokio::time::timeout(
        PROBE_TIMEOUT,
        strata_local_ipc::call(data_dir, method, params),
    )
    .await
    .map_err(|_| "核验管理后台超时，未更改运行服务".to_owned())?
    .map_err(|error| error.to_string())
}

async fn probe_owner(candidate: &LocalCandidate, data_dir: &Path) -> Result<Owner, String> {
    let hello = rpc(data_dir, "hello", json!({})).await?;
    validate_hello(data_dir, &hello)?;
    let profiles: Vec<ServiceProfile> =
        serde_json::from_value(rpc(data_dir, "local_installations", json!({})).await?)
            .map_err(|error| error.to_string())?;
    if profiles.len() > 256 {
        return Err("后台注册档案过多，无法安全确定运行实例".into());
    }
    let profile = matching_profile(candidate, data_dir, &profiles)?;
    let status = rpc(data_dir, "service_status", json!({"profileId":profile.id})).await?;
    let owner = verified_owner(
        candidate,
        data_dir,
        &hello,
        &profiles,
        &[(profile.id.clone(), status.clone())],
    )?;
    let pid = status["pid"].as_u64().ok_or("后台 PID 无效")? as u32;
    verify_listener(profile.clone(), pid, candidate.pid).await?;
    Ok(owner)
}

async fn verify_listener(
    profile: ServiceProfile,
    owned_pid: u32,
    observed_pid: Option<u32>,
) -> Result<(), String> {
    let operation = tokio::task::spawn_blocking(move || {
        let instance =
            strata_runtime_core::external::detect(&profile)?.ok_or("当前服务没有监听端口")?;
        if observed_pid.is_some_and(|observed| observed != instance.pid) {
            return Err("当前监听实例 PID 与检测候选不一致，请重新检测".into());
        }
        if !instance.belongs_to_owned_process(owned_pid) {
            return Err("当前监听端口不属于后台托管 PID 或已核验的 venv 子进程".into());
        }
        instance.revalidate(&profile)
    });
    tokio::time::timeout(PROBE_TIMEOUT, operation)
        .await
        .map_err(|_| "核验本机监听进程超时")?
        .map_err(|error| error.to_string())?
}

fn matching_profile<'a>(
    candidate: &LocalCandidate,
    data_dir: &Path,
    profiles: &'a [ServiceProfile],
) -> Result<&'a ServiceProfile, String> {
    if !same_path(&candidate_directory(candidate)?, data_dir) {
        return Err("运行配置与管理后台目录不一致".into());
    }
    let config = dunce::canonicalize(&candidate.config_path).map_err(|error| error.to_string())?;
    let mut matching = profiles
        .iter()
        .filter(|profile| profile.managed && same_path(Path::new(&profile.config_path), &config));
    let profile = matching
        .next()
        .ok_or("后台登记的配置与当前运行配置不一致，未更改托管关系")?;
    if matching.next().is_some() {
        return Err("后台配置登记存在歧义，未更改托管关系".into());
    }
    let url = url::Url::parse(&profile.base_url).map_err(|error| error.to_string())?;
    let local = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if !local
        || !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != candidate.detected_port
        || candidate.detected_port.is_none()
    {
        return Err("运行实例端口与后台登记的本机服务地址不一致".into());
    }
    Ok(profile)
}

fn validate_hello(data_dir: &Path, hello: &Value) -> Result<(), String> {
    let reported = hello["dataDir"]
        .as_str()
        .map(Path::new)
        .ok_or("管理后台缺少数据目录身份")?;
    if hello["running"] != true
        || hello["protocolVersion"].as_u64() != Some(strata_local_ipc::PROTOCOL_VERSION as u64)
        || !same_path(data_dir, reported)
    {
        return Err("管理后台身份或协议不一致，未更改运行服务".into());
    }
    Ok(())
}

fn supported_directory(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| matches!(name, "io.strata.manager" | "io.strata.manager.dev"))
}

fn candidate_directory(candidate: &LocalCandidate) -> Result<PathBuf, String> {
    let path = Path::new(&candidate.config_path);
    let imports = path.parent().and_then(Path::parent);
    let data_dir = imports.and_then(Path::parent);
    if !path.is_absolute()
        || path.file_name().is_none_or(|name| name != "config.json")
        || imports
            .and_then(Path::file_name)
            .is_none_or(|name| name != "imports")
        || data_dir.is_none_or(|path| !supported_directory(path))
    {
        return Err("RUNNING_OWNER_NOT_FOUND:当前运行配置未属于已知 Manager 管理目录".into());
    }
    let data_dir = data_dir.unwrap();
    for entry in [path, path.parent().unwrap(), imports.unwrap(), data_dir] {
        let metadata =
            fs::symlink_metadata(entry).map_err(|error| format!("管理配置路径不可用: {error}"))?;
        if reparse(&metadata) {
            return Err("管理配置路径不能是符号链接或目录联接".into());
        }
    }
    let canonical = dunce::canonicalize(path).map_err(|error| error.to_string())?;
    let root = dunce::canonicalize(data_dir).map_err(|error| error.to_string())?;
    if !canonical.is_file()
        || !supported_directory(&root)
        || canonical
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            != Some(root.as_path())
    {
        return Err("管理配置路径解析后不属于原后台目录".into());
    }
    Ok(root)
}

fn reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

fn same_path(left: &Path, right: &Path) -> bool {
    match (dunce::canonicalize(left), dunce::canonicalize(right)) {
        (Ok(left), Ok(right)) => path_key(&left) == path_key(&right),
        _ => false,
    }
}

fn path_key(path: &Path) -> String {
    let path = dunce::canonicalize(path).unwrap_or_else(|_| path.to_owned());
    let key = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    return key.to_lowercase();
    #[cfg(not(windows))]
    key
}

fn valid_remembered_owner(default: &Path, owner: &Owner) -> Result<Owner, String> {
    let mut components = Path::new(&owner.profile_id).components();
    if !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
        || !owner.data_dir.is_absolute()
        || !supported_directory(&owner.data_dir)
        || !same_user_directory(default, &owner.data_dir)
    {
        return Err("后台连接只能指向当前用户的标准 Manager 数据目录和档案".into());
    }
    let config_path = owner.config_path.clone().unwrap_or_else(|| {
        owner
            .data_dir
            .join("imports")
            .join(&owner.profile_id)
            .join("config.json")
    });
    let candidate: LocalCandidate = serde_json::from_value(json!({
        "id":"saved","name":"saved","installDir":"","pythonPath":"",
        "configPath":config_path,"modelPath":""
    }))
    .map_err(|error| error.to_string())?;
    let data_dir = candidate_directory(&candidate)?;
    if !same_path(&data_dir, &owner.data_dir) {
        return Err("保存的运行配置与后台目录不一致".into());
    }
    Ok(Owner {
        data_dir,
        profile_id: owner.profile_id.clone(),
        config_path: owner
            .config_path
            .as_ref()
            .map(dunce::canonicalize)
            .transpose()
            .map_err(|e| e.to_string())?,
    })
}

fn same_user_directory(default: &Path, data_dir: &Path) -> bool {
    let Some(parent) = data_dir.parent() else {
        return false;
    };
    // The caller obtains default from Tauri's app_data_dir, rather than an RPC.
    if default
        .parent()
        .is_some_and(|expected| same_path(expected, parent))
    {
        return true;
    }
    #[cfg(windows)]
    {
        for roaming in [
            std::env::var_os("APPDATA").map(PathBuf::from),
            std::env::var_os("USERPROFILE")
                .map(|profile| PathBuf::from(profile).join("AppData/Roaming")),
        ]
        .into_iter()
        .flatten()
        {
            if same_path(&roaming, parent) {
                return true;
            }
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let packages = PathBuf::from(local).join("Packages");
            let canonical = dunce::canonicalize(parent).ok();
            let base = dunce::canonicalize(packages).ok();
            if let (Some(parent), Some(base)) = (canonical, base) {
                if let Ok(relative) = parent.strip_prefix(base) {
                    let parts: Vec<_> = relative.components().collect();
                    if parts.len() == 3
                        && parts[0]
                            .as_os_str()
                            .to_str()
                            .is_some_and(|name| name.starts_with("OpenAI.Codex_"))
                        && parts[1].as_os_str() == "LocalCache"
                        && parts[2].as_os_str() == "Roaming"
                    {
                        return true;
                    }
                }
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    struct Fixture {
        _directory: tempfile::TempDir,
        data: PathBuf,
        candidate: LocalCandidate,
        profile: ServiceProfile,
        hello: Value,
        status: Value,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let data = directory.path().join("io.strata.manager.dev");
            let config = data.join("imports/local-model/config.json");
            fs::create_dir_all(config.parent().unwrap()).unwrap();
            fs::write(&config, b"{}").unwrap();
            let candidate = LocalCandidate {
                id: "observed-model".into(),
                name: "Model".into(),
                install_dir: "unused".into(),
                python_path: "unused".into(),
                config_path: config.to_string_lossy().into(),
                model_path: "unused".into(),
                model_bytes: None,
                model_group_key: None,
                config_modified_at: None,
                config: None,
                detected_port: Some(18100),
                running: Some(true),
                reason: None,
                runtime_version: None,
                release_version: None,
                source: None,
                availability: None,
                pid: Some(12345),
            };
            let profile = ServiceProfile {
                id: "local-model".into(),
                name: "Model".into(),
                base_url: "http://127.0.0.1:18100".into(),
                install_dir: "unused".into(),
                python_path: "unused".into(),
                config_path: config.to_string_lossy().into(),
                managed: true,
            };
            let hello =
                json!({"running":true,"protocolVersion":1,"dataDir":data,"activeServices":1});
            let status = json!({"running":true,"owned":true,"pid":12345});
            Self {
                _directory: directory,
                data,
                candidate,
                profile,
                hello,
                status,
            }
        }
        fn verify(&self) -> Result<Owner, String> {
            verified_owner(
                &self.candidate,
                &self.data,
                &self.hello,
                std::slice::from_ref(&self.profile),
                &[(self.profile.id.clone(), self.status.clone())],
            )
        }
    }

    #[test]
    fn selects_the_only_verified_running_manager_owner() {
        let fixture = Fixture::new();
        let verified = fixture.verify().unwrap();
        assert_eq!(
            verified,
            Owner {
                data_dir: dunce::canonicalize(&fixture.data).unwrap(),
                profile_id: fixture.profile.id.clone(),
                config_path: Some(dunce::canonicalize(&fixture.profile.config_path).unwrap()),
            }
        );
        let default = fixture._directory.path().join("io.strata.manager");
        assert_eq!(
            selected_directory(&default, false, &[Ok(verified)]),
            dunce::canonicalize(&fixture.data).unwrap()
        );
    }

    #[test]
    fn an_active_default_backend_has_priority_over_another_owner() {
        let fixture = Fixture::new();
        let default = fixture._directory.path().join("io.strata.manager");
        let owner = Owner {
            data_dir: fixture.data,
            profile_id: fixture.profile.id,
            config_path: None,
        };
        assert_eq!(selected_directory(&default, true, &[Ok(owner)]), default);
    }

    #[test]
    fn multiple_owners_or_an_unverified_running_candidate_preserve_default() {
        let fixture = Fixture::new();
        let default = fixture._directory.path().join("io.strata.manager");
        let owner = Owner {
            data_dir: fixture.data,
            profile_id: fixture.profile.id,
            config_path: None,
        };
        let other = Owner {
            data_dir: default.clone(),
            profile_id: "other".into(),
            config_path: None,
        };
        for owners in [
            vec![Ok(owner.clone()), Ok(other)],
            vec![Ok(owner), Err("外部未托管".into())],
            vec![],
        ] {
            assert_eq!(selected_directory(&default, false, &owners), default);
        }
    }

    #[test]
    fn an_owned_status_for_another_configuration_cannot_claim_the_candidate() {
        let mut fixture = Fixture::new();
        let other = fixture.data.join("imports/local-model/other.json");
        fs::write(&other, b"{}").unwrap();
        fixture.profile.config_path = other.to_string_lossy().into();
        assert!(fixture.verify().is_err());
    }

    #[test]
    fn owner_requires_matching_loopback_port() {
        for url in ["http://127.0.0.1:18101", "https://example.com:18100"] {
            let mut fixture = Fixture::new();
            fixture.profile.base_url = url.into();
            assert!(fixture.verify().is_err());
        }
    }

    #[test]
    fn a_legacy_registered_id_can_own_and_remember_a_differently_named_import_folder() {
        let mut fixture = Fixture::new();
        fixture.profile.id = "strata-local-18081".into();
        let connected = fixture.verify().unwrap();
        assert_eq!(connected.profile_id, "strata-local-18081");
        assert!(connected
            .config_path
            .as_ref()
            .is_some_and(|path| same_path(path, Path::new(&fixture.profile.config_path))));
        let default = fixture._directory.path().join("io.strata.manager");
        remember_owner(&default, &connected).unwrap();
        assert_eq!(remembered_owner(&default), Some(connected));
    }

    #[test]
    fn owner_requires_owned_running_matching_pid_and_live_candidate() {
        for status in [
            json!({"running":true,"owned":false,"pid":12345}),
            json!({"running":false,"owned":true,"pid":12345}),
            json!({"running":true,"owned":true,"pid":0}),
            json!({"running":true,"owned":true}),
        ] {
            let mut fixture = Fixture::new();
            fixture.status = status;
            assert!(fixture.verify().is_err());
        }
        let mut fixture = Fixture::new();
        fixture.candidate.running = Some(false);
        assert!(fixture.verify().is_err());
        let mut fixture = Fixture::new();
        fixture.profile.managed = false;
        assert!(fixture.verify().is_err());
    }

    #[test]
    fn owner_requires_hello_to_identify_the_same_backend_directory() {
        let mut fixture = Fixture::new();
        fixture.hello["dataDir"] = json!(fixture._directory.path());
        assert!(fixture.verify().is_err());
        let mut fixture = Fixture::new();
        fixture.hello["activeServices"] = json!(0);
        assert!(fixture.verify().is_err());
    }

    #[test]
    fn backend_owned_root_can_differ_from_the_observed_listener_pid() {
        let mut fixture = Fixture::new();
        fixture.status["pid"] = json!(54321);
        assert!(fixture.verify().is_ok());
    }

    #[test]
    fn saved_connection_remains_selected_when_the_model_is_stopped() {
        let fixture = Fixture::new();
        let default = fixture._directory.path().join("io.strata.manager");
        fs::create_dir_all(&default).unwrap();
        let owner = Owner {
            data_dir: dunce::canonicalize(fixture.data).unwrap(),
            profile_id: fixture.profile.id,
            config_path: None,
        };
        remember_owner(&default, &owner).unwrap();
        assert_eq!(remembered_owner(&default), Some(owner));
    }

    #[test]
    fn saved_connection_rejects_relative_arbitrary_and_missing_configuration_directories() {
        let fixture = Fixture::new();
        let default = fixture._directory.path().join("io.strata.manager");
        fs::create_dir_all(&default).unwrap();
        for owner in [
            Owner {
                data_dir: PathBuf::from("io.strata.manager.dev"),
                profile_id: fixture.profile.id.clone(),
                config_path: None,
            },
            Owner {
                data_dir: fixture._directory.path().into(),
                profile_id: fixture.profile.id.clone(),
                config_path: None,
            },
            Owner {
                data_dir: fixture.data.clone(),
                profile_id: "../local-model".into(),
                config_path: None,
            },
            Owner {
                data_dir: fixture.data.clone(),
                profile_id: "missing".into(),
                config_path: None,
            },
        ] {
            assert!(remember_owner(&default, &owner).is_err());
        }
    }

    #[cfg(windows)]
    struct IpcFixture {
        fixture: Fixture,
        _process: FixtureProcess,
        calls: Arc<Mutex<Vec<String>>>,
        stop: tokio_util::sync::CancellationToken,
        server: tokio::task::JoinHandle<Result<(), strata_local_ipc::RpcError>>,
    }

    #[cfg(windows)]
    struct FixtureProcess {
        launcher: std::process::Child,
        child: windows_sys::Win32::Foundation::HANDLE,
    }

    #[cfg(windows)]
    impl Drop for FixtureProcess {
        fn drop(&mut self) {
            use windows_sys::Win32::{
                Foundation::CloseHandle,
                System::Threading::{TerminateProcess, WaitForSingleObject},
            };
            unsafe {
                if WaitForSingleObject(self.child, 0) == 258 {
                    TerminateProcess(self.child, 1);
                }
                CloseHandle(self.child);
            }
            let _ = self.launcher.kill();
            let _ = self.launcher.wait();
        }
    }

    #[cfg(windows)]
    impl Drop for IpcFixture {
        fn drop(&mut self) {
            self.stop.cancel();
            self.server.abort();
        }
    }

    #[cfg(windows)]
    impl IpcFixture {
        async fn new(claimed_pid: Option<u32>) -> Self {
            Self::with_venv(claimed_pid, false).await
        }

        async fn with_venv(claimed_pid: Option<u32>, venv: bool) -> Self {
            use std::os::windows::process::CommandExt;
            use windows_sys::Win32::System::Threading::{
                OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
            };
            let mut fixture = Fixture::new();
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);
            static PYTHON: OnceLock<String> = OnceLock::new();
            let python = PYTHON.get_or_init(|| {
                let output = std::process::Command::new("py")
                    .args(["-c", "import sys; print(sys.executable)"])
                    .creation_flags(0x08000000)
                    .output()
                    .unwrap();
                assert!(output.status.success());
                String::from_utf8(output.stdout).unwrap().trim().to_owned()
            });
            let runtime = fixture._directory.path().join("runtime");
            fs::create_dir_all(runtime.join("serve")).unwrap();
            fs::write(runtime.join("serve/server.py"),b"import socket,sys,time,pathlib,os\ns=socket.socket();s.bind(('127.0.0.1',int(sys.argv[sys.argv.index('--port')+1])));s.listen()\npathlib.Path('test-ready').write_text(str(os.getpid()))\ntime.sleep(60)\n").unwrap();
            let selected = if venv {
                let environment = runtime.join(".venv");
                let status = std::process::Command::new(python)
                    .args(["-m", "venv", "--without-pip"])
                    .arg(&environment)
                    .creation_flags(0x08000000)
                    .status()
                    .unwrap();
                assert!(status.success());
                environment.join("Scripts/python.exe")
            } else {
                PathBuf::from(python)
            };
            let launcher = std::process::Command::new(&selected)
                .current_dir(&runtime)
                .args(["-u", "-m", "serve.server", "--engine", "strata", "--config"])
                .arg(&fixture.profile.config_path)
                .args(["--host", "127.0.0.1", "--port", &port.to_string()])
                .creation_flags(0x08000000)
                .spawn()
                .unwrap();
            let ready = runtime.join("test-ready");
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            while !ready.is_file() {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "isolated Python listener fixture did not become ready"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let child_pid: u32 = fs::read_to_string(ready).unwrap().parse().unwrap();
            let child =
                unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, child_pid) };
            assert!(!child.is_null());
            let owned_pid = launcher.id();
            let process = FixtureProcess { launcher, child };
            fixture.candidate.pid = Some(claimed_pid.unwrap_or(child_pid));
            fixture.candidate.detected_port = Some(port);
            fixture.profile.base_url = format!("http://127.0.0.1:{port}");
            fixture.profile.install_dir = runtime.to_string_lossy().into();
            fixture.profile.python_path = selected.to_string_lossy().into();
            fixture.status["pid"] = json!(claimed_pid.unwrap_or(owned_pid));
            let data = fixture.data.clone();
            let hello = fixture.hello.clone();
            let profile = serde_json::to_value(&fixture.profile).unwrap();
            let status = fixture.status.clone();
            let stop = tokio_util::sync::CancellationToken::new();
            let server_stop = stop.clone();
            let calls = Arc::new(Mutex::new(Vec::new()));
            let recorded = calls.clone();
            let server = tokio::spawn(async move {
                strata_local_ipc::serve(&data, server_stop, move |request| {
                    let calls = recorded.clone();
                    let hello = hello.clone();
                    let profile = profile.clone();
                    let status = status.clone();
                    async move {
                        calls.lock().unwrap().push(request.method.clone());
                        match request.method.as_str() {
                            "hello" => Ok(hello),
                            "local_installations" => Ok(json!([profile])),
                            "service_status" => Ok(status),
                            _ => Err(strata_local_ipc::RpcError::new(
                                "fixture_forbidden_mutation",
                                request.method,
                            )),
                        }
                    }
                })
                .await
            });
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            while rpc(&fixture.data, "hello", json!({})).await.is_err() {
                assert!(tokio::time::Instant::now() < deadline);
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            calls.lock().unwrap().clear();
            Self {
                fixture,
                _process: process,
                calls,
                stop,
                server,
            }
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn concurrent_owner_probes_share_read_only_ipc_and_verify_actual_listener_pid() {
        let fixture = IpcFixture::new(None).await;
        let (first, second) = tokio::join!(
            owner(&fixture.fixture.candidate),
            owner(&fixture.fixture.candidate)
        );
        assert_eq!(first.unwrap(), second.unwrap());
        assert_eq!(
            *fixture.calls.lock().unwrap(),
            vec!["hello", "local_installations", "service_status"]
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_claimed_pid_that_does_not_own_the_port_cannot_connect() {
        let fixture = IpcFixture::new(Some(std::process::id() + 1)).await;
        let error = owner(&fixture.fixture.candidate).await.unwrap_err();
        assert!(error.contains("PID"));
        assert!(!error.starts_with("RUNNING_OWNER_NOT_FOUND"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_stopped_candidate_cannot_reuse_a_cached_running_owner() {
        let fixture = IpcFixture::new(None).await;
        owner(&fixture.fixture.candidate).await.unwrap();
        let mut stopped = fixture.fixture.candidate.clone();
        stopped.running = Some(false);
        assert!(owner(&stopped).await.is_err());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_verified_venv_listener_child_connects_to_its_owned_launcher_backend() {
        let fixture = IpcFixture::with_venv(None, true).await;
        assert_ne!(
            fixture.fixture.candidate.pid.unwrap() as u64,
            fixture.fixture.status["pid"].as_u64().unwrap()
        );
        let connected = owner(&fixture.fixture.candidate).await.unwrap();
        assert_eq!(connected.profile_id, fixture.fixture.profile.id);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn active_default_has_priority_over_a_saved_connection_to_another_backend() {
        let fixture = IpcFixture::new(None).await;
        let other = fixture.fixture._directory.path().join("io.strata.manager");
        fs::create_dir_all(other.join("imports/other")).unwrap();
        fs::write(other.join("imports/other/config.json"), b"{}").unwrap();
        remember_owner(
            &fixture.fixture.data,
            &Owner {
                data_dir: other,
                profile_id: "other".into(),
                config_path: None,
            },
        )
        .unwrap();
        let selected = active_data_directory(&fixture.fixture.data).await;
        assert!(same_path(&selected, &fixture.fixture.data));
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "read-only acceptance of the explicitly identified live service"]
    async fn explicit_read_only_running_owner() {
        let expected_data = PathBuf::from(
            std::env::var_os("STRATA_CONNECTION_EXPECTED_DATA")
                .expect("set STRATA_CONNECTION_EXPECTED_DATA"),
        );
        let expected_profile = std::env::var("STRATA_CONNECTION_EXPECTED_PROFILE")
            .expect("set STRATA_CONNECTION_EXPECTED_PROFILE");
        let candidates = tokio::task::spawn_blocking(|| {
            strata_runtime_core::discovery::discover_local(&[], &[])
        })
        .await
        .unwrap()
        .unwrap();
        let expected_config = expected_data
            .join("imports")
            .join(&expected_profile)
            .join("config.json");
        let candidate = candidates
            .iter()
            .find(|candidate| {
                candidate.running == Some(true)
                    && same_path(Path::new(&candidate.config_path), &expected_config)
            })
            .expect("the explicitly identified running service was not discovered");
        let connected = owner(candidate).await.unwrap();
        assert!(same_path(&connected.data_dir, &expected_data));
        assert_eq!(connected.profile_id, expected_profile);
        let status = rpc(
            &connected.data_dir,
            "service_status",
            json!({"profileId":connected.profile_id}),
        )
        .await
        .unwrap();
        assert_eq!(status["running"], true);
        assert_eq!(status["owned"], true);
        println!(
            "{}",
            json!({"dataDir":connected.data_dir,"profileId":connected.profile_id,"listenerPid":candidate.pid,"ownedPid":status["pid"],"running":status["running"],"owned":status["owned"]})
        );
    }
}
