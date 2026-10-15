import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('Homepage keeps a lean collapsed shell with expandable feature and workflow panels', async () => {
  const html = await readFile(join(root, 'website/index.html'), 'utf8');
  assert.match(html, /id="capabilities"/);
  assert.match(html, /id="workflow"/);
  assert.match(html, /id="get-started"/);
  assert.doesNotMatch(html, /id="about-strata"|id="daily-experience"|id="more-features"|id="gallery"|id="workspace"/);

  const triggers = [...html.matchAll(/class="reveal-trigger"/g)];
  assert.ok(triggers.length >= 9, `expected many reveal triggers, got ${triggers.length}`);

  const required = [
    'capability-environment',
    'capability-services',
    'capability-chat',
    'capability-connections',
    'capability-monitoring',
    'capability-evaluation',
    'capability-preferences',
    'workflow-prepare',
    'workflow-run',
    'workflow-observe',
  ];
  for (const id of required) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(html, new RegExp(`id="${id}-trigger"`));
    assert.match(html, new RegExp(`aria-controls="${id}-panel"[^>]*id="${id}-trigger"|id="${id}-trigger"[^>]*aria-controls="${id}-panel"`));
    assert.match(html, new RegExp(`id="${id}-panel"[^>]*\\bhidden\\b|\\bhidden\\b[^>]*id="${id}-panel"`));
  }

  // Collapsed default: panels use hidden; screenshots live inside panels, not as always-visible gallery grids.
  assert.doesNotMatch(html, /id="gallery"|class="capabilities-grid"/);
  assert.match(html, /data-en="Environment &amp; models"/);
  assert.match(html, /data-en="Tuning &amp; Benchmark"/);
  assert.match(html, /data-en="Prepare"/);
});

test('Homepage script wires single-open reveal panels', async () => {
  const js = await readFile(join(root, 'website/app.js'), 'utf8');
  assert.match(js, /revealTriggers/);
  assert.match(js, /closeOtherReveals/);
  assert.match(js, /refreshOpenRevealMedia/);
  assert.match(js, /Hide details|收起详情/);
  assert.match(js, /'running-services'|running-services:/);
});
