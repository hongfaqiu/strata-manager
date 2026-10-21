//! Strata 0.2+ component engine packages next to the legacy ZIP path.
use super::*;
use flate2::{write::GzEncoder, Compression};

enum Item<'a> {
    File(&'a str, &'a [u8]),
    Raw(&'a str, tar::EntryType, &'a [u8]),
}

fn package(dir: &Path, items: &[Item]) -> PathBuf {
    let path = dir.join("engine.tar.gz");
    let mut builder = tar::Builder::new(GzEncoder::new(
        File::create(&path).unwrap(),
        Compression::fast(),
    ));
    for item in items {
        let (name, kind, data) = match item {
            Item::File(name, data) => (*name, tar::EntryType::Regular, *data),
            Item::Raw(name, kind, data) => (*name, *kind, *data),
        };
        let mut header = tar::Header::new_gnu();
        // Raw name bytes so hostile names reach the extractor unchanged.
        let bytes = name.as_bytes();
        header.as_gnu_mut().unwrap().name[..bytes.len()].copy_from_slice(bytes);
        header.set_entry_type(kind);
        header.set_size(data.len() as u64);
        header.set_mode(0o755);
        header.set_mtime(0);
        if kind == tar::EntryType::Symlink {
            header.set_link_name("/etc/passwd").unwrap();
        }
        header.set_cksum();
        builder.append(&header, data).unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap();
    path
}

const BUILD: &[u8] = br#"{"version":"0.1.45.3","cuda":"13.0"}"#;

fn valid() -> Vec<Item<'static>> {
    vec![
        Item::File("BUILD.json", BUILD),
        Item::File("strata.exe", b"MZ engine"),
        Item::File("cublas64_13.dll", b"dll"),
        Item::File("engine-component.json", b"{}"),
    ]
}

#[test]
fn package_extraction_accepts_a_flat_engine_package() {
    let temp = tempfile::tempdir().unwrap();
    let archive = package(temp.path(), &valid());
    let out = temp.path().join("out");
    let files = extract_package(&archive, &out, u64::MAX, || Ok(())).unwrap();
    assert_eq!(files.len(), 4);
    assert_eq!(fs::read(out.join("strata.exe")).unwrap(), b"MZ engine");
}

#[test]
fn package_extraction_rejects_links_traversal_collisions_and_unknown_files() {
    let cases: Vec<(&str, Vec<Item>)> = vec![
        (
            "symlink",
            vec![Item::Raw("strata-device.exe", tar::EntryType::Symlink, b"")],
        ),
        (
            "hardlink",
            vec![Item::Raw("strata-device.exe", tar::EntryType::Link, b"")],
        ),
        (
            "device",
            vec![Item::Raw("rocm/bin/x.dll", tar::EntryType::Char, b"")],
        ),
        ("traversal", vec![Item::File("../outside.dll", b"x")]),
        ("absolute", vec![Item::File("/tmp/abs.dll", b"x")]),
        ("windows alias", vec![Item::File("rocm/CON.dll", b"x")]),
        (
            "collision",
            vec![
                Item::File("Strata.dll", b"x"),
                Item::File("strata.DLL", b"x"),
            ],
        ),
        ("python", vec![Item::File("serve/server.py", b"x")]),
        ("config", vec![Item::File("config.json", b"{}")]),
    ];
    for (label, extra) in cases {
        let temp = tempfile::tempdir().unwrap();
        let mut items = valid();
        items.extend(extra);
        let archive = package(temp.path(), &items);
        let out = temp.path().join("out");
        assert!(
            extract_package(&archive, &out, u64::MAX, || Ok(())).is_err(),
            "{label}"
        );
        assert!(!temp.path().join("outside.dll").exists());
    }
    // Missing manifest, oversize, and a ZIP renamed to .tar.gz.
    let temp = tempfile::tempdir().unwrap();
    let archive = package(temp.path(), &valid()[..3]);
    assert!(extract_package(&archive, &temp.path().join("a"), u64::MAX, || Ok(())).is_err());
    let archive = package(temp.path(), &valid());
    assert!(extract_package(&archive, &temp.path().join("b"), 8, || Ok(())).is_err());
    fs::write(temp.path().join("fake.tar.gz"), b"PK\x03\x04 not gzip").unwrap();
    assert!(extract_package(
        &temp.path().join("fake.tar.gz"),
        &temp.path().join("c"),
        u64::MAX,
        || Ok(())
    )
    .is_err());
}

