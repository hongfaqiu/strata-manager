//! Windows reader: AMD Device Library eXtra (ADLX) performance monitoring.
//! https://gpuopen.com/manuals/adlx/adlx-_d_o_x__i_a_d_l_x_performance_monitoring_services/
//!
//! `amdadlx64.dll` ships with the Adrenalin driver in System32 and is loaded only at run time,
//! so the app starts and runs normally on PCs without it. ADLX is loaded only in a helper child
//! process (`--amd-adlx-telemetry`, see `isolated.rs`) that samples about once a second while
//! the monitor is being read; a crash inside the driver library ends only that helper.

use super::adlx_sample::{
    card_sample, identity_sample, GpuIdentity, GpuMetricsReadings, Reading, Unavailable,
};
use super::AmdGpuSample;
use adlx::{
    ffi, gpu::Gpu1, gpu_metrics::GpuMetrics, helper::AdlxHelper, interface::Interface,
    performance_monitoring_services::PerformanceMonitoringServices, Gpu,
};
use std::io::Write;
use std::time::Duration;

const SAMPLE_EVERY: Duration = Duration::from_secs(1);

/// Only load the driver's own copy; never search PATH or the working directory for it.
pub(super) fn driver_dll_present() -> bool {
    std::env::var_os("SystemRoot")
        .map(|root| {
            std::path::Path::new(&root)
                .join("System32")
                .join("amdadlx64.dll")
                .is_file()
        })
        .unwrap_or(false)
}

/// Start `<this exe> --amd-adlx-telemetry` with no window. ADLX is never loaded into the
/// supervisor itself (#124 / #127): see `isolated.rs`.
pub(super) fn spawn_helper() -> std::io::Result<std::process::Child> {
    use std::process::{Command, Stdio};
    if !driver_dll_present() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "amdadlx64.dll is not installed",
        ));
    }
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg(super::WORKER_FLAG)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::processes::hidden(&mut command);
    command.spawn()
}

/// Body of the helper process: one JSON line of samples per second on stdout until stdin closes
/// (the parent stopped it or exited) or stdout can no longer be written.
pub(super) fn worker_main() -> i32 {
    // SAFETY: plain Win32 call with no pointers. A fault in the driver library ends this helper
    // quietly instead of raising a crash dialog; the parent only loses the readings.
    unsafe {
        use windows_sys::Win32::System::Diagnostics::Debug::{
            GetErrorMode, SetErrorMode, SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX,
            SEM_NOOPENFILEERRORBOX,
        };
        SetErrorMode(
            GetErrorMode()
                | SEM_FAILCRITICALERRORS
                | SEM_NOGPFAULTERRORBOX
                | SEM_NOOPENFILEERRORBOX,
        );
    }
    std::thread::spawn(|| {
        let mut sink = [0u8; 64];
        let mut stdin = std::io::stdin();
        while matches!(std::io::Read::read(&mut stdin, &mut sink), Ok(n) if n > 0) {}
        std::process::exit(0);
    });
    match std::panic::catch_unwind(run) {
        Ok(Ok(())) => 0,
        Ok(Err(_)) => 3,
        Err(_) => 4,
    }
}

fn run() -> Result<(), String> {
    // Map System32's copy by absolute path first: `AdlxHelper` loads the DLL by name, and Windows
    // resolves a name to an already-loaded module before searching any directory.
    let pin = SystemDll::load()?;
    let helper = AdlxHelper::new().map_err(|e| e.to_string())?;
    let result = (|| {
        let session = Session::open(&helper)?;
        let mut stdout = std::io::stdout().lock();
        loop {
            let line = serde_json::to_string(&session.sample()).map_err(|e| e.to_string())?;
            if writeln!(stdout, "{line}")
                .and_then(|_| stdout.flush())
                .is_err()
            {
                return Ok(());
            }
            std::thread::sleep(SAMPLE_EVERY);
        }
        // Every ADLX interface is released here, before ADLX terminates with `helper`.
    })();
    drop(helper);
    drop(pin);
    result
}

struct SystemDll(windows_sys::Win32::Foundation::HMODULE);

impl SystemDll {
    fn load() -> Result<Self, String> {
        use std::os::windows::ffi::OsStrExt;
        let root = std::env::var_os("SystemRoot").ok_or("SystemRoot is not set")?;
        let path = std::path::Path::new(&root)
            .join("System32")
            .join("amdadlx64.dll");
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: `wide` is a NUL-terminated absolute path; loading AMD's driver DLL runs its own
        // initialization, which is the documented way to use ADLX.
        let module =
            unsafe { windows_sys::Win32::System::LibraryLoader::LoadLibraryW(wide.as_ptr()) };
        if module.is_null() {
            return Err("amdadlx64.dll could not be loaded".into());
        }
        Ok(Self(module))
    }
}

impl Drop for SystemDll {
    fn drop(&mut self) {
        // SAFETY: the handle came from LoadLibraryW and is released exactly once.
        unsafe { windows_sys::Win32::Foundation::FreeLibrary(self.0) };
    }
}

