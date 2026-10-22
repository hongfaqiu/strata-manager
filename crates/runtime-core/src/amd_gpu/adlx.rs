//! Windows reader: AMD Device Library eXtra (ADLX) performance monitoring.
//! https://gpuopen.com/manuals/adlx/adlx-_d_o_x__i_a_d_l_x_performance_monitoring_services/
//!
//! `amdadlx64.dll` ships with the Adrenalin driver in System32 and is loaded only at run time,
//! so the app starts and runs normally on PCs without it. ADLX is loaded only in a helper child
//! process (`--amd-adlx-telemetry`, see `isolated.rs`) that samples about once a second while
//! the monitor is being read; a crash inside the driver library ends only that helper.

use super::{non_negative, positive, AmdGpuSample};
use adlx::{
    ffi, gpu::Gpu1, helper::AdlxHelper, interface::Interface,
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

struct Session {
    monitoring: PerformanceMonitoringServices,
    gpus: Vec<Gpu>,
}

impl Session {
    fn open(helper: &AdlxHelper) -> Result<Self, String> {
        let system = helper.system();
        let monitoring = system
            .performance_monitoring_services()
            .map_err(|e| e.to_string())?;
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
        Ok(Self { monitoring, gpus })
    }

    fn sample(&self) -> Vec<AmdGpuSample> {
        self.gpus.iter().map(|gpu| self.read(gpu)).collect()
    }

    fn read(&self, gpu: &Gpu) -> AmdGpuSample {
        const MIB: f64 = 1_048_576.0;
        let gpu1 = gpu.cast::<Gpu1>().ok();
        let name = gpu1
            .as_ref()
            .and_then(|g| g.product_name().ok().map(str::to_owned))
            .or_else(|| gpu.name().ok().map(str::to_owned))
            .filter(|n| !n.trim().is_empty());
        let mut sample = AmdGpuSample {
            name,
            mem_total: gpu
                .total_vram()
                .ok()
                .and_then(|mb| positive(f64::from(mb) * MIB)),
            pcie_gen_max: gpu1
                .as_ref()
                .and_then(|g| g.pci_bus_type().ok())
                .and_then(pcie_generation),
            pcie_width: gpu1
                .as_ref()
                .and_then(|g| g.pci_bus_lane_width().ok())
                .and_then(|w| positive(f64::from(w))),
            ..Default::default()
        };
        if let Ok(m) = self.monitoring.current_gpu_metrics(gpu) {
            sample.util = m.usage().ok().and_then(non_negative);
            sample.mem_used = m
                .vram()
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
        sample
    }
}

fn pcie_generation(bus: ffi::ADLX_PCI_BUS_TYPE) -> Option<f64> {
    match bus {
        ffi::ADLX_PCI_BUS_TYPE_PCIE => Some(1.0),
        ffi::ADLX_PCI_BUS_TYPE_PCIE_2_0 => Some(2.0),
        ffi::ADLX_PCI_BUS_TYPE_PCIE_3_0 => Some(3.0),
        ffi::ADLX_PCI_BUS_TYPE_PCIE_4_0 => Some(4.0),
        _ => None,
    }
}
