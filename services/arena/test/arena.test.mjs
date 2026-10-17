import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { maintain, recompute, RETENTION_MS, LIMITS } from '../src/index.js';
import { validateSubmission } from '../src/schema.js';
import { aggregate, filterOutliers, recommend } from '../src/stats.js';
import { createD1 } from './d1-shim.mjs';
import { APP_KEY, installId, signed, submission } from './fixtures.mjs';

const envOf = () => ({ DB: createD1(), ARENA_APP_KEYS: 'old-key, ' + APP_KEY, IP_SALT: 'salt', SEED_TOKEN: 'seed-secret' });
const call = (env, req) => worker.fetch(req, env, { waitUntil() {} });
const submit = (env, body, opts) => signed('POST', '/v1/submit', body, opts).then(r => call(env, r));
const get = (env, path) => call(env, new Request('https://arena.test' + path));

test('schema rejects unknown fields, paths, hostnames and free text', () => {
  assert.doesNotThrow(() => validateSubmission(submission()));
  assert.throws(() => validateSubmission({ ...submission(), configPath: 'D:/AI/swift.json' }), /not allowed/);
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

test('submit requires a fresh valid signature and rejects replays', async () => {
  const env = envOf();
  assert.equal((await submit(env, submission())).status, 201);
  assert.equal((await submit(env, submission(), { key: 'wrong' })).status, 401);
  assert.equal((await submit(env, submission(), { ts: Date.now() - 3_600_000 })).status, 401);
  const req1 = await signed('POST', '/v1/submit', submission(), { nonce: 'c'.repeat(32) });
  const req2 = await signed('POST', '/v1/submit', submission(), { nonce: 'c'.repeat(32) });
  assert.equal((await call(env, req1)).status, 201);
  assert.equal((await call(env, req2)).status, 409);
  const big = await call(env, new Request('https://arena.test/v1/submit', { method: 'POST', body: 'x'.repeat(40000) }));
  assert.equal(big.status, 413);
});

test('stores no raw installId or IP, and rate-limits per install', async () => {
  const env = envOf();
  for (let i = 0; i < LIMITS.installPerDay; i++) assert.equal((await submit(env, submission())).status, 201);
  assert.equal((await submit(env, submission())).status, 429);
  const dump = JSON.stringify(['submissions', 'rate_limits', 'nonces'].map(t => env.DB.raw.prepare('SELECT * FROM ' + t).all()));
  assert.ok(!dump.includes(installId(1)), 'raw installId is not stored');
  assert.ok(!dump.includes('203.0.113.7'), 'raw IP is not stored');
});

test('maintainer seed token marks rows as seed; withdraw deletes only my data', async () => {
  const env = envOf();
  const seeded = await (await submit(env, submission({ installId: installId(9) }), { headers: { 'X-Arena-Seed': 'seed-secret' } })).json();
  assert.equal(seeded.seed, true);
  assert.equal((await (await submit(env, submission({ installId: installId(8) }), { headers: { 'X-Arena-Seed': 'guess' } })).json()).seed, false);
  await submit(env, submission({ installId: installId(2) }));
  const del = await call(env, await signed('DELETE', '/v1/me', { installId: installId(2) }));
  assert.deepEqual(await del.json(), { deleted: 1 });
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM submissions').get().n, 2);
  assert.equal((await call(env, await signed('DELETE', '/v1/me', { installId: installId(2), extra: 1 }))).status, 400);
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
  assert.deepEqual(summary.groups.map(g => g.group).sort(), ['swift:IQ2_XS', 'swift:IQ3_S']);
  const lb = await (await get(env, '/v1/leaderboard?group=swift:IQ3_S')).json();
  assert.equal(lb.family, 'swift'); assert.equal(lb.quant, 'IQ3_S');
  const [first, second, third, fourth] = lb.rows;
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
  void first; void third; void fourth;
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

test('cron enforces 12-month retention and purges short-lived counters', async () => {
  const env = envOf();
  await submit(env, submission());
  env.DB.raw.prepare('UPDATE submissions SET received_at = ?').run(Date.now() - RETENTION_MS - 1000);
  env.DB.raw.prepare("INSERT INTO rate_limits VALUES ('ip:x', '2020-01-01', 3)").run();
  await maintain(env);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM submissions').get().n, 0);
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
