import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// #225: a preparation that kept the existing settings says what differs and offers matching actions.
const jsx = (type, props) => ({ type, props: props ?? {} });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const text = tree => nodes(tree).flatMap(node => [node.props.children].flat(Infinity)).filter(child => typeof child === 'string').join('');
const source = ts.transpileModule(readFileSync(new URL('./SetupHandoffActions.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const strings = { setupKeptSettingsTitle: 'TITLE', setupKeptSettingsHint: 'HINT', setupDiffContext: 'CTX', setupDiffImages: 'IMG', setupDiffNow: 'NOW', setupDiffThisTime: 'THIS', setupImagesOn: 'ON', setupImagesOff: 'OFF', useRegisteredConfig: 'KEEP', setupChangeSettings: 'CHANGE', localSetupDetectAgain: 'AGAIN', viewModels: 'VIEW' };

function render(handoff, canRecheck = true) {
  const module = { exports: {} };
  const react = { useState: value => [value, () => {}], useRef: value => ({ current: value }), useEffect: () => {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: name => ({ react, 'react-i18next': { useTranslation: () => ({ t: key => strings[key] ?? key }) }, 'lucide-react': { LoaderCircle: () => null }, '../OfficialControls': { Dropdown: props => jsx('dropdown', props) }, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' } })[name] ?? {} });
  const tree = module.exports.SetupHandoffActions({ handoff, canRecheck, disabled: false, onResolve: async () => {}, onUse: async () => {}, onView: () => {}, onError: () => {} });
  // Expand the KeptSettings function component.
  const expand = node => !node || typeof node !== 'object' ? node : typeof node.type === 'function' ? expand(node.type(node.props)) : { ...node, props: { ...node.props, children: [node.props.children].flat(Infinity).map(expand) } };
  return expand(tree);
}

test('needs-choice names each difference and offers keep / change / detect again', () => {
  const tree = render({ taskId: 't', status: 'needs-choice', profileId: 'p', error: 'raw', differences: [{ field: 'context', current: '160K', prepared: '128K' }, { field: 'images', current: 'false', prepared: 'true' }] });
  const kept = nodes(tree).find(node => node.props['data-testid'] === 'setup-kept-settings');
  assert.ok(kept, 'kept-settings notice');
  assert.match(kept.props.className, /warning/);
  assert.doesNotMatch(kept.props.className, /error/);
  const body = text(kept);
  for (const part of ['TITLE', 'CTX', 'NOW', '160K', 'THIS', '128K', 'IMG', 'OFF', 'ON', 'HINT']) assert.ok(body.includes(part), part);
  assert.ok(!text(tree).includes('raw'), 'the raw backend sentence is not repeated');
  assert.deepEqual(nodes(tree).filter(node => node.type === 'button').map(text), ['KEEP', 'CHANGE', 'AGAIN']);
});

test('needs-choice without differences (older backend) still shows its message, not as an error', () => {
  const tree = render({ taskId: 't', status: 'needs-choice', profileId: 'p', error: 'older message' });
  const notice = nodes(tree).find(node => node.type === 'p' && text(node) === 'older message');
  assert.ok(notice);
  assert.match(notice.props.className, /warning/);
  assert.deepEqual(nodes(tree).filter(node => node.type === 'button').map(text), ['KEEP', 'CHANGE', 'AGAIN']);
  assert.deepEqual(nodes(render({ taskId: 't', status: 'needs-choice', profileId: 'p' }, false)).filter(node => node.type === 'button').map(text), ['KEEP', 'CHANGE']);
});
