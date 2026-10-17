import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { MODEL_CATALOG } from '../../../../packages/core/src/catalog.ts';

const load = (file, modules) => {
  const source = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, URLSearchParams, require: name => modules[name] ?? {} });
  return module.exports;
};
const core = { MODEL_CATALOG };
const estimates = load('../pages/d2Estimates.ts', { '@strata-manager/core': core });
const model = load('./onboardingModel.ts', { '@strata-manager/core': core, '../pages/d2Estimates': estimates });
const GB = 1024 ** 3;
const facts = (patch = {}) => ({ environment: 'pass', runtime: 'none', hasModel: false, hasProfile: false, online: false, loaded: false, starting: false, ...patch });
const states = steps => Object.fromEntries(steps.map(step => [step.id, step.state]));

test('progress normalization keeps valid fields and drops foreign ones', () => {
  assert.equal(model.normalizeProgress(null), null);
  assert.equal(model.normalizeProgress({ schemaVersion: 2, status: 'active' }), null);
  assert.equal(model.normalizeProgress({ schemaVersion: 1, status: 'weird' }), null);
  const value = model.normalizeProgress({ schemaVersion: 1, status: 'active', path: 'install', scene: 'code', autoStart: 'yes', selection: { family: 'swift', quant: 'IQ3_S', context: 32768, images: true }, setupTaskId: 'task-1', startedAt: 5, extra: 1 });
  assert.equal(value.path, 'install');
  assert.equal(value.scene, 'code');
  assert.equal(value.autoStart, false, 'auto start is opt-in only');
  assert.deepEqual({ ...value.selection }, { family: 'swift', quant: 'IQ3_S', context: 32768, images: true });
  assert.equal(value.setupTaskId, 'task-1');
  assert.equal('extra' in value, false);
  assert.equal(model.normalizeProgress({ schemaVersion: 1, status: 'active', selection: { family: 'swift', quant: 'Q9', context: 32768 } }).selection, undefined);
  assert.equal(model.newProgress(1).autoStart, false);
});

test('existing users are not pushed into the guide', () => {
  assert.equal(model.effectiveStatus(null, true), 'completed');
  assert.equal(model.effectiveStatus(null, false), 'active');
  assert.equal(model.effectiveStatus({ status: 'skipped' }, false), 'skipped');
});

test('parses GPU strings from environment info', () => {
  const gpu = model.parseGpu('NVIDIA GeForce RTX 4090, 560.94, 24564 MiB');
  assert.equal(gpu.name, 'NVIDIA GeForce RTX 4090');
  assert.equal(gpu.driver, '560.94');
  assert.equal(gpu.vramGB, 24);
  assert.equal(gpu.nvidia, true);
  assert.equal(model.parseGpu('Apple M3 Max').vramGB, undefined);
});

test('environment checks: all pass auto-skips, missing Python fails off Windows', () => {
  const base = { os: 'Windows 11', arch: 'x86_64', cpuName: 'x', totalMemory: 96 * GB, availableMemory: 60 * GB, gpus: ['NVIDIA GeForce RTX 4090, 560.94, 24564 MiB'], python: null, git: null, appVersion: '0' };
  assert.equal(model.environmentVerdict(model.environmentChecks(base)), 'pass');
  assert.equal(model.environmentVerdict(model.environmentChecks({ ...base, os: 'Ubuntu 24.04' })), 'fail');
  assert.equal(model.environmentVerdict(model.environmentChecks({ ...base, os: 'Ubuntu 24.04', python: 'Python 3.12.3' })), 'pass');
  assert.equal(model.environmentVerdict(model.environmentChecks({ ...base, gpus: [] })), 'warn');
  assert.equal(model.environmentVerdict(model.environmentChecks({ ...base, totalMemory: 32 * GB })), 'warn');
  assert.equal(model.environmentVerdict(undefined), 'loading');
});

test('fresh machine starts at the runtime step when the environment passes', () => {
  const plan = model.guidePlan('install', facts(), model.newProgress(1, 'install'));
  assert.equal(states(plan.steps).environment, 'skipped');
  assert.equal(plan.current, 'runtime');
  assert.equal(plan.total, 6);
});

test('environment warnings stop on the environment step until accepted', () => {
  const progress = model.newProgress(1, 'install');
  assert.equal(model.guidePlan('install', facts({ environment: 'warn' }), progress).current, 'environment');
  assert.equal(model.guidePlan('install', facts({ environment: 'warn' }), { ...progress, environmentAccepted: true }).current, 'runtime');
  assert.equal(states(model.deriveInstallSteps(facts({ environment: 'fail' }), { ...progress, environmentAccepted: true })).environment, 'failed');
});

