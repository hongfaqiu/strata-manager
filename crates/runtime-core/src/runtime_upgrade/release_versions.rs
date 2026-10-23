//! Every published Strata release, so a specific version can be installed (up or down).
//! Listing is advisory; installing one re-reads that release and verifies it exactly like
//! the latest one (GitHub digests, signed feed, same-tag source commit).
use super::{engine_package, fetch_release_info, now, RuntimeUpdateInfo};
use crate::RuntimeState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const VERSIONS_KEY: &str = "strataReleaseVersions";
const VERSIONS_INTERVAL: u64 = 6 * 60 * 60 * 1000;
const ERROR_INTERVAL: u64 = 10 * 60 * 1000;
const MAX_VERSIONS: usize = 100;
const RELEASES_API: &str = "https://api.github.com/repos/Niko1221/Strata/releases?per_page=100";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeReleaseVersion {
    pub version: String,
    pub tag: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    pub prerelease: bool,
    /// `feed`: signed `strata-feed.json` packages (0.2+); `zip`: legacy Windows ZIPs.
    pub packaging: String,
    /// Carries an engine package Manager can install on this platform.
    pub installable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_url: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeReleaseVersions {
    pub checked_at: u64,
    pub versions: Vec<RuntimeReleaseVersion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn installable_asset(asset: &Value, host: &str) -> bool {
    let Some(name) = asset["name"].as_str() else {
        return false;
    };
    if engine_package::asset_platform(name) != Some(host) {
        return false;
    }
    // Legacy ZIPs are verified only by GitHub's digest; without one they cannot install.
    engine_package::legacy_variant(name).is_none()
        || asset["digest"]
            .as_str()
            .is_some_and(|digest| digest.starts_with("sha256:"))
}

/// Newest first; drafts, malformed tags and duplicates are dropped.
pub fn parse_releases(releases: &Value, host: Option<&str>) -> Vec<RuntimeReleaseVersion> {
    let mut versions: Vec<RuntimeReleaseVersion> = releases
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|release| {
            if release["draft"].as_bool().unwrap_or(false) {
                return None;
            }
            let tag = release["tag_name"]
                .as_str()
                .filter(|tag| !tag.is_empty() && tag.len() <= 80)?;
            let version = tag.trim_start_matches('v');
            if !engine_package::valid_version(version) {
                return None;
            }
            let assets = release["assets"].as_array().cloned().unwrap_or_default();
            let named = |name: &str| {
                assets
                    .iter()
                    .any(|asset| asset["name"].as_str() == Some(name))
            };
            let feed =
                named(engine_package::FEED_NAME) && named(engine_package::FEED_SIGNATURE_NAME);
            Some(RuntimeReleaseVersion {
                version: version.into(),
                tag: tag.into(),
                name: release["name"]
                    .as_str()
                    .map(|value| value.chars().take(200).collect()),
                published_at: release["published_at"].as_str().map(str::to_owned),
                prerelease: release["prerelease"].as_bool().unwrap_or(false),
                packaging: if feed { "feed" } else { "zip" }.into(),
                installable: host
                    .is_some_and(|host| assets.iter().any(|asset| installable_asset(asset, host))),
                release_url: release["html_url"]
                    .as_str()
                    .filter(|url| url.starts_with("https://github.com/Niko1221/Strata/releases/"))
                    .map(str::to_owned),
            })
        })
        .collect();
    versions.sort_by(|a, b| {
        engine_package::version_key(&b.version).cmp(&engine_package::version_key(&a.version))
    });
    versions.dedup_by(|a, b| a.version == b.version);
    versions.truncate(MAX_VERSIONS);
    versions
}

async fn fetch_releases() -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Strata-Manager-runtime-updates")
        .build()
        .map_err(|error| error.to_string())?;
    super::github_source::get_json(&client, RELEASES_API, "上游版本列表")
        .await
        .map(|(value, _)| value)
}

fn fresh(cached: &RuntimeReleaseVersions, checked_now: u64) -> bool {
    let interval = if cached.error.is_some() {
        ERROR_INTERVAL
    } else {
        VERSIONS_INTERVAL
    };
    !cached.versions.is_empty() && checked_now.saturating_sub(cached.checked_at) < interval
}

