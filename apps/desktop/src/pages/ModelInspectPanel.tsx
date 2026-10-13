import type { AppLanguage } from "@strata-manager/core";
import { useEffect, useRef, useState } from 'react';
import { CircleHelp, FileSearch, FolderOpen, LoaderCircle, Square } from 'lucide-react';
import { listTasks, readTaskLogs, cancelTask, validateModelInspectRequest, type LogEntry, type ModelInspectRequest, type TaskStatus } from '@strata-manager/core';
import { Dialog } from '../components';
import './official-setup.css';
import './setup-tuning-interactions.css';

export interface ModelInspectPanelProps {
  language: AppLanguage;
  desktop: boolean;
  installationId?: string;
  disabled?: boolean;
  onInspect: (request: ModelInspectRequest) => Promise<TaskStatus>;
  onChooseTarget?: () => Promise<string | null>;
  getTasks?: () => Promise<TaskStatus[]>;
  getLogs?: (taskId: string, limit: number) => Promise<LogEntry[]>;
  onCancel?: (taskId: string) => Promise<void>;
}

export function ModelInspectPanel(props: ModelInspectPanelProps) {
  const zh = props.language === 'zh-CN';
  const [target, setTarget] = useState('');
  const [variant, setVariant] = useState('');
  const [task, setTask] = useState<TaskStatus>();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [dialog, setDialog] = useState<'help' | 'result'>();
  const callbacks = useRef(props);
  callbacks.current = props;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const running = task?.state === 'running';
  const state = task?.state;
  const taskId = task?.id;
  useEffect(() => {
    if (!taskId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const api = callbacks.current;
      const results = await Promise.allSettled([(api.getTasks ?? listTasks)(), (api.getLogs ?? readTaskLogs)(taskId, 500)]);
      if (disposed) return;
      const [tasksResult, logsResult] = results;
      let next = state;
      if (tasksResult.status === 'fulfilled') {
        const found = tasksResult.value.find(item => item.id === taskId);
        if (found) { setTask(found); next = found.state; }
      }
      if (logsResult.status === 'fulfilled') setLogs(logsResult.value);
      const failed = results.find(result => result.status === 'rejected');
      setPollError(failed?.status === 'rejected' ? String(failed.reason) : '');
      if (next === 'running') timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => { disposed = true; if (timer) clearTimeout(timer); };
  }, [taskId, state]);

  const execute = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const inspect = () => execute(async () => {
    const request = validateModelInspectRequest({ installationId: props.installationId ?? '', target, variant });
    const started = await props.onInspect(request);
    if (mounted.current) { setTask(started); setLogs([]); setPollError(''); }
  });
  const statusText: Record<string, string> = zh ? { running: '正在读取模型头部', completed: '检查完成', failed: '检查失败', cancelled: '已取消' } : { running: 'Reading model headers', completed: 'Inspection completed', failed: 'Inspection failed', cancelled: 'Cancelled' };
  const output = logs.length ? logs.filter(entry => ['stdout', 'stderr', 'error'].includes(entry.level)).map(entry => entry.message).join('\n') : task?.message ?? '';
  const officialVerdict = output.split(/\r?\n/).find(line => line.trim().startsWith('Strata:'))?.trim().slice(7).trim();
  const unverified = !!officialVerdict && /\bnot tested\b/i.test(officialVerdict);
  const resultSummary = unverified ? (zh ? '此模型尚未经过官方验证。' : 'This model has not been verified by the official project.')
    : officialVerdict?.startsWith("this is setup's --family ") ? (zh ? '已识别为官方支持的模型格式。' : 'Recognized as an officially supported model format.')
    : officialVerdict ?? (/^variants \(pass one/m.test(output) ? (zh ? '检测到多个版本，请指定量化版本后重新检查。' : 'Several variants found. Choose a quantization variant and inspect again.') : '');
  const unavailable = !props.desktop || !props.installationId || props.disabled;
  return <section className="model-inspect-panel" data-testid="model-inspect-panel">
    <div className="setup-tuning-panel-heading"><h3><FileSearch size={16}/>{zh ? '检查模型文件兼容性' : 'Inspect model compatibility'}</h3><button type="button" className="setup-tuning-help-button" aria-label={zh ? '模型检查帮助' : 'Model inspection help'} data-tooltip={zh ? '帮助' : 'Help'} onClick={() => setDialog('help')}><CircleHelp size={16}/></button></div>
    <div className="official-setup-fields model-inspect-fields">
      <label><span>{zh ? '模型位置' : 'Model location'}</span><div className="model-inspect-source"><input aria-label={zh ? '模型位置' : 'Model location'} disabled={unavailable || running || busy} value={target} onChange={event => setTarget(event.target.value)} placeholder={zh ? '选择文件，或填写模型地址' : 'Choose a file or enter a model address'}/>{props.onChooseTarget && <button type="button" aria-label={zh ? '选择模型文件' : 'Choose model file'} disabled={unavailable || running || busy} onClick={() => void execute(async () => { const chosen = await props.onChooseTarget!(); if (chosen && mounted.current) setTarget(chosen); })}><FolderOpen size={15}/>{zh ? '浏览' : 'Browse'}</button>}</div></label>
      <label><span>{zh ? '指定量化版本（可选）' : 'Quantization variant (optional)'}</span><input aria-label={zh ? '指定量化版本（可选）' : 'Quantization variant (optional)'} placeholder={zh ? '全部版本' : 'All variants'} disabled={unavailable || running || busy} value={variant} onChange={event => setVariant(event.target.value)}/></label>
    </div>
    {!props.installationId && <p className="official-setup-note">{zh ? '请先准备或选择一个本机运行环境。' : 'Prepare or select a local runtime first.'}</p>}
    <div className="actions"><button type="button" className="primary" disabled={unavailable || running || busy || !target.trim()} onClick={() => void inspect()}>{busy ? <LoaderCircle size={15} className="spin"/> : <FileSearch size={15}/>} {zh ? '检查兼容性' : 'Inspect compatibility'}</button>{running && <button type="button" disabled={busy} onClick={() => void execute(async () => { await (props.onCancel ?? cancelTask)(task!.id); })}><Square size={14}/>{zh ? '取消' : 'Cancel'}</button>}</div>
    {error && <p className="official-setup-error" role="alert">{error}</p>}
    {task && <div className="model-inspect-result"><p role="status">{running && <LoaderCircle size={14} className="spin"/>}<strong>{statusText[task.state] ?? task.state}</strong></p>{resultSummary && <p className={`model-inspect-verdict${unverified ? ' notice' : ''}`}>{resultSummary}</p>}{task.state === 'failed' && <p className="official-setup-error" role="alert">{task.message}</p>}{pollError && <p className="official-setup-error" role="alert">{pollError}</p>}<button type="button" onClick={() => setDialog('result')}>{zh ? '查看详细结果' : 'View detailed results'}</button></div>}
    {dialog && <Dialog title={dialog === 'help' ? (zh ? '模型检查帮助' : 'Model inspection help') : (zh ? '模型检查结果' : 'Model inspection result')} wide={dialog === 'result'} onClose={() => setDialog(undefined)}><div className="setup-tuning-help-content">{dialog === 'help' ? <><p>{zh ? '选择本地模型文件，或填写目录、HTTPS 地址、hf:owner/repo、ms:owner/repo。多个量化版本时填写 IQ3_S 等版本名称。' : 'Choose a local model file or enter a directory, HTTPS URL, hf:owner/repo or ms:owner/repo. For multiple variants, enter a name such as IQ3_S.'}</p><p>{zh ? '只读取模型信息，不加载模型。识别到格式不代表已经验证此文件能够运行。' : 'This reads model information without loading it. Recognizing a format does not verify that the file will run.'}</p></> : <pre className="model-inspect-output" tabIndex={0} aria-label={zh ? '模型检查结果' : 'Model inspection result'}>{output}</pre>}</div></Dialog>}
  </section>;
}
