//! Strata 0.2+ component engine packages (`strata-engine-<ver>-<platform>-<backend>-<variant>.tar.gz`).
//!
//! From 0.2.0 upstream no longer publishes `strata-windows-x64*.zip`. Engines are listed in a
//! signed feed (`strata-feed.json` + `.sig`, Ed25519 over the exact bytes) and every package
//! carries a signed `engine-component.json` with a SHA-256 per file. Manager checks, in order:
//! the feed signature and fields; GitHub's digest and size equal the feed's; after download the
//! archive SHA-256; after extraction the manifest digest, its signature and every file.
use super::RuntimeReleaseAsset;
use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::Read,
    path::Path,
};

/// Release feed key shipped in upstream `strata_control/update_keys.json` (0.2.0, key id below).
pub const FEED_KEY_ID: &str = "5d1bc23abbeffd0d";
const FEED_PUBLIC_KEY: &str = "KjnXZB0T1r3dmBNot8h+c4rTicRtllg1LH9fUlTw4ZY=";
pub const FEED_NAME: &str = "strata-feed.json";
pub const FEED_SIGNATURE_NAME: &str = "strata-feed.json.sig";
pub const MAX_FEED_BYTES: u64 = 1024 * 1024;
pub const MANIFEST_NAME: &str = "engine-component.json";
const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;
/// Upper bound for one engine archive (the largest 0.2.0 package is 0.85 GB).
pub const MAX_PACKAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Upper bound for an expanded engine (the largest 0.2.0 package expands to 1.7 GB).
pub const MAX_PACKAGE_EXPANDED: u64 = 4 * 1024 * 1024 * 1024;

/// Pre-0.2 engine ZIP names and their Manager variant.
pub fn legacy_variant(name: &str) -> Option<&'static str> {
    match name {
        "strata-windows-x64.zip" => Some("cuda13"),
        "strata-windows-x64-cuda12.zip" => Some("cuda12"),
        "strata-windows-x64-hip.zip" => Some("hip"),
        _ => None,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackageName {
    pub version: String,
    pub platform: &'static str,
    pub backend: String,
    pub variant: String,
}

const PLATFORMS: [&str; 3] = ["windows-x86_64", "linux-x86_64", "macos-arm64"];

fn numeric_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value.split('.').all(|part| {
            !part.is_empty() && part.len() <= 9 && part.bytes().all(|b| b.is_ascii_digit())
        })
}

fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// Parse an upstream component engine file name. Only the exact shape is accepted.
pub fn parse_package_name(name: &str) -> Option<PackageName> {
    let rest = name
        .strip_prefix("strata-engine-")?
        .strip_suffix(".tar.gz")?;
    let (version, rest) = rest.split_once('-')?;
    if !numeric_version(version) {
        return None;
    }
    let platform = PLATFORMS.into_iter().find(|p| {
        rest.strip_prefix(p)
            .is_some_and(|tail| tail.starts_with('-'))
    })?;
    let tail = &rest[platform.len() + 1..];
    let (backend, variant) = match tail.split_once('-') {
        Some((backend, variant)) => (backend, variant),
        None => (tail, ""),
    };
    if !token(backend) || !(variant.is_empty() || token(variant)) {
        return None;
    }
    Some(PackageName {
        version: version.into(),
        platform,
        backend: backend.into(),
        variant: variant.into(),
    })
}

/// Manager's engine variant for an upstream backend/variant pair.
pub fn manager_variant(backend: &str, variant: &str) -> Option<&'static str> {
    Some(match (backend, variant) {
        ("cuda", "cuda13") => "cuda13",
        ("cuda", "cuda12") => "cuda12",
        // RX 9000 / Radeon AI PRO R9700 (gfx1200, gfx1201): the successor of the old HIP ZIP's main target.
        ("hip", "rx9070") => "hip",
        // RX 7000 (gfx1100-1102) and Ryzen AI Max (gfx1151).
        ("hip", "rdna3") => "hip-rdna3",
        ("hip", "rx7900") => "hip-rx7900",
        ("hip", "halo") => "hip-halo",
        // RX 6000 (gfx1030, gfx1031), new in Strata 0.2.2: Linux calls it `rx6000`, Windows
        // `rdna2`. Upstream built both but has not tested them on a real RX 6000 card.
        ("hip", "rx6000") => "hip-rx6000",
        ("hip", "rdna2") => "hip-rdna2",
        ("metal", "") => "metal",
        _ => return None,
    })
}

/// The feed platform of this build, if upstream publishes engines for it.
pub fn host_platform(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("windows", "x86_64") => Some("windows-x86_64"),
        ("linux", "x86_64") => Some("linux-x86_64"),
        ("macos", "aarch64") => Some("macos-arm64"),
        _ => None,
    }
}

