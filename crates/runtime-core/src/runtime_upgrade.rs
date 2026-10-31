//! Release ZIP updates preserve user data and journal every replaced runtime file.
//! The legacy reviewed source installer remains available as a fallback.
use crate::{http, installation, maintenance, processes, storage, types::*, RuntimeState};
use futures_util::StreamExt;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{atomic::Ordering, Arc, Mutex},
    time::{Duration, Instant},
};

pub const VERSION: &str = "0.1.41";
pub mod download_route;
pub mod dsv41_engine;
pub mod engine_package;
pub mod github_source;
pub mod gpu_select;
pub mod installed_runtimes;
mod release_versions;
mod release_zip;
mod runtime_switch;
pub use release_versions::{RuntimeReleaseVersion, RuntimeReleaseVersions};
pub use release_zip::{
    resolve_release_download_asset, resolve_release_download_asset_for, start_install_release,
    start_install_release_with_archives, start_release, start_release_request,
    start_release_request_with_download, test_release_download, RuntimeZipDownloadCheckResult,
    RuntimeZipDownloadOptions,
};
const SERVER_SHA256: &str = "017efa1f4e76d72396738555d13eb1f9898d1c1c12730cf046d9b267b29987e5";
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS runtime_upgrades(task_id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,journal TEXT NOT NULL,updated_at INTEGER NOT NULL);";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeReleaseAsset {
    pub name: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
    pub variant: String,
    /// Engine version of a Strata 0.2+ component package; legacy ZIPs share the release version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_version: Option<String>,
    /// SHA-256 of the package's signed `engine-component.json`, from the signed feed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub archs: Vec<String>,
    /// Oldest NVIDIA driver the package supports (signed feed `min_driver.nvidia`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nvidia_min_driver: Option<String>,
    /// Why automatic matching chose this package (only on a resolve result, never cached).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_reason: Option<String>,
}

/// Official release metadata and SHA256-published engine ZIPs. Checking never
/// runs upstream scripts or changes an installation.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeUpdateInfo {
    pub checked_at: u64,
    pub supported_version: String,
    pub supported_revision: String,
    pub latest_version: Option<String>,
    pub release_name: Option<String>,
    pub release_url: Option<String>,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    #[serde(default)]
    pub assets: Vec<RuntimeReleaseAsset>,
    #[serde(default)]
    pub source_revision: Option<String>,
    #[serde(default)]
    pub source_archive_url: Option<String>,
    pub update_available: bool,
    pub installable: bool,
    pub error: Option<String>,
    /// Highest signed feed sequence accepted, so an older feed cannot be replayed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feed_sequence: Option<u64>,
    /// The signed feed's DeepSeek-V4.1 engine packages for this platform (feed member
    /// `dsv41`). Never part of `assets`, so engine updates cannot select one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dsv41_assets: Vec<RuntimeReleaseAsset>,
}

const UPDATE_INFO_KEY: &str = "strataUpstreamUpdateInfo";
/// Opt-in: after a Strata update, gate the switch on a model load and a short
/// request. Off by default; the default quick check only verifies `/health`.
pub const FULL_VERIFICATION_KEY: &str = "runtimeUpgradeFullVerification";

/// How a switched runtime is accepted before the update commits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Verification {
    /// `/health` only; a previously loaded model is reloaded in the background.
    Quick,
    /// Model load and a short streamed request gate the commit.
    Full,
}

pub(crate) fn verification_mode(state: &RuntimeState) -> Verification {
    match crate::store_get(state, FULL_VERIFICATION_KEY.into()) {
        Ok(Value::Bool(true)) => Verification::Full,
        _ => Verification::Quick,
    }
}
const UPDATE_CHECK_INTERVAL: u64 = 12 * 60 * 60 * 1000;
const INSTALLATION_METADATA_MAX_AGE: u64 = 10 * 60 * 1000;

/// Windows x64 installs legacy ZIPs and Windows packages; Linux x86_64 its own 0.2+ packages.
fn zip_installable(assets: &[RuntimeReleaseAsset], os: &str, arch: &str) -> bool {
    let Some(host) = engine_package::release_install_platform(os, arch) else {
        return false;
    };
    assets
        .iter()
        .any(|asset| engine_package::asset_platform(&asset.name) == Some(host))
}

fn constrain_installable(mut info: RuntimeUpdateInfo) -> RuntimeUpdateInfo {
    // Cached metadata may have been collected on another platform. Release
    // discovery remains available everywhere; installability is local.
    info.installable &= zip_installable(&info.assets, std::env::consts::OS, std::env::consts::ARCH);
    info
}

fn release_update_info(release: &Value) -> Result<RuntimeUpdateInfo, String> {
    let version = release["tag_name"]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 80)
        .ok_or("上游发布信息缺少版本号")?
        .trim_start_matches('v')
        .to_string();
    if !engine_package::valid_version(&version) {
        return Err("上游版本号格式无法识别；未改变本机运行环境".into());
    }
    let release_url = release["html_url"].as_str().and_then(|value| {
        value
            .starts_with("https://github.com/Niko1221/Strata/releases/")
            .then(|| value.to_owned())
    });
    let tag = release["tag_name"].as_str().ok_or("上游版本标记缺失")?;
    let assets = release["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let name = item["name"].as_str()?;
            let variant = engine_package::legacy_variant(name)?;
            let url = item["browser_download_url"].as_str()?;
            if url != format!("https://github.com/Niko1221/Strata/releases/download/{tag}/{name}") {
                return None;
            }
            let size = item["size"]
                .as_u64()
                .filter(|size| *size > 0 && *size <= 1024 * 1024 * 1024)?;
            let digest = item["digest"].as_str()?.strip_prefix("sha256:")?;
            if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            Some(RuntimeReleaseAsset {
                name: name.into(),
                url: url.into(),
                size,
                sha256: digest.to_ascii_lowercase(),
                variant: variant.into(),
                ..Default::default()
            })
        })
        .collect::<Vec<_>>();
    let newer = newer_than_supported(&version);
    Ok(RuntimeUpdateInfo {
        checked_at: now(),
        supported_version: VERSION.into(),
        supported_revision: installation::SOURCE_REVISION.into(),
        latest_version: Some(version),
        release_name: release["name"]
            .as_str()
            .map(|value| value.chars().take(500).collect()),
        release_url,
        notes: release["body"]
            .as_str()
            .map(|value| value.chars().take(100_000).collect()),
        published_at: release["published_at"].as_str().map(str::to_owned),
        installable: zip_installable(&assets, std::env::consts::OS, std::env::consts::ARCH),
        assets,
        dsv41_assets: Vec::new(),
        source_revision: None,
        source_archive_url: None,
        update_available: newer,
        error: None,
        feed_sequence: None,
    })
}

/// Every published release (cached), for installing a chosen version.
pub async fn release_versions(
    state: &RuntimeState,
    force: bool,
) -> Result<RuntimeReleaseVersions, String> {
    release_versions::list(state, force).await
}

/// One chosen release, verified like the latest (read-only; nothing is cached or installed).
pub async fn release_info_for_version(version: &str) -> Result<RuntimeUpdateInfo, String> {
    release_versions::release_info(version).await
}

pub async fn update_info(state: &RuntimeState, force: bool) -> Result<RuntimeUpdateInfo, String> {
    github_source::sync(state);
    let cached = crate::store_get(state, UPDATE_INFO_KEY.into())?;
    let info = update_info_with_cache(cached, force).await?;
    crate::store_set(
        state,
        UPDATE_INFO_KEY.into(),
        serde_json::to_value(&info).map_err(|error| error.to_string())?,
    )?;
    Ok(info)
}

/// Reuse the release the user just checked, without spending another GitHub
/// request during installation. The display cache's longer interval is not
/// sufficient here; only recent, successful, normalized metadata is accepted.
async fn update_info_for_installation(state: &RuntimeState) -> Result<RuntimeUpdateInfo, String> {
    let cached = crate::store_get(state, UPDATE_INFO_KEY.into())?;
    if let Some(info) = cached_installation_metadata(cached, now()) {
        return Ok(info);
    }
    update_info(state, true).await
}

fn cached_installation_metadata(cached: Value, checked_now: u64) -> Option<RuntimeUpdateInfo> {
    let info = constrain_installable(serde_json::from_value::<RuntimeUpdateInfo>(cached).ok()?);
    if info.error.is_some()
        || !info.installable
        || info.supported_version != VERSION
        || info.supported_revision != installation::SOURCE_REVISION
        || checked_now
            .checked_sub(info.checked_at)
            .is_none_or(|age| age > INSTALLATION_METADATA_MAX_AGE)
    {
        return None;
    }
    let version = info.latest_version.as_deref()?;
    if !engine_package::valid_version(version) {
        return None;
    }
    let revision = info
        .source_revision
        .as_deref()
        .filter(|r| valid_revision(r))?;
    if info.source_archive_url.as_deref()
        != Some(format!("https://codeload.github.com/Niko1221/Strata/zip/{revision}").as_str())
        || !info.assets.iter().all(|asset| {
            let Some(variant) = engine_package::installable_variant(&asset.name) else {
                return false;
            };
            let limit = if engine_package::legacy_variant(&asset.name).is_some() {
                1024 * 1024 * 1024
            } else {
                engine_package::MAX_PACKAGE_BYTES
            };
            let package_fields = engine_package::legacy_variant(&asset.name).is_some()
                || asset.engine_version.as_deref().is_some_and(|v| {
                    engine_package::parse_package_name(&asset.name)
                        .is_some_and(|parsed| parsed.version == v)
                }) && asset.manifest_sha256.as_deref().is_some_and(|sha| {
                    sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit())
                });
            asset.variant == variant
                && package_fields
                && (1..=limit).contains(&asset.size)
                && asset.sha256.len() == 64
                && asset.sha256.bytes().all(|b| b.is_ascii_hexdigit())
                && asset.sha256 == asset.sha256.to_ascii_lowercase()
                && [format!("v{version}"), version.to_owned()]
                    .into_iter()
                    .any(|tag| {
                        asset.url
                            == format!(
                                "https://github.com/Niko1221/Strata/releases/download/{tag}/{}",
                                asset.name
                            )
                    })
        })
    {
        return None;
    }
    Some(info)
}

/// Check official metadata without opening runtime state or executing recovery.
/// Desktop compatibility code can keep an older, active supervisor in place and
/// persist only this result through that supervisor's existing store RPCs.
pub async fn update_info_with_cache(
    cached: Value,
    force: bool,
) -> Result<RuntimeUpdateInfo, String> {
    if let Ok(info) = serde_json::from_value::<RuntimeUpdateInfo>(cached.clone()) {
        let interval = if info.error.is_some() {
            10 * 60 * 1000
        } else {
            UPDATE_CHECK_INTERVAL
        };
        if !force
            && info.supported_version == VERSION
            && info.supported_revision == installation::SOURCE_REVISION
            && info.source_revision.is_some()
            && now().saturating_sub(info.checked_at) < interval
        {
            return Ok(constrain_installable(info));
        }
    }
    let previous_sequence = cached["feedSequence"].as_u64();
    let response = fetch_release_info(
        "https://api.github.com/repos/Niko1221/Strata/releases/latest",
        previous_sequence,
        None,
    )
    .await;
    let info = constrain_installable(match response {
        Ok(info) => info,
        Err(error) => {
            let mut info =
                serde_json::from_value::<RuntimeUpdateInfo>(cached).unwrap_or(RuntimeUpdateInfo {
                    checked_at: now(),
                    supported_version: VERSION.into(),
                    supported_revision: installation::SOURCE_REVISION.into(),
                    latest_version: None,
                    release_name: None,
                    release_url: None,
                    notes: None,
                    published_at: None,
                    assets: Vec::new(),
                    dsv41_assets: Vec::new(),
                    source_revision: None,
                    source_archive_url: None,
                    update_available: false,
                    installable: false,
                    error: None,
                    feed_sequence: None,
                });
            info.checked_at = now();
            info.error = Some(error);
            info.installable = false;
            info
        }
    });
    Ok(info)
}

/// Read one release (latest, or a tag) with its verified feed and source commit.
/// `expected_version` pins both the release tag and the signed feed's app version.
async fn fetch_release_info(
    release_api: &str,
    previous_sequence: Option<u64>,
    expected_version: Option<&str>,
) -> Result<RuntimeUpdateInfo, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Strata-Manager-runtime-updates")
        .build()
        .map_err(|error| error.to_string())?;
    let (release, via) = github_source::get_json(&client, release_api, "上游更新信息").await?;
    let mut info = release_update_info(&release)?;
    if expected_version.is_some_and(|expected| info.latest_version.as_deref() != Some(expected)) {
        return Err(
            "上游发布的版本号与所选版本不一致 / The release does not match the chosen version"
                .into(),
        );
    }
    let tag = release["tag_name"].as_str().ok_or("发布标记缺失")?;
    match release_feed_assets(&release, tag, previous_sequence, expected_version).await {
        Ok(Some((sequence, assets, dsv41))) => {
            info.feed_sequence = Some(sequence.max(previous_sequence.unwrap_or(0)));
            info.assets.extend(assets);
            info.dsv41_assets = dsv41;
        }
        Ok(None) => {}
        // A legacy release stays installable without a feed; a feed-only one must verify.
        Err(error) if info.assets.is_empty() => return Err(error),
        Err(_) => {}
    }
    if via == github_source::Via::Mirror {
        trust_legacy_assets_from_github(&client, release_api, &mut info).await;
    }
    info.installable = zip_installable(&info.assets, std::env::consts::OS, std::env::consts::ARCH);
    if info.assets.is_empty() && info.update_available {
        info.error = Some("此上游版本没有 Manager 可在本平台安装的引擎包；已安装的运行时不受影响 / This upstream release has no engine package Manager can install on this platform; existing runtimes are unaffected".into());
    }
    let (mut reference, _) = github_source::get_json(
        &client,
        &format!("https://api.github.com/repos/Niko1221/Strata/git/ref/tags/{tag}"),
        "发布标记",
    )
    .await?;
    if reference["object"]["type"] == "tag" {
        let sha = reference["object"]["sha"]
            .as_str()
            .filter(|s| valid_revision(s))
            .ok_or("源码标记SHA无效")?;
        reference = github_source::get_json(
            &client,
            &format!("https://api.github.com/repos/Niko1221/Strata/git/tags/{sha}"),
            "发布标记",
        )
        .await?
        .0;
    }
    let revision = reference["object"]["sha"]
        .as_str()
        .filter(|s| valid_revision(s))
        .ok_or("无法核验同版本源码提交")?;
    if reference["object"]["type"] != "commit" {
        return Err("发布标记未指向源码提交".into());
    }
    info.source_revision = Some(revision.into());
    info.source_archive_url = Some(format!(
        "https://codeload.github.com/Niko1221/Strata/zip/{revision}"
    ));
    Ok(info)
}

/// Fetch and verify `strata-feed.json` (+ `.sig`) when the release carries one.
/// Engine packages from the signed feed are verified whatever served the release JSON.
/// Older releases without a feed take their SHA-256 from the release JSON itself, so a
/// mirrored copy is not trusted for them: those digests are re-read from GitHub, and
/// without GitHub the release is shown but not installable.
async fn trust_legacy_assets_from_github(
    client: &reqwest::Client,
    release_api: &str,
    info: &mut RuntimeUpdateInfo,
) {
    let legacy =
        |asset: &RuntimeReleaseAsset| engine_package::legacy_variant(&asset.name).is_some();
    if !info.assets.iter().any(legacy) {
        return;
    }
    let official = async {
        let release: Value = client
            .get(release_api)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?
            .json()
            .await
            .ok()?;
        release_update_info(&release).ok()
    }
    .await;
    let official: Vec<RuntimeReleaseAsset> = official
        .map(|official| official.assets.into_iter().filter(legacy).collect())
        .unwrap_or_default();
    info.assets.retain(|asset| !legacy(asset));
    if official.is_empty() {
        info.error.get_or_insert_with(|| {
            "此版本的引擎包摘要只能从 GitHub 核验，暂时无法连接 GitHub；请稍后重试或在设置中切换下载来源".into()
        });
    }
    info.assets.extend(official);
}

/// Feed sequence, engine packages and DeepSeek-V4.1 engine packages of one release.
type FeedAssets = (u64, Vec<RuntimeReleaseAsset>, Vec<RuntimeReleaseAsset>);

async fn release_feed_assets(
    release: &Value,
    tag: &str,
    previous_sequence: Option<u64>,
    expected_version: Option<&str>,
) -> Result<Option<FeedAssets>, String> {
    let url_for = |name: &str| {
        release["assets"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|item| item["name"].as_str() == Some(name))
            .and_then(|item| item["browser_download_url"].as_str())
            .filter(|url| {
                *url == format!("https://github.com/Niko1221/Strata/releases/download/{tag}/{name}")
            })
            .map(str::to_owned)
    };
    let (Some(feed_url), Some(signature_url)) = (
        url_for(engine_package::FEED_NAME),
        url_for(engine_package::FEED_SIGNATURE_NAME),
    ) else {
        return Ok(None);
    };
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .user_agent("Strata-Manager-runtime-updates")
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("release redirect limit exceeded");
            }
            if attempt.url().scheme() == "https"
                && matches!(
                    attempt.url().host_str(),
                    Some(
                        "github.com"
                            | "release-assets.githubusercontent.com"
                            | "objects.githubusercontent.com"
                            | github_source::MIRROR_HOST
                    )
                )
            {
                attempt.follow()
            } else {
                attempt.error("release redirect origin refused")
            }
        }))
        .build()
        .map_err(|error| error.to_string())?;
    let fetch = |url: String| {
        let client = client.clone();
        async move {
            let response = client.get(&url).send().await.map_err(|error| {
                format!(
                    "无法下载签名更新清单：{}",
                    github_source::reason(None, "", Some(&error))
                )
            })?;
            if !response.status().is_success() {
                return Err(format!(
                    "无法下载签名更新清单：{}",
                    github_source::reason(Some(response.status().as_u16()), "", None)
                ));
            }
            if response
                .content_length()
                .is_some_and(|n| n > engine_package::MAX_FEED_BYTES)
            {
                return Err("更新 feed 超过大小上限 / Update feed is too large".to_owned());
            }
            let mut bytes = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|error| error.to_string())?;
                if bytes.len() as u64 + chunk.len() as u64 > engine_package::MAX_FEED_BYTES {
                    return Err("更新 feed 超过大小上限 / Update feed is too large".to_owned());
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok::<_, String>(bytes)
        }
    };
    // The feed is signed, so the mirror may serve it; GitHub stays the fallback.
    let fetch_any = |official: String| {
        let fetch = &fetch;
        async move {
            let mut failures = Vec::new();
            for via in github_source::order() {
                match fetch(github_source::url(via, &official)).await {
                    Ok(bytes) => return Ok(bytes),
                    Err(error) => failures.push(format!("{}：{error}", github_source::label(via))),
                }
            }
            Err::<Vec<u8>, String>(failures.join("；"))
        }
    };
    let feed = fetch_any(feed_url).await?;
    let signature = fetch_any(signature_url).await?;
    let feed = engine_package::verify_feed(&feed, &signature, previous_sequence, now())?;
    if expected_version.is_some_and(|expected| feed["app"]["version"].as_str() != Some(expected)) {
        return Err(
            "签名 feed 的版本与所选版本不一致 / The signed feed is for a different version".into(),
        );
    }
    let sequence = feed["sequence"].as_u64().unwrap_or_default();
    // Only Windows x64 and Linux x64 install official release packages. Any other host
    // (e.g. macOS, which uses its own Metal engine flow) gets no packages rather than the
    // Windows list; the verified sequence still advances the rollback guard.
    let Some(platform) = engine_package::this_release_install_platform() else {
        return Ok(Some((sequence, Vec::new(), Vec::new())));
    };
    let assets = engine_package::feed_assets(&feed, release, tag, platform)?;
    // An unusable `dsv41` member never blocks a Strata engine update.
    let dsv41 =
        engine_package::dsv41_feed_assets(&feed, release, tag, platform).unwrap_or_default();
    Ok(Some((sequence, assets, dsv41)))
}

