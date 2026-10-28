import { isOrcaRouterEvidence } from './orca-import';
// Benchmark Arena: opt-in, anonymous sharing of benchmark results.
// The upload payload is built from an explicit whitelist. Nothing from a report is copied wholesale:
// no paths, hostnames, service addresses, API keys, prompts, outputs, process ids or exact timestamps.
import type { ContextBenchmarkReport } from './context-benchmark-types';
import type { BenchmarkSuiteReport } from './benchmark-suite-types';
import type { BenchmarkIdentity } from './benchmark-comparison';
import type { JsonObject } from './types';

export const ARENA_SCHEMA_VERSION = 1;
export const ARENA_CONSENT_VERSION = 1;
export const ARENA_ENDPOINT = 'https://arena.cosfoc.com';

export interface ArenaGpu { vendor: 'nvidia' | 'amd' | 'intel' | 'apple' | 'other'; name: string; vramGB: number }
export interface ArenaParams { ctx: number; kv: string; gpuCount: number; parallel: number; poolWorkers: number | null; expertCache: string | null; pcieFrac: number | null; vision: boolean }
export interface ArenaTier { ctx: number; prefill: number | null; decode: number | null; ttftMs: number | null; peakVramGB: number | null; peakRamGB: number | null; ok: boolean }
export interface ArenaScenario { decode: number | null; prefill: number | null; ttftMs: number | null; maxConcurrency: number; requests: number; failed: number }
/** One completed benchmark request: offsets from the run start, timings and token counts only. */
export interface ArenaEvidenceRun { ctx: number; startMs: number; endMs: number; ttftMs: number; promptTokens: number; cachedTokens: number | null; completionTokens: number; prefill: number; decode: number; resourceSamples: number }
export interface ArenaEvidenceCounters { requests: number; promptTokens: number; outputTokens: number }
/**
 * Run evidence: a content-free trace of the in-app run behind a context result. The native side serializes it,
 * signs it with the install key and uploads it next to the result; the server checks it for internal consistency.
 */
export interface ArenaEvidence {
  v: 1; engine: string | null; durationMs: number; intervalMs: number; runs: ArenaEvidenceRun[];
  series: { count: number; stepMs: number; vramGB: (number | null)[]; ramGB: (number | null)[]; gpuUtil: (number | null)[] };
  counters: { before: ArenaEvidenceCounters; after: ArenaEvidenceCounters } | null;
}
/** Exactly what is uploaded (the native side adds consentVersion and signs it with the per-install key). */
/** Summary medians of an official-method run (tools/strata_bench.py): speeds in tok/s, times in seconds, the agent cache hit in %. */
export const ARENA_OFFICIAL_METRICS = ['chatDecodeTps', 'chatTtftS', 'p4kTps', 'p4kTtftS', 'p16kTps', 'p16kTtftS', 'p32kTps', 'p32kTtftS', 'agentHitPct', 'agentDecodeTps', 'agentTurnTtftS'] as const;
export type ArenaOfficialMetric = typeof ARENA_OFFICIAL_METRICS[number];
/** `upstream` is the commit of the script the run follows; `runs` and `long` are its --runs and --long. */
export interface ArenaOfficial { upstream: string; runs: number; long: boolean; metrics: Record<ArenaOfficialMetric, number | null> }
export interface ArenaPayload {
  schema: 1; app: string; strata: string | null; kind: 'context' | 'scenario' | 'official'; day: string;
  hw: { os: 'windows' | 'linux' | 'macos'; arch: 'x86_64' | 'aarch64'; cpu: string; ramGB: number; gpus: ArenaGpu[]; pcie: string | null; wsl: boolean };
  model: { family: string; quant: string; sha256: string | null; sizeGB: number | null };
  params: ArenaParams;
  tiers?: ArenaTier[]; scenario?: ArenaScenario; evidence?: ArenaEvidence;
  /** kind 'official' only. The native side only sends it to servers whose /v1/health advertises `official: true`. */
  official?: ArenaOfficial;
  /** Optional context for leaderboard tracks. The native side only sends it to servers whose /v1/health advertises `extensions: true`. */
  extensions?: ArenaExtensions;
}
export type ArenaDrafting = 'auto' | 'mtp' | 'dflash2' | 'off';
export type ArenaExperts = 'resident' | 'mmap' | 'cache';
/**
 * Track and key launch parameters: `default` means the setup recipe with automatic drafting and no saved GPU roles,
 * `custom` anything else. Every field is an enum or boolean, never free text.
 */
