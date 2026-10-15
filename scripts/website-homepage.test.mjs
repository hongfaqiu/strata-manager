import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { renderHomepage } from './website-seo.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFile(join(root, path), 'utf8');

test('Homepage keeps the v0.1.7 layout: hero, architecture, features, daily gallery, workspace tabs, downloads', async () => {
  const html = await read('website/index.html');
  assert.match(html, /class="hero-section"/);
  assert.match(html, /id="strata-diagram"/);
  assert.match(html, /class="feature-grid"/);
  assert.match(html, /id="daily-experience"/);
  assert.match(html, /class="workspace-tab-nav"/);
  assert.match(html, /class="gallery-grid"/);
  assert.match(html, /id="get-started"/);
  for (const id of ['main', 'get-started', 'download-status', 'release-notes-link', 'language-switch', 'language-label']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const key of ['windows', 'appimage', 'deb', 'checksums']) assert.match(html, new RegExp(`data-download="${key}"`));
  assert.match(html, /product-cover\.zh\.webp/);
  assert.match(html, /github\.com\/hongfaqiu\/strata-manager/);
  assert.match(html, /vendor\/gsap\.min\.js/);
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
  assert.match(english, /src="\.\.\/assets\/screenshots\/product-cover\.en\.webp"/);
  const visible = english.replace(/data-zh="[^"]*"/g, "").replace(/<script[\s\S]*?<\/script>/g, "");
  assert.doesNotMatch(visible, /开源桌面管理工具|下载 Strata Manager/);
});

test('Homepage script keeps release validation, lightbox catalog and optional motion', async () => {
  const js = await read('website/app.js');
  assert.match(js, /applyDownloads\(elements, urls\)/);
  assert.match(js, /release-catalog\.json/);
  assert.match(js, /Latest published release|最新已发布版本/);
  assert.match(js, /gsap|ScrollTrigger/);
  assert.doesNotMatch(js, /未发行|Unreleased|稳定版|UNRELEASED/);
});
