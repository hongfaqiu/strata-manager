import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import worker, { maintain, OFFICIAL_REFERENCES, RETENTION_MS } from '../src/index.js';
import { validateSubmission } from '../src/schema.js';
import { checkOfficialEvidence, parseEvidence } from '../src/evidence.js';
import { aggregateOfficial, filterOfficialRows, OFFICIAL_SORTS } from '../src/stats.js';
import { evaluate } from '../src/trust.js';
import { createD1 } from './d1-shim.mjs';
import { APP_KEY, Install, installId, officialEvidenceFor, officialSubmission, submission, evidenceFor } from './fixtures.mjs';

const DAY = 86_400_000;
const envOf = (over = {}) => ({ DB: createD1(), ARENA_APP_KEYS: APP_KEY, IP_SALT: 'salt', SEED_TOKEN: 'seed-secret', POW_SECRET: 'pow-secret', POW_BITS: '8', ADMIN_TOKEN: 'admin-secret', ...over });
const call = (env, req) => worker.fetch(req, env, { waitUntil() {} });
const get = (env, path) => call(env, new Request('https://arena.test' + path));
async function machine(env, who) {
  env.machines ??= new Map();
  if (!env.machines.has(who)) {
    const inst = await Install.create();
    assert.equal((await inst.register(call, env, { ip: '198.51.100.' + (env.machines.size + 1) })).status, 201);
    env.machines.set(who, inst);
  }
  return env.machines.get(who);
}
/** Official runs carry consistent signed evidence unless `evidence: false`; a function edits it first. */
async function submit(env, body, { evidence = true, ...opts } = {}) {
  const { installId: who = installId(1), ...payload } = body;
  const inst = await machine(env, who);
  const make = payload.kind === 'official' ? officialEvidenceFor : evidenceFor;
  const attach = evidence ? await inst.evidence(make(payload, typeof evidence === 'function' ? evidence : undefined)) : {};
  return call(env, await inst.request('POST', '/v1/submit', { ...payload, ...attach }, opts));
}
const plain = over => { const { installId: _i, ...s } = officialSubmission(over); return s; };

test('official submissions: own block, catalog quants, no tiers, and plausibility checks', () => {
  const s = validateSubmission(plain());
  assert.equal(s.kind, 'official');
  assert.equal(s.official.metrics.chatDecodeTps, 44);
  assert.deepEqual(s.tiers, []);
  // Catalog quants of the published numbers fit only the official kind.
  assert.equal(validateSubmission(plain({ model: { family: 'deepseek41', quant: 'IST-DAS-2.00bpw' } })).model.quant, 'IST-DAS-2.00bpw');
  assert.throws(() => validateSubmission(submission({ model: { family: 'deepseek41', quant: 'IST-DAS-2.00bpw' } })), /model.quant/);
  assert.throws(() => validateSubmission({ ...plain(), tiers: submission().tiers }), /unexpected_tiers/);
  assert.throws(() => validateSubmission({ ...submission(), official: plain().official }), /unexpected_official/);
  assert.throws(() => validateSubmission(plain({ metrics: { prompt: 'hi' } })), /not allowed/);
  assert.throws(() => validateSubmission(plain({ official: { upstream: 'main' } })), /official.upstream/);
  assert.throws(() => validateSubmission(plain({ official: { long: false } })), /implausible_official/);
  assert.throws(() => validateSubmission(plain({ params: { ctx: 16384 } })), /implausible_tier_ctx/);
  assert.throws(() => validateSubmission(plain({ metrics: { chatDecodeTps: null } })), /incomplete_official/);
  assert.throws(() => validateSubmission(plain({ metrics: { p4kTtftS: null } })), /incomplete_official/);
  assert.throws(() => validateSubmission(plain({ metrics: { p16kTtftS: 0.05 } })), /implausible_ttft/);
  assert.throws(() => validateSubmission(plain({ metrics: { chatDecodeTps: 5000 } })), /official.chatDecodeTps/);
  // A short context skips the tiers that do not fit, exactly like the script.
  assert.doesNotThrow(() => validateSubmission(plain({ params: { ctx: 8192 }, official: { long: false }, metrics: { p16kTps: null, p16kTtftS: null, p32kTps: null, p32kTtftS: null, agentHitPct: null, agentDecodeTps: null, agentTurnTtftS: null } })));
});

