import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const jsx = (type, props) => ({ type, props: props ?? {} });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const text = tree => nodes(tree).flatMap(node => [node.props.children].flat(Infinity)).filter(child => typeof child === 'string' || typeof child === 'number').join('');
const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const contextExtension = { exports: {} };
vm.runInNewContext(compile('../../../../packages/core/src/context-extension.ts'), { module: contextExtension, exports: contextExtension.exports, require: () => ({}) });
const orcaImport = { exports: {} };
vm.runInNewContext(compile('../../../../packages/core/src/orca-import.ts'), { module: orcaImport, exports: orcaImport.exports, require: () => ({}) });
const gpuRoles = { exports: {} };
vm.runInNewContext(compile('../../../../packages/core/src/gpu-roles.ts'), { module: gpuRoles, exports: gpuRoles.exports, require: () => ({}), structuredClone });
const concurrency = { exports: {} };
vm.runInNewContext(compile('../../../../packages/core/src/concurrency.ts'), { module: concurrency, exports: concurrency.exports, require: name => name === './context-extension' ? contextExtension.exports : name === './orca-import' ? orcaImport.exports : name === './gpu-roles' ? gpuRoles.exports : {} });
const keys = ['parallel', '--batch', '--batch-mtp', '--batch-groups', '--adapt-async', '--trim-stage-weights', '--conversation-cache-mib', '--conversation-cache-slots', '--max-context', 'env.STRATA_BATCH_ATTN_ROWS', 'env.STRATA_BATCH_GDN_GROUPS', 'env.STRATA_PIPED_CONCURRENT'];
const core = { ...contextExtension.exports, ...concurrency.exports, STARTUP_TUNING_FIELDS: keys.map(key => ({ key })), applyStartupField: config => config, assessSetupResources: async () => { throw Error('not used'); } };
const Segmented = props => jsx('segmented', props), Toggle = props => jsx('toggle', props);
const GIB = 2 ** 30;

function render(config, { hardware, values = {}, platform = 'other', zh = true, engineVersion, hostOs, userAgent = '' } = {}) {
  const module = { exports: {} };
  const react = { useMemo: f => f(), useState: v => [typeof v === 'function' ? v() : v, () => {}], createContext: v => ({ v }), useContext: c => c.v };
  vm.runInNewContext(compile('./ConcurrencyCard.tsx'), { module, exports: module.exports, navigator: { userAgent }, require: name => ({ react, '@tanstack/react-query': { useQuery: () => ({ data: undefined }) }, '@strata-manager/core': core, '../OfficialControls': { Segmented, Toggle }, './concurrencyContext': { useConcurrencyEnvironment: () => ({ desktop: true, installationId: 'a' }) }, 'react/jsx-runtime': { jsx, jsxs: jsx } })[name] ?? {} });
  const changes = [];
  const tree = module.exports.ConcurrencyCard({ draft: config, fieldValue: field => values[field.key] ?? '', onFieldChange: (field, value) => changes.push([field.key, value]), zh, hardware, platform, engineVersion, hostOs });
  return { tree, changes, byId: id => nodes(tree).find(node => node.props['data-testid'] === id) };
}
const hw = (...gib) => ({ gpus: gib.map((g, id) => ({ id, name: 'GPU', vendor: 'nvidia', totalBytes: g * GIB })), totalMemoryBytes: 64 * GIB });

test('a 32 GB card in multi-user mode recommends four slots and applies them with companions', () => {
  const { byId, changes } = render({ parallel: 4, args: ['--native', 'Qwen-Q2_0.gguf', '--max-context', '32768', '--mtp', 'm.gguf'] }, { hardware: hw(32) });
  assert.match(text(byId('concurrency-recommendation')), /4 个同时/);
  const apply = byId('concurrency-apply');
  assert.equal(apply.props.disabled, false);
  apply.props.onClick();
  assert.deepEqual(changes, [['parallel', '4'], ['--batch-mtp', 'true'], ['--adapt-async', '1']]);
  assert.ok(byId('concurrency-experimental'), 'experimental switches appear once slots are on');
  assert.match(text(byId('concurrency-experimental')), /实验/);
});

test('one at a time hides experimental switches; conflicts show a fix; Metal is refused; long context is noted', () => {
  assert.equal(render({ args: ['--native', 'Qwen-IQ3_S.gguf'] }, { hardware: hw(16) }).byId('concurrency-experimental'), undefined);
  const conflict = render({ parallel: 2, args: ['--native', 'Qwen-IQ3_S.gguf', '--batch', '4', '--max-context', '524288'] }, { hardware: hw(16), platform: 'mac' });
  const issues = nodes(conflict.byId('concurrency-issues')).filter(node => node.type === 'li');
  assert.deepEqual(issues.map(node => node.props['data-code']).slice(0, 2), ['parallel_batch_conflict', 'metal_unsupported']);
  nodes(issues[0]).find(node => node.type === 'button').props.onClick();
  assert.deepEqual(conflict.changes, [['parallel', '4'], ['--batch', '']]);
  assert.ok(conflict.byId('concurrency-long-context'));
});

