import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { configurationPathKey, groupLocalModels, modelAssetKey } from '../../../../packages/core/src/model-groups.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const profile = { id: 'saved', name: 'Model', baseUrl: 'http://127.0.0.1:18081', installDir: 'D:\\Strata', pythonPath: 'python.exe', configPath: 'D:\\Strata\\managed.json', managed: true };
const config = { args: ['--native', 'D:\\Models\\Model-IQ3_S.gguf'] };
const files = [{ path: 'D:\\Models\\Model-IQ3_S.gguf', sizeBytes: 84_525_205_664, modifiedAt: 1728000000000 }];
const plan = { files, totalBytes: files[0].sizeBytes, blockedReason: null };
const jsx = (type, props) => ({ type, props: props ?? {} });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree) : !tree || typeof tree !== 'object' ? '' : [tree.props?.children].flat(Infinity).map(text).join('');
const compiled = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const load = (source, dependencies) => { const module = { exports: {} }; vm.runInNewContext(source, { module, exports: module.exports, require: name => dependencies[name] ?? {}, console }); return module.exports; };

function fixture(overrides = {}) {
  const slots = [], effects = [], calls = { plans: [], deletes: [], refreshed: 0, closed: 0, writesAfterUnmount: 0 };
  let cursor = 0, unmounted = false, tree;
  const slot = init => { const index = cursor++; return slots[index] ??= init(index); };
  const sameDeps = (a, b) => a?.length === b?.length && a?.every((value, index) => Object.is(value, b[index]));
  const react = {
    useRef: value => slot(() => ({ current: value })),
    useId: () => slot(index => `id-${index}`),
    useState: initial => { const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial })); return [state.value, value => { if (unmounted) calls.writesAfterUnmount++; state.value = typeof value === 'function' ? value(state.value) : value; }]; },
    useCallback: (fn, deps) => { const memo = slot(() => ({})); if (!sameDeps(memo.deps, deps)) { memo.fn = fn; memo.deps = deps; } return memo.fn; },
    useEffect: (fn, deps) => { const effect = slot(() => ({})); if (!sameDeps(effect.deps, deps)) { effect.deps = deps; effects.push(() => { effect.cleanup?.(); effect.cleanup = fn(); }); } },
  };
  const core = {
    normalizeError: error => ({ message: error instanceof Error ? error.message : String(error) }),
    planModelDeletion: async profiles => { calls.plans.push(profiles); return overrides.preview ? await overrides.preview(profiles) : plan; },
    deleteModelFiles: async (profiles, expectedFiles) => { calls.deletes.push({ profiles, expectedFiles }); return overrides.remove ? await overrides.remove(profiles, expectedFiles) : { removedFiles: files, removedBytes: plan.totalBytes }; },
  };
  const { ModelDeletionDialog } = load(compiled('./ModelDeletionDialog.tsx'), { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '@strata-manager/core': core, '../OfficialControls': { OfficialDialog: 'dialog' } });
  const props = { modelName: 'Model', profiles: [profile], language: 'zh-CN', onClose: () => calls.closed++, onDeleted: async () => { calls.refreshed++; await overrides.refresh?.(); }, ...overrides.props };
  const render = () => { cursor = 0; tree = ModelDeletionDialog(props); while (effects.length) effects.shift()(); return tree; };
  const button = name => nodes(tree).find(node => node.type === 'button' && text(node) === name);
  const input = () => nodes(tree).find(node => node.type === 'input');
  const enter = value => { input().props.onChange({ target: { value } }); render(); };
  const settle = async () => { await tick(); render(); };
  const unmount = () => { unmounted = true; for (const state of slots) state?.cleanup?.(); };
  render();
  return { calls, props, render, button, input, enter, settle, unmount, tree: () => tree };
}

test('opening the dialog only previews files; full model name explicitly authorizes the exact snapshot', async () => {
  const f = fixture(); await f.settle();
  assert.equal(f.calls.plans.length, 1); assert.equal(f.calls.deletes.length, 0);
  assert.ok(text(f.tree()).includes(files[0].path));
  assert.ok(text(f.tree()).includes('JSON 配置'));
  f.enter('Model '); assert.equal(f.button('永久删除模型文件').props.disabled, true);
  f.button('永久删除模型文件').props.onClick(); await f.settle(); assert.equal(f.calls.deletes.length, 0);
  f.enter('Model'); assert.equal(f.button('永久删除模型文件').props.disabled, false);
  f.button('永久删除模型文件').props.onClick(); await f.settle();
  assert.equal(f.calls.deletes.length, 1);
  assert.strictEqual(f.calls.deletes[0].profiles, f.props.profiles);
  assert.strictEqual(f.calls.deletes[0].expectedFiles, files, 'submit the original preview, including size and modifiedAt');
  assert.equal(f.calls.refreshed, 1); assert.equal(f.calls.closed, 1);
});

