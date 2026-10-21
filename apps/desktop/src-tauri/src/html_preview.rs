//! Sandboxed previews of HTML that a model wrote in a chat answer.
//!
//! The document is served from its own `strata-preview` URI scheme, never
//! from the app origin: the frame is cross-origin to the app, does not inherit
//! the app's CSP (a `srcdoc` frame would, and its inline scripts would then be
//! blocked), and carries a response CSP that forbids every network fetch,
//! including the `ipc:` custom protocol behind Tauri commands. The frontend
//! also embeds it with `sandbox="allow-scripts"` (no `allow-same-origin`), so
//! the document runs in an opaque origin without access to the parent page,
//! storage, cookies, forms, popups or top-level navigation.
use std::{collections::VecDeque, path::Path, sync::Mutex};

use tauri::http::{header, Request, Response, StatusCode};

pub(crate) const SCHEME: &str = "strata-preview";
const MAX_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_DOCUMENTS: usize = 48;

/// No network at all: inline scripts, styles and data/blob media only.
pub(crate) const DOCUMENT_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts";

#[derive(Default)]
pub(crate) struct HtmlPreviews {
    documents: Mutex<VecDeque<(String, String)>>,
}

impl HtmlPreviews {
    pub(crate) fn register(&self, html: String) -> Result<String, String> {
        if html.len() > MAX_DOCUMENT_BYTES {
            return Err("HTML 超过 4 MiB，无法预览 / HTML exceeds 4 MiB".into());
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        let mut documents = self
            .documents
            .lock()
            .map_err(|_| "预览状态不可用 / Preview state unavailable")?;
        while documents.len() >= MAX_DOCUMENTS {
            documents.pop_front();
        }
        documents.push_back((id.clone(), html));
        Ok(id)
    }

    fn get(&self, id: &str) -> Option<String> {
        let documents = self.documents.lock().ok()?;
        documents
            .iter()
            .find(|(known, _)| known == id)
            .map(|(_, html)| html.clone())
    }

    /// Serve `strata-preview://localhost/<id>` (or `http://strata-preview.localhost/<id>` on Windows).
    pub(crate) fn respond(&self, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        let id = request.uri().path().trim_start_matches('/');
        let valid = id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit());
        let document = if request.method() == tauri::http::Method::GET && valid {
            self.get(id)
        } else {
            None
        };
        let (status, body) = match document {
            Some(html) => (StatusCode::OK, html.into_bytes()),
            None => (StatusCode::NOT_FOUND, b"Preview expired".to_vec()),
        };
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CONTENT_SECURITY_POLICY, DOCUMENT_CSP)
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::REFERRER_POLICY, "no-referrer")
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .body(body)
            .unwrap_or_else(|_| Response::new(Vec::new()))
    }
}

/// Save the previewed document where the user chose in the save dialog.
pub(crate) fn save(path: &Path, html: &str) -> Result<String, String> {
    if html.len() > MAX_DOCUMENT_BYTES {
        return Err("HTML 超过 4 MiB / HTML exceeds 4 MiB".into());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension != "html" && extension != "htm" {
        return Err("请保存为 .html 文件 / Save as an .html file".into());
    }
    if !path.is_absolute() {
        return Err("保存路径必须是绝对路径 / Save path must be absolute".into());
    }
    std::fs::write(path, html.as_bytes())
        .map_err(|error| format!("HTML 保存失败 / HTML save failed: {error}"))?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(previews: &HtmlPreviews, path: &str) -> Response<Vec<u8>> {
        let request = Request::builder()
            .uri(format!("strata-preview://localhost{path}"))
            .body(Vec::new())
            .unwrap();
        previews.respond(&request)
    }

    #[test]
    fn serves_a_registered_document_with_a_no_network_sandbox_policy() {
        let previews = HtmlPreviews::default();
        let id = previews
            .register("<p>hi</p><script>1</script>".into())
            .unwrap();
        let response = get(&previews, &format!("/{id}"));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), b"<p>hi</p><script>1</script>");
        let csp = response.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap();
        for directive in [
            "default-src 'none'",
            "connect-src 'none'",
            "form-action 'none'",
            "sandbox allow-scripts",
        ] {
            assert!(csp.contains(directive), "{directive}");
        }
        assert!(!csp.contains("allow-same-origin"));
        assert!(!csp.contains("http") && !csp.contains("https:") && !csp.contains("ipc:"));
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }

    #[test]
    fn unknown_malformed_and_evicted_ids_are_not_found() {
        let previews = HtmlPreviews::default();
        assert_eq!(
            get(&previews, "/../etc/passwd").status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            get(&previews, &format!("/{}", "0".repeat(32))).status(),
            StatusCode::NOT_FOUND
        );
        let first = previews.register("a".into()).unwrap();
        for _ in 0..MAX_DOCUMENTS {
            previews.register("b".into()).unwrap();
        }
        assert_eq!(
            get(&previews, &format!("/{first}")).status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn rejects_oversized_documents_and_non_html_save_targets() {
        let previews = HtmlPreviews::default();
        assert!(previews
            .register("x".repeat(MAX_DOCUMENT_BYTES + 1))
            .is_err());
        let dir = tempfile::tempdir().unwrap();
        assert!(save(&dir.path().join("page.exe"), "<p></p>").is_err());
        assert!(save(Path::new("relative.html"), "<p></p>").is_err());
        let target = dir.path().join("page.HTML");
        save(&target, "<p>ok</p>").unwrap();
        assert_eq!(std::fs::read_to_string(target).unwrap(), "<p>ok</p>");
    }
}
