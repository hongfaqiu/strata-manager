use crate::ClientState;
use serde_json::{json, Value};
use std::{future::Future, path::Path, time::Duration};
use strata_runtime_core::types::ServiceProfile;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "service-monitor";

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

fn initial_width(settings: Option<&Value>) -> f64 {
    if settings.is_some_and(|value| value["floatingMonitor"]["showSampleTime"] == true) {
        268.0
    } else {
        220.0
    }
}

#[tauri::command]
pub async fn open_monitor_window(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    require_label(window.label(), "main")?;
    open_window(&app).await
}

pub(crate) async fn open_window(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<ClientState>();
    static OPEN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = OPEN.lock().await;
    if let Some(existing) = app.get_webview_window(LABEL) {
        existing
            .emit("monitor-restored", ())
            .map_err(|e| e.to_string())?;
        existing.show().map_err(|e| e.to_string())?;
        existing.unminimize().map_err(|e| e.to_string())?;
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
    let width = initial_width(settings.as_ref());
    let monitor = WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::App("index.html?window=monitor".into()),
    )
    .title("Strata Manager · Monitor")
    .inner_size(width, 40.0)
    .min_inner_size(220.0, 40.0)
    .max_inner_size(268.0, 40.0)
    .decorations(false)
    .resizable(false)
    .skip_taskbar(true)
    .always_on_top(initial_always_on_top(settings.as_ref()))
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;
    // Keep the initial strip inside the current monitor's work area. Subsequent
    // opens reuse its user-selected position and pin preference.
    if let Some(screen) = app
        .get_webview_window("main")
        .and_then(|window| window.current_monitor().ok().flatten())
    {
        let area = screen.work_area();
        let scale = screen.scale_factor();
        let x =
            area.position.x + (f64::from(area.size.width) - (width + 16.0) * scale).max(0.0) as i32;
        let y = area.position.y + (f64::from(area.size.height) - 56.0 * scale).max(0.0) as i32;
        monitor
            .set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
    }
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
    fn compact_width_ignores_legacy_buttons_and_tracks_optional_time() {
        assert_eq!(initial_width(None), 220.0);
        assert_eq!(
            initial_width(Some(
                &json!({"floatingMonitor":{"actions":["chat", "pin"]}})
            )),
            220.0
        );
        assert_eq!(
            initial_width(Some(&json!({"floatingMonitor":{"showSampleTime":true}}))),
            268.0
        );
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
