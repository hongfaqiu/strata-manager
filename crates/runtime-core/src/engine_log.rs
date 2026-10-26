//! Engine log preflight and fallback (Xiaohongshu feedback, Windows):
//! upstream `serve/server.py` opens `cfg["log"]` in append mode and an older
//! release dies with `PermissionError: [Errno 13]` when that file is locked by
//! a leftover process, read-only, denied by an ACL or blocked by security
//! software. Manager tries the same append open first and, when it fails,
//! points the configuration at a fresh writable file instead of letting the
//! engine fail and the auto recovery retry the same file three times.
use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
    sync::Mutex,
};

/// Startup code for a log file the engine cannot write.
pub const CODE: &str = "STARTUP_LOG_UNWRITABLE";
/// Replacement logs kept per directory; older `<name>-<stamp>.log` files are removed.
pub const KEEP_FALLBACK_LOGS: usize = 3;

pub const UNWRITABLE_MESSAGE: &str = "日志文件被占用或无权限：Strata 引擎写不进它的日志文件。请依次尝试：1）退出 Manager，结束残留的 python / strata 进程（Windows 在任务管理器里）；2）删除该日志文件，或在文件属性里取消「只读」；3）确认当前用户对该文件夹有完全控制权限；4）临时退出 360、火绒等安全软件，或把 Strata 目录加入白名单；5）若 Strata 版本较旧（如 v0.2.1.x），建议升级到最新版。 / Log file in use or not writable: the Strata engine cannot write its log file. Try: 1) quit Manager and end leftover python / strata processes (Task Manager on Windows); 2) delete the log file or clear its Read-only attribute; 3) make sure your user has Full control of the folder; 4) temporarily quit security software such as 360 or Huorong, or allow the Strata folder; 5) if Strata is old (such as v0.2.1.x), upgrade to the latest release.";

/// Profiles whose next start must not reuse the configured log, because the
/// engine itself reported it could not write it.
static FORCED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

pub fn request_fallback(profile_id: &str) {
    if let Ok(mut forced) = FORCED.lock() {
        forced
            .get_or_insert_with(Default::default)
            .insert(profile_id.to_owned());
    }
}

pub fn take_fallback_request(profile_id: &str) -> bool {
    FORCED
        .lock()
        .ok()
        .and_then(|mut forced| forced.as_mut().map(|set| set.remove(profile_id)))
        .unwrap_or(false)
}

/// Engine output (or an error) saying a `.log` file could not be opened.
pub fn is_permission_error(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    (lower.contains("permissionerror") || lower.contains("errno 13")) && lower.contains(".log")
}

/// The same open upstream performs (`open(path, "a")`), closed immediately.
/// Like upstream it creates the file but never a missing folder.
pub fn appendable(path: &Path) -> io::Result<()> {
    if path.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "日志路径是一个目录",
        ));
    }
    if path.exists() {
        return fs::OpenOptions::new().append(true).open(path).map(drop);
    }
    // Probe a missing log without leaving it behind: Manager must not add
    // files to the user's folder; the engine creates it when it starts.
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(drop)?;
    let _ = fs::remove_file(path);
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
    pub path: PathBuf,
    /// Set when `path` replaces the configured log: why the original was skipped.
    pub replaced: Option<String>,
}

/// `engine` for `engine.log` and for an earlier replacement `engine-<stamp>.log`.
fn base_name(path: &Path) -> String {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "engine".into());
    match stem.rsplit_once('-') {
        Some((base, stamp))
            if !base.is_empty()
                && stamp.len() >= 10
                && stamp.bytes().all(|b| b.is_ascii_digit()) =>
        {
            base.to_owned()
        }
        _ => stem,
    }
}

fn is_replacement(name: &str, base: &str) -> Option<u64> {
    let stamp = name
        .strip_prefix(base)?
        .strip_prefix('-')?
        .strip_suffix(".log")?;
    (stamp.len() >= 10 && stamp.bytes().all(|b| b.is_ascii_digit()))
        .then(|| stamp.parse().ok())
        .flatten()
}

