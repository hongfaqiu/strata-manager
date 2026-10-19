//! 「导入 OrcaRouter 去审查模型」: the manual compatibility workflow of upstream Strata docs/ORCA.md,
//! run as one tracked setup task. Only the file ORCA.md validated is accepted: OrcaRouter's
//! Qwen3.8-Flash-Next-Uncensored IQ3_XXS (2 shards). Nothing is renamed to look like GSQ-RCO and no other
//! model's dense.bin is shared: the pack is standalone (`iq_pack.py --compat-bf16`).
use crate::{disk, processes::Step, types::*};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

pub const SOURCE: &str = "Niko1221/Strata 477ac13 docs/ORCA.md（OrcaRouter IQ3_XXS 手动兼容流程）；Hugging Face orcarouter/Qwen3.8-Flash-Next-Uncensored-GGUF d366e27 文件大小";
pub const REPO: &str = "orcarouter/Qwen3.8-Flash-Next-Uncensored-GGUF";
/// The repository commit whose file sizes were read (Hugging Face API, 2026-10-18).
pub const REVISION: &str = "d366e279688c1f2fd6e75e2f98475d38db534f1d";
pub const FAMILY: &str = "orca";
pub const QUANT: &str = "IQ3_XXS";
pub const MODEL_NAME: &str = "orcarouter-qwen3.8-flash-next-uncensored-iq3_xxs";
pub const CONFIG_FILE: &str = "strata-orca-iq3_xxs.json";
pub const PACK: &str = "packs/orca-iq3_xxs";
pub const MODEL_DIRECTORY: &str = "models/orca-IQ3_XXS";
/// ORCA.md: 32K context, int8 KV.
pub const CONTEXT: u32 = 32768;
/// ORCA.md: "the expert arena needs about 49.8 GiB of available system RAM".
pub const ARENA_GIB: f64 = 49.8;
pub const SHARDS: [(&str, u64); 2] = [
    (
        "Qwen3.8-Flash-Next-Uncensored-IQ3_XXS-00001-of-00002.gguf",
        44_637_691_008,
    ),
    (
        "Qwen3.8-Flash-Next-Uncensored-IQ3_XXS-00002-of-00002.gguf",
        40_564_977_024,
    ),
];
const PREFIX: &str = "Qwen3.8-Flash-Next-Uncensored-";

