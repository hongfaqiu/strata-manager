//! Real upstream MockEngine HTTP, exact owned process handles and temporary DBs.
use super::*;
use crate::processes::OwnedProcess;
use std::{ffi::OsStr, io, path::PathBuf, process::Command};

fn select_python(
    configured: Option<&Path>,
    windows: bool,
    mut probe: impl FnMut(&OsStr) -> io::Result<String>,
) -> io::Result<String> {
    // setup-python installs the fixture dependencies into this interpreter.
    // The Windows launcher may select a different registered Python entirely.
    if let Some(directory) = configured {
        if !directory.is_absolute() || !directory.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "configured fixture Python directory is invalid",
            ));
        }
        return probe(
            directory
                .join(if windows { "python.exe" } else { "bin/python" })
                .as_os_str(),
        );
    }
    let candidates = if windows {
        ["python", "py"]
    } else {
        ["python3", "python"]
    };
    for candidate in candidates {
        match probe(OsStr::new(candidate)) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            result => return result,
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "CPU HTTP capture fixtures require Python",
    ))
}

fn probe_python(program: &OsStr) -> io::Result<String> {
    let mut command = Command::new(program);
    // Keep site-packages for the two actual MockEngine dependencies; -I prevents
    // an unrelated PYTHONPATH from making an unprepared interpreter look ready.
    command.args(["-I", "-c", "import json,sys,jinja2,markupsafe;print(json.dumps({'executable':sys.executable,'version':sys.version}))"]);
    crate::processes::hidden(&mut command);
    let output = command.output()?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "capture fixture Python {:?} failed dependency preflight ({}): {}",
            program,
            output.status,
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(8192)
                .collect::<String>()
        )));
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let executable = value["executable"]
        .as_str()
        .filter(|path| Path::new(path).is_absolute() && Path::new(path).is_file())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "fixture Python returned an invalid executable",
            )
        })?;
    eprintln!(
        "capture CPU fixture interpreter: {executable}; version={:?}",
        value["version"]
    );
    Ok(executable.into())
}

fn python() -> String {
    let configured = std::env::var_os("pythonLocation").map(PathBuf::from);
    select_python(configured.as_deref(), cfg!(windows), probe_python)
        .expect("CPU HTTP capture fixture interpreter/dependencies are not ready")
}

#[test]
fn configured_ci_interpreter_is_used_instead_of_the_windows_launcher() {
    let directory = tempfile::tempdir().unwrap();
    let expected = directory.path().join("python.exe");
    let mut calls = Vec::new();
    let selected = select_python(Some(directory.path()), true, |program| {
        calls.push(program.to_os_string());
        Ok("prepared-interpreter".into())
    })
    .unwrap();
    assert_eq!(selected, "prepared-interpreter");
    assert_eq!(calls, [expected.into_os_string()]);
}

#[test]
fn configured_ci_interpreter_failure_never_falls_back_to_another_installation() {
    let directory = tempfile::tempdir().unwrap();
    let mut calls = Vec::new();
    let error = select_python(Some(directory.path()), true, |program| {
        calls.push(program.to_os_string());
        Err(io::Error::new(
            io::ErrorKind::NotFound,
            "selected CI Python is absent",
        ))
    })
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::NotFound);
    assert_eq!(
        calls,
        [directory.path().join("python.exe").into_os_string()]
    );
}

#[test]
fn local_launcher_fallback_requires_a_missing_path_interpreter() {
    let mut calls = Vec::new();
    let selected = select_python(None, true, |program| {
        calls.push(program.to_os_string());
        if program == "python" {
            Err(io::Error::new(io::ErrorKind::NotFound, "no PATH Python"))
        } else {
            Ok("local-launcher-interpreter".into())
        }
    })
    .unwrap();
    assert_eq!(selected, "local-launcher-interpreter");
    assert_eq!(calls, [OsStr::new("python"), OsStr::new("py")]);

    calls.clear();
    let error = select_python(None, true, |program| {
        calls.push(program.to_os_string());
        Err(io::Error::other(
            "PATH Python has no MockEngine dependencies",
        ))
    })
    .unwrap_err();
    assert!(error.to_string().contains("dependencies"));
    assert_eq!(calls, [OsStr::new("python")]);
}

