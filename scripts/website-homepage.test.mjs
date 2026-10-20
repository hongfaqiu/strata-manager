import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { renderHomepage } from './website-seo.mjs';
import { demoTileKinds, renderDemoTile } from './website-demo-tiles.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFile(join(root, path), 'utf8');

test('Homepage keeps the v0.1.7 layout, links every current screenshot and rebuilds visuals in HTML', async () => {
  const html = await read('website/index.html');
  assert.match(html, /class="hero-section"/);
  assert.match(html, /id="strata-diagram"/);
  assert.match(html, /class="feature-grid"/);
  assert.match(html, /id="daily-experience"/);
  assert.match(html, /class="workspace-tab-nav"/);
  // Product views are rebuilt in HTML; every stage tab has a matching app view.
  assert.match(html, /id="app-window"/);
  for (const view of ['overview', 'models', 'monitor', 'usage', 'chat', 'runtime']) {
    assert.match(html, new RegExp(`data-screen="${view}"`));
    assert.match(html, new RegExp(`class="app-view[^"]*" data-view="${view}"`));
  }
  assert.match(html, /class="gallery-grid[^"]*"/);
  assert.match(html, /id="get-started"/);
  // The hero plays a scripted session with a visible pause control and a fake pointer.
  assert.match(html, /id="demo-toggle"/);
  assert.match(html, /class="demo-pointer[^"]*" data-pointer/);
  for (const state of ['stopped', 'loading', 'live']) assert.match(html, new RegExp(`data-show="${state}"`));
  // Each feature row carries its own live HTML demo instead of a static image.
  for (const demo of ['fit', 'connect', 'boost', 'monitor', 'bench']) assert.match(html, new RegExp(`data-demo="${demo}"`));
  // No product screenshots on the page: every surface is an HTML recreation; only the OG/meta image remains.
  assert.doesNotMatch(html, /<img[^>]+assets\/screenshots\//);
  assert.doesNotMatch(html, /open-lightbox-btn|lightbox-modal|shot-link/);
  assert.ok((html.match(/class="dd-slot" data-demo-tile="[a-z-]+"/g) || []).length >= 14, 'every workspace row has a live HTML demo');
  assert.ok((html.match(/<div class="tile" role="img"/g) || []).length >= 11, 'every daily-experience card is an HTML recreation');
  assert.doesNotMatch(html, /真实截图|Real screenshot|docs\/screenshots/, 'no links to real screenshots');
  for (const id of ['main', 'get-started', 'download-status', 'release-notes-link', 'language-switch', 'language-label']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const key of ['windows', 'appimage', 'deb', 'dmg', 'server', 'serverDeb']) assert.match(html, new RegExp(`data-download="${key}"`));
  // Release checksum files are not offered on the website.
  assert.doesNotMatch(html, /SHA256SUMS|data-download="checksums"|SHA256 校验文件|SHA256 checksums/);
  // Every current product surface (top-level + daily-experience screenshots) has an HTML recreation.
  for (const shot of [
    'product-cover', 'models', 'monitor', 'usage', 'chat', 'tuning', 'config', 'settings',
    'benchmark', 'scenario-benchmark', 'benchmark-report', 'runtime-download-settings',
    'connections', 'common-chat-settings', 'app-updates', 'service-status', 'running-services',
    'floating-monitor', 'floating-monitor-settings', 'language-settings',
    'daily-experience/model-download-list', 'daily-experience/model-download-detail',
    'daily-experience/startup-diagnostic', 'daily-experience/api-verification',
    'daily-experience/history-comparison', 'daily-experience/service-capabilities',
    'daily-experience/chat-execution', 'daily-experience/api-usage',
  ]) {
    const name = shot.split('/').at(-1);
    const onPage = [`id="screen-${name}"`, `data-demo-tile="${name}"`, `data-view="${name}"`].some((marker) => html.includes(marker));
    assert.ok(onPage || demoTileKinds.includes(name), `HTML recreation for ${shot}`);
  }
  assert.match(html, /Cursor|Codex/);
  assert.doesNotMatch(html, /官方脚本更新 Strata|Update Strata with the official script|官方更新脚本|official update script/);
  assert.match(html, /product-cover\.zh\.webp/);
  assert.match(html, /github\.com\/hongfaqiu\/strata-manager/);
  // No animation library: motion is CSS + IntersectionObserver, keeping the first load small.
  assert.doesNotMatch(html, /gsap|ScrollTrigger/);
  assert.match(html, /<link rel="preload" href="vendor\/fonts\/Geist\.woff2" as="font" type="font\/woff2" crossorigin>/);
  assert.doesNotMatch(html, /loading="lazy"/);
  // The intro video is a deliberate addition: nothing downloads until play, no autoplay, per-language files.
  assert.match(html, /<video class="intro-video" controls playsinline preload="none"[^>]* src="assets\/video\/intro\.zh\.mp4" data-src-en="assets\/video\/intro\.en\.mp4"/);
  assert.doesNotMatch(html, /<video[^>]*\s(?:autoplay|poster=)/);
  assert.doesNotMatch(html, /发布候选|候选版|稳定版|未发行|Unreleased|Release candidate|Current stable/i);
  assert.doesNotMatch(html, /赋能|一站式|轻松|无缝/);
});

test('English homepage translations stay plain text so the static renderer can escape them', async () => {
  const html = await read('website/index.html');
  for (const match of html.matchAll(/data-en="([^"]*)"/g)) {
    assert.doesNotMatch(match[1], /<|&lt;/, `markup inside data-en: ${match[1]}`);
  }
  const english = renderHomepage(html, 'en');
  assert.match(english, /<html lang="en">/);
  assert.match(english, /Open-source desktop management/);
  assert.match(english, /content="https:\/\/strata-manager\.cosfoc\.com\/assets\/screenshots\/product-cover\.en\.webp"/);
  const visible = english.replace(/data-zh="[^"]*"/g, "").replace(/<script[\s\S]*?<\/script>/g, "");
  assert.doesNotMatch(visible, /开源桌面管理工具|下载 Strata Manager/);
});

