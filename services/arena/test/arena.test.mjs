import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { maintain, recompute, RETENTION_MS, LIMITS } from '../src/index.js';
import { validateSubmission } from '../src/schema.js';
import { aggregate, filterOutliers, recommend } from '../src/stats.js';
import { evaluate, TRUST } from '../src/trust.js';
import { leadingZeroBits, powMessage, sha256Hex } from '../src/crypto.js';
import { createD1 } from './d1-shim.mjs';
import { APP_KEY, Install, installId, submission, evidenceFor } from './fixtures.mjs';
import { checkEvidence, parseEvidence } from '../src/evidence.js';

const DAY = 86_400_000;
const envOf = (over = {}) => ({ DB: createD1(), ARENA_APP_KEYS: 'old-key, ' + APP_KEY, IP_SALT: 'salt', SEED_TOKEN: 'seed-secret', POW_SECRET: 'pow-secret', POW_BITS: '8', ADMIN_TOKEN: 'admin-secret', ...over });
const call = (env, req) => worker.fetch(req, env, { waitUntil() {} });
const get = (env, path) => call(env, new Request('https://arena.test' + path));
const adminCall = (env, method, path, body, token = 'admin-secret') => call(env, new Request('https://arena.test' + path, {
  method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }));

/** One registered install per machine number; `submission({ installId })` picks the machine, the field itself is never sent. */
async function machine(env, who) {
  env.machines ??= new Map();
  if (!env.machines.has(who)) {
    const inst = await Install.create();
    const r = await inst.register(call, env, { ip: '198.51.100.' + (env.machines.size + 1) });
    assert.equal(r.status, 201, 'registration');
    env.machines.set(who, inst);
  }
  return env.machines.get(who);
}
/** Context runs carry consistent signed run evidence unless `evidence: false`; a function edits it first. */
async function submit(env, body, { evidence = true, ...opts } = {}) {
  const { installId: who = installId(1), ...payload } = body;
  const inst = await machine(env, who);
  const attach = evidence && payload.kind === 'context' ? await inst.evidence(evidenceFor(payload, typeof evidence === 'function' ? evidence : undefined)) : {};
  return call(env, await inst.request('POST', '/v1/submit', { ...payload, ...attach }, opts));
}

test('schema rejects unknown fields, paths, hostnames and free text, including a body installId', () => {
  const { installId: _i, ...plain } = submission();
  assert.doesNotThrow(() => validateSubmission(plain));
  assert.throws(() => validateSubmission({ ...plain, installId: installId(1) }), /not allowed/);
  assert.throws(() => validateSubmission({ ...plain, configPath: 'D:/AI/swift.json' }), /not allowed/);
  assert.throws(() => validateSubmission(submission({ hw: { hostname: 'DESKTOP-1' } })), /not allowed/);
  assert.throws(() => validateSubmission(submission({ hw: { cpu: 'C:\\Users\\me' } })), /hw.cpu/);
  assert.throws(() => validateSubmission(submission({ hw: { cpu: 'me@example.com' } })), /hw.cpu/);
  assert.throws(() => validateSubmission(submission({ params: { kv: 'int8 --api-key x' } })), /params.kv/);
  const withPrompt = submission(); withPrompt.tiers[0].output = 'hello';
  assert.throws(() => validateSubmission(withPrompt), /not allowed/);
  assert.throws(() => validateSubmission(submission({ consentVersion: 0 })));
});

test('sanity checks reject physically implausible results', () => {
  const fast = submission(); fast.tiers[0].ttftMs = 5;
  assert.throws(() => validateSubmission(fast), /implausible_ttft/);
  const vram = submission(); vram.tiers[0].peakVramGB = 80;
  assert.throws(() => validateSubmission(vram), /implausible_vram/);
  const order = submission(); order.tiers[2].decode = 90;
  assert.throws(() => validateSubmission(order), /implausible_decode_order/);
  assert.throws(() => validateSubmission(submission({ params: { gpuCount: 2 } })), /implausible_gpu_count/);
  const huge = submission(); huge.tiers[0].decode = 5000;
  assert.throws(() => validateSubmission(huge), /tier.decode/);
});

