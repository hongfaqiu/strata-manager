//! Header-only GGUF inspection via a registered official runtime's setup.py.
use crate::{processes::{self, Step}, types::{ServiceProfile, TaskStatus}, RuntimeState};
use serde::{Deserialize, Serialize};
use std::{path::{Path, PathBuf}, sync::Arc};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelInspectRequest {
    pub installation_id: String,
    pub target: String,
    pub variant: Option<String>,
}

fn controls(value: &str) -> bool { value.chars().any(|c| c.is_control()) }

pub fn validate_target(value: &str) -> Result<String, String> {
    let target = value.trim();
    if target.is_empty() || target.len() > 4096 || controls(value) || target.starts_with('-') {
        return Err("请填写有效模型文件、目录或仓库来源".into());
    }
    if let Some(repo) = target.strip_prefix("hf:").or_else(|| target.strip_prefix("ms:")) {
        let parts: Vec<_> = repo.split('/').collect();
        if parts.len() != 2 || parts.iter().any(|part| part.is_empty() || [".", ".."].contains(part) || !part.bytes().all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))) {
            return Err("仓库格式为 hf:owner/repo 或 ms:owner/repo".into());
        }
        return Ok(target.to_owned());
    }
    if target.to_ascii_lowercase().starts_with("http:") || target.to_ascii_lowercase().starts_with("https:") {
        let url = url::Url::parse(target).map_err(|_| "远程模型地址无效")?;
        if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || target.contains('\\') {
            return Err("远程模型需使用 HTTPS，且不能包含凭据、查询参数或片段".into());
        }
        return Ok(target.to_owned());
    }
    let path = Path::new(target);
    if !path.is_absolute() || !(path.is_file() || path.is_dir()) {
        return Err("本地模型必须为现有文件或目录的绝对路径".into());
    }
    // Preserve user spelling/spaces; direct argv handles them without shell quoting.
    Ok(target.to_owned())
}

pub fn inspect_step(profile: &ServiceProfile, request: &ModelInspectRequest) -> Result<Step, String> {
    let root = processes::runtime_dir(profile)?;
    if !root.join("tools/strata_inspect.py").is_file() {
        return Err("该运行环境尚未提供官方 GGUF 检查工具，请先更新 Strata".into());
    }
    let python = PathBuf::from(processes::python(profile)?);
    if !python.is_absolute() || !python.is_file() {
        return Err("此运行环境未登记可用的 Python，请先准备完整运行环境".into());
    }
    let target = validate_target(&request.target)?;
    let mut args = vec!["-u".into(), "setup.py".into(), "--inspect".into(), target];
    if let Some(variant) = request.variant.as_deref().map(str::trim).filter(|x| !x.is_empty()) {
        if variant.len() > 128 || variant.starts_with('-') || [".", ".."].contains(&variant) || !variant.bytes().all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c)) {
            return Err("量化筛选格式无效".into());
        }
        args.push(variant.to_owned());
    }
    Ok(Step { program: python.to_string_lossy().into_owned(), args, cwd: root, env: Default::default() })
}

