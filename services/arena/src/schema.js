// Arena submission schema v1. Every field is whitelisted; unknown keys are rejected rather than dropped,
// so a client that starts sending something new (a path, a hostname) fails loudly instead of leaking.
export const SCHEMA_VERSION = 1;
export const CONSENT_VERSION = 1;
export const MAX_BODY_BYTES = 64 * 1024;

export class ArenaError extends Error {
  constructor(status, code, message) { super(message ? code + ': ' + message : code); this.status = status; this.code = code; }
}
export const bad = (code, message) => { throw new ArenaError(400, code, message); };
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
export function keys(obj, allowed, where) {
  if (!isObj(obj)) bad('invalid_' + where, where + ' must be an object');
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) bad('unknown_field', `${where}.${k} is not allowed`);
}
export const str = (v, re, where, nullable = false) => {
  if (v === null && nullable) return null;
  if (typeof v !== 'string' || !re.test(v)) bad('invalid_' + where, where + ' is invalid');
  return v;
};
export const int = (v, min, max, where, nullable = false) => {
  if (v === null && nullable) return null;
  if (!Number.isSafeInteger(v) || v < min || v > max) bad('invalid_' + where, where + ' out of range');
  return v;
};
export const num = (v, min, max, where, nullable = true) => {
  if (v === null && nullable) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) bad('invalid_' + where, where + ' out of range');
  return Math.round(v * 1000) / 1000;
};
const bool = (v, where) => { if (typeof v !== 'boolean') bad('invalid_' + where, where + ' must be boolean'); return v; };

// Free-text hardware names: letters, digits and a few separators only, so paths (/ \ :), emails (@) and URLs cannot fit.
const NAME = /^[A-Za-z0-9 ()+._-]{1,96}$/;
const TOKEN = /^[A-Za-z0-9_.-]{1,24}$/;

export const TIER_WINDOWS = { k8: [7000, 9500, 8192], k32: [28000, 36000, 32768], k128: [120000, 136000, 131072] };
export function pickTier(tiers, key) {
  const [lo, hi, target] = TIER_WINDOWS[key];
  return tiers.filter(t => t.ok && t.decode !== null && t.ctx >= lo && t.ctx <= hi).sort((a, b) => Math.abs(a.ctx - target) - Math.abs(b.ctx - target))[0] ?? null;
}

