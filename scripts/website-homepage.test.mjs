import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { renderHomepage } from './website-seo.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFile(join(root, path), 'utf8');

test('Homepage keeps the spec-sheet layout: roles table, annotated overview, workflow ledger, downloads and changelog', async () => {
  const html = await read('website/index.html');
  assert.match(html, /class="roles"/);
  assert.equal([...html.matchAll(/class="pin"/g)].length, 6, 'six markers on the overview figure');
  assert.equal([...html.matchAll(/<td class="no">/g)].length, 8, 'eight workflow rows');
  for (const id of ['main', 'workflow', 'get-started', 'changes', 'download-status', 'release-notes-link', 'language-switch', 'language-label']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const key of ['windows', 'appimage', 'deb', 'checksums']) assert.match(html, new RegExp(`data-download="${key}"`));
  assert.match(html, /product-cover\.zh\.webp/);
  assert.match(html, /docs\/changelog\.html/);
  assert.match(html, /github\.com\/hongfaqiu\/strata-manager/);
  assert.doesNotMatch(html, /vendor\/|gsap/i);
  assert.doesNotMatch(html, /发布候选|候选版|稳定版|Release candidate|Current stable/i);
  assert.doesNotMatch(html, /赋能|一站式|轻松|无缝/);
});

test('English homepage translations stay plain text so the static renderer can escape them', async () => {
  const html = await read('website/index.html');
  for (const match of html.matchAll(/data-en="([^"]*)"/g)) {
    assert.doesNotMatch(match[1], /<|&lt;/, `markup inside data-en: ${match[1]}`);
  }
  const english = renderHomepage(html, 'en');
  assert.match(english, /<html lang="en">/);
  assert.match(english, /A desktop manager/);
  assert.match(english, /src="\.\.\/assets\/screenshots\/product-cover\.en\.webp"/);
  const visible = english.replace(/data-zh="[^"]*"/g, "").replace(/<script[\s\S]*?<\/script>/g, "");
  assert.doesNotMatch(visible, /给 Strata 配一个|桌面管理器。/);
});

test('Homepage script keeps release validation and only enables verified asset links', async () => {
  const js = await read('website/app.js');
  assert.match(js, /\/\/ Website interactions\./);
  assert.match(js, /applyDownloads\(elements, urls\)/);
  assert.match(js, /data-download-mirror/);
  assert.match(js, /release-catalog\.json/);
  assert.match(js, /Latest release|最新发布版本/);
  assert.doesNotMatch(js, /gsap|ScrollTrigger/);
});
