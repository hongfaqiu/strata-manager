//! Read-only Windows discovery. A held process generation, not a second PID
//! lookup, determines whether a Python instance has actually exited.
use super::{hint_from_args, ProcessHint};
use crate::external;
use std::{
    collections::HashSet,
    path::PathBuf,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER,
        ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE,
        },
    },
};

const BUDGET: Duration = Duration::from_secs(3);
const MAX_PASSES: usize = 8;
const MAX_PROCESSES: usize = 4096;
const MAX_PYTHON: usize = 64;

#[derive(Clone, Debug)]
enum ScanError {
    Changed,
    Rejected(String),
}
impl From<String> for ScanError {
    fn from(message: String) -> Self {
        Self::Rejected(message)
    }
}

// Only this census uses the seam; production always selects Native. Tests can
// deterministically order exit, command-read, and new-generation events.
trait Census {
    type Held;
    fn snapshot(&mut self, deadline: Instant) -> Result<Vec<u32>, ScanError>;
    /// `Ok(None)` means the PID cannot be opened (e.g. ACCESS_DENIED) and is not a serve candidate.
    fn hold(&mut self, pid: u32) -> Result<Option<Self::Held>, ScanError>;
    fn exited(&mut self, held: &Self::Held) -> Result<bool, String>;
    fn identity(&mut self, held: &Self::Held) -> Result<(u64, PathBuf), String>;
    fn command(&mut self, held: &Self::Held) -> Result<Vec<String>, String>;
}

fn budget(deadline: Instant) -> Result<(), ScanError> {
    if Instant::now() >= deadline {
        return Err(ScanError::Rejected(
            "读取本机 Python 参数超过时间预算，已停止自动操作".into(),
        ));
    }
    Ok(())
}

fn process_count(count: usize) -> Result<(), ScanError> {
    if count > MAX_PROCESSES {
        return Err(ScanError::Rejected(
            "本机进程清单超过检测上限，已停止自动操作".into(),
        ));
    }
    Ok(())
}

fn python_image(image: &std::path::Path) -> bool {
    image
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.eq_ignore_ascii_case("python.exe") || name.eq_ignore_ascii_case("pythonw.exe")
        })
}

fn snapshot<C: Census>(source: &mut C, deadline: Instant) -> Result<Vec<u32>, ScanError> {
    budget(deadline)?;
    let pids = source.snapshot(deadline)?;
    budget(deadline)?;
    if pids.len() > MAX_PYTHON
        || pids.contains(&0)
        || pids.iter().copied().collect::<HashSet<_>>().len() != pids.len()
    {
        return Err(ScanError::Rejected(
            "本机 Python 进程清单超过上限或身份重复，已停止自动操作".into(),
        ));
    }
    Ok(pids)
}

fn observe<C: Census>(
    source: &mut C,
    held: &C::Held,
    deadline: Instant,
) -> Result<Option<Vec<String>>, ScanError> {
    budget(deadline)?;
    if source.exited(held)? {
        return Ok(None);
    }
    let identity = match source.identity(held) {
        Ok(identity) => identity,
        Err(error) => {
            if source.exited(held)? {
                return Ok(None);
            }
            return Err(error.into());
        }
    };
    if !python_image(&identity.1) {
        return Err(ScanError::Changed);
    }
    // An initializing interpreter may briefly have unavailable argv. The same
    // held generation gets one finite retry inside the original total budget.
    let mut command = None;
    for attempt in 0..2 {
        budget(deadline)?;
        if source.exited(held)? {
            return Ok(None);
        }
        match source.command(held) {
            Ok(args) => {
                command = Some(args);
                break;
            }
            Err(error) => {
                if source.exited(held)? {
                    return Ok(None);
                }
                if attempt == 1 {
                    return Err(error.into());
                }
                std::thread::sleep(
                    Duration::from_millis(10)
                        .min(deadline.saturating_duration_since(Instant::now())),
                );
            }
        }
    }
    budget(deadline)?;
    if source.exited(held)? {
        return Ok(None);
    }
    let current_identity = match source.identity(held) {
        Ok(identity) => identity,
        Err(error) => {
            if source.exited(held)? {
                return Ok(None);
            }
            return Err(error.into());
        }
    };
    if current_identity != identity {
        return Err(ScanError::Rejected(
            "Python 进程创建时间或可执行身份变化，未自动启动".into(),
        ));
    }
    let command: Vec<_> = command
        .ok_or_else(|| ScanError::Rejected("无法完整读取 Python 启动参数，未自动启动".into()))?
        .into_iter()
        .map(std::ffi::OsString::from)
        .collect();
    Ok(Some(super::checked_windows_args(&command)?))
}

