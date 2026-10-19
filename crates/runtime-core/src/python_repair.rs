//! One-click repair of Strata's private Python: install missing regex / jinja2
//! into the interpreter named by `run-*.bat` / `run-*.sh` (or the install venv).
//!
//! The interpreter comes from `crate::launcher_env`, the same resolver the
//! dependency probe and the managed launch use (#56, #78).
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

const PIP_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonRepairResult {
    pub python_path: String,
    pub installed: Vec<String>,
    pub already_present: Vec<String>,
    pub message: String,
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
    let python = crate::launcher_env::resolve(&root, None, probe_python)?.python;
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
