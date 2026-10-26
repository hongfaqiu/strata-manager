//! Windows fallback GPU listing when `nvidia-smi` is unavailable.
//!
//! `Win32_VideoController` also lists software/indirect display drivers
//! (Meta/Oculus "Meta Virtual Monitor", Parsec, Microsoft Basic Display, remote
//! desktop adapters …). They are monitors, not compute devices, and must not be
//! shown or chosen as the GPU (#66).
#![cfg_attr(not(windows), allow(dead_code))]

/// PowerShell query: one `PNPDeviceID<TAB>Name<TAB>AdapterRAM` row per video controller.
#[cfg(windows)]
const QUERY: &str = "Get-CimInstance Win32_VideoController | ForEach-Object { [string]$_.PNPDeviceID + [char]9 + [string]$_.Name + [char]9 + [string]$_.AdapterRAM }";

/// Name fragments (lower-case) of display adapters that are not real GPUs.
const VIRTUAL_NAME_MARKERS: &[&str] = &[
    "virtual",
    "microsoft basic display",
    "microsoft basic render",
    "microsoft remote display",
    "remote display adapter",
    "indirect display",
    "mirage driver",
    "parsec",
    "spacedesk",
    "displaylink",
];

/// Software-enumerated device roots: no physical (PCI/ACPI) GPU behind them.
const VIRTUAL_PNP_PREFIXES: &[&str] = &["root\\", "swd\\", "usb\\"];

pub(crate) fn is_virtual_display_adapter(pnp_device_id: &str, name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let pnp = pnp_device_id.trim().to_ascii_lowercase();
    VIRTUAL_NAME_MARKERS
        .iter()
        .any(|marker| name.contains(marker))
        || VIRTUAL_PNP_PREFIXES
            .iter()
            .any(|prefix| pnp.starts_with(prefix))
}

/// Parse the query output into real GPU names, preserving order.
/// A row without a tab is treated as a bare name (older output format). Unfiltered: the app
/// itself uses [`windows_gpu_adapters`], which also leaves out an integrated GPU beside a card.
#[cfg(test)]
pub(crate) fn parse_video_controllers(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let (pnp, name) = line.split_once('\t').unwrap_or(("", line));
            let name = name.trim();
            (!name.is_empty() && !is_virtual_display_adapter(pnp, name)).then(|| name.to_owned())
        })
        .collect()
}

/// One real (non-virtual) display adapter.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DisplayAdapter {
    pub name: String,
    /// From the PCI vendor id (`VEN_10DE` / `VEN_1002` / `VEN_8086`), else the name.
    pub vendor: Option<&'static str>,
    /// `Win32_VideoController.AdapterRAM` (a uint32: 4 GiB and larger cards read as about 4 GiB).
    pub vram_bytes: Option<f64>,
}

impl DisplayAdapter {
    fn facts(&self) -> crate::igpu::GpuFacts {
        let mut facts = crate::igpu::GpuFacts::new(&self.name, self.vram_bytes);
        facts.vendor = self.vendor.map(str::to_owned);
        facts
    }
}

/// Parse the query output into real display adapters, preserving order.
pub(crate) fn parse_video_controller_rows(text: &str) -> Vec<DisplayAdapter> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let mut parts = line.split('\t');
            let (pnp, name, ram) = match (parts.next(), parts.next(), parts.next()) {
                (Some(pnp), Some(name), ram) => (pnp, name, ram),
                (Some(name), None, _) => ("", name, None),
                _ => return None,
            };
            let name = name.trim();
            if name.is_empty() || is_virtual_display_adapter(pnp, name) {
                return None;
            }
            let pnp_lower = pnp.to_ascii_lowercase();
            let vendor = if pnp_lower.contains("ven_10de") {
                Some("nvidia")
            } else if pnp_lower.contains("ven_1002") {
                Some("amd")
            } else if pnp_lower.contains("ven_8086") {
                Some("intel")
            } else {
                crate::igpu::vendor_of(name)
            };
            let vram_bytes = ram
                .and_then(|r| r.trim().parse::<f64>().ok())
                .filter(|b| b.is_finite() && *b > 0.0)
                // A saturated uint32 means "4 GiB or more".
                .map(|b| {
                    if b >= 4_026_531_840.0 {
                        4.0 * 1_073_741_824.0
                    } else {
                        b
                    }
                });
            Some(DisplayAdapter {
                name: name.to_owned(),
                vendor,
                vram_bytes,
            })
        })
        .collect()
}

