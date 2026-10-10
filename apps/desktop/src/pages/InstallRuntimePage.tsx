import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, CircleAlert, Download, FileText, LoaderCircle, RefreshCw, Square } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { LogEntry, PreparedRuntime, RuntimeInstallationStatus, TaskStatus } from '@strata-manager/core';
import { Empty, Header, Panel } from '../components';
import './install-runtime.css';

const words = {
  'zh-CN': {
    title: '安装 Strata', intro: '应用会自动检测运行环境，准备官方 Strata 与专用 Python 环境。无需填写目录或安装 Git。',
    refresh: '重新检测', checking: '正在检查安装状态…', start: '自动安装', retry: '重试安装', starting: '正在创建安装任务…',
    running: '正在准备运行环境', completed: '运行环境已就绪', failed: '安装未完成', cancelled: '安装已取消',
    cancel: '取消安装', canceling: '正在安全取消…', continue: '选择模型', continuing: '正在打开模型选择…',
    readyHint: '下一步选择模型并下载模型文件。当前步骤仅准备运行环境，不下载模型。',
    runningHint: '可以离开此页面，任务会在后台继续；返回后会恢复实际进度。',
    retryHint: '已校验的下载文件会保留，重试时可继续使用。',
    installStep: '准备运行环境', modelStep: '选择并下载模型', serviceStep: '自动启动模型服务',
    logs: '安装日志', showLogs: '查看日志', hideLogs: '收起日志', emptyLogs: '还没有任务日志。',
    logsUnavailable: '暂时无法读取日志', statusUnavailable: '暂时无法读取安装状态', unknownTask: '未找到上一任务的状态。请重新检测，或重试安装。',
    nativeTitle: '请在桌面应用中安装', nativeHint: '自动安装需要桌面应用的本地后台。',
    noEstimate: '显示后台实际状态；下载与校验时间取决于网络及电脑性能。',
    awaitingResult: '正在确认准备结果…',
    callbackFailed: '无法进入模型选择', actionFailed: '操作未完成', details: '技术信息', revision: 'Strata 版本', directory: '运行环境目录', python: 'Python 环境',
  },
  en: {
    title: 'Install Strata', intro: 'The app detects your environment and prepares official Strata with its own Python environment. No directory selection or Git installation is needed.',
    refresh: 'Check again', checking: 'Checking installation status…', start: 'Install automatically', retry: 'Retry installation', starting: 'Creating installation task…',
    running: 'Preparing the runtime', completed: 'Runtime ready', failed: 'Installation incomplete', cancelled: 'Installation cancelled',
    cancel: 'Cancel installation', canceling: 'Cancelling safely…', continue: 'Choose a model', continuing: 'Opening model selection…',
    readyHint: 'Next, choose a model and download its files. This step only prepares the runtime; it does not download a model.',
    runningHint: 'You can leave this page while preparation continues in the background. Returning restores the actual progress.',
    retryHint: 'Verified downloads are retained and can be reused when you retry.',
    installStep: 'Prepare runtime', modelStep: 'Choose and download a model', serviceStep: 'Start the model service automatically',
    logs: 'Installation logs', showLogs: 'Show logs', hideLogs: 'Hide logs', emptyLogs: 'No task logs yet.',
    logsUnavailable: 'Logs are temporarily unavailable', statusUnavailable: 'Installation status is temporarily unavailable', unknownTask: 'The previous task status could not be found. Check again or retry installation.',
    nativeTitle: 'Install from the desktop app', nativeHint: 'Automatic installation requires the desktop app’s local background service.',
    noEstimate: 'This shows the actual background status. Download and verification time depend on your network and computer.',
    awaitingResult: 'Confirming the prepared runtime…',
    callbackFailed: 'Could not open model selection', actionFailed: 'The operation did not complete', details: 'Technical details', revision: 'Strata revision', directory: 'Runtime directory', python: 'Python environment',
  },
} as const;

export interface InstallRuntimePageProps {
  language: 'zh-CN' | 'en';
  desktop: boolean;
  onPrepared: (runtime: PreparedRuntime) => void | Promise<void>;
}