/// Manager variant of an asset Manager can install with its release flow (Windows x64 or
/// Linux x86_64). Whether it fits this computer is [`asset_platform`]'s business.
pub fn installable_variant(name: &str) -> Option<&'static str> {
    if let Some(variant) = legacy_variant(name) {
        return Some(variant);
    }
    let package = parse_package_name(name)?;
    let variant = manager_variant(&package.backend, &package.variant)?;
    match package.platform {
        "windows-x86_64" => matches!(
            variant,
            "cuda13" | "cuda12" | "hip" | "hip-rdna3" | "hip-rdna2"
        ),
        "linux-x86_64" => matches!(
            variant,
            "cuda13" | "cuda12" | "hip" | "hip-rx7900" | "hip-halo" | "hip-rx6000"
        ),
        _ => false,
    }
    .then_some(variant)
}

pub fn is_installable_asset_name(name: &str) -> bool {
    installable_variant(name).is_some()
}

/// Feed platform of an installable asset (legacy ZIPs are Windows x64 only).
pub fn asset_platform(name: &str) -> Option<&'static str> {
    if legacy_variant(name).is_some() {
        return Some("windows-x86_64");
    }
    installable_variant(name)?;
    Some(parse_package_name(name)?.platform)
}

/// Platforms whose engines Manager installs from official releases.
pub fn release_install_platform(os: &str, arch: &str) -> Option<&'static str> {
    host_platform(os, arch).filter(|p| matches!(*p, "windows-x86_64" | "linux-x86_64"))
}

/// This build's release install platform, if any.
pub fn this_release_install_platform() -> Option<&'static str> {
    release_install_platform(std::env::consts::OS, std::env::consts::ARCH)
}

/// Whether an asset can be installed by this computer's release flow.
pub fn asset_installable_here(name: &str) -> bool {
    this_release_install_platform().is_some_and(|host| asset_platform(name) == Some(host))
}

/// Accepts a release/package version: numeric dot parts plus an optional SemVer pre-release.
pub fn valid_version(value: &str) -> bool {
    version_key(value).is_some()
}

/// Ordering key: numeric parts, then a release sorts after any pre-release of the same numbers.
pub fn version_key(value: &str) -> Option<(Vec<u32>, bool, String)> {
    let value = value.trim_start_matches('v');
    if value.is_empty() || value.len() > 80 {
        return None;
    }
    let (core, pre) = match value.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (value, None),
    };
    let numbers = core
        .split('.')
        .map(|part| {
            (!part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
                .then(|| part.parse::<u32>().ok())
                .flatten()
        })
        .collect::<Option<Vec<_>>>()?;
    if let Some(pre) = pre {
        if pre.is_empty()
            || !pre
                .split('.')
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
        {
            return None;
        }
    }
    Some((numbers, pre.is_none(), pre.unwrap_or_default().to_owned()))
}

fn decode_key() -> Result<VerifyingKey, String> {
    let bytes: [u8; 32] = base64::engine::general_purpose::STANDARD
        .decode(FEED_PUBLIC_KEY)
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "内置更新公钥长度无效".to_owned())?;
    VerifyingKey::from_bytes(&bytes).map_err(|e| e.to_string())
}

fn verify_signature(signature: &Value, payload: &[u8], what: &str) -> Result<(), String> {
    if signature["alg"].as_str() != Some("ed25519") {
        return Err(format!(
            "{what}签名算法不是 Ed25519 / {what} signature is not Ed25519"
        ));
    }
    if signature["key_id"].as_str() != Some(FEED_KEY_ID) {
        return Err(format!(
            "{what}签名来自未受信任的密钥 / {what} is signed by an untrusted key"
        ));
    }
    let value = signature["value"]
        .as_str()
        .ok_or("签名缺失 / Missing signature")?;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|_| "签名不是有效的 base64 / Signature is not valid base64".to_owned())?;
    let signature = Signature::from_slice(&raw)
        .map_err(|_| "签名长度无效 / Invalid signature length".to_owned())?;
    decode_key()?
        .verify_strict(payload, &signature)
        .map_err(|_| format!("{what}签名校验失败 / {what} signature verification failed"))
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `YYYY-MM-DDTHH:MM:SS(.fff)Z` to Unix milliseconds; anything else fails closed.
fn parse_utc(value: &str) -> Option<u64> {
    let b = value.as_bytes();
    if b.len() < 20
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || !value.ends_with('Z')
    {
        return None;
    }
    let n = |r: std::ops::Range<usize>| value.get(r)?.parse::<i64>().ok();
    let (year, month, day, hour, minute, second) = (
        n(0..4)?,
        n(5..7)?,
        n(8..10)?,
        n(11..13)?,
        n(14..16)?,
        n(17..19)?,
    );
    let fraction = &value[19..value.len() - 1];
    if !(fraction.is_empty()
        || fraction.starts_with('.') && fraction[1..].bytes().all(|b| b.is_ascii_digit()))
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let seconds = days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second;
    u64::try_from(seconds).ok()?.checked_mul(1000)
}

