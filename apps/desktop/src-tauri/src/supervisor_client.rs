use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use strata_local_ipc::RpcError;
use strata_runtime_core::types::ServiceProfile;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegistrySnapshot {
    pub profiles: Vec<ServiceProfile>,
    pub originals: Vec<ServiceProfile>,
    pub active_local_installation: Value,
    pub active_profile: Value,
    pub local_service_desired: Value,
    #[serde(default)]
    pub preserved_values: Vec<(String, Value)>,
}

pub(crate) fn original_profile(
    profile: &ServiceProfile,
    details: &Value,
    data_dir: &Path,
) -> Option<ServiceProfile> {
    let mut original = profile.clone();
    let detailed = details
        .as_array()
        .into_iter()
        .flatten()
        .find(|entry| entry["profileId"] == profile.id)
        .and_then(|entry| entry["originalConfigPath"].as_str())
        .map(str::to_owned);
    let config = detailed
        .or_else(|| crate::configuration_details::source_path(profile, data_dir))
        .filter(|path| Path::new(path).is_absolute() && Path::new(path).is_file())?;
    original.config_path = config;
    Some(original)
}

pub struct SupervisorClient {
    pub data_dir: PathBuf,
    resource_dir: PathBuf,
    connection_lock: tokio::sync::Mutex<()>,
    rpc_calls: Arc<tokio::sync::Semaphore>,
    staged: OnceLock<(PathBuf, String)>,
    next_upgrade: AtomicU64,
    update_pending: Mutex<Option<String>>,
    #[cfg(test)]
    package_override: Option<PathBuf>,
}
impl SupervisorClient {
    pub fn new(data_dir: PathBuf, resource_dir: PathBuf) -> Self {
        Self {
            data_dir,
            resource_dir,
            connection_lock: tokio::sync::Mutex::new(()),
            rpc_calls: Arc::new(tokio::sync::Semaphore::new(6)),
            staged: OnceLock::new(),
            next_upgrade: AtomicU64::new(0),
            update_pending: Mutex::new(None),
            #[cfg(test)]
            package_override: None,
        }
    }
    async fn rpc_call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        // The supervisor accepts eight simultaneous RPC connections. Queue this client's
        // individual calls below that limit, including hello and upgrade metadata.
        // Do not hold a permit across ensure_connected: it can issue further RPCs.
        let permit = self
            .rpc_calls
            .clone()
            .acquire_owned()
            .await
            .map_err(|error| RpcError::new("supervisor_queue", error.to_string()))?;
        let data_dir = self.data_dir.clone();
        let method = method.to_owned();
        // A cancelled UI preparation may leave an already accepted RPC running.
        // Keep its admission permit until the actual RPC settles, rather than letting
        // replacement requests exceed the supervisor's connection capacity.
        tokio::spawn(async move {
            let _permit = permit;
            strata_local_ipc::call(&data_dir, &method, params).await
        })
        .await
        .map_err(|error| RpcError::new("supervisor_request", error.to_string()))?
    }
    async fn connected(&self) -> Result<Value, RpcError> {
        self.rpc_call("hello", json!({})).await
    }
    pub async fn ensure_connected(&self) -> Result<(), RpcError> {
        match self.connected().await {
            Ok(status) if self.matches_package(&status)? => return Ok(()),
            Ok(status) if self.defer_background_upgrade(&status)? => return Ok(()),
            Ok(_) => {}
            Err(error) if error.code != "supervisor_unavailable" => return Err(error),
            Err(_) => {}
        }
        let _guard = self.connection_lock.lock().await;
        match self.connected().await {
            Ok(status) if self.matches_package(&status)? => return Ok(()),
            Ok(status) => {
                // A read-only UI request must not unload an already running
                // model merely to replace the UI's packaged supervisor. Check
                // again under the lock because services may have started since
                // the first hello. Missing counts are an incomplete observation.
                if self.defer_background_upgrade(&status)? {
                    return Ok(());
                }
                if self.next_upgrade.load(Ordering::Acquire) > strata_runtime_core::types::now() {
                    return Ok(());
                }
                match self.replace_background(status).await {
                    Ok(()) => {
                        *self
                            .update_pending
                            .lock()
                            .map_err(|e| RpcError::new("supervisor_state", e.to_string()))? = None;
                        return Ok(());
                    }
                    Err(error)
                        if matches!(
                            error.code.as_str(),
                            "service_busy"
                                | "supervisor_upgrade_rolled_back"
                                | "supervisor_upgrade_deferred"
                        ) =>
                    {
                        self.next_upgrade.store(
                            strata_runtime_core::types::now() + 30_000,
                            Ordering::Release,
                        );
                        *self
                            .update_pending
                            .lock()
                            .map_err(|e| RpcError::new("supervisor_state", e.to_string()))? =
                            Some(error.message);
                        return Ok(());
                    }
                    Err(error) => return Err(error),
                }
            }
            Err(error) if error.code != "supervisor_unavailable" => return Err(error),
            Err(_) => {}
        }
        self.start_and_wait(&self.staged_executable()?)
            .await
            .map(|_| ())
    }
    fn defer_background_upgrade(&self, status: &Value) -> Result<bool, RpcError> {
        let active = status.get("activeServices").and_then(Value::as_u64);
        if active == Some(0) {
            return Ok(false);
        }
        let reason = match active {
            Some(count) => format!("已有 {count} 个本机服务运行；服务停止后更新后台"),
            None => "无法核实已有后台的服务状态；保持运行，请停止服务后重试更新".into(),
        };
        *self
            .update_pending
            .lock()
            .map_err(|e| RpcError::new("supervisor_state", e.to_string()))? = Some(reason);
        Ok(true)
    }
    fn matches_package(&self, status: &Value) -> Result<bool, RpcError> {
        self.staged_executable()?;
        let (_, hash) = self
            .staged
            .get()
            .ok_or_else(|| RpcError::new("supervisor_package", "后台包身份尚未准备"))?;
        Ok(
            status.get("executableHash").and_then(Value::as_str) == Some(hash)
                && status.get("version").and_then(Value::as_str) == Some(env!("CARGO_PKG_VERSION")),
        )
    }
    async fn start_and_wait(&self, executable: &Path) -> Result<Value, RpcError> {
        self.start_and_wait_mode(executable, false).await
    }
    async fn start_and_wait_mode(
        &self,
        executable: &Path,
        defer_restore: bool,
    ) -> Result<Value, RpcError> {
        let mut command = Command::new(executable);
        command
            .args(["--data-dir"])
            .arg(&self.data_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if defer_restore {
            command.arg("--defer-restore");
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // No Job Object owned by the UI and no inherited handles: dropping
            // this Child or quitting WebView never stops the supervisor.
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|e| RpcError::unavailable(format!("启动独立后台失败: {e}")))?;
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            match self.connected().await {
                Ok(status) => return Ok(status),
                Err(error) if error.code != "supervisor_unavailable" => return Err(error),
                Err(_) => {}
            }
            if let Some(status) = child
                .try_wait()
                .map_err(|e| RpcError::unavailable(e.to_string()))?
            {
                // Concurrent UIs may spawn at the same instant. The duplicate
                // process exits 0 while the mutex owner finishes opening its pipe.
                if !status.success() {
                    return Err(RpcError::unavailable(format!(
                        "独立后台启动后退出: {status}"
                    )));
                }
            }
            if std::time::Instant::now() >= deadline {
                return Err(RpcError::unavailable(
                    "独立后台 15 秒内未能连接；请查看安装完整性",
                ));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    fn previous_executable(&self, status: &Value) -> Result<PathBuf, RpcError> {
        let path = status
            .get("executablePath")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                RpcError::new(
                    "supervisor_upgrade",
                    "已有后台缺少版本身份，需先安全退出后台再升级",
                )
            })?;
        let canonical = dunce::canonicalize(path)
            .map_err(|e| RpcError::new("supervisor_upgrade", e.to_string()))?;
        let data_root = strata_runtime_core::installation::verified_data_root(&self.data_dir)
            .map_err(|e| RpcError::new("supervisor_upgrade", e))?;
        let directory = dunce::canonicalize(data_root.join("supervisor"))
            .map_err(|e| RpcError::new("supervisor_upgrade", e.to_string()))?;
        if !supervisor_directory_contains(&canonical, &directory)? {
            return Err(RpcError::new(
                "supervisor_upgrade",
                "已有后台不在本应用的版本目录中，保持运行",
            ));
        }
        let hash = format!(
            "{:x}",
            Sha256::digest(
                std::fs::read(&canonical)
                    .map_err(|e| RpcError::new("supervisor_upgrade", e.to_string()))?
            )
        );
        if status.get("executableHash").and_then(Value::as_str) != Some(&hash) {
            return Err(RpcError::new(
                "supervisor_integrity",
                "已有后台文件身份变化，保持运行",
            ));
        }
        Ok(canonical)
    }
    async fn wait_background_stopped(&self) -> Result<(), RpcError> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            match tokio::time::timeout_at(deadline, self.connected())
                .await
                .map_err(|_| {
                    RpcError::new("supervisor_upgrade", "旧后台尚未退出，未启动重复后台")
                })? {
                Err(error) if error.code == "supervisor_unavailable" => {
                    // The listener closes before runtime cleanup drops the
                    // instance lock. Starting in that gap exits as a duplicate.
                    // Probe the same user/data-dir kernel lock, never a PID kill.
                    match strata_local_ipc::SingleInstance::acquire(&self.data_dir) {
                        Ok(instance) => {
                            drop(instance);
                            return Ok(());
                        }
                        Err(error) if error.code == "already_running" => {}
                        Err(error) => return Err(error),
                    }
                }
                Err(error) => return Err(error),
                Ok(_) => {}
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(RpcError::new(
                    "supervisor_upgrade",
                    "旧后台尚未退出，未启动重复后台",
                ));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    async fn replace_background(&self, previous: Value) -> Result<(), RpcError> {
        let executable = self.staged_executable()?;
        // Failure to prove ownership only defers this optional package upgrade.
        // It must not block compatible status/stop RPCs, and no shutdown or new
        // process has been requested at this point.
        let old = self
            .previous_executable(&previous)
            .map_err(|error| RpcError::new("supervisor_upgrade_deferred", error.to_string()))?;
        // Capture authoritative RPC metadata before the old process exits. A
        // packaged child may see a different physical roaming DB despite using
        // the same logical --data-dir and named pipe, so health alone is not an
        // acceptable handoff check.
        let snapshot = self.registry_snapshot().await?;
        let queue = self
            .rpc_call("store_get", json!({"key":"nativeRuntimeZipUpdates"}))
            .await?;
        // This RPC blocks new POST admission, drains accepted requests and then
        // unloads only application-owned services. Unknown observers refuse it.
        self.rpc_call("shutdown_supervisor", json!({"forUpdate":true}))
            .await?;
        self.wait_background_stopped().await?;
        let result = async {
            let current = self.start_and_wait_mode(&executable, true).await?;
            if !self.matches_package(&current)? {
                return Err(RpcError::new("supervisor_upgrade", "新后台版本身份不匹配"));
            }
            if current["recoveryDeferred"] != true {
                return Err(RpcError::new(
                    "supervisor_registry",
                    "候选后台未暂停服务恢复，未交接模型登记",
                ));
            }
            self.restore_registry_snapshot(&snapshot).await?;
            self.rpc_call(
                "store_set",
                json!({"key":"nativeRuntimeZipUpdates","value":queue}),
            )
            .await?;
            self.rpc_call("resume_supervisor", json!({})).await?;
            // Wait for the persisted selected API to recover, including when a
            // model is deliberately lazy. A pipe alone is not readiness proof.
            self.wait_selected_health().await?;
            Ok::<(), RpcError>(())
        }
        .await;
        if let Err(error) = result {
            if self.connected().await.is_ok() {
                // A failed new process has no accepted inference requests yet.
                // If it cannot be drained safely, preserve it for diagnostics.
                self.rpc_call("shutdown_supervisor", json!({"forUpdate":true}))
                    .await
                    .map_err(|stop| {
                        RpcError::new(
                            "supervisor_rollback",
                            format!("{error}; 无法安全退出候选后台: {stop}"),
                        )
                    })?;
            }
            self.wait_background_stopped().await.map_err(|stop| {
                RpcError::new(
                    "supervisor_rollback",
                    format!("{error}; 候选后台尚未完整退出: {stop}"),
                )
            })?;
            let restored = self.start_and_wait(&old).await.map_err(|rollback| {
                RpcError::new(
                    "supervisor_rollback",
                    format!("{error}; 回滚启动失败: {rollback}"),
                )
            })?;
            if restored["executableHash"] != previous["executableHash"]
                || restored["version"] != previous["version"]
            {
                return Err(RpcError::new(
                    "supervisor_rollback",
                    format!("{error}; 回滚后台版本身份不匹配"),
                ));
            }
            self.wait_selected_health().await.map_err(|rollback| {
                RpcError::new(
                    "supervisor_rollback",
                    format!("{error}; 原后台恢复失败: {rollback}"),
                )
            })?;
            return Err(RpcError::new(
                "supervisor_upgrade_rolled_back",
                format!("新后台验证失败，已经恢复原版本: {error}"),
            ));
        }
        // Lifecycle fixtures use a disposable data directory; they must never
        // repoint the real user's login startup entry at a temporary package.
        #[cfg(not(test))]
        if crate::startup::status(&self.data_dir)
            .ok()
            .and_then(|v| v["enabled"].as_bool())
            == Some(true)
        {
            crate::startup::set(true, &executable, &self.data_dir)
                .map_err(|e| RpcError::new("startup_refresh", e))?;
        }
        Ok(())
    }

    pub(crate) async fn registry_snapshot(&self) -> Result<RegistrySnapshot, RpcError> {
        let profiles: Vec<ServiceProfile> =
            serde_json::from_value(self.rpc_call("local_installations", json!({})).await?)
                .map_err(|error| RpcError::new("supervisor_registry", error.to_string()))?;
        let details = match self.rpc_call("local_installation_details", json!({})).await {
            Ok(details) => details,
            Err(error) if error.code == "unknown_method" => Value::Null,
            Err(error) => return Err(error),
        };
        let originals = profiles
            .iter()
            .filter_map(|profile| original_profile(profile, &details, &self.data_dir))
            .collect();
        let mut values = Vec::new();
        for key in [
            "activeLocalInstallation",
            "activeProfile",
            "localServiceDesired",
            "backgroundPolicy",
            "strataUpstreamUpdateInfo",
            "automaticRuntimeInstallation",
            "automaticRuntimeUpdateTask",
            "benchmarkReportsV1",
        ] {
            values.push((
                key.to_owned(),
                self.rpc_call("store_get", json!({"key":key})).await?,
            ));
        }
        let value = |key: &str| {
            values
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.clone())
                .unwrap_or(Value::Null)
        };
        let mut snapshot = RegistrySnapshot {
            profiles,
            originals,
            active_local_installation: value("activeLocalInstallation"),
            active_profile: value("activeProfile"),
            local_service_desired: value("localServiceDesired"),
            preserved_values: values,
        };
        let queue = self
            .rpc_call("store_get", json!({"key":"nativeRuntimeZipUpdates"}))
            .await?;
        crate::runtime_update_queue::merge_recovery_snapshot(&self.data_dir, &mut snapshot, queue)?;
        // Capture the actual running selection before shutdown. This metadata
        // crosses the registry handoff even when the replacement sees another DB.
        let mut recovery = json!({"profileId":snapshot.active_local_installation,"restore":false});
        if snapshot.local_service_desired.as_bool() != Some(false) {
            if let Some(profile) = snapshot.profiles.iter().find(|profile| {
                snapshot.active_local_installation.as_str() == Some(profile.id.as_str())
            }) {
                let status = self
                    .rpc_call("service_status", json!({"profileId":profile.id}))
                    .await?;
                if status["running"] == true && status["owned"] == true {
                    let health = self
                        .rpc_call(
                            "strata_request",
                            json!({"profile":profile,"path":"/health","method":"GET"}),
                        )
                        .await?;
                    if health["service"] != "strata" || health["status"] != "ok" {
                        return Err(RpcError::new(
                            "supervisor_registry",
                            "无法核验升级前的本机服务",
                        ));
                    }
                    let loaded = health["loaded"].as_bool().ok_or_else(|| {
                        RpcError::new("supervisor_registry", "无法确认升级前模型是否已加载")
                    })?;
                    recovery = json!({"profileId":profile.id,"loaded":loaded});
                }
            }
        }
        snapshot
            .preserved_values
            .push(("supervisorUpgradeRecoveryLoad".into(), recovery));
        Ok(snapshot)
    }

    pub(crate) async fn restore_registry_snapshot(
        &self,
        snapshot: &RegistrySnapshot,
    ) -> Result<(), RpcError> {
        let existing: Vec<ServiceProfile> =
            serde_json::from_value(self.rpc_call("local_installations", json!({})).await?)
                .map_err(|error| RpcError::new("supervisor_registry", error.to_string()))?;
        // A replacement using the same DB already has the authoritative original.
        // Keep it instead of comparing it with a source-path-only reconstruction.
        // All profiles still reach core's complete-JSON conflict validation.
        let originals: Vec<&ServiceProfile> = snapshot
            .originals
            .iter()
            .filter(|original| !existing.iter().any(|profile| profile.id == original.id))
            .collect();
        self.rpc_call("restore_local_registry", json!({"profiles":snapshot.profiles,"originals":originals,"activeLocalInstallation":snapshot.active_local_installation,"activeProfile":snapshot.active_profile,"localServiceDesired":snapshot.local_service_desired})).await?;
        for (key, value) in &snapshot.preserved_values {
            if !matches!(
                key.as_str(),
                "activeLocalInstallation" | "activeProfile" | "localServiceDesired"
            ) {
                self.rpc_call("store_set", json!({"key":key,"value":value}))
                    .await?;
            }
        }
        let profiles: Vec<ServiceProfile> =
            serde_json::from_value(self.rpc_call("local_installations", json!({})).await?)
                .map_err(|error| RpcError::new("supervisor_registry", error.to_string()))?;
        for saved in &snapshot.profiles {
            if !profiles.iter().any(|profile| {
                serde_json::to_value(profile).ok() == serde_json::to_value(saved).ok()
            }) {
                return Err(RpcError::new(
                    "supervisor_registry",
                    format!("后台升级未保留模型登记 {}；未恢复或替换模型服务", saved.id),
                ));
            }
        }
        for (key, expected) in [
            (
                "activeLocalInstallation",
                &snapshot.active_local_installation,
            ),
            ("activeProfile", &snapshot.active_profile),
            ("localServiceDesired", &snapshot.local_service_desired),
        ] {
            if self.rpc_call("store_get", json!({"key":key})).await? != *expected {
                return Err(RpcError::new(
                    "supervisor_registry",
                    format!("后台升级未保留 {key}"),
                ));
            }
        }
        Ok(())
    }
    async fn wait_selected_health(&self) -> Result<(), RpcError> {
        let selected = self
            .rpc_call("store_get", json!({"key":"activeLocalInstallation"}))
            .await?;
        let desired = self
            .rpc_call("store_get", json!({"key":"localServiceDesired"}))
            .await?;
        if desired.as_bool() == Some(false) {
            return Ok(());
        }
        let Some(id) = selected.as_str() else {
            return Ok(());
        };
        let recovery = self
            .rpc_call("store_get", json!({"key":"supervisorUpgradeRecoveryLoad"}))
            .await?;
        if recovery["restore"] == false {
            return Ok(());
        }
        let restore_loaded = recovery["loaded"].as_bool() == Some(true);
        let profiles = self.rpc_call("local_installations", json!({})).await?;
        let profile = profiles
            .as_array()
            .and_then(|ps| ps.iter().find(|p| p["id"].as_str() == Some(id)))
            .ok_or_else(|| RpcError::new("supervisor_restore", "选中的本机安装登记缺失"))?;
        let deadline = std::time::Instant::now() + Duration::from_secs(90);
        loop {
            if let Ok(health) = self
                .rpc_call(
                    "strata_request",
                    json!({"profile":profile,"path":"/health","method":"GET"}),
                )
                .await
            {
                if health["service"] == "strata"
                    && health["status"] == "ok"
                    && (!restore_loaded || health["loaded"] == true)
                {
                    return Ok(());
                }
            }
            let status = self.connected().await?;
            if status["recovery"]["repairRequired"] == true {
                return Err(RpcError::new(
                    "supervisor_restore",
                    "新后台无法恢复选中的服务",
                ));
            }
            if std::time::Instant::now() >= deadline {
                return Err(RpcError::new(
                    "supervisor_restore",
                    "新后台90秒内未恢复本机API",
                ));
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        if matches!(method, "stop_service" | "shutdown_supervisor") {
            // Explicit stops never stage/replace/start a background process.
            // The same user/data-dir IPC and protocol checks still apply.
            self.connected().await?;
            return self.rpc_call(method, params).await;
        }
        self.ensure_connected().await?;
        // A dedicated RPC prevents a replacement/old supervisor from silently
        // ignoring full-scenario fields and running the legacy short diagnostic.
        let method = if method == "tuning_start" && !params["request"]["useCase"].is_null() {
            let status = self.connected().await?;
            if status["capabilities"]["fullScenarioTuning"]
                .as_u64()
                .unwrap_or(0)
                < 1
            {
                return Err(RpcError::new(
                    "SUPERVISOR_CAPABILITY_REQUIRED",
                    "当前后台不支持完整场景实测，请在模型服务停止并完成后台更新后重试",
                ));
            }
            "tuning_start_full_v1"
        } else {
            method
        };
        // Never retry a mutation after an ambiguous transport failure. The caller
        // polls persisted state rather than potentially installing/starting twice.
        let mut result = self.rpc_call(method, params).await.map_err(|error| {
            if method == "tuning_start_full_v1" && error.code == "unknown_method" {
                RpcError::new("SUPERVISOR_CAPABILITY_REQUIRED", "当前后台不支持完整场景实测，请在模型服务停止并完成后台更新后重试")
            } else if matches!(method, "read_config_snapshot_v1" | "write_config_cas_v1") && error.code == "unknown_method" {
                RpcError::new("SUPERVISOR_CAPABILITY_REQUIRED", "当前后台不支持配置版本保护；请在模型服务停止并完成后台更新后再保存。 / The background service requires an update before version-protected saves are available.")
            } else { error }
        })?;
        if method == "supervisor_status" {
            let pending = self
                .update_pending
                .lock()
                .map_err(|e| RpcError::new("supervisor_state", e.to_string()))?
                .clone();
            result["updatePending"] = json!(pending.is_some());
            result["updateReason"] = json!(pending);
            result["expectedVersion"] = json!(env!("CARGO_PKG_VERSION"));
        }
        Ok(result)
    }
    pub(crate) fn staged_executable(&self) -> Result<PathBuf, RpcError> {
        if let Some((path, _)) = self.staged.get() {
            return Ok(path.clone());
        }
        #[cfg(windows)]
        let filename = "strata-supervisor.exe";
        #[cfg(not(windows))]
        let filename = "strata-supervisor";
        let mut candidates = Vec::new();
        #[cfg(test)]
        if let Some(path) = &self.package_override {
            candidates.push(path.clone());
        }
        #[cfg(debug_assertions)]
        if let Some(path) = std::env::var_os("STRATA_MANAGER_SUPERVISOR") {
            candidates.push(PathBuf::from(path));
        }
        if let Ok(executable) = std::env::current_exe() {
            if let Some(parent) = executable.parent() {
                candidates.push(parent.join(filename));
            }
        }
        candidates.push(self.resource_dir.join(filename));
        candidates.push(self.resource_dir.join("binaries").join(filename));
        let source = candidates
            .into_iter()
            .find(|p| p.is_file())
            .ok_or_else(|| {
                RpcError::new(
                    "supervisor_missing",
                    "安装包缺少 strata-supervisor 独立后台，请修复安装",
                )
            })?;
        let bytes = std::fs::read(&source)
            .map_err(|e| RpcError::new("supervisor_package", e.to_string()))?;
        let hash = format!("{:x}", Sha256::digest(&bytes));
        // Keep the running version outside the desktop installation directory.
        // The installer may replace UI files while this process remains alive.
        let directory = self.data_dir.join("supervisor").join(format!(
            "{}-{}",
            env!("CARGO_PKG_VERSION"),
            &hash[..16]
        ));
        std::fs::create_dir_all(&directory)
            .map_err(|e| RpcError::new("supervisor_package", e.to_string()))?;
        let target = directory.join(filename);
        if target.exists() {
            let actual = std::fs::read(&target)
                .map_err(|e| RpcError::new("supervisor_package", e.to_string()))?;
            if Sha256::digest(&actual) != Sha256::digest(&bytes) {
                return Err(RpcError::new(
                    "supervisor_integrity",
                    "已缓存后台文件校验失败，请修复安装",
                ));
            }
            let _ = self.staged.set((target.clone(), hash));
            return Ok(target);
        }
        let mut temp = tempfile::NamedTempFile::new_in(&directory)
            .map_err(|e| RpcError::new("supervisor_package", e.to_string()))?;
        use std::io::Write;
        temp.write_all(&bytes)
            .map_err(|e| RpcError::new("supervisor_package", e.to_string()))?;
        temp.as_file()
            .sync_all()
            .map_err(|e| RpcError::new("supervisor_package", e.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temp.as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o700))
                .map_err(|e| RpcError::new("supervisor_package", e.to_string()))?;
        }
        match temp.persist_noclobber(&target) {
            Ok(_) => {}
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                if Sha256::digest(
                    std::fs::read(&target)
                        .map_err(|e| RpcError::new("supervisor_package", e.to_string()))?,
                ) != Sha256::digest(&bytes)
                {
                    return Err(RpcError::new(
                        "supervisor_integrity",
                        "并发准备的后台文件校验失败",
                    ));
                }
            }
            Err(error) => return Err(RpcError::new("supervisor_package", error.error.to_string())),
        }
        let _ = self.staged.set((target.clone(), hash));
        Ok(target)
    }
}

