import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, 'benchmarkComparisonView.ts'), 'utf8');
const panel = readFileSync(resolve(here, 'BenchmarkComparisonPanel.tsx'), 'utf8');
const css = readFileSync(resolve(here, 'benchmark-history-comparison.css'), 'utf8');

test('comparison fields keep every existing metric and three highlights', () => {
  for (const key of ['ttftMs', 'firstVisibleMs', 'wallMs', 'prefillTokS', 'decodeTokS', 'cacheHitRate', 'ramPeak', 'vramPeak']) {
    assert.match(source, new RegExp(`key: '${key}'`));
  }
  assert.equal([...source.matchAll(/highlight: true/g)].length, 3);
});

test('delta helpers treat latency lower and throughput higher as improvements', async () => {
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const cache = resolve(here, '../../.cache');
  mkdirSync(cache, { recursive: true });
  const modPath = resolve(cache, 'benchmarkComparisonView.test.mjs');
  writeFileSync(modPath, compiled);
  const mod = await import(`${pathToFileURL(modPath).href}?t=${Date.now()}`);
  const latency = mod.metricDelta(200, 160, 'ttftMs', false);
  assert.equal(latency.improved, true);
  assert.ok(Math.abs(latency.relative - (160 - 200) / 200) < 1e-9);
  const decode = mod.metricDelta(20, 24, 'decodeTokS', true);
  assert.equal(decode.improved, true);
  assert.equal(mod.formatRelative(decode.relative, 'en'), '+20%');
  assert.equal(mod.formatRelative(0, 'zh-CN'), '0%');
  assert.equal(mod.formatMetric(null, 'ttftMs', 'en'), '—');
  assert.equal(mod.formatMetric(8 * 2 ** 30, 'ramPeak', 'en'), '8');
  const bars = mod.dualBarHeights(20, 24);
  assert.ok(Math.abs(bars.b - 1) < 1e-9);
  assert.ok(Math.abs(bars.a - 20 / 24) < 1e-9);
});

test('panel keeps baseline actions and never folds condition notes', () => {
  assert.match(panel, /保存升级前基线/);
  assert.match(panel, /按基线串行重跑/);
  assert.match(panel, /报告 A/);
  assert.match(panel, /报告 B/);
  assert.match(panel, /bhc-verdict/);
  assert.match(panel, /bhc-highlights/);
  assert.match(panel, /bhc-table/);
  assert.doesNotMatch(panel, /<details|<summary/);
  assert.doesNotMatch(css, /\.horizontal-bar|stacked-bar/i);
  assert.match(css, /\.bhc-dual/);
});

test('winner bolds the better side: higher for speed/hit, lower for latency/memory; none on ties or gaps', async () => {
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const cache = resolve(here, '../../.cache');
  mkdirSync(cache, { recursive: true });
  const modPath = resolve(cache, 'benchmarkComparisonView.winner.mjs');
  writeFileSync(modPath, compiled);
  const mod = await import(`${pathToFileURL(modPath).href}?t=${Date.now()}`);
  const fields = Object.fromEntries(mod.COMPARISON_FIELDS.map(f => [f.key, f]));
  const winner = (key, a, b) => mod.metricWinner(mod.metricDelta(a, b, key, fields[key].higherBetter));
  for (const key of ['decodeTokS', 'prefillTokS', 'cacheHitRate']) {
    assert.equal(winner(key, 0.2, 0.4), 'b', key);
    assert.equal(winner(key, 0.4, 0.2), 'a', key);
  }
  for (const key of ['ttftMs', 'firstVisibleMs', 'wallMs', 'ramPeak', 'vramPeak']) {
    assert.equal(winner(key, 200, 160), 'b', key);
    assert.equal(winner(key, 160, 200), 'a', key);
  }
  assert.equal(winner('decodeTokS', 20, 20), null);
  assert.equal(winner('ttftMs', null, 160), null);
  assert.equal(winner('ramPeak', 8 * 2 ** 30, null), null);
  assert.match(panel, /data-win=\{win\(delta, 'a'\)\}/);
  assert.match(panel, /data-win=\{win\(delta, 'b'\)\}/);
  assert.match(css, /data-win='yes'\]\s*\{\s*font-weight: 700/);
});
