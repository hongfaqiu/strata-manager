//! Finite, journaled restarts around complete workloads. Never edit imported files.
use super::*;
use workloads::{WorkloadKind, WorkloadOptions};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct RestartParameters {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pool_workers: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapt_async: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefill: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vram_reserve_mib: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapt_every: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapt_swaps: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapt_decay: Option<f64>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedParameter {
    pub name: String,
    pub requested: Value,
    pub observed: Option<Value>,
    pub status: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupVerification {
    pub parameters: Vec<VerifiedParameter>,
    pub checked_at: u64,
    pub note: String,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResourceStatus {
    Checked,
    Unknown,
    InsufficientHeadroom,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceAssessment {
    pub status: ResourceStatus,
    pub data_scope: String,
    pub sample_count: u64,
    pub ram_peak_bytes: Option<u64>,
    pub gpu_peak_bytes: Option<u64>,
    pub ram_total_bytes: Option<u64>,
    pub gpu_total_bytes: Option<u64>,
    pub minimum_ram_headroom_bytes: u64,
    pub minimum_gpu_headroom_bytes: u64,
    pub note: String,
}
fn assess_resources(job: &TuningJob, candidate: &str) -> ResourceAssessment {
    let mut assessment=ResourceAssessment {status:ResourceStatus::Unknown,data_scope:"systemAndPrimaryGpu".into(),sample_count:0,ram_peak_bytes:None,gpu_peak_bytes:None,ram_total_bytes:job.identity["ramTotal"].as_u64().filter(|v|*v>0),gpu_total_bytes:job.identity["gpuMemoryTotal"].as_u64().filter(|v|*v>0),minimum_ram_headroom_bytes:1u64<<30,minimum_gpu_headroom_bytes:256u64<<20,note:"System RAM and primary GPU are sampled, not attributed to this model. Safety floors are 1GiB RAM and 256MiB GPU; samples may miss peaks and do not guarantee absence of OOM. Unknown telemetry cannot establish a safe recommendation.".into()};
    let samples = job
        .full
        .workload_measurements
        .iter()
        .filter(|m| m.candidate_id == candidate && m.position == Position::Candidate)
        .collect::<Vec<_>>();
    let mut complete = !samples.is_empty();
    for m in samples {
        let peak = &m.result["resourcePeak"];
        let count = peak["sampleCount"].as_u64().unwrap_or(0);
        let ram = peak["ramUsedBytes"].as_u64();
        let gpu = peak["gpuMemoryUsedBytes"].as_u64();
        complete &= count > 0
            && peak["dataScope"] == "systemAndPrimaryGpu"
            && ram.is_some()
            && gpu.is_some();
        assessment.sample_count = assessment.sample_count.saturating_add(count);
        if let Some(v) = ram {
            assessment.ram_peak_bytes = Some(assessment.ram_peak_bytes.unwrap_or(0).max(v));
        }
        if let Some(v) = gpu {
            assessment.gpu_peak_bytes = Some(assessment.gpu_peak_bytes.unwrap_or(0).max(v));
        }
    }
    if complete {
        if let (Some(ram), Some(gpu), Some(ram_total), Some(gpu_total)) = (
            assessment.ram_peak_bytes,
            assessment.gpu_peak_bytes,
            assessment.ram_total_bytes,
            assessment.gpu_total_bytes,
        ) {
            assessment.status = if ram_total.saturating_sub(ram)
                >= assessment.minimum_ram_headroom_bytes
                && gpu_total.saturating_sub(gpu) >= assessment.minimum_gpu_headroom_bytes
            {
                ResourceStatus::Checked
            } else {
                ResourceStatus::InsufficientHeadroom
            };
        }
    }
    assessment
}
pub(super) fn check_live_resources(metrics: &Value) -> Result<(), String> {
    let hardware = &metrics["hardware"];
    let (Some(ram), Some(ram_total), Some(gpu), Some(gpu_total)) = (
        hardware["ram_used"].as_u64(),
        hardware["ram_total"].as_u64(),
        hardware["gpu_mem_used"].as_u64(),
        hardware["gpu_mem_total"].as_u64(),
    ) else {
        return Err("当前系统RAM/主GPU遥测未公开，无法核验应用候选的资源安全余量".into());
    };
    if ram_total.saturating_sub(ram) < (1u64 << 30)
        || gpu_total.saturating_sub(gpu) < (256u64 << 20)
    {
        return Err("当前系统RAM/主GPU安全余量不足，报告后的资源占用已变化；未应用候选".into());
    }
    Ok(())
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FullOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_case: Option<UseCase>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_limit: Option<usize>,
    pub include_vision: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restart_candidates: Option<Vec<RestartParameters>>,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CandidateKind {
    #[default]
    Request,
    Restart,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    #[default]
    RequestDiagnostic,
    FullScenario,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Progress {
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workload_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub round: Option<usize>,
    pub completed_workloads: usize,
    pub total_workloads: usize,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryState {
    #[default]
    NotNeeded,
    Pending,
    Restoring,
    Restored,
    Failed,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Recovery {
    pub state: RecoveryState,
    pub configuration_restored: bool,
    pub service_verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadMeasurement {
    pub id: String,
    pub candidate_id: String,
    pub round: usize,
    pub position: Position,
    pub workload_id: String,
    pub kind: WorkloadKind,
    pub freshly_loaded: bool,
    pub result: Value,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FullReport {
    pub report_version: usize,
    pub scope: Scope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_case: Option<UseCase>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_limit: Option<usize>,
    pub include_vision: bool,
    pub restart_baseline: RestartParameters,
    pub workload_measurements: Vec<WorkloadMeasurement>,
    pub progress: Progress,
    pub recovery: Recovery,
    pub limits: FullLimits,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FullLimits {
    pub max_duration_seconds: u64,
    pub generation_request_limit: usize,
    pub output_token_upper_bound: usize,
    pub recovery_deadline_seconds: u64,
}
impl Default for FullLimits {
    fn default() -> Self {
        Self {
            max_duration_seconds: 7200,
            generation_request_limit: 0,
            output_token_upper_bound: 0,
            recovery_deadline_seconds: 420,
        }
    }
}
impl Default for FullReport {
    fn default() -> Self {
        Self {
            report_version: 1,
            scope: Scope::RequestDiagnostic,
            use_case: None,
            context_limit: None,
            include_vision: false,
            restart_baseline: RestartParameters::default(),
            workload_measurements: vec![],
            progress: Progress::default(),
            recovery: Recovery::default(),
            limits: FullLimits::default(),
        }
    }
}
fn option_value<'a>(config: &'a Value, flag: &str) -> Result<Option<&'a str>, String> {
    let args = config["args"].as_array().ok_or("配置缺少引擎参数")?;
    let mut found = None;
    for (i, arg) in args.iter().enumerate() {
        let arg = arg.as_str().ok_or("引擎参数不是字符串")?;
        let value = if arg == flag {
            Some(
                args.get(i + 1)
                    .and_then(Value::as_str)
                    .filter(|s| !s.starts_with("--"))
                    .ok_or("原启动参数缺少值")?,
            )
        } else {
            arg.strip_prefix(flag).and_then(|s| s.strip_prefix('='))
        };
        if let Some(value) = value {
            if found.is_some() {
                return Err(format!("{flag} 重复，无法可靠比较启动候选"));
            }
            found = Some(value);
        }
    }
    Ok(found)
}
fn baseline(config: &Value) -> Result<RestartParameters, String> {
    let integer = |flag| {
        option_value(config, flag)?
            .map(|s| s.parse::<usize>().map_err(|_| format!("{flag} 原值无效")))
            .transpose()
    };
    Ok(RestartParameters {
        pool_workers: integer("--pool-workers")?,
        adapt_async: option_value(config, "--adapt-async")?
            .map(|v| match v {
                "0" => Ok(false),
                "1" => Ok(true),
                _ => Err("原 adapt-async 不是0或1".to_string()),
            })
            .transpose()?,
        // `auto` is retained byte-for-byte in the original snapshot, not coerced.
        prefill: option_value(config, "--prefill")?.and_then(|s| s.parse().ok()),
        vram_reserve_mib: integer("--vram-reserve-mib")?,
        adapt_every: integer("--adapt-every")?,
        adapt_swaps: integer("--adapt-swaps")?,
        adapt_decay: option_value(config, "--adapt-decay")?
            .map(|s| s.parse::<f64>().map_err(|_| "--adapt-decay 原值无效".to_string()))
            .transpose()?,
    })
}
fn validate_restart(config: &Value, p: &RestartParameters) -> Result<(), String> {
    if p == &RestartParameters::default() {
        return Err("重启候选必须指定至少一个参数".into());
    }
    if p.pool_workers.is_some_and(|v| !(1..=32).contains(&v))
        || p.prefill
            .is_some_and(|v| ![512, 1024, 2048, 4096, 8192, 16384, 32768].contains(&v))
        || p.vram_reserve_mib
            .is_some_and(|v| !(256..=8192).contains(&v))
        || p.adapt_every.is_some_and(|v| !(1..=4096).contains(&v))
        || p.adapt_swaps.is_some_and(|v| v > 4096)
        || p.adapt_decay.is_some_and(|v| !v.is_finite() || !(0.0..=1.0).contains(&v))
    {
        return Err(
            "重启参数超出受控范围：workers1–32、prefill512/1024/2048/4096/8192/16384/32768、reserve256–8192MiB、adapt-every1–4096、adapt-swaps0–4096、adapt-decay0–1"
                .into(),
        );
    }
    if let Some(reserve) = p.vram_reserve_mib {
        // Official runconfig/server default is 700MiB. Never reduce headroom.
        let old = baseline(config)?.vram_reserve_mib.unwrap_or(700);
        if reserve < old {
            return Err("调优不能减少原显存保留量；请提高候选reserve或保持原值".into());
        }
    }
    if p.adapt_async == Some(true) {
        let args = config["args"].as_array().ok_or("启动参数缺失")?;
        if !args
            .iter()
            .any(|a| a == "--resident-experts" || a == "--resident-cpu-experts")
        {
            return Err("adapt-async需要已有resident RAM模式；调优不会自动开启大内存配置".into());
        }
        if args
            .iter()
            .any(|a| a == "--layer-split" || a == "--split-device")
        {
            return Err("此有限搜索尚不支持多设备异步tier候选，保持原配置".into());
        }
    }
    Ok(())
}
fn check_ram_headroom(
    config: &Value,
    p: Option<&RestartParameters>,
    available: u64,
) -> Result<(), String> {
    let Some(prefill) = p.and_then(|p| p.prefill) else {
        return Ok(());
    };
    // `auto[:N]` is not a known effective baseline chunk. Treat a fixed request
    // conservatively as an increase without rewriting the original spelling.
    if baseline(config)?.prefill.is_some_and(|old| prefill <= old) {
        return Ok(());
    }
    // Admission safety floor, NOT an allocation estimate. Host tables and two
    // pinned T*N*4 buffers depend on model geometry; borrowed VRAM depends on
    // the cache layout. INFO does not expose a complete allocation prediction.
    let required = if prefill >= 16384 {
        4u64 << 30
    } else {
        2u64 << 30
    };
    if available < required {
        return Err(format!("prefill增加前可用RAM {:.2}GiB低于安全余量{}GiB，未切换；更大分块会增加与模型维度相关的RAM/VRAM缓冲，无法保证精确成本或避免OOM", available as f64 / (1u64 << 30) as f64, required >> 30));
    }
    Ok(())
}
pub(super) fn check_restart_ram(
    config: &Value,
    p: Option<&RestartParameters>,
) -> Result<(), String> {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    check_ram_headroom(config, p, system.available_memory())
}
pub(super) fn with_restart(config: &Value, p: Option<&RestartParameters>) -> Result<Value, String> {
    let Some(p) = p else {
        return Ok(config.clone());
    };
    validate_restart(config, p)?;
    let fields = [
        ("--pool-workers", p.pool_workers.map(|v| v.to_string())),
        (
            "--adapt-async",
            p.adapt_async.map(|v| if v { "1" } else { "0" }.into()),
        ),
        ("--prefill", p.prefill.map(|v| v.to_string())),
        (
            "--vram-reserve-mib",
            p.vram_reserve_mib.map(|v| v.to_string()),
        ),
        ("--adapt-every", p.adapt_every.map(|v| v.to_string())),
        ("--adapt-swaps", p.adapt_swaps.map(|v| v.to_string())),
        ("--adapt-decay", p.adapt_decay.map(|v| v.to_string())),
    ];
    let mut new = config.clone();
    let args = config["args"].as_array().ok_or("配置缺少args")?;
    let mut out = vec![];
    let mut i = 0;
    while i < args.len() {
        let text = args[i].as_str().ok_or("args必须为字符串")?;
        if let Some((flag, _)) = fields.iter().find(|(flag, value)| {
            value.is_some() && (text == *flag || text.starts_with(&format!("{flag}=")))
        }) {
            let _ = option_value(config, flag)?;
            i += if text == *flag { 2 } else { 1 };
        } else {
            out.push(args[i].clone());
            i += 1;
        }
    }
    for (flag, value) in fields {
        if let Some(value) = value {
            out.extend([json!(flag), json!(value)]);
        }
    }
    new["args"] = json!(out);
    storage::validate(&new)?;
    Ok(new)
}
fn options(full: &FullReport, max_tokens: usize) -> Result<WorkloadOptions, String> {
    Ok(WorkloadOptions {
        use_case: full.use_case.ok_or("完整用途缺失")?,
        context_limit: full.context_limit.ok_or("上下文上限缺失")?,
        include_vision: full.include_vision,
        max_output_tokens: max_tokens,
    })
}
pub(super) fn prepare_report(
    request: &TuningStartRequest,
    config: &Value,
    metrics: &Value,
    parameters: Parameters,
    candidates: &mut Vec<Candidate>,
) -> Result<FullReport, String> {
    let mut full = FullReport {
        report_version: 2,
        restart_baseline: baseline(config)?,
        ..Default::default()
    };
    let Some(use_case) = request.full.use_case else {
        if request
            .full
            .restart_candidates
            .as_ref()
            .is_some_and(|c| !c.is_empty())
            || request.full.include_vision
        {
            return Err("重启或视觉候选需要先选择完整用途".into());
        }
        return Ok(full);
    };
    let max_context = metrics["engine"]["max_context"]
        .as_u64()
        .ok_or("引擎未报告实际上下文，无法规划完整场景")? as usize;
    let context_limit = request
        .full
        .context_limit
        .unwrap_or(if use_case == UseCase::LongDocument {
            32768
        } else {
            8192
        })
        .min(max_context.saturating_sub(request.max_tokens));
    if !(4096..=131072).contains(&context_limit)
        || request
            .full
            .context_limit
            .is_some_and(|v| v > max_context.saturating_sub(request.max_tokens))
    {
        return Err(
            "完整场景上下文须4096–131072且保留实际回答预算；当前模型容量不足或所选上限过大".into(),
        );
    }
    if request.full.include_vision && !config.get("vision").is_some_and(Value::is_object) {
        return Err("此模型没有已配置视觉编码器，不能将视觉验收算作通过".into());
    }
    full.scope = Scope::FullScenario;
    full.use_case = Some(use_case);
    full.context_limit = Some(context_limit);
    full.include_vision = request.full.include_vision;
    let specs = workloads::plan(&options(&full, request.max_tokens)?)?;
    if let Some(restarts) = &request.full.restart_candidates {
        if restarts.len() > 4 {
            return Err("重启候选最多4组".into());
        }
        for p in restarts {
            validate_restart(config, p)?;
            let target = with_restart(config, Some(p))?;
            if target == *config || candidates.iter().any(|c| c.restart.as_ref() == Some(p)) {
                continue;
            }
            candidates.push(Candidate {
                id: format!("restart-{}", candidates.len() + 1),
                pcie_frac: parameters.pcie_frac,
                spec_min_p: parameters.spec_min_p,
                kind: CandidateKind::Restart,
                restart: Some(p.clone()),
                startup_verification: None,
                resource_assessment: None,
                dimensions: HashMap::new(),
                evaluation: None,
            });
        }
    }
    full.progress = Progress {
        phase: "waitingForIdle".into(),
        total_workloads: specs.len() * candidates.len() * request.rounds * 3,
        ..Default::default()
    };
    full.limits.generation_request_limit = specs
        .iter()
        .map(workloads::expected_request_count)
        .sum::<usize>()
        * candidates.len()
        * request.rounds
        * 3;
    full.limits.output_token_upper_bound =
        full.limits.generation_request_limit * request.max_tokens;
    Ok(full)
}
pub(super) fn request_total(
    full: &FullReport,
    _candidates: usize,
    _rounds: usize,
) -> Result<Option<usize>, String> {
    if full.scope != Scope::FullScenario {
        return Ok(None);
    }
    Ok(Some(full.limits.generation_request_limit))
}
pub(super) fn bound_identity(
    profile: &ServiceProfile,
    config: &Value,
    metrics: &Value,
    job: &TuningJob,
) -> Value {
    let mut value = identity(profile, config, metrics, &job.scenes);
    if job.full.scope == Scope::FullScenario {
        value["benchmarkVersion"] = json!(workloads::VERSION);
        value["useCase"] = json!(job.full.use_case);
        value["contextLimit"] = json!(job.full.context_limit);
        value["includeVision"] = json!(job.full.include_vision);
        value["limits"]=json!("Complete finite semantic workloads; model identity uses size/mtime, resources are sampled, driver unknown. Startup parameters are verified where reported; internal adaptive scheduling and prefill chunk may vary.");
    }
    value
}
fn journal_path(state: &RuntimeState, id: &str) -> Result<PathBuf, String> {
    let _ = report_path(state, id)?;
    Ok(report_dir(state).join(format!("{id}.stage")))
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    job_id: String,
    profile: ServiceProfile,
    original_sha256: String,
    target_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous_sha256: Option<String>,
    restored: bool,
}
fn journal(state: &RuntimeState, j: &Journal) -> Result<(), String> {
    atomic_bytes(
        &journal_path(state, &j.job_id)?,
        &serde_json::to_vec(j).map_err(|e| e.to_string())?,
    )
}
fn load_journal(state: &RuntimeState, id: &str) -> Result<Option<Journal>, String> {
    let path = journal_path(state, id)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() > 16384 {
        return Err("阶段journal超限".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "阶段journal损坏，拒绝自动覆盖".into())
}
pub(super) fn has_active_stage(state: &RuntimeState, id: &str) -> Result<bool, String> {
    let Some(stage) = load_journal(state, id)? else {
        return Ok(false);
    };
    if !stage.restored {
        return Ok(true);
    }
    if fs::metadata(report_path(state, id)?)
        .map_err(|e| e.to_string())?
        .len()
        > 4 * 1024 * 1024
    {
        return Err("恢复报告超过读取上限".into());
    }
    let job: TuningJob =
        serde_json::from_slice(&fs::read(report_path(state, id)?).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    Ok(job.state.active())
}
pub(super) fn begin_application(
    state: &RuntimeState,
    job: &TuningJob,
    profile: &ServiceProfile,
    current: &[u8],
    target: &[u8],
) -> Result<(), String> {
    if job.full.scope != Scope::FullScenario {
        return Ok(());
    }
    let _ = original(state, job)?;
    journal(
        state,
        &Journal {
            job_id: job.id.clone(),
            profile: profile.clone(),
            original_sha256: job.config_fingerprint.clone(),
            target_sha256: fingerprint(target),
            previous_sha256: Some(fingerprint(current)),
            restored: false,
        },
    )
}
pub(super) fn settle_application(
    state: &RuntimeState,
    job: &TuningJob,
    profile: &ServiceProfile,
) -> Result<(), String> {
    if job.full.scope != Scope::FullScenario {
        return Ok(());
    }
    let mut stage = load_journal(state, &job.id)?.ok_or("应用恢复journal缺失")?;
    let registered = state.registered_profile(&profile.id)?;
    if stage.job_id != job.id
        || stage.original_sha256 != job.config_fingerprint
        || serde_json::to_value(&registered).map_err(|e| e.to_string())?
            != serde_json::to_value(&stage.profile).map_err(|e| e.to_string())?
    {
        return Err("应用恢复journal身份不一致".into());
    }
    let current = fs::read(assert_managed_config(state, profile)?).map_err(|e| e.to_string())?;
    let hash = fingerprint(&current);
    if hash != stage.target_sha256 && hash != stage.original_sha256 {
        return Err("应用完成后配置身份变化，恢复journal未退役".into());
    }
    stage.restored = true;
    stage.target_sha256 = hash;
    stage.previous_sha256 = None;
    journal(state, &stage)
}
fn original(state: &RuntimeState, job: &TuningJob) -> Result<Vec<u8>, String> {
    let bytes = fs::read(report_dir(state).join(format!("{}.original", job.id)))
        .map_err(|e| format!("调优原配置恢复副本不可用：{e}"))?;
    if fingerprint(&bytes) != job.config_fingerprint {
        return Err("调优原配置恢复副本hash不符".into());
    }
    Ok(bytes)
}
async fn restore_stage(
    state: &Arc<RuntimeState>,
    profile: &ServiceProfile,
    id: &str,
    token: &str,
    terminal: bool,
) -> Result<(), String> {
    let native_operation = NativeOperation::new();
    let Some(mut stage) = load_journal(state, id)? else {
        return Ok(());
    };
    let job = read_job(state, id)?;
    let original = original(state, &job)?;
    let registered = state.registered_profile(&profile.id)?;
    if stage.job_id != job.id
        || stage.original_sha256 != job.config_fingerprint
        || serde_json::to_value(&registered).map_err(|e| e.to_string())?
            != serde_json::to_value(&stage.profile).map_err(|e| e.to_string())?
    {
        return Err("登记身份已改变，拒绝恢复到未知安装".into());
    }
    let path = assert_managed_config(state, profile)?;
    let current = fs::read(&path).map_err(|e| e.to_string())?;
    let hash = fingerprint(&current);
    if hash != stage.target_sha256
        && hash != stage.original_sha256
        && stage.previous_sha256.as_ref() != Some(&hash)
    {
        return Err("配置有不属于调优的外部编辑，未覆盖；需要修复".into());
    }
    update(state, id, |job| {
        job.current_step = "restoringBaseline".into();
        job.full.progress.phase = "restoringBaseline".into();
        job.full.recovery.state = RecoveryState::Restoring;
        job.full.recovery.service_verified = false;
    })?;
    // Drain only the current owned process. A dead owned process has no in-flight work.
    let alive = state
        .processes
        .lock()
        .map_err(|e| e.to_string())?
        .get_mut(&profile.id)
        .map(|p| p.refresh())
        .transpose()?
        .is_some_and(|s| s.running && s.owned);
    if alive {
        // A canceled candidate may have just spawned a new API root. Until its
        // GET health is ready the observer file can still name the exited root.
        wait_restarted_api(state, profile).await?;
        crate::maintenance::wait_idle(state, profile).await?;
    }
    if fs::read(&path).map_err(|e| e.to_string())? != current {
        return Err("恢复排空期间配置被编辑，未覆盖".into());
    }
    atomic_bytes(&path, &original)?;
    update(state, id, |job| {
        job.full.recovery.configuration_restored = true
    })?;
    // The guarded restart also disposes an already-dead owned root and its
    // retained descendants under the same operation lock before spawning.
    crate::restart_service_for_tuning(state.clone(), profile.clone(), id, &native_operation.0)
        .await?;
    verify_restarted(state, profile, token, job.baseline).await?;
    let config: Value = serde_json::from_slice(&original).map_err(|e| e.to_string())?;
    if bound_identity(profile, &config, &read_metrics(state, profile).await?, &job) != job.identity
    {
        return Err("恢复后原模型/引擎/硬件身份不一致".into());
    }
    if fs::read(&path).map_err(|e| e.to_string())? != original {
        return Err("恢复后原配置字节不一致".into());
    }
    // Baseline-between-candidates is still part of an active benchmark. Only a
    // terminal health-verified restore may retire crash recovery ownership.
    stage.restored = terminal;
    stage.target_sha256 = stage.original_sha256.clone();
    journal(state, &stage)?;
    update(state, id, |job| {
        job.full.recovery = Recovery {
            state: RecoveryState::Restored,
            configuration_restored: true,
            service_verified: true,
            error: None,
        }
    })?;
    Ok(())
}
async fn switch_stage(
    state: &Arc<RuntimeState>,
    profile: &ServiceProfile,
    job: &TuningJob,
    candidate: &Candidate,
    token: &str,
    cancel: &CancellationToken,
) -> Result<(), String> {
    crate::maintenance::wait_idle(state, profile).await?;
    require_owned(state, profile).await?;
    let path = assert_managed_config(state, profile)?;
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    if fingerprint(&bytes) != job.config_fingerprint {
        return Err("候选切换前原配置已变化".into());
    }
    let config: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if bound_identity(profile, &config, &read_metrics(state, profile).await?, job) != job.identity {
        return Err("候选切换前模型/引擎/硬件身份变化".into());
    }
    check_restart_ram(&config, candidate.restart.as_ref())?;
    let target = serde_json::to_vec_pretty(&with_restart(
        &with_parameters(&config, candidate.parameters())?,
        candidate.restart.as_ref(),
    )?)
    .map_err(|e| e.to_string())?;
    let backup = report_dir(state).join(format!("{}.original", job.id));
    if backup.exists() {
        if fs::read(&backup).map_err(|e| e.to_string())? != bytes {
            return Err("原配置备份已变化".into());
        }
    } else {
        atomic_bytes(&backup, &bytes)?;
    }
    // Durable backup and target ownership precede every temporary write.
    journal(
        state,
        &Journal {
            job_id: job.id.clone(),
            profile: profile.clone(),
            original_sha256: job.config_fingerprint.clone(),
            target_sha256: fingerprint(&target),
            previous_sha256: None,
            restored: false,
        },
    )?;
    update(state, &job.id, |job| {
        job.full.recovery = Recovery {
            state: RecoveryState::Pending,
            configuration_restored: false,
            service_verified: false,
            error: None,
        };
        job.full.progress.phase = "loading".into();
    })?;
    if cancel.is_cancelled() {
        return Err("已取消，正在恢复原配置和服务".into());
    }
    if fs::read(&path).map_err(|e| e.to_string())? != bytes {
        return Err("候选发布前配置变化，未覆盖".into());
    }
    atomic_bytes(&path, &target)?;
    crate::restart_service_for_tuning(state.clone(), profile.clone(), &job.id, cancel).await?;
    tokio::select! { _=cancel.cancelled()=>Err("候选加载期间取消，正在恢复原配置".into()), result=async {
        verify_restarted(state,profile,token,candidate.parameters()).await?;
        let verification=verify_flags(state,profile,candidate.restart.as_ref()).await?;
        update(state,&job.id,|job| { if let Some(c)=job.candidates.iter_mut().find(|c|c.id==candidate.id){c.startup_verification=Some(verification);} })?;
        Ok(())
    }=>result }
}
pub(super) async fn verify_flags(
    state: &RuntimeState,
    profile: &ServiceProfile,
    p: Option<&RestartParameters>,
) -> Result<StartupVerification, String> {
    let mut verification=StartupVerification { parameters:vec![], checked_at:now(), note:"poolWorkers/adaptAsync require effective engine telemetry. Prefill may shrink dynamically: upperBound is the verified live startup ceiling, not an effective chunk. ReservationRequest is the verified startup request, not measured free VRAM. Adaptive tier startupRequest is checked against the owned engine command when the engine does not expose an effective value; workload quality and timing are tested separately.".into() };
    let Some(p) = p else {
        return Ok(verification);
    };
    let metrics = read_metrics(state, profile).await?;
    let expected = [
        ("pool_workers", p.pool_workers.map(|v| json!(v))),
        ("adapt_async", p.adapt_async.map(|v| json!(u64::from(v)))),
        ("prefill", p.prefill.map(|v| json!(v))),
        ("vram_reserve_mib", p.vram_reserve_mib.map(|v| json!(v))),
        ("adapt_every", p.adapt_every.map(|v| json!(v))),
        ("adapt_swaps", p.adapt_swaps.map(|v| json!(v))),
        ("adapt_decay", p.adapt_decay.map(|v| json!(v))),
    ];
    let mut unknown = false;
    for (key, value) in expected {
        if let Some(want) = value {
            let actual = metrics["engine"][key].as_f64().filter(|n| n.is_finite())
                .map(|_| metrics["engine"][key].clone())
                .or_else(|| (key == "adapt_async").then(|| metrics["engine"][key].as_bool())
                    .flatten().map(|v| json!(u64::from(v))));
            let equal = actual.as_ref().is_some_and(|v| (v.as_f64().unwrap() - want.as_f64().unwrap()).abs() <= 1e-9);
            if let Some(ref actual) = actual {
                let n = actual.as_f64().unwrap();
                if (key == "prefill" && (n <= 0.0 || n > want.as_f64().unwrap())) || (key != "prefill" && !equal) {
                    return Err(format!("重启后 {key} 实际参数不符"));
                }
                if !equal { unknown = true; }
            } else {
                if key == "pool_workers" || key == "adapt_async" {
                    return Err(format!("此引擎没有公开 {key} 的有效状态；requested参数不证明已生效，候选不推荐并恢复原配置"));
                }
                unknown = true;
            }
            let status = if equal { "effective" } else if key == "prefill" { "upperBound" }
                else if key.starts_with("adapt_") { "startupRequest" } else { "reservationRequest" };
            verification.parameters.push(VerifiedParameter { name: key.into(), requested: want, observed: actual, status: status.into() });
        }
    }
    if !unknown {
        return Ok(verification);
    }
    // Upstream only emits pool_workers in INFO. Verify the other accepted
    // startup options on the exact live, owned engine command, not a port/PID guess.
    let config = storage::read(profile)?;
    let root = state
        .processes
        .lock()
        .map_err(|e| e.to_string())?
        .get_mut(&profile.id)
        .map(|p| p.refresh())
        .transpose()?
        .filter(|s| s.running && s.owned)
        .and_then(|s| s.pid)
        .ok_or("重启后服务归属不可核验")?;
    let cwd = config
        .get("cwd")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(&profile.install_dir));
    let exe = config["exe"].as_str().ok_or("引擎路径不可核验")?;
    let exe = Path::new(exe);
    let exe = dunce::canonicalize(if exe.is_absolute() {
        exe.to_path_buf()
    } else {
        cwd.join(exe)
    })
    .map_err(|_| "引擎文件不可核验")?;
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        true,
        sysinfo::ProcessRefreshKind::nothing()
            .with_cmd(sysinfo::UpdateKind::Always)
            .with_exe(sysinfo::UpdateKind::Always),
    );
    let fields = [
        ("--pool-workers", p.pool_workers.map(|v| v.to_string())),
        (
            "--adapt-async",
            p.adapt_async.map(|v| if v { "1" } else { "0" }.into()),
        ),
        ("--prefill", p.prefill.map(|v| v.to_string())),
        (
            "--vram-reserve-mib",
            p.vram_reserve_mib.map(|v| v.to_string()),
        ),
        ("--adapt-every", p.adapt_every.map(|v| v.to_string())),
        ("--adapt-swaps", p.adapt_swaps.map(|v| v.to_string())),
        ("--adapt-decay", p.adapt_decay.map(|v| v.to_string())),
    ];
    for (pid, process) in system.processes() {
        if pid.as_u32() == root {
            continue;
        }
        if process
            .exe()
            .and_then(|p| dunce::canonicalize(p).ok())
            .as_ref()
            != Some(&exe)
        {
            continue;
        }
        if !state
            .processes
            .lock()
            .map_err(|e| e.to_string())?
            .get(&profile.id)
            .ok_or("owned树消失")?
            .owns_pid(pid.as_u32())?
        {
            continue;
        }
        let args = process
            .cmd()
            .iter()
            .map(|a| a.to_string_lossy())
            .collect::<Vec<_>>();
        if fields.iter().all(|(flag, value)| {
            value.as_ref().is_none_or(|v| {
                args.windows(2).any(|a| a[0] == *flag && a[1] == v.as_str())
                    || args.iter().any(|a| a.as_ref() == format!("{flag}={v}"))
            })
        }) {
            return Ok(verification);
        }
    }
    Err("实际受管引擎启动参数不可核验；候选已拒绝并将恢复。此版本未公开所有effective参数，不能把requested当effective".into())
}
async fn reload(
    state: &Arc<RuntimeState>,
    profile: &ServiceProfile,
    token: &str,
    parameters: Parameters,
    cancel: &CancellationToken,
) -> Result<(), String> {
    crate::maintenance::wait_idle(state, profile).await?;
    require_owned(state, profile).await?;
    let response =
        http::request_builder(&state.client, profile, "/unload", "POST", Some(json!({})))?
            .header("X-Strata-Manager-Tuning-Id", token)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| "冷场景卸载失败")?;
    if !response.status().is_success() {
        return Err("冷场景卸载被拒绝".into());
    }
    let health =
        http::strata_request(state, profile.clone(), "/health".into(), "GET".into(), None).await?;
    if health["loaded"] != false {
        return Err("无法确认冷模型卸载，不能标记coldModelVerified".into());
    }
    // Loading is a cold boundary. A READY probe here would warm the cache before
    // the workload starts, so only load/health/parameters are inspected.
    tokio::select! {_=cancel.cancelled()=>Err("重新加载前取消".into()),result=async {
        let response=http::request_builder(&state.client,profile,"/load","POST",Some(json!({})))?.header("X-Strata-Manager-Tuning-Id",token).timeout(Duration::from_secs(300)).send().await.map_err(|_|"冷场景加载失败")?;
        if !response.status().is_success(){return Err("冷场景加载未成功".into());}
        let health=http::strata_request(state,profile.clone(),"/health".into(),"GET".into(),None).await?;
        if health["loaded"]!=true{return Err("冷场景加载后模型未就绪".into());}
        let actual=baseline_parameters(&read_metrics(state,profile).await?)?;
        if actual!=parameters{return Err("冷场景实际参数改变".into());}
        Ok(())
    }=>result}
}
pub(super) async fn run_full(
    state: Arc<RuntimeState>,
    profile: ServiceProfile,
    pid: u32,
    id: String,
    cancel: CancellationToken,
) -> Result<(), String> {
    let limits = read_job(&state, &id)?.full.limits;
    run_full_bounded(
        state,
        profile,
        pid,
        id,
        cancel,
        Duration::from_secs(limits.max_duration_seconds),
        Duration::from_secs(limits.recovery_deadline_seconds),
    )
    .await
}
struct DeadlineTask(tokio::task::JoinHandle<()>);
impl Drop for DeadlineTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}
async fn run_full_bounded(
    state: Arc<RuntimeState>,
    profile: ServiceProfile,
    pid: u32,
    id: String,
    parent_cancel: CancellationToken,
    measurement_limit: Duration,
    recovery_limit: Duration,
) -> Result<(), String> {
    let cancel = parent_cancel.child_token();
    let timed_out = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let deadline_cancel = cancel.clone();
    let deadline_timeout = timed_out.clone();
    let timer = DeadlineTask(tokio::spawn(async move {
        tokio::time::sleep(measurement_limit).await;
        deadline_timeout.store(true, std::sync::atomic::Ordering::Release);
        deadline_cancel.cancel();
    }));
    let lock = {
        let mut locks = state.ensure_locks.lock().await;
        locks.entry(profile.id.clone()).or_default().clone()
    };
    let _runtime_lock = lock.try_lock_owned().map_err(|_| "模型正在维护")?;
    let token = uuid::Uuid::new_v4().to_string();
    let _gate = crate::maintenance::begin(&state, &profile.id, Some(&token), "tuning")?;
    tokio::select! {_=cancel.cancelled()=>return Err("等待空闲时取消，原配置未变".into()),result=crate::maintenance::wait_idle(&state,&profile)=>result?};
    if require_owned(&state, &profile).await? != pid {
        return Err("完整测量前服务身份改变".into());
    }
    let job = update(&state, &id, |job| {
        job.state = Phase::Running;
        job.current_step = "fullScenario".into();
    })?;
    let bytes = fs::read(assert_managed_config(&state, &profile)?).map_err(|e| e.to_string())?;
    if fingerprint(&bytes) != job.config_fingerprint {
        return Err("完整场景开始前配置变化".into());
    }
    atomic_bytes(
        &report_dir(&state).join(format!("{}.original", job.id)),
        &bytes,
    )?;
    // Even a request-only cold workload unloads the model. Journal original
    // loaded state before that boundary, so cancellation/crash restores it.
    journal(
        &state,
        &Journal {
            job_id: job.id.clone(),
            profile: profile.clone(),
            original_sha256: job.config_fingerprint.clone(),
            target_sha256: job.config_fingerprint.clone(),
            previous_sha256: None,
            restored: false,
        },
    )?;
    update(&state, &id, |job| {
        job.full.recovery.state = RecoveryState::Pending
    })?;
    let opts = options(&job.full, job.max_tokens)?;
    let specs = workloads::plan(&opts)?;
    let result = async {
        for round in 0..job.rounds {
            let candidates: Vec<_> = if round % 2 == 0 {
                job.candidates.iter().collect()
            } else {
                job.candidates.iter().rev().collect()
            };
            for candidate in candidates {
                for spec in &specs {
                    for position in [
                        Position::BaselineBefore,
                        Position::Candidate,
                        Position::BaselineAfter,
                    ] {
                        if cancel.is_cancelled() {
                            return Err("已取消完整场景测量".into());
                        }
                        if position == Position::Candidate
                            && candidate.kind == CandidateKind::Restart
                        {
                            switch_stage(&state, &profile, &job, candidate, &token, &cancel)
                                .await?;
                        }
                        if position == Position::BaselineAfter
                            && candidate.kind == CandidateKind::Restart
                        {
                            restore_stage(&state, &profile, &id, &token, false).await?;
                        }
                        let parameters = if position == Position::Candidate {
                            candidate.parameters()
                        } else {
                            job.baseline
                        };
                        require_owned(&state, &profile).await?;
                        let kind = serde_json::to_value(spec.kind)
                            .map_err(|e| e.to_string())?
                            .as_str()
                            .ok_or("工作负载类型无效")?
                            .to_owned();
                        update(&state, &id, |job| {
                            job.current_step = format!(
                                "{} / {} / {:?} / {}",
                                candidate.id,
                                spec.id,
                                position,
                                round + 1
                            );
                            job.full.progress.phase = match position {
                                Position::BaselineBefore => "baselineBefore",
                                Position::Candidate => "candidate",
                                Position::BaselineAfter => "baselineAfter",
                            }
                            .into();
                            job.full.progress.candidate_id = Some(candidate.id.clone());
                            job.full.progress.workload_kind = Some(kind.clone());
                            job.full.progress.round = Some(round + 1);
                        })?;
                        let freshly_loaded = matches!(
                            spec.kind,
                            WorkloadKind::ColdInput
                                | WorkloadKind::SessionSwitch
                                | WorkloadKind::LongRetrieval
                        );
                        if freshly_loaded {
                            reload(
                                &state,
                                &profile,
                                &token,
                                if candidate.kind == CandidateKind::Request {
                                    job.baseline
                                } else {
                                    parameters
                                },
                                &cancel,
                            )
                            .await?;
                        }
                        let result = workloads::run_workload(
                            &state,
                            &profile,
                            parameters,
                            &token,
                            spec,
                            &opts,
                            &cancel,
                            freshly_loaded,
                        )
                        .await?;
                        let complete =
                            result["complete"] == true && result["qualityPassed"] == true;
                        update(&state, &id, |job| {
                            job.completed_requests +=
                                result["requestCount"].as_u64().unwrap_or(0) as usize;
                            job.full.progress.completed_workloads += 1;
                            job.full.workload_measurements.push(WorkloadMeasurement {
                                id: uuid::Uuid::new_v4().to_string(),
                                candidate_id: candidate.id.clone(),
                                round,
                                position,
                                workload_id: spec.id.clone(),
                                kind: spec.kind,
                                freshly_loaded,
                                result: result.clone(),
                            });
                        })?;
                        if !complete {
                            return Err(format!(
                                "{}未完成或未通过语义验收：{}",
                                spec.id,
                                result["qualityReason"]
                                    .as_str()
                                    .unwrap_or("incompleteWorkload")
                            ));
                        }
                        crate::maintenance::wait_idle(&state, &profile).await?;
                    }
                }
            }
        }
        Ok(())
    }
    .await;
    // Cancellation is intentionally not supplied to rollback/health verification.
    drop(timer);
    let recovery = if load_journal(&state, &id)?.is_some() {
        tokio::time::timeout(
            recovery_limit,
            restore_stage(&state, &profile, &id, &token, true),
        )
        .await
        .unwrap_or_else(|_| Err("原服务恢复超过硬时限；恢复journal仍保留，不能宣称恢复成功".into()))
    } else {
        let alive = require_owned(&state, &profile).await;
        match alive {
            Ok(current) => {
                wait_idle_after_disconnect(&state, &profile, current, Duration::from_secs(30))
                    .await
                    .map(|_| ())
            }
            Err(error) => Err(error),
        }
    };
    if let Err(error) = recovery {
        update(&state, &id, |job| {
            job.full.recovery.state = RecoveryState::Failed;
            job.full.recovery.error = Some(error.clone());
        })?;
        return Err(format!(
            "{}；原配置/服务恢复失败：{error}",
            result.err().unwrap_or_else(|| "场景已结束".into())
        ));
    }
    if timed_out.load(std::sync::atomic::Ordering::Acquire) {
        return Err(
            "完整场景达到任务总时限，已停止测量并独立复验恢复原配置/服务；没有生成推荐".into(),
        );
    }
    result?;
    let config = fs::read(assert_managed_config(&state, &profile)?).map_err(|e| e.to_string())?;
    if fingerprint(&config) != job.config_fingerprint {
        return Err("完整场景完成后原配置hash不同".into());
    }
    if bound_identity(
        &profile,
        &serde_json::from_slice(&config).map_err(|e| e.to_string())?,
        &read_metrics(&state, &profile).await?,
        &job,
    ) != job.identity
    {
        return Err("完整场景完成后模型/引擎/硬件身份改变".into());
    }
    update(&state, &id, |job| {
        let resources = job
            .candidates
            .iter()
            .map(|c| (c.id.clone(), assess_resources(job, &c.id)))
            .collect::<HashMap<_, _>>();
        for candidate in &mut job.candidates {
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
                // Every tier must qualify. A passing shorter tier cannot hide
                // a noisier or incomplete longer tier merely by having less gain.
                if dimensions
                    .get(&key)
                    .is_none_or(|old| worse_dimension(&evaluation, old))
                {
                    dimensions.insert(key, evaluation);
                }
            }
            let resource = resources[&candidate.id].clone();
            let accepted = dimensions.values().all(|e| e.accepted)
                && resource.status == ResourceStatus::Checked;
            let gains = dimensions
                .values()
                .filter_map(|e| e.gain)
                .collect::<Vec<_>>();
            candidate.evaluation = Some(Evaluation {
                gain: median(&gains),
                drift: dimensions
                    .values()
                    .filter_map(|e| e.drift)
                    .max_by(f64::total_cmp),
                pairs: specs.len() * job.rounds,
                accepted,
                reason: if resource.status == ResourceStatus::Unknown {
                    "resourceUnknown"
                } else if resource.status == ResourceStatus::InsufficientHeadroom {
                    "insufficientResourceHeadroom"
                } else if accepted {
                    "fullScenarioGain"
                } else {
                    "noReliableFullScenarioGain"
                }
                .into(),
            });
            candidate.resource_assessment = Some(resource);
            candidate.dimensions = dimensions;
        }
        job.recommended_candidate_id = job
            .candidates
            .iter()
            .filter(|c| c.evaluation.as_ref().is_some_and(|e| e.accepted))
            .max_by(|a, b| {
                a.evaluation
                    .as_ref()
                    .and_then(|e| e.gain)
                    .unwrap_or(0.)
                    .total_cmp(&b.evaluation.as_ref().and_then(|e| e.gain).unwrap_or(0.))
            })
            .map(|c| c.id.clone());
        job.state = Phase::Completed;
        job.full.progress.phase = "finished".into();
        job.current_step = "finished".into();
        job.finished_at = Some(now());
    })?;
    Ok(())
}
fn worse_dimension(candidate: &Evaluation, previous: &Evaluation) -> bool {
    if candidate.accepted != previous.accepted {
        !candidate.accepted
    } else {
        candidate.gain.unwrap_or(-1.) < previous.gain.unwrap_or(-1.)
    }
}
fn evaluate_workload(
    samples: &[WorkloadMeasurement],
    candidate: &str,
    workload: &str,
    rounds: usize,
) -> Evaluation {
    let mut gains = vec![];
    let mut drifts = vec![];
    for round in 0..rounds {
        let find = |position| {
            samples.iter().find(|s| {
                s.candidate_id == candidate
                    && s.workload_id == workload
                    && s.round == round
                    && s.position == position
            })
        };
        let (Some(a), Some(b), Some(c)) = (
            find(Position::BaselineBefore),
            find(Position::Candidate),
            find(Position::BaselineAfter),
        ) else {
            return Evaluation {
                gain: None,
                drift: None,
                pairs: gains.len(),
                accepted: false,
                reason: "incompleteWorkloads".into(),
            };
        };
        if [a, b, c]
            .iter()
            .any(|s| s.result["complete"] != true || s.result["qualityPassed"] != true)
        {
            return Evaluation {
                gain: None,
                drift: None,
                pairs: gains.len(),
                accepted: false,
                reason: "semanticQualityFailed".into(),
            };
        }
        let wall = |s: &WorkloadMeasurement| {
            // Document count_tokens calibration remains in total task wallMs,
            // but must not masquerade as engine generation speed. Agent score
            // intentionally includes its real tool loop and semantic tests.
            let value = if s.kind == WorkloadKind::FullAgent {
                s.result["fullAgentWallMs"].as_f64()
            } else {
                s.result["turns"]
                    .as_array()
                    .and_then(|turns| {
                        turns
                            .iter()
                            .map(|t| t["wallMs"].as_f64().filter(|v| v.is_finite() && *v > 0.))
                            .collect::<Option<Vec<_>>>()
                    })
                    .map(|turns| turns.iter().sum())
            };
            value.filter(|v| v.is_finite() && *v > 0.)
        };
        let (Some(a), Some(b), Some(c)) = (wall(a), wall(b), wall(c)) else {
            return Evaluation {
                gain: None,
                drift: None,
                pairs: gains.len(),
                accepted: false,
                reason: "missingWorkloadTimings".into(),
            };
        };
        let baseline = (a + c) / 2.;
        gains.push(baseline / b - 1.);
        drifts.push((a - c).abs() / baseline);
    }
    let gain = median(&gains);
    let drift = drifts.iter().copied().max_by(f64::total_cmp);
    let accepted = gain.zip(drift).is_some_and(|(g, d)| g > d)
        && gains.iter().zip(&drifts).all(|(g, d)| *g > 0. && g > d);
    Evaluation {
        gain,
        drift,
        pairs: gains.len(),
        accepted,
        reason: if accepted {
            "stableSemanticGain"
        } else {
            "noReliableGainBeyondDrift"
        }
        .into(),
    }
}
pub(super) fn validate_application(job: &TuningJob, candidate: &Candidate) -> Result<(), String> {
    if job.identity["benchmarkVersion"] != workloads::VERSION
        || job.full.progress.completed_workloads != job.full.progress.total_workloads
    {
        return Err("完整报告版本或工作负载覆盖不完整".into());
    }
    if candidate.kind == CandidateKind::Restart
        && candidate
            .startup_verification
            .as_ref()
            .is_none_or(|v| v.parameters.is_empty())
    {
        return Err("重启候选缺少实际受管引擎参数核验，不能应用".into());
    }
    if candidate
        .resource_assessment
        .as_ref()
        .is_none_or(|r| r.status != ResourceStatus::Checked)
        || assess_resources(job, &candidate.id).status != ResourceStatus::Checked
    {
        return Err("资源遥测未知或实测安全余量不足，不能应用候选".into());
    }
    let specs = workloads::plan(&options(&job.full, job.max_tokens)?)?;
    for spec in specs {
        if !evaluate_workload(
            &job.full.workload_measurements,
            &candidate.id,
            &spec.id,
            job.rounds,
        )
        .accepted
        {
            return Err("候选缺少完整A/B/A语义收益复验".into());
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "tuning_restart_tests.rs"]
mod tests;
pub(super) fn recover_pending(state: &Arc<RuntimeState>) -> Result<(), String> {
    let directory = report_dir(state);
    if !directory.exists() {
        return Ok(());
    }
    for item in fs::read_dir(&directory).map_err(|e| e.to_string())? {
        let path = item.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("stage") {
            continue;
        }
        let id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or("恢复任务路径无效")?;
        let Some(stage) = load_journal(state, id)? else {
            continue;
        };
        if stage.restored && !has_active_stage(state, id)? {
            continue;
        }
        let mut job = read_job(state, id)?;
        let profile = state.registered_profile(&job.profile_id)?;
        if stage.job_id != id
            || serde_json::to_value(&profile).map_err(|e| e.to_string())?
                != serde_json::to_value(&stage.profile).map_err(|e| e.to_string())?
            || stage.original_sha256 != job.config_fingerprint
        {
            return Err("恢复阶段身份不一致，未覆盖配置".into());
        }
        let config = assert_managed_config(state, &profile)?;
        let bytes = fs::read(&config).map_err(|e| e.to_string())?;
        let hash = fingerprint(&bytes);
        if hash != stage.target_sha256
            && hash != stage.original_sha256
            && stage.previous_sha256.as_ref() != Some(&hash)
        {
            return Err("中断后配置已被另行编辑，未覆盖；请修复调优恢复journal".into());
        }
        let original = original(state, &job)?;
        if crate::external::port_accepting(&profile)?
            || crate::discovery::has_running_installation(Path::new(&profile.install_dir))?
        {
            return Err("中断恢复发现仍运行的未知实例，未覆盖配置或启动第二模型".into());
        }
        if fs::read(&config).map_err(|e| e.to_string())? != bytes {
            return Err("中断恢复核验期间配置被另行编辑，未覆盖".into());
        }
        atomic_bytes(&config, &original)?;
        job.state = Phase::RollingBack;
        job.full.recovery = Recovery {
            state: RecoveryState::Pending,
            configuration_restored: true,
            service_verified: false,
            error: None,
        };
        job.error = Some("后台中断；原配置字节已恢复，正在复验原服务".into());
        persist(state, &job)?;
        register_active(state, &job, CancellationToken::new())?;
        let state = state.clone();
        let id = id.to_owned();
        let future = async move {
            let operation = async {
                let native_operation = NativeOperation::new();
                let selected = crate::store_get(&state, "activeLocalInstallation".into())?;
                if selected.as_str().is_some_and(|s| s != profile.id) {
                    return Err("恢复时已有另一模型选择，未启动旧模型；原配置已还原".into());
                }
                let lock = {
                    let mut locks = state.ensure_locks.lock().await;
                    locks.entry(profile.id.clone()).or_default().clone()
                };
                let _lock = lock.lock_owned().await;
                crate::start_service_for_tuning(
                    state.clone(),
                    profile.clone(),
                    &id,
                    &native_operation.0,
                )
                .await?;
                let token = uuid::Uuid::new_v4().to_string();
                // No owned /load or READY probe precedes admission closure.
                wait_restarted_api(&state, &profile).await?;
                let _gate = crate::maintenance::begin(&state, &profile.id, Some(&token), "tuning")?;
                crate::maintenance::wait_idle(&state, &profile).await?;
                restore_stage(&state, &profile, &id, &token, true).await
            };
            let result = tokio::time::timeout(
                Duration::from_secs(job.full.limits.recovery_deadline_seconds),
                operation,
            )
            .await
            .unwrap_or_else(|_| Err("中断恢复超过硬时限，journal保留且服务未被宣称恢复".into()));
            let _ = update(&state, &id, |job| {
                job.state = if result.is_ok() {
                    Phase::Interrupted
                } else {
                    Phase::Failed
                };
                job.finished_at = Some(now());
                job.current_step = "finished".into();
                job.full.progress.phase = "finished".into();
                if let Err(error) = &result {
                    job.error = Some(format!("中断恢复失败：{error}"));
                    job.full.recovery.state = RecoveryState::Failed;
                    job.full.recovery.error = Some(error.clone());
                }
            });
        };
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(future);
        } else {
            std::thread::spawn(move || {
                match tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                {
                    Ok(rt) => rt.block_on(future),
                    Err(error) => eprintln!("调优恢复运行时失败：{error}"),
                }
            });
        }
    }
    Ok(())
}
