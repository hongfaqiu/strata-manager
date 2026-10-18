import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Check, CircleAlert, CircleDashed, Info, RotateCcw, Square, Zap } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { AppLanguage, CalibrationJob, ServiceProfile, SpeedCheck, SpeedFix, TuningLiveSnapshot } from '@strata-manager/core';
import { appliedFor, dismissJob, dismissedJobs, type SpeedBoostApplied } from './speedBoostRecord';

const active = (job: CalibrationJob | null) => !!job && ['checking', 'running', 'canceling'].includes(job.state);
const stepKey: Record<string, string> = { warmup: 'sbStepWarmup', prefillPipe: 'sbStepPrefillPipe', pcieFrac: 'sbStepPcieFrac', specMinP: 'sbStepSpecMinP', confirm: 'sbStepConfirm' };
const checkLabel: Record<SpeedCheck['id'], string> = { vramHeadroom: 'sbCheckVram', kvInRam: 'sbCheckKv', pcieFixed: 'sbCheckPcie' };
const checkText = (check: SpeedCheck): string => {
  if (check.reason === 'unknown') return 'sbCheckUnknown';
  if (check.id === 'vramHeadroom') return ({ ok: 'sbCheckVramOk', low: 'sbCheckVramLow', reserved: 'sbCheckVramReserved' } as Record<string, string>)[check.reason] ?? 'sbCheckUnknown';
  if (check.id === 'kvInRam') return ({ shortContext: 'sbCheckKvShort', enabled: 'sbCheckKvEnabled', off: 'sbCheckKvOff', ramLow: 'sbCheckKvRamLow', ramUnknown: 'sbCheckKvRamUnknown', wsl: 'sbCheckKvWsl' } as Record<string, string>)[check.reason] ?? 'sbCheckUnknown';
  return 'sbCheckPcieFixed';
};
const verdictKey: Record<string, string> = { belowMinGain: 'sbVerdictBelowMinGain', shortRegressed: 'sbVerdictShortRegressed', longRegressed: 'sbVerdictLongRegressed' };

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000), minutes = Math.floor(total / 60), seconds = total % 60;
  return minutes ? `${minutes}:${String(seconds).padStart(2, '0')}` : `0:${String(seconds).padStart(2, '0')}`;
}

/** Health inputs: config, the running engine's facts, recent log lines and free RAM. All read-only. */
export function useSpeedHealth({ profile, desktop, owned, goal }: { profile?: ServiceProfile; desktop: boolean; owned: boolean; goal: core.CalibrationGoal }) {
  const enabled = desktop && !!profile;
  const snapshot = useQuery({ queryKey: ['speed-config', profile?.id], queryFn: () => core.readConfigSnapshot(profile!), enabled, staleTime: 15_000, retry: false });
  const metrics = useQuery({ queryKey: ['speed-metrics', profile?.id], queryFn: () => core.request(profile!, '/metrics'), enabled: enabled && owned, staleTime: 15_000, retry: false });
  const logs = useQuery({ queryKey: ['speed-logs', profile?.id], queryFn: () => core.readLogs(profile!, 400), enabled: enabled && owned, staleTime: 30_000, retry: false });
  const config = snapshot.data?.config;
  const settings = useMemo(() => config ? core.readConcurrencySettings(config) : null, [config]);
  const identity = useMemo(() => config ? core.concurrencyModelIdentity(config) : null, [config]);
  const hardware = useQuery({
    queryKey: ['speed-hardware', profile?.id, identity?.family, identity?.quant], enabled: enabled && !!settings, staleTime: 60_000, retry: false,
    queryFn: async () => (await core.assessSetupResources({ installationId: profile!.id, family: identity?.family ?? 'unknown', quant: identity?.quant ?? 'unknown', context: Math.min(1_048_576, Math.max(512, settings!.context ?? 32768)), images: false, kv: settings!.kv.slice(0, 32), gpuIds: settings!.gpuIds.filter(id => id <= 255).slice(0, 8), parallel: 1 })).hardware,
  });
  const platform = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent) ? 'windows' : 'other';
  const engine = metrics.data && typeof metrics.data.engine === 'object' && metrics.data.engine ? metrics.data.engine as Record<string, unknown> : null;
  const checks = useMemo(() => config ? core.speedHealthCheck({ config, engine: engine as never, hardware: hardware.data ?? null, platform, goal, logs: logs.data?.map(line => line.message) }) : [], [config, engine, hardware.data, platform, goal, logs.data]);
  return { checks, loading: snapshot.isPending && enabled, refetch: () => { void snapshot.refetch(); void metrics.refetch(); void logs.refetch(); } };
}

