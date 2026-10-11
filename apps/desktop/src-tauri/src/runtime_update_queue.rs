//! A confirmed ZIP update can bridge a legacy supervisor without losing the
//! selected service. The durable journal is metadata in that supervisor's store;
//! this module never opens a second production RuntimeState.
use crate::supervisor_client::{RegistrySnapshot, SupervisorClient};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use strata_local_ipc::SingleInstance;
use strata_runtime_core::runtime_upgrade::RuntimeZipDownloadOptions;
use strata_runtime_core::types::{now, LogEntry, ServiceProfile, TaskStatus};

const KEY: &str = "nativeRuntimeZipUpdates";
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Restart {
    profile: ServiceProfile,
    loaded: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    task: TaskStatus,
    install_dir: String,
    asset_name: Option<String>,
    #[serde(default)]
    download: RuntimeZipDownloadOptions,
    stop_confirmed: bool,
    phase: String,
    backend_task_id: Option<String>,
    restarts: Vec<Restart>,
    previous_active: Value,
    previous_gui_active: Value,
    previous_desired: Value,
    terminal: Option<TaskStatus>,
    logs: Vec<LogEntry>,
    #[serde(default)]
    registry: Option<RegistrySnapshot>,
}

/// Carry an interrupted confirmed update's original registration across a
/// supervisor package handoff before any default startup recovery is enabled.
pub(crate) fn merge_recovery_snapshot(
    data_dir: &Path,
    snapshot: &mut RegistrySnapshot,
    queue: Value,
) -> Result<(), strata_local_ipc::RpcError> {
    if queue.is_null() {
        return Ok(());
    }
    let values: Vec<Record> = serde_json::from_value(queue).map_err(|error| {
        strata_local_ipc::RpcError::new("supervisor_registry", format!("ZIP 恢复记录无效：{error}"))
    })?;
    let mut selection: Option<(Value, Value)> = None;
    for record in values.into_iter().filter(|record| {
        record.task.state == "running"
            || (record.task.state == "failed"
                && record.terminal.is_some()
                && record.task.message.contains("服务恢复未完成"))
    }) {
        let profiles = record
            .registry
            .as_ref()
            .map(|registry| registry.profiles.clone())
            .unwrap_or_else(|| {
                record
                    .restarts
                    .iter()
                    .map(|restart| restart.profile.clone())
                    .collect()
            });
        for profile in profiles {
            if let Some(current) = snapshot
                .profiles
                .iter()
                .find(|current| current.id == profile.id)
            {
                if serde_json::to_value(current).ok() != serde_json::to_value(&profile).ok() {
                    return Err(strata_local_ipc::RpcError::new(
                        "supervisor_registry",
                        format!("原更新配置 {} 与现有登记冲突；恢复记录保留", profile.id),
                    ));
                }
            } else {
                snapshot.profiles.push(profile.clone());
            }
            let original = record
                .registry
                .as_ref()
                .and_then(|registry| {
                    registry
                        .originals
                        .iter()
                        .find(|original| original.id == profile.id)
                })
                .cloned()
                .or_else(|| {
                    crate::supervisor_client::original_profile(&profile, &Value::Null, data_dir)
                });
            if let Some(original) = original {
                if let Some(current) = snapshot
                    .originals
                    .iter()
                    .find(|current| current.id == original.id)
                {
                    if serde_json::to_value(current).ok() != serde_json::to_value(&original).ok() {
                        return Err(strata_local_ipc::RpcError::new(
                            "supervisor_registry",
                            "原配置来源登记发生冲突；未启动模型",
                        ));
                    }
                } else {
                    snapshot.originals.push(original);
                }
            }
        }
        let previous = (record.previous_active, record.previous_gui_active);
        if selection
            .as_ref()
            .is_some_and(|selection| selection != &previous)
        {
            return Err(strata_local_ipc::RpcError::new(
                "supervisor_registry",
                "多个未完成更新的原选中配置不一致；未启动模型",
            ));
        }
        selection = Some(previous);
    }
    if let Some((active, gui_active)) = selection {
        snapshot.active_local_installation = active;
        snapshot.active_profile = gui_active;
        // The queue must first reconcile the ZIP task, then explicitly restore
        // the recorded model. Default startup must not race that workflow.
        snapshot.local_service_desired = json!(false);
    }
    Ok(())
}

type Probe = fn(&Path, &[ServiceProfile]) -> Result<bool, String>;

