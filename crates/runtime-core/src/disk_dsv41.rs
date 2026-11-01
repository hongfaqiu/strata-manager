//! DeepSeek-V4.1-Flash (setup.py MULTI_FILE_FAMILIES "deepseek41", Strata 0.2.5+): the official IST-DAS sets,
//! their shards and the files every set shares, and the disk plan setup.py's own check makes (setup.py 8100-8142,
//! strata_control/dsv41_fit.py). Sizes are setup.py v0.2.6's pinned DSV41_ISTA_FILES / DSV41_FILES bytes.
//! Checked 2026-10-26 against the Hugging Face API (paths-info, LFS size + sha256) at the revisions setup.py downloads
//! (HF_REVISIONS: ISTA-DASLab/DeepSeek-V4.1-Flash-1017-GSQ-RCO-GGUF cb02422c, unsloth/DeepSeek-V4.1-Flash-1017-GGUF
//! f924b94f): every size here and every pinned sha256 match. ISTA-DASLab's `main` has since replaced the first shard of each
//! set (about 11 KB larger); setup.py keeps downloading the pinned revision, so these stay until a Strata release moves the pin.

use std::fs;
use std::path::{Path, PathBuf};

use super::{exists, file_len, Plan, GB, SOURCE};
use crate::types::{SetupDiskPreflight, SetupDiskVolume};

pub(crate) const FAMILY: &str = "deepseek41";
/// setup.py fam["tag"]: a set's folder is `models/deepseek-v4.1-flash-<model>`.
pub(crate) const TAG_PREFIX: &str = "deepseek-v4.1-flash-";
/// setup.py fam["name"]: one model_name for every set (no quant suffix).
pub(crate) const MODEL_NAME: &str = "deepseek-v4.1-flash";
/// setup.py dsv41_shared_dir: `models/<tag prefix>shared`.
pub(crate) const SHARED_DIR: &str = "deepseek-v4.1-flash-shared";
/// setup.py DSV41_CONTEXT: the context the engine was checked at, and the default from 0.2.7 on.
pub(crate) const CONTEXT: u32 = 8192;
/// Strata 0.2.7 (control 0.1.52, strata_control/dsv41_context.py): setup takes `--context` 8K to 1M. Older
/// releases were checked at 8K only, so Manager keeps them there.
pub(crate) const CONTEXT_RELEASE: [u32; 3] = [0, 2, 7];
/// dsv41_context.TESTED: past this the sizes are "not tested yet".
pub(crate) const TESTED_CONTEXT: u32 = 262_144;
/// dsv41_context.NATIVE: the positions the model reads; the most any pack can say.
pub(crate) const NATIVE_CONTEXT: u32 = 1_048_576;
/// Graphics memory per context token. Strata 0.2.7 release notes: on an RTX 5070 a 1M context "cost about 1 GB of
/// graphics memory, which pushed 136 experts off the card"; 136 experts of the 2.25 set (149.06 GB / 15,360) are
/// 1.32 GB, so ~1,259 bytes a token. It comes out of the card's expert cache.
pub(crate) const CONTEXT_VRAM_BYTES_PER_TOKEN: u64 = 1259;
/// dsv41_fit.DISK_HEADROOM_GB: the pack folder and room to work.
pub(crate) const HEADROOM_BYTES: u64 = 6 * GB;
/// The pack: the engine's map of the shards, the hash tables and the tokenizer ("a few MB").
const PACK_BYTES: u64 = 64 * 1024 * 1024;

/// How setup.py packs and checks a set (md["recipe"]): ISTA-DASLab's IST-DAS sets, or Unsloth's 1-bit UD-IQ1 sets
/// ("udlow", Strata 0.2.9): their own shard 1 carries the metadata and their shard 5 is the Engram table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Recipe {
    Ista,
    UdLow,
}

/// Which split of a set the files are (setup.py dsv41_layout_of): the pinned four-shard files, or ISTA-DASLab's
/// 2026-10-27 six-shard re-split (five files of the set; the sixth is the Engram), taken only from files already here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Layout {
    Four,
    Six,
}

