import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { runtimeVersions } from '../runtimeVersionsForTests.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const jsx = (type, props) => ({ type, props: props ?? {} });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree) : !tree || typeof tree !== 'object' ? '' : [tree.props?.children].flat(Infinity).map(text).join('');
const compiled = ts.transpileModule(readFileSync(new URL('./InstalledRuntimesPanel.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;

const GB = 1024 ** 3;
const entry = (installDir, extra = {}) => ({ installDir, pythonPath: `${installDir}/python`, readiness: 'ready', owned: true, current: false, running: false, rollback: false, switching: false, profiles: [], cleanup: false, installedAt: Date.UTC(2026, 9, 1), ...extra });
const inventory = () => ({
  runtimes: [
    entry('/m/runtimes/release-old', { releaseVersion: '0.2.0', engineVersion: '0.1.45.3', cleanup: true }),
    entry('/m/runtimes/release-cur', { releaseVersion: '0.2.3', engineVersion: '0.1.48', current: true, protectedReason: '当前正在使用' }),
    entry('/home/me/Strata', { engineVersion: '0.1.47', rollback: true, owned: false, protectedReason: '不是 Manager 安装的目录，不会删除', lastUsedAt: Date.UTC(2026, 9, 20) }),
    entry('/m/runtimes/release-ref', { releaseVersion: '0.2.1', profiles: [{ id: 'p1', name: 'Qwen · 131K' }] }),
  ],
  leftovers: [{ path: '/m/downloads/x.tar.gz.part', kind: 'partialDownload' }],
  autoCleanup: true, busy: false,
});
const sizes = { '/m/runtimes/release-old': 2 * GB, '/m/runtimes/release-cur': 2 * GB, '/home/me/Strata': GB, '/m/runtimes/release-ref': GB, '/m/downloads/x.tar.gz.part': 512 * 1024 ** 2 };

function fixture({ tasks = [], data = inventory(), failSwitch = false } = {}) {
  const calls = { deleted: [], cleaned: [], switched: [], saved: [], started: 0, invalidated: [] };
  const slots = []; let cursor = 0, tree;
  const slot = init => { const index = cursor++; return slots[index] ??= init(); };
  const react = {
    useState: initial => { const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial })); return [state.value, value => { state.value = typeof value === 'function' ? value(state.value) : value; }]; },
    useEffect: () => {},
  };
  const queries = {
    'runtime-installed-versions': { data, isPending: false },
    'runtime-release-versions': { data: { versions: [{ version: '0.2.3', engineVersion: '0.1.48' }, { version: '0.2.2', engineVersion: '0.1.47' }] } },
    tasks: { data: tasks },
  };
  const core = {
    ...runtimeVersions,
    legacyLanguage: language => language,
    normalizeError: error => ({ message: error instanceof Error ? error.message : String(error) }),
    listTasks: async () => tasks, installedRuntimes: async () => data, installedRuntimeSize: async path => sizes[path],
    deleteInstalledRuntime: async (dir, profiles) => { calls.deleted.push([dir, [...profiles]]); return sizes[dir]; },
    cleanupInstalledRuntimes: async paths => { calls.cleaned.push([...paths]); return { removed: [...paths], skipped: [], freedBytes: paths.reduce((sum, path) => sum + sizes[path], 0) }; },
    switchInstalledRuntime: async dir => { calls.switched.push(dir); if (failSwitch) throw new Error('有任务正在进行'); return { id: 'switch', kind: 'update', state: 'running' }; },
    saveStore: async (...args) => { calls.saved.push(args); },
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, Date, Intl,
    require: name => ({
      react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '@strata-manager/core': core,
      '@tanstack/react-query': {
        useQuery: options => queries[options.queryKey[0]],
        useQueries: ({ queries: list }) => list.map(item => ({ data: sizes[item.queryKey[1]] })),
        useQueryClient: () => ({ invalidateQueries: async options => { calls.invalidated.push(options.queryKey[0]); }, removeQueries: () => {} }),
      },
      '../components': { Panel: 'panel', Dialog: 'dialog' }, '../OfficialControls': { Checkbox: 'checkbox' },
      'lucide-react': { LoaderCircle: 'spinner', Repeat2: 'switch-icon', Trash2: 'trash-icon' },
    })[name] ?? {},
  });
  const props = { language: 'zh-CN', desktop: true, onSwitchStarted: () => { calls.started += 1; } };
  const render = () => { cursor = 0; tree = module.exports.InstalledRuntimesPanel(props); return tree; };
  const rows = () => nodes(tree).filter(node => node.props['data-testid'] === 'installed-runtime');
  const button = (scope, label) => nodes(scope).find(node => node.type === 'button' && text(node).includes(label));
  const settle = async () => { await tick(); render(); };
  return { calls, props, render, rows, button, settle, tree: () => tree, queries };
}

