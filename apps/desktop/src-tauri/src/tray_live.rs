//! Live readings on the main tray icon (#71).
//!
//! The icon is rendered in memory from the app icon plus a status badge or a
//! small built-in digit font, so it needs no system fonts, GPU or webview.
//! Readings come from the same read-only snapshot the floating monitor uses;
//! the loop never starts, stops or recovers services.
use crate::{floating_monitor, ClientState};
use serde_json::Value;
use std::{
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{image::Image, AppHandle, Manager};
use tokio::sync::Notify;

pub(crate) const MAIN_TRAY: &str = "main-tray";
/// Rendered size; tray hosts scale it to 16/20/24 px as needed.
const ICON_SIZE: u32 = 32;
/// Windows truncates tray tooltips at 127 UTF-16 units.
const TOOLTIP_LIMIT: usize = 120;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TrayDisplay {
    None,
    Status,
    Generation,
    Vram,
    Gpu,
}

impl TrayDisplay {
    pub(crate) fn from_settings(settings: &Value) -> Self {
        match settings["floatingMonitor"]["trayIconDisplay"].as_str() {
            Some("none") => Self::None,
            Some("generation") => Self::Generation,
            Some("vram") => Self::Vram,
            Some("gpu") => Self::Gpu,
            // Missing (settings saved before #71) or unknown: status color.
            _ => Self::Status,
        }
    }
    fn code(self) -> u8 {
        self as u8
    }
    fn from_code(code: u8) -> Self {
        match code {
            0 => Self::None,
            2 => Self::Generation,
            3 => Self::Vram,
            4 => Self::Gpu,
            _ => Self::Status,
        }
    }
}

/// Service state shown as the badge color.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tone {
    Stopped,
    Loading,
    Ready,
    Generating,
    Error,
}