pub(crate) struct Dsv41Set {
    /// `--model` for setup.py.
    pub model: &'static str,
    /// The GGUF quant in the shard names.
    pub quant: &'static str,
    pub recipe: Recipe,
    pub shards: [u64; 4],
    /// setup.py DSV41_NEW_SHARD1: ISTA's 2026-10-26 shard 1 (the same weights, a larger chat template). Never
    /// downloaded; accepted from files already here (Strata 0.2.9).
    pub new_shard1: Option<u64>,
    /// setup.py DSV41_ISTA6_FILES: the six-shard layout's five files of the set (Strata 0.2.9, files already here).
    pub six: Option<[u64; 5]>,
    /// An Unsloth set's own shard 5: the same Engram data as ISTA's Engram file, used in its place.
    pub engram_shard: Option<u64>,
    /// dsv41_fit ISTA_SETS ram_ok_gb (GB of RAM it was measured to run well with).
    pub ram_ok_gb: f64,
    /// dsv41_fit ISTA_SETS experts_gb.
    pub experts_gb: f64,
    /// The first Strata release whose setup.py offers this set.
    pub min_release: [u32; 3],
}

impl Dsv41Set {
    pub(crate) fn bytes(&self) -> u64 {
        self.shards.iter().sum()
    }
    pub(crate) fn tag(&self) -> String {
        format!("{TAG_PREFIX}{}", self.model)
    }
    pub(crate) fn shard_names(&self) -> Vec<String> {
        (1..=4).map(|i| self.shard_name(i)).collect()
    }
    fn shard_name(&self, i: u32) -> String {
        match self.recipe {
            // setup.py DSV41_ISTA_SHARD
            Recipe::Ista => format!(
                "DeepSeek-V4.1-Flash-1017-GSQ-RCO-{}-{i:05}-of-00004.gguf",
                self.quant
            ),
            // setup.py DSV41_UD_SHARD
            Recipe::UdLow => format!(
                "DeepSeek-V4.1-Flash-1017-{}-{i:05}-of-00005.gguf",
                self.quant
            ),
        }
    }
    /// setup.py DSV41_ISTA6_SHARD, files 1-5 (none for an Unsloth set).
    pub(crate) fn six_names(&self) -> Vec<String> {
        if self.six.is_none() {
            return Vec::new();
        }
        (1..=5)
            .map(|i| {
                format!(
                    "DeepSeek-V4.1-Flash-1017-GSQ-RCO-{}-{i:05}-of-00006.gguf",
                    self.quant
                )
            })
            .collect()
    }
    /// md["engram_shard"]: an Unsloth set's shard 5, the Engram data under its own name and size.
    pub(crate) fn engram_shard_name(&self) -> Option<String> {
        self.engram_shard.map(|_| self.shard_name(5))
    }
    /// md["shared"]: Engram, Unsloth's metadata shard (IST-DAS only; an Unsloth set's own shard 1 carries it), drafter.
    pub(crate) fn shared_files(&self) -> Vec<(&'static str, u64)> {
        SHARED_FILES
            .iter()
            .copied()
            .filter(|(name, _)| self.recipe == Recipe::Ista || *name != SHARED_FILES[1].0)
            .collect()
    }
    /// The files of `layout` and the sizes each is accepted at (shard 1 of the four-shard layout also at ISTA's newer size).
    pub(crate) fn layout_files(&self, layout: Layout) -> Vec<(String, Vec<u64>)> {
        match layout {
            Layout::Four => self
                .shard_names()
                .into_iter()
                .zip(self.shards)
                .enumerate()
                .map(|(i, (name, size))| {
                    let mut sizes = vec![size];
                    if i == 0 {
                        sizes.extend(self.new_shard1);
                    }
                    (name, sizes)
                })
                .collect(),
            Layout::Six => self
                .six_names()
                .into_iter()
                .zip(self.six.unwrap_or_default())
                .map(|(name, size)| (name, vec![size]))
                .collect(),
        }
    }
}

