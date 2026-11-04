//! The DFlash2 drafter for Qwen3.8 (upstream Strata v0.2.10+, strata_control/drafting.py and
//! strata_cli/drafting_cmd.py). Upstream never downloads it on a start: Auto without the file
//! runs MTP, and the file comes only from an explicit `strata drafting fetch`. Manager runs that
//! command from 「下载 DFlash2」 as an ordinary task (progress in the task log, cancellable).
//!
//! What the run page shows as the drafter in use is the live engine command line, not the
//! choice: `server.py` restarts with MTP when DFlash2 fails, so only the argv is the truth.
use crate::{
    processes::{self, Step},
    storage,
    types::{ServiceProfile, TaskStatus},
    RuntimeState,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

/// `<data>/dflash2/`: next to `mtp` in the model data folder (drafting.FOLDER).
const FOLDER: &str = "dflash2";
/// The Q4_0 pack a fetch makes, then the Q8 pack Strata 0.2.9 test builds made (drafting.pack_path).
const PACK_NAMES: [&str; 2] = [
    "qwen3.8-flash-next-dflash2.q4_0.pack",
    "qwen3.8-flash-next-dflash2.q8.pack",
];
/// The upstream command this needs (Strata v0.2.10+).
const COMMAND: &str = "strata_cli/drafting_cmd.py";

/// The model data folder an argument list belongs to (drafting.data_dir_of): `--pack
/// <data>/packs/<tag>`, else `--mtp <data>/mtp/rt`; a numeric `--mtp N` is a count, not a path.
pub fn data_dir_of(args: &[String]) -> Option<PathBuf> {
    for flag in ["--pack", "--mtp"] {
        let Some(index) = args.iter().position(|arg| arg == flag) else {
            continue;
        };
        let Some(value) = args.get(index + 1) else {
            continue;
        };
        let path = Path::new(value);
        if flag == "--mtp"
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| !name.is_empty() && name.bytes().all(|b| b.is_ascii_digit()))
        {
            continue;
        }
        return path.parent().and_then(Path::parent).map(Path::to_path_buf);
    }
    None
}

/// A pack counts only above 1 MiB (drafting._here), so an interrupted file is not "ready".
pub fn pack_ready(data_dir: &Path) -> bool {
    PACK_NAMES.iter().any(|name| {
        let path = data_dir.join(FOLDER).join(name);
        path.metadata()
            .is_ok_and(|meta| meta.is_file() && meta.len() > (1 << 20))
    })
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Dflash2Status {
    /// The drafter file is in this model's data folder; `None` when the folder is not known
    /// from the run config.
    pub ready: Option<bool>,
    /// This runtime has `strata drafting fetch` (Strata v0.2.10+).
    pub fetchable: bool,
}

fn config_args(config: &Value) -> Vec<String> {
    config["args"]
        .as_array()
        .map(|args| {
            args.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

pub fn status(profile: &ServiceProfile) -> Result<Dflash2Status, String> {
    let config = storage::read(profile)?;
    // An external (connect-only) service has no runtime folder to run the command in.
    let fetchable = processes::runtime_dir(profile)
        .is_ok_and(|root| root.join("strata.py").is_file() && root.join(COMMAND).is_file());
    Ok(Dflash2Status {
        ready: data_dir_of(&config_args(&config)).map(|data| pack_ready(&data)),
        fetchable,
    })
}

/// `python -u strata.py drafting fetch --config <run config> --output jsonl`: the run config
/// names the data folder; progress lines are `{"event":"progress",...}`, the last line the result.
pub fn fetch_step(profile: &ServiceProfile) -> Result<Step, String> {
    let root = processes::runtime_dir(profile)?;
    if !root.join("strata.py").is_file() || !root.join(COMMAND).is_file() {
        return Err("此运行环境没有 DFlash2 下载命令，需要 Strata v0.2.10 或更新版本 / This runtime has no DFlash2 download command; it needs Strata v0.2.10 or newer".into());
    }
    let python = PathBuf::from(processes::python(profile)?);
    if !python.is_absolute() || !python.is_file() {
        return Err("此运行环境未登记可用的 Python，请先准备完整运行环境".into());
    }
    let config = storage::config_path(profile)?;
    if !config.is_file() {
        return Err("运行配置文件不存在，请重新选择配置".into());
    }
    Ok(Step {
        program: python.to_string_lossy().into_owned(),
        args: vec![
            "-u".into(),
            "strata.py".into(),
            "drafting".into(),
            "fetch".into(),
            "--config".into(),
            config.to_string_lossy().into_owned(),
            "--output".into(),
            "jsonl".into(),
        ],
        cwd: root,
        env: Default::default(),
    })
}

pub fn start(state: Arc<RuntimeState>, profile: ServiceProfile) -> Result<TaskStatus, String> {
    let step = fetch_step(&profile)?;
    let _operation = state.runtime_operations.lock().map_err(|e| e.to_string())?;
    crate::runtime_upgrade::assert_available(&state)?;
    processes::launch_task(
        state.tasks.clone(),
        state.logs.clone(),
        state.database.clone(),
        "dflash2-fetch",
        Some(profile.id),
        vec![step],
    )
}

/// The drafter the running engine actually uses, from its verified command line.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunningDrafting {
    pub verified: bool,
    /// `dflash2`, `mtp` or `off`; absent when the command line could not be verified.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drafter: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub fn running(state: &RuntimeState, profile_id: &str) -> RunningDrafting {
    match crate::chat_runtime::verified_startup(state, profile_id) {
        Ok(startup) => RunningDrafting {
            verified: true,
            drafter: Some(crate::benchmark_identity::effective_drafting(&startup.args)),
            reason: None,
        },
        Err(reason) => RunningDrafting {
            verified: false,
            drafter: None,
            reason: Some(reason),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owned(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| (*arg).to_owned()).collect()
    }

    #[test]
    fn the_data_folder_comes_from_the_pack_then_the_mtp_layer() {
        assert_eq!(
            data_dir_of(&owned(&["--pack", "/d/packs/iq3", "--mtp", "/x/mtp/rt"])),
            Some(PathBuf::from("/d"))
        );
        assert_eq!(
            data_dir_of(&owned(&["--mtp", "/d/mtp/rt"])),
            Some(PathBuf::from("/d"))
        );
        assert_eq!(data_dir_of(&owned(&["--mtp", "3"])), None);
        assert_eq!(data_dir_of(&owned(&["--mtp"])), None);
        assert_eq!(data_dir_of(&owned(&["--ctx", "8192"])), None);
    }

    #[test]
    fn only_a_complete_pack_is_ready() {
        let temp = tempfile::tempdir().unwrap();
        assert!(!pack_ready(temp.path()));
        let folder = temp.path().join(FOLDER);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join(PACK_NAMES[0]), b"partial").unwrap();
        assert!(
            !pack_ready(temp.path()),
            "a file of 1 MiB or less is not a pack"
        );
        let file = std::fs::File::create(folder.join(PACK_NAMES[1])).unwrap();
        file.set_len((1 << 20) + 1).unwrap();
        assert!(pack_ready(temp.path()), "the legacy Q8 pack still counts");
    }
}
