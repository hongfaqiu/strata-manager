//! Waiting for a cold model load during startup.
//!
//! Upstream `POST /load` blocks until the weights are resident. A large model
//! (or a multi-GPU split on older PCIe) can take longer than the HTTP request
//! timeout while the engine keeps printing "still starting (N s)". A client
//! timeout there is not a failed load: the engine is still working. We keep
//! waiting on `/health` while the process is alive and only fail on a real
//! exit, an upstream rejection, or a generous ceiling.
use serde_json::Value;
use std::future::Future;
use std::time::{Duration, Instant};

use crate::diagnostics;

#[derive(Clone, Copy, Debug)]
pub(crate) struct LoadWait {
    /// Ceiling for the whole load, measured from the `/load` request.
    pub ceiling: Duration,
    /// Interval between liveness / readiness checks.
    pub poll: Duration,
    /// Interval between "still loading" progress lines.
    pub note_every: Duration,
}

impl LoadWait {
    pub(crate) const STARTUP: LoadWait = LoadWait {
        ceiling: Duration::from_secs(30 * 60),
        poll: Duration::from_secs(2),
        note_every: Duration::from_secs(30),
    };
}

/// The `/load` request never got an HTTP answer (send failure, reset or the
/// client timeout); an HTTP status or an invalid answer is a real rejection.
pub(crate) fn is_transport_failure(error: &str) -> bool {
    error.starts_with("HTTP 请求失败") || error.contains("operation timed out")
}

fn loaded(health: &Value) -> bool {
    health.get("loaded").and_then(Value::as_bool) == Some(true)
}

