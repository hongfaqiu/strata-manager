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
    if width <= 0 || height <= 0 || gap < 0 || bar.width() <= bar.height() || height > bar.height()
    {
        return None;
    }
    let mut spans: Vec<_> = occupied
        .iter()
        .filter(|r| bar.overlaps(**r))
        .map(|r| (r.left.saturating_sub(gap), r.right.saturating_add(gap)))
        .collect();
    spans.sort_unstable();
    let mut x = bar.left.saturating_add(gap);
    let end = bar.right.saturating_sub(gap);
    for (left, right) in spans {
        if x.checked_add(width)? <= left.min(end) {
            break;
        }
        x = x.max(right);
    }
    if x.checked_add(width)? > end {
        return None;
    }
    let top = bar.top + (bar.height() - height) / 2;
    Some(Rect {
        left: x,
        top,
        right: x + width,
        bottom: top + height,
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
        assert_eq!(result.left, 138);
        assert!(![r(0, 130), r(750, 1350), r(1660, 1920)]
            .iter()
            .any(|x| x.overlaps(result)));
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
        assert_eq!(result.left, -1912);
        assert_eq!(result.right, -1612);
    }
    #[test]
    fn invalid_dimensions_and_vertical_taskbars_are_rejected() {
        assert!(vacant_rect(r(0, 1000), &[], 0, 42, 8).is_none());
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
