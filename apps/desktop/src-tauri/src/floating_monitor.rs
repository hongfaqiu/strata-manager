use crate::ClientState;
use serde_json::{json, Value};
use std::{future::Future, path::Path, time::Duration};
use strata_runtime_core::types::ServiceProfile;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[cfg(windows)]
#[path = "floating_monitor_drag.rs"]
mod drag;

pub const LABEL: &str = "service-monitor";
const MIN_WIDTH: f64 = 96.0;
const MIN_HEIGHT: f64 = 24.0;
const MAX_WIDTH: f64 = 1120.0;
const MAX_HEIGHT: f64 = 640.0;

fn require_label(actual: &str, expected: &str) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err("该操作不允许从此窗口调用".into())
    }
}

fn require_destination(destination: &str) -> Result<(), String> {
    if matches!(
        destination,
        "overview"
            | "chat"
            | "monitoring"
            | "usage"
            | "tasks"
            | "settings"
            | "taskbarColors"
            | "quickBenchmark"
    ) {
        Ok(())
    } else {
        Err("浮条不支持此导航目标".into())
    }
}

fn initial_always_on_top(settings: Option<&Value>) -> bool {
    settings
        .and_then(|settings| settings["floatingMonitor"]["alwaysOnTop"].as_bool())
        .unwrap_or(true)
}

#[cfg(any(windows, test))]
fn initial_snap_to_edge(settings: Option<&Value>) -> bool {
    settings
        .and_then(|settings| settings["floatingMonitor"]["snapToEdge"].as_bool())
        .unwrap_or(false)
}

/// Live settings only affect an already existing monitor; never create a
/// window or contact/recover the supervisor merely to apply this preference.
pub async fn apply_preferences(app: &AppHandle, settings: &Value) -> Result<(), String> {
    #[cfg(windows)]
    if let Some(window) = app.get_webview_window(LABEL) {
        drag::install(&window, Some(initial_snap_to_edge(Some(settings)))).await?;
    }
    #[cfg(not(windows))]
    let _ = (app, settings);
    Ok(())
}

/// Text settings shared by every cell of one strip layout.
#[derive(Clone, Copy)]
struct CellStyle {
    font: f64,
    label_font: f64,
    labels: bool,
    units: bool,
    english: bool,
    /// One-row strip: the label sits beside the value.
    inline: bool,
}

fn metric_cell_width(metric: &str, style: &CellStyle) -> f64 {
    let CellStyle {
        font,
        label_font,
        labels,
        units,
        english,
        inline,
    } = *style;
    let (budget, chinese, english_label, unit) = match metric {
        "generation" => (6.0, "生成", "Gen", "t/s"),
        "prefill" => (6.0, "读取", "Read", "t/s"),
        "gpu" => (3.0, "GPU", "GPU", "%"),
        "vram" => (5.0, "显存", "VRAM", "GiB"),
        "cpu" => (3.0, "CPU", "CPU", "%"),
        "ram" => (5.0, "内存", "RAM", "GiB"),
        "temperature" => (3.0, "温度", "Temp", "°C"),
        "power" => (4.0, "功耗", "Power", "W"),
        "running" => (4.0, "运行", "Run", ""),
        "queued" => (4.0, "排队", "Queue", ""),
        "cache" => (3.0, "缓存", "Cache", "%"),
        _ => (4.0, "", "", ""),
    };
    let text_width = |text: &str| {
        text.chars()
            .map(|character| if character.is_ascii() { 0.5 } else { 1.0 })
            .sum::<f64>()
            * label_font
    };
    // Stable type budgets match core: changing telemetry never resizes a cell.
    let value_width = budget * 0.58 * font
        + if units && !unit.is_empty() {
            text_width(unit) + 3.0
        } else {
            0.0
        };
    let label_width = if labels {
        text_width(if english { english_label } else { chinese })
    } else {
        0.0
    };
    if inline {
        // One-row strip: the label sits beside the value.
        (label_width + if labels { 3.0 } else { 0.0 } + value_width + 4.0).ceil()
    } else {
        (value_width.max(label_width) + 4.0).ceil()
    }
}

/// Strip rows like core `floatingMonitorStripRows` + `migrateFloatingMonitorRows`:
/// `None` is the panel grid. Saved single/double wins; otherwise the retired
/// 紧凑单行 (`compact`) preset is one row and everything else two rows.
fn strip_rows(layout: Option<&str>, rows: Option<&str>) -> Option<usize> {
    match (layout, rows) {
        (Some("panel"), _) => None,
        (_, Some("single")) => Some(1),
        (_, Some("double")) => Some(2),
        (Some("compact"), _) => Some(1),
        _ => Some(2),
    }
}

fn initial_size(settings: Option<&Value>) -> (f64, f64) {
    let preferences = settings.and_then(|settings| settings.get("floatingMonitor"));
    let font = preferences
        .and_then(|value| value["fontSize"].as_f64())
        .filter(|font| font.is_finite())
        .unwrap_or(16.0)
        .round()
        .clamp(8.0, 36.0);
    // `strip` / `panel`; older settings may still say `compact` / `twoRow`.
    let layout = preferences.and_then(|value| value["layout"].as_str());
    let mut metrics = Vec::new();
    for metric in preferences
        .and_then(|value| value["metrics"].as_array())
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if matches!(
            metric,
            "generation"
                | "prefill"
                | "gpu"
                | "vram"
                | "cpu"
                | "ram"
                | "temperature"
                | "power"
                | "running"
                | "queued"
                | "cache"
        ) && !metrics.contains(&metric)
        {
            metrics.push(metric);
            if metrics.len() == 8 {
                break;
            }
        }
    }
    if metrics.is_empty() {
        metrics.extend(["generation", "prefill", "gpu", "vram", "cpu", "ram"]);
    }
    let count = metrics.len();
    let graphs = preferences
        .and_then(|value| value["showGraphs"].as_bool())
        .unwrap_or(true);
    let labels = preferences
        .and_then(|value| value["showLabels"].as_bool())
        .unwrap_or(true);
    let units = preferences
        .and_then(|value| value["showUnits"].as_bool())
        .unwrap_or(true);
    let english = settings.is_some_and(|settings| settings["language"] == "en");
    let header = preferences
        .is_some_and(|value| value["showStatus"] == true || value["showSampleTime"] == true);
    let rows = preferences.and_then(|value| value["rows"].as_str());
    let measure = |strip: Option<usize>| {
        let (columns, rows) = match strip {
            None => (2, count.div_ceil(2)),
            Some(1) => (count, 1),
            _ => (count.div_ceil(2), count.min(2)),
        };
        let inline = strip == Some(1) && count > 1;
        let gap = if inline {
            (font * 0.5).round().max(6.0)
        } else {
            2.0
        };
        let label_font = (font * 0.7).round().max(8.0);
        let style = CellStyle {
            font,
            label_font,
            labels,
            units,
            english,
            inline,
        };
        let mut column_widths = vec![0.0_f64; columns];
        for (index, metric) in metrics.iter().enumerate() {
            let column = index % columns;
            column_widths[column] = column_widths[column].max(metric_cell_width(metric, &style));
        }
        let cell_height = (font * 1.4).ceil()
            + if labels && !inline {
                label_font + 2.0
            } else {
                0.0
            }
            + if graphs { 18.0 } else { 0.0 };
        let header_height = if header {
            (font * 0.85).ceil() + 4.0
        } else {
            0.0
        };
        let padding = 5.0;
        (
            (column_widths.iter().sum::<f64>() + (columns - 1) as f64 * gap + padding * 2.0)
                .max(MIN_WIDTH),
            (rows as f64 * cell_height + (rows - 1) as f64 * 2.0 + header_height + padding * 2.0)
                .clamp(MIN_HEIGHT, MAX_HEIGHT),
        )
    };
    let strip = strip_rows(layout, rows);
    let mut size = measure(strip);
    // A single row wider than the window limit falls back to two rows.
    if strip == Some(1) && size.0 > MAX_WIDTH {
        size = measure(Some(2));
    }
    (size.0.min(MAX_WIDTH), size.1)
}

