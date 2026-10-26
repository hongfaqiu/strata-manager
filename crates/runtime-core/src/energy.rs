//! GPU energy for the usage page (Wh per period, per 1k tokens, an estimate per request).
//!
//! No poller of its own: the engine already samples its card(s) once a second and returns the last 60 readings in
//! `/metrics` `history.gpu_power` (the AMD-on-Windows readings are merged into the same array by `amd_gpu`). Every
//! `/metrics` response that passes through the supervisor anyway (dashboard, floating/taskbar monitor) is
//! stitched into a 1 Hz series here; [`RuntimeState::energy_tick`] only fetches one itself when nobody has asked
//! for half a minute, so the seconds stay covered while the window is closed (one request per 30 s, none while
//! the UI polls). Seconds are summed into one row per minute in `analytics_energy` (written about once a minute).
//!
//! Missing readings are never filled in: every second the engine ran counts as expected, and only seconds with a
//! reading add energy, so a period's coverage is `sampled_s / expected_s`. A Mac has no readable GPU power
//! without root (`powermetrics`); its seconds stay unsampled and the page shows "not supported".
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};

/// The engine keeps 60 one-second readings; one fetch per 30 s leaves a margin for a slow request.
pub const TOP_UP_AFTER_MS: i64 = 30_000;
/// Seconds between observations beyond the history are a sampling gap, unless the gap is so long that the
/// service was evidently not being watched at all (supervisor closed, engine stopped): those are not "expected".
const MAX_GAP_S: i64 = 600;
/// Pending minutes are written at most this often (and before every query).
const FLUSH_EVERY_MS: i64 = 60_000;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Minute {
    pub sampled_s: i64,
    pub expected_s: i64,
    pub energy_j: f64,
    pub max_w: f64,
}
impl Minute {
    fn add(&mut self, other: &Minute) {
        self.sampled_s += other.sampled_s;
        self.expected_s += other.expected_s;
        self.energy_j += other.energy_j;
        self.max_w = self.max_w.max(other.max_w);
    }
}

#[derive(Default)]
struct Track {
    history: Vec<Option<f64>>,
    seen_ms: i64,
    last_second: i64,
    readable: Option<bool>,
    minutes: BTreeMap<i64, Minute>,
}

#[derive(Default)]
pub struct Sampler {
    tracks: HashMap<String, Track>,
    flushed_ms: i64,
}

fn watts(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|w| w.is_finite() && *w >= 0.0 && *w < 100_000.0)
}

/// The engine's power series, newest last; a bare current reading when an older engine sends no history.
fn series(metrics: &Value) -> Option<Vec<Option<f64>>> {
    if let Some(history) = metrics
        .pointer("/history/gpu_power")
        .and_then(Value::as_array)
    {
        if !history.is_empty() {
            return Some(history.iter().map(watts).collect());
        }
    }
    let hardware = metrics.get("hardware")?;
    if let Some(total) = hardware.get("gpu_power").filter(|v| !v.is_null()) {
        return Some(vec![watts(total)]);
    }
    let cards = hardware.get("gpus").and_then(Value::as_array)?;
    let readings: Vec<f64> = cards
        .iter()
        .filter_map(|card| card.get("power").and_then(watts))
        .collect();
    Some(vec![if readings.is_empty() {
        None
    } else {
        Some(readings.iter().sum())
    }])
}

/// How many of `current`'s newest entries were not in `previous`, fetched `elapsed_s` earlier. The window
/// slides one entry per engine second; matching the overlap absorbs request jitter and duplicate polls. Returns
/// (new entries, whether the overlap matched).
pub fn new_entries(
    previous: &[Option<f64>],
    current: &[Option<f64>],
    elapsed_s: i64,
) -> (usize, bool) {
    let expected = elapsed_s.max(0) as usize;
    if previous.is_empty() || current.is_empty() {
        return (expected.min(current.len()), false);
    }
    let mut candidates: Vec<usize> = (expected.saturating_sub(3)..=expected + 3)
        .filter(|s| *s <= current.len())
        .collect();
    candidates.sort_by_key(|s| (s.abs_diff(expected), *s));
    for shift in candidates {
        let overlap = previous.len().min(current.len() - shift);
        if overlap < 8 {
            continue;
        }
        let kept = &current[current.len() - shift - overlap..current.len() - shift];
        if kept == &previous[previous.len() - overlap..] {
            return (shift, true);
        }
    }
    (expected.min(current.len()), false)
}

