import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendMonitorHistory, monitorValues } from './floatingMonitorHistory.ts';

const metric = { state: 'generating', decodeTokS: 60, prefillTokS: 1200, gpuUtil: 0, ramUsed: 1073741824, cacheHitRate: 0.75 };
test('live graph excludes idle last-request throughput and preserves measured zero', () => {
  assert.equal(monitorValues(metric, true).generation, 60);
  assert.equal(monitorValues(metric, true).prefill, null);
  assert.equal(monitorValues({ ...metric, state: 'idle' }, true).generation, null);
  assert.equal(monitorValues(metric, false).generation, null);
  assert.equal(monitorValues(metric, true).gpu, 0);
  assert.equal(monitorValues(metric, true).ram, 1);
  assert.equal(monitorValues(metric, true).cache, null);
  assert.equal(monitorValues(metric, true, false).cache, 75);
  assert.equal(monitorValues({ ...metric, gpuUtil: 120 }, true).gpu, null);
});
test('history resets by runtime identity, rejects duplicate timestamps, caps at 60 and preserves gaps', () => {
  let history = { identity: '', points: [] };
  for (let i = 1; i <= 75; i++) history = appendMonitorHistory(history, 'pid1', i * 1000, metric, true);
  assert.equal(history.points.length, 60);
  assert.equal(appendMonitorHistory(history, 'pid1', 75000, metric, true), history);
  history = appendMonitorHistory(history, 'pid1', 76000, undefined, false);
  assert.equal(history.points.at(-1).values.generation, null);
  history = appendMonitorHistory(history, 'pid2', 77000, metric, true);
  assert.equal(history.points.length, 1);
});
