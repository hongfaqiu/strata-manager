/**
 * Official benchmark: the quick speed suite of upstream Strata's `tools/strata_bench.py`, reproduced request for
 * request so the numbers can sit beside the ones the Strata maintainers publish (official-bench-reference.json).
 *
 * Same as the script (v0.2.7.1, 46c152a1): the three short questions of `tools/ab_engine.py` (up to 100 new tokens),
 * fresh word-list prompts of about 4,096 / 16,384 (/ 32,768 with --long) tokens sized by a two-point calibration
 * (24 new tokens), the coding-agent session of five 1,500-word turns with the system prompt and four tools of
 * `tools/agent_turns_bench.py` (64 new tokens per turn), three runs each, medians with min/max, thinking off,
 * temperature 0. One warm-up chat, the calibration and a 1K prompt are discarded first. Speeds are the engine's
 * own timings (`prompt_per_second`, `predicted_per_second`); time to first token is measured by the client.
 * Differences: the agent turns use the script's generated filler (the Strata checkout's docs are not on this PC);
 * `--clients` is not offered; the report stays in the app instead of bench/results.
 */
import { benchmarkIdentity, isDesktop, normalizeBaseUrl, request, serviceStatus, streamChat } from './bridge';
import { acquireBenchmarkEndpoint } from './benchmark';
import type { BenchmarkIdentity } from './benchmark-comparison';
import { benchmarkCounters } from './context-benchmark';
import type { ContextBenchmarkCounters } from './context-benchmark-types';
import { asObject, normalizeError, StrataError } from './errors';
import type { JsonObject, ServiceProfile } from './types';
import script from './official-bench-script.json';

export const OFFICIAL_BENCH_SCRIPT = { tool: 'tools/strata_bench.py', upstreamCommit: script.upstreamCommit, schema: 1 } as const;
export const OFFICIAL_BENCH_PROMPTS: readonly string[] = script.prompts;
export const OFFICIAL_BENCH_SYSTEM: string = script.system;
export const OFFICIAL_BENCH_TOOLS: JsonObject[] = script.tools as JsonObject[];
export const OFFICIAL_CHAT_MAX_TOKENS = 100;
export const OFFICIAL_LONG_MAX_TOKENS = 24;
export const OFFICIAL_AGENT_MAX_TOKENS = 64;
export const OFFICIAL_AGENT_TURNS = 5;
export const OFFICIAL_AGENT_WORDS = 1500;
export const OFFICIAL_AGENT_MIN_CONTEXT = 10240;
export const OFFICIAL_PROMPT_TIERS = [{ label: '4K', tokens: 4096 }, { label: '16K', tokens: 16384 }] as const;
export const OFFICIAL_LONG_TIER = { label: '32K', tokens: 32768 } as const;
export type OfficialPromptLabel = '4K' | '16K' | '32K';

// ------------------------------------------------------------------------------------------- prompt generation
/** CPython's Mersenne Twister (random.Random(seed) for a small non-negative int seed), enough for `choice`. */
export class PythonRandom {
  private mt = new Uint32Array(624);
  private index = 624;
  constructor(seed: number) {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('seed must be a 32-bit non-negative integer');
    this.initByArray([seed >>> 0]);
  }
  private initGenrand(s: number) {
    const mt = this.mt; mt[0] = s >>> 0;
    for (let i = 1; i < 624; i++) { const prev = mt[i - 1]! ^ (mt[i - 1]! >>> 30); mt[i] = (Math.imul(1812433253, prev) + i) >>> 0; }
    this.index = 624;
  }
  private initByArray(key: number[]) {
    this.initGenrand(19650218);
    const mt = this.mt; let i = 1, j = 0;
    for (let k = Math.max(624, key.length); k; k--) {
      const prev = mt[i - 1]! ^ (mt[i - 1]! >>> 30);
      mt[i] = ((mt[i]! ^ Math.imul(prev, 1664525)) + key[j]! + j) >>> 0;
      i++; j++;
      if (i >= 624) { mt[0] = mt[623]!; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (let k = 623; k; k--) {
      const prev = mt[i - 1]! ^ (mt[i - 1]! >>> 30);
      mt[i] = ((mt[i]! ^ Math.imul(prev, 1566083941)) - i) >>> 0;
      i++;
      if (i >= 624) { mt[0] = mt[623]!; i = 1; }
    }
    mt[0] = 0x80000000;
  }
  /** genrand_uint32 */
  next32(): number {
    const mt = this.mt;
    if (this.index >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (mt[k]! & 0x80000000) | (mt[(k + 1) % 624]! & 0x7fffffff);
        mt[k] = (mt[(k + 397) % 624]! ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0)) >>> 0;
      }
      this.index = 0;
    }
    let y = mt[this.index++]!;
    y ^= y >>> 11; y ^= (y << 7) & 0x9d2c5680; y ^= (y << 15) & 0xefc60000; y ^= y >>> 18;
    return y >>> 0;
  }
  /** getrandbits(k) for 0 < k <= 32 */
  getrandbits(k: number): number { return k >= 32 ? this.next32() : this.next32() >>> (32 - k); }
  /** _randbelow_with_getrandbits: rejection sampling on bit_length(n) bits, as random.choice uses it. */
  randbelow(n: number): number {
    const k = Math.floor(Math.log2(n)) + 1;
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }
  choice<T>(items: readonly T[]): T { return items[this.randbelow(items.length)]!; }
}

