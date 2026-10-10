import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppUpdateController, CHECK_INTERVAL } from './appUpdateController.ts';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}) {
  const calls = [], states = [];
  const update = {
    version: '0.2.0', body: 'Memory fixture only',
    download: async onEvent => {
      calls.push('download');
      onEvent({ event: 'Started', data: { contentLength: 10 } });
      onEvent({ event: 'Progress', data: { chunkLength: 4 } });
      onEvent({ event: 'Progress', data: { chunkLength: 6 } });
      onEvent({ event: 'Finished' });
    },
    install: async () => { calls.push('install'); },
    close: async () => { calls.push('close'); },
    ...overrides.update,
  };
  const controller = new AppUpdateController({
    check: async () => { calls.push('check'); return update; },
    prepare: async () => { calls.push('prepare'); },
    loadLastCheck: async () => 0,
    saveLastCheck: async () => { calls.push('saveCheck'); },
    now: () => CHECK_INTERVAL + 1,
    ...overrides.dependencies,
  });
  controller.attach(state => states.push(state));
  controller.configure({ desktop: true, ready: true, enabled: overrides.enabled ?? true });
  return { controller, calls, states, update };
}

test('automatic checks and downloads once; preparation happens only on explicit install', async () => {
  const { controller, calls, states } = fixture();
  await Promise.all([controller.automatic(), controller.automatic(), controller.check()]);
  assert.deepEqual(calls, ['check', 'saveCheck', 'download']);
  assert.equal(controller.state.phase, 'downloaded');
  assert.equal(controller.state.received, 10);
  assert.equal(controller.state.total, 10);
  assert.equal(controller.state.downloaded, true);
  assert.ok(states.some(state => state.phase === 'downloading' && state.received === 4));
  await Promise.all([controller.download(), controller.check(), controller.automatic()]);
  assert.deepEqual(calls, ['check', 'saveCheck', 'download']);
  await controller.install();
  assert.deepEqual(calls, ['check', 'saveCheck', 'download', 'prepare', 'install', 'close']);
  assert.equal(controller.state.phase, 'installed');
  controller.detach();
  assert.equal(calls.filter(call => call === 'close').length, 1);
});

test('Finished followed by signature rejection stays retryable and never prepares or installs', async () => {
  let attempts = 0;
  const { controller, calls } = fixture({ update: {
    download: async onEvent => {
      calls.push('download'); attempts += 1;
      onEvent({ event: 'Started', data: {} });
      onEvent({ event: 'Progress', data: { chunkLength: 3 } });
      onEvent({ event: 'Finished' });
      if (attempts === 1) throw new Error('mock signature rejected');
    },
  } });
  await controller.automatic();
  assert.equal(controller.state.phase, 'error');
  assert.equal(controller.state.errorStage, 'download');
  assert.equal(controller.state.downloaded, false);
  assert.equal(controller.state.received, 3);
  assert.equal(controller.state.total, undefined);
  await controller.install();
  assert.ok(!calls.includes('prepare') && !calls.includes('install'));
  await controller.download();
  assert.equal(controller.state.phase, 'downloaded');
  assert.equal(controller.state.received, 3, 'retry resets progress');
  assert.equal(calls.filter(call => call === 'check').length, 1);
  controller.detach();
  await tick();
  assert.equal(calls.filter(call => call === 'close').length, 1);
});

test('disabling automatic downloads while a check is pending prevents a new download', async () => {
  const checking = deferred();
  const { controller, calls, update } = fixture({ dependencies: { check: () => checking.promise } });
  const pending = controller.automatic();
  await tick();
  controller.configure({ desktop: true, ready: true, enabled: false });
  checking.resolve(update);
  await pending;
  assert.equal(controller.state.phase, 'available');
  assert.ok(!calls.includes('download'));
  await controller.automatic();
  assert.ok(!calls.includes('download'));
  await controller.download();
  assert.equal(controller.state.phase, 'downloaded');
  assert.ok(!calls.includes('prepare'));
  controller.detach();
});

test('turning automatic downloads on downloads an already checked candidate even within the check interval', async () => {
  const { controller, calls } = fixture({ enabled: false });
  await controller.check();
  assert.equal(controller.state.phase, 'available');
  controller.configure({ desktop: true, ready: true, enabled: true });
  await controller.automatic();
  assert.equal(controller.state.phase, 'downloaded');
  assert.deepEqual(calls, ['check', 'saveCheck', 'download']);
  controller.detach();
});

