//! Apple Silicon Metal engine package (phase 2a): pin, select, verify, extract.
//!
//! Pure helpers take explicit `(os, arch)` so Linux CI can cover Mac selection
//! without compiling for darwin. Download/install wiring lives in `installation`.
//! Phase 2b (`./setup.sh` source build) is not automated; see `manual_build_hint`.

use flate2::read::GzDecoder;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

/// Upstream release that first shipped the ready-made Metal engine component.
pub const METAL_RELEASE_TAG: &str = "v0.2.0-beta";
/// Exact asset name on that release (do not fuzzy-match Windows/Linux packages).
pub const METAL_ENGINE_ASSET_NAME: &str = "strata-engine-0.1.45.3-macos-arm64-metal.tar.gz";
/// Official SHA-256 of [`METAL_ENGINE_ASSET_NAME`] (in-app check only; we do not ship SHA256SUMS).
pub const METAL_ENGINE_SHA256: &str =
    "47c5f5a8936e1497ed4c24ca0a26a46812affbce43d530106a317214c353d207";
/// Exact byte length of the published archive.
pub const METAL_ENGINE_SIZE: u64 = 2_353_518;
/// `BUILD.json` / component version inside the archive.
pub const METAL_ENGINE_VERSION: &str = "0.1.45.3";
/// Relative engine directory after extract (same layout as Windows `engine/`).
pub const METAL_ENGINE_DIR: &str = "engine";
/// Mach-O entrypoint inside [`METAL_ENGINE_DIR`].
pub const METAL_ENGINE_BINARY: &str = "strata";
/// Source-built layout from upstream `./setup.sh` (`build-metal/strata`).
pub const METAL_BUILD_DIR: &str = "build-metal";

const MAX_METAL_ENTRIES: usize = 512;
const MAX_METAL_EXPANDED: u64 = 64 * 1024 * 1024;

/// Download URL for the pinned Metal engine package.
pub fn metal_engine_download_url() -> String {
    format!(
        "https://github.com/Niko1221/Strata/releases/download/{METAL_RELEASE_TAG}/{METAL_ENGINE_ASSET_NAME}"
    )
}

/// Config `exe` path for a managed Metal install under the Strata root.
pub fn metal_engine_relative_exe() -> &'static str {
    "engine/strata"
}

/// Whether this host OS/arch may install the ready-made Metal engine package.
pub fn metal_engine_supported(os: &str, arch: &str) -> bool {
    os == "macos" && arch == "aarch64"
}

/// Never offer Windows or Linux engine archives on Mac (and vice versa for Metal).
pub fn platform_accepts_engine_asset(os: &str, arch: &str, asset_name: &str) -> bool {
    let name = asset_name.trim();
    if name.is_empty() {
        return false;
    }
    if metal_engine_supported(os, arch) {
        return is_pinned_metal_engine_asset(name);
    }
    if os == "windows" && arch == "x86_64" {
        return matches!(
            name,
            "strata-windows-x64.zip"
                | "strata-windows-x64-cuda12.zip"
                | "strata-windows-x64-hip.zip"
        );
    }
    false
}

/// Exact pin used by Manager for Metal downloads and local archive matching.
pub fn is_pinned_metal_engine_asset(name: &str) -> bool {
    name == METAL_ENGINE_ASSET_NAME
}

/// Pick the Metal asset from a release asset list for the given platform.
pub fn select_engine_asset_name<'a>(
    os: &str,
    arch: &str,
    asset_names: impl IntoIterator<Item = &'a str>,
) -> Option<&'a str> {
    if !metal_engine_supported(os, arch) {
        return None;
    }
    asset_names
        .into_iter()
        .find(|name| is_pinned_metal_engine_asset(name))
}

/// Verify length + SHA-256 against the pinned Metal package.
pub fn verify_metal_engine_bytes(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 != METAL_ENGINE_SIZE {
        return Err(format!(
            "Metal 引擎包长度不是官方 {METAL_ENGINE_SIZE} 字节（实际 {}）/ Metal engine archive length is not the official {METAL_ENGINE_SIZE} bytes (got {})",
            bytes.len(),
            bytes.len()
        ));
    }
    let digest = format!("{:x}", Sha256::digest(bytes));
    if digest != METAL_ENGINE_SHA256 {
        return Err(
            "Metal 引擎包 SHA256 与官方不一致 / Metal engine archive SHA256 does not match the official digest"
                .into(),
        );
    }
    Ok(())
}

