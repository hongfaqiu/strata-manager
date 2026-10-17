import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as calibration from '../../../../../packages/core/src/calibration.ts';

// Minimal JSX runtime: function components are expanded so the whole tree can be inspected.
const jsx = (type, props) => ({ type, props: props ?? {} });
const expand = tree => {
  if (Array.isArray(tree)) return tree.map(expand);
  if (!tree || typeof tree !== 'object') return tree;
  if (typeof tree.type === 'function') return expand(tree.type(tree.props));
  return { ...tree, props: { ...tree.props, children: expand(tree.props.children) } };
};
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree) : !tree || typeof tree !== 'object' ? '' : Array.isArray(tree) ? tree.map(text).join('') : text(tree.props?.children);
const compiled = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const load = (file, dependencies) => { const module = { exports: {} }; vm.runInNewContext(compiled(file), { module, exports: module.exports, require: name => dependencies[name] ?? {}, console, Date, Math, Number, JSON, Object, Array, Set, String }); return module.exports; };
const icons = new Proxy({}, { get: () => () => null });
const react = { useEffect: () => {}, useRef: value => ({ current: value }) };
const runtime = { jsx, jsxs: jsx, Fragment: 'fragment' };
const strings = load('./strings.ts', {});
const live = load('./TuningLive.tsx', { 'react/jsx-runtime': runtime, react, 'lucide-react': icons });
const view = load('./QuickCalibration.tsx', { 'react/jsx-runtime': runtime, react, 'lucide-react': icons, '@strata-manager/core': calibration, './TuningLive': live });

const pcieStep = { kind: 'pcieFrac', status: 'done', metric: 'decode', values: [0.2, 0.35, 0.55], currentValue: 0.55, rounds: 2, requests: 18, best: 0.35, chosen: 0.35,
  samples: [{ value: 0.2, round: 0, rate: 31 }, { value: 0.35, round: 0, rate: 39 }, { value: 0.35, round: 1, rate: 40 }, { value: 0.55, round: 0, rate: 36 }, { value: 0.55, round: 1, rate: 36.4 }], excluded: [{ value: 0, reason: 'amdPcieZero' }] };
const job = (overrides = {}) => ({ id: 'c', profileId: 'a', kind: 'quickCalibrate', state: 'completed', startedAt: 0, updatedAt: 0, finishedAt: 1, backend: 'hip', layerSplit: false, rounds: 3, minGain: 0.03,
  baseline: { pcieFrac: 0.55, specMinP: 0.5 }, recommended: { pcieFrac: 0.35, specMinP: 0.5 }, settings: { '--pcie-frac': '0.35', '--spec-min-p': '0.50' }, gain: 0.0856, baseRate: 36.2, tunedRate: 39.3,
  steps: [{ kind: 'warmup', status: 'done', metric: 'decode', values: [], rounds: 2, requests: 6, samples: [] }, pcieStep], completedRequests: 105, totalRequests: 105, restartSuggestions: [], identity: {}, configFingerprint: 'x', notes: [], ...overrides });
const props = (overrides = {}) => ({ job: job(), live: null, text: strings.calibrationText('zh-CN'), language: 'zh-CN', states: { running: '测量中' }, clock: 1000, busy: false, canApply: true, notice: null,
  onCancel() {}, onSaveVersion() {}, onOverwrite() {}, onVerify() {}, onBenchmark() {}, ...overrides });
const byTestId = (tree, id) => nodes(tree).filter(node => node.props?.['data-testid'] === id);

test('zh and en tables carry the same non-empty strings', () => {
  const { zh, en } = strings.calibrationStringTables;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const table of [zh, en]) for (const [key, value] of Object.entries(table)) assert.ok(value.trim(), key);
});

test('the tuning page never folds content into <details>', () => {
  for (const file of ['../TuningPage.tsx', './QuickCalibration.tsx', './TuningLive.tsx']) assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /<details|<summary/);
});

test('the sweep chart marks the winner, the current value, the 3% bar and the AMD exclusion', () => {
  const tree = expand(jsx(live.SweepChart, { title: 'PCIe', metric: 'tok/s', points: calibration.sweepPoints(pcieStep), minGain: 0.03, text: strings.calibrationText('zh-CN'), language: 'zh-CN' }));
  const groups = nodes(tree).filter(node => typeof node.props?.className === 'string' && node.props.className.startsWith('tuning-sweep-point'));
  assert.equal(groups.length, 4);
  assert.match(groups[0].props.className, /is-excluded/);
  assert.equal(text(groups[0]).includes('×'), true);
  assert.match(groups[2].props.className, /is-chosen/);
  assert.match(groups[3].props.className, /is-current/);
  assert.equal(nodes(tree).filter(node => node.props?.className === 'tuning-sweep-bar').length, 1);
  const empty = expand(jsx(live.SweepChart, { title: 'MTP', metric: 'tok/s', points: calibration.sweepPoints({ ...pcieStep, samples: [], excluded: [], chosen: undefined }), minGain: 0.03, text: strings.calibrationText('en'), language: 'en' }));
  assert.match(text(empty), /Pending/);
});

test('a finished change offers save-as-new-version first, overwrite second, and the opt-in benchmark', () => {
  const tree = expand(jsx(view.QuickCalibrationView, props()));
  const buttons = nodes(tree).filter(node => node.type === 'button').map(node => node.props['data-testid']);
  assert.deepEqual(buttons.slice(0, 4), ['calibration-save-version', 'calibration-overwrite', 'calibration-verify', 'calibration-benchmark']);
  assert.match(text(byTestId(tree, 'tuning-diff')[0]), /0\.55.*0\.35/);
  assert.match(text(tree), /\+8\.6%/);
  assert.equal(byTestId(tree, 'tuning-live').length, 0);
});

test('no change means nothing to save, and a running job shows the live strip instead of a verdict', () => {
  const unchanged = expand(jsx(view.QuickCalibrationView, props({ job: job({ settings: {}, recommended: { pcieFrac: 0.55, specMinP: 0.5 }, gain: undefined }) })));
  assert.equal(byTestId(unchanged, 'calibration-save-version').length, 0);
  assert.equal(byTestId(unchanged, 'calibration-overwrite').length, 0);
  assert.match(text(unchanged), /当前参数已经是最快的/);
  const snapshot = { jobId: 'c', stepKey: 'pcieFrac', stepIndex: 2, stepTotal: 4, parameters: { pcieFrac: 0.75, specMinP: 0.5 }, round: 2, rounds: 3, completedUnits: 40, totalUnits: 105, runningSince: 0, etaMs: 60000, request: { startedAt: 0, deltas: 10, firstTokenMs: 100, tokS: 35.4 }, lastTokS: 35, log: [{ at: 0, key: 'sample', detail: { step: 'pcieFrac', value: 0.75, round: 2, rate: 35.1 } }], updatedAt: 0 };
  const running = expand(jsx(view.QuickCalibrationView, props({ job: job({ state: 'running', settings: {}, gain: undefined, recommended: undefined, completedRequests: 38, steps: [{ ...pcieStep, status: 'running', chosen: undefined }] }), live: snapshot })));
  assert.equal(byTestId(running, 'tuning-calibration-result').length, 0);
  const strip = byTestId(running, 'tuning-live')[0];
  assert.match(text(strip), /35\.4/);
  assert.match(text(strip), /40 \/ 105/);
  assert.equal(nodes(strip).find(node => node.props?.role === 'progressbar').props['aria-valuenow'], 40);
  assert.match(text(byTestId(running, 'tuning-log')[0]), /PCIe 专家比例/);
});
