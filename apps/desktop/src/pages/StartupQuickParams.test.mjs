import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const jsx = (type, props) => ({ type, props: props ?? {} });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const text = tree => nodes(tree).flatMap(node => [node.props.children].flat(Infinity)).filter(child => typeof child === 'string').join('');
const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const support = { exports: {} };
vm.runInNewContext(compile('../../../../packages/core/src/engine-flag-support.ts'), { module: support, exports: support.exports });
const fields = ['parallel', '--batch', '--batch-mtp', 'idle_unload_s', '--vram-elastic'].map(key => ({ key, zh: key, en: key, kind: key === '--vram-elastic' ? 'boolean' : 'text', group: 'server' }));
const core = { STARTUP_TUNING_FIELDS: fields, engineFlagSupport: support.exports.engineFlagSupport };
const Dropdown = props => jsx('dropdown', props);

function render(extra) {
  const module = { exports: {} };
  vm.runInNewContext(compile('./StartupQuickParams.tsx'), { module, exports: module.exports, require: name => ({ '@strata-manager/core': core, '../OfficialControls': { Dropdown }, 'react/jsx-runtime': { jsx, jsxs: jsx } })[name] ?? {} });
  return module.exports.StartupQuickParams({ language: 'zh-CN', draft: {}, showParameterNames: false, fieldValue: () => '', onFieldChange: () => {}, ...extra });
}

test('a failed engine --help is shown inline and the fields fall back to the catalog', () => {
  const message = '引擎缺少运行库（DLL），无法读取参数列表；不影响已启动的服务（找不到所需的 DLL，0xC0000135）';
  const tree = render({ engineFlags: null, engineHelpError: message });
  const note = nodes(tree).find(node => node.props['data-testid'] === 'engine-help-error');
  assert.ok(note, 'inline note');
  assert.equal(note.props.role, 'status');
  assert.match(text(note), /已按内置参数目录显示/);
  assert.match(text(note), /cublas|0xC0000135/);
  const dropdowns = nodes(tree).filter(node => node.type === Dropdown);
  assert.equal(dropdowns.length, 5);
  assert.ok(dropdowns.every(node => !node.props.disabled), 'catalog fields stay editable');
  assert.ok(nodes(tree).filter(node => node.props['data-engine-support']).every(node => node.props['data-engine-support'] === 'unknown'));
});

test('no note when --help was read', () => {
  const tree = render({ engineFlags: ['--batch', '--batch-mtp', '--vram-elastic'], engineHelpError: null });
  assert.equal(nodes(tree).find(node => node.props['data-testid'] === 'engine-help-error'), undefined);
});
