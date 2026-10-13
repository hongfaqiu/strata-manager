//! Pure geometry shared by the isolated taskbar host and its tests.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn width(self) -> i32 {
        self.right - self.left
    }
    pub fn height(self) -> i32 {
        self.bottom - self.top
    }
    pub fn contains(self, other: Self) -> bool {
        other.left >= self.left
            && other.top >= self.top
            && other.right <= self.right
            && other.bottom <= self.bottom
            && other.width() > 0
            && other.height() > 0
    }
    pub fn overlaps(self, other: Self) -> bool {
        self.left < other.right
            && self.right > other.left
            && self.top < other.bottom
            && self.bottom > other.top
    }
}

pub(crate) fn vacant_rect(
    bar: Rect,
    occupied: &[Rect],
    width: i32,
    height: i32,
    gap: i32,
) -> Option<Rect> {
    // Win32 uses signed screen coordinates. Widen before subtracting or adding
    // spacing so negative-monitor positions and malformed extremes cannot wrap.
    let bar_width = i64::from(bar.right) - i64::from(bar.left);
    let bar_height = i64::from(bar.bottom) - i64::from(bar.top);
    if width <= 0
        || height <= 0
        || gap < 0
        || bar_height <= 0
        || bar_width <= bar_height
        || i64::from(height) > bar_height
    {
        return None;
    }
    let gap = i64::from(gap);
    let width = i64::from(width);
    let height = i64::from(height);
    let mut spans: Vec<_> = occupied
        .iter()
        .filter(|r| r.left < r.right && r.top < r.bottom && bar.overlaps(**r))
        .map(|r| (i64::from(r.left) - gap, i64::from(r.right) + gap))
        .collect();
    // Prefer the space nearest the notification area. Sort by RIGHT edge:
    // sorting by left edges could miss a wider, nested obstacle behind one.
    spans.sort_unstable_by(|a, b| b.1.cmp(&a.1));
    let start = i64::from(bar.left) + gap;
    let mut end = i64::from(bar.right) - gap;
    for (left, right) in spans {
        if end - width >= right.max(start) {
            break;
        }
        end = end.min(left);
    }
    let left = end - width;
    if left < start {
        return None;
    }
    let top = i64::from(bar.top) + (bar_height - height) / 2;
    Some(Rect {
        left: left.try_into().ok()?,
        top: top.try_into().ok()?,
        right: end.try_into().ok()?,
        bottom: (top + height).try_into().ok()?,
    })
}

