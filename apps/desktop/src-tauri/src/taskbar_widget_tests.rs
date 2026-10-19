use super::*;
use serde_json::json;

fn prefs(ring: &str, items: &[&str]) -> WidgetPrefs {
    WidgetPrefs::normalize(&json!({"ring":ring,"items":items}))
}

fn busy() -> Reading<'static> {
    Reading {
        generation: Some(21.34),
        prefill: Some(3_180.0),
        gpu: Some(76.4),
        vram_used: Some(19.8),
        vram_total: Some(24.0),
        temperature: Some(52.0),
        state: "生成中",
        tone: Tone::Busy,
    }
}

fn texts(layout: &Layout) -> Vec<&str> {
    layout
        .ops
        .iter()
        .filter_map(|op| match op {
            Op::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

#[test]
fn defaults_are_gpu_ring_with_generation_and_prefill() {
    let defaults = WidgetPrefs::normalize(&Value::Null);
    assert_eq!(defaults, WidgetPrefs::default());
    assert_eq!(defaults.ring, "gpu");
    assert_eq!(defaults.items, vec!["generation", "prefill"]);
    assert!(defaults.valid());
}

#[test]
fn normalize_filters_dedupes_orders_and_never_returns_an_empty_widget() {
    let value = json!({"ring":"cpu","items":["status","bad","gpu","status",3,"generation"]});
    let normalized = WidgetPrefs::normalize(&value);
    assert_eq!(normalized.ring, "gpu");
    assert_eq!(normalized.items, vec!["generation", "gpu", "status"]);
    // An explicit empty list is respected while the ring stays visible.
    assert!(prefs("vram", &[]).items.is_empty());
    assert_eq!(prefs("vram", &[]).ring, "vram");
    // ...but no ring and no items falls back to the GPU ring.
    assert_eq!(prefs("off", &[]).ring, "gpu");
    assert!(!WidgetPrefs {
        ring: "off".into(),
        items: vec![]
    }
    .valid());
    assert!(!WidgetPrefs {
        ring: "gpu".into(),
        items: vec!["prefill".into(), "generation".into()]
    }
    .valid());
    assert!(serde_json::from_value::<WidgetPrefs>(json!({"ring":"gpu","items":[],"x":1})).is_err());
}

#[test]
fn formats_numbers_compactly_without_decimals_above_100() {
    for (value, text) in [
        (0.0, "0.0"),
        (21.34, "21.3"),
        (99.94, "99.9"),
        (99.96, "100"),
        (128.4, "128"),
        (999.4, "999"),
        (999.6, "1.0k"),
        (3_180.0, "3.2k"),
        (12_400.0, "12k"),
        (2_500_000.0, "2.5M"),
    ] {
        assert_eq!(tokens(Some(value)), text, "{value}");
        assert!(tokens(Some(value)).chars().count() <= 4 || value >= 1e6);
    }
    for invalid in [None, Some(f64::NAN), Some(-1.0), Some(f64::INFINITY)] {
        assert_eq!(tokens(invalid), "—");
        assert_eq!(whole(invalid), "—");
        assert_eq!(gib(invalid), "—");
    }
    assert_eq!(whole(Some(52.4)), "52");
    assert_eq!(gib(Some(19.84)), "19.8");
    assert_eq!(gib(Some(140.0)), "140");
}

fn text_ops(layout: &Layout) -> Vec<(&str, i32, i32, i32, i32, Color)> {
    layout
        .ops
        .iter()
        .filter_map(|op| match op {
            Op::Text {
                text,
                left,
                top,
                right,
                bottom,
                color,
                ..
            } => Some((text.as_str(), *left, *top, *right, *bottom, *color)),
            _ => None,
        })
        .collect()
}

#[test]
fn each_metric_is_a_value_over_label_column_in_its_own_colour() {
    let palette = Palette::new(true);
    let layout = layout(&WidgetPrefs::default(), false, 96, 48, &busy(), &palette);
    assert_eq!(
        texts(&layout),
        vec!["76", "21.3", "t/s", "生成", "3.2k", "t/s", "预填充"]
    );
    assert_eq!(layout.height, 40);
    let ops = text_ops(&layout);
    let (gen, gen_unit, gen_label) = (ops[1], ops[2], ops[3]);
    // Label sits directly below the value, inside the same column.
    assert!(gen_label.2 >= gen.4 - 1, "{gen:?} {gen_label:?}");
    assert!(
        gen_label.1 <= gen.1 && gen_label.3 >= gen_unit.3,
        "{gen:?} {gen_unit:?} {gen_label:?}"
    );
    // Unit follows the number on the same line.
    assert!(gen_unit.1 >= gen.3 && gen_unit.4 <= gen.4);
    assert_eq!(gen.5, palette.metric("generation"));
    assert_eq!(gen_unit.5, palette.metric("generation"));
    assert_eq!(gen_label.5, palette.muted);
    assert_eq!(ops[4].5, palette.metric("prefill"));
    assert_ne!(palette.metric("generation"), palette.metric("prefill"));
    // Ring uses the GPU metric colour; the status dot carries the tone.
    let Op::Ring { color, track, .. } = &layout.ops[0] else {
        panic!("ring first")
    };
    assert_eq!(*color, palette.metric("gpu"));
    assert!(track.0[3] <= 48);
    assert!(layout
        .ops
        .iter()
        .any(|op| matches!(op, Op::Dot { color, halo, .. } if *color == palette.tone(Tone::Busy) && *halo > 0.0)));
}

#[test]
fn default_widget_is_narrower_than_the_previous_two_line_design() {
    // The previous "label value" rows measured 156 px at 100 %.
    let (width, _) = size(&WidgetPrefs::default(), false, 96, 48);
    assert!(width <= 140, "width {width}");
    assert!(width >= 110, "width {width}");
    let (wide, _) = size(&WidgetPrefs::default(), false, 144, 72);
    assert!(
        (wide as f32 - width as f32 * 1.5).abs() <= 4.0,
        "{wide} vs {width}"
    );
}

#[test]
fn columns_have_fixed_widths_so_values_do_not_jitter() {
    let prefs = prefs(
        "gpu",
        &["generation", "prefill", "gpu", "vram", "temperature"],
    );
    let palette = Palette::new(false);
    let mut previous: Option<Vec<(i32, i32)>> = None;
    for (generation, prefill, gpu) in [(0.4, 9.0, 1.0), (99.9, 999.0, 100.0), (8.1, 31_000.0, 55.0)]
    {
        let reading = Reading {
            generation: Some(generation),
            prefill: Some(prefill),
            gpu: Some(gpu),
            ..busy()
        };
        let layout = layout(&prefs, false, 96, 48, &reading, &palette);
        let rects: Vec<_> = text_ops(&layout).iter().map(|op| (op.1, op.3)).collect();
        if let Some(previous) = &previous {
            assert_eq!(previous, &rects);
        }
        previous = Some(rects);
    }
    // Missing values fall back to the neutral colour, not the metric hue.
    let quiet = Reading {
        state: "未启动",
        ..Reading::default()
    };
    let layout = layout(&WidgetPrefs::default(), false, 96, 48, &quiet, &palette);
    assert_eq!(text_ops(&layout)[1].0, "—");
    assert_eq!(text_ops(&layout)[1].5, palette.muted);
}

#[test]
fn temperature_is_graded_and_status_uses_tone_words() {
    for dark in [false, true] {
        let palette = Palette::new(dark);
        let green = palette.temperature(52.0);
        let amber = palette.temperature(70.0);
        let red = palette.temperature(85.0);
        assert_eq!(palette.temperature(59.9), green);
        assert_eq!(palette.temperature(60.0), amber);
        assert_eq!(palette.temperature(80.0), amber);
        assert_eq!(palette.temperature(80.1), red);
        assert!(green != amber && amber != red);
    }
    let palette = Palette::new(true);
    let layout = layout(
        &prefs("off", &["temperature", "status"]),
        false,
        96,
        48,
        &busy(),
        &palette,
    );
    assert!(text_ops(&layout)
        .iter()
        .any(|op| op.0 == "52" && op.5 == palette.temperature(52.0)));
    assert!(text_ops(&layout).iter().any(|op| op.0 == "℃"));
    assert!(text_ops(&layout)
        .iter()
        .any(|op| op.0 == "运行中" && op.5 == palette.tone(Tone::Busy)));
    assert!(texts(&layout).contains(&"温度") && texts(&layout).contains(&"状态"));
    // With the status column shown there is no extra accent dot.
    assert!(!layout.ops.iter().any(|op| matches!(op, Op::Dot { .. })));
}

fn contrast(a: Color, b: Color) -> f64 {
    let luminance = |c: Color| {
        let channel = |v: u8| {
            let v = f64::from(v) / 255.0;
            if v <= 0.039_28 {
                v / 12.92
            } else {
                ((v + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * channel(c.0[0]) + 0.7152 * channel(c.0[1]) + 0.0722 * channel(c.0[2])
    };
    let (x, y) = (luminance(a), luminance(b));
    (x.max(y) + 0.05) / (x.min(y) + 0.05)
}

#[test]
fn value_colours_reach_4_5_to_1_on_win11_light_and_dark_taskbars() {
    for (dark, background) in [(false, TASKBAR_LIGHT), (true, TASKBAR_DARK)] {
        let palette = Palette::new(dark);
        let mut colours = vec![palette.text, palette.muted];
        colours.extend(["generation", "prefill", "gpu", "vram"].map(|m| palette.metric(m)));
        colours.extend([40.0, 70.0, 90.0].map(|t| palette.temperature(t)));
        colours.extend(
            [
                Tone::Stopped,
                Tone::Loading,
                Tone::Ready,
                Tone::Busy,
                Tone::Error,
            ]
            .map(|t| palette.tone(t)),
        );
        for colour in colours {
            assert_eq!(colour.0[3], 255);
            let ratio = contrast(colour, background);
            assert!(ratio >= 4.5, "{colour:?} on {background:?}: {ratio:.2}");
        }
        let metrics: std::collections::HashSet<_> = ["generation", "prefill", "gpu", "vram"]
            .map(|m| palette.metric(m))
            .into_iter()
            .collect();
        assert_eq!(metrics.len(), 4);
    }
}

#[test]
fn ring_uses_selected_metric_and_handles_missing_totals() {
    let reading = busy();
    assert_eq!(
        ring_value("gpu", &reading),
        Some((Some(0.764), "76".into()))
    );
    let (fraction, label) = ring_value("vram", &reading).unwrap();
    assert!((fraction.unwrap() - 0.825).abs() < 1e-4);
    assert_eq!(label, "83");
    let no_total = Reading {
        vram_total: None,
        ..reading
    };
    assert_eq!(ring_value("vram", &no_total), Some((None, "–".into())));
    assert_eq!(ring_value("off", &reading), None);
    let over = Reading {
        gpu: Some(400.0),
        ..reading
    };
    assert_eq!(ring_value("gpu", &over).unwrap().0, Some(1.0));
}

#[test]
fn every_operation_stays_inside_the_widget() {
    for dpi in [96, 120, 144, 192] {
        for bar in [30, 40, 48, 72] {
            let all = prefs("vram", &ITEMS);
            let layout = layout(
                &all,
                true,
                dpi,
                bar * dpi as i32 / 96,
                &busy(),
                &Palette::new(false),
            );
            for op in &layout.ops {
                match op {
                    Op::Text {
                        left,
                        top,
                        right,
                        bottom,
                        ..
                    } => {
                        assert!(*left >= 0 && *top >= 0, "{op:?}");
                        assert!(*right <= layout.width && *bottom <= layout.height, "{op:?}");
                        assert!(left < right && top < bottom, "{op:?}");
                    }
                    Op::Ring {
                        cx,
                        cy,
                        radius,
                        stroke,
                        ..
                    } => {
                        assert!(cx - radius - stroke / 2.0 >= 0.0);
                        assert!(cy - radius - stroke / 2.0 >= 0.0);
                        assert!(cy + radius + stroke / 2.0 <= layout.height as f32);
                    }
                    Op::Dot { .. } => {}
                }
            }
            assert!(layout.height <= bar * dpi as i32 / 96);
        }
    }
}

#[test]
fn width_depends_on_items_and_dpi_but_not_on_values() {
    let base = WidgetPrefs::default();
    let (w, h) = size(&base, false, 96, 48);
    let quiet = Reading {
        state: "未启动",
        ..Reading::default()
    };
    assert_eq!(
        layout(&base, false, 96, 48, &quiet, &Palette::new(true)).width,
        layout(&base, false, 96, 48, &busy(), &Palette::new(true)).width
    );
    let (w150, h150) = size(&base, false, 144, 72);
    assert!(w150 as f32 > w as f32 * 1.4 && h150 as f32 >= h as f32 * 1.4);
    // Adding a third item adds a column; a fourth fits under it.
    let three = size(
        &prefs("gpu", &["generation", "prefill", "temperature"]),
        false,
        96,
        48,
    )
    .0;
    let four = size(
        &prefs("gpu", &["generation", "prefill", "gpu", "temperature"]),
        false,
        96,
        48,
    )
    .0;
    assert!(three > w);
    assert!(four >= three);
    // Removing the ring narrows the widget.
    assert!(size(&prefs("off", &["generation", "prefill"]), false, 96, 48).0 < w);
    // A ring-only widget is compact.
    assert!(size(&prefs("gpu", &[]), false, 96, 48).0 <= 40);
}

#[test]
fn probe_points_cover_each_element_inside_bounds() {
    let layout = layout(
        &prefs("gpu", &ITEMS),
        false,
        144,
        72,
        &busy(),
        &Palette::new(true),
    );
    let points = probe_points(&layout);
    assert!(points.len() > 9);
    assert!(points
        .iter()
        .all(|(x, y)| (0..layout.width).contains(x) && (0..layout.height).contains(y)));
}

#[test]
fn ring_raster_fills_clockwise_from_top_and_keeps_background_hit_testable() {
    let palette = Palette::new(true);
    let op = Op::Ring {
        cx: 20.0,
        cy: 20.0,
        radius: 15.0,
        stroke: 4.0,
        fraction: Some(0.25),
        color: rgb(0xff0000),
        track: palette.track,
    };
    let mut canvas = Canvas::new(40, 40, Color([0, 0, 0, 1]));
    raster_shapes(&mut canvas, &[op]);
    let at = |x: usize, y: usize| {
        let i = (y * 40 + x) * 4;
        [
            canvas.pixels[i],
            canvas.pixels[i + 1],
            canvas.pixels[i + 2],
            canvas.pixels[i + 3],
        ]
    };
    // Upper-right quadrant (12→3 o'clock) is red: BGRA premultiplied.
    let ne = at(30, 9);
    assert!(ne[2] > 200 && ne[0] < 40 && ne[3] > 200, "{ne:?}");
    // Lower-left quadrant is only the faint track.
    let sw = at(9, 30);
    assert!(sw[2] < 120 && sw[3] < 120 && sw[3] > 10, "{sw:?}");
    // Centre and corners keep alpha 1: invisible but still hit-testable.
    assert_eq!(at(20, 20), [0, 0, 0, 1]);
    assert_eq!(at(0, 0), [0, 0, 0, 1]);
    // Premultiplied invariant.
    assert!(canvas
        .pixels
        .chunks(4)
        .all(|p| p[0] <= p[3] && p[1] <= p[3] && p[2] <= p[3]));
}

#[test]
fn mask_blend_tints_text_coverage() {
    let mut canvas = Canvas::new(2, 1, Color([0, 0, 0, 1]));
    canvas.blend_mask(&[255, 0], rgb(0xffffff));
    assert_eq!(&canvas.pixels[..4], &[255, 255, 255, 255]);
    assert_eq!(&canvas.pixels[4..], &[0, 0, 0, 1]);
    let opaque = Canvas::new(1, 1, rgb(0x202020));
    assert_eq!(opaque.pixels, vec![0x20, 0x20, 0x20, 255]);
}

fn ids(entries: &[MenuEntry]) -> Vec<(u32, bool)> {
    let mut found = Vec::new();
    for entry in entries {
        match entry {
            MenuEntry::Toggle { id, checked, .. } | MenuEntry::Radio { id, checked, .. } => {
                found.push((*id, *checked))
            }
            MenuEntry::Submenu { entries, .. } => found.extend(ids(entries)),
            _ => {}
        }
    }
    found
}

#[test]
fn menu_lists_open_customize_and_close_with_checked_state() {
    let entries = menu(&WidgetPrefs::default(), false, true);
    let MenuEntry::Command { id, label } = &entries[0] else {
        panic!("open first")
    };
    assert_eq!((*id, label.as_str()), (MENU_OPEN, "打开 Strata Manager"));
    let MenuEntry::Submenu {
        label,
        entries: custom,
    } = &entries[1]
    else {
        panic!("submenu second")
    };
    assert_eq!(label, "自定义内容");
    let labels: Vec<_> = custom
        .iter()
        .filter_map(|e| match e {
            MenuEntry::Toggle { label, .. } => Some(label.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        labels,
        vec![
            "生成速度",
            "预填充速度",
            "GPU 负载",
            "显存占用",
            "GPU 温度",
            "服务状态"
        ]
    );
    assert!(
        matches!(entries.last(), Some(MenuEntry::Command { id: MENU_CLOSE, label }) if label == "关闭任务栏监控")
    );
    let checked = ids(&entries);
    assert!(checked.contains(&(100, true)) && checked.contains(&(101, true)));
    assert!(checked.contains(&(102, false)));
    assert!(checked.contains(&(200, true)) && checked.contains(&(201, false)));
    // Temperature appears only when available or already selected.
    assert!(!ids(&menu(&WidgetPrefs::default(), true, false))
        .iter()
        .any(|(id, _)| *id == 104));
    assert!(ids(&menu(&prefs("gpu", &["temperature"]), true, false)).contains(&(104, true)));
}

#[test]
fn menu_commands_toggle_items_switch_ring_and_change_width() {
    let base = WidgetPrefs::default();
    let MenuAction::Update(with_gpu) = apply(&base, 102) else {
        panic!("gpu toggles on")
    };
    assert_eq!(with_gpu.items, vec!["generation", "prefill", "gpu"]);
    assert!(size(&with_gpu, false, 96, 48).0 > size(&base, false, 96, 48).0);
    let MenuAction::Update(without_prefill) = apply(&with_gpu, 101) else {
        panic!("prefill toggles off")
    };
    assert_eq!(without_prefill.items, vec!["generation", "gpu"]);
    let MenuAction::Update(vram) = apply(&base, 201) else {
        panic!("ring switches")
    };
    assert_eq!(vram.ring, "vram");
    assert_eq!(apply(&base, 200), MenuAction::Nothing);
    assert_eq!(apply(&base, MENU_OPEN), MenuAction::Open);
    assert_eq!(apply(&base, MENU_CLOSE), MenuAction::Close);
    assert_eq!(apply(&base, MENU_FLOATING), MenuAction::Floating);
    assert_eq!(apply(&base, MENU_SETTINGS), MenuAction::Settings);
    assert_eq!(apply(&base, 0), MenuAction::Nothing);
    assert_eq!(apply(&base, 106), MenuAction::Nothing);
    assert_eq!(apply(&base, 203), MenuAction::Nothing);
    // The last visible element cannot be removed.
    let ring_only = prefs("off", &["generation"]);
    assert_eq!(apply(&ring_only, 100), MenuAction::Nothing);
    let gpu_only = prefs("gpu", &[]);
    assert_eq!(apply(&gpu_only, 202), MenuAction::Nothing);
    // Every update stays canonical so the settings page round-trips it.
    let MenuAction::Update(reordered) = apply(&prefs("gpu", &["status"]), 100) else {
        panic!()
    };
    assert_eq!(reordered.items, vec!["generation", "status"]);
    assert!(reordered.valid());
}

/// Writes display lists and rasterised shapes for the offscreen previews:
/// `STRATA_WIDGET_PREVIEW_DIR=/tmp/out cargo test widget_preview_export`.
#[test]
fn widget_preview_export() {
    let Some(dir) = std::env::var_os("STRATA_WIDGET_PREVIEW_DIR") else {
        return;
    };
    let dir = std::path::PathBuf::from(dir);
    std::fs::create_dir_all(&dir).unwrap();
    let idle = Reading {
        generation: None,
        prefill: None,
        gpu: Some(9.0),
        vram_used: Some(19.8),
        vram_total: Some(24.0),
        temperature: Some(44.0),
        state: "空闲",
        tone: Tone::Ready,
    };
    let reading_state = Reading {
        generation: None,
        prefill: Some(2_840.0),
        gpu: Some(97.0),
        state: "读取中",
        temperature: Some(81.0),
        ..busy()
    };
    let cases: Vec<(&str, WidgetPrefs, Reading)> = vec![
        ("default-generating", WidgetPrefs::default(), busy()),
        ("default-prefill", WidgetPrefs::default(), reading_state),
        ("default-idle", WidgetPrefs::default(), idle),
        (
            "vram-ring-gpu-temp",
            prefs("vram", &["generation", "prefill", "gpu", "temperature"]),
            busy(),
        ),
        (
            "no-ring-status",
            prefs("off", &["generation", "vram", "status"]),
            busy(),
        ),
        (
            "stopped",
            WidgetPrefs::default(),
            Reading {
                state: "未启动",
                ..Reading::default()
            },
        ),
    ];
    let mut index = Vec::new();
    for (name, prefs, reading) in cases {
        for dark in [false, true] {
            for (dpi, bar) in [(96u32, 48), (144, 72)] {
                let palette = Palette::new(dark);
                let layout = layout(&prefs, false, dpi, bar, &reading, &palette);
                let mut canvas = Canvas::new(layout.width, layout.height, Color([0, 0, 0, 0]));
                raster_shapes(&mut canvas, &layout.ops);
                let file = format!(
                    "{name}-{}-{}.bgra",
                    if dark { "dark" } else { "light" },
                    dpi * 100 / 96
                );
                std::fs::write(dir.join(&file), &canvas.pixels).unwrap();
                index.push(json!({"name":name,"dark":dark,"scale":dpi*100/96,"bar":bar,"shapes":file,"layout":layout}));
            }
        }
    }
    let menus = json!({
        "zh": menu(&WidgetPrefs::default(), false, true),
        "en": menu(&WidgetPrefs::default(), true, true),
    });
    std::fs::write(
        dir.join("index.json"),
        serde_json::to_vec_pretty(&json!({"cases":index,"menus":menus})).unwrap(),
    )
    .unwrap();
}