test('runtime install task drives the runtime step', () => {
  const progress = { ...model.newProgress(1, 'install'), runtimeTaskId: 't' };
  assert.equal(states(model.deriveInstallSteps(facts({ runtime: 'running' }), progress)).runtime, 'running');
  assert.equal(states(model.deriveInstallSteps(facts({ runtime: 'failed' }), progress)).runtime, 'failed');
  const ready = model.guidePlan('install', facts({ runtime: 'ready' }), progress);
  assert.equal(states(ready.steps).runtime, 'done');
  assert.equal(ready.current, 'model');
  assert.equal(states(model.deriveInstallSteps(facts({ runtime: 'ready' }), model.newProgress(1, 'install'))).runtime, 'skipped', 'detected runtime is skipped, not done');
});

test('download step follows the setup task and handoff', () => {
  const progress = { ...model.newProgress(1, 'install'), setupTaskId: 's' };
  const running = model.guidePlan('install', facts({ runtime: 'ready', setup: { state: 'running' } }), progress);
  assert.equal(running.current, 'download');
  assert.equal(states(running.steps).model, 'done');
  assert.equal(states(running.steps).download, 'running');
  assert.equal(states(model.deriveInstallSteps(facts({ runtime: 'ready', setup: { state: 'completed' }, handoff: 'pending' }), progress)).download, 'running');
  assert.equal(states(model.deriveInstallSteps(facts({ runtime: 'ready', setup: { state: 'failed' } }), progress)).download, 'failed');
  const registered = model.guidePlan('install', facts({ runtime: 'ready', setup: { state: 'completed' }, handoff: 'registered', hasProfile: true }), progress);
  assert.equal(states(registered.steps).download, 'done');
  assert.equal(registered.current, 'start');
});

test('existing model skips straight to start, then chat once loaded', () => {
  const progress = model.newProgress(1, 'install');
  const plan = model.guidePlan('install', facts({ environment: 'warn', hasModel: true, hasProfile: true }), progress);
  assert.equal(plan.steps.slice(0, 4).map(step => step.state).join(), 'skipped,skipped,skipped,skipped');
  assert.equal(plan.current, 'start');
  assert.equal(states(model.deriveInstallSteps(facts({ hasProfile: true, starting: true }), progress)).start, 'running');
  const loaded = model.guidePlan('install', facts({ hasProfile: true, online: true, loaded: true }), progress);
  assert.equal(loaded.current, 'chat');
  const done = model.guidePlan('install', facts({ hasProfile: true, online: true, loaded: true }), { ...progress, status: 'completed' });
  assert.equal(done.doneCount, 6);
  assert.equal(done.current, 'chat');
});

test('connect path: discover, load, chat', () => {
  const progress = model.newProgress(1, 'connect');
  assert.equal(model.guidePlan('connect', facts(), progress).current, 'discover');
  const online = model.guidePlan('connect', facts({ hasProfile: true, online: true }), progress);
  assert.equal(online.current, 'load');
  assert.equal(states(online.steps).load, 'running');
  assert.equal(model.guidePlan('connect', facts({ hasProfile: true, online: true, loaded: true }), progress).current, 'chat');
  assert.equal(model.suggestedPath({ hasModel: false, hasProfile: false, runningServices: 1 }), 'connect');
  assert.equal(model.suggestedPath({ hasModel: false, hasProfile: false, runningServices: 0 }), 'install');
});

test('recommendations fit memory, respect scene and push experimental last', () => {
  const chat = model.recommendations('chat', 96, true);
  assert.equal(chat[0].recommended, true);
  assert.equal(chat[0].fit, 'fits');
  assert.equal(chat[0].family, 'swift');
  assert.equal(chat[0].quant, 'IQ3_S', 'largest quant that fits');
  assert.equal(new Set(chat.slice(0, 4).map(row => row.family)).size, 4, 'one row per family first');
  assert.equal(model.recommendations('code', 96, true)[0].family, 'coder');
  const small = model.recommendations('chat', 48, true);
  assert.equal(small[0].family, 'coder', 'only coder IQ1_M (32 GB) fits 48 GB');
  const none = model.recommendations('chat', 16, false);
  assert.equal(none[0].recommended, false, 'nothing is recommended when nothing fits');
  const unsloth = model.recommendations('chat', 200, false, 20).filter(row => row.family === 'unsloth');
  assert.equal(unsloth.at(-1).quant, 'UD-Q4_K_XL');
  assert.equal(model.defaultContext('long'), 131072);
});

