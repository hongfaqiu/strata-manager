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
/** Exactly what is uploaded (the native side adds installId and consentVersion before signing). */
export interface ArenaPayload {
  schema: 1; app: string; strata: string | null; kind: 'context' | 'scenario'; day: string;
  hw: { os: 'windows' | 'linux' | 'macos'; arch: 'x86_64' | 'aarch64'; cpu: string; ramGB: number; gpus: ArenaGpu[]; pcie: string | null; wsl: boolean };
  model: { family: string; quant: string; sha256: string | null; sizeGB: number | null };
  params: ArenaParams;
  tiers?: ArenaTier[]; scenario?: ArenaScenario;
}
export interface ArenaLaunch extends ArenaParams { family: string; quant: string }
export interface ArenaEnvironment { os: string; arch: string; appVersion: string; wsl?: boolean }
export type ArenaBuild = { payload: ArenaPayload } | { skip: 'not_completed' | 'no_identity' | 'no_hardware' | 'unknown_model' | 'no_results' | 'unsupported_platform' };

// The whitelist, as exact key sets. Both the builder and assertArenaPayloadSafe use it.
export const ARENA_KEYS = {
  root: ['schema', 'app', 'strata', 'kind', 'day', 'hw', 'model', 'params', 'tiers', 'scenario'],
  hw: ['os', 'arch', 'cpu', 'ramGB', 'gpus', 'pcie', 'wsl'], gpu: ['vendor', 'name', 'vramGB'],
  model: ['family', 'quant', 'sha256', 'sizeGB'], params: ['ctx', 'kv', 'gpuCount', 'parallel', 'poolWorkers', 'expertCache', 'pcieFrac', 'vision'],
  tier: ['ctx', 'prefill', 'decode', 'ttftMs', 'peakVramGB', 'peakRamGB', 'ok'], scenario: ['decode', 'prefill', 'ttftMs', 'maxConcurrency', 'requests', 'failed'],
} as const;

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
  if (quants.length !== 1) return null;
  const quant = quants[0]!;
  const family = quant.startsWith('UD-') || /unsloth/i.test(evidence) ? 'unsloth' : /swift/i.test(evidence) ? 'swift' : /coder/i.test(evidence) ? 'coder' : /qwen/i.test(evidence) ? 'qwen' : null;
  return family ? { family, quant } : null;
}