#[test]
fn package_files_from_every_0_2_0_platform_pass_the_engine_whitelist() {
    for name in [
        "BUILD.json",
        "engine-component.json",
        "strata.exe",
        "strata-vision.exe",
        "strata-vision-hip.exe",
        "strata-device.exe",
        "strata_kq.dll",
        "cublasLt64_13.dll",
        "rocm/bin/rocblas/library/TensileLibrary_lazy_gfx1100.dat",
        "rocm/licenses/LICENSE",
        "strata",
        "strata-vision",
        "strata-vision-hip",
        "strata-device",
        "libcublas.so.13",
        "libcublasLt.so.13",
        "SYSTEM-LIBS.txt",
        "libLLVM.so.23.0git",
        "libamdhip64.so.7",
        "hipblaslt/library/gfx1151/extop_gfx1151.co",
        "rocblas/library/Kernels.so-000-gfx1151.hsaco",
        // #103: the hipBLASLt tuning table shipped in the official Windows HIP RX 9070 package.
        "tuning/gfx1201-hipblaslt-100500.txt",
        "rocm_kpack.dll",
    ] {
        assert!(engine_file_allowed(name), "{name}");
    }
    for name in [
        "setup.py",
        "serve/server.py",
        "config.json",
        "models/x.gguf",
        "strata.sh",
        "x/libz.so",
    ] {
        assert!(!engine_file_allowed(name), "{name}");
    }
}

#[test]
fn hip_engines_are_classified_by_gpu_family() {
    let cases = [
        (json!({"backend":"hip"}), HIP_MULTI),
        (
            json!({"backend":"hip","archs":["gfx1100","gfx1101","gfx1102","gfx1200","gfx1201","gfx1030","gfx1151"]}),
            HIP_MULTI,
        ),
        (
            json!({"backend":"hip","archs":["gfx1100","gfx1101","gfx1102","gfx1151"]}),
            "hip-rdna3",
        ),
        (
            json!({"backend":"hip","archs":["gfx1200","gfx1201"]}),
            "hip",
        ),
    ];
    for (build, expected) in cases {
        assert_eq!(hip_variant(&build, "windows-x86_64"), expected, "{build}");
    }
    assert!(variant_compatible(HIP_MULTI, "hip") && variant_compatible(HIP_MULTI, "hip-rdna3"));
    assert!(!variant_compatible(HIP_MULTI, "cuda13"));
    assert!(!variant_compatible("hip-rdna3", "hip") && !variant_compatible("hip", "hip-rdna3"));
}

#[test]
fn linux_build_json_samples_map_to_their_packages() {
    let linux = "linux-x86_64";
    let windows = "windows-x86_64";
    // The real Linux hip-halo BUILD.json: no backend, `variant: halo`.
    let halo = json!({"version": "0.1.45.3", "source": "f-amd-vision 18f7b90ca", "variant": "halo", "archs": ["gfx1151"], "portable": true, "vision": "gpu", "vision_cpu": "strata-vision", "vision_gpu": "strata-vision-hip", "vision_archs": ["gfx1151"]});
    assert_eq!(build_variant(&halo, linux), Some("hip-halo"));
    // The same file read with Windows rules: Windows has one RDNA3 package for gfx1151.
    assert_eq!(build_variant(&halo, windows), Some("hip-rdna3"));
    let cases = [
        (
            json!({"version":"0.1.45.3","variant":"rx7900","archs":["gfx1100","gfx1101","gfx1102"]}),
            Some("hip-rx7900"),
        ),
        (
            json!({"version":"0.1.45.3","variant":"rx9070","archs":["gfx1200","gfx1201"]}),
            Some("hip"),
        ),
        (
            json!({"version":"0.1.45.3","variant":"cuda13","cuda":"13.0"}),
            Some("cuda13"),
        ),
        (
            json!({"version":"0.1.45.3","variant":"cuda12","archs":[60,61,89]}),
            Some("cuda12"),
        ),
        // No variant either: gfx archs alone say HIP.
        (
            json!({"version":"0.1.45.3","archs":["gfx1100","gfx1101"]}),
            Some("hip-rx7900"),
        ),
        (
            json!({"version":"0.1.45.3","archs":["gfx1151"]}),
            Some("hip-halo"),
        ),
        (
            json!({"backend":"hip","archs":["gfx1100","gfx1151"]}),
            Some(HIP_MULTI),
        ),
        (json!({"backend":"hip"}), Some(HIP_MULTI)),
        // Windows-style CUDA builds and an unknown local build.
        (
            json!({"version":"0.1.45.3","cuda":"13.0","archs":[75,86,89,120]}),
            Some("cuda13"),
        ),
        (json!({"version":"0.1.41","cuda":12}), Some("cuda12")),
        (json!({"version":"0.1.41","source":"local"}), None),
        (json!({"backend":"metal","version":"0.1.45.3"}), None),
        // A variant Linux does not publish falls back to the other fields.
        (
            json!({"variant":"rdna3","archs":["gfx1100"]}),
            Some("hip-rx7900"),
        ),
    ];
    for (build, expected) in cases {
        assert_eq!(build_variant(&build, linux), expected, "{build}");
    }
    // Windows samples keep their 0.2.0 meaning.
    assert_eq!(
        build_variant(
            &json!({"backend":"hip","archs":["gfx1100","gfx1101","gfx1102","gfx1151"],"lib_dirs":["rocm/bin"]}),
            windows
        ),
        Some("hip-rdna3")
    );
    assert_eq!(
        build_variant(&json!({"version":"0.1.45.3","cuda":"13.0"}), windows),
        Some("cuda13")
    );
    assert!(
        variant_compatible(HIP_MULTI, "hip-halo") && variant_compatible(HIP_MULTI, "hip-rx7900")
    );
    assert!(
        !variant_compatible("hip-halo", "hip-rx7900") && !variant_compatible(HIP_MULTI, "cuda12")
    );
}

