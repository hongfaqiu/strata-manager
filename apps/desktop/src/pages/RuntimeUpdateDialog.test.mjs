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
const hasClasses = (node, ...classes) => classes.every(value => (node.props.className ?? '').split(/\s+/).includes(value));
const source = ts.transpileModule(readFileSync(new URL('./RuntimeUpdateDialog.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const downloadModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../../../packages/core/src/runtime-download.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module: downloadModule, exports: downloadModule.exports, URL, require: () => ({}) });
const { resolveRuntimeDownloadPreferences, runtimeDownloadSources, runtimeAssetLabel, runtimeEngineArchiveFilters, runtimeEngineIsCurrent } = downloadModule.exports;
const sharedControls = { Dropdown: 'dropdown' };
const sourceControl = tree => nodes(tree).find(node => node.type === 'dropdown' && node.props.options.some(option => option.value === 'official'));
const assetControl = tree => nodes(tree).find(node => node.type === 'dropdown' && node.props.options.some(option => option.value === assets[0].name));
const runtime = { id: 'strata', installDir: 'D:\\AI\\Strata', runtimeVersion: '0.1.41' };
const assets = [
  { name: 'Strata-cuda13-windows-x64.zip', url: 'https://official.example.com/0.1.42/Strata-cuda13-windows-x64.zip', size: 2 * 1024 * 1024, sha256: 'a'.repeat(64), variant: 'cuda13' },
  { name: 'Strata-cuda12-windows-x64.zip', url: 'https://official.example.com/0.1.42/Strata-cuda12-windows-x64.zip', size: 3 * 1024 * 1024, sha256: 'b'.repeat(64), variant: 'cuda12' },
];
const profiles = [
  { id: 'running', name: 'Qwen · 131K', installDir: 'd:/ai/strata/', configPath: 'C:\\Manager\\imports\\running\\config.json', managed: true },
  { id: 'idle', name: 'Qwen · 262K', installDir: runtime.installDir, configPath: 'D:\\AI\\Strata\\262k.json', managed: true },
  { id: 'other-runtime', name: 'Other runtime', installDir: 'D:\\AI\\AnotherStrata', configPath: 'D:\\AI\\AnotherStrata\\config.json', managed: true },
];
const bilingualNotes = '# Strata 0.1.42\n\n## 中文\n\n### 修复\n- 修复路径检测。\n\n## English\n\n### Fixed\n- Fixed path detection.\n\n```json\n{"example": true}\n```\n';

function fixture(overrides = {}) {
  const calls = { installations: 0, statuses: [], mutations: [], confirmed: 0, confirmedArgs: [], dismissed: 0, picker: [], clipboard: [] };
  const slots = [], effects = [];
  let cursor = 0, tree;
  const started = new Set();
  const slot = init => { const index = cursor++; return slots[index] ??= init(index); };
  const sameDeps = (a, b) => a?.length === b?.length && a?.every((value, index) => Object.is(value, b[index]));
  const react = {
    useRef: value => slot(() => ({ current: value })),
    useState: initial => { const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial })); return [state.value, value => { state.value = typeof value === 'function' ? value(state.value) : value; }]; },
    useEffect: (fn, deps) => { const effect = slot(() => ({})); if (!sameDeps(effect.deps, deps)) { effect.deps = deps; effects.push(() => { effect.cleanup?.(); effect.cleanup = fn(); }); } },
  };
  const query = { isSuccess: false, isPending: true, isError: false, data: undefined, error: null };
  const assetQuery = { isSuccess: false, isPending: true, isError: false, data: undefined, error: null };
  const core = {
    isDesktop: () => true,
    configurationPathKey,
    runtimeDownloadSources, resolveRuntimeDownloadPreferences, runtimeAssetLabel, runtimeEngineArchiveFilters,
    resolveRuntimeZipAsset: async (...args) => overrides.resolveAsset ? await overrides.resolveAsset(...args) : assets.find(asset => asset.name === args[1]) ?? assets[1],
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
    URL, navigator: { clipboard: { writeText: async value => { calls.clipboard.push(value); if (overrides.copy) await overrides.copy(value); } } },
    require: name => ({
      react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '@strata-manager/core': core,
      '@tanstack/react-query': { useQuery: options => {
        const service = options.queryKey[0] === 'runtime-update-services';
        const target = service ? query : assetQuery;
        const key = JSON.stringify(options.queryKey);
        if (!started.has(key) && options.enabled !== false) {
          started.add(key);
          Object.assign(target, { isSuccess: false, isPending: true, isError: false, data: undefined, error: null });
          Promise.resolve().then(options.queryFn).then(data => Object.assign(target, { data, isSuccess: true, isPending: false, isError: false }), error => Object.assign(target, { error, isSuccess: false, isPending: false, isError: true }));
        }
        return target;
      } },
      'react-markdown': { default: 'markdown' }, 'remark-gfm': { default: 'remark-gfm' },
      '../components': { Dialog: 'dialog' }, '../updateReleaseNotes': { releaseNotes },
      '../OfficialControls': sharedControls,
      '@tauri-apps/plugin-dialog': { open: async options => { calls.picker.push(options); return overrides.pick ? await overrides.pick(options) : null; } },
    })[name] ?? {},
  });
  const props = {
    language: 'zh-CN', runtime,
    release: { latestVersion: '0.1.42', supportedVersion: '0.1.41', releaseName: 'Strata 0.1.42', notes: bilingualNotes, checkedAt: 100, assets },
    onConfirm: (download, assetName) => { calls.confirmed++; calls.confirmedArgs.push({ download: JSON.parse(JSON.stringify(download)), assetName }); return overrides.confirm?.(download, assetName); },
    onDismiss: () => calls.dismissed++,
    ...overrides.props,
  };
  const render = () => { cursor = 0; tree = module.exports.RuntimeUpdateDialog(props); while (effects.length) effects.shift()(); return tree; };
  const buttons = () => nodes(tree).filter(node => node.type === 'button');
  const confirm = () => buttons().find(node => node.props.className === 'primary');
  const cancel = () => buttons().find(node => ['暂不更新', 'Not now'].includes(text(node)));
  const settle = async () => { await tick(); render(); };
  render();
  const mode = value => { sourceControl(tree).props.onValueChange(value === 'mirror' ? 'custom' : value); render(); };
  const chooseAsset = value => { assetControl(tree).props.onValueChange(value); render(); };
  const mirror = value => { nodes(tree).find(node => node.type === 'input' && node.props.type === 'url').props.onChange({ target: { value } }); render(); };
  const browse = () => buttons().find(node => text(node).includes('选择引擎包文件')).props.onClick();
  return { calls, props, query, assetQuery, render, confirm, cancel, settle, mode, chooseAsset, mirror, browse, tree: () => tree };
}

