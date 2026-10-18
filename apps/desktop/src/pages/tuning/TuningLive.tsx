import { useEffect, useRef } from 'react';
import { LoaderCircle, Square } from 'lucide-react';
import type { AppLanguage, SweepPoint, TuningLiveSnapshot } from '@strata-manager/core';
import type { CalibrationText } from './strings';

export const formatDuration = (ms: number | null | undefined, language: AppLanguage) => {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const total = Math.max(0, Math.round(ms / 1000)), h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
  if (language === 'zh-CN') return h ? `${h} 小时 ${m} 分` : m ? `${m} 分 ${String(s).padStart(2, '0')} 秒` : `${s} 秒`;
  return h ? `${h}h ${m}m` : m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
};
export const formatRate = (value: number | null | undefined, language: AppLanguage, digits = 1) =>
  value == null || !Number.isFinite(value) ? '—' : value.toLocaleString(language, { minimumFractionDigits: digits, maximumFractionDigits: digits });

export interface LiveStatusProps {
  text: CalibrationText;
  language: AppLanguage;
  state: string;
  stepLabel: string;
  stepIndex?: number;
  stepTotal?: number;
  round?: number | null;
  rounds?: number | null;
  parameters?: string;
  liveRate: number | null;
  lastRate: number | null;
  elapsedMs: number;
  etaMs: number | null;
  done: number;
  total: number;
  unit: string;
  cancelLabel: string;
  onCancel?: () => void;
  cancelDisabled?: boolean;
}

/** The one focal strip while a job runs: what is measured, how fast right now, how far along. */
export function LiveStatus(props: LiveStatusProps) {
  const { text, language } = props;
  const fraction = props.total > 0 ? Math.min(1, props.done / props.total) : 0;
  return <section className="tuning-live" data-testid="tuning-live" role="status" aria-live="polite">
    <div className="tuning-live-head">
      <div className="tuning-live-what">
        <p className="tuning-live-state"><LoaderCircle className="spin" size={14}/>{props.state}</p>
        <h3>{props.stepLabel}{props.stepIndex && props.stepTotal ? <small> · {text.step} {props.stepIndex}/{props.stepTotal}</small> : null}{props.round && props.rounds ? <small> · {text.round} {props.round}/{props.rounds}</small> : null}</h3>
        {props.parameters && <p className="tuning-live-params"><span>{text.currentParameters}</span>{props.parameters}</p>}
      </div>
      <div className="tuning-live-rate" data-testid="tuning-live-rate">
        <strong>{formatRate(props.liveRate ?? props.lastRate, language)}</strong>
        <span>tok/s · {props.liveRate != null ? text.liveRate : text.lastRate}</span>
      </div>
      {props.onCancel && <button className="tuning-live-cancel" disabled={props.cancelDisabled} onClick={props.onCancel}><Square size={14}/>{props.cancelLabel}</button>}
    </div>
    <div className="st-progress" role="progressbar" aria-label={props.stepLabel} aria-valuenow={props.done} aria-valuemin={0} aria-valuemax={props.total}><div className="st-progress__bar" style={{ width: `${fraction * 100}%` }}/></div>
    <dl className="tuning-live-facts">
      <div><dt>{props.unit}</dt><dd>{props.done} / {props.total}</dd></div>
      <div><dt>{text.elapsed}</dt><dd>{formatDuration(props.elapsedMs, language)}</dd></div>
      <div><dt>{text.eta}</dt><dd>{props.etaMs == null ? <span className="tuning-muted">{text.etaUnknown}</span> : formatDuration(props.etaMs, language)}</dd></div>
    </dl>
  </section>;
}

