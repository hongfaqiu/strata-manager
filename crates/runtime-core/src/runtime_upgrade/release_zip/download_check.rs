//! Read-only source checks never admit an installation or create download files.
use super::{RuntimeReleaseAsset, RuntimeUpdateInfo, RuntimeZipDownloadOptions};
use crate::{types::now, RuntimeState};
use futures_util::StreamExt;
use reqwest::{header, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read, path::Path, time::Duration};

const SAMPLE_BYTES: u64 = 64 * 1024;
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeZipDownloadCheckResult {
    pub source: String,
    pub asset_name: String,
    pub checked_at: u64,
    pub checked_bytes: u64,
    pub total_bytes: u64,
    pub range_supported: Option<bool>,
    pub sha256_verified: bool,
}

fn select_official_asset(
    info: &RuntimeUpdateInfo,
    name: &str,
) -> Result<RuntimeReleaseAsset, String> {
    if let Some(error) = &info.error {
        return Err(format!("无法核实官方更新包：{error}"));
    }
    let asset = info
        .assets
        .iter()
        .find(|asset| asset.name == name)
        .ok_or("此 Release 没有所选的可校验官方引擎包")?;
    let version = info
        .latest_version
        .as_deref()
        .ok_or("官方 Release 版本缺失")?;
    if !super::engine_package::is_installable_asset_name(name)
        || !(1..=super::engine_package::MAX_PACKAGE_BYTES).contains(&asset.size)
        || asset.sha256.len() != 64
        || !asset.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        || ![format!("v{version}"), version.to_owned()]
            .iter()
            .any(|tag| {
                asset.url
                    == format!("https://github.com/Niko1221/Strata/releases/download/{tag}/{name}")
            })
    {
        return Err("官方更新包的下载地址、长度或 SHA256 元数据无效".into());
    }
    Ok(asset.clone())
}

fn safe_https(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

fn probe_client(mirror: bool) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("download source check redirect limit exceeded");
            }
            if safe_https(attempt.url())
                && (mirror
                    || matches!(
                        attempt.url().host_str(),
                        Some(
                            "github.com"
                                | "release-assets.githubusercontent.com"
                                | "objects.githubusercontent.com"
                        )
                    ))
            {
                attempt.follow()
            } else {
                attempt.error("download source check refused unsafe HTTPS redirect")
            }
        }))
        .build()
        .map_err(|error| error.to_string())
}

fn check_local(
    path: &Path,
    asset: &RuntimeReleaseAsset,
) -> Result<RuntimeZipDownloadCheckResult, String> {
    let mut file = File::open(path).map_err(|error| format!("无法读取本地引擎包：{error}"))?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() != asset.size {
        return Err("本地引擎包 的长度与所选官方更新包不符".into());
    }
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 256 * 1024];
    let mut checked = 0u64;
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("本地引擎包 读取失败：{error}"))?;
        if count == 0 {
            break;
        }
        checked = checked
            .checked_add(count as u64)
            .ok_or("本地引擎包 长度无效")?;
        if checked > asset.size {
            return Err("读取期间本地引擎包 长度发生变化，请重试".into());
        }
        digest.update(&buffer[..count]);
    }
    if checked != asset.size
        || format!("{:x}", digest.finalize()) != asset.sha256.to_ascii_lowercase()
    {
        return Err("本地引擎包 的 SHA256 与所选官方更新包不符".into());
    }
    Ok(RuntimeZipDownloadCheckResult {
        source: "local".into(),
        asset_name: asset.name.clone(),
        checked_at: now(),
        checked_bytes: checked,
        total_bytes: asset.size,
        range_supported: None,
        sha256_verified: true,
    })
}

