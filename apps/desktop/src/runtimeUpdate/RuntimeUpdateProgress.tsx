import type { AppLanguage, LogEntry, TaskStatus } from '@strata-manager/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronRight, LoaderCircle, RotateCcw, Square, X } from 'lucide-react';
import {
  UPDATE_STAGES, deriveUpdateProgress, estimateEta, estimateRate, formatBytes, formatClock, formatEta, formatPercent,
  formatRate, humanizeTaskMessage, rateSeries, smoothRate, type UpdateProgressModel,
} from './runtimeUpdateProgress';
import '../i18n';
import './runtime-update-progress.css';

interface Props {
  task: TaskStatus;
  logs: LogEntry[];
  language: AppLanguage;
  /** Release version shown before the backend names it in a log line. */
  targetVersion?: string;
  cancelling?: boolean;
  onCancel?: () => void;
  onRetry?: () => void;
  onDismiss?: () => void;
}

const R = 38, C = 2 * Math.PI * R;

function Ring({ model, ratio }: { model: UpdateProgressModel; ratio?: number }) {
  const done = model.stages.filter(stage => stage.state === 'done').length;
  const tone = model.outcome === 'failed' ? 'bad' : model.outcome === 'cancelled' ? 'off' : 'ok';
  const indeterminate = model.outcome === 'running' && ratio === undefined && (model.current === 'download' || model.current === 'source') && !model.rollingBack;
  const value = model.outcome === 'completed' ? 1 : ratio ?? done / UPDATE_STAGES.length;
  return <svg className={`ru-ring t-${tone}${indeterminate ? ' is-indeterminate' : ''}`} viewBox="0 0 96 96" aria-hidden="true">
    <circle className="ru-ring-track" r={R} cx="48" cy="48"/>
    <circle className="ru-ring-arc" r={R} cx="48" cy="48" strokeDasharray={indeterminate ? `${C * .22} ${C}` : `${C * Math.max(0, Math.min(1, value))} ${C}`} transform="rotate(-90 48 48)"/>
  </svg>;
}

function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 3) return null;
  const max = Math.max(...values) || 1, w = 64, h = 18;
  const points = values.map((value, index) => `${(index / (values.length - 1) * w).toFixed(1)},${(h - 1 - value / max * (h - 3)).toFixed(1)}`);
  return <svg className="ru-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={label}>
    <polygon className="ru-spark-area" points={`0,${h} ${points.join(' ')} ${w},${h}`}/>
    <polyline className="ru-spark-line" points={points.join(' ')}/>
  </svg>;
}

