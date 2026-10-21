//! macOS GPU identity for the environment check (#53 follow-up): `nvidia-smi` does not exist on a Mac, so an
//! Apple Silicon machine used to report no GPU at all. Identity comes from `system_profiler SPDisplaysDataType
//! -json` (name, vendor, core count, Metal family, VRAM on Intel Macs), with the IOKit `IOAccelerator` registry
//! (`ioreg`, no root) as fallback and for the live load. Nothing here matches chip names against a list: an
//! Apple vendor id plus a built-in bus is enough, so later chips (M6, Ultra, ...) need no update.
//!
//! Apple GPUs share one unified memory pool with the CPU. They are reported with `unified_memory` and the
//! machine's RAM, never as a separate VRAM figure, so model-fit estimates do not count the same bytes twice.
//! `gpu_budget_bytes` is the share Metal lets one process wire for the GPU (`recommendedMaxWorkingSetSize`,
//! the figure Strata's engine and telemetry use), or an estimate when Metal cannot be asked.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuDetail {
    pub name: String,
    /// "apple", "amd", "intel", "nvidia" or "unknown".
    pub vendor: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cores: Option<u32>,
    /// Apple Silicon: the GPU uses system RAM; `memory_bytes` is then the whole unified pool.
    pub unified_memory: bool,
    /// Dedicated VRAM (discrete GPU), or the unified pool on Apple Silicon. None for shared iGPUs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_bytes: Option<u64>,
    /// Unified memory only: how much of it Metal lets one process use for the GPU.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_budget_bytes: Option<u64>,
    /// True when `gpu_budget_bytes` is the documented default ratio, not a Metal reading.
    pub gpu_budget_estimated: bool,
    /// Highest Metal family reported by macOS, e.g. 4 for "Metal 4". None when unknown/unsupported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metal: Option<u32>,
    pub source: String,
}

/// Live readings of one IOAccelerator node (the same keys Strata's `serve/telemetry.py` reads).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AcceleratorNode {
    pub model: Option<String>,
    pub cores: Option<u32>,
    pub utilization: Option<u32>,
    pub memory_in_use: Option<u64>,
}

const MIB: u64 = 1 << 20;
const GIB: u64 = 1 << 30;

fn text<'a>(item: &'a Value, key: &str) -> Option<&'a str> {
    item.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// "sppci_vendor_Apple", "Apple", "ATI (0x1002)", "sppci_vendor_amd", "Intel", "NVIDIA (0x10de)" ...
fn vendor_of(vendor: Option<&str>, name: &str) -> &'static str {
    let lower = vendor.unwrap_or_default().to_ascii_lowercase();
    let name = name.to_ascii_lowercase();
    if lower.contains("apple") || lower.contains("0x106b") {
        "apple"
    } else if lower.contains("amd") || lower.contains("ati") || lower.contains("0x1002") {
        "amd"
    } else if lower.contains("intel") || lower.contains("0x8086") {
        "intel"
    } else if lower.contains("nvidia") || lower.contains("0x10de") {
        "nvidia"
    } else if name.starts_with("apple ") {
        "apple"
    } else if name.contains("radeon") || name.starts_with("amd ") {
        "amd"
    } else if name.starts_with("intel ") {
        "intel"
    } else if name.contains("nvidia") || name.contains("geforce") {
        "nvidia"
    } else {
        "unknown"
    }
}

/// "8 GB", "1536 MB", "4096 MB" -> bytes.
fn memory_text(value: &str) -> Option<u64> {
    let mut parts = value.split_whitespace();
    let amount: f64 = parts.next()?.parse().ok()?;
    if !amount.is_finite() || amount <= 0.0 {
        return None;
    }
    let unit = match parts.next()?.to_ascii_uppercase().as_str() {
        "GB" | "GIB" => GIB,
        "MB" | "MIB" => MIB,
        _ => return None,
    };
    Some((amount * unit as f64).round() as u64)
}

/// "spdisplays_metal4" -> 4; "spdisplays_metal3" -> 3. Older feature-set spellings give None.
fn metal_family(value: Option<&str>) -> Option<u32> {
    let value = value?.to_ascii_lowercase();
    let digits = value.strip_prefix("spdisplays_metal")?;
    digits.parse().ok().filter(|family| *family > 0)
}

