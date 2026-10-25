use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use strata_runtime_core::{storage, types::ServiceProfile};

pub static OPERATIONS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn safe_filename(filename: &str) -> Result<&str, String> {
    if filename != filename.trim()
        || filename.len() > 200
        || !filename.ends_with(".json")
        || filename
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
    {
        return Err("请输入单个安全的 .json 文件名 / Enter one safe .json filename".into());
    }
    let stem = filename.strip_suffix(".json").unwrap();
    let device = stem
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            device.strip_prefix(prefix).is_some_and(|number| {
                number.len() == 1 && matches!(number.as_bytes()[0], b'1'..=b'9')
            })
        });
    if stem.is_empty() || stem == "." || stem == ".." || stem.ends_with(['.', ' ']) || reserved {
        return Err(
            "配置文件名无效或为系统保留名称 / Invalid or reserved configuration filename".into(),
        );
    }
    Ok(stem)
}

pub fn configuration_path(profile: &ServiceProfile) -> Result<PathBuf, String> {
    let path = storage::config_path(profile)?;
    let metadata = fs::symlink_metadata(&path)
        .map_err(|e| format!("配置文件不可用 / Configuration unavailable: {e}"))?;
    if !metadata.file_type().is_file() {
        return Err(
            "配置必须是普通 .json 文件 / Configuration must be a regular .json file".into(),
        );
    }
    storage::validate(&storage::read(profile)?)?;
    Ok(path)
}

pub fn path_key(path: &Path) -> String {
    let resolved = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let text = resolved.to_string_lossy().into_owned();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

fn write_new(path: &Path, contents: &[u8]) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| {
            format!("新配置不能覆盖已有文件 / Cannot overwrite an existing configuration: {e}")
        })?;
    if let Err(error) = file.write_all(contents).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(format!(
            "配置写入失败 / Configuration write failed: {error}"
        ));
    }
    Ok(())
}

/// Copies only the complete editor draft into a new file. The command registers the copy
/// when its source is registered; service startup always remains an explicit action.
pub fn copy(
    profile: &ServiceProfile,
    filename: &str,
    mut config: Value,
) -> Result<ServiceProfile, String> {
    let stem = safe_filename(filename)?;
    storage::validate(&config)?;
    let source = configuration_path(profile)?;
    let installation = Path::new(&profile.install_dir);
    if !installation.is_absolute() || !installation.is_dir() {
        return Err("安装工作目录必须是已有绝对目录 / Installation working directory must be an existing absolute directory".into());
    }
    if config
        .get("cwd")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        config["cwd"] = Value::String(installation.to_string_lossy().into_owned());
    }
    storage::validate(&config)?;
    let contents = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
    if contents.len() > 4 * 1024 * 1024 {
        return Err("配置文件超过 4 MB / Configuration exceeds 4 MB".into());
    }
    let destination = source.parent().ok_or("配置文件缺少父目录")?.join(filename);
    let mut result = profile.clone();
    result.id = format!("configuration-{}", uuid::Uuid::new_v4());
    result.name = stem.to_owned();
    result.config_path = destination.to_string_lossy().into_owned();
    result.managed = false;
    storage::config_path(&result)?;
    write_new(&destination, &contents)?;
    Ok(result)
}

pub struct ArchivedConfiguration {
    pub original: PathBuf,
    pub archived: PathBuf,
}

impl ArchivedConfiguration {
    pub fn rollback(&self) -> Result<(), String> {
        if self.original.exists() || self.original.is_symlink() {
            return Err(format!(
                "原路径已存在，归档保留 / Original path now exists; archive retained: {}",
                self.archived.display()
            ));
        }
        move_file(&self.archived, &self.original)
    }
}

fn move_file(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() || destination.is_symlink() {
        return Err("归档目标已存在 / Archive destination already exists".into());
    }
    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::CrossesDevices => {
            // Configuration files are bounded JSON; this also supports another drive.
            let contents = fs::read(source).map_err(|e| e.to_string())?;
            write_new(destination, &contents)?;
            if let Err(error) = fs::remove_file(source) {
                let _ = fs::remove_file(destination);
                return Err(format!(
                    "归档移动失败，原配置保留 / Archive move failed; original retained: {error}"
                ));
            }
            Ok(())
        }
        Err(error) => Err(format!("归档移动失败 / Archive move failed: {error}")),
    }
}

