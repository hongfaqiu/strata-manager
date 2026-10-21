//! Community (third-party) Qwen3.8-Flash-Next GGUFs from the 「选择模型」 list: one tracked setup task that
//! downloads the pinned files (Hugging Face repo + 40-hex revision, setup.py's resumable download and mirrors),
//! checks every file's size and SHA-256, then runs the official installer on them with `--gguf-dir` like
//! 「使用已有模型」. The install is kept apart from the official one of the same size:
//! - its own data folder (`<data>/community/<slug>-<quant>`) with an empty pack folder made first, so setup builds
//!   a pack from these files instead of reusing the official pack (`find_in(roots, "packs/<tag>")` takes the data
//!   folder first); the MTP draft layer and the projector are still reused from the other data folders;
//! - the config setup writes (`strata-<tag>.json`) is renamed to `strata-community-<slug>-<quant>.json` with
//!   `model_name` `community-<slug>-<quant>`, and the official config of that size is put back as it was;
//! - the remembered data folder in Strata's settings.json is restored (a `--data-dir` can become the default on
//!   a PC that had no model files yet).
//!
//! Images use the official projector setup verifies (setup accepts only ISTA's SHA-256 for it).
use crate::{disk, local_model, processes::Step};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
};

pub const FAMILY_PREFIX: &str = "community:";
const MAX_FILES: usize = 8;
const MAX_VECTOR_BYTES: u64 = 64 * 1024 * 1024;
/// A community model's shards together: anything under 1 GB cannot be a Flash-Next quantization.
const MIN_TOTAL_BYTES: u64 = disk::GB;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommunityFile {
    /// Path inside the repository (`Q2_0/<name>.gguf`).
    pub path: String,
    pub size: u64,
    pub sha256: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommunitySetupRequest {
    pub slug: String,
    pub repo: String,
    pub revision: String,
    pub family: String,
    pub quant: String,
    pub files: Vec<CommunityFile>,
    /// Accepted for symmetry with the catalog; setup uses the official projector (see the module note).
    #[serde(default)]
    pub mmproj: Option<CommunityFile>,
    /// A refusal-direction control vector (GGUF), passed as `--experimental-speed-projection` (PC engines).
    #[serde(default)]
    pub control_vector: Option<CommunityFile>,
}

/// `community-<slug>-<quant>`: the registered model name (setup_handoff matches configs by it).
pub fn model_name(slug: &str, quant: &str) -> String {
    format!("community-{slug}-{}", quant.to_ascii_lowercase())
}
pub fn config_file(slug: &str, quant: &str) -> String {
    format!("strata-{}.json", model_name(slug, quant))
}
/// setup.py FAMILIES[*]["tag"] + model: the pack folder and config name setup uses.
fn setup_tag(family: &str, quant: &str) -> Option<String> {
    let prefix = match family {
        "qwen" => "",
        "swift" => "swift-",
        "coder" => "coder-",
        "unsloth" => "unsloth-",
        _ => return None,
    };
    Some(format!("{prefix}{quant}").to_ascii_lowercase())
}

fn is_slug(slug: &str) -> bool {
    (1..=64).contains(&slug.len())
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !slug.starts_with('-')
        && !slug.ends_with('-')
}
fn is_repo_part(part: &str) -> bool {
    (1..=96).contains(&part.len())
        && part
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && part.as_bytes()[0].is_ascii_alphanumeric()
        && !part.contains("..")
}
fn is_repo(repo: &str) -> bool {
    let mut parts = repo.split('/');
    matches!((parts.next(), parts.next(), parts.next()), (Some(owner), Some(name), None) if is_repo_part(owner) && is_repo_part(name))
}
fn is_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
/// A plain relative repository path: no `..`, no absolute or drive prefix, no backslash, `.gguf` file.
fn repo_file_name(path: &str) -> Result<String, String> {
    if path.is_empty() || path.len() > 300 || path.contains('\\') || path.contains(':') {
        return Err(format!("社区模型文件路径无效：{path}"));
    }
    let parsed = Path::new(path);
    if !parsed
        .components()
        .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(format!("社区模型文件路径无效：{path}"));
    }
    let name = parsed
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| format!("社区模型文件路径无效：{path}"))?;
    if !name.to_ascii_lowercase().ends_with(".gguf") || name.starts_with('.') {
        return Err(format!("社区模型文件必须是 .gguf：{path}"));
    }
    Ok(name)
}
fn shard_of(name: &str) -> Option<(String, u32, u32)> {
    let stem = name.strip_suffix(".gguf")?;
    let (head, total) = stem.rsplit_once("-of-")?;
    let (stem, index) = head.rsplit_once('-')?;
    if index.len() != 5 || total.len() != 5 {
        return None;
    }
    Some((stem.to_string(), index.parse().ok()?, total.parse().ok()?))
}

