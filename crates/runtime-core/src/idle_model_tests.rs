//! Actual CPU-only HTTP admission, process handles and first-use reloading.
use super::*;
use crate::{processes::TaskRecord, types::TaskStatus};
use std::process::Command;

const SCRIPT: &str = r#"
import argparse,json,os,threading,time,uuid
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from strata_observer import Journal
p=argparse.ArgumentParser();p.add_argument('--config');p.add_argument('--port',type=int);p.add_argument('--host');args,_=p.parse_known_args()
root=Path(json.loads(Path(args.config).read_text())['cwd'])
journal=Journal(Path(os.environ['STRATA_MANAGER_ANALYTICS_DIR']),os.environ['STRATA_MANAGER_SERVICE_ID'])
journal.status(True,'isolated-idle-contract')
loaded=False;active=0;loads=0;unloads=0;lock=threading.Lock()
def heartbeat():
 while True:
  if not (root/'freeze-observer').exists():journal.status(True,'isolated-idle-contract')
  time.sleep(.05)
threading.Thread(target=heartbeat,daemon=True).start()
class Handler(BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*_):pass
 def respond(self,value,status=200):
  body=json.dumps(value).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def do_GET(self):
  with lock:state={'loaded':loaded,'active':active,'loads':loads,'unloads':unloads,'pid':os.getpid()}
  if self.path=='/health':self.respond({'status':'ok','service':'strata','loaded':state['loaded']})
  elif self.path=='/v1/status':self.respond({'service':'strata','activity':{'in_flight':state['active']}})
  elif self.path=='/metrics':self.respond({'live':{'state':'loading' if (root/'show-loading').exists() else 'generating' if state['active'] else 'idle','queued':0,'running':state['active'],'waiting':0,'outside_slots':0}})
  elif self.path=='/fixture-state':self.respond(state)
  else:self.respond({},404)
 def do_POST(self):
  global loaded,active,loads,unloads,journal
  if self.path=='/fixture-new-session':
   self.rfile.read(int(self.headers.get('Content-Length','0')))
   previous=journal;journal=Journal(previous.directory,previous.service_id);journal.status(True,'isolated-idle-contract');previous.close()
   self.respond({'sessionId':journal.session_id});return
  request_id=uuid.uuid4().hex;inference=self.path=='/v1/chat/completions';started=int(time.time()*1000)
  metadata={'requestId':request_id,'sessionId':journal.session_id,'serviceId':journal.service_id,'startedAtMs':started,'route':'chat'}
  if inference:journal.append('request_start',metadata)
  admission=journal.admit(request_id,self.headers.get('X-Strata-Manager-Maintenance-Token'),activity=inference or self.path in {'/load','/unload','/settings'})
  try:
   self.rfile.read(int(self.headers.get('Content-Length','0')))
   if admission is False:self.respond({'error':{'code':'strata_manager_maintenance'}},503);return
   if self.path=='/load':
    with lock:loaded=True;loads+=1
    self.respond({'status':'loaded'});return
   if self.path=='/unload':
    with lock:loaded=False;unloads+=1
    (root/'unload-received').write_text(request_id)
    deadline=time.monotonic()+5
    while (root/'hold-unload').exists() and time.monotonic()<deadline:time.sleep(.01)
    self.respond({'status':'unloaded'});return
   if self.path=='/settings':self.respond({'status':'configured'});return
   if not inference:self.respond({},404);return
   with lock:
    if not loaded:loaded=True;loads+=1
    active+=1
   try:
    (root/'request-active').write_text(request_id)
    deadline=time.monotonic()+5
    while (root/'hold-request').exists() and time.monotonic()<deadline:time.sleep(.01)
    self.respond({'choices':[{'message':{'role':'assistant','content':'CPU fixture only'}}]})
   finally:
    with lock:active-=1
  finally:
   if inference:journal.append('request_end',dict(metadata,endedAtMs=int(time.time()*1000),outcome='succeeded'))
   if admission:journal.release(request_id)
