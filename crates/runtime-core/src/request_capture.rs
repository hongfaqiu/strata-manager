//! Temporary request bodies stay in the verified observer's bounded RAM only.
//! Durable leases contain identity and expiry, never prompts or replies.
use crate::{types::ServiceProfile, RuntimeState};
use rusqlite::{Connection, OpenFlags, TransactionBehavior};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};

const SOURCE_HASHES: &[&str] = &[
    "017efa1f4e76d72396738555d13eb1f9898d1c1c12730cf046d9b267b29987e5",
    "458612e929771181d4e5419dbff5bb6499b5e8fef29a5c42aa08824d4e1d9dbf",
    "ce9266730b632e919ff93809ea6f9ecd6f91f12da19597a2d95a7edb29700dfa",
    // Strata v0.2.2 (the pinned source since SOURCE_REVISION 011c9e6): Handler._capture,
    // begin_request, the four inference routes and the capture lease contract are unchanged
    // from 0.2.0-beta; the CI fixture runs request_capture_tests against it.
    "bc09af76400932500f9ce09f401bf097ad7e7b120374d2cfbe3f4142fadd2304",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub state: String,
    pub expires_at_ms: Option<u64>,
    pub reason: Option<String>,
}
struct Identity {
    profile: ServiceProfile,
    root_pid: u32,
    started_at: u64,
    observer: Value,
}