/// ORCA.md reports "1.39 GiB BF16" of converted dense tensors in the pack; 2 GB covers it plus the
/// tokenizer and index. MTP follows disk.rs (8 GB when absent): the ~5 GB checkpoint slice plus the packs.
const PACK_BYTES: u64 = 2 * disk::GB;
const MTP_BYTES: u64 = 8 * disk::GB;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrcaImportRequest {
    /// "download" (Hugging Face, resumable) or "local" (already downloaded shards).
    pub source: String,
    /// Local mode: shard 1; shard 2 must sit beside it under its own name.
    pub shard_path: Option<String>,
    pub mtp: bool,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrcaShard {
    pub name: String,
    pub path: String,
    pub expected_bytes: u64,
    pub present_bytes: u64,
    /// complete | partial | missing | wrongSize
    pub state: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaImportPlan {
    /// ready | blocked
    pub status: String,
    pub source: String,
    pub repository: String,
    pub revision: String,
    pub model_name: String,
    pub quant: String,
    pub context: u32,
    pub shard_directory: String,
    pub shards: Vec<OrcaShard>,
    pub download_bytes: u64,
    pub total_bytes: u64,
    pub pack_directory: String,
    pub pack_ready: bool,
    pub mtp: bool,
    pub mtp_directory: String,
    pub mtp_ready: bool,
    pub config_path: String,
    pub config_exists: bool,
    pub engine: Option<String>,
    pub ram_total_bytes: u64,
    pub ram_available_bytes: u64,
    pub arena_gib: f64,
    /// ok | insufficient
    pub ram_status: String,
    pub disk: SetupDiskPreflight,
    pub problems: Vec<String>,
    pub source_note: String,
}

/// The quant a file name names, for an OrcaRouter Flash-Next Uncensored GGUF.
fn orca_quant(name: &str) -> Option<&str> {
    let rest = name.strip_prefix(PREFIX)?;
    let end = rest.find("-0000").or_else(|| rest.find(".gguf"))?;
    Some(&rest[..end])
}

/// Accept only the validated IQ3_XXS shard 1. Every other OrcaRouter quant is refused by name with the reason.
pub fn check_shard_name(name: &str) -> Result<(), String> {
    if name == SHARDS[0].0 {
        return Ok(());
    }
    if name == SHARDS[1].0 {
        return Err(format!(
            "请选择第 1 个分片 {}；第 2 个分片需放在同一目录",
            SHARDS[0].0
        ));
    }
    match orca_quant(name) {
        Some("IQ3_M") => Err("OrcaRouter IQ3_M 暂不支持：它的专家 down 投影是 Q5_0，Strata 引擎尚未支持（ORCA.md）。请改用 IQ3_XXS。".into()),
        Some(quant) => Err(format!("OrcaRouter {quant} 未经上游验证，Manager 不导入；目前只支持 ORCA.md 验证过的 IQ3_XXS（2 个分片）。")),
        None if name.contains("GSQ-RCO") => Err("这是 ISTA-DASLab GSQ-RCO 文件，请在上方官方模型列表准备，不要用 OrcaRouter 导入".into()),
        None => Err(format!("{name} 不是 OrcaRouter Qwen3.8-Flash-Next-Uncensored GGUF 分片；需要 {}", SHARDS[0].0)),
    }
}

fn shard_states(directory: &Path, local: bool) -> Result<Vec<OrcaShard>, String> {
    SHARDS
        .iter()
        .map(|(name, size)| {
            // Keep the snapshot file name: an HF cache symlink resolves to a hash-named blob (ORCA.md).
            let path = directory.join(name);
            let present = disk::file_len(&path)?;
            let partial = if local {
                0
            } else {
                disk::file_len(&directory.join(format!("{name}.part")))?
            };
            let state = if present == *size {
                "complete"
            } else if present > 0 {
                "wrongSize"
            } else if partial > 0 {
                "partial"
            } else {
                "missing"
            };
            Ok(OrcaShard {
                name: (*name).into(),
                path: path.to_string_lossy().into(),
                expected_bytes: *size,
                present_bytes: if present > 0 { present } else { partial },
                state: state.into(),
            })
        })
        .collect()
}

/// The runtime's own interpreter through the shared launcher-aligned resolver
/// (#78); the `.venv` path is only the expected location when none exists.
fn venv_python(root: &Path) -> PathBuf {
    if let Ok(env) = crate::launcher_env::resolve(root, None, |path| path.is_file()) {
        return env.python;
    }
    if cfg!(windows) {
        root.join(".venv/Scripts/python.exe")
    } else {
        root.join(".venv/bin/python")
    }
}

/// Engine settings of a config the official setup wrote for this runtime (the engine path, CUDA/HIP library
/// folders, backend), so the import uses the engine setup already verified on this PC.
const INHERITED: [&str; 4] = ["lib_dirs", "cuda", "backend", "host"];

fn engine_template(root: &Path) -> Option<(String, serde_json::Map<String, Value>)> {
    let mut best: Option<(
        std::time::SystemTime,
        String,
        serde_json::Map<String, Value>,
    )> = None;
    for entry in fs::read_dir(root).ok()?.flatten().take(256) {
        let path = entry.path();
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        if !name.starts_with("strata-") || !name.ends_with(".json") || name == CONFIG_FILE {
            continue;
        }
        let Ok(text) = fs::read(&path) else { continue };
        let Ok(Value::Object(value)) = serde_json::from_slice::<Value>(&text) else {
            continue;
        };
        let Some(exe) = value.get("exe").and_then(Value::as_str) else {
            continue;
        };
        let resolved = if Path::new(exe).is_absolute() {
            PathBuf::from(exe)
        } else {
            root.join(exe)
        };
        if !resolved.is_file() {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        let keep: serde_json::Map<_, _> = INHERITED
            .iter()
            .filter_map(|key| value.get(*key).map(|v| ((*key).to_string(), v.clone())))
            .collect();
        if best.as_ref().is_none_or(|(time, _, _)| modified > *time) {
            best = Some((modified, resolved.to_string_lossy().into(), keep));
        }
    }
    best.map(|(_, exe, keep)| (exe, keep))
}

pub(crate) struct Prepared {
    pub plan: OrcaImportPlan,
    pub root: PathBuf,
    pub shard_directory: PathBuf,
    pub inherited: serde_json::Map<String, Value>,
}

pub(crate) fn prepare(
    root: &Path,
    request: &OrcaImportRequest,
    settings: &disk::Settings,
    ram: (u64, u64),
    measure: bool,
) -> Result<Prepared, String> {
    let mut problems = Vec::new();
    let local = match request.source.as_str() {
        "download" => false,
        "local" => true,
        _ => return Err("未知的导入方式".into()),
    };
    let mut data = settings
        .data_dir
        .clone()
        .unwrap_or_else(|| root.parent().unwrap_or(root).join("Strata-data"));
    if !data.is_absolute() {
        data = root.join(data);
    }
    let roots = disk::source_roots(root, settings, &data)
        .unwrap_or_else(|_| vec![data.clone(), root.to_owned()]);
    let shard_directory = if local {
        let shard = request
            .shard_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or("请选择 OrcaRouter IQ3_XXS 第 1 个分片")?;
        let shard = PathBuf::from(shard);
        if !shard.is_absolute() {
            return Err("分片路径必须是绝对路径".into());
        }
        let name = shard
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        check_shard_name(&name)?;
        shard.parent().ok_or("分片没有所在目录")?.to_owned()
    } else {
        roots
            .iter()
            .map(|r| r.join(MODEL_DIRECTORY))
            .find(|d| {
                SHARDS.iter().all(|(name, size)| {
                    disk::file_len(&d.join(name)).ok() == Some(*size)
                        && d.join(format!("{name}.done")).is_file()
                })
            })
            .unwrap_or_else(|| data.join(MODEL_DIRECTORY))
    };
    let shards = shard_states(&shard_directory, local)?;
    if local {
        for shard in &shards {
            match shard.state.as_str() {
                "complete" => {}
                "missing" => problems.push(format!(
                    "同一目录下找不到 {}；两个分片都下载完整后才能打包（ORCA.md）",
                    shard.name
                )),
                _ => problems.push(format!(
                    "{} 大小为 {} 字节，应为 {} 字节；文件不完整或不是这个版本",
                    shard.name, shard.present_bytes, shard.expected_bytes
                )),
            }
        }
    }
    let total: u64 = SHARDS.iter().map(|(_, size)| size).sum();
    let download_bytes = if local {
        0
    } else {
        shards
            .iter()
            .filter(|s| s.state != "complete")
            .map(|s| {
                s.expected_bytes.saturating_sub(if s.state == "partial" {
                    s.present_bytes
                } else {
                    0
                })
            })
            .sum()
    };
    let pack = disk::first_existing(&roots, Path::new(PACK))
        .ok()
        .flatten()
        .unwrap_or_else(|| data.join(PACK));
    let pack_ready = [
        "native_experts.txt",
        "index.txt",
        "compat-bf16.json",
        "tokenizer/vocab.json",
        "tokenizer/merges.txt",
        "tokenizer/token_type.json",
    ]
    .iter()
    .all(|f| pack.join(f).is_file());
    let mtp_found = disk::first_existing(&roots, Path::new("mtp/rt/experts.bin"))
        .ok()
        .flatten();
    let mtp_ready = mtp_found.is_some();
    let mtp_directory = mtp_found
        .as_ref()
        .and_then(|p| p.parent())
        .and_then(Path::parent)
        .map(Path::to_owned)
        .unwrap_or_else(|| data.join("mtp"));
    let python = venv_python(root);
    if !python.is_file() {
        problems.push(
            "运行环境还没有 Python 虚拟环境（.venv）；请先用官方菜单准备一个模型，再导入".into(),
        );
    }
    let iq_pack = root.join("tools/iq_pack.py");
    if !fs::read_to_string(&iq_pack).is_ok_and(|text| text.contains("--compat-bf16")) {
        problems.push(
            "当前 Strata 运行环境的 tools/iq_pack.py 不支持 --compat-bf16；请先更新 Strata".into(),
        );
    }
    if !root.join("third_party/llama.cpp/gguf-py").is_dir() {
        problems.push(
            "缺少 third_party/llama.cpp/gguf-py（打包工具依赖）；请先用官方菜单准备一个模型".into(),
        );
    }
    if !root.join("data/expert-profile.bin").is_file() {
        problems.push("缺少 data/expert-profile.bin；请更新或修复 Strata 运行环境".into());
    }
    if request.mtp && !mtp_ready {
        for tool in [
            "tools/mtp_fetch.py",
            "tools/mtp_pack.py",
            "tools/mtp_rt.py",
            "data/draft_vocab.bin",
        ] {
            if !root.join(tool).is_file() {
                problems.push(format!(
                    "缺少 {tool}，无法准备 MTP 草稿层；可关闭 MTP 后导入"
                ));
            }
        }
    }
    let template = engine_template(root);
    if template.is_none() {
        problems.push("没有找到官方安装器写过的模型配置（含可用引擎）；请先用官方菜单准备任一模型，Manager 会沿用它核验过的引擎设置".into());
    }
    let mut requirements = vec![(shard_directory.clone(), download_bytes)];
    if !pack_ready {
        requirements.push((pack.clone(), PACK_BYTES));
    }
    if request.mtp && !mtp_ready {
        requirements.push((mtp_directory.clone(), MTP_BYTES));
    }
    let mut disk_plan = disk::Plan {
        report: SetupDiskPreflight {
            status: "ready".into(),
            data_directory: data.to_string_lossy().into(),
            model_directory: shard_directory.to_string_lossy().into(),
            model_download_bytes_estimate: Some(download_bytes),
            reusable_model_bytes: total - download_bytes.min(total),
            additional_bytes_estimate: Some(requirements.iter().map(|(_, b)| b).sum()),
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
        data_directory: data.clone(),
        gguf_directory: None,
    };
    if measure && !disk_plan.report.volumes.is_empty() {
        disk::measure(&mut disk_plan, disk::read_space);
        if disk_plan.report.status != "ready" {
            problems.push(format!("磁盘空间检查未通过：{}", disk_plan.report.reason));
        }
    }
    let ram_status = if (ram.0 as f64) / (1_u64 << 30) as f64 >= ARENA_GIB {
        "ok"
    } else {
        "insufficient"
    };
    let config = root.join(CONFIG_FILE);
    let (engine, inherited) = template
        .map(|(exe, keep)| (Some(exe), keep))
        .unwrap_or_default();
    Ok(Prepared {
        plan: OrcaImportPlan {
            status: if problems.is_empty() {
                "ready"
            } else {
                "blocked"
            }
            .into(),
            source: request.source.clone(),
            repository: REPO.into(),
            revision: REVISION.into(),
            model_name: MODEL_NAME.into(),
            quant: QUANT.into(),
            context: CONTEXT,
            shard_directory: shard_directory.to_string_lossy().into(),
            shards,
            download_bytes,
            total_bytes: total,
            pack_directory: pack.to_string_lossy().into(),
            pack_ready,
            mtp: request.mtp,
            mtp_directory: mtp_directory.to_string_lossy().into(),
            mtp_ready,
            config_path: config.to_string_lossy().into(),
            config_exists: config.is_file(),
            engine,
            ram_total_bytes: ram.0,
            ram_available_bytes: ram.1,
            arena_gib: ARENA_GIB,
            ram_status: ram_status.into(),
            disk: disk_plan.report,
            problems,
            source_note: SOURCE.into(),
        },
        root: root.to_owned(),
        shard_directory,
        inherited,
    })
}

/// The config ORCA.md documents, with absolute paths and the engine settings of this runtime.
pub(crate) fn config(prepared: &Prepared, port: u16) -> Value {
    let plan = &prepared.plan;
    let shard1 = prepared
        .shard_directory
        .join(SHARDS[0].0)
        .to_string_lossy()
        .to_string();
    let pack = PathBuf::from(&plan.pack_directory);
    let root = &prepared.root;
    let mut args: Vec<String> = vec![
        "--pack".into(),
        plan.pack_directory.clone(),
        "--native".into(),
        shard1.clone(),
        "--ple-gguf".into(),
        shard1,
        "--expert-profile".into(),
        root.join("data/expert-profile.bin")
            .to_string_lossy()
            .into(),
        "--expert-cache".into(),
        "auto".into(),
        "--prefill".into(),
        "512".into(),
    ];
    if plan.mtp {
        args.extend([
            "--spec".into(),
            "4".into(),
            "--spec-min-p".into(),
            "0.5".into(),
            "--mtp".into(),
            PathBuf::from(&plan.mtp_directory)
                .join("rt")
                .to_string_lossy()
                .into(),
        ]);
    }
    args.extend([
        "--max-context".into(),
        CONTEXT.to_string(),
        "--kv".into(),
        "int8".into(),
    ]);
    let mut value = json!({
        "exe": plan.engine.clone().unwrap_or_default(),
        "args": args,
        "cwd": root.to_string_lossy(),
        "tokenizer": pack.join("tokenizer").to_string_lossy(),
        "model_name": MODEL_NAME,
        "log": root.join("strata-orca-iq3_xxs.log").to_string_lossy(),
        "host": "127.0.0.1",
        "port": port,
    });
    if let Value::Object(map) = &mut value {
        for (key, inherited) in &prepared.inherited {
            map.insert(key.clone(), inherited.clone());
        }
    }
    value
}

/// Python run by the runtime's own venv: setup.py's resumable download (HF_ENDPOINT mirrors, .part/.done marks),
/// size and SHA-256 checks, the draft-vocabulary copy and the atomic config write. No shell is involved.
pub const HELPER: &str = r#"
import hashlib, json, os, shutil, sys, urllib.request
from pathlib import Path
root, cmd, rest = Path(sys.argv[1]), sys.argv[2], sys.argv[3:]
sys.path.insert(0, str(root))

def hf_base():
    return (os.environ.get("HF_ENDPOINT") or "").strip().rstrip("/") or "https://huggingface.co"

def published(repo, rev):
    try:
        req = urllib.request.Request(f"{hf_base()}/api/models/{repo}/tree/{rev}", headers={"User-Agent": "strata-manager"})
        with urllib.request.urlopen(req, timeout=60) as r:
            return {f["path"]: (f.get("lfs") or {}).get("oid", "") for f in json.loads(r.read())}
    except (OSError, ValueError, KeyError, TypeError) as e:
        print(f"note: cannot read the published SHA-256 ({e}); the size is checked", flush=True)
        return {}

def valid(sha):
    return isinstance(sha, str) and len(sha) == 64 and all(c in "0123456789abcdef" for c in sha)

def digest(path, size):
    h, seen, step = hashlib.sha256(), 0, 0
    with open(path, "rb") as f:
        while True:
            b = f.read(16 << 20)
            if not b:
                return h.hexdigest()
            h.update(b); seen += len(b)
            if seen * 20 // size > step:
                step = seen * 20 // size
                print(f"  checking {path.name} (SHA-256) {seen * 100 // size}%", flush=True)

if cmd == "fetch":
    import setup
    dest, repo, rev, files = Path(rest[0]), rest[1], rest[2], rest[3:]
    shas = None
    for item in files:
        name, size = item.rsplit(":", 1); size = int(size); dst = dest / name
        setup.download(f"{setup.hf_endpoint()}/{repo}/resolve/{rev}/{name}", dst, f"{repo.split('/')[-1]}: {name}")
        if dst.stat().st_size != size:
            setup.fail(f"{name} is {dst.stat().st_size:,} bytes, not {size:,}", "delete it and its .done mark, then import again")
        if shas is None:
            shas = published(repo, rev)
        if valid(shas.get(name)):
            setup.verify_sha256(dst, size, shas[name])
        else:
            print(f"note: no published SHA-256 for {name}; size {size:,} bytes verified", flush=True)
    print("shards ready", flush=True)
elif cmd == "verify":
    repo, rev, files = rest[0], rest[1], rest[2:]
    shas = published(repo, rev)
    for item in files:
        path, size = item.rsplit(":", 1); path, size = Path(path), int(size)
        have = path.stat().st_size if path.exists() else -1
        if have != size:
            print(f"error: {path.name} is {have:,} bytes, not {size:,}", flush=True); sys.exit(2)
        sha = shas.get(path.name)
        if valid(sha):
            got = digest(path, size)
            if got != sha:
                print(f"error: {path.name} has SHA-256 {got}, expected {sha}; the file was left in place", flush=True); sys.exit(2)
            print(f"  {path.name}: SHA-256 verified", flush=True)
        else:
            print(f"note: no published SHA-256 for {path.name}; size {size:,} bytes verified", flush=True)
    print("shards verified", flush=True)
elif cmd == "vocab":
    src, dst = Path(rest[0]), Path(rest[1])
    if not dst.exists():
        dst.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(src, dst)
    print(f"draft vocabulary: {dst}", flush=True)
elif cmd == "config":
    dst, cfg = Path(rest[0]), json.loads(rest[1])
    tmp = dst.with_name(dst.name + ".tmp")
    tmp.write_text(json.dumps(cfg, indent=1) + "\n", encoding="utf-8")
    tmp.replace(dst)
    print(f"config written: {dst}", flush=True)
else:
    sys.exit(f"unknown command {cmd}")
"#;

/// The tracked task: shards, pack, optional MTP, config. Every step runs with the runtime's own venv in its folder.
pub(crate) fn steps(
    prepared: &Prepared,
    env: BTreeMap<String, Option<String>>,
    port: u16,
) -> Vec<Step> {
    let plan = &prepared.plan;
    let root = &prepared.root;
    let python = venv_python(root).to_string_lossy().to_string();
    let helper = |args: Vec<String>, env: BTreeMap<String, Option<String>>| Step {
        program: python.clone(),
        args: [
            vec![
                "-u".into(),
                "-c".into(),
                HELPER.into(),
                root.to_string_lossy().into(),
            ],
            args,
        ]
        .concat(),
        cwd: root.clone(),
        env,
    };
    let mut tool_env = env.clone();
    tool_env.insert(
        "STRATA_GGUF_PY".into(),
        Some(
            root.join("third_party/llama.cpp/gguf-py")
                .to_string_lossy()
                .into(),
        ),
    );
    let tool = |args: Vec<String>, env: &BTreeMap<String, Option<String>>| Step {
        program: python.clone(),
        args: [vec!["-u".into()], args].concat(),
        cwd: root.clone(),
        env: env.clone(),
    };
    let mut steps = Vec::new();
    let files = |paths: bool| -> Vec<String> {
        SHARDS
            .iter()
            .map(|(name, size)| {
                if paths {
                    format!(
                        "{}:{size}",
                        prepared.shard_directory.join(name).to_string_lossy()
                    )
                } else {
                    format!("{name}:{size}")
                }
            })
            .collect()
    };
    if plan.source == "download" {
        steps.push(helper(
            [
                vec![
                    "fetch".into(),
                    prepared.shard_directory.to_string_lossy().into(),
                    REPO.into(),
                    REVISION.into(),
                ],
                files(false),
            ]
            .concat(),
            env.clone(),
        ));
    } else {
        steps.push(helper(
            [
                vec!["verify".into(), REPO.into(), REVISION.into()],
                files(true),
            ]
            .concat(),
            env.clone(),
        ));
    }
    let shard1 = prepared
        .shard_directory
        .join(SHARDS[0].0)
        .to_string_lossy()
        .to_string();
    if !plan.pack_ready {
        steps.push(tool(
            vec![
                "tools/iq_pack.py".into(),
                "--gguf".into(),
                shard1,
                "--out".into(),
                plan.pack_directory.clone(),
                "--compat-bf16".into(),
            ],
            &tool_env,
        ));
    }
    if plan.mtp && !plan.mtp_ready {
        let mtp = PathBuf::from(&plan.mtp_directory);
        let gguf = mtp.join("mtp-q2_0.gguf").to_string_lossy().to_string();
        // The MTP slice comes from the original Qwen checkpoint: the chosen source (ModelScope too) applies.
        steps.push(tool(
            vec![
                "tools/mtp_fetch.py".into(),
                "fetch".into(),
                "--out".into(),
                plan.mtp_directory.clone(),
            ],
            &tool_env,
        ));
        steps.push(tool(
            vec![
                "tools/mtp_pack.py".into(),
                "--src".into(),
                plan.mtp_directory.clone(),
                "--experts".into(),
                "q2_0".into(),
                "--out".into(),
                gguf.clone(),
            ],
            &tool_env,
        ));
        steps.push(tool(
            vec![
                "tools/mtp_rt.py".into(),
                "--gguf".into(),
                gguf,
                "--out".into(),
                mtp.join("rt").to_string_lossy().into(),
            ],
            &tool_env,
        ));
        steps.push(helper(
            vec![
                "vocab".into(),
                root.join("data/draft_vocab.bin").to_string_lossy().into(),
                mtp.join("rt/draft_vocab.bin").to_string_lossy().into(),
            ],
            BTreeMap::new(),
        ));
    }
    steps.push(helper(
        vec![
            "config".into(),
            plan.config_path.clone(),
            config(prepared, port).to_string(),
        ],
        BTreeMap::new(),
    ));
    steps
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime(dir: &Path) -> PathBuf {
        let root = dir.join("Strata");
        for d in [
            "tools",
            "data",
            "third_party/llama.cpp/gguf-py",
            "engine",
            if cfg!(windows) {
                ".venv/Scripts"
            } else {
                ".venv/bin"
            },
        ] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        fs::write(
            root.join("tools/iq_pack.py"),
            "ap.add_argument(\"--compat-bf16\")",
        )
        .unwrap();
        for f in [
            "tools/mtp_fetch.py",
            "tools/mtp_pack.py",
            "tools/mtp_rt.py",
            "data/draft_vocab.bin",
            "data/expert-profile.bin",
            "engine/strata",
        ] {
            fs::write(root.join(f), "x").unwrap();
        }
        fs::write(venv_python(&root), "x").unwrap();
        fs::write(
            root.join("strata-iq3_s.json"),
            json!({"exe": root.join("engine/strata").to_string_lossy(), "lib_dirs": ["/cuda/lib"], "cuda": 12, "model_name": "qwen3.8-flash-next-iq3_s", "env": {"STRATA_MMQ_KQ": "1"}, "args": ["--gpu", "1"]}).to_string(),
        )
        .unwrap();
        root
    }

    fn sparse(path: &Path, size: u64) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::File::create(path).unwrap().set_len(size).unwrap();
    }

    fn settings(data: &Path) -> disk::Settings {
        disk::Settings {
            data_dir: Some(data.to_owned()),
            ..Default::default()
        }
    }

    #[test]
    fn sizes_match_orca_md_total() {
        // ORCA.md: "2 shards, 85.20 GB total"
        let total: u64 = SHARDS.iter().map(|(_, s)| s).sum();
        assert_eq!(total, 85_202_668_032);
        assert_eq!(format!("{:.2}", total as f64 / 1e9), "85.20");
    }

    #[test]
    fn only_iq3_xxs_shard_one_is_accepted() {
        assert!(check_shard_name(SHARDS[0].0).is_ok());
        let second = check_shard_name(SHARDS[1].0).unwrap_err();
        assert!(second.contains("第 1 个分片"));
        let m = check_shard_name("Qwen3.8-Flash-Next-Uncensored-IQ3_M-00001-of-00002.gguf")
            .unwrap_err();
        assert!(m.contains("IQ3_M") && m.contains("Q5_0"), "{m}");
        let q4 = check_shard_name("Qwen3.8-Flash-Next-Uncensored-Q4_K_M-00001-of-00003.gguf")
            .unwrap_err();
        assert!(q4.contains("Q4_K_M") && q4.contains("未经上游验证"), "{q4}");
        let draft = check_shard_name("Qwen3.8-Flash-Next-Uncensored-MTP-draft.gguf").unwrap_err();
        assert!(draft.contains("未经上游验证"), "{draft}");
        let gsq =
            check_shard_name("Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf").unwrap_err();
        assert!(gsq.contains("GSQ-RCO"));
        assert!(check_shard_name("model.gguf").is_err());
    }

    #[test]
    fn local_plan_checks_both_shards_and_writes_the_orca_md_config() {
        let dir = tempfile::tempdir().unwrap();
        let root = runtime(dir.path());
        let shards = dir.path().join("hf cache/snapshots/abc");
        sparse(&shards.join(SHARDS[0].0), SHARDS[0].1);
        let request = OrcaImportRequest {
            source: "local".into(),
            shard_path: Some(shards.join(SHARDS[0].0).to_string_lossy().into()),
            mtp: true,
        };
        let blocked = prepare(
            &root,
            &request,
            &settings(&dir.path().join("Strata-data")),
            (128 << 30, 100 << 30),
            false,
        )
        .unwrap();
        assert_eq!(blocked.plan.status, "blocked");
        assert!(
            blocked
                .plan
                .problems
                .iter()
                .any(|p| p.contains("00002-of-00002")),
            "{:?}",
            blocked.plan.problems
        );
        sparse(&shards.join(SHARDS[1].0), SHARDS[1].1 - 1);
        let short = prepare(
            &root,
            &request,
            &settings(&dir.path().join("Strata-data")),
            (128 << 30, 100 << 30),
            false,
        )
        .unwrap();
        assert!(
            short
                .plan
                .problems
                .iter()
                .any(|p| p.contains("应为 40564977024 字节")),
            "{:?}",
            short.plan.problems
        );
        sparse(&shards.join(SHARDS[1].0), SHARDS[1].1);
        let ready = prepare(
            &root,
            &request,
            &settings(&dir.path().join("Strata-data")),
            (128 << 30, 100 << 30),
            false,
        )
        .unwrap();
        assert_eq!(ready.plan.status, "ready", "{:?}", ready.plan.problems);
        assert_eq!(ready.plan.download_bytes, 0);
        assert_eq!(ready.plan.ram_status, "ok");
        let cfg = config(&ready, 8080);
        let args: Vec<&str> = cfg["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        let shard1 = shards.join(SHARDS[0].0).to_string_lossy().to_string();
        let flag = |f: &str| args[args.iter().position(|a| *a == f).unwrap() + 1];
        assert_eq!(flag("--native"), shard1);
        assert_eq!(
            flag("--ple-gguf"),
            shard1,
            "ORCA.md: --native and --ple-gguf both name shard 1"
        );
        assert_eq!(flag("--expert-cache"), "auto");
        assert_eq!(flag("--prefill"), "512");
        assert_eq!(flag("--max-context"), "32768");
        assert_eq!(flag("--kv"), "int8");
        assert_eq!(flag("--spec"), "4");
        assert_eq!(flag("--spec-min-p"), "0.5");
        assert!(flag("--mtp").ends_with("rt"));
        assert!(flag("--pack").ends_with("orca-iq3_xxs"));
        assert_eq!(cfg["model_name"], MODEL_NAME);
        assert!(cfg["tokenizer"].as_str().unwrap().ends_with("tokenizer"));
        assert!(cfg.get("vision").is_none(), "text only");
        assert_eq!(cfg["lib_dirs"], json!(["/cuda/lib"]));
        assert_eq!(cfg["cuda"], 12);
        assert!(
            cfg.get("env").is_none(),
            "setup-specific env is not inherited"
        );
        assert!(!args.contains(&"--gpu"));
        let steps = steps(&ready, BTreeMap::new(), 8080);
        let lines: Vec<String> = steps
            .iter()
            .map(|s| {
                s.args
                    .iter()
                    .filter(|a| a.len() < 300)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .collect();
        assert!(lines[0].contains(" verify "), "{lines:?}");
        assert!(
            lines[1].starts_with("-u tools/iq_pack.py --gguf ")
                && lines[1].ends_with("--compat-bf16"),
            "{lines:?}"
        );
        assert!(lines[1].contains(&shard1));
        assert!(steps[1].env.contains_key("STRATA_GGUF_PY"));
        assert!(lines[2].contains("tools/mtp_fetch.py fetch --out"));
        assert!(
            lines[3].contains("tools/mtp_pack.py --src") && lines[3].contains("--experts q2_0")
        );
        assert!(lines[4].contains("tools/mtp_rt.py --gguf"));
        assert!(lines[5].contains(" vocab ") && lines[5].contains("draft_vocab.bin"));
        assert!(steps
            .last()
            .unwrap()
            .args
            .iter()
            .any(|a| a.ends_with(CONFIG_FILE)));
        assert!(steps.iter().all(|s| s.program.contains(".venv")));
    }

    #[test]
    fn download_plan_counts_partial_bytes_and_skips_mtp_when_off() {
        let dir = tempfile::tempdir().unwrap();
        let root = runtime(dir.path());
        let data = dir.path().join("Strata-data");
        sparse(
            &data
                .join(MODEL_DIRECTORY)
                .join(format!("{}.part", SHARDS[0].0)),
            1_000,
        );
        let request = OrcaImportRequest {
            source: "download".into(),
            shard_path: None,
            mtp: false,
        };
        let plan = prepare(
            &root,
            &request,
            &settings(&data),
            (32 << 30, 20 << 30),
            false,
        )
        .unwrap();
        assert_eq!(plan.plan.status, "ready", "{:?}", plan.plan.problems);
        assert_eq!(plan.plan.download_bytes, SHARDS[0].1 - 1_000 + SHARDS[1].1);
        assert_eq!(
            plan.plan.ram_status, "insufficient",
            "32 GiB is below the 49.8 GiB arena"
        );
        let cfg = config(&plan, 9000);
        let args = cfg["args"].as_array().unwrap();
        assert!(!args.iter().any(|a| a == "--mtp" || a == "--spec"));
        assert_eq!(cfg["port"], 9000);
        let steps = steps(&plan, BTreeMap::new(), 9000);
        assert_eq!(steps.len(), 3, "fetch, pack, config");
        assert!(steps[0].args.iter().any(|a| a == REVISION));
        assert!(steps[0].args.iter().any(|a| a == "fetch"));
    }

    #[test]
    fn missing_runtime_parts_block_the_import_with_reasons() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Strata");
        fs::create_dir_all(&root).unwrap();
        let request = OrcaImportRequest {
            source: "download".into(),
            shard_path: None,
            mtp: true,
        };
        let plan = prepare(
            &root,
            &request,
            &settings(&dir.path().join("d")),
            (128 << 30, 100 << 30),
            false,
        )
        .unwrap();
        assert_eq!(plan.plan.status, "blocked");
        let text = plan.plan.problems.join("\n");
        for needle in [
            ".venv",
            "--compat-bf16",
            "gguf-py",
            "expert-profile.bin",
            "mtp_fetch.py",
            "官方菜单准备任一模型",
        ] {
            assert!(text.contains(needle), "{needle}: {text}");
        }
        assert!(prepare(
            &root,
            &OrcaImportRequest {
                source: "x".into(),
                ..Default::default()
            },
            &settings(&dir.path().join("d")),
            (0, 0),
            false
        )
        .is_err());
        let wrong = OrcaImportRequest {
            source: "local".into(),
            shard_path: Some(
                dir.path()
                    .join("Qwen3.8-Flash-Next-Uncensored-IQ3_M-00001-of-00002.gguf")
                    .to_string_lossy()
                    .into(),
            ),
            mtp: false,
        };
        assert!(prepare(
            &root,
            &wrong,
            &settings(&dir.path().join("d")),
            (0, 0),
            false
        )
        .err()
        .unwrap()
        .contains("Q5_0"));
    }

    #[test]
    fn existing_pack_and_mtp_are_reused() {
        let dir = tempfile::tempdir().unwrap();
        let root = runtime(dir.path());
        let data = dir.path().join("Strata-data");
        for f in [
            "native_experts.txt",
            "index.txt",
            "compat-bf16.json",
            "tokenizer/vocab.json",
            "tokenizer/merges.txt",
            "tokenizer/token_type.json",
        ] {
            sparse(&data.join(PACK).join(f), 1);
        }
        sparse(&data.join("mtp/rt/experts.bin"), 1);
        let request = OrcaImportRequest {
            source: "download".into(),
            shard_path: None,
            mtp: true,
        };
        let plan = prepare(
            &root,
            &request,
            &settings(&data),
            (64 << 30, 60 << 30),
            false,
        )
        .unwrap();
        assert!(plan.plan.pack_ready && plan.plan.mtp_ready);
        let steps = steps(&plan, BTreeMap::new(), 8080);
        assert_eq!(
            steps.len(),
            2,
            "fetch then config: no repack, no MTP rebuild, draft vocab untouched"
        );
    }
}
