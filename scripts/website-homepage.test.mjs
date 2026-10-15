import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('Homepage uses restrained hero, quiet features, and a visible multi-shot gallery', async () => {
  const html = await readFile(join(root, 'website/index.html'), 'utf8');
  assert.match(html, /class="hero-section"/);
  assert.match(html, /id="features"/);
  assert.match(html, /id="gallery"/);
  assert.match(html, /id="get-started"/);
  assert.match(html, /feature-grid-quiet/);
  assert.match(html, /gallery-grid-dense/);
  assert.doesNotMatch(html, /reveal-trigger|reveal-panel|id="about-strata"|id="workspace"/);
  assert.ok([...html.matchAll(/class="gallery-item"/g)].length >= 12, 'expected many visible gallery shots');
  assert.match(html, /daily-experience\/model-download-detail/);
  assert.match(html, /daily-experience\/api-verification/);
  assert.doesNotMatch(html, /发布候选|Current stable|稳定版界面|0\.1\.5 界面/);
});

test('Homepage script keeps lightbox screens for gallery targets without accordion wiring', async () => {
  const js = await readFile(join(root, 'website/app.js'), 'utf8');
  assert.doesNotMatch(js, /revealTriggers|closeOtherReveals/);
  assert.match(js, /model-download-detail/);
  assert.match(js, /openLightbox|lightbox-modal/);
  assert.match(js, /Latest release\.|最新发布版本/);
});
