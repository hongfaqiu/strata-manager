import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, LoaderCircle } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { ConfigCleanupItem, ConfigCleanupPlan } from '@strata-manager/core';
import { Checkbox, OfficialDialog } from '../OfficialControls';
import './config-cleanup-dialog.css';
import './config-versions.css';

export interface ConfigCleanupDialogProps {
  currentInstallDir: string;
  directories?: string[];
  onClose: () => void;
  /** Refresh discovery after at least one file was archived. */
  onArchived: () => void | Promise<unknown>;
}

const fileName = (path: string) => path.split(/[\\/]/).at(-1) || path;

/**
 * Old-version cleanup: the plan is read-only; each selected file is then
 * archived with the same checks as a single configuration deletion.
 */
export function ConfigCleanupDialog({ currentInstallDir, directories, onClose, onArchived }: ConfigCleanupDialogProps) {
  const { t } = useTranslation();
  const mounted = useRef(true);
  const [plan, setPlan] = useState<ConfigCleanupPlan>();
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; count: number }>();
  const [archived, setArchived] = useState<number>();
  const [failures, setFailures] = useState<{ path: string; message: string }[]>([]);
  useEffect(() => {
    mounted.current = true;
    core.planConfigCleanup(currentInstallDir, directories?.length ? directories : undefined)
      .then(result => { if (!mounted.current) return; setPlan(result); setSelected(new Set(result.items.filter(item => item.identical).map(item => item.configPath))); })
      .catch(error => { if (mounted.current) setLoadError(core.normalizeError(error).message); });
    return () => { mounted.current = false; };
    // The plan is read once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const busy = !!progress;
  const close = () => { if (!busy) onClose(); };
  const items = plan?.items ?? [];
  const versions = [...new Set(items.map(item => item.runtimeVersion ?? ''))].sort((a, b) => core.compareRuntimeVersions(b || undefined, a || undefined));
  const toggle = (item: ConfigCleanupItem, on: boolean) => setSelected(previous => { const next = new Set(previous); if (on) next.add(item.configPath); else next.delete(item.configPath); return next; });
  const allSelected = items.length > 0 && items.every(item => selected.has(item.configPath));
  const archive = async () => {
    const chosen = items.filter(item => selected.has(item.configPath));
    if (!chosen.length || busy) return;
    const failed: { path: string; message: string }[] = [];
    let done = 0;
    setFailures([]); setProgress({ done, count: chosen.length });
    for (const item of chosen) {
      try { await core.deleteConfiguration(item.profile); done++; }
      catch (error) { failed.push({ path: item.configPath, message: core.normalizeError(error).message }); }
      if (mounted.current) setProgress({ done: done + failed.length, count: chosen.length });
    }
    if (done) await Promise.resolve(onArchived()).catch(() => undefined);
    if (!mounted.current) return;
    setProgress(undefined); setArchived(done); setFailures(failed);
    setPlan(previous => previous && { ...previous, items: previous.items.filter(item => !chosen.includes(item) || failed.some(failure => failure.path === item.configPath)) });
    setSelected(new Set());
  };
  const versionLabel = (version?: string) => version ? t('mvVersionTag', { version }) : t('mvVersionUnknown');
  return <OfficialDialog title={t('mvCleanup')} onClose={close} wide>
    <div className="config-cleanup" aria-busy={busy}>
      <p className="config-cleanup-intro">{t('mvCleanupIntro')}</p>
      <dl className="config-cleanup-current"><dt>{t('mvCleanupKeeping')}</dt><dd><span className="config-version-tag is-current">{versionLabel(plan?.currentVersion)}</span><code>{plan?.currentInstallDir ?? currentInstallDir}</code></dd></dl>
      {!plan && !loadError && <p className="config-cleanup-status" role="status"><LoaderCircle size={15} className="spin" aria-hidden="true"/>{t('mvCleanupLoading')}</p>}
      {loadError && <p className="notice error" role="alert">{loadError}</p>}
      {plan && !items.length && archived === undefined && <p className="config-cleanup-status" role="status">{t('mvCleanupEmpty')}</p>}
      {items.length > 0 && <div className="config-cleanup-list">
        <label className="config-cleanup-all"><Checkbox checked={allSelected} disabled={busy} onChange={event => setSelected(event.target.checked ? new Set(items.map(item => item.configPath)) : new Set())}/>{t('mvCleanupSelectAll')}<span>{selected.size} / {items.length}</span></label>
        {versions.map(version => <section key={version || 'unknown'} className="config-cleanup-version">
          <h3>{versionLabel(version || undefined)}</h3>
          {items.filter(item => (item.runtimeVersion ?? '') === version).map(item => <label key={item.configPath} className="config-cleanup-row">
            <Checkbox checked={selected.has(item.configPath)} disabled={busy} onChange={event => toggle(item, event.target.checked)}/>
            <span className="config-cleanup-file"><strong>{fileName(item.configPath)}</strong><code data-tooltip={item.configPath}>{item.configPath}</code>{!item.identical && <small>{t('mvCleanupDiffersHint')}</small>}</span>
            <span className={`config-cleanup-badge${item.identical ? ' is-same' : ''}`} data-tooltip={item.identicalTo}>{item.identical ? t('mvCleanupIdentical') : t('mvCleanupDiffers')}</span>
          </label>)}
        </section>)}
      </div>}
      {archived !== undefined && archived > 0 && <p className="config-cleanup-status" role="status"><Archive size={15} aria-hidden="true"/>{t('mvCleanupDone', { count: archived })}</p>}
      {failures.length > 0 && <div className="notice error" role="alert">{failures.map(failure => <p key={failure.path}>{t('mvCleanupFailed')}<code>{fileName(failure.path)}</code> · {failure.message}</p>)}</div>}
      {items.length > 0 && <p className="config-cleanup-note">{t('mvCleanupRunNote')}</p>}
      <div className="config-cleanup-actions">
        <button type="button" disabled={busy} onClick={close}>{archived !== undefined ? t('mvClose') : t('mvCancel')}</button>
        {items.length > 0 && <button type="button" className="danger" disabled={busy || !selected.size} onClick={() => void archive()}>{busy ? <LoaderCircle size={15} className="spin" aria-hidden="true"/> : <Archive size={15} aria-hidden="true"/>}{busy ? t('mvCleanupWorking', { done: progress!.done, count: progress!.count }) : t('mvCleanupConfirm', { count: selected.size })}</button>}
      </div>
    </div>
  </OfficialDialog>;
}