test('running, shared references, and empty plans display the reason and cannot confirm', async () => {
  for (const preview of [{ ...plan, blockedReason: '模型仍在运行' }, { files: [], totalBytes: 0, blockedReason: '另一份配置仍引用这些文件' }, { files: [], totalBytes: 0 }]) {
    const f = fixture({ preview: async () => preview }); await f.settle();
    assert.equal(f.input(), undefined);
    assert.equal(f.button('永久删除模型文件').props.disabled, true);
    f.button('永久删除模型文件').props.onClick(); await f.settle();
    assert.equal(f.calls.deletes.length, 0);
    if (preview.blockedReason) assert.ok(text(f.tree()).includes(preview.blockedReason));
  }
});

test('rejected or changed plans require a fresh preview and another typed confirmation', async () => {
  const f = fixture({ remove: async () => { throw new Error('文件列表已变化，请重新检查'); } }); await f.settle();
  f.enter('Model'); f.button('永久删除模型文件').props.onClick(); await f.settle();
  assert.ok(text(f.tree()).includes('文件列表已变化'));
  assert.equal(f.button('永久删除模型文件').props.disabled, true); assert.equal(f.input(), undefined);
  f.button('重新检查').props.onClick(); await f.settle();
  assert.equal(f.calls.plans.length, 2); assert.equal(f.input().props.value, '');
  assert.equal(f.calls.refreshed, 0);
});

test('double clicks and closing while a deletion is pending never submit twice', async () => {
  const request = deferred(); const f = fixture({ remove: () => request.promise }); await f.settle(); f.enter('Model');
  const original = f.button('永久删除模型文件'); original.props.onClick(); original.props.onClick(); f.render();
  assert.equal(f.calls.deletes.length, 1); assert.equal(f.button('取消').props.disabled, true);
  f.tree().props.onClose(); assert.equal(f.calls.closed, 0);
  request.resolve({ removedFiles: files, removedBytes: plan.totalBytes }); await f.settle();
  original.props.onClick(); await f.settle(); assert.equal(f.calls.deletes.length, 1);
});

test('refresh errors retain successful deletion and cannot repeat the mutation', async () => {
  const f = fixture({ refresh: async () => { throw new Error('刷新失败'); } }); await f.settle(); f.enter('Model');
  const original = f.button('永久删除模型文件'); original.props.onClick(); await f.settle();
  assert.ok(text(f.tree()).includes('模型文件已删除')); assert.ok(text(f.tree()).includes('列表刷新失败'));
  assert.equal(f.button('永久删除模型文件'), undefined); assert.ok(f.button('关闭'));
  original.props.onClick(); await f.settle(); assert.equal(f.calls.deletes.length, 1);
});

test('late preview and deletion responses avoid unmounted state; successful deletion still refreshes records', async () => {
  const preview = deferred(); const first = fixture({ preview: () => preview.promise }); first.unmount(); preview.resolve(plan); await tick();
  assert.equal(first.calls.writesAfterUnmount, 0);
  const remove = deferred(); const second = fixture({ remove: () => remove.promise }); await second.settle(); second.enter('Model');
  second.button('永久删除模型文件').props.onClick(); second.unmount(); remove.resolve({ removedFiles: files, removedBytes: plan.totalBytes }); await tick();
  assert.equal(second.calls.writesAfterUnmount, 0); assert.equal(second.calls.refreshed, 1); assert.equal(second.calls.closed, 0);
});

const helpers = load(compiled('./ServiceManagerPage.tsx') + '\nexports.helpers = { hasMissingModelFiles, modelDeletionProfiles };', { '@strata-manager/core': { configurationPathKey, modelAssetKey } }).helpers;
const candidate = (id, extra = {}) => ({ id, name: 'Model', installDir: profile.installDir, pythonPath: profile.pythonPath, configPath: `D:\\Strata\\${id}.json`, modelPath: files[0].path, modelBytes: files[0].sizeBytes, config, availability: 'ready', ...extra });

test('model deletion includes every saved id and same-model original/candidate configurations', () => {
  const source = candidate('original');
  const result = helpers.modelDeletionProfiles([{ profile, config, candidate: source }, { profile: { ...profile, id: 'another-id' }, config }, { candidate: candidate('other', { detectedPort: 18100 }) }]);
  assert.deepEqual(Array.from(result, item => item.id), ['saved', 'another-id', 'configuration-original', 'configuration-other']);
  assert.equal(result[3].baseUrl, 'http://127.0.0.1:18100'); assert.equal(result[3].managed, false);
  const changedSource = candidate('changed', { config: { args: ['--native', 'D:\\Models\\Other.gguf'] } });
  assert.equal(helpers.modelDeletionProfiles([{ profile, config, candidate: changedSource }]).length, 1, 'original JSON for another model must not broaden deletion');
});

