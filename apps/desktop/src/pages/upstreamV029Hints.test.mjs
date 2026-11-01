import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Strata 0.2.9 / engine 0.1.55 (upstream #4841): engine-owned parallel switches, recalibrate after an engine upgrade, all-cards default.
const jsx = (type, props) => ({ type, props: props ?? {} });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const text = tree => nodes(tree).flatMap(node => [node.props.children].flat(Infinity)).filter(child => typeof child === 'string' || typeof child === 'number').join('');
const byId = (tree, id) => nodes(tree).find(node => node.props['data-testid'] === id);
const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const load = (file, modules) => { const module = { exports: {} }; vm.runInNewContext(compile(file), { module, exports: module.exports, require: name => modules[name] ?? {} }); return module.exports; };
const runtime = { jsx, jsxs: jsx, Fragment: 'fragment' };

test('recalibrate notice names both engines in zh and en and wires both buttons', () => {
  const { RecalibrateNotice } = load('./tuning/RecalibrateNotice.tsx', { 'react/jsx-runtime': runtime, 'lucide-react': { RotateCcw: () => null } });
  const calls = [];
  const zh = RecalibrateNotice({ language: 'zh-CN', from: '0.1.54', to: '0.1.55', onStart: () => calls.push('start'), onDismiss: () => calls.push('dismiss') });
  assert.match(text(zh), /引擎已升级，建议重新校准/);
  assert.match(text(zh), /引擎 0\.1\.54 上测的.*现在用的是 0\.1\.55/);
  byId(zh, 'recalibrate-start').props.onClick();
  byId(zh, 'recalibrate-dismiss').props.onClick();
  assert.deepEqual(calls, ['start', 'dismiss']);
  const en = RecalibrateNotice({ language: 'en-US', from: '0.1.54', to: '0.1.55', disabled: true, onStart: () => {}, onDismiss: () => {} });
  assert.match(text(en), /Engine upgraded: recalibrate.*engine 0\.1\.54.*now runs 0\.1\.55/);
  assert.equal(byId(en, 'recalibrate-start').props.disabled, true);
});

test('automatic GPU selection explains the 0.2.9 all-cards default in zh and en; choosing GPUs hides it', () => {
  const gpu = load('./GpuSelector.tsx', { 'react/jsx-runtime': runtime, '@strata-manager/core': { normalizeGpuSelection: v => v, isIntegratedGpuName: name => /UHD|Radeon\(TM\) Graphics/.test(name) }, '../OfficialControls': { Checkbox: () => null } });
  assert.match(gpu.multiGpuAutoNote(true), /0\.2\.9 起.*DeepSeek 在 Linux 上用上全部 AMD 显卡.*Windows 上 AMD 仍只用一张.*Qwen 用多张 AMD 显卡仍需.*strata launch --gpu N/);
  assert.match(gpu.multiGpuAutoNote(false), /from Strata 0\.2\.9.*every AMD card on Linux.*AMD on Windows still uses one card.*strata launch --gpu N; it is remembered/);
  const two = [{ id: 0, name: 'NVIDIA GeForce RTX 4090 (24 GB)' }, { id: 1, name: 'NVIDIA GeForce RTX 3090 (24 GB)' }];
  const note = props => byId(gpu.GpuSelector({ language: 'zh-CN', value: '', onChange: () => {}, ...props }), 'gpu-auto-all-cards');
  assert.ok(note({ availableGpus: two }), 'two detected discrete cards show the note');
  assert.equal(note({ availableGpus: two, value: '0' }), undefined, 'choosing GPUs hides it');
  assert.equal(note({ availableGpus: [two[0]] }), undefined, 'one card: nothing');
  assert.equal(note({ availableGpus: [two[0], { id: 1, name: 'Intel(R) UHD Graphics 770' }] }), undefined, 'an iGPU beside a dGPU does not count');
  // Nothing detected (browser preview, hardware read pending or failed): no simulated cards, so no note and no card list.
  assert.equal(note({}), undefined);
  assert.equal(note({ availableGpus: [] }), undefined);
  const ids = gpu.GpuSelector({ language: 'zh-CN', value: '0', onChange: () => {} });
  assert.match(text(ids), /未检测到显卡列表/);
  assert.doesNotMatch(text(ids), /模拟|RTX 4090/);
});

test('the concurrency comparison drops its experimental toggle when the engine owns the switches', () => {
  const view = load('./tuning/ConcurrencyComparison.tsx', { 'react/jsx-runtime': runtime, 'lucide-react': {}, '../../OfficialControls': { Toggle: props => jsx('toggle', props) }, '../ConcurrencyChart': { ConcurrencyChart: () => null } });
  const props = { zh: true, candidates: [], recommended: 4, state: { phase: 'idle', candidates: [], versions: {}, results: [] }, experimental: false, canSave: true, canRun: true };
  const before = view.ConcurrencyComparisonView(props);
  assert.equal(byId(before, 'concurrency-comparison-engine-defaults'), undefined);
  assert.match(text(before), /加入实验开关候选/);
  const after = view.ConcurrencyComparisonView({ ...props, serverDefaults: true });
  assert.match(text(byId(after, 'concurrency-comparison-engine-defaults')), /引擎 0\.1\.55 起.*不再单独对比/);
  assert.doesNotMatch(text(after), /加入实验开关候选/);
  assert.match(text(view.ConcurrencyComparisonView({ ...props, zh: false, serverDefaults: true })), /From engine 0\.1\.55 the engine turns on/);
});

test('the GPU list comes from the native hardware read, labelled with each card\'s memory', () => {
  const { gpuOptionsFromHardware } = load('./useDetectedGpus.ts', { '@tanstack/react-query': { useQuery: () => ({}) }, '@strata-manager/core': {} });
  assert.deepEqual(JSON.parse(JSON.stringify(gpuOptionsFromHardware([{ id: 0, name: 'NVIDIA GeForce RTX 4090', totalBytes: 24 * 2 ** 30 }, { id: 1, name: 'AMD Radeon PRO W7900', totalBytes: null }]))),
    [{ id: 0, name: 'NVIDIA GeForce RTX 4090 (24 GB)' }, { id: 1, name: 'AMD Radeon PRO W7900' }]);
  assert.equal(gpuOptionsFromHardware(undefined).length, 0);
});