fn scan<C: Census>(source: &mut C, deadline: Instant) -> Result<Vec<ProcessHint>, ScanError> {
    let first = snapshot(source, deadline)?;
    let mut records = Vec::with_capacity(first.len());
    let mut skipped = HashSet::new();
    for pid in first {
        budget(deadline)?;
        // ACCESS_DENIED (and similar) means a foreign Python we cannot inspect —
        // skip it; do not abort the whole startup census.
        let Some(held) = source.hold(pid)? else {
            skipped.insert(pid);
            continue;
        };
        let command = observe(source, &held, deadline)?;
        records.push((pid, held, command));
    }
    let current = snapshot(source, deadline)?;
    // A new PID, or an old PID whose held generation exited and was reused,
    // requires a fresh observation. Never reuse that generation's saved argv.
    // PIDs we already skipped as inaccessible stay skipped unless they become
    // openable (then the census must rebuild so we never miss a serve process).
    for pid in &current {
        if let Some((_, held, _)) = records.iter().find(|(seen, _, _)| seen == pid) {
            if source.exited(held)? {
                match source.hold(*pid)? {
                    None => {
                        skipped.insert(*pid);
                    }
                    Some(replacement) if !source.exited(&replacement)? => {
                        return Err(ScanError::Changed);
                    }
                    Some(_) => {}
                }
            }
            continue;
        }
        if skipped.contains(pid) {
            match source.hold(*pid)? {
                None => continue,
                Some(held) if source.exited(&held)? => continue,
                Some(_) => return Err(ScanError::Changed),
            }
        }
        return Err(ScanError::Changed);
    }
    let mut hints = Vec::new();
    for (pid, held, command) in records {
        if source.exited(&held)? {
            continue;
        }
        if !current.contains(&pid) {
            return Err(ScanError::Changed);
        }
        let command = command.ok_or_else(|| {
            ScanError::Rejected("存活 Python 的启动参数未核验，未自动启动".into())
        })?;
        if !command
            .windows(2)
            .any(|pair| pair[0] == "-m" && pair[1] == "serve.server")
        {
            continue;
        }
        let hint = hint_from_args(&command);
        // Config deletion after a CPU fixture exits is harmless only when the
        // OS handle proves that exit. A live, unlocatable Strata still blocks.
        if source.exited(&held)? {
            continue;
        }
        hints.push(hint.ok_or_else(|| {
            ScanError::Rejected(
                "检测到无法定位配置的 Strata 进程，不能启动第二个实例；请先完成既有实例的迁移"
                    .into(),
            )
        })?);
    }
    budget(deadline)?;
    Ok(hints)
}

fn collect<C: Census>(source: &mut C, deadline: Instant) -> Result<Vec<ProcessHint>, String> {
    for _ in 0..MAX_PASSES {
        match scan(source, deadline) {
            Ok(hints) => return Ok(hints),
            Err(ScanError::Rejected(message)) => return Err(message),
            Err(ScanError::Changed) => {
                budget(deadline).map_err(|error| match error {
                    ScanError::Rejected(message) => message,
                    ScanError::Changed => unreachable!(),
                })?;
            }
        }
    }
    Err("Python 进程清单持续变化，请重新检测；未自动启动".into())
}

struct Native;
struct Held(HANDLE);
impl Drop for Held {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

impl Census for Native {
    type Held = Held;
    fn snapshot(&mut self, deadline: Instant) -> Result<Vec<u32>, ScanError> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(ScanError::Rejected(
                "无法获取完整本机进程清单，已停止自动操作".into(),
            ));
        }
        let snapshot = Held(snapshot);
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of_val(&entry) as u32;
        let mut next = unsafe { Process32FirstW(snapshot.0, &mut entry) };
        let mut count = 0;
        let mut pids = Vec::new();
        while next != 0 {
            count += 1;
            budget(deadline)?;
            process_count(count)?;
            let end = entry
                .szExeFile
                .iter()
                .position(|value| *value == 0)
                .ok_or_else(|| {
                    ScanError::Rejected("本机进程文件名不完整，已停止自动操作".into())
                })?;
            let name = String::from_utf16(&entry.szExeFile[..end])
                .map_err(|_| ScanError::Rejected("本机进程文件名无效，已停止自动操作".into()))?;
            if name.eq_ignore_ascii_case("python.exe") || name.eq_ignore_ascii_case("pythonw.exe") {
                pids.push(entry.th32ProcessID);
                if pids.len() > MAX_PYTHON {
                    return Err(ScanError::Rejected(
                        "本机 Python 进程超过检测上限，已停止自动操作".into(),
                    ));
                }
            }
            next = unsafe { Process32NextW(snapshot.0, &mut entry) };
        }
        if unsafe { GetLastError() } != ERROR_NO_MORE_FILES {
            return Err(ScanError::Rejected(
                "本机进程清单读取不完整，已停止自动操作".into(),
            ));
        }
        Ok(pids)
    }
    fn hold(&mut self, pid: u32) -> Result<Option<Held>, ScanError> {
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if handle.is_null() {
            // No held handle means no proven exit. Rebuild the complete census
            // for an already-disappeared PID. ACCESS_DENIED is a foreign
            // process (e.g. LocalSystem service child) we cannot inspect — skip
            // it rather than blocking the whole startup. Other open failures
            // stay closed because they do not prove the PID is gone or foreign.
            match unsafe { GetLastError() } {
                ERROR_INVALID_PARAMETER => return Err(ScanError::Changed),
                ERROR_ACCESS_DENIED => return Ok(None),
                _ => {
                    return Err(ScanError::Rejected(
                        "无法打开 Python 进程核验身份，请检查进程权限；未自动启动".into(),
                    ))
                }
            }
        }
        Ok(Some(Held(handle)))
    }
    fn exited(&mut self, held: &Held) -> Result<bool, String> {
        match unsafe { WaitForSingleObject(held.0, 0) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            _ => Err("无法确认 Python 进程退出状态，未自动启动".into()),
        }
    }
    fn identity(&mut self, held: &Held) -> Result<(u64, PathBuf), String> {
        external::identity(held.0)
    }
    fn command(&mut self, held: &Held) -> Result<Vec<String>, String> {
        external::arguments(&external::command_for(held.0)?)
    }
}

pub(super) fn process_hints() -> Result<Vec<ProcessHint>, String> {
    collect(&mut Native, Instant::now() + BUDGET)
}

#[cfg(test)]
mod tests;
