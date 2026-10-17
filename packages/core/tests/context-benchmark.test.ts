import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTEXT_BENCHMARK_HEADROOM, CONTEXT_BENCHMARK_TIERS, DEFAULT_CONTEXT_BENCHMARK_OPTIONS, getContextBenchmarkTiers, planContextBenchmarkTiers, runContextBenchmark, validateContextBenchmarkOptions, compareContextBenchmarkReports, benchmarkEvidenceSeries, benchmarkCounters } from '../src/context-benchmark';
import { acquireBenchmarkEndpoint } from '../src/benchmark';
import { StrataError } from '../src/errors';
import type { ChatDelta } from '../src/chat';
import type { ContextBenchmarkOptions, ContextBenchmarkProgress } from '../src/context-benchmark-types';
import type { JsonObject, ServiceProfile } from '../src/types';

const bridge = vi.hoisted(() => ({ request: vi.fn(), streamChat: vi.fn(), isDesktop: vi.fn(), serviceStatus: vi.fn(), benchmarkIdentity: vi.fn() }));
vi.mock('../src/bridge', () => ({ ...bridge, normalizeBaseUrl: (url: string) => new URL(url).origin }));
const profile: ServiceProfile = { id: 'context-fixture', name: 'Context fixture', baseUrl: 'http://127.0.0.1:8992', installDir: '', configPath: '', pythonPath: '', managed: false };
const health = { service: 'strata', status: 'ok', loaded: true, model: 'fixture-model', max_context: 262144 };
const options = (patch: Partial<ContextBenchmarkOptions> = {}): ContextBenchmarkOptions => ({ ...DEFAULT_CONTEXT_BENCHMARK_OPTIONS, tiers: [8192], ...patch });
const prompt = (body: JsonObject): string => String((body.messages as JsonObject[])[0]!.content);
const tokenCount = (body: JsonObject): number => (prompt(body).split('record alpha').length - 1) * 28 + 128;
let active = 0, peak = 0, latency = 100;
let calls: { at: number; body: JsonObject; signal: AbortSignal }[];
let failures: Set<number>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  for (const mock of Object.values(bridge)) mock.mockReset();
  active = 0; peak = 0; latency = 100; calls = []; failures = new Set();
  bridge.isDesktop.mockReturnValue(false);
  bridge.request.mockImplementation(async (_profile, path: string, _method, body: JsonObject) => {
    if (path === '/health') return { ...health };
    if (path === '/v1/messages/count_tokens') return { input_tokens: tokenCount(body) };
    return { live: { state: active ? 'generating' : 'idle', running: active, queued: 0 }, hardware: { gpu_mem_used: 100, gpu_mem_total: 1000, ram_used: 200 },
      requests: [{ prompt_tokens: 99999999, decode_tok_s: 99999, prompt_ms: 1 }], engine: { model: health.model } };
  });
  bridge.streamChat.mockImplementation((_profile, body: JsonObject, delta: (delta: ChatDelta) => void, signal: AbortSignal) => {
    calls.push({ at: performance.now(), body: structuredClone(body), signal });
    const index = calls.length; active++; peak = Math.max(active, peak);
    return new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); active--; reject(new StrataError('CANCELLED', 'fixture cancelled')); };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort); active--;
        if (failures.has(index)) { reject(new StrataError('HTTP_ERROR', 'fixture failure', 503)); return; }
        delta({ content: 'complete' });
        delta({ usage: { prompt_tokens: tokenCount(body), completion_tokens: 512, prompt_tokens_details: { cached_tokens: 0 } } });
        delta({ timings: { prompt_per_second: 1000, predicted_per_second: 80 } });
        delta({ finishReason: 'length' }); delta({ done: true }); resolve();
      }, latency);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  });
});
afterEach(() => { vi.useRealTimers(); });
async function settle<T>(work: Promise<T>, advance = 20_000): Promise<T> { await vi.advanceTimersByTimeAsync(advance); return work; }