test('automatic CUDA12 package exposes exact URL, size and hash with independent copy actions', async () => {
  const f = fixture(); await f.settle();
  assert.ok(text(f.tree()).includes(assets[1].sha256));
  assert.ok(nodes(f.tree()).some(node => node.type === 'a' && node.props.href === assets[1].url));
  assert.equal(nodes(f.tree()).some(node => node.type === 'a' && node.props.href === assets[0].url), false);
  f.chooseAsset(assets[1].name);
  assert.ok(text(f.tree()).includes('3.0 MiB'));
  assert.equal(text(f.tree()).includes(assets[0].url), false, 'choosing CUDA12 must not show CUDA13 as its matching package');
  for (const label of [`复制下载链接 ${assets[1].name}`, `复制 SHA256 ${assets[1].name}`]) {
    await nodes(f.tree()).find(node => node.type === 'button' && node.props['aria-label'] === label).props.onClick(); await f.settle();
  }
  assert.deepEqual(f.calls.clipboard, [assets[1].url, assets[1].sha256]);
  assert.equal(f.calls.confirmed, 0); assert.deepEqual(f.calls.mutations, []);
  f.confirm().props.onClick();
  assert.deepEqual(f.calls.confirmedArgs, [{ download: {}, assetName: assets[1].name }]);
});

test('local ZIP uses the auto matched package but requires a file; picker cancellation cannot start updates', async () => {
  let picked = null; const f = fixture({ pick: async () => picked }); await f.settle();
  f.mode('local'); assert.equal(f.confirm().props.disabled, true); f.confirm().props.onClick();
  f.chooseAsset(assets[1].name); assert.equal(f.confirm().props.disabled, true);
  f.browse(); await f.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.picker[0].filters)), [{ name: '引擎包（tar.gz / ZIP）', extensions: ['gz', 'tgz', 'zip'] }]);
  assert.equal(f.confirm().props.disabled, true); assert.equal(f.calls.confirmed, 0); assert.deepEqual(f.calls.mutations, []);
  picked = 'D:\\Downloads\\Strata-cuda12.zip'; f.browse(); await f.settle();
  assert.equal(f.confirm().props.disabled, false); assert.ok(text(f.tree()).includes(picked));
  assert.equal(f.calls.confirmed, 0, 'choosing a file does not authorize stopping services');
  f.confirm().props.onClick();
  assert.deepEqual(f.calls.confirmedArgs, [{ download: { localArchivePath: picked }, assetName: assets[1].name }]);
});