const logLabel = (text: CalibrationText, key: string) => ({ sample: text.sample, stepWinner: text.stepWinner, coldReload: text.coldReload, restartCandidate: text.restartCandidate, restoreBaseline: text.restoreBaseline, workloadDone: text.workloadDone, prefillPipeSample: text.prefillPipeSample, warmup: text.warmupLog, finished: text.finished, failed: text.failed, canceled: text.canceled, waitingForIdle: text.waitingLog } as Record<string, string>)[key] ?? key;
const stepName = (text: CalibrationText, key: unknown) => typeof key === 'string' && key in text ? text[key as keyof CalibrationText] : String(key ?? '');

function describe(text: CalibrationText, language: AppLanguage, raw: Record<string, unknown> | null): string {
  const detail = raw ?? {};
  const parts: string[] = [];
  if (detail.step != null) parts.push(stepName(text, detail.step));
  if (detail.candidateId != null) parts.push(String(detail.candidateId));
  if (detail.workloadKind != null) parts.push(String(detail.workloadKind));
  if (detail.position != null) parts.push(stepName(text, detail.position));
  if (detail.value != null) parts.push(`= ${typeof detail.value === 'number' && detail.value < 0 ? text.auto : detail.value}`);
  if (detail.round != null) parts.push(`${text.round} ${detail.round}`);
  if (typeof detail.rate === 'number') parts.push(`${formatRate(detail.rate, language)} tok/s`);
  if (detail.chosen != null) parts.push(`${text.chosen} ${typeof detail.chosen === 'number' && detail.chosen < 0 ? text.auto : detail.chosen}`);
  if (typeof detail.gain === 'number') parts.push(`+${formatRate(detail.gain * 100, language)}%`);
  if (typeof detail.wallMs === 'number') parts.push(formatDuration(detail.wallMs, language));
  return parts.join(' · ');
}

