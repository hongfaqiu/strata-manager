//! Linux `amdgpu` sysfs reader. Every file is optional: kernels and cards differ in what they
//! expose, and a missing or unreadable file only leaves that field empty.
//! https://docs.kernel.org/gpu/amdgpu/thermal.html , https://docs.kernel.org/gpu/amdgpu/driver-misc.html

use super::{non_negative, positive, AmdGpuSample, AmdTelemetry};
use std::path::{Path, PathBuf};

const AMD_VENDOR: &str = "0x1002";
/// Cards with at least this much dedicated memory are the ones a model runs on; smaller APU
/// carve-outs are ignored when such a card exists.
const DISCRETE_MIN_BYTES: f64 = 4.0 * 1_073_741_824.0;

fn read(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}
fn read_f64(path: &Path) -> Option<f64> {
    read(path)?.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// `pp_dpm_sclk` / `pp_dpm_mclk`: the active level is marked with `*`, e.g. `1: 2482Mhz *`.
pub(crate) fn parse_dpm_active_mhz(text: &str) -> Option<f64> {
    text.lines()
        .find(|l| l.trim_end().ends_with('*'))
        .and_then(|line| {
            let value = line.split(':').nth(1)?.trim().trim_end_matches('*').trim();
            let lower = value.to_ascii_lowercase();
            let number = lower.strip_suffix("mhz")?.trim();
            number.parse::<f64>().ok().and_then(positive)
        })
}

fn hwmon_dir(device: &Path) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(device.join("hwmon"))
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    dirs.iter()
        .find(|p| read(&p.join("name")).as_deref() == Some("amdgpu"))
        .or(dirs.first())
        .cloned()
}

/// `tempN_label` is `edge`, `junction` or `mem`; without labels, temp1 is the edge sensor.
fn temperatures(hwmon: &Path) -> (Option<f64>, Option<f64>) {
    let (mut edge, mut junction) = (None, None);
    let mut labelled = false;
    for n in 1..=4 {
        let Some(value) = read_f64(&hwmon.join(format!("temp{n}_input"))).map(|v| v / 1000.0)
        else {
            continue;
        };
        match read(&hwmon.join(format!("temp{n}_label"))).as_deref() {
            Some("edge") => {
                labelled = true;
                edge = positive(value);
            }
            Some("junction") => {
                labelled = true;
                junction = positive(value);
            }
            _ => {}
        }
    }
    if !labelled {
        edge = read_f64(&hwmon.join("temp1_input")).and_then(|v| positive(v / 1000.0));
    }
    // Some APUs expose only the junction sensor: show it as the GPU temperature.
    (edge.or(junction), junction)
}

/// Clock from the hwmon `freqN_input` (Hz) whose label matches, else the DPM table.
fn clock_mhz(device: &Path, hwmon: Option<&Path>, label: &str, dpm: &str) -> Option<f64> {
    if let Some(hwmon) = hwmon {
        for n in 1..=2 {
            if read(&hwmon.join(format!("freq{n}_label"))).as_deref() == Some(label) {
                if let Some(hz) = read_f64(&hwmon.join(format!("freq{n}_input"))) {
                    return positive(hz / 1_000_000.0);
                }
            }
        }
    }
    read(&device.join(dpm))
        .as_deref()
        .and_then(parse_dpm_active_mhz)
}