/** The install RPC starts a persisted background task. Rendering never starts an installation. */
export function InstallRuntimePage(props: InstallRuntimePageProps) {
  const text = words[props.language];
  const [installation, setInstallation] = useState<RuntimeInstallationStatus>({});
  const [task, setTask] = useState<TaskStatus>();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(props.desktop);
  const [statusError, setStatusError] = useState('');
  const [logError, setLogError] = useState('');
  const [actionError, setActionError] = useState('');
  const [action, setAction] = useState<'start' | 'cancel' | 'continue' | null>(null);
  const [cancelRequested, setCancelRequested] = useState('');
  const [logsOpen, setLogsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const callbacks = useRef(props);
  callbacks.current = props;
  const mounted = useRef(false);
  const lifetime = useRef(0);
  const operation = useRef(false);
  const cancelPending = useRef('');
  const epoch = useRef(0);
  const polling = useRef(false);
  const snapshot = useRef<{ installation: RuntimeInstallationStatus; task?: TaskStatus }>({ installation: {} });
  const describe = (value: unknown) => core.normalizeError(value).message;

  const refresh = useCallback(async () => {
    if (!mounted.current || !callbacks.current.desktop || polling.current || operation.current) return;
    polling.current = true;
    const life = lifetime.current;
    const version = epoch.current;
    const valid = () => mounted.current && life === lifetime.current && version === epoch.current;
    setRefreshing(true);
    try {
      const [status, tasks] = await Promise.all([core.localRuntimeInstallation(), core.listTasks()]);
      if (!valid()) return;
      const current = status.taskId ? tasks.find(item => item.id === status.taskId) : undefined;
      snapshot.current = { installation: status, task: current };
      setInstallation(status);
      setTask(current);
      setLoaded(true);
      setStatusError('');
      if (!current || current.state !== 'running') { cancelPending.current = ''; setCancelRequested(''); }
      if (!status.taskId) { setLogs([]); setLogError(''); return; }
      try {
        const entries = await core.readTaskLogs(status.taskId, 150);
        if (valid()) { setLogs(entries); setLogError(''); }
      } catch (error) {
        if (valid()) setLogError(describe(error));
      }
    } catch (error) {
      if (valid()) setStatusError(describe(error));
    } finally {
      if (life === lifetime.current) polling.current = false;
      if (valid()) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    lifetime.current += 1;
    polling.current = false;
    if (props.desktop) void refresh();
    const timer = props.desktop ? window.setInterval(() => void refresh(), 1500) : undefined;
    return () => {
      mounted.current = false;
      lifetime.current += 1;
      polling.current = false;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [props.desktop, refresh]);

  const start = async () => {
    const current = snapshot.current;
    if (!mounted.current || !callbacks.current.desktop || operation.current || !loaded || statusError || current.task?.state === 'running' || (current.installation.result && (!current.task || current.task.state === 'completed'))) return;
    operation.current = true;
    epoch.current += 1;
    const life = lifetime.current;
    setAction('start');
    setActionError('');
    cancelPending.current = '';
    setCancelRequested('');
    try {
      const created = await core.prepareLocalRuntime();
      if (!mounted.current || life !== lifetime.current) return;
      const next = { taskId: created.id };
      snapshot.current = { installation: next, task: created };
      setInstallation(next);
      setTask(created);
      setLogs([]);
      setLogError('');
      setLogsOpen(true);
    } catch (error) {
      if (mounted.current && life === lifetime.current) setActionError(describe(error));
    } finally {
      operation.current = false;
      if (mounted.current && life === lifetime.current) { setAction(null); setRefreshing(false); void refresh(); }
    }
  };

  const cancel = async () => {
    const current = snapshot.current.task;
    if (!mounted.current || operation.current || current?.state !== 'running' || cancelPending.current === current.id) return;
    operation.current = true;
    epoch.current += 1;
    const life = lifetime.current;
    setAction('cancel');
    setActionError('');
    cancelPending.current = current.id;
    setCancelRequested(current.id);
    try {
      await core.cancelTask(current.id);
    } catch (error) {
      if (mounted.current && life === lifetime.current) { cancelPending.current = ''; setCancelRequested(''); setActionError(describe(error)); }
    } finally {
      operation.current = false;
      if (mounted.current && life === lifetime.current) { setAction(null); setRefreshing(false); void refresh(); }
    }
  };

  const proceed = async () => {
    const current = snapshot.current;
    if (!mounted.current || operation.current || statusError || !current.installation.result || (current.task && current.task.state !== 'completed')) return;
    operation.current = true;
    epoch.current += 1;
    const life = lifetime.current;
    setAction('continue');
    setActionError('');
    try {
      await callbacks.current.onPrepared(current.installation.result);
    } catch (error) {
      if (mounted.current && life === lifetime.current) setActionError(describe(error));
    } finally {
      operation.current = false;
      if (mounted.current && life === lifetime.current) { setAction(null); setRefreshing(false); void refresh(); }
    }
  };

  const running = task?.state === 'running';
  const prepared = installation.result && (!task || task.state === 'completed') ? installation.result : undefined;
  const canceling = running && cancelRequested === task.id;
  const initial = props.desktop && !loaded && !statusError;
  const busy = action !== null;
  const title = canceling ? text.canceling : prepared ? text.completed : task?.state === 'completed' ? text.awaitingResult : task ? text[task.state] : initial ? text.checking : text.installStep;

  return <section className="install-runtime" aria-label={text.title} data-testid="install-runtime">
    <Header title={text.title} hint={text.intro}><button type="button" disabled={!props.desktop || refreshing || busy} onClick={() => void refresh()}><RefreshCw size={15}/>{text.refresh}</button></Header>
    {!props.desktop ? <Empty title={text.nativeTitle} hint={text.nativeHint}/> : <>
      <ol className="install-runtime-steps" aria-label={text.title}><li className={prepared ? 'is-complete' : 'is-current'}>{prepared ? <Check size={14}/> : <span>1</span>}{text.installStep}</li><li><span>2</span>{text.modelStep}</li><li><span>3</span>{text.serviceStep}</li></ol>
      {statusError && <div className="install-runtime-error" role="alert"><CircleAlert size={17}/><div><strong>{text.statusUnavailable}</strong><p>{statusError}</p></div></div>}
      <Panel title={text.installStep} className={`install-runtime-card${prepared ? ' is-ready' : ''}`}>
        <div className="install-runtime-state" role="status" aria-live="polite">{running || initial || action === 'start' ? <LoaderCircle size={23} className="spin"/> : prepared ? <Check size={23}/> : task?.state === 'failed' ? <CircleAlert size={23}/> : <Download size={23}/>}<div><h3>{action === 'start' ? text.starting : action === 'continue' ? text.continuing : title}</h3><p>{prepared ? text.readyHint : running ? text.runningHint : task?.state === 'failed' || task?.state === 'cancelled' ? text.retryHint : text.noEstimate}</p></div></div>
        {task?.message && <p className="install-runtime-message">{task.message}</p>}
        {installation.taskId && !task && !prepared && loaded && <p className="install-runtime-message">{text.unknownTask}</p>}
        <div className="actions install-runtime-actions">{prepared ? <button type="button" className="primary" disabled={busy || !!statusError} onClick={() => void proceed()}>{text.continue}<ArrowRight size={16}/></button> : running ? <button type="button" disabled={busy || canceling} onClick={() => void cancel()}><Square size={14}/>{canceling ? text.canceling : text.cancel}</button> : <button type="button" className="primary" disabled={!loaded || busy || !!statusError || initial} onClick={() => void start()}><Download size={15}/>{task || installation.taskId ? text.retry : text.start}</button>}{installation.taskId && <button type="button" aria-expanded={logsOpen} aria-controls="install-runtime-logs" onClick={() => setLogsOpen(value => !value)}><FileText size={15}/>{logsOpen ? text.hideLogs : text.showLogs}</button>}</div>
        {actionError && <div className="install-runtime-error" role="alert"><CircleAlert size={17}/><div><strong>{action === 'continue' ? text.callbackFailed : text.actionFailed}</strong><p>{actionError}</p></div></div>}
      </Panel>
      {logsOpen && installation.taskId && <Panel title={text.logs} className="install-runtime-log-panel">{logError && <p className="install-runtime-log-error" role="alert">{text.logsUnavailable}: {logError}</p>}<div id="install-runtime-logs" className="install-runtime-logs" role="log" aria-label={text.logs} aria-live="off">{logs.length ? logs.map((entry, index) => <div className="install-runtime-log-line" key={`${entry.timestamp}-${index}`}><time dateTime={new Date(entry.timestamp).toISOString()}>{new Date(entry.timestamp).toLocaleTimeString(props.language)}</time><span className={`install-runtime-log-level ${entry.level}`}>{entry.level}</span><span>{entry.message}</span></div>) : <p>{text.emptyLogs}</p>}</div></Panel>}
      {prepared && <section className="install-runtime-details"><button type="button" aria-expanded={detailsOpen} aria-controls="install-runtime-details" onClick={() => setDetailsOpen(value => !value)}>{text.details}</button>{detailsOpen && <dl id="install-runtime-details"><div><dt>{text.revision}</dt><dd><code>{prepared.sourceRevision}</code></dd></div><div><dt>{text.directory}</dt><dd><code>{prepared.installDir}</code></dd></div><div><dt>{text.python}</dt><dd><code>{prepared.pythonPath}</code></dd></div></dl>}</section>}
    </>}
  </section>;
}
