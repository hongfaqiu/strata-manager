import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('./OfficialUpdatePanel.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const jsx = (type, props) => ({ type, props: props ?? {} });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree) : !tree || typeof tree !== 'object' ? '' : [tree.props?.children].flat(Infinity).map(text).join('');
const profile = { id: 'local', name: 'Qwen', installDir: '/opt/strata', configPath: '/opt/strata/strata.json', managed: true };

function render({ plan, tasks = [], logs = [], props = {} }) {
  const calls = { plan: 0, update: 0, cancel: [] };
  const slots = []; let cursor = 0;
  const react = {
    useState: initial => { const index = cursor++; slots[index] ??= { value: initial }; const s = slots[index]; return [s.value, v => { s.value = typeof v === 'function' ? v(s.value) : v; }]; },
    useEffect: () => {},
  };
  const query = {
    useQuery: ({ queryKey }) => queryKey[0] === 'tasks' ? { data: tasks } : { data: plan, isFetching: false, error: null, refetch: async () => {} },
    useQueryClient: () => ({ invalidateQueries: async () => {}, setQueryData: () => {} }),
  };
  const core = {
    officialUpdatePlan: async () => { calls.plan++; return plan; },
    officialUpdate: async () => { calls.update++; return { id: 'official-1', kind: 'officialUpdate', state: 'running' }; },
    cancelTask: async id => { calls.cancel.push(id); },
    listTasks: async () => tasks, readTaskLogs: async () => logs,
    normalizeError: error => ({ message: String(error?.message ?? error) }),
  };
  const module = { exports: {} };
  const modules = { react, '@tanstack/react-query': query, '@strata-manager/core': core, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': new Proxy({}, { get: (_, name) => name }), '../components': { Panel: 'panel' } };
  vm.runInNewContext(source, { module, exports: module.exports, require: name => modules[name], window: { setInterval, clearInterval } });
  const tree = module.exports.OfficialUpdatePanel({ profile, desktop: true, language: 'zh-CN', ...props });
  return { tree, calls, button: nodes(tree).find(node => node.type === 'button' && node.props.className === 'primary') };
}

test('dirty tracked files block the official script and are listed, never forced', () => {
  const { tree, button } = render({ plan: { script: 'update.sh', gitClone: true, dirtyFiles: ['serve/server.py', 'setup.py'] } });
  assert.equal(button.props.disabled, true);
  const dirty = nodes(tree).find(node => node.props?.['data-testid'] === 'official-update-dirty');
  assert.match(text(dirty), /serve\/server\.py/);
  assert.match(text(dirty), /不会强制覆盖/);
});

test('a clean clone re-checks the plan and starts the upstream script task', async () => {
  const { tree, button, calls } = render({ plan: { script: 'update.sh', gitClone: true, dirtyFiles: [] } });
  assert.equal(button.props.disabled, false);
  assert.match(text(tree), /官方 update\.sh/);
  await button.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([calls.plan, calls.update], [1, 1]);
});

test('a running service or a non-git copy is surfaced before anything runs', () => {
  const running = render({ plan: { script: 'update.sh', gitClone: false, dirtyFiles: [] }, props: { serviceRunning: true } });
  assert.equal(running.button.props.disabled, true);
  assert.match(text(running.tree), /请先停止当前服务/);
  assert.match(text(running.tree), /不是 git 克隆/);
});

test('a running official update can be cancelled', () => {
  const { tree, button, calls } = render({ plan: { script: 'UPDATE.bat', gitClone: true, dirtyFiles: [] }, tasks: [{ id: 'official-1', kind: 'officialUpdate', state: 'running' }] });
  assert.equal(button.props.disabled, true);
  assert.match(text(button), /正在执行官方更新脚本/);
  const cancel = nodes(tree).find(node => node.type === 'button' && text(node).includes('取消'));
  cancel.props.onClick();
  assert.deepEqual(calls.cancel, ['official-1']);
});
