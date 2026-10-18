//! Read-only, finite resource guidance from the reviewed Strata v0.1.44 setup rules.
//! No inference, engine startup, download, calibration or configuration write is performed.
use crate::RuntimeState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

pub const SOURCE_REVISION: &str = "ed4773eb7c8f1f1531ba2bc70e0e1987de2661af";
const GIB: f64 = 1_073_741_824.0;
const GB: f64 = 1_000_000_000.0;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceAssessmentRequest {
    pub installation_id: String,
    pub family: String,
    pub quant: String,
    pub context: u64,
    pub images: bool,
    pub kv: String,
    pub gpu_ids: Vec<u32>,
    pub parallel: u32,
}
impl ResourceAssessmentRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.installation_id.trim().is_empty()
            || self.installation_id.len() > 256
            || self.installation_id.chars().any(char::is_control)
            || self.family.len() > 64
            || self.quant.len() > 128
            || self.kv.len() > 32
            || !(512..=1_048_576).contains(&self.context)
            || !(1..=64).contains(&self.parallel)
            || self.gpu_ids.len() > 8
            || self.gpu_ids.iter().any(|id| *id > 255)
            || self
                .gpu_ids
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != self.gpu_ids.len()
        {
            return Err("资源预估参数无效 / Invalid resource assessment request".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GpuSnapshot {
    id: u32,
    vendor: String,
    name: String,
    total_bytes: Option<u64>,
    available_bytes: Option<u64>,
    source: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HardwareSnapshot {
    sampled_at: u64,
    total_memory_bytes: u64,
    available_memory_bytes: u64,
    gpus: Vec<GpuSnapshot>,
    cpu_name: String,
    cpu_isa: String,
    wsl: bool,
    managed_service_running: bool,
}

fn bytes(value: f64, unit: f64) -> u64 {
    (value.max(0.0) * unit).round() as u64
}
fn parse_nvidia(text: &str) -> Vec<GpuSnapshot> {
    text.lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split(',').map(str::trim).collect();
            if fields.len() != 4 {
                return None;
            }
            let id = fields[0].parse().ok()?;
            let memory = |value: &str| {
                value
                    .trim_end_matches("MiB")
                    .trim()
                    .parse::<f64>()
                    .ok()
                    .filter(|number| number.is_finite() && *number >= 0.0)
                    .map(|number| bytes(number, 1_048_576.0))
            };
            let total = memory(fields[2]).filter(|total| *total > 0);
            let free = memory(fields[3]).filter(|free| total.is_none_or(|total| *free <= total));
            Some(GpuSnapshot {
                id,
                vendor: "nvidia".into(),
                name: fields[1].into(),
                total_bytes: total,
                available_bytes: free,
                source: "nvidia-smi".into(),
            })
        })
        .collect()
}
fn cpu_isa() -> String {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        if std::is_x86_feature_detected!("avx512f") {
            "avx512"
        } else if std::is_x86_feature_detected!("avx2") {
            "avx2"
        } else if std::is_x86_feature_detected!("sse4.2") {
            "sse4.2"
        } else {
            "unsupported"
        }
        .into()
    }
    #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
    "unknown".into()
}
fn hardware(state: &RuntimeState) -> Result<HardwareSnapshot, String> {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    system.refresh_cpu_all();
    let text = crate::output(
        "nvidia-smi",
        &[
            "--query-gpu=index,name,memory.total,memory.free",
            "--format=csv,noheader,nounits",
        ],
    );
    let gpus = text.as_deref().map(parse_nvidia).unwrap_or_default();
    #[cfg(windows)]
    let mut gpus = gpus;
    #[cfg(windows)]
    if gpus.is_empty() {
        if let Some(names) = crate::output(
            "powershell.exe",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }",
            ],
        ) {
            gpus = names
                .lines()
                .enumerate()
                .map(|(id, name)| GpuSnapshot {
                    id: id as u32,
                    vendor: "unknown".into(),
                    name: name.into(),
                    total_bytes: None,
                    available_bytes: None,
                    source: "windows-video-controller".into(),
                })
                .collect();
        }
    }
    let managed_service_running = {
        let mut processes = state.processes.lock().map_err(|error| error.to_string())?;
        processes
            .values_mut()
            .filter(|process| process.profile.is_some())
            .try_fold(false, |running, process| {
                process.refresh().map(|status| running || status.running)
            })?
    };
    let wsl = std::env::var_os("WSL_DISTRO_NAME").is_some()
        || std::env::var_os("WSL_INTEROP").is_some()
        || std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .is_ok_and(|release| release.to_ascii_lowercase().contains("microsoft"));
    Ok(HardwareSnapshot {
        sampled_at: crate::now(),
        total_memory_bytes: system.total_memory(),
        available_memory_bytes: system.available_memory(),
        gpus,
        cpu_name: system
            .cpus()
            .first()
            .map(|cpu| cpu.brand().to_owned())
            .unwrap_or_default(),
        cpu_isa: cpu_isa(),
        wsl,
        managed_service_running,
    })
}
/// Only static hardware identity is exported; changing free capacity cannot make unrelated hardware match.
pub(crate) fn hardware_signature(state: &RuntimeState) -> Result<Value, String> {
    let snapshot = hardware(state)?;
    if snapshot.cpu_name.is_empty()
        || snapshot.total_memory_bytes == 0
        || snapshot.gpus.is_empty()
        || snapshot.gpus.iter().any(|gpu| gpu.total_bytes.is_none())
    {
        return Ok(Value::Null);
    }
    Ok(
        json!({"cpuName":snapshot.cpu_name,"totalMemoryBytes":snapshot.total_memory_bytes,
        "gpus":snapshot.gpus.iter().map(|gpu|json!({"id":gpu.id,"name":gpu.name,"totalBytes":gpu.total_bytes})).collect::<Vec<_>>()}),
    )
}

