//! Read-only, bounded liveness checks for an already owned local runtime.
//!
//! A PID being alive is not a successful health check. This module never stops,
//! unloads or restarts a process. `Preload` is only a suggestion to the normal
//! ensure path, which must retain its own admission and ownership checks.
use crate::{http, policy, types::ServiceProfile, RuntimeState};
use futures_util::StreamExt;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
#[cfg(all(unix, not(target_os = "macos")))]
use std::collections::HashSet;
use std::{
    fs::{self, File},
    io::Read,
    path::Path,
    sync::{atomic::Ordering, OnceLock},
    time::Duration,
};

const PROBE_INTERVAL_MS: u64 = 5_000;
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_FAILURE_SAMPLES: usize = 8;
const DEGRADE_AFTER: u8 = 3;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HealthPhase {
    Healthy,
    Checking,
    Degraded,
    Deferred,
    Unknown,
    Stopped,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ObserverState {
    Idle,
    Busy,
    Unknown,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FailureKind {
    RequestUnavailable,
    Timeout,
    Connection,
    HttpStatus,
    Oversized,
    InvalidJson,
    WrongService,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureSample {
    pub at: u64,
    pub kind: FailureKind,
    pub http_status: Option<u16>,
    // Fixed diagnostics only: neither response bodies nor request URLs/keys.
    pub reason: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthSnapshot {
    pub profile_id: String,
    pub phase: HealthPhase,
    pub api_healthy: Option<bool>,
    pub loaded: Option<bool>,
    pub observer_state: ObserverState,
    pub active_requests: Option<u64>,
    pub pid: Option<u32>,
    pub reason: String,
    pub checked_at: u64,
    pub last_healthy_at: Option<u64>,
    pub probe_attempted: bool,
    pub consecutive_failures: u8,
    pub failures: Vec<FailureSample>,
}

impl HealthSnapshot {
    fn new(id: &str) -> Self {
        Self {
            profile_id: id.into(),
            phase: HealthPhase::Unknown,
            api_healthy: None,
            loaded: None,
            observer_state: ObserverState::Unknown,
            active_requests: None,
            pid: None,
            reason: "尚未完成受管服务健康重验".into(),
            checked_at: 0,
            last_healthy_at: None,
            probe_attempted: false,
            consecutive_failures: 0,
            failures: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HealthAction {
    None,
    Preload,
}

#[derive(Clone, Debug)]
pub struct HealthResult {
    pub snapshot: HealthSnapshot,
    pub action: HealthAction,
    /// Only a fresh, valid owned API check with verifiable activity can reset
    /// recovery accounting. Cached, busy and unknown observations cannot.
    pub recovery_may_reset: bool,
}

struct Lease {
    profile: ServiceProfile,
    root_pid: u32,
    started_at: Option<u64>,
}

struct Activity {
    state: ObserverState,
    active: Option<u64>,
    observer_pid: Option<u32>,
    reason: &'static str,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}

fn same_profile(left: &ServiceProfile, right: &ServiceProfile) -> bool {
    left.id == right.id
        && left.managed
        && right.managed
        && left.base_url == right.base_url
        && left.install_dir == right.install_dir
        && left.config_path == right.config_path
        && left.python_path == right.python_path
}

fn owned_lease(state: &RuntimeState, id: &str) -> Result<Option<Lease>, &'static str> {
    let profile = state
        .registered_profile(id)
        .map_err(|_| "安装未登记，未发送健康请求")?;
    let mut processes = state.processes.lock().map_err(|_| "受管进程状态不可读")?;
    let process = processes
        .get_mut(id)
        .ok_or("进程不属于本后台，未发送健康请求")?;
    let owned = process.profile.as_ref().ok_or("进程缺少已登记安装身份")?;
    if !same_profile(&profile, owned) {
        return Err("运行进程与安装登记不一致，未发送健康请求");
    }
    let status = process.refresh().map_err(|_| "受管进程状态无法核验")?;
    if !status.running {
        return Ok(None);
    }
    if !status.owned || status.pid != Some(process.child.id()) {
        return Err("受管进程句柄和 PID 不一致，未发送健康请求");
    }
    Ok(Some(Lease {
        profile,
        root_pid: process.child.id(),
        started_at: status.started_at,
    }))
}

fn owns_pid(state: &RuntimeState, lease: &Lease, pid: u32) -> Result<bool, &'static str> {
    if pid == 0 || pid == std::process::id() {
        return Ok(false);
    }
    let mut processes = state.processes.lock().map_err(|_| "受管进程状态不可读")?;
    let process = processes
        .get_mut(&lease.profile.id)
        .ok_or("受管进程记录已改变")?;
    let status = process.refresh().map_err(|_| "受管进程状态无法核验")?;
    if !status.running
        || !status.owned
        || process.child.id() != lease.root_pid
        || status.started_at != lease.started_at
    {
        return Ok(false);
    }
    process
        .owns_pid(pid)
        .map_err(|_| "无法核验健康端口的进程归属")
}

fn busy_reason(state: &RuntimeState, id: &str) -> Option<&'static str> {
    if state.shutting_down.load(Ordering::Acquire) {
        return Some("后台正在退出，延后健康重验");
    }
    if state.selection_changing.load(Ordering::Acquire) {
        return Some("模型切换中，延后健康重验");
    }
    if state.runtime_upgrading.load(Ordering::Acquire) {
        return Some("运行时更新中，延后健康重验");
    }
    if state.runtime_operations.try_lock().is_err() {
        return Some("服务启动或维护中，延后健康重验");
    }
    if state.selection_lock.try_lock().is_err() {
        return Some("模型选择操作中，延后健康重验");
    }
    let Ok(locks) = state.ensure_locks.try_lock() else {
        return Some("服务准备操作中，延后健康重验");
    };
    if locks.get(id).is_some_and(|lock| lock.try_lock().is_err()) {
        return Some("服务启动或模型加载中，延后健康重验");
    }
    drop(locks);
    if crate::tuning::assert_no_active_tuning(state).is_err() {
        return Some("调优或参数恢复中，延后健康重验");
    }
    // Any marker, including an unreadable/malformed one, fails closed. Never
    // clear another operation's admission marker as part of health checking.
    let marker = state
        .data_dir
        .join("analytics")
        .join(format!("{id}.maintenance"));
    match fs::symlink_metadata(marker) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Some("服务维护标志存在或不可读，延后健康重验"),
    }
    let Ok(tasks) = state.tasks.try_lock() else {
        return Some("任务状态不可用，延后健康重验");
    };
    if tasks.values().any(|task| {
        task.profile_id.as_deref() == Some(id)
            && matches!(
                task.status.state.as_str(),
                "pending" | "running" | "canceling" | "cancelling"
            )
    }) {
        return Some("安装或准备任务进行中，延后健康重验");
    }
    None
}

fn regular_file(path: &Path, limit: usize) -> Result<Vec<u8>, &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "观察器状态或日志不可用")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit as u64 {
        return Err("观察器状态文件类型或大小无效");
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| "观察器状态文件不可读")?
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "观察器状态文件不可读")?;
    if bytes.len() > limit {
        return Err("观察器状态文件超过限制");
    }
    Ok(bytes)
}

fn activity_inner(state: &RuntimeState, lease: &Lease) -> Result<Activity, &'static str> {
    let directory = state.data_dir.join("analytics");
    let metadata = fs::symlink_metadata(&directory).map_err(|_| "观察器尚未可用")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("观察器目录被重定向，无法核验");
    }
    let status: Value = serde_json::from_slice(&regular_file(
        &directory.join(format!("status-{}.json", lease.profile.id)),
        4096,
    )?)
    .map_err(|_| "观察器状态不是有效 JSON")?;
    let time = status["updatedAtMs"].as_u64().ok_or("观察器心跳缺失")?;
    if status["schemaVersion"] != 1
        || status["serviceId"].as_str() != Some(&lease.profile.id)
        || status["supported"] != true
        || status["observerActive"] != true
        || status["journalWriteFailed"] != false
        || !status["error"].is_null()
        || crate::now().saturating_sub(time) > 65_000
        || time > crate::now().saturating_add(1_000)
    {
        return Err("观察器兼容性、心跳或持久化状态无法核验");
    }
    let pid = status["pid"]
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
        .ok_or("观察器 PID 无效")?;
    if !owns_pid(state, lease, pid)? {
        return Err("观察器 PID 不属于当前受管进程树");
    }
    let journal = directory.join("journal.sqlite3");
    let metadata = fs::symlink_metadata(&journal).map_err(|_| "活动请求日志尚未可用")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("活动请求日志被重定向，无法核验");
    }
    let db = Connection::open_with_flags(
        journal,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "活动请求日志不可读")?;
    db.busy_timeout(Duration::from_millis(100))
        .map_err(|_| "活动请求日志不可读")?;
    let count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM active_requests WHERE service_id=?1",
            [&lease.profile.id],
            |row| row.get(0),
        )
        .map_err(|_| "活动请求状态无法核验")?;
    let active = u64::try_from(count).map_err(|_| "活动请求计数无效")?;
    Ok(Activity {
        state: if active == 0 {
            ObserverState::Idle
        } else {
            ObserverState::Busy
        },
        active: Some(active),
        observer_pid: Some(pid),
        reason: if active == 0 {
            "观察器已核验空闲"
        } else {
            "仍有生成或排队请求，延后健康重验"
        },
    })
}