#[cfg(test)]
pub fn archive(profile: &ServiceProfile, data_dir: &Path) -> Result<ArchivedConfiguration, String> {
    archive_path(&configuration_path(profile)?, data_dir)
}

/// What deleting one configuration must remove so that a rescan cannot list it again.
pub struct DeletionPlan {
    /// Existing files to archive. A file that is already gone is not listed.
    pub files: Vec<PathBuf>,
    /// Registrations whose private copy or original is among the deleted paths.
    pub registrations: Vec<ServiceProfile>,
}

/// A registered setup or discovered configuration is an app-private copy under
/// `imports/<id>/config.json`; its original stays in the Strata directory and is
/// rediscovered on every scan. Deleting either side removes both, and a side that
/// is already missing (for example deleted by hand with the model folder) only
/// needs its registration removed.
pub fn deletion_plan(
    profile: &ServiceProfile,
    registered: &[ServiceProfile],
    data_dir: &Path,
) -> Result<DeletionPlan, String> {
    let requested = path_key(Path::new(&profile.config_path));
    if registered
        .iter()
        .any(|item| item.id == profile.id && path_key(Path::new(&item.config_path)) != requested)
    {
        return Err("登记配置路径已变化，请刷新后重试 / Registered configuration path changed; refresh and try again".into());
    }
    let sources: Vec<(&ServiceProfile, Option<String>)> = registered
        .iter()
        .map(|item| {
            (
                item,
                crate::configuration_details::source_path(item, data_dir),
            )
        })
        .collect();
    let mut paths: Vec<(String, PathBuf)> = vec![(requested, PathBuf::from(&profile.config_path))];
    let mut registrations: Vec<ServiceProfile> = Vec::new();
    loop {
        let before = registrations.len();
        for (item, original) in &sources {
            if registrations.iter().any(|selected| selected.id == item.id) {
                continue;
            }
            let own = path_key(Path::new(&item.config_path));
            let source = original.as_deref().map(|path| path_key(Path::new(path)));
            if !paths
                .iter()
                .any(|(key, _)| *key == own || Some(key) == source.as_ref())
            {
                continue;
            }
            registrations.push((*item).clone());
            let linked = std::iter::once((own, &item.config_path))
                .chain(source.into_iter().zip(original.iter()));
            for (key, path) in linked {
                if !paths.iter().any(|(known, _)| *known == key) {
                    paths.push((key, PathBuf::from(path)));
                }
            }
        }
        if registrations.len() == before {
            break;
        }
    }
    let mut shared: Vec<_> = registrations
        .iter()
        .map(|item| path_key(Path::new(&item.config_path)))
        .collect();
    shared.sort();
    if shared.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err("多个登记共用此配置文件，无法原子移除，请先整理重复登记 / Multiple registrations share this configuration; consolidate them before deleting".into());
    }
    if registrations.is_empty() {
        // An unregistered path comes from the webview, so it must still be a
        // readable Strata configuration before anything is moved.
        return Ok(DeletionPlan {
            files: vec![configuration_path(profile)?],
            registrations,
        });
    }
    let mut files = Vec::new();
    for (_, path) in paths {
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "配置文件不可用 / Configuration unavailable: {}: {error}",
                    path.display()
                ))
            }
            Ok(metadata) if !metadata.file_type().is_file() => {
                return Err(format!(
                    "配置必须是普通 .json 文件 / Configuration must be a regular .json file: {}",
                    path.display()
                ))
            }
            Ok(_) => files.push(path),
        }
    }
    Ok(DeletionPlan {
        files,
        registrations,
    })
}

/// Archive every planned file, restoring the ones already moved if a later one fails.
pub fn archive_all(
    files: &[PathBuf],
    data_dir: &Path,
) -> Result<Vec<ArchivedConfiguration>, String> {
    let mut archived = Vec::new();
    for file in files {
        match archive_path(file, data_dir) {
            Ok(item) => archived.push(item),
            Err(error) => {
                return Err(match rollback_all(&archived) {
                    Ok(()) => error,
                    Err(rollback) => format!("{error}; {rollback}"),
                })
            }
        }
    }
    Ok(archived)
}