export interface ArenaExtensions { track: 'default' | 'custom'; drafting: ArenaDrafting | null; mtp: boolean | null; gpuRoles: ('main' | 'helper' | 'off')[] | null; experts: ArenaExperts | null }
export interface ArenaLaunch extends ArenaParams { family: string; quant: string; experts?: ArenaExperts | null }
export interface ArenaEnvironment { os: string; arch: string; appVersion: string; wsl?: boolean }
export type ArenaBuild = { payload: ArenaPayload } | { skip: 'not_completed' | 'no_identity' | 'no_hardware' | 'unknown_model' | 'no_results' | 'unsupported_platform' };

// The whitelist, as exact key sets. Both the builder and assertArenaPayloadSafe use it.
export const ARENA_KEYS = {
  root: ['schema', 'app', 'strata', 'kind', 'day', 'hw', 'model', 'params', 'tiers', 'scenario', 'evidence', 'extensions', 'official'],
  official: ['upstream', 'runs', 'long', 'metrics'], officialMetrics: ARENA_OFFICIAL_METRICS,
  extensions: ['track', 'drafting', 'mtp', 'gpuRoles', 'experts'],
  hw: ['os', 'arch', 'cpu', 'ramGB', 'gpus', 'pcie', 'wsl'], gpu: ['vendor', 'name', 'vramGB'],
  model: ['family', 'quant', 'sha256', 'sizeGB'], params: ['ctx', 'kv', 'gpuCount', 'parallel', 'poolWorkers', 'expertCache', 'pcieFrac', 'vision'],
  tier: ['ctx', 'prefill', 'decode', 'ttftMs', 'peakVramGB', 'peakRamGB', 'ok'], scenario: ['decode', 'prefill', 'ttftMs', 'maxConcurrency', 'requests', 'failed'],
  evidence: ['v', 'engine', 'durationMs', 'intervalMs', 'runs', 'series', 'counters'],
  evidenceRun: ['ctx', 'startMs', 'endMs', 'ttftMs', 'promptTokens', 'cachedTokens', 'completionTokens', 'prefill', 'decode', 'resourceSamples'],
  evidenceSeries: ['count', 'stepMs', 'vramGB', 'ramGB', 'gpuUtil'], evidenceCounters: ['before', 'after'], counters: ['requests', 'promptTokens', 'outputTokens'],
} as const;
export const ARENA_EVIDENCE_MAX_RUNS = 48;

const GB = 1024 ** 3;
const round = (v: number | null | undefined, d = 1) => v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;
const median = (values: (number | null | undefined)[]) => {
  const s = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const max = (values: (number | null | undefined)[]) => { const s = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)); return s.length ? Math.max(...s) : null; };

/** Hardware names keep letters, digits and a few separators; anything that could carry a path, address or email is removed. */
export function arenaName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/\((?:R|TM)\)/gi, '').replace(/[^A-Za-z0-9 ()+._-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 96).trim();
  return clean || null;
}
export function arenaGpuVendor(name: string): ArenaGpu['vendor'] {
  if (/nvidia|geforce|rtx|gtx|quadro|tesla|titan/i.test(name)) return 'nvidia';
  if (/radeon|amd|instinct|\brx\s?\d/i.test(name)) return 'amd';
  if (/intel|\barc\b/i.test(name)) return 'intel';
  if (/apple|\bm[1-9]\b/i.test(name)) return 'apple';
  return 'other';
}
const QUANT = /(?:^|[^A-Za-z0-9])((?:UD-)?(?:IQ[1-4]_(?:XXS|XS|S|M|NL)|Q[2-8]_(?:K_(?:XL|S|M|L)|K|0|1)|BF16|F16))(?=$|[^A-Za-z0-9])/gi;
/** Model family + quantization from file names only (basenames supplied by the identity), never from paths. */
export function arenaModelOf(evidence: string): { family: string; quant: string } | null {
  const quants = [...new Set([...evidence.matchAll(QUANT)].map(m => m[1]!.toUpperCase()))];
  if (quants.length !== 1 || isOrcaRouterEvidence(evidence)) return null;
  const quant = quants[0]!;
  // Qwen3.6 Unsloth MTP files also use UD-* names; prefer architecture evidence over quant prefix.
  const family = /qwen3\.?6|qwen36/i.test(evidence) ? 'qwen36' : quant.startsWith('UD-') || (quant === 'Q8_0' && /flash-next/i.test(evidence)) || /unsloth/i.test(evidence) ? 'unsloth' : /swift/i.test(evidence) ? 'swift' : /coder/i.test(evidence) ? 'coder' : /qwen/i.test(evidence) ? 'qwen' : null;
  return family ? { family, quant } : null;
}

/**
 * The model key the official-method board uses: the Arena key where one exists, plus the catalog models the
 * published strata_bench.py numbers cover (Qwen NVFP4-QAD, DeepSeek IST-DAS-*bpw). `quant` is null when unknown.
 */