/// `alive` returns `Ok(None)` while the process runs and `Ok(Some(exit))` once it exited.
pub(crate) async fn wait_for_model_load<L, H, HF>(
    load: L,
    mut health: H,
    mut alive: impl FnMut() -> Result<Option<Option<i32>>, String>,
    mut note: impl FnMut(String),
    wait: LoadWait,
) -> Result<(), String>
where
    L: Future<Output = Result<Value, String>>,
    H: FnMut() -> HF,
    HF: Future<Output = Result<Value, String>>,
{
    let started = Instant::now();
    let mut last_note = started;
    let mut load = std::pin::pin!(load);
    // None: the request is still in flight; Some(true): upstream answered "loaded";
    // Some(false): the request ended without an HTTP answer and we poll /health.
    let mut answered: Option<bool> = None;
    loop {
        if answered.is_none() {
            tokio::select! {
                result = &mut load => match result {
                    Ok(value) => {
                        if !matches!(value.get("status").and_then(Value::as_str), Some("loaded" | "already loaded")) {
                            return Err(format!("模型加载未完成: {value}"));
                        }
                        answered = Some(true);
                    }
                    Err(error) if is_transport_failure(&error) => {
                        note(format!(
                            "启动阶段：加载请求在 {} 秒后未返回，引擎仍在加载；继续等待模型就绪",
                            started.elapsed().as_secs()
                        ));
                        last_note = Instant::now();
                        answered = Some(false);
                    }
                    Err(error) => return Err(diagnostics::during(&error, "loading")),
                },
                _ = tokio::time::sleep(wait.poll) => {}
            }
        } else {
            tokio::time::sleep(wait.poll).await;
        }
        if let Some(exit) = alive()? {
            return Err(diagnostics::error(
                "STARTUP_PROCESS_EXITED",
                format!("模型加载期间本机服务退出，exit {exit:?}；请查看启动日志"),
                "loading",
            ));
        }
        match answered {
            Some(true) => {
                let value = health()
                    .await
                    .map_err(|error| diagnostics::during(&error, "loading"))?;
                return if loaded(&value) {
                    Ok(())
                } else {
                    Err("模型加载响应成功但健康状态未就绪".into())
                };
            }
            Some(false) => {
                // The API can be briefly unresponsive while weights are mapped.
                let ready = health().await.is_ok_and(|value| loaded(&value));
                if ready {
                    return Ok(());
                }
            }
            None => {}
        }
        if started.elapsed() >= wait.ceiling {
            return Err(diagnostics::error(
                "STARTUP_LOAD_TIMEOUT",
                format!(
                    "模型在 {} 分钟内仍未加载完成；服务进程仍保留，可稍后在总览查看状态或查看启动日志",
                    wait.ceiling.as_secs().div_ceil(60)
                ),
                "loading",
            ));
        }
        if last_note.elapsed() >= wait.note_every {
            last_note = Instant::now();
            note(format!(
                "启动阶段：模型仍在加载（已 {} 秒），请稍候",
                started.elapsed().as_secs()
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::{Cell, RefCell};

    const FAST: LoadWait = LoadWait {
        ceiling: Duration::from_millis(400),
        poll: Duration::from_millis(5),
        note_every: Duration::from_millis(20),
    };

    fn code(error: &str) -> String {
        serde_json::from_str::<Value>(error).unwrap()["code"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    #[tokio::test]
    async fn a_load_request_timeout_while_the_engine_keeps_loading_is_not_a_failure() {
        // Shape of the Xiaohongshu report: /load gives up after the client timeout,
        // the engine prints "still starting (261 s)" and becomes ready later.
        let probes = Cell::new(0);
        let notes = RefCell::new(Vec::new());
        let result = wait_for_model_load(
            async {
                Err(
                    "HTTP 请求失败: error sending request for url (http://127.0.0.1:8080/load)"
                        .into(),
                )
            },
            || {
                probes.set(probes.get() + 1);
                let ready = probes.get() >= 4;
                async move {
                    if ready {
                        Ok(json!({"loaded": true}))
                    } else {
                        Ok(json!({"loaded": false}))
                    }
                }
            },
            || Ok(None),
            |line| notes.borrow_mut().push(line),
            FAST,
        )
        .await;
        assert_eq!(result, Ok(()));
        assert!(probes.get() >= 4);
        assert!(
            notes.borrow()[0].contains("引擎仍在加载"),
            "{:?}",
            notes.borrow()
        );
    }

    #[tokio::test]
    async fn an_unreachable_health_probe_during_mapping_keeps_waiting() {
        let probes = Cell::new(0);
        let result = wait_for_model_load(
            async { Err("HTTP 请求失败: operation timed out".into()) },
            || {
                probes.set(probes.get() + 1);
                let n = probes.get();
                async move {
                    match n {
                        1 | 2 => Err("HTTP 请求失败: connection refused".to_string()),
                        _ => Ok(json!({"loaded": true})),
                    }
                }
            },
            || Ok(None),
            |_| {},
            FAST,
        )
        .await;
        assert_eq!(result, Ok(()));
    }

    #[tokio::test]
    async fn a_slow_but_successful_load_reports_progress_and_succeeds() {
        let notes = RefCell::new(Vec::new());
        let result = wait_for_model_load(
            async {
                tokio::time::sleep(Duration::from_millis(80)).await;
                Ok(json!({"status": "loaded"}))
            },
            || async { Ok(json!({"loaded": true})) },
            || Ok(None),
            |line| notes.borrow_mut().push(line),
            FAST,
        )
        .await;
        assert_eq!(result, Ok(()));
        assert!(notes
            .borrow()
            .iter()
            .any(|line| line.contains("模型仍在加载")));
    }

    #[tokio::test]
    async fn the_process_exiting_during_load_is_a_real_failure() {
        let checks = Cell::new(0);
        let result = wait_for_model_load(
            std::future::pending::<Result<Value, String>>(),
            || async { Ok(json!({"loaded": false})) },
            || {
                checks.set(checks.get() + 1);
                Ok(if checks.get() > 2 {
                    Some(Some(3))
                } else {
                    None
                })
            },
            |_| {},
            FAST,
        )
        .await
        .unwrap_err();
        assert_eq!(code(&result), "STARTUP_PROCESS_EXITED");
        assert!(result.contains("loading"));
    }

    #[tokio::test]
    async fn an_upstream_http_rejection_is_reported_immediately() {
        let result = wait_for_model_load(
            async { Err(r#"HTTP 500: {"error":{"message":"bad model"}}"#.into()) },
            || async { Ok(json!({"loaded": false})) },
            || Ok(None),
            |_| {},
            FAST,
        )
        .await
        .unwrap_err();
        let value: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(value["message"], "bad model");
        assert_eq!(value["details"]["startupPhase"], "loading");
    }

    #[tokio::test]
    async fn a_load_that_never_finishes_stops_at_the_ceiling_with_a_readable_message() {
        let result = wait_for_model_load(
            async { Err("HTTP 请求失败: operation timed out".into()) },
            || async { Ok(json!({"loaded": false})) },
            || Ok(None),
            |_| {},
            FAST,
        )
        .await
        .unwrap_err();
        assert_eq!(code(&result), "STARTUP_LOAD_TIMEOUT");
        assert!(result.contains("服务进程仍保留"));
    }
}