/// The official sets, the recommended one first (dsv41_fit.recommend: 2.00, else 1.75; 2.25 and the Unsloth 1-bit
/// sets only by choice).
pub(crate) const DSV41_SETS: [Dsv41Set; 5] = [
    Dsv41Set {
        model: "IST-DAS-2.00bpw",
        quant: "IQ2_XXS",
        recipe: Recipe::Ista,
        shards: [
            39_075_714_624,
            39_388_449_504,
            39_246_891_616,
            20_527_837_312,
        ],
        new_shard1: Some(39_075_725_728),
        six: Some([
            5_780_704,
            39_535_781_184,
            39_736_712_000,
            39_036_908_384,
            19_923_784_832,
        ]),
        engram_shard: None,
        ram_ok_gb: 40.0,
        experts_gb: 132.07,
        min_release: [0, 2, 5],
    },
    Dsv41Set {
        model: "IST-DAS-1.75bpw",
        quant: "IQ1_M",
        recipe: Recipe::Ista,
        shards: [
            39_358_830_464,
            39_176_113_248,
            39_997_334_720,
            2_188_841_824,
        ],
        new_shard1: Some(39_358_841_536),
        six: Some([
            5_780_704,
            39_340_012_896,
            38_698_805_888,
            39_707_055_008,
            2_969_539_840,
        ]),
        engram_shard: None,
        ram_ok_gb: 34.0,
        experts_gb: 114.56,
        min_release: [0, 2, 5],
    },
    Dsv41Set {
        model: "IST-DAS-2.25bpw",
        quant: "IQ2_XS",
        recipe: Recipe::Ista,
        shards: [
            39_535_776_992,
            39_494_617_536,
            39_423_838_496,
            36_771_591_232,
        ],
        new_shard1: Some(39_535_788_064),
        six: Some([
            5_780_704,
            39_581_533_600,
            39_417_972_640,
            39_079_187_648,
            37_141_423_776,
        ]),
        engram_shard: None,
        ram_ok_gb: 44.0,
        experts_gb: 149.06,
        min_release: [0, 2, 5],
    },
    // Strata 0.2.9: Unsloth's UD-IQ1_S / UD-IQ1_M (unsloth/DeepSeek-V4.1-Flash-1017-GGUF 8a6ec9cf, DSV41_UD_FILES;
    // dsv41_fit UD_SETS). Shards 1-4 are the set (shard 1 is 5.8 MB of metadata), shard 5 the Engram (not downloaded:
    // setup fetches ISTA's Engram file unless one of the two is already here).
    Dsv41Set {
        model: "UD-IQ1_S",
        quant: "UD-IQ1_S",
        recipe: Recipe::UdLow,
        shards: [5_780_868, 49_120_285_248, 48_899_707_008, 24_358_544_704],
        new_shard1: None,
        six: None,
        engram_shard: Some(110_595_290_592),
        ram_ok_gb: 36.0,
        experts_gb: 115.23,
        min_release: UD_RELEASE,
    },
    Dsv41Set {
        model: "UD-IQ1_M",
        quant: "UD-IQ1_M",
        recipe: Recipe::UdLow,
        shards: [5_780_868, 49_707_332_128, 49_292_777_280, 40_803_165_856],
        new_shard1: None,
        six: None,
        engram_shard: Some(110_595_290_592),
        ram_ok_gb: 40.0,
        experts_gb: 132.21,
        min_release: UD_RELEASE,
    },
];

/// Strata 0.2.9 (control 0.1.55): the Unsloth 1-bit sets, and DeepSeek files already here in ISTA's re-published
/// four-shard or six-shard layout (setup.py `--gguf-dir`, which Manager's 「使用已有模型」 hands over).
pub(crate) const UD_RELEASE: [u32; 3] = [0, 2, 9];
pub(crate) const LOCAL_RELEASE: [u32; 3] = [0, 2, 9];

/// The files every IST-DAS set shares (setup.py md["shared"]): the Engram n-gram table, Unsloth's metadata shard, the DSpark drafter.
pub(crate) const SHARED_FILES: [(&str, u64); 3] = [
    ("DeepSeek-V4.1-Flash-Engram-IQ4_NL.gguf", 110_595_290_816),
    (
        "DeepSeek-V4.1-Flash-1017-UD-Q8_K_XL-00001-of-00009.gguf",
        5_780_589,
    ),
    ("dspark-DeepSeek-V4.1-Flash-1017-Q8_0.gguf", 7_976_914_240),
];

pub(crate) fn set(model: &str) -> Option<&'static Dsv41Set> {
    DSV41_SETS.iter().find(|set| set.model == model)
}

/// dsv41_context.read_limit: `max_position_embeddings N` in the pack's ds4.txt; None without the file, the line, or
/// a sane value (under 1024).
pub(crate) fn pack_context_limit(pack: &Path) -> Option<u32> {
    let text = fs::read_to_string(pack.join("ds4.txt")).ok()?;
    text.lines().find_map(|line| {
        let mut words = line.split_whitespace();
        (words.next()? == "max_position_embeddings")
            .then(|| words.next()?.parse::<u32>().ok())
            .flatten()
            .filter(|value| words.next().is_none() && *value >= 1024)
    })
}

