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

async fn stable_request_fixture() -> (
    tempfile::TempDir,
    Arc<RuntimeState>,
    ServiceProfile,
    Vec<u8>,
) {
    let fixture = live_fixture().await;
    let (_, state, profile, _) = &fixture;
    crate::stop_service(state, profile.id.clone())
        .await
        .unwrap();
    let source_path = Path::new(&profile.install_dir).join("serve/server.py");
    let source = fs::read_to_string(&source_path).unwrap();
    let delay = "time.sleep(.004 if workers == 2 or abs(requested_pcie - .35) < .001 else .035)";
    assert_eq!(source.matches(delay).count(), 1);
    // Only these private fixtures use slower responses to allow actual HTTP
    // resource sampling. Their real wall times remain in the measured report;
    // transaction prerequisites use a separate, explicitly synthetic report.
    // Shared failure/no-gain fixtures and production gates remain unchanged.
    fs::write(
        &source_path,
        source.replace(
            delay,
            "time.sleep(.050 if workers == 2 or abs(requested_pcie - .35) < .001 else .300)",
        ),
    )
    .unwrap();
    crate::start_service(state.clone(), profile.clone())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if http::strata_request(state, profile.clone(), "/health".into(), "GET".into(), None)
                .await
                .is_ok()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("private stable CPU fixture must become ready within five seconds");
    http::strata_request(
        state,
        profile.clone(),
        "/load".into(),
        "POST".into(),
        Some(json!({})),
    )
    .await
    .unwrap();
    let metrics = read_metrics(state, profile).await.unwrap();
    assert_eq!(metrics["hardware"]["ram_total"], json!(64u64 << 30));
    assert_eq!(metrics["hardware"]["ram_used"], json!(32u64 << 30));
    assert_eq!(metrics["hardware"]["gpu_mem_total"], json!(16u64 << 30));
    assert_eq!(metrics["hardware"]["gpu_mem_used"], json!(8u64 << 30));
    check_live_resources(&metrics).unwrap();
    fixture
}

fn request_report_diagnostics(job: &TuningJob) -> String {
    let candidates = job
        .candidates
        .iter()
        .map(|candidate| {
            json!({"id":candidate.id,"evaluation":candidate.evaluation,
            "resources":candidate.resource_assessment,"dimensions":candidate.dimensions})
        })
        .collect::<Vec<_>>();
    let measurements = job.full.workload_measurements.iter().map(|measurement| {
        let walls = measurement.result["turns"].as_array().map(|turns| {
            turns.iter().map(|turn| &turn["wallMs"]).collect::<Vec<_>>()
        });
        json!({"round":measurement.round,"position":measurement.position,
            "workload":measurement.workload_id,"kind":measurement.kind,
            "complete":measurement.result["complete"],"qualityPassed":measurement.result["qualityPassed"],
            "qualityReason":measurement.result["qualityReason"],
            "timingSource":measurement.result["timingSource"],
            "sourceMeasuredJobId":measurement.result["sourceMeasuredJobId"],
            "resources":measurement.result["resourcePeak"],"wallMs":walls})
    }).collect::<Vec<_>>();
    json!({"jobId":job.id,"notes":job.notes,"state":job.state,"error":job.error,"ramTotal":job.identity["ramTotal"],
        "gpuMemoryTotal":job.identity["gpuMemoryTotal"],"candidates":candidates,
        "measurements":measurements})
    .to_string()
}

fn assert_request_fixture_evidence(job: &TuningJob) {
    let diagnostic = request_report_diagnostics(job);
    let resource = job.candidates[0]
        .resource_assessment
        .as_ref()
        .unwrap_or_else(|| panic!("missing resource assessment: {diagnostic}"));
    assert_eq!(resource.status, ResourceStatus::Checked, "{diagnostic}");
    assert!(resource.sample_count > 0, "{diagnostic}");
    assert_eq!(resource.ram_peak_bytes, Some(32u64 << 30), "{diagnostic}");
    assert_eq!(resource.gpu_peak_bytes, Some(8u64 << 30), "{diagnostic}");
    assert!(
        job.full.workload_measurements.iter().all(|measurement| {
            measurement.result["complete"] == true && measurement.result["qualityPassed"] == true
        }),
        "{diagnostic}"
    );
    assert!(
        job.full
            .workload_measurements
            .iter()
            .filter(|measurement| measurement.position == Position::Candidate)
            .all(|measurement| {
                let peak = &measurement.result["resourcePeak"];
                peak["sampleCount"].as_u64().unwrap_or(0) > 0
                    && peak["dataScope"] == "systemAndPrimaryGpu"
                    && peak["ramUsedBytes"] == json!(32u64 << 30)
                    && peak["gpuMemoryUsedBytes"] == json!(8u64 << 30)
            }),
        "{diagnostic}"
    );
}

