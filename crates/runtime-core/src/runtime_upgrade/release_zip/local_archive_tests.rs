//! First-run installation from already-downloaded archives (Windows release flow).
use super::*;
use crate::processes::TaskRecord;
use std::io::Cursor;

const REVISION: &str = "0123456789abcdef0123456789abcdef01234567";

fn task(state: &RuntimeState) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    state.tasks.lock().unwrap().insert(
        id.clone(),
        TaskRecord {
            status: TaskStatus {
                id: id.clone(),
                kind: "install".into(),
                state: "running".into(),
                message: String::new(),
                started_at: now(),
                finished_at: None,
            },
            profile_id: None,
            runtime_path: None,
            cancelled: false,
            process: None,
        },
    );
    id
}

fn zip(entries: &[(&str, &str)]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, body) in entries {
        writer
            .start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(body.as_bytes()).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

fn asset(name: &str, variant: &str, bytes: &[u8]) -> RuntimeReleaseAsset {
    RuntimeReleaseAsset {
        name: name.into(),
        url: format!("https://github.com/Niko1221/Strata/releases/download/v1.0.0/{name}"),
        size: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(bytes)),
        variant: variant.into(),
        ..Default::default()
    }
}

fn info(assets: Vec<RuntimeReleaseAsset>) -> RuntimeUpdateInfo {
    RuntimeUpdateInfo {
        checked_at: now(),
        supported_version: "1.0.0".into(),
        supported_revision: REVISION.into(),
        latest_version: Some("1.0.0".into()),
        release_name: None,
        release_url: None,
        notes: None,
        published_at: None,
        assets,
        dsv41_assets: Vec::new(),
        source_revision: Some(REVISION.into()),
        source_archive_url: Some(format!(
            "https://codeload.github.com/Niko1221/Strata/zip/{REVISION}"
        )),
        update_available: true,
        installable: true,
        error: None,
        feed_sequence: None,
    }
}

#[test]
fn local_source_archive_requires_the_release_revision_and_keeps_the_original() {
    let temp = tempfile::tempdir().unwrap();
    let state = RuntimeState::open(temp.path().join("state")).unwrap();
    let id = task(&state);
    let prefix = format!("Strata-{REVISION}");
    let good = temp.path().join("Strata.zip");
    let bytes = zip(&[
        (&format!("{prefix}/setup.py"), "setup"),
        (&format!("{prefix}/serve/server.py"), "server"),
    ]);
    fs::write(&good, &bytes).unwrap();
    let cached = local_source_archive(&state, &id, &good, REVISION, "1.0.0").unwrap();
    assert_eq!(fs::read(&cached).unwrap(), bytes);
    assert_eq!(fs::read(&good).unwrap(), bytes);
    assert!(cached
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with(&format!("source-{REVISION}-")));
    // Another revision, a mixed archive, or a non-ZIP file is refused with a clear error.
    for (name, bytes) in [
        (
            "other.zip",
            zip(&[(
                "Strata-ffffffffffffffffffffffffffffffffffffffff/setup.py",
                "x",
            )]),
        ),
        (
            "mixed.zip",
            zip(&[(&format!("{prefix}/setup.py"), "x"), ("extra.txt", "x")]),
        ),
        ("text.zip", b"not a zip".to_vec()),
    ] {
        let path = temp.path().join(name);
        fs::write(&path, bytes).unwrap();
        let error = local_source_archive(&state, &id, &path, REVISION, "1.0.0").unwrap_err();
        assert!(error.contains("Strata 安装包"), "{error}");
    }
}

