import { ArenaError, MAX_BODY_BYTES, validateSubmission, pickTier, CONSENT_VERSION, SCHEMA_VERSION } from './schema.js';
import { aggregate, filterRows, recommend } from './stats.js';
import { sha256Hex, hmacHex, safeEqual, signingMessage } from './crypto.js';

const DAY = 86_400_000;
export const RETENTION_MS = 365 * DAY;
export const LIMITS = { installPerDay: 30, ipPerDay: 120, deletePerDay: 10 };
const SIG_WINDOW_MS = 10 * 60_000;

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' };
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...extra } });
const fail = e => e instanceof ArenaError ? json({ error: e.code, message: e.message }, e.status) : (console.error(e), json({ error: 'internal' }, 500));

async function readBody(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY_BYTES) throw new ArenaError(413, 'too_large');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BODY_BYTES) throw new ArenaError(413, 'too_large');
  let body; try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ArenaError(400, 'invalid_json'); }
  return { bytes, body };
}

/** Verifies the app HMAC (X-Arena-Ts / X-Arena-Nonce / X-Arena-Sig) and rejects replays. */
async function verifySignature(env, request, bytes, now) {
  const ts = Number(request.headers.get('X-Arena-Ts')), nonce = request.headers.get('X-Arena-Nonce') ?? '', sig = request.headers.get('X-Arena-Sig') ?? '';
  if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > SIG_WINDOW_MS) throw new ArenaError(401, 'stale_signature');
  if (!/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(sig)) throw new ArenaError(401, 'invalid_signature');
  const keys = String(env.ARENA_APP_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
  if (!keys.length) throw new ArenaError(503, 'not_configured');
  const message = await signingMessage(ts, nonce, bytes);
  let ok = false; for (const k of keys) if (safeEqual(await hmacHex(k, message), sig)) ok = true;
  if (!ok) throw new ArenaError(401, 'invalid_signature');
  const r = await env.DB.prepare('INSERT OR IGNORE INTO nonces (nonce, seen_at) VALUES (?, ?)').bind(nonce, now).run();
  if (!r.meta?.changes) throw new ArenaError(409, 'replay');
}

/** Counts per day. The IP is only ever used as HMAC(IP_SALT, day + ip) and the counter row is purged after two days. */
async function rateLimit(env, request, installHash, now, perInstall, kind) {
  const day = new Date(now).toISOString().slice(0, 10);
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipKey = ip ? 'ip:' + kind + ':' + (await hmacHex(String(env.IP_SALT || 'unset'), day + '|' + ip)).slice(0, 32) : null;
  const keys = [['in:' + kind + ':' + installHash.slice(0, 32), perInstall], ...(ipKey ? [[ipKey, LIMITS.ipPerDay]] : [])];
  for (const [key, limit] of keys) {
    const row = await env.DB.prepare('INSERT INTO rate_limits (key, window, count) VALUES (?, ?, 1) ON CONFLICT(key, window) DO UPDATE SET count = count + 1 RETURNING count').bind(key, day).first();
    if ((row?.count ?? 0) > limit) throw new ArenaError(429, 'rate_limited');
  }
}

