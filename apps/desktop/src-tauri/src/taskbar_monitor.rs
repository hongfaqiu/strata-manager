//! Taskbar presentation uses an isolated, read-only Win32 helper process.
//! No Tauri/WebView HWND is ever parented to Explorer.
#[cfg(any(windows, test))]
use serde::Deserialize;
use serde::Serialize;
#[cfg(any(windows, test))]
use serde_json::json;
use serde_json::Value;
#[cfg(any(windows, test))]
use std::collections::VecDeque;
#[cfg(any(windows, test))]
use std::io::{BufRead, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

#[cfg(windows)]
#[path = "taskbar_host.rs"]
mod host;
#[cfg(any(windows, test))]
#[path = "taskbar_layout.rs"]
mod layout;

#[cfg(any(windows, test))]
pub(crate) const MAX_FRAME: usize = 16 * 1024;
#[cfg(any(windows, test))]
pub(crate) const METRICS: [&str; 11] = [
    "generation",
    "prefill",
    "gpu",
    "vram",
    "cpu",
    "ram",
    "temperature",
    "power",
    "running",
    "queued",
    "cache",
];

#[cfg(any(windows, test))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Preferences {
    pub metrics: Vec<String>,
    pub font_size: u32,
    pub layout: String,
    pub show_graphs: bool,
    pub show_labels: bool,
    pub show_units: bool,
    #[serde(default)]
    pub english: bool,
}

#[cfg(any(windows, test))]
impl Preferences {
    pub fn normalize(value: &Value) -> Self {
        let mut metrics = Vec::new();
        if let Some(values) = value["metrics"].as_array() {
            for id in values.iter().filter_map(Value::as_str) {
                if METRICS.contains(&id) && !metrics.iter().any(|x| x == id) && metrics.len() < 8 {
                    metrics.push(id.to_owned());
                }
            }
        }
        if metrics.is_empty() {
            metrics = METRICS[..6].iter().map(|x| (*x).into()).collect();
        }
        Self {
            metrics,
            font_size: value["fontSize"].as_u64().unwrap_or(16).clamp(12, 24) as u32,
            layout: value["layout"]
                .as_str()
                .filter(|x| matches!(*x, "compact" | "twoRow" | "panel"))
                .unwrap_or("twoRow")
                .into(),
            show_graphs: value["showGraphs"] != false,
            show_labels: value["showLabels"] != false,
            show_units: value["showUnits"] != false,
            english: value["language"] == "en" || value["english"] == true,
        }
    }
    pub fn valid(&self) -> bool {
        let value = serde_json::to_value(self).unwrap_or(Value::Null);
        let normalized = Self::normalize(&value);
        (12..=24).contains(&self.font_size)
            && self.metrics == normalized.metrics
            && self.layout == normalized.layout
    }
}

#[cfg(any(windows, test))]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SampleIdentity {
    profile: Option<String>,
    pid: Option<u64>,
    started_at: Option<u64>,
    creation_time: Option<String>,
    model: Option<String>,
}

#[cfg(any(windows, test))]
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Sample {
    pub state: String,
    pub values: [Option<f64>; 11],
    pub identity: SampleIdentity,
    pub sampled_at: u64,
}

