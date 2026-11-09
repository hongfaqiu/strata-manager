import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, LoaderCircle } from 'lucide-react';
import type { LogEntry, ServiceProfile, TaskStatus } from '@strata-manager/core';
import * as core from '@strata-manager/core';
import { Dialog } from '../components';

interface Props { zh: boolean; profile: ServiceProfile; disabled: boolean }

const gb = (bytes: number) => (bytes / 1e9).toFixed(2);

/**
 * 「下载 DFlash2」: upstream never downloads the drafter on a start (Auto without it runs MTP), so this runs
 * `strata drafting fetch` as a task after a confirmation, with the download progress from its JSON lines.
 */
export function Dflash2Download({ zh, profile, disabled }: Props) {
  const t = (cn: string, en: string) => (zh ? cn : en);
  const client = useQueryClient();
  const key = ['dflash2-status', profile.id, profile.configPath];
  const status = useQuery({ queryKey: key, queryFn: () => core.dflash2Status(profile), retry: false, staleTime: 30_000 });
  const [confirm, setConfirm] = useState(false);
  const [task, setTask] = useState<TaskStatus>();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const taskId = task?.id, state = task?.state;
  useEffect(() => {
    if (!taskId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const [tasks, entries] = await Promise.allSettled([core.listTasks(), core.readTaskLogs(taskId, 500)]);
      if (disposed) return;
      let next = state;
      if (tasks.status === 'fulfilled' && Array.isArray(tasks.value)) { const found = tasks.value.find(item => item.id === taskId); if (found) { setTask(found); next = found.state; } }
      if (entries.status === 'fulfilled' && Array.isArray(entries.value)) setLogs(entries.value);
      if (next === 'running') timer = setTimeout(() => void poll(), 1500);
      else void client.invalidateQueries({ queryKey: key });
    };
    void poll();
    return () => { disposed = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, state]);
  const start = async () => {
    setConfirm(false); setError(''); setLogs([]);
    try { const started = await core.fetchDflash2(profile); if (mounted.current) setTask(started); }
    catch (failure) { if (mounted.current) setError(core.normalizeError(failure).message); }
  };
  const progress = core.dflash2FetchProgress(logs.map(entry => entry.message));
  const running = task?.state === 'running';
  const taskFinishedOk = task?.state === 'completed' && progress.result?.ok === true;
  const copy = core.dflash2DownloadCopy(status.data, zh);
  const tunedUpdate = !taskFinishedOk && copy.tunedUpdate;
  const ready = (status.data?.ready === true && !tunedUpdate) || taskFinishedOk;
  const failed = task && (task.state === 'failed' || progress.result?.ok === false) ? (progress.result?.ok === false ? progress.result.message : task.message) : '';
  if (status.isPending && !task) return null;
  if (ready && !running) return <p className="startup-drafting-hint" role="status" data-testid="dflash2-ready">{t('DFlash2 预测器已下载，下次启动时按当前策略启用。', 'The DFlash2 drafter is downloaded and ready for the next start.')}</p>;
  if (!status.data?.fetchable && !task) return <p className="startup-drafting-hint" data-testid="dflash2-unavailable">{t('此运行环境不能下载 DFlash2（需要 Strata v0.2.10 或更新版本的本机安装）；未下载时将改用 MTP。', 'This runtime cannot download DFlash2 (it needs a local Strata v0.2.10 or newer install); without it Strata runs MTP.')}</p>;
  const percent = progress.total && progress.done !== undefined ? Math.min(100, Math.round(progress.done / progress.total * 100)) : undefined;
  return <div className="dflash2-download" data-testid="dflash2-download">
    {!running && <div className="dflash2-download-row">
      <span className="startup-drafting-hint">{copy.statusHint}</span>
      <button type="button" data-testid="dflash2-download-button" disabled={disabled} onClick={() => setConfirm(true)}><Download size={14}/>{copy.buttonLabel}</button>
    </div>}
    {running && <div className="dflash2-download-progress" role="status" data-testid="dflash2-download-progress">
      <span><LoaderCircle size={14} className="spin"/>{progress.total ? t(`正在下载 DFlash2：${gb(progress.done ?? 0)} / ${gb(progress.total)} GB（${percent}%）`, `Downloading DFlash2: ${gb(progress.done ?? 0)} of ${gb(progress.total)} GB (${percent}%)`) : t('正在准备下载 DFlash2…', 'Preparing the DFlash2 download…')}</span>
      <progress max={100} value={percent ?? undefined} aria-label={t('DFlash2 下载进度', 'DFlash2 download progress')}/>
      <button type="button" onClick={() => { if (taskId) void core.cancelTask(taskId).catch(failure => setError(core.normalizeError(failure).message)); }}>{t('取消', 'Cancel')}</button>
    </div>}
    {task?.state === 'cancelled' && <p className="startup-drafting-hint" role="status">{t('已取消下载；未完成前继续使用已有预测器或 MTP。', 'Download cancelled; until it finishes, the existing drafter or MTP is used.')}</p>}
    {(failed || error) && <p className="runtime-config-error" role="alert" data-testid="dflash2-download-error">{t('DFlash2 下载失败：', 'DFlash2 download failed: ')}{error || failed}</p>}
    {confirm && <Dialog title={t('下载 DFlash2 预测器', 'Download the DFlash2 drafter')} onClose={() => setConfirm(false)}>
      <div className="setup-tuning-help-content" data-testid="dflash2-confirm">
        <p>{copy.confirmSourceParagraph}</p>
        <p>{copy.confirmFolderParagraph}</p>
        <div className="dflash2-confirm-actions"><button type="button" onClick={() => setConfirm(false)}>{t('取消', 'Cancel')}</button><button type="button" className="primary" data-testid="dflash2-confirm-download" onClick={() => void start()}>{t('下载', 'Download')}</button></div>
      </div>
    </Dialog>}
  </div>;
}
