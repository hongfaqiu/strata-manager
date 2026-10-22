#![cfg_attr(not(windows), allow(dead_code))]
//! Reads AMD telemetry from a helper child process instead of loading the vendor library here.
//!
//! #124 / #127: from 0.2.12 the supervisor loaded ADLX (`amdadlx64.dll`) into its own process the
//! first time the monitor read `/metrics` of a local service. That happens a few seconds into every
//! start, while the engine is still loading. A fault inside the driver library is not a Rust panic,
//! so `catch_unwind` cannot contain it: the supervisor process died, its Job object took the
//! loading engine down with it, and the UI only saw the IPC pipe close
//! (`supervisor_unavailable: 读取后台消息失败: unexpected end of file`).
//!
//! The library now runs in a short-lived child (`<supervisor> --amd-adlx-telemetry`) that prints
//! one JSON line per sample. If it crashes, only the readings disappear; the next attempt waits
//! [`RETRY_AFTER_FAILURE`]. The child exits when this process closes its stdin or stops reading.

use super::AmdGpuSample;
use std::io::{BufRead, BufReader};
use std::process::Child;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub(super) const IDLE_EXIT: Duration = Duration::from_secs(30);
pub(super) const STALE_AFTER: Duration = Duration::from_secs(5);
pub(super) const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(300);

pub(super) type Spawn = fn() -> std::io::Result<Child>;

struct Shared {
    latest: Option<(Instant, Vec<AmdGpuSample>)>,
    last_read: Option<Instant>,
    running: bool,
    failed_at: Option<Instant>,
}

pub(super) struct IsolatedReader {
    shared: Mutex<Shared>,
    spawn: Spawn,
    idle_exit: Duration,
}

impl IsolatedReader {
    pub(super) const fn new(spawn: Spawn, idle_exit: Duration) -> Self {
        Self {
            shared: Mutex::new(Shared {
                latest: None,
                last_read: None,
                running: false,
                failed_at: None,
            }),
            spawn,
            idle_exit,
        }
    }

    /// Latest sample, starting the helper when needed. The first call after a start returns
    /// `None` until the helper has read the GPUs once.
    pub(super) fn snapshot(&'static self) -> Option<Vec<AmdGpuSample>> {
        let mut shared = self.shared.lock().ok()?;
        shared.last_read = Some(Instant::now());
        let may_start = shared
            .failed_at
            .is_none_or(|at| at.elapsed() >= RETRY_AFTER_FAILURE);
        if !shared.running && may_start {
            match (self.spawn)() {
                Ok(child) => {
                    shared.running = true;
                    let started = std::thread::Builder::new()
                        .name("amd-telemetry-reader".into())
                        .spawn(move || self.pump(child));
                    if started.is_err() {
                        shared.running = false;
                        shared.failed_at = Some(Instant::now());
                    }
                }
                Err(_) => shared.failed_at = Some(Instant::now()),
            }
        }
        shared
            .latest
            .as_ref()
            .filter(|(at, _)| at.elapsed() < STALE_AFTER)
            .map(|(_, gpus)| gpus.clone())
    }

    /// Reads the helper's lines until nobody has asked for a sample for `idle_exit`, or until the
    /// helper exits on its own (no driver, no AMD GPU, or a crash in the vendor library).
    fn pump(&self, mut child: Child) {
        let mut stopped_idle = false;
        if let Some(stdout) = child.stdout.take() {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(gpus) = serde_json::from_str::<Vec<AmdGpuSample>>(&line) else {
                    continue;
                };
                let Ok(mut shared) = self.shared.lock() else {
                    break;
                };
                shared.latest = Some((Instant::now(), gpus));
                if shared
                    .last_read
                    .is_none_or(|at| at.elapsed() > self.idle_exit)
                {
                    stopped_idle = true;
                    break;
                }
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        if let Ok(mut shared) = self.shared.lock() {
            shared.running = false;
            shared.latest = None;
            if !stopped_idle {
                shared.failed_at = Some(Instant::now());
            }
        }
    }

    #[cfg(all(test, unix))]
    fn state(&self) -> (bool, bool, bool) {
        let shared = self.shared.lock().unwrap();
        (
            shared.running,
            shared.latest.is_some(),
            shared.failed_at.is_some(),
        )
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    fn shell(script: &str) -> std::io::Result<Child> {
        Command::new("sh")
            .args(["-c", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
    }
    fn streaming() -> std::io::Result<Child> {
        shell(
            r#"while true; do echo '[{"name":"RX 9070 XT","util":12.0,"mem_used":1048576.0}]'; sleep 0.05; done"#,
        )
    }
    fn crashing() -> std::io::Result<Child> {
        // A native fault in the vendor library ends the helper with a signal and no output.
        shell("kill -SEGV $$")
    }
    fn crashing_after_sample() -> std::io::Result<Child> {
        shell(r#"echo 'not json'; echo '[{"name":"RX 7900 XTX"}]'; sleep 0.2; kill -SEGV $$"#)
    }
    fn missing() -> std::io::Result<Child> {
        Err(std::io::Error::from(std::io::ErrorKind::NotFound))
    }

    fn wait_until(mut done: impl FnMut() -> bool) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(10) {
            if done() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn helper_samples_reach_the_caller() {
        let reader: &'static IsolatedReader =
            Box::leak(Box::new(IsolatedReader::new(streaming, IDLE_EXIT)));
        assert_eq!(reader.snapshot(), None, "first read only starts the helper");
        assert!(wait_until(|| reader.snapshot().is_some()));
        let gpus = reader.snapshot().unwrap();
        assert_eq!(gpus[0].name.as_deref(), Some("RX 9070 XT"));
        assert_eq!(gpus[0].util, Some(12.0));
    }

    #[test]
    fn crashing_helper_only_loses_readings_and_is_not_restarted_at_once() {
        let reader: &'static IsolatedReader =
            Box::leak(Box::new(IsolatedReader::new(crashing, IDLE_EXIT)));
        assert_eq!(reader.snapshot(), None);
        assert!(wait_until(|| reader.state() == (false, false, true)));
        // This process (the supervisor in production) is still here, and the failure backs off.
        assert_eq!(reader.snapshot(), None);
        assert_eq!(reader.state(), (false, false, true));
    }

    #[test]
    fn helper_crash_after_samples_clears_stale_readings() {
        let reader: &'static IsolatedReader = Box::leak(Box::new(IsolatedReader::new(
            crashing_after_sample,
            IDLE_EXIT,
        )));
        reader.snapshot();
        assert!(wait_until(|| reader.snapshot().is_some()));
        assert!(wait_until(|| reader.state() == (false, false, true)));
        assert_eq!(reader.snapshot(), None);
    }

    #[test]
    fn unreadable_helper_is_reported_as_no_telemetry() {
        let reader: &'static IsolatedReader =
            Box::leak(Box::new(IsolatedReader::new(missing, IDLE_EXIT)));
        assert_eq!(reader.snapshot(), None);
        assert_eq!(reader.state(), (false, false, true));
    }

    #[test]
    fn idle_helper_is_stopped_without_counting_as_failure() {
        let reader: &'static IsolatedReader = Box::leak(Box::new(IsolatedReader::new(
            streaming,
            Duration::from_millis(200),
        )));
        reader.snapshot();
        assert!(wait_until(|| reader.state() == (false, false, false)));
        // Reading again starts a new helper right away.
        reader.snapshot();
        assert!(wait_until(|| reader.snapshot().is_some()));
    }
}