/** Progress card for one Strata ZIP update task, rebuilt from its status line and task log. */
export function RuntimeUpdateProgress({ task, logs, language, targetVersion, cancelling, onCancel, onRetry, onDismiss }: Props) {
  // The card follows the page's language prop, like the panel around it, even outside the full App.
  const { t: translate } = useTranslation();
  const t = (key: string, options: Record<string, unknown> = {}) => translate(key, { ...options, lng: language });
  const running = task.state === 'running';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!running) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [running]);
  const model = useMemo(() => deriveUpdateProgress(task, logs, now), [task, logs, now]);
  const [logOpen, setLogOpen] = useState(task.state === 'failed');
  useEffect(() => { if (task.state === 'failed') setLogOpen(true); }, [task.state]);
  const logRef = useRef<HTMLDivElement>(null);

  // Speed: least-squares over the last 10 s of log samples, then time-smoothed so the number settles.
  const smoothed = useRef<{ value?: number; at: number; attempt: number }>({ at: 0, attempt: 0 });
  const raw = estimateRate(model.samples);
  const firstSample = model.samples[0]?.at ?? 0;
  if (smoothed.current.attempt !== firstSample) smoothed.current = { at: 0, attempt: firstSample };
  const lastSample = model.samples.at(-1)?.at ?? 0;
  if (lastSample !== smoothed.current.at) smoothed.current = { ...smoothed.current, value: smoothRate(smoothed.current.value, raw, lastSample - smoothed.current.at), at: lastSample };
  const stale = running && lastSample > 0 && now - lastSample > 15_000;
  const rate = model.current === 'download' && running && !model.download?.verified && !stale ? smoothed.current.value : undefined;
  const download = model.download;
  const inDownload = model.current === 'download' && running && !model.rollingBack;
  const ratio = inDownload && download?.total ? download.received / download.total : undefined;
  const eta = inDownload && download ? estimateEta(download.received, download.total, rate) : undefined;
  const series = useMemo(() => rateSeries(model.samples), [model.samples]);
  const locale = language;

  useEffect(() => { if (logOpen && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logOpen, logs.length]);

  const version = model.version ?? targetVersion;
  const title = model.outcome === 'completed' ? (version ? t('ruDone', { version }) : t('ruDonePlain'))
    : model.outcome === 'failed' ? t('ruFailed')
    : model.outcome === 'cancelled' ? t('ruCancelled')
    : model.rollingBack ? t('ruRollingBack')
    : version ? t('ruRunning', { version }) : t('ruRunningPlain');
  const stepIndex = UPDATE_STAGES.indexOf(model.current);
  const stageName = t(`ruStage_${model.current}`);
  const detail = model.detail === 'retry' && model.retry ? t('ruDetail_retry', model.retry)
    : !model.detail && model.retry && inDownload ? t('ruDetail_resumed', model.retry)
    : model.detail ? t(`ruDetail_${model.detail}`)
    : model.rawDetail ? humanizeTaskMessage(model.rawDetail, locale) : undefined;
  const elapsed = (task.finishedAt ?? now) - task.startedAt;
  const failedStage = model.stages.find(stage => stage.state === 'failed');

  // Collapse the once-per-second progress spam into the latest line of each run so the log stays readable.
  const shownLogs = useMemo(() => {
    const rows: LogEntry[] = [];
    for (const entry of logs) {
      const progress = /^下载进度：|^官方同版本源码已下载|^已读取本地 ZIP/.test(entry.message);
      const previous = rows.at(-1);
      if (progress && previous && /^下载进度：|^官方同版本源码已下载|^已读取本地 ZIP/.test(previous.message) && previous.message.slice(0, 4) === entry.message.slice(0, 4)) rows[rows.length - 1] = entry;
      else rows.push(entry);
    }
    return rows;
  }, [logs]);

  const center = model.outcome === 'completed' ? <Check size={26} strokeWidth={2.2}/>
    : model.outcome === 'failed' ? <X size={26} strokeWidth={2.2}/>
    : model.outcome === 'cancelled' ? <Square size={18}/>
    : ratio !== undefined ? <><b className="d2-num">{formatPercent(download!.received, download!.total, locale)}</b>{download?.total && <small className="d2-num">{formatBytes(download.total, locale)}</small>}</>
    : inDownload && download ? <><b className="d2-num ru-center-bytes">{formatBytes(download.received, locale)}</b></>
    : <><b className="d2-num">{stepIndex + 1}<span>/{UPDATE_STAGES.length}</span></b></>;

  return <section className={`ru-card is-${model.outcome}${model.rollingBack && running ? ' is-rolling-back' : ''}`} aria-label={title} data-testid="runtime-update-progress" data-stage={model.current} data-outcome={model.outcome}>
    <div className="ru-head">
      <div className="ru-gauge"><Ring model={model} ratio={ratio}/><span className="ru-gauge-center">{center}</span></div>
      <div className="ru-copy" role={model.outcome === 'failed' ? 'alert' : 'status'} aria-live="polite">
        <h3>{title}</h3>
        {running && <p className="ru-stage"><strong>{stageName}</strong><span className="ru-sep">·</span><span>{t('ruStepOf', { step: stepIndex + 1, total: UPDATE_STAGES.length })}</span>{detail && <><span className="ru-sep">·</span><span className="ru-detail">{detail}</span></>}</p>}
        {inDownload && download && <div className="ru-metrics" aria-label={t('ruAriaDownload')}>
          {download.total ? <span className="ru-bytes d2-num">{t('ruOf', { received: formatBytes(download.received, locale), total: formatBytes(download.total, locale) })}</span> : <span className="ru-muted">{t('ruTotalUnknown')}</span>}
          {rate !== undefined && <span className="ru-speed"><Sparkline values={series} label={t('ruSpeedLabel')}/><b className="d2-num">{formatRate(rate, locale)}</b></span>}
          {download.total && !download.verified && <span className="ru-eta">{eta !== undefined ? t('ruEta', { eta: formatEta(eta, locale) }) : t('ruEtaPending')}</span>}
        </div>}
        {running && model.current === 'source' && model.sourceReceived !== undefined && <div className="ru-metrics"><span className="ru-bytes d2-num">{t('ruReceived', { received: formatBytes(model.sourceReceived, locale) })}</span><span className="ru-muted">{t('ruTotalUnknown')}</span></div>}
        {model.outcome === 'completed' && <p className="ru-note">{t('ruPreserved')} <span className="ru-muted d2-num">{t('ruTook', { time: formatClock(elapsed) })}</span></p>}
        {model.outcome === 'failed' && <>
          <p className="ru-reason">{humanizeTaskMessage(task.message, locale)}</p>
          <p className="ru-note">{failedStage && t('ruFailedAt', { stage: t(`ruStage_${failedStage.id}`) })} {model.rolledBack || /已恢复原程序版本/.test(task.message) ? t('ruRolledBackNote') : ''}</p>
        </>}
        {model.outcome === 'cancelled' && <p className="ru-note">{t('ruCancelledNote')}</p>}
      </div>
      <div className="ru-actions">
        {running && onCancel && <button type="button" disabled={cancelling} onClick={onCancel}>{cancelling ? <LoaderCircle size={14} className="spin"/> : <Square size={13}/>}{cancelling ? t('ruCancelling') : t('ruCancel')}</button>}
        {!running && model.outcome !== 'completed' && onRetry && <button type="button" onClick={onRetry}><RotateCcw size={14}/>{t('ruRetry')}</button>}
        {!running && onDismiss && <button type="button" className="ru-dismiss" onClick={onDismiss}>{t('ruDismiss')}</button>}
      </div>
    </div>
    <ol className="ru-steps" aria-label={t('ruAriaStages')}>
      {model.stages.map(stage => {
        const label = t(`ruStage_${stage.id}`);
        const span = stage.startedAt !== undefined ? (stage.endedAt ?? (stage.state === 'active' && running ? now : undefined)) : undefined;
        const time = span !== undefined && stage.startedAt !== undefined ? formatClock(span - stage.startedAt) : '';
        return <li key={stage.id} className={`is-${stage.state}${model.outcome === 'cancelled' && stage.state === 'failed' ? ' is-stopped' : ''}`} aria-current={stage.state === 'active' ? 'step' : undefined}>
          <span className="ru-dot" aria-hidden="true">{stage.state === 'done' ? <Check size={11} strokeWidth={3}/> : stage.state === 'failed' ? (model.outcome === 'cancelled' ? <Square size={8}/> : <X size={11} strokeWidth={3}/>) : null}</span>
          <span className="ru-step-name">{label}<span className="ru-visually-hidden">{`, ${t(`ruStageState_${stage.state}`)}`}</span></span>
          <small className="d2-num">{time}</small>
        </li>;
      })}
    </ol>
    <footer className="ru-foot">
      <button type="button" className="ru-log-toggle" aria-expanded={logOpen} aria-controls={`ru-log-${task.id}`} onClick={() => setLogOpen(value => !value)}>
        <ChevronRight size={14} className="ru-chevron"/>{t('ruLog')}{running && <span className="ru-live">{t('ruLogLive')}</span>}<span className="ru-muted">{t('ruLogLines', { count: logs.length })}</span>
      </button>
      <span className="ru-muted ru-foot-note">{running ? <>{t('ruBackground')} <span className="d2-num">{t('ruElapsed', { time: formatClock(elapsed) })}</span></> : null}</span>
    </footer>
    {logOpen && <div id={`ru-log-${task.id}`} ref={logRef} className="ru-log" role="log" aria-label={t('ruLog')} tabIndex={0}>
      {shownLogs.length ? shownLogs.map((entry, index) => <div key={`${entry.timestamp}-${index}`} className={`ru-log-line l-${entry.level.toLowerCase()}`}><time className="d2-num">{new Date(entry.timestamp).toLocaleTimeString(locale, { hour12: false })}</time><span>{humanizeTaskMessage(entry.message, locale)}</span></div>) : <p className="ru-muted">{t('ruLogEmpty')}</p>}
    </div>}
  </section>;
}
