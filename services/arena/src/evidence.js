// Run evidence: a compact, content-free trace of the in-app benchmark run that produced a submission.
// It is signed by the install key separately from the request, stored with the submission, and checked for
// internal consistency. A submission whose evidence passes is "verified" and counts immediately; missing or
// inconsistent evidence leaves it pending. No prompts, outputs, paths or hosts can fit the schema.
import { bad, keys, int, num, str } from './schema.js';

export const EVIDENCE_VERSION = 1;
export const MAX_EVIDENCE_BYTES = 16 * 1024;
export const MAX_RUNS = 48;
export const MAX_POINTS = 121;
/** Message the install key signs over the exact evidence text. */
export const evidenceMessage = (keyId, digest) => `strata-arena-evidence|v${EVIDENCE_VERSION}|${keyId}|${digest}`;

const series = (v, where, max) => {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_POINTS) bad('invalid_' + where);
  return v.map((x, i) => num(x, 0, max, `${where}[${i}]`));
};
const counters = (c, where) => {
  keys(c, ['requests', 'promptTokens', 'outputTokens'], where);
  return { requests: int(c.requests, 0, Number.MAX_SAFE_INTEGER, where + '.requests'), promptTokens: int(c.promptTokens, 0, Number.MAX_SAFE_INTEGER, where + '.promptTokens'),
    outputTokens: int(c.outputTokens, 0, Number.MAX_SAFE_INTEGER, where + '.outputTokens') };
};

/** Strict shape validation. Unknown keys are rejected (400) exactly like the main schema. */
export function parseEvidence(text) {
  if (typeof text !== 'string' || text.length > MAX_EVIDENCE_BYTES) bad('invalid_evidence');
  let ev; try { ev = JSON.parse(text); } catch { bad('invalid_evidence'); }
  keys(ev, ['v', 'engine', 'durationMs', 'intervalMs', 'runs', 'series', 'counters'], 'evidence');
  if (ev.v !== EVIDENCE_VERSION) bad('unsupported_evidence');
  const out = { engine: str(ev.engine, /^\d{1,3}\.\d{1,3}\.\d{1,4}(?:\.\d{1,4})?$/, 'evidence.engine', true), durationMs: int(ev.durationMs, 1, 6 * 3_600_000, 'evidence.durationMs'),
    intervalMs: int(ev.intervalMs, 100, 60_000, 'evidence.intervalMs') };
  if (!Array.isArray(ev.runs) || ev.runs.length > MAX_RUNS) bad('invalid_evidence.runs');
  out.runs = ev.runs.map((r, i) => {
    const w = `evidence.runs[${i}]`;
    keys(r, ['ctx', 'startMs', 'endMs', 'ttftMs', 'promptTokens', 'cachedTokens', 'completionTokens', 'prefill', 'decode', 'resourceSamples'], w);
    return { ctx: int(r.ctx, 256, 1_048_576, w + '.ctx'), startMs: int(r.startMs, 0, 6 * 3_600_000, w + '.startMs'), endMs: int(r.endMs, 0, 6 * 3_600_000, w + '.endMs'),
      ttftMs: num(r.ttftMs, 0, 7_200_000, w + '.ttftMs', false), promptTokens: int(r.promptTokens, 1, 1_048_576, w + '.promptTokens'),
      cachedTokens: int(r.cachedTokens, 0, 1_048_576, w + '.cachedTokens', true), completionTokens: int(r.completionTokens, 0, 1_048_576, w + '.completionTokens'),
      prefill: num(r.prefill, 0.5, 200000, w + '.prefill', false), decode: num(r.decode, 0.05, 1000, w + '.decode', false), resourceSamples: int(r.resourceSamples, 0, 100000, w + '.resourceSamples') };
  });
  keys(ev.series, ['count', 'stepMs', 'vramGB', 'ramGB', 'gpuUtil'], 'evidence.series');
  const sr = ev.series;
  out.series = { count: int(sr.count, 0, 1_000_000, 'evidence.series.count'), stepMs: int(sr.stepMs, 100, 3_600_000, 'evidence.series.stepMs'),
    vramGB: series(sr.vramGB, 'evidence.series.vramGB', 8192), ramGB: series(sr.ramGB, 'evidence.series.ramGB', 8192), gpuUtil: series(sr.gpuUtil, 'evidence.series.gpuUtil', 100) };
  if (out.series.vramGB.length !== out.series.ramGB.length || out.series.ramGB.length !== out.series.gpuUtil.length) bad('invalid_evidence.series');
  if (ev.counters === null || ev.counters === undefined) out.counters = null;
  else { keys(ev.counters, ['before', 'after'], 'evidence.counters'); out.counters = { before: counters(ev.counters.before, 'evidence.counters.before'), after: counters(ev.counters.after, 'evidence.counters.after') }; }
  return out;
}

