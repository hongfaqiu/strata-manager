import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppUpdateController, CHECK_INTERVAL, appUpdateSourceSummary } from './appUpdateController.ts';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const source = (id, label = id === 'official' ? 'GitHub' : id === 'gh-proxy' ? 'GH Proxy' : 'GHProxy', selectedBy = 'automatic', kind = id === 'official' ? 'official' : 'mirror') => ({
  id, label, kind, selectedBy,
  manifestUrl: id === 'official'
    ? 'https://github.com/hongfaqiu/strata-manager/releases/latest/download/latest.json'
    : `https://${id === 'gh-proxy' ? 'gh-proxy.org' : 'ghproxy.net'}/https://github.com/hongfaqiu/strata-manager/releases/latest/download/latest.json`,
  downloadUrl: id === 'official'
    ? 'https://github.com/hongfaqiu/strata-manager/releases/download/v0.2.0/Strata.Manager_0.2.0_x64-setup.exe'
    : `https://${id === 'gh-proxy' ? 'gh-proxy.org' : 'ghproxy.net'}/https://github.com/hongfaqiu/strata-manager/releases/download/v0.2.0/Strata.Manager_0.2.0_x64-setup.exe`,
});
function fixture(overrides = {}) {
  const calls = [], states = [];
  let lastCheck = 0;
  const defaultSource = source('ghproxy');
  const fallbackSource = source('official', 'GitHub', 'fallback', 'official');
  const update = {
    version: '0.2.0', body: '### 中文\n- 测试更新。\n\n### English\n- Fixture update.',
    source: defaultSource,
    fallbackChain: [fallbackSource],
    attempts: [{ stage: 'check', result: 'selected', source: defaultSource, message: 'version 0.2.0' }],
    download: async onEvent => {
      calls.push('download');
      onEvent({ event: 'Source', data: {}, source: update.source, fallbackChain: update.fallbackChain, attempts: update.attempts });
      onEvent({ event: 'Started', data: { contentLength: 10 }, source: update.source, fallbackChain: update.fallbackChain, attempts: update.attempts });
      onEvent({ event: 'Progress', data: { chunkLength: 4 } });
      onEvent({ event: 'Progress', data: { chunkLength: 6 } });
      onEvent({ event: 'Finished', data: {} });
    },
    install: async () => { calls.push('install'); },
    close: async () => { calls.push('close'); },
    ...overrides.update,
  };
  const normalizeCheck = value => {
    if (value && typeof value === 'object' && 'update' in value) return value;
    return {
      update: value ?? null,
      source: value?.source,
      fallbackChain: value?.fallbackChain ?? [],
      attempts: value?.attempts ?? [],
    };
  };
  const controller = new AppUpdateController({
    check: async () => {
      calls.push('check');
      const result = overrides.dependencies?.check ? await overrides.dependencies.check() : update;
      return normalizeCheck(result);
    },
    prepare: async () => { calls.push('prepare'); },
    loadLastCheck: async () => lastCheck,
    saveLastCheck: async time => { lastCheck = time; calls.push('saveCheck'); },
    now: () => CHECK_INTERVAL + 1,
    ...Object.fromEntries(Object.entries(overrides.dependencies ?? {}).filter(([key]) => key !== 'check')),
  });
  controller.attach(state => states.push(state));
  controller.configure({ desktop: true, ready: true, enabled: overrides.enabled ?? true, idle: overrides.idle ?? true });
  return { controller, calls, states, update };
}

test('source summaries keep the chosen host and fallback order in both languages', () => {
  const chosen = source('ghproxy');
  const official = source('official', 'GitHub', 'fallback', 'official');
  assert.deepEqual(appUpdateSourceSummary(chosen, [official], true), {
    source: '更新来源: 自动选择 · GHProxy',
    fallback: '失败时依次回退: 官方 GitHub',
  });
  assert.deepEqual(appUpdateSourceSummary({ ...official, selectedBy: 'fallback' }, [], false), {
    source: 'Update source: Fallback · Official GitHub',
  });
});

