//! 「使用已有模型」(#75): reuse GGUF files the user already has, the way upstream
//! `START-HERE.bat --family F --model Q --gguf-dir DIR` does. The folder is scanned read-only:
//! GGUF shards are grouped by model and quantization, the header magic and sizes are checked, and
//! each group is mapped to what upstream setup.py can install from it.
//!
//! Upstream setup.py (v0.1.45 and main) has no `--mtp` setup flag. It finds an existing MTP draft
//! layer at `<data folder>/mtp/rt/experts.bin` (`find_in(roots, "mtp/rt/experts.bin")`), and the
//! generated run config then passes `--mtp <...>/mtp/rt` to the engine. An MTP path chosen here is
//! therefore mapped to `--data-dir <data folder>` for setup, and to the engine's `--mtp` for the
//! ORCA.md import, which writes its own config.
use crate::{
    disk,
    gguf_check::{self, ShardCheck},
    orca_import,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

/// setup.py MODELS: the quantizations Strata runs. Any other quant in a GGUF name is refused upstream
/// (`gguf_unsupported`, #444): the engine has no kernels for it.
pub const SUPPORTED_QUANTS: [&str; 10] = [
    "Q2_0",
    "IQ2_XS",
    "IQ3_XXS",
    "IQ3_S",
    "IQ1_M",
    "UD-IQ4_XS",
    "UD-Q4_K_XL",
    "UD-Q5_K_XL",
    "UD-Q6_K_XL",
    "Q8_0",
];

/// (family, quant) pairs the verified official installer accepts; shared with `run_setup`.
pub fn setup_supports(family: &str, quant: &str) -> bool {
    match family {
        "qwen" => ["Q2_0", "IQ2_XS", "IQ3_XXS", "IQ3_S"].contains(&quant),
        "swift" => ["IQ2_XS", "IQ3_XXS", "IQ3_S"].contains(&quant),
        "coder" => quant == "IQ1_M",
        "unsloth" => [
            "UD-IQ4_XS",
            "UD-Q4_K_XL",
            "UD-Q5_K_XL",
            "UD-Q6_K_XL",
            "Q8_0",
        ]
        .contains(&quant),
        // setup.py OWN_PATH_FAMILIES qwen36; MIN_ENGINE (0,1,45)
        "qwen36" => ["UD-Q4_K_XL", "UD-Q6_K_XL", "Q8_0"].contains(&quant),
        // setup.py MULTI_FILE_FAMILIES deepseek41 (Strata 0.2.5+): the official IST-DAS sets only;
        // Unsloth's 508 GB UD-Q8_K_XL is a multi-GPU set the Manager does not offer.
        "deepseek41" => crate::disk::DSV41_SETS.iter().any(|set| set.model == quant),
        _ => false,
    }
}

const FAMILIES: [&str; 5] = ["qwen", "swift", "coder", "unsloth", "qwen36"];
const SUPPORTED_GGUFS: &str = "Strata 只能运行 ISTA-DASLab 的 GSQ-RCO 文件（Qwen3.8-Flash-Next Q2_0、IQ2_XS、IQ3_XXS、IQ3_S；Swift 1.5；Coder IQ1_M）、Unsloth 的 UD-IQ4_XS、UD-Q4_K_XL、UD-Q5_K_XL、UD-Q6_K_XL、Q8_0，以及 Qwen3.6-35B-A3B 的 UD-Q4_K_XL、UD-Q6_K_XL、Q8_0（上游 setup.py #444）";
const MAX_ENTRIES: usize = 4096;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalModelRequest {
    /// Folder with every shard, as `--gguf-dir`.
    pub gguf_directory: String,
    /// Optional MTP draft layer: `<data>/mtp/rt`, `<data>/mtp` or `<data>`.
    #[serde(default)]
    pub mtp_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalShard {
    pub name: String,
    pub bytes: u64,
    /// ok | missing | unreadable | notGguf | tooSmall (shorter than its own GGUF tensor directory says)
    pub state: String,
    /// The length the shard's GGUF header says it needs, when it could be read.
    pub expected_bytes: Option<u64>,
    /// A download leftover beside it (`.part`, `.incomplete`, `.downloading`, HF `--local-dir` cache).
    pub partial_download: Option<String>,
    /// `split.no` / `split.count` disagree with the file name (a shard of another split).
    #[serde(skip)]
    split_mismatch: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelGroup {
    pub id: String,
    /// The file name without the shard suffix and `.gguf`.
    pub name: String,
    pub first_shard: String,
    pub quant: Option<String>,
    /// official | renamed | orca | unsupported | unknown
    pub kind: String,
    /// setup.py `--family` (official/renamed) or "orca".
    pub family: Option<String>,
    pub shards: Vec<LocalShard>,
    pub total_bytes: u64,
    pub complete: bool,
    pub installable: bool,
    pub warnings: Vec<String>,
    pub problems: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelScan {
    pub directory: String,
    /// The file the user picked, when a file rather than a folder was chosen.
    pub selected_file: Option<String>,
    pub groups: Vec<LocalModelGroup>,
    pub problems: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MtpCheck {
    pub input: String,
    /// `.../rt`, passed to the engine as `--mtp`.
    pub rt_directory: Option<String>,
    /// The folder holding `mtp/rt` (upstream's data folder), passed to setup as `--data-dir`.
    pub data_directory: Option<String>,
    pub experts_bytes: u64,
    pub problems: Vec<String>,
}

fn absolute(path: &str, what: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(format!("请选择{what}"));
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(format!("{what}必须是绝对路径"));
    }
    Ok(path)
}

/// `-0000i-of-0000N.gguf`: (index, total, stem).
fn shard_parts(name: &str) -> Option<(u32, u32, &str)> {
    let lower = name.to_ascii_lowercase();
    if !lower.ends_with(".gguf") || name.len() < 22 {
        return None;
    }
    let base = &name[..name.len() - 5];
    let tail = &base[base.len() - 15..];
    let bytes = tail.as_bytes();
    if bytes[0] != b'-' || &tail[6..10] != "-of-" {
        return None;
    }
    let index: u32 = tail[1..6].parse().ok()?;
    let total: u32 = tail[10..15].parse().ok()?;
    (tail[1..6].bytes().all(|b| b.is_ascii_digit())
        && tail[10..15].bytes().all(|b| b.is_ascii_digit())
        && index >= 1
        && total >= index)
        .then_some((index, total, &base[..base.len() - 15]))
}

fn is_quant_token(token: &str) -> bool {
    let upper = token.to_ascii_uppercase();
    if ["BF16", "F16", "F32"].contains(&upper.as_str()) {
        return true;
    }
    let rest = upper.strip_prefix('I').unwrap_or(&upper);
    let Some(rest) = rest.strip_prefix('Q') else {
        return false;
    };
    let mut parts = rest.split('_');
    let digits = parts.next().unwrap_or_default();
    !digits.is_empty()
        && digits.bytes().all(|b| b.is_ascii_digit())
        && parts.all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// setup.py GGUF_QUANT: the quantization a GGUF's name says (Unsloth's UD- prefix included).
pub fn quant_of(stem: &str) -> Option<String> {
    let tokens: Vec<&str> = stem.split('-').collect();
    let last = *tokens.last()?;
    if !is_quant_token(last) {
        return None;
    }
    let ud = tokens.len() >= 2 && tokens[tokens.len() - 2].eq_ignore_ascii_case("UD");
    Some(format!(
        "{}{}",
        if ud { "UD-" } else { "" },
        last.to_ascii_uppercase()
    ))
}

/// The published first-shard name of each installable (family, quant), as `--gguf-dir` expects it.
fn official_choice(first: &str) -> Option<(String, String)> {
    for family in FAMILIES {
        for quant in SUPPORTED_QUANTS {
            if !setup_supports(family, quant) {
                continue;
            }
            if let Ok((_, names, _, _)) = disk::model_spec(family, quant) {
                if names.first().is_some_and(|n| n == first) {
                    return Some((family.into(), quant.into()));
                }
            }
        }
    }
    None
}

/// For a renamed copy: the family its name points to. setup.py's `gguf_dir_shards` then finds it as the one
/// first shard in the folder whose name contains the size.
pub(crate) fn inferred_family(stem: &str, quant: &str) -> Option<&'static str> {
    let lower = stem.to_ascii_lowercase();
    let family = if lower.contains("qwen3.6") {
        "qwen36"
    } else if lower.contains("swift") {
        "swift"
    } else if quant == "IQ1_M" {
        "coder"
    } else if quant.starts_with("UD-") || quant == "Q8_0" {
        "unsloth"
    } else {
        "qwen"
    };
    setup_supports(family, quant).then_some(family)
}

/// A leftover of an unfinished download of `name`: `<name>.part` (setup.py), `.incomplete`/`.downloading`
/// (browsers, download managers), or Hugging Face's `hf download --local-dir` working file
/// `.cache/huggingface/download/<name>.<hash>.incomplete`.
fn partial_download(directory: &Path, name: &str) -> Option<String> {
    for suffix in [
        ".part",
        ".incomplete",
        ".downloading",
        ".crdownload",
        ".tmp",
    ] {
        let candidate = format!("{name}{suffix}");
        if directory.join(&candidate).is_file() {
            return Some(candidate);
        }
    }
    let cache = directory
        .join(".cache")
        .join("huggingface")
        .join("download");
    fs::read_dir(&cache)
        .ok()?
        .take(MAX_ENTRIES)
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .find(|n| n.starts_with(name) && n.ends_with(".incomplete"))
        .map(|n| format!(".cache/huggingface/download/{n}"))
}

/// `split`: (1-based index, total) from the file name, checked against gguf-split's `split.no`/`split.count`.
fn shard_state(path: &Path, split: Option<(u32, u32)>) -> LocalShard {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let directory = path.parent().unwrap_or(Path::new(""));
    let bytes = disk::file_len(path).unwrap_or(0);
    let mut expected_bytes = None;
    let mut split_mismatch = None;
    // Completeness is the GGUF header's own tensor directory (upstream check_shards), not a size floor:
    // gguf-split's first shard of an Unsloth upload holds only metadata (about 10 MB) and is whole.
    let state = if !path.is_file() {
        "missing"
    } else {
        match gguf_check::check(path) {
            ShardCheck::Whole(header) => {
                expected_bytes = Some(header.need_bytes);
                if let (Some((index, total)), Some(count)) = (split, header.split_count) {
                    let no = header.split_no.unwrap_or(u64::from(index) - 1);
                    if count != u64::from(total) || no + 1 != u64::from(index) {
                        split_mismatch = Some(format!(
                            "{name} 的 GGUF 头写的是第 {} 个分片、共 {count} 个，与文件名（第 {index} 个、共 {total} 个）不一致；可能混入了其他模型或其他量化的分片",
                            no + 1
                        ));
                    }
                }
                "ok"
            }
            ShardCheck::Short { need, .. } => {
                expected_bytes = need;
                "tooSmall"
            }
            ShardCheck::NotGguf => "notGguf",
            ShardCheck::Unreadable(_) => "unreadable",
        }
    };
    let partial_download = if state == "ok" {
        None
    } else {
        partial_download(directory, &name)
    };
    LocalShard {
        name,
        bytes,
        state: state.into(),
        expected_bytes,
        partial_download,
        split_mismatch,
    }
}

fn describe_shard(shard: &LocalShard) -> Option<String> {
    let downloading = shard
        .partial_download
        .as_deref()
        .map(|p| format!("；同目录还有未完成的下载 {p}，请等下载完成后再导入"))
        .unwrap_or_default();
    match shard.state.as_str() {
        "ok" => shard.split_mismatch.clone(),
        "missing" => Some(format!(
            "缺少分片 {}；所有分片需放在同一目录并保留原文件名{downloading}",
            shard.name
        )),
        "tooSmall" => Some(match shard.expected_bytes {
            Some(need) => format!(
                "{} 不完整：只有 {} 字节，按它的 GGUF 文件头应有 {} 字节（缺 {} 字节）；可能仍在下载或复制中断{downloading}",
                shard.name,
                shard.bytes,
                need,
                need.saturating_sub(shard.bytes)
            ),
            None => format!(
                "{} 不完整：只有 {} 字节，GGUF 文件头本身就被截断了；可能仍在下载或复制中断{downloading}",
                shard.name, shard.bytes
            ),
        }),
        "notGguf" => Some(format!(
            "{} 不是有效的 GGUF 文件（文件头不是 GGUF）；可能已损坏或不是模型文件{downloading}",
            shard.name
        )),
        _ => Some(format!("无法读取 {}；请检查文件权限或磁盘连接", shard.name)),
    }
}

fn group(directory: &Path, first: &str, stem: &str, total: u32) -> LocalModelGroup {
    let names: Vec<String> = if total > 1 {
        (1..=total)
            .map(|i| format!("{stem}-{i:05}-of-{total:05}.gguf"))
            .collect()
    } else {
        vec![first.to_owned()]
    };
    // Every split file is a GGUF of its own (gguf-split): each header is checked against its length.
    let shards: Vec<LocalShard> = names
        .iter()
        .enumerate()
        .map(|(i, n)| {
            shard_state(
                &directory.join(n),
                (total > 1).then_some((i as u32 + 1, total)),
            )
        })
        .collect();
    let mut problems: Vec<String> = shards.iter().filter_map(describe_shard).collect();
    let mut warnings = Vec::new();
    let complete = shards
        .iter()
        .all(|s| s.state == "ok" && s.split_mismatch.is_none());
    let total_bytes = shards.iter().map(|s| s.bytes).sum();
    let quant = quant_of(stem);
    let (kind, family) = if first.starts_with("Qwen3.8-Flash-Next-Uncensored-") {
        if let Err(reason) = orca_import::check_shard_name(first) {
            problems.push(reason);
        } else {
            warnings.push("OrcaRouter 去审查模型：按上游 ORCA.md 的兼容流程打包（--compat-bf16），上下文固定 32K、仅文本".into());
        }
        ("orca", Some("orca".to_owned()))
    } else if let Some((family, _)) = official_choice(first) {
        ("official", Some(family))
    } else if let Some(q) = quant.as_deref().filter(|q| SUPPORTED_QUANTS.contains(q)) {
        match inferred_family(stem, q) {
            Some(family) => {
                warnings.push(format!("文件名与官方发布名不同；官方安装器会把它当作 --family {family} --model {q} 使用。请确认这是该模型的 {q} 版本，同一目录中不要再放其他 {q} 文件"));
                ("renamed", Some(family.to_owned()))
            }
            None => {
                problems.push(format!(
                    "无法确定 {q} 文件对应的官方模型系列；{SUPPORTED_GGUFS}"
                ));
                ("unknown", None)
            }
        }
    } else if let Some(q) = quant.as_deref() {
        problems.push(format!(
            "{q} 量化 Strata 引擎无法运行（不是名单限制，引擎没有对应内核）。{SUPPORTED_GGUFS}"
        ));
        ("unsupported", None)
    } else {
        problems.push(format!("无法从文件名识别量化版本。{SUPPORTED_GGUFS}"));
        ("unknown", None)
    };
    if total > 1 && shards.first().is_some_and(|s| s.name != first) {
        problems.push(format!("请选择第 1 个分片（{}）所在的目录", names[0]));
    }
    let installable = complete && problems.is_empty() && kind != "unsupported" && kind != "unknown";
    LocalModelGroup {
        id: names[0].clone(),
        name: stem.to_owned(),
        first_shard: names[0].clone(),
        quant: if kind == "orca" {
            quant.or(Some(orca_import::QUANT.into()))
        } else {
            quant
        },
        kind: kind.into(),
        family,
        shards,
        total_bytes,
        complete,
        installable,
        warnings,
        problems,
    }
}

fn has_model_gguf(directory: &Path) -> bool {
    fs::read_dir(directory).is_ok_and(|entries| {
        entries.take(MAX_ENTRIES).flatten().any(|e| {
            let lower = e.file_name().to_string_lossy().to_ascii_lowercase();
            lower.ends_with(".gguf") && !lower.starts_with("mmproj") && e.path().is_file()
        })
    })
}

/// Folders below `root` (up to three levels) that hold model GGUFs: a Hugging Face repository downloaded whole
/// keeps each quantization in its own folder (`UD-Q6_K_XL/`, ISTA-DASLab's `IQ3_S/`), and the hub cache adds
/// `snapshots/<revision>/`. Hidden folders (`.cache`, `.git`) and the cache's `blobs` are not models.
fn gguf_folders(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut level = vec![root.to_owned()];
    for _ in 0..3 {
        let mut next = Vec::new();
        for dir in &level {
            let Ok(entries) = fs::read_dir(dir) else {
                continue;
            };
            for entry in entries.take(256).flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let path = entry.path();
                if name.starts_with('.') || name == "blobs" || !path.is_dir() {
                    continue;
                }
                if has_model_gguf(&path) {
                    found.push(path);
                } else {
                    next.push(path);
                }
            }
        }
        if !found.is_empty() || next.is_empty() {
            break;
        }
        level = next;
    }
    // The hub cache: only the revision refs/main points to, when it is among them.
    let snapshot = |p: &Path| {
        p.ancestors()
            .find(|a| {
                a.parent()
                    .and_then(Path::file_name)
                    .is_some_and(|n| n == "snapshots")
            })
            .map(Path::to_owned)
    };
    if let Some(main) = found.iter().find_map(|p| snapshot(p)).and_then(|snap| {
        let repo = snap.parent()?.parent()?;
        let revision = fs::read_to_string(repo.join("refs").join("main")).ok()?;
        Some(repo.join("snapshots").join(revision.trim()))
    }) {
        if found.iter().any(|p| p.starts_with(&main)) {
            found.retain(|p| p.starts_with(&main));
        }
    }
    found.sort();
    found
}

/// Read-only scan of a folder (or the folder of a chosen GGUF file). A folder without GGUFs whose model files
/// are one folder down (a whole Hugging Face repository, or its hub-cache folder) is scanned there when there is
/// exactly one such folder; otherwise the folders are named.
pub fn scan(path: &str) -> Result<LocalModelScan, String> {
    let chosen = absolute(path, "模型目录或 GGUF 文件")?;
    if chosen.is_dir() && !has_model_gguf(&chosen) {
        let folders = gguf_folders(&chosen);
        if folders.len() == 1 {
            return scan_at(&folders[0]);
        }
        if folders.len() > 1 {
            let mut result = scan_at(&chosen)?;
            let names: Vec<String> = folders
                .iter()
                .take(12)
                .map(|f| {
                    f.strip_prefix(&chosen)
                        .unwrap_or(f)
                        .to_string_lossy()
                        .into_owned()
                })
                .collect();
            result.problems = vec![format!(
                "{} 里没有直接放 GGUF 文件，模型在子目录里（Hugging Face 仓库每个量化一个目录）：{}。请选择要用的那个量化目录",
                chosen.display(),
                names.join("、")
            )];
            return Ok(result);
        }
    }
    scan_at(&chosen)
}

fn scan_at(path: &Path) -> Result<LocalModelScan, String> {
    let path = path.to_owned();
    let meta = fs::metadata(&path).map_err(|e| format!("无法访问 {}: {e}", path.display()))?;
    let (directory, selected_file) = if meta.is_file() {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if !name.to_ascii_lowercase().ends_with(".gguf") {
            return Err(format!("{name} 不是 .gguf 文件"));
        }
        (
            path.parent().ok_or("文件没有所在目录")?.to_owned(),
            Some(name),
        )
    } else {
        (path.clone(), None)
    };
    let entries = fs::read_dir(&directory)
        .map_err(|e| format!("无法读取目录 {}: {e}", directory.display()))?;
    let mut firsts: Vec<(String, String, u32)> = Vec::new();
    let mut later: Vec<(String, u32)> = Vec::new();
    for entry in entries.take(MAX_ENTRIES).flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let lower = name.to_ascii_lowercase();
        if !lower.ends_with(".gguf")
            || lower.starts_with("mmproj")
            || !entry
                .file_type()
                .is_ok_and(|t| t.is_file() || t.is_symlink())
        {
            continue;
        }
        match shard_parts(&name) {
            Some((1, total, stem)) => firsts.push((name.clone(), stem.to_owned(), total)),
            Some((_, total, stem)) => later.push((stem.to_owned(), total)),
            None => firsts.push((name.clone(), name[..name.len() - 5].to_owned(), 1)),
        }
    }
    // A later shard without its first one still shows up, so a missing shard 1 is explained.
    for (stem, total) in later {
        if !firsts.iter().any(|(_, s, t)| s == &stem && *t == total) {
            firsts.push((format!("{stem}-00001-of-{total:05}.gguf"), stem, total));
        }
    }
    firsts.sort();
    firsts.dedup();
    let mut groups: Vec<LocalModelGroup> = firsts
        .iter()
        .map(|(first, stem, total)| group(&directory, first, stem, *total))
        .collect();
    let rank = |g: &LocalModelGroup| match g.kind.as_str() {
        "official" => 0,
        "renamed" => 1,
        "orca" => 2,
        _ => 3,
    };
    groups.sort_by(|a, b| {
        (!a.installable, rank(a), &a.name).cmp(&(!b.installable, rank(b), &b.name))
    });
    let mut problems = Vec::new();
    if groups.is_empty() {
        problems.push(format!(
            "{} 中没有找到 GGUF 模型文件（mmproj 视觉文件除外）",
            directory.display()
        ));
    }
    Ok(LocalModelScan {
        directory: directory.to_string_lossy().into(),
        selected_file,
        groups,
        problems,
    })
}

/// `--mtp`'s draft layer: an `rt` folder holding `experts.bin`. `<x>/rt`, `<x>/mtp/rt` and `<x>` are accepted.
pub fn check_mtp(path: &str) -> Result<MtpCheck, String> {
    let input = absolute(path, "MTP 草稿层目录")?;
    let candidates = [
        input.clone(),
        input.join("rt"),
        input.join("mtp").join("rt"),
    ];
    let found = candidates
        .iter()
        .find(|c| disk::file_len(&c.join("experts.bin")).unwrap_or(0) > 0);
    let mut problems = Vec::new();
    let (rt, data) = match found {
        Some(rt) => {
            let parent = rt.parent().map(Path::to_owned);
            let data = parent
                .as_ref()
                .filter(|p| {
                    p.file_name()
                        .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("mtp"))
                })
                .and_then(|p| p.parent())
                .map(Path::to_owned);
            (Some(rt.clone()), data)
        }
        None => {
            problems.push(format!(
                "{} 中没有找到 MTP 草稿层（需要 rt\\experts.bin，例如 Strata-data\\mtp\\rt）",
                input.display()
            ));
            (None, None)
        }
    };
    let experts_bytes = rt
        .as_ref()
        .map(|rt| disk::file_len(&rt.join("experts.bin")).unwrap_or(0))
        .unwrap_or(0);
    Ok(MtpCheck {
        input: input.to_string_lossy().into(),
        rt_directory: rt.map(|p| p.to_string_lossy().into()),
        data_directory: data.map(|p| p.to_string_lossy().into()),
        experts_bytes,
        problems,
    })
}

/// The scanned group that `run_setup` installs for (family, quant), or why the folder cannot be used.
pub fn setup_group(
    request: &LocalModelRequest,
    family: &str,
    quant: &str,
) -> Result<LocalModelGroup, String> {
    let scan = scan(&request.gguf_directory)?;
    if scan.selected_file.is_some() {
        return Err("请选择模型所在目录（--gguf-dir 是目录）".into());
    }
    let matching: Vec<&LocalModelGroup> = scan
        .groups
        .iter()
        .filter(|g| {
            matches!(g.kind.as_str(), "official" | "renamed")
                && g.family.as_deref() == Some(family)
                && g.quant.as_deref() == Some(quant)
        })
        .collect();
    let Some(group) = matching.first() else {
        return Err(format!(
            "{} 中没有 --family {family} --model {quant} 可用的 GGUF 文件",
            scan.directory
        ));
    };
    if matching.len() > 1 && matching.iter().all(|g| g.kind == "renamed") {
        return Err(format!(
            "目录中有多个 {quant} 文件，官方安装器无法确定使用哪一个；请只保留一个模型的分片"
        ));
    }
    if !group.installable {
        return Err(group
            .problems
            .first()
            .cloned()
            .unwrap_or_else(|| "所选模型文件不完整".into()));
    }
    Ok((*group).clone())
}

/// The MTP data folder for setup's `--data-dir`, or why the chosen layout cannot be found by setup.
pub fn setup_mtp_data(request: &LocalModelRequest) -> Result<Option<PathBuf>, String> {
    let Some(path) = request.mtp_path.as_deref().filter(|p| !p.trim().is_empty()) else {
        return Ok(None);
    };
    let check = check_mtp(path)?;
    if let Some(problem) = check.problems.first() {
        return Err(problem.clone());
    }
    check
        .data_directory
        .map(PathBuf::from)
        .map(Some)
        .ok_or_else(|| {
            "官方安装器只在 <数据目录>\\mtp\\rt 查找 MTP 草稿层；请选择名为 mtp 的目录下的 rt 目录"
                .into()
        })
}

fn drive(path: &Path) -> Option<String> {
    match path.components().next()? {
        Component::Prefix(prefix) => {
            Some(prefix.as_os_str().to_string_lossy().to_ascii_uppercase())
        }
        _ => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                let existing = path.ancestors().find(|p| p.exists())?;
                fs::metadata(existing).ok().map(|m| m.dev().to_string())
            }
            #[cfg(not(unix))]
            {
                None
            }
        }
    }
}

