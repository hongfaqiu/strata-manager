//! The Python interpreter and environment a Strata directory's own launchers use.
//!
//! A Strata folder is started by its own scripts: `START-HERE.bat` runs
//! `.venv\Scripts\python.exe setup.py`, and setup writes `run-<model>.bat`
//! (`run-<model>.sh`) that start `serve/server.py` with `sys.executable`, the
//! folder's private venv. Some hand-made installs ship an embedded Python
//! instead. The dependency probe (#56), the one-click Python repair and the
//! managed launch (#78) must all use exactly that interpreter and environment.
//!
//! The rule shared by all of them: a directory that has its own Python
//! environment is never run with the host Python. When none of its own
//! interpreters can run, the caller gets a Chinese error instead of a silent
//! switch to whatever `python` is on PATH.
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

const MAX_LAUNCHER_BYTES: u64 = 64 * 1024;
const MAX_ENTRIES: usize = 64;
const MAX_SCRIPTS: usize = 16;

/// Relative locations of a private venv, in Strata's own launch order.
const VENV_PYTHONS: &[&str] = &[
    ".venv/Scripts/python.exe",
    "venv/Scripts/python.exe",
    ".venv/bin/python",
    ".venv/bin/python3",
    "venv/bin/python",
    "venv/bin/python3",
];

/// Relative locations of an embedded (portable) Python next to Strata.
const EMBEDDED_PYTHONS: &[&str] = &[
    "python/python.exe",
    "python_embeded/python.exe",
    "python_embedded/python.exe",
    "python-embed/python.exe",
    "runtime/python/python.exe",
    "python/bin/python3",
    "python/bin/python",
];

/// Environment variables a launcher may set that change which Python runs or
/// what it imports. Anything else a script sets is left to the script.
const LAUNCHER_VARS: &[&str] = &[
    "PATH",
    "PYTHONHOME",
    "PYTHONPATH",
    "VIRTUAL_ENV",
    "PYTHONNOUSERSITE",
    "PYTHONUTF8",
    "PYTHONIOENCODING",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PythonKind {
    /// Named by a `run-*.bat` / `run-*.sh` launcher.
    Launcher,
    /// The folder's private venv (`.venv` / `venv`).
    Venv,
    /// An embedded Python shipped inside the folder.
    Embedded,
    /// A Python chosen by the user for a folder without its own environment.
    Selected,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PythonCandidate {
    pub path: PathBuf,
    pub kind: PythonKind,
    /// The launcher script that named it, if any.
    pub script: Option<PathBuf>,
}

/// The interpreter plus the environment the launch must reproduce.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LauncherEnv {
    pub python: PathBuf,
    pub kind: PythonKind,
    pub script: Option<PathBuf>,
    /// `cd /d "%~dp0"`: Strata always runs from its own folder.
    pub cwd: PathBuf,
    /// The venv root when the interpreter lives in one.
    pub venv: Option<PathBuf>,
    /// Raw `set NAME=VALUE` lines of the launcher, unexpanded.
    pub launcher_vars: Vec<(String, String)>,
    /// A saved interpreter that was not used, and why.
    pub ignored: Option<String>,
}

fn same_path(a: &Path, b: &Path) -> bool {
    let key = |p: &Path| {
        let text = p.to_string_lossy().replace('\\', "/");
        if cfg!(windows) {
            text.to_ascii_lowercase()
        } else {
            text
        }
    };
    key(a) == key(b)
}

fn inside(path: &Path, root: &Path) -> bool {
    let norm = |p: &Path| {
        let text = p.to_string_lossy().replace('\\', "/");
        let text = text.trim_end_matches('/').to_string();
        if cfg!(windows) {
            text.to_ascii_lowercase()
        } else {
            text
        }
    };
    let (path, root) = (norm(path), norm(root));
    path == root || path.starts_with(&format!("{root}/"))
}

/// A launcher path in either separator style, relative paths and `%~dp0`
/// taken against the Strata folder.
fn launcher_path(root: &Path, raw: &str) -> PathBuf {
    let mut text = raw.trim().to_string();
    let root_text = root.to_string_lossy().to_string();
    for token in ["%~dp0", "%~DP0", "$(dirname \"$0\")", "$(dirname $0)"] {
        if let Some(rest) = text.strip_prefix(token) {
            text = format!("{root_text}/{}", rest.trim_start_matches(['\\', '/']));
        }
    }
    if !cfg!(windows) {
        text = text.replace('\\', "/");
    }
    let path = PathBuf::from(&text);
    if path.is_absolute() {
        path
    } else {
        root.join(path)
    }
}

/// The interpreter a launcher line starts `serve/server.py` (or `setup.py`) with.
pub fn launcher_python_in(root: &Path, text: &str) -> Option<PathBuf> {
    text.lines().find_map(|line| {
        let line = line.trim();
        let line = line.strip_prefix("exec ").unwrap_or(line).trim_start();
        let line = line.strip_prefix("call ").unwrap_or(line).trim_start();
        let (program, rest) = if let Some(rest) = line.strip_prefix('"') {
            let end = rest.find('"')?;
            (&rest[..end], &rest[end + 1..])
        } else {
            let end = line.find(char::is_whitespace)?;
            (&line[..end], &line[end..])
        };
        let rest = rest.replace('\\', "/");
        let name = program.rsplit(['\\', '/']).next()?.to_ascii_lowercase();
        let python = name == "python"
            || name == "python3"
            || name == "python.exe"
            || name == "python3.exe"
            || name == "pythonw.exe";
        // A bare `python` relies on PATH; only a path names the folder's own Python.
        let has_dir = program.contains(['\\', '/']) || program.starts_with("%~dp0");
        (python && has_dir && rest.contains("serve/server.py"))
            .then(|| launcher_path(root, program))
    })
}

/// `set NAME=VALUE`, `set "NAME=VALUE"` and `export NAME=VALUE` lines for the
/// variables that decide which Python runs. Values are kept unexpanded.
pub fn launcher_vars_in(text: &str) -> Vec<(String, String)> {
    let mut vars = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let lower = line.to_ascii_lowercase();
        let body = if lower.starts_with("set ") && !lower.starts_with("set /") {
            &line[4..]
        } else if lower.starts_with("export ") {
            &line[7..]
        } else {
            continue;
        };
        let body = body.trim();
        let body = body
            .strip_prefix('"')
            .and_then(|b| b.strip_suffix('"'))
            .unwrap_or(body);
        let Some((name, value)) = body.split_once('=') else {
            continue;
        };
        let name = name.trim();
        if !LAUNCHER_VARS.iter().any(|v| v.eq_ignore_ascii_case(name)) {
            continue;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .unwrap_or(value);
        vars.push((name.to_ascii_uppercase(), value.to_string()));
    }
    vars
}

fn launcher_scripts(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut scripts: Vec<PathBuf> = entries
        .take(MAX_ENTRIES)
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
    scripts.truncate(MAX_SCRIPTS);
    scripts
}

fn venv_of(python: &Path) -> Option<PathBuf> {
    let dir = python.parent()?;
    let root = if dir
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("Scripts") || n == "bin")
    {
        dir.parent()?
    } else {
        dir
    };
    root.join("pyvenv.cfg")
        .is_file()
        .then(|| root.to_path_buf())
}

