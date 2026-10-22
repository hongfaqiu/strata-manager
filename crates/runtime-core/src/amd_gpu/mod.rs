//! AMD GPU telemetry for the monitor (#86).
//!
//! The engine's `/metrics` sampler reads NVIDIA cards through NVML. On an AMD card it reports the
//! GPU fields as null (Windows: `hardware_static.gpu_note`), so the monitor showed "–" for load,
//! VRAM, temperature and power. When the service runs on this PC, the manager fills only those
//! missing fields from the vendor's own interfaces:
//!
//! - Windows: AMD Device Library eXtra (ADLX, `amdadlx64.dll` from the Adrenalin driver), loaded at
//!   run time through the `adlx` crate; a missing DLL or an old driver leaves the fields empty.
//! - Linux: the `amdgpu` kernel driver's sysfs files (`/sys/class/drm/card*/device`).
//!
//! Values the engine already reports are never replaced, and a PC whose engine reads any GPU
//! value itself (NVIDIA) is left untouched.

#[cfg(windows)]
mod adlx;
#[cfg(any(windows, test))]
mod isolated;
#[cfg(any(target_os = "linux", test))]
mod sysfs;

use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// One AMD GPU. Memory in bytes, power in watts, clocks in MHz; `None` = not reported.
/// Serialized as the line protocol of the Windows telemetry helper process.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct AmdGpuSample {
    pub name: Option<String>,
    pub util: Option<f64>,
    pub mem_used: Option<f64>,
    pub mem_total: Option<f64>,
    pub temp: Option<f64>,
    pub hotspot_temp: Option<f64>,
    pub power: Option<f64>,
    pub power_limit: Option<f64>,
    pub clock_mhz: Option<f64>,
    pub mem_clock_mhz: Option<f64>,
    pub fan_rpm: Option<f64>,
    pub pcie_gen_max: Option<f64>,
    pub pcie_width: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AmdTelemetry {
    /// `amd-adlx` or `amdgpu-sysfs`.
    pub source: &'static str,
    pub gpus: Vec<AmdGpuSample>,
}

/// History series the monitor draws as sparklines, in the engine's units.
const HISTORY_KEYS: [&str; 4] = ["gpu_util", "gpu_mem_used", "gpu_temp", "gpu_power"];
const HISTORY_CAPACITY: usize = 240;
const SAMPLE_INTERVAL: Duration = Duration::from_millis(900);

type HistoryPoint = [Option<f64>; 4];

struct Cache {
    taken: Option<Instant>,
    telemetry: Option<AmdTelemetry>,
    history: VecDeque<HistoryPoint>,
}

static CACHE: Mutex<Cache> = Mutex::new(Cache {
    taken: None,
    telemetry: None,
    history: VecDeque::new(),
});

// Only the Linux and Windows readers use these converters.
#[cfg_attr(not(any(target_os = "linux", windows, test)), allow(dead_code))]
/// Positive finite value, else `None` (drivers report 0 or negative values for "not available").
pub(crate) fn positive(value: f64) -> Option<f64> {
    (value.is_finite() && value > 0.0).then_some(value)
}
#[cfg_attr(not(any(target_os = "linux", windows, test)), allow(dead_code))]
/// Finite value at or above zero (utilization may legitimately be 0 %).
pub(crate) fn non_negative(value: f64) -> Option<f64> {
    (value.is_finite() && value >= 0.0).then_some(value)
}

