//! Fixed official stdio MCP handshake. No tools/call, setup, model or config mutation.
//! The dispatcher must resolve the profile from the registry before calling this.
use crate::{processes::hidden, types::ServiceProfile};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::{BufRead, BufReader, Read, Write}, path::{Path, PathBuf}, process::{Child, ChildStdin, Command, Stdio}, sync::mpsc, time::{Duration, Instant}};

const OUTPUT_LIMIT: u64 = 256 * 1024;
const DEADLINE: Duration = Duration::from_secs(10);
const KNOWN_TOOLS: &[&str] = &["strata_status", "strata_models", "strata_install", "strata_start", "strata_stop", "strata_logs", "strata_benchmark", "strata_connect_info"];
// Independently fetched from reviewed official commits fb58e0d and 61b3fb5d.
// Normalize CRLF so a Git checkout with autocrlf has the same reviewed code.
const REVIEWED_SCRIPT_SHA256: &[&str] = &["99e39483823128042ce1355056165669e07637b893b64e0f21dd20194141ad98", "6602f0c0fb8b1228d72b83e423f1e25c4b1fb4043840c360121bb4b6fb5aa70a"];

struct ProbeProcess {
    child: Child,
    #[cfg(windows)] job: windows_sys::Win32::Foundation::HANDLE,
}
impl Drop for ProbeProcess {
    fn drop(&mut self) {
        #[cfg(windows)] unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1); windows_sys::Win32::Foundation::CloseHandle(self.job); }
        #[cfg(unix)] unsafe { libc::kill(-(self.child.id() as i32), libc::SIGKILL); }
        let _ = self.child.kill(); let _ = self.child.wait();
    }
}
#[cfg(windows)]
fn own_windows_child(child: &mut Child) -> Result<windows_sys::Win32::Foundation::HANDLE, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{Foundation::*, System::{JobObjects::*, Diagnostics::ToolHelp::*, Threading::*}};
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let assigned = !job.is_null() && SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of_val(&info) as u32) != 0 && AssignProcessToJobObject(job, child.as_raw_handle() as _) != 0;
        let mut resumed = false;
        if assigned {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snapshot != INVALID_HANDLE_VALUE {
                let mut entry: THREADENTRY32 = std::mem::zeroed(); entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
                let mut found = Thread32First(snapshot, &mut entry);
                while found != 0 {
                    if entry.th32OwnerProcessID == child.id() {
                        let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                        if !thread.is_null() { resumed = ResumeThread(thread) != u32::MAX; CloseHandle(thread); }
                        break;
                    }
                    found = Thread32Next(snapshot, &mut entry);
                }
                CloseHandle(snapshot);
            }
        }
        if !assigned || !resumed { let _ = child.kill(); let _ = child.wait(); if !job.is_null() { CloseHandle(job); } return Err("无法建立 MCP 自检进程树，已取消".into()); }
        Ok(job)
    }
}
fn fixed_paths(profile: &ServiceProfile) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    if !Path::new(&profile.install_dir).is_absolute() || !Path::new(&profile.python_path).is_absolute() { return Err("MCP 自检需要已登记的绝对安装目录和 Python 路径".into()); }
    let root = dunce::canonicalize(&profile.install_dir).map_err(|_| "Strata 安装目录不可读取")?;
    let python = dunce::canonicalize(&profile.python_path).map_err(|_| "已登记的 Python 不可读取")?;
    if !python.is_file() || !root.join("setup.py").is_file() || !root.join("serve/server.py").is_file() { return Err("已登记的安装目录不是完整 Strata 运行环境".into()); }
    let selected = root.join("tools/strata_mcp.py");
    let script = dunce::canonicalize(&selected).map_err(|_| "当前运行环境没有官方 tools/strata_mcp.py，请更新运行环境")?;
    if !script.starts_with(&root) || !script.is_file() || fs::metadata(&script).map_err(|e| e.to_string())?.len() > 2 * 1024 * 1024 { return Err("官方 MCP 脚本路径或大小无效".into()); }
    Ok((root, python, script))
}
fn send(input: &mut ChildStdin, message: Value) -> Result<(), String> {
    serde_json::to_writer(&mut *input, &message).map_err(|e| e.to_string())?;
    input.write_all(b"\n").and_then(|_| input.flush()).map_err(|_| "MCP 自检进程已关闭输入".into())
}
fn receive(rx: &mpsc::Receiver<Result<Value, String>>, id: u64, deadline: Instant) -> Result<Value, String> {
    for _ in 0..64 {
        let remaining = deadline.checked_duration_since(Instant::now()).ok_or("MCP 自检超时，进程已停止")?;
        let message = rx.recv_timeout(remaining).map_err(|_| "MCP 自检未在期限内返回，进程已停止")??;
        if message.get("id").and_then(Value::as_u64) != Some(id) { continue; }
        if message.get("error").is_some() { return Err("官方 MCP 拒绝初始化或工具列表请求".into()); }
        return message.get("result").filter(|v| v.is_object()).cloned().ok_or_else(|| "MCP 自检响应缺少 result 对象".into());
    }
    Err("MCP 自检返回过多非响应消息".into())
}
fn reviewed_source(profile: &ServiceProfile) -> Result<((PathBuf, PathBuf, PathBuf), String), String> {
    let paths = fixed_paths(profile)?;
    let content = fs::read_to_string(&paths.2).map_err(|_| "官方 MCP 脚本不是可读取 UTF-8 源码")?;
    let digest = format!("{:x}", Sha256::digest(content.replace("\r\n", "\n").as_bytes()));
    if !REVIEWED_SCRIPT_SHA256.contains(&digest.as_str()) { return Err("MCP 脚本与已核查官方源码不一致，未执行。请安装受支持的官方运行环境".into()); }
    Ok((paths, content))
}
pub fn verify_registered_script(profile: &ServiceProfile) -> Result<(), String> {
    reviewed_source(profile).map(|_| ())
}
pub fn probe_registered_profile(profile: &ServiceProfile) -> Result<Value, String> {
    let (paths, source) = reviewed_source(profile)?;
    probe_source(paths, source)
}
#[cfg(test)]
fn probe_paths((root, python, script): (PathBuf, PathBuf, PathBuf)) -> Result<Value, String> {
    let source = fs::read_to_string(&script).map_err(|e| e.to_string())?;
    probe_source((root, python, script), source)
}
fn probe_source((root, python, script): (PathBuf, PathBuf, PathBuf), source: String) -> Result<Value, String> {
    // Execute the exact bytes already verified, not a second read of a script
    // that an updater could replace between the digest check and Python's open.
    // --root remains the documented installation root; only this temporary,
    // reviewed source snapshot is removed when the bounded probe finishes.
    let mut snapshot = tempfile::Builder::new().prefix("strata-mcp-readonly-").suffix(".py").tempfile().map_err(|_| "无法保存 MCP 自检源码快照")?;
    snapshot.write_all(source.as_bytes()).and_then(|_| snapshot.flush()).map_err(|_| "无法保存 MCP 自检源码快照")?;
    let mut command = Command::new(&python);
    // The fixed official tools/strata_mcp.py source and documented CLI only.
    command.args(["-I", "-S", "-B", "-u"]).arg(snapshot.path()).arg("--root").arg(&root).current_dir(&root)
        .env("PYTHONIOENCODING", "utf-8").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hidden(&mut command);
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000004); }
    let mut child = command.spawn().map_err(|_| "无法启动官方 MCP 脚本")?;
    #[cfg(windows)] let job = own_windows_child(&mut child)?;
    let mut process = ProbeProcess { child, #[cfg(windows)] job };
    let mut input = process.child.stdin.take().ok_or("MCP 自检没有 stdin")?;
    let stdout = process.child.stdout.take().ok_or("MCP 自检没有 stdout")?;
    let stderr = process.child.stderr.take().ok_or("MCP 自检没有 stderr")?;
    // Discard diagnostics; never expose arbitrary script output or credentials.
    std::thread::spawn(move || { let _ = std::io::copy(&mut stderr.take(OUTPUT_LIMIT), &mut std::io::sink()); });
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout).take(OUTPUT_LIMIT + 1); let mut total = 0;
        loop {
            let mut line = Vec::new();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) => { let _ = tx.send(Err("MCP 自检进程在完成前关闭输出".into())); break; }
                Ok(n) => { total += n as u64; if total > OUTPUT_LIMIT { let _ = tx.send(Err("MCP 自检输出超过限制".into())); break; } }
                Err(_) => { let _ = tx.send(Err("无法读取 MCP 自检输出".into())); break; }
            }
            let parsed = serde_json::from_slice::<Value>(&line).map_err(|_| "MCP 自检返回无效 JSON".to_string());
            let failed = parsed.is_err(); if tx.send(parsed).is_err() || failed { break; }
        }
    });
    let deadline = Instant::now() + DEADLINE;
    send(&mut input, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"strata-manager-readonly-probe","version":"1"}}}))?;
    let initialized = receive(&rx, 1, deadline)?;
    let protocol = initialized.get("protocolVersion").and_then(Value::as_str).ok_or("MCP 自检未协商协议版本")?;
    if !["2025-06-18", "2025-03-26", "2024-11-05"].contains(&protocol) { return Err("官方 MCP 返回未支持的协议版本".into()); }
    if initialized.pointer("/serverInfo/name").and_then(Value::as_str) != Some("strata") { return Err("MCP 脚本未声明官方 Strata 服务身份".into()); }
    send(&mut input, json!({"jsonrpc":"2.0","method":"notifications/initialized"}))?;
    send(&mut input, json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}))?;
    let listed = receive(&rx, 2, deadline)?;
    if listed.get("nextCursor").is_some() { return Err("官方 MCP 工具列表不应分页，请检查脚本版本".into()); }
    let definitions = listed.get("tools").and_then(Value::as_array).ok_or("MCP 自检缺少工具列表")?;
    if definitions.len() > 32 { return Err("官方 MCP 工具数量异常".into()); }
    let mut tools = Vec::new(); let mut names = std::collections::BTreeSet::new();
    for tool in definitions {
        let name = tool.get("name").and_then(Value::as_str).ok_or("MCP 工具缺少名称")?;
        if !KNOWN_TOOLS.contains(&name) || !names.insert(name) { return Err("官方 MCP 工具列表含未知或重复工具，请更新接入适配".into()); }
        let read_only = matches!(name, "strata_status" | "strata_models" | "strata_logs" | "strata_connect_info");
        tools.push(json!({"name":name,"readOnly":read_only}));
    }
    if tools.is_empty() { return Err("官方 MCP 工具列表为空".into()); }
    // EOF and process-tree Drop conclude the probe. No tools/call can be constructed here.
    drop(input);
    Ok(json!({"protocolVersion":protocol,"serverName":"strata","tools":tools,"scriptPath":script,"pythonPath":python,"installDir":root,"readOnlyProbe":true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture_profile(root: &Path, python: &str) -> ServiceProfile { ServiceProfile { id:"mcp-probe-fixture".into(),name:"Fixture".into(),base_url:"http://127.0.0.1:18901".into(),install_dir:root.to_string_lossy().into(),python_path:python.into(),config_path:root.join("unused.json").to_string_lossy().into(),managed:true } }
    #[test]
    fn nonexistent_or_relative_profiles_fail_before_spawn() {
        let mut profile = fixture_profile(Path::new("relative"), "python");
        assert!(probe_registered_profile(&profile).unwrap_err().contains("绝对"));
        let temp = tempfile::tempdir().unwrap(); profile.install_dir = temp.path().to_string_lossy().into();
        assert!(probe_registered_profile(&profile).is_err());
    }
    #[test]
    fn fixed_stdio_fixture_never_calls_a_tool_and_terminates() {
        let executable = if cfg!(windows) { "py" } else { "python3" };
        let python = Command::new(executable).args(["-c", "import sys;print(sys.executable)"]).output().expect("fixture Python is required");
        assert!(python.status.success()); let python = String::from_utf8(python.stdout).unwrap().trim().to_string();
        let temp = tempfile::tempdir().unwrap(); fs::create_dir(temp.path().join("tools")).unwrap(); fs::create_dir(temp.path().join("serve")).unwrap();
        fs::write(temp.path().join("setup.py"), "# never imported").unwrap(); fs::write(temp.path().join("serve/server.py"), "# never started").unwrap();
        fs::write(temp.path().join("tools/strata_mcp.py"), r#"import json,sys,pathlib
assert sys.argv[1:] == ['--root', str(pathlib.Path.cwd())]
seen=[]
for line in sys.stdin:
 m=json.loads(line); seen.append(m['method'])
 pathlib.Path('fixture-methods.json').write_text(json.dumps(seen))
 assert m['method'] in ['initialize','notifications/initialized','tools/list']
 if m['method']=='initialize': r={'protocolVersion':'2025-06-18','serverInfo':{'name':'strata'}}
 elif m['method']=='tools/list': r={'tools':[{'name':'strata_status'},{'name':'strata_start'}]}
 else: continue
 print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':r}),flush=True)
"#).unwrap();
        let profile = fixture_profile(temp.path(), &python);
        assert!(verify_registered_script(&profile).unwrap_err().contains("未执行"));
        let result = probe_paths(fixed_paths(&profile).unwrap()).unwrap();
        assert_eq!(result["readOnlyProbe"], true); assert_eq!(result["tools"][1]["readOnly"], false);
        let seen: Value = serde_json::from_slice(&fs::read(temp.path().join("fixture-methods.json")).unwrap()).unwrap();
        assert_eq!(seen, json!(["initialize","notifications/initialized","tools/list"]));
        assert!(!temp.path().join(".strata-mcp").exists());
    }
}