/// Parses `system_profiler SPDisplaysDataType -json`. `total_memory` is the machine's RAM (the unified pool).
pub fn parse_system_profiler(json: &str, total_memory: u64) -> Vec<GpuDetail> {
    let Ok(root) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    let Some(items) = root.get("SPDisplaysDataType").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter(|item| text(item, "sppci_device_type").is_none_or(|kind| kind == "spdisplays_gpu"))
        .filter_map(|item| {
            let name = text(item, "sppci_model").or_else(|| text(item, "_name"))?;
            let vendor = vendor_of(text(item, "spdisplays_vendor"), name);
            let builtin = text(item, "sppci_bus").is_none_or(|bus| bus == "spdisplays_builtin");
            let unified = vendor == "apple" && builtin;
            let cores = text(item, "sppci_cores")
                .and_then(|cores| cores.parse().ok())
                .filter(|cores| *cores > 0);
            // Discrete cards list `spdisplays_vram`; Intel iGPUs list a shared carve-out, which is not VRAM.
            let memory = if unified {
                (total_memory > 0).then_some(total_memory)
            } else if text(item, "spdisplays_vram_shared").is_some() {
                None
            } else {
                text(item, "spdisplays_vram").and_then(memory_text)
            };
            Some(GpuDetail {
                name: name.to_owned(),
                vendor: vendor.into(),
                cores,
                unified_memory: unified,
                memory_bytes: memory,
                gpu_budget_bytes: None,
                gpu_budget_estimated: false,
                metal: metal_family(text(item, "spdisplays_mtlgpufamilysupport")),
                source: "system_profiler".into(),
            })
        })
        .collect()
}

