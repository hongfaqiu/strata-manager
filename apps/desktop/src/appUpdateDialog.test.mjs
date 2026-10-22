import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as lifecycle from './LifecycleStrings.ts';
import * as controller from './appUpdateController.ts';
import * as notes from './updateReleaseNotes.ts';

const jsx = (type, props) => ({ type, props: props ?? {} });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree) : !tree || typeof tree !== 'object' ? '' : [tree.props?.children].flat(Infinity).map(text).join('');
const source = ts.transpileModule(readFileSync(new URL('./AppUpdateDialog.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const modules = {
  'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
  'lucide-react': { Download: 'download-icon', LoaderCircle: 'loader-icon' },
  './ReleaseNotesMarkdown': { ReleaseNotesMarkdown: 'markdown' },
  './components': { Dialog: 'dialog' },
  './LifecycleStrings': lifecycle,
  './appUpdateController': controller,
  './updateReleaseNotes': notes,
};
const loaded = { exports: {} };
vm.runInNewContext(source, { module: loaded, exports: loaded.exports, require: name => name.endsWith('.css') ? {} : modules[name] });
const { AppUpdateDialog } = loaded.exports;

const state = (phase, extra = {}) => ({ phase, version: '0.2.16', notes: '- Fix', received: 0, downloaded: false, fallbackChain: [], attempts: [], ...extra });
function render(phase, extra, language = 'zh-CN') {
  const calls = { closed: 0 };
  const tree = AppUpdateDialog({ language, state: state(phase, extra), idle: true, onConfirm: () => {}, onClose: () => { calls.closed += 1; } });
  return { tree, calls };
}

test('a download in progress can be closed and keeps running in the background', () => {
  for (const phase of ['downloading', 'installing']) {
    const { tree, calls } = render(phase, { received: 4 * 1024 ** 2, total: 8 * 1024 ** 2 });
    tree.props.onClose();
    assert.equal(calls.closed, 1, `${phase}: the dialog close button hides the dialog`);
    const later = nodes(tree).find(node => node.type === 'button' && !String(node.props.className ?? '').includes('primary'));
    assert.equal(later.props.disabled, undefined);
    assert.equal(text(later), lifecycle.lifecycleZh.updateContinueInBackground);
    later.props.onClick();
    assert.equal(calls.closed, 2);
    assert.ok(text(tree).includes(lifecycle.lifecycleZh.updateBackgroundHint));
  }
});

test('an idle candidate still offers Later and explains that services keep running', () => {
  const { tree } = render('available', {}, 'en-US');
  const later = nodes(tree).find(node => node.type === 'button' && !String(node.props.className ?? '').includes('primary'));
  assert.equal(text(later), lifecycle.lifecycleEn.updateLater);
  assert.ok(!text(tree).includes(lifecycle.lifecycleEn.updateBackgroundHint));
  assert.match(lifecycle.lifecycleEn.updateConfirmationHint, /keep running/);
  assert.match(lifecycle.lifecycleZh.updateConfirmationHint, /不会停止/);
});

test('the title-bar badge shows background progress so the dialog can be reopened', () => {
  const { appUpdateBadge } = controller;
  assert.equal(appUpdateBadge(state('current'), true), null);
  assert.equal(appUpdateBadge(state('installed'), true), null);
  assert.equal(appUpdateBadge({ phase: 'idle', received: 0, downloaded: false }, true), null);
  assert.deepEqual(appUpdateBadge(state('available'), true), { active: false, badge: '有更新', label: '有新版本 v0.2.16，查看更新' });
  assert.equal(appUpdateBadge(state('downloading', { received: 5, total: 20 }), true).badge, '下载中 25%');
  assert.equal(appUpdateBadge(state('downloading', { received: 5 }), false).badge, 'Downloading');
  assert.equal(appUpdateBadge(state('downloading', { received: 5, total: 20 }), true).active, true);
  assert.equal(appUpdateBadge(state('installing'), false).badge, 'Installing');
  assert.equal(appUpdateBadge(state('downloaded', { downloaded: true }), true).badge, '待安装');
});
