import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const jsx = (type, props) => ({ type, props: props ?? {} });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const text = tree => nodes(tree).flatMap(node => [node.props.children].flat(Infinity)).filter(child => typeof child === 'string' || typeof child === 'number').join('');
const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const roles = { exports: {} };
vm.runInNewContext(compile('../../../../packages/core/src/gpu-roles.ts'), { module: roles, exports: roles.exports, require: () => ({}), structuredClone });
const Segmented = props => jsx('segmented', props);
const editor = { exports: {} };
vm.runInNewContext(compile('./GpuRolesEditor.tsx'), { module: editor, exports: editor.exports, structuredClone, require: name => ({ react: { useState: v => [v, () => {}] }, '@strata-manager/core': { gpuRoles: roles.exports }, '../OfficialControls': { Segmented }, 'react/jsx-runtime': { jsx, jsxs: jsx } })[name] ?? {} });
const { GpuRolesEditor, cardsFromEnvironment } = editor.exports;
const cards = cardsFromEnvironment(['NVIDIA GeForce RTX 3060, 560.94, 12288 MiB', 'NVIDIA GeForce RTX 4070 Ti, 560.94, 12282 MiB']);
const render = (config, extra = {}) => { const changes = []; const tree = GpuRolesEditor({ zh: true, config, cards, mac: false, disabled: false, showParameterNames: false, onChange: next => changes.push(next), ...extra }); return { tree, changes }; };

test('environment lines become numbered cards', () => {
  assert.deepEqual(cards.map(card => [card.index, card.vram_gb, card.vendor]), [[0, 12, 'nvidia'], [1, 12, 'nvidia']]);
});

test('a role click writes gpu_roles with the gpu mirror', () => {
  const { tree, changes } = render({ args: [] });
  const segments = nodes(tree).filter(node => node.type === Segmented);
  assert.equal(segments.length, 2);
  segments[0].props.onValueChange('main');
  assert.deepEqual(JSON.parse(JSON.stringify(changes[0])), { args: [], gpu_roles: { 0: 'main', 1: 'helper' }, gpu: [1, 0], gpu_order: 'as_given', gpu_cards: { 0: 'RTX 3060', 1: 'RTX 4070 Ti' }, layer_split: 'auto' });
});

test('a hand-edited gpu is shown to win over the roles', () => {
  const { tree } = render({ args: [], gpu_roles: { 0: 'helper', 1: 'main' }, gpu: [1, 0] });
  assert.match(text(tree), /手动修改/);
  assert.match(text(render({ args: [], gpu_roles: { 0: 'helper', 1: 'main' }, gpu: [1, 0] }, { zh: false }).tree), /Strata uses “gpu” and ignores gpu_roles/);
});

test('every card Off is an error for CUDA and a CPU-only warning for Metal', () => {
  const off = { args: [], gpu_roles: { 0: 'off', 1: 'off' }, gpu: [], gpu_none: true };
  const cuda = nodes(render(off).tree).filter(node => node.props.role === 'alert');
  assert.equal(cuda.length, 1);
  assert.match(text(cuda[0]), /至少需要一张主卡或辅助卡/);
  const metal = render({ ...off, backend: 'metal' }).tree;
  assert.equal(nodes(metal).filter(node => node.props.role === 'alert').length, 0);
  assert.match(text(metal), /只用 CPU 运行/);
});
