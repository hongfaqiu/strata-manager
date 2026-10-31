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
const { unifiedGpu } = load('../../../../packages/core/src/gpu-summary.ts', { './errors': { asObject: value => value && typeof value === 'object' && !Array.isArray(value) ? value : {} } });
const platformModule = load('../../../../packages/core/src/local-runtime-package.ts', {});
const community = load('../../../../packages/core/src/community-catalog.ts', { './catalog': { MODEL_CATALOG }, './local-runtime-package': platformModule });
const downloads = load('../../../../packages/core/src/runtime-download.ts', { './bridge': {} });
const core = { MODEL_CATALOG, unifiedGpu, ...platformModule, ...community, runtimeBilingualText: downloads.runtimeBilingualText };
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

// Captured shape of environment_info on an Apple M5 Pro (48 GB) from the macOS probe (system_profiler + Metal).
const m5Pro = { name: 'Apple M5 Pro', vendor: 'apple', cores: 20, unifiedMemory: true, memoryBytes: 48 * GB, gpuBudgetBytes: 36 * GB, gpuBudgetEstimated: false, metal: 4, source: 'system_profiler' };
const mac = { os: 'macOS 26.1 Tahoe', arch: 'aarch64', cpuName: 'Apple M5 Pro', totalMemory: 48 * GB, availableMemory: 30 * GB, gpus: ['Apple M5 Pro'], gpuDetails: [m5Pro], python: 'Python 3.12.15', git: null, appVersion: '0.2.10' };

test('Apple Silicon: the on-chip GPU passes the check with unified memory, never "no GPU"', () => {
  const gpu = model.environmentChecks(mac).find(check => check.id === 'gpu');
  assert.equal(gpu.state, 'ok');
  assert.equal(gpu.value, 'Apple M5 Pro · Metal 4');
  assert.equal(gpu.detail, 'appleUnified');
  assert.deepEqual({ ...gpu.params }, { cores: 20, total: 48, budget: 36 });
  assert.equal(model.environmentVerdict(model.environmentChecks(mac)), 'pass');
  assert.equal(model.gpuRowValue(mac), 'Apple M5 Pro · Metal 4');
  // An unknown future chip is still Apple by vendor; a VM GPU without Metal is a warning, not a silent pass.
  assert.equal(model.environmentChecks({ ...mac, gpuDetails: [{ ...m5Pro, name: 'Apple M9 Hyper' }] }).find(check => check.id === 'gpu').state, 'ok');
  const vm = model.environmentChecks({ ...mac, gpus: ['Apple Paravirtual device'], gpuDetails: [{ ...m5Pro, name: 'Apple Paravirtual device', cores: undefined, metal: undefined }] }).find(check => check.id === 'gpu');
  assert.deepEqual([vm.state, vm.detail], ['warn', 'appleNoMetal']);
  // The release before this fix: no nvidia-smi, empty gpus.
  assert.equal(model.environmentChecks({ ...mac, gpus: [], gpuDetails: undefined }).find(check => check.id === 'gpu').detail, 'noGpu');
});

test('Intel Macs keep the non-NVIDIA warning and gain the GPU name', () => {
  const intel = { ...mac, arch: 'x86_64', gpus: ['Intel UHD Graphics 630', 'AMD Radeon Pro 5500M'], gpuDetails: [
    { name: 'Intel UHD Graphics 630', vendor: 'intel', unifiedMemory: false, gpuBudgetEstimated: false, metal: 3, source: 'system_profiler' },
    { name: 'AMD Radeon Pro 5500M', vendor: 'amd', unifiedMemory: false, memoryBytes: 8 * GB, gpuBudgetEstimated: false, metal: 3, source: 'system_profiler' },
  ] };
  const gpu = model.environmentChecks(intel).find(check => check.id === 'gpu');
  assert.deepEqual([gpu.state, gpu.detail], ['warn', 'nonNvidia']);
  assert.equal(gpu.value, 'Intel UHD Graphics 630 / AMD Radeon Pro 5500M');
});

