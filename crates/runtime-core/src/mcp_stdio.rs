//! Early synchronous MCP stdio wrapper. It never opens manager storage or Tokio.
//! The real Strata process supplies a pidfd, rather than a recyclable parent PID.

use std::ffi::OsString;

pub fn run_if_requested() -> Option<Result<i32, String>> {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if args.first().and_then(|arg| arg.to_str()) != Some("--mcp-stdio") {
        return None;
    }
    #[cfg(target_os = "linux")]
    return Some(linux::run(&args[1..]));
    #[cfg(not(target_os = "linux"))]
    Some(Err("MCP stdio guardian requires Linux".into()))
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::{
        fs::File,
        io::{Read, Write},
        os::{
            fd::{FromRawFd, OwnedFd, RawFd},
            unix::{ffi::OsStrExt, process::CommandExt},
        },
        process::{Command, Stdio},
    };

    fn parse_fd(value: &OsString) -> Result<RawFd, String> {
        value
            .to_str()
            .and_then(|text| text.parse::<i32>().ok())
            .filter(|fd| *fd >= 3)
            .ok_or_else(|| "Invalid MCP guardian descriptor".into())
    }

    fn close_on_exec(fd: RawFd) -> Result<(), String> {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
            return Err("MCP guardian descriptor is unavailable".into());
        }
        Ok(())
    }

    pub(super) fn run(args: &[OsString]) -> Result<i32, String> {
        if args.len() < 6
            || args.len() > 262
            || args[0] != "--parent-pidfd"
            || args[2] != "--ready-fd"
            || args[4] != "--"
            || args[5].is_empty()
            || args.iter().map(|arg| arg.as_bytes().len()).sum::<usize>() > 128 * 1024
        {
            return Err("Invalid MCP stdio wrapper arguments".into());
        }
        let parent_fd = parse_fd(&args[1])?;
        let ready_fd = parse_fd(&args[3])?;
        if parent_fd == ready_fd {
            return Err("MCP guardian descriptors must be distinct".into());
        }
        close_on_exec(parent_fd)?;
        close_on_exec(ready_fd)?;
        // Signal zero validates a real, live pidfd without modifying its target.
        if unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                parent_fd,
                0i32,
                std::ptr::null::<libc::siginfo_t>(),
                0u32,
            )
        } < 0
        {
            return Err("MCP parent pidfd is unavailable".into());
        }
        // pidfd's kernel fdinfo identifies its target in this PID namespace.
        // Accept only the actual, still-current Strata parent, even for callers
        // invoking the low-level wrapper directly with another process's pidfd.
        let mut identity = String::new();
        File::open(format!("/proc/self/fdinfo/{parent_fd}"))
            .and_then(|file| file.take(4097).read_to_string(&mut identity))
            .map_err(|_| "MCP parent identity could not be read")?;
        let mut parents = identity.lines().filter_map(|line| {
            line.strip_prefix("Pid:")
                .and_then(|pid| pid.trim().parse::<libc::pid_t>().ok())
        });
        let parent_pid = parents.next();
        if identity.len() > 4096
            || parents.next().is_some()
            || parent_pid.is_none_or(|pid| pid <= 1 || pid != unsafe { libc::getppid() })
        {
            return Err("MCP pidfd does not identify the current Strata parent".into());
        }
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        let ready_flags = unsafe { libc::fcntl(ready_fd, libc::F_GETFL) };
        if unsafe { libc::fstat(ready_fd, &mut stat) } < 0
            || stat.st_mode & libc::S_IFMT != libc::S_IFIFO
            || ready_flags < 0
            || ready_flags & libc::O_ACCMODE != libc::O_WRONLY
        {
            return Err("MCP readiness descriptor must be a writable pipe".into());
        }
        if unsafe { libc::getpgrp() != libc::getpid() || libc::getpid() <= 1 } {
            return Err("MCP wrapper requires its own new process group".into());
        }
        let parent = unsafe { OwnedFd::from_raw_fd(parent_fd) };
        let mut ready = unsafe { File::from_raw_fd(ready_fd) };
        let mut term: libc::sigset_t = unsafe { std::mem::zeroed() };
        let mut previous: libc::sigset_t = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::sigemptyset(&mut term) < 0
                || libc::sigaddset(&mut term, libc::SIGTERM) < 0
                || libc::sigprocmask(libc::SIG_BLOCK, &term, &mut previous) < 0
        } {
            return Err("MCP wrapper could not preserve shutdown grace".into());
        }
        // The wrapper remains alive while upstream's SIGTERM reaches the tool.
        // Its guardian survives TERM too, until normal completion or SIGKILL.
        let _guardian = crate::processes::linux_guardian::attach_parent(parent)
            .map_err(|_| "MCP process guardian could not be established")?;
        let mut command = Command::new(&args[5]);
        command
            .args(&args[6..])
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        unsafe {
            command.pre_exec(move || {
                if libc::sigprocmask(libc::SIG_SETMASK, &previous, std::ptr::null_mut()) < 0 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut child = command
            .spawn()
            .map_err(|_| "MCP tool executable could not be started")?;
        // A separate pipe carries readiness; tool stdout remains byte-for-byte
        // JSON-RPC output. ACK follows successful guardian setup and tool exec.
        ready
            .write_all(&[1])
            .map_err(|_| "MCP readiness acknowledgement failed")?;
        drop(ready);
        let status = child.wait().map_err(|_| "MCP tool wait failed")?;
        Ok(status.code().unwrap_or(1))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn ordinary_supervisor_arguments_do_not_select_stdio_wrapper() {
        assert!(super::run_if_requested().is_none());
    }
}
