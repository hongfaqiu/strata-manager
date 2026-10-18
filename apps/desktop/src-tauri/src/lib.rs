mod arena;
mod config_cleanup;
mod configuration_details;
mod configuration_files;
mod daily_experience;
mod floating_monitor;
mod http;
mod invoke_policy;
mod model_files;
mod monitor_tray;
mod png_export;
mod running_service_connection;
mod runtime_detection;
mod runtime_update_queue;
mod runtime_updates;
mod service_sharing;
mod startup;
mod supervisor_client;
mod system_locale;
mod taskbar_monitor;
mod vision_files;
mod window_layout;

#[tauri::command]
async fn prepare_local_runtime(
    state: tauri::State<'_, ClientState>,
    local_archives: Option<strata_runtime_core::installation::LocalRuntimeArchives>,
) -> Result<serde_json::Value, String> {
    let params = match local_archives.filter(|archives| !archives.is_empty()) {
        Some(archives) => serde_json::json!({ "localArchives": archives }),
        None => serde_json::json!({}),
    };
    state
        .ipc
        .request("prepare_local_runtime", params)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn local_runtime_installation(
    state: tauri::State<'_, ClientState>,
) -> Result<serde_json::Value, String> {
    runtime_detection::installation_status(&state.ipc).await
}

#[tauri::command]
async fn connect_running_service(
    app: tauri::AppHandle,
    state: tauri::State<'_, ClientState>,
    candidate: LocalCandidate,
) -> Result<Value, String> {
    let owner = running_service_connection::owner(&candidate).await.map_err(|message| {
        let code = if message.starts_with("RUNNING_OWNER_NOT_FOUND") { "RUNNING_OWNER_NOT_FOUND" } else { "RUNNING_OWNER_UNVERIFIED" };
        json!({"code":code,"message":message.trim_start_matches("RUNNING_OWNER_NOT_FOUND:").trim()}).to_string()
    })?;
    if dunce::canonicalize(&state.ipc.data_dir).ok() == dunce::canonicalize(&owner.data_dir).ok() {
        return Ok(json!({"profileId":owner.profile_id,"restarting":false}));
    }
    let current = state
        .ipc
        .request("hello", json!({}))
        .await
        .map_err(|e| e.to_string())?;
    if current["activeServices"].as_u64() != Some(0)
        || !state.streams.lock().map_err(|e| e.to_string())?.is_empty()
    {
        return Err("当前后台仍有受管服务或请求，请先完成当前操作再连接另一后台".into());
    }
    if std::env::var_os("STRATA_MANAGER_DATA_DIR").is_some() {
        return Err("当前窗口使用显式指定的数据目录，请从正常窗口连接运行中的管理后台".into());
    }
    let default = app.path().app_data_dir().map_err(|e| e.to_string())?;
    running_service_connection::remember_owner(&default, &owner)?;
    state.cleanup_ui();
    let profile_id = owner.profile_id;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(250)).await;
        app.restart();
    });
    Ok(json!({"profileId":profile_id,"restarting":true}))
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
    let status = state
        .ipc
        .request(
            "switch_local_service",
            serde_json::json!({"profileId":profile_id}),
        )
        .await
        .map_err(|e| e.to_string())?;
    if status["running"].as_bool() == Some(true) {
        if let Err(error) = record_last_activation(&state.ipc, &profile_id).await {
            eprintln!("Activated configuration timestamp could not be saved: {error}");
        }
    }
    Ok(status)
}

async fn record_last_activation(ipc: &SupervisorClient, profile_id: &str) -> Result<(), String> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LOCK.lock().await;
    let previous = ipc
        .request(
            "store_get",
            json!({"key":"localConfigurationLastActivatedAt"}),
        )
        .await
        .map_err(|error| error.to_string())?;
    let mut timestamps = previous.as_object().cloned().unwrap_or_default();
    timestamps.insert(profile_id.into(), json!(strata_runtime_core::types::now()));
    ipc.request(
        "store_set",
        json!({"key":"localConfigurationLastActivatedAt","value":timestamps}),
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok(())
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
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, State,
};
use tokio_util::sync::CancellationToken;

pub struct ClientState {
    ipc: Arc<SupervisorClient>,
    client: reqwest::Client,
    streams: Mutex<HashMap<String, CancellationToken>>,
    close_to_tray: AtomicBool,
    skip_exit_confirmation: AtomicBool,
    tray_english: AtomicBool,
    quitting: AtomicBool,
    tray_profile: Mutex<Option<String>>,
    tray_status: MenuItem<tauri::Wry>,
    tray_start: MenuItem<tauri::Wry>,
    tray_stop: MenuItem<tauri::Wry>,
    tray_show: MenuItem<tauri::Wry>,
    tray_quit: MenuItem<tauri::Wry>,
    tray_stop_quit: MenuItem<tauri::Wry>,
}