/// Upstream's data-folder migration moves `<source>/models` on the data folder's drive into the data folder.
/// Refuse a `--data-dir` that would move the `--gguf-dir` files away from under setup.
pub fn migration_hazard(gguf_directory: &Path, data: &Path) -> Option<String> {
    let containing = gguf_directory
        .ancestors()
        .find(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("models"))
        })
        .and_then(Path::parent)?;
    // Only Strata folders (setup.py beside them) and Strata-data folders are migration sources upstream.
    let source = containing.join("setup.py").is_file()
        || containing
            .file_name()
            .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("Strata-data"));
    if !source || containing == data || drive(containing) != drive(data) || drive(data).is_none() {
        return None;
    }
    Some(format!(
        "模型目录位于 {}，与 MTP 所在的数据目录 {} 在同一磁盘；官方安装器会把同盘旧数据目录中的模型移动到新数据目录，--gguf-dir 将失效。请把 MTP 放到 {}\\mtp\\rt，或不指定 MTP",
        containing.display(),
        data.display(),
        containing.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::gguf_check::fixture::{self, Tensor};

    /// A metadata-only GGUF padded to `size` (whole: its header lists no tensors).
    fn gguf(path: &Path, size: u64) {
        fixture::write(path, None, &[], 0);
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_len(size)
            .unwrap();
    }
    fn tensors() -> Vec<Tensor> {
        vec![
            Tensor {
                name: "blk.0.ffn_down_exps",
                dims: vec![256, 512],
                type_id: 14,
            },
            Tensor {
                name: "output_norm",
                dims: vec![64],
                type_id: 0,
            },
        ]
    }
    const BIG: u64 = 64 * 1024 * 1024 + 1;

    #[test]
    fn quant_names_follow_setup_gguf_quant() {
        assert_eq!(
            quant_of("Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S").as_deref(),
            Some("IQ3_S")
        );
        assert_eq!(
            quant_of("Qwen3.8-Flash-Next-UD-IQ4_XS").as_deref(),
            Some("UD-IQ4_XS")
        );
        assert_eq!(
            quant_of("Qwen3.8-Flash-Next-Uncensored-iq3_xxs").as_deref(),
            Some("IQ3_XXS")
        );
        assert_eq!(quant_of("model-Q4_K_M").as_deref(), Some("Q4_K_M"));
        assert_eq!(quant_of("Qwen3.8-Flash-Next-BF16").as_deref(), Some("BF16"));
        assert_eq!(quant_of("readme"), None);
        assert_eq!(
            shard_parts("A-IQ3_S-00002-of-00002.gguf"),
            Some((2, 2, "A-IQ3_S"))
        );
        assert_eq!(shard_parts("single.gguf"), None);
    }

    #[test]
    fn official_shards_map_to_family_and_model() {
        let dir = tempfile::tempdir().unwrap();
        for i in 1..=2 {
            gguf(
                &dir.path().join(format!(
                    "Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-{i:05}-of-00002.gguf"
                )),
                BIG,
            );
        }
        let scan = scan(&dir.path().to_string_lossy()).unwrap();
        let g = &scan.groups[0];
        assert_eq!(
            (g.kind.as_str(), g.family.as_deref(), g.quant.as_deref()),
            ("official", Some("qwen"), Some("IQ3_S"))
        );
        assert!(g.installable && g.complete, "{g:?}");
        let request = LocalModelRequest {
            gguf_directory: dir.path().to_string_lossy().into(),
            mtp_path: None,
        };
        assert_eq!(setup_group(&request, "qwen", "IQ3_S").unwrap().id, g.id);
        assert!(setup_group(&request, "qwen", "IQ3_XXS")
            .unwrap_err()
            .contains("--model IQ3_XXS"));
    }

    #[test]
    fn a_missing_or_broken_shard_is_explained_in_chinese() {
        let dir = tempfile::tempdir().unwrap();
        gguf(
            &dir.path()
                .join("Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ2_XS-00001-of-00002.gguf"),
            BIG,
        );
        let scan1 = scan(&dir.path().to_string_lossy()).unwrap();
        assert!(!scan1.groups[0].installable);
        assert!(
            scan1.groups[0].problems[0].contains("缺少分片"),
            "{:?}",
            scan1.groups[0].problems
        );
        let second = dir
            .path()
            .join("Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ2_XS-00002-of-00002.gguf");
        fs::write(&second, vec![0_u8; 16]).unwrap();
        fs::File::options()
            .write(true)
            .open(&second)
            .unwrap()
            .set_len(BIG)
            .unwrap();
        let scan2 = scan(&dir.path().to_string_lossy()).unwrap();
        assert!(
            scan2.groups[0]
                .problems
                .iter()
                .any(|p| p.contains("不是有效的 GGUF")),
            "{:?}",
            scan2.groups[0].problems
        );
        fixture::write(&second, Some((1, 2)), &tensors(), 100);
        let scan3 = scan(&dir.path().to_string_lossy()).unwrap();
        assert!(scan3.groups[0]
            .problems
            .iter()
            .any(|p| p.contains("不完整") && p.contains("缺 100 字节")));
    }

    /// The reported false positive: Unsloth's UD-Q6_K_XL shard 1 is gguf-split metadata only, 10,946,624
    /// bytes (setup.py's pinned size). A 64 MiB size floor called it 「文件不完整」 and the model 不可用.
    #[test]
    fn a_small_metadata_only_first_split_is_whole_and_installable() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir
            .path()
            .join("Qwen3.8-Flash-Next-UD-Q6_K_XL-00001-of-00006.gguf");
        fixture::write(&first, Some((0, 6)), &[], 0);
        fs::File::options()
            .write(true)
            .open(&first)
            .unwrap()
            .set_len(10_946_624)
            .unwrap();
        for i in 2..=6_u16 {
            fixture::write(
                &dir.path().join(format!(
                    "Qwen3.8-Flash-Next-UD-Q6_K_XL-{i:05}-of-00006.gguf"
                )),
                Some((i - 1, 6)),
                &tensors(),
                0,
            );
        }
        let found = super::scan(&dir.path().to_string_lossy()).unwrap();
        let g = &found.groups[0];
        assert_eq!(
            (g.kind.as_str(), g.family.as_deref(), g.quant.as_deref()),
            ("official", Some("unsloth"), Some("UD-Q6_K_XL"))
        );
        assert!(g.complete && g.installable, "{g:?}");
        assert_eq!(g.shards[0].bytes, 10_946_624);
        let request = LocalModelRequest {
            gguf_directory: dir.path().to_string_lossy().into(),
            mtp_path: None,
        };
        assert!(setup_group(&request, "unsloth", "UD-Q6_K_XL").is_ok());

        // A truncated shard 4 is still refused, with the numbers; a download leftover is named.
        let fourth = dir
            .path()
            .join("Qwen3.8-Flash-Next-UD-Q6_K_XL-00004-of-00006.gguf");
        fixture::write(&fourth, Some((3, 6)), &tensors(), 4096);
        let cache = dir.path().join(".cache/huggingface/download");
        fs::create_dir_all(&cache).unwrap();
        fs::write(
            cache.join("Qwen3.8-Flash-Next-UD-Q6_K_XL-00004-of-00006.gguf.abc123.incomplete"),
            b"x",
        )
        .unwrap();
        let found = super::scan(&dir.path().to_string_lossy()).unwrap();
        let g = &found.groups[0];
        assert!(!g.installable);
        assert_eq!(g.shards[3].state, "tooSmall");
        assert!(
            g.problems[0].contains("00004-of-00006")
                && g.problems[0].contains("缺 4096 字节")
                && g.problems[0].contains(".incomplete"),
            "{:?}",
            g.problems
        );
        assert!(setup_group(&request, "unsloth", "UD-Q6_K_XL")
            .unwrap_err()
            .contains("不完整"));

        // A missing shard, and a shard of another split put under this name.
        fs::remove_file(&fourth).unwrap();
        fixture::write(
            &dir.path()
                .join("Qwen3.8-Flash-Next-UD-Q6_K_XL-00005-of-00006.gguf"),
            Some((4, 4)),
            &tensors(),
            0,
        );
        let found = super::scan(&dir.path().to_string_lossy()).unwrap();
        let problems = &found.groups[0].problems;
        assert!(
            problems
                .iter()
                .any(|p| p.contains("缺少分片") && p.contains("00004")),
            "{problems:?}"
        );
        assert!(
            problems.iter().any(|p| p.contains("共 4 个")),
            "{problems:?}"
        );
    }

    /// Hugging Face layouts: `hf download --local-dir` of the whole repo (a folder per quantization plus
    /// `.cache/huggingface`), and the hub cache (`snapshots/<rev>/<quant>/` symlinks into `blobs/`), under a
    /// path with spaces and Chinese characters.
    #[test]
    fn hugging_face_repo_and_hub_cache_layouts_are_found() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("我的 模型").join("Qwen3.8-Flash-Next-GGUF");
        let quant = root.join("UD-Q4_K_XL");
        fs::create_dir_all(&quant).unwrap();
        fs::create_dir_all(root.join(".cache/huggingface/download/UD-Q4_K_XL")).unwrap();
        for i in 1..=4 {
            gguf(
                &quant.join(format!(
                    "Qwen3.8-Flash-Next-UD-Q4_K_XL-{i:05}-of-00004.gguf"
                )),
                1024,
            );
        }
        let found = scan(&root.to_string_lossy()).unwrap();
        assert_eq!(found.directory, quant.to_string_lossy());
        assert!(found.groups[0].installable, "{found:?}");
        assert_eq!(found.groups[0].family.as_deref(), Some("unsloth"));

        // Two quantizations: name both instead of guessing.
        let other = root.join("UD-Q6_K_XL");
        fs::create_dir_all(&other).unwrap();
        gguf(
            &other.join("Qwen3.8-Flash-Next-UD-Q6_K_XL-00001-of-00006.gguf"),
            1024,
        );
        let found = scan(&root.to_string_lossy()).unwrap();
        assert!(found.groups.is_empty());
        assert!(
            found.problems[0].contains("UD-Q4_K_XL") && found.problems[0].contains("UD-Q6_K_XL"),
            "{:?}",
            found.problems
        );

        #[cfg(unix)]
        {
            let repo = dir
                .path()
                .join("hub")
                .join("models--unsloth--Qwen3.8-Flash-Next-GGUF");
            let blobs = repo.join("blobs");
            let old = repo.join("snapshots").join("aaaa").join("UD-Q4_K_XL");
            let main = repo.join("snapshots").join("bbbb").join("UD-Q4_K_XL");
            for d in [&blobs, &old, &main, &repo.join("refs")] {
                fs::create_dir_all(d).unwrap();
            }
            fs::write(repo.join("refs").join("main"), "bbbb").unwrap();
            for i in 1..=4 {
                let name = format!("Qwen3.8-Flash-Next-UD-Q4_K_XL-{i:05}-of-00004.gguf");
                let blob = blobs.join(format!("{i:064x}"));
                gguf(&blob, 1024);
                std::os::unix::fs::symlink(&blob, main.join(&name)).unwrap();
                std::os::unix::fs::symlink(&blob, old.join(&name)).unwrap();
            }
            let found = scan(&repo.to_string_lossy()).unwrap();
            assert_eq!(
                found.directory,
                main.to_string_lossy(),
                "refs/main's revision"
            );
            let g = &found.groups[0];
            assert!(g.installable && g.total_bytes == 4096, "{g:?}");
            // A blob still downloading: the symlink's shard is cut short and refused.
            fixture::write(
                &blobs.join(format!("{:064x}", 3)),
                Some((2, 4)),
                &tensors(),
                1,
            );
            let found = scan(&main.to_string_lossy()).unwrap();
            assert_eq!(found.groups[0].shards[2].state, "tooSmall");
        }
    }

    #[test]
    fn renamed_files_warn_and_unsupported_quants_explain_the_engine_limit() {
        let dir = tempfile::tempdir().unwrap();
        gguf(&dir.path().join("my-qwen-IQ3_XXS.gguf"), BIG);
        gguf(
            &dir.path()
                .join("Qwen3.8-Flash-Next-UD-Q2_K_XL-00001-of-00001.gguf"),
            BIG,
        );
        gguf(&dir.path().join("mmproj-F16.gguf"), BIG);
        let scan = scan(&dir.path().to_string_lossy()).unwrap();
        assert_eq!(scan.groups.len(), 2, "mmproj is not a model");
        let renamed = scan.groups.iter().find(|g| g.kind == "renamed").unwrap();
        assert!(renamed.installable && !renamed.warnings.is_empty());
        assert_eq!(renamed.family.as_deref(), Some("qwen"));
        let bad = scan
            .groups
            .iter()
            .find(|g| g.kind == "unsupported")
            .unwrap();
        assert!(
            !bad.installable
                && bad.problems[0].contains("UD-Q2_K_XL")
                && bad.problems[0].contains("内核")
        );
    }

    #[test]
    fn orca_shards_route_to_the_orca_md_import() {
        let dir = tempfile::tempdir().unwrap();
        for (name, _) in orca_import::SHARDS {
            gguf(&dir.path().join(name), BIG);
        }
        gguf(
            &dir.path()
                .join("Qwen3.8-Flash-Next-Uncensored-IQ3_M-00001-of-00002.gguf"),
            BIG,
        );
        let path = dir.path().join(orca_import::SHARDS[0].0);
        let scan = scan(&path.to_string_lossy()).unwrap();
        assert_eq!(
            scan.selected_file.as_deref(),
            Some(orca_import::SHARDS[0].0)
        );
        let ok = scan
            .groups
            .iter()
            .find(|g| g.id == orca_import::SHARDS[0].0)
            .unwrap();
        assert_eq!((ok.kind.as_str(), ok.installable), ("orca", true));
        let m = scan
            .groups
            .iter()
            .find(|g| g.name.contains("IQ3_M"))
            .unwrap();
        assert!(!m.installable && m.problems.iter().any(|p| p.contains("Q5_0")));
    }

    #[test]
    fn mtp_paths_resolve_to_rt_and_the_setup_data_folder() {
        let dir = tempfile::tempdir().unwrap();
        let rt = dir.path().join("Strata-data").join("mtp").join("rt");
        fs::create_dir_all(&rt).unwrap();
        fs::write(rt.join("experts.bin"), b"x").unwrap();
        for input in [
            rt.clone(),
            rt.parent().unwrap().to_owned(),
            dir.path().join("Strata-data"),
        ] {
            let check = check_mtp(&input.to_string_lossy()).unwrap();
            assert_eq!(
                check.rt_directory.as_deref(),
                Some(rt.to_string_lossy().as_ref())
            );
            assert_eq!(
                check.data_directory.as_deref(),
                Some(dir.path().join("Strata-data").to_string_lossy().as_ref())
            );
        }
        let request = LocalModelRequest {
            gguf_directory: "/x".into(),
            mtp_path: Some(rt.to_string_lossy().into()),
        };
        assert_eq!(
            setup_mtp_data(&request).unwrap(),
            Some(dir.path().join("Strata-data"))
        );
        let empty = check_mtp(&dir.path().to_string_lossy()).unwrap();
        assert!(empty.rt_directory.is_none() && empty.problems[0].contains("experts.bin"));
        let loose = dir.path().join("draft").join("rt");
        fs::create_dir_all(&loose).unwrap();
        fs::write(loose.join("experts.bin"), b"x").unwrap();
        let request = LocalModelRequest {
            gguf_directory: "/x".into(),
            mtp_path: Some(loose.to_string_lossy().into()),
        };
        assert!(setup_mtp_data(&request).unwrap_err().contains("mtp"));
    }

    #[test]
    fn same_drive_data_folders_that_would_move_the_gguf_dir_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let models = dir.path().join("Strata-0.1.45").join("models");
        let data = dir.path().join("Strata-data");
        fs::create_dir_all(&models).unwrap();
        fs::create_dir_all(&data).unwrap();
        assert!(
            migration_hazard(&models, &data).is_none(),
            "a folder that is not a Strata install is never migrated"
        );
        fs::write(models.parent().unwrap().join("setup.py"), b"").unwrap();
        assert!(migration_hazard(&models, &data)
            .unwrap()
            .contains("--gguf-dir"));
        assert!(migration_hazard(&models, models.parent().unwrap()).is_none());
        assert!(
            migration_hazard(&dir.path().join("plain"), &data).is_none(),
            "no models/ ancestor: nothing migrates"
        );
    }
}
