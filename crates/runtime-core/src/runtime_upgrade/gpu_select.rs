//! Pick the official Linux engine package for this computer's GPU (Strata 0.2+ feed).
//!
//! Read-only probes of tools that are already installed (`nvidia-smi`, `/proc/driver/nvidia`,
//! the AMD KFD topology in sysfs, `rocminfo`), the same sources upstream's updater uses. An
//! unreadable or ambiguous result is "cannot tell": the user then chooses the package, Manager
//! never guesses a GPU family.
use super::RuntimeReleaseAsset;
use std::{fs, path::Path, time::Duration};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GpuProbe {
    /// Oldest NVIDIA driver version reported when several cards disagree.
    pub nvidia_driver: Option<String>,
    /// CUDA compute capabilities (major, minor), one per NVIDIA card.
    pub nvidia_caps: Vec<(u32, u32)>,
    /// AMD GPU targets such as `gfx1100`, `gfx1151`, `gfx1201`.
    pub amd_gfx: Vec<String>,
}

fn version_key(value: &str) -> Vec<u32> {
    value
        .split('.')
        .map(|part| part.parse::<u32>().unwrap_or(0))
        .collect()
}

/// `nvidia-smi --query-gpu=driver_version,compute_cap --format=csv,noheader`.
pub fn parse_nvidia_smi(text: &str) -> (Option<String>, Vec<(u32, u32)>) {
    let mut drivers = Vec::new();
    let mut caps = Vec::new();
    for line in text.lines().take(64) {
        let mut fields = line.split(',').map(str::trim);
        let (Some(driver), cap) = (fields.next(), fields.next()) else {
            continue;
        };
        if !driver.is_empty()
            && driver.len() <= 32
            && driver
                .split('.')
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        {
            drivers.push(driver.to_owned());
        }
        if let Some((major, minor)) = cap.and_then(|cap| cap.split_once('.')) {
            if let (Ok(major), Ok(minor)) = (major.parse::<u32>(), minor.parse::<u32>()) {
                if (1..=20).contains(&major) && minor <= 9 {
                    caps.push((major, minor));
                }
            }
        }
    }
    let driver = drivers.into_iter().min_by_key(|v| version_key(v));
    caps.sort_unstable();
    caps.dedup();
    (driver, caps)
}

/// `/proc/driver/nvidia/version`: "NVRM version: NVIDIA UNIX x86_64 Kernel Module  580.95.05  ...".
pub fn parse_proc_nvidia_version(text: &str) -> Option<String> {
    let rest = text.split("Kernel Module").nth(1)?;
    let version = rest.split_whitespace().next()?;
    (version.contains('.')
        && version
            .split('.')
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())))
    .then(|| version.to_owned())
}

/// KFD node `properties`: `gfx_target_version 110501` is gfx1151, `120001` is gfx1201.
pub fn parse_kfd_properties(text: &str) -> Option<String> {
    let value: u32 = text
        .lines()
        .find_map(|line| line.strip_prefix("gfx_target_version"))?
        .trim()
        .parse()
        .ok()?;
    if value == 0 {
        return None;
    }
    Some(format!(
        "gfx{}{:x}{:x}",
        value / 10000,
        (value / 100) % 100,
        value % 100
    ))
}

/// gfx names mentioned by `rocminfo`.
pub fn parse_rocminfo(text: &str) -> Vec<String> {
    let mut found: Vec<String> = text
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| {
            word.len() >= 6
                && word.len() <= 8
                && word.starts_with("gfx")
                && word[3..].bytes().all(|b| b.is_ascii_hexdigit())
        })
        .map(str::to_owned)
        .collect();
    found.sort();
    found.dedup();
    found
}

fn kfd_gfx(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    if let Ok(nodes) = fs::read_dir(root) {
        for node in nodes.take(64).flatten() {
            if let Ok(text) = fs::read_to_string(node.path().join("properties")) {
                if let Some(gfx) = parse_kfd_properties(&text) {
                    found.push(gfx);
                }
            }
        }
    }
    found.sort();
    found.dedup();
    found
}

