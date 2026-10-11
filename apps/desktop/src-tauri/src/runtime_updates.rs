//! Read-only update metadata remains available while an older supervisor keeps
//! the current service running. Installation and ZIP updates still belong to it.
use crate::supervisor_client::SupervisorClient;
use serde_json::{json, Value};

const UPDATE_INFO_KEY: &str = "strataUpstreamUpdateInfo";

pub async fn update_info(ipc: &SupervisorClient, force: bool) -> Result<Value, String> {
    match ipc
        .request("runtime_update_info", json!({"force": force}))
        .await
    {
        Ok(info) => return Ok(info),
        Err(error) if error.code == "unknown_method" => {}
        Err(error) => return Err(error.to_string()),
    }
    let cached = ipc
        .request("store_get", json!({"key": UPDATE_INFO_KEY}))
        .await
        .map_err(|error| error.to_string())?;
    let info = strata_runtime_core::runtime_upgrade::update_info_with_cache(cached, force).await?;
    let info = serde_json::to_value(info).map_err(|error| error.to_string())?;
    ipc.request("store_set", json!({"key": UPDATE_INFO_KEY, "value": info}))
        .await
        .map_err(|error| error.to_string())?;
    Ok(info)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use sha2::Digest;
    use std::{
        path::Path,
        sync::{Arc, Mutex},
        time::Duration,
    };
    use strata_local_ipc::{Request, RpcError};
    use tokio_util::sync::CancellationToken;

    struct Legacy {
        cached: Value,
        methods: Vec<String>,
        response: Result<Value, RpcError>,
    }

    fn cached_release() -> Value {
        json!({
            "checkedAt": strata_runtime_core::types::now(),
            "supportedVersion": strata_runtime_core::runtime_upgrade::VERSION,
            "supportedRevision": strata_runtime_core::installation::SOURCE_REVISION,
            "latestVersion": "0.1.42",
            "releaseName": "Strata 0.1.42",
            "releaseUrl": "https://github.com/Niko1221/Strata/releases/tag/v0.1.42",
            "notes": "Cached official release notes",
            "publishedAt": "2026-10-10T16:10:01Z",
            "assets": [],
            "sourceRevision": "a".repeat(40),
            "sourceArchiveUrl": format!("https://codeload.github.com/Niko1221/Strata/zip/{}", "a".repeat(40)),
            "updateAvailable": true,
            "installable": false,
            "error": null,
        })
    }

    async fn legacy_server(
        data: &Path,
        state: Arc<Mutex<Legacy>>,
    ) -> (
        CancellationToken,
        tokio::task::JoinHandle<Result<(), RpcError>>,
    ) {
        let stop = CancellationToken::new();
        let token = stop.clone();
        let directory = data.to_owned();
        let server = tokio::spawn(async move {
            strata_local_ipc::serve(&directory, token, move |request: Request| {
                let state = state.clone();
                async move {
                    let mut state = state.lock().unwrap();
                    state.methods.push(request.method.clone());
                    match request.method.as_str() {
                        "hello" => Ok(json!({
                            "pid": 123, "activeServices": 1,
                            "version": "legacy-fixture", "executableHash": "legacy-fixture",
                            "health": {"fixture": {"pid": 456, "loaded": true}},
                        })),
                        "runtime_update_info" => state.response.clone(),
                        "store_get" => {
                            assert_eq!(request.params["key"], UPDATE_INFO_KEY);
                            Ok(state.cached.clone())
                        }
                        "store_set" => {
                            assert_eq!(request.params["key"], UPDATE_INFO_KEY);
                            state.cached = request.params["value"].clone();
                            Ok(Value::Null)
                        }
                        _ => panic!("Read-only compatibility sent {}", request.method),
                    }
                }
            })
            .await
        });
        for _ in 0..100 {
            if strata_local_ipc::call(data, "hello", json!({}))
                .await
                .is_ok()
            {
                return (stop, server);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("isolated legacy RPC server failed to start");
    }

    fn client(data: &Path) -> SupervisorClient {
        // A readable package identity is sufficient: the busy fixture must never
        // execute it or ask to replace the existing background.
        std::fs::write(
            data.join("strata-supervisor.exe"),
            "never execute this fixture",
        )
        .unwrap();
        SupervisorClient::new(data.to_owned(), data.to_owned())
    }

    #[tokio::test]
    async fn legacy_unknown_method_uses_cached_notes_without_service_or_background_changes() {
        let temp = tempfile::tempdir().unwrap();
        let cached = cached_release();
        let state = Arc::new(Mutex::new(Legacy {
            cached: cached.clone(),
            methods: Vec::new(),
            response: Err(RpcError::new("unknown_method", "unsupported legacy method")),
        }));
        let (stop, server) = legacy_server(temp.path(), state.clone()).await;
        let before = strata_local_ipc::call(temp.path(), "hello", json!({}))
            .await
            .unwrap();
        let result = update_info(&client(temp.path()), false).await.unwrap();
        assert_eq!(result["checkedAt"], cached["checkedAt"]);
        assert_eq!(result["notes"], cached["notes"]);
        assert_eq!(result["latestVersion"], "0.1.42");
        let after = strata_local_ipc::call(temp.path(), "hello", json!({}))
            .await
            .unwrap();
        assert_eq!(after, before);
        let state = state.lock().unwrap();
        assert_eq!(state.cached, result);
        assert!(state.methods.iter().all(|method| matches!(
            method.as_str(),
            "hello" | "runtime_update_info" | "store_get" | "store_set"
        )));
        drop(state);
        stop.cancel();
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn real_backend_errors_do_not_fall_back_or_change_cached_release() {
        let temp = tempfile::tempdir().unwrap();
        let cached = cached_release();
        let state = Arc::new(Mutex::new(Legacy {
            cached: cached.clone(),
            methods: Vec::new(),
            response: Err(RpcError::new("service_busy", "controlled backend refusal")),
        }));
        let (stop, server) = legacy_server(temp.path(), state.clone()).await;
        let error = update_info(&client(temp.path()), false).await.unwrap_err();
        assert!(error.contains("service_busy"));
        let state = state.lock().unwrap();
        assert_eq!(state.cached, cached);
        assert!(!state
            .methods
            .iter()
            .any(|method| method == "store_get" || method == "store_set"));
        drop(state);
        stop.cancel();
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    #[ignore = "explicit live legacy metadata verification; writes only the release-info cache"]
    async fn live_legacy_update_metadata_and_runtime_detection_keep_service_identity() {
        let data = std::env::var_os("STRATA_METADATA_READONLY_DATA_DIR")
            .map(std::path::PathBuf::from)
            .expect("set the explicit existing supervisor data directory");
        assert!(data.is_absolute());
        let before = strata_local_ipc::call(&data, "hello", json!({}))
            .await
            .unwrap();
        assert!(
            before["activeServices"]
                .as_u64()
                .is_some_and(|count| count > 0),
            "Run this acceptance only while the existing background has an active service"
        );
        // Reuse the verified running package as the package identity, so this
        // test never stages a new supervisor or attempts package replacement.
        let executable = std::path::PathBuf::from(
            before["executablePath"]
                .as_str()
                .expect("existing supervisor package path"),
        );
        let hash = format!(
            "{:x}",
            sha2::Sha256::digest(std::fs::read(&executable).unwrap())
        );
        assert_eq!(before["executableHash"], hash);
        assert_eq!(before["version"], env!("CARGO_PKG_VERSION"));
        if let Some(override_path) = std::env::var_os("STRATA_MANAGER_SUPERVISOR") {
            assert_eq!(
                dunce::canonicalize(override_path).unwrap(),
                dunce::canonicalize(&executable).unwrap(),
                "Remove a development package override before this live read-only acceptance"
            );
        }
        let client = SupervisorClient::new(data.clone(), executable.parent().unwrap().into());
        let unsupported =
            strata_local_ipc::call(&data, "runtime_update_info", json!({"force": false}))
                .await
                .expect_err(
                    "This acceptance specifically targets the legacy unknown_method response",
                );
        assert_eq!(unsupported.code, "unknown_method");
        let release = update_info(&client, false).await.unwrap();
        assert!(
            release["error"].is_null(),
            "Metadata check failed: {}",
            release["error"]
        );
        assert!(release["latestVersion"].is_string());
        assert!(release["notes"].is_string());
        let installation = crate::runtime_detection::installation_status(&client)
            .await
            .unwrap();
        assert!(installation["detectedRuntimes"]
            .as_array()
            .is_some_and(|runtimes| !runtimes.is_empty()));
        let models = crate::runtime_detection::local_models(&client, None)
            .await
            .unwrap();
        let running = models
            .as_array()
            .unwrap()
            .iter()
            .find(|model| model["running"].as_bool() == Some(true))
            .expect("native discovery must identify the already running service");
        assert!(running["pid"].as_u64().is_some_and(|pid| pid > 0));
        assert!(running["detectedPort"]
            .as_u64()
            .is_some_and(|port| port > 0));
        assert!(std::path::Path::new(running["configPath"].as_str().unwrap()).is_file());
        println!(
            "Native discovery: runtime {}, config {}, API port {}, process {}",
            running["installDir"], running["configPath"], running["detectedPort"], running["pid"]
        );
        let after = strata_local_ipc::call(&data, "hello", json!({}))
            .await
            .unwrap();
        for key in ["pid", "executableHash", "activeServices"] {
            assert_eq!(after[key], before[key], "Changed live background {key}");
        }
        println!("Legacy release metadata and runtime detection passed; supervisor PID {}, {} active service(s), release {}",
            after["pid"], after["activeServices"], release["latestVersion"]);
    }
}
