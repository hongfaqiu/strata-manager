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
                _ => false,
            };
        if !valid {
            return Err("该 API 查询参数不受支持".into());
        }
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
    match url.host() {
        Some(url::Host::Ipv4(ip)) if ip.is_loopback() => {}
        Some(url::Host::Ipv6(ip)) if ip.is_loopback() => {}
        Some(url::Host::Domain("localhost")) => {}
        _ => return Err("只允许连接本机 loopback Strata 服务".into()),
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
        "/load" | "/v1/load" | "/v1/vram" => 300,
        _ => 90,
    })
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
    serde_json::from_slice(&bytes).map_err(|e| format!("响应不是有效 JSON: {e}"))
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
        for path in ["/load", "/v1/load", "/v1/vram"] {
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
        assert!(endpoint(&p, "/api/requests?id=req-123").is_ok());
        assert!(endpoint(&p, "/metrics?url=https://evil").is_err());
        assert!(endpoint(&p, "/api/requests?id=a&id=b").is_err());
        assert!(endpoint(&p, "/api/requests?id=..%2Fsecret").is_err());
    }
}