async function submit(request, env, now) {
  const { bytes, body } = await readBody(request);
  await verifySignature(env, request, bytes, now);
  const s = validateSubmission(body);
  const installHash = await sha256Hex('arena-install|' + body.installId);
  await rateLimit(env, request, installHash, now, LIMITS.installPerDay, 'submit');
  const seedToken = request.headers.get('X-Arena-Seed');
  const seed = !!(seedToken && env.SEED_TOKEN && safeEqual(await sha256Hex(seedToken), await sha256Hex(env.SEED_TOKEN)));
  const k8 = s.kind === 'context' ? pickTier(s.tiers, 'k8') : null, k32 = s.kind === 'context' ? pickTier(s.tiers, 'k32') : null, k128 = s.kind === 'context' ? pickTier(s.tiers, 'k128') : null;
  const maxOf = key => { if (s.kind !== 'context') return null; const v = s.tiers.map(t => t[key]).filter(x => x !== null); return v.length ? Math.max(...v) : null; };
  const primary = [...s.hw.gpus].sort((a, b) => b.vramGB - a.vramGB)[0];
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO submissions (id, install_hash, received_at, day, schema_version, consent_version, app_version, strata_version, kind, os, arch, cpu, ram_gb, wsl,
    gpu_vendor, gpu_name, gpu_count, vram_gb, pcie, family, quant, model_sha256, model_size_gb, ctx, kv, parallel, pool_workers, expert_cache, pcie_frac, vision,
    decode_8k, prefill_8k, ttft_8k_ms, decode_32k, decode_128k, peak_vram_gb, peak_ram_gb, result_json, seed)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id, installHash, now, s.day, SCHEMA_VERSION, s.consentVersion, s.app, s.strata, s.kind, s.hw.os, s.hw.arch, s.hw.cpu, s.hw.ramGB, s.hw.wsl ? 1 : 0,
    primary?.vendor ?? null, primary?.name ?? null, s.params.gpuCount, primary?.vramGB ?? 0, s.hw.pcie, s.model.family, s.model.quant, s.model.sha256, s.model.sizeGB,
    s.params.ctx, s.params.kv, s.params.parallel, s.params.poolWorkers, s.params.expertCache, s.params.pcieFrac, s.params.vision ? 1 : 0,
    k8?.decode ?? null, k8?.prefill ?? null, k8?.ttftMs ?? null, k32?.decode ?? null, k128?.decode ?? null, maxOf('peakVramGB'), maxOf('peakRamGB'),
    JSON.stringify(s.kind === 'context' ? { tiers: s.tiers } : { scenario: s.scenario }), seed ? 1 : 0).run();
  return json({ accepted: true, id, ranked: !!k8, seed }, 201);
}

async function deleteMine(request, env, now) {
  const { bytes, body } = await readBody(request);
  await verifySignature(env, request, bytes, now);
  if (!body || typeof body !== 'object' || Object.keys(body).join() !== 'installId' || !/^[a-f0-9]{64}$/.test(body.installId)) throw new ArenaError(400, 'invalid_installId');
  const installHash = await sha256Hex('arena-install|' + body.installId);
  await rateLimit(env, request, installHash, now, LIMITS.deletePerDay, 'delete');
  const r = await env.DB.prepare('DELETE FROM submissions WHERE install_hash = ?').bind(installHash).run();
  await env.DB.prepare('DELETE FROM rate_limits WHERE key LIKE ?').bind('in:submit:' + installHash.slice(0, 32)).run();
  return json({ deleted: r.meta?.changes ?? 0 });
}

export async function recompute(env, now = Date.now()) {
  const { results } = await env.DB.prepare(`SELECT install_hash, received_at, family, quant, gpu_name, gpu_count, vram_gb, ram_gb, ctx, kv, parallel, pool_workers, expert_cache, pcie_frac, vision,
    decode_8k, prefill_8k, ttft_8k_ms, decode_32k, decode_128k, peak_vram_gb, peak_ram_gb, seed FROM submissions
    WHERE kind = 'context' AND hidden = 0 AND decode_8k IS NOT NULL AND received_at >= ?`).bind(now - RETENTION_MS).all();
  const groups = aggregate(results);
  const totals = await env.DB.prepare(`SELECT COUNT(DISTINCT install_hash) AS machines, COUNT(*) AS runs FROM submissions WHERE hidden = 0 AND seed = 0 AND received_at >= ?`).bind(now - RETENTION_MS).first();
  const summary = { computedAt: now, machines: totals?.machines ?? 0, runs: totals?.runs ?? 0,
    groups: groups.map(({ rows, ...g }) => ({ ...g, top: rows.slice(0, 3).map(r => ({ hw: r.hw, params: r.params, seed: r.seed, machines: r.machines, decode: r.decode })) })) };
  const stmts = [env.DB.prepare('DELETE FROM aggregates'), env.DB.prepare('INSERT INTO aggregates (key, json, computed_at) VALUES (?, ?, ?)').bind('groups', JSON.stringify(summary), now),
    env.DB.prepare('INSERT INTO aggregates (key, json, computed_at) VALUES (?, ?, ?)').bind('all', JSON.stringify(groups), now)];
  await env.DB.batch(stmts);
  return summary;
}