test('automatic and manual checks offer the candidate and never download or install it', async () => {
  const { controller, calls, update } = fixture();
  await Promise.all([controller.automatic(), controller.automatic(), controller.check()]);
  assert.deepEqual(calls, ['check', 'saveCheck']);
  assert.equal(controller.state.phase, 'available');
  assert.equal(controller.state.version, update.version);
  assert.equal(controller.state.notes, update.body, 'retain both language sections for live language selection');
  assert.equal(controller.state.downloaded, false);
  await controller.automatic();
  assert.deepEqual(calls, ['check', 'saveCheck']);
  controller.detach();
});

test('confirmation verifies progress and installs the displayed candidate only once', async () => {
  const { controller, calls, states } = fixture();
  await controller.check();
  await Promise.all([controller.confirm('0.2.0'), controller.confirm('0.2.0'), controller.automatic()]);
  assert.deepEqual(calls, ['check', 'saveCheck', 'download', 'prepare', 'install', 'close']);
  assert.equal(controller.state.phase, 'installed');
  assert.equal(controller.state.received, 10);
  assert.equal(controller.state.total, 10);
  assert.equal(controller.state.downloaded, false);
  assert.ok(states.some(state => state.phase === 'downloading' && state.received === 4));
  await Promise.all([controller.confirm('0.2.0'), controller.check(), controller.automatic()]);
  assert.equal(calls.filter(call => call === 'install').length, 1);
  controller.detach();
  assert.equal(calls.filter(call => call === 'close').length, 1);
});

test('download fallback republishes the active source and resets progress for the successful retry', async () => {
  const mirror = source('ghproxy');
  const official = source('official', 'GitHub', 'fallback', 'official');
  const mirrorAttempts = [{ stage: 'check', result: 'selected', source: mirror, message: 'version 0.2.0' }];
  const officialAttempts = [...mirrorAttempts, { stage: 'download', result: 'failed', source: mirror, message: 'mirror timeout' }];
  const { controller, states } = fixture({ update: {
    source: mirror,
    fallbackChain: [official],
    download: async onEvent => {
      onEvent({ event: 'Source', data: {}, source: mirror, fallbackChain: [official], attempts: mirrorAttempts });
      onEvent({ event: 'Started', data: { contentLength: 10 }, source: mirror, fallbackChain: [official], attempts: mirrorAttempts });
      onEvent({ event: 'Progress', data: { chunkLength: 7 } });
      onEvent({ event: 'Source', data: {}, source: official, fallbackChain: [], attempts: officialAttempts });
      onEvent({ event: 'Started', data: { contentLength: 4 }, source: official, fallbackChain: [], attempts: officialAttempts });
      onEvent({ event: 'Progress', data: { chunkLength: 4 } });
      onEvent({ event: 'Finished', data: {} });
    },
  } });
  await controller.check();
  await controller.confirm('0.2.0');
  assert.equal(controller.state.phase, 'installed');
  assert.equal(controller.state.source.id, 'official');
  assert.ok(states.some(state => state.phase === 'downloading' && state.source?.id === 'ghproxy' && state.received === 7));
  assert.ok(states.some(state => state.phase === 'downloading' && state.source?.id === 'official' && state.received === 0));
  assert.ok(states.some(state => state.phase === 'downloading' && state.source?.id === 'official' && state.received === 4));
  controller.detach();
});

test('deferring a candidate keeps later timers and idle transitions from authorizing it', async () => {
  const { controller, calls } = fixture();
  await controller.automatic(true);
  controller.configure({ desktop: true, ready: true, enabled: true, idle: false });
  await controller.automatic();
  controller.configure({ desktop: true, ready: true, enabled: true, idle: true });
  await controller.automatic(true);
  assert.equal(controller.state.phase, 'available');
  assert.ok(!calls.includes('download') && !calls.includes('prepare') && !calls.includes('install'));
  controller.detach();
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
  await controller.confirm('0.2.0');
  assert.equal(controller.state.phase, 'error');
  assert.equal(controller.state.errorStage, 'download');
  assert.equal(controller.state.downloaded, false);
  assert.equal(controller.state.received, 3);
  assert.equal(controller.state.total, undefined);
  assert.ok(!calls.includes('prepare') && !calls.includes('install'));
  await controller.automatic();
  assert.equal(attempts, 1, 'timers cannot retry a failed download');
  await controller.confirm('0.2.0');
  assert.equal(controller.state.phase, 'installed');
  assert.equal(controller.state.received, 3, 'retry resets progress');
  assert.equal(calls.filter(call => call === 'check').length, 1);
  controller.detach();
  await tick();
  assert.equal(calls.filter(call => call === 'close').length, 1);
});

