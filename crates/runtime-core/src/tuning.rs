//! Bounded A/B/A measurements. Complete scenarios may temporarily restart the
//! owned import snapshot under a durable recovery journal; imported originals
//! remain untouched. Prompt/response text is never written to the report.
use crate::{
    http, storage,
    types::{now, ServiceProfile},
    RuntimeState,
};
use futures_util::StreamExt;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[path = "tuning_calibrate.rs"]
pub mod calibrate;
#[path = "tuning_live.rs"]
pub mod live;
#[path = "tuning_quality.rs"]
mod quality;
#[path = "tuning_restart.rs"]
mod restart;
#[path = "tuning_workloads.rs"]
pub(crate) mod workloads;
pub use restart::{CandidateKind, FullOptions, FullReport, RestartParameters};
pub use workloads::UseCase;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Scene {
    Chat,
    Code,
    Chinese,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Parameters {
    pub pcie_frac: f64,
    pub spec_min_p: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TuningStartRequest {
    #[serde(default = "default_scenes")]
    pub scenes: Vec<Scene>,
    #[serde(default = "default_rounds")]
    pub rounds: usize,
    #[serde(default = "default_tokens")]
    pub max_tokens: usize,
    #[serde(default)]
    pub candidates: Option<Vec<Parameters>>,
    #[serde(flatten)]
    pub full: FullOptions,
}
fn default_scenes() -> Vec<Scene> {
    vec![Scene::Chat, Scene::Code, Scene::Chinese]
}
fn default_rounds() -> usize {
    2
}
fn default_tokens() -> usize {
    512
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Checking,
    Running,
    Canceling,
    Completed,
    Canceled,
    Failed,
    Interrupted,
    Applying,
    Applied,
    RollingBack,
    Restored,
}
impl Phase {
    fn active(self) -> bool {
        matches!(
            self,
            Self::Checking | Self::Running | Self::Canceling | Self::Applying | Self::RollingBack
        )
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Position {
    BaselineBefore,
    Candidate,
    BaselineAfter,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CacheMode {
    DistinctPrompt,
    RepeatedPrefix,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Measurement {
    pub id: String,
    pub candidate_id: String,
    pub scene: Scene,
    pub round: usize,
    pub position: Position,
    pub cache_mode: CacheMode,
    pub started_at: u64,
    pub wall_ms: f64,
    pub first_token_ms: Option<f64>,
    pub first_visible_ms: Option<f64>,
    pub decode_tok_s: Option<f64>,
    pub decode_ms: Option<f64>,
    pub prompt_ms: Option<f64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
    pub finish: Option<String>,
    pub complete: bool,
    pub quality_passed: bool,
    pub output_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Evaluation {
    pub gain: Option<f64>,
    pub drift: Option<f64>,
    pub pairs: usize,
    pub accepted: bool,
    pub reason: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub pcie_frac: f64,
    pub spec_min_p: f64,
    #[serde(default)]
    pub kind: CandidateKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart: Option<RestartParameters>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup_verification: Option<restart::StartupVerification>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_assessment: Option<restart::ResourceAssessment>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub dimensions: HashMap<String, Evaluation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evaluation: Option<Evaluation>,
}
impl Candidate {
    fn parameters(&self) -> Parameters {
        Parameters {
            pcie_frac: self.pcie_frac,
            spec_min_p: self.spec_min_p,
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TuningJob {
    pub id: String,
    pub profile_id: String,
    pub state: Phase,
    pub scenes: Vec<Scene>,
    pub rounds: usize,
    pub max_tokens: usize,
    pub started_at: u64,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    pub completed_requests: usize,
    pub total_requests: usize,
    pub current_step: String,
    pub baseline: Parameters,
    pub candidates: Vec<Candidate>,
    pub measurements: Vec<Measurement>,
    pub recommended_candidate_id: Option<String>,
    pub identity: Value,
    pub config_fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_config_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub notes: Vec<String>,
    /// Sanitized, size-capped copy of the live log, attached when the job ends.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub live_log: Vec<live::LiveLogLine>,
    #[serde(flatten)]
    pub full: FullReport,
}
struct Entry {
    job: TuningJob,
    cancel: CancellationToken,
}
/// Expiration of a surrounding timeout must revoke any queued/native spawn.
/// Recovery always creates a separate guard from the canceled measurement.
struct NativeOperation(CancellationToken);
impl NativeOperation {
    fn new() -> Self {
        Self(CancellationToken::new())
    }
}
impl Drop for NativeOperation {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
type Registry = HashMap<PathBuf, HashMap<String, Entry>>;
fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}
fn report_dir(state: &RuntimeState) -> PathBuf {
    state.data_dir().join("tuning-v1")
}
fn report_path(state: &RuntimeState, id: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "无效调优任务标识")?;
    Ok(report_dir(state).join(format!("{id}.json")))
}
const MAX_REPORT_BYTES: usize = 4 * 1024 * 1024;
fn ensure_report_index(database: &rusqlite::Connection) -> Result<(), String> {
    database
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS tuning_report_index(
           job_id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,
           started_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
           created_order INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS tuning_report_orders(
           job_id TEXT PRIMARY KEY,created_order INTEGER NOT NULL UNIQUE);",
        )
        .map_err(|e| format!("调优报告索引不可用：{e}"))?;
    let has_order: bool = database
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('tuning_report_index') WHERE name='created_order')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("调优报告索引版本不可用：{e}"))?;
    if !has_order {
        database
            .execute(
                "ALTER TABLE tuning_report_index ADD COLUMN created_order INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|e| format!("调优报告索引迁移失败：{e}"))?;
    }
    database
        .execute(
            "CREATE INDEX IF NOT EXISTS tuning_report_ordered_latest ON
             tuning_report_index(profile_id,created_order DESC,started_at DESC,updated_at DESC,job_id DESC)",
            [],
        )
        .map_err(|e| format!("调优报告索引不可用：{e}"))?;
    database
        .execute(
            "CREATE INDEX IF NOT EXISTS tuning_report_creation_order ON tuning_report_index(created_order)",
            [],
        )
        .map_err(|e| format!("调优报告顺序索引不可用：{e}"))?;
    Ok(())
}
fn report_order(
    database: &rusqlite::Connection,
    id: &str,
    newly_published: bool,
) -> Result<i64, String> {
    let existing: Option<i64> = database
        .query_row(
            "SELECT created_order FROM tuning_report_index WHERE job_id=?1
             UNION ALL SELECT created_order FROM tuning_report_orders WHERE job_id=?1 LIMIT 1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("调优报告顺序读取失败：{e}"))?;
    if let Some(order) = existing {
        return Ok(order);
    }
    if !newly_published {
        return Ok(0);
    }
    let previous: i64 = database
        .query_row(
            "SELECT COALESCE(MAX(created_order),0) FROM (
               SELECT MAX(created_order) AS created_order FROM tuning_report_index
               UNION ALL SELECT MAX(created_order) FROM tuning_report_orders)",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("调优报告顺序不可用：{e}"))?;
    let order = previous.checked_add(1).ok_or("调优报告顺序超限")?;
    // Reserve durably before writing the JSON, so startup backfill can
    // reconstruct ordering after a crash between file and index publication.
    database
        .execute(
            "INSERT INTO tuning_report_orders(job_id,created_order) VALUES(?1,?2)",
            rusqlite::params![id, order],
        )
        .map_err(|e| format!("调优报告顺序保存失败：{e}"))?;
    Ok(order)
}
fn index_report(state: &RuntimeState, job: &TuningJob) -> Result<(), String> {
    index_report_with_order(state, job, true)
}
fn index_report_with_order(
    state: &RuntimeState,
    job: &TuningJob,
    newly_published: bool,
) -> Result<(), String> {
    let _ = report_path(state, &job.id)?;
    let started = i64::try_from(job.started_at).map_err(|_| "调优报告开始时间无效")?;
    let updated = i64::try_from(job.updated_at).map_err(|_| "调优报告更新时间无效")?;
    let database = state.database.lock().map_err(|e| e.to_string())?;
    ensure_report_index(&database)?;
    // Preserve a task's creation order across updates and wall-clock changes.
    // Legacy reports have no reliable sequence: migrate with order zero and
    // use their recorded timestamps only within that historic group.
    let order = report_order(&database, &job.id, newly_published)?;
    database.execute(
        "INSERT INTO tuning_report_index(job_id,profile_id,started_at,updated_at,created_order)
         VALUES(?1,?2,?3,?4,?5) ON CONFLICT(job_id) DO UPDATE SET
         profile_id=excluded.profile_id,started_at=excluded.started_at,updated_at=excluded.updated_at",
        rusqlite::params![job.id,job.profile_id,started,updated,order],
    ).map_err(|e| format!("调优报告索引发布失败：{e}"))?;
    Ok(())
}
fn read_persisted_job(state: &RuntimeState, id: &str) -> Result<TuningJob, String> {
    let path = report_path(state, id)?;
    let path = dunce::canonicalize(path).map_err(|e| e.to_string())?;
    let directory = dunce::canonicalize(report_dir(state)).map_err(|e| e.to_string())?;
    if path.parent() != Some(directory.as_path()) {
        return Err("调优报告不在本应用报告目录中".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(MAX_REPORT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_REPORT_BYTES {
        return Err("调优报告超过大小限制".into());
    }
    let job: TuningJob = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if job.id != id {
        return Err("调优报告文件与任务标识不一致".into());
    }
    Ok(job)
}
fn persist(state: &RuntimeState, job: &TuningJob) -> Result<(), String> {
    let directory = report_dir(state);
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(job).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_REPORT_BYTES {
        return Err("调优报告超过持久化大小限制".into());
    }
    let path = report_path(state, &job.id)?;
    {
        let database = state.database.lock().map_err(|e| e.to_string())?;
        ensure_report_index(&database)?;
        report_order(&database, &job.id, true)?;
    }
    atomic_bytes(&path, &bytes)?;
    index_report(state, job)
}
fn atomic_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("文件缺少父目录")?)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
fn update(
    state: &RuntimeState,
    id: &str,
    f: impl FnOnce(&mut TuningJob),
) -> Result<TuningJob, String> {
    let mut registry = registry().lock().map_err(|e| e.to_string())?;
    let entry = registry
        .get_mut(state.data_dir())
        .and_then(|jobs| jobs.get_mut(id))
        .ok_or("调优任务不存在")?;
    f(&mut entry.job);
    entry.job.updated_at = now();
    persist(state, &entry.job)?;
    Ok(entry.job.clone())
}
/// Stores the ended job's log in its report without touching `updated_at`, so
/// the published completion stays the same report apart from the log.
fn attach_live_log(state: &RuntimeState, id: &str, log: Vec<live::LiveLogLine>) {
    if log.is_empty() {
        return;
    }
    let Ok(mut registry) = registry().lock() else {
        return;
    };
    if let Some(entry) = registry
        .get_mut(state.data_dir())
        .and_then(|jobs| jobs.get_mut(id))
    {
        entry.job.live_log = log;
        let _ = persist(state, &entry.job);
    }
}
fn register_active(
    state: &RuntimeState,
    job: &TuningJob,
    cancel: CancellationToken,
) -> Result<(), String> {
    register_active_checked(state, job, cancel, None)
}
fn register_active_checked(
    state: &RuntimeState,
    job: &TuningJob,
    cancel: CancellationToken,
    expected_pid: Option<u32>,
) -> Result<(), String> {
    // Linearize registration with idle unload and owned start/stop. Taking
    // this lock before registry matches their global -> registry order.
    // Reject contention instead of queueing an outdated maintenance job.
    let _operation = state
        .runtime_operations
        .try_lock()
        .map_err(|_| "模型正在切换或维护，未登记调优任务")?;
    let profile = state.registered_profile(&job.profile_id)?;
    crate::external_management::assert_profile_manager_owned(state, &profile)?;
    if let Some(pid) = expected_pid {
        let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
        let process = processes
            .get_mut(&profile.id)
            .ok_or("调优登记前受管进程已消失")?;
        let status = process.refresh()?;
        let same_profile = process
            .profile
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(|e| e.to_string())?
            == Some(serde_json::to_value(&profile).map_err(|e| e.to_string())?);
        if !status.running || !status.owned || status.pid != Some(pid) || !same_profile {
            return Err("调优登记前受管进程或安装身份已改变，未开始测量".into());
        }
    }
    let mut registry = registry().lock().map_err(|e| e.to_string())?;
    let jobs = registry.entry(state.data_dir().to_path_buf()).or_default();
    // Pair this locked recheck with the updater's CAS-before-tuning-check.
    // If upgrading wins first, registration fails. If tuning registers first,
    // the updater observes the active entry and releases its upgrade flag.
    crate::runtime_upgrade::assert_available(state)?;
    if state
        .selection_changing
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return Err("正在切换模型，未登记调优维护任务".into());
    }
    if jobs.values().any(|entry| entry.job.state.active()) {
        return Err("已有调优维护任务".into());
    }
    if !job.state.active() {
        return Err("只能登记活动调优维护任务".into());
    }
    persist(state, job)?;
    jobs.insert(
        job.id.clone(),
        Entry {
            job: job.clone(),
            cancel,
        },
    );
    Ok(())
}
fn read_job(state: &RuntimeState, id: &str) -> Result<TuningJob, String> {
    if let Some(entry) = registry()
        .lock()
        .map_err(|e| e.to_string())?
        .get(state.data_dir())
        .and_then(|jobs| jobs.get(id))
    {
        return Ok(entry.job.clone());
    }
    let mut job = read_persisted_job(state, id)?;
    if job.state.active() {
        job.state = Phase::Interrupted;
        job.finished_at = Some(now());
        job.error = Some("后台曾中断；未完成结果不能应用".into());
    }
    Ok(job)
}
pub fn status(state: &RuntimeState, profile_id: String) -> Result<Option<TuningJob>, String> {
    state.registered_profile(&profile_id)?;
    // A real active task always wins over history, even if its start time is
    // older after a wall-clock adjustment or a damaged report/index file.
    let live = registry()
        .lock()
        .map_err(|e| e.to_string())?
        .get(state.data_dir())
        .and_then(|jobs| {
            jobs.values()
                .filter(|entry| entry.job.profile_id == profile_id)
                .max_by_key(|entry| {
                    (
                        entry.job.state.active(),
                        entry.job.started_at,
                        entry.job.updated_at,
                    )
                })
                .map(|entry| entry.job.clone())
        });
    if live.as_ref().is_some_and(|job| job.state.active()) {
        return Ok(live);
    }
    let id: Option<String> = {
        let database = state.database.lock().map_err(|e| e.to_string())?;
        ensure_report_index(&database)?;
        database
            .query_row(
                "SELECT job_id FROM tuning_report_index WHERE profile_id=?1
             ORDER BY created_order DESC,started_at DESC,updated_at DESC,job_id DESC LIMIT 1",
                [&profile_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("调优报告索引读取失败：{e}"))?
    };
    let indexed = id.map(|id| read_job(state, &id)).transpose()?;
    if indexed
        .as_ref()
        .is_some_and(|job| job.profile_id != profile_id)
    {
        return Err("调优报告索引与安装身份不一致".into());
    }
    Ok(indexed.or(live))
}
/// Live progress of a running tuning or calibration job; None when idle.
pub fn live_status(job_id: &str) -> Option<live::LiveSnapshot> {
    live::snapshot(job_id)
}
pub fn assert_available(state: &RuntimeState) -> Result<(), String> {
    if state
        .selection_changing
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return Err("正在切换模型，请等待准备完成后调优".into());
    }
    assert_no_active_tuning(state)
}
pub fn assert_no_active_tuning(state: &RuntimeState) -> Result<(), String> {
    if calibrate::any_active(state)? {
        return Err("正在校准，请等待完成或取消校准".into());
    }
    assert_no_active_tuning_jobs(state)
}
/// Only the A/B/A tuning registry; calibration checks itself separately.
pub(crate) fn assert_no_active_tuning_jobs(state: &RuntimeState) -> Result<(), String> {
    if registry()
        .lock()
        .map_err(|e| e.to_string())?
        .get(state.data_dir())
        .is_some_and(|jobs| jobs.values().any(|entry| entry.job.state.active()))
    {
        return Err("正在调优或恢复参数，请等待完成或取消调优".into());
    }
    Ok(())
}
/// Guarded native operations must belong to a live in-memory task. Reading an
/// interrupted report from disk is never authorization to spawn or stop.
pub(crate) fn assert_current_service_operation(
    state: &RuntimeState,
    job_id: &str,
    profile_id: &str,
) -> Result<(), String> {
    let registry = registry().lock().map_err(|e| e.to_string())?;
    let entry = registry
        .get(state.data_dir())
        .and_then(|jobs| jobs.get(job_id))
        .ok_or("调优原生操作没有活动任务归属")?;
    if entry.job.profile_id != profile_id || !entry.job.state.active() {
        return Err("调优原生操作任务已结束或安装身份不符".into());
    }
    Ok(())
}
#[cfg(test)]
pub(crate) fn register_service_operation_fixture(
    state: &RuntimeState,
    job: &TuningJob,
) -> Result<(), String> {
    register_active(state, job, CancellationToken::new())
}
pub fn cancel(state: &RuntimeState, job_id: String) -> Result<(), String> {
    let mut registry = registry().lock().map_err(|e| e.to_string())?;
    let entry = registry
        .get_mut(state.data_dir())
        .and_then(|jobs| jobs.get_mut(&job_id))
        .ok_or("当前后台没有此活动任务")?;
    if !matches!(
        entry.job.state,
        Phase::Checking | Phase::Running | Phase::Canceling
    ) {
        return Err("只有正在测量的任务可以取消；应用与恢复按事务完成".into());
    }
    entry.cancel.cancel();
    entry.job.state = Phase::Canceling;
    entry.job.updated_at = now();
    persist(state, &entry.job)
}
fn validate_request(request: &TuningStartRequest) -> Result<(), String> {
    if request.scenes.is_empty() || request.scenes.len() > 3 {
        return Err("请选择 1–3 个测量场景".into());
    }
    for (index, scene) in request.scenes.iter().enumerate() {
        if request.scenes[..index].contains(scene) {
            return Err("测量场景不能重复".into());
        }
    }
    if !(2..=4).contains(&request.rounds) || !(128..=1024).contains(&request.max_tokens) {
        return Err("测量轮数须为 2–4，输出上限须为 128–1024".into());
    }
    if let Some(candidates) = &request.candidates {
        if candidates.is_empty() || candidates.len() > 4 {
            return Err("候选须为 1–4 组".into());
        }
        for candidate in candidates {
            validate_parameters(*candidate)?;
        }
    }
    Ok(())
}
fn validate_parameters(parameters: Parameters) -> Result<(), String> {
    if [parameters.pcie_frac, parameters.spec_min_p]
        .into_iter()
        .all(|value| value.is_finite() && (0.0..=1.0).contains(&value))
    {
        Ok(())
    } else {
        Err("PCIe 与 MTP 参数须为 0–1 有限数字".into())
    }
}
fn bounded_candidates(baseline: Parameters, requested: Option<Vec<Parameters>>) -> Vec<Candidate> {
    // These are nearby candidates, never a hardware-specific claimed optimum.
    let values = requested.unwrap_or_else(|| {
        vec![
            Parameters {
                pcie_frac: (baseline.pcie_frac + 0.15).min(1.0),
                spec_min_p: baseline.spec_min_p,
            },
            Parameters {
                pcie_frac: (baseline.pcie_frac - 0.15).max(0.0),
                spec_min_p: baseline.spec_min_p,
            },
            Parameters {
                pcie_frac: baseline.pcie_frac,
                spec_min_p: if baseline.spec_min_p >= 0.5 {
                    (baseline.spec_min_p - 0.2).max(0.0)
                } else {
                    (baseline.spec_min_p + 0.2).min(1.0)
                },
            },
        ]
    });
    let mut out = Vec::<Candidate>::new();
    for value in values {
        if value != baseline && !out.iter().any(|candidate| candidate.parameters() == value) {
            out.push(Candidate {
                id: format!("candidate-{}", out.len() + 1),
                pcie_frac: value.pcie_frac,
                spec_min_p: value.spec_min_p,
                kind: CandidateKind::Request,
                restart: None,
                startup_verification: None,
                resource_assessment: None,
                dimensions: HashMap::new(),
                evaluation: None,
            });
        }
    }
    out
}
fn engine_number(value: &Value) -> Option<f64> {
    // Strata's INFO parser converts integer values to JSON numbers, but retains
    // floating-point values such as pcie_frac=0.55 as strings. Accept only finite
    // JSON numeric syntax; never substitute configuration or observed PCIe usage.
    let number = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) if text.len() <= 64 => serde_json::from_str::<f64>(text.trim()).ok(),
        _ => None,
    }?;
    number.is_finite().then_some(number)
}

fn baseline_parameters(metrics: &Value) -> Result<Parameters, String> {
    let engine = &metrics["engine"];
    let baseline = Parameters {
        pcie_frac: engine
            .get("pcie_frac")
            .and_then(engine_number)
            .ok_or("引擎没有报告 PCIe 参数，不能可靠调优")?,
        spec_min_p: engine
            .get("spec_min_p")
            .and_then(engine_number)
            .ok_or("引擎没有报告 MTP 参数，不能可靠调优")?,
    };
    validate_parameters(baseline)?;
    Ok(baseline)
}
async fn require_owned(state: &Arc<RuntimeState>, profile: &ServiceProfile) -> Result<u32, String> {
    let status =
        crate::service_status(state.clone(), profile.id.clone(), Some(profile.clone())).await?;
    if !status.running || !status.owned {
        return Err("只能调优本应用拥有的运行中模型，请先完成导入和准备".into());
    }
    let config = storage::read(profile)?;
    if crate::network::endpoint(&config, profile)?.base_url != profile.base_url {
        return Err("网络地址设置尚未重启生效，请先重启模型服务后再运行调优".into());
    }
    status.pid.ok_or_else(|| "服务进程标识不可用".into())
}
fn assert_managed_config(
    state: &RuntimeState,
    profile: &ServiceProfile,
) -> Result<PathBuf, String> {
    let path = storage::config_path(profile)?;
    let root = dunce::canonicalize(state.data_dir()).map_err(|e| e.to_string())?;
    if !path.starts_with(root) {
        return Err("调优只可写应用托管配置副本，原安装配置保持不变".into());
    }
    Ok(path)
}
/// Tuning and calibration sweep Qwen-engine knobs (--pool-workers, --pcie-frac, batch slots). The DeepSeek-V4.1
/// engine (arch deepseek41) has none of them, so both are skipped for its configs.
pub(crate) fn assert_tunable(config_path: &Path) -> Result<(), String> {
    let config: Value = fs::read(config_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null);
    if config["arch"] == crate::disk::dsv41::FAMILY {
        return Err("DeepSeek-V4.1-Flash 使用独立引擎，暂不支持速度调优和校准".into());
    }
    Ok(())
}
async fn read_metrics(state: &RuntimeState, profile: &ServiceProfile) -> Result<Value, String> {
    http::strata_request(
        state,
        profile.clone(),
        "/metrics".into(),
        "GET".into(),
        None,
    )
    .await
}
fn identity(profile: &ServiceProfile, config: &Value, metrics: &Value, scenes: &[Scene]) -> Value {
    fn metadata(path: &Path, hash: bool) -> Value {
        match fs::metadata(path) {
            Ok(meta) => {
                let digest = if hash && meta.is_file() && meta.len() <= 256 * 1024 * 1024 {
                    fs::File::open(path).ok().and_then(|file| {
                        let mut bytes = Vec::new();
                        file.take(256 * 1024 * 1024 + 1)
                            .read_to_end(&mut bytes)
                            .ok()?;
                        (bytes.len() as u64 == meta.len()).then(|| fingerprint(&bytes))
                    })
                } else {
                    None
                };
                json!({"file":path.file_name().map(|name|name.to_string_lossy()),"bytes":meta.len(),"sha256":digest,"modifiedMs":meta.modified().ok().and_then(|time|time.duration_since(std::time::UNIX_EPOCH).ok()).map(|duration|duration.as_millis() as u64)})
            }
            Err(_) => Value::Null,
        }
    }
    let cwd = config
        .get("cwd")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(&profile.install_dir));
    let model = config
        .get("args")
        .and_then(Value::as_array)
        .and_then(|args| {
            args.windows(2)
                .find(|pair| {
                    ["--native", "--model", "-m", "--pack"]
                        .iter()
                        .any(|flag| pair[0] == *flag)
                })
                .and_then(|pair| pair[1].as_str())
        });
    let resolve = |text: &str| {
        let path = PathBuf::from(text);
        if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        }
    };
    json!({"benchmarkVersion":if scenes.contains(&Scene::Code) { quality::VERSION } else { "request-aba-v1" },"model":metrics["engine"]["model"],"engineVersion":metrics["engine"]["version"],"maxContext":metrics["engine"]["max_context"],"engineFile":config.get("exe").and_then(Value::as_str).map(|exe|metadata(&resolve(exe), true)),"runtimeSource":metadata(&Path::new(&profile.install_dir).join("serve/server.py"), true),"modelFile":model.map(|name|metadata(&resolve(name), false)),"hardware":metrics["hardware_static"],"ramTotal":metrics["hardware"]["ram_total"],"gpuMemoryTotal":metrics["hardware"]["gpu_mem_total"],"driverVersion":null,"limits":"Synthetic deterministic text probes; not complete Agent, vision, long-context or quality-suite acceptance. Model file uses size/mtime identity, not a full weight hash. Driver version is unknown."})
}
pub async fn start(
    state: Arc<RuntimeState>,
    profile_id: String,
    request: TuningStartRequest,
) -> Result<TuningJob, String> {
    validate_request(&request)?;
    crate::runtime_upgrade::assert_available(&state)?;
    assert_available(&state)?;
    let profile = state.registered_profile(&profile_id)?;
    assert_tunable(&assert_managed_config(&state, &profile)?)?;
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
        return Err("请先准备模型，调优需要已加载的模型".into());
    }
    let metrics = read_metrics(&state, &profile).await?;
    let baseline = baseline_parameters(&metrics)?;
    let config_path = assert_managed_config(&state, &profile)?;
    let bytes = fs::read(&config_path).map_err(|e| e.to_string())?;
    let config: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let mut candidates = bounded_candidates(baseline, request.candidates.clone());
    let full = restart::prepare_report(&request, &config, &metrics, baseline, &mut candidates)?;
    if candidates.is_empty() {
        return Err("候选与现有参数相同，无需测量".into());
    }
    let total_requests = restart::request_total(&full, candidates.len(), request.rounds)?
        .unwrap_or(candidates.len() * request.rounds * request.scenes.len() * 6);
    let token = CancellationToken::new();
    let job_identity = identity(&profile, &config, &metrics, &request.scenes);
    let mut job=TuningJob{ live_log: vec![],
        id:uuid::Uuid::new_v4().to_string(),profile_id, state:Phase::Checking,scenes:request.scenes,rounds:request.rounds,max_tokens:request.max_tokens,
        started_at:now(),updated_at:now(),finished_at:None,completed_requests:0,total_requests,
        current_step:"waitingForIdle".into(),baseline,candidates,measurements:vec![],recommended_candidate_id:None,
        identity:job_identity,config_fingerprint:fingerprint(&bytes),applied_config_fingerprint:None,error:None,
        notes:vec!["A/B/A runs on this machine. Full workloads use semantic quality checks; full output hashes are not compared across legal asynchronous variations.".into(),"Cold model does not prove cold OS file cache. Resource peaks are sampled and unknown values remain null.".into(),"Restart candidates are opt-in; original managed snapshot bytes are restored and verified before finishing.".into()],full,
    };
    job.identity = restart::bound_identity(&profile, &config, &metrics, &job);
    register_active_checked(&state, &job, token.clone(), Some(pid))?;
    let id = job.id.clone();
    live::begin(
        &id,
        if job.full.scope == restart::Scope::FullScenario {
            job.full.progress.total_workloads
        } else {
            job.total_requests
        },
    );
    tokio::spawn(async move {
        let result = run(state.clone(), profile, pid, id.clone(), token.clone()).await;
        live::log(
            &id,
            if result.is_ok() {
                "finished"
            } else if token.is_cancelled() {
                "canceled"
            } else {
                "failed"
            },
            json!({}),
        );
        attach_live_log(&state, &id, live::end(&id));
        // Both successful request and full runs durably publish Completed and
        // their final timestamps before returning. Preserve that report once
        // consumers observe completion; only an error needs outer finalization.
        if let Err(error) = result {
            let _ = update(&state, &id, |job| {
                job.finished_at = Some(now());
                job.state = if job.full.recovery.state == restart::RecoveryState::Failed {
                    Phase::Failed
                } else if token.is_cancelled() {
                    Phase::Canceled
                } else {
                    Phase::Failed
                };
                job.error = Some(error);
                job.current_step = "finished".into();
            });
        }
    });
    Ok(job)
}
async fn run(
    state: Arc<RuntimeState>,
    profile: ServiceProfile,
    pid: u32,
    id: String,
    cancel: CancellationToken,
) -> Result<(), String> {
    if read_job(&state, &id)?.full.scope == restart::Scope::FullScenario {
        return restart::run_full(state, profile, pid, id, cancel).await;
    }
    let lock = {
        let mut locks = state.ensure_locks.lock().await;
        locks.entry(profile.id.clone()).or_default().clone()
    };
    let _runtime_lock = lock
        .try_lock_owned()
        .map_err(|_| "模型正在准备或维护，请稍后调优")?;
    let maintenance_token = uuid::Uuid::new_v4().to_string();
    let _gate = crate::maintenance::begin(&state, &profile.id, Some(&maintenance_token), "tuning")?;
    tokio::select! {_=cancel.cancelled()=>return Err("已取消，原配置未改变".into()),result=crate::maintenance::wait_idle(&state,&profile)=>result?};
    if require_owned(&state, &profile).await? != pid {
        return Err("模型进程在测量前发生变化".into());
    }
    let job = update(&state, &id, |job| {
        job.state = Phase::Running;
        job.current_step = "measuring".into();
    })?;
    for round in 0..job.rounds {
        // Reversing candidates balances adaptive-tier drift over the sweep.
        let candidates: Vec<_> = if round % 2 == 0 {
            job.candidates.iter().collect()
        } else {
            job.candidates.iter().rev().collect()
        };
        for candidate in candidates {
            for scene in &job.scenes {
                for (position, parameters) in [
                    (Position::BaselineBefore, job.baseline),
                    (Position::Candidate, candidate.parameters()),
                    (Position::BaselineAfter, job.baseline),
                ] {
                    let prompt = prompt_for(*scene, &uuid::Uuid::new_v4().to_string());
                    for cache_mode in [CacheMode::DistinctPrompt, CacheMode::RepeatedPrefix] {
                        if cancel.is_cancelled() {
                            return Err("已取消，原配置未改变".into());
                        }
                        if require_owned(&state, &profile).await? != pid {
                            return Err("模型进程在测量中发生变化".into());
                        }
                        crate::inspect_idle_http(&state, &profile).await?;
                        update(&state, &id, |job| {
                            job.current_step = format!(
                                "{} / {:?} / {:?} / {:?} / {}",
                                candidate.id,
                                scene,
                                position,
                                cache_mode,
                                round + 1
                            )
                        })?;
                        live::step(
                            &id,
                            match position {
                                Position::BaselineBefore => "baselineBefore",
                                Position::Candidate => "candidate",
                                Position::BaselineAfter => "baselineAfter",
                            },
                            job.candidates
                                .iter()
                                .position(|c| c.id == candidate.id)
                                .unwrap_or(0)
                                + 1,
                            job.candidates.len(),
                            json!({"candidateId":candidate.id,"pcieFrac":parameters.pcie_frac,"specMinP":parameters.spec_min_p,"scene":scene,"cacheMode":cache_mode}),
                            Some((round + 1, job.rounds)),
                        );
                        let measurement = measure(
                            &state,
                            &profile,
                            Probe {
                                parameters,
                                messages: &prompt,
                                scene: *scene,
                                max_tokens: job.max_tokens,
                                maintenance_token: &maintenance_token,
                                tune_extra: Value::Null,
                            },
                            &cancel,
                        );
                        live::unit_started(&id);
                        let mut measurement = live::scope(id.clone(), measurement).await;
                        live::unit_finished(&id, measurement.decode_tok_s);
                        live::log(
                            &id,
                            "sample",
                            json!({"candidate":candidate.id,"position":position,"scene":scene,"round":round + 1,"rate":measurement.decode_tok_s}),
                        );
                        measurement.candidate_id = candidate.id.clone();
                        measurement.round = round;
                        measurement.position = position;
                        measurement.cache_mode = cache_mode;
                        let failed = measurement.error.clone();
                        update(&state, &id, |job| {
                            job.measurements.push(measurement);
                            job.completed_requests += 1;
                        })?;
                        if let Some(error) = failed {
                            // Dropping the streamed response disconnects only this
                            // benchmark. Never use the server-wide cancel endpoint.
                            let recovery = tokio::time::timeout(
                                Duration::from_secs(30),
                                wait_idle_after_disconnect(
                                    &state,
                                    &profile,
                                    pid,
                                    Duration::from_secs(30),
                                ),
                            )
                            .await;
                            return Err(match recovery {
                                Ok(Ok(())) => error,
                                Ok(Err(recovery)) => format!("{error}；{recovery}"),
                                Err(_) => {
                                    format!("{error}；断开后服务尚未恢复空闲，请检查模型状态")
                                }
                            });
                        }
                    }
                }
            }
        }
    }
    crate::maintenance::wait_idle(&state, &profile).await?;
    let bytes = fs::read(assert_managed_config(&state, &profile)?).map_err(|e| e.to_string())?;
    if fingerprint(&bytes) != job.config_fingerprint {
        return Err("测量期间配置发生变化，结果不能应用".into());
    }
    drop(_gate);
    update(&state, &id, |job| {
        annotate_consistency(&mut job.measurements);
        for candidate in &mut job.candidates {
            candidate.evaluation = Some(evaluate(
                &job.measurements,
                &candidate.id,
                job.scenes.len() * job.rounds * 2,
            ));
        }
        job.recommended_candidate_id = job
            .candidates
            .iter()
            .filter(|candidate| {
                candidate
                    .evaluation
                    .as_ref()
                    .is_some_and(|evaluation| evaluation.accepted)
            })
            .max_by(|a, b| {
                a.evaluation
                    .as_ref()
                    .and_then(|evaluation| evaluation.gain)
                    .unwrap_or(0.0)
                    .total_cmp(
                        &b.evaluation
                            .as_ref()
                            .and_then(|evaluation| evaluation.gain)
                            .unwrap_or(0.0),
                    )
            })
            .map(|candidate| candidate.id.clone());
        job.state = Phase::Completed;
        job.current_step = "finished".into();
        job.finished_at = Some(now());
    })?;
    Ok(())
}
async fn wait_idle_after_disconnect(
    state: &RuntimeState,
    profile: &ServiceProfile,
    expected_pid: u32,
    max_wait: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + max_wait;
    loop {
        {
            let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
            let process = processes
                .get_mut(&profile.id)
                .ok_or("测量服务已不存在；原配置保持不变")?;
            let status = process.refresh()?;
            if !status.running || !status.owned || status.pid != Some(expected_pid) {
                return Err("测量服务已退出或归属改变；原配置保持不变，请重新准备模型".into());
            }
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return Err("断开后排空超时，未停止任何进程；请检查模型状态".into());
        };
        if matches!(
            tokio::time::timeout(
                remaining.min(Duration::from_secs(1)),
                crate::inspect_idle_http(state, profile)
            )
            .await,
            Ok(Ok(()))
        ) {
            return Ok(());
        }
        tokio::time::sleep(remaining.min(Duration::from_millis(250))).await;
    }
}
fn prompt_for(scene: Scene, nonce: &str) -> Value {
    let text=match scene {
        Scene::Chat=>"Explain how a refrigerator transfers heat in exactly three short paragraphs. Cover compressor, refrigerant, and heat released to the room. Do not include a title.",
        Scene::Code=>"Write only Python code defining merge_sorted(a, b), with a short docstring, no imports, and exactly two assert tests after the function. Merge two sorted lists in linear time without sorting. Include duplicates and empty-list cases. Keep the entire answer below 350 tokens.",
        Scene::Chinese=>"请用中文分三段解释为什么本地大语言模型的首字响应速度和持续生成速度不同。分别介绍输入处理、前缀缓存和CPU/GPU协作，最后给出两条不夸大效果的测量建议。不要标题、不要表格，全文控制在350字以内。",
    };
    json!([{"role":"system","content":format!("Benchmark nonce {nonce}. Ignore that nonce in your answer. Follow the user's instructions exactly. Answer directly without reasoning or tool use.")},{"role":"user","content":text}])
}
struct Probe<'a> {
    parameters: Parameters,
    messages: &'a Value,
    scene: Scene,
    max_tokens: usize,
    maintenance_token: &'a str,
    /// Extra per-request `strata_tune` keys (e.g. `prefill_pipe`); Null for none.
    tune_extra: Value,
}
async fn measure(
    state: &RuntimeState,
    profile: &ServiceProfile,
    probe: Probe<'_>,
    cancel: &CancellationToken,
) -> Measurement {
    let Probe {
        parameters,
        messages,
        scene,
        max_tokens,
        maintenance_token,
        tune_extra,
    } = probe;
    let mut record = empty_measurement(scene);
    let mut tune = json!({"pcie_frac":parameters.pcie_frac,"spec_min_p":parameters.spec_min_p});
    // A negative share means "the engine's own" (quick calibration's PCIE_AUTO):
    // no per-request pcie_frac, so the engine's automatic refinement stays on.
    if parameters.pcie_frac < 0.0 {
        if let Some(tune) = tune.as_object_mut() {
            tune.remove("pcie_frac");
        }
    }
    if let (Some(tune), Some(extra)) = (tune.as_object_mut(), tune_extra.as_object()) {
        for (key, value) in extra {
            tune.insert(key.clone(), value.clone());
        }
    }
    let body = json!({"messages":messages,"stream":true,"max_tokens":max_tokens,"temperature":0,"top_p":1,"top_k":1,"seed":1,"enable_thinking":false,"reasoning_effort":"none","reasoning_budget_tokens":0,"strata_checkpoint":false,"strata_tune":tune});
    let start = Instant::now();
    let builder = http::request_builder(
        &state.client,
        profile,
        "/v1/chat/completions",
        "POST",
        Some(body),
    );
    let result = match builder {
        Err(error) => Err(error),
        Ok(builder) => {
            tokio::select! {_=cancel.cancelled()=>Err("测量已取消".into()),result=builder.header("X-Strata-Manager-Tuning-Id",maintenance_token).header("X-Strata-Client","strata-manager.tuning").timeout(Duration::from_secs(180)).send()=>match result {Ok(response)=>consume_response(response,start,cancel,&mut record).await,Err(_)=>Err("测量HTTP连接失败或超时".into())}}
        }
    };
    record.wall_ms = start.elapsed().as_secs_f64() * 1000.0;
    if let Err(error) = result {
        record.error = Some(error);
    }
    record
}
fn empty_measurement(scene: Scene) -> Measurement {
    Measurement {
        id: uuid::Uuid::new_v4().to_string(),
        candidate_id: String::new(),
        scene,
        round: 0,
        position: Position::Candidate,
        cache_mode: CacheMode::DistinctPrompt,
        started_at: now(),
        wall_ms: 0.0,
        first_token_ms: None,
        first_visible_ms: None,
        decode_tok_s: None,
        decode_ms: None,
        prompt_ms: None,
        input_tokens: None,
        output_tokens: None,
        cached_tokens: None,
        finish: None,
        complete: false,
        quality_passed: false,
        output_fingerprint: None,
        error: None,
    }
}
async fn consume_response(
    response: reqwest::Response,
    start: Instant,
    cancel: &CancellationToken,
    record: &mut Measurement,
) -> Result<(), String> {
    if !response.status().is_success() {
        return Err(format!(
            "测量被服务拒绝：HTTP {}",
            response.status().as_u16()
        ));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|header| header.to_str().ok())
        .unwrap_or("");
    if !content_type.starts_with("text/event-stream") {
        return Err("测量响应不是SSE".into());
    }
    let mut stream = response.bytes_stream();
    let mut utf8 = Vec::new();
    let mut pending = String::new();
    let mut text = String::new();
    let mut done = false;
    let mut bytes = 0usize;
    loop {
        let next = tokio::select! {_=cancel.cancelled()=>return Err("测量已取消".into()),next=stream.next()=>next};
        let Some(chunk) = next else {
            break;
        };
        let chunk = chunk.map_err(|_| "测量流中断")?;
        bytes += chunk.len();
        if bytes > 2 * 1024 * 1024 {
            return Err("测量响应超过大小限制".into());
        }
        pending.push_str(&http::decode_utf8(&mut utf8, &chunk, false)?);
        while let Some(end) = pending.find('\n') {
            let line = pending[..end].trim_end_matches('\r').to_string();
            pending.drain(..=end);
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                done = true;
                continue;
            }
            if data.is_empty() {
                continue;
            }
            let event: Value = serde_json::from_str(data).map_err(|_| "测量SSE事件JSON无效")?;
            if event.get("error").is_some() {
                return Err("服务返回测量流错误".into());
            }
            let choice = &event["choices"][0];
            let delta = &choice["delta"];
            let content = delta.get("content").and_then(Value::as_str).unwrap_or("");
            let reasoning = delta
                .get("reasoning_content")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !content.is_empty() || !reasoning.is_empty() {
                live::on_delta();
            }
            if (!content.is_empty() || !reasoning.is_empty()) && record.first_token_ms.is_none() {
                record.first_token_ms = Some(start.elapsed().as_secs_f64() * 1000.0);
            }
            if !content.is_empty() {
                if record.first_visible_ms.is_none() {
                    record.first_visible_ms = Some(start.elapsed().as_secs_f64() * 1000.0);
                }
                text.push_str(content);
            }
            if let Some(finish) = choice.get("finish_reason").and_then(Value::as_str) {
                record.finish = Some(finish.into());
            }
            if let Some(usage) = event.get("usage") {
                record.input_tokens = usage.get("prompt_tokens").and_then(Value::as_u64);
                record.output_tokens = usage.get("completion_tokens").and_then(Value::as_u64);
                record.cached_tokens = usage
                    .get("prompt_tokens_details")
                    .and_then(|value| value.get("cached_tokens"))
                    .and_then(Value::as_u64);
            }
            if let Some(timings) = event.get("timings") {
                record.decode_ms = finite_nonnegative(timings.get("predicted_ms"));
                record.prompt_ms = finite_nonnegative(timings.get("prompt_ms"));
                record.decode_tok_s = finite_positive(timings.get("predicted_per_second"));
            }
        }
    }
    http::decode_utf8(&mut utf8, &[], true)?;
    record.complete = done
        && record.finish.as_deref() == Some("stop")
        && !text.trim().is_empty()
        && record.output_tokens.is_some_and(|tokens| tokens >= 8);
    record.quality_passed = record.complete;
    if !text.is_empty() {
        record.output_fingerprint = Some(fingerprint(text.trim().as_bytes()));
    }
    if !done {
        return Err("测量流缺少结束标记，不能作为成功样本".into());
    }
    if record.complete && record.scene == Scene::Code {
        if let Err(error) = quality::validate_merge_sorted(&text) {
            record.quality_passed = false;
            return Err(error.reason().into());
        }
    }
    Ok(())
}
fn finite_nonnegative(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
}
fn finite_positive(value: Option<&Value>) -> Option<f64> {
    finite_nonnegative(value).filter(|value| *value > 0.0)
}
fn median(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut values = values.to_vec();
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    Some(if values.len().is_multiple_of(2) {
        (values[middle - 1] + values[middle]) / 2.0
    } else {
        values[middle]
    })
}
fn evaluate(measurements: &[Measurement], candidate_id: &str, expected_pairs: usize) -> Evaluation {
    let mut gain = Vec::new();
    let mut drift = Vec::new();
    let mut reason = "noReliableGain";
    for sample in measurements.iter().filter(|sample| {
        sample.candidate_id == candidate_id && sample.position == Position::Candidate
    }) {
        let matching = |position| {
            measurements.iter().find(|other| {
                other.candidate_id == candidate_id
                    && other.position == position
                    && other.scene == sample.scene
                    && other.round == sample.round
                    && other.cache_mode == sample.cache_mode
            })
        };
        let (Some(before), Some(after)) = (
            matching(Position::BaselineBefore),
            matching(Position::BaselineAfter),
        ) else {
            reason = "incomplete";
            continue;
        };
        if [sample, before, after]
            .into_iter()
            .any(|record| !record.complete)
        {
            reason = "incomplete";
            continue;
        }
        if sample.output_fingerprint.is_none()
            || sample.output_fingerprint != before.output_fingerprint
            || sample.output_fingerprint != after.output_fingerprint
            || [sample, before, after]
                .into_iter()
                .any(|record| !record.quality_passed)
        {
            reason = "qualityMismatch";
            continue;
        }
        let (Some(a), Some(b), Some(c)) =
            (before.decode_tok_s, sample.decode_tok_s, after.decode_tok_s)
        else {
            reason = "missingMetrics";
            continue;
        };
        if a <= 0.0 || b <= 0.0 || c <= 0.0 {
            reason = "missingMetrics";
            continue;
        }
        gain.push(b / a.max(c) - 1.0);
        drift.push((c / a - 1.0).abs());
    }
    let measured_gain = median(&gain);
    let measured_drift = drift.iter().copied().max_by(f64::total_cmp);
    // Every cache/scene/round must improve against the faster of both A runs,
    // by more than observed A drift. No arbitrary 3% threshold can hide drift.
    let accepted = gain.len() == expected_pairs
        && gain.iter().zip(&drift).all(|(gain, drift)| *gain > *drift)
        && measured_gain.is_some_and(|gain| gain > measured_drift.unwrap_or(f64::INFINITY));
    if accepted {
        reason = "reproducibleGain";
    } else if gain.len() != expected_pairs && reason == "noReliableGain" {
        reason = "incomplete";
    }
    Evaluation {
        gain: measured_gain,
        drift: measured_drift,
        pairs: gain.len(),
        accepted,
        reason: reason.into(),
    }
}
fn annotate_consistency(measurements: &mut [Measurement]) {
    let references = measurements.to_vec();
    for sample in measurements {
        let matching = |position| {
            references.iter().find(|other| {
                other.candidate_id == sample.candidate_id
                    && other.position == position
                    && other.scene == sample.scene
                    && other.round == sample.round
                    && other.cache_mode == sample.cache_mode
            })
        };
        let before = matching(Position::BaselineBefore);
        let after = matching(Position::BaselineAfter);
        sample.quality_passed = sample.quality_passed
            && sample.complete
            && sample.output_fingerprint.is_some()
            && before.is_some_and(|before| {
                before.complete
                    && before.quality_passed
                    && before.output_fingerprint == sample.output_fingerprint
            })
            && (sample.position != Position::Candidate
                || after.is_some_and(|after| {
                    after.complete
                        && after.quality_passed
                        && after.output_fingerprint == sample.output_fingerprint
                }));
    }
}
fn with_parameters(config: &Value, parameters: Parameters) -> Result<Value, String> {
    validate_parameters(parameters)?;
    let mut config = config.clone();
    let args = config
        .get("args")
        .and_then(Value::as_array)
        .ok_or("配置缺少引擎参数")?;
    let mut out = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let text = args[index].as_str().ok_or("引擎参数不是字符串")?;
        if ["--pcie-frac", "--spec-min-p"].contains(&text) {
            if index + 1 >= args.len() {
                return Err("原性能参数缺少值".into());
            }
            index += 2;
        } else if text.starts_with("--pcie-frac=") || text.starts_with("--spec-min-p=") {
            index += 1;
        } else {
            out.push(Value::String(text.into()));
            index += 1;
        }
    }
    out.extend([
        json!("--pcie-frac"),
        json!(parameters.pcie_frac.to_string()),
        json!("--spec-min-p"),
        json!(parameters.spec_min_p.to_string()),
    ]);
    config["args"] = Value::Array(out);
    storage::validate(&config)?;
    Ok(config)
}
/// Restore private original bytes after a backend crash during a config switch.
/// Call before restore_default() and before opening the UI to new mutations.
pub fn recover_pending_configs(state: &Arc<RuntimeState>) -> Result<(), String> {
    // Backfill legacy reports in the existing startup recovery scan. Keep
    // the durable task order; filesystem enumeration is not chronological.
    // Status never traverses an arbitrary prefix of the directory.
    {
        let database = state.database.lock().map_err(|e| e.to_string())?;
        ensure_report_index(&database)?;
    }
    restart::recover_pending(state)?;
    let directory = report_dir(state);
    if !directory.exists() {
        return Ok(());
    }
    for item in fs::read_dir(&directory).map_err(|e| e.to_string())? {
        let path = item.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(mut job) = read_persisted_job(state, id) else {
            continue;
        };
        index_report_with_order(state, &job, false)?;
        // Full-scenario temporary restarts have their own durable stage journal.
        // Do not race its asynchronous health recovery with legacy apply recovery.
        if job.full.scope == restart::Scope::FullScenario
            && restart::has_active_stage(state, &job.id)?
        {
            continue;
        }
        if matches!(job.state, Phase::Applying | Phase::RollingBack) {
            let profile = state.registered_profile(&job.profile_id)?;
            let config = assert_managed_config(state, &profile)?;
            let original = fs::read(directory.join(format!("{}.original", job.id)))
                .map_err(|e| format!("调优恢复副本不可用: {e}"))?;
            if fingerprint(&original) != job.config_fingerprint {
                return Err("调优恢复副本校验失败，需人工修复".into());
            }
            let current = fs::read(&config).map_err(|e| e.to_string())?;
            if fingerprint(&current) != job.config_fingerprint
                && Some(fingerprint(&current)) != job.applied_config_fingerprint
            {
                return Err("中断后配置已有其它变更，未自动覆盖；请修复后重开".into());
            }
            atomic_bytes(&config, &original)?;
            job.state = Phase::Restored;
            job.error = Some("后台中断，原配置已恢复；模型将按原配置准备".into());
        } else if job.state.active() {
            job.state = Phase::Interrupted;
            job.error = Some("后台中断，测量未改变配置；不完整结果不能应用".into());
        }
        if matches!(job.state, Phase::Restored | Phase::Interrupted) {
            job.finished_at = Some(now());
            job.updated_at = now();
            persist(state, &job)?;
        }
    }
    Ok(())
}
pub async fn apply(
    state: Arc<RuntimeState>,
    job_id: String,
    candidate_id: String,
) -> Result<TuningJob, String> {
    assert_available(&state)?;
    let job = read_job(&state, &job_id)?;
    if job.state != Phase::Completed {
        return Err("只能应用已完整完成且未应用的报告".into());
    }
    if job.full.report_version != 2 || job.full.scope != restart::Scope::FullScenario {
        return Err(
            "旧报告或短请求诊断没有完整场景复验，请重新按用途调优后应用；已应用参数仍可恢复".into(),
        );
    }
    // Historic reports remain readable/restorable. A pre-semantic Code report
    // cannot qualify for a new application based only on matching hashes.
    if job.full.scope == restart::Scope::RequestDiagnostic
        && job.scenes.contains(&Scene::Code)
        && job.identity["benchmarkVersion"].as_str() != Some(quality::VERSION)
    {
        return Err("旧编程调优报告缺少语义复验，请重新测量后应用".into());
    }
    let candidate = job
        .candidates
        .iter()
        .find(|candidate| {
            candidate.id == candidate_id
                && candidate
                    .evaluation
                    .as_ref()
                    .is_some_and(|evaluation| evaluation.accepted)
        })
        .ok_or("候选没有通过收益和质量复验，保持原参数")?
        .clone();
    restart::validate_application(&job, &candidate)?;
    change_configuration(state, job, Some(candidate)).await
}
pub async fn restore(state: Arc<RuntimeState>, job_id: String) -> Result<TuningJob, String> {
    assert_available(&state)?;
    let job = read_job(&state, &job_id)?;
    if job.state != Phase::Applied {
        return Err("此报告没有待恢复的已应用参数".into());
    }
    change_configuration(state, job, None).await
}
async fn change_configuration(
    state: Arc<RuntimeState>,
    mut job: TuningJob,
    candidate: Option<Candidate>,
) -> Result<TuningJob, String> {
    let parameters = candidate.as_ref().map(Candidate::parameters);
    crate::runtime_upgrade::assert_available(&state)?;
    let profile = state.registered_profile(&job.profile_id)?;
    require_owned(&state, &profile).await?;
    let path = assert_managed_config(&state, &profile)?;
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let expected = if parameters.is_some() {
        Some(job.config_fingerprint.clone())
    } else {
        job.applied_config_fingerprint.clone()
    };
    if Some(fingerprint(&bytes)) != expected {
        return Err("配置已改变，旧报告不能覆盖新设置，请重新测量".into());
    }
    let backup_path = report_dir(&state).join(format!("{}.original", job.id));
    let target = if let Some(parameters) = parameters {
        atomic_bytes(&backup_path, &bytes)?;
        let config = with_parameters(
            &serde_json::from_slice(&bytes).map_err(|e| e.to_string())?,
            parameters,
        )?;
        serde_json::to_vec_pretty(&restart::with_restart(
            &config,
            candidate.as_ref().and_then(|c| c.restart.as_ref()),
        )?)
        .map_err(|e| e.to_string())?
    } else {
        let original = fs::read(&backup_path).map_err(|e| e.to_string())?;
        if fingerprint(&original) != job.config_fingerprint {
            return Err("原配置副本校验失败".into());
        }
        original
    };
    let lock = {
        let mut locks = state.ensure_locks.lock().await;
        locks.entry(profile.id.clone()).or_default().clone()
    };
    let _runtime_lock = lock.try_lock_owned().map_err(|_| "模型正在准备或维护")?;
    let maintenance_token = uuid::Uuid::new_v4().to_string();
    let _gate = crate::maintenance::begin(&state, &profile.id, Some(&maintenance_token), "tuning")?;
    crate::maintenance::wait_idle(&state, &profile).await?;
    // Recheck after admission closes; no bytes may be overwritten by a stale report.
    if fs::read(&path).map_err(|e| e.to_string())? != bytes {
        return Err("等待空闲时配置发生变化，未应用".into());
    }
    let old_metrics = read_metrics(&state, &profile).await?;
    if parameters.is_some() && job.full.scope == restart::Scope::FullScenario {
        restart::check_live_resources(&old_metrics)?;
    }
    let config: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    restart::check_restart_ram(&config, candidate.as_ref().and_then(|c| c.restart.as_ref()))?;
    if parameters.is_some()
        && restart::bound_identity(&profile, &config, &old_metrics, &job) != job.identity
    {
        return Err("模型、引擎或硬件身份已变化，请重新测量".into());
    }
    job.state = if parameters.is_some() {
        Phase::Applying
    } else {
        Phase::RollingBack
    };
    job.current_step = "switchingConfiguration".into();
    job.updated_at = now();
    job.full.recovery = restart::Recovery {
        state: restart::RecoveryState::Pending,
        configuration_restored: false,
        service_verified: false,
        error: None,
    };
    if parameters.is_some() {
        job.applied_config_fingerprint = Some(fingerprint(&target));
    }
    register_active(&state, &job, CancellationToken::new())?;
    let operation = async {
        let native_operation = NativeOperation::new();
        restart::begin_application(&state, &job, &profile, &bytes, &target)?;
        if fs::read(&path).map_err(|e| e.to_string())? != bytes {
            return Err("应用发布前配置被另行编辑，未覆盖".into());
        }
        atomic_bytes(&path, &target)?;
        update(&state, &job.id, |job| {
            // A successful candidate write is deliberately not restoration.
            job.full.recovery.configuration_restored = parameters.is_none();
        })?;
        crate::restart_service_for_tuning(
            state.clone(),
            profile.clone(),
            &job.id,
            &native_operation.0,
        )
        .await?;
        verify_restarted(
            &state,
            &profile,
            &maintenance_token,
            parameters.unwrap_or(job.baseline),
        )
        .await?;
        restart::verify_flags(
            &state,
            &profile,
            candidate.as_ref().and_then(|c| c.restart.as_ref()),
        )
        .await
        .map(|_| ())?;
        update(&state, &job.id, |job| {
            job.full.recovery.state = if parameters.is_some() {
                restart::RecoveryState::NotNeeded
            } else {
                restart::RecoveryState::Restored
            };
            job.full.recovery.service_verified = true;
        })?;
        Ok(())
    };
    let result: Result<(), String> = tokio::time::timeout(
        Duration::from_secs(job.full.limits.recovery_deadline_seconds),
        operation,
    )
    .await
    .unwrap_or_else(|_| Err("配置应用超过硬时限，正在独立恢复原配置/服务".into()));
    match result {
        Ok(()) => {
            let done = update(&state, &job.id, |job| {
                job.state = if parameters.is_some() {
                    Phase::Applied
                } else {
                    Phase::Restored
                };
                job.current_step = "finished".into();
                job.finished_at = Some(now());
                job.error = None;
            })?;
            if let Err(error) = restart::settle_application(&state, &job, &profile) {
                return update(&state, &job.id, |job| {
                    job.state = Phase::Failed;
                    job.error = Some(error.clone());
                    job.full.recovery.state = restart::RecoveryState::Failed;
                    job.full.recovery.error = Some(error);
                });
            }
            Ok(done)
        }
        Err(error) => {
            update(&state, &job.id, |job| {
                job.state = Phase::RollingBack;
                job.error = Some(error.clone());
                job.full.recovery = restart::Recovery {
                    state: restart::RecoveryState::Restoring,
                    configuration_restored: false,
                    service_verified: false,
                    error: None,
                };
            })?;
            let rollback = async {
                let native_operation = NativeOperation::new();
                let original = fs::read(&backup_path).map_err(|e| e.to_string())?;
                let current = fs::read(&path).map_err(|e| e.to_string())?;
                if current != target && current != bytes && current != original {
                    return Err("配置已有其它变更，未覆盖该配置；需要手动检查".into());
                }
                if fingerprint(&original) != job.config_fingerprint {
                    return Err("原配置副本校验失败".into());
                }
                atomic_bytes(&path, &original)?;
                update(&state, &job.id, |job| {
                    job.full.recovery.configuration_restored = true
                })?;
                crate::restart_service_for_tuning(
                    state.clone(),
                    profile.clone(),
                    &job.id,
                    &native_operation.0,
                )
                .await?;
                verify_restarted(&state, &profile, &maintenance_token, job.baseline).await?;
                update(&state, &job.id, |job| {
                    job.full.recovery.state = restart::RecoveryState::Restored;
                    job.full.recovery.service_verified = true;
                })?;
                Ok(())
            };
            let rollback: Result<(), String> = tokio::time::timeout(
                Duration::from_secs(job.full.limits.recovery_deadline_seconds),
                rollback,
            )
            .await
            .unwrap_or_else(|_| Err("原配置/服务恢复超过硬时限，journal保留".into()));
            let recovered = rollback.is_ok();
            let done = update(&state, &job.id, |job| {
                job.state = if rollback.is_ok() {
                    Phase::Restored
                } else {
                    Phase::Failed
                };
                job.current_step = "finished".into();
                job.finished_at = Some(now());
                if !recovered {
                    job.full.recovery.state = restart::RecoveryState::Failed;
                    job.full.recovery.error = rollback.as_ref().err().cloned();
                }
                job.error = Some(match rollback {
                    Ok(()) => format!("应用失败，原配置和服务已恢复：{error}"),
                    Err(rollback) => {
                        format!("应用失败：{error}；恢复失败：{rollback}；请重新准备模型")
                    }
                });
            })?;
            if recovered {
                if let Err(error) = restart::settle_application(&state, &job, &profile) {
                    return update(&state, &job.id, |job| {
                        job.state = Phase::Failed;
                        job.error = Some(error.clone());
                        job.full.recovery.state = restart::RecoveryState::Failed;
                        job.full.recovery.error = Some(error);
                    });
                }
            }
            Ok(done)
        }
    }
}
async fn wait_restarted_api(state: &RuntimeState, profile: &ServiceProfile) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(response) =
            http::strata_request(state, profile.clone(), "/health".into(), "GET".into(), None).await
        {
            if response.get("service").and_then(Value::as_str) == Some("strata") {
                return Ok(());
            }
        }
        if Instant::now() > deadline {
            return Err("配置切换后API未恢复".into());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}
async fn verify_restarted(
    state: &RuntimeState,
    profile: &ServiceProfile,
    token: &str,
    parameters: Parameters,
) -> Result<(), String> {
    wait_restarted_api(state, profile).await?;
    let response = http::request_builder(&state.client, profile, "/load", "POST", Some(json!({})))?
        .header("X-Strata-Manager-Tuning-Id", token)
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .map_err(|_| "切换后模型加载失败")?;
    if !response.status().is_success() {
        return Err(format!("切换后加载 HTTP {}", response.status().as_u16()));
    }
    let health =
        http::strata_request(state, profile.clone(), "/health".into(), "GET".into(), None).await?;
    if health.get("loaded").and_then(Value::as_bool) != Some(true) {
        return Err("切换后模型尚未就绪".into());
    }
    let metrics = read_metrics(state, profile).await?;
    let actual = baseline_parameters(&metrics)?;
    if (actual.pcie_frac - parameters.pcie_frac).abs() > 0.000001
        || (actual.spec_min_p - parameters.spec_min_p).abs() > 0.000001
    {
        return Err("新参数未在实际引擎生效".into());
    }
    let probe = measure(
        state,
        profile,
        Probe {
            parameters,
            messages: &json!([{"role":"user","content":"Reply with the single word READY."}]),
            scene: Scene::Chat,
            max_tokens: 32,
            maintenance_token: token,
            tune_extra: Value::Null,
        },
        &CancellationToken::new(),
    )
    .await;
    if !(probe.complete
        || (probe.error.is_none()
            && probe.finish.as_deref() == Some("stop")
            && probe.first_visible_ms.is_some()))
    {
        return Err("切换后短请求验收失败".into());
    }
    Ok(())
}

// Stable content identity binds reports and recovery bytes without retaining text.
pub fn fingerprint(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
#[path = "tuning_status_tests.rs"]
mod status_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deepseek41_configs_are_not_tuned_or_calibrated() {
        let temp = tempfile::tempdir().unwrap();
        let deepseek = temp.path().join("deepseek.json");
        fs::write(&deepseek, br#"{"arch":"deepseek41","args":[]}"#).unwrap();
        assert!(assert_tunable(&deepseek).unwrap_err().contains("DeepSeek"));
        let qwen = temp.path().join("qwen.json");
        fs::write(&qwen, br#"{"args":[]}"#).unwrap();
        assert!(assert_tunable(&qwen).is_ok());
    }
    #[test]
    fn baseline_accepts_official_info_strings_and_json_numbers() {
        let actual_0143 =
            json!({"engine":{"version":"0.1.43","pcie_frac":"0.55","spec_min_p":"0.50"}});
        let baseline = baseline_parameters(&actual_0143).unwrap();
        assert_eq!(
            baseline,
            Parameters {
                pcie_frac: 0.55,
                spec_min_p: 0.5
            }
        );
        assert_eq!(
            baseline_parameters(&json!({"engine":{"pcie_frac":0.55,"spec_min_p":0.5}})).unwrap(),
            baseline
        );
        assert_eq!(
            baseline_parameters(&json!({"engine":{"pcie_frac":" 5.5e-1 ","spec_min_p":"5.0e-1"}}))
                .unwrap(),
            baseline
        );
        for edge in [0, 1] {
            let number =
                baseline_parameters(&json!({"engine":{"pcie_frac":edge,"spec_min_p":edge}}))
                    .unwrap();
            let text = baseline_parameters(
                &json!({"engine":{"pcie_frac":edge.to_string(),"spec_min_p":edge.to_string()}}),
            )
            .unwrap();
            assert_eq!(number, text);
        }
    }

    #[test]
    fn baseline_rejects_malformed_or_nonfinite_engine_values() {
        let mut invalid = vec![json!(null), json!(true), json!([]), json!({})];
        for text in [
            "",
            "NaN",
            "inf",
            "Infinity",
            "-Infinity",
            "1e9999",
            "+0.5",
            ".5",
            "01",
            "0,55",
            "0.55junk",
            "0x1",
            "\"0.55\"",
        ] {
            invalid.push(json!(text));
        }
        invalid.push(json!("0".repeat(65)));
        for key in ["pcie_frac", "spec_min_p"] {
            for value in &invalid {
                let mut metrics = json!({"engine":{"pcie_frac":0.55,"spec_min_p":0.5}});
                metrics["engine"][key] = value.clone();
                assert!(
                    baseline_parameters(&metrics).is_err(),
                    "accepted {key}={value}"
                );
            }
        }
    }

    #[test]
    fn baseline_requires_both_parameters_in_the_engine_domain() {
        for key in ["pcie_frac", "spec_min_p"] {
            for number in [-0.000001, 1.000001] {
                for value in [json!(number), json!(number.to_string())] {
                    let mut metrics = json!({"engine":{"pcie_frac":0.55,"spec_min_p":0.5}});
                    metrics["engine"][key] = value;
                    assert_eq!(
                        baseline_parameters(&metrics).unwrap_err(),
                        "PCIe 与 MTP 参数须为 0–1 有限数字"
                    );
                }
            }
        }
    }

    #[test]
    fn baseline_never_substitutes_config_defaults_or_observed_pcie_share() {
        assert_eq!(
            baseline_parameters(&json!({
                "engine":{"spec_min_p":"0.50"}, "requests":[{"pcie_share":0.005}],
                "args":["--pcie-frac","0.55"]
            }))
            .unwrap_err(),
            "引擎没有报告 PCIe 参数，不能可靠调优"
        );
        assert_eq!(
            baseline_parameters(&json!({"engine":{"pcie_frac":"0.55"}})).unwrap_err(),
            "引擎没有报告 MTP 参数，不能可靠调优"
        );
    }

    #[test]
    fn sha256_matches_external_known_vectors() {
        assert_eq!(
            fingerprint(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            fingerprint(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
    fn triplet(a: f64, b: f64, c: f64, round: usize) -> Vec<Measurement> {
        [
            (Position::BaselineBefore, a),
            (Position::Candidate, b),
            (Position::BaselineAfter, c),
        ]
        .into_iter()
        .map(|(position, rate)| {
            let mut record = empty_measurement(Scene::Chat);
            record.candidate_id = "test".into();
            record.position = position;
            record.round = round;
            record.decode_tok_s = Some(rate);
            record.complete = true;
            record.quality_passed = true;
            record.output_fingerprint = Some("identical".into());
            record
        })
        .collect()
    }
    #[test]
    fn faster_single_run_does_not_hide_baseline_drift() {
        let samples = [
            triplet(100.0, 120.0, 117.0, 0),
            triplet(115.0, 122.0, 116.0, 1),
        ]
        .concat();
        let result = evaluate(&samples, "test", 2);
        assert!(!result.accepted);
        assert_eq!(result.pairs, 2);
        assert!(result.drift.unwrap() > 0.16);
    }
    #[test]
    fn reproducible_gain_requires_all_scenes_and_identical_complete_output() {
        let mut samples = [
            triplet(100.0, 112.0, 101.0, 0),
            triplet(101.0, 113.0, 100.0, 1),
        ]
        .concat();
        assert!(evaluate(&samples, "test", 2).accepted);
        samples[1].output_fingerprint = Some("changed".into());
        assert!(!evaluate(&samples, "test", 2).accepted);
        assert_eq!(evaluate(&samples, "test", 2).reason, "qualityMismatch");
        samples[1].output_fingerprint = Some("identical".into());
        samples[4].complete = false;
        assert!(!evaluate(&samples, "test", 2).accepted);
        samples[4].complete = true;
        samples[4].decode_tok_s = None;
        assert_eq!(evaluate(&samples, "test", 2).reason, "missingMetrics");
    }
    #[test]
    fn identical_but_semantically_wrong_code_cannot_become_a_recommendation() {
        let mut samples = triplet(100.0, 200.0, 100.0, 0);
        for sample in &mut samples {
            sample.scene = Scene::Code;
            sample.quality_passed = false;
        }
        annotate_consistency(&mut samples);
        assert!(samples.iter().all(|sample| !sample.quality_passed));
        let result = evaluate(&samples, "test", 1);
        assert!(!result.accepted);
        assert_eq!(result.reason, "qualityMismatch");
        // One bad member invalidates the candidate even when all hashes agree.
        for sample in &mut samples {
            sample.quality_passed = true;
        }
        samples[2].quality_passed = false;
        annotate_consistency(&mut samples);
        assert!(!samples[1].quality_passed);
        assert!(!evaluate(&samples, "test", 1).accepted);
    }
    fn admission_fixture_job(phase: Phase) -> TuningJob {
        TuningJob {
            live_log: vec![],
            id: uuid::Uuid::new_v4().to_string(),
            profile_id: "isolated-admission".into(),
            state: phase,
            scenes: vec![Scene::Code],
            rounds: 2,
            max_tokens: 128,
            started_at: now(),
            updated_at: now(),
            finished_at: None,
            completed_requests: 0,
            total_requests: 12,
            current_step: "fixture-registration".into(),
            baseline: Parameters {
                pcie_frac: 0.5,
                spec_min_p: 0.5,
            },
            candidates: vec![],
            measurements: vec![],
            recommended_candidate_id: None,
            identity: json!({"benchmarkVersion":quality::VERSION}),
            config_fingerprint: "fixture".into(),
            applied_config_fingerprint: None,
            error: None,
            notes: vec![],
            full: FullReport::default(),
        }
    }
    fn register_admission_profile(state: &RuntimeState) {
        let profile = ServiceProfile {
            id: "isolated-admission".into(),
            name: "Isolated admission".into(),
            base_url: "http://127.0.0.1:1".into(),
            install_dir: state.data_dir().to_string_lossy().into(),
            python_path: "unused".into(),
            config_path: state
                .data_dir()
                .join("unused.json")
                .to_string_lossy()
                .into(),
            managed: true,
        };
        let text = serde_json::to_string(&profile).unwrap();
        state
            .database
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO local_installations VALUES(?1,?2,?3,?4)",
                rusqlite::params![profile.id, text, text, now() as i64],
            )
            .unwrap();
    }
    #[test]
    fn registration_rechecks_external_handoff_inside_the_operation_lock() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().into()).unwrap();
        register_admission_profile(&state);
        let profile = state.registered_profile("isolated-admission").unwrap();
        let mut root = dunce::canonicalize(&profile.install_dir)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        if cfg!(windows) {
            root = root.to_lowercase();
        }
        state.database.lock().unwrap().execute_batch("CREATE TABLE external_management(install_root TEXT PRIMARY KEY,profile_id TEXT,external INTEGER,updated_at INTEGER)").unwrap();
        state
            .database
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO external_management VALUES(?1,?2,1,0)",
                rusqlite::params![root, profile.id],
            )
            .unwrap();
        let job = admission_fixture_job(Phase::Checking);
        assert!(register_active(&state, &job, CancellationToken::new())
            .unwrap_err()
            .contains("外部助手"));
        assert!(!report_path(&state, &job.id).unwrap().exists());
        assert!(assert_no_active_tuning(&state).is_ok());
    }
    #[test]
    fn registration_rechecks_upgrade_selection_and_active_tasks_before_persisting() {
        use std::sync::atomic::Ordering;
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().into()).unwrap();
        register_admission_profile(&state);
        let job = admission_fixture_job(Phase::Checking);
        state.runtime_upgrading.store(true, Ordering::Release);
        // The shared GUI/API availability check must still allow the old
        // service during preparation. Only tuning admission is excluded.
        assert!(assert_available(&state).is_ok());
        assert!(register_active(&state, &job, CancellationToken::new()).is_err());
        assert!(!report_path(&state, &job.id).unwrap().exists());
        state.runtime_upgrading.store(false, Ordering::Release);
        state.selection_changing.store(true, Ordering::Release);
        assert!(register_active(&state, &job, CancellationToken::new()).is_err());
        state.selection_changing.store(false, Ordering::Release);
        register_active(&state, &job, CancellationToken::new()).unwrap();
        assert!(assert_no_active_tuning(&state).is_err());
        let applying = admission_fixture_job(Phase::Applying);
        assert!(register_active(&state, &applying, CancellationToken::new()).is_err());
        assert!(!report_path(&state, &applying.id).unwrap().exists());
        registry().lock().unwrap().remove(state.data_dir());
    }
    #[test]
    fn tuning_registration_and_upgrade_cas_cannot_both_win_the_race() {
        use std::sync::{atomic::Ordering, Barrier};
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().into()).unwrap();
        register_admission_profile(&state);
        for phase in [Phase::Checking, Phase::Applying] {
            for _ in 0..20 {
                let barrier = Arc::new(Barrier::new(2));
                let tuning_state = state.clone();
                let tuning_barrier = barrier.clone();
                let tuning = std::thread::spawn(move || {
                    tuning_barrier.wait();
                    register_active(
                        &tuning_state,
                        &admission_fixture_job(phase),
                        CancellationToken::new(),
                    )
                    .is_ok()
                });
                let upgrade_state = state.clone();
                let upgrade = std::thread::spawn(move || {
                    barrier.wait();
                    upgrade_state
                        .runtime_upgrading
                        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                        .unwrap();
                    let admitted = assert_no_active_tuning(&upgrade_state).is_ok();
                    // Match UpgradeFlag's rollback on failure. Keep successful
                    // admission held until the competing tuning attempt ends.
                    if !admitted {
                        upgrade_state
                            .runtime_upgrading
                            .store(false, Ordering::Release);
                    }
                    admitted
                });
                let tuning_admitted = tuning.join().unwrap();
                let upgrade_admitted = upgrade.join().unwrap();
                assert_ne!(
                    tuning_admitted, upgrade_admitted,
                    "exactly one concurrent maintenance path may be admitted"
                );
                state.runtime_upgrading.store(false, Ordering::Release);
                registry().lock().unwrap().remove(state.data_dir());
            }
        }
    }
    #[test]
    fn arguments_replace_both_spellings_without_touching_other_config() {
        let config = json!({"args":["--native","weights.gguf","--pcie-frac","0.5","--spec-min-p=0.7","--pool-workers","4"],"sampling":{"temperature":0.8},"vision":{"exe":"encoder"},"api_key":"keep-private"});
        let edited = with_parameters(
            &config,
            Parameters {
                pcie_frac: 0.2,
                spec_min_p: 0.3,
            },
        )
        .unwrap();
        assert_eq!(
            edited["args"],
            json!([
                "--native",
                "weights.gguf",
                "--pool-workers",
                "4",
                "--pcie-frac",
                "0.2",
                "--spec-min-p",
                "0.3"
            ])
        );
        for field in ["sampling", "vision", "api_key"] {
            assert_eq!(edited[field], config[field]);
        }
        assert!(with_parameters(
            &config,
            Parameters {
                pcie_frac: f64::NAN,
                spec_min_p: 0.3
            }
        )
        .is_err());
    }
    #[test]
    fn interrupted_apply_restores_exact_private_bytes_not_original_install() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().into()).unwrap();
        let managed = temp.path().join("snapshot.json");
        let original = b"{\"args\":[\"--native\",\"model\"],\"sampling\":{\"temperature\":0.7}}\n";
        let changed = b"{\"args\":[\"--native\",\"model\",\"--pcie-frac\",\"0.2\"]}";
        fs::write(&managed, changed).unwrap();
        let profile = ServiceProfile {
            id: "fixture".into(),
            name: "fixture".into(),
            base_url: "http://127.0.0.1:18000".into(),
            install_dir: temp.path().to_string_lossy().into(),
            python_path: "".into(),
            config_path: managed.to_string_lossy().into(),
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
                    now() as i64
                ],
            )
            .unwrap();
        let job = TuningJob {
            live_log: vec![],
            id: uuid::Uuid::new_v4().to_string(),
            profile_id: profile.id.clone(),
            state: Phase::Applying,
            scenes: vec![Scene::Chat],
            rounds: 2,
            max_tokens: 512,
            started_at: now(),
            updated_at: now(),
            finished_at: None,
            completed_requests: 0,
            total_requests: 12,
            current_step: "switchingConfiguration".into(),
            baseline: Parameters {
                pcie_frac: 0.5,
                spec_min_p: 0.5,
            },
            candidates: vec![],
            measurements: vec![],
            recommended_candidate_id: None,
            identity: json!({}),
            config_fingerprint: fingerprint(original),
            applied_config_fingerprint: Some(fingerprint(changed)),
            error: None,
            notes: vec![],
            full: FullReport::default(),
        };
        persist(&state, &job).unwrap();
        fs::write(
            report_dir(&state).join(format!("{}.original", job.id)),
            original,
        )
        .unwrap();
        recover_pending_configs(&state).unwrap();
        assert_eq!(fs::read(&managed).unwrap(), original);
        assert_eq!(read_job(&state, &job.id).unwrap().state, Phase::Restored);
        assert!(!serde_json::to_string(&read_job(&state, &job.id).unwrap())
            .unwrap()
            .contains("temperature"));
    }
    fn fixture_response(body: &str, delay: Duration) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = body.as_bytes().to_vec();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request);
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).as_bytes()).unwrap();
            std::thread::sleep(delay);
            for chunk in body.chunks(3) {
                if stream.write_all(chunk).is_err() {
                    break;
                }
            }
        });
        format!("http://{address}/v1/chat/completions")
    }
    #[tokio::test]
    async fn real_http_split_unicode_preserves_timings_and_requires_done() {
        let body="data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"想\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"你好🙂完整回答\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":120,\"completion_tokens\":20,\"prompt_tokens_details\":{\"cached_tokens\":110}},\"timings\":{\"predicted_ms\":200,\"predicted_per_second\":100,\"prompt_ms\":12}}\n\ndata: [DONE]\n\n";
        let url = fixture_response(body, Duration::from_millis(20));
        let start = Instant::now();
        let response = reqwest::Client::new().get(url).send().await.unwrap();
        let mut record = empty_measurement(Scene::Chinese);
        consume_response(response, start, &CancellationToken::new(), &mut record)
            .await
            .unwrap();
        assert!(record.complete);
        assert_eq!(
            record.output_fingerprint,
            Some(fingerprint("你好🙂完整回答".as_bytes()))
        );
        assert_eq!(record.decode_tok_s, Some(100.0));
        assert_eq!(record.cached_tokens, Some(110));
        assert!(record.first_token_ms.unwrap() >= 15.0);
        assert!(record.first_visible_ms.unwrap() >= record.first_token_ms.unwrap());
        let url = fixture_response(
            "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
            Duration::ZERO,
        );
        let response = reqwest::Client::new().get(url).send().await.unwrap();
        assert!(consume_response(
            response,
            Instant::now(),
            &CancellationToken::new(),
            &mut empty_measurement(Scene::Chat)
        )
        .await
        .is_err());
    }
    #[tokio::test]
    async fn complete_code_sse_requires_semantics_and_never_persists_the_answer() {
        let correct = "def merge_sorted(a, b):\n    \"\"\"Merge without sorting or modifying inputs.\"\"\"\n    out = []\n    i = j = 0\n    while i < len(a) and j < len(b):\n        if a[i] <= b[j]:\n            out.append(a[i]); i += 1\n        else:\n            out.append(b[j]); j += 1\n    return out + a[i:] + b[j:]\nassert merge_sorted([1], [1]) == [1, 1]\nassert merge_sorted([], [1]) == [1]\n";
        let wrong = "def merge_sorted(a, b):\n    \"\"\"DO_NOT_PERSIST_CODE_OR_RESPONSE\"\"\"\n    return []\nassert merge_sorted([], []) == []\nassert merge_sorted([], []) == []\n";
        for (source, passed) in [(correct, true), (wrong, false)] {
            let event = json!({"choices":[{"delta":{"content":source},"finish_reason":"stop"}],"usage":{"completion_tokens":100},"timings":{"predicted_per_second":120}});
            let body = format!("data: {event}\n\ndata: [DONE]\n\n");
            let url = fixture_response(&body, Duration::ZERO);
            let response = reqwest::Client::new().get(url).send().await.unwrap();
            let mut record = empty_measurement(Scene::Code);
            let result = consume_response(
                response,
                Instant::now(),
                &CancellationToken::new(),
                &mut record,
            )
            .await;
            assert_eq!(result.is_ok(), passed);
            assert!(record.complete);
            assert_eq!(record.quality_passed, passed);
            assert_eq!(
                record.output_fingerprint,
                Some(fingerprint(source.trim().as_bytes()))
            );
            if let Err(reason) = result {
                record.error = Some(reason);
            }
            let serialized = serde_json::to_string(&record).unwrap();
            assert!(!serialized.contains("DO_NOT_PERSIST_CODE_OR_RESPONSE"));
            assert!(!serialized.contains("def merge_sorted"));
        }
    }
    #[tokio::test]
    async fn cancellation_disconnects_only_its_own_http_stream() {
        let url = fixture_response("data: [DONE]\n\n", Duration::from_millis(500));
        let response = reqwest::Client::new().get(url).send().await.unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let mut record = empty_measurement(Scene::Chat);
        let started = Instant::now();
        let result = consume_response(response, started, &cancel, &mut record).await;
        assert!(result.unwrap_err().contains("取消"));
        assert!(started.elapsed() < Duration::from_millis(200));
        assert!(!record.complete);
    }

    fn fixture_python() -> String {
        let mut command = std::process::Command::new(if cfg!(windows) { "py" } else { "python3" });
        command.args(["-I", "-S", "-c", "import sys;print(sys.executable)"]);
        crate::processes::hidden(&mut command);
        let result = command
            .output()
            .expect("Python is required for the isolated lifecycle fixture");
        assert!(result.status.success());
        String::from_utf8(result.stdout).unwrap().trim().into()
    }
    pub(super) async fn live_fixture() -> (
        tempfile::TempDir,
        Arc<RuntimeState>,
        ServiceProfile,
        Vec<u8>,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let runtime = temp.path().join("runtime");
        fs::create_dir_all(runtime.join("serve")).unwrap();
        fs::write(runtime.join("setup.py"), "# isolated fixture only").unwrap();
        fs::write(
            runtime.join("serve/server.py"),
            include_str!("../tests/fixtures/tuning_service.py"),
        )
        .unwrap();
        let model = runtime.join("fixture.gguf");
        fs::write(&model, b"GGUF isolated fixture, never loaded").unwrap();
        let python = fixture_python();
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let state = RuntimeState::open(data.clone()).unwrap();
        let profile = ServiceProfile {
            id: "tuning-fixture".into(),
            name: "tuning-fixture".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            install_dir: runtime.to_string_lossy().into(),
            python_path: python.clone(),
            config_path: data.join("strata-fixture.json").to_string_lossy().into(),
            managed: true,
        };
        let original=serde_json::to_vec_pretty(&json!({"exe":python,"args":["--native",model,"--pcie-frac","0.5","--spec-min-p","0.5"],"cwd":runtime,"tokenizer":runtime,"model_name":"tuning-fixture","port":port,"host":"127.0.0.1"})).unwrap();
        fs::write(&profile.config_path, &original).unwrap();
        fs::write(runtime.join("source-config.json"), &original).unwrap();
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
                    now() as i64
                ],
            )
            .unwrap();
        crate::store_set(&state, "activeLocalInstallation".into(), json!(profile.id)).unwrap();
        crate::start_service(state.clone(), profile.clone())
            .await
            .unwrap();
        for _ in 0..100 {
            if http::strata_request(
                &state,
                profile.clone(),
                "/health".into(),
                "GET".into(),
                None,
            )
            .await
            .is_ok()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        http::strata_request(
            &state,
            profile.clone(),
            "/load".into(),
            "POST".into(),
            Some(json!({})),
        )
        .await
        .unwrap();
        (temp, state, profile, original)
    }
    pub(super) async fn await_job(state: &RuntimeState, profile: &ServiceProfile) -> TuningJob {
        // The runner publishes completion first and attaches the ended live log
        // right after; wait for both so callers snapshot the final report.
        let mut settled = 0;
        for _ in 0..1750 {
            let job = status(state, profile.id.clone()).unwrap().unwrap();
            if !job.state.active() {
                if !job.live_log.is_empty() || settled >= 250 {
                    return job;
                }
                settled += 1;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("isolated fixture tuning did not finish");
    }
    fn fixture_request(parameters: Parameters) -> TuningStartRequest {
        TuningStartRequest {
            scenes: vec![Scene::Chat],
            rounds: 2,
            max_tokens: 128,
            candidates: Some(vec![parameters]),
            full: FullOptions::default(),
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn actual_owned_python_aba_apply_restart_restore_and_no_gain() {
        let (_temp, state, profile, original) = live_fixture().await;
        let started = start(
            state.clone(),
            profile.id.clone(),
            fixture_request(Parameters {
                pcie_frac: 0.35,
                spec_min_p: 0.5,
            }),
        )
        .await
        .unwrap();
        assert_eq!(started.total_requests, 12);
        let completed = await_job(&state, &profile).await;
        assert_eq!(completed.state, Phase::Completed, "{:?}", completed.error);
        assert_eq!(completed.measurements.len(), 12);
        assert_eq!(completed.completed_requests, 12);
        assert_eq!(
            completed.recommended_candidate_id.as_deref(),
            Some("candidate-1")
        );
        // The live log is kept in the report once the job ends: metadata only.
        let mut logged = read_job(&state, &completed.id).unwrap();
        for _ in 0..500 {
            if !logged.live_log.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
            logged = read_job(&state, &completed.id).unwrap();
        }
        assert_eq!(
            logged
                .live_log
                .iter()
                .filter(|line| line.key == "sample")
                .count(),
            12
        );
        assert_eq!(logged.live_log.last().unwrap().key, "finished");
        assert_eq!(
            logged.updated_at, completed.updated_at,
            "attaching the log keeps the report time"
        );
        let stored = serde_json::to_string(&logged).unwrap();
        assert!(!stored.contains("refrigerator") && !stored.contains("\"prompt\":"));
        assert_eq!(fs::read(&profile.config_path).unwrap(), original);
        let source = Path::new(&profile.install_dir).join("source-config.json");
        assert_eq!(fs::read(&source).unwrap(), original);
        // Emulate a historic hash-only Code report. It remains readable, but
        // cannot be newly applied even when its recorded gain was accepted.
        update(&state, &completed.id, |job| job.scenes = vec![Scene::Code]).unwrap();
        assert_eq!(
            read_job(&state, &completed.id).unwrap().identity["benchmarkVersion"],
            "request-aba-v1"
        );
        let legacy_rejection = apply(state.clone(), completed.id.clone(), "candidate-1".into())
            .await
            .err()
            .unwrap();
        assert!(legacy_rejection.contains("旧报告"));
        assert_eq!(fs::read(&profile.config_path).unwrap(), original);
        update(&state, &completed.id, |job| job.scenes = vec![Scene::Chat]).unwrap();
        let before = require_owned(&state, &profile).await.unwrap();
        // Historical recovery still exercises the real restart transaction.
        // Public apply requires a full semantic workload report from now on.
        let applied = change_configuration(
            state.clone(),
            read_job(&state, &completed.id).unwrap(),
            Some(completed.candidates[0].clone()),
        )
        .await
        .unwrap();
        assert_eq!(applied.state, Phase::Applied, "{:?}", applied.error);
        assert_ne!(require_owned(&state, &profile).await.unwrap(), before);
        assert!(
            (baseline_parameters(&read_metrics(&state, &profile).await.unwrap())
                .unwrap()
                .pcie_frac
                - 0.35)
                .abs()
                < 0.000001
        );
        // Upgrading the Code quality gate must never disable recovery of an
        // already applied historic configuration. Verify the real owned
        // fixture restart/load/health path still restores the original bytes.
        update(&state, &completed.id, |job| job.scenes = vec![Scene::Code]).unwrap();
        let restored = restore(state.clone(), completed.id).await.unwrap();
        assert_eq!(restored.state, Phase::Restored, "{:?}", restored.error);
        assert_eq!(fs::read(&profile.config_path).unwrap(), original);
        assert_eq!(fs::read(source).unwrap(), original);
        start(
            state.clone(),
            profile.id.clone(),
            fixture_request(Parameters {
                pcie_frac: 0.2,
                spec_min_p: 0.5,
            }),
        )
        .await
        .unwrap();
        let slow = await_job(&state, &profile).await;
        assert_eq!(slow.state, Phase::Completed);
        assert!(slow.recommended_candidate_id.is_none());
        assert!(!slow.candidates[0].evaluation.as_ref().unwrap().accepted);
        assert!(apply(state.clone(), slow.id, "candidate-1".into())
            .await
            .is_err());
        assert_eq!(fs::read(&profile.config_path).unwrap(), original);
        drop(state); // Job/group cleanup terminates only this fixture.
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn actual_apply_load_failure_rolls_back_and_cancel_removes_admission_gate() {
        let (_temp, state, profile, original) = live_fixture().await;
        start(
            state.clone(),
            profile.id.clone(),
            fixture_request(Parameters {
                pcie_frac: 0.35,
                spec_min_p: 0.5,
            }),
        )
        .await
        .unwrap();
        let completed = await_job(&state, &profile).await;
        assert_eq!(completed.state, Phase::Completed, "{:?}", completed.error);
        fs::write(
            Path::new(&profile.install_dir).join("reject-applied"),
            "fixture fault injection",
        )
        .unwrap();
        let reverted = change_configuration(
            state.clone(),
            completed.clone(),
            Some(completed.candidates[0].clone()),
        )
        .await
        .unwrap();
        assert_eq!(reverted.state, Phase::Restored, "{:?}", reverted.error);
        assert!(reverted
            .error
            .as_ref()
            .unwrap()
            .contains("原配置和服务已恢复"));
        assert_eq!(fs::read(&profile.config_path).unwrap(), original);
        let started = start(
            state.clone(),
            profile.id.clone(),
            fixture_request(Parameters {
                pcie_frac: 0.35,
                spec_min_p: 0.5,
            }),
        )
        .await
        .unwrap();
        let gate = state
            .data_dir()
            .join("analytics")
            .join(format!("{}.maintenance", profile.id));
        for _ in 0..100 {
            if gate.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(gate.exists());
        assert!(assert_available(&state).is_err());
        let external=http::request_builder(&state.client,&profile,"/v1/chat/completions","POST",Some(json!({"messages":[{"role":"user","content":"external fixture request"}],"max_tokens":128}))).unwrap().send().await.unwrap();
        assert_eq!(external.status().as_u16(), 503);
        cancel(&state, started.id).unwrap();
        let canceled = await_job(&state, &profile).await;
        assert_eq!(canceled.state, Phase::Canceled, "{:?}", canceled.error);
        assert!(!gate.exists());
        assert!(assert_available(&state).is_ok());
        assert_eq!(fs::read(&profile.config_path).unwrap(), original);
        assert!(require_owned(&state, &profile).await.is_ok());
        drop(state);
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn actual_service_crash_finishes_task_and_releases_gate_without_waiting_forever() {
        let (_temp, state, profile, original) = live_fixture().await;
        fs::write(
            Path::new(&profile.install_dir).join("crash-request"),
            "fixture owned process crash",
        )
        .unwrap();
        let began = Instant::now();
        start(
            state.clone(),
            profile.id.clone(),
            fixture_request(Parameters {
                pcie_frac: 0.35,
                spec_min_p: 0.5,
            }),
        )
        .await
        .unwrap();
        let failed = await_job(&state, &profile).await;
        assert_eq!(failed.state, Phase::Failed, "{:?}", failed.error);
        assert!(began.elapsed() < Duration::from_secs(3));
        assert!(failed.error.as_ref().unwrap().contains("服务已退出"));
        assert!(!state
            .data_dir()
            .join("analytics")
            .join(format!("{}.maintenance", profile.id))
            .exists());
        assert!(assert_available(&state).is_ok());
        assert_eq!(fs::read(&profile.config_path).unwrap(), original);
        let status =
            crate::service_status(state.clone(), profile.id.clone(), Some(profile.clone()))
                .await
                .unwrap();
        assert!(!status.running); // Neither an unknown PID nor another service was stopped.
    }
}
