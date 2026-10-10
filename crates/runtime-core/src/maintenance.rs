//! Admission is serialized with the observer's SQLite write lock. A drain can
//! never label a request idle merely because it has not reached inference yet.
use crate::{types::ServiceProfile, RuntimeState};
use rusqlite::{Connection, TransactionBehavior};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, time::Duration};

pub struct Guard {
    path: PathBuf,
    journal: PathBuf,
    token: String,
}
impl Guard {
    pub fn token(&self) -> &str {
        &self.token
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        // Never clear a marker owned by another operation after rollback.
        let Ok(mut db) = Connection::open(&self.journal) else {
            return;
        };
        let _ = db.busy_timeout(Duration::from_secs(5));
        let Ok(tx) = db.transaction_with_behavior(TransactionBehavior::Immediate) else {
            return;
        };
        let owner = fs::read(&self.path)
            .ok()
            .filter(|b| b.len() <= 4096)
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
        if owner
            .as_ref()
            .and_then(|v| v.get("token"))
            .and_then(Value::as_str)
            == Some(&self.token)
        {
            let _ = fs::remove_file(&self.path);
        }
        let _ = tx.commit();
    }
}
fn identity(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn verify_observer(state: &RuntimeState, id: &str) -> Result<(), String> {
    if !identity(id) {
        return Err("本机安装标识无效".into());
    }
    let path = state
        .data_dir
        .join("analytics")
        .join(format!("status-{id}.json"));
    let bytes =
        fs::read(&path).map_err(|_| "服务观察器不可用，无法核验安全维护，请先修复兼容性")?;
    if bytes.len() > 4096 {
        return Err("服务观察器状态无效".into());
    }
    let status: Value = serde_json::from_slice(&bytes).map_err(|_| "服务观察器状态无法核验")?;
    if status["serviceId"].as_str() != Some(id)
        || status["supported"] != true
        || status["observerActive"] != true
        || status["journalWriteFailed"] != false
        || status["error"].as_str().is_some()
        || status["updatedAtMs"].as_u64().is_none_or(|time| {
            crate::now().saturating_sub(time) > 65_000 || time > crate::now() + 1_000
        })
    {
        return Err("服务观察器版本、心跳或持久化状态不完整，保留当前服务".into());
    }
    let pid = status["pid"]
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
        .ok_or("观察器进程标识无效")?;
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
    let process = processes
        .get_mut(id)
        .ok_or("服务不属于独立后台，禁止自动维护")?;
    if !process.refresh()?.running || !process.owns_pid(pid)? {
        return Err("观察器进程不属于当前后台服务树，保留服务".into());
    }
    Ok(())
}
pub fn begin(
    state: &RuntimeState,
    profile_id: &str,
    token: Option<&str>,
    mode: &str,
) -> Result<Guard, String> {
    if !matches!(mode, "tuning" | "drain") {
        return Err("维护模式无效".into());
    }
    verify_observer(state, profile_id)?;
    let token = token.map(str::to_owned).unwrap_or_else(|| {
        format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        )
    });
    if token.len() < 32
        || token.len() > 128
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("维护凭据无效".into());
    }
    let journal = state.data_dir.join("analytics/journal.sqlite3");
    let mut db = Connection::open(&journal).map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let _: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM active_requests WHERE service_id=?1",
            [profile_id],
            |r| r.get(0),
        )
        .map_err(|e| format!("观察器 admission 协议未就绪: {e}"))?;
    let path = state
        .data_dir
        .join("analytics")
        .join(format!("{profile_id}.maintenance"));
    if path.exists() {
        return Err("服务已经进入维护，稍后重试".into());
    }
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("维护目录无效")?)
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    use std::io::Write;
    file.write_all(
        &serde_json::to_vec(&json!({"mode":mode,"token":token,"supervisorPid":std::process::id(),"supervisorStartedAt":state.started_at})).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist_noclobber(&path).map_err(|e| e.to_string())?;
    if let Err(error) = tx.commit() {
        let _ = fs::remove_file(&path);
        return Err(error.to_string());
    }
    Ok(Guard {
        path,
        journal,
        token,
    })
}
/// Called only after the caller established that this installation has no live
/// runtime. Same-owner markers remain in place across a tuning-owned restart.
pub fn clear_abandoned(state: &RuntimeState, profile: &ServiceProfile) -> Result<(), String> {
    if !identity(&profile.id) {
        return Err("维护安装标识无效".into());
    }
    let path = state
        .data_dir
        .join("analytics")
        .join(format!("{}.maintenance", profile.id));
    if !path.exists() {
        return Ok(());
    }
    state.registered_profile(&profile.id)?;
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > 4096 {
        return Err("维护标志无法核验，保留文件，请通过诊断修复".into());
    }
    let marker: Value =
        serde_json::from_slice(&bytes).map_err(|_| "维护标志损坏，保留文件，请通过诊断修复")?;
    if marker["supervisorPid"].as_u64() == Some(u64::from(std::process::id()))
        && marker["supervisorStartedAt"].as_u64() == Some(state.started_at)
    {
        return Ok(());
    }
    if marker["supervisorPid"].as_u64().is_none()
        || marker["supervisorStartedAt"].as_u64().is_none()
        || !matches!(marker["mode"].as_str(), Some("tuning" | "drain"))
        || marker["token"]
            .as_str()
            .is_none_or(|t| t.len() < 32 || t.len() > 128)
    {
        return Err("维护标志缺少可验证的后台归属，保留文件".into());
    }
    if crate::external::port_accepting(profile)?
        || crate::discovery::has_running_installation(std::path::Path::new(&profile.install_dir))?
    {
        return Err("已有本机进程仍运行，未清除维护标志".into());
    }
    let mut db = Connection::open(state.data_dir.join("analytics/journal.sqlite3"))
        .map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    if fs::read(&path).map_err(|e| e.to_string())? != bytes {
        return Err("维护标志已被其它操作接管，保留文件".into());
    }
    fs::remove_file(path).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
pub async fn wait_idle(state: &RuntimeState, profile: &ServiceProfile) -> Result<(), String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        verify_observer(state, &profile.id)?;
        let db = Connection::open(state.data_dir.join("analytics/journal.sqlite3"))
            .map_err(|e| e.to_string())?;
        db.busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        let active: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM active_requests WHERE service_id=?1",
                [&profile.id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if active == 0 {
            crate::inspect_idle_http(state, profile).await?;
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err("服务仍有进行中的请求，维护未开始，保持现有服务".into());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::process::Command;
    fn owned_fixture(state: &RuntimeState) -> u32 {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ]);
        let process =
            crate::processes::OwnedProcess::spawn(command, state.logs.clone(), "fixture").unwrap();
        let pid = process.child.id();
        state
            .processes
            .lock()
            .unwrap()
            .insert("fixture".into(), process);
        let directory = state.data_dir.join("analytics");
        fs::create_dir_all(&directory).unwrap();
        let db = Connection::open(directory.join("journal.sqlite3")).unwrap();
        db.execute_batch("CREATE TABLE active_requests(request_id TEXT PRIMARY KEY,service_id TEXT NOT NULL,session_id TEXT NOT NULL,started_ms INTEGER NOT NULL);").unwrap();
        fs::write(directory.join("status-fixture.json"),serde_json::to_vec(&json!({"serviceId":"fixture","pid":pid,"updatedAtMs":crate::now(),"supported":true,"observerActive":true,"journalWriteFailed":false,"error":null})).unwrap()).unwrap();
        pid
    }
    #[test]
    fn maintenance_requires_owned_fresh_observer_and_guard_clears_only_its_token() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().into()).unwrap();
        assert!(begin(&state, "fixture", None, "drain").is_err());
        owned_fixture(&state);
        let path = temp.path().join("analytics/fixture.maintenance");
        let gate = begin(&state, "fixture", None, "drain").unwrap();
        assert!(path.is_file());
        assert!(gate.token().len() >= 32);
        assert!(begin(&state, "fixture", None, "drain").is_err());
        drop(gate);
        assert!(!path.exists());
        let gate = begin(&state, "fixture", None, "tuning").unwrap();
        fs::write(
            &path,
            br#"{"mode":"drain","token":"different-owner-token-00000000000000"}"#,
        )
        .unwrap();
        drop(gate);
        assert!(path.exists());
        fs::remove_file(&path).unwrap();
        let status = temp.path().join("analytics/status-fixture.json");
        let mut changed: Value = serde_json::from_slice(&fs::read(&status).unwrap()).unwrap();
        changed["pid"] = json!(std::process::id());
        fs::write(&status, serde_json::to_vec(&changed).unwrap()).unwrap();
        assert!(begin(&state, "fixture", None, "drain").is_err());
        state.cleanup();
    }
}
