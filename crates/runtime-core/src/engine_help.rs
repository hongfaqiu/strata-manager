//! Read the flags the installed engine itself documents (`<exe> --help`),
//! so the startup form follows the real binary instead of a pinned catalog.
//! `--help` exits in upstream's argv loop before any GPU or model work.
use crate::{processes, storage, types::ServiceProfile};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{BTreeSet, HashMap},
    ffi::OsString,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};

const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_OUTPUT: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineHelp {
    pub flags: Vec<String>,
    pub source: String,
}

/// Every `--flag` token in the help text; mentions inside descriptions count as documented.
pub fn parse_flags(text: &str) -> BTreeSet<String> {
    let mut flags = BTreeSet::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i + 2 < bytes.len() {
        let boundary = i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'-');
        if boundary
            && bytes[i] == b'-'
            && bytes[i + 1] == b'-'
            && bytes[i + 2].is_ascii_alphanumeric()
        {
            let start = i;
            i += 2;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'-') {
                i += 1;
            }
            let flag = text[start..i].trim_end_matches('-');
            if flag.len() > 2 && flag.len() <= 64 {
                flags.insert(flag.to_ascii_lowercase());
            }
        } else {
            i += 1;
        }
    }
    flags
}

/// The library environment upstream `serve/server.py` `child_env(cfg)` gives the
/// engine: the config's `env` entries, then the existing `lib_dirs` (pip's
/// nvidia cu13 `bin`, the CUDA toolkit, the HIP engine's ROCm folder) first on
/// `PATH` (Windows) or `LD_LIBRARY_PATH`. Relative entries resolve against the
/// runtime root, the server's own working directory. GPU visibility and the
/// HIP guard are left out: `--help` exits before any device is touched.
pub fn engine_env(
    config: &Value,
    root: &Path,
    current: impl Fn(&str) -> Option<OsString>,
) -> Vec<(String, OsString)> {
    let mut env: Vec<(String, OsString)> = Vec::new();
    if let Some(entries) = config["env"].as_object() {
        for (key, value) in entries {
            let text = match value {
                Value::String(text) => text.clone(),
                Value::Number(number) => number.to_string(),
                Value::Bool(flag) => if *flag { "True" } else { "False" }.to_string(),
                _ => continue,
            };
            if key.is_empty() || key.contains('=') || key.contains('\0') || text.contains('\0') {
                continue;
            }
            env.retain(|(k, _)| !same_var(k, key));
            env.push((key.clone(), text.into()));
        }
    }
    let dirs: Vec<PathBuf> = config["lib_dirs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(PathBuf::from)
        .map(|d| if d.is_absolute() { d } else { root.join(d) })
        .filter(|d| d.is_dir())
        .collect();
    if !dirs.is_empty() {
        let var = if cfg!(windows) {
            "PATH"
        } else {
            "LD_LIBRARY_PATH"
        };
        let existing = env
            .iter()
            .find(|(k, _)| same_var(k, var))
            .map(|(_, v)| v.clone())
            .or_else(|| current(var))
            .filter(|v| !v.is_empty());
        let mut parts: Vec<PathBuf> = dirs;
        if let Some(existing) = existing {
            parts.extend(std::env::split_paths(&existing));
        }
        if let Ok(joined) = std::env::join_paths(parts) {
            env.retain(|(k, _)| !same_var(k, var));
            env.push((var.to_string(), joined));
        }
    }
    env
}

fn same_var(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// A Windows loader failure (`NTSTATUS` as the exit code) in words the page can show.
pub fn describe_exit(code: Option<i32>) -> Option<String> {
    let status = code? as u32;
    let what = match status {
        0xC000_0135 => "找不到所需的 DLL",
        0xC000_007B => "DLL 与引擎位数或版本不匹配",
        0xC000_0139 => "DLL 缺少所需的入口点",
        0xC000_0142 => "DLL 初始化失败",
        _ => return None,
    };
    Some(format!(
        "引擎缺少运行库（DLL），无法读取参数列表；不影响已启动的服务（{what}，0x{status:08X}）"
    ))
}

type CacheKey = (PathBuf, Option<SystemTime>, u64, Vec<(String, OsString)>);
static CACHE: Mutex<Option<HashMap<CacheKey, EngineHelp>>> = Mutex::new(None);

pub fn engine_path(profile: &ServiceProfile) -> Result<PathBuf, String> {
    let root = processes::runtime_dir(profile)?;
    let config = storage::read(profile)?;
    engine_path_in(&root, &config)
}

fn engine_path_in(root: &Path, config: &Value) -> Result<PathBuf, String> {
    let exe = config["exe"].as_str().ok_or("配置缺少 exe")?;
    let cwd = config["cwd"]
        .as_str()
        .map(PathBuf::from)
        .map(|c| if c.is_absolute() { c } else { root.join(c) })
        .unwrap_or_else(|| root.to_path_buf());
    let path = if Path::new(exe).is_absolute() {
        PathBuf::from(exe)
    } else {
        cwd.join(exe)
    };
    if !path.is_file() {
        return Err("引擎可执行文件不存在，无法读取 --help".into());
    }
    Ok(path)
}

pub fn run_help(exe: &Path, env: &[(String, OsString)]) -> Result<EngineHelp, String> {
    processes::suppress_hard_error_dialogs();
    let mut command = Command::new(exe);
    command.envs(env.iter().map(|(k, v)| (k, v)));
    command
        .arg("--help")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(parent) = exe.parent() {
        command.current_dir(parent);
    }
    processes::hidden(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法运行引擎 --help：{e}"))?;
    let (mut out, mut err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let reader = std::thread::spawn(move || {
        let mut text = Vec::new();
        let _ = (&mut out).take(MAX_OUTPUT as u64).read_to_end(&mut text);
        text
    });
    let error_reader = std::thread::spawn(move || {
        let mut text = Vec::new();
        let _ = (&mut err).take(MAX_OUTPUT as u64).read_to_end(&mut text);
        text
    });
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if start.elapsed() > TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("引擎 --help 超时".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let mut text = String::from_utf8_lossy(&reader.join().unwrap_or_default()).into_owned();
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(
        &error_reader.join().unwrap_or_default(),
    ));
    let flags = parse_flags(&text);
    if flags.len() < 3 {
        if let Some(message) = describe_exit(status.code()) {
            return Err(message);
        }
        return Err("引擎 --help 未输出可识别的参数列表".into());
    }
    Ok(EngineHelp {
        flags: flags.into_iter().collect(),
        source: "engine --help".into(),
    })
}

pub fn flags(profile: &ServiceProfile) -> Result<EngineHelp, String> {
    let root = processes::runtime_dir(profile)?;
    let config = storage::read(profile)?;
    flags_in(&root, &config)
}

/// `--help` for this config's engine, run once per binary (path, mtime, size) and
/// library environment; only a successful read is remembered.
fn flags_in(root: &Path, config: &Value) -> Result<EngineHelp, String> {
    let exe = engine_path_in(root, config)?;
    let env = engine_env(config, root, |k| std::env::var_os(k));
    let meta = std::fs::metadata(&exe).ok();
    let key: CacheKey = (
        exe.clone(),
        meta.as_ref().and_then(|m| m.modified().ok()),
        meta.as_ref().map_or(0, |m| m.len()),
        env.clone(),
    );
    if let Some(hit) = CACHE
        .lock()
        .ok()
        .and_then(|cache| cache.as_ref().and_then(|c| c.get(&key).cloned()))
    {
        return Ok(hit);
    }
    let help = run_help(&exe, &env)?;
    if let Ok(mut cache) = CACHE.lock() {
        let cache = cache.get_or_insert_with(HashMap::new);
        if cache.len() > 32 {
            cache.clear();
        }
        cache.insert(key, help.clone());
    }
    Ok(help)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_upstream_usage_layout() {
        let text = "strata generate --pack DIR --tokens \"1,2,3\" [options]\n\n  --gpu LIST   run on these GPUs\n  --ple-gguf PATH  with --native, the shard\n  --kv fp16|int8  storage\n  --batch N    sequences at once; see --batch-mtp\n  a-b--not-a-flag, ---x, --\n";
        let flags = parse_flags(text);
        for flag in [
            "--pack",
            "--tokens",
            "--gpu",
            "--ple-gguf",
            "--native",
            "--kv",
            "--batch",
            "--batch-mtp",
        ] {
            assert!(flags.contains(flag), "{flag}");
        }
        assert!(!flags.iter().any(|f| f.contains("not-a-flag") || f == "--"));
    }

    #[cfg(unix)]
    #[test]
    fn runs_a_real_executable_and_reads_stderr_usage() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let exe = temp.path().join("strata");
        std::fs::write(&exe, "#!/bin/sh\n[ \"$1\" = --help ] || exit 9\necho '  --gpu LIST' >&2\necho '  --batch N' >&2\necho '  --vram-elastic' >&2\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let help = run_help(&exe, &[]).unwrap();
        assert_eq!(help.flags, vec!["--batch", "--gpu", "--vram-elastic"]);
        std::fs::write(&exe, "#!/bin/sh\necho nothing\n").unwrap();
        assert!(run_help(&exe, &[]).is_err());
    }

    #[test]
    fn env_prepends_existing_lib_dirs_and_applies_config_env() {
        let temp = tempfile::tempdir().unwrap();
        let abs = temp.path().join("nvidia/cublas/bin");
        std::fs::create_dir_all(&abs).unwrap();
        std::fs::create_dir_all(temp.path().join("rocm/bin")).unwrap();
        let config = serde_json::json!({
            "env": {"HIPBLASLT_TUNING_FILE": "t.txt", "N": 3, "B": true, "SKIP": null, "BAD=K": "x"},
            "lib_dirs": [abs, "rocm/bin", temp.path().join("missing"), 7],
        });
        let var = if cfg!(windows) {
            "PATH"
        } else {
            "LD_LIBRARY_PATH"
        };
        let base = OsString::from(if cfg!(windows) {
            r"C:\Windows"
        } else {
            "/usr/lib"
        });
        let env = engine_env(&config, temp.path(), |k| (k == var).then(|| base.clone()));
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        assert_eq!(get("HIPBLASLT_TUNING_FILE"), Some("t.txt".into()));
        assert_eq!(get("N"), Some("3".into()));
        assert_eq!(get("B"), Some("True".into()));
        assert!(get("SKIP").is_none() && get("BAD=K").is_none());
        let parts: Vec<PathBuf> = std::env::split_paths(&get(var).unwrap()).collect();
        assert_eq!(
            parts,
            vec![abs, temp.path().join("rocm/bin"), PathBuf::from(&base)]
        );
    }

    #[test]
    fn env_without_lib_dirs_leaves_search_path_alone() {
        let temp = tempfile::tempdir().unwrap();
        let config = serde_json::json!({"lib_dirs": [temp.path().join("gone")]});
        assert!(engine_env(&config, temp.path(), |_| None).is_empty());
        // A config `env` PATH is the base the library folders go in front of, as upstream.
        std::fs::create_dir_all(temp.path().join("lib")).unwrap();
        let var = if cfg!(windows) {
            "PATH"
        } else {
            "LD_LIBRARY_PATH"
        };
        let config =
            serde_json::json!({"env": {var: temp.path().join("own")}, "lib_dirs": ["lib"]});
        let env = engine_env(&config, temp.path(), |_| Some("ignored".into()));
        assert_eq!(env.len(), 1);
        let parts: Vec<PathBuf> = std::env::split_paths(&env[0].1).collect();
        assert_eq!(
            parts,
            vec![temp.path().join("lib"), temp.path().join("own")]
        );
    }

    #[test]
    fn loader_failures_map_to_a_clear_message() {
        let dll = describe_exit(Some(0xC000_0135u32 as i32)).unwrap();
        assert!(dll.contains("引擎缺少运行库（DLL）") && dll.contains("不影响已启动的服务"));
        assert!(dll.contains("0xC0000135"));
        assert!(describe_exit(Some(0xC000_007Bu32 as i32)).is_some());
        assert!(describe_exit(Some(1)).is_none());
        assert!(describe_exit(Some(0)).is_none());
        assert!(describe_exit(None).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn help_runs_with_the_library_environment_and_is_cached() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let lib = temp.path().join("cu13/bin");
        std::fs::create_dir_all(&lib).unwrap();
        let exe = temp.path().join("strata");
        let marker = temp.path().join("runs");
        std::fs::write(
            &exe,
            format!(
                "#!/bin/sh\necho x >> '{}'\ncase \"$LD_LIBRARY_PATH\" in '{}'*) ;; *) exit 9;; esac\n[ \"$STRATA_X\" = on ] || exit 8\necho '  --gpu L  --batch N  --kv K'\n",
                marker.display(),
                lib.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = serde_json::json!({"exe": exe, "lib_dirs": [lib], "env": {"STRATA_X": "on"}});
        let first = flags_in(temp.path(), &config).unwrap();
        assert_eq!(first.flags, vec!["--batch", "--gpu", "--kv"]);
        assert_eq!(flags_in(temp.path(), &config).unwrap(), first);
        assert_eq!(std::fs::read_to_string(&marker).unwrap().lines().count(), 1);
        let bare = serde_json::json!({"exe": exe});
        assert!(flags_in(temp.path(), &bare).is_err());
    }
}