/// Everything the task trusts, checked before anything is downloaded.
pub fn validate(request: &CommunitySetupRequest) -> Result<(), String> {
    if !is_slug(&request.slug) {
        return Err("社区模型标识无效".into());
    }
    if !is_repo(&request.repo) {
        return Err("Hugging Face 仓库名无效".into());
    }
    if !is_hex(&request.revision, 40) {
        return Err("社区模型必须固定到 40 位提交（revision）".into());
    }
    if setup_tag(&request.family, &request.quant).is_none()
        || !local_model::setup_supports(&request.family, &request.quant)
    {
        return Err(format!(
            "{} {} 不是官方安装器能准备的组合",
            request.family, request.quant
        ));
    }
    if request.files.is_empty() || request.files.len() > MAX_FILES {
        return Err("社区模型分片数量无效".into());
    }
    let mut stem: Option<String> = None;
    let mut total_bytes = 0_u64;
    for (index, file) in request.files.iter().enumerate() {
        let name = repo_file_name(&file.path)?;
        if !file.sha256.as_deref().is_some_and(|sha| is_hex(sha, 64)) {
            return Err(format!("{name} 缺少 SHA-256，Manager 不下载无法校验的文件"));
        }
        let (file_stem, number, total) = match shard_of(&name) {
            Some(shard) => shard,
            None => (name.trim_end_matches(".gguf").to_string(), 1, 1),
        };
        if number as usize != index + 1 || total as usize != request.files.len() {
            return Err(format!("{name} 不是完整分片组的第 {} 个分片", index + 1));
        }
        if stem.get_or_insert_with(|| file_stem.clone()) != &file_stem {
            return Err("社区模型分片不属于同一组文件".into());
        }
        if local_model::quant_of(&file_stem).as_deref() != Some(request.quant.as_str()) {
            return Err(format!("{name} 的文件名不是 {} 量化", request.quant));
        }
        if local_model::inferred_family(&file_stem, &request.quant) != Some(request.family.as_str())
        {
            return Err(format!("{name} 的文件名对应的不是 {} 家族", request.family));
        }
        total_bytes = total_bytes.saturating_add(file.size);
    }
    if total_bytes < MIN_TOTAL_BYTES {
        return Err("社区模型文件大小异常".into());
    }
    if let Some(vector) = &request.control_vector {
        let name = repo_file_name(&vector.path)?;
        if vector.path.contains('/') || request.family != "qwen" {
            return Err(format!(
                "{name}：去拒答向量只支持仓库根目录、Qwen3.8-Flash-Next 家族"
            ));
        }
        if vector.size == 0 || vector.size > MAX_VECTOR_BYTES {
            return Err(format!("{name} 大小异常"));
        }
        if !vector.sha256.as_deref().is_some_and(|sha| is_hex(sha, 64)) {
            return Err(format!("{name} 缺少 SHA-256"));
        }
    }
    Ok(())
}

