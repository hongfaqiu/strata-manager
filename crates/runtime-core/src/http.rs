use crate::{types::ServiceProfile, RuntimeState};
use futures_util::StreamExt;
use serde_json::Value;

pub fn endpoint(profile: &ServiceProfile, path: &str) -> Result<url::Url, String> {
    let (path, query) = path
        .split_once('?')
        .map(|(p, q)| (p, Some(q)))
        .unwrap_or((path, None));
    if let Some(query) = query {
        let params: Vec<_> = url::form_urlencoded::parse(query.as_bytes()).collect();
        let valid = params.len() == 1
            && match path {
                "/metrics" => params[0].0 == "requests" && params[0].1 == "all",
                "/api/requests" => {
                    params[0].0 == "id"
                        && !params[0].1.is_empty()
                        && params[0].1.len() <= 256
                        && params[0]
                            .1
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c))
                }
                "/slots/0" => matches!(query, "action=save" | "action=restore"),
                _ => false,
            };
        if !valid {
            return Err("该 API 查询参数不受支持".into());
        }
    }
    if path == "/slots/0" && query.is_none() {
        return Err("会话文件接口必须指定 save 或 restore 操作".into());
    }
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains('\\')
        || path.contains('#')
        || path.contains('%')
        || path.split('/').any(|s| s == ".." || s == ".")
    {
        return Err("API 路径必须是没有主机、查询或遍历的相对路径".into());
    }
    let allowed = matches!(
        path,
        "/health"
            | "/metrics"
            | "/api/health"
            | "/models"
            | "/props"
            | "/slots"
            | "/slots/0"
            | "/mcp"
            | "/settings"
            | "/status"
            | "/config"
            | "/v1/status"
            | "/v1/load"
            | "/v1/unload"
            | "/v1/vram"
            | "/v1/models"
            | "/v1/chat/completions"
            | "/v1/messages"
            | "/v1/messages/count_tokens"
            | "/v1/responses"
            | "/load"
            | "/unload"
            | "/api/load"
            | "/api/unload"
            | "/api/requests"
            | "/api/status"
            | "/api/settings"
            | "/api/mcp"
            | "/api/about"
            | "/api/cancel"
    );
    if !allowed {
        return Err(format!("不支持的 Strata API 路径: {path}"));
    }
    let mut url = url::Url::parse(&profile.base_url).map_err(|e| e.to_string())?;
    if url.scheme() != "http"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("服务地址必须为无凭据的 HTTP(S) 地址".into());
    }
    crate::network::management_host(&url)?;
    if url.port_or_known_default() == Some(0) {
        return Err("服务端口必须为 1–65535".into());
    }
    // Profile baseUrl is an origin (the UI accepts /v1 as a convenience).
    if !matches!(url.path(), "" | "/" | "/v1" | "/v1/") {
        return Err("服务地址路径只能为空或 /v1".into());
    }
    url.set_path(path);
    url.set_query(query);
    Ok(url)
}
pub fn key(profile_id: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new("io.strata.manager", profile_id).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("凭据库读取失败: {e}")),
    }
}
pub fn request_builder(
    client: &reqwest::Client,
    profile: &ServiceProfile,
    path: &str,
    method: &str,
    body: Option<Value>,
) -> Result<reqwest::RequestBuilder, String> {
    if !["GET", "POST", "PUT", "DELETE", "PATCH"].contains(&method) {
        return Err("不支持的 HTTP 方法".into());
    }
    validate_runtime_control_body(path, method, body.as_ref())?;
    let url = endpoint(profile, path)?;
    let mut builder = client.request(
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?,
        url,
    );
    if let Some(secret) = key(&profile.id)? {
        builder = builder.bearer_auth(secret);
    }
    if let Some(body) = body {
        builder = builder.json(&body);
    }
    Ok(builder)
}

