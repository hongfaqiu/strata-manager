use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
};
use strata_runtime_core::types::ServiceProfile;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelDeletionFile {
    pub path: String,
    pub size_bytes: u64,
    pub modified_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDeletionPlan {
    pub files: Vec<ModelDeletionFile>,
    pub total_bytes: u64,
    pub blocked_reason: Option<String>,
}

impl ModelDeletionPlan {
    pub fn blocked(reason: String) -> Self {
        Self {
            files: vec![],
            total_bytes: 0,
            blocked_reason: Some(reason),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDeletionSummary {
    pub removed_files: Vec<ModelDeletionFile>,
    pub removed_bytes: u64,
}

pub struct Configuration {
    pub profile: ServiceProfile,
    pub config: Value,
}
pub struct PreparedDeletion {
    pub plan: ModelDeletionPlan,
    pub profiles: Vec<ServiceProfile>,
}

pub fn assert_stopped_status(status: &Value) -> Result<(), String> {
    match status["running"].as_bool() {
        Some(false) => Ok(()),
        Some(true) => Err("检测到运行服务，请先停止后再删除 / A running service was detected; stop it before deleting".into()),
        None => Err("无法确认服务已停止 / Cannot confirm that the service is stopped".into()),
    }
}

fn local_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(
            "模型路径必须是绝对本机路径 / Model path must be an absolute local path".into(),
        );
    }
    #[cfg(windows)]
    if !matches!(path.components().next(), Some(std::path::Component::Prefix(prefix))
        if matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)))
    {
        return Err(
            "不支持删除网络共享或设备路径 / Network shares and device paths are unsupported".into(),
        );
    }
    Ok(())
}

fn resolve(configuration: &Configuration, value: &str) -> Result<PathBuf, String> {
    let installation = Path::new(&configuration.profile.install_dir);
    local_path(installation)?;
    let cwd = configuration
        .config
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| installation.to_path_buf());
    let cwd = if cwd.is_absolute() {
        cwd
    } else {
        installation.join(cwd)
    };
    let value = Path::new(value);
    let resolved = if value.is_absolute() {
        value.to_path_buf()
    } else {
        cwd.join(value)
    };
    local_path(&resolved)?;
    Ok(resolved)
}

fn option(config: &Value, flag: &str) -> Result<Option<String>, String> {
    let args = config
        .get("args")
        .and_then(Value::as_array)
        .ok_or("配置缺少 args 数组 / Configuration has no args array")?;
    let mut found = None;
    for (index, argument) in args.iter().enumerate() {
        let Some(argument) = argument.as_str() else {
            return Err("args 必须是字符串数组 / args must be a string array".into());
        };
        let value = if argument == flag {
            args.get(index + 1).and_then(Value::as_str)
        } else {
            argument.strip_prefix(&format!("{flag}="))
        };
        if argument == flag || argument.starts_with(&format!("{flag}=")) {
            if found.is_some() {
                return Err(format!(
                    "{flag} 重复，无法确认主模型 / Duplicate {flag}; primary model is ambiguous"
                ));
            }
            let value = value
                .filter(|value| !value.is_empty() && !value.starts_with('-'))
                .ok_or_else(|| format!("{flag} 缺少有效路径 / {flag} has no valid path"))?;
            found = Some(value.to_owned());
        }
    }
    Ok(found)
}

fn primary(configuration: &Configuration) -> Result<PathBuf, String> {
    for flag in ["--native", "--model", "-m", "--pack"] {
        if let Some(value) = option(&configuration.config, flag)? {
            return resolve(configuration, &value);
        }
    }
    Err(
        "配置未声明可识别的主模型权重 / Configuration has no recognized primary model weights"
            .into(),
    )
}

