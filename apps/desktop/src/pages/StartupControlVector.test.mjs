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
// Control vectors are Qwen-engine options; the DeepSeek option table (deepseek41-config) is stubbed out.
const deepseek41 = { isDeepseek41Config: config => config?.arch === 'deepseek41', DEEPSEEK41_ENGINE_FLAGS: {}, deepseek41ArgsError: () => null };
const tuning = load('../../../../packages/core/src/config-tuning.ts', { './startup-engine-flags': flags, './deepseek41-config': deepseek41 });
const vector = load('../../../../packages/core/src/control-vector.ts', { './config-tuning': tuning, './engine-flag-support': support });
const core = { ...vector, normalizeError: error => ({ message: String(error) }) };
const Toggle = props => jsx('toggle', props);
const Segmented = props => jsx('segmented', props);
const Slider = props => jsx('slider', props);
const OfficialDialog = props => jsx('dialog', props);
const icons = new Proxy({}, { get: (_, name) => props => jsx(`icon:${String(name)}`, props) });
const byTestId = (tree, id) => nodes(tree).find(node => node.props['data-testid'] === id);

function render(draft, { check, engineFlags = null, mac = false, open = false } = {}) {
  const applied = [];
  const component = load('./StartupControlVector.tsx', {
    react: { useState: value => [value === 'closed' && open ? 'open' : value, () => {}], useEffect: () => {}, useRef: value => ({ current: value }) },
    '@tanstack/react-query': { useQuery: () => ({ data: check, isFetching: false, error: null }) },
    '@strata-manager/core': core,
    '../OfficialControls': { Toggle, Segmented, Slider, OfficialDialog },
    'lucide-react': icons,
    'react/jsx-runtime': { jsx, jsxs: jsx },
  });
  const tree = component.StartupControlVector({ language: 'zh-CN', draft, disabled: false, desktop: true, showParameterNames: true, engineFlags, mac, onApply: settings => applied.push(settings) });
  return { tree, applied, toggle: nodes(tree).find(node => node.type === Toggle), dialog: nodes(tree).find(node => node.type === OfficialDialog) };
}
const root = 'C:\\Strata';
const bundled = `${root}\\data\\experimental-speed-projection\\Qwen3.8-Flash-Next-experimental-speed-projection.gguf`;
const ok = { path: bundled, status: 'ok', layers: 47, maxLayer: 47 };
const base = { cwd: root, args: ['--native', 'm.gguf', '--serve'] };

const technical = /control-vector|cvec|--|\.gguf|per-layer|project|层/;

test('off by default: one plain switch, no jargon on the main surface, turns on with the upstream preset', () => {
  const { tree, toggle, applied, dialog } = render(base, { check: ok });
  assert.equal(toggle.props.checked, false);
  assert.equal(toggle.props.disabled, false);
  assert.equal(toggle.props.ariaLabel, '启用无审查模式');
  assert.equal(dialog, undefined, 'advanced settings are closed by default');
  assert.match(text(tree), /^无审查模式/);
  assert.match(text(tree), /减少模型拒答，使用模型包自带的官方向量。保存并重启模型后生效。/);
  assert.equal(text(byTestId(tree, 'control-vector-status')), '已就绪');
  assert.equal(byTestId(tree, 'control-vector-status').props['data-tone'], 'ok');
  assert.doesNotMatch(text(tree).replace('高级设置', ''), technical, 'no paths, layers, modes or flags on the main surface');
  assert.equal(byTestId(tree, 'control-vector-strip'), undefined);
  assert.equal(byTestId(tree, 'control-vector-note'), undefined, 'the note only shows when on');
  assert.ok(byTestId(tree, 'control-vector-open-advanced'));
  assert.ok(!nodes(tree).some(node => node.type === 'details'), 'no folded section');
  toggle.props.onCheckedChange(true);
  assert.deepEqual({ ...applied[0] }, { file: bundled, scale: '1.0', first: '4', last: '44', mode: 'project', direction: 'per-layer' });
});

test('the advanced dialog holds the path, layer strip, notes and per-request field', () => {
  const { dialog } = render(base, { check: ok, open: true });
  assert.ok(dialog, 'opens as a dialog, not inline');
  assert.equal(dialog.props.title, '无审查模式 · 高级设置');
  assert.match(text(dialog), /控制向量（Control Vector）/);
  const path = byTestId(dialog, 'control-vector-path');
  assert.equal(path.props['data-tooltip'], bundled);
  assert.ok(text(path).length <= 72 && text(path).endsWith('Qwen3.8-Flash-Next-experimental-speed-projection.gguf'));
  assert.equal(text(byTestId(dialog, 'control-vector-chip')), '随附向量 · 47 层');
  const notes = text(byTestId(dialog, 'control-vector-notes'));
  assert.match(notes, /拒答方向投影/);
  assert.match(notes, /4–44/);
  assert.match(notes, /add · per-layer/);
  assert.match(notes, /Mac/);
  assert.match(text(dialog), /"experimental_speed_projection": false/);
  const bars = nodes(byTestId(dialog, 'control-vector-strip')).filter(node => node.type === 'span' && node.props['data-on']);
  assert.equal(bars.length, 47);
  assert.equal(bars.filter(bar => bar.props['data-on'] === 'true').length, 41, 'layers 4–44 highlighted');
  assert.ok(nodes(dialog).some(node => node.type === 'button' && text(node) === '改用其他文件'));
});

