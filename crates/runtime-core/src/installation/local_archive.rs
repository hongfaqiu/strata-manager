//! Already-downloaded installer archives chosen by the user during first-run setup.
//!
//! A local file is held to the same standard as a download: it must be a regular
//! `.zip` within the download's size limit and match the digest the download would
//! have to match. It is copied into the managed `downloads` cache, so installation
//! continues exactly as after a download and the user's original file is never moved.
use super::{cancelled, file_hash, owned_directory, progress};
use crate::RuntimeState;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

/// Optional local replacements for the archives the runtime step downloads.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRuntimeArchives {
    /// The Strata source ZIP (the official revision archive).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strata_archive_path: Option<String>,
    /// The official engine archive from the Release (Windows `.zip`, Mac Metal `.tar.gz`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_archive_path: Option<String>,
}

/// Bilingual name of an archive in user-facing errors.
#[derive(Clone, Copy)]
pub struct Label {
    pub zh: &'static str,
    pub en: &'static str,
}
pub const STRATA: Label = Label {
    zh: "Strata 安装包",
    en: "Strata archive",
};
pub const ENGINE: Label = Label {
    zh: "引擎安装包",
    en: "engine archive",
};

fn normalized(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn has_archive_extension(path: &Path, extensions: &[&str]) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    extensions.iter().any(|ext| name.ends_with(ext))
}

pub const WINDOWS_ENGINE_EXTENSIONS: [&str; 3] = [".zip", ".tar.gz", ".tgz"];

/// Checks a user-selected path before any task is admitted.
pub fn check_path(path: &str, label: Label) -> Result<(), String> {
    check_path_with_extensions(path, label, &[".zip"])
}

/// Same as [`check_path`], but allows the listed extensions (for example `.tar.gz` on Mac).
pub fn check_path_with_extensions(
    path: &str,
    label: Label,
    extensions: &[&str],
) -> Result<(), String> {
    let Label { zh, en } = label;
    let candidate = Path::new(path);
    let joined = extensions.join(" / ");
    if !candidate.is_absolute() || !has_archive_extension(candidate, extensions) {
        return Err(format!(
            "{zh}必须是绝对路径的 {joined} 文件 / The {en} must be an absolute path to a {joined} file"
        ));
    }
    let metadata = fs::metadata(candidate)
        .map_err(|error| format!("无法读取{zh}：{error} / Cannot read the {en}: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("{zh}不是普通文件 / The {en} is not a regular file"));
    }
    Ok(())
}

impl LocalRuntimeArchives {
    pub fn is_empty(&self) -> bool {
        self.strata_archive_path.is_none() && self.engine_archive_path.is_none()
    }

    /// Normalizes empty strings away and validates the platform and each file.
    pub fn validate(self) -> Result<Self, String> {
        self.validate_for(std::env::consts::OS, std::env::consts::ARCH)
    }

    /// Platform-parameter form used by tests and Mac Metal installs.
    pub fn validate_for(self, os: &str, arch: &str) -> Result<Self, String> {
        let archives = Self {
            strata_archive_path: normalized(self.strata_archive_path),
            engine_archive_path: normalized(self.engine_archive_path),
        };
        let windows_engine = os == "windows" && arch == "x86_64";
        let metal_engine = crate::macos_metal::metal_engine_supported(os, arch);
        if archives.engine_archive_path.is_some() && !windows_engine && !metal_engine {
            return Err("此平台不使用引擎安装包：引擎由 Strata 安装脚本在准备模型时安装 / This platform does not use an engine package; Strata's setup installs the engine while preparing the model".into());
        }
        if let Some(path) = &archives.strata_archive_path {
            check_path(path, STRATA)?;
        }
        if let Some(path) = &archives.engine_archive_path {
            if metal_engine {
                check_path_with_extensions(path, ENGINE, &[".tar.gz", ".tgz"])?;
            } else {
                // Strata 0.2+ publishes `.tar.gz` component engines; older releases ZIPs.
                check_path_with_extensions(path, ENGINE, &WINDOWS_ENGINE_EXTENSIONS)?;
            }
        }
        Ok(archives)
    }
}

/// Streams `path` into a managed temporary file in `directory`, returning it with
/// its SHA256 and length. Fails as soon as `limit` is exceeded.
pub(crate) fn copy_hashed(
    state: &RuntimeState,
    id: &str,
    path: &Path,
    directory: &Path,
    limit: u64,
    label: Label,
) -> Result<(tempfile::NamedTempFile, String, u64), String> {
    let Label { zh, en } = label;
    cancelled(state, id)?;
    let mut source = File::open(path)
        .map_err(|error| format!("无法读取{zh}：{error} / Cannot read the {en}: {error}"))?;
    let metadata = source.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err(format!("{zh}不是普通文件 / The {en} is not a regular file"));
    }
    if metadata.len() == 0 || metadata.len() > limit {
        return Err(format!(
            "{zh}为空或超过官方安装包的大小上限（{} 字节）/ The {en} is empty or larger than an official package allows ({} bytes)",
            metadata.len(),
            metadata.len()
        ));
    }
    progress(
        state,
        id,
        format!("正在读取本地{zh} {}；按官方校验后安装", path.display()),
    )?;
    let mut output = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    let mut received = 0u64;
    loop {
        cancelled(state, id)?;
        let count = source
            .read(&mut buffer)
            .map_err(|error| format!("{zh}读取失败：{error} / Failed to read the {en}: {error}"))?;
        if count == 0 {
            break;
        }
        received += count as u64;
        if received > limit {
            return Err(format!(
                "读取期间{zh}变大，已拒绝安装 / The {en} grew while being read; installation refused"
            ));
        }
        digest.update(&buffer[..count]);
        output
            .write_all(&buffer[..count])
            .map_err(|error| error.to_string())?;
    }
    output.as_file().sync_all().map_err(|e| e.to_string())?;
    Ok((output, format!("{:x}", digest.finalize()), received))
}

