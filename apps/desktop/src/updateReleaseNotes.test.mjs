import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localizedReleaseNotes, releaseNotes } from './updateReleaseNotes.ts';

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
