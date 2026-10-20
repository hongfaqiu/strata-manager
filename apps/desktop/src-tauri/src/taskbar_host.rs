//! This module runs only before Tauri initialization, in --strata-taskbar-host.
//! The only cross-process UI operation is creating our own WS_CHILD under the
//! discovered taskbar. Explorer windows are never moved, resized or reparented.
use super::{
    layout::{vacant_rect, Rect},
    read_frame, widget, write_frame, HostFrame, ParentFrame, Preferences, Sample, SampleHistory,
    TaskbarPlacement,
};
use std::{
    io::BufReader,
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{
            CloseHandle, COLORREF, FILETIME, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM,
        },
        Graphics::Gdi::*,
        System::{
            Com::*,
            LibraryLoader::GetModuleHandleW,
            Threading::{
                GetCurrentProcessId, GetCurrentThreadId, GetProcessTimes, OpenProcess,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::{Accessibility::*, HiDpi::*, WindowsAndMessaging::*},
    },
};

const CLASS: PCWSTR = w!("StrataReadOnlyTaskbarHost");
const WAKE: u32 = WM_APP + 1;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Identity {
    hwnd: usize,
    pid: u32,
    started: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ShellState {
    identity: Identity,
    bar: Rect,
    dpi: u32,
}

fn rect_text(rect: Rect) -> String {
    format!(
        "({},{},{},{})",
        rect.left, rect.top, rect.right, rect.bottom
    )
}

fn shell_difference(expected: ShellState, actual: ShellState) -> Option<String> {
    let mut differences = Vec::new();
    if expected.identity != actual.identity {
        differences.push(format!(
            "identity expected=({},{},{}) actual=({},{},{})",
            expected.identity.hwnd,
            expected.identity.pid,
            expected.identity.started,
            actual.identity.hwnd,
            actual.identity.pid,
            actual.identity.started,
        ));
    }
    if expected.bar != actual.bar {
        differences.push(format!(
            "bar expected={} actual={}",
            rect_text(expected.bar),
            rect_text(actual.bar)
        ));
    }
    if expected.dpi != actual.dpi {
        differences.push(format!(
            "dpi expected={} actual={}",
            expected.dpi, actual.dpi
        ));
    }
    if differences.is_empty() {
        None
    } else {
        Some(differences.join("; "))
    }
}

/// GetWindowRect/ScreenToClient coordinates depend on the calling thread's DPI
/// awareness. Keep the shell context for the complete measurement/create/check
/// transaction, including every error path; never compare across contexts.
struct ThreadDpiContext {
    previous: DPI_AWARENESS_CONTEXT,
    target: DPI_AWARENESS_CONTEXT,
}

impl ThreadDpiContext {
    unsafe fn for_window(hwnd: HWND) -> Result<Self, String> {
        let target = GetWindowDpiAwarenessContext(hwnd);
        if target.0.is_null() {
            return Err("无法读取任务栏 DPI 上下文".into());
        }
        Self::enter(target)
    }

    /// The host process has no DPI manifest (it runs before Tauri sets one),
    /// so anything created outside a guard is bitmap-stretched at 125/150 %.
    unsafe fn per_monitor_v2() -> Result<Self, String> {
        Self::enter(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
    }

    unsafe fn enter(target: DPI_AWARENESS_CONTEXT) -> Result<Self, String> {
        let previous = SetThreadDpiAwarenessContext(target);
        if previous.0.is_null() {
            return Err("无法匹配任务栏 DPI 上下文".into());
        }
        let guard = Self { previous, target };
        guard.verify_current()?;
        Ok(guard)
    }

    unsafe fn verify_current(&self) -> Result<(), String> {
        let current = GetThreadDpiAwarenessContext();
        if AreDpiAwarenessContextsEqual(self.target, current).as_bool() {
            return Ok(());
        }
        Err(format!(
            "DPI 上下文已改变：expected={:#x}/awareness={} actual={:#x}/awareness={}",
            self.target.0 as usize,
            GetAwarenessFromDpiAwarenessContext(self.target).0,
            current.0 as usize,
            GetAwarenessFromDpiAwarenessContext(current).0,
        ))
    }
}

impl Drop for ThreadDpiContext {
    fn drop(&mut self) {
        // The guard is thread-local: its raw context handles are not Send.
        unsafe {
            SetThreadDpiAwarenessContext(self.previous);
        }
    }
}

unsafe fn identity(hwnd: HWND) -> Result<Identity, String> {
    if !IsWindow(Some(hwnd)).as_bool() {
        return Err("任务栏窗口已失效".into());
    }
    let mut pid = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
        .map_err(|_| "无法验证 Explorer 进程身份")?;
    let (mut created, mut exited, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    let result = GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user);
    let _ = CloseHandle(process);
    result.map_err(|_| "无法验证 Explorer 进程创建时间")?;
    Ok(Identity {
        hwnd: hwnd.0 as usize,
        pid,
        started: ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64,
    })
}

unsafe fn shell() -> Result<HWND, String> {
    FindWindowW(w!("Shell_TrayWnd"), None).map_err(|_| "未找到主屏 Windows 任务栏".into())
}
unsafe fn bounds(hwnd: HWND) -> Result<Rect, String> {
    let mut r = RECT::default();
    GetWindowRect(hwnd, &mut r)
        .map_err(|error| format!("无法读取窗口位置 hwnd={:#x}: {error}", hwnd.0 as usize))?;
    Ok(convert(r))
}

unsafe fn shell_state(hwnd: HWND) -> Result<ShellState, String> {
    Ok(ShellState {
        identity: identity(hwnd)?,
        bar: bounds(hwnd)?,
        dpi: GetDpiForWindow(hwnd).max(96),
    })
}
fn convert(r: RECT) -> Rect {
    Rect {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
    }
}
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
fn output(event: &HostFrame) -> bool {
    write_frame(&mut std::io::stdout().lock(), event).is_ok()
}

struct Inspection {
    identity: Identity,
    bar: Rect,
    occupied: Vec<Rect>,
    tray_left: i32,
    dpi: u32,
}

unsafe fn inspect() -> Result<Inspection, String> {
    let hwnd = shell()?;
    let before = identity(hwnd)?;
    let _dpi = ThreadDpiContext::for_window(hwnd)?;
    inspect_with_context(hwnd, before)
}

unsafe fn inspect_with_context(hwnd: HWND, before: Identity) -> Result<Inspection, String> {
    let bar = bounds(hwnd)?;
    let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY);
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !GetMonitorInfoW(monitor, &mut info).as_bool() || info.dwFlags & 1 == 0 {
        return Err("当前仅支持主屏任务栏，无法可靠定位此屏幕".into());
    }
    if bar.width() <= bar.height() || bar.height() < 24 || bar.height() > 180 {
        return Err("此任务栏方向或高度暂不支持".into());
    }
    // Hidden auto-hide taskbars have no reliable visible UIA bounds. Existing
    // children naturally follow Explorer; a fresh attachment waits for visibility.
    if !convert(info.rcMonitor).contains(bar) {
        return Err("任务栏正在自动隐藏，请展开任务栏后重试".into());
    }
    let tray = FindWindowExW(Some(hwnd), None, w!("TrayNotifyWnd"), None)
        .map_err(|_| "无法确认任务栏通知区边界")?;
    let tray_rect = bounds(tray)?;
    if !bar.contains(tray_rect) {
        return Err("通知区矩形无效，拒绝覆盖任务栏".into());
    }
    let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
        .map_err(|_| "UI Automation 不可用，无法确认空闲任务栏区域")?;
    let root = automation
        .ElementFromHandle(hwnd)
        .map_err(|_| "无法读取任务栏辅助功能树")?;
    let condition = automation
        .CreateTrueCondition()
        .map_err(|_| "无法创建任务栏边界查询")?;
    let mut occupied = vec![tray_rect];
    let mut count = 0;
    let mut start_found = false;
    collect_visible(
        &root,
        &condition,
        &mut occupied,
        &mut count,
        &mut start_found,
        0,
    )?;
    if !start_found || count < 3 {
        return Err("任务栏辅助功能树不完整，无法证明宽条区域空闲".into());
    }
    if identity(hwnd)? != before || bounds(hwnd)? != bar {
        return Err("Explorer 在测量期间发生变化，请重试".into());
    }
    Ok(Inspection {
        identity: before,
        bar,
        occupied,
        tray_left: tray_rect.left,
        dpi: GetDpiForWindow(hwnd).max(96),
    })
}

unsafe fn collect_visible(
    element: &IUIAutomationElement,
    condition: &IUIAutomationCondition,
    occupied: &mut Vec<Rect>,
    count: &mut usize,
    start_found: &mut bool,
    depth: usize,
) -> Result<(), String> {
    if depth > 24 || *count > 2048 {
        return Err("任务栏控件数量超出安全边界".into());
    }
    *count += 1;
    let error = |_| "任务栏控件测量失败，无法确认空闲区域".to_owned();
    if element.CurrentProcessId().map_err(error)? == GetCurrentProcessId() as i32 {
        return Ok(());
    }
    if element.CurrentIsOffscreen().map_err(error)?.as_bool() {
        return Ok(());
    }
    let rect = convert(element.CurrentBoundingRectangle().map_err(error)?);
    let class = element.CurrentClassName().map_err(error)?.to_string();
    let id = element.CurrentAutomationId().map_err(error)?.to_string();
    if id == "StartButton" || class == "Start" || class == "StartButton" {
        *start_found = true;
    }
    let children = element
        .FindAll(TreeScope_Children, condition)
        .map_err(error)?;
    let length = children.Length().map_err(error)?;
    if !(0..=2048).contains(&length) {
        return Err("任务栏控件树无效".into());
    }
    let control = element.CurrentControlType().map_err(error)?;
    let actionable = [
        UIA_ButtonControlTypeId,
        UIA_CheckBoxControlTypeId,
        UIA_RadioButtonControlTypeId,
        UIA_ListItemControlTypeId,
        UIA_MenuItemControlTypeId,
        UIA_HyperlinkControlTypeId,
        UIA_EditControlTypeId,
        UIA_SliderControlTypeId,
        UIA_TabItemControlTypeId,
        UIA_ComboBoxControlTypeId,
    ]
    .contains(&control);
    // Include all visible leaf bounds, even unknown/custom controls. Containers
    // can be ignored only after their descendants were successfully enumerated.
    if depth > 0 && (actionable || length == 0) && rect.width() > 0 && rect.height() > 0 {
        occupied.push(rect);
    }
    for index in 0..length {
        collect_visible(
            &children.GetElement(index).map_err(error)?,
            condition,
            occupied,
            count,
            start_found,
            depth + 1,
        )?;
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum Event {
    Wake,
    Timer,
    Theme,
    Menu,
    Rebuild,
    Destroyed(usize),
}
struct Context {
    render: Arc<Mutex<Render>>,
    events: mpsc::SyncSender<Event>,
    taskbar_created: u32,
}
struct Render {
    preferences: Preferences,
    timeline: SampleHistory,
    dpi: u32,
    bar_height: i32,
    /// Taskbar (not app) colour mode.
    dark: bool,
    /// Per-pixel alpha child window; false after a layered attempt failed.
    layered: bool,
    /// Last layout put on screen; equal layouts are not repainted.
    last: Option<widget::Layout>,
}

/// Coalesced input stays bounded even while a Win32 popup runs its modal loop.
#[derive(Default)]
struct Incoming {
    preferences: Option<Preferences>,
    sample: Option<Sample>,
    error: Option<String>,
}

impl Incoming {
    fn store_sample(&mut self, sample: Sample) {
        self.sample = Some(sample);
    }
    fn store_preferences(&mut self, preferences: Preferences) {
        self.preferences = Some(preferences);
    }
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_NCCREATE {
        let create = &*(lparam.0 as *const CREATESTRUCTW);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
    }
    let pointer = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Context;
    if !pointer.is_null() {
        let context = &*pointer;
        if message == context.taskbar_created {
            let _ = context.events.try_send(Event::Rebuild);
            return LRESULT(0);
        }
        match message {
            WM_PAINT => {
                let mut ps = PAINTSTRUCT::default();
                let _ = BeginPaint(hwnd, &mut ps);
                let _ = EndPaint(hwnd, &ps);
                // Layered windows keep their last UpdateLayeredWindow bitmap;
                // the opaque fallback must redraw after being uncovered.
                if let Ok(mut render) = context.render.lock() {
                    if !render.layered {
                        present(hwnd, &mut render, true);
                    }
                }
                return LRESULT(0);
            }
            WM_ERASEBKGND => return LRESULT(1),
            // Clicking the widget must never activate it or steal focus.
            WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
            WM_LBUTTONUP => {
                let _ = output(&HostFrame::Main {});
                return LRESULT(0);
            }
            WM_SETTINGCHANGE | WM_THEMECHANGED | WM_DWMCOLORIZATIONCOLORCHANGED => {
                let _ = context.events.try_send(Event::Theme);
            }
            WM_CONTEXTMENU => {
                let _ = context.events.try_send(Event::Menu);
                return LRESULT(0);
            }
            WM_TIMER => {
                let _ = context.events.try_send(Event::Timer);
                return LRESULT(0);
            }
            WAKE => {
                let _ = context.events.try_send(Event::Wake);
                return LRESULT(0);
            }
            WM_DESTROY => {
                let _ = context.events.try_send(Event::Destroyed(hwnd.0 as usize));
                return LRESULT(0);
            }
            WM_CLOSE => {
                let _ = output(&HostFrame::Close {});
                return LRESULT(0);
            }
            _ => {}
        }
    }
    DefWindowProcW(hwnd, message, wparam, lparam)
}

fn reading(sample: &Sample) -> widget::Reading<'_> {
    widget::Reading {
        generation: sample.values[0],
        prefill: sample.values[1],
        gpu: sample.values[2],
        vram_used: sample.values[3],
        vram_total: sample.vram_total,
        temperature: sample.values[6],
        context_used: sample.context_used,
        context_total: sample.context_total,
        state: &sample.state,
        tone: sample.tone,
    }
}

fn widget_size(preferences: &Preferences, dpi: u32, bar_height: i32) -> (i32, i32) {
    widget::size(&preferences.widget, preferences.english, dpi, bar_height)
}

fn current_layout(render: &Render) -> widget::Layout {
    widget::layout(
        &render.preferences.widget,
        render.preferences.english,
        render.dpi,
        render.bar_height,
        &reading(&render.timeline.current),
        &widget::Palette::new(render.dark),
    )
}

/// Reads the TASKBAR colour mode (not the app mode). Missing value = dark,
/// which is the Windows default for the taskbar on both Win10 and Win11.
fn taskbar_is_dark() -> bool {
    registry_dword(
        "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
        "SystemUsesLightTheme",
    )
    .is_none_or(|light| light == 0)
}

fn registry_dword(key: &str, value: &str) -> Option<u32> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let (key, value) = (wide(key), wide(value));
    let mut data = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut data as *mut u32).cast(),
            &mut size,
        )
    };
    (status == 0).then_some(data)
}