#[cfg(any(windows, test))]
fn number(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite() && *n >= 0.0)
}
#[cfg(any(windows, test))]
fn gpu_number(hw: &Value, aggregate: &str, card: &str, mode: &str) -> Option<f64> {
    if let Some(value) = number(&hw[aggregate]) {
        return Some(value);
    }
    let values: Vec<_> = hw["gpus"]
        .as_array()?
        .iter()
        .filter_map(|gpu| number(&gpu[card]))
        .collect();
    if values.is_empty() {
        return None;
    }
    let sum: f64 = values.iter().sum();
    Some(match mode {
        "mean" => sum / values.len() as f64,
        "max" => values.into_iter().fold(0.0, f64::max),
        _ => sum,
    })
}
#[cfg(any(windows, test))]
pub(crate) fn sample(snapshot: &Value) -> Sample {
    let online = snapshot["phase"] == "online" && snapshot["health"]["loaded"] == true;
    let live = &snapshot["metrics"]["live"];
    let hw = &snapshot["metrics"]["hardware"];
    let last = &snapshot["metrics"]["requests"][0];
    let english = snapshot["settings"]["language"] == "en";
    let t = |cn, en| if english { en } else { cn };
    let mut values = [None; 11];
    let state = if online {
        match live["state"].as_str() {
            Some("generating") => t("生成中", "Generating"),
            Some("reading" | "prefill") => t("读取中", "Reading"),
            Some("idle") => t("空闲", "Idle"),
            _ => t("状态未知", "Unknown state"),
        }
    } else {
        match snapshot["phase"].as_str() {
            Some("stopped") => t("未启动", "Stopped"),
            Some("none") => t("未选择服务", "No service selected"),
            Some("online") => t("未加载模型", "No model loaded"),
            _ => t("连接不可用", "Unavailable"),
        }
    };
    if online {
        // Throughput remains strictly live; the desktop view can separately
        // label historical idle values. A native live graph never repeats history.
        values[0] = if live["state"] == "generating" {
            number(&live["tok_s"])
        } else {
            None
        };
        values[1] = if matches!(live["state"].as_str(), Some("reading" | "prefill")) {
            number(&live["prefill_tok_s_mean"])
        } else {
            None
        };
        values[2] = gpu_number(hw, "gpu_util", "util", "mean").filter(|v| *v <= 100.0);
        values[3] = gpu_number(hw, "gpu_mem_used", "mem_used", "sum").map(|v| v / 1_073_741_824.0);
        values[4] = number(&hw["cpu"]).filter(|v| *v <= 100.0);
        values[5] = number(&hw["ram_used"]).map(|v| v / 1_073_741_824.0);
        values[6] = gpu_number(hw, "gpu_temp", "temp", "max");
        values[7] = gpu_number(hw, "gpu_power", "power", "sum");
        values[8] = number(&live["running"]);
        values[9] = number(&live["queued"]);
        values[10] = number(&last["hit_rate"])
            .filter(|v| *v <= 1.0)
            .map(|v| v * 100.0);
    }
    Sample {
        state: state.into(),
        values,
        identity: SampleIdentity {
            profile: snapshot["profile"]["id"].as_str().map(str::to_owned),
            pid: snapshot["process"]["pid"].as_u64(),
            started_at: snapshot["process"]["startedAt"].as_u64(),
            creation_time: snapshot["process"]["creationTime"]
                .as_str()
                .map(str::to_owned),
            model: snapshot["metrics"]["engine"]["model"]
                .as_str()
                .map(str::to_owned),
        },
        // A failed read still carries a fresh unavailable state, with no values.
        // Successful samples retain the collector's original measurement time.
        sampled_at: snapshot["sampledAt"].as_u64().unwrap_or_else(|| {
            if online {
                0
            } else {
                strata_runtime_core::types::now()
            }
        }),
    }
}

#[cfg(any(windows, test))]
#[derive(Default)]
pub(crate) struct SampleHistory {
    pub current: Sample,
    pub points: VecDeque<[Option<f64>; 11]>,
    last_timestamp: u64,
}

#[cfg(any(windows, test))]
impl SampleHistory {
    fn fresh(timestamp: u64, now: u64) -> bool {
        timestamp > 0
            && timestamp <= now.saturating_add(2_000)
            && now.saturating_sub(timestamp) <= 6_000
    }

