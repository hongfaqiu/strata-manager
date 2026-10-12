import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ContextBenchmarkSample } from '@strata-manager/core';

export const contextTierLabel = (tokens: number) => tokens >= 1024 * 1024 && tokens % (1024 * 1024) === 0
  ? `${tokens / (1024 * 1024)}M` : tokens % 1024 === 0 ? `${tokens / 1024}K` : tokens.toLocaleString();

type ChartRow = { tier: number; prefill: number | null; decode: number | null; wall: number | null };
type ChartMetric = { key: 'prefill' | 'decode' | 'wall'; title: string; unit: string };

function ContextMetricChart({ rows, metric, language }: { rows: ChartRow[]; metric: ChartMetric; language: 'zh-CN' | 'en' }) {
  const chart = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(360);
  const titleId = useId();
  useEffect(() => {
    if (!chart.current) return;
    const observer = new ResizeObserver(entries => {
      const nextWidth = Math.round(entries[0]?.contentRect.width ?? 0);
      if (nextWidth > 0) setWidth(nextWidth);
    });
    observer.observe(chart.current);
    return () => observer.disconnect();
  }, []);
  const format = (value: number) => value.toLocaleString(language, { maximumFractionDigits: 1 });
  const dense = rows.length > 6;
  const left = 48, right = width - 32, top = 38, bottom = 180, height = dense ? 264 : 238;
  const maximum = Math.max(0, ...rows.map(row => row[metric.key] ?? 0));
  const scale = maximum > 0 ? 10 ** Math.floor(Math.log10(maximum)) : 1;
  const limit = maximum > 0 ? Math.ceil(maximum * 1.12 / scale * 2) / 2 * scale : 1;
  const x = (index: number) => rows.length < 2 ? (left + right) / 2 : left + index / (rows.length - 1) * (right - left);
  const y = (value: number) => bottom - value / limit * (bottom - top);
  const segments: { x: number; y: number }[][] = [];
  let segment: { x: number; y: number }[] = [];
  rows.forEach((row, index) => {
    const value = row[metric.key];
    if (value === null) { if (segment.length) segments.push(segment); segment = []; }
    else segment.push({ x: x(index), y: y(value) });
  });
  if (segment.length) segments.push(segment);
  const lines = segments.map(points => points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(''));
  const areas = segments.flatMap((points, index) => points.length > 1 ? [`${lines[index]}L${points.at(-1)!.x},${bottom}L${points[0]!.x},${bottom}Z`] : []);
  const axisFormat = (value: number) => value >= 1000 ? `${format(value / 1000)}k` : format(value);
  // Keep every measured value visible without relying on hover, including dense 1M runs.
  const valueLabels: { x: number; y: number; width: number }[] = [];
  rows.forEach((row, index) => {
    const value = row[metric.key], px = x(index), py = value === null ? bottom : y(value);
    const labelWidth = (value === null ? 1 : format(value).length) * 8;
    const labelX = Math.max(left + labelWidth / 2, Math.min(right - labelWidth / 2, px));
    const candidates = [-12, -34, -56, 24, 46, 68].map(offset => py + offset).filter(position => position >= 14 && position < bottom - 5);
    const labelY = candidates.find(position => !valueLabels.some(label => Math.abs(labelX - label.x) < (labelWidth + label.width) / 2 + 4 && Math.abs(position - label.y) < 21)) ?? candidates[0] ?? 14;
    valueLabels.push({ x: labelX, y: labelY, width: labelWidth });
  });
  return <section className={`context-benchmark-chart context-benchmark-chart--${metric.key}`} aria-label={metric.title}>
    <h3>{metric.title}<span>{metric.unit}</span></h3>
    <div className="context-benchmark-plot" ref={chart}>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-labelledby={titleId}>
        <title id={titleId}>{`${metric.title} (${metric.unit}) · ${rows.map(row => `${contextTierLabel(row.tier)}: ${row[metric.key] === null ? '—' : format(row[metric.key]!)}`).join(', ')}`}</title>
        {[0, 1, 2, 3].map(tick => {
          const value = limit * tick / 3, position = y(value);
          return <g key={tick}><line className="context-benchmark-grid" x1={left} x2={right} y1={position} y2={position}/>{rows.length > 0 && <text className="context-benchmark-axis" x={left - 9} y={position + 4} textAnchor="end">{axisFormat(value)}</text>}</g>;
        })}
        <path className="context-benchmark-area" d={areas.join('')} fill="currentColor" opacity=".12"/>
        <path className="context-benchmark-line" d={lines.join('')} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
        {rows.map((row, index) => {
          const value = row[metric.key], px = x(index), py = value === null ? bottom : y(value);
          return <g key={row.tier} className="context-benchmark-point">
            {value !== null && <circle cx={px} cy={py} r="3.5" fill="currentColor"/>}
            <text className="context-benchmark-value" x={valueLabels[index]!.x} y={valueLabels[index]!.y} textAnchor="middle">{value === null ? '—' : format(value)}</text>
            <text className="context-benchmark-axis context-benchmark-tier" x={px} y={bottom + 23} textAnchor={dense ? 'end' : 'middle'} transform={dense ? `rotate(${width < 360 ? -70 : -55} ${px} ${bottom + 23})` : undefined}>{contextTierLabel(row.tier)}</text>
          </g>;
        })}
        {!rows.length && <text className="context-benchmark-axis" x={(left + right) / 2} y={(top + bottom) / 2} textAnchor="middle">{language === 'zh-CN' ? '完成首个档位后显示' : 'Results appear after the first tier'}</text>}
      </svg>
    </div>
  </section>;
}

export function ContextBenchmarkCharts({ samples, language }: { samples: ContextBenchmarkSample[]; language: 'zh-CN' | 'en' }) {
  const zh = language === 'zh-CN';
  const rows = useMemo(() => {
    const tiers = [...new Set(samples.map(sample => sample.targetTokens))].sort((a, b) => a - b);
    return tiers.map(tier => {
      const completed = samples.filter(sample => sample.targetTokens === tier && sample.state === 'completed');
      const average = (read: (sample: ContextBenchmarkSample) => number | null) => {
        const values = completed.map(read).filter((value): value is number => value !== null && Number.isFinite(value));
        return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      };
      return { tier, prefill: average(sample => sample.prefillTokS), decode: average(sample => sample.decodeTokS), wall: average(sample => sample.wallMs / 1000) };
    });
  }, [samples]);
  const metrics = [
    { key: 'prefill', title: zh ? '预填充速度' : 'Prefill speed', unit: 'tok/s' },
    { key: 'decode', title: zh ? '解码速度' : 'Decode speed', unit: 'tok/s' },
    { key: 'wall', title: zh ? '请求耗时' : 'Request duration', unit: 's' },
  ] as const;
  return <div className="context-benchmark-charts">{metrics.map(metric => <ContextMetricChart key={metric.key} rows={rows} metric={metric} language={language}/>)}</div>;
}