/// dsv41_context.problem: None when the size can run; the pack's limit (or the model's 1M) is the ceiling.
pub(crate) fn context_problem(context: u32, limit: Option<u32>) -> Option<String> {
    let cap = limit.unwrap_or(NATIVE_CONTEXT);
    if context < 1024 {
        return Some("DeepSeek-V4.1-Flash 上下文至少 1024".into());
    }
    (context > cap).then(|| {
        format!("DeepSeek-V4.1-Flash 最多读取 {cap} 个位置（模型包 ds4.txt），请选更小的上下文")
    })
}

/// Bytes still to fetch for one file: 0 when it is complete (a `.done` marker, or `own` = found outside setup's
/// shared folder at its pinned size, which setup takes as the person's), else its size minus a `.part`.
fn missing(directory: &Path, name: &str, size: u64, own: bool) -> Result<(u64, u64), String> {
    let path = directory.join(name);
    let have = file_len(&path)?;
    if have > 0 && (own || exists(&directory.join(format!("{name}.done")))?) {
        return Ok((0, have));
    }
    let partial = directory.join(format!("{name}.part"));
    if fs::symlink_metadata(&partial).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("断点下载文件指向另一个目录；请核验该文件位置后重试".into());
    }
    let part = file_len(&partial)?.min(size);
    Ok((size - part, part))
}

/// setup.py dsv41_find_shared: a shared file (or `alt`, an Unsloth set's shard 5 for the Engram) at its pinned size in the
/// shared folder or beside the shards; with `--gguf-dir` also in that folder, the two above it, and one level down from
/// any of those. A file of another size (half copied) is not taken.
fn find_shared(
    names: &[(String, u64)],
    shared: &Path,
    folder: &Path,
    gguf_directory: Option<&Path>,
) -> Option<(PathBuf, u64)> {
    let mut roots = vec![shared.to_owned(), folder.to_owned()];
    if let Some(base) = gguf_directory {
        roots.extend(base.ancestors().take(3).map(Path::to_owned));
    }
    let mut seen: Vec<PathBuf> = Vec::new();
    for root in roots {
        if seen.contains(&root) {
            continue;
        }
        seen.push(root.clone());
        let mut kids = vec![root.clone()];
        if gguf_directory.is_some() && root != shared {
            if let Ok(entries) = fs::read_dir(&root) {
                kids.extend(
                    entries
                        .take(256)
                        .flatten()
                        .map(|e| e.path())
                        .filter(|p| p.is_dir()),
                );
            }
        }
        for kid in kids {
            for (name, size) in names {
                let path = kid.join(name);
                if path.is_file() && file_len(&path).ok() == Some(*size) {
                    return Some((path, *size));
                }
            }
        }
    }
    None
}

/// The shared files still to fetch into `models/deepseek-v4.1-flash-shared` (bytes left, bytes already here).
fn shared_bytes(
    set: &Dsv41Set,
    shared_directory: &Path,
    folder: &Path,
    gguf_directory: Option<&Path>,
) -> Result<(u64, u64), String> {
    let (mut left, mut have) = (0, 0);
    for (name, size) in set.shared_files() {
        let mut names = vec![(name.to_owned(), size)];
        if name == SHARED_FILES[0].0 {
            names.extend(set.engram_shard_name().zip(set.engram_shard));
        }
        // setup.py own_files: found outside setup's shared folder (or anywhere with --gguf-dir) it is the person's.
        let (l, h) = match find_shared(&names, shared_directory, folder, gguf_directory) {
            Some((path, found))
                if gguf_directory.is_some() || path.parent() != Some(shared_directory) =>
            {
                (0, found)
            }
            _ => missing(shared_directory, name, size, false)?,
        };
        left += l;
        have += h;
    }
    Ok((left, have))
}

/// setup.py dsv41_pack_layout: the layout the pack's tensors.txt `file N` lines name, if any.
pub(crate) fn pack_layout(pack: &Path) -> Option<Layout> {
    let text = fs::read_to_string(pack.join("tensors.txt")).ok()?;
    for line in text.lines() {
        if !line.starts_with("file ") {
            break;
        }
        if line.contains("-of-00006") {
            return Some(Layout::Six);
        }
        if line.contains("-of-00004") {
            return Some(Layout::Four);
        }
    }
    None
}

