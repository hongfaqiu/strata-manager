import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { applyConfig, configView, server } from './contract-server.mjs';

let baseUrl;
before(async () => {
  // An ephemeral independent port: never changes the acceptance fixture on 18091.
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
const get = async path => (await fetch(baseUrl + path)).json();
const post = (path, body, signal) => fetch(baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });

test('15 runconfig keys preserve types, validate atomically, and delete null values', () => {
  const initial = { api_monitor: false, preserved: 'keep', sampling: { min_p: 0.2 }, args: ['--other', 'x'] };
  const view = configView(initial);
  assert.equal(view.keys.length, 15);
  assert.equal(view.keys.find(item => item.key === 'sampling.temperature').value, null);
  assert.deepEqual(view.keys.find(item => item.key === 'effort_position').choices, ['start', 'end']);
  assert.ok(view.keys.every(item => !('default' in item)));
  const applied = applyConfig(initial, { 'sampling.top_k': 20, vram_reserve_mib: 512, aliases: 'a, b', api_monitor: true });
  assert.equal(applied.config.preserved, 'keep');
  assert.deepEqual(applied.config.sampling, { min_p: 0.2, top_k: 20 });
  assert.deepEqual(applied.config.args, ['--other', 'x', '--vram-reserve-mib', '512']);
  assert.deepEqual(applied.config.aliases, ['a', 'b']);
  const removed = applyConfig(applied.config, { 'sampling.top_k': null, 'sampling.min_p': null, vram_reserve_mib: null, aliases: null });
  assert.equal(removed.config.sampling, undefined);
  assert.deepEqual(removed.config.args, ['--other', 'x']);
  for (const changes of [{ api_monitor: true, 'sampling.top_k': 65 }, { api_monitor: 1 }, { host: '0.0.0.0' }, { 'sampling.top_p': 0 }, { vram_reserve_mib: 0.5 }, {}]) assert.throws(() => applyConfig(initial, changes));
  assert.equal(initial.api_monitor, false);
});

test('HTTP config uses set and API request detail returns official retention and 404', async () => {
  assert.equal((await post('/config', { api_monitor: true })).status, 400);
  assert.equal((await post('/config', { set: { api_monitor: true } })).status, 200);
  const config = await get('/config');
  assert.equal(config.keys.find(item => item.key === 'api_monitor').value, true);
  const list = await get('/api/requests');
  assert.equal(list.retention, 100);
  assert.equal(list.persistent, false);
  assert.equal((await fetch(baseUrl + '/api/requests?id=missing')).status, 404);
});

test('metrics completed history and totals derive from emitted SSE usage and measured wallclock', async () => {
  const body = { model: 'protocol-fixture', stream: true, messages: [{ role: 'user', content: '测试😀' }] };
  const response = await post('/v1/chat/completions', body);
  const frames = (await response.text()).split('\n\n').filter(frame => frame.startsWith('data: {')).map(frame => JSON.parse(frame.slice(6)));
  const usage = frames.at(-1).usage;
  const emitted = frames.map(frame => (frame.choices[0].delta.content ?? '') + (frame.choices[0].delta.reasoning_content ?? '')).join('');
  assert.equal(usage.prompt_tokens, Array.from(JSON.stringify(body.messages)).length);
  assert.equal(usage.completion_tokens, Array.from(emitted).length);
  assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens);
  const metrics = await get('/metrics');
  const request = metrics.requests[0];
  assert.equal(typeof request.time, 'number');
  assert.equal(request.finish, 'stop');
  assert.equal(request.prompt_tokens, usage.prompt_tokens);
  assert.equal(request.output_tokens, usage.completion_tokens);
  assert.ok(request.duration_s > 0);
  assert.equal(request.reused, 0);
  assert.equal(request.decode_ms, null);
  assert.equal(metrics.live.tok_s, null);
  assert.deepEqual(metrics.hardware, {});
  assert.deepEqual(metrics.hardware_static, {});
  assert.equal(metrics.totals.output_tokens, usage.completion_tokens);
  assert.equal(metrics.totals.prompt_ms, 0);
  assert.equal(metrics.totals.decode_ms, 0);
  assert.ok(metrics.totals.since <= request.time);
  const list = await get('/api/requests');
  assert.ok(!('input' in list.requests[0]));
  assert.ok(!('output' in list.requests[0]));
  const detail = await get(`/api/requests?id=${list.requests[0].id}`);
  assert.deepEqual(detail.usage, usage);
  assert.equal(detail.state, 'completed');
  assert.ok(detail.first_token_s > 0);
  assert.ok(detail.wallclock_s >= detail.first_token_s);
  assert.ok(!('_clock' in detail));
});

test('disconnect records emitted partial output without inventing engine timings', async () => {
  const controller = new AbortController();
  const response = await post('/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: '取消' }] }, controller.signal);
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await reader.cancel().catch(() => {});
  // Wait for this connection's close, not for a fixed model delay.
  for (let count = 0; count < 30; count++) {
    if ((await get('/__contract/state')).active === 0) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const metrics = await get('/metrics?requests=all');
  assert.equal(metrics.requests[0].finish, 'disconnect');
  assert.ok(metrics.requests[0].output_tokens > 0);
  assert.equal(metrics.totals.requests, 2);
  assert.equal(metrics.totals.prompt_tokens, metrics.requests.reduce((sum, item) => sum + item.prompt_tokens, 0));
  assert.equal(metrics.totals.output_tokens, metrics.requests.reduce((sum, item) => sum + item.output_tokens, 0));
  const detail = await get('/api/requests');
  assert.equal(detail.requests[0].state, 'disconnected');
  const status = await get('/v1/status');
  assert.equal(status.activity.in_flight, 0);
  assert.equal(status.activity.requests, metrics.totals.requests);
  assert.equal(status.last_timings, null);
  assert.equal(status.machine.gpu, null);
});

test('deliberate HTTP failure is retained as error without increasing model history', async () => {
  const response = await post('/v1/chat/completions', { messages: [{ role: 'user', content: '/error' }] });
  assert.equal(response.status, 502);
  const list = await get('/api/requests');
  assert.equal(list.requests[0].state, 'error');
  assert.equal(list.requests[0].http_status, 502);
  const detail = await get(`/api/requests?id=${list.requests[0].id}`);
  assert.equal(detail.error.code, 'fixture_error');
  assert.equal((await get('/metrics')).totals.requests, 2);
});
