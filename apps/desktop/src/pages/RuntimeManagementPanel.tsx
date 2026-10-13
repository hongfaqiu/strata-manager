import type { AppLanguage } from "@strata-manager/core";
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircle, Download, ExternalLink, LoaderCircle, RefreshCw, Square } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import * as core from '@strata-manager/core';
import { Panel } from '../components';
import { releaseNotes } from '../updateReleaseNotes';
import { RuntimeUpdateDialog } from './RuntimeUpdateDialog';
import { RuntimeDownloadSettings } from './RuntimeDownloadSettings';
import './install-runtime.css';

interface Props {
  language: AppLanguage; desktop: boolean; onInstall?: () => void;
  selectedRuntimeDir?: string; showInstallations?: boolean;
  installationStatus?: core.RuntimeInstallationStatus;
  autoCheck?: boolean;
  operationDisabled?: boolean;
  onUpdateStarted?: () => void;
}
const labels = {
  'zh-CN': {
    title: 'Strata 更新', current: '本机版本', latest: '最新版本', check: '检查更新', checking: '检查中…', unknown: '—',
    notes: '更新日志', published: '发布于', upstream: '官方发布', update: '更新至', install: '安装 Strata', noRuntime: '未安装',
    updating: '正在更新', completed: '更新完成', ready: '已安装', repair: '需要修复', failed: '更新失败',
    package: '更新包', automaticPackage: '自动匹配当前环境', latestInstalled: '已是最新版本', noPackage: '当前平台暂无更新包', cancel: '取消更新', logs: '下载与安装日志',
  },
  en: {
    title: 'Strata updates', current: 'Installed version', latest: 'Latest version', check: 'Check for updates', checking: 'Checking…', unknown: '—',
    notes: 'Release notes', published: 'Published', upstream: 'Official release', update: 'Update to', install: 'Install Strata', noRuntime: 'Not installed',
    updating: 'Updating', completed: 'Update complete', ready: 'Installed', repair: 'Needs repair', failed: 'Update failed',
    package: 'Update package', automaticPackage: 'Match the current runtime', latestInstalled: 'Up to date', noPackage: 'No package for this platform', cancel: 'Cancel update', logs: 'Download and installation logs',
  },
} as const;
function needsUpdate(current: string | undefined, latest: string | undefined) {
  if (!latest) return false;
  if (!current) return true;
  const numbers = (value: string) => /^v?\d+(\.\d+)*$/.test(value) ? value.replace(/^v/, '').split('.').map(Number) : undefined;
  const a = numbers(current), b = numbers(latest);
  if (!a || !b) return current !== latest;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) < (b[index] ?? 0);
  }
  return false;
}