/// setup.py dsv41_layout_of: six only when its files are here and the four-shard ones are not (or are not whole while the
/// six are); a folder holding both whole sets is used as the pinned four-shard one.
pub(crate) fn layout_of(set: &Dsv41Set, present: impl Fn(&str) -> bool) -> Layout {
    let four: Vec<bool> = set.shard_names().iter().map(|n| present(n)).collect();
    let six: Vec<bool> = set.six_names().iter().map(|n| present(n)).collect();
    let any_six = six.iter().any(|b| *b);
    let all_six = !six.is_empty() && six.iter().all(|b| *b);
    if any_six && (!four.iter().any(|b| *b) || (all_six && !four.iter().all(|b| *b))) {
        Layout::Six
    } else {
        Layout::Four
    }
}

/// setup.py dsv41_folder: `--gguf-dir` itself when it holds the set's files, else the set's own folder inside it
/// (an Unsloth repository keeps each set in `UD-IQ1_S/`), else the folder as given.
pub(crate) fn local_folder(set: &Dsv41Set, directory: &Path) -> PathBuf {
    let names: Vec<String> = set
        .shard_names()
        .into_iter()
        .chain(set.six_names())
        .collect();
    if names.iter().any(|n| directory.join(n).exists()) {
        return directory.to_owned();
    }
    [set.quant, set.model]
        .iter()
        .map(|sub| directory.join(sub))
        .find(|sub| sub.is_dir())
        .unwrap_or_else(|| directory.to_owned())
}

