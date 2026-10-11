import type { MetricSnapshot } from '@strata-manager/core';

export interface TelemetryPoint { at: number; decode: number | null; prefill: number | null; gpu: number | null }
export interface TelemetryHistory { identity: string; points: TelemetryPoint[] }
export type TelemetrySeries = 'decode' | 'prefill' | 'gpu';

export const telemetryNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function telemetryPoint(at: number, metric?: MetricSnapshot, loaded?: boolean): TelemetryPoint {
  return {
    at,
    // Idle decodeTokS is the previous request's rate; it is not a new speed sample.
    decode: loaded === true && metric?.state === 'generating' ? telemetryNumber(metric.decodeTokS) : null,
    prefill: loaded === true && ['reading', 'prefill'].includes(metric?.state ?? '') ? telemetryNumber(metric?.prefillTokS) : null,
    gpu: telemetryNumber(metric?.gpuUtil),
  };
}

export function appendTelemetry(previous: TelemetryHistory, identity: string, point: TelemetryPoint): TelemetryHistory {
  const points = previous.identity === identity ? previous.points : [];
  if (!Number.isFinite(point.at) || point.at <= 0 || (points.at(-1)?.at ?? 0) >= point.at) return previous.identity === identity ? previous : { identity, points: [] };
  return { identity, points: [...points, point].filter(sample => point.at - sample.at <= 180_000).slice(-60) };
}

/** Preserve missing-sample gaps and the actual time distance between samples. */
export function telemetrySparkline(points: TelemetryPoint[], series: TelemetrySeries, ceiling?: number) {
  const valid = points.filter(point => telemetryNumber(point[series]) !== null);
  const max = ceiling ?? Math.max(1, ...valid.map(point => point[series]!));
  const from = points[0]?.at ?? 0, to = points.at(-1)?.at ?? from;
  const paths: string[] = [];
  let path = '';
  let last: { x: number; y: number } | undefined;
  for (const point of points) {
    const value = telemetryNumber(point[series]);
    if (value === null) { if (path) paths.push(path); path = ''; continue; }
    const x = to > from ? 4 + (point.at - from) / (to - from) * 152 : 80;
    const y = 44 - Math.min(1, value / max) * 38;
    path += `${path ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `;
    last = { x, y };
  }
  if (path) paths.push(path);
  return { paths, last, count: valid.length };
}
