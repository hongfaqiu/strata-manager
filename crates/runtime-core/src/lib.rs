pub mod analytics;
pub mod apple_gpu;
pub mod benchmark_identity;
mod byte_size;
pub mod chat_runtime;
pub mod configuration_copy;
pub mod diagnostics;
pub mod discovery;
pub mod disk;
mod display_adapters;
pub mod engine_help;
pub mod external;
pub mod external_management;
mod gpu_power;
pub mod health_watch;
pub mod http;
mod idle_model;
pub mod installation;
pub mod launcher_env;
pub mod legacy;
pub mod local_model;
pub mod macos_metal;
pub mod maintenance;
pub mod manager_mcp;
pub mod manager_mcp_stdio;
pub mod mcp_probe;
pub mod mcp_stdio;
pub mod model_inspect;
mod model_load_wait;
pub mod network;
pub mod observer;
pub mod orca_import;
pub mod policy;
pub mod processes;
pub mod python_repair;
mod registry_handoff;
pub mod request_capture;
pub mod resource_assessment;
pub mod runtime_upgrade;
pub mod service_sharing;
pub mod setup_handoff;
pub mod setup_options;
pub mod storage;
pub mod storage_location;
pub mod store;
pub mod support_diagnostics;
pub mod tuning;
pub mod types;

#[cfg(test)]
mod network_runtime_tests;
#[cfg(test)]
mod tuning_contract_tests;
#[cfg(test)]
mod window_close_tests;

use processes::{Logs, OwnedProcess, Step, Tasks};
use rusqlite::Connection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use types::*;

#[derive(Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryStatus {
    attempts: u8,
    next_retry_at: u64,
    last_error: Option<String>,
    repair_required: bool,
    last_started_at: u64,
}

