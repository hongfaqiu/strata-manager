import { ArenaError, MAX_BODY_BYTES, validateSubmission, pickTier, CONSENT_VERSION, SCHEMA_VERSION } from './schema.js';
import { aggregate, facetOptions, filterRows, FILTER_KEYS, recommend } from './stats.js';
import { evaluate } from './trust.js';
import { parseEvidence, checkEvidence, evidenceMessage } from './evidence.js';
import { sha256Hex, hmacHex, safeEqual, signingMessage, verifyEd25519, hexToBytes, leadingZeroBits, powMessage } from './crypto.js';
import { isApiPath, serveSite } from './site.js';

const DAY = 86_400_000;
export const RETENTION_MS = 365 * DAY;
export const LIMITS = { installPerDay: 30, ipPerDay: 120, deletePerDay: 10, registerPerIpDay: 10, challengePerIpDay: 60 };
const SIG_WINDOW_MS = 10 * 60_000;
const CHALLENGE_TTL_MS = 10 * 60_000;
/** Default proof-of-work difficulty (leading zero bits of SHA-256). Override with the POW_BITS variable. */
export const DEFAULT_POW_BITS = 22;
const HEX64 = /^[a-f0-9]{64}$/;

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' };
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...extra } });
const fail = e => e instanceof ArenaError ? json({ error: e.code, message: e.message }, e.status) : (console.error(e), json({ error: 'internal' }, 500));
const NO_STORE = { 'Cache-Control': 'no-store' };

async function readBody(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY_BYTES) throw new ArenaError(413, 'too_large');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BODY_BYTES) throw new ArenaError(413, 'too_large');
  let body; try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ArenaError(400, 'invalid_json'); }
  return { bytes, body };
}