fn sum(values: impl Iterator<Item = Option<f64>>) -> Option<f64> {
    values
        .flatten()
        .fold(None, |acc, v| Some(acc.unwrap_or(0.0) + v))
}
fn max(values: impl Iterator<Item = Option<f64>>) -> Option<f64> {
    values.flatten().fold(None, |acc: Option<f64>, v| {
        Some(acc.map_or(v, |a| a.max(v)))
    })
}
fn mean(values: impl Iterator<Item = Option<f64>>) -> Option<f64> {
    let values: Vec<f64> = values.flatten().collect();
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

impl AmdTelemetry {
    fn aggregate(&self) -> Vec<(&'static str, Option<f64>)> {
        let g = &self.gpus;
        // Same aggregation as the engine's sampler: memory/power summed, utilization averaged,
        // hottest temperature.
        vec![
            ("gpu_util", mean(g.iter().map(|x| x.util))),
            ("gpu_mem_used", sum(g.iter().map(|x| x.mem_used))),
            ("gpu_mem_total", sum(g.iter().map(|x| x.mem_total))),
            ("gpu_temp", max(g.iter().map(|x| x.temp))),
            ("gpu_power", sum(g.iter().map(|x| x.power))),
            (
                "gpu_power_limit",
                if g.iter().all(|x| x.power_limit.is_some()) {
                    sum(g.iter().map(|x| x.power_limit))
                } else {
                    None
                },
            ),
            ("gpu_hotspot_temp", max(g.iter().map(|x| x.hotspot_temp))),
            ("gpu_clock_mhz", max(g.iter().map(|x| x.clock_mhz))),
            ("gpu_mem_clock_mhz", max(g.iter().map(|x| x.mem_clock_mhz))),
            ("gpu_fan_rpm", max(g.iter().map(|x| x.fan_rpm))),
            ("gpu_pcie_gen_max", max(g.iter().map(|x| x.pcie_gen_max))),
            ("gpu_pcie_width", max(g.iter().map(|x| x.pcie_width))),
        ]
    }
    fn history_point(&self) -> HistoryPoint {
        let a = self.aggregate();
        let get = |key: &str| a.iter().find(|(k, _)| *k == key).and_then(|(_, v)| *v);
        HISTORY_KEYS.map(get)
    }
}

/// Telemetry for this PC, sampled at most about once a second. `None` when there is no AMD GPU,
/// the platform has no reader, or the driver interface is unavailable.
pub fn current() -> Option<AmdTelemetry> {
    let mut cache = CACHE.lock().ok()?;
    if cache.taken.is_some_and(|t| t.elapsed() < SAMPLE_INTERVAL) {
        return cache.telemetry.clone();
    }
    let telemetry = sample_platform().filter(|t| !t.gpus.is_empty());
    cache.taken = Some(Instant::now());
    if let Some(t) = &telemetry {
        let point = t.history_point();
        cache.history.push_back(point);
        while cache.history.len() > HISTORY_CAPACITY {
            cache.history.pop_front();
        }
    } else {
        cache.history.clear();
    }
    cache.telemetry = telemetry.clone();
    telemetry
}

fn history_snapshot() -> Vec<HistoryPoint> {
    CACHE
        .lock()
        .map(|c| c.history.iter().copied().collect())
        .unwrap_or_default()
}

#[cfg(target_os = "linux")]
fn sample_platform() -> Option<AmdTelemetry> {
    sysfs::sample(std::path::Path::new("/sys/class/drm"))
}
#[cfg(windows)]
fn sample_platform() -> Option<AmdTelemetry> {
    // A binary that does not route `WORKER_FLAG` would start a second copy of itself.
    // STRATA_MANAGER_AMD_TELEMETRY=0 turns the AMD driver readings off entirely.
    if !WORKER_ROUTED.load(std::sync::atomic::Ordering::Relaxed)
        || std::env::var_os("STRATA_MANAGER_AMD_TELEMETRY").as_deref()
            == Some(std::ffi::OsStr::new("0"))
    {
        return None;
    }
    static READER: isolated::IsolatedReader =
        isolated::IsolatedReader::new(adlx::spawn_helper, isolated::IDLE_EXIT);
    READER.snapshot().map(|gpus| AmdTelemetry {
        source: "amd-adlx",
        gpus,
    })
}
#[cfg(not(any(target_os = "linux", windows)))]
fn sample_platform() -> Option<AmdTelemetry> {
    None
}

/// Argument that turns a process started from this binary into the Windows ADLX helper.
pub const WORKER_FLAG: &str = "--amd-adlx-telemetry";

static WORKER_ROUTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Call first in `main` of every binary that serves `/metrics` (supervisor, server). Returns the
/// exit code when this process was started as the AMD telemetry helper; otherwise records that
/// the binary routes the helper flag, which enables AMD telemetry on Windows (#124 / #127: ADLX
/// is never loaded into the supervisor process itself).
pub fn run_worker_if_requested() -> Option<i32> {
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new(WORKER_FLAG)) {
        #[cfg(windows)]
        return Some(adlx::worker_main());
        #[cfg(not(windows))]
        return Some(2);
    }
    WORKER_ROUTED.store(true, std::sync::atomic::Ordering::Relaxed);
    None
}

