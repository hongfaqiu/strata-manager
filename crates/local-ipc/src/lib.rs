use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(windows)]
use sha2::{Digest, Sha256};
use std::{fmt, future::Future, path::Path, sync::Arc, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

pub const PROTOCOL_VERSION: u32 = 1;
// Two large official image attachments must continue to fit. The bound also
// prevents a length header from allocating unbounded memory before JSON parsing.
pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(420);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    pub code: String,
    pub message: String,
    pub retriable: bool,
}
impl RpcError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retriable: false,
        }
    }
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self {
            code: "supervisor_unavailable".into(),
            message: message.into(),
            retriable: true,
        }
    }
}
impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for RpcError {}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub protocol_version: u32,
    pub id: String,
    pub method: String,
    pub params: Value,
}
impl Request {
    pub fn new(method: impl Into<String>, params: Value) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            id: uuid::Uuid::new_v4().to_string(),
            method: method.into(),
            params,
        }
    }
    pub fn validate(&self) -> Result<(), RpcError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(RpcError::new(
                "protocol_mismatch",
                format!(
                    "后台协议 {}，客户端协议 {}；请更新匹配版本",
                    PROTOCOL_VERSION, self.protocol_version
                ),
            ));
        }
        if self.id.is_empty()
            || self.id.len() > 128
            || self.method.is_empty()
            || self.method.len() > 128
            || !self.params.is_object()
        {
            return Err(RpcError::new(
                "invalid_request",
                "RPC 请求标识、方法或参数无效",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub protocol_version: u32,
    pub id: String,
    pub result: Option<Value>,
    pub error: Option<RpcError>,
}
impl Response {
    pub fn from_result(id: String, result: Result<Value, RpcError>) -> Self {
        match result {
            Ok(value) => Self {
                protocol_version: PROTOCOL_VERSION,
                id,
                result: Some(value),
                error: None,
            },
            Err(error) => Self {
                protocol_version: PROTOCOL_VERSION,
                id,
                result: None,
                error: Some(error),
            },
        }
    }
    pub fn into_result(self, id: &str) -> Result<Value, RpcError> {
        if self.protocol_version != PROTOCOL_VERSION || self.id != id {
            return Err(RpcError::new(
                "protocol_mismatch",
                "后台响应版本或关联标识不一致",
            ));
        }
        match (self.result, self.error) {
            (_, Some(error)) => Err(error),
            (Some(value), None) => Ok(value),
            (None, None) => Ok(Value::Null),
        }
    }
}

pub async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Vec<u8>, RpcError> {
    let len = reader
        .read_u32_le()
        .await
        .map_err(|e| RpcError::unavailable(format!("读取后台消息失败: {e}")))?
        as usize;
    if len == 0 || len > MAX_FRAME_BYTES {
        return Err(RpcError::new("frame_size", "后台消息超出 64 MiB 限制"));
    }
    let mut bytes = vec![0; len];
    reader
        .read_exact(&mut bytes)
        .await
        .map_err(|e| RpcError::unavailable(format!("后台消息不完整: {e}")))?;
    Ok(bytes)
}
pub async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    bytes: &[u8],
) -> Result<(), RpcError> {
    if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES {
        return Err(RpcError::new("frame_size", "后台消息超出 64 MiB 限制"));
    }
    writer
        .write_u32_le(bytes.len() as u32)
        .await
        .map_err(|e| RpcError::unavailable(e.to_string()))?;
    writer
        .write_all(bytes)
        .await
        .map_err(|e| RpcError::unavailable(e.to_string()))?;
    writer
        .flush()
        .await
        .map_err(|e| RpcError::unavailable(e.to_string()))
}

fn validate_lock_scope(scope: &str) -> Result<(), RpcError> {
    if scope.is_empty() || scope.len() > 64 || !scope.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-') {
        return Err(RpcError::new("instance_lock", "锁作用域必须为小写字母、数字或连字符"));
    }
    Ok(())
}

#[cfg(windows)]
fn endpoint_key(data_dir: &Path) -> Result<String, RpcError> {
    let canonical = dunce::canonicalize(data_dir)
        .map_err(|e| RpcError::new("data_directory", e.to_string()))?;
    let user = current_identity()?;
    let path = canonical.to_string_lossy();
    #[cfg(windows)]
    let path = path.to_lowercase();
    let digest = Sha256::digest(format!("{user}\n{path}").as_bytes());
    Ok(format!("{:x}", digest)[..32].to_owned())
}