fn linux_asset(
    variant: &str,
    upstream: &str,
    archs: &[&str],
    driver: Option<&str>,
) -> RuntimeReleaseAsset {
    let mut asset = release_asset(
        &format!("strata-engine-0.1.45.3-linux-x86_64-{upstream}.tar.gz"),
        variant,
    );
    asset.archs = archs.iter().map(|a| (*a).to_owned()).collect();
    asset.nvidia_min_driver = driver.map(str::to_owned);
    asset
}

fn linux_info() -> RuntimeUpdateInfo {
    RuntimeUpdateInfo {
        assets: vec![
            linux_asset(
                "cuda12",
                "cuda-cuda12",
                &["sm_61", "sm_86", "sm_89", "compute_89"],
                Some("575.51"),
            ),
            linux_asset(
                "cuda13",
                "cuda-cuda13",
                &["sm_75", "sm_86", "sm_89", "sm_120", "compute_120"],
                Some("580.65"),
            ),
            linux_asset("hip-halo", "hip-halo", &["gfx1151"], None),
            linux_asset(
                "hip-rx7900",
                "hip-rx7900",
                &["gfx1100", "gfx1101", "gfx1102"],
                None,
            ),
            linux_asset("hip", "hip-rx9070", &["gfx1200", "gfx1201"], None),
        ],
        ..Default::default()
    }
}

#[test]
fn linux_picks_the_package_by_detected_gpu_unless_the_engine_already_says() {
    let temp = tempfile::tempdir().unwrap();
    let info = linux_info();
    let rtx = || gpu_select::GpuProbe {
        nvidia_driver: Some("580.95.05".into()),
        nvidia_caps: vec![(8, 9)],
        amd_gfx: vec![],
    };
    let halo = || gpu_select::GpuProbe {
        amd_gfx: vec!["gfx1151".into()],
        ..Default::default()
    };
    let nothing = gpu_select::GpuProbe::default;
    // A source install without an engine yet: the GPU decides, with a reason.
    let chosen = choose_asset_with(&info, temp.path(), None, &rtx).unwrap();
    assert_eq!(chosen.variant, "cuda13");
    assert!(chosen.match_reason.unwrap().contains("580.95.05"));
    assert_eq!(
        choose_asset_with(&info, temp.path(), None, &halo)
            .unwrap()
            .variant,
        "hip-halo"
    );
    assert!(choose_asset_with(&info, temp.path(), None, &nothing)
        .unwrap_err()
        .contains("手动选择"));
    // Manual choice always works when nothing is installed.
    let rx7900 = "strata-engine-0.1.45.3-linux-x86_64-hip-rx7900.tar.gz";
    assert_eq!(
        choose_asset_with(&info, temp.path(), Some(rx7900), &nothing)
            .unwrap()
            .variant,
        "hip-rx7900"
    );
    // An installed Linux halo package keeps its type and is never re-detected.
    fs::create_dir_all(temp.path().join("engine")).unwrap();
    fs::write(
        temp.path().join("engine/BUILD.json"),
        br#"{"version":"0.1.45.3","variant":"halo","archs":["gfx1151"]}"#,
    )
    .unwrap();
    let probed = std::cell::Cell::new(false);
    let watch = || {
        probed.set(true);
        rtx()
    };
    let chosen = choose_asset_with(&info, temp.path(), None, &watch).unwrap();
    assert_eq!((chosen.variant.as_str(), probed.get()), ("hip-halo", false));
    assert!(chosen.match_reason.is_none());
    assert!(
        choose_asset_with(&info, temp.path(), Some(rx7900), &nothing)
            .unwrap_err()
            .contains("不匹配")
    );
    // A multi-family local HIP build: only HIP packages, picked by the GPU.
    fs::write(
        temp.path().join("engine/BUILD.json"),
        br#"{"backend":"hip","version":"0.1.41"}"#,
    )
    .unwrap();
    assert_eq!(
        choose_asset_with(&info, temp.path(), None, &halo)
            .unwrap()
            .variant,
        "hip-halo"
    );
    assert!(choose_asset_with(&info, temp.path(), None, &rtx).is_err());
}

