//! Application-owned source/Python preparation, with no Git or model download.
//! Upstream setup.py remains responsible for engine packages and model weights.
use crate::{
    processes::{self, Logs, OwnedProcess, TaskRecord},
    types::{now, ServiceProfile, TaskStatus},
    RuntimeState,
};
mod download;
pub mod local_archive;
pub use local_archive::LocalRuntimeArchives;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

// The reviewed upstream revision also determines observer compatibility.
pub const SOURCE_REVISION: &str = "fb58e0dbc8399662c0e47c76578c6e878b14f6cf";
pub const SOURCE_URL: &str =
    "https://codeload.github.com/Niko1221/Strata/zip/fb58e0dbc8399662c0e47c76578c6e878b14f6cf";
// Downloaded from the exact HTTPS URL and independently hashed on 2026-10-10.
pub const SOURCE_SHA256: &str = "b6b559866cf7d422d7acace638d542049ea7e3543720f574cb97b2d0bd530d7b";
#[cfg(windows)]
const PYTHON_VERSION: &str = "3.13.16";
#[cfg(windows)]
const PYTHON_URL: &str = "https://www.python.org/ftp/python/3.13.16/python-3.13.16-amd64.exe";
// Python.org's .exe.sigstore messageSignature.messageDigest (SHA2_256).
#[cfg(windows)]
const PYTHON_SHA256: &str = "fb4f9f5d438b2396da0086dc70b935c530cb578e37adc6d354f7ad2037fee83b";
const RESULT_KEY: &str = "automaticRuntimeInstallation";
const MARKER: &str = ".strata-manager-runtime.json";
const MAX_ARCHIVE: u64 = 128 * 1024 * 1024;
const MAX_EXPANDED: u64 = 512 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedRuntime {
    pub installation_id: String,
    pub source_revision: String,
    pub install_dir: String,
    pub python_path: String,
    pub prepared_at: u64,
    pub profile: ServiceProfile,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<PreparedRuntime>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub detected_runtimes: Vec<crate::discovery::DetectedRuntime>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Claim {
    token: String,
    destination: PathBuf,
    revision: String,
    installation_id: String,
    source_ready: bool,
    venv_claimed: bool,
    ready: bool,
    #[serde(default)]
    critical_hashes: HashMap<String, String>,
    result: Option<PreparedRuntime>,
}

pub fn status(state: &RuntimeState) -> Result<InstallationStatus, String> {
    let value = crate::store_get(state, RESULT_KEY.into())?;
    let mut status: InstallationStatus = if value.is_null() {
        InstallationStatus::default()
    } else {
        serde_json::from_value(value).map_err(|e| e.to_string())?
    };
    // Installation polling should not start another Python/process probe every
    // 1.5 seconds. Cache only read-only discovery, never installation results.
    type DiscoveryCache = HashMap<PathBuf, (Instant, Vec<crate::discovery::DetectedRuntime>)>;
    static CACHE: std::sync::OnceLock<Mutex<DiscoveryCache>> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = state.data_dir().to_owned();
    let cached = cache
        .lock()
        .map_err(|e| e.to_string())?
        .get(&key)
        .filter(|(at, _)| at.elapsed() < Duration::from_secs(10))
        .map(|(_, runtimes)| runtimes.clone());
    if let Some(runtimes) = cached {
        status.detected_runtimes = runtimes;
    } else {
        status.detected_runtimes = crate::discovery::discover_runtimes_for_state(
            &state.registered_profiles()?,
            state.data_dir(),
        );
        let mut cache = cache.lock().map_err(|e| e.to_string())?;
        if cache.len() >= 32 {
            cache.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(10));
        }
        cache.insert(key, (Instant::now(), status.detected_runtimes.clone()));
    }
    Ok(status)
}

/// The RPC returns immediately; cancellation uses the existing persisted task flag.
/// `archives` lets first-run setup use already-downloaded files instead of downloading.
pub fn start(
    state: Arc<RuntimeState>,
    archives: LocalRuntimeArchives,
) -> Result<TaskStatus, String> {
    let archives = archives.validate()?;
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        crate::runtime_upgrade::start_install_release_with_archives(state, archives)
    }
    #[cfg(not(all(windows, target_arch = "x86_64")))]
    {
        start_fallback_with_archives(
            state,
            archives.strata_archive_path,
            archives.engine_archive_path,
        )
    }
}

/// Fixed-source preparation remains available for unsupported package platforms
/// and explicit fallback workflows. Windows normally installs the latest Release.
pub fn start_fallback(state: Arc<RuntimeState>) -> Result<TaskStatus, String> {
    start_fallback_with_archives(state, None, None)
}

/// `local_source` replaces the fixed source download with the user's copy of the
/// same archive; it must match the same SHA256.
pub fn start_fallback_with_archive(
    state: Arc<RuntimeState>,
    local_source: Option<String>,
) -> Result<TaskStatus, String> {
    start_fallback_with_archives(state, local_source, None)
}

/// Like [`start_fallback_with_archive`], with an optional local Metal engine `.tar.gz` on Mac.
pub fn start_fallback_with_archives(
    state: Arc<RuntimeState>,
    local_source: Option<String>,
    local_engine: Option<String>,
) -> Result<TaskStatus, String> {
    let _operation = state.runtime_operations.lock().map_err(|e| e.to_string())?;
    crate::runtime_upgrade::assert_available(&state)?;
    let runtime = owned_directory(state.data_dir(), &["runtimes"])?
        .join(format!("strata-{}", &SOURCE_REVISION[..12]));
    let id = uuid::Uuid::new_v4().to_string();
    let task = TaskStatus {
        id: id.clone(),
        kind: "install-runtime".into(),
        state: "running".into(),
        message: "正在检测 Python 和准备官方 Strata；无需 Git".into(),
        started_at: now(),
        finished_at: None,
    };
    {
        let mut tasks = state.tasks.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = tasks.values().find(|record| {
            record.status.state == "running" && record.runtime_path.as_ref() == Some(&runtime)
        }) {
            return Ok(existing.status.clone());
        }
        processes::admit_task_logs(&mut tasks, &state.logs, &id)?;
        tasks.insert(
            id.clone(),
            TaskRecord {
                status: task.clone(),
                profile_id: None,
                runtime_path: Some(runtime.clone()),
                cancelled: false,
                process: None,
            },
        );
        if let Err(error) =
            processes::persist_task(&state.database, tasks.get(&id).ok_or("安装任务不存在")?)
        {
            processes::abandon_unstarted_task(
                &state.database,
                &mut tasks,
                &state.logs,
                &id,
                &error,
            );
            return Err(error);
        }
    }
    if let Err(error) = crate::store_set(
        &state,
        RESULT_KEY.into(),
        serde_json::to_value(InstallationStatus {
            task_id: Some(id.clone()),
            result: None,
            detected_runtimes: Vec::new(),
        })
        .map_err(|e| e.to_string())?,
    ) {
        let mut tasks = state.tasks.lock().map_err(|e| e.to_string())?;
        processes::abandon_unstarted_task(&state.database, &mut tasks, &state.logs, &id, &error);
        return Err(error);
    }
    drop(_operation);
    tokio::spawn(async move {
        let outcome = prepare_with_archives(&state, &id, &runtime, local_source.as_deref(), local_engine.as_deref()).await;
        if let Ok(mut tasks) = state.tasks.lock() {
            if let Some(record) = tasks.get_mut(&id) {
                record.process.take();
                record.status.finished_at = Some(now());
                let (result, message) = match outcome {
                    Ok(result) if !record.cancelled => {
                        record.status.state = "completed".into();
                        (
                            Some(result),
                            "Strata 源码与私有 Python 环境已就绪；下一步准备模型".to_owned(),
                        )
                    }
                    Ok(_) => {
                        record.status.state = "cancelled".into();
                        (None, "准备任务已取消；已校验的文件保留以供重试".to_owned())
                    }
                    Err(error) => {
                        record.status.state = if record.cancelled {
                            "cancelled"
                        } else {
                            "failed"
                        }
                        .into();
                        (None, error)
                    }
                };
                record.status.message = message.clone();
                processes::log(&state.logs, &id, &record.status.state, message);
                let saved = serde_json::to_value(InstallationStatus {
                    task_id: Some(id.clone()),
                    result,
                    detected_runtimes: Vec::new(),
                });
                if let Err(error) = saved
                    .map_err(|e| e.to_string())
                    .and_then(|v| crate::store_set(&state, RESULT_KEY.into(), v))
                {
                    record.status.state = "failed".into();
                    record.status.message = format!("准备结果保存失败，请重试: {error}");
                }
                let _ = processes::persist_task(&state.database, record);
                let _ = processes::persist_task_logs(&state.database, &state.logs, &id);
            }
        }
    });
    Ok(task)
}