#[test]
fn actual_private_stdlib_only_interpreter_fails_dependency_preflight() {
    let prepared = python();
    let directory = tempfile::tempdir().unwrap();
    let environment = directory.path().join("stdlib-only");
    let mut command = Command::new(prepared);
    command
        .args(["-I", "-m", "venv", "--without-pip"])
        .arg(&environment);
    crate::processes::hidden(&mut command);
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "private fixture venv creation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let program = environment.join(if cfg!(windows) {
        "Scripts/python.exe"
    } else {
        "bin/python"
    });
    let error = probe_python(program.as_os_str()).unwrap_err();
    assert!(error.to_string().contains("failed dependency preflight"));
    assert!(error.to_string().contains("jinja2"));
}

struct Fixture {
    state: Arc<RuntimeState>,
    profile: ServiceProfile,
    original: Vec<u8>,
    _directory: tempfile::TempDir,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.state.cleanup();
    }
}
impl Fixture {
    async fn new(manual: bool, delay: bool) -> Self {
        let root = std::env::var_os("STRATA_TEST_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.reference/strata")
            });
        assert!(
            root.join("serve/server.py").is_file(),
            "provide the pinned upstream with STRATA_TEST_ROOT; this test never skips"
        );
        let directory = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(directory.path().join("private-data")).unwrap();
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let profile = ServiceProfile {
            id: format!("capture-{}", uuid::Uuid::new_v4()),
            name: "isolated capture CPU HTTP".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            install_dir: root.to_string_lossy().into(),
            python_path: python(),
            config_path: directory
                .path()
                .join("user-config.json")
                .to_string_lossy()
                .into(),
            managed: true,
        };
        let original =
            serde_json::to_vec_pretty(&json!({"api_monitor":manual,"userField":"preserve bytes"}))
                .unwrap();
        fs::write(&profile.config_path, &original).unwrap();
        state
            .database
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO local_installations VALUES(?1,?2,?3,?4)",
                rusqlite::params![
                    profile.id,
                    serde_json::to_string(&profile).unwrap(),
                    serde_json::to_string(&profile).unwrap(),
                    crate::now() as i64
                ],
            )
            .unwrap();
        let bootstrap = crate::observer::install_bootstrap(state.data_dir()).unwrap();
        let mut command = Command::new(&profile.python_path);
        command
            .current_dir(&root)
            .args([
                "-u",
                "-m",
                "serve.server",
                "--engine",
                "mock",
                "--port",
                &port.to_string(),
                "--host",
                "127.0.0.1",
                "--script",
                "</think>\n\nCPU_CAPTURE_REPLY",
            ])
            .env("PYTHONPATH", bootstrap)
            .env(
                "STRATA_MANAGER_ANALYTICS_DIR",
                state.data_dir().join("analytics"),
            )
            .env("STRATA_MANAGER_SERVICE_ID", &profile.id);
        if manual {
            command.arg("--api-monitor");
        }
        if delay {
            command.args(["--delay", "0.03"]);
        }
        let mut process = OwnedProcess::spawn(command, state.logs.clone(), &profile.id).unwrap();
        process.profile = Some(profile.clone());
        state
            .processes
            .lock()
            .unwrap()
            .insert(profile.id.clone(), process);
        let fixture = Self {
            state,
            profile,
            original,
            _directory: directory,
        };
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let capture = status(&fixture.state, &fixture.profile.id).unwrap();
            if capture.state != "unavailable" {
                break;
            }
            let (process, readers_pending) = {
                let mut processes = fixture.state.processes.lock().unwrap();
                let process = processes.get_mut(&fixture.profile.id).unwrap();
                (
                    process.refresh().unwrap(),
                    process.readers_pending.load(Ordering::Acquire),
                )
            };
            assert!(
                (process.running || readers_pending != 0) && Instant::now() < deadline,
                "capture observer not ready: {capture:?}; running={}; pid={:?}; exit_code={:?}; readers_pending={readers_pending}; {}",
                process.running,
                process.pid,
                process.exit_code,
                fixture.startup_diagnostics()
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        fixture
    }
    fn startup_diagnostics(&self) -> String {
        // These records belong only to this private CPU fixture, before any API
        // request. Never inspect other services, configuration or environment.
        let logs = self.state.logs.lock().unwrap();
        let tail = logs
            .get(&self.profile.id)
            .into_iter()
            .flat_map(|logs| logs.iter().rev().take(20))
            .map(|entry| format!("{}: {}", entry.level, entry.message))
            .collect::<Vec<_>>()
            .join("\n")
            .chars()
            .take(8192)
            .collect::<String>();
        let analytics = self.state.data_dir().join("analytics");
        format!(
            "python={:?}; status_exists={}; journal_exists={}; private child output:\n{tail}",
            self.profile.python_path,
            analytics
                .join(format!("status-{}.json", self.profile.id))
                .is_file(),
            analytics.join("journal.sqlite3").is_file()
        )
    }
    async fn get(&self, path: &str) -> (u16, Value) {
        let response = self
            .state
            .client
            .get(format!("{}{path}", self.profile.base_url))
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap())
    }
    async fn inference(&self) -> Value {
        self.state.client.post(format!("{}/v1/chat/completions",self.profile.base_url)).json(&json!({"messages":[{"role":"user","content":"PRIVATE_CAPTURE_PROMPT"}],"max_tokens":64})).timeout(Duration::from_secs(10)).send().await.unwrap().json().await.unwrap()
    }
    fn unchanged(&self) {
        assert_eq!(fs::read(&self.profile.config_path).unwrap(), self.original);
    }
    async fn wait_disabled(&self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if status(&self.state, &self.profile.id).unwrap().state == "disabled" {
                break;
            }
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(self.get("/api/requests").await.0, 404);
    }
}