/** `long_prompt(words)` of tools/ab_engine.py, byte for byte. */
export function officialLongPrompt(words: number): string {
  const rng = new PythonRandom(7), vocab = script.vocab, body: string[] = [];
  for (let i = 0; i < words; i++) body.push(rng.choice(vocab));
  return `Here is a list of words:\n${body.join(' ')}\n\nSummarize what kinds of words appear in the list, in five sentences.`;
}

/** Suite.calibrate: tokens per word as the slope of a 200- and an 800-word prompt; the template's fixed part apart. */
export function officialCalibration(tokens200: number | null | undefined, tokens800: number | null | undefined): { tokensPerWord: number; overhead: number } {
  const ok = typeof tokens200 === 'number' && tokens200 > 0 && typeof tokens800 === 'number' && tokens800 > 0;
  const slope = ok && tokens800! > tokens200! ? (tokens800! - tokens200!) / 600 : null;
  if (!slope) return { tokensPerWord: 1.1, overhead: 40 };
  return { tokensPerWord: slope, overhead: Math.max(0, tokens200! - 200 * slope) };
}

/** Suite.prompt_for: the word count that gives a prompt of about `tokens` tokens. */
export function officialPromptWords(tokens: number, calibration: { tokensPerWord: number; overhead: number }): number {
  return Math.max(50, Math.trunc((tokens - calibration.overhead) / calibration.tokensPerWord));
}

/** Suite.tag: parts joined by "-" with the run's nonce last. */
export const officialTag = (nonce: string, ...parts: (string | number)[]) => [...parts.map(String), nonce].join('-');

/** Suite.run_prompt's skip rule. */
export const officialPromptFits = (tokens: number, context: number | null) => !context || tokens + OFFICIAL_LONG_MAX_TOKENS + 256 <= context;
export const officialAgentFits = (context: number | null) => !context || context >= OFFICIAL_AGENT_MIN_CONTEXT;

// ------------------------------------------------------------------------------------------------- statistics
export interface OfficialStat { median: number; min: number; max: number; n: number }
const round = (value: number, digits: number) => { const f = 10 ** digits; return Math.round(value * f) / f; };
/** `stat()`: Python statistics.median (mean of the middle two for an even count), min, max, n; rounded to 3 places. */
export function officialStat(values: Iterable<number | null | undefined>): OfficialStat | null {
  const v = [...values].filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1, median = v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
  return { median: round(median, 3), min: round(v[0]!, 3), max: round(v[v.length - 1]!, 3), n: v.length };
}

