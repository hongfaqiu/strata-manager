use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
use tauri::{LogicalSize, Manager, PhysicalPosition, WindowEvent};

const STATE_FILE: &str = "window-layout.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
struct MonitorArea {
    name: Option<String>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
}
impl MonitorArea {
    fn from_monitor(monitor: &tauri::Monitor) -> Self {
        let area = monitor.work_area();
        Self {
            name: monitor.name().cloned(),
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
            scale: monitor.scale_factor(),
        }
    }
    fn valid(&self) -> bool {
        self.width > 0
            && self.height > 0
            && self.width <= 100_000
            && self.height <= 100_000
            && self.scale.is_finite()
            && (0.25..=8.0).contains(&self.scale)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedWindow {
    schema: u8,
    width: f64,
    height: f64,
    x: i32,
    y: i32,
    monitor: MonitorArea,
    maximized: bool,
}
impl SavedWindow {
    fn valid(&self) -> bool {
        self.schema == 1
            && self.monitor.valid()
            && self.width.is_finite()
            && self.height.is_finite()
            && (1.0..=100_000.0).contains(&self.width)
            && (1.0..=100_000.0).contains(&self.height)
    }
}

#[derive(Debug)]
struct Layout {
    width: f64,
    height: f64,
    x: i32,
    y: i32,
    maximized: bool,
}

fn initial_size(width: u32, height: u32, scale: f64) -> Option<(f64, f64)> {
    if !scale.is_finite() || scale <= 0.0 || width == 0 || height == 0 {
        return None;
    }
    Some((
        (f64::from(width) / scale - 48.0).clamp(1.0, 1440.0),
        (f64::from(height) / scale - 72.0).clamp(1.0, 960.0),
    ))
}

fn overlap(a: &MonitorArea, b: &MonitorArea) -> i64 {
    let width = (i64::from(a.x) + i64::from(a.width)).min(i64::from(b.x) + i64::from(b.width))
        - i64::from(a.x).max(i64::from(b.x));
    let height = (i64::from(a.y) + i64::from(a.height)).min(i64::from(b.y) + i64::from(b.height))
        - i64::from(a.y).max(i64::from(b.y));
    width.max(0) * height.max(0)
}

fn restore(saved: Option<&SavedWindow>, areas: &[MonitorArea], primary: usize) -> Option<Layout> {
    let primary = primary.min(areas.len().saturating_sub(1));
    let saved = saved.filter(|value| value.valid());
    let target = saved.and_then(|value| {
        areas
            .iter()
            .enumerate()
            .filter(|(_, area)| area.valid())
            .filter(|(_, area)| {
                value.monitor.name.is_some() && area.name == value.monitor.name
                    || overlap(&value.monitor, area) > 0
            })
            .max_by_key(|(_, area)| {
                (
                    value.monitor.name.is_some() && area.name == value.monitor.name,
                    overlap(&value.monitor, area),
                )
            })
            .map(|(index, _)| index)
    });
    let area = areas.get(target.unwrap_or(primary))?;
    if !area.valid() {
        return None;
    }
    let (default_width, default_height) = initial_size(area.width, area.height, area.scale)?;
    let max_width = (f64::from(area.width) / area.scale - 48.0).max(1.0);
    let max_height = (f64::from(area.height) / area.scale - 72.0).max(1.0);
    let width = saved
        .map_or(default_width, |value| value.width)
        .clamp(720.0_f64.min(max_width), max_width);
    let height = saved
        .map_or(default_height, |value| value.height)
        .clamp(520.0_f64.min(max_height), max_height);
    let right = f64::from(area.x) + f64::from(area.width) - (width + 32.0) * area.scale;
    let bottom = f64::from(area.y) + f64::from(area.height) - (height + 48.0) * area.scale;
    let (x, y) = match (saved, target) {
        (Some(value), Some(_)) => (
            f64::from(area.x)
                + (f64::from(value.x) - f64::from(value.monitor.x))
                    / f64::from(value.monitor.width)
                    * f64::from(area.width),
            f64::from(area.y)
                + (f64::from(value.y) - f64::from(value.monitor.y))
                    / f64::from(value.monitor.height)
                    * f64::from(area.height),
        ),
        _ => (
            (f64::from(area.x) + right.max(f64::from(area.x))) / 2.0,
            (f64::from(area.y) + bottom.max(f64::from(area.y))) / 2.0,
        ),
    };
    Some(Layout {
        width,
        height,
        x: x.clamp(f64::from(area.x), right.max(f64::from(area.x)))
            .round() as i32,
        y: y.clamp(f64::from(area.y), bottom.max(f64::from(area.y)))
            .round() as i32,
        maximized: saved.is_some_and(|value| value.maximized),
    })
}

fn load(path: &Path) -> Option<SavedWindow> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(16_385)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > 16_384 {
        return None;
    }
    let state: SavedWindow = serde_json::from_slice(&bytes).ok()?;
    state.valid().then_some(state)
}

fn save(path: &Path, state: &SavedWindow) -> std::io::Result<()> {
    if !state.valid() {
        return Err(std::io::Error::other("Invalid window layout"));
    }
    let directory = path
        .parent()
        .ok_or_else(|| std::io::Error::other("Missing layout directory"))?;
    fs::create_dir_all(directory)?;
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    serde_json::to_writer(&mut file, state)?;
    file.flush()?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|error| error.error)?;
    Ok(())
}