/// One card, with its `IADLXGPU1` queried once and its static facts read once.
struct Card {
    gpu: Gpu,
    identity: AmdGpuSample,
}

struct Session {
    /// `None` when the driver has no performance monitoring: the cards are still listed.
    monitoring: Option<PerformanceMonitoringServices>,
    cards: Vec<Card>,
}

/// `QueryInterface` without the extra `Release` of adlx 0.0.0-alpha.1 (#127).
///
/// That release's `Interface::cast` copies the pointer into an owned `InterfaceImpl` and drops it,
/// so every cast releases one reference of `self` that it never acquired (fixed upstream in
/// Traverse-Research/adlx-rs#21, not published). The 0.2.12–0.2.15 reader cast `IADLXGPU1` on
/// every sample: the GPU object was freed after the first one and the next sample touched freed
/// driver memory, which took the supervisor down before #131 and ends the helper since. Giving
/// `cast` a reference of its own (acquired by `clone`, never released here) keeps the count right
/// with either crate version.
fn query<I: Interface>(gpu: &Gpu) -> Option<I> {
    let lent = std::mem::ManuallyDrop::new(gpu.clone());
    lent.cast::<I>().ok()
}

fn reading<T>(result: adlx::Result<T>) -> Reading<T> {
    result.map_err(|e| {
        if e.to_string() == "The asked feature is not supported" {
            Unavailable::NotSupported
        } else {
            Unavailable::Failed
        }
    })
}

struct Identity<'a> {
    gpu: &'a Gpu,
    gpu1: Option<&'a Gpu1>,
}

impl GpuIdentity for Identity<'_> {
    fn name(&self) -> Reading<String> {
        reading(self.gpu.name().map(str::to_owned))
    }
    fn product_name(&self) -> Reading<String> {
        let gpu1 = self.gpu1.ok_or(Unavailable::NotSupported)?;
        reading(gpu1.product_name().map(str::to_owned))
    }
    fn total_vram_mb(&self) -> Reading<u32> {
        reading(self.gpu.total_vram())
    }
    fn pci_bus_type(&self) -> Reading<i32> {
        reading(self.gpu1.ok_or(Unavailable::NotSupported)?.pci_bus_type())
    }
    fn pci_bus_lane_width(&self) -> Reading<u32> {
        reading(
            self.gpu1
                .ok_or(Unavailable::NotSupported)?
                .pci_bus_lane_width(),
        )
    }
}

impl GpuMetricsReadings for GpuMetrics {
    fn usage(&self) -> Reading<f64> {
        reading(GpuMetrics::usage(self))
    }
    fn vram_mb(&self) -> Reading<i32> {
        reading(self.vram())
    }
    fn temperature(&self) -> Reading<f64> {
        reading(GpuMetrics::temperature(self))
    }
    fn hotspot_temperature(&self) -> Reading<f64> {
        reading(GpuMetrics::hotspot_temperature(self))
    }
    fn total_board_power(&self) -> Reading<f64> {
        reading(GpuMetrics::total_board_power(self))
    }
    fn power(&self) -> Reading<f64> {
        reading(GpuMetrics::power(self))
    }
    fn clock_speed(&self) -> Reading<i32> {
        reading(GpuMetrics::clock_speed(self))
    }
    fn vram_clock_speed(&self) -> Reading<i32> {
        reading(GpuMetrics::vram_clock_speed(self))
    }
    fn fan_speed(&self) -> Reading<i32> {
        reading(GpuMetrics::fan_speed(self))
    }
}

impl Session {
    fn open(helper: &AdlxHelper) -> Result<Self, String> {
        let system = helper.system();
        let list = system.gpus().map_err(|e| e.to_string())?;
        let all: Vec<Gpu> = (0..list.size()).filter_map(|i| list.at(i).ok()).collect();
        // The model runs on a discrete card; an APU's integrated GPU next to it is not shown.
        let discrete: Vec<Gpu> = all
            .iter()
            .filter(|g| g.type_().ok() == Some(ffi::ADLX_GPU_TYPE_GPUTYPE_DISCRETE))
            .cloned()
            .collect();
        let gpus = if discrete.is_empty() { all } else { discrete };
        if gpus.is_empty() {
            return Err("ADLX found no AMD GPU".into());
        }
        let cards = gpus
            .into_iter()
            .map(|gpu| {
                let gpu1 = query::<Gpu1>(&gpu);
                let identity = identity_sample(&Identity {
                    gpu: &gpu,
                    gpu1: gpu1.as_ref(),
                });
                Card { gpu, identity }
            })
            .collect();
        Ok(Self {
            monitoring: system.performance_monitoring_services().ok(),
            cards,
        })
    }

    fn sample(&self) -> Vec<AmdGpuSample> {
        self.cards
            .iter()
            .map(|card| {
                let metrics = self
                    .monitoring
                    .as_ref()
                    .and_then(|m| m.current_gpu_metrics(&card.gpu).ok());
                card_sample(&card.identity, metrics.as_ref())
            })
            .collect()
    }
}