/** Validates a parsed body and returns the normalized submission. The install is identified by its signing key, never by the body. Throws ArenaError. */
export function validateSubmission(body) {
  keys(body, ['schema', 'consentVersion', 'evidence', 'evidenceSig', 'app', 'strata', 'kind', 'day', 'hw', 'model', 'params', 'tiers', 'scenario'], 'body');
  if (body.schema !== SCHEMA_VERSION) bad('unsupported_schema');
  int(body.consentVersion, 1, 1000, 'consentVersion');
  if (body.consentVersion < CONSENT_VERSION) bad('consent_outdated', 'consent version is older than the current policy');
  const app = str(body.app, /^\d{1,3}\.\d{1,3}\.\d{1,4}$/, 'app');
  const strata = str(body.strata, /^\d{1,3}\.\d{1,3}\.\d{1,4}(?:\.\d{1,4})?$/, 'strata', true);
  const kind = str(body.kind, /^(?:context|scenario)$/, 'kind');
  const day = str(body.day, /^20\d\d-\d\d-\d\d$/, 'day');

  keys(body.hw, ['os', 'arch', 'cpu', 'ramGB', 'gpus', 'pcie', 'wsl'], 'hw');
  const hw = body.hw;
  const os = str(hw.os, /^(?:windows|linux|macos)$/, 'hw.os');
  const arch = str(hw.arch, /^(?:x86_64|aarch64)$/, 'hw.arch');
  const cpu = str(hw.cpu, NAME, 'hw.cpu');
  const ramGB = int(hw.ramGB, 1, 4096, 'hw.ramGB');
  const pcie = str(hw.pcie, /^Gen[1-7] x(?:1|2|4|8|16)$/, 'hw.pcie', true);
  const wsl = bool(hw.wsl, 'hw.wsl');
  if (!Array.isArray(hw.gpus) || hw.gpus.length > 16) bad('invalid_hw.gpus');
  const gpus = hw.gpus.map((g, i) => {
    keys(g, ['vendor', 'name', 'vramGB'], `hw.gpus[${i}]`);
    return { vendor: str(g.vendor, /^(?:nvidia|amd|intel|apple|other)$/, 'gpu.vendor'), name: str(g.name, NAME, 'gpu.name'), vramGB: int(g.vramGB, 1, 1024, 'gpu.vramGB') };
  });

  keys(body.model, ['family', 'quant', 'sha256', 'sizeGB'], 'model');
  const model = { family: str(body.model.family, /^[a-z0-9-]{1,32}$/, 'model.family'), quant: str(body.model.quant, /^[A-Z0-9_-]{1,16}$/, 'model.quant'),
    sha256: str(body.model.sha256, /^[a-f0-9]{64}$/, 'model.sha256', true), sizeGB: num(body.model.sizeGB, 0.1, 4096, 'model.sizeGB') };

  keys(body.params, ['ctx', 'kv', 'gpuCount', 'parallel', 'poolWorkers', 'expertCache', 'pcieFrac', 'vision'], 'params');
  const p = body.params;
  const params = { ctx: int(p.ctx, 512, 1_048_576, 'params.ctx'), kv: str(p.kv, TOKEN, 'params.kv'), gpuCount: int(p.gpuCount, 0, 16, 'params.gpuCount'),
    parallel: int(p.parallel, 1, 64, 'params.parallel'), poolWorkers: int(p.poolWorkers, 1, 512, 'params.poolWorkers', true),
    expertCache: str(p.expertCache, TOKEN, 'params.expertCache', true), pcieFrac: num(p.pcieFrac, 0, 1, 'params.pcieFrac'), vision: bool(p.vision, 'params.vision') };
  if (params.gpuCount > gpus.length) bad('implausible_gpu_count');

  const vramTotal = gpus.reduce((s, g) => s + g.vramGB, 0);
  let tiers = [], scenario = null;
  if (kind === 'context') {
    if (body.scenario !== undefined && body.scenario !== null) bad('unexpected_scenario');
    if (!Array.isArray(body.tiers) || !body.tiers.length || body.tiers.length > 16) bad('invalid_tiers');
    tiers = body.tiers.map((t, i) => {
      keys(t, ['ctx', 'prefill', 'decode', 'ttftMs', 'peakVramGB', 'peakRamGB', 'ok'], `tiers[${i}]`);
      return { ctx: int(t.ctx, 256, 1_048_576, 'tier.ctx'), prefill: num(t.prefill, 0.5, 200000, 'tier.prefill'), decode: num(t.decode, 0.05, 1000, 'tier.decode'),
        ttftMs: num(t.ttftMs, 1, 7_200_000, 'tier.ttftMs'), peakVramGB: num(t.peakVramGB, 0, 8192, 'tier.peakVramGB'), peakRamGB: num(t.peakRamGB, 0, 8192, 'tier.peakRamGB'), ok: bool(t.ok, 'tier.ok') };
    }).sort((a, b) => a.ctx - b.ctx);
    sanityTiers(tiers, { ramGB, vramTotal, ctx: params.ctx });
  } else {
    if (body.tiers !== undefined && body.tiers !== null) bad('unexpected_tiers');
    keys(body.scenario, ['decode', 'prefill', 'ttftMs', 'maxConcurrency', 'requests', 'failed'], 'scenario');
    const s = body.scenario;
    scenario = { decode: num(s.decode, 0.05, 1000, 'scenario.decode'), prefill: num(s.prefill, 0.5, 200000, 'scenario.prefill'), ttftMs: num(s.ttftMs, 1, 7_200_000, 'scenario.ttftMs'),
      maxConcurrency: int(s.maxConcurrency, 1, 256, 'scenario.maxConcurrency'), requests: int(s.requests, 1, 100000, 'scenario.requests'), failed: int(s.failed, 0, 100000, 'scenario.failed') };
    if (scenario.failed > scenario.requests) bad('implausible_scenario');
  }
  return { app, strata, kind, day, consentVersion: body.consentVersion, hw: { os, arch, cpu, ramGB, pcie, wsl, gpus, vramTotal }, model, params, tiers, scenario };
}

/** Physical-plausibility checks: rejects obviously fabricated or broken measurements. */
export function sanityTiers(tiers, { ramGB, vramTotal, ctx }) {
  const seen = new Set();
  for (const t of tiers) {
    if (seen.has(t.ctx)) bad('duplicate_tier'); seen.add(t.ctx);
    if (t.ctx > ctx * 1.02 + 1024) bad('implausible_tier_ctx', 'tier exceeds the configured context');
    if (t.peakRamGB !== null && t.peakRamGB > ramGB * 1.08 + 1) bad('implausible_ram');
    if (t.peakVramGB !== null && t.peakVramGB > vramTotal * 1.08 + 0.5) bad('implausible_vram');
    if (t.ok && (t.decode === null || t.prefill === null || t.ttftMs === null)) bad('incomplete_tier');
    // First token cannot arrive faster than the prompt is processed: ttft >= tokens / prefill (with generous slack).
    if (t.ok && t.ttftMs < (t.ctx * 0.5) / t.prefill * 1000 * 0.25) bad('implausible_ttft', 'first-token time is faster than the reported prefill allows');
  }
  const ok = tiers.filter(t => t.ok);
  for (let i = 1; i < ok.length; i++) {
    // Longer prompts never make the first token dramatically faster.
    if (ok[i].ttftMs < ok[i - 1].ttftMs * 0.35) bad('implausible_ttft_order');
    if (ok[i].decode > ok[i - 1].decode * 1.6 + 1) bad('implausible_decode_order');
  }
  if (!ok.length) bad('no_successful_tier');
}

/** Coarse buckets used for grouping and "similar hardware" matching. */
export const vramTier = gb => [4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128, 192].find(t => gb <= t + 0.5) ?? 256;
export const ramTier = gb => [8, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512].find(t => gb <= t + 2) ?? 1024;