/// Verify an on-disk archive against the pin (streams; does not load whole file).
pub fn verify_metal_engine_file(path: &Path) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|e| {
        format!("无法读取 Metal 引擎包：{e} / Cannot read the Metal engine archive: {e}")
    })?;
    if !metadata.is_file() {
        return Err(
            "Metal 引擎包不是普通文件 / The Metal engine archive is not a regular file".into(),
        );
    }
    if metadata.len() != METAL_ENGINE_SIZE {
        return Err(format!(
            "Metal 引擎包长度不是官方 {METAL_ENGINE_SIZE} 字节（实际 {}）/ Metal engine archive length is not the official {METAL_ENGINE_SIZE} bytes (got {})",
            metadata.len(),
            metadata.len()
        ));
    }
    let mut reader = File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buf = [0u8; 65_536];
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        digest.update(&buf[..n]);
    }
    let hex = format!("{:x}", digest.finalize());
    if hex != METAL_ENGINE_SHA256 {
        return Err(
            "Metal 引擎包 SHA256 与官方不一致 / Metal engine archive SHA256 does not match the official digest"
                .into(),
        );
    }
    Ok(())
}

fn metal_entry_allowed(relative: &str) -> bool {
    relative == "BUILD.json"
        || relative == "engine-component.json"
        || relative == METAL_ENGINE_BINARY
        || relative.starts_with("metal/")
}

fn safe_metal_relative(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains('\0') {
        return Err("Metal 引擎包含无效路径 / Metal engine archive has an invalid path".into());
    }
    let path = Path::new(name);
    if path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!(
            "Metal 引擎包路径不安全：{name} / Unsafe path in Metal engine archive: {name}"
        ));
    }
    Ok(path.to_path_buf())
}