export async function maintain(env, now = Date.now()) {
  const day = new Date(now - 2 * DAY).toISOString().slice(0, 10);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM submissions WHERE received_at < ?').bind(now - RETENTION_MS),
    env.DB.prepare('DELETE FROM rate_limits WHERE window < ?').bind(day),
    env.DB.prepare('DELETE FROM nonces WHERE seen_at < ?').bind(now - DAY),
  ]);
  return recompute(env, now);
}

async function cached(env, key) {
  const row = await env.DB.prepare('SELECT json, computed_at FROM aggregates WHERE key = ?').bind(key).first();
  return row ? JSON.parse(row.json) : null;
}
const PUBLIC_CACHE = { ...CORS, 'Cache-Control': 'public, max-age=300' };

async function route(request, env, ctx, now) {
  const url = new URL(request.url), path = url.pathname;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (path === '/v1/health' && request.method === 'GET') return json({ ok: true, schema: SCHEMA_VERSION, consentVersion: CONSENT_VERSION }, 200, CORS);
  if (path === '/v1/submit') { if (request.method !== 'POST') throw new ArenaError(405, 'method_not_allowed'); return submit(request, env, now); }
  if (path === '/v1/me') { if (request.method !== 'DELETE') throw new ArenaError(405, 'method_not_allowed'); return deleteMine(request, env, now); }
  if (request.method !== 'GET') throw new ArenaError(405, 'method_not_allowed');
  if (path === '/v1/groups') return json(await cached(env, 'groups') ?? { computedAt: null, machines: 0, runs: 0, groups: [] }, 200, PUBLIC_CACHE);
  if (path === '/v1/leaderboard') {
    const all = await cached(env, 'all') ?? [];
    const key = url.searchParams.get('group') ?? all[0]?.group;
    const group = all.find(g => g.group === key);
    if (!group) return json({ group: key ?? null, rows: [], gpus: [], tierMedian: null }, 200, PUBLIC_CACHE);
    const gpu = url.searchParams.get('gpu') || undefined, vram = url.searchParams.get('vram') || undefined;
    const { rows, ...g } = group;
    return json({ ...g, filter: { gpu: gpu ?? null, vram: vram ? Number(vram) : null }, ...filterRows(group, { gpu, vram }) }, 200, PUBLIC_CACHE);
  }
  if (path === '/v1/recommend') {
    const p = url.searchParams, n = k => { const v = Number(p.get(k)); return p.has(k) && Number.isFinite(v) ? v : undefined; };
    const params = {}; for (const k of ['ctx', 'parallel', 'poolWorkers', 'gpuCount']) if (n(k) !== undefined) params[k] = n(k);
    for (const k of ['kv', 'expertCache']) if (p.get(k)) params[k] = p.get(k);
    if (p.has('pcieFrac')) params.pcieFrac = n('pcieFrac') ?? null;
    const all = await cached(env, 'all') ?? [];
    return json(recommend(all, { gpu: p.get('gpu') || undefined, vramGB: n('vram'), ramGB: n('ram'), family: p.get('family') || undefined, quant: p.get('quant') || undefined,
      scene: p.get('scene') || 'chat', params: Object.keys(params).length ? params : undefined }), 200, PUBLIC_CACHE);
  }
  throw new ArenaError(404, 'not_found');
}

export default {
  async fetch(request, env, ctx) { try { return await route(request, env, ctx, Date.now()); } catch (e) { return fail(e); } },
  async scheduled(event, env, ctx) { ctx.waitUntil(maintain(env)); },
};
export { route };