fn evaluated_fixture_candidate(job: &TuningJob) -> Result<Candidate, String> {
    if job.candidates.len() != 1 {
        return Err("transaction fixture requires exactly one candidate".into());
    }
    let mut candidate = job.candidates[0].clone();
    let specs = workloads::plan(&options(&job.full, job.max_tokens)?)?;
    let mut dimensions = HashMap::new();
    for spec in &specs {
        let evaluation = evaluate_workload(
            &job.full.workload_measurements,
            &candidate.id,
            &spec.id,
            job.rounds,
        );
        let key = serde_json::to_value(spec.kind)
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned();
        if dimensions
            .get(&key)
            .is_none_or(|old| worse_dimension(&evaluation, old))
        {
            dimensions.insert(key, evaluation);
        }
    }
    let resource = assess_resources(job, &candidate.id);
    let accepted = !dimensions.is_empty()
        && dimensions.values().all(|evaluation| evaluation.accepted)
        && resource.status == ResourceStatus::Checked;
    candidate.evaluation = Some(Evaluation {
        gain: median(
            &dimensions
                .values()
                .filter_map(|evaluation| evaluation.gain)
                .collect::<Vec<_>>(),
        ),
        drift: dimensions
            .values()
            .filter_map(|evaluation| evaluation.drift)
            .max_by(f64::total_cmp),
        pairs: specs.len() * job.rounds,
        accepted,
        reason: match resource.status {
            ResourceStatus::Unknown => "resourceUnknown",
            ResourceStatus::InsufficientHeadroom => "insufficientResourceHeadroom",
            ResourceStatus::Checked if accepted => "fullScenarioGain",
            ResourceStatus::Checked => "noReliableFullScenarioGain",
        }
        .into(),
    });
    candidate.dimensions = dimensions;
    candidate.resource_assessment = Some(resource);
    Ok(candidate)
}

fn assert_measured_recommendation_matches_evaluator(job: &TuningJob) {
    let candidate = evaluated_fixture_candidate(job).unwrap();
    let diagnostic = request_report_diagnostics(job);
    assert_eq!(
        serde_json::to_value(&job.candidates[0].evaluation).unwrap(),
        serde_json::to_value(&candidate.evaluation).unwrap(),
        "{diagnostic}"
    );
    assert_eq!(
        serde_json::to_value(&job.candidates[0].dimensions).unwrap(),
        serde_json::to_value(&candidate.dimensions).unwrap(),
        "{diagnostic}"
    );
    assert_eq!(
        job.recommended_candidate_id.as_deref(),
        candidate
            .evaluation
            .as_ref()
            .filter(|evaluation| evaluation.accepted)
            .map(|_| candidate.id.as_str()),
        "{diagnostic}"
    );
}

