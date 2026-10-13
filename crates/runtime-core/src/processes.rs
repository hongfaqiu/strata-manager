use crate::types::*;
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use uuid::Uuid;

pub type Logs = Arc<Mutex<LogStore>>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum LogKind {
    Task,
    Service,
}

struct LogBucket {
    kind: LogKind,
    entries: VecDeque<LogEntry>,
    sequence: VecDeque<u64>,
    registered: u64,
    active: bool,
}

/// In-memory diagnostics have bounded metadata and payload. Writers never
/// create buckets: retiring a task also retires its late stdout/stderr readers.
pub struct LogStore {
    buckets: HashMap<String, LogBucket>,
    sequence: u64,
    entries: usize,
    bytes: usize,
    max_buckets: usize,
    max_entries: usize,
    max_bytes: usize,
}

impl Default for LogStore {
    fn default() -> Self {
        Self::with_limits(512, 16_000, 16 * 1024 * 1024)
    }
}

impl LogStore {
    fn with_limits(max_buckets: usize, max_entries: usize, max_bytes: usize) -> Self {
        Self {
            buckets: HashMap::new(),
            sequence: 0,
            entries: 0,
            bytes: 0,
            max_buckets,
            max_entries,
            max_bytes,
        }
    }
    pub fn get(&self, id: &str) -> Option<&VecDeque<LogEntry>> {
        self.buckets.get(id).map(|bucket| &bucket.entries)
    }
    pub fn values(&self) -> impl Iterator<Item = &VecDeque<LogEntry>> {
        self.buckets.values().map(|bucket| &bucket.entries)
    }
    fn register(&mut self, id: &str, kind: LogKind) -> Result<(), String> {
        if id.is_empty() || id.len() > 512 {
            return Err("日志来源 ID 长度无效".into());
        }
        if self.buckets.contains_key(id) {
            return Ok(());
        }
        if self.buckets.len() >= self.max_buckets {
            let oldest = self
                .buckets
                .iter()
                .filter(|(_, bucket)| bucket.kind == LogKind::Service && !bucket.active)
                .min_by_key(|(_, bucket)| bucket.registered)
                .map(|(id, _)| id.clone());
            if let Some(oldest) = oldest {
                self.retire(&oldest);
            } else {
                return Err("日志来源数量达到上限，请等待现有任务完成".into());
            }
        }
        self.sequence += 1;
        self.buckets.insert(
            id.into(),
            LogBucket {
                kind,
                entries: VecDeque::new(),
                sequence: VecDeque::new(),
                registered: self.sequence,
                active: false,
            },
        );
        Ok(())
    }
    fn size(entry: &LogEntry) -> usize {
        std::mem::size_of::<LogEntry>() + entry.level.capacity() + entry.message.capacity()
    }
    fn pop_front(&mut self, id: &str) {
        if let Some(bucket) = self.buckets.get_mut(id) {
            if let Some(entry) = bucket.entries.pop_front() {
                bucket.sequence.pop_front();
                self.entries -= 1;
                self.bytes -= Self::size(&entry);
                if bucket.entries.capacity() > 256
                    && bucket.entries.len() < bucket.entries.capacity() / 4
                {
                    bucket.entries.shrink_to_fit();
                    bucket.sequence.shrink_to_fit();
                }
            }
        }
    }
    pub fn retire(&mut self, id: &str) {
        if let Some(bucket) = self.buckets.remove(id) {
            self.entries -= bucket.entries.len();
            self.bytes -= bucket.entries.iter().map(Self::size).sum::<usize>();
        }
    }
    fn service_active(&mut self, id: &str, active: bool) {
        if let Some(bucket) = self.buckets.get_mut(id) {
            if bucket.kind == LogKind::Service {
                bucket.active = active;
            }
        }
    }
    fn append(&mut self, id: &str, entry: LogEntry) {
        let Some(bucket) = self.buckets.get_mut(id) else {
            return;
        };
        self.sequence += 1;
        self.entries += 1;
        self.bytes += Self::size(&entry);
        bucket.entries.push_back(entry);
        bucket.sequence.push_back(self.sequence);
        while self.get(id).is_some_and(|entries| entries.len() > 2000) {
            self.pop_front(id);
        }
        while self.entries > self.max_entries || self.bytes > self.max_bytes {
            let oldest = self
                .buckets
                .iter()
                .filter_map(|(id, bucket)| {
                    bucket
                        .sequence
                        .front()
                        .map(|sequence| (id.clone(), *sequence))
                })
                .min_by_key(|(_, sequence)| *sequence)
                .map(|(id, _)| id);
            if let Some(oldest) = oldest {
                self.pop_front(&oldest);
            } else {
                break;
            }
        }
    }
}

impl std::ops::Index<&str> for LogStore {
    type Output = VecDeque<LogEntry>;
    fn index(&self, id: &str) -> &Self::Output {
        &self.buckets[id].entries
    }
}

pub fn register_service_logs(logs: &Logs, id: &str) -> Result<(), String> {
    logs.lock()
        .map_err(|error| error.to_string())?
        .register(id, LogKind::Service)
}

pub fn register_task_logs(logs: &Logs, id: &str) -> Result<(), String> {
    logs.lock()
        .map_err(|error| error.to_string())?
        .register(id, LogKind::Task)
}

/// Called with the tasks lock held; no log operation acquires that lock back.
pub fn admit_task_logs(
    tasks: &mut HashMap<String, TaskRecord>,
    logs: &Logs,
    id: &str,
) -> Result<(), String> {
    let mut entries = logs.lock().map_err(|error| error.to_string())?;
    while tasks.len() >= 100 {
        let oldest = tasks
            .values()
            .filter(|task| task.status.state != "running")
            .min_by_key(|task| task.status.started_at)
            .map(|task| task.status.id.clone())
            .ok_or("已有 100 个活动任务，请等待任务完成后再创建")?;
        tasks.remove(&oldest);
        entries.retire(&oldest);
    }
    entries.register(id, LogKind::Task)
}

pub fn abandon_unstarted_task(
    database: &Arc<Mutex<rusqlite::Connection>>,
    tasks: &mut HashMap<String, TaskRecord>,
    logs: &Logs,
    id: &str,
    error: &str,
) {
    if let Some(record) = tasks.get_mut(id) {
        record.status.state = "failed".into();
        record.status.finished_at = Some(now());
        record.status.message = error.into();
        let _ = persist_task(database, record);
    }
    tasks.remove(id);
    if let Ok(mut store) = logs.lock() {
        store.retire(id);
    }
}

