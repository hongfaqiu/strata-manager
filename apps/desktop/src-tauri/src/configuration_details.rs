//! Read-only compatibility metadata for supervisors predating configuration details.
use crate::supervisor_client::SupervisorClient;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use strata_runtime_core::types::ServiceProfile;

pub(crate) fn source_path(profile: &ServiceProfile, data_dir: &Path) -> Option<String> {
    let imports = dunce::canonicalize(data_dir.join("imports")).ok()?;
    // The private copy itself may already be gone; its import manifest still names the original.
    let config = Path::new(&profile.config_path);
    let config = dunce::canonicalize(config.parent()?)
        .ok()?
        .join(config.file_name()?);
    if !config.starts_with(&imports) || config.file_name()? != "config.json" {
        return None;
    }
    let manifest_path = config.parent()?.join("import.json");
    if std::fs::metadata(&manifest_path).ok()?.len() > 65536 {
        return None;
    }
    let manifest: Value = serde_json::from_slice(&std::fs::read(manifest_path).ok()?).ok()?;
    if manifest["schemaVersion"].as_u64()? != 1 {
        return None;
    }
    let installation = PathBuf::from(manifest["installDir"].as_str()?);
    if dunce::canonicalize(installation).ok()? != dunce::canonicalize(&profile.install_dir).ok()? {
        return None;
    }
    let original = manifest["originalConfigPath"].as_str()?;
    if !Path::new(original).is_absolute() {
        return None;
    }
    Some(original.to_owned())
}

pub async fn legacy_details(ipc: &SupervisorClient) -> Result<Value, String> {
    let profiles: Vec<ServiceProfile> = serde_json::from_value(
        ipc.request("local_installations", json!({}))
            .await
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let mut details = Vec::new();
    for profile in profiles {
        let config = ipc
            .request("read_config", json!({"profile":profile}))
            .await
            .ok()
            .map(|value| strata_runtime_core::discovery::display_config(&value));
        let modified = std::fs::metadata(&profile.config_path)
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|time| time.as_millis() as u64);
        details.push(json!({"profileId":profile.id,"originalConfigPath":source_path(&profile, &ipc.data_dir),"configModifiedAt":modified,"config":config}));
    }
    Ok(Value::Array(details))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manifest_must_belong_to_the_registered_private_copy_and_runtime() {
        let root = tempfile::tempdir().unwrap();
        let runtime = root.path().join("runtime");
        let imported = root.path().join("imports/local-test");
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::create_dir_all(&imported).unwrap();
        std::fs::write(imported.join("config.json"), "{}").unwrap();
        let original = runtime.join("original.json").to_string_lossy().into_owned();
        let profile = ServiceProfile {
            id: "local-test".into(),
            name: "model".into(),
            base_url: "http://127.0.0.1:18081".into(),
            install_dir: runtime.to_string_lossy().into_owned(),
            python_path: "python".into(),
            config_path: imported.join("config.json").to_string_lossy().into_owned(),
            managed: true,
        };
        let manifest =
            json!({"schemaVersion":1,"installDir":runtime,"originalConfigPath":original});
        std::fs::write(imported.join("import.json"), manifest.to_string()).unwrap();
        assert_eq!(source_path(&profile, root.path()), Some(original));
        let invalid = json!({"schemaVersion":1,"installDir":root.path(),"originalConfigPath":runtime.join("other.json")});
        std::fs::write(imported.join("import.json"), invalid.to_string()).unwrap();
        assert_eq!(source_path(&profile, root.path()), None);
        std::fs::write(runtime.join("config.json"), "{}").unwrap();
        assert_eq!(
            source_path(
                &ServiceProfile {
                    config_path: runtime.join("config.json").to_string_lossy().into_owned(),
                    ..profile
                },
                root.path()
            ),
            None
        );
    }

    #[tokio::test]
    #[ignore = "explicit read-only acceptance against the user's running supervisor"]
    async fn live_configuration_match_preserves_the_existing_owned_model() {
        let data = PathBuf::from(
            std::env::var_os("STRATA_METADATA_READONLY_DATA_DIR")
                .expect("explicit production data directory"),
        );
        let before = strata_local_ipc::call(&data, "hello", json!({}))
            .await
            .unwrap();
        assert!(before["activeServices"]
            .as_u64()
            .is_some_and(|count| count > 0));
        let executable = PathBuf::from(before["executablePath"].as_str().unwrap());
        let ipc = SupervisorClient::new(data.clone(), executable.parent().unwrap().into());
        let profiles: Vec<ServiceProfile> =
            serde_json::from_value(ipc.request("local_installations", json!({})).await.unwrap())
                .unwrap();
        let details = legacy_details(&ipc).await.unwrap();
        let current = profiles
            .iter()
            .find(|profile| profile.id == "local-5dde60ed2cf08e04")
            .unwrap();
        let status_before = ipc
            .request(
                "service_status",
                json!({"profileId":current.id,"profile":current}),
            )
            .await
            .unwrap();
        assert_eq!(status_before["owned"], true);
        assert_eq!(status_before["running"], true);
        let detail = details
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["profileId"] == current.id)
            .unwrap();
        assert_eq!(
            detail["originalConfigPath"],
            "D:\\AI\\Strata\\strata-gsq-iq3s-131072.json"
        );
        assert!(detail["config"]["args"].is_array());
        assert!(detail["config"]["host"].is_string());
        assert!(detail["config"]["log"].is_string());
        let after = strata_local_ipc::call(&data, "hello", json!({}))
            .await
            .unwrap();
        let status_after = ipc
            .request(
                "service_status",
                json!({"profileId":current.id,"profile":current}),
            )
            .await
            .unwrap();
        for key in ["pid", "executableHash", "activeServices"] {
            assert_eq!(after[key], before[key]);
        }
        for key in ["pid", "startedAt", "owned", "running"] {
            assert_eq!(status_after[key], status_before[key]);
        }
        println!(
            "Verified owned running profile {} using {}",
            current.id, detail["originalConfigPath"]
        );
    }
}