describe('context benchmark budgets and calibration', () => {
  it('waits for model capacity before default selection and keeps fixed request safety limits', () => {
    expect(CONTEXT_BENCHMARK_TIERS).toEqual([8192, 32768, 65536, 131072, 262144, 393216, 524288, 786432, 1048576]);
    expect(DEFAULT_CONTEXT_BENCHMARK_OPTIONS).toMatchObject({ tiers: [], maxTokens: 512, rounds: 1, stopOnError: true });
    for (const patch of [{ tiers: [] }, { tiers: [8192, 8192] }, { tiers: [0] }, { tiers: [1.5] }, { tiers: [NaN] }, { tiers: [2147483648] }, { maxTokens: 15 }, { maxTokens: 4097 }, { rounds: 0 }, { rounds: 11 }, { timeoutMs: 999 }, { timeoutMs: 600001 }, { configurationLabel: 'x'.repeat(121) }, { stopOnError: 'yes' }]) {
      expect(() => validateContextBenchmarkOptions(options(patch as Partial<ContextBenchmarkOptions>))).toThrow();
    }
    expect(planContextBenchmarkTiers([8192], null, 512).skipped[0]!.reason).toContain('max_context');
    expect(planContextBenchmarkTiers([8192], 8192, 8192).skipped[0]!.reason).toContain('余量');
  });

  it('selects all supported tiers through exact model capacity, including nonstandard and 1M maxima', () => {
    expect(getContextBenchmarkTiers(196608)).toEqual([8192, 32768, 65536, 131072, 196608]);
    expect(getContextBenchmarkTiers(1000000)).toEqual([8192, 32768, 65536, 131072, 262144, 393216, 524288, 786432, 1000000]);
    expect(getContextBenchmarkTiers(1048576)).toEqual(CONTEXT_BENCHMARK_TIERS);
    expect(getContextBenchmarkTiers(1048577).at(-1)).toBe(1048577);
    expect(getContextBenchmarkTiers(4096)).toEqual([4096]);
    for (const capacity of [null, 0, -1, NaN, Infinity, 1.5, 2147483648]) expect(getContextBenchmarkTiers(capacity)).toEqual([]);
    expect(() => validateContextBenchmarkOptions(options({ tiers: [196608, 1000000, 1048576, 1048577] }))).not.toThrow();
  });

  it.each([1000000, 1048576])('calibrates a %i-token maximum and skips oversized tiers without sending them', async maxContext => {
    const request = bridge.request.getMockImplementation()!;
    bridge.request.mockImplementation(async (...args) => args[1] === '/health' ? { ...health, max_context: maxContext } : request(...args));
    const report = await settle(runContextBenchmark(profile, options({ tiers: [maxContext + 1, maxContext] })));
    expect(report.state).toBe('completed'); expect(calls).toHaveLength(1);
    expect(report.skippedTiers).toEqual([{ targetTokens: maxContext + 1, reason: expect.stringContaining('max_context') }]);
    const sample = report.samples[0]!;
    expect(sample.targetTokens).toBe(maxContext);
    expect(sample.targetPromptTokens).toBe(maxContext - 512 - CONTEXT_BENCHMARK_HEADROOM);
    expect(sample.countedPromptTokens).toBeGreaterThanOrEqual(sample.targetPromptTokens * 0.99);
    expect(sample.countedPromptTokens! + 512 + CONTEXT_BENCHMARK_HEADROOM).toBeLessThanOrEqual(maxContext);
    expect(sample.promptTokens).toBe(sample.countedPromptTokens);
    expect(sample.inputChars).toBeGreaterThan(3_000_000);
    expect(sample.inputChars).toBeLessThan(11_000_000);
  });

  it('bounds exceptionally large configurations and explicitly marks input below target', async () => {
    const request = bridge.request.getMockImplementation()!;
    bridge.request.mockImplementation(async (...args) => args[1] === '/health' ? { ...health, max_context: 2147483647 } : request(...args));
    const report = await settle(runContextBenchmark(profile, options({ tiers: [2147483647] })));
    const sample = report.samples[0]!;
    expect(calls).toHaveLength(1);
    expect(sample.inputChars).toBeLessThan(11_000_000);
    expect(sample.countedPromptTokens).toBeLessThan(sample.targetPromptTokens * 0.99);
    expect(sample.calibrationReason).toContain('未达到目标输入量');
  });

  it('sorts tiers, excludes unsupported capacities and makes exactly one request at a time', async () => {
    const progress: ContextBenchmarkProgress[] = [];
    const report = await settle(runContextBenchmark(profile, options({ tiers: [393216, 32768, 8192, 524288], rounds: 2, configurationLabel: 'native 262K' }), event => progress.push(event)));
    expect(peak).toBe(1); expect(active).toBe(0); expect(calls).toHaveLength(4);
    expect(report.schemaVersion).toBe(3); expect(report.maxContext).toBe(262144);
    expect(report.samples.map(s => [s.targetTokens, s.round])).toEqual([[8192, 1], [8192, 2], [32768, 1], [32768, 2]]);
    expect(report.skippedTiers.map(s => s.targetTokens)).toEqual([393216, 524288]);
    expect(report.skippedTiers.every(s => s.reason.includes('max_context'))).toBe(true);
    expect(report.samples.every(s => s.promptTokens! + 512 + CONTEXT_BENCHMARK_HEADROOM <= s.targetTokens)).toBe(true);
    expect(report.samples.every(s => s.tokenCountMethod === 'count_tokens' && s.countedPromptTokens === s.promptTokens)).toBe(true);
    expect(new Set(calls.map(c => prompt(c.body).split('\n')[0])).size).toBe(4);
    expect(calls.every(c => c.body.temperature === 0 && c.body.reasoning_effort === 'none' && c.body.max_tokens === 512 && c.body.enable_thinking === false)).toBe(true);
    expect(progress.at(-1)).toMatchObject({ total: 4, completed: 4, active: 0, currentTier: null });
    expect(report.resourceScope).toBe('system'); expect(report.resourceIntervalMs).toBe(1000);
    expect(report.options.configurationLabel).toBe('native 262K');
  });

  it('shrinks oversized tokenizer estimates before generation and submits the exact counted message', async () => {
    const counted = new Set<string>();
    bridge.request.mockImplementation(async (_profile, path, _method, body: JsonObject) => {
      if (path === '/health') return { ...health };
      if (path === '/v1/messages/count_tokens') { counted.add(prompt(body)); return { input_tokens: tokenCount(body) * 2 }; }
      return {};
    });
    const report = await settle(runContextBenchmark(profile, options(), () => {}));
    expect(bridge.request.mock.calls.filter(c => c[1] === '/v1/messages/count_tokens').length).toBeGreaterThan(1);
    expect(counted.has(prompt(calls[0]!.body))).toBe(true);
    expect(report.samples[0]!.countedPromptTokens! + 512 + 64).toBeLessThanOrEqual(8192);
    expect(report.samples[0]!.calibrationReason).toContain('实际 usage');
  });

  it('never generates when metadata counts remain above the input/output budget', async () => {
    bridge.request.mockImplementation(async (_profile, path) => path === '/health' ? { ...health } : path === '/v1/messages/count_tokens' ? { input_tokens: 99999999 } : {});
    const report = await settle(runContextBenchmark(profile, options({ stopOnError: false, rounds: 2 }), () => {}));
    expect(calls).toHaveLength(0); expect(report.state).toBe('failed'); expect(report.samples).toHaveLength(1);
    expect(report.samples[0]!.errorCode).toBe('BENCHMARK_CONTEXT_OVERFLOW');
  });

  it('exposes unavailable tokenizer estimates and keeps actual usage separate', async () => {
    bridge.request.mockImplementation(async (_profile, path) => {
      if (path === '/health') return { ...health };
      if (path === '/v1/messages/count_tokens') throw new StrataError('HTTP_ERROR', 'not found', 404);
      return {};
    });
    const report = await settle(runContextBenchmark(profile, options(), () => {}));
    const sample = report.samples[0]!;
    expect(sample.tokenCountMethod).toBe('estimated'); expect(sample.countedPromptTokens).toBeNull(); expect(sample.estimatedPromptTokens).not.toBeNull();
    expect(sample.promptTokens).toBe(tokenCount(calls[0]!.body)); expect(sample.calibrationReason).toContain('估算');
    expect(sample.peakGpuMemory).toBeNull(); expect(sample.minGpuMemoryFree).toBeNull(); expect(sample.peakRam).toBeNull();
  });

  it('fails closed for tokenizer authentication errors and unknown context capacity', async () => {
    bridge.request.mockImplementation(async (_profile, path) => {
      if (path === '/health') return { ...health };
      if (path === '/v1/messages/count_tokens') throw new StrataError('UNAUTHORIZED', 'unauthorized', 401);
      return {};
    });
    const denied = await settle(runContextBenchmark(profile, options(), () => {}));
    expect(denied.samples[0]!.errorCode).toBe('UNAUTHORIZED'); expect(calls).toHaveLength(0);
    bridge.request.mockImplementation(async (_profile, path) => path === '/health' ? { ...health, max_context: undefined } : {});
    const unknown = await settle(runContextBenchmark(profile, options(), () => {}));
    expect(unknown.maxContext).toBeNull(); expect(unknown.samples).toHaveLength(0); expect(unknown.skippedTiers).toHaveLength(1); expect(calls).toHaveLength(0);
  });
});