/// Windows has no KFD topology: the AMD target of a display adapter name from
/// `Win32_VideoController` (the list Manager already shows). Only the discrete RDNA3 /
/// RDNA4 cards and Strix Halo that official packages are built for; anything else (an
/// integrated "AMD Radeon(TM) Graphics", older cards) is unknown and left out.
pub fn amd_gfx_from_adapter_name(name: &str) -> Option<&'static str> {
    let name = name.to_ascii_lowercase().replace("(tm)", " ");
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if !name.contains("radeon") {
        return None;
    }
    const TABLE: &[(&str, &str)] = &[
        // RDNA4: RX 9070 / 9070 XT / 9070 GRE and Radeon AI PRO R9700 (Navi 48), RX 9060 (Navi 44).
        ("rx 9070", "gfx1201"),
        ("r9700", "gfx1201"),
        ("rx 9060", "gfx1200"),
        // RDNA3: Navi 31 / 32 / 33 and their Radeon PRO siblings.
        ("rx 7900", "gfx1100"),
        ("pro w7900", "gfx1100"),
        ("pro w7800", "gfx1100"),
        ("rx 7800", "gfx1101"),
        ("rx 7700", "gfx1101"),
        ("pro w7700", "gfx1101"),
        ("rx 7600", "gfx1102"),
        ("rx 7650", "gfx1102"),
        ("pro w7600", "gfx1102"),
        ("pro w7500", "gfx1102"),
        // Strix Halo (Ryzen AI Max): Radeon 8060S / 8050S / 8040S.
        ("radeon 8060s", "gfx1151"),
        ("radeon 8050s", "gfx1151"),
        ("radeon 8040s", "gfx1151"),
    ];
    if let Some(gfx) = rdna2_desktop_gfx(&name) {
        return Some(gfx);
    }
    TABLE
        .iter()
        .find(|(marker, _)| name.contains(marker))
        .map(|(_, gfx)| *gfx)
}

/// RX 6000 desktop cards the Strata 0.2.2 RDNA2 packages are built for: Navi 21
/// (RX 6800 / 6900 / 6950, PRO W6800) is gfx1030, Navi 22 (RX 6700 / 6750) gfx1031.
/// The model number must be a whole word: laptop parts such as RX 6800S / 6700S are
/// Navi 23 (gfx1032) and RX 6600 / 6500 are gfx1032 / gfx1034, which no package covers.
fn rdna2_desktop_gfx(name: &str) -> Option<&'static str> {
    let words: Vec<&str> = name.split_whitespace().collect();
    words.windows(2).find_map(|pair| match pair {
        ["rx", "6800" | "6900" | "6950"] | ["pro", "w6800"] => Some("gfx1030"),
        ["rx", "6700" | "6750"] => Some("gfx1031"),
        _ => None,
    })
}

/// AMD targets of Windows display adapter names, sorted and deduplicated.
pub fn amd_gfx_from_adapter_names(names: &[String]) -> Vec<String> {
    let mut found: Vec<String> = names
        .iter()
        .filter_map(|name| amd_gfx_from_adapter_name(name))
        .map(str::to_owned)
        .collect();
    found.sort();
    found.dedup();
    found
}

/// Probe this computer. Never fails: anything unreadable stays empty.
pub fn probe_host() -> GpuProbe {
    let mut probe = GpuProbe::default();
    if let Some(text) = crate::output_with_timeout(
        "nvidia-smi",
        &[
            "--query-gpu=driver_version,compute_cap",
            "--format=csv,noheader",
        ],
        Duration::from_secs(5),
    ) {
        (probe.nvidia_driver, probe.nvidia_caps) = parse_nvidia_smi(&text);
    }
    if probe.nvidia_driver.is_none() {
        probe.nvidia_driver = fs::read_to_string("/proc/driver/nvidia/version")
            .ok()
            .as_deref()
            .and_then(parse_proc_nvidia_version);
    }
    probe.amd_gfx = kfd_gfx(Path::new("/sys/class/kfd/kfd/topology/nodes"));
    if probe.amd_gfx.is_empty() {
        if let Some(text) = crate::output_with_timeout("rocminfo", &[], Duration::from_secs(10)) {
            probe.amd_gfx = parse_rocminfo(&text);
        }
    }
    #[cfg(windows)]
    if probe.amd_gfx.is_empty() {
        if let Some(names) = crate::display_adapters::windows_gpu_names() {
            probe.amd_gfx = amd_gfx_from_adapter_names(&names);
        }
    }
    probe
}