/// Keep the configured log unless it cannot be opened for appending (or
/// `force`), then try `<base>-<stamp>.log` beside it and in each fallback
/// directory in order. `Err` lists every attempt when nothing is writable.
pub fn choose(
    original: &Path,
    fallback_dirs: &[PathBuf],
    stamp: u64,
    force: bool,
    probe: impl Fn(&Path) -> io::Result<()>,
) -> Result<Choice, String> {
    let reason = if force {
        "引擎报告无法写入该日志 / the engine reported it cannot write this log".to_owned()
    } else {
        match probe(original) {
            Ok(()) => {
                return Ok(Choice {
                    path: original.to_path_buf(),
                    replaced: None,
                })
            }
            Err(error) => error.to_string(),
        }
    };
    let base = base_name(original);
    let mut attempts = vec![format!("{}: {reason}", original.display())];
    let mut directories: Vec<PathBuf> = original
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .into_iter()
        .collect();
    for directory in fallback_dirs {
        if !directories.contains(directory) {
            directories.push(directory.clone());
        }
    }
    let beside = original.parent().map(Path::to_path_buf);
    for directory in directories {
        // Manager's own fallback folders may not exist yet; never create the
        // configured log's folder, which upstream would not create either.
        if Some(&directory) != beside.as_ref() {
            let _ = fs::create_dir_all(&directory);
        }
        let mut stamp = stamp;
        let mut candidate = directory.join(format!("{base}-{stamp}.log"));
        while candidate.exists() || candidate == original {
            stamp += 1;
            candidate = directory.join(format!("{base}-{stamp}.log"));
        }
        match probe(&candidate) {
            Ok(()) => {
                return Ok(Choice {
                    path: candidate,
                    replaced: Some(reason),
                })
            }
            Err(error) => attempts.push(format!("{}: {error}", candidate.display())),
        }
    }
    Err(attempts.join("；"))
}