/** Timestamp + nonce + body digest: the message both the app key (HMAC) and the install key (Ed25519) sign. */
async function signedMessage(request, bytes, now) {
  const ts = Number(request.headers.get('X-Arena-Ts')), nonce = request.headers.get('X-Arena-Nonce') ?? '';
  if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > SIG_WINDOW_MS) throw new ArenaError(401, 'stale_signature');
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new ArenaError(401, 'invalid_signature');
  return { nonce, message: await signingMessage(ts, nonce, bytes) };
}
/** App-build HMAC (X-Arena-Sig). ARENA_APP_KEYS may list several keys during a rotation. */
async function verifyAppKey(env, request, message) {
  const sig = request.headers.get('X-Arena-Sig') ?? '';
  if (!HEX64.test(sig)) throw new ArenaError(401, 'invalid_signature');
  const keys = String(env.ARENA_APP_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
  if (!keys.length) throw new ArenaError(503, 'not_configured');
  let ok = false; for (const k of keys) if (safeEqual(await hmacHex(k, message), sig)) ok = true;
  if (!ok) throw new ArenaError(401, 'invalid_signature');
}
/** Install signature (X-Arena-Install-Sig) with the registered key named by X-Arena-Key. */
async function verifyInstall(env, request, message, { allowBanned = false } = {}) {
  const keyId = request.headers.get('X-Arena-Key') ?? '', sig = request.headers.get('X-Arena-Install-Sig') ?? '';
  if (!HEX64.test(keyId) || !/^[a-f0-9]{128}$/.test(sig)) throw new ArenaError(401, 'invalid_install_signature');
  const install = await env.DB.prepare('SELECT key_id, public_key, override, status FROM installs WHERE key_id = ?').bind(keyId).first();
  if (!install) throw new ArenaError(401, 'unregistered');
  if (!(await verifyEd25519(install.public_key, sig, message))) throw new ArenaError(401, 'invalid_install_signature');
  if (install.override === 'ban' && !allowBanned) throw new ArenaError(403, 'banned');
  return install;
}
async function consumeNonce(env, nonce, now) {
  const r = await env.DB.prepare('INSERT OR IGNORE INTO nonces (nonce, seen_at) VALUES (?, ?)').bind(nonce, now).run();
  if (!r.meta?.changes) throw new ArenaError(409, 'replay');
}

const ipOf = request => request.headers.get('CF-Connecting-IP') || '';
/** Daily counters. The IP is only ever used as HMAC(IP_SALT, day + ip); counter rows are purged after two days. */
async function bump(env, now, entries) {
  const day = new Date(now).toISOString().slice(0, 10);
  for (const [key, limit] of entries) {
    const row = await env.DB.prepare('INSERT INTO rate_limits (key, window, count) VALUES (?, ?, 1) ON CONFLICT(key, window) DO UPDATE SET count = count + 1 RETURNING count').bind(key, day).first();
    if ((row?.count ?? 0) > limit) throw new ArenaError(429, 'rate_limited');
  }
}
async function ipKey(env, request, now, kind) {
  const ip = ipOf(request); if (!ip) return null;
  const day = new Date(now).toISOString().slice(0, 10);
  return 'ip:' + kind + ':' + (await hmacHex(String(env.IP_SALT || 'unset'), day + '|' + ip)).slice(0, 32);
}
async function rateLimit(env, request, keyId, now, perInstall, kind) {
  const ip = await ipKey(env, request, now, kind);
  await bump(env, now, [['in:' + kind + ':' + keyId.slice(0, 32), perInstall], ...(ip ? [[ip, LIMITS.ipPerDay]] : [])]);
}

// ---------- registration: proof of work + app key + proof of possession ----------
/** Current difficulty: POW_BITS (default 22), two bits harder while registrations surge past POW_SURGE per hour. */
export async function powBits(env, now) {
  const base = Math.min(32, Math.max(8, Number(env.POW_BITS) || DEFAULT_POW_BITS));
  const surge = Number(env.POW_SURGE) || 30;
  const recent = (await env.DB.prepare('SELECT COUNT(*) AS n FROM installs WHERE registered_at >= ?').bind(now - 3_600_000).first())?.n ?? 0;
  return { bits: recent > surge ? Math.min(32, base + 2) : base, recent };
}
const challengeMac = (env, payload) => {
  if (!env.POW_SECRET) throw new ArenaError(503, 'not_configured');
  return hmacHex(String(env.POW_SECRET), 'challenge|' + payload).then(h => h.slice(0, 32));
};
async function issueChallenge(request, env, now) {
  const ip = await ipKey(env, request, now, 'challenge');
  if (ip) await bump(env, now, [[ip, LIMITS.challengePerIpDay]]);
  const { bits } = await powBits(env, now);
  const rand = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  const payload = `${now}.${rand}.${bits}`;
  return json({ challenge: `${payload}.${await challengeMac(env, payload)}`, bits, expiresAt: now + CHALLENGE_TTL_MS }, 200, NO_STORE);
}
async function register(request, env, now) {
  const { bytes, body } = await readBody(request);
  const { nonce, message } = await signedMessage(request, bytes, now);
  await verifyAppKey(env, request, message);
  if (!body || typeof body !== 'object' || Object.keys(body).sort().join() !== 'challenge,consentVersion,counter,publicKey') throw new ArenaError(400, 'invalid_register');
  const { publicKey, challenge, counter, consentVersion } = body;
  if (!HEX64.test(publicKey) || typeof challenge !== 'string' || !Number.isSafeInteger(counter) || counter < 0) throw new ArenaError(400, 'invalid_register');
  if (!Number.isSafeInteger(consentVersion) || consentVersion < CONSENT_VERSION) throw new ArenaError(400, 'consent_outdated');
  const m = /^(\d{13})\.([a-f0-9]{32})\.(\d{1,2})\.([a-f0-9]{32})$/.exec(challenge);
  if (!m || !safeEqual(await challengeMac(env, `${m[1]}.${m[2]}.${m[3]}`), m[4])) throw new ArenaError(400, 'invalid_challenge');
  if (now - Number(m[1]) > CHALLENGE_TTL_MS || Number(m[1]) > now + 60_000) throw new ArenaError(400, 'challenge_expired');
  const bits = Number(m[3]);
  if (leadingZeroBits(await sha256Hex(powMessage(challenge, publicKey, counter))) < bits) throw new ArenaError(400, 'insufficient_work');
  // Proof of possession: the request itself is signed with the key being registered.
  const sig = request.headers.get('X-Arena-Install-Sig') ?? '';
  if (!/^[a-f0-9]{128}$/.test(sig) || !(await verifyEd25519(publicKey, sig, message))) throw new ArenaError(401, 'invalid_install_signature');
  await consumeNonce(env, nonce, now);
  await consumeNonce(env, 'pow:' + m[2], now);
  const keyId = await sha256Hex(hexToBytes(publicKey));
  const existing = await env.DB.prepare('SELECT override, status FROM installs WHERE key_id = ?').bind(keyId).first();
  if (existing?.override === 'ban') throw new ArenaError(403, 'banned');
  if (existing) return json({ keyId, status: existing.status, registered: false }, 200);
  const ip = await ipKey(env, request, now, 'register');
  if (ip) await bump(env, now, [[ip, LIMITS.registerPerIpDay]]);
  await env.DB.prepare('INSERT INTO installs (key_id, public_key, registered_at, last_seen_at, pow_bits, status) VALUES (?, ?, ?, ?, ?, ?)').bind(keyId, publicKey, now, now, bits, 'pending').run();
  return json({ keyId, status: 'pending', registered: true }, 201);
}

// ---------- submissions ----------
async function submit(request, env, now) {
  const { bytes, body } = await readBody(request);
  const { nonce, message } = await signedMessage(request, bytes, now);
  await verifyAppKey(env, request, message);
  const install = await verifyInstall(env, request, message);
  await consumeNonce(env, nonce, now);
  const s = validateSubmission(body);
  const keyId = install.key_id;
  await rateLimit(env, request, keyId, now, LIMITS.installPerDay, 'submit');
  // Run evidence, signed by the install key over its exact text, then checked for internal consistency.
  let evidence = { status: 'missing', reason: null, text: null, sig: null };
  if (body.evidence !== undefined && body.evidence !== null) {
    if (typeof body.evidenceSig !== 'string' || !/^[a-f0-9]{128}$/.test(body.evidenceSig)
      || !(await verifyEd25519(install.public_key, body.evidenceSig, evidenceMessage(keyId, await sha256Hex(String(body.evidence)))))) throw new ArenaError(400, 'invalid_evidence_signature');
    const verdict = checkEvidence(s, parseEvidence(body.evidence));
    evidence = { status: verdict.status, reason: verdict.reasons.join(',').slice(0, 240) || null, text: body.evidence, sig: body.evidenceSig };
  } else if (body.evidenceSig !== undefined) throw new ArenaError(400, 'invalid_evidence_signature');
  const seedToken = request.headers.get('X-Arena-Seed');
  const seed = !!(seedToken && env.SEED_TOKEN && safeEqual(await sha256Hex(seedToken), await sha256Hex(env.SEED_TOKEN)));
  const k8 = s.kind === 'context' ? pickTier(s.tiers, 'k8') : null, k32 = s.kind === 'context' ? pickTier(s.tiers, 'k32') : null, k128 = s.kind === 'context' ? pickTier(s.tiers, 'k128') : null;
  const maxOf = key => { if (s.kind !== 'context') return null; const v = s.tiers.map(t => t[key]).filter(x => x !== null); return v.length ? Math.max(...v) : null; };
  const primary = [...s.hw.gpus].sort((a, b) => b.vramGB - a.vramGB)[0];
  const id = crypto.randomUUID();
  await env.DB.batch([env.DB.prepare(`INSERT INTO submissions (id, install_hash, received_at, day, schema_version, consent_version, app_version, strata_version, kind, os, arch, cpu, ram_gb, wsl,
    gpu_vendor, gpu_name, gpu_count, vram_gb, pcie, family, quant, model_sha256, model_size_gb, ctx, kv, parallel, pool_workers, expert_cache, pcie_frac, vision,
    decode_8k, prefill_8k, ttft_8k_ms, decode_32k, decode_128k, peak_vram_gb, peak_ram_gb, result_json, seed, evidence_status, evidence_reason, evidence_json, evidence_sig)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id, keyId, now, s.day, SCHEMA_VERSION, s.consentVersion, s.app, s.strata, s.kind, s.hw.os, s.hw.arch, s.hw.cpu, s.hw.ramGB, s.hw.wsl ? 1 : 0,
    primary?.vendor ?? null, primary?.name ?? null, s.params.gpuCount, primary?.vramGB ?? 0, s.hw.pcie, s.model.family, s.model.quant, s.model.sha256, s.model.sizeGB,
    s.params.ctx, s.params.kv, s.params.parallel, s.params.poolWorkers, s.params.expertCache, s.params.pcieFrac, s.params.vision ? 1 : 0,
    k8?.decode ?? null, k8?.prefill ?? null, k8?.ttftMs ?? null, k32?.decode ?? null, k128?.decode ?? null, maxOf('peakVramGB'), maxOf('peakRamGB'),
    JSON.stringify(s.kind === 'context' ? { tiers: s.tiers } : { scenario: s.scenario }), seed ? 1 : 0, evidence.status, evidence.reason, evidence.text, evidence.sig),
    env.DB.prepare('UPDATE installs SET last_seen_at = ? WHERE key_id = ?').bind(now, keyId)]);
  // A verified run counts right away: rebuild the aggregates now instead of waiting for the hourly cron.
  let counted = false;
  if (k8) {
    await recompute(env, now);
    const row = await env.DB.prepare('SELECT s.flag, i.status FROM submissions s JOIN installs i ON i.key_id = s.install_hash WHERE s.id = ?').bind(id).first();
    counted = !row?.flag && !['banned', 'flagged'].includes(row?.status) && (evidence.status === 'verified' || seed || row?.status === 'trusted');
  }
  return json({ accepted: true, id, ranked: !!k8, seed, evidence: evidence.status, reasons: evidence.reason ? evidence.reason.split(',') : [], counted }, 201);
}

/** Withdraw: deletes every submission and the key registration. A banned key keeps only a tombstone (key_id + ban). */
async function deleteMine(request, env, now) {
  const { bytes, body } = await readBody(request);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new ArenaError(400, 'invalid_body');
  const { nonce, message } = await signedMessage(request, bytes, now);
  const install = await verifyInstall(env, request, message, { allowBanned: true });
  await consumeNonce(env, nonce, now);
  await rateLimit(env, request, install.key_id, now, LIMITS.deletePerDay, 'delete');
  const r = await env.DB.prepare('DELETE FROM submissions WHERE install_hash = ?').bind(install.key_id).run();
  await env.DB.batch([
    install.override === 'ban'
      ? env.DB.prepare("UPDATE installs SET public_key = '', runs = 0, days = 0, flagged = 0, consistent = 0, compared = 0, corroborated = 0 WHERE key_id = ?").bind(install.key_id)
      : env.DB.prepare('DELETE FROM installs WHERE key_id = ?').bind(install.key_id),
    env.DB.prepare('DELETE FROM rate_limits WHERE key LIKE ?').bind('in:submit:' + install.key_id.slice(0, 32)),
  ]);
  // Withdrawn runs leave the public aggregates right away as well.
  if (r.meta?.changes) await recompute(env, now);
  return json({ deleted: r.meta?.changes ?? 0, unregistered: true });
}

// ---------- aggregates ----------
const SUB_COLUMNS = `id, install_hash, kind, received_at, family, quant, gpu_name, gpu_count, vram_gb, ram_gb, ctx, kv, parallel, pool_workers, expert_cache, pcie_frac, vision,
  decode_8k, prefill_8k, ttft_8k_ms, decode_32k, decode_128k, peak_vram_gb, peak_ram_gb, seed, flag, evidence_status`;
async function inChunks(env, stmts, size = 90) { for (let i = 0; i < stmts.length; i += size) await env.DB.batch(stmts.slice(i, i + size)); }

/** Reputation pass, then aggregates from counting runs only: verified evidence (or maintainer trust), unflagged; seed rows always count. */
export async function recompute(env, now = Date.now()) {
  const { results: installs } = await env.DB.prepare('SELECT key_id, override, status, trust, runs, days, flagged, consistent, compared, corroborated FROM installs').all();
  const { results: subs } = await env.DB.prepare(`SELECT ${SUB_COLUMNS} FROM submissions WHERE hidden = 0 AND received_at >= ?`).bind(now - RETENTION_MS).all();
  const { installs: verdicts, flags, counts } = evaluate(installs, subs);
  const updates = [];
  for (const inst of installs) {
    const v = verdicts.get(inst.key_id);
    updates.push(env.DB.prepare('UPDATE installs SET status = ?, trust = ?, runs = ?, verified = ?, days = ?, flagged = ?, consistent = ?, compared = ?, corroborated = ?, computed_at = ? WHERE key_id = ?')
      .bind(v.status, v.trust, v.runs, v.verified, v.days, v.flagged, v.consistent, v.compared, v.corroborated, now, inst.key_id));
  }
  for (const s of subs) { const f = flags.get(s.id) ?? null; if (f !== (s.flag ?? null)) updates.push(env.DB.prepare('UPDATE submissions SET flag = ? WHERE id = ?').bind(f, s.id)); }
  await inChunks(env, updates);

  const counting = subs.filter(s => counts(s));
  const groups = aggregate(counting.filter(s => s.kind === 'context' && s.decode_8k !== null));
  const publicInstalls = new Set(counting.filter(s => !s.seed).map(s => s.install_hash));
  const pending = new Set(subs.filter(s => !s.seed && !publicInstalls.has(s.install_hash)).map(s => s.install_hash));
  const summary = { computedAt: now, machines: publicInstalls.size, runs: counting.filter(s => !s.seed).length, pendingMachines: pending.size,
    groups: groups.map(({ rows, ...g }) => ({ ...g, top: rows.slice(0, 3).map(r => ({ hw: r.hw, params: r.params, seed: r.seed, machines: r.machines, decode: r.decode })) })) };
  await env.DB.batch([env.DB.prepare('DELETE FROM aggregates'), env.DB.prepare('INSERT INTO aggregates (key, json, computed_at) VALUES (?, ?, ?)').bind('groups', JSON.stringify(summary), now),
    env.DB.prepare('INSERT INTO aggregates (key, json, computed_at) VALUES (?, ?, ?)').bind('all', JSON.stringify(groups), now)]);
  return summary;
}

export async function maintain(env, now = Date.now()) {
  const day = new Date(now - 2 * DAY).toISOString().slice(0, 10);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM submissions WHERE received_at < ?').bind(now - RETENTION_MS),
    env.DB.prepare("DELETE FROM installs WHERE last_seen_at < ? AND (override IS NULL OR override != 'ban')").bind(now - RETENTION_MS),
    env.DB.prepare('DELETE FROM rate_limits WHERE window < ?').bind(day),
    env.DB.prepare('DELETE FROM nonces WHERE seen_at < ?').bind(now - DAY),
  ]);
  return recompute(env, now);
}

async function cached(env, key) {
  const row = await env.DB.prepare('SELECT json, computed_at FROM aggregates WHERE key = ?').bind(key).first();
  return row ? JSON.parse(row.json) : null;
}
const PUBLIC_CACHE = { ...CORS, 'Cache-Control': 'public, max-age=60' };

// ---------- maintainer ----------
async function requireAdmin(request, env) {
  const auth = request.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!env.ADMIN_TOKEN) throw new ArenaError(503, 'not_configured');
  if (!token || !safeEqual(await sha256Hex(token), await sha256Hex(String(env.ADMIN_TOKEN)))) throw new ArenaError(401, 'unauthorized');
}
const installView = i => ({ keyId: i.key_id, status: i.status, trust: i.trust, override: i.override, runs: i.runs, verified: i.verified, days: i.days, flagged: i.flagged,
  consistent: i.consistent, compared: i.compared, corroborated: i.corroborated, registeredAt: i.registered_at, lastSeenAt: i.last_seen_at, powBits: i.pow_bits });
async function admin(request, env, now, path) {
  await requireAdmin(request, env);
  const url = new URL(request.url);
  if (path === '/v1/admin/installs' && request.method === 'GET') {
    const status = url.searchParams.get('status'), limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    const { results } = status
      ? await env.DB.prepare('SELECT * FROM installs WHERE status = ? ORDER BY last_seen_at DESC LIMIT ?').bind(status, limit).all()
      : await env.DB.prepare('SELECT * FROM installs ORDER BY last_seen_at DESC LIMIT ?').bind(limit).all();
    // Overview counts: installs per status and runs per evidence status.
    const { results: byStatus } = await env.DB.prepare('SELECT status, COUNT(*) AS n FROM installs GROUP BY status').all();
    const { results: byEvidence } = await env.DB.prepare('SELECT evidence_status, COUNT(*) AS n FROM submissions WHERE hidden = 0 GROUP BY evidence_status').all();
    return json({ pow: await powBits(env, now), counts: { installs: Object.fromEntries(byStatus.map(r => [r.status, r.n])), runs: Object.fromEntries(byEvidence.map(r => [r.evidence_status, r.n])) },
      installs: results.map(installView) }, 200, NO_STORE);
  }
  const inst = /^\/v1\/admin\/installs\/([a-f0-9]{64})$/.exec(path);
  if (inst && request.method === 'GET') {
    const row = await env.DB.prepare('SELECT * FROM installs WHERE key_id = ?').bind(inst[1]).first();
    if (!row) throw new ArenaError(404, 'not_found');
    const { results } = await env.DB.prepare(`SELECT id, received_at, kind, family, quant, gpu_name, vram_gb, ram_gb, ctx, kv, parallel, pool_workers, gpu_count, decode_8k, prefill_8k, ttft_8k_ms, flag, hidden, seed, evidence_status, evidence_reason
      FROM submissions WHERE install_hash = ? ORDER BY received_at DESC LIMIT 200`).bind(inst[1]).all();
    return json({ install: installView(row), submissions: results }, 200, NO_STORE);
  }
  if (inst && request.method === 'POST') {
    const { body } = await readBody(request);
    const override = { ban: 'ban', trust: 'trust', unban: null, reset: null }[body?.action];
    if (override === undefined) throw new ArenaError(400, 'invalid_action');
    const r = await env.DB.prepare('UPDATE installs SET override = ? WHERE key_id = ?').bind(override, inst[1]).run();
    if (!r.meta?.changes) throw new ArenaError(404, 'not_found');
    await recompute(env, now);
    return json(installView(await env.DB.prepare('SELECT * FROM installs WHERE key_id = ?').bind(inst[1]).first()), 200, NO_STORE);
  }
  const sub = /^\/v1\/admin\/submissions\/([a-f0-9-]{36})$/.exec(path);
  if (sub && request.method === 'GET') {
    // Full audit view: the stored signed evidence can be re-verified against the install's public key.
    const row = await env.DB.prepare(`SELECT s.id, s.install_hash AS keyId, s.received_at, s.kind, s.family, s.quant, s.result_json, s.flag, s.hidden, s.seed,
      s.evidence_status, s.evidence_reason, s.evidence_json, s.evidence_sig, i.public_key FROM submissions s LEFT JOIN installs i ON i.key_id = s.install_hash WHERE s.id = ?`).bind(sub[1]).first();
    if (!row) throw new ArenaError(404, 'not_found');
    return json(row, 200, NO_STORE);
  }
  if (sub && request.method === 'POST') {
    const { body } = await readBody(request);
    if (typeof body?.hidden !== 'boolean') throw new ArenaError(400, 'invalid_body');
    const r = await env.DB.prepare('UPDATE submissions SET hidden = ? WHERE id = ?').bind(body.hidden ? 1 : 0, sub[1]).run();
    if (!r.meta?.changes) throw new ArenaError(404, 'not_found');
    await recompute(env, now);
    return json({ id: sub[1], hidden: body.hidden }, 200, NO_STORE);
  }
  if (path === '/v1/admin/recompute' && request.method === 'POST') return json(await recompute(env, now), 200, NO_STORE);
  throw new ArenaError(404, 'not_found');
}

async function route(request, env, ctx, now) {
  const url = new URL(request.url), path = url.pathname;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (path === '/v1/health' && request.method === 'GET') return json({ ok: true, schema: SCHEMA_VERSION, consentVersion: CONSENT_VERSION }, 200, CORS);
  if (path.startsWith('/v1/admin/')) return admin(request, env, now, path);
  if (path === '/v1/register/challenge') { if (request.method !== 'POST') throw new ArenaError(405, 'method_not_allowed'); return issueChallenge(request, env, now); }
  if (path === '/v1/register') { if (request.method !== 'POST') throw new ArenaError(405, 'method_not_allowed'); return register(request, env, now); }
  if (path === '/v1/submit') { if (request.method !== 'POST') throw new ArenaError(405, 'method_not_allowed'); return submit(request, env, now); }
  if (path === '/v1/me') { if (request.method !== 'DELETE') throw new ArenaError(405, 'method_not_allowed'); return deleteMine(request, env, now); }
  if (request.method !== 'GET') throw new ArenaError(405, 'method_not_allowed');
  if (path === '/v1/groups') return json(await cached(env, 'groups') ?? { computedAt: null, machines: 0, runs: 0, pendingMachines: 0, groups: [] }, 200, PUBLIC_CACHE);
  if (path === '/v1/leaderboard') {
    const all = await cached(env, 'all') ?? [];
    const key = url.searchParams.get('group') ?? all[0]?.group;
    const group = all.find(g => g.group === key);
    if (!group) return json({ group: key ?? null, rows: [], gpus: [], tierMedian: null }, 200, PUBLIC_CACHE);
    const p = url.searchParams, query = {};
    for (const k of FILTER_KEYS) { const v = p.get(k); if (v !== null && v.trim() !== '' && v.length <= 128) query[k] = v.trim(); }
    const { rows, ...g } = group;
    const num = k => query[k] !== undefined && Number.isFinite(Number(query[k])) ? Number(query[k]) : null;
    const result = filterRows(group, query);
    const filter = { gpu: query.gpu ?? null, vram: num('vram'), ram: num('ram'), ctx: num('ctx'), kv: query.kv ?? null, parallel: num('parallel'), gpuCount: num('gpuCount'), expertCache: query.expertCache ?? null, q: query.q ?? null, sort: result.sort };
    return json({ ...g, filter, options: facetOptions(rows), total: rows.length, ...result }, 200, PUBLIC_CACHE);
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Everything outside /v1 is the website (or, on the API host, a redirect to it).
    if (env.ASSETS && !isApiPath(url.pathname)) return serveSite(request, env, url);
    try { return await route(request, env, ctx, Date.now()); } catch (e) { return fail(e); }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(maintain(env)); },
};
export { route };
