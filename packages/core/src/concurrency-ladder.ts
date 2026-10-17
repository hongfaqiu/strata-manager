import { DEFAULT_BENCHMARK_SUITE_OPTIONS, summarizeBenchmarkSuite } from './benchmark-suite';
import type { BenchmarkSuiteOptions, BenchmarkSuiteReport, BenchmarkSuiteSample } from './benchmark-suite-types';

/** One step of a concurrency ladder: N requests kept in flight together. */
export interface ConcurrencyLadderRow {
  concurrency: number;
  completed: number;
  failed: number;
  /** Output tokens per second across all requests of the step. */
  totalTokS: number | null;
  /** Mean engine decode speed of one request. */
  perRequestTokS: number | null;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
}
export interface ConcurrencyLadderConclusion { code: 'ladder_gain' | 'ladder_no_gain' | 'ladder_empty'; best: number; values: Record<string, number> }

export const CONCURRENCY_LADDER_STAGE_MS = 40_000;
/** The ladder steps the engine ramp runs: 1, 2, 4 … up to the top. */
export function concurrencyLadderLevels(top: number): number[] {
  const levels = [1];
  while (levels.at(-1)! < top) levels.push(Math.min(top, levels.at(-1)! * 2));
  return levels;
}
/** Ramp stress options for a ladder up to `slots` (at least 2, so one-at-a-time services still show the queue). */
export function concurrencyLadderOptions(slots: number, stageMs = CONCURRENCY_LADDER_STAGE_MS): BenchmarkSuiteOptions {
  const top = Math.max(2, Math.min(32, Math.round(slots) || 1));
  const stages = concurrencyLadderLevels(top).length;
  return { ...DEFAULT_BENCHMARK_SUITE_OPTIONS, kind: 'stress', stressPattern: 'ramp', stressLimit: 'duration', concurrency: top, scenarios: ['decode'],
    maxTokens: 256, warmup: true, mode: 'unique', timeoutMs: 180_000, stopOnError: false, requestLimit: 5000, requestDelayMs: 0,
    stageDurationMs: stageMs, durationMs: Math.max(10_000, stages * stageMs) };
}

const mean = (values: number[]) => values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
const quantile = (values: number[], q: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
};
const known = (values: (number | null | undefined)[]) => values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);

/** Rows from samples alone (live view): a step's throughput spans its first start to its last finish. */
export function concurrencyLadderRowsFromSamples(samples: BenchmarkSuiteSample[]): ConcurrencyLadderRow[] {
  const byStage = new Map<number, BenchmarkSuiteSample[]>();
  for (const sample of samples) if (!sample.warmup && sample.stage > 0) byStage.set(sample.stage, [...byStage.get(sample.stage) ?? [], sample]);
  return [...byStage.entries()].sort(([a], [b]) => a - b).map(([, group]) => {
    const done = group.filter(s => s.state === 'completed');
    const start = Math.min(...group.map(s => s.startedAt)), end = Math.max(...done.map(s => s.startedAt + s.wallMs));
    const tokens = known(done.map(s => s.completionTokens));
    return { concurrency: group[0]!.concurrency, completed: done.length, failed: group.filter(s => s.state === 'failed').length,
      totalTokS: done.length && tokens.length === done.length && end > start ? tokens.reduce((a, b) => a + b, 0) * 1000 / (end - start) : null,
      perRequestTokS: mean(known(done.map(s => s.decodeTokS))), ttftP50Ms: quantile(known(done.map(s => s.ttftMs)), 0.5), ttftP95Ms: quantile(known(done.map(s => s.ttftMs)), 0.95) };
  });
}

/** Rows of a finished ladder, each step measured over its own stage window. */
export function concurrencyLadderRows(report: BenchmarkSuiteReport): ConcurrencyLadderRow[] {
  return report.stages.map(stage => {
    const summary = summarizeBenchmarkSuite(report, { stage: stage.index });
    return { concurrency: stage.concurrency, completed: summary.completed, failed: summary.failed, totalTokS: summary.aggregateOutputTokS,
      perRequestTokS: summary.decodeTokS, ttftP50Ms: summary.ttftMs.p50, ttftP95Ms: summary.ttftMs.p95 };
  }).filter(row => row.completed + row.failed > 0);
}

/** One-line verdict: where total throughput peaks and what a single request pays for it. */
export function concurrencyLadderConclusion(rows: ConcurrencyLadderRow[]): ConcurrencyLadderConclusion {
  const measured = rows.filter(row => row.totalTokS !== null);
  if (!measured.length) return { code: 'ladder_empty', best: 1, values: {} };
  const solo = measured.find(row => row.concurrency === 1) ?? measured[0]!;
  const best = measured.reduce((a, b) => b.totalTokS! > a.totalTokS! ? b : a);
  const gain = best.totalTokS! / Math.max(solo.totalTokS!, 1e-9);
  const values = { best: best.concurrency, total: Math.round(best.totalTokS!), gain: Math.round(gain * 10) / 10, solo: Math.round(solo.totalTokS!),
    perRequest: Math.round(best.perRequestTokS ?? 0), drop: solo.perRequestTokS && best.perRequestTokS ? Math.round((1 - best.perRequestTokS / solo.perRequestTokS) * 100) : 0 };
  return best.concurrency > 1 && gain >= 1.1 ? { code: 'ladder_gain', best: best.concurrency, values } : { code: 'ladder_no_gain', best: 1, values };
}

const ladderMessages: Record<ConcurrencyLadderConclusion['code'], [string, string]> = {
  ladder_gain: ['{{best}} 个同时时总吞吐最高：{{total}} tok/s，是一次一个的 {{gain}} 倍；每个请求降到 {{perRequest}} tok/s（−{{drop}}%）。', 'Total throughput peaks at {{best}} at once: {{total}} tok/s, {{gain}}× one at a time; each request drops to {{perRequest}} tok/s (−{{drop}}%).'],
  ladder_no_gain: ['并发没有提高总吞吐（一次一个 {{solo}} tok/s），这台电脑建议一次一个。', 'Concurrency did not raise total throughput ({{solo}} tok/s one at a time); keep one at a time here.'],
  ladder_empty: ['没有完成的请求，无法得出结论。', 'No request completed, so there is no verdict.'],
};
export function concurrencyLadderMessage(conclusion: ConcurrencyLadderConclusion, zh: boolean): string {
  return ladderMessages[conclusion.code][zh ? 0 : 1].replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(conclusion.values[key] ?? ''));
}
