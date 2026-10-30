//! Waiting for a cold model load during startup.
//!
//! Upstream `POST /load` blocks until the weights are resident. A large model
//! (or a multi-GPU split on older PCIe) can take longer than the HTTP request
//! timeout while the engine keeps printing "still starting (N s)". A client
//! timeout there is not a failed load: the engine is still working. We keep
//! waiting on `/health` while the process is alive and only fail on a real
//! exit, an upstream rejection, or a generous ceiling.
use serde_json::Value;
use std::future::Future;
use std::time::{Duration, Instant};

use crate::diagnostics;

#[derive(Clone, Copy, Debug)]
pub(crate) struct LoadWait {
    /// Ceiling for the whole load, measured from the `/load` request.
    pub ceiling: Duration,
    /// Interval between liveness / readiness checks.
    pub poll: Duration,
    /// Interval between "still loading" progress lines.
    pub note_every: Duration,
}

impl LoadWait {
    pub(crate) const STARTUP: LoadWait = LoadWait {
        ceiling: Duration::from_secs(30 * 60),
        poll: Duration::from_secs(2),
        note_every: Duration::from_secs(30),
    };

    /// `STARTUP`, waiting at least as long as the run config's `"engine_ready_s"` (the
    /// server's own wait for the engine; a DeepSeek-V4.1 config sets 3600). Anything
    /// that is not a positive number keeps the 30-minute ceiling; 24 h is the cap.
    pub(crate) fn startup_for(config: &Value) -> LoadWait {
        let ready = config
            .get("engine_ready_s")
            .and_then(Value::as_f64)
            .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
            .map(|seconds| Duration::from_secs_f64(seconds.min(24.0 * 3600.0)));
        LoadWait {
            ceiling: ready.map_or(Self::STARTUP.ceiling, |ready| {
                ready.max(Self::STARTUP.ceiling)
            }),
            ..Self::STARTUP
        }
    }
}

/// The `/load` request never got an HTTP answer (send failure, reset or the
/// client timeout); an HTTP status or an invalid answer is a real rejection.
pub(crate) fn is_transport_failure(error: &str) -> bool {
    error.starts_with("HTTP 请求失败") || error.contains("operation timed out")
}

fn loaded(health: &Value) -> bool {
    health.get("loaded").and_then(Value::as_bool) == Some(true)
}

/// The final line of a Python traceback that upstream's HTTP server printed
/// for a request it could not answer ("Exception occurred during processing
/// of request ..." between two dashed rules). `/load` dies this way when the
/// engine cannot be started (#78: `FileNotFoundError: [WinError 2]` for a
/// configured engine exe that does not exist): the client only sees the
/// connection close, the API process keeps running and `/health` stays
/// `loaded: false`, so without this the start would wait for the 30-minute
/// ceiling. Only a complete block (closing rule seen) is reported.
pub(crate) fn request_handler_exception<'a>(
    lines: impl IntoIterator<Item = &'a str>,
) -> Option<String> {
    let mut inside = false;
    let mut last: Option<&str> = None;
    let mut found: Option<String> = None;
    for line in lines {
        let line = line.trim();
        if line.starts_with("Exception occurred during processing of request") {
            inside = true;
            last = None;
            continue;
        }
        if !inside {
            continue;
        }
        if !line.is_empty() && line.chars().all(|c| c == '-') {
            if let Some(last) = last {
                found = Some(last.to_owned());
            }
            inside = false;
            continue;
        }
        if line.is_empty() || line.starts_with("File ") || line.starts_with("Traceback") {
            continue;
        }
        let head = line.split(':').next().unwrap_or_default();
        if !head.is_empty()
            && !head.contains(' ')
            && (head.ends_with("Error") || head.ends_with("Exception") || head.ends_with("Died"))
        {
            last = Some(line);
        }
    }
    found
}

/// The last exception line anywhere in a log tail (a traceback that ended the
/// process is not inside a request-handler block).
fn last_exception_line<'a>(lines: impl IntoIterator<Item = &'a str>) -> Option<String> {
    lines
        .into_iter()
        .map(str::trim)
        .filter(|line| {
            let head = line.split(':').next().unwrap_or_default();
            !head.is_empty()
                && !head.contains(' ')
                && (head.ends_with("Error")
                    || head.ends_with("Exception")
                    || head.ends_with("Died"))
        })
        .last()
        .map(str::to_owned)
}