/// One `/sys/class/drm/cardN/device` directory, or `None` when it is not an amdgpu device.
pub(crate) fn read_device(device: &Path) -> Option<AmdGpuSample> {
    if read(&device.join("vendor"))?.to_ascii_lowercase() != AMD_VENDOR {
        return None;
    }
    let util = read_f64(&device.join("gpu_busy_percent")).and_then(non_negative);
    let mem_used = read_f64(&device.join("mem_info_vram_used")).and_then(non_negative);
    let mem_total = read_f64(&device.join("mem_info_vram_total")).and_then(positive);
    // Not an amdgpu-driven card (e.g. radeon driver): nothing useful to show.
    if util.is_none() && mem_total.is_none() {
        return None;
    }
    let hwmon = hwmon_dir(device);
    let hw = hwmon.as_deref();
    let (temp, hotspot_temp) = hw.map(temperatures).unwrap_or_default();
    let microwatts = |name: &str| {
        hw.and_then(|h| read_f64(&h.join(name)))
            .and_then(|v| positive(v / 1_000_000.0))
    };
    Some(AmdGpuSample {
        name: read(&device.join("product_name")),
        util,
        mem_used,
        mem_total,
        temp,
        hotspot_temp,
        power: microwatts("power1_average").or_else(|| microwatts("power1_input")),
        power_limit: microwatts("power1_cap"),
        clock_mhz: clock_mhz(device, hw, "sclk", "pp_dpm_sclk"),
        mem_clock_mhz: clock_mhz(device, hw, "mclk", "pp_dpm_mclk"),
        fan_rpm: hw
            .and_then(|h| read_f64(&h.join("fan1_input")))
            .and_then(positive),
        // The card's own PCIe link (current_link_*) reports its internal switch on many Radeon
        // boards, not the slot; leave PCIe empty rather than show a misleading x1 link.
        pcie_gen_max: None,
        pcie_width: None,
    })
}