impl Sampler {
    /// Feed one `/metrics` response for a service, received at `now_ms`.
    pub fn observe(&mut self, service: &str, now_ms: i64, metrics: &Value) {
        let Some(current) = series(metrics) else {
            return;
        };
        let track = self.tracks.entry(service.to_string()).or_default();
        let now_s = now_ms.div_euclid(1000);
        let first = track.seen_ms == 0;
        let elapsed_s = if first {
            1
        } else {
            (now_ms - track.seen_ms + 500).div_euclid(1000)
        };
        let (count, matched) = if first {
            // The previous supervisor already wrote what it saw: start from the newest reading only.
            (1.min(current.len()), true)
        } else if elapsed_s > MAX_GAP_S {
            (1.min(current.len()), true)
        } else {
            new_entries(&track.history, &current, elapsed_s)
        };
        // A matched window continues where the last one ended (no lost or doubled second from request jitter),
        // re-anchored to the clock if it ever drifts by more than a few seconds.
        let anchored = now_s - count as i64;
        let base =
            if matched && !first && (anchored - 3..=anchored + 2).contains(&track.last_second) {
                track.last_second
            } else {
                anchored
            };
        if !matched {
            // Seconds the history no longer reaches: expected, never filled in.
            let missing = (elapsed_s - count as i64).max(0);
            for s in (base - missing + 1).max(track.last_second + 1)..=base {
                track
                    .minutes
                    .entry(s.div_euclid(60) * 60_000)
                    .or_default()
                    .expected_s += 1;
            }
            track.last_second = track.last_second.max(base);
        }
        let mut second = base;
        for reading in &current[current.len() - count..] {
            second += 1;
            if second <= track.last_second {
                continue;
            }
            track.last_second = second;
            let minute = track
                .minutes
                .entry(second.div_euclid(60) * 60_000)
                .or_default();
            minute.expected_s += 1;
            if let Some(w) = reading {
                minute.sampled_s += 1;
                minute.energy_j += w;
                minute.max_w = minute.max_w.max(*w);
            }
        }
        if current.iter().any(Option::is_some) {
            track.readable = Some(true);
        } else if track.readable.is_none() || current.len() >= 10 {
            track.readable = Some(false);
        }
        track.history = current;
        track.seen_ms = now_ms;
    }

    pub fn last_seen_ms(&self, service: &str) -> Option<i64> {
        self.tracks
            .get(service)
            .map(|t| t.seen_ms)
            .filter(|ms| *ms > 0)
    }

    /// Whether the engine reported a power reading (None: not observed since the supervisor started).
    pub fn readable(&self, service: &str) -> Option<bool> {
        if service.is_empty() {
            let states: Vec<bool> = self.tracks.values().filter_map(|t| t.readable).collect();
            return if states.is_empty() {
                None
            } else {
                Some(states.iter().any(|v| *v))
            };
        }
        self.tracks.get(service).and_then(|t| t.readable)
    }

    pub fn due(&self, now_ms: i64) -> bool {
        now_ms - self.flushed_ms >= FLUSH_EVERY_MS
    }

    /// Takes every pending minute (complete or not); rows are additive, so a partial minute is completed later.
    pub fn drain(&mut self, now_ms: i64) -> Vec<(String, i64, Minute)> {
        self.flushed_ms = now_ms;
        self.tracks
            .retain(|_, t| now_ms - t.seen_ms < 3_600_000 || !t.minutes.is_empty());
        let mut rows = Vec::new();
        for (service, track) in &mut self.tracks {
            for (minute, values) in std::mem::take(&mut track.minutes) {
                rows.push((service.clone(), minute, values));
            }
        }
        rows
    }

    /// A failed write keeps its rows for the next flush.
    pub fn restore(&mut self, rows: Vec<(String, i64, Minute)>) {
        for (service, minute, values) in rows {
            self.tracks
                .entry(service)
                .or_default()
                .minutes
                .entry(minute)
                .or_default()
                .add(&values);
        }
    }
}