fn valid_revision(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    task_id: String,
    profile_id: String,
    phase: String,
    old: ServiceProfile,
    candidate: Option<ServiceProfile>,
    old_config_sha256: String,
    candidate_config_sha256: Option<String>,
    was_running: bool,
    was_loaded: bool,
    old_active: Value,
    old_desired: Value,
    error: Option<String>,
    updated_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeStatus {
    pub task_id: String,
    pub profile_id: String,
    pub phase: String,
    pub supported_version: String,
    pub source_revision: String,
    pub updated_at: u64,
    pub error: Option<String>,
    pub candidate_directory: Option<String>,
    pub limits: String,
}

fn persist(state: &RuntimeState, journal: &Journal) -> Result<(), String> {
    let db = state.database.lock().map_err(|e| e.to_string())?;
    db.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    db.execute("INSERT INTO runtime_upgrades VALUES(?1,?2,?3,?4) ON CONFLICT(task_id) DO UPDATE SET journal=excluded.journal,updated_at=excluded.updated_at", params![journal.task_id,journal.profile_id,serde_json::to_string(journal).map_err(|e|e.to_string())?,journal.updated_at as i64]).map_err(|e|e.to_string())?;
    Ok(())
}
pub fn status(state: &RuntimeState, profile_id: String) -> Result<Option<UpgradeStatus>, String> {
    let db = state.database.lock().map_err(|e| e.to_string())?;
    db.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    let data: Option<String> = db.query_row("SELECT journal FROM runtime_upgrades WHERE profile_id=?1 ORDER BY updated_at DESC,rowid DESC LIMIT 1",[profile_id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    data.map(|data| {
        let j: Journal = serde_json::from_str(&data).map_err(|e|e.to_string())?;
        Ok(UpgradeStatus { task_id:j.task_id, profile_id:j.profile_id, phase:j.phase, supported_version:VERSION.into(),source_revision:installation::SOURCE_REVISION.into(),updated_at:j.updated_at,error:j.error,candidate_directory:j.candidate.map(|p|p.install_dir),limits:"Fixed reviewed release; no upstream latest lookup, driver installation, model download or arbitrary script migration. Python uses a compatible private venv; a newer Python release is not promised.".into() })
    }).transpose()
}
pub fn assert_available(state: &RuntimeState) -> Result<(), String> {
    if state.runtime_upgrading.load(Ordering::Acquire) {
        Err("Strata 运行时正在准备或安全切换，请等待完成或取消更新任务".into())
    } else {
        Ok(())
    }
}
struct UpgradeFlag(Arc<RuntimeState>);
impl Drop for UpgradeFlag {
    fn drop(&mut self) {
        self.0.runtime_upgrading.store(false, Ordering::Release);
    }
}
struct SelectionFlag(Arc<RuntimeState>);
impl Drop for SelectionFlag {
    fn drop(&mut self) {
        self.0.selection_changing.store(false, Ordering::Release);
    }
}
struct StartupGate {
    path: PathBuf,
    journal: PathBuf,
    token: String,
    /// Observer request rows left behind by a killed engine, removed under the gate transaction.
    cleared_stale: usize,
}
/// The official observer deletes every `active_requests` row of a service when a new
/// observer session starts. A row therefore only means a live request while the
/// service itself runs. For a service verified as stopped, a row that started more than
/// this long ago is an orphan of a killed engine; younger rows still block.
const STALE_ACTIVE_REQUEST_MS: u64 = 120_000;
/// How a switch handles leftover rows that are still younger than the stale threshold:
/// it polls (without holding any lock) until they age out, at most `max` long.
#[derive(Clone, Copy)]
struct ObserverWait {
    stale_ms: u64,
    poll: Duration,
    max: Duration,
}
impl ObserverWait {
    const DEFAULT: Self = Self {
        stale_ms: STALE_ACTIVE_REQUEST_MS,
        poll: Duration::from_secs(3),
        max: Duration::from_secs(150),
    };
}
/// A start time further ahead of the clock than this cannot belong to a live request.
const ACTIVE_REQUEST_CLOCK_SKEW_MS: u64 = 300_000;
/// Rows of `service_id` that are too recent to be orphans: `(count, newest start ms)`.
fn recent_active_requests(
    db: &rusqlite::Connection,
    service_id: &str,
    now_ms: u64,
    stale_ms: u64,
) -> Result<Option<(i64, u64)>, rusqlite::Error> {
    let oldest_fresh = now_ms.saturating_sub(stale_ms) as i64;
    let newest_valid = now_ms.saturating_add(ACTIVE_REQUEST_CLOCK_SKEW_MS) as i64;
    let (count, newest): (i64, Option<i64>) = db.query_row(
        "SELECT COUNT(*),MAX(CAST(started_ms AS INTEGER)) FROM active_requests WHERE service_id=?1 AND CAST(started_ms AS INTEGER)>=?2 AND CAST(started_ms AS INTEGER)<=?3",
        rusqlite::params![service_id, oldest_fresh, newest_valid],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok((count > 0).then(|| (count, newest.unwrap_or_default().max(0) as u64)))
}
fn unreadable_requests(e: rusqlite::Error) -> String {
    format!("无法读取服务的使用记录，未改动任何数据：{e}")
}
/// Plain-language failure for rows that are still there after the automatic wait.
fn recent_requests_error(count: i64, newest: u64, now_ms: u64, waited: Option<Duration>) -> String {
    let age = now_ms.saturating_sub(newest) / 1000;
    let waited = waited.map_or(String::new(), |w| {
        format!("，已自动等待 {} 秒", w.as_secs())
    });
    format!("服务已停止，但使用记录里仍有 {count} 个未结束的请求（最近一个在 {age} 秒前开始{waited}）；可能还有其它 Strata 程序在使用它。请先关闭其它正在使用 Strata 的程序（命令行、其它客户端或另一个 Strata Manager 窗口），再点一次更新或切换")
}
/// Removes orphaned rows of a stopped service and errors on recent ones.
/// Only `active_requests` rows of `service_id` are touched; never the event history.
fn clear_stale_active_requests(
    tx: &rusqlite::Transaction<'_>,
    service_id: &str,
    now_ms: u64,
    stale_ms: u64,
) -> Result<usize, String> {
    let oldest_fresh = now_ms.saturating_sub(stale_ms) as i64;
    let newest_valid = now_ms.saturating_add(ACTIVE_REQUEST_CLOCK_SKEW_MS) as i64;
    let cleared = tx
        .execute(
            "DELETE FROM active_requests WHERE service_id=?1 AND (CAST(started_ms AS INTEGER)<?2 OR CAST(started_ms AS INTEGER)>?3)",
            rusqlite::params![service_id, oldest_fresh, newest_valid],
        )
        .map_err(unreadable_requests)?;
    if let Some((count, newest)) =
        recent_active_requests(tx, service_id, now_ms, stale_ms).map_err(unreadable_requests)?
    {
        return Err(recent_requests_error(count, newest, now_ms, None));
    }
    Ok(cleared)
}
/// True when neither a Manager-owned process nor anything else serves this installation.
fn service_stopped(
    state: &RuntimeState,
    profile_id: &str,
    profile: &ServiceProfile,
) -> Result<bool, String> {
    let owned_running = state
        .processes
        .lock()
        .map_err(|e| e.to_string())?
        .get_mut(profile_id)
        .map(|p| p.refresh())
        .transpose()?
        .is_some_and(|s| s.running);
    Ok(!owned_running
        && !crate::external::port_accepting(profile)?
        && !crate::discovery::has_running_installation(Path::new(&profile.install_dir))?)
}
/// Instead of failing on rows younger than the stale threshold, waits for them to age out.
/// Runs before any switch lock is taken, so nothing else is blocked while sleeping; the
/// reservation in `reserve_stopped_at` re-checks everything afterwards under its own
/// transaction. Skipped when the service runs (the drain path never reserves).
async fn wait_out_recent_requests(
    state: &RuntimeState,
    journal: &mut Journal,
    candidate: &ServiceProfile,
    wait: ObserverWait,
) -> Result<(), String> {
    if !service_stopped(state, &journal.profile_id, &journal.old)? {
        return Ok(());
    }
    let directory = installation::owned_directory(state.data_dir(), &["analytics"])?;
    let path = directory.join("journal.sqlite3");
    let started = Instant::now();
    let mut announced = false;
    loop {
        cancelled(state, &journal.task_id)?;
        let recent = {
            let db = rusqlite::Connection::open(&path).map_err(|e| e.to_string())?;
            db.busy_timeout(Duration::from_secs(5))
                .map_err(|e| e.to_string())?;
            let has_table: i64 = db
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='active_requests'",
                    [],
                    |r| r.get(0),
                )
                .map_err(unreadable_requests)?;
            if has_table == 0 {
                None
            } else {
                recent_active_requests(&db, &candidate.id, now(), wait.stale_ms)
                    .map_err(unreadable_requests)?
            }
        };
        let Some((count, newest)) = recent else {
            return Ok(());
        };
        if !service_stopped(state, &journal.profile_id, &journal.old)?
            || !service_stopped(state, &candidate.id, candidate)?
        {
            return Err(
                "候选已有运行实例；服务在等待期间被重新启动，更新未进行，请先停止服务再试".into(),
            );
        }
        if started.elapsed() >= wait.max {
            return Err(recent_requests_error(
                count,
                newest,
                now(),
                Some(started.elapsed()),
            ));
        }
        if !announced {
            announced = true;
            let expires = (newest + wait.stale_ms).saturating_sub(now()) / 1000 + 1;
            let secs = expires.min(wait.max.as_secs());
            stage(
                state,
                journal,
                "waitingIdle",
                &format!("检测到刚结束的服务还留有 {count} 个请求记录，正在自动等待其过期（约 {secs} 秒），无需操作"),
            )?;
        }
        tokio::select! {
            _ = tokio::time::sleep(wait.poll) => {},
            _ = wait_cancel(state, &journal.task_id) => {},
        }
    }
}
impl Drop for StartupGate {
    fn drop(&mut self) {
        let Ok(mut db) = rusqlite::Connection::open(&self.journal) else {
            return;
        };
        let _ = db.busy_timeout(Duration::from_secs(5));
        let Ok(tx) = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate) else {
            return;
        };
        let owner = fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
        if owner.as_ref().and_then(|v| v["token"].as_str()) == Some(&self.token) {
            let _ = fs::remove_file(&self.path);
        }
        let _ = tx.commit();
    }
}
fn reserve_stopped(
    state: &RuntimeState,
    profile: &ServiceProfile,
    stale_ms: u64,
) -> Result<StartupGate, String> {
    reserve_stopped_at(state, profile, now(), stale_ms)
}
fn reserve_stopped_at(
    state: &RuntimeState,
    profile: &ServiceProfile,
    now_ms: u64,
    stale_ms: u64,
) -> Result<StartupGate, String> {
    state.registered_profile(&profile.id)?;
    if crate::external::port_accepting(profile)?
        || crate::discovery::has_running_installation(Path::new(&profile.install_dir))?
    {
        return Err("候选已有运行实例，无法预置安全验收准入".into());
    }
    maintenance::clear_abandoned(state, profile)?;
    let directory = installation::owned_directory(state.data_dir(), &["analytics"])?;
    let journal = directory.join("journal.sqlite3");
    let mut db = rusqlite::Connection::open(&journal).map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    // The official observer creates this same protocol table on its first admission.
    tx.execute_batch("CREATE TABLE IF NOT EXISTS active_requests(request_id TEXT PRIMARY KEY,service_id TEXT NOT NULL,session_id TEXT NOT NULL,started_ms INTEGER NOT NULL);").map_err(|e|e.to_string())?;
    let cleared_stale = clear_stale_active_requests(&tx, &profile.id, now_ms, stale_ms)?;
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let path = directory.join(format!("{}.maintenance", profile.id));
    atomic_new(&path,&serde_json::to_vec(&json!({"mode":"drain","token":token,"supervisorPid":std::process::id(),"supervisorStartedAt":state.started_at})).map_err(|e|e.to_string())?)?;
    let guard = StartupGate {
        path,
        journal,
        token,
        cleared_stale,
    };
    tx.commit().map_err(|e| e.to_string())?;
    Ok(guard)
}
fn cancelled(state: &RuntimeState, id: &str) -> Result<(), String> {
    if state.shutting_down.load(Ordering::Acquire)
        || state
            .tasks
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .is_none_or(|task| task.cancelled)
    {
        Err("运行时更新已取消".into())
    } else {
        Ok(())
    }
}
fn stage(
    state: &RuntimeState,
    journal: &mut Journal,
    phase: &str,
    message: &str,
) -> Result<(), String> {
    journal.phase = phase.into();
    journal.updated_at = now();
    persist(state, journal)?;
    let mut tasks = state.tasks.lock().map_err(|e| e.to_string())?;
    let task = tasks.get_mut(&journal.task_id).ok_or("更新任务不存在")?;
    task.status.message = message.into();
    processes::persist_task(&state.database, task)?;
    processes::log(&state.logs, &journal.task_id, "info", message);
    processes::persist_task_logs(&state.database, &state.logs, &journal.task_id)
}
pub fn start(state: Arc<RuntimeState>, profile_id: String) -> Result<TaskStatus, String> {
    if profile_id.is_empty()
        || profile_id.len() > 80
        || !profile_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("本机安装标识无效，未启动更新".into());
    }
    let operation = state.runtime_operations.lock().map_err(|e| e.to_string())?;
    if state.shutting_down.load(Ordering::Acquire)
        || state.selection_changing.load(Ordering::Acquire)
    {
        return Err("后台正在退出或切换模型，请稍后重试".into());
    }
    crate::tuning::assert_available(&state)?;
    let profile = state.registered_profile(&profile_id)?;
    crate::external_management::assert_profile_manager_owned(&state, &profile)?;
    if status(&state, profile_id.clone())?.is_some_and(|job| job.phase == "rollbackFailed") {
        return Err("上次运行时更新尚未安全恢复；请查看任务诊断、修复原因后重新打开应用重试恢复，未启动新更新".into());
    }
    let old_config_sha256 = installation::file_hash(&storage::config_path(&profile)?)?;
    let id = uuid::Uuid::new_v4().to_string();
    let status = TaskStatus {
        id: id.clone(),
        kind: "update".into(),
        state: "running".into(),
        message: "正在检查应用已验证的 Strata / Python / 引擎版本；保留原安装".into(),
        started_at: now(),
        finished_at: None,
    };
    let mut tasks = state.tasks.lock().map_err(|e| e.to_string())?;
    if let Some(existing) = tasks.values().find(|t| {
        t.status.state == "running"
            && t.status.kind == "update"
            && t.profile_id.as_deref() == Some(&profile_id)
    }) {
        return Ok(existing.status.clone());
    }
    if tasks.values().any(|t| t.status.state == "running") {
        return Err("已有安装、模型准备或更新任务，请完成后再检查运行时更新".into());
    }
    state
        .runtime_upgrading
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "已有运行时更新任务")?;
    let flag = UpgradeFlag(state.clone());
    crate::tuning::assert_no_active_tuning(&state)?;
    let journal = Journal {
        task_id: id.clone(),
        profile_id: profile.id.clone(),
        phase: "checking".into(),
        old: profile,
        candidate: None,
        old_config_sha256,
        candidate_config_sha256: None,
        was_running: false,
        was_loaded: false,
        old_active: crate::store_get(&state, "activeLocalInstallation".into())?,
        old_desired: crate::store_get(&state, "localServiceDesired".into())?,
        error: None,
        updated_at: now(),
    };
    persist(&state, &journal)?;
    processes::admit_task_logs(&mut tasks, &state.logs, &id)?;
    tasks.insert(
        id.clone(),
        processes::TaskRecord {
            status: status.clone(),
            profile_id: Some(profile_id),
            runtime_path: None,
            cancelled: false,
            process: None,
        },
    );
    if let Err(error) =
        processes::persist_task(&state.database, tasks.get(&id).ok_or("更新任务不存在")?)
    {
        tasks.remove(&id);
        if let Ok(mut logs) = state.logs.lock() {
            logs.retire(&id);
        }
        return Err(format!("更新任务保存失败，原服务未改变：{error}"));
    }
    drop(tasks);
    drop(operation);
    tokio::spawn(async move {
        let _flag = flag;
        let mut journal = journal;
        let outcome = execute(state.clone(), &mut journal).await;
        if let Err(error) = &outcome {
            journal.error = Some(error.clone());
            if !matches!(journal.phase.as_str(), "rolledBack" | "rollbackFailed") {
                journal.phase = if cancelled(&state, &id).is_err() {
                    "cancelled"
                } else {
                    "failed"
                }
                .into();
            }
            journal.updated_at = now();
            let _ = persist(&state, &journal);
        }
        if let Ok(mut tasks) = state.tasks.lock() {
            if let Some(record) = tasks.get_mut(&id) {
                record.process.take();
                record.status.finished_at = Some(now());
                record.status.state = if outcome.is_ok() {
                    "completed"
                } else if record.cancelled {
                    "cancelled"
                } else {
                    "failed"
                }
                .into();
                record.status.message = match outcome {
                    Ok(message) => message,
                    Err(error) => error,
                };
                processes::log(
                    &state.logs,
                    &id,
                    &record.status.state,
                    &record.status.message,
                );
                let _ = processes::persist_task(&state.database, record);
                let _ = processes::persist_task_logs(&state.database, &state.logs, &id);
            }
        }
    });
    Ok(status)
}