export function arenaOfficialModelKey(evidence: string): { family: string; quant: string | null } | null {
  if (!evidence.trim()) return null;
  if (/fp4[-_ ]?local|nvfp4[-_ ]?qad/i.test(evidence)) return { family: 'qwen', quant: 'NVFP4-QAD' };
  if (/deepseek|dsv4|ist[-_]?das/i.test(evidence)) {
    const bpw = evidence.match(/(\d\.\d{2})\s*[-_]?\s*bpw/i);
    return { family: 'deepseek41', quant: bpw ? `IST-DAS-${bpw[1]}bpw` : null };
  }
  return arenaModelOf(evidence);
}
/** arenaOfficialModelKey with a known quant, for arenaLaunchParams. */
export const arenaOfficialModelOf = (evidence: string) => { const key = arenaOfficialModelKey(evidence); return key?.quant ? { family: key.family, quant: key.quant } : null; };

/** Whitelisted launch parameters from the sanitized resource configuration the native identity returns. */
export function arenaLaunchParams(config: JsonObject | undefined, modelOf: (evidence: string) => { family: string; quant: string } | null = arenaModelOf): ArenaLaunch | null {
  if (!config || !Array.isArray(config.args) || !config.args.every(a => typeof a === 'string')) return null;
  const args = config.args as string[];
  const read = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const model = modelOf([read('--native'), read('--pack')].filter(Boolean).join(' '));
  const ctx = Number(read('--max-context'));
  if (!model || !Number.isSafeInteger(ctx) || ctx < 512) return null;
  const token = (v: string | undefined) => v && /^[A-Za-z0-9_.-]{1,24}$/.test(v) ? v : null;
  const gpu = Array.isArray(config.gpu) ? config.gpu.length : 1;
  const workers = Number(read('--pool-workers')), frac = Number(read('--pcie-frac'));
  const experts: ArenaExperts | null = args.includes('--resident-experts') ? 'resident' : args.includes('--mmap-experts') ? 'mmap' : read('--expert-cache') ? 'cache' : null;
  return { ...model, experts, ctx, kv: token(read('--kv')) ?? (ctx <= 8192 ? 'fp16' : 'int8'), gpuCount: gpu, parallel: Number(config.parallel) || 1,
    poolWorkers: Number.isSafeInteger(workers) && workers > 0 ? workers : null, expertCache: token(read('--expert-cache')) ?? 'auto',
    pcieFrac: Number.isFinite(frac) && frac >= 0 && frac <= 1 ? frac : null, vision: config.vision === true };
}

/** Content-free model fingerprint: SHA-256 over sorted [file name, size] pairs (no modification times, no paths). */
export async function arenaModelFingerprint(identity: BenchmarkIdentity | undefined): Promise<{ sha256: string | null; sizeGB: number | null }> {
  const files = (identity?.model.files ?? []).map(f => [typeof f.name === 'string' ? f.name.split(/[\\/]/).pop()! : '', typeof f.size === 'number' ? f.size : 0] as const).filter(([n, s]) => n && s > 0).sort();
  if (!files.length || typeof crypto === 'undefined' || !crypto.subtle) return { sha256: null, sizeGB: null };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(files)));
  return { sha256: [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join(''), sizeGB: round(files.reduce((s, [, n]) => s + n, 0) / GB, 1) };
}

const DRAFTINGS: readonly ArenaDrafting[] = ['auto', 'mtp', 'dflash2', 'off'];
const ROLES = ['main', 'helper', 'off'] as const;
/** Track + key parameters from the benchmark identity (drafting, GPU roles) and the whitelisted launch (experts). */
export function arenaExtensions(identity: BenchmarkIdentity | undefined, launch: ArenaLaunch | null | undefined): ArenaExtensions {
  const d = identity?.drafting;
  const requested = d?.requested && DRAFTINGS.includes(d.requested) ? d.requested : null;
  const drafting: ArenaDrafting | null = d?.effective && DRAFTINGS.includes(d.effective) ? d.effective : requested;
  const mtp = d?.effective ? d.effective === 'mtp' : typeof d?.mtpSwitch === 'boolean' ? d.mtpSwitch : null;
  const roles = Array.isArray(identity?.gpuRoles) && identity!.gpuRoles!.length <= 16 && identity!.gpuRoles!.every(r => (ROLES as readonly string[]).includes(r)) ? [...identity!.gpuRoles!] : null;
  const experts = launch?.experts === 'resident' || launch?.experts === 'mmap' || launch?.experts === 'cache' ? launch.experts : null;
  const track = identity?.resourceRequest && (requested === null || requested === 'auto') && d?.mtpSwitch !== false && !roles ? 'default' : 'custom';
  return { track, drafting, mtp, gpuRoles: roles, experts };
}