fn activity(state: &RuntimeState, lease: &Lease) -> Activity {
    activity_inner(state, lease).unwrap_or_else(|reason| Activity {
        state: ObserverState::Unknown,
        active: None,
        observer_pid: None,
        reason,
    })
}

#[cfg(windows)]
fn listener_identity(
    state: &RuntimeState,
    lease: &Lease,
    _: &Activity,
) -> Result<Vec<u32>, &'static str> {
    let ids =
        crate::external::listener_ids(&lease.profile).map_err(|_| "健康端口监听身份无法核验")?;
    if ids.len() != 1 || !owns_pid(state, lease, ids[0])? {
        return Err("健康端口不是唯一已核验的受管监听进程");
    }
    Ok(ids)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn listener_identity(
    state: &RuntimeState,
    lease: &Lease,
    observed: &Activity,
) -> Result<Vec<u32>, &'static str> {
    // Linux has no portable PID-owned socket API. Require the fresh observer
    // PID to own every matching listener inode; lack of /proc fails closed.
    let pid = observed
        .observer_pid
        .ok_or("缺少已核验观察器 PID，无法核验健康端口")?;
    if !owns_pid(state, lease, pid)? {
        return Err("健康端口 PID 不属于当前受管进程树");
    }
    let url = http::endpoint(&lease.profile, "/health").map_err(|_| "健康地址不是有效本机地址")?;
    let port = crate::external::local_port(&lease.profile).map_err(|_| "健康端口无效")?;
    let (table, address, wildcard) = match url.host() {
        Some(url::Host::Ipv4(ip)) => {
            let octets = ip.octets();
            (
                "tcp",
                format!("{:08X}", u32::from_ne_bytes(octets)),
                "00000000",
            )
        }
        Some(url::Host::Ipv6(ip)) => {
            let octets = ip.octets();
            let address = octets
                .as_chunks::<4>()
                .0
                .iter()
                .map(|chunk| format!("{:08X}", u32::from_ne_bytes(*chunk)))
                .collect::<String>();
            ("tcp6", address, "00000000000000000000000000000000")
        }
        _ => return Err("此平台的健康身份核验需要明确的 loopback IP 地址"),
    };
    let bytes = regular_file(Path::new(&format!("/proc/net/{table}")), 4 * 1024 * 1024)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "本机 TCP 表无法核验")?;
    let mut inodes = HashSet::new();
    for line in text.lines().skip(1) {
        let columns: Vec<_> = line.split_whitespace().collect();
        if columns.len() < 10 || columns[3] != "0A" {
            continue;
        }
        let Some((local, value)) = columns[1].rsplit_once(':') else {
            continue;
        };
        if (local == address || local == wildcard)
            && u16::from_str_radix(value, 16).ok() == Some(port)
        {
            inodes.insert(columns[9].to_string());
        }
    }
    if inodes.is_empty() {
        return Err("受管健康端口尚未监听");
    }
    let mut owned = HashSet::new();
    let entries =
        fs::read_dir(format!("/proc/{pid}/fd")).map_err(|_| "健康监听 socket 归属不可读")?;
    for (index, entry) in entries.enumerate() {
        if index >= 4096 {
            return Err("健康监听句柄数量超出核验范围");
        }
        let entry = entry.map_err(|_| "健康监听 socket 归属不可读")?;
        if let Ok(target) = fs::read_link(entry.path()) {
            if let Some(inode) = target
                .to_str()
                .and_then(|text| text.strip_prefix("socket:["))
                .and_then(|text| text.strip_suffix(']'))
            {
                owned.insert(inode.to_owned());
            }
        }
    }
    if !inodes.is_subset(&owned) {
        return Err("健康端口包含未知进程的监听 socket");
    }
    Ok(vec![pid])
}

/// The loopback address and port a health probe will connect to, as compared
/// against the macOS TCP table.
#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ListenTarget {
    address: std::net::IpAddr,
    port: u16,
}

#[cfg(any(target_os = "macos", test))]
fn listen_target(profile: &ServiceProfile) -> Result<ListenTarget, &'static str> {
    let url = http::endpoint(profile, "/health").map_err(|_| "健康地址不是有效本机地址")?;
    let port = crate::external::local_port(profile).map_err(|_| "健康端口无效")?;
    let address = match url.host() {
        Some(url::Host::Ipv4(ip)) => std::net::IpAddr::V4(ip),
        Some(url::Host::Ipv6(ip)) => std::net::IpAddr::V6(ip),
        _ => return Err("此平台的健康身份核验需要明确的 loopback IP 地址"),
    };
    Ok(ListenTarget { address, port })
}

/// One TCP LISTEN socket that could accept the health probe, as found in one
/// process's descriptor table: the holder and the kernel socket id (`soi_so`),
/// which is the same in every process sharing that descriptor.
#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DarwinListener {
    pid: u32,
    socket: u64,
}

/// The Linux rule on macOS data: every listening socket that could answer the
/// probe must be one the observer itself holds. Another process may share it
/// (an inherited descriptor) but may not hold a socket of its own.
#[cfg(any(target_os = "macos", test))]
fn darwin_listener_verdict(
    observer: u32,
    listeners: &[DarwinListener],
) -> Result<(), &'static str> {
    if listeners.is_empty() {
        return Err("受管健康端口尚未监听");
    }
    let owned: Vec<u64> = listeners
        .iter()
        .filter(|listener| listener.pid == observer)
        .map(|listener| listener.socket)
        .collect();
    if owned.is_empty()
        || listeners
            .iter()
            .any(|listener| !owned.contains(&listener.socket))
    {
        return Err("健康端口包含未知进程的监听 socket");
    }
    Ok(())
}

/// Layout of `struct socket_fdinfo` from `<sys/proc_info.h>` (stable public ABI
/// used by lsof): `psi` starts at 24, `soi_so` at psi+136, `soi_kind` at psi+232, and the TCP
/// `soi_proto.pri_tcp` union member at psi+240 holds `in_sockinfo` followed by
/// `tcpsi_state` at +80.
#[cfg(any(target_os = "macos", test))]
mod socket_fdinfo {
    pub const SIZE: usize = 792;
    const PSI: usize = 24;
    const KIND: usize = PSI + 232;
    const TCP: usize = PSI + 240;
    const LPORT: usize = TCP + 4;
    const VFLAG: usize = TCP + 24;
    const LADDR: usize = TCP + 48;
    const STATE: usize = TCP + 80;
    const SOCKET_ID: usize = PSI + 136;
    const SOCKINFO_TCP: i32 = 2;
    const TSI_S_LISTEN: i32 = 1;
    const INI_IPV4: u8 = 0x1;
    const INI_IPV6: u8 = 0x2;

    fn int(bytes: &[u8], at: usize) -> i32 {
        i32::from_ne_bytes(bytes[at..at + 4].try_into().unwrap())
    }

    /// `soi_so`: the kernel's (obfuscated) socket address, as lsof prints it.
    pub fn socket_id(bytes: &[u8]) -> u64 {
        u64::from_ne_bytes(bytes[SOCKET_ID..SOCKET_ID + 8].try_into().unwrap())
    }

