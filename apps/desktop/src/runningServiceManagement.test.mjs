import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { normalizeError } from '../../../packages/core/src/errors.ts';

const source = ts.transpileModule(readFileSync(new URL('./runningServiceManagement.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
vm.runInNewContext(source, { module, exports: module.exports, require: () => ({ normalizeError }) });
const { manageRunningService } = module.exports;

test('an existing Manager owner is connected without migration', async () => {
  let migrated = 0;
  assert.equal(await manageRunningService(async () => 'connected', async () => { migrated++; return 'migrated'; }), 'connected');
  assert.equal(migrated, 0);
});

test('a plain external instance can enter the existing safe migration flow', async () => {
  let migrated = 0;
  assert.equal(await manageRunningService(async () => { throw JSON.stringify({ code: 'RUNNING_OWNER_NOT_FOUND', message: 'No Manager owner' }); }, async () => { migrated++; return 'migrated'; }), 'migrated');
  assert.equal(migrated, 1);
});

test('unverified ownership, busy services and transport errors preserve the instance', async () => {
  for (const code of ['RUNNING_OWNER_UNVERIFIED', 'BUSY', 'NETWORK_ERROR']) {
    let migrated = 0;
    const error = JSON.stringify({ code, message: 'Cannot reconnect safely' });
    await assert.rejects(manageRunningService(async () => { throw error; }, async () => { migrated++; }), value => value === error);
    assert.equal(migrated, 0);
  }
});