const median = values => { const s = values.filter(v => v !== null && Number.isFinite(v)).sort((a, b) => a - b); if (!s.length) return null; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const close = (a, b, rel, abs) => a !== null && b !== null && Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));
const maxOf = list => { const v = list.filter(x => x !== null); return v.length ? Math.max(...v) : null; };

/**
 * Internal-consistency checks of a validated context submission `s` against its evidence `ev`.
 * Returns { status: 'verified' | 'failed', reasons: string[] }. Each reason names the first failing check.
 */
export function checkEvidence(s, ev) {
  const reasons = [];
  const fail = r => { if (!reasons.includes(r)) reasons.push(r); };
  if (s.kind !== 'context') return { status: 'failed', reasons: ['scenario_unverifiable'] };
  // Engine version reported by the run must match the submission.
  if (ev.engine && s.strata && ev.engine !== s.strata) fail('engine_mismatch');
  // Runs: completed requests, in order, non-overlapping, inside the run duration.
  const runs = ev.runs;
  if (!runs.length) fail('no_runs');
  let lastEnd = -1;
  for (const r of runs) {
    if (r.endMs <= r.startMs) fail('timestamps');
    if (r.startMs < lastEnd - 100) fail('timestamps_overlap');
    lastEnd = Math.max(lastEnd, r.endMs);
    if (r.endMs > ev.durationMs + 2000) fail('run_outside_duration');
    // Tokens: the prompt fits the tier, cached tokens cannot exceed the prompt, something was generated.
    if (r.promptTokens > r.ctx || r.promptTokens < r.ctx * 0.3) fail('prompt_tokens_vs_tier');
    if (r.cachedTokens !== null && r.cachedTokens > r.promptTokens) fail('cached_tokens');
    if (r.completionTokens < 1 || r.completionTokens > r.ctx) fail('completion_tokens');
    // First token after the uncached prompt was processed at the reported prefill speed.
    const prefillMs = (r.promptTokens - (r.cachedTokens ?? 0)) / r.prefill * 1000;
    if (r.ttftMs < prefillMs * 0.6 || r.ttftMs > prefillMs * 4 + 5000) fail('ttft_vs_prefill');
    // Request wall time = first token + generated tokens at the reported decode speed.
    const expected = r.ttftMs + Math.max(0, r.completionTokens - 1) / r.decode * 1000, wall = r.endMs - r.startMs;
    if (wall < expected * 0.7 - 500 || wall > expected * 2 + 10_000) fail('wall_vs_decode');
  }
  // Reported tiers are exactly the medians of the evidenced runs.
  for (const t of s.tiers.filter(t => t.ok)) {
    const mine = runs.filter(r => r.ctx === t.ctx);
    if (!mine.length) { fail('tier_without_runs'); continue; }
    if (!close(t.decode, median(mine.map(r => r.decode)), 0.01, 0.05)) fail('tier_decode_mismatch');
    if (!close(t.prefill, median(mine.map(r => r.prefill)), 0.01, 0.5)) fail('tier_prefill_mismatch');
    if (!close(t.ttftMs, median(mine.map(r => r.ttftMs)), 0.01, 2)) fail('tier_ttft_mismatch');
  }
  for (const r of runs) if (!s.tiers.some(t => t.ok && t.ctx === r.ctx)) fail('run_without_tier');
  // Resource sampling: the number of samples fits the duration and the requests that were measured.
  const sr = ev.series;
  if (sr.stepMs < ev.intervalMs) fail('series_step');
  const expectedPoints = Math.max(1, Math.ceil(ev.durationMs / sr.stepMs));
  if (Math.abs(sr.vramGB.length - expectedPoints) > 1) fail('series_length');
  const sampled = runs.reduce((n, r) => n + r.resourceSamples, 0), busyMs = runs.reduce((n, r) => n + (r.endMs - r.startMs), 0);
  if (sr.count < sampled) fail('sample_count_below_runs');
  if (sr.count > Math.ceil(ev.durationMs / ev.intervalMs) + 3 * runs.length + 20) fail('sample_count_vs_duration');
  if (busyMs >= 10_000 && sampled < 0.3 * busyMs / ev.intervalMs) fail('too_few_samples');
  // Peaks in the series match the reported tier peaks and fit the hardware.
  const seriesVram = maxOf(sr.vramGB), seriesRam = maxOf(sr.ramGB);
  const tierVram = maxOf(s.tiers.map(t => t.peakVramGB)), tierRam = maxOf(s.tiers.map(t => t.peakRamGB));
  if (tierVram !== null && !close(seriesVram, tierVram, 0.05, 0.5)) fail('vram_peak_mismatch');
  if (tierRam !== null && !close(seriesRam, tierRam, 0.05, 0.5)) fail('ram_peak_mismatch');
  if (seriesVram !== null && seriesVram > s.hw.vramTotal * 1.02 + 0.5) fail('vram_exceeds_gpu');
  if (seriesRam !== null && seriesRam > s.hw.ramGB * 1.08 + 1) fail('ram_exceeds_host');
  // Engine counters moved at least by what the runs report. The upper bounds are loose on purpose: token counting
  // calls, failed attempts and the odd request from another client in between also move the counters.
  if (!ev.counters) fail('no_counters');
  else {
    const d = k => ev.counters.after[k] - ev.counters.before[k];
    if (d('requests') < 0 || d('promptTokens') < 0 || d('outputTokens') < 0) fail('counters_went_backwards');
    const prompt = runs.reduce((n, r) => n + r.promptTokens, 0), uncached = runs.reduce((n, r) => n + r.promptTokens - (r.cachedTokens ?? 0), 0), out = runs.reduce((n, r) => n + r.completionTokens, 0);
    if (d('requests') < runs.length || d('requests') > runs.length * 8 + 10) fail('request_count_delta');
    if (d('promptTokens') < uncached * 0.9 || d('promptTokens') > prompt * 8 + 4000) fail('prompt_token_delta');
    if (d('outputTokens') < out * 0.9 || d('outputTokens') > out * 4 + 2000) fail('output_token_delta');
  }
  return reasons.length ? { status: 'failed', reasons } : { status: 'verified', reasons: [] };
}