pub struct RuntimeState {
    database: Arc<Mutex<Connection>>,
    processes: Mutex<HashMap<String, OwnedProcess>>,
    owned_listeners: Mutex<HashMap<String, std::net::SocketAddr>>,
    runtime_operations: Mutex<()>,
    logs: Logs,
    tasks: Tasks,
    pub client: reqwest::Client,
    download_client: reqwest::Client,
    environment_cache: Mutex<Option<(u64, EnvironmentInfo)>>,
    data_dir: PathBuf,
    started_at: u64,
    ensure_locks: tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    shutting_down: AtomicBool,
    recovery: Mutex<RecoveryStatus>,
    health_snapshots: Mutex<HashMap<String, health_watch::HealthSnapshot>>,
    executable_path: PathBuf,
    executable_hash: String,
    selection_lock: tokio::sync::Mutex<()>,
    selection_changing: AtomicBool,
    legacy_migration: Mutex<()>,
    runtime_upgrading: AtomicBool,
    recovery_deferred: AtomicBool,
    recovery_resumed: tokio::sync::Notify,
}
impl RuntimeState {
    pub fn open(data_dir: PathBuf) -> Result<Arc<Self>, String> {
        Self::open_with_recovery(data_dir, false)
    }
    /// Package replacement must migrate the previous supervisor's registration
    /// before any stored selection can start a model or its observer.
    pub fn open_deferred(data_dir: PathBuf) -> Result<Arc<Self>, String> {
        Self::open_with_recovery(data_dir, true)
    }
    fn open_with_recovery(data_dir: PathBuf, deferred: bool) -> Result<Arc<Self>, String> {
        fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        let database =
            Connection::open(data_dir.join("strata-manager.sqlite3")).map_err(|e| e.to_string())?;
        database
            .busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        database
            .execute_batch(store::SCHEMA)
            .map_err(|e| e.to_string())?;
        database.execute_batch("CREATE TABLE IF NOT EXISTS local_installations(id TEXT PRIMARY KEY, profile TEXT NOT NULL, original_profile TEXT NOT NULL, imported_at INTEGER NOT NULL);").map_err(|e| e.to_string())?;
        database
            .execute_batch(legacy::SCHEMA)
            .map_err(|e| e.to_string())?;
        let database = Arc::new(Mutex::new(database));
        let tasks = processes::restore_tasks(&database)?;
        let logs: Logs = Default::default();
        for id in tasks.keys() {
            processes::register_task_logs(&logs, id)?;
        }
        let executable_path = std::env::current_exe().map_err(|e| e.to_string())?;
        let executable_hash = format!(
            "{:x}",
            Sha256::digest(fs::read(&executable_path).map_err(|e| e.to_string())?)
        );
        let state = Arc::new(Self {
            database,
            processes: Mutex::new(HashMap::new()),
            owned_listeners: Mutex::new(HashMap::new()),
            runtime_operations: Mutex::new(()),
            logs,
            tasks: Arc::new(Mutex::new(tasks)),
            client: reqwest::Client::builder()
                .no_proxy()
                .connect_timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|e| e.to_string())?,
            download_client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|e| e.to_string())?,
            environment_cache: Mutex::new(None),
            data_dir,
            started_at: now(),
            ensure_locks: tokio::sync::Mutex::new(HashMap::new()),
            shutting_down: AtomicBool::new(false),
            recovery: Mutex::new(RecoveryStatus::default()),
            health_snapshots: Mutex::new(HashMap::new()),
            executable_path,
            executable_hash,
            selection_lock: tokio::sync::Mutex::new(()),
            selection_changing: AtomicBool::new(false),
            legacy_migration: Mutex::new(()),
            runtime_upgrading: AtomicBool::new(false),
            recovery_deferred: AtomicBool::new(deferred),
            recovery_resumed: tokio::sync::Notify::new(),
        });
        if !deferred {
            state.finish_startup_recovery()?;
        }
        Ok(state)
    }
    fn finish_startup_recovery(self: &Arc<Self>) -> Result<(), String> {
        runtime_upgrade::recover(self)?;
        tuning::recover_pending_configs(self)?;
        setup_handoff::recover(self)?;
        // A broken observation DB must not prevent the local API from starting.
        // The observer independently fails body leases closed on every poll.
        let _ = request_capture::recover(self);
        Ok(())
    }
    pub fn recovery_is_deferred(&self) -> bool {
        self.recovery_deferred.load(Ordering::Acquire)
    }
    pub async fn wait_for_recovery_resume(&self) {
        loop {
            let notified = self.recovery_resumed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !self.recovery_is_deferred() {
                return;
            }
            notified.await;
        }
    }
    pub fn registered_profiles(&self) -> Result<Vec<ServiceProfile>, String> {
        let database = self.database.lock().map_err(|e| e.to_string())?;
        let mut statement = database
            .prepare("SELECT profile FROM local_installations ORDER BY imported_at,id")
            .map_err(|e| e.to_string())?;
        let records = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        records
            .map(|record| {
                serde_json::from_str(&record.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
            })
            .collect()
    }
    fn registered_profile(&self, id: &str) -> Result<ServiceProfile, String> {
        self.registered_profiles()?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| "本机安装尚未导入，请先完成检测与导入".into())
    }
    fn save_registered_endpoint(&self, profile: &ServiceProfile) -> Result<(), String> {
        // Only an existing installation is updated. Legacy profiles are imported
        // through the normal migration boundary, never registered by a save.
        self.database
            .lock()
            .map_err(|e| e.to_string())?
            .execute(
                "UPDATE local_installations SET profile=?1 WHERE id=?2",
                rusqlite::params![
                    serde_json::to_string(profile).map_err(|e| e.to_string())?,
                    profile.id
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    fn forget_owned_listener(&self, profile_id: &str) -> Result<(), String> {
        self.owned_listeners
            .lock()
            .map_err(|e| e.to_string())?
            .remove(profile_id);
        Ok(())
    }
    fn config_endpoint_after_save(
        &self,
        profile: &ServiceProfile,
        config: &Value,
    ) -> Result<(), String> {
        let mut processes = self.processes.lock().map_err(|e| e.to_string())?;
        if processes
            .get_mut(&profile.id)
            .map(|process| process.refresh())
            .transpose()?
            .is_some_and(|status| status.running)
        {
            // Keep every health, load/unload and stop request on the owned old
            // endpoint until an explicit restart actually launches the new one.
            return Ok(());
        }
        self.forget_owned_listener(&profile.id)?;
        let mut updated = profile.clone();
        updated.base_url = network::endpoint(config, profile)?.base_url;
        self.save_registered_endpoint(&updated)
    }
    fn original_profiles(&self) -> Result<Vec<ServiceProfile>, String> {
        let database = self.database.lock().map_err(|e| e.to_string())?;
        let mut statement = database
            .prepare("SELECT original_profile FROM local_installations")
            .map_err(|e| e.to_string())?;
        let records = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        records
            .map(|row| {
                serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
            })
            .collect()
    }
    fn authoritative_profile(&self, incoming: ServiceProfile) -> Result<ServiceProfile, String> {
        http::endpoint(&incoming, "/health")?;
        match self
            .registered_profiles()?
            .into_iter()
            .find(|p| p.id == incoming.id)
        {
            Some(profile) => Ok(profile),
            None => Ok(incoming), // Legacy data is readable during one-time import migration.
        }
    }
    fn owned_gui_profile(&self, id: &str) -> Result<ServiceProfile, String> {
        let profile = self.registered_profile(id)?;
        external_management::assert_manager_owned(self, id)?;
        let mut processes = self.processes.lock().map_err(|e| e.to_string())?;
        let process = processes
            .get_mut(id)
            .ok_or("本机服务尚未由后台接管，请先完成模型准备")?;
        let owned_profile = process
            .profile
            .as_ref()
            .ok_or("该后台进程不是已登记的模型服务")?;
        if !profile.managed
            || owned_profile.base_url != profile.base_url
            || owned_profile.install_dir != profile.install_dir
            || owned_profile.config_path != profile.config_path
            || owned_profile.python_path != profile.python_path
        {
            return Err("运行进程与本机安装登记不一致，未发送修改请求".into());
        }
        let status = process.refresh()?;
        if !status.running {
            self.forget_owned_listener(id)?;
        }
        if !status.running || !status.owned || self.shutting_down.load(Ordering::Acquire) {
            return Err("本机服务未在本后台运行，请先完成模型准备".into());
        }
        Ok(profile)
    }
    pub fn status(&self) -> Result<Value, String> {
        let active_local_installation = store_get(self, "activeLocalInstallation".into())?;
        let local_service_desired = store_get(self, "localServiceDesired".into())?;
        let mut processes = self.processes.lock().map_err(|e| e.to_string())?;
        let mut active_services = 0;
        for (id, process) in processes.iter_mut() {
            if process.refresh()?.running {
                active_services += 1;
            } else {
                self.forget_owned_listener(id)?;
            }
        }
        Ok(
            json!({"running":true,"pid":std::process::id(),"protocolVersion":1,"startedAt":self.started_at,"activeServices":active_services,"dataDir":self.data_dir,"version":env!("CARGO_PKG_VERSION"),"executablePath":self.executable_path,"executableHash":self.executable_hash,"recovery":*self.recovery.lock().map_err(|e|e.to_string())?,"health":*self.health_snapshots.lock().map_err(|e|e.to_string())?,"migration":legacy::report(self)?,"preparationFailures":store_get(self,"localPreparationFailures".into())?.as_object().map(|entries|entries.values().cloned().collect::<Vec<_>>()).unwrap_or_default(),"startupFailures":store_get(self,"localStartupFailures".into())?.as_object().map(|entries|entries.values().cloned().collect::<Vec<_>>()).unwrap_or_default()}),
        )
        .map(|mut status| {
            status["recoveryDeferred"] = json!(self.recovery_is_deferred());
            status["activeLocalInstallation"] = active_local_installation;
            status["localServiceDesired"] = local_service_desired;
            status["capabilities"] = json!({"fullScenarioTuning": 1, "managerMcp": 1, "quickCalibration": 2, "tuningLive": 1});
            status
        })
    }
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }
    fn selection_recovery_load(&self, profile_id: &str) -> Result<Option<bool>, String> {
        if let Some(loaded) = runtime_upgrade::recovery_load(self, profile_id)? {
            return Ok(Some(loaded));
        }
        let recovery = store_get(self, "supervisorUpgradeRecoveryLoad".into())?;
        Ok(if recovery["profileId"].as_str() == Some(profile_id) {
            recovery["loaded"].as_bool()
        } else {
            None
        })
    }
    fn clear_selection_recovery_load(&self, profile_id: &str) -> Result<(), String> {
        runtime_upgrade::clear_recovery_load(self, profile_id)?;
        let recovery = store_get(self, "supervisorUpgradeRecoveryLoad".into())?;
        if recovery["profileId"].as_str() == Some(profile_id) {
            store_set(self, "supervisorUpgradeRecoveryLoad".into(), Value::Null)?;
        }
        Ok(())
    }
    pub async fn restore_default(self: Arc<Self>) -> Result<(), String> {
        if self.recovery_is_deferred() {
            return Ok(());
        }
        if store_get(&self, "localServiceDesired".into())?.as_bool() == Some(false) {
            return Ok(());
        }
        let selected = store_get(&self, "activeLocalInstallation".into())?;
        if let Some(profile_id) = selected.as_str() {
            if external_management::is_external(&self, profile_id)? {
                return Ok(());
            }
            // A saved selection is not a request to start it when the app opens.
            // Only an explicit upgrade may resume a service it interrupted.
            let preload = match self.selection_recovery_load(profile_id)? {
                Some(preload) => preload,
                None => return Ok(()),
            };
            self.clone()
                .ensure_runtime(profile_id.into(), preload)
                .await?;
        }
        Ok(())
    }
    pub async fn recover_tick(self: Arc<Self>) -> Result<(), String> {
        if self.recovery_is_deferred()
            || self.shutting_down.load(Ordering::Acquire)
            || self.selection_changing.load(Ordering::Acquire)
        {
            return Ok(());
        }
        let selected = store_get(&self, "activeLocalInstallation".into())?;
        let Some(id) = selected.as_str() else {
            return Ok(());
        };
        if external_management::is_external(&self, id)? {
            return Ok(());
        }
        if store_get(&self, "localServiceDesired".into())?.as_bool() == Some(false) {
            self.health_snapshots
                .lock()
                .map_err(|e| e.to_string())?
                .remove(id);
            return Ok(());
        }
        let policy = policy::get(&self)?;
        let process = self
            .processes
            .lock()
            .map_err(|e| e.to_string())?
            .get_mut(id)
            .map(|p| p.refresh())
            .transpose()?;
        let recovery_load = self.selection_recovery_load(id)?;
        // OwnedProcess records survive an engine crash in this supervisor,
        // while reopening the supervisor starts with an empty process table.
        if process.is_none() && recovery_load.is_none() {
            return Ok(());
        }
        let running = process.is_some_and(|process| process.running);
        let preload = if running {
            let previous = self
                .health_snapshots
                .lock()
                .map_err(|e| e.to_string())?
                .get(id)
                .cloned();
            let health = health_watch::check(&self, id, previous.as_ref()).await?;
            {
                let mut snapshots = self.health_snapshots.lock().map_err(|e| e.to_string())?;
                snapshots.retain(|profile_id, _| profile_id == id);
                snapshots.insert(id.into(), health.snapshot);
            }
            let idle_cancel = tokio_util::sync::CancellationToken::new();
            let _ = idle_model::tick(self.clone(), id, &idle_cancel).await?;
            if health.recovery_may_reset && health.action == health_watch::HealthAction::None {
                let mut recovery = self.recovery.lock().map_err(|e| e.to_string())?;
                if recovery.last_started_at > 0
                    && now().saturating_sub(recovery.last_started_at) >= 60_000
                {
                    *recovery = RecoveryStatus::default();
                }
            }
            if health.action != health_watch::HealthAction::Preload || !policy.auto_recover {
                return Ok(());
            }
            true
        } else {
            self.health_snapshots
                .lock()
                .map_err(|e| e.to_string())?
                .remove(id);
            if !policy.auto_recover
                || self.runtime_upgrading.load(Ordering::Acquire)
                || self.runtime_operations.try_lock().is_err()
                || self.selection_lock.try_lock().is_err()
                || tuning::assert_no_active_tuning(&self).is_err()
            {
                return Ok(());
            }
            recovery_load.unwrap_or(policy.mode == "alwaysReady")
        };
        if self
            .ensure_locks
            .lock()
            .await
            .get(id)
            .is_some_and(|lock| lock.try_lock().is_err())
        {
            return Ok(());
        }
        {
            let mut recovery = self.recovery.lock().map_err(|e| e.to_string())?;
            if recovery.repair_required || now() < recovery.next_retry_at {
                return Ok(());
            }
            if recovery.attempts >= 3 {
                recovery.repair_required = true;
                recovery.last_error = Some("本机服务连续恢复失败，请在诊断中修复后重试".into());
                return Ok(());
            }
            recovery.attempts += 1;
            recovery.next_retry_at =
                now() + [2_000, 5_000, 15_000][usize::from(recovery.attempts - 1)];
        }
        let result = self.clone().ensure_runtime(id.into(), preload).await;
        let mut recovery = self.recovery.lock().map_err(|e| e.to_string())?;
        match result {
            Ok(_) => {
                recovery.last_error = None;
                recovery.last_started_at = now();
                Ok(())
            }
            Err(error) => {
                recovery.last_error = Some(error.clone());
                recovery.repair_required = recovery.attempts >= 3;
                processes::log(
                    &self.logs,
                    id,
                    "error",
                    format!("自动恢复第 {} 次失败: {error}", recovery.attempts),
                );
                Err(error)
            }
        }
    }
    async fn prepare_app_update(self: Arc<Self>) -> Result<(), String> {
        tuning::assert_no_active_tuning(&self)?;
        if self
            .ensure_locks
            .lock()
            .await
            .values()
            .any(|lock| lock.try_lock().is_err())
            || self.runtime_operations.try_lock().is_err()
            || self
                .tasks
                .lock()
                .map_err(|e| e.to_string())?
                .values()
                .any(|t| t.status.state == "running")
        {
            return Err("后台有启动、加载或维护任务，完成后再更新应用".into());
        }
        let profiles: Vec<ServiceProfile> = self
            .processes
            .lock()
            .map_err(|e| e.to_string())?
            .values()
            .filter_map(|p| p.profile.clone())
            .collect();
        for profile in profiles {
            let running = self
                .processes
                .lock()
                .map_err(|e| e.to_string())?
                .get_mut(&profile.id)
                .map(|p| p.refresh())
                .transpose()?
                .is_some_and(|p| p.running);
            if running {
                inspect_idle_http(&self, &profile).await?;
            }
        }
        let directory = self.data_dir.join("backups");
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let backup = directory.join(format!(
            "before-app-update-{}-{}.sqlite3",
            now(),
            uuid::Uuid::new_v4()
        ));
        self.database
            .lock()
            .map_err(|e| e.to_string())?
            .execute("VACUUM INTO ?1", [backup.to_string_lossy().as_ref()])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub async fn prepare_shutdown(self: Arc<Self>) -> Result<(), String> {
        runtime_upgrade::assert_available(&self)?;
        if self.selection_changing.load(Ordering::Acquire) {
            return Err("正在切换模型，请完成后再停止后台".into());
        }
        tuning::assert_available(&self)?;
        if self.shutting_down.swap(true, Ordering::AcqRel) {
            return Err("后台已在退出，请等待".into());
        }
        let result = self.clone().shutdown_when_idle().await;
        if result.is_err() {
            self.shutting_down.store(false, Ordering::Release);
        }
        result
    }
    /// The user opted out of background serving. Closing the window explicitly
    /// cancels owned work; it must not fall back to silently keeping models alive.
    pub async fn prepare_window_close(self: Arc<Self>) -> Result<(), String> {
        if self.shutting_down.swap(true, Ordering::AcqRel) {
            return Err("后台已在退出，请等待".into());
        }
        let result = async {
            store_set(&self, "localServiceDesired".into(), json!(false))?;
            let state = self.clone();
            tokio::task::spawn_blocking(move || state.cleanup())
                .await
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        .await;
        if result.is_err() {
            self.shutting_down.store(false, Ordering::Release);
        }
        result
    }
    pub async fn prepare_upgrade(self: Arc<Self>) -> Result<(), String> {
        runtime_upgrade::assert_available(&self)?;
        if self.selection_changing.load(Ordering::Acquire) {
            return Err("正在切换模型，请完成后再更新后台".into());
        }
        tuning::assert_available(&self)?;
        if self.shutting_down.swap(true, Ordering::AcqRel) {
            return Err("后台已经进入退出或升级".into());
        }
        let result = self.clone().upgrade_when_idle().await;
        if result.is_err() {
            self.shutting_down.store(false, Ordering::Release);
        }
        result
    }
    async fn upgrade_when_idle(self: Arc<Self>) -> Result<(), String> {
        let profiles: Vec<ServiceProfile> = self
            .processes
            .lock()
            .map_err(|e| e.to_string())?
            .values()
            .filter_map(|p| p.profile.clone())
            .collect();
        let mut gates = Vec::new();
        for profile in profiles {
            let running = self
                .processes
                .lock()
                .map_err(|e| e.to_string())?
                .get_mut(&profile.id)
                .map(|p| p.refresh())
                .transpose()?
                .is_some_and(|p| p.running);
            if !running {
                continue;
            }
            let gate = maintenance::begin(&self, &profile.id, None, "drain")?;
            maintenance::wait_idle(&self, &profile).await?;
            gates.push((profile, gate));
        }
        self.clone().prepare_app_update().await?;
        let selected = store_get(&self, "activeLocalInstallation".into())?;
        // Record an explicit no-restore decision too: a package handoff must
        // not enable a merely remembered selection that was already stopped.
        let mut restore = json!({"profileId":selected,"restore":false});
        for (profile, gate) in gates {
            if selected.as_str() == Some(&profile.id) {
                let health = http::strata_request(
                    &self,
                    profile.clone(),
                    "/health".into(),
                    "GET".into(),
                    None,
                )
                .await?;
                let loaded = health["loaded"]
                    .as_bool()
                    .ok_or("无法确认升级前模型是否已加载")?;
                restore = json!({"profileId":profile.id,"loaded":loaded});
            }
            let (status, unloaded) = http::control_json(
                http::request_builder(&self.client, &profile, "/unload", "POST", Some(json!({})))?
                    .header("X-Strata-Manager-Maintenance-Token", gate.token()),
                Duration::from_secs(90),
            )
            .await?;
            if !status.is_success() {
                return Err("维护时卸载模型失败，保留现有后台".into());
            }
            if !matches!(
                unloaded.get("status").and_then(Value::as_str),
                Some("unloaded" | "not loaded")
            ) {
                return Err("服务无法核验安全卸载，保留现有后台".into());
            }
            maintenance::wait_idle(&self, &profile).await?;
            stop_service(&self, profile.id).await?;
            drop(gate);
        }
        store_set(&self, "supervisorUpgradeRecoveryLoad".into(), restore)?;
        Ok(())
    }
    async fn shutdown_when_idle(self: Arc<Self>) -> Result<(), String> {
        if self
            .ensure_locks
            .lock()
            .await
            .values()
            .any(|lock| lock.try_lock().is_err())
        {
            return Err("模型正在启动或加载，后台保持运行；准备完成后再退出".into());
        }
        if self.runtime_operations.try_lock().is_err() {
            return Err("后台维护操作仍在进行，完成后再退出".into());
        }
        let profiles: Vec<ServiceProfile> = self
            .processes
            .lock()
            .map_err(|e| e.to_string())?
            .values()
            .filter_map(|p| p.profile.clone())
            .collect();
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        for profile in &profiles {
            loop {
                if inspect_idle_http(&self, profile).await.is_ok() {
                    break;
                }
                let running = self
                    .processes
                    .lock()
                    .map_err(|e| e.to_string())?
                    .get_mut(&profile.id)
                    .map(|p| p.refresh())
                    .transpose()?
                    .is_some_and(|p| p.running);
                if !running {
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    return Err(
                        "服务仍有请求或无法核验空闲，后台继续运行；请完成请求后重试退出".into(),
                    );
                }
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        }
        for profile in profiles {
            stop_service(&self, profile.id).await?;
        }
        Ok(())
    }

    pub async fn dispatch(self: Arc<Self>, method: &str, params: Value) -> Result<Value, String> {
        if self.recovery_is_deferred() && !registry_handoff::allowed_while_deferred(method, &params)
        {
            return Err("后台正在交接已有模型登记，完成前已暂停服务操作".into());
        }
        if self.shutting_down.load(Ordering::Acquire)
            && !matches!(
                method,
                "hello"
                    | "supervisor_status"
                    | "service_status"
                    | "store_get"
                    | "local_installations"
                    | "read_logs"
                    | "list_tasks"
                    | "list_setup_handoffs"
            )
        {
            return Err("后台正在退出，已拒绝新的变更操作".into());
        }
        fn arg<T: serde::de::DeserializeOwned>(params: &Value, key: &str) -> Result<T, String> {
            serde_json::from_value(
                params
                    .get(key)
                    .cloned()
                    .ok_or_else(|| format!("缺少参数 {key}"))?,
            )
            .map_err(|e| format!("参数 {key} 无效: {e}"))
        }
        fn value<T: serde::Serialize>(result: Result<T, String>) -> Result<Value, String> {
            serde_json::to_value(result?).map_err(|e| e.to_string())
        }
        let profile = || self.authoritative_profile(arg(&params, "profile")?);
        let config_target = || -> Result<ServiceProfile, String> {
            let incoming: ServiceProfile = arg(&params, "profile")?;
            let selected = self.authoritative_profile(incoming.clone())?;
            let original =
                dunce::canonicalize(storage::config_path(&incoming)?).map_err(|e| e.to_string())?;
            let current =
                dunce::canonicalize(storage::config_path(&selected)?).map_err(|e| e.to_string())?;
            if original != current {
                return Err("PROFILE_CONFIG_CHANGED: 配置目标已改变；草稿已保留，请重新选择配置。 / The selected configuration file changed; your draft is retained.".into());
            }
            Ok(selected)
        };
        if matches!(
            method,
            "start_service"
                | "stop_service"
                | "restart_service"
                | "take_over_service"
                | "run_setup"
                | "install_runtime"
                | "prepare_local_runtime"
                | "write_config"
                | "write_config_cas_v1"
                | "set_api_key"
                | "import_local"
                | "register_configuration_copy"
                | "resolve_setup_handoff"
                | "rename_local_installation"
                | "remove_local_installation"
                | "ensure_local_service"
                | "switch_local_service"
                | "tuning_start"
                | "tuning_start_full_v1"
                | "calibrate_start"
                | "tuning_apply"
                | "tuning_restore"
                | "set_background_policy"
                | "prepare_app_update"
        ) {
            runtime_upgrade::assert_available(&self)?;
        }
        if method == "strata_request"
            && params
                .get("method")
                .and_then(Value::as_str)
                .is_some_and(|m| m != "GET")
            && params.get("path").and_then(Value::as_str).is_some_and(|p| {
                matches!(
                    p,
                    "/load"
                        | "/unload"
                        | "/v1/load"
                        | "/v1/unload"
                        | "/v1/vram"
                        | "/slots/0?action=save"
                        | "/slots/0?action=restore"
                        | "/api/load"
                        | "/api/unload"
                        | "/config"
                        | "/settings"
                        | "/api/settings"
                        | "/mcp"
                        | "/api/mcp"
                )
            })
        {
            runtime_upgrade::assert_available(&self)?;
        }
        if self.selection_changing.load(Ordering::Acquire)
            && matches!(
                method,
                "start_service"
                    | "stop_service"
                    | "restart_service"
                    | "take_over_service"
                    | "run_setup"
                    | "install_runtime"
                    | "update_runtime"
                    | "write_config"
                    | "write_config_cas_v1"
                    | "set_api_key"
                    | "import_local"
                    | "register_configuration_copy"
                    | "resolve_setup_handoff"
                    | "remove_local_installation"
                    | "resolve_profile"
                    | "tuning_start"
                    | "tuning_start_full_v1"
                    | "calibrate_start"
                    | "tuning_apply"
                    | "tuning_restore"
                    | "set_background_policy"
            )
        {
            return Err("模型正在切换，请等待本次准备完成".into());
        }
        if matches!(
            method,
            "start_service"
                | "stop_service"
                | "restart_service"
                | "take_over_service"
                | "run_setup"
                | "install_runtime"
                | "update_runtime"
                | "update_runtime_zip"
                | "update_runtime_zip_download_v1"
                | "update_runtime_zip_version_v1"
                | "write_config"
                | "write_config_cas_v1"
                | "set_api_key"
                | "import_local"
                | "register_configuration_copy"
                | "resolve_setup_handoff"
                | "ensure_local_service"
                | "rename_local_installation"
                | "remove_local_installation"
                | "resolve_profile"
        ) || (method == "strata_request"
            && params
                .get("method")
                .and_then(Value::as_str)
                .is_some_and(|m| m != "GET"))
        {
            tuning::assert_available(&self)?;
        }
        match method {
            "assess_setup_resources" => {
                resource_assessment::assess(&self, arg(&params, "request")?).await
            }
            "service_sharing_status" => value(service_sharing::status(
                &self,
                &arg::<ServiceProfile>(&params, "profile")?,
            )),
            "set_service_auth" => value(
                service_sharing::set_auth(
                    self.clone(),
                    arg(&params, "profile")?,
                    arg(&params, "request")?,
                )
                .await,
            ),
            "benchmark_identity" => value(benchmark_identity::capture(&self, &profile()?)),
            "restore_local_registry" => registry_handoff::restore(&self, params).await,
            "resume_supervisor" => registry_handoff::resume(&self).await,
            "request_capture_status" => value(request_capture::status(
                &self,
                &arg::<String>(&params, "profileId")?,
            )),
            "request_capture_set" => value(
                request_capture::set(
                    self.clone(),
                    arg(&params, "profileId")?,
                    arg(&params, "minutes")?,
                )
                .await,
            ),
            "prepare_local_runtime" => {
                tuning::assert_available(&self)?;
                let archives: installation::LocalRuntimeArchives = params
                    .get("localArchives")
                    .filter(|value| !value.is_null())
                    .map(|value| serde_json::from_value(value.clone()).map_err(|e| e.to_string()))
                    .transpose()?
                    .unwrap_or_default();
                value(installation::start(self.clone(), archives))
            }
            "local_runtime_installation" => value(installation::status(&self)),
            "storage_locations" => value(storage_location::locations(
                &self,
                params
                    .get("installDir")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                params
                    .get("probePath")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            )),
            "set_engine_install_root" => value(storage_location::set_engine_root(
                &self,
                params
                    .get("directory")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            )),
            "set_model_data_directory" => {
                tuning::assert_available(&self)?;
                value(storage_location::set_model_directory(
                    self.clone(),
                    arg(&params, "directory")?,
                    params
                        .get("installDir")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    params
                        .get("moveFiles")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                ))
            }
            "runtime_update_info" => value(
                runtime_upgrade::update_info(
                    &self,
                    params
                        .get("force")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )
                .await,
            ),
            "runtime_release_info" => {
                let version: String = arg(&params, "version")?;
                value(runtime_upgrade::release_info_for_version(&version).await)
            }
            "runtime_release_versions" => value(
                runtime_upgrade::release_versions(
                    &self,
                    params
                        .get("force")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )
                .await,
            ),
            "resolve_runtime_zip_asset_v1" => {
                let install_dir: String = arg(&params, "installDir")?;
                let requested = params.get("assetName").and_then(Value::as_str);
                let target = params
                    .get("targetVersion")
                    .and_then(Value::as_str)
                    .filter(|version| !version.is_empty());
                value(
                    runtime_upgrade::resolve_release_download_asset_for(
                        &self,
                        &install_dir,
                        requested,
                        target,
                    )
                    .await,
                )
            }
            "test_runtime_zip_download_v1" => {
                let asset_name: String = arg(&params, "assetName")?;
                let download = serde_json::from_value(params.clone())
                    .map_err(|error| format!("ZIP 来源测试参数无效：{error}"))?;
                value(runtime_upgrade::test_release_download(&self, &asset_name, download).await)
            }
            "tuning_start" | "tuning_start_full_v1" => {
                let request: tuning::TuningStartRequest = arg(&params, "request")?;
                if method == "tuning_start_full_v1" && request.full.use_case.is_none() {
                    return Err("完整场景实测必须指定 useCase".into());
                }
                value(tuning::start(self.clone(), arg(&params, "profileId")?, request).await)
            }
            "tuning_status" => value(tuning::status(&self, arg(&params, "profileId")?)),
            "tuning_live" => value(Ok::<_, String>(tuning::live_status(&arg::<String>(
                &params, "jobId",
            )?))),
            "calibrate_start" => value(
                tuning::calibrate::start(
                    self.clone(),
                    arg(&params, "profileId")?,
                    params
                        .get("request")
                        .cloned()
                        .map(serde_json::from_value)
                        .transpose()
                        .map_err(|e| format!("校准参数无效：{e}"))?
                        .unwrap_or_default(),
                )
                .await,
            ),
            "calibrate_status" => {
                value(tuning::calibrate::status(&self, arg(&params, "profileId")?))
            }
            "calibrate_cancel" => value(tuning::calibrate::cancel(&self, arg(&params, "jobId")?)),
            "tuning_cancel" => value(tuning::cancel(&self, arg(&params, "jobId")?)),
            "tuning_apply" => value(
                tuning::apply(
                    self.clone(),
                    arg(&params, "jobId")?,
                    arg(&params, "candidateId")?,
                )
                .await,
            ),
            "tuning_restore" => value(tuning::restore(self.clone(), arg(&params, "jobId")?).await),
            "supervisor_status" | "hello" => self.status(),
            "get_background_policy" => value(policy::get(&self)),
            "set_background_policy" => {
                tuning::assert_available(&self)?;
                let policy: policy::BackgroundPolicy =
                    serde_json::from_value(params).map_err(|e| e.to_string())?;
                let policy = policy::set(&self, policy)?;
                if policy.mode == "alwaysReady"
                    && store_get(&self, "localServiceDesired".into())?.as_bool() != Some(false)
                {
                    let selected = store_get(&self, "activeLocalInstallation".into())?;
                    if let Some(id) = selected.as_str() {
                        let running = self
                            .processes
                            .lock()
                            .map_err(|e| e.to_string())?
                            .get_mut(id)
                            .map(|process| process.refresh())
                            .transpose()?
                            .is_some_and(|process| process.running);
                        if running {
                            self.clone().ensure_runtime(id.into(), true).await?;
                        }
                    }
                }
                value(Ok(policy))
            }
            "prepare_app_update" => value(self.clone().prepare_app_update().await),
            "store_get" => {
                let key: String = arg(&params, "key")?;
                if key == "profiles" {
                    let profiles = self.registered_profiles()?;
                    if !profiles.is_empty() {
                        return value(Ok(profiles));
                    }
                }
                store_get(&self, key)
            }
            "store_set" => value(store_set(
                &self,
                arg(&params, "key")?,
                arg(&params, "value")?,
            )),
            "set_api_key" => value(set_api_key(
                arg(&params, "profileId")?,
                arg(&params, "apiKey")?,
            )),
            "has_api_key" => value(has_api_key(arg(&params, "profileId")?)),
            "start_service" => value(start_service(self.clone(), profile()?).await),
            "stop_service" => {
                let _selection = self.selection_lock.lock().await;
                runtime_upgrade::assert_available(&self)?;
                let id: String = arg(&params, "profileId")?;
                if store_get(&self, "activeLocalInstallation".into())?.as_str() == Some(&id) {
                    store_set(&self, "localServiceDesired".into(), json!(false))?;
                    self.clear_selection_recovery_load(&id)?;
                }
                value(stop_service(&self, id).await)
            }
            "restart_service" => value(restart_service(self.clone(), profile()?).await),
            "take_over_service" => value(take_over_service(self.clone(), profile()?).await),
            "service_status" => {
                let incoming: Option<ServiceProfile> = params
                    .get("profile")
                    .filter(|v| !v.is_null())
                    .map(|p| serde_json::from_value(p.clone()).map_err(|e| e.to_string()))
                    .transpose()?;
                let incoming = incoming
                    .map(|p| self.authoritative_profile(p))
                    .transpose()?;
                value(service_status(self.clone(), arg(&params, "profileId")?, incoming).await)
            }
            "read_logs" => value(read_logs(&self, profile()?, arg(&params, "limit")?)),
            "environment_info" => value(environment_info(self.clone()).await),
            "orca_import_plan" => value(orca_import_plan(&profile()?, arg(&params, "request")?)),
            "run_orca_import" => value(run_orca_import(
                self.clone(),
                profile()?,
                arg(&params, "request")?,
                params
                    .get("options")
                    .filter(|v| !v.is_null())
                    .cloned()
                    .map(serde_json::from_value::<setup_options::SetupOptions>)
                    .transpose()
                    .map_err(|e| e.to_string())?,
            )),
            "setup_disk_preflight" => value(Ok(disk::preflight_with_local(
                &profile()?,
                &arg::<String>(&params, "model")?,
                &arg::<String>(&params, "quant")?,
                arg(&params, "images")?,
                local_model_param(&params)?.as_ref(),
            ))),
            "scan_local_models" => value(local_model::scan(&arg::<String>(&params, "path")?)),
            "check_mtp_path" => value(local_model::check_mtp(&arg::<String>(&params, "path")?)),
            "run_setup" => value(run_setup_with_options(
                self.clone(),
                profile()?,
                arg(&params, "model")?,
                arg(&params, "quant")?,
                arg(&params, "context")?,
                arg(&params, "images")?,
                params
                    .get("options")
                    .filter(|v| !v.is_null())
                    .cloned()
                    .map(serde_json::from_value::<setup_options::SetupOptions>)
                    .transpose()
                    .map_err(|e| format!("准备选项无效: {e}"))?
                    .unwrap_or_default(),
                local_model_param(&params)?,
            )),
            "inspect_gguf" => value(model_inspect::start(self.clone(), arg(&params, "request")?)),
            "manager_mcp_connection" => value(manager_mcp::connection(
                &self,
                &arg::<String>(&params, "profileId")?,
            )),
            "manager_mcp_call" => {
                Box::pin(manager_mcp::call(
                    self.clone(),
                    arg(&params, "profileId")?,
                    arg(&params, "name")?,
                    params
                        .get("arguments")
                        .cloned()
                        .unwrap_or_else(|| json!({})),
                ))
                .await
            }
            "probe_official_mcp" => {
                let registered = self.registered_profile(&arg::<String>(&params, "profileId")?)?;
                value(
                    tokio::task::spawn_blocking(move || {
                        mcp_probe::probe_registered_profile(&registered)
                    })
                    .await
                    .map_err(|e| e.to_string())?,
                )
            }
            "assert_profile_management" => {
                // Desktop file operations use the supplied path after this RPC.
                // Bind that path to registration and validate both roots before
                // authorizing IO outside the Supervisor process.
                let incoming: ServiceProfile = arg(&params, "profile")?;
                let selected = config_target()?;
                external_management::assert_profile_manager_owned(&self, &incoming)?;
                external_management::assert_profile_manager_owned(&self, &selected)?;
                Ok(json!({"managed":true}))
            }
            "chat_runtime_evidence" => value(chat_runtime::evidence(
                &self,
                &arg::<String>(&params, "profileId")?,
            )),
            "external_management_status" => value(external_management::status(
                &self,
                &arg::<String>(&params, "profileId")?,
            )),
            "set_external_management" => value(external_management::set(
                &self,
                &arg::<String>(&params, "profileId")?,
                arg(&params, "external")?,
            )),
            "install_runtime" => value(install_runtime(&self, arg(&params, "directory")?)),
            "managed_python_status" => value(installation::managed_python::status(&self)),
            "install_managed_python" => value(installation::managed_python::start(
                self.clone(),
                params
                    .get("source")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            )),
            "update_runtime" => value(runtime_upgrade::start(self.clone(), profile()?.id)),
            "engine_help_flags" => value(engine_help::flags(&profile()?)),
            "update_runtime_zip"
            | "update_runtime_zip_download_v1"
            | "update_runtime_zip_version_v1" => {
                value(runtime_upgrade::start_release_request_with_download(
                    self.clone(),
                    arg(&params, "installDir")?,
                    params
                        .get("assetName")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    params
                        .get("requestId")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    params
                        .get("stopCurrentService")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    serde_json::from_value(params.clone())
                        .map_err(|error| format!("ZIP 下载参数无效：{error}"))?,
                ))
            }
            "runtime_upgrade_status" => {
                value(runtime_upgrade::status(&self, arg(&params, "profileId")?))
            }
            "list_tasks" => value(list_tasks(&self)),
            "list_setup_handoffs" => value(setup_handoff::list(&self)),
            "resolve_setup_handoff" => {
                let task_id: String = arg(&params, "taskId")?;
                let config_path = params
                    .get("configPath")
                    .filter(|value| !value.is_null())
                    .map(|value| value.as_str().ok_or("configPath 必须为配置文件路径字符串"))
                    .transpose()?;
                value(setup_handoff::resolve(&self, &task_id, config_path))
            }
            "cancel_task" => value(cancel_task(&self, arg(&params, "taskId")?)),
            "read_config" => read_config(profile()?),
            "read_config_snapshot_v1" => value(storage::read_snapshot(&config_target()?)),
            "write_config" | "write_config_cas_v1" => {
                let _operation = self.runtime_operations.lock().map_err(|e| e.to_string())?;
                runtime_upgrade::assert_available(&self)?;
                tuning::assert_available(&self)?;
                external_management::assert_profile_manager_owned(&self, &profile()?)?;
                if self.selection_changing.load(Ordering::Acquire)
                    || self.shutting_down.load(Ordering::Acquire)
                {
                    return Err("后台正在切换模型或退出，请稍后保存".into());
                }
                if method == "write_config_cas_v1" {
                    let selected = config_target()?;
                    let config: Value = arg(&params, "config")?;
                    network::endpoint(&config, &selected)?;
                    let result = storage::write_cas(
                        &selected,
                        &config,
                        &arg::<String>(&params, "expectedRevision")?,
                    )?;
                    self.config_endpoint_after_save(&selected, &config)?;
                    value(Ok(result))
                } else {
                    let selected = profile()?;
                    let config: Value = arg(&params, "config")?;
                    network::endpoint(&config, &selected)?;
                    write_config(selected.clone(), config.clone())?;
                    self.config_endpoint_after_save(&selected, &config)?;
                    value(Ok(()))
                }
            }
            "write_markdown_export" => value(write_markdown_export(
                arg(&params, "path")?,
                arg(&params, "content")?,
            )),
            "list_local_models" => value(list_local_models(profile()?)),
            "export_diagnostics" => value(export_diagnostics(self.clone(), profile()?).await),
            "repair_python_dependencies" => {
                let install_dir: String = arg(&params, "installDir")?;
                value(
                    tokio::task::spawn_blocking(move || {
                        python_repair::repair_python_dependencies(&install_dir)
                    })
                    .await
                    .map_err(|e| e.to_string())?,
                )
            }
            "support_diagnostics_text" => {
                let extras = params
                    .get("extras")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                let selected = params
                    .get("profile")
                    .filter(|value| !value.is_null())
                    .map(|value| serde_json::from_value::<ServiceProfile>(value.clone()))
                    .transpose()
                    .map_err(|e| e.to_string())?;
                let state = self.clone();
                value(
                    tokio::task::spawn_blocking(move || {
                        support_diagnostics::support_diagnostics_text(
                            &state,
                            selected.as_ref(),
                            &extras,
                        )
                    })
                    .await
                    .map_err(|e| e.to_string())?,
                )
            }
            "strata_request" => {
                http::desktop_request(
                    &self,
                    profile()?,
                    arg(&params, "path")?,
                    arg(&params, "method")?,
                    params.get("body").filter(|v| !v.is_null()).cloned(),
                )
                .await
            }
            "discover_local" => {
                let directories: Vec<PathBuf> = params
                    .get("directories")
                    .filter(|v| !v.is_null())
                    .map(|v| serde_json::from_value(v.clone()).map_err(|e| e.to_string()))
                    .transpose()?
                    .unwrap_or_default();
                let registered = self.registered_profiles()?;
                let mut profiles = registered.clone();
                profiles.extend(self.original_profiles()?);
                let mut candidates = discovery::discover_local(&directories, &profiles)?;
                candidates.retain(|candidate| {
                    !registered.iter().any(|profile| {
                        let path = dunce::canonicalize(&candidate.config_path).ok();
                        path.is_some() && path == dunce::canonicalize(&profile.config_path).ok()
                    })
                });
                value(Ok(candidates))
            }
            "import_local" => value(self.import_local(arg(&params, "candidate")?)),
            "register_configuration_copy" => value(self.register_configuration_copy(
                arg(&params, "sourceProfileId")?,
                arg(&params, "profile")?,
            )),
            "ensure_local_service" => value(
                self.clone()
                    .ensure_local_service(arg(&params, "profileId")?)
                    .await,
            ),
            "switch_local_service" => value(
                self.clone()
                    .switch_local_service(arg(&params, "profileId")?)
                    .await,
            ),
            "local_installations" => {
                if !self.recovery_is_deferred() {
                    legacy::migrate(&self)?;
                }
                value(self.registered_profiles())
            }
            "local_installation_details" => {
                let originals = self.original_profiles()?;
                let records: Vec<Value> = self.registered_profiles()?.into_iter().map(|profile| {
                    let original = originals.iter().find(|item| item.id == profile.id);
                    let config = storage::read(&profile).ok().map(|value| discovery::display_config(&value));
                    let modified = fs::metadata(&profile.config_path).ok().and_then(|meta| meta.modified().ok())
                        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|time| time.as_millis() as u64);
                    json!({"profileId":profile.id,"originalConfigPath":original.map(|p| &p.config_path),"configModifiedAt":modified,"config":config})
                }).collect();
                value(Ok(records))
            }
            "local_installation_migration" => value(legacy::migrate(&self)),
            "analytics_query" => analytics::query(
                &self,
                params.get("query").cloned().unwrap_or_else(|| json!({})),
            ),
            "rename_local_installation" => value(
                self.rename_local_installation(arg(&params, "profileId")?, arg(&params, "name")?),
            ),
            "remove_local_installation" => {
                value(self.remove_local_installation(arg(&params, "profileId")?))
            }
            // Streaming HTTP stays in the UI process, but only the backend can
            // authorize its registered, live service. Legacy profiles remain
            // readable for discovery; they never authorize model mutations.
            "resolve_profile" => {
                let incoming: ServiceProfile = arg(&params, "profile")?;
                value(self.owned_gui_profile(&incoming.id))
            }
            _ => Err(format!("unknown_method: 不支持的后台方法 {method}")),
        }
    }

    fn import_local(&self, candidate: discovery::LocalCandidate) -> Result<ServiceProfile, String> {
        let _operation = self.runtime_operations.lock().map_err(|e| e.to_string())?;
        runtime_upgrade::assert_available(self)?;
        // The pure helper revalidates all candidate files; no caller-supplied
        // executable or URL becomes authoritative without this validation.
        let prepared = discovery::prepare_import(&candidate, &self.data_dir, None)?;
        self.register_import(prepared, None)
    }

    fn import_legacy_local(&self, previous: ServiceProfile) -> Result<ServiceProfile, String> {
        let _operation = self.runtime_operations.lock().map_err(|e| e.to_string())?;
        runtime_upgrade::assert_available(self)?;
        let prepared = discovery::prepare_legacy_import(&previous, &self.data_dir)?;
        self.register_import(prepared, Some(previous))
    }

    fn register_import(
        &self,
        mut prepared: discovery::PreparedImport,
        previous: Option<ServiceProfile>,
    ) -> Result<ServiceProfile, String> {
        for original in self.original_profiles()? {
            if dunce::canonicalize(&original.config_path).ok()
                == dunce::canonicalize(&prepared.original_config_path).ok()
                && dunce::canonicalize(&original.install_dir).ok()
                    == dunce::canonicalize(&prepared.original_profile.install_dir).ok()
            {
                if previous.as_ref().is_some_and(|p| p.id != original.id) {
                    return Err(format!(
                        "此安装已登记为 {}，保留旧档案避免丢失聊天关联",
                        original.id
                    ));
                }
                return self.registered_profile(&original.id);
            }
        }
        let originals = store_get(self, "profiles".into())?;
        let previous = previous.or_else(|| {
            originals
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|value| serde_json::from_value::<ServiceProfile>(value.clone()).ok())
                .find(|p| {
                    dunce::canonicalize(&p.config_path).ok()
                        == dunce::canonicalize(&prepared.original_config_path).ok()
                        && dunce::canonicalize(&p.install_dir).ok()
                            == dunce::canonicalize(&prepared.original_profile.install_dir).ok()
                        && !p.id.is_empty()
                        && p.id.len() <= 80
                        && p.id
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                })
        });
        if let Some(previous) = previous {
            prepared.profile.id = previous.id.clone();
            prepared.original_profile.id = previous.id;
            if !previous.name.trim().is_empty() {
                prepared.profile.name = previous.name;
            }
        }
        if self
            .registered_profiles()?
            .iter()
            .any(|p| p.id == prepared.profile.id)
        {
            return Err("旧档案标识已被另一款本机模型占用，未覆盖已有登记".into());
        }
        // Credentials are not sent back to the renderer or diagnostics. Keep the
        // old profile identifier when available so existing conversations and
        // OS-credential entries remain associated with the imported model.
        if http::key(&prepared.profile.id)?.is_none() {
            if let Some(secret) =
                service_sharing::import_client_key(&storage::read(&prepared.original_profile)?)
            {
                set_api_key(prepared.profile.id.clone(), secret)?;
            }
        }
        let mut database = self.database.lock().map_err(|e| e.to_string())?;
        let original =
            serde_json::to_string(&prepared.original_profile).map_err(|e| e.to_string())?;
        let serialized = serde_json::to_string(&prepared.profile).map_err(|e| e.to_string())?;
        let transaction = database.transaction().map_err(|e| e.to_string())?;
        transaction.execute("INSERT INTO local_installations(id,profile,original_profile,imported_at) VALUES(?1,?2,?3,?4)", rusqlite::params![prepared.profile.id,serialized,original,now() as i64]).map_err(|e| e.to_string())?;
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(prepared.profile)
    }

    /// Registers a copy that the desktop wrote next to a registered configuration.
    /// The copy is its own source; nothing is started or switched.
    fn register_configuration_copy(
        &self,
        source_id: String,
        copy: ServiceProfile,
    ) -> Result<ServiceProfile, String> {
        let _operation = self.runtime_operations.lock().map_err(|e| e.to_string())?;
        runtime_upgrade::assert_available(self)?;
        let source = self.registered_profile(&source_id)?;
        let profile = configuration_copy::prepare(&source, copy, &self.registered_profiles()?)?;
        let serialized = serde_json::to_string(&profile).map_err(|e| e.to_string())?;
        self.database
            .lock()
            .map_err(|e| e.to_string())?
            .execute(
                "INSERT INTO local_installations(id,profile,original_profile,imported_at) VALUES(?1,?2,?2,?3)",
                rusqlite::params![profile.id, serialized, now() as i64],
            )
            .map_err(|e| e.to_string())?;
        Ok(profile)
    }

    fn rename_local_installation(
        &self,
        id: String,
        name: String,
    ) -> Result<ServiceProfile, String> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 100 {
            return Err("名称需要 1–100 个字符".into());
        }
        let _operation = self.runtime_operations.lock().map_err(|e| e.to_string())?;
        let mut profile = self.registered_profile(&id)?;
        runtime_upgrade::assert_available(self)?;
        profile.name = name.into();
        self.database
            .lock()
            .map_err(|e| e.to_string())?
            .execute(
                "UPDATE local_installations SET profile=?1 WHERE id=?2",
                rusqlite::params![
                    serde_json::to_string(&profile).map_err(|e| e.to_string())?,
                    id
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(profile)
    }
    fn remove_local_installation(&self, id: String) -> Result<(), String> {
        let _operation = self.runtime_operations.lock().map_err(|e| e.to_string())?;
        runtime_upgrade::assert_available(self)?;
        if self
            .processes
            .lock()
            .map_err(|e| e.to_string())?
            .get_mut(&id)
            .map(|p| p.refresh())
            .transpose()?
            .is_some_and(|p| p.running)
        {
            return Err("本机模型仍由后台运行，请先停止后再移除登记".into());
        }
        if self
            .tasks
            .lock()
            .map_err(|e| e.to_string())?
            .values()
            .any(|task| task.profile_id.as_deref() == Some(&id) && task.status.state == "running")
        {
            return Err("该模型仍有后台任务，不能移除登记".into());
        }
        self.database
            .lock()
            .map_err(|e| e.to_string())?
            .execute("DELETE FROM local_installations WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        // Original repository, model assets, snapshots and history are retained.
        Ok(())
    }

    async fn ensure_local_service(
        self: Arc<Self>,
        profile_id: String,
    ) -> Result<ProcessStatus, String> {
        self.switch_local_service(profile_id).await
    }
    async fn switch_local_service(
        self: Arc<Self>,
        profile_id: String,
    ) -> Result<ProcessStatus, String> {
        let attempt_started_at = now();
        let result = self
            .clone()
            .switch_local_service_inner(profile_id.clone())
            .await;
        let result = self.record_startup_result(&profile_id, attempt_started_at, result)?;
        self.record_preparation_result(&profile_id, &result)?;
        result
    }
    fn record_startup_result(
        &self,
        profile_id: &str,
        attempt_started_at: u64,
        result: Result<ProcessStatus, String>,
    ) -> Result<Result<ProcessStatus, String>, String> {
        if profile_id.is_empty()
            || profile_id.len() > 80
            || !profile_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return Ok(result);
        }
        let diagnostic = match &result {
            Ok(_) => None,
            Err(error) => {
                let logs = self
                    .logs
                    .lock()
                    .map_err(|e| e.to_string())?
                    .get(profile_id)
                    .map(|entries| entries.iter().cloned().collect::<Vec<_>>())
                    .unwrap_or_default();
                // A diagnostic reads the recorded status; it does not refresh, stop or recover a child.
                let status = self
                    .processes
                    .lock()
                    .map_err(|e| e.to_string())?
                    .get(profile_id)
                    .map(|process| process.status.clone());
                Some(diagnostics::build(
                    profile_id,
                    attempt_started_at,
                    now(),
                    error,
                    &logs,
                    status.as_ref(),
                ))
            }
        };
        let mut database = self.database.lock().map_err(|e| e.to_string())?;
        let mut failures = store::get(&database, "localStartupFailures")?
            .as_object()
            .cloned()
            .unwrap_or_default();
        if let Some(diagnostic) = &diagnostic {
            failures.insert(
                profile_id.into(),
                serde_json::to_value(diagnostic).map_err(|e| e.to_string())?,
            );
        } else {
            failures.remove(profile_id);
        }
        store::set(
            &mut database,
            "localStartupFailures",
            Value::Object(failures),
        )?;
        Ok(match diagnostic {
            Some(diagnostic) => Err(diagnostics::encode(&diagnostic)),
            None => result,
        })
    }
    fn record_preparation_result(
        &self,
        profile_id: &str,
        result: &Result<ProcessStatus, String>,
    ) -> Result<(), String> {
        if profile_id.is_empty()
            || profile_id.len() > 80
            || !profile_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return Ok(());
        }
        let mut database = self.database.lock().map_err(|e| e.to_string())?;
        let mut failures = store::get(&database, "localPreparationFailures")?
            .as_object()
            .cloned()
            .unwrap_or_default();
        match result {
            Ok(_) => {
                failures.remove(profile_id);
            }
            Err(error) => {
                failures.insert(profile_id.into(),json!({"profileId":profile_id,"lastError":error.chars().take(2048).collect::<String>(),"failedAt":now(),"retryable":true,"phase":"prepare"}));
            }
        }
        store::set(
            &mut database,
            "localPreparationFailures",
            Value::Object(failures),
        )
    }
    fn preparation_error(&self, profile_id: &str) -> Result<Option<String>, String> {
        Ok(store_get(self, "localPreparationFailures".into())?
            .get(profile_id)
            .and_then(|entry| entry.get("lastError"))
            .and_then(Value::as_str)
            .map(String::from))
    }
    async fn switch_local_service_inner(
        self: Arc<Self>,
        profile_id: String,
    ) -> Result<ProcessStatus, String> {
        let _selection = self.selection_lock.lock().await;
        runtime_upgrade::assert_available(&self)?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("后台正在退出，未切换模型".into());
        }
        tuning::assert_available(&self)?;
        let target = self.registered_profile(&profile_id)?;
        external_management::assert_profile_manager_owned(&self, &target)?;
        let old = {
            let mut processes = self.processes.lock().map_err(|e| e.to_string())?;
            let mut running = Vec::new();
            for (id, process) in processes.iter_mut() {
                if id != &profile_id && process.refresh()?.running {
                    if let Some(profile) = &process.profile {
                        running.push(profile.clone());
                    }
                }
            }
            if running.len() > 1 {
                return Err("后台运行状态不符合单模型约束，请先修复后再切换".into());
            }
            running.pop()
        };
        if old.is_none() {
            *self.recovery.lock().map_err(|e| e.to_string())? = RecoveryStatus::default();
            store_set(&self, "activeLocalInstallation".into(), json!(profile_id))?;
            store_set(&self, "localServiceDesired".into(), json!(true))?;
        }
        // Configuration/Python checks occur while the old model remains available.
        let preflight = self.clone();
        let inspect = target.clone();
        let target_plan = tokio::task::spawn_blocking(move || {
            prepare_startup(&inspect, &Mutex::new(HashMap::new()), &preflight.tasks)
        })
        .await
        .map_err(|e| e.to_string())??;
        if let Some(previous) = &old {
            inspect_idle_http(&self, previous).await?;
        }
        if old.is_some() && external::port_accepting(&target_plan.profile)? {
            return Err(diagnostics::error(
                "STARTUP_PORT_IN_USE",
                "目标模型端口已被其它进程占用，保留当前模型",
                "prepare",
            ));
        }
        if old.is_some() {
            network::assert_bind_available(target_plan.listen_address)?;
        }
        self.selection_changing.store(true, Ordering::Release);
        struct SelectionFlag<'a>(&'a AtomicBool);
        impl Drop for SelectionFlag<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _flag = SelectionFlag(&self.selection_changing);
        tuning::assert_no_active_tuning(&self)?;
        *self.recovery.lock().map_err(|e| e.to_string())? = RecoveryStatus::default();
        if let Some(previous) = old {
            let gate = maintenance::begin(&self, &previous.id, None, "drain")?;
            maintenance::wait_idle(&self, &previous).await?;
            let (status, unloaded) = http::control_json(
                http::request_builder(&self.client, &previous, "/unload", "POST", Some(json!({})))?
                    .header("X-Strata-Manager-Maintenance-Token", gate.token()),
                Duration::from_secs(90),
            )
            .await?;
            if !status.is_success()
                || !matches!(unloaded["status"].as_str(), Some("unloaded" | "not loaded"))
            {
                return Err("当前模型未能安全卸载，保留原进程".into());
            }
            maintenance::wait_idle(&self, &previous).await?;
            stop_service(&self, previous.id.clone()).await?;
            drop(gate);
            let result = self.clone().ensure_runtime(profile_id.clone(), true).await;
            match result {
                Ok(status) => {
                    store_set(&self, "localServiceDesired".into(), json!(true))?;
                    Ok(status)
                }
                Err(error) => {
                    // The candidate has not been published as active. Cancel its
                    // controlled process before restoring the proven old model.
                    stop_service(&self, profile_id).await?;
                    self.clone()
                        .ensure_runtime(previous.id, true)
                        .await
                        .map_err(|rollback| {
                            diagnostics::with_context(
                                &error,
                                &format!(
                                    "切换失败；原模型恢复失败: {}",
                                    diagnostics::message(&rollback)
                                ),
                            )
                        })?;
                    Err(diagnostics::with_context(&error, "切换失败，已恢复原模型"))
                }
            }
        } else {
            // A failed first selection remains eligible for the finite recovery
            // policy; a failed switch never changes the selected installation.
            store_set(&self, "activeLocalInstallation".into(), json!(profile_id))?;
            store_set(&self, "localServiceDesired".into(), json!(true))?;
            self.clone().ensure_runtime(profile_id, true).await
        }
    }
    fn assert_single_model(&self, profile_id: &str) -> Result<(), String> {
        let mut processes = self.processes.lock().map_err(|e| e.to_string())?;
        for (id, process) in processes.iter_mut() {
            if id != profile_id && process.profile.is_some() && process.refresh()?.running {
                return Err(
                    "另一款本机模型正在后台运行，请先停止它再切换；未启动第二个GPU实例".into(),
                );
            }
        }
        Ok(())
    }
    async fn ensure_runtime(
        self: Arc<Self>,
        profile_id: String,
        load_model: bool,
    ) -> Result<ProcessStatus, String> {
        let attempt_started_at = now();
        let result = self
            .clone()
            .ensure_runtime_inner(profile_id.clone(), load_model)
            .await;
        let result = self.record_startup_result(&profile_id, attempt_started_at, result)?;
        self.record_preparation_result(&profile_id, &result)?;
        if result.as_ref().is_ok_and(|status| status.running) {
            self.clear_selection_recovery_load(&profile_id)?;
        }
        result
    }
    async fn ensure_runtime_inner(
        self: Arc<Self>,
        profile_id: String,
        load_model: bool,
    ) -> Result<ProcessStatus, String> {
        self.ensure_runtime_inner_with_deadline(profile_id, load_model, Duration::from_secs(180))
            .await
    }
    async fn ensure_runtime_inner_with_deadline(
        self: Arc<Self>,
        profile_id: String,
        load_model: bool,
        readiness_timeout: Duration,
    ) -> Result<ProcessStatus, String> {
        let lock = self
            .ensure_locks
            .lock()
            .await
            .entry(profile_id.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone();
        let _ensure = lock.lock().await;
        let profile = self.registered_profile(&profile_id)?;
        external_management::assert_profile_manager_owned(&self, &profile)?;
        processes::register_service_logs(&self.logs, &profile.id)?;
        processes::log(
            &self.logs,
            &profile.id,
            "info",
            "启动阶段：检查运行环境、配置与已有进程",
        );
        let state = self.clone();
        let startup_profile = profile.clone();
        tokio::task::spawn_blocking(move || {
            let _operation = state.runtime_operations.lock().map_err(|e| e.to_string())?;
            runtime_upgrade::assert_available(&state)?;
            external_management::assert_profile_manager_owned(&state, &startup_profile)?;
            if state.shutting_down.load(Ordering::Acquire) {
                return Err("后台正在退出，停止新服务启动".into());
            }
            tuning::assert_no_active_tuning(&state)?;
            state.assert_single_model(&startup_profile.id)?;
            if let Some(process) = state
                .processes
                .lock()
                .map_err(|e| e.to_string())?
                .get_mut(&startup_profile.id)
            {
                if process.refresh()?.running {
                    return Ok(());
                }
            }
            let original: ServiceProfile = {
                let database = state.database.lock().map_err(|e| e.to_string())?;
                let text: String = database
                    .query_row(
                        "SELECT original_profile FROM local_installations WHERE id=?1",
                        [&startup_profile.id],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                serde_json::from_str(&text).map_err(|e| e.to_string())?
            };
            let mut plan = prepare_startup(&startup_profile, &state.processes, &state.tasks)?;
            // Acquire before inspecting/unloading any observed external tree:
            // another Manager may own this installation under another dataDir.
            plan.claim_runtime()?;
            // Engine upgrades can change the registered runtime while retaining
            // its original installation as the migration source. Reserve that
            // source independently before touching its observed process.
            let original_root = dunce::canonicalize(&original.install_dir).map_err(|error| {
                diagnostics::io_error(&error, "无法核验原运行环境托管目录", "prepare")
            })?;
            let _original_runtime_lease = if original_root != plan.root {
                Some(processes::acquire_runtime_lease(&original_root)?)
            } else {
                None
            };
            let secret = http::key(&startup_profile.id)?;
            if let Some(instance) = external::detect(&original)? {
                // Import is the single migration boundary. A running original
                // installation is stopped only after the exact existing process,
                // listener and idle state have been revalidated repeatedly.
                tokio::runtime::Handle::current().block_on(inspect_idle_http(&state, &original))?;
                instance.stop_verified_tree(&original, || {
                    tokio::runtime::Handle::current().block_on(async {
                        inspect_idle_http(&state, &original).await?;
                        instance.revalidate(&original)?;
                        let result = http::strata_request(
                            &state,
                            original.clone(),
                            "/unload".into(),
                            "POST".into(),
                            Some(json!({})),
                        )
                        .await?;
                        if !matches!(
                            result.get("status").and_then(Value::as_str),
                            Some("unloaded" | "not loaded")
                        ) {
                            return Err("迁移时无法确认安全卸载，保留原进程".into());
                        }
                        inspect_idle_http(&state, &original).await
                    })
                })?;
                processes::log(
                    &state.logs,
                    &startup_profile.id,
                    "info",
                    "已有安装核验并安全迁移到独立后台；原配置和启动脚本保留",
                );
            } else if discovery::has_running_installation(Path::new(&original.install_dir))? {
                return Err(
                    "同一 Strata 目录有其他配置的实例正在运行；保留已有实例，未启动第二个模型"
                        .into(),
                );
            }
            start_prepared_service(&state, startup_profile, plan, secret)?;
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| e.to_string())??;
        let profile = self.registered_profile(&profile_id)?;
        processes::log(
            &self.logs,
            &profile.id,
            "info",
            "启动阶段：等待本机 API 响应",
        );
        let deadline = std::time::Instant::now() + readiness_timeout;
        loop {
            let status = {
                let mut processes = self.processes.lock().map_err(|e| e.to_string())?;
                processes
                    .get_mut(&profile.id)
                    .ok_or("后台启动记录丢失")?
                    .refresh()?
            };
            if !status.running {
                return Err(diagnostics::error(
                    "STARTUP_PROCESS_EXITED",
                    format!(
                        "本机服务启动后退出，exit {:?}；请查看诊断日志",
                        status.exit_code
                    ),
                    "starting",
                ));
            }
            // Startup probes must remain short: the normal request timeout is
            // intended for user requests and would stall progress for 90 seconds.
            let health = async {
                let response =
                    http::request_builder(&self.client, &profile, "/health", "GET", None)?
                        .timeout(Duration::from_secs(2))
                        .send()
                        .await
                        .map_err(|e| e.to_string())?;
                if !response.status().is_success() {
                    if matches!(response.status().as_u16(), 401 | 403) {
                        return Err(diagnostics::error(
                            if response.status().as_u16() == 401 {
                                "STARTUP_AUTH_REQUIRED"
                            } else {
                                "STARTUP_FORBIDDEN"
                            },
                            format!(
                                "本机 API 返回 HTTP {}；请检查连接凭据，启动进程仍保留",
                                response.status().as_u16()
                            ),
                            "starting",
                        ));
                    }
                    return Err("API 尚未就绪".to_string());
                }
                response.json::<Value>().await.map_err(|e| e.to_string())
            }
            .await;
            if let Err(error) = &health {
                if serde_json::from_str::<Value>(error)
                    .ok()
                    .is_some_and(|value| {
                        matches!(
                            value["code"].as_str(),
                            Some("STARTUP_AUTH_REQUIRED" | "STARTUP_FORBIDDEN")
                        )
                    })
                {
                    return Err(error.clone());
                }
            }
            if let Ok(health) = health {
                if health.get("service").and_then(Value::as_str) != Some("strata")
                    || health.get("status").and_then(Value::as_str) != Some("ok")
                {
                    return Err(diagnostics::error(
                        "STARTUP_WRONG_SERVICE",
                        "端口响应不是已核验的 Strata 服务",
                        "starting",
                    ));
                }
                if load_model && health.get("loaded").and_then(Value::as_bool) != Some(true) {
                    processes::log(
                        &self.logs,
                        &profile.id,
                        "info",
                        "启动阶段：本机 API 已就绪，正在加载模型；以下显示引擎实际输出",
                    );
                    // A cold load can outlast the /load request timeout while the engine
                    // is still working; only a real exit or rejection fails the start.
                    let load_started = types::now();
                    let python_facts = processes::launcher_env(&profile)
                        .map(|env| model_load_wait::PythonFacts::from_launcher(&env))
                        .unwrap_or_else(|_| model_load_wait::PythonFacts {
                            python: profile.python_path.clone(),
                            allowed: vec![profile.install_dir.clone()],
                        });
                    model_load_wait::wait_for_model_load_checked(
                        http::strata_request(
                            &self,
                            profile.clone(),
                            "/load".into(),
                            "POST".into(),
                            Some(json!({})),
                        ),
                        || {
                            let request = http::request_builder(
                                &self.client,
                                &profile,
                                "/health",
                                "GET",
                                None,
                            );
                            async move {
                                request?
                                    .timeout(Duration::from_secs(5))
                                    .send()
                                    .await
                                    .map_err(|e| format!("HTTP 请求失败: {e}"))?
                                    .error_for_status()
                                    .map_err(|e| format!("HTTP 请求失败: {e}"))?
                                    .json::<Value>()
                                    .await
                                    .map_err(|e| e.to_string())
                            }
                        },
                        || {
                            let mut processes = self.processes.lock().map_err(|e| e.to_string())?;
                            let status = processes
                                .get_mut(&profile.id)
                                .ok_or("后台启动记录丢失")?
                                .refresh()?;
                            Ok((!status.running).then_some(status.exit_code))
                        },
                        |exited| {
                            // #78: classify a failed /load from the process state
                            // and the engine's stderr since the load started.
                            let tail: Vec<String> = {
                                let logs = self.logs.lock().ok()?;
                                logs.get(&profile.id)?
                                    .iter()
                                    .filter(|entry| {
                                        entry.timestamp >= load_started && entry.level == "stderr"
                                    })
                                    .map(|entry| entry.message.clone())
                                    .collect()
                            };
                            let tail: Vec<&str> = tail.iter().map(String::as_str).collect();
                            let start = tail.len().saturating_sub(400);
                            let failure = model_load_wait::classify_load_failure(
                                exited,
                                &tail[start..],
                                &python_facts,
                            );
                            model_load_wait::load_failure_error(&failure, &python_facts)
                        },
                        |line| processes::log(&self.logs, &profile.id, "info", &line),
                        model_load_wait::LoadWait::STARTUP,
                    )
                    .await?;
                }
                store_set(
                    &self,
                    "activeLocalInstallation".into(),
                    Value::String(profile.id.clone()),
                )?;
                processes::log(
                    &self.logs,
                    &profile.id,
                    "info",
                    if load_model {
                        "启动阶段：模型已就绪，可以聊天和使用 API"
                    } else {
                        "启动阶段：本机 API 已就绪"
                    },
                );
                return Ok(status);
            }
            if std::time::Instant::now() >= deadline {
                return Err(diagnostics::error(
                    "STARTUP_API_TIMEOUT",
                    format!(
                        "本机 API {} 秒内未就绪；启动进程仍保留，请查看启动日志和显存/内存状态",
                        readiness_timeout.as_secs()
                    ),
                    "starting",
                ));
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }

    pub fn cleanup(&self) {
        let _operation = self.runtime_operations.lock();
        if let Ok(mut tasks) = self.tasks.lock() {
            for task in tasks.values_mut() {
                if task.status.state != "running" {
                    continue;
                }
                task.cancelled = true;
                if let Some(process) = task.process.as_mut() {
                    let _ = process.stop();
                    let deadline = std::time::Instant::now() + Duration::from_millis(500);
                    while process.readers_pending.load(Ordering::Acquire) > 0
                        && std::time::Instant::now() < deadline
                    {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
                task.status.state = "cancelled".into();
                task.status.finished_at = Some(now());
                task.status.message =
                    "后台退出，已停止本应用拥有的任务进程；半成品保留供重试".into();
                processes::log(
                    &self.logs,
                    &task.status.id,
                    "cancelled",
                    &task.status.message,
                );
                let _ = processes::persist_task(&self.database, task);
                let _ = processes::persist_task_logs(&self.database, &self.logs, &task.status.id);
            }
        }
        if let Ok(mut processes) = self.processes.lock() {
            for process in processes.values_mut() {
                let _ = process.stop();
            }
            processes.clear();
            if let Ok(mut listeners) = self.owned_listeners.lock() {
                listeners.clear();
            }
        }
    }
}

fn store_get(state: &RuntimeState, key: String) -> Result<Value, String> {
    let database = state.database.lock().map_err(|e| e.to_string())?;
    store::get(&database, &key)
}
fn store_set(state: &RuntimeState, key: String, value: Value) -> Result<(), String> {
    let mut database = state.database.lock().map_err(|e| e.to_string())?;
    store::set(&mut database, &key, value)
}
fn set_api_key(profile_id: String, api_key: String) -> Result<(), String> {
    if profile_id.is_empty() || profile_id.len() > 256 {
        return Err("profileId 无效".into());
    }
    let entry = keyring::Entry::new("io.strata.manager", &profile_id).map_err(|e| e.to_string())?;
    if api_key.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    } else {
        entry
            .set_password(&api_key)
            .map_err(|e| format!("凭据库写入失败: {e}"))
    }
}
fn has_api_key(profile_id: String) -> Result<bool, String> {
    Ok(http::key(&profile_id)?.is_some())
}

async fn start_service(
    state: Arc<RuntimeState>,
    profile: ServiceProfile,
) -> Result<ProcessStatus, String> {
    tokio::task::spawn_blocking(move || {
        let _operation = state.runtime_operations.lock().map_err(|e| e.to_string())?;
        runtime_upgrade::assert_available(&state)?;
        start_service_locked(&state, profile)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A tuning launch is tied to one live registry entry and the selected import.
/// Dropping its async caller invalidates only this launch, including a blocking
/// closure that has not reached its last pre-spawn check yet.
struct TuningServiceOperation {
    job_id: String,
    profile: ServiceProfile,
    cancel: tokio_util::sync::CancellationToken,
}
impl TuningServiceOperation {
    fn validate_identity(&self, state: &RuntimeState) -> Result<(), String> {
        if self.cancel.is_cancelled() || state.shutting_down.load(Ordering::Acquire) {
            return Err("调优服务操作已过期，未启动或停止任何其它服务".into());
        }
        runtime_upgrade::assert_available(state)?;
        if state.selection_changing.load(Ordering::Acquire)
            || store_get(state, "activeLocalInstallation".into())?.as_str()
                != Some(self.profile.id.as_str())
        {
            return Err("调优模型选择已改变，旧服务操作已拒绝".into());
        }
        let registered = state.registered_profile(&self.profile.id)?;
        if serde_json::to_value(&registered).map_err(|e| e.to_string())?
            != serde_json::to_value(&self.profile).map_err(|e| e.to_string())?
        {
            return Err("调优安装身份已改变，旧服务操作已拒绝".into());
        }
        tuning::assert_current_service_operation(state, &self.job_id, &self.profile.id)
    }
    fn validate(&self, state: &RuntimeState) -> Result<(), String> {
        self.validate_identity(state)?;
        state.assert_single_model(&self.profile.id)
    }
    fn validate_processes(
        &self,
        state: &RuntimeState,
        processes: &mut HashMap<String, OwnedProcess>,
    ) -> Result<(), String> {
        self.validate_identity(state)?;
        for (id, process) in processes.iter_mut() {
            if id != &self.profile.id && process.profile.is_some() && process.refresh()?.running {
                return Err("另一款本机模型正在后台运行，调优未启动第二个实例".into());
            }
        }
        Ok(())
    }
}

pub(crate) async fn start_service_for_tuning(
    state: Arc<RuntimeState>,
    profile: ServiceProfile,
    job_id: &str,
    parent_cancel: &tokio_util::sync::CancellationToken,
) -> Result<ProcessStatus, String> {
    tuning_service_operation(state, profile, job_id, parent_cancel, false).await
}

pub(crate) async fn restart_service_for_tuning(
    state: Arc<RuntimeState>,
    profile: ServiceProfile,
    job_id: &str,
    parent_cancel: &tokio_util::sync::CancellationToken,
) -> Result<ProcessStatus, String> {
    tuning_service_operation(state, profile, job_id, parent_cancel, true).await
}

async fn tuning_service_operation(
    state: Arc<RuntimeState>,
    profile: ServiceProfile,
    job_id: &str,
    parent_cancel: &tokio_util::sync::CancellationToken,
    restart: bool,
) -> Result<ProcessStatus, String> {
    let cancel = parent_cancel.child_token();
    let _invalidate_on_return_or_drop = cancel.clone().drop_guard();
    let operation = TuningServiceOperation {
        job_id: job_id.to_owned(),
        profile,
        cancel,
    };
    tokio::task::spawn_blocking(move || {
        // Do not leave an expired launch parked behind a long synchronous task.
        let _runtime_operation = state
            .runtime_operations
            .try_lock()
            .map_err(|_| "其它后台操作正在进行，调优服务操作未排队")?;
        operation.validate(&state)?;
        let secret = http::key(&operation.profile.id)?;
        let plan = prepare_startup(&operation.profile, &state.processes, &state.tasks)?;
        if plan.profile.base_url != operation.profile.base_url {
            return Err("网络地址设置尚未重启生效，请先重启模型服务后再运行调优".into());
        }
        #[cfg(test)]
        let _test_phase =
            tuning_service_operation_tests::pause_after_preparation(&operation.job_id);
        operation.validate(&state)?;
        #[cfg(windows)]
        let mut retired_listeners = Vec::new();
        if restart {
            let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
            operation.validate_processes(&state, &mut processes)?;
            let process = processes
                .get_mut(&operation.profile.id)
                .ok_or("调优重启没有受管进程记录，请使用受管启动")?;
            if process.profile.as_ref().map(|p| &p.id) != Some(&operation.profile.id)
                || !process.status.owned
            {
                return Err("调优重启目标不属于此登记安装，未停止".into());
            }
            // Handles remain the authority even when the root has died. This
            // also releases descendants of this owned tree, never a PID guess.
            operation.validate_identity(&state)?;
            if process.refresh()?.running {
                let old_endpoint = network::endpoint(&json!({}), &operation.profile)?;
                let owned_listener = state
                    .owned_listeners
                    .lock()
                    .map_err(|e| e.to_string())?
                    .get(&operation.profile.id)
                    .copied()
                    .unwrap_or(old_endpoint.listen_address);
                network::assert_replacement_bind_available(plan.listen_address, owned_listener)?;
            }
            #[cfg(windows)]
            for listener in external::listener_ids(&operation.profile)? {
                if !process.owns_pid(listener)? {
                    return Err("调优重启目标端口有外部监听进程，原受管服务仍保留".into());
                }
                retired_listeners.push(listener);
            }
            process.stop()?;
            state.forget_owned_listener(&operation.profile.id)?;
        }
        #[cfg(windows)]
        if restart && !retired_listeners.is_empty() {
            // Windows can briefly retain a LISTEN row/socket after the held
            // Job has no active members. Wait only for listeners proven to
            // belong to that Job before termination. A new owner is left to
            // the normal external-port guard; never terminate a searched PID.
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            loop {
                operation.validate(&state)?;
                let listeners = external::listener_ids(&operation.profile)?;
                if listeners.iter().any(|pid| !retired_listeners.contains(pid)) {
                    return Err(format!(
                        "端口 {} 出现新的外部监听进程，未启动或终止任何外部服务",
                        plan.port
                    ));
                }
                if listeners.is_empty()
                    && std::net::TcpStream::connect_timeout(
                        &plan.address,
                        Duration::from_millis(100),
                    )
                    .is_err()
                {
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    return Err("原受管监听端口仍在释放，未启动替代服务；请稍后重试恢复".into());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        operation.validate(&state)?;
        start_prepared_service_checked(
            &state,
            operation.profile.clone(),
            plan,
            secret,
            Some(&operation),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

struct StartupPlan {
    root: PathBuf,
    config: PathBuf,
    python: String,
    launcher: launcher_env::LauncherEnv,
    host: String,
    port: u16,
    #[cfg(windows)]
    address: std::net::SocketAddr,
    listen_address: std::net::SocketAddr,
    lazy_cli: bool,
    config_value: Value,
    profile: ServiceProfile,
    runtime_lease: Option<strata_local_ipc::SingleInstance>,
}

impl StartupPlan {
    fn claim_runtime(&mut self) -> Result<(), String> {
        if self.runtime_lease.is_none() {
            self.runtime_lease = Some(processes::acquire_runtime_lease(&self.root)?);
        }
        Ok(())
    }
}

/// The engine path upstream `serve/server.py` will start: `exe` as written
/// when absolute, else joined to the config's `cwd` (itself relative to the
/// Strata folder, which is the server's working directory).
fn configured_engine_path(root: &Path, config: &Value) -> Option<PathBuf> {
    let exe = config.get("exe").and_then(Value::as_str)?;
    let exe_path = Path::new(exe);
    if exe_path.is_absolute() {
        return Some(exe_path.to_path_buf());
    }
    let base = match config.get("cwd").and_then(Value::as_str) {
        Some(cwd) if Path::new(cwd).is_absolute() => PathBuf::from(cwd),
        Some(cwd) if !cwd.is_empty() => root.join(cwd),
        _ => root.to_path_buf(),
    };
    Some(base.join(exe_path))
}

fn check_engine_exe(root: &Path, config: &Value) -> Result<(), String> {
    let Some(engine) = configured_engine_path(root, config) else {
        return Ok(());
    };
    if engine.is_file() {
        return Ok(());
    }
    let elsewhere = discovery::engine_beside(root, &engine)
        .map(|found| format!("；目录里有 {}，但配置没有指向它", found.display()))
        .unwrap_or_default();
    #[cfg(windows)]
    let repair = "START-HERE.bat --setup";
    #[cfg(not(windows))]
    let repair = "./setup.sh --setup";
    Err(diagnostics::error(
        "STARTUP_ENGINE_MISSING",
        format!(
            "模型配置里的引擎文件不存在：{}{elsewhere}。Strata 会严格按配置的 exe 启动引擎，直接启动只会在加载模型时报错（WinError 2）；请在该 Strata 目录运行 {repair} 修复配置后重新扫描",
            engine.display()
        ),
        "prepare",
    ))
}

/// The same interpreter and environment the folder's launchers use (#78),
/// checked to really start Python 3.
fn resolve_startup_python(
    profile: &ServiceProfile,
    root: &Path,
) -> Result<launcher_env::LauncherEnv, String> {
    let saved = profile.python_path.trim();
    let resolved = launcher_env::resolve(root, Some(saved), |path| {
        path.is_absolute()
            && path.is_file()
            && output_with_timeout(
                &path.to_string_lossy(),
                &["-c", "import sys; print(sys.version_info.major)"],
                Duration::from_secs(20),
            )
            .as_deref()
                == Some("3")
    });
    match resolved {
        Ok(env) => Ok(env),
        Err(error) => {
            // Keep the precise historical diagnostics for a hand-picked Python
            // on a folder without its own environment.
            if !saved.is_empty() && !launcher_env::has_own_environment(root) {
                let path = Path::new(saved);
                if path.is_absolute() {
                    if let Err(io) = fs::metadata(path) {
                        return Err(diagnostics::io_error(&io, "无法读取所选 Python", "prepare"));
                    }
                }
                if !path.is_absolute() || !path.is_file() {
                    return Err(diagnostics::error(
                        "STARTUP_CONFIG_INVALID",
                        "所选 Python 必须是存在的可执行文件绝对路径",
                        "prepare",
                    ));
                }
                return Err(diagnostics::error(
                    "STARTUP_PYTHON_UNAVAILABLE",
                    "所选 Python 无法运行 Python 3（权限不足、文件无效或探测超时）",
                    "prepare",
                ));
            }
            Err(diagnostics::error(
                "STARTUP_PYTHON_UNAVAILABLE",
                error,
                "prepare",
            ))
        }
    }
}

fn prepare_startup(
    profile: &ServiceProfile,
    processes: &Mutex<HashMap<String, OwnedProcess>>,
    tasks: &Tasks,
) -> Result<StartupPlan, String> {
    if profile.managed && Path::new(&profile.install_dir).is_absolute() {
        fs::metadata(&profile.install_dir)
            .map_err(|error| diagnostics::io_error(&error, "无法读取运行环境目录", "prepare"))?;
        for relative in ["setup.py", "serve/server.py"] {
            fs::File::open(Path::new(&profile.install_dir).join(relative)).map_err(|error| {
                diagnostics::io_error(
                    &error,
                    &format!("无法读取运行环境文件 {relative}"),
                    "prepare",
                )
            })?;
        }
    }
    let root = processes::runtime_dir(profile)
        .map_err(|error| diagnostics::error("STARTUP_CONFIG_INVALID", error, "prepare"))?;
    if Path::new(&profile.config_path).is_absolute() {
        fs::File::open(&profile.config_path)
            .map_err(|error| diagnostics::io_error(&error, "无法读取模型配置文件", "prepare"))?;
    }
    let config_value = storage::read(profile)
        .map_err(|error| diagnostics::error("STARTUP_CONFIG_INVALID", error, "prepare"))?;
    storage::validate(&config_value)
        .map_err(|error| diagnostics::error("STARTUP_CONFIG_INVALID", error, "prepare"))?;
    let endpoint = network::endpoint(&config_value, profile)
        .map_err(|error| diagnostics::error("STARTUP_CONFIG_INVALID", error, "prepare"))?;
    let mut effective_profile = profile.clone();
    effective_profile.base_url = endpoint.base_url;
    if config_value.get("exe").is_none() || config_value.get("args").is_none() {
        return Err(diagnostics::error(
            "STARTUP_CONFIG_INVALID",
            "Strata 模型配置需要 exe 和 args 字段",
            "prepare",
        ));
    }
    let config = storage::config_path(profile)?;
    // This upstream version's /config refuses lazy_load on vision models while
    // its explicit CLI --lazy supports both engine and encoder. Use that verified
    // entry point, leaving the imported config's vision settings untouched.
    let lazy_cli = fs::read_to_string(root.join("serve/server.py")).is_ok_and(|source| {
        source.lines().any(|line| {
            line.contains("add_argument(\"--lazy\"") || line.contains("add_argument('--lazy'")
        })
    });
    // The engine binary is started by upstream server.py exactly as the config
    // names it (abs, or relative to the config's cwd). A missing file only
    // shows up on the first /load as WinError 2 inside the HTTP handler (#78).
    check_engine_exe(&root, &config_value)?;
    let launcher = resolve_startup_python(profile, &root)?;
    let python = launcher.python.to_string_lossy().to_string();
    if tasks.lock().map_err(|e| e.to_string())?.values().any(|t| {
        (t.profile_id.as_deref() == Some(&profile.id) || t.runtime_path.as_ref() == Some(&root))
            && t.status.state == "running"
    }) {
        return Err("安装/更新任务进行中，暂时不能启动或重启".into());
    }
    let mut processes = processes.lock().map_err(|e| e.to_string())?;
    for (id, process) in processes.iter_mut() {
        if id != &profile.id
            && process.refresh()?.running
            && process
                .profile
                .as_ref()
                .and_then(|p| dunce::canonicalize(&p.install_dir).ok())
                .as_ref()
                == Some(&root)
        {
            return Err("同一运行环境已由另一档案启动；请先停止该受管服务".into());
        }
    }
    Ok(StartupPlan {
        root,
        config,
        python,
        launcher,
        host: endpoint.host,
        port: endpoint.port,
        #[cfg(windows)]
        address: endpoint.address,
        listen_address: endpoint.listen_address,
        lazy_cli,
        config_value,
        profile: effective_profile,
        runtime_lease: None,
    })
}

fn start_service_locked(
    state: &RuntimeState,
    profile: ServiceProfile,
) -> Result<ProcessStatus, String> {
    let plan = prepare_startup(&profile, &state.processes, &state.tasks)?;
    let secret = http::key(&profile.id)?;
    start_prepared_service(state, profile, plan, secret)
}

fn start_prepared_service(
    state: &RuntimeState,
    profile: ServiceProfile,
    plan: StartupPlan,
    secret: Option<String>,
) -> Result<ProcessStatus, String> {
    start_prepared_service_checked(state, profile, plan, secret, None)
}

fn start_prepared_service_checked(
    state: &RuntimeState,
    profile: ServiceProfile,
    mut plan: StartupPlan,
    _secret: Option<String>,
    operation: Option<&TuningServiceOperation>,
) -> Result<ProcessStatus, String> {
    external_management::assert_profile_manager_owned(state, &profile)?;
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
    if let Some(operation) = operation {
        operation.validate_processes(state, &mut processes)?;
    }
    if let Some(process) = processes.get_mut(&profile.id) {
        let status = process.refresh()?;
        if status.running {
            return Ok(status);
        }
        state.forget_owned_listener(&profile.id)?;
    }
    // Legacy/direct starts pass unclaimed plans. Migration paths pass the
    // already-held lease, which must survive until the spawned tree takes it.
    plan.claim_runtime()?;
    if external::port_accepting(&plan.profile)? {
        return Err(diagnostics::error(
            "STARTUP_PORT_IN_USE",
            format!(
                "端口 {} 已被外部进程占用，未启动或终止任何外部服务",
                plan.port
            ),
            "starting",
        ));
    }
    // In particular, a foreign LAN-only listener need not answer loopback.
    // Reject its conflict before touching GPU limits or spawning a child.
    network::assert_bind_available(plan.listen_address)?;
    let profile = plan.profile.clone();
    maintenance::clear_abandoned(state, &profile)?;
    let mut command = Command::new(&plan.python);
    command
        .current_dir(&plan.root)
        .args(["-u", "-m", "serve.server", "--engine", "strata", "--config"])
        .arg(plan.config)
        .args(["--host", &plan.host, "--port", &plan.port.to_string()])
        .env("PYTHONUNBUFFERED", "1")
        .env("STRATA_REQUEST_LINES", "1");
    if plan.lazy_cli {
        command.arg("--lazy");
    }
    // Client vault credentials authorize Manager HTTP calls; they must never
    // override this service's own api_key (including arrays) through inheritance.
    command.env_remove("STRATA_API_KEY");
    let observer = observer::install_bootstrap(&state.data_dir)?;
    #[cfg(target_os = "linux")]
    command.env(
        "STRATA_MANAGER_MCP_HELPER",
        std::env::current_exe().map_err(|e| e.to_string())?,
    );
    // Same interpreter environment as the folder's run-*.bat (#78): venv /
    // embedded PATH, the launcher's own variables, no host PYTHONHOME; the
    // observer's sitecustomize stays first on PYTHONPATH.
    plan.launcher.apply(&mut command, Some(&observer));
    processes::log(&state.logs, &profile.id, "info", plan.launcher.describe());
    if let Some(note) = &plan.launcher.ignored {
        processes::log(&state.logs, &profile.id, "info", note);
    }
    command
        .env(
            "STRATA_MANAGER_ANALYTICS_DIR",
            state.data_dir.join("analytics"),
        )
        .env("STRATA_MANAGER_SERVICE_ID", &profile.id);
    if let Some(operation) = operation {
        operation.validate_processes(state, &mut processes)?;
    }
    let mut gpu_power_lease = gpu_power::GpuPowerLease::apply(&plan.config_value)?;
    storage::mark_engine_log_session(&profile);
    let mut process = match OwnedProcess::spawn(command, state.logs.clone(), &profile.id) {
        Ok(process) => process,
        Err(error) => {
            if let Some(lease) = &mut gpu_power_lease {
                lease
                    .restore()
                    .map_err(|cleanup| format!("{error}；{cleanup}"))?;
            }
            return Err(error);
        }
    };
    process.gpu_power_lease = gpu_power_lease;
    process.runtime_lease = plan.runtime_lease.take();
    process.profile = Some(profile.clone());
    if let Some(operation) = operation {
        if let Err(error) = operation.validate_processes(state, &mut processes) {
            // This local handle was created by this invocation and is not yet
            // published. Never stop an existing entry during expiration cleanup.
            process
                .stop()
                .map_err(|cleanup| format!("{error}；本次子进程清理失败：{cleanup}"))?;
            return Err(error);
        }
    }
    let status = process.status.clone();
    if let Err(error) = state.save_registered_endpoint(&profile) {
        process.stop()?;
        return Err(format!("服务地址登记失败，本次进程已停止：{error}"));
    }
    match state.owned_listeners.lock() {
        Ok(mut listeners) => {
            listeners.insert(profile.id.clone(), plan.listen_address);
        }
        Err(error) => {
            process.stop()?;
            return Err(format!("监听地址记录失败，本次进程已停止：{error}"));
        }
    }
    processes.insert(profile.id.clone(), process);
    processes::log(
        &state.logs,
        &profile.id,
        "info",
        format!(
            "受管 API 进程已启动，PID {:?}；HTTP 就绪和模型加载由健康探测确认",
            status.pid
        ),
    );
    Ok(status)
}
async fn stop_service(state: &RuntimeState, profile_id: String) -> Result<ProcessStatus, String> {
    runtime_upgrade::assert_available(state)?;
    let profile = {
        let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
        match processes.get_mut(&profile_id) {
            Some(process) => {
                if !process.refresh()?.running {
                    state.forget_owned_listener(&profile_id)?;
                    return Ok(process.status.clone());
                }
                #[cfg(windows)]
                if let Some(profile) = &process.profile {
                    let listeners = match external::listener_ids(profile) {
                        Ok(listeners) => listeners,
                        Err(error) => {
                            processes::log(
                                &state.logs,
                                &profile_id,
                                "info",
                                format!(
                                    "端口所有权核验失败：{error}；跳过 HTTP 卸载并仅停止受管进程树"
                                ),
                            );
                            process.stop()?;
                            state.forget_owned_listener(&profile_id)?;
                            return Ok(process.status.clone());
                        }
                    };
                    let mut owned_listener = !listeners.is_empty();
                    for listener in listeners {
                        owned_listener &= process.owns_pid(listener)?;
                    }
                    if !owned_listener {
                        processes::log(
                            &state.logs,
                            &profile_id,
                            "info",
                            "旧端口未确认属于受管进程，跳过 HTTP 卸载并只停止本应用拥有的进程树",
                        );
                        process.stop()?;
                        state.forget_owned_listener(&profile_id)?;
                        return Ok(process.status.clone());
                    }
                }
                process.profile.clone()
            }
            None => {
                state.forget_owned_listener(&profile_id)?;
                return Ok(ProcessStatus::default());
            }
        }
    };
    if let Some(profile) = profile {
        let request =
            http::request_builder(&state.client, &profile, "/unload", "POST", Some(json!({})));
        match request {
            Ok(request) => match request.timeout(Duration::from_secs(5)).send().await {
                Ok(response) => processes::log(
                    &state.logs,
                    &profile_id,
                    "info",
                    format!(
                        "停止前卸载请求 HTTP {}；随后停止本应用拥有的 API 进程树",
                        response.status()
                    ),
                ),
                Err(error) => processes::log(
                    &state.logs,
                    &profile_id,
                    "info",
                    format!("卸载请求未完成: {error}；继续停止本应用拥有的进程树"),
                ),
            },
            Err(error) => processes::log(
                &state.logs,
                &profile_id,
                "info",
                format!("卸载请求无法创建: {error}；继续停止本应用拥有的进程树"),
            ),
        }
    }
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
    let Some(process) = processes.get_mut(&profile_id) else {
        state.forget_owned_listener(&profile_id)?;
        return Ok(ProcessStatus::default());
    };
    process.stop()?;
    state.forget_owned_listener(&profile_id)?;
    processes::log(&state.logs, &profile_id, "info", "受管服务进程树已停止");
    Ok(process.status.clone())
}
async fn inspect_idle_http(state: &RuntimeState, profile: &ServiceProfile) -> Result<(), String> {
    async fn read(
        state: &RuntimeState,
        profile: &ServiceProfile,
        path: &str,
    ) -> Result<Value, String> {
        let response = http::request_builder(&state.client, profile, path, "GET", None)?
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(|e| format!("接管前HTTP核验失败: {e}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "接管前鉴权/状态核验失败：HTTP {}",
                response.status()
            ));
        }
        if response
            .content_length()
            .is_some_and(|length| length > 512 * 1024)
        {
            return Err("服务核验状态超过大小限制".into());
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        use futures_util::StreamExt;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            if bytes.len() + chunk.len() > 512 * 1024 {
                return Err("服务核验状态超过大小限制".into());
            }
            bytes.extend(chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| "服务核验状态不是有效JSON".into())
    }
    let status = read(state, profile, "/v1/status").await?;
    let metrics = read(state, profile, "/metrics").await?;
    external::ensure_idle(&status, &metrics)
}

async fn service_status(
    state: Arc<RuntimeState>,
    profile_id: String,
    profile: Option<ServiceProfile>,
) -> Result<ProcessStatus, String> {
    let preparation_error = state.preparation_error(&profile_id)?;
    {
        let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
        if let Some(process) = processes.get_mut(&profile_id) {
            let mut status = process.refresh()?;
            if !status.running {
                state.forget_owned_listener(&profile_id)?;
            }
            if status.running || profile.is_none() {
                status.reason = preparation_error;
                return Ok(status);
            }
        }
    }
    let Some(profile) = profile else {
        return Ok(ProcessStatus {
            reason: preparation_error,
            ..ProcessStatus::default()
        });
    };
    if profile.id != profile_id {
        return Err("profileId 与档案不一致".into());
    }
    let observed = state
        .original_profiles()?
        .into_iter()
        .find(|original| original.id == profile_id)
        .unwrap_or_else(|| profile.clone());
    tokio::task::spawn_blocking(move || match external::detect(&observed) {
        Ok(Some(instance)) => {
            let reason = if !profile.managed {
                Err("请先将档案设为本地受管，并填写运行环境/Python/配置路径".into())
            } else {
                assert_stopped(&state, &profile).and_then(|_| {
                    prepare_startup(&profile, &state.processes, &state.tasks)?;
                    http::key(&profile.id)?;
                    tokio::runtime::Handle::current().block_on(inspect_idle_http(&state, &observed))
                })
            };
            Ok(ProcessStatus {
                running: true,
                owned: false,
                pid: Some(instance.pid),
                external: Some(true),
                can_take_over: Some(reason.is_ok()),
                reason: reason.err().or(preparation_error),
                creation_time: Some(instance.created.to_string()),
                ..ProcessStatus::default()
            })
        }
        Ok(None) => Ok(ProcessStatus {
            reason: preparation_error,
            ..ProcessStatus::default()
        }),
        Err(reason) => {
            let running = external::port_accepting(&observed)
                .map_err(|error| format!("{reason}; {error}"))?;
            Ok(ProcessStatus {
                running,
                owned: false,
                external: Some(running),
                can_take_over: Some(false),
                reason: Some(reason),
                ..ProcessStatus::default()
            })
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn restart_service(
    state: Arc<RuntimeState>,
    profile: ServiceProfile,
) -> Result<ProcessStatus, String> {
    tokio::task::spawn_blocking(move || {
        let _operation = state.runtime_operations.lock().map_err(|e| e.to_string())?;
        runtime_upgrade::assert_available(&state)?;
        external_management::assert_profile_manager_owned(&state, &profile)?;
        let secret = http::key(&profile.id)?;
        let plan = prepare_owned_restart(
            &profile,
            &state.processes,
            &state.tasks,
            &state.owned_listeners,
        )?;
        start_prepared_service(&state, profile, plan, secret)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn prepare_owned_restart(
    profile: &ServiceProfile,
    processes: &Mutex<HashMap<String, OwnedProcess>>,
    tasks: &Tasks,
    owned_listeners: &Mutex<HashMap<String, std::net::SocketAddr>>,
) -> Result<StartupPlan, String> {
    let plan = prepare_startup(profile, processes, tasks)?;
    #[cfg(windows)]
    let mut retired_listeners = Vec::new();
    {
        let mut records = processes.lock().map_err(|e| e.to_string())?;
        if let Some(process) = records.get_mut(&profile.id) {
            if !process.refresh()?.running {
                owned_listeners
                    .lock()
                    .map_err(|e| e.to_string())?
                    .remove(&profile.id);
            } else {
                let old = process
                    .profile
                    .as_ref()
                    .ok_or("重启目标不是已登记的受管服务")?;
                let old_endpoint = network::endpoint(&json!({}), old)?;
                let owned_listener = owned_listeners
                    .lock()
                    .map_err(|e| e.to_string())?
                    .get(&profile.id)
                    .copied();
                network::assert_replacement_bind_available(
                    plan.listen_address,
                    owned_listener.unwrap_or(old_endpoint.listen_address),
                )?;
                #[cfg(windows)]
                for listener in external::listener_ids(&plan.profile)? {
                    if !process.owns_pid(listener)? {
                        return Err("重启目标端口有外部监听进程，原受管服务仍保留".into());
                    }
                    retired_listeners.push(listener);
                }
            }
        }
    }
    processes::stop_owned_for_restart(processes, &profile.id)?;
    owned_listeners
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&profile.id);
    #[cfg(windows)]
    if !retired_listeners.is_empty() {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let listeners = external::listener_ids(&plan.profile)?;
            if listeners.iter().any(|pid| !retired_listeners.contains(pid)) {
                return Err("目标端口出现新的外部监听进程，未启动替代服务".into());
            }
            if listeners.is_empty() {
                break;
            }
            if std::time::Instant::now() >= deadline {
                return Err("原受管端口仍在释放，请稍后重试重启".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    Ok(plan)
}

async fn take_over_service(
    state: Arc<RuntimeState>,
    profile: ServiceProfile,
) -> Result<ProcessStatus, String> {
    tokio::task::spawn_blocking(move || {
        let _operation = state.runtime_operations.lock().map_err(|e| e.to_string())?;
        runtime_upgrade::assert_available(&state)?;
        external_management::assert_profile_manager_owned(&state, &profile)?;
        assert_stopped(&state, &profile)?;
        let mut plan = prepare_startup(&profile, &state.processes, &state.tasks)?;
        plan.claim_runtime()?;
        let secret = http::key(&profile.id)?;
        let instance = external::detect(&profile)?.ok_or("没有可接管的本机Strata实例")?;
        tokio::runtime::Handle::current().block_on(inspect_idle_http(&state, &profile))?;
        instance.stop_verified_tree(&profile, || {
            tokio::runtime::Handle::current().block_on(async {
                inspect_idle_http(&state, &profile).await?;
                instance.revalidate(&profile)?;
                let response = http::request_builder(
                    &state.client,
                    &profile,
                    "/unload",
                    "POST",
                    Some(json!({})),
                )?
                .timeout(Duration::from_secs(10))
                .send()
                .await
                .map_err(|e| format!("接管前卸载失败，未停止实例: {e}"))?;
                if !response.status().is_success() {
                    return Err(format!(
                        "接管前卸载被拒绝，未停止实例：HTTP {}",
                        response.status()
                    ));
                }
                let result: Value = response
                    .json()
                    .await
                    .map_err(|_| "卸载状态不可确认，未停止实例")?;
                if !matches!(
                    result.get("status").and_then(Value::as_str),
                    Some("unloaded" | "not loaded")
                ) {
                    return Err("实例仍忙碌或不支持安全卸载，未停止实例".into());
                }
                inspect_idle_http(&state, &profile).await
            })
        })?;
        processes::register_service_logs(&state.logs, &profile.id)?;
        processes::log(
            &state.logs,
            &profile.id,
            "info",
            format!(
                "显式接管：已核验外部Strata PID {}，创建时间 {}；开始受管重启",
                instance.pid, instance.created
            ),
        );
        start_prepared_service(&state, profile, plan, secret)
    })
    .await
    .map_err(|e| e.to_string())?
}
pub(crate) fn read_logs(
    state: &RuntimeState,
    profile: ServiceProfile,
    limit: usize,
) -> Result<Vec<LogEntry>, String> {
    let (source_id, is_task) = {
        let tasks = state.tasks.lock().map_err(|e| e.to_string())?;
        match tasks.get(&profile.id) {
            Some(_) => (profile.id.clone(), true),
            None => (profile.id.clone(), false),
        }
    };
    let logs = state.logs.lock().map_err(|e| e.to_string())?;
    let mut entries: Vec<LogEntry> = logs
        .get(&source_id)
        .map(|entries| {
            entries
                .iter()
                .skip(entries.len().saturating_sub(limit.min(2000)))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    drop(logs);
    if is_task && entries.is_empty() {
        entries = processes::saved_task_logs(&state.database, &profile.id)?;
    }
    if !profile.config_path.trim().is_empty() {
        entries.extend(storage::engine_logs(&profile, limit)?);
    }
    entries.sort_by_key(|entry| entry.timestamp);
    if entries.len() > limit.min(2000) {
        entries.drain(..entries.len() - limit.min(2000));
    }
    Ok(entries)
}

pub(crate) fn output(program: &str, args: &[&str]) -> Option<String> {
    output_with_timeout(program, args, Duration::from_secs(3))
}

/// Like [`output`], with a caller-chosen deadline. Python probes on Windows can
/// exceed three seconds on a cold start (venv redirector plus antivirus scans).
pub(crate) fn output_with_timeout(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> Option<String> {
    let logs: Logs = Default::default();
    let mut command = Command::new(program);
    command.args(args);
    let mut process = OwnedProcess::spawn(command, logs.clone(), "probe").ok()?;
    let deadline = std::time::Instant::now() + timeout;
    let success = loop {
        let status = process.refresh().ok()?;
        if !status.running {
            break status.exit_code == Some(0);
        }
        if std::time::Instant::now() >= deadline {
            let _ = process.stop();
            return None;
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    let pending = process.readers_pending.clone();
    drop(process);
    let drain_deadline = std::time::Instant::now() + Duration::from_millis(500);
    while pending.load(Ordering::Acquire) > 0 && std::time::Instant::now() < drain_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    if !success {
        return None;
    }
    let logs = logs.lock().ok()?;
    let text = logs
        .get("probe")
        .map(|entries| {
            entries
                .iter()
                .filter(|log| log.level == "stdout")
                .map(|log| log.message.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    Some(
        text.chars()
            .take(8192)
            .collect::<String>()
            .trim()
            .to_owned(),
    )
}
fn collect_environment() -> EnvironmentInfo {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    system.refresh_cpu_all();
    let gpus: Vec<String> = output(
        "nvidia-smi",
        &[
            "--query-gpu=name,driver_version,memory.total",
            "--format=csv,noheader",
        ],
    )
    .map(|text| text.lines().map(str::to_owned).collect())
    .unwrap_or_default();
    #[cfg(windows)]
    let mut gpus = gpus;
    #[cfg(windows)]
    if gpus.is_empty() {
        gpus = display_adapters::windows_gpu_names().unwrap_or_default();
    }
    // macOS has no nvidia-smi: Apple Silicon GPUs come from system_profiler/IOKit (unified memory).
    let gpu_details = if gpus.is_empty() && cfg!(target_os = "macos") {
        apple_gpu::probe(system.total_memory())
    } else {
        Vec::new()
    };
    let gpus = if gpus.is_empty() {
        gpu_details
            .iter()
            .map(apple_gpu::environment_line)
            .collect()
    } else {
        gpus
    };
    EnvironmentInfo {
        os: sysinfo::System::long_os_version().unwrap_or_else(|| std::env::consts::OS.into()),
        arch: std::env::consts::ARCH.into(),
        cpu_name: system
            .cpus()
            .first()
            .map(|cpu| cpu.brand().into())
            .unwrap_or_default(),
        total_memory: system.total_memory(),
        available_memory: system.available_memory(),
        gpus,
        gpu_details,
        python: output("py", &["--version"])
            .or_else(|| output("python", &["--version"]))
            .or_else(|| output("python3", &["--version"])),
        python_managed: false,
        git: output("git", &["--version"]),
        app_version: env!("CARGO_PKG_VERSION").into(),
    }
}
pub(crate) fn cached_environment(state: &RuntimeState) -> EnvironmentInfo {
    if let Ok(cache) = state.environment_cache.lock() {
        if let Some((time, info)) = cache.as_ref() {
            if now().saturating_sub(*time) < 60_000 {
                return info.clone();
            }
        }
    }
    let mut info = collect_environment();
    // Report the interpreter Strata will actually use after a one-click install.
    if let Some(python) = installation::managed_python::installed_interpreter(state.data_dir()) {
        if let Some(version) = output(&python.to_string_lossy(), &["--version"]) {
            info.python = Some(version);
            info.python_managed = true;
        }
    }
    if let Ok(mut cache) = state.environment_cache.lock() {
        *cache = Some((now(), info.clone()));
    }
    info
}
async fn environment_info(state: Arc<RuntimeState>) -> Result<EnvironmentInfo, String> {
    tokio::task::spawn_blocking(move || cached_environment(&state))
        .await
        .map_err(|e| e.to_string())
}

pub(crate) fn assert_stopped(state: &RuntimeState, profile: &ServiceProfile) -> Result<(), String> {
    let root = processes::runtime_dir(profile)?;
    if state
        .tasks
        .lock()
        .map_err(|e| e.to_string())?
        .values()
        .any(|task| {
            task.status.state == "running"
                && (task.profile_id.as_deref() == Some(&profile.id)
                    || task.runtime_path.as_ref() == Some(&root))
        })
    {
        return Err("同一运行环境已有安装/配置/更新任务；请等待或取消".into());
    }
    for (id, process) in state
        .processes
        .lock()
        .map_err(|e| e.to_string())?
        .iter_mut()
    {
        if (id == &profile.id
            || process
                .profile
                .as_ref()
                .and_then(|p| dunce::canonicalize(&p.install_dir).ok())
                .as_ref()
                == Some(&root))
            && process.refresh()?.running
        {
            return Err("请先停止受管 API 服务再安装或更新运行环境".into());
        }
    }
    Ok(())
}
/// 「使用已有模型」(#75): the optional `localModel` of run_setup / setup_disk_preflight.
fn local_model_param(params: &Value) -> Result<Option<local_model::LocalModelRequest>, String> {
    params
        .get("localModel")
        .filter(|v| !v.is_null())
        .cloned()
        .map(serde_json::from_value::<local_model::LocalModelRequest>)
        .transpose()
        .map_err(|e| format!("已有模型参数无效: {e}"))
}

#[allow(clippy::too_many_arguments)]
fn run_setup_with_options(
    state: Arc<RuntimeState>,
    profile: ServiceProfile,
    model: String,
    quant: String,
    context: u32,
    images: bool,
    options: crate::setup_options::SetupOptions,
    local: Option<local_model::LocalModelRequest>,
) -> Result<TaskStatus, String> {
    // An existing model is used in place: `--gguf-dir <folder>`, and `--data-dir <folder holding mtp/rt>`.
    run_setup_with_preflight_options(
        state,
        profile,
        model,
        quant,
        context,
        images,
        move |profile, family, quant, images| {
            disk::plan_with_local(profile, family, quant, images, local.as_ref())
        },
        Some(options),
    )
}

#[cfg(test)]
fn run_setup_with_preflight(
    state: Arc<RuntimeState>,
    profile: ServiceProfile,
    model: String,
    quant: String,
    context: u32,
    images: bool,
    preflight: impl FnOnce(&ServiceProfile, &str, &str, bool) -> Result<disk::Plan, String>,
) -> Result<TaskStatus, String> {
    run_setup_with_preflight_options(
        state, profile, model, quant, context, images, preflight, None,
    )
}

fn engine_version_at_least(version: Option<&str>, need: &[u32]) -> bool {
    let Some(version) = version else {
        return false;
    };
    let parts: Vec<u32> = version
        .trim()
        .trim_start_matches('v')
        .trim_start_matches('V')
        .split(|c: char| !c.is_ascii_digit())
        .filter(|p| !p.is_empty())
        .filter_map(|p| p.parse().ok())
        .collect();
    for (i, required) in need.iter().enumerate() {
        let have = parts.get(i).copied().unwrap_or(0);
        if have > *required {
            return true;
        }
        if have < *required {
            return false;
        }
    }
    true
}

#[allow(clippy::too_many_arguments)]
fn run_setup_with_preflight_options(
    state: Arc<RuntimeState>,
    profile: ServiceProfile,
    model: String,
    quant: String,
    context: u32,
    images: bool,
    preflight: impl FnOnce(&ServiceProfile, &str, &str, bool) -> Result<disk::Plan, String>,
    options: Option<crate::setup_options::SetupOptions>,
) -> Result<TaskStatus, String> {
    let options = options.map(|options| options.validated()).transpose()?;
    let _operation = state.runtime_operations.lock().map_err(|e| e.to_string())?;
    runtime_upgrade::assert_available(&state)?;
    external_management::assert_profile_manager_owned(&state, &profile)?;
    let root = processes::runtime_dir(&profile)?;
    assert_stopped(&state, &profile)?;
    if !(512..=1_048_576).contains(&context) {
        return Err("context 必须为 512–1048576；实际容量由安装器检查内存和模型决定".into());
    }
    let supported = local_model::setup_supports(&model, &quant);
    if !supported {
        return Err("模型 family / quant 组合不被已核实的官方安装器支持".into());
    }
    if model == "qwen36" {
        let version = discovery::runtime_version(&root, None);
        if !engine_version_at_least(version.as_deref(), &[0, 1, 45]) {
            return Err(format!(
                "Qwen3.6-35B-A3B 需要引擎 0.1.45 或更新版本（当前：{}）；请先更新 Strata",
                version.as_deref().unwrap_or("未知")
            ));
        }
    }
    if options
        .as_ref()
        .is_some_and(|options| options.gpu_roles.is_some())
        && !crate::setup_options::setup_supports_gpu_roles(&root)
    {
        return Err("这个运行环境的官方安装器不支持显卡角色（--gpu-roles 需要 Strata 0.2.2 或更新版本）；请先更新运行环境，或改用“指定显卡”".into());
    }
    let disk_plan = preflight(&profile, &model, &quant, images)?;
    disk_plan.require_space()?;
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .starts_with("strata-")
            && path.extension().is_some_and(|x| x == "json")
        {
            storage::backup(&path)?;
        }
    }
    let url = http::endpoint(&profile, "/health")?;
    let (setup_python, mut steps) = processes::setup_python(&profile, &root)?;
    let intent = setup_handoff::SetupIntent {
        profile: profile.clone(),
        family: model.clone(),
        quant: quant.clone(),
        context,
        images,
    };
    let mut args = vec![
        "-u".into(),
        "setup.py".into(),
        "--yes".into(),
        "--setup".into(),
        "--no-start".into(),
        "--no-browser".into(),
        "--family".into(),
        model,
        "--model".into(),
        quant,
        "--context".into(),
        context.to_string(),
        "--vision".into(),
        if images { "yes" } else { "no" }.into(),
        "--port".into(),
        url.port_or_known_default().unwrap_or(8080).to_string(),
        "--data-dir".into(),
        disk_plan.data_directory.to_string_lossy().into_owned(),
    ];
    if let Some(options) = &options {
        options.append_args(&mut args)?;
    }
    if let Some(directory) = disk_plan.gguf_directory {
        args.extend([
            "--gguf-dir".into(),
            directory.to_string_lossy().into_owned(),
        ]);
    }
    let step = Step {
        program: setup_python,
        args,
        cwd: root,
        env: options
            .as_ref()
            .map(|options| options.environment())
            .transpose()?
            .unwrap_or_default(),
    };
    steps.push(step);
    processes::launch_setup_task(state.clone(), intent, steps)
}
fn orca_memory() -> (u64, u64) {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    (system.total_memory(), system.available_memory())
}
fn orca_import_plan(
    profile: &ServiceProfile,
    request: orca_import::OrcaImportRequest,
) -> Result<orca_import::OrcaImportPlan, String> {
    let root = processes::runtime_dir(profile)?;
    Ok(orca_import::prepare(&root, &request, &disk::settings()?, orca_memory(), true)?.plan)
}
/// ORCA.md's manual compatibility workflow as one tracked setup task; registration reuses the setup handoff
/// (family "orca", model_name orcarouter-qwen3.8-flash-next-uncensored-iq3_xxs, 32K, text only).
fn run_orca_import(
    state: Arc<RuntimeState>,
    profile: ServiceProfile,
    request: orca_import::OrcaImportRequest,
    options: Option<crate::setup_options::SetupOptions>,
) -> Result<TaskStatus, String> {
    let options = options.map(|options| options.validated()).transpose()?;
    let _operation = state.runtime_operations.lock().map_err(|e| e.to_string())?;
    runtime_upgrade::assert_available(&state)?;
    external_management::assert_profile_manager_owned(&state, &profile)?;
    let root = processes::runtime_dir(&profile)?;
    assert_stopped(&state, &profile)?;
    let prepared = orca_import::prepare(&root, &request, &disk::settings()?, orca_memory(), true)?;
    if prepared.plan.status != "ready" {
        return Err(format!(
            "未启动 OrcaRouter 导入：{}",
            prepared.plan.problems.join("；")
        ));
    }
    storage::backup(&root.join(orca_import::CONFIG_FILE))?;
    let url = http::endpoint(&profile, "/health")?;
    let env = options
        .as_ref()
        .map(|options| options.environment())
        .transpose()?
        .unwrap_or_default();
    let steps = orca_import::steps(&prepared, env, url.port_or_known_default().unwrap_or(8080));
    let intent = setup_handoff::SetupIntent {
        profile,
        family: orca_import::FAMILY.into(),
        quant: orca_import::QUANT.into(),
        context: orca_import::CONTEXT,
        images: false,
    };
    processes::launch_setup_task(state.clone(), intent, steps)
}
fn install_runtime(state: &RuntimeState, directory: String) -> Result<TaskStatus, String> {
    let _operation = state.runtime_operations.lock().map_err(|e| e.to_string())?;
    runtime_upgrade::assert_available(state)?;
    processes::launch_install(
        state.tasks.clone(),
        state.logs.clone(),
        state.database.clone(),
        Path::new(&directory),
    )
}
fn list_tasks(state: &RuntimeState) -> Result<Vec<TaskStatus>, String> {
    let mut statuses: Vec<_> = state
        .tasks
        .lock()
        .map_err(|e| e.to_string())?
        .values()
        .map(|t| t.status.clone())
        .collect();
    statuses.sort_by_key(|t| std::cmp::Reverse(t.started_at));
    Ok(statuses)
}
fn cancel_task(state: &RuntimeState, task_id: String) -> Result<(), String> {
    let mut tasks = state.tasks.lock().map_err(|e| e.to_string())?;
    let record = tasks.get_mut(&task_id).ok_or("任务不存在")?;
    if record.status.state != "running" {
        return Ok(());
    }
    record.cancelled = true;
    if let Some(process) = record.process.as_mut() {
        process.stop()?;
    }
    Ok(())
}
fn read_config(profile: ServiceProfile) -> Result<Value, String> {
    storage::read(&profile)
}
fn write_config(profile: ServiceProfile, config: Value) -> Result<(), String> {
    storage::write(&profile, &config)
}
fn write_markdown_export(path: String, content: String) -> Result<String, String> {
    storage::write_markdown_export(Path::new(&path), &content)?;
    Ok(path)
}
fn list_local_models(profile: ServiceProfile) -> Result<Vec<LocalModel>, String> {
    storage::local_models(&profile)
}
fn export_diagnostics_blocking(
    state: &RuntimeState,
    profile: ServiceProfile,
) -> Result<String, String> {
    let mut config = storage::read(&profile).unwrap_or_else(|e| json!({"readError":e}));
    storage::redact(&mut config);
    let process = state
        .processes
        .lock()
        .map_err(|e| e.to_string())?
        .get_mut(&profile.id)
        .map(|p| p.refresh())
        .transpose()?
        .unwrap_or_default();
    let revision = output("git", &["-C", &profile.install_dir, "rev-parse", "HEAD"]);
    let logs = state.logs.lock().map_err(|e| e.to_string())?;
    // Raw child output can contain third-party MCP credentials. Export counts and levels,
    // never freeform raw log bodies or request bodies; UI logs remain local and user-readable.
    let log_summary: Vec<Value> = logs
        .get(&profile.id)
        .map(|entries| {
            entries
                .iter()
                .rev()
                .take(100)
                .map(|l| json!({"timestamp":l.timestamp,"level":l.level}))
                .collect()
        })
        .unwrap_or_default();
    drop(logs);
    let diagnostic = store_get(state, "localStartupFailures".into())?
        .get(&profile.id)
        .cloned()
        .map(|mut value| {
            if let Some(object) = value.as_object_mut() {
                object.remove("evidence");
                object.remove("message");
            }
            value
        });
    let mut report = json!({"generatedAt":now(),"environment":cached_environment(state),"profile":profile,"config":config,"process":process,"runtimeRevision":revision,"startupDiagnostic":diagnostic,"logSummary":log_summary,"logPolicy":"Raw log and request bodies omitted to prevent leaking MCP or API credentials"});
    storage::redact(&mut report);
    let directory = state.data_dir.join("diagnostics");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let path = directory.join(format!("strata-diagnostics-{}.json", now()));
    fs::write(
        &path,
        serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into())
}

async fn export_diagnostics(
    state: Arc<RuntimeState>,
    profile: ServiceProfile,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || export_diagnostics_blocking(&state, profile))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
#[path = "tuning_service_operation_tests.rs"]
mod tuning_service_operation_tests;

#[cfg(test)]
mod native_probe_tests {
    use super::*;

    struct RuntimeLeaseCleanup(Vec<Arc<RuntimeState>>);
    impl Drop for RuntimeLeaseCleanup {
        fn drop(&mut self) {
            for state in &self.0 {
                state.cleanup();
            }
        }
    }

    fn runtime_lease_fixture(root: &Path) -> String {
        fs::create_dir_all(root.join("serve")).unwrap();
        fs::write(root.join("setup.py"), b"").unwrap();
        fs::write(
            root.join("serve/server.py"),
            br#"
import argparse, json, subprocess, sys, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
p=argparse.ArgumentParser();p.add_argument('--host');p.add_argument('--port',type=int);p.add_argument('--config')
a,_=p.parse_known_args();config=json.loads(Path(a.config).read_text())
if config.get('exit_root_marker'):
 child=subprocess.Popen([sys.executable,'-I','-S','-c','import time;time.sleep(60)'])
 Path(config['exit_root_marker']).write_text(str(child.pid));sys.exit(0)
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  if config.get('request_marker'):Path(config['request_marker']).write_text(self.path)
  self.send_response(200);self.end_headers();self.wfile.write(json.dumps({'service':'strata','status':'ok','loaded':True}).encode())
 def do_POST(self):
  if config.get('request_marker'):Path(config['request_marker']).write_text(self.path)
  self.send_response(200);self.end_headers();self.wfile.write(b'{"status":"unloaded"}')
 def log_message(self,*args):pass
ThreadingHTTPServer((a.host,a.port),Handler).serve_forever()
"#,
        )
        .unwrap();
        if let Some(selected) = std::env::var_os("STRATA_MANAGER_TEST_PYTHON") {
            return selected.to_string_lossy().into();
        }
        test_python_executable().expect("runtime lease fixture requires Python")
    }

    /// Resolves the interpreter for test fixtures without the 3 s production
    /// probe deadline: a cold `py` launcher on a loaded Windows runner can
    /// exceed it.
    fn test_python_executable() -> Option<String> {
        if let Some(selected) = std::env::var_os("STRATA_MANAGER_TEST_PYTHON") {
            return Some(selected.to_string_lossy().into());
        }
        let out = std::process::Command::new(if cfg!(windows) { "py" } else { "python3" })
            .args(["-c", "import sys;print(sys.executable)"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (out.status.success() && !text.is_empty()).then_some(text)
    }

    fn runtime_lease_profile(root: &Path, python: &str, config: &Path) -> ServiceProfile {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let profile = ServiceProfile {
            id: format!("runtime-lease-{}", uuid::Uuid::new_v4()),
            name: "CPU runtime lease fixture".into(),
            install_dir: root.to_string_lossy().into(),
            config_path: config.to_string_lossy().into(),
            python_path: python.into(),
            base_url: format!("http://127.0.0.1:{port}"),
            managed: true,
        };
        // The configured engine must exist: startup checks it like server.py starts it (#78).
        fs::write(root.join("fixture"), b"engine fixture, never started").unwrap();
        fs::write(
            config,
            serde_json::to_vec(&json!({"exe":"fixture","args":[],"port":port})).unwrap(),
        )
        .unwrap();
        profile
    }

    #[test]
    fn runtime_lease_blocks_two_data_stores_until_owned_tree_stops() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runtime");
        let python = runtime_lease_fixture(&root);
        let first = RuntimeState::open(temp.path().join("data-first")).unwrap();
        let second = RuntimeState::open(temp.path().join("data-second")).unwrap();
        let _cleanup = RuntimeLeaseCleanup(vec![first.clone(), second.clone()]);
        let first_profile = runtime_lease_profile(&root, &python, &root.join("first.json"));
        let mut second_profile = runtime_lease_profile(&root, &python, &root.join("second.json"));
        second_profile.install_dir = root.join(".").to_string_lossy().into();
        register_gui_fixture(&first, &first_profile);
        register_gui_fixture(&second, &second_profile);
        let first_plan = prepare_startup(&first_profile, &first.processes, &first.tasks).unwrap();
        let second_plan =
            prepare_startup(&second_profile, &second.processes, &second.tasks).unwrap();
        // Read-only preparation must not reserve a running-model lease.
        assert!(
            strata_local_ipc::SingleInstance::acquire_scoped(&root, "managed-model-runtime")
                .is_ok()
        );
        start_prepared_service(&first, first_profile.clone(), first_plan, None).unwrap();
        let blocked = start_prepared_service(&second, second_profile.clone(), second_plan, None)
            .expect_err("different data stores must not start models in the same runtime");
        let value: Value = serde_json::from_str(&blocked).unwrap();
        assert_eq!(value["code"], "STARTUP_RUNTIME_ALREADY_MANAGED");
        assert!(second.processes.lock().unwrap().is_empty());
        {
            let mut processes = first.processes.lock().unwrap();
            let owned = processes.get_mut(&first_profile.id).unwrap();
            assert!(owned.refresh().unwrap().running);
            owned.stop().unwrap();
            assert!(!owned.tree_running().unwrap());
        }
        let second_plan =
            prepare_startup(&second_profile, &second.processes, &second.tasks).unwrap();
        assert!(
            start_prepared_service(&second, second_profile.clone(), second_plan, None)
                .unwrap()
                .running
        );
        let removed = second
            .processes
            .lock()
            .unwrap()
            .remove(&second_profile.id)
            .unwrap();
        drop(removed);
        assert!(
            strata_local_ipc::SingleInstance::acquire_scoped(&root, "managed-model-runtime")
                .is_ok()
        );
    }

    #[test]
    fn runtime_lease_allows_different_installations_and_releases_after_root_tree_exit() {
        let temp = tempfile::tempdir().unwrap();
        let first_root = temp.path().join("runtime-first");
        let second_root = temp.path().join("runtime-second");
        let python = runtime_lease_fixture(&first_root);
        runtime_lease_fixture(&second_root);
        let first = RuntimeState::open(temp.path().join("data-first")).unwrap();
        let second = RuntimeState::open(temp.path().join("data-second")).unwrap();
        let _cleanup = RuntimeLeaseCleanup(vec![first.clone(), second.clone()]);
        let first_profile =
            runtime_lease_profile(&first_root, &python, &first_root.join("config.json"));
        let second_profile =
            runtime_lease_profile(&second_root, &python, &second_root.join("config.json"));
        let marker = first_root.join("child.pid");
        let mut config = storage::read(&first_profile).unwrap();
        config["exit_root_marker"] = json!(marker);
        fs::write(
            &first_profile.config_path,
            serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
        for (state, profile) in [(&first, &first_profile), (&second, &second_profile)] {
            register_gui_fixture(state, profile);
            let plan = prepare_startup(profile, &state.processes, &state.tasks).unwrap();
            assert!(
                start_prepared_service(state, profile.clone(), plan, None)
                    .unwrap()
                    .running
            );
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !marker.exists() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        let mut processes = first.processes.lock().unwrap();
        let owned = processes.get_mut(&first_profile.id).unwrap();
        assert!(owned.child.wait().unwrap().success());
        assert!(strata_local_ipc::SingleInstance::acquire_scoped(
            &first_root,
            "managed-model-runtime"
        )
        .is_err());
        assert!(!owned.refresh().unwrap().running);
        assert!(!owned.tree_running().unwrap());
        assert!(strata_local_ipc::SingleInstance::acquire_scoped(
            &first_root,
            "managed-model-runtime"
        )
        .is_ok());
        assert!(
            second
                .processes
                .lock()
                .unwrap()
                .get_mut(&second_profile.id)
                .unwrap()
                .refresh()
                .unwrap()
                .running
        );
    }

    #[tokio::test]
    async fn runtime_lease_blocks_migration_and_takeover_before_foreign_http_or_stop() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runtime");
        let python = runtime_lease_fixture(&root);
        let owner = RuntimeState::open(temp.path().join("owner")).unwrap();
        let competitor = RuntimeState::open(temp.path().join("competitor")).unwrap();
        let _cleanup = RuntimeLeaseCleanup(vec![owner.clone(), competitor.clone()]);
        let profile = runtime_lease_profile(&root, &python, &root.join("config.json"));
        let request_marker = root.join("foreign-request.txt");
        let mut config = storage::read(&profile).unwrap();
        config["request_marker"] = json!(request_marker);
        fs::write(&profile.config_path, serde_json::to_vec(&config).unwrap()).unwrap();
        register_gui_fixture(&owner, &profile);
        register_gui_fixture(&competitor, &profile);
        let plan = prepare_startup(&profile, &owner.processes, &owner.tasks).unwrap();
        start_prepared_service(&owner, profile.clone(), plan, None).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !external::port_accepting(&profile).unwrap() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        let startup = competitor
            .clone()
            .ensure_runtime(profile.id.clone(), true)
            .await
            .unwrap_err();
        let diagnostic: Value = serde_json::from_str(&startup).unwrap();
        assert_eq!(diagnostic["code"], "STARTUP_RUNTIME_ALREADY_MANAGED");
        assert_eq!(
            diagnostic["details"]["startupDiagnostic"]["category"],
            "config"
        );
        assert_eq!(
            diagnostic["details"]["startupDiagnostic"]["confidence"],
            "confirmed"
        );
        let takeover = take_over_service(competitor.clone(), profile.clone())
            .await
            .unwrap_err();
        assert_eq!(
            serde_json::from_str::<Value>(&takeover).unwrap()["code"],
            "STARTUP_RUNTIME_ALREADY_MANAGED"
        );
        assert!(
            !request_marker.exists(),
            "a competing backend must not probe or unload the owner"
        );
        assert!(competitor.processes.lock().unwrap().is_empty());
        assert!(
            owner
                .processes
                .lock()
                .unwrap()
                .get_mut(&profile.id)
                .unwrap()
                .refresh()
                .unwrap()
                .running
        );
    }

    #[tokio::test]
    async fn runtime_lease_blocks_original_environment_migration_after_installation_upgrade() {
        let temp = tempfile::tempdir().unwrap();
        let original_root = temp.path().join("original-runtime");
        let upgraded_root = temp.path().join("upgraded-runtime");
        let python = runtime_lease_fixture(&original_root);
        runtime_lease_fixture(&upgraded_root);
        let owner = RuntimeState::open(temp.path().join("original-owner")).unwrap();
        let competitor = RuntimeState::open(temp.path().join("upgrade-owner")).unwrap();
        let _cleanup = RuntimeLeaseCleanup(vec![owner.clone(), competitor.clone()]);
        let source =
            runtime_lease_profile(&original_root, &python, &original_root.join("config.json"));
        let target =
            runtime_lease_profile(&upgraded_root, &python, &upgraded_root.join("config.json"));
        let request_marker = original_root.join("foreign-request.txt");
        let mut config = storage::read(&source).unwrap();
        config["request_marker"] = json!(request_marker);
        fs::write(&source.config_path, serde_json::to_vec(&config).unwrap()).unwrap();
        register_gui_fixture(&owner, &source);
        register_gui_fixture(&competitor, &target);
        let mut original = source.clone();
        original.id = target.id.clone();
        competitor
            .database
            .lock()
            .unwrap()
            .execute(
                "UPDATE local_installations SET original_profile=?1 WHERE id=?2",
                rusqlite::params![serde_json::to_string(&original).unwrap(), target.id],
            )
            .unwrap();
        let plan = prepare_startup(&source, &owner.processes, &owner.tasks).unwrap();
        start_prepared_service(&owner, source.clone(), plan, None).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !external::port_accepting(&source).unwrap() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        let blocked = competitor
            .clone()
            .ensure_runtime(target.id.clone(), true)
            .await
            .unwrap_err();
        assert_eq!(
            serde_json::from_str::<Value>(&blocked).unwrap()["code"],
            "STARTUP_RUNTIME_ALREADY_MANAGED"
        );
        assert!(
            !request_marker.exists(),
            "upgraded installations must respect the original runtime owner's lease"
        );
        assert!(
            owner
                .processes
                .lock()
                .unwrap()
                .get_mut(&source.id)
                .unwrap()
                .refresh()
                .unwrap()
                .running
        );
        assert!(strata_local_ipc::SingleInstance::acquire_scoped(
            &upgraded_root,
            "managed-model-runtime"
        )
        .is_ok());
    }

    #[tokio::test]
    async fn preparation_failures_survive_reopen_and_successful_results_clear_the_retry_diagnostic()
    {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().into()).unwrap();
        let profile = gui_fixture_profile(18997);
        register_gui_fixture(&state, &profile);
        let error = state
            .clone()
            .ensure_local_service(profile.id.clone())
            .await
            .err()
            .unwrap();
        let first = state.status().unwrap()["preparationFailures"].clone();
        assert_eq!(first[0]["profileId"], profile.id);
        assert_eq!(first[0]["lastError"], error);
        assert_eq!(first[0]["retryable"], true);
        assert!(state.processes.lock().unwrap().is_empty());
        drop(state);
        let reopened = RuntimeState::open(temp.path().into()).unwrap();
        assert_eq!(reopened.status().unwrap()["preparationFailures"], first);
        let status = service_status(reopened.clone(), profile.id.clone(), None)
            .await
            .unwrap();
        assert_eq!(status.reason.as_deref(), Some(error.as_str()));
        assert!(!status.running);
        reopened
            .record_preparation_result(
                &profile.id,
                &Ok(ProcessStatus {
                    running: true,
                    owned: true,
                    ..ProcessStatus::default()
                }),
            )
            .unwrap();
        assert!(reopened.status().unwrap()["preparationFailures"]
            .as_array()
            .unwrap()
            .is_empty());
    }
    fn gui_fixture_profile(port: u16) -> ServiceProfile {
        ServiceProfile {
            id: format!("gui-ownership-{}", uuid::Uuid::new_v4()),
            name: "已登记的模型".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            install_dir: "registered-installation".into(),
            python_path: "registered-python".into(),
            config_path: "registered-snapshot".into(),
            managed: true,
        }
    }
    fn register_gui_fixture(state: &RuntimeState, profile: &ServiceProfile) {
        let serialized = serde_json::to_string(profile).unwrap();
        state.database.lock().unwrap().execute(
            "INSERT INTO local_installations(id,profile,original_profile,imported_at) VALUES(?1,?2,?2,0)",
            rusqlite::params![profile.id, serialized],
        ).unwrap();
    }
    #[tokio::test]
    async fn desktop_mutations_never_reach_unimported_or_unowned_local_instances() {
        use std::io::{Read, Write};
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().into()).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let profile = gui_fixture_profile(listener.local_addr().unwrap().port());
        for imported in [false, true] {
            if imported {
                register_gui_fixture(&state, &profile);
            }
            for method in ["POST", "PUT", "PATCH", "DELETE"] {
                for path in ["/load", "/unload", "/v1/chat/completions", "/api/cancel"] {
                    assert!(state
                        .clone()
                        .dispatch(
                            "strata_request",
                            json!({
                                "profile":profile,"method":method,"path":path,"body":{}
                            })
                        )
                        .await
                        .is_err());
                }
            }
            assert!(state
                .clone()
                .dispatch("resolve_profile", json!({"profile":profile}))
                .await
                .is_err());
            assert!(
                matches!(listener.accept(), Err(error) if error.kind()==std::io::ErrorKind::WouldBlock)
            );
        }
        // Read-only local health remains available while an installation is
        // awaiting import or repair. No mutation needs to be sent to inspect it.
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(connection) => break connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(std::time::Instant::now() < deadline);
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0; 2048];
            let count = stream.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..count]).starts_with("GET /health "));
            let body = r#"{"status":"ok","service":"strata"}"#;
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).unwrap();
        });
        let health = state
            .clone()
            .dispatch(
                "strata_request",
                json!({"profile":profile,"method":"GET","path":"/health"}),
            )
            .await
            .unwrap();
        assert_eq!(health["service"], "strata");
        server.join().unwrap();
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn streaming_resolution_uses_registered_owned_identity_and_rejects_exited_processes() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().into()).unwrap();
        let profile = gui_fixture_profile(18999);
        register_gui_fixture(&state, &profile);
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 60",
        ]);
        let mut process = OwnedProcess::spawn(command, state.logs.clone(), &profile.id).unwrap();
        process.profile = Some(profile.clone());
        state
            .processes
            .lock()
            .unwrap()
            .insert(profile.id.clone(), process);
        let mut forged = profile.clone();
        forged.base_url = "http://127.0.0.1:19000".into();
        forged.install_dir = "caller-chosen-directory".into();
        forged.config_path = "caller-chosen-config".into();
        forged.python_path = "caller-chosen-python".into();
        let resolved = state
            .clone()
            .dispatch("resolve_profile", json!({"profile":forged}))
            .await
            .unwrap();
        assert_eq!(resolved["baseUrl"], profile.base_url);
        assert_eq!(resolved["configPath"], profile.config_path);
        {
            let mut processes = state.processes.lock().unwrap();
            processes
                .get_mut(&profile.id)
                .unwrap()
                .profile
                .as_mut()
                .unwrap()
                .config_path = "unrelated-config".into();
        }
        assert!(state.owned_gui_profile(&profile.id).is_err());
        {
            let mut processes = state.processes.lock().unwrap();
            let process = processes.get_mut(&profile.id).unwrap();
            process.profile = Some(profile.clone());
            process.stop().unwrap();
        }
        assert!(state
            .clone()
            .dispatch("resolve_profile", json!({"profile":profile}))
            .await
            .is_err());
        assert!(http::desktop_request(
            &state,
            profile,
            "/load".into(),
            "POST".into(),
            Some(json!({}))
        )
        .await
        .is_err());
    }
    #[cfg(windows)]
    #[test]
    fn restart_preflight_rejects_invalid_config_python_and_shared_runtime_conflicts_without_stopping(
    ) {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("serve")).unwrap();
        fs::write(temp.path().join("setup.py"), b"").unwrap();
        fs::write(temp.path().join("serve/server.py"), b"").unwrap();
        let path = temp.path().join("config.json");
        fs::write(&path, b"{}").unwrap();
        let python = test_python_executable().unwrap();
        let mut profile = ServiceProfile {
            id: "restart-preflight".into(),
            name: "".into(),
            base_url: "http://127.0.0.1:18939".into(),
            install_dir: temp.path().to_string_lossy().into(),
            python_path: python.clone(),
            config_path: path.to_string_lossy().into(),
            managed: true,
        };
        let logs: Logs = Default::default();
        let processes = Mutex::new(HashMap::new());
        let tasks: Tasks = Arc::new(Mutex::new(HashMap::new()));
        let owned_listeners = Mutex::new(HashMap::new());
        let spawn = |profile: &ServiceProfile| {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 60",
            ]);
            let mut process = OwnedProcess::spawn(command, logs.clone(), &profile.id).unwrap();
            process.profile = Some(profile.clone());
            process
        };
        processes
            .lock()
            .unwrap()
            .insert(profile.id.clone(), spawn(&profile));
        let alive = || {
            assert!(
                processes
                    .lock()
                    .unwrap()
                    .get_mut("restart-preflight")
                    .unwrap()
                    .refresh()
                    .unwrap()
                    .running
            )
        };
        assert!(prepare_owned_restart(&profile, &processes, &tasks, &owned_listeners).is_err());
        alive();
        fs::write(&path, b"{\"exe\":\"strata.exe\",\"args\":[]}").unwrap();
        // The #78 preflight requires the configured engine to exist.
        fs::write(temp.path().join("strata.exe"), b"").unwrap();
        profile.python_path = temp
            .path()
            .join("missing-python.exe")
            .to_string_lossy()
            .into();
        assert!(prepare_owned_restart(&profile, &processes, &tasks, &owned_listeners).is_err());
        alive();
        let invalid_python = temp.path().join("invalid-python.exe");
        fs::write(&invalid_python, b"not an executable").unwrap();
        profile.python_path = invalid_python.to_string_lossy().into();
        assert!(prepare_owned_restart(&profile, &processes, &tasks, &owned_listeners).is_err());
        alive();
        profile.python_path = python;
        tasks.lock().unwrap().insert(
            "other-task".into(),
            processes::TaskRecord {
                status: types::TaskStatus {
                    id: "other-task".into(),
                    kind: "setup".into(),
                    state: "running".into(),
                    message: "".into(),
                    started_at: now(),
                    finished_at: None,
                },
                profile_id: Some("other-profile".into()),
                runtime_path: Some(dunce::canonicalize(temp.path()).unwrap()),
                cancelled: false,
                process: None,
            },
        );
        assert!(prepare_owned_restart(&profile, &processes, &tasks, &owned_listeners).is_err());
        alive();
        tasks.lock().unwrap().clear();
        let mut other = profile.clone();
        other.id = "other-profile".into();
        processes
            .lock()
            .unwrap()
            .insert(other.id.clone(), spawn(&other));
        assert!(prepare_owned_restart(&profile, &processes, &tasks, &owned_listeners).is_err());
        alive();
        processes
            .lock()
            .unwrap()
            .get_mut(&other.id)
            .unwrap()
            .stop()
            .unwrap();
        assert!(prepare_owned_restart(&profile, &processes, &tasks, &owned_listeners).is_ok());
        assert!(
            !processes
                .lock()
                .unwrap()
                .get_mut(&profile.id)
                .unwrap()
                .refresh()
                .unwrap()
                .running
        );
    }
    #[cfg(windows)]
    #[test]
    fn command_probe_has_bounded_runtime_and_accepts_empty_stdout() {
        let start = std::time::Instant::now();
        assert!(output(
            "powershell.exe",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30"
            ]
        )
        .is_none());
        assert!(start.elapsed() < Duration::from_secs(6));
        // Use the native shell for the empty successful-output contract.
        assert_eq!(
            output("cmd.exe", &["/d", "/q", "/c", "exit 0"]),
            Some(String::new())
        );
    }
}
