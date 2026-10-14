import { asObject } from './errors';
import { normalizeMetrics, type MetricSnapshot } from './metrics';
import type { ApiObserverStatus } from './analytics-types';

/**
 * Observation from upstream's public, version-stable endpoints only (/health, /status, /metrics).
 * It is the fallback when the in-process observer is disabled for an unreviewed Strata source,
 * and is parsed tolerantly: missing or renamed fields become null, never a guessed value.
 */
export interface PublicObservation {
  source: 'public';
  reachable: boolean;
  isStrata: boolean;
  loaded: boolean | null;
  model: string | null;
  maxContext: number | null;
  busy: boolean | null;
  queued: number | null;
  phase: string | null;
  elapsedS: number | null;
  tokensPerS: number | null;
  generated: number | null;
  promptTokens: number | null;
  metrics: MetricSnapshot | null;
}
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const str = (value: unknown): string | null => typeof value === 'string' && value ? value : null;
const bool = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;

export function parsePublicObservation(health: unknown, status?: unknown, metrics?: unknown): PublicObservation {
  const h = asObject(health), s = asObject(status);
  const isStrata = h.service === 'strata' && h.status === 'ok';
  const busy = bool(s.busy);
  return {
    source: 'public', reachable: health !== undefined && health !== null, isStrata,
    loaded: bool(h.loaded), model: str(h.model), maxContext: num(h.max_context),
    busy, queued: num(s.queued), phase: busy ? str(s.phase) : null,
    elapsedS: busy ? num(s.elapsed_s) : null,
    tokensPerS: busy ? num(s.tokens_per_s) : null,
    generated: busy ? num(s.generated) : null,
    promptTokens: busy ? num(s.prompt_tokens) : null,
    metrics: metrics === undefined || metrics === null ? null : normalizeMetrics(metrics),
  };
}

type Read = (path: '/health' | '/status' | '/metrics') => Promise<unknown>;
/** /status and /metrics may require the API key or be absent; their failure keeps the health result. */
export async function readPublicObservation(read: Read): Promise<PublicObservation> {
  const [health, status, metrics] = await Promise.allSettled([read('/health'), read('/status'), read('/metrics')]);
  const value = (r: PromiseSettledResult<unknown>) => r.status === 'fulfilled' ? r.value : undefined;
  return parsePublicObservation(value(health), value(status), value(metrics));
}

export type ObservationChannel = 'observer' | 'observerDegraded' | 'public';
/** The in-process observer is preferred; an unreviewed but compatible source is labelled, a disabled one falls back. */
export function observationChannel(status: ApiObserverStatus | undefined): ObservationChannel {
  if (!status || !status.supported || !status.observerActive || !status.heartbeatFresh || status.observerMode === 'disabled') return 'public';
  return status.observerMode === 'partial' ? 'observerDegraded' : 'observer';
}

export const OBSERVER_MODE_LABELS: Readonly<Record<string, string>> = {
  reviewed: '已审查版本：完整统计',
  structural: '新版本（未逐版审查）：结构检查通过，完整统计',
  partial: '新版本：部分统计能力已自动降级',
  disabled: '新版本结构不兼容：已改用公开接口监控，API 不受影响',
};