fn synthetic_transaction_report(measured: &TuningJob) -> Result<TuningJob, String> {
    if measured.state != Phase::Completed
        || measured.completed_requests != measured.total_requests
        || measured.total_requests == 0
        || measured.full.progress.completed_workloads != measured.full.progress.total_workloads
        || measured.full.workload_measurements.len() != measured.full.progress.completed_workloads
        || measured.full.workload_measurements.is_empty()
    {
        return Err("transaction fixture requires complete real HTTP coverage".into());
    }
    if measured
        .full
        .workload_measurements
        .iter()
        .any(|measurement| {
            measurement.result["complete"] != true || measurement.result["qualityPassed"] != true
        })
    {
        return Err("transaction fixture cannot replace failed real semantic evidence".into());
    }
    let actual_candidate = evaluated_fixture_candidate(measured)?;
    if actual_candidate
        .resource_assessment
        .as_ref()
        .is_none_or(|resource| resource.status != ResourceStatus::Checked)
    {
        return Err("transaction fixture requires actual safe HTTP resource samples".into());
    }
    // The original report, including its actual recommendation or rejection,
    // stays immutable. This separate report is ONLY an input to transaction
    // integration tests: synthetic timing, actual HTTP quality/resources,
    // original configuration/engine identity and observed restart parameters.
    // No benchmark or production telemetry is replaced with invented timings.
    let mut fixture = measured.clone();
    fixture.id = uuid::Uuid::new_v4().to_string();
    fixture.notes.push(format!(
        "TEST ONLY: synthetic transaction timing inputs; real HTTP evidence in source report {}",
        measured.id
    ));
    for measurement in &mut fixture.full.workload_measurements {
        let wall = if measurement.position == Position::Candidate {
            50.
        } else {
            100.
        };
        let turns = measurement.result["turns"]
            .as_array_mut()
            .filter(|turns| !turns.is_empty())
            .ok_or("transaction fixture requires actual HTTP turn records")?;
        for turn in turns.iter_mut() {
            if turn["wallMs"]
                .as_f64()
                .is_none_or(|value| !value.is_finite() || value <= 0.)
            {
                return Err("transaction fixture cannot replace missing real turn timings".into());
            }
            turn["wallMs"] = json!(wall);
            turn["wallMsSource"] = json!("TEST_ONLY_SYNTHETIC_TRANSACTION_INPUT");
        }
        let total_wall = wall * turns.len() as f64;
        measurement.result["wallMs"] = json!(total_wall);
        measurement.result["timingSource"] = json!("TEST_ONLY_SYNTHETIC_TRANSACTION_INPUT");
        measurement.result["sourceMeasuredJobId"] = json!(measured.id);
    }
    let candidate = evaluated_fixture_candidate(&fixture)?;
    validate_application(&fixture, &candidate)?;
    fixture.recommended_candidate_id = candidate
        .evaluation
        .as_ref()
        .filter(|evaluation| evaluation.accepted)
        .map(|_| candidate.id.clone());
    if fixture.recommended_candidate_id.is_none() {
        return Err("synthetic transaction inputs did not pass production evaluation".into());
    }
    fixture.candidates = vec![candidate];
    Ok(fixture)
}

fn persist_transaction_fixture(state: &RuntimeState, measured: &TuningJob) -> TuningJob {
    let fixture = synthetic_transaction_report(measured).unwrap();
    assert_ne!(fixture.id, measured.id);
    assert_eq!(fixture.identity, measured.identity);
    assert_eq!(fixture.config_fingerprint, measured.config_fingerprint);
    persist(state, &fixture).unwrap();
    fixture
}

fn assert_measured_report_unchanged(state: &RuntimeState, measured: &TuningJob, bytes: &[u8]) {
    assert_eq!(
        fs::read(report_path(state, &measured.id).unwrap()).unwrap(),
        bytes
    );
    assert_eq!(
        serde_json::to_value(read_job(state, &measured.id).unwrap()).unwrap(),
        serde_json::to_value(measured).unwrap()
    );
}

