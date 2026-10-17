import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function load(core) {
  const module = { exports: {} };
  vm.runInNewContext(compile('./concurrencyComparisonRunner.ts'), { module, exports: module.exports, setTimeout, Date, Promise, Error, AbortController, require: name => name === '@strata-manager/core' ? core : {} });
  return module.exports;
}
const base = { id: 'base', configPath: 'D:\\S\\strata-qwen.json' };
const candidates = [{ id: 'p1', parallel: 1, experimental: false, edits: [] }, { id: 'p4', parallel: 4, experimental: false, edits: [{ key: 'parallel', value: '4' }] }];
function fakeCore(calls, { failLadder } = {}) {
  return {
    asObject: v => v ?? {}, normalizeError: e => ({ message: String(e?.message ?? e) }),
    loadStore: async () => null, saveStore: async (key, value) => { calls.push(['save', key, value.results.length]); },
    readConfigSnapshot: async () => ({ config: { args: [] } }), applyConcurrencyEdits: (c, edits) => ({ ...c, edits }), validateStartupConfiguration: () => {},
    concurrencyVersionName: (path, c) => `strata-qwen-parallel-${c.parallel}.json`,
    copyConfiguration: async (profile, name) => { calls.push(['copy', name]); return { id: name, configPath: name }; },
    request: async () => ({ loaded: true }),
    concurrencyLadderOptions: n => ({ concurrency: Math.max(2, n) }),
    runBenchmarkSuite: async (profile, options, onProgress) => { calls.push(['ladder', profile.id, options.concurrency]); onProgress({ stageIndex: 1, totalStages: 2, concurrency: 1 }); if (failLadder === profile.id) throw new Error('engine exited'); return { profile }; },
    concurrencyLadderRows: () => [{ concurrency: 1, totalTokS: 40, perRequestTokS: 40, ttftP95Ms: 300 }],
    concurrencyCandidateResult: (id, rows, error) => ({ id, rows, peakTotalTokS: rows.length ? 40 : null, soloTokS: rows.length ? 40 : null, topTtftP95Ms: null, ...(error ? { error } : {}) }),
  };
}

test('saving writes one new configuration version per candidate and never the base file', async () => {
  const calls = []; const runner = load(fakeCore(calls));
  const versions = await runner.saveCandidateVersions(base, candidates);
  assert.deepEqual(calls, [['copy', 'strata-qwen-parallel-1.json'], ['copy', 'strata-qwen-parallel-4.json']]);
  assert.deepEqual(Object.keys(versions), ['p1', 'p4']);
  await runner.saveCandidateVersions(base, candidates);
  assert.equal(calls.length, 2, 'already saved versions are not copied again');
});

test('the restart run measures each version in turn and always switches back, even after a failure', async () => {
  const calls = []; const runner = load(fakeCore(calls, { failLadder: 'strata-qwen-parallel-4.json' }));
  await runner.saveCandidateVersions(base, candidates); calls.length = 0;
  await runner.runComparison(base, async profile => { calls.push(['switch', profile.id]); }, 5000);
  assert.deepEqual(calls.filter(c => c[0] !== 'save'), [['switch', 'strata-qwen-parallel-1.json'], ['ladder', 'strata-qwen-parallel-1.json', 2], ['switch', 'strata-qwen-parallel-4.json'], ['ladder', 'strata-qwen-parallel-4.json', 4], ['switch', 'base']]);
  const state = runner.comparisonSnapshot();
  assert.equal(state.phase, 'done');
  assert.equal(state.results[1].error, 'engine exited');
  assert.equal(state.results[0].peakTotalTokS, 40);
});

test('a failed switch back is reported, not hidden', async () => {
  const calls = []; const runner = load(fakeCore(calls));
  await runner.saveCandidateVersions(base, candidates.slice(0, 1));
  await runner.runComparison(base, async profile => { if (profile.id === 'base') throw new Error('restore failed'); });
  assert.equal(runner.comparisonSnapshot().phase, 'failed');
  assert.equal(runner.comparisonSnapshot().error, 'restore failed');
});
