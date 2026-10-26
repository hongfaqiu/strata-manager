//! Benchmark Arena: consent state, per-install signing key, whitelisted upload queue with retry, and read-only API access.
//!
//! The webview cannot reach the network (CSP `connect-src` is IPC only), so everything goes through here.
//! Payloads are re-validated against the exact schema-v1 shape (unknown fields are rejected) before they are
//! queued. The install is identified only by a random Ed25519 public key generated on consent; its private key
//! stays on this machine (OS keyring, or an owner-only file when no keyring is available) and is deleted on
//! withdraw. Release builds also carry an app key injected at CI build time; builds without it are read-only.
use crate::{ClientState, State};
use ed25519_dalek::{Signer, SigningKey};
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
const MAX_ATTEMPTS: u32 = 8;
const BACKOFF_SECS: [u64; 5] = [60, 300, 1_800, 7_200, 43_200];
const MAX_LOG: usize = 100;
const MAX_QUEUE: usize = 50;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
/// Highest proof-of-work difficulty the client accepts from the server (2^32 hashes is minutes, not hours).
const MAX_POW_BITS: u32 = 32;
const KEYRING_SERVICE: &str = "io.strata.manager";
const KEYRING_USER: &str = "arena-install-key";

fn endpoint() -> &'static str {
    option_env!("STRATA_ARENA_ENDPOINT").unwrap_or(DEFAULT_ENDPOINT)
}
/// App key injected at build time from the CI secret ARENA_APP_KEY. The source tree carries none, so local and
/// fork builds can read the leaderboard but cannot upload.
fn app_key() -> Option<&'static str> {
    option_env!("STRATA_ARENA_APP_KEY").filter(|key| key.len() >= 32)
}
pub fn upload_available() -> bool {
    app_key().is_some()
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
    /// Run evidence of a context run; uploaded as signed text next to the result, never inside it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    evidence: Option<Evidence>,
    /// Track and key launch parameters. Only sent to servers whose /v1/health advertises `extensions: true`;
    /// older servers reject unknown keys, so it is stripped for them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    extensions: Option<Extensions>,
}
/// Enum-only leaderboard context (packages/core/src/arena.ts ArenaExtensions).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Extensions {
    track: String,
    drafting: Option<String>,
    mtp: Option<bool>,
    gpu_roles: Option<Vec<String>>,
    experts: Option<String>,
}
impl Extensions {
    fn valid(&self) -> bool {
        matches!(self.track.as_str(), "default" | "custom")
            && self
                .drafting
                .as_deref()
                .is_none_or(|d| matches!(d, "auto" | "mtp" | "dflash2" | "off"))
            && self.gpu_roles.as_ref().is_none_or(|roles| {
                roles.len() <= 16
                    && roles
                        .iter()
                        .all(|r| matches!(r.as_str(), "main" | "helper" | "off"))
            })
            && self
                .experts
                .as_deref()
                .is_none_or(|e| matches!(e, "resident" | "mmap" | "cache"))
    }
}
/// Content-free trace of the in-app run (services/arena/src/evidence.js): offsets, timings, token counts,
/// a downsampled resource series and engine counters. Field order here is the signed serialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Evidence {
    v: u8,
    engine: Option<String>,
    duration_ms: u64,
    interval_ms: u64,
    runs: Vec<EvidenceRun>,
    series: EvidenceSeries,
    counters: Option<EvidenceCounters>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct EvidenceRun {
    ctx: u64,
    start_ms: u64,
    end_ms: u64,
    ttft_ms: f64,
    prompt_tokens: u64,
    cached_tokens: Option<u64>,
    completion_tokens: u64,
    prefill: f64,
    decode: f64,
    resource_samples: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct EvidenceSeries {
    count: u64,
    step_ms: u64,
    #[serde(rename = "vramGB")]
    vram_gb: Vec<Option<f64>>,
    #[serde(rename = "ramGB")]
    ram_gb: Vec<Option<f64>>,
    gpu_util: Vec<Option<f64>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EvidenceCounters {
    before: Counters,
    after: Counters,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Counters {
    requests: u64,
    prompt_tokens: u64,
    output_tokens: u64,
}
const EVIDENCE_VERSION: u8 = 1;
const MAX_EVIDENCE_RUNS: usize = 48;
const MAX_EVIDENCE_POINTS: usize = 121;
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
        if let Some(e) = &p.evidence {
            strings.extend(e.engine.iter());
        }
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
        if let Some(e) = &p.evidence {
            for r in &e.runs {
                numbers.extend([Some(r.ttft_ms), Some(r.prefill), Some(r.decode)]);
            }
            for series in [&e.series.vram_gb, &e.series.ram_gb, &e.series.gpu_util] {
                numbers.extend(series.iter().copied());
            }
            let points = e.series.vram_gb.len();
            let evidence_ok = e.v == EVIDENCE_VERSION
                && p.kind == "context"
                && e.runs.len() <= MAX_EVIDENCE_RUNS
                && (1..=MAX_EVIDENCE_POINTS).contains(&points)
                && e.series.ram_gb.len() == points
                && e.series.gpu_util.len() == points
                && e.series.gpu_util.iter().flatten().all(|u| *u <= 100.0);
            if !evidence_ok {
                return Err("arena_payload_invalid: evidence".into());
            }
        }
        if !finite(&numbers) {
            return Err("arena_payload_invalid: non-finite number".into());
        }
        if p.extensions.as_ref().is_some_and(|x| !x.valid()) {
            return Err("arena_payload_invalid: extensions".into());
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
    consent_version: Option<u32>,
    consented_at: Option<u64>,
    auto_upload: bool,
    /// Public half of the install key and where its private half is kept.
    key: Option<InstallKey>,
    registered: bool,
    register_attempts: u32,
    register_next_at: u64,
    banned: bool,
    queue: Vec<Queued>,
    log: Vec<LogEntry>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallKey {
    public_key: String,
    key_id: String,
    store: String,
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
        self.key.is_some() && self.consent_version == Some(CONSENT_VERSION)
    }
    fn uploading(&self) -> bool {
        upload_available() && self.consented() && self.auto_upload && !self.banned
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
            "uploadAvailable": upload_available(),
            "registered": self.registered,
            "banned": self.banned,
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
/// Delay before the next try after `attempts` failures.
pub fn backoff(attempts: u32) -> Duration {
    let index = (attempts.max(1) as usize - 1).min(BACKOFF_SECS.len() - 1);
    Duration::from_secs(BACKOFF_SECS[index])
}

// ---------- install key ----------
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex32(text: &str) -> Option<[u8; 32]> {
    let text = text.trim();
    if text.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(text.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}
fn secret_file(path: &Path) -> PathBuf {
    path.with_file_name("install.key")
}
/// Writes a file only the current user can read (0600 on Unix; the per-user app data directory elsewhere).
fn write_private(file: &Path, contents: &str) -> Result<(), String> {
    use std::io::Write;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut handle = options.open(file).map_err(|e| e.to_string())?;
    handle
        .write_all(contents.as_bytes())
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn keyring_entry() -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok()
}
/// Generates a fresh Ed25519 key and stores the private half: OS keyring first (verified by reading it back),
/// otherwise an owner-only file next to the Arena state.
fn create_key(path: &Path, use_keyring: bool) -> Result<InstallKey, String> {
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).map_err(|e| format!("arena_key_random: {e}"))?;
    let signing = SigningKey::from_bytes(&seed);
    let secret = hex(&seed);
    seed.fill(0);
    let in_keyring = use_keyring
        && keyring_entry().is_some_and(|entry| {
            entry.set_password(&secret).is_ok()
                && entry.get_password().ok().as_deref() == Some(secret.as_str())
        });
    let store = if in_keyring {
        "keyring"
    } else {
        write_private(&secret_file(path), &secret)?;
        "file"
    };
    let public = signing.verifying_key().to_bytes();
    Ok(InstallKey {
        public_key: hex(&public),
        key_id: hex(&Sha256::digest(public)),
        store: store.into(),
    })
}
fn load_signing_key(path: &Path, key: &InstallKey) -> Result<SigningKey, String> {
    let secret = if key.store == "keyring" {
        keyring_entry()
            .and_then(|entry| entry.get_password().ok())
            .ok_or("arena_key_missing")?
    } else {
        std::fs::read_to_string(secret_file(path)).map_err(|_| "arena_key_missing")?
    };
    let signing = SigningKey::from_bytes(&unhex32(&secret).ok_or("arena_key_invalid")?);
    if hex(&signing.verifying_key().to_bytes()) != key.public_key {
        return Err("arena_key_mismatch".into());
    }
    Ok(signing)
}
fn delete_key(path: &Path, use_keyring: bool) {
    if use_keyring {
        if let Some(entry) = keyring_entry() {
            let _ = entry.delete_credential();
        }
    }
    let file = secret_file(path);
    if file.exists() {
        // Overwrite before unlinking so the seed does not linger in the file's old blocks on simple filesystems.
        let _ = write_private(&file, &"0".repeat(64));
        let _ = std::fs::remove_file(file);
    }
}

// ---------- proof of work ----------
fn leading_zero_bits(digest: &[u8]) -> u32 {
    let mut bits = 0;
    for byte in digest {
        if *byte == 0 {
            bits += 8;
            continue;
        }
        return bits + byte.leading_zeros();
    }
    bits
}
/// Finds a counter so that SHA-256("strata-arena-pow|challenge|publicKey|counter") has `bits` leading zero bits.
/// Mirrors services/arena/src/crypto.js. Runs on one core so it never starves a running benchmark.
pub fn solve_pow(challenge: &str, public_key: &str, bits: u32) -> Option<u64> {
    if bits > MAX_POW_BITS {
        return None;
    }
    let mut prefix = Sha256::new();
    prefix.update(format!("strata-arena-pow|{challenge}|{public_key}|").as_bytes());
    (0..(1u64 << 53)).find(|counter| {
        let mut hasher = prefix.clone();
        hasher.update(counter.to_string().as_bytes());
        leading_zero_bits(&hasher.finalize()) >= bits
    })
}

// ---------- signing ----------
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
fn signing_message(body: &[u8], ts: u64, nonce: &str) -> String {
    format!("{ts}\n{nonce}\n{}", hex(&Sha256::digest(body)))
}
/// Request headers: timestamp and nonce, the app-key HMAC when this build has one, and the install signature.
fn signed_headers(
    body: &[u8],
    ts: u64,
    nonce: &str,
    app: Option<&str>,
    install: Option<(&str, &SigningKey)>,
) -> Vec<(&'static str, String)> {
    let message = signing_message(body, ts, nonce);
    let mut headers = vec![
        ("X-Arena-Ts", ts.to_string()),
        ("X-Arena-Nonce", nonce.to_string()),
    ];
    if let Some(key) = app {
        headers.push((
            "X-Arena-Sig",
            hex(&hmac_sha256(key.as_bytes(), message.as_bytes())),
        ));
    }
    if let Some((key_id, signing)) = install {
        headers.push(("X-Arena-Key", key_id.to_string()));
        headers.push((
            "X-Arena-Install-Sig",
            hex(&signing.sign(message.as_bytes()).to_bytes()),
        ));
    }
    headers
}
/// What the install key signs for run evidence: a domain tag, the key id and the SHA-256 of the exact evidence text.
fn evidence_message(key_id: &str, text: &str) -> String {
    format!(
        "strata-arena-evidence|v{EVIDENCE_VERSION}|{key_id}|{}",
        hex(&Sha256::digest(text.as_bytes()))
    )
}
/// Upload body: the validated payload plus the consent version, nothing else. The install is identified by its key.
/// Run evidence travels as its exact serialized text plus the install key's signature over it, so the server can
/// store and re-verify it independently of the request signature. `extensions` is kept only when the server
/// advertised support for it (see `server_accepts_extensions`).
fn upload_body(
    payload: &Payload,
    install: Option<(&str, &SigningKey)>,
    extensions: bool,
) -> Result<Vec<u8>, String> {
    let mut value = serde_json::to_value(payload).map_err(|e| e.to_string())?;
    let object: &mut Map<String, Value> = value.as_object_mut().ok_or("payload")?;
    object.remove("evidence");
    if !extensions {
        object.remove("extensions");
    }
    object.insert("consentVersion".into(), json!(CONSENT_VERSION));
    if let (Some(evidence), Some((key_id, signing))) = (&payload.evidence, install) {
        let text = serde_json::to_string(evidence).map_err(|e| e.to_string())?;
        let signature = signing.sign(evidence_message(key_id, &text).as_bytes());
        object.insert("evidenceSig".into(), json!(hex(&signature.to_bytes())));
        object.insert("evidence".into(), json!(text));
    }
    serde_json::to_vec(&value).map_err(|e| e.to_string())
}
async fn signed_request(
    method: reqwest::Method,
    path: &str,
    body: Vec<u8>,
    install: Option<(&str, &SigningKey)>,
) -> Result<(u16, Value), String> {
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let mut request = client()
        .request(method, format!("{}{path}", endpoint()))
        .header("Content-Type", "application/json");
    for (name, value) in signed_headers(&body, now_ms(), &nonce, app_key(), install) {
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
fn error_code(response: &Value) -> String {
    response["error"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(48)
        .collect()
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
    if !upload_available() {
        return Err("arena_upload_unavailable".into());
    }
    let path = state_path(&data_dir(&state));
    let status = {
        let _guard = lock().lock().await;
        let mut arena = load(&path);
        if arena.key.is_none() {
            let key_path = path.clone();
            let key = tauri::async_runtime::spawn_blocking(move || create_key(&key_path, true))
                .await
                .map_err(|e| e.to_string())??;
            arena.key = Some(key);
            arena.registered = false;
            arena.register_attempts = 0;
            arena.register_next_at = 0;
        }
        arena.consent_version = Some(CONSENT_VERSION);
        arena.consented_at = Some(now_ms());
        arena.auto_upload = auto_upload;
        save(&path, &arena)?;
        arena.status()
    };
    // Registration (proof of work) happens in the background before the first upload.
    tauri::async_runtime::spawn(async move { flush(&path, false).await });
    Ok(status)
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
    if enabled && !upload_available() {
        return Err("arena_upload_unavailable".into());
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
        if !arena.uploading() {
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
    withdraw_at(&state_path(&data_dir(&state)), true).await
}
/// Deletes this install's data and key registration on the server, then forgets the local key and state.
async fn withdraw_at(path: &Path, use_keyring: bool) -> Result<Value, String> {
    let _guard = lock().lock().await;
    let arena = load(path);
    let mut deleted = 0u64;
    if let (Some(key), true) = (&arena.key, arena.registered) {
        // Signed by the install key only, so withdrawing works even in a build without the app key.
        let signing = load_signing_key(path, key)?;
        let (status, response) = signed_request(
            reqwest::Method::DELETE,
            "/v1/me",
            b"{}".to_vec(),
            Some((&key.key_id, &signing)),
        )
        .await?;
        match status {
            200 => deleted = response["deleted"].as_u64().unwrap_or(0),
            // The server no longer knows this key (already withdrawn or expired): nothing left to delete.
            401 if error_code(&response) == "unregistered" => {}
            _ => {
                return Err(format!(
                    "arena_withdraw_failed: {status} {}",
                    error_code(&response)
                ))
            }
        }
    }
    // Forget the key entirely: a later opt-in starts as a new, unlinked machine.
    let key_path = path.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || delete_key(&key_path, use_keyring))
        .await
        .map_err(|e| e.to_string())?;
    let mut fresh = ArenaState::default();
    fresh.push_log("withdraw", "deleted", Some(deleted.to_string()), None);
    save(path, &fresh)?;
    Ok(json!({ "deleted": deleted }))
}

/// Query keys `arena_get` forwards. Must cover every key the desktop sends: services/arena/src/stats.js
/// FILTER_KEYS for /v1/leaderboard (including `q` and `sort`) and the /v1/recommend parameters.
/// apps/desktop/src/pages/arena.test.mjs checks this list against both.
const QUERY_KEYS: &[&str] = &[
    "group",
    "gpu",
    "q",
    "sort",
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
/// Route path plus the query pairs `arena_get` will forward.
type ArenaRouteQuery = (&'static str, Vec<(String, String)>);

/// Validates an `arena_get` request: route plus the forwarded query pairs. Rejections are local bugs or bad
/// input, never network trouble, so they carry the `arena_query_invalid` / `arena_path_invalid` codes.
fn arena_request(path: &str, query: Option<Map<String, Value>>) -> Result<ArenaRouteQuery, String> {
    let route = match path {
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
        if !QUERY_KEYS.contains(&key.as_str()) {
            return Err(format!("arena_query_invalid: {key}"));
        }
        if !(safe_text(&text)
            || text
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '.' | '-')))
        {
            return Err(format!("arena_query_invalid: {key}"));
        }
        pairs.push((key, text));
    }
    Ok((route, pairs))
}
/// Error strings: `network: …` (could not reach the server), `arena_http_<status>`, `arena_response_too_large`,
/// `arena_response_invalid: …` (reached the server but the body is not JSON) and the `arena_request` codes.
#[tauri::command]
pub async fn arena_get(path: String, query: Option<Map<String, Value>>) -> Result<Value, String> {
    let (route, pairs) = arena_request(&path, query)?;
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
    serde_json::from_slice(&bytes).map_err(|e| format!("arena_response_invalid: {e}"))
}

// ---------- registration and queue ----------
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

/// Applies a registration outcome to the state. Split out so the policy is testable without a network.
fn apply_registration(arena: &mut ArenaState, outcome: Result<(u16, Value), String>) -> bool {
    match outcome {
        Ok((200 | 201, _)) => {
            arena.registered = true;
            arena.register_attempts = 0;
            arena.register_next_at = 0;
            arena.push_log("register", "registered", None, None);
            true
        }
        Ok((403, response)) if error_code(&response) == "banned" => {
            arena.banned = true;
            arena.queue.clear();
            arena.push_log("register", "rejected", Some("403 banned".into()), None);
            false
        }
        failure => {
            // Expired challenges, network errors and server trouble are all worth another try with a fresh challenge.
            let detail = match failure {
                Ok((status, response)) => format!("{status} {}", error_code(&response))
                    .trim()
                    .to_string(),
                Err(e) => e.chars().take(64).collect(),
            };
            arena.register_attempts += 1;
            arena.register_next_at = now_ms() + backoff(arena.register_attempts).as_millis() as u64;
            arena.push_log("register", "retrying", Some(detail), None);
            false
        }
    }
}

/// Registers the install key once: server challenge, proof of work off the async runtime, then a request signed
/// with both the app key and the new install key (proof of possession).
async fn ensure_registered(path: &Path, force: bool) -> bool {
    let (key, signing) = {
        let _guard = lock().lock().await;
        let arena = load(path);
        if arena.registered {
            return true;
        }
        if !arena.uploading() || (!force && arena.register_next_at > now_ms()) {
            return false;
        }
        let Some(key) = arena.key.clone() else {
            return false;
        };
        match load_signing_key(path, &key) {
            Ok(signing) => (key, signing),
            Err(e) => {
                let mut arena = arena;
                apply_registration(&mut arena, Err(e));
                let _ = save(path, &arena);
                return false;
            }
        }
    };
    let outcome = async {
        let (status, challenge) = signed_request(
            reqwest::Method::POST,
            "/v1/register/challenge",
            Vec::new(),
            None,
        )
        .await?;
        if status != 200 {
            return Ok((status, challenge));
        }
        let text = challenge["challenge"].as_str().unwrap_or("").to_string();
        let bits = challenge["bits"].as_u64().unwrap_or(u64::MAX) as u32;
        let public_key = key.public_key.clone();
        let counter =
            tauri::async_runtime::spawn_blocking(move || solve_pow(&text, &public_key, bits))
                .await
                .map_err(|e| e.to_string())?
                .ok_or("arena_pow_unsolvable")?;
        let body = serde_json::to_vec(&json!({
            "publicKey": key.public_key,
            "challenge": challenge["challenge"],
            "counter": counter,
            "consentVersion": CONSENT_VERSION,
        }))
        .map_err(|e| e.to_string())?;
        signed_request(
            reqwest::Method::POST,
            "/v1/register",
            body,
            Some((&key.key_id, &signing)),
        )
        .await
    }
    .await;
    let _guard = lock().lock().await;
    let mut arena = load(path);
    // Withdrawn or re-keyed while solving: drop the result.
    if arena.key.as_ref().map(|k| &k.key_id) != Some(&key.key_id) {
        return false;
    }
    let registered = apply_registration(&mut arena, outcome);
    let _ = save(path, &arena);
    registered
}

/// Whether a /v1/health answer advertises the optional `extensions` block. Anything else (older servers,
/// errors, unexpected shapes) means it is stripped from the upload.
fn health_accepts_extensions(health: &Value) -> bool {
    health["extensions"].as_bool() == Some(true)
}
async fn server_accepts_extensions() -> bool {
    let Ok(response) = client()
        .get(format!("{}/v1/health", endpoint()))
        .send()
        .await
    else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    match response.bytes().await {
        Ok(bytes) if bytes.len() <= MAX_RESPONSE_BYTES => serde_json::from_slice::<Value>(&bytes)
            .map(|health| health_accepts_extensions(&health))
            .unwrap_or(false),
        _ => false,
    }
}

/// Uploads due items one at a time. `force` ignores the backoff schedule (user pressed "retry now").
async fn flush(path: &Path, force: bool) {
    if FLUSHING.swap(true, Ordering::SeqCst) {
        return;
    }
    if !ensure_registered(path, force).await {
        FLUSHING.store(false, Ordering::SeqCst);
        return;
    }
    let mut extensions: Option<bool> = None;
    loop {
        let next = {
            let _guard = lock().lock().await;
            let arena = load(path);
            if !arena.uploading() || !arena.registered {
                break;
            }
            let now = now_ms();
            let Some(key) = arena.key.clone() else {
                break;
            };
            match arena
                .queue
                .iter()
                .position(|q| force && q.attempts < MAX_ATTEMPTS || q.next_at <= now)
            {
                Some(index) => (arena.queue[index].payload.clone(), key),
                None => break,
            }
        };
        let (payload, key) = next;
        let send_extensions = if payload.extensions.is_some() {
            match extensions {
                Some(known) => known,
                None => *extensions.insert(server_accepts_extensions().await),
            }
        } else {
            false
        };
        let prepared = load_signing_key(path, &key).and_then(|signing| {
            upload_body(&payload, Some((&key.key_id, &signing)), send_extensions)
                .map(|body| (body, signing))
        });
        let outcome = match prepared {
            Ok((body, signing)) => {
                signed_request(
                    reqwest::Method::POST,
                    "/v1/submit",
                    body,
                    Some((&key.key_id, &signing)),
                )
                .await
            }
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
        if apply_upload(&mut arena, index, &payload, outcome, force) {
            let _ = save(path, &arena);
            break;
        }
        if save(path, &arena).is_err() {
            break;
        }
    }
    FLUSHING.store(false, Ordering::SeqCst);
}

/// Applies one upload outcome to the queue. Returns true when the loop should stop.
fn apply_upload(
    arena: &mut ArenaState,
    index: usize,
    payload: &Payload,
    outcome: Result<(u16, Value), String>,
    force: bool,
) -> bool {
    let (kind, group) = (payload.kind.clone(), Some(payload.group()));
    match outcome {
        Ok((status, response)) if (200..300).contains(&status) => {
            arena.queue.remove(index);
            // "verified": the run evidence checked out and the result counts now; otherwise it waits for review.
            let detail = match response["counted"].as_bool() {
                Some(true) => Some("verified".to_string()),
                Some(false) if payload.kind == "context" => Some("pending".to_string()),
                _ => None,
            };
            arena.push_log(&kind, "uploaded", detail, group);
            false
        }
        Ok((401, response)) if error_code(&response) == "unregistered" => {
            // The server forgot this key (e.g. 12 months idle): register again, keep the item.
            arena.registered = false;
            arena.push_log(&kind, "retrying", Some("401 unregistered".into()), group);
            true
        }
        Ok((403, response)) if error_code(&response) == "banned" => {
            arena.banned = true;
            arena.queue.clear();
            arena.push_log(&kind, "rejected", Some("403 banned".into()), group);
            true
        }
        Ok((status, response)) if !retryable(status) => {
            arena.queue.remove(index);
            let detail = format!("{status} {}", error_code(&response))
                .trim()
                .to_string();
            arena.push_log(&kind, "rejected", Some(detail), group);
            false
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
                false
            } else {
                item.next_at = now_ms() + backoff(item.attempts).as_millis() as u64;
                arena.push_log(&kind, "retrying", Some(detail), group);
                force
            }
        }
    }
}

#[cfg(test)]
mod tests {

    fn query(pairs: &[(&str, &str)]) -> Option<Map<String, Value>> {
        Some(
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), Value::String(v.to_string())))
                .collect(),
        )
    }

    #[test]
    fn arena_request_accepts_every_leaderboard_query_the_app_sends() {
        // Default view on an RTX 4080 SUPER: group + my-GPU scope.
        let (route, pairs) = arena_request(
            "leaderboard",
            query(&[
                ("group", "qwen:IQ3_S"),
                ("gpu", "NVIDIA GeForce RTX 4080 SUPER"),
            ]),
        )
        .unwrap();
        assert_eq!(route, "/v1/leaderboard");
        assert_eq!(pairs.len(), 2);
        // Sort switch and GPU keyword (added with the filters in #35) used to be rejected as arena_query_invalid,
        // which the page showed as "leaderboard unreachable".
        for sort in ["decode128k", "prefill", "machines"] {
            arena_request(
                "leaderboard",
                query(&[("group", "qwen:IQ3_S"), ("sort", sort)]),
            )
            .unwrap_or_else(|e| panic!("sort={sort}: {e}"));
        }
        arena_request(
            "leaderboard",
            query(&[("group", "qwen:IQ3_S"), ("q", "4080 SUPER")]),
        )
        .unwrap();
        arena_request(
            "leaderboard",
            query(&[
                ("group", "qwen:IQ3_S"),
                ("vram", "16"),
                ("ram", "64"),
                ("ctx", "524288"),
                ("kv", "int8"),
                ("parallel", "1"),
                ("gpuCount", "1"),
                ("expertCache", "auto"),
                ("sort", "prefill"),
            ]),
        )
        .unwrap();
    }

    #[test]
    fn arena_request_rejects_unknown_keys_values_and_paths() {
        assert_eq!(
            arena_request("leaderboard", query(&[("token", "x")])).unwrap_err(),
            "arena_query_invalid: token"
        );
        assert!(arena_request("leaderboard", query(&[("gpu", "a/b")]))
            .unwrap_err()
            .starts_with("arena_query_invalid"));
        assert_eq!(
            arena_request("admin", None).unwrap_err(),
            "arena_path_invalid"
        );
    }
    use super::*;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    fn payload() -> Value {
        json!({
            "schema": 1, "app": "0.1.12", "strata": "0.1.44", "kind": "context", "day": "2026-10-17",
            "hw": { "os": "windows", "arch": "x86_64", "cpu": "AMD Ryzen 9 7950X 16-Core Processor", "ramGB": 96, "gpus": [{ "vendor": "nvidia", "name": "NVIDIA GeForce RTX 4090", "vramGB": 24 }], "pcie": "Gen4 x16", "wsl": false },
            "model": { "family": "swift", "quant": "IQ3_S", "sha256": "ab".repeat(32), "sizeGB": 83.6 },
            "params": { "ctx": 131072, "kv": "int8", "gpuCount": 1, "parallel": 1, "poolWorkers": 16, "expertCache": "auto", "pcieFrac": null, "vision": false },
            "tiers": [{ "ctx": 8192, "prefill": 2410.2, "decode": 36.4, "ttftMs": 3150, "peakVramGB": 21.4, "peakRamGB": 61.5, "ok": true }]
        })
    }
    /// A context payload whose run evidence is internally consistent (the server marks it verified).
    fn verified_payload() -> Value {
        let mut p = payload();
        p["evidence"] = json!({
            "v": 1, "engine": "0.1.44", "durationMs": 22000, "intervalMs": 1000,
            "runs": [{ "ctx": 8192, "startMs": 2000, "endMs": 19800, "ttftMs": 3150, "promptTokens": 7592, "cachedTokens": 0,
                "completionTokens": 512, "prefill": 2410.2, "decode": 36.4, "resourceSamples": 19 }],
            "series": { "count": 21, "stepMs": 1000,
                "vramGB": (0..22).map(|i| if i == 12 { 21.4 } else { 20.1 }).collect::<Vec<_>>(),
                "ramGB": (0..22).map(|i| if i == 12 { 61.5 } else { 60.2 }).collect::<Vec<_>>(),
                "gpuUtil": (0..22).map(|i| if i < 2 { 4 } else { 86 }).collect::<Vec<_>>() },
            "counters": { "before": { "requests": 120, "promptTokens": 4200000, "outputTokens": 61000 },
                "after": { "requests": 121, "promptTokens": 4207592, "outputTokens": 61512 } }
        });
        p
    }
    fn temp_state() -> PathBuf {
        state_path(
            &std::env::temp_dir().join(format!("arena-state-{}", uuid::Uuid::new_v4().simple())),
        )
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
    fn source_builds_carry_no_app_key_and_cannot_upload() {
        // The key only exists when CI injects STRATA_ARENA_APP_KEY; plain `cargo test` has none.
        if option_env!("STRATA_ARENA_APP_KEY").is_none() {
            assert!(!upload_available());
            let state = ArenaState {
                consent_version: Some(CONSENT_VERSION),
                auto_upload: true,
                key: Some(InstallKey {
                    public_key: "00".repeat(32),
                    key_id: "11".repeat(32),
                    store: "file".into(),
                }),
                ..Default::default()
            };
            assert!(state.consented() && !state.uploading());
            assert_eq!(state.status()["uploadAvailable"], false);
        }
        let source = include_str!("arena.rs");
        let needle = ["APP_KEY", ": &str = \""].concat();
        assert!(
            !source.contains(&needle),
            "no app key literal in the source"
        );
    }

    #[test]
    fn extensions_are_enum_only_and_sent_only_to_servers_that_advertise_them() {
        let mut value = payload();
        value["extensions"] = json!({"track":"custom","drafting":"off","mtp":false,"gpuRoles":["main","helper"],"experts":"resident"});
        let parsed = Payload::parse(value.clone()).unwrap();
        let stripped: Value =
            serde_json::from_slice(&upload_body(&parsed, None, false).unwrap()).unwrap();
        assert!(stripped.get("extensions").is_none());
        let sent: Value =
            serde_json::from_slice(&upload_body(&parsed, None, true).unwrap()).unwrap();
        assert_eq!(sent["extensions"]["gpuRoles"], json!(["main", "helper"]));
        assert_eq!(sent["extensions"]["mtp"], json!(false));
        // Older queued payloads without extensions still parse and upload unchanged.
        let old = Payload::parse(payload()).unwrap();
        let body: Value = serde_json::from_slice(&upload_body(&old, None, true).unwrap()).unwrap();
        assert!(body.get("extensions").is_none());
        for (key, bad) in [
            ("track", json!("mine")),
            ("drafting", json!("eagle")),
            ("gpuRoles", json!(["C:/x"])),
            ("experts", json!("disk")),
            ("profile", json!("x")),
        ] {
            let mut leaky = value.clone();
            leaky["extensions"][key] = bad;
            assert!(Payload::parse(leaky).is_err(), "{key}");
        }
        assert!(health_accepts_extensions(
            &json!({"ok":true,"schema":1,"extensions":true})
        ));
        assert!(!health_accepts_extensions(
            &json!({"ok":true,"schema":1,"consentVersion":1})
        ));
        assert!(!health_accepts_extensions(&json!({"extensions":"true"})));
    }

    #[test]
    fn evidence_is_uploaded_as_signed_text_and_only_in_the_whitelisted_shape() {
        use ed25519_dalek::{Signature, Verifier};
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let key_id = hex(&Sha256::digest(signing.verifying_key().as_bytes()));
        let parsed = Payload::parse(verified_payload()).unwrap();
        let body: Value = serde_json::from_slice(
            &upload_body(&parsed, Some((&key_id, &signing)), false).unwrap(),
        )
        .unwrap();
        let text = body["evidence"].as_str().expect("evidence travels as text");
        let evidence: Value = serde_json::from_str(text).unwrap();
        assert_eq!(evidence["runs"][0]["promptTokens"], 7592);
        assert_eq!(evidence["series"]["vramGB"].as_array().unwrap().len(), 22);
        let signature: [u8; 64] = (0..64)
            .map(|i| {
                u8::from_str_radix(&body["evidenceSig"].as_str().unwrap()[i * 2..i * 2 + 2], 16)
                    .unwrap()
            })
            .collect::<Vec<_>>()
            .try_into()
            .unwrap();
        signing
            .verifying_key()
            .verify(
                evidence_message(&key_id, text).as_bytes(),
                &Signature::from_bytes(&signature),
            )
            .expect("signed by the install key over the exact text");
        assert!(evidence_message(&key_id, text).starts_with("strata-arena-evidence|v1|"));
        // Without a key nothing about the evidence is sent.
        let unsigned: Value =
            serde_json::from_slice(&upload_body(&parsed, None, false).unwrap()).unwrap();
        assert!(unsigned.get("evidence").is_none() && unsigned.get("evidenceSig").is_none());
        // Anything outside the evidence schema is refused before it is queued.
        let mut leaky = verified_payload();
        leaky["evidence"]["runs"][0]["output"] = json!("hello");
        assert!(Payload::parse(leaky).is_err());
        let mut prompt = verified_payload();
        prompt["evidence"]["prompt"] = json!("secret");
        assert!(Payload::parse(prompt).is_err());
        let mut texty = verified_payload();
        texty["evidence"]["engine"] = json!("C:/strata");
        assert!(Payload::parse(texty).is_err());
        let mut uneven = verified_payload();
        uneven["evidence"]["series"]["ramGB"] = json!([1.0]);
        assert!(Payload::parse(uneven).is_err());
        let mut util = verified_payload();
        util["evidence"]["series"]["gpuUtil"][3] = json!(400);
        assert!(Payload::parse(util).is_err());
    }

    #[test]
    fn accepts_the_whitelisted_shape_and_round_trips_it() {
        let parsed = Payload::parse(payload()).unwrap();
        let body: Value =
            serde_json::from_slice(&upload_body(&parsed, None, false).unwrap()).unwrap();
        let mut expected = payload();
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
        let mut keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "app",
                "consentVersion",
                "day",
                "hw",
                "kind",
                "model",
                "params",
                "schema",
                "strata",
                "tiers"
            ],
            "no install identifier in the body; the signing key identifies the install"
        );
    }

    #[test]
    fn rejects_extra_fields_paths_hosts_and_bad_shapes() {
        for (pointer, value) in [
            ("/baseUrl", json!("http://127.0.0.1:19001")),
            ("/hw/hostname", json!("DESKTOP-ALICE01")),
            ("/params/apiKey", json!("sk-1")),
            ("/tiers/0/output", json!("hello")),
            ("/installId", json!("f".repeat(64))),
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
    fn install_key_signs_the_same_message_as_the_app_hmac() {
        let path = temp_state();
        let key = create_key(&path, false).unwrap();
        let signing = load_signing_key(&path, &key).unwrap();
        let nonce = "0".repeat(32);
        let headers = signed_headers(
            b"{}",
            1_700_000_000_000,
            &nonce,
            Some("k".repeat(32).as_str()),
            Some((&key.key_id, &signing)),
        );
        let get = |name: &str| {
            headers
                .iter()
                .find(|(n, _)| *n == name)
                .map(|(_, v)| v.clone())
        };
        let message = format!("1700000000000\n{nonce}\n{}", hex(&Sha256::digest(b"{}")));
        assert_eq!(
            get("X-Arena-Sig").unwrap(),
            hex(&hmac_sha256("k".repeat(32).as_bytes(), message.as_bytes()))
        );
        assert_eq!(get("X-Arena-Key").unwrap(), key.key_id);
        let public = VerifyingKey::from_bytes(&unhex32(&key.public_key).unwrap()).unwrap();
        let sig_bytes: Vec<u8> = (0..64)
            .map(|i| {
                u8::from_str_radix(&get("X-Arena-Install-Sig").unwrap()[i * 2..i * 2 + 2], 16)
                    .unwrap()
            })
            .collect();
        let signature = Signature::from_slice(&sig_bytes).unwrap();
        assert!(public.verify(message.as_bytes(), &signature).is_ok());
        assert_eq!(key.key_id, hex(&Sha256::digest(public.to_bytes())));
        // Without an app key (source build) only the install signature is sent.
        let bare = signed_headers(b"{}", 1, &nonce, None, Some((&key.key_id, &signing)));
        assert!(bare.iter().all(|(n, _)| *n != "X-Arena-Sig"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn private_key_file_is_owner_only_verified_and_deleted_on_withdraw() {
        let path = temp_state();
        let key = create_key(&path, false).unwrap();
        assert_eq!(key.store, "file");
        let file = secret_file(&path);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let other = InstallKey {
            public_key: "00".repeat(32),
            ..key.clone()
        };
        assert_eq!(
            load_signing_key(&path, &other).unwrap_err(),
            "arena_key_mismatch"
        );
        let state = ArenaState {
            key: Some(key.clone()),
            consent_version: Some(CONSENT_VERSION),
            ..Default::default()
        };
        save(&path, &state).unwrap();
        let saved = std::fs::read_to_string(&path).unwrap();
        let secret = std::fs::read_to_string(&file).unwrap();
        assert!(
            !saved.contains(&secret),
            "the private key never lands in state.json"
        );
        assert!(
            state.status().to_string().find(&key.key_id).is_none(),
            "status never exposes the key"
        );
        delete_key(&path, false);
        assert!(!file.exists());
        assert_eq!(
            load_signing_key(&path, &key).unwrap_err(),
            "arena_key_missing"
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn proof_of_work_matches_the_server_definition() {
        // Vector computed with services/arena/src/crypto.js (powMessage + leadingZeroBits).
        let challenge = format!("1760680000000.{}.12.{}", "0".repeat(32), "1".repeat(32));
        assert_eq!(solve_pow(&challenge, &"ab".repeat(32), 12), Some(890));
        assert_eq!(leading_zero_bits(&[0, 0, 0x0f, 0xff]), 20);
        assert_eq!(leading_zero_bits(&[0x80]), 0);
        assert_eq!(
            solve_pow(&challenge, &"ab".repeat(32), 33),
            None,
            "refuses absurd difficulty"
        );
    }

    #[test]
    fn registration_and_upload_outcomes() {
        let mut arena = ArenaState {
            consent_version: Some(CONSENT_VERSION),
            auto_upload: true,
            ..Default::default()
        };
        assert!(!apply_registration(
            &mut arena,
            Ok((400, json!({ "error": "challenge_expired" })))
        ));
        assert_eq!(arena.register_attempts, 1);
        assert!(arena.register_next_at > now_ms());
        assert!(apply_registration(&mut arena, Ok((201, json!({})))));
        assert!(arena.registered && arena.register_attempts == 0);

        let item = Payload::parse(payload()).unwrap();
        let push = |arena: &mut ArenaState| {
            arena.queue.push(Queued {
                payload: item.clone(),
                attempts: 0,
                next_at: 0,
            })
        };
        push(&mut arena);
        assert!(apply_upload(
            &mut arena,
            0,
            &item,
            Ok((401, json!({ "error": "unregistered" }))),
            false
        ));
        assert!(
            !arena.registered && arena.queue.len() == 1,
            "re-register, keep the run"
        );
        assert!(!apply_upload(
            &mut arena,
            0,
            &item,
            Ok((503, Value::Null)),
            false
        ));
        assert_eq!(arena.queue[0].attempts, 1);
        assert!(!apply_upload(
            &mut arena,
            0,
            &item,
            Ok((400, json!({ "error": "invalid_hw.cpu" }))),
            false
        ));
        assert!(arena.queue.is_empty());
        push(&mut arena);
        push(&mut arena);
        assert!(apply_upload(
            &mut arena,
            0,
            &item,
            Ok((403, json!({ "error": "banned" }))),
            false
        ));
        assert!(
            arena.banned && arena.queue.is_empty(),
            "a banned key stops uploading entirely"
        );
        let mut fresh = ArenaState::default();
        assert!(!apply_registration(
            &mut fresh,
            Ok((403, json!({ "error": "banned" })))
        ));
        assert!(fresh.banned);
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
        let path = temp_state();
        assert!(!load(&path).consented());
        let mut state = ArenaState {
            key: Some(create_key(&path, false).unwrap()),
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
        assert_eq!(loaded.queue.len(), 1);
        assert_eq!(loaded.log.len(), MAX_LOG);
        let status = loaded.status();
        assert_eq!(status["queued"], 1);
        assert!(status.get("key").is_none() && status.get("installId").is_none());
        let outdated = ArenaState {
            consent_version: Some(0),
            ..loaded
        };
        assert!(!outdated.consented());
        let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }

    /// End-to-end against the deployed service with the real client code: register (proof of work), upload a run
    /// with signed evidence, see it on the public leaderboard right away, withdraw, and confirm it is gone. Needs a
    /// build with STRATA_ARENA_APP_KEY; run with `--ignored`. ARENA_ADMIN_TOKEN (runtime) enables the maintainer checks.
    #[test]
    #[ignore]
    fn live_register_submit_withdraw() {
        assert!(upload_available(), "build with STRATA_ARENA_APP_KEY");
        tauri::async_runtime::block_on(async {
            let path = temp_state();
            let key = create_key(&path, false).unwrap();
            let mut state = ArenaState {
                key: Some(key.clone()),
                consent_version: Some(CONSENT_VERSION),
                auto_upload: true,
                ..Default::default()
            };
            let mut live = verified_payload();
            // A distinctive configuration so the row is unmistakably this test's.
            live["params"]["poolWorkers"] = json!(13);
            state.queue.push(Queued {
                payload: Payload::parse(live).unwrap(),
                attempts: 0,
                next_at: 0,
            });
            save(&path, &state).unwrap();
            let started = std::time::Instant::now();
            let board = || async {
                let lb: Value = client()
                    .get(format!("{}/v1/leaderboard?group=swift:IQ3_S", endpoint()))
                    .send()
                    .await
                    .unwrap()
                    .json()
                    .await
                    .unwrap();
                lb["rows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["params"]["poolWorkers"] == 13 && r["decode"]["median"] == 36.4)
            };
            assert!(!board().await, "no leftover test row");
            assert!(
                ensure_registered(&path, true).await,
                "{:?}",
                load(&path).log
            );
            println!(
                "registration incl. proof of work: {:.2}s",
                started.elapsed().as_secs_f64()
            );
            flush(&path, true).await;
            let after = load(&path);
            assert!(after.queue.is_empty(), "{:?}", after.log);
            assert_eq!(after.log[0].status, "uploaded", "{:?}", after.log);
            assert_eq!(
                after.log[0].detail.as_deref(),
                Some("verified"),
                "{:?}",
                after.log
            );
            assert!(
                board().await,
                "a verified run is on the public leaderboard immediately"
            );
            println!(
                "join time (key + registration + upload + visible on the leaderboard): {:.2}s",
                started.elapsed().as_secs_f64()
            );
            let admin = std::env::var("ARENA_ADMIN_TOKEN").ok();
            if let Some(token) = &admin {
                let detail: Value = client()
                    .get(format!("{}/v1/admin/installs/{}", endpoint(), key.key_id))
                    .bearer_auth(token)
                    .send()
                    .await
                    .unwrap()
                    .json()
                    .await
                    .unwrap();
                println!("server view: {}", detail["install"]);
                assert_eq!(detail["install"]["status"], "verified");
                assert_eq!(detail["submissions"][0]["evidence_status"], "verified");
                assert_eq!(detail["submissions"].as_array().unwrap().len(), 1);
            }
            let withdrawn = withdraw_at(&path, false).await.unwrap();
            assert_eq!(withdrawn["deleted"], 1);
            assert!(
                !board().await,
                "withdrawn runs leave the leaderboard right away"
            );
            assert!(!secret_file(&path).exists());
            if let Some(token) = &admin {
                let status = client()
                    .get(format!("{}/v1/admin/installs/{}", endpoint(), key.key_id))
                    .bearer_auth(token)
                    .send()
                    .await
                    .unwrap()
                    .status();
                assert_eq!(status.as_u16(), 404, "registration deleted");
            }
            let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
        });
    }
}
