import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localizedReleaseNotes, releaseNotes } from './updateReleaseNotes.ts';
import { defaultUrlTransform } from 'react-markdown';
import { createReleaseNotesAssetResolver } from './releaseNotesAssets.ts';

test('retains the complete Release including bilingual sections and nested Markdown', () => {
  const notes = '# 0.2.0\n\n## 中文\n\n### 修复\n- 修复闪烁。\n\n## English\n\n### Fixed\n- Fixed flickering.\n';
  assert.equal(releaseNotes(notes), notes.trim());
});
test('shows upstream English and Chinese notes without requiring translations', () => {
  assert.equal(releaseNotes('## English\n- English update'), '## English\n- English update');
  assert.equal(releaseNotes('## 中文\n- 中文更新'), '## 中文\n- 中文更新');
  assert.equal(releaseNotes('- Fixed button flickering.'), '- Fixed button flickering.');
  assert.equal(releaseNotes('- 修复按钮闪烁。'), '- 修复按钮闪烁。');
});
test('only treats an absent or empty Release body as missing', () => {
  assert.equal(releaseNotes(undefined), null);
  assert.equal(releaseNotes(' \n\t'), null);
  assert.equal(releaseNotes('## 中文\n\n## English\n- Update'), '## 中文\n\n## English\n- Update');
});

test('selects matching language while retaining nested Markdown', () => {
  const body='### 中文\n#### 修复\n- 修复闪烁。\n### English\n#### Fixed\n- Fix flickering.';
  assert.equal(localizedReleaseNotes(body,'zh-CN'),'#### 修复\n- 修复闪烁。');
  assert.equal(localizedReleaseNotes(body,'en'),'#### Fixed\n- Fix flickering.');
  assert.equal(localizedReleaseNotes('### 中文\n- 修复。','en'),null);
  assert.equal(localizedReleaseNotes('### 中文\n### English\n- Fix.','zh-CN'),null);
});

const screenshotAssets = {
  'docs/screenshots/benchmark.zh.webp': '/assets/benchmark.zh-abc.webp',
  'docs/screenshots/changelog/unreleased/scenario-benchmark.en.webp': '/assets/scenario-benchmark.en-def.webp',
};
const resolveAsset = createReleaseNotesAssetResolver(screenshotAssets);
const transformUrl = url => resolveAsset(defaultUrlTransform(url));

test('resolves exact current and candidate release screenshots to offline assets', () => {
  assert.equal(transformUrl('docs/screenshots/benchmark.zh.webp'), screenshotAssets['docs/screenshots/benchmark.zh.webp']);
  assert.equal(transformUrl('./docs/screenshots/benchmark.zh.webp'), screenshotAssets['docs/screenshots/benchmark.zh.webp']);
  assert.equal(transformUrl('/docs/screenshots/benchmark.zh.webp?raw=true#preview'), screenshotAssets['docs/screenshots/benchmark.zh.webp']);
  assert.equal(transformUrl('docs/screenshots/changelog/unreleased/scenario-benchmark.en.webp'), screenshotAssets['docs/screenshots/changelog/unreleased/scenario-benchmark.en.webp']);
  // Markdown image links and image sources use the same closed resource mapping.
  assert.equal(transformUrl('docs/screenshots/benchmark.zh.webp#full-size'), transformUrl('docs/screenshots/benchmark.zh.webp'));
});

test('blocks missing and unsafe local screenshot aliases instead of requesting broken paths', () => {
  for (const url of [
    'docs/screenshots/unknown.zh.webp',
    'docs/screenshots/changelog/unreleased/missing.en.webp',
    '../docs/screenshots/benchmark.zh.webp',
    'docs/screenshots/../benchmark.zh.webp',
    'docs/screenshots/%2e%2e/benchmark.zh.webp',
    'docs/screenshots/%62enchmark.zh.webp',
    '%64ocs/screenshots/benchmark.zh.webp',
    'docs%2fscreenshots/benchmark.zh.webp',
    'docs\\screenshots\\benchmark.zh.webp',
    'docs/screenshots/benchmark.zh.webp\\extra',
    'other/docs/screenshots/benchmark.zh.webp',
  ]) assert.equal(transformUrl(url), '', url);
});

test('keeps default URL filtering and ordinary external images and links', () => {
  for (const url of ['https://example.com/image.webp', 'http://example.com/docs/screenshots/image.webp', '//example.com/image.webp', 'https://github.com/hongfaqiu/strata-manager/releases', 'mailto:maintainer@example.com', 'docs/USER_GUIDE.md', '#details']) {
    assert.equal(transformUrl(url), defaultUrlTransform(url));
  }
  for (const url of ['javascript:alert(1)', 'data:image/webp;base64,abc', 'file:///secret.webp', 'blob:https://example.com/image']) {
    assert.equal(transformUrl(url), '', url);
  }
});

test('only accepts local Vite asset URLs from the explicit screenshot table', () => {
  const resolve = createReleaseNotesAssetResolver({
    'docs/screenshots/remote.zh.webp': 'https://example.com/image.webp',
    'docs/screenshots/protocol-relative.zh.webp': '//example.com/image.webp',
    'docs/screenshots/other.zh.webp': '/other/image.webp',
    'docs/screenshots/unsafe.zh.webp': '/assets/image.webp\n',
    'docs/screenshots/../traversal.zh.webp': '/assets/traversal.webp',
    'docs/screenshots/development.zh.webp': '/@fs/D:/workspace/docs/screenshots/development.zh.webp',
  });
  for (const name of ['remote', 'protocol-relative', 'other', 'unsafe']) assert.equal(resolve(`docs/screenshots/${name}.zh.webp`), '');
  assert.equal(resolve('docs/screenshots/../traversal.zh.webp'), '');
  assert.equal(resolve('docs/screenshots/development.zh.webp'), '/@fs/D:/workspace/docs/screenshots/development.zh.webp');
});