    /// Whether one `socket_fdinfo` record is a TCP LISTEN socket that accepts
    /// connections for `target`.
    pub fn listens_for(bytes: &[u8], target: super::ListenTarget) -> bool {
        if bytes.len() < SIZE
            || int(bytes, KIND) != SOCKINFO_TCP
            || int(bytes, STATE) != TSI_S_LISTEN
        {
            return false;
        }
        // `insi_lport` is an int holding the port in network byte order.
        let port = u16::from_be(int(bytes, LPORT) as u16);
        if port != target.port {
            return false;
        }
        let vflag = bytes[VFLAG];
        let v4: [u8; 4] = bytes[LADDR + 12..LADDR + 16].try_into().unwrap();
        let v6: [u8; 16] = bytes[LADDR..LADDR + 16].try_into().unwrap();
        match target.address {
            std::net::IpAddr::V4(ip) => {
                vflag & INI_IPV4 != 0 && (v4 == [0; 4] || v4 == ip.octets())
            }
            std::net::IpAddr::V6(ip) => {
                vflag & INI_IPV6 != 0 && (v6 == [0; 16] || v6 == ip.octets())
            }
        }
    }
}

#[cfg(target_os = "macos")]
const DARWIN_UNREADABLE: &str = "健康监听 socket 归属不可读";
#[cfg(target_os = "macos")]
const DARWIN_TOO_MANY: &str = "健康监听句柄数量超出核验范围";

/// Every PID on the system (libproc; readable without privileges).
#[cfg(target_os = "macos")]
fn darwin_all_pids() -> Result<Vec<libc::c_int>, &'static str> {
    const MAX_PIDS: usize = 65_536;
    let mut pids: Vec<libc::c_int> = vec![0; MAX_PIDS + 1];
    let capacity = libc::c_int::try_from(pids.len() * std::mem::size_of::<libc::c_int>())
        .map_err(|_| "本机进程表不可读")?;
    // SAFETY: the buffer is valid for `capacity` bytes of pid_t values.
    let count = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), capacity) };
    let count = usize::try_from(count).map_err(|_| "本机进程表不可读")?;
    if count == 0 {
        return Err("本机进程表不可读");
    }
    if count > MAX_PIDS {
        return Err("本机进程表超出核验范围");
    }
    pids.truncate(count);
    Ok(pids)
}

/// The kernel ids of the TCP LISTEN sockets `pid` holds for `target`, read
/// from its own descriptor table through libproc (the macOS equivalent of
/// /proc/PID/fd). Fails when that table cannot be read: another account's
/// process, or one that has exited.
#[cfg(target_os = "macos")]
fn darwin_pid_listeners(pid: libc::c_int, target: ListenTarget) -> Result<Vec<u64>, &'static str> {
    const PROC_PIDFDSOCKETINFO: libc::c_int = 3;
    const MAX_FDS: usize = 65_536;
    let entry = std::mem::size_of::<libc::proc_fdinfo>();
    // SAFETY: a null buffer asks only for the size the table needs.
    let needed =
        unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
    let needed = usize::try_from(needed).map_err(|_| DARWIN_UNREADABLE)?;
    if needed == 0 {
        return Err(DARWIN_UNREADABLE);
    }
    // Room for descriptors opened between the two calls; a full buffer may be
    // truncated and fails closed.
    let slots = needed / entry + 64;
    if slots > MAX_FDS {
        return Err(DARWIN_TOO_MANY);
    }
    let mut fds = vec![
        libc::proc_fdinfo {
            proc_fd: 0,
            proc_fdtype: 0
        };
        slots
    ];
    let capacity = libc::c_int::try_from(slots * entry).map_err(|_| DARWIN_UNREADABLE)?;
    // SAFETY: the buffer is valid for `capacity` bytes of proc_fdinfo records.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDLISTFDS,
            0,
            fds.as_mut_ptr().cast(),
            capacity,
        )
    };
    let written = usize::try_from(written).map_err(|_| DARWIN_UNREADABLE)?;
    if written == 0 {
        return Err(DARWIN_UNREADABLE);
    }
    let count = written / entry;
    if count >= slots {
        return Err(DARWIN_TOO_MANY);
    }
    let mut info = vec![0u64; socket_fdinfo::SIZE.div_ceil(8)];
    let size = libc::c_int::try_from(socket_fdinfo::SIZE).map_err(|_| DARWIN_UNREADABLE)?;
    let mut sockets = Vec::new();
    for fd in &fds[..count] {
        if fd.proc_fdtype as libc::c_int != libc::PROX_FDTYPE_SOCKET {
            continue;
        }
        // SAFETY: `info` is 8-byte aligned and at least SIZE bytes long.
        let read = unsafe {
            libc::proc_pidfdinfo(
                pid,
                fd.proc_fd,
                PROC_PIDFDSOCKETINFO,
                info.as_mut_ptr().cast(),
                size,
            )
        };
        if read != size {
            // The descriptor may have closed since it was listed.
            continue;
        }
        // SAFETY: `info` holds `SIZE` initialised bytes.
        let bytes =
            unsafe { std::slice::from_raw_parts(info.as_ptr().cast::<u8>(), socket_fdinfo::SIZE) };
        if socket_fdinfo::listens_for(bytes, target) {
            sockets.push(socket_fdinfo::socket_id(bytes));
        }
    }
    Ok(sockets)
}

/// Every TCP LISTEN socket for `target` in every process whose descriptor
/// table this account can read (lsof's view without root). The observer's own
/// table must be readable.
#[cfg(target_os = "macos")]
fn darwin_listeners(
    observer: u32,
    target: ListenTarget,
) -> Result<Vec<DarwinListener>, &'static str> {
    let mut listeners = Vec::new();
    let mut observer_read = false;
    for pid in darwin_all_pids()? {
        let Ok(owner) = u32::try_from(pid) else {
            continue;
        };
        if owner == 0 {
            continue;
        }
        match darwin_pid_listeners(pid, target) {
            Ok(sockets) => {
                observer_read |= owner == observer;
                listeners.extend(
                    sockets
                        .into_iter()
                        .map(|socket| DarwinListener { pid: owner, socket }),
                );
            }
            // A table too large to read whole could hide a listener.
            Err(error) if owner == observer || error == DARWIN_TOO_MANY => return Err(error),
            // Other accounts' processes are not readable without root.
            Err(_) => {}
        }
    }
    if !observer_read {
        return Err(DARWIN_UNREADABLE);
    }
    Ok(listeners)
}

#[cfg(target_os = "macos")]
fn listener_identity(
    state: &RuntimeState,
    lease: &Lease,
    observed: &Activity,
) -> Result<Vec<u32>, &'static str> {
    // macOS has no /proc, and its TCP table sysctls only show the caller's own
    // sockets. libproc reads each process's descriptor table instead: every
    // listener that could answer the probe must be a socket the fresh observer
    // PID itself holds.
    let pid = observed
        .observer_pid
        .ok_or("缺少已核验观察器 PID，无法核验健康端口")?;
    if !owns_pid(state, lease, pid)? {
        return Err("健康端口 PID 不属于当前受管进程树");
    }
    let target = listen_target(&lease.profile)?;
    darwin_listener_verdict(pid, &darwin_listeners(pid, target)?)?;
    Ok(vec![pid])
}

fn client() -> Result<&'static reqwest::Client, &'static str> {
    static CLIENT: OnceLock<Result<reqwest::Client, reqwest::Error>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(1))
                .build()
        })
        .as_ref()
        .map_err(|_| "健康 HTTP 客户端不可用")
}

struct ProbeFailure {
    kind: FailureKind,
    status: Option<u16>,
    reason: &'static str,
}
impl ProbeFailure {
    fn new(kind: FailureKind, reason: &'static str) -> Self {
        Self {
            kind,
            status: None,
            reason,
        }
    }
}

