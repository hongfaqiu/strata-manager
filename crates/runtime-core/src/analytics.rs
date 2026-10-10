//! Durable HTTP usage statistics. HTTP requests, inference runs and MCP calls are
//! different measures. Unknown tokens/timings stay null; no payloads are stored.
use crate::RuntimeState;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs, path::Path, time::Duration};

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
 mcp_tool_failures INTEGER NOT NULL DEFAULT 0,counted_tokens INTEGER);
CREATE INDEX IF NOT EXISTS analytics_requests_range ON analytics_requests(started_ms,service_id);
CREATE TABLE IF NOT EXISTS analytics_runs(
 run_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,service_id TEXT NOT NULL,session_id TEXT NOT NULL,
 started_ms INTEGER NOT NULL,prompt_total INTEGER NOT NULL,input_tokens INTEGER,output_tokens INTEGER,
 cache_read_tokens INTEGER,first_token_s REAL,duration_s REAL,decode_tok_s REAL,
 finish TEXT NOT NULL,tool_calls INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS analytics_runs_request ON analytics_runs(request_id);
CREATE TABLE IF NOT EXISTS analytics_gaps(
 source_id TEXT NOT NULL,first_seq INTEGER NOT NULL,last_seq INTEGER NOT NULL,
 observed_ms INTEGER NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(source_id,first_seq,last_seq,reason));
"#;

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
            sql(tx.execute("INSERT OR IGNORE INTO analytics_requests(request_id,service_id,session_id,started_ms,route,client_id) VALUES(?1,?2,?3,?4,?5,?6)",params![s.request_id,s.service_id,s.session_id,s.started_at_ms,s.route,client(s.client_id)]))?;
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
            sql(tx.execute("UPDATE analytics_requests SET ended_ms=?2,outcome=?3,http_status=?4,stream=?5,input_tokens=?6,output_tokens=?7,cache_read_tokens=?8,cache_creation_tokens=?9,first_token_s=?10,duration_s=?11,error_kind=?12,mcp_tool_calls=?13,mcp_tool_failures=?14,counted_tokens=?15 WHERE request_id=?1",params![s.request_id,s.ended_at_ms,s.outcome,s.http_status.filter(|v| (100..=599).contains(v)),s.stream,positive_i(s.input_tokens),positive_i(s.output_tokens),positive_i(s.cache_read_tokens),positive_i(s.cache_creation_tokens),positive_f(s.first_token_s),positive_f(s.duration_s),error,s.mcp_tool_calls.max(0),s.mcp_tool_failures.max(0),positive_i(s.counted_tokens)]))?;
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
            sql(tx.execute("INSERT INTO analytics_runs(run_id,request_id,service_id,session_id,started_ms,prompt_total,input_tokens,output_tokens,cache_read_tokens,first_token_s,duration_s,decode_tok_s,finish,tool_calls) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14) ON CONFLICT(run_id) DO UPDATE SET input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cache_read_tokens=excluded.cache_read_tokens,first_token_s=excluded.first_token_s,duration_s=excluded.duration_s,decode_tok_s=excluded.decode_tok_s,finish=excluded.finish,tool_calls=excluded.tool_calls",params![s.run_id,s.request_id,s.service_id,s.session_id,s.started_at_ms,s.prompt_total.max(0),positive_i(s.input_tokens),positive_i(s.output_tokens),positive_i(s.cache_read_tokens),positive_f(s.first_token_s),positive_f(s.duration_s),positive_f(s.decode_tok_s),s.finish,s.tool_calls.max(0)]))?;
        }
        _ => return Err("unknown analytics event kind".into()),
    }
    Ok(())
}

/// Replay at most 2000 metadata events atomically. ACK follows destination commit;
/// a crash between commit and ACK replays harmlessly using the durable cursor.
pub fn consume(database: &mut Connection, journal_path: &Path) -> Result<usize, String> {
    sql(database.execute_batch(SCHEMA))?;
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
    let run_totals=sql(database.query_row("SELECT COUNT(*),SUM(x.input_tokens),SUM(x.output_tokens),SUM(x.cache_read_tokens),SUM(x.tool_calls),COUNT(x.input_tokens),COUNT(x.decode_tok_s) FROM analytics_runs x JOIN analytics_requests r ON x.request_id=r.request_id WHERE r.started_ms>=?1 AND r.started_ms<?2 AND (?3='' OR r.service_id=?3)",params![range.start,range.end,range.service],|r|Ok(json!({"runs":r.get::<_,i64>(0)?,"inputTokens":r.get::<_,Option<i64>>(1)?,"outputTokens":r.get::<_,Option<i64>>(2)?,"cacheReadTokens":r.get::<_,Option<i64>>(3)?,"toolCalls":r.get::<_,Option<i64>>(4)?.unwrap_or(0),"inputTokenSamples":r.get::<_,i64>(5)?,"decodeSpeedSamples":r.get::<_,i64>(6)?}))))?;
    let mut stmt=sql(database.prepare("SELECT route,client_id,COUNT(*),SUM(outcome='succeeded') FROM analytics_requests WHERE started_ms>=?1 AND started_ms<?2 AND (?3='' OR service_id=?3) GROUP BY route,client_id ORDER BY COUNT(*) DESC"))?;
    let groups=sql(stmt.query_map(params![range.start,range.end,range.service],|r|Ok(json!({"route":r.get::<_,String>(0)?,"clientId":r.get::<_,Option<String>>(1)?,"requests":r.get::<_,i64>(2)?,"succeeded":r.get::<_,i64>(3)?}))))?;
    let groups = sql(groups.collect::<rusqlite::Result<Vec<_>>>())?;
    Ok(
        json!({"startMs":range.start,"endMs":range.end,"http":totals,"inference":run_totals,"groups":groups,"ttftS":distribution(database,"first_token_s",range,false)?,"durationS":distribution(database,"duration_s",range,false)?,"decodeTokS":distribution(database,"decode_tok_s",range,true)?,"retentionDays":90,"successRateDefinition":"succeeded / (succeeded + failed + cancelled + interrupted); pending excluded","tokenDefinition":"HTTP usage and inference work are separate; unavailable counters remain null"}),
    )
}

