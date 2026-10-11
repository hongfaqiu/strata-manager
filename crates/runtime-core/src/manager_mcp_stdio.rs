//! Stdio MCP client bridge. This mode never opens RuntimeState or starts a backend.
use crate::manager_mcp::{tool_definitions, PROTOCOL_VERSION, SERVER_NAME};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    io::{self, BufRead, Write},
    path::PathBuf,
};

const MAX_INPUT_BYTES: usize = 1024 * 1024;
const SUPPORTED_PROTOCOL_VERSIONS: [&str; 3] = ["2024-11-05", "2025-03-26", PROTOCOL_VERSION];

pub fn run_if_requested() -> Option<Result<i32, String>> {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if args.first().and_then(|arg| arg.to_str()) != Some("--mcp-server") {
        return None;
    }
    Some(parse_arguments(&args[1..]).and_then(|(directory, profile)| run(directory, profile)))
}

fn parse_arguments(args: &[OsString]) -> Result<(PathBuf, String), String> {
    if args.len() != 4 || args[0] != "--data-dir" || args[2] != "--profile-id" {
        return Err(
            "MCP 启动参数必须为 --mcp-server --data-dir <绝对目录> --profile-id <已登记模型>"
                .into(),
        );
    }
    let directory = PathBuf::from(&args[1]);
    let profile = args[3]
        .to_str()
        .ok_or("MCP 模型 ID 必须为 UTF-8")?
        .to_owned();
    if !directory.is_absolute()
        || directory.to_string_lossy().chars().any(char::is_control)
        || directory
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
        || profile.is_empty()
        || profile.len() > 128
        || profile.chars().any(char::is_control)
    {
        return Err("MCP 数据目录必须为绝对路径，且模型 ID 非空".into());
    }
    Ok((directory, profile))
}

fn run(directory: PathBuf, profile: String) -> Result<i32, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    let mut session = Session {
        directory,
        profile,
        initialized: false,
        protocol_version: PROTOCOL_VERSION,
    };
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut input = stdin.lock();
    let mut output = stdout.lock();
    loop {
        let request = match read_line(&mut input) {
            Ok(Some(line)) => match serde_json::from_slice::<Value>(&line) {
                Ok(request) => request,
                Err(_) => {
                    write_response(
                        &mut output,
                        &rpc_error(Value::Null, -32700, "MCP JSON 无效"),
                    )?;
                    continue;
                }
            },
            Ok(None) => break,
            Err(ReadError::Oversize) => {
                write_response(
                    &mut output,
                    &rpc_error(Value::Null, -32700, "MCP 输入超过 1 MiB 限制"),
                )?;
                continue;
            }
            Err(ReadError::Io(error)) => return Err(error.to_string()),
        };
        if let Some(response) = runtime.block_on(session.handle(request)) {
            write_response(&mut output, &response)?;
        }
    }
    Ok(0)
}

enum ReadError {
    Oversize,
    Io(io::Error),
}
/// Drain oversized lines without retaining their payload, then resume framing.
fn read_line(input: &mut impl BufRead) -> Result<Option<Vec<u8>>, ReadError> {
    let mut line = Vec::new();
    let mut oversize = false;
    loop {
        let buffer = input.fill_buf().map_err(ReadError::Io)?;
        if buffer.is_empty() {
            if oversize {
                return Err(ReadError::Oversize);
            }
            return Ok((!line.is_empty()).then_some(line));
        }
        let end = buffer.iter().position(|byte| *byte == b'\n');
        let count = end.map_or(buffer.len(), |end| end + 1);
        if !oversize {
            if line.len() + count > MAX_INPUT_BYTES {
                oversize = true;
                line.clear();
            } else {
                line.extend_from_slice(&buffer[..count]);
            }
        }
        input.consume(count);
        if end.is_some() {
            return if oversize {
                Err(ReadError::Oversize)
            } else {
                Ok(Some(line))
            };
        }
    }
}

