//! Sandboxed previews of HTML that a model wrote in a chat answer.
//!
//! The document is served from its own `strata-preview` URI scheme, never
//! from the app origin: the frame is cross-origin to the app and does not
//! inherit the app's CSP (a `srcdoc` frame would, and its inline scripts would
//! then be blocked). Its response CSP lets the page reach the internet over
//! `https:`/`wss:` (CDNs, web fonts, APIs) but never plain `http:` or the
//! `ipc:` scheme, so neither `ipc://localhost` nor Windows'
//! `http://ipc.localhost` (Tauri commands) nor services on `http://localhost`
//! are reachable. The `sandbox allow-scripts` directive (repeated by the
//! frontend's `sandbox="allow-scripts"`, never `allow-same-origin`) gives the
//! document an opaque origin even if it is loaded on its own: it sends
//! `Origin: null`, which Tauri's IPC rejects, has no access to the parent page,
//! its storage or Tauri globals (the invoke key is only injected into the main
//! frame), and cannot open popups, submit forms or navigate the top window.
//!
//! "Open in browser" writes a copy to the app cache and hands it to the system
//! default browser, outside the app entirely.
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime},
};

use tauri::http::{header, Request, Response, StatusCode};

pub(crate) const SCHEME: &str = "strata-preview";
const MAX_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_DOCUMENTS: usize = 48;

/// Internet over https/wss only (never `http:` or `ipc:`), no nested frames, forms or plugins, always sandboxed.
/// Must equal `PREVIEW_CSP` in `src/chat/htmlPreview.ts` plus `; sandbox allow-scripts`.
pub(crate) const DOCUMENT_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: data: blob:; style-src 'unsafe-inline' https: data:; img-src https: data: blob:; font-src https: data:; media-src https: data: blob:; connect-src https: wss: data: blob:; worker-src blob:; frame-src 'none'; child-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts";

/// Copies written for "Open in browser" live in `<app cache>/html-previews` and are pruned when a new one is written.
const BROWSER_COPY_PREFIX: &str = "preview-";
const BROWSER_COPY_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const BROWSER_COPY_KEEP: usize = 20;

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

/// Write `html` to a new uniquely named file in `dir` (created if missing) for the system browser, after removing
/// copies older than a day and all but the newest few. Only files this function named are ever removed.
pub(crate) fn write_browser_copy(dir: &Path, html: &str) -> Result<PathBuf, String> {
    if html.len() > MAX_DOCUMENT_BYTES {
        return Err("HTML 超过 4 MiB / HTML exceeds 4 MiB".into());
    }
    if !dir.is_absolute() {
        return Err("预览目录必须是绝对路径 / Preview folder must be absolute".into());
    }
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("无法创建预览目录 / Cannot create preview folder: {error}"))?;
    prune_browser_copies(dir, SystemTime::now());
    let path = dir.join(format!(
        "{BROWSER_COPY_PREFIX}{}.html",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&path, html.as_bytes())
        .map_err(|error| format!("HTML 写入失败 / HTML write failed: {error}"))?;
    Ok(path)
}

fn is_browser_copy(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix(BROWSER_COPY_PREFIX))
        .and_then(|rest| rest.strip_suffix(".html"))
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn prune_browser_copies(dir: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut copies: Vec<(SystemTime, PathBuf)> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_browser_copy(path))
        .map(|path| {
            let modified = std::fs::metadata(&path)
                .and_then(|meta| meta.modified())
                .unwrap_or(now);
            (modified, path)
        })
        .collect();
    copies.sort_by_key(|copy| std::cmp::Reverse(copy.0));
    for (index, (modified, path)) in copies.iter().enumerate() {
        let stale = now
            .duration_since(*modified)
            .is_ok_and(|age| age > BROWSER_COPY_MAX_AGE);
        // keep room for the copy about to be written
        if stale || index + 1 >= BROWSER_COPY_KEEP {
            let _ = std::fs::remove_file(path);
        }
    }
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
    fn serves_a_registered_document_with_an_https_only_sandbox_policy() {
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
            "connect-src https: wss: data: blob:",
            "font-src https: data:",
            "frame-src 'none'",
            "form-action 'none'",
            "base-uri 'none'",
            "sandbox allow-scripts",
        ] {
            assert!(csp.contains(directive), "{directive}");
        }
        assert!(
            !csp.contains("allow-same-origin")
                && !csp.contains("allow-popups")
                && !csp.contains("allow-top-navigation")
        );
        // the network is https/wss only: never plain http (http://ipc.localhost, local services), ipc: or wildcards
        let sources: Vec<&str> = csp.split([';', ' ']).collect();
        for banned in ["http:", "ws:", "ipc:", "*", "'self'"] {
            assert!(!sources.contains(&banned), "{banned}");
        }
        assert!(!csp.contains("localhost"));
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

    #[test]
    fn browser_copies_are_unique_html_files_and_old_ones_are_pruned() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("html-previews");
        let first = write_browser_copy(&folder, "<p>one</p>").unwrap();
        let second = write_browser_copy(&folder, "<p>two</p>").unwrap();
        assert_ne!(first, second);
        assert!(is_browser_copy(&first) && first.starts_with(&folder));
        assert_eq!(first.extension().unwrap(), "html");
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "<p>two</p>");
        assert!(write_browser_copy(Path::new("relative"), "<p></p>").is_err());
        assert!(write_browser_copy(&folder, &"x".repeat(MAX_DOCUMENT_BYTES + 1)).is_err());

        // a day later both copies are stale; files we did not name are never touched
        let other = folder.join("notes.html");
        std::fs::write(&other, "keep").unwrap();
        prune_browser_copies(
            &folder,
            SystemTime::now() + BROWSER_COPY_MAX_AGE + Duration::from_secs(60),
        );
        assert!(!first.exists() && !second.exists());
        assert!(other.exists());

        // only the newest few are kept
        for _ in 0..BROWSER_COPY_KEEP + 5 {
            write_browser_copy(&folder, "<p></p>").unwrap();
        }
        let copies = std::fs::read_dir(&folder)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| is_browser_copy(&entry.path()))
            .count();
        assert!(copies <= BROWSER_COPY_KEEP, "{copies}");
    }
}
