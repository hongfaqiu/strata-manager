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
/// Stock and legacy DFlash2 pack filenames (drafting.PACK_NAME / CONVERTED_NAME / LEGACY_PACK_NAME).
pub const STOCK_PACK_NAMES: [&str; 3] = [
    "qwen3.8-flash-next-dflash2.q4_0-selq4.pack",
    "qwen3.8-flash-next-dflash2.q4_0.pack",
    "qwen3.8-flash-next-dflash2.q8.pack",
];
/// Tuned DFlash2 pack filenames added in Strata v0.2.12 (drafting.TUNED_NAME / TUNED_BF16_NAME).
pub const TUNED_PACK_NAMES: [&str; 2] = [
    "qwen3.8-flash-next-dflash2.strata1.q4_0-selq4.pack",
    "qwen3.8-flash-next-dflash2.strata1.q4_0-bf16sel.pack",
];
/// Every recognised DFlash2 runtime pack file in `<data>/dflash2/`.
pub const PACK_NAMES: [&str; 5] = [
    "qwen3.8-flash-next-dflash2.strata1.q4_0-selq4.pack",
    "qwen3.8-flash-next-dflash2.strata1.q4_0-bf16sel.pack",
    "qwen3.8-flash-next-dflash2.q4_0-selq4.pack",
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

fn any_pack_in(data_dir: &Path, names: &[&str]) -> bool {
    names.iter().any(|name| {
        let path = data_dir.join(FOLDER).join(name);
        path.metadata()
            .is_ok_and(|meta| meta.is_file() && meta.len() > (1 << 20))
    })
}

/// A pack counts only above 1 MiB (drafting._here), so an interrupted file is not "ready".
pub fn pack_ready(data_dir: &Path) -> bool {
    any_pack_in(data_dir, &PACK_NAMES)
}

pub fn stock_pack_ready(data_dir: &Path) -> bool {
    any_pack_in(data_dir, &STOCK_PACK_NAMES)
}

pub fn tuned_pack_ready(data_dir: &Path) -> bool {
    any_pack_in(data_dir, &TUNED_PACK_NAMES)
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Dflash2Plan {
    pub ready: bool,
    pub needed: bool,
    pub tuned: bool,
    pub tuned_update: bool,
    pub gb: f64,
    pub download_gb: f64,
    pub disk_gb: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vram_gb: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selq4: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pack: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drafter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub choice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub support: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub support_line: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Dflash2Status {
    /// A usable drafter file is in this model's data folder; `None` when the folder is not known
    /// from the run config and `drafting plan` could not run.
    pub ready: Option<bool>,
    /// This runtime has `strata drafting fetch` (Strata v0.2.10+).
    pub fetchable: bool,
    /// True when a stock pack is already usable on disk (`ready == Some(true)`) while `drafting plan`
    /// reports a tuned `.strata1.` update is still needed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tuned_update: Option<bool>,
    /// Structured output from `strata.py drafting plan --config ... --output jsonl`, when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<Dflash2Plan>,
}

fn config_args(config: &Value) -> Vec<String> {
    crate::tuning::effective_args_of(config).unwrap_or_else(|_| {
        config["args"]
            .as_array()
            .map(|args| {
                args.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    })
}

fn parse_gb_from_text(text: &str) -> Option<f64> {
    let marker = " GB to download";
    let end = text.find(marker)?;
    let prefix = text[..end].trim_end();
    let token = prefix.rsplit_once(' ').map(|(_, n)| n).unwrap_or(prefix);
    token.parse::<f64>().ok().filter(|v| *v > 0.0)
}

/// Parses the JSONL output of `strata.py drafting plan --config ... --output jsonl`.
pub fn parse_plan_output(stdout: &str, disk_ready: Option<bool>) -> Option<Dflash2Plan> {
    for line in stdout.lines().rev() {
        let trimmed = line.trim();
        if !trimmed.starts_with('{') {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if row.get("ok").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let Some(ready) = row.get("ready").and_then(Value::as_bool) else {
            continue;
        };
        let needed = row.get("needed").and_then(Value::as_bool).unwrap_or(!ready);
        let gb = row.get("gb").and_then(Value::as_f64).unwrap_or(0.0);
        let vram_gb = row.get("vram_gb").and_then(Value::as_f64);
        let selq4 = row.get("selq4").and_then(Value::as_bool);
        let pack = row.get("pack").and_then(Value::as_str).map(str::to_owned);
        let repo = row.get("repo").and_then(Value::as_str).map(str::to_owned);
        let drafter = row.get("drafter").and_then(Value::as_str).map(str::to_owned);
        let choice = row.get("choice").and_then(Value::as_str).map(str::to_owned);
        let note = row.get("note").and_then(Value::as_str).map(str::to_owned);
        let line_text = row.get("line").and_then(Value::as_str).map(str::to_owned);
        let support = row.get("support").and_then(Value::as_str).map(str::to_owned);
        let support_line = row
            .get("support_line")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let text = row.get("text").and_then(Value::as_str).map(str::to_owned);
        let is_bf16_tuned = pack.as_deref().is_some_and(|p| p.contains("bf16sel"));
        let tuned = text.as_deref().is_some_and(|t| {
            t.contains("signed update feed") || t.contains("Strata tuned")
        }) || pack.as_deref().is_some_and(|p| p.contains(".strata1."));
        let default_dl_gb = if tuned {
            if is_bf16_tuned {
                0.52
            } else {
                0.34
            }
        } else {
            1.2
        };
        let download_gb = if gb > 0.0 {
            gb
        } else {
            text.as_deref()
                .and_then(parse_gb_from_text)
                .unwrap_or(default_dl_gb)
        };
        let disk_gb = if tuned {
            if is_bf16_tuned {
                0.52
            } else {
                0.34
            }
        } else {
            0.52
        };
        let tuned_update = !ready && tuned && disk_ready == Some(true);
        return Some(Dflash2Plan {
            ready,
            needed,
            tuned,
            tuned_update,
            gb,
            download_gb,
            disk_gb,
            vram_gb,
            selq4,
            pack,
            repo,
            drafter,
            choice,
            note,
            line: line_text,
            support,
            support_line,
            text,
        });
    }
    None
}

/// Builds the `strata.py drafting plan` command. Passes `--no-split` unless the config is already
/// an all-cards split-engine configuration (`split_engine_note`), matching Manager's direct `serve.server` start.
pub fn plan_step(profile: &ServiceProfile, config: &Value) -> Result<Step, String> {
    let root = processes::runtime_dir(profile)?;
    if !root.join("strata.py").is_file() || !root.join(COMMAND).is_file() {
        return Err("此运行环境没有 DFlash2 计划命令".into());
    }
    let python = PathBuf::from(processes::python(profile)?);
    if !python.is_absolute() || !python.is_file() {
        return Err("此运行环境未登记可用的 Python".into());
    }
    let config_path = storage::config_path(profile)?;
    if !config_path.is_file() {
        return Err("运行配置文件不存在".into());
    }
    let mut args = vec![
        "-u".into(),
        "strata.py".into(),
        "drafting".into(),
        "plan".into(),
        "--config".into(),
        config_path.to_string_lossy().into_owned(),
    ];
    if config.get("split_engine_note").is_none() {
        args.push("--no-split".into());
    }
    args.extend(["--output".into(), "jsonl".into()]);
    Ok(Step {
        program: python.to_string_lossy().into_owned(),
        args,
        cwd: root,
        env: Default::default(),
    })
}

fn run_plan(profile: &ServiceProfile, config: &Value, disk_ready: Option<bool>) -> Option<Dflash2Plan> {
    let step = plan_step(profile, config).ok()?;
    let mut cmd = std::process::Command::new(&step.program);
    cmd.args(&step.args)
        .current_dir(&step.cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    for (k, v) in &step.env {
        match v {
            Some(val) => {
                cmd.env(k, val);
            }
            None => {
                cmd.env_remove(k);
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_plan_output(&stdout, disk_ready)
}

pub fn status(profile: &ServiceProfile) -> Result<Dflash2Status, String> {
    let config = storage::read(profile)?;
    let args = config_args(&config);
    let disk_ready = data_dir_of(&args).map(|data| pack_ready(&data));
    // An external (connect-only) service has no runtime folder to run the command in.
    let fetchable = processes::runtime_dir(profile)
        .is_ok_and(|root| root.join("strata.py").is_file() && root.join(COMMAND).is_file());
    let plan = if fetchable {
        run_plan(profile, &config, disk_ready)
    } else {
        None
    };
    let ready = match (&plan, disk_ready) {
        (Some(p), Some(on_disk)) => Some(p.ready || on_disk),
        (Some(p), None) => Some(p.ready),
        (None, on_disk) => on_disk,
    };
    let tuned_update = plan.as_ref().map(|p| p.tuned_update);
    Ok(Dflash2Status {
        ready,
        fetchable,
        tuned_update,
        plan,
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
        assert!(pack_ready(temp.path()), "the legacy/tuned pack counts");
    }

    #[test]
    fn recognises_all_stock_selq4_and_tuned_strata1_packs() {
        for name in PACK_NAMES {
            let temp = tempfile::tempdir().unwrap();
            let folder = temp.path().join(FOLDER);
            std::fs::create_dir_all(&folder).unwrap();
            let file = std::fs::File::create(folder.join(name)).unwrap();
            file.set_len((1 << 20) + 1).unwrap();
            assert!(pack_ready(temp.path()), "{name} must be recognised as ready");
            if TUNED_PACK_NAMES.contains(&name) {
                assert!(tuned_pack_ready(temp.path()));
                assert!(!stock_pack_ready(temp.path()));
            } else {
                assert!(stock_pack_ready(temp.path()));
                assert!(!tuned_pack_ready(temp.path()));
            }
        }
    }

    #[test]
    fn parses_drafting_plan_jsonl_for_stock_and_tuned_updates() {
        let tuned_jsonl = r#"{"schema_version":1,"ok":true,"ready":false,"gb":0.34,"vram_gb":0.72,"selq4":true,"pack":"/d/dflash2/qwen3.8-flash-next-dflash2.strata1.q4_0-selq4.pack","repo":"incoai/Qwen3.8-Flash-Next-DFlash2","text":"The DFlash2 drafter is 0.34 GB to download, from Strata's signed update feed, Apache-2.0 (a copy of incoai/Qwen3.8-Flash-Next-DFlash2 that Strata tuned). It needs about 0.7 GB of graphics memory, less than the MTP's layer, which is not loaded beside it.","needed":true,"serves":true,"drafter":"dflash2","choice":"dflash2","split":false,"note":"","line":"Drafting: DFlash2","support":"tested","support_line":"On graphics cards like yours, DFlash2 was faster than MTP on some kinds of text and slower on others in our tests."}"#;
        // Stock pack already on disk, tuned pack missing -> tuned_update = true
        let update_plan = parse_plan_output(tuned_jsonl, Some(true)).unwrap();
        assert!(!update_plan.ready);
        assert!(update_plan.needed);
        assert!(update_plan.tuned);
        assert!(update_plan.tuned_update);
        assert_eq!(update_plan.download_gb, 0.34);
        assert_eq!(update_plan.disk_gb, 0.34);
        assert_eq!(update_plan.vram_gb, Some(0.72));

        // Nothing on disk yet -> tuned_update = false, still a 0.34 GB tuned download
        let fresh_plan = parse_plan_output(tuned_jsonl, Some(false)).unwrap();
        assert!(fresh_plan.tuned);
        assert!(!fresh_plan.tuned_update);
        assert_eq!(fresh_plan.download_gb, 0.34);

        // SYCL bf16sel tuned pack -> 0.52 GB
        let sycl_jsonl = r#"{"schema_version":1,"ok":true,"ready":false,"gb":0.52,"vram_gb":0.89,"selq4":false,"pack":"/d/dflash2/qwen3.8-flash-next-dflash2.strata1.q4_0-bf16sel.pack","repo":"incoai/Qwen3.8-Flash-Next-DFlash2","text":"The DFlash2 drafter is 0.52 GB to download, from Strata's signed update feed, Apache-2.0 (a copy of incoai/Qwen3.8-Flash-Next-DFlash2 that Strata tuned).","needed":true,"drafter":"mtp","choice":"dflash2"}"#;
        let sycl_plan = parse_plan_output(sycl_jsonl, Some(false)).unwrap();
        assert!(sycl_plan.tuned);
        assert_eq!(sycl_plan.download_gb, 0.52);
        assert_eq!(sycl_plan.disk_gb, 0.52);

        // Stock HF download when choice is MTP (gb zeroed by CLI, parsed from text)
        let stock_jsonl = r#"{"schema_version":1,"ok":true,"ready":false,"gb":0.0,"vram_gb":0.72,"selq4":true,"pack":"/d/dflash2/qwen3.8-flash-next-dflash2.q4_0.pack","repo":"incoai/Qwen3.8-Flash-Next-DFlash2","text":"The DFlash2 drafter is 1.2 GB to download (it is packed to 0.52 GB for the engine and the download is removed), from incoai/Qwen3.8-Flash-Next-DFlash2, Apache-2.0.","needed":false,"drafter":"mtp","choice":"mtp"}"#;
        let stock_plan = parse_plan_output(stock_jsonl, Some(false)).unwrap();
        assert!(!stock_plan.tuned);
        assert!(!stock_plan.tuned_update);
        assert_eq!(stock_plan.download_gb, 1.2);
        assert_eq!(stock_plan.disk_gb, 0.52);
    }
}