/// Only a service on this PC shares the GPU the manager can read.
pub fn is_local_base_url(base_url: &str) -> bool {
    url::Url::parse(base_url)
        .ok()
        .and_then(|u| {
            u.host().map(|host| match host {
                url::Host::Domain(d) => d.eq_ignore_ascii_case("localhost"),
                url::Host::Ipv4(ip) => ip.is_loopback() || ip.is_unspecified(),
                url::Host::Ipv6(ip) => ip.is_loopback() || ip.is_unspecified(),
            })
        })
        .unwrap_or(false)
}

/// Fill a local service's `/metrics` response with AMD telemetry where the engine has none.
pub async fn augment_local_metrics(base_url: &str, metrics: &mut Value) {
    if !is_local_base_url(base_url) || !engine_lacks_gpu_telemetry(metrics) {
        return;
    }
    let Ok(Some((telemetry, history))) =
        tokio::task::spawn_blocking(|| current().map(|t| (t, history_snapshot()))).await
    else {
        return;
    };
    merge_into_metrics(metrics, &telemetry, &history);
}

fn is_number(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64).is_some_and(f64::is_finite)
}

/// True when the engine reported no GPU reading of its own and did not name a non-AMD GPU.
pub fn engine_lacks_gpu_telemetry(metrics: &Value) -> bool {
    let Some(object) = metrics.as_object() else {
        return false;
    };
    let hw = object.get("hardware").and_then(Value::as_object);
    if let Some(hw) = hw {
        let aggregate = [
            "gpu_util",
            "gpu_mem_used",
            "gpu_mem_total",
            "gpu_temp",
            "gpu_power",
        ]
        .iter()
        .any(|key| is_number(hw.get(*key)));
        let per_card = hw
            .get("gpus")
            .and_then(Value::as_array)
            .is_some_and(|gpus| {
                gpus.iter().any(|gpu| {
                    ["util", "mem_used", "mem_total", "temp", "power"]
                        .iter()
                        .any(|key| is_number(gpu.get(*key)))
                })
            });
        if aggregate || per_card {
            return false;
        }
    }
    let named = object
        .get("hardware_static")
        .and_then(|s| s.get("gpu_name"))
        .and_then(Value::as_str)
        .map(str::to_ascii_lowercase);
    !named.is_some_and(|name| {
        !name.trim().is_empty()
            && !["amd", "radeon", "instinct"]
                .iter()
                .any(|k| name.contains(k))
    })
}

fn set_if_missing(map: &mut Map<String, Value>, key: &str, value: Option<f64>) {
    let Some(value) = value else { return };
    if !is_number(map.get(key)) {
        map.insert(key.into(), json!(value));
    }
}

