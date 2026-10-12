//! Opt-in, device-wide NVIDIA power caps for the lifetime of a managed service.
//! NVIDIA documents `--power-limit` and the supported range at:
//! https://docs.nvidia.com/deploy/nvidia-smi/index.html

use crate::processes::{Logs, OwnedProcess};
use serde_json::Value;
use std::{
    collections::HashSet,
    process::Command,
    sync::{atomic::Ordering, Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

const QUERY: &str = "--query-gpu=uuid,power.limit,power.min_limit,power.max_limit";
const OUTPUT_LIMIT: usize = 8192;
// nvidia-smi reports watts to two decimal places.
const WATT_TOLERANCE: f64 = 0.011;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PowerLimitRequest {
    pub watts: f64,
    pub device: u32,
}

/// Manager metadata, never forwarded as an engine argument. No cap means no
/// nvidia-smi invocation and no change to the existing startup behavior.
pub fn requested(config: &Value) -> Result<Option<PowerLimitRequest>, String> {
    let device = match config.get("manager_gpu_power_limit_device") {
        None | Some(Value::Null) => 0,
        Some(value) => value
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .ok_or("GPU 设备编号必须是 0 到 4294967295 的整数")?,
    };
    let watts = match config.get("manager_gpu_power_limit_watts") {
        None | Some(Value::Null) => return Ok(None),
        Some(value) => value
            .as_f64()
            .filter(|value| value.is_finite() && *value > 0.0)
            .ok_or("GPU 功耗上限必须是大于 0 的有限瓦数；关闭时请移除此设置")?,
    };
    Ok(Some(PowerLimitRequest { watts, device }))
}

#[derive(Debug)]
struct CommandOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

trait Runner: Send + Sync {
    fn run(&self, args: &[String]) -> Result<CommandOutput, String>;
}

struct NvidiaSmi;

impl Runner for NvidiaSmi {
    fn run(&self, args: &[String]) -> Result<CommandOutput, String> {
        let logs: Logs = Default::default();
        let mut command = Command::new("nvidia-smi");
        command.args(args);
        // OwnedProcess hides the window, owns all descendants and bounds each
        // log record and aggregate capture; no shell command is constructed.
        let mut process = OwnedProcess::spawn(command, logs.clone(), "gpu-power")
            .map_err(|error| format!("无法运行 NVIDIA 功耗工具 nvidia-smi：{error}"))?;
        let deadline = Instant::now() + Duration::from_secs(3);
        let exit_code = loop {
            let status = process.refresh()?;
            if !status.running {
                break status.exit_code;
            }
            if Instant::now() >= deadline {
                process.stop()?;
                return Err("NVIDIA 功耗工具 nvidia-smi 执行超时（3 秒）".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let pending = process.readers_pending.clone();
        drop(process);
        let drain_deadline = Instant::now() + Duration::from_millis(500);
        while pending.load(Ordering::Acquire) > 0 && Instant::now() < drain_deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if pending.load(Ordering::Acquire) > 0 {
            return Err("NVIDIA 功耗工具输出未在限定时间内读取完成".into());
        }
        let store = logs.lock().map_err(|error| error.to_string())?;
        let mut stdout = String::new();
        let mut stderr = String::new();
        if let Some(entries) = store.get("gpu-power") {
            for entry in entries {
                let output = if entry.level == "stdout" {
                    &mut stdout
                } else {
                    &mut stderr
                };
                if output.len() + entry.message.len() + 1 > OUTPUT_LIMIT {
                    return Err("NVIDIA 功耗工具输出超过 8 KiB，操作已取消".into());
                }
                output.push_str(&entry.message);
                output.push('\n');
            }
        }
        Ok(CommandOutput {
            success: exit_code == Some(0),
            stdout,
            stderr,
        })
    }
}

#[derive(Debug)]
struct Limits {
    uuid: String,
    current: f64,
    minimum: f64,
    maximum: f64,
}

fn command_error(action: &str, output: &CommandOutput) -> String {
    let detail = format!("{} {}", output.stderr.trim(), output.stdout.trim());
    let detail = detail.trim().chars().take(512).collect::<String>();
    let lowercase = detail.to_lowercase();
    if lowercase.contains("permission") || lowercase.contains("access denied") {
        format!("{action}失败：需要 NVIDIA 驱动允许的管理员/root 权限。{detail}")
    } else if lowercase.contains("not supported") || lowercase.contains("unsupported") {
        format!("{action}失败：此 GPU 或驱动不支持功耗上限。{detail}")
    } else {
        format!("{action}失败：{detail}")
    }
}

fn query(runner: &dyn Runner, device: &str) -> Result<Limits, String> {
    let output = runner.run(&[
        "-i".into(),
        device.into(),
        QUERY.into(),
        "--format=csv,noheader,nounits".into(),
    ])?;
    if !output.success {
        return Err(command_error("读取 GPU 功耗范围", &output));
    }
    let lines = output
        .stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>();
    if lines.len() != 1 {
        return Err("无法确定单张 NVIDIA GPU 的功耗范围".into());
    }
    let values = lines[0].split(',').map(str::trim).collect::<Vec<_>>();
    if values.len() != 4
        || !values[0].starts_with("GPU-")
        || values[0].len() > 128
        || !values[0]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("NVIDIA GPU 功耗信息格式无效".into());
    }
    let watts = |value: &str| -> Result<f64, String> {
        value
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite() && *value > 0.0)
            .ok_or_else(|| "此 GPU 或驱动不支持读取有效的功耗上限（N/A）".into())
    };
    let limits = Limits {
        uuid: values[0].into(),
        current: watts(values[1])?,
        minimum: watts(values[2])?,
        maximum: watts(values[3])?,
    };
    if limits.minimum > limits.maximum
        || limits.current < limits.minimum
        || limits.current > limits.maximum
    {
        return Err("NVIDIA 驱动返回了不一致的功耗范围".into());
    }
    Ok(limits)
}

fn set(runner: &dyn Runner, uuid: &str, watts: f64) -> Result<(), String> {
    let output = runner.run(&[
        "-i".into(),
        uuid.into(),
        "--power-limit".into(),
        watts.to_string(),
    ])?;
    if output.success {
        Ok(())
    } else {
        Err(command_error("设置 GPU 功耗上限", &output))
    }
}

fn verify(runner: &dyn Runner, uuid: &str, watts: f64) -> Result<(), String> {
    let limits = query(runner, uuid)?;
    if limits.uuid != uuid || (limits.current - watts).abs() > WATT_TOLERANCE {
        return Err(format!(
            "NVIDIA 驱动未应用请求的功耗上限：请求 {watts} W，读取 {} W",
            limits.current
        ));
    }
    Ok(())
}

fn claims() -> &'static Mutex<HashSet<String>> {
    static CLAIMS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CLAIMS.get_or_init(Default::default)
}

/// Must be attached to the owned process until its entire tree has stopped.
/// Explicit restore reports errors; Drop provides a best-effort backup for
/// startup failures and normal teardown. A hard manager crash cannot run Drop.
pub struct GpuPowerLease {
    runner: Arc<dyn Runner>,
    uuid: String,
    previous_watts: f64,
    applied_watts: f64,
    active: bool,
}

impl GpuPowerLease {
    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn apply(config: &Value) -> Result<Option<Self>, String> {
        Self::apply_with_runner(config, Arc::new(NvidiaSmi))
    }

    fn apply_with_runner(config: &Value, runner: Arc<dyn Runner>) -> Result<Option<Self>, String> {
        let Some(request) = requested(config)? else {
            return Ok(None);
        };
        // Serialize both changes and restoration, including the initial query.
        let mut claimed = claims().lock().map_err(|error| error.to_string())?;
        let limits = query(runner.as_ref(), &request.device.to_string())?;
        if claimed.contains(&limits.uuid) {
            return Err("此 GPU 已有受管服务使用功耗上限，或上次功耗恢复失败；请先停止相关服务，恢复失败时请检查 GPU 功耗后重新启动管理器".into());
        }
        if request.watts < limits.minimum || request.watts > limits.maximum {
            return Err(format!(
                "GPU {} 的功耗上限必须介于 {}–{} W；请求 {} W",
                request.device, limits.minimum, limits.maximum, request.watts
            ));
        }
        if (request.watts - limits.current).abs() > WATT_TOLERANCE {
            let result = set(runner.as_ref(), &limits.uuid, request.watts)
                .and_then(|()| verify(runner.as_ref(), &limits.uuid, request.watts));
            if let Err(error) = result {
                // A command can fail after it already changed the driver. Always
                // attempt rollback, then verify the original setting explicitly.
                let rollback = set(runner.as_ref(), &limits.uuid, limits.current)
                    .and_then(|()| verify(runner.as_ref(), &limits.uuid, limits.current));
                return Err(match rollback {
                    Ok(()) => format!("{error}；已恢复启动前的 GPU 功耗上限"),
                    Err(rollback) => {
                        // No lease can be returned on a failed startup. Keep a
                        // failed restoration claimed, so a later startup cannot
                        // adopt the unknown setting as a new baseline.
                        claimed.insert(limits.uuid.clone());
                        format!(
                            "{error}；恢复启动前 {} W 失败：{rollback}。请手动检查 GPU 功耗上限；重新启动管理器前不会再设置此 GPU",
                            limits.current
                        )
                    }
                });
            }
        }
        claimed.insert(limits.uuid.clone());
        Ok(Some(Self {
            runner,
            uuid: limits.uuid,
            previous_watts: limits.current,
            applied_watts: request.watts,
            active: true,
        }))
    }

    /// Restore only while the current limit still matches our managed limit,
    /// preserving changes made by another tool after startup. Query/set errors
    /// leave the lease active so the caller can retry and surface the error.
    pub fn restore(&mut self) -> Result<(), String> {
        if !self.active {
            return Ok(());
        }
        let mut claimed = claims().lock().map_err(|error| error.to_string())?;
        let current = query(self.runner.as_ref(), &self.uuid)?;
        if current.uuid != self.uuid {
            return Err("恢复 GPU 功耗上限时设备身份发生变化".into());
        }
        if (current.current - self.applied_watts).abs() > WATT_TOLERANCE {
            self.active = false;
            claimed.remove(&self.uuid);
            return Err(format!(
                "GPU 功耗上限已被其他程序改为 {} W，已保留该设置",
                current.current
            ));
        }
        if (current.current - self.previous_watts).abs() > WATT_TOLERANCE {
            set(self.runner.as_ref(), &self.uuid, self.previous_watts)?;
            verify(self.runner.as_ref(), &self.uuid, self.previous_watts)?;
        }
        self.active = false;
        claimed.remove(&self.uuid);
        Ok(())
    }
}

impl Drop for GpuPowerLease {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        collections::VecDeque,
        sync::atomic::{AtomicUsize, Ordering},
    };

    struct FakeRunner {
        uuid: String,
        replies: Mutex<VecDeque<(String, Result<CommandOutput, String>)>>,
    }

    impl FakeRunner {
        fn new() -> Arc<Self> {
            static NEXT: AtomicUsize = AtomicUsize::new(1);
            Arc::new(Self {
                uuid: format!("GPU-test-{}", NEXT.fetch_add(1, Ordering::Relaxed)),
                replies: Default::default(),
            })
        }

        fn query(&self, current: &str) {
            self.replies.lock().unwrap().push_back((
                QUERY.into(),
                Ok(CommandOutput {
                    success: true,
                    stdout: format!("{}, {current}, 150.00, 320.00\n", self.uuid),
                    stderr: String::new(),
                }),
            ));
        }

        fn set(&self, watts: &str, error: Option<&str>) {
            self.replies.lock().unwrap().push_back((
                format!("set {watts}"),
                Ok(CommandOutput {
                    success: error.is_none(),
                    stdout: String::new(),
                    stderr: error.unwrap_or_default().into(),
                }),
            ));
        }

        fn done(&self) {
            assert!(self.replies.lock().unwrap().is_empty());
        }
    }

    impl Runner for FakeRunner {
        fn run(&self, args: &[String]) -> Result<CommandOutput, String> {
            let (expected, reply) = self
                .replies
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected command");
            assert_eq!(args[0], "-i");
            if args[2] == "--power-limit" {
                assert_eq!(args[1], self.uuid, "writes must target stable UUID");
                assert_eq!(expected, format!("set {}", args[3]));
            } else {
                assert_eq!(expected, QUERY);
                assert_eq!(args[2], QUERY);
                assert_eq!(args[3], "--format=csv,noheader,nounits");
            }
            reply
        }
    }

    fn config(watts: f64) -> Value {
        json!({"manager_gpu_power_limit_watts": watts})
    }

    #[test]
    fn config_requires_positive_number_and_integer_device() {
        assert_eq!(requested(&json!({})).unwrap(), None);
        assert_eq!(
            requested(&json!({"manager_gpu_power_limit_watts": null})).unwrap(),
            None
        );
        assert_eq!(
            requested(&config(210.5)).unwrap().unwrap(),
            PowerLimitRequest {
                watts: 210.5,
                device: 0
            }
        );
        for value in [json!(0), json!(-1), json!("250"), json!(true)] {
            assert!(requested(&json!({"manager_gpu_power_limit_watts": value})).is_err());
        }
        for value in [json!(-1), json!(0.5), json!(4294967296u64)] {
            assert!(requested(&json!({"manager_gpu_power_limit_watts": 200, "manager_gpu_power_limit_device": value})).is_err());
        }
    }

    #[test]
    fn disabled_cap_does_not_execute_any_command() {
        let runner = FakeRunner::new();
        assert!(GpuPowerLease::apply_with_runner(&json!({}), runner.clone())
            .unwrap()
            .is_none());
        runner.done();
    }

    #[test]
    fn out_of_range_and_unsupported_do_not_write() {
        for watts in [149.9, 320.1] {
            let runner = FakeRunner::new();
            runner.query("320.00");
            assert!(
                GpuPowerLease::apply_with_runner(&config(watts), runner.clone())
                    .err()
                    .unwrap()
                    .contains("150–320 W")
            );
            runner.done();
        }
        let runner = FakeRunner::new();
        runner.query("N/A");
        assert!(
            GpuPowerLease::apply_with_runner(&config(200.0), runner.clone())
                .err()
                .unwrap()
                .contains("不支持")
        );
        runner.done();
    }

    #[test]
    fn applies_verifies_and_restores_previous_value_once() {
        let runner = FakeRunner::new();
        runner.query("300.00");
        runner.set("210.5", None);
        runner.query("210.50");
        let mut lease = GpuPowerLease::apply_with_runner(&config(210.5), runner.clone())
            .unwrap()
            .unwrap();
        runner.query("210.50");
        runner.set("300", None);
        runner.query("300.00");
        lease.restore().unwrap();
        lease.restore().unwrap();
        drop(lease);
        runner.done();
    }

    #[test]
    fn failed_verification_rolls_back_before_returning_error() {
        let runner = FakeRunner::new();
        runner.query("320.00");
        runner.set("200", None);
        runner.query("250.00");
        runner.set("320", None);
        runner.query("320.00");
        let error = GpuPowerLease::apply_with_runner(&config(200.0), runner.clone())
            .err()
            .unwrap();
        assert!(error.contains("未应用请求"));
        assert!(error.contains("已恢复启动前"));
        runner.done();
    }

    #[test]
    fn permission_error_and_rollback_failure_are_explicit() {
        let runner = FakeRunner::new();
        runner.query("320.00");
        runner.set("200", Some("Insufficient Permissions"));
        runner.set("320", Some("Insufficient Permissions"));
        let error = GpuPowerLease::apply_with_runner(&config(200.0), runner.clone())
            .err()
            .unwrap();
        assert!(error.contains("管理员/root"));
        assert!(error.contains("恢复启动前 320 W 失败"));
        assert!(claims().lock().unwrap().contains(&runner.uuid));
        runner.query("320.00");
        let retry = GpuPowerLease::apply_with_runner(&config(200.0), runner.clone())
            .err()
            .unwrap();
        assert!(retry.contains("已有受管服务"));
        runner.done();
    }

    #[test]
    fn external_power_change_is_preserved_and_releases_claim() {
        let runner = FakeRunner::new();
        runner.query("320.00");
        runner.set("200", None);
        runner.query("200.00");
        let mut lease = GpuPowerLease::apply_with_runner(&config(200.0), runner.clone())
            .unwrap()
            .unwrap();
        runner.query("180.00");
        assert!(lease.restore().unwrap_err().contains("已保留"));
        drop(lease);
        assert!(!claims().lock().unwrap().contains(&runner.uuid));
        runner.done();
    }

    #[test]
    fn same_gpu_cannot_have_overlapping_service_leases() {
        let runner = FakeRunner::new();
        runner.query("200.00");
        let mut lease = GpuPowerLease::apply_with_runner(&config(200.0), runner.clone())
            .unwrap()
            .unwrap();
        runner.query("200.00");
        let error = GpuPowerLease::apply_with_runner(&config(250.0), runner.clone())
            .err()
            .unwrap();
        assert!(error.contains("已有受管服务"));
        runner.query("200.00");
        lease.restore().unwrap();
        drop(lease);
        runner.done();
    }

    #[test]
    fn drop_restores_after_startup_failure() {
        let runner = FakeRunner::new();
        runner.query("300.00");
        runner.set("200", None);
        runner.query("200.00");
        let lease = GpuPowerLease::apply_with_runner(&config(200.0), runner.clone())
            .unwrap()
            .unwrap();
        runner.query("200.00");
        runner.set("300", None);
        runner.query("300.00");
        drop(lease);
        runner.done();
    }

    #[test]
    fn restore_failure_keeps_lease_available_for_retry() {
        let runner = FakeRunner::new();
        runner.query("300.00");
        runner.set("200", None);
        runner.query("200.00");
        let mut lease = GpuPowerLease::apply_with_runner(&config(200.0), runner.clone())
            .unwrap()
            .unwrap();
        runner.query("200.00");
        runner.set("300", Some("Insufficient Permissions"));
        assert!(lease.restore().unwrap_err().contains("管理员/root"));
        assert!(lease.active);
        runner.query("200.00");
        runner.set("300", None);
        runner.query("300.00");
        lease.restore().unwrap();
        drop(lease);
        runner.done();
    }

    #[test]
    #[cfg(any(windows, unix))]
    fn stopping_owned_process_restores_attached_lease() {
        let runner = FakeRunner::new();
        runner.query("300.00");
        runner.set("200", None);
        runner.query("200.00");
        let lease = GpuPowerLease::apply_with_runner(&config(200.0), runner.clone())
            .unwrap()
            .unwrap();
        runner.query("200.00");
        runner.set("300", None);
        runner.query("300.00");
        #[cfg(windows)]
        let command = {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ]);
            command
        };
        #[cfg(unix)]
        let command = {
            let mut command = Command::new("/bin/sleep");
            command.arg("30");
            command
        };
        let mut process =
            OwnedProcess::spawn(command, Default::default(), "gpu-power-lifecycle").unwrap();
        process.gpu_power_lease = Some(lease);
        process.stop().unwrap();
        assert!(process.gpu_power_lease.is_none());
        drop(process);
        runner.done();
    }

    #[test]
    #[cfg(any(windows, unix))]
    fn natural_process_exit_restores_attached_lease() {
        let runner = FakeRunner::new();
        runner.query("300.00");
        runner.set("200", None);
        runner.query("200.00");
        let lease = GpuPowerLease::apply_with_runner(&config(200.0), runner.clone())
            .unwrap()
            .unwrap();
        runner.query("200.00");
        runner.set("300", None);
        runner.query("300.00");
        #[cfg(windows)]
        let command = {
            let mut command = Command::new("cmd.exe");
            command.args(["/C", "exit", "0"]);
            command
        };
        #[cfg(unix)]
        let command = Command::new("/bin/true");
        let mut process =
            OwnedProcess::spawn(command, Default::default(), "gpu-power-natural-exit").unwrap();
        process.gpu_power_lease = Some(lease);
        let deadline = Instant::now() + Duration::from_secs(3);
        while process.refresh().unwrap().running {
            assert!(Instant::now() < deadline, "fixture process did not exit");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(process.gpu_power_lease.is_none());
        drop(process);
        runner.done();
    }
}
