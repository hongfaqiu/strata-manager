use super::*;

#[tokio::test]
async fn config_cas_rejects_same_bytes_at_a_different_registered_target() {
    let directory = tempfile::tempdir().unwrap(); let state = RuntimeState::open(directory.path().to_owned()).unwrap();
    let first = directory.path().join("first.json"); let second = directory.path().join("second.json");
    for path in [&first, &second] { std::fs::write(path, b"{\"port\":8080}").unwrap(); }
    let profile = json!({"id":"moving-config","name":"fixture","baseUrl":"http://127.0.0.1:19009","installDir":directory.path(),"pythonPath":"","configPath":first,"managed":true});
    state.database.lock().unwrap().execute("INSERT INTO local_installations(id,profile,original_profile,imported_at) VALUES(?1,?2,?2,0)", rusqlite::params!["moving-config",profile.to_string()]).unwrap();
    let snapshot = state.clone().dispatch("read_config_snapshot_v1", json!({"profile":profile})).await.unwrap();
    let mut moved = profile.clone(); moved["configPath"] = json!(second);
    state.database.lock().unwrap().execute("UPDATE local_installations SET profile=?1 WHERE id='moving-config'", [moved.to_string()]).unwrap();
    let error = state.clone().dispatch("write_config_cas_v1", json!({"profile":profile,"config":{"port":8081},"expectedRevision":snapshot["revision"]})).await.unwrap_err();
    assert!(error.starts_with("PROFILE_CONFIG_CHANGED:"));
    for path in [&first, &second] { assert_eq!(std::fs::read(path).unwrap(), b"{\"port\":8080}"); }
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().filter_map(Result::ok).filter(|item| item.path().extension().is_some_and(|ext| ext == "bak")).count(),0);
}

#[tokio::test]
async fn config_cas_rpc_requires_original_revision_and_respects_lifecycle_gates() {
    let directory = tempfile::tempdir().unwrap(); let state = RuntimeState::open(directory.path().to_owned()).unwrap();
    let path = directory.path().join("config.json"); std::fs::write(&path, b"{\"port\":8080}").unwrap();
    let profile = json!({"id":"config-fixture","name":"fixture","baseUrl":"http://127.0.0.1:19009","installDir":directory.path(),"pythonPath":"","configPath":path,"managed":true});
    let snapshot = state.clone().dispatch("read_config_snapshot_v1", json!({"profile":profile})).await.unwrap();
    assert_eq!(snapshot["config"]["port"],8080);
    assert!(state.clone().dispatch("write_config_cas_v1", json!({"profile":profile,"config":{"port":8081}})).await.unwrap_err().contains("expectedRevision"));
    let request = json!({"profile":profile,"config":{"port":8081},"expectedRevision":snapshot["revision"]});
    state.selection_changing.store(true, Ordering::Release);
    assert!(state.clone().dispatch("write_config_cas_v1", request.clone()).await.is_err()); state.selection_changing.store(false, Ordering::Release);
    let saved = state.clone().dispatch("write_config_cas_v1", request.clone()).await.unwrap(); assert_ne!(saved["revision"],snapshot["revision"]);
    assert!(state.clone().dispatch("write_config_cas_v1", request).await.unwrap_err().contains("CONFIG_REVISION_CONFLICT"));
    state.shutting_down.store(true, Ordering::Release);
    assert!(state.clone().dispatch("write_config_cas_v1", json!({"profile":profile,"config":{"port":8082},"expectedRevision":saved["revision"]})).await.is_err());
    assert_eq!(storage::read(&serde_json::from_value(profile).unwrap()).unwrap()["port"],8081);
}

#[tokio::test]
async fn full_rpc_rejects_missing_or_invalid_use_case_and_respects_lifecycle_gates() {
    let directory = tempfile::tempdir().unwrap();
    let state = RuntimeState::open(directory.path().to_owned()).unwrap();
    assert_eq!(state.status().unwrap()["capabilities"]["fullScenarioTuning"], 1);
    for request in [json!({"scenes":["chat"]}), json!({"useCase":"unsupported"})] {
        let error = state.clone().dispatch("tuning_start_full_v1", json!({"profileId":"unregistered-fixture","request":request})).await.unwrap_err();
        assert!(error.contains("useCase") || error.contains("unsupported"));
    }
    let full = json!({"profileId":"unregistered-fixture","request":{"useCase":"chat"}});
    state.selection_changing.store(true, Ordering::Release);
    assert!(state.clone().dispatch("tuning_start_full_v1", full.clone()).await.unwrap_err().contains("切换"));
    state.selection_changing.store(false, Ordering::Release);
    state.shutting_down.store(true, Ordering::Release);
    assert!(state.clone().dispatch("tuning_start_full_v1", full).await.unwrap_err().contains("退出"));
    assert!(!directory.path().join("tuning-v1").exists());
}
