import { beforeEach, describe, expect, it, vi } from 'vitest';
import { describeRuntimeOperationFailure, operateSessionStorage, probeSessionStorage, requestPrefillTokS, resizeRuntimeVram, runtimeSlots, validateSessionFilename } from '../src/runtime-operations';
import type { ServiceProfile } from '../src/types';

const bridge = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/bridge', () => ({ request: bridge.request }));
const profile: ServiceProfile = { id: 'fixture', name: 'Fixture', baseUrl: 'http://127.0.0.1:8099', installDir: '', configPath: '', pythonPath: '', managed: true };
beforeEach(() => { bridge.request.mockReset(); });

describe('runtime VRAM operations', () => {
  it('uses the real reserve route and distinguishes partial 200 from meeting the request', async () => {
    bridge.request.mockResolvedValue({ status: 'ok', reserve_mib: 8000, vram_free_mib: 7000, expert_cache_mib: 512, expert_cache_full_mib: 8192 });
    expect(await resizeRuntimeVram(profile, 8000)).toMatchObject({ state: 'applied', freeMiB: 7000, reserveMet: false, fullyRestored: false });
    expect(bridge.request).toHaveBeenCalledWith(profile, '/v1/vram', 'POST', { reserve_mib: 8000 });
  });
  it('restores the startup reserve with null and treats unloaded models as deferred', async () => {
    bridge.request.mockResolvedValueOnce({ status: 'ok', reserve_mib: 700, vram_free_mib: 720, expert_cache_mib: 8192, expert_cache_full_mib: 8192 });
    expect(await resizeRuntimeVram(profile, null)).toMatchObject({ reserveMet: true, fullyRestored: true });
    expect(bridge.request).toHaveBeenLastCalledWith(profile, '/v1/vram', 'POST', { reserve_mib: null });
    bridge.request.mockResolvedValueOnce({ status: 'not loaded', reserve_mib: 4096 });
    expect(await resizeRuntimeVram(profile, 4096)).toMatchObject({ state: 'deferred', freeMiB: null, reserveMet: null, fullyRestored: null });
  });
  it('does not invent measurement success or send invalid reserves', async () => {
    for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) await expect(resizeRuntimeVram(profile, value)).rejects.toMatchObject({ code: 'INVALID_VRAM_RESERVE' });
    expect(bridge.request).not.toHaveBeenCalled();
    bridge.request.mockResolvedValue({ status: 'ok' });
    expect(await resizeRuntimeVram(profile, null)).toMatchObject({ reserveMet: null, fullyRestored: null });
    bridge.request.mockResolvedValue({ status: 'busy' });
    await expect(resizeRuntimeVram(profile, 0)).rejects.toMatchObject({ code: 'INVALID_CONTROL_RESPONSE' });
  });
  it('identifies the observed resident low-RAM refusal without misclassifying invalid reserves', async () => {
    const message = 'VRAM: not with the resident low-RAM mode (the cache holds experts RAM does not)';
    const refusal = `HTTP 400: ${JSON.stringify({ error: { message } })}`;
    bridge.request.mockRejectedValueOnce(refusal);
    await expect(resizeRuntimeVram(profile, 4096)).rejects.toBe(refusal);
    expect(describeRuntimeOperationFailure(refusal)).toMatchObject({ message, status: 400, kind: 'vram-resident-low-ram', unsupported: true, needsReload: false });
    expect(bridge.request).toHaveBeenCalledOnce();
    expect(describeRuntimeOperationFailure('HTTP 400: {"error":{"message":"reserve_mib must be a non-negative integer"}}')).toMatchObject({ status: 400, kind: null, unsupported: false, needsReload: false });
    // The same text without the observed 400 is not this compatibility case.
    expect(describeRuntimeOperationFailure(`HTTP 500: ${JSON.stringify({ error: { message } })}`)).toMatchObject({ status: 500, kind: null, unsupported: false });
  });
});