test('Homepage script keeps release validation, lightbox catalog and optional motion', async () => {
  const js = await read('website/app.js');
  assert.match(js, /applyDownloads\(elements, urls\)/);
  assert.match(js, /release-catalog\.json/);
  assert.match(js, /Latest published release|最新已发布版本/);
  assert.doesNotMatch(js, /gsap|ScrollTrigger/);
  assert.match(js, /classList\.add\('reveal', 'is-soft'\)/);
  assert.match(js, /prefers-reduced-motion: reduce/);
  // Autoplay demos only advance while visible and fall back to their final state.
  assert.match(js, /IntersectionObserver/);
  assert.match(js, /if \(!motionAllowed\(\)\) final\?\.\(\)/);
  assert.match(js, /document\.hidden/);
  assert.doesNotMatch(js, /未发行|Unreleased|稳定版|UNRELEASED/);
});

test('Demo window version comes from package.json at build time and from the live release at runtime', async () => {
  const html = await read('website/index.html');
  const { version } = JSON.parse(await read('package.json'));
  assert.match(html, /<small data-app-version>v\d+\.\d+\.\d+<\/small>/);
  assert.doesNotMatch(html.replace(/<small data-app-version>[^<]*<\/small>/g, ''), /<small>v\d+\.\d+\.\d+<\/small>/, 'version labels must use data-app-version');
  for (const language of ['zh', 'en']) {
    const rendered = renderHomepage(html, language, undefined, version);
    assert.ok(rendered.includes(`<small data-app-version>v${version}</small>`), `${language} demo window shows v${version}`);
    assert.ok(renderHomepage(html, language, undefined, '9.8.7').includes('<small data-app-version>v9.8.7</small>'), 'build version replaces the source fallback');
  }
  assert.throws(() => renderHomepage(html, 'zh', undefined, 'latest'), /Invalid app version/);
  const build = await read('scripts/build-website.mjs');
  assert.match(build, /renderWebsiteSeo\(output, documents, \{ appVersion \}\)/);
  const js = await read('website/app.js');
  assert.match(js, /\[data-app-version\]'\)\.forEach\(el => \{ el\.textContent = release\.tag_name; \}\)/);
});

test('Demo speeds match real measurements (4080 SUPER ~100+/3200, 5090 200+/~5000)', async () => {
  const html = await read('website/index.html');
  const row = (name) => {
    const match = new RegExp(`data-decode="([\\d.]+)" data-prefill="(\\d+)"[^>]*><span class="mono">\\d</span><span>${name}`).exec(html);
    assert.ok(match, `leaderboard row ${name}`);
    return { decode: Number(match[1]), prefill: Number(match[2]) };
  };
  const rtx5090 = row('RTX 5090'), rtx4080s = row('RTX 4080 SUPER');
  assert.ok(rtx5090.decode >= 200 && rtx5090.prefill >= 4500 && rtx5090.prefill <= 5500);
  assert.ok(rtx4080s.decode >= 100 && rtx4080s.decode <= 115 && rtx4080s.prefill >= 2900 && rtx4080s.prefill <= 3500);
  assert.doesNotMatch(html, /快了 17%|17% faster/);
  assert.match(html, /示例数据/);
  const js = await read('website/app.js');
  const target = /generating \? (\d+) \+ Math\.random\(\) \* (\d+) : 0/.exec(js);
  assert.ok(target && Number(target[1]) >= 100 && Number(target[1]) + Number(target[2]) <= 112, 'hero decode settles around 100–110 tok/s');
});

test('English download cards translate the macOS experimental label', async () => {
  const english = renderHomepage(await read('website/index.html'), 'en');
  assert.match(english, /Apple Silicon · Experimental/);
  const visible = english.replace(/data-[a-z-]*zh="[^"]*"/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
  assert.doesNotMatch(visible, /实验/);
});

test('Rendered homepages carry live HTML demos and no product screenshot images', async () => {
  const html = await read('website/index.html');
  for (const language of ['zh', 'en']) {
    const rendered = renderHomepage(html, language);
    const images = [...rendered.matchAll(/<img[^>]*src="([^"]*)"/g)].map((match) => match[1]);
    assert.ok(images.every((src) => /assets\/icon\.svg$/.test(src)), `only logo images remain: ${images.join(', ')}`);
    assert.doesNotMatch(rendered, /<div class="dd-slot" data-demo-tile=/, 'every placeholder was replaced');
    // Below-the-fold demos ship as inert <template> markup and are built only when needed.
    assert.ok((rendered.match(/<div class="dd-slot" data-slot="[a-z-]+"><template><div class="dd(?: is-strip)?" data-demo-tile=/g) || []).length >= 14);
    // Only meta tags may point at screenshots (social previews).
    const visible = rendered.replace(/<meta[^>]*>/g, '').replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '');
    assert.doesNotMatch(visible, /assets\/screenshots\//);
  }
  // Nothing render-blocking for below-the-fold demos: their CSS and JS are injected lazily.
  assert.doesNotMatch(html, /href="demo-tiles\.css"/);
  assert.match(await read('website/app.js'), /demo-tiles\.css/);
  // The tile player loads lazily from app.js when the workspace list approaches the viewport.
  assert.doesNotMatch(html, /<script src="demo-tiles\.js"/);
  const app = await read('website/app.js');
  assert.match(app, /function lazyDemoTiles\(\)/);
  assert.match(app, /rootMargin: '600px 0px'/);
  const tiles = await read('website/demo-tiles.js');
  assert.match(tiles, /\.dd-slot > template/);
});

test('Demo tiles animate only while visible and show their final state without motion', async () => {
  const js = await read('website/demo-tiles.js');
  assert.match(js, /IntersectionObserver/);
  assert.match(js, /prefers-reduced-motion: reduce/);
  assert.match(js, /document\.hidden/);
  const css = await read('website/demo-tiles.css');
  // Hidden "before" states only apply once the script arms a tile, so no-JS visitors see the final state.
  assert.match(css, /\.dd\.is-anim \.dd-meter b:not\(\.is-on\)\{width:0\}/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  for (const kind of demoTileKinds) {
    const zh = renderDemoTile(kind, { lang: 'zh' });
    const en = renderDemoTile(kind, { lang: 'en' });
    assert.match(zh, new RegExp(`data-demo-tile="${kind}"[^>]*role="img"`));
    // Language names in the language picker are shown in their own scripts on purpose.
    assert.doesNotMatch(en.replace(/<ul class="dd-langs"[\s\S]*?<\/ul>/, ''), /[\u3400-\u9fff]/, `${kind} English tile has no Chinese UI text`);
  }
});