fn windows_asset(upstream: &str, variant: &str, archs: &[&str]) -> RuntimeReleaseAsset {
    let mut asset = release_asset(
        &format!("strata-engine-0.1.46-windows-x86_64-{upstream}.tar.gz"),
        variant,
    );
    asset.archs = archs.iter().map(|a| (*a).to_owned()).collect();
    asset
}

/// The four Windows packages of the real v0.2.1 feed.
fn windows_info() -> RuntimeUpdateInfo {
    RuntimeUpdateInfo {
        assets: vec![
            windows_asset(
                "cuda-cuda12",
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
            ),
            windows_asset(
                "cuda-cuda13",
                "cuda13",
                &["sm_75", "sm_86", "sm_89", "sm_120", "compute_120"],
            ),
            windows_asset("hip-rx9070", "hip", &["gfx1200", "gfx1201"]),
            windows_asset(
                "hip-rdna3",
                "hip-rdna3",
                &["gfx1100", "gfx1101", "gfx1102", "gfx1151"],
            ),
        ],
        ..Default::default()
    }
}

#[test]
fn every_file_of_the_official_windows_hip_package_is_allowed() {
    // #103: the v0.2.1 HIP RX 9070 package (830 files, `rocm/` and `tuning/`) was refused.
    let manifest: Value = serde_json::from_slice(include_bytes!(
        "../fixtures/manifest-windows-hip-rx9070.json"
    ))
    .unwrap();
    let files = manifest["files"].as_array().unwrap();
    assert_eq!(files.len(), 830);
    for file in files {
        let path = file["path"].as_str().unwrap();
        assert!(engine_file_allowed(path), "{path}");
    }
}

/// Every file of the 12 signed Strata v0.2.2 engine packages (0.1.47) that Manager's release
/// flow installs passes the allowlist: the HIP packages ship `tuning/*-hipblaslt-*.txt`.
#[test]
fn every_file_of_the_strata_022_engine_packages_is_allowed() {
    let list = include_str!("../fixtures/engine-0.1.47-paths.txt");
    let mut packages = HashSet::new();
    let mut tuning = 0;
    for line in list.lines().filter(|l| !l.starts_with('#')) {
        let (package, path) = line.split_once(' ').unwrap();
        if package.starts_with("macos-") {
            continue; // Metal installs through its own flow.
        }
        packages.insert(package);
        tuning += usize::from(path.starts_with("tuning/"));
        assert!(engine_file_allowed(path), "{package}: {path}");
    }
    assert_eq!(packages.len(), 11);
    assert!(tuning >= 5, "{tuning}");
}