/// What the Python interpreter of this launch is allowed to import from:
/// the Strata folder, its venv and the venv's base installation (a venv's
/// traceback always shows the base `Lib\` for the standard library).
#[derive(Clone, Debug, Default)]
pub(crate) struct PythonFacts {
    pub python: String,
    pub allowed: Vec<String>,
}

impl PythonFacts {
    pub(crate) fn from_launcher(env: &crate::launcher_env::LauncherEnv) -> Self {
        let mut allowed = vec![env.cwd.display().to_string()];
        if let Some(venv) = &env.venv {
            allowed.push(venv.display().to_string());
            if let Ok(text) = std::fs::read_to_string(venv.join("pyvenv.cfg")) {
                for line in text.lines() {
                    if let Some((key, value)) = line.split_once('=') {
                        if key.trim().eq_ignore_ascii_case("home") {
                            let home = std::path::PathBuf::from(value.trim());
                            allowed.push(home.display().to_string());
                            if let Some(parent) = home.parent() {
                                allowed.push(parent.display().to_string());
                            }
                        }
                    }
                }
            }
        } else if let Some(dir) = env.python.parent() {
            allowed.push(dir.display().to_string());
        }
        Self {
            python: env.python.display().to_string(),
            allowed,
        }
    }
}

fn norm(path: &str) -> String {
    path.replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

/// A `File "...site-packages..."` traceback frame from outside the launch's
/// own environment: packages of another (usually the host) Python.
fn foreign_site_packages<'a>(
    lines: impl IntoIterator<Item = &'a str>,
    facts: &PythonFacts,
) -> Option<String> {
    let allowed: Vec<String> = facts
        .allowed
        .iter()
        .map(|a| norm(a))
        .filter(|a| !a.is_empty())
        .collect();
    lines.into_iter().find_map(|line| {
        let rest = line.trim().strip_prefix("File \"")?;
        let path = &rest[..rest.find('"')?];
        let key = norm(path);
        (key.contains("/site-packages/")
            && !allowed
                .iter()
                .any(|a| key == *a || key.starts_with(&format!("{a}/"))))
        .then(|| path.to_owned())
    })
}

/// Why a `/load` did not succeed, from the process state and the engine log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum LoadFailure {
    /// The API process exited, or the engine could not start / died while
    /// loading (the server printed a traceback instead of answering).
    EngineCrashed { summary: String },
    /// The traceback shows the wrong interpreter or missing packages.
    PythonEnv { summary: String },
    /// Nothing points at a failure: the engine is still working (#70).
    StillLoading,
}

/// Classify a `/load` failure. `exited` is `Some(exit code)` once the API
/// process ended; `log_tail` are its stderr lines since the load started.
pub(crate) fn classify_load_failure(
    exited: Option<Option<i32>>,
    log_tail: &[&str],
    facts: &PythonFacts,
) -> LoadFailure {
    let handler = request_handler_exception(log_tail.iter().copied());
    let summary = handler
        .clone()
        .or_else(|| last_exception_line(log_tail.iter().copied()));
    if let Some(summary) = &summary {
        if summary.starts_with("ModuleNotFoundError")
            || summary.starts_with("ImportError")
            || summary.contains("No module named")
        {
            return LoadFailure::PythonEnv {
                summary: summary.clone(),
            };
        }
    }
    if exited.is_some() || handler.is_some() {
        if let Some(path) = foreign_site_packages(log_tail.iter().copied(), facts) {
            return LoadFailure::PythonEnv {
                summary: format!(
                    "{}（报错来自其他 Python 的包：{path}）",
                    summary.clone().unwrap_or_default()
                ),
            };
        }
    }
    match (exited, summary) {
        (Some(_), Some(summary)) => LoadFailure::EngineCrashed { summary },
        (Some(code), None) => LoadFailure::EngineCrashed {
            summary: format!("进程已退出，exit {code:?} / process exited, exit {code:?}"),
        },
        (None, Some(summary)) if handler.is_some() => LoadFailure::EngineCrashed { summary },
        _ => LoadFailure::StillLoading,
    }
}

