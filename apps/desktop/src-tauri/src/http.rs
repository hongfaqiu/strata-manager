use crate::ClientState;
use futures_util::StreamExt;
use serde_json::Value;
use std::{collections::HashMap, future::Future, sync::Mutex};
use strata_runtime_core::{
    http::{decode_utf8, request_builder},
    types::{ServiceProfile, StreamEvent},
};
use tauri::{ipc::Channel, State};
use tokio_util::sync::CancellationToken;

async fn prepare_profile(
    prepare: impl Future<Output = Result<ServiceProfile, String>> + Send + 'static,
) -> Result<ServiceProfile, String> {
    // Connection recovery can be handing over a supervisor after draining the old
    // process. Cancelling a stream must not abandon that handoff midway. The caller
    // stops awaiting this task immediately; its RPCs retain their admission limits.
    tokio::spawn(prepare)
        .await
        .map_err(|error| error.to_string())?
}

struct StreamRegistration<'a> {
    streams: &'a Mutex<HashMap<String, CancellationToken>>,
    request_id: String,
    token: CancellationToken,
}

impl<'a> StreamRegistration<'a> {
    fn new(
        streams: &'a Mutex<HashMap<String, CancellationToken>>,
        request_id: String,
    ) -> Result<Self, String> {
        let token = CancellationToken::new();
        {
            let mut registered = streams.lock().map_err(|e| e.to_string())?;
            if registered.contains_key(&request_id) {
                return Err("requestId 已在运行".into());
            }
            registered.insert(request_id.clone(), token.clone());
        }
        Ok(Self {
            streams,
            request_id,
            token,
        })
    }
}

impl Drop for StreamRegistration<'_> {
    fn drop(&mut self) {
        self.token.cancel();
        // Cleanup also runs when preparation fails or the command future is dropped.
        self.streams
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.request_id);
    }
}

async fn registered_stream(
    streams: &Mutex<HashMap<String, CancellationToken>>,
    client: &reqwest::Client,
    path: &str,
    body: Value,
    request_id: String,
    prepare: impl Future<Output = Result<ServiceProfile, String>>,
    mut emit: impl FnMut(StreamEvent) -> Result<(), String>,
) -> Result<(), String> {
    if !matches!(
        path,
        "/v1/chat/completions" | "/v1/responses" | "/v1/messages"
    ) {
        return Err("此路径不支持聊天流".into());
    }
    // Register before the first await: cancellation covers queued RPC admission and profile resolution.
    let registration = StreamRegistration::new(streams, request_id)?;
    let token = &registration.token;
    let outcome = async {
        let profile = tokio::select! {
            biased;
            _ = token.cancelled() => return Ok(()),
            profile = prepare => profile?,
        };
        let builder = request_builder(client, &profile, path, "POST", Some(body))?
            .header("X-Strata-Client", "strata-manager.desktop");
        let response = tokio::select! {
            biased;
            _ = token.cancelled() => return Ok(()),
            response = builder.send() => response.map_err(|e| e.to_string())?,
        };
        if !response.status().is_success() {
            let status = response.status();
            let mut error_stream = response.bytes_stream();
            let mut bytes = Vec::new();
            while bytes.len() < 8192 {
                let chunk = tokio::select! {
                    biased;
                    _ = token.cancelled() => return Ok(()),
                    chunk = error_stream.next() => chunk,
                };
                let Some(chunk) = chunk else { break };
                let chunk = chunk.map_err(|e| e.to_string())?;
                bytes.extend_from_slice(&chunk[..chunk.len().min(8192 - bytes.len())]);
            }
            return Err(format!(
                "HTTP {}: {}",
                status,
                String::from_utf8_lossy(&bytes)
                    .chars()
                    .take(2048)
                    .collect::<String>()
            ));
        }
        let mut stream = response.bytes_stream();
        let mut pending = Vec::new();
        loop {
            let chunk = tokio::select! {
                biased;
                _ = token.cancelled() => return Ok(()),
                chunk = stream.next() => chunk,
            };
            let Some(chunk) = chunk else { break };
            let text = decode_utf8(&mut pending, &chunk.map_err(|e| e.to_string())?, false)?;
            if !text.is_empty() {
                emit(StreamEvent {
                    kind: "data".into(),
                    data: Some(text),
                })?;
            }
        }
        let rest = decode_utf8(&mut pending, &[], true)?;
        if !rest.is_empty() {
            emit(StreamEvent {
                kind: "data".into(),
                data: Some(rest),
            })?;
        }
        Ok::<(), String>(())
    }
    .await;
    drop(registration);
    if let Err(error) = &outcome {
        let _ = emit(StreamEvent {
            kind: "error".into(),
            data: Some(error.clone()),
        });
    }
    let _ = emit(StreamEvent {
        kind: "done".into(),
        data: None,
    });
    outcome
}