#[cfg(target_os = "linux")]
pub(crate) mod linux_guardian {
    use std::{
        io,
        os::{
            fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd},
            unix::{net::UnixStream, process::CommandExt},
        },
        process::Command,
        time::{Duration, Instant},
    };

    pub(crate) struct Guardian(UnixStream);

    /// Join the current, newly created MCP wrapper group and watch the actual
    /// Strata parent's inherited pidfd. The wrapper keeps its standard streams.
    pub(crate) fn attach_parent(parent: OwnedFd) -> io::Result<Guardian> {
        if !cfg!(target_pointer_width = "64") {
            return Err(io::Error::from_raw_os_error(libc::ENOTSUP));
        }
        let parent = above_stdio(parent.into_raw_fd())?;
        let (client, server) = UnixStream::pair()?;
        let client = UnixStream::from(above_stdio(client.into_raw_fd())?);
        let server = above_stdio(server.into_raw_fd())?;
        // establish owns and closes these two raw descriptors in this process.
        // Keep the client owned here; only Command's forked child closes it.
        let error = unsafe { establish(parent.into_raw_fd(), -1, server.into_raw_fd()) };
        if error != 0 {
            return Err(io::Error::from_raw_os_error(error));
        }
        Ok(Guardian(client))
    }

    fn above_stdio(fd: RawFd) -> io::Result<OwnedFd> {
        let original = unsafe { OwnedFd::from_raw_fd(fd) };
        let duplicate = unsafe { libc::fcntl(original.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
        if duplicate < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { OwnedFd::from_raw_fd(duplicate) })
    }

    pub(super) fn prepare(command: &mut Command) -> io::Result<Guardian> {
        if !cfg!(target_pointer_width = "64") {
            return Err(io::Error::from_raw_os_error(libc::ENOTSUP));
        }
        // Open in the real parent, before spawning: the pidfd names this process,
        // not its creating thread or a PID that could be recycled after a crash.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, libc::getpid(), 0u32) } as RawFd;
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let supervisor = above_stdio(fd)?;
        let mut sockets = [-1; 2];
        if unsafe {
            libc::socketpair(
                libc::AF_UNIX,
                libc::SOCK_STREAM | libc::SOCK_CLOEXEC,
                0,
                sockets.as_mut_ptr(),
            )
        } < 0
        {
            return Err(io::Error::last_os_error());
        }
        let server = unsafe { OwnedFd::from_raw_fd(sockets[1]) };
        let client = above_stdio(sockets[0])?;
        // Both ends must survive Command's stdio remapping even when fd 0/1/2
        // were initially closed in the supervisor.
        let duplicated_server =
            unsafe { libc::fcntl(server.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
        if duplicated_server < 0 {
            return Err(io::Error::last_os_error());
        }
        let server = unsafe { OwnedFd::from_raw_fd(duplicated_server) };
        let client_fd = client.as_raw_fd();
        unsafe {
            command.pre_exec(move || {
                let result = establish(supervisor.as_raw_fd(), client_fd, server.as_raw_fd());
                if result == 0 {
                    Ok(())
                } else {
                    Err(io::Error::from_raw_os_error(result))
                }
            });
        }
        Ok(Guardian(UnixStream::from(client)))
    }

    // After fork, only fixed-size stack values and libc syscalls are used.
    // No allocator, Rust locks, logging, destructors, or libc atfork callbacks.
    unsafe fn establish(supervisor: RawFd, client: RawFd, control: RawFd) -> i32 {
        let root = libc::getpid();
        if libc::getpgrp() != root {
            return libc::EPERM;
        }
        let target = libc::syscall(libc::SYS_pidfd_open, root, 0u32) as RawFd;
        if target < 0 {
            return *libc::__errno_location();
        }
        let mut ready = [-1; 2];
        if libc::pipe2(ready.as_mut_ptr(), libc::O_CLOEXEC) < 0 {
            let error = *libc::__errno_location();
            libc::close(target);
            return error;
        }
        // Raw clone with no shared VM/FD flags is fork-like, without running
        // inherited libc atfork handlers. s390x reverses the first two arguments.
        #[cfg(not(target_arch = "s390x"))]
        let pid = libc::syscall(
            libc::SYS_clone,
            libc::SIGCHLD as libc::c_ulong,
            0usize,
            0usize,
            0usize,
            0usize,
        );
        #[cfg(target_arch = "s390x")]
        let pid = libc::syscall(
            libc::SYS_clone,
            0usize,
            libc::SIGCHLD as libc::c_ulong,
            0usize,
            0usize,
            0usize,
        );
        if pid == 0 {
            watch(supervisor, target, control, ready[1], root);
        }
        let error = if pid < 0 {
            *libc::__errno_location()
        } else {
            0
        };
        libc::close(ready[1]);
        libc::close(target);
        libc::close(supervisor);
        if client >= 0 {
            libc::close(client);
        }
        libc::close(control);
        if error != 0 {
            libc::close(ready[0]);
            return error;
        }
        let mut poll = libc::pollfd {
            fd: ready[0],
            events: libc::POLLIN,
            revents: 0,
        };
        let mut clock = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        if libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut clock) < 0 {
            let error = *libc::__errno_location();
            libc::close(ready[0]);
            return error;
        }
        let deadline = clock.tv_sec as i128 * 1000 + clock.tv_nsec as i128 / 1_000_000 + 5000;
        let mut ack = 0u8;
        let result = loop {
            if libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut clock) < 0 {
                break *libc::__errno_location();
            }
            let remaining =
                deadline - (clock.tv_sec as i128 * 1000 + clock.tv_nsec as i128 / 1_000_000);
            if remaining <= 0 {
                break libc::ETIMEDOUT;
            }
            let milliseconds = remaining.min(5000) as libc::time_t;
            let timeout = libc::timespec {
                tv_sec: milliseconds / 1000,
                tv_nsec: (milliseconds % 1000 * 1_000_000) as libc::c_long,
            };
            let ready_count = libc::syscall(
                libc::SYS_ppoll,
                &mut poll as *mut libc::pollfd,
                1usize,
                &timeout as *const libc::timespec,
                std::ptr::null::<libc::sigset_t>(),
                0usize,
            );
            if ready_count < 0 && *libc::__errno_location() == libc::EINTR {
                continue;
            }
            if ready_count <= 0 {
                break if ready_count == 0 {
                    libc::ETIMEDOUT
                } else {
                    *libc::__errno_location()
                };
            }
            let count = libc::read(ready[0], &mut ack as *mut u8 as *mut libc::c_void, 1);
            if count < 0 && *libc::__errno_location() == libc::EINTR {
                continue;
            }
            break if count == 1 && ack == 1 { 0 } else { libc::EIO };
        };
        libc::close(ready[0]);
        result
    }

    unsafe fn watch(
        supervisor: RawFd,
        target: RawFd,
        control: RawFd,
        ready: RawFd,
        group: libc::pid_t,
    ) -> ! {
        let mut blocked: libc::sigset_t = std::mem::zeroed();
        if libc::sigfillset(&mut blocked) < 0
            || libc::sigprocmask(libc::SIG_SETMASK, &blocked, std::ptr::null_mut()) < 0
        {
            libc::_exit(125);
        }
        if libc::getpgrp() != group
            || group <= 1
            || libc::dup2(supervisor, 0) < 0
            || libc::dup2(target, 1) < 0
            || libc::dup2(control, 2) < 0
            || libc::dup2(ready, 3) < 0
            || libc::syscall(libc::SYS_close_range, 4u32, u32::MAX, 0u32) < 0
        {
            libc::_exit(125);
        }
        // In particular, stdout/stderr and Command's exec-error pipe are closed
        // before ACK, so the guardian cannot delay spawn completion or log EOF.
        let ack = 1u8;
        if libc::write(3, &ack as *const u8 as *const libc::c_void, 1) != 1 {
            libc::_exit(125);
        }
        libc::close(3);
        let mut fds = [
            libc::pollfd {
                fd: 0,
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: 1,
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: 2,
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        loop {
            let result = libc::syscall(
                libc::SYS_ppoll,
                fds.as_mut_ptr(),
                fds.len(),
                std::ptr::null::<libc::timespec>(),
                std::ptr::null::<libc::sigset_t>(),
                0usize,
            );
            if result < 0 && *libc::__errno_location() == libc::EINTR {
                continue;
            }
            if result != 0 {
                // We are still a member of this group: its identity cannot be
                // reused. Only kill our own group, never a saved or searched PID.
                libc::kill(-libc::getpgrp(), libc::SIGKILL);
                libc::_exit(125);
            }
        }
    }

    impl Guardian {
        /// The peer is the pinned member of this original group. A closed peer
        /// never authorizes looking up a possibly recycled saved PGID.
        pub(super) fn alive(&self) -> io::Result<bool> {
            let mut descriptor = libc::pollfd {
                fd: self.0.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let result = unsafe { libc::poll(&mut descriptor, 1, 0) };
            if result < 0 {
                return Err(io::Error::last_os_error());
            }
            if descriptor.revents & libc::POLLNVAL != 0 {
                return Err(io::Error::from_raw_os_error(libc::EBADF));
            }
            Ok(descriptor.revents & (libc::POLLHUP | libc::POLLERR) == 0)
        }
        pub(super) fn stop(&self) -> io::Result<()> {
            let byte = 1u8;
            let sent = unsafe {
                libc::send(
                    self.0.as_raw_fd(),
                    &byte as *const u8 as *const libc::c_void,
                    1,
                    libc::MSG_NOSIGNAL | libc::MSG_DONTWAIT,
                )
            };
            if sent < 0 {
                let error = io::Error::last_os_error();
                if !matches!(error.raw_os_error(), Some(libc::EPIPE | libc::ECONNRESET)) {
                    return Err(error);
                }
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let mut fd = libc::pollfd {
                    fd: self.0.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                let result = unsafe { libc::poll(&mut fd, 1, 100) };
                if result > 0 && fd.revents & (libc::POLLHUP | libc::POLLERR) != 0 {
                    return Ok(());
                }
                if result < 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() != io::ErrorKind::Interrupted {
                        return Err(error);
                    }
                }
                if Instant::now() >= deadline {
                    return Err(io::Error::from_raw_os_error(libc::ETIMEDOUT));
                }
            }
        }
    }
}

#[cfg(windows)]
fn external_argument(value: &std::ffi::OsStr) -> Result<std::ffi::OsString, String> {
    let Some(text) = value.to_str() else {
        return Err("外部进程路径包含无法转换的 Unicode".into());
    };
    if !text.starts_with("\\\\?\\") {
        return Ok(value.to_owned());
    }
    let simplified = dunce::simplified(Path::new(value));
    if !simplified
        .as_os_str()
        .to_string_lossy()
        .starts_with("\\\\?\\")
    {
        return Ok(simplified.as_os_str().to_owned());
    }
    if let Some(network_path) = text.strip_prefix("\\\\?\\UNC\\") {
        // Validate the UNC components with the same Win32 filename and length rules as dunce.
        let check = PathBuf::from(format!("\\\\?\\C:\\{network_path}"));
        if !dunce::simplified(&check)
            .as_os_str()
            .to_string_lossy()
            .starts_with("\\\\?\\")
        {
            return Ok(format!("\\\\{network_path}").into());
        }
    }
    Err(
        "该路径不能安全转换为 Git/Python 接受的普通 Windows 路径；请选择较短且名称规范的目录"
            .into(),
    )
}
pub struct OwnedProcess {
    pub child: Child,
    pub status: ProcessStatus,
    pub profile: Option<ServiceProfile>,
    pub(crate) gpu_power_lease: Option<crate::gpu_power::GpuPowerLease>,
    // Shared by every Manager data directory for this canonical installation.
    // Keep it until the owned API/engine tree is confirmed stopped.
    pub(crate) runtime_lease: Option<strata_local_ipc::SingleInstance>,
    pub readers_pending: Arc<AtomicUsize>,
    tree_stopped: bool,
    // Only service/probe spawns pin buckets. Task Drop never acquires Logs.
    service_logs: Option<(Logs, String)>,
    #[cfg(windows)]
    job: windows_sys::Win32::Foundation::HANDLE,
    #[cfg(target_os = "linux")]
    guardian: linux_guardian::Guardian,
}
// A Job handle is only accessed while the process is held under the process mutex.
#[cfg(windows)]
unsafe impl Send for OwnedProcess {}

pub fn hidden(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
}

pub fn log(logs: &Logs, id: &str, level: &str, message: impl Into<String>) {
    if let Ok(mut all) = logs.lock() {
        let message: String = message.into().chars().take(8192).collect();
        all.append(
            id,
            LogEntry {
                timestamp: now(),
                level: level.into(),
                message,
            },
        );
    }
}

fn capture<R: Read + Send + 'static>(
    reader: R,
    logs: Logs,
    id: String,
    level: &'static str,
    pending: Arc<AtomicUsize>,
) {
    pending.fetch_add(1, Ordering::Relaxed);
    std::thread::spawn(move || {
        // Bound each read and each record even if a child emits a line without newlines.
        let mut reader = BufReader::new(reader);
        loop {
            let mut bytes = Vec::new();
            let result = (&mut reader).take(8192).read_until(b'\n', &mut bytes);
            match result {
                Ok(0) | Err(_) => break,
                Ok(_) => log(
                    &logs,
                    &id,
                    level,
                    String::from_utf8_lossy(&bytes).trim_end().to_string(),
                ),
            }
        }
        pending.fetch_sub(1, Ordering::Release);
    });
}

impl OwnedProcess {
    /// Read the whole held process tree without stopping it. A root exit alone
    /// does not establish that an MCP process or another descendant has exited.
    pub fn tree_running(&mut self) -> Result<bool, String> {
        if self.tree_stopped {
            return Ok(false);
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::JobObjects::{
                JobObjectBasicAccountingInformation, QueryInformationJobObject,
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            };
            let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION =
                unsafe { std::mem::zeroed() };
            if unsafe {
                QueryInformationJobObject(
                    self.job,
                    JobObjectBasicAccountingInformation,
                    &mut accounting as *mut _ as *mut _,
                    std::mem::size_of_val(&accounting) as u32,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return Err(format!(
                    "受管进程树状态无法核验: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(accounting.ActiveProcesses > 0)
        }
        #[cfg(target_os = "linux")]
        {
            if self.tree_stopped {
                return Ok(false);
            }
            if !self
                .guardian
                .alive()
                .map_err(|e| format!("受管进程组守护状态无法核验: {e}"))?
            {
                return Err(
                    "原进程组守护已退出，不能把保存的 PGID 当作原进程树；请完成后台清理后重试"
                        .into(),
                );
            }
            let mut system = sysinfo::System::new();
            system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
            let found = system
                .processes()
                .keys()
                .any(|pid| self.owns_pid(pid.as_u32()).unwrap_or(false));
            if !self
                .guardian
                .alive()
                .map_err(|e| format!("受管进程组守护状态无法核验: {e}"))?
            {
                return Err("读取期间原进程组守护已退出，进程树状态未知".into());
            }
            if !found {
                return Err("受管进程组成员清单无法核验".into());
            }
            Ok(true)
        }
        #[cfg(all(unix, not(target_os = "linux")))]
        {
            if !self.refresh()?.running {
                return Err("根进程已退出且此平台没有可核验的进程组守护，进程树状态未知".into());
            }
            if self.owns_pid(self.child.id())? {
                Ok(true)
            } else {
                Err("受管进程组身份已改变".into())
            }
        }
    }
    pub fn owns_pid(&self, pid: u32) -> Result<bool, String> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::{
                Foundation::CloseHandle,
                System::{
                    JobObjects::IsProcessInJob,
                    Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
                },
            };
            let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
            if handle.is_null() {
                return Err("无法核验观察器进程归属".into());
            }
            let mut member = 0;
            let result = unsafe { IsProcessInJob(handle, self.job, &mut member) };
            unsafe {
                CloseHandle(handle);
            }
            if result == 0 {
                return Err("无法核验观察器所在后台进程树".into());
            }
            Ok(member != 0)
        }
        #[cfg(unix)]
        {
            Ok(unsafe { libc::getpgid(pid as i32) } == self.child.id() as i32)
        }
    }
    pub fn spawn(command: Command, logs: Logs, id: &str) -> Result<Self, String> {
        register_service_logs(&logs, id)?;
        logs.lock()
            .map_err(|e| e.to_string())?
            .service_active(id, true);
        match Self::spawn_registered(command, logs.clone(), id) {
            Ok(mut process) => {
                process.service_logs = Some((logs, id.into()));
                Ok(process)
            }
            Err(error) => {
                if let Ok(mut store) = logs.lock() {
                    store.service_active(id, false);
                }
                Err(error)
            }
        }
    }
    pub fn spawn_registered(mut command: Command, logs: Logs, id: &str) -> Result<Self, String> {
        #[cfg(windows)]
        {
            // std canonicalize creates verbatim paths; Git and some Python tooling reject them.
            // Normalise only path-shaped arguments and retain every environment value verbatim.
            let mut normalised = Command::new(external_argument(command.get_program())?);
            for argument in command.get_args() {
                normalised.arg(external_argument(argument)?);
            }
            if let Some(directory) = command.get_current_dir() {
                normalised.current_dir(external_argument(directory.as_os_str())?);
            }
            for (key, value) in command.get_envs() {
                if let Some(value) = value {
                    normalised.env(key, value);
                } else {
                    normalised.env_remove(key);
                }
            }
            command = normalised;
        }
        hidden(&mut command);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Suspend before assigning the Job, so no fast child can escape the owned tree.
            command.creation_flags(0x08000004); // CREATE_NO_WINDOW | CREATE_SUSPENDED
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "linux")]
        let guardian = linux_guardian::prepare(&mut command).map_err(|e| {
            format!("无法建立 Linux 父死亡进程组守护（需要允许 pidfd、clone 和 close_range 的 64 位 Linux 5.9+ 内核），启动已取消: {e}")
        })?;
        let mut child = command.spawn().map_err(|e| {
            #[cfg(target_os = "linux")]
            { format!("受管进程启动失败: {e}；请核验可执行权限及允许 pidfd/clone/close_range 的 64 位 Linux 5.9+ 内核") }
            #[cfg(not(target_os = "linux"))]
            { format!("启动进程失败: {e}") }
        })?;
        #[cfg(windows)]
        let job = {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::System::JobObjects::*;
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if handle.is_null()
                    || SetInformationJobObject(
                        handle,
                        JobObjectExtendedLimitInformation,
                        &info as *const _ as *const _,
                        std::mem::size_of_val(&info) as u32,
                    ) == 0
                    || AssignProcessToJobObject(handle, child.as_raw_handle() as _) == 0
                {
                    let error = std::io::Error::last_os_error();
                    let _ = child.kill();
                    let _ = child.wait();
                    if !handle.is_null() {
                        windows_sys::Win32::Foundation::CloseHandle(handle);
                    }
                    return Err(format!("无法建立受管进程树，启动已取消: {error}"));
                }
                use windows_sys::Win32::System::{Diagnostics::ToolHelp::*, Threading::*};
                let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
                let mut thread: THREADENTRY32 = std::mem::zeroed();
                thread.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
                let mut found = false;
                if snapshot != windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
                    let mut ok = Thread32First(snapshot, &mut thread);
                    while ok != 0 {
                        if thread.th32OwnerProcessID == child.id() {
                            let thread_handle =
                                OpenThread(THREAD_SUSPEND_RESUME, 0, thread.th32ThreadID);
                            if !thread_handle.is_null() {
                                found = ResumeThread(thread_handle) != u32::MAX;
                                windows_sys::Win32::Foundation::CloseHandle(thread_handle);
                            }
                            break;
                        }
                        ok = Thread32Next(snapshot, &mut thread);
                    }
                    windows_sys::Win32::Foundation::CloseHandle(snapshot);
                }
                if !found {
                    let error = std::io::Error::last_os_error();
                    TerminateJobObject(handle, 1);
                    let _ = child.kill();
                    let _ = child.wait();
                    windows_sys::Win32::Foundation::CloseHandle(handle);
                    return Err(format!("受管进程恢复执行失败，启动已取消: {error}"));
                }
                handle
            }
        };
        let readers_pending = Arc::new(AtomicUsize::new(0));
        if let Some(out) = child.stdout.take() {
            capture(
                out,
                logs.clone(),
                id.into(),
                "stdout",
                readers_pending.clone(),
            );
        }
        if let Some(err) = child.stderr.take() {
            capture(err, logs, id.into(), "stderr", readers_pending.clone());
        }
        let status = ProcessStatus {
            running: true,
            owned: true,
            pid: Some(child.id()),
            started_at: Some(now()),
            exit_code: None,
            ..ProcessStatus::default()
        };
        Ok(Self {
            child,
            status,
            profile: None,
            gpu_power_lease: None,
            runtime_lease: None,
            readers_pending,
            tree_stopped: false,
            service_logs: None,
            #[cfg(windows)]
            job,
            #[cfg(target_os = "linux")]
            guardian,
        })
    }
    pub fn refresh(&mut self) -> Result<ProcessStatus, String> {
        if let Some(exit) = self.child.try_wait().map_err(|e| e.to_string())? {
            self.status.running = false;
            self.status.exit_code = exit.code();
            self.release_log_pin();
            // A crashed root may leave owned descendants alive. End that tree
            // before releasing the board-wide power limit.
            if (self.gpu_power_lease.is_some() || self.runtime_lease.is_some())
                && !self.tree_stopped
            {
                let lease = self.gpu_power_lease.take();
                let stopped = self.stop();
                self.gpu_power_lease = lease;
                stopped?;
            }
            self.restore_gpu_power()?;
        }
        Ok(self.status.clone())
    }
    fn restore_gpu_power(&mut self) -> Result<(), String> {
        if let Some(lease) = &mut self.gpu_power_lease {
            if let Err(error) = lease.restore() {
                // A different tool changed the setting; the lease relinquished
                // ownership and preserved that value. Stopping still succeeded.
                let retained_external_setting = !lease.is_active();
                if let Some((logs, id)) = &self.service_logs {
                    log(
                        logs,
                        id,
                        if retained_external_setting {
                            "warn"
                        } else {
                            "error"
                        },
                        &error,
                    );
                }
                if retained_external_setting {
                    self.gpu_power_lease = None;
                    return Ok(());
                }
                return Err(error);
            }
            self.gpu_power_lease = None;
        }
        Ok(())
    }

    #[cfg(unix)]
    fn confirm_runtime_tree_stopped(&mut self) -> Result<(), String> {
        // Termination uses the held guardian/owned group above. This census is
        // read-only, so a recycled PGID can only delay releasing the lease;
        // it never authorizes sending another signal to a searched process.
        let group = self.child.id() as i32;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let mut system = sysinfo::System::new();
            system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
            if system
                .process(sysinfo::Pid::from_u32(std::process::id()))
                .is_none()
            {
                return Err("无法核验受管进程组成员，运行环境托管锁继续保留".into());
            }
            let live = system.processes().iter().any(|(pid, process)| {
                process.status() != sysinfo::ProcessStatus::Zombie
                    && unsafe { libc::getpgid(pid.as_u32() as i32) } == group
            });
            if !live {
                self.tree_stopped = true;
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                return Err("受管进程组仍在结束，运行环境托管锁继续保留".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn stop(&mut self) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        let pinned_tree = self.guardian.alive().unwrap_or(false);
        // Handles, not a PID search or port search: never terminate an external service.
        #[cfg(windows)]
        unsafe {
            if windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1) == 0 {
                return Err(format!(
                    "停止受管进程树失败: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
        #[cfg(all(unix, not(target_os = "linux")))]
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        #[cfg(not(target_os = "linux"))]
        let _ = self.child.kill();
        #[cfg(not(target_os = "linux"))]
        let result = self.child.wait().map_err(|e| e.to_string())?;
        #[cfg(target_os = "linux")]
        let result = {
            // The guardian is the still-pinned group member. Never signal an
            // old PGID after try_wait may have reaped the root process.
            self.guardian
                .stop()
                .map_err(|e| format!("停止受管 Linux 进程组失败: {e}"))?;
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                if let Some(exit) = self.child.try_wait().map_err(|e| e.to_string())? {
                    break exit;
                }
                if std::time::Instant::now() >= deadline {
                    return Err("Linux 守护已关闭但根进程仍未退出，无法确认整个受管组已停止".into());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        self.status.running = false;
        self.status.exit_code = result.code();
        #[cfg(windows)]
        {
            // TerminateJobObject requests termination of every member, but
            // waiting for the root does not wait for its descendants. Keep the
            // held Job as authority until its final member exits, before any
            // caller probes/reuses a listener owned by that tree.
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while self.tree_running()? {
                if std::time::Instant::now() >= deadline {
                    return Err(
                        "受管根进程已退出，但进程树仍在结束；未启动替代服务，请稍后重试恢复".into(),
                    );
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            self.tree_stopped = true;
        }
        #[cfg(target_os = "linux")]
        {
            self.tree_stopped = pinned_tree;
        }
        #[cfg(unix)]
        if self.runtime_lease.is_some() {
            self.confirm_runtime_tree_stopped()?;
        }
        self.release_log_pin();
        self.restore_gpu_power()?;
        if self.tree_stopped {
            self.runtime_lease = None;
        }
        Ok(())
    }
    fn release_log_pin(&self) {
        if let Some((logs, id)) = &self.service_logs {
            if let Ok(mut store) = logs.lock() {
                store.service_active(id, false);
            }
        }
    }
}
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        if (self.gpu_power_lease.is_some() || self.runtime_lease.is_some()) && !self.tree_stopped {
            let _ = self.stop();
        }
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
        }
        #[cfg(unix)]
        {
            if self.status.running {
                let _ = self.stop();
            }
        }
        let _ = self.restore_gpu_power();
        if !self.tree_stopped {
            if let Some(lease) = self.runtime_lease.take() {
                // Cleanup failure must not authorize a second model while an
                // unconfirmed descendant may remain. The kernel releases this
                // retained handle/file when the owning supervisor exits.
                std::mem::forget(lease);
                if let Some((logs, id)) = &self.service_logs {
                    log(
                        logs,
                        id,
                        "error",
                        "受管进程树未确认结束，运行环境托管锁保留至后台退出",
                    );
                }
            }
        }
        self.release_log_pin();
    }
}

pub fn stop_owned_for_restart(
    processes: &Mutex<HashMap<String, OwnedProcess>>,
    profile_id: &str,
) -> Result<(), String> {
    let mut processes = processes.lock().map_err(|e| e.to_string())?;
    let process = processes
        .get_mut(profile_id)
        .ok_or("该服务不属于本应用；外部实例需显式接管")?;
    if !process.refresh()?.running {
        return Err("受管服务未运行，请使用启动服务".into());
    }
    process.stop()
}

pub struct TaskRecord {
    pub status: TaskStatus,
    pub profile_id: Option<String>,
    pub runtime_path: Option<PathBuf>,
    pub cancelled: bool,
    pub process: Option<OwnedProcess>,
}
pub type Tasks = Arc<Mutex<HashMap<String, TaskRecord>>>;

fn init_task_storage(connection: &rusqlite::Connection) -> Result<(), String> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS task_runtime(id TEXT PRIMARY KEY,path TEXT); CREATE TABLE IF NOT EXISTS task_logs(id TEXT PRIMARY KEY,entries TEXT NOT NULL); CREATE TABLE IF NOT EXISTS install_claims(path TEXT PRIMARY KEY,token TEXT NOT NULL);").map_err(|e|e.to_string())
}

pub(crate) fn redact_log(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if [
        "api_key",
        "api-key",
        "apikey",
        "authorization",
        "bearer ",
        "password",
        "secret",
        "cookie",
        "access_token",
        "token=",
        "token:",
        "\"token\"",
        "--token",
        "credential",
        "hf_",
        "ghp_",
        "github_pat_",
        "sk-",
    ]
    .iter()
    .any(|key| lower.contains(key))
    {
        return "[redacted sensitive log]".into();
    }
    message
        .split_whitespace()
        .map(|word| {
            if let Ok(mut url) = url::Url::parse(word) {
                if matches!(url.scheme(), "http" | "https") {
                    let _ = url.set_username("");
                    let _ = url.set_password(None);
                    url.set_query(None);
                    url.set_fragment(None);
                    return url.to_string();
                }
            }
            word.to_owned()
        })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(4096)
        .collect()
}

pub fn persist_task_logs(
    database: &Arc<Mutex<rusqlite::Connection>>,
    logs: &Logs,
    id: &str,
) -> Result<(), String> {
    let entries: Vec<_> = logs
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .map(|entries| {
            entries
                .iter()
                .skip(entries.len().saturating_sub(500))
                .map(|entry| LogEntry {
                    timestamp: entry.timestamp,
                    level: entry.level.clone(),
                    message: redact_log(&entry.message),
                })
                .collect()
        })
        .unwrap_or_default();
    let json = serde_json::to_string(&entries).map_err(|e| e.to_string())?;
    let connection = database.lock().map_err(|e| e.to_string())?;
    init_task_storage(&connection)?;
    connection
        .execute(
            "INSERT OR REPLACE INTO task_logs(id,entries) VALUES(?1,?2)",
            rusqlite::params![id, json],
        )
        .map_err(|e| e.to_string())?;
    connection.execute("DELETE FROM task_logs WHERE id NOT IN (SELECT id FROM tasks ORDER BY rowid DESC LIMIT 100)", []).map_err(|e|e.to_string())?;
    Ok(())
}

pub fn saved_task_logs(
    database: &Arc<Mutex<rusqlite::Connection>>,
    id: &str,
) -> Result<Vec<LogEntry>, String> {
    use rusqlite::OptionalExtension;
    let connection = database.lock().map_err(|e| e.to_string())?;
    init_task_storage(&connection)?;
    let json: Option<String> = connection
        .query_row("SELECT entries FROM task_logs WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    json.map(|json| serde_json::from_str(&json).map_err(|e| e.to_string()))
        .unwrap_or_else(|| Ok(vec![]))
}

const INSTALL_MARKER: &str = ".strata-manager-install.json";
#[derive(serde::Serialize, serde::Deserialize)]
struct InstallClaim {
    destination: PathBuf,
    token: String,
}

fn check_install_claim(
    database: &Arc<Mutex<rusqlite::Connection>>,
    claim: &InstallClaim,
) -> Result<(), String> {
    use rusqlite::OptionalExtension;
    let root = &claim.destination;
    if root.is_symlink() || dunce::canonicalize(root).map_err(|e| e.to_string())? != *root {
        return Err("安装目录已被替换或重定向，拒绝修改".into());
    }
    let marker = root.join(INSTALL_MARKER);
    if marker.is_symlink() || std::fs::metadata(&marker).map_err(|e| e.to_string())?.len() > 2048 {
        return Err("安装归属标记无效".into());
    }
    let saved: InstallClaim =
        serde_json::from_slice(&std::fs::read(marker).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let connection = database.lock().map_err(|e| e.to_string())?;
    init_task_storage(&connection)?;
    let token: Option<String> = connection
        .query_row(
            "SELECT token FROM install_claims WHERE path=?1",
            [root.to_string_lossy().as_ref()],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if saved.token != claim.token
        || saved.destination != *root
        || token.as_deref() != Some(&claim.token)
    {
        return Err("安装目录归属不匹配，拒绝修改非本应用目录".into());
    }
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name() != INSTALL_MARKER && entry.file_name() != "repository" {
            return Err("安装保留目录出现未知文件，拒绝覆盖；请选择新目录".into());
        }
        if entry.path().is_symlink() {
            return Err("安装保留目录包含符号链接，拒绝修改".into());
        }
    }
    Ok(())
}

fn prepare_install(
    database: &Arc<Mutex<rusqlite::Connection>>,
    directory: &Path,
) -> Result<InstallClaim, String> {
    use std::io::Write;
    if !directory.is_absolute() || directory.parent().is_none() || directory.file_name().is_none() {
        return Err("安装目录必须为非根绝对路径".into());
    }
    let parent = directory.parent().ok_or("安装父目录为空")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let destination = dunce::canonicalize(parent)
        .map_err(|e| e.to_string())?
        .join(directory.file_name().ok_or("安装目录名为空")?);
    if destination.is_symlink() {
        return Err("安装目录不能是符号链接".into());
    }
    if destination.exists()
        && (!destination.is_dir()
            || std::fs::read_dir(&destination)
                .map_err(|e| e.to_string())?
                .next()
                .is_some())
    {
        let marker = destination.join(INSTALL_MARKER);
        if !marker.is_file() || std::fs::metadata(&marker).map_err(|e| e.to_string())?.len() > 2048
        {
            return Err("安装目录非空且没有本应用归属标记，拒绝覆盖；请选择新目录".into());
        }
        let claim: InstallClaim =
            serde_json::from_slice(&std::fs::read(marker).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if claim.destination != destination {
            return Err("安装目录归属路径不匹配".into());
        }
        check_install_claim(database, &claim)?;
        let partial = destination.join("repository");
        if partial.exists() {
            // Preserve everything from the previous attempt, including user edits; never recursively delete.
            let retained = destination
                .parent()
                .ok_or("安装父目录为空")?
                .join(format!(".strata-incomplete-{}", Uuid::new_v4()));
            std::fs::rename(&partial, &retained).map_err(|e| format!("保留安装半成品失败: {e}"))?;
        }
        return Ok(claim);
    }
    if !destination.exists() {
        std::fs::create_dir(&destination).map_err(|e| e.to_string())?;
    }
    let destination = dunce::canonicalize(destination).map_err(|e| e.to_string())?;
    let claim = InstallClaim {
        destination,
        token: Uuid::new_v4().to_string(),
    };
    let mut marker = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(claim.destination.join(INSTALL_MARKER))
        .map_err(|e| e.to_string())?;
    marker
        .write_all(&serde_json::to_vec(&claim).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    marker.sync_all().map_err(|e| e.to_string())?;
    let connection = database.lock().map_err(|e| e.to_string())?;
    init_task_storage(&connection)?;
    connection
        .execute(
            "INSERT OR REPLACE INTO install_claims(path,token) VALUES(?1,?2)",
            rusqlite::params![claim.destination.to_string_lossy(), claim.token],
        )
        .map_err(|e| e.to_string())?;
    Ok(claim)
}

fn publish_install(
    database: &Arc<Mutex<rusqlite::Connection>>,
    claim: &InstallClaim,
) -> Result<(), String> {
    check_install_claim(database, claim)?;
    let repository = claim.destination.join("repository");
    if !repository.join("setup.py").is_file()
        || !repository.join("serve/server.py").is_file()
        || !repository.join(".git").is_dir()
    {
        return Err("Git 命令结束但官方运行环境文件缺失，未发布安装目录".into());
    }
    let retained = claim
        .destination
        .parent()
        .ok_or("安装父目录为空")?
        .join(format!(".strata-install-reservation-{}", claim.token));
    if retained.exists() {
        return Err("安装归属备份目录已存在，拒绝覆盖".into());
    }
    std::fs::rename(&claim.destination, &retained).map_err(|e| e.to_string())?;
    if let Err(error) = std::fs::rename(retained.join("repository"), &claim.destination) {
        if !claim.destination.exists() {
            let _ = std::fs::rename(&retained, &claim.destination);
        }
        return Err(format!("安装发布失败，半成品仍保留: {error}"));
    }
    Ok(())
}

pub fn launch_install(
    tasks: Tasks,
    logs: Logs,
    database: Arc<Mutex<rusqlite::Connection>>,
    directory: &Path,
) -> Result<TaskStatus, String> {
    // Check before moving any previous attempt; launch_task repeats the check before spawning.
    let parent = directory.parent().ok_or("安装父目录为空")?;
    if parent.exists() {
        let destination = dunce::canonicalize(parent)
            .map_err(|e| e.to_string())?
            .join(directory.file_name().ok_or("安装目录名为空")?);
        let destination = dunce::canonicalize(&destination).unwrap_or(destination);
        if tasks
            .lock()
            .map_err(|e| e.to_string())?
            .values()
            .any(|task| {
                task.status.state == "running" && task.runtime_path.as_ref() == Some(&destination)
            })
        {
            return Err("该运行环境已有任务进行中，请等待或取消".into());
        }
    }
    let claim = prepare_install(&database, directory)?;
    let step = Step {
        program: "git".into(),
        args: vec![
            "clone".into(),
            "--depth".into(),
            "1".into(),
            "https://github.com/Niko1221/Strata.git".into(),
            claim
                .destination
                .join("repository")
                .to_string_lossy()
                .into(),
        ],
        cwd: claim.destination.clone(),
        env: Default::default(),
    };
    launch_task_with_install(
        tasks,
        logs,
        database,
        "install",
        Some(format!("install:{}", claim.destination.display())),
        vec![step],
        Some(claim.destination.clone()),
        Some(claim),
    )
}

pub struct Step {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// Overrides/removals apply to this child only; never alter the supervisor environment.
    pub env: BTreeMap<String, Option<String>>,
}

pub fn launch_task(
    tasks: Tasks,
    logs: Logs,
    database: Arc<Mutex<rusqlite::Connection>>,
    kind: &str,
    profile_id: Option<String>,
    steps: Vec<Step>,
) -> Result<TaskStatus, String> {
    let runtime_path = steps
        .first()
        .and_then(|step| dunce::canonicalize(&step.cwd).ok());
    launch_task_with_install(
        tasks,
        logs,
        database,
        kind,
        profile_id,
        steps,
        runtime_path,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn launch_task_with_install(
    tasks: Tasks,
    logs: Logs,
    database: Arc<Mutex<rusqlite::Connection>>,
    kind: &str,
    profile_id: Option<String>,
    steps: Vec<Step>,
    runtime_path: Option<PathBuf>,
    install: Option<InstallClaim>,
) -> Result<TaskStatus, String> {
    launch_task_with_handoff(
        tasks,
        logs,
        database,
        kind,
        profile_id,
        steps,
        runtime_path,
        install,
        None,
    )
}

pub fn launch_setup_task(
    state: Arc<crate::RuntimeState>,
    intent: crate::setup_handoff::SetupIntent,
    steps: Vec<Step>,
) -> Result<TaskStatus, String> {
    let runtime_path = Some(runtime_dir(&intent.profile)?);
    launch_task_with_handoff(
        state.tasks.clone(),
        state.logs.clone(),
        state.database.clone(),
        "setup",
        Some(intent.profile.id.clone()),
        steps,
        runtime_path,
        None,
        Some(crate::setup_handoff::SetupHook { state, intent }),
    )
}

#[allow(clippy::too_many_arguments)]
fn launch_task_with_handoff(
    tasks: Tasks,
    logs: Logs,
    database: Arc<Mutex<rusqlite::Connection>>,
    kind: &str,
    profile_id: Option<String>,
    steps: Vec<Step>,
    runtime_path: Option<PathBuf>,
    install: Option<InstallClaim>,
    setup: Option<crate::setup_handoff::SetupHook>,
) -> Result<TaskStatus, String> {
    let id = Uuid::new_v4().to_string();
    let status = TaskStatus {
        id: id.clone(),
        kind: kind.into(),
        state: "running".into(),
        message: "任务已启动；查看日志了解真实进度".into(),
        started_at: now(),
        finished_at: None,
    };
    {
        let mut records = tasks.lock().map_err(|e| e.to_string())?;
        if records.values().any(|r| {
            r.status.state == "running"
                && ((profile_id.is_some() && r.profile_id == profile_id)
                    || (runtime_path.is_some() && r.runtime_path == runtime_path))
        }) {
            return Err("该运行环境已有安装或更新任务，请等待或取消该任务".into());
        }
        admit_task_logs(&mut records, &logs, &id)?;
        records.insert(
            id.clone(),
            TaskRecord {
                status: status.clone(),
                profile_id: profile_id.clone(),
                runtime_path,
                cancelled: false,
                process: None,
            },
        );
        let record = records.get(&id).ok_or("任务不存在")?;
        let persisted = if let Some(hook) = &setup {
            crate::setup_handoff::persist_launch(hook, record)
        } else {
            persist_task(&database, record)
        };
        if let Err(error) = persisted {
            records.remove(&id);
            if let Ok(mut entries) = logs.lock() {
                entries.retire(&id);
            }
            return Err(error);
        }
    }
    std::thread::spawn(move || {
        let log_id = id.clone();
        let mut last_save = std::time::Instant::now();
        let outcome = (|| -> Result<(), String> {
            for step in steps {
                log(
                    &logs,
                    &log_id,
                    "info",
                    format!("{} {:?}", step.program, step.args),
                );
                let mut cmd = Command::new(&step.program);
                cmd.args(&step.args)
                    .current_dir(step.cwd)
                    .env("PYTHONUNBUFFERED", "1");
                for (key, value) in step.env {
                    if let Some(value) = value {
                        cmd.env(key, value);
                    } else {
                        cmd.env_remove(key);
                    }
                }
                let mut records = tasks.lock().map_err(|e| e.to_string())?;
                let record = records.get_mut(&id).ok_or("任务不存在")?;
                if record.cancelled {
                    return Err("任务已取消".into());
                }
                record.process = Some(OwnedProcess::spawn_registered(cmd, logs.clone(), &log_id)?);
                drop(records);
                loop {
                    std::thread::sleep(Duration::from_millis(120));
                    let mut records = tasks.lock().map_err(|e| e.to_string())?;
                    let record = records.get_mut(&id).ok_or("任务不存在")?;
                    if record.cancelled {
                        return Err("任务已取消；已下载文件保留以供续传".into());
                    }
                    let process = record.process.as_mut().ok_or("任务进程不存在")?;
                    let status = process.refresh()?;
                    if let Ok(all) = logs.lock() {
                        if let Some(last) = all.get(&log_id).and_then(|entries| entries.back()) {
                            record.status.message = last.message.chars().take(500).collect();
                        }
                    }
                    if !status.running {
                        let deadline = std::time::Instant::now() + Duration::from_millis(500);
                        while process.readers_pending.load(Ordering::Acquire) > 0
                            && std::time::Instant::now() < deadline
                        {
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        record.process.take();
                        if status.exit_code == Some(0) {
                            break;
                        }
                        return Err(format!("命令退出码 {:?}；请查看任务日志", status.exit_code));
                    }
                    if last_save.elapsed() >= Duration::from_secs(1) {
                        persist_task_logs(&database, &logs, &id)?;
                        last_save = std::time::Instant::now();
                    }
                }
            }
            if let Some(install) = install {
                let mut records = tasks.lock().map_err(|e| e.to_string())?;
                if records.get_mut(&id).ok_or("任务不存在")?.cancelled {
                    return Err("任务已取消；安装半成品保留".into());
                }
                publish_install(&database, &install)?;
            }
            if let Some(hook) = &setup {
                crate::setup_handoff::commands_completed(hook, &id)?;
            }
            Ok(())
        })();
        if let Ok(mut records) = tasks.lock() {
            if let Some(record) = records.get_mut(&id) {
                record.status.state = if record.cancelled {
                    "cancelled"
                } else if outcome.is_ok() {
                    "completed"
                } else {
                    "failed"
                }
                .into();
                record.status.message = outcome.err().unwrap_or_else(|| {
                    if setup.is_some() {
                        record.status.message.clone()
                    } else {
                        "所有命令已成功结束".into()
                    }
                });
                record.status.finished_at = Some(now());
                if let Some(process) = record.process.as_ref() {
                    let deadline = std::time::Instant::now() + Duration::from_millis(500);
                    while process.readers_pending.load(Ordering::Acquire) > 0
                        && std::time::Instant::now() < deadline
                    {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
                record.process.take();
                log(&logs, &log_id, &record.status.state, &record.status.message);
                if let Err(error) = persist_task(&database, record) {
                    log(&logs, &log_id, "error", error);
                }
                if let Some(hook) = &setup {
                    if let Err(error) = crate::setup_handoff::terminated(hook, &record.status) {
                        log(&logs, &log_id, "error", error);
                    }
                }
                if let Err(error) = persist_task_logs(&database, &logs, &id) {
                    log(&logs, &log_id, "error", error);
                }
            }
        }
    });
    Ok(status)
}

pub fn persist_task(
    database: &Arc<Mutex<rusqlite::Connection>>,
    record: &TaskRecord,
) -> Result<(), String> {
    let connection = database.lock().map_err(|e| e.to_string())?;
    persist_task_connection(&connection, record)
}

pub(crate) fn persist_task_connection(
    connection: &rusqlite::Connection,
    record: &TaskRecord,
) -> Result<(), String> {
    let mut status = record.status.clone();
    status.message = redact_log(&status.message);
    let status = serde_json::to_string(&status).map_err(|e| e.to_string())?;
    init_task_storage(connection)?;
    connection.execute("INSERT INTO tasks(id,status,profile_id) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET status=excluded.status,profile_id=excluded.profile_id", rusqlite::params![record.status.id,status,record.profile_id]).map_err(|e| e.to_string())?;
    connection
        .execute(
            "INSERT OR REPLACE INTO task_runtime(id,path) VALUES(?1,?2)",
            rusqlite::params![
                record.status.id,
                record
                    .runtime_path
                    .as_ref()
                    .map(|p| p.to_string_lossy().into_owned())
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn restore_tasks(
    database: &Arc<Mutex<rusqlite::Connection>>,
) -> Result<HashMap<String, TaskRecord>, String> {
    let connection = database.lock().map_err(|e| e.to_string())?;
    init_task_storage(&connection)?;
    let mut query = connection
        .prepare("SELECT tasks.status,tasks.profile_id,task_runtime.path FROM tasks LEFT JOIN task_runtime ON task_runtime.id=tasks.id ORDER BY tasks.rowid DESC LIMIT 100")
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut records = HashMap::new();
    for row in rows {
        let (json, profile_id, runtime_path) = row.map_err(|e| e.to_string())?;
        let mut status: TaskStatus = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        if status.state == "running" {
            status.state = "failed".into();
            status.message = "上次运行被应用退出/中断；下载文件保留，可重新运行以续传".into();
            status.finished_at = Some(now());
        }
        records.insert(
            status.id.clone(),
            TaskRecord {
                status,
                profile_id,
                runtime_path: runtime_path.map(PathBuf::from),
                cancelled: false,
                process: None,
            },
        );
    }
    drop(query);
    drop(connection);
    for record in records.values() {
        persist_task(database, record)?;
    }
    Ok(records)
}

pub fn setup_python(profile: &ServiceProfile, root: &Path) -> Result<(String, Vec<Step>), String> {
    let env_dir = root.join(".venv");
    let interpreter = if cfg!(windows) {
        env_dir.join("Scripts/python.exe")
    } else {
        env_dir.join("bin/python")
    };
    if interpreter.is_file() {
        return Ok((interpreter.to_string_lossy().into(), vec![]));
    }
    if env_dir.exists() {
        return Err(".venv 存在但Python解释器缺失；请检查该环境，管理器不会删除已有目录".into());
    }
    let step = Step {
        program: python(profile)?,
        args: vec!["-m".into(), "venv".into(), env_dir.to_string_lossy().into()],
        cwd: root.to_owned(),
        env: Default::default(),
    };
    Ok((interpreter.to_string_lossy().into(), vec![step]))
}

pub fn runtime_dir(profile: &ServiceProfile) -> Result<PathBuf, String> {
    if !profile.managed {
        return Err("仅连接的外部服务不支持本地管理".into());
    }
    let path = Path::new(&profile.install_dir);
    if !path.is_absolute() {
        return Err("运行环境目录必须为绝对路径".into());
    }
    let path = dunce::canonicalize(path).map_err(|e| format!("运行环境目录不存在: {e}"))?;
    if !path.join("setup.py").is_file() || !path.join("serve/server.py").is_file() {
        return Err("不是可识别的 Strata 安装目录（需要 setup.py 和 serve/server.py）".into());
    }
    Ok(path)
}

pub(crate) fn acquire_runtime_lease(
    root: &Path,
) -> Result<strata_local_ipc::SingleInstance, String> {
    let canonical = dunce::canonicalize(root).map_err(|error| {
        crate::diagnostics::io_error(&error, "无法核验运行环境托管目录", "prepare")
    })?;
    strata_local_ipc::SingleInstance::acquire_scoped(&canonical, "managed-model-runtime").map_err(
        |error| {
            if error.code == "already_running" {
                crate::diagnostics::error(
                    "STARTUP_RUNTIME_ALREADY_MANAGED",
                    "该 Strata 运行环境已由另一后台托管，请连接已有后台；未停止现有服务",
                    "prepare",
                )
            } else {
                crate::diagnostics::error(
                    "STARTUP_RUNTIME_LOCK_UNAVAILABLE",
                    format!("无法取得运行环境托管锁：{error}"),
                    "prepare",
                )
            }
        },
    )
}

pub fn python(profile: &ServiceProfile) -> Result<String, String> {
    if !profile.python_path.trim().is_empty() {
        return Ok(profile.python_path.clone());
    }
    let root = Path::new(&profile.install_dir);
    for path in [
        root.join(".venv/Scripts/python.exe"),
        root.join("venv/Scripts/python.exe"),
        root.join(".venv/bin/python"),
        root.join("venv/bin/python"),
    ] {
        if path.is_file() {
            return Ok(path.to_string_lossy().into());
        }
    }
    Ok("python".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tree_running_reads_the_held_tree_after_root_exit_without_stopping_descendants() {
        let mut locate = Command::new(if cfg!(windows) { "py" } else { "python3" });
        locate.args(["-I", "-S", "-c", "import sys;print(sys.executable)"]);
        hidden(&mut locate);
        let output = locate.output().expect("CPU tree fixture requires Python");
        assert!(output.status.success());
        let python = String::from_utf8(output.stdout).unwrap().trim().to_owned();
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("child.pid");
        let script="import subprocess,sys;from pathlib import Path;child=subprocess.Popen([sys.executable,'-I','-S','-c','import time;time.sleep(15)']);Path(sys.argv[1]).write_text(str(child.pid))";
        let mut command = Command::new(python);
        command.args(["-I", "-S", "-c", script]).arg(&marker);
        let mut process =
            OwnedProcess::spawn(command, Default::default(), "tree-read-fixture").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !marker.exists() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(process.child.wait().unwrap().success());
        assert!(!process.refresh().unwrap().running);
        #[cfg(windows)]
        {
            let pid = std::fs::read_to_string(&marker)
                .unwrap()
                .parse::<u32>()
                .unwrap();
            assert!(process.owns_pid(pid).unwrap());
            assert!(
                process.tree_running().unwrap(),
                "the root exit must not hide a live Job descendant"
            );
            assert!(
                process.owns_pid(pid).unwrap(),
                "read-only accounting must not terminate the descendant"
            );
        }
        #[cfg(unix)]
        {
            assert!(
                !matches!(process.tree_running(), Ok(false)),
                "an unpinned/reaped root PGID must not establish that its original tree is absent"
            );
        }
        process.stop().unwrap();
        #[cfg(windows)]
        {
            assert!(
                !process.tree_running().unwrap(),
                "stop must wait for the final Job member rather than only its root"
            );
        }
        #[cfg(target_os = "linux")]
        assert!(!matches!(process.tree_running(), Ok(true)));
    }
    #[cfg(target_os = "linux")]
    const LINUX_TREE: &str = r#"
import pathlib, subprocess, sys, time
engine = "import socket,sys; s=socket.socket(); s.bind(('127.0.0.1',int(sys.argv[1]))); s.listen(); exec('while True:\\n c,_=s.accept(); c.close()')"
child = subprocess.Popen([sys.executable, '-c', engine, sys.argv[1]])
print(child.pid, flush=True)
while not pathlib.Path(sys.argv[2]).exists(): time.sleep(.01)
sys.exit(7)
"#;
    #[cfg(target_os = "linux")]
    fn linux_fixture_tree(logs: Logs, directory: &Path) -> (OwnedProcess, u16, u32) {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let mut command = Command::new("python3");
        command.args(["-u", "-c", LINUX_TREE, &port.to_string()]);
        command.arg(directory.join("exit-root"));
        let owned = OwnedProcess::spawn(command, logs.clone(), "linux-owned-tree").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        let pid = loop {
            let pid = logs
                .lock()
                .unwrap()
                .get("linux-owned-tree")
                .and_then(|entries| {
                    entries
                        .iter()
                        .find_map(|entry| entry.message.parse::<u32>().ok())
                });
            if let Some(pid) = pid {
                if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                    break pid;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "isolated grandchild listener was not ready"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(owned.owns_pid(pid).unwrap());
        (owned, port, pid)
    }
    #[cfg(target_os = "linux")]
    fn linux_watch_pid(pid: u32) -> std::os::fd::OwnedFd {
        use std::os::fd::FromRawFd;
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0u32) };
        assert!(
            fd >= 0,
            "fixture pidfd: {}",
            std::io::Error::last_os_error()
        );
        unsafe { std::os::fd::OwnedFd::from_raw_fd(fd as i32) }
    }
    #[cfg(target_os = "linux")]
    fn linux_wait_dead(fd: &std::os::fd::OwnedFd) {
        use std::os::fd::AsRawFd;
        let mut poll = libc::pollfd {
            fd: fd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        assert_eq!(
            unsafe { libc::poll(&mut poll, 1, 5000) },
            1,
            "owned process did not exit"
        );
        assert_ne!(poll.revents & (libc::POLLIN | libc::POLLHUP), 0);
    }
    #[cfg(target_os = "linux")]
    fn linux_wait_port_closed(port: u16) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            assert!(
                std::time::Instant::now() < deadline,
                "owned grandchild listener survived"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_hard_killed_owner_stops_owned_grandchild_and_keeps_external_process() {
        const ACTOR: &str = "STRATA_MANAGER_LINUX_GUARDIAN_ACTOR";
        if let Some(directory) = std::env::var_os(ACTOR) {
            let logs = Default::default();
            let (owned, port, pid) = linux_fixture_tree(logs, Path::new(&directory));
            std::fs::write(
                Path::new(&directory).join("report.json.tmp"),
                serde_json::to_vec(
                    &serde_json::json!({"port":port,"root":owned.child.id(),"child":pid}),
                )
                .unwrap(),
            )
            .unwrap();
            std::fs::rename(
                Path::new(&directory).join("report.json.tmp"),
                Path::new(&directory).join("report.json"),
            )
            .unwrap();
            std::thread::sleep(Duration::from_secs(120));
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let mut external = Command::new("sleep").arg("120").spawn().unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", "processes::tests::linux_hard_killed_owner_stops_owned_grandchild_and_keeps_external_process", "--nocapture"]).env(ACTOR, temp.path());
        let mut actor =
            OwnedProcess::spawn(command, Default::default(), "linux-owner-actor").unwrap();
        let report = temp.path().join("report.json");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !report.exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "owner actor did not become ready"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let report: serde_json::Value =
            serde_json::from_slice(&std::fs::read(report).unwrap()).unwrap();
        let root = linux_watch_pid(report["root"].as_u64().unwrap() as u32);
        let child = linux_watch_pid(report["child"].as_u64().unwrap() as u32);
        actor.child.kill().unwrap(); // SIGKILL bypasses Rust Drop in the owner.
        actor.child.wait().unwrap();
        linux_wait_dead(&root);
        linux_wait_dead(&child);
        linux_wait_port_closed(report["port"].as_u64().unwrap() as u16);
        actor.stop().unwrap(); // Safe even after the owner root PID was reaped.
        assert!(external.try_wait().unwrap().is_none());
        external.kill().unwrap();
        external.wait().unwrap();
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_root_exit_stops_engine_and_closes_capture_without_old_pgid_signal() {
        let temp = tempfile::tempdir().unwrap();
        let mut external = Command::new("sleep").arg("120").spawn().unwrap();
        let logs = Default::default();
        let (mut owned, port, pid) = linux_fixture_tree(logs, temp.path());
        let child = linux_watch_pid(pid);
        std::fs::write(temp.path().join("exit-root"), b"exit now").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while owned.refresh().unwrap().running {
            assert!(
                std::time::Instant::now() < deadline,
                "root process did not exit"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(owned.status.exit_code, Some(7));
        linux_wait_dead(&child);
        linux_wait_port_closed(port);
        owned.stop().unwrap();
        while owned.readers_pending.load(Ordering::Acquire) != 0 {
            assert!(
                std::time::Instant::now() < deadline,
                "guardian retained capture descriptors"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(external.try_wait().unwrap().is_none());
        external.kill().unwrap();
        external.wait().unwrap();
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_repeated_spawn_stop_and_creator_thread_exit_preserve_guardian_ownership() {
        for _ in 0..20 {
            let mut owned = std::thread::spawn(|| {
                let mut command = Command::new("sleep");
                command.arg("120");
                OwnedProcess::spawn(command, Default::default(), "linux-thread-fixture").unwrap()
            })
            .join()
            .unwrap();
            assert!(
                owned.refresh().unwrap().running,
                "creator thread exit killed service"
            );
            let root = linux_watch_pid(owned.child.id());
            owned.stop().unwrap();
            linux_wait_dead(&root);
            owned.stop().unwrap();
            assert!(!owned.refresh().unwrap().running);
        }
        let mut quick = Command::new("sh");
        quick.args(["-c", "printf 'fixture log\\n'; exit 0"]);
        let mut owned =
            OwnedProcess::spawn(quick, Default::default(), "linux-quick-fixture").unwrap();
        assert!(owned.child.wait().unwrap().success());
        owned.stop().unwrap();
        assert!(OwnedProcess::spawn(
            Command::new("/strata-manager-fixture-does-not-exist"),
            Default::default(),
            "linux-failed-exec"
        )
        .is_err());
    }
    #[cfg(windows)]
    #[test]
    fn owned_restart_observes_old_exit_before_new_pid_and_rejects_unowned_ids() {
        let logs: Logs = Default::default();
        let processes = Mutex::new(HashMap::new());
        assert!(stop_owned_for_restart(&processes, "external").is_err());
        let spawn = || {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 60",
            ]);
            OwnedProcess::spawn(command, logs.clone(), "restart-fixture").unwrap()
        };
        let old = spawn();
        let old_pid = old.child.id();
        processes.lock().unwrap().insert("owned".into(), old);
        stop_owned_for_restart(&processes, "owned").unwrap();
        assert!(
            !processes
                .lock()
                .unwrap()
                .get_mut("owned")
                .unwrap()
                .refresh()
                .unwrap()
                .running
        );
        assert!(stop_owned_for_restart(&processes, "owned").is_err());
        let replacement = spawn();
        assert_ne!(old_pid, replacement.child.id());
        processes
            .lock()
            .unwrap()
            .insert("owned".into(), replacement);
        assert!(
            processes
                .lock()
                .unwrap()
                .get_mut("owned")
                .unwrap()
                .refresh()
                .unwrap()
                .running
        );
        stop_owned_for_restart(&processes, "owned").unwrap();
    }
    #[cfg(windows)]
    fn wait_task(tasks: &Tasks, id: &str) -> TaskStatus {
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            let status = tasks.lock().unwrap()[id].status.clone();
            if status.state != "running" {
                return status;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "task fixture did not finish"
            );
            std::thread::sleep(Duration::from_millis(30));
        }
    }

    #[test]
    fn install_claim_retries_keep_partial_files_and_reject_unknown_directories() {
        let temp = tempfile::tempdir().unwrap();
        let database = database();
        let destination = temp.path().join("install");
        let claim = prepare_install(&database, &destination).unwrap();
        std::fs::create_dir(claim.destination.join("repository")).unwrap();
        std::fs::write(
            claim.destination.join("repository/partial.bin"),
            b"preserve me",
        )
        .unwrap();
        let retried = prepare_install(&database, &destination).unwrap();
        assert_eq!(claim.token, retried.token);
        assert!(!retried.destination.join("repository").exists());
        let retained = std::fs::read_dir(temp.path())
            .unwrap()
            .flatten()
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".strata-incomplete-")
            })
            .unwrap()
            .path();
        assert_eq!(
            std::fs::read(retained.join("partial.bin")).unwrap(),
            b"preserve me"
        );
        std::fs::write(retried.destination.join("unknown-user-file"), b"keep").unwrap();
        assert!(prepare_install(&database, &destination).is_err());
        assert_eq!(
            std::fs::read(retried.destination.join("unknown-user-file")).unwrap(),
            b"keep"
        );
        let external = temp.path().join("external");
        std::fs::create_dir(&external).unwrap();
        std::fs::write(external.join("user.txt"), b"user").unwrap();
        assert!(prepare_install(&database, &external).is_err());
        assert_eq!(std::fs::read(external.join("user.txt")).unwrap(), b"user");
    }

    #[test]
    fn install_claim_requires_matching_database_and_marker_and_publishes_only_valid_repo() {
        let temp = tempfile::tempdir().unwrap();
        let database = database();
        let claim = prepare_install(&database, &temp.path().join("install")).unwrap();
        assert!(check_install_claim(&self::database(), &claim).is_err());
        assert!(publish_install(&database, &claim).is_err());
        let repo = claim.destination.join("repository");
        std::fs::create_dir_all(repo.join("serve")).unwrap();
        std::fs::create_dir(repo.join(".git")).unwrap();
        std::fs::write(repo.join("setup.py"), b"fixture").unwrap();
        std::fs::write(repo.join("serve/server.py"), b"fixture").unwrap();
        publish_install(&database, &claim).unwrap();
        assert!(claim.destination.join("setup.py").is_file());
        assert!(!claim.destination.join(INSTALL_MARKER).exists());
        assert!(prepare_install(&database, &claim.destination).is_err());
    }

    #[test]
    fn task_logs_survive_database_reopen_are_bounded_and_redact_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("tasks.sqlite");
        let connection = rusqlite::Connection::open(&db_path).unwrap();
        connection.execute_batch(crate::store::SCHEMA).unwrap();
        let database = Arc::new(Mutex::new(connection));
        let record = TaskRecord {
            status: TaskStatus {
                id: "logs".into(),
                kind: "fixture".into(),
                state: "failed".into(),
                message: "Authorization: Bearer hidden".into(),
                started_at: 1,
                finished_at: Some(2),
            },
            profile_id: Some("profile".into()),
            runtime_path: None,
            cancelled: false,
            process: None,
        };
        persist_task(&database, &record).unwrap();
        let logs: Logs = Default::default();
        register_task_logs(&logs, "logs").unwrap();
        for _ in 0..600 {
            log(&logs, "logs", "stdout", "你".repeat(5000));
        }
        log(
            &logs,
            "logs",
            "stderr",
            "Authorization: Bearer hidden-token",
        );
        log(
            &logs,
            "logs",
            "stdout",
            "download https://user:pass@example.com/file?signature=hidden",
        );
        persist_task_logs(&database, &logs, "logs").unwrap();
        drop(database);
        drop(logs);
        let reopened = Arc::new(Mutex::new(rusqlite::Connection::open(db_path).unwrap()));
        let entries = saved_task_logs(&reopened, "logs").unwrap();
        assert_eq!(entries.len(), 500);
        assert!(entries
            .iter()
            .all(|entry| entry.message.chars().count() <= 4096));
        assert!(entries.iter().any(|entry| entry.level == "stderr"));
        let json = serde_json::to_string(&entries).unwrap();
        assert!(!json.contains("hidden") && !json.contains("user:pass"));
        assert!(json.contains("https://example.com/file"));
        assert_eq!(
            restore_tasks(&reopened).unwrap()["logs"].status.message,
            "[redacted sensitive log]"
        );
    }

    #[cfg(windows)]
    #[test]
    fn same_runtime_blocks_another_profile_and_cancel_releases_it() {
        let temp = tempfile::tempdir().unwrap();
        let database = database();
        let tasks: Tasks = Default::default();
        let logs: Logs = Default::default();
        let make_step = |cwd: PathBuf| Step {
            program: "powershell.exe".into(),
            args: vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "Write-Output 'started'; Start-Sleep -Seconds 30".into(),
            ],
            cwd,
            env: Default::default(),
        };
        let task = launch_task(
            tasks.clone(),
            logs.clone(),
            database.clone(),
            "setup",
            Some("profile-one".into()),
            vec![make_step(temp.path().to_owned())],
        )
        .unwrap();
        assert!(launch_task(
            tasks.clone(),
            logs.clone(),
            database.clone(),
            "update",
            Some("profile-two".into()),
            vec![make_step(temp.path().join("."))]
        )
        .is_err());
        {
            let mut tasks = tasks.lock().unwrap();
            let record = tasks.get_mut(&task.id).unwrap();
            record.cancelled = true;
            if let Some(process) = record.process.as_mut() {
                process.stop().unwrap();
            }
        }
        assert_eq!(wait_task(&tasks, &task.id).state, "cancelled");
        let step = Step {
            program: "powershell.exe".into(),
            args: vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "Write-Output 'retry done'; exit 0".into(),
            ],
            cwd: temp.path().to_owned(),
            env: Default::default(),
        };
        let retried = launch_task(
            tasks.clone(),
            logs,
            database,
            "update",
            Some("profile-two".into()),
            vec![step],
        )
        .unwrap();
        assert_eq!(wait_task(&tasks, &retried.id).state, "completed");
    }

    #[cfg(windows)]
    #[test]
    fn real_failed_and_cancelled_install_can_retry_with_local_git_clone() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        std::fs::create_dir_all(source.join("serve")).unwrap();
        std::fs::write(source.join("setup.py"), b"# fixture only; no models\n").unwrap();
        std::fs::write(source.join("serve/server.py"), b"# fixture only\n").unwrap();
        for args in [
            vec!["init", "--quiet"],
            vec!["add", "."],
            vec![
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "-c",
                "core.hooksPath=NUL",
                "commit",
                "--quiet",
                "-m",
                "fixture",
            ],
        ] {
            let mut command = Command::new("git");
            command.args(args).current_dir(&source);
            hidden(&mut command);
            let result = command.output().unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
        let database = database();
        let tasks: Tasks = Default::default();
        let logs: Logs = Default::default();
        let destination = temp.path().join("runtime");
        let claim = prepare_install(&database, &destination).unwrap();
        let step=Step{program:"powershell.exe".into(),args:vec!["-NoProfile".into(),"-NonInteractive".into(),"-Command".into(),r"New-Item -ItemType Directory repository | Out-Null; Set-Content repository\partial.txt preserved; Write-Error 'fixture failure'; exit 7".into()],cwd:claim.destination.clone(),env:Default::default()};
        let initial = launch_task_with_install(
            tasks.clone(),
            logs.clone(),
            database.clone(),
            "install",
            Some("install-fixture".into()),
            vec![step],
            Some(claim.destination.clone()),
            Some(claim),
        )
        .unwrap();
        assert_eq!(wait_task(&tasks, &initial.id).state, "failed");
        assert!(saved_task_logs(&database, &initial.id)
            .unwrap()
            .iter()
            .any(|entry| entry.level == "stderr"));
        let claim = prepare_install(&database, &destination).unwrap();
        let step=Step{program:"powershell.exe".into(),args:vec!["-NoProfile".into(),"-NonInteractive".into(),"-Command".into(),"New-Item -ItemType Directory repository | Out-Null; Write-Output 'cancel fixture ready'; Start-Sleep -Seconds 30".into()],cwd:claim.destination.clone(),env:Default::default()};
        let cancelled = launch_task_with_install(
            tasks.clone(),
            logs.clone(),
            database.clone(),
            "install",
            Some("install-fixture".into()),
            vec![step],
            Some(claim.destination.clone()),
            Some(claim),
        )
        .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !logs
            .lock()
            .unwrap()
            .get(&cancelled.id)
            .is_some_and(|entries| {
                entries
                    .iter()
                    .any(|entry| entry.message == "cancel fixture ready")
            })
        {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(30));
        }
        {
            let mut records = tasks.lock().unwrap();
            let record = records.get_mut(&cancelled.id).unwrap();
            record.cancelled = true;
            record.process.as_mut().unwrap().stop().unwrap();
        }
        assert_eq!(wait_task(&tasks, &cancelled.id).state, "cancelled");
        let claim = prepare_install(&database, &destination).unwrap();
        let step = Step {
            program: "git".into(),
            args: vec![
                "clone".into(),
                "--quiet".into(),
                source.to_string_lossy().into(),
                claim
                    .destination
                    .join("repository")
                    .to_string_lossy()
                    .into(),
            ],
            cwd: claim.destination.clone(),
            env: Default::default(),
        };
        let completed = launch_task_with_install(
            tasks.clone(),
            logs,
            database,
            "install",
            Some("install-fixture".into()),
            vec![step],
            Some(claim.destination.clone()),
            Some(claim),
        )
        .unwrap();
        assert_eq!(wait_task(&tasks, &completed.id).state, "completed");
        assert!(destination.join("setup.py").is_file());
        assert!(destination.join("serve/server.py").is_file());
        assert!(destination.join(".git").is_dir());
        assert_eq!(
            std::fs::read_dir(temp.path())
                .unwrap()
                .flatten()
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".strata-incomplete-"))
                .count(),
            2
        );
    }
    fn database() -> Arc<Mutex<rusqlite::Connection>> {
        let database = rusqlite::Connection::open_in_memory().unwrap();
        database
            .execute_batch(
                "CREATE TABLE tasks(id TEXT PRIMARY KEY,status TEXT NOT NULL,profile_id TEXT);",
            )
            .unwrap();
        Arc::new(Mutex::new(database))
    }
    #[cfg(windows)]
    #[test]
    fn external_paths_drop_verbatim_prefix_without_changing_normal_arguments() {
        use std::ffi::OsStr;
        assert_eq!(
            external_argument(OsStr::new(
                r"\\?\D:\workspace\strata-manager\.local\runtime"
            ))
            .unwrap(),
            OsStr::new(r"D:\workspace\strata-manager\.local\runtime")
        );
        assert_eq!(
            external_argument(OsStr::new(r"\\?\UNC\server\share\runtime")).unwrap(),
            OsStr::new(r"\\server\share\runtime")
        );
        assert_eq!(
            external_argument(OsStr::new("--family")).unwrap(),
            OsStr::new("--family")
        );
        assert!(external_argument(OsStr::new(r"\\?\D:\directory.\runtime")).is_err());
    }
    #[test]
    fn interrupted_task_is_recovered_honestly() {
        let database = database();
        let record = TaskRecord {
            status: TaskStatus {
                id: "interrupted".into(),
                kind: "setup".into(),
                state: "running".into(),
                message: "downloading".into(),
                started_at: 123,
                finished_at: None,
            },
            profile_id: Some("profile".into()),
            runtime_path: Some(std::env::temp_dir()),
            cancelled: false,
            process: None,
        };
        persist_task(&database, &record).unwrap();
        let restored = restore_tasks(&database).unwrap();
        assert_eq!(restored["interrupted"].status.state, "failed");
        assert!(restored["interrupted"].status.message.contains("中断"));
        assert!(restored["interrupted"].process.is_none());
    }
    #[test]
    fn logs_are_bounded_by_count_and_record_length() {
        let logs: Logs = Default::default();
        register_service_logs(&logs, "test").unwrap();
        for _ in 0..2100 {
            log(&logs, "test", "info", "x");
        }
        log(&logs, "test", "info", "你".repeat(9000));
        let all = logs.lock().unwrap();
        assert_eq!(all["test"].len(), 2000);
        assert_eq!(all["test"].back().unwrap().message.chars().count(), 8192);
    }
    #[test]
    fn log_budget_bounds_all_sources_and_retired_writers_cannot_recreate_buckets() {
        let logs = Arc::new(Mutex::new(LogStore::with_limits(4, 6, 800)));
        register_task_logs(&logs, "task").unwrap();
        log(&logs, "task", "info", "keep");
        register_task_logs(&logs, "task").unwrap();
        assert_eq!(logs.lock().unwrap()["task"].len(), 1);
        for source in 0..20 {
            let id = format!("service-{source}");
            register_service_logs(&logs, &id).unwrap();
            for _ in 0..4 {
                log(&logs, &id, "stdout", "你".repeat(100));
                let store = logs.lock().unwrap();
                assert!(store.buckets.len() <= 4 && store.entries <= 6 && store.bytes <= 800);
                assert_eq!(
                    store.entries,
                    store
                        .buckets
                        .values()
                        .map(|bucket| bucket.entries.len())
                        .sum::<usize>()
                );
                assert_eq!(
                    store.bytes,
                    store
                        .buckets
                        .values()
                        .flat_map(|bucket| &bucket.entries)
                        .map(LogStore::size)
                        .sum::<usize>()
                );
            }
        }
        logs.lock().unwrap().retire("task");
        log(&logs, "task", "stdout", "late output");
        assert!(logs.lock().unwrap().get("task").is_none());
        register_service_logs(&logs, "probe").unwrap();
        let pending = Arc::new(AtomicUsize::new(0));
        capture(
            std::io::Cursor::new(b"probe output\n"),
            logs.clone(),
            "probe".into(),
            "stdout",
            pending.clone(),
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while pending.load(Ordering::Acquire) != 0 && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(pending.load(Ordering::Acquire), 0);
        assert_eq!(
            logs.lock().unwrap()["probe"].back().unwrap().message,
            "probe output"
        );
    }
    #[test]
    fn log_budget_retired_capture_cannot_recreate_its_task_bucket() {
        struct GatedRead {
            ready: Option<std::sync::mpsc::Sender<()>>,
            release: std::sync::mpsc::Receiver<()>,
            data: std::io::Cursor<Vec<u8>>,
        }
        impl Read for GatedRead {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                if let Some(ready) = self.ready.take() {
                    ready.send(()).unwrap();
                    self.release.recv_timeout(Duration::from_secs(2)).unwrap();
                }
                self.data.read(buffer)
            }
        }
        let logs: Logs = Default::default();
        register_task_logs(&logs, "retired").unwrap();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let pending = Arc::new(AtomicUsize::new(0));
        capture(
            GatedRead {
                ready: Some(ready_tx),
                release: release_rx,
                data: std::io::Cursor::new(b"late stdout\n".to_vec()),
            },
            logs.clone(),
            "retired".into(),
            "stdout",
            pending.clone(),
        );
        ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        logs.lock().unwrap().retire("retired");
        release_tx.send(()).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while pending.load(Ordering::Acquire) != 0 && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(pending.load(Ordering::Acquire), 0);
        assert!(logs.lock().unwrap().get("retired").is_none());
    }
    #[test]
    fn log_budget_preserves_active_sources_and_abandoned_tasks_are_not_restored_running() {
        let mut store = LogStore::with_limits(2, 20, 2000);
        store.register("active", LogKind::Service).unwrap();
        store.service_active("active", true);
        store.register("inactive", LogKind::Service).unwrap();
        store.register("next", LogKind::Service).unwrap();
        assert!(store.get("active").is_some() && store.get("inactive").is_none());
        store.service_active("next", true);
        assert!(store.register("capacity", LogKind::Service).is_err());
        assert_eq!(store.buckets.len(), 2);
        let database = Arc::new(Mutex::new(rusqlite::Connection::open_in_memory().unwrap()));
        database
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TABLE tasks(id TEXT PRIMARY KEY,status TEXT NOT NULL,profile_id TEXT);",
            )
            .unwrap();
        let logs: Logs = Default::default();
        let mut tasks = HashMap::new();
        register_task_logs(&logs, "abandoned").unwrap();
        tasks.insert(
            "abandoned".into(),
            TaskRecord {
                status: TaskStatus {
                    id: "abandoned".into(),
                    kind: "install".into(),
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
        persist_task(&database, &tasks["abandoned"]).unwrap();
        abandon_unstarted_task(
            &database,
            &mut tasks,
            &logs,
            "abandoned",
            "synthetic status write failure",
        );
        assert!(tasks.is_empty() && logs.lock().unwrap().get("abandoned").is_none());
        assert_eq!(
            restore_tasks(&database).unwrap()["abandoned"].status.state,
            "failed"
        );
    }
    #[test]
    fn log_budget_task_admission_retires_finished_logs_and_preserves_running_and_saved_logs() {
        let logs: Logs = Default::default();
        let mut tasks = HashMap::new();
        let database = Arc::new(Mutex::new(rusqlite::Connection::open_in_memory().unwrap()));
        database
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TABLE tasks(id TEXT PRIMARY KEY,status TEXT NOT NULL,profile_id TEXT);",
            )
            .unwrap();
        for index in 0..100 {
            let id = format!("task-{index}");
            register_task_logs(&logs, &id).unwrap();
            log(&logs, &id, "info", "saved diagnostic");
            tasks.insert(
                id.clone(),
                TaskRecord {
                    status: TaskStatus {
                        id,
                        kind: "setup".into(),
                        state: if index == 0 { "running" } else { "succeeded" }.into(),
                        message: "fixture".into(),
                        started_at: index,
                        finished_at: None,
                    },
                    profile_id: None,
                    runtime_path: None,
                    cancelled: false,
                    process: None,
                },
            );
        }
        persist_task(&database, &tasks["task-1"]).unwrap();
        persist_task_logs(&database, &logs, "task-1").unwrap();
        register_service_logs(&logs, "service").unwrap();
        log(&logs, "service", "info", "running service");
        admit_task_logs(&mut tasks, &logs, "new-task").unwrap();
        assert!(tasks.contains_key("task-0") && !tasks.contains_key("task-1"));
        let store = logs.lock().unwrap();
        assert!(store.get("task-0").is_some() && store.get("task-1").is_none());
        assert_eq!(store["service"].back().unwrap().message, "running service");
        drop(store);
        assert_eq!(
            saved_task_logs(&database, "task-1").unwrap()[0].message,
            "saved diagnostic"
        );
        for task in tasks.values_mut() {
            task.status.state = "running".into();
        }
        tasks.insert(
            "new-task".into(),
            TaskRecord {
                status: TaskStatus {
                    id: "new-task".into(),
                    kind: "setup".into(),
                    state: "running".into(),
                    message: "fixture".into(),
                    started_at: 101,
                    finished_at: None,
                },
                profile_id: None,
                runtime_path: None,
                cancelled: false,
                process: None,
            },
        );
        assert!(admit_task_logs(&mut tasks, &logs, "over-capacity").is_err());
        assert!(logs.lock().unwrap().get("over-capacity").is_none());
    }
    #[cfg(windows)]
    #[test]
    fn owned_process_can_be_stopped_and_exit_is_observed() {
        let logs: Logs = Default::default();
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Write-Output 'native fixture'; Start-Sleep -Seconds 60",
        ]);
        let mut process = OwnedProcess::spawn(command, logs.clone(), "fixture").unwrap();
        assert!(process.refresh().unwrap().running);
        process.stop().unwrap();
        assert!(!process.refresh().unwrap().running);
        assert!(process.status.owned);
    }
    #[cfg(windows)]
    #[test]
    fn owned_job_stops_grandchild_but_keeps_external_process() {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };
        let logs: Logs = Default::default();
        let mut external_cmd = Command::new("powershell.exe");
        external_cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 60",
        ]);
        hidden(&mut external_cmd);
        let mut external = external_cmd.spawn().unwrap();
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile","-NonInteractive","-Command","$child = Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60' -WindowStyle Hidden -PassThru; Write-Output $child.Id; Start-Sleep -Seconds 60"]);
        let mut owned = OwnedProcess::spawn(command, logs.clone(), "tree-fixture").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let pid = loop {
            let pid = logs
                .lock()
                .unwrap()
                .get("tree-fixture")
                .and_then(|entries| {
                    entries
                        .iter()
                        .find_map(|entry| entry.message.trim().parse::<u32>().ok())
                });
            if let Some(pid) = pid {
                break pid;
            }
            if std::time::Instant::now() >= deadline {
                let _ = external.kill();
                panic!("owned grandchild PID not captured");
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        unsafe {
            let child_handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            assert!(!child_handle.is_null());
            owned.stop().unwrap();
            let child_exit = WaitForSingleObject(child_handle, 3000);
            windows_sys::Win32::Foundation::CloseHandle(child_handle);
            assert_eq!(child_exit, 0, "owned grandchild did not exit with Job");
            assert_ne!(
                WaitForSingleObject(external.as_raw_handle() as _, 0),
                0,
                "external process was stopped"
            );
        }
        external.kill().unwrap();
        external.wait().unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn background_command_failure_is_not_success() {
        let logs: Logs = Default::default();
        let tasks: Tasks = Default::default();
        let database = database();
        let step = Step {
            program: "powershell.exe".into(),
            args: vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "Write-Error 'expected test failure'; exit 7".into(),
            ],
            cwd: std::env::temp_dir(),
            env: Default::default(),
        };
        let initial = launch_task(
            tasks.clone(),
            logs,
            database.clone(),
            "fixture",
            Some("fixture".into()),
            vec![step],
        )
        .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            let status = tasks.lock().unwrap()[&initial.id].status.clone();
            if status.state != "running" {
                assert_eq!(status.state, "failed");
                assert!(status.message.contains('7'));
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "fixture task did not finish"
            );
            std::thread::sleep(Duration::from_millis(150));
        }
        assert_eq!(
            restore_tasks(&database).unwrap()[&initial.id].status.state,
            "failed"
        );
    }

    #[cfg(windows)]
    #[test]
    fn task_step_environment_is_scoped_and_can_remove_inherited_values() {
        const KEY: &str = "STRATA_MANAGER_ENV_ISOLATION_FIXTURE";
        let before = std::env::var_os(KEY);
        let fixture = tempfile::tempdir().unwrap();
        let tasks: Tasks = Default::default();
        let logs: Logs = Default::default();
        let steps = vec![
            Step {
                program: "powershell.exe".into(),
                args: vec!["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), "if ($env:STRATA_MANAGER_ENV_ISOLATION_FIXTURE -ne 'task-only') { exit 3 }; Write-Output 'scoped'".into()],
                cwd: fixture.path().into(),
                env: BTreeMap::from([(KEY.into(), Some("task-only".into()))]),
            },
            Step {
                program: "powershell.exe".into(),
                args: vec!["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), "if (Test-Path Env:STRATA_MANAGER_ENV_ISOLATION_FIXTURE) { exit 4 }; Write-Output 'removed'".into()],
                cwd: fixture.path().into(),
                env: BTreeMap::from([(KEY.into(), None)]),
            },
        ];
        let task = launch_task(
            tasks.clone(),
            logs,
            database(),
            "environment-fixture",
            None,
            steps,
        )
        .unwrap();
        assert_eq!(wait_task(&tasks, &task.id).state, "completed");
        assert_eq!(std::env::var_os(KEY), before);
    }
}
