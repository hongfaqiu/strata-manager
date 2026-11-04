import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const jsx = (type, props) => ({ type, props: props ?? {} });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const text = tree => nodes(tree).flatMap(node => [node.props.children].flat(Infinity)).filter(child => typeof child === 'string' || typeof child === 'number').join('');
const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const drafting = { exports: {} };
vm.runInNewContext(compile('../../../../packages/core/src/drafting.ts'), { module: drafting, exports: drafting.exports, require: () => ({}) });
const Segmented = props => jsx('segmented', props);
const Dflash2Download = props => jsx('dflash2-download', props);
const control = { exports: {} };
vm.runInNewContext(compile('./StartupDraftingControl.tsx'), { module: control, exports: control.exports, require: name => ({ '@strata-manager/core': drafting.exports, '../OfficialControls': { Segmented }, './Dflash2Download': { Dflash2Download }, 'react/jsx-runtime': { jsx, jsxs: jsx } })[name] ?? {} });
const { StartupDraftingControl } = control.exports;
const render = (config, extra = {}) => { const changes = []; const tree = StartupDraftingControl({ zh: true, config, disabled: false, showParameterNames: false, onChange: next => changes.push(JSON.parse(JSON.stringify(next))), ...extra }); return { tree, changes, segmented: nodes(tree).find(node => node.type === Segmented) }; };
const mtpArgs = { args: ['--native', 'm.gguf', '--mtp', 'D:\\data\\mtp\\rt', '--spec'] };

test('offers Auto / MTP / Off; DFlash2 stays hidden without a capability', () => {
  const { segmented, tree } = render(mtpArgs, { engineVersion: '0.1.51' });
  assert.deepEqual([...segmented.props.options.map(o => o.label)], ['自动', 'MTP', '关']);
  assert.equal(segmented.props.value, 'auto');
  assert.match(text(tree), /预测（投机解码）/);
  const en = render(mtpArgs, { zh: false, engineVersion: '0.1.51' });
  assert.deepEqual([...en.segmented.props.options.map(o => o.label)], ['Auto', 'MTP', 'Off']);
  assert.match(text(en.tree), /Drafting \(speculative decoding\)/);
  const served = render({ ...mtpArgs, model_name: 'qwen3.8-flash-next-iq3_s' }, { engineVersion: '0.1.51', dflash2Served: true });
  assert.deepEqual([...served.segmented.props.options.map(o => o.value)], ['auto', 'mtp', 'dflash2', 'off']);
});

test('0.1.48+ writes drafting; 0.1.47 writes mtp:false only for Off', () => {
  const modern = render({ ...mtpArgs, mtp: false }, { engineVersion: '0.1.48' });
  assert.equal(modern.segmented.props.value, 'off');
  modern.segmented.props.onValueChange('mtp');
  assert.deepEqual(modern.changes[0], { ...mtpArgs, drafting: 'mtp' });
  const legacy = render(mtpArgs, { engineVersion: '0.1.47' });
  legacy.segmented.props.onValueChange('off');
  legacy.segmented.props.onValueChange('auto');
  assert.deepEqual(legacy.changes, [{ ...mtpArgs, mtp: false }, mtpArgs]);
  assert.match(text(legacy.tree), /"mtp": false/);
});

test('engines older than 0.1.46 lock the toggle with a note; no draft layer is pointed out', () => {
  const old = render(mtpArgs, { engineVersion: '0.1.45' });
  assert.ok(old.segmented.props.options.every(o => o.disabled));
  old.segmented.props.onValueChange('off');
  assert.equal(old.changes.length, 0);
  assert.match(text(old.tree), /0\.1\.46/);
  assert.match(text(render({ args: ['--native', 'm.gguf'] }, { engineVersion: '0.1.51' }).tree), /没有 MTP 草稿层/);
});

test('engine 0.1.56 offers DFlash2 and says it moves to MTP for 2+ concurrent requests', () => {
  const qwen = { ...mtpArgs, model_name: 'qwen3.8-flash-next-iq3_s' };
  assert.equal(drafting.exports.engineServesDflash2('0.1.56'), true);
  assert.equal(drafting.exports.engineServesDflash2('0.1.55'), false);
  assert.equal(drafting.exports.engineServesDflash2(null), null);
  const single = render(qwen, { engineVersion: '0.1.56', dflash2Served: true });
  assert.deepEqual([...single.segmented.props.options.map(o => o.label)], ['自动', 'MTP', 'DFlash2', '关']);
  assert.match(text(single.tree), /单个请求用 DFlash2/);
  assert.doesNotMatch(text(single.tree), /改用 MTP/);
  const several = render({ ...qwen, parallel: 4 }, { engineVersion: '0.1.56', dflash2Served: true });
  assert.match(text(several.tree), /并发 4 个请求：DFlash2 一次只服务一个请求，将改用 MTP/);
  const batch = render({ ...qwen, args: [...qwen.args, '--batch=2'], drafting: 'dflash2' }, { zh: false, engineVersion: '0.1.56', dflash2Served: true });
  assert.match(text(batch.tree), /2 concurrent requests: DFlash2 serves one request at a time/);
  assert.doesNotMatch(text(render({ ...qwen, parallel: 4, drafting: 'mtp' }, { engineVersion: '0.1.56', dflash2Served: true }).tree), /改用 MTP/);
  // Auto on one request needs no --mtp layer once DFlash2 is served.
  assert.doesNotMatch(text(render({ args: ['--native', 'm.gguf'], model_name: 'qwen3.8-flash-next-iq3_s' }, { engineVersion: '0.1.56', dflash2Served: true }).tree), /没有 MTP 草稿层/);
});

test('a managed Qwen3.8 offers 「下载 DFlash2」; a start never downloads it (no first-start wording)', () => {
  const qwen = { ...mtpArgs, model_name: 'qwen3.8-flash-next-unsloth-ud-q4_k_xl' };
  const profile = { id: 'p', managed: true, configPath: '/c.json' };
  const download = tree => nodes(tree).find(node => node.type === Dflash2Download);
  const single = render(qwen, { engineVersion: '0.1.56', dflash2Served: true, profile });
  assert.equal(download(single.tree)?.props.profile, profile);
  assert.match(text(single.tree), /需先点「下载 DFlash2」，约 1\.2 GB；启动时不会自动下载/);
  assert.doesNotMatch(text(single.tree), /首次下载/);
  assert.doesNotMatch(text(render(qwen, { zh: false, engineVersion: '0.1.56', dflash2Served: true, profile }).tree), /on first start/);
  assert.equal(download(render({ ...qwen, parallel: 2 }, { engineVersion: '0.1.56', dflash2Served: true, profile }).tree), undefined, 'MTP runs for 2+ requests');
  assert.equal(download(render({ ...qwen, drafting: 'mtp' }, { engineVersion: '0.1.56', dflash2Served: true, profile }).tree), undefined);
  assert.equal(download(render(qwen, { engineVersion: '0.1.56', dflash2Served: true, profile: { ...profile, managed: false } }).tree), undefined, 'a connected external service has no runtime to run fetch in');
  assert.equal(download(render(qwen, { engineVersion: '0.1.55', dflash2Served: false, profile }).tree), undefined);
});
