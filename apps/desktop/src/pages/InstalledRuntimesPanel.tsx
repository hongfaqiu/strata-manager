// 「已安装版本」: every Strata version on this machine, switching between them without a
// download, deleting old ones and 一键清理. The background service decides what is protected
// and re-checks every deletion; this view explains it and asks for confirmation.
import type { AppLanguage } from '@strata-manager/core';
import * as core from '@strata-manager/core';
import { useEffect, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, Repeat2, Trash2 } from 'lucide-react';
import { Dialog, Panel } from '../components';
import { Checkbox } from '../OfficialControls';
import './installed-runtimes.css';

const zh = {
  title: '已安装版本', summary: '{{count}} 个版本 · 共 {{size}}', cleanup: '一键清理', cleanupFree: '一键清理 · 可释放 {{size}}', nothingToClean: '没有可清理的旧版本',
  current: '当前使用', rollback: '可回退', referenced: '被 {{count}} 个配置引用', switching: '正在切换', repair: '需要修复', foreign: '自行安装',
  size: '占用 {{size}}', installedAt: '安装于 {{date}}', lastUsed: '上次使用 {{date}}',
  switch: '切换到此版本', delete: '删除', switchBusy: '有任务进行中，完成后可切换', notReady: '这个版本不完整，需要修复后才能切换',
  autoCleanup: '更新成功后自动清理旧版本', autoCleanupHint: '更新或切换成功后，自动删除 Manager 安装的更早版本，只保留当前版本和上一个版本，方便随时切回。你自己选择的 Strata 目录、仍被配置使用的版本、模型和共享数据都不会删除。',
  leftovers: '另有 {{count}} 项下载残留或失败的安装可清理',
  kind: { partialDownload: '未完成的下载', archive: '已下载的安装包', failedInstall: '安装失败的目录', trash: '未删完的旧版本', updateWork: '更新失败留下的临时文件' },
  cancel: '取消', deleting: '正在删除…', cleaning: '正在清理…', switchingStart: '正在开始切换…',
  deleteTitle: '删除 {{version}}', deleteBody: '只删除这个版本的程序目录。模型、共享数据和其它版本不受影响。', deleteFree: '将释放 {{size}}',
  deleteProfiles: '以下配置仍在使用这个版本，它们的配置文件在此目录中，会一起删除：', deleteProfilesConfirm: '我确认同时删除这些配置',
  deleteConfirm: '删除', cleanupTitle: '一键清理', cleanupBody: '将删除以下内容，保留当前版本和一个可回退的版本。删除前会再次核对，正在使用或被配置引用的版本不会删除。',
  cleanupKeep: '保留', cleanupTotal: '共释放 {{size}}', cleanupConfirm: '清理', cleanupDone: '已清理 {{count}} 项，释放 {{size}}', cleanupSkipped: '{{count}} 项未删除：',
  deleted: '已删除，释放 {{size}}',
  switchTitle: '切换到 {{version}}', switchLocal: '使用本机已安装的副本，无需下载。', switchSteps: '会停止正在运行的服务，把配置移到这个版本，再启动并检查服务是否正常；任一步失败会自动恢复当前版本。',
  switchKeep: '当前的 {{version}} 会保留，之后可以随时切换回来。', switchConfirm: '切换', from: '当前', to: '切换到',
};
const en: typeof zh = {
  title: 'Installed versions', summary: '{{count}} versions · {{size}} total', cleanup: 'Clean up', cleanupFree: 'Clean up · frees {{size}}', nothingToClean: 'No old versions to clean up',
  current: 'In use', rollback: 'Rollback', referenced: 'Used by {{count}} configurations', switching: 'Switching', repair: 'Needs repair', foreign: 'Your folder',
  size: '{{size}}', installedAt: 'Installed {{date}}', lastUsed: 'Last used {{date}}',
  switch: 'Switch to this version', delete: 'Delete', switchBusy: 'A task is running; switch when it finishes', notReady: 'This version is incomplete; repair it before switching',
  autoCleanup: 'Clean up old versions after a successful update', autoCleanupHint: 'After an update or switch succeeds, older versions installed by Manager are deleted, keeping the current one and the previous one to switch back to. Folders you chose yourself, versions still used by configurations, models and shared data are never deleted.',
  leftovers: '{{count}} leftover downloads or failed installations can be cleaned up',
  kind: { partialDownload: 'Unfinished download', archive: 'Downloaded package', failedInstall: 'Failed installation', trash: 'Partly deleted version', updateWork: 'Files left by a failed update' },
  cancel: 'Cancel', deleting: 'Deleting…', cleaning: 'Cleaning up…', switchingStart: 'Starting switch…',
  deleteTitle: 'Delete {{version}}', deleteBody: 'Only this version’s program folder is deleted. Models, shared data and other versions are not affected.', deleteFree: 'Frees {{size}}',
  deleteProfiles: 'These configurations still use this version; their files are in this folder and are deleted with it:', deleteProfilesConfirm: 'Also delete these configurations',
  deleteConfirm: 'Delete', cleanupTitle: 'Clean up', cleanupBody: 'The items below are deleted; the current version and one to switch back to are kept. Each item is checked again first; versions in use or used by configurations are not deleted.',
  cleanupKeep: 'Kept', cleanupTotal: 'Frees {{size}}', cleanupConfirm: 'Clean up', cleanupDone: 'Cleaned {{count}} items, freed {{size}}', cleanupSkipped: '{{count}} items were not deleted:',
  deleted: 'Deleted, freed {{size}}',
  switchTitle: 'Switch to {{version}}', switchLocal: 'Uses the copy already on this machine; nothing is downloaded.', switchSteps: 'Running services are stopped, configurations move to this version, then the service is started and checked; if any step fails the current version is restored.',
  switchKeep: 'The current {{version}} is kept, so you can switch back at any time.', switchConfirm: 'Switch', from: 'Current', to: 'Switch to',
};
export const installedRuntimesCopy = (language: AppLanguage) => core.legacyLanguage(language) === 'zh-CN' ? zh : en;
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values[key] ?? ''));
const INVENTORY = ['runtime-installed-versions'];