/// Uses a local archive in place of `download(url, expected, limit)`: same digest,
/// same limit, same hash-addressed cache entry.
pub(crate) fn import_verified(
    state: &RuntimeState,
    id: &str,
    path: &Path,
    expected: &str,
    limit: u64,
    label: Label,
) -> Result<PathBuf, String> {
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("官方 SHA256 无效".into());
    }
    let Label { zh, en } = label;
    let expected = expected.to_ascii_lowercase();
    let directory = owned_directory(state.data_dir(), &["downloads"])?;
    let (output, digest, received) = copy_hashed(state, id, path, &directory, limit, label)?;
    if digest != expected {
        return Err(format!(
            "本地{zh}的 SHA256 与此版本的官方安装包不符（可能版本不对或文件损坏），已拒绝安装 / The {en} SHA256 does not match this version's official package (wrong version or damaged file); installation refused"
        ));
    }
    cancelled(state, id)?;
    for candidate in [
        directory.join(format!("{expected}.download")),
        directory.join(format!("{expected}-verified.download")),
    ] {
        if candidate.is_symlink() {
            continue;
        }
        if candidate.is_file() {
            if file_hash(&candidate)? == expected {
                progress(
                    state,
                    id,
                    format!(
                        "本地{zh}校验通过（{}）；已有相同的已校验缓存",
                        crate::byte_size::human_bytes(received)
                    ),
                )?;
                return Ok(candidate);
            }
            continue;
        }
        output
            .persist_noclobber(&candidate)
            .map_err(|error| error.to_string())?;
        progress(
            state,
            id,
            format!(
                "本地{zh}官方 SHA256 校验通过，共 {}；原文件保持不变",
                crate::byte_size::human_bytes(received)
            ),
        )?;
        return Ok(candidate);
    }
    let fallback = directory.join(format!("{expected}-{}.download", uuid::Uuid::new_v4()));
    output
        .persist_noclobber(&fallback)
        .map_err(|error| error.to_string())?;
    Ok(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        processes::TaskRecord,
        types::{now, TaskStatus},
    };

    fn task(state: &RuntimeState) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        state.tasks.lock().unwrap().insert(
            id.clone(),
            TaskRecord {
                status: TaskStatus {
                    id: id.clone(),
                    kind: "install-runtime".into(),
                    state: "running".into(),
                    message: String::new(),
                    started_at: now(),
                    finished_at: None,
                },
                profile_id: None,
                runtime_path: None,
                cancelled: false,
                process: None,
            },
        );
        id
    }

    #[test]
    fn paths_must_be_absolute_existing_zip_files() {
        let temp = tempfile::tempdir().unwrap();
        let zip = temp.path().join("strata.zip");
        fs::write(&zip, b"zip").unwrap();
        assert!(check_path(&zip.to_string_lossy(), STRATA).is_ok());
        assert!(check_path("strata.zip", STRATA).is_err());
        let text = temp.path().join("strata.txt");
        fs::write(&text, b"zip").unwrap();
        assert!(check_path(&text.to_string_lossy(), STRATA).is_err());
        assert!(check_path(&temp.path().join("missing.zip").to_string_lossy(), STRATA).is_err());
        let folder = temp.path().join("folder.zip");
        fs::create_dir(&folder).unwrap();
        assert!(check_path(&folder.to_string_lossy(), STRATA).is_err());
        let empty = LocalRuntimeArchives {
            strata_archive_path: Some("  ".into()),
            engine_archive_path: None,
        }
        .validate()
        .unwrap();
        assert!(empty.is_empty());
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        assert!(LocalRuntimeArchives {
            strata_archive_path: None,
            engine_archive_path: Some(zip.to_string_lossy().into()),
        }
        .validate()
        .is_err());
    }

    #[test]
    fn matching_archive_becomes_the_download_cache_and_original_is_untouched() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("state")).unwrap();
        let id = task(&state);
        let bytes = b"official strata archive".to_vec();
        let local = temp.path().join("Strata.zip");
        fs::write(&local, &bytes).unwrap();
        let expected = format!("{:x}", Sha256::digest(&bytes));
        let cached = import_verified(&state, &id, &local, &expected, 1024, STRATA).unwrap();
        assert_eq!(
            cached.file_name().unwrap().to_string_lossy(),
            format!("{expected}.download")
        );
        assert_eq!(fs::read(&cached).unwrap(), bytes);
        assert_eq!(fs::read(&local).unwrap(), bytes);
        // A second import reuses the verified cache instead of replacing it.
        assert_eq!(
            import_verified(&state, &id, &local, &expected, 1024, STRATA).unwrap(),
            cached
        );
    }

    #[test]
    fn wrong_digest_oversize_and_cancelled_imports_leave_no_cache() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("state")).unwrap();
        let id = task(&state);
        let local = temp.path().join("Strata.zip");
        fs::write(&local, b"other version").unwrap();
        let expected = format!("{:x}", Sha256::digest(b"official"));
        let error = import_verified(&state, &id, &local, &expected, 1024, STRATA).unwrap_err();
        assert!(error.contains("SHA256"), "{error}");
        assert!(import_verified(&state, &id, &local, &expected, 4, STRATA).is_err());
        state.tasks.lock().unwrap().get_mut(&id).unwrap().cancelled = true;
        assert!(import_verified(&state, &id, &local, &expected, 1024, STRATA).is_err());
        let downloads = state.data_dir().join("downloads");
        let leftovers = fs::read_dir(&downloads)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|e| e.path().extension().is_some_and(|x| x == "download"))
                    .count()
            })
            .unwrap_or(0);
        assert_eq!(leftovers, 0);
    }
}
