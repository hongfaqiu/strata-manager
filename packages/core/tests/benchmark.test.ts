import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BENCHMARK_PROMPTS, DEFAULT_BENCHMARK_OPTIONS, runBenchmark, summarizeBenchmark, type BenchmarkOptions, type BenchmarkReport, type BenchmarkSample } from '../src/benchmark';
import { decodeChatChunk } from '../src/chat';
import { StrataError } from '../src/errors';
import type { ChatDelta } from '../src/chat';
import type { ServiceProfile } from '../src/types';

const bridge = vi.hoisted(() => ({ request: vi.fn(), streamChat: vi.fn(), isDesktop: vi.fn(), serviceStatus: vi.fn() }));
vi.mock('../src/bridge', () => ({ ...bridge, normalizeBaseUrl: (url: string) => new URL(url).origin }));
const profile: ServiceProfile = { id: 'fixture', name: 'Fixture', baseUrl: 'http://127.0.0.1:8099/v1', installDir: '', configPath: '', pythonPath: '', managed: true };
const options: BenchmarkOptions = { ...DEFAULT_BENCHMARK_OPTIONS, rounds: 2, timeoutMs: 1000 };
const health = { service: 'strata', status: 'ok', loaded: true, model: 'loaded-model', max_context: 32768 };
let monotonic = 0;

beforeEach(() => {
  for (const mock of Object.values(bridge)) mock.mockReset();
  bridge.isDesktop.mockReturnValue(false);
  bridge.request.mockImplementation(async (_profile, path) => path === '/health' ? { ...health } : {
    hardware: { gpu: 'fixture' }, engine: { model: 'loaded-model' }, live: { running: 0, queued: 0 },
    // This is another client's request and must never contribute to the benchmark.
    requests: [{ prompt_ms: 1, prompt_tokens: 900000, reused: 0, decode_tok_s: 999999 }],
  });
  monotonic = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
  bridge.streamChat.mockImplementation(async (_profile, _body, delta: (delta: ChatDelta) => void) => {
    monotonic += 20; delta({ content: '' });
    monotonic += 30; delta({ reasoning: '分析' });
    monotonic += 50; delta({ content: '结果' });
    delta({ usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 50 } } });
    delta({ timings: { prompt_per_second: 500, predicted_per_second: 80 } });
    delta({ finishReason: 'length' }); delta({ done: true });
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('benchmark stream protocol', () => {
  it('exposes only same-response engine timings and finish reason, without declaring finish_reason to be DONE', () => {
    expect(decodeChatChunk(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 12 }, timings: { predicted_per_second: 50 } })))
      .toEqual([{ usage: { prompt_tokens: 12 } }, { timings: { predicted_per_second: 50 } }, { finishReason: 'length' }]);
    expect(decodeChatChunk('[DONE]')).toEqual([{ done: true }]);
  });
});

