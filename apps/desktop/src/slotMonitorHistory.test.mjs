import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('./SlotMonitor.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
vm.runInNewContext(source, { module, exports: module.exports, require: () => ({}) });
const { nextSlotHistory } = module.exports;

test('slot speed history keeps idle polls as gaps and caps at 30 samples', () => {
  let history = {};
  for (let i = 0; i < 35; i++) history = nextSlotHistory(history, [{ id: 0, state: 'generating', tokS: 40 + i }, { id: 1, state: i % 2 ? 'idle' : 'generating', tokS: 30 }]);
  assert.equal(history[0].length, 30);
  assert.equal(history[0].at(-1), 74);
  assert.deepEqual([...history[1].slice(-2)], [null, 30]);
  assert.deepEqual([...Object.keys(nextSlotHistory(history, [{ id: 1, state: 'idle', tokS: null }]))], ['1'], 'slots that disappear are dropped');
});
