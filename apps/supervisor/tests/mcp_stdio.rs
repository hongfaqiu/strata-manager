#![cfg(target_os = "linux")]

use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    net::{SocketAddr, TcpStream},
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use strata_runtime_core::processes::OwnedProcess;

struct External(Child);
impl Drop for External {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn python() -> String {
    let output = Command::new("python3")
        .args(["-I", "-S", "-c", "import sys;print(sys.executable)"])
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().into()
}

fn upstream() -> PathBuf {
    std::env::var_os("STRATA_TEST_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.reference/strata"))
}

fn wait_json(root: &Path, name: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(bytes) = fs::read(root.join(name)) {
            return serde_json::from_slice(&bytes).unwrap();
        }
        assert!(
            Instant::now() < deadline,
            "MCP fixture {name} did not arrive"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn pidfd(pid: u64) -> OwnedFd {
    let descriptor = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0u32) };
    assert!(descriptor >= 0, "real fixture process is not alive");
    unsafe { OwnedFd::from_raw_fd(descriptor as i32) }
}

fn exited(descriptor: &OwnedFd) -> bool {
    let mut poll = libc::pollfd {
        fd: descriptor.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    unsafe { libc::poll(&mut poll, 1, 0) > 0 }
}

fn wait_tree_exit(descriptors: &[OwnedFd], port: u16) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let address: SocketAddr = ([127, 0, 0, 1], port).into();
        if descriptors.iter().all(exited)
            && TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_err()
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "MCP descendant or TCP listener survived"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn owner(root: &Path, mode: &str) -> OwnedProcess {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut command = Command::new(python());
    command
        .arg("-u")
        .arg(manifest.join("tests/fixtures/mcp_stdio_fixture.py"))
        .arg("owner")
        .arg(root)
        .arg(mode)
        .arg(env!("CARGO_BIN_EXE_strata-supervisor"))
        .arg(manifest.join("resources"))
        .arg(upstream());
    OwnedProcess::spawn(
        command,
        Arc::new(Mutex::new(HashMap::new())),
        "mcp-owner-fixture",
    )
    .unwrap()
}

#[test]
fn official_stdio_unicode_term_grace_and_hard_kill_preserve_external_process() {
    for mode in ["natural", "grace", "ignore"] {
        let directory = tempfile::tempdir().unwrap();
        let mut external = External(Command::new("sleep").arg("120").spawn().unwrap());
        let mut owner = owner(directory.path(), mode);
        let ready = wait_json(directory.path(), "ready.json");
        let engine = wait_json(directory.path(), "engine.json");
        assert!(ready["echoBytes"].as_u64().unwrap() > 12000);
        let descendants = [
            ready["wrapper"].as_u64().unwrap(),
            ready["tool"].as_u64().unwrap(),
            engine["pid"].as_u64().unwrap(),
        ]
        .into_iter()
        .map(pidfd)
        .collect::<Vec<_>>();
        fs::write(directory.path().join("close"), b"close only isolated MCP").unwrap();
        assert_eq!(
            wait_json(directory.path(), "closed.json")["stdioClosed"],
            true
        );
        wait_tree_exit(&descendants, engine["port"].as_u64().unwrap() as u16);
        assert_eq!(directory.path().join("term.json").exists(), mode == "grace");
        assert!(
            owner.child.try_wait().unwrap().is_none(),
            "Strata owner must remain alive"
        );
        assert!(
            external.0.try_wait().unwrap().is_none(),
            "unrelated process must remain alive"
        );
        owner.stop().unwrap();
    }
}

#[test]
fn actual_strata_owner_sigkill_cleans_separate_mcp_session_and_tcp_grandchild() {
    let directory = tempfile::tempdir().unwrap();
    let mut external = External(Command::new("sleep").arg("120").spawn().unwrap());
    let mut owner = owner(directory.path(), "ignore");
    let ready = wait_json(directory.path(), "ready.json");
    let engine = wait_json(directory.path(), "engine.json");
    let owner_identity = pidfd(ready["owner"].as_u64().unwrap());
    let descendants = [
        ready["wrapper"].as_u64().unwrap(),
        ready["tool"].as_u64().unwrap(),
        engine["pid"].as_u64().unwrap(),
    ]
    .into_iter()
    .map(pidfd)
    .collect::<Vec<_>>();
    assert_eq!(
        unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                owner_identity.as_raw_fd(),
                libc::SIGKILL,
                std::ptr::null::<libc::siginfo_t>(),
                0u32,
            )
        },
        0
    );
    owner.child.wait().unwrap();
    wait_tree_exit(&descendants, engine["port"].as_u64().unwrap() as u16);
    assert!(external.0.try_wait().unwrap().is_none());
    owner.stop().unwrap();
}

#[test]
fn invalid_wrapper_arguments_fail_before_any_tool_or_runtime_initialization() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("must-not-exist");
    let output = Command::new(env!("CARGO_BIN_EXE_strata-supervisor"))
        .args([
            "--mcp-stdio",
            "--parent-pidfd",
            "1",
            "--ready-fd",
            "1",
            "--",
        ])
        .arg(python())
        .args([
            "-c",
            "import pathlib,sys;pathlib.Path(sys.argv[1]).write_text('unexpected')",
        ])
        .arg(&marker)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(!marker.exists());
}

#[test]
fn foreign_live_pidfd_is_rejected_before_starting_any_tool() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("must-not-exist");
    let code = r#"import os,subprocess,sys
foreign=subprocess.Popen(['sleep','120'])
pidfd=os.pidfd_open(foreign.pid,0)
reader,writer=os.pipe2(os.O_CLOEXEC)
try:
    command=[sys.argv[1],'--mcp-stdio','--parent-pidfd',str(pidfd),'--ready-fd',str(writer),'--',sys.executable,'-c',"import pathlib,sys;pathlib.Path(sys.argv[1]).write_text('unexpected')",sys.argv[2]]
    result=subprocess.run(command,pass_fds=(pidfd,writer),start_new_session=True,capture_output=True,timeout=10)
    assert result.returncode != 0
    assert b'current Strata parent' in result.stderr
    assert foreign.poll() is None
finally:
    os.close(pidfd);os.close(reader);os.close(writer)
    foreign.kill();foreign.wait(timeout=5)
"#;
    let output = Command::new(python())
        .args(["-I", "-S", "-c", code])
        .arg(env!("CARGO_BIN_EXE_strata-supervisor"))
        .arg(&marker)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!marker.exists());
}