#[cfg(windows)]
mod platform;
#[cfg(windows)]
pub use platform::{current_identity, SingleInstance};

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::{current_identity, SingleInstance};

#[cfg(windows)]
pub fn pipe_name(data_dir: &Path) -> Result<String, RpcError> {
    Ok(format!(
        r"\\.\pipe\strata-supervisor-{}",
        endpoint_key(data_dir)?
    ))
}

#[cfg(unix)]
fn socket_path(data_dir: &Path) -> Result<std::path::PathBuf, RpcError> {
    Ok(unix::ipc_directory(data_dir)?.join("supervisor.sock"))
}

pub async fn call(data_dir: &Path, method: &str, params: Value) -> Result<Value, RpcError> {
    let request = Request::new(method, params);
    request.validate()?;
    let operation = async {
        #[cfg(windows)]
        let mut connection = {
            use tokio::net::windows::named_pipe::ClientOptions;
            let pipe = pipe_name(data_dir)?;
            let start = std::time::Instant::now();
            loop {
                match ClientOptions::new().open(&pipe) {
                    Ok(client) => break client,
                    Err(error)
                        if error.raw_os_error() == Some(231)
                            && start.elapsed() < Duration::from_secs(3) =>
                    {
                        tokio::time::sleep(Duration::from_millis(25)).await
                    }
                    Err(error) => {
                        return Err(RpcError::unavailable(format!("连接本机后台失败: {error}")))
                    }
                }
            }
        };
        #[cfg(unix)]
        let mut connection = tokio::net::UnixStream::connect(socket_path(data_dir)?)
            .await
            .map_err(|e| RpcError::unavailable(e.to_string()))?;
        let bytes = serde_json::to_vec(&request)
            .map_err(|e| RpcError::new("serialization", e.to_string()))?;
        write_frame(&mut connection, &bytes).await?;
        let bytes = read_frame(&mut connection).await?;
        let response: Response = serde_json::from_slice(&bytes)
            .map_err(|e| RpcError::new("invalid_response", e.to_string()))?;
        response.into_result(&request.id)
    };
    tokio::time::timeout(REQUEST_TIMEOUT, operation)
        .await
        .map_err(|_| {
            RpcError::new(
                "request_timeout",
                "后台操作超时，任务可能仍在进行；请查询状态",
            )
        })?
}

async fn serve_connection<S, F, Fut>(mut connection: S, handler: Arc<F>)
where
    S: AsyncRead + AsyncWrite + Unpin,
    F: Fn(Request) -> Fut,
    Fut: Future<Output = Result<Value, RpcError>>,
{
    let read = tokio::time::timeout(Duration::from_secs(15), read_frame(&mut connection)).await;
    let Ok(Ok(bytes)) = read else { return };
    let request: Request = match serde_json::from_slice(&bytes) {
        Ok(request) => request,
        Err(_) => return,
    };
    let id = request.id.clone();
    let result = match request.validate() {
        Ok(()) => handler(request).await,
        Err(error) => Err(error),
    };
    let response = Response::from_result(id, result);
    if let Ok(bytes) = serde_json::to_vec(&response) {
        let _ = tokio::time::timeout(
            Duration::from_secs(30),
            write_frame(&mut connection, &bytes),
        )
        .await;
    }
}