/// Offscreen 32-bit top-down DIB used both as the GDI text mask surface and
/// as the source of UpdateLayeredWindow / the opaque fallback blit.
struct Surface {
    dc: HDC,
    bitmap: HBITMAP,
    old: HGDIOBJ,
    bits: *mut u8,
    width: i32,
    height: i32,
}

impl Surface {
    unsafe fn new(width: i32, height: i32) -> Option<Self> {
        let dc = CreateCompatibleDC(None);
        if dc.0.is_null() {
            return None;
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let bitmap = match CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
            Ok(bitmap) if !bits.is_null() => bitmap,
            _ => {
                let _ = DeleteDC(dc);
                return None;
            }
        };
        let old = SelectObject(dc, bitmap.into());
        Some(Self {
            dc,
            bitmap,
            old,
            bits: bits.cast(),
            width,
            height,
        })
    }

    fn bytes(&mut self) -> &mut [u8] {
        // SAFETY: the DIB section owns width*height*4 bytes until Drop.
        unsafe {
            std::slice::from_raw_parts_mut(self.bits, (self.width * self.height * 4) as usize)
        }
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.old);
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.dc);
        }
    }
}

/// Renders one text operation as a grayscale coverage mask. GDI cannot write
/// alpha, so text is drawn white-on-black and tinted while compositing.
unsafe fn text_mask(surface: &mut Surface, op: &widget::Op, english: bool) -> Option<Vec<u8>> {
    let widget::Op::Text {
        left,
        top,
        right,
        bottom,
        text,
        size,
        weight,
        align,
        bottom_align,
        ..
    } = op
    else {
        return None;
    };
    surface.bytes().fill(0);
    let face = if english {
        w!("Segoe UI")
    } else {
        w!("Microsoft YaHei UI")
    };
    let font = CreateFontW(
        -size,
        0,
        0,
        0,
        *weight,
        0,
        0,
        0,
        DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS,
        CLIP_DEFAULT_PRECIS,
        ANTIALIASED_QUALITY,
        0,
        face,
    );
    let old = SelectObject(surface.dc, font.into());
    SetBkMode(surface.dc, TRANSPARENT);
    SetTextColor(surface.dc, COLORREF(0x00ffffff));
    let mut area = RECT {
        left: *left,
        top: *top,
        right: *right,
        bottom: *bottom,
    };
    let align = match align {
        widget::Align::Left => DT_LEFT,
        widget::Align::Center => DT_CENTER,
        widget::Align::Right => DT_RIGHT,
    };
    // Never pass an empty slice: its dangling pointer is not a Win32 string.
    let mut text: Vec<u16> = if text.is_empty() { " " } else { text }
        .encode_utf16()
        .collect();
    DrawTextW(
        surface.dc,
        &mut text,
        &mut area,
        align
            | if *bottom_align { DT_BOTTOM } else { DT_VCENTER }
            | DT_SINGLELINE
            | DT_END_ELLIPSIS
            | DT_NOPREFIX,
    );
    let _ = GdiFlush();
    SelectObject(surface.dc, old);
    let _ = DeleteObject(font.into());
    Some(
        surface
            .bytes()
            .chunks(4)
            .map(|p| p[0].max(p[1]).max(p[2]))
            .collect(),
    )
}

