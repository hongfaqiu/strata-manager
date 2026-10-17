import type { AppLanguage } from '@strata-manager/core';
import { useEffect, useId, useRef, useState } from 'react';

/** Tracks an element's width so SVG charts draw at true pixel size. */
function useWidth(initial: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(entries => { const next = Math.round(entries[0]?.contentRect.width ?? 0); if (next > 0) setWidth(next); });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}
const niceLimit = (maximum: number) => {
  if (!(maximum > 0)) return 1;
  const scale = 10 ** Math.floor(Math.log10(maximum));
  return Math.ceil(maximum * 1.1 / scale * 2) / 2 * scale;
};

export type RequestPoint = { order: number; label: string; value: number | null; failed: boolean; current?: boolean };

/** One dot per measured request in run order; failures sit on the baseline as crosses. */
export function RequestDotPlot({ points, title, unit, language, emptyText, mean }: {
  points: RequestPoint[]; title: string; unit: string; language: AppLanguage; emptyText: string; mean: number | null;
}) {
  const [ref, width] = useWidth(420);
  const titleId = useId();
  const format = (value: number) => value.toLocaleString(language, { maximumFractionDigits: value < 10 ? 2 : 1 });
  const height = 168, left = 44, right = width - 12, top = 14, bottom = height - 26;
  const values = points.flatMap(point => point.value === null ? [] : [point.value]);
  const limit = niceLimit(Math.max(0, ...values));
  const count = Math.max(points.length, 2);
  const x = (order: number) => left + (count < 2 ? 0.5 : (order - 1) / (count - 1)) * (right - left);
  const y = (value: number) => bottom - value / limit * (bottom - top);
  return <section className="scenario-plot" aria-label={title}>
    <h4>{title}<span>{mean === null ? unit : <>{language === 'zh-CN' ? '均值' : 'Mean'} <strong>{format(mean)}</strong> {unit}</>}</span></h4>
    <div ref={ref} className="scenario-plot-canvas">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-labelledby={titleId}>
        <title id={titleId}>{`${title} (${unit})`}</title>
        {[0, 1, 2].map(tick => { const value = limit * tick / 2, position = y(value); return <g key={tick}><line className="scenario-plot-grid" x1={left} x2={right} y1={position} y2={position}/>{values.length > 0 && <text className="scenario-plot-axis" x={left - 8} y={position + 4} textAnchor="end">{format(value)}</text>}</g>; })}
        {mean !== null && values.length > 1 && <line className="scenario-plot-mean" x1={left} x2={right} y1={y(mean)} y2={y(mean)}/>}
        {points.map(point => point.value === null || point.failed
          ? <g key={point.order} className="scenario-plot-failed"><title>{point.label}</title><path d={`M${x(point.order) - 3.5} ${bottom - 3.5}l7 7m0 -7l-7 7`}/></g>
          : <circle key={point.order} className={`scenario-plot-dot${point.current ? ' is-latest' : ''}`} cx={x(point.order)} cy={y(point.value)} r={point.current ? 4.5 : 3.5}><title>{`${point.label} · ${format(point.value)} ${unit}`}</title></circle>)}
        {points.length > 0 && <><text className="scenario-plot-axis" x={left} y={height - 6}>1</text><text className="scenario-plot-axis" x={right} y={height - 6} textAnchor="end">{points.length}</text></>}
        {!points.length && <text className="scenario-plot-axis" x={(left + right) / 2} y={(top + bottom) / 2 + 4} textAnchor="middle">{emptyText}</text>}
      </svg>
    </div>
  </section>;
}

// Wrap a category label onto two lines when it would collide with neighbours.
const labelWidth = (label: string) => [...label].reduce((n, char) => n + (char.charCodeAt(0) > 255 ? 11.5 : 5.9), 0);
function labelLines(name: string, band: number): string[] {
  if (labelWidth(name) <= band - 6) return [name];
  // Greedy word wrap, at most three lines; CJK names without spaces stay whole.
  const lines: string[] = [];
  for (const word of name.split(' ')) {
    const last = lines.at(-1);
    if (last !== undefined && labelWidth(`${last} ${word}`) <= band - 6) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines.length <= 3 ? lines : [name];
}

/** Vertical columns per scenario: a categorical comparison with exact labels. */
export function ScenarioColumns({ rows, title, unit, language, digits = 1 }: {
  rows: { id: string; name: string; value: number | null }[]; title: string; unit: string; language: AppLanguage; digits?: number;
}) {
  const [ref, width] = useWidth(420);
  const titleId = useId();
  const format = (value: number) => value.toLocaleString(language, { maximumFractionDigits: digits });
  const left = 8, right = width - 8, top = 22;
  const band = (right - left) / Math.max(1, rows.length), bar = Math.min(44, band * 0.5);
  const wrapped = rows.map(row => labelLines(row.name, band));
  // Rotate category labels only when even two-line labels would collide.
  const rotate = wrapped.some(lines => lines.some(line => labelWidth(line) > band - 4));
  const labelSpace = rotate ? Math.min(96, Math.max(...rows.map(row => labelWidth(row.name))) * 0.62 + 18) : 30 + (Math.max(...wrapped.map(lines => lines.length)) - 1) * 13;
  const height = 156 + labelSpace, bottom = height - labelSpace;
  const limit = niceLimit(Math.max(0, ...rows.map(row => row.value ?? 0)));
  return <section className="scenario-plot scenario-columns" aria-label={title}>
    <h4>{title}<span>{unit}</span></h4>
    <div ref={ref} className="scenario-plot-canvas">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-labelledby={titleId}>
        <title id={titleId}>{`${title} (${unit}) · ${rows.map(row => `${row.name}: ${row.value === null ? '—' : format(row.value)}`).join(', ')}`}</title>
        <line className="scenario-plot-grid" x1={left} x2={right} y1={bottom} y2={bottom}/>
        {rows.map((row, index) => {
          const center = left + band * (index + 0.5), barHeight = row.value === null ? 0 : row.value / limit * (bottom - top);
          return <g key={row.id} className="scenario-column">
            {row.value !== null && <rect x={center - bar / 2} y={bottom - barHeight} width={bar} height={Math.max(1, barHeight)} rx="3"/>}
            <text className="scenario-plot-value" x={center} y={bottom - barHeight - 7} textAnchor="middle">{row.value === null ? '—' : format(row.value)}</text>
            {rotate ? <text className="scenario-plot-axis" x={center} y={bottom + 14} textAnchor="end" transform={`rotate(-38 ${center} ${bottom + 14})`}>{row.name}</text>
              : <text className="scenario-plot-axis" x={center} y={bottom + 17} textAnchor="middle">{wrapped[index]!.map((line, lineIndex) => <tspan key={lineIndex} x={center} dy={lineIndex ? 13 : 0}>{line}</tspan>)}</text>}
          </g>;
        })}
      </svg>
    </div>
  </section>;
}