describe('session files', () => {
  it('rejects paths, streams, device aliases, Unicode surrogates and overlong UTF-8 names on every OS', () => {
    for (const name of ['', '../a.bin', 'a/b', 'D:\\a.bin', 'D:a', 'a:b', '.hidden', 'a.', 'a ', 'a\0b', 'a\x7fb', 'NUL.bin', 'CON .bin', 'conin$.bin', 'COM¹.bin', 'LPT9', '\ud800', '文'.repeat(67)]) {
      expect(() => validateSessionFilename(name), name).toThrow();
    }
    for (const name of ['会话一.bin', 'chat-1.bin', '😀.bin', 'COM10.bin', 'x'.repeat(200)]) expect(() => validateSessionFilename(name)).not.toThrow();
  });
  it('checks the endpoint with an empty name without issuing a valid save', async () => {
    bridge.request.mockRejectedValueOnce('HTTP 400: {"error":{"message":"filename must be a non-empty string"}}');
    expect(await probeSessionStorage(profile)).toMatchObject({ state: 'available' });
    expect(bridge.request).toHaveBeenCalledWith(profile, '/slots/0?action=save', 'POST', { filename: '' });
    bridge.request.mockRejectedValueOnce('HTTP 501: {"error":{"message":"not available with parallel requests"}}');
    expect(await probeSessionStorage(profile)).toMatchObject({ state: 'unsupported' });
    bridge.request.mockRejectedValueOnce('HTTP 400: {"error":{"message":"different validation"}}');
    expect(await probeSessionStorage(profile)).toMatchObject({ state: 'unknown' });
    bridge.request.mockResolvedValueOnce({ status: 'ok' });
    expect(await probeSessionStorage(profile)).toMatchObject({ state: 'unknown' });
  });
  it('uses slot 0 and verifies operation, filename, bytes, tokens and real timing', async () => {
    bridge.request.mockResolvedValueOnce({ id_slot: 0, filename: 'chat.bin', n_saved: 63025, n_written: 1198691396, timings: { save_ms: 709.5 } });
    expect(await operateSessionStorage(profile, 'save', 'chat.bin')).toEqual({ action: 'save', filename: 'chat.bin', tokens: 63025, bytes: 1198691396, elapsedMs: 709.5 });
    expect(bridge.request).toHaveBeenLastCalledWith(profile, '/slots/0?action=save', 'POST', { filename: 'chat.bin' });
    bridge.request.mockResolvedValueOnce({ id_slot: 0, filename: 'chat.bin', n_restored: 63025, n_read: 1198691396 });
    expect(await operateSessionStorage(profile, 'restore', 'chat.bin')).toMatchObject({ action: 'restore', tokens: 63025, elapsedMs: null });
    expect(bridge.request).toHaveBeenLastCalledWith(profile, '/slots/0?action=restore', 'POST', { filename: 'chat.bin' });
    bridge.request.mockResolvedValueOnce({ id_slot: 0, filename: 'other.bin', n_restored: 1, n_read: 10 });
    await expect(operateSessionStorage(profile, 'restore', 'chat.bin')).rejects.toMatchObject({ code: 'INVALID_CONTROL_RESPONSE' });
    await expect(operateSessionStorage(profile, 'save', '../outside.bin')).rejects.toMatchObject({ code: 'INVALID_SESSION_FILENAME' });
    expect(bridge.request).toHaveBeenCalledTimes(3);
  });
  it('preserves disk/RAM refusal and publication details without retrying', async () => {
    const failure = 'HTTP 500: {"error":{"message":"flush failed","kind":"io","published":true}}';
    bridge.request.mockRejectedValue(failure);
    await expect(operateSessionStorage(profile, 'save', 'chat.bin')).rejects.toBe(failure);
    expect(describeRuntimeOperationFailure(failure)).toMatchObject({ status: 500, kind: 'io', published: true, unsupported: false });
    expect(bridge.request).toHaveBeenCalledTimes(1);
    expect(describeRuntimeOperationFailure('HTTP 400: {"error":{"message":"VRAM: refilling the cache failed: cuda"}}')).toMatchObject({ needsReload: true });
    expect(describeRuntimeOperationFailure('HTTP 400: {"error":{"message":"session: not with --layer-split"}}')).toMatchObject({ unsupported: true });
    expect(describeRuntimeOperationFailure('HTTP 404: {"error":{"message":"no saved session named unknown.bin"}}')).toMatchObject({ unsupported: false });
  });
});

describe('runtime monitoring', () => {
  it('uses fresh prompt tokens for Prefill and keeps missing, zero-work or zero-time unavailable', () => {
    expect(requestPrefillTokS({ prompt_tokens: 1000, reused: 600, prompt_ms: 200 })).toBe(2000);
    for (const row of [{ prompt_tokens: 1000, prompt_ms: 200 }, { prompt_tokens: 1000, reused: 1000, prompt_ms: 200 }, { prompt_tokens: 1000, reused: 0, prompt_ms: 0 }]) expect(requestPrefillTokS(row)).toBeNull();
  });
  it('keeps missing slots unknown and uses actual held context for idle slots', () => {
    expect(runtimeSlots({ live: { running: 0 } })).toBeNull();
    expect(runtimeSlots({ live: { slots: [] } })).toEqual([]);
    expect(runtimeSlots({ engine: { max_context: 32768 }, live: { slots: [
      { slot: 0, state: 'idle', held_tokens: 123 }, { slot: 1, state: 'decoding', prompt_tokens: 100, generated: 20, tok_s: 30 },
      { slot: 2, state: 'reading', prompt_tokens: 500 }, { slot: 1, state: 'duplicate' }, { state: 'missing id' },
    ] } })).toMatchObject([
      { id: 0, state: 'idle', usedContext: 123, context: 32768, tokS: null }, { id: 1, usedContext: 120, tokS: 30 }, { id: 2, usedContext: null },
    ]);
  });
});