test('custom HTTPS uses the auto matched package and explicit overrides, then forwards only its own source', async () => {
  const f = fixture(); await f.settle(); f.mode('mirror');
  f.mirror('https://mirror.example.com/releases/engine.zip'); assert.equal(f.confirm().props.disabled, false);
  f.chooseAsset(assets[0].name);
  for (const url of ['http://mirror.example.com/engine.zip', 'https://mirror.example.com', 'https://user:pass@mirror.example.com/engine.zip', 'https://mirror.example.com/engine.zip#fragment', 'bad url']) {
    f.mirror(url); assert.equal(f.confirm().props.disabled, true); f.confirm().props.onClick(); assert.equal(f.calls.confirmed, 0);
  }
  f.mirror('  https://mirror.example.com/releases/engine.zip?token=example  ');
  assert.equal(f.confirm().props.disabled, false); f.confirm().props.onClick();
  assert.deepEqual(f.calls.confirmedArgs, [{ download: { downloadUrl: 'https://mirror.example.com/releases/engine.zip?token=example' }, assetName: assets[0].name }]);
});

test('built-in download sources use the automatically resolved CUDA12 asset and preserve official integrity', async () => {
  for (const source of runtimeDownloadSources) {
    const f = fixture(); await f.settle(); f.mode(source.id);
    assert.equal(assetControl(f.tree()).props.value, '');
    assert.equal(f.confirm().props.disabled, false);
    f.confirm().props.onClick();
    assert.deepEqual(f.calls.confirmedArgs, [{ download: { downloadUrl: source.urlTemplate.replace('{url}', assets[1].url) }, assetName: assets[1].name }]);
    assert.deepEqual(f.calls.mutations, []);
  }
});

test('unknown or mismatched automatic assets never guess the first package and allow an explicit override', async () => {
  for (const resolveAsset of [async () => { throw new Error('unknown engine'); }, async () => ({ ...assets[1], sha256: 'c'.repeat(64) })]) {
    const f = fixture({ resolveAsset }); await f.settle();
    assert.equal(f.confirm().props.disabled, true); f.confirm().props.onClick();
    assert.equal(f.calls.confirmed, 0);
    f.chooseAsset(assets[0].name); assert.equal(f.confirm().props.disabled, false);
    f.confirm().props.onClick();
    assert.deepEqual(f.calls.confirmedArgs, [{ download: {}, assetName: assets[0].name }]);
  }
});

test('pending automatic matching cannot authorize a stale confirmation handler', async () => {
  const request = deferred(); const f = fixture({ resolveAsset: () => request.promise });
  await f.settle(); const old = f.confirm();
  assert.equal(old.props.disabled, true); old.props.onClick(); assert.equal(f.calls.confirmed, 0);
  request.resolve(assets[1]); await f.settle();
  old.props.onClick(); assert.equal(f.calls.confirmed, 0);
  assert.equal(f.confirm().props.disabled, false); f.confirm().props.onClick();
  assert.deepEqual(f.calls.confirmedArgs, [{ download: {}, assetName: assets[1].name }]);
});

test('failed automatic matching cannot reuse previously successful query data', async () => {
  const f = fixture(); await f.settle(); assert.equal(f.confirm().props.disabled, false);
  Object.assign(f.assetQuery, { isSuccess: false, isError: true, error: new Error('refresh failed') });
  f.render(); assert.equal(f.confirm().props.disabled, true); f.confirm().props.onClick();
  assert.equal(f.calls.confirmed, 0);
  f.chooseAsset(assets[1].name); assert.equal(f.confirm().props.disabled, false);
});

