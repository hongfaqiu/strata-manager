//! One-click repair of Strata's private Python: install missing regex / jinja2
//! into the interpreter named by `run-*.bat` / `run-*.sh` (or the install venv).
//!
//! Launcher parsing is intentionally local and mirrored from `discovery` so repair
//! stays usable if discovery helpers stay private; both prefer the same run-* scripts.
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

const MAX_LAUNCHER_BYTES: u64 = 64 * 1024;
const MAX_DIRECTORIES: usize = 64;
const PIP_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonRepairResult {
    pub python_path: String,
    pub installed: Vec<String>,
    pub already_present: Vec<String>,
    pub message: String,
}

fn path_is_local_file(path: &Path) -> bool {
    path.is_absolute()
        && path.is_file()
        && fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file())
}

/// Keep the venv path (do not resolve the final symlink) so site-packages stay correct.
fn python_path(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let name = path.file_name()?;
    let parent = path.parent()?;
    let parent = dunce::canonicalize(parent).ok()?;
    let path = parent.join(name);
    path_is_local_file(&path).then_some(path)
}

fn launcher_python(text: &str) -> Option<PathBuf> {
    text.lines().find_map(|line| {
        let line = line.trim();
        let line = line.strip_prefix("exec ").unwrap_or(line).trim_start();
        let rest = line.strip_prefix('"')?;
        let end = rest.find('"')?;
        let program = Path::new(&rest[..end]);
        let server = rest[end + 1..].replace('\\', "/");
        let name = program.file_name()?.to_str()?.to_ascii_lowercase();
        (program.is_absolute() && name.starts_with("python") && server.contains("serve/server.py"))
            .then(|| program.to_path_buf())
    })
}

fn launcher_pythons(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut scripts: Vec<PathBuf> = entries
        .take(MAX_DIRECTORIES)
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            name.starts_with("run-") && (name.ends_with(".bat") || name.ends_with(".sh"))
        })
        .filter(|path| {
            fs::symlink_metadata(path).is_ok_and(|metadata| {
                metadata.is_file()
                    && !metadata.file_type().is_symlink()
                    && metadata.len() <= MAX_LAUNCHER_BYTES
            })
        })
        .collect();
    scripts.sort();
    let mut pythons = Vec::new();
    for script in scripts.into_iter().take(16) {
        let Ok(text) = fs::read_to_string(&script) else {
            continue;
        };
        if let Some(python) = launcher_python(&text).and_then(|path| python_path(&path)) {
            if !pythons.contains(&python) {
                pythons.push(python);
            }
        }
    }
    pythons
}

fn install_candidates(root: &Path) -> Vec<PathBuf> {
    let mut candidates = launcher_pythons(root);
    for relative in [
        ".venv/Scripts/python.exe",
        "venv/Scripts/python.exe",
        ".venv/bin/python",
        "venv/bin/python",
        ".venv/bin/python3",
        "venv/bin/python3",
    ] {
        if let Some(path) = python_path(&root.join(relative)) {
            if !candidates.contains(&path) {
                candidates.push(path);
            }
        }
    }
    candidates
}

fn probe_python(path: &Path) -> bool {
    let Ok(mut child) = Command::new(path)
        .args([
            "-I",
            "-S",
            "-c",
            "import sys; assert sys.version_info[:2] >= (3, 10); print('ok')",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return false;
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(_) => return false,
        }
    }
}

