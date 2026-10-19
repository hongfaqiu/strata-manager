//! Headless Strata Manager HTTP surface (axum).
pub mod auth;
pub mod config;
pub mod rpc;

use auth::{AuthError, AuthState};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use config::ServerConfig;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};
use strata_runtime_core::RuntimeState;
use tokio::sync::broadcast;
use tower_http::services::ServeDir;

pub const API_VERSION: &str = "v1";
pub const PRODUCT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone)]
pub struct AppState {
    pub runtime: Arc<RuntimeState>,
    pub auth: AuthState,
    pub bind: SocketAddr,
    pub web_root: Option<PathBuf>,
    pub events: broadcast::Sender<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcRequest {
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcErrorBody>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcErrorBody {
    pub message: String,
}

pub fn build_router(state: AppState) -> Router {
    let mut router = Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/rpc", post(rpc_handler))
        .route("/api/v1/events", get(events_ws))
        .route("/", get(spa_index))
        .route("/index.html", get(spa_index));

    if let Some(root) = state.web_root.clone() {
        router = router.nest_service("/assets", ServeDir::new(root.join("assets")));
        router = router.fallback_service(ServeDir::new(root));
    } else {
        router = router.fallback(get(placeholder_index));
    }

    router.with_state(state)
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "product": "strata-manager-server",
        "version": PRODUCT_VERSION,
        "api": API_VERSION,
        "bind": state.bind.to_string(),
        "loopback": state.bind.ip().is_loopback(),
        "web": state.web_root.is_some(),
    }))
}

fn extract_bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
}

fn auth_reject(err: AuthError) -> Response {
    (
        StatusCode::from_u16(err.status()).unwrap_or(StatusCode::UNAUTHORIZED),
        Json(json!({"ok": false, "error": {"message": err.message()}})),
    )
        .into_response()
}

async fn rpc_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RpcRequest>,
) -> Response {
    if let Err(err) = state.auth.authorize(extract_bearer(&headers)) {
        return auth_reject(err);
    }
    if body.method.is_empty() || body.method.len() > 128 {
        return (
            StatusCode::BAD_REQUEST,
            Json(RpcResponse {
                ok: false,
                result: None,
                error: Some(RpcErrorBody {
                    message: "method is required".into(),
                }),
            }),
        )
            .into_response();
    }
    match rpc::dispatch_command(state.runtime.clone(), &body.method, body.params).await {
        Ok(result) => Json(RpcResponse {
            ok: true,
            result: Some(result),
            error: None,
        })
        .into_response(),
        Err(message) => {
            let status = if message.starts_with("SERVER_UNSUPPORTED") {
                StatusCode::NOT_IMPLEMENTED
            } else if message.starts_with("unknown_method:") {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::UNPROCESSABLE_ENTITY
            };
            (
                status,
                Json(RpcResponse {
                    ok: false,
                    result: None,
                    error: Some(RpcErrorBody { message }),
                }),
            )
                .into_response()
        }
    }
}

async fn events_ws(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    if let Err(err) = state.auth.authorize(extract_bearer(&headers)) {
        let alt = headers
            .get(header::SEC_WEBSOCKET_PROTOCOL)
            .and_then(|v| v.to_str().ok())
            .and_then(|p| {
                p.split(',')
                    .map(str::trim)
                    .find_map(|part| part.strip_prefix("bearer."))
            });
        if let Some(token) = alt {
            if state
                .auth
                .authorize(Some(&format!("Bearer {token}")))
                .is_err()
            {
                return auth_reject(err);
            }
        } else {
            return auth_reject(err);
        }
    }
    ws.on_upgrade(move |socket| events_session(socket, state))
}

async fn events_session(socket: WebSocket, state: AppState) {
    let (mut sink, mut stream) = socket.split();
    let mut rx = state.events.subscribe();
    let runtime = state.runtime.clone();
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    loop {
        tokio::select! {
            _ = tick.tick() => {
                let status = runtime.clone().dispatch("supervisor_status", json!({})).await.ok();
                let payload = json!({"type":"tick","supervisor": status});
                if sink.send(Message::Text(payload.to_string().into())).await.is_err() {
                    break;
                }
            }
            msg = rx.recv() => {
                match msg {
                    Ok(value) => {
                        if sink.send(Message::Text(value.to_string().into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(p))) => {
                        let _ = sink.send(Message::Pong(p)).await;
                    }
                    _ => {}
                }
            }
        }
    }
}

async fn placeholder_index() -> Html<&'static str> {
    Html(
        r#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>Strata Manager Server</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#111;background:#fafafa}
code{background:#eee;padding:.1rem .3rem;border-radius:4px}</style></head><body>
<h1>Strata Manager Server</h1>
<p>API is up. Build the Web UI (<code>pnpm build</code>) and set <code>STRATA_MANAGER_WEB_ROOT</code> to <code>apps/desktop/dist</code>.</p>
<p>Health: <a href="/api/v1/health"><code>/api/v1/health</code></a></p>
</body></html>"#,
    )
}

async fn spa_index(State(state): State<AppState>) -> Response {
    let Some(root) = &state.web_root else {
        return placeholder_index().await.into_response();
    };
    let path = root.join("index.html");
    match tokio::fs::read_to_string(&path).await {
        Ok(html) => {
            let injected = inject_bootstrap(&html, PRODUCT_VERSION);
            (
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                injected,
            )
                .into_response()
        }
        Err(err) => (
            StatusCode::NOT_FOUND,
            format!("index.html missing under web root: {err}"),
        )
            .into_response(),
    }
}

pub fn inject_bootstrap(html: &str, version: &str) -> String {
    let snippet = format!(
        r#"<script>window.__STRATA_MANAGER_SERVER__={{apiBase:"/api/v1",version:{version:?},features:{{pathPicker:true,updater:false,tray:false,floatingMonitor:false}}}};</script>"#
    );
    if let Some(idx) = html.find("</head>") {
        let mut out = String::with_capacity(html.len() + snippet.len());
        out.push_str(&html[..idx]);
        out.push_str(&snippet);
        out.push_str(&html[idx..]);
        out
    } else {
        format!("{snippet}{html}")
    }
}

pub async fn open_runtime(data_dir: PathBuf) -> Result<Arc<RuntimeState>, String> {
    tokio::task::spawn_blocking(move || RuntimeState::open(data_dir))
        .await
        .map_err(|e| e.to_string())?
}

pub async fn bind_listener(
    config: ServerConfig,
) -> Result<(tokio::net::TcpListener, AppState, Option<String>), String> {
    let (auth, fresh_token) =
        AuthState::from_env_or_file(&config.data_dir, config.token_env.clone())?;
    let runtime = open_runtime(config.data_dir.clone()).await?;
    let (events, _) = broadcast::channel(64);
    let state = AppState {
        runtime,
        auth,
        bind: config.bind,
        web_root: config.web_root.clone(),
        events,
    };
    let listener = tokio::net::TcpListener::bind(config.bind)
        .await
        .map_err(|e| format!("bind {}: {e}", config.bind))?;
    Ok((listener, state, fresh_token))
}
