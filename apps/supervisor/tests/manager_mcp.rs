#![cfg(any(windows, target_os = "linux"))]
//! Real stdio -> IPC tests. All services, files and DB mutations are isolated.
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    time::Duration,
};
use strata_local_ipc::call;

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Mcp {
    child: OwnedChild,
    stdin: Option<ChildStdin>,
    responses: mpsc::Receiver<Result<Value, String>>,
    id: u64,
}
impl Mcp {
    fn launch(data: &Path, profile: &str) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_strata-supervisor"));
        command
            .args(["--mcp-server", "--data-dir"])
            .arg(data)
            .args(["--profile-id", profile])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        strata_runtime_core::processes::hidden(&mut command);
        let mut child = command.spawn().unwrap();
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (tx, responses) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let parsed = line
                    .map_err(|e| e.to_string())
                    .and_then(|line| serde_json::from_str(&line).map_err(|e| e.to_string()));
                if tx.send(parsed).is_err() {
                    return;
                }
            }
        });
        Self {
            child: OwnedChild(child),
            stdin: Some(input),
            responses,
            id: 0,
        }
    }
    fn request(&mut self, method: &str, params: Value) -> Value {
        self.id += 1;
        let id = self.id;
        let input = self.stdin.as_mut().unwrap();
        serde_json::to_writer(
            &mut *input,
            &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
        )
        .unwrap();
        input.write_all(b"\n").unwrap();
        input.flush().unwrap();
        for _ in 0..64 {
            let response = self
                .responses
                .recv_timeout(Duration::from_secs(30))
                .expect("MCP did not send a JSON response before the deadline")
                .expect("MCP stdout contains non-JSON protocol output");
            if response["id"] == id {
                return response;
            }
        }
        panic!("MCP emitted too many uncorrelated responses");
    }
    fn initialize(&mut self) -> Value {
        let response = self.request(
            "initialize",
            json!({
                "protocolVersion":"2024-11-05","capabilities":{},
                "clientInfo":{"name":"isolated-manager-mcp-test","version":"1"}
            }),
        );
        let input = self.stdin.as_mut().unwrap();
        input
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n")
            .unwrap();
        input.flush().unwrap();
        response
    }
    fn tool(&mut self, name: &str, arguments: Value) -> Value {
        self.request("tools/call", json!({"name":name,"arguments":arguments}))
    }
    fn close(&mut self) {
        self.stdin.take();
        for _ in 0..100 {
            if let Some(status) = self.child.0.try_wait().unwrap() {
                assert!(
                    status.success(),
                    "MCP exited unsuccessfully after stdin EOF: {status}"
                );
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("MCP did not exit after stdin EOF");
    }
}

fn rejected(response: &Value) -> bool {
    response.get("error").is_some() || response["result"]["isError"] == true
}
fn body(response: &Value) -> Value {
    assert!(!rejected(response), "MCP operation failed: {response}");
    if let Some(value) = response["result"].get("structuredContent") {
        return value.clone();
    }
    response["result"]["content"]
        .as_array()
        .unwrap()
        .iter()
        .find_map(|block| {
            block["text"]
                .as_str()
                .and_then(|text| serde_json::from_str(text).ok())
        })
        .expect("MCP tool response did not contain a JSON body")
}
fn python() -> String {
    let mut command = Command::new(if cfg!(windows) { "py" } else { "python3" });
    command.args(["-I", "-S", "-c", "import sys;print(sys.executable)"]);
    strata_runtime_core::processes::hidden(&mut command);
    let output = command.output().unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn fixture(directory: &Path) {
    let reserved = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = reserved.local_addr().unwrap().port();
    drop(reserved);
    fs::create_dir_all(directory.join("serve")).unwrap();
    fs::create_dir(directory.join("tokenizer")).unwrap();
    for name in ["tokenizer.json", "vocab.json", "token_type.json"] {
        fs::write(directory.join("tokenizer").join(name), "{}").unwrap();
    }
    fs::write(directory.join("tokenizer/merges.txt"), "#version: 0.2").unwrap();
    fs::write(
        directory.join("fixture.gguf"),
        b"CPU-only fixture; never load a real engine",
    )
    .unwrap();
    fs::write(directory.join("serve/server.py"), r#"
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import argparse,json,os
p=argparse.ArgumentParser();p.add_argument('--port',type=int);p.add_argument('--host');args,_=p.parse_known_args()
loaded=False
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  if self.path=='/health':out={'status':'ok','service':'strata','loaded':loaded,'model':'isolated-manager-mcp','fixturePid':os.getpid()}
  elif self.path=='/v1/status':out={'service':'strata','loaded':loaded,'activity':{'in_flight':0}}
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
print('CPU-only managed MCP fixture',flush=True)
ThreadingHTTPServer((args.host,args.port),Handler).serve_forever()
"#).unwrap();
    fs::write(directory.join("setup.py"), r#"
import argparse,json,pathlib
p=argparse.ArgumentParser();p.add_argument('--context',type=int);p.add_argument('--port',type=int);args,_=p.parse_known_args()
root=pathlib.Path.cwd()
(root/'setup-invoked.txt').write_text('CPU-only fixture install; no download')
config=json.loads((root/'strata-fixture.json').read_text());config['max_context']=args.context;config['port']=args.port
(root/'strata-iq2_xs.json').write_text(json.dumps(config))
print('Fixture setup completed without downloads',flush=True)
"#).unwrap();
    fs::write(
        directory.join("strata-fixture.json"),
        serde_json::to_vec(&json!({
            "exe":python(),"args":["--native","fixture.gguf"],"cwd":directory,
            "tokenizer":"tokenizer","model_name":"isolated-manager-mcp","port":port,
            "host":"127.0.0.1","api_monitor":false
        }))
        .unwrap(),
    )
    .unwrap();
    // Reusable CPU-only assets keep installation disk checks out of 68 GB territory.
    for name in ["models/IQ2_XS", "packs/iq2_xs", "mtp/rt"] {
        fs::create_dir_all(directory.join(name)).unwrap();
    }
    for name in [
        "models/IQ2_XS/Qwen3.8-Flash-Next-GSQ-RCO-IQ2_XS-00001-of-00002.gguf",
        "models/IQ2_XS/Qwen3.8-Flash-Next-GSQ-RCO-IQ2_XS-00002-of-00002.gguf",
        "packs/iq2_xs/experts.bin",
        "packs/iq2_xs/index.txt",
        "mtp/rt/experts.bin",
    ] {
        fs::write(directory.join(name), b"CPU-only fixture; never load").unwrap();
    }
}

async fn ready(data: &Path, daemon: &mut OwnedChild) -> Value {
    for _ in 0..100 {
        if let Ok(value) = call(data, "supervisor_status", json!({})).await {
            return value;
        }
        assert!(
            daemon.0.try_wait().unwrap().is_none(),
            "isolated Supervisor exited unexpectedly"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("isolated Supervisor did not become ready");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn real_stdio_bridge_uses_registered_backend_and_preserves_application_ownership() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let runtime = temp.path().join("runtime");
    let settings = temp.path().join("user-settings");
    fs::create_dir_all(&data).unwrap();
    fs::create_dir_all(&settings).unwrap();
    fixture(&runtime);
    let mut command = Command::new(env!("CARGO_BIN_EXE_strata-supervisor"));
    command
        .arg("--data-dir")
        .arg(&data)
        .env("APPDATA", &settings)
        .env("XDG_CONFIG_HOME", &settings)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    strata_runtime_core::processes::hidden(&mut command);
    let mut daemon = OwnedChild(command.spawn().unwrap());
    let original_daemon = ready(&data, &mut daemon).await;
    let candidates = call(&data, "discover_local", json!({"directories":[runtime]}))
        .await
        .unwrap();
    let expected = dunce::canonicalize(runtime.join("strata-fixture.json")).unwrap();
    let candidate = candidates
        .as_array()
        .unwrap()
        .iter()
        .find(|candidate| {
            dunce::canonicalize(candidate["configPath"].as_str().unwrap()).unwrap() == expected
        })
        .expect("isolated fixture not discovered");
    let profile = call(&data, "import_local", json!({"candidate":candidate}))
        .await
        .unwrap();
    let id = profile["id"].as_str().unwrap();
    let mut evidence = Vec::new();
    let mut bridge = Mcp::launch(&data, id);
    let initialized = bridge.initialize();
    assert!(!rejected(&initialized), "{initialized}");
    evidence.push(json!({"name":"initialize","response":initialized}));
    let tools = bridge.request("tools/list", json!({}));
    let mut names: Vec<_> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    names.sort_unstable();
    assert_eq!(
        names,
        [
            "strata_connect_info",
            "strata_install",
            "strata_logs",
            "strata_models",
            "strata_start",
            "strata_status",
            "strata_stop",
            "strata_task_status"
        ]
    );
    evidence.push(json!({"name":"tools/list","response":tools}));
    let status = body(&bridge.tool("strata_status", json!({})));
    assert_eq!(status["profileId"], id);
    assert_eq!(status["management"], "application");
    assert_eq!(status["process"]["running"], false);
    assert_eq!(
        ready(&data, &mut daemon).await["activeServices"],
        0,
        "read-only handshake started a service"
    );
    for name in [
        "strata_models",
        "strata_logs",
        "strata_connect_info",
        "strata_task_status",
    ] {
        let response = bridge.tool(name, json!({}));
        body(&response);
        evidence.push(json!({"name":name,"response":response}));
    }
    for (name, arguments) in [
        ("not_a_registered_tool", json!({})),
        ("strata_status", json!({"profileId":"other-profile"})),
        (
            "strata_status",
            json!({"profile":{"id":"other","installDir":"/"}}),
        ),
        (
            "strata_status",
            json!({"method":"shutdown_supervisor","params":{}}),
        ),
        (
            "strata_status",
            json!({"path":"/load","rpc":"stop_service"}),
        ),
        ("strata_logs", json!({"limit":501})),
        ("strata_logs", json!({"limit":0})),
        ("strata_logs", json!({"limit":1.5})),
    ] {
        let response = bridge.tool(name, arguments.clone());
        assert!(
            rejected(&response),
            "argument injection was admitted: {response}"
        );
        evidence.push(
            json!({"name":"rejected-input","tool":name,"arguments":arguments,"response":response}),
        );
    }
    let install_plan = bridge.tool("strata_install", json!({"family":"qwen","quant":"IQ2_XS"}));
    let plan = body(&install_plan);
    assert_eq!(plan["confirmed"], false);
    assert_eq!(plan["action"], "plan");
    assert!(
        !runtime.join("setup-invoked.txt").exists(),
        "default install call executed setup"
    );
    assert_eq!(
        call(&data, "list_tasks", json!({}))
            .await
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        0
    );
    evidence.push(json!({"name":"install-default-plan-only","response":install_plan}));

    let start = bridge.tool("strata_start", json!({}));
    body(&start);
    let health = call(
        &data,
        "strata_request",
        json!({"profile":profile,"path":"/health","method":"GET"}),
    )
    .await
    .unwrap();
    assert_eq!(
        health["loaded"], true,
        "MCP start did not load the isolated fixture"
    );
    let running = body(&bridge.tool("strata_status", json!({})));
    assert_eq!(running["process"]["running"], true);
    assert_eq!(running["process"]["owned"], true);
    let service_pid = running["process"]["pid"].clone();
    assert_eq!(service_pid, health["fixturePid"]);
    evidence.push(json!({"name":"start-loaded-by-supervisor","response":start,"status":running,"health":health}));
    bridge.close();
    assert!(daemon.0.try_wait().unwrap().is_none());
    assert_eq!(
        ready(&data, &mut daemon).await["pid"],
        original_daemon["pid"]
    );
    let mut bridge = Mcp::launch(&data, id);
    assert!(!rejected(&bridge.initialize()));
    let reconnected = body(&bridge.tool("strata_status", json!({})));
    assert_eq!(
        reconnected["process"]["pid"], service_pid,
        "MCP EOF replaced or stopped the managed service"
    );
    assert_eq!(reconnected["process"]["running"], true);
    evidence.push(json!({"name":"backend-and-service-survive-mcp-eof","status":reconnected}));
    let stop = bridge.tool("strata_stop", json!({}));
    body(&stop);
    let stopped = body(&bridge.tool("strata_status", json!({})));
    assert_eq!(stopped["process"]["running"], false);
    assert_eq!(stopped["desired"], false);
    tokio::time::sleep(Duration::from_millis(2400)).await;
    let after_recovery_tick = body(&bridge.tool("strata_status", json!({})));
    assert_eq!(
        after_recovery_tick["process"]["running"], false,
        "automatic recovery revived the explicitly stopped fixture"
    );
    assert_eq!(after_recovery_tick["desired"], false);
    evidence.push(json!({"name":"stop-via-supervisor","response":stop,"status":stopped}));
    let task_response = bridge.tool(
        "strata_install",
        json!({"family":"qwen","quant":"IQ2_XS","confirm":true}),
    );
    let task = body(&task_response);
    evidence.push(json!({"name":"confirmed-fixture-install","response":task_response}));
    let task_id = task["task"]["id"]
        .as_str()
        .or_else(|| task["id"].as_str())
        .expect("confirmed install did not return a task ID");
    let mut finished = None;
    for _ in 0..400 {
        let response = bridge.tool("strata_task_status", json!({"taskId":task_id}));
        let value = body(&response);
        let state = value["tasks"][0]["state"]
            .as_str()
            .or_else(|| value["state"].as_str());
        if matches!(state, Some("completed" | "failed" | "cancelled")) {
            assert_eq!(state, Some("completed"), "fixture install failed: {value}");
            finished = Some(value);
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        runtime.join("setup-invoked.txt").exists(),
        "confirmed install did not invoke isolated setup.py"
    );
    evidence.push(json!({"name":"fixture-install-task-completed","status":finished.expect("fixture install task never completed")}));
    // Seed external ownership only in the isolated DB. This avoids requiring an
    // upstream official MCP script in the CPU fixture and tests persisted gates.
    let mut seed = Command::new(python());
    seed.args(["-I", "-S", "-c", "import sqlite3,sys;db=sqlite3.connect(sys.argv[1]);db.execute('CREATE TABLE IF NOT EXISTS external_management(install_root TEXT PRIMARY KEY,profile_id TEXT NOT NULL,external INTEGER NOT NULL,updated_at INTEGER NOT NULL)');db.execute('INSERT OR REPLACE INTO external_management VALUES(?,?,1,1)',(sys.argv[2],sys.argv[3]));db.commit()"])
        .arg(data.join("strata-manager.sqlite3"))
        .arg(if cfg!(windows) { dunce::canonicalize(&runtime).unwrap().to_string_lossy().to_lowercase() } else { dunce::canonicalize(&runtime).unwrap().to_string_lossy().into_owned() })
        .arg(id);
    strata_runtime_core::processes::hidden(&mut seed);
    assert!(seed.status().unwrap().success());
    for name in ["strata_start", "strata_stop"] {
        let response = bridge.tool(name, json!({}));
        assert!(
            rejected(&response),
            "external installation bypassed management gate: {response}"
        );
        evidence
            .push(json!({"name":"external-management-rejects","tool":name,"response":response}));
    }
    let response = bridge.tool(
        "strata_install",
        json!({"family":"qwen","quant":"IQ2_XS","confirm":true}),
    );
    assert!(
        rejected(&response),
        "external installation admitted setup: {response}"
    );
    evidence.push(json!({"name":"external-management-rejects-install","response":response}));
    bridge.close();
    let missing = temp.path().join("missing-backend");
    fs::create_dir(&missing).unwrap();
    let mut unavailable = Mcp::launch(&missing, id);
    let mut response = unavailable.initialize();
    if !rejected(&response) {
        response = unavailable.tool("strata_status", json!({}));
    }
    assert!(
        rejected(&response),
        "bridge silently launched its own Supervisor: {response}"
    );
    evidence.push(json!({"name":"missing-backend-explicit-error","response":response}));
    unavailable.close();
    call(&data, "shutdown_supervisor", json!({})).await.unwrap();
    if let Some(path) = std::env::var_os("STRATA_MANAGER_MCP_EVIDENCE") {
        let path = std::path::PathBuf::from(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            serde_json::to_vec_pretty(
                &json!({"passed":true,"fixture":"CPU-only isolated runtime","checks":evidence}),
            )
            .unwrap(),
        )
        .unwrap();
        println!("MCP evidence: {}", path.display());
    }
}
