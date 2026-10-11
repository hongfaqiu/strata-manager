//! CPU-only operation contracts: actual owned processes and loopback sockets.
//! The pause exposes the preparation/mutation boundary without mocking startup.
use super::*;
use std::sync::{mpsc, OnceLock};
use tokio_util::sync::CancellationToken;

struct Pause {
    entered: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
    finished: mpsc::Sender<()>,
}
fn pauses() -> &'static Mutex<HashMap<String, Arc<Pause>>> {
    static PAUSES: OnceLock<Mutex<HashMap<String, Arc<Pause>>>> = OnceLock::new();
    PAUSES.get_or_init(Mutex::default)
}
pub(super) struct Finish(Arc<Pause>);
impl Drop for Finish {
    fn drop(&mut self) {
        let _ = self.0.finished.send(());
    }
}
pub(super) fn pause_after_preparation(id: &str) -> Option<Finish> {
    let pause = pauses().lock().unwrap().remove(id)?;
    pause.entered.send(()).unwrap();
    pause
        .release
        .lock()
        .unwrap()
        .recv_timeout(Duration::from_secs(10))
        .expect("the test must release its own preparation barrier");
    Some(Finish(pause))
}
struct Control {
    entered: mpsc::Receiver<()>,
    release: mpsc::Sender<()>,
    finished: mpsc::Receiver<()>,
}
fn install_pause(id: &str) -> Control {
    let (entered_tx, entered) = mpsc::channel();
    let (release, release_rx) = mpsc::channel();
    let (finished_tx, finished) = mpsc::channel();
    pauses().lock().unwrap().insert(
        id.into(),
        Arc::new(Pause {
            entered: entered_tx,
            release: Mutex::new(release_rx),
            finished: finished_tx,
        }),
    );
    Control {
        entered,
        release,
        finished,
    }
}