test('built-in source preferences follow the official URL across releases and switching back keeps automatic matching', async () => {
  let current = assets[1];
  const f = fixture({ resolveAsset: async () => current, props: { initialPreferences: { mode: 'mirror', sourceId: 'gh-proxy', releaseVersion: '0.1.42' } } });
  await f.settle(); assert.equal(sourceControl(f.tree()).props.value, 'gh-proxy');
  const old = f.confirm();
  current = { ...assets[1], url: assets[1].url.replace('0.1.42', '0.1.43'), sha256: 'd'.repeat(64) };
  f.props.release = { ...f.props.release, latestVersion: '0.1.43', checkedAt: 101, assets: [assets[0], current] };
  f.render(); await f.settle(); old.props.onClick(); assert.equal(f.calls.confirmed, 0);
  assert.equal(f.confirm().props.disabled, false);
  f.mode('official'); assert.equal(assetControl(f.tree()).props.value, '');
  f.mode('gh-proxy'); f.confirm().props.onClick();
  assert.deepEqual(f.calls.confirmedArgs, [{ download: { downloadUrl: `https://gh-proxy.org/${current.url}` }, assetName: current.name }]);
});

test('release or runtime changes discard local selection and ignore an old in-flight file picker', async () => {
  const request = deferred(); const f = fixture({ pick: () => request.promise }); await f.settle();
  f.mode('local'); f.chooseAsset(assets[0].name); f.browse(); f.render();
  assert.equal(f.confirm().props.disabled, true);
  f.props.release = { ...f.props.release, latestVersion: '0.1.43', checkedAt: 101 };
  f.render(); f.render();
  request.resolve('D:\\Downloads\\old-release.zip'); await f.settle();
  assert.equal(text(f.tree()).includes('old-release.zip'), false);
  assert.equal(sourceControl(f.tree()).props.value, 'official');
  f.mode('mirror'); f.chooseAsset(assets[0].name); f.mirror('https://mirror.example.com/engine.zip');
  const oldConfirmation = f.confirm(); f.props.runtime = { ...runtime, installDir: 'D:\\AI\\Other' }; f.render(); f.render();
  oldConfirmation.props.onClick(); assert.equal(f.calls.confirmed, 0);
  assert.equal(assetControl(f.tree()).props.value, '');
  f.mode('mirror'); assert.equal(nodes(f.tree()).find(node => node.props.type === 'url').props.value, '');
});

test('busy parent disables download inputs and stale selection handlers cannot change the source', async () => {
  const f = fixture(); await f.settle(); f.mode('mirror'); f.chooseAsset(assets[0].name); f.mirror('https://mirror.example.com/engine.zip');
  const oldConfirmation = f.confirm(); f.props.busy = true; f.render();
  assert.equal(nodes(f.tree()).find(node => node.type === 'fieldset').props.disabled, true);
  f.mirror('https://mirror.example.com/other.zip');
  assert.equal(nodes(f.tree()).find(node => node.props.type === 'url').props.value, 'https://mirror.example.com/engine.zip');
  oldConfirmation.props.onClick(); assert.equal(f.calls.confirmed, 0);
});

test('saved local or mirror sources prefill confirmation while remaining editable', async () => {
  for (const initialDownload of [{ localArchivePath: 'D:\\Downloads\\saved.zip' }, { downloadUrl: 'https://mirror.example.com/saved.zip' }]) {
    const mode = Object.hasOwn(initialDownload, 'localArchivePath') ? 'local' : 'mirror';
    const f = fixture({ props: { initialDownload, assetName: assets[1].name } }); await f.settle();
    assert.equal(sourceControl(f.tree()).props.value, mode === 'mirror' ? 'custom' : mode);
    assert.equal(assetControl(f.tree()).props.value, assets[1].name);
    assert.equal(f.confirm().props.disabled, false);
    f.confirm().props.onClick(); assert.deepEqual(f.calls.confirmedArgs, [{ download: initialDownload, assetName: assets[1].name }]);
    assert.deepEqual(f.calls.mutations, []);
  }
});

test('stale saved sources retain their mode and require reselection without silently falling back', async () => {
  for (const initialDownload of [{ localArchivePath: '' }, { downloadUrl: '' }]) {
    const mode = Object.hasOwn(initialDownload, 'localArchivePath') ? 'local' : 'mirror';
    const f = fixture({ props: { initialDownload, assetName: assets[1].name } }); await f.settle();
    assert.equal(sourceControl(f.tree()).props.value, mode === 'mirror' ? 'custom' : mode);
    assert.equal(f.confirm().props.disabled, true); f.confirm().props.onClick(); assert.equal(f.calls.confirmed, 0);
    assert.ok(text(f.tree()).includes('已保存的下载来源需要重新选择'));
    f.mode('official'); assert.equal(f.confirm().props.disabled, false); f.confirm().props.onClick();
    assert.deepEqual(f.calls.confirmedArgs, [{ download: {}, assetName: assets[1].name }]);
  }
});

