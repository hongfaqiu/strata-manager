import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const jsx = (type, props) => ({ type, props: props ?? {} });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const source = ts.transpileModule(readFileSync(new URL('./ModelConfigurationDropdown.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture(extra = {}) {
  const slots = [], calls = { selected: [], deleted: [], focused: [] };
  let cursor = 0, tree;
  const slot = init => { const index = cursor++; return slots[index] ??= init(index); };
  const react = {
    useId: () => slot(index => `id-${index}`), useRef: value => slot(() => ({ current: value })),
    useState: value => { const state = slot(() => ({ value })); return [state.value, next => { state.value = typeof next === 'function' ? next(state.value) : next; }]; },
    useEffect: () => {}, useLayoutEffect: () => {},
  };
  const props = { value: 'first', options: [{ value: 'first', name: 'first.json', filePath: 'D:\\Model\\first.json' }, { value: 'second', name: 'second.json', filePath: 'D:\\Model\\second.json' }], language: 'zh-CN', ariaLabel: 'Model configurations', modifiedLabel: '修改日期', onValueChange: value => calls.selected.push(value), onDelete: value => calls.deleted.push(value), ...extra };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, document: { body: {} }, require: name => ({ react, 'react-dom': { createPortal: child => child }, 'react/jsx-runtime': { jsx, jsxs: jsx } })[name] ?? {} });
  const render = () => {
    cursor = 0; tree = module.exports.ModelConfigurationDropdown(props);
    const trigger = nodes(tree).find(node => node.props.role === 'combobox');
    trigger.props.ref.current = { focus: () => calls.focused.push('trigger') };
    const menu = nodes(tree).find(node => node.props.role === 'listbox');
    if (menu) menu.props.ref.current = { querySelector: selector => ({ focus: () => calls.focused.push(selector) }) };
    return tree;
  };
  const trigger = () => nodes(tree).find(node => node.props.role === 'combobox');
  const actions = () => nodes(tree).filter(node => node.props.className === 'model-configuration-delete');
  render();
  return { props, calls, render, trigger, actions, tree: () => tree };
}

test('row delete buttons are siblings, close the dropdown, and never select either configuration', () => {
  const f = fixture(); f.trigger().props.onClick(); f.render();
  const rows = nodes(f.tree()).filter(node => node.props.className?.startsWith('model-configuration-row'));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(nodes(row).filter(node => node.type === 'button').length, 2);
    for (const button of nodes(row).filter(node => node.type === 'button')) assert.equal(nodes(button).slice(1).some(node => node.type === 'button'), false);
  }
  let stopped = 0;
  const action = f.actions()[1];
  action.props.onPointerDown({ stopPropagation: () => stopped++ });
  action.props.onClick({ stopPropagation: () => stopped++ }); f.render();
  assert.deepEqual(f.calls.deleted, ['second']); assert.deepEqual(f.calls.selected, []);
  assert.equal(stopped, 2); assert.equal(f.trigger().props['aria-expanded'], false);
  assert.equal(f.actions().length, 0);
});

test('keyboard Tab reaches the active delete action; Shift+Tab returns to the selector without selection', () => {
  const f = fixture(); let prevented = 0;
  const key = (value, shiftKey = false) => ({ key: value, shiftKey, preventDefault: () => prevented++ });
  f.trigger().props.onKeyDown(key('ArrowDown')); f.render();
  f.trigger().props.onKeyDown(key('ArrowDown')); f.render();
  f.trigger().props.onKeyDown(key('Tab'));
  assert.ok(f.calls.focused.includes('[data-delete-index="1"]'));
  assert.equal(f.actions()[1].props.tabIndex, 0);
  f.actions()[1].props.onKeyDown(key('Tab', true));
  assert.equal(f.calls.focused.at(-1), 'trigger'); assert.ok(prevented >= 3);
  assert.deepEqual(f.calls.selected, []); assert.deepEqual(f.calls.deleted, []);
});

test('unavailable delete callbacks have no action, and a disabled popup never dispatches selection or deletion', () => {
  const readOnly = fixture({ onDelete: undefined }); readOnly.trigger().props.onClick(); readOnly.render();
  assert.equal(readOnly.actions().length, 0);
  const f = fixture(); f.trigger().props.onClick(); f.render(); f.props.disabled = true; f.render();
  f.actions()[0].props.onClick({ stopPropagation: () => {} });
  nodes(f.tree()).find(node => node.props.role === 'option').props.onClick();
  assert.deepEqual(f.calls.deleted, []); assert.deepEqual(f.calls.selected, []);
});
