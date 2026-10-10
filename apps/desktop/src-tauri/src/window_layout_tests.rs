use super::*;

fn monitor(name: &str, x: i32, y: i32, width: u32, height: u32, scale: f64) -> MonitorArea {
    MonitorArea {
        name: Some(name.into()),
        x,
        y,
        width,
        height,
        scale,
    }
}

fn saved(area: MonitorArea) -> SavedWindow {
    SavedWindow {
        schema: 1,
        width: 1000.0,
        height: 700.0,
        x: area.x + 100,
        y: area.y + 50,
        monitor: area,
        maximized: false,
    }
}

fn fits(layout: &Layout, area: &MonitorArea) {
    assert!(layout.x >= area.x && layout.y >= area.y);
    assert!(
        f64::from(layout.x) + (layout.width + 32.0) * area.scale
            <= f64::from(area.x) + f64::from(area.width) + 1.0
    );
    assert!(
        f64::from(layout.y) + (layout.height + 48.0) * area.scale
            <= f64::from(area.y) + f64::from(area.height) + 1.0
    );
}

#[test]
fn first_launch_fits_common_work_areas_and_display_scales() {
    for (width, height) in [(1280, 680), (1920, 1040), (2560, 1400), (3840, 2120)] {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let area = monitor("primary", 0, 0, width, height, scale);
            let layout = restore(None, std::slice::from_ref(&area), 0).unwrap();
            fits(&layout, &area);
            assert!(layout.width <= 1440.0 && layout.height <= 960.0);
        }
    }
    assert!(initial_size(0, 1080, 1.0).is_none());
    assert!(initial_size(1920, 1080, f64::NAN).is_none());
}

#[test]
fn restart_preserves_normal_size_and_negative_monitor_position() {
    let left = monitor("left", -2560, -200, 2560, 1400, 1.25);
    let right = monitor("primary", 0, 0, 1920, 1040, 1.0);
    let previous = saved(left.clone());
    let layout = restore(Some(&previous), &[right, left.clone()], 0).unwrap();
    assert_eq!((layout.width, layout.height), (1000.0, 700.0));
    assert_eq!((layout.x, layout.y), (previous.x, previous.y));
    fits(&layout, &left);
}

#[test]
fn monitor_removal_rehomes_window_to_primary_and_preserves_maximized_flag() {
    let old = monitor("removed", -2560, 0, 2560, 1440, 1.0);
    let primary = monitor("primary", 0, 0, 1280, 680, 2.0);
    let other = monitor("other", 1280, 0, 1920, 1040, 1.0);
    let mut previous = saved(old);
    previous.maximized = true;
    let layout = restore(Some(&previous), &[other, primary.clone()], 1).unwrap();
    assert!(layout.maximized);
    fits(&layout, &primary);
    assert_eq!((previous.width, previous.height), (1000.0, 700.0));
}

#[test]
fn monitor_shift_and_dpi_change_keep_logical_size_and_accessible_position() {
    let old = monitor("same", -2560, 0, 2560, 1440, 1.0);
    let next = monitor("same", 1920, -300, 3840, 2100, 2.0);
    let previous = saved(old);
    let layout = restore(Some(&previous), std::slice::from_ref(&next), 0).unwrap();
    assert_eq!((layout.width, layout.height), (1000.0, 700.0));
    assert_eq!(layout.x, 2070);
    fits(&layout, &next);
}

#[test]
fn duplicate_names_choose_original_area_and_clamp_offscreen_position() {
    let left = monitor("display", -1920, 0, 1920, 1040, 1.0);
    let right = monitor("display", 0, 0, 1920, 1040, 1.0);
    let mut previous = saved(left.clone());
    previous.x = i32::MIN;
    previous.y = i32::MAX;
    let layout = restore(Some(&previous), &[right, left.clone()], 0).unwrap();
    fits(&layout, &left);
}

#[test]
fn corrupt_or_unknown_layout_falls_back_to_safe_first_launch() {
    let area = monitor("primary", 0, 0, 1920, 1040, 1.0);
    for bad in [f64::NAN, f64::INFINITY, -1.0, 0.0, 100_001.0] {
        let mut previous = saved(area.clone());
        previous.width = bad;
        let layout = restore(Some(&previous), std::slice::from_ref(&area), 0).unwrap();
        fits(&layout, &area);
        assert!(!layout.maximized);
    }
    let mut previous = saved(area.clone());
    previous.schema = 2;
    assert_eq!(restore(Some(&previous), &[area], 0).unwrap().width, 1440.0);
    assert!(restore(None, &[], 0).is_none());
}

#[test]
fn atomic_file_roundtrip_replacement_and_corruption_preserve_unrelated_files() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("nested").join(STATE_FILE);
    let unrelated = directory.path().join("model.gguf");
    fs::write(&unrelated, b"unchanged").unwrap();
    let mut previous = saved(monitor("primary", 0, 0, 1920, 1040, 1.0));
    save(&path, &previous).unwrap();
    assert_eq!(load(&path).unwrap().width, 1000.0);
    previous.width = 1250.0;
    previous.maximized = true;
    save(&path, &previous).unwrap();
    let reopened = load(&path).unwrap();
    assert_eq!(reopened.width, 1250.0);
    assert!(reopened.maximized);
    fs::write(&path, b"{partial JSON").unwrap();
    assert!(load(&path).is_none());
    fs::write(&path, vec![b'x'; 16_385]).unwrap();
    assert!(load(&path).is_none());
    assert_eq!(fs::read(unrelated).unwrap(), b"unchanged");
    assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
}