/// Verify the signed feed bytes and its envelope. Returns the parsed feed.
pub fn verify_feed(
    feed: &[u8],
    signature: &[u8],
    previous_sequence: Option<u64>,
    now_ms: u64,
) -> Result<Value, String> {
    if feed.len() as u64 > MAX_FEED_BYTES || signature.len() > 4096 {
        return Err("更新 feed 超过大小上限 / Update feed is too large".into());
    }
    let signature: Value = serde_json::from_slice(signature)
        .map_err(|_| "更新 feed 签名文件无效 / Invalid update feed signature file".to_owned())?;
    verify_signature(&signature, feed, "更新 feed ")?;
    let value: Value = serde_json::from_slice(feed)
        .map_err(|_| "更新 feed 不是有效的 JSON / Update feed is not valid JSON".to_owned())?;
    if value["schema_version"].as_u64() != Some(1)
        || value["feed"].as_str() != Some("strata-updates")
        || value["channel"].as_str() != Some("stable")
    {
        return Err("更新 feed 的版本、名称或渠道不受支持 / Unsupported update feed schema, name or channel".into());
    }
    let sequence = value["sequence"]
        .as_u64()
        .ok_or("更新 feed 缺少序号 / Update feed has no sequence")?;
    if previous_sequence.is_some_and(|previous| sequence < previous) {
        return Err(format!(
            "更新 feed 序号 {sequence} 低于已接受的序号，疑似回放旧 feed / Update feed sequence {sequence} is older than one already accepted"
        ));
    }
    match &value["expires_at"] {
        Value::Null => {}
        Value::String(text) => {
            let expires =
                parse_utc(text).ok_or("更新 feed 过期时间无效 / Invalid update feed expiry")?;
            if expires <= now_ms {
                return Err("更新 feed 已过期 / Update feed has expired".into());
            }
        }
        _ => return Err("更新 feed 过期时间无效 / Invalid update feed expiry".into()),
    }
    Ok(value)
}

