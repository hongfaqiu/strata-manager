import type { AppLanguage } from '@strata-manager/core';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CircleAlert, Download, LoaderCircle, Square } from 'lucide-react';
import * as core from '@strata-manager/core';
import { Dropdown } from '../OfficialControls';
import './managed-python.css';

const words = {
  'zh-CN': {
    title: (v: string) => `安装应用内 Python ${v}`,
    lead: (found: string) => found ? `检测到 ${found}，低于 Strata 需要的 Python 3.10。` : '没有找到 Strata 需要的 Python 3.10 或更高版本。',
    body: (size: string) => `下载官方 python-build-standalone 构建（约 ${size}）到应用目录。不需要管理员权限，也不改动系统或 Homebrew 的 Python。`,
    source: '下载来源', install: '一键安装 Python', retry: '重新安装', cancel: '取消', canceling: '正在取消…', starting: '正在开始…',
    running: (v: string) => `正在安装 Python ${v}`, runningHint: '下载完成后会校验 SHA-256，再解包并检查 venv。可以离开此页面，任务会在后台继续。',
    done: (v: string) => `Python ${v} 已就绪`, doneHint: 'Strata 会自动使用它，无需配置 PATH。',
    failed: 'Python 没有装好', cancelled: '已取消安装 Python', retryHint: '已下载的部分会保留，重试时接着下载；GitHub 较慢时可以换一个下载来源。',
    unsupported: '此系统暂不支持一键安装，请自行安装 Python 3.10 或更高版本后点「重新检测」。',
  },
  en: {
    title: (v: string) => `Add an app-private Python ${v}`,
    lead: (found: string) => found ? `Found ${found}; Strata needs Python 3.10 or newer.` : 'Strata needs Python 3.10 or newer, and none was found.',
    body: (size: string) => `Download the official python-build-standalone build (about ${size}) into the app folder. No administrator rights; the system and Homebrew Python stay untouched.`,
    source: 'Download source', install: 'Install Python', retry: 'Install again', cancel: 'Cancel', canceling: 'Cancelling…', starting: 'Starting…',
    running: (v: string) => `Installing Python ${v}`, runningHint: 'The download is checked against its SHA-256, then unpacked and checked for venv. You can leave this page; the task continues in the background.',
    done: (v: string) => `Python ${v} is ready`, doneHint: 'Strata uses it automatically; no PATH changes needed.',
    failed: 'Python was not installed', cancelled: 'Python installation cancelled', retryHint: 'The partial download is kept and resumes on retry. If GitHub is slow, pick another download source.',
    unsupported: 'One-click install is not available on this system. Install Python 3.10 or newer, then check again.',
  },
} as const;

const mib = (bytes?: number) => bytes ? `${Math.round(bytes / 1024 / 1024)} MB` : '25 MB';

export interface ManagedPythonPanelProps {
  language: AppLanguage;
  desktop: boolean;
  /** The Python version string the environment check found, e.g. `Python 3.9.6`. */
  found?: string | null;
  /** Called once after a successful install so callers can re-check. */
  onInstalled?: () => void;
  /** `compact`: a row inside a panel (top rule); `inline`: inside a card, no frame. */
  variant?: 'framed' | 'compact' | 'inline';
}