async fn probe(profile: &ServiceProfile, timeout: Duration) -> Result<Option<bool>, ProbeFailure> {
    let future = async {
        let builder = http::request_builder(
            client().map_err(|_| {
                ProbeFailure::new(FailureKind::RequestUnavailable, "健康客户端不可用")
            })?,
            profile,
            "/health",
            "GET",
            None,
        )
        .map_err(|_| {
            ProbeFailure::new(FailureKind::RequestUnavailable, "健康请求地址或凭据不可用")
        })?;
        let response = builder.timeout(timeout).send().await.map_err(|error| {
            if error.is_timeout() {
                ProbeFailure::new(FailureKind::Timeout, "健康请求超时；进程已保留")
            } else {
                ProbeFailure::new(FailureKind::Connection, "健康连接失败；进程已保留")
            }
        })?;
        if !response.status().is_success() {
            return Err(ProbeFailure {
                kind: FailureKind::HttpStatus,
                status: Some(response.status().as_u16()),
                reason: "健康 API 返回失败状态；未保存响应正文",
            });
        }
        if response
            .content_length()
            .is_some_and(|bytes| bytes > MAX_RESPONSE_BYTES as u64)
        {
            return Err(ProbeFailure::new(
                FailureKind::Oversized,
                "健康响应超过 64 KiB 限制",
            ));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| {
                if error.is_timeout() {
                    ProbeFailure::new(FailureKind::Timeout, "健康响应正文超时；进程已保留")
                } else {
                    ProbeFailure::new(FailureKind::Connection, "健康响应未完整接收")
                }
            })?;
            if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(bytes.len()) {
                return Err(ProbeFailure::new(
                    FailureKind::Oversized,
                    "健康响应超过 64 KiB 限制",
                ));
            }
            bytes.extend(chunk);
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| ProbeFailure::new(FailureKind::InvalidJson, "健康响应不是有效 JSON"))?;
        if value["service"].as_str() != Some("strata") || value["status"].as_str() != Some("ok") {
            return Err(ProbeFailure::new(
                FailureKind::WrongService,
                "健康响应不是有效 Strata 服务",
            ));
        }
        Ok(value["loaded"].as_bool())
    };
    tokio::time::timeout(timeout, future)
        .await
        .unwrap_or_else(|_| {
            Err(ProbeFailure::new(
                FailureKind::Timeout,
                "健康请求超时；进程已保留",
            ))
        })
}

fn finish(
    mut snapshot: HealthSnapshot,
    phase: HealthPhase,
    reason: &str,
    time: u64,
) -> HealthResult {
    snapshot.phase = phase;
    snapshot.reason = reason.into();
    snapshot.checked_at = time;
    HealthResult {
        snapshot,
        action: HealthAction::None,
        recovery_may_reset: false,
    }
}

/// Call only for the selected running installation. Store the returned snapshot
/// in the supervisor, including deferred/unknown results, for bounded diagnostics.
pub async fn check(
    state: &RuntimeState,
    id: &str,
    previous: Option<&HealthSnapshot>,
) -> Result<HealthResult, String> {
    check_with_timeout(state, id, previous, PROBE_TIMEOUT).await
}

fn clear_current(snapshot: &mut HealthSnapshot) {
    snapshot.api_healthy = None;
    snapshot.loaded = None;
    snapshot.probe_attempted = false;
    snapshot.observer_state = ObserverState::Unknown;
    snapshot.active_requests = None;
    snapshot.pid = None;
}

fn desired(state: &RuntimeState) -> Result<bool, &'static str> {
    crate::store_get(state, "localServiceDesired".into())
        .map(|value| value.as_bool() != Some(false))
        .map_err(|_| "服务运行意愿无法读取，未发送健康请求")
}

