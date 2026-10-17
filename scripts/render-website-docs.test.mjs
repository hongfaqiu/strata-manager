import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { documents, headingSlug, renderChangelog, renderMarkdownContent, rewriteDocumentUrl, verifyStaticWebsite } from './render-website-docs.mjs';

test('Screenshot evidence documents stay on GitHub while published images use website assets', () => {
  const rewrite = url => rewriteDocumentUrl(url, 'CHANGELOG.md', 'docs/changelog.en.html');
  assert.equal(rewrite('docs/screenshots/ui-refinements/README.md'), 'https://github.com/hongfaqiu/strata-manager/blob/main/docs/screenshots/ui-refinements/README.md');
  assert.equal(rewrite('docs/screenshots/ui-refinements/manifest.json'), 'https://github.com/hongfaqiu/strata-manager/blob/main/docs/screenshots/ui-refinements/manifest.json');
  assert.equal(rewrite('docs/screenshots/ui-refinements/model-download.en.webp'), '../assets/screenshots/ui-refinements/model-download.en.webp');
});

test('Markdown publishes GFM tables, task lists and fenced code as complete HTML', () => {
  const { html } = renderMarkdownContent('# Guide\n\n| Model | State |\n| --- | --- |\n| Local | Ready |\n\n- [x] Import\n\n```sh\npnpm desktop\n```', 'docs/USER_GUIDE.md', 'docs/user-guide.html');
  assert.match(html, /class="table-scroll"[^>]*><table>/);
  assert.match(html, /<td>Local<\/td>/);
  assert.match(html, /type="checkbox"[^>]*checked/);
  assert.match(html, /<pre><code class="language-sh">pnpm desktop/);
});

test('Heading anchors are stable for Chinese, formatting and repeated headings', () => {
  const { html, headings } = renderMarkdownContent('# Guide\n\n## 接入本机 API\n\n## **Local** API!\n\n## Local API!\n\n## Local API-1', 'docs/USER_GUIDE.md', 'docs/user-guide.html');
  assert.equal(headingSlug('接入本机 API'), '接入本机-api');
  assert.deepEqual(headings.map(({ id }) => id), ['guide', '接入本机-api', 'local-api', 'local-api-1', 'local-api-1-1']);
  assert.match(html, /<h2 id="接入本机-api">/);
});