pub(crate) struct Prepared {
    pub root: PathBuf,
    pub data_directory: PathBuf,
    pub gguf_directory: PathBuf,
    pub pack_directory: PathBuf,
    pub setup_config: String,
    pub community_config: String,
    pub model_name: String,
    #[cfg_attr(not(test), allow(dead_code))]
    pub download_bytes: u64,
    pub plan: disk::Plan,
}

/// Folders, names and the disk plan; reads only.
pub(crate) fn prepare(
    root: &Path,
    request: &CommunitySetupRequest,
    settings: &disk::Settings,
) -> Result<Prepared, String> {
    validate(request)?;
    let mut data = settings
        .data_dir
        .clone()
        .unwrap_or_else(|| root.parent().unwrap_or(root).join("Strata-data"));
    if !data.is_absolute() {
        data = root.join(data);
    }
    let quant = request.quant.to_ascii_lowercase();
    let community = data
        .join("community")
        .join(format!("{}-{quant}", request.slug));
    let gguf_directory = community.join("models").join(&request.quant);
    let tag = setup_tag(&request.family, &request.quant).ok_or("未知的模型家族")?;
    let pack_directory = community.join("packs").join(&tag);
    let mut download_bytes = 0_u64;
    let mut reusable = 0_u64;
    let mut files: Vec<&CommunityFile> = request.files.iter().collect();
    files.extend(request.control_vector.iter());
    for file in files {
        let name = repo_file_name(&file.path)?;
        let have = disk::file_len(&gguf_directory.join(&name))?;
        if have == file.size {
            reusable += have;
            continue;
        }
        let partial = disk::file_len(&gguf_directory.join(format!("{name}.part")))?;
        reusable += partial.min(file.size);
        download_bytes += file.size.saturating_sub(partial.min(file.size));
    }
    let pack_bytes = if request.family == "qwen" && request.quant == "Q2_0" {
        40 * disk::GB // the AVX-512 conversion may write a 40 GB pack (disk.rs)
    } else {
        2 * disk::GB
    };
    let requirements = [
        (gguf_directory.clone(), download_bytes),
        (pack_directory.clone(), pack_bytes),
        (data.join("mtp"), 8 * disk::GB),
        (root.to_owned(), 2 * disk::GB),
    ];
    let mut plan = disk::Plan {
        report: crate::types::SetupDiskPreflight {
            status: "ready".into(),
            data_directory: community.to_string_lossy().into(),
            model_directory: gguf_directory.to_string_lossy().into(),
            model_download_bytes_estimate: Some(download_bytes),
            reusable_model_bytes: reusable,
            additional_bytes_estimate: Some(requirements.iter().map(|(_, b)| b).sum()),
            estimate: true,
            volumes: requirements
                .iter()
                .filter(|(_, b)| *b > 0)
                .map(|(directory, bytes)| crate::types::SetupDiskVolume {
                    directory: directory.to_string_lossy().into(),
                    mount_point: None,
                    available_bytes: None,
                    required_additional_bytes_estimate: *bytes,
                })
                .collect(),
            reason: String::new(),
            source: format!("Hugging Face {}@{}", request.repo, &request.revision[..7]),
        },
        data_directory: community.clone(),
        gguf_directory: Some(gguf_directory.clone()),
    };
    disk::measure(&mut plan, disk::read_space);
    Ok(Prepared {
        root: root.to_owned(),
        data_directory: community,
        gguf_directory,
        pack_directory,
        setup_config: format!("strata-{tag}.json"),
        community_config: config_file(&request.slug, &request.quant),
        model_name: model_name(&request.slug, &request.quant),
        download_bytes,
        plan,
    })
}

/// Python run with the runtime's interpreter in its folder: setup.py's download (resume, HF_ENDPOINT mirrors,
/// ModelScope fallback to Hugging Face for unknown repos) and SHA-256 check, the config stash/rename and the
/// settings.json restore. No shell is involved.
pub const HELPER: &str = r#"
import json, os, shutil, sys
from pathlib import Path
root, cmd, rest = Path(sys.argv[1]), sys.argv[2], sys.argv[3:]
sys.path.insert(0, str(root))
import setup

