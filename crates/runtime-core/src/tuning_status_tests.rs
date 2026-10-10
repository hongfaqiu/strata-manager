use super::*;

fn profile(state: &RuntimeState) -> ServiceProfile {
    let profile = ServiceProfile {
        id: "isolated-status".into(),
        name: "Isolated report history".into(),
        base_url: "http://127.0.0.1:1".into(),
        install_dir: state
            .data_dir()
            .join("unused-runtime")
            .to_string_lossy()
            .into(),
        config_path: state
            .data_dir()
            .join("unused-config.json")
            .to_string_lossy()
            .into(),
        python_path: "unused-python".into(),
        managed: true,
    };
    state
        .database
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO local_installations VALUES(?1,?2,?3,?4)",
            rusqlite::params![
                profile.id,
                serde_json::to_string(&profile).unwrap(),
                serde_json::to_string(&profile).unwrap(),
                0
            ],
        )
        .unwrap();
    profile
}

fn job(profile_id: &str, started: u64, state: Phase) -> TuningJob {
    serde_json::from_value(json!({
        "id":uuid::Uuid::new_v4().to_string(),"profileId":profile_id,"state":state,
        "scenes":["chat"],"rounds":2,"maxTokens":128,"startedAt":started,"updatedAt":started,
        "completedRequests":0,"totalRequests":1,"currentStep":"isolated-history",
        "baseline":{"pcieFrac":0.5,"specMinP":0.5},"candidates":[],"measurements":[],
        "identity":{},"configFingerprint":"unused-history","notes":[]
    }))
    .unwrap()
}

#[test]
fn active_registry_wins_and_latest_history_survives_mixed_files_and_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let mut state = RuntimeState::open(temp.path().join("data")).unwrap();
    let profile = profile(&state);
    fs::create_dir_all(report_dir(&state)).unwrap();
    // Original backups, temporary files and non-report JSON must not count as
    // a directory-prefix limit hiding the most recent real report.
    for index in 0..1005 {
        let suffix = match index % 3 {
            0 => "original",
            1 => "tmp",
            _ => "json",
        };
        fs::write(
            report_dir(&state).join(format!("auxiliary-{index}.{suffix}")),
            b"{}",
        )
        .unwrap();
    }
    let older = job(&profile.id, 100, Phase::Completed);
    let recent = job(&profile.id, 200, Phase::Completed);
    let other = job("another-profile", 9999, Phase::Completed);
    for job in [&older, &recent, &other] {
        persist(&state, job).unwrap();
    }
    assert_eq!(
        status(&state, profile.id.clone()).unwrap().unwrap().id,
        recent.id
    );
    // Simulate the first upgrade from versions without a persistent index.
    state
        .database
        .lock()
        .unwrap()
        .execute("DROP TABLE tuning_report_index", [])
        .unwrap();
    state
        .database
        .lock()
        .unwrap()
        .execute("DROP TABLE tuning_report_orders", [])
        .unwrap();
    drop(state);
    state = RuntimeState::open(temp.path().join("data")).unwrap();
    assert_eq!(
        status(&state, profile.id.clone()).unwrap().unwrap().id,
        recent.id
    );
    // Even a clock going backward cannot hide an active task behind a newer
    // completed report. Removing its index row proves registry is authority.
    let active = job(&profile.id, 1, Phase::Running);
    register_active(&state, &active, CancellationToken::new()).unwrap();
    state
        .database
        .lock()
        .unwrap()
        .execute(
            "DELETE FROM tuning_report_index WHERE job_id=?1",
            [&active.id],
        )
        .unwrap();
    assert_eq!(
        status(&state, profile.id.clone()).unwrap().unwrap().id,
        active.id
    );
    update(&state, &active.id, |job| job.state = Phase::Failed).unwrap();
    assert_eq!(
        status(&state, profile.id.clone()).unwrap().unwrap().id,
        active.id
    );
    registry().lock().unwrap().remove(state.data_dir());
    drop(state);
    let reopened = RuntimeState::open(temp.path().join("data")).unwrap();
    assert_eq!(
        status(&reopened, profile.id.clone()).unwrap().unwrap().id,
        active.id
    );
    // The report is durable but its visibility index was not published.
    // The separately reserved order survives this crash window.
    let interrupted_publication = job(&profile.id, 0, Phase::Completed);
    persist(&reopened, &interrupted_publication).unwrap();
    reopened
        .database
        .lock()
        .unwrap()
        .execute(
            "DELETE FROM tuning_report_index WHERE job_id=?1",
            [&interrupted_publication.id],
        )
        .unwrap();
    drop(reopened);
    let reopened = RuntimeState::open(temp.path().join("data")).unwrap();
    assert_eq!(
        status(&reopened, profile.id).unwrap().unwrap().id,
        interrupted_publication.id
    );
}

#[test]
fn indexed_reports_bind_uuid_profile_and_bounded_file_contents() {
    let temp = tempfile::tempdir().unwrap();
    let state = RuntimeState::open(temp.path().into()).unwrap();
    let profile = profile(&state);
    let valid = job(&profile.id, 200, Phase::Completed);
    persist(&state, &valid).unwrap();
    let path = report_path(&state, &valid.id).unwrap();
    fs::write(&path, vec![b' '; MAX_REPORT_BYTES + 1]).unwrap();
    assert!(status(&state, profile.id.clone())
        .err()
        .unwrap()
        .contains("大小限制"));
    let wrong = job(&profile.id, 200, Phase::Completed);
    fs::write(&path, serde_json::to_vec(&wrong).unwrap()).unwrap();
    assert!(status(&state, profile.id.clone())
        .err()
        .unwrap()
        .contains("标识不一致"));
    assert!(report_path(&state, "../outside").is_err());
    state
        .database
        .lock()
        .unwrap()
        .execute("UPDATE tuning_report_index SET job_id='../outside'", [])
        .unwrap();
    assert!(status(&state, profile.id)
        .err()
        .unwrap()
        .contains("任务标识"));
}

#[test]
fn registration_is_atomic_with_runtime_operations_without_queued_late_jobs() {
    let temp = tempfile::tempdir().unwrap();
    let state = RuntimeState::open(temp.path().into()).unwrap();
    let profile = profile(&state);
    let job = job(&profile.id, 1, Phase::Running);
    let operation = state.runtime_operations.lock().unwrap();
    assert!(register_active(&state, &job, CancellationToken::new())
        .err()
        .unwrap()
        .contains("未登记调优任务"));
    assert!(status(&state, profile.id.clone()).unwrap().is_none());
    assert!(!report_path(&state, &job.id).unwrap().exists());
    drop(operation);
    register_active(&state, &job, CancellationToken::new()).unwrap();
    assert_eq!(
        status(&state, profile.id.clone()).unwrap().unwrap().id,
        job.id
    );
    // Once registered, global operations see this active task and must reject.
    let _operation = state.runtime_operations.lock().unwrap();
    assert!(assert_available(&state).is_err());
    registry().lock().unwrap().remove(state.data_dir());
}
