//! Optional global shortcut that shows or hides the monitor (desktop strip
//! or Windows taskbar widget, whichever the user uses).
//!
//! The default is Ctrl+Alt+M: Alt+A is WeChat's screenshot key and
//! Ctrl+Alt+A is QQ's, so neither is taken over. The user can pick another
//! preset or switch the shortcut off; a key already held by another program
//! is reported in settings instead of failing the save.

use std::str::FromStr;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub(crate) const DEFAULT: &str = "Ctrl+Alt+M";
/// Same list as FLOATING_MONITOR_SHORTCUTS in packages/core; `""` is off.
pub(crate) const PRESETS: [&str; 4] = ["Ctrl+Alt+M", "Ctrl+Alt+K", "Ctrl+Shift+M", ""];
pub(crate) const EVENT: &str = "monitor-shortcut";

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub(crate) struct Status {
    /// Wanted shortcut; empty when switched off.
    pub shortcut: String,
    pub active: bool,
    pub message: String,
}

#[derive(Default)]
pub(crate) struct ShortcutRegistry {
    inner: Mutex<(Option<Shortcut>, Status)>,
}

/// Wanted shortcut from saved settings: missing → default, unknown → default,
/// `""` → off.
pub(crate) fn wanted(settings: &Value) -> &'static str {
    match settings["floatingMonitor"]["shortcut"].as_str() {
        Some(value) => PRESETS
            .iter()
            .find(|preset| **preset == value)
            .copied()
            .unwrap_or(DEFAULT),
        None => DEFAULT,
    }
}

pub(crate) fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                // The main window owns the visibility switch and its saved mode.
                let _ = app.emit_to("main", EVENT, ());
            }
        })
        .build()
}

fn conflict(shortcut: &str, english: bool) -> String {
    if english {
        format!("{shortcut} is already used by another program. Pick another shortcut.")
    } else {
        format!("{shortcut} 已被其他程序占用，请换一个快捷键")
    }
}

/// Registers the saved shortcut, replacing the previous one. Never fails the
/// settings save: problems end up in [`Status::message`].
pub(crate) fn apply<R: Runtime>(app: &AppHandle<R>, settings: &Value, english: bool) {
    let Some(registry) = app.try_state::<ShortcutRegistry>() else {
        return;
    };
    let Ok(mut inner) = registry.inner.lock() else {
        return;
    };
    let wanted = wanted(settings);
    if inner.1.shortcut == wanted && (inner.1.active || wanted.is_empty()) {
        return;
    }
    let global = app.global_shortcut();
    if let Some(previous) = inner.0.take() {
        let _ = global.unregister(previous);
    }
    inner.1 = Status {
        shortcut: wanted.into(),
        ..Status::default()
    };
    if wanted.is_empty() {
        return;
    }
    match Shortcut::from_str(wanted) {
        Ok(shortcut) => match global.register(shortcut) {
            Ok(()) => {
                inner.0 = Some(shortcut);
                inner.1.active = true;
            }
            Err(_) => inner.1.message = conflict(wanted, english),
        },
        Err(error) => inner.1.message = error.to_string(),
    }
}

#[tauri::command]
pub(crate) fn monitor_shortcut_status(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Status, String> {
    if window.label() != "main" {
        return Err("该操作仅允许主窗口调用".into());
    }
    let registry = app.state::<ShortcutRegistry>();
    let inner = registry.inner.lock().map_err(|e| e.to_string())?;
    Ok(inner.1.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_avoids_wechat_and_qq_screenshot_keys() {
        assert_eq!(wanted(&json!({})), DEFAULT);
        assert_eq!(wanted(&json!({"floatingMonitor":{}})), "Ctrl+Alt+M");
        for taken in ["Alt+A", "Ctrl+Alt+A", "Ctrl+Shift+A"] {
            assert!(!PRESETS.contains(&taken));
            assert_eq!(
                wanted(&json!({"floatingMonitor":{"shortcut":taken}})),
                DEFAULT
            );
        }
    }

    #[test]
    fn presets_parse_and_empty_switches_off() {
        assert_eq!(wanted(&json!({"floatingMonitor":{"shortcut":""}})), "");
        assert_eq!(
            wanted(&json!({"floatingMonitor":{"shortcut":"Ctrl+Shift+M"}})),
            "Ctrl+Shift+M"
        );
        assert_eq!(wanted(&json!({"floatingMonitor":{"shortcut":7}})), DEFAULT);
        for preset in PRESETS.iter().filter(|preset| !preset.is_empty()) {
            assert!(Shortcut::from_str(preset).is_ok(), "{preset}");
        }
        assert!(conflict("Ctrl+Alt+M", false).contains("已被其他程序占用"));
    }
}
