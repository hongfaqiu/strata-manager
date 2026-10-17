//! Benchmark Arena: consent state, whitelisted upload queue with retry, signed requests and read-only API access.
//!
//! The webview cannot reach the network (CSP `connect-src` is IPC only), so everything goes through here.
//! Payloads are re-validated against the exact schema-v1 shape (unknown fields are rejected) before they are
//! queued; the only identifier added is the random per-install id, which the user can withdraw at any time.
use crate::{ClientState, State};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const CONSENT_VERSION: u32 = 1;
const SCHEMA_VERSION: u8 = 1;
const DEFAULT_ENDPOINT: &str = "https://arena.cosfoc.com";
/// Signing key shared by all desktop builds. It ships inside every binary, so it only filters out casual
/// scripted traffic; server-side rate limits and sanity checks carry the real weight. Rotate via
/// STRATA_ARENA_APP_KEY at build time (the Worker accepts a comma-separated list during rotation).
const DEFAULT_APP_KEY: &str = "<rotated-out; injected at build time>";
const MAX_ATTEMPTS: u32 = 8;
const BACKOFF_SECS: [u64; 5] = [60, 300, 1_800, 7_200, 43_200];
const MAX_LOG: usize = 100;
const MAX_QUEUE: usize = 50;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

fn endpoint() -> &'static str {
    option_env!("STRATA_ARENA_ENDPOINT").unwrap_or(DEFAULT_ENDPOINT)
}
fn app_key() -> &'static str {
    option_env!("STRATA_ARENA_APP_KEY").unwrap_or(DEFAULT_APP_KEY)
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
fn lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}
static FLUSHING: AtomicBool = AtomicBool::new(false);
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent(concat!("StrataManager/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default()
    })
}

