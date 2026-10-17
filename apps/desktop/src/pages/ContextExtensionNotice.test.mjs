import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const jsx = (type, props) => ({ type, props: props ?? {} });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const textOf = tree => tree == null || tree === false ? '' : typeof tree !== 'object' ? String(tree) : [tree.props?.children].flat(Infinity).map(textOf).join(' ');
const compile = url => ts.transpileModule(readFileSync(url, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const core = { exports: {} };
vm.runInNewContext(compile(new URL('../../../../packages/core/src/context-extension.ts', import.meta.url)), { module: core, exports: core.exports });
const module = { exports: {} };
vm.runInNewContext(compile(new URL('./ContextExtensionNotice.tsx', import.meta.url)), { module, exports: module.exports, require: name => name.endsWith('.css') ? {} : name === 'react/jsx-runtime' ? { jsx, jsxs: jsx } : name === '@strata-manager/core' ? core.exports : {} });
const render = props => module.exports.ContextExtensionNotice({ language: 'zh-CN', kv: 'int8', ...props });

test('stays hidden inside the trained 262K window', () => {
  assert.equal(render({ mode: 'setup', context: 262144 }), null);
});
test('a 1M download preset says experimental, yarn ×4 from the installer, memory and expert cache auto', () => {
  const text = textOf(render({ mode: 'setup', context: 1048576 }));
  assert.match(text, /实验性/); assert.match(text, /1M/); assert.match(text, /YaRN ×4/); assert.match(text, /安装器自动设置/);
  assert.match(text, /GiB/); assert.match(text, /专家缓存保持 auto/);
});
test('the config page flags manual, too-small or refused rope settings and offers the official values', () => {
  let applied = false;
  const automatic = render({ mode: 'config', context: 1048576, scaling: 'yarn', scale: '4', onUseRecommended: () => { applied = true; } });
  assert.match(textOf(automatic), /已按官方规则自动设置/);
  assert.equal(nodes(automatic).some(node => node.type === 'button'), false);
  const small = render({ mode: 'config', context: 1048576, scaling: 'yarn', scale: '2', onUseRecommended: () => { applied = true; } });
  assert.match(textOf(small), /倍数低于此上下文所需的 4/);
  nodes(small).find(node => node.type === 'button').props.onClick(); assert.equal(applied, true);
  assert.match(textOf(render({ mode: 'config', context: 524288, scaling: 'none', scale: '' })), /官方安装器也会拒绝/);
  assert.match(textOf(render({ mode: 'config', context: 524288, scaling: 'yarn', scale: '2', expertCache: '8900' })), /固定为 8900/);
  assert.match(textOf(render({ mode: 'setup', context: 1048576, language: 'en' })), /Experimental.*1M\s+context\s+·\s+YaRN ×4/s);
});
