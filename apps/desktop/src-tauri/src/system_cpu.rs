//! Whole-machine CPU occupancy for the desktop and taskbar monitors.
//!
//! Independent of the official `/metrics` feed, a selected service, a loaded
//! model, or a GPU. The first reading has no prior interval, so it is unknown
//! rather than a literal 0%.

use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use sysinfo::System;

/// Two refreshes closer than this have no meaningful delta.
const MIN_INTERVAL: Duration = Duration::from_millis(200);

struct Sampler {
    system: System,
    last: Option<Instant>,
    last_value: Option<f64>,
}

impl Sampler {
    fn new() -> Self {
        let mut system = System::new();
        system.refresh_cpu_usage();
        Self {
            system,
            last: None,
            last_value: None,
        }
    }

    fn sample(&mut self, now: Instant) -> Option<f64> {
        if let Some(previous) = self.last {
            if now.saturating_duration_since(previous) < MIN_INTERVAL {
                return self.last_value;
            }
        }
        self.system.refresh_cpu_usage();
        if self.last.is_none() {
            self.last = Some(now);
            self.last_value = None;
            return None;
        }
        self.last = Some(now);
        self.last_value = interpret_cpu_usage(self.system.global_cpu_usage());
        self.last_value
    }
}

/// First-frame / out-of-range policy, kept pure so tests do not depend on
/// how quickly sysinfo can produce a second tick.
pub(crate) fn interpret_cpu_usage(usage: f32) -> Option<f64> {
    if !usage.is_finite() {
        return None;
    }
    if (0.0..=100.0).contains(&usage) {
        Some(f64::from(usage))
    } else if usage < 0.0 {
        Some(0.0)
    } else {
        None
    }
}

/// `primed` is true once a previous refresh has been taken. A measured 0%
/// after that is a real idle reading, not "unknown".
pub(crate) fn first_or_measured(primed: bool, usage: f32) -> Option<f64> {
    if !primed {
        None
    } else {
        interpret_cpu_usage(usage)
    }
}

static SAMPLER: Mutex<Option<Sampler>> = Mutex::new(None);

/// Latest whole-machine CPU percent, or `None` when no valid interval exists
/// yet or the reading is unusable.
pub(crate) fn system_cpu_percent() -> Option<f64> {
    let mut slot = SAMPLER.lock().ok()?;
    let sampler = slot.get_or_insert_with(Sampler::new);
    sampler.sample(Instant::now())
}

/// Overwrite `metrics.hardware.cpu` with the manager's own sample. Official
/// `/metrics` must not stand in for a missing first interval, and a missing
/// sample must not invent 0%.
pub(crate) fn apply_system_cpu(snapshot: &mut Value, cpu: Option<f64>) {
    match cpu.and_then(|value| interpret_cpu_usage(value as f32)) {
        Some(value) => snapshot["metrics"]["hardware"]["cpu"] = json!(value),
        None => {
            if snapshot
                .pointer("/metrics/hardware")
                .is_some_and(Value::is_object)
                || snapshot.get("metrics").is_some()
            {
                snapshot["metrics"]["hardware"]["cpu"] = Value::Null;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn first_frame_is_unknown_and_real_zero_is_kept() {
        assert_eq!(first_or_measured(false, 0.0), None);
        assert_eq!(first_or_measured(false, 42.0), None);
        assert_eq!(first_or_measured(true, 0.0), Some(0.0));
        assert_eq!(first_or_measured(true, 12.5), Some(12.5));
        assert_eq!(first_or_measured(true, 100.0), Some(100.0));
        assert_eq!(first_or_measured(true, 100.1), None);
        assert_eq!(first_or_measured(true, f32::NAN), None);
        assert_eq!(interpret_cpu_usage(-1.0), Some(0.0));
    }

    #[test]
    fn apply_system_cpu_does_not_keep_official_placeholder_on_first_frame() {
        let mut snapshot = json!({
            "phase": "online",
            "metrics": {"hardware": {"cpu": 0.0, "ram_used": 1}, "live": {"tok_s": 9}}
        });
        apply_system_cpu(&mut snapshot, None);
        assert!(snapshot["metrics"]["hardware"]["cpu"].is_null());
        assert_eq!(snapshot["metrics"]["hardware"]["ram_used"], 1);
        assert_eq!(snapshot["metrics"]["live"]["tok_s"], 9);
        apply_system_cpu(&mut snapshot, Some(0.0));
        assert_eq!(snapshot["metrics"]["hardware"]["cpu"], 0.0);
        apply_system_cpu(&mut snapshot, Some(37.0));
        assert_eq!(snapshot["metrics"]["hardware"]["cpu"], 37.0);
    }

    #[test]
    fn apply_system_cpu_can_fill_a_stopped_snapshot() {
        let mut snapshot = json!({"phase": "stopped"});
        apply_system_cpu(&mut snapshot, Some(8.0));
        assert_eq!(snapshot["phase"], "stopped");
        assert_eq!(snapshot["metrics"]["hardware"]["cpu"], 8.0);
        assert!(snapshot["metrics"].get("live").is_none());
    }
}
