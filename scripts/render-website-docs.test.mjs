import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { headingSlug, renderMarkdownContent, rewriteDocumentUrl, verifyStaticWebsite } from './render-website-docs.mjs';

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
  assert.equal(rewrite('../README.en.md'), '../index.html?lang=en');
  assert.equal(rewrite('../packages/core/src/tuning-types.ts'), 'https://github.com/hongfaqiu/strata-manager/blob/main/packages/core/src/tuning-types.ts');
  assert.equal(rewrite('https://github.com/hongfaqiu/strata-manager/blob/main/docs/VERIFICATION.md'), 'verification.html');
  assert.equal(rewrite('https://example.com/guide'), 'https://example.com/guide');
  assert.equal(rewrite('javascript:alert(1)'), '');
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
