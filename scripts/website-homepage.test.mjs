import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('Homepage restores pre-0.1.7 section rhythm with selective gallery expand', async () => {
  const html = await readFile(join(root, 'website/index.html'), 'utf8');
  for (const id of ['about-strata', 'features', 'workspace', 'gallery', 'get-started']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /class="feature-grid"/);
  assert.match(html, /class="workspace-tab-nav"/);
  assert.match(html, /class="reveal-list"/);
  assert.ok([...html.matchAll(/class="reveal-trigger"/g)].length >= 6);
  assert.match(html, /id="screen-benchmark-trigger"/);
  assert.match(html, /id="screen-benchmark-panel"[^>]*\bhidden\b|\bhidden\b[^>]*id="screen-benchmark-panel"/);
  assert.doesNotMatch(html, /发布候选|Current stable|0\.1\.5 界面|稳定版界面/);
});

test('Homepage script keeps workspace tabs and single-open gallery reveals', async () => {
  const js = await readFile(join(root, 'website/app.js'), 'utf8');
  assert.match(js, /wsTabs/);
  assert.match(js, /renderScreen/);
  assert.match(js, /revealTriggers/);
  assert.match(js, /closeOtherReveals/);
  assert.match(js, /Latest release\.|最新发布版本/);
});