/// Extract a verified Metal `.tar.gz` into `destination` (usually `install/engine`).
pub fn extract_metal_engine_archive(
    archive: &Path,
    destination: &Path,
    check: impl Fn() -> Result<(), String>,
) -> Result<Vec<String>, String> {
    check()?;
    if destination.exists() {
        if destination.is_symlink() || !destination.is_dir() {
            return Err(
                "引擎目录被替换或重定向，拒绝解包 / Engine directory was replaced or redirected"
                    .into(),
            );
        }
    } else {
        fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    }
    let file = File::open(archive).map_err(|e| e.to_string())?;
    let decoder = GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let mut names = HashSet::new();
    let mut files = Vec::new();
    let mut total = 0u64;
    let mut saw_binary = false;
    let mut saw_build = false;

    for entry in archive.entries().map_err(|e| e.to_string())? {
        check()?;
        let mut entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().map_err(|e| e.to_string())?;
        let name = path.to_string_lossy().replace('\\', "/");
        let name = name.trim_start_matches("./");
        if name.is_empty() || name.ends_with('/') {
            continue;
        }
        let relative = safe_metal_relative(name)?;
        let relative_str = relative.to_string_lossy().replace('\\', "/");
        if !metal_entry_allowed(&relative_str) {
            return Err(format!(
                "Metal 引擎包含未识别的文件：{relative_str} / Unrecognized file in Metal engine archive: {relative_str}"
            ));
        }
        if !names.insert(relative_str.to_ascii_lowercase()) {
            return Err("Metal 引擎包含重复路径 / Metal engine archive has duplicate paths".into());
        }
        let size = entry.size();
        total = total
            .checked_add(size)
            .ok_or("Metal 引擎包展开体积无效 / Invalid expanded Metal archive size")?;
        if total > MAX_METAL_EXPANDED || size > MAX_METAL_EXPANDED {
            return Err(
                "Metal 引擎包展开体积超过安全上限 / Metal engine archive expands beyond the safety limit"
                    .into(),
            );
        }
        if names.len() > MAX_METAL_ENTRIES {
            return Err(
                "Metal 引擎包文件数超过安全上限 / Metal engine archive has too many files".into(),
            );
        }
        let target = destination.join(&relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if target.exists() {
            fs::remove_file(&target).map_err(|e| e.to_string())?;
        }
        {
            let mut out = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
            out.sync_all().map_err(|e| e.to_string())?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = entry.header().mode().unwrap_or(0o644);
            let mut perms = fs::metadata(&target)
                .map_err(|e| e.to_string())?
                .permissions();
            if relative_str == METAL_ENGINE_BINARY {
                perms.set_mode(0o755);
            } else {
                perms.set_mode(mode & 0o777);
            }
            fs::set_permissions(&target, perms).map_err(|e| e.to_string())?;
        }
        if relative_str == METAL_ENGINE_BINARY {
            saw_binary = true;
        }
        if relative_str == "BUILD.json" {
            saw_build = true;
        }
        files.push(relative_str);
    }

    if !saw_binary || !saw_build {
        return Err(
            "Metal 引擎包缺少 strata 或 BUILD.json / Metal engine archive is missing strata or BUILD.json"
                .into(),
        );
    }
    let build_path = destination.join("BUILD.json");
    let build: Value = serde_json::from_slice(&fs::read(&build_path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Metal BUILD.json 无效：{e}"))?;
    if build["backend"].as_str() != Some("metal") {
        return Err(
            "Metal 引擎 BUILD.json 的 backend 不是 metal / BUILD.json backend is not metal".into(),
        );
    }
    if build["version"].as_str() != Some(METAL_ENGINE_VERSION) {
        return Err(format!(
            "Metal 引擎版本不是 {METAL_ENGINE_VERSION} / Metal engine version is not {METAL_ENGINE_VERSION}"
        ));
    }
    Ok(files)
}

/// Mac engine argv defaults from upstream `docs/MAC.md` (no `--parallel`).
pub fn mac_default_engine_args() -> Vec<&'static str> {
    vec!["--spec", "2"]
}

/// Env vars Manager may set for Metal defaults (Q8 HC is already the Mac default).
pub fn mac_default_engine_env() -> Vec<(&'static str, &'static str)> {
    Vec::new()
}

/// Whether PCIe `--calibrate` / quick calibrate UI should be offered.
pub fn mac_supports_calibrate(os: &str) -> bool {
    os != "macos"
}

/// Whether `--parallel` / multi-slot concurrency is supported.
pub fn mac_supports_parallel(os: &str) -> bool {
    os != "macos"
}

/// Catalog families upstream has measured on Metal. Qwen3.6 / Swift / Coder are not.
pub fn mac_catalog_family_allowed(family: &str) -> bool {
    matches!(family, "qwen" | "unsloth")
}

/// Filter a catalog family list for Mac (Metal).
pub fn filter_catalog_families_for_mac<'a>(
    families: impl IntoIterator<Item = &'a str>,
) -> Vec<&'a str> {
    families
        .into_iter()
        .filter(|family| mac_catalog_family_allowed(family))
        .collect()
}

/// Resolve a Metal engine binary under a Strata root (managed or existing).
pub fn resolve_metal_engine_binary(root: &Path) -> Option<PathBuf> {
    for relative in [
        format!("{METAL_ENGINE_DIR}/{METAL_ENGINE_BINARY}"),
        format!("{METAL_BUILD_DIR}/{METAL_ENGINE_BINARY}"),
    ] {
        let path = root.join(&relative);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

/// Engine directory names to probe on Mac (in addition to CUDA-style names).
pub fn mac_known_engine_dir_names() -> &'static [&'static str] {
    &[METAL_ENGINE_DIR, METAL_BUILD_DIR]
}

/// Clear bilingual hint when the user prefers a source build (phase 2b not automated).
pub fn manual_build_hint() -> (&'static str, &'static str) {
    (
        "若需自行编译 Metal 引擎：在 Strata 源码目录按上游 docs/MAC.md 运行 ./setup.sh（约 1–15 分钟，需要 Command Line Tools）。Manager 目前优先安装官方预制包 strata-engine-*-macos-arm64-metal.tar.gz。",
        "To build the Metal engine yourself: in a Strata source tree run ./setup.sh per upstream docs/MAC.md (about 1–15 minutes; needs Command Line Tools). Manager prefers the official prebuilt package strata-engine-*-macos-arm64-metal.tar.gz.",
    )
}

/// Extension check for a local Metal engine archive path.
pub fn is_metal_engine_archive_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".tar.gz") || lower.ends_with(".tgz")
}

