//! Subclass only our floating monitor, on its owning UI thread. Drag proposals
//! are constrained before Windows applies them; no Moved -> set_position loop.
use super::{snap_drag_rect, DragState, MonitorArea, WindowRect};
use std::{cell::RefCell, collections::HashMap};
use tauri::WebviewWindow;
use windows::Win32::{
    Foundation::{HWND, POINT, RECT},
    Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MonitorFromRect, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    },
    UI::{
        HiDpi::GetDpiForWindow,
        WindowsAndMessaging::{
            GetPhysicalCursorPos, GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER,
            SWP_NOZORDER, WM_CANCELMODE, WM_CAPTURECHANGED, WM_DPICHANGED, WM_ENTERSIZEMOVE,
            WM_EXITSIZEMOVE, WM_MOVING, WM_NCDESTROY,
        },
    },
};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};

const SUBCLASS_ID: usize = 0x5354_4d44;

thread_local! {
    // All access is on the HWND's UI thread. Never retain a RefCell borrow
    // across a Win32 call, which may synchronously reenter this callback.
    static STATES: RefCell<HashMap<usize, DragState>> = RefCell::new(HashMap::new());
}

pub(super) async fn install(
    window: &WebviewWindow,
    snap_to_edge: Option<bool>,
) -> Result<(), String> {
    let owned = window.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            let result = owned
                .hwnd()
                .map_err(|error| error.to_string())
                .and_then(|hwnd| {
                    // No heap pointer or borrowed context is retained in dwRefData.
                    // Reinstalling this callback/ID pair is intentionally idempotent.
                    if unsafe { SetWindowSubclass(hwnd.0, Some(window_proc), SUBCLASS_ID, 0) } != 0
                    {
                        STATES.with(|states| {
                            let mut states = states.borrow_mut();
                            let state = states.entry(hwnd.0 as usize).or_default();
                            if let Some(enabled) = snap_to_edge {
                                state.snap_to_edge = enabled;
                            }
                        });
                        Ok(())
                    } else {
                        Err("无法启用浮条屏幕边界保护".into())
                    }
                });
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "浮条屏幕边界保护初始化已中断".to_owned())?
}

fn window_rect(rect: RECT) -> Option<WindowRect> {
    Some(WindowRect {
        x: rect.left,
        y: rect.top,
        width: u32::try_from(i64::from(rect.right) - i64::from(rect.left)).ok()?,
        height: u32::try_from(i64::from(rect.bottom) - i64::from(rect.top)).ok()?,
    })
}

unsafe fn target_area(
    hwnd: HWND,
    rect: RECT,
    cursor_target: bool,
    dpi: Option<u32>,
) -> Option<MonitorArea> {
    let mut cursor = POINT::default();
    let target = if cursor_target && GetPhysicalCursorPos(&mut cursor).is_ok() {
        // Selecting by cursor lets a fully constrained window cross screens.
        // Selecting by the current HWND here would trap it on its old monitor.
        MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST)
    } else {
        MonitorFromRect(&rect, MONITOR_DEFAULTTONEAREST)
    };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !GetMonitorInfoW(target, &mut info).as_bool() {
        return None;
    }
    let work = window_rect(info.rcWork)?;
    // Use the window's effective DPI (or the pending WM_DPICHANGED DPI), rather
    // than a system-DPI-virtualized monitor query on this per-monitor UI thread.
    let scale = f64::from(dpi.unwrap_or_else(|| GetDpiForWindow(hwnd)).max(96)) / 96.0;
    Some(MonitorArea {
        x: work.x,
        y: work.y,
        width: work.width,
        height: work.height,
        scale,
    })
}

fn native_rect(rect: WindowRect) -> Option<RECT> {
    Some(RECT {
        left: rect.x,
        top: rect.y,
        right: i32::try_from(i64::from(rect.x) + i64::from(rect.width)).ok()?,
        bottom: i32::try_from(i64::from(rect.y) + i64::from(rect.height)).ok()?,
    })
}

fn constrained(area: &MonitorArea, rect: RECT, snap_to_edge: bool) -> Option<RECT> {
    native_rect(snap_drag_rect(area, window_rect(rect)?, snap_to_edge)?)
}

unsafe fn capture_origin(hwnd: HWND) -> Option<((i32, i32), WindowRect)> {
    let mut cursor = POINT::default();
    let mut rect = RECT::default();
    GetPhysicalCursorPos(&mut cursor).ok()?;
    GetWindowRect(hwnd, &mut rect).ok()?;
    Some(((cursor.x, cursor.y), window_rect(rect)?))
}

fn snap_enabled(hwnd: HWND) -> bool {
    STATES.with(|states| {
        states
            .borrow()
            .get(&(hwnd.0 as usize))
            .is_some_and(|state| state.snap_to_edge)
    })
}