async fn check_with_timeout(
    state: &RuntimeState,
    id: &str,
    previous: Option<&HealthSnapshot>,
    timeout: Duration,
) -> Result<HealthResult, String> {
    let time = crate::now();
    let mut snapshot = previous
        .filter(|snapshot| snapshot.profile_id == id)
        .cloned()
        .unwrap_or_else(|| HealthSnapshot::new(id));
    if !valid_id(id) {
        clear_current(&mut snapshot);
        return Ok(finish(
            snapshot,
            HealthPhase::Unknown,
            "安装标识无效，未读取观察器文件或发送请求",
            time,
        ));
    }
    match desired(state) {
        Ok(false) => {
            clear_current(&mut snapshot);
            return Ok(finish(
                snapshot,
                HealthPhase::Stopped,
                "用户已停止服务，未发送健康请求",
                time,
            ));
        }
        Err(reason) => {
            clear_current(&mut snapshot);
            return Ok(finish(snapshot, HealthPhase::Unknown, reason, time));
        }
        Ok(true) => {}
    }
    if state.shutting_down.load(Ordering::Acquire) {
        clear_current(&mut snapshot);
        return Ok(finish(
            snapshot,
            HealthPhase::Stopped,
            "后台正在退出，未发送健康请求",
            time,
        ));
    }
    let lease = match owned_lease(state, id) {
        Ok(Some(lease)) => lease,
        Ok(None) => {
            clear_current(&mut snapshot);
            return Ok(finish(
                snapshot,
                HealthPhase::Stopped,
                "受管服务已退出；交由既有有界恢复逻辑处理",
                time,
            ));
        }
        Err(reason) => {
            clear_current(&mut snapshot);
            return Ok(finish(snapshot, HealthPhase::Unknown, reason, time));
        }
    };
    // Cheap process-handle/desired-state checks precede the cache. A stopped or
    // newly replaced process cannot inherit a recent healthy API sample.
    if snapshot.pid == Some(lease.root_pid)
        && snapshot.checked_at > 0
        && time.saturating_sub(snapshot.checked_at) < PROBE_INTERVAL_MS
    {
        return Ok(HealthResult {
            snapshot,
            action: HealthAction::None,
            recovery_may_reset: false,
        });
    }
    clear_current(&mut snapshot);
    snapshot.pid = Some(lease.root_pid);
    if let Some(reason) = busy_reason(state, id) {
        return Ok(finish(snapshot, HealthPhase::Deferred, reason, time));
    }
    let before = activity(state, &lease);
    snapshot.observer_state = before.state.clone();
    snapshot.active_requests = before.active;
    if before.state == ObserverState::Busy {
        return Ok(finish(snapshot, HealthPhase::Deferred, before.reason, time));
    }
    let listeners = match listener_identity(state, &lease, &before) {
        Ok(ids) => ids,
        Err(reason) => return Ok(finish(snapshot, HealthPhase::Unknown, reason, time)),
    };
    snapshot.probe_attempted = true;
    let result = probe(&lease.profile, timeout).await;
    let still_desired = desired(state);
    if state.shutting_down.load(Ordering::Acquire) || still_desired == Ok(false) {
        clear_current(&mut snapshot);
        snapshot.probe_attempted = true;
        return Ok(finish(
            snapshot,
            HealthPhase::Stopped,
            "健康请求期间服务已停止，未采纳响应",
            time,
        ));
    }
    if let Err(reason) = still_desired {
        return Ok(finish(snapshot, HealthPhase::Unknown, reason, time));
    }
    let after_lease = match owned_lease(state, id) {
        Ok(Some(after))
            if after.root_pid == lease.root_pid
                && after.started_at == lease.started_at
                && same_profile(&after.profile, &lease.profile) =>
        {
            after
        }
        Ok(None) => {
            clear_current(&mut snapshot);
            snapshot.probe_attempted = true;
            return Ok(finish(
                snapshot,
                HealthPhase::Stopped,
                "健康请求期间受管进程已退出，未采纳响应",
                time,
            ));
        }
        _ => {
            return Ok(finish(
                snapshot,
                HealthPhase::Unknown,
                "健康请求期间受管进程身份改变，未采纳响应",
                time,
            ))
        }
    };
    let after = activity(state, &after_lease);
    snapshot.observer_state = after.state.clone();
    snapshot.active_requests = after.active;
    if before.observer_pid.is_some() && before.observer_pid != after.observer_pid {
        return Ok(finish(
            snapshot,
            HealthPhase::Unknown,
            "健康请求期间观察器进程身份改变，未采纳响应",
            time,
        ));
    }
    if listener_identity(state, &after_lease, &after).ok().as_ref() != Some(&listeners) {
        return Ok(finish(
            snapshot,
            HealthPhase::Unknown,
            "健康请求期间监听进程身份改变，未采纳响应",
            time,
        ));
    }
    if let Some(reason) = busy_reason(state, id) {
        return Ok(finish(snapshot, HealthPhase::Deferred, reason, time));
    }
    if after.state == ObserverState::Busy {
        return Ok(finish(snapshot, HealthPhase::Deferred, after.reason, time));
    }
    snapshot.checked_at = time;
    snapshot.probe_attempted = true;
    match result {
        Ok(loaded) => {
            snapshot.api_healthy = Some(true);
            snapshot.loaded = loaded;
            snapshot.last_healthy_at = Some(crate::now());
            if after.state != ObserverState::Idle {
                snapshot.phase = HealthPhase::Unknown;
                snapshot.reason = format!("API 健康；{}，未自动预热或重置恢复计数", after.reason);
                return Ok(HealthResult {
                    snapshot,
                    action: HealthAction::None,
                    recovery_may_reset: false,
                });
            }
            snapshot.phase = HealthPhase::Healthy;
            snapshot.reason = if loaded == Some(true) {
                "API 健康，模型已加载"
            } else if loaded == Some(false) {
                "API 健康，模型未加载"
            } else {
                "API 健康，模型加载状态未知"
            }
            .into();
            let policy = match policy::get(state) {
                Ok(policy) => policy,
                Err(_) => {
                    snapshot.phase = HealthPhase::Unknown;
                    snapshot.reason = "API 健康；后台策略不可读，未自动预热或重置恢复计数".into();
                    return Ok(HealthResult {
                        snapshot,
                        action: HealthAction::None,
                        recovery_may_reset: false,
                    });
                }
            };
            snapshot.consecutive_failures = 0;
            let preload = loaded == Some(false) && policy.mode == "alwaysReady";
            Ok(HealthResult {
                snapshot,
                action: if preload {
                    HealthAction::Preload
                } else {
                    HealthAction::None
                },
                recovery_may_reset: true,
            })
        }
        Err(failure) => {
            let countable = failure.kind != FailureKind::RequestUnavailable;
            snapshot.api_healthy = countable.then_some(false);
            snapshot.failures.push(FailureSample {
                at: time,
                kind: failure.kind,
                http_status: failure.status,
                reason: failure.reason.into(),
            });
            if snapshot.failures.len() > MAX_FAILURE_SAMPLES {
                snapshot.failures.remove(0);
            }
            if countable && after.state == ObserverState::Idle {
                snapshot.consecutive_failures = snapshot.consecutive_failures.saturating_add(1);
                snapshot.phase = if snapshot.consecutive_failures >= DEGRADE_AFTER {
                    HealthPhase::Degraded
                } else {
                    HealthPhase::Checking
                };
                snapshot.reason = failure.reason.into();
            } else {
                snapshot.phase = HealthPhase::Unknown;
                snapshot.reason =
                    format!("{}；{}，未计入连续空闲故障", failure.reason, after.reason);
            }
            Ok(HealthResult {
                snapshot,
                action: HealthAction::None,
                recovery_may_reset: false,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::processes::OwnedProcess;
    use serde_json::json;
    use std::{path::PathBuf, process::Command, sync::Arc};

    // Real TCP and real owned OS process. No model, service installation,
    // default data directory, GUI, or user runtime is touched by these tests.
    const SERVER: &str = r#"
import json, os, pathlib, sqlite3, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
root=pathlib.Path(sys.argv[1]); journal=root/'analytics'/'journal.sqlite3'
service_id=sys.argv[2]
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        with (root/'health-requests').open('a',encoding='utf8') as f: f.write(self.path+'\n')
        plan=json.loads((root/'response.json').read_text(encoding='utf8'))
        time.sleep(plan.get('delayMs',0)/1000)
        body=plan.get('body',{}); data=(json.dumps(body) if isinstance(body,(dict,list)) else str(body)).encode()
        self.send_response(plan.get('status',200))
        self.send_header('Content-Length',str(len(data))); self.end_headers()
        try:
            if plan.get('dripMs'):
                for byte in data:
                    self.wfile.write(bytes([byte])); self.wfile.flush(); time.sleep(plan['dripMs']/1000)
            else: self.wfile.write(data)
        except (BrokenPipeError,ConnectionResetError): pass
    def do_POST(self):
        db=sqlite3.connect(journal)
        db.execute('INSERT INTO active_requests VALUES(?,?)',('held-request',service_id)); db.commit()
        self.send_response(200); self.send_header('Content-Length','2'); self.end_headers()
        self.wfile.write(b'A'); self.wfile.flush()
        while not (root/'release-held').exists(): time.sleep(.01)
        try: self.wfile.write(b'B'); self.wfile.flush()
        except (BrokenPipeError,ConnectionResetError): pass
        db.execute('DELETE FROM active_requests WHERE request_id=?',('held-request',)); db.commit(); db.close()
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
(root/'ready.json').write_text(json.dumps({'pid':os.getpid(),'port':server.server_port}),encoding='utf8')
server.serve_forever()
"#;

    struct Fixture {
        _temp: tempfile::TempDir,
        state: Arc<RuntimeState>,
        profile: ServiceProfile,
        pid: u32,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.state.cleanup();
        }
    }
    impl Fixture {
        async fn new(loaded: bool) -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path();
            let state = RuntimeState::open(root.to_owned()).unwrap();
            fs::create_dir(root.join("analytics")).unwrap();
            let db = Connection::open(root.join("analytics/journal.sqlite3")).unwrap();
            db.execute_batch("CREATE TABLE active_requests(request_id TEXT PRIMARY KEY, service_id TEXT NOT NULL);").unwrap();
            fs::write(root.join("server.py"), SERVER).unwrap();
            fs::write(root.join("config.json"), b"{}").unwrap();
            fs::write(
                root.join("response.json"),
                serde_json::to_vec(
                    &json!({"body":{"service":"strata","status":"ok","loaded":loaded}}),
                )
                .unwrap(),
            )
            .unwrap();
            let id = format!("health-{}", uuid::Uuid::new_v4());
            let python = ["python", "python3", "py"]
                .iter()
                .find_map(|name| {
                    let mut command = Command::new(name);
                    command.args(["-I", "-S", "-c", "import sys; print(sys.executable)"]);
                    crate::processes::hidden(&mut command);
                    let output = command.output().ok()?;
                    output
                        .status
                        .success()
                        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
                })
                .expect("health TCP fixtures require the CI-provided Python executable");
            let mut command = Command::new(&python);
            command
                .args(["-I", "-S"])
                .arg(root.join("server.py"))
                .arg(root)
                .arg(&id)
                .current_dir(root);
            let mut process = OwnedProcess::spawn(command, state.logs.clone(), &id).unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            let ready = loop {
                if let Ok(bytes) = fs::read(root.join("ready.json")) {
                    if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                        break value;
                    }
                }
                assert!(
                    process.refresh().unwrap().running,
                    "owned health fixture exited before readiness"
                );
                assert!(
                    std::time::Instant::now() < deadline,
                    "owned health fixture did not bind TCP"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            };
            let pid = u32::try_from(ready["pid"].as_u64().unwrap()).unwrap();
            let profile = ServiceProfile {
                id: id.clone(),
                name: "isolated health fixture".into(),
                base_url: format!("http://127.0.0.1:{}", ready["port"].as_u64().unwrap()),
                install_dir: root.to_string_lossy().into(),
                python_path: python,
                config_path: root.join("config.json").to_string_lossy().into(),
                managed: true,
            };
            process.profile = Some(profile.clone());
            state.processes.lock().unwrap().insert(id.clone(), process);
            let serialized = serde_json::to_string(&profile).unwrap();
            state.database.lock().unwrap().execute("INSERT INTO local_installations(id,profile,original_profile,imported_at) VALUES(?1,?2,?2,0)", rusqlite::params![id,serialized]).unwrap();
            let fixture = Self {
                _temp: temp,
                state,
                profile,
                pid,
            };
            fixture.observer(pid);
            fixture
        }
        fn observer(&self, pid: u32) {
            let status = json!({"schemaVersion":1,"serviceId":self.profile.id,"sessionId":"fixture-session","pid":pid,
                "updatedAtMs":crate::now(),"supported":true,"observerActive":true,"journalWriteFailed":false,"error":null});
            fs::write(
                self.state
                    .data_dir
                    .join("analytics")
                    .join(format!("status-{}.json", self.profile.id)),
                serde_json::to_vec(&status).unwrap(),
            )
            .unwrap();
        }
        fn response(&self, plan: Value) {
            fs::write(
                self.state.data_dir.join("response.json"),
                serde_json::to_vec(&plan).unwrap(),
            )
            .unwrap();
        }
        fn requests(&self) -> usize {
            fs::read_to_string(self.state.data_dir.join("health-requests"))
                .unwrap_or_default()
                .lines()
                .count()
        }
        fn running(&self) -> bool {
            self.state
                .processes
                .lock()
                .unwrap()
                .get_mut(&self.profile.id)
                .unwrap()
                .refresh()
                .unwrap()
                .running
        }
        async fn check(&self, previous: Option<&HealthSnapshot>) -> HealthResult {
            check_with_timeout(
                &self.state,
                &self.profile.id,
                previous,
                Duration::from_millis(300),
            )
            .await
            .unwrap()
        }
        fn expire(snapshot: &mut HealthSnapshot) {
            snapshot.checked_at = crate::now().saturating_sub(PROBE_INTERVAL_MS + 1);
        }
        fn save_profile(&self, profile: &ServiceProfile) {
            self.state
                .database
                .lock()
                .unwrap()
                .execute(
                    "UPDATE local_installations SET profile=?2 WHERE id=?1",
                    rusqlite::params![profile.id, serde_json::to_string(profile).unwrap()],
                )
                .unwrap();
        }
        fn select_for_recovery(&self) {
            crate::store_set(
                &self.state,
                "activeLocalInstallation".into(),
                json!(self.profile.id),
            )
            .unwrap();
            crate::store_set(&self.state, "localServiceDesired".into(), json!(true)).unwrap();
            *self.state.recovery.lock().unwrap() = crate::RecoveryStatus {
                attempts: 2,
                next_retry_at: 0,
                last_error: Some("isolated fixture recovery sample".into()),
                repair_required: false,
                last_started_at: crate::now().saturating_sub(65_000),
                ..Default::default()
            };
        }
        fn expire_saved_health(&self) {
            if let Some(snapshot) = self
                .state
                .health_snapshots
                .lock()
                .unwrap()
                .get_mut(&self.profile.id)
            {
                Self::expire(snapshot);
            }
        }
    }

    fn target(address: &str, port: u16) -> ListenTarget {
        ListenTarget {
            address: address.parse().unwrap(),
            port,
        }
    }

    #[test]
    fn darwin_listeners_must_all_be_sockets_the_observer_holds() {
        let held = |pid, socket| DarwinListener { pid, socket };
        assert_eq!(darwin_listener_verdict(7, &[held(7, 0xa)]), Ok(()));
        // A child that inherited the observer's socket shares it, as on Linux.
        assert_eq!(
            darwin_listener_verdict(7, &[held(7, 0xa), held(8, 0xa), held(7, 0xb)]),
            Ok(())
        );
        assert_eq!(darwin_listener_verdict(7, &[]), Err("受管健康端口尚未监听"));
        // Another process with a socket of its own (a wildcard beside the
        // loopback listener, or the port without the observer at all).
        assert_eq!(
            darwin_listener_verdict(7, &[held(7, 0xa), held(9, 0xc)]),
            Err("健康端口包含未知进程的监听 socket")
        );
        assert_eq!(
            darwin_listener_verdict(7, &[held(9, 0xc)]),
            Err("健康端口包含未知进程的监听 socket")
        );
    }

    fn fdinfo(kind: i32, state: i32, port: u16, vflag: u8, address: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0u8; socket_fdinfo::SIZE];
        bytes[256..260].copy_from_slice(&kind.to_ne_bytes());
        bytes[344..348].copy_from_slice(&state.to_ne_bytes());
        let network = i32::from(u16::from_ne_bytes(port.to_be_bytes()));
        bytes[268..272].copy_from_slice(&network.to_ne_bytes());
        bytes[288] = vflag;
        bytes[160..168].copy_from_slice(&0x1234_5678_9abc_def0u64.to_ne_bytes());
        let start = if address.len() == 4 { 312 + 12 } else { 312 };
        bytes[start..start + address.len()].copy_from_slice(address);
        bytes
    }

    #[test]
    fn darwin_socket_fdinfo_matches_only_tcp_listeners_for_the_probe_address() {
        let v4 = target("127.0.0.1", 62758);
        assert!(socket_fdinfo::listens_for(
            &fdinfo(2, 1, 62758, 1, &[127, 0, 0, 1]),
            v4
        ));
        assert!(socket_fdinfo::listens_for(
            &fdinfo(2, 1, 62758, 1, &[0; 4]),
            v4
        ));
        assert!(socket_fdinfo::listens_for(
            &fdinfo(2, 1, 62758, 3, &[0; 16]),
            v4
        ));
        assert!(!socket_fdinfo::listens_for(
            &fdinfo(2, 4, 62758, 1, &[127, 0, 0, 1]),
            v4
        ));
        assert!(!socket_fdinfo::listens_for(
            &fdinfo(1, 1, 62758, 1, &[127, 0, 0, 1]),
            v4
        ));
        assert!(!socket_fdinfo::listens_for(
            &fdinfo(2, 1, 62759, 1, &[127, 0, 0, 1]),
            v4
        ));
        assert!(!socket_fdinfo::listens_for(
            &fdinfo(2, 1, 62758, 1, &[10, 0, 0, 1]),
            v4
        ));
        assert!(!socket_fdinfo::listens_for(
            &fdinfo(2, 1, 62758, 2, &[0; 16]),
            v4
        ));
        assert!(!socket_fdinfo::listens_for(
            &fdinfo(2, 1, 62758, 1, &[127, 0, 0, 1])[..socket_fdinfo::SIZE - 1],
            v4
        ));
        assert_eq!(
            socket_fdinfo::socket_id(&fdinfo(2, 1, 62758, 1, &[127, 0, 0, 1])),
            0x1234_5678_9abc_def0
        );
        let v6 = target("::1", 62758);
        let mut loopback = [0u8; 16];
        loopback[15] = 1;
        assert!(socket_fdinfo::listens_for(
            &fdinfo(2, 1, 62758, 2, &loopback),
            v6
        ));
        assert!(!socket_fdinfo::listens_for(
            &fdinfo(2, 1, 62758, 1, &[127, 0, 0, 1]),
            v6
        ));
    }

    #[test]
    fn listen_target_requires_a_literal_loopback_address() {
        let mut profile = ServiceProfile {
            id: "target".into(),
            name: "target".into(),
            base_url: "http://127.0.0.1:62758".into(),
            install_dir: String::new(),
            python_path: String::new(),
            config_path: String::new(),
            managed: true,
        };
        assert_eq!(listen_target(&profile), Ok(target("127.0.0.1", 62758)));
        profile.base_url = "http://[::1]:62758".into();
        assert_eq!(listen_target(&profile), Ok(target("::1", 62758)));
        profile.base_url = "http://localhost:62758".into();
        assert!(listen_target(&profile).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_reads_every_listener_for_the_probe_through_libproc() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let own = target("127.0.0.1", port);
        let pid = std::process::id();
        let found = darwin_listeners(pid, own).unwrap();
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].pid, pid);
        assert_ne!(found[0].socket, 0);
        assert_eq!(darwin_listener_verdict(pid, &found), Ok(()));
        // Another observer PID does not hold this socket.
        assert_eq!(
            darwin_listener_verdict(pid + 1, &found),
            Err("健康端口包含未知进程的监听 socket")
        );
        assert_eq!(darwin_listeners(pid, target("::1", port)), Ok(vec![]));
        // The PID table includes this process and at least launchd.
        let pids = darwin_all_pids().unwrap();
        assert!(pids.contains(&(pid as libc::c_int)) && pids.contains(&1));
        drop(listener);
        assert_eq!(darwin_listeners(pid, own), Ok(vec![]));
        // A process this account cannot read, or one that does not exist.
        assert!(darwin_listeners(u32::MAX - 1, own).is_err());
    }

    #[tokio::test]
    async fn real_owned_health_distinguishes_loading_and_only_idle_always_ready_preloads() {
        let fixture = Fixture::new(false).await;
        let mut lazy = fixture.check(None).await;
        assert_eq!(lazy.snapshot.phase, HealthPhase::Healthy);
        assert_eq!(lazy.snapshot.api_healthy, Some(true));
        assert_eq!(lazy.snapshot.loaded, Some(false));
        assert!(lazy.recovery_may_reset);
        assert_eq!(lazy.action, HealthAction::None);
        policy::set(
            &fixture.state,
            policy::BackgroundPolicy {
                mode: "alwaysReady".into(),
                auto_recover: true,
                ..policy::BackgroundPolicy::default()
            },
        )
        .unwrap();
        Fixture::expire(&mut lazy.snapshot);
        let mut ready = fixture.check(Some(&lazy.snapshot)).await;
        assert_eq!(ready.action, HealthAction::Preload);
        fixture.response(json!({"body":{"service":"strata","status":"ok","loaded":true}}));
        Fixture::expire(&mut ready.snapshot);
        let loaded = fixture.check(Some(&ready.snapshot)).await;
        assert_eq!(loaded.snapshot.loaded, Some(true));
        assert_eq!(loaded.action, HealthAction::None);
        assert!(fixture.running());
    }

    #[tokio::test]
    async fn invalid_status_json_identity_and_size_are_bounded_without_payload_capture() {
        let fixture = Fixture::new(true).await;
        let marker = "DO_NOT_RECORD_RESPONSE_PAYLOAD";
        let cases = [
            (json!({"status":503,"body":marker}), FailureKind::HttpStatus),
            (json!({"body":marker}), FailureKind::InvalidJson),
            (
                json!({"body":{"service":marker,"status":"ok","loaded":true}}),
                FailureKind::WrongService,
            ),
            (
                json!({"body":marker.repeat(MAX_RESPONSE_BYTES)}),
                FailureKind::Oversized,
            ),
        ];
        let mut previous = None;
        for (index, (plan, kind)) in cases.iter().cycle().take(10).enumerate() {
            fixture.response(plan.clone());
            if let Some(snapshot) = &mut previous {
                Fixture::expire(snapshot);
            }
            let result = fixture.check(previous.as_ref()).await;
            assert_eq!(result.snapshot.consecutive_failures, index as u8 + 1);
            assert_eq!(
                result.snapshot.phase,
                if index < 2 {
                    HealthPhase::Checking
                } else {
                    HealthPhase::Degraded
                }
            );
            assert_eq!(&result.snapshot.failures.last().unwrap().kind, kind);
            assert!(result.snapshot.failures.len() <= MAX_FAILURE_SAMPLES);
            assert!(!serde_json::to_string(&result.snapshot)
                .unwrap()
                .contains(marker));
            assert!(!result.recovery_may_reset);
            assert_eq!(result.action, HealthAction::None);
            previous = Some(result.snapshot);
        }
        assert!(fixture.running());
        fixture.response(json!({"body":{"service":"strata","status":"ok"}}));
        Fixture::expire(previous.as_mut().unwrap());
        let recovered = fixture.check(previous.as_ref()).await;
        assert_eq!(recovered.snapshot.phase, HealthPhase::Healthy);
        assert_eq!(recovered.snapshot.consecutive_failures, 0);
        assert_eq!(recovered.snapshot.loaded, None);
        assert!(recovered.recovery_may_reset);
        assert_eq!(recovered.snapshot.failures.len(), MAX_FAILURE_SAMPLES);
    }

    #[tokio::test]
    async fn hanging_headers_and_slow_body_timeout_preserve_the_owned_process() {
        let fixture = Fixture::new(true).await;
        for plan in [
            json!({"delayMs":1000,"body":{"service":"strata","status":"ok"}}),
            json!({"dripMs":100,"body":{"service":"strata","status":"ok"}}),
        ] {
            fixture.response(plan);
            let start = std::time::Instant::now();
            let result = check_with_timeout(
                &fixture.state,
                &fixture.profile.id,
                None,
                Duration::from_millis(120),
            )
            .await
            .unwrap();
            assert!(start.elapsed() < Duration::from_secs(2));
            assert_eq!(
                result.snapshot.failures.last().unwrap().kind,
                FailureKind::Timeout
            );
            assert_eq!(result.snapshot.consecutive_failures, 1);
            assert!(!result.recovery_may_reset);
            assert!(fixture.running());
        }
    }

    #[tokio::test]
    async fn long_request_maintenance_loading_and_update_do_not_probe_or_interrupt() {
        let fixture = Fixture::new(true).await;
        fixture.select_for_recovery();
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let response = client
            .post(format!("{}/hold", fixture.profile.base_url))
            .send()
            .await
            .unwrap();
        let mut stream = response.bytes_stream();
        assert_eq!(&stream.next().await.unwrap().unwrap()[..], b"A");
        let mut previous = HealthSnapshot::new(&fixture.profile.id);
        previous.consecutive_failures = 2;
        let result = fixture.check(Some(&previous)).await;
        assert_eq!(result.snapshot.phase, HealthPhase::Deferred);
        assert_eq!(result.snapshot.consecutive_failures, 2);
        assert!(!result.snapshot.probe_attempted);
        assert!(!result.recovery_may_reset);
        assert_eq!(fixture.requests(), 0);
        assert!(fixture.running());
        let mut busy_snapshot = result.snapshot;
        Fixture::expire(&mut busy_snapshot);
        fixture
            .state
            .health_snapshots
            .lock()
            .unwrap()
            .insert(fixture.profile.id.clone(), busy_snapshot);
        fixture.state.clone().recover_tick().await.unwrap();
        let status = fixture.state.status().unwrap();
        assert_eq!(status["health"][&fixture.profile.id]["phase"], "deferred");
        assert_eq!(status["health"][&fixture.profile.id]["activeRequests"], 1);
        assert_eq!(
            status["health"][&fixture.profile.id]["consecutiveFailures"],
            2
        );
        assert_eq!(status["recovery"]["attempts"], 2);
        assert_eq!(fixture.requests(), 0);
        fs::write(fixture.state.data_dir.join("release-held"), b"release").unwrap();
        assert_eq!(&stream.next().await.unwrap().unwrap()[..], b"B");
        assert!(stream.next().await.is_none());
        let gate =
            crate::maintenance::begin(&fixture.state, &fixture.profile.id, None, "tuning").unwrap();
        assert_eq!(
            fixture.check(None).await.snapshot.phase,
            HealthPhase::Deferred
        );
        drop(gate);
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        fixture
            .state
            .ensure_locks
            .lock()
            .await
            .insert(fixture.profile.id.clone(), lock.clone());
        let loading = lock.lock().await;
        assert_eq!(
            fixture.check(None).await.snapshot.phase,
            HealthPhase::Deferred
        );
        drop(loading);
        fixture
            .state
            .runtime_upgrading
            .store(true, Ordering::Release);
        assert_eq!(
            fixture.check(None).await.snapshot.phase,
            HealthPhase::Deferred
        );
        fixture
            .state
            .runtime_upgrading
            .store(false, Ordering::Release);
        assert_eq!(fixture.requests(), 0);
        assert!(fixture.running());
    }

    #[tokio::test]
    async fn cached_checks_do_not_change_sample_time_or_reset_recovery_again() {
        let fixture = Fixture::new(true).await;
        let first = fixture.check(None).await;
        let second = fixture.check(Some(&first.snapshot)).await;
        assert_eq!(second.snapshot.checked_at, first.snapshot.checked_at);
        assert_eq!(
            second.snapshot.last_healthy_at,
            first.snapshot.last_healthy_at
        );
        assert!(!second.recovery_may_reset);
        assert_eq!(second.action, HealthAction::None);
        assert_eq!(fixture.requests(), 1);
    }

    #[tokio::test]
    async fn unknown_observer_pid_or_file_never_proves_idle_or_allows_preload() {
        let fixture = Fixture::new(false).await;
        policy::set(
            &fixture.state,
            policy::BackgroundPolicy {
                mode: "alwaysReady".into(),
                auto_recover: true,
                ..policy::BackgroundPolicy::default()
            },
        )
        .unwrap();
        fixture.observer(std::process::id());
        let own_pid = fixture.check(None).await;
        assert_eq!(own_pid.snapshot.phase, HealthPhase::Unknown);
        assert!(!own_pid.recovery_may_reset);
        assert_eq!(own_pid.action, HealthAction::None);
        fixture.observer(fixture.pid);
        let status = fixture
            .state
            .data_dir
            .join("analytics")
            .join(format!("status-{}.json", fixture.profile.id));
        fs::write(status, b"not a status file").unwrap();
        let invalid = fixture.check(None).await;
        assert_eq!(invalid.snapshot.phase, HealthPhase::Unknown);
        assert!(!invalid.recovery_may_reset);
        assert_eq!(invalid.action, HealthAction::None);
        let invalid_id = check(&fixture.state, "../status-other", None)
            .await
            .unwrap();
        assert_eq!(invalid_id.snapshot.phase, HealthPhase::Unknown);
        assert!(!invalid_id.snapshot.probe_attempted);
        assert!(fixture.running());
    }

    #[tokio::test]
    async fn unowned_listener_or_changed_registered_profile_is_rejected_before_http() {
        let fixture = Fixture::new(true).await;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut redirected = fixture.profile.clone();
        redirected.base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        fixture.save_profile(&redirected);
        fixture
            .state
            .processes
            .lock()
            .unwrap()
            .get_mut(&fixture.profile.id)
            .unwrap()
            .profile = Some(redirected.clone());
        let unknown = fixture.check(None).await;
        assert_eq!(unknown.snapshot.phase, HealthPhase::Unknown);
        assert!(!unknown.snapshot.probe_attempted);
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        redirected.config_path = PathBuf::from("another-owner.json").to_string_lossy().into();
        fixture.save_profile(&redirected);
        let changed = fixture.check(None).await;
        assert_eq!(changed.snapshot.phase, HealthPhase::Unknown);
        assert!(!changed.snapshot.probe_attempted);
        assert_eq!(fixture.requests(), 0);
        assert!(fixture.running());
    }

    #[tokio::test]
    async fn identity_changed_during_probe_cannot_reset_recovery_or_preload() {
        let fixture = Fixture::new(false).await;
        fixture.response(
            json!({"delayMs":150,"body":{"service":"strata","status":"ok","loaded":false}}),
        );
        let state = fixture.state.clone();
        let id = fixture.profile.id.clone();
        let checking = tokio::spawn(async move {
            check_with_timeout(&state, &id, None, Duration::from_secs(1))
                .await
                .unwrap()
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while fixture.requests() == 0 {
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let mut changed = fixture.profile.clone();
        changed.install_dir = fixture
            .state
            .data_dir
            .join("different-runtime")
            .to_string_lossy()
            .into();
        fixture.save_profile(&changed);
        let result = checking.await.unwrap();
        assert_eq!(result.snapshot.phase, HealthPhase::Unknown);
        assert_eq!(result.snapshot.api_healthy, None);
        assert!(!result.recovery_may_reset);
        assert_eq!(result.action, HealthAction::None);
        assert!(fixture.running());
    }

    #[tokio::test]
    async fn desired_stop_shutdown_and_owned_exit_override_recent_healthy_cache() {
        let fixture = Fixture::new(true).await;
        let healthy = fixture.check(None).await;
        assert_eq!(healthy.snapshot.phase, HealthPhase::Healthy);
        crate::store_set(&fixture.state, "localServiceDesired".into(), json!(false)).unwrap();
        let stopped = fixture.check(Some(&healthy.snapshot)).await;
        assert_eq!(stopped.snapshot.phase, HealthPhase::Stopped);
        assert_eq!(stopped.snapshot.api_healthy, None);
        assert_eq!(stopped.snapshot.loaded, None);
        assert_eq!(stopped.snapshot.pid, None);
        assert_eq!(
            stopped.snapshot.last_healthy_at,
            healthy.snapshot.last_healthy_at
        );
        assert!(!stopped.snapshot.probe_attempted);
        assert!(!stopped.recovery_may_reset);
        assert_eq!(fixture.requests(), 1);
        assert!(fixture.running());
        crate::store_set(&fixture.state, "localServiceDesired".into(), json!(true)).unwrap();
        fixture.state.shutting_down.store(true, Ordering::Release);
        let shutting_down = fixture.check(Some(&healthy.snapshot)).await;
        assert_eq!(shutting_down.snapshot.phase, HealthPhase::Stopped);
        assert_eq!(shutting_down.snapshot.api_healthy, None);
        assert_eq!(fixture.requests(), 1);
        fixture.state.shutting_down.store(false, Ordering::Release);
        fixture
            .state
            .processes
            .lock()
            .unwrap()
            .get_mut(&fixture.profile.id)
            .unwrap()
            .stop()
            .unwrap();
        let exited = fixture.check(Some(&healthy.snapshot)).await;
        assert_eq!(exited.snapshot.phase, HealthPhase::Stopped);
        assert_eq!(exited.snapshot.pid, None);
        assert!(!exited.snapshot.probe_attempted);
        assert!(!exited.recovery_may_reset);
        assert_eq!(fixture.requests(), 1);
    }

    #[tokio::test]
    async fn recover_tick_records_health_when_recovery_disabled_without_preloading() {
        let fixture = Fixture::new(false).await;
        fixture.select_for_recovery();
        policy::set(
            &fixture.state,
            policy::BackgroundPolicy {
                mode: "alwaysReady".into(),
                auto_recover: false,
                ..policy::BackgroundPolicy::default()
            },
        )
        .unwrap();
        fixture.state.clone().recover_tick().await.unwrap();
        let status = fixture.state.status().unwrap();
        let health = &status["health"][&fixture.profile.id];
        assert_eq!(health["phase"], "healthy");
        assert_eq!(health["apiHealthy"], true);
        assert_eq!(health["loaded"], false);
        assert!(health["checkedAt"].as_u64().unwrap() > 0);
        assert!(health["lastHealthyAt"].as_u64().unwrap() > 0);
        assert_eq!(status["recovery"]["attempts"], 2);
        assert_eq!(fixture.requests(), 1);
        fixture.state.clone().recover_tick().await.unwrap();
        assert_eq!(fixture.state.status().unwrap()["recovery"]["attempts"], 2);
        assert_eq!(fixture.requests(), 1);
        crate::store_set(&fixture.state, "localServiceDesired".into(), json!(false)).unwrap();
        fixture.state.clone().recover_tick().await.unwrap();
        assert!(fixture.state.status().unwrap()["health"]
            .get(&fixture.profile.id)
            .is_none());
        assert!(fixture.running());
    }

    #[tokio::test]
    async fn recover_tick_invalid_busy_and_cached_results_cannot_reset_recovery() {
        let fixture = Fixture::new(true).await;
        fixture.select_for_recovery();
        fixture.response(json!({"status":503,"body":"not recorded"}));
        for attempt in 1..=3 {
            fixture.expire_saved_health();
            fixture.state.clone().recover_tick().await.unwrap();
            let status = fixture.state.status().unwrap();
            assert_eq!(
                status["health"][&fixture.profile.id]["consecutiveFailures"],
                attempt
            );
            assert_eq!(status["recovery"]["attempts"], 2);
            assert_eq!(
                status["recovery"]["lastError"],
                "isolated fixture recovery sample"
            );
        }
        assert_eq!(
            fixture.state.status().unwrap()["health"][&fixture.profile.id]["phase"],
            "degraded"
        );
        fixture.expire_saved_health();
        let gate =
            crate::maintenance::begin(&fixture.state, &fixture.profile.id, None, "tuning").unwrap();
        fixture.state.clone().recover_tick().await.unwrap();
        let status = fixture.state.status().unwrap();
        assert_eq!(status["health"][&fixture.profile.id]["phase"], "deferred");
        assert_eq!(status["recovery"]["attempts"], 2);
        assert_eq!(fixture.requests(), 3);
        drop(gate);
        // Only a new valid sample after the stable window clears accounting.
        fixture.response(json!({"body":{"service":"strata","status":"ok","loaded":true}}));
        fixture.expire_saved_health();
        fixture.state.clone().recover_tick().await.unwrap();
        assert_eq!(fixture.state.status().unwrap()["recovery"]["attempts"], 0);
        *fixture.state.recovery.lock().unwrap() = crate::RecoveryStatus {
            attempts: 2,
            last_started_at: crate::now().saturating_sub(65_000),
            ..Default::default()
        };
        fixture.state.clone().recover_tick().await.unwrap();
        assert_eq!(fixture.state.status().unwrap()["recovery"]["attempts"], 2);
        assert_eq!(fixture.requests(), 4);
        assert!(fixture.running());
    }
}