test('Apple Silicon recommendations fit against unified RAM only (no VRAM added on top)', () => {
  const rows = model.recommendations('chat', 48, false, 50);
  for (const row of rows) assert.equal(row.fit, estimates.fitState(row.ramGB, 48));
  // The machine VRAM a Mac reports is undefined, so fitState never adds an offload budget.
  assert.equal(estimates.environmentVramGB(mac.gpus), undefined);
  assert.equal(estimates.usableMemoryGB(48, undefined), 48);
});

test('environment checks: all pass auto-skips, missing Python fails off Windows', () => {
  const base = { os: 'Windows 11', arch: 'x86_64', cpuName: 'x', totalMemory: 96 * GB, availableMemory: 60 * GB, gpus: ['NVIDIA GeForce RTX 4090, 560.94, 24564 MiB'], python: null, git: null, appVersion: '0' };
  assert.equal(model.environmentVerdict(model.environmentChecks(base)), 'pass');
  assert.equal(model.environmentVerdict(model.environmentChecks({ ...base, os: 'Ubuntu 24.04' })), 'fail');
  assert.equal(model.environmentVerdict(model.environmentChecks({ ...base, os: 'Ubuntu 24.04', python: 'Python 3.12.3' })), 'pass');
  // macOS ships Python 3.9; the one-click app-private Python passes and is labelled as such.
  const mac = { ...base, os: 'macOS 15.5', arch: 'aarch64', gpus: [] };
  assert.deepEqual({ ...model.environmentChecks({ ...mac, python: 'Python 3.9.6' }).find(check => check.id === 'python') }, { id: 'python', state: 'fail', value: 'Python 3.9.6', detail: 'required' });
  assert.deepEqual({ ...model.environmentChecks({ ...mac, python: 'Python 3.12.15', pythonManaged: true }).find(check => check.id === 'python') }, { id: 'python', state: 'ok', value: 'Python 3.12.15', detail: 'managed' });
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
  assert.equal(small[0].family, 'qwen36', 'qwen36 UD-Q4_K_XL (32 GB) and coder both fit 48 GB; chat scene prefers qwen36');
  assert.ok(small.some(row => row.family === 'coder' && row.fit === 'fits'));
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
  assert.equal(JSON.stringify(model.arenaLeaderboardQuery(same)), JSON.stringify({ group: 'swift:IQ3_S', gpu: 'RTX 4090' }));
  const other = model.arenaMatch(groups, 'swift', 'IQ3_S', model.parseGpu('NVIDIA GeForce RTX 4080 SUPER, 1, 24576 MiB'));
  assert.equal(other.level, 'vram'); assert.equal(other.machines, 13);
  assert.equal(JSON.stringify(model.arenaLeaderboardQuery(other)), JSON.stringify({ group: 'swift:IQ3_S', vram: '24' }));
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

test('Mac recommendations never offer families the Metal engine cannot run', () => {
  const mac = model.recommendations('chat', 48, false, 50, 'macos').map(row => row.family);
  for (const family of ['swift', 'coder', 'qwen36', 'unsloth']) assert.equal(mac.includes(family), false, family);
  assert.ok(mac.includes('qwen'));
  const windows = model.recommendations('chat', 96, true, 50, 'windows').map(row => row.family);
  assert.ok(windows.includes('swift'));
});

test('community selections survive a restart only when they are still valid', () => {
  const base = { schemaVersion: 1, status: 'active' };
  const keep = model.normalizeProgress({ ...base, selection: { family: 'community:sc117-abliterated', quant: 'IQ3_XXS', context: 32768, images: true } });
  assert.equal(keep.selection.family, 'community:sc117-abliterated');
  assert.equal(model.normalizeProgress({ ...base, selection: { family: 'community:sc117-abliterated', quant: 'Q8_0', context: 32768 } }).selection, undefined);
  const found = model.normalizeProgress({ ...base, selection: { family: 'community:hf:someone/repo@unsloth', quant: 'UD-Q4_K_XL', context: 32768 } });
  assert.equal(found.selection.quant, 'UD-Q4_K_XL');
  assert.equal(model.normalizeProgress({ ...base, selection: { family: 'community:hf:someone/repo@unsloth', quant: 'Q2_0', context: 32768 } }).selection, undefined);
  assert.equal(model.normalizeProgress({ ...base, selection: { family: 'community:hf:../x@qwen', quant: 'Q2_0', context: 32768 } }).selection, undefined);
});

test('a completed install whose runtime still needs repair stays on step 2 and shows the backend reason', () => {
  // Real 0.2.11 macOS state: the task completed, but discovery reports the venv without jinja2/regex.
  const runtimeProfile = { id: 'runtime-a', name: 'Strata', baseUrl: 'http://127.0.0.1:1', installDir: '/rt', pythonPath: '/rt/.venv/bin/python', configPath: '', managed: true };
  const base = { desktop: true, handoffs: [], runtimePending: false, environmentFailed: false, profiles: [], candidates: [], online: false, loaded: false, starting: false };
  const progress = { ...model.newProgress(1, 'install'), runtimeTaskId: 'install-1' };
  const tasks = [{ id: 'install-1', kind: 'install-runtime', state: 'completed', message: '', startedAt: 0, finishedAt: 1 }];
  const reason = 'Python 运行依赖缺失：regex, jinja2（检测的 Python：/rt/.venv/bin/python）';
  const stuck = model.deriveGuide({ ...base, progress, tasks, runtime: { taskId: 'install-1', result: { installDir: '/rt', pythonPath: '/rt/.venv/bin/python', profile: runtimeProfile }, detectedRuntimes: [{ readiness: 'repair', reason, profile: runtimeProfile }] } });
  assert.equal(stuck.facts.runtime, 'repair');
  assert.equal(stuck.plan.current, 'runtime');
  assert.equal(stuck.repairReason, reason, 'the reason is surfaced instead of a silent loop');
  // After the fixed backend installs requirements.txt, discovery reports ready and the guide advances.
  const fixed = model.deriveGuide({ ...base, progress, tasks, runtime: { taskId: 'install-1', detectedRuntimes: [{ readiness: 'ready', profile: runtimeProfile }] } });
  assert.equal(fixed.facts.runtime, 'ready');
  assert.equal(fixed.repairReason, undefined);
  assert.equal(fixed.plan.current, 'model');
  assert.equal(fixed.plan.steps.find(step => step.id === 'runtime').state, 'done');
});

test('the guide never suggests a family that needs a newer Strata release (DeepSeek-V4.1-Flash)', () => {
  for (const scene of ['chat', 'long', 'code']) {
    const rows = model.recommendations(scene, 512, true, 50, 'windows');
    assert.ok(rows.length > 0);
    assert.ok(rows.every(row => row.family !== 'deepseek41'));
  }
});

test('download step shows the source in use and the GitHub fallback notice', () => {
  const line = message => ({ message });
  const source = line('下载来源：gh-proxy.org（测速最快）· llama.cpp 源码 / Download source: gh-proxy.org (fastest) · llama.cpp source');
  assert.deepEqual({ ...model.setupDownloadView([], true) }, { done: false, fallback: false });
  assert.deepEqual({ ...model.setupDownloadView([line('下载来源测速：gh-proxy.org 278 ms / Source speed test: gh-proxy.org 278 ms'), source, line('1.0 MiB / 37.7 MiB（2%）')], true) }, { done: false, fallback: false, source: 'gh-proxy.org', reason: '测速最快' });
  const finished = model.setupDownloadView([source, line('引擎预下载：llama.cpp 源码已从 gh-proxy.org 下载并通过 SHA-256 校验，安装器将跳过下载 / Pre-download: ...'), line('=== Step 4: the Strata engine ===')], false);
  assert.equal(finished.reason, 'fastest'); assert.equal(finished.done, true);
  const fallback = model.setupDownloadView([source, line('预下载未完成：所有来源都失败。正在从 GitHub 下载引擎包，可能较慢，可在「下载设置」切换来源 / Pre-download failed: every source failed. Downloading from GitHub, which may be slow.')], false);
  assert.equal(fallback.fallback, true); assert.match(fallback.detail, /^Pre-download failed/); assert.equal(fallback.source, undefined);
});
