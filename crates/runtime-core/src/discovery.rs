//! Bounded, local-only installation discovery and non-destructive import.
//!
//! A candidate is a presentation record, never a permission to execute its paths.
//! Import re-reads every path and config. The user's repository and model assets
//! remain in place; only the application's config and shared-settings are copied.
use crate::{external, network, storage, types::ServiceProfile};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener},
    path::{Path, PathBuf},
};

const MAX_DIRECTORIES: usize = 32;
const MAX_CONFIGS: usize = 256;
const MAX_CONFIG_BYTES: u64 = 4 * 1024 * 1024;
const MAX_RUNTIME_CHILDREN: usize = 64;
const MAX_RUNTIME_ENTRIES: usize = 128;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCandidate {
    pub id: String,
    pub name: String,
    pub install_dir: String,
    pub python_path: String,
    pub config_path: String,
    pub model_path: String,
    pub model_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_group_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_modified_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_version: Option<String>,
    /// Strata release (what users install and see); `runtime_version` is the engine build.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub availability: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedImport {
    pub profile: ServiceProfile,
    pub original_profile: ServiceProfile,
    pub original_config_path: String,
    pub detected_running: bool,
}

/// Runtime detection is separate from model/config readiness: a missing model
/// in an old JSON file never means that the Strata installation is absent.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedRuntime {
    pub install_dir: String,
    pub python_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_version: Option<String>,
    /// Strata release (what users install and see); `runtime_version` is the engine build.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_revision: Option<String>,
    pub readiness: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub profile: ServiceProfile,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportManifest {
    schema_version: u32,
    candidate_id: String,
    install_dir: String,
    original_config_path: String,
}

#[derive(Clone, Debug)]
struct ProcessHint {
    config: PathBuf,
    python: PathBuf,
    port: Option<u16>,
    host: Option<String>,
    /// Filled by the process census; command-line parsing alone cannot know it.
    pid: Option<u32>,
    image: Option<String>,
}

impl ProcessHint {
    fn observed(mut self, pid: u32, image: Option<String>) -> Self {
        self.pid = Some(pid);
        self.image = image;
        self
    }
}

struct InspectedConfig {
    value: Value,
    candidate: LocalCandidate,
    profile: ServiceProfile,
    fatal_reasons: Vec<String>,
}

#[derive(Default)]
struct PythonCache {
    probes: HashMap<String, bool>,
    fallback: Option<Option<PathBuf>>,
    missing_modules: HashMap<String, Vec<String>>,
}

fn read_json(path: &Path) -> Result<Value, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| format!("无法读取配置: {e}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_CONFIG_BYTES
    {
        return Err("配置必须是小于 4 MiB 的普通 JSON 文件".into());
    }
    let bytes = fs::read(path).map_err(|e| format!("无法读取配置: {e}"))?;
    // Strata accepts Notepad's UTF-8 BOM. Keep the same behavior during import.
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    serde_json::from_slice(bytes).map_err(|e| format!("配置 JSON 无效: {e}"))
}

fn canonical_local(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("请选择本机磁盘上的绝对路径，不能使用网络共享".into());
    }
    #[cfg(windows)]
    fn disk_path(path: &Path) -> bool {
        matches!(path.components().next(), Some(std::path::Component::Prefix(prefix)) if matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)))
    }
    #[cfg(windows)]
    if !disk_path(path) {
        return Err("不能导入网络共享或设备路径".into());
    }
    let path = dunce::canonicalize(path).map_err(|e| format!("路径不可用: {e}"))?;
    #[cfg(windows)]
    if !disk_path(&path) {
        return Err("不能导入网络共享目录".into());
    }
    Ok(path)
}

fn path_key(path: &Path) -> String {
    let key = path.to_string_lossy().to_string();
    #[cfg(windows)]
    return key.to_ascii_lowercase();
    #[cfg(not(windows))]
    key
}

fn candidate_id(root: &Path, config: &Path) -> String {
    // A stable identifier, not a cryptographic content/integrity hash.
    let key = format!("{}\0{}", path_key(root), path_key(config));
    let hash = key.bytes().fold(0xcbf29ce484222325u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    });
    format!("local-{hash:016x}")
}

fn model_group_key(model: &Path, assets: &[PathBuf]) -> String {
    let mut paths: Vec<_> = assets
        .iter()
        .map(|path| path_key(&dunce::canonicalize(path).unwrap_or_else(|_| path.clone())))
        .collect();
    if paths.is_empty() {
        paths.push(path_key(
            &dunce::canonicalize(model).unwrap_or_else(|_| model.to_owned()),
        ));
    }
    paths.sort();
    paths.dedup();
    let hash = paths
        .join("\0")
        .bytes()
        .fold(0xcbf29ce484222325u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
        });
    format!("model-{hash:016x}")
}

fn config_modified_at(config: &Path) -> Option<u64> {
    fs::metadata(config)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis()
        .try_into()
        .ok()
}

// Display settings without copying credentials into the discovery/UI payload.
pub fn display_config(config: &Value) -> Value {
    fn redact(value: &mut Value) {
        match value {
            Value::Object(object) => {
                for (key, value) in object {
                    let key = key.to_ascii_lowercase();
                    if matches!(
                        key.as_str(),
                        "api_key"
                            | "apikey"
                            | "token"
                            | "password"
                            | "secret"
                            | "authorization"
                            | "credential"
                            | "credentials"
                    ) || key.ends_with("_key")
                        || key.ends_with("_token")
                        || key.ends_with("_secret")
                        || key.contains("password")
                        || key.contains("secret")
                    {
                        *value = Value::String("[已隐藏]".into());
                    } else {
                        redact(value);
                    }
                }
            }
            Value::Array(values) => {
                for value in values {
                    redact(value);
                }
            }
            _ => {}
        }
    }
    let mut config = config.clone();
    redact(&mut config);
    config
}

fn resolve(root: &Path, path: &str) -> PathBuf {
    let path = Path::new(path);
    if path.is_absolute() {
        path.to_owned()
    } else {
        root.join(path)
    }
}

fn config_cwd(root: &Path, value: &Value) -> PathBuf {
    value
        .get("cwd")
        .and_then(Value::as_str)
        .map(|v| resolve(root, v))
        .unwrap_or_else(|| root.to_owned())
}

fn option_value<'a>(args: &'a [Value], flag: &str) -> Result<Option<&'a str>, String> {
    let indices: Vec<_> = args
        .iter()
        .enumerate()
        .filter(|(_, value)| value.as_str() == Some(flag))
        .map(|(index, _)| index)
        .collect();
    if indices.len() > 1 {
        return Err(format!("{flag} 重复，无法确认实际模型配置"));
    }
    let Some(index) = indices.first() else {
        return Ok(None);
    };
    args.get(index + 1)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty() && !v.starts_with("--"))
        .map(Some)
        .ok_or_else(|| format!("{flag} 缺少路径或值"))
}

fn first_model(args: &[Value]) -> Result<Option<&str>, String> {
    for flag in ["--native", "--model", "-m", "--pack"] {
        if let Some(value) = option_value(args, flag)? {
            return Ok(Some(value));
        }
    }
    Ok(None)
}

/// Official and common self-extracted engine folder names.
/// Prefer the run-config `exe` path for validity; these names are only fallbacks.
pub(crate) fn known_engine_dir_names() -> &'static [&'static str] {
    // `build-metal` is the upstream ./setup.sh layout on Apple Silicon (docs/MAC.md).
    &["engine", "engine-cuda12", "engine_cuda12", "build-metal"]
}

/// A Strata engine folder (`engine`, `engine-…`) of a runtime root; never the DeepSeek-V4.1
/// engine's own package folder (`engine-dsv41/`), whose engine is not the runtime's engine.
pub(crate) fn strata_engine_dir_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("engine") && lower != crate::runtime_upgrade::dsv41_engine::DIR
}

fn engine_build_json_candidates(root: &Path, exe: Option<&Path>) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut push = |path: PathBuf| {
        if !paths
            .iter()
            .any(|existing| path_key(existing) == path_key(&path))
        {
            paths.push(path);
        }
    };
    if let Some(parent) = exe.and_then(Path::parent) {
        push(parent.join("BUILD.json"));
    }
    for name in known_engine_dir_names() {
        push(root.join(name).join("BUILD.json"));
    }
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.take(MAX_DIRECTORIES).flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !strata_engine_dir_name(&name) {
                continue;
            }
            let path = entry.path();
            if path.is_dir() && !path.is_symlink() {
                push(path.join("BUILD.json"));
            }
        }
    }
    paths
}

pub(crate) fn runtime_version(root: &Path, exe: Option<&Path>) -> Option<String> {
    engine_build_json_candidates(root, exe)
        .into_iter()
        .find_map(|path| {
            read_json(&path)
                .ok()?
                .get("version")?
                .as_str()
                .map(str::to_owned)
        })
}

/// Manager's record of the release it installed or updated a folder to.
pub(crate) const RELEASE_MARKER: &str = ".strata-manager-release.json";
/// From 0.2.0 the release and engine numbers differ; before, they were the same.
const FIRST_SEPARATE_RELEASE: [u32; 3] = [0, 1, 45];

/// The Strata release of a runtime folder: Manager's release marker, else the
/// `PRODUCT_VERSION` upstream ships in `strata_cli` (0.2+), else, for runtimes
/// older than 0.1.45 whose release and engine numbers were the same, the engine.
pub(crate) fn release_version(root: &Path, engine: Option<&str>) -> Option<String> {
    use crate::runtime_upgrade::engine_package::{valid_version, version_key};
    let marker = read_json(&root.join(RELEASE_MARKER)).ok();
    if let Some(version) = marker
        .as_ref()
        .and_then(|value| value["version"].as_str())
        .map(|value| value.trim_start_matches('v'))
        .filter(|value| valid_version(value))
    {
        return Some(version.to_owned());
    }
    let cli = root.join("strata_cli/__init__.py");
    let product = fs::symlink_metadata(&cli)
        .ok()
        .filter(|meta| meta.is_file() && meta.len() <= 64 * 1024)
        .and_then(|_| fs::read_to_string(&cli).ok())
        .and_then(|text| product_version(&text));
    if product.is_some() {
        return product;
    }
    engine
        .filter(|engine| {
            version_key(engine)
                .is_some_and(|(numbers, _, _)| numbers < FIRST_SEPARATE_RELEASE.to_vec())
        })
        .map(str::to_owned)
}

fn product_version(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let value = line.trim().strip_prefix("PRODUCT_VERSION")?.trim_start();
        let value = value.strip_prefix('=')?.trim();
        let value = value.trim_matches(|c| c == '"' || c == '\'');
        crate::runtime_upgrade::engine_package::valid_version(value).then(|| value.to_owned())
    })
}

/// The engine package a `component:strata-engine` run config names (None: `exe` is a path).
fn configured_component(
    exe: &str,
    config: &Value,
) -> Option<Result<crate::component_engine::ComponentEngine, String>> {
    crate::component_engine::is_reference(exe)
        .then(|| crate::component_engine::resolve(exe, config))
}

/// Resolve the engine binary from a run-config `exe` field.
/// If that exact path is missing, try the same file name under known engine folders
/// (for example `engine_cuda12/` when the config still says `engine/`).
fn resolve_engine(cwd: &Path, exe: &str) -> PathBuf {
    let primary = resolve(cwd, exe);
    if primary.is_file() {
        return primary;
    }
    let path = Path::new(exe);
    let Some(file_name) = path.file_name() else {
        return primary;
    };
    // On Mac, configs may still say strata.exe while the Metal package ships `strata`.
    let alt_names: Vec<&std::ffi::OsStr> = {
        let raw = file_name.to_string_lossy();
        let mut names = vec![file_name];
        if raw.eq_ignore_ascii_case("strata.exe") {
            names.push(std::ffi::OsStr::new("strata"));
        } else if raw.eq_ignore_ascii_case("strata") {
            names.push(std::ffi::OsStr::new("strata.exe"));
        }
        names
    };
    for name in known_engine_dir_names() {
        for file in &alt_names {
            let candidate = cwd.join(name).join(file);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    if let Ok(entries) = fs::read_dir(cwd) {
        for entry in entries.take(MAX_DIRECTORIES).flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let lower = name.to_ascii_lowercase();
            if !(strata_engine_dir_name(&lower) || lower == "build-metal") {
                continue;
            }
            let dir = entry.path();
            if !dir.is_dir() || dir.is_symlink() {
                continue;
            }
            for file in &alt_names {
                let candidate = dir.join(file);
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }
    primary
}

/// An engine with the configured file name in one of the folder's engine
/// directories, used only to tell the user where the engine actually is.
pub(crate) fn engine_beside(root: &Path, configured: &Path) -> Option<PathBuf> {
    let name = configured.file_name()?.to_str()?;
    let found = resolve_engine(root, name);
    (found.is_file() && found != configured).then_some(found)
}

fn first_config_engine(root: &Path) -> Option<PathBuf> {
    for config in config_paths(root)
        .into_iter()
        .chain(strata_model_configs_in(root))
    {
        let Ok(value) = read_json(&config) else {
            continue;
        };
        let Some(exe) = value
            .get("exe")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
        else {
            continue;
        };
        let cwd = config_cwd(root, &value);
        let engine = match configured_component(exe, &value) {
            Some(Ok(component)) => component.exe,
            Some(Err(_)) => continue,
            None => resolve_engine(&cwd, exe),
        };
        if engine.is_file() {
            return Some(engine);
        }
    }
    None
}

/// Windows Python starts can exceed the generic three-second probe budget on a
/// cold machine (venv redirector, antivirus scans). A timed-out probe must not
/// silently switch to a different interpreter.
const PYTHON_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
const DEPENDENCY_CHECK_FAILED: &str = "依赖检测失败";

fn python_output(path: &Path, args: &[&str]) -> Option<String> {
    crate::output_with_timeout(&path.to_string_lossy(), args, PYTHON_PROBE_TIMEOUT)
}

fn python_probe(path: &Path, cache: &mut PythonCache) -> bool {
    let key = path_key(path);
    *cache.probes.entry(key).or_insert_with(|| {
        path.is_file()
            && python_output(
                path,
                &[
                    "-I",
                    "-S",
                    "-c",
                    "import sys;print('ready' if sys.version_info >= (3,10) else 'unsupported')",
                ],
            )
            .as_deref()
                == Some("ready")
    })
}

fn required_python_modules(root: &Path) -> Vec<&'static str> {
    let mut modules = Vec::new();
    if root.join("tools/strata_tokenizer.py").is_file() {
        modules.push("regex");
    }
    if root.join("serve/frontend.py").is_file() {
        modules.push("jinja2");
    }
    modules
}

fn missing_python_modules(root: &Path, python: &Path, cache: &mut PythonCache) -> Vec<String> {
    let modules = required_python_modules(root);
    if modules.is_empty() {
        return Vec::new();
    }
    let key = format!("{}::{:?}", path_key(python), modules);
    cache.missing_modules.entry(key).or_insert_with(|| {
        let code = format!("import importlib.util,json;print(json.dumps([n for n in {} if importlib.util.find_spec(n) is None]))", serde_json::to_string(&modules).unwrap_or_default());
        python_output(python, &["-I", "-c", &code]).and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok()).unwrap_or_else(|| vec![DEPENDENCY_CHECK_FAILED.into()])
    }).clone()
}

/// Modules `root` needs before discovery reports it "ready", probed with
/// `python` (same rule and probe as discovery). Installation uses this so a
/// prepared runtime is never handed back while discovery still says "repair".
pub(crate) fn missing_runtime_modules(root: &Path, python: &Path) -> Vec<String> {
    missing_python_modules(root, python, &mut PythonCache::default())
}

/// A Python path without resolving its final component. A Linux/macOS venv's
/// `bin/python` is a symlink to the base interpreter; resolving it would probe
/// the base interpreter and miss the venv's site-packages. The directory is
/// still canonicalized so network shares and device paths stay rejected.
fn python_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("请选择本机磁盘上的绝对路径，不能使用网络共享".into());
    }
    let name = path.file_name().ok_or("Python 路径无效")?;
    let parent = path.parent().ok_or("Python 路径无效")?;
    let path = canonical_local(parent)?.join(name);
    if !path.is_file() {
        return Err("Python 不存在".into());
    }
    Ok(path)
}

struct PythonChoice {
    path: PathBuf,
    missing: Vec<String>,
}