test('English copy and unknown hardware stay at one at a time', () => {
  const { byId } = render({ args: ['--native', 'custom.gguf'] }, { hardware: null, zh: false });
  assert.match(text(byId('concurrency-recommendation')), /One at a time/);
});

test('from engine 0.1.55 the attention / GDN switches are left to the engine on Linux + NVIDIA; a value already set keeps its switch (upstream #4841)', () => {
  const toggles = tree => nodes(tree).filter(node => typeof node.props.onCheckedChange === 'function').map(node => node.props.ariaLabel);
  const both = tree => toggles(tree).filter(label => /ATTN_ROWS|GDN_GROUPS/.test(label)).length;
  const base = { parallel: 4, args: ['--native', 'Qwen-Q2_0.gguf', '--max-context', '32768', '--mtp', 'm.gguf'] };
  const old = render(base, { hardware: hw(32), engineVersion: '0.1.54', hostOs: 'linux' });
  assert.equal(old.byId('concurrency-engine-defaults'), undefined);
  assert.equal(old.byId('concurrency-engine-defaults-elsewhere'), undefined);
  assert.equal(both(old.tree), 2);
  const fresh = render(base, { hardware: hw(32), engineVersion: '0.1.55', hostOs: 'linux' });
  assert.match(text(fresh.byId('concurrency-engine-defaults')), /0\.1\.55 起.*Linux \+ NVIDIA（CUDA）.*不再写入/);
  assert.equal(both(fresh.tree), 0);
  assert.ok(toggles(fresh.tree).some(label => /PIPED_CONCURRENT/.test(label)), 'the pipelined switch is still offered');
  // The host OS comes from the webview's user agent when no fixture sets it.
  assert.equal(both(render(base, { hardware: hw(32), engineVersion: '0.1.55', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }).tree), 0);
  const en = render(base, { hardware: hw(32), engineVersion: '0.1.56', zh: false, hostOs: 'linux' });
  assert.match(text(en.byId('concurrency-engine-defaults')), /from engine 0\.1\.55 the engine turns them on itself on Linux with NVIDIA \(CUDA\)/);
  const kept = render({ ...base, env: { STRATA_BATCH_GDN_GROUPS: '1' } }, { hardware: hw(32), engineVersion: '0.1.55', hostOs: 'linux' });
  const gdn = nodes(kept.tree).find(node => typeof node.props.onCheckedChange === 'function' && /GDN_GROUPS/.test(node.props.ariaLabel));
  assert.ok(gdn, 'a value in the config keeps its switch so it can be removed');
  assert.match(text(kept.byId('concurrency-experimental')), /覆盖引擎默认/);
  gdn.props.onCheckedChange(false);
  assert.deepEqual(kept.changes, [['env.STRATA_BATCH_GDN_GROUPS', '']]);
});

test('Windows, AMD (hip) and DeepSeek keep both switches on engine 0.1.55, where upstream does not turn them on', () => {
  const both = tree => nodes(tree).filter(node => typeof node.props.onCheckedChange === 'function' && /ATTN_ROWS|GDN_GROUPS/.test(node.props.ariaLabel)).length;
  const base = { parallel: 4, args: ['--native', 'Qwen-Q2_0.gguf', '--max-context', '32768', '--mtp', 'm.gguf'] };
  const amd = { gpus: [{ id: 0, name: 'AMD Radeon RX 7900 XTX', vendor: 'amd', totalBytes: 24 * GIB }], totalMemoryBytes: 64 * GIB };
  const cases = [
    render(base, { hardware: hw(32), engineVersion: '0.1.55', hostOs: 'windows' }),
    render(base, { hardware: hw(32), engineVersion: '0.1.55', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }),
    render({ ...base, backend: 'hip' }, { hardware: amd, engineVersion: '0.1.55', hostOs: 'linux' }),
    render(base, { hardware: amd, engineVersion: '0.1.55', hostOs: 'linux' }),
    render({ ...base, arch: 'deepseek41' }, { hardware: hw(32), engineVersion: '0.1.55', hostOs: 'linux' }),
  ];
  for (const view of cases) {
    assert.equal(both(view.tree), 2);
    assert.equal(view.byId('concurrency-engine-defaults'), undefined);
    assert.match(text(view.byId('concurrency-engine-defaults-elsewhere')), /只在 Linux \+ NVIDIA（CUDA）上自动开启.*仍由这里的开关决定/);
  }
  assert.match(text(render(base, { hardware: hw(32), engineVersion: '0.1.55', hostOs: 'windows', zh: false }).byId('concurrency-engine-defaults-elsewhere')), /only on Linux with NVIDIA \(CUDA\).*these switches still decide/);
});
