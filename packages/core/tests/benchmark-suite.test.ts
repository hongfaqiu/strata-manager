import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BENCHMARK_SCENARIOS, DEFAULT_BENCHMARK_SUITE_OPTIONS, estimateBenchmarkSuiteRequests, runBenchmarkSuite, summarizeBenchmarkSuite, validateBenchmarkSuiteOptions } from '../src/benchmark-suite';
import { DEFAULT_BENCHMARK_OPTIONS, runBenchmark } from '../src/benchmark';
import { StrataError } from '../src/errors';
import type { BenchmarkSuiteOptions, BenchmarkSuiteProgress, BenchmarkSuiteReport, BenchmarkSuiteSample } from '../src/benchmark-suite-types';
import type { ChatDelta } from '../src/chat';
import type { JsonObject, ServiceProfile } from '../src/types';

const bridge = vi.hoisted(() => ({ request: vi.fn(), streamChat: vi.fn(), isDesktop: vi.fn(), serviceStatus: vi.fn() }));
vi.mock('../src/bridge', () => ({ ...bridge, normalizeBaseUrl: (url: string) => new URL(url).origin }));
const profile: ServiceProfile = { id: 'suite', name: 'Suite fixture', baseUrl: 'http://127.0.0.1:8991', installDir: '', configPath: '', pythonPath: '', managed: false };
const health = { service: 'strata', status: 'ok', loaded: true, model: 'fixture-model', max_context: 32768 };
const options = (patch: Partial<BenchmarkSuiteOptions> = {}): BenchmarkSuiteOptions => ({ ...DEFAULT_BENCHMARK_SUITE_OPTIONS, scenarios: ['short'], rounds: 1, durationMs: 30_000, stageDurationMs: 5000, ...patch });
let active = 0, peak = 0, latency = 100, output = 'result';
let calls: { at: number; body: JsonObject; signal: AbortSignal }[] = [];
let failures: Set<number>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  for (const mock of Object.values(bridge)) mock.mockReset();
  active = 0; peak = 0; latency = 100; output = 'result'; calls = []; failures = new Set();
  bridge.isDesktop.mockReturnValue(false);
  bridge.request.mockImplementation(async (_profile, path) => path === '/health' ? { ...health } : {
    live: { state: active ? 'generating' : 'idle', running: active, queued: 0, waiting: 0, admitting: active ? 2 : 0 },
    hardware: { cpu: 7, gpu_util: 8, gpu_mem_used: 1234, ram_used: 5678, gpu_temp: 40 },
    // A different client's speeds must never populate this suite's samples.
    requests: [{ decode_tok_s: 99999, prompt_tokens: 900000, prompt_ms: 1 }], engine: { model: health.model },
  });
  bridge.streamChat.mockImplementation((_profile, body: JsonObject, delta: (delta: ChatDelta) => void, signal: AbortSignal) => {
    calls.push({ at: performance.now(), body: structuredClone(body), signal });
    const index = calls.length; active++; peak = Math.max(peak, active);
    return new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); active--; reject(new StrataError('CANCELLED', 'transport cancelled')); };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort); active--;
        if (failures.has(index)) { reject(new StrataError('HTTP_ERROR', 'queue rejected', 429)); return; }
        delta({ reasoning: 'reasoning' }); delta({ content: output });
        delta({ usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 25 } } });
        delta({ timings: { prompt_per_second: 1000, predicted_per_second: 80 } }); delta({ finishReason: 'length' }); delta({ done: true }); resolve();
      }, latency);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  });
});
afterEach(() => { vi.useRealTimers(); });
async function settle<T>(promise: Promise<T>, advance = 35_000): Promise<T> { await vi.advanceTimersByTimeAsync(advance); return promise; }