/** Fixed-height log that follows new lines unless the reader scrolled up. */
export function LiveLog({ text, language, lines, saved = false }: { text: CalibrationText; language: AppLanguage; lines: TuningLiveSnapshot['log']; saved?: boolean }) {
  const box = useRef<HTMLOListElement>(null), pinned = useRef(true);
  useEffect(() => { const el = box.current; if (el && pinned.current) el.scrollTop = el.scrollHeight; }, [lines.length]);
  const time = (at: number) => new Date(at).toLocaleTimeString(language, { hour12: false });
  return <section className="tuning-log" aria-label={text.log}>
    <h3>{text.log}</h3>
    {saved && <p className="tuning-muted" data-testid="tuning-log-saved">{text.logSaved}</p>}
    {lines.length ? <ol ref={box} data-testid="tuning-log" onScroll={event => { const el = event.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
      {lines.map((line, index) => <li key={`${line.at}-${index}`}><time>{time(line.at)}</time><strong>{logLabel(text, line.key)}</strong><span>{describe(text, language, line.detail)}</span></li>)}
    </ol> : <p className="tuning-muted">{text.logEmpty}</p>}
  </section>;
}

/**
 * Vertical dot chart for one swept setting: one column per value, median dot,
 * min–max whisker, current value ringed, chosen value filled, and the line the
 * winner had to clear (current median + 3%).
 */
export function SweepChart({ title, metric, points, minGain, text, language, testId }: { title: string; metric: string; points: SweepPoint[]; minGain: number; text: CalibrationText; language: AppLanguage; testId?: string }) {
  const measured = points.filter(point => point.median != null);
  const width = 360, height = 168, left = 40, right = 10, top = 14, bottom = 34;
  const currentMedian = points.find(point => point.current)?.median ?? null;
  const highs = measured.map(point => point.max ?? point.median!), lows = measured.map(point => point.min ?? point.median!);
  const bar = currentMedian == null ? null : currentMedian * (1 + minGain);
  let lo = Math.min(...lows, ...(bar ? [bar] : [])), hi = Math.max(...highs, ...(bar ? [bar] : []));
  if (!measured.length) { lo = 0; hi = 1; }
  const pad = Math.max((hi - lo) * 0.15, hi * 0.02, 0.5); lo = Math.max(0, lo - pad); hi += pad;
  const x = (index: number) => left + (points.length <= 1 ? (width - left - right) / 2 : index * (width - left - right) / (points.length - 1));
  const y = (value: number) => top + (1 - (value - lo) / (hi - lo)) * (height - top - bottom);
  const label = (value: number) => value < 0 ? text.auto : Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, '');
  return <figure className="tuning-sweep" data-testid={testId} aria-label={`${title} · ${metric}`}>
    <figcaption><strong>{title}</strong><span>{metric}</span></figcaption>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}: ${measured.map(point => `${label(point.value)} ${formatRate(point.median, language)}`).join(', ')}`}>
      <line className="tuning-sweep-axis" x1={left} x2={width - right} y1={height - bottom} y2={height - bottom}/>
      {measured.length ? <>
        <text className="tuning-sweep-tick" x={left - 6} y={y(hi) + 4} textAnchor="end">{formatRate(hi, language, 0)}</text>
        <text className="tuning-sweep-tick" x={left - 6} y={y(lo) + 4} textAnchor="end">{formatRate(lo, language, 0)}</text>
      </> : <text className="tuning-sweep-tick" x={(left + width - right) / 2} y={(top + height - bottom) / 2} textAnchor="middle">{text.pending}</text>}
      {bar != null && <g className="tuning-sweep-bar"><line x1={left} x2={width - right} y1={y(bar)} y2={y(bar)}/><text x={width - right} y={y(bar) - 4} textAnchor="end">{text.minGainLine}</text></g>}
      {points.map((point, index) => <g key={point.value} className={`tuning-sweep-point${point.chosen ? ' is-chosen' : ''}${point.current ? ' is-current' : ''}${point.excluded ? ' is-excluded' : ''}`}>
        {point.min != null && point.max != null && point.max > point.min && <line className="tuning-sweep-whisker" x1={x(index)} x2={x(index)} y1={y(point.max)} y2={y(point.min)}/>}
        {point.median != null ? <circle cx={x(index)} cy={y(point.median)} r={point.chosen ? 5.5 : 4.5}><title>{`${label(point.value)} · ${text.median} ${formatRate(point.median, language)} · ${text.range} ${formatRate(point.min, language)}–${formatRate(point.max, language)} · ${point.samples} ${text.samples}`}</title></circle>
          : point.excluded ? <text className="tuning-sweep-excluded" x={x(index)} y={height - bottom - 6} textAnchor="middle">×</text> : <circle className="tuning-sweep-pending" cx={x(index)} cy={height - bottom - 8} r={2.5}/>}
        <text className="tuning-sweep-value" x={x(index)} y={height - bottom + 15} textAnchor="middle">{label(point.value)}</text>
        {(point.current || point.chosen) && <text className="tuning-sweep-mark" x={x(index)} y={height - bottom + 28} textAnchor="middle">{point.chosen ? text.chosen : text.current}</text>}
      </g>)}
    </svg>
  </figure>;
}

/** The same numbers as the chart, readable and copyable. */
export function SweepTable({ points, text, language }: { points: SweepPoint[]; text: CalibrationText; language: AppLanguage }) {
  return <table className="st-table tuning-sweep-table"><thead><tr><th>{text.parameter}</th><th>{text.median}</th><th>{text.range}</th><th>{text.samples}</th><th/></tr></thead>
    <tbody>{points.map(point => <tr key={point.value} className={point.chosen ? 'is-chosen' : ''}><td>{point.value < 0 ? text.auto : point.value}</td><td>{formatRate(point.median, language)}</td><td>{point.min == null ? '—' : `${formatRate(point.min, language)}–${formatRate(point.max, language)}`}</td><td>{point.samples}</td><td>{[point.current ? text.current : '', point.chosen ? text.chosen : '', point.excluded ? text.excluded : ''].filter(Boolean).join(' · ')}</td></tr>)}</tbody></table>;
}
