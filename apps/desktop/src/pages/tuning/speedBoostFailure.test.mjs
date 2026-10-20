import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('./speedBoostFailure.ts', import.meta.url), 'utf8');
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
const { isEarlierFailure, observerFailureKeys, speedBoostFailureKey, speedBoostFailureText } = module.exports;

const rust = readFileSync(new URL('../../../../../crates/runtime-core/src/maintenance.rs', import.meta.url), 'utf8');
const strings = readFileSync(new URL('./SpeedBoostStrings.ts', import.meta.url), 'utf8');

test('every current maintenance-gate message is mapped and identical to the Rust constant', () => {
  const constants = [...rust.matchAll(/pub\(crate\) const OBSERVER_\w+: &str =\s*"([^"]+)";/g)].map(match => match[1]);
  assert.equal(constants.length, 5);
  for (const message of constants) assert.ok(speedBoostFailureKey(message), message);
  for (const [, key] of observerFailureKeys) assert.match(strings, new RegExp(`\\b${key}: \\[`), key);
});

test('the 0.2.8 observer failure is explained instead of shown raw', () => {
  const legacy = '服务观察器版本、心跳或持久化状态不完整，保留当前服务';
  assert.equal(speedBoostFailureKey(legacy), 'sbObsLegacy');
  assert.equal(speedBoostFailureText(legacy, key => `<${key}>`), '<sbObsLegacy>');
  assert.equal(speedBoostFailureText('模型服务已停止', key => key), '模型服务已停止');
  assert.equal(speedBoostFailureText(undefined, key => key), '');
});

test('only a failure that ended before the page opened is history', () => {
  const opened = 10_000;
  assert.equal(isEarlierFailure({ state: 'failed', startedAt: 1_000, finishedAt: 2_000 }, opened), true);
  assert.equal(isEarlierFailure({ state: 'interrupted', startedAt: 1_000 }, opened), true);
  assert.equal(isEarlierFailure({ state: 'failed', startedAt: 9_000, finishedAt: 12_000 }, opened), false);
  assert.equal(isEarlierFailure({ state: 'completed', startedAt: 1_000, finishedAt: 2_000 }, opened), false);
  assert.equal(isEarlierFailure(null, opened), false);
});
