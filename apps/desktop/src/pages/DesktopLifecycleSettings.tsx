import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CircleHelp, Download, LoaderCircle, RefreshCw, RotateCw } from 'lucide-react';
import { ReleaseNotesMarkdown } from '../ReleaseNotesMarkdown';
import * as core from '@strata-manager/core';
import desktopPackage from '../../package.json';
import bundledChangelog from '../../../../CHANGELOG.md?raw';
import { Dialog, Panel } from '../components';
import { Dropdown, Toggle } from '../OfficialControls';
import type { AppUpdateState } from '../useAppUpdates';
import { startupStatusHint } from '../startupStatusText';
import { bundledAppRelease } from '../bundledAppRelease';
import { localizedReleaseNotes, releaseNotes } from '../updateReleaseNotes';
import './desktop-lifecycle-settings.css';

interface Props {
  section?: 'all' | 'background' | 'updates';
  currentVersion?: string;
  desktop: boolean;
  streaming: boolean;
  autoCheck: boolean;
  onAutoCheck: (enabled: boolean) => void;
  update: AppUpdateState;
  onCheck: () => Promise<void>;
  onDownload: () => Promise<void>;
  onInstall: () => Promise<void>;
  onError: (error: unknown) => void;
}

export function DesktopLifecycleSettings({ section = 'all', currentVersion = desktopPackage.version, desktop, streaming, autoCheck, onAutoCheck, update, onCheck, onDownload, onInstall, onError }: Props) {
  const { t, i18n } = useTranslation();
  const query = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [help, setHelp] = useState<'background' | 'updates' | 'error' | null>(null);
  const zh = (i18n.resolvedLanguage ?? i18n.language).startsWith('zh');
  const background = section !== 'updates';
  const language = zh ? 'zh-CN' : 'en';
  const currentRelease = bundledAppRelease(bundledChangelog, currentVersion);
  const currentNotes = localizedReleaseNotes(currentRelease?.notes, language) ?? releaseNotes(currentRelease?.notes);
  const availableNotes = localizedReleaseNotes(update.notes, language) ?? releaseNotes(update.notes);
  const hasCandidate = !!update.version && update.version.replace(/^v/, '') !== currentVersion.replace(/^v/, '') && !['current', 'installed'].includes(update.phase);
  const startup = useQuery({ queryKey: ['startup-status'], queryFn: core.startupStatus, enabled: desktop && background });
  const policy = useQuery({ queryKey: ['background-policy'], queryFn: core.backgroundPolicy, enabled: desktop && background });
  const backend = useQuery({ queryKey: ['supervisor'], queryFn: core.supervisorStatus, enabled: desktop && background, refetchInterval: 10000 });
  const mutate = async (operation: () => Promise<unknown>) => {
    if (saving) return;
    setSaving(true);
    try { await operation(); await Promise.all([query.invalidateQueries({ queryKey: ['startup-status'] }), query.invalidateQueries({ queryKey: ['background-policy'] })]); }
    catch (error) { onError(error); }
    finally { setSaving(false); }
  };
  const row = (title: string, hint: string, checked: boolean, disabled: boolean, change: (checked: boolean) => void, attention = false) => <div className="setting-toggle"><span><strong title={hint}>{title}</strong>{attention && <small role="status">{hint}</small>}</span><Toggle ariaLabel={title} checked={checked} disabled={disabled || saving} onCheckedChange={change}/></div>;
  const helpAction = (section: 'background' | 'updates', title: string) => <button type="button" className="st-btn st-btn--icon" aria-label={title} title={title} onClick={() => setHelp(section)}><CircleHelp size={16}/></button>;
  const phaseKey = { checking: 'checkingUpdates', current: 'noAppUpdates', available: 'updateAvailable', downloading: 'downloadingAppUpdate', downloaded: 'downloadedAppUpdate', installing: 'installingAppUpdate', installed: 'restartForUpdate' };
  const downloading = update.phase === 'downloading' || update.phase === 'installing';
  const formatBytes = (value: number) => `${(value / 1024 ** 2).toFixed(1)} MiB`;
  const idleMinutes = policy.data?.idleUnloadMinutes ?? 15;
  const idleSupported = Number.isInteger(policy.data?.idleUnloadMinutes) && idleMinutes >= 0 && idleMinutes <= 1440;
  const idlePeriods = [0, 5, 15, 30, 60];
  if (idleSupported && !idlePeriods.includes(idleMinutes)) idlePeriods.push(idleMinutes);
  const idleHint = policy.data && !idleSupported ? t('idleModelReleaseUpdate') : policy.data?.mode === 'alwaysReady' ? (zh ? '先关闭“保持模型就绪”' : 'Turn off “Keep model ready” first') : '';
  const notesBody = (notes: string | null, missing: string, label: string) => <div className="settings-release-body" role="region" tabIndex={0} aria-label={label}>{notes ? <ReleaseNotesMarkdown>{notes}</ReleaseNotesMarkdown> : <p className="subtle">{missing}</p>}</div>;

  return <>
    {background && <Panel title={t('backgroundSettings')} action={helpAction('background', zh ? '本机后台帮助' : 'Background service help')}>
      {!desktop && <p className="subtle">{t('nativeRequired')}</p>}
      {startup.error || policy.error ? <div className="notice error" role="alert">{t('settingsUnavailable')}: {String(startup.error ?? policy.error)}</div> : null}
      {row(t('launchOnLogin'), startupStatusHint(startup.data, i18n.resolvedLanguage ?? i18n.language, t('launchOnLoginHint')), startup.data?.enabled === true, !desktop || !startup.data?.supported, enabled => void mutate(() => core.setStartupEnabled(enabled)), startup.data?.configured === true && startup.data?.healthy !== true)}
      {row(t('prepareAtStartup'), t('prepareAtStartupHint'), policy.data?.mode === 'alwaysReady', !desktop || !policy.data, enabled => void mutate(() => core.setBackgroundPolicy(enabled ? 'alwaysReady' : 'lazy', policy.data!.autoRecover, idleMinutes)))}
      {row(t('recoverService'), t('recoverServiceHint'), policy.data?.autoRecover === true, !desktop || !policy.data, enabled => void mutate(() => core.setBackgroundPolicy(policy.data!.mode, enabled, idleMinutes)))}
      <div className="setting-toggle">
        <span style={{ minWidth: 0 }}><strong title={t('idleModelReleaseHint')}>{t('idleModelRelease')}</strong>{idleHint && <small role="status">{idleHint}</small>}</span>
        <div style={{ width: 180, maxWidth: '50%', flexShrink: 0 }}><Dropdown ariaLabel={t('idleModelRelease')} value={String(idleMinutes)} options={idlePeriods.map(value => ({ value: String(value), label: value === 0 ? t('idleModelReleaseOff') : t('idleModelReleaseMinutes', { count: value }) }))} disabled={!desktop || !idleSupported || policy.data?.mode !== 'lazy' || saving} onValueChange={value => { if (Number(value) !== idleMinutes) void mutate(() => core.setBackgroundPolicy(policy.data!.mode, policy.data!.autoRecover, Number(value))); }}/></div>
      </div>
      {backend.data?.updatePending && <div className="notice" role="status">{t('backendUpdatePending')}: {backend.data.updateReason}</div>}
      {backend.data?.recovery?.repairRequired && <div className="notice error" role="alert">{t('backendRepair')}: {backend.data.recovery.lastError}</div>}
      {!!backend.data?.migration?.failed && <div className="notice error" role="alert"><p>{t('migrationNeedsAttention')}</p><ul>{backend.data.migration.entries.filter(entry => entry.status === 'failed').map((entry, index) => <li key={entry.id ?? index}>{entry.name ?? entry.id}: {entry.reason}</li>)}</ul></div>}
    </Panel>}
    {section !== 'background' && <div id="settings-app-updates"><Panel className="app-updates-settings" title={t('appUpdates')} action={helpAction('updates', zh ? '应用更新帮助' : 'App update help')}>
      <div className="app-update-version"><span>{zh ? '当前版本' : 'Current version'}</span><strong>v{currentVersion.replace(/^v/, '')}</strong></div>
      {row(t('checkUpdatesAutomatically'), t('checkUpdatesAutomaticallyHint'), autoCheck, !desktop, onAutoCheck)}
      {update.phase in phaseKey && <p role="status" aria-live="polite">{t(phaseKey[update.phase as keyof typeof phaseKey], { version: update.version })}</p>}
      {update.error && <div className="notice error" role="alert">{t(update.errorStage === 'download' ? 'updateDownloadFailed' : update.errorStage === 'install' ? 'updateInstallFailed' : 'updateCheckFailed')}<button type="button" onClick={() => setHelp('error')}>{zh ? '查看原因' : 'View reason'}</button></div>}
      {downloading && <p role="status">{t(update.total ? 'downloadBytes' : 'downloadBytesUnknown', { received: formatBytes(update.received), total: formatBytes(update.total ?? 0) })}</p>}
      <div className="actions">
        <button type="button" disabled={!desktop || downloading || update.downloaded || update.phase === 'checking' || update.phase === 'installed'} onClick={() => void onCheck()}>{update.phase === 'checking' ? <LoaderCircle className="spin" size={15}/> : <RefreshCw size={15}/>} {t('checkUpdates')}</button>
        {update.version && !update.downloaded && update.phase !== 'current' && update.phase !== 'installed' && <button type="button" className="primary" disabled={!desktop || downloading || update.phase === 'checking'} onClick={() => void onDownload()}><Download size={15}/>{t('reviewAppUpdate')}</button>}
        {update.downloaded && <button type="button" className="primary" disabled={!desktop || downloading} onClick={() => void onInstall()}><Download size={15}/>{t('reviewDownloadedUpdate')}</button>}
        {update.phase === 'installed' && <button type="button" className="primary" disabled={streaming} onClick={() => void core.restartInterface().catch(onError)}><RotateCw size={15}/>{t('restartForUpdate')}</button>}
      </div>
      {hasCandidate && <section className="settings-release"><header><h3>{zh ? '可用更新日志' : 'Available update release notes'}</h3><span><code>v{update.version!.replace(/^v/, '')}</code><span className="badge positive">{zh ? '有更新' : 'Update available'}</span></span></header>{notesBody(availableNotes, zh ? '此版本尚未提供更新日志。' : 'Release notes are not provided for this version.', zh ? '可用更新日志' : 'Available update release notes')}</section>}
      <section className="settings-release"><header><h3>{zh ? '最近一次更新日志' : 'Latest installed release notes'}</h3><span><code>v{currentVersion.replace(/^v/, '')}</code>{currentRelease?.date && <time dateTime={currentRelease.date}>{currentRelease.date}</time>}</span></header>{notesBody(currentNotes, zh ? '当前版本的更新日志未包含在此安装包中。' : 'Release notes for the current version are not included in this package.', zh ? '最近一次更新日志' : 'Latest installed release notes')}</section>
    </Panel></div>}
    {help && <Dialog title={help === 'background' ? t('backgroundSettings') : help === 'updates' ? t('appUpdates') : (zh ? '更新失败原因' : 'Update failure reason')} onClose={() => setHelp(null)}><div className="settings-help-content">
      {help === 'background' ? <><p><strong>{t('launchOnLogin')}</strong>：{t('launchOnLoginHint')}</p><p><strong>{t('prepareAtStartup')}</strong>：{t('prepareAtStartupHint')}</p><p><strong>{t('recoverService')}</strong>：{t('recoverServiceHint')}</p><p><strong>{t('idleModelRelease')}</strong>：{t('idleModelReleaseHint')}</p>{backend.data?.version && <p>{t('backendVersion')}: {backend.data.version} · PID {backend.data.pid ?? '—'}</p>}</> : help === 'updates' ? <><p>{t('checkUpdatesAutomaticallyHint')}</p><p>{t('updaterHint')}</p></> : <pre>{update.error}</pre>}
    </div></Dialog>}
  </>;
}
