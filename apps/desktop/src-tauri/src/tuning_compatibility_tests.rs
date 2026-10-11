use super::*;
use std::fs;
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

struct StopFixture(CancellationToken);
impl Drop for StopFixture { fn drop(&mut self) { self.0.cancel(); } }

#[tokio::test]
async fn config_revision_requests_never_fall_back_on_old_supervisors() {
    let directory = tempfile::tempdir().unwrap(); let data = directory.path().join("data"); fs::create_dir_all(&data).unwrap();
    let client = SupervisorClient::new(data.clone(), directory.path().into());
    client.staged.set((directory.path().join("must-not-execute.exe"), "fixture-new".into())).unwrap();
    let calls = Arc::new(Mutex::new(Vec::new())); let recorded = calls.clone();
    let token = CancellationToken::new(); let _stop = StopFixture(token.clone()); let server_token = token.clone(); let server_data = data.clone();
    let server = tokio::spawn(async move {
        strata_local_ipc::serve(&server_data, server_token, move |request| {
            let recorded = recorded.clone(); async move {
                recorded.lock().unwrap().push(request.method.clone());
                if request.method == "hello" { Ok(json!({"running":true,"protocolVersion":1,"version":"fixture-old","executableHash":"fixture-old","activeServices":1})) }
                else { Err(RpcError::new("unknown_method", request.method)) }
            }
        }).await
    });
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while strata_local_ipc::call(&data, "hello", json!({})).await.is_err() { assert!(tokio::time::Instant::now() < deadline); tokio::time::sleep(Duration::from_millis(10)).await; }
    for method in ["read_config_snapshot_v1", "write_config_cas_v1"] {
        assert_eq!(client.request(method, json!({"profile":{},"config":{},"expectedRevision":"0".repeat(64)})).await.unwrap_err().code, "SUPERVISOR_CAPABILITY_REQUIRED");
    }
    assert!(calls.lock().unwrap().iter().all(|method| matches!(method.as_str(), "hello" | "read_config_snapshot_v1" | "write_config_cas_v1")));
    token.cancel(); tokio::time::timeout(Duration::from_secs(5), server).await.unwrap().unwrap().unwrap();
}

#[tokio::test]
async fn full_tuning_never_falls_back_on_old_or_replaced_supervisors() {
    for scenario in 0..3 {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("data");
        fs::create_dir_all(&data).unwrap();
        let client = SupervisorClient::new(data.clone(), directory.path().into());
        client.staged.set((directory.path().join("must-not-execute.exe"), "fixture-new".into())).unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let recorded = calls.clone();
        let token = CancellationToken::new();
        let _stop = StopFixture(token.clone());
        let server_data = data.clone();
        let server_token = token.clone();
        let server = tokio::spawn(async move {
            strata_local_ipc::serve(&server_data, server_token, move |request| {
                let recorded = recorded.clone();
                async move {
                    recorded.lock().unwrap().push((request.method.clone(), request.params.clone()));
                    match request.method.as_str() {
                        "hello" | "supervisor_status" => {
                            let mut status = json!({"running":true,"protocolVersion":1,"version":"fixture-old","executableHash":"fixture-old","activeServices":1});
                            if scenario > 0 { status["capabilities"] = json!({"fullScenarioTuning":1}); }
                            Ok(status)
                        }
                        "tuning_start_full_v1" if scenario == 1 => Err(RpcError::new("unknown_method", "fixture replaced by old supervisor")),
                        "tuning_start_full_v1" => Ok(request.params),
                        _ => Err(RpcError::new("unexpected_fixture_mutation", request.method)),
                    }
                }
            }).await
        });
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while strata_local_ipc::call(&data, "hello", json!({})).await.is_err() {
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        calls.lock().unwrap().clear();
        let params = json!({"profileId":"fixture-model","request":{"useCase":"agent","contextLimit":8192,"restartCandidates":[{"poolWorkers":4}]}});
        let result = client.request("tuning_start", params.clone()).await;
        if scenario < 2 { assert_eq!(result.unwrap_err().code, "SUPERVISOR_CAPABILITY_REQUIRED"); }
        else { assert_eq!(result.unwrap(), params); }
        let recorded = calls.lock().unwrap().clone();
        assert!(recorded.iter().all(|(method, _)| matches!(method.as_str(), "hello" | "tuning_start_full_v1")));
        let mutations: Vec<_> = recorded.iter().filter(|(method, _)| method == "tuning_start_full_v1").collect();
        assert_eq!(mutations.len(), usize::from(scenario > 0));
        if scenario > 0 { assert_eq!(mutations[0].1, params); }
        token.cancel();
        tokio::time::timeout(Duration::from_secs(5), server).await.unwrap().unwrap().unwrap();
    }
}