const osOf = (os: string): ArenaPayload['hw']['os'] | null => /windows/i.test(os) ? 'windows' : /linux|ubuntu|debian|fedora|arch/i.test(os) ? 'linux' : /mac|darwin/i.test(os) ? 'macos' : null;
const archOf = (arch: string): ArenaPayload['hw']['arch'] | null => /x86_64|amd64|x64/i.test(arch) ? 'x86_64' : /aarch64|arm64/i.test(arch) ? 'aarch64' : null;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The hardware, model and parameter part every upload kind shares. */
export async function arenaBase(identity: BenchmarkIdentity | undefined, launch: ArenaLaunch | null | undefined, env: ArenaEnvironment,
  run: { hardware?: JsonObject | null; engine?: unknown; finishedAt: number }): Promise<{ base: ArenaPayload; engineVersion: string | null } | { skip: 'no_identity' | 'no_hardware' | 'unknown_model' | 'unsupported_platform' }> {
  if (!identity) return { skip: 'no_identity' };
  const sig = identity.hardwareSignature;
  if (!sig || !sig.cpuName || !(sig.totalMemoryBytes > 0)) return { skip: 'no_hardware' };
  if (!launch) return { skip: 'unknown_model' };
  const os = osOf(env.os), arch = archOf(env.arch), app = /^\d+\.\d+\.\d+$/.test(env.appVersion) ? env.appVersion : null;
  if (!os || !arch || !app) return { skip: 'unsupported_platform' };
  const gpus = sig.gpus.slice(0, 16).flatMap(g => { const name = arenaName(g.name); return name && g.totalBytes > 0 ? [{ vendor: arenaGpuVendor(name), name, vramGB: Math.max(1, Math.round(g.totalBytes / GB)) }] : []; });
  const hw = run.hardware ?? {};
  const gen = Number(hw.gpu_pcie_gen_max ?? hw.gpu_pcie_gen), width = Number(hw.gpu_pcie_width);
  const pcie = gen >= 1 && gen <= 7 && [1, 2, 4, 8, 16].includes(width) ? `Gen${gen} x${width}` : null;
  const engineVersion = typeof run.engine === 'string' && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(run.engine) ? run.engine : null;
  const fp = await arenaModelFingerprint(identity);
  const base: ArenaPayload = {
    schema: 1, app, strata: engineVersion, kind: 'context', day: day(run.finishedAt),
    hw: { os, arch, cpu: arenaName(sig.cpuName) ?? 'Unknown CPU', ramGB: Math.max(1, Math.round(sig.totalMemoryBytes / GB)), gpus, pcie, wsl: env.wsl === true },
    model: { family: launch.family, quant: launch.quant, sha256: fp.sha256, sizeGB: fp.sizeGB },
    params: { ctx: launch.ctx, kv: launch.kv, gpuCount: Math.min(launch.gpuCount, gpus.length), parallel: launch.parallel, poolWorkers: launch.poolWorkers, expertCache: launch.expertCache, pcieFrac: launch.pcieFrac, vision: launch.vision },
    extensions: arenaExtensions(identity, launch),
  };
  return { base, engineVersion };
}

/** Builds the upload payload from a finished report. Returns a skip reason instead of guessing. */
export async function buildArenaPayload(report: ContextBenchmarkReport | BenchmarkSuiteReport, env: ArenaEnvironment): Promise<ArenaBuild> {
  if (report.state !== 'completed') return { skip: 'not_completed' };
  const identity = report.identity as (BenchmarkIdentity & { launch?: ArenaLaunch | null }) | undefined;
  const built = await arenaBase(identity, identity?.launch, env, { hardware: report.hardware, engine: report.engine?.version, finishedAt: report.finishedAt });
  if ('skip' in built) return built;
  const { base, engineVersion } = built;
  if ('skippedTiers' in report) {
    const byTier = new Map<number, ContextBenchmarkReport['samples']>();
    for (const s of report.samples) { if (!byTier.has(s.targetTokens)) byTier.set(s.targetTokens, []); byTier.get(s.targetTokens)!.push(s); }
    const tiers: ArenaTier[] = [...byTier].sort(([a], [b]) => a - b).slice(0, 16).map(([ctx, samples]) => {
      const done = samples.filter(s => s.state === 'completed');
      return { ctx, prefill: round(median(done.map(s => s.prefillTokS))), decode: round(median(done.map(s => s.decodeTokS)), 2), ttftMs: round(median(done.map(s => s.ttftMs)), 0),
        peakVramGB: round(max(samples.map(s => s.peakGpuMemory)) === null ? null : max(samples.map(s => s.peakGpuMemory))! / GB), peakRamGB: round(max(samples.map(s => s.peakRam)) === null ? null : max(samples.map(s => s.peakRam))! / GB),
        ok: done.length > 0 && median(done.map(s => s.decodeTokS)) !== null };
    });
    if (!tiers.some(t => t.ok)) return { skip: 'no_results' };
    const evidence = arenaEvidence(report as ContextBenchmarkReport, engineVersion);
    return { payload: { ...base, kind: 'context', tiers, ...(evidence ? { evidence } : {}) } };
  }
  const measured = report.samples.filter(s => !s.warmup);
  const done = measured.filter(s => s.state === 'completed');
  if (!done.length) return { skip: 'no_results' };
  return { payload: { ...base, kind: 'scenario', scenario: {
    decode: round(median(done.map(s => s.decodeTokS)), 2), prefill: round(median(done.map(s => s.prefillTokS))), ttftMs: round(median(done.map(s => s.ttftMs)), 0),
    maxConcurrency: Math.max(1, ...report.stages.map(s => s.concurrency)), requests: measured.length, failed: measured.length - done.length } } };
}