fn cancelled(state: &RuntimeState, id: &str) -> Result<(), String> {
    let tasks = state.tasks.lock().map_err(|e| e.to_string())?;
    if tasks.get(id).is_none_or(|record| record.cancelled) {
        return Err("准备任务已取消；受管下载文件保留以供重试".into());
    }
    Ok(())
}
fn progress(state: &RuntimeState, id: &str, message: impl Into<String>) -> Result<(), String> {
    cancelled(state, id)?;
    let message = message.into();
    processes::log(&state.logs, id, "info", &message);
    let mut tasks = state.tasks.lock().map_err(|e| e.to_string())?;
    let record = tasks.get_mut(id).ok_or("安装任务不存在")?;
    record.status.message = message;
    processes::persist_task(&state.database, record)?;
    processes::persist_task_logs(&state.database, &state.logs, id)
}

fn reject_installer_link(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let reparse = false;
    reject_installer_link_kind(metadata.file_type().is_symlink(), reparse)
}

fn reject_installer_link_kind(symbolic: bool, reparse: bool) -> Result<(), String> {
    if symbolic || reparse {
        return Err("安装路径被重定向，已拒绝写入".into());
    }
    Ok(())
}

fn reject_installer_path_links(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        reject_installer_link(ancestor)?;
    }
    Ok(())
}

/// A packaged process may see the Roaming directory in its original location,
/// but open the existing database in its package's LocalCache. Only that exact
/// OS-confirmed mapping is allowed; an arbitrary redirected database is refused.
fn select_installer_root(
    data_root: &Path,
    database_root: &Path,
    package_root: Option<&Path>,
) -> Result<PathBuf, String> {
    if database_root == data_root || package_root.is_some_and(|root| root == database_root) {
        Ok(database_root.to_path_buf())
    } else {
        Err("安装路径被重定向，已拒绝写入".into())
    }
}

/// An exited launcher cannot supply its package identity. In that case only a
/// database path returned by the OS file handle may identify the effective
/// AppData mapping, and Windows must also confirm that package for this user.
/// A directory spelling by itself never authorizes an installer root.
#[cfg(windows)]
fn registered_installer_package_root(
    data_root: &Path,
    database: &Path,
    roaming: &Path,
    local: &Path,
    registered: impl FnOnce(&str) -> Result<bool, String>,
) -> Result<PathBuf, String> {
    let invalid_mapping = || "实际数据库不符合系统应用包映射，已拒绝安装写入".to_owned();
    let relative = data_root
        .strip_prefix(roaming)
        .ok()
        .filter(|relative| !relative.as_os_str().is_empty())
        .ok_or_else(invalid_mapping)?;
    if database.file_name().and_then(|name| name.to_str()) != Some("strata-manager.sqlite3") {
        return Err(invalid_mapping());
    }
    let database_root = database.parent().ok_or_else(invalid_mapping)?;
    let package_relative = database_root
        .strip_prefix(local.join("Packages"))
        .map_err(|_| invalid_mapping())?;
    let family = package_relative
        .components()
        .next()
        .and_then(|component| match component {
            std::path::Component::Normal(name) => name.to_str(),
            _ => None,
        })
        .filter(|family| {
            !family.is_empty()
                && family
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        })
        .ok_or_else(invalid_mapping)?;
    let mapped = local
        .join("Packages")
        .join(family)
        .join("LocalCache")
        .join("Roaming")
        .join(relative);
    if mapped != database_root {
        return Err(invalid_mapping());
    }
    if !registered(family)? {
        return Err("实际数据库所在应用包未在当前用户注册，已拒绝安装写入".into());
    }
    Ok(mapped)
}

/// Resolve the existing database using a read-only file handle. Inherited MSIX
/// virtualization can redirect a file while leaving its parent directory at
/// the original spelling; the handle reports the file actually opened.
fn installer_database_path(database: &Path) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        use std::{os::windows::ffi::OsStringExt, os::windows::io::AsRawHandle, ptr};
        use windows_sys::Win32::Foundation::HANDLE;
        #[link(name = "kernel32")]
        extern "system" {
            fn GetFinalPathNameByHandleW(
                file: HANDLE,
                path: *mut u16,
                length: u32,
                flags: u32,
            ) -> u32;
        }
        let file = File::open(database).map_err(|e| format!("无法只读核验安装数据库: {e}"))?;
        if !file.metadata().map_err(|e| e.to_string())?.is_file() {
            return Err("安装数据库不是普通文件，已拒绝安装写入".into());
        }
        let handle = file.as_raw_handle() as HANDLE;
        let length = unsafe { GetFinalPathNameByHandleW(handle, ptr::null_mut(), 0, 0) };
        if !(2..=32768).contains(&length) {
            return Err(format!(
                "无法核验安装数据库实际路径: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut buffer = vec![0u16; length as usize];
        let written = unsafe { GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), length, 0) };
        if written == 0 || written >= length {
            return Err(format!(
                "无法核验安装数据库实际路径: {}",
                std::io::Error::last_os_error()
            ));
        }
        let path = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..written as usize]));
        Ok(dunce::simplified(&path).to_path_buf())
    }
    #[cfg(not(windows))]
    {
        dunce::canonicalize(database).map_err(|e| e.to_string())
    }
}

#[cfg(windows)]
fn installer_package_registered(family: &str) -> Result<bool, String> {
    use std::ptr;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetPackagesByPackageFamily(
            family: *const u16,
            count: *mut u32,
            names: *mut *mut u16,
            buffer_length: *mut u32,
            buffer: *mut u16,
        ) -> u32;
    }
    let family: Vec<u16> = family.encode_utf16().chain(Some(0)).collect();
    let mut count = 0;
    let mut length = 0;
    let result = unsafe {
        GetPackagesByPackageFamily(
            family.as_ptr(),
            &mut count,
            ptr::null_mut(),
            &mut length,
            ptr::null_mut(),
        )
    };
    if result == 0 && count == 0 {
        return Ok(false);
    }
    if result != 122 || !(1..=1024).contains(&count) || !(2..=1_048_576).contains(&length) {
        return Err(format!(
            "无法核验数据库应用包注册信息（Windows 错误 {result}），已拒绝安装写入"
        ));
    }
    let mut names = vec![ptr::null_mut(); count as usize];
    let mut buffer = vec![0u16; length as usize];
    let result = unsafe {
        GetPackagesByPackageFamily(
            family.as_ptr(),
            &mut count,
            names.as_mut_ptr(),
            &mut length,
            buffer.as_mut_ptr(),
        )
    };
    if result != 0 || count as usize > names.len() || length as usize > buffer.len() {
        return Err(format!(
            "无法核验数据库应用包注册信息（Windows 错误 {result}），已拒绝安装写入"
        ));
    }
    Ok(count > 0)
}

#[cfg(windows)]
fn valid_installer_parent_time(parent: u64, child: u64) -> bool {
    parent <= child
}

#[cfg(windows)]
static INSTALLER_PACKAGE_FAMILY: std::sync::OnceLock<Result<Option<String>, String>> =
    std::sync::OnceLock::new();

#[cfg(windows)]
fn installer_package_family_once(
    cache: &std::sync::OnceLock<Result<Option<String>, String>>,
    capture: impl FnOnce() -> Result<Option<String>, String>,
) -> Result<Option<&str>, String> {
    cache
        .get_or_init(capture)
        .as_ref()
        .map(|family| family.as_deref())
        .map_err(Clone::clone)
}

/// Capture the OS-confirmed package context while the launching process is
/// still alive. Call before publishing the supervisor's IPC listener; failure
/// grants no package identity. Redirected roots then require independent OS
/// evidence from the database handle, exact mapping and package registration.
pub fn initialize_installer_package_identity() -> Result<(), String> {
    #[cfg(windows)]
    installer_package_family_once(&INSTALLER_PACKAGE_FAMILY, capture_installer_package_family)?;
    Ok(())
}

