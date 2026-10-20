//! Window boundary for application commands. Plugin commands remain governed
//! by Tauri capabilities before the application invoke handler is reached.
pub(crate) fn with_window_policy<F>(
    handler: F,
) -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static
where
    F: Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static,
{
    move |invoke| {
        if !app_command_allowed(
            invoke.message.webview_ref().window().label(),
            invoke.message.webview_ref().label(),
            invoke.message.command(),
        ) {
            invoke.resolver.reject("该操作不允许从此窗口调用");
            // Rejection resolves this invoke; do not emit a second error.
            return true;
        }
        handler(invoke)
    }
}

pub(crate) fn app_command_allowed(window: &str, webview: &str, command: &str) -> bool {
    match (window, webview) {
        ("main", "main") => true,
        ("service-monitor", "service-monitor") => {
            matches!(
                command,
                "monitor_snapshot"
                    | "show_main_from_monitor"
                    | "move_monitor_to_taskbar"
                    | "resize_monitor_window"
                    | "set_monitor_mode"
                    | "set_monitor_visibility"
                    | "monitor_mode_status"
            )
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Read the real registration list, so adding a future application command
    // automatically extends the deny check. No handler, IPC or service runs.
    fn registered_commands() -> Vec<&'static str> {
        let source = include_str!("lib.rs");
        let (_, registration) = source
            .split_once("tauri::generate_handler![")
            .expect("application command registration is missing");
        let (registration, _) = registration
            .split_once("])")
            .expect("application command registration is incomplete");
        let commands: Vec<_> = registration
            .split(',')
            .map(str::trim)
            .filter(|command| !command.is_empty())
            .map(|command| command.rsplit("::").next().unwrap())
            .collect();
        assert!(
            commands.len() > 2,
            "expected the complete application command list"
        );
        assert!(commands.iter().all(|command| command
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')));
        commands
    }

    #[test]
    fn monitor_can_call_only_allowlisted_registered_application_commands() {
        let commands = registered_commands();
        let mut allowed = Vec::new();
        for command in commands {
            assert!(app_command_allowed("main", "main", command));
            let expected = matches!(
                command,
                "monitor_snapshot"
                    | "show_main_from_monitor"
                    | "move_monitor_to_taskbar"
                    | "resize_monitor_window"
                    | "set_monitor_mode"
                    | "set_monitor_visibility"
                    | "monitor_mode_status"
            );
            assert_eq!(
                app_command_allowed("service-monitor", "service-monitor", command),
                expected,
                "unexpected monitor permission for {command}"
            );
            if expected {
                allowed.push(command);
            }
        }
        allowed.sort_unstable();
        assert_eq!(
            allowed,
            [
                "monitor_mode_status",
                "monitor_snapshot",
                "move_monitor_to_taskbar",
                "resize_monitor_window",
                "set_monitor_mode",
                "set_monitor_visibility",
                "show_main_from_monitor"
            ]
        );
        assert!(!app_command_allowed(
            "service-monitor",
            "service-monitor",
            "future_unregistered_command"
        ));
    }

    #[test]
    fn unknown_windows_and_other_webviews_cannot_reach_application_commands() {
        for (window, webview) in [
            ("unknown", "unknown"),
            ("main-other", "main-other"),
            ("service-monitor-other", "service-monitor-other"),
            ("unknown", "main"),
            ("main", "unknown"),
            ("main", "service-monitor"),
            ("service-monitor", "main"),
            ("service-monitor", "unknown"),
        ] {
            for command in registered_commands() {
                assert!(
                    !app_command_allowed(window, webview, command),
                    "{window}/{webview} unexpectedly admitted {command}"
                );
            }
        }
    }
}