fn show_interface(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn quit_with_services(app: &tauri::AppHandle) {
    let state = app.state::<ClientState>();
    if state.quitting.swap(true, Ordering::AcqRel) {
        return;
    }
    let handle = app.clone();
    let ipc = state.ipc.clone();
    tauri::async_runtime::spawn(async move {
        match ipc
            .request("shutdown_supervisor", json!({"forClose":true}))
            .await
        {
            Ok(_) => {
                handle.state::<ClientState>().cleanup_ui();
                handle.exit(0);
            }
            Err(error) => {
                handle
                    .state::<ClientState>()
                    .quitting
                    .store(false, Ordering::Release);
                let _ = handle.emit("tray-action-error", error.to_string());
                show_interface(&handle);
            }
        }
    });
}

async fn refresh_tray(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<ClientState>();
    if state.quitting.load(Ordering::Acquire) {
        return Ok(());
    }
    let english = state.tray_english.load(Ordering::Relaxed);
    let profiles: Vec<ServiceProfile> = serde_json::from_value(
        state
            .ipc
            .request("local_installations", json!({}))
            .await
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let active = state
        .ipc
        .request("store_get", json!({"key":"activeLocalInstallation"}))
        .await
        .map_err(|error| error.to_string())?;
    let selected = profiles
        .iter()
        .find(|profile| Some(profile.id.as_str()) == active.as_str())
        .or_else(|| profiles.first());
    *state
        .tray_profile
        .lock()
        .map_err(|error| error.to_string())? = selected.map(|profile| profile.id.clone());
    let (message, can_start, can_stop) = match selected {
        Some(profile) => {
            let process = state
                .ipc
                .request(
                    "service_status",
                    json!({"profileId":profile.id,"profile":profile}),
                )
                .await
                .map_err(|error| error.to_string())?;
            let running = process["running"].as_bool() == Some(true);
            let owned = process["owned"].as_bool() == Some(true);
            let status = if running {
                let supervisor = state
                    .ipc
                    .request("supervisor_status", json!({}))
                    .await
                    .map_err(|error| error.to_string())?;
                let health = &supervisor["health"][&profile.id];
                if health["loaded"].as_bool() == Some(true) {
                    if english {
                        "Model ready"
                    } else {
                        "模型已就绪"
                    }
                } else if health["phase"].as_str() == Some("checking") {
                    if english {
                        "Preparing model"
                    } else {
                        "正在准备模型"
                    }
                } else {
                    if english {
                        "API running"
                    } else {
                        "API 运行中"
                    }
                }
            } else {
                if english {
                    "Stopped"
                } else {
                    "已停止"
                }
            };
            (
                format!("{status} · {}", profile.name),
                !running,
                running && owned,
            )
        }
        None => (
            (if english {
                "No model selected"
            } else {
                "尚未选择模型"
            })
            .to_string(),
            false,
            false,
        ),
    };
    state
        .tray_status
        .set_text(&message)
        .map_err(|error| error.to_string())?;
    state
        .tray_start
        .set_enabled(can_start)
        .map_err(|error| error.to_string())?;
    state
        .tray_stop
        .set_enabled(can_stop)
        .map_err(|error| error.to_string())?;
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some(format!("Strata Manager · {message}")));
    }
    Ok(())
}