export function useInstalledRuntimes(desktop: boolean, refetch = true) {
  return useQuery({ queryKey: INVENTORY, queryFn: core.installedRuntimes, enabled: desktop, refetchInterval: refetch ? 10000 : false, retry: false });
}
function useReleaseList(desktop: boolean) {
  return useQuery({ queryKey: ['runtime-release-versions'], queryFn: () => core.runtimeReleaseVersions(), enabled: desktop, staleTime: 6 * 60 * 60 * 1000, retry: false, refetchOnWindowFocus: false }).data?.versions ?? [];
}
function useSizes(paths: string[], desktop: boolean) {
  const results = useQueries({ queries: paths.map(path => ({ queryKey: ['runtime-installed-size', path], queryFn: () => core.installedRuntimeSize(path), enabled: desktop, staleTime: 5 * 60 * 1000, retry: false })) });
  return Object.fromEntries(paths.map((path, index) => [path, results[index]?.data])) as Record<string, number | undefined>;
}

/** Release v0.2.2 · 引擎 0.1.47, falling back to the folder name. */
export function installedRuntimeLabel(runtime: core.InstalledRuntime, releases: Parameters<typeof core.installedRuntimeRelease>[1], zhText: boolean) {
  return core.runtimeVersionLabel({ release: core.installedRuntimeRelease(runtime, releases), engine: runtime.engineVersion }, zhText) || runtime.installDir.split(/[\\/]/).filter(Boolean).at(-1) || 'Strata';
}

