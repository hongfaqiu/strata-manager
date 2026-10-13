import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { normalizeError, StrataError } from '../../../packages/core/src/errors.ts';
import { configurationPathKey } from '../../../packages/core/src/model-groups.ts';

const path = new URL('./autoRunningServiceConnection.ts', import.meta.url);
const source = ts.transpileModule(existsSync(path) ? readFileSync(path, 'utf8') : '', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
vm.runInNewContext(source, { module, exports: module.exports, require: () => ({ normalizeError, StrataError, configurationPathKey }) });
const { selectAutomaticService, automaticallyManageService } = module.exports;
const candidate = (extra = {}) => ({ id: 'observed', name: 'Qwen', installDir: 'D:\\AI\\Strata', pythonPath: 'D:\\AI\\Strata\\python.exe', configPath: 'C:\\Manager\\imports\\observed\\config.json', modelPath: 'D:\\Models\\qwen.gguf', modelBytes: null, running: true, pid: 90091, detectedPort: 19091, ...extra });
const noOwner = () => { throw 'HTTP 404: {"code":"RUNNING_OWNER_NOT_FOUND","message":"No Manager owner"}'; };
const loaded = { service: 'strata', status: 'ok', loaded: true };

test('automatic service selection waits for known empty backend and an unblocked unique running service', () => {
  assert.equal(typeof selectAutomaticService, 'function');
  const found = candidate();
  assert.equal(selectAutomaticService([found], 0, false), found);
  for (const count of [undefined, 1, 2, -1, NaN, Infinity]) assert.equal(selectAutomaticService([found], count, false), undefined);
  assert.equal(selectAutomaticService([found], 0, true), undefined);
  assert.equal(selectAutomaticService([], 0, false), undefined);
  assert.equal(selectAutomaticService([candidate({ running: false })], 0, false), undefined);
  assert.equal(selectAutomaticService([found, candidate({ pid: 90092, detectedPort: 19092 })], 0, false), undefined);
});

test('duplicate detections use exact process, normalized configuration path and port identity', () => {
  assert.equal(typeof selectAutomaticService, 'function');
  const found = candidate(), duplicate = candidate({ id: 'alias', configPath: 'c:/manager/imports/observed/./config.json' });
  assert.equal(selectAutomaticService([found, duplicate], 0, false), found);
  for (const changed of [{ pid: 90092 }, { detectedPort: 19092 }, { configPath: 'C:\\Manager\\imports\\other\\config.json' }]) assert.equal(selectAutomaticService([found, candidate(changed)], 0, false), undefined);
});

test('incomplete identities, invalid process or port numbers and nonabsolute inputs never auto-connect', () => {
  assert.equal(typeof selectAutomaticService, 'function');
  for (const pid of [undefined, 0, -1, 1.5, 0x100000000, NaN, Infinity]) assert.equal(selectAutomaticService([candidate({ pid })], 0, false), undefined);
  for (const detectedPort of [undefined, 0, -1, 1.5, 65536, NaN, Infinity]) assert.equal(selectAutomaticService([candidate({ detectedPort })], 0, false), undefined);
  for (const key of ['installDir', 'pythonPath', 'configPath']) for (const value of [undefined, null, 0, '', ' ', 'relative/file', 'D:relative', '\\root-relative', 'D:\\nul\0path']) assert.equal(selectAutomaticService([candidate({ [key]: value })], 0, false), undefined);
  const found = candidate();
  assert.equal(selectAutomaticService([found, candidate({ id: 'incomplete', pid: undefined })], 0, false), undefined);
});

test('absolute POSIX and UNC paths are eligible alongside Windows drive paths', () => {
  assert.equal(typeof selectAutomaticService, 'function');
  for (const found of [candidate({ installDir: '/opt/strata', pythonPath: '/opt/strata/python', configPath: '/var/manager/config.json' }), candidate({ installDir: '\\\\server\\share\\Strata', pythonPath: '\\\\server\\share\\Strata\\python.exe', configPath: '\\\\server\\share\\Manager\\config.json' })]) assert.equal(selectAutomaticService([found], 0, false), found);
});

test('existing Manager ownership connects first without reading health or migrating even if unloaded', async () => {
  assert.equal(typeof automaticallyManageService, 'function');
  const found = candidate(), calls = [];
  assert.equal(await automaticallyManageService(found, async item => { assert.equal(item, found); calls.push('connect'); return 'connected'; }, async () => { calls.push('manage'); }, async () => { calls.push('health'); return { ...loaded, loaded: false }; }), 'connected');
  assert.deepEqual(calls, ['connect']);
});

test('missing owner plus unloaded or unidentified health leaves the original service alone', async () => {
  assert.equal(typeof automaticallyManageService, 'function');
  for (const health of [null, [], {}, { ...loaded, loaded: false }, { ...loaded, service: 'other' }, { ...loaded, status: 'busy' }, { ...loaded, status: 'starting' }, { ...loaded, loaded: 'true' }, { ...loaded, busy: true }]) {
    const found = candidate(), original = structuredClone(found), calls = [];
    assert.equal(await automaticallyManageService(found, noOwner, async () => { calls.push('manage'); }, async item => { assert.equal(item, found); calls.push('health'); return health; }), undefined);
    assert.deepEqual(calls, ['health']); assert.deepEqual(found, original);
  }
});

test('only a confirmed loaded Strata service without an owner enters safe migration', async () => {
  assert.equal(typeof automaticallyManageService, 'function');
  const found = candidate(), calls = [];
  assert.equal(await automaticallyManageService(found, async item => { assert.equal(item, found); calls.push('connect'); noOwner(); }, async item => { assert.equal(item, found); calls.push('manage'); return 'managed'; }, async item => { assert.equal(item, found); calls.push('health'); return loaded; }), 'managed');
  assert.deepEqual(calls, ['connect', 'health', 'manage']);
});

test('busy, unknown ownership, transport and health failures never fall back to migration', async () => {
  assert.equal(typeof automaticallyManageService, 'function');
  for (const code of ['BUSY', 'RUNNING_OWNER_UNVERIFIED', 'NETWORK_ERROR']) {
    const error = new StrataError(code, 'Cannot connect safely'), calls = [];
    await assert.rejects(automaticallyManageService(candidate(), async () => { throw error; }, async () => calls.push('manage'), async () => { calls.push('health'); return loaded; }), failure => failure === error);
    assert.deepEqual(calls, []);
  }
  let migrations = 0;
  const healthFailure = new Error('health unavailable');
  await assert.rejects(automaticallyManageService(candidate(), noOwner, async () => migrations++, async () => { throw healthFailure; }), failure => failure === healthFailure);
  assert.equal(migrations, 0);
});
