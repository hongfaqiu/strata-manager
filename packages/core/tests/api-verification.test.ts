import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_VERIFICATION_IMAGE, verifyApi, type ApiVerificationTransport } from '../src/api-verification';
import { StrataError } from '../src/errors';
import type { ServiceProfile } from '../src/types';

const profile: ServiceProfile = { id: 'verify-fixture', name: 'fixture', baseUrl: 'http://127.0.0.1:19991', installDir: '', pythonPath: '', configPath: '', managed: false };
const health = { service: 'strata', status: 'ok', loaded: true, model: 'fixture-model', images: true };
const status = { service: 'strata', dialects: ['/v1/chat/completions'], tools: true };
function fixture() {
  const read = vi.fn(async (_profile: ServiceProfile, path: string): Promise<unknown> => path === '/health' ? health : path === '/v1/status' ? status : path === '/metrics' ? {} : { data: [{ id: 'fixture-model' }] });
  const stream = vi.fn<ApiVerificationTransport['stream']>(async (_profile, _body, delta) => { delta({ content: 'STRATA_API_OK', finishReason: 'stop' }); delta({ done: true }); });
  return { read, stream };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('explicit API verification', () => {
  it('does no IO for a stopped service, and only GET metadata precedes inference', async () => {
    const io = fixture();
    expect((await verifyApi(profile, { kind: 'text', ready: false }, undefined, undefined, io)).steps[0]?.code).toBe('VERIFICATION_NOT_READY');
    expect(io.read).not.toHaveBeenCalled(); expect(io.stream).not.toHaveBeenCalled();
    const progress = vi.fn();
    const report = await verifyApi(profile, { kind: 'text', ready: true }, progress, undefined, io);
    expect(report.state).toBe('passed'); expect(report.steps.map(step => step.stage)).toEqual(['health', 'models', 'capabilities', 'inference']);
    expect(io.read.mock.calls.map(call => call[1])).toEqual(['/health', '/v1/models', '/health', '/v1/status', '/metrics', '/health', '/v1/status', '/health', '/health', '/v1/status']);
    expect(io.stream).toHaveBeenCalledOnce(); expect(io.stream.mock.calls[0]?.[1]).toMatchObject({ model: 'fixture-model', max_tokens: 256, reasoning_effort: 'off', strata_mcp: false, stream: true });
    expect(JSON.stringify(report)).not.toContain('STRATA_API_OK');
  });
  it('keeps missing capability metadata unknown while allowing an explicitly requested test', async () => {
    const io = fixture(); io.read.mockImplementation(async (_profile, path) => path === '/health' ? health : path === '/v1/models' ? { data: [{ id: 'fixture-model' }] } : {});
    const report = await verifyApi(profile, { kind: 'text', ready: true }, undefined, undefined, io);
    expect(report.state).toBe('passed'); expect(report.capabilities?.find(item => item.id === 'chat')?.state).toBe('unknown');
    expect(io.stream).toHaveBeenCalledOnce();
  });
  it.each(['chat', 'tools'])('never tests a feature explicitly declared unavailable (%s)', async feature => {
    const io = fixture(); io.read.mockImplementation(async (_profile, path) => path === '/health' ? health : path === '/v1/status' ? { ...status, ...(feature === 'chat' ? { dialects: [] } : { tools: false }) } : { data: [{ id: 'fixture-model' }] });
    const report = await verifyApi(profile, { kind: feature === 'chat' ? 'text' : 'tools', ready: true }, undefined, undefined, io);
    expect(report.steps.at(-1)?.code).toBe('VERIFICATION_CAPABILITY_UNAVAILABLE');
    expect(report.capabilities?.find(item => item.id === feature)?.state).toBe('unavailable'); expect(io.stream).not.toHaveBeenCalled();
  });
  it('does not infer support or send a test across an engine identity change', async () => {
    const io = fixture(), identity = vi.fn().mockResolvedValueOnce({ running: true, pid: 1, startedAt: 1, engine: { pid: 2, startedAt: 2 } }).mockResolvedValueOnce({ running: true, pid: 1, startedAt: 1, engine: { pid: 3, startedAt: 3 } });
    const report = await verifyApi(profile, { kind: 'text', ready: true }, undefined, undefined, { ...io, identity });
    expect(report.steps.at(-1)?.code).toBe('VERIFICATION_IDENTITY_CHANGED'); expect(io.stream).not.toHaveBeenCalled();
  });
  it('does not call a streamed response verified if the engine changed during the request', async () => {
    const io = fixture(), initial = { running: true, pid: 1, startedAt: 1, engine: { pid: 2, startedAt: 2 } };
    const identity = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(initial).mockResolvedValue({ ...initial, engine: { pid: 3, startedAt: 3 } });
    const report = await verifyApi(profile, { kind: 'text', ready: true }, undefined, undefined, { ...io, identity });
    expect(io.stream).toHaveBeenCalledOnce(); expect(report.steps.at(-1)?.code).toBe('VERIFICATION_IDENTITY_CHANGED'); expect(report.state).toBe('failed');
  });
  it.each([{ ...health, service: 'other' }, { ...health, status: 'error' }, { ...health, loaded: false }])('refuses unconfirmed health %j', async value => {
    const io = fixture(); io.read.mockResolvedValue(value);
    const report = await verifyApi(profile, { kind: 'text', ready: true }, undefined, undefined, io);
    expect(report.state).toBe('failed'); expect(io.stream).not.toHaveBeenCalled(); expect(io.read).toHaveBeenCalledOnce();
  });
  it('requires an exact discovered model and refuses model changes immediately before inference', async () => {
    const io = fixture();
    const missing = await verifyApi(profile, { kind: 'text', ready: true, model: 'missing' }, undefined, undefined, io);
    expect(missing.steps.at(-1)?.code).toBe('VERIFICATION_MODEL_MISSING'); expect(io.stream).not.toHaveBeenCalled();
    let healthReads = 0; io.read.mockImplementation(async (_profile, path) => path === '/health' ? (++healthReads === 1 ? health : { ...health, model: 'changed' }) : path === '/v1/status' ? status : { data: [{ id: 'fixture-model' }] });
    const changed = await verifyApi(profile, { kind: 'text', ready: true }, undefined, undefined, io);
    expect(changed.steps.at(-1)?.code).toBe('VERIFICATION_MODEL_CHANGED'); expect(io.stream).not.toHaveBeenCalled();
  });
  it('cancels before or during metadata without falling through to inference', async () => {
    const io = fixture(), controller = new AbortController(); controller.abort();
    expect((await verifyApi(profile, { kind: 'text', ready: true }, undefined, controller.signal, io)).state).toBe('cancelled');
    expect(io.read).not.toHaveBeenCalled();
    const later = new AbortController(); io.read.mockImplementation(() => new Promise(() => {}));
    const pending = verifyApi(profile, { kind: 'text', ready: true }, undefined, later.signal, io); later.abort();
    expect((await pending).state).toBe('cancelled'); expect(io.stream).not.toHaveBeenCalled();
  });
  it('covers the entire run with a 60-second deadline and aborts a stalled stream', async () => {
    vi.useFakeTimers(); const io = fixture();
    io.stream.mockImplementation(async (_profile, _body, _delta, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })));
    const pending = verifyApi(profile, { kind: 'text', ready: true }, undefined, undefined, io);
    await vi.advanceTimersByTimeAsync(60_000);
    const report = await pending;
    expect(report.state).toBe('failed'); expect(report.steps.at(-1)?.code).toBe('VERIFICATION_TIMEOUT'); expect(io.stream.mock.calls[0]?.[3].aborted).toBe(true);
  });
  it('propagates cancellation during streaming and never sends a follow-up', async () => {
    const io = fixture(), controller = new AbortController();
    io.stream.mockImplementation(async (_profile, _body, delta, signal) => {
      delta({ reasoning: 'partial fixture output' }); controller.abort();
      expect(signal.aborted).toBe(true); throw new StrataError('CANCELLED', 'CANCELLED');
    });
    const report = await verifyApi(profile, { kind: 'text', ready: true }, undefined, controller.signal, io);
    expect(report.state).toBe('cancelled'); expect(io.stream).toHaveBeenCalledOnce(); expect(JSON.stringify(report)).not.toContain('partial fixture output');
  });
  it('never includes upstream errors, secrets, raw bodies or tool arguments in results', async () => {
    const io = fixture(); io.read.mockRejectedValue(new StrataError('HTTP_ERROR', 'Bearer secret-token request-body', 401, { api_key: 'secret-token' }));
    const report = await verifyApi(profile, { kind: 'text', ready: true }, undefined, undefined, io);
    expect(report.steps.at(-1)).toMatchObject({ code: 'VERIFICATION_AUTH', httpStatus: 401 }); expect(JSON.stringify(report)).not.toMatch(/secret-token|Bearer|request-body|api_key/);
  });
  it('checks fragmented tool_call structures without executing tools or enabling MCP', async () => {
    const io = fixture(); io.stream.mockImplementation(async (_profile, body, delta) => {
      expect(body.strata_mcp).toBe(false); expect(body.tool_choice).toMatchObject({ function: { name: 'strata_api_check' } });
      delta({ tool: { name: 'strata_api_check', status: 'writing', raw: { index: 0, id: 'call-fixture', type: 'function', function: { name: 'strata_api_check', arguments: '{"value":' } } } });
      delta({ tool: { name: '', status: 'writing', raw: { index: 0, function: { arguments: '"strata-ok"}' } } } });
      delta({ finishReason: 'tool_calls' }); delta({ done: true });
    });
    const report = await verifyApi(profile, { kind: 'tools', ready: true }, undefined, undefined, io);
    expect(report.state).toBe('passed'); expect(io.stream).toHaveBeenCalledOnce(); expect(JSON.stringify(report)).not.toContain('strata-ok');
  });
  it.each(['malformed', 'wrong-name', 'mcp'])('rejects %s tool output', async mode => {
    const io = fixture(); io.stream.mockImplementation(async (_profile, _body, delta) => {
      delta({ tool: { name: 'tool', status: 'writing', raw: mode === 'mcp' ? { event: 'call' } : { index: 0, id: 'call-fixture', type: 'function', function: { name: mode === 'wrong-name' ? 'unwanted' : 'strata_api_check', arguments: mode === 'malformed' ? '{' : '{"value":"strata-ok"}' } } } });
      delta({ finishReason: 'tool_calls', done: true });
    });
    expect((await verifyApi(profile, { kind: 'tools', ready: true }, undefined, undefined, io)).state).toBe('failed');
  });
  it('requires health image support and uses only the built-in fixture', async () => {
    const io = fixture(); io.read.mockImplementation(async (_profile, path) => path === '/health' ? { ...health, images: false } : { data: [{ id: 'fixture-model' }] });
    expect((await verifyApi(profile, { kind: 'vision', ready: true }, undefined, undefined, io)).steps.at(-1)?.code).toBe('VERIFICATION_VISION_UNAVAILABLE'); expect(io.stream).not.toHaveBeenCalled();
    io.read.mockImplementation(async (_profile, path) => path === '/health' ? health : { data: [{ id: 'fixture-model' }] });
    io.stream.mockImplementation(async (_profile, body, delta) => { expect(JSON.stringify(body)).toContain(API_VERIFICATION_IMAGE); delta({ content: 'red', finishReason: 'stop', done: true }); });
    expect((await verifyApi(profile, { kind: 'vision', ready: true }, undefined, undefined, io)).state).toBe('passed');
  });
});