test('new release clears a previously prefilled local source and guards its old confirmation handler', async () => {
  const f = fixture({ props: { initialDownload: { localArchivePath: 'D:\\Downloads\\0.1.42.zip' }, assetName: assets[1].name } }); await f.settle();
  const old = f.confirm(); f.props.release = { ...f.props.release, latestVersion: '0.1.43', checkedAt: 101 }; f.props.initialDownload = { localArchivePath: '' }; f.render(); f.render();
  old.props.onClick(); assert.equal(f.calls.confirmed, 0);
  assert.equal(f.confirm().props.disabled, true); assert.equal(text(f.tree()).includes('D:\\Downloads\\0.1.42.zip'), false);
  assert.equal(sourceControl(f.tree()).props.value, 'local');
});

function parentFixture(kind, savedPreferences = { mode: 'official' }) {
  const file = kind === 'manual' ? './RuntimeManagementPanel.tsx' : '../useRuntimeUpdates.ts';
  const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const calls = { updates: [], saved: [], canceled: [], started: 0 }, slots = [], effects = [];
  const tasks = [], detectedRuntime = { ...runtime, readiness: 'ready' };
  const queryData = {
    'runtime-installation': { data: { detectedRuntimes: [detectedRuntime] } },
    'tasks': { data: tasks },
    'runtime-update-info': { data: { latestVersion: '0.1.42', supportedVersion: '0.1.41', checkedAt: 100, assets, installable: true } },
    'runtime-download-preferences': { data: savedPreferences, isSuccess: true, isPending: false },
  };
  const queryClient = { invalidateQueries: async () => {}, setQueryData: (key, data) => { queryData[key[0]].data = data; } };
  let cursor = 0, tree;
  const slot = init => { const index = cursor++; return slots[index] ??= init(); };
  const sameDeps = (a, b) => a?.length === b?.length && a?.every((value, index) => Object.is(value, b[index]));
  const react = {
    createElement: jsx,
    useRef: value => slot(() => ({ current: value })),
    useState: initial => { const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial })); return [state.value, value => { state.value = typeof value === 'function' ? value(state.value) : value; }]; },
    useEffect: (fn, deps) => { const effect = slot(() => ({})); if (!sameDeps(effect.deps, deps)) { effect.deps = deps; effects.push(fn); } },
  };
  const core = {
    updateRuntimeZip: async (...args) => { calls.updates.push(JSON.parse(JSON.stringify(args))); return { id: 'update-task', kind: 'update', state: 'running' }; },
    listTasks: async () => tasks, loadStore: async () => '',
    resolveRuntimeDownloadPreferences, runtimeAssetLabel, runtimeEngineArchiveFilters, runtimeEngineIsCurrent, getRuntimeDownloadPreferences: async () => queryData['runtime-download-preferences'].data,
    saveStore: async (...args) => calls.saved.push(args), cancelTask: async id => calls.canceled.push(id),
    normalizeError: error => ({ message: error instanceof Error ? error.message : String(error) }),
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require: name => ({
      react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '@strata-manager/core': core,
      '@tanstack/react-query': { useQuery: options => queryData[options.queryKey[0]], useQueryClient: () => queryClient },
      '../components': { Panel: 'panel' }, '../OfficialControls': sharedControls,
      '../updateReleaseNotes': { releaseNotes }, './RuntimeUpdateDialog': { RuntimeUpdateDialog: 'update-dialog' }, './pages/RuntimeUpdateDialog': { RuntimeUpdateDialog: 'update-dialog' },
      './RuntimeDownloadSettings': { RuntimeDownloadSettings: 'download-settings' },
      'react-markdown': { default: 'markdown' }, 'remark-gfm': { default: 'remark-gfm' },
    })[name] ?? {},
  });
  const props = { language: 'zh-CN', desktop: true, operationDisabled: false, onUpdateStarted: () => { calls.started += 1; } };
  const render = () => { cursor = 0; tree = kind === 'manual' ? module.exports.RuntimeManagementPanel(props) : module.exports.useRuntimeUpdates(true, true, true, true, tasks, 'zh-CN', undefined, undefined, () => { calls.started += 1; }).dialog; while (effects.length) effects.shift()(); return tree; };
  const dialog = () => nodes(tree).find(node => node.type === 'update-dialog');
  const settle = async () => { await tick(); render(); render(); };
  const open = async () => {
    render(); await settle();
    if (kind === 'manual') { nodes(tree).find(node => node.type === 'button' && node.props.className === 'primary').props.onClick(); render(); }
    assert.ok(dialog());
  };
  return { calls, props, tasks, queryData, render, dialog, settle, open, tree: () => tree };
}