test('arena match prefers same GPU, then VRAM tier, else nothing', () => {
  const gpu = model.parseGpu('NVIDIA GeForce RTX 4090, 560.94, 24564 MiB');
  const groups = [{ group: 'swift:IQ3_S', family: 'swift', quant: 'IQ3_S', machines: 12, gpus: [{ gpu: 'RTX 4090', vramGB: 24, machines: 9 }, { gpu: 'RTX 3090', vramGB: 24, machines: 4 }] }];
  const same = model.arenaMatch(groups, 'swift', 'IQ3_S', gpu);
  assert.equal(same.level, 'gpu'); assert.equal(same.machines, 9);
  assert.equal(model.arenaLeaderboardQuery(same), 'group=swift%3AIQ3_S&gpu=RTX+4090');
  const other = model.arenaMatch(groups, 'swift', 'IQ3_S', model.parseGpu('NVIDIA GeForce RTX 4080 SUPER, 1, 24576 MiB'));
  assert.equal(other.level, 'vram'); assert.equal(other.machines, 13);
  assert.equal(model.arenaLeaderboardQuery(other), 'group=swift%3AIQ3_S&vram=24');
  assert.equal(model.arenaMatch(groups, 'qwen', 'Q2_0', gpu), null);
  assert.equal(model.arenaMatch([], 'swift', 'IQ3_S', gpu), null, 'empty public data shows no measurement');
  assert.equal(model.arenaMatch(undefined, 'swift', 'IQ3_S', gpu), null, 'offline shows no measurement');
  assert.equal([0, 1, 3, 10].map(model.confidenceBars).join(), '0,1,2,3');
});

test('deriveGuide reads runtime, setup task, handoff and target from backend state', () => {
  const profile = { id: 'p1', name: 'Swift', baseUrl: 'http://127.0.0.1:8080', installDir: 'd', pythonPath: '', configPath: 'c.json', managed: true };
  const runtimeProfile = { ...profile, id: 'rt', configPath: '' };
  const base = { desktop: true, tasks: [], handoffs: [], runtimePending: false, environmentFailed: false, profiles: [], candidates: [], online: false, loaded: false, starting: false };
  const progress = { ...model.newProgress(1, 'install'), runtimeTaskId: 'install-1', setupTaskId: 'setup-1' };
  const installing = model.deriveGuide({ ...base, progress, tasks: [{ id: 'install-1', kind: 'install-runtime', state: 'running', message: '', startedAt: 0 }] });
  assert.equal(installing.facts.runtime, 'running');
  assert.equal(installing.plan.current, 'runtime');
  const failed = model.deriveGuide({ ...base, progress, tasks: [{ id: 'install-1', kind: 'install-runtime', state: 'failed', message: 'x', startedAt: 0 }] });
  assert.equal(failed.facts.runtime, 'failed');
  const detectedOnly = model.deriveGuide({ ...base, progress: model.newProgress(1, 'install'), runtime: { detectedRuntimes: [{ readiness: 'ready', runtimeVersion: '0.1.44', profile: runtimeProfile }] } });
  assert.equal(detectedOnly.facts.runtime, 'ready');
  assert.equal(detectedOnly.readyRuntime.runtimeVersion, '0.1.44');
  assert.equal(detectedOnly.plan.current, 'model');
  assert.equal(model.deriveGuide({ ...base, progress: null, runtimePending: true }).facts.runtime, 'unknown');
  assert.equal(model.deriveGuide({ ...base, progress: null }).plan, undefined, 'no path chosen yet shows the entry screen');
  const registered = model.deriveGuide({ ...base, progress, runtime: { detectedRuntimes: [{ readiness: 'ready', profile: runtimeProfile }] }, profiles: [profile],
    tasks: [{ id: 'setup-1', kind: 'setup', state: 'completed', message: '', startedAt: 0 }], handoffs: [{ taskId: 'setup-1', status: 'registered', profileId: 'p1' }] });
  assert.equal(registered.target.id, 'p1');
  assert.equal(registered.plan.current, 'start');
  const loadedOther = model.deriveGuide({ ...base, progress, profiles: [profile, { ...profile, id: 'p2' }], activeProfile: { ...profile, id: 'p2' }, online: true, loaded: true,
    tasks: [{ id: 'setup-1', kind: 'setup', state: 'completed', message: '', startedAt: 0 }], handoffs: [{ taskId: 'setup-1', status: 'registered', profileId: 'p1' }] });
  assert.equal(loadedOther.facts.loaded, false, 'only the guide target counts as loaded');
  assert.equal(model.deriveGuide({ ...base, desktop: false, progress }).facts.environment, 'unavailable');
});