fn assert_transaction_fixture_rejects_bad_evidence(measured: &TuningJob) {
    let mut incomplete = measured.clone();
    incomplete.full.progress.completed_workloads -= 1;
    assert!(synthetic_transaction_report(&incomplete).is_err());
    let mut bad_quality = measured.clone();
    bad_quality.full.workload_measurements[0].result["qualityPassed"] = json!(false);
    assert!(synthetic_transaction_report(&bad_quality).is_err());
    let mut no_timing = measured.clone();
    no_timing.full.workload_measurements[0].result["turns"][0]["wallMs"] = Value::Null;
    assert!(synthetic_transaction_report(&no_timing).is_err());
    for pressure in [false, true] {
        let mut bad_resource = measured.clone();
        let sample = bad_resource
            .full
            .workload_measurements
            .iter_mut()
            .find(|measurement| measurement.position == Position::Candidate)
            .unwrap();
        if pressure {
            sample.result["resourcePeak"]["gpuMemoryUsedBytes"] = json!((16u64 << 30) - 1);
        } else {
            sample.result["resourcePeak"]["sampleCount"] = json!(0);
        }
        assert!(synthetic_transaction_report(&bad_resource).is_err());
    }
    let mut old_version = measured.clone();
    old_version.identity["benchmarkVersion"] = json!("invalid-fixture-version");
    assert!(synthetic_transaction_report(&old_version).is_err());
    if measured.candidates[0].kind == CandidateKind::Restart {
        let mut unverified_restart = measured.clone();
        unverified_restart.candidates[0].startup_verification = None;
        assert!(synthetic_transaction_report(&unverified_restart).is_err());
    }
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn full_request_aba_has_semantic_coverage_and_public_apply_restore() {
    let (_temp, state, profile, original) = stable_request_fixture().await;
    let started = start(state.clone(), profile.id.clone(), full_request(None))
        .await
        .unwrap();
    assert_eq!(started.total_requests, 48);
    let measured = await_job(&state, &profile).await;
    let done = &measured;
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
    assert_request_fixture_evidence(done);
    assert_measured_recommendation_matches_evaluator(&measured);
    assert_transaction_fixture_rejects_bad_evidence(&measured);
    let measured_bytes = fs::read(report_path(&state, &measured.id).unwrap()).unwrap();
    let done = persist_transaction_fixture(&state, &measured);
    assert_eq!(
        done.recommended_candidate_id.as_deref(),
        Some("candidate-1"),
        "{}",
        request_report_diagnostics(&done)
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
    assert_measured_report_unchanged(&state, &measured, &measured_bytes);
    crate::stop_service(&state, profile.id.clone())
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn failed_apply_and_failed_rollback_publish_only_this_transactions_verified_flags() {
    for external_edit in [false, true] {
        let (_temp, state, profile, original) = stable_request_fixture().await;
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
        let measured = await_job(&state, &profile).await;
        let done = &measured;
        assert_eq!(done.state, Phase::Completed, "{:?}", done.error);
        assert!(done.full.recovery.configuration_restored && done.full.recovery.service_verified);
        assert_request_fixture_evidence(done);
        assert_measured_recommendation_matches_evaluator(&measured);
        assert_transaction_fixture_rejects_bad_evidence(&measured);
        let measured_bytes = fs::read(report_path(&state, &measured.id).unwrap()).unwrap();
        let done = persist_transaction_fixture(&state, &measured);
        assert_eq!(
            done.recommended_candidate_id.as_deref(),
            Some("candidate-1"),
            "{}",
            request_report_diagnostics(&done)
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
        assert_measured_report_unchanged(&state, &measured, &measured_bytes);
        crate::stop_service(&state, profile.id.clone())
            .await
            .unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn restart_workers_aba_verifies_actual_flags_and_restores_baseline() {
    let (_temp, state, profile, original) = stable_request_fixture().await;
    let before = require_owned(&state, &profile).await.unwrap();
    start(
        state.clone(),
        profile.id.clone(),
        full_request(Some(workers(2))),
    )
    .await
    .unwrap();
    let measured = await_job(&state, &profile).await;
    let done = &measured;
    assert_eq!(done.state, Phase::Completed, "{:?}", done.error);
    assert_ne!(require_owned(&state, &profile).await.unwrap(), before);
    assert_eq!(
        read_metrics(&state, &profile).await.unwrap()["engine"]["pool_workers"],
        4
    );
    assert_original(&profile, &original);
    assert_request_fixture_evidence(&measured);
    assert_measured_recommendation_matches_evaluator(&measured);
    assert_transaction_fixture_rejects_bad_evidence(&measured);
    assert_eq!(
        done.candidates[0]
            .startup_verification
            .as_ref()
            .unwrap()
            .parameters[0]
            .observed,
        Some(2)
    );
    let measured_bytes = fs::read(report_path(&state, &measured.id).unwrap()).unwrap();
    let done = persist_transaction_fixture(&state, &measured);
    assert_eq!(
        done.recommended_candidate_id.as_deref(),
        Some("restart-1"),
        "{}",
        request_report_diagnostics(&done)
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
    assert_measured_report_unchanged(&state, &measured, &measured_bytes);
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