test('registration needs the app key, a fresh solved challenge bound to the key, and proof of possession', async () => {
  const env = envOf();
  const inst = await Install.create();
  assert.equal((await inst.register(call, env, { appKey: 'wrong' })).status, 401, 'app key');
  assert.equal((await inst.register(call, env, { app: false })).status, 401, 'app key missing');
  // Wrong counter: find one that does NOT satisfy the difficulty.
  const c = await (await call(env, new Request('https://arena.test/v1/register/challenge', { method: 'POST' }))).json();
  assert.equal(c.bits, 8);
  let bad = 0; while (leadingZeroBits(await sha256Hex(powMessage(c.challenge, inst.publicKey, bad))) >= 8) bad++;
  const insufficient = await call(env, await inst.request('POST', '/v1/register', { publicKey: inst.publicKey, challenge: c.challenge, counter: bad, consentVersion: 1 }));
  assert.equal((await insufficient.json()).error, 'insufficient_work');
  // A solution for another key does not transfer.
  const other = await Install.create();
  const counter = await other.solve(c.challenge, c.bits);
  const forged = await call(env, await inst.request('POST', '/v1/register', { publicKey: other.publicKey, challenge: c.challenge, counter, consentVersion: 1 }));
  assert.equal((await forged.json()).error, 'invalid_install_signature', 'must sign with the key being registered');
  // Tampered challenge (difficulty lowered) fails the server MAC.
  const [ts, rand, , mac] = c.challenge.split('.');
  const cheap = `${ts}.${rand}.1.${mac}`;
  const tampered = await call(env, await inst.request('POST', '/v1/register', { publicKey: inst.publicKey, challenge: cheap, counter: 0, consentVersion: 1 }));
  assert.equal((await tampered.json()).error, 'invalid_challenge');
  // Correct registration, then the challenge cannot be reused.
  const good = await inst.register(call, env);
  assert.equal(good.status, 201);
  const body = await good.json();
  assert.equal(body.keyId, inst.keyId); assert.equal(body.status, 'pending');
  const c2 = await (await call(env, new Request('https://arena.test/v1/register/challenge', { method: 'POST' }))).json();
  const n2 = await inst.solve(c2.challenge, c2.bits);
  assert.equal((await call(env, await inst.request('POST', '/v1/register', { publicKey: inst.publicKey, challenge: c2.challenge, counter: n2, consentVersion: 1 }))).status, 200, 'idempotent re-register');
  assert.equal((await (await call(env, await inst.request('POST', '/v1/register', { publicKey: inst.publicKey, challenge: c2.challenge, counter: n2, consentVersion: 1 }))).json()).error, 'replay');
  // Expired challenge.
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60_000;
  try {
    const late = await call(env, await inst.request('POST', '/v1/register', { publicKey: inst.publicKey, challenge: c2.challenge, counter: n2, consentVersion: 1 }));
    assert.equal((await late.json()).error, 'challenge_expired');
  } finally { Date.now = realNow; }
  // Difficulty is configurable server-side.
  const hard = envOf({ POW_BITS: '20' });
  assert.equal((await (await call(hard, new Request('https://arena.test/v1/register/challenge', { method: 'POST' }))).json()).bits, 20);
  assert.equal((await call(envOf({ POW_SECRET: '' }), new Request('https://arena.test/v1/register/challenge', { method: 'POST' }))).status, 503);
});

test('submit requires app key + registered install signature and rejects replays', async () => {
  const env = envOf();
  assert.equal((await submit(env, submission())).status, 201);
  const inst = env.machines.get(installId(1));
  const { installId: _i, ...body } = submission();
  assert.equal((await call(env, await inst.request('POST', '/v1/submit', body, { appKey: 'wrong' }))).status, 401);
  assert.equal((await call(env, await inst.request('POST', '/v1/submit', body, { install: false }))).status, 401, 'install signature required');
  const stranger = await Install.create();
  assert.equal((await (await call(env, await stranger.request('POST', '/v1/submit', body))).json()).error, 'unregistered');
  assert.equal((await (await call(env, await inst.request('POST', '/v1/submit', body, { signer: stranger }))).json()).error, 'invalid_install_signature', 'signature by another key');
  assert.equal((await call(env, await inst.request('POST', '/v1/submit', body, { ts: Date.now() - 3_600_000 }))).status, 401);
  const req1 = await inst.request('POST', '/v1/submit', body, { nonce: 'c'.repeat(32) });
  const req2 = await inst.request('POST', '/v1/submit', body, { nonce: 'c'.repeat(32) });
  assert.equal((await call(env, req1)).status, 201);
  assert.equal((await call(env, req2)).status, 409);
  const big = await call(env, new Request('https://arena.test/v1/submit', { method: 'POST', body: 'x'.repeat(70000) }));
  assert.equal(big.status, 413);
  // The rotated-out key no longer works once removed from ARENA_APP_KEYS.
  const rotated = { ...env, ARENA_APP_KEYS: 'new-key' };
  assert.equal((await call(rotated, await inst.request('POST', '/v1/submit', body))).status, 401);
  assert.equal((await call(rotated, await inst.request('POST', '/v1/submit', body, { appKey: 'new-key' }))).status, 201);
});