/** Evidence from the report's own measurements: offsets relative to the run start, never wall-clock times, prompts or outputs. */
export function arenaEvidence(report: ContextBenchmarkReport, engine: string | null): ArenaEvidence | null {
  if (!report.evidence) return null;
  const n = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
  const runs = report.samples.filter(s => s.state === 'completed' && n(s.ttftMs) && n(s.prefillTokS) && n(s.decodeTokS) && n(s.promptTokens) && n(s.completionTokens))
    .slice(0, ARENA_EVIDENCE_MAX_RUNS).map(s => {
      const startMs = Math.max(0, Math.round(s.startedAt - report.startedAt));
      return { ctx: s.targetTokens, startMs, endMs: startMs + Math.round(s.wallMs), ttftMs: Math.round(s.ttftMs!), promptTokens: s.promptTokens!, cachedTokens: s.cachedTokens ?? null,
        completionTokens: s.completionTokens!, prefill: round(s.prefillTokS)!, decode: round(s.decodeTokS, 2)!, resourceSamples: s.resourceSamples };
    });
  if (!runs.length) return null;
  const { series, counters } = report.evidence;
  return { v: 1, engine, durationMs: Math.round(report.elapsedMs), intervalMs: report.resourceIntervalMs, runs,
    series: { count: series.count, stepMs: series.stepMs, vramGB: [...series.vramGB], ramGB: [...series.ramGB], gpuUtil: [...series.gpuUtil] },
    counters: counters ? { before: { ...counters.before }, after: { ...counters.after } } : null };
}

const SAFE_STRING = /^[A-Za-z0-9 ()+._-]{0,96}$/;
/** Defense in depth: exact key sets and conservative string contents, checked again right before upload. */
export function assertArenaPayloadSafe(payload: unknown): asserts payload is ArenaPayload {
  const fail = (why: string): never => { throw new Error('Arena payload rejected: ' + why); };
  const exact = (obj: unknown, allowed: readonly string[], where: string) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail(where + ' is not an object');
    for (const k of Object.keys(obj as object)) if (!allowed.includes(k)) fail(`${where}.${k} is not whitelisted`);
  };
  const walk = (v: unknown, where: string): void => {
    if (typeof v === 'string' && !SAFE_STRING.test(v)) fail(where + ' contains unsafe characters');
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, where + '.' + k);
  };
  const p = payload as ArenaPayload;
  exact(p, ARENA_KEYS.root, 'payload'); exact(p.hw, ARENA_KEYS.hw, 'hw'); exact(p.model, ARENA_KEYS.model, 'model'); exact(p.params, ARENA_KEYS.params, 'params');
  p.hw.gpus.forEach((g, i) => exact(g, ARENA_KEYS.gpu, `gpus[${i}]`));
  (p.tiers ?? []).forEach((t, i) => exact(t, ARENA_KEYS.tier, `tiers[${i}]`));
  if (p.scenario) exact(p.scenario, ARENA_KEYS.scenario, 'scenario');
  if (p.official !== undefined) {
    exact(p.official, ARENA_KEYS.official, 'official'); exact(p.official.metrics, ARENA_KEYS.officialMetrics, 'official.metrics');
    if (!/^[a-f0-9]{7,40}$/.test(p.official.upstream)) fail('official.upstream');
    for (const v of Object.values(p.official.metrics)) if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) fail('official.metrics');
  }
  if (p.extensions !== undefined) {
    const x = p.extensions;
    exact(x, ARENA_KEYS.extensions, 'extensions');
    if (x.track !== 'default' && x.track !== 'custom') fail('extensions.track');
    if (x.drafting !== null && !DRAFTINGS.includes(x.drafting)) fail('extensions.drafting');
    if (x.mtp !== null && typeof x.mtp !== 'boolean') fail('extensions.mtp');
    if (x.gpuRoles !== null && (!Array.isArray(x.gpuRoles) || x.gpuRoles.length > 16 || !x.gpuRoles.every(r => (ROLES as readonly string[]).includes(r)))) fail('extensions.gpuRoles');
    if (x.experts !== null && !['resident', 'mmap', 'cache'].includes(x.experts)) fail('extensions.experts');
  }
  if (p.evidence !== undefined) {
    const e = p.evidence;
    exact(e, ARENA_KEYS.evidence, 'evidence'); exact(e.series, ARENA_KEYS.evidenceSeries, 'evidence.series');
    if (!Array.isArray(e.runs) || e.runs.length > ARENA_EVIDENCE_MAX_RUNS) fail('evidence.runs');
    e.runs.forEach((r, i) => exact(r, ARENA_KEYS.evidenceRun, `evidence.runs[${i}]`));
    if (e.counters !== null) { exact(e.counters, ARENA_KEYS.evidenceCounters, 'evidence.counters'); exact(e.counters.before, ARENA_KEYS.counters, 'evidence.counters.before'); exact(e.counters.after, ARENA_KEYS.counters, 'evidence.counters.after'); }
    // Only numbers (and the engine version) inside the evidence: nothing that could carry text.
    const numbers = (v: unknown, where: string): void => {
      if (Array.isArray(v)) v.forEach((x, i) => numbers(x, `${where}[${i}]`));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) numbers(x, where + '.' + k);
      else if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) fail(where + ' is not a number');
    };
    const { engine, ...rest } = e;
    if (engine !== null && !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(engine)) fail('evidence.engine');
    numbers(rest, 'evidence');
  }
  walk(p, 'payload');
}

