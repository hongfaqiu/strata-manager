import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { bundledAppRelease } from './bundledAppRelease.ts';

const changelog = '# Changelog\r\n## [Unreleased]\r\n- Pending changes\r\n## [0.2.0] - 2026-10-12\r\n### 中文\r\n- 当前版本\r\n### English\r\n- Current release\r\n## [0.1.0] - 2026-10-10\r\n- Older release';

test('offline changelog matches only the installed version, including CRLF and v prefix', () => {
  assert.deepEqual(bundledAppRelease(changelog, 'v0.2.0'), {
    version: '0.2.0', date: '2026-10-12', notes: '### 中文\r\n- 当前版本\r\n### English\r\n- Current release',
  });
});

test('missing or duplicate versions cannot fall back to an unrelated release', () => {
  assert.equal(bundledAppRelease(changelog, '0.3.0'), null);
  assert.equal(bundledAppRelease(changelog, 'Unreleased'), null);
  assert.equal(bundledAppRelease(changelog + '\n## [0.2.0]\n- Duplicate', '0.2.0'), null);
  assert.equal(bundledAppRelease('## [0.2.0]\n', '0.2.0'), null);
});

test('the package version has its own maintained offline release notes', () => {
  const packageInfo = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const notes = bundledAppRelease(readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8'), packageInfo.version);
  assert.ok(notes);
  assert.match(notes.notes, /### 中文/);
  assert.match(notes.notes, /### English/);
  assert.doesNotMatch(notes.notes, /These changes are in development and validation/);
});
