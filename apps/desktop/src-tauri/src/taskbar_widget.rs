//! Pure model of the Windows taskbar widget: preferences, text formatting,
//! layout (a display list), ring/dot rasterisation and the context menu.
//! Everything here is platform independent so Linux CI can test it; the
//! Win32 host only turns the display list into pixels and menus.
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Items in their canonical display order.
pub(crate) const ITEMS: [&str; 6] = [
    "generation",
    "prefill",
    "gpu",
    "vram",
    "temperature",
    "status",
];
pub(crate) const RINGS: [&str; 3] = ["gpu", "vram", "off"];
const DEFAULT_ITEMS: [&str; 2] = ["generation", "prefill"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WidgetPrefs {
    pub ring: String,
    pub items: Vec<String>,
}

impl Default for WidgetPrefs {
    fn default() -> Self {
        Self {
            ring: "gpu".into(),
            items: DEFAULT_ITEMS.iter().map(|x| (*x).into()).collect(),
        }
    }
}

impl WidgetPrefs {
    /// `value` is `settings.floatingMonitor.taskbar`. Unknown items are
    /// dropped, duplicates collapse and the order is always canonical. The
    /// widget is never empty: no ring and no items falls back to the GPU ring.
    pub fn normalize(value: &Value) -> Self {
        let ring = value["ring"]
            .as_str()
            .filter(|ring| RINGS.contains(ring))
            .unwrap_or("gpu");
        let items = match value["items"].as_array() {
            Some(values) => ITEMS
                .iter()
                .filter(|item| values.iter().any(|v| v.as_str() == Some(**item)))
                .map(|item| (*item).to_owned())
                .collect(),
            None => Self::default().items,
        };
        let ring = if ring == "off" && Vec::<String>::is_empty(&items) {
            "gpu"
        } else {
            ring
        };
        Self {
            ring: ring.into(),
            items,
        }
    }

    pub fn valid(&self) -> bool {
        serde_json::to_value(self).is_ok_and(|value| Self::normalize(&value) == *self)
    }

    fn has(&self, item: &str) -> bool {
        self.items.iter().any(|x| x == item)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Tone {
    #[default]
    Stopped,
    Loading,
    Ready,
    Busy,
    Error,
}

/// Straight (non-premultiplied) RGBA.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Color(pub [u8; 4]);

impl Serialize for Color {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let [r, g, b, a] = self.0;
        serializer.serialize_str(&format!("#{r:02x}{g:02x}{b:02x}{a:02x}"))
    }
}

const fn rgb(hex: u32) -> Color {
    Color([(hex >> 16) as u8, (hex >> 8) as u8, hex as u8, 255])
}
const fn rgba(hex: u32, alpha: u8) -> Color {
    Color([(hex >> 16) as u8, (hex >> 8) as u8, hex as u8, alpha])
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Palette {
    pub text: Color,
    pub muted: Color,
    pub track: Color,
    /// Used only when per-pixel transparency is unavailable.
    pub opaque_background: Color,
    dark: bool,
}

impl Palette {
    /// `dark` describes the TASKBAR (SystemUsesLightTheme == 0), not the app.
    pub fn new(dark: bool) -> Self {
        if dark {
            Self {
                text: rgb(0xffffff),
                muted: rgba(0xffffff, 178),
                track: rgba(0xffffff, 56),
                opaque_background: rgb(0x202020),
                dark,
            }
        } else {
            Self {
                text: rgba(0x000000, 228),
                muted: rgba(0x000000, 150),
                track: rgba(0x000000, 38),
                opaque_background: rgb(0xf3f3f3),
                dark,
            }
        }
    }

    pub fn tone(&self, tone: Tone) -> Color {
        match (tone, self.dark) {
            (Tone::Stopped, true) => rgb(0x9ca3af),
            (Tone::Stopped, false) => rgb(0x6b7280),
            (Tone::Loading, true) => rgb(0x60a5fa),
            (Tone::Loading, false) => rgb(0x2563eb),
            (Tone::Ready, true) => rgb(0x4ade80),
            (Tone::Ready, false) => rgb(0x16a34a),
            (Tone::Busy, true) => rgb(0xfb923c),
            (Tone::Busy, false) => rgb(0xea580c),
            (Tone::Error, true) => rgb(0xf87171),
            (Tone::Error, false) => rgb(0xdc2626),
        }
    }

    pub fn temperature(&self, celsius: f64) -> Color {
        self.tone(if celsius < 70.0 {
            Tone::Ready
        } else if celsius < 85.0 {
            Tone::Busy
        } else {
            Tone::Error
        })
    }
}

/// Live values the widget can show. Indices follow `taskbar_monitor::METRICS`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Reading<'a> {
    pub generation: Option<f64>,
    pub prefill: Option<f64>,
    pub gpu: Option<f64>,
    pub vram_used: Option<f64>,
    pub vram_total: Option<f64>,
    pub temperature: Option<f64>,
    pub state: &'a str,
    pub tone: Tone,
}

const DASH: &str = "—";

/// tok/s: one decimal below 100, integers below 1000, then "3.2k".
pub(crate) fn tokens(value: Option<f64>) -> String {
    let Some(value) = value.filter(|v| v.is_finite() && *v >= 0.0) else {
        return DASH.into();
    };
    if value >= 999_950.0 {
        format!("{:.1}M", value / 1e6)
    } else if value >= 9_999.5 {
        format!("{:.0}k", value / 1e3)
    } else if value >= 999.5 {
        format!("{:.1}k", value / 1e3)
    } else if value >= 99.95 {
        format!("{value:.0}")
    } else {
        format!("{value:.1}")
    }
}

/// "21.3 tok/s", or a bare dash when there is no live value.
pub(crate) fn speed(value: Option<f64>) -> String {
    match tokens(value) {
        dash if dash == DASH => dash,
        text => format!("{text} tok/s"),
    }
}

pub(crate) fn percent(value: Option<f64>) -> String {
    value
        .filter(|v| v.is_finite() && *v >= 0.0)
        .map(|v| format!("{:.0}%", v.min(100.0)))
        .unwrap_or_else(|| DASH.into())
}

pub(crate) fn gigabytes(value: Option<f64>) -> String {
    match value.filter(|v| v.is_finite() && *v >= 0.0) {
        Some(v) if v >= 99.95 => format!("{v:.0} GB"),
        Some(v) => format!("{v:.1} GB"),
        None => DASH.into(),
    }
}

pub(crate) fn celsius(value: Option<f64>) -> String {
    value
        .filter(|v| v.is_finite() && *v >= 0.0)
        .map(|v| format!("{v:.0}℃"))
        .unwrap_or_else(|| DASH.into())
}

/// Ring fill in 0..=1 and the number shown inside it.
pub(crate) fn ring_value(ring: &str, reading: &Reading) -> Option<(Option<f32>, String)> {
    let fraction = match ring {
        "gpu" => reading.gpu.map(|v| v / 100.0),
        "vram" => match (reading.vram_used, reading.vram_total) {
            (Some(used), Some(total)) if total > 0.0 => Some(used / total),
            _ => None,
        },
        _ => return None,
    }
    .filter(|v| v.is_finite())
    .map(|v| v.clamp(0.0, 1.0) as f32);
    let label = fraction
        .map(|f| ((f * 100.0).round() as u32).to_string())
        .unwrap_or_else(|| "–".into());
    Some((fraction, label))
}

pub(crate) fn item_label(item: &str, english: bool) -> &'static str {
    match (item, english) {
        ("generation", false) => "生成",
        ("prefill", false) => "预填充",
        ("gpu", false) => "GPU",
        ("vram", false) => "显存",
        ("temperature", false) => "温度",
        ("status", false) => "状态",
        ("generation", true) => "Gen",
        ("prefill", true) => "Prefill",
        ("gpu", true) => "GPU",
        ("vram", true) => "VRAM",
        ("temperature", true) => "Temp",
        _ => "Status",
    }
}

/// Menu wording is longer than the compact on-taskbar labels.
pub(crate) fn item_menu_label(item: &str, english: bool) -> &'static str {
    match (item, english) {
        ("generation", false) => "生成速度",
        ("prefill", false) => "预填充速度",
        ("gpu", false) => "GPU 负载",
        ("vram", false) => "显存占用",
        ("temperature", false) => "GPU 温度",
        ("status", false) => "服务状态",
        ("generation", true) => "Generation speed",
        ("prefill", true) => "Prefill speed",
        ("gpu", true) => "GPU load",
        ("vram", true) => "VRAM usage",
        ("temperature", true) => "GPU temperature",
        _ => "Service status",
    }
}

