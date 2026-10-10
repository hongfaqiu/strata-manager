//! Durable HTTP usage statistics. HTTP requests, inference runs and MCP calls are
//! different measures. Unknown tokens/timings stay null; no payloads are stored.
use crate::RuntimeState;
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path, time::Duration};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS analytics_cursors(source_id TEXT PRIMARY KEY,seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS analytics_sessions(
 session_id TEXT PRIMARY KEY,service_id TEXT NOT NULL,started_ms INTEGER NOT NULL,
 ended_ms INTEGER,supported INTEGER NOT NULL,source_hash TEXT);
CREATE TABLE IF NOT EXISTS analytics_requests(
 request_id TEXT PRIMARY KEY,service_id TEXT NOT NULL,session_id TEXT NOT NULL,
 started_ms INTEGER NOT NULL,ended_ms INTEGER,route TEXT NOT NULL,client_id TEXT,
 outcome TEXT NOT NULL DEFAULT 'pending',http_status INTEGER,stream INTEGER,
 input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_creation_tokens INTEGER,
 first_token_s REAL,duration_s REAL,error_kind TEXT,mcp_tool_calls INTEGER NOT NULL DEFAULT 0,
 mcp_tool_failures INTEGER NOT NULL DEFAULT 0,counted_tokens INTEGER,model_id TEXT);
CREATE INDEX IF NOT EXISTS analytics_requests_range ON analytics_requests(started_ms,service_id);
CREATE TABLE IF NOT EXISTS analytics_request_order(
 id INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS analytics_runs(
 run_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,service_id TEXT NOT NULL,session_id TEXT NOT NULL,
 started_ms INTEGER NOT NULL,prompt_total INTEGER NOT NULL,input_tokens INTEGER,output_tokens INTEGER,
 cache_read_tokens INTEGER,first_token_s REAL,duration_s REAL,decode_tok_s REAL,
 finish TEXT NOT NULL,tool_calls INTEGER NOT NULL,prefill_tokens INTEGER,prefill_s REAL,
 prefill_tok_s REAL,decode_s REAL,expert_cache_hits INTEGER,expert_cache_lookups INTEGER);
CREATE INDEX IF NOT EXISTS analytics_runs_request ON analytics_runs(request_id);
CREATE TABLE IF NOT EXISTS analytics_gaps(
 source_id TEXT NOT NULL,first_seq INTEGER NOT NULL,last_seq INTEGER NOT NULL,
 observed_ms INTEGER NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(source_id,first_seq,last_seq,reason));
"#;

/// Nullable model identity is additive: historical rows are never guessed from
/// the installation's current configuration. The monotonic admission id cannot
/// be reused after retention, unlike an ordinary SQLite rowid.
fn ensure_schema(database: &Connection) -> Result<(), String> {
    let had_order = sql(database.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='analytics_request_order' AND type='table')",
        [], |row| row.get::<_, bool>(0),
    ))?;
    sql(database.execute_batch(SCHEMA))?;
    let mut columns = sql(database.prepare("PRAGMA table_info(analytics_requests)"))?;
    let names = sql(columns.query_map([], |row| row.get::<_, String>(1)))?;
    let has_model = sql(names.collect::<rusqlite::Result<Vec<_>>>())?
        .iter()
        .any(|name| name == "model_id");
    drop(columns);
    if !has_model {
        sql(database.execute_batch("ALTER TABLE analytics_requests ADD COLUMN model_id TEXT;"))?;
    }
    let mut statement = sql(database.prepare("PRAGMA table_info(analytics_runs)"))?;
    let run_columns = sql(statement.query_map([], |row| row.get::<_, String>(1)))?;
    let run_names = sql(run_columns.collect::<rusqlite::Result<Vec<_>>>())?;
    drop(statement);
    for (name, kind) in [
        ("prefill_tokens", "INTEGER"),
        ("prefill_s", "REAL"),
        ("prefill_tok_s", "REAL"),
        ("decode_s", "REAL"),
        ("expert_cache_hits", "INTEGER"),
        ("expert_cache_lookups", "INTEGER"),
    ] {
        if !run_names.iter().any(|column| column == name) {
            sql(database.execute_batch(&format!(
                "ALTER TABLE analytics_runs ADD COLUMN {name} {kind};"
            )))?;
        }
    }
    sql(database.execute_batch("CREATE INDEX IF NOT EXISTS analytics_requests_order ON analytics_requests(started_ms,request_id); CREATE INDEX IF NOT EXISTS analytics_requests_model ON analytics_requests(model_id,started_ms,request_id); CREATE INDEX IF NOT EXISTS analytics_requests_client ON analytics_requests(client_id,started_ms,request_id); CREATE INDEX IF NOT EXISTS analytics_requests_outcome ON analytics_requests(outcome,started_ms,request_id);"))?;
    let order_empty = !sql(database.query_row(
        "SELECT EXISTS(SELECT 1 FROM analytics_request_order LIMIT 1)",
        [],
        |row| row.get::<_, bool>(0),
    ))?;
    if !had_order || order_empty {
        sql(database.execute("INSERT OR IGNORE INTO analytics_request_order(request_id) SELECT request_id FROM analytics_requests ORDER BY started_ms,request_id", []))?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionStart {
    session_id: String,
    service_id: String,
    started_at_ms: i64,
    supported: bool,
    source_hash: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionEnd {
    session_id: String,
    ended_at_ms: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Start {
    request_id: String,
    session_id: String,
    service_id: String,
    started_at_ms: i64,
    route: String,
    client_id: Option<String>,
    #[serde(default)]
    model_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct End {
    request_id: String,
    ended_at_ms: i64,
    outcome: String,
    http_status: Option<i64>,
    stream: bool,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    cache_read_tokens: Option<i64>,
    cache_creation_tokens: Option<i64>,
    first_token_s: Option<f64>,
    duration_s: Option<f64>,
    error_kind: Option<String>,
    #[serde(default)]
    mcp_tool_calls: i64,
    #[serde(default)]
    mcp_tool_failures: i64,
    #[serde(default)]
    counted_tokens: Option<i64>,
    #[serde(default)]
    model_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Run {
    run_id: String,
    request_id: String,
    service_id: String,
    session_id: String,
    started_at_ms: i64,
    prompt_total: i64,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    cache_read_tokens: Option<i64>,
    first_token_s: Option<f64>,
    duration_s: Option<f64>,
    decode_tok_s: Option<f64>,
    #[serde(default)]
    prefill_tokens: Option<i64>,
    #[serde(default)]
    prefill_s: Option<f64>,
    #[serde(default)]
    prefill_tok_s: Option<f64>,
    #[serde(default)]
    decode_s: Option<f64>,
    #[serde(default)]
    expert_cache_hits: Option<i64>,
    #[serde(default)]
    expert_cache_lookups: Option<i64>,
    finish: String,
    tool_calls: i64,
}

fn positive_i(value: Option<i64>) -> Option<i64> {
    value.filter(|v| *v >= 0)
}
fn positive_f(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite() && *v >= 0.0)
}
fn identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || v == b'_' || v == b'-')
}
fn client(value: Option<String>) -> Option<String> {
    value.filter(|s| {
        !s.is_empty()
            && s.len() <= 64
            && s.bytes()
                .all(|v| v.is_ascii_alphanumeric() || b"_.:/-".contains(&v))
    })
}
fn model(value: Option<String>) -> Option<String> {
    value.filter(|value| {
        !value.is_empty()
            && value.len() <= 160
            && value.as_bytes()[0].is_ascii_alphanumeric()
            && !(value.as_bytes().get(1) == Some(&b':')
                && value
                    .as_bytes()
                    .get(2)
                    .is_some_and(|byte| b"/\\".contains(byte)))
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.:+/-".contains(&byte))
    })
}
fn known(value: &str, allowed: &[&str]) -> bool {
    allowed.contains(&value)
}
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
fn sql<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}
fn parse<T: for<'a> Deserialize<'a>>(payload: &str) -> Result<T, String> {
    serde_json::from_str(payload).map_err(|_| "analytics event has invalid metadata schema".into())
}

fn apply(tx: &Transaction<'_>, kind: &str, payload: &str) -> Result<(), String> {
    match kind {
        "session_start" => {
            let s: SessionStart = parse(payload)?;
            if !identity(&s.session_id) || !identity(&s.service_id) {
                return Err("invalid analytics identity".into());
            }
            // A newly booted observer for the same owned installation makes unfinished
            // requests from the previous process explicitly interrupted, not successful.
            sql(tx.execute("UPDATE analytics_requests SET outcome='interrupted' WHERE service_id=?1 AND session_id!=?2 AND outcome='pending'",params![s.service_id,s.session_id]))?;
            sql(tx.execute("UPDATE analytics_runs SET finish='interrupted' WHERE service_id=?1 AND session_id!=?2 AND finish='pending'",params![s.service_id,s.session_id]))?;
            let hash = s
                .source_hash
                .filter(|s| s.len() == 64 && s.bytes().all(|v| v.is_ascii_hexdigit()));
            sql(tx.execute("INSERT OR IGNORE INTO analytics_sessions(session_id,service_id,started_ms,supported,source_hash) VALUES(?1,?2,?3,?4,?5)", params![s.session_id,s.service_id,s.started_at_ms,s.supported,hash]))?;
        }
        "session_end" => {
            let s: SessionEnd = parse(payload)?;
            sql(tx.execute(
                "UPDATE analytics_sessions SET ended_ms=?2 WHERE session_id=?1",
                params![s.session_id, s.ended_at_ms],
            ))?;
        }
        "request_start" => {
            let s: Start = parse(payload)?;
            if !identity(&s.request_id)
                || !identity(&s.session_id)
                || !identity(&s.service_id)
                || !known(&s.route, &["chat", "responses", "anthropic", "token_count"])
            {
                return Err("invalid analytics request metadata".into());
            }
            sql(tx.execute("INSERT OR IGNORE INTO analytics_requests(request_id,service_id,session_id,started_ms,route,client_id,model_id) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![s.request_id,s.service_id,s.session_id,s.started_at_ms,s.route,client(s.client_id),model(s.model_id)]))?;
            sql(tx.execute(
                "INSERT OR IGNORE INTO analytics_request_order(request_id) VALUES(?1)",
                [&s.request_id],
            ))?;
        }
        "request_end" => {
            let s: End = parse(payload)?;
            if !known(&s.outcome, &["succeeded", "failed", "cancelled"]) {
                return Err("invalid analytics outcome".into());
            }
            let error = s.error_kind.filter(|s| {
                known(
                    s,
                    &[
                        "invalid_request_error",
                        "server_error",
                        "model_busy",
                        "api_error",
                        "structured_output_failed",
                        "authentication_error",
                        "not_found",
                    ],
                )
            });
            sql(tx.execute("UPDATE analytics_requests SET ended_ms=?2,outcome=?3,http_status=?4,stream=?5,input_tokens=?6,output_tokens=?7,cache_read_tokens=?8,cache_creation_tokens=?9,first_token_s=?10,duration_s=?11,error_kind=?12,mcp_tool_calls=?13,mcp_tool_failures=?14,counted_tokens=?15,model_id=COALESCE(?16,model_id) WHERE request_id=?1",params![s.request_id,s.ended_at_ms,s.outcome,s.http_status.filter(|v| (100..=599).contains(v)),s.stream,positive_i(s.input_tokens),positive_i(s.output_tokens),positive_i(s.cache_read_tokens),positive_i(s.cache_creation_tokens),positive_f(s.first_token_s),positive_f(s.duration_s),error,s.mcp_tool_calls.max(0),s.mcp_tool_failures.max(0),positive_i(s.counted_tokens),model(s.model_id)]))?;
        }
        "run_start" | "run_end" => {
            let s: Run = parse(payload)?;
            if !identity(&s.run_id)
                || !identity(&s.request_id)
                || !identity(&s.service_id)
                || !identity(&s.session_id)
                || !known(
                    &s.finish,
                    &[
                        "stop",
                        "length",
                        "cancel",
                        "disconnect",
                        "error",
                        "interrupted",
                        "pending",
                    ],
                )
            {
                return Err("invalid analytics run metadata".into());
            }
            sql(tx.execute("INSERT INTO analytics_runs(run_id,request_id,service_id,session_id,started_ms,prompt_total,input_tokens,output_tokens,cache_read_tokens,first_token_s,duration_s,decode_tok_s,finish,tool_calls,prefill_tokens,prefill_s,prefill_tok_s,decode_s,expert_cache_hits,expert_cache_lookups) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20) ON CONFLICT(run_id) DO UPDATE SET input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cache_read_tokens=excluded.cache_read_tokens,first_token_s=excluded.first_token_s,duration_s=excluded.duration_s,decode_tok_s=excluded.decode_tok_s,finish=excluded.finish,tool_calls=excluded.tool_calls,prefill_tokens=excluded.prefill_tokens,prefill_s=excluded.prefill_s,prefill_tok_s=excluded.prefill_tok_s,decode_s=excluded.decode_s,expert_cache_hits=excluded.expert_cache_hits,expert_cache_lookups=excluded.expert_cache_lookups",params![s.run_id,s.request_id,s.service_id,s.session_id,s.started_at_ms,s.prompt_total.max(0),positive_i(s.input_tokens),positive_i(s.output_tokens),positive_i(s.cache_read_tokens),positive_f(s.first_token_s),positive_f(s.duration_s),positive_f(s.decode_tok_s),s.finish,s.tool_calls.max(0),positive_i(s.prefill_tokens),positive_f(s.prefill_s),positive_f(s.prefill_tok_s),positive_f(s.decode_s),positive_i(s.expert_cache_hits),positive_i(s.expert_cache_lookups)]))?;
        }
        _ => return Err("unknown analytics event kind".into()),
    }
    Ok(())
}

/// Replay at most 2000 metadata events atomically. ACK follows destination commit;
/// a crash between commit and ACK replays harmlessly using the durable cursor.
pub fn consume(database: &mut Connection, journal_path: &Path) -> Result<usize, String> {
    ensure_schema(database)?;
    if !journal_path.is_file() {
        return Ok(0);
    }
    let journal = sql(Connection::open_with_flags(
        journal_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE,
    ))?;
    sql(journal.busy_timeout(Duration::from_secs(5)))?;
    let schema: String = sql(journal.query_row(
        "SELECT value FROM meta WHERE key='schema_version'",
        [],
        |r| r.get(0),
    ))?;
    if schema != "1" {
        return Err("unsupported analytics journal version".into());
    }
    let source: String = sql(journal.query_row(
        "SELECT value FROM meta WHERE key='source_id'",
        [],
        |r| r.get(0),
    ))?;
    if !identity(&source) {
        return Err("invalid analytics journal identity".into());
    }
    let cursor: i64 = sql(database
        .query_row(
            "SELECT seq FROM analytics_cursors WHERE source_id=?1",
            [&source],
            |r| r.get(0),
        )
        .optional())?
    .unwrap_or(0);
    let events = {
        let mut stmt = sql(journal
            .prepare("SELECT seq,kind,payload FROM events WHERE seq>?1 ORDER BY seq LIMIT 2000"))?;
        let rows = sql(stmt.query_map([cursor], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        }))?;
        sql(rows.collect::<rusqlite::Result<Vec<_>>>())?
    };
    let dropped: i64 = sql(journal.query_row(
        "SELECT CAST(value AS INTEGER) FROM meta WHERE key='dropped_through'",
        [],
        |r| r.get(0),
    ))?;
    let tx = sql(database.transaction())?;
    let mut last = cursor;
    if dropped > cursor {
        sql(tx.execute(
            "INSERT OR IGNORE INTO analytics_gaps VALUES(?1,?2,?3,?4,'journal_retention')",
            params![source, cursor + 1, dropped, now_ms()],
        ))?;
        last = dropped;
    }
    for (seq, kind, payload) in &events {
        if *seq <= last {
            continue;
        }
        if *seq > last + 1 {
            sql(tx.execute(
                "INSERT OR IGNORE INTO analytics_gaps VALUES(?1,?2,?3,?4,'missing_sequence')",
                params![source, last + 1, seq - 1, now_ms()],
            ))?;
        }
        if apply(&tx, kind, payload).is_err() {
            // Advance past a malformed/future event and expose the gap instead of
            // wedging all subsequent collection or retaining its untrusted contents.
            sql(tx.execute(
                "INSERT OR IGNORE INTO analytics_gaps VALUES(?1,?2,?2,?3,'invalid_metadata')",
                params![source, seq, now_ms()],
            ))?;
        }
        last = *seq;
    }
    sql(tx.execute("INSERT INTO analytics_cursors VALUES(?1,?2) ON CONFLICT(source_id) DO UPDATE SET seq=excluded.seq",params![source,last]))?;
    // Raw per-request metadata has a bounded 90-day retention; gaps/sessions are
    // retained for the same interval. Older aggregates aren't fabricated.
    let cutoff = now_ms() - 90 * 86_400_000;
    sql(tx.execute("DELETE FROM analytics_runs WHERE started_ms<?1", [cutoff]))?;
    sql(tx.execute("DELETE FROM analytics_request_order WHERE request_id IN (SELECT request_id FROM analytics_requests WHERE started_ms<?1)", [cutoff]))?;
    sql(tx.execute(
        "DELETE FROM analytics_requests WHERE started_ms<?1",
        [cutoff],
    ))?;
    sql(tx.execute(
        "DELETE FROM analytics_sessions WHERE started_ms<?1",
        [cutoff],
    ))?;
    sql(tx.execute("DELETE FROM analytics_gaps WHERE observed_ms<?1", [cutoff]))?;
    sql(tx.commit())?;
    sql(journal.execute(
        "UPDATE meta SET value=CAST(MAX(CAST(value AS INTEGER),?1) AS TEXT) WHERE key='ack'",
        [last],
    ))?;
    Ok(events.len())
}

pub fn poll(state: &RuntimeState) -> Result<(), String> {
    let mut database = state.database.lock().map_err(|e| e.to_string())?;
    consume(
        &mut database,
        &state.data_dir.join("analytics/journal.sqlite3"),
    )?;
    Ok(())
}

#[derive(Clone)]
struct Range {
    start: i64,
    end: i64,
    service: String,
}
impl Range {
    fn from(value: &Value) -> Result<Self, String> {
        let end = value
            .get("endMs")
            .and_then(Value::as_i64)
            .unwrap_or_else(now_ms);
        let start = value
            .get("startMs")
            .and_then(Value::as_i64)
            .unwrap_or(end - 86_400_000);
        if start < 0 || end <= start || end - start > 90 * 86_400_000 {
            return Err("analytics range must be between 1 ms and 90 days".into());
        }
        let service = value
            .get("serviceId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if !service.is_empty() && !identity(&service) {
            return Err("invalid analytics installation id".into());
        }
        Ok(Self {
            start,
            end,
            service,
        })
    }
}

/// Type 7 linear interpolation, with null for no observations.
fn percentile(mut samples: Vec<f64>, q: f64) -> Option<f64> {
    samples.retain(|v| v.is_finite() && *v >= 0.0);
    if samples.is_empty() {
        return None;
    }
    samples.sort_by(f64::total_cmp);
    let index = (samples.len() - 1) as f64 * q;
    let low = index.floor() as usize;
    let high = index.ceil() as usize;
    Some(samples[low] + (samples[high] - samples[low]) * (index - low as f64))
}

fn distribution(
    database: &Connection,
    column: &str,
    range: &Range,
    runs: bool,
) -> Result<Value, String> {
    // Column names come exclusively from fixed call sites, never RPC parameters.
    let query = if runs {
        format!("SELECT x.{column} FROM analytics_runs x JOIN analytics_requests r ON x.request_id=r.request_id WHERE r.started_ms>=?1 AND r.started_ms<?2 AND (?3='' OR r.service_id=?3) AND x.{column} IS NOT NULL")
    } else {
        format!("SELECT {column} FROM analytics_requests WHERE started_ms>=?1 AND started_ms<?2 AND (?3='' OR service_id=?3) AND {column} IS NOT NULL")
    };
    let mut statement = sql(database.prepare(&query))?;
    let rows = sql(
        statement.query_map(params![range.start, range.end, range.service], |r| {
            r.get::<_, f64>(0)
        }),
    )?;
    let values = sql(rows.collect::<rusqlite::Result<Vec<_>>>())?;
    Ok(
        json!({"samples":values.len(),"p50":percentile(values.clone(),0.5),"p95":percentile(values,0.95)}),
    )
}

fn summary(database: &Connection, range: &Range) -> Result<Value, String> {
    let mut totals=sql(database.query_row("SELECT COUNT(*),SUM(outcome='succeeded'),SUM(outcome='failed'),SUM(outcome='cancelled'),SUM(outcome='interrupted'),SUM(outcome='pending'),SUM(input_tokens),SUM(output_tokens),SUM(cache_read_tokens),SUM(cache_creation_tokens),COUNT(input_tokens),COUNT(output_tokens),SUM(mcp_tool_calls),SUM(mcp_tool_failures),MIN(started_ms),MAX(ended_ms) FROM analytics_requests WHERE started_ms>=?1 AND started_ms<?2 AND (?3='' OR service_id=?3)",params![range.start,range.end,range.service],|r|Ok(json!({"requests":r.get::<_,i64>(0)?,"succeeded":r.get::<_,Option<i64>>(1)?.unwrap_or(0),"failed":r.get::<_,Option<i64>>(2)?.unwrap_or(0),"cancelled":r.get::<_,Option<i64>>(3)?.unwrap_or(0),"interrupted":r.get::<_,Option<i64>>(4)?.unwrap_or(0),"pending":r.get::<_,Option<i64>>(5)?.unwrap_or(0),"inputTokens":r.get::<_,Option<i64>>(6)?,"outputTokens":r.get::<_,Option<i64>>(7)?,"cacheReadTokens":r.get::<_,Option<i64>>(8)?,"cacheCreationTokens":r.get::<_,Option<i64>>(9)?,"inputTokenSamples":r.get::<_,i64>(10)?,"outputTokenSamples":r.get::<_,i64>(11)?,"mcpToolCalls":r.get::<_,Option<i64>>(12)?.unwrap_or(0),"mcpToolFailures":r.get::<_,Option<i64>>(13)?.unwrap_or(0),"firstRequestAtMs":r.get::<_,Option<i64>>(14)?,"lastFinishedAtMs":r.get::<_,Option<i64>>(15)?}))))?;
    let finished =
        totals["requests"].as_i64().unwrap_or(0) - totals["pending"].as_i64().unwrap_or(0);
    totals["successRate"] = if finished > 0 {
        json!(totals["succeeded"].as_i64().unwrap_or(0) as f64 / finished as f64)
    } else {
        Value::Null
    };
    let mut run_totals=sql(database.query_row("SELECT COUNT(*),SUM(x.input_tokens),SUM(x.output_tokens),SUM(x.cache_read_tokens),SUM(x.tool_calls),COUNT(x.input_tokens),COUNT(x.decode_tok_s),COUNT(x.prefill_tok_s),SUM(x.prefill_tokens),SUM(x.prefill_s),SUM(x.decode_s) FROM analytics_runs x JOIN analytics_requests r ON x.request_id=r.request_id WHERE r.started_ms>=?1 AND r.started_ms<?2 AND (?3='' OR r.service_id=?3)",params![range.start,range.end,range.service],|r|Ok(json!({"runs":r.get::<_,i64>(0)?,"inputTokens":r.get::<_,Option<i64>>(1)?,"outputTokens":r.get::<_,Option<i64>>(2)?,"cacheReadTokens":r.get::<_,Option<i64>>(3)?,"toolCalls":r.get::<_,Option<i64>>(4)?.unwrap_or(0),"inputTokenSamples":r.get::<_,i64>(5)?,"decodeSpeedSamples":r.get::<_,i64>(6)?,"prefillSpeedSamples":r.get::<_,i64>(7)?,"prefillTokens":r.get::<_,Option<i64>>(8)?,"prefillS":r.get::<_,Option<f64>>(9)?,"decodeS":r.get::<_,Option<f64>>(10)?}))))?;
    // Cache ratios use the same known runs for both numerator and denominator.
    // An unknown cache counter must not be treated as zero or dilute the rate.
    let (cache_samples, cached, prompt) = sql(database.query_row("SELECT COUNT(*),SUM(x.cache_read_tokens),SUM(x.input_tokens) FROM analytics_runs x JOIN analytics_requests r ON x.request_id=r.request_id WHERE r.started_ms>=?1 AND r.started_ms<?2 AND (?3='' OR r.service_id=?3) AND x.input_tokens>0 AND x.cache_read_tokens BETWEEN 0 AND x.input_tokens", params![range.start,range.end,range.service], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,Option<i64>>(1)?,row.get::<_,Option<i64>>(2)?))))?;
    run_totals["cacheRateSamples"] = json!(cache_samples);
    run_totals["cacheHitRate"] = match (cached, prompt) {
        (Some(cached), Some(prompt)) if prompt > 0 => json!(cached as f64 / prompt as f64),
        _ => Value::Null,
    };
    let (expert_samples, hits, lookups) = sql(database.query_row("SELECT COUNT(*),SUM(x.expert_cache_hits),SUM(x.expert_cache_lookups) FROM analytics_runs x JOIN analytics_requests r ON x.request_id=r.request_id WHERE r.started_ms>=?1 AND r.started_ms<?2 AND (?3='' OR r.service_id=?3) AND x.expert_cache_lookups>0 AND x.expert_cache_hits BETWEEN 0 AND x.expert_cache_lookups", params![range.start,range.end,range.service], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,Option<i64>>(1)?,row.get::<_,Option<i64>>(2)?))))?;
    run_totals["expertCacheSamples"] = json!(expert_samples);
    run_totals["expertCacheHitRate"] = match (hits, lookups) {
        (Some(hits), Some(lookups)) if lookups > 0 => json!(hits as f64 / lookups as f64),
        _ => Value::Null,
    };
    let mut stmt=sql(database.prepare("SELECT route,client_id,COUNT(*),SUM(outcome='succeeded') FROM analytics_requests WHERE started_ms>=?1 AND started_ms<?2 AND (?3='' OR service_id=?3) GROUP BY route,client_id ORDER BY COUNT(*) DESC"))?;
    let groups=sql(stmt.query_map(params![range.start,range.end,range.service],|r|Ok(json!({"route":r.get::<_,String>(0)?,"clientId":r.get::<_,Option<String>>(1)?,"requests":r.get::<_,i64>(2)?,"succeeded":r.get::<_,i64>(3)?}))))?;
    let groups = sql(groups.collect::<rusqlite::Result<Vec<_>>>())?;
    Ok(
        json!({"startMs":range.start,"endMs":range.end,"http":totals,"inference":run_totals,"groups":groups,"ttftS":distribution(database,"first_token_s",range,false)?,"durationS":distribution(database,"duration_s",range,false)?,"decodeTokS":distribution(database,"decode_tok_s",range,true)?,"prefillTokS":distribution(database,"prefill_tok_s",range,true)?,"retentionDays":90,"successRateDefinition":"succeeded / (succeeded + failed + cancelled + interrupted); pending excluded","tokenDefinition":"HTTP usage and inference work are separate; unavailable counters remain null"}),
    )
}