/// Every interpreter that belongs to this Strata folder, in launch order:
/// the run-* launchers, the private venv, then an embedded Python. Only
/// existing files are listed.
pub fn own_candidates(root: &Path) -> Vec<PythonCandidate> {
    let mut out: Vec<PythonCandidate> = Vec::new();
    let push = |candidate: PythonCandidate, out: &mut Vec<PythonCandidate>| {
        if candidate.path.is_file() && !out.iter().any(|c| same_path(&c.path, &candidate.path)) {
            out.push(candidate);
        }
    };
    for script in launcher_scripts(root) {
        let Ok(text) = fs::read_to_string(&script) else {
            continue;
        };
        if let Some(path) = launcher_python_in(root, &text) {
            push(
                PythonCandidate {
                    path,
                    kind: PythonKind::Launcher,
                    script: Some(script.clone()),
                },
                &mut out,
            );
        }
    }
    for relative in VENV_PYTHONS {
        push(
            PythonCandidate {
                path: root.join(relative),
                kind: PythonKind::Venv,
                script: None,
            },
            &mut out,
        );
    }
    for relative in EMBEDDED_PYTHONS {
        push(
            PythonCandidate {
                path: root.join(relative),
                kind: PythonKind::Embedded,
                script: None,
            },
            &mut out,
        );
    }
    out
}

/// Signs that the folder has its own Python environment, even a broken one
/// (a `.venv` without its interpreter, a launcher naming a missing Python).
/// A folder like that must never be run with the host Python.
pub fn has_own_environment(root: &Path) -> bool {
    if ["venv", ".venv"]
        .iter()
        .any(|name| root.join(name).join("pyvenv.cfg").is_file() || root.join(name).is_dir())
    {
        return true;
    }
    if EMBEDDED_PYTHONS
        .iter()
        .any(|relative| root.join(relative).is_file())
    {
        return true;
    }
    launcher_scripts(root).iter().any(|script| {
        fs::read_to_string(script)
            .ok()
            .and_then(|text| launcher_python_in(root, &text))
            .is_some()
    })
}