fn report(
    root: &Path,
    data: PathBuf,
    model_directory: PathBuf,
    requirements: Vec<(PathBuf, u64)>,
    download: u64,
    reusable: u64,
    gguf_directory: Option<PathBuf>,
) -> Plan {
    let mut requirements = requirements;
    // The dsv41 engine package (~0.4 GB archive, ~0.6 GB unpacked) and the Python wheels.
    requirements.push((root.to_owned(), 2 * GB));
    let additional = requirements.iter().map(|(_, bytes)| *bytes).sum();
    Plan {
        report: SetupDiskPreflight {
            status: "unknown".into(),
            data_directory: data.to_string_lossy().into(),
            model_directory: model_directory.to_string_lossy().into(),
            model_download_bytes_estimate: Some(download),
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
        gguf_directory,
    }
}

fn pack_ready(pack: &Path, layout: Layout) -> Result<bool, String> {
    Ok(exists(&pack.join("tokenizer").join("vocab.json"))?
        && exists(&pack.join("tensors.txt"))?
        // A pack points into the files it was made from: one made from the other layout is built again.
        && pack_layout(pack).is_none_or(|made| made == layout))
}

/// setup.py's disk check for a deepseek41 set: the missing shards in `models/<tag>`, the missing shared files in
/// `models/deepseek-v4.1-flash-shared` (one copy for every set), the pack, and dsv41_fit's 6 GB headroom.
pub(crate) fn plan(root: &Path, data: PathBuf, model: &str) -> Result<Plan, String> {
    let set = set(model).ok_or("模型/量化组合不被已核对的官方安装器支持")?;
    let tag = set.tag();
    let models = data.join("models");
    let model_directory = models.join(&tag);
    let shared_directory = models.join(SHARED_DIR);
    let mut reusable = 0_u64;
    let mut shard_bytes = 0_u64;
    for (name, size) in set.shard_names().iter().zip(set.shards) {
        let (left, have) = missing(&model_directory, name, size, false)?;
        shard_bytes += left;
        reusable += have;
    }
    let (shared_left, shared_have) = shared_bytes(set, &shared_directory, &model_directory, None)?;
    reusable += shared_have;
    let pack = data.join("packs").join(tag.to_lowercase());
    let pack_ready = pack_ready(&pack, Layout::Four)?;
    let download = shard_bytes + shared_left;
    let headroom = if download > 0 { HEADROOM_BYTES } else { 0 };
    let requirements = vec![
        (model_directory.clone(), shard_bytes + headroom),
        (shared_directory, shared_left),
        (pack, if pack_ready { 0 } else { PACK_BYTES }),
    ];
    Ok(report(
        root,
        data,
        model_directory,
        requirements,
        download,
        reusable,
        None,
    ))
}

/// 「使用已有模型」 for DeepSeek (Strata 0.2.9 `--gguf-dir`): the set's files must all be here at an official size (the pinned
/// four-shard files, ISTA's newer shard 1, or the six-shard re-split); only the shared files not found anywhere setup looks are
/// downloaded, and the pack is made under `data`.
pub(crate) fn local_plan(
    root: &Path,
    data: PathBuf,
    model: &str,
    directory: &Path,
) -> Result<Plan, String> {
    let set = set(model).ok_or("模型/量化组合不被已核对的官方安装器支持")?;
    let folder = local_folder(set, directory);
    let layout = layout_of(set, |n| folder.join(n).exists());
    let mut reusable = 0_u64;
    let mut wrong = Vec::new();
    for (name, sizes) in set.layout_files(layout) {
        let have = file_len(&folder.join(&name))?;
        if sizes.contains(&have) {
            reusable += have;
        } else {
            wrong.push(name);
        }
    }
    if !wrong.is_empty() {
        return Err(format!(
            "{} 中 DeepSeek {} 的文件缺少或大小与官方发布不一致：{}。Strata 只接受官方文件（按上游固定的大小核对），请等下载/复制完成后再试 / Missing or not the official size: {}",
            folder.display(),
            set.model,
            wrong.join("、"),
            wrong.join(", ")
        ));
    }
    let tag = set.tag();
    let shared_directory = data.join("models").join(SHARED_DIR);
    let (shared_left, shared_have) =
        shared_bytes(set, &shared_directory, &folder, Some(directory))?;
    reusable += shared_have;
    let pack = data.join("packs").join(tag.to_lowercase());
    let pack_ready = pack_ready(&pack, layout)?;
    let headroom = if shared_left > 0 { HEADROOM_BYTES } else { 0 };
    let requirements = vec![
        (shared_directory, shared_left + headroom),
        (pack, if pack_ready { 0 } else { PACK_BYTES }),
    ];
    Ok(report(
        root,
        data,
        folder,
        requirements,
        shared_left,
        reusable,
        Some(directory.to_owned()),
    ))
}

#[cfg(test)]
mod context_tests {
    use super::*;

    #[test]
    fn pack_limit_and_problem_follow_dsv41_context() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(pack_context_limit(dir.path()), None);
        fs::write(
            dir.path().join("ds4.txt"),
            "arch deepseek4\nmax_position_embeddings 1048576\n",
        )
        .unwrap();
        assert_eq!(pack_context_limit(dir.path()), Some(1_048_576));
        fs::write(
            dir.path().join("ds4.txt"),
            "max_position_embeddings   262144  \n",
        )
        .unwrap();
        assert_eq!(pack_context_limit(dir.path()), Some(262_144));
        fs::write(dir.path().join("ds4.txt"), "max_position_embeddings 512\n").unwrap();
        assert_eq!(pack_context_limit(dir.path()), None);
        fs::write(
            dir.path().join("ds4.txt"),
            "max_position_embeddings 4096 extra\n",
        )
        .unwrap();
        assert_eq!(pack_context_limit(dir.path()), None);

        assert_eq!(context_problem(8192, None), None);
        assert_eq!(context_problem(NATIVE_CONTEXT, None), None);
        assert!(context_problem(NATIVE_CONTEXT + 1, None).is_some());
        assert!(context_problem(512, None).is_some());
        assert!(context_problem(524_288, Some(262_144)).is_some());
        assert_eq!(context_problem(262_144, Some(262_144)), None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sets_match_setup_py_and_dsv41_fit() {
        let bytes: Vec<_> = DSV41_SETS.iter().map(Dsv41Set::bytes).collect();
        // dsv41_fit ISTA_SETS / UD_SETS set_bytes
        assert_eq!(
            bytes,
            [
                138_238_893_056,
                120_721_120_256,
                155_225_824_256,
                122_384_317_828,
                139_809_056_132
            ]
        );
        // dsv41_fit disk_total: 257 / 239 / 274 GB; the Unsloth sets 241 / 258 GB (no metadata shard of their own).
        let totals: Vec<_> = DSV41_SETS
            .iter()
            .map(|set| {
                let shared: u64 = set.shared_files().iter().map(|(_, size)| size).sum();
                ((set.bytes() + shared) as f64 / GB as f64).round() as u64
            })
            .collect();
        assert_eq!(totals, [257, 239, 274, 241, 258]);
        let ud = set("UD-IQ1_M").unwrap();
        assert_eq!(
            ud.shard_names()[3],
            "DeepSeek-V4.1-Flash-1017-UD-IQ1_M-00004-of-00005.gguf"
        );
        assert_eq!(
            ud.engram_shard_name().as_deref(),
            Some("DeepSeek-V4.1-Flash-1017-UD-IQ1_M-00005-of-00005.gguf")
        );
        assert_eq!(ud.min_release, [0, 2, 9]);
        assert!(ud.six_names().is_empty());
        assert_eq!(
            set("IST-DAS-2.00bpw").unwrap().six_names()[4],
            "DeepSeek-V4.1-Flash-1017-GSQ-RCO-IQ2_XXS-00005-of-00006.gguf"
        );
        assert_eq!(
            set("IST-DAS-2.25bpw").unwrap().shard_names()[3],
            "DeepSeek-V4.1-Flash-1017-GSQ-RCO-IQ2_XS-00004-of-00004.gguf"
        );
        assert!(set("UD-Q8_K_XL").is_none());
    }

    #[test]
    fn plan_counts_shared_files_once_and_resumes_partial_downloads() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Strata");
        let data = temp.path().join("Strata-data");
        let shared = data.join("models").join(SHARED_DIR);
        fs::create_dir_all(&shared).unwrap();
        fs::create_dir_all(&root).unwrap();
        // The metadata shard is complete (marked), the drafter half-downloaded.
        let (meta, meta_size) = SHARED_FILES[1];
        fs::write(shared.join(meta), vec![0; meta_size as usize]).unwrap();
        fs::write(shared.join(format!("{meta}.done")), "sha256 x").unwrap();
        let (dspark, _) = SHARED_FILES[2];
        fs::write(shared.join(format!("{dspark}.part")), vec![0; 1000]).unwrap();
        let plan = plan(&root, data.clone(), "IST-DAS-2.00bpw").unwrap();
        let set = set("IST-DAS-2.00bpw").unwrap();
        let expected = set.bytes() + SHARED_FILES[0].1 + SHARED_FILES[2].1 - 1000;
        assert_eq!(plan.report.model_download_bytes_estimate, Some(expected));
        assert_eq!(plan.report.reusable_model_bytes, meta_size + 1000);
        assert!(plan
            .report
            .model_directory
            .ends_with("deepseek-v4.1-flash-IST-DAS-2.00bpw"));
        let model_volume = &plan.report.volumes[0];
        assert_eq!(
            model_volume.required_additional_bytes_estimate,
            set.bytes() + HEADROOM_BYTES
        );
        assert!(plan.gguf_directory.is_none());
    }

    // NTFS allocates every byte of a `set_len` file, so the multi-GB fake set fills the CI disk there.
    #[cfg(not(windows))]
    #[test]
    fn a_complete_set_needs_no_download_and_no_headroom() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Strata");
        let data = temp.path().join("Strata-data");
        let set = set("IST-DAS-1.75bpw").unwrap();
        let folder = data.join("models").join(set.tag());
        fs::create_dir_all(&folder).unwrap();
        fs::create_dir_all(&root).unwrap();
        // Sparse files: the real sizes without the real bytes.
        let sparse = |path: PathBuf, size: u64| {
            fs::File::create(path).unwrap().set_len(size).unwrap();
        };
        for (name, size) in set.shard_names().into_iter().zip(set.shards) {
            sparse(folder.join(&name), size);
            fs::write(folder.join(format!("{name}.done")), "").unwrap();
        }
        // The shared files beside the shards at their pinned sizes count as the person's.
        for (name, size) in SHARED_FILES {
            sparse(folder.join(name), size);
        }
        let pack = data.join("packs").join(set.tag().to_lowercase());
        fs::create_dir_all(pack.join("tokenizer")).unwrap();
        fs::write(pack.join("tokenizer/vocab.json"), "{}").unwrap();
        fs::write(pack.join("tensors.txt"), "").unwrap();
        let plan = plan(&root, data, set.model).unwrap();
        assert_eq!(plan.report.model_download_bytes_estimate, Some(0));
        assert_eq!(
            plan.report.volumes.len(),
            1,
            "only the runtime margin remains"
        );
    }

    // Only the tests that skip NTFS (see above) create sparse files.
    #[cfg(not(windows))]
    fn sparse(path: &Path, size: u64) {
        fs::File::create(path).unwrap().set_len(size).unwrap();
    }

    #[test]
    fn layouts_follow_dsv41_layout_of() {
        let set = set("IST-DAS-2.25bpw").unwrap();
        let four = set.shard_names();
        let six = set.six_names();
        fn has(names: Vec<&String>) -> impl Fn(&str) -> bool + '_ {
            move |n: &str| names.iter().any(|m| m.as_str() == n)
        }
        assert_eq!(layout_of(set, has(six.iter().collect())), Layout::Six);
        assert_eq!(layout_of(set, has(four.iter().collect())), Layout::Four);
        // Both whole: the pinned four-shard set, as before.
        assert_eq!(
            layout_of(set, has(four.iter().chain(&six).collect())),
            Layout::Four
        );
        // Four incomplete, six whole: six.
        assert_eq!(
            layout_of(set, has(four[..2].iter().chain(&six).collect())),
            Layout::Six
        );
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(pack_layout(dir.path()), None);
        fs::write(
            dir.path().join("tensors.txt"),
            format!("file 0 {}\nfile 1 x\n", six[0]),
        )
        .unwrap();
        assert_eq!(pack_layout(dir.path()), Some(Layout::Six));
    }

    #[test]
    fn an_unsloth_set_needs_no_metadata_shard_and_takes_its_shard_5_for_the_engram() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Strata");
        let data = temp.path().join("Strata-data");
        fs::create_dir_all(&root).unwrap();
        let set = set("UD-IQ1_S").unwrap();
        let empty = plan(&root, data.clone(), set.model).unwrap();
        let expected = set.bytes() + SHARED_FILES[0].1 + SHARED_FILES[2].1;
        assert_eq!(empty.report.model_download_bytes_estimate, Some(expected));
        #[cfg(not(windows))]
        {
            let folder = data.join("models").join(set.tag());
            fs::create_dir_all(&folder).unwrap();
            sparse(
                &folder.join(set.engram_shard_name().unwrap()),
                set.engram_shard.unwrap(),
            );
            let with_engram = plan(&root, data, set.model).unwrap();
            assert_eq!(
                with_engram.report.model_download_bytes_estimate,
                Some(set.bytes() + SHARED_FILES[2].1)
            );
        }
    }

    // NTFS allocates every byte of a `set_len` file.
    #[cfg(not(windows))]
    #[test]
    fn files_already_here_are_used_in_place_in_either_layout() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Strata");
        let data = temp.path().join("Strata-data");
        fs::create_dir_all(&root).unwrap();
        let set = set("IST-DAS-2.00bpw").unwrap();

        // Four shards with ISTA's re-published shard 1, the Engram one folder up.
        let repo = temp.path().join("hf");
        let four = repo.join("IQ2_XXS");
        fs::create_dir_all(&four).unwrap();
        for (i, (name, sizes)) in set.layout_files(Layout::Four).into_iter().enumerate() {
            sparse(&four.join(name), if i == 0 { sizes[1] } else { sizes[0] });
        }
        sparse(&repo.join(SHARED_FILES[0].0), SHARED_FILES[0].1);
        let plan = local_plan(&root, data.clone(), set.model, &four).unwrap();
        assert_eq!(plan.gguf_directory.as_deref(), Some(four.as_path()));
        assert_eq!(
            plan.report.model_download_bytes_estimate,
            Some(SHARED_FILES[1].1 + SHARED_FILES[2].1)
        );
        assert!(plan.report.model_directory.ends_with("IQ2_XXS"));

        // The six-shard re-split, handed over as the repository folder.
        let six = temp.path().join("six");
        fs::create_dir_all(&six).unwrap();
        for (name, sizes) in set.layout_files(Layout::Six) {
            sparse(&six.join(name), sizes[0]);
        }
        let plan = local_plan(&root, data.clone(), set.model, &six).unwrap();
        // setup.py also looks one level into the parent's folders, so the Engram under hf/ is found.
        assert_eq!(
            plan.report.model_download_bytes_estimate,
            Some(SHARED_FILES[1].1 + SHARED_FILES[2].1)
        );
        // A pack made from the four-shard files is built again for the six.
        let pack = data.join("packs").join(set.tag().to_lowercase());
        fs::create_dir_all(pack.join("tokenizer")).unwrap();
        fs::write(pack.join("tokenizer/vocab.json"), "{}").unwrap();
        fs::write(
            pack.join("tensors.txt"),
            format!("file 0 {}\n", set.shard_names()[0]),
        )
        .unwrap();
        let plan = local_plan(&root, data.clone(), set.model, &six).unwrap();
        assert!(plan
            .report
            .volumes
            .iter()
            .any(|v| v.directory.ends_with("deepseek-v4.1-flash-ist-das-2.00bpw")));

        // A shard of another size is refused, not downloaded over.
        let name = &set.six_names()[2];
        sparse(&six.join(name), 1000);
        let Err(error) = local_plan(&root, data, set.model, &six) else {
            panic!("a wrong-size shard was accepted");
        };
        assert!(error.contains(name.as_str()), "{error}");
    }
}