/// Composes the current layout and puts it on screen. Unchanged layouts are
/// skipped, so a once-per-second snapshot with equal values never repaints.
unsafe fn present(hwnd: HWND, render: &mut Render, force: bool) -> bool {
    let layout = current_layout(render);
    if !force && render.last.as_ref() == Some(&layout) {
        return true;
    }
    let palette = widget::Palette::new(render.dark);
    let background = if render.layered {
        // Alpha 1 is visually transparent yet still hit-testable, so clicks
        // and the WindowFromPhysicalPoint visibility probe keep working.
        widget::Color([0, 0, 0, 1])
    } else {
        palette.opaque_background
    };
    let mut canvas = widget::Canvas::new(layout.width, layout.height, background);
    widget::raster_shapes(&mut canvas, &layout.ops);
    let Some(mut surface) = Surface::new(layout.width, layout.height) else {
        return false;
    };
    for op in &layout.ops {
        if let widget::Op::Text { color, .. } = op {
            if let Some(mask) = text_mask(&mut surface, op, render.preferences.english) {
                canvas.blend_mask(&mask, *color);
            }
        }
    }
    surface.bytes().copy_from_slice(&canvas.pixels);
    let shown = if render.layered {
        let size = SIZE {
            cx: layout.width,
            cy: layout.height,
        };
        let source = POINT::default();
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        UpdateLayeredWindow(
            hwnd,
            None,
            None,
            Some(&size),
            Some(surface.dc),
            Some(&source),
            COLORREF(0),
            Some(&blend),
            ULW_ALPHA,
        )
        .is_ok()
    } else {
        let dc = GetDC(Some(hwnd));
        let ok = !dc.0.is_null()
            && BitBlt(
                dc,
                0,
                0,
                layout.width,
                layout.height,
                Some(surface.dc),
                0,
                0,
                SRCCOPY,
            )
            .is_ok();
        if !dc.0.is_null() {
            ReleaseDC(Some(hwnd), dc);
        }
        ok
    };
    if shown {
        render.last = Some(layout);
    }
    shown
}