/// Independent scale per metric; None deliberately breaks a rendered polyline.
pub(crate) fn graph_points(values: &[Option<f64>], area: Rect) -> Vec<Option<(i32, i32)>> {
    if area.width() < 2 || area.height() < 2 {
        return Vec::new();
    }
    let values = &values[values.len().saturating_sub(60)..];
    let valid = |v: f64| v.is_finite() && v >= 0.0;
    let max = values
        .iter()
        .flatten()
        .copied()
        .filter(|v| valid(*v))
        .fold(1.0, f64::max);
    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            value.filter(|v| valid(*v)).map(|value| {
                let x = area.left + index as i32 * (area.width() - 1) / 59;
                let y = area.bottom
                    - 1
                    - ((value / max).clamp(0.0, 1.0) * (area.height() - 1) as f64).round() as i32;
                (x, y)
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn r(left: i32, right: i32) -> Rect {
        Rect {
            left,
            top: 1000,
            right,
            bottom: 1048,
        }
    }
    #[test]
    fn space_is_measured_between_visible_controls() {
        let result = vacant_rect(
            r(0, 1920),
            &[r(0, 130), r(750, 1350), r(1660, 1920)],
            400,
            42,
            8,
        )
        .unwrap();
        assert!(r(0, 1920).contains(result));
        assert_eq!(result.left, 342);
        assert_eq!(result.right, 742);
        assert!(![r(0, 130), r(750, 1350), r(1660, 1920)]
            .iter()
            .any(|x| x.overlaps(result)));
    }
    #[test]
    fn rightmost_available_gap_is_preferred_and_keeps_edge_spacing() {
        let occupied = [r(0, 100), r(550, 800), r(1300, 1450)];
        let result = vacant_rect(r(0, 1600), &occupied, 300, 42, 8).unwrap();
        assert_eq!(result.left, 992);
        assert_eq!(result.right, 1292);
        assert_eq!(result.top, 1003);
        assert!(!occupied.iter().any(|x| x.overlaps(result)));
        let edge = vacant_rect(r(0, 1600), &occupied, 100, 42, 8).unwrap();
        assert_eq!(edge.left, 1492);
        assert_eq!(edge.right, 1592);
    }
    #[test]
    fn overlapping_and_nested_obstacles_cannot_hide_a_rightward_blocker() {
        let occupied = [r(0, 900), r(800, 820), r(750, 880)];
        assert!(vacant_rect(r(0, 1000), &occupied, 150, 42, 8).is_none());
        let result = vacant_rect(r(0, 1000), &occupied, 80, 42, 8).unwrap();
        assert_eq!(result.left, 912);
        assert_eq!(result.right, 992);
    }
    #[test]
    fn exact_gap_fit_and_notification_area_boundary_are_respected() {
        let occupied = [r(0, 100), r(550, 800), r(1300, 1920)];
        let result = vacant_rect(r(0, 1300), &occupied, 484, 42, 8).unwrap();
        assert_eq!(result.left, 808);
        assert_eq!(result.right, 1292);
        assert!(vacant_rect(r(0, 1300), &occupied, 485, 42, 8).is_none());
    }
    #[test]
    fn no_overlay_when_taskbar_is_full_or_too_short() {
        assert!(vacant_rect(r(0, 1000), &[r(0, 1000)], 300, 42, 8).is_none());
        assert!(vacant_rect(r(0, 1000), &[], 300, 60, 8).is_none());
    }
    #[test]
    fn offscreen_controls_do_not_consume_space_and_edges_are_guarded() {
        let result = vacant_rect(
            r(-1920, 0),
            &[Rect {
                left: -1800,
                top: 0,
                right: -1400,
                bottom: 20,
            }],
            300,
            42,
            8,
        )
        .unwrap();
        assert_eq!(result.left, -308);
        assert_eq!(result.right, -8);
    }
    #[test]
    fn invalid_dimensions_and_vertical_taskbars_are_rejected() {
        assert!(vacant_rect(r(0, 1000), &[], 0, 42, 8).is_none());
        assert!(vacant_rect(r(0, 1000), &[], 30, 42, -1).is_none());
        assert!(vacant_rect(r(1000, 0), &[], 30, 42, 8).is_none());
        assert!(vacant_rect(
            Rect {
                bottom: 999,
                ..r(0, 1000)
            },
            &[],
            30,
            42,
            8
        )
        .is_none());
        assert!(vacant_rect(
            Rect {
                left: 0,
                top: 0,
                right: 48,
                bottom: 1080
            },
            &[],
            30,
            42,
            8
        )
        .is_none());
    }
    #[test]
    fn extreme_coordinates_and_gaps_do_not_overflow() {
        let bar = Rect {
            left: i32::MIN,
            right: i32::MAX,
            top: i32::MAX - 48,
            bottom: i32::MAX,
        };
        let result = vacant_rect(bar, &[], 300, 42, 8).unwrap();
        assert_eq!(result.left, i32::MAX - 308);
        assert_eq!(result.right, i32::MAX - 8);
        assert_eq!(result.top, i32::MAX - 45);
        assert_eq!(result.bottom, i32::MAX - 3);
        assert!(vacant_rect(bar, &[], 300, 42, i32::MAX).is_none());
        assert!(vacant_rect(bar, &[bar], 300, 42, i32::MAX).is_none());
    }
    #[test]
    fn graph_unknowns_break_and_metrics_scale_independently() {
        let area = Rect {
            left: 0,
            top: 0,
            right: 60,
            bottom: 11,
        };
        let decode = graph_points(&[Some(10.0), None, Some(20.0)], area);
        let prefill = graph_points(&[Some(1000.0), None, Some(2000.0)], area);
        assert_eq!(decode, prefill);
        assert_eq!(decode, vec![Some((0, 5)), None, Some((2, 0))]);
        assert_eq!(
            graph_points(&[Some(f64::NAN), Some(-1.0)], area),
            vec![None, None]
        );
        assert_eq!(graph_points(&vec![Some(1.0); 80], area).len(), 60);
    }
}
