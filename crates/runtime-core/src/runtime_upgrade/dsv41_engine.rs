//! DeepSeek-V4.1's engine (`strata-dsv41`) as its own package: the signed feed member
//! `dsv41` (Strata 0.2.5+), published for Windows CUDA 13, Linux CUDA 13, Linux HIP
//! (RX 9000 / R9700) and, from Strata 0.2.7, Windows HIP for Ryzen AI Max (Strix Halo, gfx1151),
//! which carries its ROCm runtime in `rocm/bin` (BUILD.json `lib_dirs`).
//!
//! It goes in `<runtime>/engine-dsv41/<version>-<platform>-<backend>[-<variant>]/`, beside the
//! Strata engine and never inside it, the folder upstream's `setup.py` (`dsv41_engine_dir`) and
//! `strata_control/dsv41_engine.find` read. The Strata engine (`engine/`), its version, its
//! updates, switches and rollbacks are untouched: this package is never an engine asset.
//!
//! Checked like an engine update: the signed feed, GitHub's digest and size equal to the feed's,
//! the archive SHA-256 after download (mirror first, GitHub as the fallback, resumable), then the
//! manifest digest the feed names, its signature and every extracted file. A new version is
//! staged next to the old one, started once (`--version`) and only then replaces it (one
//! generation is kept, as upstream does).
use super::{engine_package, github_source, gpu_select, release_zip, RuntimeReleaseAsset};
use crate::{installation, processes, RuntimeState};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

/// Folder beside the engine (upstream `DSV41_ENGINE_DIR`).
pub const DIR: &str = "engine-dsv41";
/// The engine program's name, and the first word of its `--version` line.
pub const NAME: &str = "strata-dsv41";
/// Environment variable upstream's setup reads for the DeepSeek engine (it also stops
/// setup's own automatic download and upgrade, so the package Manager checked is used).
pub const EXE_ENV: &str = "STRATA_DSV41_EXE";

pub fn exe_name(platform: &str) -> &'static str {
    if platform.starts_with("windows") {
        "strata-dsv41.exe"
    } else {
        "strata-dsv41"
    }
}

/// `<version>-<platform>-<backend>[-<variant>]`, upstream's package folder name.
pub fn folder_name(asset: &RuntimeReleaseAsset) -> Option<String> {
    let parsed = engine_package::parse_dsv41_package_name(&asset.name)?;
    let mut name = format!("{}-{}-{}", parsed.version, parsed.platform, parsed.backend);
    if !parsed.variant.is_empty() {
        name.push('-');
        name.push_str(&parsed.variant);
    }
    Some(name)
}

type VersionKey = (Vec<u32>, bool, String);
/// Checks an extracted package folder against its signed manifest and file list.
type Verify<'a> = &'a dyn Fn(&Path, &[String]) -> Result<(), String>;

fn folder_version(name: &str) -> Option<VersionKey> {
    engine_package::version_key(name.split('-').next()?)
}

/// The newest installed package in `dir` (`engine-dsv41/`): its folder version and program.
pub fn find(dir: &Path, platform: &str) -> Option<(String, PathBuf)> {
    let exe = exe_name(platform);
    let mut best: Option<(VersionKey, String, PathBuf)> = None;
    for entry in fs::read_dir(dir).ok()?.take(64).flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_dir() || !path.join(exe).is_file() {
            continue;
        }
        let Some(key) = folder_version(&name) else {
            continue;
        };
        if best.as_ref().is_none_or(|(k, n, _)| (&key, &name) > (k, n)) {
            best = Some((key, name, path.join(exe)));
        }
    }
    best.map(|(_, name, exe)| (name.split('-').next().unwrap_or_default().to_owned(), exe))
}

/// The installed DeepSeek engine's version under a runtime folder, if any.
pub fn installed_version(root: &Path) -> Option<String> {
    let platform = engine_package::this_release_install_platform()?;
    find(&root.join(DIR), platform).map(|(version, _)| version)
}

/// Whether `installed` is at least `wanted` (both upstream engine versions).
pub fn version_at_least(installed: &str, wanted: &str) -> bool {
    match (
        engine_package::version_key(installed),
        engine_package::version_key(wanted),
    ) {
        (Some(a), Some(b)) => a >= b,
        _ => false,
    }
}