fn request_timeout(path: &str) -> std::time::Duration {
    // A cold model start or a VRAM resize waiting for a generation can take minutes.
    std::time::Duration::from_secs(match path {
        "/load" | "/v1/load" | "/v1/vram" | "/slots/0?action=save" | "/slots/0?action=restore" => {
            300
        }
        _ => 90,
    })
}

fn is_runtime_control(path: &str) -> bool {
    matches!(
        path,
        "/v1/vram" | "/slots/0?action=save" | "/slots/0?action=restore"
    )
}

fn session_filename_valid(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_lowercase();
    let device = matches!(
        stem.as_str(),
        "con" | "prn" | "aux" | "nul" | "conin$" | "conout$"
    ) || ["com", "lpt"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    });
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('.')
        && !name.ends_with(['.', ' '])
        && !device
        && !name
            .chars()
            .any(|c| c < '\u{20}' || c == '\u{7f}' || "/\\:*?\"<>|".contains(c))
}

fn is_session_probe(path: &str, body: Option<&Value>) -> bool {
    path == "/slots/0?action=save"
        && body
            .and_then(Value::as_object)
            .is_some_and(|b| b.len() == 1 && b.get("filename").and_then(Value::as_str) == Some(""))
}

fn validate_runtime_control_body(
    path: &str,
    method: &str,
    body: Option<&Value>,
) -> Result<(), String> {
    if !is_runtime_control(path) {
        return Ok(());
    }
    if method != "POST" {
        return Err("运行控制接口只接受 POST".into());
    }
    let object = body
        .and_then(Value::as_object)
        .ok_or("运行控制必须提供 JSON 对象")?;
    if path == "/v1/vram" {
        if object.len() != 1
            || !object.get("reserve_mib").is_some_and(|v| {
                v.is_null() || v.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991)
            })
        {
            return Err("显存控制只接受 reserve_mib 非负整数或 null".into());
        }
    } else if !is_session_probe(path, body)
        && (object.len() != 1
            || !object
                .get("filename")
                .and_then(Value::as_str)
                .is_some_and(session_filename_valid))
    {
        return Err("会话文件必须是保存目录内的普通文件名（最多 200 字节）".into());
    }
    Ok(())
}

fn assert_runtime_control_available(state: &RuntimeState) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    crate::runtime_upgrade::assert_available(state)?;
    crate::tuning::assert_available(state)?;
    if state.shutting_down.load(Ordering::Acquire)
        || state.selection_changing.load(Ordering::Acquire)
    {
        return Err("后台正在退出或切换模型，未执行运行控制".into());
    }
    let tasks = state.tasks.try_lock().map_err(|_| "后台任务状态无法核验")?;
    if tasks.values().any(|task| {
        !matches!(
            task.status.state.as_str(),
            "completed" | "failed" | "cancelled"
        ) || task.status.finished_at.is_none()
            || task.process.is_some()
    }) {
        return Err("后台仍有安装或准备任务，未执行运行控制".into());
    }
    Ok(())
}

fn control_lease(state: &RuntimeState, id: &str) -> Result<(ServiceProfile, u32, u64), String> {
    let profile = state.owned_gui_profile(id)?;
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
    let process = processes.get_mut(id).ok_or("运行控制进程记录已改变")?;
    let status = process.refresh()?;
    let started = status.started_at.ok_or("运行控制进程创建时间无法核验")?;
    if !status.running || !status.owned || status.pid != Some(process.child.id()) {
        return Err("运行控制进程归属无法核验".into());
    }
    Ok((profile, process.child.id(), started))
}

fn validate_control_lease(
    state: &RuntimeState,
    before: &(ServiceProfile, u32, u64),
) -> Result<(), String> {
    assert_runtime_control_available(state)?;
    let after = control_lease(state, &before.0.id)?;
    if after.1 != before.1
        || after.2 != before.2
        || serde_json::to_value(&after.0).map_err(|e| e.to_string())?
            != serde_json::to_value(&before.0).map_err(|e| e.to_string())?
    {
        return Err("运行控制期间进程或配置归属已改变，结果未确认".into());
    }
    Ok(())
}