export interface RuntimeSwitchDialogProps {
  language: AppLanguage; target: core.InstalledRuntime; current?: core.InstalledRuntime;
  releases?: Parameters<typeof core.installedRuntimeRelease>[1];
  busy?: boolean; error?: string; onConfirm: () => void; onDismiss: () => void;
}
export function RuntimeSwitchDialog({ language, target, current, releases = [], busy = false, error, onConfirm, onDismiss }: RuntimeSwitchDialogProps) {
  const t = installedRuntimesCopy(language), z = core.legacyLanguage(language) === 'zh-CN';
  const targetLabel = installedRuntimeLabel(target, releases, z), currentLabel = current ? installedRuntimeLabel(current, releases, z) : '';
  return <Dialog title={fill(t.switchTitle, { version: targetLabel })} onClose={() => { if (!busy) onDismiss(); }}>
    <div className="installed-runtime-dialog" data-testid="runtime-switch-dialog">
      <dl className="installed-runtime-dialog-pair">{current && <div><dt>{t.from}</dt><dd>{currentLabel}</dd></div>}<div><dt>{t.to}</dt><dd>{targetLabel}</dd></div></dl>
      <code>{target.installDir}</code>
      <p className="installed-runtime-dialog-lead">{t.switchLocal}</p>
      <p>{t.switchSteps}</p>
      {current && <p className="installed-runtime-dialog-note">{fill(t.switchKeep, { version: currentLabel })}</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="installed-runtime-dialog-actions"><button type="button" disabled={busy} onClick={onDismiss}>{t.cancel}</button><button type="button" className="primary" disabled={busy} onClick={onConfirm}>{busy ? <LoaderCircle size={15} className="spin"/> : <Repeat2 size={15}/>}{busy ? t.switchingStart : t.switchConfirm}</button></div>
    </div>
  </Dialog>;
}

/** Starts a switch to an installed version and reports the task through the shared task list. */
export function useRuntimeSwitch(onStarted?: () => void) {
  const query = useQueryClient();
  const [target, setTarget] = useState<core.InstalledRuntime | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const confirm = async () => {
    if (!target || busy) return;
    setBusy(true); setError('');
    try {
      await core.switchInstalledRuntime(target.installDir);
      await Promise.all([query.invalidateQueries({ queryKey: ['tasks'] }), query.invalidateQueries({ queryKey: INVENTORY })]);
      setTarget(null); onStarted?.();
    } catch (cause) { setError(core.normalizeError(cause).message); }
    finally { setBusy(false); }
  };
  return { target, busy, error, open: (runtime: core.InstalledRuntime) => { setError(''); setTarget(runtime); }, dismiss: () => { if (!busy) { setTarget(null); setError(''); } }, confirm };
}

interface Props { language: AppLanguage; desktop: boolean; operationDisabled?: boolean; onSwitchStarted?: () => void }
export function InstalledRuntimesPanel({ language, desktop, operationDisabled = false, onSwitchStarted }: Props) {
  const t = installedRuntimesCopy(language), z = core.legacyLanguage(language) === 'zh-CN';
  const query = useQueryClient();
  const inventory = useInstalledRuntimes(desktop);
  const releases = useReleaseList(desktop);
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: core.listTasks, enabled: desktop, refetchInterval: 2000 });
  const taskRunning = !!tasks.data?.some(task => task.state === 'running');
  const runtimes = core.sortInstalledRuntimes(inventory.data?.runtimes ?? [], releases);
  const leftovers = inventory.data?.leftovers ?? [];
  const sizes = useSizes([...runtimes.map(runtime => runtime.installDir), ...leftovers.map(item => item.path)], desktop);
  const cleanupPaths = core.cleanupPaths(inventory.data);
  const cleanupBytes = core.totalBytes(cleanupPaths, sizes);
  const allBytes = core.totalBytes(runtimes.map(runtime => runtime.installDir), sizes);
  const current = runtimes.find(runtime => runtime.current);
  const busy = operationDisabled || taskRunning || !!inventory.data?.busy;
  const switcher = useRuntimeSwitch(onSwitchStarted);
  const [deleting, setDeleting] = useState<core.InstalledRuntime | null>(null), [confirmProfiles, setConfirmProfiles] = useState(false);
  const [cleaning, setCleaning] = useState(false), [working, setWorking] = useState(false), [dialogError, setDialogError] = useState('');
  const [result, setResult] = useState(''), [skipped, setSkipped] = useState<{ path: string; reason: string }[]>([]);
  const [autoCleanup, setAutoCleanup] = useState<boolean | undefined>(undefined), [settingError, setSettingError] = useState('');
  const date = (ms?: number) => ms ? new Date(ms).toLocaleDateString(language) : '';
  const bytes = (path: string) => core.formatRuntimeBytes(sizes[path]);
  const wasRunning = useLatch(taskRunning);
  useEffect(() => { if (wasRunning) void query.invalidateQueries({ queryKey: INVENTORY }); }, [wasRunning, query]);
  const refreshAfterDelete = async (paths: string[]) => {
    await query.invalidateQueries({ queryKey: INVENTORY });
    for (const path of paths) query.removeQueries({ queryKey: ['runtime-installed-size', path] });
    await query.invalidateQueries({ queryKey: ['runtime-installation'] });
  };
  const closeDialogs = () => { if (working) return; setDeleting(null); setCleaning(false); setConfirmProfiles(false); setDialogError(''); };
  const remove = async () => {
    if (!deleting || working) return;
    setWorking(true); setDialogError('');
    try {
      const freed = await core.deleteInstalledRuntime(deleting.installDir, confirmProfiles ? deleting.profiles.map(profile => profile.id) : []);
      setResult(fill(t.deleted, { size: core.formatRuntimeBytes(freed) })); setSkipped([]);
      await refreshAfterDelete([deleting.installDir]); setDeleting(null); setConfirmProfiles(false);
    } catch (cause) { setDialogError(core.normalizeError(cause).message); }
    finally { setWorking(false); }
  };
  const clean = async () => {
    if (working) return;
    setWorking(true); setDialogError('');
    try {
      const outcome = await core.cleanupInstalledRuntimes(cleanupPaths);
      setResult(fill(t.cleanupDone, { count: outcome.removed.length, size: core.formatRuntimeBytes(outcome.freedBytes) })); setSkipped(outcome.skipped);
      await refreshAfterDelete(outcome.removed); setCleaning(false);
    } catch (cause) { setDialogError(core.normalizeError(cause).message); }
    finally { setWorking(false); }
  };
  const toggleAutoCleanup = async (value: boolean) => {
    setSettingError(''); setAutoCleanup(value);
    try { await core.saveStore(core.RUNTIME_AUTO_CLEANUP_KEY, value); await query.invalidateQueries({ queryKey: INVENTORY }); }
    catch (cause) { setAutoCleanup(!value); setSettingError(core.normalizeError(cause).message); }
  };
  const autoCleanupOn = autoCleanup ?? inventory.data?.autoCleanup ?? true;
  const kept = runtimes.filter(runtime => !runtime.cleanup);
  const action = runtimes.length > 0 && <button type="button" data-testid="runtime-cleanup" disabled={!desktop || busy || !cleanupPaths.length} onClick={() => { setDialogError(''); setCleaning(true); }}>
    <Trash2 size={14}/>{cleanupPaths.length ? cleanupBytes !== undefined && cleanupBytes > 0 ? fill(t.cleanupFree, { size: core.formatRuntimeBytes(cleanupBytes) }) : t.cleanup : t.nothingToClean}
  </button>;
  if (!desktop) return null;
  return <Panel title={t.title} className="installed-runtimes" action={action || undefined}>
    {runtimes.length > 0 && <p className="installed-runtimes-summary">{fill(t.summary, { count: runtimes.length, size: core.formatRuntimeBytes(allBytes) })}</p>}
    {inventory.error && <p className="notice error" role="alert">{core.normalizeError(inventory.error).message}</p>}
    {inventory.isPending && <p className="installed-runtimes-summary" role="status"><LoaderCircle size={14} className="spin"/></p>}
    <ul className="installed-runtimes-list" data-testid="installed-runtimes">
      {runtimes.map(runtime => {
        const label = installedRuntimeLabel(runtime, releases, z);
        const switchBlocked = runtime.readiness !== 'ready' ? t.notReady : busy ? t.switchBusy : '';
        return <li key={runtime.installDir} className={runtime.current ? 'is-current' : undefined} data-testid="installed-runtime">
          <div className="installed-runtime-main">
            <div className="installed-runtime-head"><strong>{label}</strong>
              {runtime.current && <span className="installed-runtime-tag is-current">{t.current}</span>}
              {runtime.switching && <span className="installed-runtime-tag is-current">{t.switching}</span>}
              {runtime.rollback && !runtime.current && <span className="installed-runtime-tag">{t.rollback}</span>}
              {runtime.profiles.length > 0 && !runtime.current && <span className="installed-runtime-tag" data-tooltip={runtime.profiles.map(profile => profile.name).join('、')}>{fill(t.referenced, { count: runtime.profiles.length })}</span>}
              {runtime.readiness !== 'ready' && <span className="installed-runtime-tag is-warn">{t.repair}</span>}
              {!runtime.owned && <span className="installed-runtime-tag">{t.foreign}</span>}
            </div>
            <code>{runtime.installDir}</code>
            <small>{[fill(t.size, { size: bytes(runtime.installDir) }), runtime.installedAt && fill(t.installedAt, { date: date(runtime.installedAt) }), runtime.lastUsedAt && !runtime.current && fill(t.lastUsed, { date: date(runtime.lastUsedAt) })].filter(Boolean).join(' · ')}</small>
            {runtime.protectedReason && !runtime.current && <small className="installed-runtime-reason">{runtime.protectedReason}</small>}
          </div>
          <div className="installed-runtime-actions">
            {!runtime.current && <button type="button" disabled={!!switchBlocked} data-tooltip={switchBlocked || undefined} onClick={() => switcher.open(runtime)}><Repeat2 size={14}/>{t.switch}</button>}
            {!runtime.current && <button type="button" className="installed-runtime-delete" disabled={busy || !!runtime.protectedReason} data-tooltip={runtime.protectedReason || undefined} onClick={() => { setDialogError(''); setConfirmProfiles(false); setDeleting(runtime); }}>{t.delete}</button>}
          </div>
        </li>;
      })}
    </ul>
    {leftovers.length > 0 && <p className="installed-runtimes-leftovers">{fill(t.leftovers, { count: leftovers.length })}</p>}
    <label className="installed-runtimes-setting">
      <Checkbox checked={autoCleanupOn} disabled={!desktop} onChange={event => void toggleAutoCleanup(event.target.checked)}/>
      <span><strong>{t.autoCleanup}</strong><small>{t.autoCleanupHint}</small></span>
    </label>
    {settingError && <p className="notice error" role="alert">{settingError}</p>}
    {result && <p className="installed-runtimes-result" role="status">{result}</p>}
    {skipped.length > 0 && <div className="notice warning" role="status"><strong>{fill(t.cleanupSkipped, { count: skipped.length })}</strong>{skipped.map(item => <p key={item.path}><code>{item.path}</code> {item.reason}</p>)}</div>}
    {switcher.target && <RuntimeSwitchDialog language={language} target={switcher.target} current={current} releases={releases} busy={switcher.busy} error={switcher.error} onConfirm={() => void switcher.confirm()} onDismiss={switcher.dismiss}/>}
    {deleting && <Dialog title={fill(t.deleteTitle, { version: installedRuntimeLabel(deleting, releases, z) })} onClose={closeDialogs}>
      <div className="installed-runtime-dialog" data-testid="runtime-delete-dialog">
        <code>{deleting.installDir}</code>
        <p className="installed-runtime-dialog-lead">{fill(t.deleteFree, { size: bytes(deleting.installDir) })}</p>
        <p>{t.deleteBody}</p>
        {deleting.profiles.length > 0 && <div className="notice warning"><div className="installed-runtime-notice-body"><p>{t.deleteProfiles}</p><ul>{deleting.profiles.map(profile => <li key={profile.id}>{profile.name}</li>)}</ul>
          <label className="installed-runtime-confirm"><Checkbox checked={confirmProfiles} onChange={event => setConfirmProfiles(event.target.checked)}/>{t.deleteProfilesConfirm}</label></div></div>}
        {dialogError && <p className="notice error" role="alert">{dialogError}</p>}
        <div className="installed-runtime-dialog-actions"><button type="button" disabled={working} onClick={closeDialogs}>{t.cancel}</button><button type="button" className="danger" disabled={working || busy || deleting.profiles.length > 0 && !confirmProfiles} onClick={() => void remove()}>{working ? <><LoaderCircle size={15} className="spin"/>{t.deleting}</> : t.deleteConfirm}</button></div>
      </div>
    </Dialog>}
    {cleaning && <Dialog title={t.cleanupTitle} onClose={closeDialogs}>
      <div className="installed-runtime-dialog" data-testid="runtime-cleanup-dialog">
        <p className="installed-runtime-dialog-lead">{fill(t.cleanupTotal, { size: core.formatRuntimeBytes(cleanupBytes) })}</p>
        <p>{t.cleanupBody}</p>
        <ul className="installed-runtime-cleanup-list">
          {runtimes.filter(runtime => runtime.cleanup).map(runtime => <li key={runtime.installDir}><span><strong>{installedRuntimeLabel(runtime, releases, z)}</strong><code>{runtime.installDir}</code></span><em>{bytes(runtime.installDir)}</em></li>)}
          {leftovers.map(item => <li key={item.path}><span><strong>{t.kind[item.kind]}</strong><code>{item.path}</code></span><em>{bytes(item.path)}</em></li>)}
        </ul>
        {kept.length > 0 && <p className="installed-runtime-dialog-note">{t.cleanupKeep}：{kept.map(runtime => installedRuntimeLabel(runtime, releases, z)).join('、')}</p>}
        {dialogError && <p className="notice error" role="alert">{dialogError}</p>}
        <div className="installed-runtime-dialog-actions"><button type="button" disabled={working} onClick={closeDialogs}>{t.cancel}</button><button type="button" className="danger" disabled={working || busy || !cleanupPaths.length} onClick={() => void clean()}>{working ? <><LoaderCircle size={15} className="spin"/>{t.cleaning}</> : t.cleanupConfirm}</button></div>
      </div>
    </Dialog>}
  </Panel>;
}

/** True for one render after `value` goes from true to false. */
function useLatch(value: boolean) {
  const [previous, setPrevious] = useState(value);
  const fell = previous && !value;
  if (previous !== value) setPrevious(value);
  return fell;
}
