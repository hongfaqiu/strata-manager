//! Windows fallback GPU listing when `nvidia-smi` is unavailable.
//!
//! `Win32_VideoController` also lists software/indirect display drivers
//! (Meta/Oculus "Meta Virtual Monitor", Parsec, Microsoft Basic Display, remote
//! desktop adapters …). They are monitors, not compute devices, and must not be
//! shown or chosen as the GPU (#66).
#![cfg_attr(not(windows), allow(dead_code))]

/// PowerShell query: one `PNPDeviceID<TAB>Name` row per video controller.
#[cfg(windows)]
const QUERY: &str = "Get-CimInstance Win32_VideoController | ForEach-Object { [string]$_.PNPDeviceID + [char]9 + [string]$_.Name }";

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
/// A row without a tab is treated as a bare name (older output format).
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

#[cfg(windows)]
pub(crate) fn windows_gpu_names() -> Option<Vec<String>> {
    crate::output(
        "powershell.exe",
        &["-NoProfile", "-NonInteractive", "-Command", QUERY],
    )
    .map(|text| parse_video_controllers(&text))
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
    fn bare_names_are_still_accepted_but_virtual_names_dropped() {
        assert_eq!(
            parse_video_controllers("AMD Radeon RX 7900 XTX\nMeta Virtual Monitor\n"),
            vec!["AMD Radeon RX 7900 XTX"]
        );
    }
}