// ---- API response types (GET /v1/groups, /v1/leaderboard, /v1/recommend) ----
export interface ArenaRowHardware { gpu: string; vramGB: number; ramGB: number }
export interface ArenaRow { rank?: number | null; hw: ArenaRowHardware; params: ArenaParams; seed: boolean; machines: number; confidence: 'high' | 'medium' | 'low' | 'none' | 'seed';
  decode: { p25: number | null; median: number; p75: number | null }; prefill: number | null; ttftMs: number | null; decode32k: number | null; decode128k: number | null; peakRamGB: number | null; peakVramGB: number | null }
export interface ArenaGroupSummary { group: string; family: string; quant: string; machines: number; seedMachines: number; configs: number; bestDecode: number; gpus: { gpu: string; vramGB: number; machines: number }[];
  top?: Pick<ArenaRow, 'hw' | 'params' | 'seed' | 'machines' | 'decode'>[] }
export interface ArenaGroups { computedAt: number | null; machines: number; runs: number; groups: ArenaGroupSummary[] }
export type ArenaSort = 'decode8k' | 'decode128k' | 'prefill' | 'machines';
export const ARENA_SORTS: readonly ArenaSort[] = ['decode8k', 'decode128k', 'prefill', 'machines'];
/** Leaderboard facets: hardware tiers and the launch parameters that most change speed. */
export const ARENA_FACETS = ['vram', 'ram', 'ctx', 'kv', 'parallel', 'gpuCount', 'expertCache'] as const;
export type ArenaFacet = typeof ARENA_FACETS[number];
/** Active leaderboard filters as query-string values; an empty or missing value means "all". */
export type ArenaFilters = Partial<Record<ArenaFacet | 'gpu' | 'q', string>>;
export type ArenaFacetOptions = Record<ArenaFacet, (number | string)[]>;
export interface ArenaLeaderboard extends Partial<Omit<ArenaGroupSummary, 'group'>> { group: string | null; rows: ArenaRow[]; tierMedian: number | null;
  filter?: { gpu: string | null; vram: number | null } & Partial<Record<Exclude<ArenaFacet, 'vram'> | 'q', number | string | null>> & { sort?: ArenaSort };
  /** Present on servers that support filtering: the whole group's distinct values per facet. */
  options?: ArenaFacetOptions & { gpus?: { gpu: string; vramGB: number; machines: number }[] }; total?: number; sort?: ArenaSort }
export interface ArenaRecommendRow { hw: ArenaRowHardware; params: ArenaParams; seed: boolean; machines: number; confidence: ArenaRow['confidence']; speed: number; decode: ArenaRow['decode']; peakRamGB: number | null; peakVramGB: number | null }
export interface ArenaParamChange { param: keyof ArenaParams; from: unknown; to: unknown; gainPct: number; machines: number; confidence: ArenaRow['confidence']; peakRamGB: number | null }
export interface ArenaRecommendation { scene: 'chat' | 'long' | 'code'; level: 'gpu' | 'vram' | 'none';
  sameModel: { group: string; level: 'gpu' | 'vram' | 'none'; best: ArenaRecommendRow | null; current: ArenaRecommendRow | null; changes: ArenaParamChange[]; alternatives: ArenaRecommendRow[] } | null;
  otherModels: (ArenaRecommendRow & { group: string; family: string; quant: string; level: 'gpu' | 'vram' | 'none' })[] }

