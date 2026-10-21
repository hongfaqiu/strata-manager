//! Read-only Hugging Face model API for the community model discovery (packages/core community-discovery.ts).
//! The webview has no network (CSP `connect-src` is IPC only). Only three GET shapes are allowed: the model
//! search with a fixed set of query keys, one repository's info, and one repository's tree at a 40-hex revision.
//! Responses are size-limited; huggingface.co first, then the hf-mirror.com mirror when it cannot be reached.
use std::sync::OnceLock;
use std::time::Duration;

const HOSTS: [&str; 2] = ["https://huggingface.co", "https://hf-mirror.com"];
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const SEARCH_KEYS: [&str; 5] = ["search", "filter", "sort", "direction", "limit"];

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent(concat!("StrataManager/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default()
    })
}

fn repo_part(part: &str) -> bool {
    (1..=96).contains(&part.len())
        && part
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && part.as_bytes()[0].is_ascii_alphanumeric()
        && !part.contains("..")
}
fn query_value(value: &str) -> bool {
    (1..=80).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'%' | b'+'))
}

/// The allowed request shapes; anything else is refused before any network access.
pub(crate) fn allowed_path(path: &str) -> bool {
    if path.len() > 300 {
        return false;
    }
    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    let parts: Vec<&str> = route.split('/').collect();
    match parts.as_slice() {
        ["", "api", "models"] => {
            !query.is_empty()
                && query.split('&').all(|pair| {
                    pair.split_once('=').is_some_and(|(key, value)| {
                        SEARCH_KEYS.contains(&key) && query_value(value)
                    })
                })
        }
        ["", "api", "models", owner, name] => {
            query.is_empty() && repo_part(owner) && repo_part(name)
        }
        ["", "api", "models", owner, name, "tree", revision] => {
            repo_part(owner)
                && repo_part(name)
                && revision.len() == 40
                && revision
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                && (query.is_empty() || query == "recursive=true")
        }
        _ => false,
    }
}

#[tauri::command]
pub async fn hf_models_api(path: String) -> Result<String, String> {
    if !allowed_path(&path) {
        return Err("hf_path_not_allowed".into());
    }
    let mut last = String::new();
    for host in HOSTS {
        let response = match client().get(format!("{host}{path}")).send().await {
            Ok(response) => response,
            Err(error) => {
                last = format!("network: {}", error.without_url());
                continue;
            }
        };
        let status = response.status();
        if !status.is_success() {
            return Err(format!("hf_http_{}", status.as_u16()));
        }
        if response
            .content_length()
            .is_some_and(|len| len as usize > MAX_RESPONSE_BYTES)
        {
            return Err("hf_response_too_large".into());
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("network: {}", e.without_url()))?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err("hf_response_too_large".into());
        }
        return String::from_utf8(bytes.to_vec()).map_err(|_| "hf_response_invalid".into());
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::allowed_path;

    #[test]
    fn only_the_three_read_shapes_are_allowed() {
        assert!(allowed_path(
            "/api/models?search=GSQ-RCO&filter=gguf&sort=downloads&direction=-1&limit=40"
        ));
        assert!(allowed_path(
            "/api/models?search=Qwen3.8-Flash-Next&filter=gguf"
        ));
        assert!(allowed_path(
            "/api/models/SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF"
        ));
        assert!(allowed_path("/api/models/SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF/tree/eec4e10a2c29b440a2ae85591fa11569ce752963?recursive=true"));
        for bad in [
            "/api/models",
            "/api/models?token=x",
            "/api/models?search=a&author=b",
            "/api/models?search=a b",
            "/api/models/a/b/tree/main",
            "/api/models/a/b/resolve/eec4e10a2c29b440a2ae85591fa11569ce752963/x.gguf",
            "/api/models/../b",
            "/api/models/a/b?x=1",
            "/api/datasets?search=a",
            "https://evil.example/api/models?search=a",
            "//evil.example/api/models?search=a",
        ] {
            assert!(!allowed_path(bad), "{bad}");
        }
    }
}
