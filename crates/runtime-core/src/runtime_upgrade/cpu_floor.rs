//! The official prebuilt Strata engines are compiled for AVX2 (upstream setup.py `cpu_floor`:
//! "the ready-made engine is AVX2; an older CPU gets one compiled here"). Manager installs only
//! those prebuilt engines, so on a CPU without AVX2 an engine install or update is refused
//! before anything is downloaded, and an existing runtime can still take the new code alone
//! (「只更新代码」, `RuntimeZipDownloadOptions::source_only`).
use serde::Serialize;

/// AVX2 on this computer: `None` where the question does not apply (not x86) or cannot be
/// answered.
pub fn host_avx2() -> Option<bool> {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        Some(std::arch::is_x86_feature_detected!("avx2"))
    }
    #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
    {
        None
    }
}

/// Why an engine install or update is refused on this CPU, or `None` when it may go ahead.
/// `new_install`: a first install has no engine to keep, so it cannot take the code alone.
pub fn engine_block(avx2: Option<bool>, new_install: bool) -> Option<String> {
    if avx2 != Some(false) {
        return None;
    }
    Some(if new_install {
        "这台电脑的 CPU 不支持 AVX2，官方预编译引擎无法运行，因此不安装引擎包；可改用源码安装（官方安装器 setup.py 会在本机编译引擎） / This CPU has no AVX2, which the official prebuilt engines need, so no engine package is installed; use the source install instead (setup.py builds an engine on this computer)".into()
    } else {
        "这台电脑的 CPU 不支持 AVX2，官方预编译引擎无法运行，已拦下引擎更新；可选择「只更新代码」，保留当前引擎 / This CPU has no AVX2, which the official prebuilt engines need, so the engine update was stopped; choose \"Update code only\" to keep the current engine".into()
    })
}

/// What the update dialog asks before an update (`runtime_cpu_check_v1`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CpuCheck {
    pub avx2: Option<bool>,
    /// Set when the engine update is refused; the dialog then offers 「只更新代码」.
    pub engine_blocked: Option<String>,
}

pub fn check() -> CpuCheck {
    let avx2 = host_avx2();
    CpuCheck {
        avx2,
        engine_blocked: engine_block(avx2, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_cpu_known_to_lack_avx2_is_blocked() {
        assert_eq!(engine_block(Some(true), false), None);
        assert_eq!(engine_block(None, false), None);
        assert_eq!(engine_block(None, true), None);
        let update = engine_block(Some(false), false).unwrap();
        assert!(
            update.contains("AVX2") && update.contains("只更新代码"),
            "{update}"
        );
        let install = engine_block(Some(false), true).unwrap();
        assert!(
            install.contains("源码安装") && !install.contains("只更新代码"),
            "{install}"
        );
    }

    #[test]
    fn the_check_reports_this_computer() {
        let check = check();
        assert_eq!(check.avx2, host_avx2());
        assert_eq!(check.engine_blocked.is_some(), check.avx2 == Some(false));
    }
}