#[test]
fn local_source_archive_accepts_release_tag_named_prefix() {
    let temp = tempfile::tempdir().unwrap();
    let state = RuntimeState::open(temp.path().join("state")).unwrap();
    let id = task(&state);
    // GitHub Release "Source code (zip)" uses Strata-<tag>/, not Strata-<commit>/.
    for prefix in ["Strata-1.0.0", "Strata-v1.0.0"] {
        let path = temp.path().join(format!("{prefix}.zip"));
        let bytes = zip(&[
            (&format!("{prefix}/setup.py"), "setup"),
            (&format!("{prefix}/serve/server.py"), "server"),
        ]);
        fs::write(&path, &bytes).unwrap();
        let cached = local_source_archive(&state, &id, &path, REVISION, "1.0.0").unwrap();
        assert_eq!(fs::read(&cached).unwrap(), bytes);
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    // A different version tag must still be refused.
    let wrong = temp.path().join("Strata-9.9.9.zip");
    fs::write(
        &wrong,
        zip(&[
            ("Strata-9.9.9/setup.py", "x"),
            ("Strata-9.9.9/serve/server.py", "x"),
        ]),
    )
    .unwrap();
    let error = local_source_archive(&state, &id, &wrong, REVISION, "1.0.0").unwrap_err();
    assert!(error.contains("Strata 安装包"), "{error}");
}

#[test]
fn extract_engine_writes_nested_rocm_paths_without_tempfile_persist() {
    let temp = tempfile::tempdir().unwrap();
    let archive = temp.path().join("engine.zip");
    // Mimic HIP-Style nesting that previously failed persist on Windows (#62).
    let deep = "rocm/bin/hipblaslt/library/gfx1201/TensileLibrary_sample.dat.zlib";
    let bytes = zip(&[
        ("BUILD.json", r#"{"version":"1.0.0"}"#),
        ("strata.exe", "exe"),
        (deep, "kernel-bytes"),
        ("amdhip64_7.dll", "dll"),
    ]);
    fs::write(&archive, bytes).unwrap();
    let dest = temp.path().join("e");
    let files = extract(&archive, &dest, false, || Ok(())).unwrap();
    assert!(files.iter().any(|f| f == deep));
    assert_eq!(fs::read_to_string(dest.join(deep)).unwrap(), "kernel-bytes");
    assert!(dest.join("strata.exe").is_file());
}

#[test]
fn engine_build_is_read_from_the_directory_the_engine_was_extracted_to() {
    // #65: v0.2.2 extracted into `<work>/e` but still read `<work>/engine/BUILD.json`,
    // failing every install/update with "os error 3" right after extraction.
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("work");
    fs::create_dir(&work).unwrap();
    let archive = temp.path().join("engine.zip");
    let deep = "rocm/bin/hipblaslt/library/gfx1100/TensileLibrary_sample.dat.zlib";
    fs::write(
        &archive,
        zip(&[
            ("BUILD.json", r#"{"version":"0.1.45"}"#),
            ("strata.exe", "exe"),
            (deep, "kernel-bytes"),
        ]),
    )
    .unwrap();
    extract(&archive, &engine_work_dir(&work), false, || Ok(())).unwrap();
    let build = read_engine_build(&work).unwrap();
    assert_eq!(build["version"].as_str(), Some("0.1.45"));
    assert!(!work.join("engine").exists());
}

#[test]
fn local_engine_archive_selects_the_official_asset_by_digest() {
    let temp = tempfile::tempdir().unwrap();
    let state = RuntimeState::open(temp.path().join("state")).unwrap();
    let id = task(&state);
    let cuda13 = b"cuda13 engine".to_vec();
    let cuda12 = b"cuda12 engine".to_vec();
    let release = info(vec![
        asset("strata-windows-x64.zip", "cuda13", &cuda13),
        asset("strata-windows-x64-cuda12.zip", "cuda12", &cuda12),
    ]);
    let local = temp.path().join("downloaded-engine.zip");
    fs::write(&local, &cuda12).unwrap();
    let selected = local_engine_asset(&state, &id, &release, &local).unwrap();
    assert_eq!(selected.name, "strata-windows-x64-cuda12.zip");
    // Same length, different bytes (an older version or a damaged file).
    fs::write(&local, b"cuda12 enginf").unwrap();
    let error = local_engine_asset(&state, &id, &release, &local).unwrap_err();
    assert!(error.contains("v1.0.0"), "{error}");
    fs::write(&local, b"short").unwrap();
    assert!(local_engine_asset(&state, &id, &release, &local).is_err());
}

#[test]
fn install_options_accept_a_local_engine_without_an_asset_but_updates_do_not() {
    let temp = tempfile::tempdir().unwrap();
    let local = temp.path().join("engine.zip");
    fs::write(&local, b"zip").unwrap();
    let archives = installation::LocalRuntimeArchives {
        strata_archive_path: Some(format!("  {}  ", local.display())),
        engine_archive_path: None,
    }
    .validate()
    .unwrap();
    assert_eq!(
        archives.strata_archive_path.as_deref(),
        Some(local.to_string_lossy().as_ref())
    );
    let missing = installation::LocalRuntimeArchives {
        strata_archive_path: Some(temp.path().join("missing.zip").to_string_lossy().into()),
        engine_archive_path: None,
    };
    assert!(missing.validate().is_err());
    // The update flow keeps requiring an explicit official asset for a local engine ZIP.
    assert!(RuntimeZipDownloadOptions {
        local_archive_path: Some(local.to_string_lossy().into()),
        download_url: None,
        target_version: None,
        source: None,
    }
    .validate(None)
    .is_err());
}