async fn guarded_runtime_control(
    state: &RuntimeState,
    profile: ServiceProfile,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    assert_runtime_control_available(state)?;
    validate_runtime_control_body(&path, "POST", body.as_ref())?;
    let before = control_lease(state, &profile.id)?;
    let gate = crate::maintenance::begin(state, &profile.id, None, "drain")?;
    crate::maintenance::wait_idle(state, &before.0).await?;
    validate_control_lease(state, &before)?;
    let builder = request_builder(&state.client, &before.0, &path, "POST", body)?
        .header("X-Strata-Client", "strata-manager.desktop")
        .header("X-Strata-Manager-Maintenance-Token", gate.token());
    let (status, value) = control_json(builder, request_timeout(&path)).await?;
    validate_control_lease(state, &before)?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), value));
    }
    Ok(value)
}

/// Bound both headers and the entire body of lifecycle control responses.
/// Callers keep their authentication and maintenance headers on the builder.
pub(crate) async fn control_json(
    builder: reqwest::RequestBuilder,
    timeout: std::time::Duration,
) -> Result<(reqwest::StatusCode, Value), String> {
    tokio::time::timeout(timeout, async {
        let response = builder.send().await.map_err(|e| e.to_string())?;
        let status = response.status();
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            if bytes.len() + chunk.len() > 64 * 1024 {
                return Err("控制响应超过 64 KiB".into());
            }
            bytes.extend(chunk);
        }
        let body =
            serde_json::from_slice(&bytes).map_err(|e| format!("控制响应不是有效 JSON: {e}"))?;
        Ok((status, body))
    })
    .await
    .map_err(|_| "控制请求超时，结果未确认；保留现有进程且未自动重试，请检查服务状态".to_string())?
}