/// Scan `drm_root` (normally `/sys/class/drm`) for `cardN` entries driven by amdgpu.
pub(crate) fn sample(drm_root: &Path) -> Option<AmdTelemetry> {
    let mut cards: Vec<(u32, PathBuf)> = std::fs::read_dir(drm_root)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let index = name.strip_prefix("card")?.parse::<u32>().ok()?;
            Some((index, entry.path().join("device")))
        })
        .collect();
    cards.sort();
    let mut gpus: Vec<AmdGpuSample> = cards.iter().filter_map(|(_, d)| read_device(d)).collect();
    if gpus
        .iter()
        .any(|g| g.mem_total.is_some_and(|t| t >= DISCRETE_MIN_BYTES))
    {
        gpus.retain(|g| g.mem_total.is_some_and(|t| t >= DISCRETE_MIN_BYTES));
    }
    (!gpus.is_empty()).then_some(AmdTelemetry {
        source: "amdgpu-sysfs",
        gpus,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(root: &Path, files: &[(&str, &str)]) {
        for (path, content) in files {
            let path = root.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
    }

    /// Files as an RX 7900 XTX exposes them on Linux 6.x (values from a real card).
    fn rx7900xtx(root: &Path, card: &str) {
        let d = format!("{card}/device");
        write(
            root,
            &[
                (&format!("{d}/vendor"), "0x1002\n"),
                (&format!("{d}/gpu_busy_percent"), "87\n"),
                (&format!("{d}/mem_info_vram_used"), "21474836480\n"),
                (&format!("{d}/mem_info_vram_total"), "25753026560\n"),
                (
                    &format!("{d}/pp_dpm_sclk"),
                    "0: 500Mhz\n1: 2482Mhz *\n2: 2526Mhz\n",
                ),
                (
                    &format!("{d}/pp_dpm_mclk"),
                    "0: 96Mhz\n1: 456Mhz\n2: 1249Mhz *\n",
                ),
                (&format!("{d}/hwmon/hwmon3/name"), "amdgpu\n"),
                (&format!("{d}/hwmon/hwmon3/temp1_input"), "64000\n"),
                (&format!("{d}/hwmon/hwmon3/temp1_label"), "edge\n"),
                (&format!("{d}/hwmon/hwmon3/temp2_input"), "79000\n"),
                (&format!("{d}/hwmon/hwmon3/temp2_label"), "junction\n"),
                (&format!("{d}/hwmon/hwmon3/temp3_input"), "70000\n"),
                (&format!("{d}/hwmon/hwmon3/temp3_label"), "mem\n"),
                (&format!("{d}/hwmon/hwmon3/power1_average"), "312000000\n"),
                (&format!("{d}/hwmon/hwmon3/power1_cap"), "355000000\n"),
                (&format!("{d}/hwmon/hwmon3/freq1_input"), "2500000000\n"),
                (&format!("{d}/hwmon/hwmon3/freq1_label"), "sclk\n"),
                (&format!("{d}/hwmon/hwmon3/fan1_input"), "1450\n"),
            ],
        );
    }

    #[test]
    fn reads_a_discrete_radeon() {
        let dir = tempfile::tempdir().unwrap();
        rx7900xtx(dir.path(), "card1");
        let t = sample(dir.path()).unwrap();
        assert_eq!(t.source, "amdgpu-sysfs");
        let g = &t.gpus[0];
        assert_eq!(g.util, Some(87.0));
        assert_eq!(g.mem_used, Some(21474836480.0));
        assert_eq!(g.mem_total, Some(25753026560.0));
        assert_eq!(g.temp, Some(64.0));
        assert_eq!(g.hotspot_temp, Some(79.0));
        assert_eq!(g.power, Some(312.0));
        assert_eq!(g.power_limit, Some(355.0));
        assert_eq!(
            g.clock_mhz,
            Some(2500.0),
            "hwmon freq wins over the DPM table"
        );
        assert_eq!(g.mem_clock_mhz, Some(1249.0), "DPM fallback");
        assert_eq!(g.fan_rpm, Some(1450.0));
        assert_eq!(g.pcie_gen_max, None);
    }

    #[test]
    fn ignores_other_vendors_connectors_and_small_apus_next_to_a_dgpu() {
        let dir = tempfile::tempdir().unwrap();
        rx7900xtx(dir.path(), "card1");
        write(
            dir.path(),
            &[
                ("card0/device/vendor", "0x10de\n"),
                ("card0/device/gpu_busy_percent", "5\n"),
                ("card1-DP-1/device/vendor", "0x1002\n"),
                ("card2/device/vendor", "0x1002\n"),
                ("card2/device/gpu_busy_percent", "3\n"),
                ("card2/device/mem_info_vram_total", "536870912\n"),
                ("renderD128/device/vendor", "0x1002\n"),
            ],
        );
        let t = sample(dir.path()).unwrap();
        assert_eq!(t.gpus.len(), 1);
        assert_eq!(t.gpus[0].util, Some(87.0));
    }

    #[test]
    fn apu_only_and_sparse_files_leave_fields_empty() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            &[
                ("card0/device/vendor", "0x1002"),
                ("card0/device/gpu_busy_percent", "0"),
                ("card0/device/mem_info_vram_total", "536870912"),
                ("card0/device/hwmon/hwmon0/name", "amdgpu"),
                ("card0/device/hwmon/hwmon0/temp1_input", "45000"),
                ("card0/device/hwmon/hwmon0/power1_input", "0"),
            ],
        );
        let t = sample(dir.path()).unwrap();
        let g = &t.gpus[0];
        assert_eq!(g.util, Some(0.0));
        assert_eq!(g.temp, Some(45.0), "unlabelled temp1 is the edge sensor");
        assert_eq!(g.power, None, "0 W means not reported");
        assert_eq!(g.mem_used, None);
        assert_eq!(g.clock_mhz, None);
    }

    #[test]
    fn no_amd_card_or_missing_root_is_none() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), &[("card0/device/vendor", "0x8086")]);
        assert!(sample(dir.path()).is_none());
        assert!(sample(&dir.path().join("missing")).is_none());
    }

    #[test]
    fn dpm_table_parsing() {
        assert_eq!(
            parse_dpm_active_mhz("0: 500Mhz\n1: 2482Mhz *\n"),
            Some(2482.0)
        );
        assert_eq!(parse_dpm_active_mhz("S: 19Mhz *\n0: 500Mhz\n"), Some(19.0));
        assert_eq!(parse_dpm_active_mhz("0: 500Mhz\n1: 2482Mhz\n"), None);
        assert_eq!(parse_dpm_active_mhz("garbage *"), None);
    }
}
