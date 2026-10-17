import './concurrency-chart.css';

export interface ConcurrencyChartItem { key: string; label: string; total: number | null; perRequest: number | null; highlight?: boolean; pending?: boolean }

const fmt = (value: number | null) => value === null ? '—' : value >= 100 ? value.toFixed(0) : value.toFixed(1);

/** Vertical bars for total tok/s with a line for one request's tok/s: never a stacked or horizontal bar. */
export function ConcurrencyChart({ items, zh, ariaLabel }: { items: ConcurrencyChartItem[]; zh: boolean; ariaLabel: string }) {
  const width = 560, height = 220, top = 26, bottom = 34, left = 12, right = 12;
  const plot = height - top - bottom;
  const max = Math.max(1, ...items.flatMap(item => [item.total ?? 0, item.perRequest ?? 0])) * 1.08;
  const slot = (width - left - right) / Math.max(1, items.length);
  const bar = Math.min(64, slot * 0.46);
  const x = (i: number) => left + slot * i + slot / 2;
  const y = (v: number) => top + plot - v / max * plot;
  const line = items.map((item, i) => item.perRequest === null ? null : [x(i), y(item.perRequest)] as const);
  const path = line.reduce((d, point, i) => !point ? d : `${d}${d && line[i - 1] ? 'L' : 'M'}${point[0].toFixed(1)},${point[1].toFixed(1)}`, '');
  return <figure className="concurrency-chart" aria-label={ariaLabel}>
    <figcaption className="concurrency-chart-legend"><span data-series="total">{zh ? '总吞吐 tok/s' : 'Total tok/s'}</span><span data-series="per">{zh ? '单个请求 tok/s' : 'One request tok/s'}</span></figcaption>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" preserveAspectRatio="xMidYMid meet">
      <line className="concurrency-chart-axis" x1={left} x2={width - right} y1={top + plot} y2={top + plot}/>
      {items.map((item, i) => {
        const h = item.total === null ? 0 : item.total / max * plot;
        return <g key={item.key} data-highlight={item.highlight || undefined} data-pending={item.pending || undefined}>
          {item.total !== null ? <rect className="concurrency-chart-bar" x={x(i) - bar / 2} y={top + plot - h} width={bar} height={Math.max(1, h)} rx={4}/> : <rect className="concurrency-chart-ghost" x={x(i) - bar / 2} y={top + plot - 24} width={bar} height={24} rx={4}/>}
          <text className="concurrency-chart-value" x={x(i)} y={(item.total === null ? top + plot - 24 : top + plot - h) - 6} textAnchor="middle">{fmt(item.total)}</text>
          <text className="concurrency-chart-label" x={x(i)} y={height - 12} textAnchor="middle">{item.label}</text>
        </g>;
      })}
      {path && <path className="concurrency-chart-line" d={path}/>}
      {line.map((point, i) => point && <g key={`p${i}`}><circle className="concurrency-chart-dot" cx={point[0]} cy={point[1]} r={4}/><text className="concurrency-chart-per" x={point[0] + bar / 2 + 4} y={point[1] + 4}>{fmt(items[i]!.perRequest)}</text></g>)}
    </svg>
  </figure>;
}