fn sample_range(response: &reqwest::Response, asset_size: u64) -> Result<u64, String> {
    let invalid = || "来源返回的 Content-Range 与官方更新包或请求范围不符".to_owned();
    let range = response
        .headers()
        .get(header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("bytes "))
        .ok_or_else(invalid)?;
    let (range, total) = range.split_once('/').ok_or_else(invalid)?;
    let (start, end) = range.split_once('-').ok_or_else(invalid)?;
    let start: u64 = start.parse().map_err(|_| invalid())?;
    let end: u64 = end.parse().map_err(|_| invalid())?;
    let total: u64 = total.parse().map_err(|_| invalid())?;
    let sample = SAMPLE_BYTES.min(asset_size);
    if start != 0
        || end.checked_add(1) != Some(sample)
        || total != asset_size
        || response
            .content_length()
            .is_some_and(|length| length != sample)
    {
        return Err(invalid());
    }
    Ok(sample)
}

async fn check_network(
    url: &str,
    asset: &RuntimeReleaseAsset,
    source: &str,
    client: &reqwest::Client,
) -> Result<RuntimeZipDownloadCheckResult, String> {
    let response = client
        .get(url)
        .header(header::RANGE, "bytes=0-65535")
        .header(header::ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|error| format!("无法连接下载来源：{error}"))?;
    if response
        .headers()
        .get(header::CONTENT_ENCODING)
        .is_some_and(|value| value.as_bytes() != b"identity")
    {
        return Err("下载来源返回压缩编码，无法可靠核实 ZIP 字节范围".into());
    }
    let (range_supported, expected) = match response.status() {
        StatusCode::PARTIAL_CONTENT => (true, sample_range(&response, asset.size)?),
        StatusCode::OK => {
            if response
                .content_length()
                .is_some_and(|length| length != asset.size)
            {
                return Err("下载来源声明的长度与官方更新包不符".into());
            }
            (false, SAMPLE_BYTES.min(asset.size))
        }
        status => return Err(format!("下载来源返回 HTTP {status}")),
    };
    let mut checked = 0u64;
    let mut stream = response.bytes_stream();
    while checked < expected {
        let chunk = stream
            .next()
            .await
            .ok_or("下载来源提前结束，未取得预期测试样本")?
            .map_err(|error| format!("下载来源读取失败：{error}"))?;
        // Discard the response immediately after the bounded sample. In
        // particular a 200 response must never cause a whole engine download.
        checked += (chunk.len() as u64).min(expected - checked);
    }
    Ok(RuntimeZipDownloadCheckResult {
        source: source.into(),
        asset_name: asset.name.clone(),
        checked_at: now(),
        checked_bytes: checked,
        total_bytes: asset.size,
        range_supported: Some(range_supported),
        // Even a small network response is only a reachability/range check.
        sha256_verified: false,
    })
}

async fn check_network_before(
    deadline: tokio::time::Instant,
    url: &str,
    asset: &RuntimeReleaseAsset,
    source: &str,
    client: &reqwest::Client,
) -> Result<RuntimeZipDownloadCheckResult, String> {
    tokio::time::timeout_at(deadline, check_network(url, asset, source, client))
        .await
        .map_err(|_| "下载来源测试超过 20 秒，请检查网络后重试".to_owned())?
}

/// Resolve through the same CUDA/HIP compatibility rules used by installation.
/// Reading BUILD.json and release metadata never starts or changes a service.
pub async fn resolve_release_download_asset(
    state: &RuntimeState,
    install_dir: &str,
    requested: Option<&str>,
) -> Result<RuntimeReleaseAsset, String> {
    resolve_release_download_asset_for(state, install_dir, requested, None).await
}