// ------------------------------------------------------------------------------------------- one request digest
/** `at`: when the request was sent, in ms from the start of the run (for Arena run evidence; never a wall-clock time). */
export interface OfficialRawResponse { first: number | null; total: number; usage: JsonObject | null; timings: JsonObject | null; err: string | null; pieces: number; text?: string; at?: number }
export interface OfficialRequestDigest {
  ok: boolean; err: string | null; ttftS: number | null; totalS: number; promptTokens: number | null; reusedTokens: number | null; readTokens: number | null;
  generatedTokens: number; promptTps: number | null; promptTpsSource: 'engine' | null; decodeTps: number | null; decodeTpsSource: 'engine' | 'client' | null;
  promptMs: number | null; decodeMs: number | null; draftsOffered: number | null; draftsAccepted: number | null;
  at?: number;
}
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
/** `digest()`: the engine's own speeds; a client decode estimate only when the engine reported none. */
export function officialDigest(r: OfficialRawResponse): OfficialRequestDigest {
  const u = r.usage ?? {}, t = r.timings ?? {};
  const gen = num(u.completion_tokens) || r.pieces || 0;
  const promptTokens = num(u.prompt_tokens);
  let cached = num(asObject(u.prompt_tokens_details).cached_tokens);
  if (cached === null) cached = num(t.cache_n);
  let read = num(t.prompt_n);
  if (read === null && promptTokens !== null && cached !== null) read = promptTokens - cached;
  let decode = num(t.predicted_per_second), source: OfficialRequestDigest['decodeTpsSource'] = decode === null ? null : 'engine';
  if (decode === null && r.first !== null && gen > 1 && r.total > r.first) { decode = round((gen - 1) / (r.total - r.first), 1); source = 'client'; }
  return { ok: r.err === null && r.first !== null, err: r.err, ttftS: r.first === null ? null : round(r.first, 3), totalS: round(r.total, 3),
    promptTokens, reusedTokens: cached, readTokens: read, generatedTokens: gen, promptTps: num(t.prompt_per_second), promptTpsSource: num(t.prompt_per_second) === null ? null : 'engine',
    decodeTps: decode, decodeTpsSource: source, promptMs: num(t.prompt_ms), decodeMs: num(t.predicted_ms), draftsOffered: num(t.draft_n), draftsAccepted: num(t.draft_n_accepted), ...(typeof r.at === 'number' ? { at: r.at } : {}) };
}

// ------------------------------------------------------------------------------------------------ agent figures
export interface OfficialAgentTurn extends OfficialRequestDigest { run: number; turn: number }
export interface OfficialAgentResult {
  hitPct: OfficialStat | null; rereadTokens: OfficialStat | null; newTokens: OfficialStat | null; turnTtftS: OfficialStat | null;
  lastTurnPromptTokens: OfficialStat | null; turnDecodeTps: OfficialStat | null; firstTurnTtftS: OfficialStat | null; sessions: OfficialAgentTurn[][];
}
/** Suite.run_agent's summary of the sessions. */
export function officialAgentSummary(sessions: OfficialAgentTurn[][]): OfficialAgentResult {
  const follow = sessions.map(s => s.filter(d => d.ok && d.turn > 0));
  const hit = follow.filter(s => s.length).map(s => s.reduce((a, d) => a + (d.reusedTokens ?? 0), 0) / Math.max(1, s.reduce((a, d) => a + (d.promptTokens ?? 0), 0)) * 100);
  const reread: number[] = [], fresh: number[] = [];
  for (const session of sessions) {
    const s = session.filter(d => d.ok);
    let again = 0;
    for (let i = 1; i < s.length; i++) again += Math.max(0, (s[i - 1]!.promptTokens ?? 0) + (s[i - 1]!.generatedTokens ?? 0) - (s[i]!.reusedTokens ?? 0));
    reread.push(again);
    fresh.push(s.slice(1).reduce((a, d) => a + (d.readTokens ?? 0), 0) - again);
  }
  return { sessions, hitPct: officialStat(hit), rereadTokens: officialStat(reread), newTokens: officialStat(fresh),
    turnTtftS: officialStat(follow.flat().map(d => d.ttftS)), lastTurnPromptTokens: officialStat(follow.filter(s => s.length).map(s => s[s.length - 1]!.promptTokens)),
    turnDecodeTps: officialStat(follow.flat().map(d => d.decodeTps)), firstTurnTtftS: officialStat(sessions.filter(s => s[0]?.ok).map(s => s[0]!.ttftS)) };
}