/// The startup diagnostic for a classified failure; `None` keeps waiting.
pub(crate) fn load_failure_error(failure: &LoadFailure, facts: &PythonFacts) -> Option<String> {
    match failure {
        LoadFailure::StillLoading => None,
        LoadFailure::EngineCrashed { summary } => {
            let hint = if summary.contains("WinError 2") || summary.starts_with("FileNotFoundError") {
                "找不到引擎程序，请检查模型配置里的 exe 路径，或在该 Strata 目录运行 START-HERE.bat --setup 修复 / The engine program was not found: check the config's exe path or run START-HERE.bat --setup in that Strata folder"
            } else {
                "完整报错见启动日志 / See the startup log for the full traceback"
            };
            let summary = summary.trim_end_matches(['。', '.']);
            Some(diagnostics::error(
                "STARTUP_ENGINE_CRASHED",
                format!("引擎在加载模型时崩溃：{summary}。{hint}"),
                "loading",
            ))
        }
        LoadFailure::PythonEnv { summary } => Some(diagnostics::error(
            "STARTUP_PYTHON_ENV_MISMATCH",
            format!(
                "Python 环境不对：本次使用的是 {}，报错 {summary}。应使用该 Strata 目录自带的 .venv 或嵌入式 Python（与 run-*.bat 一致），可在该目录运行 UPDATE.bat 修复 / Wrong Python environment: {} was used; it should be the folder's own .venv or embedded Python, as run-*.bat uses",
                facts.python, facts.python
            ),
            "loading",
        )),
    }
}

/// `alive` returns `Ok(None)` while the process runs and `Ok(Some(exit))` once it exited.
#[cfg(test)]
pub(crate) async fn wait_for_model_load<L, H, HF>(
    load: L,
    health: H,
    alive: impl FnMut() -> Result<Option<Option<i32>>, String>,
    note: impl FnMut(String),
    wait: LoadWait,
) -> Result<(), String>
where
    L: Future<Output = Result<Value, String>>,
    H: FnMut() -> HF,
    HF: Future<Output = Result<Value, String>>,
{
    wait_for_model_load_checked(load, health, alive, |_| None, note, wait).await
}