pub fn rollback_all(archived: &[ArchivedConfiguration]) -> Result<(), String> {
    let errors: Vec<_> = archived
        .iter()
        .rev()
        .filter_map(|item| item.rollback().err())
        .collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn archive_path(original: &Path, data_dir: &Path) -> Result<ArchivedConfiguration, String> {
    let metadata = fs::symlink_metadata(original)
        .map_err(|e| format!("配置文件不可用 / Configuration unavailable: {e}"))?;
    if !original.is_absolute()
        || !metadata.file_type().is_file()
        || original.extension().and_then(|x| x.to_str()) != Some("json")
    {
        return Err(
            "配置必须是普通 .json 文件 / Configuration must be a regular .json file".into(),
        );
    }
    let original = original.to_path_buf();
    let trash = data_dir.join("config-trash");
    if !data_dir.is_absolute() || trash.is_symlink() || (trash.exists() && !trash.is_dir()) {
        return Err("配置归档目录无效 / Invalid configuration archive directory".into());
    }
    fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let archived = trash.join(format!("{}.json", uuid::Uuid::new_v4()));
    move_file(&original, &archived)?;
    let result = ArchivedConfiguration { original, archived };
    if let Err(error) = record_manifest(&trash, &result) {
        return match result.rollback() {
            Ok(()) => Err(error),
            Err(rollback) => Err(format!("{error}; {rollback}")),
        };
    }
    Ok(result)
}

const MANIFEST: &str = "manifest.json";

/// `config-trash/manifest.json` maps each archived file back to its original
/// path, so a configuration can be restored by hand. Written whole or not at all.
fn record_manifest(trash: &Path, archived: &ArchivedConfiguration) -> Result<(), String> {
    let path = trash.join(MANIFEST);
    let mut entries = match fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.file_type().is_file() || metadata.len() > 8 * 1024 * 1024 => {
            return Err("归档清单无效 / Invalid archive manifest".into())
        }
        Ok(_) => {
            match serde_json::from_slice::<Value>(&fs::read(&path).map_err(|e| e.to_string())?) {
                Ok(Value::Object(object)) => object
                    .get("entries")
                    .and_then(Value::as_array)
                    .cloned()
                    .ok_or("归档清单无效 / Invalid archive manifest")?,
                _ => return Err("归档清单无效 / Invalid archive manifest".into()),
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.to_string()),
    };
    let archived_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.as_millis() as u64)
        .unwrap_or_default();
    entries.push(serde_json::json!({
        "archived": archived.archived.file_name().map(|name| name.to_string_lossy().into_owned()),
        "originalPath": archived.original.to_string_lossy(),
        "archivedAt": archived_at,
    }));
    let contents =
        serde_json::to_vec_pretty(&serde_json::json!({"schemaVersion": 1, "entries": entries}))
            .map_err(|e| e.to_string())?;
    let temporary = trash.join(format!("{MANIFEST}.{}.tmp", uuid::Uuid::new_v4()));
    write_new(&temporary, &contents)?;
    fs::rename(&temporary, &path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("归档清单写入失败 / Archive manifest write failed: {error}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(root: &Path) -> ServiceProfile {
        let file = root.join("config.json");
        fs::write(&file, "{\"args\":[\"--native\",\"model.gguf\"]}").unwrap();
        ServiceProfile {
            id: "existing".into(),
            name: "Existing".into(),
            base_url: "http://127.0.0.1:18081".into(),
            install_dir: root.to_string_lossy().into(),
            python_path: "python".into(),
            config_path: file.to_string_lossy().into(),
            managed: true,
        }
    }

    #[test]
    fn copy_preserves_editor_draft_and_original_and_sets_default_cwd() {
        let temp = tempfile::tempdir().unwrap();
        let source = fixture(temp.path());
        let original = fs::read(&source.config_path).unwrap();
        let draft = json!({"args":["--native", "draft.gguf"],"custom":{"value":1}});
        let cloned = copy(&source, "新配置.json", draft).unwrap();
        assert_ne!(source.id, cloned.id);
        assert_eq!(cloned.name, "新配置");
        assert!(!cloned.managed);
        assert_eq!(cloned.base_url, source.base_url);
        let saved = storage::read(&cloned).unwrap();
        assert_eq!(saved["args"][1], "draft.gguf");
        assert_eq!(saved["custom"]["value"], 1);
        assert_eq!(saved["cwd"], source.install_dir);
        assert_eq!(fs::read(&source.config_path).unwrap(), original);
        assert!(copy(&source, "新配置.json", json!({})).is_err());
        assert_eq!(storage::read(&cloned).unwrap(), saved);
    }

    #[test]
    fn relative_cwd_and_asset_paths_are_unchanged() {
        let temp = tempfile::tempdir().unwrap();
        let source = fixture(temp.path());
        let draft = json!({"cwd":"runtime", "args":["--native", "../model.gguf"],"vision":{"mmproj":"projector.gguf"}});
        let cloned = copy(&source, "relative.json", draft.clone()).unwrap();
        assert_eq!(storage::read(&cloned).unwrap(), draft);
    }

    #[test]
    fn unsafe_names_and_invalid_json_cannot_create_files() {
        let temp = tempfile::tempdir().unwrap();
        let source = fixture(temp.path());
        for name in [
            "",
            "../copy.json",
            "a/b.json",
            "a\\b.json",
            "C:copy.json",
            "config.json ",
            " copy.json",
            ".json",
            "CON.json",
            "nul.extra.json",
            "COM1.json",
            "a?.json",
            "copy.txt",
            "..json",
        ] {
            assert!(copy(&source, name, json!({})).is_err(), "{name}");
        }
        for draft in [
            json!(null),
            json!([]),
            json!({"args":1}),
            json!({"cwd":null}),
        ] {
            assert!(copy(&source, "invalid.json", draft).is_err());
        }
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[test]
    fn archive_keeps_configuration_recoverable_without_touching_weights() {
        let temp = tempfile::tempdir().unwrap();
        let source = fixture(temp.path());
        let contents = fs::read(&source.config_path).unwrap();
        let weight = temp.path().join("model.gguf");
        fs::write(&weight, "weight").unwrap();
        let archived = archive(&source, &temp.path().join("app-data")).unwrap();
        assert!(!Path::new(&source.config_path).exists());
        assert_eq!(fs::read(&archived.archived).unwrap(), contents);
        assert_eq!(fs::read_to_string(&weight).unwrap(), "weight");
        archived.rollback().unwrap();
        assert_eq!(fs::read(&source.config_path).unwrap(), contents);
        assert!(!archived.archived.exists());
    }

    #[test]
    fn archive_rejects_non_config_files_and_rollback_does_not_overwrite() {
        let temp = tempfile::tempdir().unwrap();
        let mut source = fixture(temp.path());
        source.config_path = temp.path().join("model.gguf").to_string_lossy().into();
        fs::write(&source.config_path, "weight").unwrap();
        assert!(archive(&source, temp.path()).is_err());
        source.config_path = temp.path().join("folder.json").to_string_lossy().into();
        fs::create_dir(&source.config_path).unwrap();
        assert!(archive(&source, temp.path()).is_err());
        source.config_path = temp.path().join("invalid.json").to_string_lossy().into();
        fs::write(&source.config_path, "not json").unwrap();
        assert!(archive(&source, temp.path()).is_err());
        source.config_path = temp.path().join("config.json").to_string_lossy().into();
        let archived = archive(&source, temp.path()).unwrap();
        fs::write(&source.config_path, "new file").unwrap();
        assert!(archived.rollback().is_err());
        assert_eq!(fs::read_to_string(&source.config_path).unwrap(), "new file");
        assert!(archived.archived.is_file());
    }

    #[test]
    fn archive_records_original_paths_in_the_manifest_and_refuses_a_corrupt_one() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("app-data");
        let first = fixture(temp.path());
        let archived = archive(&first, &data).unwrap();
        let second_dir = temp.path().join("other");
        fs::create_dir_all(&second_dir).unwrap();
        let second = fixture(&second_dir);
        archive(&second, &data).unwrap();
        let manifest: Value =
            serde_json::from_slice(&fs::read(data.join("config-trash/manifest.json")).unwrap())
                .unwrap();
        let entries = manifest["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["originalPath"], first.config_path);
        assert_eq!(
            entries[0]["archived"],
            archived
                .archived
                .file_name()
                .unwrap()
                .to_string_lossy()
                .as_ref()
        );
        assert_eq!(entries[1]["originalPath"], second.config_path);

        fs::write(data.join("config-trash/manifest.json"), b"not json").unwrap();
        let third = fixture(temp.path());
        assert!(archive(&third, &data).is_err());
        assert!(
            Path::new(&third.config_path).is_file(),
            "the original is restored"
        );
    }

    /// A Manager setup output in the Strata directory and its registered private copy.
    fn imported(root: &Path) -> (PathBuf, ServiceProfile, ServiceProfile) {
        let runtime = root.join("Strata");
        let data = root.join("app-data");
        let private = data.join("imports/local-test");
        fs::create_dir_all(&runtime).unwrap();
        fs::create_dir_all(&private).unwrap();
        // The weights this configuration names were deleted by hand.
        let config = json!({"args":["--native","models/deleted-00001-of-00002.gguf"]});
        let original = runtime.join("strata-deleted.json");
        fs::write(&original, config.to_string()).unwrap();
        fs::write(private.join("config.json"), config.to_string()).unwrap();
        fs::write(
            private.join("import.json"),
            json!({"schemaVersion":1,"installDir":runtime,"originalConfigPath":original})
                .to_string(),
        )
        .unwrap();
        let registered = ServiceProfile {
            id: "local-test".into(),
            name: "Deleted".into(),
            base_url: "http://127.0.0.1:18081".into(),
            install_dir: runtime.to_string_lossy().into(),
            python_path: "python".into(),
            config_path: private.join("config.json").to_string_lossy().into(),
            managed: true,
        };
        let candidate = ServiceProfile {
            id: "configuration-candidate".into(),
            config_path: original.to_string_lossy().into(),
            managed: false,
            ..registered.clone()
        };
        (data, registered, candidate)
    }

    fn keys(files: &[PathBuf]) -> Vec<String> {
        let mut keys: Vec<_> = files.iter().map(|file| path_key(file)).collect();
        keys.sort();
        keys
    }

    #[test]
    fn deleting_a_registered_copy_also_archives_the_original_rescanned_from_strata() {
        let temp = tempfile::tempdir().unwrap();
        let (data, registered, candidate) = imported(temp.path());
        let both = keys(&[
            PathBuf::from(&registered.config_path),
            PathBuf::from(&candidate.config_path),
        ]);
        let plan = deletion_plan(&registered, std::slice::from_ref(&registered), &data).unwrap();
        assert_eq!(keys(&plan.files), both);
        assert_eq!(plan.registrations.len(), 1);
        // Selecting the rediscovered original removes the registration with it.
        let plan = deletion_plan(&candidate, std::slice::from_ref(&registered), &data).unwrap();
        assert_eq!(keys(&plan.files), both);
        assert_eq!(plan.registrations[0].id, registered.id);

        let archived = archive_all(&plan.files, &data).unwrap();
        assert!(!Path::new(&candidate.config_path).exists());
        assert!(!Path::new(&registered.config_path).exists());
        rollback_all(&archived).unwrap();
        assert!(Path::new(&candidate.config_path).is_file());
        assert!(Path::new(&registered.config_path).is_file());
    }

    #[test]
    fn a_registration_whose_files_were_deleted_by_hand_can_still_be_removed() {
        let temp = tempfile::tempdir().unwrap();
        let (data, registered, candidate) = imported(temp.path());
        fs::remove_file(&registered.config_path).unwrap();
        let plan = deletion_plan(&registered, std::slice::from_ref(&registered), &data).unwrap();
        assert_eq!(
            keys(&plan.files),
            keys(&[PathBuf::from(&candidate.config_path)])
        );
        assert_eq!(plan.registrations.len(), 1);
        fs::remove_file(&candidate.config_path).unwrap();
        let plan = deletion_plan(&registered, std::slice::from_ref(&registered), &data).unwrap();
        assert!(plan.files.is_empty());
        assert_eq!(plan.registrations[0].id, registered.id);
        // Corrupt JSON in a registered file does not block its removal either.
        fs::write(&registered.config_path, "not json").unwrap();
        let plan = deletion_plan(&registered, std::slice::from_ref(&registered), &data).unwrap();
        assert_eq!(plan.files.len(), 1);
    }

    #[test]
    fn unregistered_paths_must_still_be_valid_configurations() {
        let temp = tempfile::tempdir().unwrap();
        let mut source = fixture(temp.path());
        let data = temp.path().join("app-data");
        let plan = deletion_plan(&source, &[], &data).unwrap();
        assert_eq!(plan.files.len(), 1);
        assert!(plan.registrations.is_empty());
        source.config_path = temp.path().join("gone.json").to_string_lossy().into();
        assert!(deletion_plan(&source, &[], &data).is_err());
        source.config_path = temp.path().join("invalid.json").to_string_lossy().into();
        fs::write(&source.config_path, "not json").unwrap();
        assert!(deletion_plan(&source, &[], &data).is_err());
        let mut moved = fixture(temp.path());
        moved.config_path = source.config_path.clone();
        assert!(deletion_plan(&moved, &[fixture(temp.path())], &data)
            .err()
            .unwrap()
            .contains("changed"));
    }
}
