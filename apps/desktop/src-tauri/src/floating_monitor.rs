use crate::ClientState;
use serde_json::{json, Value};
use std::{future::Future, path::Path, time::Duration};
use strata_runtime_core::types::ServiceProfile;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "service-monitor";
const MIN_WIDTH: f64 = 220.0;
const MIN_HEIGHT: f64 = 40.0;
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
        "overview" | "chat" | "monitoring" | "usage" | "tasks" | "settings" | "quickBenchmark"
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

fn initial_size(settings: Option<&Value>) -> (f64, f64) {
    let preferences = settings.and_then(|settings| settings.get("floatingMonitor"));
    let font = preferences
        .and_then(|value| value["fontSize"].as_f64())
        .filter(|font| font.is_finite())
        .unwrap_or(16.0)
        .round()
        .clamp(12.0, 24.0);
    let layout = preferences
        .and_then(|value| value["layout"].as_str())
        .filter(|layout| matches!(*layout, "compact" | "twoRow" | "panel"))
        .unwrap_or("twoRow");
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
    let count = if metrics.is_empty() { 6 } else { metrics.len() };
    let graphs = preferences
        .and_then(|value| value["showGraphs"].as_bool())
        .unwrap_or(true);
    let labels = preferences
        .and_then(|value| value["showLabels"].as_bool())
        .unwrap_or(true);
    let (columns, rows, cell_width) = match layout {
        "compact" => (
            count.min(4),
            count.div_ceil(4),
            (font * 5.5 + if labels { 60.0 } else { 12.0 }).ceil(),
        ),
        "panel" => (2, count.div_ceil(2), (font * 7.0 + 32.0).ceil()),
        _ => (
            count.div_ceil(2),
            count.min(2),
            (font * 7.5 + if labels { 64.0 } else { 20.0 }).ceil(),
        ),
    };
    let label_font = (font * 0.7).round().max(10.0);
    let cell_height = (font * 1.4).ceil()
        + if graphs { 20.0 } else { 0.0 }
        + if layout == "panel" && labels {
            label_font + 6.0
        } else {
            4.0
        };
    let header_height = (font * 1.2).ceil() + 10.0;
    (
        (columns as f64 * cell_width + (columns - 1) as f64 * 8.0 + 20.0)
            .clamp(MIN_WIDTH, MAX_WIDTH),
        (rows as f64 * cell_height + (rows - 1) as f64 * 8.0 + header_height + 20.0)
            .clamp(MIN_HEIGHT, MAX_HEIGHT),
    )
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
        Err("监控窗口尺寸必须为有限数值，宽度 220–1120、高度 40–640".into())
    }
}

fn fit_window(
    area: &MonitorArea,
    current: Option<WindowRect>,
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
    let width = (width * area.scale)
        .round()
        .clamp(1.0, f64::from(area.width));
    let height = (height * area.scale)
        .round()
        .clamp(1.0, f64::from(area.height));
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
                right - right_gap - width
            } else {
                f64::from(current.x)
            },
            if near_edge.contains(&bottom_gap) {
                bottom - bottom_gap - height
            } else {
                f64::from(current.y)
            },
        )
    } else {
        (
            right - width - 16.0 * area.scale,
            bottom - height - 16.0 * area.scale,
        )
    };
    Ok(WindowRect {
        x: x.clamp(left, right - width).round() as i32,
        y: y.clamp(top, bottom - height).round() as i32,
        width: width as u32,
        height: height as u32,
    })
}

fn current_rect(window: &WebviewWindow) -> Result<WindowRect, String> {
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    Ok(WindowRect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
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
    rect: WindowRect,
) -> Result<(), String> {
    // A very small work area may be smaller than the usual logical minimum.
    // Physical constraints prevent an obsolete DPI or the old 40px maximum
    // from forcing a resized/restored window outside that area.
    let bounded_size = |width: f64, height: f64| {
        tauri::PhysicalSize::new(
            ((width * area.scale).round() as u32).min(area.width).max(1),
            ((height * area.scale).round() as u32)
                .min(area.height)
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
    let rect = fit_window(&area, Some(current_rect(&window)?), width, height)?;
    apply_layout(&window, &area, rect)?;
    Ok(json!({
        "width": f64::from(rect.width) / area.scale,
        "height": f64::from(rect.height) / area.scale,
        "x": rect.x, "y": rect.y, "scaleFactor": area.scale
    }))
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
        existing.unminimize().map_err(|e| e.to_string())?;
        let area = current_area(app, &existing)?;
        let current = current_rect(&existing)?;
        let scale = existing.scale_factor().map_err(|e| e.to_string())?;
        let scale = if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            area.scale
        };
        let rect = fit_window(
            &area,
            Some(current),
            (f64::from(current.width) / scale).clamp(MIN_WIDTH, MAX_WIDTH),
            (f64::from(current.height) / scale).clamp(MIN_HEIGHT, MAX_HEIGHT),
        )?;
        apply_layout(&existing, &area, rect)?;
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
    let rect = fit_window(&area, None, width, height)?;
    apply_layout(&monitor, &area, rect)?;
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
        assert_eq!(initial_size(None), (588.0, 152.0));
        for settings in [
            Value::Null,
            json!({}),
            json!({"floatingMonitor":null}),
            json!({"floatingMonitor":{"actions":["chat", "pin"]}}),
            json!({"floatingMonitor":{"showSampleTime":true}}),
            json!({"floatingMonitor":{"layout":"unknown","fontSize":"24","metrics":["unknown"],"showGraphs":"false","showLabels":null}}),
            json!({"floatingMonitor":{"metrics":[]}}),
        ] {
            assert_eq!(initial_size(Some(&settings)), (588.0, 152.0));
        }
    }

    #[test]
    fn initial_size_normalizes_metrics_and_respects_layout_and_visibility() {
        assert_eq!(
            initial_size(Some(
                &json!({"floatingMonitor":{"metrics":["cpu","cpu",null,"unknown"]}})
            )),
            (220.0, 97.0)
        );
        assert_eq!(
            initial_size(Some(
                &json!({"floatingMonitor":{"showGraphs":false,"showLabels":false}})
            )),
            (456.0, 112.0)
        );
        assert_eq!(
            initial_size(Some(&json!({"floatingMonitor":{"fontSize":1}}))),
            (498.0, 135.0)
        );
        assert_eq!(
            initial_size(Some(&json!({"floatingMonitor":{"fontSize":17.5}}))),
            (633.0, 160.0)
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
            ("compact", (812.0, 183.0)),
            ("twoRow", (1020.0, 183.0)),
            ("panel", (428.0, 391.0)),
        ] {
            let settings =
                json!({"floatingMonitor":{"layout":layout,"fontSize":900,"metrics":metrics}});
            assert_eq!(initial_size(Some(&settings)), expected);
        }
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
    fn resize_bounds_reject_nonfinite_and_unsafe_dimensions() {
        for (width, height) in [
            (f64::NAN, 40.0),
            (220.0, f64::INFINITY),
            (f64::NEG_INFINITY, 40.0),
            (219.0, 40.0),
            (1121.0, 40.0),
            (220.0, 39.0),
            (220.0, 641.0),
        ] {
            assert!(validate_size(width, height).is_err());
        }
        assert!(validate_size(220.0, 40.0).is_ok());
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
