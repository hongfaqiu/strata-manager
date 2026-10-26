//! Optional global shortcut that shows or hides the monitor (desktop strip
//! or Windows taskbar widget, whichever the user uses).
//!
//! There is no default: nothing is registered until the user records a
//! combination in settings, and clearing it unregisters it again. A key
//! already held by another program is reported in settings instead of
//! failing the save. Validation matches `checkFloatingMonitorShortcut` in
//! packages/core, so a hand-edited settings file cannot register Alt+A
//! (WeChat screenshot), Ctrl+Alt+A (QQ screenshot) or a bare typing key.

use std::str::FromStr;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub(crate) const EVENT: &str = "monitor-shortcut";

/// Same list as FLOATING_MONITOR_RESERVED_SHORTCUTS in packages/core.
const RESERVED: [&str; 8] = [
    "Alt+A",
    "Ctrl+Alt+A",
    "Alt+Space",
    "Alt+F4",
    "Ctrl+Space",
    "Shift+Space",
    "Ctrl+Shift+Space",
    "Ctrl+F4",
];
const NAMED_KEYS: [&str; 10] = [
    "Space", "Home", "End", "PageUp", "PageDown", "Insert", "Up", "Down", "Left", "Right",
];
const MODIFIERS: [&str; 4] = ["Ctrl", "Alt", "Shift", "Super"];

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub(crate) struct Status {
    /// Wanted shortcut; empty when none is set.
    pub shortcut: String,
    pub active: bool,
    pub message: String,
}

#[derive(Default)]
pub(crate) struct ShortcutRegistry {
    inner: Mutex<(Option<Shortcut>, Status)>,
}

fn key(token: &str) -> Option<String> {
    let lower = token.to_ascii_lowercase();
    let mut chars = token.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_alphanumeric() {
            return Some(c.to_ascii_uppercase().to_string());
        }
    }
    if let Some(n) = lower.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()) {
        if (1..=24).contains(&n) && !lower[1..].starts_with('0') {
            return Some(format!("F{n}"));
        }
    }
    let lower = lower.strip_prefix("arrow").unwrap_or(&lower);
    NAMED_KEYS
        .iter()
        .find(|named| named.to_ascii_lowercase() == lower)
        .map(|named| (*named).to_string())
}

/// Canonical spelling of a usable shortcut, or `None`.
pub(crate) fn canonical(value: &str) -> Option<String> {
    let mut held = [false; 4];
    let mut main = None;
    for token in value.split('+').map(str::trim).filter(|t| !t.is_empty()) {
        let modifier = match token.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => Some(0),
            "alt" | "option" => Some(1),
            "shift" => Some(2),
            "super" | "win" | "meta" | "cmd" | "command" => Some(3),
            _ => None,
        };
        match modifier {
            Some(index) => held[index] = true,
            None if main.is_some() => return None,
            None => main = Some(key(token)?),
        }
    }
    let main = main?;
    let mut parts: Vec<&str> = MODIFIERS
        .iter()
        .zip(held)
        .filter_map(|(name, on)| on.then_some(*name))
        .collect();
    parts.push(&main);
    let shortcut = parts.join("+");
    let strong = held[0] || held[1] || held[3];
    let spare_f = main
        .strip_prefix('F')
        .and_then(|n| n.parse::<u8>().ok())
        .is_some_and(|n| n >= 13);
    if !strong && !spare_f {
        return None;
    }
    let super_only = held == [false, false, false, true];
    if RESERVED.contains(&shortcut.as_str()) || (super_only && (main.len() == 1 || main == "Space"))
    {
        return None;
    }
    Some(shortcut)
}

/// Wanted shortcut from saved settings. Missing, empty, invalid or reserved
/// all mean none — there is no default.
pub(crate) fn wanted(settings: &Value) -> String {
    settings["floatingMonitor"]["shortcut"]
        .as_str()
        .and_then(canonical)
        .unwrap_or_default()
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
    let wanted = wanted.as_str();
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
    fn no_default_for_new_or_upgraded_settings() {
        assert_eq!(wanted(&json!({})), "");
        assert_eq!(wanted(&json!({"floatingMonitor":{}})), "");
        assert_eq!(wanted(&json!({"floatingMonitor":{"layout":"strip"}})), "");
        assert_eq!(wanted(&json!({"floatingMonitor":{"shortcut":""}})), "");
        assert_eq!(wanted(&json!({"floatingMonitor":{"shortcut":7}})), "");
        // Presets picked explicitly before the upgrade stay registered.
        for kept in ["Ctrl+Alt+M", "Ctrl+Alt+K", "Ctrl+Shift+M"] {
            assert_eq!(wanted(&json!({"floatingMonitor":{"shortcut":kept}})), kept);
        }
    }

    #[test]
    fn recorded_shortcuts_are_canonical_and_parse() {
        for (input, expected) in [
            ("shift+ctrl+m", "Ctrl+Shift+M"),
            ("Super+Alt+ArrowUp", "Alt+Super+Up"),
            ("Ctrl+Alt+F9", "Ctrl+Alt+F9"),
            ("F13", "F13"),
            ("Ctrl+Win+Space", "Ctrl+Super+Space"),
            ("Ctrl+Shift+7", "Ctrl+Shift+7"),
            ("Ctrl+Alt+PageDown", "Ctrl+Alt+PageDown"),
        ] {
            assert_eq!(canonical(input).as_deref(), Some(expected), "{input}");
            assert!(Shortcut::from_str(expected).is_ok(), "{expected}");
        }
    }

    #[test]
    fn rejects_typing_screenshot_and_system_keys() {
        for rejected in [
            "M",
            "Shift+M",
            "F5",
            "Alt+A",
            "Ctrl+Alt+A",
            "Alt+F4",
            "Alt+Space",
            "Ctrl+Space",
            "Super+L",
            "Win+D",
            "Super+1",
            "Ctrl+Alt",
            "Ctrl+Alt+M+K",
            "Ctrl+Tab",
            "Ctrl+F25",
            "Ctrl+F0",
            "",
        ] {
            assert_eq!(canonical(rejected), None, "{rejected}");
            assert_eq!(
                wanted(&json!({"floatingMonitor":{"shortcut":rejected}})),
                ""
            );
        }
        assert!(conflict("Ctrl+Alt+M", false).contains("已被其他程序占用"));
    }
}
