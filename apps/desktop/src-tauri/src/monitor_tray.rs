//! Independent, read-only monitor: it never invokes supervisor recovery.
use crate::{floating_monitor, ClientState};
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use std::{sync::Mutex, time::Duration};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewWindow,
};
use tokio_util::sync::CancellationToken;

const ID: &str = "monitor-tray";
#[derive(Default)]
pub(crate) struct MonitorTrayState(Mutex<Option<CancellationToken>>);

pub(crate) fn enabled(settings: &Value) -> bool {
    settings["floatingMonitor"]["showInTray"].as_bool() == Some(true)
}

fn report(app: &AppHandle, result: Result<(), String>) {
    if let Err(error) = result {
        let _ = app.emit_to("main", "tray-action-error", error);
    }
}

fn restore(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = crate::taskbar_monitor::open_floating(&app).await;
        report(&app, result);
    });
}

async fn snapshot(app: &AppHandle) -> Result<Value, String> {
    let state = app.state::<ClientState>();
    let directory = state.ipc.data_dir.clone();
    let client = state.client.clone();
    floating_monitor::collect_snapshot(move |method, params| {
        let directory = directory.clone();
        let client = client.clone();
        async move { floating_monitor::read_existing(&directory, &client, method, params).await }
    })
    .await
}

pub(crate) fn apply(app: &AppHandle, settings: &Value) -> Result<(), String> {
    set_enabled(
        app,
        enabled(settings),
        crate::system_locale::uses_english_fallback(settings["language"].as_str()),
    )
}

