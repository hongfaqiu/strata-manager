/** Pure view helpers for history/upgrade comparison. No React. */

export type ComparisonMetricKey =
  | 'ttftMs' | 'firstVisibleMs' | 'wallMs' | 'prefillTokS' | 'decodeTokS'
  | 'cacheHitRate' | 'ramPeak' | 'vramPeak';

export type ComparisonField = {
  key: ComparisonMetricKey;
  nameZh: string;
  nameEn: string;
  unit: string;
  /** When true, a higher numeric value is an improvement. */
  higherBetter: boolean;
  /** Featured in the primary dual-column strip. */
  highlight?: boolean;
};

export const COMPARISON_FIELDS: ComparisonField[] = [
  { key: 'decodeTokS', nameZh: '输出速度', nameEn: 'Decode', unit: 'tok/s', higherBetter: true, highlight: true },
  { key: 'prefillTokS', nameZh: '输入处理', nameEn: 'Prefill', unit: 'tok/s', higherBetter: true, highlight: true },
  { key: 'ttftMs', nameZh: '首 token', nameEn: 'TTFT', unit: 'ms', higherBetter: false, highlight: true },
  { key: 'firstVisibleMs', nameZh: '首正文', nameEn: 'First answer', unit: 'ms', higherBetter: false },
  { key: 'wallMs', nameZh: '总耗时', nameEn: 'Wall time', unit: 'ms', higherBetter: false },
  { key: 'cacheHitRate', nameZh: '缓存命中', nameEn: 'Cache hit', unit: '%', higherBetter: true },
  { key: 'ramPeak', nameZh: 'RAM 峰值', nameEn: 'Peak RAM', unit: 'GiB', higherBetter: false },
  { key: 'vramPeak', nameZh: '显存峰值', nameEn: 'Peak VRAM', unit: 'GiB', higherBetter: false },
];

export type MetricDelta = {
  key: ComparisonMetricKey;
  left: number | null;
  right: number | null;
  /** Signed relative change of B vs A: (B-A)/A. Null when either side missing or A is 0. */
  relative: number | null;
  /** Absolute change B - A in display units (same as formatMetric). */
  absolute: number | null;
  /** Whether B is an improvement over A for this metric. Null when equal or unknown. */
  improved: boolean | null;
};

/** Convert raw metric storage into the unit shown in the UI. */
export function displayMetric(value: number | null, key: ComparisonMetricKey): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (key.endsWith('Peak')) return value / 2 ** 30;
  if (key === 'cacheHitRate') return value * 100;
  return value;
}

export function formatMetric(value: number | null, key: ComparisonMetricKey, language: string): string {
  const shown = displayMetric(value, key);
  return shown === null ? '—' : shown.toLocaleString(language, { maximumFractionDigits: 2 });
}

export type ValueDelta = Pick<MetricDelta, 'relative' | 'absolute' | 'improved'>;

/** Direction-aware B-vs-A change on values already in display units. Shared by the scenario and context comparisons. */
export function valueDelta(a: number | null, b: number | null, higherBetter: boolean): ValueDelta {
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) return { relative: null, absolute: null, improved: null };
  const absolute = b - a;
  const relative = a === 0 ? null : absolute / a;
  const improved = absolute === 0 ? null : higherBetter ? absolute > 0 : absolute < 0;
  return { relative, absolute, improved };
}

export function metricDelta(left: number | null, right: number | null, key: ComparisonMetricKey, higherBetter: boolean): MetricDelta {
  return { key, left, right, ...valueDelta(displayMetric(left, key), displayMetric(right, key), higherBetter) };
}

/** Which side holds the better value for this metric; null on ties or missing values. Matches metricDelta. */
export function metricWinner(delta: Pick<MetricDelta, 'improved'>): 'a' | 'b' | null {
  return delta.improved === null ? null : delta.improved ? 'b' : 'a';
}