#[cfg(windows)]
fn capture_installer_package_family() -> Result<Option<String>, String> {
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                GetCurrentProcess, GetCurrentProcessId, GetProcessTimes, OpenProcess,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
    };
    // Keep the package query local to this helper without changing the IPC or
    // runtime state's data-directory identity.
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentPackageFamilyName(length: *mut u32, name: *mut u16) -> u32;
        fn GetPackageFamilyName(process: HANDLE, length: *mut u32, name: *mut u16) -> u32;
    }
    fn family_name(
        mut query: impl FnMut(*mut u32, *mut u16) -> u32,
    ) -> Result<Option<String>, String> {
        let mut length = 0;
        let result = query(&mut length, ptr::null_mut());
        if result == 15700 {
            // APPMODEL_ERROR_NO_PACKAGE
            return Ok(None);
        }
        if result != 122 || !(2..=16384).contains(&length) {
            // ERROR_INSUFFICIENT_BUFFER
            return Err("无法核验当前应用包身份，已拒绝安装写入".into());
        }
        let mut buffer = vec![0u16; length as usize];
        if query(&mut length, buffer.as_mut_ptr()) != 0 || length as usize > buffer.len() {
            return Err("无法核验当前应用包身份，已拒绝安装写入".into());
        }
        let family = String::from_utf16(&buffer[..length.saturating_sub(1) as usize])
            .map_err(|_| "当前应用包身份无效")?;
        if family.is_empty()
            || !family
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        {
            return Err("当前应用包身份无效，已拒绝安装写入".into());
        }
        Ok(Some(family))
    }
    fn process_created(process: HANDLE) -> Result<u64, String> {
        let mut created: FILETIME = unsafe { std::mem::zeroed() };
        let mut exited: FILETIME = unsafe { std::mem::zeroed() };
        let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
        let mut user: FILETIME = unsafe { std::mem::zeroed() };
        if unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) }
            == 0
        {
            return Err("无法核验应用进程创建时间，已拒绝安装写入".into());
        }
        Ok(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
    }
    fn inherited_family() -> Result<Option<String>, String> {
        if let Some(family) =
            family_name(|length, name| unsafe { GetCurrentPackageFamilyName(length, name) })?
        {
            return Ok(Some(family));
        }
        // Desktop Bridge descendants can inherit file virtualization without
        // receiving an AppModel identity. Follow only the OS-recorded parent
        // chain, bounded in time/depth, and reject reused parent process IDs.
        let deadline = Instant::now() + Duration::from_secs(2);
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err("无法核验应用父进程，已拒绝安装写入".into());
        }
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut parents = HashMap::new();
        let mut available = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
        while available && Instant::now() < deadline {
            parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
            available = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
        }
        unsafe { CloseHandle(snapshot) };
        let mut child = unsafe { GetCurrentProcessId() };
        let mut child_created = process_created(unsafe { GetCurrentProcess() })?;
        let mut visited = HashSet::new();
        for _ in 0..16 {
            if Instant::now() >= deadline {
                return Err("核验应用包身份超时，已拒绝安装写入".into());
            }
            let Some(&parent) = parents.get(&child) else {
                return Ok(None);
            };
            if parent == 0 {
                return Ok(None);
            }
            if !visited.insert(parent) {
                return Err("应用父进程清单无效，已拒绝安装写入".into());
            }
            let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, parent) };
            if process.is_null() {
                return Err("无法核验应用父进程，已拒绝安装写入".into());
            }
            let result: Result<(u64, Option<String>), String> = (|| {
                let created = process_created(process)?;
                if !valid_installer_parent_time(created, child_created) {
                    return Err("应用父进程已被替换，已拒绝安装写入".into());
                }
                Ok((
                    created,
                    family_name(|length, name| unsafe {
                        GetPackageFamilyName(process, length, name)
                    })?,
                ))
            })();
            unsafe { CloseHandle(process) };
            let (created, family) = result?;
            if family.is_some() {
                return Ok(family);
            }
            child = parent;
            child_created = created;
        }
        Err("应用父进程层级超出上限，已拒绝安装写入".into())
    }
    inherited_family()
}

#[cfg(windows)]
fn current_package_roaming_root(
    data_root: &Path,
    database: &Path,
) -> Result<Option<PathBuf>, String> {
    use std::{ffi::c_void, os::windows::ffi::OsStringExt, ptr};
    use windows_sys::Win32::UI::Shell::{
        FOLDERID_LocalAppData, FOLDERID_RoamingAppData, SHGetKnownFolderPath,
        KF_FLAG_NO_PACKAGE_REDIRECTION,
    };
    #[link(name = "ole32")]
    extern "system" {
        fn CoTaskMemFree(memory: *const c_void);
    }
    fn known_folder(id: &windows_sys::core::GUID) -> Result<PathBuf, String> {
        let mut value = ptr::null_mut();
        let result = unsafe {
            SHGetKnownFolderPath(
                id,
                KF_FLAG_NO_PACKAGE_REDIRECTION as u32,
                ptr::null_mut(),
                &mut value,
            )
        };
        if result < 0 || value.is_null() {
            if !value.is_null() {
                unsafe { CoTaskMemFree(value.cast()) };
            }
            return Err("无法核验系统应用数据目录，已拒绝安装写入".into());
        }
        let mut length = 0;
        while length < 32768 && unsafe { *value.add(length) } != 0 {
            length += 1;
        }
        let path = (length < 32768).then(|| {
            PathBuf::from(std::ffi::OsString::from_wide(unsafe {
                std::slice::from_raw_parts(value, length)
            }))
        });
        unsafe { CoTaskMemFree(value.cast()) };
        path.ok_or_else(|| "系统应用数据目录无效，已拒绝安装写入".into())
    }
    let roaming = known_folder(&FOLDERID_RoamingAppData)?;
    reject_installer_path_links(&roaming)?;
    let roaming = dunce::canonicalize(roaming).map_err(|e| e.to_string())?;
    let Ok(relative) = data_root.strip_prefix(&roaming) else {
        return Ok(None);
    };
    if relative.as_os_str().is_empty() {
        return Ok(None);
    }
    let local = known_folder(&FOLDERID_LocalAppData)?;
    reject_installer_path_links(&local)?;
    let local = dunce::canonicalize(local).map_err(|e| e.to_string())?;
    let captured =
        installer_package_family_once(&INSTALLER_PACKAGE_FAMILY, capture_installer_package_family);
    let family = match captured {
        Ok(Some(family)) => family,
        // No trusted ancestor survives a short-lived shell launcher. The
        // database handle, exact mapping, registration and link checks provide
        // independent OS evidence without promoting a directory name to an
        // application identity or weakening normal root validation.
        Ok(None) | Err(_) => {
            return registered_installer_package_root(
                data_root,
                database,
                &roaming,
                &local,
                installer_package_registered,
            )
            .map(Some)
            .map_err(|mapping_error| match captured {
                Err(parent_error) => {
                    format!("{mapping_error}（启动应用包核验失败: {parent_error}）")
                }
                _ => mapping_error,
            });
        }
    };
    let mapped = local
        .join("Packages")
        .join(family)
        .join("LocalCache")
        .join("Roaming")
        .join(relative);
    reject_installer_path_links(&mapped)?;
    Ok(Some(
        dunce::canonicalize(mapped).map_err(|e| e.to_string())?,
    ))
}

fn installer_data_root(data: &Path) -> Result<PathBuf, String> {
    reject_installer_path_links(data)?;
    let root = dunce::canonicalize(data).map_err(|e| e.to_string())?;
    let database = data.join("strata-manager.sqlite3");
    reject_installer_link(&database)?;
    let database = installer_database_path(&database)?;
    reject_installer_path_links(&database)?;
    let database_root = database.parent().ok_or("安装数据库没有父目录")?;
    if database_root == root {
        return Ok(root);
    }
    #[cfg(windows)]
    let package_root = current_package_roaming_root(&root, &database)?;
    #[cfg(not(windows))]
    let package_root: Option<PathBuf> = None;
    select_installer_root(&root, database_root, package_root.as_deref())
}

/// Resolve the existing database's verified physical data root without writing.
/// Keep the caller's logical data-directory identity for IPC; inherited MSIX
/// virtualization can redirect files while leaving directory paths unchanged.
pub fn verified_data_root(data: &Path) -> Result<PathBuf, String> {
    installer_data_root(data)
}

