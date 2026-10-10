mod http;
mod startup;
mod supervisor_client;

#[tauri::command]
async fn prepare_local_runtime(
    state: tauri::State<'_, ClientState>,
) -> Result<serde_json::Value, String> {
    state
        .ipc
        .request("prepare_local_runtime", serde_json::json!({}))
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn local_runtime_installation(
    state: tauri::State<'_, ClientState>,
) -> Result<serde_json::Value, String> {
    state
        .ipc
        .request("local_runtime_installation", serde_json::json!({}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn local_installation_migration(
    state: tauri::State<'_, ClientState>,
) -> Result<serde_json::Value, String> {
    state
        .ipc
        .request("local_installation_migration", serde_json::json!({}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn switch_local_service(
    state: tauri::State<'_, ClientState>,
    profile_id: String,
) -> Result<serde_json::Value, String> {
    state
        .ipc
        .request(
            "switch_local_service",
            serde_json::json!({"profileId":profile_id}),
        )
        .await
        .map_err(|e| e.to_string())
}

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use strata_runtime_core::{discovery::LocalCandidate, types::ServiceProfile};
use supervisor_client::SupervisorClient;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, State,
};
use tokio_util::sync::CancellationToken;

pub struct ClientState {
    ipc: Arc<SupervisorClient>,
    client: reqwest::Client,
    streams: Mutex<HashMap<String, CancellationToken>>,
    close_to_tray: AtomicBool,
    tray_show: MenuItem<tauri::Wry>,
    tray_quit: MenuItem<tauri::Wry>,
    tray_stop_quit: MenuItem<tauri::Wry>,
}
impl ClientState {
    fn cleanup_ui(&self) {
        if let Ok(streams) = self.streams.lock() {
            for token in streams.values() {
                token.cancel();
            }
        }
        // Service, install task, SQLite and Job Object live in another process.
    }
}

#[tauri::command]
fn get_startup_status() -> Result<Value, String> {
    startup::status()
}

#[tauri::command]
fn set_startup_enabled(state: State<'_, ClientState>, enabled: bool) -> Result<Value, String> {
    let executable = state.ipc.staged_executable().map_err(|e| e.to_string())?;
    startup::set(enabled, &executable, &state.ipc.data_dir)
}

#[tauri::command]
async fn get_background_policy(state: State<'_, ClientState>) -> Result<Value, String> {
    state
        .ipc
        .request("get_background_policy", json!({}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_background_policy(
    state: State<'_, ClientState>,
    mode: String,
    auto_recover: bool,
) -> Result<Value, String> {
    state
        .ipc
        .request(
            "set_background_policy",
            json!({"mode":mode,"autoRecover":auto_recover}),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn prepare_app_update(state: State<'_, ClientState>) -> Result<Value, String> {
    if !state.streams.lock().map_err(|e| e.to_string())?.is_empty() {
        return Err("聊天仍在生成，完成后再更新应用".into());
    }
    state
        .ipc
        .request("prepare_app_update", json!({}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn restart_interface(app: tauri::AppHandle, state: State<'_, ClientState>) {
    state.cleanup_ui();
    app.restart();
}

#[tauri::command]
async fn tuning_start(
    state: State<'_, ClientState>,
    profile_id: String,
    request: Value,
) -> Result<Value, String> {
    state
        .ipc
        .request(
            "tuning_start",
            json!({"profileId":profile_id,"request":request}),
        )
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn tuning_status(state: State<'_, ClientState>, profile_id: String) -> Result<Value, String> {
    state
        .ipc
        .request("tuning_status", json!({"profileId":profile_id}))
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn tuning_cancel(state: State<'_, ClientState>, job_id: String) -> Result<Value, String> {
    state
        .ipc
        .request("tuning_cancel", json!({"jobId":job_id}))
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn tuning_apply(
    state: State<'_, ClientState>,
    job_id: String,
    candidate_id: String,
) -> Result<Value, String> {
    state
        .ipc
        .request(
            "tuning_apply",
            json!({"jobId":job_id,"candidateId":candidate_id}),
        )
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn tuning_restore(state: State<'_, ClientState>, job_id: String) -> Result<Value, String> {
    state
        .ipc
        .request("tuning_restore", json!({"jobId":job_id}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn store_get(state: State<'_, ClientState>, key: String) -> Result<Value, String> {
    state
        .ipc
        .request("store_get", json!({"key":key}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn store_set(
    state: State<'_, ClientState>,
    key: String,
    value: Value,
) -> Result<Value, String> {
    state
        .ipc
        .request("store_set", json!({"key":key,"value":value}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_api_key(
    state: State<'_, ClientState>,
    profile_id: String,
    api_key: String,
) -> Result<Value, String> {
    state
        .ipc
        .request(
            "set_api_key",
            json!({"profileId":profile_id,"apiKey":api_key}),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn has_api_key(state: State<'_, ClientState>, profile_id: String) -> Result<Value, String> {
    state
        .ipc
        .request("has_api_key", json!({"profileId":profile_id}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn strata_request(
    state: State<'_, ClientState>,
    profile: ServiceProfile,
    path: String,
    method: String,
    body: Option<Value>,
) -> Result<Value, String> {
    state
        .ipc
        .request(
            "strata_request",
            json!({"profile":profile,"path":path,"method":method,"body":body}),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_service(
    state: State<'_, ClientState>,
    profile: ServiceProfile,
) -> Result<Value, String> {
    state
        .ipc
        .request("start_service", json!({"profile":profile}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn stop_service(state: State<'_, ClientState>, profile_id: String) -> Result<Value, String> {
    state
        .ipc
        .request("stop_service", json!({"profileId":profile_id}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn restart_service(
    state: State<'_, ClientState>,
    profile: ServiceProfile,
) -> Result<Value, String> {
    state
        .ipc
        .request("restart_service", json!({"profile":profile}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn take_over_service(
    state: State<'_, ClientState>,
    profile: ServiceProfile,
) -> Result<Value, String> {
    state
        .ipc
        .request("take_over_service", json!({"profile":profile}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn service_status(
    state: State<'_, ClientState>,
    profile_id: String,
    profile: Option<ServiceProfile>,
) -> Result<Value, String> {
    state
        .ipc
        .request(
            "service_status",
            json!({"profileId":profile_id,"profile":profile}),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_logs(
    state: State<'_, ClientState>,
    profile: ServiceProfile,
    limit: usize,
) -> Result<Value, String> {
    state
        .ipc
        .request("read_logs", json!({"profile":profile,"limit":limit}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn environment_info(state: State<'_, ClientState>) -> Result<Value, String> {
    state
        .ipc
        .request("environment_info", json!({}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_setup(
    state: State<'_, ClientState>,
    profile: ServiceProfile,
    model: String,
    quant: String,
    context: u32,
    images: bool,
) -> Result<Value, String> {
    state.ipc.request("run_setup",json!({"profile":profile,"model":model,"quant":quant,"context":context,"images":images})).await.map_err(|e|e.to_string())
}

#[tauri::command]
async fn install_runtime(
    state: State<'_, ClientState>,
    directory: String,
) -> Result<Value, String> {
    state
        .ipc
        .request("install_runtime", json!({"directory":directory}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_runtime(
    state: State<'_, ClientState>,
    profile: ServiceProfile,
) -> Result<Value, String> {
    state
        .ipc
        .request("update_runtime", json!({"profile":profile}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_tasks(state: State<'_, ClientState>) -> Result<Value, String> {
    state
        .ipc
        .request("list_tasks", json!({}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cancel_task(state: State<'_, ClientState>, task_id: String) -> Result<Value, String> {
    state
        .ipc
        .request("cancel_task", json!({"taskId":task_id}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_config(
    state: State<'_, ClientState>,
    profile: ServiceProfile,
) -> Result<Value, String> {
    state
        .ipc
        .request("read_config", json!({"profile":profile}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_config(
    state: State<'_, ClientState>,
    profile: ServiceProfile,
    config: Value,
) -> Result<Value, String> {
    state
        .ipc
        .request("write_config", json!({"profile":profile,"config":config}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_markdown_export(
    state: State<'_, ClientState>,
    path: String,
    content: String,
) -> Result<Value, String> {
    state
        .ipc
        .request(
            "write_markdown_export",
            json!({"path":path,"content":content}),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_local_models(
    state: State<'_, ClientState>,
    profile: ServiceProfile,
) -> Result<Value, String> {
    state
        .ipc
        .request("list_local_models", json!({"profile":profile}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_diagnostics(
    state: State<'_, ClientState>,
    profile: ServiceProfile,
) -> Result<Value, String> {
    state
        .ipc
        .request("export_diagnostics", json!({"profile":profile}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn discover_local(
    state: State<'_, ClientState>,
    directories: Option<Vec<String>>,
) -> Result<Value, String> {
    state
        .ipc
        .request("discover_local", json!({"directories":directories}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn import_local(
    state: State<'_, ClientState>,
    candidate: LocalCandidate,
) -> Result<Value, String> {
    state
        .ipc
        .request("import_local", json!({"candidate":candidate}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ensure_local_service(
    state: State<'_, ClientState>,
    profile_id: String,
) -> Result<Value, String> {
    state
        .ipc
        .request("ensure_local_service", json!({"profileId":profile_id}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn supervisor_status(state: State<'_, ClientState>) -> Result<Value, String> {
    state
        .ipc
        .request("supervisor_status", json!({}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn shutdown_supervisor(state: State<'_, ClientState>) -> Result<Value, String> {
    state
        .ipc
        .request("shutdown_supervisor", json!({}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn local_installations(state: State<'_, ClientState>) -> Result<Value, String> {
    state
        .ipc
        .request("local_installations", json!({}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn apply_settings(state: State<'_, ClientState>, settings: Value) -> Result<(), String> {
    let close = settings
        .get("closeToTray")
        .and_then(Value::as_bool)
        .ok_or("closeToTray 必须是布尔值")?;
    state.close_to_tray.store(close, Ordering::Relaxed);
    let english = settings.get("language").and_then(Value::as_str) == Some("en");
    state
        .tray_show
        .set_text(if english {
            "Show Strata Manager"
        } else {
            "显示 Strata Manager"
        })
        .map_err(|e| e.to_string())?;
    state
        .tray_quit
        .set_text(if english {
            "Quit interface"
        } else {
            "退出界面"
        })
        .map_err(|e| e.to_string())?;
    state
        .tray_stop_quit
        .set_text(if english {
            "Quit and stop local services"
        } else {
            "退出并停止本机服务"
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn rename_local_installation(
    state: State<'_, ClientState>,
    profile_id: String,
    name: String,
) -> Result<Value, String> {
    state
        .ipc
        .request(
            "rename_local_installation",
            json!({"profileId":profile_id,"name":name}),
        )
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn remove_local_installation(
    state: State<'_, ClientState>,
    profile_id: String,
) -> Result<Value, String> {
    state
        .ipc
        .request("remove_local_installation", json!({"profileId":profile_id}))
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn analytics_query(
    state: State<'_, ClientState>,
    query: Option<Value>,
) -> Result<Value, String> {
    state
        .ipc
        .request(
            "analytics_query",
            json!({"query":query.unwrap_or_else(||json!({}))}),
        )
        .await
        .map_err(|e| e.to_string())
}
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let data_dir = supervisor_client::data_directory(&app.path().app_data_dir()?);
            if !data_dir.is_absolute() {
                return Err("后台数据目录必须是绝对路径".into());
            }
            std::fs::create_dir_all(&data_dir)?;
            let ipc = Arc::new(SupervisorClient::new(data_dir, app.path().resource_dir()?));
            let saved_settings =
                tauri::async_runtime::block_on(ipc.request("store_get", json!({"key":"settings"})))
                    .unwrap_or(Value::Null);
            let english = saved_settings.get("language").and_then(Value::as_str) == Some("en");
            let close = saved_settings
                .get("closeToTray")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let show = MenuItem::with_id(
                app,
                "show",
                if english {
                    "Show Strata Manager"
                } else {
                    "显示 Strata Manager"
                },
                true,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(
                app,
                "quit",
                if english {
                    "Quit interface"
                } else {
                    "退出界面"
                },
                true,
                None::<&str>,
            )?;
            let stop_quit = MenuItem::with_id(
                app,
                "stop-quit",
                if english {
                    "Quit and stop local services"
                } else {
                    "退出并停止本机服务"
                },
                true,
                None::<&str>,
            )?;
            app.manage(ClientState {
                ipc,
                client: reqwest::Client::builder()
                    .connect_timeout(Duration::from_secs(10))
                    .redirect(reqwest::redirect::Policy::none())
                    .build()?,
                streams: Mutex::new(HashMap::new()),
                close_to_tray: AtomicBool::new(close),
                tray_show: show.clone(),
                tray_quit: quit.clone(),
                tray_stop_quit: stop_quit.clone(),
            });
            let menu = Menu::with_items(app, &[&show, &quit, &stop_quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().ok_or("应用图标缺失")?.clone())
                .tooltip("Strata Manager")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.state::<ClientState>().cleanup_ui();
                        app.exit(0);
                    }
                    "stop-quit" => {
                        let handle = app.clone();
                        let ipc = app.state::<ClientState>().ipc.clone();
                        tauri::async_runtime::spawn(async move {
                            if ipc.request("shutdown_supervisor", json!({})).await.is_ok() {
                                handle.state::<ClientState>().cleanup_ui();
                                handle.exit(0);
                            } else if let Some(window) = handle.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        });
                    }
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<ClientState>();
                if state.close_to_tray.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    state.cleanup_ui();
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_startup_status,
            set_startup_enabled,
            get_background_policy,
            set_background_policy,
            prepare_app_update,
            restart_interface,
            tuning_start,
            tuning_status,
            tuning_cancel,
            tuning_apply,
            tuning_restore,
            switch_local_service,
            prepare_local_runtime,
            local_runtime_installation,
            store_get,
            store_set,
            set_api_key,
            has_api_key,
            strata_request,
            start_service,
            stop_service,
            restart_service,
            take_over_service,
            service_status,
            read_logs,
            environment_info,
            run_setup,
            install_runtime,
            update_runtime,
            list_tasks,
            cancel_task,
            read_config,
            write_config,
            write_markdown_export,
            list_local_models,
            export_diagnostics,
            discover_local,
            import_local,
            ensure_local_service,
            supervisor_status,
            shutdown_supervisor,
            local_installations,
            local_installation_migration,
            http::strata_stream,
            http::cancel_stream,
            apply_settings,
            rename_local_installation,
            analytics_query,
            remove_local_installation
        ])
        .build(tauri::generate_context!())
        .expect("Strata Manager initialization failed");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            handle.state::<ClientState>().cleanup_ui();
        }
    });
}
