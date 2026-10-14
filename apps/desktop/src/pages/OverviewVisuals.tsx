import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, Cpu, Layers3, Workflow } from 'lucide-react';
import type { AppLanguage, MetricSnapshot } from '@strata-manager/core';
import { Chart } from '../components';
import computeRig from '../assets/overview-compute-rig.webp';
import './overview-visuals.css';

const known = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const clamp = (value: number) => Math.min(100, Math.max(0, value));

export type OverviewArtState =
  | 'disconnected'
  | 'connecting'
  | 'loading'
  | 'unloading'
  | 'unloaded'
  | 'idle'
  | 'generating'
  | 'reading'
  | 'queued'
  | 'offline'
  | 'unknown';

/** TEMPORARY: ?artDemo=1 | #artDemo=1 | localStorage artDemo=1 — cycle hero art for screen recording */
const ART_DEMO_CYCLE: OverviewArtState[] = [
  'disconnected', 'connecting', 'loading', 'idle', 'generating', 'reading', 'queued', 'unloading', 'offline',
];
function artDemoEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).get('artDemo') === '1') return true;
    if (/(?:^|[?#&])artDemo=1(?:&|$)/.test(window.location.hash)) return true;
    if (window.localStorage.getItem('artDemo') === '1') return true;
  } catch { /* ignore */ }
  return false;
}

export function OverviewComputeIllustration({ status = 'disconnected' }: { status?: OverviewArtState | string }) {
  const demo = artDemoEnabled();
  const [demoIndex, setDemoIndex] = useState(0);
  useEffect(() => {
    if (!demo) return;
    const id = window.setInterval(() => setDemoIndex((i) => (i + 1) % ART_DEMO_CYCLE.length), 2000);
    return () => window.clearInterval(id);
  }, [demo]);
  const state = demo ? ART_DEMO_CYCLE[demoIndex] : (status || 'disconnected');
  return (
    <div className="overview-compute-art" data-state={state} aria-hidden="true">
      <div className="overview-compute-stage">
        <span className="overview-compute-halo" />
        <span className="overview-compute-orbit overview-compute-orbit-a" />
        <span className="overview-compute-orbit overview-compute-orbit-b" />
        <span className="overview-compute-scan" />
        <span className="overview-compute-beam overview-compute-beam-a" />
        <span className="overview-compute-beam overview-compute-beam-b" />
        <span className="overview-compute-spark overview-compute-spark-a" />
        <span className="overview-compute-spark overview-compute-spark-b" />
        <span className="overview-compute-spark overview-compute-spark-c" />
        <img src={computeRig} alt="" draggable={false} decoding="async" />
      </div>
    </div>
  );
}

export function OverviewResourceMeter({ label, used, total, language, tone = 'green', units = 'bytes' }: { label: string; used: number | null | undefined; total: number | null | undefined; language: AppLanguage; tone?: 'green' | 'blue'; units?: 'bytes' | 'tokens' }) {
  const percentage = known(used) && used >= 0 && known(total) && total > 0 ? clamp(used / total * 100) : null;
  const format = (value: number | null | undefined) => known(value) ? (units === 'bytes' ? value / 1024 ** 3 : value).toLocaleString(language, { maximumFractionDigits: units === 'bytes' ? 1 : 0 }) : '—';
  const style = { '--overview-share': `${percentage ?? 0}%` } as CSSProperties;
  return <div className={`overview-resource-meter tone-${tone} units-${units}`}>
    <div className="overview-resource-ring" style={style} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage ?? undefined} aria-valuetext={percentage === null ? language === 'zh-CN' ? '暂无数据' : 'No data' : `${Math.round(percentage)}%; ${format(used)} / ${format(total)} ${units === 'bytes' ? 'GB' : 'tokens'}`}>
      <span aria-hidden="true">{percentage === null ? '—' : Math.round(percentage)}{percentage !== null && <small>%</small>}</span>
    </div>
    <div className="overview-resource-meter-copy"><span>{label}</span><strong>{format(used)} <small>/ {format(total)} {units === 'bytes' ? 'GB' : 'tokens'}</small></strong></div>
  </div>;
}

export function OverviewMetricCards({ metric, language }: { metric?: MetricSnapshot; language: AppLanguage }) {
  const { t } = useTranslation();
  const zh = language === 'zh-CN';
  const format = (value: number | null | undefined, digits = 1) => known(value) ? value.toLocaleString(language, { maximumFractionDigits: digits }) : '—';
  const recent = [...(metric?.requests ?? [])].filter(request => known(request.time)).sort((a, b) => (a.time as number) - (b.time as number)).slice(-12);
  const speedValues = recent.map(request => known(request.decode_tok_s) && request.decode_tok_s >= 0 ? request.decode_tok_s : null);
  const hasSpeedHistory = speedValues.filter(known).length >= 2;
  const generationLabel = metric && metric.state !== 'generating' ? zh ? '最近生成' : 'Last generation' : t('decode');
  const generationCandidate = metric?.state === 'generating' ? metric.decodeTokS : recent.at(-1)?.decode_tok_s;
  const generationSpeed = known(generationCandidate) && generationCandidate >= 0 ? generationCandidate : null;
  const gpu = known(metric?.gpuUtil) ? clamp(metric.gpuUtil) : null;
  const empty = !metric;
  return <div className={`overview-visual-metrics${empty ? ' is-empty' : ''}`} data-empty={empty ? 'true' : undefined}>
    <div className="overview-visual-metric overview-metric-speed">
      <div className="overview-visual-metric-label"><span className="overview-metric-symbol"><Activity size={17} /></span><span>{generationLabel}</span></div>
      <div className="overview-visual-metric-value">{format(generationSpeed)}<small>tok/s</small></div>
      {hasSpeedHistory ? <div className="overview-speed-plot"><Chart values={speedValues} label={zh ? '近期已完成请求的生成速度' : 'Generation speed of recent completed requests'} unit="tok/s" /></div> : <Activity className="overview-metric-decor" size={47} strokeWidth={1.2} aria-hidden="true" />}
    </div>
    <div className="overview-visual-metric overview-metric-gpu">
      <div className="overview-visual-metric-label"><span className="overview-metric-symbol"><Cpu size={17} /></span><span>{t('gpuUtil')}</span></div>
      <div className="overview-visual-metric-value">{format(metric?.gpuUtil)}<small>%</small></div>
      <div className="overview-gpu-dial" style={{ '--overview-share': `${gpu ?? 0}%` } as CSSProperties} aria-hidden="true"><Cpu size={24} strokeWidth={1.3} /></div>
    </div>
    <div className="overview-visual-metric overview-metric-running">
      <div className="overview-visual-metric-label"><span className="overview-metric-symbol"><Workflow size={17} /></span><span>{t('activeRequests')}</span></div>
      <div className="overview-visual-metric-value">{format(metric?.running, 0)}</div><Workflow className="overview-metric-decor" size={47} strokeWidth={1.2} aria-hidden="true" />
    </div>
    <div className="overview-visual-metric overview-metric-queue">
      <div className="overview-visual-metric-label"><span className="overview-metric-symbol"><Layers3 size={17} /></span><span>{t('queued')}</span></div>
      <div className="overview-visual-metric-value">{format(metric?.queued, 0)}</div><Layers3 className="overview-metric-decor" size={47} strokeWidth={1.2} aria-hidden="true" />
    </div>
  </div>;
}
