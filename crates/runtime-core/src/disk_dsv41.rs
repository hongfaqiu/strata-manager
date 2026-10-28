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

pub(crate) struct Dsv41Set {
    /// `--model` for setup.py.
    pub model: &'static str,
    /// The GGUF quant in the shard names.
    pub quant: &'static str,
    pub shards: [u64; 4],
    /// dsv41_fit ISTA_SETS ram_ok_gb (GB of RAM it was measured to run well with).
    pub ram_ok_gb: f64,
    /// dsv41_fit ISTA_SETS experts_gb.
    pub experts_gb: f64,
}

impl Dsv41Set {
    pub(crate) fn bytes(&self) -> u64 {
        self.shards.iter().sum()
    }
    pub(crate) fn tag(&self) -> String {
        format!("{TAG_PREFIX}{}", self.model)
    }
    pub(crate) fn shard_names(&self) -> Vec<String> {
        (1..=4)
            .map(|i| {
                format!(
                    "DeepSeek-V4.1-Flash-1017-GSQ-RCO-{}-{i:05}-of-00004.gguf",
                    self.quant
                )
            })
            .collect()
    }
}

/// The official sets, the recommended one first (dsv41_fit.recommend: 2.00, else 1.75; 2.25 only by choice).
pub(crate) const DSV41_SETS: [Dsv41Set; 3] = [
    Dsv41Set {
        model: "IST-DAS-2.00bpw",
        quant: "IQ2_XXS",
        shards: [
            39_075_714_624,
            39_388_449_504,
            39_246_891_616,
            20_527_837_312,
        ],
        ram_ok_gb: 40.0,
        experts_gb: 132.07,
    },
    Dsv41Set {
        model: "IST-DAS-1.75bpw",
        quant: "IQ1_M",
        shards: [
            39_358_830_464,
            39_176_113_248,
            39_997_334_720,
            2_188_841_824,
        ],
        ram_ok_gb: 34.0,
        experts_gb: 114.56,
    },
    Dsv41Set {
        model: "IST-DAS-2.25bpw",
        quant: "IQ2_XS",
        shards: [
            39_535_776_992,
            39_494_617_536,
            39_423_838_496,
            36_771_591_232,
        ],
        ram_ok_gb: 44.0,
        experts_gb: 149.06,
    },
];

/// The files every set shares (setup.py md["shared"]): the Engram n-gram table, Unsloth's metadata shard, the DSpark drafter.
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
    let mut shared_bytes = 0_u64;
    for (name, size) in SHARED_FILES {
        // setup.py dsv41_find_shared: a file of the pinned size beside the shards is the person's and is used as is.
        let beside = file_len(&model_directory.join(name))? == size;
        let (left, have) = if beside {
            (0, size)
        } else {
            missing(&shared_directory, name, size, false)?
        };
        shared_bytes += left;
        reusable += have;
    }
    let pack = data.join("packs").join(tag.to_lowercase());
    let pack_ready =
        exists(&pack.join("tokenizer").join("vocab.json"))? && exists(&pack.join("tensors.txt"))?;
    let download = shard_bytes + shared_bytes;
    let headroom = if download > 0 { HEADROOM_BYTES } else { 0 };
    let requirements = vec![
        (model_directory.clone(), shard_bytes + headroom),
        (shared_directory, shared_bytes),
        (pack, if pack_ready { 0 } else { PACK_BYTES }),
        // The dsv41 engine package (~0.4 GB archive, ~0.6 GB unpacked) and the Python wheels.
        (root.to_owned(), 2 * GB),
    ];
    let additional = requirements.iter().map(|(_, bytes)| *bytes).sum();
    Ok(Plan {
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
        gguf_directory: None,
    })
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
        // dsv41_fit ISTA_SETS set_bytes
        assert_eq!(bytes, [138_238_893_056, 120_721_120_256, 155_225_824_256]);
        let shared: u64 = SHARED_FILES.iter().map(|(_, size)| size).sum();
        // dsv41_fit disk_total: 257 / 239 / 274 GB
        let totals: Vec<_> = bytes
            .iter()
            .map(|b| ((b + shared) as f64 / GB as f64).round() as u64)
            .collect();
        assert_eq!(totals, [257, 239, 274]);
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
}
