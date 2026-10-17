//! In-memory live progress for running tuning and calibration jobs.
//!
//! Nothing here is persisted: reports keep their own durable state at step
//! boundaries. This registry only exists so the UI can show what is being
//! measured right now (current step, parameters, streamed token rate, ETA and
//! a short metadata log). It never stores prompt or response text.
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Mutex, OnceLock},
    time::Instant,
};

use crate::types::now;

pub const MAX_LOG_LINES: usize = 200;

tokio::task_local! {
    /// The job whose request is streaming on this task. Set with `scope`.
    static LIVE_JOB: String;
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveRequest {
    pub started_at: u64,
    /// Streamed content/reasoning deltas. One delta is usually one token; MTP
    /// may batch several, so the live rate is an estimate until the request ends.
    pub deltas: u64,
    pub first_token_ms: Option<f64>,
    pub tok_s: Option<f64>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveLogLine {
    pub at: u64,
    /// Stable message key; the UI translates it.
    pub key: String,
    /// Metadata only (parameter values, rates). Never prompt or answer text.
    pub detail: Value,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveSnapshot {
    pub job_id: String,
    pub step_key: String,
    pub step_index: usize,
    pub step_total: usize,
    pub parameters: Value,
    pub round: Option<usize>,
    pub rounds: Option<usize>,
    pub completed_units: usize,
    pub total_units: usize,
    pub running_since: u64,
    pub eta_ms: Option<u64>,
    pub request: Option<LiveRequest>,
    pub last_tok_s: Option<f64>,
    pub log: Vec<LiveLogLine>,
    pub updated_at: u64,
}

struct Entry {
    snapshot: LiveSnapshot,
    request_started: Option<Instant>,
    first_delta: Option<Instant>,
    unit_started: Instant,
    unit_ms: Vec<f64>,
    log: VecDeque<LiveLogLine>,
}

fn registry() -> &'static Mutex<HashMap<String, Entry>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn with<R>(job_id: &str, f: impl FnOnce(&mut Entry) -> R) -> Option<R> {
    let mut registry = registry().lock().ok()?;
    let entry = registry.get_mut(job_id)?;
    let result = f(entry);
    entry.snapshot.updated_at = now();
    Some(result)
}

/// Median completed unit duration times the remaining units. `None` until at
/// least one unit finished, so the UI never shows a made-up estimate.
pub fn estimate_eta(unit_ms: &[f64], completed: usize, total: usize) -> Option<u64> {
    if unit_ms.is_empty() || completed >= total {
        return if completed >= total && total > 0 {
            Some(0)
        } else {
            None
        };
    }
    let mut sorted: Vec<f64> = unit_ms
        .iter()
        .copied()
        .filter(|v| v.is_finite() && *v >= 0.0)
        .collect();
    if sorted.is_empty() {
        return None;
    }
    sorted.sort_by(f64::total_cmp);
    let middle = sorted.len() / 2;
    let median = if sorted.len() % 2 == 0 {
        (sorted[middle - 1] + sorted[middle]) / 2.0
    } else {
        sorted[middle]
    };
    Some((median * (total - completed) as f64).round() as u64)
}

pub fn begin(job_id: &str, total_units: usize) {
    if let Ok(mut registry) = registry().lock() {
        registry.insert(
            job_id.to_owned(),
            Entry {
                snapshot: LiveSnapshot {
                    job_id: job_id.to_owned(),
                    step_key: "waitingForIdle".into(),
                    step_index: 0,
                    step_total: 0,
                    parameters: Value::Null,
                    round: None,
                    rounds: None,
                    completed_units: 0,
                    total_units,
                    running_since: now(),
                    eta_ms: None,
                    request: None,
                    last_tok_s: None,
                    log: vec![],
                    updated_at: now(),
                },
                request_started: None,
                first_delta: None,
                unit_started: Instant::now(),
                unit_ms: vec![],
                log: VecDeque::new(),
            },
        );
    }
}

pub fn set_total(job_id: &str, total_units: usize) {
    with(job_id, |entry| {
        entry.snapshot.total_units = total_units.max(entry.snapshot.completed_units);
        entry.snapshot.eta_ms = estimate_eta(
            &entry.unit_ms,
            entry.snapshot.completed_units,
            entry.snapshot.total_units,
        );
    });
}

/// Moves to a named step. `parameters` are the values under test right now.
pub fn step(
    job_id: &str,
    key: &str,
    index: usize,
    total: usize,
    parameters: Value,
    round: Option<(usize, usize)>,
) {
    with(job_id, |entry| {
        let s = &mut entry.snapshot;
        s.step_key = key.to_owned();
        s.step_index = index;
        s.step_total = total;
        s.parameters = parameters;
        s.round = round.map(|r| r.0);
        s.rounds = round.map(|r| r.1);
    });
}

pub fn log(job_id: &str, key: &str, detail: Value) {
    with(job_id, |entry| {
        entry.log.push_back(LiveLogLine {
            at: now(),
            key: key.to_owned(),
            detail,
        });
        while entry.log.len() > MAX_LOG_LINES {
            entry.log.pop_front();
        }
    });
}

/// Starts a measured unit (one request or one workload).
pub fn unit_started(job_id: &str) {
    with(job_id, |entry| {
        entry.unit_started = Instant::now();
        entry.request_started = Some(Instant::now());
        entry.first_delta = None;
        entry.snapshot.request = Some(LiveRequest {
            started_at: now(),
            ..LiveRequest::default()
        });
    });
}

/// Finishes a unit. `tok_s` is the engine's own figure when it reported one.
pub fn unit_finished(job_id: &str, tok_s: Option<f64>) {
    with(job_id, |entry| {
        let elapsed = entry.unit_started.elapsed().as_secs_f64() * 1000.0;
        entry.unit_ms.push(elapsed);
        let s = &mut entry.snapshot;
        s.completed_units = (s.completed_units + 1).min(s.total_units.max(s.completed_units + 1));
        if let Some(rate) = tok_s.filter(|v| v.is_finite() && *v > 0.0) {
            s.last_tok_s = Some(rate);
        }
        s.eta_ms = estimate_eta(&entry.unit_ms, s.completed_units, s.total_units);
        if let Some(request) = &mut s.request {
            if tok_s.is_some() {
                request.tok_s = tok_s;
            }
        }
        entry.request_started = None;
    });
}

fn record_delta(entry: &mut Entry) {
    let now_instant = Instant::now();
    let started = entry.request_started.get_or_insert(now_instant).to_owned();
    let first = *entry.first_delta.get_or_insert(now_instant);
    let request = entry
        .snapshot
        .request
        .get_or_insert_with(LiveRequest::default);
    request.deltas += 1;
    if request.first_token_ms.is_none() {
        request.first_token_ms = Some(first.duration_since(started).as_secs_f64() * 1000.0);
    }
    let decoding = now_instant.duration_since(first).as_secs_f64();
    if request.deltas > 1 && decoding > 0.05 {
        request.tok_s = Some((request.deltas - 1) as f64 / decoding);
    }
}

/// Called by the SSE readers for each streamed content/reasoning delta.
/// Outside a `scope` it does nothing.
pub fn on_delta() {
    let _ = LIVE_JOB.try_with(|job_id| {
        with(job_id, record_delta);
    });
}

pub async fn scope<F: std::future::Future>(job_id: String, future: F) -> F::Output {
    LIVE_JOB.scope(job_id, future).await
}

pub fn snapshot(job_id: &str) -> Option<LiveSnapshot> {
    let registry = registry().lock().ok()?;
    let entry = registry.get(job_id)?;
    let mut snapshot = entry.snapshot.clone();
    snapshot.log = entry.log.iter().cloned().collect();
    Some(snapshot)
}

pub fn end(job_id: &str) {
    if let Ok(mut registry) = registry().lock() {
        registry.remove(job_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn eta_uses_median_of_finished_units_and_never_guesses() {
        assert_eq!(estimate_eta(&[], 0, 10), None);
        assert_eq!(estimate_eta(&[1000.0, 3000.0, 2000.0], 3, 10), Some(14000));
        assert_eq!(estimate_eta(&[1000.0, 50_000.0], 2, 4), Some(51_000));
        assert_eq!(estimate_eta(&[1000.0], 4, 4), Some(0));
    }

    #[tokio::test]
    async fn streamed_deltas_update_the_live_rate_only_inside_a_scope() {
        let id = "live-test-job";
        begin(id, 4);
        step(id, "pcieFrac", 2, 5, json!({"pcieFrac":0.35}), Some((1, 3)));
        on_delta();
        assert!(
            snapshot(id).unwrap().request.is_none(),
            "outside a scope nothing is recorded"
        );
        unit_started(id);
        scope(id.to_owned(), async {
            for _ in 0..5 {
                on_delta();
                tokio::time::sleep(std::time::Duration::from_millis(15)).await;
            }
        })
        .await;
        let live = snapshot(id).unwrap();
        let request = live.request.unwrap();
        assert_eq!(request.deltas, 5);
        assert!(request.first_token_ms.is_some());
        assert!(request.tok_s.unwrap() > 0.0);
        assert_eq!(live.step_key, "pcieFrac");
        assert_eq!(live.round, Some(1));
        unit_finished(id, Some(61.5));
        let live = snapshot(id).unwrap();
        assert_eq!(live.completed_units, 1);
        assert_eq!(live.last_tok_s, Some(61.5));
        assert!(live.eta_ms.is_some());
        end(id);
        assert!(snapshot(id).is_none());
    }

    #[test]
    fn the_log_is_bounded() {
        let id = "live-log-job";
        begin(id, 1);
        for index in 0..(MAX_LOG_LINES + 25) {
            log(id, "sample", json!({"index": index}));
        }
        let live = snapshot(id).unwrap();
        assert_eq!(live.log.len(), MAX_LOG_LINES);
        assert_eq!(live.log[0].detail["index"], 25);
        end(id);
    }
}