pub const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS analytics_energy(service_id TEXT NOT NULL,minute_ms INTEGER NOT NULL,sampled_s INTEGER NOT NULL,expected_s INTEGER NOT NULL,energy_j REAL NOT NULL,max_w REAL,PRIMARY KEY(service_id,minute_ms)); CREATE INDEX IF NOT EXISTS analytics_energy_minute ON analytics_energy(minute_ms);";

pub fn write(
    database: &mut Connection,
    rows: &[(String, i64, Minute)],
    cutoff_ms: i64,
) -> rusqlite::Result<()> {
    let tx = database.transaction()?;
    {
        let mut upsert = tx.prepare_cached("INSERT INTO analytics_energy VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(service_id,minute_ms) DO UPDATE SET sampled_s=MIN(60,sampled_s+excluded.sampled_s),expected_s=MIN(60,expected_s+excluded.expected_s),energy_j=energy_j+excluded.energy_j,max_w=MAX(COALESCE(max_w,0),COALESCE(excluded.max_w,0))")?;
        for (service, minute, m) in rows {
            upsert.execute(params![
                service,
                minute,
                m.sampled_s.min(60),
                m.expected_s.min(60),
                m.energy_j,
                if m.sampled_s > 0 { Some(m.max_w) } else { None }
            ])?;
        }
    }
    tx.execute(
        "DELETE FROM analytics_energy WHERE minute_ms<?1",
        [cutoff_ms],
    )?;
    tx.commit()
}