fn regular(path: &Path, limit: Option<u64>) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "请求诊断观察器尚未就绪")?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || limit.is_some_and(|limit| metadata.len() > limit)
    {
        return Err("请求诊断文件被重定向或无法核验".into());
    }
    Ok(())
}
fn connection(state: &RuntimeState) -> Result<Connection, String> {
    let directory = state.data_dir().join("analytics");
    let metadata = fs::symlink_metadata(&directory).map_err(|_| "请求診断观察器尚未就绪")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("请求诊断目录被重定向".into());
    }
    let path = directory.join("journal.sqlite3");
    regular(&path, None)?;
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    Ok(db)
}
fn identity(state: &RuntimeState, id: &str) -> Result<Identity, String> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err("请求诊断安装标识无效".into());
    }
    let profile = state.registered_profile(id)?;
    if !profile.managed {
        return Err("仅已登记的受管本机服务支持临时请求诊断".into());
    }
    let path = state
        .data_dir()
        .join("analytics")
        .join(format!("status-{id}.json"));
    regular(&path, Some(4096))?;
    let observer: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|_| "观察器状态无效")?;
    let updated = observer["updatedAtMs"].as_u64().ok_or("观察器心跳缺失")?;
    if observer["schemaVersion"] != 1
        || observer["serviceId"] != id
        || observer["supported"] != true
        || observer["observerActive"] != true
        || observer["journalWriteFailed"] != false
        || !observer["error"].is_null()
        || updated > crate::now().saturating_add(1000)
        || crate::now().saturating_sub(updated) > 65_000
        || !observer["sourceHash"]
            .as_str()
            .is_some_and(|hash| SOURCE_HASHES.contains(&hash))
        || !observer["sessionId"].as_str().is_some_and(|session| {
            session.len() == 32 && session.bytes().all(|b| b.is_ascii_hexdigit())
        })
    {
        return Err("当前 Strata 观察器版本或心跳未通过请求诊断兼容性核验".into());
    }
    let pid = observer["pid"]
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
        .ok_or("观察器 PID 无效")?;
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
    let process = processes
        .get_mut(id)
        .ok_or("服务不属于当前独立后台，不能启用或关闭诊断")?;
    let current = process.refresh()?;
    if !current.running
        || !current.owned
        || current.pid != Some(process.child.id())
        || !process.owns_pid(pid)?
        || serde_json::to_value(process.profile.as_ref()).map_err(|e| e.to_string())?
            != serde_json::to_value(Some(&profile)).map_err(|e| e.to_string())?
    {
        return Err("服务进程与已登记安装不一致，保留当前服务".into());
    }
    Ok(Identity {
        profile,
        root_pid: process.child.id(),
        started_at: current.started_at.ok_or("受管进程创建时间缺失")?,
        observer,
    })
}
fn revalidate(state: &RuntimeState, before: &Identity) -> Result<(), String> {
    let after = identity(state, &before.profile.id)?;
    if before.root_pid != after.root_pid
        || before.started_at != after.started_at
        || before.observer["sessionId"] != after.observer["sessionId"]
        || before.observer["pid"] != after.observer["pid"]
        || before.observer["sourceHash"] != after.observer["sourceHash"]
    {
        return Err("诊断操作期间服务身份已改变".into());
    }
    Ok(())
}
fn acknowledgement(db: &Connection, identity: &Identity) -> Result<Value, String> {
    let payload: String = db
        .query_row(
            "SELECT payload FROM request_capture_status WHERE service_id=?1",
            [&identity.profile.id],
            |r| r.get(0),
        )
        .map_err(|_| "当前观察器未支持临时正文诊断，请升级受管后台后重试")?;
    if payload.len() > 4096 {
        return Err("请求诊断状态无效".into());
    }
    let ack: Value = serde_json::from_str(&payload).map_err(|_| "请求诊断状态无法核验")?;
    let updated = ack["updatedAtMs"].as_u64().ok_or("请求诊断心跳缺失")?;
    if ack["protocolVersion"] != 1
        || ack["serviceId"] != identity.profile.id
        || ack["sessionId"] != identity.observer["sessionId"]
        || ack["pid"] != identity.observer["pid"]
        || ack["sourceHash"] != identity.observer["sourceHash"]
        || updated > crate::now().saturating_add(1000)
        || crate::now().saturating_sub(updated) > 3000
        || !ack["manualEnabled"].is_boolean()
        || !ack["active"].is_boolean()
    {
        return Err("请求诊断会话身份或心跳无法核验".into());
    }
    if ack["active"] == true
        && (!ack["token"]
            .as_str()
            .is_some_and(|token| token.len() == 32 && token.bytes().all(|b| b.is_ascii_hexdigit()))
            || ack["expiresAtMs"].as_u64().is_none())
    {
        return Err("请求诊断租约确认无效".into());
    }
    Ok(ack)
}
fn view(ack: &Value) -> CaptureStatus {
    let state = if ack["manualEnabled"] == true {
        "external"
    } else if ack["active"] == true
        && ack["expiresAtMs"]
            .as_u64()
            .is_some_and(|expires| expires > crate::now())
    {
        "temporary"
    } else {
        "disabled"
    };
    CaptureStatus {
        state: state.into(),
        expires_at_ms: if state == "temporary" {
            ack["expiresAtMs"].as_u64()
        } else {
            None
        },
        reason: None,
    }
}
fn manually_configured(profile: &ServiceProfile) -> Result<bool, String> {
    let config = crate::storage::read(profile)?;
    if !config.is_object()
        || config
            .get("api_monitor")
            .is_some_and(|value| !value.is_boolean())
    {
        return Err("用户请求查看器配置无法核验，临时诊断未启用".into());
    }
    Ok(config.get("api_monitor") == Some(&json!(true)))
}
pub fn status(state: &RuntimeState, id: &str) -> Result<CaptureStatus, String> {
    // A missing observer is a visible compatibility state, never evidence of off.
    state.registered_profile(id)?;
    Ok(
        match identity(state, id).and_then(|identity| {
            Ok((
                acknowledgement(&connection(state)?, &identity)?,
                manually_configured(&identity.profile)?,
            ))
        }) {
            Ok((ack, configured)) => {
                let mut status = view(&ack);
                if configured && status.state != "temporary" {
                    status.state = "external".into();
                }
                status
            }
            Err(reason) => CaptureStatus {
                state: "unavailable".into(),
                expires_at_ms: None,
                reason: Some(reason),
            },
        },
    )
}
fn available(state: &RuntimeState, id: &str) -> Result<(), String> {
    if state.shutting_down.load(Ordering::Acquire)
        || state.selection_changing.load(Ordering::Acquire)
    {
        return Err("后台退出或模型切换中，请稍后重试".into());
    }
    crate::runtime_upgrade::assert_available(state)?;
    crate::tuning::assert_available(state)?;
    if state
        .data_dir()
        .join("analytics")
        .join(format!("{id}.maintenance"))
        .exists()
    {
        return Err("服务正在维护，请稍后重试".into());
    }
    let tasks = state.tasks.try_lock().map_err(|_| "后台任务状态无法核验")?;
    if tasks.values().any(|task| {
        !matches!(
            task.status.state.as_str(),
            "completed" | "failed" | "cancelled"
        ) || task.status.finished_at.is_none()
            || task.process.is_some()
    }) {
        return Err("后台仍有安装或准备任务，请完成后再启用诊断".into());
    }
    Ok(())
}
pub async fn set(
    state: Arc<RuntimeState>,
    id: String,
    minutes: u16,
) -> Result<CaptureStatus, String> {
    if !matches!(minutes, 0 | 5 | 15 | 30) {
        return Err("临时诊断仅支持关闭、5、15 或 30 分钟".into());
    }
    tokio::task::spawn_blocking(move || {
        let _operation = state.runtime_operations.try_lock().map_err(|_| "模型正在启动或维护，请稍后重试")?;
        let identity = identity(&state,&id)?;
        if minutes>0 && manually_configured(&identity.profile)? {
            return Err("请求查看器由用户配置启用，应用不会认领或关闭它；请在原配置中管理".into());
        }
        if minutes>0 { available(&state,&id)?; }
        let mut db = connection(&state)?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
        let ack = acknowledgement(&tx,&identity)?;
        if ack["manualEnabled"] == true { return Err("请求查看器由用户配置启用，应用不会认领或关闭它；请在原配置中管理".into()); }
        if minutes>0 {
            let active: i64 = tx.query_row("SELECT COUNT(*) FROM active_requests WHERE service_id=?1", [&id], |r| r.get(0)).map_err(|_| "请求活动无法核验")?;
            if active != 0 { return Err("服务仍有进行中的请求，完成后再启用临时诊断".into()); }
        }
        revalidate(&state,&identity)?;
        if minutes>0 && manually_configured(&identity.profile)? {
            return Err("用户配置已开启请求查看器，临时诊断未取得控制权".into());
        }
        let token = uuid::Uuid::new_v4().simple().to_string();
        if minutes==0 {
            tx.execute("DELETE FROM request_capture_leases WHERE service_id=?1", [&id]).map_err(|e| e.to_string())?;
        } else {
            let created = crate::now();
            let payload = json!({"protocolVersion":1,"serviceId":id,"sessionId":identity.observer["sessionId"],"pid":identity.observer["pid"],
                "sourceHash":identity.observer["sourceHash"],"token":token,"createdAtMs":created,"expiresAtMs":created+u64::from(minutes)*60_000});
            tx.execute("INSERT INTO request_capture_leases VALUES(?1,?2) ON CONFLICT(service_id) DO UPDATE SET payload=excluded.payload",rusqlite::params![id,payload.to_string()]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        let deadline = Instant::now()+Duration::from_secs(5);
        let result = (|| loop {
            revalidate(&state,&identity)?;
            let ack = acknowledgement(&db,&identity)?;
            if ack["manualEnabled"] == true { return Err("用户配置已开启请求查看器，临时诊断未取得控制权".into()); }
            if (minutes==0 && ack["active"] == false && ack["token"].is_null())
                || (minutes>0 && ack["active"] == true && ack["token"] == token) { return Ok(view(&ack)); }
            if Instant::now()>=deadline {
                // A lost acknowledgement must not leave a body lease enabled.
                return Err("观察器未确认诊断状态，临时租约已撤回；当前 API 服务保持运行".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        })();
        if result.is_err() && minutes>0 {
            db.execute("DELETE FROM request_capture_leases WHERE service_id=?1 AND json_extract(payload,'$.token')=?2",rusqlite::params![id,token]).map_err(|e| e.to_string())?;
        }
        result
    }).await.map_err(|e| e.to_string())?
}
/// On supervisor restart, never revive a lease belonging to an earlier process.
/// The observer independently enforces expiry even when no GUI/backend is open.
pub fn recover(state: &RuntimeState) -> Result<(), String> {
    let path = state.data_dir().join("analytics/journal.sqlite3");
    if !path.exists() {
        return Ok(());
    }
    let db = connection(state)?;
    let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='request_capture_leases')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if exists {
        db.execute("DELETE FROM request_capture_leases", [])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "request_capture_tests.rs"]
mod tests;