fn hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Engine packages for `platform` listed by a verified feed and actually attached to the release.
/// GitHub's own digest and size must equal the signed feed's, so neither source alone decides.
pub fn feed_assets(
    feed: &Value,
    release: &Value,
    tag: &str,
    platform: &str,
) -> Result<Vec<RuntimeReleaseAsset>, String> {
    let attached: BTreeMap<&str, &Value> = release["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| Some((item["name"].as_str()?, item)))
        .collect();
    let mut assets = Vec::new();
    for package in feed["engine"]["packages"].as_array().into_iter().flatten() {
        if package["platform"].as_str() != Some(platform) {
            continue;
        }
        let Some(name) = package["url"].as_str() else {
            continue;
        };
        let Some(parsed) = parse_package_name(name) else {
            continue;
        };
        let (Some(version), Some(backend), Some(variant)) = (
            package["version"].as_str(),
            package["backend"].as_str(),
            package["variant"].as_str(),
        ) else {
            continue;
        };
        if package["format"].as_str() != Some("tar.gz")
            || parsed.platform != platform
            || parsed.version != version
            || parsed.backend != backend
            || parsed.variant != variant
        {
            continue;
        }
        let Some(manager) = manager_variant(backend, variant) else {
            continue;
        };
        let (Some(size), Some(sha256), Some(manifest_sha256), Some(installed_bytes)) = (
            package["size"].as_u64(),
            package["sha256"].as_str(),
            package["manifest_sha256"].as_str(),
            package["installed_bytes"].as_u64(),
        ) else {
            continue;
        };
        if !(1..=MAX_PACKAGE_BYTES).contains(&size)
            || !(1..=MAX_PACKAGE_EXPANDED).contains(&installed_bytes)
            || !hex64(sha256)
            || !hex64(manifest_sha256)
        {
            continue;
        }
        let Some(item) = attached.get(name) else {
            continue;
        };
        let url = format!("https://github.com/Niko1221/Strata/releases/download/{tag}/{name}");
        if item["browser_download_url"].as_str() != Some(url.as_str())
            || item["size"].as_u64() != Some(size)
            || item["digest"]
                .as_str()
                .and_then(|digest| digest.strip_prefix("sha256:"))
                .is_none_or(|digest| !digest.eq_ignore_ascii_case(sha256))
        {
            return Err(format!(
                "Release 资产 {name} 与签名 feed 的长度或 SHA256 不一致 / Release asset {name} disagrees with the signed feed"
            ));
        }
        assets.push(RuntimeReleaseAsset {
            name: name.into(),
            url,
            size,
            sha256: sha256.to_ascii_lowercase(),
            variant: manager.into(),
            engine_version: Some(version.into()),
            manifest_sha256: Some(manifest_sha256.to_ascii_lowercase()),
            installed_bytes: Some(installed_bytes),
            nvidia_min_driver: package["min_driver"]["nvidia"]
                .as_str()
                .filter(|v| {
                    v.len() <= 32
                        && v.split('.')
                            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
                })
                .map(str::to_owned),
            archs: package["archs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|a| a.as_str().map(str::to_owned))
                .take(32)
                .collect(),
            match_reason: None,
        });
    }
    Ok(assets)
}

/// Upstream's signing payload: sorted keys, no spaces, non-ASCII kept (Python
/// `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`). Floats are
/// refused rather than risk a different number spelling.
pub fn canonical_json(value: &Value, out: &mut String) -> Result<(), String> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if n.is_f64() {
                return Err("清单含小数，无法按规范格式校验签名 / Manifest has a float".into());
            }
            out.push_str(&n.to_string());
        }
        Value::String(s) => out.push_str(&serde_json::to_string(s).map_err(|e| e.to_string())?),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                canonical_json(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).map_err(|e| e.to_string())?);
                out.push(':');
                canonical_json(&map[key], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// Check a signed manifest's bytes against the feed and its own signature. Returns its file list.
pub fn verify_manifest_bytes(
    bytes: &[u8],
    asset: &RuntimeReleaseAsset,
    platform: &str,
) -> Result<BTreeMap<String, (String, u64)>, String> {
    let expected = asset
        .manifest_sha256
        .as_deref()
        .ok_or("此引擎包没有签名清单信息 / Package has no signed manifest digest")?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES
        || !format!("{:x}", Sha256::digest(bytes)).eq_ignore_ascii_case(expected)
    {
        return Err(
            "引擎清单与签名 feed 不一致 / Engine manifest does not match the signed feed".into(),
        );
    }
    let manifest: Value = serde_json::from_slice(bytes)
        .map_err(|_| "引擎清单不是有效的 JSON / Engine manifest is not valid JSON".to_owned())?;
    let mut body = manifest.clone();
    let signature = body
        .as_object_mut()
        .and_then(|map| map.remove("signature"))
        .ok_or("引擎清单没有签名 / Engine manifest is unsigned")?;
    let mut payload = String::new();
    canonical_json(&body, &mut payload)?;
    verify_signature(&signature, payload.as_bytes(), "引擎清单")?;
    let parsed = parse_package_name(&asset.name).ok_or("引擎包名称无效 / Invalid package name")?;
    if manifest["id"].as_str() != Some("strata-engine")
        || manifest["schema_version"].as_u64() != Some(2)
        || manifest["platform"].as_str() != Some(platform)
        || manifest["version"].as_str() != asset.engine_version.as_deref()
        || manifest["backend"].as_str() != Some(parsed.backend.as_str())
        || manifest["variant"].as_str().unwrap_or("") != parsed.variant
    {
        return Err("引擎清单的平台、版本或类型与所选包不符 / Engine manifest platform, version or type differs from the package".into());
    }
    let mut files = BTreeMap::new();
    for file in manifest["files"].as_array().ok_or("引擎清单没有文件列表")? {
        let (Some(path), Some(sha256), Some(bytes)) = (
            file["path"].as_str(),
            file["sha256"].as_str(),
            file["bytes"].as_u64(),
        ) else {
            return Err("引擎清单文件项无效 / Invalid manifest file entry".into());
        };
        if !hex64(sha256)
            || path == MANIFEST_NAME
            || files
                .insert(path.to_owned(), (sha256.to_ascii_lowercase(), bytes))
                .is_some()
        {
            return Err(
                "引擎清单文件项无效或重复 / Invalid or duplicate manifest file entry".into(),
            );
        }
    }
    if files.is_empty() {
        return Err("引擎清单没有文件 / Engine manifest lists no files".into());
    }
    Ok(files)
}

/// After a safe extraction: the manifest is genuine and the extracted set is exactly its files.
pub fn verify_extracted(
    root: &Path,
    extracted: &[String],
    asset: &RuntimeReleaseAsset,
    platform: &str,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    let mut manifest = Vec::new();
    File::open(root.join(MANIFEST_NAME))
        .map_err(|_| {
            "引擎包缺少签名清单 engine-component.json / Engine package has no engine-component.json"
                .to_owned()
        })?
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut manifest)
        .map_err(|e| e.to_string())?;
    let files = verify_manifest_bytes(&manifest, asset, platform)?;
    let present: BTreeSet<&str> = extracted
        .iter()
        .map(String::as_str)
        .filter(|name| *name != MANIFEST_NAME)
        .collect();
    let listed: BTreeSet<&str> = files.keys().map(String::as_str).collect();
    if present != listed {
        let extra: Vec<_> = present.difference(&listed).take(3).collect();
        let missing: Vec<_> = listed.difference(&present).take(3).collect();
        return Err(format!(
            "引擎包文件与签名清单不一致（多出 {extra:?}，缺少 {missing:?}）/ Package files differ from the signed manifest"
        ));
    }
    for (path, (sha256, bytes)) in &files {
        check()?;
        let mut file = File::open(root.join(path)).map_err(|e| e.to_string())?;
        let mut digest = Sha256::new();
        let mut buffer = vec![0u8; 1024 * 1024];
        let mut total = 0u64;
        loop {
            let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            total += count as u64;
            digest.update(&buffer[..count]);
        }
        if total != *bytes || format!("{:x}", digest.finalize()) != *sha256 {
            return Err(format!(
                "引擎文件 {path} 与签名清单不一致 / Engine file {path} differs from the signed manifest"
            ));
        }
    }
    Ok(())
}

