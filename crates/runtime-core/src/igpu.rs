//! Integrated GPUs and the monitor's default GPU set (upstream v0.2.6 `defaultGpuSet`, 59599f69).
//!
//! A Ryzen's "AMD Radeon(TM) Graphics" (512 MiB carve-out) or an Intel UHD/Iris next to a real card
//! is a display adapter, not a compute device: added to the "All GPUs" totals it inflates the card
//! count and the VRAM total. The rule, kept identical to `packages/core/src/integrated-gpu.ts`:
//!
//! - a *real* card is one with 4 GB or more of VRAM, or an NVIDIA card;
//! - a *small integrated* GPU is an AMD or Intel GPU with less than 2 GB of its own memory (or, when
//!   the size is unknown, an integrated-GPU name) and no unified memory;
//! - when a real card is present, small integrated GPUs are left out of the default set; a machine
//!   with only an integrated GPU (or only small GPUs) keeps all of them.

/// GPU vendor from a device name (or a PCI vendor id inside a PNP device id).
pub fn vendor_of(name: &str) -> Option<&'static str> {
    let n = name.to_ascii_lowercase();
    if n.contains("nvidia")
        || n.contains("geforce")
        || n.contains("quadro")
        || n.contains("tesla")
        || n.contains("ven_10de")
    {
        Some("nvidia")
    } else if n.contains("amd")
        || n.contains("radeon")
        || n.contains("instinct")
        || n.contains("ven_1002")
    {
        Some("amd")
    } else if n.contains("intel")
        || n.contains("ven_8086")
        || n.contains("iris")
        || n.contains("uhd graphics")
    {
        Some("intel")
    } else if n.starts_with("apple") {
        Some("apple")
    } else {
        None
    }
}

/// True for the names AMD and Intel give their integrated GPUs: "AMD Radeon(TM) Graphics",
/// "Radeon 780M Graphics", "Intel(R) UHD Graphics 770", "Intel(R) Iris(R) Xe Graphics",
/// "Intel(R) Arc(TM) Graphics" (Core Ultra) or "Arc 140V". Discrete Radeon RX/Pro/Instinct and
/// Intel Arc A/B-series cards are not matched.
pub fn is_integrated_gpu_name(name: &str) -> bool {
    let n = name
        .to_ascii_lowercase()
        .replace("(tm)", "")
        .replace("(r)", "");
    let words: Vec<&str> = n
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let has = |w: &str| words.contains(&w);
    let vega_apu = words
        .windows(2)
        .any(|w| w[0] == "vega" && matches!(w[1], "3" | "6" | "7" | "8"));
    if has("integrated") || has("uhd") || has("iris") || vega_apu {
        return true;
    }
    if has("radeon") {
        // A bare "Radeon Graphics" (Ryzen 7000/9000 desktop and most APUs) or "Radeon 780M" style.
        let after: Vec<&str> = words
            .iter()
            .skip_while(|w| **w != "radeon")
            .skip(1)
            .copied()
            .collect();
        if after.first() == Some(&"graphics") {
            return true;
        }
        return after
            .first()
            .is_some_and(|w| is_mobile_model(w, "m") || is_mobile_model(w, "s"));
    }
    if has("intel") || has("arc") {
        if has("arc") {
            let after: Vec<&str> = words
                .iter()
                .skip_while(|w| **w != "arc")
                .skip(1)
                .copied()
                .collect();
            // "Arc Graphics" (Core Ultra 1xxH), "Arc 140V"/"130T" (Lunar Lake / Arrow Lake).
            return after.first().is_none_or(|w| {
                *w == "graphics" || is_mobile_model(w, "v") || is_mobile_model(w, "t")
            });
        }
        // "Intel(R) HD Graphics 630", "Intel(R) Graphics".
        return has("graphics") && !has("data") && !has("max") && !has("flex");
    }
    false
}

/// "780m", "8060s", "140v": three or four digits and the suffix.
fn is_mobile_model(word: &str, suffix: &str) -> bool {
    let Some(digits) = word.strip_suffix(suffix) else {
        return false;
    };
    (3..=4).contains(&digits.len()) && digits.chars().all(|c| c.is_ascii_digit())
}

/// What the default-set rule needs to know about one GPU.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GpuFacts {
    pub name: String,
    /// "nvidia" | "amd" | "intel" | "apple"; derived from the name when `None`.
    pub vendor: Option<String>,
    /// Own memory in GiB, when known.
    pub vram_gb: Option<f64>,
    pub unified: bool,
}

impl GpuFacts {
    pub fn new(name: &str, vram_bytes: Option<f64>) -> Self {
        GpuFacts {
            name: name.to_owned(),
            vendor: None,
            vram_gb: vram_bytes
                .filter(|b| b.is_finite() && *b > 0.0)
                .map(|b| b / 1_073_741_824.0),
            unified: false,
        }
    }
    fn vendor(&self) -> Option<&str> {
        self.vendor.as_deref().or_else(|| vendor_of(&self.name))
    }
    pub fn is_real(&self) -> bool {
        self.vram_gb.is_some_and(|v| v >= 4.0) || self.vendor() == Some("nvidia")
    }
    pub fn is_small_integrated(&self) -> bool {
        if self.unified || !matches!(self.vendor(), Some("amd" | "intel")) {
            return false;
        }
        match self.vram_gb {
            Some(v) => v < 2.0,
            None => is_integrated_gpu_name(&self.name),
        }
    }
}