describe('suite validation and scenarios', () => {
  it('validates all safety bounds, distinct scenarios and the theoretical request estimate', () => {
    expect(BENCHMARK_SCENARIOS.map(s => s.id)).toEqual(['short', 'code', 'long', 'decode', 'cache', 'conversation', 'custom']);
    expect(estimateBenchmarkSuiteRequests(options({ scenarios: ['short', 'code', 'conversation'], rounds: 2, conversationTurns: 4, warmup: true }))).toBe(12);
    expect(estimateBenchmarkSuiteRequests(options({ kind: 'stress', requestLimit: 99 }))).toBe(99);
    for (const patch of [{ scenarios: [] }, { scenarios: ['short', 'short'] }, { scenarios: ['unknown'] }, { rounds: 21 }, { maxTokens: 15 }, { maxTokens: 4097 }, { inputChars: 1023 }, { inputChars: 131073 }, { conversationTurns: 1 }, { conversationTurns: 11 }, { concurrency: 33 }, { requestLimit: 5001 }, { durationMs: 9999 }, { stageDurationMs: 4999 }, { requestDelayMs: 30001 }, { timeoutMs: 601000 }, { prompt: 'x'.repeat(131073) }, { scenarios: ['custom'], prompt: ' ' }]) {
      expect(() => validateBenchmarkSuiteOptions(options(patch as Partial<BenchmarkSuiteOptions>))).toThrow();
    }
    expect(() => validateBenchmarkSuiteOptions(options({ concurrency: 32, requestLimit: 5000, inputChars: 131072 }))).not.toThrow();
  });

  it('runs all measured scenarios serially with one excluded warmup each and builds actual long input characters', async () => {
    const runOptions = options({ scenarios: ['short', 'code', 'long', 'decode', 'cache', 'conversation'], warmup: true, rounds: 2, mode: 'repeat', inputChars: 2048 });
    const report = await settle(runBenchmarkSuite(profile, runOptions, () => {}));
    expect(peak).toBe(1);
    expect(report.samples.filter(s => s.warmup)).toHaveLength(6);
    expect(report.samples.filter(s => !s.warmup)).toHaveLength(16);
    expect(report.measurementElapsedMs).toBe(1600);
    expect(report.elapsedMs).toBe(2200);
    const long = report.samples.find(s => s.scenario === 'long');
    expect(long?.inputChars).toBe(2048);
    const cacheCalls = calls.filter(call => (call.body.messages as JsonObject[])[0]?.content === report.options.prompt);
    expect(cacheCalls.length).toBeGreaterThan(1);
    expect(report.samples.every(s => s.output.length <= 512)).toBe(true);
    expect(summarizeBenchmarkSuite(report).completed).toBe(16);
    expect(summarizeBenchmarkSuite(report).truncatedCount).toBe(16);
    expect(summarizeBenchmarkSuite(report).aggregateOutputTokS).toBe(200);
  });

  it('carries complete assistant text and reasoning in real multi-turn history while reports store only 512 characters', async () => {
    output = '完整回答'.repeat(300);
    const report = await settle(runBenchmarkSuite(profile, options({ scenarios: ['conversation'], conversationTurns: 3 }), () => {}));
    expect(report.samples.map(s => s.turn)).toEqual([1, 2, 3]);
    expect(new Set(report.samples.map(s => s.conversationId)).size).toBe(1);
    expect(report.samples.every(s => s.output.length === 512)).toBe(true);
    const second = calls[1]!.body.messages as JsonObject[];
    const third = calls[2]!.body.messages as JsonObject[];
    expect(second).toHaveLength(3); expect(third).toHaveLength(5);
    expect(second[1]).toEqual({ role: 'assistant', content: output, reasoning_content: 'reasoning' });
    expect(third[3]?.content).toBe(output);
    expect(report.samples[2]!.inputChars).toBeGreaterThan(output.length * 2);
  });

  it('keeps cache prompts identical despite unique mode but varies regular prompts', async () => {
    await settle(runBenchmarkSuite(profile, options({ scenarios: ['cache', 'short'], rounds: 2, warmup: true, mode: 'unique' }), () => {}));
    const prompts = calls.map(c => (c.body.messages as JsonObject[])[0]!.content);
    expect(prompts[0]).toBe(prompts[2]); expect(prompts[2]).toBe(prompts[4]);
    expect(new Set([prompts[1], prompts[3], prompts[5]]).size).toBe(3);
  });
});

