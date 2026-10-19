import { describe, expect, it } from 'vitest';
import { modelTelemetry, normalizeMetrics } from '../src/metrics';

const metric = (state: string) => normalizeMetrics({ live: { state, load_elapsed_s: 12 }, requests: [{ decode_tok_s: 95, hit_rate: .5 }], hardware: { gpu_util: 40 } });

describe('model lifecycle telemetry', () => {
  it('preserves loading before READY and drops previous throughput', () => {
    for (const state of ['loading', 'unloading']) for (const loaded of [true, false, undefined]) {
      expect(modelTelemetry(metric(state), loaded)).toMatchObject({ state, decodeTokS: null, prefillTokS: null, cacheHitRate: null, gpuUtil: 40 });
    }
    expect(modelTelemetry(metric('loading'), false)?.raw.live).toMatchObject({ load_elapsed_s: 12 });
  });
  it('does not mistake an unloaded idle model or cached generation for reloading', () => {
    for (const state of ['idle', 'generating', 'unknown']) expect(modelTelemetry(metric(state), false)).toMatchObject({ state: 'unloaded', decodeTokS: null });
    expect(modelTelemetry(undefined, false)).toBeUndefined();
  });
  it('resumes the original telemetry as soon as the model is ready', () => {
    const ready = metric('idle');
    expect(modelTelemetry(ready, true)).toBe(ready);
    expect(modelTelemetry(ready)).toBe(ready);
    expect(ready.decodeTokS).toBe(95);
  });
});

describe('model load notice on the overview', async () => {
  const { modelLoadNotice } = await import('../src/metrics');
  it('treats a long but progressing load as loading with elapsed time, not as an error', () => {
    expect(modelLoadNotice({ online: true, loaded: false, metric: normalizeMetrics({ live: { state: 'loading', load_elapsed_s: 261.4 } }) })).toEqual({ kind: 'loading', seconds: 261 });
    expect(modelLoadNotice({ online: true, loaded: false, metric: normalizeMetrics({ live: { state: 'idle' } }), loadingSince: 1_000, now: 100_000 })).toEqual({ kind: 'loading', seconds: 99 });
    expect(modelLoadNotice({ online: true, loaded: false, metric: normalizeMetrics({ live: { state: 'loading' } }) })).toEqual({ kind: 'loading', seconds: null });
  });
  it('keeps the not-loaded warning only when nothing is loading, and clears once ready', () => {
    expect(modelLoadNotice({ online: true, loaded: false, metric: normalizeMetrics({ live: { state: 'idle' } }) })).toEqual({ kind: 'notLoaded' });
    expect(modelLoadNotice({ online: true, loaded: true, metric: normalizeMetrics({ live: { state: 'loading' } }), loadingSince: 1 })).toBeNull();
    expect(modelLoadNotice({ online: false, loaded: false })).toBeNull();
  });
});