#[cfg(test)]
mod control_tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::time::Duration;

    async fn fixture(
        response: Vec<u8>,
        stall: bool,
    ) -> (Result<(reqwest::StatusCode, Value), String>, String) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if std::time::Instant::now() >= deadline {
                            return "fixture was not contacted".into();
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            // Windows accepted sockets inherit the listener's nonblocking mode.
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 1024];
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let count = stream.read(&mut chunk).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
            }
            stream.write_all(&response).unwrap();
            if stall {
                std::thread::sleep(Duration::from_millis(350));
            }
            String::from_utf8_lossy(&request).into_owned()
        });
        let builder = reqwest::Client::new()
            .post(format!("http://{address}/unload"))
            .header("X-Strata-Manager-Maintenance-Token", "fixture-token")
            .json(&json!({}));
        let result = control_json(builder, Duration::from_millis(200)).await;
        (result, server.join().unwrap())
    }

    #[tokio::test]
    async fn unload_timeout_covers_headers_and_incomplete_body() {
        for response in [
            Vec::new(),
            b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{\"status\":".to_vec(),
        ] {
            let (result, _) = fixture(response, true).await;
            assert!(result.unwrap_err().contains("超时"));
        }
    }

    #[tokio::test]
    async fn unload_keeps_maintenance_header_and_bounds_body() {
        let body = br#"{"status":"unloaded"}"#;
        let response =
            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len()).into_bytes();
        let (result, request) = fixture([response, body.to_vec()].concat(), false).await;
        let (status, value) = result.unwrap();
        assert!(status.is_success());
        assert_eq!(value["status"], "unloaded");
        assert!(request
            .to_lowercase()
            .contains("x-strata-manager-maintenance-token: fixture-token"));
        let body = vec![b' '; 64 * 1024 + 1];
        let response =
            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len()).into_bytes();
        let (result, _) = fixture([response, body].concat(), false).await;
        assert!(result.unwrap_err().contains("64 KiB"));
    }

    #[tokio::test]
    async fn session_control_checks_idle_uses_own_gate_and_preserves_published_failure() {
        let directory = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(directory.path().join("private-data")).unwrap();
        struct Cleanup(std::sync::Arc<RuntimeState>);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                self.0.cleanup();
            }
        }
        let _cleanup = Cleanup(state.clone());
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let profile = ServiceProfile {
            id: format!("control-{}", uuid::Uuid::new_v4()),
            name: "CPU control fixture".into(),
            base_url: format!("http://{address}"),
            install_dir: directory.path().to_string_lossy().into(),
            python_path: "fixture-only".into(),
            config_path: directory
                .path()
                .join("fixture.json")
                .to_string_lossy()
                .into(),
            managed: true,
        };
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
        let mut command = if cfg!(windows) {
            std::process::Command::new("powershell.exe")
        } else {
            std::process::Command::new("sleep")
        };
        if cfg!(windows) {
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 15",
            ]);
        } else {
            command.arg("15");
        }
        crate::processes::hidden(&mut command);
        let mut process =
            crate::processes::OwnedProcess::spawn(command, state.logs.clone(), &profile.id)
                .unwrap();
        process.profile = Some(profile.clone());
        let pid = process.child.id();
        state
            .processes
            .lock()
            .unwrap()
            .insert(profile.id.clone(), process);
        let analytics = state.data_dir.join("analytics");
        std::fs::create_dir_all(&analytics).unwrap();
        let db = rusqlite::Connection::open(analytics.join("journal.sqlite3")).unwrap();
        db.execute_batch("CREATE TABLE active_requests(request_id TEXT PRIMARY KEY,service_id TEXT NOT NULL,session_id TEXT NOT NULL,started_ms INTEGER NOT NULL);").unwrap();
        let observer = analytics.join(format!("status-{}.json", profile.id));
        std::fs::write(&observer,serde_json::to_vec(&json!({"serviceId":profile.id,"pid":pid,"updatedAtMs":crate::now(),"supported":true,"observerActive":true,"journalWriteFailed":false,"error":null})).unwrap()).unwrap();
        let marker = analytics.join(format!("{}.maintenance", profile.id));
        let fixture_marker = marker.clone();
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(8);
            let mut requests = Vec::new();
            for index in 0..3 {
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            if std::time::Instant::now() >= deadline {
                                return requests;
                            }
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut chunk = [0; 1024];
                while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                    let count = stream.read(&mut chunk).unwrap();
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&chunk[..count]);
                }
                let text = String::from_utf8(request).unwrap();
                assert!(
                    fixture_marker.is_file(),
                    "idle checks and the actual control must remain gated"
                );
                if index == 2 {
                    let value: Value =
                        serde_json::from_slice(&std::fs::read(&fixture_marker).unwrap()).unwrap();
                    assert!(text.to_lowercase().contains(&format!(
                        "x-strata-manager-maintenance-token: {}",
                        value["token"].as_str().unwrap()
                    )));
                    assert!(text
                        .to_lowercase()
                        .contains("x-strata-client: strata-manager.desktop"));
                }
                requests.push(text);
                let (status, body) = match index {
                    0 => (
                        "200 OK",
                        json!({"service":"strata","activity":{"in_flight":0}}),
                    ),
                    1 => (
                        "200 OK",
                        json!({"live":{"state":"idle","queued":0,"running":0,"waiting":0,"outside_slots":0}}),
                    ),
                    _ => (
                        "500 Internal Server Error",
                        json!({"error":{"message":"flush failed","kind":"io","published":true}}),
                    ),
                };
                let bytes = serde_json::to_vec(&body).unwrap();
                stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",bytes.len()).as_bytes()).unwrap();
                stream.write_all(&bytes).unwrap();
            }
            requests
        });
        let failure = desktop_request(
            &state,
            profile.clone(),
            "/slots/0?action=save".into(),
            "POST".into(),
            Some(json!({"filename":"chat.bin"})),
        )
        .await
        .unwrap_err();
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 3);
        for (request, route) in requests.iter().zip([
            "GET /v1/status ",
            "GET /metrics ",
            "POST /slots/0?action=save ",
        ]) {
            assert!(request.starts_with(route), "{request}");
        }
        assert!(failure.starts_with("HTTP 500: "), "{failure}");
        let detail: Value =
            serde_json::from_str(failure.strip_prefix("HTTP 500: ").unwrap()).unwrap();
        assert_eq!(detail["error"]["published"], true);
        assert!(
            !marker.exists(),
            "the operation must clear its own gate even after failure"
        );
        assert!(
            state
                .processes
                .lock()
                .unwrap()
                .get_mut(&profile.id)
                .unwrap()
                .refresh()
                .unwrap()
                .running
        );
        std::fs::remove_file(observer).unwrap();
        let failure = desktop_request(
            &state,
            profile,
            "/slots/0?action=restore".into(),
            "POST".into(),
            Some(json!({"filename":"chat.bin"})),
        )
        .await
        .unwrap_err();
        assert!(failure.contains("观察器"), "{failure}");
        assert!(!marker.exists());
    }
}