#[derive(Clone, Copy, Debug)]
struct MonitorArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
}

impl MonitorArea {
    fn from_monitor(monitor: &tauri::Monitor) -> Self {
        let area = monitor.work_area();
        Self {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
            scale: monitor.scale_factor(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WindowRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn validate_size(width: f64, height: f64) -> Result<(), String> {
    if width.is_finite()
        && height.is_finite()
        && (MIN_WIDTH..=MAX_WIDTH).contains(&width)
        && (MIN_HEIGHT..=MAX_HEIGHT).contains(&height)
    {
        Ok(())
    } else {
        Err("监控窗口尺寸必须为有限数值，宽度 96–1120、高度 24–640".into())
    }
}

/// Physical pixels the native frame adds around the webview (outer − inner).
/// Undecorated Windows windows keep an invisible DWM resize border/shadow
/// (≈8px left/right/bottom at 100%), so `outer_size` is larger than the size
/// `set_size` (an inner size) applies. macOS borderless windows report 0.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct FrameInset {
    width: u32,
    height: u32,
}

impl FrameInset {
    fn between(outer: WindowRect, inner: (u32, u32)) -> Self {
        Self {
            width: outer.width.saturating_sub(inner.0),
            height: outer.height.saturating_sub(inner.1),
        }
    }
}

#[cfg(test)]
fn fit_window(
    area: &MonitorArea,
    current: Option<WindowRect>,
    width: f64,
    height: f64,
) -> Result<WindowRect, String> {
    fit_window_framed(area, current, FrameInset::default(), width, height)
}

/// `current` is the window's outer rect and `width`/`height` the logical
/// webview size. The result's x/y are the outer position and its
/// width/height the physical *inner* size passed to `set_size`, so the frame
/// inset is counted once for placement and never fed back into the size.
fn fit_window_framed(
    area: &MonitorArea,
    current: Option<WindowRect>,
    inset: FrameInset,
    width: f64,
    height: f64,
) -> Result<WindowRect, String> {
    validate_size(width, height)?;
    if area.width == 0
        || area.height == 0
        || !area.scale.is_finite()
        || !(0.25..=8.0).contains(&area.scale)
    {
        return Err("屏幕工作区不可用".into());
    }
    let inset_width = f64::from(inset.width.min(area.width.saturating_sub(1)));
    let inset_height = f64::from(inset.height.min(area.height.saturating_sub(1)));
    let width = (width * area.scale)
        .round()
        .clamp(1.0, f64::from(area.width) - inset_width);
    let height = (height * area.scale)
        .round()
        .clamp(1.0, f64::from(area.height) - inset_height);
    let outer_width = width + inset_width;
    let outer_height = height + inset_height;
    let left = f64::from(area.x);
    let top = f64::from(area.y);
    let right = left + f64::from(area.width);
    let bottom = top + f64::from(area.height);
    let (x, y) = if let Some(current) = current {
        let right_gap = right - f64::from(current.x) - f64::from(current.width);
        let bottom_gap = bottom - f64::from(current.y) - f64::from(current.height);
        let near_edge = 0.0..=48.0 * area.scale;
        (
            if near_edge.contains(&right_gap) {
                right - right_gap - outer_width
            } else {
                f64::from(current.x)
            },
            if near_edge.contains(&bottom_gap) {
                bottom - bottom_gap - outer_height
            } else {
                f64::from(current.y)
            },
        )
    } else {
        (
            right - outer_width - 16.0 * area.scale,
            bottom - outer_height - 16.0 * area.scale,
        )
    };
    Ok(WindowRect {
        x: x.clamp(left, right - outer_width).round() as i32,
        y: y.clamp(top, bottom - outer_height).round() as i32,
        width: width as u32,
        height: height as u32,
    })
}

/// Drag rectangles and work areas are physical desktop pixels. Only the snap
/// distance is logical, so crossing onto a negative-coordinate or scaled screen
/// does not change the work-area containment rule.
#[cfg(any(windows, test))]
fn snap_drag_rect(
    area: &MonitorArea,
    proposed: WindowRect,
    snap_to_edge: bool,
) -> Option<WindowRect> {
    if area.width == 0
        || area.height == 0
        || proposed.width == 0
        || proposed.height == 0
        || !area.scale.is_finite()
        || !(0.25..=8.0).contains(&area.scale)
        || i64::from(area.x) + i64::from(area.width) > i64::from(i32::MAX)
        || i64::from(area.y) + i64::from(area.height) > i64::from(i32::MAX)
    {
        return None;
    }
    let width = proposed.width.min(area.width);
    let height = proposed.height.min(area.height);
    let threshold = if snap_to_edge {
        (14.0 * area.scale).round() as i64
    } else {
        0
    };
    let axis = |position: i32, origin: i32, extent: u32, size: u32| {
        let start = i64::from(origin);
        let end = start + i64::from(extent) - i64::from(size);
        let position = i64::from(position).clamp(start, end);
        let start_gap = position - start;
        let end_gap = end - position;
        if start_gap <= threshold && start_gap <= end_gap {
            start as i32
        } else if end_gap <= threshold {
            end as i32
        } else {
            position as i32
        }
    };
    Some(WindowRect {
        x: axis(proposed.x, area.x, area.width, width),
        y: axis(proposed.y, area.y, area.height, height),
        width,
        height,
    })
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy)]
struct DragOrigin {
    cursor: (i32, i32),
    rect: WindowRect,
}

#[cfg(any(windows, test))]
#[derive(Default)]
struct DragState {
    snap_to_edge: bool,
    origin: Option<DragOrigin>,
}

#[cfg(any(windows, test))]
impl DragState {
    fn begin(&mut self, cursor: (i32, i32), rect: WindowRect) {
        self.origin = Some(DragOrigin { cursor, rect });
    }

    fn finish(&mut self) {
        self.origin = None;
    }

    fn rebase(&mut self, cursor: (i32, i32), rect: WindowRect) {
        if self.origin.is_some() {
            self.begin(cursor, rect);
        }
    }

    fn candidate(&self, cursor: (i32, i32), proposed: WindowRect) -> WindowRect {
        let Some(origin) = self.origin else {
            return proposed;
        };
        let shifted = |position: i32, from: i32, to: i32| {
            (i64::from(position) + i64::from(to) - i64::from(from))
                .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
        };
        // Width/height can change with DPI or an explicit preference update.
        // Position never feeds back from a previously clamped/snapped RECT.
        WindowRect {
            x: shifted(origin.rect.x, origin.cursor.0, cursor.0),
            y: shifted(origin.rect.y, origin.cursor.1, cursor.1),
            ..proposed
        }
    }
}

/// Outer rect plus the inner (webview) size. Sizes must be read back from
/// `inner_size`: `set_size` applies an inner size, so restoring from
/// `outer_size` grew the strip by the frame inset on every reopen.
fn current_geometry(window: &WebviewWindow) -> Result<(WindowRect, (u32, u32)), String> {
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let inner = window.inner_size().map_err(|e| e.to_string())?;
    Ok((
        WindowRect {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
        (inner.width, inner.height),
    ))
}

/// Reopen keeps the strip's current webview size. Only the inner size is
/// converted back to logical pixels, and with the same work-area scale that
/// `fit_window_framed` multiplies by, so the physical size round-trips
/// exactly and repeated opens are idempotent (even if the window's own DPI
/// differs from the fallback work area's).
fn restore_rect(
    area: &MonitorArea,
    outer: WindowRect,
    inner: (u32, u32),
) -> Result<WindowRect, String> {
    if !area.scale.is_finite() || area.scale <= 0.0 {
        return Err("屏幕工作区不可用".into());
    }
    fit_window_framed(
        area,
        Some(outer),
        FrameInset::between(outer, inner),
        (f64::from(inner.0) / area.scale).clamp(MIN_WIDTH, MAX_WIDTH),
        (f64::from(inner.1) / area.scale).clamp(MIN_HEIGHT, MAX_HEIGHT),
    )
}

fn current_area(app: &AppHandle, window: &WebviewWindow) -> Result<MonitorArea, String> {
    window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| {
            app.get_webview_window("main")
                .and_then(|main| main.current_monitor().ok().flatten())
        })
        .or_else(|| window.primary_monitor().ok().flatten())
        .or_else(|| window.available_monitors().ok()?.into_iter().next())
        .map(|monitor| MonitorArea::from_monitor(&monitor))
        .ok_or_else(|| "屏幕工作区不可用".into())
}

fn apply_layout(
    window: &WebviewWindow,
    area: &MonitorArea,
    inset: FrameInset,
    rect: WindowRect,
) -> Result<(), String> {
    // A very small work area may be smaller than the usual logical minimum.
    // Physical constraints prevent an obsolete DPI or the old 40px maximum
    // from forcing a resized/restored window outside that area. Constraints
    // are inner sizes, so leave room for the frame inset.
    let bounded_size = |width: f64, height: f64| {
        tauri::PhysicalSize::new(
            ((width * area.scale).round() as u32)
                .min(area.width.saturating_sub(inset.width))
                .max(1),
            ((height * area.scale).round() as u32)
                .min(area.height.saturating_sub(inset.height))
                .max(1),
        )
    };
    window
        .set_min_size(Some(bounded_size(MIN_WIDTH, MIN_HEIGHT)))
        .map_err(|e| e.to_string())?;
    window
        .set_max_size(Some(bounded_size(MAX_WIDTH, MAX_HEIGHT)))
        .map_err(|e| e.to_string())?;
    window
        .set_position(tauri::PhysicalPosition::new(rect.x, rect.y))
        .map_err(|e| e.to_string())?;
    window
        .set_size(tauri::PhysicalSize::new(rect.width, rect.height))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resize_monitor_window(
    app: AppHandle,
    window: WebviewWindow,
    width: f64,
    height: f64,
) -> Result<Value, String> {
    require_label(window.label(), LABEL)?;
    validate_size(width, height)?;
    let area = current_area(&app, &window)?;
    let (outer, inner) = current_geometry(&window)?;
    let inset = FrameInset::between(outer, inner);
    let rect = fit_window_framed(&area, Some(outer), inset, width, height)?;
    apply_layout(&window, &area, inset, rect)?;
    Ok(json!({
        "width": f64::from(rect.width) / area.scale,
        "height": f64::from(rect.height) / area.scale,
        "x": rect.x, "y": rect.y, "scaleFactor": area.scale
    }))
}

fn require_rows(rows: &str) -> Result<(), String> {
    // The desktop strip has no `auto` (only the taskbar widget does).
    if matches!(rows, "single" | "double") {
        Ok(())
    } else {
        Err("文字行数无效".into())
    }
}

/// Strip context menu 「文字行数」: the main window saves the change like any
/// settings edit, then `monitor-preferences-changed` re-lays out the strip.
#[tauri::command]
pub fn set_monitor_rows(app: AppHandle, window: WebviewWindow, rows: String) -> Result<(), String> {
    require_label(window.label(), LABEL)?;
    require_rows(&rows)?;
    app.emit_to("main", "monitor-preferences-patch", json!({ "rows": rows }))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_monitor_window(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    require_label(window.label(), "main")?;
    crate::taskbar_monitor::open_floating(&app).await
}

pub(crate) async fn open_window(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<ClientState>();
    static OPEN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = OPEN.lock().await;
    if let Some(existing) = app.get_webview_window(LABEL) {
        #[cfg(windows)]
        drag::install(&existing, None).await?;
        existing.unminimize().map_err(|e| e.to_string())?;
        let area = current_area(app, &existing)?;
        let (outer, inner) = current_geometry(&existing)?;
        let rect = restore_rect(&area, outer, inner)?;
        apply_layout(&existing, &area, FrameInset::between(outer, inner), rect)?;
        existing
            .emit("monitor-restored", ())
            .map_err(|e| e.to_string())?;
        existing.show().map_err(|e| e.to_string())?;
        return existing.set_focus().map_err(|e| e.to_string());
    }
    // Read only an existing backend. Opening the strip must never recover or
    // start a stopped supervisor merely to read a window preference.
    let settings = read_existing(
        &state.ipc.data_dir,
        &state.client,
        "store_get",
        json!({"key":"settings"}),
    )
    .await
    .ok();
    let (width, height) = initial_size(settings.as_ref());
    let monitor = WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::App("index.html?window=monitor".into()),
    )
    .title("Strata Manager · Monitor")
    .inner_size(width, height)
    .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
    .max_inner_size(MAX_WIDTH, MAX_HEIGHT)
    .decorations(false)
    .resizable(false)
    .skip_taskbar(true)
    .always_on_top(initial_always_on_top(settings.as_ref()))
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    if let Err(error) = drag::install(&monitor, Some(initial_snap_to_edge(settings.as_ref()))).await
    {
        let _ = monitor.destroy();
        return Err(error);
    }
    // Place on the main window's current screen; later restores retain the
    // user's position and pin preference while fitting the current work area.
    let area = if let Some(screen) = app
        .get_webview_window("main")
        .and_then(|window| window.current_monitor().ok().flatten())
    {
        MonitorArea::from_monitor(&screen)
    } else {
        current_area(app, &monitor)?
    };
    let inset = current_geometry(&monitor)
        .map(|(outer, inner)| FrameInset::between(outer, inner))
        .unwrap_or_default();
    let rect = fit_window_framed(&area, None, inset, width, height)?;
    apply_layout(&monitor, &area, inset, rect)?;
    monitor.show().map_err(|e| e.to_string())?;
    monitor.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn show_main_from_monitor(
    app: AppHandle,
    window: WebviewWindow,
    destination: Option<String>,
) -> Result<(), String> {
    require_label(window.label(), LABEL)?;
    show_main(&app, destination)
}

pub(crate) fn show_main(app: &AppHandle, destination: Option<String>) -> Result<(), String> {
    if let Some(destination) = destination.as_deref() {
        require_destination(destination)?;
    }
    let main = app.get_webview_window("main").ok_or("主窗口不可用")?;
    if let Some(destination) = destination {
        app.emit_to("main", "monitor-navigate", destination)
            .map_err(|e| e.to_string())?;
    }
    main.show().map_err(|e| e.to_string())?;
    main.unminimize().map_err(|e| e.to_string())?;
    main.set_focus().map_err(|e| e.to_string())
}

pub(crate) async fn read_existing(
    directory: &Path,
    client: &reqwest::Client,
    method: &'static str,
    params: Value,
) -> Result<Value, String> {
    if method == "strata_request" {
        let path = params["path"].as_str().ok_or("监控路径无效")?;
        if params["method"] != "GET" || !matches!(path, "/health" | "/metrics") {
            return Err("浮条仅允许读取健康状态和监控指标".into());
        }
        let profile: ServiceProfile =
            serde_json::from_value(params["profile"].clone()).map_err(|e| e.to_string())?;
        return strata_runtime_core::http::request_builder(client, &profile, path, "GET", None)?
            .timeout(Duration::from_secs(4))
            .header("X-Strata-Client", "strata-manager.monitor")
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string());
    }
    if !matches!(
        method,
        "store_get" | "local_installations" | "supervisor_status" | "service_status"
    ) {
        return Err("浮条不支持此后台操作".into());
    }
    // Never use SupervisorClient::request here: its connection recovery can
    // launch or upgrade the supervisor. A closed backend remains closed.
    tokio::time::timeout(
        Duration::from_secs(5),
        strata_local_ipc::call(directory, method, params),
    )
    .await
    .map_err(|_| "后台状态读取超时".to_owned())?
    .map_err(|e| e.to_string())
}

pub(crate) async fn collect_snapshot<F, Fut>(mut rpc: F) -> Result<Value, String>
where
    F: FnMut(&'static str, Value) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    let settings = rpc("store_get", json!({"key":"settings"})).await?;
    let profiles = rpc("local_installations", json!({})).await?;
    let status = rpc("supervisor_status", json!({})).await?;
    let mut active = if let Some(selected) = status["activeLocalInstallation"].as_str() {
        Value::String(selected.into())
    } else {
        rpc("store_get", json!({"key":"activeLocalInstallation"})).await?
    };
    if active.as_str().is_none_or(str::is_empty) {
        active = rpc("store_get", json!({"key":"activeProfile"})).await?;
    }
    let profile = profiles
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p["id"].as_str().is_some() && p["id"].as_str() == active.as_str());
    let mut snapshot = json!({
        "settings": {
            "language":settings["language"], "theme":settings["theme"],
            "pollInterval":settings["pollInterval"],
            "floatingMonitor":settings["floatingMonitor"]
        },
        "phase":"none", "sampledAt":strata_runtime_core::types::now()
    });
    let Some(profile) = profile else {
        return Ok(snapshot);
    };
    snapshot["profile"] = profile.clone();
    let process = rpc(
        "service_status",
        json!({"profileId":profile["id"],"profile":profile}),
    )
    .await?;
    snapshot["process"] = process.clone();
    if process["running"] == false {
        snapshot["phase"] = json!("stopped");
        return Ok(snapshot);
    }
    if process["running"] != true {
        snapshot["phase"] = json!("unavailable");
        return Ok(snapshot);
    }
    let health = match rpc(
        "strata_request",
        json!({"profile":profile,"path":"/health","method":"GET"}),
    )
    .await
    {
        Ok(health)
            if health["service"] == "strata"
                && health["status"] == "ok"
                && health["loaded"].is_boolean() =>
        {
            health
        }
        Ok(_) => {
            snapshot["phase"] = json!("disconnected");
            snapshot["error"] = json!("API 健康状态尚未核验 / API health unverified");
            return Ok(snapshot);
        }
        Err(error) => {
            snapshot["phase"] = json!("disconnected");
            snapshot["error"] = json!(error);
            return Ok(snapshot);
        }
    };
    snapshot["health"] = health;
    match rpc(
        "strata_request",
        json!({"profile":profile,"path":"/metrics","method":"GET"}),
    )
    .await
    {
        Ok(metrics) if metrics.is_object() => {
            snapshot["phase"] = json!("online");
            snapshot["metrics"] = metrics;
        }
        Ok(_) => {
            snapshot["phase"] = json!("unavailable");
        }
        Err(error) => {
            snapshot["phase"] = json!("unavailable");
            snapshot["error"] = json!(error);
        }
    }
    snapshot["sampledAt"] = json!(strata_runtime_core::types::now());
    Ok(snapshot)
}

#[tauri::command]
pub async fn monitor_snapshot(
    window: WebviewWindow,
    state: State<'_, ClientState>,
) -> Result<Value, String> {
    require_label(window.label(), LABEL)?;
    // Renderer remounts and repeated refreshes cannot overlap accepted reads.
    static READ: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = READ.lock().await;
    let directory = state.ipc.data_dir.clone();
    let client = state.client.clone();
    collect_snapshot(move |method, params| {
        let directory = directory.clone();
        let client = client.clone();
        async move { read_existing(&directory, &client, method, params).await }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    async fn fixture(
        running: Option<bool>,
        health_ok: bool,
        metrics_ok: bool,
    ) -> (Value, Vec<(String, Value)>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let records = calls.clone();
        let result = collect_snapshot(move |method, params| {
            records.lock().unwrap().push((method.into(), params.clone()));
            async move {
                match method {
                    "store_get" => Ok(json!({"language":"en","theme":"dark","pollInterval":2000,"floatingMonitor":{"alwaysOnTop":false,"quickActions":["chat","settings"],"futureOption":"keep"}})),
                    "local_installations" => Ok(json!([{"id":"selected","name":"Model A","baseUrl":"http://127.0.0.1:18081","managed":true}])),
                    "supervisor_status" => Ok(json!({"activeLocalInstallation":"selected"})),
                    "service_status" => Ok(json!({"running":running})),
                    "strata_request" if params["path"] == "/health" && health_ok => Ok(json!({"service":"strata","status":"ok","loaded":true})),
                    "strata_request" if params["path"] == "/metrics" && metrics_ok => Ok(json!({"live":{"state":"generating","tok_s":90}})),
                    "strata_request" => Err("test unavailable".into()),
                    _ => panic!("Unexpected command: {method}"),
                }
            }
        }).await.unwrap();
        let calls = calls.lock().unwrap().clone();
        (result, calls)
    }

    #[test]
    fn initial_size_uses_clear_two_row_default_and_ignores_legacy_buttons() {
        assert_eq!(initial_size(None), (244.0, 120.0));
        for settings in [
            Value::Null,
            json!({}),
            json!({"floatingMonitor":null}),
            json!({"floatingMonitor":{"actions":["chat", "pin"]}}),
            json!({"floatingMonitor":{"layout":"unknown","fontSize":"24","metrics":["unknown"],"showGraphs":"false","showLabels":null}}),
            json!({"floatingMonitor":{"metrics":[]}}),
        ] {
            assert_eq!(initial_size(Some(&settings)), (244.0, 120.0));
        }
    }

    #[test]
    fn initial_size_normalizes_metrics_and_respects_layout_and_visibility() {
        assert_eq!(
            initial_size(Some(
                &json!({"floatingMonitor":{"metrics":["cpu","cpu",null,"unknown"]}})
            )),
            (96.0, 64.0)
        );
        assert_eq!(
            initial_size(Some(
                &json!({"floatingMonitor":{"showGraphs":false,"showLabels":false}})
            )),
            (244.0, 58.0)
        );
        assert_eq!(
            initial_size(Some(&json!({"floatingMonitor":{"fontSize":1}}))),
            (151.0, 92.0)
        );
        assert_eq!(
            initial_size(Some(&json!({"floatingMonitor":{"fontSize":17.5}}))),
            (273.0, 130.0)
        );
        let metrics = json!([
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
            "cache"
        ]);
        for (layout, expected) in [
            ("compact", (613.0, 204.0)),
            ("twoRow", (613.0, 204.0)),
            ("strip", (613.0, 204.0)),
            ("panel", (352.0, 400.0)),
        ] {
            let settings =
                json!({"floatingMonitor":{"layout":layout,"fontSize":900,"metrics":metrics}});
            assert_eq!(initial_size(Some(&settings)), expected);
        }
    }

    #[test]
    fn single_row_strip_is_one_line_with_inline_labels_without_changing_other_layouts() {
        assert_eq!(
            initial_size(Some(&json!({"floatingMonitor":{
                "layout":"compact", "fontSize":14,
                "metrics":["generation","gpu","vram"], "showGraphs":false
            }}))),
            (259.0, 30.0)
        );
        assert_eq!(
            initial_size(Some(&json!({"floatingMonitor":{
                "layout":"compact", "fontSize":14,
                "metrics":["gpu"], "showGraphs":false
            }}))),
            (96.0, 42.0)
        );
        assert_eq!(initial_size(None), (244.0, 120.0));
        assert_eq!(
            initial_size(Some(&json!({"floatingMonitor":{
                "layout":"compact", "fontSize":14, "metrics":["generation","gpu","vram"],
                "showGraphs":false, "showLabels":false
            }}))),
            (195.0, 30.0)
        );
        for header in ["showStatus", "showSampleTime"] {
            assert_eq!(
                initial_size(Some(&json!({"floatingMonitor":{(header):true}}))),
                (244.0, 138.0)
            );
        }
    }

    #[test]
    fn initial_width_uses_short_localized_labels_and_optional_units() {
        let preferences = json!({"layout":"compact", "fontSize":8,
            "metrics":["cache","power","queued","gpu"], "showUnits":false, "showGraphs":false});
        assert_eq!(
            initial_size(Some(
                &json!({"language":"zh-CN", "floatingMonitor":preferences})
            )),
            (182.0, 24.0)
        );
        assert_eq!(
            initial_size(Some(
                &json!({"language":"en", "floatingMonitor":preferences})
            )),
            (194.0, 24.0)
        );
        assert_eq!(
            initial_size(Some(
                &json!({"language":"invalid", "floatingMonitor":preferences})
            )),
            (182.0, 24.0)
        );
        for language in ["zh-CN", "en"] {
            assert_eq!(
                initial_size(Some(&json!({"language":language}))),
                (244.0, 120.0)
            );
            assert_eq!(
                initial_size(Some(
                    &json!({"language":language, "floatingMonitor":{"showUnits":false}})
                )),
                (185.0, 120.0)
            );
            assert_eq!(
                initial_size(Some(&json!({"language":language, "floatingMonitor":{
                    "layout":"panel", "fontSize":18,
                    "metrics":["generation","prefill","gpu","vram","cpu","ram","temperature","power"]
                }}))),
                (192.0, 252.0)
            );
        }
    }

    #[test]
    fn initial_width_takes_the_largest_metric_in_each_row_major_column() {
        assert_eq!(
            initial_size(Some(&json!({"floatingMonitor":{
                "metrics":["generation","gpu","vram","prefill","cpu","ram"]
            }}))),
            (205.0, 120.0)
        );
        assert_eq!(
            initial_size(Some(&json!({"floatingMonitor":{
                "layout":"compact", "fontSize":14, "metrics":["generation","gpu","vram"],
                "showGraphs":false, "showUnits":false
            }}))),
            (215.0, 30.0)
        );
    }

    #[test]
    fn text_rows_match_core_strip_layout() {
        let eight = json!([
            "generation",
            "prefill",
            "gpu",
            "vram",
            "cpu",
            "ram",
            "temperature",
            "power"
        ]);
        let size =
            |preferences: Value| initial_size(Some(&json!({ "floatingMonitor": preferences })));
        // Default two rows is unchanged; auto and unknown values keep it.
        for rows in [json!(null), json!("auto"), json!("double"), json!("three")] {
            assert_eq!(size(json!({ "rows": rows })), (244.0, 120.0));
        }
        assert_eq!(size(json!({ "rows": "single" })), (570.0, 51.0));
        assert_eq!(
            size(json!({ "rows": "single", "metrics": eight })),
            (738.0, 51.0)
        );
        assert_eq!(size(json!({ "metrics": eight })), (298.0, 120.0));
        assert_eq!(
            size(
                json!({ "layout": "compact", "fontSize": 14, "metrics": eight, "rows": "double" })
            ),
            (268.0, 112.0)
        );
        // Too wide for one row: fall back to two rows inside MAX_WIDTH.
        assert_eq!(
            size(json!({ "rows": "single", "metrics": eight, "fontSize": 36 })),
            (613.0, 204.0)
        );
        // The panel ignores the choice.
        assert_eq!(
            size(json!({ "layout": "panel", "fontSize": 18, "rows": "single", "metrics": eight })),
            (192.0, 252.0)
        );
        assert!(require_rows("single").is_ok() && require_rows("double").is_ok());
        // `auto` belongs to the taskbar widget only.
        assert!(
            require_rows("auto").is_err()
                && require_rows("").is_err()
                && require_rows("triple").is_err()
        );
    }

    #[test]
    fn retired_presets_migrate_to_strip_with_rows() {
        let size =
            |preferences: Value| initial_size(Some(&json!({ "floatingMonitor": preferences })));
        let six = json!(["generation", "prefill", "gpu", "vram", "cpu", "ram"]);
        // 清晰双行 → 条形 + 两行: identical size.
        for layout in ["twoRow", "strip"] {
            assert_eq!(
                size(json!({ "layout": layout, "metrics": six })),
                size(json!({ "layout": "strip", "rows": "double", "metrics": six }))
            );
        }
        assert_eq!(size(json!({ "layout": "twoRow" })), (244.0, 120.0));
        // 紧凑单行 → 条形 + 单行: one line, no 4 + 2 wrap.
        let compact =
            json!({ "layout": "compact", "fontSize": 14, "metrics": six, "showGraphs": false });
        let strip = json!({ "layout": "strip", "rows": "single", "fontSize": 14, "metrics": six, "showGraphs": false });
        assert_eq!(size(compact.clone()), size(strip));
        assert_eq!(size(compact).1, 30.0);
        // `auto` from an unreleased build follows the old preset; an explicit choice wins.
        assert_eq!(
            size(json!({ "layout": "compact", "rows": "auto", "metrics": six })),
            size(json!({ "layout": "strip", "rows": "single", "metrics": six }))
        );
        assert_eq!(
            size(json!({ "layout": "compact", "rows": "double", "metrics": six })),
            (244.0, 120.0)
        );
        assert_eq!(
            size(json!({ "layout": "twoRow", "rows": "single", "metrics": six })),
            (570.0, 51.0)
        );
        // The panel stays a grid.
        assert_eq!(
            size(json!({ "layout": "panel", "rows": "single", "fontSize": 18,
                "metrics": ["generation","prefill","gpu","vram","cpu","ram","temperature","power"] })),
            (192.0, 252.0)
        );
    }

    #[test]
    fn font_range_eight_to_thirty_six_fits_safe_sizes_and_smaller_text_reduces_height() {
        for language in ["zh-CN", "en"] {
            for layout in ["compact", "twoRow", "strip", "panel"] {
                let dimensions = |font| {
                    initial_size(Some(&json!({"language":language, "floatingMonitor":{
                        "layout":layout, "fontSize":font, "showStatus":true,
                        "metrics":["generation","prefill","gpu","vram","cpu","ram","temperature","power"]
                    }})))
                };
                let small = dimensions(8);
                let normal = dimensions(16);
                let large = dimensions(36);
                assert!(small.1 < normal.1 && normal.1 < large.1);
                for size in [small, normal, large] {
                    assert!(validate_size(size.0, size.1).is_ok());
                }
                assert_eq!(dimensions(-1), small);
                assert_eq!(dimensions(100), large);
            }
        }
        assert_eq!(
            initial_size(Some(&json!({"floatingMonitor":{
                "layout":"compact", "fontSize":8, "metrics":["gpu"],
                "showGraphs":false, "showLabels":false
            }}))),
            (96.0, 24.0)
        );
    }

    fn area(x: i32, y: i32, width: u32, height: u32, scale: f64) -> MonitorArea {
        MonitorArea {
            x,
            y,
            width,
            height,
            scale,
        }
    }

    fn rect(x: i32, y: i32, width: u32, height: u32) -> WindowRect {
        WindowRect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn initial_placement_uses_work_area_and_monitor_dpi() {
        assert_eq!(
            fit_window(&area(0, 0, 1920, 1040, 1.0), None, 588.0, 152.0).unwrap(),
            rect(1316, 872, 588, 152)
        );
        assert_eq!(
            fit_window(&area(-2560, 120, 2560, 1440, 1.5), None, 588.0, 152.0).unwrap(),
            rect(-906, 1308, 882, 228)
        );
    }

    /// Regression: reopening the strip (tray/taskbar/hotkey click) must not
    /// grow it. Windows' undecorated frame makes outer > inner; restoring
    /// from the outer size added that inset on every click.
    #[test]
    fn repeated_reopen_keeps_size_and_edges_stable_with_frame_inset() {
        for (screen, inset, start) in [
            // Windows 11 at 150%: ~11px side/bottom borders + 2px top inset.
            (
                area(0, 0, 2560, 1392, 1.5),
                FrameInset {
                    width: 22,
                    height: 13,
                },
                (1600, 1200, 882, 60),
            ),
            // Windows 10 at 100%: 8px borders, no top inset.
            (
                area(-1920, 0, 1920, 1040, 1.0),
                FrameInset {
                    width: 16,
                    height: 8,
                },
                (-700, 300, 588, 152),
            ),
            // macOS Retina borderless (physical work area): no frame.
            (
                area(0, 50, 3024, 1864, 2.0),
                FrameInset::default(),
                (900, 700, 1176, 80),
            ),
        ] {
            let (x, y, width, height) = start;
            let outer =
                |x: i32, y: i32, w: u32, h: u32| rect(x, y, w + inset.width, h + inset.height);
            let mut window = outer(x, y, width, height);
            let first = window;
            for click in 0..12 {
                let inner = (window.width - inset.width, window.height - inset.height);
                let next = restore_rect(&screen, window, inner).unwrap();
                assert_eq!(
                    (next.width, next.height),
                    (width, height),
                    "inner size changed on reopen #{click}"
                );
                window = outer(next.x, next.y, next.width, next.height);
                assert_eq!(window, first, "outer rect drifted on reopen #{click}");
            }
        }
    }

    #[test]
    fn framed_fit_keeps_outer_edge_distance_when_resizing() {
        let screen = area(0, 0, 1920, 1040, 1.0);
        let inset = FrameInset {
            width: 16,
            height: 8,
        };
        // Outer right/bottom edges 16px inside the work area.
        let current = rect(1572, 884, 316 + 16, 132 + 8);
        let next = fit_window_framed(&screen, Some(current), inset, 588.0, 152.0).unwrap();
        assert_eq!((next.width, next.height), (588, 152));
        assert_eq!(next.x + 588 + 16, 1920 - 16);
        assert_eq!(next.y + 152 + 8, 1040 - 16);
        // Without a current rect the default margin is measured to the outer edge.
        let fresh = fit_window_framed(&screen, None, inset, 588.0, 152.0).unwrap();
        assert_eq!(fresh, rect(1920 - 16 - 604, 1040 - 16 - 160, 588, 152));
    }

    #[test]
    fn expanding_near_right_and_bottom_preserves_edge_distances() {
        assert_eq!(
            fit_window(
                &area(0, 0, 1920, 1040, 1.0),
                Some(rect(1684, 984, 220, 40)),
                588.0,
                152.0
            )
            .unwrap(),
            rect(1316, 872, 588, 152)
        );
        assert_eq!(
            fit_window(
                &area(-1920, -1080, 1920, 1040, 2.0),
                Some(rect(-512, -168, 440, 80)),
                588.0,
                152.0
            )
            .unwrap(),
            rect(-1248, -392, 1176, 304)
        );
    }

    #[test]
    fn expanding_away_from_edges_preserves_top_left_or_clamps_overflow() {
        let screen = area(-1920, -1080, 1920, 1040, 1.0);
        assert_eq!(
            fit_window(&screen, Some(rect(-1000, -700, 300, 200)), 588.0, 152.0).unwrap(),
            rect(-1000, -700, 588, 152)
        );
        assert_eq!(
            fit_window(&screen, Some(rect(-300, -130, 220, 40)), 588.0, 152.0).unwrap(),
            rect(-588, -192, 588, 152)
        );
    }

    #[test]
    fn restoration_clamps_offscreen_windows_and_fits_tiny_work_areas() {
        assert_eq!(
            fit_window(
                &area(0, 40, 800, 560, 1.25),
                Some(rect(3000, -900, 1500, 900)),
                1120.0,
                640.0
            )
            .unwrap(),
            rect(0, 40, 800, 560)
        );
        assert_eq!(
            fit_window(&area(-100, 100, 180, 30, 2.0), None, 588.0, 152.0).unwrap(),
            rect(-100, 100, 180, 30)
        );
    }

    #[test]
    fn dragging_clamps_and_snaps_all_work_area_edges_without_hiding_any_pixels() {
        let screen = area(0, 40, 1920, 1000, 1.0);
        for (proposed, expected) in [
            (rect(14, 54, 233, 60), rect(0, 40, 233, 60)),
            (rect(15, 55, 233, 60), rect(15, 55, 233, 60)),
            (rect(1673, 966, 233, 60), rect(1687, 980, 233, 60)),
            (rect(1672, 965, 233, 60), rect(1672, 965, 233, 60)),
            (rect(-900, 1500, 233, 60), rect(0, 980, 233, 60)),
        ] {
            assert_eq!(snap_drag_rect(&screen, proposed, true), Some(expected));
            assert_eq!(snap_drag_rect(&screen, expected, true), Some(expected));
        }
    }

    #[test]
    fn dragging_uses_physical_dpi_threshold_and_negative_monitor_coordinates() {
        let screen = area(-1920, -1080, 1920, 1040, 1.5);
        assert_eq!(
            snap_drag_rect(&screen, rect(-1899, -1059, 350, 90), true),
            Some(rect(-1920, -1080, 350, 90))
        );
        assert_eq!(
            snap_drag_rect(&screen, rect(-1898, -1058, 350, 90), true),
            Some(rect(-1898, -1058, 350, 90))
        );
        assert_eq!(
            snap_drag_rect(&screen, rect(-371, -151, 350, 90), true),
            Some(rect(-350, -130, 350, 90))
        );
    }

    #[test]
    fn dragging_can_move_to_another_work_area_and_fit_a_smaller_monitor() {
        let left = area(-1920, 0, 1920, 1040, 1.0);
        let right = area(0, 40, 1280, 680, 1.25);
        let proposed = rect(-80, 120, 588, 152);
        assert_eq!(
            snap_drag_rect(&left, proposed, true),
            Some(rect(-588, 120, 588, 152))
        );
        assert_eq!(
            snap_drag_rect(&right, proposed, true),
            Some(rect(0, 120, 588, 152))
        );
        assert_eq!(
            snap_drag_rect(
                &area(200, -500, 180, 30, 2.0),
                rect(-10, -20, 588, 152),
                true
            ),
            Some(rect(200, -500, 180, 30))
        );
    }

    #[test]
    fn dragging_rejects_invalid_rectangles_without_panicking() {
        for screen in [
            area(0, 0, 0, 800, 1.0),
            area(0, 0, 1200, 800, f64::NAN),
            area(i32::MAX, 0, 1200, 800, 1.0),
        ] {
            assert_eq!(snap_drag_rect(&screen, rect(0, 0, 233, 60), true), None);
        }
        assert_eq!(
            snap_drag_rect(&area(0, 0, 1200, 800, 1.0), rect(0, 0, 0, 60), true),
            None
        );
    }

    #[test]
    fn snap_preference_defaults_off_and_off_keeps_work_area_clamping() {
        assert!(!initial_snap_to_edge(None));
        for settings in [
            json!({}),
            json!({"floatingMonitor":{"snapToEdge":"true"}}),
            json!({"floatingMonitor":{"snapToEdge":false}}),
        ] {
            assert!(!initial_snap_to_edge(Some(&settings)));
        }
        assert!(initial_snap_to_edge(Some(
            &json!({"floatingMonitor":{"snapToEdge":true}})
        )));
        let screen = area(0, 0, 1920, 1040, 1.0);
        assert_eq!(
            snap_drag_rect(&screen, rect(8, 8, 225, 40), false),
            Some(rect(8, 8, 225, 40))
        );
        assert_eq!(
            snap_drag_rect(&screen, rect(-8, 1010, 225, 40), false),
            Some(rect(0, 1000, 225, 40))
        );
    }

    #[test]
    fn accumulated_cursor_motion_escapes_snap_feedback_and_can_drag_again() {
        let screen = area(0, 0, 1920, 1040, 1.0);
        let mut state = DragState {
            snap_to_edge: true,
            ..Default::default()
        };
        let mut actual = rect(0, 100, 225, 40);
        state.begin((100, 120), actual);
        for total_delta in 1..=40 {
            // Reproduce Windows proposing the last snapped RECT + only 1px.
            // Feeding this position back used to keep the window at x=0 forever.
            let proposed = rect(actual.x + 1, actual.y, actual.width, actual.height);
            let candidate = state.candidate((100 + total_delta, 120), proposed);
            actual = snap_drag_rect(&screen, candidate, state.snap_to_edge).unwrap();
            assert_eq!(actual.x, if total_delta <= 14 { 0 } else { total_delta });
        }
        state.finish();
        assert!(state.origin.is_none());
        state.begin((700, 120), actual);
        assert_eq!(state.candidate((710, 120), actual).x, 50);
        state.finish();
        // A subsequent move from a snapped edge gets a new origin as well.
        state.begin((900, 120), rect(0, 100, 225, 40));
        assert_eq!(
            snap_drag_rect(&screen, state.candidate((916, 120), actual), true)
                .unwrap()
                .x,
            16
        );
    }

    #[test]
    fn accumulated_cursor_motion_can_pull_away_from_every_snapped_corner() {
        let screen = area(-1920, -1080, 1920, 1040, 1.5);
        for (x, y, dx, dy) in [
            (-1920, -1080, 1, 1),
            (-225, -1080, -1, 1),
            (-1920, -80, 1, -1),
            (-225, -80, -1, -1),
        ] {
            let mut state = DragState {
                snap_to_edge: true,
                ..Default::default()
            };
            let mut actual = rect(x, y, 225, 40);
            let cursor = (x + 100, y + 20);
            state.begin(cursor, actual);
            for travel in 1..=40 {
                let proposed = rect(actual.x + dx, actual.y + dy, 225, 40);
                let candidate =
                    state.candidate((cursor.0 + dx * travel, cursor.1 + dy * travel), proposed);
                actual = snap_drag_rect(&screen, candidate, state.snap_to_edge).unwrap();
                let moved = if travel <= 21 { 0 } else { travel };
                assert_eq!(actual, rect(x + dx * moved, y + dy * moved, 225, 40));
            }
        }
    }

    #[test]
    fn live_snap_toggle_and_dpi_rebase_do_not_reuse_an_old_drag_origin() {
        let screen = area(0, 0, 1920, 1040, 1.0);
        let mut state = DragState {
            snap_to_edge: true,
            ..Default::default()
        };
        let original = rect(0, 100, 225, 40);
        state.begin((100, 120), original);
        let candidate = state.candidate((105, 120), original);
        assert_eq!(
            snap_drag_rect(&screen, candidate, state.snap_to_edge)
                .unwrap()
                .x,
            0
        );
        state.snap_to_edge = false;
        assert_eq!(
            snap_drag_rect(&screen, candidate, state.snap_to_edge)
                .unwrap()
                .x,
            5
        );
        state.rebase((-1000, 200), rect(-1200, 160, 338, 60));
        let scaled = state.candidate((-980, 206), rect(-1200, 160, 338, 60));
        assert_eq!(scaled, rect(-1180, 166, 338, 60));
        state.finish();
        state.rebase((10, 10), original);
        assert!(state.origin.is_none());
        assert_eq!(state.candidate((500, 500), original), original);
    }

    #[test]
    fn resize_bounds_reject_nonfinite_and_unsafe_dimensions() {
        for (width, height) in [
            (f64::NAN, 40.0),
            (220.0, f64::INFINITY),
            (f64::NEG_INFINITY, 40.0),
            (95.0, 40.0),
            (1121.0, 40.0),
            (220.0, 23.0),
            (220.0, 641.0),
        ] {
            assert!(validate_size(width, height).is_err());
        }
        assert!(validate_size(220.0, 40.0).is_ok());
        assert!(validate_size(160.0, 40.0).is_ok());
        assert!(validate_size(96.0, 24.0).is_ok());
        assert!(validate_size(1120.0, 640.0).is_ok());
        for screen in [
            area(0, 0, 0, 1080, 1.0),
            area(0, 0, 1920, 0, 1.0),
            area(0, 0, 1920, 1080, 0.0),
            area(0, 0, 1920, 1080, f64::NAN),
        ] {
            assert!(fit_window(&screen, None, 588.0, 152.0).is_err());
        }
    }

    #[test]
    fn monitor_navigation_only_accepts_known_destinations() {
        for destination in [
            "overview",
            "chat",
            "monitoring",
            "usage",
            "tasks",
            "settings",
            "taskbarColors",
            "quickBenchmark",
        ] {
            assert!(require_destination(destination).is_ok());
        }
        for destination in [
            "",
            "start_service",
            "shutdown",
            "https://example.com",
            "Settings",
        ] {
            assert!(require_destination(destination).is_err());
        }
    }

    #[test]
    fn initial_pin_preference_defaults_safely_and_honors_false() {
        assert!(initial_always_on_top(None));
        for settings in [
            Value::Null,
            json!({}),
            json!({"floatingMonitor":null}),
            json!({"floatingMonitor":{"alwaysOnTop":"false"}}),
        ] {
            assert!(initial_always_on_top(Some(&settings)));
        }
        assert!(initial_always_on_top(Some(
            &json!({"floatingMonitor":{"alwaysOnTop":true}})
        )));
        assert!(!initial_always_on_top(Some(
            &json!({"floatingMonitor":{"alwaysOnTop":false}})
        )));
    }

    #[tokio::test]
    async fn snapshot_keeps_monitor_preferences_for_renderer_normalization() {
        let (snapshot, _) = fixture(Some(false), true, true).await;
        assert_eq!(
            snapshot["settings"]["floatingMonitor"],
            json!({"alwaysOnTop":false,"quickActions":["chat","settings"],"futureOption":"keep"})
        );
    }

    #[tokio::test]
    async fn stopped_and_unknown_processes_never_probe_or_restore_a_model() {
        for running in [Some(false), None] {
            let (snapshot, calls) = fixture(running, true, true).await;
            assert_eq!(
                snapshot["phase"],
                if running == Some(false) {
                    "stopped"
                } else {
                    "unavailable"
                }
            );
            assert!(snapshot.get("metrics").is_none());
            assert!(calls.iter().all(|(method, _)| matches!(
                method.as_str(),
                "store_get" | "local_installations" | "supervisor_status" | "service_status"
            )));
        }
    }

    #[tokio::test]
    async fn health_and_metric_failures_never_publish_old_measurements() {
        for (health, metrics, phase) in
            [(false, true, "disconnected"), (true, false, "unavailable")]
        {
            let (snapshot, calls) = fixture(Some(true), health, metrics).await;
            assert_eq!(snapshot["phase"], phase);
            assert!(snapshot.get("metrics").is_none());
            if !health {
                assert!(!calls.iter().any(|(_, params)| params["path"] == "/metrics"));
            }
        }
    }

    #[tokio::test]
    async fn live_snapshot_uses_only_fixed_read_only_endpoints() {
        let (snapshot, calls) = fixture(Some(true), true, true).await;
        assert_eq!(snapshot["phase"], "online");
        assert_eq!(snapshot["metrics"]["live"]["tok_s"], 90);
        assert!(calls
            .iter()
            .filter(|(method, _)| method == "strata_request")
            .all(|(_, params)| params["method"] == "GET"
                && matches!(params["path"].as_str(), Some("/health" | "/metrics"))));
        assert!(require_label("main", LABEL).is_err());
        assert!(require_label(LABEL, "main").is_err());
        assert!(require_label(LABEL, LABEL).is_ok());
    }

    #[tokio::test]
    async fn absent_background_stays_absent_and_write_endpoints_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let client = reqwest::Client::new();
        assert!(read_existing(
            directory.path(),
            &client,
            "store_get",
            json!({"key":"settings"})
        )
        .await
        .is_err());
        assert!(
            read_existing(directory.path(), &client, "start_service", json!({}))
                .await
                .is_err()
        );
        assert!(read_existing(
            directory.path(),
            &client,
            "strata_request",
            json!({"path":"/load","method":"POST"})
        )
        .await
        .is_err());
        #[cfg(windows)]
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};

            // The Unix client creates its private IPC directory before a
            // missing socket fails. It must create no backend or model state.
            let entries: Vec<_> = std::fs::read_dir(directory.path())
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
            assert_eq!(entries, [std::ffi::OsString::from(".ipc")]);
            let ipc = directory.path().join(".ipc");
            let metadata = std::fs::symlink_metadata(&ipc).unwrap();
            assert!(metadata.is_dir() && !metadata.file_type().is_symlink());
            assert_eq!(metadata.permissions().mode() & 0o7777, 0o700);
            assert_eq!(
                metadata.uid().to_string(),
                strata_local_ipc::current_identity().unwrap()
            );
            assert_eq!(std::fs::read_dir(ipc).unwrap().count(), 0);
        }
    }
}