/// The package for this computer's GPU, chosen by the same rules as a Linux engine
/// update (NVIDIA: architectures and minimum driver; AMD: the GPU target).
pub fn select(
    assets: &[RuntimeReleaseAsset],
    probe: &gpu_select::GpuProbe,
) -> Result<(RuntimeReleaseAsset, String), String> {
    if assets.is_empty() {
        return Err("此 Strata 版本的签名 feed 没有本平台可用的 DeepSeek 引擎包（需要 Strata 0.2.5 或更新，Windows CUDA 13 / Linux CUDA 13 / Linux HIP RX 9000；Windows Ryzen AI Max 需要 Strata 0.2.7 或更新） / The signed feed has no DeepSeek engine package for this platform".into());
    }
    gpu_select::pick(assets, probe).map_err(|reason| {
        format!(
            "没有适合本机显卡的 DeepSeek 引擎包（支持 NVIDIA CUDA 13，需 Ampere sm_86 或更新的显卡（RTX 30 系起；A100 等 sm_80 不支持），驱动 580.65+；Linux 上的 AMD RX 9000 / R9700；Windows 上的 Ryzen AI Max / Radeon 8060S 等 gfx1151）：{reason}"
        )
    })
}

fn clear(path: &Path) {
    if fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()) {
        let _ = fs::remove_dir_all(path);
    } else {
        let _ = fs::remove_file(path);
    }
}

/// `strata-dsv41 --version` runs and names itself (no GPU or model needed).
pub fn test_start(exe: &Path) -> Result<String, String> {
    let program = exe.to_string_lossy().into_owned();
    let envs: Vec<_> = start_env(exe, std::env::var_os(LIB_VAR))
        .into_iter()
        .collect();
    let text = crate::output_with_timeout_env(
        &program,
        &["--version"],
        &envs,
        exe.parent(),
        Duration::from_secs(120),
    )
    .ok_or("新的 DeepSeek 引擎无法启动 / The new DeepSeek engine did not start")?;
    let first = text.lines().next().unwrap_or_default().trim().to_owned();
    if !first.starts_with(NAME) {
        return Err(format!(
            "新的 DeepSeek 引擎没有正确启动（{}） / The new DeepSeek engine did not start correctly",
            first.chars().take(160).collect::<String>()
        ));
    }
    Ok(first)
}

/// The library search variable of this platform: Windows finds DLLs on `PATH`.
const LIB_VAR: &str = if cfg!(windows) {
    "PATH"
} else {
    "LD_LIBRARY_PATH"
};

/// The folders that must be on the library path when this engine starts: its own package
/// folder, then the folders its BUILD.json names in `lib_dirs` (upstream 0.2.7
/// `strata_control/dsv41_engine.lib_dirs` / `engine_component.package_lib_dirs`). The Windows
/// HIP package keeps hipBLAS / rocBLAS in `rocm/bin`, and `strata-dsv41.exe` imports
/// `hipblas.dll`, so it does not even print its version without them. Only relative folders
/// that exist inside the package count; anything else in the list is ignored, as upstream does.
pub fn lib_dirs(exe: &Path) -> Vec<PathBuf> {
    let Some(folder) = exe.parent() else {
        return Vec::new();
    };
    let mut dirs = vec![folder.to_path_buf()];
    let names = fs::read_to_string(folder.join("BUILD.json"))
        .ok()
        .and_then(|text| {
            serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}')).ok()
        })
        .and_then(|build| build.get("lib_dirs").and_then(|v| v.as_array()).cloned())
        .unwrap_or_default();
    for name in names.iter().filter_map(|v| v.as_str()) {
        let relative = Path::new(name);
        if name.is_empty()
            || !relative
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_)))
        {
            continue;
        }
        let path = folder.join(relative);
        if fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir()) && !dirs.contains(&path) {
            dirs.push(path);
        }
    }
    dirs
}

/// The library-path entry to start `exe` with: its [`lib_dirs`] first, then `current` (the
/// process's own value). `None` when the package has no folders to add.
fn start_env(
    exe: &Path,
    current: Option<std::ffi::OsString>,
) -> Option<(std::ffi::OsString, std::ffi::OsString)> {
    let mut dirs = lib_dirs(exe);
    if dirs.is_empty() {
        return None;
    }
    if let Some(current) = current.filter(|c| !c.is_empty()) {
        dirs.extend(std::env::split_paths(&current));
    }
    let value = std::env::join_paths(dirs).ok()?;
    Some((LIB_VAR.into(), value))
}