// ---------- payload schema (mirror of packages/core/src/arena.ts and services/arena/src/schema.js) ----------
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Payload {
    schema: u8,
    app: String,
    strata: Option<String>,
    kind: String,
    day: String,
    hw: Hardware,
    model: Model,
    params: Params,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tiers: Option<Vec<Tier>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    scenario: Option<Scenario>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Hardware {
    os: String,
    arch: String,
    cpu: String,
    #[serde(rename = "ramGB")]
    ram_gb: f64,
    gpus: Vec<Gpu>,
    pcie: Option<String>,
    wsl: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Gpu {
    vendor: String,
    name: String,
    #[serde(rename = "vramGB")]
    vram_gb: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Model {
    family: String,
    quant: String,
    sha256: Option<String>,
    #[serde(rename = "sizeGB")]
    size_gb: Option<f64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Params {
    ctx: u64,
    kv: String,
    gpu_count: u32,
    parallel: u32,
    pool_workers: Option<u32>,
    expert_cache: Option<String>,
    pcie_frac: Option<f64>,
    vision: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Tier {
    ctx: u64,
    prefill: Option<f64>,
    decode: Option<f64>,
    #[serde(rename = "ttftMs")]
    ttft_ms: Option<f64>,
    #[serde(rename = "peakVramGB")]
    peak_vram_gb: Option<f64>,
    #[serde(rename = "peakRamGB")]
    peak_ram_gb: Option<f64>,
    ok: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Scenario {
    decode: Option<f64>,
    prefill: Option<f64>,
    ttft_ms: Option<f64>,
    max_concurrency: u32,
    requests: u32,
    failed: u32,
}

fn safe_text(value: &str) -> bool {
    value.len() <= 96
        && value.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, ' ' | '(' | ')' | '+' | '.' | '_' | '-')
        })
}
fn finite(values: &[Option<f64>]) -> bool {
    values.iter().flatten().all(|v| v.is_finite() && *v >= 0.0)
}
impl Payload {
    /// Parses an untrusted value into the exact schema and checks every string is plain text
    /// (no slashes, colons, `@` or other characters that paths, URLs, hosts or keys need).
    pub fn parse(value: Value) -> Result<Self, String> {
        let p: Payload =
            serde_json::from_value(value).map_err(|e| format!("arena_payload_invalid: {e}"))?;
        let mut strings = vec![
            &p.app,
            &p.kind,
            &p.day,
            &p.hw.os,
            &p.hw.arch,
            &p.hw.cpu,
            &p.model.family,
            &p.model.quant,
            &p.params.kv,
        ];
        strings.extend(p.strata.iter());
        strings.extend(p.hw.pcie.iter());
        strings.extend(p.model.sha256.iter());
        strings.extend(p.params.expert_cache.iter());
        for gpu in &p.hw.gpus {
            strings.push(&gpu.vendor);
            strings.push(&gpu.name);
        }
        if let Some(bad) = strings.iter().find(|s| !safe_text(s)) {
            return Err(format!(
                "arena_payload_unsafe: {:?}",
                bad.chars().take(24).collect::<String>()
            ));
        }
        let mut numbers = vec![Some(p.hw.ram_gb), p.model.size_gb, p.params.pcie_frac];
        numbers.extend(p.hw.gpus.iter().map(|g| Some(g.vram_gb)));
        for t in p.tiers.iter().flatten() {
            numbers.extend([
                t.prefill,
                t.decode,
                t.ttft_ms,
                t.peak_vram_gb,
                t.peak_ram_gb,
            ]);
        }
        if let Some(s) = &p.scenario {
            numbers.extend([s.decode, s.prefill, s.ttft_ms]);
        }
        if !finite(&numbers) {
            return Err("arena_payload_invalid: non-finite number".into());
        }
        let shape_ok = match p.kind.as_str() {
            "context" => {
                p.tiers
                    .as_ref()
                    .is_some_and(|t| !t.is_empty() && t.len() <= 8)
                    && p.scenario.is_none()
            }
            "scenario" => p.scenario.is_some() && p.tiers.is_none(),
            _ => false,
        };
        if p.schema != SCHEMA_VERSION || !shape_ok || p.hw.gpus.len() > 8 {
            return Err("arena_payload_invalid: shape".into());
        }
        Ok(p)
    }
    /// The platform comes from the native build, not from the webview's user agent.
    fn with_native_platform(mut self) -> Self {
        let os = match std::env::consts::OS {
            "windows" => Some("windows"),
            "linux" => Some("linux"),
            "macos" => Some("macos"),
            _ => None,
        };
        let arch = match std::env::consts::ARCH {
            "x86_64" => Some("x86_64"),
            "aarch64" => Some("aarch64"),
            _ => None,
        };
        if let Some(os) = os {
            self.hw.os = os.into();
        }
        if let Some(arch) = arch {
            self.hw.arch = arch.into();
        }
        self
    }
    fn group(&self) -> String {
        format!("{}:{}", self.model.family, self.model.quant)
    }
}

// ---------- local state ----------
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ArenaState {
    install_id: Option<String>,
    consent_version: Option<u32>,
    consented_at: Option<u64>,
    auto_upload: bool,
    queue: Vec<Queued>,
    log: Vec<LogEntry>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Queued {
    payload: Payload,
    attempts: u32,
    next_at: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogEntry {
    at: u64,
    kind: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    group: Option<String>,
}
impl ArenaState {
    fn consented(&self) -> bool {
        self.install_id.is_some() && self.consent_version == Some(CONSENT_VERSION)
    }
    fn push_log(
        &mut self,
        kind: &str,
        status: &str,
        detail: Option<String>,
        group: Option<String>,
    ) {
        self.log.insert(
            0,
            LogEntry {
                at: now_ms(),
                kind: kind.into(),
                status: status.into(),
                detail,
                group,
            },
        );
        self.log.truncate(MAX_LOG);
    }
    fn status(&self) -> Value {
        json!({
            "consented": self.consented(),
            "consentVersion": self.consent_version,
            "autoUpload": self.consented() && self.auto_upload,
            "queued": self.queue.len(),
            "log": self.log,
            "endpoint": endpoint(),
        })
    }
}
fn state_path(data_dir: &Path) -> PathBuf {
    data_dir.join("arena").join("state.json")
}
fn load(path: &Path) -> ArenaState {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}
fn save(path: &Path, state: &ArenaState) -> Result<(), String> {
    let dir = path.parent().ok_or("arena state path")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}
fn new_install_id() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
/// Delay before the next try after `attempts` failures.
pub fn backoff(attempts: u32) -> Duration {
    let index = (attempts.max(1) as usize - 1).min(BACKOFF_SECS.len() - 1);
    Duration::from_secs(BACKOFF_SECS[index])
}

// ---------- signing ----------
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|b| b ^ 0x36));
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(block.map(|b| b ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}
fn signed_headers(body: &[u8], ts: u64, nonce: &str) -> [(&'static str, String); 3] {
    let message = format!("{ts}\n{nonce}\n{}", hex(&Sha256::digest(body)));
    [
        ("X-Arena-Ts", ts.to_string()),
        ("X-Arena-Nonce", nonce.to_string()),
        (
            "X-Arena-Sig",
            hex(&hmac_sha256(app_key().as_bytes(), message.as_bytes())),
        ),
    ]
}
/// Upload body: the validated payload plus the install id and consent version, nothing else.
fn upload_body(payload: &Payload, install_id: &str) -> Result<Vec<u8>, String> {
    let mut value = serde_json::to_value(payload).map_err(|e| e.to_string())?;
    let object: &mut Map<String, Value> = value.as_object_mut().ok_or("payload")?;
    object.insert("installId".into(), json!(install_id));
    object.insert("consentVersion".into(), json!(CONSENT_VERSION));
    serde_json::to_vec(&value).map_err(|e| e.to_string())
}
async fn signed_request(
    method: reqwest::Method,
    path: &str,
    body: Vec<u8>,
) -> Result<(u16, Value), String> {
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let mut request = client()
        .request(method, format!("{}{path}", endpoint()))
        .header("Content-Type", "application/json");
    for (name, value) in signed_headers(&body, now_ms(), &nonce) {
        request = request.header(name, value);
    }
    let response = request
        .body(body)
        .send()
        .await
        .map_err(|e| format!("network: {}", e.without_url()))?;
    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("network: {}", e.without_url()))?;
    Ok((
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    ))
}
/// Whether a failed upload is worth retrying (server/network trouble) or permanently rejected.
fn retryable(status: u16) -> bool {
    status >= 500 || status == 408 || status == 429
}

// ---------- commands ----------
fn data_dir(state: &State<'_, ClientState>) -> PathBuf {
    state.ipc.data_dir.clone()
}

#[tauri::command]
pub async fn arena_status(state: State<'_, ClientState>) -> Result<Value, String> {
    let _guard = lock().lock().await;
    Ok(load(&state_path(&data_dir(&state))).status())
}

#[tauri::command]
pub async fn arena_consent(
    state: State<'_, ClientState>,
    consent_version: u32,
    auto_upload: bool,
) -> Result<Value, String> {
    if consent_version != CONSENT_VERSION {
        return Err("arena_consent_outdated".into());
    }
    let path = state_path(&data_dir(&state));
    let _guard = lock().lock().await;
    let mut arena = load(&path);
    arena.install_id.get_or_insert_with(new_install_id);
    arena.consent_version = Some(CONSENT_VERSION);
    arena.consented_at = Some(now_ms());
    arena.auto_upload = auto_upload;
    save(&path, &arena)?;
    Ok(arena.status())
}

#[tauri::command]
pub async fn arena_set_auto_upload(
    state: State<'_, ClientState>,
    enabled: bool,
) -> Result<Value, String> {
    let path = state_path(&data_dir(&state));
    let _guard = lock().lock().await;
    let mut arena = load(&path);
    if enabled && !arena.consented() {
        return Err("arena_consent_required".into());
    }
    arena.auto_upload = enabled;
    if !enabled {
        // Turning uploads off also drops anything still waiting, so nothing leaves after the switch.
        let pending = arena.queue.len();
        arena.queue.clear();
        if pending > 0 {
            arena.push_log(
                "context",
                "skipped",
                Some(format!("paused:{pending}")),
                None,
            );
        }
    }
    save(&path, &arena)?;
    Ok(arena.status())
}

#[tauri::command]
pub async fn arena_enqueue(state: State<'_, ClientState>, payload: Value) -> Result<Value, String> {
    let payload = Payload::parse(payload)?.with_native_platform();
    let path = state_path(&data_dir(&state));
    let status = {
        let _guard = lock().lock().await;
        let mut arena = load(&path);
        if !arena.consented() || !arena.auto_upload {
            return Ok(arena.status());
        }
        let (kind, group) = (payload.kind.clone(), payload.group());
        arena.queue.push(Queued {
            payload,
            attempts: 0,
            next_at: 0,
        });
        if arena.queue.len() > MAX_QUEUE {
            arena.queue.remove(0);
        }
        arena.push_log(&kind, "queued", None, Some(group));
        save(&path, &arena)?;
        arena.status()
    };
    tauri::async_runtime::spawn(async move { flush(&path, false).await });
    Ok(status)
}

#[tauri::command]
pub async fn arena_flush(state: State<'_, ClientState>) -> Result<Value, String> {
    let path = state_path(&data_dir(&state));
    flush(&path, true).await;
    let _guard = lock().lock().await;
    Ok(load(&path).status())
}

#[tauri::command]
pub async fn arena_withdraw(state: State<'_, ClientState>) -> Result<Value, String> {
    let path = state_path(&data_dir(&state));
    let _guard = lock().lock().await;
    let arena = load(&path);
    let mut deleted = 0u64;
    if let Some(install_id) = &arena.install_id {
        let body =
            serde_json::to_vec(&json!({ "installId": install_id })).map_err(|e| e.to_string())?;
        let (status, response) = signed_request(reqwest::Method::DELETE, "/v1/me", body).await?;
        if status != 200 {
            return Err(format!(
                "arena_withdraw_failed: {status} {}",
                response["error"].as_str().unwrap_or("")
            ));
        }
        deleted = response["deleted"].as_u64().unwrap_or(0);
    }
    // Forget the install id entirely: a later opt-in starts as a new, unlinked machine.
    let mut fresh = ArenaState::default();
    fresh.push_log("withdraw", "deleted", Some(deleted.to_string()), None);
    save(&path, &fresh)?;
    Ok(json!({ "deleted": deleted }))
}

const QUERY_KEYS: &[&str] = &[
    "group",
    "gpu",
    "vram",
    "ram",
    "family",
    "quant",
    "scene",
    "ctx",
    "kv",
    "parallel",
    "poolWorkers",
    "expertCache",
    "gpuCount",
    "pcieFrac",
];
#[tauri::command]
pub async fn arena_get(path: String, query: Option<Map<String, Value>>) -> Result<Value, String> {
    let route = match path.as_str() {
        "groups" => "/v1/groups",
        "leaderboard" => "/v1/leaderboard",
        "recommend" => "/v1/recommend",
        _ => return Err("arena_path_invalid".into()),
    };
    let mut pairs = Vec::new();
    for (key, value) in query.unwrap_or_default() {
        let text = match value {
            Value::String(s) => s,
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            _ => continue,
        };
        if !QUERY_KEYS.contains(&key.as_str())
            || !(safe_text(&text)
                || text
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '.' | '-')))
        {
            return Err("arena_query_invalid".into());
        }
        pairs.push((key, text));
    }
    let response = client()
        .get(format!("{}{route}", endpoint()))
        .query(&pairs)
        .send()
        .await
        .map_err(|e| format!("network: {}", e.without_url()))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("network: {}", e.without_url()))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("arena_response_too_large".into());
    }
    if !status.is_success() {
        return Err(format!("arena_http_{}", status.as_u16()));
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

// ---------- queue ----------
/// Background retry loop: first try shortly after launch, then every 15 minutes.
pub fn start_background(data_dir: PathBuf) {
    let path = state_path(&data_dir);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(45)).await;
        loop {
            flush(&path, false).await;
            tokio::time::sleep(Duration::from_secs(900)).await;
        }
    });
}
/// Uploads due items one at a time. `force` ignores the backoff schedule (user pressed "retry now").
async fn flush(path: &Path, force: bool) {
    if FLUSHING.swap(true, Ordering::SeqCst) {
        return;
    }
    loop {
        let next = {
            let _guard = lock().lock().await;
            let arena = load(path);
            if !arena.consented() || !arena.auto_upload {
                break;
            }
            let now = now_ms();
            let Some(install_id) = arena.install_id.clone() else {
                break;
            };
            match arena
                .queue
                .iter()
                .position(|q| force && q.attempts < MAX_ATTEMPTS || q.next_at <= now)
            {
                Some(index) => (index, arena.queue[index].payload.clone(), install_id),
                None => break,
            }
        };
        let (_, payload, install_id) = next;
        let outcome = match upload_body(&payload, &install_id) {
            Ok(body) => signed_request(reqwest::Method::POST, "/v1/submit", body).await,
            Err(e) => Err(e),
        };
        let _guard = lock().lock().await;
        let mut arena = load(path);
        // The queue may have changed while uploading (pause, withdraw); find the item again by content.
        let Some(index) = arena.queue.iter().position(|q| {
            serde_json::to_string(&q.payload).ok() == serde_json::to_string(&payload).ok()
        }) else {
            continue;
        };
        let (kind, group) = (payload.kind.clone(), Some(payload.group()));
        match outcome {
            Ok((status, _)) if (200..300).contains(&status) => {
                arena.queue.remove(index);
                arena.push_log(&kind, "uploaded", None, group);
            }
            Ok((status, response)) if !retryable(status) => {
                arena.queue.remove(index);
                let code = response["error"]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                    .take(48)
                    .collect::<String>();
                arena.push_log(
                    &kind,
                    "rejected",
                    Some(format!("{status} {code}").trim().to_string()),
                    group,
                );
            }
            failure => {
                let detail = match failure {
                    Ok((status, _)) => status.to_string(),
                    Err(e) => e.chars().take(64).collect(),
                };
                let item = &mut arena.queue[index];
                item.attempts += 1;
                if item.attempts >= MAX_ATTEMPTS {
                    arena.queue.remove(index);
                    arena.push_log(&kind, "rejected", Some(format!("gave_up {detail}")), group);
                } else {
                    item.next_at = now_ms() + backoff(item.attempts).as_millis() as u64;
                    arena.push_log(&kind, "retrying", Some(detail), group);
                    if force {
                        let _ = save(path, &arena);
                        break;
                    }
                }
            }
        }
        if save(path, &arena).is_err() {
            break;
        }
    }
    FLUSHING.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> Value {
        json!({
            "schema": 1, "app": "0.1.12", "strata": "0.1.44", "kind": "context", "day": "2026-10-17",
            "hw": { "os": "windows", "arch": "x86_64", "cpu": "AMD Ryzen 9 7950X 16-Core Processor", "ramGB": 96, "gpus": [{ "vendor": "nvidia", "name": "NVIDIA GeForce RTX 4090", "vramGB": 24 }], "pcie": "Gen4 x16", "wsl": false },
            "model": { "family": "swift", "quant": "IQ3_S", "sha256": "ab".repeat(32), "sizeGB": 83.6 },
            "params": { "ctx": 131072, "kv": "int8", "gpuCount": 1, "parallel": 1, "poolWorkers": 16, "expertCache": "auto", "pcieFrac": null, "vision": false },
            "tiers": [{ "ctx": 8192, "prefill": 2410.2, "decode": 36.4, "ttftMs": 3150, "peakVramGB": 21.4, "peakRamGB": 61.5, "ok": true }]
        })
    }

    #[test]
    fn hmac_matches_rfc4231_case_2() {
        assert_eq!(
            hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        let long_key = [0xaa_u8; 131];
        assert_eq!(
            hex(&hmac_sha256(
                &long_key,
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn accepts_the_whitelisted_shape_and_round_trips_it() {
        let parsed = Payload::parse(payload()).unwrap();
        let body: Value =
            serde_json::from_slice(&upload_body(&parsed, &"f".repeat(64)).unwrap()).unwrap();
        let mut expected = payload();
        expected["installId"] = json!("f".repeat(64));
        expected["consentVersion"] = json!(1);
        // Numbers may come back as floats (96 -> 96.0); compare them numerically.
        let numbers = |v: &Value| {
            serde_json::to_string(v)
                .unwrap()
                .replace(".0,", ",")
                .replace(".0}", "}")
        };
        assert_eq!(numbers(&body["hw"]), numbers(&expected["hw"]));
        assert_eq!(numbers(&body["params"]), numbers(&expected["params"]));
        assert_eq!(body["installId"], expected["installId"]);
        let mut keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "app",
                "consentVersion",
                "day",
                "hw",
                "installId",
                "kind",
                "model",
                "params",
                "schema",
                "strata",
                "tiers"
            ]
        );
    }

    #[test]
    fn rejects_extra_fields_paths_hosts_and_bad_shapes() {
        for (pointer, value) in [
            ("/baseUrl", json!("http://127.0.0.1:19001")),
            ("/hw/hostname", json!("DESKTOP-ALICE01")),
            ("/params/apiKey", json!("sk-1")),
            ("/tiers/0/output", json!("hello")),
        ] {
            let mut p = payload();
            let (parent, key) = pointer.rsplit_once('/').unwrap();
            p.pointer_mut(if parent.is_empty() { "" } else { parent })
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert(key.into(), value);
            assert!(
                Payload::parse(p).unwrap_err().contains("unknown field"),
                "{pointer}"
            );
        }
        for (pointer, value) in [
            ("/hw/cpu", "C:\\Users\\alice"),
            ("/model/family", "a/b"),
            ("/strata", "host:1"),
            ("/params/kv", "x@y"),
        ] {
            let mut p = payload();
            *p.pointer_mut(pointer).unwrap() = json!(value);
            assert!(
                Payload::parse(p).unwrap_err().contains("unsafe"),
                "{pointer}"
            );
        }
        let mut p = payload();
        p["scenario"] = json!({ "decode": 1, "prefill": 1, "ttftMs": 1, "maxConcurrency": 1, "requests": 1, "failed": 0 });
        assert!(Payload::parse(p).is_err());
        let mut p = payload();
        p["kind"] = json!("chat");
        assert!(Payload::parse(p).is_err());
    }

    #[test]
    fn signs_ts_nonce_and_body_digest() {
        let headers = signed_headers(b"{}", 1_700_000_000_000, &"0".repeat(32));
        let message = format!(
            "1700000000000\n{}\n{}",
            "0".repeat(32),
            hex(&Sha256::digest(b"{}"))
        );
        assert_eq!(
            headers[2].1,
            hex(&hmac_sha256(app_key().as_bytes(), message.as_bytes()))
        );
        assert_eq!(headers[2].1.len(), 64);
    }

    #[test]
    fn backoff_grows_then_caps() {
        let seconds: Vec<u64> = (1..=7).map(|a| backoff(a).as_secs()).collect();
        assert_eq!(seconds, [60, 300, 1_800, 7_200, 43_200, 43_200, 43_200]);
        assert!(retryable(503) && retryable(429) && retryable(408));
        assert!(!retryable(400) && !retryable(401) && !retryable(409) && !retryable(422));
    }

    #[test]
    fn state_persists_and_consent_needs_current_version() {
        let dir =
            std::env::temp_dir().join(format!("arena-state-{}", uuid::Uuid::new_v4().simple()));
        let path = state_path(&dir);
        assert!(!load(&path).consented());
        let mut state = ArenaState {
            install_id: Some(new_install_id()),
            consent_version: Some(CONSENT_VERSION),
            auto_upload: true,
            ..Default::default()
        };
        state.queue.push(Queued {
            payload: Payload::parse(payload()).unwrap(),
            attempts: 2,
            next_at: 5,
        });
        for _ in 0..120 {
            state.push_log("context", "queued", None, Some("swift:IQ3_S".into()));
        }
        save(&path, &state).unwrap();
        let loaded = load(&path);
        assert!(loaded.consented());
        assert_eq!(loaded.install_id.as_ref().unwrap().len(), 64);
        assert_eq!(loaded.queue.len(), 1);
        assert_eq!(loaded.log.len(), MAX_LOG);
        let status = loaded.status();
        assert_eq!(status["queued"], 1);
        assert!(
            status.get("installId").is_none(),
            "the install id never leaves the native side"
        );
        let outdated = ArenaState {
            consent_version: Some(0),
            ..loaded
        };
        assert!(!outdated.consented());
        let _ = std::fs::remove_dir_all(dir);
    }
}
