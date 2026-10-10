//! Bounded, local-only installation discovery and non-destructive import.
//!
//! A candidate is a presentation record, never a permission to execute its paths.
//! Import re-reads every path and config. The user's repository and model assets
//! remain in place; only the application's config and shared-settings are copied.
use crate::{external, storage, types::ServiceProfile};
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_version: Option<String>,
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

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportManifest {
    schema_version: u32,
    candidate_id: String,
    install_dir: String,
    original_config_path: String,
}

#[derive(Clone)]
struct ProcessHint {
    config: PathBuf,
    python: PathBuf,
    port: Option<u16>,
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

fn runtime_version(root: &Path, exe: Option<&Path>) -> Option<String> {
    let paths = [
        exe.and_then(Path::parent).map(|p| p.join("BUILD.json")),
        Some(root.join("engine/BUILD.json")),
    ];
    paths.into_iter().flatten().find_map(|path| {
        read_json(&path)
            .ok()?
            .get("version")?
            .as_str()
            .map(str::to_owned)
    })
}

fn python_probe(path: &Path, cache: &mut PythonCache) -> bool {
    let key = path_key(path);
    *cache.probes.entry(key).or_insert_with(|| {
        path.is_file()
            && crate::output(
                &path.to_string_lossy(),
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

fn missing_python_modules(root: &Path, python: &Path, cache: &mut PythonCache) -> Vec<String> {
    let mut modules = Vec::new();
    if root.join("tools/strata_tokenizer.py").is_file() {
        modules.push("regex");
    }
    if root.join("serve/frontend.py").is_file() {
        modules.push("jinja2");
    }
    if modules.is_empty() {
        return Vec::new();
    }
    let key = format!("{}::{:?}", path_key(python), modules);
    cache.missing_modules.entry(key).or_insert_with(|| {
        let code = format!("import importlib.util,json;print(json.dumps([n for n in {} if importlib.util.find_spec(n) is None]))", serde_json::to_string(&modules).unwrap_or_default());
        crate::output(&python.to_string_lossy(), &["-I", "-c", &code]).and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok()).unwrap_or_else(|| vec!["依赖检测失败".into()])
    }).clone()
}

fn find_python(
    root: &Path,
    preferred: Option<&str>,
    hint: Option<&ProcessHint>,
    cache: &mut PythonCache,
) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = preferred.filter(|v| !v.is_empty()) {
        candidates.push(PathBuf::from(path));
    }
    candidates.extend([
        root.join(".venv/Scripts/python.exe"),
        root.join("venv/Scripts/python.exe"),
        root.join(".venv/bin/python"),
        root.join("venv/bin/python"),
    ]);
    if let Some(hint) = hint {
        candidates.push(hint.python.clone());
    }
    for path in candidates {
        if let Ok(path) = canonical_local(&path) {
            if python_probe(&path, cache) {
                return Some(path);
            }
        }
    }
    if cache.fallback.is_none() {
        #[cfg(windows)]
        let programs = ["py", "python"];
        #[cfg(not(windows))]
        let programs = ["python3", "python"];
        let fallback = programs.into_iter().find_map(|program| {
            let text = crate::output(
                program,
                &["-I", "-S", "-c", "import sys;print(sys.executable)"],
            )?;
            let path = canonical_local(Path::new(text.trim())).ok()?;
            python_probe(&path, cache).then_some(path)
        });
        cache.fallback = Some(fallback);
    }
    cache.fallback.clone().flatten()
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
    let engine = resolve(&cwd, exe);
    let model_path = resolve(&cwd, model);
    let python = find_python(&root, preferred_python, hint, cache);
    let mut fatal_reasons = Vec::new();
    if !cwd.is_dir() {
        fatal_reasons.push("配置工作目录不存在".into());
    }
    if !engine.is_file() {
        fatal_reasons.push("引擎文件不存在，请修复运行环境".into());
    }
    if python.is_none() {
        fatal_reasons.push("没有可运行的本机 Python 3.10+ 环境".into());
    }
    if let Some(python) = &python {
        let missing = missing_python_modules(&root, python, cache);
        if !missing.is_empty() {
            fatal_reasons.push(format!(
                "Python 运行依赖缺失：{}，请修复运行环境",
                missing.join(", ")
            ));
        }
    }
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
    let profile = ServiceProfile {
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
    let mut candidate = LocalCandidate {
        id,
        name,
        install_dir: profile.install_dir.clone(),
        python_path: profile.python_path.clone(),
        config_path: profile.config_path.clone(),
        model_path: model_path.to_string_lossy().into(),
        model_bytes,
        detected_port: Some(detected_port),
        running: Some(false),
        reason: if fatal_reasons.is_empty() {
            None
        } else {
            Some(fatal_reasons.join("；"))
        },
        runtime_version: runtime_version(&root, Some(&engine)),
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

fn common_directories() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        for suffix in ["Strata", "AI/Strata", "Documents/Strata"] {
            roots.push(PathBuf::from(&home).join(suffix));
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        for suffix in [
            "Strata",
            "Strata Manager/runtimes",
            "com.strata.manager/runtimes",
        ] {
            roots.push(PathBuf::from(&local).join(suffix));
        }
    }
    #[cfg(windows)]
    {
        // A short list of conventional installation locations, never a drive walk.
        roots.extend([PathBuf::from("C:/AI/Strata"), PathBuf::from("D:/AI/Strata")]);
    }
    roots
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

#[cfg(windows)]
fn split_command(command: &str) -> Option<Vec<String>> {
    use windows_sys::Win32::{Foundation::LocalFree, UI::Shell::CommandLineToArgvW};
    let wide: Vec<_> = command.encode_utf16().chain(std::iter::once(0)).collect();
    let mut count = 0;
    unsafe {
        let pointers = CommandLineToArgvW(wide.as_ptr(), &mut count);
        if pointers.is_null() {
            return None;
        }
        let parsed = (|| {
            let mut args = Vec::new();
            for index in 0..count as usize {
                let pointer = *pointers.add(index);
                let mut length = 0;
                while *pointer.add(length) != 0 {
                    length += 1;
                }
                args.push(String::from_utf16(std::slice::from_raw_parts(pointer, length)).ok()?);
            }
            Some(args)
        })();
        LocalFree(pointers as _);
        parsed
    }
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
    Some(ProcessHint {
        config,
        python,
        port,
    })
}

fn process_hints() -> Result<Vec<ProcessHint>, String> {
    #[cfg(windows)]
    {
        // Fixed script: paths from a config/frontend are never interpolated into PowerShell.
        let script = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$p=@(Get-CimInstance Win32_Process -Filter \"Name='python.exe' OR Name='pythonw.exe'\" | Where-Object {$_.CommandLine -match '(?:^|\\s)serve\\.server(?:\\s|$)'} | Select-Object -First 65 -ExpandProperty CommandLine);ConvertTo-Json -InputObject $p -Compress";
        let text = crate::output(
            "powershell.exe",
            &["-NoProfile", "-NonInteractive", "-Command", script],
        )
        .ok_or("无法读取本机 Strata 进程清单（权限不足或超时），为避免重复启动已停止自动操作")?;
        let commands = serde_json::from_str::<Vec<String>>(&text)
            .map_err(|_| "本机进程清单响应无效，无法安全自动启动")?;
        if commands.len() > 64 {
            return Err("本机 Strata 进程超过检测上限，无法安全自动启动".into());
        }
        let mut hints = Vec::new();
        for command in commands {
            let args = split_command(&command).ok_or("无法完整解析本机 Strata 进程启动参数")?;
            if !args
                .windows(2)
                .any(|pair| pair[0] == "-m" && pair[1] == "serve.server")
            {
                continue;
            }
            hints.push(hint_from_args(&args).ok_or(
                "检测到无法定位配置的 Strata 进程，不能启动第二个实例；请先完成既有实例的迁移",
            )?);
        }
        Ok(hints)
    }
    #[cfg(not(windows))]
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
                hint_from_args(&args)
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

/// Whether *any* identified Strata Python server references this installation.
/// This is deliberately conservative and does not authorize stopping that process.
pub fn has_running_installation(installation: &Path) -> Result<bool, String> {
    let root = canonical_local(installation)?;
    Ok(process_hints()?.iter().any(|hint| {
        hint_root(hint)
            .and_then(|path| canonical_local(&path).ok())
            .is_some_and(|path| path_key(&path) == path_key(&root))
    }))
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
    let mut roots: Vec<(PathBuf, &str)> = profiles
        .iter()
        .filter(|profile| external::local_port(profile).is_ok())
        .map(|profile| (PathBuf::from(&profile.install_dir), "registered"))
        .collect();
    roots.extend(directories.iter().cloned().map(|root| (root, "directory")));
    roots.extend(
        hints
            .iter()
            .filter_map(hint_root)
            .map(|root| (root, "running-process")),
    );
    roots.extend(
        common_directories()
            .into_iter()
            .map(|root| (root, "common")),
    );
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
        let mut paths = config_paths(&root);
        paths.extend(
            profiles
                .iter()
                .filter(|profile| {
                    canonical_local(Path::new(&profile.install_dir)).is_ok_and(|path| path == root)
                })
                .map(|profile| PathBuf::from(&profile.config_path)),
        );
        paths.extend(
            hints
                .iter()
                .filter(|hint| {
                    hint_root(hint)
                        .and_then(|path| canonical_local(&path).ok())
                        .as_ref()
                        == Some(&root)
                })
                .map(|hint| hint.config.clone()),
        );
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
        detected_port: None,
        running: None,
        reason: None,
        runtime_version: None,
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
    if destination.exists() {
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
        let imported = read_json(Path::new(&profile.config_path))?;
        storage::validate(&imported)?;
        let port = imported
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|v| u16::try_from(v).ok())
            .ok_or("已有导入缺少本机端口")?;
        if imported.get("host").and_then(Value::as_str) != Some("127.0.0.1") {
            return Err("已有导入不是本机 loopback 服务".into());
        }
        profile.base_url = format!("http://127.0.0.1:{port}");
    } else {
        let port = import_port(port, &inspected)?;
        profile.base_url = format!("http://127.0.0.1:{port}");
        let mut value = inspected.value;
        let object = value.as_object_mut().ok_or("配置必须为对象")?;
        object.insert("host".into(), Value::String("127.0.0.1".into()));
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
    fn import_revalidates_and_preserves_source_and_shared_settings_and_is_idempotent() {
        let (temp, profile) = fixture();
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
        storage::write(&imported.profile, &updated).unwrap();
        let again = prepare_import(&candidate, &state, None).unwrap();
        assert_eq!(again.profile.id, imported.profile.id);
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
}