fn recent(database: &Connection, range: &Range, limit: i64) -> Result<Value, String> {
    let mut stmt=sql(database.prepare("SELECT r.request_id,r.service_id,r.started_ms,r.ended_ms,r.route,r.client_id,r.outcome,r.http_status,r.stream,r.input_tokens,r.output_tokens,r.cache_read_tokens,r.first_token_s,r.duration_s,r.error_kind,r.mcp_tool_calls,(SELECT COUNT(*) FROM analytics_runs x WHERE x.request_id=r.request_id) FROM analytics_requests r WHERE r.started_ms>=?1 AND r.started_ms<?2 AND (?3='' OR r.service_id=?3) ORDER BY r.started_ms DESC,r.request_id DESC LIMIT ?4"))?;
    let rows=sql(stmt.query_map(params![range.start,range.end,range.service,limit],|r|Ok(json!({"requestId":r.get::<_,String>(0)?,"serviceId":r.get::<_,String>(1)?,"startedAtMs":r.get::<_,i64>(2)?,"endedAtMs":r.get::<_,Option<i64>>(3)?,"route":r.get::<_,String>(4)?,"clientId":r.get::<_,Option<String>>(5)?,"outcome":r.get::<_,String>(6)?,"httpStatus":r.get::<_,Option<i64>>(7)?,"stream":r.get::<_,Option<bool>>(8)?,"inputTokens":r.get::<_,Option<i64>>(9)?,"outputTokens":r.get::<_,Option<i64>>(10)?,"cacheReadTokens":r.get::<_,Option<i64>>(11)?,"firstTokenS":r.get::<_,Option<f64>>(12)?,"durationS":r.get::<_,Option<f64>>(13)?,"errorKind":r.get::<_,Option<String>>(14)?,"mcpToolCalls":r.get::<_,i64>(15)?,"inferenceRuns":r.get::<_,i64>(16)?}))))?;
    Ok(json!(sql(rows.collect::<rusqlite::Result<Vec<_>>>())?))
}

fn trends(database: &Connection, range: &Range, bucket_ms: i64) -> Result<Value, String> {
    if !(60_000..=86_400_000).contains(&bucket_ms) || (range.end - range.start) / bucket_ms > 2160 {
        return Err(
            "analytics trend supports 1 minute to 1 day buckets, at most 2160 buckets".into(),
        );
    }
    // Buckets are anchored to startMs, so a user's local midnight is supported
    // without assuming a UTC day or the supervisor machine's local timezone.
    let mut stmt=sql(database.prepare("SELECT ((started_ms-?1)/?4),COUNT(*),SUM(outcome='succeeded'),SUM(outcome='failed'),SUM(outcome='cancelled'),SUM(input_tokens),SUM(output_tokens) FROM analytics_requests WHERE started_ms>=?1 AND started_ms<?2 AND (?3='' OR service_id=?3) GROUP BY ((started_ms-?1)/?4) ORDER BY 1"))?;
    let rows=sql(stmt.query_map(params![range.start,range.end,range.service,bucket_ms],|r|Ok((r.get::<_,i64>(0)?,json!({"requests":r.get::<_,i64>(1)?,"succeeded":r.get::<_,i64>(2)?,"failed":r.get::<_,i64>(3)?,"cancelled":r.get::<_,i64>(4)?,"inputTokens":r.get::<_,Option<i64>>(5)?,"outputTokens":r.get::<_,Option<i64>>(6)?})))))?;
    let mut occupied = sql(rows.collect::<rusqlite::Result<std::collections::BTreeMap<_, _>>>())?;
    let count = (range.end - range.start + bucket_ms - 1) / bucket_ms;
    let mut result = Vec::with_capacity(count as usize);
    for index in 0..count {
        let mut bucket=occupied.remove(&index).unwrap_or_else(||json!({"requests":0,"succeeded":0,"failed":0,"cancelled":0,"inputTokens":null,"outputTokens":null}));
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
    let database = state.database.lock().map_err(|e| e.to_string())?;
    sql(database.execute_batch(SCHEMA))?;
    let action = params
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("summary");
    let data = match action {
        "summary" => summary(&database, &range)?,
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
    Ok(json!({"data":data,"coverage":coverage(&database,&state.data_dir,&range)?}))
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
}
