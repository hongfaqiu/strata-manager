import type { AppLanguage } from "@strata-manager/core";
import { useEffect, useRef, useState } from 'react';
import type { ApiTrendBucket, ApiUsageTrends } from '@strata-manager/core';
import { apiUsageStrings } from './ApiUsageStrings';
import './api-usage-charts.css';

export type ChartColor = 'accent' | 'blue' | 'gold' | 'danger' | 'violet' | 'muted';
export interface ChartSeries {
  key: keyof ApiTrendBucket;
  label: string;
  color: ChartColor;
  samples?: keyof ApiTrendBucket;
  /** A count rate uses 60_000 / bucketMs. Boundary buckets use their actual covered duration. */
  scale?: number;
}
export interface UsageChartProps {
  trends: ApiUsageTrends;
  language: AppLanguage;
  title: string;
  series: ChartSeries[];
  mode?: 'line' | 'stack';
  percentage?: boolean;
  unit?: string;
  range?: { startMs: number; endMs: number };
  inspectedAt?: number | null;
  onInspect?: (startMs: number | null) => void;
}

const knownMetric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export const bucketMetric = (bucket: ApiTrendBucket, key: keyof ApiTrendBucket): number | null => {
  const value = bucket[key];
  return knownMetric(value) ? value : null;
};

const metricSamples: Partial<Record<keyof ApiTrendBucket, keyof ApiTrendBucket>> = {
  inputTokens: 'inputTokenSamples', outputTokens: 'outputTokenSamples',
  firstTokenS: 'firstTokenSamples', durationS: 'durationSamples',
  prefillTokS: 'prefillSamples', decodeTokS: 'decodeSamples',
  cacheHitRate: 'cacheRateSamples', expertCacheHitRate: 'expertCacheSamples',
};
const countMetrics = new Set<keyof ApiTrendBucket>(['requests', 'succeeded', 'failed', 'cancelled', 'interrupted', 'pending']);
const niceMaximum = (value: number) => {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * magnitude;
};
type ChartPoint = { x: number; y: number };
const linePath = (points: ChartPoint[]) => points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
const areaPath = (points: ChartPoint[], bottom: number) => !points.length ? '' : `${linePath(points)} L${points.at(-1)!.x.toFixed(2)},${bottom} L${points[0]!.x.toFixed(2)},${bottom} Z`;

