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

/// Copies only the complete editor draft. Registration and service startup remain explicit actions.
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

pub fn archive(profile: &ServiceProfile, data_dir: &Path) -> Result<ArchivedConfiguration, String> {
    let original = configuration_path(profile)?;
    let trash = data_dir.join("config-trash");
    if !data_dir.is_absolute() || trash.is_symlink() || (trash.exists() && !trash.is_dir()) {
        return Err("配置归档目录无效 / Invalid configuration archive directory".into());
    }
    fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let archived = trash.join(format!("{}.json", uuid::Uuid::new_v4()));
    move_file(&original, &archived)?;
    Ok(ArchivedConfiguration { original, archived })
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
}