export interface SpeedBoostProps {
  language: AppLanguage;
  job: CalibrationJob | null;
  live: TuningLiveSnapshot | null;
  clock: number;
  profile?: ServiceProfile;
  /** Why the run cannot start, already translated; undefined when it can. */
  blocked?: string;
  busy: boolean;
  canApply: boolean;
  canSwitch: boolean;
  checks: SpeedCheck[];
  onStart: () => void;
  onCancel: () => void;
  onApply: () => void;
  onFix: (fixes: SpeedFix[]) => void;
  onRollback: (record: SpeedBoostApplied) => void;
  notice?: string | null;
}

export function SpeedBoost({ language, job, live, clock, profile, blocked, busy, canApply, canSwitch, checks, onStart, onCancel, onApply, onFix, onRollback, notice }: SpeedBoostProps) {
  const { t } = useTranslation();
  const [, rerender] = useState(0);
  const dismissed = dismissedJobs();
  const number = (value: number | null | undefined, digits = 1) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString(language, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const running = active(job);
  const applied = appliedFor(profile?.id);
  const result = core.speedResult(job);
  const showResult = !!job && !!result && !dismissed.includes(job.id) && !(applied && applied.kind === 'boost' && applied.at >= (job.finishedAt ?? 0));
  const changes = core.speedChanges(job);
  const fixes = checks.filter(check => check.status === 'fix' && check.fix);

  const progress = job ? core.calibrationProgress(job, live) : null;
  const steps = job?.steps.filter(step => step.status !== 'skipped') ?? [];
  const current = steps.find(step => step.status === 'running');
  const index = current ? steps.indexOf(current) + 1 : 0;

  const changeLine = (change: core.SpeedChange) => ({
    pcieAuto: t('sbChangePcieAuto'),
    pcieFixed: change.from == null ? t('sbChangePcieFixed', { to: change.to }) : t('sbChangePcieValue', { from: change.from, to: change.to }),
    specMinP: t('sbChangeSpecMinP', { from: change.from ?? '—', to: change.to ?? '—' }),
    prefillPipe: t('sbChangePrefillPipe', { to: change.to ?? '—' }),
  })[change.kind];
  const flagLine = (change: core.SpeedChange) => `${change.flag} ${change.to ?? (change.kind === 'pcieAuto' ? '—' : '')}`.trim();

  let hero;
  if (running && job) {
    hero = <div className="sb-run" data-testid="speed-boost-running" role="status" aria-live="polite">
      <div className="sb-run-head"><span className="sb-kicker">{t('sbRunning')}</span><span className="sb-muted">{index ? t('sbStepOf', { index, total: steps.length }) : ''}</span></div>
      <p className="sb-run-step">{current ? t(stepKey[current.kind] ?? 'sbRunning') : t('sbStepChecking')}</p>
      <div className="sb-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress?.fraction ?? 0) * 100)} aria-label={t('sbRunning')}><span style={{ width: `${Math.max(2, (progress?.fraction ?? 0) * 100)}%` }}/></div>
      <div className="sb-run-foot">
        <span>{t('sbElapsed', { time: formatDuration(clock - job.startedAt) })}{live?.etaMs != null ? ` · ${t('sbRemaining', { time: formatDuration(live.etaMs) })}` : ''}</span>
        {live?.request?.tokS != null && <span className="sb-live-rate"><strong>{number(live.request.tokS)}</strong> tok/s</span>}
        <button type="button" data-testid="speed-boost-cancel" disabled={busy || job.state === 'canceling'} onClick={onCancel}><Square size={13}/>{t('sbCancel')}</button>
      </div>
    </div>;
  } else if (showResult && result && job) {
    hero = result.changed ? <div className="sb-result" data-testid="speed-boost-result">
      <div className="sb-compare">
        <div><span className="sb-muted">{t('sbBefore')}</span><strong>{number(result.before)}</strong></div>
        <span className="sb-arrow" aria-hidden>→</span>
        <div className="is-after"><span className="sb-muted">{t('sbAfter')}</span><strong>{number(result.after)}</strong></div>
        <span className="sb-unit">tok/s</span>
        {result.gain != null && <span className="sb-gain" data-testid="speed-boost-gain">{t('sbFaster', { percent: number(result.gain * 100) })}</span>}
      </div>
      {(result.short.before != null || result.long.before != null) && <p className="sb-split">{result.short.before != null && <span>{t('sbShortAnswers')} {number(result.short.before)} → {number(result.short.after)}</span>}{result.long.before != null && <span>{t('sbLongAnswers')} {number(result.long.before)} → {number(result.long.after)}</span>}</p>}
      <h3 className="sb-h3">{t('sbChangesTitle')}</h3>
      <ul className="sb-changes" data-testid="speed-boost-changes">{changes.map(change => <li key={change.flag}><span>{changeLine(change)}</span><code>{change.kind === 'pcieAuto' ? `${change.flag} → auto` : flagLine(change)}</code></li>)}</ul>
      <div className="sb-actions">
        <button className="primary" data-testid="speed-boost-apply" disabled={!canApply} onClick={onApply}><Check size={15}/>{canSwitch ? t('sbApply') : t('sbSaveOnly')}</button>
        <button type="button" data-testid="speed-boost-discard" disabled={busy} onClick={() => { dismissJob(job.id); rerender(value => value + 1); }}>{t('sbDiscard')}</button>
      </div>
      <p className="sb-muted sb-foot">{t('sbApplyHint')}</p>
    </div> : <div className="sb-result is-same" data-testid="speed-boost-same">
      <div className="sb-compare"><div><span className="sb-muted">{t('sbCurrentSpeed')}</span><strong>{number(result.before)}</strong></div><span className="sb-unit">tok/s</span></div>
      <h3 className="sb-title">{t('sbSame')}</h3>
      <p className="sb-muted">{job.verdict && verdictKey[job.verdict] ? t(verdictKey[job.verdict]!) : t('sbSameHint')}</p>
      <div className="sb-actions"><button type="button" data-testid="speed-boost-start" disabled={!!blocked || busy} onClick={onStart}><RotateCcw size={14}/>{t('sbRetry')}</button></div>
    </div>;
  } else if (applied) {
    hero = <div className="sb-result is-applied" data-testid="speed-boost-applied">
      {applied.before != null && applied.after != null && <div className="sb-compare"><div><span className="sb-muted">{t('sbBefore')}</span><strong>{number(applied.before)}</strong></div><span className="sb-arrow" aria-hidden>→</span><div className="is-after"><span className="sb-muted">{t('sbAfter')}</span><strong>{number(applied.after)}</strong></div><span className="sb-unit">tok/s</span></div>}
      <h3 className="sb-title"><Check size={16}/>{applied.kind === 'fix' ? t('sbFixed') : t('sbApplied')}</h3>
      <p className="sb-muted">{t('sbAppliedHint', { name: profile?.name ?? applied.name, origin: applied.origin.name })}</p>
      <div className="sb-actions"><button type="button" data-testid="speed-boost-rollback" disabled={busy || !canSwitch} onClick={() => onRollback(applied)}><RotateCcw size={14}/>{t('sbRollback')}</button>
        <button type="button" data-testid="speed-boost-start" disabled={!!blocked || busy} onClick={onStart}><Zap size={14}/>{t('sbRetry')}</button></div>
    </div>;
  } else {
    const failed = job && ['failed', 'interrupted'].includes(job.state);
    hero = <div className="sb-idle" data-testid="speed-boost-idle">
      {failed && <p className="notice error" role="alert">{t('sbFailed')}{job?.error ? `：${job.error}` : ''}</p>}
      {job?.state === 'canceled' && <p className="notice" role="status">{t('sbCanceled')}</p>}
      <button className="primary sb-start" data-testid="speed-boost-start" disabled={!!blocked || busy} onClick={onStart}><Zap size={17}/>{failed ? t('sbRetry') : t('sbStart')}</button>
      <p className="sb-muted">{blocked ?? t('sbStartHint')}</p>
    </div>;
  }

  return <>
    <section className="sb-hero" data-testid="speed-boost">{hero}{notice && <p className="notice sb-notice" role="status">{notice}</p>}</section>
    <section className="sb-checks" data-testid="speed-health" aria-labelledby="sb-checks-title">
      <div className="sb-section-head"><div><h3 id="sb-checks-title">{t('sbCheckTitle')}</h3><p className="sb-muted">{fixes.length ? t('sbFixHint') : t('sbCheckHint')}</p></div>
        {fixes.length > 1 && <button type="button" data-testid="speed-fix-all" disabled={busy || running} onClick={() => onFix(fixes.map(check => check.fix!))}>{t('sbFixAll')}</button>}</div>
      <ul>{checks.map(check => <li key={check.id} className={`is-${check.status}`} data-testid={`speed-check-${check.id}`}>
        <span className="sb-check-icon" aria-hidden>{check.status === 'ok' ? <Check size={15}/> : check.status === 'fix' ? <CircleAlert size={15}/> : check.status === 'info' ? <Info size={15}/> : <CircleDashed size={15}/>}</span>
        <div><strong>{t(checkLabel[check.id])}</strong><p>{t(checkText(check), { ...check.values, ...(typeof check.values.context === 'number' ? { context: `${Math.round(check.values.context / 1024)}K` } : {}) })}</p></div>
        {check.status === 'fix' && check.fix && <button type="button" data-testid={`speed-fix-${check.id}`} disabled={busy || running} onClick={() => onFix([check.fix!])}>{t('sbFix')}</button>}
      </li>)}</ul>
    </section>
  </>;
}