fn supervisor_directory_contains(executable: &Path, directory: &Path) -> Result<bool, RpcError> {
    if executable.starts_with(directory) {
        return Ok(true);
    }
    #[cfg(windows)]
    {
        use std::{os::windows::fs::OpenOptionsExt, os::windows::io::AsRawHandle};
        use windows_sys::Win32::Foundation::HANDLE;

        #[repr(C)]
        #[derive(Default, PartialEq, Eq)]
        struct FileIdentity {
            volume: u64,
            id: [u8; 16],
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetFileInformationByHandleEx(
                file: HANDLE,
                class: i32,
                information: *mut std::ffi::c_void,
                size: u32,
            ) -> i32;
        }
        let identity = |path: &Path| -> Result<FileIdentity, RpcError> {
            let handle = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(0x02000000) // FILE_FLAG_BACKUP_SEMANTICS opens directories.
                .open(path)
                .map_err(|error| RpcError::new("supervisor_upgrade", error.to_string()))?;
            let mut identity = FileIdentity::default();
            // FileIdInfo includes the volume and the full 128-bit file ID.
            let ok = unsafe {
                GetFileInformationByHandleEx(
                    handle.as_raw_handle() as HANDLE,
                    18,
                    std::ptr::addr_of_mut!(identity).cast(),
                    std::mem::size_of::<FileIdentity>() as u32,
                )
            };
            if ok == 0 {
                return Err(RpcError::new(
                    "supervisor_upgrade",
                    std::io::Error::last_os_error().to_string(),
                ));
            }
            Ok(identity)
        };
        // Windows canonical paths can retain different capitalization even
        // though IPC resolves them to the same directory. Compare the actual
        // ancestor directory, rather than weakening the boundary by lowercasing
        // paths (which could admit a distinct case-sensitive NTFS directory).
        if let Some(ancestor) = executable
            .ancestors()
            .find(|path| path.components().count() == directory.components().count())
        {
            return Ok(identity(ancestor)? == identity(directory)?);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod registry_restore_tests {
    use super::*;
    use std::{fs, net::TcpListener};
    use strata_runtime_core::RuntimeState;
    use tokio_util::sync::CancellationToken;

    struct Fixture {
        _directory: tempfile::TempDir,
        client: SupervisorClient,
        profile: ServiceProfile,
        original: ServiceProfile,
        calls: Arc<Mutex<Vec<(String, Value)>>>,
        stop: CancellationToken,
        server: tokio::task::JoinHandle<Result<(), RpcError>>,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.stop.cancel();
            self.server.abort();
        }
    }
    impl Fixture {
        async fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().join("runtime");
            fs::create_dir(&root).unwrap();
            let python = root.join("python-never-executed.exe");
            fs::write(&python, b"never executed").unwrap();
            let config = root.join("managed.json");
            let source = root.join("original.json");
            for path in [&config, &source] {
                fs::write(path, br#"{"model_name":"isolated-registry-fixture"}"#).unwrap();
            }
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);
            let profile = ServiceProfile {
                id: "existing-registry-fixture".into(),
                name: "Managed fixture".into(),
                base_url: format!("http://127.0.0.1:{port}"),
                install_dir: root.to_string_lossy().into(),
                python_path: python.to_string_lossy().into(),
                config_path: config.to_string_lossy().into(),
                managed: true,
            };
            let mut original = profile.clone();
            original.name = "Original source fixture".into();
            original.managed = false;
            original.config_path = source.to_string_lossy().into();
            let data = directory.path().join("data");
            let state = RuntimeState::open_deferred(data.clone()).unwrap();
            let client = SupervisorClient::new(data.clone(), directory.path().into());
            let calls = Arc::new(Mutex::new(Vec::new()));
            let recorded = calls.clone();
            let stop = CancellationToken::new();
            let server_stop = stop.clone();
            let server = tokio::spawn(async move {
                strata_local_ipc::serve(&data, server_stop, move |request| {
                    let state = state.clone();
                    let recorded = recorded.clone();
                    async move {
                        recorded
                            .lock()
                            .unwrap()
                            .push((request.method.clone(), request.params.clone()));
                        if !matches!(
                            request.method.as_str(),
                            "hello"
                                | "local_installations"
                                | "restore_local_registry"
                                | "store_get"
                                | "store_set"
                        ) {
                            return Err(RpcError::new(
                                "unexpected_fixture_operation",
                                request.method,
                            ));
                        }
                        state
                            .dispatch(&request.method, request.params)
                            .await
                            .map_err(|error| RpcError::new("command_failed", error))
                    }
                })
                .await
            });
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            while client.rpc_call("hello", json!({})).await.is_err() {
                assert!(tokio::time::Instant::now() < deadline);
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            client.rpc_call("restore_local_registry", json!({
                "profiles":[profile], "originals":[original],
                "activeLocalInstallation":profile.id, "activeProfile":profile.id, "localServiceDesired":false,
            })).await.unwrap();
            calls.lock().unwrap().clear();
            Self {
                _directory: directory,
                client,
                profile,
                original,
                calls,
                stop,
                server,
            }
        }
        fn original(&self, id: &str) -> Value {
            let database =
                rusqlite::Connection::open(self.client.data_dir.join("strata-manager.sqlite3"))
                    .unwrap();
            let source: String = database
                .query_row(
                    "SELECT original_profile FROM local_installations WHERE id=?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap();
            serde_json::from_str(&source).unwrap()
        }
        fn synthesized_original(&self) -> ServiceProfile {
            let mut original = self.profile.clone();
            original.config_path = self.original.config_path.clone();
            original
        }
    }

    #[tokio::test]
    async fn same_database_restore_keeps_true_original_and_transfers_only_missing_originals() {
        let fixture = Fixture::new().await;
        let mut added = fixture.profile.clone();
        added.id = "missing-registry-fixture".into();
        added.name = "Missing managed fixture".into();
        let mut added_original = fixture.original.clone();
        added_original.id = added.id.clone();
        let snapshot = RegistrySnapshot {
            profiles: vec![fixture.profile.clone(), added.clone()],
            originals: vec![fixture.synthesized_original(), added_original.clone()],
            active_local_installation: json!(fixture.profile.id),
            active_profile: json!(fixture.profile.id),
            local_service_desired: json!(false),
            preserved_values: vec![(
                "supervisorUpgradeRecoveryLoad".into(),
                json!({"restore":false}),
            )],
        };
        let before = fs::read(&fixture.profile.config_path).unwrap();
        fixture
            .client
            .restore_registry_snapshot(&snapshot)
            .await
            .unwrap();
        assert_eq!(
            fixture.original(&fixture.profile.id),
            json!(fixture.original)
        );
        assert_eq!(fixture.original(&added.id), json!(added_original));
        let calls = fixture.calls.lock().unwrap();
        assert_eq!(calls[0].0, "local_installations");
        let restored = &calls
            .iter()
            .find(|(method, _)| method == "restore_local_registry")
            .unwrap()
            .1;
        assert_eq!(restored["profiles"], json!(snapshot.profiles));
        assert_eq!(restored["originals"], json!([added_original]));
        assert_eq!(restored["localServiceDesired"], false);
        assert_eq!(fs::read(&fixture.profile.config_path).unwrap(), before);
        assert!(!fixture.client.data_dir.join("imports").exists());
    }

    #[tokio::test]
    async fn restore_still_rejects_a_different_registered_profile_without_writing_selection() {
        let fixture = Fixture::new().await;
        let mut conflicting = fixture.profile.clone();
        conflicting.name = "Different profile under the same identifier".into();
        let snapshot = RegistrySnapshot {
            profiles: vec![conflicting],
            originals: vec![fixture.synthesized_original()],
            active_local_installation: Value::Null,
            active_profile: Value::Null,
            local_service_desired: json!(true),
            preserved_values: vec![("must-not-write".into(), json!("conflicting"))],
        };
        let error = fixture
            .client
            .restore_registry_snapshot(&snapshot)
            .await
            .unwrap_err();
        assert!(error.message.contains("已被不同配置占用"));
        assert_eq!(
            fixture.original(&fixture.profile.id),
            json!(fixture.original)
        );
        assert_eq!(
            fixture
                .client
                .rpc_call("local_installations", json!({}))
                .await
                .unwrap(),
            json!([fixture.profile])
        );
        assert_eq!(
            fixture
                .client
                .rpc_call("store_get", json!({"key":"activeLocalInstallation"}))
                .await
                .unwrap(),
            json!(fixture.profile.id)
        );
        assert_eq!(
            fixture
                .client
                .rpc_call("store_get", json!({"key":"localServiceDesired"}))
                .await
                .unwrap(),
            false
        );
        assert_eq!(
            fixture
                .client
                .rpc_call("store_get", json!({"key":"must-not-write"}))
                .await
                .unwrap(),
            Value::Null
        );
        let calls = fixture.calls.lock().unwrap();
        let restored = &calls
            .iter()
            .find(|(method, _)| method == "restore_local_registry")
            .unwrap()
            .1;
        assert_eq!(restored["originals"], json!([]));
        assert!(!calls.iter().any(|(method, _)| method == "store_set"));
    }
}

#[cfg(test)]
#[path = "supervisor_connection_tests.rs"]
mod connection_tests;

#[cfg(test)]
mod supervisor_path_tests {
    use super::*;

    #[test]
    fn previous_executable_requires_verified_root_and_unchanged_file_identity() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let version = data.join("supervisor/previous");
        std::fs::create_dir_all(&version).unwrap();
        let database = data.join("strata-manager.sqlite3");
        std::fs::write(&database, b"read-only database fixture").unwrap();
        let executable = version.join("strata-supervisor.exe");
        let bytes = b"previous package fixture; never executed";
        std::fs::write(&executable, bytes).unwrap();
        let hash = format!("{:x}", Sha256::digest(bytes));
        let status = json!({"executablePath":executable,"executableHash":hash});
        let client = SupervisorClient::new(data.clone(), temp.path().into());
        assert_eq!(
            client.previous_executable(&status).unwrap(),
            dunce::canonicalize(&executable).unwrap()
        );
        assert_eq!(client.data_dir, data);
        assert_eq!(
            std::fs::read(&database).unwrap(),
            b"read-only database fixture"
        );

        // An identical binary outside the verified version directory is not
        // owned, and changing an owned file still invalidates its reported hash.
        let outside = temp.path().join("unowned-supervisor.exe");
        std::fs::write(&outside, bytes).unwrap();
        let mut unowned = status.clone();
        unowned["executablePath"] = json!(outside);
        assert_eq!(
            client.previous_executable(&unowned).unwrap_err().code,
            "supervisor_upgrade"
        );
        std::fs::write(&executable, b"changed package fixture").unwrap();
        assert_eq!(
            client.previous_executable(&status).unwrap_err().code,
            "supervisor_integrity"
        );
        std::fs::remove_file(&database).unwrap();
        assert_eq!(
            client.previous_executable(&status).unwrap_err().code,
            "supervisor_upgrade"
        );
        assert!(!database.exists());
    }
}

#[cfg(test)]
mod rpc_admission_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use tokio_util::sync::CancellationToken;

    struct Fixture {
        _directory: tempfile::TempDir,
        client: Arc<SupervisorClient>,
        stop: CancellationToken,
        hold: CancellationToken,
        active: Arc<AtomicUsize>,
        peak: Arc<AtomicUsize>,
        accepted: Arc<AtomicUsize>,
        server: tokio::task::JoinHandle<Result<(), RpcError>>,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.hold.cancel();
            self.stop.cancel();
            self.server.abort();
        }
    }
    impl Fixture {
        async fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let client = Arc::new(SupervisorClient::new(
                directory.path().into(),
                directory.path().into(),
            ));
            client
                .staged
                .set((
                    directory.path().join("unused-fixture.exe"),
                    "fixture-package".into(),
                ))
                .unwrap();
            let stop = CancellationToken::new();
            let hold = CancellationToken::new();
            let active = Arc::new(AtomicUsize::new(0));
            let peak = Arc::new(AtomicUsize::new(0));
            let accepted = Arc::new(AtomicUsize::new(0));
            let server_data = directory.path().to_owned();
            let server_stop = stop.clone();
            let server_hold = hold.clone();
            let in_flight = active.clone();
            let observed_peak = peak.clone();
            let total = accepted.clone();
            let server = tokio::spawn(async move {
                strata_local_ipc::serve(&server_data, server_stop, move |request| {
                    let in_flight = in_flight.clone();
                    let peak = observed_peak.clone();
                    let total = total.clone();
                    let hold = server_hold.clone();
                    async move {
                        let current = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(current, Ordering::SeqCst);
                        if request.method != "hello" { total.fetch_add(1, Ordering::SeqCst); }
                        if request.method == "hold" { hold.cancelled().await; }
                        else { tokio::time::sleep(Duration::from_millis(10)).await; }
                        in_flight.fetch_sub(1, Ordering::SeqCst);
                        if request.method == "hello" {
                            Ok(json!({"executableHash":"fixture-package","version":env!("CARGO_PKG_VERSION"),"activeServices":0}))
                        } else { Ok(request.params) }
                    }
                }).await
            });
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            while client.rpc_call("hello", json!({})).await.is_err() {
                assert!(tokio::time::Instant::now() < deadline);
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Self {
                _directory: directory,
                client,
                stop,
                hold,
                active,
                peak,
                accepted,
                server,
            }
        }
        async fn wait_for(&self, count: usize) {
            tokio::time::timeout(Duration::from_secs(5), async {
                while self.accepted.load(Ordering::SeqCst) < count {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn rpc_admission_queues_32_profile_resolutions_including_hello() {
        let fixture = Fixture::new().await;
        let mut calls = tokio::task::JoinSet::new();
        for index in 0..32 {
            let client = fixture.client.clone();
            calls.spawn(async move {
                client
                    .request("resolve_profile", json!({"index":index}))
                    .await
            });
        }
        tokio::time::timeout(Duration::from_secs(10), async {
            let mut values = Vec::new();
            while let Some(result) = calls.join_next().await {
                values.push(result.unwrap().unwrap()["index"].as_u64().unwrap());
            }
            values.sort();
            assert_eq!(values, (0..32).collect::<Vec<u64>>());
        })
        .await
        .expect("hello and request must not recursively retain admission permits");
        assert_eq!(fixture.accepted.load(Ordering::SeqCst), 32);
        assert!(fixture.peak.load(Ordering::SeqCst) <= 6);
        assert!(fixture.peak.load(Ordering::SeqCst) > 1);
        assert_eq!(fixture.active.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cancelled_callers_keep_rpc_permits_until_server_responses() {
        let fixture = Fixture::new().await;
        let mut held = Vec::new();
        for index in 0..6 {
            let client = fixture.client.clone();
            held.push(tokio::spawn(async move {
                client.rpc_call("hold", json!({"index":index})).await
            }));
        }
        fixture.wait_for(6).await;
        for call in held {
            call.abort();
            assert!(call.await.unwrap_err().is_cancelled());
        }
        let client = fixture.client.clone();
        let next =
            tokio::spawn(async move { client.rpc_call("next", json!({"after":true})).await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(fixture.accepted.load(Ordering::SeqCst), 6);
        assert_eq!(fixture.client.rpc_calls.available_permits(), 0);
        fixture.hold.cancel();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), next)
                .await
                .unwrap()
                .unwrap()
                .unwrap()["after"],
            true
        );
        assert_eq!(fixture.accepted.load(Ordering::SeqCst), 7);
        assert!(fixture.peak.load(Ordering::SeqCst) <= 6);
    }
}

#[cfg(test)]
#[path = "tuning_compatibility_tests.rs"]
mod tuning_compatibility_tests;

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::fs;
    struct Background(std::process::Child);
    impl Drop for Background {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    fn source() -> PathBuf {
        std::env::current_exe()
            .expect("desktop test executable path")
            .parent()
            .expect("desktop test deps directory")
            .parent()
            .expect("desktop test profile directory")
            .join("strata-supervisor.exe")
    }
    async fn initial(data: &Path, source: &Path) -> Background {
        let directory = data.join("supervisor/previous");
        fs::create_dir_all(&directory).unwrap();
        let executable = directory.join("strata-supervisor.exe");
        let mut bytes =
            fs::read(source).expect("build strata-supervisor before desktop lifecycle tests");
        bytes.extend_from_slice(b"isolated previous package fixture");
        fs::write(&executable, bytes).unwrap();
        let mut command = Command::new(executable);
        command
            .arg("--data-dir")
            .arg(data)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        strata_runtime_core::processes::hidden(&mut command);
        let child = Background(command.spawn().unwrap());
        for _ in 0..150 {
            if strata_local_ipc::call(data, "hello", json!({}))
                .await
                .is_ok()
            {
                return child;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("isolated previous supervisor failed to start");
    }
    #[tokio::test]
    async fn shutdown_waits_for_instance_release_after_the_rpc_listener_is_gone() {
        let data = tempfile::tempdir().unwrap();
        let owner = strata_local_ipc::SingleInstance::acquire(data.path()).unwrap();
        assert!(strata_local_ipc::call(data.path(), "hello", json!({}))
            .await
            .is_err());
        let client = SupervisorClient::new(data.path().into(), data.path().into());
        let mut stopped = Box::pin(client.wait_background_stopped());
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut stopped)
                .await
                .is_err(),
            "A closed RPC listener does not prove the old instance released its lock"
        );
        drop(owner);
        tokio::time::timeout(Duration::from_secs(2), stopped)
            .await
            .unwrap()
            .unwrap();
    }
    #[test]
    fn upgrade_requires_an_explicit_zero_active_service_count() {
        let temp = tempfile::tempdir().unwrap();
        let client = SupervisorClient::new(temp.path().into(), temp.path().into());
        for status in [
            json!({}),
            json!({"activeServices": null}),
            json!({"activeServices": "0"}),
            json!({"activeServices": -1}),
            json!({"activeServices": 0.5}),
            json!({"activeServices": 1}),
        ] {
            assert!(client.defer_background_upgrade(&status).unwrap());
            assert!(client.update_pending.lock().unwrap().is_some());
        }
        assert!(!client
            .defer_background_upgrade(&json!({"activeServices": 0}))
            .unwrap());
    }
    #[tokio::test]
    async fn read_only_request_keeps_loaded_service_and_previous_supervisor_alive() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        fs::create_dir(&data).unwrap();
        let source = source();
        let _previous = initial(&data, &source).await;
        let runtime = data.join("runtimes/release-preserved-fixture");
        fs::create_dir_all(runtime.join("serve")).unwrap();
        fs::write(
            runtime.join("setup.py"),
            "# isolated fixture; never executed",
        )
        .unwrap();
        fs::write(
            runtime.join("serve/server.py"),
            include_str!(
                "../../../../crates/runtime-core/tests/fixtures/runtime_upgrade_service.py"
            ),
        )
        .unwrap();
        let mut probe = Command::new("py");
        probe.args(["-I", "-S", "-c", "import sys;print(sys.executable)"]);
        strata_runtime_core::processes::hidden(&mut probe);
        let output = probe
            .output()
            .expect("Python is required for the isolated lifecycle fixture");
        assert!(output.status.success());
        let python = String::from_utf8(output.stdout).unwrap().trim().to_owned();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let profile = json!({
            "id": format!("preserve-fixture-{}", uuid::Uuid::new_v4()),
            "name": "Isolated CPU fixture",
            "baseUrl": format!("http://127.0.0.1:{port}"),
            "installDir": runtime,
            "pythonPath": python,
            "configPath": runtime.join("config.json"),
            "managed": true,
        });
        fs::write(
            runtime.join("config.json"),
            serde_json::to_vec(&json!({
                "exe": python,
                "args": [],
                "cwd": runtime,
                "model_name": "isolated-preserved-model",
            }))
            .unwrap(),
        )
        .unwrap();
        let mut client = SupervisorClient::new(data.clone(), temp.path().into());
        client.package_override = Some(source);
        let client = std::sync::Arc::new(client);
        let connection_guard = client.connection_lock.lock().await;
        let connecting_client = client.clone();
        let connecting = tokio::spawn(async move { connecting_client.ensure_connected().await });
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        // Package staging follows the first inactive hello. Holding the lock
        // lets a service start before the second hello, without timing guesses.
        while client.staged.get().is_none() {
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        strata_local_ipc::call(
            &data,
            "restore_local_registry",
            json!({
                "profiles":[profile],"originals":[profile],"activeLocalInstallation":profile["id"],
                "activeProfile":profile["id"],"localServiceDesired":true,
            }),
        )
        .await
        .unwrap();
        let started = strata_local_ipc::call(&data, "start_service", json!({"profile": profile}))
            .await
            .unwrap();
        let service_pid = started["pid"].clone();
        assert!(service_pid.as_u64().is_some_and(|pid| pid > 0));
        let http = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let health_url = format!("http://127.0.0.1:{port}/health");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if http.get(&health_url).send().await.is_ok() {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "Fixture did not become ready"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        http.post(format!("http://127.0.0.1:{port}/load"))
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        let before = strata_local_ipc::call(&data, "hello", json!({}))
            .await
            .unwrap();
        assert_eq!(before["activeServices"], 1);
        let snapshot = client.registry_snapshot().await.unwrap();
        assert_eq!(
            snapshot
                .preserved_values
                .iter()
                .find(|(key, _)| key == "supervisorUpgradeRecoveryLoad")
                .unwrap()
                .1,
            json!({"profileId":profile["id"],"loaded":true})
        );
        drop(connection_guard);
        connecting.await.unwrap().unwrap();
        let after = client
            .request("supervisor_status", json!({}))
            .await
            .unwrap();
        assert_eq!(after["pid"], before["pid"]);
        assert_eq!(after["executableHash"], before["executableHash"]);
        assert_eq!(after["updatePending"], true);
        let installation = crate::runtime_detection::installation_status(&client)
            .await
            .unwrap();
        let canonical_runtime = dunce::canonicalize(&runtime).unwrap();
        assert!(installation["detectedRuntimes"]
            .as_array()
            .unwrap()
            .iter()
            .any(
                |detected| Path::new(detected["installDir"].as_str().unwrap()) == canonical_runtime
            ));
        let service = client
            .request(
                "service_status",
                json!({"profileId": profile["id"], "profile": profile}),
            )
            .await
            .unwrap();
        assert_eq!(service["pid"], service_pid);
        assert_eq!(service["running"], true);
        let health: Value = http
            .get(&health_url)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            health["loaded"], true,
            "A read-only check unloaded the model"
        );
        // The user's explicit stop is still served by the existing background.
        client
            .request("stop_service", json!({"profileId": profile["id"]}))
            .await
            .unwrap();
        let upgraded = client
            .request("supervisor_status", json!({}))
            .await
            .unwrap();
        assert_ne!(upgraded["pid"], before["pid"]);
        assert_eq!(upgraded["updatePending"], false);
        assert!(client.matches_package(&upgraded).unwrap());
        strata_local_ipc::call(&data, "shutdown_supervisor", json!({}))
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn package_identity_switches_idle_background_and_bad_candidate_rolls_back() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        fs::create_dir(&data).unwrap();
        let source = source();
        let _previous = initial(&data, &source).await;
        let before = strata_local_ipc::call(&data, "hello", json!({}))
            .await
            .unwrap();
        let runtime = temp.path().join("stopped-runtime");
        fs::create_dir(&runtime).unwrap();
        let python = runtime.join("python-never-executed.exe");
        let config = runtime.join("config.json");
        fs::write(&python, b"stopped fixture must not execute").unwrap();
        fs::write(&config, br#"{"model_name":"stopped-model"}"#).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let profile = json!({"id":"stopped-history","name":"Stopped history","baseUrl":format!("http://127.0.0.1:{port}"),
            "installDir":runtime,"pythonPath":python,"configPath":config,"managed":true});
        strata_local_ipc::call(
            &data,
            "restore_local_registry",
            json!({
                "profiles":[profile],"originals":[profile],"activeLocalInstallation":profile["id"],
                "activeProfile":profile["id"],"localServiceDesired":true,
            }),
        )
        .await
        .unwrap();
        strata_local_ipc::call(
            &data,
            "set_background_policy",
            json!({"mode":"alwaysReady","autoRecover":true,"idleUnloadMinutes":15}),
        )
        .await
        .unwrap();
        let mut client = SupervisorClient::new(data.clone(), temp.path().into());
        client.package_override = Some(source.clone());
        let snapshot = client.registry_snapshot().await.unwrap();
        let no_restore = json!({"profileId":profile["id"],"restore":false});
        assert_eq!(
            snapshot
                .preserved_values
                .iter()
                .find(|(key, _)| key == "supervisorUpgradeRecoveryLoad")
                .unwrap()
                .1,
            no_restore
        );
        // Exercise the same preserved-values RPC path against a separate DB.
        let transferred_data = temp.path().join("transferred-data");
        let _transferred = initial(&transferred_data, &source).await;
        let transferred_client =
            SupervisorClient::new(transferred_data.clone(), temp.path().into());
        transferred_client
            .restore_registry_snapshot(&snapshot)
            .await
            .unwrap();
        assert_eq!(
            strata_local_ipc::call(
                &transferred_data,
                "store_get",
                json!({"key":"supervisorUpgradeRecoveryLoad"})
            )
            .await
            .unwrap(),
            no_restore
        );
        transferred_client.wait_selected_health().await.unwrap();
        strata_local_ipc::call(&transferred_data, "shutdown_supervisor", json!({}))
            .await
            .unwrap();
        let after = client
            .request("supervisor_status", json!({}))
            .await
            .unwrap();
        assert_ne!(before["pid"], after["pid"]);
        assert!(
            client.matches_package(&after).unwrap(),
            "Candidate package was not retained: before={before}, after={after}"
        );
        assert_eq!(after["updatePending"], false);
        assert_eq!(after["activeServices"], 0);
        assert!(
            strata_local_ipc::call(
                &data,
                "store_get",
                json!({"key":"localPreparationFailures"})
            )
            .await
            .unwrap()
            .is_null(),
            "upgrading a stopped selection attempted to prepare its model"
        );
        let broken = temp.path().join("broken-supervisor.exe");
        fs::write(&broken, b"invalid native package fixture").unwrap();
        let mut broken_client = SupervisorClient::new(data.clone(), temp.path().into());
        broken_client.package_override = Some(broken);
        let rolled = broken_client
            .request("supervisor_status", json!({}))
            .await
            .unwrap();
        assert_eq!(rolled["executableHash"], after["executableHash"]);
        assert_eq!(rolled["updatePending"], true);
        assert!(rolled["updateReason"]
            .as_str()
            .unwrap()
            .contains("恢复原版本"));
        strata_local_ipc::call(&data, "shutdown_supervisor", json!({}))
            .await
            .unwrap();
    }
}

pub fn data_directory(default: &Path) -> PathBuf {
    // Controlled native acceptance and portable installs use a separate store;
    // this never changes the standard user's existing database in place.
    std::env::var_os("STRATA_MANAGER_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| default.to_owned())
}
