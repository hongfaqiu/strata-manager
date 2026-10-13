import type { FloatingMonitorMetric, MetricSnapshot } from '@strata-manager/core';

export type MonitorValues = Record<FloatingMonitorMetric, number | null>;
export interface MonitorPoint { at: number; values: MonitorValues }
export interface MonitorHistory { identity: string; points: MonitorPoint[] }
const number = (v: unknown, max = Infinity) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
const gib = (v: unknown) => number(v) === null ? null : (v as number) / 1073741824;

/** Display may use labelled last-request values; graphs contain only current samples. */
export function monitorValues(metric?: MetricSnapshot, loaded = false, live = true): MonitorValues {
  const throughput = loaded && metric && !['unloaded', 'loading', 'unloading'].includes(metric.state);
  return {
    generation: throughput && (!live || metric.state === 'generating') ? number(metric.decodeTokS) : null,
    prefill: throughput && (!live || ['reading', 'prefill'].includes(metric.state)) ? number(metric.prefillTokS) : null,
    gpu: number(metric?.gpuUtil, 100), vram: gib(metric?.gpuMemoryUsed), cpu: number(metric?.cpuUtil, 100), ram: gib(metric?.ramUsed),
    temperature: number(metric?.gpuTemperature), power: number(metric?.gpuPower), running: number(metric?.running), queued: number(metric?.queued),
    // This is one completed request, not a live hardware series.
    cache: !live && loaded && number(metric?.cacheHitRate, 1) !== null ? metric!.cacheHitRate! * 100 : null,
  };
}

export function appendMonitorHistory(previous: MonitorHistory, identity: string, at: number, metric?: MetricSnapshot, loaded = false): MonitorHistory {
  const points = previous.identity === identity ? previous.points : [];
  if (!Number.isFinite(at) || at <= 0 || (points.at(-1)?.at ?? 0) >= at) return previous.identity === identity ? previous : { identity, points: [] };
  return { identity, points: [...points, { at, values: monitorValues(metric, loaded) }].filter(point => at - point.at <= 180000).slice(-60) };
}
