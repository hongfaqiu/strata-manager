//! The `auto` download source: Hugging Face when it can be reached, ModelScope when it cannot.
//! Only `auto` is ever probed; an explicit official / mirror / modelscope choice passes through.
use crate::setup_options::SetupOptions;
use std::{future::Future, time::Duration};

/// Upper bound for the whole check, connect and TLS included.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const PROBE_URL: &str = "https://huggingface.co/";
/// The one line written to the task log (and so shown as the task status) after a fallback.
pub const FALLBACK_NOTE: &str = "检测到无法连接 Hugging Face，已自动改用魔搭下载";

/// Whether huggingface.co answers over HTTPS. Any HTTP answer counts, only a transport failure
/// does not. The client follows the system proxy like the installer's own downloads.
pub async fn hf_reachable() -> bool {
    reachable(PROBE_URL).await
}

async fn reachable(url: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .connect_timeout(PROBE_TIMEOUT)
        .timeout(PROBE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return true;
    };
    client.head(url).send().await.is_ok()
}

/// Turns `auto` into the source this task uses. Returns the options to run and the note to log.
pub async fn resolve<F, Fut>(
    options: Option<SetupOptions>,
    probe: F,
) -> (Option<SetupOptions>, Option<&'static str>)
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = bool>,
{
    resolve_within(options, probe, PROBE_TIMEOUT).await
}

pub(crate) async fn resolve_within<F, Fut>(
    options: Option<SetupOptions>,
    probe: F,
    limit: Duration,
) -> (Option<SetupOptions>, Option<&'static str>)
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = bool>,
{
    let Some(mut options) = options else {
        return (None, None);
    };
    if options.source.as_deref() != Some("auto") {
        return (Some(options), None);
    }
    let reachable = tokio::time::timeout(limit, probe()).await.unwrap_or(false);
    options.hf_endpoint = None;
    if reachable {
        options.source = Some("official".into());
        (Some(options), None)
    } else {
        options.source = Some("modelscope".into());
        (Some(options), Some(FALLBACK_NOTE))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn with_source(source: Option<&str>) -> Option<SetupOptions> {
        Some(SetupOptions {
            source: source.map(Into::into),
            backend: Some("cuda".into()),
            gpus: Some("1".into()),
            ..Default::default()
        })
    }

    #[tokio::test]
    async fn reachable_huggingface_keeps_the_official_arguments() {
        let (options, note) = resolve(with_source(Some("auto")), || async { true }).await;
        let options = options.unwrap();
        assert_eq!(options.source.as_deref(), Some("official"));
        assert_eq!(options.backend.as_deref(), Some("cuda"));
        assert_eq!(options.gpus.as_deref(), Some("1"));
        assert!(note.is_none());
        let mut args = vec![];
        options.append_args(&mut args).unwrap();
        assert_eq!(
            args,
            ["--source", "huggingface", "--backend", "cuda", "--gpu", "1"]
        );
        assert_eq!(
            options.environment().unwrap()["STRATA_SOURCE"],
            Some("huggingface".into())
        );
    }

    #[tokio::test]
    async fn unreachable_huggingface_switches_this_task_to_modelscope() {
        let (options, note) = resolve(with_source(Some("auto")), || async { false }).await;
        let options = options.unwrap();
        assert_eq!(options.source.as_deref(), Some("modelscope"));
        assert_eq!(options.backend.as_deref(), Some("cuda"));
        assert_eq!(note, Some(FALLBACK_NOTE));
        let mut args = vec![];
        options.append_args(&mut args).unwrap();
        assert_eq!(
            args,
            ["--source", "modelscope", "--backend", "cuda", "--gpu", "1"]
        );
        assert_eq!(
            options.environment().unwrap()["STRATA_SOURCE"],
            Some("modelscope".into())
        );
    }

    #[tokio::test]
    async fn an_explicit_source_is_never_probed_or_changed() {
        for source in [Some("official"), Some("modelscope"), None] {
            let probes = AtomicUsize::new(0);
            let (options, note) = resolve(with_source(source), || async {
                probes.fetch_add(1, Ordering::SeqCst);
                false
            })
            .await;
            assert_eq!(probes.load(Ordering::SeqCst), 0, "{source:?}");
            assert_eq!(options.unwrap().source.as_deref(), source);
            assert!(note.is_none());
        }
        let mirror = Some(SetupOptions {
            source: Some("mirror".into()),
            hf_endpoint: Some("https://hf-mirror.com".into()),
            ..Default::default()
        });
        let (options, note) = resolve(mirror, || async { panic!("probed") }).await;
        assert_eq!(
            options.unwrap().hf_endpoint.as_deref(),
            Some("https://hf-mirror.com")
        );
        assert!(note.is_none());
        let (none, note) = resolve(None, || async { panic!("probed") }).await;
        assert!(none.is_none() && note.is_none());
    }

    #[tokio::test]
    async fn a_probe_that_never_answers_is_cut_off_and_counts_as_unreachable() {
        let started = std::time::Instant::now();
        let (options, note) = resolve_within(
            with_source(Some("auto")),
            std::future::pending::<bool>,
            Duration::from_millis(60),
        )
        .await;
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(options.unwrap().source.as_deref(), Some("modelscope"));
        assert_eq!(note, Some(FALLBACK_NOTE));
        assert!(PROBE_TIMEOUT <= Duration::from_secs(3));
    }

    #[tokio::test]
    async fn the_real_probe_returns_false_quickly_for_a_closed_port() {
        let started = std::time::Instant::now();
        assert!(!reachable("https://127.0.0.1:9/").await);
        assert!(started.elapsed() <= PROBE_TIMEOUT + Duration::from_secs(1));
    }
}