export function UsageChart({ trends, language, title, series, mode = 'line', percentage = false, unit = '', range, inspectedAt, onInspect }: UsageChartProps) {
  const text = apiUsageStrings[(language === 'zh-CN' ? 'zh-CN' : 'en')];
  const [localInspection, setLocalInspection] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Set<keyof ApiTrendBucket>>(() => new Set());
  const [chartWidth, setChartWidth] = useState(600);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setChartWidth(Math.max(240, element.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const activeInspection = inspectedAt === undefined ? localInspection : inspectedAt;
  const bucketMs = Math.max(1, trends.bucketMs);
  const sortedBuckets = [...trends.buckets].sort((a, b) => a.startMs - b.startMs);
  const startMs = range?.startMs ?? sortedBuckets[0]?.startMs ?? 0;
  const endMs = Math.max(startMs + 1, range?.endMs ?? ((sortedBuckets.at(-1)?.startMs ?? startMs) + bucketMs));
  const buckets = sortedBuckets.filter(bucket => bucket.startMs < endMs && bucket.startMs + bucketMs > startMs);
  const visibleSeries = series.filter(item => !hidden.has(item.key));
  const duration = (bucket: ApiTrendBucket) => Math.max(0, Math.min(endMs, bucket.startMs + bucketMs) - Math.max(startMs, bucket.startMs));
  const metric = (bucket: ApiTrendBucket, item: ChartSeries): number | null => {
    const sampleKey = item.samples ?? metricSamples[item.key];
    if (sampleKey && (bucketMetric(bucket, sampleKey) ?? 0) <= 0) return null;
    const value = bucketMetric(bucket, item.key);
    if (value === null) return null;
    const scale = knownMetric(item.scale) ? item.scale : 1;
    const covered = duration(bucket);
    return value * scale * (item.scale !== undefined && countMetrics.has(item.key) && covered > 0 ? bucketMs / covered : 1);
  };
  const total = (bucket: ApiTrendBucket) => visibleSeries.reduce((sum, item) => sum + (metric(bucket, item) ?? 0), 0);
  const valid = (bucket: ApiTrendBucket) => mode === 'stack' ? total(bucket) > 0 : visibleSeries.some(item => metric(bucket, item) !== null);
  const fallback = buckets.reduce((last, bucket, index) => valid(bucket) ? index : last, -1);
  // Rolling ranges can move the bucket boundaries while the pointer stays still.
  const inspectedIndex = activeInspection === null ? -1 : buckets.reduce((nearest, bucket, index) =>
    nearest < 0 || Math.abs(bucket.startMs - activeInspection) < Math.abs(buckets[nearest]!.startMs - activeInspection) ? index : nearest, -1);
  const selectedIndex = activeInspection === null ? fallback : inspectedIndex;
  const selected = buckets[selectedIndex];
  const rawMaximum = mode === 'stack' ? Math.max(0, ...buckets.map(total)) : Math.max(0, ...buckets.flatMap(bucket => visibleSeries.map(item => metric(bucket, item) ?? 0)));
  const maximum = percentage ? 1 : niceMaximum(rawMaximum);
  const daily = bucketMs >= 86_400_000;
  const left = 56, top = 10, width = chartWidth - left - 10, height = 146, bottom = top + height;
  const timestampX = (timestamp: number) => left + (timestamp - startMs) / (endMs - startMs) * width;
  const bucketCenter = (bucket: ApiTrendBucket) => Math.max(startMs, bucket.startMs) + duration(bucket) / 2;
  const x = (index: number) => timestampX(bucketCenter(buckets[index]!));
  const y = (value: number) => bottom - Math.min(maximum, value) / maximum * height;
  const time = (value: number, axis = false) => new Date(value).toLocaleString(language, daily
    ? { month: '2-digit', day: '2-digit' }
    : axis && endMs - startMs <= 86_400_000 ? { hour: '2-digit', minute: '2-digit' }
      : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const format = (value: number | null, includeUnit = true) => value === null ? '—' : percentage
    ? `${(value * 100).toLocaleString(language, { maximumFractionDigits: 1 })}%`
    : `${value.toLocaleString(language, { maximumFractionDigits: unit || value < 1 ? 2 : 0 })}${unit && includeUnit ? ` ${unit}` : ''}`;
  const axis = (value: number) => percentage ? `${Math.round(value * 100)}%` : value.toLocaleString(language, { notation: 'compact', maximumFractionDigits: 2 });
  const interval = bucketMs < 3_600_000
    ? (language === 'zh-CN' ? `每 ${Math.round(bucketMs / 60_000)} 分钟` : `Every ${Math.round(bucketMs / 60_000)} min`)
    : daily ? (bucketMs === 86_400_000 ? text.chartDaily : language === 'zh-CN' ? `每 ${Math.round(bucketMs / 86_400_000)} 天` : `Every ${Math.round(bucketMs / 86_400_000)} days`)
      : bucketMs === 3_600_000 ? text.chartHourly : language === 'zh-CN' ? `每 ${Math.round(bucketMs / 3_600_000)} 小时` : `Every ${Math.round(bucketMs / 3_600_000)} hours`;
  const hasData = fallback >= 0;
  const description = selected
    ? `${title}; ${time(Math.max(startMs, selected.startMs))}; ${visibleSeries.map(item => `${item.label}: ${format(metric(selected, item))}`).join('; ')}`
    : `${title}; ${text.chartNoSamples}`;
  const inspect = (timestamp: number | null) => { setLocalInspection(timestamp); onInspect?.(timestamp); };
  const inspectPointer = (clientX: number, element: HTMLElement) => {
    if (!buckets.length) return;
    const bounds = element.getBoundingClientRect();
    const position = Math.max(0, Math.min(1, ((clientX - bounds.left) / bounds.width * chartWidth - left) / width));
    const timestamp = startMs + position * (endMs - startMs);
    const containing = buckets.findIndex(bucket => timestamp >= bucket.startMs && timestamp < bucket.startMs + bucketMs);
    if (containing >= 0) { inspect(buckets[containing]!.startMs); return; }
    let nearest = 0;
    for (let index = 1; index < buckets.length; index++) {
      if (Math.abs(bucketCenter(buckets[index]!) - timestamp) < Math.abs(bucketCenter(buckets[nearest]!) - timestamp)) nearest = index;
    }
    inspect(buckets[nearest]!.startMs);
  };
  const segments = (item: ChartSeries) => {
    const result: ChartPoint[][] = [];
    let drawing: ChartPoint[] = [];
    buckets.forEach((bucket, index) => {
      const value = metric(bucket, item);
      const missingInterval = index > 0 && bucket.startMs - buckets[index - 1]!.startMs > bucketMs;
      if (value === null || missingInterval) { if (drawing.length) result.push(drawing); drawing = []; }
      if (value !== null) drawing.push({ x: x(index), y: y(value) });
    });
    if (drawing.length) result.push(drawing);
    return result;
  };

  return <div className="api-metric-chart api-usage-chart-v2">
    <div className="api-metric-chart-meta"><span>{interval}{unit ? ` · ${unit}` : ''}</span><span>{selected ? `${activeInspection === null ? (language === 'zh-CN' ? '最近有效' : 'Latest known') : text.chartBucket}: ${time(Math.max(startMs, selected.startMs))}` : text.chartNoSamples}</span></div>
    <div className="api-metric-chart-interaction" ref={viewport} tabIndex={0} role="group" aria-label={description}
      onPointerMove={event => inspectPointer(event.clientX, event.currentTarget)}
      onClick={event => inspectPointer(event.clientX, event.currentTarget)}
      onPointerLeave={() => inspect(null)} onBlur={() => inspect(null)}
      onKeyDown={event => {
        if (event.key === 'Escape') { inspect(null); return; }
        if (!buckets.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const current = selectedIndex < 0 ? 0 : selectedIndex;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buckets.length - 1 : Math.max(0, Math.min(buckets.length - 1, current + (event.key === 'ArrowLeft' ? -1 : 1)));
        inspect(buckets[next]!.startMs);
      }}>
      <svg viewBox={`0 0 ${chartWidth} 188`} role="img" aria-label={description}>
        {[0, 0.25, 0.5, 0.75, 1].map(fraction => <g key={fraction} className="api-metric-grid"><line x1={left} x2={left + width} y1={y(maximum * fraction)} y2={y(maximum * fraction)}/><text x={left - 8} y={y(maximum * fraction) + 3.5} textAnchor="end">{axis(maximum * fraction)}</text></g>)}
        {[0, 0.25, 0.5, 0.75, 1].map(fraction => <line key={fraction} className="api-metric-grid-vertical" x1={left + width * fraction} x2={left + width * fraction} y1={top} y2={bottom}/>)}
        {mode === 'stack' ? buckets.map((bucket, index) => {
          let offset = 0;
          const barWidth = Math.max(0.6, duration(bucket) / (endMs - startMs) * width * 0.75);
          return <g key={bucket.startMs}>{visibleSeries.map(item => {
            const value = metric(bucket, item) ?? 0;
            const start = offset; offset += value;
            return value > 0 ? <rect key={item.key} className={`api-chart-color-${item.color}`} x={x(index) - barWidth / 2} y={y(offset)} width={barWidth} height={Math.max(0, y(start) - y(offset))}/> : null;
          })}</g>;
        }) : visibleSeries.map(item => <g key={item.key} className={`api-chart-color-${item.color}`}>
          {segments(item).map((points, index) => <g key={index}><path className="api-metric-area" d={areaPath(points, bottom)}/><path className="api-metric-line" d={linePath(points)}/>{points.length === 1 && <circle cx={points[0]!.x} cy={points[0]!.y} r={2}/>}</g>)}
          {selected && metric(selected, item) !== null && <circle className="api-metric-selected-point" cx={x(selectedIndex)} cy={y(metric(selected, item)!)} r={3.5}/>}</g>)}
        {selected && <line className="api-metric-cursor" x1={x(selectedIndex)} x2={x(selectedIndex)} y1={top} y2={bottom}/>}
        {[0, 0.5, 1].map(fraction => <text key={fraction} className="api-metric-time-tick" x={left + width * fraction} y={179} textAnchor={fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle'}>{time(startMs + (endMs - startMs) * fraction, true)}</text>)}
      </svg>
      {!hasData && <div className="api-metric-empty-overlay">{!visibleSeries.length ? (language === 'zh-CN' ? '点击图例显示指标' : 'Select a legend to show a metric') : mode === 'stack' ? text.noRequests : text.chartNoSamples}</div>}
    </div>
    <div className="api-metric-legend">{series.map(item => {
      const sampleKey = item.samples ?? metricSamples[item.key];
      return <button type="button" key={item.key} className={hidden.has(item.key) ? 'is-hidden' : ''} aria-pressed={!hidden.has(item.key)}
        aria-label={`${hidden.has(item.key) ? (language === 'zh-CN' ? '显示' : 'Show') : (language === 'zh-CN' ? '隐藏' : 'Hide')} ${item.label}`}
        data-tooltip={sampleKey && selected ? `${text.samples}: ${bucketMetric(selected, sampleKey)?.toLocaleString(language) ?? '—'}` : item.label}
        onClick={() => setHidden(previous => { const next = new Set(previous); if (next.has(item.key)) next.delete(item.key); else next.add(item.key); return next; })}>
        <span className={`api-metric-key api-chart-color-${item.color}`}/><span>{item.label}</span><strong>{selected ? format(metric(selected, item), !countMetrics.has(item.key)) : '—'}</strong>
      </button>;
    })}</div>
    {mode === 'stack' && <div className="api-metric-total">{text.chartTotal}: {buckets.reduce((sum, bucket) => sum + (bucketMetric(bucket, 'requests') ?? 0), 0).toLocaleString(language)}</div>}
  </div>;
}

/** Missing samples split the path; no trace is drawn when the range has no known data. */
export function UsageSparkline({ values, color = 'accent', percentage = false }: { values: (number | null)[]; color?: ChartColor; percentage?: boolean }) {
  const maximum = percentage ? 1 : Math.max(1, ...values.filter(knownMetric));
  const bottom = 40;
  const paths: ChartPoint[][] = [];
  let drawing: ChartPoint[] = [];
  values.forEach((value, index) => {
    if (!knownMetric(value)) { if (drawing.length) paths.push(drawing); drawing = []; return; }
    drawing.push({ x: values.length === 1 ? 100 : index / (values.length - 1) * 200, y: bottom - Math.min(value, maximum) / maximum * 36 });
  });
  if (drawing.length) paths.push(drawing);
  return <svg className={`api-usage-sparkline api-chart-color-${color}`} viewBox="0 0 200 42" preserveAspectRatio="none" aria-hidden="true">
    {paths.map((points, index) => <g key={index}><path className="api-metric-area" d={areaPath(points, bottom)}/><path className="api-metric-line" d={linePath(points)}/>{points.length === 1 && <circle cx={points[0]!.x} cy={points[0]!.y} r={1.8}/>}</g>)}
  </svg>;
}

/** Share of request outcomes as a ring; zero-value outcomes are omitted from the ring but kept in the caller's legend. */
export function OutcomeDonut({ items, label, centerLabel, centerValue }: { items: { label: string; value: number; color: ChartColor }[]; label: string; centerLabel: string; centerValue: string }) {
  const total = items.reduce((sum, item) => sum + (knownMetric(item.value) ? item.value : 0), 0);
  const radius = 42, circumference = 2 * Math.PI * radius, gap = total && items.filter(item => item.value > 0).length > 1 ? 1.6 : 0;
  let offset = 0;
  const description = `${label}: ${items.map(item => `${item.label} ${item.value.toLocaleString()}`).join(', ')}`;
  return <div className="api-usage-donut">
    <svg viewBox="0 0 100 100" role="img" aria-label={description}>
      <circle className="api-usage-donut-track" cx="50" cy="50" r={radius}/>
      {total > 0 && items.map(item => {
        if (!(item.value > 0)) return null;
        const length = item.value / total * circumference, dash = Math.max(0.0001, length - gap);
        const segment = <circle key={item.label} className={`api-usage-donut-segment api-chart-color-${item.color}`} cx="50" cy="50" r={radius} strokeDasharray={`${dash} ${circumference - dash}`} strokeDashoffset={-offset} transform="rotate(-90 50 50)"/>;
        offset += length;
        return segment;
      })}
    </svg>
    <div className="api-usage-donut-center"><strong>{centerValue}</strong><span>{centerLabel}</span></div>
  </div>;
}