fn tray_service_action(app: &tauri::AppHandle, start: bool) {
    let state = app.state::<ClientState>();
    let selected = state
        .tray_profile
        .lock()
        .ok()
        .and_then(|profile| profile.clone());
    let Some(profile_id) = selected else {
        show_interface(app);
        return;
    };
    let handle = app.clone();
    let ipc = state.ipc.clone();
    tauri::async_runtime::spawn(async move {
        let method = if start {
            "ensure_local_service"
        } else {
            "stop_service"
        };
        if let Err(error) = ipc.request(method, json!({"profileId":profile_id})).await {
            let _ = handle.emit("tray-action-error", error.to_string());
            show_interface(&handle);
        }
        let _ = refresh_tray(&handle).await;
    });
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
fn get_startup_status(state: State<'_, ClientState>) -> Result<Value, String> {
    startup::status(&state.ipc.data_dir)
}

#[tauri::command]
fn set_startup_enabled(state: State<'_, ClientState>, enabled: bool) -> Result<Value, String> {
    let executable = if enabled {
        state.ipc.staged_executable().map_err(|e| e.to_string())?
    } else {
        // Removing an owned entry must still work when its staged file is broken.
        std::path::PathBuf::new()
    };
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
    idle_unload_minutes: Option<u16>,
) -> Result<Value, String> {
    state
        .ipc
        .request(
            "set_background_policy",
            json!({"mode":mode,"autoRecover":auto_recover,"idleUnloadMinutes":idle_unload_minutes.unwrap_or(15)}),
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
        .map_err(|e| json!({"code":e.code,"message":e.message,"retriable":e.retriable}).to_string())
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
async fn tuning_live(state: State<'_, ClientState>, job_id: String) -> Result<Value, String> {
    state
        .ipc
        .request("tuning_live", json!({"jobId":job_id}))
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn calibrate_start(
    state: State<'_, ClientState>,
    profile_id: String,
    request: Value,
) -> Result<Value, String> {
    state
        .ipc
        .request(
            "calibrate_start",
            json!({"profileId":profile_id,"request":request}),
        )
        .await
        .map_err(|e| json!({"code":e.code,"message":e.message,"retriable":e.retriable}).to_string())
}
#[tauri::command]
async fn calibrate_status(
    state: State<'_, ClientState>,
    profile_id: String,
) -> Result<Value, String> {
    state
        .ipc
        .request("calibrate_status", json!({"profileId":profile_id}))
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn calibrate_cancel(state: State<'_, ClientState>, job_id: String) -> Result<Value, String> {
    state
        .ipc
        .request("calibrate_cancel", json!({"jobId":job_id}))
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
    runtime_update_queue::read_logs(&state.ipc, profile, limit).await
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
async fn setup_disk_preflight(
    state: State<'_, ClientState>,
    profile: ServiceProfile,
    model: String,
    quant: String,
    images: bool,
) -> Result<Value, String> {
    state
        .ipc
        .request(
            "setup_disk_preflight",
            json!({"profile":profile,"model":model,"quant":quant,"images":images}),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn orca_import_plan(
    state: State<'_, ClientState>,
    profile: ServiceProfile,
    request: Value,
) -> Result<Value, String> {
    state
        .ipc
        .request(
            "orca_import_plan",
            json!({"profile":profile,"request":request}),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_orca_import(
    state: State<'_, ClientState>,
    profile: ServiceProfile,
    request: Value,
    options: Option<Value>,
) -> Result<Value, String> {
    state
        .ipc
        .request(
            "run_orca_import",
            json!({"profile":profile,"request":request,"options":options}),
        )
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
    options: Option<Value>,
) -> Result<Value, String> {
    state.ipc.request("run_setup",json!({"profile":profile,"model":model,"quant":quant,"context":context,"images":images,"options":options})).await.map_err(|e|e.to_string())
}

#[tauri::command]
async fn inspect_gguf(state: State<'_, ClientState>, request: Value) -> Result<Value, String> {
    state
        .ipc
        .request("inspect_gguf", json!({"request":request}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn manager_mcp_connection(
    state: State<'_, ClientState>,
    profile_id: String,
) -> Result<Value, String> {
    state
        .ipc
        .request("manager_mcp_connection", json!({"profileId":profile_id}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn probe_official_mcp(
    state: State<'_, ClientState>,
    profile_id: String,
) -> Result<Value, String> {
    state
        .ipc
        .request("probe_official_mcp", json!({"profileId":profile_id}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn external_management_status(
    state: State<'_, ClientState>,
    profile_id: String,
) -> Result<Value, String> {
    state
        .ipc
        .request(
            "external_management_status",
            json!({"profileId":profile_id}),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn chat_runtime_evidence(
    state: State<'_, ClientState>,
    profile_id: String,
) -> Result<Value, String> {
    state
        .ipc
        .request("chat_runtime_evidence", json!({"profileId":profile_id}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_external_management(
    state: State<'_, ClientState>,
    profile_id: String,
    external: bool,
) -> Result<Value, String> {
    state
        .ipc
        .request(
            "set_external_management",
            json!({"profileId":profile_id,"external":external}),
        )
        .await
        .map_err(|e| e.to_string())
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
async fn engine_help_flags(
    state: State<'_, ClientState>,
    profile: ServiceProfile,
) -> Result<Value, String> {
    state
        .ipc
        .request("engine_help_flags", json!({"profile":profile}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_runtime_zip(
    state: State<'_, ClientState>,
    install_dir: String,
    asset_name: Option<String>,
    stop_current_service: Option<bool>,
    local_archive_path: Option<String>,
    download_url: Option<String>,
) -> Result<Value, String> {
    runtime_update_queue::start(
        &state.ipc,
        install_dir,
        asset_name,
        stop_current_service.unwrap_or(false),
        strata_runtime_core::runtime_upgrade::RuntimeZipDownloadOptions {
            local_archive_path,
            download_url,
        },
    )
    .await
}

#[tauri::command]
async fn runtime_update_info(
    state: State<'_, ClientState>,
    force: Option<bool>,
) -> Result<Value, String> {
    runtime_updates::update_info(&state.ipc, force.unwrap_or(false)).await
}

#[tauri::command]
async fn test_runtime_zip_download(
    state: State<'_, ClientState>,
    asset_name: String,
    local_archive_path: Option<String>,
    download_url: Option<String>,
) -> Result<Value, String> {
    // A read-only probe must not call ensure_connected, which can initiate a
    // supervisor package handoff. An older background service reports clearly.
    match strata_local_ipc::call(
        &state.ipc.data_dir,
        "test_runtime_zip_download_v1",
        json!({"assetName":asset_name, "localArchivePath":local_archive_path, "downloadUrl":download_url}),
    ).await {
        Ok(result) => Ok(result),
        Err(error) if error.code == "unknown_method" =>
            Err("当前管理器后台版本不支持下载来源测试，请更新管理器后台后重试".into()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
async fn resolve_runtime_zip_asset(
    state: State<'_, ClientState>,
    install_dir: String,
    asset_name: Option<String>,
) -> Result<Value, String> {
    match strata_local_ipc::call(
        &state.ipc.data_dir,
        "resolve_runtime_zip_asset_v1",
        json!({"installDir":install_dir, "assetName":asset_name}),
    )
    .await
    {
        Ok(result) => Ok(result),
        Err(error) if error.code == "unknown_method" => {
            Err("当前后台不支持自动匹配更新包，请更新管理器后台或手动选择包".into())
        }
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
async fn list_tasks(state: State<'_, ClientState>) -> Result<Value, String> {
    runtime_update_queue::list_tasks(&state.ipc).await
}

#[tauri::command]
async fn list_setup_handoffs(state: State<'_, ClientState>) -> Result<Value, String> {
    state
        .ipc
        .request("list_setup_handoffs", json!({}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn resolve_setup_handoff(
    state: State<'_, ClientState>,
    task_id: String,
    config_path: Option<String>,
) -> Result<Value, String> {
    state
        .ipc
        .request(
            "resolve_setup_handoff",
            json!({"taskId":task_id,"configPath":config_path}),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cancel_task(state: State<'_, ClientState>, task_id: String) -> Result<Value, String> {
    runtime_update_queue::cancel_task(&state.ipc, task_id).await
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
async fn read_config_snapshot(
    state: State<'_, ClientState>,
    profile: ServiceProfile,
) -> Result<Value, String> {
    state
        .ipc
        .request("read_config_snapshot_v1", json!({"profile":profile}))
        .await
        .map_err(|e| json!({"code":e.code,"message":e.message,"retriable":e.retriable}).to_string())
}

#[tauri::command]
fn validate_vision_files(profile: ServiceProfile, config: Value) -> Result<(), String> {
    vision_files::check(&profile, &config)
}

#[tauri::command]
async fn copy_configuration(
    state: State<'_, ClientState>,
    profile: ServiceProfile,
    filename: String,
    config: Value,
) -> Result<ServiceProfile, String> {
    let _guard = configuration_files::OPERATIONS.lock().await;
    let _management = management_file_lock(&state.ipc)?;
    state
        .ipc
        .request("assert_profile_management", json!({"profile":profile}))
        .await
        .map_err(|e| e.to_string())?;
    let registered: Vec<ServiceProfile> = serde_json::from_value(
        state
            .ipc
            .request("local_installations", json!({}))
            .await
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    // A copy of a registered configuration joins the configuration list right away.
    // A discovered, unregistered source stays a file; using it imports it as before.
    let source_registered = registered.iter().any(|item| {
        item.id == profile.id
            && configuration_files::path_key(std::path::Path::new(&item.config_path))
                == configuration_files::path_key(std::path::Path::new(&profile.config_path))
    });
    let source_id = profile.id.clone();
    let copied =
        tokio::task::spawn_blocking(move || configuration_files::copy(&profile, &filename, config))
            .await
            .map_err(|error| error.to_string())??;
    if !source_registered {
        return Ok(copied);
    }
    match state
        .ipc
        .request(
            "register_configuration_copy",
            json!({"sourceProfileId":source_id,"profile":copied}),
        )
        .await
    {
        // A supervisor predating copy registration keeps the earlier file-only behavior.
        Err(error) if error.code == "unknown_method" => Ok(copied),
        Ok(value) => serde_json::from_value(value).map_err(|error| error.to_string()),
        Err(error) => {
            let error = error.to_string();
            // The file was created by this call and is not registered; never leave half a copy.
            let path = std::path::PathBuf::from(&copied.config_path);
            let cleanup = tokio::task::spawn_blocking(move || std::fs::remove_file(path)).await;
            Err(match cleanup {
                Ok(Ok(())) => format!("新配置登记失败，未保留副本 / Could not register the new configuration; the copy was removed: {error}"),
                _ => format!("新配置登记失败，副本保留在 / Could not register the new configuration; the copy remains at {}: {error}", copied.config_path),
            })
        }
    }
}

// Keep external-management handoff out of the gap between IPC validation and
// local filesystem writes, including operations from another desktop process.
fn management_file_lock(
    ipc: &SupervisorClient,
) -> Result<strata_local_ipc::SingleInstance, String> {
    strata_local_ipc::SingleInstance::acquire_scoped(&ipc.data_dir, "managed-file-operation")
        .map_err(|_| "管理交接或文件操作正在进行，请完成后重试 / Management handoff or file operation is in progress; try again when it finishes".into())
}

async fn assert_configuration_stopped(
    ipc: &SupervisorClient,
    profiles: &[ServiceProfile],
) -> Result<(), String> {
    for profile in profiles {
        ipc.request("assert_profile_management", json!({"profile":profile}))
            .await
            .map_err(|e| e.to_string())?;
        let status = ipc
            .request(
                "service_status",
                json!({"profileId":profile.id,"profile":profile}),
            )
            .await
            .map_err(|error| error.to_string())?;
        model_files::assert_stopped_status(&status)?;
    }
    Ok(())
}

#[tauri::command]
async fn delete_configuration(
    state: State<'_, ClientState>,
    profile: ServiceProfile,
) -> Result<Value, String> {
    let _guard = configuration_files::OPERATIONS.lock().await;
    let _management = management_file_lock(&state.ipc)?;
    let path = configuration_files::configuration_path(&profile)?;
    let key = configuration_files::path_key(&path);
    let registered: Vec<ServiceProfile> = serde_json::from_value(
        state
            .ipc
            .request("local_installations", json!({}))
            .await
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if registered.iter().any(|item| {
        item.id == profile.id
            && configuration_files::path_key(std::path::Path::new(&item.config_path)) != key
    }) {
        return Err("登记配置路径已变化，请刷新后重试 / Registered configuration path changed; refresh and try again".into());
    }
    let matching: Vec<ServiceProfile> = registered
        .into_iter()
        .filter(|item| {
            configuration_files::path_key(std::path::Path::new(&item.config_path)) == key
        })
        .collect();
    if matching.len() > 1 {
        return Err("多个登记共用此配置文件，无法原子移除，请先整理重复登记 / Multiple registrations share this configuration; consolidate them before deleting".into());
    }
    let mut inspected = matching.clone();
    if !inspected.iter().any(|item| item.id == profile.id) {
        inspected.push(profile.clone());
    }
    assert_configuration_stopped(&state.ipc, &inspected).await?;
    let archived = configuration_files::archive(&profile, &state.ipc.data_dir)?;
    let removal = async {
        // Recheck after the file operation so a concurrent start cannot authorize deletion.
        assert_configuration_stopped(&state.ipc, &inspected).await?;
        for selected in &matching {
            state
                .ipc
                .request(
                    "remove_local_installation",
                    json!({"profileId":selected.id}),
                )
                .await
                .map_err(|error| error.to_string())?;
        }
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = removal {
        return match archived.rollback() {
            Ok(()) => Err(format!("删除未完成，配置文件已恢复 / Deletion incomplete; configuration file restored: {error}")),
            Err(rollback) => Err(format!("删除未完成 / Deletion incomplete: {error}; {rollback}")),
        };
    }
    Ok(json!({"archivedPath":archived.archived.to_string_lossy()}))
}

/// Read-only: which older-version run configurations could be archived.
#[tauri::command]
async fn plan_config_cleanup(
    state: State<'_, ClientState>,
    directories: Option<Vec<String>>,
    current_install_dir: String,
) -> Result<config_cleanup::CleanupPlan, String> {
    let current = std::path::PathBuf::from(&current_install_dir);
    if !current.is_absolute() {
        return Err(
            "当前运行环境必须是本机绝对路径 / The current runtime must be an absolute local path"
                .into(),
        );
    }
    let candidates = runtime_detection::local_models(&state.ipc, directories).await?;
    let candidates = candidates
        .as_array()
        .ok_or("模型检测结果格式无效 / Invalid model discovery result")?;
    let registered: Vec<ServiceProfile> = serde_json::from_value(
        state
            .ipc
            .request("local_installations", json!({}))
            .await
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let protected: Vec<std::path::PathBuf> = registered
        .iter()
        .filter_map(|profile| configuration_details::source_path(profile, &state.ipc.data_dir))
        .map(std::path::PathBuf::from)
        .collect();
    config_cleanup::plan(config_cleanup::CleanupInput {
        candidates,
        registered: &registered,
        protected_paths: &protected,
        current_install_dir: &current,
    })
}

async fn model_deletion_context(
    ipc: &SupervisorClient,
    profiles: Vec<ServiceProfile>,
) -> Result<
    (
        Vec<model_files::Configuration>,
        Vec<model_files::Configuration>,
    ),
    String,
> {
    if profiles.is_empty() || profiles.len() > 256 {
        return Err("请选择一组模型配置 / Select one model configuration group".into());
    }
    let registered: Vec<ServiceProfile> = serde_json::from_value(
        ipc.request("local_installations", json!({}))
            .await
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let mut selected = Vec::new();
    for incoming in profiles {
        let profile = if let Some(saved) = registered.iter().find(|item| item.id == incoming.id) {
            if configuration_files::path_key(std::path::Path::new(&saved.config_path))
                != configuration_files::path_key(std::path::Path::new(&incoming.config_path))
            {
                return Err("登记配置路径已变化，请刷新模型列表 / Registered configuration path changed; refresh the model list".into());
            }
            saved.clone()
        } else {
            incoming
        };
        configuration_files::configuration_path(&profile)?;
        let config = ipc
            .request("read_config", json!({"profile":profile}))
            .await
            .map_err(|error| error.to_string())?;
        selected.push(model_files::Configuration { profile, config });
    }
    let mut all = Vec::new();
    for profile in registered {
        configuration_files::configuration_path(&profile).map_err(|error| format!("无法核验登记配置引用，请先修复或移除该配置 / Cannot verify registered configuration references; repair or remove it first: {}: {error}", profile.name))?;
        let config = ipc
            .request("read_config", json!({"profile":profile}))
            .await
            .map_err(|error| error.to_string())?;
        all.push(model_files::Configuration { profile, config });
    }
    Ok((selected, all))
}

#[tauri::command]
async fn plan_model_deletion(
    state: State<'_, ClientState>,
    profiles: Vec<ServiceProfile>,
) -> Result<model_files::ModelDeletionPlan, String> {
    let context = model_deletion_context(&state.ipc, profiles).await;
    let prepared = match context
        .and_then(|(selected, registered)| model_files::prepare(&selected, &registered))
    {
        Ok(prepared) => prepared,
        Err(reason) => return Ok(model_files::ModelDeletionPlan::blocked(reason)),
    };
    let mut plan = prepared.plan;
    if let Err(reason) = assert_configuration_stopped(&state.ipc, &prepared.profiles).await {
        plan.blocked_reason = Some(reason);
    }
    Ok(plan)
}

#[tauri::command]
async fn delete_model_files(
    state: State<'_, ClientState>,
    profiles: Vec<ServiceProfile>,
    expected_files: Vec<model_files::ModelDeletionFile>,
) -> Result<model_files::ModelDeletionSummary, String> {
    let _guard = configuration_files::OPERATIONS.lock().await;
    let _management = management_file_lock(&state.ipc)?;
    let (selected, registered) = model_deletion_context(&state.ipc, profiles.clone()).await?;
    let inspected = model_files::prepare(&selected, &registered)?;
    model_files::verify_expected(&inspected.plan.files, &expected_files)?;
    assert_configuration_stopped(&state.ipc, &inspected.profiles).await?;
    // Re-read the configuration references after the process checks as well.
    let (selected, registered) = model_deletion_context(&state.ipc, profiles).await?;
    let current = model_files::prepare(&selected, &registered)?;
    model_files::verify_expected(&current.plan.files, &expected_files)?;
    assert_configuration_stopped(&state.ipc, &current.profiles).await?;
    model_files::remove(&current.plan, &expected_files)
}

#[tauri::command]
async fn write_config(
    state: State<'_, ClientState>,
    profile: ServiceProfile,
    config: Value,
    expected_revision: String,
) -> Result<Value, String> {
    let _guard = configuration_files::OPERATIONS.lock().await;
    state
        .ipc
        .request(
            "write_config_cas_v1",
            json!({"profile":profile,"config":config,"expectedRevision":expected_revision}),
        )
        .await
        .map_err(|e| json!({"code":e.code,"message":e.message,"retriable":e.retriable}).to_string())
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
async fn write_png_export(path: String, bytes: Vec<u8>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        png_export::save(std::path::Path::new(&path), &bytes)
    })
    .await
    .map_err(|error| format!("PNG 保存任务失败 / PNG save task failed: {error}"))?
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
    let mut candidates = runtime_detection::local_models(&state.ipc, directories).await?;
    let records = candidates
        .as_array_mut()
        .ok_or("模型检测结果格式无效 / Invalid model discovery result")?;
    for candidate in records {
        let needs_config = candidate.get("config").is_none_or(Value::is_null);
        let needs_modified = candidate.get("configModifiedAt").is_none_or(Value::is_null);
        if !needs_config && !needs_modified {
            continue;
        }
        let Some(config_path) = candidate["configPath"].as_str().map(str::to_owned) else {
            continue;
        };
        let Some(install_dir) = candidate["installDir"].as_str().map(str::to_owned) else {
            continue;
        };
        let port = candidate["detectedPort"]
            .as_u64()
            .filter(|port| (1..=65535).contains(port))
            .unwrap_or(18081);
        let profile = ServiceProfile {
            // A discovery identifier may also name an imported managed copy.
            // Use a read-only identity so read_config reads this actual JSON path.
            id: format!("discovery-read-{}", uuid::Uuid::new_v4()),
            name: candidate["name"].as_str().unwrap_or_default().to_owned(),
            base_url: format!("http://127.0.0.1:{port}"),
            install_dir,
            python_path: candidate["pythonPath"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            config_path,
            managed: false,
        };
        let Ok(path) = configuration_files::configuration_path(&profile) else {
            continue;
        };
        if needs_modified {
            if let Some(modified) = std::fs::metadata(&path)
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .and_then(|time| u64::try_from(time.as_millis()).ok())
            {
                candidate["configModifiedAt"] = json!(modified);
            }
        }
        if needs_config {
            if let Ok(mut config) = state
                .ipc
                .request("read_config", json!({"profile":profile}))
                .await
            {
                // Match discovery's display-only credential redaction.
                fn redact(value: &mut Value) {
                    match value {
                        Value::Object(object) => {
                            for (key, value) in object {
                                let key = key.to_ascii_lowercase();
                                if matches!(
                                    key.as_str(),
                                    "api_key"
                                        | "apikey"
                                        | "token"
                                        | "password"
                                        | "secret"
                                        | "authorization"
                                        | "credential"
                                        | "credentials"
                                ) || key.ends_with("_key")
                                    || key.ends_with("_token")
                                    || key.ends_with("_secret")
                                    || key.contains("password")
                                    || key.contains("secret")
                                {
                                    *value = Value::String("[已隐藏]".into());
                                } else {
                                    redact(value);
                                }
                            }
                        }
                        Value::Array(values) => {
                            for value in values {
                                redact(value);
                            }
                        }
                        _ => {}
                    }
                }
                if config.is_object() {
                    redact(&mut config);
                    candidate["config"] = config;
                }
            }
        }
    }
    Ok(candidates)
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
async fn local_installation_details(state: State<'_, ClientState>) -> Result<Value, String> {
    let mut details = match state
        .ipc
        .request("local_installation_details", json!({}))
        .await
    {
        Ok(details) => details,
        Err(error)
            if error.code == "unknown_method" || error.message.contains("unknown_method") =>
        {
            configuration_details::legacy_details(&state.ipc).await?
        }
        Err(error) => return Err(error.to_string()),
    };
    let activated = state
        .ipc
        .request(
            "store_get",
            json!({"key":"localConfigurationLastActivatedAt"}),
        )
        .await
        .map_err(|error| error.to_string())?;
    for detail in details
        .as_array_mut()
        .ok_or("配置详情格式无效 / Invalid configuration details")?
    {
        let timestamp = detail["profileId"]
            .as_str()
            .and_then(|id| activated.get(id))
            .and_then(Value::as_u64);
        detail["lastActivatedAt"] = json!(timestamp);
    }
    Ok(details)
}

#[tauri::command]
async fn confirm_window_close(
    app: tauri::AppHandle,
    state: State<'_, ClientState>,
) -> Result<(), String> {
    if state.quitting.swap(true, Ordering::AcqRel) {
        return Err("正在停止服务，请稍候".into());
    }
    match state
        .ipc
        .request("shutdown_supervisor", json!({"forClose":true}))
        .await
    {
        Ok(_) => {
            state.cleanup_ui();
            app.exit(0);
            Ok(())
        }
        Err(error) => {
            state.quitting.store(false, Ordering::Release);
            Err(error.to_string())
        }
    }
}

#[tauri::command]
async fn apply_settings(
    app: tauri::AppHandle,
    state: State<'_, ClientState>,
    settings: Value,
) -> Result<(), String> {
    let close = settings
        .get("closeToTray")
        .and_then(Value::as_bool)
        .ok_or("closeToTray 必须是布尔值")?;
    state.close_to_tray.store(close, Ordering::Relaxed);
    state.skip_exit_confirmation.store(
        settings
            .get("skipExitConfirmation")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        Ordering::Relaxed,
    );
    let english =
        system_locale::uses_english_fallback(settings.get("language").and_then(Value::as_str));
    monitor_tray::apply(&app, &settings)?;
    taskbar_monitor::apply_preferences(&app, &settings)?;
    floating_monitor::apply_preferences(&app, &settings).await?;
    state.tray_english.store(english, Ordering::Relaxed);
    state
        .tray_start
        .set_text(if english {
            "Start model service"
        } else {
            "启动模型服务"
        })
        .map_err(|error| error.to_string())?;
    state
        .tray_stop
        .set_text(if english {
            "Stop model service"
        } else {
            "停止模型服务"
        })
        .map_err(|error| error.to_string())?;
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
    if let Some(monitor) = app.get_webview_window(floating_monitor::LABEL) {
        if let Err(error) = monitor.emit("monitor-preferences-changed", &settings) {
            // A concurrent strip close must not turn successfully applied
            // settings into a failed save in the main window.
            eprintln!("Monitor preference notification could not be delivered: {error}");
        }
    }
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
#[tauri::command]
async fn request_capture_status(
    state: State<'_, ClientState>,
    profile_id: String,
) -> Result<Value, String> {
    state
        .ipc
        .request("request_capture_status", json!({"profileId":profile_id}))
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn request_capture_set(
    state: State<'_, ClientState>,
    profile_id: String,
    minutes: u16,
) -> Result<Value, String> {
    state
        .ipc
        .request(
            "request_capture_set",
            json!({"profileId":profile_id,"minutes":minutes}),
        )
        .await
        .map_err(|e| e.to_string())
}
pub fn run() {
    if taskbar_monitor::maybe_run_host() {
        return;
    }
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
            let _ = window_layout::fit_initial_window(app);
            let data_dir = supervisor_client::data_directory(&app.path().app_data_dir()?);
            if !data_dir.is_absolute() {
                return Err("后台数据目录必须是绝对路径".into());
            }
            std::fs::create_dir_all(&data_dir)?;
            let data_dir = tauri::async_runtime::block_on(
                running_service_connection::active_data_directory(&data_dir),
            );
            arena::start_background(data_dir.clone());
            let ipc = Arc::new(SupervisorClient::new(data_dir, app.path().resource_dir()?));
            let saved_settings =
                tauri::async_runtime::block_on(ipc.request("store_get", json!({"key":"settings"})))
                    .unwrap_or(Value::Null);
            let english = system_locale::uses_english_fallback(
                saved_settings.get("language").and_then(Value::as_str),
            );
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
            let service_state = MenuItem::with_id(
                app,
                "service-state",
                if english {
                    "Reading service status…"
                } else {
                    "正在读取服务状态…"
                },
                false,
                None::<&str>,
            )?;
            let start = MenuItem::with_id(
                app,
                "service-start",
                if english {
                    "Start model service"
                } else {
                    "启动模型服务"
                },
                false,
                None::<&str>,
            )?;
            let stop = MenuItem::with_id(
                app,
                "service-stop",
                if english {
                    "Stop model service"
                } else {
                    "停止模型服务"
                },
                false,
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
                skip_exit_confirmation: AtomicBool::new(
                    saved_settings
                        .get("skipExitConfirmation")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                ),
                tray_english: AtomicBool::new(english),
                quitting: AtomicBool::new(false),
                tray_profile: Mutex::new(None),
                tray_status: service_state.clone(),
                tray_start: start.clone(),
                tray_stop: stop.clone(),
                tray_show: show.clone(),
                tray_quit: quit.clone(),
                tray_stop_quit: stop_quit.clone(),
            });
            app.manage(monitor_tray::MonitorTrayState::default());
            app.manage(taskbar_monitor::TaskbarMonitorState::default());
            monitor_tray::apply(app.handle(), &saved_settings)?;
            let menu = Menu::with_items(
                app,
                &[&service_state, &show, &start, &stop, &quit, &stop_quit],
            )?;
            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().ok_or("应用图标缺失")?.clone())
                .tooltip("Strata Manager")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show_interface(tray.app_handle());
                    }
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Right,
                            ..
                        }
                    ) {
                        let handle = tray.app_handle().clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = refresh_tray(&handle).await;
                        });
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        show_interface(app);
                    }
                    "service-start" => tray_service_action(app, true),
                    "service-stop" => tray_service_action(app, false),
                    "quit" => {
                        app.state::<ClientState>().cleanup_ui();
                        app.exit(0);
                    }
                    "stop-quit" => {
                        quit_with_services(app);
                    }
                    _ => {}
                })
                .build(app)?;
            let handle = app.handle().clone();
            let update_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let ipc = update_handle.state::<ClientState>().ipc.clone();
                    if let Err(error) = runtime_update_queue::tick(&ipc).await {
                        eprintln!("ZIP update reconciliation: {error}");
                    }
                    tokio::time::sleep(Duration::from_secs(10)).await;
                }
            });
            tauri::async_runtime::spawn(async move {
                loop {
                    let _ = refresh_tray(&handle).await;
                    tokio::time::sleep(Duration::from_secs(3)).await;
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == floating_monitor::LABEL
                && matches!(event, tauri::WindowEvent::Destroyed)
            {
                taskbar_monitor::notify_visibility(window.app_handle());
            }
            if window.label() != "main" {
                // Closing the optional monitor must never hide it to the tray
                // or enter the main window's service-exit confirmation flow.
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<ClientState>();
                if state.close_to_tray.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    api.prevent_close();
                    // Even when the service-exit prompt is skipped, the renderer
                    // must first protect unsaved configuration drafts.
                    let _ = window.emit("window-exit-requested", ());
                    let _ = window.set_focus();
                }
            }
        })
        .invoke_handler(invoke_policy::with_window_policy(tauri::generate_handler![
            arena::arena_status,
            arena::arena_consent,
            arena::arena_set_auto_upload,
            arena::arena_enqueue,
            arena::arena_flush,
            arena::arena_withdraw,
            arena::arena_get,
            floating_monitor::open_monitor_window,
            floating_monitor::resize_monitor_window,
            taskbar_monitor::set_monitor_mode,
            taskbar_monitor::set_monitor_visibility,
            taskbar_monitor::monitor_mode_status,
            monitor_tray::minimize_monitor_to_tray,
            floating_monitor::monitor_snapshot,
            floating_monitor::show_main_from_monitor,
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
            tuning_live,
            calibrate_start,
            calibrate_status,
            calibrate_cancel,
            switch_local_service,
            prepare_local_runtime,
            local_runtime_installation,
            connect_running_service,
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
            daily_experience::assess_setup_resources,
            daily_experience::benchmark_identity,
            service_sharing::service_sharing_status,
            service_sharing::set_service_auth,
            setup_disk_preflight,
            orca_import_plan,
            run_orca_import,
            run_setup,
            inspect_gguf,
            manager_mcp_connection,
            probe_official_mcp,
            external_management_status,
            chat_runtime_evidence,
            set_external_management,
            install_runtime,
            update_runtime,
            engine_help_flags,
            update_runtime_zip,
            runtime_update_info,
            test_runtime_zip_download,
            resolve_runtime_zip_asset,
            list_tasks,
            list_setup_handoffs,
            resolve_setup_handoff,
            cancel_task,
            read_config,
            read_config_snapshot,
            validate_vision_files,
            copy_configuration,
            delete_configuration,
            plan_config_cleanup,
            plan_model_deletion,
            delete_model_files,
            write_config,
            write_markdown_export,
            write_png_export,
            list_local_models,
            export_diagnostics,
            discover_local,
            import_local,
            ensure_local_service,
            supervisor_status,
            shutdown_supervisor,
            local_installations,
            local_installation_details,
            local_installation_migration,
            http::strata_stream,
            http::cancel_stream,
            apply_settings,
            system_locale::get_system_language,
            confirm_window_close,
            rename_local_installation,
            analytics_query,
            request_capture_status,
            request_capture_set,
            remove_local_installation
        ]))
        .build(tauri::generate_context!())
        .expect("Strata Manager initialization failed");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            taskbar_monitor::shutdown(handle);
            handle.state::<ClientState>().cleanup_ui();
        }
    });
}