test('stores no raw IP, and rate-limits per install', async () => {
  const env = envOf();
  for (let i = 0; i < LIMITS.installPerDay; i++) assert.equal((await submit(env, submission())).status, 201);
  assert.equal((await submit(env, submission())).status, 429);
  const dump = JSON.stringify(['submissions', 'rate_limits', 'nonces', 'installs'].map(t => env.DB.raw.prepare('SELECT * FROM ' + t).all()));
  assert.ok(!dump.includes('203.0.113.7'), 'raw IP is not stored');
});

test('maintainer seed token marks rows as seed; withdraw deletes my data and my key registration', async () => {
  const env = envOf();
  const seeded = await (await submit(env, submission({ installId: installId(9) }), { headers: { 'X-Arena-Seed': 'seed-secret' } })).json();
  assert.equal(seeded.seed, true);
  assert.equal((await (await submit(env, submission({ installId: installId(8) }), { headers: { 'X-Arena-Seed': 'guess' } })).json()).seed, false);
  await submit(env, submission({ installId: installId(2) }));
  const mine = env.machines.get(installId(2));
  assert.equal((await call(env, await mine.request('DELETE', '/v1/me', { extra: 1 }, { app: false }))).status, 400);
  const del = await call(env, await mine.request('DELETE', '/v1/me', {}, { app: false }));
  assert.deepEqual(await del.json(), { deleted: 1, unregistered: true }, 'withdraw works without the app key');
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM submissions').get().n, 2);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM installs WHERE key_id = ?').get(mine.keyId).n, 0);
  const { installId: _i, ...body } = submission();
  assert.equal((await (await call(env, await mine.request('POST', '/v1/submit', body))).json()).error, 'unregistered');
});

test('maintainer can ban an install key; banned keys cannot submit, re-register, or erase the ban', async () => {
  const env = envOf();
  await submit(env, submission({ installId: installId(3) }));
  const bad = env.machines.get(installId(3));
  assert.equal((await adminCall(env, 'GET', '/v1/admin/installs', undefined, 'nope')).status, 401);
  const list = await (await adminCall(env, 'GET', '/v1/admin/installs')).json();
  assert.equal(list.installs.length, 1); assert.equal(list.installs[0].status, 'verified'); assert.equal(list.installs[0].verified, 1); assert.equal(list.pow.bits, 8);
  const banned = await (await adminCall(env, 'POST', '/v1/admin/installs/' + bad.keyId, { action: 'ban' })).json();
  assert.equal(banned.status, 'banned'); assert.equal(banned.trust, 0);
  const { installId: _i, ...body } = submission();
  assert.equal((await (await call(env, await bad.request('POST', '/v1/submit', body))).json()).error, 'banned');
  assert.equal((await bad.register(call, env)).status, 403);
  assert.equal((await call(env, await bad.request('DELETE', '/v1/me', {}))).status, 200, 'data is still deletable');
  const tomb = env.DB.raw.prepare('SELECT override, public_key FROM installs WHERE key_id = ?').get(bad.keyId);
  assert.deepEqual({ ...tomb }, { override: 'ban', public_key: '' }, 'only a tombstone remains');
  assert.equal((await bad.register(call, env)).status, 403);
  const detail = await adminCall(env, 'GET', '/v1/admin/installs/' + bad.keyId);
  assert.equal((await detail.json()).submissions.length, 0);
  assert.equal((await adminCall(env, 'POST', '/v1/admin/installs/' + bad.keyId, { action: 'explode' })).status, 400);
  assert.equal((await call(envOf({ ADMIN_TOKEN: '' }), new Request('https://arena.test/v1/admin/installs'))).status, 503);
});