    pub fn accept(&mut self, sample: Sample, now: u64, english: bool) -> bool {
        if self.current.identity != sample.identity {
            self.points.clear();
            self.last_timestamp = 0;
        }
        if !Self::fresh(sample.sampled_at, now) {
            self.current.identity = sample.identity;
            self.current.sampled_at = sample.sampled_at;
            self.clear_stale(english);
            return true;
        }
        // An explicit unavailable/stopped frame invalidates data even if a
        // coarse source clock gives it the same timestamp as the last sample.
        if sample.values.iter().all(Option::is_none) {
            self.points.clear();
            self.last_timestamp = self.last_timestamp.max(sample.sampled_at);
            self.current = sample;
            return true;
        }
        // Duplicate/out-of-order frames neither extend a graph nor refresh TTL.
        if sample.sampled_at <= self.last_timestamp {
            return false;
        }
        self.last_timestamp = sample.sampled_at;
        if self.points.len() == 60 {
            self.points.pop_front();
        }
        let mut point = sample.values;
        // Cache is the last completed request's hit rate, not a live series.
        point[10] = None;
        self.points.push_back(point);
        self.current = sample;
        true
    }

    fn clear_stale(&mut self, english: bool) {
        self.current.values = [None; 11];
        self.current.state = if english {
            "Sample expired"
        } else {
            "采样已过期"
        }
        .into();
        self.points.clear();
    }

    pub fn expire(&mut self, now: u64, english: bool) -> bool {
        if !Self::fresh(self.current.sampled_at, now)
            && (self.current.values.iter().any(Option::is_some) || !self.points.is_empty())
        {
            self.clear_stale(english);
            return true;
        }
        false
    }
}

#[cfg(any(windows, test))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum ParentFrame {
    Configure { preferences: Preferences },
    Snapshot { sample: Box<Sample> },
    Shutdown {},
}

#[cfg(any(windows, test))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum HostFrame {
    Ready {},
    Failed {
        message: String,
    },
    Preferences {
        metrics: Vec<String>,
        show_graphs: bool,
    },
    Floating {},
    Settings {},
    Close {},
}

#[cfg(any(windows, test))]
pub(crate) fn read_frame<R: BufRead, T: serde::de::DeserializeOwned>(
    reader: &mut R,
) -> Result<Option<T>, String> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(|e| e.to_string())?;
        if available.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err("辅助进程协议帧未完成".into())
            };
        }
        let count = available
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(available.len());
        if bytes.len() + count > MAX_FRAME {
            return Err("辅助进程协议帧过大".into());
        }
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count);
        if bytes.last() == Some(&b'\n') {
            break;
        }
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "辅助进程协议无效".into())
}

#[cfg(any(windows, test))]
pub(crate) fn write_frame<W: Write, T: Serialize>(writer: &mut W, value: &T) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() + 1 > MAX_FRAME {
        return Err("辅助进程协议帧过大".into());
    }
    bytes.push(b'\n');
    writer
        .write_all(&bytes)
        .and_then(|_| writer.flush())
        .map_err(|e| e.to_string())
}

#[derive(Clone, Serialize)]
pub(crate) struct ModeStatus {
    mode: &'static str,
    supported: bool,
    active: bool,
    message: String,
}
impl Default for ModeStatus {
    fn default() -> Self {
        Self {
            mode: "floating",
            supported: cfg!(windows),
            active: false,
            message: if cfg!(windows) {
                "任务栏宽条为实验性适配，挂载时验证可用空间"
            } else {
                "当前平台不支持原生任务栏宽条，保留桌面浮条"
            }
            .into(),
        }
    }
}

#[derive(Default)]
struct Inner {
    status: ModeStatus,
    #[cfg(windows)]
    session: Option<std::sync::Arc<Session>>,
}

#[derive(Default)]
pub(crate) struct TaskbarMonitorState {
    inner: Mutex<Inner>,
    switching: tokio::sync::Mutex<()>,
}

pub(crate) fn maybe_run_host() -> bool {
    if !std::env::args_os()
        .skip(1)
        .any(|arg| arg == "--strata-taskbar-host")
    {
        return false;
    }
    #[cfg(windows)]
    host::run();
    true
}