#[test]
fn strata_022_rx6000_packages_are_listed_and_picked_by_gpu() {
    let feed = engine_package::verify_feed(
        include_bytes!("../fixtures/strata-feed-v0.2.2.json"),
        include_bytes!("../fixtures/strata-feed-v0.2.2.json.sig"),
        Some(102),
        now(),
    )
    .unwrap();
    let release: Value =
        serde_json::from_str(include_str!("../fixtures/release-v0.2.2.json")).unwrap();
    let info = |platform| RuntimeUpdateInfo {
        assets: engine_package::feed_assets(&feed, &release, "v0.2.2", platform).unwrap(),
        ..Default::default()
    };
    let (linux, windows) = (info("linux-x86_64"), info("windows-x86_64"));
    let variants = |info: &RuntimeUpdateInfo| {
        info.assets
            .iter()
            .map(|a| a.variant.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        variants(&linux),
        [
            "cuda12",
            "cuda13",
            "hip-halo",
            "hip-rx6000",
            "hip-rx7900",
            "hip"
        ]
    );
    assert_eq!(
        variants(&windows),
        ["cuda12", "cuda13", "hip-rdna2", "hip-rdna3", "hip"]
    );
    let temp = tempfile::tempdir().unwrap();
    let rx6800 = || gpu_select::GpuProbe {
        amd_gfx: vec!["gfx1030".into()],
        ..Default::default()
    };
    let chosen = choose_asset_with(&linux, temp.path(), None, &rx6800).unwrap();
    assert_eq!(
        chosen.name,
        "strata-engine-0.1.47-linux-x86_64-hip-rx6000.tar.gz"
    );
    assert!(chosen.match_reason.unwrap().contains("untested"));
    // Windows first install (no engine yet): an RX 6700 XT gets the RDNA2 package.
    let rx6700 = || gpu_select::GpuProbe {
        amd_gfx: vec!["gfx1031".into()],
        ..Default::default()
    };
    let chosen = choose_asset_with(&windows, temp.path(), None, &rx6700).unwrap();
    assert_eq!(
        chosen.name,
        "strata-engine-0.1.47-windows-x86_64-hip-rdna2.tar.gz"
    );
    // An installed RX 6000 engine is recognised from its BUILD.json and kept.
    for (platform, build, variant) in [
        (
            "linux-x86_64",
            r#"{"version":"0.1.47","variant":"rx6000","archs":["gfx1030","gfx1031"]}"#,
            "hip-rx6000",
        ),
        (
            "windows-x86_64",
            r#"{"backend":"hip","platform":"windows-x64","archs":["gfx1030","gfx1031"]}"#,
            "hip-rdna2",
        ),
    ] {
        let build: Value = serde_json::from_str(build).unwrap();
        assert_eq!(build_variant(&build, platform), Some(variant), "{platform}");
    }
}

#[test]
fn windows_first_install_picks_hip_for_an_amd_only_computer() {
    let temp = tempfile::tempdir().unwrap();
    let info = windows_info();
    // #103: RX 9070 XT (gfx1201) plus the Ryzen iGPU (gfx1036), no NVIDIA driver.
    let rx9070 = || gpu_select::GpuProbe {
        amd_gfx: vec!["gfx1036".into(), "gfx1201".into()],
        ..Default::default()
    };
    let chosen = choose_asset_with(&info, temp.path(), None, &rx9070).unwrap();
    assert_eq!(
        chosen.name,
        "strata-engine-0.1.46-windows-x86_64-hip-rx9070.tar.gz"
    );
    assert!(chosen.match_reason.unwrap().contains("gfx1201"));
    let rx7900 = || gpu_select::GpuProbe {
        amd_gfx: vec!["gfx1100".into()],
        ..Default::default()
    };
    assert_eq!(
        choose_asset_with(&info, temp.path(), None, &rx7900)
            .unwrap()
            .variant,
        "hip-rdna3"
    );
    // An AMD card no package supports asks the user instead of installing CUDA.
    let rx6800 = || gpu_select::GpuProbe {
        amd_gfx: vec!["gfx1030".into()],
        ..Default::default()
    };
    assert!(choose_asset_with(&info, temp.path(), None, &rx6800)
        .unwrap_err()
        .contains("手动选择"));
    // NVIDIA, NVIDIA + AMD, or nothing detected: CUDA 13 as before.
    let rtx = || gpu_select::GpuProbe {
        nvidia_driver: Some("581.57".into()),
        nvidia_caps: vec![(8, 9)],
        amd_gfx: vec![],
    };
    let mixed = || gpu_select::GpuProbe {
        nvidia_driver: Some("581.57".into()),
        nvidia_caps: vec![(8, 9)],
        amd_gfx: vec!["gfx1036".into()],
    };
    for probe in [
        &rtx as &dyn Fn() -> gpu_select::GpuProbe,
        &mixed,
        &gpu_select::GpuProbe::default,
    ] {
        assert_eq!(
            choose_asset_with(&info, temp.path(), None, probe)
                .unwrap()
                .variant,
            "cuda13"
        );
    }
    // An installed engine keeps its type and is never re-detected.
    fs::create_dir_all(temp.path().join("engine")).unwrap();
    fs::write(
        temp.path().join("engine/BUILD.json"),
        br#"{"version":"0.1.46","cuda":"13.0"}"#,
    )
    .unwrap();
    let probed = std::cell::Cell::new(false);
    let watch = || {
        probed.set(true);
        rx9070()
    };
    let chosen = choose_asset_with(&info, temp.path(), None, &watch).unwrap();
    assert_eq!((chosen.variant.as_str(), probed.get()), ("cuda13", false));
}

#[test]
fn windows_first_install_keeps_the_legacy_hip_zip_for_amd() {
    let temp = tempfile::tempdir().unwrap();
    let info = RuntimeUpdateInfo {
        assets: vec![
            release_asset("strata-windows-x64.zip", "cuda13"),
            release_asset("strata-windows-x64-hip.zip", "hip"),
        ],
        ..Default::default()
    };
    let rx9070 = || gpu_select::GpuProbe {
        amd_gfx: vec!["gfx1201".into()],
        ..Default::default()
    };
    assert_eq!(
        choose_asset_with(&info, temp.path(), None, &rx9070)
            .unwrap()
            .name,
        "strata-windows-x64-hip.zip"
    );
}

fn release_asset(name: &str, variant: &str) -> RuntimeReleaseAsset {
    RuntimeReleaseAsset {
        name: name.into(),
        url: format!("https://github.com/Niko1221/Strata/releases/download/v0.2.0-beta/{name}"),
        size: 1,
        sha256: "0".repeat(64),
        variant: variant.into(),
        ..Default::default()
    }
}

#[test]
fn a_legacy_multi_family_hip_install_must_choose_its_0_2_0_package() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir_all(temp.path().join("engine")).unwrap();
    fs::write(
        temp.path().join("engine/BUILD.json"),
        br#"{"backend":"hip","version":"0.1.45"}"#,
    )
    .unwrap();
    let rx9070 = "strata-engine-0.1.45.3-windows-x86_64-hip-rx9070.tar.gz";
    let rdna3 = "strata-engine-0.1.45.3-windows-x86_64-hip-rdna3.tar.gz";
    let info = RuntimeUpdateInfo {
        assets: vec![
            release_asset(
                "strata-engine-0.1.45.3-windows-x86_64-cuda-cuda13.tar.gz",
                "cuda13",
            ),
            release_asset(rx9070, "hip"),
            release_asset(rdna3, "hip-rdna3"),
        ],
        ..Default::default()
    };
    assert!(choose_asset(&info, temp.path(), None)
        .unwrap_err()
        .contains("手动选择"));
    assert_eq!(
        choose_asset(&info, temp.path(), Some(rdna3))
            .unwrap()
            .variant,
        "hip-rdna3"
    );
    assert_eq!(
        choose_asset(&info, temp.path(), Some(rx9070))
            .unwrap()
            .variant,
        "hip"
    );
    assert!(choose_asset(
        &info,
        temp.path(),
        Some("strata-engine-0.1.45.3-windows-x86_64-cuda-cuda13.tar.gz")
    )
    .is_err());
    // A CUDA install keeps choosing its own type automatically.
    fs::write(
        temp.path().join("engine/BUILD.json"),
        br#"{"version":"0.1.45","cuda":"13.0"}"#,
    )
    .unwrap();
    assert_eq!(
        choose_asset(&info, temp.path(), None).unwrap().variant,
        "cuda13"
    );
}