test('official evidence: medians reproduce every figure; each contradiction names its reason', () => {
  const s = validateSubmission(plain());
  const check = edit => checkOfficialEvidence(s, parseEvidence(JSON.stringify(officialEvidenceFor(plain(), edit))));
  assert.deepEqual(check(), { status: 'verified', reasons: [] });
  const reason = edit => check(edit).reasons;
  assert.ok(reason(ev => { ev.runs.filter(r => r.ctx === 512).forEach(r => { r.decode = 60; }); }).includes('tier_decode_mismatch'));
  assert.ok(reason(ev => { ev.runs.filter(r => r.ctx === 4096).forEach(r => { r.prefill = 1500; }); }).includes('tier_prefill_mismatch'));
  assert.ok(reason(ev => { ev.runs = ev.runs.filter(r => r.ctx !== 16384); }).includes('tier_without_runs'));
  assert.ok(reason(ev => { ev.runs[0].ctx = 2048; }).includes('unknown_slot'));
  assert.ok(reason(ev => { ev.runs.filter(r => r.ctx === 4096).forEach(r => { r.promptTokens = 900; }); }).includes('prompt_tokens_vs_tier'));
  assert.ok(reason(ev => { ev.series.count = 30; ev.series.vramGB[0] = 20; }).includes('series_unexpected'));
  assert.ok(reason(ev => { ev.counters = null; }).includes('no_counters'));
  assert.ok(reason(ev => { ev.runs.filter(r => r.ctx === 65536).forEach(r => { r.cachedTokens = 100; }); }).includes('agent_hit_mismatch'));
  assert.ok(reason(ev => { ev.runs[3].endMs = ev.runs[3].startMs + 200; }).includes('wall_vs_decode'));
  assert.ok(reason(ev => { ev.runs[5].ttftMs = 1; }).length > 0);
  // A figure without its requests and requests without a figure are both rejected.
  const noAgent = validateSubmission(plain({ metrics: { agentHitPct: null, agentDecodeTps: null, agentTurnTtftS: null } }));
  assert.ok(checkOfficialEvidence(noAgent, parseEvidence(JSON.stringify(officialEvidenceFor(plain())))).reasons.includes('run_without_tier'));
  assert.deepEqual(checkOfficialEvidence(validateSubmission(submission()), parseEvidence(JSON.stringify(officialEvidenceFor(plain())))).reasons, ['not_official']);
});