fn sample(window: &tauri::WebviewWindow, previous: &SavedWindow) -> Option<SavedWindow> {
    // Minimizing/fullscreen must not destroy the last normal rectangle.
    if window.is_minimized().ok()? || window.is_fullscreen().ok()? {
        return None;
    }
    let maximized = window.is_maximized().ok()?;
    if maximized {
        return Some(SavedWindow {
            maximized,
            ..previous.clone()
        });
    }
    let monitor = MonitorArea::from_monitor(&window.current_monitor().ok()??);
    let size = window.inner_size().ok()?;
    let position = window.outer_position().ok()?;
    let scale = window.scale_factor().ok()?;
    let state = SavedWindow {
        schema: 1,
        width: f64::from(size.width) / scale,
        height: f64::from(size.height) / scale,
        x: position.x,
        y: position.y,
        monitor,
        maximized,
    };
    state.valid().then_some(state)
}

fn install_persistence(window: &tauri::WebviewWindow, path: PathBuf, initial: SavedWindow) {
    let state = Arc::new(Mutex::new(initial));
    let writer_state = state.clone();
    let writer_path = path.clone();
    let (sender, receiver) = mpsc::sync_channel(1);
    // One bounded writer; dragging does not spawn threads or force a disk
    // write for every native move/resize event.
    std::thread::spawn(move || {
        while receiver.recv().is_ok() {
            while receiver.recv_timeout(Duration::from_millis(300)).is_ok() {}
            if let Ok(value) = writer_state.lock() {
                let _ = save(&writer_path, &value);
            }
        }
    });
    let observed = window.clone();
    window.on_window_event(move |event| {
        if !matches!(
            event,
            WindowEvent::Moved(_)
                | WindowEvent::Resized(_)
                | WindowEvent::ScaleFactorChanged { .. }
                | WindowEvent::CloseRequested { .. }
                | WindowEvent::Focused(false)
        ) {
            return;
        }
        if let Ok(mut value) = state.lock() {
            if let Some(next) = sample(&observed, &value) {
                *value = next;
            }
            if matches!(
                event,
                WindowEvent::CloseRequested { .. } | WindowEvent::Focused(false)
            ) {
                // Flush even if close goes to the tray; installer/tray exit
                // also loses focus before terminating the UI process.
                let _ = save(&path, &value);
            } else {
                let _ = sender.try_send(());
            }
        }
    });
}

pub fn fit_initial_window(app: &tauri::App) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let monitors = window.available_monitors()?;
    let areas: Vec<_> = monitors.iter().map(MonitorArea::from_monitor).collect();
    let primary = window
        .primary_monitor()?
        .map(|monitor| MonitorArea::from_monitor(&monitor));
    let primary = primary
        .as_ref()
        .and_then(|monitor| {
            areas.iter().position(|area| {
                area.name == monitor.name && area.x == monitor.x && area.y == monitor.y
            })
        })
        .unwrap_or(0);
    let directory = super::supervisor_client::data_directory(&app.path().app_data_dir()?);
    if !directory.is_absolute() {
        return Err(std::io::Error::other("Window layout directory must be absolute").into());
    }
    let path = directory.join(STATE_FILE);
    let saved = load(&path);
    let Some(layout) = restore(saved.as_ref(), &areas, primary) else {
        return Ok(());
    };
    window.set_min_size(Some(LogicalSize::new(
        layout.width.min(720.0),
        layout.height.min(520.0),
    )))?;
    window.set_size(LogicalSize::new(layout.width, layout.height))?;
    window.set_position(PhysicalPosition::new(layout.x, layout.y))?;
    let fallback = SavedWindow {
        schema: 1,
        width: layout.width,
        height: layout.height,
        x: layout.x,
        y: layout.y,
        monitor: window
            .current_monitor()?
            .map(|monitor| MonitorArea::from_monitor(&monitor))
            .unwrap_or_else(|| areas[primary].clone()),
        maximized: false,
    };
    let mut initial = sample(&window, &fallback).unwrap_or(fallback);
    initial.maximized = layout.maximized;
    install_persistence(&window, path, initial);
    if layout.maximized {
        window.maximize()?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "window_layout_tests.rs"]
mod tests;