test('opening the app forces a check; later timer checks honor the twelve-hour interval', async () => {
  const { controller, calls } = fixture({ dependencies: { loadLastCheck: async () => CHECK_INTERVAL } });
  await controller.automatic();
  assert.deepEqual(calls, []);
  await controller.automatic(true);
  assert.deepEqual(calls, ['check', 'saveCheck', 'download']);
  controller.detach();
});

test('disabling the setting during download lets that download settle without new work', async () => {
  const downloading = deferred();
  const { controller, calls } = fixture({ update: { download: () => { calls.push('download'); return downloading.promise; } } });
  const pending = controller.automatic();
  await tick();
  controller.configure({ desktop: true, ready: true, enabled: false });
  await controller.automatic();
  downloading.resolve();
  await pending;
  assert.equal(controller.state.phase, 'downloaded');
  assert.deepEqual(calls, ['check', 'saveCheck', 'download']);
  controller.detach();
});

test('unmount during download ignores stale events and closes only after download settles', async () => {
  const downloading = deferred();
  let event;
  const { controller, calls, states } = fixture({ update: { download: onEvent => { event = onEvent; calls.push('download'); return downloading.promise; } } });
  const pending = controller.automatic();
  await tick();
  controller.detach();
  const count = states.length;
  event({ event: 'Progress', data: { chunkLength: 99 } });
  assert.equal(states.length, count);
  assert.ok(!calls.includes('close'));
  downloading.resolve();
  await pending;
  assert.equal(calls.filter(call => call === 'close').length, 1);
  assert.ok(!calls.includes('prepare') && !calls.includes('install'));
});

test('StrictMode detach and reattach closes a late check resource and resumes a single new check', async () => {
  const checking = deferred();
  let checks = 0;
  const { controller, calls, update } = fixture({ dependencies: { check: () => { checks += 1; return checks === 1 ? checking.promise : Promise.resolve(update); } } });
  const pending = controller.automatic();
  await tick();
  controller.detach();
  controller.attach(() => {});
  void controller.automatic();
  checking.resolve({ ...update, close: async () => calls.push('lateClose') });
  await pending;
  await tick();
  assert.equal(checks, 2);
  assert.equal(calls.filter(call => call === 'lateClose').length, 1);
  assert.equal(calls.filter(call => call === 'download').length, 1);
  assert.equal(controller.state.phase, 'downloaded');
  controller.detach();
});

test('offline check errors preserve the old app and manual retry works', async () => {
  let attempts = 0;
  const { controller, calls, update } = fixture({ dependencies: { check: async () => { if (++attempts === 1) throw new Error('offline fixture'); return update; } } });
  await controller.automatic();
  assert.equal(controller.state.errorStage, 'check');
  assert.ok(!calls.includes('prepare') && !calls.includes('install'));
  await controller.check();
  assert.equal(controller.state.phase, 'downloaded');
  controller.detach();
});

test('failed safe preparation keeps downloaded bytes for install retry without a second download', async () => {
  let attempts = 0;
  const { controller, calls } = fixture({ dependencies: { prepare: async () => { calls.push('prepare'); if (++attempts === 1) throw new Error('busy model fixture'); } } });
  await controller.automatic();
  await controller.install();
  assert.equal(controller.state.errorStage, 'install');
  assert.equal(controller.state.downloaded, true);
  assert.ok(!calls.includes('install'));
  await controller.install();
  assert.equal(calls.filter(call => call === 'download').length, 1);
  assert.equal(calls.filter(call => call === 'prepare').length, 2);
  assert.equal(calls.filter(call => call === 'install').length, 1);
  controller.detach();
});

test('unmount during preparation prevents install and releases downloaded resources', async () => {
  const preparing = deferred();
  const { controller, calls } = fixture({ dependencies: { prepare: () => preparing.promise } });
  await controller.automatic();
  const pending = controller.install();
  await tick();
  controller.detach();
  preparing.resolve();
  await pending;
  assert.ok(!calls.includes('install'));
  assert.equal(calls.filter(call => call === 'close').length, 1);
});
