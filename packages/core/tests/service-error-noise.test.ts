import { describe, expect, it } from 'vitest';
import { engineLogTone, SERVICE_START_GRACE_MS, visibleServiceError } from '../src';

describe('visibleServiceError', () => {
  const now = 1_000_000_000;
  it('hides failures while a start is pending', () => {
    expect(visibleServiceError({ error: 'connection refused', kind: 'health', starting: true, now })).toBeUndefined();
  });
  it('hides failures within the grace window after the process started', () => {
    expect(visibleServiceError({ error: 'connection refused', kind: 'health', starting: false, processStartedAt: now - 22_000, now })).toBeUndefined();
  });
  it('surfaces failures that persist past the grace window', () => {
    expect(visibleServiceError({ error: 'connection refused', kind: 'health', starting: false, processStartedAt: now - SERVICE_START_GRACE_MS - 1, now })).toBe('connection refused');
    expect(visibleServiceError({ error: 'connection refused', kind: 'health', starting: false, now })).toBe('connection refused');
  });
  it('hides metrics failures while health reports a load in progress', () => {
    expect(visibleServiceError({ error: 'operation timed out', kind: 'metrics', starting: false, loaded: false, processStartedAt: now - 3_600_000, now })).toBeUndefined();
    expect(visibleServiceError({ error: 'operation timed out', kind: 'metrics', starting: false, loaded: true, processStartedAt: now - 3_600_000, now })).toBe('operation timed out');
  });
  it('a loading health answer does not hide a health failure', () => {
    expect(visibleServiceError({ error: 'HTTP 500', kind: 'health', starting: false, loaded: false, now })).toBe('HTTP 500');
  });
});

describe('engineLogTone', () => {
  it('treats engine statistics as normal output', () => {
    for (const line of [
      'strata serve: route tail skip: 2188 missed experts skipped (22/57 entries) since the start',
      'strata serve: decode expert cache hit rate: 94.3% (36618 hits / 38804 lookups)',
      'strata serve: KV streaming: 98.39% of 56856 block reads hit VRAM',
    ]) expect(engineLogTone(line)).toBe('normal');
  });
  it('marks real failures', () => {
    for (const line of ['Traceback (most recent call last):', 'CUDA error: out of memory', 'RuntimeError: engine exited', 'strata: fatal: cannot open model']) expect(engineLogTone(line)).toBe('error');
  });
});