pub fn start(state: Arc<RuntimeState>, request: ModelInspectRequest) -> Result<TaskStatus, String> {
    if request.installation_id.trim().is_empty() || controls(&request.installation_id) {
        return Err("请选择已登记的运行环境".into());
    }
    // Resolve only backend-held runtime records, never executable paths from the caller.
    let mut profile = state.registered_profiles()?.into_iter().find(|p| p.id == request.installation_id);
    if profile.is_none() {
        let installation = crate::installation::status(&state)?;
        profile = installation.result.filter(|runtime| runtime.installation_id == request.installation_id || runtime.profile.id == request.installation_id).map(|runtime| runtime.profile)
            .or_else(|| installation.detected_runtimes.into_iter().find(|runtime| runtime.profile.id == request.installation_id && runtime.readiness == "ready").map(|runtime| runtime.profile));
    }
    let profile = profile.ok_or("该运行环境未登记或已不可用，请重新检测")?;
    let step = inspect_step(&profile, &request)?;
    let _operation = state.runtime_operations.lock().map_err(|e| e.to_string())?;
    crate::runtime_upgrade::assert_available(&state)?;
    // Existing task machinery owns the process tree, cancellation and persisted logs.
    processes::launch_task(state.tasks.clone(), state.logs.clone(), state.database.clone(), "model-inspect", Some(profile.id), vec![step])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspection_rejects_flags_relative_paths_and_remote_secrets() {
        for target in ["--setup", "relative.gguf", "hf:owner/repo --yes", "http://host/file.gguf", "https://u:p@host/file.gguf", "https://host/file.gguf?token=secret", "https://host/file.gguf\n"] {
            assert!(validate_target(target).is_err(), "{target}");
        }
        assert_eq!(validate_target("hf:owner/repo").unwrap(), "hf:owner/repo");
        assert_eq!(validate_target("ms:owner/repo").unwrap(), "ms:owner/repo");
    }

    #[test]
    fn inspect_plan_is_read_only_and_uses_the_registered_interpreter() {
        let fixture = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(fixture.path().join("serve")).unwrap();
        std::fs::create_dir_all(fixture.path().join("tools")).unwrap();
        for name in ["setup.py", "serve/server.py", "tools/strata_inspect.py", "fixture-python", "模型 文件.gguf"] { std::fs::write(fixture.path().join(name), "fixture").unwrap(); }
        let root = fixture.path().to_string_lossy().into_owned();
        let profile = ServiceProfile { id:"fixture".into(), name:"fixture".into(), base_url:"http://127.0.0.1:1".into(), install_dir:root, python_path:fixture.path().join("fixture-python").to_string_lossy().into_owned(), config_path:String::new(), managed:true };
        let request = ModelInspectRequest { installation_id:profile.id.clone(), target:fixture.path().join("模型 文件.gguf").to_string_lossy().into_owned(), variant:Some("IQ3_S".into()) };
        let step = inspect_step(&profile, &request).unwrap();
        assert_eq!(step.args, ["-u", "setup.py", "--inspect", &request.target, "IQ3_S"]);
        assert_eq!(step.program, profile.python_path);
        assert!(!step.args.iter().any(|flag| ["--setup", "--yes", "--build"].contains(&flag.as_str())));
        let invalid = ModelInspectRequest { variant:Some("--setup".into()), ..request };
        assert!(inspect_step(&profile, &invalid).is_err());
        assert_eq!(std::fs::read_to_string(fixture.path().join("模型 文件.gguf")).unwrap(), "fixture");
    }

    #[test]
    #[ignore = "Explicit isolated Python process fixture; set STRATA_MANAGER_TEST_PYTHON to an absolute interpreter"]
    fn isolated_inspect_task_reports_output_and_cancels_without_model_start() {
        use std::{sync::Mutex, time::{Duration, Instant}};
        let interpreter = std::env::var("STRATA_MANAGER_TEST_PYTHON").expect("set STRATA_MANAGER_TEST_PYTHON for this isolated fixture");
        let fixture = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(fixture.path().join("serve")).unwrap();
        std::fs::create_dir_all(fixture.path().join("tools")).unwrap();
        std::fs::write(fixture.path().join("serve/server.py"), "# fixture only").unwrap();
        std::fs::write(fixture.path().join("tools/strata_inspect.py"), "# fixture only").unwrap();
        std::fs::write(fixture.path().join("setup.py"), "import sys,time,pathlib\nassert sys.argv[1] == '--inspect'\nassert '--setup' not in sys.argv\nprint('HEADER IQ3_S compatible',flush=True)\nif sys.argv[2].endswith('wait.gguf'): time.sleep(30)\n").unwrap();
        for name in ["model.gguf", "wait.gguf"] { std::fs::write(fixture.path().join(name), "header fixture").unwrap(); }
        let profile = ServiceProfile { id:"inspect-fixture".into(), name:"fixture".into(), base_url:"http://127.0.0.1:1".into(), install_dir:fixture.path().to_string_lossy().into_owned(), python_path:interpreter, config_path:String::new(), managed:true };
        let tasks: processes::Tasks = Default::default();
        let logs: processes::Logs = Default::default();
        let database = Arc::new(Mutex::new(rusqlite::Connection::open_in_memory().unwrap()));
        database.lock().unwrap().execute_batch("CREATE TABLE tasks(id TEXT PRIMARY KEY,status TEXT NOT NULL,profile_id TEXT)").unwrap();
        let launch = |name: &str| {
            let request = ModelInspectRequest { installation_id:profile.id.clone(), target:fixture.path().join(name).to_string_lossy().into_owned(), variant:None };
            processes::launch_task(tasks.clone(), logs.clone(), database.clone(), "model-inspect", Some(profile.id.clone()), vec![inspect_step(&profile, &request).unwrap()]).unwrap()
        };
        let wait = |id: &str| {
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                let task = tasks.lock().unwrap()[id].status.clone();
                if task.state != "running" { break task; }
                assert!(Instant::now() < deadline, "inspect fixture timeout");
                std::thread::sleep(Duration::from_millis(25));
            }
        };
        let complete = launch("model.gguf");
        assert_eq!(wait(&complete.id).state, "completed");
        assert!(logs.lock().unwrap().get(&complete.id).unwrap().iter().any(|entry| entry.message.contains("HEADER IQ3_S compatible")));
        let cancel = launch("wait.gguf");
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if logs.lock().unwrap().get(&cancel.id).is_some_and(|entries| entries.iter().any(|entry| entry.message.contains("HEADER IQ3_S compatible"))) { break; }
            assert!(Instant::now() < deadline, "inspection never started");
            std::thread::sleep(Duration::from_millis(25));
        }
        {
            let mut records = tasks.lock().unwrap();
            let record = records.get_mut(&cancel.id).unwrap();
            record.cancelled = true;
            record.process.as_mut().unwrap().stop().unwrap();
        }
        assert_eq!(wait(&cancel.id).state, "cancelled");
        assert!(!fixture.path().join("models").exists());
        assert!(!fixture.path().join("strata-iq3_s.json").exists());
        assert_eq!(std::fs::read_to_string(fixture.path().join("model.gguf")).unwrap(), "header fixture");
    }
}