fn write_response(output: &mut impl Write, value: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *output, value).map_err(|error| error.to_string())?;
    output
        .write_all(b"\n")
        .and_then(|_| output.flush())
        .map_err(|error| error.to_string())
}
fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
fn rpc_result(id: Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolCall {
    name: String,
    #[serde(default = "empty_object")]
    arguments: Value,
    #[serde(rename = "_meta")]
    _meta: Option<Value>,
}
fn empty_object() -> Value {
    json!({})
}
fn negotiate_protocol(requested: &str) -> &'static str {
    SUPPORTED_PROTOCOL_VERSIONS
        .iter()
        .copied()
        .find(|version| *version == requested)
        .unwrap_or(PROTOCOL_VERSION)
}
fn tool_result(value: Value, protocol: &str) -> Value {
    let mut result = json!({"content":[{"type":"text","text":serde_json::to_string(&value).unwrap_or_default()}],"isError":false});
    if protocol == PROTOCOL_VERSION {
        result["structuredContent"] = value;
    }
    result
}

struct Session {
    directory: PathBuf,
    profile: String,
    initialized: bool,
    protocol_version: &'static str,
}
impl Session {
    async fn connection(&self) -> Result<Value, String> {
        let value = strata_local_ipc::call(
            &self.directory,
            "manager_mcp_connection",
            json!({"profileId":self.profile}),
        )
        .await
        .map_err(|error| format!("请先打开匹配版本的 Strata Manager 后台：{error}"))?;
        if value["serverName"] != SERVER_NAME
            || value["protocolVersion"] != PROTOCOL_VERSION
            || value["profileId"] != self.profile
        {
            return Err("后台 MCP 连接响应与绑定模型或协议不一致".into());
        }
        Ok(value)
    }
    async fn handle(&mut self, request: Value) -> Option<Value> {
        let id = request.get("id").cloned();
        let response_id = id.clone().unwrap_or(Value::Null);
        let valid_id = id
            .as_ref()
            .is_none_or(|id| id.is_null() || id.is_string() || id.is_number());
        if !request.is_object() || request["jsonrpc"] != "2.0" || !valid_id {
            return Some(rpc_error(Value::Null, -32600, "MCP JSON-RPC 请求无效"));
        }
        let Some(method) = request.get("method").and_then(Value::as_str) else {
            return Some(rpc_error(response_id, -32600, "MCP 请求缺少 method"));
        };
        // Notifications cannot trigger model operations. Unknown notifications
        // are ignored according to JSON-RPC and never forwarded to Supervisor.
        id.as_ref()?;
        let params = request.get("params").cloned().unwrap_or_else(empty_object);
        if !params.is_object() {
            return Some(rpc_error(response_id, -32602, "MCP params 必须是对象"));
        }
        let result = match method {
            "initialize" => {
                if self.initialized {
                    return Some(rpc_error(response_id, -32600, "MCP 会话已初始化"));
                }
                let Some(requested_version) = params.get("protocolVersion").and_then(Value::as_str)
                else {
                    return Some(rpc_error(
                        response_id,
                        -32602,
                        "initialize 必须指定 protocolVersion",
                    ));
                };
                match self.connection().await {
                    Ok(_) => {
                        self.initialized = true;
                        self.protocol_version = negotiate_protocol(requested_version);
                        Ok(
                            json!({"protocolVersion":self.protocol_version,"capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":SERVER_NAME,"version":env!("CARGO_PKG_VERSION")},"instructions":"默认仍由 Strata Manager 管理。MCP 仅转发到已有后台；查询不会启动模型。安装先返回计划，用户明确同意后传 confirm=true。"}),
                        )
                    }
                    Err(error) => Err(error),
                }
            }
            "ping" => Ok(json!({})),
            "tools/list" => {
                if !self.initialized {
                    return Some(rpc_error(response_id, -32002, "请先初始化 MCP 会话"));
                }
                if params.get("cursor").is_some() {
                    return Some(rpc_error(response_id, -32602, "工具清单不使用分页 cursor"));
                }
                self.connection()
                    .await
                    .map(|_| json!({"tools":tool_definitions()}))
            }
            "tools/call" => {
                if !self.initialized {
                    return Some(rpc_error(response_id, -32002, "请先初始化 MCP 会话"));
                }
                let call = match serde_json::from_value::<ToolCall>(params) {
                    Ok(call) => call,
                    Err(_) => return Some(rpc_error(response_id, -32602, "tools/call 参数无效")),
                };
                if call.name.len() > 128
                    || !call.arguments.is_object()
                    || !tool_definitions()
                        .iter()
                        .any(|tool| tool["name"] == call.name)
                {
                    return Some(rpc_error(response_id, -32602, "未知 MCP 工具或参数无效"));
                }
                let call_result = strata_local_ipc::call(
                    &self.directory,
                    "manager_mcp_call",
                    json!({"profileId":self.profile,"name":call.name,"arguments":call.arguments}),
                )
                .await;
                let value = match call_result {
                    Ok(value) => tool_result(value, self.protocol_version),
                    Err(error) => {
                        json!({"content":[{"type":"text","text":error.to_string()}],"isError":true})
                    }
                };
                Ok(value)
            }
            _ => return Some(rpc_error(response_id, -32601, "不支持的 MCP 方法")),
        };
        Some(match result {
            Ok(result) => rpc_result(response_id, result),
            Err(error) => rpc_error(response_id, -32000, &error),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_launch_args_only() {
        let absolute = std::env::temp_dir();
        let args = [
            OsString::from("--data-dir"),
            absolute.into_os_string(),
            OsString::from("--profile-id"),
            OsString::from("model"),
        ];
        assert!(parse_arguments(&args).is_ok());
        let mut extra = args.to_vec();
        extra.push(OsString::from("--python"));
        assert!(parse_arguments(&extra).is_err());
        let relative = [
            OsString::from("--data-dir"),
            OsString::from("relative"),
            OsString::from("--profile-id"),
            OsString::from("model"),
        ];
        assert!(parse_arguments(&relative).is_err());
    }
    #[test]
    fn oversized_line_drains_and_next_request_survives() {
        let mut bytes = vec![b'x'; MAX_INPUT_BYTES + 1];
        bytes.extend_from_slice(b"\n{}\n");
        let mut input = io::Cursor::new(bytes);
        assert!(matches!(read_line(&mut input), Err(ReadError::Oversize)));
        assert_eq!(read_line(&mut input).ok().flatten().unwrap(), b"{}\n");
        assert!(read_line(&mut input).ok().flatten().is_none());
    }
    #[tokio::test]
    async fn notifications_cannot_mutate_and_rpc_names_cannot_escape() {
        let mut session = Session {
            directory: std::env::temp_dir(),
            profile: "fixture".into(),
            initialized: true,
            protocol_version: PROTOCOL_VERSION,
        };
        assert!(session
            .handle(json!({"jsonrpc":"2.0","method":"tools/call","params":{"name":"strata_start"}}))
            .await
            .is_none());
        assert_eq!(
            session
                .handle(json!({"jsonrpc":"2.0","id":1,"method":"stop_service","params":{}}))
                .await
                .unwrap()["error"]["code"],
            -32601
        );
        assert_eq!(session.handle(json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write_config","arguments":{}}})).await.unwrap()["error"]["code"],-32602);
        assert_eq!(session.handle(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"strata_start","profileId":"other"}})).await.unwrap()["error"]["code"],-32602);
    }
    #[tokio::test]
    async fn disconnected_session_stays_uninitialized_without_creating_database() {
        let temp = tempfile::tempdir().unwrap();
        let mut session = Session {
            directory: temp.path().to_path_buf(),
            profile: "fixture".into(),
            initialized: false,
            protocol_version: PROTOCOL_VERSION,
        };
        let response=session.handle(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":PROTOCOL_VERSION}})).await.unwrap();
        assert_eq!(response["error"]["code"], -32000);
        assert!(!session.initialized);
        assert!(!temp.path().join("strata-manager.sqlite3").exists());
    }
    #[test]
    fn protocol_versions_negotiate_and_older_results_keep_text() {
        for version in SUPPORTED_PROTOCOL_VERSIONS {
            assert_eq!(negotiate_protocol(version), version);
        }
        assert_eq!(negotiate_protocol("unknown"), PROTOCOL_VERSION);
        let data = json!({"running":false});
        assert!(tool_result(data.clone(), "2024-11-05")
            .get("structuredContent")
            .is_none());
        assert_eq!(
            tool_result(data, PROTOCOL_VERSION)["structuredContent"]["running"],
            false
        );
    }
}
