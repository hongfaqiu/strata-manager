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
const parts = readFileSync(resolve(here, 'BenchmarkComparisonParts.tsx'), 'utf8');
const contextPage = readFileSync(resolve(here, 'ContextBenchmarkPage.tsx'), 'utf8');
const contextComparison = contextPage.slice(contextPage.indexOf("text('上下文历史对照'"), contextPage.indexOf('{imagePreview &&'));
async function loadView(name) {
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const cache = resolve(here, '../../.cache');
  mkdirSync(cache, { recursive: true });
  const modPath = resolve(cache, `benchmarkComparisonView.${name}.mjs`);
  writeFileSync(modPath, compiled);
  return import(`${pathToFileURL(modPath).href}?t=${Date.now()}`);
}

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
  assert.match(panel, /<ComparisonPickers/);
  assert.match(parts, /报告 A/);
  assert.match(parts, /报告 B/);
  assert.match(panel, /<ComparisonVerdict/);
  assert.match(parts, /bhc-verdict/);
  assert.match(panel, /bhc-highlights/);
  assert.match(panel, /bhc-table/);
  assert.doesNotMatch(panel + parts, /<details|<summary/);
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
  assert.match(parts, /data-win=\{winAttr\(delta, 'a'\)\}/);
  assert.match(parts, /data-win=\{winAttr\(delta, 'b'\)\}/);
  assert.match(panel, /<ComparisonValueCells/);
  assert.equal(mod.winAttr({ improved: true }, 'b'), 'yes');
  assert.equal(mod.winAttr({ improved: true }, 'a'), 'no');
  assert.equal(mod.winAttr({ improved: null }, 'a'), undefined);
  assert.match(css, /data-win='yes'\]\s*\{\s*font-weight: 700/);
});

test('context comparison reuses the shared A/B parts, never folds, bolds direction-aware', async () => {
  const mod = await loadView('context');
  for (const part of ['ComparisonPickers', 'ComparisonVerdict', 'ComparisonHighlightCard', 'ComparisonValueCells']) assert.match(contextComparison, new RegExp(`<${part}\\b`));
  assert.match(contextComparison, /bhc-highlights/);
  assert.match(contextComparison, /bhc-table/);
  assert.doesNotMatch(contextComparison, /<details|<summary/);
  for (const kept of ['对照上下文测试记录', '条件匹配', '仅并列展示测量值', '次成功', '条件核验', '以上方当前记录为 A']) assert.ok(contextComparison.includes(kept), kept);
  const fields = Object.fromEntries(mod.CONTEXT_COMPARISON_FIELDS.map(f => [f.key, f]));
  assert.deepEqual(mod.CONTEXT_COMPARISON_FIELDS.filter(f => f.featured).map(f => f.key), ['decodeTokS', 'prefillTokS', 'ttftMs']);
  const winner = (key, a, b) => mod.metricWinner(mod.valueDelta(mod.contextDisplay(a, key), mod.contextDisplay(b, key), fields[key].higherBetter));
  assert.equal(winner('decodeTokS', 30, 36), 'b');
  assert.equal(winner('prefillTokS', 900, 800), 'a');
  for (const key of ['ttftMs', 'firstVisibleMs', 'wallMs', 'ramPeak', 'vramPeak']) {
    assert.equal(winner(key, 4000, 3000), 'b', key);
    assert.equal(winner(key, 3000, 4000), 'a', key);
  }
  assert.equal(winner('decodeTokS', 30, 30), null);
  assert.equal(winner('ttftMs', null, 3000), null);
  assert.equal(mod.contextDisplay(2500, 'ttftMs'), 2.5);
  assert.equal(mod.contextDisplay(3 * 2 ** 30, 'vramPeak'), 3);
  const rows = [
    { tier: 8192, left: { decodeTokS: 40, ttftMs: 500 }, right: { decodeTokS: 42, ttftMs: 480 } },
    { tier: 131072, left: { decodeTokS: 20, ttftMs: null }, right: { decodeTokS: 24, ttftMs: 9000 } },
    { tier: 32768, left: { decodeTokS: 30, ttftMs: 2000 }, right: { decodeTokS: null, ttftMs: 1800 } },
  ];
  assert.equal(mod.featuredTier(rows, 'decodeTokS'), 131072);
  assert.equal(mod.featuredTier(rows, 'ttftMs'), 32768);
  assert.equal(mod.featuredTier([{ tier: 4096, left: {}, right: {} }], 'prefillTokS'), 4096);
  assert.equal(mod.featuredTier([], 'prefillTokS'), null);
  assert.match(css, /\.bhc-table-context/);
});