/// Undocumented uxtheme ordinals (Win10 1903+) make the popup menu follow the
/// taskbar's light/dark mode. Older builds keep the classic light menu.
unsafe fn menu_theme(owner: HWND, dark: bool) {
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    let build = {
        use windows_sys::Win32::System::Registry::{
            RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ,
        };
        let (key, value) = (
            wide("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"),
            wide("CurrentBuildNumber"),
        );
        let mut data = [0u16; 16];
        let mut size = std::mem::size_of_val(&data) as u32;
        let status = RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            data.as_mut_ptr().cast(),
            &mut size,
        );
        if status != 0 {
            return;
        }
        String::from_utf16_lossy(&data)
            .trim_end_matches('\0')
            .parse::<u32>()
            .unwrap_or(0)
    };
    if build < 18362 {
        return;
    }
    let Ok(module) = LoadLibraryW(w!("uxtheme.dll")) else {
        return;
    };
    type SetPreferredAppMode = unsafe extern "system" fn(i32) -> i32;
    type AllowDarkModeForWindow = unsafe extern "system" fn(HWND, i32) -> i32;
    type FlushMenuThemes = unsafe extern "system" fn();
    let ordinal = |n: usize| windows::core::PCSTR(n as *const u8);
    if let Some(set) = GetProcAddress(module, ordinal(135)) {
        let set: SetPreferredAppMode = std::mem::transmute(set);
        // 2 = ForceDark, 3 = ForceLight.
        set(if dark { 2 } else { 3 });
    }
    if let Some(allow) = GetProcAddress(module, ordinal(133)) {
        let allow: AllowDarkModeForWindow = std::mem::transmute(allow);
        allow(owner, i32::from(dark));
    }
    if let Some(flush) = GetProcAddress(module, ordinal(136)) {
        let flush: FlushMenuThemes = std::mem::transmute(flush);
        flush();
    }
}

unsafe fn build_menu(entries: &[widget::MenuEntry]) -> Result<HMENU, String> {
    let menu = CreatePopupMenu().map_err(|e| e.to_string())?;
    let mut radios = Vec::new();
    for entry in entries {
        match entry {
            widget::MenuEntry::Command { id, label } => {
                let text = wide(label);
                let _ = AppendMenuW(menu, MF_STRING, *id as usize, PCWSTR(text.as_ptr()));
            }
            widget::MenuEntry::Toggle { id, label, checked } => {
                let text = wide(label);
                let flags = MF_STRING | if *checked { MF_CHECKED } else { MF_UNCHECKED };
                let _ = AppendMenuW(menu, flags, *id as usize, PCWSTR(text.as_ptr()));
            }
            widget::MenuEntry::Radio { id, label, checked } => {
                let text = wide(label);
                let _ = AppendMenuW(menu, MF_STRING, *id as usize, PCWSTR(text.as_ptr()));
                radios.push((*id, *checked));
            }
            widget::MenuEntry::Header { label } => {
                let text = wide(label);
                let _ = AppendMenuW(menu, MF_STRING | MF_GRAYED, 0, PCWSTR(text.as_ptr()));
            }
            widget::MenuEntry::Separator => {
                let _ = AppendMenuW(menu, MF_SEPARATOR, 0, None);
            }
            widget::MenuEntry::Submenu { label, entries } => {
                let child = build_menu(entries)?;
                let text = wide(label);
                let _ = AppendMenuW(menu, MF_POPUP, child.0 as usize, PCWSTR(text.as_ptr()));
            }
        }
    }
    if let (Some(first), Some(last)) = (radios.first(), radios.last()) {
        if let Some((checked, _)) = radios.iter().find(|(_, checked)| *checked) {
            let _ = CheckMenuRadioItem(menu, first.0, last.0, *checked, MF_BYCOMMAND.0);
        }
    }
    Ok(menu)
}

/// Hidden top-level window that owns the context menu. Unlike the controller
/// it is not WS_EX_NOACTIVATE, so it can become the foreground window: the
/// menu loop then gets mouse tracking (hover highlight, hover-open submenus)
/// and closes on an outside click. Created per-monitor-v2 DPI aware so the
/// menu is rendered at the monitor's real DPI instead of being stretched.
unsafe fn create_menu_owner(
    instance: windows::Win32::Foundation::HINSTANCE,
) -> Result<HWND, String> {
    let _dpi = ThreadDpiContext::per_monitor_v2()?;
    CreateWindowExW(
        WS_EX_TOOLWINDOW,
        CLASS,
        w!("Strata taskbar menu owner"),
        WS_POPUP,
        0,
        0,
        0,
        0,
        None,
        None,
        Some(instance),
        None,
    )
    .map_err(|e| e.to_string())
}

unsafe fn menu(owner: HWND, render: &Arc<Mutex<Render>>) -> Result<Option<Preferences>, String> {
    let (preferences, temperature, dark) = {
        let view = render.lock().map_err(|_| "监控偏好不可用")?;
        (
            view.preferences.clone(),
            view.timeline.current.values[6].is_some(),
            view.dark,
        )
    };
    let entries = widget::menu(&preferences.widget, preferences.english, temperature);
    let selected = {
        // Build, position and track in the owner's per-monitor-v2 context:
        // crisp text at 125/150 % and physical cursor coordinates.
        let _dpi = ThreadDpiContext::for_window(owner)?;
        menu_theme(owner, dark);
        let menu = build_menu(&entries)?;
        let mut point = POINT::default();
        let _ = GetCursorPos(&mut point);
        // The click on our widget grants this process foreground rights.
        // A foreground owner is what makes the native menu loop highlight
        // on hover, open submenus on hover and close on an outside click.
        // The owner is a hidden tool window: no taskbar button appears.
        let _ = SetForegroundWindow(owner);
        let selected = TrackPopupMenuEx(
            menu,
            (TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_BOTTOMALIGN | TPM_LEFTALIGN).0,
            point.x,
            point.y,
            owner,
            None,
        )
        .0;
        // Documented workaround so the next click after the menu works.
        let _ = PostMessageW(Some(owner), WM_NULL, WPARAM(0), LPARAM(0));
        let _ = DestroyMenu(menu);
        selected
    };
    match widget::apply(&preferences.widget, selected.max(0) as u32) {
        widget::MenuAction::Open => {
            output(&HostFrame::Main {});
        }
        widget::MenuAction::Floating => {
            output(&HostFrame::Floating {});
        }
        widget::MenuAction::Close => {
            output(&HostFrame::Close {});
        }
        widget::MenuAction::Settings => {
            output(&HostFrame::Settings {});
        }
        widget::MenuAction::Colors => {
            output(&HostFrame::Colors {});
        }
        widget::MenuAction::Update(next) => {
            output(&HostFrame::Widget {
                widget: next.clone(),
            });
            let mut preferences = preferences;
            preferences.widget = next;
            return Ok(Some(preferences));
        }
        widget::MenuAction::Nothing => {}
    }
    Ok(None)
}