def settings_file():
    try:
        return Path(setup.settings_path())
    except Exception:
        return None

def write_json(path, value):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, indent=1) + "\n", encoding="utf-8")
    tmp.replace(path)

if cmd == "fetch":
    dest, repo, rev, items = Path(rest[0]), rest[1], rest[2], rest[3:]
    dest.mkdir(parents=True, exist_ok=True)
    for item in items:
        remote, size, sha = item.rsplit("|", 2); size = int(size)
        dst = dest / remote.rsplit("/", 1)[-1]
        mark = dst.with_name(dst.name + ".done")
        if dst.exists() and dst.stat().st_size == size and mark.exists() and f"sha256 {sha}" in mark.read_text(encoding="utf-8", errors="replace"):
            print(f"{dst.name} already downloaded and verified", flush=True)
            continue
        setup.download(f"{setup.hf_endpoint()}/{repo}/resolve/{rev}/{remote}", dst, f"{repo.split('/')[-1]}: {dst.name}")
        if dst.stat().st_size != size:
            setup.fail(f"{dst.name} is {dst.stat().st_size:,} bytes, not {size:,}", "delete it and its .done mark, then download again")
        setup.verify_sha256(dst, size, sha)
        print(f"  {dst.name}: SHA-256 verified", flush=True)
    print("community files ready", flush=True)
elif cmd == "stash":
    generic, pack = rest[0], Path(rest[1])
    cfg, stash, none = root / generic, root / (generic + ".community-stash"), root / (generic + ".community-none")
    for f in (stash, none):
        if f.exists():
            f.unlink()
    if cfg.exists():
        shutil.copy2(cfg, stash)
    else:
        none.write_text("", encoding="utf-8")
    sf = settings_file()
    snap = {"existed": bool(sf and sf.exists()), "data_dir": None}
    if snap["existed"]:
        try:
            snap["data_dir"] = json.loads(sf.read_text(encoding="utf-8")).get("data_dir")
        except (OSError, ValueError):
            pass
    write_json(root / (generic + ".community-settings"), snap)
    pack.mkdir(parents=True, exist_ok=True)       # setup takes the data folder's pack first: build ours, not the official one
    print(f"official config kept aside: {generic}", flush=True)
