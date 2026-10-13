import type { AppLanguage } from "@strata-manager/core";
import { useEffect, useState } from 'react';
import type { ChatExecution } from '@strata-manager/core';
import './daily-experience.css';

export function ChatExecutionStatus({ execution, streaming, language }: { execution: ChatExecution; streaming: boolean; language: AppLanguage }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!streaming) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [streaming]);
  const zh = language === 'zh-CN';
  const labels = zh ? { waiting: '等待响应', reasoning: '正在思考', tools: '工具调用', generating: '正在回答', completed: '已完成', cancelled: '已停止', failed: '失败' } : { waiting: 'Waiting for response', reasoning: 'Reasoning', tools: 'Tool call', generating: 'Answering', completed: 'Completed', cancelled: 'Stopped', failed: 'Failed' };
  const seconds = (value?: number) => value === undefined ? '—' : `${(Math.max(0, value) / 1000).toLocaleString(language, { maximumFractionDigits: 1 })} s`;
  return <div className="chat-execution" aria-label={zh ? '本次请求状态' : 'This request status'}><span aria-live="polite">{labels[execution.phase]}</span><span>{seconds((execution.finishedAt ?? now) - execution.startedAt)}</span>{execution.firstTokenMs !== undefined && <span>TTFT {seconds(execution.firstTokenMs)}</span>}{!streaming && <span>{zh ? '首正文' : 'First answer'} {seconds(execution.firstVisibleMs)}</span>}<details><summary>{zh ? '请求标识' : 'Request identity'}</summary><div>{zh ? '本地操作' : 'Local operation'} <code>{execution.operationId}</code></div><div>{zh ? '服务请求' : 'Service request'} <code>{execution.serviceRequestId ?? '—'}</code></div><div>{zh ? '响应' : 'Response'} <code>{execution.responseId ?? '—'}</code></div>{!execution.serviceRequestId && <p>{zh ? '服务未返回可关联的请求标识；排队与输入处理只在服务总体状态中显示。' : 'No correlatable service request ID was returned. Queue and input processing remain service-wide observations.'}</p>}</details></div>;
}
