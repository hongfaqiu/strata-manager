import { ArrowUpCircle, LoaderCircle } from 'lucide-react';
import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useQuery } from '@tanstack/react-query';
import * as core from '@strata-manager/core';
import type { DetectedRuntime, RuntimeUpdateInfo } from '@strata-manager/core';
import { Dialog } from '../components';
import { releaseNotes } from '../updateReleaseNotes';
import './runtime-update-dialog.css';

export interface RuntimeUpdateDialogProps {
  language: 'zh-CN' | 'en'; runtime: DetectedRuntime; release: RuntimeUpdateInfo;
  onConfirm: () => void; onDismiss: () => void;
  busy?: boolean; canConfirm?: boolean; error?: string;
}

export function RuntimeUpdateDialog({ language, runtime, release, onConfirm, onDismiss, busy = false, canConfirm = true, error }: RuntimeUpdateDialogProps) {
  const zh = language === 'zh-CN';
  const notes = releaseNotes(release.notes);
  const services = useQuery({
    queryKey: ['runtime-update-services', runtime.installDir],
    queryFn: async () => {
      const profiles = (await core.localInstallations()).filter(item => core.configurationPathKey(item.installDir) === core.configurationPathKey(runtime.installDir));
      const statuses = await Promise.all(profiles.map(async profile => ({ profile, status: await core.serviceStatus(profile.id, profile) })));
      return statuses.filter(item => item.status.running);
    },
    enabled: core.isDesktop(), refetchInterval: busy ? false : 5000, retry: false,
  });
  const checkingServices = core.isDesktop() && !services.isSuccess;
  const willStop = !!services.data?.length;
  const confirming = useRef(false);
  useEffect(() => { if (!busy) confirming.current = false; }, [busy, error, release.checkedAt, runtime.installDir]);
  const confirm = () => {
    if (confirming.current || busy || !canConfirm || checkingServices) return;
    confirming.current = true;
    onConfirm();
  };
  const version = release.latestVersion ?? release.supportedVersion;
  const dismiss = () => { if (!busy) onDismiss(); };
  return <Dialog title={zh ? '确认更新 Strata' : 'Confirm Strata update'} wide onClose={dismiss}>
    <div className="runtime-update-dialog">
      <p className="runtime-update-release-name">{release.releaseName || `Strata ${version}`}</p>
      <dl className="runtime-update-details"><div><dt>{zh ? '本机版本' : 'Installed version'}</dt><dd>{runtime.runtimeVersion ?? '—'}</dd></div><div><dt>{zh ? '更新至' : 'Update to'}</dt><dd>{version}</dd></div></dl>
      <code className="runtime-update-directory">{runtime.installDir}</code>
      {willStop && <div className="notice warning runtime-update-service-warning" role="status"><strong>{zh ? '更新需要停止当前服务' : 'Updating requires stopping the current service'}</strong><p>{zh ? '确认后停止以下服务并更新 Strata，完成后恢复服务。正在进行的请求会中断。' : 'Confirm to stop the services below and update Strata. Services resume afterward. Active requests will be interrupted.'}</p>{services.data?.map(({ profile, status }) => <div key={profile.id}><strong>{profile.name}</strong> · PID {status.pid ?? '—'}<code className="runtime-update-directory">{profile.configPath}</code></div>)}</div>}
      {checkingServices && !services.error && <p role="status">{zh ? '正在检查当前服务…' : 'Checking running services…'}</p>}
      {services.error && <p className="notice error" role="alert">{core.normalizeError(services.error).message}</p>}
      <h3>{zh ? '更新日志' : 'Release notes'}</h3>
      <div className="runtime-update-notes" role="region" aria-label={zh ? '更新日志' : 'Release notes'} tabIndex={0}>
        {notes ? <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ node: _node, children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a> }}>{notes}</ReactMarkdown> : <p>{zh ? '此 Release 暂无更新日志。' : 'This release has no release notes.'}</p>}
      </div>
      {!canConfirm && !busy && <p className="runtime-update-waiting" role="status">{zh ? '当前正在处理请求或任务，空闲后可确认更新。' : 'Requests or tasks are in progress. You can confirm the update when they finish.'}</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="runtime-update-dialog-actions"><button type="button" disabled={busy} onClick={dismiss}>{zh ? '暂不更新' : 'Not now'}</button><button type="button" className="primary" disabled={busy || !canConfirm || checkingServices} onClick={confirm}>{busy ? <LoaderCircle size={15} className="spin"/> : <ArrowUpCircle size={15}/>} {busy ? zh ? '正在开始更新…' : 'Starting update…' : willStop ? zh ? '停止服务并更新' : 'Stop services and update' : zh ? '确认更新' : 'Confirm update'}</button></div>
    </div>
  </Dialog>;
}