pub async fn strata_request(
    state: &RuntimeState,
    profile: ServiceProfile,
    path: String,
    method: String,
    body: Option<Value>,
) -> Result<Value, String> {
    request_from(state, profile, path, method, body, None).await
}
pub async fn desktop_request(
    state: &RuntimeState,
    profile: ServiceProfile,
    path: String,
    method: String,
    body: Option<Value>,
) -> Result<Value, String> {
    let profile = if method == "GET" {
        state.authoritative_profile(profile)?
    } else {
        state.owned_gui_profile(&profile.id)?
    };
    if is_runtime_control(&path) {
        assert_runtime_control_available(state)?;
        validate_runtime_control_body(&path, &method, body.as_ref())?;
        // The empty-filename capability probe is rejected by upstream before
        // state or file I/O, and does not require draining a live conversation.
        if !is_session_probe(&path, body.as_ref()) {
            return guarded_runtime_control(state, profile, path, body).await;
        }
    }
    request_from(
        state,
        profile,
        path,
        method,
        body,
        Some("strata-manager.desktop"),
    )
    .await
}
async fn request_from(
    state: &RuntimeState,
    profile: ServiceProfile,
    path: String,
    method: String,
    body: Option<Value>,
    client_id: Option<&str>,
) -> Result<Value, String> {
    let mut builder = request_builder(&state.client, &profile, &path, &method, body)?;
    if method == "POST" {
        if let Some(id) = client_id {
            builder = builder.header("X-Strata-Client", id);
        }
    }
    let response = builder
        .timeout(request_timeout(&path))
        .send()
        .await
        .map_err(|e| format!("HTTP 请求失败: {e}"))?;
    let status = response.status();
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        if bytes.len() + chunk.len() > 16 * 1024 * 1024 {
            return Err("响应超过 16 MB".into());
        }
        bytes.extend(chunk);
    }
    if !status.is_success() {
        return Err(format!(
            "HTTP {}: {}",
            status.as_u16(),
            String::from_utf8_lossy(&bytes)
                .chars()
                .take(2048)
                .collect::<String>()
        ));
    }
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    let mut value: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("响应不是有效 JSON: {e}"))?;
    if method == "GET" && (path == "/metrics" || path.starts_with("/metrics?")) {
        // The engine reads only NVIDIA cards; fill AMD readings for a service on this PC (#86).
        crate::amd_gpu::augment_local_metrics(&profile.base_url, &mut value).await;
    }
    Ok(value)
}