/// Install a downloaded, SHA-256-checked archive into `dir`: extract into a staging folder,
/// verify it (`verify`: the signed manifest and every file), move it into place, start it
/// once when it replaces an older package (`probe`), then remove the older folders. Returns
/// the program to run; on a failed start the older package stays and is returned.
pub fn install_archive(
    dir: &Path,
    archive: &Path,
    asset: &RuntimeReleaseAsset,
    platform: &str,
    verify: Verify<'_>,
    probe: &dyn Fn(&Path) -> Result<String, String>,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<(PathBuf, Option<String>), String> {
    let folder =
        folder_name(asset).ok_or("不是 DeepSeek 引擎包 / Not a DeepSeek engine package")?;
    let parsed = engine_package::parse_dsv41_package_name(&asset.name)
        .ok_or("不是 DeepSeek 引擎包 / Not a DeepSeek engine package")?;
    if parsed.platform != platform
        || !engine_package::dsv41_supported(parsed.platform, &parsed.backend, &parsed.variant)
    {
        return Err(
            "DeepSeek 引擎包不适用于本机平台 / The DeepSeek engine package is for another platform"
                .into(),
        );
    }
    let exe = exe_name(platform);
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    if fs::symlink_metadata(dir)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("engine-dsv41 是链接，已拒绝写入".into());
    }
    let previous = find(dir, platform);
    let stage = dir.join(format!(".staging-{}", uuid::Uuid::new_v4()));
    let result = (|| -> Result<PathBuf, String> {
        let files = release_zip::extract_package_files(
            archive,
            &stage,
            asset
                .installed_bytes
                .unwrap_or(engine_package::MAX_PACKAGE_EXPANDED),
            release_zip::dsv41_file_allowed,
            check,
        )?;
        if !stage.join(exe).is_file() || !stage.join(engine_package::MANIFEST_NAME).is_file() {
            return Err(format!(
                "DeepSeek 引擎包缺少 {exe} 或签名清单 / The DeepSeek engine package lacks {exe} or its manifest"
            ));
        }
        verify(&stage, &files)?;
        let manifest: serde_json::Value = serde_json::from_slice(
            &fs::read(stage.join(engine_package::MANIFEST_NAME)).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        if manifest["entrypoint"]
            .as_str()
            .is_some_and(|entry| entry != exe)
        {
            return Err("这不是 DeepSeek 引擎包（入口程序不同） / Not the DeepSeek engine (different entrypoint)".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(stage.join(exe), fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
        }
        check()?;
        let target = dir.join(&folder);
        if fs::symlink_metadata(&target).is_ok() {
            // The same version again (a repair): the old copy moves aside first.
            let aside = dir.join(format!(".old-{}", uuid::Uuid::new_v4()));
            fs::rename(&target, &aside).map_err(|e| e.to_string())?;
            if let Err(error) = fs::rename(&stage, &target) {
                let _ = fs::rename(&aside, &target);
                return Err(error.to_string());
            }
            clear(&aside);
        } else {
            fs::rename(&stage, &target).map_err(|e| e.to_string())?;
        }
        Ok(target.join(exe))
    })();
    clear(&stage);
    let installed = result?;
    if let Some((_, old)) = previous.as_ref().filter(|(_, old)| old != &installed) {
        if let Err(error) = probe(&installed) {
            // Keep what worked: the new folder goes, the older package stays in use.
            if let Some(parent) = installed.parent() {
                clear(parent);
            }
            return Ok((old.clone(), Some(error)));
        }
    }
    let keep = installed.parent().map(Path::to_path_buf);
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.take(64).flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_dir = fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir());
            if is_dir
                && Some(&path) != keep.as_ref()
                && (folder_version(&name).is_some() || name.starts_with(".old-"))
            {
                clear(&path);
            }
        }
    }
    Ok((installed, None))
}

fn cancelled(state: &RuntimeState, id: &str) -> Result<(), String> {
    let tasks = state.tasks.lock().map_err(|e| e.to_string())?;
    if tasks.get(id).is_none_or(|record| record.cancelled) {
        return Err("任务已取消；已下载的 DeepSeek 引擎包保留以供续传".into());
    }
    Ok(())
}

fn say(state: &RuntimeState, id: &str, message: impl Into<String>) {
    processes::log(&state.logs, id, "info", message);
}

