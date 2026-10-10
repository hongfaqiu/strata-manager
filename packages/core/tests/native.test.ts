import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request, streamChat, serviceStatus, restartService, takeOverService, discoverLocal, importLocal, ensureLocalService, supervisorStatus } from '../src';
import type { ChatDelta, ServiceProfile, StreamEvent } from '../src';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, Channel: class { onmessage: (event: StreamEvent) => void = () => {}; } }));
const profile: ServiceProfile = { id: 'native', name: 'native', baseUrl: 'http://127.0.0.1:8080', installDir: '', configPath: '', pythonPath: '', managed: true };
beforeEach(() => { native.invoke.mockReset(); vi.stubGlobal('window', { __TAURI_INTERNALS__: {} }); });
afterEach(async () => {
  // streamChat starts cancellation imports without awaiting them. Keep the
  // desktop globals alive until those imports finish before resetting a test.
  await vi.dynamicImportSettled();
  vi.unstubAllGlobals();
});

describe('native bridge protocol', () => {
  it('rejects remote services before sending either HTTP or stream commands', async () => {
    for (const baseUrl of ['http://192.168.1.10:8080', 'https://models.example.com', 'http://127.0.0.1.example.com', 'https://127.0.0.1:8080']) {
      await expect(request({ ...profile, baseUrl }, '/health')).rejects.toMatchObject({ code: 'LOCAL_SERVICE_ONLY' });
      await expect(streamChat({ ...profile, baseUrl }, {}, () => {})).rejects.toMatchObject({ code: 'LOCAL_SERVICE_ONLY' });
    }
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it('passes real local discovery and supervisor workflow arguments', async () => {
    const candidate = { id: 'candidate', name: 'local', installDir: 'D:\\AI\\Strata', pythonPath: 'python', configPath: 'config.json', modelPath: 'model.gguf', modelBytes: null };
    native.invoke.mockResolvedValue([]);
    await discoverLocal();
    expect(native.invoke).toHaveBeenLastCalledWith('discover_local', {});
    await discoverLocal(['D:\\AI\\Strata']);
    expect(native.invoke).toHaveBeenLastCalledWith('discover_local', { directories: ['D:\\AI\\Strata'] });
    await importLocal(candidate);
    expect(native.invoke).toHaveBeenLastCalledWith('import_local', { candidate });
    await ensureLocalService('registered');
    expect(native.invoke).toHaveBeenLastCalledWith('ensure_local_service', { profileId: 'registered' });
    await supervisorStatus();
    expect(native.invoke).toHaveBeenLastCalledWith('supervisor_status', undefined);
  });
  it('keeps legacy status arguments and passes explicit profiles to service management', async () => {
    native.invoke.mockResolvedValue({ running: true, owned: false, external: true, canTakeOver: true, creationTime: '134355840000000000' });
    await serviceStatus(profile.id);
    expect(native.invoke).toHaveBeenLastCalledWith('service_status', { profileId: profile.id });
    const status = await serviceStatus(profile.id, profile);
    expect(native.invoke).toHaveBeenLastCalledWith('service_status', { profileId: profile.id, profile });
    expect(status.creationTime).toBe('134355840000000000');
    await restartService(profile);
    expect(native.invoke).toHaveBeenLastCalledWith('restart_service', { profile });
    native.invoke.mockRejectedValue('服务有活动或排队请求，接管已拒绝');
    await expect(takeOverService(profile)).rejects.toMatchObject({ message: '服务有活动或排队请求，接管已拒绝' });
    expect(native.invoke).toHaveBeenLastCalledWith('take_over_service', { profile });
  });
  it('normalizes copied /v1 endpoint before native invocation without mutating stored profile', async () => {
    native.invoke.mockResolvedValue({ status: 'ok' });
    const input = { ...profile, baseUrl: 'http://127.0.0.1:8080/v1/' };
    await request(input, '/health');
    expect(native.invoke).toHaveBeenCalledWith('strata_request', { profile, path: '/health', method: 'GET' });
    expect(input.baseUrl).toBe('http://127.0.0.1:8080/v1/');
  });
  it('passes profile and typed Channel data; tracks completed MCP metadata', async () => {
    native.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      expect(command).toBe('strata_stream');
      expect(args).toMatchObject({ profile, path: '/v1/chat/completions', body: { stream: true } });
      const channel = args.onEvent as { onmessage: (event: StreamEvent) => void };
      channel.onmessage({ kind: 'data', data: 'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n' });
      channel.onmessage({ kind: 'data', data: 'data: {"strata_mcp":{"event":"call","id":"id1","name":"calc","round":0,"arguments":{"a":1}}}\n\n' });
      channel.onmessage({ kind: 'data', data: 'data: {"strata_mcp":{"event":"result","id":"id1","ok":true,"text":"2"}}\n\ndata: [DO' });
      channel.onmessage({ kind: 'data', data: 'NE]\n\n' });
      channel.onmessage({ kind: 'done' });
    });
    const deltas: ChatDelta[] = [];
    await streamChat(profile, { stream: true }, delta => deltas.push(delta));
    expect(deltas[0]).toMatchObject({ reasoning: '想' });
    expect(deltas[2]?.tool).toMatchObject({ id: 'id1', name: 'calc', round: 0, arguments: { a: 1 }, result: '2' });
    expect(deltas.filter(d => d.done)).toHaveLength(1);
  });
  it('sends cancel_stream for the same request ID and rejects cancellation', async () => {
    const controller = new AbortController();
    let activeRequest: string | undefined;
    let finish: (() => void) | undefined;
    native.invoke.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === 'strata_stream') {
        activeRequest = String(args.requestId);
        const channel = args.onEvent as { onmessage: (event: StreamEvent) => void };
        channel.onmessage({ kind: 'data', data: 'data: {"choices":[{"delta":{"content":"started"}}]}\n\n' });
        return new Promise<void>(resolve => { finish = resolve; queueMicrotask(() => controller.abort()); });
      }
      if (command === 'cancel_stream') { expect(args.requestId).toBe(activeRequest); finish?.(); return Promise.resolve(); }
      throw new Error(`unexpected ${command}`);
    });
    await expect(streamChat(profile, {}, () => {}, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual(['strata_stream', 'cancel_stream']);
  });
  it('does not swallow Channel engine errors and normalizes native HTTP failures', async () => {
    native.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'strata_stream') {
        const channel = args.onEvent as { onmessage: (event: StreamEvent) => void };
        channel.onmessage({ kind: 'error', data: '{"code":"HTTP_ERROR","status":503,"message":"engine crashed"}' });
      }
    });
    await expect(streamChat(profile, {}, () => {})).rejects.toMatchObject({ status: 503, message: 'engine crashed' });
    // The Channel error also starts cancel_stream. Vitest 3 shares the manual
    // mock import callstack: a second import during cancellation can bypass
    // the factory. Finish cancellation before changing this mock to HTTP errors.
    await vi.dynamicImportSettled();
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual(['strata_stream', 'cancel_stream']);
    native.invoke.mockRejectedValue('HTTP 401: {"error":{"message":"key required"}}');
    await expect(request(profile, '/metrics')).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401, message: 'key required' });
    expect(native.invoke).toHaveBeenLastCalledWith('strata_request', { profile, path: '/metrics', method: 'GET' });
    native.invoke.mockRejectedValue('HTTP 409 Conflict: {"status":"busy"}');
    await expect(request(profile, '/unload', 'POST', {})).rejects.toMatchObject({ code: 'BUSY', status: 409 });
    expect(native.invoke).toHaveBeenLastCalledWith('strata_request', { profile, path: '/unload', method: 'POST', body: {} });
  });
});