test('disabling automatic checks during a pending check leaves the candidate inert', async () => {
  const checking = deferred();
  const { controller, calls, update } = fixture({ dependencies: { check: () => checking.promise } });
  const pending = controller.automatic();
  await tick();
  controller.configure({ desktop: true, ready: true, enabled: false });
  checking.resolve(update);
  await pending;
  assert.equal(controller.state.phase, 'available');
  await controller.automatic();
  assert.ok(!calls.includes('download'));
  await controller.confirm('0.2.0');
  assert.equal(controller.state.phase, 'installed', 'approval works with automatic checks off');
  controller.detach();
});

test('turning automatic checks on does not install an already offered candidate', async () => {
  const { controller, calls } = fixture({ enabled: false });
  await controller.check();
  controller.configure({ desktop: true, ready: true, enabled: true });
  await controller.automatic();
  assert.equal(controller.state.phase, 'available');
  assert.deepEqual(calls, ['check', 'saveCheck']);
  controller.detach();
});

test('opening the app forces a check; later checks honor the twelve-hour interval', async () => {
  const { controller, calls } = fixture({ idle: false, dependencies: { loadLastCheck: async () => CHECK_INTERVAL } });
  await controller.automatic();
  assert.deepEqual(calls, []);
  await controller.automatic(true);
  assert.deepEqual(calls, ['check', 'saveCheck']);
  controller.detach();
});

test('turning off automatic checks does not revoke a confirmed update already downloading', async () => {
  const downloading = deferred();
  const { controller, calls } = fixture({ update: { download: () => { calls.push('download'); return downloading.promise; } } });
  await controller.check();
  const pending = controller.confirm('0.2.0');
  await tick();
  controller.configure({ desktop: true, ready: true, enabled: false });
  await controller.automatic();
  downloading.resolve();
  await pending;
  assert.equal(controller.state.phase, 'installed');
  assert.deepEqual(calls, ['check', 'saveCheck', 'download', 'prepare', 'install', 'close']);
  controller.detach();
});

