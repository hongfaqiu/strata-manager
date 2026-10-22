//! Turns ADLX readings into an [`AmdGpuSample`], one metric at a time (#127).
//!
//! Kept apart from `adlx.rs` so the rules run in tests on every platform: drivers answer
//! `ADLX_NOT_SUPPORTED` for some metrics of a card (an RX 7900 XTX has no "GPU power" or intake
//! temperature, and reports `IsSupportedGPUPower() == false` while total board power works), so
//! every value is read and dropped on its own and the `IsSupported*` flags are never used as a
//! gate. A failed call only leaves its own field empty.

use super::{non_negative, positive, AmdGpuSample};

/// Why one ADLX call gave no value. Only kept apart for tests and diagnostics; both are treated
/// the same: the field stays empty.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Unavailable {
    NotSupported,
    Failed,
}

pub(super) type Reading<T> = Result<T, Unavailable>;

const MIB: f64 = 1_048_576.0;

/// Static facts about one card (`IADLXGPU` / `IADLXGPU1`), read once per helper session.
pub(super) trait GpuIdentity {
    fn name(&self) -> Reading<String>;
    /// `IADLXGPU1::ProductName`; `Err` too when the driver has no `IADLXGPU1`.
    fn product_name(&self) -> Reading<String>;
    fn total_vram_mb(&self) -> Reading<u32>;
    fn pci_bus_type(&self) -> Reading<i32>;
    fn pci_bus_lane_width(&self) -> Reading<u32>;
}

/// One `IADLXGPUMetrics` snapshot.
pub(super) trait GpuMetricsReadings {
    fn usage(&self) -> Reading<f64>;
    fn vram_mb(&self) -> Reading<i32>;
    fn temperature(&self) -> Reading<f64>;
    fn hotspot_temperature(&self) -> Reading<f64>;
    fn total_board_power(&self) -> Reading<f64>;
    fn power(&self) -> Reading<f64>;
    fn clock_speed(&self) -> Reading<i32>;
    fn vram_clock_speed(&self) -> Reading<i32>;
    fn fan_speed(&self) -> Reading<i32>;
}

fn clean(name: Reading<String>) -> Option<String> {
    name.ok()
        .map(|n| n.trim().to_owned())
        .filter(|n| !n.is_empty())
}

/// `ADLX_PCI_BUS_TYPE`: PCIE = 3, PCIE_2_0 = 4, PCIE_3_0 = 5, PCIE_4_0 = 6, PCIE_5_0 = 7 (ADLX 1.3+).
pub(super) fn pcie_generation(bus: i32) -> Option<f64> {
    match bus {
        3 => Some(1.0),
        4 => Some(2.0),
        5 => Some(3.0),
        6 => Some(4.0),
        7 => Some(5.0),
        _ => None,
    }
}

/// Name, VRAM size and PCIe link of one card; each call is independent.
pub(super) fn identity_sample(gpu: &impl GpuIdentity) -> AmdGpuSample {
    AmdGpuSample {
        // The marketing name ("AMD Radeon RX 7900 XTX") matches the engine and Task Manager; the
        // board string ("XFX D702_XTX_A0_24GB_…") is only a fallback.
        name: clean(gpu.name()).or_else(|| clean(gpu.product_name())),
        mem_total: gpu
            .total_vram_mb()
            .ok()
            .and_then(|mb| positive(f64::from(mb) * MIB)),
        pcie_gen_max: gpu.pci_bus_type().ok().and_then(pcie_generation),
        pcie_width: gpu
            .pci_bus_lane_width()
            .ok()
            .and_then(|w| positive(f64::from(w))),
        ..Default::default()
    }
}

/// Adds every metric the snapshot has to `sample`; unsupported ones stay `None`.
pub(super) fn fill_metrics(sample: &mut AmdGpuSample, m: &impl GpuMetricsReadings) {
    sample.util = m.usage().ok().and_then(non_negative);
    sample.mem_used = m
        .vram_mb()
        .ok()
        .and_then(|mb| non_negative(f64::from(mb) * MIB));
    sample.temp = m.temperature().ok().and_then(positive);
    sample.hotspot_temp = m.hotspot_temperature().ok().and_then(positive);
    // Total board power matches what nvidia-smi reports; older ASICs only have GPU power.
    sample.power = m
        .total_board_power()
        .ok()
        .and_then(positive)
        .or_else(|| m.power().ok().and_then(positive));
    sample.clock_mhz = m.clock_speed().ok().and_then(|v| positive(f64::from(v)));
    sample.mem_clock_mhz = m
        .vram_clock_speed()
        .ok()
        .and_then(|v| positive(f64::from(v)));
    sample.fan_rpm = m.fan_speed().ok().and_then(|v| positive(f64::from(v)));
}