fn recent(database: &Connection, range: &Range, limit: i64) -> Result<Value, String> {
    let mut stmt=sql(database.prepare(&format!("{REQUEST_COLUMNS} FROM analytics_requests r WHERE r.started_ms>=?1 AND r.started_ms<?2 AND (?3='' OR r.service_id=?3) ORDER BY r.started_ms DESC,r.request_id DESC LIMIT ?4")))?;
    let rows = sql(stmt.query_map(
        params![range.start, range.end, range.service, limit],
        request_row,
    ))?;
    Ok(json!(sql(rows.collect::<rusqlite::Result<Vec<_>>>())?))
}

const REQUEST_COLUMNS: &str = "SELECT r.request_id,r.service_id,r.started_ms,r.ended_ms,r.route,r.client_id,r.outcome,r.http_status,r.stream,r.input_tokens,r.output_tokens,r.cache_read_tokens,r.first_token_s,r.duration_s,r.error_kind,r.mcp_tool_calls,(SELECT COUNT(*) FROM analytics_runs x WHERE x.request_id=r.request_id),r.model_id,(SELECT AVG(x.prefill_tok_s) FROM analytics_runs x WHERE x.request_id=r.request_id),(SELECT AVG(x.decode_tok_s) FROM analytics_runs x WHERE x.request_id=r.request_id),(SELECT 1.0*SUM(x.cache_read_tokens)/SUM(x.input_tokens) FROM analytics_runs x WHERE x.request_id=r.request_id AND x.input_tokens>0 AND x.cache_read_tokens BETWEEN 0 AND x.input_tokens),(SELECT 1.0*SUM(x.expert_cache_hits)/SUM(x.expert_cache_lookups) FROM analytics_runs x WHERE x.request_id=r.request_id AND x.expert_cache_lookups>0 AND x.expert_cache_hits BETWEEN 0 AND x.expert_cache_lookups)";
const EXPORT_LIMIT: usize = 5000;
fn request_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"requestId":row.get::<_,String>(0)?,"serviceId":row.get::<_,String>(1)?,"startedAtMs":row.get::<_,i64>(2)?,"endedAtMs":row.get::<_,Option<i64>>(3)?,"route":row.get::<_,String>(4)?,"clientId":row.get::<_,Option<String>>(5)?,"outcome":row.get::<_,String>(6)?,"httpStatus":row.get::<_,Option<i64>>(7)?,"stream":row.get::<_,Option<bool>>(8)?,"inputTokens":row.get::<_,Option<i64>>(9)?,"outputTokens":row.get::<_,Option<i64>>(10)?,"cacheReadTokens":row.get::<_,Option<i64>>(11)?,"firstTokenS":row.get::<_,Option<f64>>(12)?,"durationS":row.get::<_,Option<f64>>(13)?,"errorKind":row.get::<_,Option<String>>(14)?,"mcpToolCalls":row.get::<_,i64>(15)?,"inferenceRuns":row.get::<_,i64>(16)?,"modelId":row.get::<_,Option<String>>(17)?,"prefillTokS":row.get::<_,Option<f64>>(18)?,"decodeTokS":row.get::<_,Option<f64>>(19)?,"cacheHitRate":row.get::<_,Option<f64>>(20)?,"expertCacheHitRate":row.get::<_,Option<f64>>(21)?}),
    )
}