// setup.py MODELS 201-240: numeric RAM thresholds are compared to ram_gb() (GiB).
// Expert arenas and KV/slot estimates follow the original decimal-GB arithmetic; do not silently change its units.
fn model(family: &str, quant: &str) -> Option<(f64, f64, bool)> {
    match (family, quant) {
        ("qwen", "Q2_0") => Some((48.0, 34.0, false)),
        ("qwen" | "swift", "IQ2_XS") => Some((48.0, 35.5, false)),
        ("qwen" | "swift", "IQ3_XXS") => Some((60.0, 42.9, false)),
        ("qwen" | "swift", "IQ3_S") => Some((62.0, 50.3, false)),
        ("coder", "IQ1_M") => Some((32.0, 23.4, false)),
        ("unsloth", "UD-IQ4_XS") => Some((48.0, 59.5, true)),
        ("unsloth", "UD-Q4_K_XL") => Some((48.0, 77.0, true)),
        // OWN_PATH_FAMILIES.models[*].ram_gb; arena ≈ GGUF size (docs/QWEN36.md / QWEN36_FILES)
        ("qwen36", "UD-Q4_K_XL") => Some((32.0, 22.9, false)),
        ("qwen36", "UD-Q6_K_XL") => Some((44.0, 32.6, false)),
        ("qwen36", "Q8_0") => Some((52.0, 37.8, false)),
        _ => None,
    }
}
fn cell_bytes(kv: &str) -> Option<f64> {
    match kv {
        "int8" => Some(1056.0),
        "q4_0" => Some(576.0),
        "k8v4" => Some(816.0),
        _ => None,
    }
}
/// The model's trained context; past it Strata uses rope scaling (docs/DETAILS.md, "Context extension past 262K").
const TRAINED_CONTEXT: u64 = 262_144;
/// RoPE angle tables for a scaled context: ~0.26 KB per token (only past the trained window).
fn rope_table_gb(context: u64) -> f64 {
    if context > TRAINED_CONTEXT {
        context as f64 * 266.0 / GB
    } else {
        0.0
    }
}
// setup.py 4538-4560. Its k8v4 batch estimate deliberately uses the conservative int8 rule.
fn slot_gb(context: u64, kv: &str, streaming: bool) -> f64 {
    let cells = if streaming {
        context.min(32768)
    } else {
        context
    };
    cells as f64 * 12.0 * if kv == "q4_0" { 576.0 } else { 1056.0 } / GB + 0.17
}
fn parallel_recommend(vram: f64, arena: f64, context: u64, kv: &str, streaming: bool) -> u32 {
    let cache = (vram - 5.0).max(0.0);
    let slot = slot_gb(context, kv, streaming);
    (2..=4)
        .rfind(|n| *n as f64 * slot <= 0.2 * cache && cache - *n as f64 * slot >= 0.5 * arena)
        .unwrap_or(1)
}