/// `BUILD.json` key that keeps the package's own `source` after [`mark_hip_engine_for_setup`].
pub const ORIGINAL_SOURCE_KEY: &str = "strata_manager_original_source";

/// Upstream `setup.py` (0.2.x, Windows) only reuses a HIP engine in `engine/` whose
/// `BUILD.json` says `"source": "prebuilt"`; otherwise it downloads the retired
/// `strata-windows-x64-hip.zip` and fails with HTTP 404. The official 0.2+ HIP packages
/// Manager installs say `"source": "f-021-rel"` (#103). For an untouched official
/// Windows HIP package (signed manifest verified, `BUILD.json` equal to its listed
/// digest) this sets `source` to `prebuilt` and keeps the original value under
/// [`ORIGINAL_SOURCE_KEY`]. Anything else is left alone. Returns whether it wrote.
pub fn mark_hip_engine_for_setup(engine: &Path) -> Result<bool, String> {
    let build_path = engine.join("BUILD.json");
    let Ok(build_bytes) = std::fs::read(&build_path) else {
        return Ok(false);
    };
    if build_bytes.len() > 64 * 1024 {
        return Ok(false);
    }
    let Ok(Value::Object(mut build)) = serde_json::from_slice::<Value>(&build_bytes) else {
        return Ok(false);
    };
    let source = build
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if build.get("backend").and_then(Value::as_str) != Some("hip")
        || source == "prebuilt"
        || source.starts_with("local")
        || build.contains_key(ORIGINAL_SOURCE_KEY)
    {
        return Ok(false);
    }
    let mut manifest = Vec::new();
    match File::open(engine.join(MANIFEST_NAME)) {
        Ok(file) => {
            file.take(MAX_MANIFEST_BYTES + 1)
                .read_to_end(&mut manifest)
                .map_err(|e| e.to_string())?;
        }
        Err(_) => return Ok(false),
    }
    if manifest.len() as u64 > MAX_MANIFEST_BYTES {
        return Ok(false);
    }
    let Ok(manifest) = serde_json::from_slice::<Value>(&manifest) else {
        return Ok(false);
    };
    if manifest["id"].as_str() != Some("strata-engine")
        || manifest["platform"].as_str() != Some("windows-x86_64")
        || manifest["backend"].as_str() != Some("hip")
    {
        return Ok(false);
    }
    let mut body = manifest.clone();
    let Some(signature) = body.as_object_mut().and_then(|map| map.remove("signature")) else {
        return Ok(false);
    };
    let mut payload = String::new();
    canonical_json(&body, &mut payload)?;
    if verify_signature(&signature, payload.as_bytes(), "引擎清单").is_err() {
        return Ok(false);
    }
    let listed = manifest["files"].as_array().and_then(|files| {
        files
            .iter()
            .find(|file| file["path"].as_str() == Some("BUILD.json"))
    });
    let digest = format!("{:x}", Sha256::digest(&build_bytes));
    if !listed.is_some_and(|file| {
        file["sha256"]
            .as_str()
            .is_some_and(|sha| sha.eq_ignore_ascii_case(&digest))
            && file["bytes"].as_u64() == Some(build_bytes.len() as u64)
    }) {
        return Ok(false);
    }
    build.insert(ORIGINAL_SOURCE_KEY.into(), Value::String(source));
    build.insert("source".into(), Value::String("prebuilt".into()));
    let text = serde_json::to_vec_pretty(&Value::Object(build)).map_err(|e| e.to_string())?;
    let temporary = engine.join("BUILD.json.strata-manager.tmp");
    std::fs::write(&temporary, text).map_err(|e| e.to_string())?;
    if let Err(error) = std::fs::rename(&temporary, &build_path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FEED: &[u8] = include_bytes!("fixtures/strata-feed.json");
    const FEED_SIG: &[u8] = include_bytes!("fixtures/strata-feed.json.sig");
    const RELEASE: &str = include_str!("fixtures/release-v0.2.0-beta.json");
    const CUDA13_MANIFEST: &[u8] = include_bytes!("fixtures/manifest-windows-cuda13.json");
    const NOW: u64 = 1_792_400_000_000;
    /// The real v0.2.1 Windows HIP RX 9070 package: its signed manifest and `BUILD.json` (#103).
    const HIP_MANIFEST: &[u8] = include_bytes!("fixtures/manifest-windows-hip-rx9070.json");
    const HIP_BUILD: &[u8] = include_bytes!("fixtures/build-windows-hip-rx9070.json");

    #[test]
    fn official_windows_hip_engine_is_marked_prebuilt_for_setup_once() {
        let temp = tempfile::tempdir().unwrap();
        let engine = temp.path();
        std::fs::write(engine.join(MANIFEST_NAME), HIP_MANIFEST).unwrap();
        std::fs::write(engine.join("BUILD.json"), HIP_BUILD).unwrap();
        assert!(mark_hip_engine_for_setup(engine).unwrap());
        let build: Value =
            serde_json::from_slice(&std::fs::read(engine.join("BUILD.json")).unwrap()).unwrap();
        assert_eq!(build["source"], "prebuilt");
        assert_eq!(build[ORIGINAL_SOURCE_KEY], "f-021-rel");
        // Everything setup.py checks besides `source` is unchanged.
        let original: Value = serde_json::from_slice(HIP_BUILD).unwrap();
        for key in [
            "backend",
            "version",
            "archs",
            "lib_dirs",
            "vision_gpu",
            "commit",
        ] {
            assert_eq!(build[key], original[key], "{key}");
        }
        // Already marked: nothing more to write.
        assert!(!mark_hip_engine_for_setup(engine).unwrap());
        assert!(!engine.join("BUILD.json.strata-manager.tmp").exists());
    }

    #[test]
    fn hip_marking_leaves_other_engines_alone() {
        let temp = tempfile::tempdir().unwrap();
        let engine = temp.path();
        // No engine at all.
        assert!(!mark_hip_engine_for_setup(engine).unwrap());
        // A BUILD.json edited by hand no longer matches the signed digest.
        std::fs::write(engine.join(MANIFEST_NAME), HIP_MANIFEST).unwrap();
        let edited = String::from_utf8(HIP_BUILD.to_vec())
            .unwrap()
            .replace("gfx1200", "gfx1100");
        std::fs::write(engine.join("BUILD.json"), &edited).unwrap();
        assert!(!mark_hip_engine_for_setup(engine).unwrap());
        assert_eq!(
            std::fs::read_to_string(engine.join("BUILD.json")).unwrap(),
            edited
        );
        // A tampered manifest fails its signature.
        std::fs::write(engine.join("BUILD.json"), HIP_BUILD).unwrap();
        let tampered = String::from_utf8(HIP_MANIFEST.to_vec())
            .unwrap()
            .replace("gfx1201", "gfx1100");
        std::fs::write(engine.join(MANIFEST_NAME), tampered).unwrap();
        assert!(!mark_hip_engine_for_setup(engine).unwrap());
        // A CUDA package and a local HIP build are not touched.
        std::fs::write(engine.join(MANIFEST_NAME), CUDA13_MANIFEST).unwrap();
        std::fs::write(
            engine.join("BUILD.json"),
            br#"{"version":"0.1.45.3","cuda":"13.0"}"#,
        )
        .unwrap();
        assert!(!mark_hip_engine_for_setup(engine).unwrap());
        std::fs::write(
            engine.join("BUILD.json"),
            br#"{"source":"local-hip","backend":"hip","version":"0.1.46"}"#,
        )
        .unwrap();
        assert!(!mark_hip_engine_for_setup(engine).unwrap());
    }

    #[test]
    fn package_names_parse_exactly_and_map_to_manager_variants() {
        let cases = [
            (
                "strata-engine-0.1.45.3-windows-x86_64-cuda-cuda13.tar.gz",
                Some("cuda13"),
            ),
            (
                "strata-engine-0.1.45.3-windows-x86_64-cuda-cuda12.tar.gz",
                Some("cuda12"),
            ),
            (
                "strata-engine-0.1.45.3-windows-x86_64-hip-rx9070.tar.gz",
                Some("hip"),
            ),
            (
                "strata-engine-0.1.45.3-windows-x86_64-hip-rdna3.tar.gz",
                Some("hip-rdna3"),
            ),
            (
                "strata-engine-0.1.45.3-linux-x86_64-hip-halo.tar.gz",
                Some("hip-halo"),
            ),
            (
                "strata-engine-0.1.45.3-linux-x86_64-hip-rx7900.tar.gz",
                Some("hip-rx7900"),
            ),
            (
                "strata-engine-0.1.45.3-linux-x86_64-hip-rx9070.tar.gz",
                Some("hip"),
            ),
            (
                "strata-engine-0.1.45.3-linux-x86_64-cuda-cuda13.tar.gz",
                Some("cuda13"),
            ),
            (
                "strata-engine-0.1.45.3-linux-x86_64-cuda-cuda12.tar.gz",
                Some("cuda12"),
            ),
            // Linux has no RDNA3 bundle and Windows no separate Halo package.
            ("strata-engine-0.1.45.3-linux-x86_64-hip-rdna3.tar.gz", None),
            (
                "strata-engine-0.1.45.3-windows-x86_64-hip-halo.tar.gz",
                None,
            ),
            ("strata-engine-0.1.45.3-macos-arm64-metal.tar.gz", None),
            ("strata-windows-x64.zip", Some("cuda13")),
            ("strata-windows-x64-hip.zip", Some("hip")),
            (
                "strata-engine-0.1.45.3-windows-x86_64-cuda-cuda13.zip",
                None,
            ),
            ("strata-engine-x-windows-x86_64-cuda-cuda13.tar.gz", None),
            (
                "strata-engine-0.1.45.3-windows-x86_64-cuda-../x.tar.gz",
                None,
            ),
            ("strata-control-0.1.45.3-windows-x86_64.zip", None),
        ];
        for (name, expected) in cases {
            assert_eq!(installable_variant(name), expected, "{name}");
        }
        let halo =
            parse_package_name("strata-engine-0.1.45.3-linux-x86_64-hip-halo.tar.gz").unwrap();
        assert_eq!(
            (halo.platform, halo.backend.as_str(), halo.variant.as_str()),
            ("linux-x86_64", "hip", "halo")
        );
        let metal = parse_package_name("strata-engine-0.1.45.3-macos-arm64-metal.tar.gz").unwrap();
        assert_eq!(
            manager_variant(&metal.backend, &metal.variant),
            Some("metal")
        );
    }

    #[test]
    fn versions_accept_semver_prerelease_and_order_it_before_the_release() {
        assert!(
            valid_version("0.2.0-beta")
                && valid_version("v0.1.45.3")
                && valid_version("0.2.0-rc.1")
        );
        for bad in ["", "0.2.0-", "0..1", "0.2.0-beta!", "x.1", "0.2.0-be ta"] {
            assert!(!valid_version(bad), "{bad}");
        }
        assert!(version_key("0.2.0-beta") > version_key("0.1.45.3"));
        assert!(version_key("0.2.0") > version_key("0.2.0-beta"));
        assert!(version_key("0.2.0-rc") > version_key("0.2.0-beta"));
    }

    #[test]
    fn the_real_0_2_0_feed_verifies_and_lists_four_windows_packages() {
        let feed = verify_feed(FEED, FEED_SIG, None, NOW).unwrap();
        let release: Value = serde_json::from_str(RELEASE).unwrap();
        let assets = feed_assets(&feed, &release, "v0.2.0-beta", "windows-x86_64").unwrap();
        let variants: Vec<_> = assets.iter().map(|a| a.variant.as_str()).collect();
        assert_eq!(variants, ["cuda12", "cuda13", "hip-rdna3", "hip"]);
        for asset in &assets {
            assert_eq!(asset.engine_version.as_deref(), Some("0.1.45.3"));
            assert!(asset.url.starts_with("https://github.com/Niko1221/Strata/releases/download/v0.2.0-beta/strata-engine-0.1.45.3-windows-x86_64-"));
            assert!(installable_variant(&asset.name).is_some());
        }
        let linux = feed_assets(&feed, &release, "v0.2.0-beta", "linux-x86_64").unwrap();
        let variants: Vec<_> = linux.iter().map(|a| a.variant.as_str()).collect();
        assert_eq!(
            variants,
            ["cuda12", "cuda13", "hip-halo", "hip-rx7900", "hip"]
        );
        for asset in &linux {
            assert_eq!(asset_platform(&asset.name), Some("linux-x86_64"));
            assert_eq!(
                installable_variant(&asset.name),
                Some(asset.variant.as_str())
            );
        }
        let driver = |v: &str| {
            linux
                .iter()
                .find(|a| a.variant == v)
                .unwrap()
                .nvidia_min_driver
                .clone()
        };
        assert_eq!(driver("cuda13").as_deref(), Some("580.65"));
        assert_eq!(driver("cuda12").as_deref(), Some("575.51"));
        assert_eq!(driver("hip-halo"), None);
        assert_eq!(
            release_install_platform("linux", "x86_64"),
            Some("linux-x86_64")
        );
        assert_eq!(release_install_platform("macos", "aarch64"), None);
        assert_eq!(release_install_platform("linux", "aarch64"), None);
        assert_eq!(
            asset_platform("strata-windows-x64.zip"),
            Some("windows-x86_64")
        );
    }

    #[test]
    fn tampered_replayed_or_expired_feeds_fail_closed() {
        let mut tampered = FEED.to_vec();
        let at = tampered.iter().position(|b| *b == b'1').unwrap();
        tampered[at] = b'2';
        assert!(verify_feed(&tampered, FEED_SIG, None, NOW)
            .unwrap_err()
            .contains("签名校验失败"));
        assert!(verify_feed(FEED, FEED_SIG, Some(102), NOW)
            .unwrap_err()
            .contains("序号"));
        assert!(verify_feed(FEED, FEED_SIG, Some(101), NOW).is_ok());
        let wrong_key = br#"{"alg":"ed25519","key_id":"0000000000000000","value":"AA=="}"#;
        assert!(verify_feed(FEED, wrong_key, None, NOW)
            .unwrap_err()
            .contains("未受信任"));
        assert_eq!(parse_utc("1970-01-02T00:00:00Z"), Some(86_400_000));
        assert_eq!(
            parse_utc("2026-10-19T17:00:56.123Z"),
            Some(1_792_429_256_000)
        );
        assert_eq!(parse_utc("2026-10-19 17:00:56"), None);
    }

    #[test]
    fn release_assets_must_agree_with_the_signed_feed() {
        let feed = verify_feed(FEED, FEED_SIG, None, NOW).unwrap();
        let mut release: Value = serde_json::from_str(RELEASE).unwrap();
        for item in release["assets"].as_array_mut().unwrap() {
            if item["name"] == "strata-engine-0.1.45.3-windows-x86_64-cuda-cuda13.tar.gz" {
                item["size"] = json!(1);
            }
        }
        assert!(
            feed_assets(&feed, &release, "v0.2.0-beta", "windows-x86_64")
                .unwrap_err()
                .contains("不一致")
        );
        // A package the release does not actually carry is not offered.
        let mut release: Value = serde_json::from_str(RELEASE).unwrap();
        release["assets"]
            .as_array_mut()
            .unwrap()
            .retain(|a| a["name"] != "strata-engine-0.1.45.3-windows-x86_64-hip-rdna3.tar.gz");
        let assets = feed_assets(&feed, &release, "v0.2.0-beta", "windows-x86_64").unwrap();
        assert!(assets.iter().all(|a| a.variant != "hip-rdna3"));
    }

    fn cuda13_asset() -> RuntimeReleaseAsset {
        let feed = verify_feed(FEED, FEED_SIG, None, NOW).unwrap();
        let release: Value = serde_json::from_str(RELEASE).unwrap();
        feed_assets(&feed, &release, "v0.2.0-beta", "windows-x86_64")
            .unwrap()
            .into_iter()
            .find(|a| a.variant == "cuda13")
            .unwrap()
    }

    #[test]
    fn the_real_engine_manifest_signature_matches_upstream_canonical_json() {
        let files =
            verify_manifest_bytes(CUDA13_MANIFEST, &cuda13_asset(), "windows-x86_64").unwrap();
        assert_eq!(files.len(), 6);
        assert!(files.contains_key("strata.exe") && files.contains_key("cublasLt64_13.dll"));
        assert!(verify_manifest_bytes(CUDA13_MANIFEST, &cuda13_asset(), "linux-x86_64").is_err());
        // Re-serialised bytes no longer match the digest the feed signed.
        let reformatted =
            serde_json::to_vec(&serde_json::from_slice::<Value>(CUDA13_MANIFEST).unwrap()).unwrap();
        assert!(verify_manifest_bytes(&reformatted, &cuda13_asset(), "windows-x86_64").is_err());
    }

    #[test]
    fn a_forged_manifest_with_the_right_digest_slot_is_still_rejected() {
        let mut manifest: Value = serde_json::from_slice(CUDA13_MANIFEST).unwrap();
        manifest["files"][0]["sha256"] = json!("0".repeat(64));
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let mut asset = cuda13_asset();
        asset.manifest_sha256 = Some(format!("{:x}", Sha256::digest(&bytes)));
        assert!(verify_manifest_bytes(&bytes, &asset, "windows-x86_64")
            .unwrap_err()
            .contains("签名校验失败"));
    }

    #[test]
    fn canonical_json_matches_python_for_unicode_and_escapes() {
        let mut out = String::new();
        canonical_json(
            &json!({"b": [1, "é\n\"x\""], "a": {"z": null, "y": true}}),
            &mut out,
        )
        .unwrap();
        assert_eq!(
            out,
            "{\"a\":{\"y\":true,\"z\":null},\"b\":[1,\"é\\n\\\"x\\\"\"]}"
        );
        assert!(canonical_json(&json!({"a": 1.5}), &mut String::new()).is_err());
    }

    #[test]
    fn extracted_files_must_equal_the_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let asset = cuda13_asset();
        std::fs::write(temp.path().join(MANIFEST_NAME), CUDA13_MANIFEST).unwrap();
        let none = || Ok(());
        let error = verify_extracted(
            temp.path(),
            &[MANIFEST_NAME.into(), "strata.exe".into()],
            &asset,
            "windows-x86_64",
            &none,
        )
        .unwrap_err();
        assert!(error.contains("不一致"), "{error}");
    }
}
