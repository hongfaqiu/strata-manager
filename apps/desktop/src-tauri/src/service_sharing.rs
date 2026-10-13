use crate::ClientState;
use serde_json::{json, Value};
use strata_runtime_core::{service_sharing::SetServiceAuthRequest, types::ServiceProfile};

fn validate_request(request: &Value) -> Result<(), String> {
    serde_json::from_value::<SetServiceAuthRequest>(request.clone())
        .map(|_| ())
        .map_err(|_| "SHARING_OPTIONS_INVALID: 局域网设置参数无效".into())
}

#[tauri::command]
pub async fn service_sharing_status(
    state: tauri::State<'_, ClientState>,
    profile: ServiceProfile,
) -> Result<Value, String> {
    state
        .ipc
        .request("service_sharing_status", json!({"profile":profile}))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn set_service_auth(
    state: tauri::State<'_, ClientState>,
    profile: ServiceProfile,
    request: Value,
) -> Result<Value, String> {
    // Validate the exact request shape without printing or formatting the new key.
    validate_request(&request)?;
    state
        .ipc
        .request(
            "set_service_auth",
            json!({"profile":profile,"request":request}),
        )
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_renderer_arguments_never_echo_key_material() {
        let valid = json!({"expectedRevision":"a".repeat(64),"host":"0.0.0.0","port":18081,"keyAction":"set","serverKey":"private-value"});
        assert!(validate_request(&valid).is_ok());
        for invalid in [
            json!({"host":"0.0.0.0","port":18081,"serverKey":"private-value"}),
            json!({"expectedRevision":"a".repeat(64),"host":"0.0.0.0","port":65536,"keyAction":"set","serverKey":"private-value"}),
            json!({"expectedRevision":"a".repeat(64),"host":"0.0.0.0","port":18081,"keyAction":"keep","private-value":"invalid-field"}),
        ] {
            let error = validate_request(&invalid).unwrap_err();
            assert!(!error.contains("private-value"));
            assert!(!error.contains("invalid-field"));
        }
    }
}
