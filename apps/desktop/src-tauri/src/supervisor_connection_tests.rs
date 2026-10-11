use super::*;
use std::{fs, sync::atomic::AtomicBool};
use tokio_util::sync::CancellationToken;

struct Fixture {
    _directory: tempfile::TempDir,
    client: SupervisorClient,
    calls: Arc<Mutex<Vec<String>>>,
    running: Arc<AtomicBool>,
    stop: CancellationToken,
    server: tokio::task::JoinHandle<Result<(), RpcError>>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.cancel();
        self.server.abort();
    }
}

impl Fixture {
    async fn new(outside: bool, changed_hash: bool, missing_identity: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("data");
        let packages = data.join("supervisor");
        fs::create_dir_all(&packages).unwrap();
        fs::write(data.join("strata-manager.sqlite3"), b"").unwrap();
        let old = if outside {
            directory.path().join("external-package")
        } else {
            packages.join("previous")
        };
        fs::create_dir_all(&old).unwrap();
        let executable = old.join("strata-supervisor.exe");
        // These bytes are never executed. Only the isolated IPC handler runs.
        let bytes = b"disposable connection fixture";
        fs::write(&executable, bytes).unwrap();
        let hash = format!("{:x}", Sha256::digest(bytes));
        let mut status = json!({
            "running":true,"pid":123,"protocolVersion":1,
            "version":"fixture-old","activeServices":0,
            "executablePath":executable,
            "executableHash":if changed_hash { "changed" } else { &hash },
        });
        if missing_identity {
            status.as_object_mut().unwrap().remove("executablePath");
        }
        let client = SupervisorClient::new(data.clone(), directory.path().into());
        client
            .staged
            .set((
                directory.path().join("must-never-execute.exe"),
                "fixture-new".into(),
            ))
            .unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let recorded = calls.clone();
        let running = Arc::new(AtomicBool::new(false));
        let observed = running.clone();
        let stop = CancellationToken::new();
        let server_stop = stop.clone();
        let server = tokio::spawn(async move {
            strata_local_ipc::serve(&data, server_stop, move |request| {
                let recorded = recorded.clone();
                let running = observed.clone();
                let status = status.clone();
                async move {
                    recorded.lock().unwrap().push(request.method.clone());
                    match request.method.as_str() {
                        "hello" | "supervisor_status" => Ok(status),
                        "service_status" => Ok(json!({
                            "running":running.load(Ordering::SeqCst),"owned":true,
                        })),
                        "stop_service" => {
                            running.store(false, Ordering::SeqCst);
                            Ok(json!({"running":false,"owned":true}))
                        }
                        _ => Err(RpcError::new("unexpected_fixture_mutation", request.method)),
                    }
                }
            })
            .await
        });
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while client.connected().await.is_err() {
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Self {
            _directory: directory,
            client,
            calls,
            running,
            stop,
            server,
        }
    }
}

#[tokio::test]
async fn blocked_upgrade_preserves_queries_and_explicit_stop_without_replacing_background() {
    for (outside, changed_hash, missing_identity, reason) in [
        (true, false, false, "不在本应用的版本目录"),
        (false, true, false, "文件身份变化"),
        (false, false, true, "缺少版本身份"),
    ] {
        let fixture = Fixture::new(outside, changed_hash, missing_identity).await;
        let status = fixture
            .client
            .request("supervisor_status", json!({}))
            .await
            .unwrap();
        assert_eq!(status["pid"], 123);
        assert_eq!(status["updatePending"], true);
        assert!(status["updateReason"].as_str().unwrap().contains(reason));

        // An already stopped selection stays stopped after repeated refreshes.
        for _ in 0..3 {
            assert_eq!(
                fixture
                    .client
                    .request("service_status", json!({"profileId":"fixture"}))
                    .await
                    .unwrap()["running"],
                false
            );
        }
        // Explicit stop remains available even when package staging would fail.
        fixture.running.store(true, Ordering::SeqCst);
        assert_eq!(
            fixture
                .client
                .request("stop_service", json!({"profileId":"fixture"}))
                .await
                .unwrap()["running"],
            false
        );
        assert_eq!(
            fixture
                .client
                .request("service_status", json!({"profileId":"fixture"}))
                .await
                .unwrap()["running"],
            false
        );
        assert!(fixture.calls.lock().unwrap().iter().all(|method| matches!(
            method.as_str(),
            "hello" | "supervisor_status" | "service_status" | "stop_service"
        )));
    }
}

#[tokio::test]
async fn explicit_stop_does_not_require_packaged_executable() {
    let mut fixture = Fixture::new(true, false, false).await;
    fixture.client.staged = OnceLock::new();
    fixture.running.store(true, Ordering::SeqCst);
    assert_eq!(
        fixture
            .client
            .request("stop_service", json!({"profileId":"fixture"}))
            .await
            .unwrap()["running"],
        false
    );
    assert!(fixture.client.staged.get().is_none());
}

#[tokio::test]
async fn stopping_without_a_background_never_stages_or_starts_one() {
    let directory = tempfile::tempdir().unwrap();
    let client = SupervisorClient::new(directory.path().into(), directory.path().into());
    for method in ["stop_service", "shutdown_supervisor"] {
        assert_eq!(
            client
                .request(method, json!({"profileId":"fixture"}))
                .await
                .unwrap_err()
                .code,
            "supervisor_unavailable"
        );
        assert!(client.staged.get().is_none());
        assert!(!directory.path().join("supervisor").exists());
    }
}

#[test]
fn directory_boundary_rejects_external_and_prefixed_sibling_packages() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("supervisor");
    let sibling = directory.path().join("supervisor-external");
    fs::create_dir_all(root.join("previous")).unwrap();
    fs::create_dir_all(&sibling).unwrap();
    let owned = root.join("previous/background.exe");
    let outside = sibling.join("background.exe");
    fs::write(&owned, b"fixture").unwrap();
    fs::write(&outside, b"fixture").unwrap();
    let root = dunce::canonicalize(root).unwrap();
    assert!(supervisor_directory_contains(&dunce::canonicalize(owned).unwrap(), &root).unwrap());
    assert!(!supervisor_directory_contains(&dunce::canonicalize(outside).unwrap(), &root).unwrap());
}

#[cfg(windows)]
#[test]
fn windows_directory_identity_accepts_case_variants_without_loosening_the_boundary() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("SupervisorCaseFixture");
    let package = root.join("Previous/background.exe");
    fs::create_dir_all(package.parent().unwrap()).unwrap();
    fs::write(&package, b"fixture").unwrap();
    let executable = dunce::canonicalize(package).unwrap();
    let root = dunce::canonicalize(root).unwrap();
    let variant = PathBuf::from(root.to_str().unwrap().to_ascii_lowercase());
    assert!(!executable.starts_with(&variant));
    assert!(supervisor_directory_contains(&executable, &variant).unwrap());
}
