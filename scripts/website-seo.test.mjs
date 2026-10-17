import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { documents, renderWebsiteDocs, verifyStaticWebsite } from './render-website-docs.mjs';
import { documentSeo, pageUrl, parseWebsiteHtml, publicPath, renderHomepage, renderSitemap, renderWebsiteSeo, site, standalonePages } from './website-seo.mjs';

const source = `<!doctype html><html lang="zh-CN"><head>
<meta name="description" content="安装与管理 Strata。" data-content-en="Set up &amp; manage Strata.">
<meta property="og:title" content="Strata Manager · 中文" data-content-en="Strata Manager · English">
<meta property="og:url" content="${site}"><meta property="og:locale" content="zh_CN"><meta property="og:locale:alternate" content="en_US">
<link rel="canonical" href="${site}"><link rel="alternate" hreflang="en" href="${site}?lang=en">
<link rel="stylesheet" href="style.css"><script src="app.js" defer></script>
<title data-en="Strata Manager · English">Strata Manager · 中文</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","url":"${site}","description":"旧介绍","screenshot":"${site}assets/runtime.zh.webp"}</script>
<script>if (1 < 2) { window.example = "<a href='ignored'>"; }</script>
</head><body><!-- translator comment with <p> -->
<a id="language-switch" href="en/" data-label-en="Switch language"><span id="language-label">EN</span></a>
<h1 id="intro" data-en="Set up &amp; manage Strata.">安装与管理 Strata。</h1>
<p data-en="A desktop workspace.">桌面工作台。</p>
<a href="#intro" data-en="Overview">总览</a>
<a href="docs/guide.html#开始" data-href-en="docs/guide.en.html#start" data-en="User guide">使用指南</a>
<a href="https://github.com/hongfaqiu/strata-manager">GitHub</a>
<img src="assets/runtime.zh.webp" data-src-en="assets/runtime.en.webp" alt="中文截图" data-alt-en="English screenshot">
<svg><symbol id="icon"/><use href="#icon"/></svg>
</body></html>`;

function allNodes(root) {
  return [root, ...(root.children || []).flatMap(allNodes)];
}

test('English content, image and document destinations exist in initial HTML without running JavaScript', () => {
  const rendered = renderHomepage(source, 'en');
  const nodes = allNodes(parseWebsiteHtml(rendered));
  assert.match(rendered, /<html lang="en">/);
  assert.match(rendered, /<title[^>]*>Strata Manager · English<\/title>/);
  assert.match(rendered, /<h1[^>]*>Set up &amp; manage Strata\.<\/h1>/);
  assert.match(rendered, /<p[^>]*>A desktop workspace\.<\/p>/);
  assert.match(rendered, /src="\.\.\/assets\/runtime\.en\.webp"/);
  assert.match(rendered, /href="\.\.\/docs\/guide\.en\.html#start"/);
  assert.match(rendered, /href="#intro"/);
  assert.match(rendered, /<use href="#icon"\/>/);
  assert.match(rendered, /data-zh="安装与管理 Strata。"/);
  assert.match(rendered, /data-content-zh="安装与管理 Strata。"/);
  assert.match(rendered, /data-href-zh="\.\.\/docs\/guide\.html#开始"/);
  const switchLink = nodes.find((node) => node.attributes?.get('id') === 'language-switch');
  assert.equal(switchLink.attributes.get('href'), '../');
  assert.equal(switchLink.attributes.get('hreflang'), 'zh-CN');
  assert.equal(switchLink.attributes.get('aria-label'), 'Switch to 简体中文');
  assert.equal(switchLink.attributes.get('title'), 'Switch to 简体中文');
  assert.match(rendered, /id="language-label">中文<\/span>/);
  assert.ok(rendered.includes('if (1 < 2) { window.example = "<a href=\'ignored\'>"; }'));
  assert.throws(() => renderHomepage(source.replace('</h1>', '</h2>'), 'en'), /Mismatched website closing tag/);
});

test('Homepage canonical, language alternates, Open Graph and structured data describe the same language URL', () => {
  for (const language of ['zh', 'en']) {
    const rendered = renderHomepage(source, language);
    const nodes = allNodes(parseWebsiteHtml(rendered));
    const url = language === 'en' ? `${site}en/` : site;
    const canonical = nodes.filter((node) => node.attributes?.get('rel') === 'canonical');
    assert.equal(canonical.length, 1);
    assert.equal(canonical[0].attributes.get('href'), url);
    const alternatives = nodes.filter((node) => node.attributes?.get('rel') === 'alternate');
    assert.deepEqual(alternatives.map((node) => [node.attributes.get('hreflang'), node.attributes.get('href')]), [['zh-CN', site], ['en', `${site}en/`], ['x-default', site]]);
    const og = nodes.find((node) => node.attributes?.get('property') === 'og:url');
    assert.equal(og.attributes.get('content'), url);
    const script = nodes.find((node) => node.attributes?.get('type') === 'application/ld+json');
    const structured = JSON.parse(script.children.map((child) => child.raw).join(''));
    assert.equal(structured.url, url);
    assert.equal(structured.inLanguage, language === 'en' ? 'en' : 'zh-CN');
    assert.equal(structured.description, language === 'en' ? 'Set up & manage Strata.' : '安装与管理 Strata。');
    assert.equal(structured.screenshot, `${site}assets/runtime.${language}.webp`);
  }
});

