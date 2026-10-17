import { hmacHex, signingMessage, sha256Hex, leadingZeroBits, powMessage } from '../src/crypto.js';
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
