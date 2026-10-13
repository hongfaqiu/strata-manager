import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatFloatingMonitorValue } from './floatingMonitorPresentation.ts';

test('compact throughput keeps its full numeric tooltip while abbreviating thousands', () => {
  assert.deepEqual(formatFloatingMonitorValue(1280, 'prefill', 'en', true), { text: '1.3k', fullText: '1,280' });
  assert.deepEqual(formatFloatingMonitorValue(1000, 'generation', 'zh-CN', true), { text: '1k', fullText: '1,000' });
  assert.deepEqual(formatFloatingMonitorValue(999.5, 'generation', 'en', true), { text: '999.5', fullText: '999.5' });
  assert.equal(formatFloatingMonitorValue(1250000, 'prefill', 'en', true).text, '1.3M');
  assert.equal(formatFloatingMonitorValue(1280, 'prefill', 'en', false).text, '1,280');
});

test('zero remains measurable and unknown values stay unknown', () => {
  assert.deepEqual(formatFloatingMonitorValue(0, 'gpu', 'en', true), { text: '0', fullText: '0' });
  for (const value of [null, NaN, Infinity, -Infinity]) {
    assert.deepEqual(formatFloatingMonitorValue(value, 'vram', 'zh-CN', true), { text: '—', fullText: '—' });
  }
  assert.equal(formatFloatingMonitorValue(19.8, 'vram', 'zh-CN', true).text, '19.8');
  assert.equal(formatFloatingMonitorValue(76.2, 'gpu', 'zh-CN', true).text, '76');
});

test('bounded metric values fit their stable character budgets across scale boundaries', () => {
  const budgets = { generation: 6, prefill: 6, gpu: 3, vram: 5, cpu: 3, ram: 5, temperature: 3, power: 4, running: 4, queued: 4, cache: 3 };
  for (const [metric, budget] of Object.entries(budgets)) {
    const values = ['gpu', 'cpu', 'cache'].includes(metric) ? [0, 9.9, 99.9, 100]
      : [0, 9.9, 99.9, 999, 999.9, 999.95, 1000, 1280, 999900, 999950, 1000000, 999900000, 1300000000, 1000000000000];
    for (const language of ['zh-CN', 'en']) for (const value of values) {
      const result = formatFloatingMonitorValue(value, metric, language, true, budget);
      assert.ok(result.text.length <= budget, `${metric} ${value} should fit ${budget} characters: ${result.text}`);
      assert.notEqual(result.fullText, '—');
    }
  }
  assert.deepEqual(formatFloatingMonitorValue(999900, 'ram', 'en', true, 5), { text: '1M', fullText: '999,900' });
  assert.deepEqual(formatFloatingMonitorValue(1280, 'temperature', 'en', true, 3), { text: '1k', fullText: '1,280' });
  assert.deepEqual(formatFloatingMonitorValue(999950, 'prefill', 'en', true, 6), { text: '1M', fullText: '999,950' });
});
