import type { AppLanguage } from "@strata-manager/core";
import { Download, LoaderCircle } from 'lucide-react';
import { ReleaseNotesMarkdown } from './ReleaseNotesMarkdown';
import { Dialog } from './components';
import { lifecycleEn, lifecycleZh } from './LifecycleStrings';
import { appUpdateSourceSummary, type AppUpdateState } from './appUpdateController';
import { localizedReleaseNotes, releaseNotes } from './updateReleaseNotes';
import './app-update-dialog.css';

export interface AppUpdateDialogProps {
  language: AppLanguage;
  state: AppUpdateState;
  idle?: boolean;
  onConfirm: (version: string) => Promise<void> | void;
  onClose: () => void;
}

/** Release metadata stays attached to the candidate the user is approving. */
export function AppUpdateDialog({ language, state, idle = true, onConfirm, onClose }: AppUpdateDialogProps) {
  const text = language !== 'zh-CN' ? lifecycleEn : lifecycleZh;
  const zh = language === 'zh-CN';
  if (!state.version || state.phase === 'current' || state.phase === 'installed') return null;
  const version = state.version;
  const notes = localizedReleaseNotes(state.notes, language) ?? releaseNotes(state.notes);
  const busy = ['checking', 'downloading', 'installing'].includes(state.phase);
  const close = () => { if (!busy) onClose(); };
  const bytes = (value: number) => `${(value / 1024 ** 2).toFixed(1)} MiB`;
  const progress = (state.total ? text.downloadBytes : text.downloadBytesUnknown).replace('{{received}}', bytes(state.received)).replace('{{total}}', bytes(state.total ?? 0));
  const errorText = state.errorStage === 'download' ? text.updateDownloadFailed : state.errorStage === 'install' ? text.updateInstallFailed : text.updateCheckFailed;
  const { source: sourceSummary, fallback: fallbackSummary } = appUpdateSourceSummary(state.source, state.fallbackChain, zh);
  return <Dialog title={text.updateConfirmTitle.replace('{{version}}', version)} onClose={close}>
    <div className="app-update-dialog">
      <h3>{text.releaseNotesTitle}</h3>
      <div className="app-update-release-notes" tabIndex={0} aria-label={text.releaseNotesTitle}>
        {notes ? <ReleaseNotesMarkdown>{notes}</ReleaseNotesMarkdown> : <p>{text.releaseNotesMissing.replace('{{version}}', version)}</p>}
      </div>
      <p className="app-update-confirm-hint">{text.updateConfirmationHint}</p>
      {sourceSummary && <p className="app-update-confirm-hint">{sourceSummary}</p>}
      {fallbackSummary && <p className="app-update-confirm-hint">{fallbackSummary}</p>}
      {!idle && !busy && <p className="notice" role="status">{text.updateWaitForIdle}</p>}
      {state.error && <div className="notice error" role="alert"><span>{errorText}<details><summary>{text.updateErrorDetails}</summary>{state.error}</details></span></div>}
      {busy && <div className="app-update-progress" role="status" aria-live="polite"><LoaderCircle size={16} className="spin"/><span>{state.phase === 'downloading' ? `${text.downloadingAppUpdate} · ${progress}` : state.phase === 'installing' ? text.installingAppUpdate : text.checkingUpdates}</span></div>}
      <div className="dialog-footer"><button type="button" disabled={busy} onClick={close}>{text.updateLater}</button><button type="button" className="primary" disabled={busy || !idle} onClick={() => void onConfirm(version)}>{busy ? <LoaderCircle size={15} className="spin"/> : <Download size={15}/>} {state.downloaded ? text.installAppUpdate : text.confirmAppUpdate}</button></div>
    </div>
  </Dialog>;
}