/// Like `wait_for_model_load`; `engine_failed(exited)` classifies a failed
/// `/load` from the process state and log tail (see [`classify_load_failure`])
/// and returns the diagnostic, or `None` while the engine is still working.
pub(crate) async fn wait_for_model_load_checked<L, H, HF>(
    load: L,
    mut health: H,
    mut alive: impl FnMut() -> Result<Option<Option<i32>>, String>,
    mut engine_failed: impl FnMut(Option<Option<i32>>) -> Option<String>,
    mut note: impl FnMut(String),
    wait: LoadWait,
) -> Result<(), String>
where
    L: Future<Output = Result<Value, String>>,
    H: FnMut() -> HF,
    HF: Future<Output = Result<Value, String>>,
{
    let started = Instant::now();
    let mut last_note = started;
    let mut load = std::pin::pin!(load);
    // None: the request is still in flight; Some(true): upstream answered "loaded";
    // Some(false): the request ended without an HTTP answer and we poll /health.
    let mut answered: Option<bool> = None;
    loop {
        if answered.is_none() {
            tokio::select! {
                result = &mut load => match result {
                    Ok(value) => {
                        if !matches!(value.get("status").and_then(Value::as_str), Some("loaded" | "already loaded")) {
                            return Err(format!("模型加载未完成: {value}"));
                        }
                        answered = Some(true);
                    }
                    Err(error) if is_transport_failure(&error) => {
                        note(format!(
                            "启动阶段：加载请求在 {} 秒后未返回，引擎仍在加载；继续等待模型就绪",
                            started.elapsed().as_secs()
                        ));
                        // The raw transport error stays in the log only (#78).
                        note(format!("加载请求原始错误 / raw /load error: {error}"));
                        last_note = Instant::now();
                        answered = Some(false);
                    }
                    Err(error) => {
                        if let Some(classified) = engine_failed(None) {
                            note(format!("加载请求原始错误 / raw /load error: {error}"));
                            return Err(classified);
                        }
                        return Err(diagnostics::during(&error, "loading"));
                    }
                },
                _ = tokio::time::sleep(wait.poll) => {}
            }
        } else {
            tokio::time::sleep(wait.poll).await;
        }
        if let Some(exit) = alive()? {
            if let Some(classified) = engine_failed(Some(exit)) {
                return Err(classified);
            }
            return Err(diagnostics::error(
                "STARTUP_PROCESS_EXITED",
                format!("模型加载期间本机服务退出，exit {exit:?}；请查看启动日志"),
                "loading",
            ));
        }
        match answered {
            Some(true) => {
                let value = health()
                    .await
                    .map_err(|error| diagnostics::during(&error, "loading"))?;
                return if loaded(&value) {
                    Ok(())
                } else {
                    Err("模型加载响应成功但健康状态未就绪".into())
                };
            }
            Some(false) => {
                if let Some(classified) = engine_failed(None) {
                    return Err(classified);
                }
                // The API can be briefly unresponsive while weights are mapped.
                let ready = health().await.is_ok_and(|value| loaded(&value));
                if ready {
                    return Ok(());
                }
            }
            None => {}
        }
        if started.elapsed() >= wait.ceiling {
            return Err(diagnostics::error(
                "STARTUP_LOAD_TIMEOUT",
                format!(
                    "模型在 {} 分钟内仍未加载完成；服务进程仍保留，可稍后在总览查看状态或查看启动日志",
                    wait.ceiling.as_secs().div_ceil(60)
                ),
                "loading",
            ));
        }
        if last_note.elapsed() >= wait.note_every {
            last_note = Instant::now();
            note(format!(
                "启动阶段：模型仍在加载（已 {} 秒），请稍候",
                started.elapsed().as_secs()
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::{Cell, RefCell};

    const FAST: LoadWait = LoadWait {
        ceiling: Duration::from_millis(400),
        poll: Duration::from_millis(5),
        note_every: Duration::from_millis(20),
    };

    fn code(error: &str) -> String {
        serde_json::from_str::<Value>(error).unwrap()["code"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    #[test]
    fn the_startup_ceiling_is_the_longer_of_engine_ready_s_and_thirty_minutes() {
        let ceiling = |config: Value| LoadWait::startup_for(&config).ceiling.as_secs();
        assert_eq!(ceiling(serde_json::json!({})), 1800);
        assert_eq!(ceiling(serde_json::json!({"engine_ready_s": 3600})), 3600);
        assert_eq!(ceiling(serde_json::json!({"engine_ready_s": 600})), 1800);
        assert_eq!(ceiling(serde_json::json!({"engine_ready_s": 2400.5})), 2400);
        for bad in [
            serde_json::json!(0),
            serde_json::json!(-5),
            serde_json::json!("3600"),
            serde_json::json!(null),
            serde_json::json!(true),
        ] {
            assert_eq!(ceiling(serde_json::json!({"engine_ready_s": bad})), 1800);
        }
        assert_eq!(
            ceiling(serde_json::json!({"engine_ready_s": 1e12})),
            24 * 3600
        );
        assert_eq!(
            LoadWait::startup_for(&serde_json::json!({})).poll,
            LoadWait::STARTUP.poll
        );
    }

    #[tokio::test]
    async fn a_load_request_timeout_while_the_engine_keeps_loading_is_not_a_failure() {
        // Shape of the Xiaohongshu report: /load gives up after the client timeout,
        // the engine prints "still starting (261 s)" and becomes ready later.
        let probes = Cell::new(0);
        let notes = RefCell::new(Vec::new());
        let result = wait_for_model_load(
            async {
                Err(
                    "HTTP 请求失败: error sending request for url (http://127.0.0.1:8080/load)"
                        .into(),
                )
            },
            || {
                probes.set(probes.get() + 1);
                let ready = probes.get() >= 4;
                async move {
                    if ready {
                        Ok(json!({"loaded": true}))
                    } else {
                        Ok(json!({"loaded": false}))
                    }
                }
            },
            || Ok(None),
            |line| notes.borrow_mut().push(line),
            FAST,
        )
        .await;
        assert_eq!(result, Ok(()));
        assert!(probes.get() >= 4);
        assert!(
            notes.borrow()[0].contains("引擎仍在加载"),
            "{:?}",
            notes.borrow()
        );
    }

    #[tokio::test]
    async fn an_unreachable_health_probe_during_mapping_keeps_waiting() {
        let probes = Cell::new(0);
        let result = wait_for_model_load(
            async { Err("HTTP 请求失败: operation timed out".into()) },
            || {
                probes.set(probes.get() + 1);
                let n = probes.get();
                async move {
                    match n {
                        1 | 2 => Err("HTTP 请求失败: connection refused".to_string()),
                        _ => Ok(json!({"loaded": true})),
                    }
                }
            },
            || Ok(None),
            |_| {},
            FAST,
        )
        .await;
        assert_eq!(result, Ok(()));
    }

    #[tokio::test]
    async fn a_slow_but_successful_load_reports_progress_and_succeeds() {
        let notes = RefCell::new(Vec::new());
        let result = wait_for_model_load(
            async {
                tokio::time::sleep(Duration::from_millis(80)).await;
                Ok(json!({"status": "loaded"}))
            },
            || async { Ok(json!({"loaded": true})) },
            || Ok(None),
            |line| notes.borrow_mut().push(line),
            FAST,
        )
        .await;
        assert_eq!(result, Ok(()));
        assert!(notes
            .borrow()
            .iter()
            .any(|line| line.contains("模型仍在加载")));
    }

    #[tokio::test]
    async fn the_process_exiting_during_load_is_a_real_failure() {
        let checks = Cell::new(0);
        let result = wait_for_model_load(
            std::future::pending::<Result<Value, String>>(),
            || async { Ok(json!({"loaded": false})) },
            || {
                checks.set(checks.get() + 1);
                Ok(if checks.get() > 2 {
                    Some(Some(3))
                } else {
                    None
                })
            },
            |_| {},
            FAST,
        )
        .await
        .unwrap_err();
        assert_eq!(code(&result), "STARTUP_PROCESS_EXITED");
        assert!(result.contains("loading"));
    }

    #[tokio::test]
    async fn an_upstream_http_rejection_is_reported_immediately() {
        let result = wait_for_model_load(
            async { Err(r#"HTTP 500: {"error":{"message":"bad model"}}"#.into()) },
            || async { Ok(json!({"loaded": false})) },
            || Ok(None),
            |_| {},
            FAST,
        )
        .await
        .unwrap_err();
        let value: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(value["message"], "bad model");
        assert_eq!(value["details"]["startupPhase"], "loading");
    }

    #[tokio::test]
    async fn a_load_that_never_finishes_stops_at_the_ceiling_with_a_readable_message() {
        let result = wait_for_model_load(
            async { Err("HTTP 请求失败: operation timed out".into()) },
            || async { Ok(json!({"loaded": false})) },
            || Ok(None),
            |_| {},
            FAST,
        )
        .await
        .unwrap_err();
        assert_eq!(code(&result), "STARTUP_LOAD_TIMEOUT");
        assert!(result.contains("服务进程仍保留"));
    }

    /// The #78 log: the /load handler died starting the engine.
    const ISSUE_78: &str = r#"[strata] starting the engine: reading the model's weights ...
----------------------------------------
Exception occurred during processing of request from ('127.0.0.1', 65257)
Traceback (most recent call last):
File "C:\Program Files\Python\Python312\Lib\socketserver.py", line 697, in process_request_thread
self.finish_request(request, client_address)
File "I:\Strata-0.1.45\serve\server.py", line 81, in popen
return subprocess.Popen(args, **kw)
^^^^^^^^^^^^^^^^^^^^^^^^^^^^
File "C:\Program Files\Python\Python312\Lib\subprocess.py", line 1538, in _execute_child
hp, ht, pid, tid = _winapi.CreateProcess(executable, args,
FileNotFoundError: [WinError 2] 系统找不到指定的文件。
----------------------------------------"#;

    fn facts() -> PythonFacts {
        PythonFacts {
            python: r"I:\Strata-0.1.45\.venv\Scripts\python.exe".into(),
            allowed: vec![
                r"I:\Strata-0.1.45".into(),
                r"I:\Strata-0.1.45\.venv".into(),
                r"C:\Program Files\Python\Python312".into(),
            ],
        }
    }

    #[test]
    fn the_issue_78_traceback_is_an_engine_crash_with_its_exception_line() {
        assert_eq!(
            request_handler_exception(ISSUE_78.lines()).as_deref(),
            Some("FileNotFoundError: [WinError 2] 系统找不到指定的文件。")
        );
        let tail: Vec<&str> = ISSUE_78.lines().collect();
        let failure = classify_load_failure(None, &tail, &facts());
        assert_eq!(
            failure,
            LoadFailure::EngineCrashed {
                summary: "FileNotFoundError: [WinError 2] 系统找不到指定的文件。".into()
            }
        );
        let message = load_failure_error(&failure, &facts()).unwrap();
        assert_eq!(code(&message), "STARTUP_ENGINE_CRASHED");
        assert!(message.contains("引擎在加载模型时崩溃"), "{message}");
        assert!(message.contains("exe"), "{message}");
        assert!(!message.contains("error sending request"), "{message}");
    }

    #[test]
    fn an_incomplete_traceback_or_plain_progress_is_still_loading() {
        let partial: Vec<&str> = ISSUE_78.lines().take(10).collect();
        assert_eq!(
            classify_load_failure(None, &partial, &facts()),
            LoadFailure::StillLoading
        );
        let progress = [
            "[strata] still starting (261 s)",
            "ready: http://127.0.0.1:8080/v1",
        ];
        assert_eq!(
            classify_load_failure(None, &progress, &facts()),
            LoadFailure::StillLoading
        );
        assert_eq!(
            load_failure_error(&LoadFailure::StillLoading, &facts()),
            None
        );
    }

    #[test]
    fn an_exited_process_is_a_crash_with_the_last_exception_or_exit_code() {
        let tail = [
            "Traceback (most recent call last):",
            r#"File "I:\Strata-0.1.45\serve\server.py", line 1088, in restart"#,
            "RuntimeError: the engine exited while loading (exit code 3221225477)",
        ];
        assert_eq!(
            classify_load_failure(Some(Some(1)), &tail, &facts()),
            LoadFailure::EngineCrashed {
                summary: "RuntimeError: the engine exited while loading (exit code 3221225477)"
                    .into()
            }
        );
        match classify_load_failure(Some(Some(-1)), &[], &facts()) {
            LoadFailure::EngineCrashed { summary } => assert!(summary.contains("exit Some(-1)")),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn missing_modules_or_host_site_packages_are_a_python_env_problem() {
        let tail = [
            "Traceback (most recent call last):",
            r#"File "I:\Strata-0.1.45\serve\server.py", line 12, in <module>"#,
            "ModuleNotFoundError: No module named 'jinja2'",
        ];
        let failure = classify_load_failure(Some(Some(1)), &tail, &facts());
        assert!(
            matches!(failure, LoadFailure::PythonEnv { .. }),
            "{failure:?}"
        );
        let message = load_failure_error(&failure, &facts()).unwrap();
        assert_eq!(code(&message), "STARTUP_PYTHON_ENV_MISMATCH");
        let message = serde_json::from_str::<Value>(&message).unwrap()["message"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(
            message.contains(r"I:\Strata-0.1.45\.venv\Scripts\python.exe"),
            "{message}"
        );
        assert!(message.contains(".venv"), "{message}");
        // Packages imported from the host's site-packages, not the venv's.
        let host = [
            "Exception occurred during processing of request from ('127.0.0.1', 1)",
            r#"File "C:\Users\u\AppData\Roaming\Python\Python312\site-packages\numpy\core\__init__.py", line 3"#,
            "OSError: [WinError 126] module could not be found",
            "----------------------------------------",
        ];
        assert!(matches!(
            classify_load_failure(None, &host, &facts()),
            LoadFailure::PythonEnv { .. }
        ));
        // The venv's own site-packages and the base Lib are not foreign.
        let own = [
            "Exception occurred during processing of request from ('127.0.0.1', 1)",
            r#"File "C:\Program Files\Python\Python312\Lib\socketserver.py", line 697"#,
            r#"File "I:\Strata-0.1.45\.venv\Lib\site-packages\regex\regex.py", line 3"#,
            "ValueError: bad",
            "----------------------------------------",
        ];
        assert_eq!(
            classify_load_failure(None, &own, &facts()),
            LoadFailure::EngineCrashed {
                summary: "ValueError: bad".into()
            }
        );
    }

    #[tokio::test]
    async fn a_load_handler_crash_fails_fast_instead_of_waiting_for_the_ceiling() {
        let slow = LoadWait {
            ceiling: Duration::from_secs(60),
            ..FAST
        };
        let started = std::time::Instant::now();
        let tail: Vec<&str> = ISSUE_78.lines().collect();
        let notes = RefCell::new(Vec::new());
        let result = wait_for_model_load_checked(
            async {
                Err(
                    "HTTP 请求失败: error sending request for url (http://127.0.0.1:8080/load)"
                        .into(),
                )
            },
            || async { Ok(json!({"loaded": false})) },
            || Ok(None),
            |exited| load_failure_error(&classify_load_failure(exited, &tail, &facts()), &facts()),
            |line| notes.borrow_mut().push(line),
            slow,
        )
        .await
        .unwrap_err();
        assert_eq!(code(&result), "STARTUP_ENGINE_CRASHED");
        assert!(result.contains("WinError 2"), "{result}");
        assert!(!result.contains("error sending request"), "{result}");
        assert!(
            notes
                .borrow()
                .iter()
                .any(|line| line.contains("error sending request")),
            "the raw error stays in the log: {:?}",
            notes.borrow()
        );
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
