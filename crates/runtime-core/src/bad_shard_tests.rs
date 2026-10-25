use super::*;
use crate::processes::{log, register_task_logs, TaskRecord};
use std::fs;

const SHARD: &str = "Qwen-00004-of-00006.gguf";

fn failed_task(
    state: &RuntimeState,
    id: &str,
    task_state: &str,
    directory: Option<&Path>,
    lines: &str,
) {
    register_task_logs(&state.logs, id).unwrap();
    log(&state.logs, id, "stderr", lines);
    state.tasks.lock().unwrap().insert(
        id.into(),
        TaskRecord {
            status: types::TaskStatus {
                id: id.into(),
                kind: "setup".into(),
                state: task_state.into(),
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
    if let Some(directory) = directory {
        state
            .task_model_dirs
            .lock()
            .unwrap()
            .insert(id.into(), directory.to_owned());
    }
}

fn accusation(name: &str) -> String {
    format!("  [X]  {name} does not match the published file (SHA-256 a, expected b)\n       your file was left as it is")
}

#[test]
fn a_failed_task_deletes_only_the_shard_its_log_accuses() {
    let temp = tempfile::tempdir().unwrap();
    let models = temp.path().join("models");
    fs::create_dir(&models).unwrap();
    for name in [SHARD, &format!("{SHARD}.done"), "other-00001-of-00006.gguf"] {
        fs::write(models.join(name), b"x").unwrap();
    }
    let state = RuntimeState::open(temp.path().join("data")).unwrap();
    failed_task(&state, "t1", "failed", Some(&models), &accusation(SHARD));

    let found = task_bad_shard(&state, "t1").unwrap().unwrap();
    assert_eq!(found.file_name, SHARD);
    assert_eq!(Path::new(&found.path), models.join(SHARD));

    // Another file in the same folder, even a real one, is not what the log accused.
    assert!(delete_bad_shard(&state, "t1", "other-00001-of-00006.gguf").is_err());
    assert!(models.join("other-00001-of-00006.gguf").exists());
    assert!(delete_bad_shard(&state, "t1", "../data/strata-manager.sqlite3").is_err());

    let removed = delete_bad_shard(&state, "t1", SHARD).unwrap();
    assert_eq!(removed.removed.len(), 2);
    assert!(models.join("other-00001-of-00006.gguf").exists());
    assert!(!models.join(SHARD).exists());
}

#[test]
fn nothing_is_deleted_unless_the_task_failed_in_gguf_dir_mode_on_a_kept_file() {
    let temp = tempfile::tempdir().unwrap();
    let models = temp.path().join("models");
    fs::create_dir(&models).unwrap();
    fs::write(models.join(SHARD), b"x").unwrap();
    let state = RuntimeState::open(temp.path().join("data")).unwrap();
    failed_task(
        &state,
        "running",
        "running",
        Some(&models),
        &accusation(SHARD),
    );
    failed_task(&state, "no-dir", "failed", None, &accusation(SHARD));
    failed_task(
        &state,
        "network",
        "failed",
        Some(&models),
        "  [X]  cannot reach huggingface.co (timed out)",
    );
    for id in ["running", "no-dir", "network", "unknown"] {
        assert_eq!(task_bad_shard(&state, id).unwrap(), None, "{id}");
        assert!(delete_bad_shard(&state, id, SHARD).is_err(), "{id}");
    }
    assert!(models.join(SHARD).exists());
}