/// A CUDA package runs on a card when it has native code for it (`sm_XY`) or PTX for an
/// equal or older architecture (`compute_XY`), which the driver compiles for newer cards.
fn cuda_covers(archs: &[String], (major, minor): (u32, u32)) -> bool {
    let cap = major * 10 + minor;
    archs.iter().any(|arch| {
        if let Some(sm) = arch.strip_prefix("sm_") {
            sm.parse::<u32>().is_ok_and(|sm| sm == cap)
        } else if let Some(ptx) = arch.strip_prefix("compute_") {
            ptx.parse::<u32>().is_ok_and(|ptx| ptx <= cap)
        } else {
            false
        }
    })
}

fn driver_ok(driver: &str, minimum: Option<&str>) -> bool {
    minimum.is_none_or(|minimum| version_key(driver) >= version_key(minimum))
}

/// The package for this GPU and why, or a bilingual reason the user must choose.
pub fn pick(
    assets: &[RuntimeReleaseAsset],
    probe: &GpuProbe,
) -> Result<(RuntimeReleaseAsset, String), String> {
    let manual = |why_zh: &str, why_en: &str| {
        format!("{why_zh}，请在「官方更新包」中手动选择对应显卡的引擎包 / {why_en}; choose the engine package for your GPU under \"Official update package\"")
    };
    let nvidia = probe.nvidia_driver.is_some() || !probe.nvidia_caps.is_empty();
    let amd = !probe.amd_gfx.is_empty();
    // A Ryzen's integrated Radeon (gfx1036, gfx1103, gfx90c …) has no HIP package; beside an
    // NVIDIA card it is a display adapter, not a choice, so the NVIDIA route decides.
    let amd_supported = probe.amd_gfx.iter().any(|g| {
        assets
            .iter()
            .any(|a| a.variant.starts_with("hip") && a.archs.iter().any(|arch| arch == g))
    });
    let amd = amd && !(nvidia && !amd_supported);
    if nvidia && amd {
        return Err(manual(
            "同时检测到 NVIDIA 和 AMD 显卡，无法确定使用哪一张",
            "Both NVIDIA and AMD GPUs were detected, so Manager cannot tell which one to use",
        ));
    }
    if nvidia {
        let Some(driver) = probe.nvidia_driver.as_deref() else {
            return Err(manual(
                "检测到 NVIDIA 显卡但读不到驱动版本",
                "An NVIDIA GPU was found but its driver version is unreadable",
            ));
        };
        if probe.nvidia_caps.is_empty() {
            return Err(manual(
                "读不到 NVIDIA 显卡的计算能力（nvidia-smi 不可用或过旧）",
                "The NVIDIA compute capability is unreadable (nvidia-smi missing or too old)",
            ));
        }
        let caps = probe
            .nvidia_caps
            .iter()
            .map(|(a, b)| format!("{a}.{b}"))
            .collect::<Vec<_>>()
            .join(", ");
        let mut too_old = Vec::new();
        for variant in ["cuda13", "cuda12"] {
            let Some(asset) = assets.iter().find(|a| a.variant == variant) else {
                continue;
            };
            if !probe
                .nvidia_caps
                .iter()
                .all(|cap| cuda_covers(&asset.archs, *cap))
            {
                continue;
            }
            if !driver_ok(driver, asset.nvidia_min_driver.as_deref()) {
                too_old.push(asset.nvidia_min_driver.clone().unwrap_or_default());
                continue;
            }
            let label = if variant == "cuda13" {
                "CUDA 13"
            } else {
                "CUDA 12"
            };
            return Ok((
                asset.clone(),
                format!("检测到 NVIDIA 驱动 {driver}、计算能力 {caps}，选择 {label} / Detected NVIDIA driver {driver}, compute capability {caps}: {label}"),
            ));
        }
        if let Some(minimum) = too_old.iter().min_by_key(|v| version_key(v)) {
            return Err(format!(
                "NVIDIA 驱动 {driver} 过旧，官方引擎包至少需要 {minimum}；请先更新驱动 / NVIDIA driver {driver} is too old; the official engine packages need {minimum} or newer. Update the driver first"
            ));
        }
        return Err(manual(
            &format!("没有官方引擎包支持计算能力 {caps} 的 NVIDIA 显卡"),
            &format!("No official engine package supports NVIDIA compute capability {caps}"),
        ));
    }
    if amd {
        let hip: Vec<_> = assets
            .iter()
            .filter(|a| a.variant.starts_with("hip"))
            .collect();
        // An AMD target no package is built for (typically the integrated GPU next to a
        // discrete card, e.g. gfx1036 beside gfx1201, #103) does not block the choice.
        let (supported, ignored): (Vec<&String>, Vec<&String>) = probe
            .amd_gfx
            .iter()
            .partition(|g| hip.iter().any(|a| a.archs.iter().any(|arch| arch == *g)));
        let wanted: Vec<&String> = if supported.is_empty() {
            probe.amd_gfx.iter().collect()
        } else {
            supported
        };
        let gfx = wanted
            .iter()
            .map(|g| g.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let fits: Vec<_> = hip
            .iter()
            .copied()
            .filter(|a| wanted.iter().all(|g| a.archs.iter().any(|arch| arch == *g)))
            .collect();
        let (note_zh, note_en) = if ignored.is_empty() || wanted.len() == probe.amd_gfx.len() {
            (String::new(), String::new())
        } else {
            let ignored = ignored
                .iter()
                .map(|g| g.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            (
                format!("（忽略无官方引擎包的 {ignored}）"),
                format!(" (ignoring {ignored}, which no package supports)"),
            )
        };
        return match fits.as_slice() {
            [asset] => {
                let label = hip_label(&asset.variant);
                let (untested_zh, untested_en) = if untested_variant(&asset.variant) {
                    (UNTESTED_ZH, UNTESTED_EN)
                } else {
                    ("", "")
                };
                Ok((
                    (*asset).clone(),
                    format!(
                        "检测到 AMD 显卡 {gfx}，选择 {label}{untested_zh}{note_zh} / Detected AMD GPU {gfx}: {label}{untested_en}{note_en}"
                    ),
                ))
            }
            [] => Err(manual(
                &format!("没有官方引擎包同时支持 AMD 显卡 {gfx}"),
                &format!("No official engine package supports AMD GPU {gfx}"),
            )),
            _ => Err(manual(
                &format!("AMD 显卡 {gfx} 对应多个引擎包"),
                &format!("Several engine packages fit AMD GPU {gfx}"),
            )),
        };
    }
    Err(manual(
        "没有检测到 NVIDIA 或 AMD 显卡（驱动未安装或无法读取）",
        "No NVIDIA or AMD GPU was detected (driver missing or unreadable)",
    ))
}

/// Packages upstream built but has not run on a real card (RX 6000 in Strata 0.2.2).
pub fn untested_variant(variant: &str) -> bool {
    matches!(variant, "hip-rx6000" | "hip-rdna2")
}

const UNTESTED_ZH: &str = "（上游未经实机测试）";
const UNTESTED_EN: &str = " (untested by upstream on a real card)";

fn hip_label(variant: &str) -> &'static str {
    match variant {
        "hip" => "AMD HIP · RX 9000/R9700",
        "hip-rx7900" => "AMD HIP · RX 7000",
        "hip-halo" => "AMD HIP · Strix Halo",
        "hip-rdna3" => "AMD HIP · RX 7000/Strix Halo",
        "hip-rx6000" | "hip-rdna2" => "AMD HIP · RX 6000",
        _ => "AMD HIP",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(variant: &str, archs: &[&str], driver: Option<&str>) -> RuntimeReleaseAsset {
        RuntimeReleaseAsset {
            name: format!("{variant}.tar.gz"),
            variant: variant.into(),
            archs: archs.iter().map(|a| (*a).to_owned()).collect(),
            nvidia_min_driver: driver.map(str::to_owned),
            ..Default::default()
        }
    }

    /// The five Linux packages of the real 0.2.0-beta feed.
    fn linux_assets() -> Vec<RuntimeReleaseAsset> {
        vec![
            asset(
                "cuda12",
                &[
                    "sm_60",
                    "sm_61",
                    "sm_70",
                    "sm_75",
                    "sm_80",
                    "sm_86",
                    "sm_89",
                    "compute_89",
                ],
                Some("575.51"),
            ),
            asset(
                "cuda13",
                &["sm_75", "sm_86", "sm_89", "sm_120", "compute_120"],
                Some("580.65"),
            ),
            asset("hip-halo", &["gfx1151"], None),
            asset("hip-rx7900", &["gfx1100", "gfx1101", "gfx1102"], None),
            asset("hip", &["gfx1200", "gfx1201"], None),
        ]
    }

    fn nvidia(driver: &str, caps: &[(u32, u32)]) -> GpuProbe {
        GpuProbe {
            nvidia_driver: Some(driver.into()),
            nvidia_caps: caps.to_vec(),
            amd_gfx: vec![],
        }
    }

    fn amd(gfx: &[&str]) -> GpuProbe {
        GpuProbe {
            amd_gfx: gfx.iter().map(|g| (*g).to_owned()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn nvidia_cards_pick_cuda_by_driver_and_architecture() {
        let assets = linux_assets();
        let pick_variant = |probe: GpuProbe| pick(&assets, &probe).map(|(a, _)| a.variant);
        // RTX 4080 Super (8.9) on a new driver: CUDA 13.
        assert_eq!(
            pick_variant(nvidia("580.95.05", &[(8, 9)])).unwrap(),
            "cuda13"
        );
        // The same card on a 575 driver: CUDA 12.
        assert_eq!(pick_variant(nvidia("575.64", &[(8, 9)])).unwrap(), "cuda12");
        // Pascal (6.1) has no CUDA 13 code: CUDA 12 even on a new driver.
        assert_eq!(pick_variant(nvidia("580.95", &[(6, 1)])).unwrap(), "cuda12");
        // RTX 50 (12.0) is only in CUDA 13.
        assert_eq!(
            pick_variant(nvidia("580.65", &[(12, 0)])).unwrap(),
            "cuda13"
        );
        // A future 12.1 card runs CUDA 13's compute_120 PTX.
        assert_eq!(pick_variant(nvidia("590.1", &[(12, 1)])).unwrap(), "cuda13");
        // Hopper 9.0: CUDA 12 has compute_89 PTX for it; CUDA 13 has neither sm_90 nor older PTX.
        assert_eq!(pick_variant(nvidia("580.65", &[(9, 0)])).unwrap(), "cuda12");
        // Mixed 3090 + 1080 Ti: only CUDA 12 covers both.
        assert_eq!(
            pick_variant(nvidia("580.65", &[(6, 1), (8, 6)])).unwrap(),
            "cuda12"
        );
        let old = pick(&assets, &nvidia("550.54", &[(8, 9)])).unwrap_err();
        assert!(old.contains("575.51") && old.contains("too old"), "{old}");
        let (_, reason) = pick(&assets, &nvidia("580.95.05", &[(8, 9)])).unwrap();
        assert!(
            reason.contains("580.95.05") && reason.contains("CUDA 13"),
            "{reason}"
        );
    }

    #[test]
    fn pascal_cards_pick_cuda12_even_beside_a_ryzen_igpu() {
        let assets = linux_assets();
        let pick_variant = |probe: GpuProbe| pick(&assets, &probe).map(|(a, _)| a.variant);
        // Two GTX 1080 (6.1): CUDA 13 has no sm_61, so CUDA 12 on any new driver.
        assert_eq!(
            pick_variant(nvidia("580.95", &[(6, 1), (6, 1)])).unwrap(),
            "cuda12"
        );
        // GTX 1080 Ti next to a Ryzen 7000 iGPU (kfd lists gfx1036, no HIP package): the iGPU
        // no longer blocks the choice.
        let mut probe = nvidia("580.95", &[(6, 1)]);
        probe.amd_gfx = vec!["gfx1036".into()];
        assert_eq!(pick_variant(probe).unwrap(), "cuda12");
        let mut probe = nvidia("580.95.05", &[(8, 9)]);
        probe.amd_gfx = vec!["gfx1103".into()];
        assert_eq!(pick_variant(probe).unwrap(), "cuda13");
        // A real AMD card beside the NVIDIA one is still ambiguous.
        let mut probe = nvidia("580.95", &[(8, 9)]);
        probe.amd_gfx = vec!["gfx1201".into()];
        assert!(pick_variant(probe).unwrap_err().contains("NVIDIA"));
    }

    #[test]
    fn amd_cards_pick_the_package_built_for_their_family() {
        let assets = linux_assets();
        let pick_variant = |probe: GpuProbe| pick(&assets, &probe).map(|(a, _)| a.variant);
        assert_eq!(pick_variant(amd(&["gfx1151"])).unwrap(), "hip-halo");
        assert_eq!(pick_variant(amd(&["gfx1100"])).unwrap(), "hip-rx7900");
        assert_eq!(pick_variant(amd(&["gfx1201"])).unwrap(), "hip");
        // RX 7900 + Strix Halo iGPU: no single package covers both, the user decides.
        assert!(pick_variant(amd(&["gfx1100", "gfx1151"]))
            .unwrap_err()
            .contains("手动选择"));
        // The 0.2.0-beta feed has no RDNA2 package (0.2.2 adds one, see below).
        assert!(pick_variant(amd(&["gfx1030"]))
            .unwrap_err()
            .contains("gfx1030"));
        // #103: RX 9070 XT next to the Ryzen iGPU (gfx1036, no package): the iGPU is
        // ignored and named in the reason instead of blocking the choice.
        let (asset, reason) = pick(&assets, &amd(&["gfx1036", "gfx1201"])).unwrap();
        assert_eq!(asset.variant, "hip");
        assert!(
            reason.contains("gfx1201") && reason.contains("gfx1036"),
            "{reason}"
        );
    }

    #[test]
    fn rx6000_picks_the_strata_022_rdna2_package_and_says_it_is_untested() {
        let mut linux = linux_assets();
        linux.push(asset("hip-rx6000", &["gfx1030", "gfx1031"], None));
        for gfx in ["gfx1030", "gfx1031"] {
            let (asset, reason) = pick(&linux, &amd(&[gfx])).unwrap();
            assert_eq!(asset.variant, "hip-rx6000");
            assert!(
                reason.contains("RX 6000")
                    && reason.contains("未经实机测试")
                    && reason.contains("untested"),
                "{reason}"
            );
        }
        let windows = vec![
            asset(
                "cuda13",
                &["sm_75", "sm_86", "sm_89", "sm_120"],
                Some("580.65"),
            ),
            asset("hip-rdna2", &["gfx1030", "gfx1031"], None),
            asset(
                "hip-rdna3",
                &["gfx1100", "gfx1101", "gfx1102", "gfx1151"],
                None,
            ),
            asset("hip", &["gfx1200", "gfx1201"], None),
        ];
        let (asset, reason) = pick(&windows, &amd(&["gfx1031"])).unwrap();
        assert_eq!(asset.variant, "hip-rdna2");
        // Each half of the bilingual reason carries its own untested note.
        let (zh, en) = reason.split_once(" / ").unwrap();
        assert!(
            zh.contains("未经实机测试") && !zh.contains("untested"),
            "{zh}"
        );
        assert!(en.contains("untested") && !en.contains("未经"), "{en}");
        // Tested packages carry no note.
        let (_, reason) = pick(&windows, &amd(&["gfx1201"])).unwrap();
        assert!(!reason.contains("untested"), "{reason}");
        // An RX 6600 (gfx1032) still has no package.
        assert!(pick(&windows, &amd(&["gfx1032"])).is_err());
    }

    #[test]
    fn windows_adapter_names_map_to_amd_targets() {
        for (name, gfx) in [
            ("AMD Radeon RX 9070 XT", Some("gfx1201")),
            ("AMD Radeon RX 9070", Some("gfx1201")),
            ("AMD Radeon AI PRO R9700", Some("gfx1201")),
            ("AMD Radeon RX 9060 XT", Some("gfx1200")),
            ("AMD Radeon RX 7900 XTX", Some("gfx1100")),
            ("AMD Radeon RX 7900 GRE", Some("gfx1100")),
            ("AMD Radeon PRO W7900", Some("gfx1100")),
            ("AMD Radeon RX 7800 XT", Some("gfx1101")),
            ("AMD Radeon RX 7700 XT", Some("gfx1101")),
            ("AMD Radeon RX 7600", Some("gfx1102")),
            ("AMD Radeon(TM) 8060S Graphics", Some("gfx1151")),
            // Integrated graphics and cards no package is built for stay unknown.
            ("AMD Radeon(TM) Graphics", None),
            // RX 6000 (Strata 0.2.2 RDNA2 packages): desktop Navi 21 / 22 only.
            ("AMD Radeon RX 6800 XT", Some("gfx1030")),
            ("AMD Radeon RX 6950 XT", Some("gfx1030")),
            ("AMD Radeon PRO W6800", Some("gfx1030")),
            ("AMD Radeon RX 6700 XT", Some("gfx1031")),
            ("AMD Radeon RX 6750 XT", Some("gfx1031")),
            ("AMD Radeon RX 6800S", None),
            ("AMD Radeon RX 6600 XT", None),
            ("NVIDIA GeForce RTX 4090", None),
            ("Meta Virtual Monitor", None),
        ] {
            assert_eq!(amd_gfx_from_adapter_name(name), gfx, "{name}");
        }
        assert_eq!(
            amd_gfx_from_adapter_names(&[
                "AMD Radeon(TM) Graphics".into(),
                "AMD Radeon RX 9070 XT".into(),
            ]),
            ["gfx1201"]
        );
    }

    #[test]
    fn unknown_or_mixed_hardware_asks_the_user() {
        let assets = linux_assets();
        assert!(pick(&assets, &GpuProbe::default())
            .unwrap_err()
            .contains("手动选择"));
        let mut both = nvidia("580.65", &[(8, 9)]);
        both.amd_gfx = vec!["gfx1151".into()];
        assert!(pick(&assets, &both).unwrap_err().contains("NVIDIA 和 AMD"));
        let no_caps = GpuProbe {
            nvidia_driver: Some("580.65".into()),
            ..Default::default()
        };
        assert!(pick(&assets, &no_caps).unwrap_err().contains("计算能力"));
    }

    #[test]
    fn probe_outputs_parse_strictly() {
        assert_eq!(
            parse_nvidia_smi("580.95.05, 8.9\n575.64, 6.1\n"),
            (Some("575.64".into()), vec![(6, 1), (8, 9)])
        );
        assert_eq!(
            parse_nvidia_smi("580.95.05, [N/A]\n"),
            (Some("580.95.05".into()), vec![])
        );
        assert_eq!(parse_nvidia_smi("No devices were found\n"), (None, vec![]));
        assert_eq!(
            parse_proc_nvidia_version("NVRM version: NVIDIA UNIX x86_64 Kernel Module  580.95.05  Tue Sep 30 2025\nGCC version: gcc 13"),
            Some("580.95.05".into())
        );
        assert_eq!(parse_proc_nvidia_version("garbage"), None);
        assert_eq!(
            parse_kfd_properties("cpu_cores_count 0\ngfx_target_version 110501\n"),
            Some("gfx1151".into())
        );
        assert_eq!(
            parse_kfd_properties("gfx_target_version 120001\n"),
            Some("gfx1201".into())
        );
        assert_eq!(
            parse_kfd_properties("gfx_target_version 110000\n"),
            Some("gfx1100".into())
        );
        assert_eq!(parse_kfd_properties("gfx_target_version 0\n"), None);
        assert_eq!(
            parse_rocminfo("  Name:                    gfx1100\n  Name: amdgcn-amd-amdhsa--gfx1100\n Name: gfx90a\n"),
            vec!["gfx1100".to_owned(), "gfx90a".to_owned()]
        );
    }
}
