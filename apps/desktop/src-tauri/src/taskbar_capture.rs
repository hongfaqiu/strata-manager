//! Screen-capture overlays and the taskbar host.
//!
//! Win+Shift+S and PrintScreen snipping (and third-party keys such as WeChat
//! Alt+A or QQ Ctrl+Alt+A) put a topmost window over the whole screen while the
//! user picks a region. Explorer's taskbar can change underneath it, and a hit
//! test from our widget lands on the overlay instead of on our child. Neither
//! is a reason to give up on the taskbar: the host keeps its current child and
//! measures again once the overlay is gone, instead of failing and opening
//! the desktop strip.
//!
//! Matching uses the overlay's process executable name plus window traits
//! (topmost and/or covering its monitor), never window titles.
#![cfg_attr(not(windows), allow(dead_code))]

use super::layout::Rect;
use std::time::{Duration, Instant};

/// Built-in Windows capture processes. Their overlay counts when it is topmost
/// or covers its monitor; the normal Snipping Tool app window is neither.
pub(crate) const SYSTEM_CAPTURE: [&str; 3] = [
    // Win10 and early Win11 Win+Shift+S / PrintScreen overlay.
    "screenclippinghost.exe",
    // Win11 Snipping Tool: Win+Shift+S, PrintScreen and its own "New" snip.
    "snippingtool.exe",
    // Win10 Snip & Sketch (Windows.UI.Input.Inking / ScreenSketch).
    "screensketch.exe",
];

/// Third-party screenshot tools. These processes also have ordinary windows,
/// so their overlay must be topmost AND cover the whole monitor.
pub(crate) const APP_CAPTURE: [&str; 7] = [
    "wechat.exe",
    "weixin.exe",
    "qq.exe",
    "tim.exe",
    "snipaste.exe",
    "pixpin.exe",
    "sharex.exe",
];

/// Attach error used when the hit test landed on a capture overlay. The host
/// treats it as "try again later", never as a reason to fall back.
pub(crate) const BUSY: &str = "截图遮罩覆盖任务栏，稍后重新挂载";

/// How long validation stays paused after the overlay was last seen, so the
/// taskbar can settle once the snip is taken or cancelled.
pub(crate) const SETTLE: Duration = Duration::from_millis(1500);