for (const kind of ['manual', 'automatic']) {
  test(`${kind} update entry forwards the official asset, explicit stop authorization and selected source`, async () => {
    for (const download of [{ localArchivePath: 'D:\\Downloads\\Strata-cuda12.zip' }, { downloadUrl: 'https://mirror.example.com/engine.zip' }, {}]) {
      const f = parentFixture(kind); await f.open();
      assert.equal(f.calls.updates.length, 0, 'opening a confirmation must not start an update');
      f.dialog().props.onConfirm(download, assets[1].name); await f.settle();
      assert.deepEqual(f.calls.updates, [[runtime.installDir, assets[1].name, true, download]]);
      assert.equal(f.calls.started, 1);
    }
  });

  test(`${kind} update entry refreshes a changed release before accepting a downloaded ZIP`, async () => {
    const f = parentFixture(kind); await f.open();
    f.queryData['runtime-update-info'].data = { ...f.queryData['runtime-update-info'].data, latestVersion: '0.1.43', checkedAt: 101 };
    f.render(); f.dialog().props.onConfirm({ localArchivePath: 'D:\\Downloads\\old-release.zip' }, assets[1].name); await f.settle();
    assert.equal(f.calls.updates.length, 0);
    assert.equal(f.dialog().props.release.latestVersion, '0.1.43');
  });

  test(`${kind} update entry carries saved preferences into the confirmation and resolves newer releases safely`, async () => {
    for (const saved of [
      { mode: 'local', assetName: assets[1].name, releaseVersion: '0.1.42', localArchivePath: 'D:\\Downloads\\saved.zip' },
      { mode: 'mirror', assetName: assets[1].name, releaseVersion: '0.1.42', mirrorUrl: 'https://mirror.example.com/saved.zip' },
      { mode: 'mirror', assetName: assets[1].name, releaseVersion: '0.1.42', mirrorUrl: 'https://mirror.example.com/{version}/{asset}' },
    ]) {
      const f = parentFixture(kind, saved); await f.open();
      assert.equal(f.dialog().props.assetName, assets[1].name);
      const expected = resolveRuntimeDownloadPreferences(saved, f.queryData['runtime-update-info'].data).download;
      assert.deepEqual(JSON.parse(JSON.stringify(f.dialog().props.initialDownload)), JSON.parse(JSON.stringify(expected)));
      f.queryData['runtime-update-info'].data = { ...f.queryData['runtime-update-info'].data, latestVersion: '0.1.43', checkedAt: 101 };
      f.render(); f.dialog().props.onConfirm(expected, assets[1].name); await f.settle();
      assert.equal(f.calls.updates.length, 0);
      const next = f.dialog().props.initialDownload;
      if (saved.mode === 'local') assert.equal(next.localArchivePath, '');
      else if (saved.mirrorUrl.includes('{')) assert.equal(next.downloadUrl, `https://mirror.example.com/0.1.43/${assets[1].name}`);
      else assert.equal(next.downloadUrl, '');
    }
  });

  test(`${kind} update entry waits for saved download preferences instead of using an implicit official source`, async () => {
    const f = parentFixture(kind); f.queryData['runtime-download-preferences'].isSuccess = false; f.queryData['runtime-download-preferences'].isPending = true;
    f.render(); await f.settle();
    if (kind === 'manual') {
      const button = nodes(f.tree()).find(node => node.type === 'button' && node.props.className === 'primary');
      assert.equal(button.props.disabled, true); button.props.onClick(); f.render();
    }
    assert.equal(f.dialog(), undefined); assert.equal(f.calls.updates.length, 0);
    f.queryData['runtime-download-preferences'].isPending = false; f.queryData['runtime-download-preferences'].error = new Error('read failure');
    f.render(); await f.settle(); assert.equal(f.dialog(), undefined); assert.equal(f.calls.updates.length, 0);
  });
}

