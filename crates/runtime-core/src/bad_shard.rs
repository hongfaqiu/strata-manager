//! A model shard that failed its size or SHA-256 check in `--gguf-dir` mode. Upstream treats that
//! folder as the user's own and never deletes from it, so retrying fails on the same file forever.
//! The user may delete exactly that shard (and its leftovers) and let setup download it again.
use crate::task_failure;
use serde::Serialize;
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

/// The file name plus these suffixes are everything upstream leaves for one shard:
/// the finish mark, the partial download and its resume bookkeeping.
const COMPANION_SUFFIXES: [&str; 4] = [".done", ".part", ".part.chunks", ".part.src"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BadShard {
    pub file_name: String,
    pub directory: String,
    /// The shard's full path, the one the user confirms.
    pub path: String,
    /// Bytes of the shard on disk; `None` when it is already gone.
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    pub removed: Vec<String>,
}

/// The `--gguf-dir` a setup command was started with.
pub fn gguf_directory(args: &[String]) -> Option<PathBuf> {
    let index = args.iter().position(|arg| arg == "--gguf-dir")?;
    let directory = args.get(index + 1)?;
    (!directory.is_empty()).then(|| PathBuf::from(directory))
}

/// A bare `.gguf` file name: no separators, no drive prefix, no dot segments.
fn checked_name(name: &str) -> Result<&str, String> {
    let bare = !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', ':', '\0'])
        && Path::new(name).file_name().is_some_and(|n| n == name)
        && name.to_ascii_lowercase().ends_with(".gguf");
    if bare {
        Ok(name)
    } else {
        Err("不是有效的模型分片文件名".into())
    }
}

/// The failed task's bad shard, when its log shows the kept-file failure and the task ran with
/// `--gguf-dir`.
pub fn inspect(directory: Option<&Path>, lines: &[String]) -> Option<BadShard> {
    let directory = directory?;
    let name = task_failure::kept_file_name(lines)?;
    let name = checked_name(&name).ok()?;
    let path = directory.join(name);
    let size_bytes = fs::symlink_metadata(&path)
        .ok()
        .filter(|meta| meta.file_type().is_file())
        .map(|meta| meta.len());
    Some(BadShard {
        file_name: name.to_owned(),
        directory: directory.to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        size_bytes,
    })
}

/// Delete `file_name` and its leftovers, only inside `directory`. Every file must be a plain file
/// that really lives in that folder; anything else stops the whole removal before it starts.
pub fn remove(directory: &Path, file_name: &str) -> Result<Removed, String> {
    let name = checked_name(file_name)?;
    let root = dunce::canonicalize(directory)
        .map_err(|error| format!("模型目录不可用：{}：{error}", directory.display()))?;
    let mut targets = Vec::new();
    for suffix in std::iter::once("").chain(COMPANION_SUFFIXES) {
        let path = root.join(format!("{name}{suffix}"));
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("无法读取 {}：{error}", path.display())),
            Ok(meta) if !meta.file_type().is_file() => {
                return Err(format!("{} 不是普通文件，已拒绝删除", path.display()))
            }
            Ok(_) => {}
        }
        if path.parent() != Some(root.as_path()) {
            return Err(format!("{} 不在模型目录内，已拒绝删除", path.display()));
        }
        targets.push(path);
    }
    let mut removed = Vec::new();
    for path in targets {
        fs::remove_file(&path).map_err(|error| {
            format!(
                "删除 {} 失败：{error}；已删除 {} 个文件",
                path.display(),
                removed.len()
            )
        })?;
        removed.push(path.to_string_lossy().into_owned());
    }
    Ok(Removed { removed })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHARD: &str = "Qwen3.8-Flash-Next-UD-Q6_K_XL-00004-of-00006.gguf";

    fn lines(text: &str) -> Vec<String> {
        text.lines().map(str::to_owned).collect()
    }

    fn sha_failure() -> Vec<String> {
        lines(&format!("  checking {SHARD} (SHA-256, 49.8 GB) ...\n  [X]  {SHARD} does not match the published file (SHA-256 6f98, expected 0ea4)\n       it may be damaged or another version; your file was left as it is. Copy the whole published file into the folder\n"))
    }

    #[test]
    fn the_gguf_dir_comes_from_the_setup_arguments() {
        let args: Vec<String> = ["setup.py", "--gguf-dir", "D:\\Models", "--yes"]
            .map(String::from)
            .into();
        assert_eq!(gguf_directory(&args), Some(PathBuf::from("D:\\Models")));
        assert_eq!(gguf_directory(&args[..2]), None);
        assert_eq!(gguf_directory(&["--gguf-dir".into(), String::new()]), None);
    }

    #[test]
    fn a_kept_file_failure_names_the_shard_and_its_path() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join(SHARD), [0u8; 7]).unwrap();
        let found = inspect(Some(temp.path()), &sha_failure()).unwrap();
        assert_eq!(found.file_name, SHARD);
        assert_eq!(found.size_bytes, Some(7));
        assert_eq!(Path::new(&found.path), temp.path().join(SHARD));
    }

    #[test]
    fn other_failures_and_runs_without_gguf_dir_have_no_bad_shard() {
        let temp = tempfile::tempdir().unwrap();
        assert!(inspect(None, &sha_failure()).is_none());
        let deleted = lines("  [X]  m-00001-of-00002.gguf has the wrong SHA-256 (a, expected b): deleted\n       run setup again to download it again");
        assert!(inspect(Some(temp.path()), &deleted).is_none());
        let network = lines("  [X]  cannot reach huggingface.co (timed out)");
        assert!(inspect(Some(temp.path()), &network).is_none());
    }

    #[test]
    fn a_log_that_names_a_path_instead_of_a_file_is_not_trusted() {
        let temp = tempfile::tempdir().unwrap();
        for name in [
            "..\\evil.gguf",
            "../evil.gguf",
            "C:\\evil.gguf",
            "sub/evil.gguf",
            "notes.txt",
        ] {
            let log = lines(&format!(
                "  [X]  {name} does not match the published file (SHA-256 a, expected b)"
            ));
            assert!(inspect(Some(temp.path()), &log).is_none(), "{name}");
        }
    }

    #[test]
    fn remove_deletes_the_shard_and_its_leftovers_only() {
        let temp = tempfile::tempdir().unwrap();
        for suffix in ["", ".done", ".part", ".part.chunks", ".part.src"] {
            fs::write(temp.path().join(format!("{SHARD}{suffix}")), b"x").unwrap();
        }
        let other = "Qwen3.8-Flash-Next-UD-Q6_K_XL-00003-of-00006.gguf";
        fs::write(temp.path().join(other), b"keep").unwrap();
        fs::write(temp.path().join(format!("{other}.done")), b"keep").unwrap();
        fs::write(temp.path().join("notes.txt"), b"keep").unwrap();
        let result = remove(temp.path(), SHARD).unwrap();
        assert_eq!(result.removed.len(), 5);
        assert!(!temp.path().join(SHARD).exists());
        assert!(!temp.path().join(format!("{SHARD}.done")).exists());
        assert!(temp.path().join(other).exists());
        assert!(temp.path().join(format!("{other}.done")).exists());
        assert!(temp.path().join("notes.txt").exists());
        // Nothing left to delete is not an error: the user may have removed it already.
        assert!(remove(temp.path(), SHARD).unwrap().removed.is_empty());
    }

    #[test]
    fn remove_refuses_names_that_leave_the_model_directory() {
        let temp = tempfile::tempdir().unwrap();
        let models = temp.path().join("models");
        fs::create_dir(&models).unwrap();
        fs::write(temp.path().join("outside.gguf"), b"keep").unwrap();
        for name in [
            "../outside.gguf",
            "..\\outside.gguf",
            "sub/../../outside.gguf",
            "/etc/passwd.gguf",
            "C:\\outside.gguf",
            "..",
            "",
            "outside.txt",
        ] {
            assert!(remove(&models, name).is_err(), "{name}");
        }
        assert!(temp.path().join("outside.gguf").exists());
    }

    #[test]
    fn remove_refuses_directories_and_leaves_the_rest_untouched() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join(SHARD), b"x").unwrap();
        // A folder named like a leftover stops the removal before the shard goes.
        fs::create_dir(temp.path().join(format!("{SHARD}.part"))).unwrap();
        assert!(remove(temp.path(), SHARD).is_err());
        assert!(temp.path().join(SHARD).exists());
        let by_name = tempfile::tempdir().unwrap();
        fs::create_dir(by_name.path().join(SHARD)).unwrap();
        assert!(remove(by_name.path(), SHARD).is_err());
        assert!(by_name.path().join(SHARD).is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn remove_never_follows_a_symlink_out_of_the_directory() {
        let temp = tempfile::tempdir().unwrap();
        let models = temp.path().join("models");
        fs::create_dir(&models).unwrap();
        let outside = temp.path().join("precious.gguf");
        fs::write(&outside, b"keep").unwrap();
        std::os::unix::fs::symlink(&outside, models.join(SHARD)).unwrap();
        assert!(remove(&models, SHARD).is_err());
        assert!(outside.exists());
        assert!(fs::symlink_metadata(models.join(SHARD)).is_ok());
    }

    #[test]
    fn remove_reports_a_missing_directory() {
        let temp = tempfile::tempdir().unwrap();
        assert!(remove(&temp.path().join("gone"), SHARD).is_err());
    }
}