/// Cached for six hours (ten minutes after an error); `force` re-reads GitHub.
pub async fn list(state: &RuntimeState, force: bool) -> Result<RuntimeReleaseVersions, String> {
    super::github_source::sync(state);
    let cached = serde_json::from_value::<RuntimeReleaseVersions>(crate::store_get(
        state,
        VERSIONS_KEY.into(),
    )?)
    .ok();
    if let Some(cached) = cached
        .as_ref()
        .filter(|cached| !force && fresh(cached, now()))
    {
        return Ok(cached.clone());
    }
    let result = match fetch_releases().await {
        Ok(releases) => RuntimeReleaseVersions {
            checked_at: now(),
            versions: parse_releases(&releases, engine_package::this_release_install_platform()),
            error: None,
        },
        Err(error) => {
            let mut stale = cached.unwrap_or_default();
            stale.checked_at = now();
            stale.error = Some(error);
            stale
        }
    };
    crate::store_set(
        state,
        VERSIONS_KEY.into(),
        serde_json::to_value(&result).map_err(|error| error.to_string())?,
    )?;
    Ok(result)
}

/// Release metadata for one chosen version, verified like the latest release. The signed
/// feed must name this version; its sequence is not compared with the newest one accepted
/// (an older release's feed is older by design) and is not remembered.
pub async fn release_info(version: &str) -> Result<RuntimeUpdateInfo, String> {
    let version = version.trim().trim_start_matches('v');
    if !engine_package::valid_version(version) {
        return Err("所选 Strata 版本号无效 / Invalid Strata version".into());
    }
    let url = format!("https://api.github.com/repos/Niko1221/Strata/releases/tags/v{version}");
    let mut info = fetch_release_info(&url, None, Some(version))
        .await
        .map_err(|error| {
            format!("无法读取 Strata {version} 的发布信息 / Cannot read Strata {version}: {error}")
        })?;
    info.feed_sequence = None;
    Ok(super::constrain_installable(info))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn release(tag: &str, assets: Value) -> Value {
        json!({"tag_name": tag, "name": format!("Strata {tag}"), "published_at": "2026-10-20T08:19:00Z", "prerelease": false, "draft": false,
            "html_url": format!("https://github.com/Niko1221/Strata/releases/tag/{tag}"), "assets": assets})
    }

    #[test]
    fn lists_newest_first_and_marks_what_installs_here() {
        let releases = json!([
            release(
                "v0.1.44",
                json!([{"name": "strata-windows-x64.zip", "digest": format!("sha256:{}", "a".repeat(64))}])
            ),
            release(
                "v0.2.1",
                json!([{"name": "strata-feed.json"}, {"name": "strata-feed.json.sig"}, {"name": "strata-engine-0.1.46-linux-x86_64-cuda-cu12.tar.gz"}])
            ),
            release("v0.1.9", json!([{"name": "strata-windows-x64.zip"}])),
            json!({"tag_name": "v9.9.9", "draft": true, "assets": []}),
            release("nightly", json!([])),
            release("v0.2.1", json!([])),
        ]);
        let windows = parse_releases(&releases, Some("windows-x86_64"));
        assert_eq!(
            windows
                .iter()
                .map(|v| v.version.as_str())
                .collect::<Vec<_>>(),
            ["0.2.1", "0.1.44", "0.1.9"]
        );
        assert_eq!(windows[0].packaging, "feed");
        assert!(
            !windows[0].installable,
            "a Linux package does not install on Windows"
        );
        assert!(windows[1].installable && windows[1].packaging == "zip");
        assert!(
            !windows[2].installable,
            "a legacy ZIP without a GitHub digest cannot be verified"
        );
        let none = parse_releases(&releases, None);
        assert!(none.iter().all(|v| !v.installable));
    }

    #[test]
    fn prereleases_sort_below_their_release() {
        let releases = json!([
            release("v0.2.0-beta", json!([])),
            release("v0.2.0", json!([])),
            release("v0.1.45", json!([]))
        ]);
        let versions = parse_releases(&releases, None);
        assert_eq!(
            versions
                .iter()
                .map(|v| v.version.as_str())
                .collect::<Vec<_>>(),
            ["0.2.0", "0.2.0-beta", "0.1.45"]
        );
    }

    #[test]
    fn cache_freshness() {
        let mut cached = RuntimeReleaseVersions {
            checked_at: 1_000,
            versions: parse_releases(&json!([release("v0.2.1", json!([]))]), None),
            error: None,
        };
        assert!(fresh(&cached, 1_000 + VERSIONS_INTERVAL - 1));
        assert!(!fresh(&cached, 1_000 + VERSIONS_INTERVAL));
        cached.error = Some("offline".into());
        assert!(!fresh(&cached, 1_000 + ERROR_INTERVAL));
        cached.versions.clear();
        assert!(!fresh(&cached, 1_001));
    }
}