function settingsFixture(overrides = {}) {
  const compiled = ts.transpileModule(readFileSync(new URL('./RuntimeDownloadSettings.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const calls = { saved: [], tested: [], mutations: [], reloaded: 0 }, slots = [], effects = [];
  const preferences = { data: overrides.preferences ?? { mode: 'official' }, isPending: false, isSuccess: true, error: null, refetch: async () => { calls.reloaded++; } };
  let cursor = 0, tree;
  const slot = init => { const index = cursor++; return slots[index] ??= init(); };
  const sameDeps = (a, b) => a?.length === b?.length && a?.every((value, index) => Object.is(value, b[index]));
  const react = {
    useRef: value => slot(() => ({ current: value })),
    useState: initial => { const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial })); return [state.value, value => { state.value = typeof value === 'function' ? value(state.value) : value; }]; },
    useEffect: (fn, deps) => { const effect = slot(() => ({})); if (!sameDeps(effect.deps, deps)) { effect.deps = deps; effects.push(fn); } },
  };
  const core = {
    getRuntimeDownloadPreferences: async () => preferences.data, resolveRuntimeDownloadPreferences, runtimeDownloadSources, runtimeAssetLabel, runtimeEngineArchiveFilters,
    resolveRuntimeZipAsset: async (_dir, name) => overrides.resolveAsset ? await overrides.resolveAsset() : assets.find(asset => asset.name === name) ?? assets[1],
    normalizeError: error => ({ message: error instanceof Error ? error.message : String(error) }),
    saveRuntimeDownloadPreferences: async value => { calls.saved.push(JSON.parse(JSON.stringify(value))); if (overrides.save) await overrides.save(value); },
    testRuntimeZipDownload: async (assetName, download) => {
      calls.tested.push({ assetName, download: JSON.parse(JSON.stringify(download)) });
      return overrides.test ? await overrides.test() : { source: 'official', assetName, checkedAt: 100, checkedBytes: 65536, totalBytes: 2 * 1024 * 1024, rangeSupported: true, sha256Verified: false };
    },
  };
  for (const method of ['updateRuntimeZip', 'stop', 'start', 'restart', 'cancelTask']) core[method] = () => { calls.mutations.push(method); throw new Error(`unexpected mutation: ${method}`); };
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, navigator: { clipboard: { writeText: async () => {} } },
    require: name => ({ react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '@strata-manager/core': core, '../OfficialControls': sharedControls, '@tanstack/react-query': { useQuery: options => options.queryKey[0] === 'runtime-download-preferences' ? preferences : { data: overrides.assetError ? undefined : assets[1], error: overrides.assetError ?? null, isSuccess: !overrides.assetError, isError: !!overrides.assetError, isPending: false }, useQueryClient: () => ({ setQueryData: (_key, value) => { preferences.data = value; preferences.error = null; preferences.isSuccess = true; } }) } })[name] ?? {},
  });
  const props = { desktop: true, language: 'zh-CN', runtime, release: { latestVersion: '0.1.42', supportedVersion: '0.1.41', assets, checkedAt: 100 } };
  const render = () => { cursor = 0; tree = module.exports.RuntimeDownloadSettings(props); while (effects.length) effects.shift()(); return tree; };
  const button = label => nodes(tree).find(node => node.type === 'button' && (node.props['aria-label'] === label || text(node).trim() === label));
  const mode = value => { sourceControl(tree).props.onValueChange(value === 'mirror' ? 'custom' : value); render(); };
  const chooseAsset = value => { assetControl(tree).props.onValueChange(value); render(); };
  const mirror = value => { nodes(tree).find(node => node.props['aria-label'] === '镜像地址或模板').props.onChange({ target: { value } }); render(); };
  const settle = async () => { await tick(); render(); render(); };
  render(); return { calls, props, preferences, render, button, mode, chooseAsset, mirror, settle, tree: () => tree };
}