/** Shown where "Python 3.10+ is required" appears: one-click, app-private Python with progress and cancel. */
export function ManagedPythonPanel(props: ManagedPythonPanelProps) {
  const text = words[props.language === 'zh-CN' ? 'zh-CN' : 'en'];
  const client = useQueryClient();
  const [action, setAction] = useState<'start' | 'cancel' | null>(null);
  const [error, setError] = useState('');
  const preferences = useQuery({ queryKey: ['runtime-download-preferences'], queryFn: core.getRuntimeDownloadPreferences, enabled: props.desktop, staleTime: 60000 });
  const [source, setSource] = useState<core.ManagedPythonSourceId>();
  const status = useQuery({
    queryKey: ['managed-python'], queryFn: core.managedPythonStatus, enabled: props.desktop,
    refetchInterval: query => query.state.data?.task?.state === 'running' ? 1000 : false,
  });
  const phase = core.managedPythonPhase(status.data);
  const version = status.data?.version ?? '3.12.15';
  const chosen = source ?? core.defaultManagedPythonSource(preferences.data);
  const [announced, setAnnounced] = useState<string>();
  useEffect(() => {
    const task = status.data?.task;
    if (phase !== 'installed' || !task || task.state !== 'completed' || announced === task.id) return;
    setAnnounced(task.id);
    void client.invalidateQueries({ queryKey: ['environment'] });
    props.onInstalled?.();
  }, [phase, status.data?.task, announced, client, props]);

  useEffect(() => { if (phase !== 'running' && action === 'cancel') setAction(null); }, [phase, action]);

  if (!props.desktop || status.isLoading || !status.data) return null;

  const start = async () => {
    setAction('start'); setError('');
    try { await core.installManagedPython(core.managedPythonSourceTemplate(chosen)); }
    catch (reason) { setError(core.normalizeError(reason).message); }
    finally { setAction(null); void status.refetch(); }
  };
  const cancel = async () => {
    const task = status.data?.task;
    if (!task) return;
    setAction('cancel'); setError('');
    try { await core.cancelTask(task.id); }
    catch (reason) { setError(core.normalizeError(reason).message); }
    finally { void status.refetch(); }
  };

  const message = status.data.task?.message ? core.runtimeBilingualText(status.data.task.message, props.language === 'zh-CN') : '';
  const percent = core.managedPythonProgress(status.data.task?.message);
  const className = `managed-python is-${props.variant ?? 'framed'} is-${phase}`;

  if (phase === 'installed') return <div className={className} role="status" data-testid="managed-python">
    <Check size={17} className="managed-python-mark"/>
    <div className="managed-python-body"><strong>{text.done(version)}</strong><p>{text.doneHint}</p>{status.data.interpreter && <code>{status.data.interpreter}</code>}</div>
  </div>;

  if (phase === 'unsupported') return <div className={className} role="status" data-testid="managed-python"><CircleAlert size={17} className="managed-python-mark"/><div className="managed-python-body"><p>{text.unsupported}</p></div></div>;

  if (phase === 'running') return <div className={className} role="status" aria-live="polite" data-testid="managed-python">
    <LoaderCircle size={17} className="managed-python-mark spin"/>
    <div className="managed-python-body">
      <strong>{text.running(version)}</strong>
      <div className={`managed-python-bar${percent === undefined ? ' is-indeterminate' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={percent === undefined ? undefined : { width: `${percent}%` }}/></div>
      {message && <p className="managed-python-step">{message}</p>}
      <p>{text.runningHint}</p>
    </div>
    <div className="managed-python-actions"><button type="button" disabled={action === 'cancel'} onClick={() => void cancel()}><Square size={12}/>{action === 'cancel' ? text.canceling : text.cancel}</button></div>
  </div>;

  const failed = phase === 'failed' || phase === 'cancelled';
  return <div className={className} data-testid="managed-python">
    {failed ? <CircleAlert size={17} className="managed-python-mark"/> : <Download size={17} className="managed-python-mark"/>}
    <div className="managed-python-body">
      <strong>{phase === 'failed' ? text.failed : phase === 'cancelled' ? text.cancelled : text.title(version)}</strong>
      {failed && message && <p className="managed-python-error" role="alert">{message}</p>}
      <p>{failed ? text.retryHint : <>{props.variant === 'compact' ? '' : text.lead(props.found ?? '')}{text.body(mib(status.data.downloadBytes))}</>}</p>
      <div className="managed-python-source"><span>{text.source}</span><Dropdown compact className="managed-python-select" ariaLabel={text.source} value={chosen} disabled={action !== null} onValueChange={value => setSource(value as core.ManagedPythonSourceId)} options={core.managedPythonSources.map(item => ({ value: item.id, label: item.label }))}/></div>
      {error && <p className="managed-python-error" role="alert">{error}</p>}
    </div>
    <div className="managed-python-actions"><button type="button" className="primary" disabled={action !== null} onClick={() => void start()}>{action === 'start' ? <LoaderCircle size={14} className="spin"/> : <Download size={14}/>}{action === 'start' ? text.starting : failed ? text.retry : text.install}</button></div>
  </div>;
}