// reqwest chunks need not align with UTF-8 code points or SSE events.
pub fn decode_utf8(pending: &mut Vec<u8>, chunk: &[u8], eof: bool) -> Result<String, String> {
    pending.extend_from_slice(chunk);
    match std::str::from_utf8(pending) {
        Ok(text) => {
            let text = text.to_owned();
            pending.clear();
            Ok(text)
        }
        Err(error) if error.error_len().is_none() && !eof => {
            let len = error.valid_up_to();
            let text =
                String::from_utf8(pending.drain(..len).collect()).map_err(|e| e.to_string())?;
            Ok(text)
        }
        Err(error) => Err(format!("SSE UTF-8 数据无效: {error}")),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slow_model_controls_get_extended_timeout_and_other_requests_remain_bounded() {
        for path in [
            "/load",
            "/v1/load",
            "/v1/vram",
            "/slots/0?action=save",
            "/slots/0?action=restore",
        ] {
            assert_eq!(request_timeout(path).as_secs(), 300, "{path}");
        }
        for path in [
            "/unload",
            "/v1/unload",
            "/health",
            "/v1/status",
            "/metrics?requests=all",
            "/config",
            "/settings",
            "/v1/chat/completions",
            "/v1/load-extra",
        ] {
            assert_eq!(request_timeout(path).as_secs(), 90, "{path}");
        }
    }
    #[test]
    fn session_routes_allow_only_exact_slot_zero_actions() {
        let profile = ServiceProfile {
            id: "route-fixture".into(),
            name: "".into(),
            base_url: "http://127.0.0.1:8099".into(),
            install_dir: "".into(),
            python_path: "".into(),
            config_path: "".into(),
            managed: true,
        };
        for path in ["/slots/0?action=save", "/slots/0?action=restore"] {
            assert_eq!(
                endpoint(&profile, path).unwrap().as_str(),
                format!("http://127.0.0.1:8099{path}")
            );
        }
        for path in [
            "/slots/0",
            "/slots/1?action=save",
            "/slots/00?action=save",
            "/slots/0?action=erase",
            "/slots/0?action=save&action=restore",
            "/slots/0?action=save&extra=1",
            "/slots/0?action=%73ave",
            "/slots/0?%61ction=save",
            "/slots/0?action=save#x",
            "/slots/0?action=save?x",
            "/slots/0/?action=save",
        ] {
            assert!(endpoint(&profile, path).is_err(), "{path}");
        }
    }
    #[test]
    fn runtime_controls_validate_real_body_and_read_only_probe() {
        use serde_json::json;
        for reserve in [json!(null), json!(0), json!(32768)] {
            assert!(validate_runtime_control_body(
                "/v1/vram",
                "POST",
                Some(&json!({"reserve_mib":reserve}))
            )
            .is_ok());
        }
        for body in [
            json!({}),
            json!({"reserve_mib":-1}),
            json!({"reserve_mib":0.5}),
            json!({"reserve_mib":"1"}),
            json!({"reserve_mib":9007199254740992_u64}),
            json!({"reserve_mib":1,"extra":true}),
        ] {
            assert!(
                validate_runtime_control_body("/v1/vram", "POST", Some(&body)).is_err(),
                "{body}"
            );
        }
        for path in [
            "/v1/vram",
            "/slots/0?action=save",
            "/slots/0?action=restore",
        ] {
            assert!(validate_runtime_control_body(path, "GET", None).is_err());
            assert!(validate_runtime_control_body(path, "POST", None).is_err());
        }
        let probe = json!({"filename":""});
        assert!(is_session_probe("/slots/0?action=save", Some(&probe)));
        assert!(
            validate_runtime_control_body("/slots/0?action=save", "POST", Some(&probe)).is_ok()
        );
        assert!(
            validate_runtime_control_body("/slots/0?action=restore", "POST", Some(&probe)).is_err()
        );
        assert!(!is_session_probe(
            "/slots/0?action=save",
            Some(&json!({"filename":"","extra":true}))
        ));
        for filename in [
            "",
            "../a.bin",
            "a/b",
            "D:\\a.bin",
            "D:a",
            ".hidden",
            "a.",
            "a ",
            "a\0b",
            "a\u{7f}b",
            "NUL.bin",
            "CON .bin",
            "conin$.bin",
            "COM¹.bin",
            "LPT9",
        ] {
            assert!(!session_filename_valid(filename), "{filename:?}");
        }
        assert!(!session_filename_valid(&"文".repeat(67)));
        for filename in ["会话一.bin", "chat-1.bin", "😀.bin", "COM10.bin"] {
            assert!(validate_runtime_control_body(
                "/slots/0?action=restore",
                "POST",
                Some(&json!({"filename":filename}))
            )
            .is_ok());
        }
        assert!(session_filename_valid(&"x".repeat(200)));
        assert!(validate_runtime_control_body(
            "/slots/0?action=save",
            "POST",
            Some(&json!({"filename":"a.bin","extra":true}))
        )
        .is_err());
    }
    #[test]
    fn runtime_control_admission_rejects_upgrade_selection_shutdown_and_active_tasks() {
        use std::sync::atomic::Ordering;
        let directory = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(directory.path().into()).unwrap();
        assert!(assert_runtime_control_available(&state).is_ok());
        for flag in [
            &state.runtime_upgrading,
            &state.selection_changing,
            &state.shutting_down,
        ] {
            flag.store(true, Ordering::Release);
            assert!(assert_runtime_control_available(&state).is_err());
            flag.store(false, Ordering::Release);
        }
        state.tasks.lock().unwrap().insert(
            "fixture-task".into(),
            crate::processes::TaskRecord {
                status: crate::types::TaskStatus {
                    id: "fixture-task".into(),
                    kind: "setup".into(),
                    state: "running".into(),
                    message: "".into(),
                    started_at: crate::now(),
                    finished_at: None,
                },
                profile_id: Some("fixture".into()),
                runtime_path: None,
                cancelled: false,
                process: None,
            },
        );
        assert!(assert_runtime_control_available(&state).is_err());
        {
            let mut tasks = state.tasks.lock().unwrap();
            let task = tasks.get_mut("fixture-task").unwrap();
            task.status.state = "completed".into();
        }
        assert!(assert_runtime_control_available(&state).is_err());
        state
            .tasks
            .lock()
            .unwrap()
            .get_mut("fixture-task")
            .unwrap()
            .status
            .finished_at = Some(crate::now());
        assert!(assert_runtime_control_available(&state).is_ok());
        assert!(
            control_lease(&state, "fixture").is_err(),
            "an unowned service must never obtain a control lease"
        );
    }
    #[test]
    fn utf8_split_preserves_chinese() {
        let bytes = "你好🙂".as_bytes();
        let mut buffer = vec![];
        let mut text = String::new();
        for byte in bytes {
            text.push_str(&decode_utf8(&mut buffer, &[*byte], false).unwrap());
        }
        text.push_str(&decode_utf8(&mut buffer, &[], true).unwrap());
        assert_eq!(text, "你好🙂");
    }
    #[test]
    fn rejects_cross_origin_and_traversal() {
        let p = ServiceProfile {
            id: "test".into(),
            name: "".into(),
            base_url: "http://127.0.0.1:8080/v1".into(),
            install_dir: "".into(),
            python_path: "".into(),
            config_path: "".into(),
            managed: false,
        };
        for path in [
            "//evil/health",
            "/../health",
            "/%2e%2e/health",
            "https://evil/health",
        ] {
            assert!(endpoint(&p, path).is_err());
        }
        assert_eq!(
            endpoint(&p, "/health").unwrap().as_str(),
            "http://127.0.0.1:8080/health"
        );
        assert!(endpoint(&p, "/metrics?requests=all").is_ok());
        assert!(endpoint(&p, "/v1/messages/count_tokens").is_ok());
        assert!(endpoint(&p, "/v1/messages/count_tokens?url=https://evil").is_err());
        assert!(endpoint(&p, "/api/requests?id=req-123").is_ok());
        assert!(endpoint(&p, "/metrics?url=https://evil").is_err());
        assert!(endpoint(&p, "/api/requests?id=a&id=b").is_err());
        assert!(endpoint(&p, "/api/requests?id=..%2Fsecret").is_err());
    }
}
