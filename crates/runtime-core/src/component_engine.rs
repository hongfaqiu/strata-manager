//! Upstream Strata 0.2+ run configs written by the desktop app or the Terminal bundle
//! (setup.py in CONTROL mode, `strata_cli/launch/adopt.py`) name their engine as
//! `"exe": "component:strata-engine"` instead of a path. `serve/server.py` then asks the
//! per-user component folder for the engine package that fits this PC when it starts
//! (`strata_control/engine_component.py::expand`). The engine never lives in the Strata
//! folder or beside the config in that layout, so joining `exe` to `cwd` always misses.
//!
//! Layout (`components_dir()`):
//! `<components>/engine/<version>-<platform>-<backend>/engine-component.json` + the entrypoint.

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

pub const REFERENCE_PREFIX: &str = "component:";
const COMPONENT_ID: &str = "strata-engine";
const MANIFEST: &str = "engine-component.json";
const MAX_PACKAGES: usize = 64;
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;

pub fn is_reference(exe: &str) -> bool {
    exe.starts_with(REFERENCE_PREFIX)
}

/// The per-user component folder, as upstream `components_dir()` computes it:
/// `STRATA_COMPONENTS_DIR`, else `%LOCALAPPDATA%\Strata\components` on Windows,
/// else `$XDG_DATA_HOME/strata/components` (default `~/.local/share`).
pub fn components_dir() -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(dir) = TEST_COMPONENTS_DIR.with(|dir| dir.borrow().clone()) {
        return Some(dir);
    }
    if let Some(dir) = std::env::var_os("STRATA_COMPONENTS_DIR").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    if cfg!(windows) {
        let local = std::env::var_os("LOCALAPPDATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| home.map(|h| h.join("AppData").join("Local")))?;
        Some(local.join("Strata").join("components"))
    } else {
        let data = std::env::var_os("XDG_DATA_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| home.map(|h| h.join(".local").join("share")))?;
        Some(data.join("strata").join("components"))
    }
}

#[cfg(test)]
thread_local! {
    static TEST_COMPONENTS_DIR: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// Tests point the component folder somewhere private without touching the process environment.
#[cfg(test)]
pub(crate) fn with_components_dir<R>(dir: &Path, run: impl FnOnce() -> R) -> R {
    TEST_COMPONENTS_DIR.with(|cell| *cell.borrow_mut() = Some(dir.to_owned()));
    let result = run();
    TEST_COMPONENTS_DIR.with(|cell| *cell.borrow_mut() = None);
    result
}

/// This machine as upstream's `os-arch` key (`targets.host_platform`).
pub fn host_platform() -> String {
    let os = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        other => other,
    };
    format!("{os}-{arch}")
}

/// One installed engine package that can be started on this platform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComponentEngine {
    pub exe: PathBuf,
    pub version: String,
    pub backend: String,
}

fn plain_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\0')
        && !path.starts_with(['/', '\\'])
        && !path.contains(':')
        && !path.split(['/', '\\']).any(|part| part == "..")
}

fn read_package(folder: &Path, platform: &str) -> Result<ComponentEngine, String> {
    let path = folder.join(MANIFEST);
    let meta = fs::symlink_metadata(&path).map_err(|_| format!("{MANIFEST} 缺失"))?;
    if !meta.is_file() || meta.len() > MAX_MANIFEST_BYTES {
        return Err(format!("{MANIFEST} 无效"));
    }
    let text = fs::read_to_string(&path).map_err(|_| format!("{MANIFEST} 无法读取"))?;
    let value: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|_| format!("{MANIFEST} 不是有效的 JSON"))?;
    if value["id"].as_str() != Some(COMPONENT_ID) {
        return Err(format!("{MANIFEST} 不是引擎组件"));
    }
    let field = |key: &str| {
        value[key]
            .as_str()
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| format!("{MANIFEST} 缺少 {key}"))
    };
    let version = field("version")?;
    let package_platform = field("platform")?;
    let backend = field("backend")?;
    let entrypoint = field("entrypoint")?;
    if package_platform != platform {
        return Err(format!(
            "{version} {package_platform}-{backend} 不是本机平台（{platform}）的引擎"
        ));
    }
    if !plain_relative(&entrypoint) {
        return Err(format!("{MANIFEST} 的 entrypoint 无效"));
    }
    let exe = folder.join(&entrypoint);
    if !exe.is_file() {
        return Err(format!(
            "{version} {package_platform}-{backend} 缺少引擎文件 {entrypoint}"
        ));
    }
    Ok(ComponentEngine {
        exe,
        version,
        backend,
    })
}