/// Remove all but the newest `keep` replacement logs of `base` in `directory`,
/// never touching `protect` (the active and the configured file).
pub fn prune(directory: &Path, base: &str, keep: usize, protect: &[&Path]) -> usize {
    let Ok(entries) = fs::read_dir(directory) else {
        return 0;
    };
    let mut found: Vec<(u64, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| {
            let stamp = is_replacement(&entry.file_name().to_string_lossy(), base)?;
            Some((stamp, entry.path()))
        })
        .collect();
    found.sort_by_key(|item| std::cmp::Reverse(item.0));
    let mut removed = 0;
    let mut kept = 0;
    for (_, path) in found {
        if protect.iter().any(|item| *item == path) {
            continue;
        }
        if kept < keep {
            kept += 1;
            continue;
        }
        if fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

pub fn base_of(path: &Path) -> String {
    base_name(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn blocking(blocked: Vec<PathBuf>) -> impl Fn(&Path) -> io::Result<()> {
        let seen = RefCell::new(Vec::<PathBuf>::new());
        move |path: &Path| {
            seen.borrow_mut().push(path.to_path_buf());
            if blocked
                .iter()
                .any(|item| path.starts_with(item) || item == path)
            {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "Access is denied",
                ))
            } else {
                appendable(path)
            }
        }
    }

    #[test]
    fn writable_log_is_kept_without_creating_a_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let original = temp.path().join("engine.log");
        fs::write(&original, "old session\n").unwrap();
        let choice = choose(
            &original,
            &[temp.path().join("fallback")],
            1_000_000_000_000,
            false,
            appendable,
        )
        .unwrap();
        assert_eq!(
            choice,
            Choice {
                path: original.clone(),
                replaced: None
            }
        );
        assert_eq!(fs::read_to_string(&original).unwrap(), "old session\n");
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[test]
    fn unwritable_log_is_replaced_by_a_stamped_file_in_the_same_directory() {
        let temp = tempfile::tempdir().unwrap();
        let original = temp.path().join("engine.log");
        let choice = choose(
            &original,
            &[temp.path().join("fallback")],
            1_761_480_000_000,
            false,
            blocking(vec![original.clone()]),
        )
        .unwrap();
        assert_eq!(choice.path, temp.path().join("engine-1761480000000.log"));
        assert!(choice.replaced.unwrap().contains("Access is denied"));
        // The probe leaves nothing behind; the engine creates the file itself.
        assert!(!choice.path.exists());
    }

    #[test]
    fn unwritable_directory_falls_back_to_the_manager_directory_then_temp() {
        let temp = tempfile::tempdir().unwrap();
        let imports = temp.path().join("imports/local-1");
        let manager = temp.path().join("manager-logs");
        let other = temp.path().join("tmp");
        let original = imports.join("engine.log");
        let choice = choose(
            &original,
            &[manager.clone(), other.clone()],
            1_761_480_000_000,
            false,
            blocking(vec![imports.clone()]),
        )
        .unwrap();
        assert_eq!(choice.path, manager.join("engine-1761480000000.log"));
        let choice = choose(
            &original,
            &[manager.clone(), other.clone()],
            1_761_480_000_000,
            false,
            blocking(vec![imports.clone(), manager.clone()]),
        )
        .unwrap();
        assert_eq!(choice.path, other.join("engine-1761480000000.log"));
        let error = choose(
            &original,
            std::slice::from_ref(&manager),
            1_761_480_000_000,
            false,
            blocking(vec![imports, manager.clone()]),
        )
        .unwrap_err();
        assert_eq!(error.matches("Access is denied").count(), 3);
    }

    #[test]
    fn forced_fallback_skips_a_log_the_engine_could_not_open_and_strips_old_stamps() {
        let temp = tempfile::tempdir().unwrap();
        let original = temp.path().join("engine-1761480000000.log");
        fs::write(&original, "").unwrap();
        let choice = choose(&original, &[], 1_761_480_000_000, true, appendable).unwrap();
        assert_eq!(choice.path, temp.path().join("engine-1761480000001.log"));
        assert!(choice.replaced.is_some());
    }

    #[cfg(unix)]
    #[test]
    fn read_only_file_on_disk_is_detected_by_the_real_probe() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let original = temp.path().join("engine.log");
        fs::write(&original, "").unwrap();
        fs::set_permissions(&original, fs::Permissions::from_mode(0o444)).unwrap();
        let choice = choose(&original, &[], 1_761_480_000_000, false, appendable).unwrap();
        assert_eq!(choice.path, temp.path().join("engine-1761480000000.log"));
        fs::set_permissions(&original, fs::Permissions::from_mode(0o644)).unwrap();
    }

    #[test]
    fn prune_keeps_the_newest_replacements_and_protected_files() {
        let temp = tempfile::tempdir().unwrap();
        for stamp in 1_761_480_000_001u64..=1_761_480_000_006 {
            fs::write(temp.path().join(format!("engine-{stamp}.log")), "").unwrap();
        }
        fs::write(temp.path().join("engine.log"), "").unwrap();
        fs::write(temp.path().join("engine-notes.log"), "").unwrap();
        let protected = temp.path().join("engine-1761480000001.log");
        assert_eq!(
            prune(temp.path(), "engine", KEEP_FALLBACK_LOGS, &[&protected]),
            2
        );
        let mut left: Vec<_> = fs::read_dir(temp.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                "engine-1761480000001.log",
                "engine-1761480000004.log",
                "engine-1761480000005.log",
                "engine-1761480000006.log",
                "engine-notes.log",
                "engine.log"
            ]
        );
    }

    #[test]
    fn permission_errors_on_log_files_are_recognised() {
        assert!(is_permission_error(
            r"PermissionError: [Errno 13] Permission denied: 'C:\\Users\\a\\AppData\\Roaming\\io.strata.manager\\imports\\local-7d19ff0a40acf041\\engine.log'"
        ));
        assert!(is_permission_error(
            "OSError: [Errno 13] Permission denied: '/x/strata.LOG'"
        ));
        assert!(!is_permission_error(
            "PermissionError: [Errno 13] Permission denied: 'model.gguf'"
        ));
        assert!(!is_permission_error("engine.log written"));
    }

    #[test]
    fn fallback_requests_are_taken_once_per_profile() {
        request_fallback("engine-log-test-profile");
        assert!(!take_fallback_request("engine-log-other-profile"));
        assert!(take_fallback_request("engine-log-test-profile"));
        assert!(!take_fallback_request("engine-log-test-profile"));
    }
}