/// One card's sample: identity plus whatever metrics the driver returned this time. `metrics`
/// is `None` when `GetCurrentGPUMetrics` itself failed; the card is still reported.
pub(super) fn card_sample(
    identity: &AmdGpuSample,
    metrics: Option<&impl GpuMetricsReadings>,
) -> AmdGpuSample {
    let mut sample = identity.clone();
    if let Some(m) = metrics {
        fill_metrics(&mut sample, m);
    }
    sample
}

#[cfg(test)]
mod tests {
    use super::Unavailable::{Failed, NotSupported};
    use super::*;

    /// RX 7900 XTX, Adrenalin 26.6.4, ADLX 1.5 (#127): readings from the reporter's probe, with
    /// GPU power and intake temperature not supported.
    struct Rx7900Xtx;
    impl GpuIdentity for Rx7900Xtx {
        fn name(&self) -> Reading<String> {
            Ok("AMD Radeon RX 7900 XTX".into())
        }
        fn product_name(&self) -> Reading<String> {
            Ok("XFX D702_XTX_A0_24GB_XFX_APM6294_79XTACBD".into())
        }
        fn total_vram_mb(&self) -> Reading<u32> {
            Ok(24560)
        }
        fn pci_bus_type(&self) -> Reading<i32> {
            Ok(6)
        }
        fn pci_bus_lane_width(&self) -> Reading<u32> {
            Ok(16)
        }
    }
    impl GpuMetricsReadings for Rx7900Xtx {
        fn usage(&self) -> Reading<f64> {
            Ok(34.0)
        }
        fn vram_mb(&self) -> Reading<i32> {
            Ok(2310)
        }
        fn temperature(&self) -> Reading<f64> {
            Ok(27.0)
        }
        fn hotspot_temperature(&self) -> Reading<f64> {
            Ok(32.0)
        }
        fn total_board_power(&self) -> Reading<f64> {
            Ok(34.0)
        }
        fn power(&self) -> Reading<f64> {
            Err(NotSupported)
        }
        fn clock_speed(&self) -> Reading<i32> {
            Ok(1300)
        }
        fn vram_clock_speed(&self) -> Reading<i32> {
            Ok(182)
        }
        fn fan_speed(&self) -> Reading<i32> {
            Ok(1188)
        }
    }

    /// Every call fails, as on a driver without performance monitoring for this card.
    struct Nothing;
    impl GpuIdentity for Nothing {
        fn name(&self) -> Reading<String> {
            Err(Failed)
        }
        fn product_name(&self) -> Reading<String> {
            Err(NotSupported)
        }
        fn total_vram_mb(&self) -> Reading<u32> {
            Err(NotSupported)
        }
        fn pci_bus_type(&self) -> Reading<i32> {
            Err(NotSupported)
        }
        fn pci_bus_lane_width(&self) -> Reading<u32> {
            Err(NotSupported)
        }
    }
    impl GpuMetricsReadings for Nothing {
        fn usage(&self) -> Reading<f64> {
            Err(NotSupported)
        }
        fn vram_mb(&self) -> Reading<i32> {
            Err(NotSupported)
        }
        fn temperature(&self) -> Reading<f64> {
            Err(NotSupported)
        }
        fn hotspot_temperature(&self) -> Reading<f64> {
            Err(Failed)
        }
        fn total_board_power(&self) -> Reading<f64> {
            Err(NotSupported)
        }
        fn power(&self) -> Reading<f64> {
            Err(NotSupported)
        }
        fn clock_speed(&self) -> Reading<i32> {
            Err(NotSupported)
        }
        fn vram_clock_speed(&self) -> Reading<i32> {
            Err(NotSupported)
        }
        fn fan_speed(&self) -> Reading<i32> {
            Err(NotSupported)
        }
    }