fn canonical_hash(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let text = String::from_utf8(bytes).map_err(|_| "源码不是 UTF-8")?;
    Ok(format!(
        "{:x}",
        Sha256::digest(text.replace("\r\n", "\n").as_bytes())
    ))
}
fn config_cwd(profile: &ServiceProfile, config: &Value) -> Result<PathBuf, String> {
    let runtime = Path::new(&profile.install_dir);
    let raw = config.get("cwd").and_then(Value::as_str).unwrap_or(".");
    let path = resolve(runtime, raw);
    dunce::canonicalize(path).map_err(|_| "配置 cwd 目录不存在".into())
}
fn resolve(root: &Path, value: &str) -> PathBuf {
    let p = Path::new(value);
    if p.is_absolute() {
        p.into()
    } else {
        root.join(p)
    }
}
fn engine_metadata(profile: &ServiceProfile, config: &Value) -> Result<Value, String> {
    let exe = resolve(
        &config_cwd(profile, config)?,
        config["exe"].as_str().ok_or("配置缺少 exe")?,
    );
    let path = exe.parent().ok_or("引擎目录无效")?.join("BUILD.json");
    if fs::metadata(&path)
        .map_err(|_| "引擎缺少 BUILD.json，无法选择已验证更新；请保留现有安装并使用受管安装器准备")?
        .len()
        > 65536
    {
        return Err("引擎版本文件超过上限".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|_| "引擎 BUILD.json 无效".into())
}
fn newer_than_supported(version: &str) -> bool {
    match (
        engine_package::version_key(version),
        engine_package::version_key(VERSION),
    ) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}
struct EngineArtifact {
    name: &'static str,
    sha: &'static str,
    size: u64,
    cuda: Option<u8>,
}
fn artifact(config: &Value) -> Result<EngineArtifact, String> {
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Err("当前已验证 v0.1.41 仅发布 Windows x64 引擎。此平台保持原运行时；需等待应用提供对应平台的固定、校验版本，不会转用 upstream latest 或现场编译。".into());
    }
    if config["backend"].as_str() == Some("hip") {
        Ok(EngineArtifact {
            name: "strata-windows-x64-hip.zip",
            sha: "e8701d1d183f0f84742f6b9dcde7c5589cfd86271cdec70646f88cf441ee6716",
            size: 628263532,
            cuda: None,
        })
    } else if config["cuda"].as_u64() == Some(12)
        || config["exe"]
            .as_str()
            .is_some_and(|p| p.contains("engine-cuda12"))
    {
        Ok(EngineArtifact {
            name: "strata-windows-x64-cuda12.zip",
            sha: "646ded0105aa5213a75e16621d559670d09dac26b5c720c9fd651ca83bdf14ec",
            size: 198572838,
            cuda: Some(12),
        })
    } else if config
        .get("backend")
        .is_none_or(|v| v.is_null() || v == "cuda")
    {
        Ok(EngineArtifact {
            name: "strata-windows-x64.zip",
            sha: "3dd7715f4844c0f9d2f28eb5067af0198f386df060c93523cd17e1d65b757f13",
            size: 137164559,
            cuda: Some(13),
        })
    } else {
        Err("该自定义引擎 backend 没有已验证迁移目标，保留现有安装".into())
    }
}

async fn execute(state: Arc<RuntimeState>, journal: &mut Journal) -> Result<String, String> {
    cancelled(&state, &journal.task_id)?;
    let config = storage::read(&journal.old)?;
    storage::validate(&config)?;
    let meta = engine_metadata(&journal.old, &config)?;
    let version = meta["version"]
        .as_str()
        .ok_or("引擎版本缺失，无法确定兼容目标")?;
    if newer_than_supported(version) {
        stage(
            &state,
            journal,
            "noUpdate",
            "当前引擎高于应用已验证的 v0.1.41；没有可安全升级的更高已验证版本，保留现有运行时",
        )?;
        return Ok("没有更高的已验证版本；当前引擎较新，未降级或修改安装".into());
    }
    if version == VERSION
        && canonical_hash(&Path::new(&journal.old.install_dir).join("serve/server.py"))?
            == SERVER_SHA256
    {
        stage(
            &state,
            journal,
            "noUpdate",
            "当前已使用应用支持的 Strata / 引擎 v0.1.41；没有更高已验证更新",
        )?;
        return Ok(
            "当前已是应用支持的 v0.1.41，没有更高已验证更新；未重新下载模型或修改 Python".into(),
        );
    }
    // Read-only no-update checks do not migrate hooks. Actual migrations reject
    // ambiguous commands before downloading a candidate or changing a service.
    validate_hooks(&journal.old, &config)?;
    let mut engine_selection = config.clone();
    if let Some(backend) = meta["backend"].as_str() {
        if config["backend"]
            .as_str()
            .is_some_and(|declared| declared != backend)
        {
            return Err("配置 backend 与当前引擎 BUILD.json 不一致，无法证明更新目标兼容；请核对配置和引擎后重试，未停服务".into());
        }
        engine_selection["backend"] = json!(backend);
    }
    if let Some(cuda) = meta["cuda"]
        .as_str()
        .and_then(|value| value.split('.').next())
        .and_then(|major| major.parse::<u8>().ok())
    {
        if !matches!(cuda, 12 | 13) {
            return Err("当前 CUDA 引擎没有匹配的已验证更新目标，保留现有安装".into());
        }
        if config["cuda"]
            .as_u64()
            .is_some_and(|declared| declared != u64::from(cuda))
        {
            return Err(
                "配置 CUDA 版本与当前引擎 BUILD.json 不一致；请核对后重试，未停服务".into(),
            );
        }
        engine_selection["cuda"] = json!(cuda);
    }
    let asset = artifact(&engine_selection)?;
    prepare_candidate(state.clone(), journal, &config, asset).await?;
    Ok(match switch(state, journal).await? {
        Verification::Full => {
            "运行时已安全更新至固定 v0.1.41；健康、加载与短请求验收通过，原安装和模型文件保持原位"
        }
        Verification::Quick => {
            "运行时已更新至固定 v0.1.41；新版服务健康检查通过，原安装和模型文件保持原位"
        }
    }
    .into())
}

async fn prepare_candidate(
    state: Arc<RuntimeState>,
    journal: &mut Journal,
    config: &Value,
    asset: EngineArtifact,
) -> Result<(), String> {
    stage(
        &state,
        journal,
        "preparingSource",
        "正在新目录准备固定、SHA256 校验的 Strata 源码和私有 Python 环境",
    )?;
    let root = installation::owned_directory(state.data_dir(), &["runtimes"])?
        .join(format!("upgrade-{}", journal.task_id));
    let prepared = installation::prepare(&state, &journal.task_id, &root).await?;
    stage(
        &state,
        journal,
        "preparingPython",
        "正在私有环境安装固定源码的 Python 依赖；不修改原环境",
    )?;
    let mut pip = Command::new(&prepared.python_path);
    pip.args([
        "-I",
        "-m",
        "pip",
        "--isolated",
        "install",
        "--disable-pip-version-check",
        "--index-url",
        "https://pypi.org/simple",
        "--only-binary=:all:",
        "-r",
    ])
    .arg(root.join("requirements.txt"))
    .current_dir(&root);
    installation::run_owned(&state, &journal.task_id, pip, "安装候选 Python 依赖").await?;
    if let Some(cuda) = asset.cuda {
        let wheels = if cuda == 12 {
            [
                "nvidia-cublas-cu12==12.9.1.4",
                "nvidia-cuda-runtime-cu12==12.9.79",
            ]
        } else {
            ["nvidia-cublas==13.0.2.14", "nvidia-cuda-runtime==13.0.96"]
        };
        let mut pip = Command::new(&prepared.python_path);
        pip.args([
            "-I",
            "-m",
            "pip",
            "--isolated",
            "install",
            "--disable-pip-version-check",
            "--index-url",
            "https://pypi.org/simple",
            "--only-binary=:all:",
        ])
        .args(wheels)
        .current_dir(&root);
        installation::run_owned(&state, &journal.task_id, pip, "安装候选固定 CUDA 运行库").await?;
    }
    stage(
        &state,
        journal,
        "preparingEngine",
        "正在下载固定 v0.1.41 引擎；强制 SHA256 和精确大小核验",
    )?;
    let url = format!(
        "https://github.com/Niko1221/Strata/releases/download/v{VERSION}/{}",
        asset.name
    );
    let archive =
        installation::download_release(&state, &journal.task_id, &url, asset.sha, asset.size)
            .await?;
    if fs::metadata(&archive).map_err(|e| e.to_string())?.len() != asset.size {
        return Err("候选引擎大小与固定清单不符".into());
    }
    let engine = root.join("engine");
    fs::create_dir(&engine).map_err(|e| e.to_string())?;
    extract_engine(&archive, &engine, || cancelled(&state, &journal.task_id))?;
    let build: Value =
        serde_json::from_slice(&fs::read(engine.join("BUILD.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if build["version"].as_str() != Some(VERSION) {
        return Err("已校验引擎内部版本与固定版本不一致，拒绝切换".into());
    }
    let libs = if asset.cuda.is_some() {
        cuda_dirs(&root, asset.cuda.unwrap_or(13))?
    } else {
        hip_dirs(&engine, &build)?
    };
    let mut candidate = journal.old.clone();
    candidate.install_dir = prepared.install_dir;
    candidate.python_path = prepared.python_path;
    candidate.config_path = root.join("managed-config.json").to_string_lossy().into();
    let migrated = migrate_config(&journal.old, config, &engine, &libs)?;
    atomic_new(
        Path::new(&candidate.config_path),
        &serde_json::to_vec_pretty(&migrated).map_err(|e| e.to_string())?,
    )?;
    copy_shared_settings(&journal.old, &candidate)?;
    journal.candidate_config_sha256 =
        Some(installation::file_hash(Path::new(&candidate.config_path))?);
    journal.candidate = Some(candidate);
    stage(
        &state,
        journal,
        "candidateReady",
        "候选源码、私有 Python、引擎及配置已准备；等待当前服务空闲",
    )?;
    Ok(())
}

fn validate_hooks(profile: &ServiceProfile, config: &Value) -> Result<(), String> {
    if config
        .get("before_load")
        .is_some_and(|v| !v.is_null() && v != "" && v != &json!([]))
    {
        return Err("before_load 包含外部命令，当前版本暂不自动迁移此类钩子。请先移除此钩子后重试，或继续使用原安装；当前配置和服务未改变。".into());
    }
    let runtime = Path::new(&profile.install_dir);
    for key in ["mcp_servers", "mcpServers"] {
        if let Some(block) = config.get(key).filter(|v| !v.is_null()) {
            let servers = block
                .as_object()
                .ok_or_else(|| format!("{key} 必须是服务器对象，无法安全迁移"))?;
            for (name, server) in servers {
                let obj = server
                    .as_object()
                    .ok_or_else(|| format!("MCP {name} 配置不是对象"))?;
                if obj
                    .get("url")
                    .and_then(Value::as_str)
                    .is_some_and(|url| !url.is_empty())
                {
                    continue;
                }
                let cwd = resolve(
                    runtime,
                    obj.get("cwd")
                        .and_then(Value::as_str)
                        .filter(|v| !v.is_empty())
                        .unwrap_or("."),
                );
                if !cwd.is_dir() {
                    return Err(format!("MCP {name} 的 cwd 不存在；请修复后重试"));
                }
                let command = obj
                    .get("command")
                    .and_then(Value::as_str)
                    .ok_or_else(|| format!("MCP {name} 缺少 command"))?;
                if !command.contains(['/', '\\']) {
                    return Err(format!("MCP {name} 的 command 依赖 PATH/启动目录搜索，无法证明候选兼容。请先将 command 改为有效绝对路径后重试；未停服务。"));
                }
                if !Path::new(command).is_absolute()
                    && dunce::canonicalize(&cwd).ok() != dunce::canonicalize(runtime).ok()
                {
                    return Err(format!("MCP {name} 使用相对 command 和不同 cwd；官方先按 Strata 工作目录搜索 command，无法证明迁移语义。请先将 command 改为有效绝对路径，保持 args 和 cwd；未停服务。"));
                }
                if command.contains(['/', '\\']) && !resolve(&cwd, command).is_file() {
                    return Err(format!(
                        "MCP {name} 相对 command 无法定位，请先改为有效绝对路径"
                    ));
                }
                if let Some(path) = server
                    .get("env")
                    .and_then(|v| v.get("PATH"))
                    .and_then(Value::as_str)
                {
                    if std::env::split_paths(path).any(|p| !p.is_absolute()) {
                        return Err(format!("MCP {name} 的 PATH 含相对路径，请先改为绝对路径"));
                    }
                }
            }
        }
    }
    Ok(())
}
fn migrate_config(
    profile: &ServiceProfile,
    config: &Value,
    engine: &Path,
    libs: &[String],
) -> Result<Value, String> {
    validate_hooks(profile, config)?;
    let cwd = config_cwd(profile, config)?;
    let runtime = Path::new(&profile.install_dir);
    let mut out = config.clone();
    let obj = out.as_object_mut().ok_or("配置不是对象")?;
    obj.insert("cwd".into(), json!(cwd));
    obj.insert(
        "exe".into(),
        json!(engine.join(if cfg!(windows) {
            "strata.exe"
        } else {
            "strata"
        })),
    );
    obj.insert("lib_dirs".into(), json!(libs));
    // Unlike engine arguments, the official server resolves tokenizer relative to its own cwd.
    let tokenizer = config["tokenizer"]
        .as_str()
        .ok_or("配置没有 tokenizer，不能迁移默认 tokenizer 的隐式路径；请填写现有目录")?;
    let tokenizer = resolve(runtime, tokenizer);
    for name in ["vocab.json", "merges.txt", "token_type.json"] {
        if !tokenizer.join(name).is_file() {
            return Err(format!("原 tokenizer 缺少 {name}；未下载替代资源"));
        }
    }
    obj.insert(
        "tokenizer".into(),
        json!(dunce::canonicalize(tokenizer).map_err(|e| e.to_string())?),
    );
    // Preserve all unknown fields and engine flags. Their relative paths keep the exact old engine cwd.
    for key in ["log", "expert_profile_save", "slot_save_path"] {
        if let Some(raw) = config[key].as_str().filter(|v| !v.is_empty()) {
            obj.insert(
                key.into(),
                json!(resolve(if key == "log" { runtime } else { &cwd }, raw)),
            );
        }
    }
    if let Some(vision) = obj.get_mut("vision").and_then(Value::as_object_mut) {
        for key in ["model", "mmproj"] {
            if let Some(raw) = vision.get(key).and_then(Value::as_str) {
                let path = resolve(&cwd, raw);
                if !path.is_file() {
                    return Err(format!("vision.{key} 资源不存在；保持原模型"));
                }
                vision.insert(key.into(), json!(path));
            }
        }
        let exe = engine.join(if cfg!(windows) {
            "strata-vision.exe"
        } else {
            "strata-vision"
        });
        if !exe.is_file() {
            return Err("固定引擎缺少当前配置所需的视觉编码器，未停服务".into());
        }
        vision.insert("exe".into(), json!(exe));
    }
    for key in ["mcp_servers", "mcpServers"] {
        if let Some(servers) = obj.get_mut(key).and_then(Value::as_object_mut) {
            for server in servers.values_mut() {
                if server
                    .get("url")
                    .and_then(Value::as_str)
                    .is_some_and(|url| !url.is_empty())
                {
                    continue;
                }
                let cfg = server.as_object_mut().ok_or("MCP 配置无效")?;
                let cwd = resolve(
                    runtime,
                    cfg.get("cwd")
                        .and_then(Value::as_str)
                        .filter(|v| !v.is_empty())
                        .unwrap_or("."),
                );
                if let Some(command) = cfg
                    .get("command")
                    .and_then(Value::as_str)
                    .filter(|v| v.contains(['/', '\\']))
                {
                    cfg.insert("command".into(), json!(resolve(&cwd, command)));
                }
                cfg.insert(
                    "cwd".into(),
                    json!(dunce::canonicalize(cwd).map_err(|_| "MCP cwd 无法核验")?),
                );
            }
        }
    }
    storage::validate(&out)?;
    Ok(out)
}
fn atomic_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = write_temp(path, bytes)?;
    temp.persist_noclobber(path)
        .map_err(|e| persist_error(path, &e.error, "已存在，未覆盖"))?;
    Ok(())
}
/// Like [`atomic_new`] for a file only this operation owns (a candidate copy in
/// a folder keyed by the task): a leftover from an earlier attempt is replaced
/// atomically instead of failing with "file already exists" (os error 183).
fn atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = write_temp(path, bytes)?;
    temp.persist(path)
        .map_err(|e| persist_error(path, &e.error, "无法替换"))?;
    Ok(())
}
fn persist_error(path: &Path, error: &std::io::Error, what: &str) -> String {
    format!("候选文件 {} {what}：{error}", path.display())
}
fn write_temp(path: &Path, bytes: &[u8]) -> Result<tempfile::NamedTempFile, String> {
    let parent = path.parent().ok_or("候选目录无效")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("无法在 {} 创建临时文件：{e}", parent.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    temp.write_all(bytes).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    Ok(temp)
}
fn shared_settings_path(profile: &ServiceProfile) -> PathBuf {
    let path = Path::new(&profile.config_path);
    path.with_file_name(format!(
        "{}.shared-settings.json",
        path.file_stem().unwrap_or_default().to_string_lossy()
    ))
}
fn read_shared_settings(path: &Path) -> Result<Option<Vec<u8>>, String> {
    const LIMIT: u64 = 4 * 1024 * 1024;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("共享设置无法读取：{error}")),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > LIMIT {
        return Err("共享设置不是安全的普通文件，或超过 4 MiB 上限".into());
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|error| format!("共享设置无法打开：{error}"))?
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("共享设置无法读取：{error}"))?;
    if bytes.len() as u64 > LIMIT {
        return Err("共享设置写入期间超过 4 MiB 上限".into());
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("共享设置不是有效 JSON，请等待保存完成后重试：{error}"))?;
    if !value.is_object() {
        return Err("共享设置不是 JSON 对象".into());
    }
    Ok(Some(bytes))
}
fn copy_shared_settings(old: &ServiceProfile, new: &ServiceProfile) -> Result<(), String> {
    if let Some(bytes) = read_shared_settings(&shared_settings_path(old))? {
        atomic_replace(&shared_settings_path(new), &bytes)?;
    }
    Ok(())
}
fn refresh_shared_settings(old: &ServiceProfile, new: &ServiceProfile) -> Result<(), String> {
    if dunce::canonicalize(&old.config_path).map_err(|e| e.to_string())?
        == dunce::canonicalize(&new.config_path).map_err(|e| e.to_string())?
    {
        return Err("候选配置必须与原配置分离，未覆盖原共享设置".into());
    }
    let source = shared_settings_path(old);
    let target = shared_settings_path(new);
    let snapshot = read_shared_settings(&source)?;
    // The candidate is not running. Never follow a redirected destination when
    // replacing or deleting its preliminary shared-settings copy.
    match fs::symlink_metadata(&target) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
            return Err("候选共享设置路径被重定向，未切换服务".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("候选共享设置无法核验：{error}")),
    }
    if let Some(bytes) = &snapshot {
        let mut temp = tempfile::NamedTempFile::new_in(target.parent().ok_or("候选目录无效")?)
            .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temp.as_file()
                .set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        temp.write_all(bytes).map_err(|e| e.to_string())?;
        temp.as_file().sync_all().map_err(|e| e.to_string())?;
        temp.persist(&target).map_err(|e| e.to_string())?;
    } else {
        match fs::remove_file(&target) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("候选旧共享设置无法移除：{error}")),
        }
    }
    if read_shared_settings(&source)? != snapshot {
        return Err("排空后共享设置仍在变化，原服务未停止；请等待保存完成后重试更新".into());
    }
    if read_shared_settings(&target)? != snapshot {
        return Err("候选共享设置发布后无法核验，原服务未停止".into());
    }
    Ok(())
}
fn cuda_dirs(root: &Path, cuda: u8) -> Result<Vec<String>, String> {
    let root = root.join(".venv/Lib/site-packages/nvidia");
    let mut dirs = Vec::new();
    let mut stack = vec![root];
    let names = if cuda == 12 {
        vec!["cublas64_12.dll", "cudart64_12.dll"]
    } else {
        vec!["cublas64_13.dll"]
    };
    let mut scanned = 0;
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
            scanned += 1;
            if scanned > 8192 {
                return Err("候选 CUDA 文件超过扫描上限".into());
            }
            let path = entry.path();
            if path.is_symlink() {
                return Err("候选 CUDA 路径被重定向".into());
            }
            if path.is_dir() {
                stack.push(path);
            } else if names
                .iter()
                .any(|n| path.file_name().is_some_and(|v| v == *n))
            {
                let parent = path
                    .parent()
                    .ok_or("CUDA 路径无效")?
                    .to_string_lossy()
                    .into_owned();
                if !dirs.contains(&parent) {
                    dirs.push(parent);
                }
            }
        }
    }
    if dirs.is_empty() {
        return Err("候选固定 CUDA 运行库未形成有效 DLL 目录".into());
    }
    Ok(dirs)
}
fn hip_dirs(engine: &Path, build: &Value) -> Result<Vec<String>, String> {
    if build["backend"] != "hip" {
        return Err("固定 HIP 引擎的版本元数据不匹配，未停服务".into());
    }
    let root = dunce::canonicalize(engine).map_err(|e| e.to_string())?;
    let mut directories = vec![root.to_string_lossy().into_owned()];
    if let Some(paths) = build.get("lib_dirs").filter(|v| !v.is_null()) {
        let paths = paths
            .as_array()
            .ok_or("HIP lib_dirs 元数据无效，未停服务")?;
        for relative in paths {
            let relative = Path::new(relative.as_str().ok_or("HIP lib_dirs 路径无效")?);
            if relative.is_absolute()
                || relative
                    .components()
                    .any(|c| !matches!(c, std::path::Component::Normal(_)))
            {
                return Err("HIP lib_dirs 必须位于固定候选引擎目录内，未停服务".into());
            }
            let path = dunce::canonicalize(root.join(relative))
                .map_err(|_| "固定 HIP 运行库目录缺失，未停服务")?;
            if !path.is_dir() || !path.starts_with(&root) {
                return Err("固定 HIP 运行库路径不属于候选引擎，未停服务".into());
            }
            let path = path.to_string_lossy().into_owned();
            if !directories.contains(&path) {
                directories.push(path);
            }
        }
    }
    Ok(directories)
}
fn extract_engine(
    archive: &Path,
    root: &Path,
    mut cancel: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if zip.len() > 4096 {
        return Err("引擎压缩包条目过多".into());
    }
    let mut total = 0u64;
    for i in 0..zip.len() {
        cancel()?;
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name();
        if name.contains(['\\', ':', '\0'])
            || name.starts_with('/')
            || name.split('/').any(|p| p == ".." || p == ".")
        {
            return Err("引擎压缩包含不安全路径".into());
        }
        let path = root.join(entry.enclosed_name().ok_or("引擎压缩路径越界")?);
        if entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            return Err("引擎压缩包包含符号链接".into());
        }
        total = total.checked_add(entry.size()).ok_or("引擎大小溢出")?;
        if total > 2 * 1024 * 1024 * 1024 {
            return Err("引擎解包超过安全上限".into());
        }
        if entry.is_dir() {
            fs::create_dir_all(&path).map_err(|e| e.to_string())?;
            continue;
        }
        fs::create_dir_all(path.parent().ok_or("引擎路径无效")?).map_err(|e| e.to_string())?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        let mut bytes = [0u8; 65536];
        loop {
            cancel()?;
            let n = entry.read(&mut bytes).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            file.write_all(&bytes[..n]).map_err(|e| e.to_string())?;
        }
        file.sync_all().map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                path,
                fs::Permissions::from_mode(if entry.unix_mode().is_some_and(|m| m & 0o111 != 0) {
                    0o700
                } else {
                    0o600
                }),
            )
            .map_err(|e| e.to_string())?;
        }
    }
    if !root.join("BUILD.json").is_file()
        || !root
            .join(if cfg!(windows) {
                "strata.exe"
            } else {
                "strata"
            })
            .is_file()
    {
        return Err("引擎包缺少版本或可执行文件".into());
    }
    Ok(())
}

