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
        "SYSTEM-LIBS.txt",
        "libLLVM.so.23.0git",
        "libamdhip64.so.7",
        "hipblaslt/library/gfx1151/extop_gfx1151.co",
        "rocblas/library/Kernels.so-000-gfx1151.hsaco",
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
        assert_eq!(hip_variant(&build), expected, "{build}");
    }
    assert!(variant_compatible(HIP_MULTI, "hip") && variant_compatible(HIP_MULTI, "hip-rdna3"));
    assert!(!variant_compatible(HIP_MULTI, "cuda13"));
    assert!(!variant_compatible("hip-rdna3", "hip") && !variant_compatible("hip", "hip-rdna3"));
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
    let Some(dir) = std::env::var_os("STRATA_020_PACKAGES").map(PathBuf::from) else {
        return;
    };
    let feed = engine_package::verify_feed(
        include_bytes!("../fixtures/strata-feed.json"),
        include_bytes!("../fixtures/strata-feed.json.sig"),
        None,
        now(),
    )
    .unwrap();
    let release: Value =
        serde_json::from_str(include_str!("../fixtures/release-v0.2.0-beta.json")).unwrap();
    let mut checked = 0;
    for platform in ["windows-x86_64", "linux-x86_64"] {
        for asset in engine_package::feed_assets(&feed, &release, "v0.2.0-beta", platform).unwrap()
        {
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
