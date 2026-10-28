import { hmacHex, signingMessage, sha256Hex, leadingZeroBits, powMessage } from '../src/crypto.js';
import { evidenceMessage } from '../src/evidence.js';
export const APP_KEY = 'test-app-key';
export const installId = n => n.toString(16).padStart(64, 'a');
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

export function submission(over = {}) {
  const decode = over.decode ?? 35.2;
  const base = {
    schema: 1, consentVersion: 1, app: '0.1.12', strata: '0.1.44', kind: 'context', day: '2026-10-17',
    hw: { os: 'windows', arch: 'x86_64', cpu: 'AMD Ryzen 9 7950X 16-Core Processor', ramGB: 96, gpus: [{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090', vramGB: 24 }], pcie: 'Gen4 x16', wsl: false },
    model: { family: 'swift', quant: 'IQ3_S', sha256: 'f'.repeat(64), sizeGB: 83.6 },
    params: { ctx: 131072, kv: 'int8', gpuCount: 1, parallel: 1, poolWorkers: 16, expertCache: 'auto', pcieFrac: null, vision: false },
    tiers: [
      { ctx: 8192, prefill: 2410, decode, ttftMs: 3400, peakVramGB: 21.4, peakRamGB: 61.5, ok: true },
      { ctx: 32768, prefill: 2180, decode: Math.round(decode * 0.93 * 10) / 10, ttftMs: 14700, peakVramGB: 21.9, peakRamGB: 62.0, ok: true },
      { ctx: 131072, prefill: 1520, decode: Math.round(decode * 0.77 * 10) / 10, ttftMs: 86200, peakVramGB: 22.8, peakRamGB: 63.1, ok: true },
    ],
  };
  const { decode: _d, ...rest } = over;
  return { ...base, ...rest, hw: { ...base.hw, ...(over.hw ?? {}) }, model: { ...base.model, ...(over.model ?? {}) }, params: { ...base.params, ...(over.params ?? {}) } };
}

/**
 * Run evidence consistent with a context submission: one completed request per ok tier, sampled every second,
 * engine counters moving by exactly the reported tokens. `edit(ev)` mutates it for negative tests.
 */
export function evidenceFor(sub, edit = ev => ev) {
  const runs = [];
  let at = 2000;
  for (const t of sub.tiers.filter(t => t.ok)) {
    const promptTokens = Math.round(t.ctx * 0.92), completionTokens = 256;
    const wall = Math.round((t.ttftMs + (completionTokens - 1) / t.decode * 1000) * 1.04);
    runs.push({ ctx: t.ctx, startMs: at, endMs: at + wall, ttftMs: t.ttftMs, promptTokens, cachedTokens: 0, completionTokens, prefill: t.prefill, decode: t.decode, resourceSamples: Math.floor(wall / 1000) + 2 });
    at += wall + 1500;
  }
  const durationMs = at + 500, intervalMs = 1000, stepMs = Math.max(intervalMs, Math.ceil(durationMs / 120 / 1000) * 1000), points = Math.ceil(durationMs / stepMs);
  const vram = Math.max(...sub.tiers.map(t => t.peakVramGB ?? 0)), ram = Math.max(...sub.tiers.map(t => t.peakRamGB ?? 0));
  const sum = k => runs.reduce((n, r) => n + r[k], 0);
  const ev = { v: 1, engine: sub.strata, durationMs, intervalMs, runs,
    series: { count: sum('resourceSamples') + 1, stepMs, vramGB: Array.from({ length: points }, (_, i) => i === points - 2 ? vram : Math.round((vram - 1.5) * 10) / 10),
      ramGB: Array.from({ length: points }, (_, i) => i === points - 2 ? ram : Math.round((ram - 2) * 10) / 10), gpuUtil: Array.from({ length: points }, (_, i) => i ? 86 : 4) },
    counters: { before: { requests: 120, promptTokens: 4_200_000, outputTokens: 61_000 },
      after: { requests: 120 + runs.length, promptTokens: 4_200_000 + sum('promptTokens'), outputTokens: 61_000 + sum('completionTokens') } } };
  return edit(ev) ?? ev;
}

let n = 0;
const nextNonce = () => (++n).toString(16).padStart(32, '0');

/** A desktop install: its own Ed25519 key, registered with proof of work, signing every request. */
export class Install {
  static async create() {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const inst = new Install();
    Object.assign(inst, { privateKey: pair.privateKey, publicKey: hex(raw), keyId: await sha256Hex(raw) });
    return inst;
  }
  /** Body fields carrying signed evidence: the exact text and the install's signature over its digest. */
  async evidence(ev) { const text = JSON.stringify(ev); return { evidence: text, evidenceSig: await this.sign(evidenceMessage(this.keyId, await sha256Hex(text))) }; }
  async sign(message) { return hex(await crypto.subtle.sign({ name: 'Ed25519' }, this.privateKey, new TextEncoder().encode(message))); }
  /** Builds a signed request. `app: false` omits the app HMAC; `install: false` omits the install signature. */
  async request(method, path, body, { appKey = APP_KEY, app = true, install = true, ts = Date.now(), nonce = nextNonce(), ip = '203.0.113.7', headers = {}, signer = this } = {}) {
    const text = JSON.stringify(body), bytes = new TextEncoder().encode(text);
    const message = await signingMessage(ts, nonce, bytes);
    const h = { 'Content-Type': 'application/json', 'X-Arena-Ts': String(ts), 'X-Arena-Nonce': nonce, 'CF-Connecting-IP': ip, ...headers };
    if (app) h['X-Arena-Sig'] = await hmacHex(appKey, message);
    if (install) { h['X-Arena-Key'] = this.keyId; h['X-Arena-Install-Sig'] = await signer.sign(message); }
    return new Request('https://arena.test' + path, { method, body: text, headers: h });
  }
  async solve(challenge, bits) {
    for (let counter = 0; ; counter++) if (leadingZeroBits(await sha256Hex(powMessage(challenge, this.publicKey, counter))) >= bits) return counter;
  }
  async register(call, env, opts = {}) {
    const c = await (await call(env, new Request('https://arena.test/v1/register/challenge', { method: 'POST', headers: { 'CF-Connecting-IP': opts.ip ?? '203.0.113.7' } }))).json();
    const counter = opts.counter ?? await this.solve(c.challenge, c.bits);
    return call(env, await this.request('POST', '/v1/register', { publicKey: this.publicKey, challenge: opts.challenge ?? c.challenge, counter, consentVersion: 1 }, opts));
  }
}

/** An official-method (tools/strata_bench.py) submission; `metrics` overrides single figures. */
export function officialSubmission(over = {}) {
  const { metrics = {}, official = {}, ...rest } = over;
  const base = submission({ kind: 'official', ...rest });
  delete base.tiers;
  return { ...base, official: { upstream: '46c152a1310f', runs: 3, long: true, ...official,
    metrics: { chatDecodeTps: 44.0, chatTtftS: 0.6, p4kTps: 755, p4kTtftS: 5.4, p16kTps: 821, p16kTtftS: 19.6, p32kTps: 700, p32kTtftS: 46.8,
      agentHitPct: 82, agentDecodeTps: 40.1, agentTurnTtftS: 2.9, ...metrics } } };
}

/**
 * Evidence consistent with an official submission: 9 chat requests, 3 per prompt tier and 15 agent follow-up turns,
 * no resource series (the script samples none), counters moving by the reported tokens plus the warm-up.
 */
export function officialEvidenceFor(sub, edit = ev => ev) {
  const m = sub.official.metrics, runs = [];
  let at = 4000;
  const add = (ctx, n, promptTokens, cachedTokens, completionTokens, prefill, decode, ttftS) => {
    for (let i = 0; i < n; i++) {
      const ttftMs = Math.round(ttftS * 1000), wall = Math.round((ttftMs + (completionTokens - 1) / decode * 1000) * 1.04);
      runs.push({ ctx, startMs: at, endMs: at + wall, ttftMs, promptTokens, cachedTokens, completionTokens, prefill, decode, resourceSamples: 0 });
      at += wall + 200;
    }
  };
  add(512, 9, 40, 0, 100, 300, m.chatDecodeTps, m.chatTtftS);
  if (m.p4kTps !== null) add(4096, 3, 4000, 0, 24, m.p4kTps, 40, m.p4kTtftS);
  if (m.p16kTps !== null) add(16384, 3, 16000, 0, 24, m.p16kTps, 38, m.p16kTtftS);
  if (m.agentDecodeTps !== null) add(65536, 15, 4000, Math.round(4000 * m.agentHitPct / 100), 64, 250, m.agentDecodeTps, m.agentTurnTtftS);
  if (m.p32kTps !== null) add(32768, 3, 32000, 0, 24, m.p32kTps, 35, m.p32kTtftS);
  const durationMs = at + 500, stepMs = Math.max(1000, Math.ceil(durationMs / 120 / 1000) * 1000), points = Math.ceil(durationMs / stepMs);
  const sum = k => runs.reduce((n, r) => n + r[k], 0), empty = () => Array(points).fill(null);
  const ev = { v: 1, engine: sub.strata, durationMs, intervalMs: 1000, runs, series: { count: 0, stepMs, vramGB: empty(), ramGB: empty(), gpuUtil: empty() },
    counters: { before: { requests: 40, promptTokens: 900_000, outputTokens: 20_000 },
      after: { requests: 40 + runs.length + 7, promptTokens: 900_000 + sum('promptTokens') + 3000, outputTokens: 20_000 + sum('completionTokens') + 30 } } };
  return edit(ev) ?? ev;
}
