import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { releaseNotes, githubReleaseNotes } from './release-notes.mjs';

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

const sourceSha = 'ab12'.repeat(10);
const screenshot = 'docs/screenshots/changelog/0.1.5/benchmark.zh.webp';
const raw = path => `https://raw.githubusercontent.com/hongfaqiu/strata-manager/${sourceSha}/${path}`;

test('GitHub notes pin both the screenshot and its original-image link while updater notes remain relative', () => {
  const markdown = `## [0.1.5]\n### 中文\n[![档位](${screenshot})](${screenshot})\n### English\n- Update.`;
  const notes = releaseNotes(markdown, '0.1.5');
  const github = githubReleaseNotes(notes, sourceSha);
  assert.ok(github.includes(`[![档位](${raw(screenshot)})](${raw(screenshot)})`));
  assert.ok(notes.includes(`[![档位](${screenshot})](${screenshot})`));
  assert.equal(releaseNotes(markdown, '0.1.5'), notes);
  assert.equal(githubReleaseNotes(github, sourceSha), github);
});

test('GitHub screenshot conversion preserves ordinary links, external images, titles and angle brackets', () => {
  const ordinary = '[Guide](docs/USER_GUIDE.md) [Site](https://example.org/path?q=1) ![Remote](https://example.org/image.webp) [Section](#usage)';
  const notes = `${ordinary}\n![图](<${screenshot}> "原图")\n[Original](  ${screenshot} 'Title')`;
  assert.equal(githubReleaseNotes(notes, sourceSha), `${ordinary}\n![图](<${raw(screenshot)}> "原图")\n[Original](  ${raw(screenshot)} 'Title')`);
});

test('GitHub screenshot conversion requires a full immutable source SHA', () => {
  for (const value of [undefined, null, 123, '', 'main', 'v0.1.5', sourceSha.slice(0, 7), sourceSha + '0', 'g'.repeat(40), sourceSha.toUpperCase(), sourceSha + '\n']) {
    assert.throws(() => githubReleaseNotes(`![图](${screenshot})`, value), /full lowercase source SHA/);
  }
  assert.throws(() => githubReleaseNotes(null, sourceSha), /Release notes/);
});

test('GitHub screenshot conversion refuses traversal, encoded, noncanonical and unsafe paths', () => {
  for (const path of [
    'docs/screenshots/../private.webp', 'docs/screenshots/./image.webp', 'docs/screenshots//image.webp',
    'docs/screenshots/%2e%2e/private.webp', 'docs/screenshots/%ZZ.webp', 'docs/screenshots/image.webp?raw=1',
    'docs/screenshots/image.webp#fragment', 'docs/screenshots/image.svg', 'docs/screenshots/bad:image.webp',
    'docs/screenshots/image name.webp', 'docs/screenshots/image(name).webp', 'docs/screenshots/日本語.webp',
    './docs/screenshots/image.webp', '../docs/screenshots/image.webp', '/docs/screenshots/image.webp',
    'docs\\screenshots\\image.webp', 'docs%2fscreenshots%2fimage.webp',
  ]) {
    assert.throws(() => githubReleaseNotes(`![图](${path})`, sourceSha), /safe repository-relative WebP path/, path);
    assert.throws(() => githubReleaseNotes(`[Original](${path})`, sourceSha), /safe repository-relative WebP path/, path);
  }
});

test('all 22 maintained 0.1.5 screenshot pairs exist and receive the exact source prefix', () => {
  const notes = releaseNotes(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), '0.1.5');
  const paths = [...notes.matchAll(/!\[[^\]]*\]\((docs\/screenshots\/changelog\/0\.1\.5\/[^)]+\.webp)\)/g)].map(match => match[1]);
  const github = githubReleaseNotes(notes, sourceSha);
  assert.equal(paths.length, 22);
  assert.equal(new Set(paths).size, 22);
  assert.equal(paths.filter(path => path.endsWith('.zh.webp')).length, 11);
  assert.equal(paths.filter(path => path.endsWith('.en.webp')).length, 11);
  for (const path of paths) {
    assert.ok(readFileSync(new URL('../' + path, import.meta.url)).length > 0, path);
    assert.ok(github.includes(`](${raw(path)})](${raw(path)})`), path);
  }
  assert.equal((github.match(/https:\/\/raw\.githubusercontent\.com\//g) || []).length, 44);
  assert.doesNotMatch(github, /\]\(docs\/screenshots\//);
  assert.equal((notes.match(/\]\(docs\/screenshots\//g) || []).length, 44);
});