/// Write a small marker so readiness can show the installed Metal package pin.
pub fn write_metal_install_marker(engine_dir: &Path) -> Result<(), String> {
    let marker = engine_dir.join(".strata-manager-metal.json");
    let body = serde_json::json!({
        "assetName": METAL_ENGINE_ASSET_NAME,
        "sha256": METAL_ENGINE_SHA256,
        "size": METAL_ENGINE_SIZE,
        "version": METAL_ENGINE_VERSION,
        "releaseTag": METAL_RELEASE_TAG,
    });
    let mut tmp = tempfile::NamedTempFile::new_in(engine_dir).map_err(|e| e.to_string())?;
    tmp.write_all(
        serde_json::to_vec_pretty(&body)
            .map_err(|e| e.to_string())?
            .as_slice(),
    )
    .map_err(|e| e.to_string())?;
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    tmp.persist(marker).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn metal_supported_only_on_macos_aarch64() {
        assert!(metal_engine_supported("macos", "aarch64"));
        assert!(!metal_engine_supported("macos", "x86_64"));
        assert!(!metal_engine_supported("windows", "aarch64"));
        assert!(!metal_engine_supported("linux", "aarch64"));
    }

    #[test]
    fn mac_never_accepts_windows_or_linux_engine_zips() {
        assert!(!platform_accepts_engine_asset(
            "macos",
            "aarch64",
            "strata-windows-x64.zip"
        ));
        assert!(!platform_accepts_engine_asset(
            "macos",
            "aarch64",
            "strata-engine-0.1.45.3-windows-x86_64-cuda-cuda13.tar.gz"
        ));
        assert!(!platform_accepts_engine_asset(
            "macos",
            "aarch64",
            "strata-engine-0.1.45.3-linux-x86_64-cuda-cuda13.tar.gz"
        ));
        assert!(platform_accepts_engine_asset(
            "macos",
            "aarch64",
            METAL_ENGINE_ASSET_NAME
        ));
    }

    #[test]
    fn windows_still_accepts_classic_zips_not_metal() {
        assert!(platform_accepts_engine_asset(
            "windows",
            "x86_64",
            "strata-windows-x64.zip"
        ));
        assert!(!platform_accepts_engine_asset(
            "windows",
            "x86_64",
            METAL_ENGINE_ASSET_NAME
        ));
    }

    #[test]
    fn select_engine_asset_picks_only_pinned_metal_name() {
        let names = [
            "strata-windows-x64.zip",
            "strata-engine-0.1.45.3-macos-arm64-metal.tar.gz",
            "Strata-0.2.0-beta-mac.dmg",
        ];
        assert_eq!(
            select_engine_asset_name("macos", "aarch64", names),
            Some(METAL_ENGINE_ASSET_NAME)
        );
        assert_eq!(select_engine_asset_name("linux", "x86_64", names), None);
        assert_eq!(select_engine_asset_name("windows", "x86_64", names), None);
    }

    #[test]
    fn mac_defaults_have_spec_2_and_no_parallel_or_calibrate() {
        assert_eq!(mac_default_engine_args(), vec!["--spec", "2"]);
        assert!(!mac_supports_parallel("macos"));
        assert!(mac_supports_parallel("windows"));
        assert!(!mac_supports_calibrate("macos"));
        assert!(mac_supports_calibrate("linux"));
    }

    #[test]
    fn mac_catalog_hides_qwen36_swift_coder() {
        assert_eq!(
            filter_catalog_families_for_mac(["qwen", "swift", "coder", "unsloth", "qwen36"]),
            vec!["qwen", "unsloth"]
        );
        assert!(!mac_catalog_family_allowed("qwen36"));
    }

    #[test]
    fn relative_exe_and_dirs() {
        assert_eq!(metal_engine_relative_exe(), "engine/strata");
        assert!(mac_known_engine_dir_names().contains(&"engine"));
        assert!(mac_known_engine_dir_names().contains(&"build-metal"));
    }

    #[test]
    fn resolve_prefers_engine_then_build_metal() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        assert!(resolve_metal_engine_binary(root).is_none());
        fs::create_dir_all(root.join("build-metal")).unwrap();
        fs::write(root.join("build-metal/strata"), b"build").unwrap();
        assert_eq!(
            resolve_metal_engine_binary(root).unwrap(),
            root.join("build-metal/strata")
        );
        fs::create_dir_all(root.join("engine")).unwrap();
        fs::write(root.join("engine/strata"), b"pkg").unwrap();
        assert_eq!(
            resolve_metal_engine_binary(root).unwrap(),
            root.join("engine/strata")
        );
    }

    #[test]
    fn verify_rejects_wrong_length_or_digest() {
        assert!(verify_metal_engine_bytes(b"short").is_err());
        let mut fake = vec![0u8; METAL_ENGINE_SIZE as usize];
        fake[0] = 1;
        assert!(verify_metal_engine_bytes(&fake).is_err());
    }

    #[test]
    fn extract_metal_fixture_roundtrip() {
        let temp = tempfile::tempdir().unwrap();
        let tar_path = temp.path().join("mini.tar");
        {
            let file = File::create(&tar_path).unwrap();
            let mut builder = tar::Builder::new(file);
            let build = br#"{"version":"0.1.45.3","backend":"metal"}"#;
            let mut header = tar::Header::new_gnu();
            header.set_size(build.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, "BUILD.json", &build[..])
                .unwrap();
            let bin = b"#!/bin/sh\necho metal-fixture\n";
            let mut header = tar::Header::new_gnu();
            header.set_size(bin.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder
                .append_data(&mut header, "strata", &bin[..])
                .unwrap();
            let kernel = b"// metal fixture\n";
            let mut header = tar::Header::new_gnu();
            header.set_size(kernel.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, "metal/kernels/units.metal", &kernel[..])
                .unwrap();
            builder.finish().unwrap();
        }
        let gz_path = temp.path().join("mini.tar.gz");
        {
            let mut encoder = flate2::write::GzEncoder::new(
                File::create(&gz_path).unwrap(),
                flate2::Compression::default(),
            );
            encoder.write_all(&fs::read(&tar_path).unwrap()).unwrap();
            encoder.finish().unwrap();
        }
        let dest = temp.path().join("engine");
        let files = extract_metal_engine_archive(&gz_path, &dest, || Ok(())).unwrap();
        assert!(files.iter().any(|f| f == "strata"));
        assert!(dest.join("strata").is_file());
        assert!(dest.join("metal/kernels/units.metal").is_file());
        write_metal_install_marker(&dest).unwrap();
        assert!(dest.join(".strata-manager-metal.json").is_file());
    }

    #[test]
    fn extract_rejects_windows_dll() {
        let temp = tempfile::tempdir().unwrap();
        let tar_path = temp.path().join("bad.tar");
        {
            let file = File::create(&tar_path).unwrap();
            let mut builder = tar::Builder::new(file);
            for (name, data, mode) in [
                (
                    "BUILD.json",
                    br#"{"version":"0.1.45.3","backend":"metal"}"#.as_slice(),
                    0o644,
                ),
                ("strata", b"x".as_slice(), 0o755),
                ("cublas64_13.dll", b"dll".as_slice(), 0o644),
            ] {
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(mode);
                header.set_cksum();
                builder.append_data(&mut header, name, data).unwrap();
            }
            builder.finish().unwrap();
        }
        let gz_path = temp.path().join("bad.tar.gz");
        {
            let mut encoder = flate2::write::GzEncoder::new(
                File::create(&gz_path).unwrap(),
                flate2::Compression::default(),
            );
            encoder.write_all(&fs::read(&tar_path).unwrap()).unwrap();
            encoder.finish().unwrap();
        }
        let err =
            extract_metal_engine_archive(&gz_path, &temp.path().join("out"), || Ok(())).unwrap_err();
        assert!(err.contains("cublas") || err.contains("未识别"), "{err}");
    }

    #[test]
    fn archive_path_helper_recognizes_tar_gz() {
        assert!(is_metal_engine_archive_path(
            "/tmp/strata-engine-0.1.45.3-macos-arm64-metal.tar.gz"
        ));
        assert!(is_metal_engine_archive_path("/tmp/x.tgz"));
        assert!(!is_metal_engine_archive_path("/tmp/strata-windows-x64.zip"));
    }

    #[test]
    fn manual_build_hint_mentions_setup_sh() {
        let (zh, en) = manual_build_hint();
        assert!(zh.contains("./setup.sh"));
        assert!(en.contains("./setup.sh"));
        assert!(en.contains("MAC.md"));
    }
}
