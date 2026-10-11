use super::*;
use crate::processes::TaskRecord;

#[tokio::test]
async fn failed_close_intent_write_preserves_state_and_allows_retry() {
    let directory = tempfile::tempdir().unwrap();
    let state = RuntimeState::open(directory.path().to_owned()).unwrap();
    store_set(&state, "localServiceDesired".into(), json!(true)).unwrap();
    store_set(&state, "conversations".into(), json!([{"title":"saved"}])).unwrap();
    state
        .database
        .lock()
        .unwrap()
        .execute_batch("PRAGMA query_only=ON")
        .unwrap();
    assert!(state.clone().prepare_window_close().await.is_err());
    assert!(!state.shutting_down.load(Ordering::Acquire));
    assert_eq!(
        store_get(&state, "localServiceDesired".into()).unwrap(),
        json!(true)
    );
    assert_eq!(
        store_get(&state, "conversations".into()).unwrap(),
        json!([{"title":"saved"}])
    );
    state
        .database
        .lock()
        .unwrap()
        .execute_batch("PRAGMA query_only=OFF")
        .unwrap();
    state.clone().prepare_window_close().await.unwrap();
    assert!(state.shutting_down.load(Ordering::Acquire));
    assert_eq!(
        store_get(&state, "localServiceDesired".into()).unwrap(),
        json!(false)
    );
}

#[tokio::test]
async fn closing_without_background_cancels_owned_work_and_keeps_saved_data() {
    let directory = tempfile::tempdir().unwrap();
    let state = RuntimeState::open(directory.path().to_owned()).unwrap();
    store_set(&state, "settings".into(), json!({"closeToTray":false})).unwrap();
    store_set(&state, "conversations".into(), json!([{"title":"saved"}])).unwrap();
    store_set(&state, "localServiceDesired".into(), json!(true)).unwrap();
    // A CPU-only owned process, with no port or real model configuration.
    let mut command = if cfg!(windows) {
        Command::new("powershell.exe")
    } else {
        Command::new("sh")
    };
    if cfg!(windows) {
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 60",
        ]);
    } else {
        command.args(["-c", "sleep 60"]);
    }
    let owned = OwnedProcess::spawn(command, state.logs.clone(), "closing-test").unwrap();
    state
        .processes
        .lock()
        .unwrap()
        .insert("closing-test".into(), owned);
    state.tasks.lock().unwrap().insert(
        "closing-task".into(),
        TaskRecord {
            status: TaskStatus {
                id: "closing-task".into(),
                kind: "setup".into(),
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
    tokio::time::timeout(
        Duration::from_secs(10),
        state.clone().prepare_window_close(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(state.processes.lock().unwrap().is_empty());
    assert_eq!(
        state.tasks.lock().unwrap()["closing-task"].status.state,
        "cancelled"
    );
    assert_eq!(
        store_get(&state, "localServiceDesired".into()).unwrap(),
        json!(false)
    );
    assert_eq!(
        store_get(&state, "conversations".into()).unwrap(),
        json!([{"title":"saved"}])
    );
    drop(state);
    let reopened = RuntimeState::open(directory.path().to_owned()).unwrap();
    assert_eq!(
        store_get(&reopened, "conversations".into()).unwrap(),
        json!([{"title":"saved"}])
    );
    assert_eq!(
        store_get(&reopened, "localServiceDesired".into()).unwrap(),
        json!(false)
    );
}