pub async fn serve<F, Fut>(
    data_dir: &Path,
    shutdown: CancellationToken,
    handler: F,
) -> Result<(), RpcError>
where
    F: Fn(Request) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Value, RpcError>> + Send + 'static,
{
    let handler = Arc::new(handler);
    let permits = Arc::new(tokio::sync::Semaphore::new(8));
    #[cfg(windows)]
    {
        let pipe = pipe_name(data_dir)?;
        let security = platform::UserSecurity::new()?;
        let mut listener = security.create_pipe(&pipe, true)?;
        loop {
            tokio::select! { _ = shutdown.cancelled() => break, connected = listener.connect() => connected.map_err(|e| RpcError::unavailable(e.to_string()))? }
            let connected = listener;
            listener = security.create_pipe(&pipe, false)?;
            let permit = match permits.clone().try_acquire_owned() {
                Ok(permit) => permit,
                Err(_) => {
                    drop(connected);
                    continue;
                }
            };
            let handler = handler.clone();
            tokio::spawn(async move {
                let _permit = permit;
                serve_connection(connected, handler).await;
            });
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = socket_path(data_dir)?;
        let listener = tokio::net::UnixListener::bind(&path)
            .map_err(|e| RpcError::unavailable(e.to_string()))?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| RpcError::new("socket_permissions", e.to_string()))?;
        loop {
            let (connected, _) = tokio::select! { _ = shutdown.cancelled() => break, next = listener.accept() => next.map_err(|e| RpcError::unavailable(e.to_string()))? };
            if connected
                .peer_cred()
                .map_err(|e| RpcError::new("peer_identity", e.to_string()))?
                .uid()
                != unsafe { libc::geteuid() }
            {
                drop(connected);
                continue;
            }
            let permit = match permits.clone().try_acquire_owned() {
                Ok(permit) => permit,
                Err(_) => {
                    drop(connected);
                    continue;
                }
            };
            let handler = handler.clone();
            tokio::spawn(async move {
                let _permit = permit;
                serve_connection(connected, handler).await;
            });
        }
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn truncated_and_oversized_frames_do_not_allocate_or_decode() {
        let (mut writer, mut reader) = tokio::io::duplex(32);
        writer.write_u32_le(u32::MAX).await.unwrap();
        assert_eq!(
            read_frame(&mut reader).await.unwrap_err().code,
            "frame_size"
        );
        drop(writer);
        assert!(read_frame(&mut reader).await.is_err());
    }
    #[test]
    fn protocol_and_correlated_response_are_checked() {
        let mut request = Request::new("supervisor_status", serde_json::json!({}));
        request.protocol_version += 1;
        assert_eq!(request.validate().unwrap_err().code, "protocol_mismatch");
        assert!(Response::from_result("wrong".into(), Ok(Value::Null))
            .into_result("expected")
            .is_err());
    }
    #[cfg(any(windows, unix))]
    #[tokio::test]
    async fn named_pipe_roundtrip_is_user_scoped_and_other_state_dir_isolated() {
        let first = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let shutdown = CancellationToken::new();
        let token = shutdown.clone();
        let path = first.path().to_owned();
        let task =
            tokio::spawn(async move { serve(&path, token, |r| async move { Ok(r.params) }).await });
        let mut value = None;
        for _ in 0..40 {
            match call(first.path(), "echo", serde_json::json!({"中文": "后台"})).await {
                Ok(result) => {
                    value = Some(result);
                    break;
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(25)).await,
            }
        }
        assert_eq!(value.unwrap()["中文"], "后台");
        assert!(call(other.path(), "echo", serde_json::json!({}))
            .await
            .is_err());
        shutdown.cancel();
        task.await.unwrap().unwrap();
    }
    #[test]
    fn single_instance_lock_is_released_only_when_its_owner_drops() {
        let data = tempfile::tempdir().unwrap();
        let owner = SingleInstance::acquire(data.path()).unwrap();
        assert!(
            matches!(SingleInstance::acquire(data.path()),Err(error) if error.code=="already_running")
        );
        drop(owner);
        assert!(SingleInstance::acquire(data.path()).is_ok());
    }

    #[test]
    fn scoped_operation_lock_does_not_occupy_supervisor_or_remove_its_socket() {
        let data = tempfile::tempdir().unwrap();
        let supervisor = SingleInstance::acquire(data.path()).unwrap();
        #[cfg(unix)]
        std::fs::write(socket_path(data.path()).unwrap(), "live supervisor sentinel").unwrap();
        let update = SingleInstance::acquire_scoped(data.path(), "runtime-update-queue").unwrap();
        assert!(matches!(SingleInstance::acquire_scoped(data.path(), "runtime-update-queue"), Err(error) if error.code == "already_running"));
        assert!(matches!(SingleInstance::acquire(data.path()), Err(error) if error.code == "already_running"));
        #[cfg(unix)]
        assert_eq!(std::fs::read_to_string(socket_path(data.path()).unwrap()).unwrap(), "live supervisor sentinel");
        for invalid in ["", "../supervisor", "RUNTIME", "update/lock"] {
            assert!(SingleInstance::acquire_scoped(data.path(), invalid).is_err());
        }
        drop(update);
        assert!(SingleInstance::acquire_scoped(data.path(), "runtime-update-queue").is_ok());
        drop(supervisor);
    }
}