fn checked_file(path: &Path) -> Result<ModelDeletionFile, String> {
    local_path(path)?;
    if !path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("gguf"))
    {
        return Err("仅支持主 GGUF 权重文件；目录及其他格式不能删除 / Only primary GGUF weight files are supported; directories and other formats are refused".into());
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        format!(
            "模型文件缺失或不可读 / Model file missing or unreadable: {}: {error}",
            path.display()
        )
    })?;
    if !metadata.file_type().is_file() {
        return Err(format!("模型必须是普通文件，不能为目录或符号链接 / Model must be a regular file, not a directory or symlink: {}", path.display()));
    }
    let canonical = dunce::canonicalize(path).map_err(|error| error.to_string())?;
    local_path(&canonical)?;
    let mut header = [0u8; 24];
    fs::File::open(&canonical)
        .and_then(|mut file| file.read_exact(&mut header))
        .map_err(|error| {
            format!(
                "无法核验 GGUF 文件头 / Cannot verify GGUF header: {}: {error}",
                canonical.display()
            )
        })?;
    let version = u32::from_le_bytes(header[4..8].try_into().unwrap());
    let tensors = u64::from_le_bytes(header[8..16].try_into().unwrap());
    if &header[..4] != b"GGUF" || !matches!(version, 2 | 3) || tensors == 0 {
        return Err(format!(
            "文件不是支持的 GGUF 权重 / File is not supported GGUF weights: {}",
            canonical.display()
        ));
    }
    let modified_at = metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis()
        .try_into()
        .map_err(|_| "模型修改时间超出范围 / Model modification time is out of range")?;
    Ok(ModelDeletionFile {
        path: canonical.to_string_lossy().into_owned(),
        size_bytes: metadata.len(),
        modified_at,
    })
}

fn bundle(path: &Path) -> Result<Vec<ModelDeletionFile>, String> {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("模型文件名无效 / Invalid model filename")?;
    let mut paths = Vec::new();
    if let Some((before_count, count)) = stem
        .rsplit_once("-of-")
        .filter(|(_, count)| !count.is_empty() && count.bytes().all(|byte| byte.is_ascii_digit()))
    {
        let (prefix, index) = before_count
            .rsplit_once('-')
            .ok_or("GGUF 分片名称无效 / Invalid GGUF shard name")?;
        let total: usize = count
            .parse()
            .map_err(|_| "GGUF 分片数量无效 / Invalid GGUF shard count")?;
        let index: usize = index
            .parse()
            .map_err(|_| "GGUF 分片序号无效 / Invalid GGUF shard index")?;
        if count.len() != 5
            || before_count.rsplit_once('-').unwrap().1.len() != 5
            || prefix.is_empty()
            || total == 0
            || total > 4096
            || index == 0
            || index > total
        {
            return Err(
                "GGUF 分片名称或数量不受支持 / Unsupported GGUF shard name or count".into(),
            );
        }
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("gguf");
        let parent = path
            .parent()
            .ok_or("模型文件缺少目录 / Model has no parent directory")?;
        for part in 1..=total {
            paths.push(parent.join(format!("{prefix}-{part:05}-of-{total:05}.{extension}")));
        }
    } else {
        paths.push(path.to_path_buf());
    }
    let mut files: Vec<_> = paths
        .iter()
        .map(|path| checked_file(path))
        .collect::<Result<_, _>>()?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn references(configuration: &Configuration) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    for flag in ["--native", "--model", "-m", "--pack", "--ple-gguf", "--mtp"] {
        if let Some(value) = option(&configuration.config, flag)? {
            paths.push(resolve(configuration, &value)?);
        }
    }
    if let Some(vision) = configuration
        .config
        .get("vision")
        .and_then(Value::as_object)
    {
        for key in ["model", "mmproj"] {
            if let Some(value) = vision
                .get(key)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                paths.push(resolve(configuration, value)?);
            }
        }
    }
    Ok(paths)
}

pub fn prepare(
    selected: &[Configuration],
    registered: &[Configuration],
) -> Result<PreparedDeletion, String> {
    if selected.is_empty() || selected.len() > 256 {
        return Err("请选择一组模型配置 / Select one model configuration group".into());
    }
    let files = bundle(&primary(&selected[0])?)?;
    for configuration in selected.iter().skip(1) {
        if bundle(&primary(configuration)?)? != files {
            return Err("所选配置不属于同一主模型权重集合 / Selected configurations do not share one primary model weight set".into());
        }
    }
    let selected_configs: Vec<_> = selected
        .iter()
        .map(|entry| super::configuration_files::path_key(Path::new(&entry.profile.config_path)))
        .collect();
    let file_paths: Vec<_> = files.iter().map(|file| PathBuf::from(&file.path)).collect();
    let file_keys: Vec<_> = file_paths
        .iter()
        .map(|path| super::configuration_files::path_key(path))
        .collect();
    let mut involved = BTreeMap::new();
    for entry in selected {
        involved.insert(entry.profile.id.clone(), entry.profile.clone());
    }
    for entry in registered {
        let referred = references(entry)?.iter().any(|reference| {
            file_keys.contains(&super::configuration_files::path_key(reference))
                || reference.is_dir()
                    && dunce::canonicalize(reference)
                        .ok()
                        .is_some_and(|directory| {
                            file_paths.iter().any(|file| file.starts_with(&directory))
                        })
        });
        if referred {
            if !selected_configs.contains(&super::configuration_files::path_key(Path::new(
                &entry.profile.config_path,
            ))) {
                return Err(format!("另一个未选择的配置仍引用这些权重，请把它加入本组 / Another unselected configuration references these weights; include it in this group: {} ({})", entry.profile.name, entry.profile.config_path));
            }
            involved.insert(entry.profile.id.clone(), entry.profile.clone());
        }
    }
    let total_bytes = files
        .iter()
        .try_fold(0u64, |total, file| total.checked_add(file.size_bytes))
        .ok_or("模型总大小超出范围 / Model total size is out of range")?;
    Ok(PreparedDeletion {
        plan: ModelDeletionPlan {
            files,
            total_bytes,
            blocked_reason: None,
        },
        profiles: involved.into_values().collect(),
    })
}