fn set_enabled(app: &AppHandle, enable: bool, english: bool) -> Result<(), String> {
    let state = app.state::<MonitorTrayState>();
    let mut active = state.0.lock().map_err(|e| e.to_string())?;
    if !enable {
        if let Some(token) = active.take() {
            token.cancel();
        }
        app.remove_tray_by_id(ID);
        return Ok(());
    }
    if active.is_some() {
        return Ok(());
    }
    let label = |cn, en| if english { en } else { cn };
    let show = MenuItem::with_id(
        app,
        "monitor-show",
        label("显示浮动条", "Show monitor strip"),
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let main = MenuItem::with_id(
        app,
        "monitor-main",
        label("显示主窗口", "Show main window"),
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let benchmark = MenuItem::with_id(
        app,
        "monitor-benchmark",
        label("快速测速", "Quick speed test"),
        false,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let settings = MenuItem::with_id(
        app,
        "monitor-settings",
        label("自定义浮条", "Customize monitor"),
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let close = MenuItem::with_id(
        app,
        "monitor-close",
        label("关闭托盘监控", "Close tray monitor"),
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&show, &main, &benchmark, &settings, &close])
        .map_err(|e| e.to_string())?;
    let tray = TrayIconBuilder::with_id(ID)
        .icon(icon("-", [148, 163, 184]))
        .tooltip(label(
            "Strata 监控 · 正在读取状态",
            "Strata Monitor · Reading status",
        ))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                restore(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "monitor-show" => restore(app),
            "monitor-main" => report(app, floating_monitor::show_main(app, None)),
            "monitor-settings" => report(
                app,
                floating_monitor::show_main(app, Some("settings".into())),
            ),
            "monitor-benchmark" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    // Revalidate on click; an enabled menu can have become stale.
                    let value = snapshot(&app).await.unwrap_or(Value::Null);
                    if presentation(&value, false).can_benchmark {
                        report(
                            &app,
                            floating_monitor::show_main(&app, Some("quickBenchmark".into())),
                        );
                    } else {
                        report(&app, Err("服务未就绪或正在处理请求，暂时无法测速".into()));
                    }
                });
            }
            "monitor-close" => {
                report(app, set_enabled(app, false, false));
                report(
                    app,
                    app.emit_to("main", "monitor-tray-preference", false)
                        .map_err(|e| e.to_string()),
                );
            }
            _ => {}
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    let token = CancellationToken::new();
    *active = Some(token.clone());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let value = tokio::select! {
                _ = token.cancelled() => break,
                result = snapshot(&app) => result.unwrap_or(Value::Null),
            };
            let english = value["settings"]["language"]
                .as_str()
                .map(|language| crate::system_locale::uses_english_fallback(Some(language)))
                .unwrap_or(english);
            let view = presentation(&value, english);
            // Use this generation's handle, never look up a replacement by ID.
            // No native UI dispatch occurs while holding the lifecycle mutex.
            if token.is_cancelled() {
                break;
            }
            let _ = tray.set_icon(Some(icon(&view.digits, view.color)));
            let _ = tray.set_tooltip(Some(&view.tooltip));
            let _ = benchmark.set_enabled(view.can_benchmark);
            let label = |cn, en| if english { en } else { cn };
            let _ = show.set_text(label("显示浮动条", "Show monitor strip"));
            let _ = main.set_text(label("显示主窗口", "Show main window"));
            let _ = benchmark.set_text(label("快速测速", "Quick speed test"));
            let _ = settings.set_text(label("自定义浮条", "Customize monitor"));
            let _ = close.set_text(label("关闭托盘监控", "Close tray monitor"));
            let interval = value["settings"]["pollInterval"]
                .as_u64()
                .unwrap_or(2000)
                .clamp(1000, 60_000);
            tokio::select! {
                _ = token.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_millis(interval)) => {}
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn minimize_monitor_to_tray(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    if window.label() != floating_monitor::LABEL {
        return Err("该操作仅允许监控浮条调用".into());
    }
    let english = app
        .state::<ClientState>()
        .tray_english
        .load(std::sync::atomic::Ordering::Relaxed);
    set_enabled(&app, true, english)?;
    window.hide().map_err(|e| e.to_string())?;
    let _ = window.emit("monitor-suspended", ());
    crate::taskbar_monitor::notify_visibility(&app);
    app.emit_to("main", "monitor-tray-preference", true)
        .map_err(|e| e.to_string())
}

struct Presentation {
    digits: String,
    tooltip: String,
    color: [u8; 3],
    can_benchmark: bool,
}

fn numeric(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite() && *n >= 0.0)
}

fn presentation(value: &Value, english: bool) -> Presentation {
    let t = |cn, en| if english { en } else { cn };
    let live = &value["metrics"]["live"];
    let state = live["state"].as_str().unwrap_or("unknown");
    let transition = if value["phase"] == "online" {
        match state {
            "loading" => Some(t("正在载入模型", "Loading model")),
            "unloading" => Some(t("正在释放模型", "Releasing model")),
            _ => None,
        }
    } else {
        None
    };
    let online =
        value["phase"] == "online" && value["health"]["loaded"] == true && transition.is_none();
    let state_label = if let Some(label) = transition {
        label
    } else if !online {
        match value["phase"].as_str() {
            Some("none") => t("未选择服务", "No service selected"),
            Some("stopped") => t("未启动", "Stopped"),
            Some("online") => t("未加载模型", "No model loaded"),
            _ => t("连接不可用", "Unavailable"),
        }
    } else {
        match state {
            "generating" => t("生成中", "Generating"),
            "reading" => t("读取中", "Reading"),
            "idle" => t("空闲", "Idle"),
            _ => t("状态未知", "State unknown"),
        }
    };
    let speed = if online {
        match state {
            "generating" => numeric(&live["tok_s"]),
            "reading" => numeric(&live["prefill_tok_s_mean"]),
            _ => None,
        }
    } else {
        None
    };
    let mut tooltip = format!("Strata {} · {state_label}", t("监控", "Monitor"));
    if let Some(speed) = speed {
        tooltip.push_str(&format!(
            "\n{}: {speed:.1} tok/s",
            if state == "reading" {
                t("当前读取", "Current prefill")
            } else {
                t("当前生成", "Current generation")
            }
        ));
    }
    if online {
        if state == "idle" {
            if let Some(last) = numeric(&value["metrics"]["requests"][0]["decode_tok_s"]) {
                tooltip.push_str(&format!(
                    "\n{}: {last:.1} tok/s",
                    t("最近生成", "Last generation")
                ));
            }
        }
        for (label, key) in [("GPU", "gpu_util"), ("CPU", "cpu")] {
            if let Some(n) = numeric(&value["metrics"]["hardware"][key]) {
                tooltip.push_str(&format!("\n{label}: {n:.0}%"));
            }
        }
    }
    Presentation {
        digits: speed
            .map(|n| {
                if n.round() >= 1000.0 {
                    format!("{}k", (n / 1000.0).round().min(99.0))
                } else {
                    format!("{n:.0}")
                }
            })
            .unwrap_or_else(|| "-".into()),
        tooltip,
        color: if online {
            [34, 211, 153]
        } else {
            [148, 163, 184]
        },
        can_benchmark: online
            && state == "idle"
            && !["running", "queued", "waiting", "admitting", "outside_slots"]
                .iter()
                .any(|key| numeric(&live[*key]).is_some_and(|n| n > 0.0)),
    }
}

// Small pixel font keeps the tray readable without fonts, GPU or webview.
fn icon(text: &str, color: [u8; 3]) -> Image<'static> {
    let mut rgba = vec![0u8; 32 * 32 * 4];
    let chars: Vec<_> = text.chars().take(3).collect();
    let left = (32 - (chars.len() * 8 - 2)) / 2;
    for (index, ch) in chars.into_iter().enumerate() {
        let rows = match ch {
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
        };
        for (y, row) in rows.into_iter().enumerate() {
            for x in 0..3 {
                if row & (1 << (2 - x)) != 0 {
                    for dy in 0..2 {
                        for dx in 0..2 {
                            let offset =
                                ((11 + y * 2 + dy) * 32 + left + index * 8 + x * 2 + dx) * 4;
                            rgba[offset..offset + 4]
                                .copy_from_slice(&[color[0], color[1], color[2], 255]);
                        }
                    }
                }
            }
        }
    }
    Image::new_owned(rgba, 32, 32)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabled_by_default_and_only_boolean_true_enables_tray() {
        for value in [
            Value::Null,
            json!({}),
            json!({"floatingMonitor":{"showInTray":"true"}}),
        ] {
            assert!(!enabled(&value));
        }
        assert!(enabled(&json!({"floatingMonitor":{"showInTray":true}})));
    }
    #[test]
    fn no_stale_speed_when_stopped_unavailable_or_unloaded() {
        for phase in ["stopped", "unavailable", "online", "none"] {
            let view = presentation(
                &json!({"phase":phase,"health":{"loaded":false},"metrics":{"live":{"state":"generating","tok_s":90},"hardware":{"cpu":90}}}),
                false,
            );
            assert_eq!(view.digits, "-");
            assert!(!view.tooltip.contains("90"));
            assert!(!view.can_benchmark);
        }
    }
    #[test]
    fn model_transitions_override_loaded_flag_without_reusing_throughput() {
        for (state, chinese, english) in [
            ("loading", "正在载入模型", "Loading model"),
            ("unloading", "正在释放模型", "Releasing model"),
        ] {
            for loaded in [false, true] {
                let snapshot = json!({"phase":"online","health":{"loaded":loaded},"metrics":{"live":{"state":state,"tok_s":90,"prefill_tok_s_mean":2200},"requests":[{"decode_tok_s":80}]}});
                for (is_english, label) in [(false, chinese), (true, english)] {
                    let view = presentation(&snapshot, is_english);
                    assert!(view.tooltip.contains(label));
                    assert_eq!(view.digits, "-");
                    assert!(!view.tooltip.contains("tok/s"));
                    assert!(!view.can_benchmark);
                }
                for phase in ["stopped", "unavailable", "none"] {
                    let mut stale = snapshot.clone();
                    stale["phase"] = json!(phase);
                    let view = presentation(&stale, false);
                    assert!(!view.tooltip.contains(chinese));
                    assert_eq!(view.digits, "-");
                    assert!(!view.can_benchmark);
                }
            }
        }
    }
    #[test]
    fn live_prefill_and_decode_are_distinct_from_idle_history() {
        let mut snapshot = json!({"phase":"online","health":{"loaded":true},"metrics":{"live":{"state":"generating","tok_s":90.4,"prefill_tok_s_mean":2200},"requests":[{"decode_tok_s":80}],"hardware":{"cpu":20,"gpu_util":50}}});
        let generating = presentation(&snapshot, false);
        assert_eq!(generating.digits, "90");
        assert!(!generating.can_benchmark);
        assert!(generating.tooltip.contains("当前生成"));
        snapshot["metrics"]["live"]["state"] = json!("reading");
        assert_eq!(presentation(&snapshot, false).digits, "2k");
        snapshot["metrics"]["live"]["state"] = json!("idle");
        let idle = presentation(&snapshot, false);
        assert_eq!(idle.digits, "-");
        assert!(idle.can_benchmark);
        assert!(idle.tooltip.contains("最近生成: 80.0"));
        assert!(!idle.tooltip.contains("90.4"));
    }
    #[test]
    fn icon_is_valid_rgba_for_every_supported_glyph() {
        for value in ["-", "0", "12", "345", "678", "99k"] {
            assert_eq!(icon(value, [255, 255, 255]).rgba().len(), 4096);
        }
    }
    #[test]
    fn queued_work_blocks_idle_benchmark() {
        for key in ["running", "queued", "waiting", "admitting", "outside_slots"] {
            let mut value = json!({"phase":"online","health":{"loaded":true},"metrics":{"live":{"state":"idle"}}});
            value["metrics"]["live"][key] = json!(1);
            assert!(!presentation(&value, false).can_benchmark);
        }
    }
    #[test]
    fn speed_rounding_never_truncates_four_digit_number() {
        for (speed, digits) in [
            (999.4, "999"),
            (999.5, "1k"),
            (1000.0, "1k"),
            (999999.0, "99k"),
        ] {
            let value = json!({"phase":"online","health":{"loaded":true},"metrics":{"live":{"state":"generating","tok_s":speed}}});
            assert_eq!(presentation(&value, false).digits, digits);
        }
    }
}