test('a verified official run counts at once on /v1/official, next to the labelled published reference rows', async () => {
  const env = envOf();
  const r = await submit(env, officialSubmission({ model: { family: 'qwen', quant: 'IQ3_S' } }));
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.deepEqual([body.ranked, body.evidence, body.counted], [true, 'verified', true]);
  const board = await (await get(env, '/v1/official?group=qwen:IQ3_S')).json();
  assert.equal(board.group, 'qwen:IQ3_S');
  assert.equal(board.sort, 'chatDecode');
  assert.equal(board.rows.length, 1);
  assert.equal(board.rows[0].rank, 1);
  assert.equal(board.rows[0].metrics.chatDecodeTps, 44);
  assert.equal(board.rows[0].metrics.p16kTps, 821);
  assert.equal(board.rows[0].hw.gpu, 'NVIDIA GeForce RTX 4090');
  assert.equal(board.machines, 1);
  // Published numbers: labelled, sourced, never ranked or counted.
  assert.ok(board.references.length >= 1);
  for (const ref of board.references) {
    assert.equal(ref.official, true);
    assert.match(ref.source.url, /^https:\/\/github\.com\/Niko1221\/Strata\/blob\/[0-9a-f]{40}\//);
    assert.equal(ref.rank, undefined);
  }
  assert.equal(board.references[0].metrics.chatDecodeTps, 44);
  assert.equal(board.references[0].printed.chatDecodeTps, '44.0');
  // Groups with only published numbers are listed too, with no machines.
  const all = await (await get(env, '/v1/official')).json();
  assert.equal(all.group, 'qwen:IQ3_S', 'the group with uploads comes first');
  const ds = all.groups.find(g => g.group === 'deepseek41:IST-DAS-2.00bpw');
  assert.ok(ds && ds.machines === 0 && ds.references >= 1);
  const dsBoard = await (await get(env, '/v1/official?group=' + encodeURIComponent('deepseek41:IST-DAS-2.00bpw'))).json();
  assert.equal(dsBoard.rows.length, 0);
  assert.ok(dsBoard.references.length >= 1);
  // The old boards are untouched: an official run is not an 8K context run.
  const groups = await (await get(env, '/v1/groups')).json();
  assert.equal(groups.groups.length, 0);
  assert.equal((await (await get(env, '/v1/leaderboard')).json()).rows.length, 0);
  assert.equal((await (await get(env, '/v1/health')).json()).official, true);
});

test('official board sorts by each prefill tier and agent decode, and keeps the old filters', async () => {
  const env = envOf();
  await submit(env, officialSubmission({ installId: installId(1) }));
  await submit(env, officialSubmission({ installId: installId(2), hw: { gpus: [{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3090', vramGB: 24 }] }, metrics: { chatDecodeTps: 30, p16kTps: 1200, p16kTtftS: 13.4 } }));
  const q = async query => (await (await get(env, '/v1/official?group=swift:IQ3_S&' + query)).json());
  assert.deepEqual((await q('')).rows.map(r => r.hw.gpu), ['NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 3090']);
  const p16 = await q('sort=prefill16k');
  assert.equal(p16.sort, 'prefill16k');
  assert.deepEqual(p16.rows.map(r => r.hw.gpu), ['NVIDIA GeForce RTX 3090', 'NVIDIA GeForce RTX 4090']);
  assert.equal(p16.median, 1010.5);
  assert.equal((await q('sort=nonsense')).sort, 'chatDecode');
  assert.deepEqual((await q('q=3090')).rows.map(r => r.rank), [1]);
  assert.deepEqual(Object.keys(OFFICIAL_SORTS), ['chatDecode', 'prefill4k', 'prefill16k', 'prefill32k', 'agentDecode', 'machines']);
});

test('official runs without or with failing evidence stay pending; seed and retention rules are the same as before', async () => {
  const env = envOf();
  const none = await (await submit(env, officialSubmission(), { evidence: false })).json();
  assert.deepEqual([none.evidence, none.counted], ['missing', false]);
  const bad = await (await submit(env, officialSubmission({ installId: installId(2) }), { evidence: ev => { ev.runs.filter(r => r.ctx === 512).forEach(r => { r.decode = 99; }); } })).json();
  assert.equal(bad.evidence, 'failed');
  assert.equal(bad.counted, false);
  let board = await (await get(env, '/v1/official?group=swift:IQ3_S')).json();
  assert.equal(board.rows.length, 0);
  // A maintainer seed run counts and is labelled; it never adds to the public machine count.
  const seeded = await (await submit(env, officialSubmission({ installId: installId(3) }), { evidence: false, headers: { 'X-Arena-Seed': 'seed-secret' } })).json();
  assert.equal(seeded.seed, true);
  board = await (await get(env, '/v1/official?group=swift:IQ3_S')).json();
  assert.equal(board.rows.length, 1);
  assert.equal(board.rows[0].seed, true);
  assert.equal(board.rows[0].confidence, 'seed');
  assert.equal(board.machines, 0);
  // 12-month retention covers official runs too.
  await maintain(env, Date.now() + RETENTION_MS + DAY);
  board = await (await get(env, '/v1/official?group=swift:IQ3_S')).json();
  assert.equal(board.rows.length, 0);
});

test('peer cross-validation compares official runs only with official runs on the same configuration', () => {
  const sub = (id, who, kind, v) => ({ id, install_hash: who, kind, received_at: Date.now(), family: 'swift', quant: 'IQ3_S', gpu_name: 'RTX 4090', gpu_count: 1, vram_gb: 24, ram_gb: 96,
    ctx: 131072, kv: 'int8', parallel: 1, pool_workers: null, expert_cache: 'auto', pcie_frac: null, vision: 0, decode_8k: kind === 'context' ? v : null, off_chat_decode: kind === 'official' ? v : null,
    prefill_8k: null, ttft_8k_ms: null, seed: 0, evidence_status: 'verified' });
  const installs = ['a', 'b', 'c', 'd'].map(k => ({ key_id: k }));
  const { flags } = evaluate(installs, [sub(1, 'a', 'official', 44), sub(2, 'b', 'official', 43), sub(3, 'c', 'official', 140), sub(4, 'd', 'context', 12)]);
  assert.equal(flags.get(3), 'peer_outlier');
  assert.equal(flags.get(4) ?? null, null, 'a context run is not compared with official chat decode');
});

test('aggregateOfficial: one value per machine, reference-free medians, unranked rows without the sorted figure', () => {
  const row = (who, v, p32) => ({ id: who, install_hash: who, kind: 'official', received_at: 1, family: 'qwen', quant: 'IQ3_S', gpu_name: 'RTX 4090', gpu_count: 1, vram_gb: 24, ram_gb: 96,
    ctx: 131072, kv: 'int8', parallel: 1, pool_workers: null, expert_cache: 'auto', pcie_frac: null, vision: 0, seed: 0,
    off_chat_decode: v, off_chat_ttft_s: 0.6, off_prefill_4k: 700, off_prefill_16k: 800, off_prefill_32k: p32, off_agent_decode: 40, off_agent_hit: 80 });
  const [g] = aggregateOfficial([row('a', 40, null), row('b', 44, null), row('c', 42, null)]);
  assert.equal(g.rows.length, 1);
  assert.equal(g.rows[0].machines, 3);
  assert.equal(g.rows[0].metrics.chatDecodeTps, 42);
  assert.deepEqual(g.rows[0].spread, { p25: 41, p75: 43 });
  const r = filterOfficialRows(g, { sort: 'prefill32k' });
  assert.equal(r.rows[0].rank, null);
  assert.equal(r.median, null);
  assert.ok(OFFICIAL_REFERENCES.every(ref => ref.official && ref.source.url && ref.group.includes(':')));
});

test('migration 0004 only adds columns: it never drops, deletes or rewrites data', () => {
  const dir = new URL('../migrations/', import.meta.url);
  const name = readdirSync(dir).find(f => f.startsWith('0004_'));
  assert.equal(name, '0004_official_bench.sql');
  const sql = readFileSync(new URL(name, dir), 'utf8').replace(/--.*$/gm, '');
  assert.doesNotMatch(sql, /\b(DROP|DELETE|UPDATE|RENAME|REPLACE|TRUNCATE|INSERT)\b/i);
  const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
  assert.ok(statements.length >= 8);
  for (const s of statements) assert.match(s, /^ALTER TABLE submissions ADD COLUMN off_[a-z0-9_]+ (REAL|TEXT)$/);
});
