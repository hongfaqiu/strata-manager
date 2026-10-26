import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { cacheSavedSeconds, durationParts, powerReading, ringDash } from './apiUsageHighlights.ts';

const page = readFileSync(new URL('./ApiUsagePage.tsx', import.meta.url), 'utf8');
const highlights = readFileSync(new URL('./ApiUsageHighlights.tsx', import.meta.url), 'utf8');
const strings = readFileSync(new URL('./ApiUsageLayoutStrings.ts', import.meta.url), 'utf8');

test('saved prefill time uses only measured engine timings', () => {
  const saved = cacheSavedSeconds({ cacheReadTokens: 9000, prefillTokens: 3000, prefillS: 3 });
  assert.equal(saved.prefillTokS, 1000);
  assert.equal(saved.seconds, 9);
  assert.equal(cacheSavedSeconds({ cacheReadTokens: 9000, prefillTokens: 3000, prefillS: null }), null);
  assert.equal(cacheSavedSeconds({ cacheReadTokens: null, prefillTokens: 3000, prefillS: 3 }), null);
  assert.equal(cacheSavedSeconds({ cacheReadTokens: 10, prefillTokens: 0, prefillS: 0 }), null);
  assert.equal(cacheSavedSeconds(null), null);
  assert.equal(cacheSavedSeconds({ cacheReadTokens: 0, prefillTokens: 10, prefillS: 1 }).seconds, 0);
});

test('power reports unsupported instead of inventing 0 W', () => {
  assert.deepEqual(powerReading({ watts: null, unavailable: false, mac: true }), { kind: 'unsupported', reason: 'mac' });
  assert.deepEqual(powerReading({ watts: null, unavailable: false, mac: false }), { kind: 'unsupported', reason: 'device' });
  assert.deepEqual(powerReading({ watts: 120, unavailable: false, stopped: true, mac: false }), { kind: 'stopped' });
  assert.deepEqual(powerReading({ watts: 120, unavailable: true, mac: false }), { kind: 'unsupported', reason: 'device' });
  const live = powerReading({ watts: 248, limit: 320, history: [100, null, 200, Number.NaN, -1], unavailable: false, mac: false });
  assert.equal(live.kind, 'live');
  assert.equal(live.watts, 248);
  assert.equal(live.limit, 320);
  assert.equal(live.average, 150);
  assert.deepEqual(live.samples, [100, null, 200, null, null]);
  const noHistory = powerReading({ watts: 0, limit: 0, unavailable: false, mac: false });
  assert.equal(noHistory.watts, 0, 'a measured 0 W stays 0 W');
  assert.equal(noHistory.limit, null);
  assert.equal(noHistory.average, null);
});

test('duration and ring helpers', () => {
  assert.deepEqual(durationParts(4.2), { value: 4.2, unit: 'second', digits: 1 });
  assert.deepEqual(durationParts(90), { value: 1.5, unit: 'minute', digits: 1 });
  assert.deepEqual(durationParts(5400), { value: 1.5, unit: 'hour', digits: 1 });
  assert.equal(ringDash(null, 100), null);
  assert.equal(ringDash(0.25, 100), '25 75');
  assert.equal(ringDash(1.4, 100), '100 0');
  assert.equal(ringDash(-1, 100), '0 100');
});

test('key metrics render above the request KPIs and existing sections are kept', () => {
  const order = ['<ApiUsageHighlights', 'api-usage-kpis', 'api-usage-trend-card', 'aria-label={text.latency}', 'aria-label={layout.efficiencyTitle}', 'aria-label={layout.outcomeTitle}', 'aria-label={text.sources}', '<ApiUsageLive', '<RequestHistory', 'api-usage-notes-card'];
  const positions = order.map(marker => page.indexOf(marker));
  positions.forEach((position, index) => assert.ok(position > 0, `${order[index]} is present`));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  for (const key of ['cache', 'expert', 'saved', 'ttft', 'power']) assert.match(highlights, new RegExp(`data-highlight="${key}"`));
  assert.match(highlights, /layout\.hlUnsupported/);
  assert.match(highlights, /layout\.hlEnergyUnsupported/);
});

test('new strings are translated for zh-CN and en', () => {
  for (const key of ['highlightsTitle', 'hlCache', 'hlPower', 'hlUnsupported', 'hlEnergyUnsupported', 'hlSavedDetail']) {
    const row = new RegExp(`${key}: \\['([^']+)', '([^']+)'`).exec(strings);
    assert.ok(row, key);
    assert.notEqual(row[1], row[2]);
  }
  assert.match(strings, /hlUnsupported: \['暂不支持', 'Not supported'/);
});