test('only confirmed missing weights move to repair configurations; unread or changed managed copies stay unknown', () => {
  const missing = candidate('missing', { modelBytes: null, availability: 'repair' });
  const group = configurations => ({ key: 'weights', name: 'Model', configurations });
  assert.equal(helpers.hasMissingModelFiles(group([{ candidate: missing }])), true);
  assert.equal(helpers.hasMissingModelFiles(group([{ profile, config, candidate: missing }])), true);
  assert.equal(helpers.hasMissingModelFiles(group([{ profile }])), false);
  assert.equal(helpers.hasMissingModelFiles(group([{ profile, candidate: missing }])), false);
  assert.equal(helpers.hasMissingModelFiles(group([{ profile, config: { args: ['--native', 'Other.gguf'] }, candidate: missing }])), false);
  assert.equal(helpers.hasMissingModelFiles(group([{ candidate: missing }, { candidate: candidate('existing') }])), false);
  assert.equal(helpers.hasMissingModelFiles(group([{ candidate: candidate('runtime-broken', { availability: 'repair' }) }])), false);
});

test('two existing main weights render two model rows; orphan configurations appear in a collapsed repair section', () => {
  const candidates = [candidate('gsq-262k'), candidate('gsq-512k'), candidate('sc', { config: { args: ['--native', 'D:\\Models\\SC117-IQ3_S.gguf'] } }), candidate('orca-1', { config: { args: ['--native', 'D:\\Models\\Orca.gguf'] }, modelBytes: null, availability: 'repair' }), candidate('orca-2', { config: { args: ['--native', 'D:\\Models\\Orca.gguf'] }, modelBytes: null, availability: 'repair' })];
  const { ServiceManagerPage } = load(compiled('./ServiceManagerPage.tsx'), {
    react: { useRef: value => ({ current: value }), useEffect: () => {}, useState: value => [value, () => {}] },
    '@tanstack/react-query': { useQueries: ({ queries }) => queries.map(() => ({})) },
    '@strata-manager/core': { configurationPathKey, modelAssetKey, groupLocalModels },
    'react/jsx-runtime': { jsx, jsxs: jsx }, './ModelConfigurationDropdown': { ModelConfigurationDropdown: 'configurations' },
  });
  const tree = ServiceManagerPage({ profiles: [], activeId: '', candidates, language: 'zh-CN', desktop: true });
  const all = nodes(tree);
  assert.ok(text(all.find(node => node.props.className === 'service-manager-list-heading')).startsWith('2 个本机模型 · 3 份配置'));
  assert.equal(nodes(all.find(node => node.props.className === 'service-manager-list')).filter(node => node.type === 'section').length, 2);
  const repair = all.find(node => node.type === 'details' && node.props.className === 'service-manager-repair-configurations');
  assert.ok(repair); assert.equal(repair.props.open, undefined); assert.ok(text(repair).startsWith('待修复配置 · 2 份配置'));
  assert.equal(nodes(repair).filter(node => node.type === 'section').length, 1);
});

test('each model exposes only its own configurations; deleting an inactive candidate opens the shared file dialog', async () => {
  const slots = [], calls = { selected: 0, started: 0, refreshed: 0 }; let cursor = 0;
  const { ServiceManagerPage } = load(compiled('./ServiceManagerPage.tsx'), {
    react: { useRef: value => ({ current: value }), useEffect: () => {}, useState: value => { const index = cursor++; if (!(index in slots)) slots[index] = value; return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; } },
    '@tanstack/react-query': { useQueries: ({ queries }) => queries.map(() => ({})) },
    '@strata-manager/core': { configurationPathKey, modelAssetKey, groupLocalModels },
    'react/jsx-runtime': { jsx, jsxs: jsx }, './ModelConfigurationDropdown': { ModelConfigurationDropdown: 'configurations' }, './ConfigurationDeletionDialog': { ConfigurationDeletionDialog: 'configuration-deletion' },
  });
  const props = { profiles: [profile], details: [{ profileId: profile.id, config }], activeId: profile.id, candidates: [candidate('inactive'), candidate('other-model', { config: { args: ['--native', 'D:\\Models\\Other.gguf'] } })], language: 'zh-CN', desktop: true, onSelect: () => calls.selected++, onStart: () => calls.started++, onModelDeleted: () => calls.refreshed++ };
  const render = () => { cursor = 0; return ServiceManagerPage(props); };
  let tree = render();
  const dropdowns = nodes(tree).filter(node => node.type === 'configurations');
  assert.equal(dropdowns.length, 2); assert.equal(dropdowns[0].props.options.length, 2); assert.equal(dropdowns[1].props.options.length, 1);
  dropdowns[0].props.onDelete(dropdowns[1].props.options[0].value);
  assert.equal(nodes(render()).some(node => node.type === 'configuration-deletion'), false, 'reject another model’s configuration key');
  dropdowns[0].props.onDelete('candidate:inactive'); tree = render();
  const dialog = nodes(tree).find(node => node.type === 'configuration-deletion');
  assert.ok(dialog); assert.equal(dialog.props.profile.id, 'configuration-inactive'); assert.equal(dialog.props.profile.managed, false);
  assert.equal(dialog.props.profile.configPath, 'D:\\Strata\\inactive.json');
  assert.equal(calls.selected, 0); assert.equal(calls.started, 0);
  await dialog.props.onDeleted(dialog.props.profile); assert.equal(calls.refreshed, 1);
});