ThreadingHTTPServer((args.host,args.port),Handler).serve_forever()
"#;

fn python() -> String {
    let mut command = Command::new(if cfg!(windows) { "py" } else { "python3" });
    command.args(["-I", "-S", "-c", "import sys;print(sys.executable)"]);
    crate::processes::hidden(&mut command);
    let output = command.output().expect("CPU HTTP fixture requires Python");
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().into()
}
struct Fixture {
    state: Arc<RuntimeState>,
    profile: ServiceProfile,
    root: std::path::PathBuf,
    original: Vec<u8>,
    _directory: tempfile::TempDir,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.state.cleanup();
    }
}
impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("runtime");
        fs::create_dir_all(root.join("serve")).unwrap();
        fs::write(root.join("setup.py"), "# CPU fixture only").unwrap();
        fs::write(root.join("serve/server.py"), SCRIPT).unwrap();
        let state = RuntimeState::open(directory.path().join("private-data")).unwrap();
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let python = python();
        let profile = ServiceProfile {
            id: format!("idle-{}", uuid::Uuid::new_v4()),
            name: "isolated idle CPU fixture".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            install_dir: root.to_string_lossy().into(),
            python_path: python.clone(),
            config_path: root.join("fixture.json").to_string_lossy().into(),
            managed: true,
        };
        let original = serde_json::to_vec_pretty(
            &json!({"exe":python,"args":[],"cwd":root,"port":port,"host":"127.0.0.1"}),
        )
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
        crate::store_set(&state, "activeLocalInstallation".into(), json!(profile.id)).unwrap();
        crate::store_set(&state, "localServiceDesired".into(), json!(true)).unwrap();
        state
            .clone()
            .ensure_runtime(profile.id.clone(), true)
            .await
            .unwrap();
        let fixture = Self {
            state,
            profile,
            root,
            original,
            _directory: directory,
        };
        fixture.health().await;
        fixture
    }
    async fn health(&self) {
        let result = crate::health_watch::check(&self.state, &self.profile.id, None)
            .await
            .unwrap();
        self.state
            .health_snapshots
            .lock()
            .unwrap()
            .insert(self.profile.id.clone(), result.snapshot);
    }
    async fn tick(&self) -> IdleOutcome {
        tick_with_window(
            self.state.clone(),
            &self.profile.id,
            &CancellationToken::new(),
            40,
        )
        .await
        .unwrap()
    }
    async fn expire(&self) {
        tokio::time::sleep(Duration::from_millis(70)).await;
    }
    async fn state(&self) -> Value {
        self.state
            .client
            .get(format!("{}/fixture-state", self.profile.base_url))
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }
    fn gate(&self) -> std::path::PathBuf {
        self.state
            .data_dir()
            .join("analytics")
            .join(format!("{}.maintenance", self.profile.id))
    }
    fn preserved(&self) {
        assert_eq!(fs::read(&self.profile.config_path).unwrap(), self.original);
        assert!(!self.gate().exists());
    }
    async fn wait(&self, name: &str) {
        for _ in 0..300 {
            if self.root.join(name).exists() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("CPU boundary {name} did not arrive");
    }
    fn chat(&self) -> tokio::task::JoinHandle<reqwest::Response> {
        let client = self.state.client.clone();
        let url = format!("{}/v1/chat/completions", self.profile.base_url);
        tokio::spawn(async move {
            client
                .post(url)
                .json(&json!({"messages":[]}))
                .timeout(Duration::from_secs(8))
                .send()
                .await
                .unwrap()
        })
    }
    fn policy(&self, mode: &str, minutes: u16) {
        policy::set(
            &self.state,
            policy::BackgroundPolicy {
                mode: mode.into(),
                idle_unload_minutes: minutes,
                ..policy::BackgroundPolicy::default()
            },
        )
        .unwrap();
    }
    fn reject_update_before_download(&mut self) {
        // The real update entrance still registers and persists its task, but
        // execution must fail its local BUILD.json preflight before any network,
        // candidate preparation or model startup. Only this private fixture's
        // baseline config is changed; the existing HTTP process keeps running.
        let mut config: Value = serde_json::from_slice(&self.original).unwrap();
        config["exe"] = json!(self
            .root
            .join("absent-idle-update-engine")
            .join("strata.exe"));
        self.original = serde_json::to_vec_pretty(&config).unwrap();
        fs::write(&self.profile.config_path, &self.original).unwrap();
    }
}
async fn pause(state: &RuntimeState, id: &str, phase: &str) {
    let root = std::path::PathBuf::from(state.registered_profile(id).unwrap().install_dir);
    if !root.join(format!("pause-{phase}")).exists() {
        return;
    }
    fs::write(root.join(format!("reached-{phase}")), b"CPU boundary").unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !root.join(format!("release-{phase}")).exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "CPU boundary must be released"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
pub(super) async fn before_gate(state: &RuntimeState, id: &str) {
    pause(state, id, "before-gate").await;
}
pub(super) async fn before_operation(state: &RuntimeState, id: &str) {
    pause(state, id, "before-operation").await;
}
pub(super) async fn after_gate(state: &RuntimeState, id: &str) {
    pause(state, id, "after-gate").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn idle_release_keeps_same_api_process_and_first_use_reloads() {
    let f = Fixture::new().await;
    let before = f.state().await;
    assert_eq!(f.tick().await, IdleOutcome::Observing);
    f.expire().await;
    assert_eq!(f.tick().await, IdleOutcome::Unloaded);
    let unloaded = f.state().await;
    assert_eq!(unloaded["pid"], before["pid"]);
    assert_eq!(unloaded["loaded"], false);
    assert_eq!(unloaded["unloads"], 1);
    f.preserved();
    let response = f.chat().await.unwrap();
    assert!(response.status().is_success());
    assert_eq!(f.state().await["loaded"], true);
    f.health().await;
    assert_eq!(f.tick().await, IdleOutcome::Observing);
    f.expire().await;
    assert_eq!(f.tick().await, IdleOutcome::Unloaded);
    f.state
        .clone()
        .ensure_runtime(f.profile.id.clone(), true)
        .await
        .unwrap();
    let reloaded = f.state().await;
    assert_eq!(reloaded["loaded"], true);
    assert_eq!(reloaded["pid"], before["pid"]);
    f.preserved();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn active_request_never_unloads_and_completion_restarts_idle_period() {
    let f = Fixture::new().await;
    assert_eq!(f.tick().await, IdleOutcome::Observing);
    f.expire().await;
    fs::write(f.root.join("hold-request"), b"hold").unwrap();
    let request = f.chat();
    f.wait("request-active").await;
    f.health().await;
    assert_eq!(f.tick().await, IdleOutcome::Deferred);
    assert_eq!(f.state().await["unloads"], 0);
    fs::remove_file(f.root.join("hold-request")).unwrap();
    assert!(request.await.unwrap().status().is_success());
    f.health().await;
    assert_eq!(f.tick().await, IdleOutcome::Observing);
    f.preserved();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn request_admitted_between_check_and_gate_drains_then_defers_unload() {
    let f = Fixture::new().await;
    assert_eq!(f.tick().await, IdleOutcome::Observing);
    f.expire().await;
    fs::write(f.root.join("pause-before-gate"), b"pause").unwrap();
    fs::write(f.root.join("hold-request"), b"hold").unwrap();
    let state = f.state.clone();
    let id = f.profile.id.clone();
    let work = tokio::spawn(async move {
        tick_with_window(state, &id, &CancellationToken::new(), 40)
            .await
            .unwrap()
    });
    f.wait("reached-before-gate").await;
    let request = f.chat();
    f.wait("request-active").await;
    fs::write(f.root.join("release-before-gate"), b"release").unwrap();
    for _ in 0..100 {
        if f.gate().exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(f.gate().exists());
    assert_eq!(f.state().await["unloads"], 0);
    fs::remove_file(f.root.join("hold-request")).unwrap();
    assert!(request.await.unwrap().status().is_success());
    assert_eq!(work.await.unwrap(), IdleOutcome::Observing);
    assert_eq!(f.state().await["unloads"], 0);
    f.preserved();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn request_after_gate_is_rejected_and_recent_attempt_defers_unload() {
    let f = Fixture::new().await;
    assert_eq!(f.tick().await, IdleOutcome::Observing);
    f.expire().await;
    fs::write(f.root.join("pause-after-gate"), b"pause").unwrap();
    let state = f.state.clone();
    let id = f.profile.id.clone();
    let work = tokio::spawn(async move {
        tick_with_window(state, &id, &CancellationToken::new(), 40)
            .await
            .unwrap()
    });
    f.wait("reached-after-gate").await;
    assert_eq!(f.chat().await.unwrap().status().as_u16(), 503);
    fs::write(f.root.join("release-after-gate"), b"release").unwrap();
    assert_eq!(work.await.unwrap(), IdleOutcome::Observing);
    assert_eq!(f.state().await["unloads"], 0);
    f.preserved();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn completed_model_control_after_check_resets_idle_without_inference_events() {
    for path in ["/load", "/settings"] {
        let f = Fixture::new().await;
        assert_eq!(f.tick().await, IdleOutcome::Observing);
        f.expire().await;
        fs::write(f.root.join("pause-before-gate"), b"pause").unwrap();
        let state = f.state.clone();
        let id = f.profile.id.clone();
        let work = tokio::spawn(async move {
            tick_with_window(state, &id, &CancellationToken::new(), 40)
                .await
                .unwrap()
        });
        f.wait("reached-before-gate").await;
        let response = f
            .state
            .client
            .post(format!("{}{path}", f.profile.base_url))
            .json(&json!({}))
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        let db = Connection::open(f.state.data_dir().join("analytics/journal.sqlite3")).unwrap();
        for _ in 0..100 {
            let active: i64 = db
                .query_row(
                    "SELECT COUNT(*) FROM active_requests WHERE service_id=?1",
                    [&f.profile.id],
                    |row| row.get(0),
                )
                .unwrap();
            if active == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let active: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM active_requests WHERE service_id=?1",
                [&f.profile.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active, 0, "control must finish before drain starts");
        let inference_events: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM events WHERE kind IN ('request_start','request_end')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(inference_events, 0);
        fs::write(f.root.join("release-before-gate"), b"release").unwrap();
        assert_eq!(work.await.unwrap(), IdleOutcome::Observing);
        assert_eq!(f.state().await["unloads"], 0);
        f.preserved();
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn new_observer_session_restarts_idle_while_get_polling_does_not() {
    let f = Fixture::new().await;
    let before = f.state().await;
    assert_eq!(f.tick().await, IdleOutcome::Observing);
    f.expire().await;
    let response = f
        .state
        .client
        .post(format!("{}/fixture-new-session", f.profile.base_url))
        .json(&json!({}))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    f.health().await;
    assert_eq!(f.tick().await, IdleOutcome::Observing);
    assert_eq!(f.state().await["unloads"], 0);
    f.expire().await;
    f.health().await;
    assert_eq!(f.tick().await, IdleOutcome::Unloaded);
    assert_eq!(f.state().await["pid"], before["pid"]);
    f.preserved();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unknown_stale_foreign_pid_and_missing_journal_never_unload() {
    let f = Fixture::new().await;
    assert_eq!(f.tick().await, IdleOutcome::Observing);
    f.expire().await;
    fs::write(f.root.join("freeze-observer"), b"freeze").unwrap();
    tokio::time::sleep(Duration::from_millis(80)).await;
    let path = f
        .state
        .data_dir()
        .join("analytics")
        .join(format!("status-{}.json", f.profile.id));
    let original = fs::read(&path).unwrap();
    let status: Value = serde_json::from_slice(&original).unwrap();
    for (field, value) in [
        ("supported", json!(false)),
        ("updatedAtMs", json!(0)),
        ("pid", json!(std::process::id())),
        ("journalWriteFailed", json!(true)),
    ] {
        let mut changed = status.clone();
        changed[field] = value;
        fs::write(&path, serde_json::to_vec(&changed).unwrap()).unwrap();
        assert_eq!(f.tick().await, IdleOutcome::Deferred);
        assert_eq!(f.state().await["unloads"], 0);
    }
    fs::write(path, original).unwrap();
    let db = Connection::open(f.state.data_dir().join("analytics/journal.sqlite3")).unwrap();
    db.execute_batch("ALTER TABLE active_requests RENAME TO unavailable_activity;")
        .unwrap();
    assert_eq!(f.tick().await, IdleOutcome::Deferred);
    assert_eq!(f.state().await["unloads"], 0);
    db.execute_batch("ALTER TABLE unavailable_activity RENAME TO active_requests;")
        .unwrap();
    f.preserved();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn policy_disabled_always_ready_and_observation_gap_preserve_loaded_api() {
    let f = Fixture::new().await;
    assert_eq!(f.tick().await, IdleOutcome::Observing);
    f.expire().await;
    f.policy("alwaysReady", 15);
    assert_eq!(f.tick().await, IdleOutcome::Disabled);
    f.policy("lazy", 0);
    assert_eq!(f.tick().await, IdleOutcome::Disabled);
    f.policy("lazy", 15);
    assert_eq!(f.tick().await, IdleOutcome::Observing);
    let mut previous = latest(&f.state, &f.profile.id).unwrap().unwrap();
    previous.checked_at = crate::now() - OBSERVATION_GAP_MS - 1;
    previous.idle_since = previous.checked_at;
    save(&f.state, &f.profile.id, &previous).unwrap();
    assert_eq!(f.tick().await, IdleOutcome::Observing);
    assert_eq!(f.state().await["unloads"], 0);
    assert_eq!(f.state().await["loaded"], true);
    f.preserved();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn production_threshold_uses_locked_policy_after_a_sixty_one_sixty_aba() {
    let f = Fixture::new().await;
    f.policy("lazy", 60);
    assert_eq!(f.tick().await, IdleOutcome::Observing);
    let mut prior_sixty_minute_history = latest(&f.state, &f.profile.id).unwrap().unwrap();
    f.policy("lazy", 1);
    assert!(latest(&f.state, &f.profile.id).unwrap().is_none());
    fs::write(f.root.join("pause-before-operation"), b"pause").unwrap();
    let state = f.state.clone();
    let id = f.profile.id.clone();
    let work =
        tokio::spawn(async move { tick(state, &id, &CancellationToken::new()).await.unwrap() });
    f.wait("reached-before-operation").await;
    f.policy("lazy", 60);
    assert!(latest(&f.state, &f.profile.id).unwrap().is_none());
    // Seed valid metadata for two idle minutes without waiting two minutes.
    // This also detects a stale captured one-minute threshold independently
    // of the atomic policy-history invalidation checked above.
    prior_sixty_minute_history.checked_at = crate::now();
    prior_sixty_minute_history.idle_since = crate::now() - 120_000;
    save(&f.state, &f.profile.id, &prior_sixty_minute_history).unwrap();
    fs::write(f.root.join("release-before-operation"), b"release").unwrap();
    assert_eq!(work.await.unwrap(), IdleOutcome::Observing);
    assert_eq!(f.state().await["unloads"], 0);
    assert_eq!(f.state().await["loaded"], true);
    f.preserved();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancellation_after_server_commits_unload_keeps_api_and_does_not_claim_rollback() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let before = f.state().await;
    let other_before = other.state().await;
    assert_eq!(f.tick().await, IdleOutcome::Observing);
    f.expire().await;
    fs::write(f.root.join("hold-unload"), b"hold response after commit").unwrap();
    let own_cancel = CancellationToken::new();
    let task_cancel = own_cancel.clone();
    let state = f.state.clone();
    let id = f.profile.id.clone();
    let work = tokio::spawn(async move {
        tick_with_window(state, &id, &task_cancel, 40)
            .await
            .unwrap()
    });
    f.wait("unload-received").await;
    own_cancel.cancel();
    assert_eq!(work.await.unwrap(), IdleOutcome::Deferred);
    let committed = f.state().await;
    assert_eq!(
        committed["loaded"], false,
        "an accepted unload cannot be reversed by client cancellation"
    );
    assert_eq!(committed["unloads"], 1);
    assert_eq!(committed["pid"], before["pid"]);
    assert_eq!(other.state().await, other_before);
    f.preserved();
    fs::remove_file(f.root.join("hold-unload")).unwrap();
    assert!(f.chat().await.unwrap().status().is_success());
    assert_eq!(f.state().await["loaded"], true);
    f.preserved();
    other.preserved();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn preparation_loading_upgrade_tuning_and_foreign_gate_block_release() {
    let f = Fixture::new().await;
    let task_id = uuid::Uuid::new_v4().to_string();
    f.state.tasks.lock().unwrap().insert(
        task_id.clone(),
        TaskRecord {
            status: TaskStatus {
                id: task_id.clone(),
                kind: "prepare".into(),
                state: "running".into(),
                message: "CPU contract".into(),
                started_at: crate::now(),
                finished_at: None,
            },
            profile_id: None,
            runtime_path: None,
            cancelled: false,
            process: None,
        },
    );
    assert_eq!(f.tick().await, IdleOutcome::Deferred);
    f.state
        .tasks
        .lock()
        .unwrap()
        .get_mut(&task_id)
        .unwrap()
        .status
        .state = "unknown".into();
    assert_eq!(f.tick().await, IdleOutcome::Deferred);
    f.state.tasks.lock().unwrap().remove(&task_id);
    f.state.runtime_upgrading.store(true, Ordering::Release);
    assert_eq!(f.tick().await, IdleOutcome::Deferred);
    f.state.runtime_upgrading.store(false, Ordering::Release);
    let ensure = f
        .state
        .ensure_locks
        .lock()
        .await
        .get(&f.profile.id)
        .unwrap()
        .clone();
    let guard = ensure.lock().await;
    assert_eq!(f.tick().await, IdleOutcome::Deferred);
    drop(guard);
    fs::write(f.gate(), b"foreign-owner-marker").unwrap();
    assert_eq!(f.tick().await, IdleOutcome::Deferred);
    assert_eq!(fs::read(f.gate()).unwrap(), b"foreign-owner-marker");
    fs::remove_file(f.gate()).unwrap();
    assert_eq!(f.tick().await, IdleOutcome::Observing);
    f.expire().await;
    fs::write(f.root.join("show-loading"), b"loading").unwrap();
    assert_eq!(f.tick().await, IdleOutcome::Deferred);
    fs::remove_file(f.root.join("show-loading")).unwrap();
    let job:crate::tuning::TuningJob=serde_json::from_value(json!({"id":uuid::Uuid::new_v4().to_string(),"profileId":f.profile.id,"state":"running","scenes":["chat"],"rounds":2,"maxTokens":1024,"startedAt":crate::now(),"updatedAt":crate::now(),"completedRequests":0,"totalRequests":1,"currentStep":"CPU idle exclusion","baseline":{"pcieFrac":0.5,"specMinP":0.5},"candidates":[],"measurements":[],"identity":{},"configFingerprint":"fixture","notes":[]})).unwrap();
    crate::tuning::register_service_operation_fixture(&f.state, &job).unwrap();
    assert_eq!(f.tick().await, IdleOutcome::Deferred);
    assert_eq!(f.state().await["unloads"], 0);
    f.preserved();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dropping_expired_operation_cannot_late_unload_and_explicit_stop_stays_stopped() {
    let f = Fixture::new().await;
    assert_eq!(f.tick().await, IdleOutcome::Observing);
    f.expire().await;
    fs::write(f.root.join("pause-after-gate"), b"pause").unwrap();
    let parent = CancellationToken::new();
    let task_cancel = parent.clone();
    let state = f.state.clone();
    let id = f.profile.id.clone();
    let work = tokio::spawn(async move {
        tick_with_window(state, &id, &task_cancel, 40)
            .await
            .unwrap()
    });
    f.wait("reached-after-gate").await;
    work.abort();
    assert!(work.await.unwrap_err().is_cancelled());
    assert!(!parent.is_cancelled());
    fs::write(f.root.join("release-after-gate"), b"release").unwrap();
    for _ in 0..300 {
        if !f.gate().exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    f.preserved();
    assert_eq!(f.state().await["unloads"], 0);
    f.state
        .clone()
        .dispatch("stop_service", json!({"profileId":f.profile.id}))
        .await
        .unwrap();
    assert_eq!(f.tick().await, IdleOutcome::Deferred);
    assert!(
        !f.state
            .processes
            .lock()
            .unwrap()
            .get_mut(&f.profile.id)
            .unwrap()
            .refresh()
            .unwrap()
            .running
    );
    f.preserved();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn real_update_registration_cannot_enter_the_idle_commit_window() {
    let mut f = Fixture::new().await;
    f.reject_update_before_download();
    let before = f.state().await;
    assert_eq!(f.tick().await, IdleOutcome::Observing);
    f.expire().await;
    fs::write(f.root.join("pause-after-gate"), b"pause").unwrap();
    let state = f.state.clone();
    let id = f.profile.id.clone();
    let unloading = tokio::spawn(async move {
        tick_with_window(state, &id, &CancellationToken::new(), 40)
            .await
            .unwrap()
    });
    f.wait("reached-after-gate").await;
    let state = f.state.clone();
    let id = f.profile.id.clone();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let updating = tokio::task::spawn_blocking(move || {
        entered_tx.send(()).unwrap();
        crate::runtime_upgrade::start(state, id)
    });
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert!(!updating.is_finished());
    assert!(!f.state.runtime_upgrading.load(Ordering::Acquire));
    assert!(f.state.tasks.lock().unwrap().is_empty());
    assert_eq!(f.state().await["unloads"], 0);
    fs::write(f.root.join("release-after-gate"), b"release").unwrap();
    assert_eq!(unloading.await.unwrap(), IdleOutcome::Unloaded);
    let task = tokio::time::timeout(Duration::from_secs(5), updating)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    for _ in 0..200 {
        if !f.state.runtime_upgrading.load(Ordering::Acquire) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(!f.state.runtime_upgrading.load(Ordering::Acquire));
    {
        let tasks = f.state.tasks.lock().unwrap();
        let finished = &tasks.get(&task.id).unwrap().status;
        assert_eq!(finished.state, "failed");
        assert!(finished.message.contains("BUILD.json"));
        assert!(finished.finished_at.is_some());
    }
    let after = f.state().await;
    assert_eq!(after["pid"], before["pid"]);
    assert_eq!(after["loaded"], false);
    assert_eq!(after["unloads"], 1);
    f.preserved();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn registered_real_update_wins_before_idle_and_preserves_loaded_api() {
    let mut f = Fixture::new().await;
    f.reject_update_before_download();
    let before = f.state().await;
    assert_eq!(f.tick().await, IdleOutcome::Observing);
    f.expire().await;
    let state = f.state.clone();
    let id = f.profile.id.clone();
    let (registered_tx, registered_rx) = std::sync::mpsc::channel();
    let (resume_tx, resume_rx) = std::sync::mpsc::channel();
    let updating = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let task = crate::runtime_upgrade::start(state.clone(), id).unwrap();
            registered_tx.send(task.id.clone()).unwrap();
            // Pause this isolated scheduler after real durable registration.
            // The production execute future stays unpolled until the test has
            // checked that idle defers to the actual active task, not fake flags.
            resume_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
            while state.runtime_upgrading.load(Ordering::Acquire) {
                assert!(tokio::time::Instant::now() < deadline);
                tokio::task::yield_now().await;
            }
            task.id
        })
    });
    let task_id = registered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(f.state.runtime_upgrading.load(Ordering::Acquire));
    assert_eq!(
        f.state
            .tasks
            .lock()
            .unwrap()
            .get(&task_id)
            .unwrap()
            .status
            .state,
        "running"
    );
    assert_eq!(f.tick().await, IdleOutcome::Deferred);
    assert_eq!(f.state().await, before);
    f.preserved();
    resume_tx.send(()).unwrap();
    assert_eq!(
        tokio::task::spawn_blocking(move || updating.join().unwrap())
            .await
            .unwrap(),
        task_id
    );
    assert!(!f.state.runtime_upgrading.load(Ordering::Acquire));
    assert_eq!(
        f.state
            .tasks
            .lock()
            .unwrap()
            .get(&task_id)
            .unwrap()
            .status
            .state,
        "failed"
    );
    assert_eq!(f.state().await, before);
    f.preserved();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn real_setup_rpc_cannot_prepare_during_idle_or_mistake_unloaded_api_for_stopped() {
    let f = Fixture::new().await;
    let before = f.state().await;
    assert_eq!(f.tick().await, IdleOutcome::Observing);
    f.expire().await;
    fs::write(f.root.join("pause-after-gate"), b"pause").unwrap();
    let state = f.state.clone();
    let id = f.profile.id.clone();
    let unloading = tokio::spawn(async move {
        tick_with_window(state, &id, &CancellationToken::new(), 40)
            .await
            .unwrap()
    });
    f.wait("reached-after-gate").await;
    let state = f.state.clone();
    let profile = f.profile.clone();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let preparing = tokio::task::spawn_blocking(move || {
        entered_tx.send(()).unwrap();
        tokio::runtime::Handle::current().block_on(state.dispatch(
            "run_setup",
            json!({
                "profile":profile,"model":"qwen","quant":"IQ2_XS","context":4096,"images":false
            }),
        ))
    });
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert!(!preparing.is_finished());
    assert!(f.state.tasks.lock().unwrap().is_empty());
    assert_eq!(f.state().await["unloads"], 0);
    fs::write(f.root.join("release-after-gate"), b"release").unwrap();
    assert_eq!(unloading.await.unwrap(), IdleOutcome::Unloaded);
    let error = tokio::time::timeout(Duration::from_secs(5), preparing)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(error.contains("停止受管 API 服务"), "{error}");
    assert!(f.state.tasks.lock().unwrap().is_empty());
    let after = f.state().await;
    assert_eq!(after["pid"], before["pid"]);
    assert_eq!(after["loaded"], false);
    assert_eq!(after["unloads"], 1);
    f.preserved();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn contended_global_operation_defers_without_queued_or_late_unload() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let other_before = other.state().await;
    assert_eq!(f.tick().await, IdleOutcome::Observing);
    f.expire().await;
    let state = f.state.clone();
    let (held_tx, held_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let operation = std::thread::spawn(move || {
        let _guard = state.runtime_operations.lock().unwrap();
        held_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    });
    held_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(1), f.tick())
        .await
        .unwrap();
    assert_eq!(result, IdleOutcome::Deferred);
    assert_eq!(f.state().await["unloads"], 0);
    f.preserved();
    release_tx.send(()).unwrap();
    tokio::task::spawn_blocking(move || operation.join().unwrap())
        .await
        .unwrap();
    f.expire().await;
    assert_eq!(
        f.state().await["unloads"],
        0,
        "the expired attempt must not queue an unload"
    );
    assert_eq!(f.tick().await, IdleOutcome::Observing);
    f.expire().await;
    assert_eq!(f.tick().await, IdleOutcome::Unloaded);
    assert_eq!(other.state().await, other_before);
    f.preserved();
    other.preserved();
}
