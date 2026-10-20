//! Human-readable sizes for user-facing progress text (binary units).
//! Exact byte counts stay in the dialogs' "Package details".

/// `1.23 GiB`, `12.4 MiB`, `512 B`: two decimals below 10, one decimal above.
pub(crate) fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["KiB", "MiB", "GiB", "TiB", "PiB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64 / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    // Rounding can reach the next unit (1023.96 KiB -> "1024.0 KiB"); show it as 1.00 of the next.
    if value >= 1023.95 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if value < 9.995 {
        format!("{value:.2} {}", UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// `1.23 GiB / 2.10 GiB（58%）· 12.4 MiB/s`; without a total: `1.23 GiB / 总量未知`.
pub(crate) fn progress_amount(
    received: u64,
    total: Option<u64>,
    bytes_per_second: Option<f64>,
) -> String {
    let mut text = match total {
        Some(total) if total > 0 => {
            let percent = (received.min(total) as u128 * 100 / total as u128) as u64;
            format!(
                "{} / {}（{percent}%）",
                human_bytes(received),
                human_bytes(total)
            )
        }
        Some(_) => human_bytes(received),
        None => format!("{} / 总量未知", human_bytes(received)),
    };
    if let Some(speed) = bytes_per_second.filter(|speed| speed.is_finite() && *speed >= 1.0) {
        // A full-width parenthesis already spaces itself in Chinese text.
        let separator = if text.ends_with('）') { "· " } else { " · " };
        text.push_str(&format!(
            "{separator}{}/s",
            human_bytes(speed.round() as u64)
        ));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_use_binary_units_with_one_or_two_decimals() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(1023), "1023 B");
        assert_eq!(human_bytes(1024), "1.00 KiB");
        assert_eq!(human_bytes(1536), "1.50 KiB");
        assert_eq!(human_bytes(13_002_342), "12.4 MiB");
        assert_eq!(human_bytes(1_320_702_444), "1.23 GiB");
        assert_eq!(human_bytes(2_254_857_830), "2.10 GiB");
        assert_eq!(human_bytes(512 * 1024 * 1024), "512.0 MiB");
        assert_eq!(human_bytes(1024 * 1024 - 1), "1.00 MiB");
        assert_eq!(human_bytes(u64::MAX), "16384.0 PiB");
    }

    #[test]
    fn progress_shows_sizes_percent_and_optional_speed() {
        assert_eq!(
            progress_amount(1_320_702_444, Some(2_254_857_830), Some(13_002_342.0)),
            "1.23 GiB / 2.10 GiB（58%）· 12.4 MiB/s"
        );
        assert_eq!(progress_amount(0, Some(2048), None), "0 B / 2.00 KiB（0%）");
        assert_eq!(
            progress_amount(4096, Some(2048), None),
            "4.00 KiB / 2.00 KiB（100%）"
        );
        assert_eq!(progress_amount(5 << 20, None, None), "5.00 MiB / 总量未知");
        assert_eq!(progress_amount(10, Some(0), Some(f64::NAN)), "10 B");
        assert_eq!(
            progress_amount(3 << 20, None, Some(2048.0)),
            "3.00 MiB / 总量未知 · 2.00 KiB/s"
        );
    }
}
