//! Which host serves a GitHub release file (engine packages, the llama.cpp source archive).
//! Default and "auto": a short speed test of the built-in mirrors and GitHub picks the fastest,
//! the other mirrors follow and GitHub is the last resort unless it won. A saved fixed mirror
//! keeps its order (that mirror, then GitHub); "official" means GitHub only. Only the transport
//! changes: every file is still held to its official size and SHA-256.
use crate::{installation, processes, RuntimeState};
use futures_util::future::join_all;
use serde_json::Value;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

pub const OFFICIAL_ID: &str = "official";
pub const OFFICIAL_LABEL: &str = "GitHub";
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// The built-in GitHub release proxies, in fallback order (same list as the desktop setting).
pub const MIRRORS: [(&str, &str, &str); 2] = [
    ("gh-proxy", "gh-proxy.org", "https://gh-proxy.org/"),
    ("ghproxy", "ghproxy.net", "https://ghproxy.net/"),
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Choice {
    /// Nothing saved, `mode: "auto"`, or a choice that does not apply to this file.
    Auto,
    Official,
    /// A built-in mirror the user picked (its id).
    Mirror(&'static str),
    /// A user template that wraps the official URL with `{url}`.
    Custom(String),
}

/// Reads the saved `runtimeDownloadPreferences`. Missing or unknown values mean automatic.
pub fn choice(preferences: &Value) -> Choice {
    match preferences["mode"].as_str() {
        Some("official") => Choice::Official,
        Some("mirror") => {
            let id = preferences["sourceId"].as_str().unwrap_or_default();
            if let Some((id, _, _)) = MIRRORS.iter().find(|(known, _, _)| *known == id) {
                return Choice::Mirror(id);
            }
            let template = preferences["mirrorUrl"].as_str().unwrap_or_default().trim();
            // Only a template that wraps the official URL fits any file; {version}/{asset}
            // templates and literal URLs name one engine package.
            if template.starts_with("https://")
                && template.contains("{url}")
                && !template.replace("{url}", "").contains(['{', '}'])
            {
                Choice::Custom(template.to_owned())
            } else {
                Choice::Auto
            }
        }
        _ => Choice::Auto,
    }
}

pub fn saved_choice(state: &RuntimeState) -> Choice {
    crate::store_get(state, super::github_source::PREFERENCES_KEY.into())
        .map(|value| choice(&value))
        .unwrap_or(Choice::Auto)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source {
    pub id: String,
    pub label: String,
    /// `None` is GitHub itself; otherwise a template with `{url}`.
    template: Option<String>,
}

impl Source {
    pub fn official() -> Self {
        Self {
            id: OFFICIAL_ID.into(),
            label: OFFICIAL_LABEL.into(),
            template: None,
        }
    }

    pub fn mirror(id: &str) -> Option<Self> {
        MIRRORS
            .iter()
            .find(|(known, _, _)| *known == id)
            .map(|(id, label, prefix)| Self {
                id: (*id).into(),
                label: (*label).into(),
                template: Some(format!("{prefix}{{url}}")),
            })
    }

    pub fn is_official(&self) -> bool {
        self.template.is_none()
    }

    pub fn url(&self, official: &str) -> String {
        match &self.template {
            None => official.to_owned(),
            Some(template) => template.replace("{url}", official),
        }
    }
}

fn builtin() -> Vec<Source> {
    MIRRORS
        .iter()
        .filter_map(|(id, _, _)| Source::mirror(id))
        .collect()
}

/// Rank probe results (`id`, milliseconds or `None` when it failed): the fastest source first,
/// then the remaining built-in mirrors in their usual order; GitHub is last unless it won.
/// Shared by engine downloads and app updates so both pick sources the same way.
pub fn rank(probes: &[(String, Option<u64>)]) -> Vec<String> {
    let mut successes: Vec<_> = probes
        .iter()
        .filter_map(|(id, ms)| ms.map(|ms| (ms, id.clone())))
        .collect();
    successes.sort();
    let mut ordered = Vec::new();
    if let Some((_, winner)) = successes.first() {
        ordered.push(winner.clone());
    }
    for (id, _, _) in MIRRORS {
        if !ordered.iter().any(|item| item == id) {
            ordered.push(id.to_owned());
        }
    }
    if !ordered.iter().any(|item| item == OFFICIAL_ID) {
        ordered.push(OFFICIAL_ID.to_owned());
    }
    ordered
}

/// The fixed order for a saved choice; `None` means automatic (probe first).
pub fn fixed_order(choice: &Choice) -> Option<Vec<Source>> {
    match choice {
        Choice::Auto => None,
        Choice::Official => Some(vec![Source::official()]),
        Choice::Mirror(id) => Some(vec![
            Source::mirror(id).unwrap_or_else(Source::official),
            Source::official(),
        ]),
        Choice::Custom(template) => Some(vec![
            Source {
                id: "custom".into(),
                label: url::Url::parse(&template.replace("{url}", "x"))
                    .ok()
                    .and_then(|url| url.host_str().map(str::to_owned))
                    .unwrap_or_else(|| "Custom HTTPS".into()),
                template: Some(template.clone()),
            },
            Source::official(),
        ]),
    }
}

async fn probe(source: &Source, official: &str) -> Option<u64> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .timeout(PROBE_TIMEOUT)
        .build()
        .ok()?;
    let started = Instant::now();
    let response = client
        .get(source.url(official))
        .header(reqwest::header::RANGE, "bytes=0-255")
        .send()
        .await
        .ok()?;
    let status = response.status();
    (status.is_success() || status == reqwest::StatusCode::PARTIAL_CONTENT)
        .then(|| started.elapsed().as_millis().min(u64::MAX as u128) as u64)
}

/// One line for the log: `gh-proxy.org 182 ms · ghproxy.net 超时 · GitHub 640 ms`.
pub fn probe_summary(results: &[(Source, Option<u64>)], zh: bool) -> String {
    results
        .iter()
        .map(|(source, ms)| match ms {
            Some(ms) => format!("{} {ms} ms", source.label),
            None if zh => format!("{} 不可用", source.label),
            None => format!("{} unavailable", source.label),
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

/// Sources to try for `official`, in order, and whether a speed test chose them.
pub async fn plan(
    state: &RuntimeState,
    id: &str,
    choice: &Choice,
    official: &str,
) -> (Vec<Source>, bool) {
    if let Some(order) = fixed_order(choice) {
        return (order, false);
    }
    let mut candidates = builtin();
    candidates.push(Source::official());
    let results: Vec<(Source, Option<u64>)> =
        join_all(candidates.into_iter().map(|source| async move {
            let ms = probe(&source, official).await;
            (source, ms)
        }))
        .await;
    processes::log(
        &state.logs,
        id,
        "info",
        format!(
            "下载来源测速：{} / Source speed test: {}",
            probe_summary(&results, true),
            probe_summary(&results, false)
        ),
    );
    let ranked = rank(
        &results
            .iter()
            .map(|(source, ms)| (source.id.clone(), *ms))
            .collect::<Vec<_>>(),
    );
    let order = ranked
        .iter()
        .filter_map(|id| {
            results
                .iter()
                .find(|(source, _)| &source.id == id)
                .map(|(s, _)| s.clone())
        })
        .collect();
    (order, results.iter().any(|(_, ms)| ms.is_some()))
}

/// Why this source is used, as `(中文, English)`.
pub fn reason(index: usize, automatic: bool) -> (&'static str, &'static str) {
    match (index, automatic) {
        (0, true) => ("测速最快", "fastest"),
        (0, false) => ("所选来源", "your choice"),
        _ => ("备用来源", "fallback"),
    }
}

fn mirror_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("mirror redirect limit exceeded");
            }
            if attempt.url().scheme() == "https"
                && attempt.url().username().is_empty()
                && attempt.url().password().is_none()
            {
                attempt.follow()
            } else {
                attempt.error("mirror redirect must remain HTTPS without credentials")
            }
        }))
        .build()
        .map_err(|error| error.to_string())
}