/// Installer caches use the database's verified physical directory, never UI
/// input or the virtualized spelling of a newly created Roaming child.
pub(crate) fn owned_directory(data: &Path, components: &[&str]) -> Result<PathBuf, String> {
    let root = installer_data_root(data)?;
    let mut path = root.clone();
    for component in components {
        if component.is_empty() || component.contains(['/', '\\', ':']) || *component == ".." {
            return Err("内部安装路径无效".into());
        }
        path.push(component);
        if !path.exists() {
            fs::create_dir(&path).map_err(|e| e.to_string())?;
        }
        reject_installer_link(&path)?;
        let canonical = dunce::canonicalize(&path).map_err(|e| e.to_string())?;
        if !canonical.starts_with(&root)
            || !fs::metadata(&path).map_err(|e| e.to_string())?.is_dir()
        {
            return Err("安装路径被重定向，已拒绝写入".into());
        }
        path = canonical;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(path)
}

fn claim(state: &RuntimeState, destination: &Path, revision: &str) -> Result<Claim, String> {
    let mut database = state.database.lock().map_err(|e| e.to_string())?;
    database.execute_batch("CREATE TABLE IF NOT EXISTS automatic_runtime_claims(path TEXT PRIMARY KEY,token TEXT NOT NULL,revision TEXT NOT NULL);").map_err(|e| e.to_string())?;
    let recorded: Option<(String, String)> = database
        .query_row(
            "SELECT token,revision FROM automatic_runtime_claims WHERE path=?1",
            [destination.to_string_lossy().as_ref()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if destination.exists() {
        let metadata = fs::symlink_metadata(destination).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || dunce::canonicalize(destination).map_err(|e| e.to_string())? != destination
        {
            return Err("运行时目录被替换或重定向，拒绝修改".into());
        }
        let marker = destination.join(MARKER);
        if !marker.is_file()
            || marker.is_symlink()
            || fs::metadata(&marker).map_err(|e| e.to_string())?.len() > 16_384
        {
            return Err(
                "默认安装目录已存在但不属于本应用，保留原文件；请在本机检测中导入它".into(),
            );
        }
        let existing: Claim = serde_json::from_slice(&fs::read(marker).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        if existing.destination != destination
            || existing.revision != revision
            || recorded != Some((existing.token.clone(), revision.into()))
        {
            return Err("运行时目录归属校验失败，拒绝覆盖非本应用文件".into());
        }
        return Ok(existing);
    }
    fs::create_dir(destination).map_err(|e| e.to_string())?;
    let value = Claim {
        token: uuid::Uuid::new_v4().to_string(),
        destination: destination.into(),
        revision: revision.into(),
        installation_id: uuid::Uuid::new_v4().to_string(),
        source_ready: false,
        venv_claimed: false,
        ready: false,
        critical_hashes: HashMap::new(),
        result: None,
    };
    let transaction = database.transaction().map_err(|e| e.to_string())?;
    transaction
        .execute(
            "INSERT OR REPLACE INTO automatic_runtime_claims(path,token,revision) VALUES(?1,?2,?3)",
            rusqlite::params![destination.to_string_lossy(), value.token, revision],
        )
        .map_err(|e| e.to_string())?;
    let mut marker = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination.join(MARKER))
        .map_err(|e| e.to_string())?;
    marker
        .write_all(&serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    marker.sync_all().map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(value)
}
fn save_claim(value: &Claim) -> Result<(), String> {
    let marker = value.destination.join(MARKER);
    if marker.is_symlink() {
        return Err("运行时归属标记被重定向".into());
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(&value.destination).map_err(|e| e.to_string())?;
    temporary
        .write_all(&serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary.persist(marker).map_err(|e| e.to_string())?;
    Ok(())
}
pub(crate) fn file_hash(path: &Path) -> Result<String, String> {
    if path.is_symlink() {
        return Err("受管文件被重定向".into());
    }
    let mut reader = File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut bytes = [0u8; 65_536];
    loop {
        let count = reader.read(&mut bytes).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&bytes[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub(crate) async fn download(
    state: &RuntimeState,
    id: &str,
    url: &str,
    expected: &str,
    limit: u64,
) -> Result<PathBuf, String> {
    download_with_client(state, id, url, expected, limit, &state.download_client).await
}

/// Release assets redirect to GitHub's asset origin. Every destination stays HTTPS
/// and the archive still must match the application's fixed digest.
pub(crate) async fn download_release(
    state: &RuntimeState,
    id: &str,
    url: &str,
    expected: &str,
    limit: u64,
) -> Result<PathBuf, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("release redirect limit exceeded");
            }
            if attempt.url().scheme() == "https"
                && matches!(
                    attempt.url().host_str(),
                    Some(
                        "github.com"
                            | "release-assets.githubusercontent.com"
                            | "objects.githubusercontent.com"
                    )
                )
            {
                attempt.follow()
            } else {
                attempt.error("release redirect origin refused")
            }
        }))
        .build()
        .map_err(|e| e.to_string())?;
    download_with_client(state, id, url, expected, limit, &client).await
}

async fn download_with_client(
    state: &RuntimeState,
    id: &str,
    url: &str,
    expected: &str,
    limit: u64,
    client: &reqwest::Client,
) -> Result<PathBuf, String> {
    download::download_with_client(state, id, url, expected, limit, client).await
}

pub(crate) async fn download_using_client(
    state: &RuntimeState,
    id: &str,
    url: &str,
    expected: &str,
    limit: u64,
    client: &reqwest::Client,
) -> Result<PathBuf, String> {
    download_with_client(state, id, url, expected, limit, client).await
}

fn safe_entry(name: &str, prefix: &str) -> Result<Option<PathBuf>, String> {
    if name.contains(['\\', ':', '\0']) || name.starts_with('/') {
        return Err("压缩包含不安全路径".into());
    }
    let components: Vec<_> = name.trim_end_matches('/').split('/').collect();
    if components.first() != Some(&prefix) {
        return Err("源码压缩包根目录与固定 revision 不一致".into());
    }
    if components.len() == 1 {
        return Ok(None);
    }
    let mut relative = PathBuf::new();
    for component in &components[1..] {
        let reserved = component
            .split('.')
            .next()
            .unwrap_or("")
            .to_ascii_uppercase();
        if component.is_empty()
            || *component == "."
            || *component == ".."
            || component.ends_with([' ', '.'])
            || component.chars().any(char::is_control)
            || ["CON", "PRN", "AUX", "NUL"].contains(&reserved.as_str())
            || (reserved.len() == 4
                && (reserved.starts_with("COM") || reserved.starts_with("LPT"))
                && reserved.ends_with(['1', '2', '3', '4', '5', '6', '7', '8', '9']))
        {
            return Err("压缩包含跨平台不安全文件名".into());
        }
        relative.push(component);
    }
    if relative.to_string_lossy().len() > 240 {
        return Err("压缩包路径过长".into());
    }
    Ok(Some(relative))
}

/// Preflight every name/type/size before writing; never replace a differing file.
fn extract_source(
    archive: &Path,
    root: &Path,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<HashMap<String, String>, String> {
    let root = dunce::canonicalize(root).map_err(|e| e.to_string())?;
    let prefix = format!("Strata-{SOURCE_REVISION}");
    let mut zip = zip::ZipArchive::new(File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if zip.len() > 30_000 {
        return Err("压缩包文件数量超过上限".into());
    }
    let mut names = HashSet::new();
    let mut expanded = 0u64;
    for index in 0..zip.len() {
        check()?;
        let entry = zip.by_index(index).map_err(|e| e.to_string())?;
        let relative = safe_entry(entry.name(), &prefix)?;
        if entry
            .unix_mode()
            .is_some_and(|mode| !matches!(mode & 0o170000, 0 | 0o100000 | 0o040000))
        {
            return Err("压缩包链接或特殊文件被拒绝".into());
        }
        if let Some(relative) = relative {
            if !names.insert(relative.to_string_lossy().to_lowercase()) {
                return Err("压缩包含重名文件".into());
            }
        }
        expanded = expanded.checked_add(entry.size()).ok_or("解压体积无效")?;
        if expanded > MAX_EXPANDED || entry.size() > MAX_ARCHIVE {
            return Err("解压体积超过上限".into());
        }
    }
    let mut critical = HashMap::new();
    for index in 0..zip.len() {
        check()?;
        let mut entry = zip.by_index(index).map_err(|e| e.to_string())?;
        let Some(relative) = safe_entry(entry.name(), &prefix)? else {
            continue;
        };
        let destination = root.join(&relative);
        let parent = if entry.is_dir() {
            destination.as_path()
        } else {
            destination.parent().ok_or("文件父目录为空")?
        };
        let mut current = root.clone();
        for component in parent
            .strip_prefix(&root)
            .map_err(|e| e.to_string())?
            .components()
        {
            current.push(component);
            if !current.exists() {
                fs::create_dir(&current).map_err(|e| e.to_string())?;
            }
            if current.is_symlink()
                || !dunce::canonicalize(&current)
                    .map_err(|e| e.to_string())?
                    .starts_with(&root)
            {
                return Err("解包路径被重定向".into());
            }
        }
        if entry.is_dir() {
            continue;
        }
        let mut output = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 65_536];
        loop {
            check()?;
            let count = entry.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
            output
                .write_all(&buffer[..count])
                .map_err(|e| e.to_string())?;
        }
        let expected = format!("{:x}", digest.finalize());
        if destination.exists() {
            if file_hash(&destination)? != expected {
                return Err(format!(
                    "已存在文件与固定源码不同，保留原文件并拒绝覆盖: {}",
                    relative.display()
                ));
            }
        } else {
            output.as_file().sync_all().map_err(|e| e.to_string())?;
            output
                .persist_noclobber(&destination)
                .map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                // Retain only reviewed source executable bits, never privileged bits.
                let mode = if entry.unix_mode().is_some_and(|mode| mode & 0o111 != 0) {
                    0o700
                } else {
                    0o600
                };
                fs::set_permissions(&destination, fs::Permissions::from_mode(mode))
                    .map_err(|e| e.to_string())?;
            }
        }
        let name = relative.to_string_lossy().replace('\\', "/");
        if [
            "setup.py",
            "serve/server.py",
            "requirements.txt",
            "serve/runconfig.py",
        ]
        .contains(&name.as_str())
        {
            critical.insert(name, expected);
        }
    }
    if !critical.contains_key("setup.py") || !critical.contains_key("serve/server.py") {
        return Err("官方源码缺少 setup.py 或 serve/server.py".into());
    }
    Ok(critical)
}

fn python_probe(program: &Path, prefix: &[&str]) -> Option<String> {
    let logs: Logs = Default::default();
    let id = uuid::Uuid::new_v4().to_string();
    let mut command = Command::new(program);
    command.args(prefix).args(["-I","-S","-c","import sys,json,venv,ensurepip;assert sys.version_info>=(3,10) and sys.maxsize>2**32;print(json.dumps({'executable':sys.executable}))"]);
    let mut process = OwnedProcess::spawn(command, logs.clone(), &id).ok()?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let status = process.refresh().ok()?;
        if !status.running {
            if status.exit_code != Some(0) {
                return None;
            }
            for _ in 0..10 {
                if let Ok(entries) = logs.lock() {
                    if let Some(path) = entries.get(&id).into_iter().flatten().find_map(|entry| {
                        serde_json::from_str::<serde_json::Value>(&entry.message)
                            .ok()?
                            .get("executable")?
                            .as_str()
                            .map(str::to_owned)
                    }) {
                        return dunce::canonicalize(path)
                            .ok()
                            .map(|p| p.to_string_lossy().into_owned());
                    }
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            return None;
        }
        if Instant::now() >= deadline {
            let _ = process.stop();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
fn find_python(data_dir: &Path) -> Option<String> {
    #[cfg(not(windows))]
    let _ = data_dir;
    #[cfg(windows)]
    {
        let private = data_dir
            .join("toolchains")
            .join(format!("python-{PYTHON_VERSION}"))
            .join("python.exe");
        if private.is_file() {
            if let Some(path) = python_probe(&private, &[]) {
                return Some(path);
            }
        }
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    for directory in std::env::split_paths(&path) {
        #[cfg(windows)]
        if directory
            .to_string_lossy()
            .to_ascii_lowercase()
            .contains("microsoft\\windowsapps")
        {
            continue;
        }
        #[cfg(windows)]
        let candidates = [("py.exe", vec!["-3"]), ("python.exe", vec![])];
        #[cfg(not(windows))]
        let candidates = [("python3", vec![]), ("python", vec![])];
        for (name, args) in candidates {
            let candidate = directory.join(name);
            if candidate.is_file() {
                if let Some(path) = python_probe(&candidate, &args) {
                    return Some(path);
                }
            }
        }
    }
    #[cfg(windows)]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        for version in ["313", "312", "311", "310"] {
            let candidate = PathBuf::from(&local)
                .join("Programs/Python")
                .join(format!("Python{version}"))
                .join("python.exe");
            if candidate.is_file() {
                if let Some(path) = python_probe(&candidate, &[]) {
                    return Some(path);
                }
            }
        }
    }
    None
}

pub(crate) async fn run_owned(
    state: &RuntimeState,
    id: &str,
    mut command: Command,
    description: &str,
) -> Result<(), String> {
    progress(state, id, description)?;
    command.env("PYTHONUNBUFFERED", "1");
    {
        let mut tasks = state.tasks.lock().map_err(|e| e.to_string())?;
        let record = tasks.get_mut(id).ok_or("安装任务不存在")?;
        if record.cancelled {
            return Err("准备任务已取消".into());
        }
        record.process = Some(OwnedProcess::spawn_registered(
            command,
            state.logs.clone(),
            id,
        )?);
    }
    let deadline = Instant::now() + Duration::from_secs(600);
    let mut last_persist = Instant::now();
    loop {
        cancelled(state, id)?;
        tokio::time::sleep(Duration::from_millis(100)).await;
        let finished = {
            let mut tasks = state.tasks.lock().map_err(|e| e.to_string())?;
            let record = tasks.get_mut(id).ok_or("安装任务不存在")?;
            let process = record.process.as_mut().ok_or("安装进程不存在")?;
            let process_status = process.refresh()?;
            if !process_status.running {
                let pending = process.readers_pending.clone();
                record.process.take();
                Some((process_status.exit_code, pending))
            } else {
                if Instant::now() >= deadline {
                    process.stop()?;
                    return Err(format!("{description}超时，已停止本任务进程，可重试"));
                }
                None
            }
        };
        if let Some((exit_code, pending)) = finished {
            let drain_deadline = Instant::now() + Duration::from_millis(500);
            while pending.load(std::sync::atomic::Ordering::Acquire) > 0
                && Instant::now() < drain_deadline
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            processes::persist_task_logs(&state.database, &state.logs, id)?;
            if exit_code == Some(0) {
                return Ok(());
            }
            return Err(format!(
                "{description}失败，退出码 {:?}；查看日志后重试",
                exit_code
            ));
        }
        if last_persist.elapsed() >= Duration::from_secs(1) {
            processes::persist_task_logs(&state.database, &state.logs, id)?;
            last_persist = Instant::now();
        }
    }
}

pub(crate) async fn ensure_python(state: &RuntimeState, id: &str) -> Result<String, String> {
    progress(state, id, "正在检测 64 位 Python 3.10+、venv 与 ensurepip")?;
    if let Some(python) = find_python(state.data_dir()) {
        progress(state, id, "已找到可创建私有环境的本机 Python")?;
        return Ok(python);
    }
    #[cfg(not(windows))]
    {
        Err("本机缺少 64 位 Python 3.10+ 或 venv/ensurepip。本应用不会执行 sudo。Ubuntu/Debian 请由系统管理员安装 python3、python3-venv、python3-pip；Fedora 安装 python3、python3-pip；NixOS 需提供可运行 pip wheel 的 Python/uv 环境。安装后点击重试。".into())
    }
    #[cfg(windows)]
    {
        if std::env::consts::ARCH != "x86_64" {
            return Err(
                "自动 Python 安装目前支持 Windows x64；请提供 64 位 Python 3.10+ 后重试".into(),
            );
        }
        let root = owned_directory(state.data_dir(), &["toolchains"])?;
        let destination = root.join(format!("python-{PYTHON_VERSION}"));
        let python_claim = claim(state, &destination, &format!("python-{PYTHON_VERSION}"))?;
        let installer = download(state, id, PYTHON_URL, PYTHON_SHA256, 64 * 1024 * 1024).await?;
        let mut command = Command::new(installer);
        command
            .args([
                "/quiet",
                "InstallAllUsers=0",
                "PrependPath=0",
                "AppendPath=0",
                "Include_launcher=0",
                "InstallLauncherAllUsers=0",
                "AssociateFiles=0",
                "Shortcuts=0",
                "Include_test=0",
                "Include_tcltk=0",
                "Include_doc=0",
                "Include_pip=1",
            ])
            .arg(format!("TargetDir={}", destination.display()))
            .arg("/log")
            .arg(destination.join("installer.log"));
        run_owned(
            state,
            id,
            command,
            "正在将官方 Python 安装到应用私有目录；不改变 PATH 或系统 Python",
        )
        .await?;
        let candidate = destination.join("python.exe");
        let python = python_probe(&candidate, &[]).ok_or(
            "Python 安装未形成有效的私有解释器；已保留日志，请重试或安装 Python 3.10+ 后重试",
        )?;
        if !Path::new(&python).starts_with(&destination) {
            return Err("Python 安装结果不在受管目录，拒绝继续".into());
        }
        save_claim(&python_claim)?;
        Ok(python)
    }
}

pub(crate) async fn prepare(
    state: &RuntimeState,
    id: &str,
    root: &Path,
) -> Result<PreparedRuntime, String> {
    prepare_with_archives(state, id, root, None, None).await
}

pub(crate) async fn prepare_with_archive(
    state: &RuntimeState,
    id: &str,
    root: &Path,
    local_source: Option<&str>,
) -> Result<PreparedRuntime, String> {
    prepare_with_archives(state, id, root, local_source, None).await
}

pub(crate) async fn prepare_with_archives(
    state: &RuntimeState,
    id: &str,
    root: &Path,
    local_source: Option<&str>,
    local_engine: Option<&str>,
) -> Result<PreparedRuntime, String> {
    let mut owner = claim(state, root, SOURCE_REVISION)?;
    if owner.ready {
        for (relative, expected) in &owner.critical_hashes {
            if file_hash(&root.join(relative))? != *expected {
                return Err(
                    "已安装的官方源码已改变，拒绝自动覆盖；请保留改动并导入或修复后重试".into(),
                );
            }
        }
        let result = owner.result.ok_or("准备结果缺失，请查看诊断")?;
        if python_probe(Path::new(&result.python_path), &[]).is_none() {
            return Err("已准备的私有 Python 环境损坏，请在诊断中修复后重试".into());
        }
        progress(
            state,
            id,
            "已验证现有受管运行时；没有重新下载模型或替换用户文件",
        )?;
        ensure_metal_engine(state, id, root, local_engine).await?;
        return Ok(result);
    }
    let python = ensure_python(state, id).await?;
    if !owner.source_ready {
        let archive = match local_source {
            Some(path) => local_archive::import_verified(
                state,
                id,
                Path::new(path),
                SOURCE_SHA256,
                MAX_ARCHIVE,
                local_archive::STRATA,
            )?,
            None => download(state, id, SOURCE_URL, SOURCE_SHA256, MAX_ARCHIVE).await?,
        };
        progress(state, id, "正在安全解包固定版本的 Strata 官方源码")?;
        owner.critical_hashes = extract_source(&archive, root, || cancelled(state, id))?;
        owner.source_ready = true;
        save_claim(&owner)?;
    }
    for (relative, expected) in &owner.critical_hashes {
        if file_hash(&root.join(relative))? != *expected {
            return Err("源码校验失败，拒绝执行安装脚本".into());
        }
    }
    let venv = root.join(".venv");
    if venv.exists() && !owner.venv_claimed {
        return Err("检测到未归属的 Python 环境，拒绝覆盖".into());
    }
    if venv.is_symlink() {
        return Err("私有 Python 环境被重定向，拒绝安装".into());
    }
    owner.venv_claimed = true;
    save_claim(&owner)?;
    #[cfg(windows)]
    let venv_python = venv.join("Scripts/python.exe");
    #[cfg(not(windows))]
    let venv_python = venv.join("bin/python");
    if python_probe(&venv_python, &[]).is_none() {
        let mut command = Command::new(&python);
        command
            .args(["-I", "-m", "venv"])
            .arg(&venv)
            .current_dir(root);
        run_owned(state, id, command, "正在创建 Strata 私有 Python 环境").await?;
    }
    let verified = python_probe(&venv_python, &[])
        .ok_or("私有 Python 环境无法通过版本/位数/venv 检查，可重试")?;
    #[cfg(not(windows))]
    let _ = verified;
    #[cfg(windows)]
    if dunce::canonicalize(&venv_python).map_err(|e| e.to_string())? != Path::new(&verified) {
        return Err("私有 Python 解释器路径不一致".into());
    }
    let mut pip = Command::new(&venv_python);
    pip.args(["-I", "-m", "pip", "--version"]).current_dir(root);
    run_owned(state, id, pip, "正在验证私有 Python 环境的 pip").await?;
    cancelled(state, id)?;
    let port = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| e.to_string())?
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    let result = PreparedRuntime {
        installation_id: owner.installation_id.clone(),
        source_revision: SOURCE_REVISION.into(),
        install_dir: root.to_string_lossy().into(),
        python_path: venv_python.to_string_lossy().into(),
        prepared_at: now(),
        profile: ServiceProfile {
            id: format!("runtime-{}", owner.installation_id),
            name: "Strata".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            install_dir: root.to_string_lossy().into(),
            python_path: venv_python.to_string_lossy().into(),
            config_path: root
                .join("strata-unconfigured.json")
                .to_string_lossy()
                .into(),
            managed: true,
        },
    };
    ensure_metal_engine(state, id, root, local_engine).await?;
    owner.ready = true;
    owner.result = Some(result.clone());
    save_claim(&owner)?;
    Ok(result)
}

/// On macOS aarch64, download (or import) the pinned Metal engine package into `engine/`.
/// No-op on other platforms. Skips when a matching Metal `BUILD.json` is already present
/// or when `build-metal/strata` from an upstream source build already exists.
async fn ensure_metal_engine(
    state: &RuntimeState,
    id: &str,
    root: &Path,
    local_engine: Option<&str>,
) -> Result<(), String> {
    if !crate::macos_metal::metal_engine_supported(std::env::consts::OS, std::env::consts::ARCH) {
        if local_engine.is_some() {
            return Err(
                "仅 Apple Silicon Mac 可使用官方 Metal 引擎包 / Only Apple Silicon Macs use the official Metal engine package"
                    .into(),
            );
        }
        return Ok(());
    }
    cancelled(state, id)?;
    if let Some(existing) = crate::macos_metal::resolve_metal_engine_binary(root) {
        let build = existing
            .parent()
            .map(|parent| parent.join("BUILD.json"))
            .filter(|path| path.is_file());
        if let Some(build) = build {
            if let Ok(value) =
                serde_json::from_slice::<serde_json::Value>(&fs::read(build).unwrap_or_default())
            {
                if value["backend"].as_str() == Some("metal") {
                    progress(
                        state,
                        id,
                        format!("已检测到 Metal 引擎 {}；跳过重复安装", existing.display()),
                    )?;
                    return Ok(());
                }
            }
        } else if existing
            .components()
            .any(|c| c.as_os_str() == crate::macos_metal::METAL_BUILD_DIR)
        {
            progress(
                state,
                id,
                format!(
                    "已检测到源码构建的 Metal 引擎 {}；跳过预制包安装",
                    existing.display()
                ),
            )?;
            return Ok(());
        }
    }
    let engine_dir = root.join(crate::macos_metal::METAL_ENGINE_DIR);
    let archive = match local_engine {
        Some(path) => {
            progress(state, id, format!("正在校验本地 Metal 引擎包 {}", path))?;
            crate::macos_metal::verify_metal_engine_file(Path::new(path))?;
            local_archive::import_verified(
                state,
                id,
                Path::new(path),
                crate::macos_metal::METAL_ENGINE_SHA256,
                crate::macos_metal::METAL_ENGINE_SIZE
                    .saturating_mul(2)
                    .max(8 * 1024 * 1024),
                local_archive::ENGINE,
            )?
        }
        None => {
            progress(
                state,
                id,
                format!(
                    "正在下载官方 Metal 引擎 {}（{} 字节）并校验 SHA256",
                    crate::macos_metal::METAL_ENGINE_ASSET_NAME,
                    crate::macos_metal::METAL_ENGINE_SIZE
                ),
            )?;
            download_release(
                state,
                id,
                &crate::macos_metal::metal_engine_download_url(),
                crate::macos_metal::METAL_ENGINE_SHA256,
                crate::macos_metal::METAL_ENGINE_SIZE
                    .saturating_mul(2)
                    .max(8 * 1024 * 1024),
            )
            .await?
        }
    };
    crate::macos_metal::verify_metal_engine_file(&archive)?;
    progress(state, id, "官方 Metal 引擎 SHA256 通过；正在解包到 engine/")?;
    if engine_dir.exists() {
        if engine_dir.join("BUILD.json").is_file() || engine_dir.join("strata").is_file() {
            for entry in fs::read_dir(&engine_dir).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();
                if path.is_dir() {
                    fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
                } else {
                    fs::remove_file(&path).map_err(|e| e.to_string())?;
                }
            }
        } else if fs::read_dir(&engine_dir)
            .map_err(|e| e.to_string())?
            .next()
            .is_some()
        {
            return Err(
                "engine/ 目录已有非 Metal 内容，拒绝覆盖；请改用空目录或已有 build-metal / The engine/ directory already has non-Metal contents; use an empty directory or an existing build-metal"
                    .into(),
            );
        }
    }
    crate::macos_metal::extract_metal_engine_archive(&archive, &engine_dir, || {
        cancelled(state, id)
    })?;
    crate::macos_metal::write_metal_install_marker(&engine_dir)?;
    progress(
        state,
        id,
        format!(
            "Metal 引擎 {} 已安装到 {}",
            crate::macos_metal::METAL_ENGINE_VERSION,
            engine_dir.display()
        ),
    )?;
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn installer_owned_path_rejects_symbolic_links_and_reparse_points() {
        assert!(reject_installer_link_kind(false, false).is_ok());
        assert!(reject_installer_link_kind(true, false).is_err());
        assert!(reject_installer_link_kind(false, true).is_err());
        assert!(reject_installer_link_kind(true, true).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn installer_owned_package_parent_identity_rejects_reused_process_ids() {
        assert!(valid_installer_parent_time(100, 200));
        assert!(valid_installer_parent_time(200, 200));
        assert!(!valid_installer_parent_time(201, 200));
    }

    #[cfg(windows)]
    #[test]
    fn installer_package_identity_survives_parent_exit_without_querying_again() {
        let cache = std::sync::OnceLock::new();
        let queries = std::cell::Cell::new(0);
        let family = installer_package_family_once(&cache, || {
            queries.set(queries.get() + 1);
            Ok(Some("OS-confirmed-family".to_owned()))
        })
        .unwrap();
        assert_eq!(family, Some("OS-confirmed-family"));
        let family = installer_package_family_once(&cache, || {
            queries.set(queries.get() + 1);
            Err("launching parent has exited".into())
        })
        .unwrap();
        assert_eq!(family, Some("OS-confirmed-family"));
        assert_eq!(queries.get(), 1);

        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("Roaming/io.strata.manager");
        let mapped = temp
            .path()
            .join("Packages")
            .join(family.unwrap())
            .join("LocalCache/Roaming/io.strata.manager");
        assert_eq!(
            select_installer_root(&data, &mapped, Some(&mapped)).unwrap(),
            mapped
        );
        let stranger = temp
            .path()
            .join("Packages/another-family/LocalCache/Roaming/io.strata.manager");
        assert!(select_installer_root(&data, &stranger, Some(&mapped)).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn installer_package_identity_missing_or_failed_capture_cannot_be_promoted() {
        for captured in [Ok(None), Err("OS identity unavailable".to_owned())] {
            let expected = captured.clone();
            let cache = std::sync::OnceLock::new();
            let queries = std::cell::Cell::new(0);
            assert_eq!(
                installer_package_family_once(&cache, || captured),
                expected
                    .as_ref()
                    .map(|family| family.as_deref())
                    .map_err(Clone::clone)
            );
            let retry = installer_package_family_once(&cache, || {
                queries.set(queries.get() + 1);
                Ok(Some("family-found-in-directory-name".to_owned()))
            });
            assert_eq!(
                retry,
                expected
                    .as_ref()
                    .map(|family| family.as_deref())
                    .map_err(Clone::clone)
            );
            assert_eq!(queries.get(), 0);
            let data = Path::new("C:/Roaming/io.strata.manager");
            let stranger = Path::new(
                "C:/Packages/family-found-in-directory-name/LocalCache/Roaming/io.strata.manager",
            );
            assert!(select_installer_root(data, stranger, None).is_err());
            assert_eq!(select_installer_root(data, data, None).unwrap(), data);
        }
    }

    #[test]
    fn installer_owned_root_accepts_only_exact_system_confirmed_mapping() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("Roaming/io.strata.manager");
        let mapped = temp
            .path()
            .join("Packages/current-family/LocalCache/Roaming/io.strata.manager");
        assert_eq!(select_installer_root(&data, &data, None).unwrap(), data);
        assert_eq!(
            select_installer_root(&data, &mapped, Some(&mapped)).unwrap(),
            mapped
        );
        assert!(select_installer_root(&data, &mapped, None).is_err());
        for other in [
            mapped.join("nested"),
            temp.path()
                .join("Packages/other-family/LocalCache/Roaming/io.strata.manager"),
            temp.path().join("untrusted/io.strata.manager"),
        ] {
            assert!(select_installer_root(&data, &other, Some(&mapped)).is_err());
        }
    }

    #[cfg(windows)]
    #[test]
    fn installer_exited_launcher_uses_only_registered_exact_database_mapping() {
        let roaming = Path::new("C:/Users/fixture/AppData/Roaming");
        let local = Path::new("C:/Users/fixture/AppData/Local");
        let data = roaming.join("io.strata.manager");
        let mapped = local.join("Packages/registered-family/LocalCache/Roaming/io.strata.manager");
        let database = mapped.join("strata-manager.sqlite3");
        let queries = std::cell::Cell::new(0);
        assert_eq!(
            registered_installer_package_root(&data, &database, roaming, local, |family| {
                queries.set(queries.get() + 1);
                assert_eq!(family, "registered-family");
                Ok(true)
            })
            .unwrap(),
            mapped
        );
        assert_eq!(queries.get(), 1);
        assert!(
            registered_installer_package_root(&data, &database, roaming, local, |_| Ok(false))
                .unwrap_err()
                .contains("未在当前用户注册")
        );
        assert_eq!(
            registered_installer_package_root(&data, &database, roaming, local, |_| {
                Err("Windows registration unavailable".into())
            })
            .unwrap_err(),
            "Windows registration unavailable"
        );
    }

    #[cfg(windows)]
    #[test]
    fn installer_exited_launcher_rejects_forged_package_and_relative_paths() {
        let roaming = Path::new("C:/Users/fixture/AppData/Roaming");
        let local = Path::new("C:/Users/fixture/AppData/Local");
        let data = roaming.join("io.strata.manager");
        let queries = std::cell::Cell::new(0);
        for database in [
            local.join("Packages/registered-family/Roaming/io.strata.manager/strata-manager.sqlite3"),
            local.join("Packages/registered-family/LocalCache/Local/io.strata.manager/strata-manager.sqlite3"),
            local.join("Packages/registered-family/LocalCache/Roaming/another-app/strata-manager.sqlite3"),
            local.join("Packages/registered-family/LocalCache/Roaming/io.strata.manager/nested/strata-manager.sqlite3"),
            local.join("Packages/registered-family/LocalCache/Roaming/io.strata.manager/another.sqlite3"),
            PathBuf::from("C:/Users/other/AppData/Local/Packages/registered-family/LocalCache/Roaming/io.strata.manager/strata-manager.sqlite3"),
        ] {
            assert!(registered_installer_package_root(
                &data, &database, roaming, local, |_| {
                    queries.set(queries.get() + 1);
                    Ok(true)
                }
            )
            .is_err());
        }
        // An OS-registered name still cannot authorize an unrelated spelling.
        assert_eq!(queries.get(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn installer_database_handle_resolves_existing_file_and_rejects_directory() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("normal-data")).unwrap();
        let database = state.data_dir().join("strata-manager.sqlite3");
        assert_eq!(
            installer_database_path(&database).unwrap(),
            dunce::canonicalize(database).unwrap()
        );
        assert!(installer_database_path(state.data_dir()).is_err());
    }

    #[test]
    fn installer_owned_directory_uses_physical_database_root_and_rejects_invalid_parts() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let root = installer_data_root(state.data_dir()).unwrap();
        assert_eq!(root, dunce::canonicalize(state.data_dir()).unwrap());
        let cache = owned_directory(state.data_dir(), &["zip-updates", "fixture"]).unwrap();
        assert_eq!(cache, root.join("zip-updates/fixture"));
        assert_eq!(dunce::canonicalize(&cache).unwrap(), cache);
        for part in ["..", "escape/nested", "escape\\nested", "C:escape", ""] {
            assert!(owned_directory(state.data_dir(), &[part]).is_err());
        }
    }

    #[test]
    fn verified_data_root_is_read_only_and_requires_an_existing_database() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        fs::create_dir(&data).unwrap();
        let database = data.join("strata-manager.sqlite3");
        assert!(verified_data_root(&data).is_err());
        assert!(!database.exists());
        assert_eq!(fs::read_dir(&data).unwrap().count(), 0);

        let original = b"existing database content must stay unchanged";
        fs::write(&database, original).unwrap();
        assert_eq!(
            verified_data_root(&data).unwrap(),
            dunce::canonicalize(&data).unwrap()
        );
        assert_eq!(fs::read(&database).unwrap(), original);
        assert_eq!(fs::read_dir(&data).unwrap().count(), 1);
        assert!(!data.join("supervisor").exists());
    }

    #[cfg(any(unix, windows))]
    #[test]
    #[cfg_attr(
        windows,
        ignore = "Requires Windows symbolic-link privilege; the link policy is tested without elevation"
    )]
    fn installer_owned_directory_rejects_linked_database() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        fs::create_dir(&data).unwrap();
        let external = temp.path().join("external.sqlite3");
        fs::write(&external, "preserve external database").unwrap();
        let database = data.join("strata-manager.sqlite3");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&external, &database).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&external, &database).unwrap();
        assert!(owned_directory(&data, &["zip-updates"])
            .unwrap_err()
            .contains("重定向"));
        assert!(!data.join("zip-updates").exists());
        assert_eq!(
            fs::read_to_string(external).unwrap(),
            "preserve external database"
        );
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn installer_owned_directory_rejects_linked_root_and_child() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let state = RuntimeState::open(data.clone()).unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let root_alias = temp.path().join("root-alias");
        // A previous successful directory check must not authorize a link
        // substituted afterwards, even when the package identity is cached.
        let child_alias = owned_directory(state.data_dir(), &["zip-updates"]).unwrap();
        fs::remove_dir(&child_alias).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&data, &root_alias).unwrap();
            std::os::unix::fs::symlink(&outside, &child_alias).unwrap();
        }
        #[cfg(windows)]
        {
            // Junctions do not require the symbolic-link privilege and exercise
            // the Windows reparse-point guard rather than only is_symlink().
            for (alias, target) in [(&root_alias, &data), (&child_alias, &outside)] {
                let output = Command::new("cmd")
                    .args(["/C", "mklink", "/J"])
                    .arg(alias)
                    .arg(target)
                    .output()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        }
        assert!(owned_directory(&root_alias, &["downloads"]).is_err());
        assert!(owned_directory(state.data_dir(), &["zip-updates", "fixture"]).is_err());
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "Explicit read-only check of the current packaged process data path"]
    fn installer_owned_root_live_readonly_verifies_existing_msix_mapping() {
        let data = PathBuf::from(
            std::env::var_os("STRATA_INSTALLER_READONLY_DATA_DIR")
                .expect("provide the existing data directory"),
        );
        if std::env::var_os("STRATA_INSTALLER_READONLY_PARENT_EXIT").is_some() {
            // Launch this ignored test directly as a detached child of a
            // short-lived shell, then let that shell exit before the OS probe.
            std::thread::sleep(Duration::from_secs(2));
            let identity = installer_package_family_once(
                &INSTALLER_PACKAGE_FAMILY,
                capture_installer_package_family,
            );
            eprintln!("orphaned launcher identity={identity:?}");
            assert!(
                matches!(identity, Err(_) | Ok(None)),
                "the launcher must have exited before supplying a package identity"
            );
        }
        eprintln!(
            "data={:?}; database={:?}; package mapping={:?}",
            dunce::canonicalize(&data),
            dunce::canonicalize(data.join("strata-manager.sqlite3")),
            current_package_roaming_root(
                &dunce::canonicalize(&data).unwrap(),
                &installer_database_path(&data.join("strata-manager.sqlite3")).unwrap(),
            )
        );
        let root = installer_data_root(&data).unwrap();
        let database = dunce::canonicalize(data.join("strata-manager.sqlite3")).unwrap();
        assert_eq!(root, database.parent().unwrap());
        assert!(data.join("strata-manager.sqlite3").is_file());
        // This test does not open a second RuntimeState or create any directory.
    }

    fn source_zip(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, content) in entries {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }
    fn fixture_task(state: &RuntimeState) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        state.tasks.lock().unwrap().insert(
            id.clone(),
            TaskRecord {
                status: TaskStatus {
                    id: id.clone(),
                    kind: "install-runtime".into(),
                    state: "running".into(),
                    message: "fixture".into(),
                    started_at: now(),
                    finished_at: None,
                },
                profile_id: None,
                runtime_path: None,
                cancelled: false,
                process: None,
            },
        );
        id
    }
    fn fixture_download(bytes: &'static [u8]) -> (String, std::thread::JoinHandle<()>) {
        let server = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let url = format!("http://{}/artifact", server.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = server.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = [0u8; 4096];
            assert!(stream.read(&mut request).unwrap() > 0);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                bytes.len()
            )
            .unwrap();
            stream.write_all(bytes).unwrap();
        });
        (url, worker)
    }
    #[tokio::test]
    async fn download_checks_hash_and_retries_without_overwriting_a_bad_cache() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let id = fixture_task(&state);
        let expected = format!("{:x}", Sha256::digest(b"verified official fixture"));
        let downloads = owned_directory(state.data_dir(), &["downloads"]).unwrap();
        let old = downloads.join(format!("{expected}.download"));
        fs::write(&old, "preserve unknown bytes").unwrap();
        let (url, worker) = fixture_download(b"verified official fixture");
        let downloaded = download(&state, &id, &url, &expected, 1024).await.unwrap();
        worker.join().unwrap();
        assert_ne!(downloaded, old);
        assert_eq!(file_hash(&downloaded).unwrap(), expected);
        assert_eq!(fs::read_to_string(old).unwrap(), "preserve unknown bytes");
        let wrong_expected = "0".repeat(64);
        let (url, worker) = fixture_download(b"tampered bytes");
        assert!(download(&state, &id, &url, &wrong_expected, 1024)
            .await
            .unwrap_err()
            .contains("SHA256"));
        worker.join().unwrap();
        assert!(!downloads
            .join(format!("{wrong_expected}.download"))
            .exists());
    }
    #[tokio::test]
    async fn cancelled_download_does_not_publish_an_artifact() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let id = fixture_task(&state);
        let server = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let url = format!("http://{}/artifact", server.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = server.accept().unwrap();
            let mut request = [0u8; 4096];
            assert!(stream.read(&mut request).unwrap() > 0);
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 10000\r\nConnection: close\r\n\r\npartial",
                )
                .unwrap();
            std::thread::sleep(Duration::from_millis(500));
        });
        let task_state = state.clone();
        let task_id = id.clone();
        let download_task = tokio::spawn(async move {
            download(&task_state, &task_id, &url, &"0".repeat(64), 20_000).await
        });
        tokio::time::sleep(Duration::from_millis(150)).await;
        state.tasks.lock().unwrap().get_mut(&id).unwrap().cancelled = true;
        assert!(download_task.await.unwrap().unwrap_err().contains("取消"));
        worker.join().unwrap();
        let directory = state.data_dir().join("downloads");
        assert!(fs::read_dir(&directory).unwrap().all(|entry| entry
            .unwrap()
            .path()
            .extension()
            .is_none_or(|ext| ext != "download")));
        assert_eq!(
            fs::read(directory.join(format!("{}.part", "0".repeat(64)))).unwrap(),
            b"partial"
        );
    }
    #[test]
    fn archive_paths_reject_traversal_ads_windows_aliases_and_foreign_roots() {
        let prefix = format!("Strata-{SOURCE_REVISION}");
        for tail in [
            "../outside.py",
            "serve/../../escape",
            "C:evil",
            "serve\\evil",
            "con.txt",
            "AUX",
            "foo.",
            "foo ",
        ] {
            assert!(
                safe_entry(&format!("{prefix}/{tail}"), &prefix).is_err(),
                "{tail}"
            );
        }
        assert!(safe_entry("other/setup.py", &prefix).is_err());
        assert_eq!(
            safe_entry(&format!("{prefix}/serve/server.py"), &prefix).unwrap(),
            Some(PathBuf::from("serve/server.py"))
        );
    }
    #[test]
    fn archive_preflight_prevents_escape_and_preserves_existing_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runtime");
        fs::create_dir(&root).unwrap();
        let prefix = format!("Strata-{SOURCE_REVISION}");
        let setup = format!("{prefix}/setup.py");
        let server = format!("{prefix}/serve/server.py");
        let archive = temp.path().join("fixture.zip");
        fs::write(
            &archive,
            source_zip(&[(&setup, "official"), (&server, "server")]),
        )
        .unwrap();
        let hashes = extract_source(&archive, &root, || Ok(())).unwrap();
        assert_eq!(hashes.len(), 2);
        extract_source(&archive, &root, || Ok(())).unwrap(); // safe retry reuses identical files
        fs::write(root.join("setup.py"), "user change").unwrap();
        assert!(extract_source(&archive, &root, || Ok(())).is_err());
        assert_eq!(
            fs::read_to_string(root.join("setup.py")).unwrap(),
            "user change"
        );
        fs::write(
            &archive,
            source_zip(&[
                (&setup, "official"),
                (&format!("{prefix}/../escape"), "bad"),
            ]),
        )
        .unwrap();
        assert!(extract_source(&archive, &root, || Ok(())).is_err());
        assert!(!temp.path().join("escape").exists());
    }
    #[test]
    fn installation_claim_requires_database_and_filesystem_identity() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let base = owned_directory(state.data_dir(), &["runtimes"]).unwrap();
        let root = base.join("fixture");
        let first = claim(&state, &root, "fixture-rev").unwrap();
        assert_eq!(
            claim(&state, &root, "fixture-rev").unwrap().token,
            first.token
        );
        let unknown = base.join("unknown");
        fs::create_dir(&unknown).unwrap();
        fs::write(unknown.join("user.txt"), "keep").unwrap();
        assert!(claim(&state, &unknown, "fixture-rev").is_err());
        assert_eq!(
            fs::read_to_string(unknown.join("user.txt")).unwrap(),
            "keep"
        );
        state
            .database
            .lock()
            .unwrap()
            .execute("DELETE FROM automatic_runtime_claims", [])
            .unwrap();
        assert!(claim(&state, &root, "fixture-rev").is_err());
    }
    #[test]
    fn extraction_cancellation_does_not_publish_incomplete_source_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runtime");
        fs::create_dir(&root).unwrap();
        let archive = temp.path().join("fixture.zip");
        let prefix = format!("Strata-{SOURCE_REVISION}");
        fs::write(
            &archive,
            source_zip(&[
                (&format!("{prefix}/setup.py"), "official"),
                (&format!("{prefix}/serve/server.py"), "server"),
            ]),
        )
        .unwrap();
        assert!(extract_source(&archive, &root, || Err("cancelled".into())).is_err());
        assert!(!root.join("setup.py").exists());
    }
    #[tokio::test]
    #[ignore = "Uses the externally verified official source archive and creates a real private venv; no model download"]
    async fn official_archive_prepares_without_git_and_returns_only_a_setup_profile() {
        let archive = PathBuf::from(
            std::env::var_os("STRATA_MANAGER_TEST_SOURCE_ARCHIVE")
                .expect("provide the verified official zip"),
        );
        assert_eq!(file_hash(&archive).unwrap(), SOURCE_SHA256);
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let downloads = owned_directory(state.data_dir(), &["downloads"]).unwrap();
        // STRATA_MANAGER_TEST_LOCAL_ARCHIVE=1 exercises first-run "use a downloaded package".
        let local = std::env::var("STRATA_MANAGER_TEST_LOCAL_ARCHIVE").as_deref() == Ok("1");
        if !local && std::env::var("STRATA_MANAGER_TEST_NETWORK_SOURCE").as_deref() != Ok("1") {
            fs::copy(
                &archive,
                downloads.join(format!("{SOURCE_SHA256}.download")),
            )
            .unwrap();
        }
        let archives = LocalRuntimeArchives {
            strata_archive_path: local.then(|| archive.to_string_lossy().into_owned()),
            engine_archive_path: None,
        };
        let task = start(state.clone(), archives).unwrap();
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let status = state
                .tasks
                .lock()
                .unwrap()
                .get(&task.id)
                .unwrap()
                .status
                .clone();
            if status.state != "running" {
                assert_eq!(status.state, "completed", "{}", status.message);
                break;
            }
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let result = status(&state).unwrap().result.unwrap();
        assert!(Path::new(&result.python_path).is_file());
        assert!(!Path::new(&result.profile.config_path).exists());
        assert!(state.registered_profiles().unwrap().is_empty());
        assert_eq!(result.source_revision, SOURCE_REVISION);
        assert!(!Path::new(&result.install_dir).join(".git").exists());
    }
}