struct Attachment {
    hwnd: HWND,
    shell: Identity,
    bar: Rect,
    area: Rect,
    dpi: u32,
    /// Windows found by the hit-test probe but missing from UI Automation.
    blockers: Vec<Rect>,
}

/// Free space nearest the notification area. Re-evaluated on every
/// inspection, so tray overflow/clock width changes move the widget.
fn target_area(
    inspection: &Inspection,
    occupied: &[Rect],
    width: i32,
    height: i32,
) -> Option<Rect> {
    let available = Rect {
        right: inspection.tray_left.min(inspection.bar.right),
        ..inspection.bar
    };
    vacant_rect(
        available,
        occupied,
        width,
        height,
        (inspection.dpi / 12) as i32,
    )
}

fn placement(area: Rect, bar: Rect, tray_left: i32, dpi: u32) -> TaskbarPlacement {
    let gap = i64::from(tray_left) - i64::from(area.right);
    if (0..=i64::from(dpi) / 6).contains(&gap) {
        TaskbarPlacement::NotificationLeft
    } else if i64::from(area.left) + i64::from(area.right)
        < i64::from(bar.left) + i64::from(bar.right)
    {
        TaskbarPlacement::LeftSide
    } else {
        TaskbarPlacement::RightSide
    }
}

#[derive(Debug)]
struct VisibilityProbe {
    own: usize,
    total: usize,
    visible_style: bool,
    blockers: Vec<Rect>,
    details: Vec<serde_json::Value>,
}

impl VisibilityProbe {
    fn confirmed(&self) -> bool {
        self.visible_style && self.total > 0 && self.own == self.total
    }
}

// Physical hit testing checks the displayed surface, not just WS_VISIBLE or a
// successful BitBlt. Record classes/rectangles only; never collect window titles.
unsafe fn inspect_visibility(hwnd: HWND, area: Rect, probes: &[(i32, i32)]) -> VisibilityProbe {
    let points: Vec<_> = probes
        .iter()
        .map(|(x, y)| POINT {
            x: area.left + x,
            y: area.top + y,
        })
        .collect();
    let mut result = VisibilityProbe {
        own: 0,
        total: points.len(),
        visible_style: IsWindowVisible(hwnd).as_bool(),
        blockers: Vec::new(),
        details: Vec::new(),
    };
    for point in points {
        let hit = WindowFromPhysicalPoint(point);
        let own = hit == hwnd || IsChild(hwnd, hit).as_bool();
        let mut class = [0u16; 256];
        let length = GetClassNameW(hit, &mut class).max(0) as usize;
        let blocking = if own { None } else { bounds(hit).ok() };
        if own {
            result.own += 1;
        }
        if let Some(rect) = blocking.filter(|rect| rect.width() > 0 && rect.height() > 0) {
            if !result.blockers.contains(&rect) {
                result.blockers.push(rect);
            }
        }
        result.details.push(serde_json::json!({"x":point.x,"y":point.y,"own":own,"hwnd":hit.0 as usize,"class":String::from_utf16_lossy(&class[..length]),"rect":blocking.map(rect_text)}));
    }
    if std::env::var_os("STRATA_MANAGER_TASKBAR_DIAGNOSTICS").is_some() {
        eprintln!(
            "{}",
            serde_json::json!({"taskbarVisibility":{"hwnd":hwnd.0 as usize,"rect":rect_text(area),"visibleStyle":result.visible_style,"confirmed":result.confirmed(),"awareness":GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()).0,"hits":result.details}})
        );
    }
    result
}

unsafe fn attach(
    inspection: &Inspection,
    preferences: &Preferences,
    context: &Context,
    instance: windows::Win32::Foundation::HINSTANCE,
) -> Result<Attachment, String> {
    let (width, height) = widget_size(preferences, inspection.dpi, inspection.bar.height());
    let available = Rect {
        right: inspection.tray_left.min(inspection.bar.right),
        ..inspection.bar
    };
    let mut occupied = inspection.occupied.clone();
    let mut blockers = Vec::new();
    for _ in 0..8 {
        let area = target_area(inspection, &occupied, width, height)
            .ok_or("任务栏没有足够且可确认的空闲空间，请在右键菜单中减少显示内容")?;
        let parent = HWND(inspection.identity.hwnd as *mut _);
        // Switch BEFORE the first bounds comparison and restore only after the
        // final child bounds verification, not immediately after CreateWindowExW.
        let dpi_context = ThreadDpiContext::for_window(parent)?;
        let expected = ShellState {
            identity: inspection.identity,
            bar: inspection.bar,
            dpi: inspection.dpi,
        };
        let actual = shell_state(parent).map_err(|error| format!("挂载前测量失败：{error}"))?;
        if let Some(difference) = shell_difference(expected, actual) {
            return Err(format!(
                "Explorer 或任务栏布局已改变，取消本次挂载 [pre-create: {difference}]"
            ));
        }
        let mut position = POINT {
            x: area.left,
            y: area.top,
        };
        let mapped = ScreenToClient(parent, &mut position).as_bool();
        let layered = context.render.lock().is_ok_and(|r| r.layered);
        let child = if mapped {
            CreateWindowExW(
                WS_EX_NOACTIVATE
                    | WS_EX_TOOLWINDOW
                    | if layered {
                        WS_EX_LAYERED
                    } else {
                        WINDOW_EX_STYLE(0)
                    },
                CLASS,
                w!("Strata 任务栏监控"),
                WS_CHILD | WS_CLIPSIBLINGS,
                position.x,
                position.y,
                width,
                height,
                Some(parent),
                None,
                Some(instance),
                Some(context as *const _ as *const _),
            )
            .map_err(|e| format!("原生子窗口创建失败：{e}"))
        } else {
            Err("任务栏坐标转换失败".into())
        };
        let child = child?;
        let validation = (|| {
            dpi_context.verify_current()?;
            let actual = shell_state(parent).map_err(|error| format!("挂载后测量失败：{error}"))?;
            if let Some(difference) = shell_difference(expected, actual) {
                return Err(format!(
                    "任务栏在挂载期间发生变化 [post-create: {difference}]"
                ));
            }
            let child_rect = bounds(child)?;
            if child_rect != area {
                return Err(format!(
                    "原生子窗口矩形不匹配 [post-create: child expected={} actual={}; dpi={}]",
                    rect_text(area),
                    rect_text(child_rect),
                    actual.dpi
                ));
            }
            Ok(())
        })();
        if let Err(error) = validation {
            let _ = DestroyWindow(child);
            return Err(error);
        }
        if let Ok(mut render) = context.render.lock() {
            render.dpi = inspection.dpi;
            render.bar_height = inspection.bar.height();
            render.last = None;
        }
        // CreateWindowEx places a WS_CHILD at the bottom of its sibling Z-order.
        // Raise only our child, never Explorer or a screen-level topmost overlay.
        if let Err(error) = SetWindowPos(
            child,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOOWNERZORDER | SWP_SHOWWINDOW,
        ) {
            let _ = DestroyWindow(child);
            return Err(format!("任务栏子窗口显示失败：{error}"));
        }
        let (painted, probes) = match context.render.lock() {
            Ok(mut render) => {
                let painted = present(child, &mut render, true);
                (painted, widget::probe_points(&current_layout(&render)))
            }
            Err(_) => (false, Vec::new()),
        };
        if !painted {
            let _ = DestroyWindow(child);
            // Layered child windows need Windows 8+ and a supportedOS manifest
            // entry; retry once with an opaque, theme-coloured surface.
            if let Ok(mut render) = context.render.lock() {
                if render.layered {
                    render.layered = false;
                    continue;
                }
            }
            return Err("任务栏首帧绘制失败".into());
        }
        let visibility = inspect_visibility(child, area, &probes);
        if !visibility.confirmed() {
            let _ = DestroyWindow(child);
            let previous_count = occupied.len();
            for blocker in visibility.blockers {
                if available.overlaps(blocker) && !occupied.contains(&blocker) {
                    occupied.push(blocker);
                    blockers.push(blocker);
                }
            }
            if occupied.len() == previous_count {
                return Err("无法确认任务栏数值条可见，保留桌面浮条".into());
            }
            continue;
        }
        return Ok(Attachment {
            hwnd: child,
            shell: inspection.identity,
            bar: inspection.bar,
            area,
            dpi: inspection.dpi,
            blockers,
        });
    }
    Err("任务栏空位持续被其它窗口遮挡，保留桌面浮条".into())
}