fn require_window(window: &WebviewWindow) -> Result<(), String> {
    if matches!(window.label(), "main" | "service-monitor") {
        Ok(())
    } else {
        Err("此窗口不能切换监控呈现模式".into())
    }
}

fn publish(app: &AppHandle, status: &ModeStatus) {
    let _ = app.emit_to("main", "monitor-mode-status", status);
    let _ = app.emit_to(
        crate::floating_monitor::LABEL,
        "monitor-mode-status",
        status,
    );
}

#[tauri::command]
pub(crate) fn monitor_mode_status(app: AppHandle, window: WebviewWindow) -> Result<Value, String> {
    require_window(&window)?;
    let state = app.state::<TaskbarMonitorState>();
    let inner = state.inner.lock().map_err(|e| e.to_string())?;
    serde_json::to_value(&inner.status).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn set_monitor_mode(
    app: AppHandle,
    window: WebviewWindow,
    mode: String,
    preferences: Value,
) -> Result<Value, String> {
    require_window(&window)?;
    if !matches!(mode.as_str(), "floating" | "taskbar") {
        return Err("未知监控呈现模式".into());
    }
    let state = app.state::<TaskbarMonitorState>();
    if mode == "floating" {
        open_floating(&app).await?;
    } else {
        let _switch = state.switching.lock().await;
        #[cfg(windows)]
        start(&app, Preferences::normalize(&preferences)).await?;
        #[cfg(not(windows))]
        {
            let _ = preferences;
            crate::floating_monitor::open_window(&app).await?;
        }
    }
    let inner = state.inner.lock().map_err(|e| e.to_string())?;
    serde_json::to_value(&inner.status).map_err(|e| e.to_string())
}

/// All user-facing restore entries share the presentation switch lock. The
/// lower-level open_window stays independent so startup failure can recover.
pub(crate) async fn open_floating(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<TaskbarMonitorState>();
    let _switch = state.switching.lock().await;
    open_floating_locked(app).await
}

async fn open_floating_locked(app: &AppHandle) -> Result<(), String> {
    crate::floating_monitor::open_window(app).await?;
    stop(app, "已切换到桌面浮条".into());
    Ok(())
}

fn stop(app: &AppHandle, message: String) {
    let state = app.state::<TaskbarMonitorState>();
    let status = {
        let Ok(mut inner) = state.inner.lock() else {
            return;
        };
        #[cfg(windows)]
        if let Some(session) = inner.session.take() {
            session.stop();
        }
        inner.status = ModeStatus {
            message,
            ..ModeStatus::default()
        };
        inner.status.clone()
    };
    publish(app, &status);
}

pub(crate) fn shutdown(app: &AppHandle) {
    stop(app, "任务栏监控已关闭".into());
}

/// Settings application only updates a live presentation. It never starts a host.
pub(crate) fn apply_preferences(app: &AppHandle, settings: &Value) -> Result<(), String> {
    #[cfg(windows)]
    {
        let state = app.state::<TaskbarMonitorState>();
        let session = state
            .inner
            .lock()
            .map_err(|e| e.to_string())?
            .session
            .clone();
        if let Some(session) = session.filter(|s| !s.cancellation.is_cancelled()) {
            let mut preferences = Preferences::normalize(&settings["floatingMonitor"]);
            preferences.english = settings["language"] == "en";
            session
                .input
                .try_send(ParentFrame::Configure { preferences })
                .map_err(|_| "任务栏偏好队列暂时繁忙".to_owned())?;
        }
    }
    #[cfg(not(windows))]
    let _ = (app, settings);
    Ok(())
}

impl Drop for TaskbarMonitorState {
    fn drop(&mut self) {
        #[cfg(windows)]
        if let Ok(inner) = self.inner.get_mut() {
            if let Some(session) = inner.session.take() {
                session.stop();
            }
        }
    }
}

#[cfg(windows)]
struct Session {
    id: uuid::Uuid,
    child: Mutex<std::process::Child>,
    input: std::sync::mpsc::SyncSender<ParentFrame>,
    cancellation: tokio_util::sync::CancellationToken,
}

#[cfg(windows)]
impl Session {
    fn stop(&self) {
        self.cancellation.cancel();
        let _ = self.input.try_send(ParentFrame::Shutdown {});
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(windows)]
impl Drop for Session {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(windows)]
async fn start(app: &AppHandle, preferences: Preferences) -> Result<(), String> {
    use std::{
        io::BufReader,
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        sync::{mpsc, Arc},
        time::Duration,
    };
    let state = app.state::<TaskbarMonitorState>();
    let existing = state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .session
        .clone();
    if let Some(existing) = existing {
        if !existing.cancellation.is_cancelled() {
            existing
                .input
                .try_send(ParentFrame::Configure { preferences })
                .map_err(|_| "任务栏偏好队列繁忙，请稍后重试")?;
            return Ok(());
        }
    }
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut child = match Command::new(executable)
        .arg("--strata-taskbar-host")
        .creation_flags(0x08000000)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            crate::floating_monitor::open_window(app).await?;
            stop(app, format!("任务栏辅助进程启动失败：{error}"));
            return Ok(());
        }
    };
    let mut stdin = child.stdin.take().ok_or("辅助进程输入管道不可用")?;
    let stdout = child.stdout.take().ok_or("辅助进程输出管道不可用")?;
    let (input, input_rx) = mpsc::sync_channel::<ParentFrame>(4);
    let (events, mut events_rx) = tokio::sync::mpsc::channel::<Result<HostFrame, String>>(8);
    let session = Arc::new(Session {
        id: uuid::Uuid::new_v4(),
        child: Mutex::new(child),
        input,
        cancellation: tokio_util::sync::CancellationToken::new(),
    });
    std::thread::spawn(move || {
        while let Ok(frame) = input_rx.recv() {
            if write_frame(&mut stdin, &frame).is_err() {
                break;
            }
        }
    });
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let next = match read_frame::<_, HostFrame>(&mut reader) {
                Ok(Some(frame)) => Ok(frame),
                Ok(None) => Err("任务栏辅助进程已退出".into()),
                Err(error) => Err(error),
            };
            let done = next.is_err();
            if events.blocking_send(next).is_err() || done {
                break;
            }
        }
    });
    session
        .input
        .try_send(ParentFrame::Configure { preferences })
        .map_err(|e| e.to_string())?;
    // A valid first sample is not required for readiness: stopped services remain
    // stopped and render placeholders while the independent read is pending.
    session
        .input
        .try_send(ParentFrame::Snapshot {
            sample: Box::new(sample(&Value::Null)),
        })
        .map_err(|e| e.to_string())?;
    state.inner.lock().map_err(|e| e.to_string())?.session = Some(session.clone());
    let (ready, ready_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let event_session = session.clone();
    let event_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut ready = Some(ready);
        loop {
            let event = tokio::select! { _ = event_session.cancellation.cancelled() => break, item = events_rx.recv() => item.unwrap_or_else(|| Err("任务栏辅助进程已断开".into())) };
            match event {
                Ok(HostFrame::Ready {}) => {
                    if let Some(tx) = ready.take() {
                        let _ = tx.send(Ok(()));
                    }
                }
                Ok(HostFrame::Preferences {
                    metrics,
                    show_graphs,
                }) => {
                    let valid = !metrics.is_empty()
                        && metrics.len() <= 8
                        && metrics.iter().all(|x| METRICS.contains(&x.as_str()));
                    if valid {
                        let _ = event_app.emit_to(
                            "main",
                            "monitor-preferences-patch",
                            json!({"metrics":metrics,"showGraphs":show_graphs,"mode":"taskbar"}),
                        );
                    }
                }
                Ok(HostFrame::Settings {}) => {
                    let _ = crate::floating_monitor::show_main(&event_app, Some("settings".into()));
                }
                Ok(HostFrame::Floating {}) => {
                    recover(&event_app, &event_session, "已切换到桌面浮条".into(), true).await;
                    break;
                }
                Ok(HostFrame::Close {}) => {
                    let state = event_app.state::<TaskbarMonitorState>();
                    let _switch = state.switching.lock().await;
                    if current(&event_app, &event_session) {
                        stop(&event_app, "任务栏监控已关闭".into());
                        let _ = event_app.emit_to(
                            "main",
                            "monitor-preferences-patch",
                            json!({"mode":"floating"}),
                        );
                    }
                    break;
                }
                Ok(HostFrame::Failed { message }) | Err(message) => {
                    let message: String = message.chars().take(512).collect();
                    if let Some(tx) = ready.take() {
                        let _ = tx.send(Err(message));
                    } else {
                        recover(&event_app, &event_session, message, true).await;
                    }
                    break;
                }
            }
        }
    });
    match tokio::time::timeout(Duration::from_secs(10), ready_rx).await {
        Ok(Ok(Ok(())))
            if !session.cancellation.is_cancelled()
                && session
                    .child
                    .lock()
                    .is_ok_and(|mut child| child.try_wait().is_ok_and(|exit| exit.is_none())) =>
        {
            if let Some(window) = app.get_webview_window(crate::floating_monitor::LABEL) {
                if let Err(error) = window.hide() {
                    session.stop();
                    stop(app, format!("无法切换桌面浮条：{error}"));
                    return Ok(());
                }
            }
            let status = ModeStatus {
                mode: "taskbar",
                supported: true,
                active: true,
                message: "原生任务栏宽条已启用（实验性适配）".into(),
            };
            state.inner.lock().map_err(|e| e.to_string())?.status = status.clone();
            publish(app, &status);
        }
        result => {
            session.stop();
            let reason = match result {
                Ok(Ok(Err(message))) => message,
                _ => "任务栏宿主未在时限内完成首帧绘制".into(),
            };
            crate::floating_monitor::open_window(app).await?;
            stop(app, format!("已回到桌面浮条：{reason}"));
            return Ok(());
        }
    }
    let sampler_app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let snapshot = async {
                let state = sampler_app.state::<crate::ClientState>();
                let directory = state.ipc.data_dir.clone();
                let client = state.client.clone();
                crate::floating_monitor::collect_snapshot(move |method, params| {
                    let directory = directory.clone();
                    let client = client.clone();
                    async move {
                        crate::floating_monitor::read_existing(&directory, &client, method, params)
                            .await
                    }
                })
                .await
                .unwrap_or(Value::Null)
            };
            let value = tokio::select! { _ = session.cancellation.cancelled() => break, value = snapshot => value };
            // A bounded queue may be temporarily busy (for example during a
            // native menu). A skipped sample is not proof that the host exited.
            if matches!(
                session.input.try_send(ParentFrame::Snapshot {
                    sample: Box::new(sample(&value))
                }),
                Err(std::sync::mpsc::TrySendError::Disconnected(_))
            ) {
                recover(
                    &sampler_app,
                    &session,
                    "任务栏辅助进程输入已断开".into(),
                    true,
                )
                .await;
                break;
            }
            tokio::select! { _ = session.cancellation.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(1)) => {} }
        }
    });
    Ok(())
}

