import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('./overview-dashboard.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tsx = readFileSync(new URL('./OverviewDashboard.tsx', import.meta.url), 'utf8');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));

test('memory bar segments and legend swatches read the same colour token', () => {
  const fills = rules.filter(rule => /\.seg-[ab]\b/.test(rule.selector) && /background/.test(rule.body));
  for (const seg of ['a', 'b']) {
    const own = fills.filter(rule => new RegExp(`\\.seg-${seg}\\b`).test(rule.selector));
    assert.ok(own.length > 0, `seg-${seg} has a fill`);
    for (const rule of own) assert.match(rule.body, new RegExp(`background:var\\(--seg-${seg}[,)]`), `${rule.selector} must paint from --seg-${seg}`);
  }
  // Each device defines both tokens once, so bar and legend (both inside the device) resolve to one value.
  for (const dev of ['gpu', 'ram']) {
    const def = rules.find(rule => rule.selector === `.ovw-dev-${dev}`);
    assert.ok(def && /--seg-a:/.test(def.body) && /--seg-b:/.test(def.body), `.ovw-dev-${dev} defines --seg-a and --seg-b`);
  }
});

test('pressure states never repaint a segment', () => {
  const offenders = rules.filter(rule => /\.t-(warn|bad)\b/.test(rule.selector) && /\.seg-[ab]\b/.test(rule.selector));
  assert.deepEqual(offenders.map(rule => rule.selector), []);
  assert.ok(rules.some(rule => /\.ovw-mem\.t-warn s\b/.test(rule.selector)), 'warn pressure is shown on the threshold mark');
  assert.ok(rules.some(rule => /\.ovw-mem\.t-bad s\b/.test(rule.selector)), 'bad pressure is shown on the threshold mark');
});

test('every bar segment class has a matching legend entry', () => {
  const bars = [...tsx.matchAll(/<div className=\{`ovw-mem [\s\S]*?<div className="ovw-arcs">/g)].map(m => m[0]);
  assert.equal(bars.length, 2, 'GPU and RAM bars');
  for (const block of bars) {
    const [bar, legend] = block.split('{legend(');
    const barClasses = [...bar.matchAll(/<i className="(seg-[ab])"/g)].map(m => m[1]);
    const legendClasses = [...legend.matchAll(/'(seg-[ab])'\]/g)].map(m => m[1]);
    assert.deepEqual(barClasses, ['seg-a', 'seg-b']);
    assert.deepEqual(legendClasses, barClasses);
  }
});