fn within_restart_grace(lost_since: Option<Instant>) -> bool {
    lost_since.is_some_and(|since| since.elapsed() < Duration::from_secs(30))
}

pub(super) fn run() {
    if let Err(message) = unsafe { run_inner() } {
        output(&HostFrame::Failed { message });
    }
}

unsafe fn run_inner() -> Result<(), String> {
    // Input is the only source of samples/configuration. No backend, supervisor,
    // model path, network client or Tauri initializer is reachable from this loop.
    let (initial, initial_rx) = mpsc::sync_channel::<Result<Preferences, String>>(1);
    let incoming = Arc::new(Mutex::new(Incoming::default()));
    let input_slot = incoming.clone();
    let gui_thread = GetCurrentThreadId();
    let mut initial_message = MSG::default();
    let _ = PeekMessageW(&mut initial_message, None, 0, 0, PM_NOREMOVE);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(std::io::stdin());
        let mut initialized = false;
        loop {
            let frame = match read_frame(&mut reader) {
                Ok(Some(frame)) => Ok(frame),
                Ok(None) => Ok(ParentFrame::Shutdown {}),
                Err(error) => Err(error),
            };
            match frame {
                Ok(ParentFrame::Configure { preferences }) if !initialized => {
                    initialized = true;
                    if initial.send(Ok(preferences)).is_err() {
                        break;
                    }
                }
                Ok(ParentFrame::Configure { preferences }) => {
                    if let Ok(mut slot) = input_slot.lock() {
                        slot.store_preferences(preferences);
                    }
                }
                Ok(ParentFrame::Snapshot { sample }) => {
                    if let Ok(mut slot) = input_slot.lock() {
                        slot.store_sample(*sample);
                    }
                }
                Ok(ParentFrame::Shutdown {}) => {
                    let _ = PostThreadMessageW(gui_thread, WM_QUIT, WPARAM(0), LPARAM(0));
                    break;
                }
                Err(error) => {
                    if !initialized {
                        let _ = initial.send(Err(error.clone()));
                    }
                    if let Ok(mut slot) = input_slot.lock() {
                        slot.error = Some(error);
                    }
                    let _ = PostThreadMessageW(gui_thread, WM_QUIT, WPARAM(0), LPARAM(0));
                    break;
                }
            }
        }
    });
    let preferences = match initial_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(preferences)) if preferences.valid() => preferences,
        _ => return Err("未收到有效的任务栏宿主初始化协议".into()),
    };
    let parent = shell()?;
    let controller_dpi = ThreadDpiContext::for_window(parent)?;
    let instance = GetModuleHandleW(None).map_err(|e| e.to_string())?.into();
    let class = WNDCLASSW {
        lpfnWndProc: Some(window_proc),
        hInstance: instance,
        lpszClassName: CLASS,
        ..Default::default()
    };
    if RegisterClassW(&class) == 0 {
        return Err("无法注册原生监控窗口".into());
    }
    let render = Arc::new(Mutex::new(Render {
        preferences,
        timeline: SampleHistory::default(),
        dpi: 96,
        bar_height: 48,
        dark: taskbar_is_dark(),
        layered: true,
        last: None,
    }));
    let (events, events_rx) = mpsc::sync_channel(64);
    let context = Box::new(Context {
        render: render.clone(),
        events,
        taskbar_created: RegisterWindowMessageW(w!("TaskbarCreated")),
    });
    // A hidden TOP-LEVEL tool window receives Explorer broadcasts. HWND_MESSAGE
    // windows do not receive TaskbarCreated and are deliberately not used.
    let controller = CreateWindowExW(
        WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
        CLASS,
        w!("Strata taskbar host controller"),
        WS_OVERLAPPED,
        0,
        0,
        0,
        0,
        None,
        None,
        Some(instance),
        Some(&*context as *const _ as *const _),
    )
    .map_err(|e| e.to_string())?;
    drop(controller_dpi);
    let menu_owner = match create_menu_owner(instance) {
        Ok(hwnd) => hwnd,
        Err(error) => {
            let _ = DestroyWindow(controller);
            return Err(format!("无法创建任务栏菜单窗口：{error}"));
        }
    };
    if SetTimer(Some(controller), 1, 250, None) == 0 {
        let _ = DestroyWindow(menu_owner);
        let _ = DestroyWindow(controller);
        return Err("无法启动任务栏有效性检查".into());
    }
    let (inspect_tx, inspect_rx) = mpsc::sync_channel::<u64>(1);
    let (result_tx, result_rx) = mpsc::sync_channel::<(u64, Result<Inspection, String>)>(1);
    // UIA runs on a separate MTA thread so querying the taskbar cannot deadlock
    // our child window's message pump. A stuck provider expires the host below.
    std::thread::spawn(move || {
        if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
            let _ = result_tx.send((1, Err("无法初始化 UI Automation".into())));
            return;
        }
        while let Ok(generation) = inspect_rx.recv() {
            if result_tx.send((generation, inspect())).is_err() {
                break;
            }
        }
        CoUninitialize();
    });
    let mut attachment: Option<Attachment> = None;
    let mut generation = 1u64;
    let mut pending = Some((generation, Instant::now()));
    let mut last_inspect = Instant::now();
    let mut ready = false;
    // Set while Explorer restarts: inspection errors are tolerated for a while
    // and the widget re-attaches to the new taskbar instead of exiting.
    let mut lost_since: Option<Instant> = None;
    let mut theme_checked = Instant::now();
    let _ = inspect_tx.try_send(generation);
    let mut message = MSG::default();
    let outcome = 'main: loop {
        let got = GetMessageW(&mut message, None, 0, 0).0;
        if got <= 0 {
            break incoming
                .lock()
                .ok()
                .and_then(|mut slot| slot.error.take())
                .map_or(Ok(()), Err);
        }
        let _ = TranslateMessage(&message);
        DispatchMessageW(&message);
        while let Ok(event) = events_rx.try_recv() {
            match event {
                Event::Menu => {
                    // Native menus run a modal loop that pauses validation. The
                    // widget stays visible; geometry is remeasured afterwards.
                    if let Some(prefs) = menu(menu_owner, &render)? {
                        let resized = render.lock().is_ok_and(|view| {
                            widget_size(&view.preferences, view.dpi, view.bar_height)
                                != widget_size(&prefs, view.dpi, view.bar_height)
                        });
                        if let Ok(mut view) = render.lock() {
                            view.preferences = prefs;
                        }
                        if resized {
                            if let Some(old) = attachment.take() {
                                let _ = DestroyWindow(old.hwnd);
                            }
                        } else if let (Some(current), Ok(mut view)) = (&attachment, render.lock()) {
                            present(current.hwnd, &mut view, false);
                        }
                    }
                    generation += 1;
                    let _ = inspect_tx.try_send(generation);
                    pending = Some((generation, Instant::now()));
                }
                Event::Rebuild => {
                    if let Some(old) = attachment.take() {
                        if IsWindow(Some(old.hwnd)).as_bool() {
                            let _ = DestroyWindow(old.hwnd);
                        }
                    }
                    lost_since = Some(Instant::now());
                    generation += 1;
                    let _ = inspect_tx.try_send(generation);
                    pending = Some((generation, Instant::now()));
                }
                Event::Theme | Event::Timer
                    if matches!(event, Event::Theme)
                        || theme_checked.elapsed() >= Duration::from_secs(2) =>
                {
                    theme_checked = Instant::now();
                    let dark = taskbar_is_dark();
                    if let Ok(mut view) = render.lock() {
                        if view.dark != dark {
                            view.dark = dark;
                            if let Some(current) = &attachment {
                                present(current.hwnd, &mut view, false);
                            }
                        }
                    }
                }
                Event::Destroyed(hwnd)
                    if attachment
                        .as_ref()
                        .is_some_and(|a| a.hwnd.0 as usize == hwnd) =>
                {
                    attachment = None;
                    if pending.is_none() {
                        generation += 1;
                        let _ = inspect_tx.try_send(generation);
                        pending = Some((generation, Instant::now()));
                    }
                }
                _ => {}
            }
        }
        let latest = incoming
            .lock()
            .map(|mut slot| std::mem::take(&mut *slot))
            .map_err(|_| "任务栏输入队列不可用")?;
        let frames = latest
            .preferences
            .map(|preferences| ParentFrame::Configure { preferences })
            .into_iter()
            .chain(latest.sample.map(|sample| ParentFrame::Snapshot {
                sample: Box::new(sample),
            }));
        if let Some(error) = latest.error {
            break Err(error);
        }
        for frame in frames {
            match frame {
                ParentFrame::Shutdown {} => break 'main Ok(()),
                ParentFrame::Configure { preferences } => {
                    if !preferences.valid() {
                        break 'main Err("任务栏偏好协议不合法".into());
                    }
                    let changed = render
                        .lock()
                        .map(|view| {
                            widget_size(&view.preferences, view.dpi, view.bar_height)
                                != widget_size(&preferences, view.dpi, view.bar_height)
                        })
                        .unwrap_or(true);
                    if let Ok(mut view) = render.lock() {
                        view.preferences = preferences;
                    }
                    if changed {
                        if let Some(old) = attachment.take() {
                            let _ = DestroyWindow(old.hwnd);
                        }
                    }
                    if let (Some(current), Ok(mut view)) = (&attachment, render.lock()) {
                        present(current.hwnd, &mut view, false);
                    }
                    if pending.is_none() {
                        generation += 1;
                        let _ = inspect_tx.try_send(generation);
                        pending = Some((generation, Instant::now()));
                    }
                }
                ParentFrame::Snapshot { sample } => {
                    if sample.state.len() > 128
                        || sample
                            .values
                            .iter()
                            .flatten()
                            .any(|v| !v.is_finite() || *v < 0.0)
                    {
                        break 'main Err("任务栏采样协议不合法".into());
                    }
                    if let Ok(mut view) = render.lock() {
                        let english = view.preferences.english;
                        view.timeline
                            .accept(*sample, strata_runtime_core::types::now(), english);
                        if let Some(current) = &attachment {
                            present(current.hwnd, &mut view, false);
                        }
                    }
                }
            }
        }
        let expired = render.lock().is_ok_and(|mut view| {
            let english = view.preferences.english;
            view.timeline
                .expire(strata_runtime_core::types::now(), english)
        });
        if expired {
            if let (Some(current), Ok(mut view)) = (&attachment, render.lock()) {
                present(current.hwnd, &mut view, false);
            }
        }
        if let Ok((result_generation, result)) = result_rx.try_recv() {
            if pending.is_none_or(|(active, _)| active != result_generation) {
                continue;
            }
            pending = None;
            last_inspect = Instant::now();
            match result {
                Ok(inspection) => {
                    let preferences = render
                        .lock()
                        .map_err(|_| "监控偏好不可用")?
                        .preferences
                        .clone();
                    let (width, height) =
                        widget_size(&preferences, inspection.dpi, inspection.bar.height());
                    let reusable = attachment.as_ref().is_some_and(|a| {
                        let mut occupied = inspection.occupied.clone();
                        occupied.extend(a.blockers.iter().copied());
                        a.shell == inspection.identity
                            && a.bar == inspection.bar
                            && a.dpi == inspection.dpi
                            && !inspection.occupied.iter().any(|r| r.overlaps(a.area))
                            // The tray/clock grew or shrank: follow it.
                            && target_area(&inspection, &occupied, width, height) == Some(a.area)
                    });
                    if reusable && std::env::var_os("STRATA_MANAGER_TASKBAR_DIAGNOSTICS").is_some()
                    {
                        if let Some(current) = &attachment {
                            let _dpi =
                                ThreadDpiContext::for_window(HWND(current.shell.hwnd as *mut _))?;
                            let probes = render
                                .lock()
                                .map(|view| widget::probe_points(&current_layout(&view)))
                                .unwrap_or_default();
                            inspect_visibility(current.hwnd, current.area, &probes);
                        }
                    }
                    if !reusable {
                        if let Some(old) = attachment.take() {
                            let _ = DestroyWindow(old.hwnd);
                        }
                        match attach(&inspection, &preferences, &context, instance) {
                            Ok(new) => {
                                attachment = Some(new);
                                lost_since = None;
                            }
                            Err(_) if within_restart_grace(lost_since) => {}
                            Err(error) => break 'main Err(error),
                        }
                    }
                    if !ready || !reusable {
                        let location = attachment.as_ref().map(|current| {
                            placement(
                                current.area,
                                inspection.bar,
                                inspection.tray_left,
                                inspection.dpi,
                            )
                        });
                        if !output(&HostFrame::Ready {
                            placement: location,
                        }) {
                            break 'main Ok(());
                        }
                        ready = true;
                    }
                }
                Err(error) if error.contains("自动隐藏") && attachment.is_some() => {}
                Err(_) if within_restart_grace(lost_since) => {}
                Err(error) => break 'main Err(error),
            }
        }
        if pending.is_some_and(|(_, since)| since.elapsed() > Duration::from_secs(3)) {
            break Err("任务栏 UI Automation 检查超时，已停止挂载".into());
        }
        if let Some(current) = &attachment {
            if shell().and_then(|hwnd| identity(hwnd)).ok() != Some(current.shell) {
                // Explorer restarted: our child died with the old taskbar.
                // Wait for the new one (TaskbarCreated also triggers this).
                if let Some(old) = attachment.take() {
                    if IsWindow(Some(old.hwnd)).as_bool() {
                        let _ = DestroyWindow(old.hwnd);
                    }
                }
                lost_since = Some(Instant::now());
            }
        }
        if lost_since.is_some() && !within_restart_grace(lost_since) && attachment.is_none() {
            break Err("Explorer 重启后 30 秒内未能重新挂载任务栏监控".into());
        }
        if pending.is_none() && last_inspect.elapsed() >= Duration::from_millis(750) {
            generation += 1;
            let _ = inspect_tx.try_send(generation);
            pending = Some((generation, Instant::now()));
        }
    };
    if let Some(old) = attachment {
        if IsWindow(Some(old.hwnd)).as_bool() {
            let _ = DestroyWindow(old.hwnd);
        }
    }
    let _ = KillTimer(Some(controller), 1);
    let _ = DestroyWindow(menu_owner);
    let _ = DestroyWindow(controller);
    // No Explorer rectangle restoration is needed: none was ever modified.
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paint_success_and_visible_style_do_not_accept_occluded_surfaces() {
        let mut probe = VisibilityProbe {
            own: 3,
            total: 5,
            visible_style: true,
            blockers: vec![],
            details: vec![],
        };
        assert!(!probe.confirmed());
        probe.own = 5;
        assert!(probe.confirmed());
        probe.visible_style = false;
        assert!(!probe.confirmed());
        probe.visible_style = true;
        probe.own = 0;
        probe.total = 0;
        assert!(!probe.confirmed());
    }
    #[test]
    fn attachment_diagnostics_identify_each_changed_component() {
        let expected = ShellState {
            identity: Identity {
                hwnd: 123,
                pid: 90,
                started: 1000,
            },
            bar: Rect {
                left: 0,
                top: 1392,
                right: 2560,
                bottom: 1440,
            },
            dpi: 144,
        };
        assert!(shell_difference(expected, expected).is_none());
        let actual = ShellState {
            bar: Rect {
                left: 0,
                top: 928,
                right: 1707,
                bottom: 960,
            },
            ..expected
        };
        let geometry = shell_difference(expected, actual).unwrap();
        assert!(geometry.contains("bar expected=(0,1392,2560,1440) actual=(0,928,1707,960)"));
        assert!(!geometry.contains("identity") && !geometry.contains("dpi"));
        let actual = ShellState {
            identity: Identity {
                pid: 91,
                ..expected.identity
            },
            dpi: 192,
            ..expected
        };
        let process = shell_difference(expected, actual).unwrap();
        assert!(process.contains("identity expected=(123,90,1000) actual=(123,91,1000)"));
        assert!(process.contains("dpi expected=144 actual=192"));
        assert!(!process.contains("bar"));
    }
    #[test]
    fn shell_identity_detects_reused_handle_or_pid() {
        let before = Identity {
            hwnd: 123,
            pid: 90,
            started: 1000,
        };
        assert_ne!(before, Identity { pid: 91, ..before });
        assert_ne!(
            before,
            Identity {
                started: 2000,
                ..before
            }
        );
        assert_ne!(
            before,
            Identity {
                hwnd: 124,
                ..before
            }
        );
    }
    #[test]
    fn restart_grace_is_bounded() {
        assert!(!within_restart_grace(None));
        assert!(within_restart_grace(Some(Instant::now())));
        assert!(!within_restart_grace(
            Instant::now().checked_sub(Duration::from_secs(31))
        ));
    }

    #[test]
    fn modal_menu_input_coalesces_without_losing_latest_sample_or_preferences() {
        let mut incoming = Incoming::default();
        for counter in 0..10000 {
            let mut values = [None; 11];
            values[0] = Some(counter as f64);
            incoming.store_sample(Sample {
                state: "Generating".into(),
                values,
                ..Sample::default()
            });
            incoming.store_preferences(Preferences::normalize(
                &serde_json::json!({"fontSize": 12 + counter % 13}),
            ));
        }
        assert_eq!(incoming.sample.unwrap().values[0], Some(9999.));
        assert_eq!(incoming.preferences.unwrap().font_size, 12 + 9999 % 13);
    }
}
