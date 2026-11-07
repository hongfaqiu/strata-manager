//! Qwen3.8-Flash-Next (NVFP4) (setup.py FAMILIES "nvfp4", `ready: True`): ready-made Strata packs that setup downloads as a
//! file list (NVFP4_REPOS), not GGUF shards, plus NVIDIA's FP4-Local (QAD) checkpoint that setup turns into a pack on this PC
//! (tools/nvfp4_local_pack.py prepare). Sizes are setup.py's pinned NVFP4_REPOS bytes (Strata v0.2.11 c3b3f503 and main
//! 2026-11-07 agree: the same revisions and files). NVIDIA only: the HIP and SYCL engines have no NVFP4 kernels.
//!
//! Where setup puts them (ready_where): `<data>/models/<owner>--<repo>/<path in the repository>`; a prepared checkpoint
//! keeps what it made in `<that folder>/prepared/` (FP4LOCAL_PREPARED) and the ~102 GB of safetensors can go afterwards.

use std::path::{Path, PathBuf};

use super::{exists, file_len, first_existing, Plan, GB, SOURCE};
use crate::types::{SetupDiskPreflight, SetupDiskVolume};

pub(crate) const FAMILY: &str = "nvfp4";
/// setup.py fam["tag"]: the config is `strata-nvfp4-<model lower>.json`.
pub(crate) const TAG_PREFIX: &str = "nvfp4-";
/// setup.py fam["name"]: model_name is `qwen3.8-flash-next-nvfp4-<model lower>`.
pub(crate) const MODEL_NAME: &str = "qwen3.8-flash-next-nvfp4";
/// setup.py FP4LOCAL_PREPARED.
pub(crate) const PREPARED_DIR: &str = "prepared";
/// setup.py prepared_done: every step of nvfp4_local_pack.py prepare writes its mark when it is whole.
pub(crate) const PREPARED_MARKS: [&str; 4] = [
    "ple-nvfp4.gguf.done",
    "dense.gguf.done",
    "pack.done",
    "draft.done",
];
/// fam["mmproj"] / fam["mmproj_sha256"]: ISTA-DASLab's image encoder, the same file as every Flash-Next model's.
pub(crate) const MMPROJ: (&str, u64) = ("mmproj-Qwen3.8-Flash-Next-BF16.gguf", 907_543_008);
/// The MTP draft layer setup builds for a ready-made pack (as for every other Flash-Next model): ~5 GB of tensors + rt.
const MTP_BYTES: u64 = 8 * GB;
/// PyTorch, transformers and safetensors (requirements-nvfp4-local.txt) for the QAD conversion. Not in setup.py: an
/// estimate of the CUDA wheels in the runtime's venv.
const PREPARE_PACKAGES_BYTES: u64 = 4 * GB;

/// NVFP4_REPOS role: pack = the experts pack folder, dense = the dense GGUF (`--native`), ple = the FP8 n-gram table,
/// embd = the BF16 token embedding, src = a file of NVIDIA's checkpoint (prepared here).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Role {
    Pack,
    Dense,
    Ple,
    Embd,
    Src,
}

#[derive(Debug)]
pub(crate) struct ReadyFile {
    pub path: &'static str,
    pub role: Role,
    pub bytes: u64,
}

const fn f(path: &'static str, role: Role, bytes: u64) -> ReadyFile {
    ReadyFile { path, role, bytes }
}

