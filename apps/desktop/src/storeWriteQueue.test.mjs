import test from 'node:test';
import assert from 'node:assert/strict';
import { createLatestStoreWriter } from './storeWriteQueue.mjs';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
test('unchanged snapshots skip writes and one changed key leaves others alone', async () => {
  const calls = [], writer = createLatestStoreWriter(async (key, value) => calls.push([key, value]));
  const chats = [{ attachment: 'x'.repeat(2_000_000) }]; writer.seed('conversations', chats); writer.seed('sidebar', false);
  for (let index = 0; index < 20; index++) { writer.stage('conversations', chats); await writer.flushAll(); }
  assert.equal(calls.length, 0);
  writer.stage('sidebar', true); await writer.flushAll(); assert.deepEqual(calls, [['sidebar', true]]);
});
test('blocked old checkpoint drains the newest final snapshot without concurrent writes', async () => {
  const gate = deferred(), started = deferred(), calls = []; let active = 0, maximum = 0;
  const writer = createLatestStoreWriter(async (key, value) => { maximum = Math.max(maximum, ++active); calls.push(value); if (calls.length === 1) { started.resolve(); await gate.promise; } active--; });
  writer.stage('conversations', { text: 'old' }); const first = writer.flush('conversations'); await started.promise;
  writer.stage('conversations', { text: 'middle' }); writer.flush('conversations');
  writer.stage('conversations', { text: 'final', done: true }); const final = writer.flush('conversations'); gate.resolve();
  await Promise.all([first, final]); assert.equal(maximum, 1); assert.deepEqual(calls, [{ text: 'old' }, { text: 'final', done: true }]);
  await writer.flushAll(); assert.equal(calls.length, 2);
});
test('failed write retains dirty latest state for retry and final completion', async () => {
  const calls = []; let failing = true;
  const writer = createLatestStoreWriter(async (_, value) => { calls.push(value); if (failing) throw Error('synthetic disk failure'); });
  writer.stage('conversations', { text: 'partial' }); await assert.rejects(writer.flush('conversations'), /disk failure/);
  writer.stage('conversations', { text: 'final' }); failing = false; await writer.flushAll(); await writer.flushAll();
  assert.deepEqual(calls, [{ text: 'partial' }, { text: 'final' }]);
});
test('stream deltas staged during a checkpoint wait for the next explicit flush', async () => {
  const gate = deferred(), started = deferred(), calls = [];
  const writer = createLatestStoreWriter(async (_, value) => { calls.push(value); if (calls.length === 1) { started.resolve(); await gate.promise; } });
  writer.stage('conversations', 'checkpoint'); const saving = writer.flush('conversations'); await started.promise;
  for (let index = 0; index < 100; index++) writer.stage('conversations', `delta-${index}`);
  gate.resolve(); await saving; assert.deepEqual(calls, ['checkpoint']);
  await writer.flush('conversations'); assert.deepEqual(calls, ['checkpoint', 'delta-99']);
});