#[test]
fn engine_versions_with_four_parts_and_prereleases_compare_for_downgrades() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir_all(temp.path().join("engine")).unwrap();
    fs::write(
        temp.path().join("engine/BUILD.json"),
        br#"{"version":"0.1.45"}"#,
    )
    .unwrap();
    assert!(prevent_downgrade(temp.path(), "0.1.45.3").is_ok());
    fs::write(
        temp.path().join("engine/BUILD.json"),
        br#"{"version":"0.1.46"}"#,
    )
    .unwrap();
    assert!(prevent_downgrade(temp.path(), "0.1.45.3").is_err());
    assert!(prevent_downgrade(temp.path(), "0.2.0-beta").is_ok());
}

#[test]
fn the_0_2_0_source_keeps_strata_control_and_its_release_archive_name() {
    assert!(source_file("strata_control/procs.py"));
    assert!(source_file("strata_control/update_keys.json"));
    assert!(source_file("strata_cli/__main__.py"));
    assert!(!source_file("desktop/package.json"));
    let prefixes = source_archive_prefixes(&"a".repeat(40), "0.2.0-beta");
    assert!(prefixes.contains(&"Strata-0.2.0-beta/".to_owned()));
    assert!(prefixes.contains(&"Strata-v0.2.0-beta/".to_owned()));
    assert_eq!(source_archive_prefixes(&"a".repeat(40), "../x").len(), 1);
}

