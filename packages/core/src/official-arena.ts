// Benchmark Arena upload of an official-method run (tools/strata_bench.py as run in the app).
// Same whitelist rules as arena.ts: summary medians, hardware tiers and launch parameters; never prompts, outputs or paths.
import { ARENA_EVIDENCE_MAX_RUNS, ARENA_OFFICIAL_METRICS, arenaBase, type ArenaBuild, type ArenaEnvironment, type ArenaEvidence, type ArenaEvidenceRun, type ArenaOfficial } from './arena';
import { OFFICIAL_BENCH_SCRIPT, officialSummary, type OfficialBenchReport, type OfficialRequestDigest } from './official-bench';

/**
 * Evidence `ctx` slot per part of the script, so the server can match each request to the figure it backs.
 * Prompt tiers use their target size; chat and agent turns use codes outside the tiers' range of use.
 */
export const OFFICIAL_EVIDENCE_SLOTS = { chat: 512, '4K': 4096, '16K': 16384, '32K': 32768, agent: 65536 } as const;

const round = (v: number | null | undefined, d: number) => v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** One evidence run per successful measured request: the timings the published figures are medians of. */
export function officialArenaEvidence(report: OfficialBenchReport, engine: string | null): ArenaEvidence | null {
  if (!report.evidence) return null;
  const r = report.results, runs: ArenaEvidenceRun[] = [];
  const add = (slot: number, d: OfficialRequestDigest) => {
    if (!d.ok || !isNum(d.at) || !isNum(d.ttftS) || !isNum(d.promptTps) || !isNum(d.decodeTps) || !isNum(d.promptTokens) || !(d.generatedTokens > 0)) return;
    const startMs = Math.max(0, Math.round(d.at));
    runs.push({ ctx: slot, startMs, endMs: startMs + Math.round(d.totalS * 1000), ttftMs: Math.round(d.ttftS * 1000), promptTokens: d.promptTokens, cachedTokens: d.reusedTokens ?? null,
      completionTokens: d.generatedTokens, prefill: round(d.promptTps, 1)!, decode: round(d.decodeTps, 2)!, resourceSamples: 0 });
  };
  for (const d of r.chat?.requests ?? []) add(OFFICIAL_EVIDENCE_SLOTS.chat, d);
  for (const label of ['4K', '16K', '32K'] as const) for (const d of r.prompts[label]?.requests ?? []) add(OFFICIAL_EVIDENCE_SLOTS[label], d);
  for (const session of r.agent?.sessions ?? []) for (const d of session) if (d.turn > 0) add(OFFICIAL_EVIDENCE_SLOTS.agent, d);
  // Every figure has to be backed by all of its requests; a partial trace would not reproduce the medians.
  if (!runs.length || runs.length > ARENA_EVIDENCE_MAX_RUNS) return null;
  runs.sort((a, b) => a.startMs - b.startMs);
  const durationMs = Math.max(Math.round(report.elapsedMs), runs[runs.length - 1]!.endMs);
  // The script does not sample resources, so the run carries no series (count 0), only its length.
  const stepMs = Math.max(1000, Math.ceil(durationMs / 120 / 1000) * 1000), length = Math.max(1, Math.ceil(durationMs / stepMs));
  const empty = () => Array<number | null>(length).fill(null);
  const c = report.evidence.counters;
  return { v: 1, engine, durationMs, intervalMs: 1000, runs, series: { count: 0, stepMs, vramGB: empty(), ramGB: empty(), gpuUtil: empty() },
    counters: c ? { before: { ...c.before }, after: { ...c.after } } : null };
}

/** The summary the leaderboard ranks: medians exactly as the run's own table shows them. */
export function officialArenaBlock(report: OfficialBenchReport): ArenaOfficial {
  const summary = officialSummary(report.results);
  const metrics = Object.fromEntries(ARENA_OFFICIAL_METRICS.map(k => [k, summary[k]?.median ?? null])) as ArenaOfficial['metrics'];
  return { upstream: OFFICIAL_BENCH_SCRIPT.upstreamCommit.slice(0, 12), runs: report.options.runs, long: report.options.long, metrics };
}

/** Builds the upload for a finished official-method run; a run without a chat result is skipped rather than guessed. */
export async function buildOfficialArenaPayload(report: OfficialBenchReport, env: ArenaEnvironment): Promise<ArenaBuild> {
  if (report.state !== 'completed') return { skip: 'not_completed' };
  const identity = report.identity;
  const built = await arenaBase(identity, identity?.launch ?? identity?.officialLaunch, env, { engine: report.engineVersion, finishedAt: report.finishedAt });
  if ('skip' in built) return built;
  const official = officialArenaBlock(report);
  if (official.metrics.chatDecodeTps === null || official.metrics.chatTtftS === null) return { skip: 'no_results' };
  const evidence = officialArenaEvidence(report, built.engineVersion);
  return { payload: { ...built.base, kind: 'official', official, ...(evidence ? { evidence } : {}) } };
}