fn display_list(root: &Path) -> String {
    let mut names: Vec<String> = Vec::new();
    for script in launcher_scripts(root) {
        if let Some(path) = fs::read_to_string(&script)
            .ok()
            .and_then(|text| launcher_python_in(root, &text))
        {
            names.push(path.display().to_string());
        }
    }
    for name in [".venv", "venv"] {
        if root.join(name).is_dir() {
            names.push(root.join(name).display().to_string());
        }
    }
    names.dedup();
    names.join("、")
}

/// Choose the interpreter and environment a Strata folder's launchers use.
///
/// `saved` is the interpreter remembered in the profile. It is used first when
/// it belongs to the folder, and only used outside the folder when the folder
/// has no environment of its own. `runs` decides whether an interpreter can
/// start (callers pass a real probe, tests a fixture).
pub fn resolve(
    root: &Path,
    saved: Option<&str>,
    mut runs: impl FnMut(&Path) -> bool,
) -> Result<LauncherEnv, String> {
    let own = own_candidates(root);
    let own_env = has_own_environment(root);
    let saved = saved
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let mut ignored = None;
    let mut ordered: Vec<PythonCandidate> = Vec::new();
    if let Some(saved) = &saved {
        if let Some(found) = own.iter().find(|c| same_path(&c.path, saved)) {
            ordered.push(found.clone());
        } else if inside(saved, root) && saved.is_file() {
            let kind = if venv_of(saved).is_some() {
                PythonKind::Venv
            } else {
                PythonKind::Embedded
            };
            ordered.push(PythonCandidate {
                path: saved.clone(),
                kind,
                script: None,
            });
        } else if own_env {
            ignored = Some(format!(
                "已忽略保存的 Python {}：该 Strata 目录有自带的 Python 环境，启动脚本不会使用它",
                saved.display()
            ));
        } else {
            ordered.push(PythonCandidate {
                path: saved.clone(),
                kind: PythonKind::Selected,
                script: None,
            });
        }
    }
    for candidate in own {
        if !ordered.iter().any(|c| same_path(&c.path, &candidate.path)) {
            ordered.push(candidate);
        }
    }
    let mut tried = Vec::new();
    for candidate in ordered {
        if runs(&candidate.path) {
            let launcher_vars = candidate
                .script
                .as_ref()
                .and_then(|script| fs::read_to_string(script).ok())
                .map(|text| launcher_vars_in(&text))
                .unwrap_or_default();
            return Ok(LauncherEnv {
                venv: venv_of(&candidate.path).or_else(|| {
                    (candidate.kind == PythonKind::Venv)
                        .then(|| candidate.path.parent()?.parent().map(Path::to_path_buf))
                        .flatten()
                }),
                python: candidate.path,
                kind: candidate.kind,
                script: candidate.script,
                cwd: root.to_path_buf(),
                launcher_vars,
                ignored,
            });
        }
        tried.push(candidate.path.display().to_string());
    }
    #[cfg(windows)]
    let (setup, update) = ("START-HERE.bat", "UPDATE.bat");
    #[cfg(not(windows))]
    let (setup, update) = ("./setup.sh", "./update.sh");
    if own_env {
        let tried = if tried.is_empty() {
            display_list(root)
        } else {
            tried.join("、")
        };
        return Err(format!(
            "该 Strata 目录自带的 Python 环境无法运行（{tried}）。为保证和启动脚本一致，不会改用系统 Python；请在该目录运行 {update} 或 {setup} 修复后重新扫描"
        ));
    }
    if let Some(saved) = saved {
        return Err(format!(
            "所选 Python 无法运行：{}；该 Strata 目录也没有自带的 Python 环境",
            saved.display()
        ));
    }
    Err(format!(
        "该 Strata 目录没有自带的 Python 环境（没有 .venv、嵌入式 Python，run-*.bat 也没有指定解释器）；请先在该目录运行 {setup} 完成安装，或在配置里手动选择 Python"
    ))
}

fn expand(value: &str, root: &Path, sh: bool, lookup: &dyn Fn(&str) -> Option<String>) -> String {
    let mut text = value.to_string();
    let root_text = format!("{}{}", root.display(), std::path::MAIN_SEPARATOR);
    for token in ["%~dp0", "%~DP0"] {
        text = text.replace(token, &root_text);
    }
    // %NAME% (cmd) and $NAME / ${NAME} (sh) references to the inherited value.
    let mut out = String::new();
    let mut rest = text.as_str();
    let marks: &[char] = if sh { &['$'] } else { &['%'] };
    while let Some(start) = rest.find(marks) {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let (name, used) = if let Some(after) = tail.strip_prefix('%') {
            match after.find('%') {
                Some(end) if end > 0 => (&after[..end], end + 2),
                _ => ("", 0),
            }
        } else if let Some(after) = tail.strip_prefix("${") {
            match after.find('}') {
                Some(end) => (&after[..end], end + 3),
                None => ("", 0),
            }
        } else {
            let after = &tail[1..];
            let end = after
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .unwrap_or(after.len());
            (&after[..end], end + 1)
        };
        if name.is_empty() || used == 0 {
            out.push_str(&tail[..1]);
            rest = &tail[1..];
            continue;
        }
        out.push_str(&lookup(&name.to_ascii_uppercase()).unwrap_or_default());
        rest = &tail[used..];
    }
    out.push_str(rest);
    out
}