elif cmd == "finish":
    generic, target, name = rest[0], rest[1], rest[2]
    cfg, stash, none = root / generic, root / (generic + ".community-stash"), root / (generic + ".community-none")
    if not cfg.exists():
        setup.fail(f"setup wrote no {generic}", "see the log above")
    value = json.loads(cfg.read_text(encoding="utf-8-sig"))
    value["model_name"] = name
    value["log"] = str(root / (Path(target).stem + ".log"))
    write_json(root / target, value)
    if stash.exists():
        stash.replace(cfg)
    elif none.exists():
        cfg.unlink()
        none.unlink()
    snapfile = root / (generic + ".community-settings")
    sf = settings_file()
    if snapfile.exists() and sf and sf.exists():
        snap = json.loads(snapfile.read_text(encoding="utf-8"))
        try:
            now = json.loads(sf.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            now = None
        if isinstance(now, dict) and now.get("data_dir") != snap.get("data_dir"):
            if snap.get("data_dir"):
                now["data_dir"] = snap["data_dir"]
            else:
                now.pop("data_dir", None)
            write_json(sf, now)
            print("remembered data folder restored", flush=True)
    if snapfile.exists():
        snapfile.unlink()
    print(f"config registered: {target} ({name})", flush=True)
else:
    sys.exit(f"unknown command {cmd}")
"#;

/// fetch → stash → setup.py --gguf-dir → finish, all with the runtime's interpreter in its folder.
#[allow(clippy::too_many_arguments)]
pub(crate) fn steps(
    prepared: &Prepared,
    request: &CommunitySetupRequest,
    python: &str,
    env: BTreeMap<String, Option<String>>,
    context: u32,
    images: bool,
    port: u16,
    setup_args: Vec<String>,
) -> Vec<Step> {
    let root = &prepared.root;
    let helper = |args: Vec<String>| Step {
        program: python.into(),
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
        env: env.clone(),
    };
    let item = |file: &CommunityFile| {
        format!(
            "{}|{}|{}",
            file.path,
            file.size,
            file.sha256.clone().unwrap_or_default()
        )
    };
    let mut fetch = vec![
        "fetch".into(),
        prepared.gguf_directory.to_string_lossy().into(),
        request.repo.clone(),
        request.revision.clone(),
    ];
    fetch.extend(request.files.iter().map(item));
    fetch.extend(request.control_vector.iter().map(item));
    let mut setup = vec![
        "-u".into(),
        "setup.py".into(),
        "--yes".into(),
        "--setup".into(),
        "--no-start".into(),
        "--no-browser".into(),
        "--family".into(),
        request.family.clone(),
        "--model".into(),
        request.quant.clone(),
        "--context".into(),
        context.to_string(),
        "--vision".into(),
        if images { "yes" } else { "no" }.into(),
        "--port".into(),
        port.to_string(),
        "--data-dir".into(),
        prepared.data_directory.to_string_lossy().into(),
    ];
    setup.extend(setup_args);
    setup.extend([
        "--gguf-dir".into(),
        prepared.gguf_directory.to_string_lossy().into(),
    ]);
    if let Some(vector) = &request.control_vector {
        let name = vector.path.rsplit('/').next().unwrap_or(&vector.path);
        setup.extend([
            "--experimental-speed-projection".into(),
            prepared.gguf_directory.join(name).to_string_lossy().into(),
        ]);
    }
    vec![
        helper(fetch),
        helper(vec![
            "stash".into(),
            prepared.setup_config.clone(),
            prepared.pack_directory.to_string_lossy().into(),
        ]),
        Step {
            program: python.into(),
            args: setup,
            cwd: root.clone(),
            env: env.clone(),
        },
        helper(vec![
            "finish".into(),
            prepared.setup_config.clone(),
            prepared.community_config.clone(),
            prepared.model_name.clone(),
        ]),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "1620faf21c845524cbe38dcbbaf850b8d155c2299df05d8b7bfb43b642c4647e";
    fn sc117(quant: &str) -> CommunitySetupRequest {
        CommunitySetupRequest {
            slug: "sc117-abliterated".into(),
            repo: "SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF".into(),
            revision: "eec4e10a2c29b440a2ae85591fa11569ce752963".into(),
            family: "qwen".into(),
            quant: quant.into(),
            files: (1..=2)
                .map(|i| CommunityFile {
                    path: format!("{quant}/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-{quant}-0000{i}-of-00002.gguf"),
                    size: 30_000_000_000,
                    sha256: Some(SHA.into()),
                })
                .collect(),
            mmproj: None,
            control_vector: None,
        }
    }

    #[test]
    fn accepts_the_pinned_sc117_shards() {
        for quant in ["Q2_0", "IQ2_XS", "IQ3_XXS", "IQ3_S"] {
            validate(&sc117(quant)).unwrap();
        }
        assert_eq!(
            model_name("sc117-abliterated", "IQ3_S"),
            "community-sc117-abliterated-iq3_s"
        );
        assert_eq!(
            config_file("sc117-abliterated", "Q2_0"),
            "strata-community-sc117-abliterated-q2_0.json"
        );
    }

    #[test]
    fn refuses_unpinned_unsafe_or_mismatched_requests() {
        let mut r = sc117("Q2_0");
        r.revision = "main".into();
        assert!(validate(&r).is_err());
        let mut r = sc117("Q2_0");
        r.files[0].path =
            "../Qwen3.8-Flash-Next-GSQ-RCO-abliterated-Q2_0-00001-of-00002.gguf".into();
        assert!(validate(&r).is_err());
        let mut r = sc117("Q2_0");
        r.files[0].path =
            "/etc/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-Q2_0-00001-of-00002.gguf".into();
        assert!(validate(&r).is_err());
        let mut r = sc117("Q2_0");
        r.files[1].sha256 = None;
        assert!(validate(&r).unwrap_err().contains("SHA-256"));
        let mut r = sc117("Q2_0");
        r.files.pop();
        assert!(validate(&r).is_err(), "an incomplete shard set");
        let mut r = sc117("Q2_0");
        r.quant = "IQ3_S".into();
        assert!(validate(&r).is_err(), "names say Q2_0");
        let mut r = sc117("Q2_0");
        r.family = "swift".into();
        assert!(validate(&r).is_err());
        let mut r = sc117("Q2_0");
        r.repo = "a/b/c".into();
        assert!(validate(&r).is_err());
        let mut r = sc117("Q2_0");
        r.slug = "../x".into();
        assert!(validate(&r).is_err());
        let mut r = sc117("Q2_0");
        r.files.iter_mut().for_each(|f| f.size = 1000);
        assert!(validate(&r).is_err());
    }

    #[test]
    fn control_vector_is_root_level_small_and_hashed() {
        let mut r = sc117("Q2_0");
        r.control_vector = Some(CommunityFile {
            path: "Huihui-Qwen3.8-Flash-Next-refusal-direction-r.gguf".into(),
            size: 483_520,
            sha256: Some("59f9ae8b4372107ae79044278a4406bdfe8f8861fe599aa5848515f0d072be38".into()),
        });
        validate(&r).unwrap();
        r.control_vector.as_mut().unwrap().size = MAX_VECTOR_BYTES + 1;
        assert!(validate(&r).is_err());
    }

    #[test]
    fn steps_download_stash_setup_and_rename() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runtime");
        std::fs::create_dir_all(&root).unwrap();
        let data = temp.path().join("data");
        let request = sc117("IQ3_S");
        let prepared = prepare(
            &root,
            &request,
            &disk::Settings {
                data_dir: Some(data.clone()),
                ..disk::Settings::default()
            },
        )
        .unwrap();
        assert_eq!(
            prepared.data_directory,
            data.join("community/sc117-abliterated-iq3_s")
        );
        assert_eq!(
            prepared.pack_directory,
            data.join("community/sc117-abliterated-iq3_s/packs/iq3_s")
        );
        assert_eq!(prepared.setup_config, "strata-iq3_s.json");
        assert_eq!(prepared.download_bytes, 60_000_000_000);
        let steps = steps(
            &prepared,
            &request,
            "python",
            BTreeMap::new(),
            32768,
            true,
            8080,
            vec![],
        );
        assert_eq!(steps.len(), 4);
        assert_eq!(steps[0].args[4], "fetch");
        assert!(steps[0].args.iter().any(|a| a.starts_with("IQ3_S/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_S-00001-of-00002.gguf|30000000000|1620")));
        assert_eq!(steps[1].args[4], "stash");
        let setup = &steps[2].args;
        assert!(setup
            .windows(2)
            .any(|w| w[0] == "--gguf-dir" && w[1].ends_with("IQ3_S")));
        assert!(setup
            .windows(2)
            .any(|w| w[0] == "--family" && w[1] == "qwen"));
        assert!(setup
            .windows(2)
            .any(|w| w[0] == "--data-dir" && w[1].ends_with("sc117-abliterated-iq3_s")));
        assert!(!setup.iter().any(|a| a == "--experimental-speed-projection"));
        assert_eq!(
            steps[3].args[4..],
            [
                "finish",
                "strata-iq3_s.json",
                "strata-community-sc117-abliterated-iq3_s.json",
                "community-sc117-abliterated-iq3_s"
            ]
        );
    }
}