export function RuntimeManagementPanel({ language, desktop, onInstall, selectedRuntimeDir, showInstallations = true, installationStatus, autoCheck = true, operationDisabled = false, onUpdateStarted }: Props) {
  const text = labels[(language === 'zh-CN' ? 'zh-CN' : 'en')]; const query = useQueryClient();
  const [checking, setChecking] = useState(false), [starting, setStarting] = useState(''), [actionError, setActionError] = useState('');
  const [taskLogs, setTaskLogs] = useState<core.LogEntry[]>([]);
  const [taskId, setTaskId] = useState(''); const observedTask = useRef('');
  const [pending,setPending] = useState<{ runtime: core.DetectedRuntime; release: core.RuntimeUpdateInfo } | null>(null);
  const startingRef = useRef(false);
  const installation = useQuery({ queryKey: ['runtime-installation'], queryFn: core.localRuntimeInstallation, enabled: desktop && !installationStatus, refetchInterval: 10000 });
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: core.listTasks, enabled: desktop, refetchInterval: 2000 });
  const update = useQuery({ queryKey: ['runtime-update-info'], queryFn: () => core.runtimeUpdateInfo(), enabled: desktop && autoCheck, staleTime: 12 * 60 * 60 * 1000, refetchInterval: autoCheck ? 12 * 60 * 60 * 1000 : false, refetchOnWindowFocus: autoCheck });
  const downloadPreferences = useQuery({ queryKey: ['runtime-download-preferences'], queryFn: core.getRuntimeDownloadPreferences, enabled: desktop, staleTime: Infinity, retry: false });
  const activeTask = tasks.data?.find(task => task.state === 'running' && task.kind === 'update');
  const lastTask = tasks.data?.find(task => task.id === taskId);
  const status = installationStatus ?? installation.data, result = status?.result;
  const allRuntimes: core.DetectedRuntime[] = status?.detectedRuntimes ?? (result ? [{ installDir: result.installDir, pythonPath: result.pythonPath, sourceRevision: result.sourceRevision, readiness: 'ready', profile: result.profile }] : []);
  const runtimes = selectedRuntimeDir ? allRuntimes.filter(runtime => runtime.installDir === selectedRuntimeDir) : allRuntimes;
  const updateTargets = runtimes.filter(runtime => needsUpdate(runtime.runtimeVersion, update.data?.latestVersion));
  const installed = allRuntimes.length > 0;
  const notes = releaseNotes(update.data?.notes);
  useEffect(() => {
    if (activeTask) { observedTask.current = activeTask.id; setTaskId(activeTask.id); }
    else if (observedTask.current) {
      observedTask.current = '';
      void query.invalidateQueries({ queryKey: ['runtime-installation'] });
      void query.invalidateQueries({ queryKey: ['localInstallationDetails'] });
      void query.invalidateQueries({ queryKey: ['process'] });
    }
  }, [activeTask?.id, query]);
  useEffect(() => {
    if (!activeTask) return;
    let stopped = false;
    const refresh = () => { void core.readTaskLogs(activeTask.id, 40).then(logs => { if (!stopped) setTaskLogs(logs); }).catch(() => {}); };
    refresh(); const timer = window.setInterval(refresh, 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [activeTask?.id]);
  const check = async () => {
    if (checking) return;
    setChecking(true); setActionError('');
    try { query.setQueryData(['runtime-update-info'], await core.runtimeUpdateInfo(true)); await query.invalidateQueries({ queryKey: ['runtime-installation'] }); }
    catch (error) { setActionError(core.normalizeError(error).message); }
    finally { setChecking(false); }
  };
  const installUpdate = async (download: core.RuntimeZipDownloadOptions = {}, selectedAssetName?: string) => {
    if (operationDisabled || !pending || !downloadPreferences.isSuccess || startingRef.current || activeTask || tasks.data?.some(task => task.state === 'running')) return;
    const latest = update.data;
    if (!latest?.installable || update.isFetching) return;
    if (latest.checkedAt !== pending.release.checkedAt || latest.latestVersion !== pending.release.latestVersion) {
      setPending({ ...pending, release: latest }); setActionError(''); return;
    }
    const runtime = pending.runtime;
    startingRef.current = true;
    setStarting(runtime.installDir); setActionError(''); setTaskLogs([]);
    try {
      const freshTasks = await core.listTasks();
      if (freshTasks.some(task => task.state === 'running')) throw new Error(language === 'zh-CN' ? '有任务正在进行，请完成后再确认更新。' : 'A task is in progress. Confirm the update again when it finishes.');
      const task = await core.updateRuntimeZip(runtime.installDir, selectedAssetName, true, download);
      setTaskId(task.id); observedTask.current = task.id;
      await query.invalidateQueries({ queryKey: ['tasks'] }); setPending(null);
      onUpdateStarted?.();
    }
    catch (error) { setActionError(core.normalizeError(error).message); }
    finally { startingRef.current = false; setStarting(''); }
  };
  const cancel = async () => {
    if (!activeTask) return;
    try { await core.cancelTask(activeTask.id); await query.invalidateQueries({ queryKey: ['tasks'] }); }
    catch (error) { setActionError(core.normalizeError(error).message); }
  };
  const savedDownload = pending && downloadPreferences.data ? core.resolveRuntimeDownloadPreferences(downloadPreferences.data, pending.release) : undefined;
  const updateButton = (runtime: core.DetectedRuntime) => <button type="button" className="primary" key={runtime.installDir} disabled={operationDisabled || !desktop || !downloadPreferences.isSuccess || !update.data?.installable || !!starting || !!activeTask} onClick={() => { if (update.data && downloadPreferences.isSuccess) { setActionError(''); setPending({ runtime, release: update.data }); } }}><ArrowUpCircle size={15}/>{starting === runtime.installDir ? text.updating : `${text.update} ${update.data?.latestVersion ?? ''}`}</button>;
  return <Panel title={text.title} className="runtime-management">
    <div className="runtime-version-grid">
      <div><span>{text.current}</span><strong>{runtimes.map(runtime => runtime.runtimeVersion).filter(Boolean).filter((version, index, all) => all.indexOf(version) === index).join(' / ') || (installed ? text.ready : text.noRuntime)}</strong></div>
      <div><span>{text.latest}</span><strong>{update.data?.latestVersion ?? (update.isLoading ? text.checking : text.unknown)}</strong>{installed && update.data?.latestVersion && !updateTargets.length && <small className="runtime-ready">{text.latestInstalled}</small>}</div>
    </div>
    {(installation.error || update.error || update.data?.error) && <p className="notice error" role="alert">{core.normalizeError(installation.error ?? update.error ?? update.data?.error).message}</p>}
    <div className="actions">{!installed && onInstall && <button type="button" className="primary" onClick={onInstall}><Download size={15}/>{text.install}</button>}{!showInstallations && updateTargets.map(updateButton)}<button type="button" disabled={!desktop || checking || update.isFetching} onClick={() => void check()}>{checking || update.isFetching ? <LoaderCircle size={15} className="spin"/> : <RefreshCw size={15}/>} {text.check}</button>{update.data?.releaseUrl && <a className="runtime-release-link" href={update.data.releaseUrl} target="_blank" rel="noreferrer"><ExternalLink size={14}/>{text.upstream}</a>}{installed && updateTargets.length > 0 && !update.isLoading && !update.data?.installable && !update.data?.error && <span className="subtle">{text.noPackage}</span>}</div>
    {showInstallations && !!runtimes.length && <div className="runtime-installed-list">{runtimes.map(runtime => <div className="runtime-installed-item" key={runtime.installDir}><div><strong>{runtime.runtimeVersion ? `Strata ${runtime.runtimeVersion}` : 'Strata'}</strong><span className={runtime.readiness === 'ready' ? 'runtime-ready' : 'runtime-repair'}>{runtime.readiness === 'ready' ? text.ready : text.repair}</span><code>{runtime.installDir}</code></div>{needsUpdate(runtime.runtimeVersion, update.data?.latestVersion) && updateButton(runtime)}</div>)}</div>}
    {activeTask && <div className="runtime-update-progress" role="status"><LoaderCircle className="spin" size={16}/><div><strong>{activeTask.message || text.updating}</strong>{taskLogs.length > 0 && <details><summary>{text.logs}</summary><pre>{taskLogs.map(entry => entry.message).join('\n')}</pre></details>}<button type="button" onClick={() => void cancel()}><Square size={13}/>{text.cancel}</button></div></div>}
    {lastTask?.state === 'completed' && <p className="runtime-update-result runtime-ready" role="status">{text.completed}</p>}
    {lastTask?.state === 'failed' && <p className="notice error" role="alert">{text.failed}: {lastTask.message}</p>}
    {actionError && <p className="notice error" role="alert">{actionError}</p>}
    <RuntimeDownloadSettings language={language} desktop={desktop} runtime={runtimes[0]} release={update.data} releaseLoading={update.isLoading || update.isFetching}/>
    {notes && update.data && <details className="runtime-release-notes"><summary>{text.notes} · {update.data.releaseName ?? update.data.latestVersion}</summary>{update.data.publishedAt && <p className="subtle">{text.published} {new Date(update.data.publishedAt).toLocaleDateString(language)}</p>}<div className="runtime-release-body" tabIndex={0} role="region" aria-label={text.notes}><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ node: _node, title, children, ...props }) => <a {...props} data-tooltip={title} target="_blank" rel="noreferrer">{children}</a>, img: ({ node: _node, title, ...props }) => <img {...props} data-tooltip={title}/> }}>{notes}</ReactMarkdown></div></details>}
    {pending && <RuntimeUpdateDialog language={language} runtime={pending.runtime} release={pending.release} assetName={savedDownload?.assetName} initialDownload={savedDownload?.download} initialPreferences={downloadPreferences.data} busy={!!starting} canConfirm={!operationDisabled && desktop && downloadPreferences.isSuccess && !!tasks.data && !tasks.data.some(task => task.state === 'running') && !update.isFetching && !!update.data?.installable} error={actionError} onConfirm={(download, selectedAssetName) => { void installUpdate(download, selectedAssetName); }} onDismiss={() => { if (!startingRef.current) { setPending(null); setActionError(''); } }}/>}
  </Panel>;
}