/// Choose the interpreter the configuration will run with. Candidates follow
/// the engine's own launch order (saved profile, Strata launcher scripts, the
/// install's venv, an observed process). The first candidate whose required
/// modules import wins; otherwise the first runnable one is reported with its
/// missing modules. A system Python is only a last resort and never hides an
/// install-local environment that is complete.
fn find_python(
    root: &Path,
    preferred: Option<&str>,
    hint: Option<&ProcessHint>,
    cache: &mut PythonCache,
) -> Option<PythonChoice> {
    // Same candidates and rule as the managed launch (crate::launcher_env, #78):
    // a folder with its own environment is never probed or run with the host
    // Python, even when its own interpreter misses a module.
    let own_env = crate::launcher_env::has_own_environment(root);
    let own: Vec<PathBuf> = crate::launcher_env::own_candidates(root)
        .into_iter()
        .map(|candidate| candidate.path)
        .collect();
    let belongs = |path: &Path| {
        own.iter().any(|own| path_key(own) == path_key(path))
            || path_key(path).starts_with(&format!(
                "{}{}",
                path_key(root),
                std::path::MAIN_SEPARATOR
            ))
    };
    let mut candidates = Vec::new();
    if let Some(path) = preferred.filter(|v| !v.is_empty()) {
        let path = PathBuf::from(path);
        if !own_env || belongs(&path) {
            candidates.push(path);
        }
    }
    candidates.extend(own.iter().cloned());
    if let Some(hint) = hint {
        if !own_env || belongs(&hint.python) {
            candidates.push(hint.python.clone());
        }
    }
    let mut seen = HashSet::new();
    let mut first: Option<PythonChoice> = None;
    for path in candidates {
        let Ok(path) = python_path(&path) else {
            continue;
        };
        if !seen.insert(path_key(&path)) || !python_probe(&path, cache) {
            continue;
        }
        let missing = missing_python_modules(root, &path, cache);
        if missing.is_empty() {
            return Some(PythonChoice { path, missing });
        }
        first.get_or_insert(PythonChoice { path, missing });
    }
    if own_env {
        return first;
    }
    if cache.fallback.is_none() {
        #[cfg(windows)]
        let programs = ["py", "python"];
        #[cfg(not(windows))]
        let programs = ["python3", "python"];
        let fallback = programs.into_iter().find_map(|program| {
            let text = crate::output_with_timeout(
                program,
                &["-I", "-S", "-c", "import sys;print(sys.executable)"],
                PYTHON_PROBE_TIMEOUT,
            )?;
            let path = canonical_local(Path::new(text.trim())).ok()?;
            python_probe(&path, cache).then_some(path)
        });
        cache.fallback = Some(fallback);
    }
    if let Some(path) = cache.fallback.clone().flatten() {
        if seen.insert(path_key(&path)) {
            let missing = missing_python_modules(root, &path, cache);
            if missing.is_empty() || first.is_none() {
                return Some(PythonChoice { path, missing });
            }
        }
    }
    first
}

fn missing_modules_reason(choice: &PythonChoice) -> Option<String> {
    if choice.missing.is_empty() {
        return None;
    }
    let python = choice.path.display();
    #[cfg(windows)]
    let update = "UPDATE.bat";
    #[cfg(not(windows))]
    let update = "./update.sh";
    if choice
        .missing
        .iter()
        .any(|name| name == DEPENDENCY_CHECK_FAILED)
    {
        return Some(format!(
            "Python 依赖检测失败或超时（{python}），请重新扫描；仍失败时在 Strata 目录运行 {update} 修复运行环境"
        ));
    }
    Some(format!(
        "Python 运行依赖缺失：{}（检测的 Python：{python}），请在 Strata 目录运行 {update} 修复运行环境",
        choice.missing.join(", ")
    ))
}

fn inspect_config(
    root: &Path,
    config: &Path,
    preferred_python: Option<&str>,
    hint: Option<&ProcessHint>,
    source: &str,
    cache: &mut PythonCache,
) -> Result<InspectedConfig, String> {
    let root = canonical_local(root)?;
    if !root.join("setup.py").is_file() || !root.join("serve/server.py").is_file() {
        return Err("不是可识别的 Strata 安装目录".into());
    }
    if config.is_symlink() {
        return Err("配置文件不能是符号链接".into());
    }
    let config = canonical_local(config)?;
    let value = read_json(&config)?;
    storage::validate(&value)?;
    let exe = value
        .get("exe")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or("配置没有引擎 exe")?;
    let args = value
        .get("args")
        .and_then(Value::as_array)
        .ok_or("配置没有引擎 args")?;
    let model = first_model(args)?.ok_or("配置没有可识别的本机模型路径")?;
    let cwd = config_cwd(&root, &value);
    let component = configured_component(exe, &value);
    let engine = match &component {
        Some(Ok(component)) => component.exe.clone(),
        _ => resolve_engine(&cwd, exe),
    };
    let model_path = resolve(&cwd, model);
    let python = find_python(&root, preferred_python, hint, cache);
    let mut fatal_reasons = Vec::new();
    if !cwd.is_dir() {
        fatal_reasons.push("配置工作目录不存在".into());
    }
    if let Some(Err(why)) = &component {
        // Upstream 0.2 app/Terminal configs name "component:strata-engine": the engine is a
        // package in the per-user component folder, never a file under `cwd`.
        fatal_reasons.push(crate::component_engine::missing_reason(why));
    } else if component.is_none() && !engine.is_file() {
        fatal_reasons.push("引擎文件不存在，请修复运行环境".into());
    } else if component.is_none() && !resolve(&cwd, exe).is_file() {
        // Upstream server.py starts exactly the configured exe; an engine found
        // elsewhere in the folder does not make this configuration startable (#78).
        #[cfg(windows)]
        let repair = "START-HERE.bat --setup";
        #[cfg(not(windows))]
        let repair = "./setup.sh --setup";
        fatal_reasons.push(format!(
            "配置里的引擎路径不存在（{}），目录里的引擎在 {}；Strata 按配置路径启动引擎，请运行 {repair} 修复配置",
            resolve(&cwd, exe).display(),
            engine.display()
        ));
    }
    if python.is_none() {
        fatal_reasons.push("没有可运行的本机 Python 3.10+ 环境".into());
    }
    if let Some(reason) = python.as_ref().and_then(missing_modules_reason) {
        fatal_reasons.push(reason);
    }
    let python = python.map(|choice| choice.path);
    if !model_path.exists() {
        fatal_reasons.push("模型文件不存在，请重新定位或下载".into());
    }
    let mut asset_paths = Vec::new();
    for flag in [
        "--native",
        "--model",
        "-m",
        "--ple-gguf",
        "--pack",
        "--mtp",
        "--expert-profile",
    ] {
        if let Some(path) = option_value(args, flag)? {
            let path = resolve(&cwd, path);
            if !path.exists() {
                fatal_reasons.push(format!("{flag} 指向的文件或目录不存在"));
            }
            if matches!(flag, "--native" | "--model" | "-m" | "--ple-gguf")
                && !asset_paths.contains(&path)
            {
                asset_paths.push(path);
            }
        }
    }
    if let Some(tokenizer) = value.get("tokenizer").and_then(Value::as_str) {
        for name in ["vocab.json", "merges.txt", "token_type.json"] {
            if !resolve(&cwd, tokenizer).join(name).is_file() {
                fatal_reasons.push(format!("模型 tokenizer 缺少 {name}，请重新准备模型"));
            }
        }
    } else {
        fatal_reasons.push("配置没有 tokenizer 路径，请重新准备模型".into());
    }
    if let Some(vision) = value.get("vision").and_then(Value::as_object) {
        for key in ["exe", "model", "mmproj"] {
            if let Some(path) = vision.get(key).and_then(Value::as_str) {
                if key == "exe" && crate::component_engine::is_reference(path) {
                    continue; // the same engine package the main `exe` check resolved
                }
                let path = resolve(&cwd, path);
                if !path.is_file() {
                    fatal_reasons.push(format!("视觉 {key} 文件不存在"));
                }
                if key != "exe" && !asset_paths.contains(&path) {
                    asset_paths.push(path);
                }
            }
        }
    }
    // A vision companion does not turn one set of language-model weights into
    // several models. Context/parallel/cache variants share this identity.
    let model_assets: Vec<_> = ["--native", "--model", "-m", "--ple-gguf"]
        .into_iter()
        .filter_map(|flag| option_value(args, flag).ok().flatten())
        .map(|path| resolve(&cwd, path))
        .collect();
    let model_bytes = if asset_paths.is_empty() {
        model_size(&model_path)
    } else {
        asset_paths.iter().try_fold(0u64, |sum, path| {
            sum.checked_add(fs::metadata(path).ok().filter(|m| m.is_file())?.len())
        })
    };
    let detected_port = hint
        .and_then(|hint| hint.port)
        .or_else(|| {
            value
                .get("port")
                .and_then(Value::as_u64)
                .and_then(|v| u16::try_from(v).ok())
        })
        .unwrap_or(8080);
    let name = value
        .get("model_name")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| {
            config
                .file_stem()
                .and_then(|v| v.to_str())
                .unwrap_or("Strata")
        })
        .to_owned();
    let id = candidate_id(&root, &config);
    let mut profile = ServiceProfile {
        id: id.clone(),
        name: name.clone(),
        base_url: format!("http://127.0.0.1:{detected_port}"),
        install_dir: root.to_string_lossy().into(),
        python_path: python
            .as_ref()
            .map(|v| v.to_string_lossy().into())
            .unwrap_or_default(),
        config_path: config.to_string_lossy().into(),
        managed: true,
    };
    let observed_host = hint
        .and_then(|hint| hint.host.as_deref())
        .or_else(|| value.get("host").and_then(Value::as_str))
        .unwrap_or("127.0.0.1");
    profile.base_url = network::endpoint(
        &serde_json::json!({"host":observed_host,"port":detected_port}),
        &profile,
    )?
    .base_url;
    let engine_version = runtime_version(&root, Some(&engine)).or_else(|| match &component {
        Some(Ok(component)) => Some(component.version.clone()),
        _ => None,
    });
    let mut candidate = LocalCandidate {
        id,
        name,
        install_dir: profile.install_dir.clone(),
        python_path: profile.python_path.clone(),
        config_path: profile.config_path.clone(),
        model_path: model_path.to_string_lossy().into(),
        model_bytes,
        model_group_key: Some(model_group_key(&model_path, &model_assets)),
        config_modified_at: config_modified_at(&config),
        config: Some(display_config(&value)),
        detected_port: Some(detected_port),
        running: Some(false),
        reason: if fatal_reasons.is_empty() {
            None
        } else {
            Some(fatal_reasons.join("；"))
        },
        runtime_version: engine_version.clone(),
        release_version: release_version(&root, engine_version.as_deref()),
        source: Some(source.into()),
        availability: Some(
            if fatal_reasons.is_empty() {
                "ready"
            } else {
                "repair"
            }
            .into(),
        ),
        pid: None,
    };
    if hint.is_some() && !profile.python_path.is_empty() {
        match external::detect(&profile) {
            Ok(Some(process)) => {
                candidate.running = Some(true);
                candidate.pid = Some(process.pid);
            }
            Ok(None) => {}
            Err(reason) => {
                candidate.reason = Some(format!("检测到已有进程，但身份核验未通过：{reason}"));
            }
        }
    }
    Ok(InspectedConfig {
        value,
        candidate,
        profile,
        fatal_reasons,
    })
}

fn model_size(path: &Path) -> Option<u64> {
    fn walk(path: &Path, depth: usize, entries: &mut usize) -> Option<u64> {
        let metadata = fs::symlink_metadata(path).ok()?;
        if metadata.file_type().is_symlink() {
            return None;
        }
        if metadata.is_file() {
            return Some(metadata.len());
        }
        if !metadata.is_dir() || depth == 0 {
            return None;
        }
        let mut sum = 0u64;
        for entry in fs::read_dir(path).ok()? {
            *entries += 1;
            if *entries > 2048 {
                return None;
            }
            sum = sum.checked_add(walk(&entry.ok()?.path(), depth - 1, entries)?)?;
        }
        Some(sum)
    }
    walk(path, 4, &mut 0)
}

fn conventional_directories(
    home: Option<&Path>,
    local: Option<&Path>,
    roaming: Option<&Path>,
) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = home {
        for suffix in ["Strata", "AI/Strata", "Documents/Strata"] {
            roots.push(home.join(suffix));
        }
    }
    if let Some(local) = local {
        for suffix in [
            "Strata",
            "Strata Manager/runtimes",
            "com.strata.manager/runtimes",
            "io.strata.manager/runtimes",
        ] {
            roots.push(local.join(suffix));
        }
    }
    // Tauri's app_data_dir uses Roaming on Windows. Keep legacy locations
    // discoverable while using the application's actual bundle identifier.
    if let Some(roaming) = roaming {
        for suffix in [
            "io.strata.manager/runtimes",
            "Strata Manager/runtimes",
            "com.strata.manager/runtimes",
        ] {
            roots.push(roaming.join(suffix));
        }
    }
    #[cfg(windows)]
    {
        // A short list of conventional installation locations, never a drive walk.
        roots.extend([PathBuf::from("C:/AI/Strata"), PathBuf::from("D:/AI/Strata")]);
    }
    roots
}

fn common_directories() -> Vec<PathBuf> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let roaming = std::env::var_os("APPDATA").map(PathBuf::from);
    expand_runtime_directories(conventional_directories(
        home.as_deref(),
        local.as_deref(),
        roaming.as_deref(),
    ))
}

fn is_runtime_root(root: &Path) -> bool {
    root.join("setup.py").is_file() && root.join("serve/server.py").is_file()
}

fn is_named_data_directory(root: &Path) -> bool {
    root.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            let lower = name.to_ascii_lowercase();
            lower == "strata-data" || lower == "strata_data" || lower.ends_with("-strata-data")
        })
}

fn looks_like_weight_layout(root: &Path) -> bool {
    root.join("models").is_dir() || root.join("packs").is_dir() || root.join("mtp").is_dir()
}

/// Official `strata-*.json` run configs (excluding Chat shared-settings companions).
fn strata_model_configs_in(folder: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for directory in [
        folder.to_owned(),
        folder.join("configs"),
        folder.join("config"),
    ] {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.take(MAX_CONFIGS).flatten() {
            let path = entry.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if name.starts_with("strata-")
                && name.ends_with(".json")
                && !name.ends_with(".shared-settings.json")
                && path.is_file()
                && !path.is_symlink()
            {
                paths.push(path);
            }
            if paths.len() >= MAX_CONFIGS {
                break;
            }
        }
        if paths.len() >= MAX_CONFIGS {
            break;
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

fn official_settings_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        paths.push(PathBuf::from(appdata).join("Strata").join("settings.json"));
    }
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        paths.push(PathBuf::from(xdg).join("strata").join("settings.json"));
    } else if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
    {
        paths.push(
            PathBuf::from(home)
                .join(".config")
                .join("strata")
                .join("settings.json"),
        );
    }
    paths
}

fn settings_claim_data_directory(data_dir: &Path) -> bool {
    let data_key = path_key(data_dir);
    official_settings_paths().into_iter().any(|settings_path| {
        let Ok(value) = read_json(&settings_path) else {
            return false;
        };
        value
            .get("data_dir")
            .and_then(Value::as_str)
            .and_then(|recorded| canonical_local(Path::new(recorded)).ok())
            .is_some_and(|recorded| path_key(&recorded) == data_key)
    })
}

fn should_expand_as_data_directory(root: &Path) -> bool {
    looks_like_weight_layout(root)
        || is_named_data_directory(root)
        || settings_claim_data_directory(root)
        || !strata_model_configs_in(root).is_empty()
}

fn installs_from_official_settings(data_dir: &Path) -> Vec<PathBuf> {
    let data_key = path_key(data_dir);
    let mut installs = Vec::new();
    let mut seen = HashSet::new();
    for settings_path in official_settings_paths() {
        let Ok(value) = read_json(&settings_path) else {
            continue;
        };
        let Some(recorded) = value
            .get("data_dir")
            .and_then(Value::as_str)
            .and_then(|path| canonical_local(Path::new(path)).ok())
        else {
            continue;
        };
        if path_key(&recorded) != data_key {
            continue;
        }
        let Some(list) = value.get("installs").and_then(Value::as_array) else {
            continue;
        };
        for item in list.iter().take(20) {
            let Some(path) = item.as_str() else {
                continue;
            };
            let Ok(root) = canonical_local(Path::new(path)) else {
                continue;
            };
            if is_runtime_root(&root) && seen.insert(path_key(&root)) {
                installs.push(root);
            }
        }
    }
    installs
}