#[derive(Clone)]
struct RequestFilter {
    client: Option<Option<String>>,
    model: Option<Option<String>>,
    outcome: Option<String>,
    oldest: bool,
}
impl RequestFilter {
    fn from(value: &Value) -> Result<Self, String> {
        let label = |key: &str, is_model: bool| -> Result<Option<Option<String>>, String> {
            match value.get(key) {
                None => Ok(None),
                Some(Value::Null) => Ok(Some(None)),
                Some(Value::String(text)) if text.is_empty() => Ok(None),
                Some(Value::String(text)) => {
                    let valid = if is_model {
                        model(Some(text.clone()))
                    } else {
                        client(Some(text.clone()))
                    };
                    valid
                        .map(|label| Some(Some(label)))
                        .ok_or_else(|| format!("invalid analytics {key}"))
                }
                _ => Err(format!("invalid analytics {key}")),
            }
        };
        let outcome = match value.get("outcome") {
            None => None,
            Some(Value::String(text)) if text.is_empty() => None,
            Some(Value::String(text))
                if known(
                    text,
                    &["pending", "succeeded", "failed", "cancelled", "interrupted"],
                ) =>
            {
                Some(text.clone())
            }
            _ => return Err("invalid analytics request outcome".into()),
        };
        let oldest = match value
            .get("sort")
            .and_then(Value::as_str)
            .unwrap_or("newest")
        {
            "newest" => false,
            "oldest" => true,
            _ => return Err("invalid analytics request sort".into()),
        };
        Ok(Self {
            client: label("clientId", false)?,
            model: label("modelId", true)?,
            outcome,
            oldest,
        })
    }
    fn scope(&self, range: &Range) -> String {
        // Nested Option serializes both "all" and "unknown" as null. Bind the
        // selected flags too so a cursor cannot silently change either filter.
        let bytes = serde_json::to_vec(&json!([
            range.start,
            range.end,
            range.service,
            self.client.is_some(),
            self.client,
            self.model.is_some(),
            self.model,
            self.outcome,
            self.oldest
        ]))
        .expect("closed analytics filter serializes");
        format!("{:x}", Sha256::digest(bytes))
    }
    fn clause(
        &self,
        range: &Range,
        snapshot: i64,
        cursor: Option<&RequestCursor>,
    ) -> (String, Vec<rusqlite::types::Value>) {
        use rusqlite::types::Value as Binding;
        let mut clause =
            "r.started_ms>=?1 AND r.started_ms<?2 AND (?3='' OR r.service_id=?3) AND o.id<=?4"
                .to_string();
        let mut bindings = vec![
            Binding::Integer(range.start),
            Binding::Integer(range.end),
            Binding::Text(range.service.clone()),
            Binding::Integer(snapshot),
        ];
        for (column, selected) in [("client_id", &self.client), ("model_id", &self.model)] {
            match selected {
                Some(Some(label)) => {
                    bindings.push(Binding::Text(label.clone()));
                    clause.push_str(&format!(" AND r.{column}=?{}", bindings.len()));
                }
                Some(None) => clause.push_str(&format!(" AND r.{column} IS NULL")),
                None => {}
            }
        }
        if let Some(outcome) = &self.outcome {
            bindings.push(Binding::Text(outcome.clone()));
            clause.push_str(&format!(" AND r.outcome=?{}", bindings.len()));
        }
        if let Some(cursor) = cursor {
            let comparison = if self.oldest { ">" } else { "<" };
            bindings.push(Binding::Integer(cursor.started_ms));
            let at = bindings.len();
            bindings.push(Binding::Text(cursor.request_id.clone()));
            clause.push_str(&format!(" AND (r.started_ms{comparison}?{at} OR (r.started_ms=?{at} AND r.request_id{comparison}?{}))",bindings.len()));
        }
        (clause, bindings)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestCursor {
    version: u8,
    snapshot: i64,
    started_ms: i64,
    request_id: String,
    scope: String,
}
fn snapshot(
    database: &Connection,
    value: &Value,
    cursor: Option<&RequestCursor>,
) -> Result<i64, String> {
    let current = sql(database.query_row(
        "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='analytics_request_order'),0)",
        [],
        |row| row.get::<_, i64>(0),
    ))?;
    let explicit = value
        .get("snapshotRowId")
        .map(|value| value.as_i64().ok_or("invalid analytics snapshot"))
        .transpose()?;
    let selected = cursor
        .map(|cursor| cursor.snapshot)
        .or(explicit)
        .unwrap_or(current);
    if selected < 0 || selected > current || explicit.is_some_and(|at| at != selected) {
        return Err("invalid analytics snapshot".into());
    }
    Ok(selected)
}
fn request_rows(
    database: &Connection,
    range: &Range,
    filter: &RequestFilter,
    snapshot: i64,
    cursor: Option<&RequestCursor>,
    limit: usize,
) -> Result<Vec<Value>, String> {
    let (clause, mut bindings) = filter.clause(range, snapshot, cursor);
    let order = if filter.oldest { "ASC" } else { "DESC" };
    bindings.push(rusqlite::types::Value::Integer(limit as i64));
    let statement = format!("{REQUEST_COLUMNS} FROM analytics_requests r JOIN analytics_request_order o ON o.request_id=r.request_id WHERE {clause} ORDER BY r.started_ms {order},r.request_id {order} LIMIT ?{}",bindings.len());
    let mut statement = sql(database.prepare(&statement))?;
    let rows = sql(statement.query_map(rusqlite::params_from_iter(bindings), request_row))?;
    sql(rows.collect::<rusqlite::Result<Vec<_>>>())
}
fn requests(database: &Connection, range: &Range, value: &Value) -> Result<Value, String> {
    let filter = RequestFilter::from(value)?;
    let scope = filter.scope(range);
    let cursor = match value.get("cursor") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(Value::String(text)) if text.len() <= 1024 => {
            let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(text)
                .map_err(|_| "invalid analytics cursor")?;
            let cursor: RequestCursor =
                serde_json::from_slice(&bytes).map_err(|_| "invalid analytics cursor")?;
            if cursor.version != 1
                || cursor.scope != scope
                || !identity(&cursor.request_id)
                || cursor.started_ms < range.start
                || cursor.started_ms >= range.end
            {
                return Err("analytics cursor does not match this query".into());
            }
            Some(cursor)
        }
        _ => return Err("invalid analytics cursor".into()),
    };
    let snapshot = snapshot(database, value, cursor.as_ref())?;
    let limit = value
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(50)
        .clamp(1, 200) as usize;
    let mut items = request_rows(
        database,
        range,
        &filter,
        snapshot,
        cursor.as_ref(),
        limit + 1,
    )?;
    let more = items.len() > limit;
    items.truncate(limit);
    let next = if more {
        items.last().map(|last| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&RequestCursor {
                    version: 1,
                    snapshot,
                    started_ms: last["startedAtMs"].as_i64().expect("typed row"),
                    request_id: last["requestId"].as_str().expect("typed row").into(),
                    scope,
                })
                .expect("cursor serializes"),
            )
        })
    } else {
        None
    };
    Ok(json!({"items":items,"nextCursor":next,"snapshotRowId":snapshot,"limit":limit}))
}
fn request_options(database: &Connection, range: &Range) -> Result<Value, String> {
    let labels = |column: &str| -> Result<(Vec<String>, bool, bool), String> {
        let mut statement = sql(database.prepare(&format!("SELECT DISTINCT {column} FROM analytics_requests WHERE started_ms>=?1 AND started_ms<?2 AND (?3='' OR service_id=?3) ORDER BY {column} LIMIT 202")))?;
        let rows = sql(statement
            .query_map(params![range.start, range.end, range.service], |row| {
                row.get::<_, Option<String>>(0)
            }))?;
        let values = sql(rows.collect::<rusqlite::Result<Vec<_>>>())?;
        let unknown = values.iter().any(Option::is_none);
        let truncated = values.iter().flatten().count() > 200;
        Ok((
            values.into_iter().flatten().take(200).collect(),
            unknown,
            truncated,
        ))
    };
    let (clients, unknown_client, client_truncated) = labels("client_id")?;
    let (models, unknown_model, model_truncated) = labels("model_id")?;
    Ok(
        json!({"clients":clients,"models":models,"unknownClient":unknown_client,"unknownModel":unknown_model,"truncated":client_truncated||model_truncated}),
    )
}