/// Download one official GitHub file through the saved route; `what` is `(中文, English)`.
/// Returns the verified cache file and the label of the source that delivered it.
pub async fn download(
    state: &RuntimeState,
    id: &str,
    what: (&str, &str),
    official: &str,
    sha256: &str,
    size: u64,
) -> Result<(PathBuf, String), String> {
    download_with(
        state,
        id,
        &saved_choice(state),
        what,
        official,
        sha256,
        size,
    )
    .await
}

/// [`download`] with an explicit choice (the update dialog's own selection).
pub async fn download_with(
    state: &RuntimeState,
    id: &str,
    choice: &Choice,
    what: (&str, &str),
    official: &str,
    sha256: &str,
    size: u64,
) -> Result<(PathBuf, String), String> {
    let (order, automatic) = plan(state, id, choice, official).await;
    let mut failures = Vec::new();
    for (index, source) in order.iter().enumerate() {
        installation::cancelled(state, id)?;
        let (why_zh, why_en) = reason(index, automatic);
        installation::progress(
            state,
            id,
            format!(
                "下载来源：{}（{why_zh}）· {} / Download source: {} ({why_en}) · {}",
                source.label, what.0, source.label, what.1
            ),
        )?;
        let result = if source.is_official() {
            installation::download_release_sized(state, id, official, sha256, size).await
        } else {
            match mirror_client() {
                Ok(client) => {
                    installation::download_using_client_sized(
                        state,
                        id,
                        &source.url(official),
                        sha256,
                        size,
                        &client,
                    )
                    .await
                }
                Err(error) => Err(error),
            }
        };
        match result {
            Ok(file) => {
                if file.metadata().map_err(|e| e.to_string())?.len() != size {
                    return Err(format!(
                        "{}长度与官方清单不符 / {} size does not match",
                        what.0, what.1
                    ));
                }
                return Ok((file, source.label.clone()));
            }
            Err(error) => {
                installation::cancelled(state, id)?;
                processes::log(
                    &state.logs,
                    id,
                    "warn",
                    format!("{} 下载{}未完成：{error}", source.label, what.0),
                );
                failures.push(format!("{}：{error}", source.label));
            }
        }
    }
    Err(format!("没能下载{}。{}", what.0, failures.join("；")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn nothing_saved_or_auto_is_automatic_and_explicit_choices_are_kept() {
        assert_eq!(choice(&Value::Null), Choice::Auto);
        assert_eq!(choice(&json!({"mode": "auto"})), Choice::Auto);
        assert_eq!(choice(&json!({"mode": "official"})), Choice::Official);
        assert_eq!(
            choice(&json!({"mode": "mirror", "sourceId": "gh-proxy"})),
            Choice::Mirror("gh-proxy")
        );
        assert_eq!(
            choice(&json!({"mode": "mirror", "sourceId": "ghproxy"})),
            Choice::Mirror("ghproxy")
        );
        assert_eq!(
            choice(&json!({"mode": "mirror", "mirrorUrl": "https://m.example/{url}"})),
            Choice::Custom("https://m.example/{url}".into())
        );
        // A one-package template or a local file does not fit other files: automatic.
        assert_eq!(
            choice(&json!({"mode": "mirror", "mirrorUrl": "https://m.example/{version}/{asset}"})),
            Choice::Auto
        );
        assert_eq!(choice(&json!({"mode": "local"})), Choice::Auto);
    }

    #[test]
    fn ranking_puts_the_fastest_first_and_github_last_unless_it_won() {
        let probes = |a: Option<u64>, b: Option<u64>, g: Option<u64>| {
            vec![
                ("gh-proxy".to_owned(), a),
                ("ghproxy".to_owned(), b),
                (OFFICIAL_ID.to_owned(), g),
            ]
        };
        assert_eq!(
            rank(&probes(Some(300), Some(120), Some(90_000))),
            ["ghproxy", "gh-proxy", "official"]
        );
        assert_eq!(
            rank(&probes(Some(300), None, Some(80))),
            ["official", "gh-proxy", "ghproxy"]
        );
        // Every probe failed: mirrors in their usual order, GitHub last.
        assert_eq!(
            rank(&probes(None, None, None)),
            ["gh-proxy", "ghproxy", "official"]
        );
    }

    #[test]
    fn fixed_choices_try_their_source_then_github_and_official_is_github_only() {
        let ids = |choice: Choice| {
            fixed_order(&choice)
                .unwrap()
                .into_iter()
                .map(|source| source.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(fixed_order(&Choice::Auto), None);
        assert_eq!(ids(Choice::Official), ["official"]);
        assert_eq!(ids(Choice::Mirror("ghproxy")), ["ghproxy", "official"]);
        let custom = fixed_order(&Choice::Custom("https://m.example/{url}".into())).unwrap();
        assert_eq!(custom[0].label, "m.example");
        assert_eq!(
            custom[0].url("https://github.com/a/b.zip"),
            "https://m.example/https://github.com/a/b.zip"
        );
    }

    #[test]
    fn mirror_urls_wrap_the_official_url_and_summaries_name_each_host() {
        let official = "https://github.com/ggml-org/llama.cpp/archive/abc.zip";
        assert_eq!(
            Source::mirror("gh-proxy").unwrap().url(official),
            format!("https://gh-proxy.org/{official}")
        );
        assert_eq!(Source::official().url(official), official);
        let results = vec![
            (Source::mirror("gh-proxy").unwrap(), Some(182)),
            (Source::mirror("ghproxy").unwrap(), None),
            (Source::official(), Some(640)),
        ];
        assert_eq!(
            probe_summary(&results, true),
            "gh-proxy.org 182 ms · ghproxy.net 不可用 · GitHub 640 ms"
        );
        assert_eq!(reason(0, true), ("测速最快", "fastest"));
        assert_eq!(reason(1, true), ("备用来源", "fallback"));
    }
}