// ------------------------------------------------------------------------------------------------------ report
export interface OfficialBenchOptions { runs: number; long: boolean; agent: boolean; timeoutMs: number }
/** The parameters of the published numbers: `python tools/strata_bench.py --runs 3 --long` (docs/STRIX_HALO_WINDOWS.md §6). */
export const DEFAULT_OFFICIAL_BENCH_OPTIONS: OfficialBenchOptions = { runs: 3, long: true, agent: true, timeoutMs: 3_600_000 };
export interface OfficialChatRow extends OfficialRequestDigest { run: number; prompt: number }
export interface OfficialPromptRow extends OfficialRequestDigest { run: number }
export interface OfficialPromptResult { targetTokens: number; requests: OfficialPromptRow[]; promptTps: OfficialStat | null; ttftS: OfficialStat | null; promptTokens: OfficialStat | null; reusedTokens: OfficialStat | null }
export interface OfficialChatResult { requests: OfficialChatRow[]; decodeTps: OfficialStat | null; ttftS: OfficialStat | null; generatedTokens: OfficialStat | null; promptTokens: OfficialStat | null }
export interface OfficialBenchResults {
  chat: OfficialChatResult | null; prompts: Partial<Record<OfficialPromptLabel, OfficialPromptResult>>; agent: OfficialAgentResult | null;
  skipped: Record<string, string>; failures: { where: string; error: string }[];
}
export interface OfficialBenchMachine { gpuNames: string[]; vramGB: number | null; cpuName: string | null; modelEvidence: string[] }
export interface OfficialBenchReport {
  schemaVersion: 1; kind: 'official-bench'; script: typeof OFFICIAL_BENCH_SCRIPT; id: string; profileId: string; profileName: string; baseUrl: string;
  model: string; maxContext: number | null; startedAt: number; finishedAt: number; elapsedMs: number; options: OfficialBenchOptions;
  state: 'completed' | 'failed' | 'cancelled'; calibration: { tokensPerWord: number; overhead: number }; results: OfficialBenchResults;
  machine: OfficialBenchMachine; identity?: BenchmarkIdentity; engineVersion?: string | null;
  /** Engine counters before the first and after the last request (Arena run evidence); null when the engine reports no totals. */
  evidence?: { counters: { before: ContextBenchmarkCounters; after: ContextBenchmarkCounters } | null };
}
export type OfficialBenchPhase = 'warmup' | 'chat' | OfficialPromptLabel | 'agent' | 'done';
export interface OfficialBenchProgress { phase: OfficialBenchPhase; done: number; total: number; phases: OfficialBenchPhase[]; last?: OfficialRequestDigest }

export function validateOfficialBenchOptions(options: OfficialBenchOptions): void {
  const bad = (m: string) => { throw new StrataError('INVALID_BENCHMARK_OPTIONS', m); };
  if (!Number.isSafeInteger(options.runs) || options.runs < 1 || options.runs > 10) bad('每项轮数必须为 1–10 的整数');
  if (typeof options.long !== 'boolean' || typeof options.agent !== 'boolean') bad('选项必须为布尔值');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 3_600_000) bad('每个请求超时必须为 1–3600 秒');
}

/** The phases a run will go through and how many requests it sends, for the progress strip. */
export function planOfficialBench(options: OfficialBenchOptions, context: number | null) {
  const tiers = [...OFFICIAL_PROMPT_TIERS, ...(options.long ? [OFFICIAL_LONG_TIER] : [])];
  const prompts = tiers.filter(t => officialPromptFits(t.tokens, context)), skipped = tiers.filter(t => !officialPromptFits(t.tokens, context));
  const agent = options.agent && officialAgentFits(context);
  // The script runs 4K, 16K, the agent session, then 32K.
  const phases: OfficialBenchPhase[] = ['warmup', 'chat', ...prompts.filter(t => t.label !== '32K').map(t => t.label), ...(agent ? ['agent' as const] : []), ...prompts.filter(t => t.label === '32K').map(t => t.label)];
  const total = 4 + options.runs * OFFICIAL_BENCH_PROMPTS.length + prompts.length * options.runs + (agent ? options.runs * (OFFICIAL_AGENT_TURNS + 1) : 0);
  return { phases, total, prompts, skipped, agent };
}

