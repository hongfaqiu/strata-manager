use axum::body::Body;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use strata_manager_server::{
    auth::AuthState, bind_listener, build_router, config::ServerConfig, inject_bootstrap,
};
use tempfile::tempdir;
use tower::ServiceExt;

async fn test_app() -> (strata_manager_server::AppState, String) {
    let dir = tempdir().unwrap();
    let bind = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0));
    let config = ServerConfig::for_test(dir.path().to_path_buf(), bind);
    let (_listener, state, token) = bind_listener(config).await.unwrap();
    let token = token.expect("fresh token");
    std::mem::forget(dir);
    (state, token)
}

#[tokio::test]
async fn health_is_public() {
    let (state, _token) = test_app().await;
    let app = build_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["product"], "strata-manager-server");
    assert_eq!(value["ok"], true);
}

#[tokio::test]
async fn rpc_rejects_missing_and_wrong_token() {
    let (state, token) = test_app().await;
    let app = build_router(state);

    let missing = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/rpc")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"method":"supervisor_status","params":{}}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);

    let wrong = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/rpc")
                .header("content-type", "application/json")
                .header("authorization", "Bearer totally-wrong-token!!")
                .body(Body::from(r#"{"method":"supervisor_status","params":{}}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);

    let ok = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/rpc")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::from(r#"{"method":"supervisor_status","params":{}}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ok.status(), StatusCode::OK);
    let body = ok.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["ok"], true);
}

#[tokio::test]
async fn rpc_maps_desktop_only_commands() {
    let (state, token) = test_app().await;
    let app = build_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/rpc")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::from(
                    r#"{"method":"open_monitor_window","params":{}}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
}

#[tokio::test]
async fn store_roundtrip_via_rpc() {
    let (state, token) = test_app().await;
    let app = build_router(state);
    let set = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/rpc")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::from(
                    json!({"method":"store_set","params":{"key":"settings","value":{"language":"zh-CN","theme":"light"}}}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(set.status(), StatusCode::OK);

    let get = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/rpc")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::from(
                    r#"{"method":"store_get","params":{"key":"settings"}}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get.status(), StatusCode::OK);
    let body = get.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["result"]["theme"], "light");
}

#[test]
fn bootstrap_injection_marks_server_mode() {
    let html = "<html><head><title>x</title></head><body></body></html>";
    let out = inject_bootstrap(html, "0.2.6");
    assert!(out.contains("__STRATA_MANAGER_SERVER__"));
    assert!(out.contains("pathPicker"));
}

#[test]
fn auth_unit_smoke() {
    let dir = tempdir().unwrap();
    let (auth, token) = AuthState::load_or_create(dir.path()).unwrap();
    let token = token.unwrap();
    assert!(auth.authorize(Some(&format!("Bearer {token}"))).is_ok());
}

#[test]
fn default_bind_is_loopback() {
    let addr = strata_manager_server::config::parse_bind("127.0.0.1:8787").unwrap();
    assert!(addr.ip().is_loopback());
    assert_eq!(addr.port(), 8787);
}
