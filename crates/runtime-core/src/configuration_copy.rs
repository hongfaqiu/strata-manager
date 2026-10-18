//! Registration of a configuration copied next to an already registered one.
//!
//! The desktop writes the copy itself (never overwriting a file). This module
//! only decides whether that new file may join the registry as its own
//! configuration: same installation and directory as the registered source,
//! a regular, valid JSON file, and no existing registration for its id or path.
use crate::{network, storage, types::ServiceProfile};
use std::{fs, path::Path};

fn canonical(path: &Path) -> Result<std::path::PathBuf, String> {
    dunce::canonicalize(path)
        .map_err(|e| format!("配置文件不可用 / Configuration unavailable: {e}"))
}

/// Returns the profile to store for `copy`, derived from the registered `source`.
/// Nothing is written; the caller stores the result in one transaction.
pub fn prepare(
    source: &ServiceProfile,
    copy: ServiceProfile,
    registered: &[ServiceProfile],
) -> Result<ServiceProfile, String> {
    if !copy.id.starts_with("configuration-")
        || copy.id.len() > 80
        || !copy
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("新配置标识无效 / Invalid configuration identifier".into());
    }
    let name = copy.name.trim().to_owned();
    if name.is_empty() || name.chars().count() > 100 {
        return Err("名称需要 1–100 个字符 / Name must be 1–100 characters".into());
    }
    if copy.install_dir != source.install_dir || copy.python_path != source.python_path {
        return Err(
            "副本必须沿用原配置的运行环境 / The copy must keep the source installation".into(),
        );
    }
    let source_path = canonical(&storage::config_path(source)?)?;
    let copy_path = storage::config_path(&copy)?;
    let metadata = fs::symlink_metadata(&copy_path)
        .map_err(|e| format!("配置文件不可用 / Configuration unavailable: {e}"))?;
    if !metadata.file_type().is_file() {
        return Err(
            "配置必须是普通 .json 文件 / Configuration must be a regular .json file".into(),
        );
    }
    let copy_path = canonical(&copy_path)?;
    if copy_path == source_path || copy_path.parent() != source_path.parent() {
        return Err("副本必须是原配置同目录下的新文件 / The copy must be a new file next to the source configuration".into());
    }
    for item in registered {
        if item.id == copy.id {
            return Err("配置标识已被登记 / Configuration identifier is already registered".into());
        }
        if dunce::canonicalize(&item.config_path).ok().as_ref() == Some(&copy_path) {
            return Err("此配置文件已登记 / This configuration file is already registered".into());
        }
    }
    let config = storage::read(&copy)?;
    storage::validate(&config)?;
    let mut profile = copy;
    profile.name = name;
    profile.config_path = copy_path.to_string_lossy().into_owned();
    // The copy is managed exactly like its source; only its own file decides the endpoint.
    profile.managed = source.managed;
    profile.base_url = network::endpoint(&config, &profile)?.base_url;
    Ok(profile)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(root: &Path) -> (ServiceProfile, ServiceProfile) {
        let directory = root.join("imports/local-test");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("config.json"),
            r#"{"port":18101,"args":["--native","model.gguf"]}"#,
        )
        .unwrap();
        fs::write(
            directory.join("config-copy.json"),
            r#"{"port":18102,"args":["--native","model.gguf"]}"#,
        )
        .unwrap();
        let source = ServiceProfile {
            id: "local-test".into(),
            name: "Source".into(),
            base_url: "http://127.0.0.1:18101".into(),
            install_dir: root.to_string_lossy().into(),
            python_path: "python".into(),
            config_path: directory.join("config.json").to_string_lossy().into(),
            managed: true,
        };
        let mut copy = source.clone();
        copy.id = "configuration-0b6b2a58-6f3f-4a6e-9a43-6b5c1f1f6c11".into();
        copy.name = "config-copy".into();
        copy.config_path = directory.join("config-copy.json").to_string_lossy().into();
        copy.managed = false;
        (source, copy)
    }

    #[test]
    fn copy_next_to_a_registered_configuration_is_managed_with_its_own_endpoint() {
        let temp = tempfile::tempdir().unwrap();
        let (source, copy) = fixture(temp.path());
        let profile = prepare(&source, copy.clone(), std::slice::from_ref(&source)).unwrap();
        assert!(profile.managed);
        assert_eq!(profile.id, copy.id);
        assert_eq!(profile.name, "config-copy");
        assert_eq!(profile.base_url, "http://127.0.0.1:18102");
        assert_eq!(profile.install_dir, source.install_dir);
    }

    #[test]
    fn duplicate_foreign_or_unsafe_copies_are_refused() {
        let temp = tempfile::tempdir().unwrap();
        let (source, copy) = fixture(temp.path());
        // Already registered by id or by path.
        assert!(prepare(&source, copy.clone(), &[source.clone(), copy.clone()]).is_err());
        let mut same_path = copy.clone();
        same_path.id = "configuration-other".into();
        assert!(prepare(&source, copy.clone(), &[source.clone(), same_path]).is_err());
        // The source itself, another directory, or a missing file.
        let mut itself = copy.clone();
        itself.config_path = source.config_path.clone();
        assert!(prepare(&source, itself, std::slice::from_ref(&source)).is_err());
        let elsewhere = temp.path().join("elsewhere.json");
        fs::write(&elsewhere, "{}").unwrap();
        let mut moved = copy.clone();
        moved.config_path = elsewhere.to_string_lossy().into();
        assert!(prepare(&source, moved, std::slice::from_ref(&source)).is_err());
        let mut missing = copy.clone();
        missing.config_path = temp
            .path()
            .join("imports/local-test/missing.json")
            .to_string_lossy()
            .into();
        assert!(prepare(&source, missing, std::slice::from_ref(&source)).is_err());
        // Identifier, name and installation are not caller-controlled.
        for mutate in [
            (|p: &mut ServiceProfile| p.id = "local-test".into()) as fn(&mut ServiceProfile),
            |p| p.id = "configuration-../x".into(),
            |p| p.name = "  ".into(),
            |p| p.install_dir = "/other".into(),
            |p| p.python_path = "/other/python".into(),
        ] {
            let mut changed = copy.clone();
            mutate(&mut changed);
            assert!(prepare(&source, changed, std::slice::from_ref(&source)).is_err());
        }
        // Invalid JSON content is never registered.
        fs::write(&copy.config_path, "[]").unwrap();
        assert!(prepare(&source, copy, std::slice::from_ref(&source)).is_err());
    }

    #[tokio::test]
    async fn dispatch_registers_the_copy_without_starting_it() {
        let temp = tempfile::tempdir().unwrap();
        let (source, copy) = fixture(temp.path());
        let state = crate::RuntimeState::open(temp.path().join("state")).unwrap();
        state.database.lock().unwrap().execute(
            "INSERT INTO local_installations(id,profile,original_profile,imported_at) VALUES(?1,?2,?2,0)",
            rusqlite::params![source.id, serde_json::to_string(&source).unwrap()],
        ).unwrap();
        let params = serde_json::json!({"sourceProfileId": source.id, "profile": copy});
        let registered: ServiceProfile = serde_json::from_value(
            state
                .clone()
                .dispatch("register_configuration_copy", params.clone())
                .await
                .unwrap(),
        )
        .unwrap();
        assert!(registered.managed);
        let profiles = state.registered_profiles().unwrap();
        assert_eq!(profiles.len(), 2);
        assert!(profiles.iter().any(|p| p.id == registered.id));
        assert!(state.processes.lock().unwrap().is_empty());
        // A second registration of the same copy never replaces the first.
        assert!(state
            .clone()
            .dispatch("register_configuration_copy", params)
            .await
            .is_err());
        // An unregistered source cannot vouch for a copy.
        let mut other = registered.clone();
        other.id = "configuration-other".into();
        assert!(state
            .clone()
            .dispatch(
                "register_configuration_copy",
                serde_json::json!({"sourceProfileId": "missing", "profile": other})
            )
            .await
            .is_err());
        assert_eq!(state.registered_profiles().unwrap().len(), 2);
    }
}
