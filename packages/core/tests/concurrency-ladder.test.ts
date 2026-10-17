import { describe, expect, it } from 'vitest';
import { validateBenchmarkSuiteOptions } from '../src/benchmark-suite';
import { concurrencyLadderConclusion, concurrencyLadderLevels, concurrencyLadderMessage, concurrencyLadderOptions, concurrencyLadderRows, concurrencyLadderRowsFromSamples } from '../src/concurrency-ladder';
import type { BenchmarkSuiteReport, BenchmarkSuiteSample } from '../src/benchmark-suite-types';

const sample = (stage: number, concurrency: number, startedAt: number, wallMs: number, decode: number, ttft: number, extra: Partial<BenchmarkSuiteSample> = {}): BenchmarkSuiteSample => ({
  index: 0, warmup: false, model: 'm', startedAt, scenario: 'decode', stage, concurrency, worker: 1, conversationId: null, turn: 1, inputChars: 10, maxTokens: 256,
  state: 'completed', ttftMs: ttft, wallMs, promptTokens: 40, completionTokens: 256, cachedTokens: 0, prefillTokS: 500, decodeTokS: decode, output: '', ...extra });

describe('concurrency ladder', () => {
  it('walks 1, 2, 4 … to the slot count on the ramp stress engine', () => {
    expect(concurrencyLadderLevels(4)).toEqual([1, 2, 4]);
    expect(concurrencyLadderLevels(6)).toEqual([1, 2, 4, 6]);
    const options = concurrencyLadderOptions(1);
    expect(options).toMatchObject({ kind: 'stress', stressPattern: 'ramp', concurrency: 2, scenarios: ['decode'], warmup: true, durationMs: 80_000 });
    expect(() => validateBenchmarkSuiteOptions(concurrencyLadderOptions(8))).not.toThrow();
    expect(concurrencyLadderOptions(99).concurrency).toBe(32);
  });
  it('builds live rows from samples and final rows from stage windows', () => {
    const samples = [sample(1, 1, 0, 6400, 40, 300), sample(2, 2, 7000, 7300, 36, 320), sample(2, 2, 7000, 7300, 36, 340), sample(0, 1, 0, 1, 1, 1, { warmup: true })];
    const live = concurrencyLadderRowsFromSamples(samples);
    expect(live.map(r => r.concurrency)).toEqual([1, 2]);
    expect(live[0]!.totalTokS).toBeCloseTo(40, 5);
    expect(live[1]!.totalTokS).toBeCloseTo(512 / 7.3, 5);
    expect(live[1]!.ttftP50Ms).toBe(330);
    const report = { samples, stages: [{ index: 1, concurrency: 1, startedAt: 0, finishedAt: 7000, elapsedMs: 6400 }, { index: 2, concurrency: 2, startedAt: 7000, finishedAt: 14300, elapsedMs: 7300 }, { index: 3, concurrency: 4, startedAt: 14300, finishedAt: 14300, elapsedMs: 0 }], telemetry: [], measurementElapsedMs: 13700 } as unknown as BenchmarkSuiteReport;
    const rows = concurrencyLadderRows(report);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ concurrency: 2, completed: 2, failed: 0, perRequestTokS: 36 });
  });
  it('concludes where total throughput peaks, or that concurrency does not help', () => {
    const row = (concurrency: number, totalTokS: number, perRequestTokS: number) => ({ concurrency, completed: 4, failed: 0, totalTokS, perRequestTokS, ttftP50Ms: 300, ttftP95Ms: 500 });
    const gain = concurrencyLadderConclusion([row(1, 40, 40), row(2, 72, 36), row(4, 112, 28)]);
    expect(gain).toMatchObject({ code: 'ladder_gain', best: 4, values: { total: 112, gain: 2.8, perRequest: 28, drop: 30 } });
    expect(concurrencyLadderMessage(gain, true)).toBe('4 个同时时总吞吐最高：112 tok/s，是一次一个的 2.8 倍；每个请求降到 28 tok/s（−30%）。');
    const flat = concurrencyLadderConclusion([row(1, 30, 30), row(2, 31, 16)]);
    expect(flat).toMatchObject({ code: 'ladder_no_gain', best: 1 });
    expect(concurrencyLadderMessage(flat, false)).toMatch(/keep one at a time/);
    expect(concurrencyLadderConclusion([]).code).toBe('ladder_empty');
  });
});
