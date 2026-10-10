use crate::ClientState;
use futures_util::StreamExt;
use serde_json::Value;
use strata_runtime_core::{
    http::{decode_utf8, request_builder},
    types::{ServiceProfile, StreamEvent},
};
use tauri::{ipc::Channel, State};
use tokio_util::sync::CancellationToken;
#[tauri::command]
pub async fn strata_stream(
    state: State<'_, ClientState>,
    profile: ServiceProfile,
    path: String,
    body: Value,
    request_id: String,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    if path != "/v1/chat/completions" && path != "/v1/responses" && path != "/v1/messages" {
        return Err("此路径不支持聊天流".into());
    }
    let profile = state
        .ipc
        .request("resolve_profile", serde_json::json!({"profile":profile}))
        .await
        .map_err(|e| e.to_string())?;
    let profile: ServiceProfile = serde_json::from_value(profile).map_err(|e| e.to_string())?;
    let builder = request_builder(&state.client, &profile, &path, "POST", Some(body))?
        .header("X-Strata-Client", "strata-manager.desktop");
    let token = CancellationToken::new();
    {
        let mut streams = state.streams.lock().map_err(|e| e.to_string())?;
        if streams.contains_key(&request_id) {
            return Err("requestId 已在运行".into());
        }
        streams.insert(request_id.clone(), token.clone());
    }
    let outcome = async {
        let response = tokio::select! { _ = token.cancelled() => return Ok(()), response = builder.send() => response.map_err(|e| e.to_string())? };
        if !response.status().is_success() {
            let status = response.status();
            let mut error_stream = response.bytes_stream();
            let mut bytes = Vec::new();
            while bytes.len() < 8192 {
                let chunk = tokio::select! { _ = token.cancelled() => return Ok(()), chunk = error_stream.next() => chunk };
                let Some(chunk) = chunk else { break };
                let chunk = chunk.map_err(|e|e.to_string())?;
                bytes.extend_from_slice(&chunk[..chunk.len().min(8192-bytes.len())]);
            }
            return Err(format!("HTTP {}: {}",status,String::from_utf8_lossy(&bytes).chars().take(2048).collect::<String>()));
        }
        let mut stream = response.bytes_stream();
        let mut pending = Vec::new();
        loop {
            let chunk = tokio::select! { _ = token.cancelled() => return Ok(()), chunk = stream.next() => chunk };
            let Some(chunk) = chunk else { break; };
            let text = decode_utf8(&mut pending, &chunk.map_err(|e| e.to_string())?, false)?;
            if !text.is_empty() { on_event.send(StreamEvent { kind: "data".into(), data: Some(text) }).map_err(|e| e.to_string())?; }
        }
        let rest = decode_utf8(&mut pending, &[], true)?;
        if !rest.is_empty() { on_event.send(StreamEvent { kind: "data".into(), data: Some(rest) }).map_err(|e| e.to_string())?; }
        Ok::<(), String>(())
    }.await;
    state
        .streams
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&request_id);
    if let Err(error) = &outcome {
        let _ = on_event.send(StreamEvent {
            kind: "error".into(),
            data: Some(error.clone()),
        });
    }
    let _ = on_event.send(StreamEvent {
        kind: "done".into(),
        data: None,
    });
    outcome
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