const GPTQ_FILES: &[ReadyFile] = &[
    f("pack/dense.bin", Role::Pack, 1_538_035_200),
    f("pack/experts.bin", Role::Pack, 67_948_118_016),
    f("pack/index.txt", Role::Pack, 93_663),
    f("pack/native_experts.txt", Role::Pack, 1_599),
    f("pack/tokenizer/chat_template.jinja", Role::Pack, 8_952),
    f("pack/tokenizer/merges.txt", Role::Pack, 3_600_844),
    f("pack/tokenizer/token_type.json", Role::Pack, 744_960),
    f("pack/tokenizer/tokenizer.json", Role::Pack, 554),
    f("pack/tokenizer/vocab.json", Role::Pack, 5_737_005),
    f("qwen-nvfp4-gptq-dense.gguf", Role::Dense, 5_991_569_472),
    f("ple-fp8.gguf", Role::Ple, 51_200_246_176),
    f("token-embd-bf16.gguf", Role::Embd, 1_271_398_656),
];
const NVIDIA_FILES: &[ReadyFile] = &[
    f("pack/dense.bin", Role::Pack, 1_538_625_024),
    f("pack/experts.bin", Role::Pack, 67_948_118_016),
    f("pack/index.txt", Role::Pack, 117_490),
    f("pack/native_experts.txt", Role::Pack, 1_590),
    f("pack/tokenizer/chat_template.jinja", Role::Pack, 8_952),
    f("pack/tokenizer/merges.txt", Role::Pack, 3_600_844),
    f("pack/tokenizer/token_type.json", Role::Pack, 744_960),
    f("pack/tokenizer/tokenizer.json", Role::Pack, 554),
    f("pack/tokenizer/vocab.json", Role::Pack, 5_737_005),
    f("qwen-nvidia-nvfp4-dense.gguf", Role::Dense, 5_992_176_896),
    f("ple-fp8.gguf", Role::Ple, 51_200_246_176),
    f("token-embd-bf16.gguf", Role::Embd, 1_271_398_656),
];
const QAD_FILES: &[ReadyFile] = &[
    f("config.json", Role::Src, 75_217),
    f("generation_config.json", Role::Src, 202),
    f("chat_template.jinja", Role::Src, 8_952),
    f("merges.txt", Role::Src, 3_353_259),
    f("tokenizer.json", Role::Src, 12_809_320),
    f("tokenizer_config.json", Role::Src, 17_928),
    f("vocab.json", Role::Src, 6_722_759),
    f("model.safetensors.index.json", Role::Src, 47_280_974),
    f(
        "tensors/model-00001-of-00021.safetensors",
        Role::Src,
        5_000_643_504,
    ),
    f(
        "tensors/model-00002-of-00021.safetensors",
        Role::Src,
        5_002_792_096,
    ),
    f(
        "tensors/model-00003-of-00021.safetensors",
        Role::Src,
        5_002_927_400,
    ),
    f(
        "tensors/model-00004-of-00021.safetensors",
        Role::Src,
        5_003_194_672,
    ),
    f(
        "tensors/model-00005-of-00021.safetensors",
        Role::Src,
        5_003_151_448,
    ),
    f(
        "tensors/model-00006-of-00021.safetensors",
        Role::Src,
        5_002_892_148,
    ),
    f(
        "tensors/model-00007-of-00021.safetensors",
        Role::Src,
        5_002_907_708,
    ),
    f(
        "tensors/model-00008-of-00021.safetensors",
        Role::Src,
        5_003_103_756,
    ),
    f(
        "tensors/model-00009-of-00021.safetensors",
        Role::Src,
        5_002_976_316,
    ),
    f(
        "tensors/model-00010-of-00021.safetensors",
        Role::Src,
        5_002_834_136,
    ),
    f(
        "tensors/model-00011-of-00021.safetensors",
        Role::Src,
        5_002_685_828,
    ),
    f(
        "tensors/model-00012-of-00021.safetensors",
        Role::Src,
        5_002_912_920,
    ),
    f(
        "tensors/model-00013-of-00021.safetensors",
        Role::Src,
        5_003_237_060,
    ),
    f(
        "tensors/model-00014-of-00021.safetensors",
        Role::Src,
        4_845_006_312,
    ),
    f(
        "tensors/model-00015-of-00021.safetensors",
        Role::Src,
        4_860_574_920,
    ),
    f(
        "tensors/model-00016-of-00021.safetensors",
        Role::Src,
        4_950_031_028,
    ),
    f(
        "tensors/model-00017-of-00021.safetensors",
        Role::Src,
        4_950_030_896,
    ),
    f(
        "tensors/model-00018-of-00021.safetensors",
        Role::Src,
        4_950_030_896,
    ),
    f(
        "tensors/model-00019-of-00021.safetensors",
        Role::Src,
        4_950_030_904,
    ),
    f(
        "tensors/model-00020-of-00021.safetensors",
        Role::Src,
        4_950_030_904,
    ),
    f(
        "tensors/model-00021-of-00021.safetensors",
        Role::Src,
        2_700_016_864,
    ),
];