fn nearby_install_roots(data_dir: &Path) -> Vec<PathBuf> {
    let mut installs = Vec::new();
    let mut seen = HashSet::new();
    let Some(parent) = data_dir.parent() else {
        return installs;
    };
    let mut candidates = Vec::new();
    for name in ["Strata", "strata", "Strata-main", "strata-main"] {
        candidates.push(parent.join(name));
    }
    // Official default is `<parent>/Strata-data` next to `<parent>/Strata`.
    if is_named_data_directory(data_dir) || looks_like_weight_layout(data_dir) {
        if let Ok(entries) = fs::read_dir(parent) {
            for entry in entries.take(MAX_DIRECTORIES).flatten() {
                let path = entry.path();
                if path.is_dir() && !path.is_symlink() {
                    candidates.push(path);
                }
            }
        }
    }
    for path in candidates {
        if installs.len() >= MAX_DIRECTORIES {
            break;
        }
        let Ok(root) = canonical_local(&path) else {
            continue;
        };
        if is_runtime_root(&root) && seen.insert(path_key(&root)) {
            installs.push(root);
        }
    }
    installs
}

/// Resolve the Strata install root from a run-config's cwd / exe / ancestors.
fn install_root_from_config_file(config: &Path) -> Option<PathBuf> {
    let value = read_json(config).ok()?;
    let exe = value
        .get("exe")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())?;
    if !value.get("args").map(Value::is_array).unwrap_or(false) {
        return None;
    }
    let config_dir = config.parent()?;
    if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
        let cwd = resolve(config_dir, cwd);
        if let Ok(cwd) = canonical_local(&cwd) {
            if is_runtime_root(&cwd) {
                return Some(cwd);
            }
        }
    }
    let exe_path = resolve(
        value
            .get("cwd")
            .and_then(Value::as_str)
            .map(Path::new)
            .unwrap_or(config_dir),
        exe,
    );
    for ancestor in exe_path.ancestors().take(6) {
        if is_runtime_root(ancestor) {
            return canonical_local(ancestor).ok();
        }
    }
    for ancestor in config.ancestors().take(6) {
        if is_runtime_root(ancestor) {
            return canonical_local(ancestor).ok();
        }
    }
    None
}

fn config_outside_install(config: &Path, install: &Path) -> bool {
    match (canonical_local(config), canonical_local(install)) {
        (Ok(config), Ok(install)) => config.strip_prefix(&install).is_err(),
        _ => true,
    }
}

struct ExpandedUserDirectory {
    install_roots: Vec<PathBuf>,
    /// Run configs that live outside the install root (for example under a data dir).
    external_configs: Vec<(PathBuf, PathBuf)>,
    source: &'static str,
}

/// Expand a user-added path: install roots stay as-is; official data directories
/// resolve to linked installs via settings.json, siblings, and strata-*.json.
fn expand_user_directory(directory: &Path) -> ExpandedUserDirectory {
    let empty = ExpandedUserDirectory {
        install_roots: Vec::new(),
        external_configs: Vec::new(),
        source: "directory",
    };
    let Ok(root) = canonical_local(directory) else {
        return empty;
    };
    if is_runtime_root(&root) {
        return ExpandedUserDirectory {
            install_roots: vec![root],
            external_configs: Vec::new(),
            source: "directory",
        };
    }
    if !should_expand_as_data_directory(&root) {
        return empty;
    }
    let mut install_roots = Vec::new();
    let mut seen = HashSet::new();
    let mut push_install = |path: PathBuf| {
        if seen.insert(path_key(&path)) {
            install_roots.push(path);
        }
    };
    for install in installs_from_official_settings(&root) {
        push_install(install);
    }
    for install in nearby_install_roots(&root) {
        push_install(install);
    }
    let mut external_configs = Vec::new();
    for config in strata_model_configs_in(&root) {
        let Some(install) = install_root_from_config_file(&config) else {
            continue;
        };
        push_install(install.clone());
        if config_outside_install(&config, &install) {
            external_configs.push((install, config));
        }
    }
    ExpandedUserDirectory {
        install_roots,
        external_configs,
        source: "data-directory",
    }
}

/// Manager installations live inside runtimes/release-* or runtimes/strata-*.
/// Look only one level below a recognized runtime container, with hard bounds;
/// this never walks drives, model directories, or arbitrary user directories.
fn expand_runtime_directories(mut roots: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut children = Vec::new();
    for parent in &roots {
        if parent.file_name().and_then(|name| name.to_str()) != Some("runtimes")
            || canonical_local(parent).is_err()
            || parent.is_symlink()
        {
            continue;
        }
        let Ok(entries) = fs::read_dir(parent) else {
            continue;
        };
        for entry in entries.take(MAX_RUNTIME_ENTRIES).flatten() {
            let path = entry.path();
            if !path.is_symlink() && path.is_dir() && is_runtime_root(&path) {
                children.push(path);
            }
            if children.len() >= MAX_RUNTIME_CHILDREN {
                break;
            }
        }
        if children.len() >= MAX_RUNTIME_CHILDREN {
            break;
        }
    }
    children.sort();
    children.dedup();
    roots.extend(children);
    roots
}

fn source_revision(root: &Path) -> Option<String> {
    for marker in [
        ".strata-manager-release.json",
        ".strata-manager-runtime.json",
    ] {
        if let Some(revision) = read_json(&root.join(marker))
            .ok()
            .and_then(|value| {
                value
                    .get("revision")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .filter(|revision| {
                revision.len() == 40 && revision.bytes().all(|value| value.is_ascii_hexdigit())
            })
        {
            return Some(revision);
        }
    }
    let head = fs::read_to_string(root.join(".git/HEAD")).ok()?;
    let revision = if let Some(reference) = head.trim().strip_prefix("ref: ") {
        if !reference.starts_with("refs/") || reference.contains("..") {
            return None;
        }
        fs::read_to_string(root.join(".git").join(reference)).ok()?
    } else {
        head
    };
    let revision = revision.trim();
    (revision.len() == 40 && revision.bytes().all(|value| value.is_ascii_hexdigit()))
        .then(|| revision.to_owned())
}

fn runtime_root(profile: &ServiceProfile) -> PathBuf {
    let root = PathBuf::from(&profile.install_dir);
    let Ok(config) = read_json(Path::new(&profile.config_path)) else {
        return root;
    };
    let Some(exe) = config.get("exe").and_then(Value::as_str) else {
        return root;
    };
    let Ok(cwd) = canonical_local(&config_cwd(&root, &config)) else {
        return root;
    };
    if cwd.join("setup.py").is_file()
        && cwd.join("serve/server.py").is_file()
        && canonical_local(&resolve_engine(&cwd, exe))
            .is_ok_and(|engine| engine.is_file() && engine.starts_with(&cwd))
    {
        return cwd;
    }
    root
}

pub fn discover_runtimes(profiles: &[ServiceProfile]) -> Vec<DetectedRuntime> {
    inspect_runtime_directories(profiles, common_directories(), &HashMap::new())
}

/// Include the supervisor's actual state directory, which can be overridden
/// for development and need not match any conventional Tauri app-data path.
pub fn discover_runtimes_for_state(
    profiles: &[ServiceProfile],
    data_dir: &Path,
) -> Vec<DetectedRuntime> {
    discover_runtimes_for_state_with(profiles, data_dir, None)
}

/// Also scans `engine_root` (a `runtimes` folder chosen for new engine installs).
pub fn discover_runtimes_for_state_with(
    profiles: &[ServiceProfile],
    data_dir: &Path,
    engine_root: Option<PathBuf>,
) -> Vec<DetectedRuntime> {
    let mut roots = expand_runtime_directories(
        std::iter::once(data_dir.join("runtimes"))
            .chain(engine_root)
            .collect(),
    );
    roots.extend(common_directories());
    inspect_runtime_directories(profiles, roots, &HashMap::new())
}

/// Also inspects runtimes the Manager used before (`known`: folder → the
/// Python it ran with), e.g. the version switched away from, which no saved
/// configuration references any more.
pub fn discover_runtimes_with_known(
    profiles: &[ServiceProfile],
    data_dir: &Path,
    engine_root: Option<PathBuf>,
    known: &HashMap<PathBuf, String>,
) -> Vec<DetectedRuntime> {
    let mut roots = expand_runtime_directories(
        std::iter::once(data_dir.join("runtimes"))
            .chain(engine_root)
            .collect(),
    );
    roots.extend(known.keys().cloned());
    roots.extend(common_directories());
    inspect_runtime_directories(profiles, roots, known)
}

fn inspect_runtime_directories(
    profiles: &[ServiceProfile],
    directories: Vec<PathBuf>,
    known: &HashMap<PathBuf, String>,
) -> Vec<DetectedRuntime> {
    let hints = process_hints().unwrap_or_default();
    let mut roots: Vec<_> = profiles
        .iter()
        .filter(|profile| profile.managed)
        .map(runtime_root)
        .collect();
    roots.extend(hints.iter().filter_map(hint_root));
    roots.extend(directories);
    let mut seen = HashSet::new();
    let mut cache = PythonCache::default();
    let mut runtimes = Vec::new();
    for root in roots.into_iter().take(128) {
        let Ok(root) = canonical_local(&root) else {
            continue;
        };
        if !seen.insert(path_key(&root))
            || !root.join("setup.py").is_file()
            || !root.join("serve/server.py").is_file()
        {
            continue;
        }
        let registered = profiles
            .iter()
            .find(|profile| canonical_local(&runtime_root(profile)).is_ok_and(|path| path == root));
        let python = find_python(
            &root,
            registered
                .map(|profile| profile.python_path.as_str())
                .or_else(|| known.get(&root).map(String::as_str)),
            None,
            &mut cache,
        );
        let mut reasons = Vec::new();
        if python.is_none() {
            reasons.push("需要准备 Python 3.10+ 环境".to_owned());
        }
        if let Some(reason) = python.as_ref().and_then(missing_modules_reason) {
            reasons.push(reason);
        }
        let python_path = python
            .map(|choice| choice.path)
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default();
        let mut profile = registered.cloned().unwrap_or_else(|| ServiceProfile {
            id: candidate_id(&root, &root.join("setup.py")).replace("local-", "runtime-detected-"),
            name: "Strata".into(),
            base_url: "http://127.0.0.1:18081".into(),
            install_dir: root.to_string_lossy().into(),
            python_path: python_path.clone(),
            config_path: String::new(),
            managed: true,
        });
        // Model preparation uses the interpreter we just verified, even when a
        // saved configuration refers to an interpreter that was later moved.
        profile.install_dir = root.to_string_lossy().into();
        profile.python_path = python_path.clone();
        let engine_hint = first_config_engine(&root);
        let engine_version = runtime_version(&root, engine_hint.as_deref());
        runtimes.push(DetectedRuntime {
            install_dir: root.to_string_lossy().into(),
            python_path,
            release_version: release_version(&root, engine_version.as_deref()),
            runtime_version: engine_version,
            source_revision: source_revision(&root),
            readiness: if reasons.is_empty() {
                "ready"
            } else {
                "repair"
            }
            .into(),
            reason: (!reasons.is_empty()).then(|| reasons.join("；")),
            profile,
        });
    }
    runtimes
}

fn config_paths(root: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for directory in [root.to_owned(), root.join("configs")] {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.take(MAX_CONFIGS).flatten() {
            let path = entry.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if path.extension().and_then(|v| v.to_str()) == Some("json")
                && !name.ends_with(".shared-settings.json")
                && path.is_file()
                && !path.is_symlink()
            {
                paths.push(path);
            }
            if paths.len() >= MAX_CONFIGS {
                break;
            }
        }
        if paths.len() >= MAX_CONFIGS {
            break;
        }
    }
    paths.sort();
    paths
}

/// Enumerate the complete native snapshot before reading only Python argv.
/// Discovery hints never authorize adoption; external identity checks still do.
#[cfg(windows)]
mod windows_census;

#[cfg(windows)]
type WindowsPythonInventory = Vec<(Vec<String>, Option<PathBuf>)>;

#[cfg(windows)]
fn windows_python_inventory(read_cwd: bool) -> Result<WindowsPythonInventory, String> {
    use std::time::{Duration, Instant};
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
    };
    let started = Instant::now();
    let pids = unsafe {
        let handle = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if handle == INVALID_HANDLE_VALUE {
            return Err("无法获取完整本机进程清单，已停止自动操作".into());
        }
        let result = (|| {
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of_val(&entry) as u32;
            let mut next = Process32FirstW(handle, &mut entry);
            let mut count = 0;
            let mut pids = Vec::new();
            while next != 0 {
                count += 1;
                if count > 4096 || started.elapsed() >= Duration::from_secs(3) {
                    return Err("本机进程清单超过检测上限或时间预算，已停止自动操作".to_string());
                }
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .ok_or("本机进程文件名不完整，已停止自动操作")?;
                let name = String::from_utf16(&entry.szExeFile[..end])
                    .map_err(|_| "本机进程文件名无效，已停止自动操作")?;
                if name.eq_ignore_ascii_case("python.exe")
                    || name.eq_ignore_ascii_case("pythonw.exe")
                {
                    pids.push(Pid::from_u32(entry.th32ProcessID));
                    if pids.len() > 64 {
                        return Err("本机 Python 进程超过检测上限，已停止自动操作".into());
                    }
                }
                next = Process32NextW(handle, &mut entry);
            }
            if GetLastError() != ERROR_NO_MORE_FILES {
                return Err("本机进程清单读取不完整，已停止自动操作".into());
            }
            Ok(pids)
        })();
        CloseHandle(handle);
        result?
    };
    if started.elapsed() >= Duration::from_secs(3) {
        return Err("读取本机进程清单超过时间预算，已停止自动操作".into());
    }
    if pids.is_empty() {
        return Ok(Vec::new());
    }
    let mut system = System::new();
    let mut refresh = ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always);
    if read_cwd {
        refresh = refresh.with_cwd(UpdateKind::Always);
    }
    system.refresh_processes_specifics(ProcessesToUpdate::Some(&pids), true, refresh);
    if started.elapsed() >= Duration::from_secs(3) {
        return Err("读取本机 Python 参数超过时间预算，已停止自动操作".into());
    }
    let mut commands = Vec::with_capacity(pids.len());
    for pid in pids {
        // A disappeared or unreadable process is an incomplete observation.
        // A later detection may retry; this pass must not declare it absent.
        let process = system
            .process(pid)
            .ok_or("Python 进程清单发生变化，请重新检测；未自动启动")?;
        let name = process
            .name()
            .to_str()
            .ok_or("Python 进程名称无法核验，未自动启动")?;
        if !name.eq_ignore_ascii_case("python.exe") && !name.eq_ignore_ascii_case("pythonw.exe") {
            return Err("Python 进程身份发生变化，请重新检测；未自动启动".into());
        }
        // A Python owned by another account (e.g. a LocalSystem service child)
        // denies even limited query access, so it cannot be this user's Strata
        // management script. Skip it instead of blocking the whole check.
        if process.cmd().is_empty() && windows_open_denied(pid.as_u32()) {
            continue;
        }
        commands.push((
            checked_windows_args(process.cmd())?,
            process.cwd().map(Path::to_path_buf),
        ));
    }
    if started.elapsed() >= Duration::from_secs(3) {
        return Err("读取本机 Python 参数超过时间预算，已停止自动操作".into());
    }
    Ok(commands)
}

/// True only when OpenProcess fails with ERROR_ACCESS_DENIED for limited
/// query access, i.e. the process belongs to another security context.
#[cfg(windows)]
fn windows_open_denied(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED},
        System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return unsafe { GetLastError() } == ERROR_ACCESS_DENIED;
    }
    unsafe { CloseHandle(handle) };
    false
}

#[cfg(windows)]
fn checked_windows_args(command: &[std::ffi::OsString]) -> Result<Vec<String>, String> {
    if command.is_empty() || command.len() > 256 {
        return Err("无法完整读取 Python 启动参数，请检查进程权限后重新检测；未自动启动".into());
    }
    let mut args = Vec::with_capacity(command.len());
    let mut bytes = 0usize;
    for value in command {
        let value = value
            .to_str()
            .ok_or("Python 启动参数包含无效文本，未自动启动")?;
        bytes = bytes.saturating_add(value.len());
        if bytes > 128 * 1024 {
            return Err("Python 启动参数超过检测上限，未自动启动".into());
        }
        args.push(value.to_owned());
    }
    Ok(args)
}

fn hint_from_args(args: &[String]) -> Option<ProcessHint> {
    let module = args
        .windows(2)
        .position(|pair| pair[0] == "-m" && pair[1] == "serve.server")?;
    let options = &args[module + 2..];
    let config_index = options.iter().position(|arg| arg == "--config")?;
    let config = PathBuf::from(options.get(config_index + 1)?);
    if !config.is_absolute() || !config.is_file() {
        return None;
    }
    let python = PathBuf::from(args.first()?);
    let port = options
        .iter()
        .position(|arg| arg == "--port")
        .and_then(|index| options.get(index + 1)?.parse::<u16>().ok());
    let host = options
        .iter()
        .position(|arg| arg == "--host")
        .and_then(|index| options.get(index + 1))
        .cloned();
    Some(ProcessHint {
        config,
        python,
        port,
        host,
        pid: None,
        image: None,
    })
}

