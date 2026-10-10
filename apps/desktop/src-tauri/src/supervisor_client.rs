use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::Duration,
};
use strata_local_ipc::RpcError;

pub struct SupervisorClient {
    pub data_dir: PathBuf,
    resource_dir: PathBuf,
    connection_lock: tokio::sync::Mutex<()>,
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
            staged: OnceLock::new(),
            next_upgrade: AtomicU64::new(0),
            update_pending: Mutex::new(None),
            #[cfg(test)]
            package_override: None,
        }
    }
    async fn connected(&self) -> Result<Value, RpcError> {
        strata_local_ipc::call(&self.data_dir, "hello", json!({})).await
    }
    pub async fn ensure_connected(&self) -> Result<(), RpcError> {
        match self.connected().await {
            Ok(status) if self.matches_package(&status)? => return Ok(()),
            Ok(_) => {}
            Err(error) if error.code != "supervisor_unavailable" => return Err(error),
            Err(_) => {}
        }
        let _guard = self.connection_lock.lock().await;
        match self.connected().await {
            Ok(status) if self.matches_package(&status)? => return Ok(()),
            Ok(status) => {
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
                            "service_busy" | "supervisor_upgrade_rolled_back"
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
        let mut command = Command::new(executable);
        command
            .args(["--data-dir"])
            .arg(&self.data_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
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
        let directory = dunce::canonicalize(self.data_dir.join("supervisor"))
            .map_err(|e| RpcError::new("supervisor_upgrade", e.to_string()))?;
        if !canonical.starts_with(directory) {
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
    async fn replace_background(&self, previous: Value) -> Result<(), RpcError> {
        let executable = self.staged_executable()?;
        let old = self.previous_executable(&previous)?;
        // This RPC blocks new POST admission, drains accepted requests and then
        // unloads only application-owned services. Unknown observers refuse it.
        strata_local_ipc::call(
            &self.data_dir,
            "shutdown_supervisor",
            json!({"forUpdate":true}),
        )
        .await?;
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            match self.connected().await {
                Err(error) if error.code == "supervisor_unavailable" => break,
                Err(error) => return Err(error),
                Ok(_) => {}
            }
            if std::time::Instant::now() >= deadline {
                return Err(RpcError::new(
                    "supervisor_upgrade",
                    "旧后台尚未退出，未启动重复后台",
                ));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let result = async {
            let current = self.start_and_wait(&executable).await?;
            if !self.matches_package(&current)? {
                return Err(RpcError::new("supervisor_upgrade", "新后台版本身份不匹配"));
            }
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
                strata_local_ipc::call(
                    &self.data_dir,
                    "shutdown_supervisor",
                    json!({"forUpdate":true}),
                )
                .await
                .map_err(|stop| {
                    RpcError::new(
                        "supervisor_rollback",
                        format!("{error}; 无法安全退出候选后台: {stop}"),
                    )
                })?;
                for _ in 0..150 {
                    if self.connected().await.is_err() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
            self.start_and_wait(&old).await.map_err(|rollback| {
                RpcError::new(
                    "supervisor_rollback",
                    format!("{error}; 回滚启动失败: {rollback}"),
                )
            })?;
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
        if crate::startup::status()
            .ok()
            .and_then(|v| v["enabled"].as_bool())
            == Some(true)
        {
            crate::startup::set(true, &executable, &self.data_dir)
                .map_err(|e| RpcError::new("startup_refresh", e))?;
        }
        Ok(())
    }
    async fn wait_selected_health(&self) -> Result<(), RpcError> {
        let selected = strata_local_ipc::call(
            &self.data_dir,
            "store_get",
            json!({"key":"activeLocalInstallation"}),
        )
        .await?;
        let desired = strata_local_ipc::call(
            &self.data_dir,
            "store_get",
            json!({"key":"localServiceDesired"}),
        )
        .await?;
        if desired.as_bool() == Some(false) {
            return Ok(());
        }
        let Some(id) = selected.as_str() else {
            return Ok(());
        };
        let profiles =
            strata_local_ipc::call(&self.data_dir, "local_installations", json!({})).await?;
        let profile = profiles
            .as_array()
            .and_then(|ps| ps.iter().find(|p| p["id"].as_str() == Some(id)))
            .ok_or_else(|| RpcError::new("supervisor_restore", "选中的本机安装登记缺失"))?;
        let deadline = std::time::Instant::now() + Duration::from_secs(90);
        loop {
            if let Ok(health) = strata_local_ipc::call(
                &self.data_dir,
                "strata_request",
                json!({"profile":profile,"path":"/health","method":"GET"}),
            )
            .await
            {
                if health["service"] == "strata" && health["status"] == "ok" {
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
        if method == "shutdown_supervisor" && self.connected().await.is_ok() {
            // An explicit stop remains available even when an older compatible
            // protocol lacks package metadata and cannot auto-upgrade safely.
            return strata_local_ipc::call(&self.data_dir, method, params).await;
        }
        self.ensure_connected().await?;
        // Never retry a mutation after an ambiguous transport failure. The caller
        // polls persisted state rather than potentially installing/starting twice.
        let mut result = strata_local_ipc::call(&self.data_dir, method, params).await?;
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
    async fn package_identity_switches_idle_background_and_bad_candidate_rolls_back() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        fs::create_dir(&data).unwrap();
        let source = source();
        let _previous = initial(&data, &source).await;
        let before = strata_local_ipc::call(&data, "hello", json!({}))
            .await
            .unwrap();
        let mut client = SupervisorClient::new(data.clone(), temp.path().into());
        client.package_override = Some(source.clone());
        let after = client
            .request("supervisor_status", json!({}))
            .await
            .unwrap();
        assert_ne!(before["pid"], after["pid"]);
        assert!(client.matches_package(&after).unwrap());
        assert_eq!(after["updatePending"], false);
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