test('persistent settings separate saving from read-only network and full local integrity tests', async () => {
  const network = settingsFixture(); await network.settle(); network.chooseAsset(assets[1].name);
  network.button('测试下载来源').props.onClick(); await network.settle();
  assert.deepEqual(network.calls.tested, [{ assetName: assets[1].name, download: {} }]);
  assert.equal(network.calls.saved.length, 0); assert.deepEqual(network.calls.mutations, []);
  assert.ok(text(network.tree()).includes('连接正常')); assert.ok(text(network.tree()).includes('完整文件 SHA256 尚未验证'));
  assert.ok(text(network.tree()).includes('65,536')); assert.ok(text(network.tree()).includes('断点续传（Range）: 支持'));
  network.mode('mirror'); network.chooseAsset(assets[1].name); network.mirror('https://mirror.example.com/{version}/{asset}');
  network.button('保存下载设置').props.onClick(); await network.settle();
  assert.deepEqual(network.calls.saved, [{ mode: 'mirror', assetName: assets[1].name, releaseVersion: '0.1.42', mirrorUrl: 'https://mirror.example.com/{version}/{asset}' }]);
  assert.equal(network.calls.tested.length, 1, 'saving does not implicitly retest or update');
  const local = settingsFixture({ preferences: { mode: 'local', assetName: assets[1].name, releaseVersion: '0.1.42', localArchivePath: 'D:\\Downloads\\engine.zip' }, test: async () => ({ source: 'local', assetName: assets[1].name, checkedAt: 100, checkedBytes: 3145728, totalBytes: 3145728, sha256Verified: true }) }); await local.settle();
  local.button('测试下载来源').props.onClick(); await local.settle();
  assert.ok(text(local.tree()).includes('本地完整 SHA256 校验通过')); assert.equal(text(local.tree()).includes('断点续传（Range）'), false);
  assert.deepEqual(local.calls.mutations, []); assert.equal(local.calls.saved.length, 0);
});

test('saved built-in presets keep automatic package selection and tests use the actual CUDA12 match', async () => {
  for (const source of runtimeDownloadSources) {
    const f = settingsFixture(); await f.settle(); f.mode(source.id);
    assert.equal(assetControl(f.tree()).props.value, '');
    f.button('保存下载设置').props.onClick(); await f.settle();
    assert.deepEqual(f.calls.saved, [{ mode: 'mirror', releaseVersion: '0.1.42', sourceId: source.id }]);
    f.button('测试下载来源').props.onClick(); await f.settle();
    assert.deepEqual(f.calls.tested, [{ assetName: assets[1].name, download: { downloadUrl: source.urlTemplate.replace('{url}', assets[1].url) } }]);
    assert.deepEqual(f.calls.mutations, []);
  }
});

test('settings block invalid mirrors and preserve the selected source through failed preference reads', async () => {
  const f = settingsFixture(); await f.settle(); f.mode('mirror'); f.chooseAsset(assets[0].name);
  for (const value of ['http://mirror.example.com/file.zip', 'https://mirror.example.com/{unknown}', 'https://mirror.example.com/file.zip#fragment']) {
    f.mirror(value); assert.equal(f.button('保存下载设置').props.disabled, true); assert.equal(f.button('测试下载来源').props.disabled, true);
    assert.equal(f.calls.tested.length, 0);
  }
  f.preferences.error = new Error('store unavailable'); f.render();
  assert.equal(f.button('保存下载设置').props.disabled, true); assert.equal(f.button('测试下载来源').props.disabled, true);
  f.button('重新读取下载设置').props.onClick(); await f.settle(); assert.equal(f.calls.reloaded, 1);
  f.button('恢复官方自动下载').props.onClick(); await f.settle();
  assert.deepEqual(f.calls.saved, [{ mode: 'official' }]); assert.deepEqual(f.calls.mutations, []);
});

test('settings discard test results from an older release and stale save handlers cannot persist old sources', async () => {
  const request = deferred(); const f = settingsFixture({ test: () => request.promise }); await f.settle(); f.chooseAsset(assets[0].name);
  const oldSave = f.button('保存下载设置'); f.button('测试下载来源').props.onClick(); f.render();
  f.props.release = { ...f.props.release, latestVersion: '0.1.43', checkedAt: 101 }; f.render();
  request.resolve({ source: 'official', assetName: assets[0].name, checkedAt: 100, checkedBytes: 65536, totalBytes: 2 * 1024 * 1024, rangeSupported: true, sha256Verified: false }); await f.settle();
  assert.equal(text(f.tree()).includes('连接正常'), false); oldSave.props.onClick(); await f.settle();
  assert.equal(f.calls.saved.length, 0); assert.deepEqual(f.calls.mutations, []);
});

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
  const notice = nodes(f.tree()).find(node => node.props.role === 'status' && hasClasses(node, 'notice', 'warning'));
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
  assert.equal(nodes(idle.tree()).some(node => hasClasses(node, 'notice', 'warning')), false);
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