describe('request metrics and whole-system resource observations', () => {
  it('uses only generation usage/timings, tracks host peaks each second and includes request wall time', async () => {
    latency = 2500;
    bridge.request.mockImplementation(async (_profile, path, _method, body: JsonObject) => {
      if (path === '/health') return { ...health };
      if (path === '/v1/messages/count_tokens') return { input_tokens: tokenCount(body) };
      const mid = performance.now() >= 1000 && performance.now() < 2500;
      return { hardware: { gpu_mem_used: mid ? 900 : 100, gpu_mem_total: 1000, ram_used: mid ? 2000 : 200 }, requests: [{ decode_tok_s: 99999, prompt_tokens: 999999 }] };
    });
    const report = await settle(runContextBenchmark(profile, options(), () => {}));
    expect(report.samples[0]).toMatchObject({ state: 'completed', cachedTokens: 0, completionTokens: 512, prefillTokS: 1000, decodeTokS: 80, wallMs: 2500, ttftMs: 2500,
      peakGpuMemory: 900, minGpuMemoryFree: 100, peakRam: 2000, resourceSamples: 4 });
  });

  it('keeps a content-free run trace for Arena evidence: counters around the run and a bucketed resource series', async () => {
    latency = 2500;
    const GiB = 1024 ** 3;
    bridge.request.mockImplementation(async (_profile, path, _method, body: JsonObject) => {
      if (path === '/health') return { ...health };
      if (path === '/v1/messages/count_tokens') return { input_tokens: tokenCount(body) };
      const mid = performance.now() >= 1000 && performance.now() < 2500;
      return { hardware: { gpu_mem_used: (mid ? 21.4 : 18) * GiB, gpu_mem_total: 24 * GiB, ram_used: (mid ? 61.5 : 60) * GiB, gpu_util: mid ? 90 : 10 },
        totals: { requests: 10 + calls.length, prompt_tokens: 1000 + calls.length * 7000, output_tokens: 50 + calls.length * 512 } };
    });
    const report = await settle(runContextBenchmark(profile, options(), () => {}));
    expect(report.evidence?.counters).toEqual({ before: { requests: 10, promptTokens: 1000, outputTokens: 50 }, after: { requests: 11, promptTokens: 8000, outputTokens: 562 } });
    const series = report.evidence!.series;
    expect(series.count).toBe(report.samples[0]!.resourceSamples);
    expect(series.stepMs).toBe(1000); expect(series.vramGB).toHaveLength(Math.max(1, Math.ceil(report.elapsedMs / 1000)));
    expect(Math.max(...series.vramGB.map(v => v ?? 0))).toBe(21.4); expect(Math.max(...series.ramGB.map(v => v ?? 0))).toBe(61.5);
    expect(series.gpuUtil.every(u => u === null || (u >= 0 && u <= 100))).toBe(true);
    expect(Object.keys(report.evidence!).sort()).toEqual(['counters', 'series']); expect(JSON.stringify(report.evidence)).not.toMatch(/:"/);
  });

  it('buckets long runs into at most 120 steps and leaves counters null when the engine has no totals', () => {
    const t0 = 1_000_000, points = Array.from({ length: 3600 }, (_, i) => [t0 + i * 1000, (20 + (i === 1800 ? 2 : 0)) * 1024 ** 3, 60 * 1024 ** 3, i % 2 ? 100 : 50] as [number, number, number, number]);
    const series = benchmarkEvidenceSeries(points, t0, 3_600_000, 1000);
    expect(series.vramGB).toHaveLength(120); expect(series.stepMs).toBe(30_000); expect(series.count).toBe(3600);
    expect(Math.max(...series.vramGB.map(v => v ?? 0))).toBe(22); expect(series.gpuUtil[0]).toBe(75);
    expect(benchmarkCounters({ totals: { requests: 1 } })).toBeNull();
    expect(benchmarkCounters({ totals: { requests: 3, prompt_tokens: 9, output_tokens: 2 } })).toEqual({ requests: 3, promptTokens: 9, outputTokens: 2 });
  });

  it('keeps missing/invalid fields null rather than assigning host history or invented cache misses', async () => {
    bridge.request.mockImplementation(async (_profile, path, _method, body: JsonObject) => path === '/health' ? { ...health }
      : path === '/v1/messages/count_tokens' ? { input_tokens: tokenCount(body) }
      : { hardware: { gpu_mem_used: -1, gpu_mem_total: 1000, ram_used: '200' }, requests: [{ prompt_tokens: 999999, decode_tok_s: 99999 }] });
    bridge.streamChat.mockImplementation(async (_profile, body: JsonObject, delta: (delta: ChatDelta) => void) => { calls.push({ at: 0, body, signal: new AbortController().signal }); delta({ content: 'ok' }); delta({ done: true }); });
    const report = await settle(runContextBenchmark(profile, options(), () => {}));
    expect(report.samples[0]).toMatchObject({ promptTokens: null, completionTokens: null, cachedTokens: null, prefillTokS: null, decodeTokS: null, peakGpuMemory: null, minGpuMemoryFree: null, peakRam: null, resourceSamples: 0 });
  });
});

describe('lifecycle, stopping and shared endpoint gate', () => {
  it('does not start services and rejects stopped/unloaded/busy targets before generation', async () => {
    bridge.isDesktop.mockReturnValue(true); bridge.serviceStatus.mockResolvedValue({ running: false });
    await expect(runContextBenchmark(profile, options(), () => {})).rejects.toMatchObject({ code: 'BENCHMARK_SERVICE_STOPPED' });
    expect(calls).toHaveLength(0); bridge.isDesktop.mockReturnValue(false);
    bridge.request.mockResolvedValue({ ...health, loaded: false });
    await expect(runContextBenchmark(profile, options(), () => {})).rejects.toMatchObject({ code: 'BENCHMARK_MODEL_UNLOADED' });
    bridge.request.mockImplementation(async (_profile, path) => path === '/health' ? { ...health } : { live: { queued: 1 } });
    await expect(runContextBenchmark(profile, options(), () => {})).rejects.toMatchObject({ code: 'BENCHMARK_SERVICE_BUSY' });
    expect(calls).toHaveLength(0);
  });

  it('stops immediately on cancellation and never submits another row', async () => {
    latency = 5000;
    const controller = new AbortController();
    const running = runContextBenchmark(profile, options({ rounds: 3 }), () => {}, controller.signal);
    await vi.advanceTimersByTimeAsync(100); controller.abort();
    const report = await settle(running);
    expect(report.state).toBe('cancelled'); expect(report.samples).toHaveLength(1); expect(report.samples[0]!.state).toBe('cancelled');
    expect(calls).toHaveLength(1); expect(calls[0]!.signal.aborted).toBe(true); expect(active).toBe(0);
  });

  it('does not dispatch when cancelled during metadata preparation', async () => {
    const controller = new AbortController();
    bridge.request.mockImplementation(async (_profile, path) => {
      if (path === '/health') return { ...health };
      if (path === '/v1/messages/count_tokens') { controller.abort(); return { input_tokens: 7000 }; }
      return {};
    });
    const report = await settle(runContextBenchmark(profile, options({ rounds: 3 }), () => {}, controller.signal));
    expect(report.state).toBe('cancelled'); expect(calls).toHaveLength(0);
  });

  it('stops generation on timeout even when stopOnError is disabled', async () => {
    latency = 5000;
    const report = await settle(runContextBenchmark(profile, options({ timeoutMs: 1000, rounds: 3, stopOnError: false }), () => {}));
    expect(report.state).toBe('failed'); expect(report.samples).toHaveLength(1); expect(report.samples[0]!.errorCode).toBe('BENCHMARK_TIMEOUT');
    expect(calls).toHaveLength(1); expect(active).toBe(0);
  });

  it('retains the endpoint lock until a native transport settles after cancellation', async () => {
    let finish: (() => void) | undefined;
    bridge.streamChat.mockImplementation((_profile, body: JsonObject, _delta, signal: AbortSignal) => { calls.push({ at: 0, body, signal }); return new Promise<void>(resolve => { finish = resolve; }); });
    const controller = new AbortController();
    const run = runContextBenchmark(profile, options(), () => {}, controller.signal);
    await vi.advanceTimersByTimeAsync(100); controller.abort(); await settle(run, 100);
    expect(() => acquireBenchmarkEndpoint('http://localhost:8992')).toThrow('此服务已有一组测试');
    finish!(); await vi.advanceTimersByTimeAsync(0);
    const release = acquireBenchmarkEndpoint('http://localhost:8992'); release();
  });

  it('shares the existing serial/suite endpoint gate and releases it after normal completion', async () => {
    const release = acquireBenchmarkEndpoint(profile.baseUrl);
    await expect(runContextBenchmark(profile, options(), () => {})).rejects.toMatchObject({ code: 'BENCHMARK_ALREADY_RUNNING' });
    release(); await settle(runContextBenchmark(profile, options(), () => {}));
    const after = acquireBenchmarkEndpoint(profile.baseUrl); after();
  });

  it('detects model changes during a request and stops all later rows', async () => {
    latency = 5000;
    bridge.request.mockImplementation(async (_profile, path, _method, body: JsonObject) => path === '/health'
      ? { ...health, model: performance.now() >= 1000 ? 'changed' : health.model }
      : path === '/v1/messages/count_tokens' ? { input_tokens: tokenCount(body) } : {});
    const report = await settle(runContextBenchmark(profile, options({ rounds: 3, stopOnError: false }), () => {}));
    expect(report.stopReason).toBe('modelChanged'); expect(report.samples[0]!.errorCode).toBe('BENCHMARK_MODEL_CHANGED');
    expect(calls).toHaveLength(1); expect(calls[0]!.signal.aborted).toBe(true);
  });

  it('rechecks capacity after token counting and does not generate against reduced context', async () => {
    let counted = false;
    bridge.request.mockImplementation(async (_profile, path, _method, body: JsonObject) => {
      if (path === '/health') return { ...health, max_context: counted ? 4096 : 262144 };
      if (path === '/v1/messages/count_tokens') { counted = true; return { input_tokens: tokenCount(body) }; }
      return {};
    });
    const report = await settle(runContextBenchmark(profile, options({ rounds: 3, stopOnError: false }), () => {}));
    expect(report.samples[0]!.errorCode).toBe('BENCHMARK_CONTEXT_CHANGED'); expect(calls).toHaveLength(0);
  });

  it('can continue settled HTTP errors only when requested and keeps the report failed', async () => {
    failures = new Set([1]);
    const report = await settle(runContextBenchmark(profile, options({ rounds: 2, stopOnError: false }), () => {}));
    expect(report.samples.map(s => s.state)).toEqual(['failed', 'completed']); expect(report.state).toBe('failed'); expect(calls).toHaveLength(2);
  });
  it('captures read-only identity before generation and keeps older reports viewable without conclusions', async () => {
    bridge.isDesktop.mockReturnValue(true); bridge.serviceStatus.mockResolvedValue({ running: true });
    const identity = { schemaVersion: 1, capturedAt: 1, process: { pid: 42, startedAt: 1, running: true },
      runtime: { strength: 'sha256', fingerprint: 'runtime-a' }, model: { strength: 'sha256', fingerprint: 'model-a' },
      savedConfigurationHash: 'saved', effectiveStartupHash: 'effective', effectiveVerified: true };
    bridge.benchmarkIdentity.mockImplementation(async () => { expect(calls).toHaveLength(0); return identity; });
    const first = await settle(runContextBenchmark(profile, options()));
    expect(first.identity).toEqual(identity); expect(first.samples[0]?.firstVisibleMs).toBe(100);
    const old = { ...first, id: 'older', identity: undefined, samples: first.samples.map(({ firstVisibleMs: _first, ...sample }) => sample) };
    const [row] = compareContextBenchmarkReports(first, old);
    expect(row!.comparison.comparable).toBe(false); expect(row!.comparison.unknowns).toContain('identity');
    expect(row!.right.firstVisibleMs).toBeNull(); expect(row!.right.ttftMs).toBe(100);
    expect(row!.right.ramPeak).toBe(200); expect(row!.right.vramPeak).toBe(100);
  });
  it('adapts each tier to the shared condition rules and detects cache/input changes', async () => {
    const first = await settle(runContextBenchmark(profile, options({ tiers: [8192, 32768] })));
    const changed = { ...first, id: 'changed', samples: first.samples.map(sample => ({ ...sample, cachedTokens: 100, wallMs: sample.wallMs / 2 })) };
    const rows = compareContextBenchmarkReports(first, changed);
    expect(rows.map(row => row.tier)).toEqual([8192, 32768]);
    expect(rows.every(row => row.comparison.differences.includes('options') && !row.comparison.comparable)).toBe(true);
    expect(rows[0]!.right.wallMs).toBe(50);
  });
  it('keeps identity unavailable when the optional RPC is unsupported', async () => {
    bridge.isDesktop.mockReturnValue(true); bridge.serviceStatus.mockResolvedValue({ running: true });
    bridge.benchmarkIdentity.mockRejectedValue(new Error('unknown method'));
    const report = await settle(runContextBenchmark(profile, options()));
    expect(report.state).toBe('completed'); expect(report.identity).toBeUndefined(); expect(calls).toHaveLength(1);
  });
  it('separates first reasoning token from first non-empty answer text', async () => {
    bridge.streamChat.mockImplementation((_profile, body: JsonObject, delta: (value: ChatDelta) => void) => new Promise<void>(resolve => {
      setTimeout(() => delta({ reasoning: 'thinking' }), 25);
      setTimeout(() => delta({ content: '   ' }), 40);
      setTimeout(() => delta({ content: 'answer' }), 90);
      setTimeout(() => { delta({ usage: { prompt_tokens: tokenCount(body), completion_tokens: 32 } }); delta({ done: true }); resolve(); }, 100);
    }));
    const report = await settle(runContextBenchmark(profile, options()));
    expect(report.samples[0]).toMatchObject({ ttftMs: 25, firstVisibleMs: 90, wallMs: 100 });
  });
  it('ignores malformed optional identities while keeping historical measurements available', async () => {
    const report = await settle(runContextBenchmark(profile, options()));
    const malformed = { ...report, identity: { schemaVersion: 1, runtime: { strength: 'sha256', fingerprint: 42 } } as never };
    const [row] = compareContextBenchmarkReports(report, malformed);
    expect(row!.comparison.unknowns).toContain('identity'); expect(row!.right.ttftMs).toBe(100);
  });
});
