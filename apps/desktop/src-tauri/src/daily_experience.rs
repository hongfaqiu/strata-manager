use crate::{ClientState, State};
use serde_json::{json, Value};
use strata_runtime_core::types::ServiceProfile;

#[tauri::command]
pub async fn assess_setup_resources(
    state: State<'_, ClientState>,
    request: Value,
) -> Result<Value, String> {
    state
        .ipc
        .request("assess_setup_resources", json!({"request":request}))
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn benchmark_identity(
    state: State<'_, ClientState>,
    profile: ServiceProfile,
) -> Result<Value, String> {
    state
        .ipc
        .request("benchmark_identity", json!({"profile":profile}))
        .await
        .map_err(|e| e.to_string())
}
