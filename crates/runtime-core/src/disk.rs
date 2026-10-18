//! Read-only preparation-space estimates for the reviewed upstream setup.py.
//! Counts missing files rather than requiring a second copy of existing weights.
use crate::{processes, types::*};
use serde_json::Value;
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

const GB: u64 = 1_000_000_000;
const SOURCE: &str = "Strata 477ac13cbe8e582c20484871ce459d20d82df09d setup.py MODELS + OWN_PATH_FAMILIES (qwen36); decimal GB. Estimates exclude unknown dependency downloads and do not guarantee RAM/VRAM readiness.";

#[derive(Default)]
struct Settings {
    data_dir: Option<PathBuf>,
    installs: Vec<PathBuf>,
    reusable_directory: Option<PathBuf>,
}

pub(crate) struct Plan {
    pub report: SetupDiskPreflight,
    pub data_directory: PathBuf,
    pub gguf_directory: Option<PathBuf>,
}

impl Plan {
    pub fn require_space(&self) -> Result<(), String> {
        match self.report.status.as_str() {
            "ready" => Ok(()),
            "insufficient" => Err(format!("准备目录可用磁盘空间不足，未启动下载或准备任务。{} 请释放空间，或选择/导入位于更大磁盘的 Strata 安装后重试；已有模型文件不会删除。", self.report.reason)),
            _ => Err(format!("无法核验准备目标磁盘，未启动下载或准备任务。{} 请检查目录/磁盘挂载和当前用户权限后重试。", self.report.reason)),
        }
    }
}