    /// An older ASIC: no total board power, GPU power only; usage fails, the rest works.
    struct OlderCard;
    impl GpuMetricsReadings for OlderCard {
        fn usage(&self) -> Reading<f64> {
            Err(Failed)
        }
        fn vram_mb(&self) -> Reading<i32> {
            Ok(1024)
        }
        fn temperature(&self) -> Reading<f64> {
            Ok(55.0)
        }
        fn hotspot_temperature(&self) -> Reading<f64> {
            Err(NotSupported)
        }
        fn total_board_power(&self) -> Reading<f64> {
            Err(NotSupported)
        }
        fn power(&self) -> Reading<f64> {
            Ok(120.0)
        }
        fn clock_speed(&self) -> Reading<i32> {
            Ok(0)
        }
        fn vram_clock_speed(&self) -> Reading<i32> {
            Err(NotSupported)
        }
        fn fan_speed(&self) -> Reading<i32> {
            Ok(900)
        }
    }

    #[test]
    fn unsupported_gpu_power_keeps_every_other_rx_7900_xtx_metric() {
        let identity = identity_sample(&Rx7900Xtx);
        let sample = card_sample(&identity, Some(&Rx7900Xtx));
        assert_eq!(sample.name.as_deref(), Some("AMD Radeon RX 7900 XTX"));
        assert_eq!(sample.mem_total, Some(24560.0 * MIB));
        assert_eq!(sample.pcie_gen_max, Some(4.0));
        assert_eq!(sample.pcie_width, Some(16.0));
        assert_eq!(sample.util, Some(34.0));
        assert_eq!(sample.mem_used, Some(2310.0 * MIB));
        assert_eq!(sample.temp, Some(27.0));
        assert_eq!(sample.hotspot_temp, Some(32.0));
        assert_eq!(
            sample.power,
            Some(34.0),
            "total board power despite no GPU power"
        );
        assert_eq!(sample.clock_mhz, Some(1300.0));
        assert_eq!(sample.mem_clock_mhz, Some(182.0));
        assert_eq!(sample.fan_rpm, Some(1188.0));
    }

    #[test]
    fn each_failed_metric_only_empties_its_own_field() {
        let mut sample = AmdGpuSample::default();
        fill_metrics(&mut sample, &OlderCard);
        assert_eq!(sample.util, None);
        assert_eq!(sample.mem_used, Some(1024.0 * MIB));
        assert_eq!(sample.temp, Some(55.0));
        assert_eq!(sample.hotspot_temp, None);
        assert_eq!(sample.power, Some(120.0), "falls back to GPU power");
        assert_eq!(sample.clock_mhz, None, "0 MHz means not reported");
        assert_eq!(sample.mem_clock_mhz, None);
        assert_eq!(sample.fan_rpm, Some(900.0));
    }

    #[test]
    fn card_without_any_reading_is_still_listed_empty() {
        let identity = identity_sample(&Nothing);
        assert_eq!(identity, AmdGpuSample::default());
        let sample = card_sample(&identity, Some(&Nothing));
        assert_eq!(sample, AmdGpuSample::default());
    }

    #[test]
    fn failed_metrics_snapshot_keeps_the_card_identity() {
        let identity = identity_sample(&Rx7900Xtx);
        let sample = card_sample(&identity, None::<&Nothing>);
        assert_eq!(sample.name.as_deref(), Some("AMD Radeon RX 7900 XTX"));
        assert_eq!(sample.mem_total, Some(24560.0 * MIB));
        assert_eq!(sample.util, None);
    }

    #[test]
    fn product_name_is_only_a_fallback() {
        struct BoardOnly;
        impl GpuIdentity for BoardOnly {
            fn name(&self) -> Reading<String> {
                Ok("  ".into())
            }
            fn product_name(&self) -> Reading<String> {
                Ok("XFX D702_XTX".into())
            }
            fn total_vram_mb(&self) -> Reading<u32> {
                Ok(0)
            }
            fn pci_bus_type(&self) -> Reading<i32> {
                Ok(7)
            }
            fn pci_bus_lane_width(&self) -> Reading<u32> {
                Err(NotSupported)
            }
        }
        let sample = identity_sample(&BoardOnly);
        assert_eq!(sample.name.as_deref(), Some("XFX D702_XTX"));
        assert_eq!(sample.mem_total, None, "0 MB means not reported");
        assert_eq!(sample.pcie_gen_max, Some(5.0));
        assert_eq!(sample.pcie_width, None);
    }
}