test('unmount during download ignores stale events and closes after download settles', async () => {
  const downloading = deferred();
  let event;
  const { controller, calls, states } = fixture({ update: { download: onEvent => { event = onEvent; calls.push('download'); return downloading.promise; } } });
  await controller.check();
  const pending = controller.confirm('0.2.0');
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

test('StrictMode reattach closes a late resource and resumes one unapproved check', async () => {
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
  assert.ok(!calls.includes('download') && !calls.includes('install'));
  assert.equal(controller.state.phase, 'available');
  controller.detach();
});

test('offline check errors preserve the app and manual retry offers notes without installing', async () => {
  let attempts = 0;
  const { controller, calls, update } = fixture({ dependencies: { check: async () => { if (++attempts === 1) throw new Error('offline fixture'); return update; } } });
  await controller.automatic();
  assert.equal(controller.state.errorStage, 'check');
  assert.ok(!calls.includes('prepare') && !calls.includes('install'));
  await controller.check();
  assert.equal(controller.state.phase, 'available');
  assert.equal(controller.state.notes, update.body);
  controller.detach();
});

test('safe preparation failure retains verified bytes for explicit install retry', async () => {
  let attempts = 0;
  const { controller, calls } = fixture({ dependencies: { prepare: async () => { calls.push('prepare'); if (++attempts === 1) throw new Error('busy model fixture'); } } });
  await controller.automatic();
  await controller.confirm('0.2.0');
  assert.equal(controller.state.errorStage, 'install');
  assert.equal(controller.state.downloaded, true);
  assert.ok(!calls.includes('install'));
  await controller.automatic(true);
  assert.equal(attempts, 1);
  await controller.confirm('0.2.0');
  assert.equal(calls.filter(call => call === 'download').length, 1);
  assert.equal(calls.filter(call => call === 'prepare').length, 2);
  assert.equal(calls.filter(call => call === 'install').length, 1);
  controller.detach();
});

test('unmount during preparation prevents installation and releases verified resources', async () => {
  const preparing = deferred();
  const { controller, calls } = fixture({ dependencies: { prepare: () => preparing.promise } });
  await controller.check();
  const pending = controller.confirm('0.2.0');
  await tick();
  controller.detach();
  preparing.resolve();
  await pending;
  assert.ok(!calls.includes('install'));
  assert.equal(calls.filter(call => call === 'close').length, 1);
});

test('a busy app cannot start an update; becoming idle still requires confirmation', async () => {
  const { controller, calls } = fixture({ idle: false });
  await controller.check();
  await controller.confirm('0.2.0');
  assert.deepEqual(calls, ['check', 'saveCheck']);
  controller.configure({ desktop: true, ready: true, enabled: true, idle: true });
  await controller.automatic();
  assert.deepEqual(calls, ['check', 'saveCheck']);
  await controller.confirm('0.2.0');
  assert.equal(controller.state.phase, 'installed');
  controller.detach();
});

test('becoming busy during an approved download retains bytes without installing', async () => {
  const downloading = deferred();
  const { controller, calls } = fixture({ update: { download: () => { calls.push('download'); return downloading.promise; } } });
  await controller.check();
  const pending = controller.confirm('0.2.0');
  await tick();
  controller.configure({ desktop: true, ready: true, enabled: true, idle: false });
  downloading.resolve();
  await pending;
  assert.equal(controller.state.phase, 'downloaded');
  assert.ok(!calls.includes('prepare') && !calls.includes('install'));
  controller.configure({ desktop: true, ready: true, enabled: true, idle: true });
  await controller.automatic();
  assert.ok(!calls.includes('install'));
  await controller.confirm('0.2.0');
  assert.equal(calls.filter(call => call === 'download').length, 1);
  assert.equal(controller.state.phase, 'installed');
  controller.detach();
});

test('becoming busy during preparation defers native installation until explicit retry', async () => {
  const preparing = deferred();
  const { controller, calls } = fixture({ dependencies: { prepare: () => { calls.push('prepare'); return preparing.promise; } } });
  await controller.check();
  const pending = controller.confirm('0.2.0');
  await tick();
  controller.configure({ desktop: true, ready: true, enabled: true, idle: false });
  preparing.resolve();
  await pending;
  assert.equal(controller.state.phase, 'downloaded');
  assert.ok(!calls.includes('install'));
  controller.configure({ desktop: true, ready: true, enabled: true, idle: true });
  await controller.automatic();
  assert.equal(calls.filter(call => call === 'prepare').length, 1);
  await controller.confirm('0.2.0');
  assert.equal(calls.filter(call => call === 'prepare').length, 2);
  assert.equal(calls.filter(call => call === 'install').length, 1);
  controller.detach();
});

test('changing the automatic-check setting during preparation preserves explicit approval', async () => {
  const preparing = deferred();
  const { controller, calls } = fixture({ dependencies: { prepare: () => { calls.push('prepare'); return preparing.promise; } } });
  await controller.check();
  const pending = controller.confirm('0.2.0');
  await tick();
  controller.configure({ desktop: true, ready: true, enabled: false });
  preparing.resolve();
  await pending;
  assert.equal(controller.state.phase, 'installed');
  assert.equal(calls.filter(call => call === 'install').length, 1);
  controller.detach();
});

test('native install failure is never retried by a timer; explicit retry reuses bytes', async () => {
  let installs = 0;
  const { controller, calls } = fixture({ update: { install: async () => { calls.push('install'); if (++installs === 1) throw new Error('installer rejected fixture'); } } });
  await controller.check();
  await controller.confirm('0.2.0');
  assert.equal(controller.state.phase, 'error');
  assert.equal(controller.state.downloaded, true);
  await controller.automatic();
  await controller.automatic(true);
  assert.equal(installs, 1);
  await controller.confirm('0.2.0');
  assert.equal(installs, 2);
  assert.equal(controller.state.phase, 'installed');
  assert.equal(calls.filter(call => call === 'download').length, 1);
  controller.detach();
});

test('disabling during timestamp persistence cannot authorize a download', async () => {
  const saving = deferred();
  const { controller, calls } = fixture({ dependencies: { saveLastCheck: () => saving.promise } });
  const pending = controller.automatic();
  await tick();
  controller.configure({ desktop: true, ready: true, enabled: false });
  saving.resolve();
  await pending;
  assert.equal(controller.state.phase, 'available');
  assert.ok(!calls.includes('download') && !calls.includes('prepare') && !calls.includes('install'));
  controller.detach();
});

test('approval of an older displayed version cannot authorize a newer candidate', async () => {
  let next;
  const { controller, calls, update } = fixture({ dependencies: { check: async () => next } });
  next = update;
  await controller.check();
  next = { ...update, version: '0.3.0', body: '### English\n- Notes for 0.3.0.' };
  await controller.check();
  await controller.confirm('0.2.0');
  assert.equal(controller.state.version, '0.3.0');
  assert.equal(controller.state.notes, next.body);
  assert.ok(!calls.includes('download') && !calls.includes('install'));
  await controller.confirm('0.3.0');
  assert.equal(controller.state.phase, 'installed');
  controller.detach();
});

test('an in-flight check cannot apply stale approval to its eventual candidate', async () => {
  const checking = deferred();
  let next;
  const { controller, calls, update } = fixture({ dependencies: { check: async () => next } });
  next = update;
  await controller.check();
  next = checking.promise;
  const pending = controller.check();
  await tick();
  const staleApproval = controller.confirm('0.2.0');
  checking.resolve({ ...update, version: '0.3.0' });
  await Promise.all([pending, staleApproval]);
  assert.equal(controller.state.version, '0.3.0');
  assert.ok(!calls.includes('download') && !calls.includes('install'));
  controller.detach();
});

test('the shared update gate blocks download and releases after an approved operation', async () => {
  let permitted = false, releases = 0;
  const { controller, calls } = fixture({ dependencies: { acquire: () => permitted, release: () => { releases += 1; } } });
  await controller.check();
  await controller.confirm('0.2.0');
  assert.equal(controller.state.phase, 'error');
  assert.ok(!calls.includes('download') && !calls.includes('prepare') && !calls.includes('install'));
  assert.equal(releases, 0);
  permitted = true;
  await controller.confirm('0.2.0');
  assert.equal(controller.state.phase, 'installed');
  assert.equal(releases, 1);
  controller.detach();
});

test('signature failure releases the shared update gate', async () => {
  let releases = 0;
  const { controller } = fixture({ update: { download: async () => { throw new Error('invalid signature'); } }, dependencies: { acquire: () => true, release: () => { releases += 1; } } });
  await controller.check();
  await controller.confirm('0.2.0');
  assert.equal(controller.state.errorStage, 'download');
  assert.equal(releases, 1);
  controller.detach();
});

test('an unavailable candidate cannot be approved and cleanup rejection is contained', async () => {
  let next;
  const { controller, calls, update } = fixture({ update: { close: async () => { calls.push('close'); throw new Error('cleanup fixture'); } }, dependencies: { check: async () => next } });
  next = update;
  await controller.check();
  next = null;
  await controller.check();
  assert.equal(controller.state.phase, 'current');
  await controller.confirm('0.2.0');
  assert.ok(!calls.includes('download') && !calls.includes('install'));
  assert.equal(calls.filter(call => call === 'close').length, 1);
  controller.detach();
});
