//! Taskbar presentation uses an isolated, read-only Win32 helper process.
//! No Tauri/WebView HWND is ever parented to Explorer.
#[cfg(any(windows, test))]
use serde::Deserialize;
use serde::Serialize;
#[cfg(any(windows, test))]
use serde_json::json;
use serde_json::Value;
#[cfg(any(windows, test))]
use std::collections::{BTreeMap, VecDeque};
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
#[path = "taskbar_widget.rs"]
pub(crate) mod widget;

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
    pub show_status: bool,
    #[serde(default)]
    pub metric_colors: BTreeMap<String, String>,
    #[serde(default)]
    pub english: bool,
    /// Ring + item selection of the native taskbar widget.
    #[serde(default)]
    pub widget: widget::WidgetPrefs,
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
        // Inspect only the fixed metric allowlist. Colors are exact six-digit
        // hex strings; whitespace, CSS functions and unknown keys are ignored.
        let metric_colors = METRICS
            .iter()
            .filter_map(|metric| {
                let color = value["metricColors"][*metric].as_str()?;
                (color.len() == 7
                    && color.starts_with('#')
                    && color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit))
                .then(|| ((*metric).to_owned(), color.to_ascii_lowercase()))
            })
            .collect();
        Self {
            metrics,
            font_size: value["fontSize"]
                .as_f64()
                .filter(|size| size.is_finite())
                .unwrap_or(16.0)
                .round()
                .clamp(8.0, 36.0) as u32,
            layout: value["layout"]
                .as_str()
                .filter(|x| matches!(*x, "compact" | "twoRow" | "panel"))
                .unwrap_or("twoRow")
                .into(),
            show_graphs: value["showGraphs"] != false,
            show_labels: value["showLabels"] != false,
            show_units: value["showUnits"] != false,
            show_status: value["showStatus"] == true,
            metric_colors,
            english: value["language"]
                .as_str()
                .map(|language| crate::system_locale::uses_english_fallback(Some(language)))
                .unwrap_or_else(|| value["english"].as_bool().unwrap_or(true)),
            widget: widget::WidgetPrefs::normalize(&value["taskbar"]),
        }
    }

    fn from_settings(settings: &Value) -> Self {
        let mut preferences = Self::normalize(&settings["floatingMonitor"]);
        preferences.english =
            crate::system_locale::uses_english_fallback(settings["language"].as_str());
        preferences
    }

    pub fn valid(&self) -> bool {
        let value = serde_json::to_value(self).unwrap_or(Value::Null);
        let normalized = Self::normalize(&value);
        (8..=36).contains(&self.font_size)
            && self.metrics == normalized.metrics
            && self.layout == normalized.layout
            && self.metric_colors.len() <= METRICS.len()
            && self.metric_colors == normalized.metric_colors
            && self.widget.valid()
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
    /// Status accent of the taskbar widget.
    #[serde(default)]
    pub tone: widget::Tone,
    /// Total VRAM in GiB, for the VRAM ring.
    #[serde(default)]
    pub vram_total: Option<f64>,
    /// Context ring: tokens of the current (idle: last) request and the
    /// model's maximum context, as on the overview "上下文" gauge.
    #[serde(default)]
    pub context_used: Option<f64>,
    #[serde(default)]
    pub context_total: Option<f64>,
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
    let live = &snapshot["metrics"]["live"];
    let hw = &snapshot["metrics"]["hardware"];
    let last = &snapshot["metrics"]["requests"][0];
    let english =
        crate::system_locale::uses_english_fallback(snapshot["settings"]["language"].as_str());
    let t = |cn, en| if english { en } else { cn };
    let mut values = [None; 11];
    let transition = if snapshot["phase"] == "online" {
        match live["state"].as_str() {
            Some("loading") => Some(t("正在载入模型", "Loading model")),
            Some("unloading") => Some(t("正在释放模型", "Releasing model")),
            _ => None,
        }
    } else {
        None
    };
    let online = snapshot["phase"] == "online"
        && snapshot["health"]["loaded"] == true
        && transition.is_none();
    let state = if let Some(label) = transition {
        label
    } else if online {
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
    let tone = if transition.is_some() {
        widget::Tone::Loading
    } else if online {
        match live["state"].as_str() {
            Some("generating" | "reading" | "prefill") => widget::Tone::Busy,
            _ => widget::Tone::Ready,
        }
    } else {
        match snapshot["phase"].as_str() {
            Some("stopped" | "none" | "online") => widget::Tone::Stopped,
            _ => widget::Tone::Error,
        }
    };
    let mut vram_total = None;
    let (mut context_used, mut context_total) = (None, None);
    if online {
        // Same source as OverviewDashboard's context gauge.
        context_total = number(&snapshot["metrics"]["engine"]["max_context"])
            .or_else(|| number(&snapshot["health"]["max_context"]))
            .filter(|v| *v > 0.0);
        let (prompt, generated) = if live["state"] == "idle" {
            (
                number(&last["prompt_tokens"]),
                number(&last["output_tokens"]),
            )
        } else {
            (number(&live["prompt_tokens"]), number(&live["generated"]))
        };
        context_used = prompt.zip(generated).map(|(p, g)| p + g);
        vram_total =
            gpu_number(hw, "gpu_mem_total", "mem_total", "sum").map(|v| v / 1_073_741_824.0);
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
        tone,
        vram_total,
        context_used,
        context_total,
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
        self.current.vram_total = None;
        self.current.context_used = None;
        self.current.context_total = None;
        self.current.tone = widget::Tone::Error;
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
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TaskbarPlacement {
    NotificationLeft,
    LeftSide,
    RightSide,
}

#[cfg(any(windows, test))]
fn placement_message(placement: Option<TaskbarPlacement>, english: bool) -> String {
    match (placement, english) {
        (Some(TaskbarPlacement::NotificationLeft), false) => "已显示在主屏任务栏通知区左侧",
        (Some(TaskbarPlacement::LeftSide), false) => "已显示在主屏任务栏左侧空位",
        (Some(TaskbarPlacement::RightSide), false) => "已显示在主屏任务栏右侧空位",
        (None, false) => "已显示在主屏任务栏",
        (Some(TaskbarPlacement::NotificationLeft), true) => {
            "Shown to the left of the notification area on the primary taskbar"
        }
        (Some(TaskbarPlacement::LeftSide), true) => {
            "Shown in a free space on the left side of the primary taskbar"
        }
        (Some(TaskbarPlacement::RightSide), true) => {
            "Shown in a free space on the right side of the primary taskbar"
        }
        (None, true) => "Shown on the primary taskbar",
    }
    .into()
}

#[cfg(any(windows, test))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum HostFrame {
    Ready {
        #[serde(default)]
        placement: Option<TaskbarPlacement>,
    },
    Failed {
        message: String,
    },
    /// Ring/item selection changed from the widget's context menu.
    Widget {
        widget: widget::WidgetPrefs,
    },
    /// Left click or "打开 Strata Manager".
    Main {},
    Floating {},
    Settings {},
    /// "自定义颜色…": open the colour rows of the taskbar settings.
    Colors {},
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
    visible: bool,
    message: String,
}
impl Default for ModeStatus {
    fn default() -> Self {
        Self {
            mode: "floating",
            supported: cfg!(windows),
            active: false,
            visible: false,
            message: if cfg!(windows) {
                "任务栏监控挂载时会验证主屏任务栏的可用空间"
            } else {
                "任务栏监控仅支持 Windows，保留桌面浮条"
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

fn require_mode(mode: &str) -> Result<(), String> {
    if matches!(mode, "floating" | "taskbar") {
        Ok(())
    } else {
        Err("未知监控呈现模式".into())
    }
}

fn with_visibility(mut status: ModeStatus, floating_visible: bool) -> ModeStatus {
    status.visible = status.active || floating_visible;
    status
}

fn floating_visible(app: &AppHandle) -> bool {
    app.get_webview_window(crate::floating_monitor::LABEL)
        .is_some_and(|window| window.is_visible().unwrap_or(false))
}

fn current_status(app: &AppHandle) -> Result<ModeStatus, String> {
    let stored = {
        let state = app
            .try_state::<TaskbarMonitorState>()
            .ok_or("监控状态尚未初始化")?;
        let inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.status.clone()
    };
    // Never hold inner while querying the UI thread: Destroyed callbacks can
    // simultaneously notify visibility and must be able to acquire that mutex.
    Ok(with_visibility(stored, floating_visible(app)))
}

fn emit_status(app: &AppHandle, status: &ModeStatus) {
    let _ = app.emit_to("main", "monitor-mode-status", status);
    let _ = app.emit_to(
        crate::floating_monitor::LABEL,
        "monitor-mode-status",
        status,
    );
}

fn publish(app: &AppHandle, status: &ModeStatus) {
    emit_status(app, &with_visibility(status.clone(), floating_visible(app)));
}

/// Window destruction/tray hiding only updates presentation state. It must
/// never recreate the strip or resume sampling in an existing hidden webview.
pub(crate) fn notify_visibility(app: &AppHandle) {
    if let Ok(status) = current_status(app) {
        emit_status(app, &status);
    }
}

#[tauri::command]
pub(crate) fn monitor_mode_status(app: AppHandle, window: WebviewWindow) -> Result<Value, String> {
    require_window(&window)?;
    serde_json::to_value(current_status(&app)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn set_monitor_mode(
    app: AppHandle,
    window: WebviewWindow,
    mode: String,
    preferences: Value,
) -> Result<Value, String> {
    require_window(&window)?;
    require_mode(&mode)?;
    let state = app.state::<TaskbarMonitorState>();
    let _switch = state.switching.lock().await;
    set_mode_locked(&app, &mode, preferences).await?;
    serde_json::to_value(current_status(&app)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn set_monitor_visibility(
    app: AppHandle,
    window: WebviewWindow,
    visible: bool,
    mode: String,
    preferences: Value,
) -> Result<Value, String> {
    require_window(&window)?;
    require_mode(&mode)?;
    let state = app.state::<TaskbarMonitorState>();
    let _switch = state.switching.lock().await;
    if visible {
        set_mode_locked(&app, &mode, preferences).await?;
    } else {
        close_monitor_locked(&app)?;
    }
    serde_json::to_value(current_status(&app)?).map_err(|e| e.to_string())
}

/// The strip's "收起到任务栏监控" entry: the taskbar widget replaces the strip
/// and stays on for the next launch, exactly like the settings switch. There is
/// no separate tray readout any more; the app's tray icon stays plain.
#[tauri::command]
pub(crate) async fn move_monitor_to_taskbar(
    app: AppHandle,
    window: WebviewWindow,
    preferences: Value,
) -> Result<Value, String> {
    if window.label() != crate::floating_monitor::LABEL {
        return Err("该操作仅允许监控浮条调用".into());
    }
    #[cfg(not(windows))]
    {
        let _ = (app, preferences);
        Err("任务栏监控仅支持 Windows，保留桌面浮条".into())
    }
    #[cfg(windows)]
    {
        let state = app.state::<TaskbarMonitorState>();
        let _switch = state.switching.lock().await;
        set_mode_locked(&app, "taskbar", preferences).await?;
        let status = current_status(&app)?;
        if status.mode == "taskbar" && status.active {
            let _ = app.emit_to(
                "main",
                "monitor-preferences-patch",
                json!({"taskbarEnabled": true}),
            );
        }
        serde_json::to_value(status).map_err(|e| e.to_string())
    }
}

async fn set_mode_locked(app: &AppHandle, mode: &str, preferences: Value) -> Result<(), String> {
    if mode == "floating" {
        open_floating_locked(app).await
    } else {
        #[cfg(windows)]
        start(app, Preferences::normalize(&preferences)).await?;
        #[cfg(not(windows))]
        {
            let _ = preferences;
            crate::floating_monitor::open_window(app).await?;
        }
        notify_visibility(app);
        Ok(())
    }
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

fn stopped_status(app: &AppHandle, message: String) -> Result<ModeStatus, String> {
    let state = app.state::<TaskbarMonitorState>();
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let session = inner.session.take();
    inner.status = ModeStatus {
        message,
        ..ModeStatus::default()
    };
    let status = inner.status.clone();
    drop(inner);
    #[cfg(windows)]
    if let Some(session) = session {
        session.stop();
    }
    Ok(status)
}

fn stop(app: &AppHandle, message: String) {
    if let Ok(status) = stopped_status(app, message) {
        publish(app, &status);
    }
}

fn close_monitor_locked(app: &AppHandle) -> Result<(), String> {
    // Closing is not a switch to floating: preserve the user's saved mode and
    // never invoke open_window here. Destroy the webview to stop its poll loop.
    stopped_status(app, "监控显示已关闭".into())?;
    let result = if let Some(window) = app.get_webview_window(crate::floating_monitor::LABEL) {
        // If native destruction fails after hiding, the explicit suspension
        // still prevents the hidden renderer from restarting its polling loop.
        let _ = window.emit("monitor-suspended", ());
        window
            .hide()
            .and_then(|()| window.destroy())
            .map_err(|error| error.to_string())
    } else {
        Ok(())
    };
    notify_visibility(app);
    result
}

pub(crate) fn shutdown(app: &AppHandle) {
    stop(app, "任务栏监控已关闭".into());
}

/// Restores the taskbar widget on launch when the user left it switched on.
/// A failure falls back to the desktop strip exactly like a manual start.
pub(crate) fn restore_on_launch(app: &AppHandle, settings: &Value) {
    #[cfg(windows)]
    if settings["floatingMonitor"]["taskbarEnabled"] == true {
        let app = app.clone();
        let preferences = Preferences::from_settings(settings);
        tauri::async_runtime::spawn(async move {
            // Let Explorer and the main window settle after sign-in.
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let state = app.state::<TaskbarMonitorState>();
            let _switch = state.switching.lock().await;
            if let Err(error) = start(&app, preferences).await {
                stop(&app, format!("任务栏监控恢复失败：{error}"));
            }
            notify_visibility(&app);
        });
    }
    #[cfg(not(windows))]
    let _ = (app, settings);
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
            let preferences = Preferences::from_settings(settings);

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
    let english = preferences.english;
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
    let (ready, ready_rx) =
        tokio::sync::oneshot::channel::<Result<Option<TaskbarPlacement>, String>>();
    let event_session = session.clone();
    let event_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut ready = Some(ready);
        loop {
            let event = tokio::select! { _ = event_session.cancellation.cancelled() => break, item = events_rx.recv() => item.unwrap_or_else(|| Err("任务栏辅助进程已断开".into())) };
            match event {
                Ok(HostFrame::Ready { placement }) => {
                    if let Some(tx) = ready.take() {
                        let _ = tx.send(Ok(placement));
                    } else {
                        // Rebuilt/repositioned hosts report their actual location.
                        // Serialize with close/switch, but never hide or open a
                        // window again after the initial readiness handshake.
                        let state = event_app.state::<TaskbarMonitorState>();
                        let _switch = state.switching.lock().await;
                        let status = {
                            let mut inner = match state.inner.lock() {
                                Ok(inner) => inner,
                                Err(_) => continue,
                            };
                            if inner.status.active
                                && inner
                                    .session
                                    .as_ref()
                                    .is_some_and(|session| session.id == event_session.id)
                            {
                                inner.status.message = placement_message(placement, english);
                                Some(inner.status.clone())
                            } else {
                                None
                            }
                        };
                        if let Some(status) = status {
                            publish(&event_app, &status);
                        }
                    }
                }
                Ok(HostFrame::Widget { widget }) => {
                    if widget.valid() {
                        let _ = event_app.emit_to(
                            "main",
                            "monitor-preferences-patch",
                            json!({"taskbar":widget}),
                        );
                    }
                }
                Ok(HostFrame::Main {}) => {
                    let _ = crate::floating_monitor::show_main(&event_app, None);
                }
                Ok(HostFrame::Settings {}) => {
                    let _ = crate::floating_monitor::show_main(&event_app, Some("settings".into()));
                }
                Ok(HostFrame::Colors {}) => {
                    let _ = crate::floating_monitor::show_main(
                        &event_app,
                        Some("taskbarColors".into()),
                    );
                }
                Ok(HostFrame::Floating {}) => {
                    let _ = event_app.emit_to(
                        "main",
                        "monitor-preferences-patch",
                        json!({"taskbarEnabled":false}),
                    );
                    recover(&event_app, &event_session, "已切换到桌面浮条".into(), true).await;
                    break;
                }
                Ok(HostFrame::Close {}) => {
                    let state = event_app.state::<TaskbarMonitorState>();
                    let _switch = state.switching.lock().await;
                    if current(&event_app, &event_session) {
                        let _ = event_app.emit_to(
                            "main",
                            "monitor-preferences-patch",
                            json!({"taskbarEnabled":false}),
                        );
                        if let Err(error) = close_monitor_locked(&event_app) {
                            let _ = event_app.emit_to("main", "tray-action-error", error);
                        }
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
        Ok(Ok(Ok(placement)))
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
                visible: true,
                message: placement_message(placement, english),
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
    fn new_language_packs_use_english_native_text_and_keep_host_preferences() {
        for language in ["zh-TW", "ja", "ko", "de", "fr", "es", "pt", "ru"] {
            assert!(
                Preferences::normalize(&json!({"language":language})).english,
                "{language}"
            );
            let stopped = sample(&json!({"phase":"stopped","settings":{"language":language}}));
            assert_eq!(stopped.state, "Stopped", "{language}");
        }
        assert!(!Preferences::normalize(&json!({"language":"zh-CN"})).english);
        assert!(!Preferences::normalize(&json!({"english":false})).english);
        assert!(Preferences::normalize(&Value::Null).english);
    }
    #[test]
    fn visible_status_requires_an_actual_surface_without_changing_taskbar_active() {
        let unopened = with_visibility(ModeStatus::default(), false);
        assert!(!unopened.visible);
        assert!(!unopened.active);
        let floating = with_visibility(ModeStatus::default(), true);
        assert!(floating.visible);
        assert!(!floating.active);
        let taskbar = ModeStatus {
            mode: "taskbar",
            active: true,
            ..ModeStatus::default()
        };
        let taskbar = with_visibility(taskbar, false);
        assert!(taskbar.visible && taskbar.active);
        // A previously visible stored snapshot cannot keep a hidden strip on.
        let hidden = with_visibility(floating, false);
        assert!(!hidden.visible);
        assert!(!hidden.active);
        assert_eq!(serde_json::to_value(hidden).unwrap()["visible"], false);
    }

    #[test]
    fn visibility_and_mode_commands_share_the_same_mode_allowlist() {
        assert!(require_mode("floating").is_ok());
        assert!(require_mode("taskbar").is_ok());
        for mode in ["", "tray", "startModel", "stopService"] {
            assert!(require_mode(mode).is_err());
        }
    }
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
    fn ready_accepts_legacy_missing_placement_and_rejects_unknown_locations() {
        let legacy = read_frame::<_, HostFrame>(&mut &b"{\"type\":\"ready\"}\n"[..]).unwrap();
        assert!(matches!(legacy, Some(HostFrame::Ready { placement: None })));
        for placement in [
            json!("nearClock"),
            json!("notification-left"),
            json!("NotificationLeft"),
            json!(3),
            json!({}),
        ] {
            let mut encoded = Vec::new();
            write_frame(&mut encoded, &json!({"type":"ready","placement":placement})).unwrap();
            assert!(read_frame::<_, HostFrame>(&mut encoded.as_slice()).is_err());
        }
        assert_eq!(placement_message(None, false), "已显示在主屏任务栏");
        assert_eq!(
            placement_message(None, true),
            "Shown on the primary taskbar"
        );
    }

    #[test]
    fn ready_placement_roundtrips_and_selects_the_matching_localized_message() {
        for (placement, wire_name, chinese, english) in [
            (
                TaskbarPlacement::NotificationLeft,
                "notificationLeft",
                "已显示在主屏任务栏通知区左侧",
                "Shown to the left of the notification area on the primary taskbar",
            ),
            (
                TaskbarPlacement::LeftSide,
                "leftSide",
                "已显示在主屏任务栏左侧空位",
                "Shown in a free space on the left side of the primary taskbar",
            ),
            (
                TaskbarPlacement::RightSide,
                "rightSide",
                "已显示在主屏任务栏右侧空位",
                "Shown in a free space on the right side of the primary taskbar",
            ),
        ] {
            let frame = HostFrame::Ready {
                placement: Some(placement),
            };
            assert_eq!(
                serde_json::to_value(&frame).unwrap()["placement"],
                wire_name
            );
            let mut encoded = Vec::new();
            write_frame(&mut encoded, &frame).unwrap();
            let Some(HostFrame::Ready { placement: decoded }) =
                read_frame(&mut encoded.as_slice()).unwrap()
            else {
                panic!("wrong ready frame");
            };
            assert_eq!(decoded, Some(placement));
            assert_eq!(placement_message(decoded, false), chinese);
            assert_eq!(placement_message(decoded, true), english);
        }
    }
    #[test]
    fn stopped_or_unloaded_never_reuses_numeric_values() {
        for phase in ["stopped", "unavailable", "none", "online"] {
            let value = json!({"phase":phase,"health":{"loaded":false},"metrics":{"live":{"state":"generating","tok_s":90},"hardware":{"cpu":99}}});
            assert_eq!(sample(&value).values, [None; 11]);
        }
    }
    #[test]
    fn model_transitions_override_loaded_flag_and_clear_old_values() {
        for (state, chinese, english) in [
            ("loading", "正在载入模型", "Loading model"),
            ("unloading", "正在释放模型", "Releasing model"),
        ] {
            for loaded in [false, true] {
                let snapshot = json!({"phase":"online","health":{"loaded":loaded},"metrics":{"live":{"state":state,"tok_s":90,"prefill_tok_s_mean":2200},"requests":[{"decode_tok_s":80,"hit_rate":0.5}],"hardware":{"cpu":99}}});
                for (language, label) in [("zh-CN", chinese), ("en", english)] {
                    let mut localized = snapshot.clone();
                    localized["settings"] = json!({"language":language});
                    let current = sample(&localized);
                    assert_eq!(current.state, label);
                    assert_eq!(current.values, [None; 11]);
                }
                for phase in ["stopped", "unavailable", "none"] {
                    let mut stale = snapshot.clone();
                    stale["phase"] = json!(phase);
                    let current = sample(&stale);
                    assert_ne!(current.state, chinese);
                    assert_eq!(current.values, [None; 11]);
                }
            }
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
        assert_eq!(prefs.font_size, 36);
        assert!(prefs.valid());
        assert_eq!(Preferences::normalize(&Value::Null).metrics.len(), 6);
        let without_labels = Preferences::normalize(
            &json!({"metrics":["generation","prefill"],"showLabels":false,"showStatus":false}),
        );
        assert!(!without_labels.show_labels);
        assert!(!without_labels.show_status);
        assert_eq!(without_labels.metrics, vec!["generation", "prefill"]);
        assert!(without_labels.valid());
    }

    #[test]
    fn metric_colors_normalize_only_exact_six_digit_hex_for_known_metrics() {
        let preferences = Preferences::normalize(&json!({"metricColors":{
            "generation":"#Aa00Ff", "prefill":"#123456", "gpu":"#fff",
            "vram":"#gg0000", "cpu":"red", "ram":"#123456 ",
            "temperature":" #123456", "power":"url(javascript:alert(1))",
            "running":"var(--color)", "queued":"#123456;display:none", "cache":123,
            "unknown":"#abcdef", "__proto__":"#abcdef", "constructor":"#abcdef"
        }}));
        assert_eq!(
            preferences.metric_colors,
            BTreeMap::from([
                ("generation".into(), "#aa00ff".into()),
                ("prefill".into(), "#123456".into()),
            ])
        );
        assert!(preferences.valid());
        for invalid in [
            "",
            "123456",
            "#12345",
            "#1234567",
            "#123456\n",
            "\t#123456",
            "#１２３４５６",
        ] {
            assert!(
                Preferences::normalize(&json!({"metricColors":{"generation":invalid}}))
                    .metric_colors
                    .is_empty()
            );
        }
        for invalid in [Value::Null, json!([]), json!("#123456")] {
            assert!(Preferences::normalize(&json!({"metricColors":invalid}))
                .metric_colors
                .is_empty());
        }
    }

    #[test]
    fn metric_color_protocol_validation_requires_canonical_bounded_entries() {
        let mut preferences = Preferences::normalize(&Value::Null);
        for metric in METRICS {
            preferences
                .metric_colors
                .insert(metric.into(), "#123abc".into());
        }
        assert_eq!(preferences.metric_colors.len(), 11);
        assert!(preferences.valid());
        preferences
            .metric_colors
            .insert("unknown".into(), "#123abc".into());
        assert!(!preferences.valid());
        preferences.metric_colors.remove("unknown");
        for invalid in ["#ABCDEF", "#123abc ", "red", "#123abc;color:red"] {
            preferences
                .metric_colors
                .insert("generation".into(), invalid.into());
            assert!(!preferences.valid());
        }
    }

    #[test]
    fn configure_accepts_legacy_missing_colors_and_roundtrips_settings_colors() {
        let settings = json!({"language":"en","floatingMonitor":{"showStatus":true,"metricColors":{"generation":"#1FE3A2","prefill":"#64ABFF"}}});
        // This is the same normalization path used by apply_preferences before
        // it sends Configure to the existing helper; no host starts in this test.
        let preferences = Preferences::from_settings(&settings);
        let mut encoded = Vec::new();
        write_frame(
            &mut encoded,
            &ParentFrame::Configure {
                preferences: preferences.clone(),
            },
        )
        .unwrap();
        let Some(ParentFrame::Configure {
            preferences: decoded,
        }) = read_frame(&mut encoded.as_slice()).unwrap()
        else {
            panic!("wrong configure frame");
        };
        assert_eq!(decoded.metric_colors, preferences.metric_colors);
        assert_eq!(decoded.metric_colors["generation"], "#1fe3a2");
        assert_eq!(decoded.metric_colors["prefill"], "#64abff");
        assert!(decoded.english && decoded.show_status && decoded.valid());
        let mut legacy = serde_json::to_value(ParentFrame::Configure { preferences }).unwrap();
        legacy["preferences"]
            .as_object_mut()
            .unwrap()
            .remove("metricColors");
        legacy["preferences"]
            .as_object_mut()
            .unwrap()
            .remove("showStatus");
        let mut encoded = Vec::new();
        write_frame(&mut encoded, &legacy).unwrap();
        let Some(ParentFrame::Configure {
            preferences: decoded,
        }) = read_frame(&mut encoded.as_slice()).unwrap()
        else {
            panic!("wrong legacy configure frame");
        };
        assert!(decoded.metric_colors.is_empty());
        assert!(!decoded.show_status);
        assert!(decoded.valid());
    }

    #[test]
    fn show_status_is_opt_in_and_ignores_non_boolean_values() {
        assert!(!Preferences::normalize(&Value::Null).show_status);
        for value in [Value::Null, json!(false), json!("true"), json!(1)] {
            assert!(!Preferences::normalize(&json!({"showStatus":value})).show_status);
        }
        assert!(Preferences::normalize(&json!({"showStatus":true})).show_status);
    }

    #[test]
    fn font_size_rounds_and_accepts_the_full_eight_to_thirty_six_range() {
        for (input, expected) in [
            (0.0, 8),
            (8.0, 8),
            (8.5, 9),
            (16.49, 16),
            (16.5, 17),
            (35.7, 36),
            (36.0, 36),
            (100.0, 36),
        ] {
            let preferences = Preferences::normalize(&json!({"fontSize":input}));
            assert_eq!(preferences.font_size, expected);
            assert!(preferences.valid());
        }
        assert_eq!(
            Preferences::normalize(&json!({"fontSize":"12"})).font_size,
            16
        );
        assert_eq!(
            Preferences::normalize(&json!({"fontSize":null})).font_size,
            16
        );
    }

    #[test]
    fn widget_preferences_roundtrip_through_settings_and_menu_frames() {
        let settings = json!({"language":"zh-CN","floatingMonitor":{"taskbarEnabled":true,"taskbar":{"ring":"vram","items":["status","generation","bogus"],"colors":{"generation":"#14B8A6","status":"#000000","vram":"nope"}}}});
        let preferences = Preferences::from_settings(&settings);
        assert_eq!(preferences.widget.ring, "vram");
        assert_eq!(
            preferences.widget.colors,
            [("generation".to_owned(), "#14b8a6".to_owned())].into()
        );
        assert_eq!(preferences.widget.items, vec!["generation", "status"]);
        assert!(preferences.valid());
        let mut tampered = preferences.clone();
        tampered.widget.items = vec!["status".into(), "generation".into()];
        assert!(!tampered.valid());
        // Legacy Configure frames without the widget field use the defaults.
        let mut legacy = serde_json::to_value(&preferences).unwrap();
        legacy.as_object_mut().unwrap().remove("widget");
        let decoded: Preferences = serde_json::from_value(legacy).unwrap();
        assert_eq!(decoded.widget, widget::WidgetPrefs::default());
        // Menu changes come back as a bounded, allowlisted frame.
        let frame = HostFrame::Widget {
            widget: preferences.widget.clone(),
        };
        let mut encoded = Vec::new();
        write_frame(&mut encoded, &frame).unwrap();
        let Some(HostFrame::Widget { widget }) = read_frame(&mut encoded.as_slice()).unwrap()
        else {
            panic!("wrong widget frame");
        };
        assert_eq!(widget, preferences.widget);
        assert!(read_frame::<_, HostFrame>(
            &mut &b"{\"type\":\"widget\",\"widget\":{\"ring\":\"gpu\",\"items\":[],\"run\":1}}\n"[..]
        )
        .is_err());
        assert!(matches!(
            read_frame::<_, HostFrame>(&mut &b"{\"type\":\"main\"}\n"[..]).unwrap(),
            Some(HostFrame::Main {})
        ));
        assert!(matches!(
            read_frame::<_, HostFrame>(&mut &b"{\"type\":\"colors\"}\n"[..]).unwrap(),
            Some(HostFrame::Colors {})
        ));
    }

    #[test]
    fn sample_carries_status_tone_and_vram_total() {
        let tone = |value: Value| sample(&value).tone;
        assert_eq!(tone(json!({"phase":"stopped"})), widget::Tone::Stopped);
        assert_eq!(tone(json!({"phase":"unavailable"})), widget::Tone::Error);
        assert_eq!(
            tone(
                json!({"phase":"online","health":{"loaded":true},"metrics":{"live":{"state":"loading"}}})
            ),
            widget::Tone::Loading
        );
        assert_eq!(
            tone(
                json!({"phase":"online","health":{"loaded":true},"metrics":{"live":{"state":"idle"}}})
            ),
            widget::Tone::Ready
        );
        let busy = sample(
            &json!({"phase":"online","health":{"loaded":true},"metrics":{"live":{"state":"generating","tok_s":20},"hardware":{"gpu_mem_used":2147483648u64,"gpu_mem_total":8589934592u64}}}),
        );
        assert_eq!(busy.tone, widget::Tone::Busy);
        assert_eq!(busy.vram_total, Some(8.0));
        assert_eq!(
            sample(&json!({"phase":"stopped","metrics":{"hardware":{"gpu_mem_total":1}}}))
                .vram_total,
            None
        );
    }

    #[test]
    fn sample_reads_context_like_the_overview_gauge() {
        // Live request: prompt + generated so far over the engine maximum.
        let live = sample(
            &json!({"phase":"online","health":{"loaded":true,"max_context":4096},"metrics":{"engine":{"max_context":32768},"live":{"state":"generating","prompt_tokens":12000,"generated":400},"requests":[{"prompt_tokens":5,"output_tokens":5}]}}),
        );
        assert_eq!(
            (live.context_used, live.context_total),
            (Some(12_400.0), Some(32_768.0))
        );
        // Idle: the last request; health supplies the maximum when the engine does not.
        let idle = sample(
            &json!({"phase":"online","health":{"loaded":true,"max_context":1048576},"metrics":{"live":{"state":"idle"},"requests":[{"prompt_tokens":3000,"output_tokens":900}]}}),
        );
        assert_eq!(
            (idle.context_used, idle.context_total),
            (Some(3_900.0), Some(1_048_576.0))
        );
        // Unknown pieces stay unknown, and offline samples carry nothing.
        let partial = sample(
            &json!({"phase":"online","health":{"loaded":true},"metrics":{"engine":{"max_context":0},"live":{"state":"generating","prompt_tokens":10}}}),
        );
        assert_eq!((partial.context_used, partial.context_total), (None, None));
        let stopped =
            sample(&json!({"phase":"stopped","metrics":{"engine":{"max_context":32768}}}));
        assert_eq!((stopped.context_used, stopped.context_total), (None, None));
        let mut history = SampleHistory {
            current: live,
            ..SampleHistory::default()
        };
        history.clear_stale(false);
        assert_eq!(history.current.context_total, None);
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
