import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const tick = () => new Promise(resolve => setImmediate(resolve));
const shard = { fileName: 'Qwen-00004-of-00006.gguf', directory: 'D:\\Models', path: 'D:\\Models\\Qwen-00004-of-00006.gguf', sizeBytes: 49_800_000_000 };
const jsx = (type, props) => ({ type, props: props ?? {} });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree) : !tree || typeof tree !== 'object' ? '' : [tree.props?.children].flat(Infinity).map(text).join('');
const source = ts.transpileModule(readFileSync(new URL('./BadShardAction.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(overrides = {}) {
  const slots = [], effects = [], calls = { asked: [] };
  let cursor = 0, tree, component;
  const sameDeps = (a, b) => a?.length === b?.length && a?.every((value, index) => Object.is(value, b[index]));
  const react = {
    useState: initial => { const state = slots[cursor] ??= { value: initial }; cursor++; return [state.value, value => { state.value = value; }]; },
    useEffect: (fn, deps) => { const effect = slots[cursor] ??= {}; cursor++; if (!sameDeps(effect.deps, deps)) { effect.deps = deps; effects.push(() => { effect.cleanup?.(); effect.cleanup = fn(); }); } },
  };
  const core = {
    normalizeError: error => ({ message: error instanceof Error ? error.message : String(error) }),
    taskBadShard: async id => { calls.asked.push(id); return overrides.found === undefined ? shard : overrides.found; },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: name => ({ react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '@strata-manager/core': core, '../OfficialControls': { OfficialDialog: 'dialog' } })[name] ?? {} });
  return {
    calls,
    mount: (Component, props) => { component = Component; const run = () => { cursor = 0; tree = module.exports[component](props); while (effects.length) effects.shift()(); }; run(); return { settle: async () => { await tick(); run(); }, tree: () => tree, button: name => nodes(tree).find(node => node.type === 'button' && text(node).includes(name)) }; },
  };
}

test('a failed task with a kept shard shows one clear action; other tasks show nothing', async () => {
  const opened = [];
  const props = { taskId: 't1', failed: true, language: 'zh-CN', canRetry: true, onOpen: found => opened.push(found) };
  const h = harness(); const view = h.mount('BadShardAction', props); await view.settle();
  assert.deepEqual(h.calls.asked, ['t1']);
  const action = view.button('删除坏分片并重试');
  assert.ok(action);
  action.props.onClick();
  assert.deepEqual(opened, [shard], 'opens the confirmation only; nothing is deleted yet');

  const none = harness({ found: null }).mount('BadShardAction', props); await none.settle();
  assert.equal(none.tree(), null);
  const done = harness(); const finished = done.mount('BadShardAction', { ...props, failed: false }); await finished.settle();
  assert.equal(finished.tree(), null);
  assert.deepEqual(done.calls.asked, [], 'a task that did not fail is never asked');
});

test('the action says plainly when there is no recipe to retry with, and has an English label', async () => {
  const base = { taskId: 't1', failed: true, onOpen() {} };
  const a = harness().mount('BadShardAction', { ...base, language: 'zh-CN', canRetry: false }); await a.settle();
  assert.ok(a.button('删除坏分片')); assert.equal(a.button('并重试'), undefined);
  const b = harness().mount('BadShardAction', { ...base, language: 'en', canRetry: true }); await b.settle();
  assert.ok(b.button('Delete bad shard and retry'));
});

test('the confirm step shows the exact path, deletes only on confirm, and keeps the error visible', async () => {
  const log = [];
  let fail = true;
  const props = { shard, language: 'zh-CN', canRetry: true, onClose: () => log.push('close'), onConfirm: async () => { log.push('confirm'); if (fail) throw new Error('文件被占用'); } };
  const view = harness().mount('BadShardDialog', props);
  const body = text(view.tree());
  assert.ok(body.includes('D:\\Models\\Qwen-00004-of-00006.gguf'), 'exact file path');
  assert.ok(body.includes('.done') && body.includes('.part'));
  assert.deepEqual(log, [], 'opening the dialog deletes nothing');
  view.button('取消').props.onClick();
  assert.deepEqual(log, ['close']);

  view.button('删除并重试').props.onClick(); await view.settle();
  assert.deepEqual(log, ['close', 'confirm']);
  assert.ok(text(view.tree()).includes('文件被占用'));
  assert.equal(view.button('删除并重试').props.disabled, false, 'can try again after an error');
  fail = false;
  view.button('删除并重试').props.onClick(); await view.settle();
  assert.deepEqual(log, ['close', 'confirm', 'confirm']);
});

test('a shard that is already gone says so instead of a size', () => {
  const view = harness().mount('BadShardDialog', { shard: { ...shard, sizeBytes: null }, language: 'zh-CN', canRetry: true, onClose() {}, onConfirm() {} });
  assert.ok(text(view.tree()).includes('文件已经不在了'));
});