// ---- Official-method board (/v1/official) ----
/** Orderings of the official board; chat decode, the figure the maintainers headline, is the default. */
export type ArenaOfficialSort = 'chatDecode' | 'prefill4k' | 'prefill16k' | 'prefill32k' | 'agentDecode' | 'machines';
export const ARENA_OFFICIAL_SORTS: readonly ArenaOfficialSort[] = ['chatDecode', 'prefill4k', 'prefill16k', 'prefill32k', 'agentDecode', 'machines'];
/** The figures a board row carries (a subset of ArenaOfficial metrics: the speeds plus chat TTFT and agent cache hit). */
export type ArenaOfficialRowMetric = 'chatDecodeTps' | 'chatTtftS' | 'p4kTps' | 'p16kTps' | 'p32kTps' | 'agentDecodeTps' | 'agentHitPct';
export interface ArenaOfficialRow { rank?: number | null; hw: ArenaRowHardware; params: ArenaParams; seed: boolean; machines: number; confidence: ArenaRow['confidence'];
  metrics: Record<ArenaOfficialRowMetric, number | null>; spread: { p25: number | null; p75: number | null } }
/** A published maintainer figure (official-bench-reference.json): labelled 官方, never ranked or counted. */
export interface ArenaOfficialReferenceRow { official: true; id: string; group: string; family: string; quant: string; hardware: string; setup: string;
  measured: { date: string | null; strata: string }; source: { title: string; url: string }; metrics: Record<ArenaOfficialRowMetric, number | null>; printed: Partial<Record<ArenaOfficialRowMetric, string>> }
export interface ArenaOfficialGroup { group: string; family: string; quant: string; machines: number; seedMachines: number; configs: number; best: number | null; references: number }
export interface ArenaOfficialBoard { computedAt: number | null; machines: number; runs: number; groups: ArenaOfficialGroup[]; group: string | null; family?: string; quant?: string;
  options?: ArenaFacetOptions & { gpus?: { gpu: string; vramGB: number; machines: number }[] }; total: number; sort: ArenaOfficialSort; rows: ArenaOfficialRow[]; median: number | null;
  references: ArenaOfficialReferenceRow[] }
/** Query of the official board: same filters as the context board, its own sort key. */
export function arenaOfficialQuery(group: string | null, filters: ArenaFilters = {}, sort: ArenaOfficialSort = 'chatDecode'): Record<string, string> {
  const query: Record<string, string> = group ? { group } : {};
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') query[key] = value;
  if (sort !== 'chatDecode') query.sort = sort;
  return query;
}
/** Value a board sort ranks by, for bars and for reference rows placed beside ranked ones. */
export const arenaOfficialSortMetric = (sort: ArenaOfficialSort): ArenaOfficialRowMetric | null =>
  ({ chatDecode: 'chatDecodeTps', prefill4k: 'p4kTps', prefill16k: 'p16kTps', prefill32k: 'p32kTps', agentDecode: 'agentDecodeTps', machines: null } as const)[sort];

// ---- Native state ----
export interface ArenaLogEntry { at: number; kind: 'context' | 'scenario' | 'official' | 'withdraw' | 'register'; status: 'queued' | 'uploaded' | 'rejected' | 'retrying' | 'skipped' | 'deleted' | 'registered'; detail?: string; group?: string }
export interface ArenaStatus {
  consented: boolean; consentVersion: number | null; autoUpload: boolean; queued: number; log: ArenaLogEntry[]; endpoint: string;
  /** False in builds without the CI-injected app key: the leaderboard is view-only. */
  uploadAvailable: boolean;
  /** The install key has been registered with the server (proof of work done). */
  registered: boolean;
  /** The maintainer disabled uploads from this install key. */
  banned: boolean;
}

/** Query string for GET /v1/recommend describing this machine and (optionally) its current model + parameters. */
export function arenaRecommendQuery(hw: { gpu?: string | null; vramGB?: number | null; ramGB?: number | null }, launch?: ArenaLaunch | null, scene: 'chat' | 'long' | 'code' = 'chat'): Record<string, string> {
  const q: Record<string, string> = { scene };
  if (hw.gpu) q.gpu = hw.gpu; if (hw.vramGB) q.vram = String(hw.vramGB); if (hw.ramGB) q.ram = String(hw.ramGB);
  if (launch) {
    q.family = launch.family; q.quant = launch.quant;
    for (const k of ['ctx', 'kv', 'parallel', 'poolWorkers', 'expertCache', 'gpuCount'] as const) if (launch[k] !== null && launch[k] !== undefined) q[k] = String(launch[k]);
  }
  return q;
}