describe('read-only serial benchmark', () => {
  it('measures reasoning first token, serial rounds, optional excluded warmup and same-request speed', async () => {
    const seen: BenchmarkSample[] = [];
    const report = await runBenchmark(profile, { ...options, warmup: true }, sample => seen.push(sample));
    expect(report).toMatchObject({ state: 'completed', baseUrl: 'http://127.0.0.1:8099', model: 'loaded-model', hardware: { gpu: 'fixture' }, engine: { model: 'loaded-model' } });
    expect(seen).toHaveLength(3);
    expect(seen.map(sample => [sample.index, sample.warmup])).toEqual([[0, true], [1, false], [2, false]]);
    expect(seen[1]).toMatchObject({ ttftMs: 50, wallMs: 100, promptTokens: 100, completionTokens: 20, cachedTokens: 50, prefillTokS: 500, decodeTokS: 80, finishReason: 'length', output: '结果' });
    expect(summarizeBenchmark(report)).toEqual({ completed: 2, failed: 0, cancelled: 0, ttftMs: { mean: 50, p50: 50, p95: 50 }, wallMs: { mean: 100, p50: 100, p95: 100 }, prefillTokS: 500, decodeTokS: 80, cacheHitRate: 0.5 });
    const bodies = bridge.streamChat.mock.calls.map(call => call[1]);
    expect(bodies[0]).toMatchObject({ model: 'loaded-model', stream: true, stream_options: { include_usage: true }, max_tokens: 256, temperature: 0, seed: 42 });
    const prompts = bodies.map(body => body.messages[0].content as string);
    expect(new Set(prompts).size).toBe(3);
    expect(prompts[0]?.endsWith(options.prompt)).toBe(true);
    expect(prompts[0]?.startsWith(`[benchmark ${report.id}/warmup]`)).toBe(true);
    expect(bridge.request.mock.calls.every(call => call[1] === '/health' || call[1] === '/metrics')).toBe(true);
  });

  it('keeps repeated prompts identical and never borrows global last-request speed', async () => {
    bridge.streamChat.mockImplementation(async (_profile, _body, delta) => { delta({ content: 'ok' }); delta({ done: true }); });
    const report = await runBenchmark(profile, { ...options, mode: 'repeat', warmup: true }, () => {});
    expect(bridge.streamChat.mock.calls.map(call => call[1].messages[0].content)).toEqual([options.prompt, options.prompt, options.prompt]);
    expect(report.samples.every(sample => sample.promptTokens === null && sample.cachedTokens === null && sample.prefillTokS === null && sample.decodeTokS === null)).toBe(true);
    expect(summarizeBenchmark(report).cacheHitRate).toBeNull();
    expect(summarizeBenchmark(report).decodeTokS).toBeNull();
  });

  it('rejects preflight for stopped, unloaded, busy or unidentified service without inference', async () => {
    bridge.isDesktop.mockReturnValue(true);
    bridge.serviceStatus.mockResolvedValue({ running: false });
    await expect(runBenchmark(profile, options, () => {})).rejects.toMatchObject({ code: 'BENCHMARK_SERVICE_STOPPED' });
    expect(bridge.request).not.toHaveBeenCalled();
    bridge.isDesktop.mockReturnValue(false);
    for (const [patch, code] of [[{ loaded: false }, 'BENCHMARK_MODEL_UNLOADED'], [{ model: '' }, 'BENCHMARK_MODEL_UNKNOWN'], [{ service: 'other' }, 'BENCHMARK_SERVICE_UNAVAILABLE']] as const) {
      bridge.request.mockResolvedValueOnce({ ...health, ...patch });
      await expect(runBenchmark(profile, options, () => {})).rejects.toMatchObject({ code });
    }
    bridge.request.mockResolvedValueOnce(health).mockResolvedValueOnce({ live: { running: 1 } });
    await expect(runBenchmark(profile, options, () => {})).rejects.toMatchObject({ code: 'BENCHMARK_SERVICE_BUSY' });
    expect(bridge.streamChat).not.toHaveBeenCalled();
  });

  it('validates bounds, cancellation and context budget before inference', async () => {
    for (const patch of [{ rounds: 11 }, { rounds: 0 }, { maxTokens: 4097 }, { maxTokens: 15 }, { prompt: '' }, { timeoutMs: 999 }, { timeoutMs: 600001 }, { mode: 'invalid' }])
      await expect(runBenchmark(profile, { ...options, ...patch } as BenchmarkOptions, () => {})).rejects.toMatchObject({ code: 'INVALID_BENCHMARK_OPTIONS' });
    expect(bridge.request).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    await expect(runBenchmark(profile, options, () => {}, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(bridge.request).not.toHaveBeenCalled();
    bridge.request.mockResolvedValueOnce({ ...health, max_context: 256 });
    await expect(runBenchmark(profile, options, () => {})).rejects.toMatchObject({ code: 'INVALID_BENCHMARK_OPTIONS' });
    expect(bridge.streamChat).not.toHaveBeenCalled();
    expect(BENCHMARK_PROMPTS.long.length).toBeGreaterThan(BENCHMARK_PROMPTS.mixed.length);
  });

  it('rejects real serial activity and parallel waiting work even when queued and running are zero or absent', async () => {
    const busySnapshots = [
      { live: { state: 'reading', queued: 0 } },
      { live: { state: 'generating', queued: 0 } },
      { live: { state: 'idle', queued: 0, running: 0, waiting: 1 } },
      { live: { state: 'idle', queued: 0, running: 0, waiting: 0, admitting: 1 } },
      { live: { state: 'idle', queued: 0, running: 0, outside_slots: 1 } },
      { live: { state: 'idle', queued: 0 }, activity: { in_flight: 1 } },
    ];
    for (const snapshot of busySnapshots) {
      bridge.request.mockResolvedValueOnce(health).mockResolvedValueOnce(snapshot);
      await expect(runBenchmark(profile, options, () => {})).rejects.toMatchObject({ code: 'BENCHMARK_SERVICE_BUSY' });
    }
    expect(bridge.streamChat).not.toHaveBeenCalled();
    // The same schema with all activity absent/zero still permits an idle model.
    bridge.request.mockResolvedValueOnce(health).mockResolvedValueOnce({ live: { state: 'idle', running: 0, queued: 0, waiting: 0, admitting: 0, outside_slots: 0 }, activity: { in_flight: 0 } });
    expect((await runBenchmark(profile, { ...options, rounds: 1 }, () => {})).state).toBe('completed');
  });

  it('marks dropped streams and failed warmups as failed and stops subsequent rounds', async () => {
    bridge.streamChat.mockImplementation(async (_profile, _body, delta) => { delta({ content: 'partial' }); });
    const report = await runBenchmark(profile, { ...options, warmup: true }, () => {});
    expect(report.state).toBe('failed');
    expect(report.samples).toHaveLength(1);
    expect(report.samples[0]).toMatchObject({ state: 'failed', warmup: true, error: '服务数据流中断，未收到完成标记', output: 'partial' });
    expect(summarizeBenchmark(report).completed).toBe(0);
    expect(summarizeBenchmark(report).ttftMs.mean).toBeNull();
    bridge.streamChat.mockRejectedValueOnce(new StrataError('STREAM_ERROR', 'engine stopped'));
    expect((await runBenchmark(profile, options, () => {})).samples[0]).toMatchObject({ state: 'failed', error: 'engine stopped' });
  });

  it('cancels the active stream and does not execute a second round', async () => {
    const controller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    bridge.streamChat.mockImplementation(async (_profile, _body, delta, signal) => {
      transportSignal = signal; delta({ reasoning: 'partial reasoning' }); controller.abort();
      throw new StrataError('CANCELLED', '请求已取消');
    });
    const report = await runBenchmark(profile, options, () => {}, controller.signal);
    expect(report).toMatchObject({ state: 'cancelled', samples: [{ state: 'cancelled', output: '[推理输出]\npartial reasoning' }] });
    expect(transportSignal?.aborted).toBe(true);
    expect(bridge.streamChat).toHaveBeenCalledOnce();
  });

  it('times out an unresponsive stream, freezes late callbacks and releases the service lock', async () => {
    vi.useFakeTimers();
    let lateDelta: ((delta: ChatDelta) => void) | undefined, transportSignal: AbortSignal | undefined;
    bridge.streamChat.mockImplementation((_profile, _body, delta, signal) => { lateDelta = delta; transportSignal = signal; return new Promise(() => {}); });
    const pending = runBenchmark(profile, options, () => {});
    await vi.advanceTimersByTimeAsync(0);
    await expect(runBenchmark(profile, options, () => {})).rejects.toMatchObject({ code: 'BENCHMARK_ALREADY_RUNNING' });
    await vi.advanceTimersByTimeAsync(1000);
    const report = await pending;
    expect(report).toMatchObject({ state: 'failed', samples: [{ state: 'failed', error: '本轮超过 1 秒，已取消请求' }] });
    expect(transportSignal?.aborted).toBe(true);
    lateDelta?.({ content: 'late output' });
    expect(report.samples[0]?.output).toBe('');
    bridge.streamChat.mockImplementation(async (_profile, _body, delta) => { delta({ done: true }); });
    expect((await runBenchmark(profile, { ...options, rounds: 1 }, () => {})).state).toBe('completed');
  });

  it('stops if the loaded model changes between measured rounds', async () => {
    bridge.request.mockResolvedValueOnce(health).mockResolvedValueOnce({}).mockResolvedValueOnce({ ...health, model: 'new-model' });
    const report = await runBenchmark(profile, options, () => {});
    expect(report.state).toBe('failed');
    expect(report.samples[1]).toMatchObject({ state: 'failed', error: '测试期间模型发生变化，已停止后续轮次' });
    expect(bridge.streamChat).toHaveBeenCalledOnce();
  });
});

describe('benchmark summaries', () => {
  it('excludes warmups, errors and unknown measurements and uses interpolated percentiles', async () => {
    const report = await runBenchmark(profile, options, () => {});
    const sample = report.samples[0]!;
    const samples: BenchmarkSample[] = [
      { ...sample, warmup: true, wallMs: 999999, ttftMs: 999999 },
      { ...sample, index: 1, wallMs: 100, ttftMs: 10, decodeTokS: 40, cachedTokens: 20 },
      { ...sample, index: 2, wallMs: 300, ttftMs: null, decodeTokS: null, prefillTokS: null, cachedTokens: null },
      { ...sample, index: 3, state: 'failed', wallMs: 90000, ttftMs: 40000 },
    ];
    const summary = summarizeBenchmark({ ...report, samples } as BenchmarkReport);
    expect(summary).toEqual({ completed: 2, failed: 1, cancelled: 0, wallMs: { mean: 200, p50: 200, p95: 290 }, ttftMs: { mean: 10, p50: 10, p95: 10 }, prefillTokS: 500, decodeTokS: 40, cacheHitRate: 0.2 });
  });
});
