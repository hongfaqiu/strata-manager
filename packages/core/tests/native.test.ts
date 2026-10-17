import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request, streamChat, serviceStatus, restartService, takeOverService, discoverLocal, importLocal, ensureLocalService, supervisorStatus, listSetupHandoffs, resolveSetupHandoff, setBackgroundPolicy, tuningStart, readConfigSnapshot, writeConfig, calibrateStart, calibrateStatus, calibrateCancel, tuningLive } from '../src';
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
  it('preserves original config revision, conflict code, and never retries unsafe saves', async () => {
    native.invoke.mockResolvedValueOnce({ config: { port: 8080 }, revision: 'original-revision' });
    expect(await readConfigSnapshot(profile)).toEqual({ config: { port: 8080 }, revision: 'original-revision' });
    native.invoke.mockRejectedValueOnce(JSON.stringify({ code: 'CONFIG_REVISION_CONFLICT', message: 'Draft retained', retriable: false }));
    await expect(writeConfig(profile, { port: 8081 }, 'original-revision')).rejects.toMatchObject({ code: 'CONFIG_REVISION_CONFLICT', message: 'Draft retained' });
    expect(native.invoke.mock.calls).toEqual([['read_config_snapshot', { profile }], ['write_config', { profile, config: { port: 8081 }, expectedRevision: 'original-revision' }]]);
  });
  it('rejects full scenarios on old or malformed capabilities before any tuning mutation', async () => {
    for (const capabilities of [undefined, null, {}, { fullScenarioTuning: false }, { fullScenarioTuning: '1' }, { fullScenarioTuning: 0 }]) {
      native.invoke.mockReset(); native.invoke.mockResolvedValue({ protocolVersion: 1, version: '99.0.0', capabilities });
      await expect(tuningStart('model', { useCase: 'chat' })).rejects.toMatchObject({ code: 'SUPERVISOR_CAPABILITY_REQUIRED' });
      expect(native.invoke.mock.calls).toEqual([['supervisor_status', undefined]]);
    }
  });
  it('preserves full inputs and never retries a rejected mutation as diagnostic', async () => {
    const request = { useCase: 'agent' as const, contextLimit: 8192, includeVision: true, restartCandidates: [{ poolWorkers: 4 }], rounds: 2, maxTokens: 1024 };
    native.invoke.mockResolvedValueOnce({ capabilities: { fullScenarioTuning: 1 } }).mockRejectedValueOnce('unknown_method: tuning_start_full_v1');
    await expect(tuningStart('model', request)).rejects.toThrow('unknown_method');
    expect(native.invoke.mock.calls).toEqual([['supervisor_status', undefined], ['tuning_start', { profileId: 'model', request }]]);
  });
  it('starts quick calibration only on a supervisor that reports it, and maps the other calibration calls', async () => {
    for (const capabilities of [undefined, {}, { fullScenarioTuning: 1 }, { quickCalibration: '1' }, { quickCalibration: 0 }]) {
      native.invoke.mockReset(); native.invoke.mockResolvedValue({ protocolVersion: 1, version: '99.0.0', capabilities });
      await expect(calibrateStart('model')).rejects.toMatchObject({ code: 'SUPERVISOR_CAPABILITY_REQUIRED' });
      expect(native.invoke.mock.calls).toEqual([['supervisor_status', undefined]]);
    }
    native.invoke.mockReset();
    native.invoke.mockResolvedValueOnce({ capabilities: { quickCalibration: 1 } }).mockResolvedValue({ id: 'calibration' });
    await calibrateStart('model', { rounds: 3 });
    await calibrateStatus('model'); await calibrateCancel('job'); await tuningLive('job');
    expect(native.invoke.mock.calls).toEqual([['supervisor_status', undefined], ['calibrate_start', { profileId: 'model', request: { rounds: 3 } }], ['calibrate_status', { profileId: 'model' }], ['calibrate_cancel', { jobId: 'job' }], ['tuning_live', { jobId: 'job' }]]);
  });
  it('keeps the explicitly selected short diagnostic available without full capability', async () => {
    native.invoke.mockResolvedValue({ id: 'diagnostic' });
    const request = { scenes: ['chat' as const], rounds: 2, maxTokens: 512 };
    await tuningStart('model', request);
    expect(native.invoke.mock.calls).toEqual([['tuning_start', { profileId: 'model', request }]]);
  });
  it('preserves disabled and custom idle release periods when saving background policy', async () => {
    native.invoke.mockResolvedValue({ mode: 'lazy', autoRecover: false, idleUnloadMinutes: 0 });
    await setBackgroundPolicy('lazy', false, 0);
    expect(native.invoke).toHaveBeenLastCalledWith('set_background_policy', { mode: 'lazy', autoRecover: false, idleUnloadMinutes: 0 });
    await setBackgroundPolicy('alwaysReady', true, 37);
    expect(native.invoke).toHaveBeenLastCalledWith('set_background_policy', { mode: 'alwaysReady', autoRecover: true, idleUnloadMinutes: 37 });
    await setBackgroundPolicy('lazy', true);
    expect(native.invoke).toHaveBeenLastCalledWith('set_background_policy', { mode: 'lazy', autoRecover: true, idleUnloadMinutes: 15 });
  });
  it('reads durable setup registration and resolves only the explicit task configuration', async () => {
    native.invoke.mockResolvedValue([]);
    await listSetupHandoffs();
    expect(native.invoke).toHaveBeenLastCalledWith('list_setup_handoffs', undefined);
    await resolveSetupHandoff('setup-task');
    expect(native.invoke).toHaveBeenLastCalledWith('resolve_setup_handoff', { taskId: 'setup-task' });
    await resolveSetupHandoff('setup-task', '/tmp/strata/strata-qwen-iq3_s.json');
    expect(native.invoke).toHaveBeenLastCalledWith('resolve_setup_handoff', { taskId: 'setup-task', configPath: '/tmp/strata/strata-qwen-iq3_s.json' });
  });
  it('rejects remote services before sending either HTTP or stream commands', async () => {
    for (const baseUrl of ['http://203.0.113.10:8080', 'https://models.example.com', 'http://127.0.0.1.example.com', 'https://127.0.0.1:8080']) {
      await expect(request({ ...profile, baseUrl }, '/health')).rejects.toMatchObject({ code: 'LOCAL_SERVICE_ONLY' });
      await expect(streamChat({ ...profile, baseUrl }, {}, () => {})).rejects.toMatchObject({ code: 'LOCAL_SERVICE_ONLY' });
    }
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it('passes a local interface literal to the native ownership check', async () => {
    native.invoke.mockResolvedValue({ status: 'ok' });
    const local = { ...profile, baseUrl: 'http://192.168.1.10:18099' };
    await request(local, '/health');
    expect(native.invoke).toHaveBeenLastCalledWith('strata_request', { profile: local, path: '/health', method: 'GET' });
    native.invoke.mockRejectedValue('监听地址不是本机网络接口');
    await expect(request(local, '/health')).rejects.toThrow('监听地址不是本机网络接口');
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