impl LauncherEnv {
    /// The environment changes for the launch: `Some(value)` sets, `None`
    /// removes. `inherited` reads the manager's own environment; `observer` is
    /// the Manager's sitecustomize directory, kept first on PYTHONPATH.
    pub fn env_plan(
        &self,
        inherited: &dyn Fn(&str) -> Option<String>,
        observer: Option<&Path>,
    ) -> BTreeMap<String, Option<String>> {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let mut plan: BTreeMap<String, Option<String>> = BTreeMap::new();
        // A PYTHONHOME or VIRTUAL_ENV inherited from the host would point the
        // folder's interpreter at the host's standard library or packages.
        plan.insert("PYTHONHOME".into(), None);
        plan.insert("VIRTUAL_ENV".into(), None);
        let mut path_front: Vec<String> = Vec::new();
        if let Some(venv) = &self.venv {
            plan.insert("VIRTUAL_ENV".into(), Some(venv.display().to_string()));
            let bin = if venv.join("Scripts").is_dir() || cfg!(windows) {
                venv.join("Scripts")
            } else {
                venv.join("bin")
            };
            path_front.push(bin.display().to_string());
        } else if matches!(self.kind, PythonKind::Embedded | PythonKind::Launcher) {
            if let Some(dir) = self.python.parent() {
                path_front.push(dir.display().to_string());
                if dir.join("Scripts").is_dir() {
                    path_front.push(dir.join("Scripts").display().to_string());
                }
            }
        }
        let base_path = inherited("PATH").unwrap_or_default();
        let path = if path_front.is_empty() {
            base_path.clone()
        } else if base_path.is_empty() {
            path_front.join(sep)
        } else {
            format!("{}{sep}{base_path}", path_front.join(sep))
        };
        plan.insert("PATH".into(), Some(path));
        let sh = self
            .script
            .as_ref()
            .and_then(|s| s.extension())
            .is_some_and(|e| e.eq_ignore_ascii_case("sh"));
        let mut launcher_pythonpath: Option<String> = None;
        for (name, raw) in &self.launcher_vars {
            let current = |key: &str| -> Option<String> {
                if key == "PYTHONPATH" {
                    return launcher_pythonpath
                        .clone()
                        .or_else(|| inherited("PYTHONPATH"));
                }
                match plan.get(key) {
                    Some(value) => value.clone(),
                    None => inherited(key),
                }
            };
            let value = expand(raw, &self.cwd, sh, &current);
            if name == "PYTHONPATH" {
                launcher_pythonpath = Some(value);
                continue;
            }
            plan.insert(name.clone(), (!value.is_empty()).then_some(value));
        }
        let mut pythonpath: Vec<String> = Vec::new();
        if let Some(observer) = observer {
            pythonpath.push(observer.display().to_string());
        }
        if let Some(extra) = launcher_pythonpath.filter(|v| !v.is_empty()) {
            pythonpath.push(extra);
        }
        plan.insert(
            "PYTHONPATH".into(),
            (!pythonpath.is_empty()).then(|| pythonpath.join(sep)),
        );
        // Child output is read as UTF-8; a Chinese Windows locale would
        // otherwise write OS messages in GBK and show up garbled (#78 log).
        if !plan.contains_key("PYTHONIOENCODING") {
            plan.insert("PYTHONIOENCODING".into(), Some("utf-8".into()));
        }
        plan
    }

    /// Apply the interpreter's working directory and environment to a command.
    pub fn apply(&self, command: &mut std::process::Command, observer: Option<&Path>) {
        command.current_dir(&self.cwd);
        let plan = self.env_plan(&|key| std::env::var(key).ok(), observer);
        for (name, value) in plan {
            match value {
                Some(value) => {
                    command.env(name, value);
                }
                None => {
                    command.env_remove(name);
                }
            }
        }
    }

    /// One line for the startup log.
    pub fn describe(&self) -> String {
        let kind = match self.kind {
            PythonKind::Launcher => "启动脚本指定",
            PythonKind::Venv => "目录自带虚拟环境",
            PythonKind::Embedded => "目录自带嵌入式 Python",
            PythonKind::Selected => "手动选择",
        };
        match &self.script {
            Some(script) => format!(
                "使用 Python：{}（{kind}，来自 {}）",
                self.python.display(),
                script
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default()
            ),
            None => format!("使用 Python：{}（{kind}）", self.python.display()),
        }
    }
}

#[cfg(test)]
#[path = "launcher_env_tests.rs"]
mod tests;