/// Worst-case value text: width depends on this, never on the live value,
/// so the widget does not jitter or re-attach every second.
fn template(item: &str, english: bool) -> &'static str {
    match (item, english) {
        ("generation" | "prefill", _) => "999.9 tok/s",
        ("gpu", _) => "100%",
        ("vram", _) => "99.9 GB",
        ("temperature", _) => "100℃",
        (_, false) => "正在载入模型",
        (_, true) => "Loading model",
    }
}

/// Estimated advance width in em for Segoe UI / Microsoft YaHei UI. Slightly
/// generous; the host additionally clips with an ellipsis.
pub(crate) fn text_width(text: &str, size: f32) -> f32 {
    text.chars()
        .map(|c| match c {
            ' ' | '.' | ',' | ':' | 'i' | 'l' | 'I' | '/' => 0.3,
            '0'..='9' => 0.56,
            '%' => 0.86,
            'm' | 'w' | 'M' | 'W' => 0.86,
            'A'..='Z' => 0.64,
            c if c.is_ascii() => 0.54,
            _ => 1.0,
        })
        .sum::<f32>()
        * size
        * 1.04
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Align {
    Left,
    Center,
    Right,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum Op {
    Ring {
        cx: f32,
        cy: f32,
        radius: f32,
        stroke: f32,
        fraction: Option<f32>,
        color: Color,
        track: Color,
    },
    Dot {
        cx: f32,
        cy: f32,
        radius: f32,
        color: Color,
    },
    Text {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
        text: String,
        size: i32,
        bold: bool,
        color: Color,
        align: Align,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct Layout {
    pub width: i32,
    pub height: i32,
    pub ops: Vec<Op>,
}

struct Metrics {
    scale: f32,
    height: i32,
    pad: f32,
    ring_diameter: f32,
    font: f32,
}

fn metrics(dpi: u32, bar_height: i32) -> Metrics {
    let scale = dpi.max(96) as f32 / 96.0;
    let min = (24.0 * scale).round() as i32;
    let max = (40.0 * scale).round() as i32;
    let height = (bar_height - (4.0 * scale).round() as i32).clamp(min, max);
    let h = height as f32;
    Metrics {
        scale,
        height,
        pad: 4.0 * scale,
        ring_diameter: (h - 6.0 * scale).min(32.0 * scale),
        font: ((h - 2.0 * scale) / 2.0 * 0.78).min(12.0 * scale).round(),
    }
}

/// Selected items in canonical order.
fn cells(prefs: &WidgetPrefs) -> Vec<&str> {
    prefs.items.iter().map(String::as_str).collect()
}

/// Width of every column for the selected items, at most two cells each.
fn columns(prefs: &WidgetPrefs, english: bool, m: &Metrics) -> Vec<f32> {
    let gap = 4.0 * m.scale;
    cells(prefs)
        .chunks(2)
        .map(|pair| {
            pair.iter()
                .map(|item| {
                    let label = if *item == "status" {
                        // Status shows a coloured dot instead of a label.
                        m.font * 0.7
                    } else {
                        text_width(item_label(item, english), m.font)
                    };
                    (label + gap + text_width(template(item, english), m.font)).ceil()
                })
                .fold(0.0, f32::max)
        })
        .collect()
}

pub(crate) fn size(prefs: &WidgetPrefs, english: bool, dpi: u32, bar_height: i32) -> (i32, i32) {
    let m = metrics(dpi, bar_height);
    let mut x = m.pad;
    if prefs.ring != "off" {
        x += m.ring_diameter;
    } else {
        // Status accent dot.
        x += 6.0 * m.scale;
    }
    let columns = columns(prefs, english, &m);
    for width in &columns {
        x += 8.0 * m.scale + width;
    }
    ((x + m.pad).ceil() as i32, m.height)
}

pub(crate) fn layout(
    prefs: &WidgetPrefs,
    english: bool,
    dpi: u32,
    bar_height: i32,
    reading: &Reading,
    palette: &Palette,
) -> Layout {
    let m = metrics(dpi, bar_height);
    let (width, height) = size(prefs, english, dpi, bar_height);
    let h = height as f32;
    let tone = palette.tone(reading.tone);
    let mut ops = Vec::new();
    let mut x = m.pad;
    if let Some((fraction, label)) = ring_value(&prefs.ring, reading) {
        let d = m.ring_diameter;
        let stroke = (d * 0.11).max(2.5 * m.scale);
        let (cx, cy) = (x + d / 2.0, h / 2.0);
        ops.push(Op::Ring {
            cx,
            cy,
            radius: (d - stroke) / 2.0,
            stroke,
            fraction,
            color: tone,
            track: palette.track,
        });
        let size = (d * 0.36).round() as i32;
        ops.push(Op::Text {
            left: (cx - d / 2.0).floor() as i32,
            top: (cy - d / 2.0).floor() as i32,
            right: (cx + d / 2.0).ceil() as i32,
            bottom: (cy + d / 2.0).ceil() as i32,
            text: label,
            size,
            bold: true,
            color: palette.text,
            align: Align::Center,
        });
        x += d;
    } else {
        let radius = 2.5 * m.scale;
        ops.push(Op::Dot {
            cx: x + radius,
            cy: h / 2.0,
            radius,
            color: tone,
        });
        x += 6.0 * m.scale;
    }
    let gap = 4.0 * m.scale;
    let line = h / 2.0;
    let items = cells(prefs);
    for (pair, column) in items.chunks(2).zip(columns(prefs, english, &m)) {
        x += 8.0 * m.scale;
        for (row, item) in pair.iter().enumerate() {
            let top = if pair.len() == 1 {
                (h - line) / 2.0
            } else {
                row as f32 * line
            };
            let (top, bottom) = (top.round() as i32, (top + line).round() as i32);
            let left = x.round() as i32;
            let right = (x + column).round() as i32;
            let (value, color) = match *item {
                "generation" => (speed(reading.generation), palette.text),
                "prefill" => (speed(reading.prefill), palette.text),
                "gpu" => (percent(reading.gpu), palette.text),
                "vram" => (gigabytes(reading.vram_used), palette.text),
                "temperature" => (
                    celsius(reading.temperature),
                    reading
                        .temperature
                        .map(|t| palette.temperature(t))
                        .unwrap_or(palette.muted),
                ),
                _ => (
                    if reading.state.trim().is_empty() {
                        if english { "Waiting" } else { "等待采样" }.to_owned()
                    } else {
                        reading.state.to_owned()
                    },
                    palette.text,
                ),
            };
            if *item == "status" {
                let radius = 3.0 * m.scale;
                ops.push(Op::Dot {
                    cx: x + radius,
                    cy: (top + bottom) as f32 / 2.0,
                    radius,
                    color: tone,
                });
                ops.push(Op::Text {
                    left: (x + m.font * 0.7 + gap).round() as i32,
                    top,
                    right,
                    bottom,
                    text: value,
                    size: m.font as i32,
                    bold: false,
                    color,
                    align: Align::Left,
                });
                continue;
            }
            let label = item_label(item, english);
            ops.push(Op::Text {
                left,
                top,
                right: (x + text_width(label, m.font)).ceil() as i32,
                bottom,
                text: label.into(),
                size: m.font as i32,
                bold: false,
                color: palette.muted,
                align: Align::Left,
            });
            ops.push(Op::Text {
                left: (x + text_width(label, m.font) + gap).round() as i32,
                top,
                right,
                bottom,
                text: value,
                size: m.font as i32,
                bold: false,
                color,
                align: Align::Right,
            });
        }
        x += column;
    }
    Layout { width, height, ops }
}

/// Points for the host's physical hit-test probe: the widget corners' inner
/// grid plus the centre of every drawn element.
pub(crate) fn probe_points(layout: &Layout) -> Vec<(i32, i32)> {
    let mut points = Vec::new();
    for x in [1, 2, 3] {
        for y in [1, 2, 3] {
            points.push((layout.width * x / 4, layout.height * y / 4));
        }
    }
    for op in &layout.ops {
        let point = match op {
            Op::Ring { cx, cy, .. } | Op::Dot { cx, cy, .. } => (*cx as i32, *cy as i32),
            Op::Text {
                left,
                top,
                right,
                bottom,
                ..
            } => ((left + right) / 2, (top + bottom) / 2),
        };
        if !points.contains(&point) {
            points.push(point);
        }
    }
    points
}

/// A premultiplied BGRA canvas, the format UpdateLayeredWindow consumes.
pub(crate) struct Canvas {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<u8>,
}

impl Canvas {
    /// `background` alpha 1 keeps a "transparent" layered window hit-testable.
    pub fn new(width: i32, height: i32, background: Color) -> Self {
        let (width, height) = (width.max(1) as usize, height.max(1) as usize);
        let [r, g, b, a] = background.0;
        let p = |c: u8| ((u16::from(c) * u16::from(a) + 127) / 255) as u8;
        let pixel = [p(b), p(g), p(r), a];
        Self {
            width,
            height,
            pixels: pixel.repeat(width * height),
        }
    }

    /// Source-over blend of a straight colour at `coverage` (0..=1).
    pub fn blend(&mut self, x: usize, y: usize, color: Color, coverage: f32) {
        if x >= self.width || y >= self.height || coverage <= 0.0 {
            return;
        }
        let alpha = f32::from(color.0[3]) / 255.0 * coverage.min(1.0);
        let index = (y * self.width + x) * 4;
        let source = [color.0[2], color.0[1], color.0[0]];
        for (pixel, source) in self.pixels[index..index + 3].iter_mut().zip(source) {
            *pixel = (f32::from(source) * alpha + f32::from(*pixel) * (1.0 - alpha)).round() as u8;
        }
        let dst = f32::from(self.pixels[index + 3]);
        self.pixels[index + 3] = (255.0 * alpha + dst * (1.0 - alpha)).round() as u8;
    }

    /// Coverage mask (one byte per canvas pixel) tinted with `color`; used for
    /// grayscale-antialiased text rendered by GDI into an offscreen mask.
    pub fn blend_mask(&mut self, mask: &[u8], color: Color) {
        for (index, coverage) in mask.iter().enumerate().take(self.width * self.height) {
            if *coverage > 0 {
                self.blend(
                    index % self.width,
                    index / self.width,
                    color,
                    f32::from(*coverage) / 255.0,
                );
            }
        }
    }
}

/// Anti-aliased rasterisation of the non-text operations.
pub(crate) fn raster_shapes(canvas: &mut Canvas, ops: &[Op]) {
    for op in ops {
        match *op {
            Op::Ring {
                cx,
                cy,
                radius,
                stroke,
                fraction,
                color,
                track,
            } => {
                let sweep = fraction.unwrap_or(0.0) * std::f32::consts::TAU;
                each_pixel(canvas, cx, cy, radius + stroke, |canvas, x, y, dx, dy| {
                    let distance = (dx * dx + dy * dy).sqrt();
                    let radial = (stroke / 2.0 + 0.5 - (distance - radius).abs()).clamp(0.0, 1.0);
                    if radial <= 0.0 {
                        return;
                    }
                    canvas.blend(x, y, track, radial);
                    // Clockwise from 12 o'clock, antialiased along the arc end.
                    let mut angle = dx.atan2(-dy);
                    if angle < 0.0 {
                        angle += std::f32::consts::TAU;
                    }
                    let along = ((sweep - angle) * distance + 0.5).clamp(0.0, 1.0);
                    let coverage = radial * along;
                    if sweep > 0.0 && coverage > 0.0 {
                        canvas.blend(x, y, color, coverage);
                    }
                });
            }
            Op::Dot {
                cx,
                cy,
                radius,
                color,
            } => each_pixel(canvas, cx, cy, radius + 1.0, |canvas, x, y, dx, dy| {
                let coverage = (radius + 0.5 - (dx * dx + dy * dy).sqrt()).clamp(0.0, 1.0);
                canvas.blend(x, y, color, coverage);
            }),
            Op::Text { .. } => {}
        }
    }
}

fn each_pixel(
    canvas: &mut Canvas,
    cx: f32,
    cy: f32,
    extent: f32,
    mut visit: impl FnMut(&mut Canvas, usize, usize, f32, f32),
) {
    let x0 = (cx - extent).floor().max(0.0) as usize;
    let y0 = (cy - extent).floor().max(0.0) as usize;
    let x1 = ((cx + extent).ceil().max(0.0) as usize).min(canvas.width);
    let y1 = ((cy + extent).ceil().max(0.0) as usize).min(canvas.height);
    for y in y0..y1 {
        for x in x0..x1 {
            visit(canvas, x, y, x as f32 + 0.5 - cx, y as f32 + 0.5 - cy);
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum MenuEntry {
    Command {
        id: u32,
        label: String,
    },
    Toggle {
        id: u32,
        label: String,
        checked: bool,
    },
    Radio {
        id: u32,
        label: String,
        checked: bool,
    },
    Header {
        label: String,
    },
    Separator,
    Submenu {
        label: String,
        entries: Vec<MenuEntry>,
    },
}

pub(crate) const MENU_OPEN: u32 = 1;
pub(crate) const MENU_FLOATING: u32 = 2;
pub(crate) const MENU_CLOSE: u32 = 3;
pub(crate) const MENU_SETTINGS: u32 = 4;
const MENU_ITEM: u32 = 100;
const MENU_RING: u32 = 200;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum MenuAction {
    Open,
    Floating,
    Close,
    Settings,
    Update(WidgetPrefs),
    Nothing,
}

pub(crate) fn menu(prefs: &WidgetPrefs, english: bool, temperature: bool) -> Vec<MenuEntry> {
    let t = |cn: &str, en: &str| if english { en } else { cn }.to_owned();
    let mut custom: Vec<MenuEntry> = ITEMS
        .iter()
        .enumerate()
        // Temperature is offered only when the GPU reports it, unless it is
        // already selected (so it can always be switched off again).
        .filter(|(_, item)| **item != "temperature" || temperature || prefs.has(item))
        .map(|(index, item)| MenuEntry::Toggle {
            id: MENU_ITEM + index as u32,
            label: item_menu_label(item, english).into(),
            checked: prefs.has(item),
        })
        .collect();
    custom.push(MenuEntry::Separator);
    custom.push(MenuEntry::Header {
        label: t("圆环显示", "Ring shows"),
    });
    for (index, ring) in RINGS.iter().enumerate() {
        custom.push(MenuEntry::Radio {
            id: MENU_RING + index as u32,
            label: match *ring {
                "gpu" => t("GPU 负载", "GPU load"),
                "vram" => t("显存占用", "VRAM usage"),
                _ => t("不显示圆环", "No ring"),
            },
            checked: prefs.ring == *ring,
        });
    }
    custom.push(MenuEntry::Separator);
    custom.push(MenuEntry::Command {
        id: MENU_SETTINGS,
        label: t("更多设置…", "More settings…"),
    });
    vec![
        MenuEntry::Command {
            id: MENU_OPEN,
            label: t("打开 Strata Manager", "Open Strata Manager"),
        },
        MenuEntry::Submenu {
            label: t("自定义内容", "Customize"),
            entries: custom,
        },
        MenuEntry::Separator,
        MenuEntry::Command {
            id: MENU_FLOATING,
            label: t("切换为桌面浮条", "Switch to desktop strip"),
        },
        MenuEntry::Command {
            id: MENU_CLOSE,
            label: t("关闭任务栏监控", "Close taskbar monitor"),
        },
    ]
}

/// Applies a menu command. Removing the last visible element is refused so
/// the widget never becomes an empty, unclickable strip.
pub(crate) fn apply(prefs: &WidgetPrefs, id: u32) -> MenuAction {
    let mut next = prefs.clone();
    match id {
        MENU_OPEN => return MenuAction::Open,
        MENU_FLOATING => return MenuAction::Floating,
        MENU_CLOSE => return MenuAction::Close,
        MENU_SETTINGS => return MenuAction::Settings,
        _ => {}
    }
    if let Some(item) = id
        .checked_sub(MENU_ITEM)
        .and_then(|index| ITEMS.get(index as usize))
    {
        if next.has(item) {
            next.items.retain(|x| x != item);
        } else {
            next.items.push((*item).into());
        }
    } else if let Some(ring) = id
        .checked_sub(MENU_RING)
        .and_then(|index| RINGS.get(index as usize))
    {
        next.ring = (*ring).into();
    } else {
        return MenuAction::Nothing;
    }
    if next.ring == "off" && next.items.is_empty() {
        return MenuAction::Nothing;
    }
    let next = WidgetPrefs::normalize(&serde_json::to_value(&next).unwrap_or(Value::Null));
    if next == *prefs {
        MenuAction::Nothing
    } else {
        MenuAction::Update(next)
    }
}

#[cfg(test)]
#[path = "taskbar_widget_tests.rs"]
mod tests;
