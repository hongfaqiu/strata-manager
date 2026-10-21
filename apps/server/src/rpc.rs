//! Map Web/Tauri command names onto RuntimeState::dispatch methods.
use serde_json::{json, Value};
use std::sync::Arc;
use strata_runtime_core::RuntimeState;

/// Commands that only make sense inside the Tauri desktop shell.
const DESKTOP_ONLY: &[&str] = &[
    "open_monitor_window",
    "resize_monitor_window",
    "set_monitor_mode",
    "set_monitor_visibility",
    "monitor_mode_status",
    "move_monitor_to_taskbar",
    "monitor_snapshot",
    "show_main_from_monitor",
    "confirm_window_close",
    "restart_interface",
    "arena_status",
    "arena_consent",
    "arena_set_auto_upload",
    "arena_enqueue",
    "arena_flush",
    "arena_withdraw",
    "arena_get",
    "get_startup_status",
    "set_startup_enabled",
    "prepare_app_update",
    "write_png_export",
    "register_html_preview",
    "write_html_preview",
    "validate_vision_files",
    "copy_configuration",
    "delete_configuration",
    "plan_config_cleanup",
    "plan_model_deletion",
    "delete_model_files",
    "connect_running_service",
    "strata_stream",
    "cancel_stream",
];

/// Rename bridge/Tauri invoke names to the supervisor dispatch method.
fn map_method(command: &str) -> Result<&str, String> {
    if DESKTOP_ONLY.contains(&command) {
        return Err(format!(
            "SERVER_UNSUPPORTED: '{command}' is only available in the desktop app"
        ));
    }
    Ok(match command {
        "write_config" => "write_config_cas_v1",
        "read_config_snapshot" => "read_config_snapshot_v1",
        "update_runtime_zip" => "update_runtime_zip_download_v1",
        "test_runtime_zip_download" => "test_runtime_zip_download_v1",
        "resolve_runtime_zip_asset" => "resolve_runtime_zip_asset_v1",
        "apply_settings" => "server_apply_settings", // handled locally
        "get_system_language" => "server_get_system_language",
        "shutdown_supervisor" => "shutdown_supervisor", // rejected below
        other => other,
    })
}

pub async fn dispatch_command(
    state: Arc<RuntimeState>,
    command: &str,
    mut params: Value,
) -> Result<Value, String> {
    let method = map_method(command)?;
    if method == "shutdown_supervisor" {
        return Err("SERVER_UNSUPPORTED: use systemctl stop strata-manager-server".into());
    }
    if method == "server_apply_settings" {
        // Tray / floating monitor preferences are ignored; settings persist via store_set from the UI.
        return Ok(json!(null));
    }
    if method == "server_get_system_language" {
        return Ok(json!({"locales": ["zh-CN", "en"], "installerLanguage": Value::Null}));
    }
    if !params.is_object() {
        params = json!({});
    }
    // snake_case bridge args sometimes use camelCase expectedRevision already.
    state.dispatch(method, params).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_write_config_to_cas() {
        assert_eq!(map_method("write_config").unwrap(), "write_config_cas_v1");
        assert_eq!(map_method("start_service").unwrap(), "start_service");
    }

    #[test]
    fn rejects_tray_and_updater_commands() {
        assert!(map_method("open_monitor_window")
            .unwrap_err()
            .contains("SERVER_UNSUPPORTED"));
        assert!(map_method("prepare_app_update")
            .unwrap_err()
            .contains("SERVER_UNSUPPORTED"));
    }
}