// ---------- official-method runs (tools/strata_bench.py as run in the app) ----------
/** Evidence `ctx` slot per part of the script (packages/core/src/official-arena.ts OFFICIAL_EVIDENCE_SLOTS). */
export const OFFICIAL_SLOTS = Object.freeze({ chat: 512, p4k: 4096, p16k: 16384, p32k: 32768, agent: 65536 });
// [slot, speed metric (median of), first-token metric, prompt-token bounds, max completion tokens]
const OFFICIAL_PARTS = [
  ['chat', 'chatDecodeTps', 'chatTtftS', [1, 512], 100, 'decode'],
  ['p4k', 'p4kTps', 'p4kTtftS', [4096 * 0.5, 4096 * 1.15], 24, 'prefill'],
  ['p16k', 'p16kTps', 'p16kTtftS', [16384 * 0.5, 16384 * 1.15], 24, 'prefill'],
  ['p32k', 'p32kTps', 'p32kTtftS', [32768 * 0.5, 32768 * 1.15], 24, 'prefill'],
  ['agent', 'agentDecodeTps', 'agentTurnTtftS', [256, 65536], 64, 'decode'],
];

/**
 * Internal-consistency checks of a validated official submission against its evidence: one run per measured request
 * (chat prompts, prompt tiers, agent follow-up turns), whose medians must reproduce the reported figures.
 * The script samples no resources, so the series must be empty (count 0); everything else is checked as for context runs.
 */