test('Sitemap lists both complete homepage URLs and reciprocal document language alternates', () => {
  const sitemap = renderSitemap(documents);
  assert.doesNotMatch(sitemap, /\?lang=/);
  const entries = [...sitemap.matchAll(/<url>(.*?)<\/url>/gs)].map((match) => match[1]);
  assert.equal(entries.length, documents.length + 2 + standalonePages.length);
  for (const url of [site, `${site}en/`]) {
    const entry = entries.find((value) => value.includes(`<loc>${url}</loc>`));
    assert.ok(entry.includes(`hreflang="zh-CN" href="${site}"`));
    assert.ok(entry.includes(`hreflang="en" href="${site}en/"`));
    assert.ok(entry.includes(`hreflang="x-default" href="${site}"`));
  }
  for (const document of documents) {
    const pair = documents.filter((entry) => entry.key === document.key);
    const entry = entries.find((value) => value.includes(`<loc>${pageUrl(document.page)}</loc>`));
    assert.ok(entry);
    if (pair.length > 1) for (const counterpart of pair) {
      assert.ok(entry.includes(`hreflang="${counterpart.lang === 'en' ? 'en' : 'zh-CN'}" href="${pageUrl(counterpart.page)}"`));
    }
  }
});

test('Public page URLs are the clean paths served by Workers static assets', () => {
  assert.equal(site, 'https://strata-manager.cosfoc.com/');
  assert.equal(publicPath('docs/index.html'), 'docs/');
  assert.equal(publicPath('docs/index.en.html'), 'docs/index.en');
  assert.equal(publicPath('docs/changelog.html'), 'docs/changelog');
  assert.equal(publicPath('leaderboard.html'), 'leaderboard');
  assert.equal(publicPath('en/'), 'en/');
  assert.equal(pageUrl('leaderboard.en.html'), 'https://strata-manager.cosfoc.com/leaderboard.en');
  assert.equal(pageUrl(''), site);
});

test('Rendered documentation uses language-specific home links and aligned metadata', async () => {
  const output = await mkdtemp(join(tmpdir(), 'strata-doc-seo-'));
  try {
    await renderWebsiteDocs(output);
    for (const entry of documents) {
      const html = await readFile(join(output, entry.page), 'utf8');
      assert.ok(html.includes(`<a class="doc-brand" href="${entry.lang === 'en' ? '../en/' : '../'}">`));
      assert.ok(html.includes(`<link rel="canonical" href="${pageUrl(entry.page)}">`));
      assert.ok(html.includes(`<meta property="og:url" content="${pageUrl(entry.page)}">`));
      assert.ok(html.includes(`"url":"${pageUrl(entry.page)}"`));
      assert.ok(html.includes(`"inLanguage":"${entry.lang === 'en' ? 'en' : 'zh-CN'}"`));
    }
    const unsafe = documentSeo({ title: '<Title>', description: '</script>', page: 'docs/example.html', lang: 'en', alternates: [] });
    assert.ok(unsafe.includes('content="&lt;Title&gt;"'));
    assert.ok(unsafe.includes('"description":"\\u003c/script>"'));
  } finally {
    assert.ok(resolve(output).startsWith(resolve(tmpdir()) + sep));
    await rm(output, { recursive: true, force: true });
  }
});

test('Build writes both language pages and verification catches broken English assets and canonical links', async () => {
  const output = await mkdtemp(join(tmpdir(), 'strata-home-seo-'));
  try {
    await mkdir(join(output, 'assets'));
    await mkdir(join(output, 'docs'));
    await writeFile(join(output, 'index.html'), source.replace('<script>if (1 < 2) { window.example = "<a href=\'ignored\'>"; }</script>', ''));
    for (const file of ['style.css', 'app.js', 'assets/runtime.zh.webp', 'assets/runtime.en.webp']) await writeFile(join(output, file), 'fixture');
    await writeFile(join(output, 'docs', 'guide.html'), '<h1 id="开始">开始</h1>');
    await writeFile(join(output, 'docs', 'guide.en.html'), '<h1 id="start">Start</h1>');
    await renderWebsiteSeo(output, []);
    await access(join(output, 'en', 'index.html'));
    const checked = await verifyStaticWebsite(output);
    assert.equal(checked.pages, 4);
    assert.ok(checked.localTargets > 10);
    await rm(join(output, 'assets', 'runtime.en.webp'));
    await assert.rejects(verifyStaticWebsite(output), /Missing website target: ..\/assets\/runtime.en.webp/);
    await writeFile(join(output, 'assets', 'runtime.en.webp'), 'fixture');
    await writeFile(join(output, 'en', 'index.html'), `<link rel="canonical" href="${site}en/missing/">`);
    await assert.rejects(verifyStaticWebsite(output), /Missing website target/);
  } finally {
    assert.ok(resolve(output).startsWith(resolve(tmpdir()) + sep));
    await rm(output, { recursive: true, force: true });
  }
});
