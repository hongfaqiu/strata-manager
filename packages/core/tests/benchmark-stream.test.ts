import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BENCHMARK_OPTIONS, runBenchmark } from '../src/benchmark';
import type { ServiceProfile } from '../src/types';

const profile: ServiceProfile = { id: 'sse-fixture', name: 'SSE fixture', baseUrl: 'http://127.0.0.1:8098', installDir: '', configPath: '', pythonPath: '', managed: false };
afterEach(() => { vi.unstubAllGlobals(); });

function fixture(done: boolean) {
  const chunks = [
    { choices: [{ delta: { reasoning_content: '先分析' } }] },
    { choices: [{ delta: { content: '这是代码审查结果' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 300, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 250 } },
      timings: { prompt_per_second: 1600, predicted_per_second: 100 } },
  ];
  const bytes = new TextEncoder().encode(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''));
  return vi.fn(async (input: string) => {
    const path = new URL(input, 'http://preview').searchParams.get('path');
    if (path === '/health') return new Response(JSON.stringify({ service: 'strata', status: 'ok', loaded: true, model: 'fixture-model', max_context: 32768 }));
    if (path === '/metrics') return new Response(JSON.stringify({ live: { running: 0, queued: 0 }, requests: [{ decode_tok_s: 9999 }] }));
    return new Response(new ReadableStream({ start(controller) {
      // Fragment UTF-8 and event boundaries as a real network may do.
      for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7));
      controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  });
}

describe('benchmark with actual browser request and SSE bridge', () => {
  it('records usage, finish reason and engine timings from this fragmented SSE response', async () => {
    const fetch = fixture(true); vi.stubGlobal('fetch', fetch);
    const report = await runBenchmark(profile, { ...DEFAULT_BENCHMARK_OPTIONS, rounds: 1 }, () => {});
    expect(report.state).toBe('completed');
    expect(report.samples[0]).toMatchObject({ output: '这是代码审查结果', promptTokens: 300, completionTokens: 40, cachedTokens: 250, prefillTokS: 1600, decodeTokS: 100, finishReason: 'stop', state: 'completed' });
    expect(report.samples[0]?.ttftMs).toBeGreaterThanOrEqual(0);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('preserves partial output and reports failure if the socket closes without DONE, even with finish_reason', async () => {
    vi.stubGlobal('fetch', fixture(false));
    const report = await runBenchmark(profile, { ...DEFAULT_BENCHMARK_OPTIONS, rounds: 3 }, () => {});
    expect(report.state).toBe('failed');
    expect(report.samples).toHaveLength(1);
    expect(report.samples[0]).toMatchObject({ state: 'failed', finishReason: 'stop', error: '服务数据流中断，未收到完成标记', output: '这是代码审查结果' });
  });
});