/// Totals for minutes in [start, end): (joules, sampled seconds, expected seconds, peak W).
pub fn totals(
    database: &Connection,
    start: i64,
    end: i64,
    service: &str,
) -> rusqlite::Result<(f64, i64, i64, Option<f64>)> {
    database.query_row(
        "SELECT COALESCE(SUM(energy_j),0),COALESCE(SUM(sampled_s),0),COALESCE(SUM(expected_s),0),MAX(max_w) FROM analytics_energy WHERE minute_ms>=?1 AND minute_ms<?2 AND (?3='' OR service_id=?3)",
        params![start.div_euclid(60_000) * 60_000, end, service],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
}

/// Wh, coverage and Wh per 1k tokens, null wherever there is nothing measured.
pub fn describe(
    joules: f64,
    sampled_s: i64,
    expected_s: i64,
    max_w: Option<f64>,
    tokens: Option<i64>,
) -> Value {
    let wh = (sampled_s > 0).then(|| joules / 3600.0);
    let expected = expected_s.max(sampled_s);
    json!({
        "wh": wh,
        "sampledS": sampled_s,
        "expectedS": expected,
        "coverage": (expected > 0).then(|| sampled_s as f64 / expected as f64),
        "maxW": max_w,
        "averageW": (sampled_s > 0).then(|| joules / sampled_s as f64),
        "whPer1kTokens": match (wh, tokens) { (Some(wh), Some(t)) if t > 0 => Some(wh * 1000.0 / t as f64), _ => None },
    })
}

fn overlap(a: (i64, i64), b: (i64, i64)) -> i64 {
    (a.1.min(b.1) - a.0.max(b.0)).max(0)
}

/// Adds `energyWhEstimate` / `energyCoverage` to request rows. Each request gets the average power of the minutes
/// it ran in, for the time it ran, divided by how many requests ran at once on that service (time-weighted). The
/// minute average includes any idle seconds of that minute, so this is an estimate, and is labelled one.
pub fn attribute(database: &Connection, items: &mut [Value]) -> rusqlite::Result<()> {
    let spans: Vec<Option<(String, i64, i64)>> = items
        .iter()
        .map(|item| {
            let start = item["startedAtMs"].as_i64()?;
            let end = item["endedAtMs"].as_i64().filter(|end| *end > start)?;
            Some((item["serviceId"].as_str()?.to_string(), start, end))
        })
        .collect();
    let mut services: HashMap<&str, (i64, i64)> = HashMap::new();
    for (service, start, end) in spans.iter().flatten() {
        let entry = services.entry(service).or_insert((*start, *end));
        entry.0 = entry.0.min(*start);
        entry.1 = entry.1.max(*end);
    }
    let mut minutes: HashMap<(String, i64), (f64, i64)> = HashMap::new();
    let mut concurrency: HashMap<(String, i64), f64> = HashMap::new();
    for (service, (low, high)) in &services {
        let low = low.div_euclid(60_000) * 60_000;
        let mut statement = database.prepare_cached("SELECT minute_ms,energy_j,sampled_s FROM analytics_energy WHERE service_id=?1 AND minute_ms>=?2 AND minute_ms<?3")?;
        for row in statement.query_map(params![service, low, high], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, f64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })? {
            let (minute, joules, sampled) = row?;
            minutes.insert((service.to_string(), minute), (joules, sampled));
        }
        // All of the service's requests in the window, not just this page, share the card.
        let mut statement = database.prepare_cached("SELECT started_ms,ended_ms FROM analytics_requests WHERE service_id=?1 AND started_ms<?3 AND started_ms>=?2-86400000 AND ended_ms>?2")?;
        let mut intervals: Vec<(i64, i64)> = statement
            .query_map(params![service, low, high], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            })?
            .collect::<rusqlite::Result<_>>()?;
        intervals.retain(|(start, end)| end > start);
        intervals.sort();
        let mut per_minute: BTreeMap<i64, (i64, Vec<(i64, i64)>)> = BTreeMap::new();
        for &(start, end) in &intervals {
            let mut minute = start.max(low).div_euclid(60_000) * 60_000;
            while minute < end.min(*high) {
                let window = (minute, minute + 60_000);
                let part = overlap((start, end), window);
                if part > 0 {
                    let slot = per_minute.entry(minute).or_default();
                    slot.0 += part;
                    slot.1.push((start.max(window.0), end.min(window.1)));
                }
                minute += 60_000;
            }
        }
        for (minute, (sum, parts)) in per_minute {
            // `intervals` was sorted, so the clipped parts are too: merge them for the busy (union) time.
            let mut union = 0;
            let mut current: Option<(i64, i64)> = None;
            for (start, end) in parts {
                match current {
                    Some((s, e)) if start <= e => current = Some((s, e.max(end))),
                    Some((s, e)) => {
                        union += e - s;
                        current = Some((start, end));
                    }
                    None => current = Some((start, end)),
                }
            }
            if let Some((s, e)) = current {
                union += e - s;
            }
            if union > 0 {
                concurrency.insert(
                    (service.to_string(), minute),
                    (sum as f64 / union as f64).max(1.0),
                );
            }
        }
    }
    for (item, span) in items.iter_mut().zip(spans) {
        let Some((service, start, end)) = span else {
            item["energyWhEstimate"] = Value::Null;
            item["energyCoverage"] = Value::Null;
            continue;
        };
        let (mut joules, mut covered, mut total) = (0.0, 0i64, 0i64);
        let mut minute = start.div_euclid(60_000) * 60_000;
        while minute < end {
            let part = overlap((start, end), (minute, minute + 60_000));
            total += part;
            if let Some((energy, sampled)) = minutes
                .get(&(service.clone(), minute))
                .filter(|(_, s)| *s > 0)
            {
                let share = concurrency
                    .get(&(service.clone(), minute))
                    .copied()
                    .unwrap_or(1.0);
                joules += energy / *sampled as f64 * (part as f64 / 1000.0) / share;
                covered += part;
            }
            minute += 60_000;
        }
        item["energyWhEstimate"] = if covered > 0 {
            json!(joules / 3600.0)
        } else {
            Value::Null
        };
        item["energyCoverage"] = if total > 0 {
            json!(covered as f64 / total as f64)
        } else {
            Value::Null
        };
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // A whole minute, in ms, so second offsets map onto predictable minute rows.
    const T0: i64 = 1_700_000_040_000;

    fn watts_at(second: i64) -> Option<f64> {
        Some(100.0 + second as f64)
    }
    /// The engine's 60-entry window ending at engine second `last` (exclusive).
    fn window(last: i64) -> Vec<Option<f64>> {
        (last - 60..last).map(watts_at).collect()
    }
    fn metrics(series: &[Option<f64>]) -> Value {
        json!({"history":{"gpu_power":series},"hardware":{"gpu_power":series.last().copied().flatten()}})
    }
    fn total(rows: &[(String, i64, Minute)]) -> Minute {
        let mut sum = Minute::default();
        for (_, _, minute) in rows {
            sum.add(minute);
        }
        sum
    }

    #[test]
    fn overlap_matching_absorbs_jitter_and_duplicates() {
        let previous = window(60);
        assert_eq!(new_entries(&previous, &window(65), 5), (5, true));
        // The request arrived a second late or early: the overlap still pins the shift.
        assert_eq!(new_entries(&previous, &window(65), 6), (5, true));
        assert_eq!(new_entries(&previous, &window(65), 4), (5, true));
        // Two windows polling the same second.
        assert_eq!(new_entries(&previous, &previous, 0), (0, true));
        // Nothing in common (engine restarted): take what the clock says, flagged unmatched.
        let unrelated: Vec<Option<f64>> = (0..60).map(|_| Some(1.0)).collect();
        assert_eq!(new_entries(&previous, &unrelated, 5), (5, false));
        assert_eq!(new_entries(&previous, &window(200), 140), (60, false));
    }

    #[test]
    fn stitches_seconds_once_and_leaves_gaps_unfilled() {
        let mut sampler = Sampler::default();
        sampler.observe("gpu", T0, &metrics(&window(60)));
        // Polled twice in the same second by the dashboard and the floating monitor.
        sampler.observe("gpu", T0 + 300, &metrics(&window(60)));
        sampler.observe("gpu", T0 + 10_000, &metrics(&window(70)));
        let rows = sampler.drain(T0 + 10_000);
        let sum = total(&rows);
        assert_eq!((sum.sampled_s, sum.expected_s), (11, 11));
        let expected: f64 = (59..70).map(|s| watts_at(s).unwrap()).sum();
        assert!((sum.energy_j - expected).abs() < 1e-9);
        assert_eq!(sum.max_w, 169.0);
        // Nobody asked for 190 s: the window only reaches back 60 s, the other 130 s are a gap.
        sampler.observe("gpu", T0 + 200_000, &metrics(&window(260)));
        let sum = total(&sampler.drain(T0 + 200_000));
        assert_eq!((sum.sampled_s, sum.expected_s), (60, 190));
        // Seconds land in their own minutes, each capped at 60.
        sampler.observe("gpu", T0 + 230_000, &metrics(&window(290)));
        for (_, minute, values) in sampler.drain(T0 + 230_000) {
            assert_eq!(minute % 60_000, 0);
            assert!(values.expected_s <= 60 && values.sampled_s <= values.expected_s);
        }
        assert_eq!(sampler.readable("gpu"), Some(true));
        assert_eq!(sampler.readable(""), Some(true));
    }

    #[test]
    fn long_absence_is_not_counted_as_expected() {
        let mut sampler = Sampler::default();
        sampler.observe("gpu", T0, &metrics(&window(60)));
        sampler.drain(T0);
        sampler.observe("gpu", T0 + 3_600_000, &metrics(&window(3660)));
        let sum = total(&sampler.drain(T0 + 3_600_000));
        assert_eq!((sum.sampled_s, sum.expected_s), (1, 1));
    }

    #[test]
    fn no_power_reading_counts_expected_seconds_only() {
        // Apple GPU: the card is listed but no power is readable without root.
        let mac = json!({"hardware":{"gpu_power":null,"gpus":[{"name":"Apple M3 Max"}]}});
        let mut sampler = Sampler::default();
        sampler.observe("mac", T0, &mac);
        sampler.observe("mac", T0 + 5_000, &mac);
        assert_eq!(sampler.readable("mac"), Some(false));
        let sum = total(&sampler.drain(T0 + 5_000));
        assert_eq!(sum.sampled_s, 0);
        assert!(sum.expected_s > 0);
        let described = describe(
            sum.energy_j,
            sum.sampled_s,
            sum.expected_s,
            None,
            Some(1000),
        );
        assert!(
            described["wh"].is_null()
                && described["whPer1kTokens"].is_null()
                && described["averageW"].is_null()
        );
        assert_eq!(described["coverage"], 0.0);
        assert_eq!(Sampler::default().readable(""), None);
        // No metrics shape at all (older engine, error body): nothing is recorded.
        sampler.observe("other", T0, &json!({"error":"loading"}));
        assert!(sampler.last_seen_ms("other").is_none());
    }

    fn database() -> Connection {
        let database = Connection::open_in_memory().unwrap();
        database.execute_batch(SCHEMA).unwrap();
        database
            .execute_batch("CREATE TABLE analytics_requests(service_id TEXT NOT NULL,started_ms INTEGER NOT NULL,ended_ms INTEGER);")
            .unwrap();
        database
    }

    #[test]
    fn writes_are_additive_capped_and_retained() {
        let mut database = database();
        let half = Minute {
            sampled_s: 40,
            expected_s: 45,
            energy_j: 4000.0,
            max_w: 120.0,
        };
        let rows = vec![
            ("gpu".to_string(), T0, half),
            ("gpu".to_string(), T0 - 120 * 86_400_000, half),
        ];
        write(&mut database, &rows, T0 - 90 * 86_400_000).unwrap();
        let more = Minute {
            sampled_s: 30,
            expected_s: 30,
            energy_j: 2000.0,
            max_w: 150.0,
        };
        write(
            &mut database,
            &[("gpu".to_string(), T0, more)],
            T0 - 90 * 86_400_000,
        )
        .unwrap();
        let (joules, sampled, expected, max_w) =
            totals(&database, T0 - 86_400_000 * 200, T0 + 60_000, "").unwrap();
        assert_eq!(
            (joules, sampled, expected, max_w),
            (6000.0, 60, 60, Some(150.0))
        );
        // A range starting inside the minute still includes it; another service does not.
        assert_eq!(
            totals(&database, T0 + 30_000, T0 + 60_000, "gpu")
                .unwrap()
                .0,
            6000.0
        );
        assert_eq!(totals(&database, T0, T0 + 60_000, "other").unwrap().1, 0);
        let described = describe(joules, sampled, expected, max_w, Some(2000));
        assert!((described["wh"].as_f64().unwrap() - 6000.0 / 3600.0).abs() < 1e-12);
        assert!(
            (described["whPer1kTokens"].as_f64().unwrap() - 6000.0 / 3600.0 / 2.0).abs() < 1e-12
        );
        assert_eq!(described["coverage"], 1.0);
        assert_eq!(described["averageW"], 100.0);
    }

    #[test]
    fn requests_share_their_minutes_power_and_report_coverage() {
        let mut database = database();
        let minute = |n: i64| T0 + n * 60_000;
        let row = |n: i64, joules: f64| {
            (
                "gpu".to_string(),
                minute(n),
                Minute {
                    sampled_s: 60,
                    expected_s: 60,
                    energy_j: joules,
                    max_w: 0.0,
                },
            )
        };
        write(&mut database, &[row(0, 6000.0), row(3, 3000.0)], 0).unwrap();
        let spans = [
            (minute(0), minute(0) + 30_000),
            (minute(0), minute(0) + 30_000),
            (minute(2), minute(2) + 30_000),
            (minute(3) + 30_000, minute(4) + 30_000),
        ];
        for (start, end) in spans {
            database
                .execute(
                    "INSERT INTO analytics_requests VALUES('gpu',?1,?2)",
                    params![start, end],
                )
                .unwrap();
        }
        let mut items: Vec<Value> = spans
            .iter()
            .map(|(start, end)| json!({"serviceId":"gpu","startedAtMs":start,"endedAtMs":end}))
            .collect();
        items.push(json!({"serviceId":"gpu","startedAtMs":minute(0),"endedAtMs":null}));
        attribute(&database, &mut items).unwrap();
        let wh = |i: usize| items[i]["energyWhEstimate"].as_f64();
        // 100 W for 30 s, two requests at once.
        assert!((wh(0).unwrap() - 1500.0 / 3600.0).abs() < 1e-9);
        assert_eq!(wh(0), wh(1));
        assert_eq!(items[0]["energyCoverage"], 1.0);
        // A minute without readings is not guessed.
        assert_eq!(wh(2), None);
        assert_eq!(items[2]["energyCoverage"], 0.0);
        // Half in a measured 50 W minute, half in an unmeasured one.
        assert!((wh(3).unwrap() - 1500.0 / 3600.0).abs() < 1e-9);
        assert_eq!(items[3]["energyCoverage"], 0.5);
        // Still running.
        assert!(items[4]["energyWhEstimate"].is_null() && items[4]["energyCoverage"].is_null());
    }
}
