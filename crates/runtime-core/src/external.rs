use crate::types::ServiceProfile;
use serde_json::Value;
#[cfg(windows)]
use std::path::{Path, PathBuf};

pub fn local_port(profile: &ServiceProfile) -> Result<u16, String> {
    let url = crate::http::endpoint(profile, "/health")?;
    if url.scheme() != "http"
        || !matches!(url.host(), Some(url::Host::Ipv4(ip)) if ip.is_loopback())
            && !matches!(url.host(), Some(url::Host::Ipv6(ip)) if ip.is_loopback())
            && url.host_str() != Some("localhost")
    {
        return Err("外部进程识别/接管仅支持本机 loopback HTTP 服务".into());
    }
    url.port_or_known_default()
        .ok_or_else(|| "服务端口无效".into())
}

#[cfg(windows)]
fn same_path(a: &Path, b: &Path) -> bool {
    match (dunce::canonicalize(a), dunce::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

#[cfg(windows)]
fn validate_venv_base(selected: &Path, image: &Path) -> Result<(), String> {
    let scripts = selected.parent().ok_or("venv Python 路径无效")?;
    if selected
        .file_name()
        .and_then(|v| v.to_str())
        .is_none_or(|v| !v.eq_ignore_ascii_case("python.exe"))
        || scripts
            .file_name()
            .and_then(|v| v.to_str())
            .is_none_or(|v| !v.eq_ignore_ascii_case("Scripts"))
    {
        return Err("所选 Python 不是可核验的标准 Windows venv 启动器".into());
    }
    let cfg = scripts
        .parent()
        .ok_or("venv 根目录无效")?
        .join("pyvenv.cfg");
    let metadata = std::fs::symlink_metadata(&cfg).map_err(|_| "缺少 venv pyvenv.cfg")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 8192 {
        return Err("venv 配置文件类型或大小无效".into());
    }
    let text = std::fs::read_to_string(cfg).map_err(|_| "无法读取 venv 配置")?;
    let mut entries = std::collections::HashMap::new();
    for line in text.lines() {
        if let Some((key, value)) = line.split_once('=') {
            if entries
                .insert(key.trim().to_ascii_lowercase(), value.trim())
                .is_some()
            {
                return Err("venv 配置字段重复，无法核验".into());
            }
        }
    }
    let home = Path::new(entries.get("home").ok_or("venv 配置缺少 home")?);
    if !home.is_absolute() || !same_path(&home.join("python.exe"), image) {
        return Err("venv home 与端口进程 Python 不一致".into());
    }
    for key in ["base-executable", "executable"] {
        if let Some(value) = entries.get(key) {
            let path = Path::new(value);
            if !path.is_absolute() || !same_path(path, image) {
                return Err("venv base-executable/executable 与进程不一致".into());
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn validate_arguments(
    profile: &ServiceProfile,
    image: &Path,
    argv: &[String],
) -> Result<(), String> {
    let python = Path::new(&profile.python_path);
    if !python.is_absolute() || !python.is_file() {
        return Err("接管需要明确选择实际 Python 可执行文件的绝对路径".into());
    }
    if argv
        .first()
        .is_none_or(|value| !same_path(Path::new(value.trim_start_matches("\\??\\")), python))
    {
        return Err("进程 argv[0] 与所选 Python 不一致".into());
    }
    if !same_path(python, image) {
        validate_venv_base(python, image)?;
    }
    validate_server_arguments(profile, argv)
}

#[cfg(windows)]
fn validate_server_arguments(profile: &ServiceProfile, argv: &[String]) -> Result<(), String> {
    let mut index = 1;
    while argv
        .get(index)
        .is_some_and(|arg| matches!(arg.as_str(), "-u" | "-B"))
    {
        index += 1;
    }
    if argv.get(index).map(String::as_str) != Some("-m")
        || argv.get(index + 1).map(String::as_str) != Some("serve.server")
    {
        return Err("端口进程并非 Python -m serve.server，拒绝接管".into());
    }
    index += 2;
    let mut options = std::collections::HashMap::new();
    while index < argv.len() {
        let name = argv[index].as_str();
        if matches!(name, "--api-monitor" | "--no-open-browser") {
            index += 1;
            continue;
        }
        if !matches!(name, "--engine" | "--config" | "--host" | "--port") {
            return Err("实例包含不在可核验范围内的启动参数，拒绝接管".into());
        }
        let value = argv.get(index + 1).ok_or("Strata 启动参数缺少值")?;
        if options.insert(name, value.as_str()).is_some() {
            return Err("Strata 启动参数重复，无法确认真实配置".into());
        }
        index += 2;
    }
    if options
        .get("--engine")
        .is_some_and(|engine| *engine != "strata")
    {
        return Err("该实例并非 Strata 引擎".into());
    }
    let config = Path::new(
        options
            .get("--config")
            .ok_or("实例缺少明确的 --config 绝对路径")?,
    );
    if !config.is_absolute() || !same_path(config, Path::new(&profile.config_path)) {
        return Err("实例配置路径与所选档案不一致".into());
    }
    let config_json = crate::storage::read(profile)?;
    let port = options
        .get("--port")
        .map(|port| port.parse::<u16>())
        .transpose()
        .map_err(|_| "实例端口参数无效")?
        .or_else(|| {
            config_json
                .get("port")
                .and_then(Value::as_u64)
                .and_then(|value| u16::try_from(value).ok())
        })
        .unwrap_or(8080);
    if port != local_port(profile)? {
        return Err("实例启动端口与所选服务不一致".into());
    }
    let host = options
        .get("--host")
        .copied()
        .or_else(|| config_json.get("host").and_then(Value::as_str))
        .unwrap_or("127.0.0.1");
    if host != "localhost"
        && !host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
    {
        return Err("实例监听地址不是 loopback，拒绝接管".into());
    }
    Ok(())
}

/// A successful loopback TCP connection proves a listener exists even if identity probes fail.
pub fn port_accepting(profile: &ServiceProfile) -> Result<bool, String> {
    let port = local_port(profile)?;
    #[cfg(windows)]
    if let Ok(ids) = platform::listening_ids(port) {
        return Ok(!ids.is_empty());
    }
    let url = crate::http::endpoint(profile, "/health")?;
    let ips = match url.host() {
        Some(url::Host::Ipv4(ip)) => vec![std::net::IpAddr::V4(ip)],
        Some(url::Host::Ipv6(ip)) => vec![std::net::IpAddr::V6(ip)],
        _ => vec![
            std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
            std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST),
        ],
    };
    let mut uncertain = None;
    for ip in ips {
        match std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::new(ip, port),
            std::time::Duration::from_millis(500),
        ) {
            Ok(_) => return Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {}
            Err(error) => uncertain = Some(error),
        }
    }
    match uncertain {
        Some(error) => Err(format!("无法确认监听状态: {error}")),
        None => Ok(false),
    }
}

pub fn ensure_idle(status: &Value, metrics: &Value) -> Result<(), String> {
    if status.get("service").and_then(Value::as_str) != Some("strata") {
        return Err("HTTP 服务未提供真实 Strata 身份状态".into());
    }
    if status
        .pointer("/activity/in_flight")
        .and_then(Value::as_u64)
        != Some(0)
    {
        return Err("服务有活动或排队请求，接管已拒绝".into());
    }
    let live = metrics
        .get("live")
        .ok_or("缺少服务活动状态，不能安全接管")?;
    if !matches!(
        live.get("state").and_then(Value::as_str),
        Some("idle" | "unloaded")
    ) || live.get("queued").and_then(Value::as_u64) != Some(0)
        || ["running", "waiting", "outside_slots"]
            .iter()
            .any(|key| live.get(key).is_some_and(|value| value.as_u64() != Some(0)))
    {
        return Err("服务有活动/排队/并行请求，接管已拒绝".into());
    }
    Ok(())
}

#[cfg(windows)]
mod platform {
    use super::*;
    use windows_sys::Win32::{
        Foundation::*,
        System::{Diagnostics::ToolHelp::*, Threading::*},
        UI::Shell::CommandLineToArgvW,
    };
    pub struct VerifiedExternal {
        pub pid: u32,
        pub created: u64,
        image: PathBuf,
        command: String,
        handle: HANDLE,
        launcher: Option<Box<VerifiedExternal>>,
    }
    unsafe impl Send for VerifiedExternal {}
    impl Drop for VerifiedExternal {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }
    fn identity(handle: HANDLE) -> Result<(u64, PathBuf), String> {
        unsafe {
            let mut created: FILETIME = std::mem::zeroed();
            let mut exit = created;
            let mut kernel = created;
            let mut user = created;
            if GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user) == 0 {
                return Err("无法确认进程创建时间".into());
            }
            let mut image = vec![0u16; 32768];
            let mut length = image.len() as u32;
            if QueryFullProcessImageNameW(handle, 0, image.as_mut_ptr(), &mut length) == 0 {
                return Err("无法确认进程可执行文件".into());
            }
            Ok((
                ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64,
                PathBuf::from(
                    String::from_utf16(&image[..length as usize])
                        .map_err(|_| "进程路径Unicode无效")?,
                ),
            ))
        }
    }
    fn arguments(command: &str) -> Result<Vec<String>, String> {
        let wide: Vec<_> = command.encode_utf16().chain(std::iter::once(0)).collect();
        let mut count = 0;
        unsafe {
            let pointers = CommandLineToArgvW(wide.as_ptr(), &mut count);
            if pointers.is_null() {
                return Err("无法解析完整启动参数".into());
            }
            let result = (|| {
                let mut args = vec![];
                for index in 0..count as usize {
                    let pointer = *pointers.add(index);
                    let mut length = 0;
                    while *pointer.add(length) != 0 {
                        length += 1;
                    }
                    args.push(
                        String::from_utf16(std::slice::from_raw_parts(pointer, length))
                            .map_err(|_| "启动参数Unicode无效")?,
                    );
                }
                Ok(args)
            })();
            LocalFree(pointers as _);
            result
        }
    }
    fn command_for(pid: u32) -> Result<String, String> {
        let script=format!("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); (Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine");
        crate::output(
            "powershell.exe",
            &["-NoProfile", "-NonInteractive", "-Command", &script],
        )
        .filter(|line| !line.is_empty())
        .ok_or_else(|| "无法读取完整进程命令行（权限不足或探测超时）".into())
    }
    fn parent_pid(pid: u32) -> Result<u32, String> {
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err("无法核验 venv 父进程".into());
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of_val(&entry) as u32;
            let mut next = Process32FirstW(snapshot, &mut entry);
            let mut parent = None;
            while next != 0 {
                if entry.th32ProcessID == pid {
                    parent = Some(entry.th32ParentProcessID);
                    break;
                }
                next = Process32NextW(snapshot, &mut entry);
            }
            CloseHandle(snapshot);
            parent.ok_or_else(|| "venv 子进程已退出".into())
        }
    }
    fn inspect(pid: u32) -> Result<VerifiedExternal, String> {
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if handle.is_null() {
            return Err("无法打开端口/venv进程核验身份".into());
        }
        let result = (|| {
            let (created, image) = identity(handle)?;
            Ok(VerifiedExternal {
                pid,
                created,
                image,
                command: command_for(pid)?,
                handle,
                launcher: None,
            })
        })();
        if result.is_err() {
            unsafe {
                CloseHandle(handle);
            }
        }
        result
    }
    fn validate_chain(
        profile: &ServiceProfile,
        instance: &VerifiedExternal,
        launcher: Option<&VerifiedExternal>,
    ) -> Result<(), String> {
        let argv = arguments(&instance.command)?;
        if let Some(parent) = launcher {
            let parent_argv = arguments(&parent.command)?;
            if parent_pid(instance.pid)? != parent.pid
                || parent.created >= instance.created
                || !same_path(Path::new(&profile.python_path), &parent.image)
                || argv.first().is_none_or(|value| {
                    !same_path(
                        Path::new(value.trim_start_matches("\\??\\")),
                        &instance.image,
                    )
                })
                || argv.get(1..) != parent_argv.get(1..)
            {
                return Err("venv 父子身份、创建顺序或完整启动参数不匹配".into());
            }
            validate_arguments(profile, &parent.image, &parent_argv)?;
            validate_venv_base(Path::new(&profile.python_path), &instance.image)?;
            validate_server_arguments(profile, &argv)
        } else {
            validate_arguments(profile, &instance.image, &argv)
        }
    }
    pub(super) fn listening_ids(port: u16) -> Result<Vec<u32>, String> {
        let script=format!("$ErrorActionPreference='Stop'; $ids=@(Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); ConvertTo-Json -InputObject $ids -Compress");
        let text = crate::output(
            "powershell.exe",
            &["-NoProfile", "-NonInteractive", "-Command", &script],
        )
        .ok_or("无法读取监听端口进程（权限不足或探测超时）")?;
        serde_json::from_str(&text).map_err(|_| "监听端口查询结果无效".into())
    }
    pub fn detect(profile: &ServiceProfile) -> Result<Option<VerifiedExternal>, String> {
        let ids = listening_ids(local_port(profile)?)?;
        if ids.is_empty() {
            return Ok(None);
        }
        if ids.len() != 1 {
            return Err("端口存在多个监听进程，无法安全确定实例".into());
        }
        let mut candidate = inspect(ids[0])?;
        if validate_chain(profile, &candidate, None).is_err() {
            let launcher = inspect(parent_pid(candidate.pid)?)?;
            validate_chain(profile, &candidate, Some(&launcher))?;
            candidate.launcher = Some(Box::new(launcher));
        }
        candidate.revalidate(profile)?;
        Ok(Some(candidate))
    }
    impl VerifiedExternal {
        pub fn revalidate(&self, profile: &ServiceProfile) -> Result<(), String> {
            self.revalidate_with_launcher(profile, self.launcher.as_deref())?;
            if listening_ids(local_port(profile)?)? != vec![self.pid] {
                return Err("监听端口已不属于原已核验实例，未卸载或停止任何进程".into());
            }
            Ok(())
        }
        fn revalidate_with_launcher(
            &self,
            profile: &ServiceProfile,
            launcher: Option<&VerifiedExternal>,
        ) -> Result<(), String> {
            if unsafe { WaitForSingleObject(self.handle, 0) } != WAIT_TIMEOUT {
                return Err("已核验实例已经退出，拒绝接管".into());
            }
            let (created, image) = identity(self.handle)?;
            let command = command_for(self.pid)?;
            if created != self.created || image != self.image || command != self.command {
                return Err("PID创建时间或进程身份已变化，拒绝接管".into());
            }
            if let Some(parent) = launcher {
                parent.revalidate_with_launcher(profile, None)?;
            }
            validate_chain(profile, self, launcher)
        }
        pub fn stop_verified_tree(
            &self,
            profile: &ServiceProfile,
            before_stop: impl FnOnce() -> Result<(), String>,
        ) -> Result<(), String> {
            self.revalidate(profile)?;
            unsafe {
                use windows_sys::Win32::System::JobObjects::*;
                struct NoKillJob(HANDLE);
                impl Drop for NoKillJob {
                    fn drop(&mut self) {
                        unsafe {
                            CloseHandle(self.0);
                        }
                    }
                }
                // No KILL_ON_JOB_CLOSE: any failed verification leaves the external instance alive.
                let root_job = NoKillJob(CreateJobObjectW(std::ptr::null(), std::ptr::null()));
                if root_job.0.is_null() {
                    return Err("无法建立接管子树核验Job，未停止实例".into());
                }
                let root_handle = OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION
                        | PROCESS_SYNCHRONIZE
                        | PROCESS_TERMINATE
                        | PROCESS_SET_QUOTA,
                    0,
                    self.pid,
                );
                if root_handle.is_null() {
                    return Err("无法取得已核验实例停止权限".into());
                }
                let (created, image) = match identity(root_handle) {
                    Ok(value) => value,
                    Err(error) => {
                        CloseHandle(root_handle);
                        return Err(error);
                    }
                };
                let root = VerifiedExternal {
                    pid: self.pid,
                    created,
                    image,
                    command: self.command.clone(),
                    handle: root_handle,
                    launcher: None,
                };
                if root.created != self.created || root.image != self.image {
                    return Err("实例PID身份已变化，未停止任何进程".into());
                }
                root.revalidate_with_launcher(profile, self.launcher.as_deref())?;
                if AssignProcessToJobObject(root_job.0, root.handle) == 0 {
                    return Err(format!(
                        "现有实例的 Job 不允许安全接管，未停止任何进程：{}",
                        std::io::Error::last_os_error()
                    ));
                }
                let mut jobs = vec![root_job];
                let mut tree: Vec<VerifiedExternal> = vec![];
                let mut parents = std::collections::HashMap::from([(self.pid, self.created)]);
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                loop {
                    if std::time::Instant::now() > deadline {
                        return Err("子树仍在变化，接管已拒绝，未停止实例".into());
                    }
                    let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
                    if snapshot == INVALID_HANDLE_VALUE {
                        return Err("无法完整获取实例子树，拒绝停止".into());
                    }
                    let mut entry: PROCESSENTRY32W = std::mem::zeroed();
                    entry.dwSize = std::mem::size_of_val(&entry) as u32;
                    let mut rows = vec![];
                    let mut next = Process32FirstW(snapshot, &mut entry);
                    while next != 0 {
                        rows.push((entry.th32ProcessID, entry.th32ParentProcessID));
                        next = Process32NextW(snapshot, &mut entry);
                    }
                    CloseHandle(snapshot);
                    let mut added = false;
                    for &(pid, parent) in &rows {
                        if parents.contains_key(&pid) {
                            continue;
                        }
                        let Some(&parent_created) = parents.get(&parent) else {
                            continue;
                        };
                        let handle = OpenProcess(
                            PROCESS_QUERY_LIMITED_INFORMATION
                                | PROCESS_SYNCHRONIZE
                                | PROCESS_TERMINATE
                                | PROCESS_SET_QUOTA,
                            0,
                            pid,
                        );
                        if handle.is_null() {
                            return Err("实例子进程身份/权限不可确认，未停止任何进程".into());
                        }
                        let (created, image) = match identity(handle) {
                            Ok(value) => value,
                            Err(error) => {
                                CloseHandle(handle);
                                return Err(error);
                            }
                        };
                        let child = VerifiedExternal {
                            pid,
                            created,
                            image,
                            command: String::new(),
                            handle,
                            launcher: None,
                        };
                        if created < parent_created {
                            return Err("检测到父PID复用，子树关联不可靠；未停止任何进程".into());
                        }
                        let mut captured = false;
                        for job in &jobs {
                            let mut in_job = 0;
                            if IsProcessInJob(child.handle, job.0, &mut in_job) == 0 {
                                return Err(format!(
                                    "无法核验子进程 {pid} 的 Job 归属，未停止实例：{}",
                                    std::io::Error::last_os_error()
                                ));
                            }
                            if in_job != 0 {
                                captured = true;
                                break;
                            }
                        }
                        if !captured {
                            // An engine may already be in its own Job, created
                            // before the server entered our capture Job. Windows
                            // cannot merge those disjoint non-empty hierarchies.
                            // A fresh empty Job captures this exact verified
                            // branch as a nested subset, including future children
                            // while leaving unrelated peers of its old Job alive.
                            let branch_job =
                                NoKillJob(CreateJobObjectW(std::ptr::null(), std::ptr::null()));
                            if branch_job.0.is_null() {
                                return Err(format!(
                                    "无法建立子进程 {pid} 的接管 Job，未停止实例：{}",
                                    std::io::Error::last_os_error()
                                ));
                            }
                            if AssignProcessToJobObject(branch_job.0, child.handle) == 0 {
                                return Err(format!(
                                    "子进程 {pid} 的既有 Job 无法安全纳管，未停止实例：{}",
                                    std::io::Error::last_os_error()
                                ));
                            }
                            let mut member = 0;
                            if IsProcessInJob(child.handle, branch_job.0, &mut member) == 0
                                || member == 0
                            {
                                return Err(format!(
                                    "子进程 {pid} 未进入已核验的接管 Job，未停止实例：{}",
                                    std::io::Error::last_os_error()
                                ));
                            }
                            jobs.push(branch_job);
                        }
                        parents.insert(pid, created);
                        tree.push(child);
                        added = true;
                        if tree.len() > 128 {
                            return Err("实例子树过大，拒绝接管".into());
                        }
                    }
                    if !added {
                        break;
                    }
                }
                root.revalidate_with_launcher(profile, self.launcher.as_deref())?;
                for child in &tree {
                    if identity(child.handle)? != (child.created, child.image.clone()) {
                        return Err("子树进程身份已变化，未停止任何进程".into());
                    }
                }
                self.revalidate(profile)?;
                before_stop()?;
                self.revalidate(profile)?;
                if identity(root.handle)? != (self.created, self.image.clone()) {
                    return Err("实例身份已变化，未停止实例".into());
                }
                for job in jobs.iter().rev() {
                    if TerminateJobObject(job.0, 1) == 0 {
                        return Err(format!(
                            "已核验实例支树停止失败，未启动新的服务：{}",
                            std::io::Error::last_os_error()
                        ));
                    }
                }
                for process in tree.iter().chain(std::iter::once(&root)) {
                    if WaitForSingleObject(process.handle, 5000) != WAIT_OBJECT_0 {
                        return Err("已核验进程仍未退出；未启动新的服务".into());
                    }
                }
                Ok(())
            }
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        use std::process::{Child, Command};
        struct Fixture(Child);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        fn wait_for(path: &Path) {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            while !path.is_file() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "external fixture never became ready"
                );
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
        }
        #[test]
        fn existing_engine_job_is_captured_as_its_exact_branch_without_killing_unrelated_peers() {
            use windows_sys::Win32::System::JobObjects::*;
            struct EngineJob(HANDLE);
            impl Drop for EngineJob {
                fn drop(&mut self) {
                    unsafe {
                        TerminateJobObject(self.0, 1);
                        CloseHandle(self.0);
                    }
                }
            }
            struct ProcessHandle(HANDLE);
            impl Drop for ProcessHandle {
                fn drop(&mut self) {
                    unsafe {
                        CloseHandle(self.0);
                    }
                }
            }
            let python = crate::output(
                "py",
                &["-I", "-S", "-c", "import sys;print(sys.executable)"],
            )
            .unwrap();
            let temp = tempfile::tempdir().unwrap();
            let name = format!("Local\\StrataFixtureEngine-{}", uuid::Uuid::new_v4());
            let wide: Vec<_> = name.encode_utf16().chain(std::iter::once(0)).collect();
            let engine_job =
                EngineJob(unsafe { CreateJobObjectW(std::ptr::null(), wide.as_ptr()) });
            assert!(!engine_job.0.is_null());
            std::fs::create_dir(temp.path().join("serve")).unwrap();
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);
            let config = temp.path().join("strata.json");
            std::fs::write(
                &config,
                serde_json::to_vec(&serde_json::json!({"port":port,"host":"127.0.0.1"})).unwrap(),
            )
            .unwrap();
            std::fs::write(temp.path().join("serve/server.py"),r#"import ctypes,json,os,pathlib,socket,subprocess,sys,time
k=ctypes.WinDLL('kernel32',use_last_error=True)
k.OpenJobObjectW.argtypes=[ctypes.c_uint32,ctypes.c_int,ctypes.c_wchar_p];k.OpenJobObjectW.restype=ctypes.c_void_p
k.AssignProcessToJobObject.argtypes=[ctypes.c_void_p,ctypes.c_void_p];k.AssignProcessToJobObject.restype=ctypes.c_int
job=k.OpenJobObjectW(1,False,os.environ['FIXTURE_ENGINE_JOB'])
assert job,ctypes.get_last_error()
engine_code='''import json,os,pathlib,subprocess,sys,time
while not pathlib.Path('allow-engine').exists():time.sleep(0.01)
grandchild=subprocess.Popen([sys.executable,'-c','import time;time.sleep(90)'],creationflags=0x08000000)
pathlib.Path('engine-tree.json').write_text(json.dumps({'engine':os.getpid(),'grandchild':grandchild.pid}))
time.sleep(90)
'''
engine=subprocess.Popen([sys.executable,'-c',engine_code],creationflags=0x08000000)
assert k.AssignProcessToJobObject(job,int(engine._handle)),ctypes.get_last_error()
pathlib.Path('allow-engine').write_text('ready')
while not pathlib.Path('engine-tree.json').exists():time.sleep(0.01)
s=socket.socket();s.bind(('127.0.0.1',int(sys.argv[sys.argv.index('--port')+1])));s.listen()
pathlib.Path('ready').write_text('ready')
time.sleep(90)
"#).unwrap();
            let profile = ServiceProfile {
                id: "nested-job-fixture".into(),
                name: String::new(),
                base_url: format!("http://127.0.0.1:{port}"),
                install_dir: temp.path().to_string_lossy().into(),
                python_path: python.clone(),
                config_path: config.to_string_lossy().into(),
                managed: true,
            };
            let mut command = Command::new(&python);
            command
                .current_dir(temp.path())
                .args(["-u", "-m", "serve.server", "--engine", "strata", "--config"])
                .arg(&config)
                .args(["--host", "127.0.0.1", "--port", &port.to_string()])
                .env("FIXTURE_ENGINE_JOB", &name);
            crate::processes::hidden(&mut command);
            let mut server = Fixture(command.spawn().unwrap());
            wait_for(&temp.path().join("ready"));
            let tree: Value = serde_json::from_slice(
                &std::fs::read(temp.path().join("engine-tree.json")).unwrap(),
            )
            .unwrap();
            let open = |pid: u32| {
                let handle = unsafe {
                    OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION
                            | PROCESS_SYNCHRONIZE
                            | PROCESS_TERMINATE
                            | PROCESS_SET_QUOTA,
                        0,
                        pid,
                    )
                };
                assert!(!handle.is_null());
                ProcessHandle(handle)
            };
            let engine = open(tree["engine"].as_u64().unwrap() as u32);
            let grandchild = open(tree["grandchild"].as_u64().unwrap() as u32);
            let mut peer_command = Command::new(&python);
            peer_command.args(["-c", "import time;time.sleep(90)"]);
            crate::processes::hidden(&mut peer_command);
            let mut unrelated = Fixture(peer_command.spawn().unwrap());
            let peer = open(unrelated.0.id());
            assert_ne!(unsafe { AssignProcessToJobObject(engine_job.0, peer.0) }, 0);
            let candidate = detect(&profile).unwrap().unwrap();
            // Reproduce the previous failure with a non-empty disjoint Job.
            let rejected_job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            let root = open(candidate.pid);
            assert_ne!(unsafe { AssignProcessToJobObject(rejected_job, root.0) }, 0);
            assert_eq!(
                unsafe { AssignProcessToJobObject(rejected_job, engine.0) },
                0
            );
            assert_eq!(unsafe { GetLastError() }, ERROR_ACCESS_DENIED);
            unsafe {
                CloseHandle(rejected_job);
            }
            assert!(candidate
                .stop_verified_tree(&profile, || Err("fixture idle/auth guard refusal".into()))
                .is_err());
            for process in [&root, &engine, &grandchild, &peer] {
                assert_eq!(unsafe { WaitForSingleObject(process.0, 0) }, WAIT_TIMEOUT);
            }
            candidate.revalidate(&profile).unwrap();
            candidate.stop_verified_tree(&profile, || Ok(())).unwrap();
            for process in [&root, &engine, &grandchild] {
                assert_eq!(
                    unsafe { WaitForSingleObject(process.0, 5000) },
                    WAIT_OBJECT_0
                );
            }
            assert_eq!(unsafe { WaitForSingleObject(peer.0, 0) }, WAIT_TIMEOUT);
            assert!(server.0.try_wait().unwrap().is_some());
            assert!(unrelated.0.try_wait().unwrap().is_none());
        }
        #[test]
        fn full_python_arguments_reject_wrong_config_port_module_and_extra_flags() {
            let temp = tempfile::tempdir().unwrap();
            let image = std::env::current_exe().unwrap();
            let config = temp.path().join("strata.json");
            std::fs::write(&config, b"{\"port\":18339}").unwrap();
            let profile = ServiceProfile {
                id: "fixture".into(),
                name: "".into(),
                base_url: "http://127.0.0.1:18339".into(),
                install_dir: temp.path().to_string_lossy().into(),
                config_path: config.to_string_lossy().into(),
                python_path: image.to_string_lossy().into(),
                managed: true,
            };
            let argv = vec![
                image.to_string_lossy().into_owned(),
                "-u".into(),
                "-m".into(),
                "serve.server".into(),
                "--engine".into(),
                "strata".into(),
                "--config".into(),
                config.to_string_lossy().into_owned(),
                "--host".into(),
                "127.0.0.1".into(),
                "--port".into(),
                "18339".into(),
            ];
            assert!(validate_arguments(&profile, &image, &argv).is_ok());
            let parsed=arguments(&format!("\"{}\" -u -m serve.server --engine strata --config \"{}\" --host 127.0.0.1 --port 18339",image.display(),config.display())).unwrap();
            assert_eq!(parsed, argv);
            for (index, value) in [
                (3, "not_strata.server"),
                (7, "relative.json"),
                (9, "0.0.0.0"),
                (11, "18340"),
            ] {
                let mut wrong = argv.clone();
                wrong[index] = value.into();
                assert!(validate_arguments(&profile, &image, &wrong).is_err());
            }
            let mut extra = argv.clone();
            extra.extend(["--port".into(), "18339".into()]);
            assert!(validate_arguments(&profile, &image, &extra).is_err());
            let mut extra = argv;
            extra.extend(["--api-key".into(), "never-print-this".into()]);
            assert!(validate_arguments(&profile, &image, &extra).is_err());
            let mut remote = profile;
            remote.base_url = "http://example.com:18339".into();
            assert!(local_port(&remote).is_err());
        }
        #[test]
        fn real_windows_venv_chain_matches_and_rejects_wrong_home_argv_and_image() {
            let python = crate::output("py", &["-c", "import sys; print(sys.executable)"]).unwrap();
            let temp = tempfile::tempdir().unwrap();
            let venv = temp.path().join(".venv");
            let mut create = Command::new(&python);
            create.args(["-m", "venv", "--without-pip"]).arg(&venv);
            crate::processes::hidden(&mut create);
            assert!(create.status().unwrap().success());
            let selected = venv.join("Scripts/python.exe");
            let cfg_path = venv.join("pyvenv.cfg");
            let original_cfg = std::fs::read_to_string(&cfg_path).unwrap();
            std::fs::create_dir(temp.path().join("serve")).unwrap();
            let config = temp.path().join("strata.json");
            std::fs::write(&config, b"{}").unwrap();
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);
            std::fs::write(
                temp.path().join("serve/server.py"),
                br#"import socket,sys,time,pathlib,os
port=int(sys.argv[sys.argv.index('--port')+1])
def bind():
    s=socket.socket();s.bind(('127.0.0.1',port));s.listen();return s
s=bind()
pathlib.Path('child.pid').write_text(str(os.getpid()))
pathlib.Path('ready').write_text('ready')
deadline=time.monotonic()+180
while time.monotonic()<deadline:
    if pathlib.Path('release').exists():
        pathlib.Path('release').unlink();s.close();pathlib.Path('released').write_text('ready')
        while not pathlib.Path('rebind').exists() and time.monotonic()<deadline: time.sleep(0.01)
        s=bind();pathlib.Path('rebound').write_text('ready')
    time.sleep(0.01)
"#,
            )
            .unwrap();
            let mut command = Command::new(&selected);
            command
                .current_dir(temp.path())
                .args(["-u", "-m", "serve.server", "--engine", "strata", "--config"])
                .arg(&config)
                .args(["--host", "127.0.0.1", "--port", &port.to_string()]);
            crate::processes::hidden(&mut command);
            let mut launcher = Fixture(command.spawn().unwrap());
            wait_for(&temp.path().join("ready"));
            let child_pid: u32 = std::fs::read_to_string(temp.path().join("child.pid"))
                .unwrap()
                .parse()
                .unwrap();
            // Keep a test-owned child guard even if validation fails midway.
            struct Cleanup(HANDLE);
            impl Drop for Cleanup {
                fn drop(&mut self) {
                    unsafe {
                        if WaitForSingleObject(self.0, 0) == WAIT_TIMEOUT {
                            TerminateProcess(self.0, 1);
                        }
                        CloseHandle(self.0);
                    }
                }
            }
            let handle =
                unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, child_pid) };
            assert!(!handle.is_null());
            let _cleanup = Cleanup(handle);
            let profile = ServiceProfile {
                id: "venv-fixture".into(),
                name: "".into(),
                base_url: format!("http://127.0.0.1:{port}"),
                install_dir: temp.path().to_string_lossy().into(),
                config_path: config.to_string_lossy().into(),
                python_path: selected.to_string_lossy().into(),
                managed: true,
            };
            let mut candidate = detect(&profile).unwrap().unwrap();
            assert_eq!(candidate.pid, child_pid);
            assert_ne!(child_pid, launcher.0.id());
            assert!(same_path(&candidate.image, Path::new(&python)));
            assert_eq!(candidate.launcher.as_ref().unwrap().pid, launcher.0.id());
            assert!(port_accepting(&profile).unwrap());
            let mut unknown = profile.clone();
            unknown.config_path = temp.path().join("unknown.json").to_string_lossy().into();
            assert!(detect(&unknown).is_err());
            assert!(port_accepting(&unknown).unwrap());
            candidate.revalidate(&profile).unwrap();
            let saved_command = candidate.command.clone();
            candidate.command.push_str(" --no-open-browser");
            assert!(validate_chain(&profile, &candidate, candidate.launcher.as_deref()).is_err());
            candidate.command = saved_command;
            let mut wrong_argv = arguments(&candidate.command).unwrap();
            wrong_argv[0] = selected.to_string_lossy().into();
            assert!(validate_arguments(&profile, &candidate.image, &wrong_argv).is_ok());
            wrong_argv[0] = std::env::current_exe().unwrap().to_string_lossy().into();
            assert!(validate_arguments(&profile, &candidate.image, &wrong_argv).is_err());
            let saved_image = candidate.image.clone();
            candidate.image = std::env::current_exe().unwrap();
            assert!(validate_chain(&profile, &candidate, candidate.launcher.as_deref()).is_err());
            candidate.image = saved_image;
            let saved_parent_created = candidate.launcher.as_ref().unwrap().created;
            candidate.launcher.as_mut().unwrap().created = candidate.created;
            assert!(candidate.revalidate(&profile).is_err());
            candidate.launcher.as_mut().unwrap().created = saved_parent_created;
            std::fs::write(&cfg_path, format!("home = {}\n", temp.path().display())).unwrap();
            assert!(candidate.revalidate(&profile).is_err());
            std::fs::write(
                &cfg_path,
                format!("{original_cfg}\nbase-executable = {}\n", selected.display()),
            )
            .unwrap();
            assert!(candidate.revalidate(&profile).is_err());
            std::fs::write(&cfg_path, &original_cfg).unwrap();
            assert!(launcher.0.try_wait().unwrap().is_none());
            std::fs::write(temp.path().join("release"), b"release").unwrap();
            wait_for(&temp.path().join("released"));
            let replacement =
                std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).unwrap();
            assert!(candidate.revalidate(&profile).is_err());
            let mut callback_ran = false;
            assert!(candidate
                .stop_verified_tree(&profile, || {
                    callback_ran = true;
                    Ok(())
                })
                .is_err());
            assert!(
                !callback_ran,
                "must refuse before any HTTP unload or process termination"
            );
            assert!(launcher.0.try_wait().unwrap().is_none());
            assert_eq!(unsafe { WaitForSingleObject(handle, 0) }, WAIT_TIMEOUT);
            assert_eq!(replacement.local_addr().unwrap().port(), port);
            drop(replacement);
            std::fs::write(temp.path().join("rebind"), b"rebind").unwrap();
            wait_for(&temp.path().join("rebound"));
            candidate.stop_verified_tree(&profile, || Ok(())).unwrap();
            launcher.0.wait().unwrap();
            assert!(!port_accepting(&profile).unwrap());
        }
        #[test]
        fn external_fixture_failed_verification_stays_alive_and_verified_tree_stops_only_itself() {
            let python = crate::output("py", &["-c", "import sys; print(sys.executable)"])
                .expect("Python launcher is required for the isolated fixture");
            let temp = tempfile::tempdir().unwrap();
            std::fs::create_dir(temp.path().join("serve")).unwrap();
            let config = temp.path().join("strata.json");
            std::fs::write(&config, b"{}").unwrap();
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);
            std::fs::write(temp.path().join("serve/server.py"),b"import socket,subprocess,sys,time,pathlib\ns=socket.socket();s.bind(('127.0.0.1',int(sys.argv[sys.argv.index('--port')+1])));s.listen()\nc=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],creationflags=0x08000000)\npathlib.Path('child.pid').write_text(str(c.pid))\npathlib.Path('ready').write_text('ready')\ntime.sleep(60)\n").unwrap();
            let mut command = Command::new(&python);
            command
                .current_dir(temp.path())
                .args(["-u", "-m", "serve.server", "--engine", "strata", "--config"])
                .arg(&config)
                .args(["--host", "127.0.0.1", "--port", &port.to_string()]);
            crate::processes::hidden(&mut command);
            let mut server = Fixture(command.spawn().unwrap());
            wait_for(&temp.path().join("ready"));
            let child_pid: u32 = std::fs::read_to_string(temp.path().join("child.pid"))
                .unwrap()
                .parse()
                .unwrap();
            let child_handle = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE,
                    0,
                    child_pid,
                )
            };
            assert!(!child_handle.is_null());
            struct ChildHandle(HANDLE);
            impl Drop for ChildHandle {
                fn drop(&mut self) {
                    unsafe {
                        if WaitForSingleObject(self.0, 0) == WAIT_TIMEOUT {
                            TerminateProcess(self.0, 1);
                        }
                        CloseHandle(self.0);
                    }
                }
            }
            let _child_cleanup = ChildHandle(child_handle);
            let mut unrelated = Command::new(&python);
            unrelated.args(["-c", "import time; time.sleep(60)"]);
            crate::processes::hidden(&mut unrelated);
            let mut unrelated = Fixture(unrelated.spawn().unwrap());
            let profile = ServiceProfile {
                id: "external-fixture".into(),
                name: "fixture".into(),
                base_url: format!("http://127.0.0.1:{port}"),
                install_dir: temp.path().to_string_lossy().into(),
                config_path: config.to_string_lossy().into(),
                python_path: python,
                managed: true,
            };
            let mut candidate = detect(&profile).unwrap().unwrap();
            assert_eq!(candidate.pid, server.0.id());
            assert!(candidate.created > 0);
            candidate.created += 1;
            assert!(candidate.revalidate(&profile).is_err());
            candidate.created -= 1;
            assert!(candidate
                .stop_verified_tree(&profile, || Err("fixture busy/auth refusal".into()))
                .is_err());
            assert!(server.0.try_wait().unwrap().is_none());
            assert_eq!(
                unsafe { WaitForSingleObject(child_handle, 0) },
                WAIT_TIMEOUT
            );
            let mut changed = profile.clone();
            changed.config_path = temp.path().join("missing.json").to_string_lossy().into();
            assert!(candidate.revalidate(&changed).is_err());
            candidate.stop_verified_tree(&profile, || Ok(())).unwrap();
            assert!(server.0.try_wait().unwrap().is_some());
            assert_eq!(
                unsafe { WaitForSingleObject(child_handle, 3000) },
                WAIT_OBJECT_0
            );
            assert!(unrelated.0.try_wait().unwrap().is_none());
            assert!(candidate.revalidate(&profile).is_err());
        }
    }
}
#[cfg(windows)]
pub use platform::*;
#[cfg(not(windows))]
pub struct VerifiedExternal {
    pub pid: u32,
    pub created: u64,
}
#[cfg(not(windows))]
pub fn detect(profile: &ServiceProfile) -> Result<Option<VerifiedExternal>, String> {
    if !port_accepting(profile)? {
        return Ok(None);
    }
    Err("此平台尚不支持外部服务身份核验与接管；已占用端口保持原状".into())
}
#[cfg(not(windows))]
impl VerifiedExternal {
    pub fn revalidate(&self, _profile: &ServiceProfile) -> Result<(), String> {
        Err("不支持此平台接管".into())
    }
    pub fn stop_verified_tree(
        &self,
        _profile: &ServiceProfile,
        _before_stop: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        Err("不支持此平台接管".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn takeover_rejects_missing_busy_and_parallel_state() {
        let idle = serde_json::json!({"service":"strata","activity":{"in_flight":0}});
        let metrics = serde_json::json!({"live":{"state":"idle","queued":0}});
        assert!(ensure_idle(&idle, &metrics).is_ok());
        for status in [
            serde_json::json!({}),
            serde_json::json!({"service":"strata","activity":{"in_flight":1}}),
        ] {
            assert!(ensure_idle(&status, &metrics).is_err());
        }
        for live in [
            serde_json::json!({"state":"generating","queued":0}),
            serde_json::json!({"state":"idle","queued":1}),
            serde_json::json!({"state":"idle","queued":0,"running":1}),
            serde_json::json!({"state":"idle","queued":0,"waiting":1}),
        ] {
            assert!(ensure_idle(&idle, &serde_json::json!({"live":live})).is_err());
        }
    }
}
