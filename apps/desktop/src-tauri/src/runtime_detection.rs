//! Read-only discovery also works while a running service keeps an older
//! supervisor alive. A legacy empty installation record is not proof that the
//! computer has no Strata runtime.
use crate::supervisor_client::SupervisorClient;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::OnceLock,
    time::{Duration, Instant},
};
use strata_runtime_core::{discovery::DetectedRuntime, types::ServiceProfile};

type DiscoveryCache = HashMap<PathBuf, (Instant, Vec<DetectedRuntime>)>;
const CACHE_TTL: Duration = Duration::from_secs(10);

fn needs_local_detection(status: &Value) -> Result<bool, String> {
    let object = status.as_object().ok_or("安装状态不是有效对象")?;
    match object.get("detectedRuntimes") {
        None => Ok(true),
        Some(Value::Array(_)) => Ok(false),
        Some(_) => Err("运行环境检测结果格式无效".into()),
    }
}

fn merge_detection(mut status: Value, runtimes: Vec<DetectedRuntime>) -> Result<Value, String> {
    if needs_local_detection(&status)? {
        status["detectedRuntimes"] = serde_json::to_value(runtimes).map_err(|e| e.to_string())?;
    }
    Ok(status)
}

pub async fn installation_status(ipc: &SupervisorClient) -> Result<Value, String> {
    let status = match ipc.request("local_runtime_installation", json!({})).await {
        Ok(status) => status,
        Err(error) if error.code == "unknown_method" => json!({}),
        Err(error) => return Err(error.to_string()),
    };
    if !needs_local_detection(&status)? {
        return Ok(status);
    }

    // Polling and the updater share one probe per data directory. No database,
    // installation, model configuration or service state is changed here.
    static CACHE: OnceLock<tokio::sync::Mutex<DiscoveryCache>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(Default::default).lock().await;
    let directory = ipc.data_dir.clone();
    if let Some((_, runtimes)) = cache
        .get(&directory)
        .filter(|(at, _)| at.elapsed() < CACHE_TTL)
    {
        return merge_detection(status, runtimes.clone());
    }
    let profiles: Vec<ServiceProfile> = serde_json::from_value(
        ipc.request("local_installations", json!({}))
            .await
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let root = directory.clone();
    let runtimes = tokio::task::spawn_blocking(move || {
        strata_runtime_core::discovery::discover_runtimes_for_state(&profiles, &root)
    })
    .await
    .map_err(|e| e.to_string())?;
    cache.retain(|_, (at, _)| at.elapsed() < CACHE_TTL);
    if cache.len() >= 32 {
        if let Some(key) = cache.keys().next().cloned() {
            cache.remove(&key);
        }
    }
    cache.insert(directory, (Instant::now(), runtimes.clone()));
    merge_detection(status, runtimes)
}

/// Discovery is a local observation, so its current parser also works while a
/// running service keeps an older supervisor alive. Import remains an explicit
/// supervisor operation that revalidates any chosen candidate.
pub async fn local_models(
    ipc: &SupervisorClient,
    directories: Option<Vec<String>>,
) -> Result<Value, String> {
    let profiles: Vec<ServiceProfile> = serde_json::from_value(
        ipc.request("local_installations", json!({}))
            .await
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let directories: Vec<PathBuf> = directories
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .collect();
    let candidates = tokio::task::spawn_blocking(move || {
        strata_runtime_core::discovery::discover_local(&directories, &profiles)
    })
    .await
    .map_err(|error| error.to_string())??;
    serde_json::to_value(candidates).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn installed() -> DetectedRuntime {
        DetectedRuntime {
            install_dir: "D:/AI/Strata".into(),
            python_path: "D:/AI/Strata/.venv/Scripts/python.exe".into(),
            runtime_version: Some("0.1.41".into()),
            release_version: Some("0.1.41".into()),
            source_revision: None,
            readiness: "ready".into(),
            reason: None,
            profile: ServiceProfile {
                id: "detected".into(),
                name: "Strata".into(),
                base_url: "http://127.0.0.1:18081".into(),
                install_dir: "D:/AI/Strata".into(),
                python_path: "D:/AI/Strata/.venv/Scripts/python.exe".into(),
                config_path: String::new(),
                managed: true,
            },
        }
    }

    #[test]
    fn legacy_installation_status_detects_existing_runtime_without_losing_task_state() {
        let status = json!({"taskId":"previous-task","result":{"installationId":"saved-runtime"}});
        let merged = merge_detection(status.clone(), vec![installed()]).unwrap();
        assert_eq!(merged["taskId"], status["taskId"]);
        assert_eq!(merged["result"], status["result"]);
        assert_eq!(merged["detectedRuntimes"][0]["readiness"], "ready");
        assert_eq!(merged["detectedRuntimes"][0]["installDir"], "D:/AI/Strata");
        assert!(needs_local_detection(&json!({})).unwrap());
    }

    #[test]
    fn current_supervisor_detection_is_authoritative_even_when_empty() {
        let reported = json!({"detectedRuntimes":[]});
        assert_eq!(
            merge_detection(reported.clone(), vec![installed()]).unwrap(),
            reported
        );
    }

    #[test]
    fn malformed_status_is_reported_instead_of_showing_installation_guide() {
        assert!(needs_local_detection(&Value::Null).is_err());
        assert!(merge_detection(json!({"detectedRuntimes":"invalid"}), vec![]).is_err());
    }
}
