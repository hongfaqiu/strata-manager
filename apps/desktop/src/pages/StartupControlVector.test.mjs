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
const Slider = props => jsx('slider', props);
const icons = new Proxy({}, { get: (_, name) => props => jsx(`icon:${String(name)}`, props) });
const byTestId = (tree, id) => nodes(tree).find(node => node.props['data-testid'] === id);

function render(draft, { check, engineFlags = null, mac = false } = {}) {
  const applied = [];
  const component = load('./StartupControlVector.tsx', {
    react: { useState: value => [value, () => {}], useEffect: () => {}, useRef: value => ({ current: value }) },
    '@tanstack/react-query': { useQuery: () => ({ data: check, isFetching: false, error: null }) },
    '@strata-manager/core': core,
    '../OfficialControls': { Toggle, Segmented, Slider },
    'lucide-react': icons,
    'react/jsx-runtime': { jsx, jsxs: jsx },
  });
  const tree = component.StartupControlVector({ language: 'zh-CN', draft, disabled: false, desktop: true, showParameterNames: true, engineFlags, mac, onApply: settings => applied.push(settings) });
  return { tree, applied, toggle: nodes(tree).find(node => node.type === Toggle) };
}
const root = 'C:\\Strata';
const bundled = `${root}\\data\\experimental-speed-projection\\Qwen3.8-Flash-Next-experimental-speed-projection.gguf`;
const ok = { path: bundled, status: 'ok', layers: 47, maxLayer: 47 };
const base = { cwd: root, args: ['--native', 'm.gguf', '--serve'] };

test('off by default; compact chip, path with tooltip, notes in one info tooltip, turns on with the upstream preset', () => {
  const { tree, toggle, applied } = render(base, { check: ok });
  assert.equal(toggle.props.checked, false);
  assert.equal(toggle.props.disabled, false);
  const path = byTestId(tree, 'control-vector-path');
  assert.equal(path.props['data-tooltip'], bundled);
  assert.equal(path.props['data-path'], bundled);
  assert.ok(text(path).length <= 72 && text(path).endsWith('Qwen3.8-Flash-Next-experimental-speed-projection.gguf'));
  assert.equal(text(byTestId(tree, 'control-vector-chip')), '随附向量 · 47 层');
  assert.equal(byTestId(tree, 'control-vector-chip').props['data-tone'], 'ok');
  const info = byTestId(tree, 'control-vector-info').props['data-tooltip'];
  assert.match(info, /拒答方向投影/);
  assert.match(info, /4–44/);
  assert.match(info, /add · per-layer/);
  assert.match(info, /Mac/);
  assert.match(text(tree), /experimental_speed_projection/, 'the per-request field stays visible');
  const bars = nodes(byTestId(tree, 'control-vector-strip')).filter(node => node.type === 'span' && node.props['data-on']);
  assert.equal(bars.length, 47);
  assert.equal(bars.filter(bar => bar.props['data-on'] === 'true').length, 41, 'layers 4–44 highlighted');
  assert.ok(!nodes(tree).some(node => node.type === 'details'), 'no folded section');
  toggle.props.onCheckedChange(true);
  assert.deepEqual({ ...applied[0] }, { file: bundled, scale: '1.0', first: '4', last: '44', mode: 'project', direction: 'per-layer' });
});

test('a missing bundled file disables the switch with the reason', () => {
  const { tree, toggle } = render(base, { check: { path: bundled, status: 'missing', layers: 0 } });
  assert.equal(toggle.props.disabled, true);
  assert.match(text(byTestId(tree, 'control-vector-reason')), /随附的控制向量不可用：找不到这个文件/);
  assert.equal(text(byTestId(tree, 'control-vector-chip')), '未找到文件');
  assert.match(toggle.props.tooltip, /找不到这个文件/);
});

test('an older engine and a Mac disable the switch', () => {
  const old = render(base, { check: ok, engineFlags: ['--native', '--serve', '--max-context', '--kv'] });
  assert.equal(old.toggle.props.disabled, true);
  assert.match(text(old.tree), /0\.1\.44/);
  const mac = render(base, { check: ok, mac: true });
  assert.equal(mac.toggle.props.disabled, true);
  assert.match(text(mac.tree), /Mac/);
  assert.equal(text(byTestId(old.tree, 'control-vector-chip')), '需引擎 0.1.44+');
  assert.equal(text(byTestId(mac.tree, 'control-vector-chip')), 'Mac 版暂不支持');
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
  const slider = nodes(tree).find(node => node.type === Slider);
  slider.props.onValueChange(1.5);
  assert.equal(applied.at(-1).scale, '1.5');
  const lastThumb = nodes(tree).find(node => node.type === 'input' && node.props['aria-label'] === '结束层滑块');
  lastThumb.props.onChange({ target: { value: '30' } });
  assert.deepEqual([applied.at(-1).first, applied.at(-1).last], ['4', '30']);
  const strip = byTestId(tree, 'control-vector-strip');
  strip.props.onPointerDown({ clientX: 15, pointerId: 1, currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 470 }) } });
  assert.deepEqual([applied.at(-1).first, applied.at(-1).last], ['2', '44'], 'clicking a bar moves the nearer end');
  const mode = nodes(tree).find(node => node.type === Segmented && node.props.ariaLabel === '控制向量模式');
  mode.props.onValueChange('add');
  assert.equal(applied.at(-1).mode, 'add');
  const direction = nodes(tree).find(node => node.type === Segmented && node.props.ariaLabel === '控制向量方向');
  direction.props.onValueChange('single');
  assert.deepEqual([applied.at(-1).mode, applied.at(-1).direction], ['project', 'single:20']);
  assert.ok(nodes(tree).some(node => node.type === 'button' && text(node) === '恢复上游预设'));
  toggle.props.onCheckedChange(false);
  assert.equal(applied.at(-1), null);
});

test('a custom-file state offers restoring the bundled vector; no cwd disables with a reason', () => {
  const custom = vector.applyControlVector(base, { file: 'D:\\vectors\\mine.gguf', ...vector.CONTROL_VECTOR_PRESET });
  const { tree } = render(custom, { check: { path: 'D:\\vectors\\mine.gguf', status: 'ok', layers: 40, maxLayer: 40 } });
  assert.ok(nodes(tree).some(node => node.type === 'button' && text(node) === '恢复随附向量'));
  assert.ok(nodes(tree).some(node => node.type === 'button' && text(node) === '改用其他文件'));
  assert.equal(text(byTestId(tree, 'control-vector-chip')), '自定义文件 · 40 层');
  const none = render({ args: ['--native', 'm.gguf'] });
  assert.equal(none.toggle.props.disabled, true);
  assert.match(text(byTestId(none.tree, 'control-vector-reason')), /cwd/);
});
