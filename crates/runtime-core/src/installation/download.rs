//! Hash-addressed downloads survive interrupted requests and application restarts.
use super::{cancelled, file_hash, owned_directory, progress};
use crate::RuntimeState;
use futures_util::StreamExt;
use reqwest::{header, StatusCode};
use std::{
    fs::{self, File, OpenOptions, TryLockError},
    future::Future,
    io::{Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const CANCEL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_ATTEMPTS: usize = 3;

/// A request has separate header and per-chunk deadlines, never a whole-file
/// deadline. The task flag is checked while either network operation is idle.
async fn cancellable_wait<T>(
    state: &RuntimeState,
    id: &str,
    future: impl Future<Output = T>,
    timeout: Duration,
) -> Result<T, String> {
    let deadline = tokio::time::timeout(timeout, future);
    tokio::pin!(deadline);
    loop {
        cancelled(state, id)?;
        tokio::select! {
            result = &mut deadline => {
                cancelled(state, id)?;
                return result.map_err(|_| "网络连续 60 秒未响应".to_owned());
            }
            _ = tokio::time::sleep(CANCEL_INTERVAL) => {}
        }
    }
}

fn regular_file(metadata: &fs::Metadata) -> Result<(), String> {
    #[cfg(windows)]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let reparse = false;
    if metadata.file_type().is_symlink() || reparse || !metadata.is_file() {
        return Err("受管下载文件被替换或重定向，已拒绝写入".into());
    }
    Ok(())
}

fn existing_regular_file(path: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            regular_file(&metadata)?;
            Ok(Some(metadata))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Refuse links both before and after opening. O_NOFOLLOW and
/// FILE_FLAG_OPEN_REPARSE_POINT also close the path-replacement window.
fn managed_file(path: &Path) -> Result<File, String> {
    existing_regular_file(path)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path).map_err(|error| error.to_string())?;
    regular_file(&file.metadata().map_err(|error| error.to_string())?)?;
    Ok(file)
}

async fn download_lock(state: &RuntimeState, id: &str, path: &Path) -> Result<File, String> {
    let file = managed_file(path)?;
    let mut logged = false;
    loop {
        cancelled(state, id)?;
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(TryLockError::WouldBlock) => {
                if !logged {
                    progress(state, id, "相同官方包正在下载，等待其缓存校验完成")?;
                    logged = true;
                }
                tokio::time::sleep(CANCEL_INTERVAL).await;
            }
            Err(TryLockError::Error(error)) => return Err(format!("下载缓存加锁失败: {error}")),
        }
    }
}

fn checked_length(value: Option<u64>, limit: u64) -> Result<Option<u64>, String> {
    if value.is_some_and(|value| value > limit) {
        return Err("下载超过安全体积上限，已拒绝安装".into());
    }
    Ok(value)
}

/// Only a single, bounded byte range covering the requested remainder is valid.
fn resumed_total(response: &reqwest::Response, offset: u64, limit: u64) -> Result<u64, String> {
    let invalid = || "官方来源返回了无效的 Content-Range，已拒绝安装".to_owned();
    let value = response
        .headers()
        .get(header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("bytes "))
        .ok_or_else(invalid)?;
    let (range, total) = value.split_once('/').ok_or_else(invalid)?;
    let (start, end) = range.split_once('-').ok_or_else(invalid)?;
    let start: u64 = start.parse().map_err(|_| invalid())?;
    let end: u64 = end.parse().map_err(|_| invalid())?;
    let total: u64 = total.parse().map_err(|_| invalid())?;
    checked_length(Some(total), limit)?;
    if start != offset
        || start > end
        || end.checked_add(1) != Some(total)
        || response.content_length().is_some_and(|length| {
            Some(length) != end.checked_sub(start).and_then(|n| n.checked_add(1))
        })
    {
        return Err(invalid());
    }
    Ok(total)
}

fn amount(received: u64, total: Option<u64>) -> String {
    match total {
        Some(total) => format!("{received} / {total} 字节"),
        None => format!("{received} 字节 / 总量未知"),
    }
}

async fn retry(
    state: &RuntimeState,
    id: &str,
    attempt: usize,
    received: u64,
    reason: &str,
) -> Result<(), String> {
    cancelled(state, id)?;
    if attempt == MAX_ATTEMPTS {
        return Err(format!(
            "官方下载已尝试 {MAX_ATTEMPTS} 次，{reason}；已保存 {received} 字节，可重试续传"
        ));
    }
    progress(
        state,
        id,
        format!(
            "下载重试 {}/{}：{reason}；已保存 {received} 字节",
            attempt + 1,
            MAX_ATTEMPTS
        ),
    )?;
    cancellable_wait(
        state,
        id,
        tokio::time::sleep(Duration::from_millis(250 * attempt as u64)),
        IDLE_TIMEOUT,
    )
    .await
}

fn publish(partial: &Path, cache: &Path) -> Result<(), String> {
    // hard_link is no-clobber on both Windows and Unix. The lock prevents other
    // application instances from using or deleting the partial while publishing.
    fs::hard_link(partial, cache).map_err(|error| format!("保存已校验缓存失败: {error}"))?;
    fs::remove_file(partial).map_err(|error| format!("清理已完成的续传文件失败: {error}"))
}

pub(super) async fn download_with_client(
    state: &RuntimeState,
    id: &str,
    url: &str,
    expected: &str,
    limit: u64,
    client: &reqwest::Client,
) -> Result<PathBuf, String> {
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) || limit == 0
    {
        return Err("官方下载 SHA256 或安全体积上限无效".into());
    }
    let expected = expected.to_ascii_lowercase();
    cancelled(state, id)?;
    let directory = owned_directory(state.data_dir(), &["downloads"])?;
    let _lock = download_lock(state, id, &directory.join(format!("{expected}.lock"))).await?;
    let canonical = directory.join(format!("{expected}.download"));
    let alternate = directory.join(format!("{expected}-verified.download"));
    let mut cache = canonical.clone();
    for candidate in [&canonical, &alternate] {
        if let Some(metadata) = existing_regular_file(candidate)? {
            if metadata.len() <= limit && file_hash(candidate)? == expected {
                progress(state, id, "已复用经过 SHA256 校验的下载缓存")?;
                return Ok(candidate.clone());
            }
            progress(state, id, "已有下载缓存校验不符，保留原文件并重新下载")?;
            cache = if candidate == &canonical {
                alternate.clone()
            } else {
                directory.join(format!("{expected}-{}.download", uuid::Uuid::new_v4()))
            };
        }
    }
    let partial = directory.join(format!("{expected}.part"));
    if existing_regular_file(&partial)?.is_some_and(|metadata| metadata.len() > limit) {
        return Err("已有续传文件超过安全体积上限，已拒绝安装".into());
    }
    let mut output = managed_file(&partial)?;
    let mut received = output.metadata().map_err(|error| error.to_string())?.len();
    output
        .seek(SeekFrom::End(0))
        .map_err(|error| error.to_string())?;
    for attempt in 1..=MAX_ATTEMPTS {
        cancelled(state, id)?;
        progress(
            state,
            id,
            if received == 0 {
                format!("正在从官方来源下载: {url}")
            } else {
                format!("断点续传，已下载 {received} 字节: {url}")
            },
        )?;
        let mut request = client.get(url).header(header::ACCEPT_ENCODING, "identity");
        if received > 0 {
            request = request.header(header::RANGE, format!("bytes={received}-"));
        }
        let response = match cancellable_wait(state, id, request.send(), IDLE_TIMEOUT).await {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                retry(state, id, attempt, received, &format!("请求失败: {error}")).await?;
                continue;
            }
            Err(error) => {
                retry(state, id, attempt, received, &error).await?;
                continue;
            }
        };
        let status = response.status();
        if status == StatusCode::REQUEST_TIMEOUT
            || status == StatusCode::TOO_MANY_REQUESTS
            || status.is_server_error()
        {
            retry(
                state,
                id,
                attempt,
                received,
                &format!("来源返回 HTTP {status}"),
            )
            .await?;
            continue;
        }
        if status == StatusCode::RANGE_NOT_SATISFIABLE && received > 0 {
            if file_hash(&partial)? == expected {
                output.sync_all().map_err(|error| error.to_string())?;
                drop(output);
                cancelled(state, id)?;
                publish(&partial, &cache)?;
                progress(state, id, format!("SHA256 校验通过，共 {received} 字节"))?;
                return Ok(cache);
            }
            output.set_len(0).map_err(|error| error.to_string())?;
            output
                .seek(SeekFrom::Start(0))
                .map_err(|error| error.to_string())?;
            received = 0;
            retry(
                state,
                id,
                attempt,
                received,
                "来源不接受续传且已有文件未完整，重新下载",
            )
            .await?;
            continue;
        }
        let total = if status == StatusCode::PARTIAL_CONTENT {
            Some(resumed_total(&response, received, limit)?)
        } else if status == StatusCode::OK {
            let total = checked_length(response.content_length(), limit)?;
            if received > 0 {
                progress(state, id, "官方来源未支持断点续传，重新下载完整文件")?;
                output.set_len(0).map_err(|error| error.to_string())?;
                output
                    .seek(SeekFrom::Start(0))
                    .map_err(|error| error.to_string())?;
                received = 0;
            }
            total
        } else {
            return Err(format!("官方下载返回 HTTP {status}，请检查来源后重试"));
        };
        progress(state, id, format!("下载进度：{}", amount(received, total)))?;
        let mut last_log = Instant::now();
        let mut stream = response.bytes_stream();
        let interruption = loop {
            let next = match cancellable_wait(state, id, stream.next(), IDLE_TIMEOUT).await {
                Ok(next) => next,
                Err(error) => break Some(error),
            };
            match next {
                None => break None,
                Some(Err(error)) => break Some(format!("下载中断: {error}")),
                Some(Ok(bytes)) => {
                    let next_size = received
                        .checked_add(bytes.len() as u64)
                        .ok_or("下载大小无效")?;
                    if next_size > limit || total.is_some_and(|total| next_size > total) {
                        drop(output);
                        fs::remove_file(&partial).map_err(|error| error.to_string())?;
                        return Err("下载超过安全体积上限或声明长度，已拒绝安装".into());
                    }
                    output
                        .write_all(&bytes)
                        .map_err(|error| format!("磁盘写入失败: {error}"))?;
                    received = next_size;
                    if last_log.elapsed() >= Duration::from_secs(1) {
                        progress(state, id, format!("下载进度：{}", amount(received, total)))?;
                        last_log = Instant::now();
                    }
                }
            }
        };
        output.sync_all().map_err(|error| error.to_string())?;
        if let Some(reason) = interruption {
            retry(state, id, attempt, received, &reason).await?;
            continue;
        }
        if total.is_some_and(|total| total != received) {
            retry(state, id, attempt, received, "下载长度未达到来源声明总量").await?;
            continue;
        }
        cancelled(state, id)?;
        if file_hash(&partial)? != expected {
            drop(output);
            fs::remove_file(&partial).map_err(|error| error.to_string())?;
            return Err("官方下载内容的 SHA256 不符，已删除续传文件并拒绝解包或执行".into());
        }
        drop(output);
        cancelled(state, id)?;
        publish(&partial, &cache)?;
        progress(state, id, format!("SHA256 校验通过，共 {received} 字节"))?;
        return Ok(cache);
    }
    unreachable!("the final failed attempt returns its error")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        processes::TaskRecord,
        types::{now, TaskStatus},
    };
    use sha2::{Digest, Sha256};
    use std::{
        io::Read,
        net::TcpListener,
        sync::{Arc, Mutex},
        thread,
    };

    struct Reply {
        bytes: Vec<u8>,
        keep_open: Duration,
    }

    fn reply(status: &str, headers: &str, body: &[u8]) -> Reply {
        let mut bytes =
            format!("HTTP/1.1 {status}\r\nConnection: close\r\n{headers}\r\n").into_bytes();
        bytes.extend_from_slice(body);
        Reply {
            bytes,
            keep_open: Duration::ZERO,
        }
    }

    fn server(replies: Vec<Reply>) -> (String, Arc<Mutex<Vec<String>>>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/fixture", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let worker = thread::spawn(move || {
            for reply in replies {
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                Instant::now() < deadline,
                                "expected fixture request did not arrive"
                            );
                            thread::sleep(Duration::from_millis(10));
                        }
                        Err(error) => panic!("fixture accept failed: {error}"),
                    }
                };
                // Windows accepted sockets can inherit the listener's
                // nonblocking mode. A request need not arrive with accept().
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 1024];
                while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    let count = stream.read(&mut buffer).unwrap();
                    assert!(count > 0 && request.len() + count <= 16_384);
                    request.extend_from_slice(&buffer[..count]);
                }
                recorded
                    .lock()
                    .unwrap()
                    .push(String::from_utf8(request).unwrap().to_ascii_lowercase());
                stream.write_all(&reply.bytes).unwrap();
                if !reply.keep_open.is_zero() {
                    thread::sleep(reply.keep_open);
                }
            }
        });
        (url, requests, worker)
    }

    fn task(state: &RuntimeState) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        state.tasks.lock().unwrap().insert(
            id.clone(),
            TaskRecord {
                status: TaskStatus {
                    id: id.clone(),
                    kind: "install-runtime".into(),
                    state: "running".into(),
                    message: "fixture".into(),
                    started_at: now(),
                    finished_at: None,
                },
                profile_id: None,
                runtime_path: None,
                cancelled: false,
                process: None,
            },
        );
        id
    }

    fn hash(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    #[tokio::test]
    async fn complete_download_and_verified_cache_need_only_one_request() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let id = task(&state);
        let content = b"official complete download";
        let expected = hash(content);
        let (url, requests, worker) = server(vec![reply(
            "200 OK",
            &format!("Content-Length: {}\r\n", content.len()),
            content,
        )]);
        let path = download_with_client(&state, &id, &url, &expected, 1024, &state.client)
            .await
            .unwrap();
        worker.join().unwrap();
        assert_eq!(fs::read(&path).unwrap(), content);
        // The listening socket has been dropped, so cache reuse cannot make HTTP.
        assert_eq!(
            download_with_client(&state, &id, &url, &expected, 1024, &state.client)
                .await
                .unwrap(),
            path
        );
        assert_eq!(requests.lock().unwrap().len(), 1);
        assert!(!path.with_extension("part").exists());
    }

    #[tokio::test]
    async fn disconnected_body_resumes_at_the_persisted_offset() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let id = task(&state);
        let content = b"official resumable fixture";
        let expected = hash(content);
        let offset = 8;
        let (url, requests, worker) = server(vec![
            reply(
                "200 OK",
                &format!("Content-Length: {}\r\n", content.len()),
                &content[..offset],
            ),
            reply(
                "206 Partial Content",
                &format!(
                    "Content-Length: {}\r\nContent-Range: bytes {offset}-{}/{}\r\n",
                    content.len() - offset,
                    content.len() - 1,
                    content.len()
                ),
                &content[offset..],
            ),
        ]);
        let path = download_with_client(&state, &id, &url, &expected, 1024, &state.client)
            .await
            .unwrap();
        worker.join().unwrap();
        assert_eq!(fs::read(path).unwrap(), content);
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(!requests[0].contains("range:"));
        assert!(requests[1].contains("range: bytes=8-\r\n"));
    }

    #[tokio::test]
    async fn a_source_ignoring_range_restarts_without_concatenating_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let id = task(&state);
        let content = b"server sends the complete official file";
        let expected = hash(content);
        let directory = owned_directory(state.data_dir(), &["downloads"]).unwrap();
        fs::write(directory.join(format!("{expected}.part")), b"old partial").unwrap();
        let (url, requests, worker) = server(vec![reply(
            "200 OK",
            &format!("Content-Length: {}\r\n", content.len()),
            content,
        )]);
        let path = download_with_client(&state, &id, &url, &expected, 1024, &state.client)
            .await
            .unwrap();
        worker.join().unwrap();
        assert!(requests.lock().unwrap()[0].contains("range: bytes=11-\r\n"));
        assert_eq!(fs::read(path).unwrap(), content);
    }

    #[tokio::test]
    async fn invalid_ranges_and_oversize_responses_never_publish() {
        for (status, headers, body, error_fragment) in [
            (
                "206 Partial Content",
                "Content-Length: 2\r\nContent-Range: bytes 0-1/2\r\n",
                b"ok".as_slice(),
                "Content-Range",
            ),
            (
                "206 Partial Content",
                "Content-Length: 2\r\nContent-Range: bytes 3-9/10\r\n",
                b"ok".as_slice(),
                "Content-Range",
            ),
            (
                "206 Partial Content",
                "Content-Length: 2\r\nContent-Range: bytes 3-4/9999\r\n",
                b"ok".as_slice(),
                "上限",
            ),
            (
                "200 OK",
                "Content-Length: 9999\r\n",
                b"ok".as_slice(),
                "上限",
            ),
            (
                "200 OK",
                "",
                b"oversize response body with no declared length".as_slice(),
                "上限",
            ),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let state = RuntimeState::open(temp.path().join("data")).unwrap();
            let id = task(&state);
            let expected = hash(b"different trusted official data");
            let directory = owned_directory(state.data_dir(), &["downloads"]).unwrap();
            fs::write(directory.join(format!("{expected}.part")), b"abc").unwrap();
            let (url, _, worker) = server(vec![reply(status, headers, body)]);
            let error = download_with_client(&state, &id, &url, &expected, 32, &state.client)
                .await
                .unwrap_err();
            worker.join().unwrap();
            assert!(error.contains(error_fragment), "{error}");
            assert!(!directory.join(format!("{expected}.download")).exists());
        }
    }

    #[tokio::test]
    async fn mismatched_sha_removes_partial_and_preserves_old_corrupt_cache() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let id = task(&state);
        let expected = hash(b"official bytes");
        let directory = owned_directory(state.data_dir(), &["downloads"]).unwrap();
        let old = directory.join(format!("{expected}.download"));
        fs::write(&old, b"preserve existing bytes").unwrap();
        let (url, _, worker) = server(vec![reply("200 OK", "Content-Length: 8\r\n", b"tampered")]);
        assert!(
            download_with_client(&state, &id, &url, &expected, 1024, &state.client)
                .await
                .unwrap_err()
                .contains("SHA256")
        );
        worker.join().unwrap();
        assert_eq!(fs::read(old).unwrap(), b"preserve existing bytes");
        assert!(!directory.join(format!("{expected}.part")).exists());
        assert!(!directory
            .join(format!("{expected}-verified.download"))
            .exists());
    }

    #[tokio::test]
    async fn transient_statuses_retry_up_to_three_requests() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let id = task(&state);
        let content = b"successful retry";
        let expected = hash(content);
        let (url, requests, worker) = server(vec![
            reply("503 Service Unavailable", "Content-Length: 0\r\n", b""),
            reply("429 Too Many Requests", "Content-Length: 0\r\n", b""),
            reply(
                "200 OK",
                &format!("Content-Length: {}\r\n", content.len()),
                content,
            ),
        ]);
        let path = download_with_client(&state, &id, &url, &expected, 1024, &state.client)
            .await
            .unwrap();
        worker.join().unwrap();
        assert_eq!(requests.lock().unwrap().len(), 3);
        assert_eq!(fs::read(path).unwrap(), content);

        let id = task(&state);
        let (url, requests, worker) = server(
            (0..3)
                .map(|_| reply("503 Service Unavailable", "Content-Length: 0\r\n", b""))
                .collect(),
        );
        assert!(download_with_client(
            &state,
            &id,
            &url,
            &hash(b"other download"),
            1024,
            &state.client
        )
        .await
        .unwrap_err()
        .contains("已尝试 3 次"));
        worker.join().unwrap();
        assert_eq!(requests.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn cancellation_during_idle_body_keeps_partial_for_a_future_attempt() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let id = task(&state);
        let expected = hash(b"a larger complete fixture");
        let directory = owned_directory(state.data_dir(), &["downloads"]).unwrap();
        let partial = directory.join(format!("{expected}.part"));
        let mut response = reply("200 OK", "Content-Length: 10000\r\n", b"partial");
        response.keep_open = Duration::from_millis(800);
        let (url, _, worker) = server(vec![response]);
        let download_state = state.clone();
        let download_id = id.clone();
        let download_expected = expected.clone();
        let download = tokio::spawn(async move {
            download_with_client(
                &download_state,
                &download_id,
                &url,
                &download_expected,
                20_000,
                &download_state.client,
            )
            .await
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while fs::metadata(&partial).map_or(true, |metadata| metadata.len() != 7) {
            assert!(Instant::now() < deadline, "partial was not written");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        state.tasks.lock().unwrap().get_mut(&id).unwrap().cancelled = true;
        let error = tokio::time::timeout(Duration::from_millis(300), download)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(error.contains("取消"));
        assert_eq!(fs::read(partial).unwrap(), b"partial");
        assert!(!directory.join(format!("{expected}.download")).exists());
        worker.join().unwrap();
    }

    #[tokio::test]
    async fn unsatisfied_range_hashes_the_partial_before_publishing_or_restarting() {
        for complete in [true, false] {
            let temp = tempfile::tempdir().unwrap();
            let state = RuntimeState::open(temp.path().join("data")).unwrap();
            let id = task(&state);
            let content = b"complete after a lost final response";
            let expected = hash(content);
            let directory = owned_directory(state.data_dir(), &["downloads"]).unwrap();
            fs::write(
                directory.join(format!("{expected}.part")),
                if complete {
                    content.as_slice()
                } else {
                    b"partial"
                },
            )
            .unwrap();
            let mut replies = vec![reply(
                "416 Range Not Satisfiable",
                "Content-Length: 0\r\n",
                b"",
            )];
            if !complete {
                replies.push(reply(
                    "200 OK",
                    &format!("Content-Length: {}\r\n", content.len()),
                    content,
                ));
            }
            let (url, requests, worker) = server(replies);
            let path = download_with_client(&state, &id, &url, &expected, 1024, &state.client)
                .await
                .unwrap();
            worker.join().unwrap();
            assert_eq!(fs::read(path).unwrap(), content);
            assert_eq!(requests.lock().unwrap().len(), if complete { 1 } else { 2 });
            if !complete {
                assert!(!requests.lock().unwrap()[1].contains("range:"));
            }
        }
    }

    #[tokio::test]
    async fn invalid_hash_never_becomes_a_cache_path() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let id = task(&state);
        for expected in ["../outside", &"a/".repeat(32), &"z".repeat(64)] {
            assert!(download_with_client(
                &state,
                &id,
                "http://127.0.0.1:1",
                expected,
                1024,
                &state.client
            )
            .await
            .unwrap_err()
            .contains("SHA256"));
        }
        assert!(!state.data_dir().join("downloads").exists());
    }

    #[tokio::test]
    async fn concurrent_same_hash_downloads_share_one_verified_cache() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let first_id = task(&state);
        let second_id = task(&state);
        let content = b"one official artifact for both callers";
        let expected = hash(content);
        let (url, requests, worker) = server(vec![reply(
            "200 OK",
            &format!("Content-Length: {}\r\n", content.len()),
            content,
        )]);
        let (first, second) = tokio::join!(
            download_with_client(&state, &first_id, &url, &expected, 1024, &state.client),
            download_with_client(&state, &second_id, &url, &expected, 1024, &state.client),
        );
        worker.join().unwrap();
        assert_eq!(first.unwrap(), second.unwrap());
        assert_eq!(requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn cancellation_also_interrupts_waiting_for_response_headers() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let id = task(&state);
        let expected = hash(b"headers never arrive");
        let (url, requests, worker) = server(vec![Reply {
            bytes: Vec::new(),
            keep_open: Duration::from_millis(800),
        }]);
        let download_state = state.clone();
        let download_id = id.clone();
        let download = tokio::spawn(async move {
            download_with_client(
                &download_state,
                &download_id,
                &url,
                &expected,
                1024,
                &download_state.client,
            )
            .await
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while requests.lock().unwrap().is_empty() {
            assert!(Instant::now() < deadline, "request did not arrive");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        state.tasks.lock().unwrap().get_mut(&id).unwrap().cancelled = true;
        let error = tokio::time::timeout(Duration::from_millis(300), download)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(error.contains("取消"));
        worker.join().unwrap();
    }

    #[tokio::test]
    async fn download_idle_deadline_does_not_reset_on_cancel_poll_ticks() {
        let temp = tempfile::tempdir().unwrap();
        let state = RuntimeState::open(temp.path().join("data")).unwrap();
        let id = task(&state);
        // A short deadline exercises the production wait loop without a
        // 60-second test. At least two cancellation ticks occur before expiry.
        let error = tokio::time::timeout(
            Duration::from_secs(1),
            cancellable_wait(
                &state,
                &id,
                std::future::pending::<()>(),
                Duration::from_millis(250),
            ),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert!(error.contains("未响应"));
    }
}
