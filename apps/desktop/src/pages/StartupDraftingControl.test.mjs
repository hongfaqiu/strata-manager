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
const control = { exports: {} };
vm.runInNewContext(compile('./StartupDraftingControl.tsx'), { module: control, exports: control.exports, require: name => ({ '@strata-manager/core': drafting.exports, '../OfficialControls': { Segmented }, 'react/jsx-runtime': { jsx, jsxs: jsx } })[name] ?? {} });
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