test('a missing bundled file disables the switch with a plain reason; the technical one is in the tooltip and dialog', () => {
  const { tree, toggle } = render(base, { check: { path: bundled, status: 'missing', layers: 0 } });
  assert.equal(toggle.props.disabled, true);
  assert.equal(text(byTestId(tree, 'control-vector-status')), '未找到向量');
  assert.match(text(byTestId(tree, 'control-vector-plain-reason')), /没有找到模型包自带的向量文件/);
  assert.match(toggle.props.tooltip, /找不到这个文件/);
  const { dialog } = render(base, { check: { path: bundled, status: 'missing', layers: 0 }, open: true });
  assert.match(text(byTestId(dialog, 'control-vector-reason')), /随附的控制向量不可用：找不到这个文件/);
  assert.equal(text(byTestId(dialog, 'control-vector-chip')), '未找到文件');
});

test('an older engine and a Mac disable the switch', () => {
  const old = render(base, { check: ok, engineFlags: ['--native', '--serve', '--max-context', '--kv'] });
  assert.equal(old.toggle.props.disabled, true);
  assert.match(text(old.tree), /0\.1\.44/);
  assert.match(old.toggle.props.tooltip, /--control-vector-scaled/);
  const mac = render(base, { check: ok, mac: true });
  assert.equal(mac.toggle.props.disabled, true);
  assert.match(text(mac.tree), /Mac/);
  assert.equal(text(byTestId(old.tree, 'control-vector-status')), '需引擎 0.1.44+');
  assert.equal(text(byTestId(mac.tree, 'control-vector-status')), 'Mac 版暂不支持');
});

test('when on: the note shows, edits in the dialog apply, the switch turns it off', () => {
  const on = vector.applyControlVector(base, { file: bundled, ...vector.CONTROL_VECTOR_PRESET });
  const { tree, toggle, applied, dialog } = render(on, { check: ok, open: true });
  assert.equal(toggle.props.checked, true);
  assert.match(text(byTestId(tree, 'control-vector-note')), /模型会回答更多原本拒绝的问题，请自行把关内容。/);
  assert.equal(byTestId(tree, 'control-vector-customized'), undefined, 'the upstream preset is not "customized"');
  const strength = nodes(dialog).find(node => node.type === 'input' && node.props['aria-label'] === '强度');
  assert.equal(strength.props.value, '1.0');
  strength.props.onChange({ target: { value: '0.5' } });
  assert.equal(applied.at(-1).scale, '0.5');
  const first = nodes(dialog).find(node => node.type === 'input' && node.props['aria-label'] === '起始层');
  first.props.onChange({ target: { value: '50' } });
  assert.equal(applied.length, 1, 'an invalid range is not applied');
  const slider = nodes(dialog).find(node => node.type === Slider);
  slider.props.onValueChange(1.5);
  assert.equal(applied.at(-1).scale, '1.5');
  const lastThumb = nodes(dialog).find(node => node.type === 'input' && node.props['aria-label'] === '结束层滑块');
  lastThumb.props.onChange({ target: { value: '30' } });
  assert.deepEqual([applied.at(-1).first, applied.at(-1).last], ['4', '30']);
  const strip = byTestId(dialog, 'control-vector-strip');
  strip.props.onPointerDown({ clientX: 15, pointerId: 1, currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 470 }) } });
  assert.deepEqual([applied.at(-1).first, applied.at(-1).last], ['2', '44'], 'clicking a bar moves the nearer end');
  const mode = nodes(dialog).find(node => node.type === Segmented && node.props.ariaLabel === '控制向量模式');
  mode.props.onValueChange('add');
  assert.equal(applied.at(-1).mode, 'add');
  const direction = nodes(dialog).find(node => node.type === Segmented && node.props.ariaLabel === '控制向量方向');
  direction.props.onValueChange('single');
  assert.deepEqual([applied.at(-1).mode, applied.at(-1).direction], ['project', 'single:20']);
  assert.ok(nodes(dialog).some(node => node.type === 'button' && text(node) === '恢复上游预设'));
  toggle.props.onCheckedChange(false);
  assert.equal(applied.at(-1), null);
  const tuned = render(vector.applyControlVector(base, { file: bundled, ...vector.CONTROL_VECTOR_PRESET, scale: '0.8' }), { check: ok });
  assert.equal(text(byTestId(tuned.tree, 'control-vector-customized')), '已自定义');
});

test('a custom-file state is "customized" and offers restoring the bundled vector; no cwd disables with a reason', () => {
  const custom = vector.applyControlVector(base, { file: 'D:\\vectors\\mine.gguf', ...vector.CONTROL_VECTOR_PRESET });
  const { tree, dialog } = render(custom, { check: { path: 'D:\\vectors\\mine.gguf', status: 'ok', layers: 40, maxLayer: 40 }, open: true });
  assert.equal(text(byTestId(tree, 'control-vector-customized')), '已自定义');
  assert.ok(nodes(dialog).some(node => node.type === 'button' && text(node) === '恢复随附向量'));
  assert.ok(nodes(dialog).some(node => node.type === 'button' && text(node) === '改用其他文件'));
  assert.equal(text(byTestId(dialog, 'control-vector-chip')), '自定义文件 · 40 层');
  const none = render({ args: ['--native', 'm.gguf'] });
  assert.equal(none.toggle.props.disabled, true);
  assert.match(text(byTestId(none.tree, 'control-vector-plain-reason')), /cwd/);
  assert.match(none.toggle.props.tooltip, /cwd/);
});