#[test]
fn requirements_may_only_shrink_in_place() {
    let old: Vec<String> = ["cmake==4.4.3", "ninja==1.13.2", "numpy==2.3.0"]
        .map(String::from)
        .into();
    assert!(requirements_compatible(&old, &["numpy==2.3.0".into()]));
    assert!(requirements_compatible(&old, &old));
    assert!(!requirements_compatible(&old, &["numpy==2.4.0".into()]));
    assert!(!requirements_compatible(
        &old,
        &["numpy==2.3.0".into(), "rich==1".into()]
    ));
}

/// Runs real downloaded 0.2.0 packages through extraction and signed-manifest checks when
/// `STRATA_020_PACKAGES=/dir` names a folder with them; otherwise it has nothing to check.
#[test]
fn real_0_2_0_packages_extract_and_verify() {
    check_real_packages(
        "STRATA_020_PACKAGES",
        include_bytes!("../fixtures/strata-feed.json"),
        include_bytes!("../fixtures/strata-feed.json.sig"),
        include_str!("../fixtures/release-v0.2.0-beta.json"),
        "v0.2.0-beta",
    );
}

/// The same for Strata v0.2.2 (engine 0.1.47) with `STRATA_022_PACKAGES=/dir`.
#[test]
fn real_0_2_2_packages_extract_and_verify() {
    check_real_packages(
        "STRATA_022_PACKAGES",
        include_bytes!("../fixtures/strata-feed-v0.2.2.json"),
        include_bytes!("../fixtures/strata-feed-v0.2.2.json.sig"),
        include_str!("../fixtures/release-v0.2.2.json"),
        "v0.2.2",
    );
}

fn check_real_packages(env: &str, feed: &[u8], sig: &[u8], release: &str, tag: &str) {
    let Some(dir) = std::env::var_os(env).map(PathBuf::from) else {
        return;
    };
    let feed = engine_package::verify_feed(feed, sig, None, now()).unwrap();
    let release: Value = serde_json::from_str(release).unwrap();
    let mut checked = 0;
    for platform in ["windows-x86_64", "linux-x86_64"] {
        for asset in engine_package::feed_assets(&feed, &release, tag, platform).unwrap() {
            let archive = dir.join(&asset.name);
            if !archive.exists() {
                continue;
            }
            assert_eq!(installation::file_hash(&archive).unwrap(), asset.sha256);
            let temp = tempfile::tempdir().unwrap();
            let out = temp.path().join(ENGINE_WORK_DIR);
            let files =
                extract_package(&archive, &out, asset.installed_bytes.unwrap(), || Ok(())).unwrap();
            engine_package::verify_extracted(&out, &files, &asset, platform, &|| Ok(())).unwrap();
            // A Linux engine runs here: its trial start passes without a GPU (--version).
            if cfg!(all(target_os = "linux", target_arch = "x86_64")) && platform == "linux-x86_64"
            {
                let output = engine_trial::run_engine_version(&out).unwrap();
                let detail =
                    engine_trial::judge(&output).unwrap_or_else(|e| panic!("{}: {e}", asset.name));
                eprintln!("trial start {}: {detail}", asset.name);
            }
            // A single changed byte is caught by the signed manifest.
            let victim = out.join("BUILD.json");
            let mut bytes = fs::read(&victim).unwrap();
            bytes.push(b' ');
            fs::write(&victim, bytes).unwrap();
            assert!(
                engine_package::verify_extracted(&out, &files, &asset, platform, &|| Ok(()))
                    .is_err()
            );
            eprintln!("verified {} ({} files)", asset.name, files.len());
            checked += 1;
        }
    }
    assert!(checked > 0, "no packages found in {}", dir.display());
}