fn inventory_changed(error: &str) -> bool {
    error.contains("Python 进程清单发生变化") || error.contains("Python进程清单发生变化")
}
async fn observe(probe: Probe, runtime: &Path, allowed: &[ServiceProfile]) -> Result<bool, String> {
    for attempt in 0..5 {
        match probe(runtime, allowed) {
            Err(error) if inventory_changed(&error) && attempt < 4 => {
                tokio::time::sleep(Duration::from_millis(200)).await
            }
            result => return result,
        }
    }
    unreachable!()
}
async fn wait_stopped(ipc: &SupervisorClient, runtime: &Path, probe: Probe) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let mut stable = 0;
    loop {
        let no_owned = raw(ipc, "hello", json!({})).await?["activeServices"].as_u64() == Some(0);
        match observe(probe, runtime, &[]).await {
            Ok(true) if no_owned => {
                stable += 1;
                if stable >= 2 {
                    return Ok(());
                }
            }
            Ok(_) => stable = 0,
            Err(error) if inventory_changed(&error) => stable = 0,
            Err(error) => return Err(error),
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(
                "已确认服务尚未完整退出或进程清单仍不稳定，保留原配置恢复记录；未安装 ZIP".into(),
            );
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn raw(ipc: &SupervisorClient, method: &str, params: Value) -> Result<Value, String> {
    strata_local_ipc::call(&ipc.data_dir, method, params)
        .await
        .map_err(|error| error.to_string())
}
async fn get(ipc: &SupervisorClient, key: &str) -> Result<Value, String> {
    raw(ipc, "store_get", json!({"key": key})).await
}
async fn set(ipc: &SupervisorClient, key: &str, value: Value) -> Result<(), String> {
    raw(ipc, "store_set", json!({"key": key, "value": value}))
        .await
        .map(|_| ())
}
async fn records(ipc: &SupervisorClient) -> Result<Vec<Record>, String> {
    let value = get(ipc, KEY).await?;
    if value.is_null() {
        return Ok(vec![]);
    }
    serde_json::from_value(value).map_err(|error| format!("ZIP 更新恢复记录无效：{error}"))
}
async fn save(ipc: &SupervisorClient, values: &[Record]) -> Result<(), String> {
    set(
        ipc,
        KEY,
        serde_json::to_value(values).map_err(|error| error.to_string())?,
    )
    .await
}
fn message(record: &mut Record, text: impl Into<String>) {
    let text = text.into();
    if record.task.message != text {
        record.logs.push(LogEntry {
            timestamp: now(),
            level: "info".into(),
            message: text.clone(),
        });
        if record.logs.len() > 200 {
            record.logs.remove(0);
        }
    }
    record.task.message = text;
}
async fn guard(ipc: &SupervisorClient) -> Result<SingleInstance, String> {
    for _ in 0..500 {
        match SingleInstance::acquire_scoped(&ipc.data_dir, "runtime-update-queue") {
            Ok(lock) => return Ok(lock),
            Err(error) if error.code == "already_running" => {
                tokio::time::sleep(Duration::from_millis(20)).await
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("另一窗口正在处理 ZIP 更新，请稍后查看任务状态".into())
}
fn root(path: &str) -> Result<PathBuf, String> {
    let path = dunce::canonicalize(path).map_err(|_| "Strata 安装目录不存在")?;
    if !path.join("setup.py").is_file() || !path.join("serve/server.py").is_file() {
        return Err("请选择已经检测到的 Strata 安装目录".into());
    }
    Ok(path)
}
fn same_runtime(profile: &ServiceProfile, root: &Path) -> bool {
    dunce::canonicalize(&profile.install_dir).is_ok_and(|path| path == root)
}
fn approved_processes(root: &Path, allowed: &[ServiceProfile]) -> Result<bool, String> {
    if !strata_runtime_core::discovery::has_running_installation(root)? {
        return Ok(true);
    }
    if allowed.is_empty() {
        return Ok(false);
    }
    let candidates = strata_runtime_core::discovery::discover_local(&[root.to_owned()], allowed)?;
    let relevant: Vec<_> = candidates
        .iter()
        .filter(|candidate| {
            dunce::canonicalize(&candidate.install_dir).is_ok_and(|path| path == root)
        })
        .collect();
    if relevant.iter().any(|candidate| {
        candidate
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("身份核验未通过"))
    }) {
        return Ok(false);
    }
    let running: Vec<_> = relevant
        .iter()
        .filter(|candidate| candidate.running == Some(true))
        .collect();
    Ok(!running.is_empty()
        && running.iter().all(|candidate| {
            allowed.iter().any(|profile| {
                match (
                    dunce::canonicalize(&profile.config_path),
                    dunce::canonicalize(&candidate.config_path),
                ) {
                    (Ok(first), Ok(second)) => first == second,
                    _ => false,
                }
            })
        }))
}

async fn inventory(
    ipc: &SupervisorClient,
    runtime: &Path,
) -> Result<(u64, Vec<ServiceProfile>), String> {
    let hello = raw(ipc, "hello", json!({})).await?;
    let active = hello["activeServices"]
        .as_u64()
        .ok_or("无法核实后台运行服务数量，未停止任何服务")?;
    let profiles: Vec<ServiceProfile> =
        serde_json::from_value(raw(ipc, "local_installations", json!({})).await?)
            .map_err(|error| error.to_string())?;
    let mut owned = Vec::new();
    for profile in profiles {
        let status = raw(ipc, "service_status", json!({"profileId": profile.id})).await?;
        match (status["running"].as_bool(), status["owned"].as_bool()) {
            (Some(true), Some(true)) => {
                if !same_runtime(&profile, runtime) {
                    return Err("另一个 Strata 环境仍有受管服务运行，本次确认不会停止它".into());
                }
                owned.push(profile);
            }
            (Some(true), _) => return Err("存在未由此后台托管的服务，未停止任何外部进程".into()),
            (Some(false), _) => {}
            _ => return Err("后台服务状态不完整，未停止任何服务".into()),
        }
    }
    if owned.len() as u64 != active {
        return Err("后台运行服务与模型登记不一致，未停止任何服务".into());
    }
    Ok((active, owned))
}
async fn health(ipc: &SupervisorClient, profile: &ServiceProfile) -> Result<Value, String> {
    let value = raw(
        ipc,
        "strata_request",
        json!({"profile": profile, "path": "/health", "method": "GET"}),
    )
    .await?;
    if value["service"] != "strata" || value["status"] != "ok" || !value["loaded"].is_boolean() {
        return Err("无法核实当前模型的加载状态，原服务保持运行".into());
    }
    Ok(value)
}
fn backend_params(record: &Record) -> Value {
    // The legacy bridge already stopped the specifically approved services.
    // A newly appearing service must never be stopped by the subsequent ZIP task.
    json!({"installDir": record.install_dir, "assetName": record.asset_name, "requestId": record.task.id, "stopCurrentService": false, "localArchivePath": record.download.local_archive_path, "downloadUrl": record.download.download_url})
}
fn backend_method(download: &RuntimeZipDownloadOptions) -> &'static str {
    if download.is_custom() {
        "update_runtime_zip_download_v1"
    } else {
        "update_runtime_zip"
    }
}

pub async fn start(
    ipc: &SupervisorClient,
    install_dir: String,
    asset_name: Option<String>,
    stop_current_service: bool,
    download: RuntimeZipDownloadOptions,
) -> Result<Value, String> {
    start_with_download_probe(
        ipc,
        install_dir,
        asset_name,
        stop_current_service,
        download,
        approved_processes,
    )
    .await
}
#[cfg(all(test, windows))]
async fn start_with_probe(
    ipc: &SupervisorClient,
    install_dir: String,
    asset_name: Option<String>,
    stop_current_service: bool,
    probe: Probe,
) -> Result<Value, String> {
    start_with_download_probe(
        ipc,
        install_dir,
        asset_name,
        stop_current_service,
        RuntimeZipDownloadOptions::default(),
        probe,
    )
    .await
}
async fn start_with_download_probe(
    ipc: &SupervisorClient,
    install_dir: String,
    asset_name: Option<String>,
    stop_current_service: bool,
    download: RuntimeZipDownloadOptions,
    probe: Probe,
) -> Result<Value, String> {
    let download = download.validate(asset_name.as_deref())?;
    let _serial = SERIAL.lock().await;
    let _process = guard(ipc).await?;
    let runtime = root(&install_dir)?;
    if asset_name.as_deref().is_some_and(|asset| {
        !matches!(
            asset,
            "strata-windows-x64.zip"
                | "strata-windows-x64-cuda12.zip"
                | "strata-windows-x64-hip.zip"
        )
    }) {
        return Err("不是支持的官方 Strata ZIP".into());
    }
    let mut values = records(ipc).await?;
    if let Some(existing) = values.iter().find(|record| {
        record.task.state == "running" && record.install_dir == runtime.to_string_lossy()
    }) {
        if existing.asset_name != asset_name || existing.download != download {
            return Err("此运行环境已有不同 ZIP 或下载来源的更新任务".into());
        }
        return serde_json::to_value(&existing.task).map_err(|error| error.to_string());
    }
    download.validate_local_file()?;
    let (active, owned) = inventory(ipc, &runtime).await?;
    if active > 0 && !stop_current_service {
        return Err("当前模型服务正在运行，请确认停止服务后再更新".into());
    }
    if !observe(probe, &runtime, &owned).await? {
        return Err("此 Strata 仍有无法确认归属的外部服务；本次更新不会自动停止它".into());
    }
    let request_id = uuid::Uuid::new_v4().to_string();
    let params = json!({"installDir": runtime, "assetName": asset_name, "requestId": request_id, "stopCurrentService": stop_current_service, "localArchivePath": download.local_archive_path, "downloadUrl": download.download_url});
    match strata_local_ipc::call(&ipc.data_dir, backend_method(&download), params).await {
        Ok(task) => return Ok(task),
        Err(error) if error.code == "unknown_method" => {}
        Err(error) => return Err(error.to_string()),
    }
    let mut restarts = Vec::new();
    for profile in owned {
        let loaded = health(ipc, &profile).await?["loaded"].as_bool().unwrap();
        restarts.push(Restart { profile, loaded });
    }
    let task = TaskStatus {
        id: request_id,
        kind: "update".into(),
        state: "running".into(),
        message: "正在准备已确认的 ZIP 更新；保存当前配置和服务恢复记录".into(),
        started_at: now(),
        finished_at: None,
    };
    let record = Record {
        task: task.clone(),
        install_dir: runtime.to_string_lossy().into(),
        asset_name,
        download,
        stop_confirmed: stop_current_service,
        phase: "stopping".into(),
        backend_task_id: None,
        restarts,
        previous_active: get(ipc, "activeLocalInstallation").await?,
        previous_gui_active: get(ipc, "activeProfile").await?,
        previous_desired: get(ipc, "localServiceDesired").await?,
        terminal: None,
        logs: vec![LogEntry {
            timestamp: now(),
            level: "info".into(),
            message: task.message.clone(),
        }],
        registry: Some(
            ipc.registry_snapshot()
                .await
                .map_err(|error| error.to_string())?,
        ),
    };
    values.retain(|record| {
        record.task.state == "running"
            || now().saturating_sub(record.task.started_at) < 30 * 24 * 60 * 60 * 1000
    });
    values.push(record);
    let index = values.len() - 1;
    save(ipc, &values).await?;
    if let Err(error) = submit_legacy(ipc, &mut values, index, probe).await {
        fail_and_restore(ipc, &mut values, index, error, probe).await?;
    }
    serde_json::to_value(&values[index].task).map_err(|error| error.to_string())
}

async fn submit_legacy(
    ipc: &SupervisorClient,
    values: &mut [Record],
    index: usize,
    probe: Probe,
) -> Result<(), String> {
    let runtime = root(&values[index].install_dir)?;
    let (active, owned) = inventory(ipc, &runtime).await?;
    let approved: Vec<_> = values[index]
        .restarts
        .iter()
        .map(|item| item.profile.clone())
        .collect();
    if active > 0 && !values[index].stop_confirmed {
        return Err("停止服务尚未确认，未执行更新".into());
    }
    if owned.iter().any(|profile| {
        !approved
            .iter()
            .any(|saved| serde_json::to_value(saved).ok() == serde_json::to_value(profile).ok())
    }) {
        return Err("当前服务配置已改变，原停止确认不适用于新配置".into());
    }
    if !observe(probe, &runtime, &owned).await? {
        return Err("检测到未获本次确认的运行实例，未停止外部服务".into());
    }
    set(ipc, "localServiceDesired", json!(false)).await?;
    message(
        &mut values[index],
        "已确认停止当前服务；正在停止对应配置并更新后台",
    );
    save(ipc, values).await?;
    for profile in owned {
        raw(ipc, "stop_service", json!({"profileId": profile.id})).await?;
    }
    wait_stopped(ipc, &runtime, probe).await?;
    ipc.ensure_connected()
        .await
        .map_err(|error| error.to_string())?;
    wait_stopped(ipc, &runtime, probe).await?;
    // Persist submission intent before the mutation. Reopening reconciles this
    // same requestId instead of ever creating a second update task.
    values[index].phase = "submitting".into();
    message(
        &mut values[index],
        "后台已准备；正在提交官方 ZIP 下载、校验和安装任务",
    );
    save(ipc, values).await?;
    let task = match ipc
        .request(
            backend_method(&values[index].download),
            backend_params(&values[index]),
        )
        .await
    {
        Ok(task) => task,
        Err(error)
            if matches!(
                error.code.as_str(),
                "request_timeout"
                    | "supervisor_unavailable"
                    | "invalid_response"
                    | "protocol_mismatch"
            ) =>
        {
            return Err(error.to_string())
        }
        Err(error) if error.code == "unknown_method" => {
            values[index].phase = "stopping".into();
            return Err("后台升级尚未完成，ZIP 更新未执行；正在恢复原服务，请稍后重试".into());
        }
        Err(error) => {
            values[index].phase = "stopping".into();
            return Err(error.to_string());
        }
    };
    let task: TaskStatus = serde_json::from_value(task).map_err(|error| error.to_string())?;
    values[index].backend_task_id = Some(task.id);
    values[index].phase = "submitted".into();
    message(&mut values[index], task.message);
    save(ipc, values).await
}

async fn restore(ipc: &SupervisorClient, record: &mut Record, probe: Probe) -> Result<(), String> {
    let runtime = root(&record.install_dir)?;
    let registered: Vec<ServiceProfile> =
        serde_json::from_value(raw(ipc, "local_installations", json!({})).await?)
            .map_err(|error| error.to_string())?;
    let expected: Vec<_> = record
        .registry
        .as_ref()
        .map(|snapshot| snapshot.profiles.clone())
        .unwrap_or_else(|| {
            record
                .restarts
                .iter()
                .map(|restart| restart.profile.clone())
                .collect()
        });
    if expected.iter().any(|saved| {
        !registered
            .iter()
            .any(|profile| serde_json::to_value(profile).ok() == serde_json::to_value(saved).ok())
    }) {
        if raw(ipc, "hello", json!({})).await?["activeServices"].as_u64() != Some(0) {
            return Err(
                "旧模型登记尚未恢复且已有服务运行；保留原配置恢复记录，未停止当前实例".into(),
            );
        }
        let mut snapshot = match record.registry.clone() {
            Some(snapshot) => snapshot,
            None => RegistrySnapshot {
                profiles: expected.clone(),
                originals: expected
                    .iter()
                    .filter_map(|profile| {
                        crate::supervisor_client::original_profile(
                            profile,
                            &Value::Null,
                            &ipc.data_dir,
                        )
                    })
                    .collect(),
                active_local_installation: record.previous_active.clone(),
                active_profile: record.previous_gui_active.clone(),
                local_service_desired: json!(false),
                preserved_values: vec![],
            },
        };
        snapshot.local_service_desired = json!(false);
        ipc.restore_registry_snapshot(&snapshot)
            .await
            .map_err(|error| error.to_string())?;
    }
    let (_, owned) = inventory(ipc, &runtime).await?;
    let approved: Vec<_> = record
        .restarts
        .iter()
        .map(|restart| restart.profile.clone())
        .collect();
    if owned
        .iter()
        .any(|profile| !approved.iter().any(|saved| saved.id == profile.id))
        || !observe(probe, &runtime, &owned).await?
    {
        return Err("服务归属发生变化，保留恢复记录；未停止或覆盖其它实例".into());
    }
    for restart in &record.restarts {
        let status = raw(
            ipc,
            "service_status",
            json!({"profileId": restart.profile.id}),
        )
        .await?;
        let needs_load = restart.loaded
            && health(ipc, &restart.profile)
                .await
                .is_ok_and(|health| health["loaded"] != true);
        if status["running"] != true || status["owned"] != true || needs_load {
            if restart.loaded {
                ipc.request(
                    "ensure_local_service",
                    json!({"profileId": restart.profile.id}),
                )
                .await
                .map_err(|error| error.to_string())?;
            } else {
                ipc.request("start_service", json!({"profile": restart.profile}))
                    .await
                    .map_err(|error| error.to_string())?;
            }
        }
        // start_service returns the child immediately; an originally unloaded
        // API needs a short health wait without loading a model as a side effect.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            if let Ok(restored) = health(ipc, &restart.profile).await {
                if restored["loaded"].as_bool() == Some(restart.loaded) {
                    break;
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("服务已启动，原模型加载状态 30 秒内未恢复；请查看启动日志".into());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    set(
        ipc,
        "activeLocalInstallation",
        record.previous_active.clone(),
    )
    .await?;
    set(ipc, "activeProfile", record.previous_gui_active.clone()).await?;
    set(ipc, "localServiceDesired", record.previous_desired.clone()).await?;
    Ok(())
}
async fn finish(
    ipc: &SupervisorClient,
    values: &mut [Record],
    index: usize,
    probe: Probe,
) -> Result<(), String> {
    let terminal = values[index].terminal.clone().ok_or("更新终止状态缺失")?;
    values[index].phase = "restoring".into();
    message(&mut values[index], "正在恢复更新前的当前配置和模型加载状态");
    save(ipc, values).await?;
    let result = restore(ipc, &mut values[index], probe).await;
    values[index].task.state = if result.is_ok() {
        terminal.state
    } else {
        "running".into()
    };
    values[index].task.finished_at = result.is_ok().then(now);
    values[index].phase = if result.is_ok() {
        values[index].task.state.clone()
    } else {
        "restoreFailed".into()
    };
    let text = match result {
        Ok(_) => format!("{}；原配置及服务状态已恢复", terminal.message),
        Err(error) => format!(
            "{}；服务恢复未完成，恢复记录保留，等待修复：{error}",
            terminal.message
        ),
    };
    message(&mut values[index], text);
    save(ipc, values).await
}
async fn fail_and_restore(
    ipc: &SupervisorClient,
    values: &mut [Record],
    index: usize,
    error: String,
    probe: Probe,
) -> Result<(), String> {
    // An ambiguous response after submitting must be reconciled by requestId;
    // restoring a model immediately could race an accepted file replacement.
    if matches!(values[index].phase.as_str(), "submitting" | "submitted") {
        message(
            &mut values[index],
            format!("正在核对已提交的更新任务，未重复执行：{error}"),
        );
        return save(ipc, values).await;
    }
    let mut terminal = values[index].task.clone();
    terminal.state = "failed".into();
    terminal.message = error;
    values[index].terminal = Some(terminal);
    finish(ipc, values, index, probe).await
}

pub async fn tick(ipc: &SupervisorClient) -> Result<(), String> {
    tick_with_probe(ipc, approved_processes).await
}
async fn tick_with_probe(ipc: &SupervisorClient, probe: Probe) -> Result<(), String> {
    let _serial = SERIAL.lock().await;
    let _process = guard(ipc).await?;
    let mut values = records(ipc).await?;
    for record in &mut values {
        if record.task.state == "failed"
            && record.terminal.is_some()
            && record.task.message.contains("服务恢复未完成")
        {
            record.task.state = "running".into();
            record.task.finished_at = None;
            record.phase = "restoreFailed".into();
        }
    }
    if !values.iter().any(|record| record.task.state == "running") {
        return Ok(());
    }
    let backend: Vec<TaskStatus> = serde_json::from_value(raw(ipc, "list_tasks", json!({})).await?)
        .map_err(|error| error.to_string())?;
    for index in 0..values.len() {
        if values[index].task.state != "running" {
            continue;
        }
        let backend_id = values[index]
            .backend_task_id
            .as_deref()
            .unwrap_or(&values[index].task.id);
        if let Some(task) = backend.iter().find(|task| task.id == backend_id) {
            values[index].backend_task_id = Some(task.id.clone());
            values[index].phase = "submitted".into();
            if task.state == "running" {
                message(&mut values[index], task.message.clone());
                save(ipc, &values).await?;
            } else {
                values[index].terminal = Some(task.clone());
                finish(ipc, &mut values, index, probe).await?;
            }
        } else if matches!(values[index].phase.as_str(), "restoring" | "restoreFailed") {
            finish(ipc, &mut values, index, probe).await?;
        } else if matches!(values[index].phase.as_str(), "stopping" | "submitting") {
            if let Err(error) = submit_legacy(ipc, &mut values, index, probe).await {
                fail_and_restore(ipc, &mut values, index, error, probe).await?;
            }
        } else if values[index].phase == "submitted" {
            message(
                &mut values[index],
                "后台更新任务暂时不可见，正在核对任务状态；保留原服务恢复记录",
            );
            save(ipc, &values).await?;
        }
    }
    Ok(())
}
pub async fn list_tasks(ipc: &SupervisorClient) -> Result<Value, String> {
    let mut tasks: Vec<TaskStatus> =
        serde_json::from_value(raw(ipc, "list_tasks", json!({})).await?)
            .map_err(|error| error.to_string())?;
    for record in records(ipc).await? {
        tasks.retain(|task| {
            task.id != record.task.id && record.backend_task_id.as_ref() != Some(&task.id)
        });
        tasks.push(record.task);
    }
    tasks.sort_by_key(|task| std::cmp::Reverse(task.started_at));
    serde_json::to_value(tasks).map_err(|error| error.to_string())
}
pub async fn read_logs(
    ipc: &SupervisorClient,
    mut profile: ServiceProfile,
    limit: usize,
) -> Result<Value, String> {
    let record = records(ipc)
        .await?
        .into_iter()
        .find(|record| record.task.id == profile.id);
    let Some(record) = record else {
        return raw(
            ipc,
            "read_logs",
            json!({"profile": profile, "limit": limit}),
        )
        .await;
    };
    let mut logs = record.logs;
    if let Some(id) = record.backend_task_id {
        profile.id = id;
        profile.config_path.clear();
        let backend: Vec<LogEntry> = serde_json::from_value(
            raw(
                ipc,
                "read_logs",
                json!({"profile": profile, "limit": limit}),
            )
            .await?,
        )
        .map_err(|error| error.to_string())?;
        logs.extend(backend);
    }
    logs.sort_by_key(|log| log.timestamp);
    let keep = limit.min(2000);
    if logs.len() > keep {
        logs.drain(..logs.len() - keep);
    }
    serde_json::to_value(logs).map_err(|error| error.to_string())
}
pub async fn cancel_task(ipc: &SupervisorClient, task_id: String) -> Result<Value, String> {
    let _serial = SERIAL.lock().await;
    let _process = guard(ipc).await?;
    let mut values = records(ipc).await?;
    let Some(index) = values.iter().position(|record| record.task.id == task_id) else {
        return raw(ipc, "cancel_task", json!({"taskId": task_id})).await;
    };
    if values[index].task.state != "running" {
        return Ok(Value::Null);
    }
    let backend: Vec<TaskStatus> = serde_json::from_value(raw(ipc, "list_tasks", json!({})).await?)
        .map_err(|error| error.to_string())?;
    let backend_id = values[index].backend_task_id.as_deref().unwrap_or(&task_id);
    if backend.iter().any(|task| task.id == backend_id) {
        let result = raw(ipc, "cancel_task", json!({"taskId": backend_id})).await?;
        values[index].backend_task_id = Some(backend_id.to_owned());
        message(
            &mut values[index],
            "正在取消更新，等待程序文件和原服务状态恢复",
        );
        save(ipc, &values).await?;
        return Ok(result);
    }
    let mut terminal = values[index].task.clone();
    terminal.state = "cancelled".into();
    terminal.message = "ZIP 更新已取消，未提交安装任务".into();
    values[index].terminal = Some(terminal);
    finish(ipc, &mut values, index, approved_processes).await?;
    Ok(Value::Null)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };
    use strata_local_ipc::{Request, RpcError};
    use tokio_util::sync::CancellationToken;

    struct Fixture {
        profile: ServiceProfile,
        store: HashMap<String, Value>,
        calls: Vec<(String, Value)>,
        running: bool,
        loaded: bool,
        legacy: bool,
        ambiguous: bool,
        tasks: Vec<TaskStatus>,
        package_hash: String,
        lost_registry: bool,
        lose_registry_on_stop: bool,
        restore_fails: bool,
    }

    async fn fixture(
        data: &Path,
        runtime: &Path,
        ambiguous: bool,
    ) -> (
        SupervisorClient,
        Arc<Mutex<Fixture>>,
        CancellationToken,
        tokio::task::JoinHandle<Result<(), RpcError>>,
    ) {
        std::fs::create_dir_all(runtime.join("serve")).unwrap();
        std::fs::write(runtime.join("setup.py"), "# isolated source").unwrap();
        std::fs::write(runtime.join("serve/server.py"), "# never executed").unwrap();
        std::fs::write(runtime.join("config.json"), "{}").unwrap();
        let package = b"never execute isolated supervisor fixture";
        std::fs::write(data.join("strata-supervisor.exe"), package).unwrap();
        let profile = ServiceProfile {
            id: "fixture-model".into(),
            name: "fixture".into(),
            base_url: "http://127.0.0.1:18081".into(),
            install_dir: dunce::canonicalize(runtime)
                .unwrap()
                .to_string_lossy()
                .into(),
            python_path: "never-executed.exe".into(),
            config_path: runtime.join("config.json").to_string_lossy().into(),
            managed: true,
        };
        let store = HashMap::from([
            ("activeLocalInstallation".into(), json!(profile.id)),
            ("activeProfile".into(), json!(profile.id)),
            ("localServiceDesired".into(), json!(true)),
        ]);
        let state = Arc::new(Mutex::new(Fixture {
            profile,
            store,
            calls: vec![],
            running: true,
            loaded: true,
            legacy: true,
            ambiguous,
            tasks: vec![],
            package_hash: format!("{:x}", Sha256::digest(package)),
            lost_registry: false,
            lose_registry_on_stop: false,
            restore_fails: false,
        }));
        let stop = CancellationToken::new();
        let token = stop.clone();
        let directory = data.to_owned();
        let server_state = state.clone();
        let server = tokio::spawn(async move {
            strata_local_ipc::serve(&directory, token, move |request: Request| {
                let state = server_state.clone();
                async move {
                    let mut state = state.lock().unwrap();
                    state.calls.push((request.method.clone(), request.params.clone()));
                    match request.method.as_str() {
                        "hello" => Ok(json!({"pid": 123, "version": env!("CARGO_PKG_VERSION"), "executableHash": state.package_hash, "activeServices": u64::from(state.running)})),
                        "store_get" => Ok(state.store.get(request.params["key"].as_str().unwrap()).cloned().unwrap_or(Value::Null)),
                        "store_set" => { state.store.insert(request.params["key"].as_str().unwrap().into(), request.params["value"].clone()); Ok(Value::Null) },
                        "local_installations" => Ok(if state.lost_registry { json!([]) } else { json!([state.profile]) }),
                        "local_installation_details" => Err(RpcError::new("unknown_method", "legacy metadata fixture")),
                        "restore_local_registry" => { assert!(!state.running); let restored: ServiceProfile = serde_json::from_value(request.params["profiles"][0].clone()).unwrap(); assert_eq!(restored.id, state.profile.id); assert_eq!(restored.config_path, state.profile.config_path); state.lost_registry = false; for key in ["activeLocalInstallation", "activeProfile", "localServiceDesired"] { state.store.insert(key.into(), request.params[key].clone()); } Ok(Value::Null) },
                        "service_status" => Ok(json!({"running": state.running, "owned": state.running, "pid": 456})),
                        "strata_request" => { assert_eq!(request.params["method"], "GET"); assert_eq!(request.params["path"], "/health"); Ok(json!({"service": "strata", "status": "ok", "loaded": state.loaded})) },
                        "update_runtime_zip" | "update_runtime_zip_download_v1" if state.legacy => Err(RpcError::new("unknown_method", "isolated legacy method")),
                        "update_runtime_zip" | "update_runtime_zip_download_v1" => {
                            assert!(!state.running, "ZIP submission must follow the approved service stop");
                            assert_eq!(request.params["stopCurrentService"], false);
                            let id = request.params["requestId"].as_str().unwrap().to_owned();
                            if let Some(task) = state.tasks.iter().find(|task| task.id == id) { return Ok(json!(task)); }
                            let task = TaskStatus { id, kind: "update".into(), state: "running".into(), message: "isolated ZIP task accepted".into(), started_at: now(), finished_at: None };
                            state.tasks.push(task.clone());
                            if state.ambiguous { state.ambiguous = false; return Err(RpcError::new("request_timeout", "accepted but reply interrupted")); }
                            Ok(json!(task))
                        },
                        "stop_service" => { assert_eq!(request.params["profileId"], state.profile.id); state.running = false; state.loaded = false; state.legacy = false; state.lost_registry = state.lose_registry_on_stop; Ok(Value::Null) },
                        "ensure_local_service" => { assert!(state.tasks.iter().all(|task| task.state != "running")); if state.restore_fails { return Err(RpcError::new("runtime_operation", "isolated temporary restore failure")); } state.running = true; state.loaded = true; Ok(json!({"state": "ready"})) },
                        "start_service" => { state.running = true; state.loaded = false; Ok(Value::Null) },
                        "list_tasks" => Ok(json!(state.tasks)),
                        "read_logs" => Ok(json!([])),
                        "cancel_task" => { let id = request.params["taskId"].as_str().unwrap(); for task in &mut state.tasks { if task.id == id { task.state = "cancelled".into(); task.message = "isolated rollback complete".into(); } } Ok(Value::Null) },
                        other => panic!("unexpected isolated RPC: {other}"),
                    }
                }
            }).await
        });
        for _ in 0..100 {
            if strata_local_ipc::call(data, "hello", json!({}))
                .await
                .is_ok()
            {
                return (
                    SupervisorClient::new(data.to_owned(), data.to_owned()),
                    state,
                    stop,
                    server,
                );
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("isolated fixture did not start");
    }
    fn safe_probe(_: &Path, _: &[ServiceProfile]) -> Result<bool, String> {
        Ok(true)
    }

    #[tokio::test]
    async fn custom_download_sources_survive_legacy_handoff_and_resubmission() {
        for local in [true, false] {
            let temp = tempfile::tempdir().unwrap();
            let runtime = temp.path().join("runtime");
            let archive = temp.path().join("strata-windows-x64.zip");
            std::fs::write(&archive, b"isolated ZIP metadata fixture; never unpacked").unwrap();
            let download = RuntimeZipDownloadOptions {
                local_archive_path: local.then(|| archive.to_string_lossy().into_owned()),
                download_url: (!local)
                    .then(|| "https://mirror.example/strata-windows-x64.zip".into()),
            };
            let (client, state, stop, server) = fixture(temp.path(), &runtime, false).await;
            let task = start_with_download_probe(
                &client,
                runtime.to_string_lossy().into(),
                Some("strata-windows-x64.zip".into()),
                true,
                download.clone(),
                safe_probe,
            )
            .await
            .unwrap();
            let mut saved = records(&client).await.unwrap();
            assert_eq!(saved[0].download, download);
            if local {
                let other = temp.path().join("other.zip");
                std::fs::write(&other, b"another isolated source").unwrap();
                let error = start_with_download_probe(
                    &client,
                    runtime.to_string_lossy().into(),
                    Some("strata-windows-x64.zip".into()),
                    true,
                    RuntimeZipDownloadOptions {
                        local_archive_path: Some(other.to_string_lossy().into()),
                        download_url: None,
                    },
                    safe_probe,
                )
                .await
                .unwrap_err();
                assert!(error.contains("下载来源"), "{error}");
            }
            assert_eq!(
                backend_method(&saved[0].download),
                "update_runtime_zip_download_v1"
            );
            // Reopening after persisting submission intent but before backend
            // acceptance must retain both the original request ID and source.
            saved[0].phase = "submitting".into();
            saved[0].backend_task_id = None;
            save(&client, &saved).await.unwrap();
            state.lock().unwrap().tasks.clear();
            tick_with_probe(&client, safe_probe).await.unwrap();
            {
                let state = state.lock().unwrap();
                assert_eq!(
                    count(&state, "update_runtime_zip"),
                    0,
                    "custom source cannot fall back to an old RPC"
                );
                assert_eq!(count(&state, "update_runtime_zip_download_v1"), 3);
                assert_eq!(count(&state, "stop_service"), 1);
                for (_, params) in state
                    .calls
                    .iter()
                    .filter(|(name, _)| name == "update_runtime_zip_download_v1")
                {
                    assert_eq!(
                        params["localArchivePath"],
                        json!(download.local_archive_path)
                    );
                    assert_eq!(params["downloadUrl"], json!(download.download_url));
                    assert_eq!(params["requestId"], task["id"]);
                }
                assert_eq!(state.store["localServiceDesired"], false);
                assert_eq!(count(&state, "ensure_local_service"), 0);
            }
            state.lock().unwrap().tasks[0].state = "completed".into();
            tick_with_probe(&client, safe_probe).await.unwrap();
            assert_eq!(list_tasks(&client).await.unwrap()[0]["state"], "completed");
            assert!(state.lock().unwrap().running);
            stop.cancel();
            server.await.unwrap().unwrap();
        }
    }

    #[tokio::test]
    async fn running_update_deduplicates_only_the_same_download_source() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = temp.path().join("runtime");
        let (client, state, stop, server) = fixture(temp.path(), &runtime, false).await;
        let download = RuntimeZipDownloadOptions {
            local_archive_path: None,
            download_url: Some("https://mirror.example/strata-windows-x64.zip".into()),
        };
        let first = start_with_download_probe(
            &client,
            runtime.to_string_lossy().into(),
            Some("strata-windows-x64.zip".into()),
            true,
            download.clone(),
            safe_probe,
        )
        .await
        .unwrap();
        let repeated = start_with_download_probe(
            &client,
            runtime.to_string_lossy().into(),
            Some("strata-windows-x64.zip".into()),
            true,
            download,
            safe_probe,
        )
        .await
        .unwrap();
        assert_eq!(first["id"], repeated["id"]);
        let second_archive = temp.path().join("other.zip");
        std::fs::write(&second_archive, b"isolated local file").unwrap();
        for changed in [
            RuntimeZipDownloadOptions {
                local_archive_path: None,
                download_url: Some("https://another.example/strata-windows-x64.zip".into()),
            },
            RuntimeZipDownloadOptions {
                local_archive_path: Some(second_archive.to_string_lossy().into()),
                download_url: None,
            },
            RuntimeZipDownloadOptions::default(),
        ] {
            let error = start_with_download_probe(
                &client,
                runtime.to_string_lossy().into(),
                Some("strata-windows-x64.zip".into()),
                true,
                changed,
                safe_probe,
            )
            .await
            .unwrap_err();
            assert!(error.contains("下载来源"), "{error}");
        }
        {
            let state = state.lock().unwrap();
            assert_eq!(count(&state, "update_runtime_zip_download_v1"), 2);
            assert_eq!(count(&state, "update_runtime_zip"), 0);
            assert_eq!(count(&state, "stop_service"), 1);
        }
        stop.cancel();
        server.await.unwrap().unwrap();
    }
    #[tokio::test]
    async fn accepted_local_update_remains_idempotent_after_source_is_removed() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = temp.path().join("runtime");
        let archive = temp.path().join("strata-windows-x64.zip");
        std::fs::write(&archive, b"isolated accepted ZIP").unwrap();
        let download = RuntimeZipDownloadOptions {
            local_archive_path: Some(archive.to_string_lossy().into()),
            download_url: None,
        };
        let (client, state, stop, server) = fixture(temp.path(), &runtime, false).await;
        let accepted = start_with_download_probe(
            &client,
            runtime.to_string_lossy().into(),
            Some("strata-windows-x64.zip".into()),
            true,
            download.clone(),
            safe_probe,
        )
        .await
        .unwrap();
        std::fs::remove_file(&archive).unwrap();
        let repeated = start_with_download_probe(
            &client,
            runtime.to_string_lossy().into(),
            Some("strata-windows-x64.zip".into()),
            true,
            download,
            safe_probe,
        )
        .await
        .unwrap();
        assert_eq!(accepted["id"], repeated["id"]);
        {
            let state = state.lock().unwrap();
            assert_eq!(count(&state, "update_runtime_zip_download_v1"), 2);
            assert_eq!(count(&state, "stop_service"), 1);
        }
        stop.cancel();
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn missing_local_zip_for_new_request_does_not_stop_or_submit() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = temp.path().join("runtime");
        let (client, state, stop, server) = fixture(temp.path(), &runtime, false).await;
        let download = RuntimeZipDownloadOptions {
            local_archive_path: Some(temp.path().join("missing.zip").to_string_lossy().into()),
            download_url: None,
        };
        assert!(start_with_download_probe(
            &client,
            runtime.to_string_lossy().into(),
            Some("strata-windows-x64.zip".into()),
            true,
            download,
            safe_probe
        )
        .await
        .is_err());
        {
            let state = state.lock().unwrap();
            assert!(state.running && state.loaded);
            assert_eq!(count(&state, "update_runtime_zip_download_v1"), 0);
            assert_eq!(count(&state, "update_runtime_zip"), 0);
            assert_eq!(count(&state, "stop_service"), 0);
            assert_eq!(state.store["localServiceDesired"], true);
            assert!(!state.store.contains_key(KEY));
        }
        stop.cancel();
        server.await.unwrap().unwrap();
    }

    fn count(state: &Fixture, method: &str) -> usize {
        state
            .calls
            .iter()
            .filter(|(name, _)| name == method)
            .count()
    }

    #[tokio::test]
    async fn missing_confirmation_never_stops_or_submits_an_update() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = temp.path().join("runtime");
        let (client, state, stop, server) = fixture(temp.path(), &runtime, false).await;
        let error = start_with_probe(
            &client,
            runtime.to_string_lossy().into(),
            None,
            false,
            safe_probe,
        )
        .await
        .unwrap_err();
        assert!(error.contains("确认停止"));
        {
            let state = state.lock().unwrap();
            assert!(state.running && state.loaded);
            assert_eq!(count(&state, "stop_service"), 0);
            assert_eq!(count(&state, "update_runtime_zip"), 0);
            assert_eq!(state.store["localServiceDesired"], true);
            assert!(!state.store.contains_key(KEY));
        }
        stop.cancel();
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn originally_unloaded_service_restores_api_without_loading_model() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = temp.path().join("runtime");
        let (client, state, stop, server) = fixture(temp.path(), &runtime, false).await;
        state.lock().unwrap().loaded = false;
        start_with_probe(
            &client,
            runtime.to_string_lossy().into(),
            None,
            true,
            safe_probe,
        )
        .await
        .unwrap();
        state.lock().unwrap().tasks[0].state = "completed".into();
        tick_with_probe(&client, safe_probe).await.unwrap();
        {
            let state = state.lock().unwrap();
            assert!(state.running);
            assert!(!state.loaded);
            assert_eq!(count(&state, "start_service"), 1);
            assert_eq!(count(&state, "ensure_local_service"), 0);
        }
        assert_eq!(list_tasks(&client).await.unwrap()[0]["state"], "completed");
        stop.cancel();
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn lost_registration_is_restored_with_original_id_and_failed_recovery_remains_pending() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = temp.path().join("runtime");
        let (client, state, stop, server) = fixture(temp.path(), &runtime, false).await;
        {
            let mut state = state.lock().unwrap();
            state.lose_registry_on_stop = true;
            state.restore_fails = true;
        }
        start_with_probe(
            &client,
            runtime.to_string_lossy().into(),
            None,
            true,
            safe_probe,
        )
        .await
        .unwrap();
        state.lock().unwrap().tasks[0].state = "completed".into();
        tick_with_probe(&client, safe_probe).await.unwrap();
        let saved = records(&client).await.unwrap();
        assert_eq!(saved[0].phase, "restoreFailed");
        assert_eq!(saved[0].task.state, "running");
        assert!(saved[0].task.finished_at.is_none());
        assert!(saved[0].task.message.contains("等待修复"));
        {
            let mut state = state.lock().unwrap();
            assert_eq!(count(&state, "restore_local_registry"), 1);
            assert!(!state.lost_registry);
            assert_eq!(state.store["localServiceDesired"], false);
            state.restore_fails = false;
        }
        tick_with_probe(&client, safe_probe).await.unwrap();
        let saved = records(&client).await.unwrap();
        assert_eq!(saved[0].task.state, "completed");
        {
            let state = state.lock().unwrap();
            assert!(state.running && state.loaded);
            assert_eq!(state.store["activeProfile"], "fixture-model");
            assert_eq!(count(&state, "stop_service"), 1);
            assert_eq!(count(&state, "update_runtime_zip"), 2);
        }
        stop.cancel();
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn legacy_failed_recovery_journal_is_resumed_without_resubmitting_update() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = temp.path().join("runtime");
        let (client, state, stop, server) = fixture(temp.path(), &runtime, false).await;
        start_with_probe(
            &client,
            runtime.to_string_lossy().into(),
            None,
            true,
            safe_probe,
        )
        .await
        .unwrap();
        let mut saved = records(&client).await.unwrap();
        saved[0].registry = None;
        saved[0].phase = "failed".into();
        saved[0].task.state = "failed".into();
        saved[0].task.message = "旧后台更新失败；服务恢复未完成".into();
        saved[0].terminal = Some(TaskStatus {
            state: "failed".into(),
            message: "original update failed".into(),
            ..saved[0].task.clone()
        });
        save(&client, &saved).await.unwrap();
        {
            let mut state = state.lock().unwrap();
            state.tasks.clear();
            state.lost_registry = true;
        }
        tick_with_probe(&client, safe_probe).await.unwrap();
        let saved = records(&client).await.unwrap();
        assert_eq!(saved[0].task.state, "failed");
        assert!(saved[0].task.message.contains("原配置及服务状态已恢复"));
        {
            let state = state.lock().unwrap();
            assert!(state.running && state.loaded);
            assert_eq!(state.store["activeProfile"], "fixture-model");
            assert_eq!(count(&state, "update_runtime_zip"), 2);
            assert_eq!(count(&state, "restore_local_registry"), 1);
        }
        stop.cancel();
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn handoff_recovers_legacy_original_selection_before_default_startup() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = temp.path().join("runtime");
        let (client, state, stop, server) = fixture(temp.path(), &runtime, false).await;
        start_with_probe(
            &client,
            runtime.to_string_lossy().into(),
            None,
            true,
            safe_probe,
        )
        .await
        .unwrap();
        let mut saved = records(&client).await.unwrap();
        saved[0].registry = None;
        saved[0].phase = "failed".into();
        saved[0].task.state = "failed".into();
        saved[0].task.message = "旧更新失败；服务恢复未完成".into();
        saved[0].terminal = Some(saved[0].task.clone());
        let original = saved[0].restarts[0].profile.clone();
        let mut wrong = original.clone();
        wrong.id = "incorrect-default-model".into();
        let mut snapshot = RegistrySnapshot {
            profiles: vec![wrong.clone()],
            originals: vec![],
            active_local_installation: json!(wrong.id),
            active_profile: json!(wrong.id),
            local_service_desired: json!(true),
            preserved_values: vec![],
        };
        let calls_before = state.lock().unwrap().calls.len();
        merge_recovery_snapshot(temp.path(), &mut snapshot, json!(saved)).unwrap();
        assert_eq!(snapshot.profiles.len(), 2);
        assert!(snapshot
            .profiles
            .iter()
            .any(|profile| serde_json::to_value(profile).unwrap() == json!(original)));
        assert_eq!(snapshot.active_local_installation, original.id);
        assert_eq!(snapshot.active_profile, original.id);
        assert_eq!(snapshot.local_service_desired, false);
        assert!(
            snapshot.originals.is_empty(),
            "unknown source must not invent original metadata"
        );
        assert_eq!(
            state.lock().unwrap().calls.len(),
            calls_before,
            "metadata reconciliation must never call lifecycle RPCs"
        );
        let mut conflicting = original.clone();
        conflicting.config_path = runtime.join("different.json").to_string_lossy().into();
        snapshot.profiles = vec![conflicting];
        let error = merge_recovery_snapshot(temp.path(), &mut snapshot, json!(saved)).unwrap_err();
        assert_eq!(error.code, "supervisor_registry");
        assert!(error.message.contains("冲突"));
        assert_eq!(state.lock().unwrap().calls.len(), calls_before);
        stop.cancel();
        server.await.unwrap().unwrap();
    }

    #[test]
    fn original_source_requires_a_valid_import_manifest_for_the_same_runtime() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = temp.path().join("runtime");
        let imported = temp.path().join("imports/original-profile");
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::create_dir_all(&imported).unwrap();
        let source = runtime.join("source.json");
        std::fs::write(&source, "{}").unwrap();
        std::fs::write(imported.join("config.json"), "{}").unwrap();
        let profile = ServiceProfile {
            id: "original-profile".into(),
            name: "fixture".into(),
            base_url: "http://127.0.0.1:18081".into(),
            install_dir: runtime.to_string_lossy().into(),
            python_path: "never-executed.exe".into(),
            config_path: imported.join("config.json").to_string_lossy().into(),
            managed: true,
        };
        std::fs::write(
            imported.join("import.json"),
            json!({"schemaVersion":1, "installDir": runtime, "originalConfigPath": source})
                .to_string(),
        )
        .unwrap();
        let original =
            crate::supervisor_client::original_profile(&profile, &Value::Null, temp.path())
                .unwrap();
        assert_eq!(original.id, profile.id);
        assert_eq!(original.config_path, source.to_string_lossy());
        std::fs::write(
            imported.join("import.json"),
            json!({"schemaVersion":1, "installDir": temp.path(), "originalConfigPath": source})
                .to_string(),
        )
        .unwrap();
        assert!(
            crate::supervisor_client::original_profile(&profile, &Value::Null, temp.path())
                .is_none()
        );
    }

    #[tokio::test]
    async fn changing_python_inventory_is_reobserved_before_any_lifecycle_action() {
        static OBSERVATIONS: std::sync::atomic::AtomicUsize =
            std::sync::atomic::AtomicUsize::new(0);
        fn changing(_: &Path, _: &[ServiceProfile]) -> Result<bool, String> {
            if OBSERVATIONS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                Err("Python 进程清单发生变化，请重新检测；未自动启动".into())
            } else {
                Ok(true)
            }
        }
        OBSERVATIONS.store(0, std::sync::atomic::Ordering::SeqCst);
        let temp = tempfile::tempdir().unwrap();
        let runtime = temp.path().join("runtime");
        let (client, state, stop, server) = fixture(temp.path(), &runtime, false).await;
        let task = start_with_probe(
            &client,
            runtime.to_string_lossy().into(),
            None,
            true,
            changing,
        )
        .await
        .unwrap();
        assert_eq!(task["state"], "running");
        assert!(OBSERVATIONS.load(std::sync::atomic::Ordering::SeqCst) > 2);
        {
            let state = state.lock().unwrap();
            assert_eq!(count(&state, "stop_service"), 1);
            assert_eq!(count(&state, "update_runtime_zip"), 2);
        }
        stop.cancel();
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn confirmed_legacy_update_is_unique_across_clients_and_restores_service() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = temp.path().join("runtime");
        let (client, state, stop, server) = fixture(temp.path(), &runtime, false).await;
        let second = SupervisorClient::new(temp.path().into(), temp.path().into());
        let (first, repeat) = tokio::join!(
            start_with_probe(
                &client,
                runtime.to_string_lossy().into(),
                None,
                true,
                safe_probe
            ),
            start_with_probe(
                &second,
                runtime.to_string_lossy().into(),
                None,
                true,
                safe_probe
            )
        );
        let first = first.unwrap();
        let repeat = repeat.unwrap();
        assert_eq!(first["id"], repeat["id"]);
        assert_eq!(first["kind"], "update");
        let listed = list_tasks(&client).await.unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);
        {
            let mut state = state.lock().unwrap();
            assert_eq!(count(&state, "stop_service"), 1);
            assert_eq!(count(&state, "update_runtime_zip"), 2);
            assert_eq!(count(&state, "ensure_local_service"), 0);
            assert_eq!(state.store["localServiceDesired"], false);
            let stops = state
                .calls
                .iter()
                .position(|(name, _)| name == "stop_service")
                .unwrap();
            let submit = state
                .calls
                .iter()
                .rposition(|(name, _)| name == "update_runtime_zip")
                .unwrap();
            assert!(stops < submit);
            state.tasks[0].state = "completed".into();
            state.tasks[0].message = "isolated update finished".into();
        }
        tick_with_probe(&client, safe_probe).await.unwrap();
        let listed = list_tasks(&second).await.unwrap();
        assert_eq!(listed[0]["state"], "completed");
        {
            let state = state.lock().unwrap();
            assert!(state.running && state.loaded);
            assert_eq!(count(&state, "ensure_local_service"), 1);
            assert_eq!(state.store["localServiceDesired"], true);
            assert_eq!(state.store["activeProfile"], state.profile.id);
            assert_eq!(state.store["activeLocalInstallation"], state.profile.id);
        }
        // The queue mutex has its own namespace and cannot occupy the supervisor's instance lock.
        let supervisor = SingleInstance::acquire(temp.path()).unwrap();
        let queue = guard(&client).await.unwrap();
        drop(queue);
        drop(supervisor);
        stop.cancel();
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn ambiguous_acceptance_is_reconciled_without_duplicate_submission_or_early_restore() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = temp.path().join("runtime");
        let (client, state, stop, server) = fixture(temp.path(), &runtime, true).await;
        let task = start_with_probe(
            &client,
            runtime.to_string_lossy().into(),
            None,
            true,
            safe_probe,
        )
        .await
        .unwrap();
        assert_eq!(task["state"], "running");
        assert!(task["message"].as_str().unwrap().contains("核对"));
        tick_with_probe(&client, safe_probe).await.unwrap();
        {
            let state = state.lock().unwrap();
            assert_eq!(count(&state, "update_runtime_zip"), 2);
            assert_eq!(count(&state, "stop_service"), 1);
            assert_eq!(count(&state, "ensure_local_service"), 0);
            assert!(!state.running);
        }
        cancel_task(&client, task["id"].as_str().unwrap().into())
            .await
            .unwrap();
        tick_with_probe(&client, safe_probe).await.unwrap();
        assert_eq!(list_tasks(&client).await.unwrap()[0]["state"], "cancelled");
        {
            let state = state.lock().unwrap();
            assert_eq!(count(&state, "update_runtime_zip"), 2);
            assert_eq!(count(&state, "stop_service"), 1);
            assert_eq!(count(&state, "cancel_task"), 1);
            assert!(state.running && state.loaded);
        }
        stop.cancel();
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    #[ignore = "explicit live refusal check; no stop confirmation and no update mutation"]
    async fn live_running_model_refuses_unconfirmed_update_without_changing_service_or_intent() {
        let data = std::env::var_os("STRATA_METADATA_READONLY_DATA_DIR")
            .map(PathBuf::from)
            .expect("set the explicit existing supervisor data directory");
        let before = strata_local_ipc::call(&data, "hello", json!({}))
            .await
            .unwrap();
        assert!(before["activeServices"]
            .as_u64()
            .is_some_and(|count| count > 0));
        let executable = PathBuf::from(before["executablePath"].as_str().unwrap());
        let client = SupervisorClient::new(data, executable.parent().unwrap().into());
        let intent = get(&client, KEY).await.unwrap();
        assert!(
            !intent.as_array().is_some_and(|records| records
                .iter()
                .any(|record| record["task"]["state"] == "running")),
            "This refusal acceptance requires no existing ZIP task"
        );
        let profiles: Vec<ServiceProfile> = serde_json::from_value(
            raw(&client, "local_installations", json!({}))
                .await
                .unwrap(),
        )
        .unwrap();
        let mut running = Vec::new();
        for profile in profiles {
            let status = raw(&client, "service_status", json!({"profileId": profile.id}))
                .await
                .unwrap();
            if status["running"] == true && status["owned"] == true {
                running.push((profile, status));
            }
        }
        assert_eq!(
            running.len() as u64,
            before["activeServices"].as_u64().unwrap()
        );
        let (profile, status) = running.first().unwrap();
        let before_health = health(&client, profile).await.unwrap();
        // Never pass confirmation in live acceptance. The guard must reject
        // before process probing, intent writes or the ZIP mutation RPC.
        let error = start(
            &client,
            "D:/AI/Strata".into(),
            None,
            false,
            RuntimeZipDownloadOptions::default(),
        )
        .await
        .unwrap_err();
        assert!(error.contains("确认停止"), "Unexpected refusal: {error}");
        let after = raw(&client, "hello", json!({})).await.unwrap();
        for key in ["pid", "executableHash", "activeServices"] {
            assert_eq!(after[key], before[key]);
        }
        let after_status = raw(&client, "service_status", json!({"profileId": profile.id}))
            .await
            .unwrap();
        assert_eq!(after_status["pid"], status["pid"]);
        assert_eq!(after_status["running"], true);
        assert_eq!(
            health(&client, profile).await.unwrap()["loaded"],
            before_health["loaded"]
        );
        assert_eq!(get(&client, KEY).await.unwrap(), intent);
        println!("Unconfirmed ZIP update refused; supervisor {}, service PID {}, loaded={} unchanged; saved update intent unchanged", after["pid"], after_status["pid"], before_health["loaded"]);
    }
}