/** data-win attribute for one side: 'yes' bold, 'no' muted, undefined on ties or gaps. */
export function winAttr(delta: Pick<MetricDelta, 'improved'>, side: 'a' | 'b'): 'yes' | 'no' | undefined {
  const winner = metricWinner(delta);
  return winner === null ? undefined : winner === side ? 'yes' : 'no';
}

export function deltaTone(improved: boolean | null): 'up' | 'down' | 'flat' {
  return improved === null ? 'flat' : improved ? 'up' : 'down';
}

export function formatValue(value: number | null, language: string, digits = 2): string {
  return value === null || !Number.isFinite(value) ? '—' : value.toLocaleString(language, { maximumFractionDigits: digits });
}

/* Context tier comparison: same metrics per tier, times shown in seconds as on the context page. */
export type ContextComparisonKey = 'decodeTokS' | 'prefillTokS' | 'ttftMs' | 'firstVisibleMs' | 'wallMs' | 'ramPeak' | 'vramPeak';
export type ContextComparisonField = { key: ContextComparisonKey; nameZh: string; nameEn: string; unit: string; higherBetter: boolean; featured?: boolean };

/** Featured: decode and prefill speed plus TTFT at the longest tier both reports measured. */
export const CONTEXT_COMPARISON_FIELDS: ContextComparisonField[] = [
  { key: 'decodeTokS', nameZh: '解码', nameEn: 'Decode', unit: 'tok/s', higherBetter: true, featured: true },
  { key: 'prefillTokS', nameZh: '预填充', nameEn: 'Prefill', unit: 'tok/s', higherBetter: true, featured: true },
  { key: 'ttftMs', nameZh: 'TTFT', nameEn: 'TTFT', unit: 's', higherBetter: false, featured: true },
  { key: 'firstVisibleMs', nameZh: '首正文', nameEn: 'First answer text', unit: 's', higherBetter: false },
  { key: 'wallMs', nameZh: '请求耗时', nameEn: 'Request time', unit: 's', higherBetter: false },
  { key: 'ramPeak', nameZh: 'RAM 峰值', nameEn: 'RAM peak', unit: 'GiB', higherBetter: false },
  { key: 'vramPeak', nameZh: '显存峰值', nameEn: 'VRAM peak', unit: 'GiB', higherBetter: false },
];

export function contextDisplay(value: number | null | undefined, key: ContextComparisonKey): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (key.endsWith('Ms')) return value / 1000;
  if (key.endsWith('Peak')) return value / 2 ** 30;
  return value;
}

type ContextMetricRow = { tier: number; left: Partial<Record<ContextComparisonKey, number | null>>; right: Partial<Record<ContextComparisonKey, number | null>> };

/** Longest tier where both reports have this metric; falls back to the longest tier overall. */
export function featuredTier(rows: ContextMetricRow[], key: ContextComparisonKey): number | null {
  const sorted = [...rows].sort((x, y) => y.tier - x.tier);
  const both = sorted.find(row => contextDisplay(row.left[key], key) !== null && contextDisplay(row.right[key], key) !== null);
  return (both ?? sorted[0])?.tier ?? null;
}

export function formatRelative(relative: number | null, language: string): string {
  if (relative === null || !Number.isFinite(relative)) return '—';
  if (Math.abs(relative) < 0.0005) return '0%';
  const pct = Math.abs(relative * 100).toLocaleString(language, { maximumFractionDigits: Math.abs(relative) < 0.1 ? 1 : 0 });
  return `${relative > 0 ? '+' : '−'}${pct}%`;
}

/** Dual-column bar heights (0–1) for A and B; share the same scale. */
export function dualBarHeights(left: number | null, right: number | null): { a: number; b: number } {
  const a = left === null || !Number.isFinite(left) || left < 0 ? 0 : left;
  const b = right === null || !Number.isFinite(right) || right < 0 ? 0 : right;
  const max = Math.max(a, b, 1e-9);
  return { a: a / max, b: b / max };
}
