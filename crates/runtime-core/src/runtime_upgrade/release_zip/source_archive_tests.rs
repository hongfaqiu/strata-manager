//! Official same-revision source ZIP: URL pin, cache reuse, identity, no UI.
use super::*;
use crate::processes::TaskRecord;
use std::io::Cursor;

const REVISION: &str = "0123456789abcdef0123456789abcdef01234567";

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

#[test]
fn official_source_url_accepts_codeload_and_the_github_archive_redirect() {
    let canonical = format!("https://codeload.github.com/Niko1221/Strata/zip/{REVISION}");
    let github = format!("https://github.com/Niko1221/Strata/archive/{REVISION}.zip");
    assert_eq!(
        official_source_archive_url(&canonical, REVISION).unwrap(),
        canonical
    );
    assert_eq!(
        official_source_archive_url(&github, REVISION).unwrap(),
        canonical
    );
    assert!(official_source_archive_url(&canonical, "not-a-revision").is_err());
    assert!(official_source_archive_url(
        "https://evil.example/Niko1221/Strata/zip/{REVISION}",
        REVISION
    )
    .is_err());
    assert!(
        official_source_archive_url(&format!("https://gh-proxy.org/{canonical}"), REVISION)
            .is_err()
    );
}

#[test]
fn publish_source_archive_keeps_a_matching_cache_and_rejects_the_wrong_prefix() {
    let temp = tempfile::tempdir().unwrap();
    let state = RuntimeState::open(temp.path().join("data")).unwrap();
    let id = task(&state);
    let directory = installation::owned_directory(state.data_dir(), &["downloads"]).unwrap();
    let good = zip(&[(&format!("Strata-{REVISION}/README.md"), "official source")]);
    let tag = zip(&[("Strata-1.0.0/README.md", "release page source")]);
    let bad = zip(&[("Strata-deadbeef/README.md", "wrong revision")]);

    let good_path = directory.join("incoming-good.download");
    fs::write(&good_path, &good).unwrap();
    let cached =
        publish_source_archive(&state, &id, &good_path, "GitHub", REVISION, "1.0.0").unwrap();
    let digest = installation::file_hash(&cached).unwrap();
    assert_eq!(
        cached.file_name().unwrap(),
        format!("source-{REVISION}-{digest}.zip").as_str()
    );
    assert_eq!(fs::read(&cached).unwrap(), good);
    assert!(!good_path.exists());

    assert_eq!(
        cached_source_archive(&directory, REVISION, "1.0.0")
            .unwrap()
            .as_deref(),
        Some(cached.as_path())
    );

    let tag_path = directory.join("incoming-tag.download");
    fs::write(&tag_path, &tag).unwrap();
    let tagged =
        publish_source_archive(&state, &id, &tag_path, "GitHub", REVISION, "1.0.0").unwrap();
    assert_ne!(tagged, cached);
    assert!(source_archive_revision(&tagged, REVISION, "1.0.0").is_ok());

    let bad_path = directory.join("incoming-bad.download");
    fs::write(&bad_path, &bad).unwrap();
    let error =
        publish_source_archive(&state, &id, &bad_path, "GitHub", REVISION, "1.0.0").unwrap_err();
    assert!(error.contains("不是当前官方 Release 的源码"));
    assert!(!bad_path.exists());
}