/// Which GPUs belong to the "All GPUs" set, by position. Every GPU stays in the set unless a real
/// card is present; then small integrated GPUs drop out (never all of them).
pub fn default_gpu_mask(gpus: &[GpuFacts]) -> Vec<bool> {
    if !gpus.iter().any(GpuFacts::is_real) {
        return vec![true; gpus.len()];
    }
    let mask: Vec<bool> = gpus.iter().map(|g| !g.is_small_integrated()).collect();
    if mask.iter().any(|keep| *keep) {
        mask
    } else {
        vec![true; gpus.len()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gpu(name: &str, gib: Option<f64>) -> GpuFacts {
        GpuFacts::new(name, gib.map(|g| g * 1_073_741_824.0))
    }

    #[test]
    fn integrated_names() {
        for name in [
            "AMD Radeon(TM) Graphics",
            "AMD Radeon Graphics",
            "AMD Radeon 780M Graphics",
            "AMD Radeon(TM) 760M",
            "AMD Radeon 890M",
            "AMD Radeon 680M",
            "AMD Radeon(TM) 8060S Graphics",
            "AMD Radeon(TM) Vega 8 Graphics",
            "Intel(R) UHD Graphics 770",
            "Intel(R) Iris(R) Xe Graphics",
            "Intel(R) HD Graphics 630",
            "Intel(R) Graphics",
            "Intel(R) Arc(TM) Graphics",
            "Intel(R) Arc(TM) 140V GPU (16GB)",
            "Intel(R) Arc(TM) 130T GPU",
        ] {
            assert!(is_integrated_gpu_name(name), "{name}");
        }
        for name in [
            "NVIDIA GeForce RTX 4090",
            "AMD Radeon RX 7900 XTX",
            "AMD Radeon PRO W7900",
            "AMD Radeon RX 6800M",
            "AMD Instinct MI300X",
            "AMD Radeon RX Vega 64",
            "Intel(R) Arc(TM) A770 Graphics",
            "Intel(R) Arc(TM) B580 Graphics",
            "Intel(R) Arc(TM) Pro B60 Graphics",
            "Intel(R) Data Center GPU Max 1550",
            "Apple M4 Max",
        ] {
            assert!(!is_integrated_gpu_name(name), "{name}");
        }
    }

    #[test]
    fn small_igpu_beside_a_real_card_leaves_the_default_set() {
        // Upstream's own vector: an RTX 5070 laptop GPU beside a Ryzen's 512 MiB Radeon.
        let set = [
            gpu("NVIDIA GeForce RTX 5070 Laptop GPU", Some(11.9)),
            gpu("AMD Radeon(TM) Graphics", Some(0.5)),
        ];
        assert_eq!(default_gpu_mask(&set), vec![true, false]);
        // Size unknown (Windows adapter list without nvidia-smi): the name decides.
        let set = [
            gpu("NVIDIA GeForce RTX 4090", None),
            gpu("Intel(R) UHD Graphics 770", None),
        ];
        assert_eq!(default_gpu_mask(&set), vec![true, false]);
        // AMD dGPU + AMD iGPU (ADLX lists both).
        let set = [
            gpu("AMD Radeon RX 7900 XTX", Some(24.0)),
            gpu("AMD Radeon(TM) Graphics", Some(0.5)),
        ];
        assert_eq!(default_gpu_mask(&set), vec![true, false]);
    }

    #[test]
    fn igpu_only_unified_or_large_carve_out_machines_are_unchanged() {
        assert_eq!(
            default_gpu_mask(&[gpu("AMD Radeon(TM) Graphics", Some(0.5))]),
            vec![true]
        );
        assert_eq!(
            default_gpu_mask(&[gpu("Intel(R) Iris(R) Xe Graphics", None)]),
            vec![true]
        );
        let mut strix = gpu("AMD Radeon(TM) 8060S Graphics", Some(96.0));
        strix.unified = true;
        assert_eq!(
            default_gpu_mask(&[gpu("NVIDIA GeForce RTX 5070", Some(11.9)), strix]),
            vec![true, true]
        );
        // A 4 GB carve-out is not "small" (upstream keeps it too).
        assert_eq!(
            default_gpu_mask(&[
                gpu("NVIDIA GeForce RTX 4090", Some(24.0)),
                gpu("AMD Radeon 780M Graphics", Some(4.0))
            ]),
            vec![true, true]
        );
        // Two small cards and no real one: all kept.
        assert_eq!(
            default_gpu_mask(&[
                gpu("AMD Radeon RX 550", Some(2.0)),
                gpu("AMD Radeon(TM) Graphics", Some(0.5))
            ]),
            vec![true, true]
        );
    }
}
