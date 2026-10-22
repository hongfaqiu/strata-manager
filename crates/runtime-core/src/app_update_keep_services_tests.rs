use super::*;

fn running_service(state: &RuntimeState) -> ServiceProfile {
    // Nothing listens on port 1, so the strict path cannot verify an idle API.
    let profile = ServiceProfile {
        id: "app-update-keep".into(),
        name: "Running service".into(),
        base_url: "http://127.0.0.1:1".into(),
        install_dir: state.data_dir().join("unused").to_string_lossy().into(),
        config_path: state
            .data_dir()
            .join("unused.json")
            .to_string_lossy()
            .into(),
        python_path: "unused-python".into(),
        managed: true,
    };
    // A CPU-only owned process stands in for the engine.
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
    let mut owned = OwnedProcess::spawn(command, state.logs.clone(), &profile.id).unwrap();
    owned.profile = Some(profile.clone());
    state
        .processes
        .lock()
        .unwrap()
        .insert(profile.id.clone(), owned);
    profile
}

fn still_running(state: &RuntimeState, id: &str) -> bool {
    state
        .processes
        .lock()
        .unwrap()
        .get_mut(id)
        .map(|p| p.refresh().unwrap().running)
        .unwrap_or(false)
}

#[tokio::test]
async fn desktop_update_keeps_running_services_without_draining_them() {
    let directory = tempfile::tempdir().unwrap();
    let state = RuntimeState::open(directory.path().to_owned()).unwrap();
    let profile = running_service(&state);

    // Legacy callers (`{}`) keep the strict idle verification.
    let strict = state
        .clone()
        .dispatch("prepare_app_update", json!({}))
        .await;
    assert!(
        strict.is_err(),
        "unverifiable API must block the strict path"
    );
    assert!(!directory.path().join("backups").exists());
    assert!(still_running(&state, &profile.id));

    // The desktop updater only replaces UI files; the engine keeps serving.
    state
        .clone()
        .dispatch("prepare_app_update", json!({"keepServices": true}))
        .await
        .unwrap();
    assert!(still_running(&state, &profile.id));
    assert!(state.processes.lock().unwrap().contains_key(&profile.id));
    assert!(directory
        .path()
        .join("backups")
        .read_dir()
        .unwrap()
        .next()
        .is_some());
    state.cleanup();
}