#[tokio::test]
async fn rpc_enable_read_disable_keeps_original_config_and_same_api_process() {
    let fixture = Fixture::new(false, false).await;
    assert_eq!(fixture.get("/api/requests").await.0, 404);
    let before = identity(&fixture.state, &fixture.profile.id).unwrap();
    let value = fixture
        .state
        .clone()
        .dispatch(
            "request_capture_set",
            json!({"profileId":fixture.profile.id,"minutes":5}),
        )
        .await
        .unwrap();
    assert_eq!(value["state"], "temporary");
    let reply = fixture.inference().await;
    assert!(reply["choices"][0]["message"]["content"]
        .as_str()
        .unwrap()
        .contains("CPU_CAPTURE_REPLY"));
    let (code, listing) = fixture.get("/api/requests").await;
    assert_eq!(code, 200);
    let id = listing["requests"][0]["id"].as_str().unwrap();
    let (code, detail) = fixture.get(&format!("/api/requests?id={id}")).await;
    assert_eq!(code, 200);
    assert!(detail["input"]
        .as_str()
        .unwrap()
        .contains("PRIVATE_CAPTURE_PROMPT"));
    assert!(detail["output"]
        .as_str()
        .unwrap()
        .contains("CPU_CAPTURE_REPLY"));
    assert_eq!(
        set(fixture.state.clone(), fixture.profile.id.clone(), 0)
            .await
            .unwrap()
            .state,
        "disabled"
    );
    assert_eq!(fixture.get("/api/requests").await.0, 404);
    assert_eq!(fixture.get("/health").await.0, 200);
    revalidate(&fixture.state, &before).unwrap();
    fixture.unchanged();
    let db = connection(&fixture.state).unwrap();
    let events: String = db
        .query_row("SELECT group_concat(payload) FROM events", [], |r| r.get(0))
        .unwrap();
    assert!(!events.contains("PRIVATE_CAPTURE_PROMPT"));
    assert!(!events.contains("CPU_CAPTURE_REPLY"));
}

