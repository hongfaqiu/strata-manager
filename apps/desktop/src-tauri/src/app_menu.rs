//! Native macOS application menu.
//!
//! Without an Edit menu WKWebView never receives Cmd+C / Cmd+V / Cmd+Z, and
//! without an app menu Cmd+Q / Cmd+H / Cmd+M / Cmd+W do nothing. Windows and
//! Linux keep their menu-less custom title bar, so this module only builds on
//! macOS (and in tests, where the labels are checked on every platform).

/// Menu id handled by [`handle_event`]; the tray's own "quit" id stays separate.
pub(crate) const QUIT_ID: &str = "app-menu-quit";

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) struct Labels {
    pub about: String,
    pub services: &'static str,
    pub hide: String,
    pub hide_others: &'static str,
    pub show_all: &'static str,
    pub quit: String,
    pub edit: &'static str,
    pub undo: &'static str,
    pub redo: &'static str,
    pub cut: &'static str,
    pub copy: &'static str,
    pub paste: &'static str,
    pub select_all: &'static str,
    pub view: &'static str,
    pub fullscreen: &'static str,
    pub window: &'static str,
    pub minimize: &'static str,
    pub zoom: &'static str,
    pub close_window: &'static str,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn labels(app_name: &str, english: bool) -> Labels {
    if english {
        Labels {
            about: format!("About {app_name}"),
            services: "Services",
            hide: format!("Hide {app_name}"),
            hide_others: "Hide Others",
            show_all: "Show All",
            quit: format!("Quit {app_name}"),
            edit: "Edit",
            undo: "Undo",
            redo: "Redo",
            cut: "Cut",
            copy: "Copy",
            paste: "Paste",
            select_all: "Select All",
            view: "View",
            fullscreen: "Enter Full Screen",
            window: "Window",
            minimize: "Minimize",
            zoom: "Zoom",
            close_window: "Close Window",
        }
    } else {
        // Wording follows the system's own Simplified Chinese menus.
        Labels {
            about: format!("关于 {app_name}"),
            services: "服务",
            hide: format!("隐藏 {app_name}"),
            hide_others: "隐藏其他",
            show_all: "全部显示",
            quit: format!("退出 {app_name}"),
            edit: "编辑",
            undo: "撤销",
            redo: "重做",
            cut: "剪切",
            copy: "拷贝",
            paste: "粘贴",
            select_all: "全选",
            view: "显示",
            fullscreen: "进入全屏幕",
            window: "窗口",
            minimize: "最小化",
            zoom: "缩放",
            close_window: "关闭窗口",
        }
    }
}

/// Replaces Tauri's English default menu with a localized one.
///
/// Cmd+W uses the predefined "Close Window" item, which sends the normal
/// close request: the main window then follows the background policy (hide
/// to the menu bar icon, or the exit confirmation) exactly like the red
/// traffic light. Cmd+Q is a custom item so it runs the same clean-up as the
/// tray's "Quit" instead of terminating the process directly.
#[cfg(target_os = "macos")]
pub(crate) fn install(app: &tauri::App, english: bool) -> tauri::Result<()> {
    use tauri::menu::{
        AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
        WINDOW_SUBMENU_ID,
    };
    let handle = app.handle();
    let name = handle.package_info().name.clone();
    let text = labels(&name, english);
    let about = AboutMetadata {
        name: Some(name.clone()),
        version: Some(handle.package_info().version.to_string()),
        ..Default::default()
    };
    let quit = MenuItem::with_id(handle, QUIT_ID, &text.quit, true, Some("CmdOrCtrl+Q"))?;
    let app_menu = Submenu::with_items(
        handle,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(handle, Some(&text.about), Some(about))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::services(handle, Some(text.services))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, Some(&text.hide))?,
            &PredefinedMenuItem::hide_others(handle, Some(text.hide_others))?,
            &PredefinedMenuItem::show_all(handle, Some(text.show_all))?,
            &PredefinedMenuItem::separator(handle)?,
            &quit,
        ],
    )?;
    let edit = Submenu::with_items(
        handle,
        text.edit,
        true,
        &[
            &PredefinedMenuItem::undo(handle, Some(text.undo))?,
            &PredefinedMenuItem::redo(handle, Some(text.redo))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, Some(text.cut))?,
            &PredefinedMenuItem::copy(handle, Some(text.copy))?,
            &PredefinedMenuItem::paste(handle, Some(text.paste))?,
            &PredefinedMenuItem::select_all(handle, Some(text.select_all))?,
        ],
    )?;
    let view = Submenu::with_items(
        handle,
        text.view,
        true,
        &[&PredefinedMenuItem::fullscreen(
            handle,
            Some(text.fullscreen),
        )?],
    )?;
    let window = Submenu::with_id_and_items(
        handle,
        WINDOW_SUBMENU_ID,
        text.window,
        true,
        &[
            &PredefinedMenuItem::minimize(handle, Some(text.minimize))?,
            &PredefinedMenuItem::maximize(handle, Some(text.zoom))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::close_window(handle, Some(text.close_window))?,
        ],
    )?;
    // Registered as the Help menu so macOS adds its search field there.
    let help = Submenu::with_id_and_items(
        handle,
        HELP_SUBMENU_ID,
        if english { "Help" } else { "帮助" },
        true,
        &[],
    )?;
    let menu = Menu::with_items(handle, &[&app_menu, &edit, &view, &window, &help])?;
    handle.set_menu(menu)?;
    handle.on_menu_event(|app, event| {
        if event.id.as_ref() == QUIT_ID {
            crate::quit_interface(app);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chinese_menu_uses_system_wording() {
        let text = labels("Strata Manager", false);
        assert_eq!(text.quit, "退出 Strata Manager");
        assert_eq!(text.hide, "隐藏 Strata Manager");
        assert_eq!(text.copy, "拷贝");
        assert_eq!(text.close_window, "关闭窗口");
        assert_eq!(text.edit, "编辑");
    }

    #[test]
    fn english_menu_matches_macos_defaults() {
        let text = labels("Strata Manager", true);
        assert_eq!(text.quit, "Quit Strata Manager");
        assert_eq!(text.paste, "Paste");
        assert_eq!(text.zoom, "Zoom");
        assert_eq!(text.fullscreen, "Enter Full Screen");
    }

    #[test]
    fn quit_id_does_not_collide_with_tray_items() {
        for tray_id in ["show", "quit", "stop-quit", "service-start", "service-stop"] {
            assert_ne!(QUIT_ID, tray_id);
        }
    }
}
