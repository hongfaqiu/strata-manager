#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
use std::{path::PathBuf, sync::Arc, time::Duration};
use strata_local_ipc::{Request, RpcError};
use strata_runtime_core::RuntimeState;
use tokio_util::sync::CancellationToken;

fn main() {
    // Engine probes and services must never block on a Windows loader dialog.
    strata_runtime_core::processes::suppress_hard_error_dialogs();
    // AMD telemetry runs in a child of this exe so a driver fault cannot end the supervisor (#124).
    if let Some(code) = strata_runtime_core::amd_gpu::run_worker_if_requested() {
        std::process::exit(code);
    }
    if let Some(result) = strata_runtime_core::manager_mcp_stdio::run_if_requested() {
        match result {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("Strata Manager MCP: {error}");
                std::process::exit(1);
            }
        }
    }
    let _ = strata_runtime_core::installation::initialize_installer_package_identity();
    if let Some(result) = strata_runtime_core::mcp_stdio::run_if_requested() {
        match result {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("Strata MCP guardian: {error}");
                std::process::exit(1);
            }
        }
    }
    supervisor_main();
}

#[tokio::main]
async fn supervisor_main() {
    if let Err(error) = run().await {
        eprintln!("Strata Supervisor: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), RpcError> {
    let mut args = std::env::args_os().skip(1);
    let mut data_dir = None;
    let mut defer_restore = false;
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--data-dir") => data_dir = args.next().map(PathBuf::from),
            Some("--defer-restore") => defer_restore = true,
            _ => {
                return Err(RpcError::new(
                    "invalid_arguments",
                    "用法: strata-supervisor --data-dir <绝对目录> [--defer-restore]",
                ))
            }
        }
    }
    let data_dir =
        data_dir.ok_or_else(|| RpcError::new("invalid_arguments", "后台数据目录未指定"))?;
    if !data_dir.is_absolute() {
        return Err(RpcError::new(
            "data_directory",
            "后台数据目录必须为绝对路径",
        ));
    }
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| RpcError::new("data_directory", e.to_string()))?;
    let data_dir = dunce::canonicalize(data_dir)
        .map_err(|e| RpcError::new("data_directory", e.to_string()))?;
    let _instance = match strata_local_ipc::SingleInstance::acquire(&data_dir) {
        Ok(instance) => instance,
        Err(error) if error.code == "already_running" => return Ok(()),
        Err(error) => return Err(error),
    };
    let state = if defer_restore {
        RuntimeState::open_deferred(data_dir.clone())
    } else {
        RuntimeState::open(data_dir.clone())
    }
    .map_err(|e| RpcError::new("runtime_initialization", e))?;
    let shutdown = CancellationToken::new();
    let token = shutdown.clone();
    let runtime = state.clone();
    let recovery = state.clone();
    let recovery_stop = shutdown.clone();
    let collector = state.clone();
    let collector_stop = shutdown.clone();
    tokio::spawn(async move {
        tokio::select! {
            _ = collector_stop.cancelled() => return,
            _ = collector.wait_for_recovery_resume() => {}
        }
        loop {
            tokio::select! { _=collector_stop.cancelled()=>break, _=tokio::time::sleep(Duration::from_secs(1))=>{} }
            let collect = collector.clone();
            match tokio::task::spawn_blocking(move || {
                strata_runtime_core::analytics::poll(&collect)
            })
            .await
            {
                Ok(Ok(())) => {}
                Ok(Err(error)) => eprintln!("本机用量采集失败: {error}"),
                Err(error) => eprintln!("本机用量采集任务失败: {error}"),
            }
        }
    });
    tokio::spawn(async move {
        tokio::select! {
            _ = recovery_stop.cancelled() => return,
            _ = recovery.wait_for_recovery_resume() => {}
        }
        // Ordinary startup only observes saved selections. Restore is reserved
        // for a service interrupted by an explicit runtime/supervisor upgrade.
        if let Err(error) = recovery.clone().restore_default().await {
            eprintln!("后台恢复需要处理: {error}");
        }
        loop {
            tokio::select! { _=recovery_stop.cancelled()=>break, _=tokio::time::sleep(Duration::from_secs(2))=>{} }
            if let Err(error) = recovery.clone().recover_tick().await {
                eprintln!("后台自动恢复失败: {error}");
            }
        }
    });
    let result = strata_local_ipc::serve(&data_dir, token, move |request: Request| {
        let state = runtime.clone();
        let shutdown = shutdown.clone();
        async move {
            if request.method == "shutdown_supervisor" {
                let preparation = if request
                    .params
                    .get("forClose")
                    .and_then(serde_json::Value::as_bool)
                    == Some(true)
                {
                    state.clone().prepare_window_close().await
                } else if request
                    .params
                    .get("forUpdate")
                    .and_then(serde_json::Value::as_bool)
                    == Some(true)
                {
                    state.clone().prepare_upgrade().await
                } else {
                    state.clone().prepare_shutdown().await
                };
                preparation.map_err(|e| RpcError::new("service_busy", e))?;
                // Flush the success response before stopping the listener/process.
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    shutdown.cancel();
                });
                return Ok(serde_json::json!({"stopped":true}));
            }
            // Filesystem inspection and SQLite work do not block the pipe accept
            // loop. All process ownership remains in this process, not the UI.
            tokio::task::spawn_blocking(move || {
                tokio::runtime::Handle::current()
                    .block_on(state.dispatch(&request.method, request.params))
            })
            .await
            .map_err(|e| RpcError::new("runtime_panicked", e.to_string()))?
            .map_err(|error| {
                let code = if error.starts_with("unknown_method:") {
                    "unknown_method"
                } else if error.starts_with("CONFIG_REVISION_CONFLICT:") {
                    "CONFIG_REVISION_CONFLICT"
                } else if error.starts_with("PROFILE_CONFIG_CHANGED:") {
                    "PROFILE_CONFIG_CHANGED"
                } else {
                    "runtime_operation"
                };
                RpcError::new(code, error)
            })
        }
    })
    .await;
    // Graceful and unexpected exits both drop the Job owned by the supervisor.
    let cleanup: Arc<RuntimeState> = state;
    tokio::task::spawn_blocking(move || cleanup.cleanup())
        .await
        .map_err(|e| RpcError::new("shutdown_failure", e.to_string()))?;
    result
}
