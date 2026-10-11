//! Real upstream MockEngine HTTP, exact owned process handles and temporary DBs.
use super::*;
use crate::processes::OwnedProcess;
use std::{path::PathBuf, process::Command};

fn python() -> String {
    let mut command = Command::new(if cfg!(windows) { "py" } else { "python3" });
    command.args(["-I", "-S", "-c", "import sys;print(sys.executable)"]);
    crate::processes::hidden(&mut command);
    let output = command
        .output()
        .expect("CPU HTTP capture fixtures require Python");
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().into()
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
            if status(&fixture.state, &fixture.profile.id).unwrap().state != "unavailable" {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "capture observer not ready: {:?}",
                status(&fixture.state, &fixture.profile.id)
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        fixture
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
