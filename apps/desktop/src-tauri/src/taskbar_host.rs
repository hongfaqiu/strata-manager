//! This module runs only before Tauri initialization, in --strata-taskbar-host.
//! The only cross-process UI operation is creating our own WS_CHILD under the
//! discovered taskbar. Explorer windows are never moved, resized or reparented.
use super::{
    layout::{graph_points, vacant_rect, Rect},
    read_frame, write_frame, HostFrame, ParentFrame, Preferences, Sample, SampleHistory,
    TaskbarPlacement, METRICS,
};
use std::{
    collections::VecDeque,
    io::BufReader,
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{CloseHandle, COLORREF, FILETIME, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
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
const LABELS: [&str; 11] = [
    "生成",
    "读取",
    "GPU",
    "显存",
    "CPU",
    "内存",
    "温度",
    "功耗",
    "运行",
    "排队",
    "近缓存",
];
const LABELS_EN: [&str; 11] = [
    "Gen ",
    "Read ",
    "GPU ",
    "VRAM ",
    "CPU ",
    "RAM ",
    "Temp ",
    "Power ",
    "Run ",
    "Queue ",
    "Last cache ",
];
const UNITS: [&str; 11] = ["t/s", "t/s", "%", "G", "%", "G", "°C", "W", "", "", "%"];

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
    painted: bool,
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
                if let Ok(mut render) = context.render.lock() {
                    render.painted = paint(hwnd, &render);
                }
                return LRESULT(0);
            }
            WM_ERASEBKGND => return LRESULT(1),
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

fn column_widths(preferences: &Preferences, dpi: u32) -> Vec<i32> {
    let rows = if preferences.layout == "compact" {
        1
    } else {
        2
    };
    let mut columns = vec![0; preferences.metrics.len().div_ceil(rows).max(1)];
    let font = f64::from(preferences.font_size);
    let scale = f64::from(dpi) / 96.0;
    for (position, metric) in preferences.metrics.iter().enumerate() {
        let Some(index) = METRICS.iter().position(|id| id == metric) else {
            continue;
        };
        let digits = match index {
            0 | 1 => 6.,
            2 | 4 | 6 | 10 => 3.,
            3 | 5 => 5.,
            _ => 4.,
        };
        let measure = |text: &str| {
            text.chars()
                .map(|c| if c.is_ascii() { 0.6 } else { 1. })
                .sum::<f64>()
                * font
        };
        let label = if preferences.show_labels {
            measure(if preferences.english {
                LABELS_EN[index]
            } else {
                LABELS[index]
            })
        } else {
            0.
        };
        let unit = if preferences.show_units {
            measure(UNITS[index])
        } else {
            0.
        };
        let graph = if preferences.show_graphs { 26. } else { 0. };
        let width = ((label + digits * font * 0.58 + unit + graph + 8.) * scale).ceil() as i32;
        let column = position / rows;
        columns[column] = columns[column].max(width);
    }
    columns
}

fn dimensions(preferences: &Preferences, dpi: u32) -> (i32, i32, usize) {
    let rows = if preferences.layout == "compact" {
        1
    } else {
        2
    };
    let scale = f64::from(dpi) / 96.0;
    let width = column_widths(preferences, dpi).iter().sum::<i32>() + 8;
    let height = ((preferences.font_size + 4) as f64 * rows as f64 * scale).ceil() as i32 + 4;
    (width, height, rows)
}

fn metric_text(index: usize, number: f64) -> String {
    if number >= 1e12 {
        return format!("{number:.0e}");
    }
    if number >= 999.95 {
        let (scale, suffix) = if number >= 999_950_000. {
            (1e9, "G")
        } else if number >= 999_950. {
            (1e6, "M")
        } else {
            (1e3, "k")
        };
        return format!("{:.1}{suffix}", number / scale);
    }
    if matches!(index, 0 | 1 | 3 | 5) {
        format!("{number:.1}")
    } else {
        format!("{number:.0}")
    }
}

unsafe fn paint(hwnd: HWND, render: &Render) -> bool {
    let mut ps = PAINTSTRUCT::default();
    let dc = BeginPaint(hwnd, &mut ps);
    if dc.0.is_null() {
        return false;
    }
    let mut rect = RECT::default();
    if GetClientRect(hwnd, &mut rect).is_err() {
        let _ = EndPaint(hwnd, &ps);
        return false;
    }
    let buffer = CreateCompatibleDC(Some(dc));
    let bitmap = CreateCompatibleBitmap(dc, rect.right.max(1), rect.bottom.max(1));
    if buffer.0.is_null() || bitmap.0.is_null() {
        if !bitmap.0.is_null() {
            let _ = DeleteObject(bitmap.into());
        }
        if !buffer.0.is_null() {
            let _ = DeleteDC(buffer);
        }
        let _ = EndPaint(hwnd, &ps);
        return false;
    }
    let old_bitmap = SelectObject(buffer, bitmap.into());
    let brush = CreateSolidBrush(COLORREF(0x002b211b));
    FillRect(buffer, &rect, brush);
    let _ = DeleteObject(brush.into());
    let font_height =
        (render.preferences.font_size as f64 * render.dpi as f64 / 96.0).round() as i32;
    let font = CreateFontW(
        -font_height,
        0,
        0,
        0,
        500,
        0,
        0,
        0,
        DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS,
        CLIP_DEFAULT_PRECIS,
        CLEARTYPE_QUALITY,
        0,
        w!("Segoe UI"),
    );
    let old_font = SelectObject(buffer, font.into());
    SetBkMode(buffer, TRANSPARENT);
    let (_, _, rows) = dimensions(&render.preferences, render.dpi);
    let column_widths = column_widths(&render.preferences, render.dpi);
    let cell_height = (rect.bottom - 4) / rows as i32;
    for (position, metric) in render.preferences.metrics.iter().enumerate() {
        let Some(index) = METRICS.iter().position(|x| *x == metric) else {
            continue;
        };
        let column = position / rows;
        let cell_width = column_widths[column];
        let x = 4 + column_widths[..column].iter().sum::<i32>();
        let y = 2 + (position % rows) as i32 * cell_height;
        let color = color(index, &render.preferences);
        let graph_width = if render.preferences.show_graphs {
            (26.0 * render.dpi as f64 / 96.0) as i32
        } else {
            0
        };
        if graph_width > 0 {
            graph(
                buffer,
                &render.timeline.points,
                index,
                Rect {
                    left: x + cell_width - graph_width - 3,
                    top: y + 3,
                    right: x + cell_width - 3,
                    bottom: y + cell_height - 3,
                },
                color,
            );
        }
        SetTextColor(buffer, color);
        let label = if render.preferences.show_labels {
            if render.preferences.english {
                LABELS_EN[index]
            } else {
                LABELS[index]
            }
        } else {
            ""
        };
        let unit =
            if render.preferences.show_units && render.timeline.current.values[index].is_some() {
                UNITS[index]
            } else {
                ""
            };
        let value = match render.timeline.current.values[index] {
            Some(n) => metric_text(index, n),
            None => "—".into(),
        };
        let text = format!("{label}{value}{unit}");
        let mut text: Vec<u16> = text.encode_utf16().collect();
        let mut area = RECT {
            left: x,
            top: y,
            right: x + cell_width - graph_width - 4,
            bottom: y + cell_height,
        };
        DrawTextW(
            buffer,
            &mut text,
            &mut area,
            DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX,
        );
    }
    // When no telemetry is available, replace the first column's placeholder
    // with the actual stopped/unavailable state; never retain previous digits.
    if render.preferences.show_status && render.timeline.current.values.iter().all(Option::is_none)
    {
        let mut area = RECT {
            left: 4,
            top: 2,
            right: rect.right - 4,
            bottom: rect.bottom - 2,
        };
        let brush = CreateSolidBrush(COLORREF(0x002b211b));
        FillRect(buffer, &area, brush);
        let _ = DeleteObject(brush.into());
        SetTextColor(buffer, COLORREF(0x00c7b8a8));
        // The first paint may precede the first snapshot. An empty Rust slice
        // has a dangling non-null pointer; do not pass that as a Win32 string.
        let state = initial_status_text(&render.timeline.current.state, render.preferences.english);
        let mut text: Vec<u16> = state.encode_utf16().collect();
        DrawTextW(
            buffer,
            &mut text,
            &mut area,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX,
        );
    }
    let success = BitBlt(
        dc,
        0,
        0,
        rect.right,
        rect.bottom,
        Some(buffer),
        0,
        0,
        SRCCOPY,
    )
    .is_ok();
    SelectObject(buffer, old_font);
    SelectObject(buffer, old_bitmap);
    let _ = DeleteObject(font.into());
    let _ = DeleteObject(bitmap.into());
    let _ = DeleteDC(buffer);
    let _ = EndPaint(hwnd, &ps);
    success
}

fn initial_status_text(state: &str, english: bool) -> &str {
    if state.trim().is_empty() {
        if english {
            "Waiting for sample"
        } else {
            "等待采样"
        }
    } else {
        state
    }
}

fn color(index: usize, preferences: &Preferences) -> COLORREF {
    const DEFAULTS: [&str; 11] = [
        "#68e7a5", "#75bdff", "#ffbb75", "#5edbe8", "#c49af7", "#a3b3ff", "#ff959e", "#efd16a",
        "#61d8b9", "#f7ae72", "#b5a2fa",
    ];
    let text = preferences
        .metric_colors
        .get(METRICS[index])
        .map(String::as_str)
        .unwrap_or(DEFAULTS[index]);
    let rgb = text
        .strip_prefix('#')
        .and_then(|hex| u32::from_str_radix(hex, 16).ok())
        .unwrap_or(0xe2e8f0);
    COLORREF(((rgb & 0xff0000) >> 16) | (rgb & 0x00ff00) | ((rgb & 0xff) << 16))
}
unsafe fn graph(
    dc: HDC,
    history: &VecDeque<[Option<f64>; 11]>,
    metric: usize,
    rect: Rect,
    color: COLORREF,
) {
    if rect.width() < 2 || rect.height() < 2 {
        return;
    }
    let values: Vec<_> = history.iter().map(|sample| sample[metric]).collect();
    let pen = CreatePen(PS_SOLID, 1, color);
    let old = SelectObject(dc, pen.into());
    let mut previous = false;
    for point in graph_points(&values, rect) {
        if let Some((x, y)) = point {
            if previous {
                let _ = LineTo(dc, x, y);
            } else {
                let _ = MoveToEx(dc, x, y, None);
            }
            previous = true;
        } else {
            previous = false;
        }
    }
    SelectObject(dc, old);
    let _ = DeleteObject(pen.into());
}

unsafe fn menu(owner: HWND, render: &Arc<Mutex<Render>>) -> Result<Option<Preferences>, String> {
    let preferences = render
        .lock()
        .map_err(|_| "监控偏好不可用")?
        .preferences
        .clone();
    let menu = CreatePopupMenu().map_err(|e| e.to_string())?;
    let metrics = CreatePopupMenu().map_err(|e| e.to_string())?;
    let labels = if preferences.english {
        LABELS_EN
    } else {
        LABELS
    };
    let t = |cn, en| if preferences.english { en } else { cn };
    for (index, label) in labels.iter().enumerate() {
        let checked = preferences.metrics.iter().any(|x| x == METRICS[index]);
        let flags = MF_STRING | if checked { MF_CHECKED } else { MF_UNCHECKED };
        let text = wide(label);
        let _ = AppendMenuW(metrics, flags, 100 + index, PCWSTR(text.as_ptr()));
    }
    let text = wide(t("自定义内容", "Choose metrics"));
    let _ = AppendMenuW(menu, MF_POPUP, metrics.0 as usize, PCWSTR(text.as_ptr()));
    let text = wide(t("显示折线", "Show graphs"));
    let _ = AppendMenuW(
        menu,
        MF_STRING
            | if preferences.show_graphs {
                MF_CHECKED
            } else {
                MF_UNCHECKED
            },
        1,
        PCWSTR(text.as_ptr()),
    );
    let _ = AppendMenuW(menu, MF_SEPARATOR, 0, None);
    for (id, label) in [
        (2, t("切换桌面浮条", "Switch to desktop strip")),
        (3, t("自定义设置", "Customize monitor")),
        (4, t("关闭任务栏监控", "Close taskbar monitor")),
    ] {
        let text = wide(label);
        let _ = AppendMenuW(menu, MF_STRING, id, PCWSTR(text.as_ptr()));
    }
    let mut point = POINT::default();
    let _ = GetCursorPos(&mut point);
    let _ = SetForegroundWindow(owner);
    let selected = TrackPopupMenu(
        menu,
        TPM_RETURNCMD | TPM_RIGHTBUTTON,
        point.x,
        point.y,
        None,
        owner,
        None,
    )
    .0;
    let _ = PostMessageW(Some(owner), WM_NULL, WPARAM(0), LPARAM(0));
    let _ = DestroyMenu(menu);
    let mut next = preferences;
    match selected {
        1 => next.show_graphs = !next.show_graphs,
        2 => {
            output(&HostFrame::Floating {});
            return Ok(None);
        }
        3 => {
            output(&HostFrame::Settings {});
            return Ok(None);
        }
        4 => {
            output(&HostFrame::Close {});
            return Ok(None);
        }
        100..=110 => {
            let id = METRICS[(selected - 100) as usize];
            if next.metrics.iter().any(|x| x == id) {
                if next.metrics.len() <= 1 {
                    return Ok(None);
                }
                next.metrics.retain(|x| x != id);
            } else if next.metrics.len() < 8 {
                next.metrics.push(id.into());
            } else {
                return Ok(None);
            }
        }
        _ => return Ok(None),
    }
    output(&HostFrame::Preferences {
        metrics: next.metrics.clone(),
        show_graphs: next.show_graphs,
    });
    Ok(Some(next))
}

struct Attachment {
    hwnd: HWND,
    shell: Identity,
    bar: Rect,
    area: Rect,
    dpi: u32,
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
unsafe fn inspect_visibility(
    hwnd: HWND,
    area: Rect,
    widths: &[i32],
    rows: usize,
) -> VisibilityProbe {
    let mut points = Vec::new();
    for x in [1, 2, 3] {
        for y in [1, 2, 3] {
            points.push(POINT {
                x: area.left + area.width() * x / 4,
                y: area.top + area.height() * y / 4,
            });
        }
    }
    let mut left = area.left + 4;
    for width in widths {
        for row in 0..rows {
            points.push(POINT {
                x: left + width / 2,
                y: area.top
                    + 2
                    + ((2 * row + 1) as i64 * i64::from(area.height() - 4) / (2 * rows) as i64)
                        as i32,
            });
        }
        left += width;
    }
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
    let (width, height, rows) = dimensions(preferences, inspection.dpi);
    let available = Rect {
        right: inspection.tray_left.min(inspection.bar.right),
        ..inspection.bar
    };
    let mut occupied = inspection.occupied.clone();
    for _ in 0..8 {
        let area = vacant_rect(
            available,
            &occupied,
            width,
            height,
            (inspection.dpi / 12) as i32,
        )
        .ok_or("任务栏没有足够且可确认的空闲空间，请减少指标或字号")?;
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
        let child = if mapped {
            CreateWindowExW(
                WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
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
            render.painted = false;
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
        let _ = InvalidateRect(Some(child), None, false);
        let _ = UpdateWindow(child);
        if !context.render.lock().is_ok_and(|r| r.painted) {
            let _ = DestroyWindow(child);
            return Err("任务栏首帧绘制失败".into());
        }
        let visibility = inspect_visibility(
            child,
            area,
            &column_widths(preferences, inspection.dpi),
            rows,
        );
        if !visibility.confirmed() {
            let _ = DestroyWindow(child);
            let previous_count = occupied.len();
            for blocker in visibility.blockers {
                if available.overlaps(blocker) && !occupied.contains(&blocker) {
                    occupied.push(blocker);
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
        });
    }
    Err("任务栏空位持续被其它窗口遮挡，保留桌面浮条".into())
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
        painted: false,
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
    if SetTimer(Some(controller), 1, 250, None) == 0 {
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
                    // Native menus use a modal message loop. Remove our child
                    // while geometry validation is paused, then remeasure.
                    if let Some(old) = attachment.take() {
                        let _ = DestroyWindow(old.hwnd);
                    }
                    if let Some(prefs) = menu(controller, &render)? {
                        if let Ok(mut view) = render.lock() {
                            view.preferences = prefs;
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
                    generation += 1;
                    let _ = inspect_tx.try_send(generation);
                    pending = Some((generation, Instant::now()));
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
                            dimensions(&view.preferences, view.dpi)
                                != dimensions(&preferences, view.dpi)
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
                    if let Some(current) = &attachment {
                        let _ = InvalidateRect(Some(current.hwnd), None, false);
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
                    }
                    if let Some(current) = &attachment {
                        let _ = InvalidateRect(Some(current.hwnd), None, false);
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
            if let Some(current) = &attachment {
                let _ = InvalidateRect(Some(current.hwnd), None, false);
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
                    let reusable = attachment.as_ref().is_some_and(|a| {
                        a.shell == inspection.identity
                            && a.bar == inspection.bar
                            && a.dpi == inspection.dpi
                            && !inspection.occupied.iter().any(|r| r.overlaps(a.area))
                    });
                    if reusable && std::env::var_os("STRATA_MANAGER_TASKBAR_DIAGNOSTICS").is_some()
                    {
                        if let Some(current) = &attachment {
                            let _dpi =
                                ThreadDpiContext::for_window(HWND(current.shell.hwnd as *mut _))?;
                            let (_, _, rows) = dimensions(&preferences, current.dpi);
                            inspect_visibility(
                                current.hwnd,
                                current.area,
                                &column_widths(&preferences, current.dpi),
                                rows,
                            );
                        }
                    }
                    if !reusable {
                        if let Some(old) = attachment.take() {
                            let _ = DestroyWindow(old.hwnd);
                        }
                        match attach(&inspection, &preferences, &context, instance) {
                            Ok(new) => attachment = Some(new),
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
                Err(error) => break 'main Err(error),
            }
        }
        if pending.is_some_and(|(_, since)| since.elapsed() > Duration::from_secs(3)) {
            break Err("任务栏 UI Automation 检查超时，已停止挂载".into());
        }
        if let Some(current) = &attachment {
            if shell().and_then(|hwnd| identity(hwnd)).ok() != Some(current.shell) {
                break Err("Explorer 已重启，任务栏宿主退出以恢复桌面浮条".into());
            }
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
    fn native_metrics_have_distinct_colors_and_custom_rgb_maps_to_colorref() {
        let mut prefs = Preferences::normalize(&serde_json::Value::Null);
        let values: std::collections::HashSet<_> = (0..METRICS.len())
            .map(|index| color(index, &prefs).0)
            .collect();
        assert_eq!(values.len(), METRICS.len());
        prefs.metric_colors.insert("gpu".into(), "#123456".into());
        assert_eq!(color(2, &prefs).0, 0x563412);
    }
    #[test]
    fn first_frame_without_a_snapshot_has_a_nonempty_native_string() {
        assert_eq!(initial_status_text("", false), "等待采样");
        assert_eq!(initial_status_text("  ", true), "Waiting for sample");
        assert_eq!(initial_status_text("未启动", false), "未启动");
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
    fn two_rows_fit_at_default_dpi_and_scale_together() {
        let mut preferences = Preferences::normalize(&serde_json::Value::Null);
        preferences.layout = "twoRow".into();
        let (width, height, rows) = dimensions(&preferences, 96);
        assert_eq!(rows, 2);
        assert!(height <= 48);
        assert!(width > 200);
        let (large_width, large_height, _) = dimensions(&preferences, 144);
        assert!(large_width > width && large_height > height);
    }

    #[test]
    fn requested_large_font_is_preserved_and_rejected_when_bar_is_too_short() {
        let preferences =
            Preferences::normalize(&serde_json::json!({"fontSize":36,"layout":"twoRow"}));
        let (width, height, _) = dimensions(&preferences, 96);
        assert_eq!(preferences.font_size, 36);
        assert!(height > 48);
        let bar = Rect {
            left: 0,
            top: 0,
            right: 3840,
            bottom: 48,
        };
        assert!(vacant_rect(bar, &[], width, height, 8).is_none());
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