describe('stress concurrency, stages and safety', () => {
  it('obeys the HTTP concurrency ceiling and one shared dispatch budget, draining the last issued batch', async () => {
    const events: BenchmarkSuiteProgress[] = [];
    const report = await settle(runBenchmarkSuite(profile, options({ kind: 'stress', concurrency: 4, stressPattern: 'steady', requestLimit: 17 }), p => events.push(p)));
    expect(peak).toBe(4); expect(calls).toHaveLength(17); expect(active).toBe(0);
    expect(report.samples).toHaveLength(17); expect(report.samples.every(s => s.state === 'completed')).toBe(true);
    expect(report.stopReason).toBe('requestLimit'); expect(report.measurementElapsedMs).toBe(500);
    expect(Math.max(...events.map(p => p.active))).toBe(4); expect(Math.max(...events.map(p => p.issued))).toBe(17);
  });

  it('supports 32 client HTTP requests without exceeding the configured ceiling', async () => {
    const report = await settle(runBenchmarkSuite(profile, options({ kind: 'stress', concurrency: 32, stressPattern: 'steady', requestLimit: 64 }), () => {}));
    expect(peak).toBe(32); expect(calls).toHaveLength(64); expect(active).toBe(0);
    expect(report.samples.every(s => s.concurrency === 32)).toBe(true);
    expect(report.measurementElapsedMs).toBe(200);
  });

  it('ramps 1/2/4 and drains old stage requests before assigning a new stage without resetting the budget', async () => {
    latency = 1200;
    const report = await settle(runBenchmarkSuite(profile, options({ kind: 'stress', concurrency: 4, stressPattern: 'ramp', requestLimit: 22 }), () => {}));
    expect(report.stages.map(s => s.concurrency)).toEqual([1, 2, 4]);
    expect(report.samples).toHaveLength(22); expect(peak).toBe(4);
    expect(report.stages[0]!.elapsedMs).toBe(6000);
    for (let i = 1; i < report.stages.length; i++) expect(report.stages[i]!.startedAt).toBeGreaterThanOrEqual(report.stages[i - 1]!.finishedAt);
    for (const sample of report.samples) {
      const stage = report.stages.find(s => s.index === sample.stage)!;
      expect(sample.startedAt + sample.wallMs).toBeLessThanOrEqual(stage.finishedAt);
      expect(sample.concurrency).toBe(stage.concurrency);
    }
  });

  it('uses a hard overall duration that cancels in-flight work, excludes warmup time and captures resource telemetry only', async () => {
    latency = 15_000;
    const progress: BenchmarkSuiteProgress[] = [];
    const report = await settle(runBenchmarkSuite(profile, options({ kind: 'stress', stressPattern: 'steady', concurrency: 3, durationMs: 10_000, requestLimit: 200 }), p => progress.push(p)), 20_000);
    expect(report.state).toBe('completed'); expect(report.stopReason).toBe('duration');
    expect(report.measurementElapsedMs).toBe(10_000); expect(report.samples).toHaveLength(3);
    expect(report.samples.every(s => s.state === 'cancelled')).toBe(true); expect(active).toBe(0);
    expect(report.telemetry.length).toBeGreaterThanOrEqual(4);
    expect(report.telemetry[0]).toMatchObject({ cpuUtil: 7, gpuUtil: 8, gpuMemoryUsed: 1234, ramUsed: 5678, gpuTemperature: 40, queued: 2 });
    expect(report.telemetry[0]).not.toHaveProperty('decodeTokS');
    expect(progress.some(p => p.telemetry)).toBe(true);
    expect(summarizeBenchmarkSuite(report).failed).toBe(0);
    expect(summarizeBenchmarkSuite(report).aggregateOutputTokS).toBeNull();
  });

  it('starts the stress deadline after serial warmups rather than spending the measurement allowance on preheating', async () => {
    latency = 15_000;
    const report = await settle(runBenchmarkSuite(profile, options({ kind: 'stress', warmup: true, stressPattern: 'steady', concurrency: 2, durationMs: 10_000 }), () => {}));
    expect(report.samples.filter(s => s.warmup)).toHaveLength(1);
    expect(report.samples[0]?.state).toBe('completed');
    expect(report.samples.filter(s => !s.warmup)).toHaveLength(2);
    expect(report.elapsedMs).toBe(25_000); expect(report.measurementElapsedMs).toBe(10_000);
    expect(summarizeBenchmarkSuite(report).completed).toBe(0);
  });

  it('continues settled HTTP failures unless stopOnError is enabled and counts error status separately', async () => {
    failures = new Set([1, 3]);
    const report = await settle(runBenchmarkSuite(profile, options({ kind: 'stress', stressPattern: 'steady', concurrency: 2, requestLimit: 6 }), () => {}));
    const summary = summarizeBenchmarkSuite(report);
    expect(report.samples).toHaveLength(6); expect(summary.completed).toBe(4); expect(summary.failed).toBe(2);
    expect(summary.errors).toEqual([{ code: 'HTTP_ERROR', status: 429, count: 2 }]);
    expect(summary.outputTokens).toBeNull();
    expect(summary.requestsPerSecond).toBeCloseTo(4 * 1000 / report.measurementElapsedMs);
    failures = new Set([7]);
    const stopped = await settle(runBenchmarkSuite(profile, options({ rounds: 10, stopOnError: true }), () => {}));
    expect(stopped.stopReason).toBe('error'); expect(stopped.state).toBe('failed'); expect(stopped.samples).toHaveLength(1);
  });

  it('aborts all active requests when health reports a changed model, without mistaking its own activity for external load', async () => {
    latency = 5000;
    bridge.request.mockImplementation(async (_profile, path) => path === '/health'
      ? { ...health, model: performance.now() >= 2000 ? 'changed-model' : health.model }
      : { live: { state: active ? 'generating' : 'idle', running: active, queued: 0 } });
    const report = await settle(runBenchmarkSuite(profile, options({ kind: 'stress', stressPattern: 'steady', concurrency: 4 }), () => {}));
    expect(report.state).toBe('failed'); expect(report.stopReason).toBe('modelChanged');
    expect(report.samples).toHaveLength(4); expect(report.samples.every(s => s.state === 'cancelled')).toBe(true);
    expect(report.measurementElapsedMs).toBe(2000); expect(active).toBe(0);
  });

  it('stops on a request timeout and retains the endpoint gate while the actual transport still settles', async () => {
    let resolveTransport: (() => void) | undefined;
    bridge.streamChat.mockImplementation(() => new Promise<void>(resolve => { resolveTransport = resolve; }));
    const pending = runBenchmarkSuite(profile, options({ kind: 'stress', concurrency: 1, requestLimit: 100, timeoutMs: 1000 }), () => {});
    await vi.advanceTimersByTimeAsync(1000);
    const report = await pending;
    expect(report.stopReason).toBe('error'); expect(report.samples).toHaveLength(1);
    expect(summarizeBenchmarkSuite(report).timeoutCount).toBe(1);
    await expect(runBenchmarkSuite(profile, options(), () => {})).rejects.toMatchObject({ code: 'BENCHMARK_ALREADY_RUNNING' });
    resolveTransport!(); await vi.advanceTimersByTimeAsync(0);
    bridge.streamChat.mockImplementation(async (_profile, _body, delta) => { delta({ done: true }); });
    expect((await runBenchmarkSuite(profile, options(), () => {})).state).toBe('completed');
  });

  it('shares the endpoint lock with legacy serial runs and propagates explicit cancellation to every active stream', async () => {
    latency = 5000;
    const controller = new AbortController();
    const pending = runBenchmarkSuite(profile, options({ kind: 'stress', stressPattern: 'steady', concurrency: 3 }), () => {}, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    await expect(runBenchmark({ ...profile, baseUrl: 'http://localhost:8991/v1' }, DEFAULT_BENCHMARK_OPTIONS, () => {})).rejects.toMatchObject({ code: 'BENCHMARK_ALREADY_RUNNING' });
    controller.abort(); await vi.advanceTimersByTimeAsync(0);
    const report = await pending;
    expect(report.state).toBe('cancelled'); expect(report.stopReason).toBe('cancelled'); expect(report.samples).toHaveLength(3);
    expect(calls.every(c => c.signal.aborted)).toBe(true); expect(active).toBe(0);
    const legacyController = new AbortController();
    const legacy = runBenchmark(profile, { ...DEFAULT_BENCHMARK_OPTIONS, rounds: 1 }, () => {}, legacyController.signal);
    await vi.advanceTimersByTimeAsync(0);
    await expect(runBenchmarkSuite(profile, options(), () => {})).rejects.toMatchObject({ code: 'BENCHMARK_ALREADY_RUNNING' });
    legacyController.abort(); await vi.advanceTimersByTimeAsync(0); await legacy;
  });

  it('runs the finite suite plan without applying hidden stress budget or duration settings', async () => {
    latency = 1000;
    const report = await settle(runBenchmarkSuite(profile, options({ scenarios: ['conversation'], conversationTurns: 10, rounds: 2, requestLimit: 7, durationMs: 10_000 }), () => {}));
    expect(report.samples).toHaveLength(20); expect(report.stopReason).toBe('completed');
    expect(report.measurementElapsedMs).toBe(20_000);
    bridge.request.mockResolvedValueOnce({ ...health, max_context: 263 });
    await expect(runBenchmarkSuite(profile, options({ maxTokens: 256 }), () => {})).rejects.toMatchObject({ code: 'INVALID_BENCHMARK_OPTIONS' });
    expect(calls).toHaveLength(20);
  });
});

describe('suite summary grouping and missing evidence', () => {
  it('excludes all warmups, uses stage elapsed including failed waiting and preserves missing aggregate counters', async () => {
    const report = await settle(runBenchmarkSuite(profile, options({ warmup: true, scenarios: ['short', 'code'], rounds: 2 }), () => {}));
    const sample = report.samples.find(s => !s.warmup)!;
    const samples: BenchmarkSuiteSample[] = [
      { ...sample, warmup: true, completionTokens: 99999, wallMs: 99999 },
      { ...sample, scenario: 'short', stage: 1, wallMs: 100, ttftMs: 20, completionTokens: 10 },
      { ...sample, scenario: 'code', stage: 1, wallMs: 300, ttftMs: 30, completionTokens: 20, decodeTokS: null },
      { ...sample, scenario: 'short', stage: 2, state: 'failed', completionTokens: null, errorCode: 'BENCHMARK_TIMEOUT', httpStatus: null },
    ];
    const grouped: BenchmarkSuiteReport = { ...report, samples, measurementElapsedMs: 2000, stages: [
      { index: 1, concurrency: 1, elapsedMs: 1000, startedAt: 0, finishedAt: 1000 },
      { index: 2, concurrency: 2, elapsedMs: 1000, startedAt: 1000, finishedAt: 2000 },
    ], telemetry: [
      { at: -100, elapsedMs: 0, active: 1, queued: 9999, running: 1, cpuUtil: 90, gpuUtil: 90, gpuMemoryUsed: 99999, ramUsed: 99999, gpuTemperature: 99 },
      { at: 500, elapsedMs: 500, active: 1, queued: 2, running: 1, cpuUtil: 10, gpuUtil: 10, gpuMemoryUsed: 200, ramUsed: 300, gpuTemperature: 40 },
    ] };
    const all = summarizeBenchmarkSuite(grouped), stage = summarizeBenchmarkSuite(grouped, { stage: 1 });
    expect(all.completed).toBe(2); expect(all.failed).toBe(1); expect(all.timeoutCount).toBe(1);
    expect(all.aggregateOutputTokS).toBeNull(); expect(all.outputTokens).toBeNull(); expect(all.requestsPerSecond).toBe(1);
    expect(stage.outputTokens).toBe(30); expect(stage.aggregateOutputTokS).toBe(30); expect(stage.requestsPerSecond).toBe(2);
    expect(stage.wallMs).toEqual({ mean: 200, p50: 200, p95: 290, p99: 298 }); expect(stage.decodeTokS).toBe(80);
    expect(all.peakQueue).toBe(2); expect(all.peakGpuMemory).toBe(200); expect(all.peakRam).toBe(300);
    expect(summarizeBenchmarkSuite(grouped, { scenario: 'short', stage: 1 }).completed).toBe(1);
    expect(summarizeBenchmarkSuite(grouped, { scenario: 'decode' }).outputTokens).toBeNull();
  });
});
