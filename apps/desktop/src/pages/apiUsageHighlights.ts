import type { ApiInferenceTotals } from '@strata-manager/core';

/** Pure helpers for the API usage "key metrics" row; every value comes from recorded or live samples, never a default. */
const known = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Prefill time the context cache avoided, estimated from the engine's own timings in the same range:
 * reused tokens ÷ (recomputed tokens ÷ recomputed seconds). Null unless all three were measured.
 */
export function cacheSavedSeconds(inference: Pick<ApiInferenceTotals, 'cacheReadTokens' | 'prefillTokens' | 'prefillS'> | null | undefined): { seconds: number; prefillTokS: number } | null {
  if (!inference) return null;
  const { cacheReadTokens: reused, prefillTokens: tokens, prefillS: seconds } = inference;
  if (!known(reused) || !known(tokens) || !known(seconds) || reused < 0 || tokens <= 0 || seconds <= 0) return null;
  const prefillTokS = tokens / seconds;
  return { seconds: reused / prefillTokS, prefillTokS };
}

export type PowerReading =
  | { kind: 'live'; watts: number; limit: number | null; average: number | null; samples: (number | null)[] }
  | { kind: 'stopped' }
  | { kind: 'unsupported'; reason: 'mac' | 'device' };

/**
 * Live GPU draw from the engine telemetry (NVML on NVIDIA, amdgpu sysfs on Linux, the manager's ADLX reader on
 * Windows AMD). Apple GPUs expose no power sensor without root, so macOS reports "unsupported" instead of 0 W.
 */
export function powerReading(input: { watts: number | null; limit?: number | null; history?: (number | null)[]; unavailable: boolean; stopped?: boolean; mac: boolean }): PowerReading {
  if (input.stopped || input.unavailable) return input.stopped ? { kind: 'stopped' } : { kind: 'unsupported', reason: input.mac ? 'mac' : 'device' };
  if (!known(input.watts) || input.watts < 0) return { kind: 'unsupported', reason: input.mac ? 'mac' : 'device' };
  const samples = (input.history ?? []).map(value => known(value) && value >= 0 ? value : null);
  const valid = samples.filter(known);
  return { kind: 'live', watts: input.watts, limit: known(input.limit) && input.limit > 0 ? input.limit : null, average: valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null, samples };
}

/** Compact duration in the caller's units: seconds below a minute, minutes below an hour, then hours. */
export function durationParts(seconds: number): { value: number; unit: 'second' | 'minute' | 'hour'; digits: number } {
  if (seconds < 60) return { value: seconds, unit: 'second', digits: seconds < 10 ? 1 : 0 };
  if (seconds < 3600) return { value: seconds / 60, unit: 'minute', digits: 1 };
  return { value: seconds / 3600, unit: 'hour', digits: 1 };
}

/** Ring arc for a 0–1 ratio; out-of-range values are clamped so a bad sample cannot overdraw the ring. */
export function ringDash(ratio: number | null | undefined, circumference: number): string | null {
  if (!known(ratio)) return null;
  const length = Math.max(0, Math.min(1, ratio)) * circumference;
  return `${length} ${circumference - length}`;
}
