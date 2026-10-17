import { hmacHex, signingMessage } from '../src/crypto.js';
export const APP_KEY = 'test-app-key';
export const installId = n => n.toString(16).padStart(64, 'a');
export function submission(over = {}) {
  const decode = over.decode ?? 35.2;
  const base = {
    schema: 1, consentVersion: 1, installId: installId(1), app: '0.1.12', strata: '0.1.44', kind: 'context', day: '2026-10-17',
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
export async function signed(method, path, body, { key = APP_KEY, ts = Date.now(), nonce, ip = '203.0.113.7', headers = {} } = {}) {
  const text = JSON.stringify(body), bytes = new TextEncoder().encode(text);
  nonce ??= (++n).toString(16).padStart(32, '0') + '';
  nonce = nonce.slice(-32).padStart(32, '0');
  const sig = await hmacHex(key, await signingMessage(ts, nonce, bytes));
  return new Request('https://arena.test' + path, { method, body: text, headers: { 'Content-Type': 'application/json', 'X-Arena-Ts': String(ts), 'X-Arena-Nonce': nonce, 'X-Arena-Sig': sig, 'CF-Connecting-IP': ip, ...headers } });
}
