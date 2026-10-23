import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const jsx = (type, props) => ({ type, props: props ?? {} });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const text = tree => nodes(tree).flatMap(node => [node.props.children].flat(Infinity)).filter(child => typeof child === 'string' || typeof child === 'number').join('');
const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const load = (file, modules = {}) => { const module = { exports: {} }; vm.runInNewContext(compile(file), { module, exports: module.exports, structuredClone, require: name => modules[name] ?? {} }); return module.exports; };
const flags = load('../../../../packages/core/src/startup-engine-flags.ts');
const support = load('../../../../packages/core/src/engine-flag-support.ts');
const tuning = load('../../../../packages/core/src/config-tuning.ts', { './startup-engine-flags': flags });
const vector = load('../../../../packages/core/src/control-vector.ts', { './config-tuning': tuning, './engine-flag-support': support });
const core = { ...vector, normalizeError: error => ({ message: String(error) }) };
const Toggle = props => jsx('toggle', props);
const Segmented = props => jsx('segmented', props);
const Dropdown = props => jsx('dropdown', props);

function render(draft, { check, engineFlags = null, mac = false } = {}) {
  const applied = [];
  const component = load('./StartupControlVector.tsx', {
    react: { useState: value => [value, () => {}], useEffect: () => {} },
    '@tanstack/react-query': { useQuery: () => ({ data: check, isFetching: false, error: null }) },
    '@strata-manager/core': core,
    '../OfficialControls': { Toggle, Segmented, Dropdown },
    'react/jsx-runtime': { jsx, jsxs: jsx },
  });
  const tree = component.StartupControlVector({ language: 'zh-CN', draft, disabled: false, desktop: true, showParameterNames: true, engineFlags, mac, onApply: settings => applied.push(settings) });
  return { tree, applied, toggle: nodes(tree).find(node => node.type === Toggle) };
}
const root = 'C:\\Strata';
const bundled = `${root}\\data\\experimental-speed-projection\\Qwen3.8-Flash-Next-experimental-speed-projection.gguf`;
const ok = { path: bundled, status: 'ok', layers: 47, maxLayer: 47 };
const base = { cwd: root, args: ['--native', 'm.gguf', '--serve'] };

test('off by default; shows the bundled path and turns on with the upstream preset', () => {
  const { tree, toggle, applied } = render(base, { check: ok });
  assert.equal(toggle.props.checked, false);
  assert.equal(toggle.props.disabled, false);
  assert.equal(text(nodes(tree).find(node => node.props['data-testid'] === 'control-vector-path')), bundled);
  assert.match(text(tree), /47 层方向/);
  assert.match(text(tree), /拒答方向投影/);
  assert.match(text(tree), /experimental_speed_projection/);
  assert.ok(!nodes(tree).some(node => node.type === 'details'), 'no folded section');
  toggle.props.onCheckedChange(true);
  assert.deepEqual({ ...applied[0] }, { file: bundled, scale: '1.0', first: '4', last: '44', mode: 'project', direction: 'per-layer' });
});

test('a missing bundled file disables the switch with the reason', () => {
  const { tree, toggle } = render(base, { check: { path: bundled, status: 'missing', layers: 0 } });
  assert.equal(toggle.props.disabled, true);
  assert.match(text(nodes(tree).find(node => node.props['data-testid'] === 'control-vector-reason')), /随附的控制向量不可用：找不到这个文件/);
});

test('an older engine and a Mac disable the switch', () => {
  const old = render(base, { check: ok, engineFlags: ['--native', '--serve', '--max-context', '--kv'] });
  assert.equal(old.toggle.props.disabled, true);
  assert.match(text(old.tree), /0\.1\.44/);
  const mac = render(base, { check: ok, mac: true });
  assert.equal(mac.toggle.props.disabled, true);
  assert.match(text(mac.tree), /Mac/);
});

test('when on, edits apply and the switch turns it off', () => {
  const on = vector.applyControlVector(base, { file: bundled, ...vector.CONTROL_VECTOR_PRESET });
  const { tree, toggle, applied } = render(on, { check: ok });
  assert.equal(toggle.props.checked, true);
  const strength = nodes(tree).find(node => node.type === 'input' && node.props['aria-label'] === '强度');
  assert.equal(strength.props.value, '1.0');
  strength.props.onChange({ target: { value: '0.5' } });
  assert.equal(applied.at(-1).scale, '0.5');
  const first = nodes(tree).find(node => node.type === 'input' && node.props['aria-label'] === '起始层');
  first.props.onChange({ target: { value: '50' } });
  assert.equal(applied.length, 1, 'an invalid range is not applied');
  toggle.props.onCheckedChange(false);
  assert.equal(applied.at(-1), null);
});
