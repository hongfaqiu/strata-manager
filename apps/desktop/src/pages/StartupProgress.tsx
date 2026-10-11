import { useEffect, useRef, useState } from 'react';
import { Check, Clock3, FileText, LoaderCircle } from 'lucide-react';
import type { LogEntry } from '@strata-manager/core';
import './startup-progress.css';

export interface StartupProgressState {
  phase: 'importing' | 'starting' | 'loading';
  message?: string;
  startedAt?: number;
  logs?: LogEntry[];
  pid?: number;
  apiUrl?: string;
  modelName?: string;
  profileId?: string;
}

export interface StartupProgressProps {
  language: 'zh-CN' | 'en';
  progress: StartupProgressState;
  modelName?: string;
  apiUrl?: string;
}

const words = {
  'zh-CN': {
    title: '正在准备本机模型', importing: '检查并加入我的模型', starting: '启动本机 API', loading: '加载模型并验证就绪',
    elapsed: '已用时', noLogs: '等待后台首次输出。', logs: '启动详情', waiting: '当前阶段尚未返回新的日志。大型模型的首次加载可能需要数分钟。',
    hint: '这里显示真实启动阶段与后台输出；模型文件会保留。', pid: '进程', api: 'API 地址',
  },
  en: {
    title: 'Preparing the local model', importing: 'Check and add to My models', starting: 'Start local API', loading: 'Load the model and verify readiness',
    elapsed: 'Elapsed', noLogs: 'Waiting for the first background output.', logs: 'Startup details', waiting: 'This stage has not produced a new log yet. Large models can take several minutes to load for the first time.',
    hint: 'Actual startup stages and background output are shown here. Model files are retained.', pid: 'Process', api: 'API address',
  },
} as const;

const formatDuration = (milliseconds: number) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** No estimated percentage: engine output and readiness are the source of truth. */
export function StartupProgress({ language, progress, modelName, apiUrl }: StartupProgressProps) {
  const text = words[language];
  const firstSeen = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);
  const startedAt = progress.startedAt ?? firstSeen.current;
  const logs = (progress.logs ?? []).filter(log => log.timestamp >= startedAt).slice(-30);
  const phase = ['importing', 'starting', 'loading'].indexOf(progress.phase);
  const latestAt = logs.at(-1)?.timestamp ?? startedAt;
  const label = text[progress.phase];
  return <section className="startup-progress" aria-label={text.title} data-testid="startup-progress">
    <div className="startup-progress-heading" role="status" aria-live="polite">
      <LoaderCircle className="spin" size={20}/><div><strong>{modelName || progress.modelName ? `${text.title} · ${modelName ?? progress.modelName}` : text.title}</strong><p>{label}</p></div>
      <span className="startup-progress-elapsed"><Clock3 size={13}/>{text.elapsed} {formatDuration(now - startedAt)}</span>
    </div>
    <ol className="startup-progress-steps">{(['importing', 'starting', 'loading'] as const).map((step, index) => <li key={step} className={index < phase ? 'is-complete' : index === phase ? 'is-current' : ''} aria-current={index === phase ? 'step' : undefined}>
      {index < phase ? <Check size={13}/> : index === phase ? <LoaderCircle className="spin" size={13}/> : <span>{index + 1}</span>}{text[step]}
    </li>)}</ol>
    {progress.message && progress.message !== label && <p className="startup-progress-message">{progress.message}</p>}
    {(progress.pid || apiUrl || progress.apiUrl) && <p className="startup-progress-connection">{progress.pid && <span>{text.pid} {progress.pid}</span>}{(apiUrl || progress.apiUrl) && <span>{text.api} <code>{apiUrl ?? progress.apiUrl}</code></span>}</p>}
    <details className="startup-progress-logs" open><summary><FileText size={14}/>{text.logs}</summary><div className="startup-progress-log-output" tabIndex={0}>{logs.length ? logs.map((log, index) => <div key={`${log.timestamp}-${index}`}><time>{new Date(log.timestamp).toLocaleTimeString(language)}</time><span>{log.message}</span></div>) : <p>{text.noLogs}</p>}</div></details>
    {now - latestAt >= 30_000 && <p className="startup-progress-waiting">{text.waiting}</p>}
    <p className="startup-progress-hint">{text.hint}</p>
  </section>;
}