/// As above, for a chosen release version instead of the latest one.
pub async fn resolve_release_download_asset_for(
    state: &RuntimeState,
    install_dir: &str,
    requested: Option<&str>,
    target_version: Option<&str>,
) -> Result<RuntimeReleaseAsset, String> {
    if !Path::new(install_dir).is_absolute() {
        return Err("运行环境目录必须是绝对路径".into());
    }
    // Linux packages match by the detected GPU when the installed engine has no known type.
    let unknown = requested.is_none() && super::variant(Path::new(install_dir)).is_none();
    if unknown && super::engine_package::this_release_install_platform() != Some("linux-x86_64") {
        return Err("无法识别当前 CUDA/HIP 引擎，请手动选择更新包 / The installed CUDA/HIP engine is not recognised; choose the update package".into());
    }
    let cached = crate::store_get(state, super::super::UPDATE_INFO_KEY.into())?;
    let info = tokio::time::timeout(CHECK_TIMEOUT, async {
        match target_version {
            Some(version) => super::super::release_versions::release_info(version).await,
            None => super::super::update_info_with_cache(cached, false).await,
        }
    })
    .await
    .map_err(|_| "匹配更新包超过 20 秒，请检查网络后重试".to_owned())??;
    if unknown && super::release_platform(&info) != "linux-x86_64" {
        return Err("无法识别当前 CUDA/HIP 引擎，请手动选择更新包 / The installed CUDA/HIP engine is not recognised; choose the update package".into());
    }
    let install_dir = install_dir.to_owned();
    let requested = requested.map(str::to_owned);
    let chosen = {
        let info = info.clone();
        // GPU probes run tools (nvidia-smi, rocminfo); keep them off the async workers.
        tokio::task::spawn_blocking(move || {
            super::choose_asset(&info, Path::new(&install_dir), requested.as_deref())
        })
        .await
        .map_err(|error| error.to_string())??
    };
    let mut asset = select_official_asset(&info, &chosen.name)?;
    asset.match_reason = chosen.match_reason;
    Ok(asset)
}