pub fn verify_expected(
    actual: &[ModelDeletionFile],
    expected: &[ModelDeletionFile],
) -> Result<(), String> {
    let mut expected = expected.to_vec();
    expected.sort_by(|a, b| a.path.cmp(&b.path));
    if actual.is_empty() || expected != actual {
        return Err("模型删除预览已变化，请重新检查并确认 / Model deletion preview changed; check and confirm again".into());
    }
    Ok(())
}

pub fn remove(
    plan: &ModelDeletionPlan,
    expected: &[ModelDeletionFile],
) -> Result<ModelDeletionSummary, String> {
    if let Some(reason) = &plan.blocked_reason {
        return Err(reason.clone());
    }
    verify_expected(&plan.files, expected)?;
    // Check every path, type, header, size and mtime before the first removal.
    let current = plan
        .files
        .iter()
        .map(|file| checked_file(Path::new(&file.path)))
        .collect::<Result<Vec<_>, _>>()?;
    verify_expected(&current, expected)?;
    let mut removed_files: Vec<ModelDeletionFile> = Vec::new();
    let mut removed_bytes = 0;
    for file in current {
        if let Err(error) = fs::remove_file(&file.path) {
            let removed = removed_files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!("删除失败 / Deletion failed: {}: {error}; 已删除 {} 个文件 / removed {} files: [{removed}]", file.path, removed_files.len(), removed_files.len()));
        }
        removed_bytes += file.size_bytes;
        removed_files.push(file);
    }
    Ok(ModelDeletionSummary {
        removed_files,
        removed_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    fn gguf(path: &Path) {
        let mut header = b"GGUF".to_vec();
        header.extend(3u32.to_le_bytes());
        header.extend(1u64.to_le_bytes());
        header.extend(0u64.to_le_bytes());
        fs::write(path, header).unwrap();
    }
    fn configuration(root: &Path, id: &str, model: &str) -> Configuration {
        let config_path = root.join(format!("{id}.json"));
        let config = json!({"args":["--native",model]});
        fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
        Configuration {
            profile: ServiceProfile {
                id: id.into(),
                name: id.into(),
                install_dir: root.to_string_lossy().into(),
                config_path: config_path.to_string_lossy().into(),
                python_path: String::new(),
                base_url: "http://127.0.0.1:18081".into(),
                managed: false,
            },
            config,
        }
    }
    #[test]
    fn candidate_configuration_and_full_shard_bundle_are_planned() {
        let temp = tempfile::tempdir().unwrap();
        for part in 1..=2 {
            gguf(&temp.path().join(format!("weights-{part:05}-of-00002.gguf")));
        }
        let selected = vec![configuration(
            temp.path(),
            "candidate",
            "weights-00002-of-00002.gguf",
        )];
        let prepared = prepare(&selected, &[]).unwrap();
        assert_eq!(prepared.plan.files.len(), 2);
        assert_eq!(prepared.plan.total_bytes, 48);
        assert!(prepared
            .plan
            .files
            .iter()
            .all(|file| Path::new(&file.path).is_absolute()));
        assert!(!selected[0].profile.managed);
    }
    #[test]
    fn missing_shards_and_unknown_formats_are_refused() {
        let temp = tempfile::tempdir().unwrap();
        gguf(&temp.path().join("weights-00001-of-00002.gguf"));
        assert!(prepare(
            &[configuration(
                temp.path(),
                "missing",
                "weights-00001-of-00002.gguf"
            )],
            &[]
        )
        .is_err());
        assert!(temp.path().join("weights-00001-of-00002.gguf").exists());
        fs::create_dir(temp.path().join("native")).unwrap();
        assert!(prepare(&[configuration(temp.path(), "directory", "native")], &[]).is_err());
        fs::write(temp.path().join("fake.gguf"), [0u8; 24]).unwrap();
        assert!(prepare(&[configuration(temp.path(), "fake", "fake.gguf")], &[]).is_err());
    }
    #[test]
    fn shared_main_and_vision_references_require_every_configuration() {
        let temp = tempfile::tempdir().unwrap();
        gguf(&temp.path().join("weights.gguf"));
        gguf(&temp.path().join("other.gguf"));
        let selected = vec![configuration(temp.path(), "chosen", "weights.gguf")];
        let mut registered = vec![configuration(temp.path(), "shared", "weights.gguf")];
        assert!(prepare(&selected, &registered)
            .err()
            .unwrap()
            .contains("shared"));
        registered[0].config =
            json!({"args":["--model","other.gguf"], "vision":{"model":"weights.gguf"}});
        assert!(prepare(&selected, &registered)
            .err()
            .unwrap()
            .contains("shared"));
        let all = vec![
            configuration(temp.path(), "chosen", "weights.gguf"),
            configuration(temp.path(), "shared", "weights.gguf"),
        ];
        registered[0].config = json!({"args":["--native","weights.gguf"]});
        assert!(prepare(&all, &registered).is_ok());
    }
    #[test]
    fn changed_stats_or_traversal_expected_paths_cannot_delete_files() {
        let temp = tempfile::tempdir().unwrap();
        gguf(&temp.path().join("weights.gguf"));
        let selected = vec![configuration(temp.path(), "chosen", "weights.gguf")];
        let prepared = prepare(&selected, &[]).unwrap();
        let mut wrong = prepared.plan.files.clone();
        wrong[0].path = temp
            .path()
            .join("sub/../weights.gguf")
            .to_string_lossy()
            .into();
        assert!(remove(&prepared.plan, &wrong).is_err());
        fs::File::options()
            .write(true)
            .open(temp.path().join("weights.gguf"))
            .unwrap()
            .set_times(
                fs::FileTimes::new()
                    .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(42)),
            )
            .unwrap();
        assert!(remove(&prepared.plan, &prepared.plan.files).is_err());
        let mut wrong = prepared.plan.files.clone();
        wrong[0].modified_at += 1;
        assert!(remove(&prepared.plan, &wrong).is_err());
        fs::OpenOptions::new()
            .append(true)
            .open(temp.path().join("weights.gguf"))
            .unwrap()
            .write_all(b"changed")
            .unwrap();
        assert!(remove(&prepared.plan, &prepared.plan.files).is_err());
        assert!(temp.path().join("weights.gguf").exists());
    }
    #[test]
    fn only_main_weights_are_removed_and_configuration_and_companions_remain() {
        let temp = tempfile::tempdir().unwrap();
        for name in ["weights.gguf", "projector.gguf", "ple.gguf"] {
            gguf(&temp.path().join(name));
        }
        let mut selected = vec![configuration(temp.path(), "chosen", "weights.gguf")];
        selected[0].config = json!({"args":["--native=weights.gguf", "--ple-gguf", "ple.gguf"], "vision":{"mmproj":"projector.gguf"}});
        let prepared = prepare(&selected, &[]).unwrap();
        let removed = remove(&prepared.plan, &prepared.plan.files).unwrap();
        assert_eq!(removed.removed_files.len(), 1);
        assert!(!temp.path().join("weights.gguf").exists());
        for name in ["chosen.json", "projector.gguf", "ple.gguf"] {
            assert!(temp.path().join(name).exists());
        }
    }
    #[test]
    fn relative_cwd_and_other_primary_flags_resolve_against_installation() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("work")).unwrap();
        gguf(&temp.path().join("weights.gguf"));
        for flag in ["--model", "-m", "--pack"] {
            let mut selected = vec![configuration(temp.path(), "chosen", "weights.gguf")];
            selected[0].config = json!({"cwd":"work","args":[flag,"../weights.gguf"]});
            assert!(prepare(&selected, &[]).is_ok());
        }
    }

    #[test]
    fn running_and_unknown_service_statuses_block_deletion() {
        assert!(assert_stopped_status(&json!({"running":false})).is_ok());
        for status in [
            json!({"running":true,"owned":true}),
            json!({"running":true,"owned":false}),
            json!({}),
            json!({"running":null}),
        ] {
            assert!(assert_stopped_status(&status).is_err());
        }
    }
}