fn settings() -> Result<Settings, String> {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from).or_else(|| {
        std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("AppData/Roaming"))
    });
    #[cfg(not(windows))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".config")));
    let Some(base) = base else {
        return Err("无法读取 Strata 用户数据目录设置".into());
    };
    let path = base.join(if cfg!(windows) {
        "Strata/settings.json"
    } else {
        "strata/settings.json"
    });
    let Some(meta) = file_meta(&path)? else {
        return Ok(Settings::default());
    };
    if !meta.is_file() || meta.len() > 1024 * 1024 {
        return Err("Strata settings.json 不是受支持的小型配置文件".into());
    }
    // Upstream treats invalid JSON as empty settings too.
    let value: Value = serde_json::from_slice(
        &fs::read(&path).map_err(|e| format!("无法读取 {}: {e}", path.display()))?,
    )
    .unwrap_or(Value::Null);
    let data_dir = value["data_dir"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let installs = value["installs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .take(20)
        .map(PathBuf::from)
        .collect();
    Ok(Settings {
        data_dir,
        installs,
        reusable_directory: None,
    })
}

fn file_meta(path: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::metadata(path) {
        Ok(meta) => Ok(Some(meta)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取 {}: {error}", path.display())),
    }
}

fn file_len(path: &Path) -> Result<u64, String> {
    Ok(file_meta(path)?
        .filter(fs::Metadata::is_file)
        .map(|m| m.len())
        .unwrap_or(0))
}

fn exists(path: &Path) -> Result<bool, String> {
    Ok(file_meta(path)?.is_some())
}

fn model_spec(family: &str, quant: &str) -> Result<(String, Vec<String>, u64, f64), String> {
    // Qwen3.6 OWN_PATH: single Unsloth MTP GGUF (setup.py QWEN36_FILES / OWN_PATH_FAMILIES).
    if family == "qwen36" {
        let (download, arena) = match quant {
            "UD-Q4_K_XL" => (22_853_663_008_u64, 22.9),
            "UD-Q6_K_XL" => (32_611_711_264, 32.6),
            "Q8_0" => (37_801_097_504, 37.8),
            _ => return Err("模型/量化组合不被已核对的官方安装器支持".into()),
        };
        return Ok((
            format!("qwen36-{quant}"),
            vec![format!("Qwen3.6-35B-A3B-{quant}.gguf")],
            download,
            arena,
        ));
    }
    let (tag, prefix, count, suffix) = match family {
        "qwen" => ("", "Qwen3.8-Flash-Next-GSQ-RCO", 2, 2),
        "swift" => ("swift-", "Swift-Qwen3.8-Flash-Next-GSQ-RCO", 2, 2),
        "coder" => ("coder-", "Qwen3.8-Flash-Next-GSQ-RCO", 2, 2),
        "unsloth" if quant == "UD-IQ4_XS" => ("unsloth-", "Qwen3.8-Flash-Next", 3, 3),
        "unsloth" => ("unsloth-", "Qwen3.8-Flash-Next", 4, 4),
        _ => return Err("没有经过核对的模型目录规则".into()),
    };
    let (download, arena) = match (family, quant) {
        ("qwen", "Q2_0") => (66_400_000_000, 34.0),
        ("qwen" | "swift", "IQ2_XS") => (68_000_000_000, 35.5),
        ("qwen" | "swift", "IQ3_XXS") => (75_800_000_000, 42.9),
        ("qwen" | "swift", "IQ3_S") => (83_600_000_000, 50.3),
        ("coder", "IQ1_M") => (58_400_000_000, 23.4),
        ("unsloth", "UD-IQ4_XS") => (93_700_000_000, 59.5),
        ("unsloth", "UD-Q4_K_XL") => (111_300_000_000, 77.0),
        _ => return Err("模型/量化组合不被已核对的官方安装器支持".into()),
    };
    Ok((
        format!("{tag}{quant}"),
        (1..=count)
            .map(|i| format!("{prefix}-{quant}-{i:05}-of-{suffix:05}.gguf"))
            .collect(),
        download,
        arena,
    ))
}

fn configured_model_directory(
    profile: &ServiceProfile,
    names: &[String],
) -> Result<Option<PathBuf>, String> {
    if profile.config_path.is_empty() {
        return Ok(None);
    }
    let path = Path::new(&profile.config_path);
    let Some(meta) = file_meta(path)? else {
        return Ok(None);
    };
    if !meta.is_file() || meta.len() > 4 * 1024 * 1024 {
        return Err("模型配置无法用于核验已有分片目录".into());
    }
    let value: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("已有模型配置无法解析: {e}"))?;
    let root = Path::new(&profile.install_dir);
    let cwd = value["cwd"]
        .as_str()
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| root.join(value["cwd"].as_str().unwrap_or(".")));
    for argument in value["args"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let argument = argument.strip_prefix("--native=").unwrap_or(argument);
        let file = Path::new(argument);
        if file
            .file_name()
            .is_some_and(|name| name == names[0].as_str())
        {
            let file = if file.is_absolute() {
                file.to_owned()
            } else {
                cwd.join(file)
            };
            if let Some(parent) = file.parent() {
                return Ok(Some(parent.to_owned()));
            }
        }
    }
    Ok(None)
}

fn source_roots(root: &Path, settings: &Settings, data: &Path) -> Result<Vec<PathBuf>, String> {
    let mut roots = vec![data.to_owned(), root.to_owned()];
    roots.extend(
        settings
            .installs
            .iter()
            .filter(|p| p.is_absolute())
            .cloned(),
    );
    // Mirror upstream's bounded nearby-install lookup; never scan drives.
    for base in [root.parent(), root.parent().and_then(Path::parent)]
        .into_iter()
        .flatten()
    {
        let entries =
            fs::read_dir(base).map_err(|e| format!("无法识别相邻 Strata 数据目录: {e}"))?;
        for entry in entries.take(256) {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if entry.file_type().map_err(|e| e.to_string())?.is_dir()
                && entry
                    .file_name()
                    .to_string_lossy()
                    .to_lowercase()
                    .starts_with("strata")
            {
                roots.push(path.clone());
                if let Ok(nested) = fs::read_dir(&path) {
                    for child in nested.take(64).flatten() {
                        if child.file_type().is_ok_and(|t| t.is_dir())
                            && child
                                .file_name()
                                .to_string_lossy()
                                .to_lowercase()
                                .starts_with("strata")
                        {
                            roots.push(child.path());
                        }
                    }
                }
            }
        }
    }
    roots.extend(roots.clone().into_iter().map(|p| p.join("Strata-data")));
    roots.dedup();
    Ok(roots)
}

