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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
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
    /// Neutral secondary colour for labels and units-free captions.
    pub muted: Color,
    pub track: Color,
    /// Used only when per-pixel transparency is unavailable.
    pub opaque_background: Color,
    dark: bool,
}

/// Typical Windows 11 taskbar colours; every value colour is tuned to keep a
/// WCAG contrast of at least 4.5:1 against the matching one.
pub(crate) const TASKBAR_LIGHT: Color = rgb(0xf3f3f3);
pub(crate) const TASKBAR_DARK: Color = rgb(0x202020);

impl Palette {
    /// `dark` describes the TASKBAR (SystemUsesLightTheme == 0), not the app.
    pub fn new(dark: bool) -> Self {
        if dark {
            Self {
                text: rgb(0xffffff),
                muted: rgb(0xb4b4b4),
                track: rgba(0xffffff, 40),
                opaque_background: TASKBAR_DARK,
                dark,
            }
        } else {
            Self {
                text: rgb(0x1a1a1a),
                muted: rgb(0x5c5c5c),
                track: rgba(0x000000, 28),
                opaque_background: TASKBAR_LIGHT,
                dark,
            }
        }
    }

    /// One hue per metric so a glance tells them apart; the label repeats it
    /// in words, so colour is never the only cue.
    pub fn metric(&self, item: &str) -> Color {
        match (item, self.dark) {
            ("generation", true) => rgb(0x4ade80),
            ("generation", false) => rgb(0x15803d),
            ("prefill", true) => rgb(0x60c8fa),
            ("prefill", false) => rgb(0x0369a1),
            ("gpu", true) => rgb(0xfb923c),
            ("gpu", false) => rgb(0xc2410c),
            ("vram", true) => rgb(0xc4a5fd),
            ("vram", false) => rgb(0x7e22ce),
            (_, true) => rgb(0xffffff),
            (_, false) => rgb(0x1a1a1a),
        }
    }

    pub fn tone(&self, tone: Tone) -> Color {
        match (tone, self.dark) {
            (Tone::Stopped, true) => rgb(0xa1a1aa),
            (Tone::Stopped, false) => rgb(0x5c5c5c),
            (Tone::Loading, true) => rgb(0x60c8fa),
            (Tone::Loading, false) => rgb(0x0369a1),
            (Tone::Ready, true) => rgb(0x4ade80),
            (Tone::Ready, false) => rgb(0x15803d),
            (Tone::Busy, true) => rgb(0xfacc15),
            (Tone::Busy, false) => rgb(0x9a5b00),
            (Tone::Error, true) => rgb(0xfb7185),
            (Tone::Error, false) => rgb(0xbe123c),
        }
    }