/** Flat headline figures for the comparison view, the same rows as summary_metrics(). */
export type OfficialMetricKey = 'chatDecodeTps' | 'chatTtftS' | 'p4kTps' | 'p4kTtftS' | 'p16kTps' | 'p16kTtftS' | 'p32kTps' | 'p32kTtftS' | 'agentHitPct' | 'agentDecodeTps' | 'agentTurnTtftS';
export function officialSummary(results: OfficialBenchResults): Partial<Record<OfficialMetricKey, OfficialStat | null>> {
  const p = results.prompts;
  return { chatDecodeTps: results.chat?.decodeTps ?? null, chatTtftS: results.chat?.ttftS ?? null,
    p4kTps: p['4K']?.promptTps ?? null, p4kTtftS: p['4K']?.ttftS ?? null, p16kTps: p['16K']?.promptTps ?? null, p16kTtftS: p['16K']?.ttftS ?? null,
    p32kTps: p['32K']?.promptTps ?? null, p32kTtftS: p['32K']?.ttftS ?? null,
    agentHitPct: results.agent?.hitPct ?? null, agentDecodeTps: results.agent?.turnDecodeTps ?? null, agentTurnTtftS: results.agent?.turnTtftS ?? null };
}

// ------------------------------------------------------------------------------------------------------ runner
const clock = () => performance.now();
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** One streamed chat request as `chat()` of the script sends it. */
export function officialChatBody(messages: JsonObject[], maxTokens: number, tools?: JsonObject[]): JsonObject {
  return { model: 'strata', stream: true, max_tokens: maxTokens, temperature: 0, messages,
    ...(tools ? { tools } : {}), reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } };
}