pub(crate) struct Nvfp4Set {
    /// `--model` for setup.py.
    pub model: &'static str,
    pub repo: &'static str,
    pub files: &'static [ReadyFile],
    /// MODELS[*].download_gb, ram_gb, arena_gb (decimal GB; ram_gb is compared with GiB as setup's ram_gb() reads it).
    pub download_gb: f64,
    pub ram_gb: f64,
    pub arena_gb: f64,
    /// MODELS["NVFP4-QAD"].prepare_gb: what the conversion writes on this PC.
    pub prepare_gb: Option<f64>,
    /// MODELS[*].engine: NVFP4_ENGINE (0,1,44) / FP4LOCAL_ENGINE (0,1,45).
    pub min_engine: [u32; 3],
}

pub(crate) const SETS: [Nvfp4Set; 3] = [
    Nvfp4Set {
        model: "NVFP4",
        repo: "Maximilian228/Qwen3.8-Flash-Next-NVFP4-GPTQ-Strata",
        // setup.py NVFP4_REPOS revision 640a1db97446ddd5e89d2b70ecd0297987192c93 (the sizes below are from that commit)
        files: GPTQ_FILES,
        download_gb: 128.0,
        ram_gb: 80.0,
        arena_gb: 68.0,
        prepare_gb: None,
        min_engine: [0, 1, 44],
    },
    Nvfp4Set {
        model: "NVFP4-NVIDIA",
        repo: "Maximilian228/Qwen3.8-Flash-Next-NVIDIA-NVFP4-Strata",
        // setup.py NVFP4_REPOS revision cca8f7fee5ce0af932097340a75e06df25c4e57d (the sizes below are from that commit)
        files: NVIDIA_FILES,
        download_gb: 128.0,
        ram_gb: 80.0,
        arena_gb: 68.0,
        prepare_gb: None,
        min_engine: [0, 1, 44],
    },
    Nvfp4Set {
        model: "NVFP4-QAD",
        repo: "nvidia/Qwen3.8-Flash-Next-FP4-Local",
        // setup.py NVFP4_REPOS revision b9ce18a6887e18c089fdea8509a33e63429a3300 (the sizes below are from that commit)
        files: QAD_FILES,
        download_gb: 102.2,
        ram_gb: 80.0,
        arena_gb: 68.0,
        prepare_gb: Some(110.0),
        min_engine: [0, 1, 45],
    },
];

impl Nvfp4Set {
    pub(crate) fn tag(&self) -> String {
        format!("{TAG_PREFIX}{}", self.model)
    }
    /// setup.py ready_where: `<owner>--<repo>`.
    pub(crate) fn folder(&self) -> String {
        self.repo.replace('/', "--")
    }
    pub(crate) fn bytes(&self) -> u64 {
        self.files.iter().map(|file| file.bytes).sum()
    }
    pub(crate) fn prepared(&self) -> bool {
        self.prepare_gb.is_some()
    }
    /// The ready-made pack's dense GGUF (`--native`), or None for the checkpoint that is prepared here.
    pub(crate) fn dense(&self) -> Option<&'static ReadyFile> {
        self.files.iter().find(|file| file.role == Role::Dense)
    }
    /// setup.py ready_needed: without the checkpoint's tensors once it is prepared.
    fn needed(&self, prepared_done: bool) -> impl Iterator<Item = &'static ReadyFile> {
        let skip = self.prepared() && prepared_done;
        self.files
            .iter()
            .filter(move |file| !(skip && file.path.starts_with("tensors/")))
    }
}

pub(crate) fn set(model: &str) -> Option<&'static Nvfp4Set> {
    SETS.iter().find(|set| set.model == model)
}

/// setup.py prepared_done for the checkpoint folder `<models>/nvidia--Qwen3.8-Flash-Next-FP4-Local`.
pub(crate) fn prepared_done(folder: &Path) -> bool {
    PREPARED_MARKS
        .iter()
        .all(|mark| folder.join(PREPARED_DIR).join(mark).is_file())
}