impl Tone {
    pub(crate) fn rgb(self) -> [u8; 3] {
        match self {
            Self::Stopped => [148, 163, 184],
            Self::Loading => [37, 99, 235],
            Self::Ready => [22, 163, 74],
            Self::Generating => [234, 88, 12],
            Self::Error => [220, 38, 38],
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Reading {
    pub tone: Tone,
    /// Up to three glyphs from `0-9` and `k`; `None` shows the status dot.
    pub digits: Option<String>,
    pub tooltip: String,
    /// Short macOS menu-bar text next to the icon.
    pub title: Option<String>,
}

fn numeric(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite() && *n >= 0.0)
}

fn compact(n: f64) -> String {
    if n.round() >= 1000.0 {
        format!("{}k", (n / 1000.0).round().clamp(1.0, 99.0))
    } else {
        format!("{n:.0}")
    }
}

fn shorten(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut out: String = text.chars().take(limit.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Pure mapping from a monitor snapshot (plus the supervisor health entry for
/// the selected profile) to what the tray shows.
pub(crate) fn reading(
    snapshot: &Value,
    supervisor_health: &Value,
    display: TrayDisplay,
    english: bool,
) -> Reading {
    let t = |cn: &'static str, en: &'static str| if english { en } else { cn };
    let phase = snapshot["phase"].as_str().unwrap_or("unavailable");
    let live = &snapshot["metrics"]["live"];
    let hardware = &snapshot["metrics"]["hardware"];
    let state = live["state"].as_str().unwrap_or("unknown");
    let loaded = snapshot["health"]["loaded"] == true;
    let checking = supervisor_health["phase"] == "checking";
    let online = phase == "online";
    let (tone, label) = match phase {
        "none" => (Tone::Stopped, t("尚未选择模型", "No model selected")),
        "stopped" => (Tone::Stopped, t("已停止", "Stopped")),
        "online" if state == "loading" => (Tone::Loading, t("正在载入模型", "Loading model")),
        "online" if state == "unloading" => (Tone::Loading, t("正在释放模型", "Releasing model")),
        "online" if !loaded && checking => (Tone::Loading, t("正在准备模型", "Preparing model")),
        "online" if !loaded => (Tone::Stopped, t("未加载模型", "No model loaded")),
        "online" if state == "generating" => (Tone::Generating, t("生成中", "Generating")),
        "online" if state == "reading" => (Tone::Generating, t("读取中", "Reading")),
        "online" => (Tone::Ready, t("模型已就绪", "Model ready")),
        // The process runs but the API is not answering yet: still starting.
        _ if checking => (Tone::Loading, t("正在启动服务", "Starting service")),
        _ => (Tone::Error, t("服务异常", "Service error")),
    };
    let ready = online && loaded && tone != Tone::Loading;
    let speed = if ready {
        match state {
            "generating" => numeric(&live["tok_s"]),
            "reading" => numeric(&live["prefill_tok_s_mean"]),
            _ => None,
        }
    } else {
        None
    };
    let vram = if online {
        match (
            numeric(&hardware["gpu_mem_used"]),
            numeric(&hardware["gpu_mem_total"]),
        ) {
            (Some(used), Some(total)) if total > 0.0 => Some((used, total)),
            _ => None,
        }
    } else {
        None
    };
    let gpu = if online {
        numeric(&hardware["gpu_util"])
    } else {
        None
    };
    let gib = |bytes: f64| bytes / 1024f64.powi(3);
    let percent = |n: f64| n.round().clamp(0.0, 100.0);

    let mut parts = vec!["Strata Manager".to_string()];
    let model = snapshot["health"]["model"]
        .as_str()
        .filter(|m| online && loaded && !m.is_empty());
    let profile = snapshot["profile"]["name"]
        .as_str()
        .filter(|n| !n.is_empty());
    if let Some(name) = model.or(profile) {
        parts.push(shorten(name, 40));
    }
    match speed {
        Some(speed) => parts.push(format!("{speed:.1} tok/s")),
        None => parts.push(label.to_string()),
    }
    if let Some((used, total)) = vram {
        parts.push(format!(
            "{} {:.1}/{:.0} GB",
            t("显存", "VRAM"),
            gib(used),
            gib(total)
        ));
    }
    if let Some(gpu) = gpu {
        parts.push(format!("GPU {:.0}%", percent(gpu)));
    }
    let tooltip = shorten(&parts.join(" · "), TOOLTIP_LIMIT);

    let (digits, title) = match display {
        TrayDisplay::Generation => (
            speed.map(compact),
            speed.map(|n| format!("{} t/s", compact(n))),
        ),
        TrayDisplay::Vram => (
            vram.map(|(used, total)| format!("{:.0}", percent(used / total * 100.0))),
            vram.map(|(used, _)| format!("{:.1} GB", gib(used))),
        ),
        TrayDisplay::Gpu => (
            gpu.map(|n| format!("{:.0}", percent(n))),
            gpu.map(|n| format!("{:.0}%", percent(n))),
        ),
        TrayDisplay::Status | TrayDisplay::None => (None, None),
    };
    Reading {
        tone,
        digits,
        tooltip,
        title,
    }
}

/// 3×5 glyphs; each row's low three bits are pixels, left to right.
fn glyph(ch: char) -> [u8; 5] {
    match ch {
        '0' => [7, 5, 5, 5, 7],
        '1' => [2, 6, 2, 2, 7],
        '2' => [7, 1, 7, 4, 7],
        '3' => [7, 1, 7, 1, 7],
        '4' => [5, 5, 7, 1, 1],
        '5' => [7, 4, 7, 1, 7],
        '6' => [7, 4, 7, 5, 7],
        '7' => [7, 1, 2, 2, 2],
        '8' => [7, 5, 7, 5, 7],
        '9' => [7, 5, 7, 1, 7],
        'k' => [4, 5, 6, 5, 5],
        _ => [0, 0, 7, 0, 0],
    }
}

/// Area-average resample of straight-alpha RGBA to `size`×`size`.
pub(crate) fn resample(rgba: &[u8], width: u32, height: u32, size: u32) -> Vec<u8> {
    let (w, h, s) = (width as usize, height as usize, size as usize);
    let mut out = vec![0u8; s * s * 4];
    if w == 0 || h == 0 || rgba.len() < w * h * 4 {
        return out;
    }
    for oy in 0..s {
        let y0 = (oy * h / s).min(h - 1);
        let y1 = ((oy + 1) * h / s).clamp(y0 + 1, h);
        for ox in 0..s {
            let x0 = (ox * w / s).min(w - 1);
            let x1 = ((ox + 1) * w / s).clamp(x0 + 1, w);
            let (mut r, mut g, mut b, mut a, mut n) = (0u64, 0u64, 0u64, 0u64, 0u64);
            for y in y0..y1 {
                for x in x0..x1 {
                    let p = (y * w + x) * 4;
                    let alpha = u64::from(rgba[p + 3]);
                    r += u64::from(rgba[p]) * alpha;
                    g += u64::from(rgba[p + 1]) * alpha;
                    b += u64::from(rgba[p + 2]) * alpha;
                    a += alpha;
                    n += 1;
                }
            }
            let o = (oy * s + ox) * 4;
            if let (Some(r), Some(g), Some(b)) =
                (r.checked_div(a), g.checked_div(a), b.checked_div(a))
            {
                out[o..o + 4].copy_from_slice(&[r as u8, g as u8, b as u8, (a / n) as u8]);
            }
        }
    }
    out
}

/// Draw the badge for `tone` / `digits` over a `size`×`size` base icon.
/// Pure: the same inputs always give the same pixels.
pub(crate) fn render(base: &[u8], size: u32, tone: Tone, digits: Option<&str>) -> Vec<u8> {
    let s = size as usize;
    let mut px = base.to_vec();
    px.resize(s * s * 4, 0);
    let color = tone.rgb();
    let white = [255, 255, 255];
    let mut put = |x: usize, y: usize, rgb: [u8; 3]| {
        if x < s && y < s {
            let o = (y * s + x) * 4;
            px[o..o + 4].copy_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
        }
    };
    match digits.filter(|d| !d.is_empty()) {
        None => {
            // Status dot in the lower-right corner with a white ring so it
            // stays visible on dark and light taskbars.
            let radius = (s as f64 * 0.25).max(3.0);
            let ring = (s as f64 / 16.0).max(1.0);
            let center = s as f64 - radius - ring;
            for y in 0..s {
                for x in 0..s {
                    let dx = x as f64 + 0.5 - center;
                    let dy = y as f64 + 0.5 - center;
                    let d = (dx * dx + dy * dy).sqrt();
                    if d <= radius {
                        put(x, y, color);
                    } else if d <= radius + ring {
                        put(x, y, white);
                    }
                }
            }
        }
        Some(text) => {
            let chars: Vec<char> = text.chars().take(3).collect();
            let scale = (s / 16).max(1);
            let pad = scale;
            let band = 5 * scale + pad * 2;
            let top = s.saturating_sub(band);
            let corner = scale.min(2);
            // Band across the bottom: the reading must win over the logo.
            for y in top..s {
                for x in 0..s {
                    let dy = (y - top).min(s - 1 - y);
                    let dx = x.min(s - 1 - x);
                    if dx + dy >= corner {
                        put(x, y, color);
                    }
                }
            }
            let advance = 4 * scale;
            let width = chars.len() * advance - scale;
            let left = s.saturating_sub(width) / 2;
            for (index, ch) in chars.into_iter().enumerate() {
                for (row, bits) in glyph(ch).into_iter().enumerate() {
                    for col in 0..3 {
                        if bits & (1 << (2 - col)) == 0 {
                            continue;
                        }
                        for dy in 0..scale {
                            for dx in 0..scale {
                                put(
                                    left + index * advance + col * scale + dx,
                                    top + pad + row * scale + dy,
                                    white,
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    px
}

/// Shared lifecycle state; the loop reads the display choice on each tick.
pub(crate) struct TrayLiveState {
    display: AtomicU8,
    wake: Arc<Notify>,
    /// Default app icon resampled once to `ICON_SIZE`.
    base: Mutex<Option<Vec<u8>>>,
}

impl Default for TrayLiveState {
    fn default() -> Self {
        Self {
            display: AtomicU8::new(TrayDisplay::Status.code()),
            wake: Arc::new(Notify::new()),
            base: Mutex::new(None),
        }
    }
}

/// True while the live loop owns the main tray tooltip.
pub(crate) fn owns_tooltip(app: &AppHandle) -> bool {
    app.try_state::<TrayLiveState>().is_some_and(|state| {
        TrayDisplay::from_code(state.display.load(Ordering::Relaxed)) != TrayDisplay::None
    })
}

pub(crate) fn apply(app: &AppHandle, settings: &Value) {
    if let Some(state) = app.try_state::<TrayLiveState>() {
        let next = TrayDisplay::from_settings(settings).code();
        if state.display.swap(next, Ordering::Relaxed) != next {
            state.wake.notify_one();
        }
    }
}

fn english_for(app: &AppHandle, snapshot: &Value) -> bool {
    match snapshot["settings"]["language"].as_str() {
        Some(language) => crate::system_locale::uses_english_fallback(Some(language)),
        None => app
            .state::<ClientState>()
            .tray_english
            .load(Ordering::Relaxed),
    }
}

/// One read-only monitor snapshot plus the supervisor health of its profile.
async fn sample(app: &AppHandle) -> (Value, Value) {
    let state = app.state::<ClientState>();
    let directory = state.ipc.data_dir.clone();
    let client = state.client.clone();
    let supervisor = Arc::new(Mutex::new(Value::Null));
    let seen = supervisor.clone();
    let snapshot = floating_monitor::collect_snapshot(move |method, params| {
        let directory = directory.clone();
        let client = client.clone();
        let seen = seen.clone();
        async move {
            let result = floating_monitor::read_existing(&directory, &client, method, params).await;
            if method == "supervisor_status" {
                if let (Ok(value), Ok(mut slot)) = (&result, seen.lock()) {
                    *slot = value.clone();
                }
            }
            result
        }
    })
    .await
    .unwrap_or(Value::Null);
    let supervisor = supervisor
        .lock()
        .map(|value| value.clone())
        .unwrap_or(Value::Null);
    let health = snapshot["profile"]["id"]
        .as_str()
        .map(|id| supervisor["health"][id].clone())
        .unwrap_or(Value::Null);
    (snapshot, health)
}

/// Background loop: 1–2 s cadence, and native calls only when something
/// changed. It keeps running while every window is hidden to the tray.
pub(crate) fn start(app: &AppHandle, settings: &Value) {
    let state = app.state::<TrayLiveState>();
    state.display.store(
        TrayDisplay::from_settings(settings).code(),
        Ordering::Relaxed,
    );
    if let Some(icon) = app.default_window_icon() {
        if let Ok(mut base) = state.base.lock() {
            *base = Some(resample(
                icon.rgba(),
                icon.width(),
                icon.height(),
                ICON_SIZE,
            ));
        }
    }
    let wake = state.wake.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut shown: Option<(Tone, Option<String>)> = None;
        let mut tooltip: Option<String> = None;
        let mut title: Option<Option<String>> = None;
        loop {
            if app.state::<ClientState>().quitting.load(Ordering::Acquire) {
                break;
            }
            let live = app.state::<TrayLiveState>();
            let display = TrayDisplay::from_code(live.display.load(Ordering::Relaxed));
            let Some(tray) = app.tray_by_id(MAIN_TRAY) else {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            };
            let mut interval = 2000;
            if display == TrayDisplay::None {
                if shown.take().is_some() {
                    let _ = tray.set_icon(app.default_window_icon().cloned());
                    let _ = tray.set_tooltip(Some("Strata Manager"));
                    #[cfg(target_os = "macos")]
                    let _ = tray.set_title(None::<&str>);
                }
                tooltip = None;
                title = None;
            } else {
                let (snapshot, health) = sample(&app).await;
                let english = english_for(&app, &snapshot);
                let view = reading(&snapshot, &health, display, english);
                let key = (view.tone, view.digits.clone());
                if shown.as_ref() != Some(&key) {
                    let base = live.base.lock().ok().and_then(|base| base.clone());
                    if let Some(base) = base {
                        let rgba = render(&base, ICON_SIZE, view.tone, view.digits.as_deref());
                        let _ = tray.set_icon(Some(Image::new_owned(rgba, ICON_SIZE, ICON_SIZE)));
                    }
                    shown = Some(key);
                }
                if tooltip.as_deref() != Some(view.tooltip.as_str()) {
                    let _ = tray.set_tooltip(Some(&view.tooltip));
                    tooltip = Some(view.tooltip.clone());
                }
                if title.as_ref() != Some(&view.title) {
                    #[cfg(target_os = "macos")]
                    let _ = tray.set_title(view.title.as_deref());
                    title = Some(view.title.clone());
                }
                interval = snapshot["settings"]["pollInterval"]
                    .as_u64()
                    .unwrap_or(2000)
                    .clamp(1000, 2000);
            }
            tokio::select! {
                _ = wake.notified() => {}
                _ = tokio::time::sleep(Duration::from_millis(interval)) => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};

    /// Deterministic stand-in for the app icon: a dark square with a clear rim.
    fn base(size: u32) -> Vec<u8> {
        let s = size as usize;
        let mut px = vec![0u8; s * s * 4];
        for y in 1..s - 1 {
            for x in 1..s - 1 {
                let o = (y * s + x) * 4;
                px[o..o + 4].copy_from_slice(&[15, 23, 42, 255]);
            }
        }
        px
    }
    fn hash(px: &[u8]) -> String {
        Sha256::digest(px)
            .iter()
            .take(8)
            .map(|b| format!("{b:02x}"))
            .collect()
    }
    fn online(state: &str) -> Value {
        let gib = 1024f64.powi(3);
        json!({"phase":"online","profile":{"id":"p","name":"Qwen 本地"},
            "health":{"loaded":true,"model":"Qwen3-30B-A3B-Q4_K_M"},
            "metrics":{"live":{"state":state,"tok_s":21.34,"prefill_tok_s_mean":3200},
            "hardware":{"gpu_util":49.6,"gpu_mem_used":38.4*gib,"gpu_mem_total":44.0*gib}}})
    }

    #[test]
    fn display_defaults_to_status_and_parses_every_choice() {
        assert_eq!(
            TrayDisplay::from_settings(&Value::Null),
            TrayDisplay::Status
        );
        assert_eq!(
            TrayDisplay::from_settings(&json!({"floatingMonitor":{"trayIconDisplay":"GPU"}})),
            TrayDisplay::Status
        );
        for (id, display) in [
            ("none", TrayDisplay::None),
            ("status", TrayDisplay::Status),
            ("generation", TrayDisplay::Generation),
            ("vram", TrayDisplay::Vram),
            ("gpu", TrayDisplay::Gpu),
        ] {
            let parsed =
                TrayDisplay::from_settings(&json!({"floatingMonitor":{"trayIconDisplay":id}}));
            assert_eq!(parsed, display);
            assert_eq!(TrayDisplay::from_code(parsed.code()), display);
        }
    }

    #[test]
    fn tone_follows_service_state() {
        let none = Value::Null;
        let checking = json!({"phase":"checking"});
        let cases = [
            (json!({"phase":"none"}), &none, Tone::Stopped),
            (json!({"phase":"stopped"}), &none, Tone::Stopped),
            (json!({"phase":"disconnected"}), &checking, Tone::Loading),
            (json!({"phase":"disconnected"}), &none, Tone::Error),
            (json!({"phase":"unavailable"}), &none, Tone::Error),
            (Value::Null, &none, Tone::Error),
            (online("loading"), &none, Tone::Loading),
            (online("idle"), &none, Tone::Ready),
            (online("generating"), &none, Tone::Generating),
            (online("reading"), &none, Tone::Generating),
        ];
        for (snapshot, health, tone) in cases {
            let view = reading(&snapshot, health, TrayDisplay::Status, false);
            assert_eq!(view.tone, tone, "{snapshot}");
        }
        let mut unloaded = online("idle");
        unloaded["health"]["loaded"] = json!(false);
        let idle = reading(&unloaded, &none, TrayDisplay::Status, false);
        assert_eq!(idle.tone, Tone::Stopped);
        let preparing = reading(&unloaded, &checking, TrayDisplay::Status, false);
        assert_eq!(preparing.tone, Tone::Loading);
    }

    #[test]
    fn tooltip_matches_the_agreed_format() {
        let view = reading(
            &online("generating"),
            &Value::Null,
            TrayDisplay::Status,
            false,
        );
        assert_eq!(
            view.tooltip,
            "Strata Manager · Qwen3-30B-A3B-Q4_K_M · 21.3 tok/s · 显存 38.4/44 GB · GPU 50%"
        );
        let en = reading(&online("idle"), &Value::Null, TrayDisplay::Status, true);
        assert_eq!(
            en.tooltip,
            "Strata Manager · Qwen3-30B-A3B-Q4_K_M · Model ready · VRAM 38.4/44 GB · GPU 50%"
        );
        let stopped = reading(
            &json!({"phase":"stopped","profile":{"name":"Qwen 本地"}}),
            &Value::Null,
            TrayDisplay::Gpu,
            false,
        );
        assert_eq!(stopped.tooltip, "Strata Manager · Qwen 本地 · 已停止");
        assert_eq!(stopped.digits, None);
        let mut long = online("idle");
        long["health"]["model"] = json!("m".repeat(300));
        let view = reading(&long, &Value::Null, TrayDisplay::Status, false);
        assert!(view.tooltip.chars().count() <= TOOLTIP_LIMIT);
    }

    #[test]
    fn digits_and_titles_per_display() {
        let generating = online("generating");
        let h = &Value::Null;
        let g = reading(&generating, h, TrayDisplay::Generation, false);
        assert_eq!(
            (g.digits.as_deref(), g.title.as_deref()),
            (Some("21"), Some("21 t/s"))
        );
        let r = reading(&online("reading"), h, TrayDisplay::Generation, false);
        assert_eq!(r.digits.as_deref(), Some("3k"));
        let idle = reading(&online("idle"), h, TrayDisplay::Generation, false);
        assert_eq!((idle.digits, idle.title), (None, None), "no stale speed");
        let v = reading(&generating, h, TrayDisplay::Vram, false);
        assert_eq!(
            (v.digits.as_deref(), v.title.as_deref()),
            (Some("87"), Some("38.4 GB"))
        );
        let u = reading(&generating, h, TrayDisplay::Gpu, false);
        assert_eq!(
            (u.digits.as_deref(), u.title.as_deref()),
            (Some("50"), Some("50%"))
        );
        let s = reading(&generating, h, TrayDisplay::Status, false);
        assert_eq!((s.digits, s.title), (None, None));
        let mut full = generating.clone();
        full["metrics"]["hardware"]["gpu_util"] = json!(100.0);
        let full = reading(&full, h, TrayDisplay::Gpu, false);
        assert_eq!(full.digits.as_deref(), Some("100"));
        let mut loading = generating;
        loading["metrics"]["live"]["state"] = json!("loading");
        let loading = reading(&loading, h, TrayDisplay::Generation, false);
        assert_eq!(loading.digits, None);
    }

    #[test]
    fn render_is_pure_and_changes_only_the_badge() {
        let base = base(32);
        let dot = render(&base, 32, Tone::Ready, None);
        assert_eq!(dot, render(&base, 32, Tone::Ready, None));
        assert_eq!(dot.len(), 32 * 32 * 4);
        // The corner dot leaves the top-left of the logo untouched.
        for y in 0..12 {
            for x in 0..12 {
                let o = (y * 32 + x) * 4;
                assert_eq!(dot[o..o + 4], base[o..o + 4]);
            }
        }
        let center = ((32 - 9) * 32 + (32 - 9)) * 4;
        assert_eq!(dot[center..center + 3], Tone::Ready.rgb());
        let band = render(&base, 32, Tone::Generating, Some("21"));
        let o = (31 * 32 + 16) * 4;
        assert_eq!(band[o..o + 3], Tone::Generating.rgb());
        assert_eq!(band[..32 * 18 * 4], base[..32 * 18 * 4], "logo stays above");
        // A blank digit string is treated as "no reading": the status dot.
        assert_eq!(render(&base, 32, Tone::Ready, Some("")), dot);
    }

    #[test]
    fn render_hashes_are_stable_and_distinct() {
        let mut hashes = std::collections::HashSet::new();
        let cases: [(u32, Tone, Option<&str>); 9] = [
            (32, Tone::Stopped, None),
            (32, Tone::Loading, None),
            (32, Tone::Ready, None),
            (32, Tone::Generating, None),
            (32, Tone::Error, None),
            (32, Tone::Generating, Some("21")),
            (32, Tone::Ready, Some("100")),
            (16, Tone::Generating, Some("99k")),
            (64, Tone::Generating, Some("21")),
        ];
        for (size, tone, digits) in cases {
            let px = render(&base(size), size, tone, digits);
            assert_eq!(px.len(), (size * size * 4) as usize);
            assert!(hashes.insert(hash(&px)), "{tone:?} {digits:?} collides");
        }
        // Golden hashes guard against accidental glyph or color changes.
        assert_eq!(
            hash(&render(&base(32), 32, Tone::Ready, None)),
            GOLDEN_READY
        );
        assert_eq!(
            hash(&render(&base(32), 32, Tone::Generating, Some("21"))),
            GOLDEN_GENERATING_21
        );
    }
    const GOLDEN_READY: &str = "4d99a42c141c9b17";
    const GOLDEN_GENERATING_21: &str = "fa872f039d1bc1fa";

    #[test]
    fn resample_handles_any_source_size() {
        let src = vec![200u8; 512 * 512 * 4];
        let out = resample(&src, 512, 512, 32);
        assert!(out.chunks(4).all(|p| p == [200, 200, 200, 200]));
        assert_eq!(resample(&[], 0, 0, 16), vec![0; 16 * 16 * 4]);
        let up = resample(&[1, 2, 3, 255], 1, 1, 4);
        assert!(up.chunks(4).all(|p| p == [1, 2, 3, 255]));
    }
}