fn csv_cell(value: &Value) -> String {
    let text = match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        _ => value.to_string(),
    };
    // Spreadsheet apps interpret quoted cells as formulae too. Prefix dangerous
    // text after leading whitespace, including tab/CR and Unicode whitespace.
    let danger =
        text.trim_start().starts_with(['=', '+', '-', '@']) || text.starts_with(['\t', '\r', '\n']);
    format!(
        "\"{}{}\"",
        if danger { "'" } else { "" },
        text.replace('"', "\"\"")
    )
}
fn no_redirect(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                #[cfg(windows)]
                let redirected = {
                    use std::os::windows::fs::MetadataExt;
                    metadata.file_attributes() & 0x400 != 0
                };
                #[cfg(not(windows))]
                let redirected = false;
                if metadata.file_type().is_symlink() || redirected {
                    return Err("CSV export path contains a redirected file or directory".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && ancestor == path => {}
            Err(_) => return Err("CSV export directory is unavailable".into()),
        }
    }
    Ok(())
}
fn export_csv(database: &Connection, range: &Range, value: &Value) -> Result<Value, String> {
    let path = Path::new(
        value
            .get("path")
            .and_then(Value::as_str)
            .ok_or("CSV export requires a save-dialog path")?,
    );
    if !path.is_absolute()
        || !path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("csv"))
        || path.is_dir()
    {
        return Err("CSV export requires an absolute .csv file path".into());
    }
    #[cfg(windows)]
    if !matches!(path.components().next(),Some(std::path::Component::Prefix(prefix)) if matches!(prefix.kind(),std::path::Prefix::Disk(_)|std::path::Prefix::VerbatimDisk(_)))
    {
        return Err("CSV export requires a local disk path".into());
    }
    no_redirect(path)?;
    let filter = RequestFilter::from(value)?;
    let snapshot = snapshot(database, value, None)?;
    let rows = request_rows(database, range, &filter, snapshot, None, EXPORT_LIMIT + 1)?;
    if rows.len() > EXPORT_LIMIT {
        return Err(format!("CSV export matches more than {EXPORT_LIMIT} requests (at least {}); narrow the time range or filters (no file was written)",EXPORT_LIMIT+1));
    }
    const FIELDS: &[&str] = &[
        "requestId",
        "serviceId",
        "modelId",
        "clientId",
        "startedAtMs",
        "endedAtMs",
        "route",
        "outcome",
        "httpStatus",
        "stream",
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheHitRate",
        "expertCacheHitRate",
        "prefillTokS",
        "decodeTokS",
        "firstTokenS",
        "durationS",
        "mcpToolCalls",
        "inferenceRuns",
        "errorKind",
    ];
    let parent = dunce::canonicalize(path.parent().ok_or("CSV export requires a directory")?)
        .map_err(|_| "CSV export directory is unavailable")?;
    let destination = parent.join(path.file_name().ok_or("CSV export file name is missing")?);
    let mut temporary = tempfile::NamedTempFile::new_in(&parent)
        .map_err(|_| "CSV export could not create its temporary file")?;
    temporary
        .write_all(b"\xef\xbb\xbf")
        .map_err(|_| "CSV export write failed")?;
    writeln!(temporary, "{}\r", FIELDS.join(",")).map_err(|_| "CSV export write failed")?;
    for row in &rows {
        let line = FIELDS
            .iter()
            .map(|field| csv_cell(&row[*field]))
            .collect::<Vec<_>>()
            .join(",");
        writeln!(temporary, "{line}\r").map_err(|_| "CSV export write failed")?;
    }
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "CSV export flush failed")?;
    // Check again immediately before the atomic rename; never follow an existing
    // symlink/reparse target or put user-selected paths into persisted metadata.
    no_redirect(path)?;
    temporary
        .persist(destination)
        .map_err(|_| "CSV export save failed")?;
    Ok(
        json!({"path":path.to_string_lossy(),"rows":rows.len(),"rowLimit":EXPORT_LIMIT,"snapshotRowId":snapshot}),
    )
}

