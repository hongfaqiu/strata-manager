import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, Download, FileText, LoaderCircle, RefreshCw, Square } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { LogEntry, RuntimeInstallationStatus, TaskStatus } from '@strata-manager/core';
import { Empty, Header, Panel } from '../components';
import { Dropdown } from '../OfficialControls';
import { RuntimeManagementPanel } from './RuntimeManagementPanel';
import './install-runtime.css';

const words = {
  'zh-CN': {
    title: 'Strata', intro: '首次使用时，先安装 Strata，再准备模型。', installedIntro: '统一管理本机 Strata 运行环境、版本和上游更新。',
    refresh: '重新检测', checking: '正在检查安装状态…', start: '自动安装', retry: '重试安装', starting: '正在创建安装任务…',
    running: '正在准备运行环境', completed: '运行环境已就绪', failed: '安装未完成', cancelled: '安装已取消',
    cancel: '取消安装', canceling: '正在安全取消…',
    readyHint: 'Strata 已安装。下一步选择已有模型，或下载新模型。',
    runningHint: '可以离开此页面，任务会在后台继续；返回后会恢复实际进度。',
    retryHint: '已校验的下载文件会保留，重试时可继续使用。',
    installStep: '准备运行环境', modelStep: '选择并下载模型', serviceStep: '自动启动模型服务',
    logs: '安装日志', showLogs: '查看日志', hideLogs: '收起日志', emptyLogs: '还没有任务日志。',
    logsUnavailable: '暂时无法读取日志', statusUnavailable: '暂时无法读取安装状态', unknownTask: '未找到上一任务的状态。请重新检测，或重试安装。',
    nativeTitle: '请在桌面应用中安装', nativeHint: '自动安装需要桌面应用的本地后台。',
    noEstimate: '显示后台实际状态；下载与校验时间取决于网络及电脑性能。',
    awaitingResult: '正在确认准备结果…',
    callbackFailed: '无法进入模型选择', actionFailed: '操作未完成', details: '技术信息', revision: 'Strata 版本', directory: '运行环境目录', python: 'Python 环境',
    chooseRuntime: '选择运行环境', existingRuntime: '已检测到本机 Strata', runtimeRepair: '需要补齐运行环境',
    environment: '运行环境', installed: '已安装', version: '引擎版本', notPrepared: '尚未准备引擎',
    prepareRuntime: '准备完整运行环境', repairHint: '在应用管理目录准备完整的独立运行环境，原目录保留。完成后可以切换使用。',
    repairFallback: '已检测到 Strata 文件，但 Python 或运行依赖尚未就绪。',
  },
  en: {
    title: 'Strata', intro: 'On a new computer, install Strata before preparing a model.', installedIntro: 'Manage local Strata runtimes, versions and upstream updates in one place.',
    refresh: 'Check again', checking: 'Checking installation status…', start: 'Install automatically', retry: 'Retry installation', starting: 'Creating installation task…',
    running: 'Preparing the runtime', completed: 'Runtime ready', failed: 'Installation incomplete', cancelled: 'Installation cancelled',
    cancel: 'Cancel installation', canceling: 'Cancelling safely…',
    readyHint: 'Strata is installed. Choose an existing model or download a new one next.',
    runningHint: 'You can leave this page while preparation continues in the background. Returning restores the actual progress.',
    retryHint: 'Verified downloads are retained and can be reused when you retry.',
    installStep: 'Prepare runtime', modelStep: 'Choose and download a model', serviceStep: 'Start the model service automatically',
    logs: 'Installation logs', showLogs: 'Show logs', hideLogs: 'Hide logs', emptyLogs: 'No task logs yet.',
    logsUnavailable: 'Logs are temporarily unavailable', statusUnavailable: 'Installation status is temporarily unavailable', unknownTask: 'The previous task status could not be found. Check again or retry installation.',
    nativeTitle: 'Install from the desktop app', nativeHint: 'Automatic installation requires the desktop app’s local background service.',
    noEstimate: 'This shows the actual background status. Download and verification time depend on your network and computer.',
    awaitingResult: 'Confirming the prepared runtime…',
    callbackFailed: 'Could not open model selection', actionFailed: 'The operation did not complete', details: 'Technical details', revision: 'Strata revision', directory: 'Runtime directory', python: 'Python environment',
    chooseRuntime: 'Choose a runtime', existingRuntime: 'Local Strata detected', runtimeRepair: 'Runtime needs repair',
    environment: 'Runtime', installed: 'Installed', version: 'Engine version', notPrepared: 'Engine not prepared yet',
    prepareRuntime: 'Prepare a complete runtime', repairHint: 'Prepare a complete, separate runtime in the app-managed directory. The original directory is retained; switch after preparation.',
    repairFallback: 'Strata files were detected, but Python or runtime dependencies are not ready.',
  },
} as const;

