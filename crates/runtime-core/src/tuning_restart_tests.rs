use super::*;
use crate::tuning::tests::{await_job, live_fixture};

fn full_request(restart: Option<RestartParameters>) -> TuningStartRequest {
    TuningStartRequest {
        scenes: vec![Scene::Chat],
        rounds: 2,
        max_tokens: 1024,
        candidates: Some(vec![Parameters {
            pcie_frac: if restart.is_some() { 0.5 } else { 0.35 },
            spec_min_p: 0.5,
        }]),
        full: FullOptions {
            use_case: Some(UseCase::Chat),
            context_limit: Some(8192),
            include_vision: false,
            restart_candidates: restart.map(|p| vec![p]),
        },
    }
}
fn workers(value: usize) -> RestartParameters {
    RestartParameters {
        pool_workers: Some(value),
        ..Default::default()
    }
}
async fn health(state: &RuntimeState, profile: &ServiceProfile) -> Value {
    http::strata_request(state, profile.clone(), "/health".into(), "GET".into(), None)
        .await
        .unwrap()
}
fn assert_original(profile: &ServiceProfile, original: &[u8]) {
    assert_eq!(fs::read(&profile.config_path).unwrap(), original);
    assert_eq!(
        fs::read(Path::new(&profile.install_dir).join("source-config.json")).unwrap(),
        original
    );
}

#[test]
fn finite_flags_preserve_model_rope_kv_and_legacy_defaults() {
    let config = json!({"exe":"engine","cwd":".","args":["--native","weights.gguf","--max-context","524288","--kv","q4","--rope-scale","4","--prefill=auto:32768","--pool-workers","4"],"env":{"KEEP":"yes"},"sampling":{"temperature":0.7},"mcp":{"servers":[]}});
    let edited = with_restart(
        &config,
        Some(&RestartParameters {
            prefill: Some(32768),
            pool_workers: Some(2),
            ..Default::default()
        }),
    )
    .unwrap();
    for field in ["exe", "cwd", "env", "sampling", "mcp"] {
        assert_eq!(config[field], edited[field]);
    }
    assert_eq!(
        option_value(&edited, "--max-context").unwrap(),
        Some("524288")
    );
    assert_eq!(option_value(&edited, "--kv").unwrap(), Some("q4"));
    assert_eq!(option_value(&edited, "--rope-scale").unwrap(), Some("4"));
    assert_eq!(option_value(&edited, "--prefill").unwrap(), Some("32768"));
    assert!(with_restart(&config, Some(&workers(33))).is_err());
    assert!(with_restart(
        &config,
        Some(&RestartParameters {
            adapt_async: Some(true),
            ..Default::default()
        })
    )
    .is_err());
    assert!(with_restart(
        &config,
        Some(&RestartParameters {
            vram_reserve_mib: Some(256),
            ..Default::default()
        })
    )
    .is_err());
    assert!(serde_json::from_value::<RestartParameters>(json!({"asyncSwap":true})).is_err());
    let legacy: FullReport = serde_json::from_value(json!({})).unwrap();
    assert_eq!(legacy.report_version, 1);
    assert_eq!(legacy.scope, Scope::RequestDiagnostic);
    let request:TuningStartRequest=serde_json::from_value(json!({"useCase":"chat","contextLimit":8192,"maxTokens":1024,"restartCandidates":[{"poolWorkers":2}]})).unwrap();
    assert_eq!(request.scenes.len(), 3);
    assert_eq!(request.full.use_case, Some(UseCase::Chat));
    assert!(check_ram_headroom(
        &config,
        Some(&RestartParameters {
            prefill: Some(32768),
            ..Default::default()
        }),
        3u64 << 30
    )
    .is_err());
    assert!(check_ram_headroom(
        &config,
        Some(&RestartParameters {
            prefill: Some(32768),
            ..Default::default()
        }),
        4u64 << 30
    )
    .is_ok());
}