test('Only explicit named anchors are retained from raw HTML', () => {
  const { html } = renderMarkdownContent('<a id="first-use"></a>\n\n## First use\n\n<script>alert(1)</script>\n\n[Unsafe](javascript:alert%281%29)', 'docs/USER_GUIDE.md', 'docs/user-guide.html');
  assert.match(html, /<a href="#first-use" id="first-use"><\/a>/);
  assert.doesNotMatch(html, /<script>|href="javascript:/);
  assert.match(html, /<h2 id="first-use-1">/);
});

test('Document, license, screenshot and source links use their published destinations', () => {
  const rewrite = (url) => rewriteDocumentUrl(url, 'docs/USER_GUIDE.en.md', 'docs/user-guide.en.html');
  assert.equal(rewrite('TROUBLESHOOTING.en.md#api-requests'), 'troubleshooting.en.html#api-requests');
  assert.equal(rewrite('USER_GUIDE.md'), 'user-guide.html');
  assert.equal(rewrite('../LICENSE'), 'license.html');
  assert.equal(rewrite('../apps/desktop/public/licenses/outfit-OFL.txt'), 'outfit-license.html');
  assert.equal(rewrite('screenshots/chat.zh.webp'), '../assets/screenshots/chat.zh.webp');
  assert.equal(rewrite('../README.en.md'), '../en/');
  assert.equal(rewrite('../README.md'), '../en/');
  assert.equal(rewrite('../README.zh-CN.md'), '../');
  assert.equal(rewrite('../README.zh-CN.md#什么是-strata'), 'https://github.com/hongfaqiu/strata-manager/blob/main/README.zh-CN.md#什么是-strata');
  assert.equal(rewrite('../packages/core/src/tuning-types.ts'), 'https://github.com/hongfaqiu/strata-manager/blob/main/packages/core/src/tuning-types.ts');
  assert.equal(rewrite('https://github.com/hongfaqiu/strata-manager/blob/main/docs/VERIFICATION.md'), 'https://github.com/hongfaqiu/strata-manager/blob/main/docs/VERIFICATION.md');
  assert.equal(rewrite('https://example.com/guide'), 'https://example.com/guide');
  assert.equal(rewrite('javascript:alert(1)'), '');
});

test('Maintainer records stay at their source instead of becoming user documentation pages', () => {
  const rewrite = (url) => rewriteDocumentUrl(url, 'docs/USER_GUIDE.en.md', 'docs/user-guide.en.html');
  for (const source of ['DEVELOPMENT.md', 'VERIFICATION.md', 'RELEASING.md']) {
    assert.ok(!documents.some((document) => document.source === `docs/${source}`));
    assert.equal(rewrite(`${source}#current-scope`), `https://github.com/hongfaqiu/strata-manager/blob/main/docs/${source}#current-scope`);
  }
  assert.equal(documents.length, 17);
});

test('Changelog pages keep version status and only the requested language from the shared source', () => {
  const markdown = '# Changelog\r\n\r\n## [Unreleased]\r\n### 中文\r\n- 开发中的功能\r\n### English\r\n- Feature in development\r\n## [1.0.0] - Unpublished\r\n### 中文\r\n- 中文修复\r\n### English\r\n- English fix\r\n';
  const chinese = renderChangelog(markdown, 'zh');
  const english = renderChangelog(markdown, 'en');
  assert.match(chinese, /## 未发布/);
  assert.match(chinese, /## 1\.0\.0 - 未公开发布/);
  assert.match(chinese, /中文修复/);
  assert.doesNotMatch(chinese, /Feature in development|English fix|### English/);
  assert.match(english, /## Unreleased/);
  assert.match(english, /## 1\.0\.0 - Unpublished/);
  assert.doesNotMatch(english, /开发中的功能|中文修复|### 中文/);
  assert.throws(() => renderChangelog(markdown.replace('- English fix', ''), 'en'), /requires nonempty en/);
  assert.equal(rewriteDocumentUrl('../CHANGELOG.md', 'docs/USER_GUIDE.md', 'docs/user-guide.html'), 'changelog.html');
  assert.equal(rewriteDocumentUrl('../CHANGELOG.md', 'docs/USER_GUIDE.en.md', 'docs/user-guide.en.html'), 'changelog.en.html');
});

test('An empty unreleased placeholder does not block publishing a versioned changelog', () => {
  const released = '## [1.0.0]\n### 中文\n- 修复\n### English\n- Fix';
  for (const placeholder of ['## [Unreleased]\n\n', '## [Unreleased]\n### 中文\n\n### English\n\n']) {
    assert.match(renderChangelog(placeholder + released, 'zh'), /## 1\.0\.0/);
    assert.match(renderChangelog(placeholder + released, 'en'), /## 1\.0\.0/);
  }
});

test('Publication checks catch missing files and stale document anchors', async () => {
  const output = await mkdtemp(join(tmpdir(), 'strata-doc-links-'));
  try {
    await writeFile(join(output, 'index.html'), '<a href="guide.html#first-use">Guide</a>');
    await writeFile(join(output, 'guide.html'), '<h1 id="first-use">First use</h1>');
    assert.deepEqual(await verifyStaticWebsite(output), { pages: 2, localTargets: 1 });
    await writeFile(join(output, 'guide.html'), '<h1 id="renamed">First use</h1>');
    await assert.rejects(verifyStaticWebsite(output), /Missing website anchor/);
    await writeFile(join(output, 'index.html'), '<a href="missing.html">Missing</a>');
    await assert.rejects(verifyStaticWebsite(output), /Missing website target/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