export function checkOfficialEvidence(s, ev) {
  const reasons = [];
  const fail = r => { if (!reasons.includes(r)) reasons.push(r); };
  if (s.kind !== 'official') return { status: 'failed', reasons: ['not_official'] };
  if (ev.engine && s.strata && ev.engine !== s.strata) fail('engine_mismatch');
  const runs = ev.runs, m = s.official.metrics;
  if (!runs.length) fail('no_runs');
  const slots = new Map(OFFICIAL_PARTS.map(p => [OFFICIAL_SLOTS[p[0]], p]));
  let lastEnd = -1;
  for (const r of runs) {
    const part = slots.get(r.ctx);
    if (!part) { fail('unknown_slot'); continue; }
    const [, , , [lo, hi], maxOut] = part;
    if (r.endMs <= r.startMs) fail('timestamps');
    if (r.startMs < lastEnd - 100) fail('timestamps_overlap');
    lastEnd = Math.max(lastEnd, r.endMs);
    if (r.endMs > ev.durationMs + 2000) fail('run_outside_duration');
    if (r.promptTokens < lo || r.promptTokens > hi) fail('prompt_tokens_vs_tier');
    if (r.promptTokens > s.params.ctx) fail('prompt_exceeds_context');
    if (r.cachedTokens !== null && r.cachedTokens > r.promptTokens) fail('cached_tokens');
    if (r.completionTokens < 1 || r.completionTokens > maxOut + 1) fail('completion_tokens');
    if (r.resourceSamples !== 0) fail('series_unexpected');
    const prefillMs = (r.promptTokens - (r.cachedTokens ?? 0)) / r.prefill * 1000;
    if (r.ttftMs < prefillMs * 0.6 - 50 || r.ttftMs > prefillMs * 4 + 5000) fail('ttft_vs_prefill');
    const expected = r.ttftMs + Math.max(0, r.completionTokens - 1) / r.decode * 1000, wall = r.endMs - r.startMs;
    if (wall < expected * 0.7 - 500 || wall > expected * 2 + 10_000) fail('wall_vs_decode');
  }
  // Every reported figure is the median of its evidenced requests, and every request backs a reported figure.
  for (const [slot, speed, ttft, , , field] of OFFICIAL_PARTS) {
    const mine = runs.filter(r => r.ctx === OFFICIAL_SLOTS[slot]);
    if (m[speed] === null) { if (mine.length) fail('run_without_tier'); continue; }
    if (!mine.length) { fail('tier_without_runs'); continue; }
    if (!close(m[speed], median(mine.map(r => r[field])), 0.01, field === 'decode' ? 0.05 : 0.5)) fail('tier_' + (field === 'decode' ? 'decode' : 'prefill') + '_mismatch');
    if (m[ttft] !== null && !close(m[ttft] * 1000, median(mine.map(r => r.ttftMs)), 0.01, 2)) fail('tier_ttft_mismatch');
  }
  if (m.agentHitPct !== null) {
    const agent = runs.filter(r => r.ctx === OFFICIAL_SLOTS.agent), prompt = agent.reduce((n, r) => n + r.promptTokens, 0);
    const hit = prompt ? agent.reduce((n, r) => n + (r.cachedTokens ?? 0), 0) / prompt * 100 : null;
    if (hit === null || Math.abs(hit - m.agentHitPct) > 10) fail('agent_hit_mismatch');
  }
  // No resource sampling in the script: an empty series of the right length.
  const sr = ev.series;
  if (sr.count !== 0 || [...sr.vramGB, ...sr.ramGB, ...sr.gpuUtil].some(v => v !== null)) fail('series_unexpected');
  if (sr.stepMs < ev.intervalMs) fail('series_step');
  if (Math.abs(sr.vramGB.length - Math.max(1, Math.ceil(ev.durationMs / sr.stepMs))) > 1) fail('series_length');
  // Engine counters: the warm-up, the agent's first turns and the calibration also move them, so the upper bounds stay loose.
  if (!ev.counters) fail('no_counters');
  else {
    const d = k => ev.counters.after[k] - ev.counters.before[k];
    if (d('requests') < 0 || d('promptTokens') < 0 || d('outputTokens') < 0) fail('counters_went_backwards');
    const prompt = runs.reduce((n, r) => n + r.promptTokens, 0), uncached = runs.reduce((n, r) => n + r.promptTokens - (r.cachedTokens ?? 0), 0), out = runs.reduce((n, r) => n + r.completionTokens, 0);
    if (d('requests') < runs.length || d('requests') > runs.length * 8 + 20) fail('request_count_delta');
    if (d('promptTokens') < uncached * 0.9 || d('promptTokens') > prompt * 8 + 40_000) fail('prompt_token_delta');
    if (d('outputTokens') < out * 0.9 || d('outputTokens') > out * 4 + 2000) fail('output_token_delta');
  }
  return reasons.length ? { status: 'failed', reasons } : { status: 'verified', reasons: [] };
}