fn ioreg_number(block: &str, key: &str) -> Option<f64> {
    let pattern = format!("\"{key}\"");
    let start = block.find(&pattern)? + pattern.len();
    let rest = block[start..].trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    let end = rest
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

/// Parses `ioreg -l -w0 -r -c IOAccelerator`: one node per accelerator that carries PerformanceStatistics.
pub fn parse_ioreg(text: &str) -> Vec<AcceleratorNode> {
    text.split("+-o ")
        .filter(|block| block.contains("\"PerformanceStatistics\""))
        .map(|block| {
            let model = block.find("\"model\" = \"").and_then(|start| {
                let rest = &block[start + "\"model\" = \"".len()..];
                rest.find('"').map(|end| rest[..end].trim().to_owned())
            });
            let utilization = ioreg_number(block, "Device Utilization %").or_else(|| {
                // Older chips report only the renderer and the tiler.
                [
                    ioreg_number(block, "Renderer Utilization %"),
                    ioreg_number(block, "Tiler Utilization %"),
                ]
                .into_iter()
                .flatten()
                .reduce(f64::max)
            });
            AcceleratorNode {
                model: model.filter(|model| !model.is_empty()),
                cores: ioreg_number(block, "gpu-core-count")
                    .map(|cores| cores as u32)
                    .filter(|cores| *cores > 0),
                utilization: utilization.map(|value| value.clamp(0.0, 100.0) as u32),
                memory_in_use: ioreg_number(block, "In use system memory").map(|v| v as u64),
            }
        })
        .collect()
}

/// macOS' default GPU wiring limit when Metal cannot be asked: about two thirds of RAM up to 36 GiB, three
/// quarters above (the same split `recommendedMaxWorkingSetSize` reports). A `iogpu.wired_limit_mb` override wins.
pub fn estimated_gpu_budget(total_memory: u64, wired_limit_mb: Option<u64>) -> Option<u64> {
    if let Some(limit) = wired_limit_mb.filter(|limit| *limit > 0) {
        return Some(limit * MIB);
    }
    if total_memory == 0 {
        return None;
    }
    Some(if total_memory > 36 * GIB {
        total_memory / 4 * 3
    } else {
        total_memory / 3 * 2
    })
}

/// Fills gaps from the IOKit registry (name/cores) and adds the Metal budget to unified GPUs.
pub fn merge(
    mut gpus: Vec<GpuDetail>,
    nodes: &[AcceleratorNode],
    total_memory: u64,
    metal_budget: Option<u64>,
    wired_limit_mb: Option<u64>,
) -> Vec<GpuDetail> {
    if gpus.is_empty() {
        gpus = nodes
            .iter()
            .filter_map(|node| {
                let name = node.model.clone()?;
                let vendor = vendor_of(None, &name);
                let unified = vendor == "apple";
                Some(GpuDetail {
                    name,
                    vendor: vendor.into(),
                    cores: node.cores,
                    unified_memory: unified,
                    memory_bytes: (unified && total_memory > 0).then_some(total_memory),
                    source: "ioreg".into(),
                    ..GpuDetail::default()
                })
            })
            .collect();
    }
    for gpu in gpus.iter_mut().filter(|gpu| gpu.unified_memory) {
        if gpu.cores.is_none() {
            gpu.cores = nodes
                .iter()
                .find(|node| node.model.as_deref() == Some(gpu.name.as_str()))
                .or(nodes.first())
                .and_then(|node| node.cores);
        }
        match metal_budget.filter(|budget| *budget > 0) {
            Some(budget) => gpu.gpu_budget_bytes = Some(budget),
            None => {
                gpu.gpu_budget_bytes = estimated_gpu_budget(total_memory, wired_limit_mb);
                gpu.gpu_budget_estimated = gpu.gpu_budget_bytes.is_some();
            }
        }
    }
    gpus
}

/// The `EnvironmentInfo.gpus` line. Only NVIDIA lines carry a memory figure elsewhere; a Mac line is the bare
/// name so older UI code that reads "<name>, <driver>, <MiB>" never mistakes unified RAM (or an Intel Mac's AMD
/// card, which Strata does not use) for CUDA VRAM.
pub fn environment_line(gpu: &GpuDetail) -> String {
    gpu.name.replace(',', " ")
}

/// One support-diagnostics line: "Apple M5 Pro · 20-core · Metal 4 · unified 48 GiB (GPU budget ≈36 GiB)".
pub fn diagnostic_line(gpu: &GpuDetail) -> String {
    let mut parts = vec![gpu.name.clone()];
    if let Some(cores) = gpu.cores {
        parts.push(format!("{cores}-core"));
    }
    if let Some(metal) = gpu.metal {
        parts.push(format!("Metal {metal}"));
    }
    let gib = |bytes: u64| format!("{:.0} GiB", bytes as f64 / GIB as f64);
    match (gpu.unified_memory, gpu.memory_bytes) {
        (true, Some(total)) => parts.push(match gpu.gpu_budget_bytes {
            Some(budget) => format!(
                "unified {} (GPU budget {}{})",
                gib(total),
                if gpu.gpu_budget_estimated { "≈" } else { "" },
                gib(budget)
            ),
            None => format!("unified {}", gib(total)),
        }),
        (false, Some(vram)) => parts.push(format!("VRAM {}", gib(vram))),
        _ => {}
    }
    parts.push(format!("[{}]", gpu.source));
    parts.join(" · ")
}

#[cfg(target_os = "macos")]
mod native {
    use std::ffi::{c_char, c_void};

    #[link(name = "Metal", kind = "framework")]
    unsafe extern "C" {
        fn MTLCreateSystemDefaultDevice() -> *mut c_void;
    }
    #[link(name = "objc")]
    unsafe extern "C" {
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn object_getClass(object: *mut c_void) -> *mut c_void;
        fn class_respondsToSelector(class: *mut c_void, selector: *mut c_void) -> bool;
        fn objc_msgSend();
    }

    /// `MTLCreateSystemDefaultDevice().recommendedMaxWorkingSetSize`, as Strata's telemetry reads it. The class
    /// is asked first: an unanswered selector would raise an Objective-C exception.
    pub fn metal_working_set() -> Option<u64> {
        type SendU64 = unsafe extern "C" fn(*mut c_void, *mut c_void) -> u64;
        type SendVoid = unsafe extern "C" fn(*mut c_void, *mut c_void);
        // SAFETY: objc_msgSend is called through the exact signatures of the two selectors used (`-(uint64_t)
        // recommendedMaxWorkingSetSize` and `-(oneway void)release`); the device pointer is checked for null and
        // released once, matching MTLCreateSystemDefaultDevice's +1 ownership.
        unsafe {
            let device = MTLCreateSystemDefaultDevice();
            if device.is_null() {
                return None;
            }
            let working_set = sel_registerName(c"recommendedMaxWorkingSetSize".as_ptr());
            let release = sel_registerName(c"release".as_ptr());
            let send_u64 = std::mem::transmute::<unsafe extern "C" fn(), SendU64>(
                objc_msgSend as unsafe extern "C" fn(),
            );
            let send_void = std::mem::transmute::<unsafe extern "C" fn(), SendVoid>(
                objc_msgSend as unsafe extern "C" fn(),
            );
            let value = if class_respondsToSelector(object_getClass(device), working_set) {
                send_u64(device, working_set)
            } else {
                0
            };
            send_void(device, release);
            (value > 0).then_some(value)
        }
    }

    pub fn sysctl_u64(name: &std::ffi::CStr) -> Option<u64> {
        let mut value: u64 = 0;
        let mut size = std::mem::size_of::<u64>();
        // SAFETY: the out-pointer and size describe a valid u64; a smaller integer is zero-extended.
        let status = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                (&mut value as *mut u64).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        (status == 0 && size <= 8).then_some(value)
    }
}

/// Probes this Mac. Cheap enough for the 60 s environment cache: system_profiler ~0.3 s, ioreg ~20 ms.
#[cfg(target_os = "macos")]
pub fn probe(total_memory: u64) -> Vec<GpuDetail> {
    let profiled = crate::output_with_timeout(
        "/usr/sbin/system_profiler",
        &["SPDisplaysDataType", "-json"],
        std::time::Duration::from_secs(8),
    )
    .map(|json| parse_system_profiler(&json, total_memory))
    .unwrap_or_default();
    let nodes = crate::output(
        "/usr/sbin/ioreg",
        &["-l", "-w0", "-r", "-c", "IOAccelerator"],
    )
    .map(|text| parse_ioreg(&text))
    .unwrap_or_default();
    let needs_budget = profiled.is_empty() || profiled.iter().any(|gpu| gpu.unified_memory);
    let metal = needs_budget.then(native::metal_working_set).flatten();
    let wired = native::sysctl_u64(c"iogpu.wired_limit_mb");
    merge(profiled, &nodes, total_memory, metal, wired)
}

#[cfg(not(target_os = "macos"))]
pub fn probe(_total_memory: u64) -> Vec<GpuDetail> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    const RAM_48: u64 = 48 * GIB;
    fn fixture(name: &str) -> String {
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/apple_gpu")
                .join(name),
        )
        .unwrap()
    }

    #[test]
    fn m5_pro_is_an_apple_unified_gpu_with_cores_and_metal_4() {
        let gpus = parse_system_profiler(&fixture("sp-displays-m5-pro.json"), RAM_48);
        assert_eq!(gpus.len(), 1);
        let gpu = &gpus[0];
        assert_eq!(gpu.name, "Apple M5 Pro");
        assert_eq!(gpu.vendor, "apple");
        assert_eq!(gpu.cores, Some(20));
        assert!(gpu.unified_memory);
        assert_eq!(gpu.memory_bytes, Some(RAM_48));
        assert_eq!(gpu.metal, Some(4));
        assert_eq!(environment_line(gpu), "Apple M5 Pro");
    }

    #[test]
    fn unknown_future_chip_names_are_detected_by_vendor_not_by_a_model_list() {
        let json = fixture("sp-displays-m5-pro.json")
            .replace("Apple M5 Pro", "Apple M9 Hyper")
            .replace("spdisplays_metal4", "spdisplays_metal7");
        let gpu = &parse_system_profiler(&json, RAM_48)[0];
        assert_eq!(
            (gpu.name.as_str(), gpu.vendor.as_str()),
            ("Apple M9 Hyper", "apple")
        );
        assert!(gpu.unified_memory);
        assert_eq!(gpu.metal, Some(7));
    }

    #[test]
    fn external_displays_do_not_add_gpus() {
        let gpus = parse_system_profiler(&fixture("sp-displays-m1-max-external.json"), 64 * GIB);
        assert_eq!(gpus.len(), 1);
        assert_eq!((gpus[0].cores, gpus[0].metal), (Some(32), Some(3)));
    }

    #[test]
    fn intel_mac_lists_both_gpus_without_unified_memory() {
        let gpus = parse_system_profiler(&fixture("sp-displays-intel-amd.json"), 16 * GIB);
        assert_eq!(gpus.len(), 2);
        assert_eq!(gpus[0].vendor, "intel");
        assert_eq!(gpus[0].memory_bytes, None, "shared iGPU memory is not VRAM");
        assert_eq!(gpus[1].vendor, "amd");
        assert_eq!(gpus[1].memory_bytes, Some(8 * GIB));
        assert!(gpus.iter().all(|gpu| !gpu.unified_memory));
        // No budget is invented for discrete/shared GPUs.
        let merged = merge(gpus, &[], 16 * GIB, None, None);
        assert!(merged.iter().all(|gpu| gpu.gpu_budget_bytes.is_none()));
        assert_eq!(environment_line(&merged[1]), "AMD Radeon Pro 5500M");
    }

    #[test]
    fn virtual_mac_gpu_has_no_metal_family() {
        let gpu = &parse_system_profiler(&fixture("sp-displays-vm.json"), 14 * GIB)[0];
        assert_eq!(gpu.vendor, "apple");
        assert_eq!((gpu.cores, gpu.metal), (None, None));
    }

    #[test]
    fn broken_or_empty_profiler_output_is_no_gpu() {
        assert!(parse_system_profiler("", RAM_48).is_empty());
        assert!(parse_system_profiler("{\"SPDisplaysDataType\":[]}", RAM_48).is_empty());
        assert!(parse_system_profiler("not json", RAM_48).is_empty());
    }

    #[test]
    fn ioreg_reads_cores_load_and_memory_in_use() {
        let nodes = parse_ioreg(&fixture("ioreg-agx-m5-pro.txt"));
        assert_eq!(
            nodes,
            vec![AcceleratorNode {
                model: Some("Apple M5 Pro".into()),
                cores: Some(20),
                utilization: Some(87),
                memory_in_use: Some(22_548_578_304),
            }]
        );
        let legacy = parse_ioreg(&fixture("ioreg-agx-legacy.txt"));
        assert_eq!(legacy[0].utilization, Some(3), "renderer/tiler fallback");
        assert_eq!(legacy[0].cores, None);
        assert!(parse_ioreg("").is_empty());
    }

    #[test]
    fn ioreg_alone_still_identifies_the_gpu_when_system_profiler_fails() {
        let nodes = parse_ioreg(&fixture("ioreg-agx-m5-pro.txt"));
        let gpus = merge(Vec::new(), &nodes, RAM_48, Some(36 * GIB), None);
        assert_eq!(gpus.len(), 1);
        assert_eq!(gpus[0].name, "Apple M5 Pro");
        assert_eq!(gpus[0].cores, Some(20));
        assert!(gpus[0].unified_memory);
        assert_eq!(gpus[0].gpu_budget_bytes, Some(36 * GIB));
        assert!(!gpus[0].gpu_budget_estimated);
    }

    #[test]
    fn budget_prefers_metal_then_the_wired_limit_then_the_default_ratio() {
        let base = || parse_system_profiler(&fixture("sp-displays-m5-pro.json"), RAM_48);
        let metal = merge(base(), &[], RAM_48, Some(38_654_705_664), None);
        assert_eq!(metal[0].gpu_budget_bytes, Some(38_654_705_664));
        assert_eq!(
            diagnostic_line(&metal[0]),
            "Apple M5 Pro · 20-core · Metal 4 · unified 48 GiB (GPU budget 36 GiB) · [system_profiler]"
        );
        let wired = merge(base(), &[], RAM_48, None, Some(40960));
        assert_eq!(wired[0].gpu_budget_bytes, Some(40 * GIB));
        assert!(wired[0].gpu_budget_estimated);
        let default = merge(base(), &[], RAM_48, None, Some(0));
        assert_eq!(default[0].gpu_budget_bytes, Some(36 * GIB));
        assert_eq!(estimated_gpu_budget(24 * GIB, None), Some(16 * GIB));
        assert_eq!(estimated_gpu_budget(0, None), None);
    }

    #[test]
    fn detail_serializes_in_camel_case() {
        let gpu = merge(
            parse_system_profiler(&fixture("sp-displays-m5-pro.json"), RAM_48),
            &[],
            RAM_48,
            Some(36 * GIB),
            None,
        );
        let json = serde_json::to_value(&gpu[0]).unwrap();
        assert_eq!(json["unifiedMemory"], true);
        assert_eq!(json["gpuBudgetBytes"], 36 * GIB);
        assert_eq!(json["metal"], 4);
    }

    /// Runs only on a real Mac (the macOS CI job): the probe must not panic and an Apple Silicon host's GPUs are
    /// unified. A VM runner may expose no accelerator, so presence is not asserted.
    #[cfg(target_os = "macos")]
    #[test]
    fn probe_on_this_mac_does_not_panic() {
        let gpus = probe(64 * GIB);
        eprintln!("macOS GPU probe: {gpus:?}");
        for gpu in gpus.iter().filter(|gpu| gpu.vendor == "apple") {
            assert!(gpu.unified_memory);
        }
    }
}