test('the list is always shown, the version in use first, with release, engine, size and badges', () => {
  const f = fixture(); f.render();
  const rows = f.rows();
  assert.equal(rows.length, 4);
  assert.match(text(rows[0]), /^Release v0\.2\.3 · 引擎 0\.1\.48当前使用/);
  assert.ok(text(rows[0]).includes('占用 2.0 GB'));
  assert.equal(f.button(rows[0], '删除'), undefined, 'the current version cannot be deleted or switched to');
  assert.equal(f.button(rows[0], '切换到此版本'), undefined);
  const user = rows.find(row => text(row).includes('/home/me/Strata'));
  assert.ok(text(user).startsWith('Release v0.2.2 · 引擎 0.1.47'), 'a folder without a release record shows the release that shipped its engine');
  assert.ok(text(user).includes('可回退') && text(user).includes('自行安装') && text(user).includes('上次使用'));
  assert.equal(f.button(user, '删除').props.disabled, true);
  assert.equal(f.button(user, '删除').props['data-tooltip'], '不是 Manager 安装的目录，不会删除');
  assert.ok(text(rows.find(row => text(row).includes('release-ref'))).includes('被 1 个配置引用'));
  assert.ok(text(f.tree()).includes('4 个版本 · 共 6.0 GB'));
  assert.ok(text(f.tree()).includes('更新成功后自动清理旧版本'));
  assert.equal(nodes(f.tree()).find(node => node.type === 'checkbox').props.checked, true, 'automatic cleanup is on by default');
});

test('一键清理 shows what is deleted and the space freed, then deletes only those items', async () => {
  const f = fixture(); f.render();
  const action = f.tree().props.action;
  assert.equal(text(action), '一键清理 · 可释放 2.5 GB');
  action.props.onClick(); f.render();
  const dialog = nodes(f.tree()).find(node => node.props?.['data-testid'] === 'runtime-cleanup-dialog');
  assert.ok(text(dialog).includes('共释放 2.5 GB'));
  assert.ok(text(dialog).includes('Release v0.2.0') && text(dialog).includes('未完成的下载'));
  assert.ok(text(dialog).includes('保留：Release v0.2.3'));
  assert.equal(f.calls.cleaned.length, 0, 'nothing happens before confirmation');
  await f.button(dialog, '清理').props.onClick(); await f.settle();
  assert.deepEqual(f.calls.cleaned, [['/m/runtimes/release-old', '/m/downloads/x.tar.gz.part']]);
  assert.ok(text(f.tree()).includes('已清理 2 项，释放 2.5 GB'));
});

test('deleting a version used by a configuration needs an explicit confirmation of that configuration', async () => {
  const f = fixture(); f.render();
  const row = f.rows().find(item => text(item).includes('release-ref'));
  f.button(row, '删除').props.onClick(); f.render();
  let dialog = nodes(f.tree()).find(node => node.props?.['data-testid'] === 'runtime-delete-dialog');
  assert.ok(text(dialog).includes('Qwen · 131K') && text(dialog).includes('将释放 1.0 GB'));
  assert.equal(f.button(dialog, '删除').props.disabled, true);
  nodes(dialog).find(node => node.type === 'checkbox').props.onChange({ target: { checked: true } }); f.render();
  dialog = nodes(f.tree()).find(node => node.props?.['data-testid'] === 'runtime-delete-dialog');
  assert.equal(f.button(dialog, '删除').props.disabled, false);
  await f.button(dialog, '删除').props.onClick(); await f.settle();
  assert.deepEqual(f.calls.deleted, [['/m/runtimes/release-ref', ['p1']]]);
  assert.ok(text(f.tree()).includes('已删除，释放 1.0 GB'));
});

test('switching to an installed version confirms, keeps the current one and uses no download', async () => {
  const f = fixture(); f.render();
  const row = f.rows().find(item => text(item).includes('/home/me/Strata'));
  f.button(row, '切换到此版本').props.onClick(); f.render();
  const dialog = nodes(f.tree()).find(node => node.type === 'runtime-switch-dialog' || node.type?.name === 'RuntimeSwitchDialog');
  assert.equal(dialog.props.target.installDir, '/home/me/Strata');
  const rendered = dialog.type(dialog.props);
  assert.ok(text(rendered).includes('无需下载'));
  assert.ok(text(rendered).includes('当前的 Release v0.2.3 · 引擎 0.1.48 会保留'));
  assert.ok(text(rendered).includes('失败会自动恢复当前版本'));
  await dialog.props.onConfirm(); await f.settle();
  assert.deepEqual(f.calls.switched, ['/home/me/Strata']);
  assert.equal(f.calls.started, 1);
  assert.equal(nodes(f.tree()).find(node => node.type?.name === 'RuntimeSwitchDialog'), undefined);
});

test('a refused switch keeps the dialog open with the reason', async () => {
  const f = fixture({ failSwitch: true }); f.render();
  f.button(f.rows()[1], '切换到此版本').props.onClick(); f.render();
  await nodes(f.tree()).find(node => node.type?.name === 'RuntimeSwitchDialog').props.onConfirm(); await f.settle();
  assert.equal(nodes(f.tree()).find(node => node.type?.name === 'RuntimeSwitchDialog').props.error, '有任务正在进行');
  assert.equal(f.calls.started, 0);
});

test('while a task runs nothing can be switched, deleted or cleaned', () => {
  const f = fixture({ tasks: [{ id: 't', kind: 'update', state: 'running' }] }); f.render();
  for (const row of f.rows()) for (const node of nodes(row).filter(item => item.type === 'button')) assert.equal(node.props.disabled, true);
  assert.equal(f.tree().props.action.props.disabled, true);
});

test('turning automatic cleanup off is saved', async () => {
  const f = fixture(); f.render();
  await nodes(f.tree()).find(node => node.type === 'checkbox').props.onChange({ target: { checked: false } }); f.render();
  assert.deepEqual(f.calls.saved, [['runtimeAutoCleanup', false]]);
  assert.equal(nodes(f.tree()).find(node => node.type === 'checkbox').props.checked, false);
});