#[test]
fn adaptive_flags_keep_unrelated_configuration_and_reject_invalid_values() {
    let config = json!({"exe":"engine","args":["--native","weights.gguf","--adapt-decay=0.7","--max-context","524288"],"env":{"KEEP":"yes"}});
    let p = RestartParameters { adapt_every: Some(1), adapt_swaps: Some(160), adapt_decay: Some(0.97), ..Default::default() };
    let edited = with_restart(&config, Some(&p)).unwrap();
    assert_eq!(edited["env"], config["env"]);
    assert_eq!(option_value(&edited, "--max-context").unwrap(), Some("524288"));
    assert_eq!(option_value(&edited, "--adapt-decay").unwrap(), Some("0.97"));
    assert_eq!(baseline(&edited).unwrap().adapt_decay, Some(0.97));
    for bad in [f64::NAN, -0.1, 1.1] {
        assert!(with_restart(&config, Some(&RestartParameters { adapt_decay: Some(bad), ..Default::default() })).is_err());
    }
    assert!(with_restart(&config, Some(&RestartParameters { adapt_every: Some(0), ..Default::default() })).is_err());
    assert!(with_restart(&config, Some(&RestartParameters { adapt_swaps: Some(4097), ..Default::default() })).is_err());
    // Previous integer reports still decode; decimal values survive a round trip.
    let old: VerifiedParameter = serde_json::from_value(json!({"name":"pool_workers","requested":2,"observed":2,"status":"effective"})).unwrap();
    assert_eq!(old.observed, Some(json!(2)));
    let decimal = VerifiedParameter { name:"adapt_decay".into(), requested:json!(0.97), observed:Some(json!(0.97)), status:"effective".into() };
    assert_eq!(serde_json::to_value(decimal).unwrap()["observed"], json!(0.97));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn adaptive_decimal_restart_is_verified_and_baseline_is_restored() {
    let (_temp, state, profile, original) = live_fixture().await;
    start(state.clone(), profile.id.clone(), full_request(Some(RestartParameters { adapt_decay:Some(0.97), ..Default::default() }))).await.unwrap();
    let done = await_job(&state, &profile).await;
    assert_eq!(done.state, Phase::Completed, "{:?}", done.error);
    let parameter = &done.candidates[0].startup_verification.as_ref().unwrap().parameters[0];
    assert_eq!(parameter.name, "adapt_decay");
    assert_eq!(parameter.observed, Some(json!(0.97)));
    assert_eq!(parameter.status, "effective");
    assert_eq!(read_metrics(&state, &profile).await.unwrap()["engine"]["adapt_decay"], json!(0.7));
    assert_original(&profile, &original);
    assert!(done.full.recovery.configuration_restored && done.full.recovery.service_verified);
    crate::stop_service(&state, profile.id.clone()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unpublished_adaptive_values_require_the_exact_owned_engine_argv() {
    for argv_available in [false, true] {
        let (_temp, state, profile, original) = live_fixture().await;
        fs::write(Path::new(&profile.install_dir).join("unknown-effective-adaptive"), b"fixture").unwrap();
        if argv_available { fs::write(Path::new(&profile.install_dir).join("adaptive-argv-fixture"), b"fixture").unwrap(); }
        start(state.clone(), profile.id.clone(), full_request(Some(RestartParameters { adapt_decay:Some(0.97), ..Default::default() }))).await.unwrap();
        let done = await_job(&state, &profile).await;
        if argv_available {
            assert_eq!(done.state, Phase::Completed, "{:?}", done.error);
            let parameter = &done.candidates[0].startup_verification.as_ref().unwrap().parameters[0];
            assert_eq!(parameter.observed, None);
            assert_eq!(parameter.requested, json!(0.97));
            assert_eq!(parameter.status, "startupRequest");
        } else {
            assert_eq!(done.state, Phase::Failed);
            assert!(done.error.as_deref().unwrap_or_default().contains("启动参数不可核验"));
        }
        assert_original(&profile, &original);
        assert!(done.full.recovery.configuration_restored && done.full.recovery.service_verified);
        crate::stop_service(&state, profile.id.clone()).await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn full_request_aba_has_semantic_coverage_and_public_apply_restore() {
    let (_temp, state, profile, original) = live_fixture().await;
    let started = start(state.clone(), profile.id.clone(), full_request(None))
        .await
        .unwrap();
    assert_eq!(started.total_requests, 48);
    let done = await_job(&state, &profile).await;
    assert_eq!(done.state, Phase::Completed, "{:?}", done.error);
    assert_eq!(done.full.progress.completed_workloads, 24);
    assert_eq!(done.full.workload_measurements.len(), 24);
    assert_eq!(done.completed_requests, 48);
    assert!(done.measurements.is_empty());
    assert!(done
        .full
        .workload_measurements
        .iter()
        .all(|m| m.result["qualityPassed"] == true));
    assert!(done
        .full
        .workload_measurements
        .iter()
        .filter(|m| m.kind == WorkloadKind::ColdInput)
        .all(|m| m.freshly_loaded && m.result["coldModelVerified"] == true));
    assert_eq!(
        done.recommended_candidate_id.as_deref(),
        Some("candidate-1")
    );
    assert_original(&profile, &original);
    // A historical safe resource sample does not permit applying after other
    // applications occupy current system/GPU headroom.
    let pressure = Path::new(&profile.install_dir).join("resource-pressure");
    fs::write(&pressure, b"isolated").unwrap();
    assert!(apply(state.clone(), done.id.clone(), "candidate-1".into())
        .await
        .err()
        .unwrap()
        .contains("安全余量"));
    fs::remove_file(&pressure).unwrap();
    assert_original(&profile, &original);
    let applied = apply(state.clone(), done.id.clone(), "candidate-1".into())
        .await
        .unwrap();
    assert_eq!(applied.state, Phase::Applied, "{:?}", applied.error);
    assert_eq!(applied.full.recovery.state, RecoveryState::NotNeeded);
    assert!(!applied.full.recovery.configuration_restored);
    assert!(applied.full.recovery.service_verified);
    let restored = restore(state.clone(), done.id).await.unwrap();
    assert_eq!(restored.state, Phase::Restored);
    assert_eq!(restored.full.recovery.state, RecoveryState::Restored);
    assert!(
        restored.full.recovery.configuration_restored && restored.full.recovery.service_verified
    );
    assert_original(&profile, &original);
    crate::stop_service(&state, profile.id.clone())
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn failed_apply_and_failed_rollback_publish_only_this_transactions_verified_flags() {
    for external_edit in [false, true] {
        let (_temp, state, profile, original) = live_fixture().await;
        let source_path = Path::new(&profile.install_dir).join("serve/server.py");
        let source = fs::read_to_string(&source_path)
            .unwrap()
            .replace("\r\n", "\n");
        let needle = "            if self.path in (\"/load\", \"/v1/load\"):\n";
        assert_eq!(source.matches(needle).count(), 1);
        // Only the copied CPU fixture is extended, before the identity-bound
        // measurement. Production source and imported files are untouched.
        let replacement = r#"            if self.path in ("/load", "/v1/load"):
                if Path(config["cwd"]).joinpath("reject-all-loads").exists():
                    self.respond({"error": {"code": "isolated_load_failure"}}, 500)
                    return
                if abs(pcie - 0.35) < 0.001 and Path(config["cwd"]).joinpath("edit-on-apply").exists():
                    Path(args.config).write_text('{"isolated_external_edit":true}', encoding="utf-8")
                    self.respond({"error": {"code": "isolated_load_failure"}}, 500)
                    return
"#;
        fs::write(&source_path, source.replace(needle, replacement)).unwrap();
        start(state.clone(), profile.id.clone(), full_request(None))
            .await
            .unwrap();
        let done = await_job(&state, &profile).await;
        assert_eq!(done.state, Phase::Completed, "{:?}", done.error);
        assert!(done.full.recovery.configuration_restored && done.full.recovery.service_verified);
        assert_eq!(
            done.recommended_candidate_id.as_deref(),
            Some("candidate-1")
        );
        let marker = if external_edit {
            "edit-on-apply"
        } else {
            "reject-all-loads"
        };
        fs::write(
            Path::new(&profile.install_dir).join(marker),
            b"isolated CPU fault",
        )
        .unwrap();
        let failed = apply(state.clone(), done.id, "candidate-1".into())
            .await
            .unwrap();
        assert_eq!(failed.state, Phase::Failed);
        assert_eq!(failed.full.recovery.state, RecoveryState::Failed);
        assert!(!failed.full.recovery.service_verified);
        assert_eq!(failed.full.recovery.configuration_restored, !external_edit);
        assert!(failed.full.recovery.error.is_some());
        assert!(
            !status(&state, profile.id.clone())
                .unwrap()
                .unwrap()
                .full
                .recovery
                .service_verified
        );
        if external_edit {
            assert_eq!(
                fs::read(&profile.config_path).unwrap(),
                br#"{"isolated_external_edit":true}"#
            );
        } else {
            assert_original(&profile, &original);
            assert_eq!(health(&state, &profile).await["loaded"], false);
        }
        assert_eq!(
            fs::read(Path::new(&profile.install_dir).join("source-config.json")).unwrap(),
            original
        );
        crate::stop_service(&state, profile.id.clone())
            .await
            .unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn restart_workers_aba_verifies_actual_flags_and_restores_baseline() {
    let (_temp, state, profile, original) = live_fixture().await;
    let before = require_owned(&state, &profile).await.unwrap();
    start(
        state.clone(),
        profile.id.clone(),
        full_request(Some(workers(2))),
    )
    .await
    .unwrap();
    let done = await_job(&state, &profile).await;
    assert_eq!(done.state, Phase::Completed, "{:?}", done.error);
    assert_ne!(require_owned(&state, &profile).await.unwrap(), before);
    assert_eq!(
        read_metrics(&state, &profile).await.unwrap()["engine"]["pool_workers"],
        4
    );
    assert_original(&profile, &original);
    assert_eq!(done.recommended_candidate_id.as_deref(), Some("restart-1"));
    assert_eq!(
        done.candidates[0]
            .startup_verification
            .as_ref()
            .unwrap()
            .parameters[0]
            .observed,
        Some(json!(2))
    );
    let applied = apply(state.clone(), done.id.clone(), "restart-1".into())
        .await
        .unwrap();
    assert_eq!(applied.state, Phase::Applied, "{:?}", applied.error);
    assert_eq!(
        read_metrics(&state, &profile).await.unwrap()["engine"]["pool_workers"],
        2
    );
    assert_eq!(
        restore(state.clone(), done.id).await.unwrap().state,
        Phase::Restored
    );
    assert_original(&profile, &original);
    assert_eq!(
        read_metrics(&state, &profile).await.unwrap()["engine"]["pool_workers"],
        4
    );
    crate::stop_service(&state, profile.id.clone())
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn candidate_load_failure_restores_original_bytes_and_loaded_service() {
    let (_temp, state, profile, original) = live_fixture().await;
    fs::write(
        Path::new(&profile.install_dir).join("reject-restart"),
        b"isolated",
    )
    .unwrap();
    start(
        state.clone(),
        profile.id.clone(),
        full_request(Some(workers(3))),
    )
    .await
    .unwrap();
    let done = await_job(&state, &profile).await;
    assert_eq!(done.state, Phase::Failed);
    assert!(done.error.as_deref().unwrap().contains("加载"));
    assert_eq!(done.full.recovery.state, RecoveryState::Restored);
    assert!(done.full.recovery.configuration_restored && done.full.recovery.service_verified);
    assert_original(&profile, &original);
    assert_eq!(health(&state, &profile).await["loaded"], true);
    assert!(!state
        .data_dir()
        .join("analytics")
        .join(format!("{}.maintenance", profile.id))
        .exists());
    crate::stop_service(&state, profile.id.clone())
        .await
        .unwrap();
}

async fn wait_candidate(profile: &ServiceProfile) {
    let path = Path::new(&profile.install_dir).join("full-in-flight");
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if fs::read_to_string(&path).ok().as_deref() == Some("2") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "candidate did not enter isolated request"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancellation_during_candidate_does_not_cancel_baseline_recovery() {
    let (_temp, state, profile, original) = live_fixture().await;
    fs::write(
        Path::new(&profile.install_dir).join("slow-full"),
        b"isolated",
    )
    .unwrap();
    let started = start(
        state.clone(),
        profile.id.clone(),
        full_request(Some(workers(2))),
    )
    .await
    .unwrap();
    wait_candidate(&profile).await;
    cancel(&state, started.id).unwrap();
    let done = await_job(&state, &profile).await;
    assert_eq!(done.state, Phase::Canceled, "{:?}", done.error);
    assert_eq!(done.full.recovery.state, RecoveryState::Restored);
    assert!(done.full.recovery.configuration_restored && done.full.recovery.service_verified);
    assert_original(&profile, &original);
    assert_eq!(health(&state, &profile).await["loaded"], true);
    crate::stop_service(&state, profile.id.clone())
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn recovery_failure_is_persisted_and_never_overwrites_external_edit() {
    let (_temp, state, profile, original) = live_fixture().await;
    fs::write(
        Path::new(&profile.install_dir).join("slow-full"),
        b"isolated",
    )
    .unwrap();
    let started = start(
        state.clone(),
        profile.id.clone(),
        full_request(Some(workers(2))),
    )
    .await
    .unwrap();
    wait_candidate(&profile).await;
    let user_edit = b"{\"user\":\"unrelated new settings\"}";
    fs::write(&profile.config_path, user_edit).unwrap();
    cancel(&state, started.id.clone()).unwrap();
    let done = await_job(&state, &profile).await;
    assert_eq!(done.state, Phase::Failed);
    assert_eq!(done.full.recovery.state, RecoveryState::Failed);
    assert!(done.error.unwrap().contains("恢复失败"));
    assert!(done.full.recovery.error.unwrap().contains("外部编辑"));
    assert_eq!(fs::read(&profile.config_path).unwrap(), user_edit);
    assert_eq!(
        fs::read(Path::new(&profile.install_dir).join("source-config.json")).unwrap(),
        original
    );
    assert!(!load_journal(&state, &started.id).unwrap().unwrap().restored);
    crate::stop_service(&state, profile.id.clone())
        .await
        .unwrap();
}

async fn interrupted_stage() -> (
    tempfile::TempDir,
    Arc<RuntimeState>,
    ServiceProfile,
    Vec<u8>,
    String,
) {
    let (temp, state, profile, original) = live_fixture().await;
    let metrics = read_metrics(&state, &profile).await.unwrap();
    let config: Value = serde_json::from_slice(&original).unwrap();
    let parameters = baseline_parameters(&metrics).unwrap();
    let request = full_request(Some(workers(2)));
    let mut candidates = vec![];
    let full = prepare_report(&request, &config, &metrics, parameters, &mut candidates).unwrap();
    let mut job:TuningJob=serde_json::from_value(json!({"id":uuid::Uuid::new_v4().to_string(),"profileId":profile.id,"state":"running","scenes":["chat"],"rounds":2,"maxTokens":1024,"startedAt":now(),"updatedAt":now(),"completedRequests":0,"totalRequests":48,"currentStep":"candidate","baseline":parameters,"candidates":candidates,"measurements":[],"recommendedCandidateId":null,"identity":{},"configFingerprint":fingerprint(&original),"notes":[]})).unwrap();
    job.full = full;
    job.identity = bound_identity(&profile, &config, &metrics, &job);
    persist(&state, &job).unwrap();
    atomic_bytes(
        &report_dir(&state).join(format!("{}.original", job.id)),
        &original,
    )
    .unwrap();
    let target =
        serde_json::to_vec_pretty(&with_restart(&config, Some(&workers(2))).unwrap()).unwrap();
    journal(
        &state,
        &Journal {
            job_id: job.id.clone(),
            profile: profile.clone(),
            original_sha256: fingerprint(&original),
            target_sha256: fingerprint(&target),
            previous_sha256: None,
            restored: false,
        },
    )
    .unwrap();
    crate::stop_service(&state, profile.id.clone())
        .await
        .unwrap();
    atomic_bytes(Path::new(&profile.config_path), &target).unwrap();
    (temp, state, profile, original, job.id)
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn startup_recovers_running_temporary_stage_and_verifies_original_service() {
    let (_temp, state, profile, original, id) = interrupted_stage().await;
    registry().lock().unwrap().remove(state.data_dir());
    let reopened = RuntimeState::open(state.data_dir().to_owned()).unwrap();
    let done = await_job(&reopened, &profile).await;
    assert_eq!(done.state, Phase::Interrupted, "{:?}", done.error);
    assert_eq!(done.full.recovery.state, RecoveryState::Restored);
    assert!(done.full.recovery.configuration_restored && done.full.recovery.service_verified);
    assert_original(&profile, &original);
    assert_eq!(health(&reopened, &profile).await["loaded"], true);
    assert!(load_journal(&reopened, &id).unwrap().unwrap().restored);
    crate::stop_service(&reopened, profile.id.clone())
        .await
        .unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn startup_refuses_unowned_config_hash_after_interruption() {
    let (_temp, state, profile, _original, _id) = interrupted_stage().await;
    let user_edit = b"{\"user\":\"changed outside the journal\"}";
    fs::write(&profile.config_path, user_edit).unwrap();
    assert!(recover_pending(&state).unwrap_err().contains("另行编辑"));
    assert_eq!(fs::read(&profile.config_path).unwrap(), user_edit);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn candidate_oom_restores_exact_baseline_and_marks_measurement_failed() {
    let (_temp, state, profile, original) = live_fixture().await;
    fs::write(
        Path::new(&profile.install_dir).join("oom-candidate"),
        b"isolated",
    )
    .unwrap();
    start(
        state.clone(),
        profile.id.clone(),
        full_request(Some(workers(2))),
    )
    .await
    .unwrap();
    let done = await_job(&state, &profile).await;
    assert_eq!(done.state, Phase::Failed, "{:?}", done.error);
    assert_eq!(
        done.full.recovery.state,
        RecoveryState::Restored,
        "{:?}",
        done.error
    );
    assert!(done.full.recovery.configuration_restored && done.full.recovery.service_verified);
    assert_original(&profile, &original);
    assert_eq!(health(&state, &profile).await["loaded"], true);
    crate::stop_service(&state, profile.id.clone())
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn async_requested_without_effective_state_is_never_recommended() {
    let (_temp, state, profile, bytes) = live_fixture().await;
    crate::stop_service(&state, profile.id.clone())
        .await
        .unwrap();
    let mut config: Value = serde_json::from_slice(&bytes).unwrap();
    config["args"]
        .as_array_mut()
        .unwrap()
        .push(json!("--resident-experts"));
    let original = serde_json::to_vec_pretty(&config).unwrap();
    fs::write(&profile.config_path, &original).unwrap();
    fs::write(
        Path::new(&profile.install_dir).join("source-config.json"),
        &original,
    )
    .unwrap();
    fs::write(
        Path::new(&profile.install_dir).join("unknown-effective-async"),
        b"isolated",
    )
    .unwrap();
    crate::start_service(state.clone(), profile.clone())
        .await
        .unwrap();
    verify_restarted(
        &state,
        &profile,
        &uuid::Uuid::new_v4().to_string(),
        Parameters {
            pcie_frac: 0.5,
            spec_min_p: 0.5,
        },
    )
    .await
    .unwrap();
    start(
        state.clone(),
        profile.id.clone(),
        full_request(Some(RestartParameters {
            adapt_async: Some(true),
            ..Default::default()
        })),
    )
    .await
    .unwrap();
    let done = await_job(&state, &profile).await;
    assert_eq!(done.state, Phase::Failed);
    assert!(done.recommended_candidate_id.is_none());
    assert!(done.error.unwrap().contains("有效状态"));
    assert_eq!(done.full.recovery.state, RecoveryState::Restored);
    assert_original(&profile, &original);
    crate::stop_service(&state, profile.id.clone())
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn overall_deadline_cancels_measurement_but_not_independent_recovery() {
    let (_temp, state, profile, original, id) = interrupted_stage().await;
    atomic_bytes(Path::new(&profile.config_path), &original).unwrap();
    crate::start_service(state.clone(), profile.clone())
        .await
        .unwrap();
    verify_restarted(
        &state,
        &profile,
        &uuid::Uuid::new_v4().to_string(),
        Parameters {
            pcie_frac: 0.5,
            spec_min_p: 0.5,
        },
    )
    .await
    .unwrap();
    let mut job = read_job(&state, &id).unwrap();
    job.state = Phase::Running;
    assert_eq!(job.full.limits.max_duration_seconds, 7200);
    assert_eq!(job.full.limits.generation_request_limit, 48);
    assert_eq!(job.full.limits.output_token_upper_bound, 49152);
    register_active(&state, &job, CancellationToken::new()).unwrap();
    let pid = require_owned(&state, &profile).await.unwrap();
    let parent_cancel = CancellationToken::new();
    let error = run_full_bounded(
        state.clone(),
        profile.clone(),
        pid,
        id.clone(),
        parent_cancel.clone(),
        Duration::from_millis(200),
        Duration::from_secs(10),
    )
    .await
    .unwrap_err();
    assert!(error.contains("任务总时限"), "{error}");
    assert!(!parent_cancel.is_cancelled());
    let done = read_job(&state, &id).unwrap();
    assert!(done.recommended_candidate_id.is_none());
    assert_eq!(done.full.recovery.state, RecoveryState::Restored);
    assert!(done.full.recovery.configuration_restored && done.full.recovery.service_verified);
    assert!(load_journal(&state, &id).unwrap().unwrap().restored);
    assert_original(&profile, &original);
    assert_eq!(health(&state, &profile).await["loaded"], true);
    crate::stop_service(&state, profile.id.clone())
        .await
        .unwrap();
    registry().lock().unwrap().remove(state.data_dir());
}

#[test]
fn full_gain_uses_measured_noise_without_fixed_percent_threshold() {
    let make = |round, position, wall| WorkloadMeasurement {
        id: uuid::Uuid::new_v4().to_string(),
        candidate_id: "test".into(),
        round,
        position,
        workload_id: "short".into(),
        kind: WorkloadKind::ColdInput,
        freshly_loaded: true,
        result: json!({"qualityPassed":true,"complete":true,"wallMs":wall+9000.,"turns":[{"wallMs":wall}]}),
    };
    let samples = (0..2)
        .flat_map(|round| {
            [
                make(round, Position::BaselineBefore, 100.),
                make(round, Position::Candidate, 98.),
                make(round, Position::BaselineAfter, 100.1),
            ]
        })
        .collect::<Vec<_>>();
    let result = evaluate_workload(&samples, "test", "short", 2);
    assert!(result.accepted);
    assert!(result.gain.unwrap() < 0.03);
    let drift_samples = (0..2)
        .flat_map(|round| {
            [
                make(round, Position::BaselineBefore, 90.),
                make(round, Position::Candidate, 98.),
                make(round, Position::BaselineAfter, 110.),
            ]
        })
        .collect::<Vec<_>>();
    assert!(!evaluate_workload(&drift_samples, "test", "short", 2).accepted);
}

#[test]
fn rejected_long_context_tier_cannot_be_hidden_by_lower_passing_gain() {
    let evaluation = |gain, drift, accepted| Evaluation {
        gain: Some(gain),
        drift: Some(drift),
        pairs: 2,
        accepted,
        reason: "isolated-measured-tier".into(),
    };
    let passing_short = evaluation(0.04, 0.01, true);
    let noisy_long = evaluation(0.09, 0.12, false);
    assert!(worse_dimension(&noisy_long, &passing_short));
    assert!(!worse_dimension(&passing_short, &noisy_long));
    let slower_pass = evaluation(0.02, 0.001, true);
    assert!(worse_dimension(&slower_pass, &passing_short));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unknown_or_insufficient_resources_prevent_recommendation_and_apply() {
    let (_temp, state, profile, original) = live_fixture().await;
    for (marker, status) in [
        ("unknown-resources", ResourceStatus::Unknown),
        ("resource-pressure", ResourceStatus::InsufficientHeadroom),
    ] {
        let path = Path::new(&profile.install_dir).join(marker);
        fs::write(&path, b"isolated").unwrap();
        start(state.clone(), profile.id.clone(), full_request(None))
            .await
            .unwrap();
        let done = await_job(&state, &profile).await;
        assert_eq!(done.state, Phase::Completed, "{:?}", done.error);
        assert!(done.recommended_candidate_id.is_none());
        assert_eq!(
            done.candidates[0]
                .resource_assessment
                .as_ref()
                .unwrap()
                .status,
            status
        );
        assert!(!done.candidates[0].evaluation.as_ref().unwrap().accepted);
        assert!(apply(state.clone(), done.id.clone(), "candidate-1".into())
            .await
            .is_err());
        assert_original(&profile, &original);
        fs::remove_file(path).unwrap();
    }
    crate::stop_service(&state, profile.id.clone())
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn startup_recovers_apply_phase_even_if_journal_was_already_settled() {
    let (_temp, state, profile, original, id) = interrupted_stage().await;
    let mut job = read_job(&state, &id).unwrap();
    job.state = Phase::Applying;
    job.applied_config_fingerprint = Some(fingerprint(&fs::read(&profile.config_path).unwrap()));
    persist(&state, &job).unwrap();
    let mut stage = load_journal(&state, &id).unwrap().unwrap();
    stage.restored = true;
    journal(&state, &stage).unwrap();
    let reopened = RuntimeState::open(state.data_dir().to_owned()).unwrap();
    let done = await_job(&reopened, &profile).await;
    assert_eq!(done.state, Phase::Interrupted, "{:?}", done.error);
    assert!(done.full.recovery.configuration_restored && done.full.recovery.service_verified);
    assert_original(&profile, &original);
    assert_eq!(health(&reopened, &profile).await["loaded"], true);
    crate::stop_service(&reopened, profile.id.clone())
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn restore_crash_before_or_after_config_write_recovers_previous_owned_hash() {
    for after_write in [false, true] {
        let (_temp, state, profile, original, id) = interrupted_stage().await;
        let current = fs::read(&profile.config_path).unwrap();
        let mut job = read_job(&state, &id).unwrap();
        job.state = Phase::RollingBack;
        job.applied_config_fingerprint = Some(fingerprint(&current));
        persist(&state, &job).unwrap();
        begin_application(&state, &job, &profile, &current, &original).unwrap();
        if after_write {
            atomic_bytes(Path::new(&profile.config_path), &original).unwrap();
        }
        let reopened = RuntimeState::open(state.data_dir().to_owned()).unwrap();
        let done = await_job(&reopened, &profile).await;
        assert_eq!(done.state, Phase::Interrupted, "{:?}", done.error);
        assert!(done.full.recovery.configuration_restored && done.full.recovery.service_verified);
        assert_original(&profile, &original);
        assert_eq!(health(&reopened, &profile).await["loaded"], true);
        crate::stop_service(&reopened, profile.id.clone())
            .await
            .unwrap();
    }
}