async function populate(env) {
  // 4090 group: IQ3_S at 128K on six machines, the same at 64K on four machines (faster), one outlier, one seed row.
  const rows = [];
  [35.2, 34.1, 36.8, 33.9, 35.6, 36.4].forEach((d, i) => rows.push(submission({ installId: installId(100 + i), decode: d })));
  rows.push(submission({ installId: installId(100), decode: 34.6 }), submission({ installId: installId(100), decode: 35.0 }));
  [39.1, 38.4, 40.2, 39.5].forEach((d, i) => rows.push(submission({ installId: installId(200 + i), decode: d, params: { ctx: 65536 }, tiers: submission({ decode: d }).tiers.slice(0, 2) })));
  rows.push(submission({ installId: installId(300), decode: 12.0 }));
  [28.9, 29.4].forEach((d, i) => rows.push(submission({ installId: installId(400 + i), decode: d, model: { quant: 'IQ3_XXS' } })));
  [44.1, 43.2, 45.6].forEach((d, i) => rows.push(submission({ installId: installId(500 + i), decode: d, model: { quant: 'IQ2_XS' }, params: { ctx: 65536 }, tiers: submission({ decode: d }).tiers.slice(0, 2) })));
  [24.8, 25.3, 23.9].forEach((d, i) => rows.push(submission({ installId: installId(600 + i), decode: d, hw: { gpus: [{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3090', vramGB: 24 }], pcie: 'Gen4 x16' } })));
  for (const r of rows) assert.equal((await submit(env, r, { ip: '198.51.100.' + Math.floor(Math.random() * 200) })).status, 201);
  await submit(env, submission({ installId: installId(900), decode: 33.8, params: { kv: 'q4_0', poolWorkers: 24 } }), { headers: { 'X-Arena-Seed': 'seed-secret' } });
  return recompute(env);
}

test('leaderboard groups by model + quant and ranks hardware + parameter rows by 8K decode median', async () => {
  const env = envOf();
  const summary = await populate(env);
  assert.deepEqual(summary.groups.map(g => g.group).sort(), ['swift:IQ2_XS', 'swift:IQ3_S', 'swift:IQ3_XXS'], 'verified runs form rows right away, even from two machines');
  assert.equal(summary.groups.find(g => g.group === 'swift:IQ3_XXS').machines, 2);
  const lb = await (await get(env, '/v1/leaderboard?group=swift:IQ3_S')).json();
  assert.equal(lb.family, 'swift'); assert.equal(lb.quant, 'IQ3_S');
  const [first, second] = lb.rows;
  assert.equal(first.params.ctx, 65536); assert.equal(first.machines, 4); assert.equal(first.decode.median, 39.3);
  assert.equal(second.params.ctx, 131072); assert.equal(second.machines, 6, 'outlier 12.0 removed, repeat runs collapse to one machine');
  assert.equal(second.decode.median, 35.3, 'machine 100 contributes the median of its latest three runs');
  assert.ok(lb.rows.some(r => r.seed && r.params.kv === 'q4_0' && r.confidence === 'seed'), 'seed row is listed and labeled');
  assert.ok(lb.rows.some(r => r.hw.gpu === 'NVIDIA GeForce RTX 3090'));
  assert.ok(!lb.rows.some(r => r.decode.median < 20), 'outlier machine never forms its own row (single machine)');
  const only3090 = await (await get(env, '/v1/leaderboard?group=swift:IQ3_S&gpu=NVIDIA%20GeForce%20RTX%203090')).json();
  assert.equal(only3090.rows.length, 1); assert.equal(only3090.rows[0].rank, 1);
  const tier = await (await get(env, '/v1/leaderboard?group=swift:IQ3_S&vram=24')).json();
  assert.equal(tier.rows.length, lb.rows.length);
  assert.equal((await get(env, '/v1/leaderboard?group=swift:IQ3_S')).headers.get('Access-Control-Allow-Origin'), '*');
  const groups = await (await get(env, '/v1/groups')).json();
  assert.ok(groups.groups.every(g => !('rows' in g)) && groups.machines > 0);
  // The 12.0 run is flagged against its peers and never counted.
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM submissions WHERE flag = 'peer_outlier'").get().n, 1);
});

test('a verified in-app run counts on the leaderboard immediately; runs without or with failing evidence stay pending', async () => {
  const env = envOf();
  const first = await (await submit(env, submission({ installId: installId(10), decode: 35.2 }))).json();
  assert.deepEqual([first.evidence, first.counted, first.reasons], ['verified', true, []], 'first upload, no waiting period');
  let lb = await (await get(env, '/v1/leaderboard?group=swift:IQ3_S')).json();
  assert.equal(lb.rows.length, 1); assert.equal(lb.rows[0].machines, 1); assert.equal(lb.rows[0].confidence, 'none', 'labeled as a single-machine row');
  assert.equal((await (await get(env, '/v1/groups')).json()).machines, 1);
  // No evidence: stored, pending, not on the board.
  const bare = await (await submit(env, submission({ installId: installId(11), decode: 34.6 }), { evidence: false })).json();
  assert.deepEqual([bare.evidence, bare.counted], ['missing', false]);
  // Evidence that contradicts the result: pending with the reason.
  const liar = await (await submit(env, submission({ installId: installId(12), decode: 36.1 }), { evidence: ev => { ev.runs[0].decode = 18; } })).json();
  assert.equal(liar.evidence, 'failed'); assert.ok(liar.reasons.includes('tier_decode_mismatch')); assert.equal(liar.counted, false);
  lb = await (await get(env, '/v1/leaderboard?group=swift:IQ3_S')).json();
  assert.equal(lb.rows[0].machines, 1, 'only the verified machine counts');
  const summary = await (await get(env, '/v1/groups')).json();
  assert.equal(summary.pendingMachines, 2);
  const overview = await (await adminCall(env, 'GET', '/v1/admin/installs')).json();
  assert.deepEqual(overview.counts, { installs: { verified: 1, pending: 2 }, runs: { verified: 1, missing: 1, failed: 1 } });
  const installs = Object.fromEntries(overview.installs.map(i => [i.keyId, i]));
  assert.equal(installs[env.machines.get(installId(10)).keyId].status, 'verified');
  assert.equal(installs[env.machines.get(installId(11)).keyId].status, 'pending');
  // Maintainers see the reason and can re-check the stored signed evidence.
  const detail = await (await adminCall(env, 'GET', '/v1/admin/installs/' + env.machines.get(installId(12)).keyId)).json();
  assert.equal(detail.submissions[0].evidence_status, 'failed'); assert.match(detail.submissions[0].evidence_reason, /tier_decode_mismatch/);
  const audit = await (await adminCall(env, 'GET', '/v1/admin/submissions/' + first.id)).json();
  assert.equal(audit.evidence_status, 'verified'); assert.equal(audit.evidence_sig.length, 128); assert.equal(JSON.parse(audit.evidence_json).v, 1);
  assert.equal((await adminCall(env, 'GET', '/v1/admin/submissions/' + first.id, undefined, 'nope')).status, 401);
});

test('evidence must be signed by the install key over its exact text and contain only whitelisted fields', async () => {
  const env = envOf();
  await submit(env, submission());
  const inst = env.machines.get(installId(1));
  const { installId: _i, ...body } = submission();
  const signed = await inst.evidence(evidenceFor(body));
  const tampered = { ...signed, evidence: signed.evidence.replace('"decode":35.2', '"decode":95.2') };
  assert.equal((await (await call(env, await inst.request('POST', '/v1/submit', { ...body, ...tampered }))).json()).error, 'invalid_evidence_signature');
  const stranger = await Install.create();
  const foreign = await stranger.evidence(evidenceFor(body));
  assert.equal((await (await call(env, await inst.request('POST', '/v1/submit', { ...body, ...foreign }))).json()).error, 'invalid_evidence_signature', 'signed by another key');
  assert.equal((await (await call(env, await inst.request('POST', '/v1/submit', { ...body, evidence: signed.evidence }))).json()).error, 'invalid_evidence_signature', 'unsigned');
  const leaky = await inst.evidence(evidenceFor(body, ev => { ev.runs[0].output = 'hello'; }));
  assert.match((await (await call(env, await inst.request('POST', '/v1/submit', { ...body, ...leaky }))).json()).error, /unknown_field|not_allowed|invalid/);
  const prompt = await inst.evidence({ ...evidenceFor(body), prompt: 'secret' });
  assert.equal((await call(env, await inst.request('POST', '/v1/submit', { ...body, ...prompt }))).status, 400);
});

test('evidence consistency checks: each contradiction leaves the run pending with its reason', () => {
  const base = submission(), s = validateSubmission(base);
  const check = (edit, sub = s) => checkEvidence(sub, parseEvidence(JSON.stringify(evidenceFor(base, edit))));
  assert.deepEqual(check(), { status: 'verified', reasons: [] });
  const cases = [
    ['engine_mismatch', ev => { ev.engine = '0.1.40'; }],
    ['timestamps', ev => { ev.runs[1].endMs = ev.runs[1].startMs; }],
    ['timestamps_overlap', ev => { ev.runs[1].startMs = ev.runs[0].startMs + 10; }],
    ['run_outside_duration', ev => { ev.durationMs = 20_000; }],
    ['prompt_tokens_vs_tier', ev => { ev.runs[0].promptTokens = 9000; }],
    ['cached_tokens', ev => { ev.runs[0].cachedTokens = ev.runs[0].promptTokens + 1; }],
    ['ttft_vs_prefill', ev => { ev.runs[2].ttftMs = 2000; }],
    ['wall_vs_decode', ev => { ev.runs[0].endMs = ev.runs[0].startMs + 1000; }],
    ['tier_decode_mismatch', ev => { ev.runs[0].decode = 30; }],
    ['tier_prefill_mismatch', ev => { ev.runs[0].prefill = 2000; }],
    ['tier_without_runs', ev => { ev.runs.pop(); }],
    ['run_without_tier', ev => { ev.runs.push({ ...ev.runs[2], ctx: 65536, startMs: ev.runs[2].endMs + 10, endMs: ev.runs[2].endMs + 20 }); }],
    ['series_length', ev => { ev.series.vramGB.length = ev.series.ramGB.length = ev.series.gpuUtil.length = 10; }],
    ['sample_count_below_runs', ev => { ev.series.count = 3; }],
    ['sample_count_vs_duration', ev => { ev.series.count = 5000; }],
    ['too_few_samples', ev => { for (const r of ev.runs) r.resourceSamples = 1; ev.series.count = 3; }],
    ['vram_peak_mismatch', ev => { ev.series.vramGB = ev.series.vramGB.map(() => 12); }],
    ['vram_exceeds_gpu', ev => { ev.series.vramGB[3] = 40; }],
    ['ram_peak_mismatch', ev => { ev.series.ramGB = ev.series.ramGB.map(() => 20); }],
    ['no_counters', ev => { ev.counters = null; }],
    ['counters_went_backwards', ev => { ev.counters.after.requests = 100; }],
    ['request_count_delta', ev => { ev.counters.after.requests = ev.counters.before.requests + 1; }],
    ['prompt_token_delta', ev => { ev.counters.after.promptTokens = ev.counters.before.promptTokens + 1000; }],
    ['output_token_delta', ev => { ev.counters.after.outputTokens = ev.counters.before.outputTokens + 10; }],
  ];
  for (const [reason, edit] of cases) {
    const r = check(edit);
    assert.equal(r.status, 'failed', reason); assert.ok(r.reasons.includes(reason), `${reason}: got ${r.reasons}`);
  }
  // Reported tier peaks must also fit the hardware.
  const small = validateSubmission(submission({ hw: { gpus: [{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090', vramGB: 24 }] } }));
  assert.equal(check(undefined, small).status, 'verified');
  const { tiers: _t, ...plain } = base;
  assert.deepEqual(checkEvidence(validateSubmission({ ...plain, kind: 'scenario', scenario: { decode: 31.4, prefill: 1980, ttftMs: 1200, maxConcurrency: 4, requests: 24, failed: 0 } }), parseEvidence(JSON.stringify(evidenceFor(base)))).reasons, ['scenario_unverifiable']);
  assert.throws(() => parseEvidence(JSON.stringify({ ...evidenceFor(base), v: 2 })), /unsupported_evidence/);
  assert.throws(() => parseEvidence('x'.repeat(20000)), /invalid_evidence/);
});

test('cross-validation flags outliers after the fact instead of gating, and flags installs that keep diverging', async () => {
  const env = envOf();
  for (const [i, d] of [35.2, 34.6, 36.1].entries()) assert.equal((await (await submit(env, submission({ installId: installId(10 + i), decode: d }))).json()).counted, true);
  // A fabricated machine: same config, absurd speed, but evidence internally consistent with it.
  for (let k = 0; k < 4; k++) await submit(env, submission({ installId: installId(99), decode: 90 + k, tiers: submission({ decode: 90 + k }).tiers.slice(0, 1) }));
  const summary = await recompute(env);
  const status = Object.fromEntries(env.DB.raw.prepare('SELECT key_id, status, trust, verified FROM installs').all().map(r => [r.key_id, r]));
  const ids = [10, 11, 12].map(n => env.machines.get(installId(n)).keyId), liar = env.machines.get(installId(99)).keyId;
  for (const id of ids) { assert.equal(status[id].status, 'verified'); assert.ok(status[id].trust >= 0.9, 'verified and consistent with peers'); }
  assert.equal(status[liar].status, 'flagged'); assert.ok(status[liar].trust < 0.5); assert.equal(status[liar].verified, 4);
  assert.equal(summary.machines, 3);
  const lb = await (await get(env, '/v1/leaderboard?group=swift:IQ3_S')).json();
  assert.equal(lb.rows.length, 1); assert.equal(lb.rows[0].machines, 3); assert.ok(lb.rows[0].decode.median < 40, 'the outlier is dropped once peers exist');
  const detail = await (await adminCall(env, 'GET', '/v1/admin/installs/' + liar)).json();
  assert.ok(detail.submissions.every(s => s.flag === 'peer_outlier' && s.evidence_status === 'verified'));
  const hide = await adminCall(env, 'POST', '/v1/admin/submissions/' + detail.submissions[0].id, { hidden: true });
  assert.deepEqual(await hide.json(), { id: detail.submissions[0].id, hidden: true });
  // A maintainer override still applies, and reset recomputes from the evidence.
  assert.equal((await (await adminCall(env, 'POST', '/v1/admin/installs/' + ids[0], { action: 'reset' })).json()).status, 'verified');
});

test('trust evaluation: verified vs pending, self flags, peer outliers and the flag-rate cut-off', () => {
  const now = Date.now();
  const row = (id, key, decode, dayOffset, extra = {}) => ({ id, install_hash: key, kind: 'context', received_at: now - dayOffset * DAY, family: 'swift', quant: 'IQ3_S', gpu_name: 'RTX', vram_gb: 24, ram_gb: 96,
    ctx: 131072, kv: 'int8', parallel: 1, pool_workers: 16, expert_cache: 'auto', pcie_frac: null, gpu_count: 1, vision: 0, decode_8k: decode, prefill_8k: 2400, ttft_8k_ms: 3400, seed: 0, evidence_status: 'verified', ...extra });
  const installs = [{ key_id: 'a' }, { key_id: 'b' }, { key_id: 'c' }];
  const subs = [row(1, 'a', 35, 0), row(2, 'a', 35.5, 1), row(3, 'a', 34.8, 2), row(4, 'b', 36, 0), row(5, 'b', 36.4, 1), row(6, 'b', 35.9, 1),
    row(7, 'c', 30, 0, { ttft_8k_ms: 200 }), row(8, 'c', 31, 1, { ttft_8k_ms: 300 }), row(9, 'c', 30.5, 1)];
  const { installs: v, flags, counts } = evaluate(installs, subs);
  assert.equal(flags.get(7), 'ttft_fast'); assert.equal(flags.get(9), null);
  assert.equal(v.get('a').status, 'verified'); assert.deepEqual([v.get('a').compared, v.get('a').consistent], [1, 1]);
  assert.equal(v.get('c').status, 'flagged', `flag rate above ${TRUST.maxFlagRate}`);
  assert.equal(counts(subs[0]), true); assert.equal(counts(subs[8]), false, 'runs of a flagged install do not count');
  const pair = evaluate(installs.slice(0, 2), subs.slice(0, 6)).installs;
  assert.deepEqual([pair.get('a').compared, pair.get('a').corroborated], [0, 1], 'a single peer within 20% corroborates');
  const alone = evaluate([{ key_id: 'z' }], [row(1, 'z', 35, 0)]);
  assert.equal(alone.installs.get('z').status, 'verified', 'no peers needed: one verified run is enough');
  assert.equal(alone.counts({ ...row(1, 'z', 35, 0) }), true);
  const pending = evaluate([{ key_id: 'p' }], [row(1, 'p', 35, 0, { evidence_status: 'missing' }), row(2, 'p', 35, 0, { evidence_status: 'failed' })]);
  assert.equal(pending.installs.get('p').status, 'pending'); assert.equal(pending.counts(row(1, 'p', 35, 0, { evidence_status: 'missing' })), false);
  assert.ok(pending.installs.get('p').trust < alone.installs.get('z').trust);
  const manual = evaluate([{ key_id: 'z', override: 'trust' }], [row(1, 'z', 35, 0, { evidence_status: 'missing' })]);
  assert.equal(manual.installs.get('z').status, 'trusted'); assert.equal(manual.counts(row(1, 'z', 35, 0, { evidence_status: 'missing' })), true);
  const outlier = evaluate([{ key_id: 'a' }, { key_id: 'b' }, { key_id: 'o' }], [...subs.slice(0, 6), row(20, 'o', 80, 0)]);
  assert.equal(outlier.flags.get(20), 'peer_outlier'); assert.equal(outlier.counts(row(20, 'o', 80, 0)), false);
});

test('recommendation compares parameters inside the same model + quant first', async () => {
  const env = envOf();
  await populate(env);
  const q = '/v1/recommend?gpu=NVIDIA%20GeForce%20RTX%204090&vram=24&ram=96&family=swift&quant=IQ3_S&ctx=131072&kv=int8&parallel=1&poolWorkers=16&expertCache=auto&gpuCount=1';
  const rec = await (await get(env, q)).json();
  assert.equal(rec.level, 'gpu');
  assert.equal(rec.sameModel.group, 'swift:IQ3_S');
  assert.equal(rec.sameModel.current.params.ctx, 131072);
  assert.equal(rec.sameModel.best.params.ctx, 65536);
  assert.deepEqual(rec.sameModel.changes.map(c => [c.param, c.from, c.to]), [['ctx', 131072, 65536]]);
  assert.ok(rec.sameModel.changes[0].gainPct >= 10);
  assert.equal(rec.otherModels[0].group, 'swift:IQ2_XS');
  const long = await (await get(env, q + '&scene=long')).json();
  assert.equal(long.sameModel.best.params.ctx, 131072, 'long-document scene only ranks rows that measured 128K');
  const fallback = await (await get(env, '/v1/recommend?gpu=NVIDIA%20GeForce%20RTX%204090D&vram=24&ram=96&family=swift&quant=IQ3_S')).json();
  assert.equal(fallback.level, 'vram');
  const cold = await (await get(env, '/v1/recommend?gpu=Radeon%20RX%207600&vram=8&ram=32')).json();
  assert.equal(cold.level, 'none'); assert.deepEqual(cold.otherModels, []);
  const tight = recommend(aggregate([]), { ramGB: 16 });
  assert.equal(tight.level, 'none');
});

test('cron enforces 12-month retention for runs and idle key registrations, and purges short-lived counters', async () => {
  const env = envOf();
  await submit(env, submission());
  env.DB.raw.prepare('UPDATE submissions SET received_at = ?').run(Date.now() - RETENTION_MS - 1000);
  env.DB.raw.prepare('UPDATE installs SET last_seen_at = ?').run(Date.now() - RETENTION_MS - 1000);
  env.DB.raw.prepare("INSERT INTO rate_limits VALUES ('ip:x', '2020-01-01', 3)").run();
  await maintain(env);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM submissions').get().n, 0);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM installs').get().n, 0);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE window = '2020-01-01'").get().n, 0);
});

test('outlier filter keeps a tight cluster and drops a far value', () => {
  const kept = filterOutliers([30, 31, 31.5, 32, 30.5, 12, 90].map(decode => ({ decode })));
  assert.deepEqual(kept.map(k => k.decode), [30, 31, 31.5, 32, 30.5]);
});

test('unknown routes and methods', async () => {
  const env = envOf();
  assert.equal((await get(env, '/v1/nope')).status, 404);
  assert.equal((await call(env, new Request('https://arena.test/v1/groups', { method: 'POST' }))).status, 405);
  assert.equal((await get(env, '/v1/register/challenge')).status, 405);
  assert.equal((await get(env, '/v1/health')).status, 200);
  assert.deepEqual((await (await get(env, '/v1/leaderboard')).json()).rows, []);
});

test('scenario submissions are stored but not ranked', async () => {
  const env = envOf();
  const { tiers: _t, ...base } = submission();
  const res = await submit(env, { ...base, kind: 'scenario', scenario: { decode: 31.4, prefill: 1980, ttftMs: 1200, maxConcurrency: 4, requests: 24, failed: 0 } });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json().then(b => [b.accepted, b.ranked]), [true, false]);
  const row = env.DB.raw.prepare('SELECT decode_8k, peak_vram_gb, result_json FROM submissions').get();
  assert.equal(row.decode_8k, null);
  assert.equal(row.peak_vram_gb, null);
  assert.match(row.result_json, /"maxConcurrency":4/);
});