pub async fn test_release_download(
    state: &RuntimeState,
    asset_name: &str,
    download: RuntimeZipDownloadOptions,
) -> Result<RuntimeZipDownloadCheckResult, String> {
    if asset_name.is_empty() {
        return Err("请先选择对应的官方更新包".into());
    }
    let download = download.validate(Some(asset_name))?;
    let deadline = tokio::time::Instant::now() + CHECK_TIMEOUT;
    // Read the existing update metadata, or fetch it without persisting it.
    // The source check never changes configuration or the metadata cache.
    let cached = crate::store_get(state, super::super::UPDATE_INFO_KEY.into())?;
    let info = tokio::time::timeout_at(
        deadline,
        super::super::update_info_with_cache(cached, false),
    )
    .await
    .map_err(|_| "下载来源测试超过 20 秒，请检查网络后重试".to_owned())??;
    let asset = select_official_asset(&info, asset_name)?;
    if let Some(path) = download.local_archive_path {
        return tokio::task::spawn_blocking(move || check_local(Path::new(&path), &asset))
            .await
            .map_err(|error| format!("本地引擎包 检查失败：{error}"))?;
    }
    let mirror = download.download_url.is_some();
    let source = if mirror { "mirror" } else { "official" };
    let url = download.download_url.as_deref().unwrap_or(&asset.url);
    if !safe_https(&url::Url::parse(url).map_err(|_| "下载来源地址无效")?) {
        return Err("下载来源必须使用 HTTPS 且不能包含凭据或片段".into());
    }
    let client = probe_client(mirror)?;
    check_network_before(deadline, url, &asset, source, &client).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::{
        fs,
        io::Write,
        net::TcpListener,
        sync::{atomic::Ordering, Arc, Mutex},
        thread,
        time::Instant,
    };

    fn asset(bytes: &[u8]) -> RuntimeReleaseAsset {
        RuntimeReleaseAsset {
            name: "strata-windows-x64.zip".into(),
            url: "https://github.com/Niko1221/Strata/releases/download/v0.1.42/strata-windows-x64.zip".into(),
            size: bytes.len() as u64, sha256: format!("{:x}", Sha256::digest(bytes)), variant: "cuda13".into(),
            ..Default::default()
        }
    }

    fn metadata(asset: RuntimeReleaseAsset) -> Value {
        serde_json::to_value(RuntimeUpdateInfo {
            checked_at: now(),
            supported_version: crate::runtime_upgrade::VERSION.into(),
            supported_revision: crate::installation::SOURCE_REVISION.into(),
            latest_version: Some("0.1.42".into()),
            release_name: None,
            release_url: None,
            notes: None,
            published_at: None,
            assets: vec![asset],
            source_revision: Some(crate::installation::SOURCE_REVISION.into()),
            source_archive_url: Some(crate::installation::SOURCE_URL.into()),
            update_available: true,
            installable: true,
            error: None,
            feed_sequence: None,
        })
        .unwrap()
    }

    fn fixture(
        bytes: &[u8],
    ) -> (
        tempfile::TempDir,
        Arc<RuntimeState>,
        std::path::PathBuf,
        Value,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let source = temp.path().join("engine.zip");
        fs::write(&source, bytes).unwrap();
        let info = metadata(asset(bytes));
        crate::store_set(
            &state,
            crate::runtime_upgrade::UPDATE_INFO_KEY.into(),
            info.clone(),
        )
        .unwrap();
        crate::store_set(&state, "localServiceDesired".into(), json!(false)).unwrap();
        fs::write(
            state.data_dir().join("config.json"),
            b"readonly fixture config",
        )
        .unwrap();
        (temp, state, source, info)
    }

    #[tokio::test]
    async fn automatic_package_resolution_preserves_each_engine_and_remains_readonly() {
        let (temp, state, _, mut info) = fixture(b"official fixture archive");
        let mut assets = Vec::new();
        for (variant, name) in [
            ("cuda13", "strata-windows-x64.zip"),
            ("cuda12", "strata-windows-x64-cuda12.zip"),
            ("hip", "strata-windows-x64-hip.zip"),
        ] {
            let mut item = asset(b"official fixture archive");
            item.variant = variant.into();
            item.name = name.into();
            item.url =
                format!("https://github.com/Niko1221/Strata/releases/download/v0.1.42/{name}");
            assets.push(item);
        }
        info["assets"] = serde_json::to_value(&assets).unwrap();
        crate::store_set(
            &state,
            crate::runtime_upgrade::UPDATE_INFO_KEY.into(),
            info.clone(),
        )
        .unwrap();
        let root = temp.path().join("installed");
        fs::create_dir_all(root.join("engine")).unwrap();
        for (backend, cuda, expected) in [
            ("cuda", 13, "cuda13"),
            ("cuda", 12, "cuda12"),
            ("hip", 0, "hip"),
        ] {
            fs::write(
                root.join("engine/BUILD.json"),
                serde_json::to_vec(&json!({"backend":backend,"cuda":cuda})).unwrap(),
            )
            .unwrap();
            let selected = resolve_release_download_asset(&state, root.to_str().unwrap(), None)
                .await
                .unwrap();
            assert_eq!(selected.variant, expected);
            let wrong = assets.iter().find(|item| item.variant != expected).unwrap();
            assert!(resolve_release_download_asset(
                &state,
                root.to_str().unwrap(),
                Some(&wrong.name)
            )
            .await
            .is_err());
            assert_readonly(&state, &info);
        }
    }

    #[tokio::test]
    async fn automatic_package_resolution_rejects_unknown_engine_instead_of_guessing() {
        let (temp, state, _, info) = fixture(b"official fixture archive");
        assert!(
            resolve_release_download_asset(&state, "relative/path", None)
                .await
                .is_err()
        );
        let root = temp.path().join("unknown-engine");
        let error = resolve_release_download_asset(&state, root.to_str().unwrap(), None)
            .await
            .unwrap_err();
        assert!(error.contains("手动选择"));
        assert_readonly(&state, &info);
    }

    #[tokio::test]
    async fn automatic_package_resolution_uses_build_metadata_instead_of_cuda12_directory_name() {
        let (temp, state, _, info) = fixture(b"official fixture archive");
        let root = temp.path().join("installed");
        fs::create_dir_all(root.join("engine-cuda12")).unwrap();
        for build in [
            json!({}),
            json!({"backend":"sycl"}),
            json!({"cuda":"129.0"}),
            json!({"backend":"sycl","cuda":"12.9"}),
        ] {
            fs::write(
                root.join("engine-cuda12/BUILD.json"),
                serde_json::to_vec(&build).unwrap(),
            )
            .unwrap();
            assert!(
                resolve_release_download_asset(&state, root.to_str().unwrap(), None)
                    .await
                    .is_err()
            );
        }
        fs::write(root.join("engine-cuda12/BUILD.json"), br#"{"cuda":"13.0"}"#).unwrap();
        let selected = resolve_release_download_asset(&state, root.to_str().unwrap(), None)
            .await
            .unwrap();
        assert_eq!(selected.variant, "cuda13");
        assert_readonly(&state, &info);
    }

    fn assert_readonly(state: &RuntimeState, metadata: &Value) {
        assert!(state.tasks.lock().unwrap().is_empty());
        assert!(state.processes.lock().unwrap().is_empty());
        assert_eq!(
            crate::store_get(state, crate::runtime_upgrade::UPDATE_INFO_KEY.into()).unwrap(),
            *metadata
        );
        assert_eq!(
            crate::store_get(state, "localServiceDesired".into()).unwrap(),
            false
        );
        assert_eq!(
            fs::read(state.data_dir().join("config.json")).unwrap(),
            b"readonly fixture config"
        );
        for name in ["downloads", "runtimes", "zip-updates", "zu"] {
            assert!(
                !state.data_dir().join(name).exists(),
                "source check created {name}"
            );
        }
    }

    #[tokio::test]
    async fn local_download_check_reads_and_hashes_without_any_runtime_mutation() {
        let bytes = vec![b'x'; 300_000]; // Exercises more than one local read block.
        let (_temp, state, source, metadata) = fixture(&bytes);
        let result = test_release_download(
            &state,
            "strata-windows-x64.zip",
            RuntimeZipDownloadOptions {
                local_archive_path: Some(source.to_string_lossy().into()),
                download_url: None,
                target_version: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(result.source, "local");
        assert_eq!(result.checked_bytes, bytes.len() as u64);
        assert_eq!(result.total_bytes, bytes.len() as u64);
        assert!(result.checked_at > 0);
        assert!(result.sha256_verified);
        assert_eq!(result.range_supported, None);
        assert_eq!(
            serde_json::to_value(&result).unwrap()["sha256Verified"],
            true
        );
        assert_eq!(fs::read(source).unwrap(), bytes);
        assert_readonly(&state, &metadata);
    }

    #[tokio::test]
    async fn local_download_check_rejects_size_or_hash_without_creating_artifacts() {
        for (bytes, expected_error) in [
            (b"bad".as_slice(), "长度"),
            (b"tampered fixture".as_slice(), "SHA256"),
        ] {
            let (_temp, state, source, metadata) = fixture(b"official fixture");
            fs::write(&source, bytes).unwrap();
            let error = test_release_download(
                &state,
                "strata-windows-x64.zip",
                RuntimeZipDownloadOptions {
                    local_archive_path: Some(source.to_string_lossy().into()),
                    download_url: None,
                    target_version: None,
                },
            )
            .await
            .unwrap_err();
            assert!(error.contains(expected_error), "{error}");
            assert_eq!(fs::read(source).unwrap(), bytes);
            assert_readonly(&state, &metadata);
        }
    }

    #[tokio::test]
    async fn readonly_rpc_remains_available_during_runtime_maintenance() {
        let (_temp, state, source, metadata) = fixture(b"official fixture");
        state.runtime_upgrading.store(true, Ordering::Release);
        state.selection_changing.store(true, Ordering::Release);
        let result = state
            .clone()
            .dispatch(
                "test_runtime_zip_download_v1",
                json!({
                    "assetName":"strata-windows-x64.zip", "localArchivePath":source,
                }),
            )
            .await
            .unwrap();
        assert_eq!(result["source"], "local");
        assert_eq!(result["sha256Verified"], true);
        let root = source.parent().unwrap().join("installed");
        fs::create_dir_all(root.join("engine")).unwrap();
        fs::write(
            root.join("engine/BUILD.json"),
            br#"{"backend":"cuda","cuda":13}"#,
        )
        .unwrap();
        let selected = state
            .clone()
            .dispatch("resolve_runtime_zip_asset_v1", json!({"installDir":root}))
            .await
            .unwrap();
        assert_eq!(selected["name"], "strata-windows-x64.zip");
        assert_readonly(&state, &metadata);
        assert!(state.runtime_upgrading.load(Ordering::Acquire));
        assert!(state.selection_changing.load(Ordering::Acquire));
    }

    fn server(
        status: &str,
        headers: &str,
        body: Vec<u8>,
        hold: Duration,
    ) -> (String, Arc<Mutex<String>>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/sample", listener.local_addr().unwrap());
        let request = Arc::new(Mutex::new(String::new()));
        let recorded = request.clone();
        let header = format!("HTTP/1.1 {status}\r\nConnection: close\r\n{headers}\r\n");
        let worker = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            Instant::now() < deadline,
                            "source check request did not arrive"
                        );
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("source check fixture accept: {error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = Vec::new();
            while !bytes.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let mut buffer = [0u8; 1024];
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0 && bytes.len() + count <= 16_384);
                bytes.extend_from_slice(&buffer[..count]);
            }
            *recorded.lock().unwrap() = String::from_utf8(bytes).unwrap().to_ascii_lowercase();
            stream.write_all(header.as_bytes()).unwrap();
            // Dropping a bounded probe can close the socket before all provided
            // fixture bytes are written; it must not force the server to finish.
            let _ = stream.write_all(&body);
            if !hold.is_zero() {
                thread::sleep(hold);
            }
        });
        (url, request, worker)
    }

    #[tokio::test]
    async fn network_download_check_validates_range_and_never_claims_full_sha() {
        let content = vec![b'x'; SAMPLE_BYTES as usize];
        let mut official = asset(&content);
        official.size = 200_000;
        let (url, request, worker) = server(
            "206 Partial Content",
            "Content-Length: 65536\r\nContent-Range: bytes 0-65535/200000\r\n",
            content,
            Duration::ZERO,
        );
        let result = check_network(&url, &official, "mirror", &reqwest::Client::new())
            .await
            .unwrap();
        worker.join().unwrap();
        assert_eq!(result.source, "mirror");
        assert_eq!(result.checked_bytes, SAMPLE_BYTES);
        assert_eq!(result.total_bytes, official.size);
        assert_eq!(result.range_supported, Some(true));
        assert!(!result.sha256_verified);
        assert!(request.lock().unwrap().contains("range: bytes=0-65535\r\n"));
        assert!(request
            .lock()
            .unwrap()
            .contains("accept-encoding: identity\r\n"));
    }

    #[tokio::test]
    async fn network_download_check_stops_after_a_bounded_sample_when_range_is_ignored() {
        let mut official = asset(b"official bytes");
        official.size = 200_000;
        // The server does not finish its declared 200 KB body. The check must
        // still return promptly after 64 KB instead of waiting for its EOF.
        let (url, _, worker) = server(
            "200 OK",
            "Content-Length: 200000\r\n",
            vec![b'x'; SAMPLE_BYTES as usize],
            Duration::from_millis(700),
        );
        let result = tokio::time::timeout(
            Duration::from_millis(400),
            check_network(&url, &official, "official", &reqwest::Client::new()),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result.source, "official");
        assert_eq!(result.checked_bytes, SAMPLE_BYTES);
        assert_eq!(result.range_supported, Some(false));
        assert!(!result.sha256_verified);
        worker.join().unwrap();
    }

    #[tokio::test]
    async fn network_download_check_rejects_wrong_ranges_lengths_and_short_bodies() {
        let official = asset(b"official fixture");
        for (status, headers, body, fragment) in [
            (
                "206 Partial Content",
                "Content-Length: 16\r\n",
                b"official fixture".as_slice(),
                "Content-Range",
            ),
            (
                "206 Partial Content",
                "Content-Length: 16\r\nContent-Range: bytes 1-16/16\r\n",
                b"official fixture".as_slice(),
                "Content-Range",
            ),
            (
                "206 Partial Content",
                "Content-Length: 16\r\nContent-Range: bytes 0-15/17\r\n",
                b"official fixture".as_slice(),
                "Content-Range",
            ),
            (
                "206 Partial Content",
                "Content-Length: 15\r\nContent-Range: bytes 0-15/16\r\n",
                b"official fixtur".as_slice(),
                "Content-Range",
            ),
            (
                "200 OK",
                "Content-Length: 100\r\n",
                b"error page".as_slice(),
                "长度",
            ),
            ("200 OK", "", b"short".as_slice(), "提前结束"),
        ] {
            let (url, _, worker) = server(status, headers, body.to_vec(), Duration::ZERO);
            let error = check_network(&url, &official, "mirror", &reqwest::Client::new())
                .await
                .unwrap_err();
            worker.join().unwrap();
            assert!(error.contains(fragment), "{error}");
        }
    }

    #[tokio::test]
    async fn network_download_check_deadline_includes_an_idle_response_body() {
        let official = asset(b"official fixture");
        let (url, _, worker) = server(
            "200 OK",
            "Content-Length: 16\r\n",
            b"o".to_vec(),
            Duration::from_millis(400),
        );
        let error = check_network_before(
            tokio::time::Instant::now() + Duration::from_millis(150),
            &url,
            &official,
            "mirror",
            &reqwest::Client::new(),
        )
        .await
        .unwrap_err();
        assert!(
            error.contains("超时") || error.contains("超过 20 秒"),
            "{error}"
        );
        worker.join().unwrap();
    }

    #[tokio::test]
    async fn download_check_rejects_unofficial_asset_and_unsafe_mirror() {
        let (_temp, state, _source, metadata) = fixture(b"official fixture");
        assert!(
            test_release_download(&state, "wrong.zip", RuntimeZipDownloadOptions::default())
                .await
                .unwrap_err()
                .contains("所选")
        );
        for url in [
            "http://127.0.0.1/engine.zip",
            "https://user:password@mirror.test/engine.zip",
            "https://mirror.test/a.zip#fragment",
        ] {
            assert!(test_release_download(
                &state,
                "strata-windows-x64.zip",
                RuntimeZipDownloadOptions {
                    local_archive_path: None,
                    download_url: Some(url.into()),
                    target_version: None,
                }
            )
            .await
            .is_err());
        }
        assert_readonly(&state, &metadata);
    }

    #[tokio::test]
    #[ignore = "Read-only live GitHub source check; explicitly run this test to fetch current metadata and at most 64 KiB"]
    async fn live_official_download_source_probe_readonly() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("isolated-live-data")).unwrap();
        let info = crate::runtime_upgrade::update_info_with_cache(Value::Null, true)
            .await
            .unwrap();
        let asset_name = info
            .assets
            .iter()
            .find(|asset| asset.name == "strata-windows-x64.zip")
            .map(|asset| asset.name.clone())
            .unwrap_or_else(|| "strata-windows-x64.zip".into());
        // Metadata is fixture setup in this temporary state, not a download
        // cache. The production check itself must leave it unchanged.
        let metadata = serde_json::to_value(info).unwrap();
        crate::store_set(
            &state,
            crate::runtime_upgrade::UPDATE_INFO_KEY.into(),
            metadata.clone(),
        )
        .unwrap();
        let official_url = metadata["assets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|asset| asset["name"] == asset_name)
            .unwrap()["url"]
            .as_str()
            .unwrap();
        for (name, prefix) in [
            ("official", ""),
            ("gh-proxy", "https://gh-proxy.org/"),
            ("ghproxy", "https://ghproxy.net/"),
        ] {
            let options = RuntimeZipDownloadOptions {
                local_archive_path: None,
                download_url: (!prefix.is_empty()).then(|| format!("{prefix}{official_url}")),
                target_version: None,
            };
            let result = test_release_download(&state, &asset_name, options).await;
            eprintln!(
                "live_download_source_probe {name}={}",
                serde_json::to_string(&result).unwrap()
            );
            let checked = result.expect(
                "Live source probe failed; this is not evidence that isolated tests failed",
            );
            assert!(checked.checked_bytes <= SAMPLE_BYTES);
            assert!(!checked.sha256_verified);
            assert_eq!(checked.range_supported, Some(true));
        }
        assert!(state.tasks.lock().unwrap().is_empty());
        assert!(state.processes.lock().unwrap().is_empty());
        assert_eq!(
            crate::store_get(&state, crate::runtime_upgrade::UPDATE_INFO_KEY.into()).unwrap(),
            metadata
        );
        for name in ["downloads", "runtimes", "zip-updates", "zu"] {
            assert!(!state.data_dir().join(name).exists());
        }
    }
}