fn estimate(request: &ResourceAssessmentRequest, hardware: HardwareSnapshot) -> Value {
    let mut reasons = vec![json!({"code":"estimate_scope","severity":"info"})];
    let mut unknowns = Vec::<String>::new();
    let mut risk = false;
    let mut note = |code: &str, is_risk: bool| {
        reasons.push(json!({"code":code,"severity":if is_risk {"risk"} else {"info"}}));
        risk |= is_risk;
    };
    if hardware.managed_service_running {
        note("managed_running", false);
    }
    if matches!(hardware.cpu_isa.as_str(), "sse4.2" | "unsupported") {
        note("cpu_experimental", true);
    }
    let mut ram =
        json!({"baselineBytes":null,"expertBytes":null,"longContextBytes":null,"mode":"unknown"});
    let mut kv = json!({"streaming":null,"streamingRamBytes":null});
    let mut slots = json!({"count":request.parallel,"perSlotVramBytes":null,"totalVramBytes":null});
    let mut recommendations = json!({"context":null,"parallel":null});
    let mut context_extension = Value::Null;
    if let Some((baseline, arena, budget)) = model(&request.family, &request.quant) {
        ram["baselineBytes"] = json!(bytes(baseline, GIB));
        ram["expertBytes"] = json!(bytes(arena, GB));
        let ram_gib = hardware.total_memory_bytes as f64 / GIB;
        let selected: Vec<_> = if request.gpu_ids.is_empty() {
            hardware
                .gpus
                .iter()
                .filter(|gpu| gpu.vendor == "nvidia")
                .max_by_key(|gpu| gpu.total_bytes)
                .into_iter()
                .collect()
        } else {
            request
                .gpu_ids
                .iter()
                .filter_map(|id| hardware.gpus.iter().find(|gpu| gpu.id == *id))
                .collect()
        };
        let gpu = if selected.len() == 1 && request.gpu_ids.len() <= 1 {
            selected.first().copied()
        } else {
            None
        };
        let vram = gpu
            .filter(|gpu| gpu.vendor == "nvidia")
            .and_then(|gpu| gpu.total_bytes)
            .map(|v| v as f64 / GIB);
        if request.gpu_ids.is_empty() && hardware.gpus.len() > 1 {
            unknowns.push("gpu_auto_selection_unknown".into());
        }
        if request.gpu_ids.len() > 1 {
            unknowns.push("multi_gpu_unknown".into());
        } else if vram.is_none() {
            unknowns.push("gpu_unknown".into());
        }
        if budget {
            note("budget_mode", false);
            unknowns.push("budget_mode".into());
            ram["mode"] = json!("budget");
        }
        if request.images {
            unknowns.push("image_reserve_unknown".into());
        }
        if request.context > TRAINED_CONTEXT {
            // setup.py resolve_rope: past the trained window setup adds yarn with context / 262144.
            let cell = cell_bytes(&request.kv).unwrap_or(1056.0);
            context_extension = json!({"trainedContext":TRAINED_CONTEXT,"scaling":"yarn",
                "scale":(request.context as f64 / TRAINED_CONTEXT as f64).max(1.0),
                "kvBytes":bytes(request.context as f64 * 13.0 * cell, 1.0),
                "ropeBytes":bytes(rope_table_gb(request.context), GB)});
            note("context_extension", false);
            note("expert_cache_auto", false);
        }
        if cell_bytes(&request.kv).is_none() {
            unknowns.push("kv_unknown".into());
        }
        let low_ram = !budget && ram_gib < arena + 10.0;
        if !budget && !low_ram {
            ram["mode"] = json!("normal");
        }
        if let (Some(vram), Some(cell)) = (vram, cell_bytes(&request.kv)) {
            // setup.py 3479-3498: only the single-GPU, reviewed low-RAM rule.
            let gpu_experts =
                (vram - 5.0 - request.context.saturating_sub(32768) as f64 * 13.0 * cell / GB)
                    .max(0.0)
                    .min(arena);
            if !hardware.managed_service_running {
                let host_experts = if low_ram { arena - gpu_experts } else { arena };
                if !budget && hardware.available_memory_bytes < bytes(host_experts, GB) {
                    note("ram_pressure", true);
                }
                // The same ~5 GiB allowance the official GPU cache estimate removes for dense weights/buffers.
                if gpu
                    .and_then(|gpu| gpu.available_bytes)
                    .is_some_and(|free| free < bytes(5.0, GIB))
                {
                    note("gpu_pressure", true);
                }
            }
            if low_ram {
                let resident = ram_gib >= arena - gpu_experts + 10.0;
                ram["mode"] = json!(if resident { "resident" } else { "mmap" });
                note(
                    if resident {
                        "low_ram_resident"
                    } else {
                        "low_ram_mmap"
                    },
                    !resident,
                );
                if ram_gib - 6.0 + (vram - 5.0).max(0.0) < arena {
                    note("low_ram_shortfall", true);
                }
            }
            // setup.py 3518-3531: WSL never streams, and low-RAM setup does not have room for streamed KV.
            let streamed_gb = request.context as f64 * 13.0 * cell / GB;
            let streaming = !hardware.wsl
                && !low_ram
                && request.context >= 65536
                && ram_gib >= baseline + streamed_gb + 1.0;
            kv["streaming"] = json!(streaming);
            kv["streamingRamBytes"] = json!(if streaming { bytes(streamed_gb, GB) } else { 0 });
            if hardware.wsl && request.context >= 65536 {
                note("wsl_streaming_off", false);
            }
            if request.parallel > 1 {
                let slot = slot_gb(request.context, &request.kv, streaming);
                slots["perSlotVramBytes"] = json!(bytes(slot, GB));
                slots["totalVramBytes"] = json!(bytes(slot * request.parallel as f64, GB));
                note("parallel_cost", false);
            }
            let recommended_parallel =
                parallel_recommend(vram, arena, request.context, &request.kv, streaming);
            let mut recommended_context = if vram < 14.0 {
                32768
            } else if vram < 20.0 {
                65536
            } else {
                131072
            };
            if budget {
                recommended_context = if vram < 14.0 { 8192 } else { 32768 };
            }
            recommendations =
                json!({"context":recommended_context,"parallel":recommended_parallel});
            if request.parallel > recommended_parallel {
                note("parallel_above_recommendation", true);
            }
            if matches!(request.quant.as_str(), "IQ3_XXS" | "IQ3_S") && !low_ram {
                let need = arena
                    + request.context as f64 * 13.0 * 1056.0 / GB
                    + rope_table_gb(request.context)
                    + 24.0;
                ram["longContextBytes"] = json!(bytes(need, GIB));
                if request.context > 131072 && ram_gib < need {
                    note("long_context_ram", true);
                }
            }
        }
    } else {
        unknowns.push("model_unknown".into());
    }
    if request.parallel > 8 {
        note("engine_slot_cap", true);
    }
    // A partial estimate must not become a positive recommendation for an unsupported mode.
    if !unknowns.is_empty() {
        recommendations = json!({"context":null,"parallel":null});
    }
    json!({"status":if risk {"risk"} else if !unknowns.is_empty() {"unknown"} else {"suggested"},"estimate":true,
        "sampledAt":hardware.sampled_at,"hardware":hardware,"ram":ram,"kv":kv,"slots":slots,"recommendations":recommendations,
        "contextExtension":context_extension,"reasons":reasons,"unknowns":unknowns,"sourceRevision":SOURCE_REVISION})
}