fn process_hints() -> Result<Vec<ProcessHint>, String> {
    #[cfg(windows)]
    {
        windows_census::process_hints()
    }
    #[cfg(target_os = "macos")]
    {
        // macOS has no /proc: read argv through the system process table (sysctl) instead. Another
        // account's processes expose no arguments and simply yield no hint.
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
        );
        Ok(system
            .processes()
            .iter()
            .take(4096)
            .filter_map(|(pid, process)| {
                let args: Vec<String> = process
                    .cmd()
                    .iter()
                    .map(|arg| arg.to_str().map(str::to_owned))
                    .collect::<Option<_>>()?;
                let image = process.name().to_str().map(str::to_owned);
                hint_from_args(&args).map(|hint| hint.observed(pid.as_u32(), image))
            })
            .collect())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let entries =
            fs::read_dir("/proc").map_err(|_| "此平台无法读取本机进程，不能安全自动启动")?;
        Ok(entries
            .take(4096)
            .flatten()
            .filter_map(|entry| {
                if entry.file_name().to_string_lossy().parse::<u32>().is_err() {
                    return None;
                }
                let bytes = fs::read(entry.path().join("cmdline")).ok()?;
                if bytes.len() > 32 * 1024 {
                    return None;
                }
                let args: Vec<_> = bytes
                    .split(|byte| *byte == 0)
                    .filter(|v| !v.is_empty())
                    .map(|v| String::from_utf8(v.to_vec()))
                    .collect::<Result<_, _>>()
                    .ok()?;
                let pid = entry.file_name().to_string_lossy().parse::<u32>().ok()?;
                let image = fs::read_to_string(entry.path().join("comm"))
                    .ok()
                    .map(|name| name.trim().to_owned())
                    .filter(|name| !name.is_empty());
                hint_from_args(&args).map(|hint| hint.observed(pid, image))
            })
            .collect())
    }
}

fn hint_root(hint: &ProcessHint) -> Option<PathBuf> {
    let value = read_json(&hint.config).ok()?;
    let parent = hint.config.parent()?;
    let cwd = value
        .get("cwd")
        .and_then(Value::as_str)
        .map(|value| resolve(parent, value))
        .unwrap_or_else(|| parent.to_owned());
    [cwd, parent.to_owned()]
        .into_iter()
        .find(|root| root.join("setup.py").is_file() && root.join("serve/server.py").is_file())
}

fn prioritized_config_paths(
    root: &Path,
    profiles: &[ServiceProfile],
    hints: &[ProcessHint],
) -> Vec<PathBuf> {
    // The live command line can refer to an application-owned copy outside the
    // runtime directory. Keep that exact config ahead of the bounded file scan.
    let mut paths: Vec<_> = hints
        .iter()
        .filter(|hint| {
            hint_root(hint)
                .and_then(|path| canonical_local(&path).ok())
                .as_deref()
                == Some(root)
        })
        .map(|hint| hint.config.clone())
        .collect();
    paths.extend(
        profiles
            .iter()
            .filter(|profile| {
                canonical_local(Path::new(&profile.install_dir)).is_ok_and(|path| path == root)
            })
            .map(|profile| PathBuf::from(&profile.config_path)),
    );
    paths.extend(config_paths(root));
    paths
}

/// A live Strata Python server that references an installation directory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunningProcess {
    pub pid: u32,
    /// Executable file name (e.g. `python.exe`).
    pub name: String,
    pub config: PathBuf,
}

/// Every identified Strata Python server that references this installation.
/// Read-only: it neither authorizes nor performs stopping any process.
pub fn running_installation_processes(installation: &Path) -> Result<Vec<RunningProcess>, String> {
    let root = canonical_local(installation)?;
    let mut found: Vec<RunningProcess> = process_hints()?
        .into_iter()
        .filter(|hint| {
            hint_root(hint)
                .and_then(|path| canonical_local(&path).ok())
                .is_some_and(|path| path_key(&path) == path_key(&root))
        })
        .map(|hint| RunningProcess {
            pid: hint.pid.unwrap_or(0),
            name: hint.image.unwrap_or_else(|| {
                hint.python
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "python".into())
            }),
            config: hint.config,
        })
        .collect();
    found.sort_by_key(|process| process.pid);
    found.dedup_by_key(|process| process.pid);
    Ok(found)
}

/// Whether *any* identified Strata Python server references this installation.
/// This is deliberately conservative and does not authorize stopping that process.
pub fn has_running_installation(installation: &Path) -> Result<bool, String> {
    Ok(!running_installation_processes(installation)?.is_empty())
}

/// The Python entry script, rather than an incidental argument or `-c` text.
fn python_entry_script(args: &[String]) -> Option<&str> {
    let mut index = 1;
    while let Some(arg) = args.get(index) {
        if arg.starts_with("-c") {
            return None;
        }
        if arg == "-m" || arg.starts_with("-m") {
            let module = if arg == "-m" {
                args.get(index + 1)?.as_str()
            } else {
                &arg[2..]
            };
            return match module {
                "tools.strata_mcp" => Some("tools/strata_mcp.py"),
                "setup" => Some("setup.py"),
                _ => None,
            };
        }
        if arg == "--" {
            return args.get(index + 1).map(String::as_str);
        }
        if ["-W", "-X", "--check-hash-based-pycs"].contains(&arg.as_str()) {
            index += 2;
            continue;
        }
        if arg.starts_with('-') {
            index += 1;
            continue;
        }
        return Some(arg);
    }
    None
}

fn python_management_script(args: &[String]) -> Option<&str> {
    let script = python_entry_script(args)?;
    let name = Path::new(script).file_name()?.to_str()?;
    (name.eq_ignore_ascii_case("setup.py") || name.eq_ignore_ascii_case("strata_mcp.py"))
        .then_some(script)
}

fn management_script_matches(
    root: &Path,
    args: &[String],
    cwd: Option<&Path>,
) -> Result<bool, String> {
    let Some(script) = python_management_script(args) else {
        return Ok(false);
    };
    let path = Path::new(script);
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.ok_or("管理脚本使用相对路径但工作目录不可核验，禁止恢复本应用管理")?
            .join(path)
    };
    let actual = dunce::canonicalize(&path)
        .map_err(|_| "存活管理脚本的文件身份不可核验，禁止恢复本应用管理")?;
    let expected = root.join(if name.eq_ignore_ascii_case("setup.py") {
        "setup.py"
    } else {
        "tools/strata_mcp.py"
    });
    if path_key(&actual) == path_key(&expected) {
        return Ok(true);
    }
    // An unrelated root's management script must not require this root to have
    // the same optional script. Canonical aliases still identify the same file.
    Ok(
        dunce::canonicalize(expected)
            .is_ok_and(|expected| path_key(&actual) == path_key(&expected)),
    )
}

