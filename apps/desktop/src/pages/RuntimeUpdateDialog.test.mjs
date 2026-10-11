import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { releaseNotes } from '../updateReleaseNotes.ts';
import { configurationPathKey } from '../../../../packages/core/src/model-groups.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const jsx = (type, props) => ({ type, props: props ?? {} });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree) : !tree || typeof tree !== 'object' ? '' : [tree.props?.children].flat(Infinity).map(text).join('');
const source = ts.transpileModule(readFileSync(new URL('./RuntimeUpdateDialog.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const runtime = { id: 'strata', installDir: 'D:\\AI\\Strata', runtimeVersion: '0.1.41' };
const profiles = [
  { id: 'running', name: 'Qwen · 131K', installDir: 'd:/ai/strata/', configPath: 'C:\\Manager\\imports\\running\\config.json', managed: true },
  { id: 'idle', name: 'Qwen · 262K', installDir: runtime.installDir, configPath: 'D:\\AI\\Strata\\262k.json', managed: true },
  { id: 'other-runtime', name: 'Other runtime', installDir: 'D:\\AI\\AnotherStrata', configPath: 'D:\\AI\\AnotherStrata\\config.json', managed: true },
];
const bilingualNotes = '# Strata 0.1.42\n\n## 中文\n\n### 修复\n- 修复路径检测。\n\n## English\n\n### Fixed\n- Fixed path detection.\n\n```json\n{"example": true}\n```\n';

function fixture(overrides = {}) {
  const calls = { installations: 0, statuses: [], mutations: [], confirmed: 0, dismissed: 0 };
  const slots = [], effects = [];
  let cursor = 0, started = false, tree;
  const slot = init => { const index = cursor++; return slots[index] ??= init(index); };
  const sameDeps = (a, b) => a?.length === b?.length && a?.every((value, index) => Object.is(value, b[index]));
  const react = {
    useRef: value => slot(() => ({ current: value })),
    useState: initial => { const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial })); return [state.value, value => { state.value = typeof value === 'function' ? value(state.value) : value; }]; },
    useEffect: (fn, deps) => { const effect = slot(() => ({})); if (!sameDeps(effect.deps, deps)) { effect.deps = deps; effects.push(() => { effect.cleanup?.(); effect.cleanup = fn(); }); } },
  };
  const query = { isSuccess: false, isPending: true, data: undefined, error: null };
  const core = {
    isDesktop: () => true,
    configurationPathKey,
    normalizeError: error => ({ message: error instanceof Error ? error.message : String(error) }),
    localInstallations: async () => { calls.installations++; return overrides.installations ? await overrides.installations() : profiles; },
    serviceStatus: async (id, profile) => {
      calls.statuses.push({ id, profile });
      return overrides.status ? await overrides.status(id, profile) : { running: id === 'running', pid: id === 'running' ? 10152 : null };
    },
  };
  for (const method of ['stop', 'restart', 'start', 'switchLocalService', 'ensureLocalService', 'applyRuntimeUpdate', 'runtimeUpdate', 'takeOverExternal', 'importLocal', 'saveConfig']) {
    core[method] = () => { calls.mutations.push(method); throw new Error(`unexpected mutation: ${method}`); };
  }
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require: name => ({
      react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '@strata-manager/core': core,
      '@tanstack/react-query': { useQuery: options => {
        if (!started && options.enabled !== false) {
          started = true;
          Promise.resolve().then(options.queryFn).then(data => Object.assign(query, { data, isSuccess: true, isPending: false }), error => Object.assign(query, { error, isSuccess: false, isPending: false }));
        }
        return query;
      } },
      'react-markdown': { default: 'markdown' }, 'remark-gfm': { default: 'remark-gfm' },
      '../components': { Dialog: 'dialog' }, '../updateReleaseNotes': { releaseNotes },
    })[name] ?? {},
  });
  const props = {
    language: 'zh-CN', runtime,
    release: { latestVersion: '0.1.42', supportedVersion: '0.1.41', releaseName: 'Strata 0.1.42', notes: bilingualNotes },
    onConfirm: () => { calls.confirmed++; return overrides.confirm?.(); },
    onDismiss: () => calls.dismissed++,
    ...overrides.props,
  };
  const render = () => { cursor = 0; tree = module.exports.RuntimeUpdateDialog(props); while (effects.length) effects.shift()(); return tree; };
  const buttons = () => nodes(tree).filter(node => node.type === 'button');
  const confirm = () => buttons().find(node => node.props.className === 'primary');
  const cancel = () => buttons().find(node => node.props.className !== 'primary');
  const settle = async () => { await tick(); render(); };
  render();
  return { calls, props, query, render, confirm, cancel, settle, tree: () => tree };
}