/// Mirror first (or GitHub first when chosen under download sources); both are held to the
/// signed size and SHA-256, and the hash-addressed download resumes after an interruption.
async fn download(
    state: &RuntimeState,
    id: &str,
    asset: &RuntimeReleaseAsset,
) -> Result<PathBuf, String> {
    let mut failures = Vec::new();
    for via in github_source::order() {
        cancelled(state, id)?;
        let result = match via {
            github_source::Via::Official => {
                installation::download_release(state, id, &asset.url, &asset.sha256, asset.size)
                    .await
            }
            github_source::Via::Mirror => {
                let client = reqwest::Client::builder()
                    .connect_timeout(Duration::from_secs(10))
                    .redirect(reqwest::redirect::Policy::custom(|attempt| {
                        if attempt.previous().len() >= 5 {
                            return attempt.error("mirror redirect limit exceeded");
                        }
                        if attempt.url().scheme() == "https"
                            && attempt.url().username().is_empty()
                            && attempt.url().password().is_none()
                        {
                            attempt.follow()
                        } else {
                            attempt.error("mirror redirect must remain HTTPS without credentials")
                        }
                    }))
                    .build()
                    .map_err(|error| error.to_string())?;
                installation::download_using_client(
                    state,
                    id,
                    &github_source::url(via, &asset.url),
                    &asset.sha256,
                    asset.size,
                    &client,
                )
                .await
            }
        };
        match result {
            Ok(archive) => {
                if archive.metadata().map_err(|e| e.to_string())?.len() != asset.size {
                    return Err("DeepSeek 引擎包长度与签名 feed 不符".into());
                }
                return Ok(archive);
            }
            Err(error) => {
                cancelled(state, id)?;
                processes::log(
                    &state.logs,
                    id,
                    "warn",
                    format!(
                        "{}下载 DeepSeek 引擎未完成：{error}",
                        github_source::label(via)
                    ),
                );
                failures.push(format!("{}：{error}", github_source::label(via)));
            }
        }
    }
    Err(format!("没能下载 DeepSeek 引擎包。{}", failures.join("；")))
}

