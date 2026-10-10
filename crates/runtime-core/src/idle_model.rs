//! Conservative idle model release. The API and its exact owned process remain
//! alive; normal first-use loading is unchanged. No model/config bytes are saved.
use crate::{
    health_watch::{HealthPhase, ObserverState},
    http, maintenance, policy,
    types::ServiceProfile,
    RuntimeState,
};
use futures_util::StreamExt;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

const OBSERVATION_GAP_MS: u64 = 65_000;
const MAX_EVENTS_PER_CHECK: usize = 2048;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const OPERATION_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum IdleOutcome {
    Disabled,
    Observing,
    Deferred,
    Unloaded,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observation {
    supervisor_started_at: u64,
    root_pid: u32,
    process_started_at: u64,
    session_id: String,
    source_id: String,
    last_sequence: u64,
    activity_revision: u64,
    checked_at: u64,
    idle_since: u64,
    idle_unload_minutes: u16,
}
#[derive(Clone)]
struct Lease {
    profile: ServiceProfile,
    root_pid: u32,
    started_at: u64,
}
struct Sample {
    session_id: String,
    source_id: String,
    observer_pid: u32,
    sequence: u64,
    activity_revision: u64,
    active: u64,
    activity: bool,
}

fn key(id: &str) -> Result<String, String> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err("空闲释放安装标识无效".into());
    }
    Ok(format!("idleModelObservation:{id}"))
}
fn reset(state: &RuntimeState, id: &str) -> Result<(), String> {
    crate::store_set(state, key(id)?, Value::Null)
}
fn save(state: &RuntimeState, id: &str, value: &Observation) -> Result<(), String> {
    crate::store_set(
        state,
        key(id)?,
        serde_json::to_value(value).map_err(|e| e.to_string())?,
    )
}
fn latest(state: &RuntimeState, id: &str) -> Result<Option<Observation>, String> {
    let value = crate::store_get(state, key(id)?)?;
    if value.is_null() {
        return Ok(None);
    }
    // A corrupt old observation can never make a model appear idle.
    Ok(serde_json::from_value(value).ok())
}
fn allowed(
    state: &RuntimeState,
    id: &str,
    cancel: &CancellationToken,
    own_gate: Option<&str>,
) -> Result<policy::BackgroundPolicy, String> {
    if cancel.is_cancelled()
        || state.shutting_down.load(Ordering::Acquire)
        || state.selection_changing.load(Ordering::Acquire)
        || crate::store_get(state, "activeLocalInstallation".into())?.as_str() != Some(id)
        || crate::store_get(state, "localServiceDesired".into())?.as_bool() == Some(false)
    {
        return Err("空闲释放已取消或模型选择/运行意愿已改变".into());
    }
    crate::runtime_upgrade::assert_available(state)?;
    crate::tuning::assert_available(state)?;
    let marker = state
        .data_dir()
        .join("analytics")
        .join(format!("{id}.maintenance"));
    match fs::symlink_metadata(&marker) {
        Ok(_) => {
            regular(&marker, Some(4096))?;
            let value: Value =
                serde_json::from_slice(&fs::read(marker).map_err(|e| e.to_string())?)
                    .map_err(|_| "维护状态无法核验")?;
            if own_gate.is_none() || value["mode"] != "drain" || value["token"].as_str() != own_gate
            {
                return Err("服务已有其它维护任务".into());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && own_gate.is_none() => {}
        _ => return Err("空闲释放维护凭据已改变或无法读取".into()),
    }
    let tasks = state.tasks.try_lock().map_err(|_| "后台任务无法核验")?;
    if tasks.values().any(|task| {
        !matches!(
            task.status.state.as_str(),
            "completed" | "failed" | "cancelled"
        ) || task.status.finished_at.is_none()
            || task.process.is_some()
    }) {
        return Err("后台仍有安装/准备任务，或任务终态无法核验".into());
    }
    let policy = policy::get(state)?;
    if policy.mode != "lazy" || policy.idle_unload_minutes == 0 || policy.idle_unload_minutes > 1440
    {
        return Err("当前策略不允许空闲释放".into());
    }
    Ok(policy)
}
fn lease(state: &RuntimeState, id: &str) -> Result<Lease, String> {
    let profile = state.registered_profile(id)?;
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
    let process = processes
        .get_mut(id)
        .ok_or("空闲释放目标没有受管进程记录")?;
    if serde_json::to_value(process.profile.as_ref()).map_err(|e| e.to_string())?
        != serde_json::to_value(Some(&profile)).map_err(|e| e.to_string())?
    {
        return Err("受管进程与已登记安装不一致".into());
    }
    let status = process.refresh()?;
    if !profile.managed
        || !status.running
        || !status.owned
        || status.pid != Some(process.child.id())
    {
        return Err("空闲释放进程归属无法核验".into());
    }
    Ok(Lease {
        profile,
        root_pid: process.child.id(),
        started_at: status.started_at.ok_or("受管进程创建时间无法核验")?,
    })
}
fn revalidate(state: &RuntimeState, before: &Lease) -> Result<(), String> {
    let after = lease(state, &before.profile.id)?;
    if after.root_pid != before.root_pid
        || after.started_at != before.started_at
        || serde_json::to_value(&after.profile).map_err(|e| e.to_string())?
            != serde_json::to_value(&before.profile).map_err(|e| e.to_string())?
    {
        return Err("空闲释放期间进程或登记已改变".into());
    }
    Ok(())
}
fn regular(path: &std::path::Path, limit: Option<u64>) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "观察器文件不可用")?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || limit.is_some_and(|limit| metadata.len() > limit)
    {
        return Err("观察器文件类型或大小无法核验".into());
    }
    Ok(())
}
fn sample(
    state: &RuntimeState,
    lease: &Lease,
    previous: Option<&Observation>,
) -> Result<Sample, String> {
    let directory = state.data_dir().join("analytics");
    let metadata = fs::symlink_metadata(&directory).map_err(|_| "观察器目录不可用")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("观察器目录被重定向".into());
    }
    let path = directory.join(format!("status-{}.json", lease.profile.id));
    regular(&path, Some(4096))?;
    let status: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|_| "观察器状态无效")?;
    let now = crate::now();
    let updated = status["updatedAtMs"].as_u64().ok_or("观察器缺少心跳")?;
    if status["schemaVersion"] != 1
        || status["serviceId"].as_str() != Some(&lease.profile.id)
        || status["supported"] != true
        || status["observerActive"] != true
        || status["journalWriteFailed"] != false
        || !status["error"].is_null()
        || updated > now.saturating_add(1000)
        || now.saturating_sub(updated) > OBSERVATION_GAP_MS
    {
        return Err("观察器不支持、心跳过期或采集失败".into());
    }
    let observer_pid = status["pid"]
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .ok_or("观察器 PID 无效")?;
    let session_id = status["sessionId"]
        .as_str()
        .filter(|id| id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or("观察器会话无法核验")?
        .to_owned();
    {
        let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
        let process = processes
            .get_mut(&lease.profile.id)
            .ok_or("受管进程记录已改变")?;
        let status = process.refresh()?;
        if !status.running
            || process.child.id() != lease.root_pid
            || status.started_at != Some(lease.started_at)
            || !process.owns_pid(observer_pid)?
        {
            return Err("观察器不属于当前受管进程树".into());
        }
    }
    let journal = directory.join("journal.sqlite3");
    regular(&journal, None)?;
    let mut db = Connection::open_with_flags(
        journal,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_millis(100))
        .map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let source_id: String = tx
        .query_row("SELECT value FROM meta WHERE key='source_id'", [], |row| {
            row.get(0)
        })
        .map_err(|_| "观察器日志来源不可用")?;
    if source_id.len() != 32 || !source_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("观察器日志来源无法核验".into());
    }
    let sequence: i64 = tx
        .query_row("SELECT COALESCE(MAX(seq),0) FROM events", [], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())?;
    let active: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM active_requests WHERE service_id=?1",
            [&lease.profile.id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let (activity_session, activity_revision, activity_at): (String, i64, i64) = tx
        .query_row(
            "SELECT session_id,revision,last_activity_ms FROM service_activity WHERE service_id=?1",
            [&lease.profile.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| "观察器未支持近期模型控制活动核验")?;
    let activity_revision = u64::try_from(activity_revision).map_err(|_| "活动序号无效")?;
    let activity_at = u64::try_from(activity_at).map_err(|_| "活动时间无效")?;
    if activity_session != session_id || activity_at > now.saturating_add(1000) {
        return Err("观察器活动会话或时钟无法核验，重新计时".into());
    }
    let mut activity = false;
    if let Some(previous) =
        previous.filter(|p| p.source_id == source_id && p.session_id == session_id)
    {
        if activity_revision < previous.activity_revision {
            return Err("观察器活动序号已回退，重新计时".into());
        }
        activity = activity_revision != previous.activity_revision;
        let dropped: String = tx
            .query_row(
                "SELECT value FROM meta WHERE key='dropped_through'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if dropped.parse::<u64>().map_err(|_| "观察器断档状态无效")? > previous.last_sequence
            || u64::try_from(sequence).map_err(|_| "观察器序列无效")? < previous.last_sequence
        {
            return Err("观察器记录已断档，重新计时".into());
        }
        let mut statement = tx
            .prepare("SELECT at_ms,kind,payload FROM events WHERE seq>?1 ORDER BY seq LIMIT ?2")
            .map_err(|e| e.to_string())?;
        let mut rows = statement
            .query(rusqlite::params![
                i64::try_from(previous.last_sequence).map_err(|_| "观察器序列无效")?,
                (MAX_EVENTS_PER_CHECK + 1) as i64
            ])
            .map_err(|e| e.to_string())?;
        let mut count = 0;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            count += 1;
            if count > MAX_EVENTS_PER_CHECK {
                return Err("观察器事件超出单次核验范围，重新计时".into());
            }
            let at: i64 = row.get(0).map_err(|e| e.to_string())?;
            let kind: String = row.get(1).map_err(|e| e.to_string())?;
            let payload: String = row.get(2).map_err(|e| e.to_string())?;
            if payload.len() > 16 * 1024 || kind.len() > 80 {
                return Err("观察器事件无效，重新计时".into());
            }
            let value: Value = serde_json::from_str(&payload).map_err(|_| "观察器事件无法核验")?;
            if value["serviceId"].as_str() == Some(&lease.profile.id)
                && value["sessionId"].as_str() == Some(&session_id)
            {
                let at = u64::try_from(at).map_err(|_| "活动时间无效")?;
                if at > now.saturating_add(1000) {
                    return Err("活动时间无法核验，重新计时".into());
                }
                // Include rejected/cancelled requests: attempts to use the API
                // are user activity, even when the temporary gate refuses them.
                if matches!(
                    kind.as_str(),
                    "request_start" | "request_end" | "run_start" | "run_end"
                ) {
                    activity = true;
                }
            }
        }
    }
    Ok(Sample {
        session_id,
        source_id,
        observer_pid,
        sequence: u64::try_from(sequence).map_err(|_| "观察器序列无效")?,
        activity_revision,
        active: u64::try_from(active).map_err(|_| "活动计数无效")?,
        activity,
    })
}
#[cfg(windows)]
fn listener_owned(state: &RuntimeState, lease: &Lease, _: u32) -> Result<(), String> {
    let ids = crate::external::listener_ids(&lease.profile)?;
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
    let process = processes
        .get_mut(&lease.profile.id)
        .ok_or("受管监听记录已改变")?;
    if ids.len() != 1 || !process.owns_pid(ids[0])? {
        return Err("空闲释放端口存在未知监听进程".into());
    }
    Ok(())
}
#[cfg(target_os = "linux")]
fn listener_owned(_: &RuntimeState, lease: &Lease, observer_pid: u32) -> Result<(), String> {
    use std::collections::HashSet;
    let url = http::endpoint(&lease.profile, "/health")?;
    let port = crate::external::local_port(&lease.profile)?;
    let (table, address, wildcard) = match url.host() {
        Some(url::Host::Ipv4(ip)) => (
            "tcp",
            format!("{:08X}", u32::from_ne_bytes(ip.octets())),
            "00000000",
        ),
        Some(url::Host::Ipv6(ip)) => {
            let address = ip
                .octets()
                .as_chunks::<4>()
                .0
                .iter()
                .map(|v| format!("{:08X}", u32::from_ne_bytes(*v)))
                .collect::<String>();
            ("tcp6", address, "00000000000000000000000000000000")
        }
        _ => return Err("空闲释放需要明确的 loopback IP".into()),
    };
    let text = fs::read_to_string(format!("/proc/net/{table}")).map_err(|_| "无法核验本机监听")?;
    if text.len() > 4 * 1024 * 1024 {
        return Err("本机监听表超过核验上限".into());
    }
    let mut inodes = HashSet::new();
    for line in text.lines().skip(1) {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 10 || fields[3] != "0A" {
            continue;
        }
        let Some((host, value)) = fields[1].rsplit_once(':') else {
            continue;
        };
        if (host == address || host == wildcard)
            && u16::from_str_radix(value, 16).ok() == Some(port)
        {
            inodes.insert(fields[9].to_owned());
        }
    }
    if inodes.is_empty() {
        return Err("受管 API 端口未监听".into());
    }
    let mut owned = HashSet::new();
    for (index, entry) in fs::read_dir(format!("/proc/{observer_pid}/fd"))
        .map_err(|_| "受管监听句柄不可读")?
        .enumerate()
    {
        if index >= 4096 {
            return Err("受管监听句柄超过核验上限".into());
        }
        let entry = entry.map_err(|_| "监听句柄不可读")?;
        if let Ok(path) = fs::read_link(entry.path()) {
            if let Some(inode) = path
                .to_str()
                .and_then(|p| p.strip_prefix("socket:["))
                .and_then(|p| p.strip_suffix(']'))
            {
                owned.insert(inode.to_owned());
            }
        }
    }
    if !inodes.is_subset(&owned) {
        return Err("空闲释放端口存在未知监听进程".into());
    }
    Ok(())
}
#[cfg(not(any(windows, target_os = "linux")))]
fn listener_owned(_: &RuntimeState, _: &Lease, _: u32) -> Result<(), String> {
    Err("当前平台不支持空闲释放的监听归属核验".into())
}
fn observation(
    state: &RuntimeState,
    lease: &Lease,
    sample: &Sample,
    policy: &policy::BackgroundPolicy,
    previous: Option<&Observation>,
) -> Observation {
    let now = crate::now();
    let previous = previous.filter(|p| {
        p.supervisor_started_at == state.started_at
            && p.root_pid == lease.root_pid
            && p.process_started_at == lease.started_at
            && p.session_id == sample.session_id
            && p.source_id == sample.source_id
            && p.idle_unload_minutes == policy.idle_unload_minutes
            && now >= p.checked_at
            && now.saturating_sub(p.checked_at) <= OBSERVATION_GAP_MS
            && p.idle_since <= p.checked_at
            && !sample.activity
            && sample.active == 0
    });
    Observation {
        supervisor_started_at: state.started_at,
        root_pid: lease.root_pid,
        process_started_at: lease.started_at,
        session_id: sample.session_id.clone(),
        source_id: sample.source_id.clone(),
        last_sequence: sample.sequence,
        activity_revision: sample.activity_revision,
        checked_at: now,
        idle_since: previous.map_or(now, |p| p.idle_since),
        idle_unload_minutes: policy.idle_unload_minutes,
    }
}
async fn json_request(
    state: &RuntimeState,
    profile: &ServiceProfile,
    path: &str,
    token: Option<&str>,
    cancel: &CancellationToken,
) -> Result<Value, String> {
    // Cancellation before sending prevents a pending unload. Once the server
    // accepted the POST, disconnecting cannot undo its model-state transition;
    // only this request is cancelled and the API process remains owned/alive.
    let mut builder = http::request_builder(
        &state.client,
        profile,
        path,
        if token.is_some() { "POST" } else { "GET" },
        token.map(|_| json!({})),
    )?
    .timeout(Duration::from_secs(20));
    if let Some(token) = token {
        builder = builder.header("X-Strata-Manager-Maintenance-Token", token);
    }
    let request = async {
        let response = builder.send().await.map_err(|_| "空闲释放 API 请求失败")?;
        if !response.status().is_success() {
            return Err(format!("空闲释放 API 返回 HTTP {}", response.status()));
        }
        if response
            .content_length()
            .is_some_and(|v| v > MAX_RESPONSE_BYTES as u64)
        {
            return Err("空闲释放响应超过上限".into());
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "空闲释放响应中断")?;
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err("空闲释放响应超过上限".into());
            }
            bytes.extend(chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| "空闲释放响应无法核验".into())
    };
    tokio::select! { biased; _=cancel.cancelled()=>Err("空闲释放已取消".into()), result=request=>result }
}
fn snapshot_eligible(state: &RuntimeState, lease: &Lease) -> Result<(), String> {
    let snapshots = state.health_snapshots.lock().map_err(|e| e.to_string())?;
    let health = snapshots
        .get(&lease.profile.id)
        .ok_or("尚无已核验健康状态")?;
    if health.phase != HealthPhase::Healthy
        || health.api_healthy != Some(true)
        || health.loaded != Some(true)
        || health.observer_state != ObserverState::Idle
        || health.active_requests != Some(0)
        || health.pid != Some(lease.root_pid)
        || crate::now().saturating_sub(health.checked_at) > 15_000
        || health.checked_at > crate::now().saturating_add(1000)
    {
        return Err("健康、加载或活动状态不足以核验空闲".into());
    }
    Ok(())
}
async fn release_locked(
    state: &RuntimeState,
    id: &str,
    cancel: &CancellationToken,
    test_idle_ms: Option<u64>,
) -> Result<IdleOutcome, String> {
    let policy = allowed(state, id, cancel, None)?;
    // Production uses only the policy read under the operation lock. Never
    // capture a shorter threshold outside the lock across a policy ABA change.
    let idle_ms = test_idle_ms.unwrap_or(u64::from(policy.idle_unload_minutes) * 60_000);
    let lease = lease(state, id)?;
    snapshot_eligible(state, &lease)?;
    let previous = latest(state, id)?;
    let before = sample(state, &lease, previous.as_ref())?;
    let observed = observation(state, &lease, &before, &policy, previous.as_ref());
    save(state, id, &observed)?;
    if before.active != 0 || crate::now().saturating_sub(observed.idle_since) < idle_ms {
        return Ok(IdleOutcome::Observing);
    }
    // Gate creation and HTTP admission share BEGIN IMMEDIATE. No new request
    // can slip between an active-count check and this operation's unload.
    #[cfg(test)]
    tests::before_gate(state, id).await;
    if allowed(state, id, cancel, None)? != policy {
        return Err("空闲释放策略已改变".into());
    }
    revalidate(state, &lease)?;
    let gate = maintenance::begin(state, id, None, "drain")?;
    #[cfg(test)]
    tests::after_gate(state, id).await;
    let drain = async { maintenance::wait_idle(state, &lease.profile).await };
    tokio::select! { biased; _=cancel.cancelled()=>return Err("空闲释放已取消".into()), result=drain=>result? }
    let policy_after = allowed(state, id, cancel, Some(gate.token()))?;
    revalidate(state, &lease)?;
    let after = sample(state, &lease, Some(&observed))?;
    if after.active != 0
        || after.activity
        || after.session_id != before.session_id
        || after.source_id != before.source_id
        || policy_after != policy
    {
        save(
            state,
            id,
            &observation(state, &lease, &after, &policy_after, None),
        )?;
        return Ok(IdleOutcome::Observing);
    }
    let health = json_request(state, &lease.profile, "/health", None, cancel).await?;
    if health["service"] != "strata" || health["status"] != "ok" || health["loaded"] != true {
        return Err("模型正在加载、未加载或 API 状态不完整，未卸载".into());
    }
    // The final health request can take time. Recheck activity under the gate
    // immediately before committing, including a just-finished admitted request.
    let final_sample = sample(state, &lease, Some(&observed))?;
    if final_sample.active != 0
        || final_sample.activity
        || final_sample.session_id != before.session_id
        || final_sample.source_id != before.source_id
    {
        save(
            state,
            id,
            &observation(state, &lease, &final_sample, &policy_after, None),
        )?;
        return Ok(IdleOutcome::Observing);
    }
    if allowed(state, id, cancel, Some(gate.token()))? != policy {
        return Err("空闲释放策略已改变".into());
    }
    revalidate(state, &lease)?;
    listener_owned(state, &lease, final_sample.observer_pid)?;
    let result = json_request(state, &lease.profile, "/unload", Some(gate.token()), cancel).await?;
    if !matches!(result["status"].as_str(), Some("unloaded" | "not loaded")) {
        return Err("无法确认空闲模型已卸载，保留 API".into());
    }
    let health = json_request(state, &lease.profile, "/health", None, cancel).await?;
    revalidate(state, &lease)?;
    if health["service"] != "strata" || health["status"] != "ok" || health["loaded"] != false {
        return Err("空闲释放后 API 或加载状态未通过核验".into());
    }
    reset(state, id)?;
    state
        .health_snapshots
        .lock()
        .map_err(|e| e.to_string())?
        .remove(id);
    crate::processes::log(
        &state.logs,
        id,
        "info",
        "空闲模型已释放；本机 API 保持运行，下一次使用会自动加载",
    );
    Ok(IdleOutcome::Unloaded)
}
pub(crate) async fn tick(
    state: Arc<RuntimeState>,
    id: &str,
    parent_cancel: &CancellationToken,
) -> Result<IdleOutcome, String> {
    tick_operation(state, id, parent_cancel, None).await
}
#[cfg(test)]
async fn tick_with_window(
    state: Arc<RuntimeState>,
    id: &str,
    parent_cancel: &CancellationToken,
    idle_ms: u64,
) -> Result<IdleOutcome, String> {
    tick_operation(state, id, parent_cancel, Some(idle_ms)).await
}
async fn tick_operation(
    state: Arc<RuntimeState>,
    id: &str,
    parent_cancel: &CancellationToken,
    test_idle_ms: Option<u64>,
) -> Result<IdleOutcome, String> {
    let policy = policy::get(&state)?;
    if policy.mode != "lazy" || policy.idle_unload_minutes == 0 {
        reset(&state, id)?;
        return Ok(IdleOutcome::Disabled);
    }
    #[cfg(test)]
    tests::before_operation(&state, id).await;
    let id = id.to_owned();
    let cancelled = parent_cancel.child_token();
    let _drop_cancel = cancelled.clone().drop_guard();
    let cleanup_state = state.clone();
    let cleanup_id = id.clone();
    let work = tokio::task::spawn_blocking(move || {
        // Keep all locks in this bounded worker, including when the async caller
        // is dropped. Try-locks refuse contention rather than queueing a late op.
        let _selection = state
            .selection_lock
            .try_lock()
            .map_err(|_| "模型选择正在进行")?;
        let ensure = state
            .ensure_locks
            .try_lock()
            .map_err(|_| "加载状态无法核验")?
            .entry(id.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone();
        let _ensure = ensure.try_lock().map_err(|_| "模型正在启动或加载")?;
        let _operation = state
            .runtime_operations
            .try_lock()
            .map_err(|_| "服务启动或维护正在进行")?;
        let runtime = tokio::runtime::Handle::current();
        runtime.block_on(async {
            tokio::time::timeout(
                OPERATION_TIMEOUT,
                release_locked(&state, &id, &cancelled, test_idle_ms),
            )
            .await
            .map_err(|_| "空闲释放操作超时，保留 API")?
        })
    })
    .await
    .map_err(|e| e.to_string())?;
    match work {
        Ok(result) => Ok(result),
        Err(_) => {
            reset(&cleanup_state, &cleanup_id)?;
            Ok(IdleOutcome::Deferred)
        }
    }
}

#[cfg(test)]
#[path = "idle_model_tests.rs"]
mod tests;
