use tauri::{LogicalSize, Manager, PhysicalPosition};

fn initial_size(width: u32, height: u32, scale: f64) -> Option<(f64, f64)> {
    if !scale.is_finite() || scale <= 0.0 || width == 0 || height == 0 {
        return None;
    }
    // Reserve space for the OS window frame inside the usable monitor area.
    Some((
        (f64::from(width) / scale - 48.0).clamp(1.0, 1440.0),
        (f64::from(height) / scale - 72.0).clamp(1.0, 960.0),
    ))
}

pub fn fit_initial_window(app: &tauri::App) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let monitor = match window.current_monitor()? {
        Some(monitor) => Some(monitor),
        None => window.primary_monitor()?,
    };
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let area = monitor.work_area();
    let Some((width, height)) =
        initial_size(area.size.width, area.size.height, monitor.scale_factor())
    else {
        return Ok(());
    };
    window.set_min_size(Some(LogicalSize::new(width.min(720.0), height.min(520.0))))?;
    window.set_size(LogicalSize::new(width, height))?;
    let outer = window.outer_size()?;
    window.set_position(PhysicalPosition::new(
        area.position.x + (area.size.width.saturating_sub(outer.width) / 2) as i32,
        area.position.y + (area.size.height.saturating_sub(outer.height) / 2) as i32,
    ))
}

#[cfg(test)]
mod tests {
    use super::initial_size;

    #[test]
    fn initial_window_fits_work_area_at_common_display_scales() {
        for (width, height) in [(1280, 680), (1920, 1040), (2560, 1400), (3840, 2120)] {
            for scale in [1.0, 1.25, 1.5, 2.0] {
                let (logical_width, logical_height) = initial_size(width, height, scale).unwrap();
                assert!(logical_width * scale + 32.0 * scale <= f64::from(width));
                assert!(logical_height * scale + 48.0 * scale <= f64::from(height));
                assert!(logical_width <= 1440.0 && logical_height <= 960.0);
            }
        }
        assert!(initial_size(0, 1080, 1.0).is_none());
        assert!(initial_size(1920, 1080, f64::NAN).is_none());
    }
}
