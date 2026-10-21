// First-run guide fixture. All native IO is synthetic and in-memory; ?state= picks a scenario.
const params = new URLSearchParams(location.search);
const scenario = params.get('state') || 'entry';
const GB = 1024 ** 3, now = Date.now();
const runtimeProfile = { id: 'runtime-1', name: 'Strata', baseUrl: 'http://127.0.0.1:8080', installDir: 'C:\\Users\\fixture\\AppData\\Strata Manager\\runtime', pythonPath: 'C:\\Users\\fixture\\AppData\\Strata Manager\\runtime\\.venv\\Scripts\\python.exe', configPath: '', managed: true };
const modelProfile = { id: 'swift-iq3', name: 'Swift 1.5 IQ3_S', baseUrl: 'http://127.0.0.1:8080', installDir: runtimeProfile.installDir, pythonPath: runtimeProfile.pythonPath, configPath: 'C:\\Users\\fixture\\AppData\\Strata Manager\\runtime\\configs\\swift-1.5-iq3_s.json', managed: true };
const progress = (patch) => ({ schemaVersion: 1, status: 'active', path: 'install', scene: 'chat', autoStart: false, startedAt: now - 900000, updatedAt: now - 1000, ...patch });
const environment = { os: 'Windows 11 Pro 24H2', arch: 'x86_64', cpuName: 'AMD Ryzen 9 7950X', totalMemory: 96 * GB, availableMemory: 71 * GB, gpus: ['NVIDIA GeForce RTX 4090, 560.94, 24564 MiB'], python: null, git: null, appVersion: '0.1.11' };
const state = { profiles: [], candidates: [], tasks: [], handoffs: [], runtime: {}, running: {}, loaded: {}, store: { settings: { language: 'zh-CN', theme: params.get('theme') || 'light', pollInterval: 60000, autoCheckUpdates: false, closeToTray: false, skipExitConfirmation: false, languagePreference: 'zh-CN' } }, logs: {}, holdStart: false };
const readyRuntime = () => { state.runtime = { detectedRuntimes: [{ installDir: runtimeProfile.installDir, pythonPath: runtimeProfile.pythonPath, runtimeVersion: '0.1.44', readiness: 'ready', profile: runtimeProfile }] }; };
const log = (message, offset) => ({ timestamp: now - offset, level: 'INFO', message });
if (scenario === 'environment') { environment.gpus = []; environment.totalMemory = 64 * GB; state.store.onboardingV1 = progress({}); }
// ?mac=m5pro: Apple M5 Pro (48 GB) as the macOS probe reports it (system_profiler + Metal working set).
// ?mac=old: the same Mac on v0.2.10, which found no GPU (no nvidia-smi on macOS).
const mac = params.get('mac');
if (mac) {
  Object.assign(environment, { os: 'macOS 26.1', arch: 'aarch64', cpuName: 'Apple M5 Pro', totalMemory: 48 * GB, availableMemory: 29.6 * GB, python: 'Python 3.12.15', gpus: mac === 'old' ? [] : ['Apple M5 Pro'] });
  if (mac !== 'old') environment.gpuDetails = [{ name: 'Apple M5 Pro', vendor: 'apple', cores: 20, unifiedMemory: true, memoryBytes: 48 * GB, gpuBudgetBytes: 36 * GB, gpuBudgetEstimated: false, metal: 4, source: 'system_profiler' }];
}
if (scenario === 'install') {
  state.store.onboardingV1 = progress({ runtimeTaskId: 'rt-1' });
  state.tasks = [{ id: 'rt-1', kind: 'install-runtime', state: 'running', message: '正在安装运行依赖（torch、gguf）', startedAt: now - 352000 }];
  state.runtime = { taskId: 'rt-1' };
  state.logs['rt-1'] = [log('下载 Strata 源码包 fb58e0d（12.4 MB），SHA-256 校验通过', 330000), log('下载 Python 3.13.16 安装器，sigstore 摘要校验通过', 290000), log('创建私有 Python 环境 .venv', 200000), log('pip install -r requirements.txt', 120000), log('Collecting torch==2.8.0', 60000), log('Downloading torch-2.8.0-cp313-cp313-win_amd64.whl (2.4 GB) 61%', 3000)];
}
if (scenario === 'model' || scenario === 'model-offline') { readyRuntime(); state.store.onboardingV1 = progress({ runtimeTaskId: 'rt-1' }); state.tasks = [{ id: 'rt-1', kind: 'install-runtime', state: 'completed', message: '运行环境已就绪', startedAt: now - 700000, finishedAt: now - 300000 }]; }
if (scenario === 'download' || scenario === 'overview') {
  readyRuntime();
  state.store.onboardingV1 = progress({ runtimeTaskId: 'rt-1', setupTaskId: 'setup-1', selection: { family: 'swift', quant: 'IQ3_S', context: 131072, images: false } });
  state.tasks = [{ id: 'rt-1', kind: 'install-runtime', state: 'completed', message: '运行环境已就绪', startedAt: now - 1700000, finishedAt: now - 1300000 },
    { id: 'setup-1', kind: 'setup', state: 'running', message: 'Swift 1.5 IQ3_S 下载中 31.2 / 83.6 GB', startedAt: now - 722000 }];
  state.handoffs = [{ taskId: 'setup-1', status: 'pending' }];
  state.logs['setup-1'] = [log('setup.py --model swift --quant IQ3_S --context 131072', 720000), log('镜像源：hf-mirror.com', 719000), log('swift-1.5-IQ3_S-00001-of-00004.gguf 已完成并校验', 300000), log('swift-1.5-IQ3_S-00002-of-00004.gguf 下载中 31.2 / 83.6 GB · 68 MB/s', 2000)];
}
if (scenario === 'start' || scenario === 'ready') {
  readyRuntime();
  state.profiles = [modelProfile];
  state.store.onboardingV1 = progress({ runtimeTaskId: 'rt-1', setupTaskId: 'setup-1', profileId: modelProfile.id, selection: { family: 'swift', quant: 'IQ3_S', context: 131072, images: false } });
  state.store.activeProfile = modelProfile.id;
  state.tasks = [{ id: 'setup-1', kind: 'setup', state: 'completed', message: '模型已准备完成', startedAt: now - 2400000, finishedAt: now - 60000 }];
  state.handoffs = [{ taskId: 'setup-1', status: 'registered', profileId: modelProfile.id }];
  state.logs[modelProfile.id] = [log('启动 Strata：python -m strata.server --config swift-1.5-iq3_s.json', 9000), log('CUDA 12.6 · NVIDIA GeForce RTX 4090 (24 GB)', 8000), log('本机 API 已就绪，正在加载模型', 5000), log('加载专家权重 18 / 48', 1000)];
  if (scenario === 'ready') { state.running[modelProfile.id] = true; state.loaded[modelProfile.id] = true; }
  if (scenario === 'start') state.holdStart = true;
}
if (scenario === 'connect' || scenario === 'connect-running') {
  state.store.onboardingV1 = progress({ path: 'connect' });
  state.candidates = [
    { id: 'c1', name: 'Qwen3.8-Flash-Next IQ3_XXS', installDir: 'D:\\AI\\Strata', pythonPath: 'D:\\AI\\Strata\\.venv\\Scripts\\python.exe', configPath: 'D:\\AI\\Strata\\configs\\qwen-iq3_xxs.json', modelPath: 'D:\\AI\\models\\qwen', modelBytes: 75.8e9, ...(scenario === 'connect-running' ? { running: true, detectedPort: 18081, pid: 4242 } : { running: false }), runtimeVersion: '0.1.42' },
    { id: 'c2', name: 'Swift 1.5 IQ2_XS', installDir: 'D:\\AI\\Strata', pythonPath: 'D:\\AI\\Strata\\.venv\\Scripts\\python.exe', configPath: 'D:\\AI\\Strata\\configs\\swift-iq2_xs.json', modelPath: 'D:\\AI\\models\\swift', modelBytes: 68e9, running: false, runtimeVersion: '0.1.42' },
  ];
}
if (scenario === 'skipped') { state.store.onboardingV1 = progress({ status: 'skipped', path: null }); }
if (scenario === 'settings') { readyRuntime(); state.profiles = [modelProfile]; state.store.activeProfile = modelProfile.id; state.store.onboardingV1 = progress({ status: 'completed' }); }
const calls = [];
const callbacks = new Map(); let callbackId = 0; const listeners = new Map(); let listenerId = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(_event, id) { listeners.delete(id); } };
window.__fixture = { calls, state };
const assessment = () => ({ status: 'suggested', sampledAt: Date.now(), estimate: true, sourceRevision: 'fixture',
  hardware: { sampledAt: Date.now(), totalMemoryBytes: environment.totalMemory, availableMemoryBytes: environment.availableMemory, gpus: [{ id: 0, vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090', totalBytes: 24 * GB, availableBytes: 22 * GB, source: 'nvml' }], cpuName: environment.cpuName, cpuIsa: 'avx512', wsl: false, managedServiceRunning: false },
  ram: { baselineBytes: 52 * GB, expertBytes: 34e9, longContextBytes: 4 * GB, mode: 'normal' }, kv: { streaming: false, streamingRamBytes: 0 }, slots: { count: 1, perSlotVramBytes: 3 * GB, totalVramBytes: 3 * GB }, recommendations: { context: 131072, parallel: 1 }, reasons: [], unknowns: [] });
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, convertFileSrc: path => path,
  transformCallback(callback) { const id = ++callbackId; callbacks.set(id, callback); return id; }, unregisterCallback(id) { callbacks.delete(id); },
  async invoke(command, args = {}) {
    calls.push({ command, args: structuredClone(args) });
    const profile = args.profile ?? state.profiles.find(item => item.id === args.profileId);
    // Hugging Face discovery (read-only allow-listed API): a synthetic community repo; ?hf=offline fails like no network.
    if (command === 'hf_models_api') {
      if (params.get('hf') === 'offline') throw 'Hugging Face 不可达';
      const repo = 'example-user/Qwen3.8-Flash-Next-GSQ-RCO-uncensored-GGUF', rev = 'f'.repeat(40);
      if (args.path.startsWith('/api/models?')) return JSON.stringify([{ id: repo, downloads: 812, likes: 9 }, { id: 'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF', downloads: 99999 }]);
      if (args.path === `/api/models/${repo}`) return JSON.stringify({ id: repo, sha: rev, downloads: 812, likes: 9, lastModified: '2026-10-12T08:00:00.000Z' });
      if (args.path.startsWith(`/api/models/${repo}/tree/${rev}`)) {
        const file = (quant, i, size) => ({ path: `${quant}/Qwen3.8-Flash-Next-GSQ-RCO-uncensored-${quant}-0000${i}-of-00002.gguf`, size, lfs: { oid: String(i).repeat(64), size } });
        return JSON.stringify([file('Q2_0', 1, 17.2e9), file('Q2_0', 2, 28.8e9), file('IQ3_XXS', 1, 26.1e9), file('IQ3_XXS', 2, 28.8e9)]);
      }
      throw 'not found';
    }
    if (command === 'store_get') return structuredClone(state.store[args.key] ?? null);
    if (command === 'store_set') { state.store[args.key] = structuredClone(args.value); return; }
    if (command === 'get_system_language') return { locales: ['zh-CN'] };
    if (command === 'local_installations') return structuredClone(state.profiles);
    if (command === 'local_installation_details') return state.profiles.map(item => ({ profileId: item.id, configModifiedAt: now - 60000 }));
    if (command === 'service_status') { const running = !!(profile && state.running[profile.id]); return { profileId: profile?.id ?? args.profileId, running, owned: running, pid: running ? 31337 : null, phase: running ? 'ready' : 'stopped', startedAt: running ? now - 30000 : undefined }; }
    if (command === 'switch_local_service' || command === 'ensure_local_service') { if (state.holdStart) return new Promise(() => {}); state.running[args.profileId] = true; state.loaded[args.profileId] = true; return; }
    if (command === 'strata_request') {
      if (args.path.startsWith('/health')) return { service: 'strata', status: 'ok', loaded: !!state.loaded[profile?.id], model: 'Swift-1.5-IQ3_S' };
      // Strata's macOS telemetry (serve/telemetry.py _Metal): IOAccelerator load and in-use memory, Metal working set as total.
      if (args.path.startsWith('/metrics') && mac && mac !== 'old') return { live: { state: 'idle' }, engine: { model: 'Swift-1.5-IQ3_S', max_context: 131072 }, hardware_static: { gpu_name: 'Apple M5 Pro', cores: 12, threads: 12 }, hardware: { ram_total: environment.totalMemory, ram_used: 31.2 * GB, gpu_mem_total: 36 * GB, gpu_mem_used: 21.4 * GB, gpu_util: 87, cpu: 14, gpus: [{ index: 0, util: 87, mem_used: 21.4 * GB, mem_total: 36 * GB }] }, requests: [] };
      if (args.path.startsWith('/metrics')) return { live: { state: 'idle' }, engine: { model: 'Swift-1.5-IQ3_S', max_context: 131072 }, hardware: { ram_total: environment.totalMemory, ram_used: 25 * GB, vram_total: 24 * GB, vram_used: 21.4 * GB, gpu_util: 3 }, requests: [] };
      if (args.path === '/load') { state.loaded[profile.id] = true; return { ok: true }; }
      if (args.path.startsWith('/v1/models')) return { data: [{ id: 'Swift-1.5-IQ3_S' }] };
      if (args.path.startsWith('/mcp')) return { servers: [] };
      return {};
    }
    if (command === 'supervisor_status') return { running: true, protocolVersion: 1, activeServices: Object.values(state.running).filter(Boolean).length, health: {} };
    if (command === 'list_tasks') return structuredClone(state.tasks);
    if (command === 'list_setup_handoffs') return structuredClone(state.handoffs);
    if (command === 'discover_local') return structuredClone(state.candidates);
    if (command === 'local_runtime_installation') return structuredClone(state.runtime);
    if (command === 'environment_info') return structuredClone(environment);
    if (command === 'read_logs') return structuredClone(state.logs[args.profile?.id] ?? []);
    if (command === 'prepare_local_runtime') { const task = { id: 'rt-new', kind: 'install-runtime', state: 'running', message: '正在下载 Strata 源码包', startedAt: Date.now() }; state.tasks.push(task); state.runtime = { taskId: task.id }; return structuredClone(task); }
    if (command === 'run_setup') { const task = { id: 'setup-new', kind: 'setup', state: 'running', message: '正在准备下载', startedAt: Date.now() }; state.tasks.push(task); state.handoffs.push({ taskId: task.id, status: 'pending' }); return structuredClone(task); }
    if (command === 'run_community_setup') { const task = { id: 'setup-community', kind: 'setup', state: 'running', message: '正在下载社区模型', startedAt: Date.now() }; state.tasks.push(task); state.handoffs.push({ taskId: task.id, status: 'pending' }); return structuredClone(task); }
    if (command === 'setup_disk_preflight') return { status: 'ready', dataDirectory: runtimeProfile.installDir, modelDirectory: `${runtimeProfile.installDir}\\models`, modelDownloadBytesEstimate: 83.6e9, reusableModelBytes: 0, additionalBytesEstimate: 90e9, estimate: true, volumes: [{ directory: runtimeProfile.installDir, mountPoint: 'D:\\', availableBytes: 405 * GB, requiredAdditionalBytesEstimate: 90e9 }], reason: '', source: 'fixture' };
    if (command === 'assess_setup_resources') return assessment();
    if (command === 'cancel_task') { const task = state.tasks.find(item => item.id === args.taskId); if (task) { task.state = 'cancelled'; task.finishedAt = Date.now(); } return; }
    if (command === 'connect_running_service') { const candidate = args.candidate; const connected = { ...modelProfile, id: 'connected-1', name: candidate.name, baseUrl: `http://127.0.0.1:${candidate.detectedPort}`, configPath: candidate.configPath, installDir: candidate.installDir }; state.profiles.push(connected); state.running[connected.id] = true; return { profileId: connected.id, restarting: false }; }
    if (command === 'import_local') { const candidate = args.candidate; const imported = { ...modelProfile, id: 'imported-1', name: candidate.name, configPath: candidate.configPath, installDir: candidate.installDir, pythonPath: candidate.pythonPath }; state.profiles.push(imported); return structuredClone(imported); }
    if (command === 'arena_get') {
      const mock = window.__arenaMock;
      if (!mock) throw 'arena_unreachable';
      if (args.path === 'groups') return structuredClone(mock.groups);
      if (args.path === 'leaderboard') {
        const median = mock.tiers[args.query?.group] ?? null;
        const rows = median == null ? [] : [{ rank: 1, hw: { gpu: 'RTX 4090', vramGB: 24, ramGB: 96 }, params: { ctx: 32768, kv: 'int8', parallel: 1 }, seed: false, machines: 9, confidence: 'medium', decode: { p25: median * 0.92, median, p75: median * 1.06 }, prefill: 820, ttftMs: 410, decode32k: median * 0.8, decode128k: null, peakRamGB: 61, peakVramGB: 21.5 }];
        return { group: args.query?.group ?? null, rows, tierMedian: median };
      }
      if (args.path === 'recommend') return { scene: args.query?.scene ?? 'chat', level: 'none', sameModel: null, otherModels: [] };
      throw 'arena_path_invalid';
    }
    if (command === 'arena_status') return { consented: false, consentVersion: null, autoUpload: false, queued: 0, log: [], endpoint: 'arena', uploadAvailable: false, registered: false, banned: false };
    if (command === 'arena_flush') return null;
    if (command === 'tuning_status') return null;
    if (command === 'has_api_key') return false;
    if (command === 'get_background_policy') return { mode: 'alwaysReady', autoRecover: false };
    if (command === 'get_startup_status') return { enabled: false, supported: true };
    if (command === 'list_local_models') return [];
    if (command === 'analytics_query') return { data: { http: {}, inference: {}, groups: [], buckets: [] }, coverage: { gaps: [], sessions: [], observerStatuses: [], collectionScope: [] } };
    if (command === 'request_capture_status') return { state: 'disabled', expiresAtMs: null, reason: null };
    if (command === 'runtime_update_info') return null;
    if (command === 'plugin:event|listen') { const id = ++listenerId; listeners.set(id, { event: args.event, handler: args.handler }); return id; }
    if (command === 'plugin:dialog|open') return window.__fixture.dialogPaths?.shift() ?? null;
    if (command.startsWith('plugin:') || ['apply_settings', 'confirm_window_close'].includes(command)) return null;
    window.__fixture.unmocked = [...(window.__fixture.unmocked ?? []), command];
    return null;
  },
};