#[cfg(windows)]
fn current(app: &AppHandle, session: &Session) -> bool {
    app.state::<TaskbarMonitorState>()
        .inner
        .lock()
        .ok()
        .and_then(|inner| inner.session.as_ref().map(|x| x.id))
        == Some(session.id)
}

#[cfg(windows)]
async fn recover(app: &AppHandle, session: &Session, message: String, show: bool) {
    let state = app.state::<TaskbarMonitorState>();
    let _switch = state.switching.lock().await;
    if !current(app, session) {
        return;
    }
    if show {
        if let Err(error) = crate::floating_monitor::open_window(app).await {
            stop(app, format!("{message}；桌面浮条恢复失败：{error}"));
            let _ = crate::floating_monitor::show_main(app, Some("settings".into()));
            return;
        }
    }
    stop(app, format!("已回到桌面浮条：{message}"));
    let _ = app.emit_to(
        "main",
        "monitor-preferences-patch",
        json!({"mode":"floating"}),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protocol_has_bounds_and_rejects_unapproved_actions() {
        assert!(read_frame::<_, HostFrame>(&mut &b"{\"type\":\"startModel\"}\n"[..]).is_err());
        assert!(read_frame::<_, HostFrame>(
            &mut &b"{\"type\":\"ready\",\"command\":\"start\"}\n"[..]
        )
        .is_err());
        assert!(read_frame::<_, HostFrame>(&mut vec![b'x'; MAX_FRAME + 1].as_slice()).is_err());
        assert!(read_frame::<_, HostFrame>(&mut &b"{\"type\":\"ready\"}"[..]).is_err());
        assert!(read_frame::<_, HostFrame>(&mut &b""[..]).unwrap().is_none());
        let frame = ParentFrame::Snapshot {
            sample: Box::new(fixture_sample(1000)),
        };
        let mut encoded = Vec::new();
        write_frame(&mut encoded, &frame).unwrap();
        let Some(ParentFrame::Snapshot { sample }) = read_frame(&mut encoded.as_slice()).unwrap()
        else {
            panic!("wrong protocol frame");
        };
        assert_eq!(sample.sampled_at, 1000);
        assert_eq!(sample.identity.profile.as_deref(), Some("profile-a"));
    }
    #[test]
    fn stopped_or_unloaded_never_reuses_numeric_values() {
        for phase in ["stopped", "unavailable", "none", "online"] {
            let value = json!({"phase":phase,"health":{"loaded":false},"metrics":{"live":{"state":"generating","tok_s":90},"hardware":{"cpu":99}}});
            assert_eq!(sample(&value).values, [None; 11]);
        }
    }
    #[test]
    fn reading_and_output_have_independent_live_values() {
        let mut value = json!({"phase":"online","health":{"loaded":true},"metrics":{"live":{"state":"reading","tok_s":90,"prefill_tok_s_mean":2200},"hardware":{"cpu":50,"gpu_util":101,"gpu_mem_used":2147483648u64}}});
        let reading = sample(&value);
        assert_eq!(
            &reading.values[..5],
            &[None, Some(2200.), None, Some(2.), Some(50.)]
        );
        value["metrics"]["live"]["state"] = json!("generating");
        assert_eq!(&sample(&value).values[..2], &[Some(90.), None]);
        value["metrics"]["live"]["state"] = json!("prefill");
        assert_eq!(&sample(&value).values[..2], &[None, Some(2200.)]);
    }
    #[test]
    fn gpu_fallback_aggregates_and_cache_uses_latest_request() {
        let value = json!({"phase":"online","health":{"loaded":true},"metrics":{"live":{"state":"idle","cache_hit_rate":0.99},"requests":[{"hit_rate":0.25}],"hardware":{"gpus":[{"util":20,"mem_used":1073741824u64,"temp":60,"power":90},{"util":60,"mem_used":2147483648u64,"temp":70,"power":110}]}}});
        let current = sample(&value);
        assert_eq!(current.values[2], Some(40.));
        assert_eq!(current.values[3], Some(3.));
        assert_eq!(current.values[6], Some(70.));
        assert_eq!(current.values[7], Some(200.));
        assert_eq!(current.values[10], Some(25.));
    }
    #[test]
    fn preference_metrics_are_valid_unique_and_bounded() {
        let prefs = Preferences::normalize(
            &json!({"metrics":["generation","bad","generation","prefill"],"fontSize":200,"layout":"unknown"}),
        );
        assert_eq!(prefs.metrics, vec!["generation", "prefill"]);
        assert_eq!(prefs.font_size, 24);
        assert!(prefs.valid());
        assert_eq!(Preferences::normalize(&Value::Null).metrics.len(), 6);
    }

    fn fixture_sample(sampled_at: u64) -> Sample {
        sample(
            &json!({"phase":"online","sampledAt":sampled_at,"profile":{"id":"profile-a"},"process":{"pid":20,"startedAt":100,"creationTime":"creation-a"},"health":{"loaded":true},"metrics":{"engine":{"model":"model-a"},"live":{"state":"generating","tok_s":90},"requests":[{"hit_rate":0.5}],"hardware":{"cpu":50}}}),
        )
    }

    #[test]
    fn every_runtime_identity_component_starts_new_history() {
        let initial = fixture_sample(1000);
        for component in 0..5 {
            let mut timeline = SampleHistory::default();
            timeline.accept(initial.clone(), 1000, false);
            let mut changed = fixture_sample(1001);
            match component {
                0 => changed.identity.profile = Some("profile-b".into()),
                1 => changed.identity.pid = Some(21),
                2 => changed.identity.started_at = Some(101),
                3 => changed.identity.creation_time = Some("creation-b".into()),
                _ => changed.identity.model = Some("model-b".into()),
            }
            assert!(timeline.accept(changed.clone(), 1001, false));
            assert_eq!(timeline.points.len(), 1, "component {component}");
            assert_eq!(timeline.current.identity, changed.identity);
        }
    }

    #[test]
    fn timestamps_deduplicate_and_do_not_refresh_expired_values() {
        let initial = fixture_sample(1000);
        let mut timeline = SampleHistory::default();
        assert!(timeline.accept(initial.clone(), 1000, false));
        assert!(!timeline.accept(initial.clone(), 2000, false));
        assert!(!timeline.accept(fixture_sample(999), 2000, false));
        assert_eq!(timeline.points.len(), 1);
        assert!(timeline.expire(7001, true));
        assert_eq!(timeline.current.values, [None; 11]);
        assert!(timeline.points.is_empty());
        timeline.accept(initial, 7002, true);
        assert_eq!(timeline.current.values, [None; 11]);
        assert_eq!(timeline.current.state, "Sample expired");
        assert!(timeline.accept(fixture_sample(7003), 7003, false));
        assert_eq!(timeline.points.len(), 1);
    }

    #[test]
    fn unavailable_clears_history_and_historical_cache_has_no_live_graph() {
        let mut timeline = SampleHistory::default();
        let mut current = fixture_sample(1000);
        timeline.accept(current.clone(), 1000, false);
        assert_eq!(timeline.current.values[10], Some(50.));
        assert_eq!(timeline.points[0][10], None);
        current.state = "未启动".into();
        current.values = [None; 11];
        timeline.accept(current, 1000, false);
        assert_eq!(timeline.current.state, "未启动");
        assert_eq!(timeline.current.values, [None; 11]);
        assert!(timeline.points.is_empty());
        // Replaying a duplicate online frame cannot resurrect cleared values.
        assert!(!timeline.accept(fixture_sample(1000), 1001, false));
        assert_eq!(timeline.current.values, [None; 11]);
    }

    #[test]
    fn invalid_or_delayed_timestamps_never_become_live_telemetry() {
        for (timestamp, now) in [(0, 1000), (1, 10000), (10000, 1000)] {
            let mut timeline = SampleHistory::default();
            timeline.accept(fixture_sample(timestamp), now, false);
            assert_eq!(timeline.current.values, [None; 11]);
            assert!(timeline.points.is_empty());
        }
        let mut timeline = SampleHistory::default();
        for now in 1000..1100 {
            timeline.accept(fixture_sample(now), now, false);
        }
        assert_eq!(timeline.points.len(), 60);
    }
}