fn first_existing(roots: &[PathBuf], relative: &Path) -> Result<Option<PathBuf>, String> {
    for root in roots {
        let path = root.join(relative);
        if exists(&path)? {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

fn prepare_plan(
    root: &Path,
    family: &str,
    quant: &str,
    images: bool,
    settings: &Settings,
    ram_gib: f64,
    avx512: bool,
) -> Result<Plan, String> {
    let (tag, names, download, arena) = model_spec(family, quant)?;
    let mut data = settings
        .data_dir
        .clone()
        .unwrap_or_else(|| root.parent().unwrap_or(root).join("Strata-data"));
    if !data.is_absolute() {
        data = root.join(data);
    }
    let mut roots = source_roots(root, settings, &data)?;
    let mut model_directory = data.join("models").join(&tag);
    let mut reuse_directory = None;
    // Explicit --gguf-dir prevents re-downloading complete files copied by hand,
    // even without .done markers. Upstream still checks their GGUF directories.
    let mut candidates: Vec<(PathBuf, PathBuf)> = roots
        .iter()
        .map(|source| (source.join("models").join(&tag), source.clone()))
        .collect();
    if let Some(directory) = &settings.reusable_directory {
        // A profile can point at weights outside Strata's remembered folders.
        // Keep a containing models/ tree as its data root so upstream's initial
        // data-folder migration cannot move --gguf-dir out from under setup.
        let containing_data = directory
            .ancestors()
            .find(|p| p.file_name().is_some_and(|name| name == "models"))
            .and_then(Path::parent)
            .map(Path::to_owned)
            .unwrap_or_else(|| data.clone());
        candidates.insert(0, (directory.clone(), containing_data));
    }
    for (candidate, source) in candidates {
        if names
            .iter()
            .map(|name| file_len(&candidate.join(name)))
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .all(|size| *size > 0)
        {
            data = source;
            model_directory = candidate.clone();
            reuse_directory = Some(candidate);
            break;
        }
    }
    roots.retain(|r| r != &data);
    roots.insert(0, data.clone());
    let mut reusable = 0_u64;
    for name in &names {
        let final_path = model_directory.join(name);
        let final_bytes = file_len(&final_path)?;
        if reuse_directory.is_some()
            || (final_bytes > 0 && exists(&model_directory.join(format!("{name}.done")))?)
        {
            reusable = reusable.saturating_add(final_bytes);
        } else {
            let partial = model_directory.join(format!("{name}.part"));
            if fs::symlink_metadata(&partial).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err("断点下载文件指向另一个目录；请核验该文件位置后重试".into());
            }
            reusable = reusable.saturating_add(file_len(&partial)?);
        }
    }
    let missing = if reuse_directory.is_some() {
        0
    } else {
        download.saturating_sub(reusable)
    };
    let pack = first_existing(&roots, &PathBuf::from("packs").join(tag.to_lowercase()))?
        .unwrap_or_else(|| data.join("packs").join(tag.to_lowercase()));
    let pack_ready = exists(&pack.join("experts.bin"))? && exists(&pack.join("index.txt"))?;
    let mtp = first_existing(&roots, Path::new("mtp/rt/experts.bin"))?;
    let mtp_directory = mtp
        .as_ref()
        .and_then(|p| p.parent())
        .and_then(Path::parent)
        .map(Path::to_owned)
        .unwrap_or_else(|| data.join("mtp"));
    let q2_conversion = family == "qwen" && quant == "Q2_0" && avx512;
    // Qwen3.6: tokenizer-only pack (no experts.bin), MTP lives in the GGUF (install_own_path).
    let own_path = family == "qwen36";
    let low_ram = !own_path && family != "unsloth" && ram_gib < arena + 10.0;
    let pack_bytes = if own_path {
        if pack_ready || exists(&pack.join("tokenizer").join("vocab.json"))? {
            0
        } else {
            64 * 1024 * 1024 // tokenizer extracted from the GGUF
        }
    } else if pack_ready {
        0
    } else if q2_conversion {
        40 * GB
    } else if low_ram {
        ((arena + 1.0) * GB as f64).ceil() as u64
    } else {
        0
    };
    let mmproj = if family == "swift" {
        "mmproj-Swift-Qwen3.8-Flash-Next-BF16.gguf"
    } else if own_path {
        "mmproj-F16.gguf" // Unsloth Qwen3.6 mmproj beside the GGUF (QWEN36_FILES)
    } else {
        "mmproj-Qwen3.8-Flash-Next-BF16.gguf"
    };
    let vision_bytes = if !images {
        0
    } else if own_path {
        // install_own_path keeps mmproj next to the model GGUF under models/<tag>/
        if exists(&model_directory.join(mmproj))? {
            0
        } else {
            899_283_584 // QWEN36_FILES mmproj-F16.gguf
        }
    } else if first_existing(&roots, &PathBuf::from("models").join(mmproj))?.is_none() {
        GB
    } else {
        0
    };
    let mtp_bytes = if own_path {
        0
    } else if mtp.is_some() {
        2 * GB
    } else {
        8 * GB
    };
    let mut requirements = vec![
        (
            model_directory.clone(),
            missing.saturating_add(if own_path { vision_bytes } else { 0 }),
        ),
        (mtp_directory, mtp_bytes),
        (pack, pack_bytes),
        (data.join("models"), if own_path { 0 } else { vision_bytes }),
    ];
    // The upstream data-volume estimate does not bound wheel/engine downloads.
    // Include a small explicit runtime margin; still disclose the unknown total.
    requirements.push((root.to_owned(), 2 * GB));
    let additional = requirements.iter().map(|(_, bytes)| *bytes).sum();
    Ok(Plan {
        report: SetupDiskPreflight {
            status: "unknown".into(),
            data_directory: data.to_string_lossy().into(),
            model_directory: model_directory.to_string_lossy().into(),
            model_download_bytes_estimate: Some(missing),
            reusable_model_bytes: reusable,
            additional_bytes_estimate: Some(additional),
            estimate: true,
            volumes: requirements
                .into_iter()
                .filter(|(_, b)| *b > 0)
                .map(|(directory, bytes)| SetupDiskVolume {
                    directory: directory.to_string_lossy().into(),
                    mount_point: None,
                    available_bytes: None,
                    required_additional_bytes_estimate: bytes,
                })
                .collect(),
            reason: String::new(),
            source: SOURCE.into(),
        },
        data_directory: data,
        gguf_directory: reuse_directory,
    })
}

fn existing_ancestor(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("准备目录必须为绝对路径".into());
    }
    let mut current = path;
    loop {
        match fs::metadata(current) {
            Ok(meta) if meta.is_dir() => {
                return dunce::canonicalize(current).map_err(|e| e.to_string())
            }
            Ok(_) => return Err(format!("准备路径不是目录: {}", current.display())),
            Err(error) if error.kind() == ErrorKind::NotFound => {
                current = current.parent().ok_or("准备目录没有可访问的父目录")?
            }
            Err(error) => return Err(format!("无法读取准备目录 {}: {error}", current.display())),
        }
    }
}

fn read_space(path: &Path) -> Result<(PathBuf, u64), String> {
    let target = existing_ancestor(path)?;
    let disks = sysinfo::Disks::new_with_refreshed_list_specifics(
        sysinfo::DiskRefreshKind::nothing().with_storage(),
    );
    let disk = disks
        .list()
        .iter()
        .filter_map(|disk| {
            dunce::canonicalize(disk.mount_point())
                .ok()
                .filter(|mount| target.starts_with(mount))
                .map(|mount| (disk, mount))
        })
        .max_by_key(|(_, mount)| mount.components().count())
        .ok_or("找不到目标目录对应的磁盘挂载")?;
    if disk.0.total_space() == 0 {
        return Err("无法读取目标磁盘容量；可能未挂载或当前用户无权限".into());
    }
    if disk.0.is_read_only() {
        return Err("目标磁盘为只读；无法写入准备文件".into());
    }
    Ok((disk.1, disk.0.available_space()))
}

fn measure(plan: &mut Plan, reader: impl Fn(&Path) -> Result<(PathBuf, u64), String>) {
    let mut grouped: Vec<SetupDiskVolume> = vec![];
    let mut errors = vec![];
    for mut volume in plan.report.volumes.drain(..) {
        match reader(Path::new(&volume.directory)) {
            Ok((mount, available)) => {
                let mount = mount.to_string_lossy().into_owned();
                if let Some(existing) = grouped
                    .iter_mut()
                    .find(|v| v.mount_point.as_deref() == Some(&mount))
                {
                    existing.required_additional_bytes_estimate = existing
                        .required_additional_bytes_estimate
                        .saturating_add(volume.required_additional_bytes_estimate);
                    existing.available_bytes =
                        Some(existing.available_bytes.unwrap_or(available).min(available));
                } else {
                    volume.mount_point = Some(mount);
                    volume.available_bytes = Some(available);
                    grouped.push(volume);
                }
            }
            Err(error) => {
                errors.push(error);
                grouped.push(volume);
            }
        }
    }
    plan.report.volumes = grouped;
    if !errors.is_empty() {
        plan.report.status = "unknown".into();
        plan.report.reason = errors.join("；");
        return;
    }
    let low: Vec<_> = plan
        .report
        .volumes
        .iter()
        .filter(|v| v.available_bytes.unwrap_or(0) < v.required_additional_bytes_estimate)
        .map(|v| {
            format!(
                "{} 可用 {:.2} GB，预计还需 {:.2} GB。",
                v.mount_point.as_deref().unwrap_or(&v.directory),
                v.available_bytes.unwrap_or(0) as f64 / GB as f64,
                v.required_additional_bytes_estimate as f64 / GB as f64
            )
        })
        .collect();
    plan.report.status = if low.is_empty() {
        "ready"
    } else {
        "insufficient"
    }
    .into();
    plan.report.reason = if low.is_empty() {
        "按现有分片/断点文件扣减后的空间估计通过；GGUF有效性由上游继续核验，依赖下载、模型质量与运行容量另行验证。".into()
    } else {
        low.join(" ")
    };
}

pub(crate) fn plan(
    profile: &ServiceProfile,
    family: &str,
    quant: &str,
    images: bool,
) -> Result<Plan, String> {
    let root = processes::runtime_dir(profile)?;
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    let avx512 = std::is_x86_feature_detected!("avx512f");
    #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
    let avx512 = false;
    let mut settings = settings()?;
    let (_, names, _, _) = model_spec(family, quant)?;
    settings.reusable_directory = configured_model_directory(profile, &names)?;
    let mut result = prepare_plan(
        &root,
        family,
        quant,
        images,
        &settings,
        system.total_memory() as f64 / (1_u64 << 30) as f64,
        avx512,
    )?;
    measure(&mut result, read_space);
    Ok(result)
}

pub(crate) fn preflight(
    profile: &ServiceProfile,
    family: &str,
    quant: &str,
    images: bool,
) -> SetupDiskPreflight {
    match plan(profile, family, quant, images) {
        Ok(plan) => plan.report,
        Err(reason) => SetupDiskPreflight {
            status: "unknown".into(),
            data_directory: String::new(),
            model_directory: String::new(),
            model_download_bytes_estimate: None,
            reusable_model_bytes: 0,
            additional_bytes_estimate: None,
            estimate: true,
            volumes: vec![],
            reason,
            source: SOURCE.into(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::RuntimeState;

    struct Fixture {
        _temp: tempfile::TempDir,
        root: PathBuf,
        data: PathBuf,
    }
    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runtime");
        let data = temp.path().join("data");
        fs::create_dir_all(root.join("serve")).unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::write(
            root.join("setup.py"),
            b"raise Exception('must not execute')",
        )
        .unwrap();
        fs::write(root.join("serve/server.py"), b"# never execute").unwrap();
        Fixture {
            _temp: temp,
            root,
            data,
        }
    }
    fn make_plan(f: &Fixture) -> Plan {
        prepare_plan(
            &f.root,
            "qwen",
            "IQ3_S",
            false,
            &Settings {
                data_dir: Some(f.data.clone()),
                installs: vec![],
                ..Settings::default()
            },
            64.0,
            false,
        )
        .unwrap()
    }
    fn files(f: &Fixture, complete: bool) -> PathBuf {
        let dir = f.data.join("models/IQ3_S");
        fs::create_dir_all(&dir).unwrap();
        let (_, names, _, _) = model_spec("qwen", "IQ3_S").unwrap();
        fs::write(dir.join(&names[0]), vec![1; 4096]).unwrap();
        if complete {
            fs::write(dir.join(&names[1]), vec![2; 8192]).unwrap();
        }
        dir
    }

    #[test]
    fn fresh_download_is_an_explicit_estimate_and_not_a_ram_promise() {
        let f = fixture();
        let p = make_plan(&f);
        assert_eq!(p.report.model_download_bytes_estimate, Some(83_600_000_000));
        assert_eq!(p.report.additional_bytes_estimate, Some(93_600_000_000));
        assert!(p.report.estimate);
        assert!(p.report.source.contains("do not guarantee RAM/VRAM"));
    }

    #[test]
    fn existing_complete_files_need_no_second_weight_copy_or_done_markers() {
        let f = fixture();
        let dir = files(&f, true);
        fs::create_dir_all(f.data.join("mtp/rt")).unwrap();
        fs::write(f.data.join("mtp/rt/experts.bin"), b"existing draft").unwrap();
        // A stale .part beside a complete file is not counted again.
        let (_, names, _, _) = model_spec("qwen", "IQ3_S").unwrap();
        fs::write(dir.join(format!("{}.part", names[0])), vec![0; 1024]).unwrap();
        let mut p = make_plan(&f);
        measure(&mut p, |_| {
            Ok((
                PathBuf::from(if cfg!(windows) { "C:/" } else { "/" }),
                5 * GB,
            ))
        });
        assert_eq!(p.gguf_directory, Some(dir));
        assert_eq!(p.report.model_download_bytes_estimate, Some(0));
        assert_eq!(p.report.reusable_model_bytes, 12288);
        assert_eq!(p.report.additional_bytes_estimate, Some(4 * GB));
        assert_eq!(p.report.status, "ready");
        p.require_space().unwrap();
    }

    #[test]
    fn partial_download_counts_done_files_and_resume_bytes_once() {
        let f = fixture();
        let dir = files(&f, false);
        let (_, names, _, _) = model_spec("qwen", "IQ3_S").unwrap();
        fs::write(dir.join(format!("{}.done", names[0])), b"finished").unwrap();
        fs::write(dir.join(format!("{}.part", names[0])), vec![0; 500]).unwrap();
        fs::write(dir.join(format!("{}.part", names[1])), vec![0; 2048]).unwrap();
        let p = make_plan(&f);
        assert!(p.gguf_directory.is_none());
        assert_eq!(p.report.reusable_model_bytes, 6144);
        assert_eq!(
            p.report.model_download_bytes_estimate,
            Some(83_600_000_000 - 6144)
        );
    }

    #[test]
    fn complete_install_from_another_data_directory_stays_in_place() {
        let f = fixture();
        let other = f._temp.path().join("existing-runtime");
        let tag = other.join("models/IQ3_S");
        fs::create_dir_all(&tag).unwrap();
        let (_, names, _, _) = model_spec("qwen", "IQ3_S").unwrap();
        for name in names {
            fs::write(
                tag.join(name),
                b"existing weights validated later by upstream",
            )
            .unwrap();
        }
        let p = prepare_plan(
            &f.root,
            "qwen",
            "IQ3_S",
            false,
            &Settings {
                data_dir: Some(f.data.clone()),
                installs: vec![other.clone()],
                ..Settings::default()
            },
            64.0,
            false,
        )
        .unwrap();
        assert_eq!(p.data_directory, other);
        assert_eq!(p.gguf_directory, Some(tag));
        assert_eq!(p.report.model_download_bytes_estimate, Some(0));
    }

    #[test]
    fn swift_iq3_s_uses_the_official_family_paths_and_resource_estimate() {
        let (tag, names, download, arena) = model_spec("swift", "IQ3_S").unwrap();
        assert_eq!(tag, "swift-IQ3_S");
        assert_eq!(names.len(), 2);
        assert!(names
            .iter()
            .all(|name| name.starts_with("Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-")));
        assert_eq!(download, 83_600_000_000);
        assert_eq!(arena, 50.3);
    }

    #[test]
    fn qwen36_uses_single_unsloth_gguf_and_own_path_sizes() {
        let (tag, names, download, arena) = model_spec("qwen36", "UD-Q4_K_XL").unwrap();
        assert_eq!(tag, "qwen36-UD-Q4_K_XL");
        assert_eq!(names, vec!["Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf".to_string()]);
        assert_eq!(download, 22_853_663_008);
        assert_eq!(arena, 22.9);
        assert!(model_spec("qwen36", "IQ3_S").is_err());
    }

    #[test]
    fn profile_weights_outside_remembered_roots_are_reused_without_moving_the_model_tree() {
        let f = fixture();
        let other = f._temp.path().join("my-existing-assets");
        let directory = other.join("models/custom-folder");
        fs::create_dir_all(&directory).unwrap();
        let (_, names, _, _) = model_spec("qwen", "IQ3_S").unwrap();
        for name in &names {
            fs::write(
                directory.join(name),
                b"existing shard, validated by upstream later",
            )
            .unwrap();
        }
        let config = f.root.join("strata-existing.json");
        fs::write(&config, serde_json::to_vec(&serde_json::json!({"cwd":f.root,"args":["--native",directory.join(&names[0]),"--ple-gguf",directory.join(&names[1])]})).unwrap()).unwrap();
        let profile = ServiceProfile {
            id: "existing".into(),
            name: "existing".into(),
            base_url: "http://127.0.0.1:19973".into(),
            install_dir: f.root.to_string_lossy().into(),
            config_path: config.to_string_lossy().into(),
            python_path: String::new(),
            managed: true,
        };
        let reuse = configured_model_directory(&profile, &names).unwrap();
        assert_eq!(reuse.as_ref(), Some(&directory));
        let settings = Settings {
            data_dir: Some(f.data.clone()),
            reusable_directory: reuse,
            ..Settings::default()
        };
        let p = prepare_plan(&f.root, "qwen", "IQ3_S", false, &settings, 64.0, false).unwrap();
        assert_eq!(p.data_directory, other);
        assert_eq!(p.gguf_directory, Some(directory));
        assert_eq!(p.report.model_download_bytes_estimate, Some(0));
        assert!(config.is_file());
    }

    #[test]
    fn mixed_volumes_are_checked_independently_and_same_volume_is_summed() {
        let f = fixture();
        let mut p = make_plan(&f);
        measure(&mut p, |path| {
            if path.starts_with(&f.root) {
                Ok((PathBuf::from("runtime-volume"), 500 * GB))
            } else {
                Ok((PathBuf::from("data-volume"), 20 * GB))
            }
        });
        assert_eq!(p.report.volumes.len(), 2);
        assert_eq!(p.report.status, "insufficient");
        assert_eq!(
            p.report
                .volumes
                .iter()
                .find(|v| v.mount_point.as_deref() == Some("data-volume"))
                .unwrap()
                .required_additional_bytes_estimate,
            91_600_000_000
        );
        assert!(p.require_space().unwrap_err().contains("未启动下载"));
    }

    #[test]
    fn missing_mount_or_permission_failure_is_unknown_and_rejects_preparation() {
        for message in ["no matching mount", "permission denied"] {
            let f = fixture();
            let mut p = make_plan(&f);
            measure(&mut p, |_| Err(message.into()));
            assert_eq!(p.report.status, "unknown");
            assert!(p.report.volumes.iter().all(|v| v.available_bytes.is_none()));
            assert!(p.require_space().unwrap_err().contains(message));
        }
    }

    #[test]
    fn q2_conversion_and_low_ram_pack_are_separate_disk_estimates() {
        let f = fixture();
        let settings = Settings {
            data_dir: Some(f.data.clone()),
            installs: vec![],
            ..Settings::default()
        };
        let q2 = prepare_plan(&f.root, "qwen", "Q2_0", false, &settings, 64.0, true).unwrap();
        assert_eq!(q2.report.additional_bytes_estimate, Some(116_400_000_000));
        let small_ram =
            prepare_plan(&f.root, "qwen", "IQ3_S", false, &settings, 32.0, false).unwrap();
        assert_eq!(
            small_ram.report.additional_bytes_estimate,
            Some(144_900_000_000)
        );
    }

    #[test]
    fn real_read_only_free_space_probe_resolves_the_target_parent_volume() {
        let f = fixture();
        let before = fs::read_dir(&f.data).unwrap().count();
        let (mount, available) = read_space(&f.data.join("not-created/model")).unwrap();
        assert!(mount.is_absolute());
        assert!(available > 0);
        assert_eq!(fs::read_dir(&f.data).unwrap().count(), before);
        assert!(!f.data.join("not-created").exists());
        println!(
            "read-only disk probe: mount={} available_bytes={available}",
            mount.display()
        );
    }

    #[test]
    fn low_or_unknown_space_stops_run_setup_before_tasks_backups_or_processes() {
        for unknown in [false, true] {
            let f = fixture();
            fs::write(f.root.join("strata-original.json"), b"preserve exact bytes").unwrap();
            let state = RuntimeState::open(f._temp.path().join("manager-data")).unwrap();
            let profile = ServiceProfile {
                id: "disk-isolated".into(),
                name: "disk fixture".into(),
                base_url: "http://127.0.0.1:19973".into(),
                install_dir: f.root.to_string_lossy().into(),
                config_path: String::new(),
                python_path: "must-not-start-python".into(),
                managed: true,
            };
            let mut p = make_plan(&f);
            measure(&mut p, |_| {
                if unknown {
                    Err("permission denied".into())
                } else {
                    Ok((PathBuf::from("test-volume"), GB))
                }
            });
            let error = crate::run_setup_with_preflight(
                state.clone(),
                profile,
                "qwen".into(),
                "IQ3_S".into(),
                8192,
                false,
                |_, _, _, _| Ok(p),
            )
            .err()
            .expect("space preflight must reject setup");
            assert!(error.contains("未启动下载或准备任务"));
            assert!(state.tasks.lock().unwrap().is_empty());
            assert!(state.processes.lock().unwrap().is_empty());
            assert_eq!(
                fs::read(f.root.join("strata-original.json")).unwrap(),
                b"preserve exact bytes"
            );
            assert_eq!(fs::read_dir(&f.root).unwrap().count(), 3);
        }
    }
}
