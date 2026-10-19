import { asObject } from './errors';
import type { JsonObject } from './types';

export interface MetricSnapshot {
  state: string; model: string;
  decodeTokS: number | null; prefillTokS: number | null;
  gpuUtil: number | null; gpuMemoryUsed: number | null; gpuMemoryTotal: number | null;
  gpuTemperature: number | null; gpuPower: number | null; cpuUtil: number | null;
  ramUsed: number | null; ramTotal: number | null; queued: number | null; running: number | null;
  cacheHitRate: number | null; requests: JsonObject[]; history: Record<string, (number | null)[]>; raw: JsonObject;
}
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Loading keeps health.loaded false until READY; it must not hide the in-flight transition. */
export function modelTelemetry(metric: MetricSnapshot | undefined, loaded?: boolean): MetricSnapshot | undefined {
  if (!metric) return undefined;
  const transitioning = metric.state === 'loading' || metric.state === 'unloading';
  if (!transitioning && loaded !== false) return metric;
  return { ...metric, state: transitioning ? metric.state : 'unloaded', decodeTokS: null, prefillTokS: null, cacheHitRate: null };
}

/** Memory values retain upstream bytes; throughput is tokens/sec. Never infer online from missing fields. */
export function normalizeMetrics(value: unknown): MetricSnapshot {
  const raw = asObject(value), live = asObject(raw.live), hw = asObject(raw.hardware), engine = asObject(raw.engine);
  const requests = Array.isArray(raw.requests) ? raw.requests.filter(x => x !== null && typeof x === 'object' && !Array.isArray(x)).map(asObject) : [];
  const last = requests[0];
  const state = typeof live.state === 'string' ? live.state : 'unknown';
  // The official telemetry sampler sums memory/power, averages utilization and takes the hottest temperature.
  // Prefer its already computed aggregates; retain raw per-card records for detailed presentation.
  const gpus = Array.isArray(hw.gpus) ? hw.gpus.map(asObject) : [];
  const gpuMetric = (aggregate: string, perCard: string, mode: 'sum' | 'mean' | 'max'): number | null => {
    const direct = number(hw[aggregate]);
    if (direct !== null) return direct;
    const values = gpus.map(gpu => number(gpu[perCard])).filter((x): x is number => x !== null);
    if (!values.length) return null;
    if (mode === 'max') return Math.max(...values);
    const sum = values.reduce((a, b) => a + b, 0);
    return mode === 'mean' ? sum / values.length : sum;
  };
  let prefillTokS = number(live.prefill_tok_s_mean);
  if (state === 'idle') {
    const ms = number(last?.prompt_ms), tokens = number(last?.prompt_tokens), reused = number(last?.reused);
    prefillTokS = ms !== null && ms > 0 && tokens !== null ? Math.max(0, tokens - (reused ?? 0)) / (ms / 1000) : null;
  }
  const history: Record<string, (number | null)[]> = {};
  for (const [key, series] of Object.entries(asObject(raw.history))) if (Array.isArray(series)) history[key] = series.map(number);
  return {
    state, model: typeof engine.model === 'string' ? engine.model : '',
    decodeTokS: state === 'generating' ? number(live.tok_s) : number(last?.decode_tok_s), prefillTokS,
    gpuUtil: gpuMetric('gpu_util', 'util', 'mean'), gpuMemoryUsed: gpuMetric('gpu_mem_used', 'mem_used', 'sum'), gpuMemoryTotal: gpuMetric('gpu_mem_total', 'mem_total', 'sum'),
    gpuTemperature: gpuMetric('gpu_temp', 'temp', 'max'), gpuPower: gpuMetric('gpu_power', 'power', 'sum'), cpuUtil: number(hw.cpu),
    ramUsed: number(hw.ram_used), ramTotal: number(hw.ram_total), queued: number(live.queued), running: number(live.running),
    cacheHitRate: number(last?.hit_rate), requests, history, raw,
  };
}

/** Per-request decode rates of the slots generating right now ("parallel" / --batch); live.tok_s is their sum upstream. */
export function decodeStreams(value: unknown): number[] {
  const live = asObject(asObject(value).live);
  if (!Array.isArray(live.slots)) return [];
  return live.slots.map(asObject).filter(slot => slot.state === 'generating' || slot.state === 'decoding')
    .map(slot => slot.tok_s).filter((rate): rate is number => typeof rate === 'number' && Number.isFinite(rate) && rate > 0);
}
/** "2 路合计 · 80 + 76" when more than one request generates; null otherwise. */
export function decodeStreamsLabel(streams: number[], zh: boolean): string | null {
  if (streams.length < 2) return null;
  const parts = streams.length <= 4 ? streams.map(rate => rate.toFixed(rate >= 100 ? 0 : 1)).join(' + ') : null;
  return zh ? `${streams.length} 路合计${parts ? ` · ${parts}` : ''}` : `${streams.length} streams${parts ? ` · ${parts}` : ''}`;
}

export type ModelLoadNotice = { kind: 'loading'; seconds: number | null } | { kind: 'notLoaded' } | null;
/**
 * Overview line for a running service whose model is not ready. A cold load that is still
 * progressing (upstream `live.state === 'loading'`, or a start this app is still waiting on)
 * is normal progress with an elapsed time, never a warning or an error.
 */
export function modelLoadNotice(input: { online: boolean; loaded: unknown; metric?: MetricSnapshot; loadingSince?: number; now?: number }): ModelLoadNotice {
  if (!input.online || input.loaded !== false) return null;
  const live = asObject(input.metric?.raw.live);
  const upstream = number(live.load_elapsed_s);
  const since = typeof input.loadingSince === 'number' && input.loadingSince > 0 ? input.loadingSince : undefined;
  if (input.metric?.state !== 'loading' && since === undefined) return { kind: 'notLoaded' };
  const seconds = upstream ?? (since === undefined ? null : Math.max(0, ((input.now ?? Date.now()) - since) / 1000));
  return { kind: 'loading', seconds: seconds === null ? null : Math.round(seconds) };
}
