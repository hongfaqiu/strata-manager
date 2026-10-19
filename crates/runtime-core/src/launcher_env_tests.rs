use super::*;
use std::collections::HashMap;

fn strata(root: &Path) {
    fs::create_dir_all(root.join("serve")).unwrap();
    fs::write(root.join("setup.py"), b"# fixture").unwrap();
    fs::write(root.join("serve/server.py"), b"# fixture").unwrap();
}

fn file(path: &Path) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, b"fixture").unwrap();
}

/// A Windows venv as `python -m venv .venv` leaves it.
fn windows_venv(root: &Path) -> PathBuf {
    let python = root.join(".venv/Scripts/python.exe");
    file(&python);
    fs::write(
        root.join(".venv/pyvenv.cfg"),
        "home = C:\\Program Files\\Python\\Python312\r\nversion = 3.12.10\r\n",
    )
    .unwrap();
    python
}

fn all_run(_: &Path) -> bool {
    true
}

fn sep() -> &'static str {
    if cfg!(windows) {
        ";"
    } else {
        ":"
    }
}

fn host_env<'a>(vars: &'a HashMap<&'static str, String>) -> impl Fn(&str) -> Option<String> + 'a {
    move |key| vars.get(key).cloned()
}

#[test]
fn windows_venv_layout_is_chosen_and_host_python_saved_by_discovery_is_ignored() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("Strata-0.1.45");
    strata(&root);
    let venv_python = windows_venv(&root);
    let host = temp
        .path()
        .join("Program Files/Python/Python312/python.exe");
    file(&host);
    let env = resolve(&root, Some(&host.to_string_lossy()), all_run).unwrap();
    assert_eq!(env.python, venv_python);
    assert_eq!(env.kind, PythonKind::Venv);
    assert_eq!(env.venv.as_deref(), Some(root.join(".venv").as_path()));
    assert_eq!(env.cwd, root);
    let ignored = env.ignored.as_deref().unwrap();
    assert!(ignored.contains("已忽略保存的 Python"), "{ignored}");
}

#[test]
fn run_bat_named_interpreter_wins_and_its_set_lines_are_kept() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("Strata");
    strata(&root);
    windows_venv(&root);
    // An interpreter the user's launcher names explicitly (e.g. a shared env).
    let named = root.join("envs/py312/python.exe");
    file(&named);
    let bat = format!(
        "@echo off\r\ntitle Strata IQ3_S\r\ncd /d \"%~dp0\"\r\nset \"PYTHONPATH=%~dp0vendor\"\r\nset PATH=%~dp0rocm\\bin;%PATH%\r\n\"{}\" \"{}\" \"--engine\" \"strata\" \"--config\" \"{}\" \"--port\" \"8080\"\r\nif errorlevel 1 pause\r\n",
        named.display(),
        root.join("serve/server.py").display(),
        root.join("strata-iq3_s.json").display()
    );
    fs::write(root.join("run-iq3_s.bat"), bat).unwrap();
    let env = resolve(&root, None, all_run).unwrap();
    assert_eq!(env.python, named);
    assert_eq!(env.kind, PythonKind::Launcher);
    assert_eq!(
        env.script.as_deref(),
        Some(root.join("run-iq3_s.bat").as_path())
    );
    assert_eq!(
        env.launcher_vars,
        vec![
            ("PYTHONPATH".to_string(), "%~dp0vendor".to_string()),
            ("PATH".to_string(), "%~dp0rocm\\bin;%PATH%".to_string()),
        ]
    );
}

#[test]
fn relative_launcher_python_is_resolved_against_the_strata_folder() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("Strata");
    strata(&root);
    let python = windows_venv(&root);
    fs::write(
        root.join("run-q2.bat"),
        "@echo off\r\n\"%~dp0.venv\\Scripts\\python.exe\" \"%~dp0serve\\server.py\" --engine strata\r\n",
    )
    .unwrap();
    let env = resolve(&root, None, all_run).unwrap();
    assert_eq!(env.python, python);
    assert_eq!(env.kind, PythonKind::Launcher);
    assert_eq!(env.venv.as_deref(), Some(root.join(".venv").as_path()));
}

#[test]
fn embedded_python_layout_is_used_when_there_is_no_venv() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("Strata");
    strata(&root);
    let embedded = root.join("python/python.exe");
    file(&embedded);
    file(&root.join("python/python312._pth"));
    let env = resolve(&root, None, all_run).unwrap();
    assert_eq!(env.python, embedded);
    assert_eq!(env.kind, PythonKind::Embedded);
    assert_eq!(env.venv, None);
    let vars = HashMap::from([("PATH", "/usr/bin".to_string())]);
    let plan = env.env_plan(&host_env(&vars), None);
    assert_eq!(
        plan["PATH"].as_deref(),
        Some(format!("{}{}/usr/bin", root.join("python").display(), sep()).as_str())
    );
    assert_eq!(plan["VIRTUAL_ENV"], None);
    assert_eq!(plan["PYTHONHOME"], None);
}

#[test]
fn no_environment_and_no_saved_python_is_a_chinese_error_not_host_python() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("Strata");
    strata(&root);
    let error = resolve(&root, None, all_run).unwrap_err();
    assert!(error.contains("没有自带的 Python 环境"), "{error}");
}