#[cfg(any(not(windows), test))]
fn unix_python_name(name: &str) -> bool {
    let name = Path::new(name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    name == "python" || name == "python3" || name == "pythonw" || name.starts_with("python3.")
}

#[cfg(any(not(windows), test))]
fn checked_unix_management_command(
    bytes: &[u8],
    executable: impl FnOnce() -> std::io::Result<Option<PathBuf>>,
) -> Result<Option<Vec<String>>, String> {
    if bytes.is_empty() || bytes.len() > 128 * 1024 || bytes.last() != Some(&0) {
        return Err("Python 管理参数不完整或超过核验上限".into());
    }
    // Preserve empty option values and use the real Python entry position.
    // Incidental setup.py text in -c, another script's arguments or a module's
    // options must not make an unrelated process a management candidate.
    let args = bytes[..bytes.len() - 1]
        .split(|b| *b == 0)
        .map(|value| {
            String::from_utf8(value.to_vec()).map_err(|_| "Python 管理参数包含无效文本".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if args.len() > 256 {
        return Err("Python 管理参数超过核验上限".into());
    }
    // A Python daemon's unrelated entry, -c or other module is not a management
    // candidate, even when its real executable cannot be read across users.
    // Share the exact entry classification with management_script_matches;
    // argv0/comm renaming never excludes an actual setup/MCP script entry.
    if python_management_script(&args).is_none() {
        return Ok(None);
    }
    let Some(exe) = executable().map_err(|error| {
        format!(
            "进程文件身份无法核验，禁止恢复本应用管理: {:?}",
            error.kind()
        )
    })?
    else {
        // The caller only returns None after confirming this /proc PID vanished.
        return Ok(None);
    };
    if !unix_python_name(&exe.to_string_lossy()) {
        return Ok(None);
    }
    Ok(Some(args))
}

#[cfg(any(not(windows), test))]
fn unix_empty_command_is_inactive(bytes: &[u8], expected_pid: u32) -> Result<bool, String> {
    let invalid = "空参数进程的内核状态不可核验，禁止恢复本应用管理";
    if bytes.len() > 4096 {
        return Err(invalid.into());
    }
    let open = bytes.iter().position(|byte| *byte == b'(').ok_or(invalid)?;
    let close = bytes
        .iter()
        .rposition(|byte| *byte == b')')
        .ok_or(invalid)?;
    if close <= open {
        return Err(invalid.into());
    }
    let pid = std::str::from_utf8(&bytes[..open])
        .ok()
        .and_then(|pid| pid.trim().parse::<u32>().ok())
        .ok_or(invalid)?;
    let fields = std::str::from_utf8(&bytes[close + 1..])
        .map_err(|_| invalid)?
        .split_ascii_whitespace()
        .collect::<Vec<_>>();
    if pid != expected_pid || fields.len() < 20 {
        return Err(invalid.into());
    }
    let flags = fields[6].parse::<u64>().map_err(|_| invalid)?;
    fields[19].parse::<u64>().map_err(|_| invalid)?;
    // PF_KTHREAD comes from the kernel's stat flags, not a changeable name.
    // Zombies/dead tasks also cannot be executing a live management script.
    Ok(flags & 0x0020_0000 != 0 || matches!(fields[0], "Z" | "X" | "x"))
}

#[cfg(not(windows))]
type UnixPythonInventory = Vec<(Vec<String>, Option<PathBuf>)>;

#[cfg(not(windows))]
fn unix_management_inventory() -> Result<UnixPythonInventory, String> {
    use std::io::Read;
    let mut commands = Vec::new();
    let mut entries = 0;
    let processes =
        fs::read_dir("/proc").map_err(|_| "此平台无法核验完整管理进程清单，禁止恢复本应用管理")?;
    for entry in processes {
        let entry = entry.map_err(|_| "管理进程清单不完整")?;
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        entries += 1;
        if entries > 4096 {
            return Err("管理进程清单超过核验上限".into());
        }
        let process = entry.path();
        let vanished = || matches!(fs::metadata(&process), Err(error) if error.kind() == std::io::ErrorKind::NotFound);
        let read = |name: &str, limit: u64| -> std::io::Result<Vec<u8>> {
            let mut bytes = Vec::new();
            fs::File::open(process.join(name))?
                .take(limit + 1)
                .read_to_end(&mut bytes)?;
            Ok(bytes)
        };
        // cmdline is normally readable across users even when ptrace
        // restrictions hide exe/cwd. Only positively classified non-candidates
        // avoid exe; an unreadable or malformed command still blocks resuming.
        let bytes = match read("cmdline", 128 * 1024) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && vanished() => continue,
            Err(error) => {
                return Err(format!(
                    "管理进程参数无法读取（PID {pid}，{:?}），禁止恢复本应用管理",
                    error.kind()
                ));
            }
        };
        if bytes.is_empty() {
            let stat = match read("stat", 4096) {
                Ok(stat) => stat,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound && vanished() => {
                    continue
                }
                Err(_) => return Err(format!("空参数进程状态无法读取（PID {pid}）")),
            };
            if unix_empty_command_is_inactive(&stat, pid)? {
                continue;
            }
            return Err(format!(
                "存活进程参数不完整（PID {pid}），禁止恢复本应用管理"
            ));
        }
        let args =
            checked_unix_management_command(&bytes, || match fs::read_link(process.join("exe")) {
                Ok(exe) => Ok(Some(exe)),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound && vanished() => {
                    Ok(None)
                }
                Err(error) => Err(error),
            })
            .map_err(|error| format!("{error}（PID {pid}）"))?;
        let Some(args) = args else { continue };
        commands.push((args, fs::read_link(entry.path().join("cwd")).ok()));
        if commands.len() > 64 {
            return Err("Python 管理进程超过核验上限".into());
        }
    }
    Ok(commands)
}

/// Official stdio MCP and setup can survive without a serving TCP listener.
/// This read-only scan complements server discovery; it never adopts/stops them.
pub fn has_running_management(installation: &Path) -> Result<bool, String> {
    let root = canonical_local(installation)?;
    #[cfg(windows)]
    let commands = windows_python_inventory(true)?;
    #[cfg(not(windows))]
    let commands = unix_management_inventory()?;
    for (args, cwd) in commands {
        if management_script_matches(&root, &args, cwd.as_deref())? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Discover only explicit/registered roots, conventional roots, and observed
/// Python Strata processes. No recursive drive or network/port scanning occurs.
pub fn discover_local(
    directories: &[PathBuf],
    profiles: &[ServiceProfile],
) -> Result<Vec<LocalCandidate>, String> {
    if directories.len() > MAX_DIRECTORIES {
        return Err("一次最多检测 32 个安装目录".into());
    }
    for directory in directories {
        if !directory.is_absolute() {
            return Err("检测目录必须是本机绝对路径".into());
        }
    }
    let hints = process_hints()?;
    let mut roots: Vec<(PathBuf, &str)> = hints
        .iter()
        .filter_map(hint_root)
        .map(|root| (root, "running-process"))
        .collect();
    roots.extend(
        profiles
            .iter()
            .filter(|profile| external::local_port(profile).is_ok())
            .map(|profile| (PathBuf::from(&profile.install_dir), "registered")),
    );
    let mut external_configs: Vec<(PathBuf, PathBuf, &'static str)> = Vec::new();
    for directory in directories {
        let expanded = expand_user_directory(directory);
        for root in expanded.install_roots {
            roots.push((root, expanded.source));
        }
        for (install, config) in expanded.external_configs {
            external_configs.push((install, config, expanded.source));
        }
    }
    roots.extend(
        common_directories()
            .into_iter()
            .map(|root| (root, "common")),
    );
    let mut extras_by_install: HashMap<String, Vec<(PathBuf, &'static str)>> = HashMap::new();
    for (install, config, source) in external_configs {
        extras_by_install
            .entry(path_key(&install))
            .or_default()
            .push((config, source));
    }
    let mut seen = HashSet::new();
    let mut cache = PythonCache::default();
    let mut candidates = Vec::new();
    for (root, source) in roots.into_iter().take(128) {
        let Ok(root) = canonical_local(&root) else {
            continue;
        };
        if !root.join("setup.py").is_file() || !root.join("serve/server.py").is_file() {
            continue;
        }
        let mut paths = prioritized_config_paths(&root, profiles, &hints);
        if let Some(extras) = extras_by_install.remove(&path_key(&root)) {
            for (config, _) in extras.into_iter().rev() {
                if !paths.iter().any(|path| path_key(path) == path_key(&config)) {
                    paths.insert(0, config);
                }
            }
        }
        for path in paths.into_iter().take(MAX_CONFIGS) {
            if path.is_symlink() {
                continue;
            }
            let Ok(path) = canonical_local(&path) else {
                continue;
            };
            if !seen.insert(path_key(&path)) {
                continue;
            }
            let hint = hints.iter().find(|hint| {
                canonical_local(&hint.config)
                    .as_ref()
                    .is_ok_and(|config| *config == path)
            });
            let preferred = profiles
                .iter()
                .find(|profile| {
                    canonical_local(Path::new(&profile.config_path))
                        .as_ref()
                        .is_ok_and(|config| *config == path)
                })
                .map(|profile| profile.python_path.as_str());
            if let Ok(mut inspected) =
                inspect_config(&root, &path, preferred, hint, source, &mut cache)
            {
                if inspected.candidate.running != Some(true)
                    && hints.iter().any(|hint| {
                        hint_root(hint)
                            .and_then(|path| canonical_local(&path).ok())
                            .as_ref()
                            == Some(&root)
                    })
                {
                    let message = "此安装已有其它模型实例运行，自动启动前需安全迁移";
                    inspected.candidate.reason = Some(
                        inspected
                            .candidate
                            .reason
                            .map(|reason| format!("{reason}；{message}"))
                            .unwrap_or_else(|| message.into()),
                    );
                }
                candidates.push(inspected.candidate);
            }
        }
    }
    candidates.sort_by(|a, b| {
        b.running
            .cmp(&a.running)
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.config_path.cmp(&b.config_path))
    });
    Ok(candidates)
}

fn unused_port(requested: Option<u16>) -> Result<u16, String> {
    if let Some(port) = requested {
        if port == 0 {
            return Err("本机端口不能为 0".into());
        }
        TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port))
            .map_err(|_| "所选本机端口已被占用")?;
        return Ok(port);
    }
    for port in 18100..=18200 {
        if TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok() {
            return Ok(port);
        }
    }
    Err("18100–18200 范围没有可用本机端口".into())
}

fn import_port(requested: Option<u16>, inspected: &InspectedConfig) -> Result<u16, String> {
    let original_port = inspected
        .candidate
        .detected_port
        .ok_or("原安装缺少有效端口")?;
    if inspected.candidate.running == Some(true)
        && requested.is_none_or(|port| port == original_port)
    {
        // Only an independently re-verified instance can reserve its occupied
        // port for an idle handover. A frontend `running` flag has no authority.
        if let Some(process) = external::detect(&inspected.profile)? {
            process.revalidate(&inspected.profile)?;
            return Ok(original_port);
        }
        return unused_port(Some(original_port));
    }
    if requested.is_some() {
        return unused_port(requested);
    }
    unused_port(Some(original_port)).or_else(|_| unused_port(None))
}

fn write_json_new(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}

/// Import an installation without changing any source config, startup script,
/// model file, or process. Backend registration/start is a separate transaction.
pub fn prepare_import(
    candidate: &LocalCandidate,
    state_root: &Path,
    port: Option<u16>,
) -> Result<PreparedImport, String> {
    prepare_import_inner(candidate, state_root, port, None)
}

/// A saved legacy profile is trusted local application state, unlike an IPC
/// presentation candidate. Validate its exact Python and config instead of
/// replacing the user's interpreter or choosing a neighbouring model config.
pub(crate) fn prepare_legacy_import(
    profile: &ServiceProfile,
    state_root: &Path,
) -> Result<PreparedImport, String> {
    external::local_port(profile)?;
    let python = canonical_local(Path::new(&profile.python_path))?;
    if !python.is_file() || !python_probe(&python, &mut PythonCache::default()) {
        return Err("旧版档案中的 Python 不是可运行的本机 Python 3.10+".into());
    }
    let candidate = LocalCandidate {
        id: profile.id.clone(),
        name: profile.name.clone(),
        install_dir: profile.install_dir.clone(),
        python_path: profile.python_path.clone(),
        config_path: profile.config_path.clone(),
        model_path: String::new(),
        model_bytes: None,
        model_group_key: None,
        config_modified_at: None,
        config: None,
        detected_port: None,
        running: None,
        reason: None,
        runtime_version: None,
        release_version: None,
        source: Some("legacy-profile".into()),
        availability: None,
        pid: None,
    };
    prepare_import_inner(
        &candidate,
        state_root,
        None,
        Some(&python.to_string_lossy()),
    )
}

fn prepare_import_inner(
    candidate: &LocalCandidate,
    state_root: &Path,
    port: Option<u16>,
    saved_python: Option<&str>,
) -> Result<PreparedImport, String> {
    let root = canonical_local(Path::new(&candidate.install_dir))?;
    let state_root = canonical_local(state_root)?;
    if Path::new(&candidate.config_path).is_symlink() {
        return Err("配置文件不能是符号链接".into());
    }
    let config = canonical_local(Path::new(&candidate.config_path))?;
    let hints = process_hints()?;
    let hint = hints.iter().find(|hint| {
        canonical_local(&hint.config)
            .as_ref()
            .is_ok_and(|path| *path == config)
    });
    if !config.starts_with(&root)
        && !config.starts_with(&state_root)
        && hint.is_none()
        && saved_python.is_none()
    {
        return Err("配置不属于所选安装，也不是已识别的本机运行配置".into());
    }
    // An IPC candidate cannot choose an arbitrary executable. Python is derived
    // from the installation, observed process, or known system Python launcher.
    let inspected = inspect_config(
        &root,
        &config,
        saved_python,
        hint,
        "import",
        &mut PythonCache::default(),
    )?;
    // All display fields (id/name/model/running/bytes) are re-derived, not trusted.
    if !inspected.fatal_reasons.is_empty() {
        return Err(inspected.fatal_reasons.join("；"));
    }
    let imports = state_root.join("imports");
    if imports.is_symlink() || (imports.exists() && !imports.is_dir()) {
        return Err("应用导入目录类型无效".into());
    }
    fs::create_dir_all(&imports).map_err(|e| e.to_string())?;
    let destination = imports.join(&inspected.candidate.id);
    let mut profile = inspected.profile.clone();
    profile.config_path = destination.join("config.json").to_string_lossy().into();
    let mut existing = destination.exists() || destination.is_symlink();
    if existing {
        if destination.is_symlink() || !destination.is_dir() {
            return Err("应用导入目标类型无效".into());
        }
        let manifest: ImportManifest =
            serde_json::from_value(read_json(&destination.join("import.json"))?)
                .map_err(|_| "已有导入记录无法核验")?;
        if manifest.schema_version != 1
            || manifest.candidate_id != inspected.candidate.id
            || manifest.install_dir != inspected.profile.install_dir
            || manifest.original_config_path != inspected.profile.config_path
        {
            return Err("导入目标已被其它安装占用，拒绝覆盖".into());
        }
        let snapshot = Path::new(&profile.config_path);
        if fs::symlink_metadata(snapshot)
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        {
            // The private copy was archived by "delete configuration"; a restored or
            // regenerated original gets a fresh snapshot instead of a dead record.
            fs::remove_dir_all(&destination)
                .map_err(|e| format!("清理已删除配置的导入记录失败: {e}"))?;
            existing = false;
        }
    }
    if existing {
        let imported = read_json(Path::new(&profile.config_path))?;
        storage::validate(&imported)?;
        profile.base_url = network::endpoint(&imported, &profile)?.base_url;
    } else {
        let port = import_port(port, &inspected)?;
        let mut value = inspected.value;
        let object = value.as_object_mut().ok_or("配置必须为对象")?;
        object.entry("host").or_insert_with(|| {
            Value::String(
                hint.and_then(|hint| hint.host.clone())
                    .unwrap_or_else(|| "127.0.0.1".into()),
            )
        });
        object.insert("port".into(), Value::from(port));
        object.insert(
            "cwd".into(),
            Value::String(
                config_cwd(&root, &Value::Object(object.clone()))
                    .to_string_lossy()
                    .into(),
            ),
        );
        object.insert("open_browser".into(), Value::Bool(false));
        // Imported relative files retain their original absolute cwd. Logs belong
        // to the application so the user's original log is not overwritten.
        object.insert(
            "log".into(),
            Value::String(destination.join("engine.log").to_string_lossy().into()),
        );
        storage::validate(&value)?;
        profile.base_url = network::endpoint(&value, &profile)?.base_url;
        let temporary = tempfile::Builder::new()
            .prefix(".import-")
            .tempdir_in(&imports)
            .map_err(|e| e.to_string())?;
        write_json_new(&temporary.path().join("config.json"), &value)?;
        let shared = config.with_file_name(format!(
            "{}.shared-settings.json",
            config
                .file_stem()
                .ok_or("配置文件名无效")?
                .to_string_lossy()
        ));
        if shared.exists() {
            let settings = read_json(&shared)?;
            if !settings.is_object() {
                return Err("原共享采样设置不是 JSON 对象".into());
            }
            write_json_new(
                &temporary.path().join("config.shared-settings.json"),
                &settings,
            )?;
        }
        write_json_new(
            &temporary.path().join("import.json"),
            &ImportManifest {
                schema_version: 1,
                candidate_id: inspected.candidate.id,
                install_dir: inspected.profile.install_dir.clone(),
                original_config_path: inspected.profile.config_path.clone(),
            },
        )?;
        fs::rename(temporary.path(), &destination)
            .map_err(|e| format!("发布导入快照失败（原安装保留）: {e}"))?;
    }
    Ok(PreparedImport {
        profile,
        original_profile: inspected.profile.clone(),
        original_config_path: inspected.profile.config_path,
        detected_running: inspected.candidate.running == Some(true),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn management_cmdline(values: &[&str]) -> Vec<u8> {
        values
            .iter()
            .flat_map(|value| value.bytes().chain([0]))
            .collect()
    }

    #[test]
    fn unix_management_inventory_prefilters_only_complete_unrelated_commands() {
        for values in [
            vec![
                "/usr/bin/gnome-keyring-daemon",
                "--foreground",
                "--components=secrets",
            ],
            vec!["worker", "-c", "print('setup.py')", "setup.py"],
            vec!["worker", "-cprint('strata_mcp.py')", "setup.py"],
            vec!["worker", "unrelated.py", "tools/strata_mcp.py"],
            vec!["worker", "-m", "other.module", "setup.py"],
            vec!["/usr/bin/python3", "/usr/share/unrelated.py", "setup.py"],
            vec!["/usr/bin/python3", "-c", "print('setup.py')", "setup.py"],
            vec![
                "/usr/bin/python3",
                "-m",
                "other.module",
                "tools/strata_mcp.py",
            ],
            vec![
                "/usr/bin/python3",
                "/usr/share/unattended-upgrades/unattended-upgrade-shutdown",
                "--wait-for-signal",
            ],
        ] {
            assert!(
                checked_unix_management_command(&management_cmdline(&values), || panic!(
                    "an unrelated command must not read a restricted exe"
                ),)
                .unwrap()
                .is_none()
            );
        }
    }

    #[test]
    fn unix_management_inventory_verifies_python_and_renamed_real_entries() {
        for values in [
            vec!["/usr/bin/python3.13", "-I", "-u", "setup.py"],
            vec!["/usr/bin/python3", "-W", "", "setup.py"],
            vec!["renamed-argv0", "tools/strata_mcp.py"],
            vec!["renamed-argv0", "-m", "setup"],
            vec!["renamed-argv0", "-mtools.strata_mcp"],
        ] {
            let args = checked_unix_management_command(&management_cmdline(&values), || {
                Ok(Some(PathBuf::from("/usr/bin/python3.13")))
            })
            .unwrap()
            .unwrap();
            assert_eq!(args, values);
        }
        assert!(
            checked_unix_management_command(&management_cmdline(&["python3", "setup.py"]), || {
                Ok(Some(PathBuf::from("/usr/bin/sh")))
            },)
            .unwrap()
            .is_none(),
            "an argv/name claim cannot replace the actual executable identity"
        );
    }

    #[test]
    fn unix_management_inventory_restricted_candidates_fail_closed() {
        for values in [
            vec!["/usr/bin/python3", "setup.py"],
            vec!["renamed-argv0", "setup.py"],
            vec!["renamed-argv0", "-m", "tools.strata_mcp"],
        ] {
            for kind in [
                std::io::ErrorKind::PermissionDenied,
                std::io::ErrorKind::NotFound,
            ] {
                let error = checked_unix_management_command(&management_cmdline(&values), || {
                    Err(std::io::Error::from(kind))
                })
                .unwrap_err();
                assert!(error.contains("进程文件身份无法核验"));
            }
        }
        assert!(
            checked_unix_management_command(&management_cmdline(&["python3", "setup.py"]), || Ok(
                None
            ),)
            .unwrap()
            .is_none(),
            "only a separately confirmed vanished PID may return None"
        );
    }

    #[test]
    fn unix_management_inventory_incomplete_arguments_never_become_non_candidates() {
        let malformed = [
            Vec::new(),
            b"worker\0unrelated.py".to_vec(),
            b"python3\0setup.py\0\xff\0".to_vec(),
            vec![0; 128 * 1024 + 1],
            management_cmdline(&vec!["arg"; 257]),
        ];
        for bytes in malformed {
            assert!(checked_unix_management_command(&bytes, || {
                panic!("invalid arguments must not reach executable verification")
            })
            .is_err());
        }
    }

    #[test]
    fn unix_management_inventory_empty_command_requires_kernel_or_dead_state() {
        let stat = |state: &str, flags: u64| {
            let mut fields = vec!["0".to_owned(); 20];
            fields[0] = state.into();
            fields[6] = flags.to_string();
            fields[19] = "12345".into();
            format!("42 (renamed ) worker) {}\n", fields.join(" ")).into_bytes()
        };
        assert!(unix_empty_command_is_inactive(&stat("S", 0x0020_0000), 42).unwrap());
        for state in ["Z", "X", "x"] {
            assert!(unix_empty_command_is_inactive(&stat(state, 0), 42).unwrap());
        }
        for state in ["S", "R", "D", "T"] {
            assert!(!unix_empty_command_is_inactive(&stat(state, 0), 42).unwrap());
        }
        assert!(unix_empty_command_is_inactive(&stat("S", 0x0020_0000), 43).is_err());
        assert!(unix_empty_command_is_inactive(b"42 (python3) S 0 0", 42).is_err());
        assert!(unix_empty_command_is_inactive(&vec![0; 4097], 42).is_err());
    }

    #[test]
    fn management_entry_matches_exact_canonical_scripts_not_incidental_text() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("root 中文");
        let other = directory.path().join("other");
        for path in [&root, &other] {
            fs::create_dir_all(path.join("tools")).unwrap();
            fs::write(path.join("setup.py"), b"# fixture").unwrap();
            fs::write(path.join("tools/strata_mcp.py"), b"# fixture").unwrap();
        }
        let root = canonical_local(&root).unwrap();
        let args = |values: &[&str]| values.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        for values in [
            args(&["python", "-I", "-u", "setup.py"]),
            args(&["python", "-W", "", "setup.py"]),
            args(&["python", "tools/strata_mcp.py", "--root", "ignored"]),
            args(&["python", "-m", "tools.strata_mcp"]),
        ] {
            assert!(management_script_matches(&root, &values, Some(&root)).unwrap());
            assert!(!management_script_matches(&root, &values, Some(&other)).unwrap());
        }
        let absolute = root
            .join("tools/../tools/strata_mcp.py")
            .to_string_lossy()
            .into_owned();
        assert!(management_script_matches(&root, &args(&["python", &absolute]), None).unwrap());
        for values in [
            args(&["python", "-c", "print('setup.py')", "setup.py"]),
            args(&["python", "-cprint('x')", "setup.py"]),
            args(&["python", "unrelated.py", "tools/strata_mcp.py"]),
            args(&["python", "-m", "other.module", "setup.py"]),
        ] {
            assert!(!management_script_matches(&root, &values, Some(&root)).unwrap());
        }
        assert!(management_script_matches(&root, &args(&["python", "setup.py"]), None).is_err());
        fs::remove_file(root.join("tools/strata_mcp.py")).unwrap();
        assert!(
            !management_script_matches(
                &root,
                &args(&["python", "tools/strata_mcp.py"]),
                Some(&other)
            )
            .unwrap(),
            "another installation's MCP must not require this root's optional script"
        );
    }

    /// Tests that start or scan live processes take this so one test's
    /// half-started child is never read mid-exec by another's whole-system census.
    static PROCESS_CENSUS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn management_inventory_detects_live_stdio_and_relative_setup_only_in_their_root() {
        let _census = PROCESS_CENSUS.lock().unwrap_or_else(|e| e.into_inner());
        use std::{
            process::Command,
            time::{Duration, Instant},
        };
        let python = test_python().expect("isolated management fixture requires Python");
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("runtime 中文 空格");
        let other = directory.path().join("other");
        for path in [&root, &other] {
            fs::create_dir_all(path.join("tools")).unwrap();
            fs::write(path.join("setup.py"), b"# fixture").unwrap();
            fs::write(path.join("tools/strata_mcp.py"), b"# fixture").unwrap();
        }
        let root = canonical_local(&root).unwrap();
        for script in ["tools/strata_mcp.py", "setup.py"] {
            let marker = root.join("ready");
            let body=format!("import time\nfrom pathlib import Path\nPath({}).write_text('CPU fixture')\ntime.sleep(15)\n",serde_json::to_string(&marker.to_string_lossy()).unwrap());
            fs::write(root.join(script), body).unwrap();
            let mut command = Command::new(python.trim());
            command.args(["-I", "-S", script]).current_dir(&root);
            let mut process = crate::processes::OwnedProcess::spawn(
                command,
                Default::default(),
                "management-inventory-fixture",
            )
            .unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while !marker.exists() {
                assert!(Instant::now() < deadline, "fixture not ready");
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(has_running_management(&root.join("tools/..")).unwrap());
            assert!(
                !has_running_management(&other).unwrap(),
                "another root must remain separate"
            );
            assert!(
                process.refresh().unwrap().running,
                "read-only inventory must retain the fixture"
            );
            process.stop().unwrap();
            fs::remove_file(marker).unwrap();
        }
    }

    #[test]
    fn manager_runtime_locations_cover_actual_identifier_and_zip_children() {
        let temp = tempfile::tempdir().unwrap();
        let local = temp.path().join("Local");
        let roaming = temp.path().join("Roaming");
        let official_zip = roaming.join("io.strata.manager/runtimes/release-fixture");
        let source = local.join("io.strata.manager/runtimes/strata-fixture");
        for root in [&official_zip, &source] {
            fs::create_dir_all(root.join("serve")).unwrap();
            fs::create_dir_all(root.join("engine")).unwrap();
            fs::write(root.join("setup.py"), "# never executed").unwrap();
            fs::write(root.join("serve/server.py"), "# never executed").unwrap();
            fs::write(root.join("engine/strata.exe"), "# never executed").unwrap();
            fs::write(root.join("engine/BUILD.json"), r#"{"version":"0.1.42"}"#).unwrap();
        }
        let incomplete = roaming.join("io.strata.manager/runtimes/incomplete");
        fs::create_dir_all(&incomplete).unwrap();
        fs::write(incomplete.join("setup.py"), "# partial extraction").unwrap();
        let nested = roaming.join("io.strata.manager/runtimes/parent/nested");
        fs::create_dir_all(nested.join("serve")).unwrap();
        fs::write(nested.join("setup.py"), "# no recursive walk").unwrap();
        fs::write(nested.join("serve/server.py"), "# no recursive walk").unwrap();
        let directories = expand_runtime_directories(conventional_directories(
            None,
            Some(&local),
            Some(&roaming),
        ));
        assert!(directories.contains(&official_zip));
        assert!(directories.contains(&source));
        assert!(!directories.contains(&incomplete));
        assert!(!directories.contains(&nested));
        assert_eq!(
            runtime_version(&official_zip, None).as_deref(),
            Some("0.1.42")
        );
    }

    #[test]
    fn manager_runtime_child_scan_is_bounded() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("runtimes");
        for index in 0..MAX_RUNTIME_CHILDREN + 1 {
            let root = parent.join(format!("release-{index:03}"));
            fs::create_dir_all(root.join("serve")).unwrap();
            fs::write(root.join("setup.py"), "# never executed").unwrap();
            fs::write(root.join("serve/server.py"), "# never executed").unwrap();
        }
        assert_eq!(
            expand_runtime_directories(vec![parent]).len(),
            MAX_RUNTIME_CHILDREN + 1
        );
    }

    #[test]
    fn unregistered_runtime_in_custom_state_is_discovered_without_model_config() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runtimes/release-fixture");
        fs::create_dir_all(root.join("serve")).unwrap();
        fs::create_dir_all(root.join("engine")).unwrap();
        fs::write(root.join("setup.py"), "# never executed").unwrap();
        fs::write(root.join("serve/server.py"), "# never executed").unwrap();
        fs::write(root.join("engine/BUILD.json"), r#"{"version":"0.1.42"}"#).unwrap();
        let expected = canonical_local(&root).unwrap();
        let runtimes = discover_runtimes_for_state(&[], temp.path());
        let runtime = runtimes
            .iter()
            .find(|runtime| Path::new(&runtime.install_dir) == expected)
            .expect("detect a ZIP runtime before a model profile is created");
        assert_eq!(runtime.runtime_version.as_deref(), Some("0.1.42"));
        assert!(runtime.profile.config_path.is_empty());
        assert!(runtime.profile.managed);
        assert!(matches!(runtime.readiness.as_str(), "ready" | "repair"));
        assert!(!root.join("config.json").exists());
    }

    #[test]
    fn imported_service_copy_discovers_its_global_runtime_once() {
        let temp = tempfile::tempdir().unwrap();
        let global = temp.path().join("Strata");
        let private = temp.path().join("imports/service");
        fs::create_dir_all(global.join("serve")).unwrap();
        fs::create_dir_all(global.join("engine")).unwrap();
        fs::create_dir_all(&private).unwrap();
        fs::write(global.join("setup.py"), "# fixture").unwrap();
        fs::write(global.join("serve/server.py"), "# fixture").unwrap();
        fs::write(global.join("engine/strata.exe"), "fixture").unwrap();
        let config_path = private.join("config.json");
        fs::write(
            &config_path,
            serde_json::to_vec(&serde_json::json!({"cwd":global,"exe":"engine/strata.exe"}))
                .unwrap(),
        )
        .unwrap();
        let profile = ServiceProfile {
            id: "fixture".into(),
            name: "fixture".into(),
            base_url: "http://127.0.0.1:18081".into(),
            install_dir: private.to_string_lossy().into(),
            python_path: String::new(),
            config_path: config_path.to_string_lossy().into(),
            managed: true,
        };
        assert_eq!(runtime_root(&profile), canonical_local(&global).unwrap());
        fs::write(
            &config_path,
            serde_json::to_vec(&serde_json::json!({"cwd":global,"exe":config_path})).unwrap(),
        )
        .unwrap();
        assert_eq!(runtime_root(&profile), private);
    }

    #[test]
    fn zip_release_revision_takes_precedence_over_previous_installation_marker() {
        let root = tempfile::tempdir().unwrap();
        let old_revision = "a".repeat(40);
        let new_revision = "b".repeat(40);
        fs::write(
            root.path().join(".strata-manager-runtime.json"),
            serde_json::to_vec(&serde_json::json!({"revision": old_revision})).unwrap(),
        )
        .unwrap();
        fs::write(
            root.path().join(".strata-manager-release.json"),
            serde_json::to_vec(&serde_json::json!({"revision": new_revision})).unwrap(),
        )
        .unwrap();
        assert_eq!(source_revision(root.path()), Some(new_revision));
        fs::write(
            root.path().join(".strata-manager-release.json"),
            "{\"revision\":\"invalid\"}",
        )
        .unwrap();
        assert_eq!(source_revision(root.path()), Some(old_revision));
    }

    #[cfg(windows)]
    #[test]
    fn native_python_args_preserve_unicode_spaces_and_reject_incomplete_observations() {
        use std::{ffi::OsString, os::windows::ffi::OsStringExt};
        let args = [
            r"C:\模型 环境\python.exe",
            "-m",
            "serve.server",
            "--config",
            r"D:\现有 模型\参数.json",
        ]
        .map(OsString::from);
        assert_eq!(
            checked_windows_args(&args).unwrap(),
            args.iter()
                .map(|value| value.to_str().unwrap())
                .collect::<Vec<_>>()
        );
        assert!(checked_windows_args(&[]).is_err());
        assert!(checked_windows_args(&vec![OsString::from("x"); 257]).is_err());
        assert!(checked_windows_args(&[OsString::from("x".repeat(128 * 1024 + 1))]).is_err());
        assert!(checked_windows_args(&[OsString::from_wide(&[0xd800])]).is_err());
    }

    fn test_python() -> Option<String> {
        #[cfg(windows)]
        let probes = [
            ("py", vec!["-c", "import sys;print(sys.executable)"]),
            ("python", vec!["-c", "import sys;print(sys.executable)"]),
        ];
        #[cfg(not(windows))]
        let probes = [
            ("python3", vec!["-c", "import sys;print(sys.executable)"]),
            ("python", vec!["-c", "import sys;print(sys.executable)"]),
        ];
        probes
            .into_iter()
            .find_map(|(program, args)| crate::output(program, &args))
    }

    fn fixture() -> (tempfile::TempDir, ServiceProfile) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("strata");
        fs::create_dir_all(root.join("serve")).unwrap();
        fs::create_dir_all(root.join("tokenizer")).unwrap();
        fs::create_dir_all(root.join("engine")).unwrap();
        fs::write(root.join("setup.py"), b"# fixture").unwrap();
        fs::write(root.join("serve/server.py"), b"# fixture, never started").unwrap();
        fs::write(root.join("tokenizer/vocab.json"), b"{}").unwrap();
        fs::write(root.join("tokenizer/merges.txt"), b"").unwrap();
        fs::write(root.join("tokenizer/token_type.json"), b"[]").unwrap();
        fs::write(
            root.join("engine/strata.exe"),
            b"fixture engine, never executed",
        )
        .unwrap();
        fs::write(
            root.join("engine/BUILD.json"),
            br#"{"version":"fixture-1"}"#,
        )
        .unwrap();
        fs::write(root.join("part-1.gguf"), b"0123456789").unwrap();
        fs::write(root.join("part-2.gguf"), b"abcdefghij").unwrap();
        let config = root.join("strata-fixture.json");
        write_json_new(&config, &serde_json::json!({"exe":"engine/strata.exe","cwd":root,"args":["--native","part-1.gguf","--ple-gguf","part-2.gguf"],"tokenizer":"tokenizer","model_name":"fixture-model","port":18099,"sampling":{"temperature":0.6},"custom":{"preserve":true}})).unwrap();
        let profile = ServiceProfile {
            id: "fixture".into(),
            name: "fixture".into(),
            base_url: "http://127.0.0.1:18099".into(),
            install_dir: root.to_string_lossy().into(),
            python_path: test_python().expect("Python 3 test fixture is required"),
            config_path: config.to_string_lossy().into(),
            managed: true,
        };
        (temp, profile)
    }

    fn inspect(profile: &ServiceProfile) -> InspectedConfig {
        inspect_config(
            Path::new(&profile.install_dir),
            Path::new(&profile.config_path),
            Some(&profile.python_path),
            None,
            "fixture",
            &mut PythonCache::default(),
        )
        .unwrap()
    }

    #[test]
    fn discovers_complete_assets_and_reports_missing_files_without_loading() {
        let (_temp, profile) = fixture();
        let inspected = inspect(&profile);
        assert_eq!(inspected.candidate.availability.as_deref(), Some("ready"));
        assert_eq!(inspected.candidate.model_bytes, Some(20));
        assert_eq!(
            inspected.candidate.runtime_version.as_deref(),
            Some("fixture-1")
        );
        fs::remove_file(Path::new(&profile.install_dir).join("part-2.gguf")).unwrap();
        let inspected = inspect(&profile);
        assert_eq!(inspected.candidate.availability.as_deref(), Some("repair"));
        assert!(inspected.candidate.reason.unwrap().contains("--ple-gguf"));
        assert_eq!(inspected.candidate.model_bytes, None);
    }

    #[test]
    fn configuration_variants_share_weight_identity_and_report_modified_settings() {
        let (_temp, profile) = fixture();
        let first = inspect(&profile).candidate;
        assert!(first.config_modified_at.is_some());
        assert_eq!(
            first.config.as_ref().unwrap()["sampling"]["temperature"],
            0.6
        );
        let mut config = read_json(Path::new(&profile.config_path)).unwrap();
        config["args"].as_array_mut().unwrap().extend([
            Value::from("--max-context"),
            Value::from("524288"),
            Value::from("--kv"),
            Value::from("int8"),
        ]);
        config["parallel"] = Value::from(2);
        config["api_key"] = Value::from("fixture-secret-do-not-expose");
        config["env"] = serde_json::json!({"OPENAI_API_KEY":"private", "NORMAL_SETTING":"safe"});
        fs::write(&profile.config_path, serde_json::to_vec(&config).unwrap()).unwrap();
        let second = inspect(&profile).candidate;
        assert_eq!(first.model_group_key, second.model_group_key);
        let display = second.config.as_ref().unwrap();
        assert_eq!(display["api_key"], "[已隐藏]");
        assert_eq!(display["env"]["OPENAI_API_KEY"], "[已隐藏]");
        assert_eq!(display["env"]["NORMAL_SETTING"], "safe");
        assert!(!serde_json::to_string(display)
            .unwrap()
            .contains("fixture-secret-do-not-expose"));
        config["args"][1] = Value::from("part-2.gguf");
        fs::write(&profile.config_path, serde_json::to_vec(&config).unwrap()).unwrap();
        assert_ne!(
            first.model_group_key,
            inspect(&profile).candidate.model_group_key
        );
    }

    #[test]
    fn runtime_remains_installed_when_old_model_configuration_needs_repair() {
        let (_temp, profile) = fixture();
        fs::remove_file(Path::new(&profile.install_dir).join("part-1.gguf")).unwrap();
        assert_eq!(
            inspect(&profile).candidate.availability.as_deref(),
            Some("repair")
        );
        // Windows TEMP can use an 8.3 alias (ADMINI~1); discovery reports the
        // canonical installation path rather than the spelling in the profile.
        let expected_root = canonical_local(Path::new(&profile.install_dir)).unwrap();
        let runtimes = discover_runtimes(std::slice::from_ref(&profile));
        let runtime = runtimes
            .iter()
            .find(|runtime| Path::new(&runtime.install_dir) == expected_root)
            .unwrap();
        assert_eq!(runtime.readiness, "ready");
        assert_eq!(runtime.profile.id, profile.id);
        assert!(!runtime.python_path.is_empty());
        // Even an unusable old config does not hide the detected runtime.
        fs::write(&profile.config_path, b"{invalid json").unwrap();
        assert!(discover_runtimes(std::slice::from_ref(&profile))
            .iter()
            .any(|runtime| Path::new(&runtime.install_dir) == expected_root));
    }

    #[test]
    fn import_revalidates_and_preserves_source_and_shared_settings_and_is_idempotent() {
        let (temp, profile) = fixture();
        let mut lan_source = read_json(Path::new(&profile.config_path)).unwrap();
        lan_source["host"] = Value::from("0.0.0.0");
        storage::write(&profile, &lan_source).unwrap();
        let source = fs::read(&profile.config_path).unwrap();
        let shared =
            Path::new(&profile.config_path).with_file_name("strata-fixture.shared-settings.json");
        fs::write(&shared, br#"{"reasoning_effort":"high","temperature":0.7}"#).unwrap();
        let state = temp.path().join("state");
        fs::create_dir(&state).unwrap();
        let mut candidate = inspect(&profile).candidate;
        candidate.id = "../../outside".into();
        candidate.name = "forged".into();
        candidate.model_path = "forged".into();
        candidate.model_bytes = Some(1);
        candidate.python_path = "forged-python".into();
        let imported = prepare_import(&candidate, &state, None).unwrap();
        assert_eq!(imported.profile.name, "fixture-model");
        assert_eq!(
            read_json(Path::new(&imported.profile.config_path)).unwrap()["host"],
            "0.0.0.0"
        );
        assert!(imported.profile.base_url.starts_with("http://127.0.0.1:"));
        assert!(imported.profile.id.starts_with("local-"));
        assert!(Path::new(&imported.profile.config_path)
            .starts_with(dunce::canonicalize(&state).unwrap()));
        assert_eq!(fs::read(&profile.config_path).unwrap(), source);
        assert_eq!(
            read_json(
                &Path::new(&imported.profile.config_path)
                    .with_file_name("config.shared-settings.json")
            )
            .unwrap()["reasoning_effort"],
            "high"
        );
        let mut updated = read_json(Path::new(&imported.profile.config_path)).unwrap();
        updated["sampling"]["temperature"] = Value::from(0.25);
        updated["port"] = Value::from(23123);
        storage::write(&imported.profile, &updated).unwrap();
        let again = prepare_import(&candidate, &state, None).unwrap();
        assert_eq!(again.profile.id, imported.profile.id);
        assert_eq!(again.profile.base_url, "http://127.0.0.1:23123");
        assert_eq!(
            read_json(Path::new(&again.profile.config_path)).unwrap()["sampling"]["temperature"],
            0.25
        );
        assert_eq!(
            read_json(Path::new(&again.profile.config_path)).unwrap()["custom"]["preserve"],
            true
        );
    }

    #[test]
    fn reimport_after_the_private_copy_was_deleted_starts_from_the_source() {
        let (temp, profile) = fixture();
        let state = temp.path().join("state");
        fs::create_dir(&state).unwrap();
        let candidate = inspect(&profile).candidate;
        let imported = prepare_import(&candidate, &state, None).unwrap();
        let private = PathBuf::from(&imported.profile.config_path);
        let fresh = read_json(&private).unwrap();
        // Deleting the configuration archives config.json but leaves import.json behind.
        fs::remove_file(&private).unwrap();
        assert!(private.with_file_name("import.json").is_file());
        let again = prepare_import(&candidate, &state, None).unwrap();
        assert_eq!(again.profile.id, imported.profile.id);
        assert_eq!(
            read_json(Path::new(&again.profile.config_path)).unwrap(),
            fresh
        );
    }

    #[test]
    fn changed_candidate_assets_are_rejected_at_import_and_source_is_not_modified() {
        let (temp, profile) = fixture();
        let candidate = inspect(&profile).candidate;
        let state = temp.path().join("state");
        fs::create_dir(&state).unwrap();
        fs::remove_file(Path::new(&profile.install_dir).join("part-1.gguf")).unwrap();
        assert!(prepare_import(&candidate, &state, None)
            .err()
            .unwrap()
            .contains("模型文件不存在"));
        assert!(!state.join("imports").exists());
        assert!(Path::new(&profile.config_path).is_file());
    }

    #[test]
    fn invalid_args_and_unrelated_json_are_not_importable_configs() {
        let (_temp, profile) = fixture();
        let mut value = read_json(Path::new(&profile.config_path)).unwrap();
        value["args"] = serde_json::json!(["--native", "part-1.gguf", "--native", "part-2.gguf"]);
        fs::write(&profile.config_path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(inspect_config(
            Path::new(&profile.install_dir),
            Path::new(&profile.config_path),
            Some(&profile.python_path),
            None,
            "fixture",
            &mut PythonCache::default()
        )
        .is_err());
        fs::write(&profile.config_path, b"{}").unwrap();
        assert!(inspect_config(
            Path::new(&profile.install_dir),
            Path::new(&profile.config_path),
            Some(&profile.python_path),
            None,
            "fixture",
            &mut PythonCache::default()
        )
        .is_err());
    }

    #[test]
    fn notepad_bom_and_port_reservation_are_handled() {
        let (_temp, profile) = fixture();
        let bytes = fs::read(&profile.config_path).unwrap();
        fs::write(
            &profile.config_path,
            [vec![0xef, 0xbb, 0xbf], bytes].concat(),
        )
        .unwrap();
        assert_eq!(
            inspect(&profile).candidate.availability.as_deref(),
            Some("ready")
        );
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        assert!(unused_port(Some(listener.local_addr().unwrap().port())).is_err());
        assert!(unused_port(Some(0)).is_err());
        assert!(unused_port(None).unwrap() >= 18100);
    }

    #[test]
    fn process_arguments_need_exact_module_and_absolute_config() {
        let (_temp, profile) = fixture();
        let args: Vec<_> = [
            profile.python_path.as_str(),
            "-u",
            "-m",
            "serve.server",
            "--config",
            profile.config_path.as_str(),
            "--port",
            "18099",
        ]
        .iter()
        .map(|v| v.to_string())
        .collect();
        assert_eq!(hint_from_args(&args).unwrap().port, Some(18099));
        let mut wrong = args.clone();
        wrong[3] = "unrelated.server".into();
        assert!(hint_from_args(&wrong).is_none());
        let mut relative = args;
        relative[5] = "strata.json".into();
        assert!(hint_from_args(&relative).is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn running_installation_processes_reports_pid_and_name_only_for_this_root() {
        let _census = PROCESS_CENSUS.lock().unwrap_or_else(|e| e.into_inner());
        let (temp, profile) = fixture();
        let root = canonical_local(Path::new(&profile.install_dir)).unwrap();
        fs::write(root.join("setup.py"), b"").unwrap();
        fs::create_dir_all(root.join("serve")).unwrap();
        fs::write(
            root.join("serve/server.py"),
            b"import time\ntime.sleep(60)\n",
        )
        .unwrap();
        let config = root.join("busy.json");
        fs::write(&config, b"{}").unwrap();
        struct Reap(std::process::Child);
        impl Drop for Reap {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let Ok(child) = std::process::Command::new("python3")
            .current_dir(&root)
            .args(["-m", "serve.server", "--config"])
            .arg(&config)
            .spawn()
        else {
            return;
        };
        let child = Reap(child);
        let pid = child.0.id();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let found = loop {
            let found = running_installation_processes(&root).unwrap();
            if !found.is_empty() || std::time::Instant::now() >= deadline {
                break found;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        };
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].pid, pid);
        assert!(found[0].name.starts_with("python"), "{found:?}");
        assert_eq!(found[0].config, config);
        assert!(has_running_installation(&root).unwrap());
        // Another directory is not blamed for this process.
        let other = temp.path().join("other-runtime");
        fs::create_dir_all(other.join("serve")).unwrap();
        fs::write(other.join("setup.py"), b"").unwrap();
        fs::write(other.join("serve/server.py"), b"").unwrap();
        assert!(running_installation_processes(&other).unwrap().is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_lists_a_running_strata_server_without_proc() {
        // macOS has no /proc: the census reads argv from the system process table.
        let (temp, _profile) = fixture();
        let config = dunce::canonicalize(temp.path())
            .unwrap()
            .join("census.json");
        fs::write(&config, b"{}").unwrap();
        let mut child = std::process::Command::new("python3")
            .args([
                "-c",
                "import time; time.sleep(30)",
                "-m",
                "serve.server",
                "--config",
            ])
            .arg(&config)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("python3 is required for this macOS census test");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let found = loop {
            let hints = process_hints().expect("macOS must be able to list processes");
            if hints.iter().any(|hint| hint.config == config) {
                break true;
            }
            if std::time::Instant::now() > deadline {
                break false;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        };
        let _ = child.kill();
        let _ = child.wait();
        assert!(found, "the running server's command line was not listed");
    }

    #[test]
    fn observed_config_outside_runtime_precedes_full_directory_scan() {
        let (temp, profile) = fixture();
        let root = canonical_local(Path::new(&profile.install_dir)).unwrap();
        fs::create_dir(root.join("configs")).unwrap();
        for index in 0..MAX_CONFIGS {
            fs::write(root.join(format!("strata-variant-{index:03}.json")), b"{}").unwrap();
            fs::write(
                root.join("configs")
                    .join(format!("strata-variant-{index:03}.json")),
                b"{}",
            )
            .unwrap();
        }
        let observed = temp.path().join("managed-config.json");
        fs::write(&observed, fs::read(&profile.config_path).unwrap()).unwrap();
        let hint = ProcessHint {
            config: observed.clone(),
            python: PathBuf::from(&profile.python_path),
            port: Some(18099),
            host: None,
            pid: None,
            image: None,
        };
        assert_eq!(canonical_local(&hint_root(&hint).unwrap()).unwrap(), root);
        assert_eq!(config_paths(&root).len(), MAX_CONFIGS);
        let paths = prioritized_config_paths(&root, &[profile], &[hint]);
        assert_eq!(paths.first(), Some(&observed));
        assert!(paths
            .into_iter()
            .take(MAX_CONFIGS)
            .any(|path| path == observed));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "explicit live running-service read-only verification"]
    fn live_running_service_reports_exact_config_without_changing_process_or_files() {
        let required = |name| {
            std::env::var(name).unwrap_or_else(|_| panic!("set {name} for explicit verification"))
        };
        let root = canonical_local(Path::new(&required("STRATA_DISCOVERY_READONLY_ROOT"))).unwrap();
        let config =
            canonical_local(Path::new(&required("STRATA_DISCOVERY_READONLY_CONFIG"))).unwrap();
        let port: u16 = required("STRATA_DISCOVERY_READONLY_PORT").parse().unwrap();
        let expected_pid: u32 = required("STRATA_DISCOVERY_READONLY_PID").parse().unwrap();
        let value = read_json(&config).unwrap();
        let profile = ServiceProfile {
            id: "read-only-running-verification".into(),
            name: "Read-only verification".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            install_dir: root.to_string_lossy().into(),
            python_path: root
                .join(".venv/Scripts/python.exe")
                .to_string_lossy()
                .into(),
            config_path: config.to_string_lossy().into(),
            managed: false,
        };
        let before = external::detect(&profile)
            .unwrap()
            .expect("expected a verified live process");
        assert_eq!(before.pid, expected_pid);
        let mut files = config_paths(&root);
        files.push(config.clone());
        let snapshots: Vec<_> = files
            .into_iter()
            .map(|path| {
                let bytes = fs::read(&path).unwrap();
                (path, bytes)
            })
            .collect();
        let candidates = discover_local(&[], &[]).unwrap();
        let running: Vec<_> = candidates
            .iter()
            .filter(|candidate| candidate.running == Some(true))
            .collect();
        let observed = running
            .iter()
            .find(|candidate| {
                canonical_local(Path::new(&candidate.config_path))
                    .as_ref()
                    .is_ok_and(|path| path == &config)
            })
            .expect("exact runtime command-line configuration must be detected");
        assert_eq!(observed.pid, Some(expected_pid));
        assert_eq!(observed.detected_port, Some(port));
        assert_eq!(
            observed.config.as_ref().unwrap()["model_name"],
            value["model_name"]
        );
        assert!(candidates
            .iter()
            .filter(|candidate| {
                canonical_local(Path::new(&candidate.install_dir))
                    .as_ref()
                    .is_ok_and(|path| path == &root)
                    && canonical_local(Path::new(&candidate.config_path))
                        .as_ref()
                        .is_ok_and(|path| path != &config)
            })
            .all(|candidate| candidate.running != Some(true)));
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let health: Value = runtime.block_on(async {
            reqwest::Client::new()
                .get(format!("{}/health", profile.base_url))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json()
                .await
                .unwrap()
        });
        assert_eq!(health["service"], "strata");
        assert_eq!(health["status"], "ok");
        assert_eq!(health["loaded"], true);
        assert_eq!(health["model"], value["model_name"]);
        let after = external::detect(&profile).unwrap().unwrap();
        assert_eq!((after.pid, after.created), (before.pid, before.created));
        before.revalidate(&profile).unwrap();
        for (path, bytes) in snapshots {
            assert_eq!(fs::read(path).unwrap(), bytes);
        }
        println!(
            "{}",
            serde_json::json!({
                "installDir": observed.install_dir, "configPath": observed.config_path,
                "pid": observed.pid, "port": observed.detected_port, "running": observed.running,
                "model": health["model"], "loaded": health["loaded"], "unchanged": true,
            })
        );
    }

    #[test]
    #[ignore = "explicit live read-only installation verification"]
    fn live_installation_discovery_is_read_only() {
        let root = PathBuf::from(
            std::env::var_os("STRATA_DISCOVERY_READONLY_ROOT")
                .expect("set an explicit local Strata directory"),
        );
        let configs: Vec<_> = config_paths(&root)
            .into_iter()
            .filter_map(|path| fs::read(&path).ok().map(|bytes| (path, bytes)))
            .collect();
        let candidates = discover_local(std::slice::from_ref(&root), &[]).unwrap();
        let selected: Vec<_> = candidates
            .into_iter()
            .filter(|candidate| Path::new(&candidate.install_dir) == root)
            .collect();
        assert!(!selected.is_empty());
        assert!(selected
            .iter()
            .any(|candidate| candidate.availability.as_deref() == Some("ready")));
        for (path, bytes) in configs {
            assert_eq!(fs::read(path).unwrap(), bytes);
        }
        println!("{}", serde_json::to_string_pretty(&selected).unwrap());
    }

    struct EnvRestore {
        key: &'static str,
        previous: Option<std::ffi::OsString>,
    }

    impl EnvRestore {
        fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
            let previous = std::env::var_os(key);
            // SAFETY: discovery tests run single-threaded in this crate's unit suite.
            unsafe { std::env::set_var(key, value) };
            Self { key, previous }
        }
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => unsafe { std::env::set_var(self.key, value) },
                None => unsafe { std::env::remove_var(self.key) },
            }
        }
    }

    fn write_install_root(root: &Path) {
        fs::create_dir_all(root.join("serve")).unwrap();
        fs::create_dir_all(root.join("engine")).unwrap();
        fs::create_dir_all(root.join("tokenizer")).unwrap();
        fs::write(root.join("setup.py"), b"# fixture").unwrap();
        fs::write(root.join("serve/server.py"), b"# fixture").unwrap();
        fs::write(root.join("engine/strata.exe"), b"fixture").unwrap();
        fs::write(
            root.join("engine/BUILD.json"),
            br#"{"version":"fixture-data-dir"}"#,
        )
        .unwrap();
        fs::write(root.join("tokenizer/vocab.json"), b"{}").unwrap();
        fs::write(root.join("tokenizer/merges.txt"), b"").unwrap();
        fs::write(root.join("tokenizer/token_type.json"), b"[]").unwrap();
    }

    fn write_model_config(install: &Path, config: &Path, model_rel: &str) {
        if let Some(parent) = config.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let model = install.join(model_rel);
        if let Some(parent) = model.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&model, b"0123456789").unwrap();
        write_json_new(
            config,
            &serde_json::json!({
                "exe": install.join("engine/strata.exe"),
                "cwd": install,
                "args": ["--native", model],
                "tokenizer": install.join("tokenizer"),
                "model_name": "ud-q4-k-xl",
                "port": 18088
            }),
        )
        .unwrap();
    }

    #[test]
    fn data_directory_from_official_settings_discovers_install_configs() {
        let temp = tempfile::tempdir().unwrap();
        let install = temp.path().join("Strata");
        let data = temp.path().join("strata-data");
        write_install_root(&install);
        fs::create_dir_all(data.join("models/UD-Q4_K_XL")).unwrap();
        fs::write(data.join("models/UD-Q4_K_XL/weights.gguf"), b"0123456789").unwrap();
        write_model_config(
            &install,
            &install.join("strata-ud-q4_k_xl.json"),
            "models/placeholder.gguf",
        );
        let config_home = temp.path().join("config-home");
        fs::create_dir_all(config_home.join("strata")).unwrap();
        fs::create_dir_all(config_home.join("Strata")).unwrap();
        let settings = serde_json::json!({
            "data_dir": &data,
            "installs": [&install]
        });
        fs::write(
            config_home.join("strata/settings.json"),
            serde_json::to_vec_pretty(&settings).unwrap(),
        )
        .unwrap();
        fs::write(
            config_home.join("Strata/settings.json"),
            serde_json::to_vec_pretty(&settings).unwrap(),
        )
        .unwrap();
        let _xdg = EnvRestore::set("XDG_CONFIG_HOME", &config_home);
        let _appdata = EnvRestore::set("APPDATA", &config_home);
        let candidates = discover_local(std::slice::from_ref(&data), &[]).unwrap();
        assert!(
            candidates.iter().any(|candidate| {
                candidate.source.as_deref() == Some("data-directory")
                    && canonical_local(Path::new(&candidate.config_path))
                        .ok()
                        .as_ref()
                        == Some(&canonical_local(&install.join("strata-ud-q4_k_xl.json")).unwrap())
            }),
            "expected install config via settings-linked data dir, got {candidates:?}"
        );
    }

    #[test]
    fn data_directory_sibling_install_is_discovered() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("AI");
        let install = parent.join("Strata");
        let data = parent.join("Strata-data");
        write_install_root(&install);
        fs::create_dir_all(data.join("models")).unwrap();
        write_model_config(&install, &install.join("strata-sibling.json"), "part.gguf");
        let candidates = discover_local(std::slice::from_ref(&data), &[]).unwrap();
        assert!(
            candidates.iter().any(|candidate| {
                candidate.name == "ud-q4-k-xl"
                    && candidate.source.as_deref() == Some("data-directory")
            }),
            "expected sibling install discovery, got {candidates:?}"
        );
    }

    #[test]
    fn data_directory_with_run_configs_resolves_install_from_cwd() {
        let temp = tempfile::tempdir().unwrap();
        let install = temp.path().join("opt/strata");
        let data = temp.path().join("strata-data");
        write_install_root(&install);
        fs::create_dir_all(data.join("models")).unwrap();
        write_model_config(
            &install,
            &data.join("strata-from-data.json"),
            "models/weights.gguf",
        );
        // Point the native weight into the data directory the user added.
        let mut value = read_json(&data.join("strata-from-data.json")).unwrap();
        value["args"] = serde_json::json!([
            "--native",
            data.join("models/weights.gguf").to_string_lossy(),
        ]);
        fs::write(data.join("models/weights.gguf"), b"0123456789").unwrap();
        fs::write(
            data.join("strata-from-data.json"),
            serde_json::to_vec_pretty(&value).unwrap(),
        )
        .unwrap();
        let candidates = discover_local(std::slice::from_ref(&data), &[]).unwrap();
        assert!(
            candidates.iter().any(|candidate| {
                canonical_local(Path::new(&candidate.config_path))
                    .ok()
                    .as_ref()
                    == Some(&canonical_local(&data.join("strata-from-data.json")).unwrap())
                    && canonical_local(Path::new(&candidate.install_dir))
                        .ok()
                        .as_ref()
                        == Some(&canonical_local(&install).unwrap())
            }),
            "expected config living in the data dir, got {candidates:?}"
        );
    }

    #[test]
    fn config_exe_under_engine_cuda12_is_ready() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Strata");
        fs::create_dir_all(root.join("serve")).unwrap();
        fs::create_dir_all(root.join("engine_cuda12")).unwrap();
        fs::create_dir_all(root.join("tokenizer")).unwrap();
        fs::write(root.join("setup.py"), b"# fixture").unwrap();
        fs::write(root.join("serve/server.py"), b"# fixture").unwrap();
        fs::write(root.join("engine_cuda12/strata.exe"), b"fixture").unwrap();
        fs::write(
            root.join("engine_cuda12/BUILD.json"),
            br#"{"version":"0.1.44.1","backend":"cuda","cuda":"12.9"}"#,
        )
        .unwrap();
        fs::write(root.join("tokenizer/vocab.json"), b"{}").unwrap();
        fs::write(root.join("tokenizer/merges.txt"), b"").unwrap();
        fs::write(root.join("tokenizer/token_type.json"), b"[]").unwrap();
        fs::write(root.join("model.gguf"), b"0123456789").unwrap();
        let config = root.join("strata-cuda12.json");
        write_json_new(
            &config,
            &serde_json::json!({
                "exe": "engine_cuda12/strata.exe",
                "cwd": root,
                "args": ["--native", root.join("model.gguf")],
                "tokenizer": root.join("tokenizer"),
                "model_name": "cuda12-model",
                "port": 18091
            }),
        )
        .unwrap();
        // No classic engine/ directory at all.
        assert!(!root.join("engine").exists());
        let candidates = discover_local(std::slice::from_ref(&root), &[]).unwrap();
        let hit = candidates
            .iter()
            .find(|c| c.name == "cuda12-model")
            .unwrap_or_else(|| panic!("expected cuda12-model, got {candidates:?}"));
        assert_eq!(
            hit.availability.as_deref(),
            Some("ready"),
            "reason={:?}",
            hit.reason
        );
        assert_eq!(hit.runtime_version.as_deref(), Some("0.1.44.1"));
        assert!(hit.reason.is_none(), "{:?}", hit.reason);
    }

    #[test]
    fn config_exe_under_official_engine_cuda12_hyphen_is_ready() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Strata");
        fs::create_dir_all(root.join("serve")).unwrap();
        fs::create_dir_all(root.join("engine-cuda12")).unwrap();
        fs::create_dir_all(root.join("tokenizer")).unwrap();
        fs::write(root.join("setup.py"), b"# fixture").unwrap();
        fs::write(root.join("serve/server.py"), b"# fixture").unwrap();
        fs::write(root.join("engine-cuda12/strata.exe"), b"fixture").unwrap();
        fs::write(
            root.join("engine-cuda12/BUILD.json"),
            br#"{"version":"0.1.44.1","backend":"cuda","cuda":"12.9"}"#,
        )
        .unwrap();
        fs::write(root.join("tokenizer/vocab.json"), b"{}").unwrap();
        fs::write(root.join("tokenizer/merges.txt"), b"").unwrap();
        fs::write(root.join("tokenizer/token_type.json"), b"[]").unwrap();
        fs::write(root.join("model.gguf"), b"0123456789").unwrap();
        write_json_new(
            &root.join("strata-official-cuda12.json"),
            &serde_json::json!({
                "exe": "engine-cuda12/strata.exe",
                "cwd": root,
                "args": ["--native", root.join("model.gguf")],
                "tokenizer": root.join("tokenizer"),
                "model_name": "official-cuda12",
                "port": 18092
            }),
        )
        .unwrap();
        assert!(!root.join("engine").exists());
        let candidates = discover_local(std::slice::from_ref(&root), &[]).unwrap();
        let hit = candidates
            .iter()
            .find(|c| c.name == "official-cuda12")
            .unwrap_or_else(|| panic!("expected official-cuda12, got {candidates:?}"));
        assert_eq!(
            hit.availability.as_deref(),
            Some("ready"),
            "reason={:?}",
            hit.reason
        );
        assert_eq!(hit.runtime_version.as_deref(), Some("0.1.44.1"));
    }

    #[test]
    fn config_exe_pointing_at_a_missing_engine_needs_repair_even_if_another_engine_exists() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Strata");
        fs::create_dir_all(root.join("serve")).unwrap();
        fs::create_dir_all(root.join("engine_cuda12")).unwrap();
        fs::create_dir_all(root.join("tokenizer")).unwrap();
        fs::write(root.join("setup.py"), b"# fixture").unwrap();
        fs::write(root.join("serve/server.py"), b"# fixture").unwrap();
        fs::write(root.join("engine_cuda12/strata.exe"), b"fixture").unwrap();
        fs::write(
            root.join("engine_cuda12/BUILD.json"),
            br#"{"version":"0.1.44.1","backend":"cuda","cuda":"12.9"}"#,
        )
        .unwrap();
        fs::write(root.join("tokenizer/vocab.json"), b"{}").unwrap();
        fs::write(root.join("tokenizer/merges.txt"), b"").unwrap();
        fs::write(root.join("tokenizer/token_type.json"), b"[]").unwrap();
        fs::write(root.join("model.gguf"), b"0123456789").unwrap();
        write_json_new(
            &root.join("strata-legacy-exe.json"),
            &serde_json::json!({
                "exe": "engine/strata.exe",
                "cwd": root,
                "args": ["--native", root.join("model.gguf")],
                "tokenizer": root.join("tokenizer"),
                "model_name": "legacy-exe-path",
                "port": 18093
            }),
        )
        .unwrap();
        assert!(!root.join("engine").exists());
        let candidates = discover_local(std::slice::from_ref(&root), &[]).unwrap();
        let hit = candidates
            .iter()
            .find(|c| c.name == "legacy-exe-path")
            .unwrap_or_else(|| panic!("expected legacy-exe-path, got {candidates:?}"));
        // Upstream server.py starts exactly engine/strata.exe; the engine in
        // engine_cuda12/ does not make this configuration startable (#78:
        // FileNotFoundError [WinError 2] on the first /load).
        assert_eq!(
            hit.availability.as_deref(),
            Some("repair"),
            "reason={:?}",
            hit.reason
        );
        let reason = hit.reason.as_deref().unwrap();
        assert!(reason.contains("配置里的引擎路径不存在"), "{reason}");
        assert!(reason.contains("engine_cuda12"), "{reason}");
        assert_eq!(hit.runtime_version.as_deref(), Some("0.1.44.1"));
    }

    /// Upstream 0.2.0-beta desktop install (momo's report): the Control bundle under
    /// `D:\Program Files\Strata\control`, the run config in the data folder `D:\Strata`, and
    /// `"exe": "component:strata-engine"` naming the package in
    /// `%LOCALAPPDATA%\Strata\components\engine\0.1.45-windows-x86_64-cuda`.
    fn component_engine_fixture(temp: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let control = temp.join("Program Files/Strata/control");
        let data = temp.join("D/Strata");
        let components = temp.join("AppData/Local/Strata/components");
        fs::create_dir_all(control.join("serve")).unwrap();
        fs::write(control.join("setup.py"), b"# fixture").unwrap();
        fs::write(control.join("serve/server.py"), b"# fixture").unwrap();
        let pack = data.join("models/qwen3.8-flash-next-iq3_s");
        fs::create_dir_all(pack.join("tokenizer")).unwrap();
        for (name, body) in [
            ("vocab.json", "{}"),
            ("merges.txt", ""),
            ("token_type.json", "[]"),
        ] {
            fs::write(pack.join("tokenizer").join(name), body).unwrap();
        }
        fs::write(pack.join("model.gguf"), b"0123456789").unwrap();
        write_json_new(
            &data.join("strata-iq3_s.json"),
            &serde_json::json!({
                "exe": "component:strata-engine",
                "cwd": control,
                "args": ["--native", pack.join("model.gguf"), "--max-context", "32768"],
                "tokenizer": pack.join("tokenizer"),
                "model_name": "qwen3.8-flash-next-iq3_s",
                "port": 18094
            }),
        )
        .unwrap();
        (control, data, components)
    }

    fn component_candidate(data: &Path) -> LocalCandidate {
        discover_local(&[data.to_owned()], &[])
            .unwrap()
            .into_iter()
            .find(|c| c.name == "qwen3.8-flash-next-iq3_s")
            .expect("the component config is listed")
    }

    #[test]
    fn component_engine_config_from_the_upstream_app_is_ready() {
        let temp = tempfile::tempdir().unwrap();
        let (_, data, components) = component_engine_fixture(temp.path());
        let package = components.join("engine/0.1.45-windows-x86_64-cuda");
        fs::create_dir_all(&package).unwrap();
        let entry = if cfg!(windows) {
            "strata.exe"
        } else {
            "strata"
        };
        fs::write(package.join(entry), b"engine").unwrap();
        fs::write(
            package.join("engine-component.json"),
            serde_json::json!({"schema_version": 2, "id": "strata-engine", "version": "0.1.45",
                "platform": crate::component_engine::host_platform(), "backend": "cuda",
                "entrypoint": entry, "build_id": "fixture", "files": []})
            .to_string(),
        )
        .unwrap();
        let hit = crate::component_engine::with_components_dir(&components, || {
            component_candidate(&data)
        });
        let reason = hit.reason.clone().unwrap_or_default();
        assert!(!reason.contains("引擎"), "{reason}");
        assert_eq!(hit.runtime_version.as_deref(), Some("0.1.45"));
    }

    #[test]
    fn component_engine_config_without_a_package_says_to_update_the_engine() {
        let temp = tempfile::tempdir().unwrap();
        let (_, data, components) = component_engine_fixture(temp.path());
        let hit = crate::component_engine::with_components_dir(&components, || {
            component_candidate(&data)
        });
        assert_eq!(hit.availability.as_deref(), Some("repair"));
        let reason = hit.reason.as_deref().unwrap();
        assert!(reason.contains("component:strata-engine"), "{reason}");
        assert!(reason.contains("更新引擎"), "{reason}");
        assert!(
            !reason.contains("引擎文件不存在，请修复运行环境"),
            "{reason}"
        );
    }

    #[test]
    fn release_version_prefers_the_marker_then_the_shipped_product_version() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        // 0.2+ runtime: the engine number is not the release.
        assert_eq!(release_version(root, Some("0.1.47")), None);
        fs::create_dir_all(root.join("strata_cli")).unwrap();
        fs::write(
            root.join("strata_cli/__init__.py"),
            "SCHEMA_VERSION = 1\n#: comment\nPRODUCT_VERSION = \"0.2.2\"\n",
        )
        .unwrap();
        assert_eq!(
            release_version(root, Some("0.1.47")).as_deref(),
            Some("0.2.2")
        );
        fs::write(
            root.join(RELEASE_MARKER),
            r#"{"version":"0.2.3","revision":"x"}"#,
        )
        .unwrap();
        assert_eq!(
            release_version(root, Some("0.1.48")).as_deref(),
            Some("0.2.3")
        );
        // Before 0.1.45 the release carried the engine's number.
        let legacy = tempfile::tempdir().unwrap();
        assert_eq!(
            release_version(legacy.path(), Some("0.1.44.1")).as_deref(),
            Some("0.1.44.1")
        );
        assert_eq!(release_version(legacy.path(), Some("0.1.45.3")), None);
        assert_eq!(
            product_version("PRODUCT_VERSION = \"0.2.0-beta\"").as_deref(),
            Some("0.2.0-beta")
        );
        assert_eq!(product_version("PRODUCT_VERSION = version()"), None);
    }

    #[test]
    fn runtime_version_reads_build_json_under_engine_cuda12_without_classic_engine() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Strata");
        fs::create_dir_all(root.join("serve")).unwrap();
        fs::create_dir_all(root.join("engine_cuda12")).unwrap();
        fs::write(root.join("setup.py"), b"# fixture").unwrap();
        fs::write(root.join("serve/server.py"), b"# fixture").unwrap();
        fs::write(
            root.join("engine_cuda12/BUILD.json"),
            br#"{"version":"cuda12-only"}"#,
        )
        .unwrap();
        assert!(!root.join("engine").exists());
        assert_eq!(runtime_version(&root, None).as_deref(), Some("cuda12-only"));
    }

    #[test]
    fn unrelated_directory_without_data_markers_is_not_expanded_to_siblings() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("workspace");
        let install = parent.join("Strata");
        let other = parent.join("notes");
        write_install_root(&install);
        write_model_config(&install, &install.join("strata-hidden.json"), "part.gguf");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("readme.txt"), b"not strata").unwrap();
        let candidates = discover_local(std::slice::from_ref(&other), &[]).unwrap();
        assert!(
            candidates
                .iter()
                .filter(|candidate| {
                    canonical_local(Path::new(&candidate.install_dir))
                        .ok()
                        .as_ref()
                        == Some(&canonical_local(&install).unwrap())
                })
                .count()
                == 0,
            "random folders must not pull in sibling installs: {candidates:?}"
        );
    }

    #[test]
    fn launcher_python_reads_strata_run_scripts() {
        use crate::launcher_env::launcher_python_in;
        let bat = "@echo off\r\ntitle Strata Q2_0\r\ncd /d \"C:\\Strata\"\r\n\"C:\\Strata\\.venv\\Scripts\\python.exe\" \"C:\\Strata\\serve\\server.py\" \"--engine\" \"strata\" \"--config\" \"C:\\Strata\\strata-q2_0.json\" \"--port\" \"8080\"\r\nif errorlevel 1 pause\r\n";
        #[cfg(windows)]
        assert_eq!(
            launcher_python_in(Path::new("C:\\Strata"), bat),
            Some(PathBuf::from("C:\\Strata\\.venv\\Scripts\\python.exe"))
        );
        #[cfg(not(windows))]
        assert!(launcher_python_in(Path::new("/opt/strata"), bat).is_some());
        let sh = "#!/bin/sh\ncd \"/opt/strata\"\nexec \"/opt/strata/.venv/bin/python\" \"/opt/strata/serve/server.py\" \"--engine\" \"strata\"\n";
        #[cfg(not(windows))]
        assert_eq!(
            launcher_python_in(Path::new("/opt/strata"), sh),
            Some(PathBuf::from("/opt/strata/.venv/bin/python"))
        );
        let _ = sh;
        assert_eq!(
            launcher_python_in(
                Path::new("/opt/strata"),
                "\"/usr/bin/python3\" tools/other.py\n"
            ),
            None
        );
        assert_eq!(
            launcher_python_in(Path::new("/opt/strata"), "\"/bin/rm\" serve/server.py\n"),
            None
        );
    }

    #[cfg(unix)]
    fn fake_python(path: &Path, missing: &str) {
        use std::os::unix::fs::PermissionsExt;
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            path,
            format!("#!/bin/sh\ncase \"$*\" in\n  *find_spec*) echo '{missing}' ;;\n  *version_info*) echo ready ;;\n  *) exit 1 ;;\nesac\n"),
        )
        .unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    fn dependency_root() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("tools")).unwrap();
        fs::create_dir_all(temp.path().join("serve")).unwrap();
        fs::write(temp.path().join("tools/strata_tokenizer.py"), b"# fixture").unwrap();
        fs::write(temp.path().join("serve/frontend.py"), b"# fixture").unwrap();
        temp
    }

    #[cfg(unix)]
    #[test]
    fn install_launcher_python_wins_over_incomplete_saved_python() {
        let temp = dependency_root();
        let root = canonical_local(temp.path()).unwrap();
        let system = root.join("system/python3");
        fake_python(&system, r#"["regex", "jinja2"]"#);
        let private = root.join("private-env/bin/python");
        fake_python(&private, "[]");
        fs::write(
            root.join("run-q2_0.sh"),
            format!(
                "#!/bin/sh\ncd \"{}\"\nexec \"{}\" \"{}\" \"--engine\" \"strata\"\n",
                root.display(),
                private.display(),
                root.join("serve/server.py").display()
            ),
        )
        .unwrap();
        let choice = find_python(
            &root,
            Some(&system.to_string_lossy()),
            None,
            &mut PythonCache::default(),
        )
        .unwrap();
        assert_eq!(choice.path, private);
        assert!(choice.missing.is_empty());
        assert_eq!(missing_modules_reason(&choice), None);
    }

    #[cfg(unix)]
    #[test]
    fn venv_python_symlink_is_probed_as_the_venv_and_reasons_name_it() {
        let temp = dependency_root();
        let root = canonical_local(temp.path()).unwrap();
        let base = root.join("base/python3.12");
        fake_python(&base, r#"["jinja2"]"#);
        fs::create_dir_all(root.join(".venv/bin")).unwrap();
        std::os::unix::fs::symlink(&base, root.join(".venv/bin/python")).unwrap();
        let choice = find_python(&root, None, None, &mut PythonCache::default()).unwrap();
        // The venv path is kept, not its resolved base interpreter, so the
        // venv's own site-packages are what the import check sees.
        if choice.path.starts_with(&root) {
            assert_eq!(choice.path, root.join(".venv/bin/python"));
            let reason = missing_modules_reason(&choice).unwrap();
            assert!(reason.contains("jinja2"), "{reason}");
            assert!(reason.contains(".venv/bin/python"), "{reason}");
            assert!(reason.contains("update.sh"), "{reason}");
        } else {
            // The machine's own Python had every module and is a valid last resort.
            assert!(choice.missing.is_empty());
        }
    }

    #[cfg(unix)]
    #[test]
    fn failed_dependency_check_is_not_reported_as_missing_modules() {
        let choice = PythonChoice {
            path: PathBuf::from("/opt/strata/.venv/bin/python"),
            missing: vec![DEPENDENCY_CHECK_FAILED.into()],
        };
        let reason = missing_modules_reason(&choice).unwrap();
        assert!(reason.contains("检测失败或超时"), "{reason}");
        assert!(!reason.contains("依赖缺失"), "{reason}");
    }
}