fn missing_modules(python: &Path) -> Result<Vec<String>, String> {
    let code = "import importlib.util,json;print(json.dumps([n for n in ['regex','jinja2'] if importlib.util.find_spec(n) is None]))";
    let output = Command::new(python)
        .args(["-I", "-c", code])
        .output()
        .map_err(|error| format!("无法检测 Python 依赖：{error}"))?;
    if !output.status.success() {
        return Err(format!("依赖检测失败（{}）", python.display()));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str::<Vec<String>>(text.trim())
        .map_err(|error| format!("依赖检测结果无效：{error}"))
}

fn pip_install(python: &Path, modules: &[String]) -> Result<(), String> {
    if modules.is_empty() {
        return Ok(());
    }
    let mut args = vec![
        "-m".into(),
        "pip".into(),
        "install".into(),
        "--disable-pip-version-check".into(),
        "--no-input".into(),
    ];
    args.extend(modules.iter().cloned());
    let mut child = Command::new(python)
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动 pip：{error}"))?;
    let mut stderr = child.stderr.take();
    let deadline = std::time::Instant::now() + PIP_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("pip 安装超时".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(80)),
            Err(error) => return Err(format!("pip 等待失败：{error}")),
        }
    };
    let mut err_text = String::new();
    if let Some(mut pipe) = stderr.take() {
        use std::io::Read;
        let _ = pipe.read_to_string(&mut err_text);
    }
    if status.success() {
        return Ok(());
    }
    let stderr = err_text.trim();
    Err(if stderr.is_empty() {
        format!("pip 安装失败（{}）", python.display())
    } else {
        format!(
            "pip 安装失败：{}",
            stderr.chars().take(400).collect::<String>()
        )
    })
}

/// Install missing regex/jinja2 into the Strata install's launcher Python.
pub fn repair_python_dependencies(install_dir: &str) -> Result<PythonRepairResult, String> {
    let root = PathBuf::from(install_dir.trim());
    if install_dir.trim().is_empty() || !root.is_absolute() {
        return Err("请提供本机 Strata 安装目录的绝对路径".into());
    }
    let root = dunce::canonicalize(&root).map_err(|error| format!("无法访问安装目录：{error}"))?;
    if !root.is_dir() {
        return Err("安装目录不存在".into());
    }
    let python = install_candidates(&root)
        .into_iter()
        .find(|path| probe_python(path))
        .ok_or_else(|| {
            "未找到 Strata 启动脚本或私有 venv 中的 Python 3.10+；请先完成引擎安装或运行 update 脚本"
                .to_owned()
        })?;
    let missing = missing_modules(&python)?;
    let required = ["regex".to_owned(), "jinja2".to_owned()];
    let already_present: Vec<String> = required
        .iter()
        .filter(|name| !missing.iter().any(|item| item == *name))
        .cloned()
        .collect();
    if missing.is_empty() {
        return Ok(PythonRepairResult {
            python_path: python.display().to_string(),
            installed: Vec::new(),
            already_present,
            message: format!("运行环境已齐全（{}），无需安装", python.display()),
        });
    }
    pip_install(&python, &missing)?;
    let still = missing_modules(&python)?;
    if !still.is_empty() {
        return Err(format!(
            "安装后仍缺少：{}（{}）",
            still.join(", "),
            python.display()
        ));
    }
    Ok(PythonRepairResult {
        python_path: python.display().to_string(),
        installed: missing.clone(),
        already_present,
        message: format!("已向 {} 安装 {}", python.display(), missing.join(", ")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launcher_python_reads_strata_run_scripts() {
        let bat = "@echo off\r\n\"C:\\Strata\\.venv\\Scripts\\python.exe\" \"C:\\Strata\\serve\\server.py\" \"--engine\" \"strata\"\r\n";
        #[cfg(windows)]
        assert_eq!(
            launcher_python(bat),
            Some(PathBuf::from("C:\\Strata\\.venv\\Scripts\\python.exe"))
        );
        #[cfg(not(windows))]
        assert_eq!(launcher_python(bat), None);
        let sh = "#!/bin/sh\nexec \"/opt/strata/.venv/bin/python\" \"/opt/strata/serve/server.py\" \"--engine\" \"strata\"\n";
        #[cfg(not(windows))]
        assert_eq!(
            launcher_python(sh),
            Some(PathBuf::from("/opt/strata/.venv/bin/python"))
        );
        let _ = (bat, sh);
        assert_eq!(
            launcher_python("\"/usr/bin/python3\" tools/other.py\n"),
            None
        );
    }
}
