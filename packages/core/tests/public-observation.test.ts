import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { observationChannel, parsePublicObservation, readPublicObservation, type ApiObserverStatus } from '../src';

// Captured from the real upstream MockEngine by apps/supervisor/tests/test_public_endpoints.py.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/public-endpoints.json', import.meta.url), 'utf8'));

describe('public endpoint observation channel', () => {
  it('reads an idle upstream service', () => {
    const value = parsePublicObservation(fixture.health, fixture.statusIdle, fixture.metrics);
    expect(value).toMatchObject({ isStrata: true, loaded: true, model: fixture.health.model, maxContext: 32768, busy: false, queued: 0, phase: null, elapsedS: null });
    expect(value.metrics?.state).toBe('idle');
  });
  it('reads a busy generation from /status', () => {
    const value = parsePublicObservation(fixture.health, fixture.statusBusy);
    expect(value).toMatchObject({ busy: true, phase: fixture.statusBusy.phase, promptTokens: fixture.statusBusy.prompt_tokens, metrics: null });
    expect(typeof value.elapsedS).toBe('number');
  });
  it('tolerates renamed or missing fields without guessing', () => {
    const value = parsePublicObservation({ service: 'strata', status: 'ok', ready: 1 }, { working: true });
    expect(value).toMatchObject({ isStrata: true, loaded: null, model: null, busy: null, phase: null });
    expect(parsePublicObservation({ status: 'ok' }).isStrata).toBe(false);
    expect(parsePublicObservation(undefined).reachable).toBe(false);
  });
  it('keeps health when /status needs a key or /metrics is gone', async () => {
    const value = await readPublicObservation(async path => { if (path === '/health') return fixture.health; throw new Error('401'); });
    expect(value).toMatchObject({ isStrata: true, loaded: true, busy: null, metrics: null });
  });
  it('chooses the observer only while it is active and not disabled', () => {
    const base: ApiObserverStatus = { serviceId: 'a', sessionId: 's', pid: 1, updatedAtMs: 1, supported: true, journalWriteFailed: false, observerActive: true, heartbeatFresh: true, error: null };
    expect(observationChannel(base)).toBe('observer');
    expect(observationChannel({ ...base, observerMode: 'structural' })).toBe('observer');
    expect(observationChannel({ ...base, observerMode: 'partial' })).toBe('observerDegraded');
    expect(observationChannel({ ...base, observerMode: 'disabled' })).toBe('public');
    expect(observationChannel({ ...base, supported: false, error: 'unsupported_runtime' })).toBe('public');
    expect(observationChannel({ ...base, heartbeatFresh: false })).toBe('public');
    expect(observationChannel(undefined)).toBe('public');
  });
});
