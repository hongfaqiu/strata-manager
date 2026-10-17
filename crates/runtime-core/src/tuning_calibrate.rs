//! Quick calibration, following upstream Strata's official scheme
//! (`tools/calibrate.py`, `setup.sh --calibrate`): request-level sweeps of the
//! hardware-dependent settings through one running engine, every value visited
//! `SWEEP_ROUNDS` times in alternating order, the median deciding, and a final
//! interleaved confirmation against the current settings. A setting is only
//! recommended when it beats the current one by more than `MIN_GAIN`.
//!
//! Differences from upstream, on purpose:
//! - nothing is written here. Applying (new config version or overwrite) is a
//!   separate, explicit user action;
//! - a sweep keeps the current value unless another beats it by more than
//!   `MIN_GAIN`, so the saved values never contradict the printed winners
//!   (upstream #2465);
//! - `pcie_frac` 0 is never measured or recommended unless the GPU is a
//!   confirmed NVIDIA card (upstream #2498: it wedges AMD gfx1201 at boot);
//! - restart-bound settings (CPU workers, expert tier, AMD shared-expert
//!   stream) are not restarted here. They are returned as suggested candidates
//!   for the scenario verification, which already restarts under a journal.
use super::*;

pub const MIN_GAIN: f64 = 0.03;
pub const PCIE_FRACS: [f64; 7] = [0.0, 0.2, 0.35, 0.55, 0.75, 0.9, 1.0];
pub const SPEC_MIN_PS: [f64; 3] = [0.3, 0.5, 0.7];
pub const PIPE_VALUES: [f64; 6] = [0.0, 1.0, 768.0, 1536.0, 3072.0, 6144.0];
pub const PIPE_TOKENS: [usize; 2] = [2048, 8192];
pub const SWEEP_ROUNDS: usize = 3;
pub const WARMUP_ROUNDS: usize = 2;
pub const MAX_NEW: usize = 128;
const PROMPTS: [Scene; 3] = [Scene::Code, Scene::Chat, Scene::Chinese];

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Backend {
    Cuda,
    Hip,
    Sycl,
    Unknown,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StepKind {
    Warmup,
    PrefillPipe,
    PcieFrac,
    SpecMinP,
    Confirm,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StepStatus {
    Pending,
    Running,
    Done,
    Skipped,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub value: f64,
    pub round: usize,
    /// Decode tok/s (prompt read tok/s for the prompt-chunk step).
    pub rate: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Excluded {
    pub value: f64,
    pub reason: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub kind: StepKind,
    pub status: StepStatus,
    /// "decode" or "prompt".
    pub metric: String,
    pub values: Vec<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_value: Option<f64>,
    pub rounds: usize,
    pub requests: usize,
    pub samples: Vec<Sample>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub best: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chosen: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub excluded: Vec<Excluded>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped_reason: Option<String>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationParameters {
    pub pcie_frac: f64,
    pub spec_min_p: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefill_pipe: Option<f64>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CalibrateRequest {
    /// 2-4 sweep rounds; default 3 like upstream.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rounds: Option<usize>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationJob {
    pub id: String,
    pub profile_id: String,
    pub kind: String,
    pub state: Phase,
    pub started_at: u64,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    pub backend: Backend,
    pub layer_split: bool,
    pub rounds: usize,
    pub min_gain: f64,
    pub baseline: CalibrationParameters,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<CalibrationParameters>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended: Option<CalibrationParameters>,
    /// Engine flags to write when applying, e.g. {"--pcie-frac": "0.35"}.
    pub settings: serde_json::Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gain: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tuned_rate: Option<f64>,
    pub steps: Vec<Step>,
    pub completed_requests: usize,
    pub total_requests: usize,
    /// Official worker / expert-tier grids for the scenario verification.
    pub restart_suggestions: Vec<RestartParameters>,
    pub identity: Value,
    pub config_fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub notes: Vec<String>,
    /// Sanitized, size-capped copy of the live log, attached when the job ends.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub live_log: Vec<live::LiveLogLine>,
}

// ---------------------------------------------------------------- pure logic

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

pub fn detect_backend(config: &Value, metrics: &Value) -> Backend {
    match config.get("backend").and_then(Value::as_str) {
        Some("hip") => return Backend::Hip,
        Some("sycl") => return Backend::Sycl,
        Some("cuda") => return Backend::Cuda,
        _ => {}
    }
    let text = serde_json::to_string(&metrics["hardware_static"])
        .unwrap_or_default()
        .to_ascii_lowercase();
    if ["amd", "radeon", "gfx1", "gfx9", "hip"]
        .iter()
        .any(|key| text.contains(key))
    {
        Backend::Hip
    } else if ["intel arc", "sycl", "level-zero"]
        .iter()
        .any(|key| text.contains(key))
    {
        Backend::Sycl
    } else if ["nvidia", "geforce", "rtx", "tesla", "quadro", "cuda"]
        .iter()
        .any(|key| text.contains(key))
    {
        Backend::Cuda
    } else {
        Backend::Unknown
    }
}

pub fn detect_layer_split(config: &Value, metrics: &Value) -> bool {
    if let Some(stages) = metrics["engine"]["prefill_stages"].as_u64() {
        return stages > 1;
    }
    let args_split = config
        .get("args")
        .and_then(Value::as_array)
        .is_some_and(|args| {
            args.iter().any(|arg| {
                arg.as_str()
                    .is_some_and(|a| a == "--layer-split" || a.starts_with("--layer-split="))
            })
        });
    let key_split = match config.get("layer_split") {
        Some(Value::String(text)) => !text.trim().is_empty() && text.trim() != "0",
        Some(Value::Number(n)) => n.as_f64().is_some_and(|v| v > 0.0),
        Some(Value::Bool(b)) => *b,
        _ => false,
    };
    args_split || key_split
}

/// The official PCIe grid plus the current value. `pcie_frac` 0 is excluded
/// unless the card is a confirmed NVIDIA GPU.
pub fn pcie_values(current: f64, backend: Backend) -> (Vec<f64>, Vec<Excluded>) {
    let mut values: Vec<f64> = PCIE_FRACS.to_vec();
    values.push(round2(current));
    values.sort_by(f64::total_cmp);
    values.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    let mut excluded = vec![];
    if backend != Backend::Cuda {
        values.retain(|value| {
            if *value <= 0.0 {
                excluded.push(Excluded {
                    value: *value,
                    reason: if backend == Backend::Hip {
                        "amdPcieZero".into()
                    } else {
                        "unconfirmedGpuPcieZero".into()
                    },
                });
                false
            } else {
                true
            }
        });
    }
    (values, excluded)
}

pub fn spec_values(current: f64) -> Vec<f64> {
    let mut values: Vec<f64> = SPEC_MIN_PS.to_vec();
    values.push(round2(current));
    values.sort_by(f64::total_cmp);
    values.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    values
}

pub fn sweep_order(values: &[f64], round: usize) -> Vec<f64> {
    if round.is_multiple_of(2) {
        values.to_vec()
    } else {
        values.iter().rev().copied().collect()
    }
}

pub fn medians(samples: &[Sample], values: &[f64]) -> Vec<(f64, Option<f64>)> {
    values
        .iter()
        .map(|value| {
            let rates: Vec<f64> = samples
                .iter()
                .filter(|s| (s.value - value).abs() < 1e-9 && s.rate > 0.0)
                .map(|s| s.rate)
                .collect();
            (*value, median(&rates))
        })
        .collect()
}

/// The value with the best median, unless it does not beat the current value
/// by more than `MIN_GAIN` (then the current value stays).
pub fn sweep_winner(samples: &[Sample], values: &[f64], current: f64) -> (Option<f64>, f64) {
    let table = medians(samples, values);
    let best = table
        .iter()
        .filter_map(|(value, rate)| rate.map(|rate| (*value, rate)))
        .max_by(|a, b| a.1.total_cmp(&b.1));
    let Some((best_value, best_rate)) = best else {
        return (None, current);
    };
    let current_rate = table
        .iter()
        .find(|(value, _)| (value - current).abs() < 1e-9)
        .and_then(|(_, rate)| *rate);
    let chosen = match current_rate {
        Some(rate) if best_rate <= rate * (1.0 + MIN_GAIN) => current,
        Some(_) => best_value,
        None => best_value,
    };
    (Some(best_value), chosen)
}

/// Upstream `pick`: the candidate wins only above `MIN_GAIN` in the median.
pub fn confirm_gain(default_rates: &[f64], candidate_rates: &[f64]) -> (Option<f64>, bool) {
    match (median(default_rates), median(candidate_rates)) {
        (Some(d), Some(c)) if d > 0.0 => {
            let gain = c / d - 1.0;
            (Some(gain), gain > MIN_GAIN)
        }
        _ => (None, false),
    }
}

/// Prompt chunks are kept only when faster in every paired round and by more
/// than `MIN_GAIN` in the median (upstream `measure_pipe`).
pub fn pipe_confirmed(default_rates: &[f64], candidate_rates: &[f64]) -> bool {
    let gains: Vec<f64> = default_rates
        .iter()
        .zip(candidate_rates)
        .filter(|(d, _)| **d > 0.0)
        .map(|(d, c)| c / d - 1.0)
        .collect();
    !gains.is_empty()
        && gains.len() == default_rates.len()
        && gains.iter().all(|g| *g > 0.0)
        && median(&gains).is_some_and(|g| g > MIN_GAIN)
}

/// Upstream `worker_candidates`: two thirds, a half, a quarter (at least 2).
pub fn worker_candidates(default: usize) -> Vec<usize> {
    let mut out = vec![];
    for w in [
        (default as f64 * 2.0 / 3.0).round() as usize,
        (default as f64 / 2.0).round() as usize,
        (default as f64 / 4.0).round() as usize,
    ] {
        if (2..default).contains(&w) && !out.contains(&w) {
            out.push(w);
        }
    }
    out
}

/// At most four restart candidates for the scenario verification: two worker
/// counts and upstream's two expert-tier presets.
pub fn restart_suggestions(default_workers: Option<usize>) -> Vec<RestartParameters> {
    let mut out: Vec<RestartParameters> = default_workers
        .map(worker_candidates)
        .unwrap_or_default()
        .into_iter()
        .take(2)
        .map(|w| RestartParameters {
            pool_workers: Some(w),
            ..RestartParameters::default()
        })
        .collect();
    for swaps in [80, 160] {
        out.push(RestartParameters {
            adapt_every: Some(1),
            adapt_swaps: Some(swaps),
            adapt_decay: Some(0.97),
            ..RestartParameters::default()
        });
    }
    out.truncate(4);
    out
}

pub fn settings_for(
    baseline: CalibrationParameters,
    recommended: CalibrationParameters,
) -> serde_json::Map<String, Value> {
    let mut settings = serde_json::Map::new();
    if (recommended.pcie_frac - baseline.pcie_frac).abs() > 1e-9
        || (recommended.spec_min_p - baseline.spec_min_p).abs() > 1e-9
    {
        settings.insert(
            "--pcie-frac".into(),
            json!(format!("{:.2}", recommended.pcie_frac)),
        );
        settings.insert(
            "--spec-min-p".into(),
            json!(format!("{:.2}", recommended.spec_min_p)),
        );
    }
    if let Some(pipe) = recommended.prefill_pipe.filter(|p| *p > 0.0) {
        if recommended.prefill_pipe != baseline.prefill_pipe {
            settings.insert("--prefill-pipe".into(), json!(format!("{}", pipe as u64)));
        }
    }
    settings
}

pub struct Plan {
    pub steps: Vec<Step>,
    pub total_requests: usize,
}

fn step(
    kind: StepKind,
    metric: &str,
    values: Vec<f64>,
    current: Option<f64>,
    rounds: usize,
    requests: usize,
) -> Step {
    Step {
        kind,
        status: StepStatus::Pending,
        metric: metric.into(),
        values,
        current_value: current,
        rounds,
        requests,
        samples: vec![],
        best: None,
        chosen: None,
        excluded: vec![],
        skipped_reason: None,
    }
}

pub fn plan(
    baseline: CalibrationParameters,
    backend: Backend,
    layer_split: bool,
    max_context: Option<u64>,
    rounds: usize,
) -> Plan {
    let prompts = PROMPTS.len();
    let mut steps = vec![step(
        StepKind::Warmup,
        "decode",
        vec![],
        None,
        WARMUP_ROUNDS,
        WARMUP_ROUNDS * prompts,
    )];
    let pipe_reads: Vec<usize> = PIPE_TOKENS
        .iter()
        .copied()
        .filter(|n| max_context.is_none_or(|ctx| (*n as u64) + 512 <= ctx))
        .collect();
    if layer_split && !pipe_reads.is_empty() {
        // one warm read, one pass over the values, then paired confirmation
        let reads = pipe_reads.len();
        let requests = reads * (1 + PIPE_VALUES.len() + rounds * 2);
        steps.push(step(
            StepKind::PrefillPipe,
            "prompt",
            PIPE_VALUES.to_vec(),
            Some(baseline.prefill_pipe.unwrap_or(0.0)),
            rounds,
            requests,
        ));
    } else {
        let mut skipped = step(
            StepKind::PrefillPipe,
            "prompt",
            PIPE_VALUES.to_vec(),
            Some(0.0),
            rounds,
            0,
        );
        skipped.status = StepStatus::Skipped;
        skipped.skipped_reason = Some(if layer_split {
            "contextTooSmall".into()
        } else {
            "noLayerSplit".into()
        });
        steps.push(skipped);
    }
    let (pcie, excluded) = pcie_values(baseline.pcie_frac, backend);
    let mut pcie_step = step(
        StepKind::PcieFrac,
        "decode",
        pcie.clone(),
        Some(round2(baseline.pcie_frac)),
        rounds,
        pcie.len() * rounds * prompts,
    );
    pcie_step.excluded = excluded;
    steps.push(pcie_step);
    let spec = spec_values(baseline.spec_min_p);
    steps.push(step(
        StepKind::SpecMinP,
        "decode",
        spec.clone(),
        Some(round2(baseline.spec_min_p)),
        rounds,
        spec.len() * rounds * prompts,
    ));
    steps.push(step(
        StepKind::Confirm,
        "decode",
        vec![0.0, 1.0],
        Some(0.0),
        rounds,
        2 * rounds * prompts,
    ));
    let total_requests = steps.iter().map(|s| s.requests).sum();
    Plan {
        steps,
        total_requests,
    }
}

fn pipe_messages(read: usize, tokens: usize) -> Value {
    const PARAGRAPH: &str = "A mixture-of-experts model routes every token to a few experts. The engine keeps the most used experts in graphics memory, streams the others over PCIe or computes them on the CPU, and reads the prompt in chunks so that every stage of a layer split stays busy. ";
    let chars = tokens * 4;
    let mut body = String::with_capacity(chars + PARAGRAPH.len());
    while body.len() < chars {
        body.push_str(PARAGRAPH);
    }
    body.truncate(chars);
    json!([{"role":"user","content":format!("[calibration read {read}] Summarize in one word:\n{body}")}])
}

// ------------------------------------------------------------ registry/state

struct CalEntry {
    job: CalibrationJob,
    cancel: CancellationToken,
}
type CalRegistry = HashMap<PathBuf, HashMap<String, CalEntry>>;
fn cal_registry() -> &'static Mutex<CalRegistry> {
    static REGISTRY: OnceLock<Mutex<CalRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}
fn cal_path(state: &RuntimeState, id: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "无效校准任务标识")?;
    Ok(report_dir(state).join(format!("calibrate-{id}.json")))
}
fn latest_path(state: &RuntimeState, profile_id: &str) -> PathBuf {
    let safe: String = profile_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    report_dir(state).join(format!("calibrate-latest-{safe}.txt"))
}
fn cal_persist(state: &RuntimeState, job: &CalibrationJob) -> Result<(), String> {
    fs::create_dir_all(report_dir(state)).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(job).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_REPORT_BYTES {
        return Err("校准报告超过持久化大小限制".into());
    }
    atomic_bytes(&cal_path(state, &job.id)?, &bytes)?;
    atomic_bytes(&latest_path(state, &job.profile_id), job.id.as_bytes())
}
fn cal_update(
    state: &RuntimeState,
    id: &str,
    f: impl FnOnce(&mut CalibrationJob),
) -> Result<CalibrationJob, String> {
    let mut registry = cal_registry().lock().map_err(|e| e.to_string())?;
    let entry = registry
        .get_mut(state.data_dir())
        .and_then(|jobs| jobs.get_mut(id))
        .ok_or("校准任务不存在")?;
    f(&mut entry.job);
    entry.job.updated_at = now();
    cal_persist(state, &entry.job)?;
    Ok(entry.job.clone())
}
pub fn any_active(state: &RuntimeState) -> Result<bool, String> {
    Ok(cal_registry()
        .lock()
        .map_err(|e| e.to_string())?
        .get(state.data_dir())
        .is_some_and(|jobs| jobs.values().any(|entry| entry.job.state.active())))
}
pub fn status(state: &RuntimeState, profile_id: String) -> Result<Option<CalibrationJob>, String> {
    state.registered_profile(&profile_id)?;
    let live = cal_registry()
        .lock()
        .map_err(|e| e.to_string())?
        .get(state.data_dir())
        .and_then(|jobs| {
            jobs.values()
                .filter(|entry| entry.job.profile_id == profile_id)
                .max_by_key(|entry| (entry.job.state.active(), entry.job.started_at))
                .map(|entry| entry.job.clone())
        });
    if live.is_some() {
        return Ok(live);
    }
    let Ok(id) = fs::read_to_string(latest_path(state, &profile_id)) else {
        return Ok(None);
    };
    let Ok(bytes) = fs::read(cal_path(state, id.trim())?) else {
        return Ok(None);
    };
    let mut job: CalibrationJob = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if job.profile_id != profile_id {
        return Ok(None);
    }
    if job.state.active() {
        job.state = Phase::Interrupted;
        job.finished_at.get_or_insert(job.updated_at);
        job.error = Some("后台曾中断，校准未完成；配置未改变".into());
    }
    Ok(Some(job))
}
pub fn cancel(state: &RuntimeState, job_id: String) -> Result<(), String> {
    let mut registry = cal_registry().lock().map_err(|e| e.to_string())?;
    let entry = registry
        .get_mut(state.data_dir())
        .and_then(|jobs| jobs.get_mut(&job_id))
        .ok_or("当前后台没有此校准任务")?;
    if !matches!(
        entry.job.state,
        Phase::Checking | Phase::Running | Phase::Canceling
    ) {
        return Err("只有正在进行的校准可以取消".into());
    }
    entry.cancel.cancel();
    entry.job.state = Phase::Canceling;
    entry.job.updated_at = now();
    cal_persist(state, &entry.job)
}

pub async fn start(
    state: Arc<RuntimeState>,
    profile_id: String,
    request: CalibrateRequest,
) -> Result<CalibrationJob, String> {
    let rounds = request.rounds.unwrap_or(SWEEP_ROUNDS);
    if !(2..=4).contains(&rounds) {
        return Err("校准轮数须为 2–4".into());
    }
    crate::runtime_upgrade::assert_available(&state)?;
    super::assert_available(&state)?;
    let profile = state.registered_profile(&profile_id)?;
    let config_path = assert_managed_config(&state, &profile)?;
    let pid = require_owned(&state, &profile).await?;
    let health = http::strata_request(
        &state,
        profile.clone(),
        "/health".into(),
        "GET".into(),
        None,
    )
    .await?;
    if health.get("loaded").and_then(Value::as_bool) != Some(true) {
        return Err("请先准备模型，校准需要已加载的模型".into());
    }
    let metrics = read_metrics(&state, &profile).await?;
    let current = baseline_parameters(&metrics)?;
    let bytes = fs::read(&config_path).map_err(|e| e.to_string())?;
    let config: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let backend = detect_backend(&config, &metrics);
    let layer_split = detect_layer_split(&config, &metrics);
    let prefill_pipe = metrics["engine"]
        .get("prefill_pipe")
        .and_then(engine_number);
    let baseline = CalibrationParameters {
        pcie_frac: current.pcie_frac,
        spec_min_p: current.spec_min_p,
        prefill_pipe: if layer_split {
            Some(prefill_pipe.unwrap_or(0.0))
        } else {
            None
        },
    };
    let max_context = metrics["engine"]["max_context"].as_u64();
    let Plan {
        steps,
        total_requests,
    } = plan(baseline, backend, layer_split, max_context, rounds);
    let workers = metrics["engine"]
        .get("pool_workers")
        .and_then(engine_number)
        .map(|w| w as usize)
        .filter(|w| *w > 0);
    let job = CalibrationJob { live_log: vec![],
        id: uuid::Uuid::new_v4().to_string(),
        profile_id: profile.id.clone(),
        kind: "quickCalibrate".into(),
        state: Phase::Checking,
        started_at: now(),
        updated_at: now(),
        finished_at: None,
        backend,
        layer_split,
        rounds,
        min_gain: MIN_GAIN,
        baseline,
        candidate: None,
        recommended: None,
        settings: serde_json::Map::new(),
        gain: None,
        base_rate: None,
        tuned_rate: None,
        steps,
        completed_requests: 0,
        total_requests,
        restart_suggestions: restart_suggestions(workers),
        identity: json!({"model":metrics["engine"]["model"],"engineVersion":metrics["engine"]["version"],"maxContext":max_context,"poolWorkers":workers,"hardware":metrics["hardware_static"],"scheme":"strata-calibrate-v1"}),
        config_fingerprint: fingerprint(&bytes),
        error: None,
        notes: vec![
            "Follows upstream tools/calibrate.py: request-level sweeps in one engine, alternating order, median of rounds, interleaved confirmation, 3% minimum gain.".into(),
            "Nothing is written until you apply. Restart-bound settings are suggested for the scenario verification.".into(),
        ],
    };
    let token = CancellationToken::new();
    {
        let mut registry = cal_registry().lock().map_err(|e| e.to_string())?;
        let jobs = registry.entry(state.data_dir().to_path_buf()).or_default();
        if jobs.values().any(|entry| entry.job.state.active()) {
            return Err("正在校准，请等待完成或取消".into());
        }
        jobs.insert(
            job.id.clone(),
            CalEntry {
                job: job.clone(),
                cancel: token.clone(),
            },
        );
    }
    super::assert_no_active_tuning_jobs(&state)?;
    cal_persist(&state, &job)?;
    live::begin(&job.id, total_requests);
    let id = job.id.clone();
    tokio::spawn(async move {
        let result = run(state.clone(), profile, pid, id.clone(), token.clone()).await;
        if let Err(error) = result {
            let canceled = token.is_cancelled();
            live::log(&id, if canceled { "canceled" } else { "failed" }, json!({}));
            let _ = cal_update(&state, &id, |job| {
                job.finished_at = Some(now());
                job.state = if canceled {
                    Phase::Canceled
                } else {
                    Phase::Failed
                };
                job.error = Some(error);
                for step in &mut job.steps {
                    if step.status == StepStatus::Running {
                        step.status = StepStatus::Pending;
                    }
                }
            });
        }
        let log = live::end(&id);
        if !log.is_empty() {
            let _ = cal_update(&state, &id, |job| job.live_log = log);
        }
    });
    Ok(job)
}

struct Runner<'a> {
    state: &'a Arc<RuntimeState>,
    profile: &'a ServiceProfile,
    pid: u32,
    id: &'a str,
    cancel: &'a CancellationToken,
    token: &'a str,
    step_index: usize,
    step_total: usize,
}

impl Runner<'_> {
    async fn request(
        &self,
        parameters: Parameters,
        extra: Value,
        scene: Scene,
        messages: &Value,
        max_tokens: usize,
    ) -> Result<Measurement, String> {
        if self.cancel.is_cancelled() {
            return Err("已取消校准，配置未改变".into());
        }
        live::unit_started(self.id);
        // Calibration only measures throughput like upstream calibrate.py: the
        // prompt text varies by scene, but no answer is quality-graded.
        let _ = scene;
        let probe = Probe {
            parameters,
            messages,
            scene: Scene::Chat,
            max_tokens,
            maintenance_token: self.token,
            tune_extra: extra,
        };
        let record = live::scope(
            self.id.to_owned(),
            measure(self.state, self.profile, probe, self.cancel),
        )
        .await;
        if let Some(error) = &record.error {
            return Err(error.clone());
        }
        live::unit_finished(self.id, record.decode_tok_s);
        cal_update(self.state, self.id, |job| job.completed_requests += 1)?;
        Ok(record)
    }
    /// Median decode tok/s over the three fixed prompts (upstream `Session.rate`).
    async fn rate(&self, parameters: Parameters) -> Result<f64, String> {
        if require_owned(self.state, self.profile).await? != self.pid {
            return Err("模型进程在校准中发生变化".into());
        }
        crate::inspect_idle_http(self.state, self.profile).await?;
        let mut rates = vec![];
        for scene in PROMPTS {
            let messages = prompt_for(scene, &uuid::Uuid::new_v4().to_string());
            let record = self
                .request(parameters, Value::Null, scene, &messages, MAX_NEW)
                .await?;
            let rate =
                record
                    .decode_tok_s
                    .or_else(|| match (record.output_tokens, record.decode_ms) {
                        (Some(n), Some(ms)) if n > 8 && ms > 0.0 => Some(n as f64 / (ms / 1000.0)),
                        _ => None,
                    });
            if let Some(rate) = rate.filter(|r| r.is_finite() && *r > 0.0) {
                rates.push(rate);
            }
        }
        median(&rates).ok_or_else(|| "引擎没有报告生成速度，无法校准".into())
    }
    /// Prompt read tok/s of fresh prompts (upstream `measure_pipe.rate`).
    async fn prompt_rate(
        &self,
        parameters: Parameters,
        pipe: f64,
        reads: &[usize],
        read: &mut usize,
    ) -> Result<f64, String> {
        let (mut ms, mut tokens) = (0.0, 0.0);
        for n in reads {
            *read += 1;
            let messages = pipe_messages(*read, *n);
            let record = self
                .request(
                    parameters,
                    json!({"prefill_pipe": pipe}),
                    Scene::Chat,
                    &messages,
                    1,
                )
                .await?;
            if let (Some(prompt_ms), Some(input)) = (record.prompt_ms, record.input_tokens) {
                ms += prompt_ms;
                tokens += input.saturating_sub(record.cached_tokens.unwrap_or(0)) as f64;
            }
        }
        Ok(if ms > 0.0 && tokens > 0.0 {
            tokens / (ms / 1000.0)
        } else {
            0.0
        })
    }
    fn enter(&mut self, kind: StepKind, parameters: Value, round: Option<(usize, usize)>) {
        let key = serde_json::to_value(kind)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        live::step(
            self.id,
            &key,
            self.step_index,
            self.step_total,
            parameters,
            round,
        );
    }
}

fn mark(job: &mut CalibrationJob, kind: StepKind, f: impl FnOnce(&mut Step)) {
    if let Some(step) = job.steps.iter_mut().find(|s| s.kind == kind) {
        f(step);
    }
}

async fn run(
    state: Arc<RuntimeState>,
    profile: ServiceProfile,
    pid: u32,
    id: String,
    cancel: CancellationToken,
) -> Result<(), String> {
    let lock = {
        let mut locks = state.ensure_locks.lock().await;
        locks.entry(profile.id.clone()).or_default().clone()
    };
    let _runtime_lock = lock
        .try_lock_owned()
        .map_err(|_| "模型正在准备或维护，请稍后校准")?;
    let token = uuid::Uuid::new_v4().to_string();
    let _gate = crate::maintenance::begin(&state, &profile.id, Some(&token), "tuning")?;
    live::log(&id, "waitingForIdle", json!({}));
    tokio::select! {_=cancel.cancelled()=>return Err("等待空闲时取消，配置未改变".into()),result=crate::maintenance::wait_idle(&state,&profile)=>result?};
    if require_owned(&state, &profile).await? != pid {
        return Err("模型进程在校准前发生变化".into());
    }
    let job = cal_update(&state, &id, |job| job.state = Phase::Running)?;
    let active_steps = job
        .steps
        .iter()
        .filter(|s| s.status != StepStatus::Skipped)
        .count();
    let mut runner = Runner {
        state: &state,
        profile: &profile,
        pid,
        id: &id,
        cancel: &cancel,
        token: &token,
        step_index: 0,
        step_total: active_steps,
    };
    let base = Parameters {
        pcie_frac: job.baseline.pcie_frac,
        spec_min_p: job.baseline.spec_min_p,
    };
    let rounds = job.rounds;

    // 0. warm-up (not recorded)
    runner.step_index = 1;
    runner.enter(
        StepKind::Warmup,
        json!({"pcieFrac":base.pcie_frac,"specMinP":base.spec_min_p}),
        Some((1, WARMUP_ROUNDS)),
    );
    cal_update(&state, &id, |job| {
        mark(job, StepKind::Warmup, |s| s.status = StepStatus::Running)
    })?;
    live::log(&id, "warmup", json!({}));
    for round in 0..WARMUP_ROUNDS {
        runner.enter(
            StepKind::Warmup,
            json!({"pcieFrac":base.pcie_frac,"specMinP":base.spec_min_p}),
            Some((round + 1, WARMUP_ROUNDS)),
        );
        runner.rate(base).await?;
    }
    cal_update(&state, &id, |job| {
        mark(job, StepKind::Warmup, |s| s.status = StepStatus::Done)
    })?;

    // 1. prompt chunks of a layer split (prompt read speed)
    let mut chosen_pipe = job.baseline.prefill_pipe;
    let pipe_step = job
        .steps
        .iter()
        .find(|s| s.kind == StepKind::PrefillPipe)
        .cloned();
    if let Some(pipe_step) = pipe_step.filter(|s| s.status != StepStatus::Skipped) {
        runner.step_index += 1;
        cal_update(&state, &id, |job| {
            mark(job, StepKind::PrefillPipe, |s| {
                s.status = StepStatus::Running
            })
        })?;
        let max_context = job.identity["maxContext"].as_u64();
        let reads: Vec<usize> = PIPE_TOKENS
            .iter()
            .copied()
            .filter(|n| max_context.is_none_or(|ctx| (*n as u64) + 512 <= ctx))
            .collect();
        let mut read = 0;
        let current = pipe_step.current_value.unwrap_or(0.0);
        runner.enter(StepKind::PrefillPipe, json!({"prefillPipe":current}), None);
        runner.prompt_rate(base, current, &reads, &mut read).await?; // faults the weights in
        let mut by_value = vec![];
        for value in &pipe_step.values {
            runner.enter(
                StepKind::PrefillPipe,
                json!({"prefillPipe":value}),
                Some((1, 1)),
            );
            let rate = runner.prompt_rate(base, *value, &reads, &mut read).await?;
            by_value.push((*value, rate));
            live::log(&id, "prefillPipeSample", json!({"value":value,"rate":rate}));
            cal_update(&state, &id, |job| {
                mark(job, StepKind::PrefillPipe, |s| {
                    s.samples.push(Sample {
                        value: *value,
                        round: 0,
                        rate,
                    })
                })
            })?;
        }
        let best = by_value
            .iter()
            .max_by(|a, b| a.1.total_cmp(&b.1))
            .map(|v| v.0)
            .unwrap_or(current);
        let mut chosen = current;
        if (best - current).abs() > 1e-9 {
            let (mut d, mut c) = (vec![], vec![]);
            for round in 0..rounds {
                for value in if round % 2 == 0 {
                    [current, best]
                } else {
                    [best, current]
                } {
                    runner.enter(
                        StepKind::PrefillPipe,
                        json!({"prefillPipe":value,"confirm":true}),
                        Some((round + 1, rounds)),
                    );
                    let rate = runner.prompt_rate(base, value, &reads, &mut read).await?;
                    if (value - current).abs() < 1e-9 {
                        d.push(rate)
                    } else {
                        c.push(rate)
                    }
                    cal_update(&state, &id, |job| {
                        mark(job, StepKind::PrefillPipe, |s| {
                            s.samples.push(Sample {
                                value,
                                round: round + 1,
                                rate,
                            })
                        })
                    })?;
                }
            }
            if pipe_confirmed(&d, &c) {
                chosen = best;
            }
        }
        chosen_pipe = Some(chosen);
        cal_update(&state, &id, |job| {
            mark(job, StepKind::PrefillPipe, |s| {
                s.best = Some(best);
                s.chosen = Some(chosen);
                s.status = StepStatus::Done;
            });
            job.total_requests = job.steps.iter().map(|s| s.requests).sum();
        })?;
    }

    // 2./3. request-level sweeps, every value SWEEP_ROUNDS times
    let mut best_pcie = base.pcie_frac;
    let mut best_spec = base.spec_min_p;
    for kind in [StepKind::PcieFrac, StepKind::SpecMinP] {
        runner.step_index += 1;
        let step = job
            .steps
            .iter()
            .find(|s| s.kind == kind)
            .cloned()
            .ok_or("校准计划缺少步骤")?;
        cal_update(&state, &id, |job| {
            mark(job, kind, |s| s.status = StepStatus::Running)
        })?;
        let mut samples = vec![];
        for round in 0..rounds {
            for value in sweep_order(&step.values, round) {
                let parameters = if kind == StepKind::PcieFrac {
                    Parameters {
                        pcie_frac: value,
                        spec_min_p: base.spec_min_p,
                    }
                } else {
                    Parameters {
                        pcie_frac: best_pcie,
                        spec_min_p: value,
                    }
                };
                runner.enter(kind, json!({"pcieFrac":parameters.pcie_frac,"specMinP":parameters.spec_min_p,"value":value}), Some((round + 1, rounds)));
                let rate = runner.rate(parameters).await?;
                let sample = Sample { value, round, rate };
                samples.push(sample.clone());
                live::log(
                    &id,
                    "sample",
                    json!({"step":kind,"value":value,"round":round + 1,"rate":rate}),
                );
                cal_update(&state, &id, |job| {
                    mark(job, kind, |s| s.samples.push(sample))
                })?;
            }
        }
        let current = step.current_value.unwrap_or(if kind == StepKind::PcieFrac {
            base.pcie_frac
        } else {
            base.spec_min_p
        });
        let (best, chosen) = sweep_winner(&samples, &step.values, current);
        live::log(
            &id,
            "stepWinner",
            json!({"step":kind,"best":best,"chosen":chosen}),
        );
        cal_update(&state, &id, |job| {
            mark(job, kind, |s| {
                s.best = best;
                s.chosen = Some(chosen);
                s.status = StepStatus::Done;
            })
        })?;
        if kind == StepKind::PcieFrac {
            best_pcie = chosen
        } else {
            best_spec = chosen
        }
    }

    // 4. the winner against the current settings, interleaved
    runner.step_index += 1;
    let candidate = Parameters {
        pcie_frac: best_pcie,
        spec_min_p: best_spec,
    };
    let current = Parameters {
        pcie_frac: round2(base.pcie_frac),
        spec_min_p: round2(base.spec_min_p),
    };
    let mut recommended = base;
    let (mut gain, mut base_rate, mut tuned_rate) = (None, None, None);
    if candidate != current {
        cal_update(&state, &id, |job| {
            mark(job, StepKind::Confirm, |s| s.status = StepStatus::Running)
        })?;
        let (mut d, mut c) = (vec![], vec![]);
        for round in 0..rounds {
            for (index, parameters) in [(0.0, base), (1.0, candidate)] {
                runner.enter(StepKind::Confirm, json!({"pcieFrac":parameters.pcie_frac,"specMinP":parameters.spec_min_p,"value":index}), Some((round + 1, rounds)));
                let rate = runner.rate(parameters).await?;
                if index == 0.0 {
                    d.push(rate)
                } else {
                    c.push(rate)
                }
                cal_update(&state, &id, |job| {
                    mark(job, StepKind::Confirm, |s| {
                        s.samples.push(Sample {
                            value: index,
                            round,
                            rate,
                        })
                    })
                })?;
            }
        }
        let (measured, accepted) = confirm_gain(&d, &c);
        gain = measured;
        base_rate = median(&d);
        tuned_rate = median(&c);
        if accepted {
            recommended = candidate;
        }
        cal_update(&state, &id, |job| {
            mark(job, StepKind::Confirm, |s| {
                s.best = Some(1.0);
                s.chosen = Some(if accepted { 1.0 } else { 0.0 });
                s.status = StepStatus::Done;
            })
        })?;
    } else {
        cal_update(&state, &id, |job| {
            mark(job, StepKind::Confirm, |s| {
                s.status = StepStatus::Skipped;
                s.skipped_reason = Some("currentIsBest".into());
                s.requests = 0;
            });
            job.total_requests = job.steps.iter().map(|s| s.requests).sum();
        })?;
        live::set_total(
            &id,
            job.steps
                .iter()
                .filter(|s| s.kind != StepKind::Confirm)
                .map(|s| s.requests)
                .sum(),
        );
    }
    // Never recommend pcie_frac 0 off a confirmed NVIDIA card (upstream #2498).
    if job.backend != Backend::Cuda && recommended.pcie_frac <= 0.0 {
        recommended = base;
    }
    crate::maintenance::wait_idle(&state, &profile).await?;
    let bytes = fs::read(assert_managed_config(&state, &profile)?).map_err(|e| e.to_string())?;
    if fingerprint(&bytes) != job.config_fingerprint {
        return Err("校准期间配置发生变化，结果不能应用".into());
    }
    drop(_gate);
    let candidate_params = CalibrationParameters {
        pcie_frac: candidate.pcie_frac,
        spec_min_p: candidate.spec_min_p,
        prefill_pipe: chosen_pipe,
    };
    let recommended_params = CalibrationParameters {
        pcie_frac: recommended.pcie_frac,
        spec_min_p: recommended.spec_min_p,
        prefill_pipe: chosen_pipe,
    };
    live::log(&id, "finished", json!({"gain":gain}));
    cal_update(&state, &id, |job| {
        job.candidate = Some(candidate_params);
        job.recommended = Some(recommended_params);
        job.settings = settings_for(job.baseline, recommended_params);
        job.gain = gain;
        job.base_rate = base_rate;
        job.tuned_rate = tuned_rate;
        job.state = Phase::Completed;
        job.finished_at = Some(now());
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn samples(rows: &[(f64, &[f64])]) -> Vec<Sample> {
        rows.iter()
            .flat_map(|(value, rates)| {
                rates.iter().enumerate().map(move |(round, rate)| Sample {
                    value: *value,
                    round,
                    rate: *rate,
                })
            })
            .collect()
    }

    #[test]
    fn amd_and_unconfirmed_gpus_never_measure_pcie_zero() {
        let (cuda, excluded) = pcie_values(0.55, Backend::Cuda);
        assert_eq!(cuda, vec![0.0, 0.2, 0.35, 0.55, 0.75, 0.9, 1.0]);
        assert!(excluded.is_empty());
        let (hip, excluded) = pcie_values(0.3, Backend::Hip);
        assert!(!hip.contains(&0.0));
        assert!(hip.contains(&0.3), "the current value is always measured");
        assert_eq!(
            excluded,
            vec![Excluded {
                value: 0.0,
                reason: "amdPcieZero".into()
            }]
        );
        let (unknown, excluded) = pcie_values(0.5, Backend::Unknown);
        assert!(!unknown.contains(&0.0));
        assert_eq!(excluded[0].reason, "unconfirmedGpuPcieZero");
    }

    #[test]
    fn sweeps_alternate_order_like_upstream() {
        assert_eq!(sweep_order(&[0.3, 0.5, 0.7], 0), vec![0.3, 0.5, 0.7]);
        assert_eq!(sweep_order(&[0.3, 0.5, 0.7], 1), vec![0.7, 0.5, 0.3]);
        assert_eq!(spec_values(0.5), vec![0.3, 0.5, 0.7]);
        assert_eq!(spec_values(0.8), vec![0.3, 0.5, 0.7, 0.8]);
    }

    #[test]
    fn a_sweep_keeps_the_current_value_unless_the_winner_beats_it_by_more_than_three_percent() {
        let s = samples(&[
            (0.3, &[50.0, 51.0, 50.5]),
            (0.5, &[50.0, 50.0, 50.2]),
            (0.7, &[51.0, 51.2, 51.1]),
        ]);
        // 0.7 is the best median but only +2.2% over the current 0.5
        assert_eq!(sweep_winner(&s, &[0.3, 0.5, 0.7], 0.5), (Some(0.7), 0.5));
        let s = samples(&[
            (0.35, &[120.0, 119.0, 121.0]),
            (0.55, &[100.0, 101.0, 99.0]),
        ]);
        assert_eq!(sweep_winner(&s, &[0.35, 0.55], 0.55), (Some(0.35), 0.35));
        // a single bad sample does not decide (median of rounds)
        let s = samples(&[(0.2, &[200.0, 60.0, 61.0]), (0.55, &[70.0, 71.0, 70.0])]);
        assert_eq!(sweep_winner(&s, &[0.2, 0.55], 0.55), (Some(0.55), 0.55));
    }

    #[test]
    fn confirmation_and_prompt_chunks_follow_upstream_rules() {
        assert!(confirm_gain(&[100.0, 101.0, 99.0], &[110.0, 111.0, 109.0]).1);
        assert!(!confirm_gain(&[100.0, 101.0, 99.0], &[102.0, 103.0, 101.0]).1);
        assert_eq!(confirm_gain(&[], &[1.0]), (None, false));
        assert!(pipe_confirmed(
            &[1000.0, 1000.0, 1000.0],
            &[1100.0, 1080.0, 1090.0]
        ));
        assert!(
            !pipe_confirmed(&[1000.0, 1000.0, 1000.0], &[1200.0, 990.0, 1200.0]),
            "must win every round"
        );
    }

    #[test]
    fn restart_suggestions_use_the_official_grids_and_fit_four_candidates() {
        assert_eq!(worker_candidates(15), vec![10, 8, 4]);
        assert_eq!(worker_candidates(3), vec![2]);
        let suggestions = restart_suggestions(Some(19));
        assert_eq!(suggestions.len(), 4);
        assert_eq!(suggestions[0].pool_workers, Some(13));
        assert_eq!(suggestions[1].pool_workers, Some(10));
        assert_eq!(suggestions[3].adapt_swaps, Some(160));
        assert_eq!(restart_suggestions(None).len(), 2);
    }

    #[test]
    fn plan_counts_every_request_and_skips_prompt_chunks_without_a_split() {
        let base = CalibrationParameters {
            pcie_frac: 0.55,
            spec_min_p: 0.5,
            prefill_pipe: None,
        };
        let plan_single = plan(base, Backend::Cuda, false, Some(65536), 3);
        // warm-up 6 + pcie 7*3*3 + spec 3*3*3 + confirm 2*3*3
        assert_eq!(plan_single.total_requests, 6 + 63 + 27 + 18);
        assert_eq!(plan_single.steps[1].status, StepStatus::Skipped);
        assert_eq!(
            plan_single.steps[1].skipped_reason.as_deref(),
            Some("noLayerSplit")
        );
        let plan_split = plan(
            CalibrationParameters {
                prefill_pipe: Some(0.0),
                ..base
            },
            Backend::Hip,
            true,
            Some(2048),
            3,
        );
        assert_eq!(
            plan_split.steps[1].status,
            StepStatus::Skipped,
            "8K and 2K reads need room in the context"
        );
        assert_eq!(
            plan_split.steps[1].skipped_reason.as_deref(),
            Some("contextTooSmall")
        );
        let plan_split = plan(
            CalibrationParameters {
                prefill_pipe: Some(0.0),
                ..base
            },
            Backend::Hip,
            true,
            Some(4096),
            3,
        );
        assert_eq!(
            plan_split.steps[1].requests,
            1 + 6 + 6,
            "only the 2K read fits a 4K context"
        );
        let plan_split = plan(
            CalibrationParameters {
                prefill_pipe: Some(0.0),
                ..base
            },
            Backend::Hip,
            true,
            Some(32768),
            3,
        );
        assert_eq!(plan_split.steps[1].requests, 2 * (1 + 6 + 6));
        assert!(!plan_split.steps[2].values.contains(&0.0));
    }

    #[test]
    fn settings_only_name_changed_values() {
        let base = CalibrationParameters {
            pcie_frac: 0.55,
            spec_min_p: 0.5,
            prefill_pipe: None,
        };
        assert!(settings_for(base, base).is_empty());
        let tuned = CalibrationParameters {
            pcie_frac: 0.35,
            ..base
        };
        let settings = settings_for(base, tuned);
        assert_eq!(settings["--pcie-frac"], "0.35");
        assert_eq!(settings["--spec-min-p"], "0.50");
        let piped = settings_for(
            CalibrationParameters {
                prefill_pipe: Some(0.0),
                ..base
            },
            CalibrationParameters {
                prefill_pipe: Some(1536.0),
                ..base
            },
        );
        assert_eq!(piped["--prefill-pipe"], "1536");
        assert!(!piped.contains_key("--pcie-frac"));
    }

    #[test]
    fn backend_and_split_detection() {
        assert_eq!(
            detect_backend(&json!({"backend":"hip"}), &json!({})),
            Backend::Hip
        );
        assert_eq!(
            detect_backend(
                &json!({}),
                &json!({"hardware_static":{"gpu":"AMD Radeon AI PRO R9700"}})
            ),
            Backend::Hip
        );
        assert_eq!(
            detect_backend(
                &json!({}),
                &json!({"hardware_static":{"gpu":"NVIDIA GeForce RTX 5070"}})
            ),
            Backend::Cuda
        );
        assert_eq!(
            detect_backend(&json!({}), &json!({"hardware_static":{"cpu":"fixture"}})),
            Backend::Unknown
        );
        assert!(detect_layer_split(
            &json!({"args":["--layer-split","24"]}),
            &json!({})
        ));
        assert!(detect_layer_split(&json!({"layer_split":"23"}), &json!({})));
        assert!(!detect_layer_split(
            &json!({"args":[]}),
            &json!({"engine":{"prefill_stages":1}})
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn quick_calibration_on_the_owned_fixture_finds_the_faster_pcie_share_and_writes_nothing()
    {
        let (_temp, state, profile, original) = super::super::tests::live_fixture().await;
        let started = start(
            state.clone(),
            profile.id.clone(),
            CalibrateRequest { rounds: Some(2) },
        )
        .await
        .unwrap();
        assert_eq!(started.backend, Backend::Unknown);
        assert!(
            !started.steps[2].values.contains(&0.0),
            "unconfirmed GPU never measures pcie_frac 0"
        );
        // a tuning start is refused while the calibration runs
        assert!(super::super::assert_available(&state).is_err());
        let mut saw_live = false;
        let mut job = started.clone();
        for _ in 0..3000 {
            if let Some(live) = live::snapshot(&started.id) {
                saw_live |= live.completed_units > 0 && live.total_units == started.total_requests;
            }
            job = status(&state, profile.id.clone()).unwrap().unwrap();
            if !job.state.active() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(job.state, Phase::Completed, "{:?}", job.error);
        assert!(saw_live, "live progress was published while running");
        assert_eq!(job.completed_requests, job.total_requests);
        let recommended = job.recommended.unwrap();
        assert!(
            (recommended.pcie_frac - 0.35).abs() < 1e-9,
            "{recommended:?}"
        );
        assert!(
            (recommended.spec_min_p - 0.5).abs() < 1e-9,
            "spec_min_p had no effect and keeps the current value"
        );
        assert_eq!(job.settings["--pcie-frac"], "0.35");
        assert!(job.gain.unwrap() > MIN_GAIN);
        assert_eq!(
            fs::read(&profile.config_path).unwrap(),
            original,
            "calibration never writes the config"
        );
        // the live log is attached to the report when the job ends
        for _ in 0..500 {
            job = status(&state, profile.id.clone()).unwrap().unwrap();
            if !job.live_log.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(live::snapshot(&started.id).is_none());
        let keys: Vec<_> = job.live_log.iter().map(|line| line.key.as_str()).collect();
        assert!(
            keys.contains(&"warmup") && keys.last() == Some(&"finished"),
            "{keys:?}"
        );
        let stored = fs::read_to_string(cal_path(&state, &job.id).unwrap()).unwrap();
        assert!(stored.contains("\"liveLog\""));
        for prompt_text in [
            "refrigerator",
            "merge_sorted",
            "\"prompt\":",
            "\"content\":",
        ] {
            assert!(
                !stored.contains(prompt_text),
                "report never stores {prompt_text}"
            );
        }
        // the report survives in the latest-report index
        let reread = status(&state, profile.id.clone()).unwrap().unwrap();
        assert_eq!(reread.id, job.id);
        drop(state); // Job/group cleanup terminates only this fixture.
    }
}