test('opening and dismissing only read the selected runtime’s profiles and status', async () => {
  const f = fixture(); await f.settle();
  assert.equal(f.calls.installations, 1);
  assert.deepEqual(f.calls.statuses.map(item => item.id), ['running', 'idle']);
  assert.strictEqual(f.calls.statuses[0].profile, profiles[0]);
  assert.equal(f.calls.confirmed, 0); assert.deepEqual(f.calls.mutations, []);
  f.cancel().props.onClick();
  assert.equal(f.calls.dismissed, 1); assert.equal(f.calls.confirmed, 0); assert.deepEqual(f.calls.mutations, []);
  const close = fixture(); await close.settle(); close.tree().props.onClose();
  assert.equal(close.calls.dismissed, 1); assert.equal(close.calls.confirmed, 0); assert.deepEqual(close.calls.mutations, []);
});

test('pending or failed service status cannot authorize an update, including stale button handlers', async () => {
  const request = deferred(); const pending = fixture({ installations: () => request.promise });
  const original = pending.confirm();
  assert.equal(original.props.disabled, true);
  original.props.onClick(); assert.equal(pending.calls.confirmed, 0);
  pending.cancel().props.onClick(); assert.equal(pending.calls.dismissed, 1);
  request.resolve(profiles); await pending.settle();
  original.props.onClick(); assert.equal(pending.calls.confirmed, 0, 'pending render must not become an authorization after its query completes');
  for (const overrides of [
    { installations: async () => { throw new Error('无法读取配置列表'); } },
    { status: async () => { throw new Error('无法读取服务状态'); } },
  ]) {
    const f = fixture(overrides); await f.settle();
    assert.equal(f.confirm().props.disabled, true);
    assert.ok(nodes(f.tree()).some(node => node.props.role === 'alert'));
    f.confirm().props.onClick(); assert.equal(f.calls.confirmed, 0); assert.deepEqual(f.calls.mutations, []);
  }
});

test('running service warnings identify the exact model, process and configuration being stopped', async () => {
  const f = fixture(); await f.settle();
  const notice = nodes(f.tree()).find(node => node.props.role === 'status' && node.props.className?.split(' ').includes('warning'));
  assert.ok(notice); const message = text(notice);
  assert.ok(message.includes(profiles[0].name)); assert.ok(message.includes('PID 10152'));
  assert.ok(message.includes(profiles[0].configPath)); assert.ok(message.includes('正在进行的请求会中断'));
  assert.equal(message.includes(profiles[1].configPath), false); assert.equal(message.includes(profiles[2].configPath), false);
  assert.ok(text(f.confirm()).includes('停止服务并更新')); assert.equal(f.confirm().props.disabled, false);
});

test('confirmation delegates once to the parent without directly stopping or updating a service', async () => {
  const operation = deferred(); const f = fixture({ confirm: () => operation.promise }); await f.settle();
  const original = f.confirm(); original.props.onClick(); original.props.onClick();
  assert.equal(f.calls.confirmed, 1, 'synchronous repeated clicks must not start a second update');
  assert.deepEqual(f.calls.mutations, []);
  f.props.busy = true; f.render();
  assert.equal(f.confirm().props.disabled, true); assert.equal(f.cancel().props.disabled, true);
  f.cancel().props.onClick(); f.tree().props.onClose(); assert.equal(f.calls.dismissed, 0);
  f.confirm().props.onClick(); assert.equal(f.calls.confirmed, 1);
  operation.resolve(); await f.settle(); original.props.onClick();
  assert.equal(f.calls.confirmed, 1); assert.deepEqual(f.calls.mutations, []);
});