fn pinned_folder(components: &Path) -> Option<String> {
    let text = fs::read_to_string(components.join(".updates").join("state.json")).ok()?;
    let value: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    value["engine"]["pinned"]
        .as_str()
        .filter(|v| !v.is_empty() && !v.contains(['/', '\\']))
        .map(str::to_owned)
}

fn version_order(value: &str) -> Vec<u64> {
    value
        .split(['.', '-', '+'])
        .map(|part| part.parse().unwrap_or(0))
        .collect()
}

/// The engine a `component:strata-engine` reference names on this PC, or why none fits.
/// Like upstream it prefers a rollback pin, else the newest version; `backend` (the run
/// config's own `backend`, e.g. `hip`) narrows the choice. GPU detection and the full
/// SHA-256 check stay with upstream's server, which does them when it starts the engine.
pub fn resolve_in(
    components: &Path,
    reference: &str,
    backend: Option<&str>,
    platform: &str,
) -> Result<ComponentEngine, String> {
    let name = reference
        .strip_prefix(REFERENCE_PREFIX)
        .unwrap_or(reference);
    if !(name.is_empty() || name == COMPONENT_ID) {
        return Err(format!("运行配置引用了未知组件 {name}"));
    }
    let folder = components.join("engine");
    let Ok(entries) = fs::read_dir(&folder) else {
        return Err(format!("组件目录 {} 里没有引擎包", folder.display()));
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .map(|entry| entry.path())
        .filter(|path| path.is_dir() && !path.is_symlink())
        .collect();
    dirs.sort();
    dirs.truncate(MAX_PACKAGES);
    let mut usable = Vec::new();
    let mut reasons = Vec::new();
    for dir in &dirs {
        match read_package(dir, platform) {
            Ok(engine) if backend.is_some_and(|wanted| wanted != engine.backend) => {
                reasons.push(format!(
                    "{} 是 {} 引擎，配置要求 {}",
                    engine.version,
                    engine.backend,
                    backend.unwrap_or_default()
                ));
            }
            Ok(engine) => usable.push((dir.clone(), engine)),
            Err(reason) => reasons.push(reason),
        }
    }
    if let Some(pin) = pinned_folder(components) {
        if let Some((_, engine)) = usable
            .iter()
            .find(|(dir, _)| dir.file_name().is_some_and(|n| n.to_string_lossy() == pin))
        {
            return Ok(engine.clone());
        }
    }
    usable
        .into_iter()
        .map(|(_, engine)| engine)
        .max_by(|a, b| version_order(&a.version).cmp(&version_order(&b.version)))
        .ok_or_else(|| {
            if reasons.is_empty() {
                format!("组件目录 {} 里没有引擎包", folder.display())
            } else {
                format!("{}：{}", folder.display(), reasons.join("；"))
            }
        })
}

/// Where the engine Manager itself installed (`<root>/engine`, the signed Metal package on a Mac)
/// is exposed to upstream as a component folder: `<root>/components`.
pub const MANAGED_COMPONENTS_DIR: &str = "components";
const MANAGED_ENGINE_DIR: &str = "engine";
const MANAGED_MARKER: &str = ".strata-manager-metal.json";

/// The engine package Manager installed into `<root>/engine` and verified against the signed
/// manifest (its marker exists), when it fits this PC. The Mac has no per-user component folder
/// of its own: the prebuilt Metal engine lives here, so this is what `component:strata-engine`
/// means for a runtime Manager set up.
pub fn managed_package(root: &Path, platform: &str) -> Option<ComponentEngine> {
    let folder = root.join(MANAGED_ENGINE_DIR);
    if !folder.join(MANAGED_MARKER).is_file() {
        return None;
    }
    read_package(&folder, platform).ok()
}

/// Makes the managed engine visible the way upstream's `engine_component.scan` expects:
/// `<root>/components/engine/<version>-<platform>-<backend>` pointing at `<root>/engine`, and
/// returns `<root>/components` for `STRATA_COMPONENTS_DIR`. `None` when there is no managed
/// engine (nothing is created then). Links this function made earlier for another version are
/// replaced; anything else in the folder is left alone.
pub fn ensure_managed_view(root: &Path, platform: &str) -> Result<Option<PathBuf>, String> {
    let Some(engine) = managed_package(root, platform) else {
        return Ok(None);
    };
    let components = root.join(MANAGED_COMPONENTS_DIR);
    let engines = components.join("engine");
    fs::create_dir_all(&engines)
        .map_err(|e| format!("无法创建组件目录 {}：{e}", engines.display()))?;
    let wanted = format!("{}-{platform}-{}", engine.version, engine.backend);
    let target = Path::new("..").join("..").join(MANAGED_ENGINE_DIR);
    let mut present = false;
    if let Ok(entries) = fs::read_dir(&engines) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_symlink() || !fs::read_link(&path).is_ok_and(|link| link == target) {
                continue;
            }
            if entry.file_name().to_string_lossy() == wanted {
                present = true;
            } else {
                // A stale link this function made for an earlier engine version.
                let _ = fs::remove_file(&path);
            }
        }
    }
    if present {
        return Ok(Some(components));
    }
    link_dir(&target, &engines.join(&wanted))
        .map_err(|e| format!("无法链接引擎到组件目录 {}：{e}", engines.display()))?;
    Ok(Some(components))
}