/// The adapters that count as GPUs: a small integrated GPU (Ryzen "Radeon(TM) Graphics", Intel
/// UHD/Iris) beside a real card is left out, as upstream's HIP card list and monitor do; a
/// machine with only an integrated GPU keeps it.
pub(crate) fn default_adapters(adapters: Vec<DisplayAdapter>) -> Vec<DisplayAdapter> {
    let facts: Vec<_> = adapters.iter().map(DisplayAdapter::facts).collect();
    let mask = crate::igpu::default_gpu_mask(&facts);
    adapters
        .into_iter()
        .zip(mask)
        .filter_map(|(adapter, keep)| keep.then_some(adapter))
        .collect()
}

#[cfg(windows)]
pub(crate) fn windows_gpu_adapters() -> Option<Vec<DisplayAdapter>> {
    crate::output(
        "powershell.exe",
        &["-NoProfile", "-NonInteractive", "-Command", QUERY],
    )
    .map(|text| default_adapters(parse_video_controller_rows(&text)))
}

#[cfg(windows)]
pub(crate) fn windows_gpu_names() -> Option<Vec<String>> {
    windows_gpu_adapters().map(|adapters| adapters.into_iter().map(|a| a.name).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meta_virtual_monitor_is_not_a_gpu() {
        // Shape reported in #66: Meta Quest Link virtual display + a real Radeon.
        let text = "ROOT\\DISPLAY\\0000\tMeta Virtual Monitor\r\n\
                    PCI\\VEN_1002&DEV_744C&SUBSYS_0E3B1002&REV_C8\\6&1A2B3C4D&0&00000019\tAMD Radeon RX 7900 XTX\r\n";
        assert_eq!(
            parse_video_controllers(text),
            vec!["AMD Radeon RX 7900 XTX"]
        );
    }

    #[test]
    fn software_and_remote_adapters_are_filtered_by_name_or_pnp_root() {
        let text = [
            "PCI\\VEN_10DE&DEV_2684\tNVIDIA GeForce RTX 4090",
            "ROOT\\BasicDisplay\\0000\tMicrosoft Basic Display Adapter",
            "SWD\\REMOTEDISPLAYENUM\\RDPIDD\tMicrosoft Remote Display Adapter",
            "ROOT\\DISPLAY\\0001\tParsec Virtual Display Adapter",
            "ROOT\\DISPLAY\\0002\tSome Indirect Display Driver",
            "PCI\\VEN_8086&DEV_A780\tIntel(R) UHD Graphics 770",
            "",
        ]
        .join("\n");
        assert_eq!(
            parse_video_controllers(&text),
            vec!["NVIDIA GeForce RTX 4090", "Intel(R) UHD Graphics 770"]
        );
    }

    #[test]
    fn integrated_gpu_beside_a_real_card_is_left_out_without_nvidia_smi() {
        let text = [
            "PCI\\VEN_1002&DEV_744C\tAMD Radeon RX 7900 XTX\t4293918720",
            "PCI\\VEN_1002&DEV_164E\tAMD Radeon(TM) Graphics\t536870912",
            "ROOT\\DISPLAY\\0000\tMeta Virtual Monitor\t0",
        ]
        .join("\n");
        let rows = parse_video_controller_rows(&text);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].vendor, Some("amd"));
        assert_eq!(rows[1].vram_bytes, Some(536870912.0));
        let names: Vec<_> = default_adapters(rows).into_iter().map(|a| a.name).collect();
        assert_eq!(names, vec!["AMD Radeon RX 7900 XTX"]);

        // NVIDIA + Intel UHD, old two-column output (no AdapterRAM): the name decides.
        let text = "PCI\\VEN_10DE&DEV_2684\tNVIDIA GeForce RTX 4090\nPCI\\VEN_8086&DEV_A780\tIntel(R) UHD Graphics 770\n";
        let names: Vec<_> = default_adapters(parse_video_controller_rows(text))
            .into_iter()
            .map(|a| a.name)
            .collect();
        assert_eq!(names, vec!["NVIDIA GeForce RTX 4090"]);
    }

    #[test]
    fn integrated_gpu_alone_is_kept() {
        let text = "PCI\\VEN_8086&DEV_46A6\tIntel(R) Iris(R) Xe Graphics\t1073741824\n";
        let rows = default_adapters(parse_video_controller_rows(text));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].vendor, Some("intel"));
    }

    #[test]
    fn bare_names_are_still_accepted_but_virtual_names_dropped() {
        assert_eq!(
            parse_video_controllers("AMD Radeon RX 7900 XTX\nMeta Virtual Monitor\n"),
            vec!["AMD Radeon RX 7900 XTX"]
        );
    }
}
