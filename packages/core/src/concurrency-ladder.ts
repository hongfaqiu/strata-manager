import { DEFAULT_BENCHMARK_SUITE_OPTIONS, summarizeBenchmarkSuite } from './benchmark-suite';
import type { BenchmarkSuiteOptions, BenchmarkSuiteReport, BenchmarkSuiteSample } from './benchmark-suite-types';
import { applyStartupField, STARTUP_TUNING_FIELDS } from './config-tuning';
import { CONCURRENCY_ENGINE_MAX, type ConcurrencyChange, type ConcurrencyPlan, type ConcurrencySettings } from './concurrency';
import type { JsonObject } from './types';

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

/** A configuration version to compare: the slot count plus the companions the recommendation writes. */
export interface ConcurrencyCandidate { id: string; parallel: number; experimental: boolean; edits: ConcurrencyChange[] }
/** One at a time, the recommendation and one more slot (capped at the engine's 8), optionally the recommendation with the experimental launch switches. */
export function concurrencyComparisonCandidates(settings: ConcurrencySettings, plan: ConcurrencyPlan, options: { experimental?: boolean } = {}): ConcurrencyCandidate[] {
  const recommended = Math.max(2, plan.officialParallel, plan.parallel);
  const counts = [...new Set([1, recommended, Math.min(CONCURRENCY_ENGINE_MAX, recommended + 1)])];
  const companions = plan.companions.map(({ key, value }) => ({ key, value }));
  const editsFor = (parallel: number): ConcurrencyChange[] => {
    const edits: ConcurrencyChange[] = [{ key: 'parallel', value: parallel > 1 ? String(parallel) : '' }];
    if (settings.batchArg !== null || settings.slotsArg !== null) edits.push({ key: '--batch', value: '' });
    if (parallel > 1) edits.push(...companions);
    else if (settings.batchMtp) edits.push({ key: '--batch-mtp', value: '' });
    return edits;
  };
  const list: ConcurrencyCandidate[] = counts.map(parallel => ({ id: `p${parallel}`, parallel, experimental: false, edits: editsFor(parallel) }));
  if (options.experimental) list.push({ id: `p${recommended}-exp`, parallel: recommended, experimental: true, edits: [...editsFor(recommended), { key: 'env.STRATA_BATCH_ATTN_ROWS', value: '1' }, { key: 'env.STRATA_BATCH_GDN_GROUPS', value: '1' }] });
  return list;
}
export function applyConcurrencyEdits(config: JsonObject, edits: ConcurrencyChange[]): JsonObject {
  return edits.reduce((next, edit) => {
    const field = STARTUP_TUNING_FIELDS.find(item => item.key === edit.key);
    return field ? applyStartupField(next, field, edit.value) : next;
  }, config);
}
/** "<base>-parallel-4-20261017-1104.json"; "-exp" marks the experimental switches. */
export function concurrencyVersionName(configPath: string, candidate: Pick<ConcurrencyCandidate, 'parallel' | 'experimental'>, at: Date): string {
  const base = configPath.split(/[\\/]/).at(-1)?.replace(/\.json$/i, '').replace(/-parallel-\d+(?:-exp)?-\d{8}-\d{4}$/, '') || 'configuration';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${base}-parallel-${candidate.parallel}${candidate.experimental ? '-exp' : ''}-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}.json`;
}
/** A candidate's headline numbers from its ladder: peak total, one request alone, and TTFT P95 at the top step. */
export interface ConcurrencyCandidateResult { id: string; peakTotalTokS: number | null; soloTokS: number | null; topTtftP95Ms: number | null; rows: ConcurrencyLadderRow[]; error?: string }
export function concurrencyCandidateResult(id: string, rows: ConcurrencyLadderRow[], error?: string): ConcurrencyCandidateResult {
  const totals = rows.map(row => row.totalTokS).filter((v): v is number => v !== null);
  return { id, rows, peakTotalTokS: totals.length ? Math.max(...totals) : null, soloTokS: rows.find(row => row.concurrency === 1)?.perRequestTokS ?? null, topTtftP95Ms: rows.at(-1)?.ttftP95Ms ?? null, ...(error ? { error } : {}) };
}
