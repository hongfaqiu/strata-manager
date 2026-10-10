import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { releaseNotes } from './release-notes.mjs';

const changelog = '# Changelog\n## [Unreleased]\n### 中文\n- 未发布\n### English\n- Unreleased\n## [0.2.0]\n### 中文\n- 修复刷新。\n### English\n- Fix refresh.\n## [0.1.0]\n### 中文\n- 旧版\n### English\n- Old version';
test('extracts only the exact release with both languages', () => {
  const notes = releaseNotes(changelog, '0.2.0');
  assert.match(notes, /修复刷新/);
  assert.match(notes, /Fix refresh/);
  assert.doesNotMatch(notes, /未发布|Unreleased|旧版|Old version/);
});
test('refuses missing, duplicate, unreleased or untranslated versions', () => {
  assert.throws(() => releaseNotes(changelog, '0.3.0'), /exactly one/);
  assert.throws(() => releaseNotes(changelog + '\n## [0.2.0]\nDuplicate', '0.2.0'), /exactly one/);
  assert.throws(() => releaseNotes(changelog, 'Unreleased'), /SemVer/);
  assert.throws(() => releaseNotes('## [0.2.0]\n### 中文\n- 修复。', '0.2.0'), /Chinese and English/);
});
test('the maintained preview notes contain both matching languages', () => {
  assert.ok(releaseNotes(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), '0.1.0-beta.1'));
});