/// `C:\Windows\System32\SnippingTool.exe` → `snippingtool.exe`.
pub(crate) fn executable_name(image_path: &str) -> String {
    image_path
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

fn covers(window: Rect, monitor: Rect) -> bool {
    monitor.width() > 0
        && monitor.height() > 0
        && window.left <= monitor.left
        && window.top <= monitor.top
        && window.right >= monitor.right
        && window.bottom >= monitor.bottom
}

/// Whether a top-level window is a screen-capture overlay.
pub(crate) fn is_capture_overlay(
    image_path: &str,
    topmost: bool,
    window: Rect,
    monitor: Rect,
) -> bool {
    let name = executable_name(image_path);
    let full = covers(window, monitor);
    if SYSTEM_CAPTURE.contains(&name.as_str()) {
        topmost || full
    } else if APP_CAPTURE.contains(&name.as_str()) {
        topmost && full
    } else {
        false
    }
}

/// Keeps validation paused while an overlay is up and for [`SETTLE`] after.
#[derive(Debug, Default)]
pub(crate) struct OverlayGate {
    last_seen: Option<Instant>,
}

impl OverlayGate {
    /// Records the current foreground check; returns true while paused.
    pub fn observe(&mut self, overlay: bool, now: Instant) -> bool {
        if overlay {
            self.last_seen = Some(now);
        }
        self.last_seen
            .is_some_and(|seen| now.saturating_duration_since(seen) < SETTLE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MONITOR: Rect = Rect {
        left: 0,
        top: 0,
        right: 1920,
        bottom: 1080,
    };
    const WINDOW: Rect = Rect {
        left: 200,
        top: 100,
        right: 1400,
        bottom: 900,
    };

    #[test]
    fn executable_name_ignores_folder_and_case() {
        assert_eq!(
            executable_name(r"C:\Windows\System32\ScreenClippingHost.exe"),
            "screenclippinghost.exe"
        );
        assert_eq!(
            executable_name(
                r"C:\Program Files\WindowsApps\Microsoft.ScreenSketch_11.2409.25.0_x64__8wekyb3d8bbwe\SnippingTool\SnippingTool.exe"
            ),
            "snippingtool.exe"
        );
        assert_eq!(executable_name("WeChat.exe"), "wechat.exe");
        assert_eq!(executable_name(""), "");
    }

    #[test]
    fn win_shift_s_overlays_on_win10_and_win11_pause_the_taskbar_host() {
        for path in [
            r"C:\Windows\SystemApps\ShellExperienceHost_cw5n1h2txyewy\ScreenClippingHost.exe",
            r"C:\Windows\System32\ScreenClippingHost.exe",
            r"C:\Program Files\WindowsApps\Microsoft.ScreenSketch_11.2409.25.0_x64__8wekyb3d8bbwe\SnippingTool\SnippingTool.exe",
            r"C:\Program Files\WindowsApps\Microsoft.ScreenSketch_10.2008.3001.0_x64__8wekyb3d8bbwe\ScreenSketch.exe",
        ] {
            // Fullscreen topmost overlay (the usual shape).
            assert!(is_capture_overlay(path, true, MONITOR, MONITOR), "{path}");
            // Spanning every monitor still covers this one.
            let all = Rect {
                left: -1920,
                right: 3840,
                ..MONITOR
            };
            assert!(is_capture_overlay(path, false, all, MONITOR), "{path}");
            // A topmost toolbar-only overlay window counts too.
            assert!(is_capture_overlay(path, true, WINDOW, MONITOR), "{path}");
        }
    }

    #[test]
    fn normal_snipping_tool_window_is_not_an_overlay() {
        let path = r"C:\Program Files\WindowsApps\Microsoft.ScreenSketch_11.2409.25.0_x64__8wekyb3d8bbwe\SnippingTool\SnippingTool.exe";
        assert!(!is_capture_overlay(path, false, WINDOW, MONITOR));
    }

    #[test]
    fn alt_a_style_overlays_need_topmost_and_fullscreen() {
        for path in [
            r"C:\Program Files\Tencent\WeChat\WeChat.exe",
            r"C:\Program Files\Tencent\Weixin\Weixin.exe",
            r"C:\Program Files\Tencent\QQNT\QQ.exe",
            r"D:\Tools\Snipaste\Snipaste.exe",
            r"C:\Program Files\PixPin\PixPin.exe",
        ] {
            assert!(is_capture_overlay(path, true, MONITOR, MONITOR), "{path}");
            // Normal chat windows, maximised or pinned, do not pause anything.
            assert!(!is_capture_overlay(path, false, MONITOR, MONITOR), "{path}");
            assert!(!is_capture_overlay(path, true, WINDOW, MONITOR), "{path}");
        }
    }

    #[test]
    fn real_fullscreen_apps_are_not_capture_overlays() {
        for path in [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Games\game.exe",
            r"C:\Program Files\VideoLAN\VLC\vlc.exe",
            r"C:\Windows\explorer.exe",
            // Names that merely contain a listed one.
            r"C:\Tools\notsnippingtool.exe",
            r"C:\Tools\SnippingTool.exe.bak",
        ] {
            assert!(!is_capture_overlay(path, true, MONITOR, MONITOR), "{path}");
        }
        assert!(!is_capture_overlay("", true, MONITOR, MONITOR));
        // An empty monitor rectangle never counts as covered.
        assert!(!is_capture_overlay(
            "WeChat.exe",
            true,
            MONITOR,
            Rect::default()
        ));
    }

    #[test]
    fn gate_stays_paused_briefly_after_the_overlay_closes() {
        let start = Instant::now();
        let mut gate = OverlayGate::default();
        assert!(!gate.observe(false, start));
        assert!(gate.observe(true, start));
        assert!(gate.observe(false, start + Duration::from_millis(1000)));
        assert!(!gate.observe(false, start + SETTLE));
        // A new snip pauses again.
        assert!(gate.observe(true, start + Duration::from_secs(10)));
        assert!(!gate.observe(false, start + Duration::from_secs(12)));
    }

    #[test]
    fn busy_error_is_not_the_auto_hide_or_fallback_message() {
        assert!(!BUSY.contains("自动隐藏"));
        assert!(!BUSY.contains("保留桌面浮条"));
    }
}