fn trends(database: &Connection, range: &Range, bucket_ms: i64) -> Result<Value, String> {
    if !(60_000..=86_400_000).contains(&bucket_ms) || (range.end - range.start) / bucket_ms > 2160 {
        return Err(
            "analytics trend supports 1 minute to 1 day buckets, at most 2160 buckets".into(),
        );
    }
    // Buckets are anchored to startMs, so a user's local midnight is supported
    // without assuming a UTC day or the supervisor machine's local timezone.
    let mut stmt=sql(database.prepare("SELECT ((started_ms-?1)/?4),COUNT(*),SUM(outcome='succeeded'),SUM(outcome='failed'),SUM(outcome='cancelled'),SUM(input_tokens),SUM(output_tokens),SUM(outcome='interrupted'),SUM(outcome='pending'),AVG(first_token_s),COUNT(first_token_s),AVG(duration_s),COUNT(duration_s),COUNT(input_tokens),COUNT(output_tokens) FROM analytics_requests WHERE started_ms>=?1 AND started_ms<?2 AND (?3='' OR service_id=?3) GROUP BY ((started_ms-?1)/?4) ORDER BY 1"))?;
    let rows=sql(stmt.query_map(params![range.start,range.end,range.service,bucket_ms],|r|Ok((r.get::<_,i64>(0)?,json!({"requests":r.get::<_,i64>(1)?,"succeeded":r.get::<_,i64>(2)?,"failed":r.get::<_,i64>(3)?,"cancelled":r.get::<_,i64>(4)?,"inputTokens":r.get::<_,Option<i64>>(5)?,"outputTokens":r.get::<_,Option<i64>>(6)?,"interrupted":r.get::<_,i64>(7)?,"pending":r.get::<_,i64>(8)?,"firstTokenS":r.get::<_,Option<f64>>(9)?,"firstTokenSamples":r.get::<_,i64>(10)?,"durationS":r.get::<_,Option<f64>>(11)?,"durationSamples":r.get::<_,i64>(12)?,"inputTokenSamples":r.get::<_,i64>(13)?,"outputTokenSamples":r.get::<_,i64>(14)?})))))?;
    let mut occupied = sql(rows.collect::<rusqlite::Result<std::collections::BTreeMap<_, _>>>())?;
    // Aggregate engine work separately: joining runs into HTTP totals would
    // multiply requests and protocol usage when a tool call triggers more runs.
    let mut statement = sql(database.prepare(r#"SELECT ((r.started_ms-?1)/?4),
        AVG(x.prefill_tok_s),COUNT(x.prefill_tok_s),AVG(x.decode_tok_s),COUNT(x.decode_tok_s),
        1.0*SUM(CASE WHEN x.input_tokens>0 AND x.cache_read_tokens BETWEEN 0 AND x.input_tokens THEN x.cache_read_tokens END)/SUM(CASE WHEN x.input_tokens>0 AND x.cache_read_tokens BETWEEN 0 AND x.input_tokens THEN x.input_tokens END),
        SUM(CASE WHEN x.input_tokens>0 AND x.cache_read_tokens BETWEEN 0 AND x.input_tokens THEN 1 ELSE 0 END),
        1.0*SUM(CASE WHEN x.expert_cache_lookups>0 AND x.expert_cache_hits BETWEEN 0 AND x.expert_cache_lookups THEN x.expert_cache_hits END)/SUM(CASE WHEN x.expert_cache_lookups>0 AND x.expert_cache_hits BETWEEN 0 AND x.expert_cache_lookups THEN x.expert_cache_lookups END),
        SUM(CASE WHEN x.expert_cache_lookups>0 AND x.expert_cache_hits BETWEEN 0 AND x.expert_cache_lookups THEN 1 ELSE 0 END)
        FROM analytics_runs x JOIN analytics_requests r ON x.request_id=r.request_id
        WHERE r.started_ms>=?1 AND r.started_ms<?2 AND (?3='' OR r.service_id=?3)
        GROUP BY ((r.started_ms-?1)/?4) ORDER BY 1"#))?;
    let rows = sql(statement.query_map(params![range.start,range.end,range.service,bucket_ms], |row| Ok((row.get::<_,i64>(0)?, json!({
        "prefillTokS":row.get::<_,Option<f64>>(1)?,"prefillSamples":row.get::<_,i64>(2)?,
        "decodeTokS":row.get::<_,Option<f64>>(3)?,"decodeSamples":row.get::<_,i64>(4)?,
        "cacheHitRate":row.get::<_,Option<f64>>(5)?,"cacheRateSamples":row.get::<_,i64>(6)?,
        "expertCacheHitRate":row.get::<_,Option<f64>>(7)?,"expertCacheSamples":row.get::<_,i64>(8)?
    })))))?;
    let mut engine = sql(rows.collect::<rusqlite::Result<std::collections::BTreeMap<_, _>>>())?;
    let count = (range.end - range.start + bucket_ms - 1) / bucket_ms;
    let mut result = Vec::with_capacity(count as usize);
    for index in 0..count {
        let mut bucket=occupied.remove(&index).unwrap_or_else(||json!({"requests":0,"succeeded":0,"failed":0,"cancelled":0,"interrupted":0,"pending":0,"inputTokens":null,"outputTokens":null,"inputTokenSamples":0,"outputTokenSamples":0,"firstTokenS":null,"firstTokenSamples":0,"durationS":null,"durationSamples":0}));
        let performance = engine.remove(&index).unwrap_or_else(||json!({"prefillTokS":null,"prefillSamples":0,"decodeTokS":null,"decodeSamples":0,"cacheHitRate":null,"cacheRateSamples":0,"expertCacheHitRate":null,"expertCacheSamples":0}));
        bucket
            .as_object_mut()
            .unwrap()
            .extend(performance.as_object().unwrap().clone());
        bucket["startMs"] = json!(range.start + index * bucket_ms);
        result.push(bucket);
    }
    Ok(json!({"bucketMs":bucket_ms,"buckets":result}))
}

fn coverage(database: &Connection, data_dir: &Path, range: &Range) -> Result<Value, String> {
    let mut stmt=sql(database.prepare("SELECT session_id,service_id,started_ms,ended_ms,supported,source_hash FROM analytics_sessions WHERE (?1='' OR service_id=?1) AND started_ms<?2 AND (ended_ms IS NULL OR ended_ms>=?3) ORDER BY started_ms DESC LIMIT 100"))?;
    let sessions=sql(stmt.query_map(params![range.service,range.end,range.start],|r|Ok(json!({"sessionId":r.get::<_,String>(0)?,"serviceId":r.get::<_,String>(1)?,"startedAtMs":r.get::<_,i64>(2)?,"endedAtMs":r.get::<_,Option<i64>>(3)?,"supported":r.get::<_,bool>(4)?,"sourceHash":r.get::<_,Option<String>>(5)?}))))?;
    let sessions = sql(sessions.collect::<rusqlite::Result<Vec<_>>>())?;
    let mut stmt=sql(database.prepare("SELECT first_seq,last_seq,observed_ms,reason FROM analytics_gaps WHERE observed_ms>=?1 AND observed_ms<?2 ORDER BY observed_ms DESC LIMIT 100"))?;
    let gaps=sql(stmt.query_map(params![range.start,range.end],|r|Ok(json!({"firstSeq":r.get::<_,i64>(0)?,"lastSeq":r.get::<_,i64>(1)?,"observedAtMs":r.get::<_,i64>(2)?,"reason":r.get::<_,String>(3)?}))))?;
    let gaps = sql(gaps.collect::<rusqlite::Result<Vec<_>>>())?;
    // Parse a closed status schema rather than returning arbitrary file content.
    let mut statuses = Vec::new();
    if let Ok(entries) = fs::read_dir(data_dir.join("analytics")) {
        for entry in entries.flatten() {
            if !entry.file_name().to_string_lossy().starts_with("status-")
                || entry.path().extension().and_then(|v| v.to_str()) != Some("json")
            {
                continue;
            }
            if let Ok(text) = fs::read_to_string(entry.path()) {
                if text.len() > 4096 {
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    let id = value.get("serviceId").and_then(Value::as_str).unwrap_or("");
                    if !identity(id) || (!range.service.is_empty() && id != range.service) {
                        continue;
                    }
                    let error = value
                        .get("error")
                        .and_then(Value::as_str)
                        .filter(|v| known(v, &["unsupported_runtime", "journal_write_failed"]));
                    let updated = value.get("updatedAtMs").and_then(Value::as_i64);
                    let fresh = updated
                        .map(|at| (0..=65_000).contains(&(now_ms() - at)))
                        .unwrap_or(false);
                    statuses.push(json!({"serviceId":id,"sessionId":value.get("sessionId").and_then(Value::as_str).filter(|v|identity(v)),"pid":value.get("pid").and_then(Value::as_u64),"updatedAtMs":updated,"supported":value.get("supported").and_then(Value::as_bool).unwrap_or(false),"journalWriteFailed":value.get("journalWriteFailed").and_then(Value::as_bool).unwrap_or(false),"observerActive":fresh && value.get("observerActive").and_then(Value::as_bool).unwrap_or(false),"heartbeatFresh":fresh,"error":error}));
                }
            }
        }
    }
    let available_from = sql(database.query_row(
        "SELECT MIN(started_ms) FROM analytics_sessions WHERE supported=1 AND (?1='' OR service_id=?1)",
        [&range.service],
        |r| r.get::<_, Option<i64>>(0),
    ))?;
    Ok(
        json!({"sessions":sessions,"gaps":gaps,"observerStatuses":statuses,"journalPresent":data_dir.join("analytics/journal.sqlite3").is_file(),"metadataOnly":true,"dataAvailableFromMs":available_from,"collectionScope":["POST /v1/chat/completions","POST /v1/responses","POST /v1/messages","POST /v1/messages/count_tokens"],"historyRetentionDays":90,"journalRetentionDays":7,"journalMaxEvents":200000}),
    )
}

pub fn query(state: &RuntimeState, params: Value) -> Result<Value, String> {
    let range = Range::from(&params)?;
    let mut database = state.database.lock().map_err(|e| e.to_string())?;
    // Restore the last durable observer events immediately on reopen, including
    // calls made just before the supervisor stopped or while its UI was closed.
    let journal_sync_failed = consume(
        &mut database,
        &state.data_dir.join("analytics/journal.sqlite3"),
    )
    .is_err();
    // A damaged or temporarily busy observer journal must not hide history
    // already committed to the application database.
    ensure_schema(&database)?;
    let action = params
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("summary");
    let data = match action {
        "summary" => summary(&database, &range)?,
        "requests" => requests(&database, &range, &params)?,
        "request_options" => request_options(&database, &range)?,
        "export_csv" => export_csv(&database, &range, &params)?,
        "recent" => recent(
            &database,
            &range,
            params
                .get("limit")
                .and_then(Value::as_i64)
                .unwrap_or(100)
                .clamp(1, 500),
        )?,
        "trends" => trends(
            &database,
            &range,
            params
                .get("bucketMs")
                .and_then(Value::as_i64)
                .unwrap_or(3_600_000),
        )?,
        _ => return Err("unknown analytics query action".into()),
    };
    let mut coverage = coverage(&database, &state.data_dir, &range)?;
    coverage["journalSyncFailed"] = json!(journal_sync_failed);
    Ok(json!({"data":data,"coverage":coverage}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn journal(path: &Path) -> Connection {
        let c = Connection::open(path).unwrap();
        c.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);INSERT INTO meta VALUES('schema_version','1'),('source_id','fixture'),('ack','0'),('dropped_through','0');CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,at_ms INTEGER,kind TEXT,payload TEXT);").unwrap();
        c
    }
    fn event(c: &Connection, kind: &str, payload: Value) {
        c.execute(
            "INSERT INTO events(at_ms,kind,payload) VALUES(?1,?2,?3)",
            params![now_ms(), kind, payload.to_string()],
        )
        .unwrap();
    }
    fn start(c: &Connection, id: &str, session: &str, at: i64) {
        event(
            c,
            "request_start",
            json!({"requestId":id,"sessionId":session,"serviceId":"local","startedAtMs":at,"route":"chat","clientId":null}),
        );
    }
    fn end(c: &Connection, id: &str, outcome: &str, at: i64, ft: Value) {
        event(
            c,
            "request_end",
            json!({"requestId":id,"endedAtMs":at,"outcome":outcome,"httpStatus":200,"stream":true,"inputTokens":10,"outputTokens":4,"cacheReadTokens":3,"cacheCreationTokens":null,"firstTokenS":ft,"durationS":2.0,"errorKind":null}),
        );
    }
    fn range(at: i64) -> Range {
        Range {
            start: at - 1000,
            end: at + 86_400_000,
            service: String::new(),
        }
    }
    #[test]
    fn replay_and_restart_are_idempotent_and_ack_after_commit() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("journal.sqlite3");
        let src = journal(&path);
        let at = now_ms();
        start(&src, "request1", "session1", at);
        end(&src, "request1", "succeeded", at + 2, json!(0.25));
        let dest = tmp.path().join("stats.sqlite3");
        let mut db = Connection::open(&dest).unwrap();
        assert_eq!(consume(&mut db, &path).unwrap(), 2);
        assert_eq!(
            src.query_row("SELECT value FROM meta WHERE key='ack'", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "2"
        );
        src.execute("UPDATE meta SET value='0' WHERE key='ack'", [])
            .unwrap();
        drop(db);
        let mut db = Connection::open(dest).unwrap();
        assert_eq!(consume(&mut db, &path).unwrap(), 0);
        assert_eq!(summary(&db, &range(at)).unwrap()["http"]["requests"], 1);
    }
    #[test]
    fn app_reopen_imports_durable_tail_and_retains_engine_performance() {
        let temp = tempfile::tempdir().unwrap();
        let analytics = temp.path().join("analytics");
        fs::create_dir(&analytics).unwrap();
        let source = journal(&analytics.join("journal.sqlite3"));
        let at = now_ms();
        start(&source, "http", "old-session", at);
        end(&source, "http", "succeeded", at + 2, json!(0.25));
        event(
            &source,
            "run_end",
            json!({"runId":"engine-run","requestId":"http","serviceId":"local","sessionId":"old-session","startedAtMs":at,"promptTotal":10,"inputTokens":10,"outputTokens":4,"cacheReadTokens":3,"firstTokenS":0.25,"durationS":2.0,"decodeTokS":20.0,"prefillTokens":7,"prefillS":0.1,"prefillTokS":70.0,"decodeS":0.2,"expertCacheHits":60,"expertCacheLookups":100,"finish":"stop","toolCalls":0}),
        );
        let params = json!({"startMs":at-1,"endMs":at+10000,"serviceId":"local"});
        let state = RuntimeState::open(temp.path().to_owned()).unwrap();
        let first = query(&state, params.clone()).unwrap();
        assert_eq!(first["data"]["http"]["requests"], 1);
        assert_eq!(first["data"]["inference"]["cacheHitRate"], 0.3);
        assert_eq!(first["data"]["inference"]["expertCacheHitRate"], 0.6);
        assert_eq!(first["data"]["prefillTokS"]["p50"], 70.0);
        assert_eq!(first["data"]["decodeTokS"]["p50"], 20.0);
        drop(state);
        // A durable final call not yet imported by the old supervisor must show
        // immediately, without waiting for its background poll after reopening.
        start(&source, "tail", "old-session", at + 3);
        end(&source, "tail", "succeeded", at + 4, Value::Null);
        let reopened = RuntimeState::open(temp.path().to_owned()).unwrap();
        let restored = query(&reopened, params.clone()).unwrap();
        assert_eq!(restored["data"]["http"]["requests"], 2);
        assert_eq!(restored["data"]["inference"]["cacheHitRate"], 0.3);
        assert_eq!(restored["data"]["prefillTokS"]["samples"], 1);
        assert_eq!(query(&reopened, params).unwrap()["data"], restored["data"]);
        let rows = query(
            &reopened,
            json!({"action":"requests","startMs":at-1,"endMs":at+10000}),
        )
        .unwrap();
        let record = rows["data"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["requestId"] == "http")
            .unwrap();
        assert_eq!(record["prefillTokS"], 70.0);
        assert_eq!(record["cacheHitRate"], 0.3);
        assert_eq!(record["expertCacheHitRate"], 0.6);
    }
    #[test]
    fn additive_engine_schema_and_unknown_cache_samples_preserve_history() {
        let database = Connection::open_in_memory().unwrap();
        database.execute_batch("CREATE TABLE analytics_runs(run_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,service_id TEXT NOT NULL,session_id TEXT NOT NULL,started_ms INTEGER NOT NULL,prompt_total INTEGER NOT NULL,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,first_token_s REAL,duration_s REAL,decode_tok_s REAL,finish TEXT NOT NULL,tool_calls INTEGER NOT NULL);INSERT INTO analytics_runs VALUES('old','http','local','session',1000,10,10,4,3,0.1,1.0,20.0,'stop',0);").unwrap();
        ensure_schema(&database).unwrap();
        database.execute("INSERT INTO analytics_requests(request_id,service_id,session_id,started_ms,route) VALUES('http','local','session',1000,'chat')", []).unwrap();
        database.execute("INSERT INTO analytics_runs(run_id,request_id,service_id,session_id,started_ms,prompt_total,input_tokens,cache_read_tokens,finish,tool_calls) VALUES('unknown','http','local','session',1000,1000,1000,NULL,'stop',0),('invalid','http','local','session',1000,5,5,10,'stop',0)", []).unwrap();
        let summary = summary(
            &database,
            &Range {
                start: 0,
                end: 10000,
                service: String::new(),
            },
        )
        .unwrap();
        assert_eq!(summary["inference"]["runs"], 3);
        assert_eq!(summary["inference"]["cacheRateSamples"], 1);
        assert_eq!(summary["inference"]["cacheHitRate"], 0.3);
        assert_eq!(summary["prefillTokS"]["samples"], 0);
        assert!(summary["prefillTokS"]["p50"].is_null());
        assert_eq!(summary["decodeTokS"]["p50"], 20.0);
    }
    #[test]
    fn unavailable_journal_does_not_hide_committed_history() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("analytics");
        fs::create_dir(&directory).unwrap();
        let path = directory.join("journal.sqlite3");
        let source = journal(&path);
        let at = now_ms();
        start(&source, "http", "session", at);
        end(&source, "http", "succeeded", at + 1, Value::Null);
        let state = RuntimeState::open(temp.path().to_owned()).unwrap();
        let params = json!({"startMs":at-1,"endMs":at+10000});
        assert_eq!(
            query(&state, params.clone()).unwrap()["data"]["http"]["requests"],
            1
        );
        drop(source);
        fs::write(path, b"fixture corrupt journal").unwrap();
        let result = query(&state, params).unwrap();
        assert_eq!(result["data"]["http"]["requests"], 1);
        assert_eq!(result["coverage"]["journalSyncFailed"], true);
    }
    #[test]
    fn empty_and_failure_denominators_keep_unknown_null() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("j.sqlite3");
        let src = journal(&path);
        let at = now_ms();
        let mut db = Connection::open_in_memory().unwrap();
        consume(&mut db, &path).unwrap();
        let empty = summary(&db, &range(at)).unwrap();
        assert!(empty["http"]["successRate"].is_null());
        assert!(empty["http"]["inputTokens"].is_null());
        assert!(empty["ttftS"]["p50"].is_null());
        for (id, outcome) in [("a", "succeeded"), ("b", "failed"), ("c", "cancelled")] {
            start(&src, id, "session", at);
            end(&src, id, outcome, at + 1, json!(0.5));
        }
        start(&src, "pending", "session", at);
        consume(&mut db, &path).unwrap();
        let data = summary(&db, &range(at)).unwrap();
        assert_eq!(data["http"]["requests"], 4);
        assert_eq!(data["http"]["pending"], 1);
        assert!((data["http"]["successRate"].as_f64().unwrap() - 1.0 / 3.0).abs() < 1e-10);
    }
    #[test]
    fn cross_day_buckets_and_multi_run_http_are_distinct() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("j.sqlite3");
        let src = journal(&path);
        let at = now_ms() - 86_400_000;
        start(&src, "http1", "s1", at);
        end(&src, "http1", "succeeded", at + 1, json!(1.0));
        start(&src, "http2", "s1", at + 86_400_000);
        end(&src, "http2", "failed", at + 86_400_001, Value::Null);
        for id in ["run1", "run2"] {
            event(
                &src,
                "run_end",
                json!({"runId":id,"requestId":"http1","serviceId":"local","sessionId":"s1","startedAtMs":at,"promptTotal":10,"inputTokens":10,"outputTokens":4,"cacheReadTokens":3,"firstTokenS":0.2,"durationS":1.0,"decodeTokS":25.0,"finish":"stop","toolCalls":1}),
            );
        }
        let mut db = Connection::open_in_memory().unwrap();
        consume(&mut db, &path).unwrap();
        let r = Range {
            start: at,
            end: at + 2 * 86_400_000,
            service: String::new(),
        };
        let data = summary(&db, &r).unwrap();
        assert_eq!(data["http"]["requests"], 2);
        assert_eq!(data["inference"]["runs"], 2);
        assert_eq!(data["inference"]["toolCalls"], 2);
        let trend = trends(&db, &r, 86_400_000).unwrap();
        assert_eq!(trend["buckets"][0]["requests"], 1);
        assert_eq!(trend["buckets"][1]["requests"], 1);
        assert_eq!(data["ttftS"]["samples"], 1);
    }
    #[test]
    fn trend_buckets_keep_http_counts_distinct_and_only_aggregate_known_engine_samples() {
        let database = Connection::open_in_memory().unwrap();
        ensure_schema(&database).unwrap();
        database.execute_batch(r#"INSERT INTO analytics_requests(request_id,service_id,session_id,started_ms,route,outcome,input_tokens,output_tokens,first_token_s,duration_s) VALUES
            ('one','local','session',1000,'chat','succeeded',100,30,0.2,2.0),
            ('two','local','session',2000,'chat','failed',200,10,0.4,4.0),
            ('unknown','local','session',61000,'chat','pending',NULL,NULL,NULL,NULL),
            ('cancelled','local','session',62000,'chat','cancelled',NULL,NULL,NULL,NULL),
            ('interrupted','local','session',63000,'chat','interrupted',NULL,NULL,NULL,NULL),
            ('zero','local','session',181000,'chat','succeeded',0,0,NULL,NULL),
            ('foreign','other','session',1000,'chat','succeeded',9000,9000,9.0,99.0);
            INSERT INTO analytics_runs(run_id,request_id,service_id,session_id,started_ms,prompt_total,input_tokens,cache_read_tokens,prefill_tok_s,decode_tok_s,expert_cache_hits,expert_cache_lookups,finish,tool_calls) VALUES
            ('run1','one','local','session',1000,100,100,50,1000,10,20,100,'stop',0),
            ('run2','one','local','session',2000,300,300,270,3000,30,180,200,'stop',1),
            ('unknown-run','two','local','session',2000,200,200,NULL,NULL,NULL,NULL,NULL,'error',0),
            ('invalid-cache','two','local','session',2000,100,100,500,NULL,NULL,900,100,'error',0),
            ('zero-run','zero','local','session',181000,0,0,0,0,0,0,0,'stop',0),
            ('foreign-run','foreign','other','session',1000,9000,9000,9000,9000,90,9000,9000,'stop',0);"#).unwrap();
        let result = trends(
            &database,
            &Range {
                start: 0,
                end: 240000,
                service: "local".into(),
            },
            60000,
        )
        .unwrap();
        let buckets = result["buckets"].as_array().unwrap();
        assert_eq!(buckets.len(), 4);
        let first = &buckets[0];
        assert_eq!(first["requests"], 2);
        assert_eq!(first["succeeded"], 1);
        assert_eq!(first["failed"], 1);
        assert_eq!(first["inputTokens"], 300);
        assert_eq!(first["outputTokens"], 40);
        assert_eq!(first["inputTokenSamples"], 2);
        assert_eq!(first["firstTokenSamples"], 2);
        assert!((first["firstTokenS"].as_f64().unwrap() - 0.3).abs() < 1e-10);
        assert_eq!(first["durationS"], 3.0);
        assert_eq!(first["prefillTokS"], 2000.0);
        assert_eq!(first["decodeTokS"], 20.0);
        assert_eq!(first["prefillSamples"], 2);
        assert_eq!(first["cacheRateSamples"], 2);
        assert_eq!(first["cacheHitRate"], 0.8);
        assert_eq!(first["expertCacheSamples"], 2);
        assert!((first["expertCacheHitRate"].as_f64().unwrap() - 2.0 / 3.0).abs() < 1e-10);
        assert_eq!(buckets[1]["pending"], 1);
        assert_eq!(buckets[1]["cancelled"], 1);
        assert_eq!(buckets[1]["interrupted"], 1);
        for bucket in buckets {
            let outcomes: i64 = ["succeeded", "failed", "cancelled", "interrupted", "pending"]
                .iter()
                .map(|key| bucket[*key].as_i64().unwrap())
                .sum();
            assert_eq!(outcomes, bucket["requests"].as_i64().unwrap());
        }
        assert_eq!(buckets[2]["requests"], 0);
        for bucket in [&buckets[1], &buckets[2]] {
            assert!(bucket["inputTokens"].is_null());
            assert!(bucket["prefillTokS"].is_null());
            assert!(bucket["cacheHitRate"].is_null());
            assert_eq!(bucket["prefillSamples"], 0);
        }
        // A measured zero remains a real sample, distinct from no observation.
        assert_eq!(buckets[3]["inputTokens"], 0);
        assert_eq!(buckets[3]["inputTokenSamples"], 1);
        assert_eq!(buckets[3]["decodeTokS"], 0.0);
        assert_eq!(buckets[3]["decodeSamples"], 1);
        assert!(buckets[3]["cacheHitRate"].is_null());
        assert!(buckets[3]["expertCacheHitRate"].is_null());
    }
    #[test]
    fn retention_gaps_and_crashed_sessions_are_explicit() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("j.sqlite3");
        let src = journal(&path);
        let at = now_ms();
        start(&src, "lost", "old", at);
        let mut db = Connection::open_in_memory().unwrap();
        consume(&mut db, &path).unwrap();
        event(
            &src,
            "session_start",
            json!({"sessionId":"new","serviceId":"local","startedAtMs":at+1,"supported":true,"sourceHash":null}),
        );
        start(&src, "lost_seq", "new", at + 2);
        start(&src, "kept", "new", at + 3);
        src.execute("DELETE FROM events WHERE seq=3", []).unwrap();
        consume(&mut db, &path).unwrap();
        assert_eq!(summary(&db, &range(at)).unwrap()["http"]["interrupted"], 1);
        assert_eq!(
            db.query_row("SELECT reason FROM analytics_gaps", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "missing_sequence"
        );
    }
    #[test]
    fn malformed_private_payload_is_not_stored_and_does_not_wedge() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("j.sqlite3");
        let src = journal(&path);
        event(&src, "future_event", json!({"prompt":"PRIVATE_SECRET"}));
        start(&src, "good", "s", now_ms());
        let mut db = Connection::open_in_memory().unwrap();
        consume(&mut db, &path).unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM analytics_requests", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM analytics_gaps WHERE reason='invalid_metadata'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
    #[test]
    fn started_runs_survive_crash_and_completed_runs_replace_pending() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("journal.sqlite3");
        let src = journal(&path);
        let at = now_ms();
        start(&src, "http", "old", at);
        let mut run = json!({"runId":"run","requestId":"http","serviceId":"local","sessionId":"old","startedAtMs":at,"promptTotal":10,"inputTokens":null,"outputTokens":null,"cacheReadTokens":null,"firstTokenS":null,"durationS":null,"decodeTokS":null,"finish":"pending","toolCalls":0});
        event(&src, "run_start", run.clone());
        let mut db = Connection::open_in_memory().unwrap();
        consume(&mut db, &path).unwrap();
        assert_eq!(summary(&db, &range(at)).unwrap()["inference"]["runs"], 1);
        assert!(summary(&db, &range(at)).unwrap()["inference"]["outputTokens"].is_null());
        run["finish"] = json!("stop");
        run["outputTokens"] = json!(5);
        run["inputTokens"] = json!(10);
        event(&src, "run_end", run);
        consume(&mut db, &path).unwrap();
        assert_eq!(summary(&db, &range(at)).unwrap()["inference"]["runs"], 1);
        assert_eq!(
            summary(&db, &range(at)).unwrap()["inference"]["outputTokens"],
            5
        );
        let mut pending = json!({"runId":"unfinished","requestId":"http","serviceId":"local","sessionId":"old","startedAtMs":at,"promptTotal":10,"inputTokens":null,"outputTokens":null,"cacheReadTokens":null,"firstTokenS":null,"durationS":null,"decodeTokS":null,"finish":"pending","toolCalls":0});
        pending["outputTokens"] = Value::Null;
        event(&src, "run_start", pending);
        event(
            &src,
            "session_start",
            json!({"sessionId":"new","serviceId":"local","startedAtMs":at+1,"supported":true,"sourceHash":null}),
        );
        consume(&mut db, &path).unwrap();
        assert_eq!(
            db.query_row(
                "SELECT finish FROM analytics_runs WHERE run_id='unfinished'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "interrupted"
        );
    }
    #[test]
    fn percentile_interpolates_and_filters_invalid_samples() {
        assert_eq!(percentile(vec![], 0.95), None);
        assert_eq!(percentile(vec![1.0, 3.0, f64::NAN, -1.0], 0.5), Some(2.0));
        assert!((percentile(vec![1.0, 3.0], 0.95).unwrap() - 2.9).abs() < 1e-10);
    }

    fn add_request(
        database: &Connection,
        id: &str,
        at: i64,
        client: Option<&str>,
        model: Option<&str>,
        outcome: &str,
    ) {
        database.execute("INSERT INTO analytics_requests(request_id,service_id,session_id,started_ms,route,client_id,model_id,outcome) VALUES(?1,'local','session',?2,'chat',?3,?4,?5)",params![id,at,client,model,outcome]).unwrap();
        database
            .execute(
                "INSERT INTO analytics_request_order(request_id) VALUES(?1)",
                [id],
            )
            .unwrap();
    }
    #[test]
    fn historical_schema_migrates_without_guessing_models_or_reusing_snapshot_ids() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE analytics_requests(request_id TEXT PRIMARY KEY,service_id TEXT NOT NULL,session_id TEXT NOT NULL,started_ms INTEGER NOT NULL,ended_ms INTEGER,route TEXT NOT NULL,client_id TEXT,outcome TEXT NOT NULL DEFAULT 'pending',http_status INTEGER,stream INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_creation_tokens INTEGER,first_token_s REAL,duration_s REAL,error_kind TEXT,mcp_tool_calls INTEGER NOT NULL DEFAULT 0,mcp_tool_failures INTEGER NOT NULL DEFAULT 0,counted_tokens INTEGER);INSERT INTO analytics_requests(request_id,service_id,session_id,started_ms,route) VALUES('legacy','local','session',1000,'chat');").unwrap();
        ensure_schema(&db).unwrap();
        let range = Range {
            start: 0,
            end: 5000,
            service: "local".into(),
        };
        let old = requests(&db, &range, &json!({})).unwrap();
        assert_eq!(old["items"][0]["requestId"], "legacy");
        assert!(old["items"][0]["modelId"].is_null());
        let high = old["snapshotRowId"].as_i64().unwrap();
        db.execute("DELETE FROM analytics_request_order", [])
            .unwrap();
        db.execute("DELETE FROM analytics_requests", []).unwrap();
        add_request(&db, "new", 1000, None, Some("actual-model"), "pending");
        assert!(
            requests(&db, &range, &json!({"snapshotRowId":high})).unwrap()["items"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            requests(&db, &range, &json!({})).unwrap()["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn keyset_pages_survive_tied_times_and_late_ingestion_and_bind_query_scope() {
        let mut db = Connection::open_in_memory().unwrap();
        ensure_schema(&db).unwrap();
        let tx = db.transaction().unwrap();
        for index in 0..10_000 {
            add_request(
                &tx,
                &format!("r{index:05}"),
                1000 + index / 3,
                None,
                Some("model"),
                "succeeded",
            );
        }
        tx.commit().unwrap();
        let range = Range {
            start: 0,
            end: 10_000,
            service: "local".into(),
        };
        let first = requests(&db, &range, &json!({"limit":200})).unwrap();
        let high = first["snapshotRowId"].as_i64().unwrap();
        // Newly collected requests include old timestamps and identical times.
        for index in 0..100 {
            add_request(
                &db,
                &format!("late{index}"),
                1000 + index / 2,
                None,
                Some("model"),
                "succeeded",
            );
        }
        let mut collected = first["items"].as_array().unwrap().clone();
        let mut cursor = first["nextCursor"].clone();
        while !cursor.is_null() {
            let page = requests(&db, &range, &json!({"limit":200,"cursor":cursor})).unwrap();
            assert_eq!(page["snapshotRowId"], high);
            collected.extend(page["items"].as_array().unwrap().clone());
            cursor = page["nextCursor"].clone();
        }
        assert_eq!(collected.len(), 10_000);
        let ids = collected
            .iter()
            .map(|row| row["requestId"].as_str().unwrap())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(ids.len(), 10_000);
        assert!(ids.iter().all(|id| id.starts_with('r')));
        for pair in collected.windows(2) {
            let key = |row: &Value| {
                (
                    row["startedAtMs"].as_i64().unwrap(),
                    row["requestId"].as_str().unwrap().to_string(),
                )
            };
            assert!(key(&pair[0]) > key(&pair[1]));
        }
        let oldest = requests(
            &db,
            &range,
            &json!({"limit":2,"sort":"oldest","snapshotRowId":high}),
        )
        .unwrap();
        assert_eq!(oldest["items"][0]["requestId"], "r00000");
        assert_eq!(oldest["items"][1]["requestId"], "r00001");
        for mismatch in [
            json!({"cursor":first["nextCursor"],"sort":"oldest"}),
            json!({"cursor":first["nextCursor"],"clientId":"changed"}),
            json!({"cursor":first["nextCursor"],"clientId":null}),
            json!({"cursor":first["nextCursor"],"modelId":null}),
            json!({"cursor":first["nextCursor"],"snapshotRowId":high+1}),
        ] {
            assert!(requests(&db, &range, &mismatch).is_err());
        }
        let changed = Range {
            end: range.end + 1,
            ..range.clone()
        };
        assert!(requests(&db, &changed, &json!({"cursor":first["nextCursor"]})).is_err());
        assert!(requests(&db, &range, &json!({"cursor":"bad!"})).is_err());
        let plan = db.prepare("EXPLAIN QUERY PLAN SELECT r.request_id FROM analytics_requests r JOIN analytics_request_order o ON o.request_id=r.request_id WHERE r.started_ms>=0 AND r.started_ms<10000 AND o.id<=10000 ORDER BY r.started_ms DESC,r.request_id DESC LIMIT 201").unwrap().query_map([],|row|row.get::<_,String>(3)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap().join("\n");
        assert!(plan.contains("analytics_requests_order"), "{plan}");
        assert!(!plan.contains("TEMP B-TREE"), "{plan}");
    }
    #[test]
    fn filters_preserve_unknown_pending_and_http_vs_inference_counts() {
        let db = Connection::open_in_memory().unwrap();
        ensure_schema(&db).unwrap();
        add_request(&db, "one", 1000, Some("editor"), Some("model-a"), "failed");
        add_request(
            &db,
            "two",
            1001,
            Some("editor"),
            Some("model-b"),
            "cancelled",
        );
        add_request(&db, "three", 1002, None, None, "pending");
        add_request(&db, "four", 1003, None, None, "interrupted");
        db.execute("INSERT INTO analytics_runs(run_id,request_id,service_id,session_id,started_ms,prompt_total,input_tokens,output_tokens,cache_read_tokens,first_token_s,duration_s,decode_tok_s,finish,tool_calls) VALUES('run1','one','local','session',1000,0,NULL,NULL,NULL,NULL,NULL,NULL,'error',0),('run2','one','local','session',1000,0,NULL,NULL,NULL,NULL,NULL,NULL,'error',0)",[]).unwrap();
        let range = Range {
            start: 1000,
            end: 1004,
            service: "local".into(),
        };
        let filtered = requests(
            &db,
            &range,
            &json!({"clientId":"editor","modelId":"model-a","outcome":"failed"}),
        )
        .unwrap();
        assert_eq!(filtered["items"].as_array().unwrap().len(), 1);
        assert_eq!(filtered["items"][0]["inferenceRuns"], 2);
        assert!(filtered["items"][0]["inputTokens"].is_null());
        let unknown = requests(&db, &range, &json!({"clientId":null,"modelId":null})).unwrap();
        assert_eq!(unknown["items"].as_array().unwrap().len(), 2);
        let unknown_page = requests(
            &db,
            &range,
            &json!({"clientId":null,"modelId":null,"limit":1}),
        )
        .unwrap();
        assert!(unknown_page["nextCursor"].is_string());
        for changed_filter in [
            json!({"cursor":unknown_page["nextCursor"]}),
            json!({"cursor":unknown_page["nextCursor"],"clientId":null}),
            json!({"cursor":unknown_page["nextCursor"],"modelId":null}),
            json!({"cursor":unknown_page["nextCursor"],"clientId":"","modelId":""}),
        ] {
            assert!(requests(&db, &range, &changed_filter).is_err());
        }
        assert_eq!(
            requests(&db, &range, &json!({"outcome":"pending"})).unwrap()["items"][0]["requestId"],
            "three"
        );
        assert_eq!(
            requests(&db, &range, &json!({"outcome":"cancelled"})).unwrap()["items"][0]
                ["requestId"],
            "two"
        );
        let stats = summary(&db, &range).unwrap();
        assert_eq!(stats["http"]["requests"], 4);
        assert_eq!(stats["http"]["pending"], 1);
        assert_eq!(stats["inference"]["runs"], 2);
        for invalid in [
            json!({"clientId":"x' OR 1=1"}),
            json!({"modelId":"/private/weights"}),
            json!({"modelId":"C:/private/weights.gguf"}),
            json!({"outcome":"200"}),
            json!({"sort":"random"}),
        ] {
            assert!(requests(&db, &range, &invalid).is_err());
        }
    }
    #[test]
    fn metadata_csv_preserves_nulls_and_escapes_formulae_without_private_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Connection::open_in_memory().unwrap();
        ensure_schema(&db).unwrap();
        add_request(&db, "-formula", 1000, Some("editor"), None, "pending");
        let range = Range {
            start: 0,
            end: 5000,
            service: "local".into(),
        };
        let path = tmp.path().join("metadata.csv");
        let saved = export_csv(&db, &range, &json!({"path":path})).unwrap();
        assert_eq!(saved["rows"], 1);
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"'-formula\""));
        assert!(text.contains("\"pending\",\"\",\"\",\"\",\"\""));
        for forbidden in [
            "prompt",
            "response",
            "reasoning",
            "authorization",
            "api_key",
            "tool_arguments",
            "configPath",
        ] {
            assert!(!text.contains(forbidden));
        }
        for dangerous in [
            "=2+2",
            "+cmd",
            "-cmd",
            "@SUM(A1)",
            "\t=evil",
            " \r=evil",
            "\u{2003}=evil",
        ] {
            assert!(csv_cell(&json!(dangerous)).starts_with("\"'"));
        }
        assert_eq!(csv_cell(&json!("a,\"b\"\nnext")), "\"a,\"\"b\"\"\nnext\"");
        assert_eq!(csv_cell(&Value::Null), "\"\"");
        assert!(export_csv(&db, &range, &json!({"path":"relative.csv"})).is_err());
        assert!(export_csv(&db, &range, &json!({"path":tmp.path().join("config.json")})).is_err());
    }
    #[test]
    fn csv_limit_never_truncates_or_overwrites_an_existing_export() {
        let tmp = tempfile::tempdir().unwrap();
        let mut db = Connection::open_in_memory().unwrap();
        ensure_schema(&db).unwrap();
        let tx = db.transaction().unwrap();
        for index in 0..5001 {
            add_request(&tx, &format!("r{index}"), 1000, None, None, "pending");
        }
        tx.commit().unwrap();
        let range = Range {
            start: 0,
            end: 5000,
            service: "local".into(),
        };
        let path = tmp.path().join("keep.csv");
        fs::write(&path, "existing export").unwrap();
        let error = export_csv(&db, &range, &json!({"path":path})).unwrap_err();
        assert!(error.contains("5000") && error.contains("5001") && error.contains("narrow"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "existing export");
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1);
    }
    #[test]
    fn options_report_two_hundred_label_boundary_with_and_without_unknowns() {
        for unknown in [false, true] {
            let db = Connection::open_in_memory().unwrap();
            ensure_schema(&db).unwrap();
            for index in 0..200 {
                add_request(
                    &db,
                    &format!("r{index}"),
                    1000,
                    Some(&format!("c{index:03}")),
                    Some(&format!("m{index:03}")),
                    "pending",
                );
            }
            if unknown {
                add_request(&db, "unknown", 1000, None, None, "pending");
            }
            let range = Range {
                start: 0,
                end: 5000,
                service: "local".into(),
            };
            let exact = request_options(&db, &range).unwrap();
            assert_eq!(exact["clients"].as_array().unwrap().len(), 200);
            assert_eq!(exact["models"].as_array().unwrap().len(), 200);
            assert_eq!(exact["truncated"], false);
            assert_eq!(exact["unknownModel"], unknown);
            add_request(
                &db,
                "extra",
                1000,
                Some("zz-extra"),
                Some("zz-extra"),
                "pending",
            );
            let over = request_options(&db, &range).unwrap();
            assert_eq!(over["clients"].as_array().unwrap().len(), 200);
            assert_eq!(over["truncated"], true);
        }
    }
    #[test]
    fn csv_rejects_redirected_parent_and_file_targets() {
        let tmp = tempfile::tempdir().unwrap();
        let directory = tmp.path().join("real");
        fs::create_dir(&directory).unwrap();
        let link = tmp.path().join("redirect");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&directory, &link).unwrap();
        #[cfg(windows)]
        assert!(std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&directory)
            .output()
            .unwrap()
            .status
            .success());
        let db = Connection::open_in_memory().unwrap();
        ensure_schema(&db).unwrap();
        add_request(&db, "one", 1000, None, None, "pending");
        let range = Range {
            start: 0,
            end: 5000,
            service: "local".into(),
        };
        assert!(
            export_csv(&db, &range, &json!({"path":link.join("blocked.csv")}))
                .unwrap_err()
                .contains("redirected")
        );
        assert!(!directory.join("blocked.csv").exists());
        #[cfg(unix)]
        {
            let target = directory.join("target.csv");
            fs::write(&target, "keep").unwrap();
            let file_link = directory.join("file.csv");
            std::os::unix::fs::symlink(&target, &file_link).unwrap();
            assert!(export_csv(&db, &range, &json!({"path":file_link})).is_err());
            assert_eq!(fs::read_to_string(target).unwrap(), "keep");
        }
    }
}
