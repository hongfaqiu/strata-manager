import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { configurationPathKey } from '../../../../packages/core/src/model-groups.ts';

const source = ts.transpileModule(readFileSync(new URL('./overviewStartup.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
vm.runInNewContext(source, { module, exports: module.exports, require: name => name === '@strata-manager/core' ? { configurationPathKey } : {} });
const { selectOverviewStartup } = module.exports;
const profile = (id, overrides = {}) => ({ id, name: 'Qwen', baseUrl: 'http://127.0.0.1:18081', installDir: 'D:\\AI\\Strata', pythonPath: 'D:\\AI\\Strata\\python.exe', configPath: `D:\\AI\\Strata\\${id}.json`, managed: true, ...overrides });
const candidate = (id, overrides = {}) => ({ id, name: 'Qwen', installDir: 'D:\\AI\\Strata', pythonPath: 'D:\\AI\\Strata\\python.exe', configPath: `D:\\AI\\Strata\\${id}.json`, modelPath: 'D:\\Models\\qwen.gguf', modelBytes: 100, availability: 'ready', ...overrides });

test('recommends the most recently activated configuration, keeping same-name configurations distinct', () => {
  const older = profile('older'), newer = profile('newer');
  const result = selectOverviewStartup([older, newer], [
    { profileId: older.id, lastActivatedAt: 100, configModifiedAt: 9000 },
    { profileId: newer.id, lastActivatedAt: 200, configModifiedAt: 1 },
  ], [], older.id);
  assert.equal(result.profile, newer);
  assert.equal(result.lastActivatedAt, 200);
});

test('ignores invalid activation timestamps and falls back to the previous valid configuration', () => {
  const first = profile('first'), previous = profile('previous');
  for (const timestamp of [null, undefined, 0, -1, Infinity, NaN, 1e300]) {
    const result = selectOverviewStartup([first, previous], [{ profileId: first.id, lastActivatedAt: timestamp, configModifiedAt: 9000 }], [], previous.id);
    assert.equal(result.profile, previous);
    assert.equal(result.lastActivatedAt, undefined);
  }
  assert.equal(selectOverviewStartup([first, previous], [], [], 'missing').profile, first);
});

test('excludes an unavailable saved configuration by its exact path, without excluding a same-name alternative', () => {
  const broken = profile('broken'), available = profile('available');
  const result = selectOverviewStartup([broken, available], [{ profileId: broken.id, lastActivatedAt: 999 }], [candidate('broken', { configPath: 'd:/ai/strata/folder/../broken.json', availability: 'repair' })], broken.id);
  assert.equal(result.profile, available);
});

test('recognizes a repaired-needed original configuration path for an imported private copy', () => {
  const imported = profile('imported', { configPath: 'C:\\Manager\\imports\\imported\\config.json' }), available = profile('available');
  const result = selectOverviewStartup([imported, available], [{ profileId: imported.id, originalConfigPath: 'original.json', lastActivatedAt: 999 }], [candidate('original', { configPath: 'd:/AI/STRATA/./original.json', availability: 'repair' })]);
  assert.equal(result.profile, available);
});

test('excludes connection-only and incomplete saved profiles', () => {
  const available = profile('available');
  const invalid = [profile('remote', { managed: false }), profile('no-runtime', { installDir: '' }), profile('no-config', { configPath: '' }), profile('no-python', { pythonPath: ' ' })];
  const result = selectOverviewStartup([...invalid, available], invalid.map((item, index) => ({ profileId: item.id, lastActivatedAt: 999 + index })));
  assert.equal(result.profile, available);
});

test('uses a complete discovered candidate when no saved profile can start and prioritizes the running candidate', () => {
  const stopped = candidate('stopped'), running = candidate('running', { running: true });
  const result = selectOverviewStartup([profile('incomplete', { pythonPath: '' })], [], [candidate('broken', { availability: 'repair', running: true }), stopped, running]);
  assert.equal(result.profile, undefined);
  assert.equal(result.candidate, running);
  assert.equal(result.lastActivatedAt, undefined);
  assert.equal(selectOverviewStartup([], [], [stopped]).candidate, stopped);
});

test('returns no recommendation when model paths or runtime inputs are missing', () => {
  assert.equal(selectOverviewStartup([], [], []), undefined);
  const incomplete = [candidate('no-runtime', { installDir: '' }), candidate('no-config', { configPath: '' }), candidate('no-python', { pythonPath: '' }), candidate('no-model', { modelPath: '' }), candidate('repair', { availability: 'repair' })];
  assert.equal(selectOverviewStartup([], [], incomplete), undefined);
});