#[cfg(unix)]
fn link_dir(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(not(unix))]
fn link_dir(_target: &Path, _link: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "this platform has no managed component view",
    ))
}

/// `resolve_in` against this user's component folder, after the engine Manager installed beside
/// the run config (`config.cwd`/engine).
pub fn resolve(reference: &str, config: &Value) -> Result<ComponentEngine, String> {
    resolve_for(reference, config, &host_platform())
}

fn resolve_for(reference: &str, config: &Value, platform: &str) -> Result<ComponentEngine, String> {
    let backend = config.get("backend").and_then(Value::as_str);
    if let Some(root) = config
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|cwd| !cwd.is_empty())
    {
        if let Some(engine) = managed_package(Path::new(root), platform)
            .filter(|engine| backend.is_none_or(|wanted| wanted == engine.backend))
        {
            return Ok(engine);
        }
    }
    let components = components_dir().ok_or("无法确定 Strata 组件目录")?;
    resolve_in(&components, reference, backend, platform)
}

/// The engine path for a run config's `exe`: None when it is a plain path (the caller
/// joins it to `cwd` as before), the package's binary when it is a component reference.
pub fn expand(exe: &str, config: &Value) -> Option<Result<PathBuf, String>> {
    is_reference(exe).then(|| {
        resolve(exe, config)
            .map(|engine| engine.exe)
            .map_err(|why| missing_reason(&why))
    })
}