#[tauri::command]
pub async fn strata_stream(
    state: State<'_, ClientState>,
    profile: ServiceProfile,
    path: String,
    body: Value,
    request_id: String,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let ipc = state.ipc.clone();
    let prepare = prepare_profile(async move {
        let profile = ipc
            .request("resolve_profile", serde_json::json!({"profile":profile}))
            .await
            .map_err(|e| e.to_string())?;
        serde_json::from_value(profile).map_err(|e| e.to_string())
    });
    registered_stream(
        &state.streams,
        &state.client,
        &path,
        body,
        request_id,
        prepare,
        |event| on_event.send(event).map_err(|e| e.to_string()),
    )
    .await
}

#[tauri::command]
pub fn cancel_stream(state: State<'_, ClientState>, request_id: String) -> Result<(), String> {
    if let Some(token) = state
        .streams
        .lock()
        .map_err(|e| e.to_string())?
        .get(&request_id)
    {
        token.cancel();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn profile(base_url: String) -> ServiceProfile {
        ServiceProfile {
            id: uuid::Uuid::new_v4().to_string(),
            name: "stream fixture".into(),
            base_url,
            install_dir: String::new(),
            python_path: String::new(),
            config_path: String::new(),
            managed: true,
        }
    }

    async fn preparing(
        streams: Arc<Mutex<HashMap<String, CancellationToken>>>,
        id: &str,
    ) -> tokio::task::JoinHandle<Result<(), String>> {
        let id = id.to_owned();
        let (started, ready) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            registered_stream(
                &streams,
                &reqwest::Client::new(),
                "/v1/chat/completions",
                Value::Null,
                id,
                async {
                    let _ = started.send(());
                    std::future::pending().await
                },
                |_| Ok(()),
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), ready)
            .await
            .unwrap()
            .unwrap();
        task
    }

    #[tokio::test]
    async fn cancellation_while_preparing_removes_registration() {
        let streams = Arc::new(Mutex::new(HashMap::new()));
        let task = preparing(streams.clone(), "preparing").await;
        streams.lock().unwrap().get("preparing").unwrap().cancel();
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(streams.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancelled_profile_preparation_can_finish_connection_recovery() {
        let streams = Arc::new(Mutex::new(HashMap::new()));
        let (started, ready) = tokio::sync::oneshot::channel();
        let (finished, recovered) = tokio::sync::oneshot::channel();
        let finish_recovery = CancellationToken::new();
        let continue_recovery = finish_recovery.clone();
        let registry = streams.clone();
        let task = tokio::spawn(async move {
            registered_stream(
                &registry,
                &reqwest::Client::new(),
                "/v1/chat/completions",
                Value::Null,
                "recovering".into(),
                prepare_profile(async move {
                    let _ = started.send(());
                    continue_recovery.cancelled().await;
                    let _ = finished.send(());
                    Err("fixture recovery complete".into())
                }),
                |_| Ok(()),
            )
            .await
        });
        ready.await.unwrap();
        streams.lock().unwrap().get("recovering").unwrap().cancel();
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(streams.lock().unwrap().is_empty());
        finish_recovery.cancel();
        tokio::time::timeout(Duration::from_secs(2), recovered)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn duplicate_id_cannot_replace_or_remove_original_registration() {
        let streams = Arc::new(Mutex::new(HashMap::new()));
        let task = preparing(streams.clone(), "duplicate").await;
        let error = registered_stream(
            &streams,
            &reqwest::Client::new(),
            "/v1/chat/completions",
            Value::Null,
            "duplicate".into(),
            async { panic!("duplicate must not prepare") },
            |_| Ok(()),
        )
        .await
        .unwrap_err();
        assert_eq!(error, "requestId 已在运行");
        let original = streams.lock().unwrap().get("duplicate").unwrap().clone();
        assert!(!original.is_cancelled());
        assert_eq!(streams.lock().unwrap().len(), 1);
        original.cancel();
        task.await.unwrap().unwrap();
        assert!(streams.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn dropped_preparation_cleans_registration_and_cancels_token() {
        let streams = Arc::new(Mutex::new(HashMap::new()));
        let task = preparing(streams.clone(), "dropped").await;
        let token = streams.lock().unwrap().get("dropped").unwrap().clone();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(token.is_cancelled());
        assert!(streams.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn preparation_failure_cleans_registration_and_emits_error_then_done() {
        let streams = Mutex::new(HashMap::new());
        let mut events = Vec::new();
        let error = registered_stream(
            &streams,
            &reqwest::Client::new(),
            "/v1/chat/completions",
            Value::Null,
            "failed".into(),
            async { Err("profile unavailable".into()) },
            |event| {
                events.push(event);
                Ok(())
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error, "profile unavailable");
        assert!(streams.lock().unwrap().is_empty());
        assert_eq!(
            events
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            ["error", "done"]
        );
        assert_eq!(events[0].data.as_deref(), Some("profile unavailable"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn limited_preparation_still_allows_32_simultaneous_http_streams() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let connected = Arc::new(AtomicUsize::new(0));
        let release = CancellationToken::new();
        let count_connections = connected.clone();
        let finish = release.clone();
        let server = tokio::spawn(async move {
            let mut responses = tokio::task::JoinSet::new();
            for _ in 0..32 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let connected = count_connections.clone();
                let finish = finish.clone();
                responses.spawn(async move {
                    let mut request = Vec::new();
                    let mut bytes = [0u8; 4096];
                    while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                        let read = socket.read(&mut bytes).await.unwrap();
                        assert_ne!(read, 0);
                        request.extend_from_slice(&bytes[..read]);
                    }
                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n8\r\n: ping\n\n\r\n").await.unwrap();
                    connected.fetch_add(1, Ordering::SeqCst);
                    finish.cancelled().await;
                    socket.write_all(b"0\r\n\r\n").await.unwrap();
                });
            }
            while let Some(response) = responses.join_next().await {
                response.unwrap();
            }
        });
        let streams = Arc::new(Mutex::new(HashMap::new()));
        let metadata = Arc::new(tokio::sync::Semaphore::new(6));
        let client = reqwest::Client::new();
        let mut requests = tokio::task::JoinSet::new();
        for index in 0..32 {
            let streams = streams.clone();
            let metadata = metadata.clone();
            let profile = profile(url.clone());
            let client = client.clone();
            requests.spawn(async move {
                registered_stream(
                    &streams,
                    &client,
                    "/v1/chat/completions",
                    serde_json::json!({}),
                    index.to_string(),
                    async {
                        let _permit = metadata.acquire().await.unwrap();
                        tokio::time::sleep(Duration::from_millis(5)).await;
                        Ok(profile)
                    },
                    |_| Ok(()),
                )
                .await
            });
        }
        tokio::time::timeout(Duration::from_secs(10), async {
            while connected.load(Ordering::SeqCst) < 32 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("metadata permits must be released before awaiting HTTP completion");
        assert_eq!(streams.lock().unwrap().len(), 32);
        assert_eq!(metadata.available_permits(), 6);
        release.cancel();
        while let Some(request) = requests.join_next().await {
            request.unwrap().unwrap();
        }
        server.await.unwrap();
        assert!(streams.lock().unwrap().is_empty());
    }
}
