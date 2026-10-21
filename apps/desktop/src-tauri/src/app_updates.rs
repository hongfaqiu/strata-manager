use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use futures_util::future::join_all;
use reqwest::{header::RANGE, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;
use uuid::Uuid;

use crate::ClientState;

const OFFICIAL_MANIFEST_URL: &str =
    "https://github.com/hongfaqiu/strata-manager/releases/latest/download/latest.json";
const DOWNLOAD_PREFS_KEY: &str = "runtimeDownloadPreferences";
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const DEFAULT_CHECK_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS: u64 = 600_000;

#[derive(Default)]
pub struct AppUpdateStore {
    updates: Mutex<HashMap<String, ManagedAppUpdate>>,
}

#[derive(Clone)]
struct ManagedAppUpdate {
    update: Update,
    official_download_url: Url,
    bytes: Option<Vec<u8>>,
    ordered_sources: Vec<SourceSpec>,
    current_source: AppUpdateSource,
    fallback_chain: Vec<AppUpdateSource>,
    attempts: Vec<AppUpdateAttempt>,
}

#[derive(Clone)]
struct SourceSpec {
    id: String,
    label: String,
    kind: String,
    template: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateSource {
    id: String,
    label: String,
    kind: String,
    selected_by: String,
    manifest_url: String,
    download_url: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateAttempt {
    stage: String,
    result: String,
    source: AppUpdateSource,
    message: Option<String>,
    duration_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateHandle {
    id: String,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: Value,
    source: AppUpdateSource,
    fallback_chain: Vec<AppUpdateSource>,
    attempts: Vec<AppUpdateAttempt>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateCheckResult {
    update: Option<AppUpdateHandle>,
    source: Option<AppUpdateSource>,
    fallback_chain: Vec<AppUpdateSource>,
    attempts: Vec<AppUpdateAttempt>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateDownloadEvent {
    event: String,
    data: Value,
    source: Option<AppUpdateSource>,
    fallback_chain: Option<Vec<AppUpdateSource>>,
    attempts: Option<Vec<AppUpdateAttempt>>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeDownloadPreferences {
    mode: Option<String>,
    source_id: Option<String>,
    mirror_url: Option<String>,
}

fn official_source() -> SourceSpec {
    SourceSpec {
        id: "official".into(),
        label: "GitHub".into(),
        kind: "official".into(),
        template: None,
    }
}

fn builtin_sources() -> Vec<SourceSpec> {
    vec![
        SourceSpec {
            id: "gh-proxy".into(),
            label: "GH Proxy".into(),
            kind: "mirror".into(),
            template: Some("https://gh-proxy.org/{url}".into()),
        },
        SourceSpec {
            id: "ghproxy".into(),
            label: "GHProxy".into(),
            kind: "mirror".into(),
            template: Some("https://ghproxy.net/{url}".into()),
        },
    ]
}

fn validate_https_url(url: &str) -> Result<Url, String> {
    let parsed = Url::parse(url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
        || parsed.path().is_empty()
        || parsed.path() == "/"
    {
        return Err("应用更新来源必须是无凭据、无片段的完整 HTTPS 地址".into());
    }
    Ok(parsed)
}

fn resolve_wrapped_url(template: &str, official_url: &str) -> Result<Url, String> {
    let resolved = template.replace("{url}", official_url);
    if resolved.contains('{') || resolved.contains('}') {
        return Err("应用更新镜像只支持 {url} 占位符".into());
    }
    validate_https_url(&resolved)
}

fn custom_source(template: &str) -> Result<SourceSpec, String> {
    let template = template.trim();
    if !template.contains("{url}") {
        return Err("应用更新镜像需要使用 {url} 包裹官方地址".into());
    }
    let _ = resolve_wrapped_url(template, OFFICIAL_MANIFEST_URL)?;
    Ok(SourceSpec {
        id: "custom".into(),
        label: "Custom HTTPS".into(),
        kind: "custom".into(),
        template: Some(template.into()),
    })
}

fn preferred_source_from_preferences(value: &Value) -> Option<SourceSpec> {
    let prefs: RuntimeDownloadPreferences = serde_json::from_value(value.clone()).ok()?;
    if prefs.mode.as_deref() != Some("mirror") {
        return None;
    }
    if let Some(source_id) = prefs.source_id.as_deref() {
        if let Some(source) = builtin_sources()
            .into_iter()
            .find(|source| source.id == source_id)
        {
            return Some(source);
        }
    }
    prefs
        .mirror_url
        .as_deref()
        .and_then(|template| custom_source(template).ok())
}

fn source_manifest_url(source: &SourceSpec) -> Result<Url, String> {
    match source.template.as_deref() {
        Some(template) => resolve_wrapped_url(template, OFFICIAL_MANIFEST_URL),
        None => validate_https_url(OFFICIAL_MANIFEST_URL),
    }
}

fn source_download_url(source: &SourceSpec, official_url: &Url) -> Result<Url, String> {
    match source.template.as_deref() {
        Some(template) => resolve_wrapped_url(template, official_url.as_str()),
        None => Ok(official_url.clone()),
    }
}

fn selection_for_source(auto: bool, index: usize) -> &'static str {
    if auto {
        "automatic"
    } else if index == 0 {
        "preference"
    } else {
        "fallback"
    }
}

fn preferred_order(source: SourceSpec) -> Vec<SourceSpec> {
    if source.id == official_source().id {
        vec![official_source()]
    } else {
        vec![source, official_source()]
    }
}

/// Rank successful probes by latency. Official GitHub stays last unless it won.
fn order_automatic_sources(mut successes: Vec<(u64, SourceSpec)>) -> Vec<SourceSpec> {
    successes.sort_by(|(left_ms, left), (right_ms, right)| {
        left_ms.cmp(right_ms).then_with(|| left.id.cmp(&right.id))
    });
    let mut ordered = Vec::new();
    if let Some((_, winner)) = successes.first() {
        ordered.push(winner.clone());
    }
    for source in builtin_sources() {
        if !ordered.iter().any(|item| item.id == source.id) {
            ordered.push(source);
        }
    }
    if ordered.first().map(|source| source.id.as_str()) != Some("official") {
        ordered.retain(|source| source.id != "official");
        ordered.push(official_source());
    }
    if ordered.is_empty() {
        ordered.push(official_source());
    }
    ordered
}

fn source_view(
    source: &SourceSpec,
    selected_by: &str,
    manifest_url: Url,
    download_url: Option<Url>,
) -> AppUpdateSource {
    AppUpdateSource {
        id: source.id.clone(),
        label: source.label.clone(),
        kind: source.kind.clone(),
        selected_by: selected_by.into(),
        manifest_url: manifest_url.to_string(),
        download_url: download_url.map(|url| url.to_string()),
    }
}

fn official_release_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url
            .path()
            .starts_with("/hongfaqiu/strata-manager/releases/download/")
}

fn attempt(
    stage: &str,
    result: &str,
    source: AppUpdateSource,
    message: Option<String>,
    duration_ms: Option<u64>,
) -> AppUpdateAttempt {
    AppUpdateAttempt {
        stage: stage.into(),
        result: result.into(),
        source,
        message,
        duration_ms,
    }
}

fn format_attempts_error(prefix: &str, attempts: &[AppUpdateAttempt]) -> String {
    let details = attempts
        .iter()
        .map(|entry| {
            let duration = entry
                .duration_ms
                .map(|value| format!(" ({value} ms)"))
                .unwrap_or_default();
            match entry.message.as_deref() {
                Some(message) => format!(
                    "- {} {} via {}{}: {}",
                    entry.stage, entry.result, entry.source.label, duration, message
                ),
                None => format!(
                    "- {} {} via {}{}",
                    entry.stage, entry.result, entry.source.label, duration
                ),
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    if details.is_empty() {
        prefix.into()
    } else {
        format!("{prefix}\n{details}")
    }
}

async fn load_preferences(state: &ClientState) -> Value {
    state
        .ipc
        .request("store_get", json!({ "key": DOWNLOAD_PREFS_KEY }))
        .await
        .unwrap_or(Value::Null)
}

async fn probe_source(source: SourceSpec) -> (SourceSpec, Result<u64, String>) {
    let manifest_url = match source_manifest_url(&source) {
        Ok(url) => url,
        Err(error) => return (source, Err(error)),
    };
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .timeout(PROBE_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(error) => return (source, Err(error.to_string())),
    };
    let started = Instant::now();
    let response = client
        .get(manifest_url)
        .header(RANGE, "bytes=0-255")
        .send()
        .await;
    match response {
        Ok(response)
            if response.status().is_success()
                || response.status() == StatusCode::PARTIAL_CONTENT =>
        {
            let elapsed = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
            (source, Ok(elapsed))
        }
        Ok(response) => (source, Err(format!("HTTP {}", response.status()))),
        Err(error) => (source, Err(error.to_string())),
    }
}

async fn ordered_sources(
    preferred: Option<SourceSpec>,
) -> (Vec<SourceSpec>, Vec<AppUpdateAttempt>, bool) {
    if let Some(source) = preferred {
        return (preferred_order(source), Vec::new(), false);
    }
    let mut attempts = Vec::new();
    let probe_order = {
        let mut sources = builtin_sources();
        sources.push(official_source());
        sources
    };
    let mut successes = Vec::new();
    for (source, result) in join_all(probe_order.into_iter().map(probe_source)).await {
        let manifest_url = source_manifest_url(&source).ok();
        let view = source_view(
            &source,
            "automatic",
            manifest_url.unwrap_or_else(|| Url::parse(OFFICIAL_MANIFEST_URL).unwrap()),
            None,
        );
        match result {
            Ok(duration_ms) => {
                attempts.push(attempt("probe", "success", view, None, Some(duration_ms)));
                successes.push((duration_ms, source.clone()));
            }
            Err(error) => attempts.push(attempt("probe", "failed", view, Some(error), None)),
        }
    }
    (order_automatic_sources(successes), attempts, true)
}

#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    state: State<'_, ClientState>,
    updates: State<'_, AppUpdateStore>,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let preferred = preferred_source_from_preferences(&load_preferences(&state).await);
    let (ordered, mut attempts, automatic) = ordered_sources(preferred).await;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_CHECK_TIMEOUT_MS));
    let mut authoritative: Option<AppUpdateSource> = None;
    let mut official_current = false;

    for (index, source) in ordered.iter().enumerate() {
        let manifest_url = source_manifest_url(source)?;
        let selection = selection_for_source(automatic, index);
        let source_for_attempt = source_view(source, selection, manifest_url.clone(), None);
        let endpoint = vec![manifest_url.clone()];
        let result = app
            .updater_builder()
            .endpoints(endpoint)
            .map_err(|e| e.to_string())?
            .timeout(timeout)
            .build()
            .map_err(|e| e.to_string())?
            .check()
            .await;
        match result {
            Ok(Some(mut update)) => {
                if !official_release_url(&update.download_url) {
                    attempts.push(attempt(
                        "check",
                        "failed",
                        source_for_attempt,
                        Some(
                            "update manifest did not point to the canonical GitHub release asset"
                                .into(),
                        ),
                        None,
                    ));
                    continue;
                }
                let official_download_url = update.download_url.clone();
                let mirrored_download_url = source_download_url(source, &official_download_url)?;
                let current_source = source_view(
                    source,
                    selection,
                    manifest_url.clone(),
                    Some(mirrored_download_url.clone()),
                );
                update.download_url = mirrored_download_url;
                update.timeout = Some(timeout);
                let fallback_chain = ordered
                    .iter()
                    .skip(index + 1)
                    .map(|next| {
                        let manifest = source_manifest_url(next)
                            .unwrap_or_else(|_| Url::parse(OFFICIAL_MANIFEST_URL).unwrap());
                        let download = source_download_url(next, &official_download_url).ok();
                        source_view(next, "fallback", manifest, download)
                    })
                    .collect::<Vec<_>>();
                attempts.push(attempt(
                    "check",
                    "selected",
                    current_source.clone(),
                    Some(format!("version {}", update.version)),
                    None,
                ));
                let id = Uuid::new_v4().to_string();
                updates.updates.lock().map_err(|e| e.to_string())?.insert(
                    id.clone(),
                    ManagedAppUpdate {
                        update: update.clone(),
                        official_download_url,
                        bytes: None,
                        ordered_sources: ordered.iter().skip(index).cloned().collect(),
                        current_source: current_source.clone(),
                        fallback_chain: fallback_chain.clone(),
                        attempts: attempts.clone(),
                    },
                );
                return Ok(serde_json::to_value(AppUpdateCheckResult {
                    source: Some(current_source.clone()),
                    fallback_chain: fallback_chain.clone(),
                    attempts: attempts.clone(),
                    update: Some(AppUpdateHandle {
                        id,
                        current_version: update.current_version.clone(),
                        version: update.version.clone(),
                        date: update.date.as_ref().map(ToString::to_string),
                        body: update.body.clone(),
                        raw_json: update.raw_json.clone(),
                        source: current_source,
                        fallback_chain,
                        attempts,
                    }),
                })
                .map_err(|e| e.to_string())?);
            }
            Ok(None) => {
                authoritative = Some(source_for_attempt.clone());
                official_current = source.id == "official";
                attempts.push(attempt(
                    "check",
                    if official_current {
                        "current"
                    } else {
                        "no-update"
                    },
                    source_for_attempt,
                    None,
                    None,
                ));
                if official_current {
                    break;
                }
            }
            Err(error) => attempts.push(attempt(
                "check",
                "failed",
                source_for_attempt,
                Some(error.to_string()),
                None,
            )),
        }
    }

    if official_current {
        return Ok(serde_json::to_value(AppUpdateCheckResult {
            update: None,
            source: authoritative,
            fallback_chain: Vec::new(),
            attempts,
        })
        .map_err(|e| e.to_string())?);
    }

    Err(format_attempts_error(
        "暂时无法获取更新信息 / Update information is unavailable",
        &attempts,
    ))
}

impl AppUpdateDownloadEvent {
    fn source(
        source: AppUpdateSource,
        fallback_chain: Vec<AppUpdateSource>,
        attempts: Vec<AppUpdateAttempt>,
    ) -> Self {
        Self {
            event: "Source".into(),
            data: json!({}),
            source: Some(source),
            fallback_chain: Some(fallback_chain),
            attempts: Some(attempts),
        }
    }

    fn started(
        source: AppUpdateSource,
        fallback_chain: Vec<AppUpdateSource>,
        attempts: Vec<AppUpdateAttempt>,
        content_length: Option<u64>,
    ) -> Self {
        Self {
            event: "Started".into(),
            data: json!({ "contentLength": content_length }),
            source: Some(source),
            fallback_chain: Some(fallback_chain),
            attempts: Some(attempts),
        }
    }

    fn progress(chunk_length: usize) -> Self {
        Self {
            event: "Progress".into(),
            data: json!({ "chunkLength": chunk_length }),
            source: None,
            fallback_chain: None,
            attempts: None,
        }
    }

    fn finished() -> Self {
        Self {
            event: "Finished".into(),
            data: json!({}),
            source: None,
            fallback_chain: None,
            attempts: None,
        }
    }
}

#[tauri::command]
pub async fn download_app_update(
    updates: State<'_, AppUpdateStore>,
    update_id: String,
    timeout_ms: Option<u64>,
    on_event: Channel<AppUpdateDownloadEvent>,
) -> Result<(), String> {
    let managed = updates
        .updates
        .lock()
        .map_err(|e| e.to_string())?
        .get(&update_id)
        .cloned()
        .ok_or_else(|| "应用更新会话已失效".to_string())?;
    if managed.bytes.is_some() {
        return Ok(());
    }
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_DOWNLOAD_TIMEOUT_MS));
    let mut attempts = managed.attempts.clone();
    let ordered = managed.ordered_sources.clone();

    for (index, source) in ordered.iter().enumerate() {
        let mut update = managed.update.clone();
        let manifest_url = source_manifest_url(source)?;
        let download_url = source_download_url(source, &managed.official_download_url)?;
        update.download_url = download_url.clone();
        update.timeout = Some(timeout);
        let selection = if index == 0 {
            managed.current_source.selected_by.as_str()
        } else {
            "fallback"
        };
        let current_source = source_view(
            source,
            selection,
            manifest_url.clone(),
            Some(download_url.clone()),
        );
        let fallback_chain = ordered
            .iter()
            .skip(index + 1)
            .map(|next| {
                let manifest = source_manifest_url(next)
                    .unwrap_or_else(|_| Url::parse(OFFICIAL_MANIFEST_URL).unwrap());
                let download = source_download_url(next, &managed.official_download_url).ok();
                source_view(next, "fallback", manifest, download)
            })
            .collect::<Vec<_>>();
        let _ = on_event.send(AppUpdateDownloadEvent::source(
            current_source.clone(),
            fallback_chain.clone(),
            attempts.clone(),
        ));
        let mut started = false;
        let bytes = update
            .download(
                |chunk_length, content_length| {
                    if !started {
                        started = true;
                        let _ = on_event.send(AppUpdateDownloadEvent::started(
                            current_source.clone(),
                            fallback_chain.clone(),
                            attempts.clone(),
                            content_length,
                        ));
                    }
                    let _ = on_event.send(AppUpdateDownloadEvent::progress(chunk_length));
                },
                || {
                    let _ = on_event.send(AppUpdateDownloadEvent::finished());
                },
            )
            .await;
        match bytes {
            Ok(bytes) => {
                attempts.push(attempt(
                    "download",
                    "selected",
                    current_source.clone(),
                    Some("signature verified".into()),
                    None,
                ));
                if let Some(entry) = updates
                    .updates
                    .lock()
                    .map_err(|e| e.to_string())?
                    .get_mut(&update_id)
                {
                    entry.update = update;
                    entry.bytes = Some(bytes);
                    entry.current_source = current_source;
                    entry.fallback_chain = fallback_chain;
                    entry.attempts = attempts;
                }
                return Ok(());
            }
            Err(error) => attempts.push(attempt(
                "download",
                "failed",
                current_source,
                Some(error.to_string()),
                None,
            )),
        }
    }

    if let Some(entry) = updates
        .updates
        .lock()
        .map_err(|e| e.to_string())?
        .get_mut(&update_id)
    {
        entry.bytes = None;
        entry.attempts = attempts.clone();
    }
    Err(format_attempts_error(
        "应用更新下载失败 / App update download failed",
        &attempts,
    ))
}

#[tauri::command]
pub fn install_app_update(
    updates: State<'_, AppUpdateStore>,
    update_id: String,
    restart_after_install: Option<bool>,
) -> Result<(), String> {
    let managed = updates
        .updates
        .lock()
        .map_err(|e| e.to_string())?
        .get(&update_id)
        .cloned()
        .ok_or_else(|| "应用更新会话已失效".to_string())?;
    let bytes = managed
        .bytes
        .ok_or_else(|| "请先下载并校验更新包".to_string())?;
    let update = managed
        .update
        .clone()
        .restart_after_install(restart_after_install.unwrap_or(true));
    update.install(bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_app_update(
    updates: State<'_, AppUpdateStore>,
    update_id: String,
) -> Result<(), String> {
    let _ = updates
        .updates
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&update_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_updates_use_built_in_and_custom_wrap_sources_only() {
        assert_eq!(
            preferred_source_from_preferences(&json!({"mode":"mirror","sourceId":"gh-proxy"}))
                .unwrap()
                .id,
            "gh-proxy"
        );
        assert_eq!(
            preferred_source_from_preferences(
                &json!({"mode":"mirror","mirrorUrl":"https://mirror.example/{url}"})
            )
            .unwrap()
            .id,
            "custom"
        );
        assert!(preferred_source_from_preferences(
            &json!({"mode":"mirror","mirrorUrl":"https://mirror.example/{version}/{asset}"})
        )
        .is_none());
        assert!(preferred_source_from_preferences(
            &json!({"mode":"mirror","mirrorUrl":"https://mirror.example/app.exe"})
        )
        .is_none());
        assert!(preferred_source_from_preferences(
            &json!({"mode":"local","localArchivePath":"/tmp/engine.zip"})
        )
        .is_none());
    }

    #[test]
    fn wrapped_urls_and_canonical_release_urls_stay_https_only() {
        assert_eq!(
            resolve_wrapped_url("https://ghproxy.net/{url}", OFFICIAL_MANIFEST_URL)
                .unwrap()
                .as_str(),
            format!("https://ghproxy.net/{OFFICIAL_MANIFEST_URL}")
        );
        assert!(resolve_wrapped_url("http://ghproxy.net/{url}", OFFICIAL_MANIFEST_URL).is_err());
        assert!(
            resolve_wrapped_url("https://user:pw@ghproxy.net/{url}", OFFICIAL_MANIFEST_URL)
                .is_err()
        );
        assert!(
            resolve_wrapped_url("https://ghproxy.net/{url}#frag", OFFICIAL_MANIFEST_URL).is_err()
        );
        assert!(official_release_url(
            &Url::parse(
                "https://github.com/hongfaqiu/strata-manager/releases/download/v0.2.11/Strata.Manager_0.2.11_x64-setup.exe"
            )
            .unwrap()
        ));
        assert!(!official_release_url(
            &Url::parse(
                "https://mirror.example/hongfaqiu/strata-manager/releases/download/v0.2.11/app.exe"
            )
            .unwrap()
        ));
        assert!(!official_release_url(
            &Url::parse(
                "https://github.com/hongfaqiu/strata-manager/releases/download/v0.2.11/app.exe?token=1"
            )
            .unwrap()
        ));
    }

    #[test]
    fn automatic_ranking_picks_the_fastest_source_and_keeps_official_last() {
        let gh_proxy = builtin_sources()
            .into_iter()
            .find(|source| source.id == "gh-proxy")
            .unwrap();
        let ghproxy = builtin_sources()
            .into_iter()
            .find(|source| source.id == "ghproxy")
            .unwrap();
        assert_eq!(
            order_automatic_sources(vec![
                (80, official_source()),
                (12, ghproxy.clone()),
                (40, gh_proxy.clone()),
            ])
            .into_iter()
            .map(|source| source.id)
            .collect::<Vec<_>>(),
            ["ghproxy", "gh-proxy", "official"]
        );
        assert_eq!(
            order_automatic_sources(vec![(5, official_source())])
                .into_iter()
                .map(|source| source.id)
                .collect::<Vec<_>>(),
            ["official", "gh-proxy", "ghproxy"]
        );
        assert_eq!(
            order_automatic_sources(Vec::new())
                .into_iter()
                .map(|source| source.id)
                .collect::<Vec<_>>(),
            ["gh-proxy", "ghproxy", "official"]
        );
        assert_eq!(
            preferred_order(gh_proxy)
                .into_iter()
                .map(|source| source.id)
                .collect::<Vec<_>>(),
            ["gh-proxy", "official"]
        );
        assert_eq!(
            preferred_order(official_source())
                .into_iter()
                .map(|source| source.id)
                .collect::<Vec<_>>(),
            ["official"]
        );
    }
}
