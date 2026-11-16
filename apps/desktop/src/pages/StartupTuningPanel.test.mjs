import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const jsx = (type, props) => ({ type, props: props ?? {} });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;

const loadCore = () => {
  const cache = new Map();
  const requireCore = name => {
    if (!name.startsWith('.')) return {};
    const path = new URL(`${name.endsWith('.ts') ? name : `${name}.ts`}`, new URL('../../../../packages/core/src/', import.meta.url)).href;
    if (cache.has(path)) return cache.get(path).exports;
    const mod = { exports: {} };
    cache.set(path, mod);
    vm.runInNewContext(compile(path), { module: mod, exports: mod.exports, require: requireCore, structuredClone, URL, RegExp, Object, Array, Set, Map, Math, Number, String, Boolean, JSON, Error });
    return mod.exports;
  };
  return requireCore('./config-tuning');
};

const coreExports = loadCore();
const catalogExports = (() => {
  const mod = { exports: {} };
  vm.runInNewContext(compile('../../../../packages/core/src/catalog.ts'), { module: mod, exports: mod.exports, require: () => ({}), Object, Array, Set, Map, Math, Number, String, Boolean, JSON, RegExp });
  return mod.exports;
})();
const deepseekExports = (() => {
  const mod = { exports: {} };
  vm.runInNewContext(compile('../../../../packages/core/src/deepseek41-config.ts'), { module: mod, exports: mod.exports, require: name => name === './catalog' ? catalogExports : {}, structuredClone, Object, Array, Set, Map, Math, Number, String, Boolean, JSON, RegExp, Error });
  return mod.exports;
})();
const contextExtExports = (() => {
  const mod = { exports: {} };
  vm.runInNewContext(compile('../../../../packages/core/src/context-extension.ts'), { module: mod, exports: mod.exports, require: () => ({}), Object, Array, Set, Map, Math, Number, String, Boolean, JSON, RegExp, Error });
  return mod.exports;
})();
const draftingExports = (() => {
  const mod = { exports: {} };
  vm.runInNewContext(compile('../../../../packages/core/src/drafting.ts'), { module: mod, exports: mod.exports, require: () => ({}), Object, Array, Set, Map, Math, Number, String, Boolean, JSON, RegExp });
  return mod.exports;
})();

const core = {
  ...coreExports,
  ...deepseekExports,
  ...contextExtExports,
  ...draftingExports,
  installDirKey: value => value ?? '',
  formatContextTokens: value => String(value),
  normalizeError: error => ({ message: String(error?.message ?? error) }),
};

const Dropdown = props => jsx('dropdown', props);
const Checkbox = props => jsx('checkbox', props);
const Segmented = props => jsx('segmented', props);