unsafe fn correct_current(hwnd: HWND, area: &MonitorArea, snap_to_edge: bool) {
    let mut current = RECT::default();
    if GetWindowRect(hwnd, &mut current).is_err() {
        return;
    }
    let Some(fitted) = constrained(area, current, snap_to_edge) else {
        return;
    };
    if current != fitted {
        // These position messages are not intercepted; correction cannot
        // recurse into a Moved/set_position feedback loop.
        let _ = SetWindowPos(
            hwnd,
            None,
            fitted.left,
            fitted.top,
            fitted.right - fitted.left,
            fitted.bottom - fitted.top,
            SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER,
        );
    }
}

unsafe extern "system" fn window_proc(
    hwnd: windows_sys::Win32::Foundation::HWND,
    message: u32,
    wparam: usize,
    lparam: isize,
    subclass_id: usize,
    _reference: usize,
) -> isize {
    match message {
        WM_ENTERSIZEMOVE => {
            let origin = capture_origin(HWND(hwnd));
            STATES.with(|states| {
                if let Some(state) = states.borrow_mut().get_mut(&(hwnd as usize)) {
                    state.finish();
                    if let Some((cursor, rect)) = origin {
                        state.begin(cursor, rect);
                    }
                }
            });
        }
        WM_MOVING if lparam != 0 => {
            let _ = DefSubclassProc(hwnd, message, wparam, lparam);
            let rect = &mut *(lparam as *mut RECT);
            let origin = capture_origin(HWND(hwnd));
            let proposed = window_rect(*rect);
            let candidate = STATES
                .with(|states| {
                    let mut states = states.borrow_mut();
                    let state = states.get_mut(&(hwnd as usize))?;
                    let proposed = proposed?;
                    let Some((cursor, actual)) = origin else {
                        return Some(proposed);
                    };
                    // A missing initial cursor sample is recoverable; importantly,
                    // ordinary WM_MOVING frames never reset a valid origin.
                    if state.origin.is_none() {
                        state.begin(cursor, actual);
                    }
                    Some(state.candidate(cursor, proposed))
                })
                .and_then(native_rect)
                .unwrap_or(*rect);
            if let Some(fitted) = target_area(HWND(hwnd), candidate, true, None)
                .and_then(|area| constrained(&area, candidate, snap_enabled(HWND(hwnd))))
            {
                *rect = fitted;
                return 1;
            }
            return 0;
        }
        WM_DPICHANGED if lparam != 0 => {
            // Tao recomputes its own size after reading the suggestion. Let it
            // update its DPI state, then constrain the actual resulting size
            // against the same destination work area (not a monitor selected
            // from an oversized intermediate rectangle).
            let rect = &mut *(lparam as *mut RECT);
            let area = target_area(HWND(hwnd), *rect, false, Some((wparam & 0xffff) as u32));
            let snap = snap_enabled(HWND(hwnd));
            if let Some(fitted) = area
                .as_ref()
                .and_then(|area| constrained(area, *rect, snap))
            {
                *rect = fitted;
            }
            let result = DefSubclassProc(hwnd, message, wparam, lparam);
            if let Some(area) = area {
                correct_current(HWND(hwnd), &area, snap);
            }
            let origin = capture_origin(HWND(hwnd));
            STATES.with(|states| {
                if let Some(state) = states.borrow_mut().get_mut(&(hwnd as usize)) {
                    if let Some((cursor, rect)) = origin {
                        state.rebase(cursor, rect);
                    } else {
                        state.finish();
                    }
                }
            });
            return result;
        }
        WM_EXITSIZEMOVE => {
            STATES.with(|states| {
                if let Some(state) = states.borrow_mut().get_mut(&(hwnd as usize)) {
                    state.finish();
                }
            });
            let result = DefSubclassProc(hwnd, message, wparam, lparam);
            let mut current = RECT::default();
            if GetWindowRect(HWND(hwnd), &mut current).is_ok() {
                // An Escape-cancelled move may restore the old rectangle while
                // the pointer remains on another display. Preserve that drop
                // result instead of moving the window to the pointer again.
                if let Some(area) = target_area(HWND(hwnd), current, false, None) {
                    correct_current(HWND(hwnd), &area, snap_enabled(HWND(hwnd)));
                }
            }
            return result;
        }
        WM_CANCELMODE | WM_CAPTURECHANGED => {
            STATES.with(|states| {
                if let Some(state) = states.borrow_mut().get_mut(&(hwnd as usize)) {
                    state.finish();
                }
            });
        }
        WM_NCDESTROY => {
            // Remove on the same UI thread before continuing teardown. There
            // is no callback-owned allocation whose lifetime can outlive HWND.
            STATES.with(|states| {
                states.borrow_mut().remove(&(hwnd as usize));
            });
            let _ = RemoveWindowSubclass(hwnd, Some(window_proc), subclass_id);
        }
        _ => {}
    }
    DefSubclassProc(hwnd, message, wparam, lparam)
}