#[tokio::test]
async fn manual_monitor_cannot_be_claimed_disabled_or_overwritten() {
    let fixture = Fixture::new(true, false).await;
    assert_eq!(
        status(&fixture.state, &fixture.profile.id).unwrap().state,
        "external"
    );
    for minutes in [0, 5, 15, 30] {
        assert!(
            set(fixture.state.clone(), fixture.profile.id.clone(), minutes)
                .await
                .unwrap_err()
                .contains("用户配置")
        );
    }
    fixture.inference().await;
    assert_eq!(fixture.get("/api/requests").await.0, 200);
    fixture.unchanged();
    let count: i64 = connection(&fixture.state)
        .unwrap()
        .query_row("SELECT COUNT(*) FROM request_capture_leases", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn pending_manual_config_is_not_claimed_and_app_lease_can_still_be_erased() {
    let fixture = Fixture::new(false, false).await;
    fs::write(
        &fixture.profile.config_path,
        serde_json::to_vec(&json!({"api_monitor":true})).unwrap(),
    )
    .unwrap();
    assert_eq!(
        status(&fixture.state, &fixture.profile.id).unwrap().state,
        "external"
    );
    assert!(set(fixture.state.clone(), fixture.profile.id.clone(), 5)
        .await
        .unwrap_err()
        .contains("用户配置"));
    fs::write(&fixture.profile.config_path, &fixture.original).unwrap();
    set(fixture.state.clone(), fixture.profile.id.clone(), 5)
        .await
        .unwrap();
    fs::write(
        &fixture.profile.config_path,
        serde_json::to_vec(&json!({"api_monitor":true})).unwrap(),
    )
    .unwrap();
    assert_eq!(
        status(&fixture.state, &fixture.profile.id).unwrap().state,
        "temporary"
    );
    assert_eq!(
        set(fixture.state.clone(), fixture.profile.id.clone(), 0)
            .await
            .unwrap()
            .state,
        "disabled"
    );
    assert_eq!(
        crate::storage::read(&fixture.profile).unwrap()["api_monitor"],
        true
    );
}

#[tokio::test]
async fn expiry_is_enforced_without_gui_and_supervisor_reopen_revokes_lease() {
    let fixture = Fixture::new(false, false).await;
    set(fixture.state.clone(), fixture.profile.id.clone(), 5)
        .await
        .unwrap();
    fixture.inference().await;
    let db = connection(&fixture.state).unwrap();
    let mut payload: Value = serde_json::from_str(
        &db.query_row::<String, _, _>(
            "SELECT payload FROM request_capture_leases WHERE service_id=?1",
            [&fixture.profile.id],
            |r| r.get(0),
        )
        .unwrap(),
    )
    .unwrap();
    payload["createdAtMs"] = json!(crate::now());
    payload["expiresAtMs"] = json!(crate::now() + 100);
    db.execute(
        "UPDATE request_capture_leases SET payload=?1 WHERE service_id=?2",
        rusqlite::params![payload.to_string(), fixture.profile.id],
    )
    .unwrap();
    fixture.wait_disabled().await;
    set(fixture.state.clone(), fixture.profile.id.clone(), 15)
        .await
        .unwrap();
    fixture.inference().await;
    let reopened = RuntimeState::open(fixture.state.data_dir().to_path_buf()).unwrap();
    assert_eq!(
        status(&reopened, &fixture.profile.id).unwrap().state,
        "unavailable"
    );
    let count: i64 = connection(&reopened)
        .unwrap()
        .query_row("SELECT COUNT(*) FROM request_capture_leases", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
    fixture.wait_disabled().await;
    fixture.unchanged();
}

#[tokio::test]
async fn busy_unknown_identity_source_and_unregistered_calls_fail_closed() {
    let fixture = Fixture::new(false, false).await;
    let db = connection(&fixture.state).unwrap();
    db.execute(
        "INSERT INTO active_requests VALUES(?1,?2,?3,?4)",
        rusqlite::params![
            "busy-fixture",
            fixture.profile.id,
            identity(&fixture.state, &fixture.profile.id)
                .unwrap()
                .observer["sessionId"]
                .as_str()
                .unwrap(),
            crate::now() as i64
        ],
    )
    .unwrap();
    assert!(set(fixture.state.clone(), fixture.profile.id.clone(), 5)
        .await
        .unwrap_err()
        .contains("进行中的请求"));
    db.execute(
        "DELETE FROM active_requests WHERE request_id='busy-fixture'",
        [],
    )
    .unwrap();
    assert!(set(fixture.state.clone(), "unknown-installation".into(), 5)
        .await
        .is_err());
    assert!(set(fixture.state.clone(), fixture.profile.id.clone(), 1440)
        .await
        .is_err());
    let path = fixture
        .state
        .data_dir()
        .join("analytics")
        .join(format!("status-{}.json", fixture.profile.id));
    let original = fs::read(&path).unwrap();
    let mut source: Value = serde_json::from_slice(&original).unwrap();
    source["sourceHash"] = json!("0".repeat(64));
    fs::write(&path, source.to_string()).unwrap();
    assert!(set(fixture.state.clone(), fixture.profile.id.clone(), 5)
        .await
        .unwrap_err()
        .contains("兼容性"));
    source = serde_json::from_slice(&original).unwrap();
    source["pid"] = json!(std::process::id());
    fs::write(&path, source.to_string()).unwrap();
    assert!(set(fixture.state.clone(), fixture.profile.id.clone(), 5)
        .await
        .is_err());
    fs::write(&path, original).unwrap();
    fixture.unchanged();
    let count: i64 = db
        .query_row("SELECT COUNT(*) FROM request_capture_leases", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
}