fn python() -> String {
    let mut command = Command::new(if cfg!(windows) { "py" } else { "python3" });
    command.args(["-I", "-S", "-c", "import sys;print(sys.executable)"]);
    processes::hidden(&mut command);
    let result = command
        .output()
        .expect("the isolated fixture requires Python");
    assert!(result.status.success());
    String::from_utf8(result.stdout).unwrap().trim().into()
}
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
fn accepts(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(100),
    )
    .is_ok()
}
async fn wait_port(port: u16) {
    for _ in 0..100 {
        if accepts(port) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("isolated CPU listener did not start");
}

struct Fixture {
    state: Arc<RuntimeState>,
    profile: ServiceProfile,
    job: tuning::TuningJob,
    original: Vec<u8>,
    port: u16,
    _directory: tempfile::TempDir,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let mut processes = self.state.processes.lock().unwrap();
        for process in processes.values_mut() {
            let _ = process.stop();
        }
        processes.clear();
    }
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let runtime = directory.path().join("runtime");
        fs::create_dir_all(runtime.join("serve")).unwrap();
        fs::write(runtime.join("setup.py"), "# isolated CPU fixture").unwrap();
        fs::write(
            runtime.join("serve/server.py"),
            include_str!("../tests/fixtures/tuning_service.py"),
        )
        .unwrap();
        let model = runtime.join("fixture.gguf");
        fs::write(
            &model,
            b"isolated metadata fixture; never loaded by a model engine",
        )
        .unwrap();
        let state = RuntimeState::open(directory.path().join("data")).unwrap();
        let port = free_port();
        let python = python();
        let profile = ServiceProfile {
            id: format!("native-operation-{}", uuid::Uuid::new_v4()),
            name: "isolated CPU service".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            install_dir: runtime.to_string_lossy().into(),
            python_path: python.clone(),
            config_path: state
                .data_dir
                .join("strata-fixture.json")
                .to_string_lossy()
                .into(),
            managed: true,
        };
        let original = serde_json::to_vec_pretty(&json!({"exe":python,"args":["--native",model,"--pcie-frac","0.5","--spec-min-p","0.5"],"cwd":runtime,"tokenizer":runtime,"model_name":"tuning-fixture","port":port,"host":"127.0.0.1"})).unwrap();
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
                    now() as i64
                ],
            )
            .unwrap();
        store_set(&state, "activeLocalInstallation".into(), json!(profile.id)).unwrap();
        let job: tuning::TuningJob = serde_json::from_value(json!({
            "id":uuid::Uuid::new_v4().to_string(),"profileId":profile.id,"state":"running",
            "scenes":["chat"],"rounds":2,"maxTokens":1024,"startedAt":now(),"updatedAt":now(),
            "completedRequests":0,"totalRequests":1,"currentStep":"isolatedNativeOperation",
            "baseline":{"pcieFrac":0.5,"specMinP":0.5},"candidates":[],"measurements":[],
            "identity":{},"configFingerprint":tuning::fingerprint(&original),"notes":[]
        }))
        .unwrap();
        tuning::register_service_operation_fixture(&state, &job).unwrap();
        Self {
            state,
            profile,
            job,
            original,
            port,
            _directory: directory,
        }
    }
    fn assert_config(&self) {
        assert_eq!(fs::read(&self.profile.config_path).unwrap(), self.original);
    }
    async fn unrelated_listener(&self, as_model: bool) -> (String, u16, u32) {
        const LISTENER: &str = "import socket,sys\ns=socket.socket();s.bind(('127.0.0.1',int(sys.argv[1])));s.listen()\nwhile True:\n c,_=s.accept();c.close()\n";
        let port = free_port();
        let id = format!("unrelated-{}", uuid::Uuid::new_v4());
        let mut command = Command::new(&self.profile.python_path);
        command.args(["-I", "-S", "-c", LISTENER, &port.to_string()]);
        let mut process = OwnedProcess::spawn(command, self.state.logs.clone(), &id).unwrap();
        if as_model {
            let mut other = self.profile.clone();
            other.id = id.clone();
            process.profile = Some(other);
        }
        let pid = process.status.pid.unwrap();
        self.state
            .processes
            .lock()
            .unwrap()
            .insert(id.clone(), process);
        wait_port(port).await;
        (id, port, pid)
    }
    fn assert_unrelated(&self, id: &str, port: u16, pid: u32) {
        assert!(accepts(port));
        let status = self
            .state
            .processes
            .lock()
            .unwrap()
            .get_mut(id)
            .unwrap()
            .refresh()
            .unwrap();
        assert!(status.running);
        assert_eq!(status.pid, Some(pid));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn busy_global_operation_never_queues_a_late_launch_or_touches_other_child() {
    let fixture = Fixture::new();
    let (other, port, pid) = fixture.unrelated_listener(false).await;
    let (held_tx, held_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let state = fixture.state.clone();
    let holder = std::thread::spawn(move || {
        let _held = state.runtime_operations.lock().unwrap();
        held_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    });
    held_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let cancel = CancellationToken::new();
    let result = tokio::time::timeout(
        Duration::from_millis(100),
        start_service_for_tuning(
            fixture.state.clone(),
            fixture.profile.clone(),
            &fixture.job.id,
            &cancel,
        ),
    )
    .await
    .expect("a contended operation must fail without blocking");
    assert!(result.err().unwrap().contains("未排队"));
    tokio::time::sleep(Duration::from_millis(150)).await;
    release_tx.send(()).unwrap();
    holder.join().unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!accepts(fixture.port));
    assert!(!fixture
        .state
        .processes
        .lock()
        .unwrap()
        .contains_key(&fixture.profile.id));
    assert!(!cancel.is_cancelled());
    fixture.assert_config();
    fixture.assert_unrelated(&other, port, pid);
}

async fn expire_at_boundary(fixture: &Fixture, restart: bool) {
    let control = install_pause(&fixture.job.id);
    let state = fixture.state.clone();
    let profile = fixture.profile.clone();
    let job_id = fixture.job.id.clone();
    let parent = CancellationToken::new();
    let parent_for_task = parent.clone();
    let (arm_tx, arm_rx) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let mut operation = Box::pin(tuning_service_operation(
            state,
            profile,
            &job_id,
            &parent_for_task,
            restart,
        ));
        tokio::select! {
            result=&mut operation => panic!("the held mutation barrier returned early: {}",result.is_ok()),
            _=arm_rx => { assert!(tokio::time::timeout(Duration::from_millis(25),&mut operation).await.is_err()); }
        }
    });
    tokio::task::spawn_blocking(move || {
        control
            .entered
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
    })
    .await
    .unwrap();
    arm_tx.send(()).unwrap();
    task.await.unwrap(); // The real async operation has now been dropped by timeout.
    assert!(!parent.is_cancelled());
    control.release.send(()).unwrap();
    tokio::task::spawn_blocking(move || {
        control
            .finished
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn timeout_after_preparation_prevents_late_spawn_and_preserves_other_child() {
    let fixture = Fixture::new();
    let (other, port, pid) = fixture.unrelated_listener(false).await;
    expire_at_boundary(&fixture, false).await;
    assert!(!accepts(fixture.port));
    assert!(!fixture
        .state
        .processes
        .lock()
        .unwrap()
        .contains_key(&fixture.profile.id));
    fixture.assert_config();
    fixture.assert_unrelated(&other, port, pid);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn timeout_before_restart_neither_stops_original_nor_starts_replacement() {
    let fixture = Fixture::new();
    let original = start_service(fixture.state.clone(), fixture.profile.clone())
        .await
        .unwrap();
    wait_port(fixture.port).await;
    let (other, port, pid) = fixture.unrelated_listener(false).await;
    expire_at_boundary(&fixture, true).await;
    let current = fixture
        .state
        .processes
        .lock()
        .unwrap()
        .get_mut(&fixture.profile.id)
        .unwrap()
        .refresh()
        .unwrap();
    assert!(current.running && accepts(fixture.port));
    assert_eq!(current.pid, original.pid);
    fixture.assert_config();
    fixture.assert_unrelated(&other, port, pid);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn selected_profile_registry_and_single_model_are_rechecked_before_mutation() {
    let fixture = Fixture::new();
    let cancel = CancellationToken::new();
    store_set(
        &fixture.state,
        "activeLocalInstallation".into(),
        json!("another-selection"),
    )
    .unwrap();
    let error = start_service_for_tuning(
        fixture.state.clone(),
        fixture.profile.clone(),
        &fixture.job.id,
        &cancel,
    )
    .await
    .err()
    .unwrap();
    assert!(error.contains("选择"));
    store_set(
        &fixture.state,
        "activeLocalInstallation".into(),
        json!(fixture.profile.id),
    )
    .unwrap();
    let mut changed = fixture.profile.clone();
    changed.name = "different registration".into();
    assert!(
        start_service_for_tuning(fixture.state.clone(), changed, &fixture.job.id, &cancel)
            .await
            .err()
            .unwrap()
            .contains("身份")
    );
    assert!(start_service_for_tuning(
        fixture.state.clone(),
        fixture.profile.clone(),
        &uuid::Uuid::new_v4().to_string(),
        &cancel
    )
    .await
    .is_err());
    let (other, port, pid) = fixture.unrelated_listener(true).await;
    assert!(start_service_for_tuning(
        fixture.state.clone(),
        fixture.profile.clone(),
        &fixture.job.id,
        &cancel
    )
    .await
    .err()
    .unwrap()
    .contains("另一"));
    assert!(!accepts(fixture.port));
    fixture.assert_config();
    fixture.assert_unrelated(&other, port, pid);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn admitted_start_and_dead_owned_restart_use_only_the_selected_tree() {
    let fixture = Fixture::new();
    let (other, port, pid) = fixture.unrelated_listener(false).await;
    let cancel = CancellationToken::new();
    let first = start_service_for_tuning(
        fixture.state.clone(),
        fixture.profile.clone(),
        &fixture.job.id,
        &cancel,
    )
    .await
    .unwrap();
    wait_port(fixture.port).await;
    fixture
        .state
        .processes
        .lock()
        .unwrap()
        .get_mut(&fixture.profile.id)
        .unwrap()
        .stop()
        .unwrap();
    let second = restart_service_for_tuning(
        fixture.state.clone(),
        fixture.profile.clone(),
        &fixture.job.id,
        &cancel,
    )
    .await
    .unwrap();
    wait_port(fixture.port).await;
    assert_ne!(first.pid, second.pid);
    assert!(!cancel.is_cancelled());
    fixture.assert_config();
    fixture.assert_unrelated(&other, port, pid);
}