/// Make sure the runtime at `root` has the newest DeepSeek engine the signed feed offers for
/// this computer; returns its program. Runs inside a tracked task (`id`): progress goes to its
/// log and cancelling the task stops the download (the partial file is kept for a retry).
pub async fn prepare(state: &RuntimeState, id: &str, root: &Path) -> Result<PathBuf, String> {
    let platform = engine_package::this_release_install_platform()
        .ok_or("DeepSeek-V4.1 引擎只提供 Windows x64 和 Linux x86_64 版本")?;
    let dir = root.join(DIR);
    say(
        state,
        id,
        "检查 DeepSeek 引擎（独立引擎包，不影响 Strata 引擎）…",
    );
    let mut info = super::update_info(state, false).await;
    if info
        .as_ref()
        .map_or(true, |info| info.dsv41_assets.is_empty())
    {
        info = super::update_info(state, true).await;
    }
    let installed = find(&dir, platform);
    let info = match info {
        Ok(info) if info.error.is_none() || !info.dsv41_assets.is_empty() => info,
        result => {
            // Offline: a package that is already installed (checked when installed) still runs.
            if let Some((version, exe)) = installed {
                say(
                    state,
                    id,
                    format!("无法读取更新信息，继续使用已安装的 DeepSeek 引擎 {version}"),
                );
                return Ok(exe);
            }
            return Err(match result {
                Ok(info) => info.error.unwrap_or_default(),
                Err(error) => error,
            });
        }
    };
    let probe = gpu_select::probe_host();
    let (asset, reason) = match select(&info.dsv41_assets, &probe) {
        Ok(chosen) => chosen,
        Err(error) => {
            if let Some((version, exe)) = installed {
                say(
                    state,
                    id,
                    format!("{error}；继续使用已安装的 DeepSeek 引擎 {version}"),
                );
                return Ok(exe);
            }
            return Err(error);
        }
    };
    let wanted = asset.engine_version.clone().unwrap_or_default();
    if let Some((version, exe)) = &installed {
        if version_at_least(version, &wanted) {
            say(
                state,
                id,
                format!("DeepSeek 引擎 {version} 已是最新：{}", exe.display()),
            );
            return Ok(exe.clone());
        }
    }
    say(
        state,
        id,
        format!(
            "{reason}；下载 DeepSeek 引擎 {wanted}（{} MB）…",
            asset.size / 1_000_000
        ),
    );
    let archive = download(state, id, &asset).await?;
    let check = || cancelled(state, id);
    let verify = |stage: &Path, files: &[String]| {
        engine_package::verify_extracted(stage, files, &asset, platform, &check)
    };
    let (exe, problem) = install_archive(
        &dir,
        &archive,
        &asset,
        platform,
        &verify,
        &|exe| test_start(exe),
        &check,
    )?;
    if let Some(problem) = problem {
        processes::log(
            &state.logs,
            id,
            "warn",
            format!("{problem}；继续使用旧版 DeepSeek 引擎：{}", exe.display()),
        );
    } else {
        say(
            state,
            id,
            format!(
                "DeepSeek 引擎 {wanted} 已校验（签名清单与每个文件）并安装：{}",
                exe.display()
            ),
        );
    }
    Ok(exe)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::cell::Cell;

    const LINUX: &str = "linux-x86_64";
    const MANIFEST: &[u8] = br#"{"id":"strata-engine","entrypoint":"strata-dsv41"}"#;

    fn asset(version: &str, backend: &str, variant: &str) -> RuntimeReleaseAsset {
        let name = format!("strata-dsv41-{version}-{LINUX}-{backend}-{variant}.tar.gz");
        RuntimeReleaseAsset {
            url: format!("https://github.com/Niko1221/Strata/releases/download/v0.2.6/{name}"),
            name,
            size: 1,
            sha256: "0".repeat(64),
            variant: if backend == "hip" {
                "hip".into()
            } else {
                variant.into()
            },
            engine_version: Some(version.into()),
            manifest_sha256: Some("1".repeat(64)),
            installed_bytes: Some(1024 * 1024),
            archs: if backend == "hip" {
                vec!["gfx1200".into(), "gfx1201".into()]
            } else {
                vec!["sm_86".into(), "sm_120".into(), "compute_120".into()]
            },
            nvidia_min_driver: (backend == "cuda").then(|| "580.65".into()),
            match_reason: None,
        }
    }

    fn package(dir: &Path, name: &str, files: &[(&str, &[u8])]) -> PathBuf {
        let path = dir.join(name);
        let mut builder = tar::Builder::new(GzEncoder::new(
            fs::File::create(&path).unwrap(),
            Compression::fast(),
        ));
        for (name, data) in files {
            let mut header = tar::Header::new_gnu();
            // Raw name bytes so hostile names reach the extractor unchanged.
            let bytes = name.as_bytes();
            header.as_gnu_mut().unwrap().name[..bytes.len()].copy_from_slice(bytes);
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_mtime(0);
            header.set_cksum();
            builder.append(&header, *data).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap();
        path
    }

    fn good(dir: &Path, tag: &[u8]) -> PathBuf {
        package(
            dir,
            &format!("p-{}.tar.gz", uuid::Uuid::new_v4()),
            &[
                ("strata-dsv41", tag),
                ("BUILD.json", br#"{"version":"0.1.51","dsv41":true}"#),
                ("libggml-hip.so", b"lib"),
                (engine_package::MANIFEST_NAME, MANIFEST),
            ],
        )
    }

    fn ok_verify(_: &Path, _: &[String]) -> Result<(), String> {
        Ok(())
    }
    fn ok_check() -> Result<(), String> {
        Ok(())
    }

    #[test]
    fn folder_and_program_names_follow_upstream() {
        assert_eq!(exe_name("windows-x86_64"), "strata-dsv41.exe");
        assert_eq!(exe_name(LINUX), "strata-dsv41");
        assert_eq!(
            folder_name(&asset("0.1.51", "hip", "rx9070")).as_deref(),
            Some("0.1.51-linux-x86_64-hip-rx9070")
        );
        assert_eq!(
            folder_name(&asset("0.1.51", "cuda", "cuda13")).as_deref(),
            Some("0.1.51-linux-x86_64-cuda-cuda13")
        );
        let mut engine = asset("0.1.51", "cuda", "cuda13");
        engine.name = "strata-engine-0.1.51-linux-x86_64-cuda-cuda13.tar.gz".into();
        assert_eq!(folder_name(&engine), None);
        assert!(version_at_least("0.1.51", "0.1.50"));
        assert!(version_at_least("0.1.50", "0.1.50"));
        assert!(!version_at_least("0.1.49", "0.1.50"));
        assert!(!version_at_least("garbage", "0.1.50"));
    }

    #[test]
    fn find_picks_the_newest_complete_package() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        for (folder, with_exe) in [
            ("0.1.50-linux-x86_64-cuda-cuda13", true),
            ("0.1.52-linux-x86_64-cuda-cuda13", false),
            ("0.1.51-linux-x86_64-cuda-cuda13", true),
            (".staging-x", true),
        ] {
            fs::create_dir_all(dir.join(folder)).unwrap();
            if with_exe {
                fs::write(dir.join(folder).join("strata-dsv41"), b"x").unwrap();
            }
        }
        let (version, exe) = find(dir, LINUX).unwrap();
        assert_eq!(version, "0.1.51");
        assert!(exe.ends_with("0.1.51-linux-x86_64-cuda-cuda13/strata-dsv41"));
        assert!(find(&dir.join("missing"), LINUX).is_none());
    }

    #[test]
    fn install_stages_verifies_then_replaces_and_prunes_older_versions() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join(DIR);
        let first = asset("0.1.50", "hip", "rx9070");
        let probes = Cell::new(0);
        let probe = |_: &Path| {
            probes.set(probes.get() + 1);
            Ok("strata-dsv41 0.1.51".to_owned())
        };
        let (exe, problem) = install_archive(
            &dir,
            &good(temp.path(), b"v50"),
            &first,
            LINUX,
            &ok_verify,
            &probe,
            &ok_check,
        )
        .unwrap();
        assert!(problem.is_none());
        assert_eq!(
            probes.get(),
            0,
            "a first install is started by setup's own smoke test"
        );
        assert!(exe.ends_with("0.1.50-linux-x86_64-hip-rx9070/strata-dsv41"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&exe).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
        let second = asset("0.1.51", "hip", "rx9070");
        let (exe, problem) = install_archive(
            &dir,
            &good(temp.path(), b"v51"),
            &second,
            LINUX,
            &ok_verify,
            &probe,
            &ok_check,
        )
        .unwrap();
        assert!(problem.is_none());
        assert_eq!(probes.get(), 1);
        assert_eq!(fs::read(&exe).unwrap(), b"v51");
        let left: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, ["0.1.51-linux-x86_64-hip-rx9070"]);
        // A repair of the same version replaces it in place.
        let (exe, _) = install_archive(
            &dir,
            &good(temp.path(), b"again"),
            &second,
            LINUX,
            &ok_verify,
            &probe,
            &ok_check,
        )
        .unwrap();
        assert_eq!(fs::read(&exe).unwrap(), b"again");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn a_new_version_that_does_not_start_leaves_the_old_one_in_use() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join(DIR);
        let never = |_: &Path| -> Result<String, String> { panic!("not probed") };
        let (old, _) = install_archive(
            &dir,
            &good(temp.path(), b"old"),
            &asset("0.1.50", "cuda", "cuda13"),
            LINUX,
            &ok_verify,
            &never,
            &ok_check,
        )
        .unwrap();
        let broken = |_: &Path| Err("新的 DeepSeek 引擎无法启动".to_owned());
        let (exe, problem) = install_archive(
            &dir,
            &good(temp.path(), b"new"),
            &asset("0.1.51", "cuda", "cuda13"),
            LINUX,
            &ok_verify,
            &broken,
            &ok_check,
        )
        .unwrap();
        assert_eq!(exe, old);
        assert!(problem.unwrap().contains("无法启动"));
        assert_eq!(fs::read(&exe).unwrap(), b"old");
        assert_eq!(find(&dir, LINUX).unwrap().0, "0.1.50");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn bad_packages_change_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join(DIR);
        let never = |_: &Path| -> Result<String, String> { panic!("not probed") };
        let target = asset("0.1.51", "cuda", "cuda13");
        let cases: Vec<(PathBuf, &str)> = vec![
            (
                package(
                    temp.path(),
                    "a.tar.gz",
                    &[
                        ("strata-dsv41", b"x"),
                        (engine_package::MANIFEST_NAME, MANIFEST),
                        ("evil.sh", b"rm -rf /"),
                    ],
                ),
                "未识别",
            ),
            (
                package(
                    temp.path(),
                    "b.tar.gz",
                    &[
                        ("strata", b"x"),
                        ("BUILD.json", b"{}"),
                        (engine_package::MANIFEST_NAME, MANIFEST),
                    ],
                ),
                "缺少",
            ),
            (
                package(
                    temp.path(),
                    "c.tar.gz",
                    &[
                        ("strata-dsv41", b"x"),
                        (engine_package::MANIFEST_NAME, br#"{"entrypoint":"strata"}"#),
                    ],
                ),
                "入口程序",
            ),
            (
                package(
                    temp.path(),
                    "d.tar.gz",
                    &[
                        ("../strata-dsv41", b"x"),
                        (engine_package::MANIFEST_NAME, MANIFEST),
                    ],
                ),
                "",
            ),
        ];
        for (archive, why) in cases {
            let error = install_archive(
                &dir, &archive, &target, LINUX, &ok_verify, &never, &ok_check,
            )
            .unwrap_err();
            assert!(error.contains(why), "{error}");
            assert_eq!(fs::read_dir(&dir).unwrap().count(), 0, "{error}");
        }
        // The signed manifest check runs before anything is moved into place.
        let refuse = |_: &Path, _: &[String]| Err("引擎清单签名无效".to_owned());
        assert!(install_archive(
            &dir,
            &good(temp.path(), b"x"),
            &target,
            LINUX,
            &refuse,
            &never,
            &ok_check
        )
        .unwrap_err()
        .contains("签名"));
        // A package for another platform or an unsupported combination is refused.
        assert!(install_archive(
            &dir,
            &good(temp.path(), b"x"),
            &target,
            "windows-x86_64",
            &ok_verify,
            &never,
            &ok_check
        )
        .is_err());
        assert!(install_archive(
            &dir,
            &good(temp.path(), b"x"),
            &asset("0.1.51", "cuda", "cuda12"),
            LINUX,
            &ok_verify,
            &never,
            &ok_check
        )
        .is_err());
        // Cancelling the task stops before the package is moved into place.
        let cancelled = || Err("任务已取消".to_owned());
        assert!(install_archive(
            &dir,
            &good(temp.path(), b"x"),
            &target,
            LINUX,
            &ok_verify,
            &never,
            &cancelled
        )
        .is_err());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    }

    #[test]
    fn windows_ryzen_ai_max_gets_the_hip_rdna3_package() {
        let windows = |backend: &str, variant: &str, archs: &[&str]| {
            let name = format!("strata-dsv41-0.1.52-windows-x86_64-{backend}-{variant}.tar.gz");
            RuntimeReleaseAsset {
                url: format!("https://github.com/Niko1221/Strata/releases/download/v0.2.7/{name}"),
                name,
                size: 1,
                sha256: "0".repeat(64),
                variant: if backend == "hip" {
                    format!("hip-{variant}")
                } else {
                    variant.into()
                },
                engine_version: Some("0.1.52".into()),
                manifest_sha256: Some("1".repeat(64)),
                installed_bytes: Some(1024 * 1024),
                archs: archs.iter().map(|a| a.to_string()).collect(),
                nvidia_min_driver: (backend == "cuda").then(|| "580.65".into()),
                match_reason: None,
            }
        };
        let assets = vec![
            windows(
                "cuda",
                "cuda13",
                &["sm_86", "sm_89", "sm_120", "compute_120"],
            ),
            windows("hip", "rdna3", &["gfx1151"]),
        ];
        let halo = gpu_select::GpuProbe {
            amd_gfx: vec!["gfx1151".into()],
            ..Default::default()
        };
        let (chosen, _) = select(&assets, &halo).unwrap();
        assert_eq!(chosen.variant, "hip-rdna3");
        assert_eq!(
            folder_name(&chosen).as_deref(),
            Some("0.1.52-windows-x86_64-hip-rdna3")
        );
        let nvidia = gpu_select::GpuProbe {
            nvidia_driver: Some("580.82".into()),
            nvidia_caps: vec![(12, 0)],
            amd_gfx: vec![],
        };
        assert_eq!(select(&assets, &nvidia).unwrap().0.variant, "cuda13");
        // A discrete RX 7900 (gfx1100) is not what this package was built for.
        let rx7900 = gpu_select::GpuProbe {
            amd_gfx: vec!["gfx1100".into()],
            ..Default::default()
        };
        assert!(select(&assets, &rx7900).unwrap_err().contains("gfx1151"));
    }

    #[test]
    fn lib_dirs_are_the_package_folder_and_its_build_json_folders() {
        let temp = tempfile::tempdir().unwrap();
        let package = temp.path().join("0.1.52-windows-x86_64-hip-rdna3");
        fs::create_dir_all(package.join("rocm/bin")).unwrap();
        fs::create_dir_all(package.join("tuning")).unwrap();
        let exe = package.join("strata-dsv41.exe");
        // Without BUILD.json (the CUDA packages keep everything beside the program): the folder alone.
        assert_eq!(lib_dirs(&exe), std::slice::from_ref(&package));
        // The real 0.2.7 BUILD.json names rocm/bin; absolute, escaping, empty, missing and
        // non-string entries are ignored, and a folder is listed once.
        fs::write(
            package.join("BUILD.json"),
            "\u{feff}{\"lib_dirs\":[\"rocm/bin\",\"../outside\",\"/abs\",\"\",\"missing\",7,\"rocm/bin\"],\"backend\":\"hip\"}",
        )
        .unwrap();
        assert_eq!(lib_dirs(&exe), [package.clone(), package.join("rocm/bin")]);
        let (key, value) =
            start_env(&exe, Some(std::env::join_paths(["/usr/lib"]).unwrap())).unwrap();
        assert_eq!(key, LIB_VAR);
        let parts: Vec<_> = std::env::split_paths(&value).collect();
        assert_eq!(
            parts,
            [
                package.clone(),
                package.join("rocm/bin"),
                PathBuf::from("/usr/lib")
            ]
        );
        let (_, alone) = start_env(&exe, None).unwrap();
        assert_eq!(std::env::split_paths(&alone).count(), 2);
        // A malformed BUILD.json falls back to the folder alone.
        fs::write(package.join("BUILD.json"), "{not json").unwrap();
        assert_eq!(lib_dirs(&exe), [package]);
    }

    #[cfg(unix)]
    #[test]
    fn the_start_check_runs_with_the_package_libraries_on_the_path() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let package = temp.path().join("0.1.52-linux-x86_64-hip-rx9070");
        fs::create_dir_all(package.join("rocm/lib")).unwrap();
        fs::write(package.join("BUILD.json"), br#"{"lib_dirs":["rocm/lib"]}"#).unwrap();
        let exe = package.join("strata-dsv41");
        // Like strata-dsv41.exe importing hipblas.dll from rocm/bin: it only starts when its
        // library folder is on the path (and it runs from its own folder).
        fs::write(
            &exe,
            format!(
                "#!/bin/sh\ncase \":$LD_LIBRARY_PATH:\" in *\":{}:\"*) ;; *) echo missing >&2; exit 53;; esac\n[ \"$(pwd -P)\" = \"$(cd \"$(dirname \"$0\")\" && pwd -P)\" ] || exit 54\necho \"strata-dsv41 0.1.52\"\n",
                package.join("rocm/lib").display()
            ),
        )
        .unwrap();
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(test_start(&exe).unwrap(), "strata-dsv41 0.1.52");
        // Without the folder in BUILD.json the same program does not start.
        fs::write(package.join("BUILD.json"), b"{}").unwrap();
        assert!(test_start(&exe).is_err());
    }

    #[test]
    fn the_gpu_decides_which_package() {
        let assets = vec![
            asset("0.1.51", "cuda", "cuda13"),
            asset("0.1.51", "hip", "rx9070"),
        ];
        let nvidia = gpu_select::GpuProbe {
            nvidia_driver: Some("580.82".into()),
            nvidia_caps: vec![(8, 6)],
            amd_gfx: vec![],
        };
        assert_eq!(select(&assets, &nvidia).unwrap().0.variant, "cuda13");
        let blackwell = gpu_select::GpuProbe {
            nvidia_caps: vec![(12, 0)],
            ..nvidia.clone()
        };
        assert_eq!(select(&assets, &blackwell).unwrap().0.variant, "cuda13");
        let old_driver = gpu_select::GpuProbe {
            nvidia_driver: Some("570.10".into()),
            ..nvidia.clone()
        };
        assert!(select(&assets, &old_driver).unwrap_err().contains("580.65"));
        let rx9070 = gpu_select::GpuProbe {
            amd_gfx: vec!["gfx1201".into()],
            ..Default::default()
        };
        assert_eq!(select(&assets, &rx9070).unwrap().0.variant, "hip");
        let rx7900 = gpu_select::GpuProbe {
            amd_gfx: vec!["gfx1100".into()],
            ..Default::default()
        };
        assert!(select(&assets, &rx7900).is_err());
        assert!(select(&[], &nvidia).unwrap_err().contains("0.2.5"));
    }

    #[test]
    fn the_dsv41_folder_is_never_read_as_the_strata_engine() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let package = root.join(DIR).join("0.1.51-linux-x86_64-cuda-cuda13");
        fs::create_dir_all(&package).unwrap();
        fs::write(
            package.join("BUILD.json"),
            br#"{"version":"0.1.51","dsv41":true}"#,
        )
        .unwrap();
        fs::write(package.join("strata-dsv41"), b"x").unwrap();
        // Even a BUILD.json directly in engine-dsv41/ is not the runtime's engine.
        fs::write(root.join(DIR).join("BUILD.json"), br#"{"version":"9.9.9"}"#).unwrap();
        assert_eq!(crate::discovery::runtime_version(root, None), None);
        fs::create_dir_all(root.join("engine")).unwrap();
        fs::write(root.join("engine/BUILD.json"), br#"{"version":"0.1.48"}"#).unwrap();
        assert_eq!(
            crate::discovery::runtime_version(root, None).as_deref(),
            Some("0.1.48")
        );
        assert!(crate::discovery::strata_engine_dir_name("engine"));
        assert!(crate::discovery::strata_engine_dir_name("engine-cuda12"));
        assert!(!crate::discovery::strata_engine_dir_name("engine-dsv41"));
        assert!(!crate::discovery::strata_engine_dir_name("Engine-DSV41"));
    }
}