export interface InstallRuntimePageProps {
  language: 'zh-CN' | 'en';
  desktop: boolean;
  autoCheck?: boolean;
  operationDisabled?: boolean;
}

function detectedRuntimes(status: RuntimeInstallationStatus): core.DetectedRuntime[] {
  if (status.detectedRuntimes) return status.detectedRuntimes;
  const result = status.result;
  return result ? [{ installDir: result.installDir, pythonPath: result.pythonPath, sourceRevision: result.sourceRevision, readiness: 'ready', profile: result.profile }] : [];
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
  const [action, setAction] = useState<'start' | 'cancel' | null>(null);
  const [cancelRequested, setCancelRequested] = useState('');
  const [logsOpen, setLogsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [selectedRuntime, setSelectedRuntime] = useState('');
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

  const refresh = useCallback(async (manual = false) => {
    if (!mounted.current || !callbacks.current.desktop || operation.current) return;
    // Polling keeps task status current without changing the manual action's state.
    // A manual check can reuse the request already in flight.
    if (manual) setRefreshing(true);
    if (polling.current) return;
    polling.current = true;
    const life = lifetime.current;
    const version = epoch.current;
    const valid = () => mounted.current && life === lifetime.current && version === epoch.current;
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
      if (mounted.current && life === lifetime.current) setRefreshing(false);
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

  const start = async (repair = false) => {
    if (props.operationDisabled) return;
    const current = snapshot.current;
    if (!mounted.current || !callbacks.current.desktop || operation.current || !loaded || statusError || current.task?.state === 'running' || (!repair && detectedRuntimes(current.installation).length > 0)) return;
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
      const next = { ...current.installation, taskId: created.id };
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

  const running = task?.state === 'running';
  const runtimes = detectedRuntimes(installation);
  const installed = runtimes.length > 0;
  const detected = runtimes.find(runtime => runtime.installDir === selectedRuntime) ?? runtimes.find(runtime => runtime.readiness === 'ready') ?? runtimes[0];
  const prepared = detected?.readiness === 'ready' ? { installationId: detected.profile.id, sourceRevision: detected.sourceRevision ?? detected.runtimeVersion ?? '', installDir: detected.installDir, pythonPath: detected.pythonPath, preparedAt: Date.now(), profile: detected.profile } : undefined;
  const canceling = running && cancelRequested === task.id;
  const initial = props.desktop && !loaded && !statusError;
  const busy = action !== null;
  const title = canceling ? text.canceling : running ? text.running : prepared ? text.completed : task?.state === 'completed' ? text.awaitingResult : task ? text[task.state] : initial ? text.checking : text.installStep;

  const errorBlock = actionError && <div className="install-runtime-error" role="alert"><CircleAlert size={17}/><div><strong>{text.actionFailed}</strong><p>{actionError}</p></div></div>;
  const logButton = installation.taskId && <button type="button" aria-expanded={logsOpen} aria-controls="install-runtime-logs" onClick={() => setLogsOpen(value => !value)}><FileText size={15}/>{logsOpen ? text.hideLogs : text.showLogs}</button>;
  return <section className={`install-runtime${installed ? ' has-runtime' : ''}`} aria-label={text.title} data-testid="install-runtime" data-installed={installed}>
    {!installed && <Header title={text.title} hint={text.intro}><button type="button" disabled={!props.desktop || refreshing || busy} aria-busy={refreshing} onClick={() => void refresh(true)}><RefreshCw size={15} className={refreshing ? 'spin' : undefined}/>{text.refresh}</button></Header>}
    {!props.desktop ? <Empty title={text.nativeTitle} hint={text.nativeHint}/> : <>
      {statusError && <div className="install-runtime-error" role="alert"><CircleAlert size={17}/><div><strong>{text.statusUnavailable}</strong><p>{statusError}</p></div></div>}
      {installed && detected ? <>
        <Panel title={text.environment} className="runtime-installed-summary" action={<button type="button" disabled={refreshing || busy} aria-busy={refreshing} onClick={() => void refresh(true)}><RefreshCw size={15} className={refreshing ? 'spin' : undefined}/>{text.refresh}</button>}>
          <div className="runtime-summary-selection"><span className={`runtime-summary-status ${detected.readiness === 'ready' ? 'runtime-ready' : 'runtime-repair'}`}>{detected.readiness === 'ready' ? <Check size={14}/> : <CircleAlert size={14}/>} {detected.readiness === 'ready' ? text.installed : text.runtimeRepair}</span><div><span className="runtime-selection-label">{text.chooseRuntime}</span><Dropdown ariaLabel={text.chooseRuntime} value={detected.installDir} disabled={busy || running} onValueChange={setSelectedRuntime} options={runtimes.map(runtime => ({ value: runtime.installDir, label: `${runtime.runtimeVersion ? `Strata ${runtime.runtimeVersion} · ` : ''}${runtime.installDir}${runtime.readiness === 'repair' ? ` · ${text.runtimeRepair}` : ''}` }))}/></div></div>
          <dl className="runtime-summary-facts"><div><dt>{text.directory}</dt><dd><code>{detected.installDir}</code></dd></div><div><dt>{text.version}</dt><dd>{detected.runtimeVersion ?? text.notPrepared}</dd></div></dl>
          {detected.readiness === 'repair' && <div className="runtime-repair-details" role="status"><p>{detected.reason ?? text.repairFallback}</p><small>{text.repairHint}</small></div>}
          {running && <p className="runtime-summary-task" role="status"><LoaderCircle size={15} className="spin"/><span>{task.message}</span></p>}
          <div className="actions runtime-summary-actions">{detected.readiness === 'repair' && !running && <button type="button" disabled={props.operationDisabled || !loaded || busy || !!statusError} onClick={() => void start(true)}><Download size={15}/>{action === 'start' ? text.starting : text.prepareRuntime}</button>}{running && <button type="button" disabled={busy || canceling} onClick={() => void cancel()}><Square size={13}/>{canceling ? text.canceling : text.cancel}</button>}<button type="button" aria-expanded={detailsOpen} aria-controls="install-runtime-details" onClick={() => setDetailsOpen(value => !value)}><FileText size={15}/>{text.details}</button>{running && logButton}</div>
          {detailsOpen && <dl id="install-runtime-details" className="runtime-summary-facts"><div><dt>{text.revision}</dt><dd><code>{detected.sourceRevision ?? '—'}</code></dd></div><div><dt>{text.python}</dt><dd><code>{detected.pythonPath || '—'}</code></dd></div></dl>}
          {errorBlock}
        </Panel>
        <RuntimeManagementPanel operationDisabled={props.operationDisabled} autoCheck={props.autoCheck} language={props.language} desktop={props.desktop} installationStatus={installation} selectedRuntimeDir={detected.installDir} showInstallations={false}/>
      </> : initial ? <div className="runtime-detecting" role="status"><LoaderCircle size={18} className="spin"/>{text.checking}</div> : loaded && !statusError ? <>
        <ol className="install-runtime-steps" aria-label={text.title}><li className="is-current"><span>1</span>{text.installStep}</li><li><span>2</span>{text.modelStep}</li><li><span>3</span>{text.serviceStep}</li></ol>
        <Panel title={text.installStep} className="install-runtime-card">
          <div className="install-runtime-state" role="status" aria-live="polite">{running || action === 'start' ? <LoaderCircle size={23} className="spin"/> : task?.state === 'failed' ? <CircleAlert size={23}/> : <Download size={23}/>}<div><h3>{action === 'start' ? text.starting : title}</h3><p>{running ? text.runningHint : task?.state === 'failed' || task?.state === 'cancelled' ? text.retryHint : text.noEstimate}</p></div></div>
          {task?.message && <p className="install-runtime-message">{task.message}</p>}
          {installation.taskId && !task && <p className="install-runtime-message">{text.unknownTask}</p>}
          <div className="actions install-runtime-actions">{running ? <button type="button" disabled={busy || canceling} onClick={() => void cancel()}><Square size={14}/>{canceling ? text.canceling : text.cancel}</button> : <button type="button" className="primary" disabled={props.operationDisabled || !loaded || busy} onClick={() => void start()}><Download size={15}/>{task || installation.taskId ? text.retry : text.start}</button>}{logButton}</div>{errorBlock}
        </Panel>
      </> : null}
      {logsOpen && installation.taskId && <Panel title={text.logs} className="install-runtime-log-panel">{logError && <p className="install-runtime-log-error" role="alert">{text.logsUnavailable}: {logError}</p>}<div id="install-runtime-logs" className="install-runtime-logs" role="log" aria-label={text.logs} aria-live="off">{logs.length ? logs.map((entry, index) => <div className="install-runtime-log-line" key={`${entry.timestamp}-${index}`}><time dateTime={new Date(entry.timestamp).toISOString()}>{new Date(entry.timestamp).toLocaleTimeString(props.language)}</time><span className={`install-runtime-log-level ${entry.level}`}>{entry.level}</span><span>{entry.message}</span></div>) : <p>{text.emptyLogs}</p>}</div></Panel>}
    </>}
  </section>;
}