// ---- Leaderboard filtering and sorting (mirrors services/arena/src/stats.js filterRows) ----
const SORT_VALUE: Record<ArenaSort, (row: ArenaRow) => number | null> = { decode8k: row => row.decode?.median ?? null, decode128k: row => row.decode128k ?? null, prefill: row => row.prefill ?? null, machines: row => row.machines ?? null };
const FACET_VALUE: Record<ArenaFacet, (row: ArenaRow) => number | string> = {
  vram: row => row.hw.vramGB, ram: row => row.hw.ramGB, ctx: row => row.params.ctx, kv: row => row.params.kv, parallel: row => row.params.parallel, gpuCount: row => row.params.gpuCount, expertCache: row => row.params.expertCache ?? 'auto',
};
const NUMERIC_FACETS = new Set<ArenaFacet>(['vram', 'ram', 'ctx', 'parallel', 'gpuCount']);
export const arenaSortValue = (row: ArenaRow, sort: ArenaSort): number | null => (SORT_VALUE[sort] ?? SORT_VALUE.decode8k)(row);
export const arenaFacetValue = (row: ArenaRow, facet: ArenaFacet): number | string => FACET_VALUE[facet](row);

/** Distinct values per facet, ascending; clients only offer options that exist. */
export function arenaFacetOptions(rows: ArenaRow[]): ArenaFacetOptions {
  const out = {} as ArenaFacetOptions;
  for (const facet of ARENA_FACETS) {
    const values = [...new Set(rows.map(FACET_VALUE[facet]).filter(value => value !== null && value !== undefined))];
    out[facet] = NUMERIC_FACETS.has(facet) ? (values as number[]).sort((a, b) => a - b) : values.sort((a, b) => String(a).localeCompare(String(b)));
  }
  return out;
}

/**
 * Narrows rows to the active filters (exact facet values, GPU name, GPU keyword) and re-ranks them by `sort`.
 * Rows without the sorted value go last with rank null. Applying it twice is harmless, so it also covers servers that ignore the filters.
 */
export function arenaApplyFilters(rows: ArenaRow[], filters: ArenaFilters, sort: ArenaSort = 'decode8k'): { rows: ArenaRow[]; tierMedian: number | null } {
  let out = rows;
  if (filters.gpu) out = out.filter(row => row.hw.gpu === filters.gpu);
  const keyword = filters.q?.trim().toLowerCase();
  if (keyword) out = out.filter(row => row.hw.gpu.toLowerCase().includes(keyword));
  for (const facet of ARENA_FACETS) { const want = filters[facet]; if (want !== undefined && want !== '') out = out.filter(row => String(FACET_VALUE[facet](row)) === want); }
  const value = SORT_VALUE[sort] ?? SORT_VALUE.decode8k;
  out = [...out].sort((a, b) => { const va = value(a), vb = value(b); if (va === null || vb === null) return Number(va === null) - Number(vb === null); return vb - va || b.decode.median - a.decode.median; });
  const medians = out.filter(row => !row.seed).map(row => row.decode.median).sort((a, b) => a - b);
  const mid = (medians.length - 1) / 2;
  const tierMedian = medians.length ? Math.round((medians[Math.floor(mid)]! + medians[Math.ceil(mid)]!) / 2 * 10) / 10 : null;
  let rank = 0;
  return { rows: out.map(row => ({ ...row, rank: value(row) === null ? null : ++rank })), tierMedian };
}

/** GET /v1/leaderboard query: group, hardware scope, active filters and sort (default sort omitted). */
export function arenaLeaderboardQuery(group: string, filters: ArenaFilters = {}, sort: ArenaSort = 'decode8k'): Record<string, string> {
  const query: Record<string, string> = { group };
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') query[key] = value;
  if (sort !== 'decode8k') query.sort = sort;
  return query;
}

// ---- arena_get failures ----
/**
 * Splits native `arena_get` failures: `network` means the server could not be reached or is temporarily down
 * (`network: …`, HTTP 408/429/5xx); `app` means the request reached the app's own checks or the server answered
 * something unusable (`arena_query_invalid`, other HTTP 4xx, `arena_response_invalid`, …). Only `network`
 * should be shown as "check your network".
 */
export function arenaFailure(error: unknown): { kind: 'network' | 'app'; code: string } {
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message
    : typeof (error as { message?: unknown } | null)?.message === 'string' ? (error as { message: string }).message : String(error);
  const code = text.trim().slice(0, 160) || 'unknown';
  const http = /^arena_http_(\d{3})\b/.exec(code);
  const network = /^network:/i.test(code) || (!!http && (Number(http[1]) >= 500 || http[1] === '408' || http[1] === '429'));
  return { kind: network ? 'network' : 'app', code };
}