pub async fn assess(
    state: &Arc<RuntimeState>,
    request: ResourceAssessmentRequest,
) -> Result<Value, String> {
    request.validate()?;
    let state = state.clone();
    tokio::task::spawn_blocking(move || {
        let registered = state
            .registered_profiles()?
            .iter()
            .any(|profile| profile.id == request.installation_id);
        if !registered {
            let status = crate::installation::status(&state)?;
            let known = status.result.as_ref().is_some_and(|runtime| {
                runtime.installation_id == request.installation_id
                    || runtime.profile.id == request.installation_id
            }) || status
                .detected_runtimes
                .iter()
                .any(|runtime| runtime.profile.id == request.installation_id);
            if !known {
                return Err("运行环境未登记，请重新检测 / Runtime is not registered".into());
            }
        }
        Ok(estimate(&request, hardware(&state)?))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(ram: f64, vram: f64) -> HardwareSnapshot {
        HardwareSnapshot {
            sampled_at: 1234,
            total_memory_bytes: bytes(ram, GIB),
            available_memory_bytes: bytes(ram - 4.0, GIB),
            gpus: vec![GpuSnapshot {
                id: 0,
                vendor: "nvidia".into(),
                name: "Fixture".into(),
                total_bytes: Some(bytes(vram, GIB)),
                available_bytes: Some(bytes(vram - 1.0, GIB)),
                source: "fixture".into(),
            }],
            cpu_isa: "avx2".into(),
            cpu_name: "Fixture CPU".into(),
            wsl: false,
            managed_service_running: false,
        }
    }
    fn request() -> ResourceAssessmentRequest {
        ResourceAssessmentRequest {
            installation_id: "fixture".into(),
            family: "qwen".into(),
            quant: "Q2_0".into(),
            context: 32768,
            images: false,
            kv: "int8".into(),
            gpu_ids: vec![],
            parallel: 1,
        }
    }
    #[test]
    fn official_single_gpu_recommendation_and_low_ram_modes() {
        let result = estimate(&request(), fixture(64.0, 12.0));
        assert_eq!(result["status"], "suggested");
        assert_eq!(result["recommendations"]["parallel"], 1);
        assert_eq!(result["recommendations"]["context"], 32768);
        assert_eq!(
            estimate(&request(), fixture(32.0, 24.0))["ram"]["mode"],
            "resident"
        );
        assert_eq!(
            estimate(&request(), fixture(24.0, 12.0))["ram"]["mode"],
            "mmap"
        );
    }
    #[test]
    fn kv_and_batch_match_official_reference_values() {
        assert!((slot_gb(32768, "int8", false) - 0.585236096).abs() < 1e-9);
        assert!((slot_gb(131072, "q4_0", true) - 0.396492416).abs() < 1e-9);
        assert_eq!(slot_gb(32768, "k8v4", false), slot_gb(32768, "int8", false));
        let mut req = request();
        req.context = 131072;
        req.parallel = 2;
        let result = estimate(&req, fixture(64.0, 24.0));
        assert_eq!(result["kv"]["streamingRamBytes"], 1_799_356_416_u64);
        assert_eq!(result["slots"]["totalVramBytes"], 1_170_472_192_u64);
        let mut hw = fixture(64.0, 24.0);
        hw.wsl = true;
        assert_eq!(estimate(&req, hw)["kv"]["streaming"], false);
    }
    #[test]
    fn unknown_modes_keep_missing_capacity_unknown() {
        for (field, value) in [
            ("images", json!(true)),
            ("family", json!("other")),
            ("kv", json!("fp16")),
            ("gpuIds", json!([0, 1])),
        ] {
            let mut value_req = serde_json::to_value(request()).unwrap();
            value_req[field] = value;
            let result = estimate(
                &serde_json::from_value(value_req).unwrap(),
                fixture(64.0, 24.0),
            );
            assert_eq!(result["status"], "unknown");
            assert!(result["recommendations"]["context"].is_null());
        }
        let mut hw = fixture(64.0, 24.0);
        hw.gpus[0].total_bytes = None;
        let result = estimate(&request(), hw);
        assert_eq!(result["status"], "unknown");
        assert!(result["slots"]["perSlotVramBytes"].is_null());
    }
    #[test]
    fn hardware_parser_preserves_unknowns_and_each_card() {
        let gpus = parse_nvidia("0, GPU A, 24576, 20000\n1, GPU B, N/A, N/A\n2, GPU C, 100, 101");
        assert_eq!(gpus.len(), 3);
        assert_eq!(gpus[0].total_bytes, Some(25_769_803_776));
        assert!(gpus[1].total_bytes.is_none());
        assert!(gpus[2].available_bytes.is_none());
    }
    #[test]
    fn validates_request_without_probing_or_starting_any_service() {
        let mut req = request();
        req.gpu_ids = vec![1, 1];
        assert!(req.validate().is_err());
        req = request();
        req.parallel = 0;
        assert!(req.validate().is_err());
    }
    #[test]
    fn extended_context_reports_yarn_factor_and_kv_plus_rope_memory() {
        let mut req = request();
        req.quant = "IQ3_S".into();
        req.context = 1_048_576;
        let result = estimate(&req, fixture(128.0, 32.0));
        assert_eq!(result["contextExtension"]["scaling"], "yarn");
        assert_eq!(result["contextExtension"]["scale"], 4.0);
        assert_eq!(
            result["contextExtension"]["kvBytes"],
            1_048_576_u64 * 13 * 1056
        );
        assert_eq!(result["contextExtension"]["ropeBytes"], 1_048_576_u64 * 266);
        assert!(result["unknowns"]
            .as_array()
            .unwrap()
            .iter()
            .all(|code| code != "above_native_context"));
        let codes: Vec<_> = result["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .map(|reason| reason["code"].as_str().unwrap())
            .collect();
        assert!(codes.contains(&"context_extension") && codes.contains(&"expert_cache_auto"));
        req.kv = "q4_0".into();
        assert_eq!(
            estimate(&req, fixture(128.0, 32.0))["contextExtension"]["kvBytes"],
            1_048_576_u64 * 13 * 576
        );
        req.context = 262_144;
        assert!(estimate(&req, fixture(128.0, 32.0))["contextExtension"].is_null());
    }
    #[test]
    fn flags_long_context_and_transient_pressure_without_double_counting_running_models() {
        let mut req = request();
        req.quant = "IQ3_S".into();
        req.context = 262144;
        let result = estimate(&req, fixture(64.0, 24.0));
        assert_eq!(result["status"], "risk");
        assert!(result["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| reason["code"] == "long_context_ram"));
        let mut hw = fixture(64.0, 24.0);
        hw.available_memory_bytes = 1024;
        hw.gpus[0].available_bytes = Some(1024);
        let result = estimate(&request(), hw.clone());
        assert_eq!(result["status"], "risk");
        hw.managed_service_running = true;
        let result = estimate(&request(), hw);
        assert_eq!(result["status"], "suggested");
        assert!(result["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| reason["code"] == "managed_running"));
    }
}
