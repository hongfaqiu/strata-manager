//! Trial start of a freshly installed engine (upstream's "test start" without a model).
//!
//! After the new program files are in place each updated engine runs once with `--version`
//! from its own folder, its libraries on the search path. It must load, its GPU runtime
//! libraries must resolve and it must answer. A failure restores every replaced file before
//! anything restarts, so the previous engine stays the installed one. Services that were
//! running then restart and pass `/health` (and `/load`) as before: the full trial.
use super::{apply, rollback_files, Change};
use serde_json::Value;
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const TRIAL_TIMEOUT: Duration = Duration::from_secs(120);
const OUTPUT_LIMIT: u64 = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct TrialOutput {
    pub code: Option<i32>,
    pub text: String,
}

pub(super) fn engine_executable(directory: &Path) -> PathBuf {
    directory.join(if cfg!(windows) {
        "strata.exe"
    } else {
        "strata"
    })
}

/// The engine folder, then BUILD.json `lib_dirs` (relative, inside the folder, existing).
pub(in crate::runtime_upgrade) fn library_dirs(directory: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![directory.to_path_buf()];
    let names = fs::read(directory.join("BUILD.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|build| build["lib_dirs"].as_array().cloned())
        .unwrap_or_default();
    for name in names.iter().filter_map(Value::as_str).take(8) {
        let relative = Path::new(name);
        if name.is_empty()
            || relative.is_absolute()
            || relative
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            continue;
        }
        let path = directory.join(relative);
        if path.is_dir() {
            dirs.push(path);
        }
    }
    dirs
}

fn tail(path: &Path) -> String {
    let bytes = fs::read(path).unwrap_or_default();
    let start = bytes.len().saturating_sub(OUTPUT_LIMIT as usize);
    String::from_utf8_lossy(&bytes[start..]).into_owned()
}

/// Run `<engine> --version` once from its folder. Output goes to files, never a pipe that
/// could fill up; a hung engine is killed at the deadline.
pub(super) fn run_engine_version(directory: &Path) -> Result<TrialOutput, String> {
    let executable = engine_executable(directory);
    if !executable.is_file() {
        return Err(format!(
            "找不到引擎程序 {} / Engine program {} is missing",
            executable.display(),
            executable.display()
        ));
    }
    let scratch = tempfile::tempdir().map_err(|e| e.to_string())?;
    let stdout = scratch.path().join("stdout");
    let stderr = scratch.path().join("stderr");
    let variable = if cfg!(windows) {
        "PATH"
    } else {
        "LD_LIBRARY_PATH"
    };
    let mut paths = library_dirs(directory);
    if let Some(existing) = std::env::var_os(variable) {
        paths.extend(std::env::split_paths(&existing));
    }
    let mut command = Command::new(&executable);
    command
        .arg("--version")
        .current_dir(directory)
        .env(
            variable,
            std::env::join_paths(paths).map_err(|e| e.to_string())?,
        )
        .stdin(Stdio::null())
        .stdout(File::create(&stdout).map_err(|e| e.to_string())?)
        .stderr(File::create(&stderr).map_err(|e| e.to_string())?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法运行引擎 / The engine could not run\n{e}"))?;
    let deadline = Instant::now() + TRIAL_TIMEOUT;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "引擎在 {} 秒内没有响应 --version / The engine did not answer --version within {} s",
                TRIAL_TIMEOUT.as_secs(),
                TRIAL_TIMEOUT.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    Ok(TrialOutput {
        code: status.code(),
        text: format!("{}\n{}", tail(&stdout), tail(&stderr)),
    })
}

/// How much of a failed trial's output is kept in the failure reason, counted from the end.
const FAILURE_TAIL_CHARS: usize = 1000;

/// The last `limit` characters of `text` (cut on a character boundary), marked with `…` when cut.
fn last_chars(text: &str, limit: usize) -> String {
    let count = text.chars().count();
    if count <= limit {
        return text.to_owned();
    }
    let start = text
        .char_indices()
        .nth(count - limit)
        .map_or(text.len(), |(index, _)| index);
    format!("…{}", &text[start..])
}

/// Upstream's rule: exit 0 passes; an engine built before `--version` existed prints its
/// usage (at least five of its own options) and exits 2, which proves it loaded too.
pub(super) fn judge(output: &TrialOutput) -> Result<String, String> {
    let lines = || output.text.lines().map(str::trim).filter(|l| !l.is_empty());
    match output.code {
        Some(0) => Ok(lines().next().unwrap_or("ok").chars().take(200).collect()),
        Some(2)
            if output
                .text
                .lines()
                .filter(|line| {
                    let line = line.trim_start();
                    line.starts_with("--")
                        && line[2..]
                            .chars()
                            .next()
                            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                })
                .count()
                >= 5 =>
        {
            Ok("engine loaded and listed its options".into())
        }
        code => {
            // The real error is usually last, after a long path or a banner: keep the end (upstream #4727).
            let joined = lines().collect::<Vec<_>>().join("\n");
            let last = if joined.is_empty() {
                "(no output)".to_owned()
            } else {
                last_chars(&joined, FAILURE_TAIL_CHARS)
            };
            Err(match code {
                Some(code) => format!("--version 退出码 {code} / --version exited {code}\n{last}"),
                None => format!("引擎被系统终止 / The engine was killed by a signal\n{last}"),
            })
        }
    }
}

/// Run every updated engine directory once. Returns the first failure's reason.
pub(super) fn trial_engines(
    root: &Path,
    directories: &[PathBuf],
    runner: &dyn Fn(&Path) -> Result<TrialOutput, String>,
) -> Result<Vec<String>, String> {
    let mut passed = Vec::new();
    let mut seen = Vec::new();
    for directory in directories {
        if seen.contains(directory) {
            continue;
        }
        seen.push(directory.clone());
        let path = root.join(directory);
        let label = super::portable(directory);
        let output = runner(&path).map_err(|e| format!("{label}: {e}"))?;
        let detail = judge(&output).map_err(|e| format!("{label}: {e}"))?;
        passed.push(format!("{label}: {detail}"));
    }
    Ok(passed)
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ApplyFailure {
    /// Replacing files failed; the caller's rollback restores what was replaced.
    Apply(String),
    /// The new engine failed its trial; the replaced files were already restored.
    Trial(String),
}

/// Replace the program files, then trial-start the new engine. On a failed trial every
/// replaced file is restored before returning; the update's own rollback repeats this
/// idempotently and restarts the services that were running.
pub(super) fn apply_and_trial(
    root: &Path,
    work: &Path,
    changes: &[Change],
    directories: &[PathBuf],
    runner: &dyn Fn(&Path) -> Result<TrialOutput, String>,
    check: impl Fn() -> Result<(), String>,
) -> Result<Vec<String>, ApplyFailure> {
    apply(root, work, changes, &check).map_err(ApplyFailure::Apply)?;
    match trial_engines(root, directories, runner) {
        Ok(passed) => Ok(passed),
        Err(reason) => {
            // A failed restore is reported by the caller's rollback, which repeats it.
            let _ = rollback_files(root, work, changes);
            Err(ApplyFailure::Trial(reason))
        }
    }
}

/// Engine version installed before the update (default engine folder first).
pub(super) fn installed_engine_version(root: &Path, directories: &[PathBuf]) -> Option<String> {
    directories.iter().find_map(|directory| {
        let bytes = fs::read(root.join(directory).join("BUILD.json")).ok()?;
        let build: Value = serde_json::from_slice(&bytes).ok()?;
        build["version"]
            .as_str()
            .filter(|v| super::engine_package::valid_version(v))
            .map(str::to_owned)
    })
}

/// The bilingual message of an update undone by a failed trial start.
pub(super) fn failure_message(previous: Option<&str>, reason: &str) -> String {
    match previous {
        Some(version) => format!(
            "新引擎试启动未通过，已自动恢复原版本 {version}，模型与配置未改动 / The new engine failed its trial start; the previous version {version} was restored and models and settings are unchanged. 原因 / Reason: {reason}"
        ),
        None => format!(
            "新引擎试启动未通过，已撤销本次安装，模型与配置未改动 / The new engine failed its trial start; this installation was undone and models and settings are unchanged. 原因 / Reason: {reason}"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::super::add_change;
    use super::*;

    fn output(code: Option<i32>, text: &str) -> TrialOutput {
        TrialOutput {
            code,
            text: text.into(),
        }
    }

    #[test]
    fn trial_judgement_follows_upstream() {
        assert_eq!(
            judge(&output(Some(0), "strata 0.1.45.3\n")).unwrap(),
            "strata 0.1.45.3"
        );
        let usage = "usage: strata [options]\n  --model\n  --ctx\n  --port\n  --pcie-frac\n  --split-device\n";
        assert!(judge(&output(Some(2), usage)).is_ok());
        assert!(judge(&output(Some(2), "  --model\n  --ctx\n")).is_err());
        let error = judge(&output(
            Some(127),
            "./strata: error while loading shared libraries: libcuda.so.1: cannot open shared object file\n",
        ))
        .unwrap_err();
        assert!(
            error.contains("127") && error.contains("libcuda.so.1"),
            "{error}"
        );
        assert!(judge(&output(None, "")).unwrap_err().contains("signal"));
    }

    #[test]
    fn a_failed_trial_keeps_the_end_of_the_output() {
        // A long path first, the real error last: the old 300-character head lost the error.
        let path = format!("C:\\Users\\用户\\{}\\strata.exe", "很长的目录".repeat(300));
        let text = format!("loading {path}\nstrata: error: unknown argument --eos (exit 2)\n");
        let error = judge(&output(Some(1), &text)).unwrap_err();
        assert!(
            error.ends_with("unknown argument --eos (exit 2)"),
            "{error}"
        );
        let kept = error.lines().skip(1).collect::<Vec<_>>().join("\n");
        assert_eq!(kept.chars().count(), FAILURE_TAIL_CHARS + 1, "{kept}");
        assert!(kept.starts_with('…'));
        // Earlier lines survive when there is room; short output is kept whole.
        let error = judge(&output(Some(3), "first line\n\nsecond line\n")).unwrap_err();
        assert!(error.ends_with("first line\nsecond line"), "{error}");
        assert!(judge(&output(Some(3), "  \n"))
            .unwrap_err()
            .contains("(no output)"));
        assert_eq!(last_chars("一二三四", 2), "…三四");
        assert_eq!(last_chars("abc", 3), "abc");
    }

    fn engine_fixture(root: &Path, work: &Path, version: &str) -> Vec<Change> {
        fs::create_dir_all(root.join("engine")).unwrap();
        fs::write(root.join("engine/BUILD.json"), r#"{"version":"0.1.41"}"#).unwrap();
        fs::write(root.join("engine/strata.bin"), b"old engine").unwrap();
        for part in ["replacement", "backup", "staged/engine"] {
            fs::create_dir_all(work.join(part)).unwrap();
        }
        fs::write(
            work.join("staged/engine/BUILD.json"),
            format!(r#"{{"version":"{version}"}}"#),
        )
        .unwrap();
        fs::write(work.join("staged/engine/strata.bin"), b"new engine").unwrap();
        fs::write(work.join("staged/engine/libnew.so.1"), b"new lib").unwrap();
        let mut changes = Vec::new();
        for file in ["BUILD.json", "strata.bin", "libnew.so.1"] {
            add_change(
                root,
                work,
                &format!("engine/{file}"),
                &work.join("staged/engine").join(file),
                &mut changes,
            )
            .unwrap();
        }
        changes
    }

    #[test]
    fn a_failed_trial_restores_the_previous_engine_before_returning() {
        let temp = tempfile::tempdir().unwrap();
        let (root, work) = (temp.path().join("runtime"), temp.path().join("work"));
        let changes = engine_fixture(&root, &work, "0.1.45.3");
        let directories = vec![PathBuf::from("engine")];
        assert_eq!(
            installed_engine_version(&root, &directories).as_deref(),
            Some("0.1.41")
        );
        let seen = std::cell::RefCell::new(Vec::new());
        let failing = |dir: &Path| {
            // The trial sees the new files in place.
            seen.borrow_mut()
                .push(fs::read(dir.join("strata.bin")).unwrap());
            Ok(output(
                Some(127),
                "error while loading shared libraries: libcuda.so.1",
            ))
        };
        let failure =
            apply_and_trial(&root, &work, &changes, &directories, &failing, || Ok(())).unwrap_err();
        let ApplyFailure::Trial(reason) = failure else {
            panic!("expected a trial failure");
        };
        assert!(
            reason.starts_with("engine: ") && reason.contains("libcuda.so.1"),
            "{reason}"
        );
        assert_eq!(seen.into_inner(), vec![b"new engine".to_vec()]);
        // Everything is back: old engine and BUILD.json, the added library removed.
        assert_eq!(
            fs::read(root.join("engine/strata.bin")).unwrap(),
            b"old engine"
        );
        assert_eq!(
            installed_engine_version(&root, &directories).as_deref(),
            Some("0.1.41")
        );
        assert!(!root.join("engine/libnew.so.1").exists());
        // The update's own rollback can repeat the restore safely.
        rollback_files(&root, &work, &changes).unwrap();
        let message = failure_message(Some("0.1.41"), &reason);
        assert!(
            message.contains("已自动恢复原版本 0.1.41")
                && message.contains("previous version 0.1.41 was restored")
        );
        assert!(message.contains("libcuda.so.1"));
        assert!(failure_message(None, "x").contains("installation was undone"));
    }

    #[test]
    fn a_passing_trial_keeps_the_new_engine() {
        let temp = tempfile::tempdir().unwrap();
        let (root, work) = (temp.path().join("runtime"), temp.path().join("work"));
        let changes = engine_fixture(&root, &work, "0.1.45.3");
        let directories = vec![PathBuf::from("engine"), PathBuf::from("engine")];
        let calls = std::cell::Cell::new(0);
        let passing = |_: &Path| {
            calls.set(calls.get() + 1);
            Ok(output(Some(0), "strata 0.1.45.3"))
        };
        let passed =
            apply_and_trial(&root, &work, &changes, &directories, &passing, || Ok(())).unwrap();
        assert_eq!(passed, vec!["engine: strata 0.1.45.3".to_owned()]);
        assert_eq!(calls.get(), 1, "each directory runs once");
        assert_eq!(
            fs::read(root.join("engine/strata.bin")).unwrap(),
            b"new engine"
        );
        assert_eq!(
            installed_engine_version(&root, &directories).as_deref(),
            Some("0.1.45.3")
        );
        // The backup of the previous engine is kept after success.
        assert_eq!(
            fs::read(work.join("backup/engine/strata.bin")).unwrap(),
            b"old engine"
        );
    }

    #[test]
    fn a_runner_error_is_a_trial_failure_too() {
        let temp = tempfile::tempdir().unwrap();
        let (root, work) = (temp.path().join("runtime"), temp.path().join("work"));
        let changes = engine_fixture(&root, &work, "0.1.45.3");
        let missing = |_: &Path| Err("找不到引擎程序 / Engine program is missing".to_owned());
        assert!(matches!(
            apply_and_trial(
                &root,
                &work,
                &changes,
                &[PathBuf::from("engine")],
                &missing,
                || Ok(())
            ),
            Err(ApplyFailure::Trial(_))
        ));
        assert_eq!(
            fs::read(root.join("engine/strata.bin")).unwrap(),
            b"old engine"
        );
    }

    /// The real runner against real processes (shell scripts stand in for the engine).
    #[cfg(unix)]
    #[test]
    fn the_real_runner_reports_exit_codes_libraries_and_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("engine");
        fs::create_dir_all(dir.join("lib64")).unwrap();
        fs::write(
            dir.join("BUILD.json"),
            r#"{"version":"0.1.45.3","lib_dirs":["lib64","../escape","/abs"]}"#,
        )
        .unwrap();
        let script = |body: &str| {
            fs::write(dir.join("strata"), format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(dir.join("strata"), fs::Permissions::from_mode(0o755)).unwrap();
        };
        script(r#"echo "strata 0.1.45.3 $LD_LIBRARY_PATH""#);
        let out = run_engine_version(&dir).unwrap();
        assert_eq!(out.code, Some(0));
        let first = out.text.lines().next().unwrap().to_owned();
        assert!(first.starts_with("strata 0.1.45.3 "), "{first}");
        let paths: Vec<_> = first["strata 0.1.45.3 ".len()..].split(':').collect();
        assert_eq!(paths[0], dir.to_string_lossy());
        assert_eq!(paths[1], dir.join("lib64").to_string_lossy());
        assert!(!first.contains("escape") && !first.contains(":/abs"));
        script("echo 'libcuda.so.1: cannot open shared object file' >&2; exit 127");
        let error = judge(&run_engine_version(&dir).unwrap()).unwrap_err();
        assert!(
            error.contains("127") && error.contains("libcuda.so.1"),
            "{error}"
        );
        fs::set_permissions(dir.join("strata"), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(run_engine_version(&dir)
            .unwrap_err()
            .contains("could not run"));
        fs::remove_file(dir.join("strata")).unwrap();
        assert!(run_engine_version(&dir).unwrap_err().contains("missing"));
    }
}