#[test]
fn broken_own_environment_never_falls_back_to_a_working_host_python() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("Strata");
    strata(&root);
    let venv_python = windows_venv(&root);
    let host = temp.path().join("host/python.exe");
    file(&host);
    let error = resolve(&root, Some(&host.to_string_lossy()), |path| path == host).unwrap_err();
    assert!(error.contains("不会改用系统 Python"), "{error}");
    assert!(
        error.contains(&venv_python.display().to_string()),
        "{error}"
    );
    // A .venv whose interpreter is gone still counts as the folder's own env.
    fs::remove_file(&venv_python).unwrap();
    let error = resolve(&root, Some(&host.to_string_lossy()), |path| path == host).unwrap_err();
    assert!(error.contains("不会改用系统 Python"), "{error}");
}

#[test]
fn a_selected_python_is_kept_for_a_folder_without_its_own_environment() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("Strata");
    strata(&root);
    let host = temp.path().join("host/python.exe");
    file(&host);
    let env = resolve(&root, Some(&host.to_string_lossy()), all_run).unwrap();
    assert_eq!(env.python, host);
    assert_eq!(env.kind, PythonKind::Selected);
    assert_eq!(env.ignored, None);
    let error = resolve(&root, Some(&host.to_string_lossy()), |_| false).unwrap_err();
    assert!(error.contains("所选 Python 无法运行"), "{error}");
}

#[test]
fn launcher_parsing_ignores_bare_python_and_non_server_lines() {
    let root = Path::new("/opt/strata");
    assert_eq!(
        launcher_python_in(root, "python serve\\server.py\r\n"),
        None
    );
    assert_eq!(
        launcher_python_in(root, "\"/bin/rm\" serve/server.py\n"),
        None
    );
    assert_eq!(
        launcher_python_in(root, "\"C:/x/python.exe\" setup.py\r\n"),
        None,
        "only the line that starts the server names the runtime interpreter"
    );
    assert_eq!(
        launcher_python_in(
            root,
            "#!/bin/sh\ncd \"/opt/strata\"\nexec \"/opt/strata/.venv/bin/python\" \"/opt/strata/serve/server.py\" --engine strata\n"
        ),
        Some(PathBuf::from("/opt/strata/.venv/bin/python"))
    );
    assert_eq!(
        launcher_vars_in(
            "set /a N=1\r\nset FOO=bar\r\nSET \"PythonHome=\"\r\nexport PYTHONPATH=\"$PWD/lib\"\n"
        ),
        vec![
            ("PYTHONHOME".to_string(), String::new()),
            ("PYTHONPATH".to_string(), "$PWD/lib".to_string()),
        ]
    );
}

#[test]
fn launch_env_is_the_venv_plus_launcher_vars_with_the_observer_first() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("Strata");
    strata(&root);
    windows_venv(&root);
    fs::write(
        root.join("run-iq3_s.bat"),
        "@echo off\r\nset \"PYTHONPATH=%~dp0vendor\"\r\nset PATH=%~dp0rocm\\bin;%PATH%\r\n\"%~dp0.venv\\Scripts\\python.exe\" \"%~dp0serve\\server.py\" --engine strata\r\n",
    )
    .unwrap();
    let env = resolve(&root, None, all_run).unwrap();
    let vars = HashMap::from([
        ("PATH", "/usr/bin".to_string()),
        ("PYTHONHOME", "/host/python".to_string()),
        ("VIRTUAL_ENV", "/host/other-venv".to_string()),
        ("PYTHONPATH", "/host/site".to_string()),
    ]);
    let observer = temp.path().join("observer-v1");
    let plan = env.env_plan(&host_env(&vars), Some(&observer));
    let s = sep();
    let main = std::path::MAIN_SEPARATOR;
    assert_eq!(
        plan["PYTHONHOME"], None,
        "a host PYTHONHOME must not leak in"
    );
    assert_eq!(
        plan["VIRTUAL_ENV"].as_deref(),
        Some(root.join(".venv").display().to_string().as_str())
    );
    assert_eq!(
        plan["PATH"].as_deref(),
        Some(
            format!(
                "{}{main}rocm\\bin;{}{s}/usr/bin",
                root.display(),
                root.join(".venv").join("Scripts").display()
            )
            .as_str()
        )
    );
    assert_eq!(
        plan["PYTHONPATH"].as_deref(),
        Some(format!("{}{s}{}{main}vendor", observer.display(), root.display()).as_str())
    );
    assert_eq!(plan["PYTHONIOENCODING"].as_deref(), Some("utf-8"));
}

#[test]
fn applied_command_runs_from_the_strata_folder_with_the_planned_env() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("Strata");
    strata(&root);
    let python = windows_venv(&root);
    let env = resolve(&root, None, all_run).unwrap();
    let mut command = std::process::Command::new(&env.python);
    env.apply(&mut command, Some(Path::new("/obs")));
    assert_eq!(command.get_program(), python.as_os_str());
    assert_eq!(command.get_current_dir(), Some(root.as_path()));
    let envs: HashMap<String, Option<String>> = command
        .get_envs()
        .map(|(k, v)| {
            (
                k.to_string_lossy().to_string(),
                v.map(|v| v.to_string_lossy().to_string()),
            )
        })
        .collect();
    assert_eq!(envs["PYTHONHOME"], None);
    assert_eq!(envs["PYTHONPATH"].as_deref(), Some("/obs"));
    assert!(envs["PATH"]
        .as_deref()
        .unwrap()
        .starts_with(&root.join(".venv").join("Scripts").display().to_string()));
}