/// A file setup will not fetch again: its finish mark is there, or it is the pinned size with no `.part` (setup hashes
/// it in place and marks it, download()). Returns the bytes already here and the bytes still to fetch.
fn have(path: &Path, size: u64) -> Result<(u64, u64), String> {
    let len = file_len(path)?;
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let part = path.with_file_name(format!("{name}.part"));
    if std::fs::symlink_metadata(&part).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("断点下载文件指向另一个目录；请核验该文件位置后重试".into());
    }
    if len == size && (exists(&path.with_file_name(format!("{name}.done")))? || !part.exists()) {
        return Ok((size, 0));
    }
    let partial = file_len(&part)?.min(size);
    Ok((partial, size - partial))
}

/// setup.py ready_fetch: the FP8 n-gram table and the token embedding are the same file in both ready-made repositories;
/// one already here for the other pack is linked, not downloaded.
fn linked_elsewhere(models: &Path, set: &Nvfp4Set, file: &ReadyFile) -> Result<bool, String> {
    if !matches!(file.role, Role::Ple | Role::Embd) {
        return Ok(false);
    }
    for other in SETS.iter().filter(|other| other.model != set.model) {
        let same = other
            .files
            .iter()
            .any(|o| o.path == file.path && o.bytes == file.bytes);
        if same && have(&models.join(other.folder()).join(file.path), file.bytes)?.1 == 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The data folder whose `models/<owner>--<repo>` already holds every file a set needs (setup.py's `elsewhere`).
fn complete_in(roots: &[PathBuf], set: &Nvfp4Set) -> Result<Option<PathBuf>, String> {
    for root in roots {
        let folder = root.join("models").join(set.folder());
        if !folder.is_dir() {
            continue;
        }
        let done = prepared_done(&folder);
        let mut whole = true;
        for file in set.needed(done) {
            if have(&folder.join(file.path), file.bytes)?.1 > 0 {
                whole = false;
                break;
            }
        }
        if whole {
            return Ok(Some(root.clone()));
        }
    }
    Ok(None)
}

/// setup.py's install of a ready-made NVFP4 pack (or the QAD checkpoint): the files still to fetch into
/// `models/<owner>--<repo>`, the conversion's 110 GB for QAD until it is done, the MTP draft layer for the ready-made packs
/// (a prepared checkpoint makes its own), the image encoder, and room for the runtime.
pub(crate) fn plan(
    root: &Path,
    roots: &[PathBuf],
    data: PathBuf,
    model: &str,
    images: bool,
) -> Result<Plan, String> {
    let set = set(model).ok_or("模型/量化组合不被已核对的官方安装器支持")?;
    let data = complete_in(roots, set)?.unwrap_or(data);
    let models = data.join("models");
    let folder = models.join(set.folder());
    let done = set.prepared() && prepared_done(&folder);
    let (mut download, mut reusable) = (0_u64, 0_u64);
    for file in set.needed(done) {
        let (here, left) = have(&folder.join(file.path), file.bytes)?;
        if left > 0 && linked_elsewhere(&models, set, file)? {
            reusable += file.bytes;
            continue;
        }
        reusable += here;
        download += left;
    }
    let prepare = match set.prepare_gb {
        Some(gb) if !done => (gb * GB as f64).round() as u64,
        _ => 0,
    };
    let mtp = if set.prepared() {
        0
    } else if first_existing(roots, Path::new("mtp/rt/experts.bin"))?.is_some() {
        0
    } else {
        MTP_BYTES
    };
    let vision = if images && first_existing(roots, &Path::new("models").join(MMPROJ.0))?.is_none()
    {
        MMPROJ.1
    } else {
        0
    };
    let runtime = 2 * GB
        + if prepare > 0 {
            PREPARE_PACKAGES_BYTES
        } else {
            0
        };
    let requirements = vec![
        (folder.clone(), download),
        (folder.join(PREPARED_DIR), prepare),
        (data.join("mtp"), mtp),
        (models.clone(), vision),
        (root.to_owned(), runtime),
    ];
    let additional = requirements.iter().map(|(_, bytes)| *bytes).sum();
    Ok(Plan {
        report: SetupDiskPreflight {
            status: "unknown".into(),
            data_directory: data.to_string_lossy().into(),
            model_directory: folder.to_string_lossy().into(),
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
        // --gguf-dir does not apply to ready-made packs (setup warns and drops it): setup finds them by --data-dir.
        gguf_directory: None,
        renamed: None,
    })
}

/// 「使用已有模型」 for an NVFP4 pack: setup reads it only from `<data>/models/<owner>--<repo>/`, so the chosen folder (that
/// repository folder, or its `pack/` / `prepared/` folder) gives the data folder setup is run with.
pub(crate) fn local_data_directory(set: &Nvfp4Set, directory: &Path) -> Result<PathBuf, String> {
    let folder = repository_folder(directory).filter(|folder| {
        folder
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(&set.folder()))
    });
    let data = folder.as_deref().and_then(|folder| {
        let models = folder.parent()?;
        models
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("models"))
            .then(|| models.parent().map(Path::to_owned))
            .flatten()
    });
    data.ok_or_else(|| {
        format!(
            "官方安装器只在 <数据目录>/models/{0}/ 里找 {1} 的文件（现成包不走 --gguf-dir）；请把整个文件夹放到某个数据目录的 models 下再选它 / Setup reads {1} only from <data folder>/models/{0}/ (ready-made packs do not use --gguf-dir); put the whole folder under a data folder's models/ and choose it",
            set.folder(),
            set.model
        )
    })
}

/// The repository folder a chosen folder belongs to: itself, or the parent of its `pack/` or `prepared/` folder.
pub(crate) fn repository_folder(directory: &Path) -> Option<PathBuf> {
    let name = directory
        .file_name()?
        .to_string_lossy()
        .to_ascii_lowercase();
    if name == "pack" || name == PREPARED_DIR {
        return directory.parent().map(Path::to_owned);
    }
    Some(directory.to_owned())
}

/// Which set a folder holds, from its files (the dense GGUF's name, or the checkpoint's index / prepared marks).
pub(crate) fn set_in(folder: &Path) -> Option<&'static Nvfp4Set> {
    let by_name = SETS.iter().find(|set| {
        folder
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(&set.folder()))
    });
    by_name.or_else(|| {
        SETS.iter().find(|set| match set.dense() {
            Some(dense) => folder.join(dense.path).is_file(),
            None => {
                folder.join("model.safetensors.index.json").is_file()
                    && folder.join("tensors").is_dir()
                    || prepared_done(folder)
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Sparse files: the real sizes without the real bytes.
    fn sparse(path: &Path, size: u64) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::File::create(path).unwrap().set_len(size).unwrap();
    }

    #[test]
    fn the_sets_match_setup_py_nvfp4_repos() {
        let rows: Vec<_> = SETS
            .iter()
            .map(|set| (set.model, set.folder(), set.files.len(), set.bytes()))
            .collect();
        assert_eq!(
            rows,
            [
                (
                    "NVFP4",
                    "Maximilian228--Qwen3.8-Flash-Next-NVFP4-GPTQ-Strata".to_owned(),
                    12,
                    127_959_555_097
                ),
                (
                    "NVFP4-NVIDIA",
                    "Maximilian228--Qwen3.8-Flash-Next-NVIDIA-NVFP4-Strata".to_owned(),
                    12,
                    127_960_776_163
                ),
                (
                    "NVFP4-QAD",
                    "nvidia--Qwen3.8-Flash-Next-FP4-Local".to_owned(),
                    29,
                    102_262_280_327
                ),
            ]
        );
        assert_eq!(set("NVFP4-QAD").unwrap().tag(), "nvfp4-NVFP4-QAD");
        assert_eq!(set("NVFP4-QAD").unwrap().min_engine, [0, 1, 45]);
        assert_eq!(set("NVFP4").unwrap().min_engine, [0, 1, 44]);
        assert!(set("NVFP4").unwrap().dense().is_some());
        assert!(set("NVFP4-QAD").unwrap().dense().is_none());
        assert!(set("IQ3_S").is_none());
    }

    #[test]
    fn qad_reserves_the_conversion_and_ready_packs_the_mtp_layer() {
        let temp = tempfile::tempdir().unwrap();
        let (root, data) = (temp.path().join("Strata"), temp.path().join("data"));
        fs::create_dir_all(&root).unwrap();
        let qad = plan(&root, &[data.clone()], data.clone(), "NVFP4-QAD", true).unwrap();
        let set = set("NVFP4-QAD").unwrap();
        assert_eq!(qad.report.model_download_bytes_estimate, Some(set.bytes()));
        let prepare = 110 * GB;
        assert_eq!(
            qad.report.additional_bytes_estimate,
            Some(set.bytes() + prepare + MMPROJ.1 + 2 * GB + PREPARE_PACKAGES_BYTES)
        );
        assert!(qad
            .report
            .volumes
            .iter()
            .any(|v| v.directory.ends_with("prepared")
                && v.required_additional_bytes_estimate == prepare));
        assert!(qad.gguf_directory.is_none());
        let gptq = plan(&root, &[data.clone()], data.clone(), "NVFP4", false).unwrap();
        let bytes = super::set("NVFP4").unwrap().bytes();
        assert_eq!(
            gptq.report.additional_bytes_estimate,
            Some(bytes + MTP_BYTES + 2 * GB)
        );
        assert!(gptq
            .report
            .model_directory
            .ends_with("Maximilian228--Qwen3.8-Flash-Next-NVFP4-GPTQ-Strata"));
    }

    #[cfg(not(windows))]
    #[test]
    fn the_shared_table_is_linked_and_a_prepared_checkpoint_needs_no_tensors() {
        let temp = tempfile::tempdir().unwrap();
        let (root, data) = (temp.path().join("Strata"), temp.path().join("data"));
        fs::create_dir_all(&root).unwrap();
        let models = data.join("models");
        // The GPTQ pack's n-gram table is here: the NVIDIA pack links it instead of downloading 51 GB again.
        let ple = set("NVFP4")
            .unwrap()
            .files
            .iter()
            .find(|f| f.role == Role::Ple)
            .unwrap();
        let gptq = models.join(set("NVFP4").unwrap().folder());
        sparse(&gptq.join(ple.path), ple.bytes);
        let nvidia = plan(&root, &[data.clone()], data.clone(), "NVFP4-NVIDIA", false).unwrap();
        assert_eq!(
            nvidia.report.model_download_bytes_estimate,
            Some(set("NVFP4-NVIDIA").unwrap().bytes() - ple.bytes)
        );
        assert_eq!(nvidia.report.reusable_model_bytes, ple.bytes);

        // A prepared checkpoint: every mark written, the source tensors deleted.
        let qad = set("NVFP4-QAD").unwrap();
        let folder = models.join(qad.folder());
        for file in qad.needed(true) {
            sparse(&folder.join(file.path), file.bytes);
        }
        for mark in PREPARED_MARKS {
            sparse(&folder.join(PREPARED_DIR).join(mark), 0);
        }
        let done = plan(&root, &[data.clone()], data.clone(), "NVFP4-QAD", false).unwrap();
        assert_eq!(done.report.model_download_bytes_estimate, Some(0));
        assert_eq!(done.report.additional_bytes_estimate, Some(2 * GB));
        assert_eq!(set_in(&folder).map(|s| s.model), Some("NVFP4-QAD"));
    }

    #[test]
    fn a_local_pack_must_sit_under_a_data_folders_models() {
        let set = set("NVFP4").unwrap();
        let data = Path::new("/d/Strata-data");
        let folder = data.join("models").join(set.folder());
        assert_eq!(local_data_directory(set, &folder).unwrap(), data);
        assert_eq!(
            local_data_directory(set, &folder.join("pack")).unwrap(),
            data
        );
        let loose = Path::new("/d/Downloads").join(set.folder());
        assert!(local_data_directory(set, &loose)
            .unwrap_err()
            .contains("models/Maximilian228--Qwen3.8-Flash-Next-NVFP4-GPTQ-Strata"));
        let renamed = data.join("models").join("my-nvfp4");
        assert!(local_data_directory(set, &renamed).is_err());
    }

    #[test]
    fn nvfp4_is_refused_off_nvidia_before_any_download() {
        assert!(crate::nvfp4_refusal("windows", "auto", true).is_none());
        assert!(crate::nvfp4_refusal("linux", "cuda", true).is_none());
        assert!(crate::nvfp4_refusal("macos", "auto", false)
            .unwrap()
            .contains("Mac"));
        assert!(crate::nvfp4_refusal("windows", "hip", true)
            .unwrap()
            .contains("AMD"));
        assert!(crate::nvfp4_refusal("linux", "auto", false)
            .unwrap()
            .contains("UD-IQ4_XS"));
    }
}
