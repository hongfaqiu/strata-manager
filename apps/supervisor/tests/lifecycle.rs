#![cfg(any(windows, target_os = "linux"))]
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    process::{Child, Command, Stdio},
    time::Duration,
};
use strata_local_ipc::call;

fn launch(data: &Path) -> Child {
    let mut command = Command::new(env!("CARGO_BIN_EXE_strata-supervisor"));
    command
        .arg("--data-dir")
        .arg(data)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    strata_runtime_core::processes::hidden(&mut command);
    command.spawn().unwrap()
}
async fn ready(data: &Path) -> Value {
    for _ in 0..100 {
        if let Ok(status) = call(data, "supervisor_status", json!({})).await {
            return status;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("isolated test supervisor failed to start");
}
async fn wait_exit(child: &mut Child) {
    for _ in 0..100 {
        if child.try_wait().unwrap().is_some() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let _ = child.kill();
    panic!("isolated supervisor did not stop");
}
fn python() -> String {
    #[cfg(windows)]
    let programs = ["py"];
    #[cfg(target_os = "linux")]
    let programs = ["python3", "python"];
    for program in programs {
        let mut probe = Command::new(program);
        probe.args([
            "-I",
            "-S",
            "-c",
            "import sys;assert sys.version_info.major==3;print(sys.executable)",
        ]);
        strata_runtime_core::processes::hidden(&mut probe);
        let Ok(result) = probe.output() else {
            continue;
        };
        if result.status.success() {
            let executable = String::from_utf8(result.stdout).unwrap().trim().to_owned();
            assert!(Path::new(&executable).is_absolute());
            assert!(Path::new(&executable).is_file());
            return executable;
        }
    }
    panic!("isolated lifecycle fixture requires Python 3");
}

// The fixture reports its OS creation identity. Termination holds a Windows
// process handle or a Linux pidfd, so a recycled PID cannot target another process.
const FIXTURE_IDENTITY: &str = r#"
import ctypes,json,os,pathlib,signal,sys
if sys.platform=='win32':
 kernel=ctypes.WinDLL('kernel32',use_last_error=True)
 kernel.GetCurrentProcess.restype=ctypes.c_void_p
 kernel.OpenProcess.argtypes=[ctypes.c_uint32,ctypes.c_int,ctypes.c_uint32];kernel.OpenProcess.restype=ctypes.c_void_p
 kernel.GetProcessTimes.argtypes=[ctypes.c_void_p]+[ctypes.POINTER(ctypes.c_uint64)]*4;kernel.GetProcessTimes.restype=ctypes.c_int
 kernel.QueryFullProcessImageNameW.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.c_wchar_p,ctypes.POINTER(ctypes.c_uint32)];kernel.QueryFullProcessImageNameW.restype=ctypes.c_int
 kernel.TerminateProcess.argtypes=[ctypes.c_void_p,ctypes.c_uint32];kernel.TerminateProcess.restype=ctypes.c_int
 kernel.CloseHandle.argtypes=[ctypes.c_void_p];kernel.CloseHandle.restype=ctypes.c_int
def windows_created(handle):
 times=[ctypes.c_uint64() for _ in range(4)]
 assert kernel.GetProcessTimes(handle,*[ctypes.byref(value) for value in times]),ctypes.get_last_error()
 return str(times[0].value)
def linux_stat(pid):
 return pathlib.Path('/proc',str(pid),'stat').read_text().rsplit(') ',1)[1].split()
def identity():
 pid=os.getpid()
 return {'pid':pid,'parentPid':os.getppid(),'created':windows_created(kernel.GetCurrentProcess()) if sys.platform=='win32' else linux_stat(pid)[19],'executable':str(pathlib.Path(sys.executable).resolve()),'directory':str(pathlib.Path.cwd().resolve())}
def terminate(expected):
 pid=expected['pid'];assert pid>0 and pid!=os.getpid()
 executable=pathlib.Path(expected['executable']).resolve()
 assert executable==pathlib.Path(sys.executable).resolve()
 if sys.platform=='win32':
  handle=kernel.OpenProcess(0x1001,False,pid);assert handle,ctypes.get_last_error()
  try:
   assert windows_created(handle)==expected['created'],'fixture PID was recycled'
   image=ctypes.create_unicode_buffer(32768);length=ctypes.c_uint32(len(image))
   assert kernel.QueryFullProcessImageNameW(handle,0,image,ctypes.byref(length)),ctypes.get_last_error()
   assert pathlib.Path(image.value).resolve()==executable,'fixture executable changed'
   assert kernel.TerminateProcess(handle,1),ctypes.get_last_error()
  finally:kernel.CloseHandle(handle)
 else:
  descriptor=os.pidfd_open(pid)
  try:
   stat=linux_stat(pid)
   assert stat[19]==expected['created'],'fixture PID was recycled'
   assert int(stat[1])==expected['parentPid'],'fixture supervisor changed'
   assert os.getpgid(pid)==pid,'fixture is not the owned process-group leader'
   assert pathlib.Path('/proc',str(pid),'exe').resolve()==executable,'fixture executable changed'
   assert pathlib.Path('/proc',str(pid),'cwd').resolve()==pathlib.Path(expected['directory']).resolve(),'fixture directory changed'
   signal.pidfd_send_signal(descriptor,signal.SIGKILL)
  finally:os.close(descriptor)
if __name__=='__main__':terminate(json.loads(sys.argv[1]))
"#;

fn terminate_owned_fixture(status: &Value, health: &Value, directory: &Path, owner: u64) -> u64 {
    assert_eq!(status["running"], true);
    assert_eq!(status["owned"], true);
    let identity = &health["fixture"];
    let pid = status["pid"].as_u64().unwrap();
    assert_eq!(identity["pid"].as_u64(), Some(pid));
    assert_eq!(identity["parentPid"].as_u64(), Some(owner));
    assert_eq!(
        dunce::canonicalize(identity["directory"].as_str().unwrap()).unwrap(),
        dunce::canonicalize(directory).unwrap()
    );
    let mut terminate = Command::new(python());
    terminate
        .args(["-I", "-S"])
        .arg(directory.join("fixture_identity.py"))
        .arg(serde_json::to_string(identity).unwrap())
        .stdin(Stdio::null());
    strata_runtime_core::processes::hidden(&mut terminate);
    let result = terminate.output().unwrap();
    assert!(
        result.status.success(),
        "verified fixture termination failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    pid
}

fn fixture(directory: &Path) {
    let reserved = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = reserved.local_addr().unwrap().port();
    drop(reserved);
    fs::create_dir_all(directory.join("serve")).unwrap();
    fs::create_dir(directory.join("tokenizer")).unwrap();
    fs::write(directory.join("tokenizer/tokenizer.json"), "{}").unwrap();
    fs::write(directory.join("tokenizer/vocab.json"), "{}").unwrap();
    fs::write(directory.join("tokenizer/merges.txt"), "#version: 0.2").unwrap();
    fs::write(directory.join("tokenizer/token_type.json"), "{}").unwrap();
    fs::write(directory.join("setup.py"), "# isolated fixture").unwrap();
    fs::write(directory.join("fixture_identity.py"), FIXTURE_IDENTITY).unwrap();
    fs::write(
        directory.join("fixture.gguf"),
        b"GGUF isolated test; never sent to real engine",
    )
    .unwrap();
    fs::write(directory.join("serve/server.py"), r#"
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import argparse,json
from fixture_identity import identity
p=argparse.ArgumentParser();p.add_argument('--port',type=int);p.add_argument('--host');args,_=p.parse_known_args()
loaded=False
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  if self.path=='/health':out={'status':'ok','service':'strata','loaded':loaded,'model':'isolated-fixture','fixture':identity()}
  elif self.path=='/v1/status':out={'service':'strata','activity':{'in_flight':0}}
  elif self.path=='/metrics':out={'live':{'state':'idle' if loaded else 'unloaded','queued':0,'running':0,'waiting':0,'outside_slots':0}}
  else:out={}
  self.respond(out)
 def do_POST(self):
  global loaded
  self.rfile.read(int(self.headers.get('Content-Length',0)))
  if self.path in ('/load','/v1/load'):loaded=True;out={'status':'loaded'}
  elif self.path in ('/unload','/v1/unload'):loaded=False;out={'status':'unloaded'}
  else:out={}
  self.respond(out)
 def respond(self,value):
  body=json.dumps(value).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
ThreadingHTTPServer((args.host,args.port),Handler).serve_forever()
"#).unwrap();
    fs::write(
        directory.join("strata-fixture.json"),
        serde_json::to_vec(&json!({
            "exe":python(),"args":["--native","fixture.gguf"],"cwd":directory,
            "tokenizer":"tokenizer","model_name":"isolated-fixture","port":port,
            "host":"127.0.0.1","api_monitor":false
        }))
        .unwrap(),
    )
    .unwrap();
}

struct DaemonGuard {
    child: Option<Child>,
}
impl Drop for DaemonGuard {
    fn drop(&mut self) {
        if let Some(child) = &mut self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn real_background_process_survives_client_disconnect_and_reconnects_with_single_owner() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let separate = temp.path().join("separate-data");
    let runtime = temp.path().join("runtime");
    fs::create_dir_all(&data).unwrap();
    fs::create_dir_all(&separate).unwrap();
    fs::create_dir_all(&runtime).unwrap();
    fixture(&runtime);
    let mut guard = DaemonGuard {
        child: Some(launch(&data)),
    };
    let first = ready(&data).await;
    assert_eq!(first["protocolVersion"], 1);
    let owner = first["pid"].as_u64().unwrap();
    call(
        &data,
        "store_set",
        json!({"key":"lifecycle-test","value":{"中文":"persisted"}}),
    )
    .await
    .unwrap();
    let mut duplicate = launch(&data);
    wait_exit(&mut duplicate).await;
    assert!(duplicate.try_wait().unwrap().unwrap().success());
    assert_eq!(ready(&data).await["pid"].as_u64(), Some(owner));
    let mut other = DaemonGuard {
        child: Some(launch(&separate)),
    };
    assert_ne!(ready(&separate).await["pid"].as_u64(), Some(owner));
    assert!(
        call(&separate, "store_get", json!({"key":"lifecycle-test"}))
            .await
            .unwrap()
            .is_null()
    );
    call(&separate, "shutdown_supervisor", json!({}))
        .await
        .unwrap();
    wait_exit(other.child.as_mut().unwrap()).await;

    let candidates = call(&data, "discover_local", json!({"directories":[runtime]}))
        .await
        .unwrap();
    let candidate = candidates
        .as_array()
        .unwrap()
        .iter()
        // Discovery intentionally lists other running installations first.
        // Parallel lifecycle fixtures share the display name, so select this
        // test's exact root/config rather than another test's active listener.
        .find(|c| {
            dunce::canonicalize(c["installDir"].as_str().unwrap()).unwrap()
                == dunce::canonicalize(&runtime).unwrap()
                && dunce::canonicalize(c["configPath"].as_str().unwrap()).unwrap()
                    == dunce::canonicalize(runtime.join("strata-fixture.json")).unwrap()
        })
        .unwrap()
        .clone();
    let original = fs::read(runtime.join("strata-fixture.json")).unwrap();
    let profile = call(&data, "import_local", json!({"candidate":candidate}))
        .await
        .unwrap();
    assert_eq!(
        fs::read(runtime.join("strata-fixture.json")).unwrap(),
        original
    );
    let id = profile["id"].as_str().unwrap().to_owned();
    let (left, right) = tokio::join!(
        call(&data, "ensure_local_service", json!({"profileId":id})),
        call(&data, "ensure_local_service", json!({"profileId":id}))
    );
    let left = left.unwrap();
    let right = right.unwrap();
    assert_eq!(left["pid"], right["pid"]);
    assert_eq!(left["owned"], true);
    assert_eq!(ready(&data).await["activeServices"], 1);
    let health = call(
        &data,
        "strata_request",
        json!({"profile":profile,"path":"/health","method":"GET"}),
    )
    .await
    .unwrap();
    assert_eq!(health["loaded"], true);
    // Every RPC opens/closes its own UI-like connection. The model remains
    // healthy after all previous clients have gone away.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        call(&data, "store_get", json!({"key":"lifecycle-test"}))
            .await
            .unwrap()["中文"],
        "persisted"
    );
    let status = call(&data, "service_status", json!({"profileId":id}))
        .await
        .unwrap();
    assert_eq!(status["pid"], left["pid"]);
    assert_eq!(status["running"], true);

    assert_eq!(
        call(&data, "get_background_policy", json!({}))
            .await
            .unwrap(),
        json!({"mode":"lazy","autoRecover":true})
    );
    call(&data, "prepare_app_update", json!({})).await.unwrap();
    assert_eq!(ready(&data).await["pid"].as_u64(), Some(owner));
    assert!(data.join("backups").read_dir().unwrap().next().is_some());
    assert!(std::net::TcpStream::connect_timeout(
        &url_origin(&profile),
        Duration::from_millis(200)
    )
    .is_ok());

    // Only the PID returned by this isolated owned fixture is terminated.
    // No user's real Python/runtime or port is touched.
    let killed = terminate_owned_fixture(&status, &health, &runtime, owner);
    let mut restored = None;
    for _ in 0..200 {
        let current = call(&data, "service_status", json!({"profileId":id}))
            .await
            .unwrap();
        if current["running"] == true && current["pid"].as_u64() != Some(killed) {
            restored = Some(current);
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        restored.is_some(),
        "selected fixture was not automatically recovered"
    );
    assert_eq!(ready(&data).await["activeServices"], 1);
    call(&data, "stop_service", json!({"profileId":id}))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(2400)).await;
    assert_eq!(
        call(&data, "service_status", json!({"profileId":id}))
            .await
            .unwrap()["running"],
        false
    );
    call(&data, "ensure_local_service", json!({"profileId":id}))
        .await
        .unwrap();

    // Broken managed snapshots cannot produce an endless GPU restart loop.
    call(&data, "stop_service", json!({"profileId":id}))
        .await
        .unwrap();
    let managed = Path::new(profile["configPath"].as_str().unwrap());
    let managed_bytes = fs::read(managed).unwrap();
    fs::write(managed, b"{isolated invalid json").unwrap();
    assert!(call(&data, "ensure_local_service", json!({"profileId":id}))
        .await
        .is_err());
    let mut repair = false;
    for _ in 0..200 {
        let status = ready(&data).await;
        if status["recovery"]["repairRequired"] == true {
            assert_eq!(status["recovery"]["attempts"], 3);
            repair = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(repair, "three failed retries must require repair");
    tokio::time::sleep(Duration::from_millis(2400)).await;
    assert_eq!(ready(&data).await["recovery"]["attempts"], 3);
    fs::write(managed, managed_bytes).unwrap();
    call(&data, "ensure_local_service", json!({"profileId":id}))
        .await
        .unwrap();
    assert_eq!(ready(&data).await["recovery"]["repairRequired"], false);

    call(&data, "shutdown_supervisor", json!({})).await.unwrap();
    wait_exit(guard.child.as_mut().unwrap()).await;
    let origin = url_origin(&profile);
    assert!(std::net::TcpStream::connect_timeout(&origin, Duration::from_millis(200)).is_err());
    guard.child = Some(launch(&data));
    assert_ne!(ready(&data).await["pid"].as_u64(), Some(owner));
    assert_eq!(
        call(&data, "store_get", json!({"key":"lifecycle-test"}))
            .await
            .unwrap()["中文"],
        "persisted"
    );
    let profiles = call(&data, "local_installations", json!({})).await.unwrap();
    assert_eq!(profiles[0]["id"], id);
    call(&data, "ensure_local_service", json!({"profileId":id}))
        .await
        .unwrap();
    // Simulate a supervisor crash: its platform ownership mechanism must release
    // only this fixture's process tree, so a stale model is never duplicated.
    let crashed = ready(&data).await;
    let marker = data.join("analytics").join(format!("{id}.maintenance"));
    fs::write(&marker,serde_json::to_vec(&json!({"mode":"tuning","token":"isolated-stale-owner-token-00000000000000","supervisorPid":crashed["pid"],"supervisorStartedAt":crashed["startedAt"]})).unwrap()).unwrap();
    guard.child.as_mut().unwrap().kill().unwrap();
    guard.child.as_mut().unwrap().wait().unwrap();
    let mut stopped = false;
    for _ in 0..50 {
        if std::net::TcpStream::connect_timeout(&origin, Duration::from_millis(100)).is_err() {
            stopped = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        stopped,
        "fixture model escaped supervisor ownership after simulated crash"
    );
    guard.child = Some(launch(&data));
    ready(&data).await;
    call(&data, "ensure_local_service", json!({"profileId":id}))
        .await
        .unwrap();
    assert!(
        !marker.exists(),
        "new owner must clear verified dead-owner maintenance gate"
    );
    call(&data, "shutdown_supervisor", json!({})).await.unwrap();
    wait_exit(guard.child.as_mut().unwrap()).await;
}
fn url_origin(profile: &Value) -> std::net::SocketAddr {
    profile["baseUrl"]
        .as_str()
        .unwrap()
        .strip_prefix("http://")
        .unwrap()
        .parse()
        .unwrap()
}

fn admitted_fixture(directory: &Path) {
    fixture(directory);
    let path = directory.join("serve/server.py");
    let source = fs::read_to_string(&path).unwrap();
    let instrumentation = r#"
# A controlled standard-library observer protocol fixture, not a real model.
import os,pathlib,sqlite3,time,uuid,threading
directory=pathlib.Path(os.environ['STRATA_MANAGER_ANALYTICS_DIR']);directory.mkdir(exist_ok=True,parents=True)
sid=os.environ['STRATA_MANAGER_SERVICE_ID'];session=uuid.uuid4().hex
db=sqlite3.connect(directory/'journal.sqlite3');db.execute('CREATE TABLE IF NOT EXISTS active_requests(request_id TEXT PRIMARY KEY,service_id TEXT NOT NULL,session_id TEXT NOT NULL,started_ms INTEGER NOT NULL)');db.commit();db.close()
busy=False
def heartbeat():
 while True:
  temporary=directory/('status-'+sid+'.tmp');temporary.write_text(json.dumps({'serviceId':sid,'sessionId':session,'pid':os.getpid(),'updatedAtMs':int(time.time()*1000),'supported':True,'observerActive':True,'journalWriteFailed':False,'error':None}));os.replace(temporary,directory/('status-'+sid+'.json'))
  time.sleep(.5)
threading.Thread(target=heartbeat,daemon=True).start()
post=Handler.do_POST;get=Handler.do_GET
def admitted(self):
 global busy
 key=uuid.uuid4().hex;db=sqlite3.connect(directory/'journal.sqlite3',timeout=5)
 try:
  db.execute('BEGIN IMMEDIATE');marker=directory/(sid+'.maintenance')
  if marker.exists():
   gate=json.loads(marker.read_text());token=self.headers.get('X-Strata-Manager-Maintenance-Token') or self.headers.get('X-Strata-Manager-Tuning-Id')
   if token!=gate.get('token'):
    db.commit();self.rfile.read(int(self.headers.get('Content-Length',0)));self.send_response(503);self.end_headers();return
  db.execute('INSERT INTO active_requests VALUES(?,?,?,?)',(key,sid,session,int(time.time()*1000)));db.commit()
  if self.path=='/load' and pathlib.Path('fail-load').exists():
   self.rfile.read(int(self.headers.get('Content-Length',0)));self.send_response(500);self.end_headers();self.wfile.write(b'{"status":"failed"}');return
  if self.path=='/v1/chat/completions':busy=True;time.sleep(8)
  post(self)
 finally:
  busy=False;db.execute('DELETE FROM active_requests WHERE request_id=?',(key,));db.commit();db.close()
def observed_get(self):
 if busy and self.path in ('/v1/status','/metrics'):
  self.respond({'service':'strata','activity':{'in_flight':1}} if self.path=='/v1/status' else {'live':{'state':'busy','queued':0,'running':1,'waiting':0,'outside_slots':0}})
 else:get(self)
Handler.do_POST=admitted;Handler.do_GET=observed_get
"#;
    fs::write(path,source.replace("ThreadingHTTPServer((args.host,args.port),Handler).serve_forever()",&format!("{instrumentation}\nThreadingHTTPServer((args.host,args.port),Handler).serve_forever()"))).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn switching_two_owned_models_drains_requests_and_failure_restores_original() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    fs::create_dir(&data).unwrap();
    let left = temp.path().join("left");
    let right = temp.path().join("right");
    fs::create_dir(&left).unwrap();
    fs::create_dir(&right).unwrap();
    admitted_fixture(&left);
    admitted_fixture(&right);
    let mut daemon = DaemonGuard {
        child: Some(launch(&data)),
    };
    ready(&data).await;
    let mut profiles = Vec::new();
    for root in [&left, &right] {
        let candidates = call(&data, "discover_local", json!({"directories":[root]}))
            .await
            .unwrap();
        let candidate = candidates
            .as_array()
            .unwrap()
            .iter()
            .find(|c| {
                dunce::canonicalize(c["installDir"].as_str().unwrap()).unwrap()
                    == dunce::canonicalize(root).unwrap()
            })
            .unwrap();
        profiles.push(
            call(&data, "import_local", json!({"candidate":candidate}))
                .await
                .unwrap(),
        );
    }
    let left_id = profiles[0]["id"].as_str().unwrap();
    let right_id = profiles[1]["id"].as_str().unwrap();
    call(&data, "ensure_local_service", json!({"profileId":left_id}))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(600)).await;
    let busy_url = format!(
        "{}/v1/chat/completions",
        profiles[0]["baseUrl"].as_str().unwrap()
    );
    let busy = tokio::spawn(async move {
        reqwest::Client::new()
            .post(busy_url)
            .json(&json!({"fixture":true}))
            .send()
            .await
            .unwrap()
            .status()
    });
    for _ in 0..40 {
        let status = call(
            &data,
            "strata_request",
            json!({"profile":profiles[0],"path":"/v1/status","method":"GET"}),
        )
        .await
        .unwrap();
        if status["activity"]["in_flight"] == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        call(&data, "switch_local_service", json!({"profileId":right_id}))
            .await
            .is_err(),
        "busy original model must remain selected"
    );
    assert_eq!(
        call(&data, "store_get", json!({"key":"activeLocalInstallation"}))
            .await
            .unwrap(),
        left_id
    );
    assert_eq!(busy.await.unwrap(), reqwest::StatusCode::OK);
    fs::write(right.join("fail-load"), "isolated bad target").unwrap();
    let failed = call(&data, "switch_local_service", json!({"profileId":right_id}))
        .await
        .unwrap_err();
    assert!(failed.message.contains("已恢复原模型"), "{failed}");
    assert_eq!(
        call(&data, "store_get", json!({"key":"activeLocalInstallation"}))
            .await
            .unwrap(),
        left_id
    );
    assert_eq!(
        call(
            &data,
            "strata_request",
            json!({"profile":profiles[0],"path":"/health","method":"GET"})
        )
        .await
        .unwrap()["loaded"],
        true
    );
    assert_eq!(ready(&data).await["activeServices"], 1);
    fs::remove_file(right.join("fail-load")).unwrap();
    call(&data, "switch_local_service", json!({"profileId":right_id}))
        .await
        .unwrap();
    assert_eq!(
        call(&data, "store_get", json!({"key":"activeLocalInstallation"}))
            .await
            .unwrap(),
        right_id
    );
    assert_eq!(ready(&data).await["activeServices"], 1);
    assert_eq!(
        call(&data, "service_status", json!({"profileId":left_id}))
            .await
            .unwrap()["running"],
        false
    );
    call(&data, "switch_local_service", json!({"profileId":left_id}))
        .await
        .unwrap();
    assert_eq!(ready(&data).await["activeServices"], 1);
    call(&data, "shutdown_supervisor", json!({})).await.unwrap();
    wait_exit(daemon.child.as_mut().unwrap()).await;
}
