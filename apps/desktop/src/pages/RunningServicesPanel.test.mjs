import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { normalizeError } from '../../../../packages/core/src/errors.ts';

const jsx = (type, props) => ({ type, props: props ?? {} });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree) : !tree || typeof tree !== 'object' ? '' : [tree.props?.children].flat(Infinity).map(text).join('');
const source = ts.transpileModule(readFileSync(new URL('./RunningServicesPanel.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const candidate = { id: 'running-a', name: 'Model A', configPath: 'fixture/a.json', installDir: 'fixture', pythonPath: 'fixture/python', modelPath: 'fixture/model.gguf', modelBytes: null, running: true, pid: 90001, detectedPort: 19091, config: { model_name: 'Model A' } };

function fixture(extra = {}) {
  const slots = [], calls = { connect: [], manage: [], request: [], refresh: 0 };
  let cursor = 0, tree, queries;
  const slot = init => { const index = cursor++; return slots[index] ??= init(); };
  const react = {
    useRef: initial => slot(() => ({ current: initial })),
    useState: initial => { const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial })); return [state.value, next => { state.value = typeof next === 'function' ? next(state.value) : next; }]; },
  };
  const core = { normalizeError, normalizeBaseUrl: url => url,
    request: async (profile, path, method) => { calls.request.push({ profile, path, method }); return { service: 'strata', status: 'ok', loaded: false }; },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: name => ({ react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '@strata-manager/core': core, '../components': { Panel: 'section', Badge: 'badge' }, '@tanstack/react-query': { useQueries: options => { queries = options.queries; return queries.map(() => ({ isSuccess: true, data: { service: 'strata', status: 'ok', loaded: false }, refetch: async () => {} })); } } })[name] ?? {} });
  const props = { candidates: [candidate], language: 'zh-CN', onRefresh: () => calls.refresh++, onConnect: item => { calls.connect.push(item); return extra.connect?.(item); }, onManage: item => { calls.manage.push(item); return extra.manage?.(item); }, ...extra.props };
  const render = () => { cursor = 0; tree = module.exports.RunningServicesPanel(props); return tree; };
  const button = name => nodes(tree).find(node => node.type === 'button' && text(node).trim() === name);
  const settle = async () => { await tick(); render(); };
  render();
  return { calls, props, render, button, settle, tree: () => tree, queries: () => queries };
}

test('unloaded services keep the model identity and offer explicit connect and management actions', () => {
  const f = fixture();
  assert.equal(text(nodes(f.tree()).find(node => node.type === 'h3')), 'Model A');
  assert.ok(text(f.tree()).includes('模型未加载'));
  assert.ok(f.button('连接管理后台')); assert.ok(f.button('托管此服务'));
  assert.equal(f.calls.connect.length, 0); assert.equal(f.calls.manage.length, 0);
});

test('observation only reads health and never imports, connects, starts or stops a service', async () => {
  const f = fixture();
  for (const query of f.queries()) await query.queryFn();
  assert.equal(f.calls.request.length, 1);
  assert.deepEqual(f.calls.request.map(call => [call.path, call.method, call.profile.managed]), [['/health', 'GET', false]]);
  assert.equal(f.calls.connect.length, 0); assert.equal(f.calls.manage.length, 0);
});

test('pending operations cannot be repeated or crossed with another lifecycle action', async () => {
  const waiting = deferred(), f = fixture({ connect: () => waiting.promise });
  const connect = f.button('连接管理后台'), manage = f.button('托管此服务');
  connect?.props.onClick(); connect?.props.onClick(); manage?.props.onClick(); f.render();
  assert.equal(f.calls.connect.length, 1); assert.equal(f.calls.manage.length, 0);
  assert.equal(f.button('正在连接…').props.disabled, true);
  assert.equal(f.button('托管此服务').props.disabled, true);
  assert.equal(f.button('正在连接…').props['aria-busy'], true);
  waiting.resolve(); await f.settle();
  assert.equal(f.button('连接管理后台').props.disabled, false);
  assert.equal(f.calls.connect[0], candidate);
});

test('a failed connection shows its normalized message and keeps health and safe management available', async () => {
  const f = fixture({ connect: async () => { throw 'HTTP 409: {"code":"EXTERNAL_OWNER","message":"服务已由其他管理器托管","details":{"private":"trace"}}'; } });
  f.button('连接管理后台')?.props.onClick(); await f.settle();
  const alert = nodes(f.tree()).find(node => node.props.role === 'alert');
  assert.ok(alert); assert.match(text(alert), /服务已由其他管理器托管/); assert.doesNotMatch(text(alert), /private|trace|HTTP 409/);
  assert.equal(f.calls.manage.length, 0); assert.equal(f.button('托管此服务').props.disabled, false);
  assert.equal(nodes(f.tree()).filter(node => node.type === 'article').length, 1);
  await f.queries()[0].queryFn(); assert.equal(f.calls.request.length, 1);
  f.button('托管此服务').props.onClick(); await f.settle();
  assert.equal(f.calls.manage.length, 1); assert.equal(nodes(f.tree()).find(node => node.props.role === 'alert'), undefined);
});

test('callbacks remain optional and background scans do not disable management controls', () => {
  const readOnly = fixture({ props: { onConnect: undefined, onManage: undefined } });
  assert.equal(readOnly.button('连接管理后台'), undefined); assert.equal(readOnly.button('托管此服务'), undefined);
  const refreshing = fixture({ props: { loading: true } });
  assert.equal(refreshing.button('连接管理后台')?.props.disabled, false);
  assert.equal(refreshing.button('托管此服务')?.props.disabled, false);
});
