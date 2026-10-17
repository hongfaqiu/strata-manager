import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const jsx = (type, props) => ({ type, props: props ?? {} });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const text = tree => nodes(tree).flatMap(node => [node.props.children].flat(Infinity)).filter(child => typeof child === 'string' || typeof child === 'number').join('');
const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const concurrency = { exports: {} };
vm.runInNewContext(compile('../../../../packages/core/src/concurrency.ts'), { module: concurrency, exports: concurrency.exports, require: () => ({}) });
const keys = ['parallel', '--batch', '--batch-mtp', '--batch-groups', '--adapt-async', '--trim-stage-weights', '--conversation-cache-mib', '--conversation-cache-slots', '--max-context', 'env.STRATA_BATCH_ATTN_ROWS', 'env.STRATA_BATCH_GDN_GROUPS', 'env.STRATA_PIPED_CONCURRENT'];
const core = { ...concurrency.exports, STARTUP_TUNING_FIELDS: keys.map(key => ({ key })), applyStartupField: config => config, assessSetupResources: async () => { throw Error('not used'); } };
const Segmented = props => jsx('segmented', props), Toggle = props => jsx('toggle', props);
const GIB = 2 ** 30;

function render(config, { hardware, values = {}, platform = 'other', zh = true } = {}) {
  const module = { exports: {} };
  const react = { useMemo: f => f(), useState: v => [typeof v === 'function' ? v() : v, () => {}], createContext: v => ({ v }), useContext: c => c.v };
  vm.runInNewContext(compile('./ConcurrencyCard.tsx'), { module, exports: module.exports, navigator: { userAgent: '' }, require: name => ({ react, '@tanstack/react-query': { useQuery: () => ({ data: undefined }) }, '@strata-manager/core': core, '../OfficialControls': { Segmented, Toggle }, './concurrencyContext': { useConcurrencyEnvironment: () => ({ desktop: true, installationId: 'a' }) }, 'react/jsx-runtime': { jsx, jsxs: jsx } })[name] ?? {} });
  const changes = [];
  const tree = module.exports.ConcurrencyCard({ draft: config, fieldValue: field => values[field.key] ?? '', onFieldChange: (field, value) => changes.push([field.key, value]), zh, hardware, platform });
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