/// Pure merge (unit tested): fills missing hardware fields, per-card records, static identity and
/// empty sparkline series. Engine values are kept.
pub fn merge_into_metrics(metrics: &mut Value, telemetry: &AmdTelemetry, history: &[HistoryPoint]) {
    let Some(root) = metrics.as_object_mut() else {
        return;
    };
    if telemetry.gpus.is_empty() {
        return;
    }
    let hw = root
        .entry("hardware")
        .or_insert_with(|| Value::Object(Map::new()));
    if !hw.is_object() {
        *hw = Value::Object(Map::new());
    }
    let hw = hw.as_object_mut().expect("object");
    for (key, value) in telemetry.aggregate() {
        set_if_missing(hw, key, value);
    }
    // Engine per-card records, when present, carry no reading (checked by the caller); replace
    // them so the overview's per-card rows show the AMD values.
    let replace_cards = !hw
        .get("gpus")
        .and_then(Value::as_array)
        .is_some_and(|gpus| {
            gpus.iter().any(|gpu| {
                ["util", "mem_used", "mem_total", "temp", "power"]
                    .iter()
                    .any(|key| is_number(gpu.get(*key)))
            })
        });
    if replace_cards {
        let cards: Vec<Value> = telemetry
            .gpus
            .iter()
            .enumerate()
            .map(|(index, gpu)| {
                let mut card = Map::new();
                card.insert("index".into(), json!(index));
                if let Some(name) = &gpu.name {
                    card.insert("name".into(), json!(name));
                }
                for (key, value) in [
                    ("util", gpu.util),
                    ("mem_used", gpu.mem_used),
                    ("mem_total", gpu.mem_total),
                    ("temp", gpu.temp),
                    ("hotspot_temp", gpu.hotspot_temp),
                    ("power", gpu.power),
                    ("power_limit", gpu.power_limit),
                    ("clock_mhz", gpu.clock_mhz),
                    ("mem_clock_mhz", gpu.mem_clock_mhz),
                    ("fan_rpm", gpu.fan_rpm),
                ] {
                    set_if_missing(&mut card, key, value);
                }
                Value::Object(card)
            })
            .collect();
        hw.insert("gpus".into(), Value::Array(cards));
    }

    let st = root
        .entry("hardware_static")
        .or_insert_with(|| Value::Object(Map::new()));
    if !st.is_object() {
        *st = Value::Object(Map::new());
    }
    let st = st.as_object_mut().expect("object");
    let mut names: Vec<&str> = Vec::new();
    for name in telemetry.gpus.iter().filter_map(|g| g.name.as_deref()) {
        if !name.trim().is_empty() && !names.contains(&name) {
            names.push(name);
        }
    }
    if !st
        .get("gpu_name")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty())
        && !names.is_empty()
    {
        st.insert("gpu_name".into(), json!(names.join(" + ")));
    }
    if !is_number(st.get("gpu_count")) || st.get("gpu_count").and_then(Value::as_f64) == Some(0.0) {
        st.insert("gpu_count".into(), json!(telemetry.gpus.len()));
    }
    if !is_number(st.get("gpu_vram_total_mib")) {
        if let Some(total) = sum(telemetry.gpus.iter().map(|g| g.mem_total)) {
            st.insert(
                "gpu_vram_total_mib".into(),
                json!((total / 1_048_576.0).round()),
            );
        }
    }
    // The engine's note explains its own NVML-only reader; the readings now come from here.
    if let Some(note) = st.get("gpu_note").filter(|n| !n.is_null()).cloned() {
        st.insert("gpu_note_engine".into(), note);
        st.insert("gpu_note".into(), Value::Null);
    }
    st.insert("gpu_telemetry_source".into(), json!(telemetry.source));

    if history.is_empty() {
        return;
    }
    let series = root
        .entry("history")
        .or_insert_with(|| Value::Object(Map::new()));
    if !series.is_object() {
        *series = Value::Object(Map::new());
    }
    let series = series.as_object_mut().expect("object");
    // Match the engine's window so every sparkline spans the same time.
    let length = ["cpu", "tok_s", "ram_used"]
        .iter()
        .find_map(|k| series.get(*k).and_then(Value::as_array).map(Vec::len))
        .filter(|n| *n > 0)
        .unwrap_or(history.len());
    for (slot, key) in HISTORY_KEYS.iter().enumerate() {
        let empty = series
            .get(*key)
            .and_then(Value::as_array)
            .is_none_or(|values| values.iter().all(|v| !is_number(Some(v))));
        if !empty {
            continue;
        }
        let tail = &history[history.len().saturating_sub(length)..];
        let mut values: Vec<Value> = vec![Value::Null; length - tail.len()];
        values.extend(
            tail.iter()
                .map(|p| p[slot].map_or(Value::Null, |v| json!(v))),
        );
        series.insert((*key).into(), Value::Array(values));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(name: &str, util: f64, used_gib: f64, temp: f64, power: f64) -> AmdGpuSample {
        AmdGpuSample {
            name: Some(name.into()),
            util: Some(util),
            mem_used: Some(used_gib * 1_073_741_824.0),
            mem_total: Some(24.0 * 1_073_741_824.0),
            temp: Some(temp),
            hotspot_temp: Some(temp + 15.0),
            power: Some(power),
            clock_mhz: Some(2500.0),
            mem_clock_mhz: Some(1250.0),
            pcie_gen_max: Some(4.0),
            pcie_width: Some(16.0),
            ..Default::default()
        }
    }

    /// Engine response captured on Windows with an RX 7900 XTX (issue #86): every GPU field null.
    fn windows_amd_engine_metrics() -> Value {
        json!({
            "live": {"state": "idle"},
            "hardware": {"cpu": 2.0, "gpu_util": null, "gpu_mem_used": null, "gpu_mem_total": null,
                          "gpu_temp": null, "gpu_power": null, "ram_used": 1.0, "ram_total": 2.0},
            "hardware_static": {"gpu_name": null, "gpu_count": 0,
                                 "gpu_note": "Windows AMD: no NVML", "threads": 24, "cores": 12},
            "history": {"cpu": [1.0, 2.0, 3.0], "gpu_util": [null, null, null], "gpu_temp": [null, null, null]}
        })
    }

    #[test]
    fn fills_missing_windows_amd_fields_and_keeps_engine_values() {
        let mut metrics = windows_amd_engine_metrics();
        assert!(engine_lacks_gpu_telemetry(&metrics));
        let telemetry = AmdTelemetry {
            source: "amd-adlx",
            gpus: vec![card("AMD Radeon RX 7900 XTX", 87.0, 20.0, 64.0, 312.0)],
        };
        let history = vec![
            [Some(10.0), None, Some(50.0), Some(100.0)],
            [Some(87.0), None, Some(64.0), Some(312.0)],
        ];
        merge_into_metrics(&mut metrics, &telemetry, &history);
        let hw = &metrics["hardware"];
        assert_eq!(hw["gpu_util"], 87.0);
        assert_eq!(hw["gpu_mem_used"], 20.0 * 1_073_741_824.0);
        assert_eq!(hw["gpu_mem_total"], 24.0 * 1_073_741_824.0);
        assert_eq!(hw["gpu_temp"], 64.0);
        assert_eq!(hw["gpu_hotspot_temp"], 79.0);
        assert_eq!(hw["gpu_power"], 312.0);
        assert_eq!(hw["gpu_clock_mhz"], 2500.0);
        assert_eq!(hw["gpu_pcie_gen_max"], 4.0);
        assert!(
            hw.get("gpu_power_limit").is_none(),
            "unknown limit stays absent"
        );
        assert_eq!(hw["cpu"], 2.0, "engine values are kept");
        assert_eq!(hw["gpus"][0]["name"], "AMD Radeon RX 7900 XTX");
        let st = &metrics["hardware_static"];
        assert_eq!(st["gpu_name"], "AMD Radeon RX 7900 XTX");
        assert_eq!(st["gpu_count"], 1);
        assert_eq!(st["gpu_vram_total_mib"], 24576.0);
        assert!(st["gpu_note"].is_null());
        assert_eq!(st["gpu_note_engine"], "Windows AMD: no NVML");
        assert_eq!(st["gpu_telemetry_source"], "amd-adlx");
        assert_eq!(metrics["history"]["gpu_util"], json!([null, 10.0, 87.0]));
        assert_eq!(metrics["history"]["gpu_temp"], json!([null, 50.0, 64.0]));
        assert_eq!(
            metrics["history"]["gpu_mem_used"],
            json!([null, null, null])
        );
        assert_eq!(metrics["history"]["cpu"], json!([1.0, 2.0, 3.0]));
    }

    #[test]
    fn empty_engine_card_records_are_replaced() {
        let mut metrics =
            json!({"hardware": {"gpus": [{"index": 0, "util": null, "mem_used": null}]}});
        assert!(engine_lacks_gpu_telemetry(&metrics));
        let telemetry = AmdTelemetry {
            source: "amd-adlx",
            gpus: vec![card("AMD Radeon RX 7900 XTX", 50.0, 8.0, 60.0, 200.0)],
        };
        merge_into_metrics(&mut metrics, &telemetry, &[]);
        assert_eq!(metrics["hardware"]["gpus"][0]["util"], 50.0);
        assert_eq!(metrics["hardware"]["gpus"][0]["power"], 200.0);
    }

    #[test]
    fn aggregates_multiple_cards_like_the_engine() {
        let mut metrics = json!({"hardware": {}});
        let telemetry = AmdTelemetry {
            source: "amdgpu-sysfs",
            gpus: vec![
                card("A", 80.0, 10.0, 60.0, 200.0),
                card("A", 40.0, 6.0, 70.0, 150.0),
            ],
        };
        merge_into_metrics(&mut metrics, &telemetry, &[]);
        let hw = &metrics["hardware"];
        assert_eq!(hw["gpu_util"], 60.0);
        assert_eq!(hw["gpu_mem_used"], 16.0 * 1_073_741_824.0);
        assert_eq!(hw["gpu_temp"], 70.0);
        assert_eq!(hw["gpu_power"], 350.0);
        assert_eq!(hw["gpus"].as_array().unwrap().len(), 2);
        assert_eq!(hw["gpus"][1]["index"], 1);
        assert_eq!(metrics["hardware_static"]["gpu_name"], "A");
        assert!(metrics.get("history").is_none());
    }

    #[test]
    fn missing_fields_stay_absent_instead_of_zero() {
        let mut metrics = json!({"hardware": {}});
        let telemetry = AmdTelemetry {
            source: "amd-adlx",
            gpus: vec![AmdGpuSample {
                util: Some(0.0),
                ..Default::default()
            }],
        };
        merge_into_metrics(&mut metrics, &telemetry, &[]);
        let hw = &metrics["hardware"];
        assert_eq!(hw["gpu_util"], 0.0);
        for key in ["gpu_mem_used", "gpu_temp", "gpu_power", "gpu_clock_mhz"] {
            assert!(hw.get(key).is_none(), "{key}");
        }
        assert!(hw["gpus"][0].get("temp").is_none());
        assert!(metrics["hardware_static"].get("gpu_name").is_none());
    }

    #[test]
    fn nvidia_or_engine_readings_are_left_alone() {
        let nvidia = json!({"hardware": {"gpu_util": null}, "hardware_static": {"gpu_name": "NVIDIA GeForce RTX 4090"}});
        assert!(!engine_lacks_gpu_telemetry(&nvidia));
        let engine_reads = json!({"hardware": {"gpu_util": 50, "gpu_temp": null}});
        assert!(!engine_lacks_gpu_telemetry(&engine_reads));
        let per_card = json!({"hardware": {"gpus": [{"index": 0, "mem_used": 1}]}});
        assert!(!engine_lacks_gpu_telemetry(&per_card));
        let amd_named =
            json!({"hardware": {}, "hardware_static": {"gpu_name": "AMD Radeon RX 7900 XTX"}});
        assert!(engine_lacks_gpu_telemetry(&amd_named));
        assert!(!engine_lacks_gpu_telemetry(&json!(null)));
    }

    #[test]
    fn only_loopback_services_are_augmented() {
        for url in [
            "http://127.0.0.1:8080",
            "http://localhost:1",
            "http://[::1]:9",
            "http://0.0.0.0:5",
        ] {
            assert!(is_local_base_url(url), "{url}");
        }
        for url in [
            "http://192.168.1.20:8080",
            "https://example.com",
            "not a url",
        ] {
            assert!(!is_local_base_url(url), "{url}");
        }
    }

    #[test]
    fn history_window_follows_engine_length() {
        let mut metrics = json!({"history": {"tok_s": [0.0, 0.0]}});
        let telemetry = AmdTelemetry {
            source: "amd-adlx",
            gpus: vec![card("X", 1.0, 1.0, 1.0, 1.0)],
        };
        let history = vec![
            [Some(1.0), None, None, None],
            [Some(2.0), None, None, None],
            [Some(3.0), None, None, None],
        ];
        merge_into_metrics(&mut metrics, &telemetry, &history);
        assert_eq!(metrics["history"]["gpu_util"], json!([2.0, 3.0]));
    }
}