async function officialChat(profile: ServiceProfile, messages: JsonObject[], maxTokens: number, timeoutMs: number, signal: AbortSignal, tools?: JsonObject[]): Promise<OfficialRawResponse> {
  const controller = new AbortController(), began = clock();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let first: number | null = null, usage: JsonObject | null = null, timings: JsonObject | null = null, err: string | null = null, pieces = 0, text = '';
  try {
    await streamChat(profile, officialChatBody(messages, maxTokens, tools), delta => {
      const piece = (delta.content ?? '') + (delta.reasoning ?? '');
      if (piece) { if (first === null) first = (clock() - began) / 1000; pieces++; text += delta.content ?? ''; }
      if (delta.usage) usage = delta.usage;
      if (delta.timings) timings = delta.timings;
      if (delta.error) err = String(delta.error).slice(0, 300);
    }, controller.signal);
  } catch (error) {
    err = signal.aborted ? '测试已取消' : controller.signal.aborted ? `请求超过 ${timeoutMs / 1000} 秒` : normalizeError(error).message.slice(0, 300);
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  return { first, total: (clock() - began) / 1000, usage, timings, err, pieces, text };
}

function machineOf(metrics: JsonObject, identity: BenchmarkIdentity | undefined, model: string): OfficialBenchMachine {
  const st = asObject(metrics.hardware_static);
  const sig = identity?.hardwareSignature;
  const fromSig = sig?.gpus.map(g => g.name).filter(Boolean) ?? [];
  const served = typeof st.gpu_name === 'string' ? st.gpu_name.split(' + ').map(s => s.trim()).filter(s => s && s !== '?') : [];
  const gpuNames = [...new Set([...served, ...fromSig])];
  const vram = sig?.gpus.length ? sig.gpus.reduce((a, g) => a + (g.totalBytes || 0), 0) / 2 ** 30 : null;
  const files = (identity?.model.files ?? []).flatMap(f => typeof f.name === 'string' ? [f.name.split(/[\\/]/).pop()!] : []);
  const args = [identity?.launch?.family, identity?.launch?.quant].filter((x): x is string => typeof x === 'string');
  return { gpuNames, vramGB: vram ? Math.round(vram) : null, cpuName: sig?.cpuName || (typeof st.cpu_name === 'string' ? st.cpu_name : null), modelEvidence: [...new Set([model, ...files, ...args])] };
}

/** Runs the official suite against a loaded, idle service. Never starts, loads or reconfigures it. */
export async function runOfficialBench(profile: ServiceProfile, input: OfficialBenchOptions = DEFAULT_OFFICIAL_BENCH_OPTIONS,
  onProgress: (progress: OfficialBenchProgress) => void = () => {}, signal?: AbortSignal): Promise<OfficialBenchReport> {
  const options = { ...input };
  validateOfficialBenchOptions(options);
  if (signal?.aborted) throw new StrataError('CANCELLED', '测试已取消');
  const baseUrl = normalizeBaseUrl(profile.baseUrl), release = acquireBenchmarkEndpoint(baseUrl);
  const controller = new AbortController(), cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const began = clock();
  try {
    if (isDesktop() && (await serviceStatus(profile.id, profile)).running !== true) throw new StrataError('BENCHMARK_SERVICE_STOPPED', '服务未启动，请先启动并加载模型');
    const health = await request(profile, '/health');
    if (health.service !== 'strata' || health.status !== 'ok') throw new StrataError('BENCHMARK_SERVICE_UNAVAILABLE', '请先连接健康的 Strata 服务');
    if (health.loaded !== true) throw new StrataError('BENCHMARK_MODEL_UNLOADED', '模型尚未加载，请先启动并加载模型');
    const model = typeof health.model === 'string' && health.model.trim() ? health.model : 'strata';
    const maxContext = count(health.max_context);
    const metrics: JsonObject = await request(profile, '/metrics').catch((): JsonObject => ({}));
    const live = asObject(metrics.live);
    if (['reading', 'generating'].includes(String(live.state)) || ['running', 'queued', 'waiting', 'admitting', 'outside_slots'].some(k => (count(live[k]) ?? 0) > 0))
      throw new StrataError('BENCHMARK_SERVICE_BUSY', '服务仍有推理或排队请求，请空闲后再测试');
    const identity = isDesktop() ? await benchmarkIdentity(profile).catch(() => undefined) : undefined;
    const plan = planOfficialBench(options, maxContext);
    const nonce = String(Math.floor(Date.now() / 1000)), tag = (...parts: (string | number)[]) => officialTag(nonce, ...parts);
    const results: OfficialBenchResults = { chat: null, prompts: {}, agent: null, skipped: {}, failures: [] };
    const report: OfficialBenchReport = { schemaVersion: 1, kind: 'official-bench', script: OFFICIAL_BENCH_SCRIPT, id: crypto.randomUUID(), profileId: profile.id,
      profileName: profile.name, baseUrl, model, maxContext, startedAt: Date.now(), finishedAt: 0, elapsedMs: 0, options, state: 'completed',
      calibration: { tokensPerWord: 1.1, overhead: 40 }, results, machine: machineOf(metrics, identity, model), ...(identity ? { identity } : {}),
      engineVersion: typeof asObject(metrics.engine).version === 'string' ? asObject(metrics.engine).version as string : null };
    let done = 0, phase: OfficialBenchPhase = 'warmup';
    const step = (last?: OfficialRequestDigest) => onProgress({ phase, done, total: plan.total, phases: plan.phases, ...(last ? { last } : {}) });
    const send = async (messages: JsonObject[], maxTokens: number, tools?: JsonObject[]) => {
      if (controller.signal.aborted) throw new StrataError('CANCELLED', '测试已取消');
      const at = Math.round(clock() - began);
      const raw = { ...await officialChat(profile, messages, maxTokens, options.timeoutMs, controller.signal, tools), at };
      if (controller.signal.aborted) throw new StrataError('CANCELLED', '测试已取消');
      done++;
      return raw;
    };
    const fail = (where: string, d: OfficialRequestDigest) => results.failures.push({ where, error: d.err ?? 'no token came back' });
    const user = (content: string): JsonObject[] => [{ role: 'user', content }];
    const promptFor = (tokens: number, run: number) => user(`[bench ${tag(run, tokens, 'p')}]\n` + officialLongPrompt(officialPromptWords(tokens, report.calibration)));
    const runPrompt = async (label: OfficialPromptLabel, tokens: number) => {
      phase = label; step();
      const rows: OfficialPromptRow[] = [];
      for (let run = 0; run < options.runs; run++) {
        const d = { ...officialDigest(await send(promptFor(tokens, run), OFFICIAL_LONG_MAX_TOKENS)), run };
        rows.push(d); if (!d.ok) fail(label, d); step(d);
      }
      const good = rows.filter(r => r.ok);
      results.prompts[label] = { targetTokens: tokens, requests: rows, promptTps: officialStat(good.map(r => r.promptTps)), ttftS: officialStat(good.map(r => r.ttftS)),
        promptTokens: officialStat(good.map(r => r.promptTokens)), reusedTokens: officialStat(good.map(r => r.reusedTokens ?? 0)) };
    };
    for (const t of plan.skipped) results.skipped[t.label] = `the context is ${maxContext} tokens`;
    if (options.agent && !plan.agent) results.skipped.agent = `context ${maxContext} is below ~10K`;
    try {
      step();
      // warm_up(): not measured
      await send(user(OFFICIAL_BENCH_PROMPTS[0]!), 24);
      const cal: (number | null)[] = [];
      for (const words of [200, 800]) cal.push(officialDigest(await send(user(`[${tag('cal', words)}]\n` + officialLongPrompt(words)), 1)).promptTokens);
      report.calibration = officialCalibration(cal[0], cal[1]);
      await send(promptFor(1024, -1), 8);
      // run_chat()
      phase = 'chat'; step();
      const chatRows: OfficialChatRow[] = [];
      for (let run = 0; run < options.runs; run++) for (let i = 0; i < OFFICIAL_BENCH_PROMPTS.length; i++) {
        const d = { ...officialDigest(await send(user(`[${tag(run, i, 'c')}] ${OFFICIAL_BENCH_PROMPTS[i]}`), OFFICIAL_CHAT_MAX_TOKENS)), run, prompt: i };
        chatRows.push(d); if (!d.ok) fail('chat', d); step(d);
      }
      const good = chatRows.filter(r => r.ok);
      results.chat = { requests: chatRows, decodeTps: officialStat(good.map(r => r.decodeTps)), ttftS: officialStat(good.map(r => r.ttftS)),
        generatedTokens: officialStat(good.map(r => r.generatedTokens)), promptTokens: officialStat(good.map(r => r.promptTokens)) };
      for (const t of plan.prompts.filter(t => t.label !== '32K')) await runPrompt(t.label, t.tokens);
      if (plan.agent) {
        phase = 'agent'; step();
        const sessions: OfficialAgentTurn[][] = [];
        for (let run = 0; run < options.runs; run++) {
          const msgs: JsonObject[] = [{ role: 'system', content: `${OFFICIAL_BENCH_SYSTEM}\n(session ${tag(run, 'a')})` },
            { role: 'user', content: 'I will show you files from a project one at a time. After each file, answer in one or two sentences what it is for. Do not call tools.' }];
          const turns: OfficialAgentTurn[] = [];
          for (let t = 0; t <= OFFICIAL_AGENT_TURNS; t++) {
            if (t > 0) msgs.push({ role: 'user', content: `File generated/part${t - 1}.txt:\n${officialLongPrompt(OFFICIAL_AGENT_WORDS)}\n\nWhat is this file for? Two sentences.` });
            const raw = await send(msgs, OFFICIAL_AGENT_MAX_TOKENS, OFFICIAL_BENCH_TOOLS);
            const d = { ...officialDigest(raw), run, turn: t };
            turns.push(d); step(d);
            if (!d.ok) { fail('agent', d); break; }
            msgs.push({ role: 'assistant', content: raw.text || 'Understood.' });
          }
          sessions.push(turns);
        }
        results.agent = officialAgentSummary(sessions);
      }
      for (const t of plan.prompts.filter(t => t.label === '32K')) await runPrompt(t.label, t.tokens);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      report.state = 'cancelled';
    }
    if (report.state === 'completed' && results.failures.length) report.state = results.chat || Object.keys(results.prompts).length || results.agent ? 'completed' : 'failed';
    const before = benchmarkCounters(metrics);
    const after = before && report.state !== 'cancelled' ? await request(profile, '/metrics').then(benchmarkCounters, () => null) : null;
    report.evidence = { counters: before && after ? { before, after } : null };
    phase = 'done'; step();
    report.finishedAt = Date.now(); report.elapsedMs = Math.max(0, clock() - began);
    return report;
  } finally { signal?.removeEventListener('abort', cancel); release(); }
}