test('a busy or unavailable parent cannot authorize an update even when services are idle', async () => {
  for (const props of [{ busy: true }, { canConfirm: false }]) {
    const f = fixture({ props, status: async () => ({ running: false }) }); await f.settle();
    assert.equal(f.confirm().props.disabled, true); f.confirm().props.onClick();
    assert.equal(f.calls.confirmed, 0); assert.deepEqual(f.calls.mutations, []);
  }
  const idle = fixture({ status: async () => ({ running: false }) }); await idle.settle();
  assert.equal(nodes(idle.tree()).some(node => node.props.role === 'status' && node.props.className?.split(' ').includes('warning')), false);
  assert.ok(text(idle.confirm()).includes('确认更新')); assert.equal(idle.confirm().props.disabled, false);
});

test('the entire official bilingual Release body reaches Markdown unchanged in either language', async () => {
  for (const language of ['zh-CN', 'en']) {
    const f = fixture({ props: { language } }); await f.settle();
    const markdown = nodes(f.tree()).find(node => node.type === 'markdown');
    assert.ok(markdown); assert.equal(markdown.props.children, bilingualNotes.trim());
    assert.equal(markdown.props.skipHtml, true);
    const region = nodes(f.tree()).find(node => node.props.className === 'runtime-update-notes');
    assert.equal(region.props.role, 'region'); assert.equal(region.props.tabIndex, 0);
    assert.equal(region.props['aria-label'], language === 'zh-CN' ? '更新日志' : 'Release notes');
  }
});

test('configuration comparison uses native accessible disclosure and never renders raw credentials', () => {
  const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const load = (compiled, dependencies) => { const module = { exports: {} }; vm.runInNewContext(compiled, { module, exports: module.exports, require: name => dependencies[name] ?? {} }); return module.exports; };
  const { compareRunningConfiguration } = load(compile('../../../../packages/core/src/configuration-match.ts'), { './model-groups': { configurationPathKey } });
  const running = {
    id: 'running', name: 'Qwen · actual', installDir: runtime.installDir, configPath: 'D:\\AI\\Strata\\actual.json',
    config: { port: 18081, api_key: 'fixture-running-secret', nested: { authorization: 'fixture-running-auth' }, token: '[已隐藏]' },
  };
  const other = { ...running, id: 'other', name: 'Qwen · other', configPath: 'D:\\AI\\Strata\\other.json', config: { port: 18082, api_key: 'fixture-listed-secret', nested: { authorization: 'fixture-listed-auth' }, token: '[已隐藏]' } };
  const comparison = compareRunningConfiguration(running, [running, other]);
  const expandedJsx = (type, props) => typeof type === 'function' ? type(props ?? {}) : jsx(type, props);
  const { RunningConfigurationComparison } = load(compile('./RunningConfigurationComparison.tsx'), { 'react/jsx-runtime': { jsx: expandedJsx, jsxs: expandedJsx } });
  const opened = [];
  const tree = RunningConfigurationComparison({ comparison, language: 'zh-CN', onOpenConfiguration: entry => opened.push(entry) });
  const content = text(tree);
  for (const credential of ['fixture-running-secret', 'fixture-listed-secret', 'fixture-running-auth', 'fixture-listed-auth']) assert.equal(content.includes(credential), false);
  assert.ok(content.includes('[已隐藏]')); assert.ok(content.includes('凭据已隐藏，未比较'));
  assert.ok(content.includes(running.configPath)); assert.ok(content.includes(other.configPath));
  assert.equal(tree.props['aria-label'], '对比全部配置');
  const all = nodes(tree).find(node => node.type === 'details' && node.props.className === 'configuration-comparison-all');
  assert.equal(all.props.open, undefined);
  for (const disclosure of nodes(tree).filter(node => node.type === 'details')) assert.equal(disclosure.props.children[0].type, 'summary');
  for (const table of nodes(tree).filter(node => node.type === 'table')) {
    assert.equal(nodes(table).filter(node => node.type === 'th' && node.props.scope === 'col').length, 3);
    assert.ok(nodes(table).some(node => node.type === 'th' && node.props.scope === 'row'));
  }
  assert.equal(opened.length, 0);
  const open = nodes(tree).find(node => node.type === 'button'); assert.equal(open.props.type, 'button');
  assert.ok(text(open).includes('查看配置')); open.props.onClick(); assert.strictEqual(opened[0], comparison.exactMatches[0]);
});
