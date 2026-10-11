import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendTelemetry, telemetryNumber, telemetryPoint, telemetrySparkline } from './serviceStatusTelemetry.ts';

const metric = (state, changes = {}) => ({ state, decodeTokS: 95, prefillTokS: 200, gpuUtil: 72, ...changes });
const point = (at, decode, gpu = 50) => ({ at, decode, prefill: null, gpu });
const empty = () => ({ identity: '', points: [] });

test('idle last-request speed and unloaded models never become fresh throughput samples', () => {
  const idle = telemetryPoint(100, metric('idle'), true);
  assert.equal(idle.decode, null);
  assert.equal(idle.prefill, null);
  assert.equal(idle.gpu, 72);
  for (const loaded of [false, undefined]) {
    assert.equal(telemetryPoint(100, metric('generating'), loaded).decode, null);
    assert.equal(telemetryPoint(100, metric('reading'), loaded).prefill, null);
  }
  assert.equal(telemetryPoint(100).gpu, null);
});

test('input and generation samples remain distinct, including valid zero measurements', () => {
  assert.equal(telemetryPoint(100, metric('reading'), true).prefill, 200);
  assert.equal(telemetryPoint(100, metric('reading'), true).decode, null);
  assert.equal(telemetryPoint(100, metric('generating', { decodeTokS: 0 }), true).decode, 0);
  assert.equal(telemetryPoint(100, metric('generating'), true).prefill, null);
  assert.equal(telemetryPoint(100, metric('prefill'), true).prefill, 200);
});

test('invalid or missing telemetry is unavailable rather than zero', () => {
  for (const value of [undefined, null, NaN, Infinity, -1, '72']) assert.equal(telemetryNumber(value), null);
  assert.equal(telemetryNumber(0), 0);
  assert.equal(telemetryPoint(100, metric('generating', { decodeTokS: NaN, gpuUtil: -1 }), true).decode, null);
});

test('refreshing a sample or accepting a stale reply does not grow or rewind history', () => {
  const history = appendTelemetry(empty(), 'A|pid1', point(100, 20));
  assert.equal(appendTelemetry(history, 'A|pid1', point(100, 90)), history);
  assert.equal(appendTelemetry(history, 'A|pid1', point(99, 90)), history);
  assert.equal(appendTelemetry(history, 'A|pid1', point(NaN, 90)), history);
  assert.equal(appendTelemetry(history, 'A|pid1', point(0, 90)), history);
});

test('switching the service or restarting its process resets unrelated history', () => {
  const history = appendTelemetry(empty(), 'A|pid1', point(100, 20));
  for (const identity of ['B|pid2', 'A|pid2']) {
    const changed = appendTelemetry(history, identity, point(101, 80));
    assert.equal(changed.identity, identity);
    assert.equal(changed.points.length, 1);
    assert.equal(changed.points[0].decode, 80);
  }
});

test('sampling bounds retained history by both elapsed time and size', () => {
  let history = appendTelemetry(empty(), 'A', point(1, 20));
  history = appendTelemetry(history, 'A', point(180002, 30));
  assert.equal(history.points.length, 1);
  for (let at = 180003; at <= 180102; at++) history = appendTelemetry(history, 'A', point(at, 30));
  assert.equal(history.points.length, 60);
  assert.equal(history.points.at(-1).at, 180102);
});

test('failed samples split curves and irregular sampling uses actual elapsed time', () => {
  const graph = telemetrySparkline([point(1000, 10), point(3000, 20), point(5000, null), point(11000, 15)], 'decode');
  assert.equal(graph.count, 3);
  assert.equal(graph.paths.length, 2);
  assert.match(graph.paths[0], /M4\.0,25\.0 L34\.4,6\.0/);
  assert.match(graph.paths[1], /^M156\.0,15\.5/);
  const gpu = telemetrySparkline([point(100, null, 50)], 'gpu', 100);
  assert.equal(gpu.last.x, 80);
  assert.equal(gpu.last.y, 25);
  assert.equal(telemetrySparkline([point(100, null, null)], 'gpu', 100).count, 0);
});
