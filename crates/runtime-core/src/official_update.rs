//! Run upstream's own `update.sh` / `UPDATE.bat` for a manager-owned installation.
//!
//! Upstream owns version detection, engine downloads, hashes and config migration
//! (`setup.py --update`); this module only gates and streams it. It never forces:
//! a dirty git checkout is refused with upstream's own advice, and the
//! rewritten-history migration stays inside upstream's script.
use crate::{external_management, processes, runtime_upgrade, types::*, RuntimeState};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialUpdatePlan {
    pub script: String,
    pub git_clone: bool,
    pub dirty_files: Vec<String>,
}

pub fn script_name(windows: bool) -> &'static str {
    if windows {
        "UPDATE.bat"
    } else {
        "update.sh"
    }
}

/// Tracked changes only, matching upstream's own `git status --porcelain --untracked-files=no` check.
pub fn parse_porcelain(text: &str) -> Vec<String> {
    text.lines()
        .filter(|line| line.len() > 3)
        .map(|line| line[3..].trim().to_owned())
        .collect()
}

pub fn plan_for(
    root: &Path,
    windows: bool,
    git: impl Fn(&Path) -> Result<String, String>,
) -> Result<OfficialUpdatePlan, String> {
    let script = script_name(windows);
    if !root.join(script).is_file() {
        return Err(format!("此 Strata 版本没有官方更新脚本 {script}；请使用“更新运行环境”或升级到 0.1.36 以上的官方版本"));
    }
    let git_clone = root.join(".git").exists();
    let dirty_files = if git_clone {
        parse_porcelain(&git(root)?)
    } else {
        Vec::new()
    };
    Ok(OfficialUpdatePlan {
        script: script.into(),
        git_clone,
        dirty_files,
    })
}

fn git_status(root: &Path) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .args(["status", "--porcelain", "--untracked-files=no"])
        .current_dir(root);
    processes::hidden(&mut command);
    let output = command.output().map_err(|_| {
        "这是 git 克隆的安装目录，但找不到 git：请先安装 git，或在该目录手动执行 git pull"
            .to_string()
    })?;
    if !output.status.success() {
        return Err(format!(
            "git status 失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub fn dirty_message(files: &[String]) -> String {
    let shown = files.iter().take(8).cloned().collect::<Vec<_>>().join("、");
    format!(
        "安装目录中有 {} 个已跟踪文件被修改（{shown}），官方 git pull --ff-only 会失败，因此未执行任何更新。请先自行保存或还原这些改动（例如 git stash），再重新点击“更新 Strata”。本应用不会强制覆盖。",
        files.len()
    )
}

pub fn step_for(root: &Path, plan: &OfficialUpdatePlan, windows: bool) -> processes::Step {
    // --yes: setup.py's own non-interactive switch; update.sh passes its options to setup.py.
    let (program, mut args) = if windows {
        (
            "cmd".to_owned(),
            vec!["/d".to_owned(), "/c".to_owned(), plan.script.clone()],
        )
    } else {
        (
            "sh".to_owned(),
            vec![root.join(&plan.script).to_string_lossy().into_owned()],
        )
    };
    args.push("--yes".into());
    processes::Step {
        program,
        args,
        cwd: PathBuf::from(root),
        env: Default::default(),
    }
}

pub fn plan(profile: &ServiceProfile) -> Result<OfficialUpdatePlan, String> {
    let root = processes::runtime_dir(profile)?;
    plan_for(&root, cfg!(windows), git_status)
}

pub fn start(state: Arc<RuntimeState>, profile: ServiceProfile) -> Result<TaskStatus, String> {
    let _operation = state.runtime_operations.lock().map_err(|e| e.to_string())?;
    runtime_upgrade::assert_available(&state)?;
    external_management::assert_profile_manager_owned(&state, &profile)?;
    crate::assert_stopped(&state, &profile)?;
    let root = processes::runtime_dir(&profile)?;
    let plan = plan_for(&root, cfg!(windows), git_status)?;
    if !plan.dirty_files.is_empty() {
        return Err(dirty_message(&plan.dirty_files));
    }
    let step = step_for(&root, &plan, cfg!(windows));
    processes::launch_task(
        state.tasks.clone(),
        state.logs.clone(),
        state.database.clone(),
        "officialUpdate",
        Some(profile.id.clone()),
        vec![step],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn porcelain_lists_tracked_changes_only() {
        assert_eq!(
            parse_porcelain(" M serve/server.py\nM  setup.py\n"),
            vec!["serve/server.py", "setup.py"]
        );
        assert!(parse_porcelain("").is_empty());
    }

    #[test]
    fn plan_refuses_missing_script_and_reports_dirty_clone_without_forcing() {
        let temp = tempfile::tempdir().unwrap();
        assert!(plan_for(temp.path(), false, |_| Ok(String::new()))
            .unwrap_err()
            .contains("update.sh"));
        fs::write(temp.path().join("update.sh"), "#!/bin/sh\n").unwrap();
        let plain = plan_for(temp.path(), false, |_| panic!("not a git clone")).unwrap();
        assert_eq!((plain.git_clone, plain.dirty_files.len()), (false, 0));
        fs::create_dir(temp.path().join(".git")).unwrap();
        let dirty = plan_for(temp.path(), false, |_| Ok(" M setup.py\n".into())).unwrap();
        assert_eq!(dirty.dirty_files, vec!["setup.py"]);
        assert!(dirty_message(&dirty.dirty_files).contains("不会强制"));
        assert!(plan_for(temp.path(), false, |_| Err("git missing".into())).is_err());
        assert!(plan_for(temp.path(), true, |_| Ok(String::new()))
            .unwrap_err()
            .contains("UPDATE.bat"));
    }

    #[test]
    fn step_runs_upstream_script_non_interactively_in_the_service_directory() {
        let root = Path::new("/opt/strata");
        let plan = OfficialUpdatePlan {
            script: "update.sh".into(),
            git_clone: true,
            dirty_files: vec![],
        };
        let step = step_for(root, &plan, false);
        assert_eq!(step.program, "sh");
        assert_eq!(
            step.args,
            vec![
                root.join("update.sh").to_string_lossy().into_owned(),
                "--yes".into()
            ]
        );
        assert_eq!(step.cwd, root);
        let windows = step_for(
            root,
            &OfficialUpdatePlan {
                script: "UPDATE.bat".into(),
                ..plan
            },
            true,
        );
        assert_eq!(
            (windows.program.as_str(), windows.args.as_slice()),
            (
                "cmd",
                ["/d", "/c", "UPDATE.bat", "--yes"]
                    .map(String::from)
                    .as_slice()
            )
        );
    }

    #[cfg(unix)]
    #[test]
    fn real_script_receives_the_non_interactive_flag() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("update.sh"),
            "#!/bin/sh\necho \"Getting the newest Strata (git pull) ... $*\"\n",
        )
        .unwrap();
        let plan = plan_for(temp.path(), false, |_| Ok(String::new())).unwrap();
        let output = Command::new(&step_for(temp.path(), &plan, false).program)
            .args(&step_for(temp.path(), &plan, false).args)
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&output.stdout).contains("git pull) ... --yes"));
    }
}