/** Whitelisted launch parameters from the sanitized resource configuration the native identity returns. */
export function arenaLaunchParams(config: JsonObject | undefined): ArenaLaunch | null {
  if (!config || !Array.isArray(config.args) || !config.args.every(a => typeof a === 'string')) return null;
  const args = config.args as string[];
  const read = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const model = arenaModelOf([read('--native'), read('--pack')].filter(Boolean).join(' '));
  const ctx = Number(read('--max-context'));
  if (!model || !Number.isSafeInteger(ctx) || ctx < 512) return null;
  const token = (v: string | undefined) => v && /^[A-Za-z0-9_.-]{1,24}$/.test(v) ? v : null;
  const gpu = Array.isArray(config.gpu) ? config.gpu.length : 1;
  const workers = Number(read('--pool-workers')), frac = Number(read('--pcie-frac'));
  return { ...model, ctx, kv: token(read('--kv')) ?? (ctx <= 8192 ? 'fp16' : 'int8'), gpuCount: gpu, parallel: Number(config.parallel) || 1,
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

const osOf = (os: string): ArenaPayload['hw']['os'] | null => /windows/i.test(os) ? 'windows' : /linux|ubuntu|debian|fedora|arch/i.test(os) ? 'linux' : /mac|darwin/i.test(os) ? 'macos' : null;
const archOf = (arch: string): ArenaPayload['hw']['arch'] | null => /x86_64|amd64|x64/i.test(arch) ? 'x86_64' : /aarch64|arm64/i.test(arch) ? 'aarch64' : null;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Builds the upload payload from a finished report. Returns a skip reason instead of guessing. */
export async function buildArenaPayload(report: ContextBenchmarkReport | BenchmarkSuiteReport, env: ArenaEnvironment): Promise<ArenaBuild> {
  if (report.state !== 'completed') return { skip: 'not_completed' };
  const identity = report.identity as (BenchmarkIdentity & { launch?: ArenaLaunch | null }) | undefined;
  if (!identity) return { skip: 'no_identity' };
  const sig = identity.hardwareSignature;
  if (!sig || !sig.cpuName || !(sig.totalMemoryBytes > 0)) return { skip: 'no_hardware' };
  const launch = identity.launch;
  if (!launch) return { skip: 'unknown_model' };
  const os = osOf(env.os), arch = archOf(env.arch), app = /^\d+\.\d+\.\d+$/.test(env.appVersion) ? env.appVersion : null;
  if (!os || !arch || !app) return { skip: 'unsupported_platform' };
  const gpus = sig.gpus.slice(0, 16).flatMap(g => { const name = arenaName(g.name); return name && g.totalBytes > 0 ? [{ vendor: arenaGpuVendor(name), name, vramGB: Math.max(1, Math.round(g.totalBytes / GB)) }] : []; });
  const hw = report.hardware ?? {};
  const gen = Number(hw.gpu_pcie_gen_max ?? hw.gpu_pcie_gen), width = Number(hw.gpu_pcie_width);
  const pcie = gen >= 1 && gen <= 7 && [1, 2, 4, 8, 16].includes(width) ? `Gen${gen} x${width}` : null;
  const engineVersion = typeof report.engine?.version === 'string' && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(report.engine.version) ? report.engine.version : null;
  const fp = await arenaModelFingerprint(identity);
  const base: ArenaPayload = {
    schema: 1, app, strata: engineVersion, kind: 'context', day: day(report.finishedAt),
    hw: { os, arch, cpu: arenaName(sig.cpuName) ?? 'Unknown CPU', ramGB: Math.max(1, Math.round(sig.totalMemoryBytes / GB)), gpus, pcie, wsl: env.wsl === true },
    model: { family: launch.family, quant: launch.quant, sha256: fp.sha256, sizeGB: fp.sizeGB },
    params: { ctx: launch.ctx, kv: launch.kv, gpuCount: Math.min(launch.gpuCount, gpus.length), parallel: launch.parallel, poolWorkers: launch.poolWorkers, expertCache: launch.expertCache, pcieFrac: launch.pcieFrac, vision: launch.vision },
  };
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
    return { payload: { ...base, kind: 'context', tiers } };
  }
  const measured = report.samples.filter(s => !s.warmup);
  const done = measured.filter(s => s.state === 'completed');
  if (!done.length) return { skip: 'no_results' };
  return { payload: { ...base, kind: 'scenario', scenario: {
    decode: round(median(done.map(s => s.decodeTokS)), 2), prefill: round(median(done.map(s => s.prefillTokS))), ttftMs: round(median(done.map(s => s.ttftMs)), 0),
    maxConcurrency: Math.max(1, ...report.stages.map(s => s.concurrency)), requests: measured.length, failed: measured.length - done.length } } };
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
  walk(p, 'payload');
}

// ---- API response types (GET /v1/groups, /v1/leaderboard, /v1/recommend) ----
export interface ArenaRowHardware { gpu: string; vramGB: number; ramGB: number }
export interface ArenaRow { rank?: number; hw: ArenaRowHardware; params: ArenaParams; seed: boolean; machines: number; confidence: 'high' | 'medium' | 'low' | 'none' | 'seed';
  decode: { p25: number | null; median: number; p75: number | null }; prefill: number | null; ttftMs: number | null; decode32k: number | null; decode128k: number | null; peakRamGB: number | null; peakVramGB: number | null }
export interface ArenaGroupSummary { group: string; family: string; quant: string; machines: number; seedMachines: number; configs: number; bestDecode: number; gpus: { gpu: string; vramGB: number; machines: number }[];
  top?: Pick<ArenaRow, 'hw' | 'params' | 'seed' | 'machines' | 'decode'>[] }
export interface ArenaGroups { computedAt: number | null; machines: number; runs: number; groups: ArenaGroupSummary[] }
export interface ArenaLeaderboard extends Partial<Omit<ArenaGroupSummary, 'group'>> { group: string | null; rows: ArenaRow[]; tierMedian: number | null; filter?: { gpu: string | null; vram: number | null } }
export interface ArenaRecommendRow { hw: ArenaRowHardware; params: ArenaParams; seed: boolean; machines: number; confidence: ArenaRow['confidence']; speed: number; decode: ArenaRow['decode']; peakRamGB: number | null; peakVramGB: number | null }
export interface ArenaParamChange { param: keyof ArenaParams; from: unknown; to: unknown; gainPct: number; machines: number; confidence: ArenaRow['confidence']; peakRamGB: number | null }
export interface ArenaRecommendation { scene: 'chat' | 'long' | 'code'; level: 'gpu' | 'vram' | 'none';
  sameModel: { group: string; level: 'gpu' | 'vram' | 'none'; best: ArenaRecommendRow | null; current: ArenaRecommendRow | null; changes: ArenaParamChange[]; alternatives: ArenaRecommendRow[] } | null;
  otherModels: (ArenaRecommendRow & { group: string; family: string; quant: string; level: 'gpu' | 'vram' | 'none' })[] }

// ---- Native state ----
export interface ArenaLogEntry { at: number; kind: 'context' | 'scenario' | 'withdraw'; status: 'queued' | 'uploaded' | 'rejected' | 'retrying' | 'skipped' | 'deleted'; detail?: string; group?: string }
export interface ArenaStatus { consented: boolean; consentVersion: number | null; autoUpload: boolean; queued: number; log: ArenaLogEntry[]; endpoint: string }

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
