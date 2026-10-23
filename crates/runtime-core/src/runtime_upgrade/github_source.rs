//! Where release metadata is read from. The domestic mirror comes first by default and
//! GitHub is the fallback; a user who chose the official source gets the reverse order.
//! Only transport changes: asset URLs stay canonical GitHub URLs, the signed feed is
//! still verified and every download is still checked against its SHA-256.
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};

/// Same store key and value shape the desktop download-source setting writes.
pub const PREFERENCES_KEY: &str = "runtimeDownloadPreferences";
/// gh-proxy.org also proxies api.github.com; ghproxy.net refuses API URLs.
const MIRROR_PREFIX: &str = "https://gh-proxy.org/";
pub const MIRROR_HOST: &str = "gh-proxy.org";

static OFFICIAL_FIRST: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Via {
    Mirror,
    Official,
}

/// Only an explicit official choice puts GitHub first; missing or unknown means mirror.
pub fn official_first(preferences: &Value) -> bool {
    preferences["mode"].as_str() == Some("official")
}

pub fn remember(preferences: &Value) {
    OFFICIAL_FIRST.store(official_first(preferences), Ordering::Relaxed);
}

pub fn sync(state: &crate::RuntimeState) {
    if let Ok(value) = crate::store_get(state, PREFERENCES_KEY.into()) {
        remember(&value);
    }
}

pub fn order() -> [Via; 2] {
    order_for(OFFICIAL_FIRST.load(Ordering::Relaxed))
}

pub fn order_for(official_first: bool) -> [Via; 2] {
    if official_first {
        [Via::Official, Via::Mirror]
    } else {
        [Via::Mirror, Via::Official]
    }
}

pub fn url(via: Via, official: &str) -> String {
    match via {
        Via::Official => official.to_owned(),
        Via::Mirror => format!("{MIRROR_PREFIX}{official}"),
    }
}

pub fn label(via: Via) -> &'static str {
    match via {
        Via::Official => "GitHub",
        Via::Mirror => "国内镜像",
    }
}

/// A short Chinese reason for one failed attempt; never Rust's error Debug text.
pub fn reason(status: Option<u16>, body: &str, transport: Option<&reqwest::Error>) -> String {
    if let Some(error) = transport {
        if error.is_timeout() {
            return "连接超时".into();
        }
        if error.is_connect() {
            return "无法建立连接".into();
        }
        if error.is_decode() {
            return "返回内容无法解析".into();
        }
        return "网络请求失败".into();
    }
    match status {
        Some(403 | 429) if body.contains("rate limit") => "请求过于频繁，已被限流".into(),
        Some(403) => "拒绝访问 (HTTP 403)".into(),
        Some(404) => "找不到该发布 (HTTP 404)".into(),
        Some(code) if code >= 500 => format!("服务暂时不可用 (HTTP {code})"),
        Some(code) => format!("HTTP {code}"),
        None => "返回内容无法解析".into(),
    }
}

/// Fetch one JSON document, trying the mirror and GitHub in the configured order.
/// `what` names the document in the combined error, e.g. "上游更新信息".
pub async fn get_json(
    client: &reqwest::Client,
    official: &str,
    what: &str,
) -> Result<(Value, Via), String> {
    let mut failures = Vec::new();
    for via in order() {
        let response = client
            .get(url(via, official))
            .header("Accept", "application/vnd.github+json")
            .send()
            .await;
        let failure = match response {
            Err(error) => reason(None, "", Some(&error)),
            Ok(response) => {
                let status = response.status();
                if status.is_success() {
                    match response.json::<Value>().await {
                        Ok(value) => return Ok((value, via)),
                        Err(error) => reason(None, "", Some(&error)),
                    }
                } else {
                    let body = response.text().await.unwrap_or_default();
                    reason(Some(status.as_u16()), &body, None)
                }
            }
        };
        failures.push(format!("{}：{failure}", label(via)));
    }
    Err(combined(what, &failures))
}

pub fn combined(what: &str, failures: &[String]) -> String {
    format!(
        "暂时无法获取{what}（{}）。请检查网络，稍后重试，或在设置的“下载来源”中切换来源",
        failures.join("；")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mirror_is_first_unless_official_was_chosen() {
        assert!(!official_first(&Value::Null));
        assert!(!official_first(
            &json!({"mode": "mirror", "sourceId": "ghproxy"})
        ));
        assert!(!official_first(&json!({"mode": "local"})));
        assert!(official_first(&json!({"mode": "official"})));
        assert_eq!(order_for(false), [Via::Mirror, Via::Official]);
        assert_eq!(order_for(true), [Via::Official, Via::Mirror]);
    }

    #[test]
    fn mirror_wraps_the_canonical_url() {
        let api = "https://api.github.com/repos/Niko1221/Strata/releases/latest";
        assert_eq!(url(Via::Official, api), api);
        assert_eq!(url(Via::Mirror, api), format!("https://gh-proxy.org/{api}"));
    }

    #[test]
    fn reasons_are_plain_chinese() {
        assert_eq!(
            reason(Some(403), "{\"message\":\"API rate limit exceeded\"}", None),
            "请求过于频繁，已被限流"
        );
        assert_eq!(reason(Some(502), "", None), "服务暂时不可用 (HTTP 502)");
        let text = combined(
            "上游更新信息",
            &["国内镜像：连接超时".into(), "GitHub：无法建立连接".into()],
        );
        assert!(text
            .starts_with("暂时无法获取上游更新信息（国内镜像：连接超时；GitHub：无法建立连接）"));
        assert!(!text.contains("error sending request"));
        assert!(!text.contains("Some("));
    }
}