    /// Green below 60 ℃, amber from 60 to 80 ℃, red above 80 ℃.
    pub fn temperature(&self, celsius: f64) -> Color {
        match (celsius, self.dark) {
            (c, true) if c < 60.0 => rgb(0x4ade80),
            (c, false) if c < 60.0 => rgb(0x15803d),
            (c, true) if c <= 80.0 => rgb(0xfacc15),
            (c, false) if c <= 80.0 => rgb(0x9a5b00),
            (_, true) => rgb(0xfb7185),
            (_, false) => rgb(0xbe123c),
        }
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

/// Whole number ("76"), or a dash.
pub(crate) fn whole(value: Option<f64>) -> String {
    value
        .filter(|v| v.is_finite() && *v >= 0.0)
        .map(|v| format!("{v:.0}"))
        .unwrap_or_else(|| DASH.into())
}

/// GiB with one decimal below 100 ("19.8"), whole above ("140").
pub(crate) fn gib(value: Option<f64>) -> String {
    match value.filter(|v| v.is_finite() && *v >= 0.0) {
        Some(v) if v >= 99.95 => format!("{v:.0}"),
        Some(v) => format!("{v:.1}"),
        None => DASH.into(),
    }
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

/// Number part, unit part and worst-case template of each item. Width is
/// derived from the template, never from the live value, so it cannot jitter.
fn value_parts(item: &str, reading: &Reading, english: bool) -> (String, &'static str) {
    match item {
        "generation" => (tokens(reading.generation), "t/s"),
        "prefill" => (tokens(reading.prefill), "t/s"),
        "gpu" => (whole(reading.gpu.map(|v| v.min(100.0))), "%"),
        "vram" => (gib(reading.vram_used), "GB"),
        "temperature" => (whole(reading.temperature), "℃"),
        _ => (tone_word(reading.tone, english).into(), ""),
    }
}

fn template(item: &str, english: bool) -> (&'static str, &'static str) {
    match (item, english) {
        // tokens() never exceeds four glyphs: "99.9", "999", "9.9k", "99k".
        ("generation" | "prefill", _) => ("99.9", "t/s"),
        ("gpu", _) => ("100", "%"),
        ("vram", _) => ("99.9", "GB"),
        ("temperature", _) => ("100", "℃"),
        (_, false) => ("载入中", ""),
        (_, true) => ("Loading", ""),
    }
}

pub(crate) fn tone_word(tone: Tone, english: bool) -> &'static str {
    match (tone, english) {
        (Tone::Stopped, false) => "未启动",
        (Tone::Loading, false) => "载入中",
        (Tone::Ready, false) => "就绪",
        (Tone::Busy, false) => "运行中",
        (Tone::Error, false) => "异常",
        (Tone::Stopped, true) => "Off",
        (Tone::Loading, true) => "Loading",
        (Tone::Ready, true) => "Ready",
        (Tone::Busy, true) => "Busy",
        (Tone::Error, true) => "Error",
    }
}

/// Estimated advance width in em for Segoe UI / Microsoft YaHei UI. Slightly
/// generous; the host additionally clips with an ellipsis.
pub(crate) fn text_width(text: &str, size: f32) -> f32 {
    text.chars()
        .map(|c| match c {
            ' ' | '.' | ',' | ':' | 'i' | 'l' | 'I' | '/' => 0.3,
            't' | 'f' | 'r' | 'j' => 0.36,
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

/// Bold digits are a little wider than regular ones.
const BOLD: f32 = 1.06;

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
        /// Clears this much space around the dot (e.g. where it sits on the ring).
        halo: f32,
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
        /// Bottom-aligned (shared baseline for a number and its unit) instead
        /// of vertically centred.
        bottom_align: bool,
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
    gap: f32,
    ring_diameter: f32,
    value: f32,
    unit: f32,
    label: f32,
}

fn metrics(dpi: u32, bar_height: i32) -> Metrics {
    let scale = dpi.max(96) as f32 / 96.0;
    let min = (24.0 * scale).round() as i32;
    let max = (40.0 * scale).round() as i32;
    let height = (bar_height - (4.0 * scale).round() as i32).clamp(min, max);
    let h = height as f32;
    let value = (h * 0.36).min(14.0 * scale).round();
    Metrics {
        scale,
        height,
        pad: 3.0 * scale,
        gap: 6.0 * scale,
        ring_diameter: (h - 10.0 * scale).min(28.0 * scale),
        value,
        unit: (value * 0.66).round(),
        label: (h * 0.26).min(10.0 * scale).round(),
    }
}

/// One column per selected item: value (+ compact unit) over a small label.
struct Column {
    value: f32,
    unit: f32,
    width: f32,
}

fn column(item: &str, english: bool, m: &Metrics) -> Column {
    let (value, unit) = template(item, english);
    let bold = item != "status";
    let value = text_width(value, m.value) * if bold { BOLD } else { 1.0 };
    let unit = if unit.is_empty() {
        0.0
    } else {
        text_width(unit, m.unit) + m.scale
    };
    let label = text_width(item_label(item, english), m.label);
    let (value, unit) = (value.ceil(), unit.ceil());
    Column {
        value,
        unit,
        width: (value + unit).max(label.ceil()),
    }
}

pub(crate) fn size(prefs: &WidgetPrefs, english: bool, dpi: u32, bar_height: i32) -> (i32, i32) {
    let m = metrics(dpi, bar_height);
    let mut x = m.pad;
    let mut first = true;
    if prefs.ring != "off" {
        x += m.ring_diameter;
        first = false;
    } else if !prefs.has("status") {
        // Status accent dot.
        x += 6.0 * m.scale;
        first = false;
    }
    for item in &prefs.items {
        if !first {
            x += m.gap;
        }
        first = false;
        x += column(item, english, &m).width;
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
    let mut first = true;
    if let Some((fraction, label)) = ring_value(&prefs.ring, reading) {
        let d = m.ring_diameter;
        let stroke = (d * 0.11).max(2.5 * m.scale);
        let (cx, cy) = (x + d / 2.0, h / 2.0);
        let radius = (d - stroke) / 2.0;
        ops.push(Op::Ring {
            cx,
            cy,
            radius,
            stroke,
            fraction,
            color: palette.metric(&prefs.ring),
            track: palette.track,
        });
        ops.push(Op::Text {
            left: (cx - d / 2.0).floor() as i32,
            top: (cy - d / 2.0).floor() as i32,
            right: (cx + d / 2.0).ceil() as i32,
            bottom: (cy + d / 2.0).ceil() as i32,
            text: label,
            size: (d * 0.4).round() as i32,
            bold: true,
            color: palette.text,
            align: Align::Center,
            bottom_align: false,
        });
        if !prefs.has("status") {
            // Service state rides on the ring's lower-right edge.
            let offset = radius * std::f32::consts::FRAC_1_SQRT_2;
            ops.push(Op::Dot {
                cx: cx + offset,
                cy: cy + offset,
                radius: 2.5 * m.scale,
                color: tone,
                halo: 1.5 * m.scale,
            });
        }
        x += d;
        first = false;
    } else if !prefs.has("status") {
        let radius = 2.5 * m.scale;
        ops.push(Op::Dot {
            cx: x + radius,
            cy: h / 2.0,
            radius,
            color: tone,
            halo: 0.0,
        });
        x += 6.0 * m.scale;
        first = false;
    }
    // Value line and label line, centred as one block.
    let value_line = (m.value * 1.25).round();
    let label_line = (m.label * 1.3).round();
    let top = ((h - value_line - label_line) / 2.0).round();
    let (value_top, value_bottom) = (top as i32, (top + value_line) as i32);
    let label_bottom = (top + value_line + label_line) as i32;
    for item in &prefs.items {
        if !first {
            x += m.gap;
        }
        first = false;
        let column = column(item, english, &m);
        let (value, unit) = value_parts(item, reading, english);
        let color = match item.as_str() {
            "temperature" => reading
                .temperature
                .filter(|t| t.is_finite())
                .map(|t| palette.temperature(t))
                .unwrap_or(palette.muted),
            "status" => tone,
            _ if value == DASH => palette.muted,
            other => palette.metric(other),
        };
        // Digits are right-aligned against a fixed split so they never shift.
        let start = (x + (column.width - column.value - column.unit) / 2.0).round();
        let split = start + column.value;
        ops.push(Op::Text {
            left: start as i32,
            top: value_top,
            right: split as i32,
            bottom: value_bottom,
            text: value,
            size: m.value as i32,
            bold: item != "status",
            color,
            align: if unit.is_empty() {
                Align::Center
            } else {
                Align::Right
            },
            bottom_align: true,
        });
        if !unit.is_empty() {
            ops.push(Op::Text {
                left: (split + m.scale).round() as i32,
                top: value_top,
                right: (split + column.unit) as i32,
                bottom: value_bottom - (m.scale).round() as i32,
                text: unit.into(),
                size: m.unit as i32,
                bold: false,
                color,
                align: Align::Left,
                bottom_align: true,
            });
        }
        ops.push(Op::Text {
            left: x.floor() as i32,
            top: value_bottom,
            right: (x + column.width).ceil() as i32,
            bottom: label_bottom,
            text: item_label(item, english).into(),
            size: m.label as i32,
            bold: false,
            color: palette.muted,
            align: Align::Center,
            bottom_align: false,
        });
        x += column.width;
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
    background: [u8; 4],
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
            background: pixel,
        }
    }

    /// Fades a pixel back to the background (used to cut a gap around a dot).
    pub fn clear(&mut self, x: usize, y: usize, coverage: f32) {
        if x >= self.width || y >= self.height || coverage <= 0.0 {
            return;
        }
        let c = coverage.min(1.0);
        let index = (y * self.width + x) * 4;
        for (pixel, background) in self.pixels[index..index + 4]
            .iter_mut()
            .zip(self.background)
        {
            *pixel = (f32::from(*pixel) * (1.0 - c) + f32::from(background) * c).round() as u8;
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
                halo,
            } => each_pixel(
                canvas,
                cx,
                cy,
                radius + halo + 1.0,
                |canvas, x, y, dx, dy| {
                    let distance = (dx * dx + dy * dy).sqrt();
                    canvas.clear(x, y, (radius + halo + 0.5 - distance).clamp(0.0, 1.0));
                    canvas.blend(x, y, color, (radius + 0.5 - distance).clamp(0.0, 1.0));
                },
            ),
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