fn registry_replace(
    state: &RuntimeState,
    expected: &ServiceProfile,
    target: &ServiceProfile,
) -> Result<(), String> {
    let mut db = state.database.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let raw: String = tx
        .query_row(
            "SELECT profile FROM local_installations WHERE id=?1",
            [&expected.id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string())?
        != serde_json::to_value(expected).map_err(|e| e.to_string())?
    {
        return Err("安装登记已被其它操作改变，未覆盖登记".into());
    }
    tx.execute(
        "UPDATE local_installations SET profile=?1 WHERE id=?2",
        params![
            serde_json::to_string(target).map_err(|e| e.to_string())?,
            target.id
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
async fn start_candidate(state: Arc<RuntimeState>, profile: ServiceProfile) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let _operation = state.runtime_operations.lock().map_err(|e| e.to_string())?;
        state.assert_single_model(&profile.id)?;
        let tasks: processes::Tasks = Arc::new(Mutex::new(HashMap::new()));
        let plan = crate::prepare_startup(&profile, &state.processes, &tasks)?;
        let secret = http::key(&profile.id)?;
        crate::start_prepared_service(&state, profile, plan, secret)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
async fn owned_stop(state: &RuntimeState, id: &str) -> Result<(), String> {
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
    if let Some(process) = processes.get_mut(id) {
        process.stop()?;
    }
    Ok(())
}
async fn switch(state: Arc<RuntimeState>, journal: &mut Journal) -> Result<Verification, String> {
    switch_with(state, journal, ObserverWait::DEFAULT).await
}
async fn switch_with(
    state: Arc<RuntimeState>,
    journal: &mut Journal,
    wait: ObserverWait,
) -> Result<Verification, String> {
    cancelled(&state, &journal.task_id)?;
    let mode = verification_mode(&state);
    let candidate = journal.candidate.clone().ok_or("候选尚未准备")?;
    if installation::file_hash(Path::new(&journal.old.config_path))? != journal.old_config_sha256 {
        return Err("准备期间原配置已变化，保持原安装；重新检查更新即可使用新配置".into());
    }
    if Some(installation::file_hash(Path::new(&candidate.config_path))?)
        != journal.candidate_config_sha256
    {
        return Err("候选配置已变化，未停服务".into());
    }
    wait_out_recent_requests(&state, journal, &candidate, wait).await?;
    let _selection = state.selection_lock.lock().await;
    state
        .selection_changing
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "正在切换模型")?;
    let _flag = SelectionFlag(state.clone());
    crate::tuning::assert_no_active_tuning(&state)?;
    let ensure = {
        let mut locks = state.ensure_locks.lock().await;
        locks.entry(journal.profile_id.clone()).or_default().clone()
    };
    let _ensure = ensure.lock().await;
    state.assert_single_model(&journal.profile_id)?;
    journal.was_running = {
        let mut p = state.processes.lock().map_err(|e| e.to_string())?;
        p.get_mut(&journal.profile_id)
            .map(|p| p.refresh())
            .transpose()?
            .is_some_and(|s| s.running && s.owned)
    };
    let gate = if journal.was_running {
        state.owned_gui_profile(&journal.profile_id)?;
        let health = http::strata_request(
            &state,
            journal.old.clone(),
            "/health".into(),
            "GET".into(),
            None,
        )
        .await?;
        if health["service"] != "strata" || health["status"] != "ok" {
            return Err("原服务健康无法核验，保留现有服务".into());
        }
        journal.was_loaded = health["loaded"].as_bool().ok_or("原服务加载状态无法核验")?;
        let gate = maintenance::begin(&state, &journal.profile_id, None, "drain")?;
        stage(
            &state,
            journal,
            "waitingIdle",
            "正在关闭新请求准入并等待已在执行的请求结束",
        )?;
        tokio::select! {result=maintenance::wait_idle(&state,&journal.old)=>result?, _=wait_cancel(&state,&journal.task_id)=>return Err("运行时更新已取消；原服务保持运行".into())};
        // A previously admitted /load or /unload may finish while admission is
        // draining. Restore the quiescent state, not the earlier health sample.
        let frozen = http::strata_request(
            &state,
            journal.old.clone(),
            "/health".into(),
            "GET".into(),
            None,
        )
        .await?;
        if frozen["service"] != "strata" || frozen["status"] != "ok" {
            return Err("排空后原服务健康无法核验，未切换安装".into());
        }
        journal.was_loaded = frozen["loaded"]
            .as_bool()
            .ok_or("排空后原服务加载状态无法核验")?;
        Some(gate)
    } else {
        if crate::external::port_accepting(&journal.old)?
            || crate::discovery::has_running_installation(Path::new(&journal.old.install_dir))?
        {
            return Err(
                "原安装由其它程序运行，更新不能停止外部实例；请先完成本应用安全接管".into(),
            );
        }
        None
    };
    cancelled(&state, &journal.task_id)?;
    if installation::file_hash(Path::new(&journal.old.config_path))? != journal.old_config_sha256 {
        return Err("等待空闲期间原配置发生变化，未切换".into());
    }
    // Already admitted /settings saves may finish while admission is draining.
    // Re-capture after they have completed, before stopping the old process.
    refresh_shared_settings(&journal.old, &candidate)?;
    if installation::file_hash(Path::new(&journal.old.config_path))? != journal.old_config_sha256 {
        return Err("共享设置发布期间原配置发生变化，未停服务或覆盖原配置".into());
    }
    if Some(installation::file_hash(Path::new(&candidate.config_path))?)
        != journal.candidate_config_sha256
    {
        return Err("共享设置发布期间候选配置发生变化，未停服务".into());
    }
    // The recovery journal is durable BEFORE the first controlled stop or registry mutation.
    stage(
        &state,
        journal,
        "switching",
        "服务已空闲，正在受控切换候选；失败将恢复原版本与加载状态",
    )?;
    let mut token = gate.as_ref().map(|g| g.token().to_owned());
    let mut startup_gate = None;
    let result = async {
        if let Some(token) = &token {
            unload(&state, &journal.old, Some(token)).await?;
            maintenance::wait_idle(&state, &journal.old).await?;
        }
        owned_stop(&state, &journal.profile_id).await?;
        registry_replace(&state, &journal.old, &candidate)?;
        if token.is_none() {
            let reserved = reserve_stopped(&state, &candidate, wait.stale_ms)?;
            if reserved.cleared_stale > 0 {
                processes::log(&state.logs, &journal.task_id, "warn", format!("服务已停止，已自动清理 {} 条超过 {} 秒的残留请求记录（上次引擎被强制结束时遗留），未改动使用统计与历史", reserved.cleared_stale, wait.stale_ms / 1000));
                processes::persist_task_logs(&state.database, &state.logs, &journal.task_id)?;
            }
            token = Some(reserved.token.clone());
            startup_gate = Some(reserved);
        }
        cancelled(&state, &journal.task_id)?;
        start_candidate(state.clone(), candidate.clone()).await?;
        if mode == Verification::Full {
            stage(
                &state,
                journal,
                "verifying",
                "完整验收：正在核验候选 API、模型加载与完整短请求",
            )?;
            verify(
                &state,
                &candidate,
                token.as_deref(),
                Some(&journal.task_id),
                true,
                true,
            )
            .await?;
            maintenance::wait_idle(&state, &candidate).await?;
            if !journal.was_loaded {
                unload(&state, &candidate, token.as_deref()).await?;
                verify(
                    &state,
                    &candidate,
                    token.as_deref(),
                    Some(&journal.task_id),
                    false,
                    false,
                )
                .await?;
            }
        } else {
            stage(
                &state,
                journal,
                "verifying",
                "快速校验：正在核验新版服务健康（不加载模型）",
            )?;
            let health = verify_health(&state, &candidate, Some(&journal.task_id)).await?;
            // A runtime without lazy start may load on its own; keep the
            // pre-update unloaded state instead of leaving VRAM in use.
            if !journal.was_loaded && health["loaded"] == true {
                unload(&state, &candidate, token.as_deref()).await?;
            }
        }
        if !journal.was_running {
            owned_stop(&state, &journal.profile_id).await?;
        }
        cancelled(&state, &journal.task_id)?;
        stage(
            &state,
            journal,
            "committed",
            match mode {
                Verification::Full => "候选健康、加载与短请求已验收，更新完成；保留原安装以便恢复",
                Verification::Quick if journal.was_running && journal.was_loaded => "新版服务健康检查通过，更新完成；正在后台重新加载模型，保留原安装以便恢复",
                Verification::Quick => "新版服务健康检查通过，更新完成；保留原安装以便恢复",
            },
        )?;
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = result {
        journal.error = Some(error.clone());
        let journal_write_error = stage(
            &state,
            journal,
            "rollingBack",
            "候选未通过验收或更新取消，正在恢复原安装与原加载状态",
        )
        .err();
        let restored = rollback(state.clone(), journal, token.as_deref()).await;
        match restored {
            Ok(()) => {
                if let Err(persist_error) = stage(
                    &state,
                    journal,
                    "rolledBack",
                    "原安装登记与服务加载状态已恢复；候选保留用于诊断",
                ) {
                    return Err(format!(
                        "原运行时已恢复，但恢复记录保存失败：{persist_error}；更新失败：{error}"
                    ));
                }
                if let Some(persist_error) = journal_write_error {
                    processes::log(
                        &state.logs,
                        &journal.task_id,
                        "warning",
                        format!("切换记录保存失败，原运行时已恢复：{persist_error}"),
                    );
                }
                return Err(format!("更新失败或取消，已恢复原运行时：{error}"));
            }
            Err(rollback) => {
                journal.error = Some(format!("{error}；恢复失败：{rollback}"));
                stage(
                    &state,
                    journal,
                    "rollbackFailed",
                    "更新恢复失败；原文件未修改，请通过诊断重新准备原模型",
                )?;
                return Err(journal.error.clone().unwrap_or_default());
            }
        }
    }
    drop(startup_gate);
    drop(gate);
    if mode == Verification::Quick && journal.was_running && journal.was_loaded {
        spawn_background_load(state.clone(), candidate, journal.task_id.clone());
    }
    Ok(mode)
}
/// Restores the pre-update loaded state after a quick-check commit. The update
/// has already completed: a failure is reported as a warning and never rolls
/// back (the previous runtime stays installed for a manual switch back).
pub(crate) fn spawn_background_load(
    state: Arc<RuntimeState>,
    profile: ServiceProfile,
    task_id: String,
) -> tokio::task::JoinHandle<Result<(), String>> {
    tokio::spawn(async move {
        let log = |level: &str, message: String| {
            processes::log(&state.logs, &task_id, level, message.clone());
            processes::log(&state.logs, &profile.id, level, message);
            let _ = processes::persist_task_logs(&state.database, &state.logs, &task_id);
        };
        log(
            "info",
            "正在后台重新加载更新前已加载的模型 / Reloading the previously loaded model in the background".into(),
        );
        let result = background_load(&state, &profile).await;
        match &result {
            Ok(()) => log(
                "info",
                "后台模型加载完成 / Background model load finished".into(),
            ),
            Err(error) => log(
                "warning",
                format!("后台重新加载模型失败：{error}；更新已完成且不会回滚，可手动加载模型，或在「已安装版本」切回原版本 / Background model load failed; the update stays in place: {error}"),
            ),
        }
        result
    })
}
async fn background_load(state: &RuntimeState, profile: &ServiceProfile) -> Result<(), String> {
    state.owned_gui_profile(&profile.id)?;
    let health =
        http::strata_request(state, profile.clone(), "/health".into(), "GET".into(), None).await?;
    if health["loaded"] == true {
        return Ok(());
    }
    // A cold load can take many minutes; this runs after the update has completed.
    let result = post(state, profile, "/load", json!({}), None, 1200).await?;
    if !matches!(result["status"].as_str(), Some("loaded" | "already loaded")) {
        return Err("模型加载返回无效状态".into());
    }
    Ok(())
}
async fn rollback(
    state: Arc<RuntimeState>,
    journal: &Journal,
    token: Option<&str>,
) -> Result<(), String> {
    owned_stop(&state, &journal.profile_id).await?;
    let current = state.registered_profile(&journal.profile_id)?;
    if let Some(candidate) = &journal.candidate {
        if serde_json::to_value(&current).map_err(|e| e.to_string())?
            == serde_json::to_value(candidate).map_err(|e| e.to_string())?
        {
            registry_replace(&state, candidate, &journal.old)?;
        } else if serde_json::to_value(&current).map_err(|e| e.to_string())?
            != serde_json::to_value(&journal.old).map_err(|e| e.to_string())?
        {
            return Err("登记已由其他操作改变，未覆盖新登记".into());
        }
    }
    if installation::file_hash(Path::new(&journal.old.config_path))? != journal.old_config_sha256 {
        return Err("原配置被其它程序改变；原文件保留，拒绝以旧记录启动".into());
    }
    if journal.was_running {
        start_candidate(state.clone(), journal.old.clone()).await?;
        verify(&state, &journal.old, token, None, journal.was_loaded, false).await?;
    }
    crate::store_set(
        &state,
        "activeLocalInstallation".into(),
        journal.old_active.clone(),
    )?;
    crate::store_set(
        &state,
        "localServiceDesired".into(),
        journal.old_desired.clone(),
    )?;
    Ok(())
}
async fn wait_cancel(state: &RuntimeState, id: &str) {
    loop {
        if cancelled(state, id).is_err() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
async fn unload(
    state: &RuntimeState,
    profile: &ServiceProfile,
    token: Option<&str>,
) -> Result<(), String> {
    let result = post(state, profile, "/unload", json!({}), token, 30).await?;
    if matches!(result["status"].as_str(), Some("unloaded" | "not loaded")) {
        Ok(())
    } else {
        Err("模型未确认安全卸载，拒绝完成切换".into())
    }
}
async fn post(
    state: &RuntimeState,
    profile: &ServiceProfile,
    path: &str,
    body: Value,
    token: Option<&str>,
    timeout: u64,
) -> Result<Value, String> {
    let mut request = http::request_builder(&state.client, profile, path, "POST", Some(body))?
        .timeout(Duration::from_secs(timeout));
    if let Some(token) = token {
        request = request
            .header("X-Strata-Manager-Maintenance-Token", token)
            .header("X-Strata-Manager-Tuning-Id", token);
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("运行时验收 {path} HTTP {status}"));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err("验收响应超过上限".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
async fn verify(
    state: &RuntimeState,
    profile: &ServiceProfile,
    token: Option<&str>,
    task: Option<&str>,
    load: bool,
    probe: bool,
) -> Result<(), String> {
    verify_health(state, profile, task).await?;
    if load {
        let result = if let Some(id) = task {
            tokio::select! {result=post(state,profile,"/load",json!({}),token,300)=>result?,_=wait_cancel(state,id)=>return Err("加载候选时取消更新".into())}
        } else {
            post(state, profile, "/load", json!({}), token, 300).await?
        };
        if !matches!(result["status"].as_str(), Some("loaded" | "already loaded")) {
            return Err("候选模型加载返回无效状态".into());
        }
    }
    let health =
        http::strata_request(state, profile.clone(), "/health".into(), "GET".into(), None).await?;
    if health["loaded"].as_bool() != Some(load) {
        return Err("运行时加载状态与验收要求不一致".into());
    }
    if probe {
        short_probe(state, profile, token, task).await?;
    }
    Ok(())
}
/// Waits up to 30 seconds for the owned service's `/health` to report a
/// healthy Strata; this is the quick update check.
async fn verify_health(
    state: &RuntimeState,
    profile: &ServiceProfile,
    task: Option<&str>,
) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(id) = task {
            cancelled(state, id)?;
        }
        state.owned_gui_profile(&profile.id)?;
        if let Ok(health) =
            http::strata_request(state, profile.clone(), "/health".into(), "GET".into(), None).await
        {
            if health["service"] == "strata" && health["status"] == "ok" {
                return Ok(health);
            }
            return Err("候选健康响应不是有效 Strata".into());
        }
        if Instant::now() >= deadline {
            return Err("候选 API 30 秒内未就绪".into());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
async fn short_probe(
    state: &RuntimeState,
    profile: &ServiceProfile,
    token: Option<&str>,
    task: Option<&str>,
) -> Result<(), String> {
    let config = storage::read(profile)?;
    let model = config["model_name"]
        .as_str()
        .unwrap_or("qwen3.8-flash-next");
    let mut request=http::request_builder(&state.client,profile,"/v1/chat/completions","POST",Some(json!({"model":model,"messages":[{"role":"user","content":"Reply with the single word READY."}],"temperature":0,"max_tokens":32,"stream":true,"chat_template_kwargs":{"enable_thinking":false},"strata_mcp":false,"tool_choice":"none"})))?.timeout(Duration::from_secs(60));
    if let Some(token) = token {
        request = request
            .header("X-Strata-Manager-Maintenance-Token", token)
            .header("X-Strata-Manager-Tuning-Id", token);
    }
    let response = if let Some(id) = task {
        tokio::select! {result = request.send() => result.map_err(|e| e.to_string())?, _ = wait_cancel(state, id) => return Err("候选短请求时取消更新".into())}
    } else {
        request.send().await.map_err(|e| e.to_string())?
    };
    if !response.status().is_success() {
        return Err(format!("候选短请求 HTTP {}", response.status()));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    loop {
        let next = if let Some(id) = task {
            tokio::select! {next=stream.next()=>next,_=wait_cancel(state,id)=>return Err("候选短请求时取消更新".into())}
        } else {
            stream.next().await
        };
        let Some(chunk) = next else {
            break;
        };
        let chunk = chunk.map_err(|e| e.to_string())?;
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err("候选短请求超出上限".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let text = String::from_utf8(bytes).map_err(|_| "候选短请求 UTF-8 无效")?;
    let mut done = false;
    let mut finish = false;
    let mut visible = false;
    for line in text.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data == "[DONE]" {
            done = true;
            continue;
        }
        let event: Value = serde_json::from_str(data).map_err(|_| "候选 SSE 数据无效")?;
        if event.get("error").is_some() {
            return Err("候选短请求包含流错误".into());
        }
        let choice = &event["choices"][0];
        finish |= choice["finish_reason"]
            .as_str()
            .is_some_and(|s| matches!(s, "stop" | "length"));
        visible |= choice["delta"]["content"]
            .as_str()
            .is_some_and(|s| !s.is_empty());
    }
    if !(done && finish && visible) {
        return Err("候选短请求未完整结束或没有可见输出".into());
    }
    Ok(())
}

/// No process is started here. Called after the supervisor's exclusive ownership lock.
pub fn recover(state: &RuntimeState) -> Result<(), String> {
    release_zip::recover(state)?;
    let rows = {
        let db = state.database.lock().map_err(|e| e.to_string())?;
        db.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        let mut query = db
            .prepare("SELECT journal FROM runtime_upgrades ORDER BY updated_at,task_id")
            .map_err(|e| e.to_string())?;
        let values = query
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        values
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    for row in rows {
        let mut journal: Journal = serde_json::from_str(&row).map_err(|e| e.to_string())?;
        if matches!(
            journal.phase.as_str(),
            "switching" | "verifying" | "rollingBack" | "rollbackFailed"
        ) {
            match recover_identity(state, &journal) {
                Ok(()) => {
                    journal.phase = "rolledBack".into();
                    journal.error = Some(
                        "后台在候选验收前退出，已恢复原安装登记；按原加载状态恢复服务。".into(),
                    );
                }
                Err(error) => {
                    journal.phase = "rollbackFailed".into();
                    journal.error = Some(format!("中断更新恢复未完成：{error}；原文件保留，修复原因后重新打开应用以重试恢复。"));
                    if crate::store_get(state, "activeLocalInstallation".into())?.as_str()
                        == Some(&journal.profile_id)
                    {
                        crate::store_set(state, "localServiceDesired".into(), json!(false))?;
                    }
                }
            }
        } else if matches!(
            journal.phase.as_str(),
            "checking"
                | "preparingSource"
                | "preparingPython"
                | "preparingEngine"
                | "candidateReady"
                | "waitingIdle"
        ) {
            journal.phase = "cancelled".into();
            journal.error = Some(
                "后台在准备阶段退出；原安装未切换，候选文件保留供诊断，重新检查即可重试。".into(),
            );
        } else {
            continue;
        }
        journal.updated_at = now();
        persist(state, &journal)?;
        let mut tasks = state.tasks.lock().map_err(|e| e.to_string())?;
        if let Some(task) = tasks.get_mut(&journal.task_id) {
            task.status.state = if journal.phase == "cancelled" {
                "cancelled"
            } else {
                "failed"
            }
            .into();
            task.status.message = journal
                .error
                .clone()
                .unwrap_or_else(|| "更新中断，请检查运行时恢复诊断".into());
            task.status.finished_at = Some(now());
            processes::persist_task(&state.database, task)?;
        }
    }
    Ok(())
}
fn recover_identity(state: &RuntimeState, journal: &Journal) -> Result<(), String> {
    if crate::external::port_accepting(&journal.old)?
        || crate::discovery::has_running_installation(Path::new(&journal.old.install_dir))?
        || journal
            .candidate
            .as_ref()
            .map(|p| crate::discovery::has_running_installation(Path::new(&p.install_dir)))
            .transpose()?
            .unwrap_or(false)
    {
        return Err("检测到尚存实例，未停止进程或修改登记。请先关闭对应旧后台/实例".into());
    }
    if installation::file_hash(Path::new(&journal.old.config_path))? != journal.old_config_sha256 {
        return Err("原配置在更新中断后改变，请核对配置；未以旧记录覆盖文件或启动服务".into());
    }
    let current = state.registered_profile(&journal.profile_id)?;
    if let Some(candidate) = &journal.candidate {
        if serde_json::to_value(&current).map_err(|e| e.to_string())?
            == serde_json::to_value(candidate).map_err(|e| e.to_string())?
        {
            registry_replace(state, candidate, &journal.old)?;
        } else if serde_json::to_value(&current).map_err(|e| e.to_string())?
            != serde_json::to_value(&journal.old).map_err(|e| e.to_string())?
        {
            return Err("登记已由其它操作改变，未覆盖新的登记".into());
        }
    }
    crate::store_set(
        state,
        "activeLocalInstallation".into(),
        journal.old_active.clone(),
    )?;
    crate::store_set(
        state,
        "localServiceDesired".into(),
        journal.old_desired.clone(),
    )?;
    if journal.was_running {
        crate::store_set(
            state,
            "runtimeUpgradeRecoveryLoad".into(),
            json!({"profileId":journal.profile_id,"loaded":journal.was_loaded}),
        )?;
    }
    Ok(())
}
pub(crate) fn recovery_load(state: &RuntimeState, id: &str) -> Result<Option<bool>, String> {
    let value = crate::store_get(state, "runtimeUpgradeRecoveryLoad".into())?;
    Ok(if value["profileId"].as_str() == Some(id) {
        value["loaded"].as_bool()
    } else {
        None
    })
}
pub(crate) fn clear_recovery_load(state: &RuntimeState, id: &str) -> Result<(), String> {
    if recovery_load(state, id)?.is_some() {
        crate::store_set(state, "runtimeUpgradeRecoveryLoad".into(), Value::Null)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn windows_release_fixture() -> Value {
        json!({
            "tag_name":"v0.1.42", "body":"Official release notes",
            "assets":[{"name":"strata-windows-x64.zip","size":1024,
                "browser_download_url":"https://github.com/Niko1221/Strata/releases/download/v0.1.42/strata-windows-x64.zip",
                "digest":format!("sha256:{}","a".repeat(64))}]
        })
    }

    const OBSERVER_ROWS: &str = "CREATE TABLE IF NOT EXISTS active_requests(request_id TEXT PRIMARY KEY,service_id TEXT NOT NULL,session_id TEXT NOT NULL,started_ms INTEGER NOT NULL);";
    fn stopped_fixture(temp: &tempfile::TempDir) -> (Arc<RuntimeState>, ServiceProfile) {
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let install = temp.path().join("install");
        fs::create_dir_all(&install).unwrap();
        let profile = ServiceProfile {
            id: "stale-fixture".into(),
            name: "stale".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            install_dir: install.to_string_lossy().into(),
            python_path: "python".into(),
            config_path: temp.path().join("c.json").to_string_lossy().into(),
            managed: true,
        };
        let text = serde_json::to_string(&profile).unwrap();
        state
            .database
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO local_installations VALUES(?1,?2,?3,0)",
                params![profile.id, text, text],
            )
            .unwrap();
        (state, profile)
    }
    fn seed_requests(state: &RuntimeState, rows: &[(&str, &str, i64)]) -> rusqlite::Connection {
        let directory = installation::owned_directory(state.data_dir(), &["analytics"]).unwrap();
        let db = rusqlite::Connection::open(directory.join("journal.sqlite3")).unwrap();
        db.execute_batch(OBSERVER_ROWS).unwrap();
        for (id, service, started) in rows {
            db.execute(
                "INSERT INTO active_requests VALUES(?1,?2,'old-session',?3)",
                params![id, service, started],
            )
            .unwrap();
        }
        db
    }
    fn count(db: &rusqlite::Connection, service: &str) -> i64 {
        db.query_row(
            "SELECT COUNT(*) FROM active_requests WHERE service_id=?1",
            [service],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn orphaned_observer_rows_of_a_stopped_service_are_cleared_and_counted() {
        let temp = tempfile::tempdir().unwrap();
        let (state, profile) = stopped_fixture(&temp);
        let now_ms = now();
        let hour = 3_600_000_i64;
        let db = seed_requests(
            &state,
            &[
                ("a", "stale-fixture", now_ms as i64 - hour),
                ("b", "stale-fixture", 0),
                ("c", "stale-fixture", now_ms as i64 + hour),
                ("other", "other-service", now_ms as i64),
            ],
        );
        db.execute_batch("CREATE TABLE events(seq INTEGER PRIMARY KEY,payload TEXT); INSERT INTO events VALUES(1,'keep');").unwrap();
        let gate = reserve_stopped_at(&state, &profile, now_ms, STALE_ACTIVE_REQUEST_MS).unwrap();
        assert_eq!(gate.cleared_stale, 3);
        assert_eq!(count(&db, "stale-fixture"), 0);
        assert_eq!(count(&db, "other-service"), 1);
        let events: i64 = db
            .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(events, 1);
        assert!(gate.path.exists());
    }

    #[test]
    fn a_recent_row_still_blocks_with_count_and_age_and_changes_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let (state, profile) = stopped_fixture(&temp);
        let now_ms = now();
        let db = seed_requests(
            &state,
            &[
                ("old", "stale-fixture", 0),
                ("fresh", "stale-fixture", now_ms as i64 - 30_000),
            ],
        );
        let error = reserve_stopped_at(&state, &profile, now_ms, STALE_ACTIVE_REQUEST_MS)
            .err()
            .unwrap();
        assert!(
            error.contains("1 个未结束的请求") && error.contains("30 秒前"),
            "{error}"
        );
        assert!(error.contains("关闭其它正在使用 Strata 的程序"), "{error}");
        assert!(!error.contains("观察器"), "{error}");
        // The stale row is only dropped together with a successful reservation.
        assert_eq!(count(&db, "stale-fixture"), 2);
        assert!(!state
            .data_dir()
            .join("analytics/stale-fixture.maintenance")
            .exists());
        // The same fresh row has become an orphan two minutes later.
        let gate = reserve_stopped_at(&state, &profile, now_ms + 130_000, STALE_ACTIVE_REQUEST_MS)
            .unwrap();
        assert_eq!(gate.cleared_stale, 2);
        assert_eq!(count(&db, "stale-fixture"), 0);
    }

    #[test]
    fn a_stopped_service_without_rows_reserves_with_nothing_cleared() {
        let temp = tempfile::tempdir().unwrap();
        let (state, profile) = stopped_fixture(&temp);
        let gate = reserve_stopped_at(&state, &profile, now(), STALE_ACTIVE_REQUEST_MS).unwrap();
        assert_eq!(gate.cleared_stale, 0);
    }

    #[test]
    fn the_0_2_0_beta_release_is_recognised_and_its_feed_packages_are_cached_as_installable() {
        let release: Value = serde_json::from_str(include_str!(
            "runtime_upgrade/fixtures/release-v0.2.0-beta.json"
        ))
        .unwrap();
        let mut info = release_update_info(&release).unwrap();
        assert_eq!(info.latest_version.as_deref(), Some("0.2.0-beta"));
        assert!(info.update_available && info.assets.is_empty());
        let feed = engine_package::verify_feed(
            include_bytes!("runtime_upgrade/fixtures/strata-feed.json"),
            include_bytes!("runtime_upgrade/fixtures/strata-feed.json.sig"),
            None,
            now(),
        )
        .unwrap();
        info.assets =
            engine_package::feed_assets(&feed, &release, "v0.2.0-beta", "windows-x86_64").unwrap();
        info.installable = zip_installable(&info.assets, "windows", "x86_64");
        let revision = "3d1fb48090e8f2cefc22d7b5845fb7f5b71f33fa";
        info.source_revision = Some(revision.into());
        info.source_archive_url = Some(format!(
            "https://codeload.github.com/Niko1221/Strata/zip/{revision}"
        ));
        info.feed_sequence = Some(101);
        let cached = serde_json::to_value(&info).unwrap();
        assert_eq!(cached["feedSequence"], 101);
        assert_eq!(cached["assets"][0]["engineVersion"], "0.1.45.3");
        let restored: RuntimeUpdateInfo = serde_json::from_value(cached.clone()).unwrap();
        assert_eq!(restored.assets.len(), 4);
        if cfg!(all(windows, target_arch = "x86_64")) {
            assert!(cached_installation_metadata(cached.clone(), info.checked_at).is_some());
            let mut forged = cached;
            forged["assets"][0]["engineVersion"] = json!("9.9.9");
            assert!(cached_installation_metadata(forged, info.checked_at).is_none());
        }
        assert!(newer_than_supported("0.2.0-beta") && !newer_than_supported("0.1.41-rc"));
    }

    #[test]
    fn linux_x86_64_installs_its_own_0_2_0_feed_packages_only() {
        let release: Value = serde_json::from_str(include_str!(
            "runtime_upgrade/fixtures/release-v0.2.0-beta.json"
        ))
        .unwrap();
        let mut info = release_update_info(&release).unwrap();
        let feed = engine_package::verify_feed(
            include_bytes!("runtime_upgrade/fixtures/strata-feed.json"),
            include_bytes!("runtime_upgrade/fixtures/strata-feed.json.sig"),
            None,
            now(),
        )
        .unwrap();
        info.assets =
            engine_package::feed_assets(&feed, &release, "v0.2.0-beta", "linux-x86_64").unwrap();
        assert_eq!(info.assets.len(), 5);
        assert!(zip_installable(&info.assets, "linux", "x86_64"));
        // Linux packages never make Windows, macOS or Linux arm64 installable.
        for (os, arch) in [
            ("windows", "x86_64"),
            ("macos", "aarch64"),
            ("linux", "aarch64"),
        ] {
            assert!(!zip_installable(&info.assets, os, arch), "{os}/{arch}");
        }
        // Legacy Windows ZIPs stay visible but are not installable on Linux.
        let legacy = release_update_info(&windows_release_fixture()).unwrap();
        assert!(!zip_installable(&legacy.assets, "linux", "x86_64"));
        info.installable = zip_installable(&info.assets, "linux", "x86_64");
        let revision = "3d1fb48090e8f2cefc22d7b5845fb7f5b71f33fa";
        info.source_revision = Some(revision.into());
        info.source_archive_url = Some(format!(
            "https://codeload.github.com/Niko1221/Strata/zip/{revision}"
        ));
        let cached = serde_json::to_value(&info).unwrap();
        assert_eq!(cached["assets"][1]["nvidiaMinDriver"], "580.65");
        assert_eq!(
            cached_installation_metadata(cached, info.checked_at).is_some(),
            cfg!(all(target_os = "linux", target_arch = "x86_64"))
        );
    }

    fn installation_metadata_fixture(checked_at: u64) -> RuntimeUpdateInfo {
        let mut info = release_update_info(&windows_release_fixture()).unwrap();
        let revision = "61b3fb5dd3f1e8ec09cf7e4e05208bc6d3c46406";
        info.checked_at = checked_at;
        info.source_revision = Some(revision.into());
        info.source_archive_url = Some(format!(
            "https://codeload.github.com/Niko1221/Strata/zip/{revision}"
        ));
        info
    }

    #[cfg(all(windows, target_arch = "x86_64"))]
    #[test]
    fn installation_metadata_reuse_obeys_exact_age_and_clock_boundaries() {
        let checked_now = 2 * INSTALLATION_METADATA_MAX_AGE;
        for age in [
            0,
            INSTALLATION_METADATA_MAX_AGE - 1,
            INSTALLATION_METADATA_MAX_AGE,
        ] {
            let info = installation_metadata_fixture(checked_now - age);
            let cached = serde_json::to_value(&info).unwrap();
            assert!(cached_installation_metadata(cached, checked_now).is_some());
        }
        for checked_at in [
            checked_now - INSTALLATION_METADATA_MAX_AGE - 1,
            checked_now + 1,
            u64::MAX,
        ] {
            let cached = serde_json::to_value(installation_metadata_fixture(checked_at)).unwrap();
            assert!(cached_installation_metadata(cached, checked_now).is_none());
        }
    }

    #[test]
    fn installation_metadata_rejects_errors_capability_and_review_mismatch() {
        let checked_now = 2 * INSTALLATION_METADATA_MAX_AGE;
        let valid = serde_json::to_value(installation_metadata_fixture(checked_now)).unwrap();
        for (pointer, replacement) in [
            ("/error", json!("GitHub 403")),
            ("/installable", json!(false)),
            ("/supportedVersion", json!("other manager release")),
            ("/supportedRevision", json!("a".repeat(40))),
            ("/assets", json!([])),
            ("/sourceRevision", Value::Null),
        ] {
            let mut cached = valid.clone();
            *cached.pointer_mut(pointer).unwrap() = replacement;
            assert!(
                cached_installation_metadata(cached, checked_now).is_none(),
                "accepted invalid cached field {pointer}"
            );
        }
        assert!(cached_installation_metadata(Value::Null, checked_now).is_none());
    }

    #[test]
    fn installation_metadata_revalidates_official_source_and_asset_normalization() {
        let checked_now = 2 * INSTALLATION_METADATA_MAX_AGE;
        let valid = serde_json::to_value(installation_metadata_fixture(checked_now)).unwrap();
        for (pointer, replacement) in [
            ("/latestVersion", json!("0.1.42-preview")),
            ("/sourceRevision", json!("invalid")),
            ("/sourceArchiveUrl", json!("https://example.org/source.zip")),
            ("/assets/0/name", json!("unreviewed.zip")),
            ("/assets/0/variant", json!("cuda12")),
            ("/assets/0/url", json!("https://example.org/strata-windows-x64.zip")),
            ("/assets/0/url", json!("https://github.com/Niko1221/Strata/releases/download/v0.1.41/strata-windows-x64.zip")),
            ("/assets/0/sha256", json!("not a digest")),
            ("/assets/0/sha256", json!("A".repeat(64))),
            ("/assets/0/size", json!(0)),
            ("/assets/0/size", json!(1024u64 * 1024 * 1024 + 1)),
        ] {
            let mut cached = valid.clone();
            *cached.pointer_mut(pointer).unwrap() = replacement;
            assert!(
                cached_installation_metadata(cached, checked_now).is_none(),
                "accepted non-normalized cached field {pointer}"
            );
        }
    }

    #[cfg(all(windows, target_arch = "x86_64"))]
    #[tokio::test]
    async fn installation_metadata_reads_successful_database_cache_without_refreshing() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().to_path_buf()).unwrap();
        let info = installation_metadata_fixture(now());
        let expected = serde_json::to_value(&info).unwrap();
        crate::store_set(&state, UPDATE_INFO_KEY.into(), expected.clone()).unwrap();
        let current = update_info_for_installation(&state).await.unwrap();
        // A network refresh would replace this synthetic official digest and
        // fixture release; the installation lookup must retain the whole result.
        assert_eq!(serde_json::to_value(current).unwrap(), expected);
        assert_eq!(
            crate::store_get(&state, UPDATE_INFO_KEY.into()).unwrap(),
            expected
        );
    }

    #[test]
    fn windows_zip_capability_is_local_and_does_not_hide_release_metadata() {
        let info = release_update_info(&windows_release_fixture()).unwrap();
        assert!(zip_installable(&info.assets, "windows", "x86_64"));
        for (os, arch) in [
            ("linux", "x86_64"),
            ("macos", "x86_64"),
            ("windows", "aarch64"),
        ] {
            assert!(!zip_installable(&info.assets, os, arch));
        }
        assert!(!zip_installable(&[], "windows", "x86_64"));
        assert_eq!(info.assets.len(), 1);
        assert_eq!(info.notes.as_deref(), Some("Official release notes"));
        assert_eq!(
            info.installable,
            cfg!(all(target_os = "windows", target_arch = "x86_64"))
        );
        let mut refused = info;
        refused.installable = false;
        assert!(!constrain_installable(refused).installable);
    }

    #[tokio::test]
    async fn cached_platform_capability_is_revalidated_without_network_or_version_loss() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().to_path_buf()).unwrap();
        let mut info = release_update_info(&windows_release_fixture()).unwrap();
        // Portable data or an older manager may have cached a Windows proposal.
        info.installable = true;
        info.source_revision = Some("61b3fb5dd3f1e8ec09cf7e4e05208bc6d3c46406".into());
        crate::store_set(
            &state,
            UPDATE_INFO_KEY.into(),
            serde_json::to_value(&info).unwrap(),
        )
        .unwrap();
        drop(state);
        let reopened = RuntimeState::open(temp.path().to_path_buf()).unwrap();
        let current = update_info(&reopened, false).await.unwrap();
        assert_eq!(current.checked_at, info.checked_at);
        assert_eq!(current.source_revision, info.source_revision);
        assert_eq!(current.latest_version, info.latest_version);
        assert_eq!(current.notes, info.notes);
        assert_eq!(current.assets.len(), 1);
        assert_eq!(
            current.installable,
            cfg!(all(target_os = "windows", target_arch = "x86_64"))
        );
    }

    #[test]
    fn upstream_release_does_not_advertise_unreviewed_installation() {
        let info = release_update_info(&json!({
            "tag_name":"v0.1.42", "name":"Strata v0.1.42",
            "html_url":"https://github.com/Niko1221/Strata/releases/tag/v0.1.42",
            "body":"Faster decode and bug fixes", "published_at":"2026-10-10T16:10:01Z"
        }))
        .unwrap();
        assert_eq!(info.latest_version.as_deref(), Some("0.1.42"));
        assert_eq!(info.supported_version, VERSION);
        assert!(info.update_available);
        assert!(!info.installable);
        assert_eq!(info.notes.as_deref(), Some("Faster decode and bug fixes"));
        assert!(release_update_info(&json!({"tag_name":"unexpected"})).is_err());
        let foreign = release_update_info(
            &json!({"tag_name":"v0.1.41","html_url":"https://example.org/UPDATE.bat"}),
        )
        .unwrap();
        assert!(foreign.release_url.is_none());
    }

    #[tokio::test]
    async fn upstream_metadata_and_release_notes_survive_reopening_without_a_network_check() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().to_path_buf()).unwrap();
        let mut info =
            release_update_info(&json!({"tag_name":"v0.1.42","body":"Persisted release notes"}))
                .unwrap();
        info.source_revision = Some("61b3fb5dd3f1e8ec09cf7e4e05208bc6d3c46406".into());
        crate::store_set(
            &state,
            UPDATE_INFO_KEY.into(),
            serde_json::to_value(&info).unwrap(),
        )
        .unwrap();
        drop(state);
        let reopened = RuntimeState::open(temp.path().to_path_buf()).unwrap();
        let result = update_info(&reopened, false).await.unwrap();
        assert_eq!(result.checked_at, info.checked_at);
        assert_eq!(result.notes.as_deref(), Some("Persisted release notes"));
        assert_eq!(result.latest_version.as_deref(), Some("0.1.42"));
        assert!(!result.installable);
    }

    fn python() -> String {
        let mut command = Command::new(if cfg!(windows) { "py" } else { "python3" });
        command.args(["-I", "-S", "-c", "import sys;print(sys.executable)"]);
        processes::hidden(&mut command);
        let result = command
            .output()
            .expect("Python is required for isolated upgrade fixtures");
        assert!(result.status.success());
        String::from_utf8(result.stdout).unwrap().trim().into()
    }
    struct Fixture {
        state: Arc<RuntimeState>,
        old: ServiceProfile,
        candidate: ServiceProfile,
        journal: Journal,
        hashes: Vec<(PathBuf, String)>,
        _temp: tempfile::TempDir,
    }
    fn fixture() -> Fixture {
        let temp = if let Some(root) = std::env::var_os("STRATA_RUNTIME_UPGRADE_CRASH_ROOT") {
            tempfile::tempdir_in(root).unwrap()
        } else {
            tempfile::tempdir().unwrap()
        };
        let runtime = temp.path().join("user-import");
        fs::create_dir_all(runtime.join("serve")).unwrap();
        fs::create_dir(runtime.join("tokenizer")).unwrap();
        fs::write(
            runtime.join("setup.py"),
            "# immutable imported setup fixture",
        )
        .unwrap();
        fs::write(
            runtime.join("serve/server.py"),
            include_str!("../tests/fixtures/runtime_upgrade_service.py"),
        )
        .unwrap();
        for name in ["vocab.json", "merges.txt", "token_type.json"] {
            fs::write(runtime.join("tokenizer").join(name), "{}\n").unwrap();
        }
        fs::write(
            runtime.join("model.gguf"),
            "synthetic fixture weight bytes; never loaded",
        )
        .unwrap();
        fs::write(
            runtime.join("mcp-tool.py"),
            "# relative command fixture; not executed",
        )
        .unwrap();
        let data = temp.path().join("data");
        let state = RuntimeState::open(data.clone()).unwrap();
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let old = ServiceProfile {
            id: "upgrade-fixture".into(),
            name: "保留原名称".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            install_dir: runtime.to_string_lossy().into(),
            python_path: python(),
            config_path: data.join("original-managed.json").to_string_lossy().into(),
            managed: true,
        };
        let value = json!({"exe":old.python_path,"args":["--native","model.gguf","--mtp","draft.bin","--custom-value","retain"],"cwd":runtime,"tokenizer":"tokenizer","model_name":"upgrade-fixture-model","sampling":{"temperature":0.7},"custom":{"unknown":{"preserve":true}},"fixture_generation":"old"});
        fs::write(&old.config_path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        fs::write(
            runtime.join("source-config.json"),
            fs::read(&old.config_path).unwrap(),
        )
        .unwrap();
        fs::write(
            Path::new(&old.config_path).with_file_name("original-managed.shared-settings.json"),
            "{\"temperature\":0.31}\n",
        )
        .unwrap();
        state
            .database
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO local_installations VALUES(?1,?2,?3,?4)",
                params![
                    old.id,
                    serde_json::to_string(&old).unwrap(),
                    serde_json::to_string(&old).unwrap(),
                    now() as i64
                ],
            )
            .unwrap();
        crate::store_set(&state, "activeLocalInstallation".into(), json!(old.id)).unwrap();
        crate::store_set(&state, "localServiceDesired".into(), json!(true)).unwrap();
        let root = installation::owned_directory(state.data_dir(), &["runtimes"])
            .unwrap()
            .join("isolated-candidate");
        fs::create_dir_all(root.join("serve")).unwrap();
        fs::write(root.join("setup.py"), "# isolated candidate setup").unwrap();
        fs::write(
            root.join("serve/server.py"),
            include_str!("../tests/fixtures/runtime_upgrade_service.py"),
        )
        .unwrap();
        let mut candidate = old.clone();
        candidate.install_dir = root.to_string_lossy().into();
        candidate.config_path = root.join("config.json").to_string_lossy().into();
        let mut candidate_value = value;
        candidate_value["fixture_generation"] = json!("candidate");
        fs::write(
            &candidate.config_path,
            serde_json::to_vec_pretty(&candidate_value).unwrap(),
        )
        .unwrap();
        copy_shared_settings(&old, &candidate).unwrap();
        let task_id = uuid::Uuid::new_v4().to_string();
        let task = processes::TaskRecord {
            status: TaskStatus {
                id: task_id.clone(),
                kind: "update".into(),
                state: "running".into(),
                message: "isolated fixture".into(),
                started_at: now(),
                finished_at: None,
            },
            profile_id: Some(old.id.clone()),
            runtime_path: None,
            cancelled: false,
            process: None,
        };
        processes::persist_task(&state.database, &task).unwrap();
        state.tasks.lock().unwrap().insert(task_id.clone(), task);
        let journal = Journal {
            task_id,
            profile_id: old.id.clone(),
            phase: "candidateReady".into(),
            old: old.clone(),
            candidate: Some(candidate.clone()),
            old_config_sha256: installation::file_hash(Path::new(&old.config_path)).unwrap(),
            candidate_config_sha256: Some(
                installation::file_hash(Path::new(&candidate.config_path)).unwrap(),
            ),
            was_running: false,
            was_loaded: false,
            old_active: json!(old.id),
            old_desired: json!(true),
            error: None,
            updated_at: now(),
        };
        persist(&state, &journal).unwrap();
        let mut paths = vec![
            PathBuf::from(&old.config_path),
            runtime.join("setup.py"),
            runtime.join("serve/server.py"),
            runtime.join("source-config.json"),
            runtime.join("model.gguf"),
            runtime.join("mcp-tool.py"),
        ];
        paths.extend(
            ["vocab.json", "merges.txt", "token_type.json"]
                .map(|n| runtime.join("tokenizer").join(n)),
        );
        let hashes = paths
            .into_iter()
            .map(|p| {
                let hash = installation::file_hash(&p).unwrap();
                (p, hash)
            })
            .collect();
        Fixture {
            _temp: temp,
            state,
            old,
            candidate,
            journal,
            hashes,
        }
    }
    fn unchanged(f: &Fixture) {
        for (path, hash) in &f.hashes {
            assert_eq!(
                installation::file_hash(path).unwrap(),
                *hash,
                "source changed: {}",
                path.display()
            );
        }
    }
    fn gate(f: &Fixture) -> PathBuf {
        f.state
            .data_dir
            .join("analytics/upgrade-fixture.maintenance")
    }
    async fn health(f: &Fixture) -> Value {
        http::strata_request(
            &f.state,
            f.state.registered_profile(&f.old.id).unwrap(),
            "/health".into(),
            "GET".into(),
            None,
        )
        .await
        .unwrap()
    }
    fn full_verification(f: &Fixture) {
        crate::store_set(&f.state, FULL_VERIFICATION_KEY.into(), json!(true)).unwrap();
    }
    /// Quick mode reloads a previously loaded model after the switch commits.
    async fn wait_loaded(f: &Fixture, within: Duration) {
        let deadline = Instant::now() + within;
        while health(f).await["loaded"] != true {
            assert!(
                Instant::now() < deadline,
                "background model load did not finish"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    fn task_logs(f: &Fixture) -> Vec<String> {
        f.state
            .logs
            .lock()
            .unwrap()
            .get(&f.journal.task_id)
            .map(|lines| lines.iter().map(|line| line.message.clone()).collect())
            .unwrap_or_default()
    }
    async fn start_old(f: &Fixture, load: bool) -> u32 {
        start_candidate(f.state.clone(), f.old.clone())
            .await
            .unwrap();
        verify(&f.state, &f.old, None, None, load, false)
            .await
            .unwrap();
        f.state.owned_gui_profile(&f.old.id).unwrap();
        f.state
            .processes
            .lock()
            .unwrap()
            .get(&f.old.id)
            .unwrap()
            .child
            .id()
    }
    fn change_candidate(f: &mut Fixture, key: &str, value: Value) {
        let mut config = storage::read(&f.candidate).unwrap();
        config[key] = value;
        fs::write(
            &f.candidate.config_path,
            serde_json::to_vec_pretty(&config).unwrap(),
        )
        .unwrap();
        f.journal.candidate_config_sha256 =
            Some(installation::file_hash(Path::new(&f.candidate.config_path)).unwrap());
        persist(&f.state, &f.journal).unwrap();
    }

    #[test]
    fn migration_keeps_unknown_fields_model_cwd_and_mcp_relative_semantics() {
        let f = fixture();
        let mut config = storage::read(&f.old).unwrap();
        config["mcp_servers"] = json!({"relative":{"command":"./mcp-tool.py","args":["relative-input.json"],"env":{"TOKEN":"fixture-secret"}},"remote":{"url":"https://example.invalid/mcp"}});
        let engine = Path::new(&f.candidate.install_dir).join("engine");
        fs::create_dir(&engine).unwrap();
        let migrated =
            migrate_config(&f.old, &config, &engine, &["new-private-cuda".into()]).unwrap();
        assert_eq!(migrated["custom"], config["custom"]);
        assert_eq!(migrated["sampling"], config["sampling"]);
        assert_eq!(migrated["args"], config["args"]);
        assert_eq!(migrated["cwd"], json!(config_cwd(&f.old, &config).unwrap()));
        assert_eq!(
            migrated["tokenizer"],
            json!(dunce::canonicalize(Path::new(&f.old.install_dir).join("tokenizer")).unwrap())
        );
        assert_eq!(
            migrated["mcp_servers"]["relative"]["cwd"],
            json!(dunce::canonicalize(&f.old.install_dir).unwrap())
        );
        assert_eq!(
            migrated["mcp_servers"]["relative"]["args"],
            config["mcp_servers"]["relative"]["args"]
        );
        assert_eq!(
            migrated["mcp_servers"]["relative"]["env"],
            config["mcp_servers"]["relative"]["env"]
        );
        assert!(Path::new(
            migrated["mcp_servers"]["relative"]["command"]
                .as_str()
                .unwrap()
        )
        .is_absolute());
        let other = Path::new(&f.old.install_dir).join("mcp-working-directory");
        fs::create_dir(&other).unwrap();
        fs::write(other.join("mcp-tool.py"), "# different relative command").unwrap();
        config["mcp_servers"]["relative"]["cwd"] = json!(other);
        assert!(migrate_config(&f.old, &config, &engine, &[])
            .unwrap_err()
            .contains("不同 cwd"));
        config["mcp_servers"]["relative"]["command"] =
            json!(dunce::canonicalize(Path::new(&f.old.install_dir).join("mcp-tool.py")).unwrap());
        migrate_config(&f.old, &config, &engine, &[]).unwrap();
        config["before_load"] = json!("python hooks/release_gpu.py");
        assert!(migrate_config(&f.old, &config, &engine, &[])
            .unwrap_err()
            .contains("before_load"));
        unchanged(&f);
    }
    fn zip_bytes(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, body) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }
    #[test]
    fn engine_archive_rejects_traversal_and_honors_cancel_before_execution() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("engine.zip");
        let engine = temp.path().join("engine");
        fs::create_dir(&engine).unwrap();
        fs::write(&archive, zip_bytes(&[("../outside", "bad")])).unwrap();
        assert!(extract_engine(&archive, &engine, || Ok(())).is_err());
        assert!(!temp.path().join("outside").exists());
        fs::write(&archive, zip_bytes(&[("BUILD.json", "{}")])).unwrap();
        assert!(
            extract_engine(&archive, &engine, || Err("cancelled".into()))
                .unwrap_err()
                .contains("cancelled")
        );
        assert!(!engine.join("BUILD.json").exists());
        fs::write(
            &archive,
            zip_bytes(&[
                ("BUILD.json", "{\"version\":\"0.1.41\"}"),
                (
                    if cfg!(windows) {
                        "strata.exe"
                    } else {
                        "strata"
                    },
                    "never executed",
                ),
            ]),
        )
        .unwrap();
        extract_engine(&archive, &engine, || Ok(())).unwrap();
        assert_eq!(
            fs::read_to_string(engine.join("BUILD.json")).unwrap(),
            "{\"version\":\"0.1.41\"}"
        );
        fs::create_dir_all(engine.join("rocm/bin")).unwrap();
        let dirs = hip_dirs(&engine, &json!({"backend":"hip","lib_dirs":["rocm/bin"]})).unwrap();
        assert_eq!(dirs.len(), 2);
        assert_eq!(
            Path::new(&dirs[1]),
            dunce::canonicalize(engine.join("rocm/bin")).unwrap()
        );
        assert!(hip_dirs(&engine, &json!({"backend":"hip","lib_dirs":["../escape"]})).is_err());
        assert!(hip_dirs(&engine, &json!({"backend":"cuda","lib_dirs":["rocm/bin"]})).is_err());
    }
    #[test]
    fn shared_settings_refresh_preserves_latest_bytes_and_handles_creation_and_deletion() {
        let f = fixture();
        let source = shared_settings_path(&f.old);
        let target = shared_settings_path(&f.candidate);
        let latest = b"{\"temperature\":0.89,\"unknown\":{\"preserve\":true}}\n";
        fs::write(&source, latest).unwrap();
        refresh_shared_settings(&f.old, &f.candidate).unwrap();
        assert_eq!(fs::read(&source).unwrap(), latest);
        assert_eq!(fs::read(&target).unwrap(), latest);
        fs::remove_file(&source).unwrap();
        refresh_shared_settings(&f.old, &f.candidate).unwrap();
        assert!(!source.exists());
        assert!(!target.exists());
        fs::write(&source, latest).unwrap();
        refresh_shared_settings(&f.old, &f.candidate).unwrap();
        assert_eq!(fs::read(&target).unwrap(), latest);
        assert!(refresh_shared_settings(&f.old, &f.old)
            .unwrap_err()
            .contains("必须与原配置分离"));
        fs::write(&source, "{\"partialWrite\":").unwrap();
        assert!(refresh_shared_settings(&f.old, &f.candidate)
            .unwrap_err()
            .contains("不是有效 JSON"));
        assert_eq!(fs::read(&target).unwrap(), latest);
        assert_eq!(fs::read_to_string(&source).unwrap(), "{\"partialWrite\":");
        unchanged(&f);
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn admitted_settings_save_during_drain_refreshes_candidate_before_switch() {
        for action in ["replace", "create", "delete"] {
            let mut f = fixture();
            let source = shared_settings_path(&f.old);
            let target = shared_settings_path(&f.candidate);
            if action == "create" {
                fs::remove_file(&source).unwrap();
                fs::remove_file(&target).unwrap();
            }
            start_old(&f, true).await;
            let state = f.state.clone();
            let old = f.old.clone();
            let request = tokio::spawn(async move {
                post(
                    &state,
                    &old,
                    "/settings",
                    json!({"fixture_wait_for_drain":true,"delete":action=="delete","shared":{"temperature":0.89,"unknown":{"retain":true}}}),
                    None,
                    15,
                )
                .await
            });
            let signal = Path::new(&f.old.install_dir).join("old-saving-settings");
            let deadline = Instant::now() + Duration::from_secs(5);
            while !signal.exists() {
                assert!(
                    Instant::now() < deadline,
                    "settings request was not admitted"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            if action != "create" {
                assert_eq!(
                    read_shared_settings(&target).unwrap().unwrap(),
                    b"{\"temperature\":0.31}\n"
                );
            }
            switch(f.state.clone(), &mut f.journal).await.unwrap();
            assert_eq!(request.await.unwrap().unwrap()["status"], "saved");
            assert_eq!(f.journal.phase, "committed");
            assert_eq!(health(&f).await["generation"], "candidate");
            wait_loaded(&f, Duration::from_secs(10)).await;
            assert_eq!(
                read_shared_settings(&source).unwrap(),
                read_shared_settings(&target).unwrap()
            );
            if action == "delete" {
                assert!(!source.exists());
                assert!(!target.exists());
                assert_eq!(health(&f).await["shared"], json!({}));
            } else {
                assert_eq!(
                    health(&f).await["shared"],
                    json!({"temperature":0.89,"unknown":{"retain":true}})
                );
            }
            assert!(!gate(&f).exists());
            unchanged(&f);
            owned_stop(&f.state, &f.old.id).await.unwrap();
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn admitted_settings_write_with_main_config_edit_refuses_switch_without_overwriting() {
        let mut f = fixture();
        let before = start_old(&f, true).await;
        let candidate_before = fs::read(&f.candidate.config_path).unwrap();
        let old_before = fs::read(&f.old.config_path).unwrap();
        let target_before = fs::read(shared_settings_path(&f.candidate)).unwrap();
        let state = f.state.clone();
        let old = f.old.clone();
        let request = tokio::spawn(async move {
            post(
                &state,
                &old,
                "/settings",
                json!({"fixture_wait_for_drain":true,"fixture_edit_main_config":true,"shared":{"temperature":0.89}}),
                None,
                15,
            )
            .await
        });
        let signal = Path::new(&f.old.install_dir).join("old-saving-settings");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !signal.exists() {
            assert!(
                Instant::now() < deadline,
                "settings request was not admitted"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let error = switch(f.state.clone(), &mut f.journal).await.unwrap_err();
        assert!(error.contains("原配置发生变化"), "{error}");
        assert_eq!(request.await.unwrap().unwrap()["status"], "saved");
        let edited = fs::read(&f.old.config_path).unwrap();
        assert_ne!(edited, old_before);
        let value: Value = serde_json::from_slice(&edited).unwrap();
        assert_eq!(value["fixture_concurrent_main_edit"], true);
        assert_eq!(
            fs::read(&f.candidate.config_path).unwrap(),
            candidate_before
        );
        assert_eq!(
            fs::read(shared_settings_path(&f.candidate)).unwrap(),
            target_before
        );
        assert_eq!(health(&f).await["generation"], "old");
        assert_eq!(health(&f).await["loaded"], true);
        assert_eq!(health(&f).await["shared"], json!({"temperature":0.89}));
        assert_eq!(
            f.state
                .processes
                .lock()
                .unwrap()
                .get(&f.old.id)
                .unwrap()
                .child
                .id(),
            before
        );
        assert_eq!(
            f.state.registered_profile(&f.old.id).unwrap().install_dir,
            f.old.install_dir
        );
        assert!(!gate(&f).exists());
        for (path, expected) in &f.hashes {
            if path != Path::new(&f.old.config_path) {
                assert_eq!(installation::file_hash(path).unwrap(), *expected);
            }
        }
        assert_eq!(fs::read(&f.old.config_path).unwrap(), edited);
        owned_stop(&f.state, &f.old.id).await.unwrap();
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn owned_switch_verifies_real_http_process_and_preserves_all_imported_bytes() {
        let mut f = fixture();
        full_verification(&f);
        let before = start_old(&f, true).await;
        assert_eq!(
            switch(f.state.clone(), &mut f.journal).await.unwrap(),
            Verification::Full
        );
        assert_eq!(f.journal.phase, "committed");
        assert_ne!(
            f.state
                .processes
                .lock()
                .unwrap()
                .get(&f.old.id)
                .unwrap()
                .child
                .id(),
            before
        );
        let current = f.state.registered_profile(&f.old.id).unwrap();
        assert_eq!(current.install_dir, f.candidate.install_dir);
        assert_eq!(current.id, f.old.id);
        assert_eq!(current.name, f.old.name);
        assert_eq!(
            f.state.original_profiles().unwrap()[0].install_dir,
            f.old.install_dir
        );
        assert_eq!(health(&f).await["generation"], "candidate");
        assert_eq!(health(&f).await["loaded"], true);
        assert!(!gate(&f).exists());
        unchanged(&f);
        owned_stop(&f.state, &f.old.id).await.unwrap();
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn preparation_rejects_model_mutations_but_keeps_registered_health_readable() {
        let f = fixture();
        start_old(&f, true).await;
        f.state.runtime_upgrading.store(true, Ordering::Release);
        let current_health = f
            .state
            .clone()
            .dispatch(
                "strata_request",
                json!({"profile":f.old,"path":"/health","method":"GET"}),
            )
            .await
            .unwrap();
        assert_eq!(current_health["loaded"], true);
        let streaming_profile = f
            .state
            .clone()
            .dispatch("resolve_profile", json!({"profile":f.old}))
            .await
            .unwrap();
        assert_eq!(streaming_profile["installDir"], f.old.install_dir);
        for path in ["/unload", "/load", "/config", "/settings", "/mcp"] {
            let error = f
                .state
                .clone()
                .dispatch(
                    "strata_request",
                    json!({"profile":f.old,"path":path,"method":"POST","body":{}}),
                )
                .await
                .unwrap_err();
            assert!(error.contains("运行时正在"), "{path}: {error}");
        }
        assert!(crate::install_runtime(
            &f.state,
            f._temp
                .path()
                .join("forbidden-install")
                .to_string_lossy()
                .into()
        )
        .err()
        .unwrap()
        .contains("运行时正在"));
        assert!(crate::start_service(f.state.clone(), f.old.clone())
            .await
            .err()
            .unwrap()
            .contains("运行时正在"));
        assert!(crate::stop_service(&f.state, f.old.id.clone())
            .await
            .err()
            .unwrap()
            .contains("运行时正在"));
        assert_eq!(health(&f).await["loaded"], true);
        unchanged(&f);
        f.state.runtime_upgrading.store(false, Ordering::Release);
        owned_stop(&f.state, &f.old.id).await.unwrap();
    }
    #[cfg(all(windows, target_arch = "x86_64"))]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "Downloads fixed official source/engine, installs private Python dependencies/CUDA wheels, and verifies a candidate; does not execute an engine or use a GPU"]
    async fn real_fixed_engine_download_redirect_hash_and_extraction_without_execution() {
        let mut f = fixture();
        let asset = artifact(&json!({"backend":"cuda","cuda":13})).unwrap();
        let url = format!(
            "https://github.com/Niko1221/Strata/releases/download/v{VERSION}/{}",
            asset.name
        );
        let archive = installation::download_release(
            &f.state,
            &f.journal.task_id,
            &url,
            asset.sha,
            asset.size,
        )
        .await
        .unwrap();
        assert_eq!(fs::metadata(&archive).unwrap().len(), asset.size);
        assert_eq!(installation::file_hash(&archive).unwrap(), asset.sha);
        let destination = f._temp.path().join("verified-engine-only");
        fs::create_dir(&destination).unwrap();
        extract_engine(&archive, &destination, || Ok(())).unwrap();
        let build: Value =
            serde_json::from_slice(&fs::read(destination.join("BUILD.json")).unwrap()).unwrap();
        assert_eq!(build["version"], VERSION);
        assert!(fs::metadata(destination.join("strata.exe")).unwrap().len() > 0);
        assert!(f.state.processes.lock().unwrap().is_empty());
        unchanged(&f);
        println!(
            "official fixed engine bytes={} sha256={} version={VERSION}; no process started",
            asset.size, asset.sha
        );
        let config = storage::read(&f.old).unwrap();
        let asset = artifact(&json!({"backend":"cuda","cuda":13})).unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(300),
            prepare_candidate(f.state.clone(), &mut f.journal, &config, asset),
        )
        .await
        .expect("candidate preparation exceeded the isolated five-minute acceptance bound");
        if let Err(error) = result {
            let entries = f
                .state
                .logs
                .lock()
                .unwrap()
                .get(&f.journal.task_id)
                .cloned()
                .unwrap_or_default();
            let messages: Vec<_> = entries.iter().map(|entry| entry.message.as_str()).collect();
            panic!(
                "candidate preparation failed: {error}; logs: {}",
                messages.join("\n")
            );
        }
        let candidate = f.journal.candidate.as_ref().unwrap();
        assert_eq!(f.journal.phase, "candidateReady");
        assert_eq!(
            canonical_hash(&Path::new(&candidate.install_dir).join("serve/server.py")).unwrap(),
            SERVER_SHA256
        );
        assert_eq!(
            f.state.registered_profile(&f.old.id).unwrap().install_dir,
            f.old.install_dir
        );
        assert!(!cuda_dirs(Path::new(&candidate.install_dir), 13)
            .unwrap()
            .is_empty());
        let migrated = storage::read(candidate).unwrap();
        assert_eq!(migrated["args"], config["args"]);
        assert_eq!(migrated["custom"], config["custom"]);
        let mut python = Command::new(&candidate.python_path);
        python.args(["-I", "-c", "import sys,regex,jinja2,numpy,requests;assert sys.prefix!=sys.base_prefix;print('private dependencies import passed; no GPU loaded')"]);
        installation::run_owned(
            &f.state,
            &f.journal.task_id,
            python,
            "隔离验证候选私有 Python 依赖，不启动引擎",
        )
        .await
        .unwrap();
        assert!(f.state.processes.lock().unwrap().is_empty());
        unchanged(&f);
        println!("full fixed candidate source/private venv/pinned dependencies/CUDA libraries/engine/config passed; registry unchanged, original bytes unchanged, no service or GPU started");
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn load_and_probe_failures_restore_old_identity_and_loaded_state() {
        for failure in ["fixture_fail_load", "fixture_bad_probe"] {
            let mut f = fixture();
            full_verification(&f);
            start_old(&f, true).await;
            change_candidate(&mut f, failure, json!(true));
            assert!(switch(f.state.clone(), &mut f.journal)
                .await
                .unwrap_err()
                .contains("已恢复"));
            assert_eq!(f.journal.phase, "rolledBack");
            assert_eq!(
                f.state.registered_profile(&f.old.id).unwrap().install_dir,
                f.old.install_dir
            );
            assert_eq!(health(&f).await["generation"], "old");
            assert_eq!(health(&f).await["loaded"], true);
            assert!(!gate(&f).exists());
            unchanged(&f);
            owned_stop(&f.state, &f.old.id).await.unwrap();
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn previously_admitted_unload_during_drain_preserves_quiescent_unloaded_state() {
        let mut f = fixture();
        let mut original = storage::read(&f.old).unwrap();
        original["fixture_unload_during_drain"] = json!(true);
        fs::write(
            &f.old.config_path,
            serde_json::to_vec_pretty(&original).unwrap(),
        )
        .unwrap();
        f.journal.old_config_sha256 =
            installation::file_hash(Path::new(&f.old.config_path)).unwrap();
        for (path, hash) in &mut f.hashes {
            *hash = installation::file_hash(path).unwrap();
        }
        persist(&f.state, &f.journal).unwrap();
        start_old(&f, true).await;
        let request_state = f.state.clone();
        let old = f.old.clone();
        let request = tokio::spawn(async move {
            post(&request_state, &old, "/unload", json!({}), None, 15).await
        });
        let signal = Path::new(&f.old.install_dir).join("old-unloading");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !signal.exists() {
            assert!(
                Instant::now() < deadline,
                "pre-existing request did not reach the fixture"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(health(&f).await["loaded"], true);
        switch(f.state.clone(), &mut f.journal).await.unwrap();
        assert_eq!(request.await.unwrap().unwrap()["status"], "unloaded");
        assert!(!f.journal.was_loaded);
        assert_eq!(health(&f).await["generation"], "candidate");
        assert_eq!(health(&f).await["loaded"], false);
        unchanged(&f);
        owned_stop(&f.state, &f.old.id).await.unwrap();
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cancellation_during_candidate_loading_restores_old_and_external_requests_are_blocked()
    {
        let mut f = fixture();
        full_verification(&f);
        start_old(&f, true).await;
        change_candidate(&mut f, "fixture_slow_load", json!(true));
        let state = f.state.clone();
        let mut journal = f.journal.clone();
        let switching = tokio::spawn(async move {
            let outcome = switch(state, &mut journal).await;
            (outcome, journal)
        });
        let signal = Path::new(&f.old.install_dir).join("candidate-loading");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !signal.exists() {
            assert!(
                Instant::now() < deadline,
                "candidate did not reach real load handler"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let response = http::request_builder(
            &f.state.client,
            &f.candidate,
            "/load",
            "POST",
            Some(json!({})),
        )
        .unwrap()
        .send()
        .await
        .unwrap();
        assert_eq!(response.status().as_u16(), 503);
        crate::cancel_task(&f.state, f.journal.task_id.clone()).unwrap();
        let (outcome, journal) = tokio::time::timeout(Duration::from_secs(10), switching)
            .await
            .unwrap()
            .unwrap();
        assert!(outcome.unwrap_err().contains("已恢复"));
        assert_eq!(journal.phase, "rolledBack");
        assert_eq!(health(&f).await["generation"], "old");
        assert_eq!(health(&f).await["loaded"], true);
        assert!(!gate(&f).exists());
        unchanged(&f);
        owned_stop(&f.state, &f.old.id).await.unwrap();
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn preserves_unloaded_and_previously_stopped_states() {
        for (running, full) in [(true, false), (false, false), (true, true), (false, true)] {
            let mut f = fixture();
            if full {
                full_verification(&f);
            }
            if running {
                start_old(&f, false).await;
            }
            switch(f.state.clone(), &mut f.journal).await.unwrap();
            assert_eq!(f.journal.phase, "committed");
            if running {
                assert_eq!(health(&f).await["loaded"], false);
                owned_stop(&f.state, &f.old.id).await.unwrap();
            } else {
                assert!(!crate::external::port_accepting(&f.candidate).unwrap());
            }
            assert!(!gate(&f).exists());
            unchanged(&f);
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn interrupted_uncommitted_switch_recovers_registry_then_actual_old_service_on_reopen() {
        let mut f = fixture();
        start_old(&f, true).await;
        owned_stop(&f.state, &f.old.id).await.unwrap();
        registry_replace(&f.state, &f.old, &f.candidate).unwrap();
        f.journal.was_running = true;
        f.journal.was_loaded = true;
        f.journal.phase = "verifying".into();
        persist(&f.state, &f.journal).unwrap();
        let data = f.state.data_dir.clone();
        f.state.cleanup();
        let reopened = RuntimeState::open(data).unwrap();
        assert_eq!(
            reopened.registered_profile(&f.old.id).unwrap().install_dir,
            f.old.install_dir
        );
        assert_eq!(
            status(&reopened, f.old.id.clone()).unwrap().unwrap().phase,
            "rolledBack"
        );
        assert_eq!(recovery_load(&reopened, &f.old.id).unwrap(), Some(true));
        reopened.clone().restore_default().await.unwrap();
        let health = http::strata_request(
            &reopened,
            f.old.clone(),
            "/health".into(),
            "GET".into(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(health["generation"], "old");
        assert_eq!(health["loaded"], true);
        assert_eq!(recovery_load(&reopened, &f.old.id).unwrap(), None);
        unchanged(&f);
        owned_stop(&reopened, &f.old.id).await.unwrap();
    }
    #[test]
    fn changed_configuration_and_missing_tokenizer_refuse_without_overwrite() {
        let f = fixture();
        let mut config = storage::read(&f.old).unwrap();
        config["tokenizer"] = json!("missing");
        assert!(
            migrate_config(&f.old, &config, Path::new(&f.candidate.install_dir), &[])
                .unwrap_err()
                .contains("tokenizer")
        );
        let mut changed = f.old.clone();
        changed.name = "different registry owner".into();
        registry_replace(&f.state, &f.old, &changed).unwrap();
        assert!(registry_replace(&f.state, &f.old, &f.candidate)
            .unwrap_err()
            .contains("已被其它操作改变"));
        assert_eq!(
            f.state.registered_profile(&f.old.id).unwrap().name,
            changed.name
        );
        unchanged(&f);
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn public_update_command_returns_persisted_no_update_without_touching_newer_runtime() {
        let mut f = fixture();
        f.state.tasks.lock().unwrap().clear();
        let engine = Path::new(&f.old.install_dir).join("engine");
        fs::create_dir(&engine).unwrap();
        let executable = engine.join(if cfg!(windows) {
            "strata.exe"
        } else {
            "strata"
        });
        fs::write(&executable, "not executed, version check fixture").unwrap();
        fs::write(engine.join("BUILD.json"), "{\"version\":\"0.1.42\"}").unwrap();
        let mut config = storage::read(&f.old).unwrap();
        config["exe"] = json!(executable);
        // No-update is read-only even when a hook could not be migrated.
        config["before_load"] = json!("a relative hook that must never execute");
        fs::write(
            &f.old.config_path,
            serde_json::to_vec_pretty(&config).unwrap(),
        )
        .unwrap();
        for (path, hash) in &mut f.hashes {
            *hash = installation::file_hash(path).unwrap();
        }
        let task = f
            .state
            .clone()
            .dispatch("update_runtime", json!({"profile":f.old}))
            .await
            .unwrap();
        let id = task["id"].as_str().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let record = f
                .state
                .tasks
                .lock()
                .unwrap()
                .get(id)
                .unwrap()
                .status
                .clone();
            if record.state != "running" {
                assert_eq!(record.state, "completed", "{}", record.message);
                assert!(record.message.contains("没有更高"));
                break;
            }
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            status(&f.state, f.old.id.clone()).unwrap().unwrap().phase,
            "noUpdate"
        );
        assert!(!f.state.runtime_upgrading.load(Ordering::Acquire));
        assert_eq!(
            fs::read_dir(f.state.data_dir.join("runtimes"))
                .unwrap()
                .count(),
            1
        ); // only the prebuilt synthetic fixture
        unchanged(&f);
    }
    #[tokio::test]
    async fn candidate_config_drift_refuses_before_any_owned_service_stop() {
        let mut f = fixture();
        let before = start_old(&f, true).await;
        fs::write(&f.candidate.config_path, "{\"changedByOtherWriter\":true}").unwrap();
        assert!(switch(f.state.clone(), &mut f.journal)
            .await
            .unwrap_err()
            .contains("候选配置已变化"));
        assert_eq!(
            f.state
                .processes
                .lock()
                .unwrap()
                .get(&f.old.id)
                .unwrap()
                .child
                .id(),
            before
        );
        assert_eq!(health(&f).await["loaded"], true);
        assert!(!gate(&f).exists());
        unchanged(&f);
        owned_stop(&f.state, &f.old.id).await.unwrap();
    }
    #[test]
    fn recovery_retains_changed_original_and_reports_failure_then_retries_after_source_repair() {
        let mut f = fixture();
        let original = fs::read(&f.old.config_path).unwrap();
        registry_replace(&f.state, &f.old, &f.candidate).unwrap();
        f.journal.phase = "verifying".into();
        f.journal.was_running = true;
        f.journal.was_loaded = true;
        persist(&f.state, &f.journal).unwrap();
        fs::write(&f.old.config_path, "{\"userEdited\":true}").unwrap();
        recover(&f.state).unwrap();
        assert_eq!(
            status(&f.state, f.old.id.clone()).unwrap().unwrap().phase,
            "rollbackFailed"
        );
        assert_eq!(
            fs::read_to_string(&f.old.config_path).unwrap(),
            "{\"userEdited\":true}"
        );
        assert_eq!(
            f.state.registered_profile(&f.old.id).unwrap().install_dir,
            f.candidate.install_dir
        );
        assert_eq!(
            crate::store_get(&f.state, "localServiceDesired".into()).unwrap(),
            false
        );
        assert!(f
            .state
            .tasks
            .lock()
            .unwrap()
            .get(&f.journal.task_id)
            .unwrap()
            .status
            .message
            .contains("原配置"));
        fs::write(&f.old.config_path, original).unwrap();
        recover(&f.state).unwrap();
        assert_eq!(
            status(&f.state, f.old.id.clone()).unwrap().unwrap().phase,
            "rolledBack"
        );
        assert_eq!(
            f.state.registered_profile(&f.old.id).unwrap().install_dir,
            f.old.install_dir
        );
        assert_eq!(recovery_load(&f.state, &f.old.id).unwrap(), Some(true));
        unchanged(&f);
    }
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn hard_crash_during_candidate_verification_restores_old_service_on_reconnect() {
        use windows_sys::Win32::{
            Foundation::{
                CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES,
                INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
            },
            System::{
                Diagnostics::ToolHelp::{
                    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                    TH32CS_SNAPPROCESS,
                },
                Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
            },
        };
        const ACTOR: &str = "STRATA_RUNTIME_UPGRADE_CRASH_ROOT";
        if let Some(root) = std::env::var_os(ACTOR) {
            let mut f = fixture();
            start_old(&f, true).await;
            owned_stop(&f.state, &f.old.id).await.unwrap();
            registry_replace(&f.state, &f.old, &f.candidate).unwrap();
            start_candidate(f.state.clone(), f.candidate.clone())
                .await
                .unwrap();
            verify(&f.state, &f.candidate, None, None, true, true)
                .await
                .unwrap();
            f.journal.phase = "verifying".into();
            f.journal.was_running = true;
            f.journal.was_loaded = true;
            persist(&f.state, &f.journal).unwrap();
            let report = json!({"dataDir":f.state.data_dir,"old":f.old,"candidatePid":f.state.processes.lock().unwrap().get("upgrade-fixture").unwrap().child.id(),"hashes":f.hashes});
            fs::write(
                Path::new(&root).join("crash-report.json"),
                serde_json::to_vec(&report).unwrap(),
            )
            .unwrap();
            std::process::exit(29); // Skips RuntimeState/OwnedProcess/Guard Drop, exactly like a hard crash.
        }
        let temp = tempfile::tempdir().unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", "runtime_upgrade::tests::hard_crash_during_candidate_verification_restores_old_service_on_reconnect", "--nocapture"]).env(ACTOR,temp.path());
        processes::hidden(&mut command);
        let output = command.output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(29),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value =
            serde_json::from_slice(&fs::read(temp.path().join("crash-report.json")).unwrap())
                .unwrap();
        // Job teardown can close the socket before Python disappears from the
        // native process snapshot. That terminating process may have no readable
        // argv yet and correctly blocks production discovery. Wait for only the
        // actor's reported fixture PID to disappear before testing reconnect;
        // unreadable or unrelated Python processes are never retried or ignored.
        let candidate_pid = u32::try_from(report["candidatePid"].as_u64().unwrap()).unwrap();
        let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, candidate_pid) };
        if process.is_null() {
            let error = unsafe { GetLastError() };
            assert_eq!(
                error, ERROR_INVALID_PARAMETER,
                "Cannot inspect crashed actor's fixture PID {candidate_pid}: {error}"
            );
        } else {
            let exit_state = unsafe { WaitForSingleObject(process, 10_000) };
            unsafe {
                CloseHandle(process);
            }
            assert_eq!(
                exit_state, WAIT_OBJECT_0,
                "Job did not exit fixture PID {candidate_pid}"
            );
        }
        // A signaled process object may remain openable after exit. Check the
        // same native snapshot used by discovery rather than PID object lifetime.
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
            assert_ne!(
                snapshot, INVALID_HANDLE_VALUE,
                "Cannot read fixture process snapshot"
            );
            let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
            entry.dwSize = std::mem::size_of_val(&entry) as u32;
            let mut next = unsafe { Process32FirstW(snapshot, &mut entry) };
            while next != 0 && entry.th32ProcessID != candidate_pid {
                next = unsafe { Process32NextW(snapshot, &mut entry) };
            }
            let error = if next == 0 {
                Some(unsafe { GetLastError() })
            } else {
                None
            };
            unsafe {
                CloseHandle(snapshot);
            }
            if let Some(error) = error {
                assert_eq!(
                    error, ERROR_NO_MORE_FILES,
                    "Incomplete fixture process snapshot: {error}"
                );
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Job did not remove crashed actor's fixture PID {candidate_pid}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let old: ServiceProfile = serde_json::from_value(report["old"].clone()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while crate::external::port_accepting(&old).unwrap() {
            assert!(
                Instant::now() < deadline,
                "Job did not release the crashed actor's synthetic server"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let state = RuntimeState::open(report["dataDir"].as_str().unwrap().into()).unwrap();
        assert_eq!(
            status(&state, old.id.clone()).unwrap().unwrap().phase,
            "rolledBack"
        );
        assert_eq!(
            state.registered_profile(&old.id).unwrap().install_dir,
            old.install_dir
        );
        state.clone().restore_default().await.unwrap();
        let health =
            http::strata_request(&state, old.clone(), "/health".into(), "GET".into(), None)
                .await
                .unwrap();
        assert_eq!(health["loaded"], true);
        assert_eq!(health["generation"], "old");
        let hashes: Vec<(PathBuf, String)> =
            serde_json::from_value(report["hashes"].clone()).unwrap();
        for (path, expected) in hashes {
            assert_eq!(installation::file_hash(&path).unwrap(), expected);
        }
        owned_stop(&state, &old.id).await.unwrap();
    }
    #[test]
    fn verification_defaults_to_quick_and_full_is_opt_in() {
        let f = fixture();
        assert_eq!(verification_mode(&f.state), Verification::Quick);
        crate::store_set(&f.state, FULL_VERIFICATION_KEY.into(), json!("yes")).unwrap();
        assert_eq!(verification_mode(&f.state), Verification::Quick);
        full_verification(&f);
        assert_eq!(verification_mode(&f.state), Verification::Full);
        crate::store_set(&f.state, FULL_VERIFICATION_KEY.into(), json!(false)).unwrap();
        assert_eq!(verification_mode(&f.state), Verification::Quick);
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn quick_switch_checks_health_only_without_load_or_short_request() {
        let mut f = fixture();
        start_old(&f, false).await;
        // Either would fail the full check; quick mode must not run them.
        change_candidate(&mut f, "fixture_fail_load", json!(true));
        change_candidate(&mut f, "fixture_bad_probe", json!(true));
        assert_eq!(
            switch(f.state.clone(), &mut f.journal).await.unwrap(),
            Verification::Quick
        );
        assert_eq!(f.journal.phase, "committed");
        assert!(!f.journal.was_loaded);
        assert_eq!(health(&f).await["generation"], "candidate");
        assert_eq!(health(&f).await["loaded"], false);
        assert!(!task_logs(&f).iter().any(|line| line.contains("后台")));
        assert!(!gate(&f).exists());
        unchanged(&f);
        owned_stop(&f.state, &f.old.id).await.unwrap();
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn quick_switch_reloads_previously_loaded_model_in_background_without_gating() {
        let mut f = fixture();
        start_old(&f, true).await;
        change_candidate(&mut f, "fixture_slow_load", json!(true));
        processes::register_task_logs(&f.state.logs, &f.journal.task_id).unwrap();
        let begun = Instant::now();
        switch(f.state.clone(), &mut f.journal).await.unwrap();
        // The fixture load sleeps 15 s; the commit must not wait for it.
        assert!(
            begun.elapsed() < Duration::from_secs(12),
            "{:?}",
            begun.elapsed()
        );
        assert_eq!(f.journal.phase, "committed");
        assert!(f.journal.was_loaded);
        assert_eq!(health(&f).await["generation"], "candidate");
        assert_eq!(health(&f).await["loaded"], false);
        assert!(!gate(&f).exists());
        let signal = Path::new(&f.old.install_dir).join("candidate-loading");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !signal.exists() {
            assert!(
                Instant::now() < deadline,
                "background load never reached the service"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        wait_loaded(&f, Duration::from_secs(30)).await;
        let deadline = Instant::now() + Duration::from_secs(5);
        while !task_logs(&f)
            .iter()
            .any(|line| line.contains("后台模型加载完成"))
        {
            assert!(Instant::now() < deadline, "{:?}", task_logs(&f));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        unchanged(&f);
        owned_stop(&f.state, &f.old.id).await.unwrap();
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn quick_switch_background_load_failure_only_warns_and_never_rolls_back() {
        let mut f = fixture();
        start_old(&f, true).await;
        change_candidate(&mut f, "fixture_fail_load", json!(true));
        processes::register_task_logs(&f.state.logs, &f.journal.task_id).unwrap();
        switch(f.state.clone(), &mut f.journal).await.unwrap();
        assert_eq!(f.journal.phase, "committed");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !task_logs(&f)
            .iter()
            .any(|line| line.contains("后台重新加载模型失败"))
        {
            assert!(Instant::now() < deadline, "{:?}", task_logs(&f));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            status(&f.state, f.old.id.clone()).unwrap().unwrap().phase,
            "committed"
        );
        assert_eq!(
            f.state.registered_profile(&f.old.id).unwrap().install_dir,
            f.candidate.install_dir
        );
        assert_eq!(health(&f).await["generation"], "candidate");
        assert_eq!(health(&f).await["loaded"], false);
        unchanged(&f);
        owned_stop(&f.state, &f.old.id).await.unwrap();
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn full_switch_gates_on_load_and_probe_and_keeps_unloaded_state() {
        let mut f = fixture();
        full_verification(&f);
        start_old(&f, false).await;
        change_candidate(&mut f, "fixture_bad_probe", json!(true));
        let error = switch(f.state.clone(), &mut f.journal).await.unwrap_err();
        assert!(error.contains("已恢复"), "{error}");
        assert_eq!(f.journal.phase, "rolledBack");
        assert_eq!(health(&f).await["generation"], "old");
        assert_eq!(health(&f).await["loaded"], false);
        unchanged(&f);
        owned_stop(&f.state, &f.old.id).await.unwrap();
    }
    const SHORT_WAIT: ObserverWait = ObserverWait {
        stale_ms: 400,
        poll: Duration::from_millis(40),
        max: Duration::from_secs(10),
    };
    fn task_message(f: &Fixture) -> String {
        f.state.tasks.lock().unwrap()[&f.journal.task_id]
            .status
            .message
            .clone()
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn fresh_rows_age_out_during_the_wait_and_the_switch_then_succeeds() {
        let mut f = fixture();
        let id = f.candidate.id.clone();
        let db = seed_requests(&f.state, &[("fresh", &id, now() as i64)]);
        let begun = Instant::now();
        switch_with(f.state.clone(), &mut f.journal, SHORT_WAIT)
            .await
            .unwrap();
        assert!(begun.elapsed() >= Duration::from_millis(300));
        assert_eq!(f.journal.phase, "committed");
        assert_eq!(count(&db, &id), 0);
        assert!(!gate(&f).exists());
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_wait_announces_itself_once_in_the_task_status_and_log() {
        let mut f = fixture();
        let id = f.candidate.id.clone();
        seed_requests(&f.state, &[("fresh", &id, now() as i64)]);
        processes::register_task_logs(&f.state.logs, &f.journal.task_id).unwrap();
        let candidate = f.candidate.clone();
        wait_out_recent_requests(&f.state, &mut f.journal, &candidate, SHORT_WAIT)
            .await
            .unwrap();
        assert_eq!(f.journal.phase, "waitingIdle");
        let message = task_message(&f);
        assert!(
            message.contains("正在自动等待") && message.contains("无需操作"),
            "{message}"
        );
        let logs = f.state.logs.lock().unwrap();
        let announced = logs
            .get(&f.journal.task_id)
            .unwrap()
            .iter()
            .filter(|line| line.message.contains("正在自动等待"))
            .count();
        assert_eq!(announced, 1);
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cancelling_during_the_wait_aborts_without_touching_anything() {
        let mut f = fixture();
        let id = f.candidate.id.clone();
        let db = seed_requests(&f.state, &[("fresh", &id, now() as i64)]);
        let slow = ObserverWait {
            stale_ms: 60_000,
            ..SHORT_WAIT
        };
        let state = f.state.clone();
        let task = f.journal.task_id.clone();
        let canceller = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            state
                .tasks
                .lock()
                .unwrap()
                .get_mut(&task)
                .unwrap()
                .cancelled = true;
        });
        let begun = Instant::now();
        let error = switch_with(f.state.clone(), &mut f.journal, slow)
            .await
            .unwrap_err();
        canceller.await.unwrap();
        assert!(error.contains("已取消"), "{error}");
        assert!(begun.elapsed() < Duration::from_secs(5));
        assert_eq!(count(&db, &id), 1);
        unchanged(&f);
        assert_eq!(
            f.state.registered_profile(&f.old.id).unwrap().install_dir,
            f.old.install_dir
        );
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_service_that_starts_during_the_wait_aborts_the_switch() {
        let mut f = fixture();
        let id = f.candidate.id.clone();
        seed_requests(&f.state, &[("fresh", &id, now() as i64)]);
        let slow = ObserverWait {
            stale_ms: 60_000,
            ..SHORT_WAIT
        };
        let port = url::Url::parse(&f.old.base_url).unwrap().port().unwrap();
        let listener = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            std::net::TcpListener::bind(("127.0.0.1", port)).unwrap()
        });
        let error = switch_with(f.state.clone(), &mut f.journal, slow)
            .await
            .unwrap_err();
        let _listener = listener.await.unwrap();
        assert!(error.contains("候选已有运行实例"), "{error}");
        unchanged(&f);
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn rows_that_never_expire_time_out_with_a_plain_message_before_any_change() {
        let mut f = fixture();
        let id = f.candidate.id.clone();
        let db = seed_requests(
            &f.state,
            &[("a", &id, now() as i64), ("b", &id, now() as i64)],
        );
        let never = ObserverWait {
            stale_ms: 3_600_000,
            poll: Duration::from_millis(40),
            max: Duration::from_millis(300),
        };
        let error = switch_with(f.state.clone(), &mut f.journal, never)
            .await
            .unwrap_err();
        assert!(error.contains("2 个未结束的请求"), "{error}");
        assert!(error.contains("已自动等待 0 秒"), "{error}");
        assert!(error.contains("关闭其它正在使用 Strata 的程序"), "{error}");
        for jargon in ["观察器", "journal", "sqlite", "诊断"] {
            assert!(!error.contains(jargon), "{error}");
        }
        assert_eq!(count(&db, &id), 2);
        unchanged(&f);
        assert!(!gate(&f).exists());
        assert_eq!(
            f.state.registered_profile(&f.old.id).unwrap().install_dir,
            f.old.install_dir
        );
    }
}