/// The plain sentence when a component reference finds no engine.
pub fn missing_reason(why: &str) -> String {
    format!(
        "配置使用 Strata 应用安装的引擎组件（component:strata-engine），但没找到本机可用的引擎包（{why}）；请打开 Strata 应用在设置里「更新引擎」，或运行 strata update 后重新扫描"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn package(components: &Path, folder: &str, manifest: Value, entry: Option<&str>) {
        let dir = components.join("engine").join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(MANIFEST), manifest.to_string()).unwrap();
        if let Some(entry) = entry {
            fs::write(dir.join(entry), b"engine").unwrap();
        }
    }

    fn manifest(version: &str, platform: &str, backend: &str) -> Value {
        json!({"schema_version": 2, "id": "strata-engine", "name": "strata-engine", "version": version,
               "platform": platform, "backend": backend, "entrypoint": "strata.exe", "build_id": "x", "files": []})
    }

    #[test]
    fn finds_the_newest_engine_package_for_this_platform() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("AppData/Local/Strata/components");
        package(
            &root,
            "0.1.44-windows-x86_64-cuda",
            manifest("0.1.44", "windows-x86_64", "cuda"),
            Some("strata.exe"),
        );
        package(
            &root,
            "0.1.45-windows-x86_64-cuda",
            manifest("0.1.45", "windows-x86_64", "cuda"),
            Some("strata.exe"),
        );
        package(
            &root,
            "0.1.46-linux-x86_64-cuda",
            manifest("0.1.46", "linux-x86_64", "cuda"),
            Some("strata.exe"),
        );
        let engine = resolve_in(&root, "component:strata-engine", None, "windows-x86_64").unwrap();
        assert_eq!(engine.version, "0.1.45");
        assert_eq!(
            engine.exe,
            root.join("engine/0.1.45-windows-x86_64-cuda/strata.exe")
        );
    }

    #[test]
    fn honours_the_rollback_pin_and_the_configured_backend() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        package(
            root,
            "0.1.44-windows-x86_64-cuda",
            manifest("0.1.44", "windows-x86_64", "cuda"),
            Some("strata.exe"),
        );
        package(
            root,
            "0.1.45-windows-x86_64-cuda",
            manifest("0.1.45", "windows-x86_64", "cuda"),
            Some("strata.exe"),
        );
        package(
            root,
            "0.1.45-windows-x86_64-hip",
            manifest("0.1.45", "windows-x86_64", "hip"),
            Some("strata.exe"),
        );
        let hip = resolve_in(
            root,
            "component:strata-engine",
            Some("hip"),
            "windows-x86_64",
        )
        .unwrap();
        assert_eq!(hip.backend, "hip");
        fs::create_dir_all(root.join(".updates")).unwrap();
        fs::write(
            root.join(".updates/state.json"),
            json!({"engine": {"pinned": "0.1.44-windows-x86_64-cuda"}}).to_string(),
        )
        .unwrap();
        let pinned = resolve_in(root, "component:", None, "windows-x86_64").unwrap();
        assert_eq!(pinned.version, "0.1.44");
    }

    #[test]
    fn says_why_no_package_fits() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let empty =
            resolve_in(root, "component:strata-engine", None, "windows-x86_64").unwrap_err();
        assert!(empty.contains("没有引擎包"), "{empty}");
        package(
            root,
            "0.1.45-windows-x86_64-cuda",
            manifest("0.1.45", "windows-x86_64", "cuda"),
            None,
        );
        let missing =
            resolve_in(root, "component:strata-engine", None, "windows-x86_64").unwrap_err();
        assert!(missing.contains("缺少引擎文件 strata.exe"), "{missing}");
        let mut escape = manifest("0.1.46", "windows-x86_64", "cuda");
        escape["entrypoint"] = json!("../strata.exe");
        package(root, "0.1.46-windows-x86_64-cuda", escape, None);
        assert!(resolve_in(root, "component:strata-engine", None, "windows-x86_64").is_err());
        assert!(resolve_in(root, "component:other", None, "windows-x86_64")
            .unwrap_err()
            .contains("未知组件"));
    }
    fn managed_engine(root: &Path, version: &str, marker: bool) {
        let dir = root.join("engine");
        fs::create_dir_all(&dir).unwrap();
        let mut manifest = manifest(version, "macos-arm64", "metal");
        manifest["entrypoint"] = json!("strata");
        fs::write(dir.join(MANIFEST), manifest.to_string()).unwrap();
        fs::write(dir.join("strata"), b"engine").unwrap();
        if marker {
            fs::write(dir.join(MANAGED_MARKER), "{}").unwrap();
        }
    }

    #[test]
    fn the_engine_manager_installed_is_what_the_reference_means() {
        // The Mac user's report: setup.py in CONTROL mode wrote `component:strata-engine`, but the
        // prebuilt engine is in <root>/engine and there is no per-user component folder.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("strata");
        managed_engine(&root, "0.1.47", true);
        let empty = temp.path().join("nothing-here");
        let config = json!({"cwd": root.to_string_lossy(), "backend": "metal"});
        let engine = with_components_dir(&empty, || {
            let found = resolve_for("component:strata-engine", &config, "macos-arm64").unwrap();
            // A pinned backend that does not match falls through to the component folder.
            assert!(resolve_for(
                "component:strata-engine",
                &json!({"cwd": root.to_string_lossy(), "backend": "cuda"}),
                "macos-arm64"
            )
            .is_err());
            found
        });
        assert_eq!(engine.exe, root.join("engine").join("strata"));
        assert_eq!(engine.version, "0.1.47");
        assert_eq!(engine.backend, "metal");
        // Without Manager's marker (a hand-made engine folder) nothing is assumed.
        let other = temp.path().join("other");
        managed_engine(&other, "0.1.47", false);
        assert!(managed_package(&other, "macos-arm64").is_none());
        // And a package for another platform never counts.
        assert!(managed_package(&root, "windows-x86_64").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn the_managed_view_links_the_engine_for_upstreams_scan_and_follows_upgrades() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        assert_eq!(ensure_managed_view(root, "macos-arm64").unwrap(), None);
        assert!(!root.join(MANAGED_COMPONENTS_DIR).exists());
        managed_engine(root, "0.1.47", true);
        let components = ensure_managed_view(root, "macos-arm64").unwrap().unwrap();
        assert_eq!(components, root.join("components"));
        let link = components.join("engine/0.1.47-macos-arm64-metal");
        assert!(link.is_symlink());
        // Upstream's scan reads the manifest through the link.
        assert!(link.join(MANIFEST).is_file());
        assert!(link.join("strata").is_file());
        // A second call keeps it; a newer engine replaces only the link made for the old one.
        ensure_managed_view(root, "macos-arm64").unwrap();
        fs::write(components.join("engine/notes.txt"), "mine").unwrap();
        managed_engine(root, "0.1.48", true);
        ensure_managed_view(root, "macos-arm64").unwrap();
        assert!(!link.is_symlink());
        assert!(components
            .join("engine/0.1.48-macos-arm64-metal")
            .is_symlink());
        assert!(components.join("engine/notes.txt").is_file());
    }
}