function renderPanel({ config, engineHelpFlags = null, initialNewFlag = '' }) {
  const states = [];
  let stateIndex = 0;
  const refs = [];
  let refIndex = 0;
  const hooks = {
    useState: initial => {
      const idx = stateIndex++;
      if (!(idx in states)) states[idx] = typeof initial === 'function' ? initial() : initial;
      const setState = value => { states[idx] = typeof value === 'function' ? value(states[idx]) : value; };
      return [states[idx], setState];
    },
    useRef: initial => {
      const idx = refIndex++;
      if (!(idx in refs)) refs[idx] = { current: initial };
      return refs[idx];
    },
    useEffect: () => {},
  };

  const mod = { exports: {} };
  const dummy = name => props => jsx(name, props);
  vm.runInNewContext(compile('./StartupTuningPanel.tsx'), {
    module: mod,
    exports: mod.exports,
    structuredClone,
    Object,
    Array,
    Set,
    Map,
    Math,
    Number,
    String,
    Boolean,
    JSON,
    Error,
    require: name => ({
      react: hooks,
      '@tanstack/react-query': {
        useQuery: ({ queryKey }) => {
          if (queryKey[0] === 'engine-help-flags') return { data: engineHelpFlags ? { flags: engineHelpFlags, source: 'help' } : undefined, error: null, isPending: false, isFetching: false };
          if (queryKey[0] === 'startup-config') return { data: { config, revision: 'r1' }, error: null, isPending: false, isFetching: false };
          return { data: undefined, error: null, isPending: false, isFetching: false };
        },
        useQueryClient: () => ({ invalidateQueries: async () => {} }),
      },
      '@strata-manager/core': core,
      'lucide-react': new Proxy({}, { get: (_, prop) => dummy(String(prop)) }),
      '../components': { Dialog: dummy('dialog') },
      '../OfficialControls': { Checkbox, Dropdown, Segmented },
      './StartupConfigurationNode': { ConfigurationNode: dummy('config-node') },
      './StartupNetworkPowerSettings': { StartupNetworkPowerSettings: dummy('net-power') },
      './StartupQuickParams': { StartupQuickParams: dummy('quick-params') },
      './Deepseek41RunOptions': { Deepseek41RunOptions: dummy('dsv41') },
      './StartupControlVector': { StartupControlVector: dummy('cvec') },
      './ContextExtensionNotice': { ContextExtensionNotice: dummy('ctx-notice') },
      './GpuRolesEditor': { GpuRolesEditor: dummy('gpu-roles'), cardsFromEnvironment: () => [] },
      './StartupDraftingControl': { StartupDraftingControl: dummy('drafting-ctrl') },
      '../useDraftGuard': { useDraftGuard: () => ({ request: fn => fn(), dialog: null }) },
      'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    })[name] ?? {},
  });

  const profile = { id: 'p1', name: 'Qwen', baseUrl: 'http://127.0.0.1:18081', configPath: '/tmp/c.json', managed: true };
  const runRender = () => {
    stateIndex = 0;
    refIndex = 0;
    return mod.exports.StartupTuningPanel({ profile, desktop: true, language: 'zh-CN', onError: () => {} });
  };
  let tree = runRender();
  if (initialNewFlag) {
    const newArgDropdown = nodes(tree).find(n => n.type === Dropdown && n.props.ariaLabel === '新增参数名称');
    assert.ok(newArgDropdown, 'expected 新增参数名称 dropdown');
    newArgDropdown.props.onValueChange(initialNewFlag);
    tree = runRender();
  }
  return tree;
}

test('full engine argument list offers --draft, --draft-model and --draft-conf autocomplete with arity 1 (#229)', () => {
  const tree = renderPanel({ config: { args: ['--native', 'm.gguf', '--draft', 'dflash2'] }, initialNewFlag: '--draft' });
  const dropdowns = nodes(tree).filter(n => n.type === Dropdown);
  const newArg = dropdowns.find(n => n.props.ariaLabel === '新增参数名称');
  assert.ok(newArg, 'expected 新增参数名称 dropdown');
  const optionValues = newArg.props.options.map(o => o.value);
  assert.ok(optionValues.includes('--draft'));
  assert.ok(optionValues.includes('--draft-model'));
  assert.ok(optionValues.includes('--draft-conf'));

  // Known arity (1) suppresses custom operand count selector and renders 1 operand input.
  assert.equal(dropdowns.find(n => n.props.ariaLabel === '自定义参数值数量'), undefined);
  const operandInput = nodes(tree).find(n => n.type === 'input' && n.props['aria-label'] === '新增参数值 1');
  assert.ok(operandInput, 'expected 1 operand input for --draft');

  // Existing --draft row offers --draft in flag autocomplete and dflash2 in operand autocomplete.
  const rowFlag = dropdowns.find(n => n.props.ariaLabel === '参数名称 3');
  assert.ok(rowFlag.props.options.some(o => o.value === '--draft'));
  const rowOperand = dropdowns.find(n => n.props.ariaLabel === '--draft 值 1');
  assert.ok(rowOperand.props.options.some(o => o.value === 'dflash2'));
});

test('merges engine --help flags for non-DeepSeek configs while keeping DeepSeek isolated', () => {
  const qwenTree = renderPanel({ config: { args: ['--native', 'm.gguf'] }, engineHelpFlags: ['--draft', '--future-engine-flag'] });
  const qwenNewArg = nodes(qwenTree).find(n => n.type === Dropdown && n.props.ariaLabel === '新增参数名称');
  const qwenValues = qwenNewArg.props.options.map(o => o.value);
  assert.equal(qwenValues.filter(v => v === '--draft').length, 1, 'deduplicates --draft');
  assert.ok(qwenValues.includes('--future-engine-flag'));

  const dsv41Tree = renderPanel({ config: { arch: 'deepseek41', args: ['--pack', '/d'] }, engineHelpFlags: ['--draft'] });
  const dsv41NewArg = nodes(dsv41Tree).find(n => n.type === Dropdown && n.props.ariaLabel === '新增参数名称');
  assert.equal(dsv41NewArg.props.options.some(o => o.value === '--draft'), false);
});
