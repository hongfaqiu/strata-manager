// Storage-location fixture layered over another native fixture. All paths and sizes are synthetic;
// nothing is copied or moved. Without ?state= (the first-run guide's scenario) it also supplies an installed engine. ?storage=moving shows a move in progress; ?storage=custom a custom engine root.
(() => {
  const params = new URLSearchParams(location.search), mode = params.get('storage') || 'default';
  const GB = 1e9, previous = window.__TAURI_INTERNALS__.invoke;
  const appData = 'C:\\Users\\fixture\\AppData\\Roaming\\io.strata.manager';
  const state = {
    model: { path: `${appData}\\runtimes\\release-3f2a\\Strata-data`, source: 'default', availableBytes: 38.6 * GB, mountPoint: 'C:\\', usedBytes: 82.4 * GB },
    engine: { path: `${appData}\\runtimes`, source: 'default', availableBytes: 38.6 * GB, mountPoint: 'C:\\' },
    currentEngine: { path: `${appData}\\runtimes\\release-3f2a\\Strata`, source: 'current', availableBytes: 38.6 * GB, mountPoint: 'C:\\', usedBytes: 0.94 * GB },
    movingTaskId: undefined,
  };
  const volumes = { 'C:': 38.6 * GB, 'D:': 812.3 * GB, 'E:': 41.2 * GB };
  const probe = path => { const drive = /^[a-z]:/i.test(path) ? path.slice(0, 2).toUpperCase() : 'C:'; return { path, source: 'probe', availableBytes: volumes[drive] ?? 100 * GB, mountPoint: `${drive}\\` }; };
  const moveTask = { id: 'move-1', kind: 'move-model-data', state: 'running', message: '正在复制模型文件 / Copying model files：47.8 GiB / 76.7 GiB（62%）· 412 MiB/s', startedAt: Date.now() - 118000 };
  if (mode === 'custom') Object.assign(state.engine, { path: 'D:\\Strata\\runtimes', source: 'custom', availableBytes: 812.3 * GB, mountPoint: 'D:\\' });
  if (mode === 'moving') state.movingTaskId = moveTask.id;
  if (mode === 'moved') Object.assign(state.model, { path: 'D:\\Strata-data', source: 'remembered', availableBytes: 729.9 * GB, mountPoint: 'D:\\' });
  window.__storageFixture = state;
  window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
    if (command === 'storage_locations') return structuredClone({ ...state, ...(args.probePath ? { probe: probe(args.probePath) } : {}) });
    if (command === 'set_engine_install_root') { Object.assign(state.engine, args.directory ? { ...probe(`${args.directory}\\runtimes`), source: 'custom' } : { path: `${appData}\\runtimes`, source: 'default', availableBytes: 38.6 * GB, mountPoint: 'C:\\' }); return structuredClone(state.engine); }
    if (command === 'set_model_data_directory') { if (args.moveFiles) { state.movingTaskId = moveTask.id; return { directory: args.directory, moving: true, taskId: moveTask.id }; } Object.assign(state.model, { ...probe(args.directory), source: 'remembered', usedBytes: 0 }); return { directory: args.directory, moving: false }; }
    if (command === 'plugin:dialog|open' && params.get('pick')) return params.get('pick');
    if (command === 'local_runtime_installation' && !params.has('state')) { const installDir = state.currentEngine.path; return { detectedRuntimes: [{ installDir, pythonPath: `${installDir}\\.venv\\Scripts\\python.exe`, runtimeVersion: '0.2.1', sourceRevision: 'v0.2.1', readiness: 'ready', profile: { id: 'runtime-1', name: 'Strata', baseUrl: 'http://127.0.0.1:8080', installDir, pythonPath: `${installDir}\\.venv\\Scripts\\python.exe`, configPath: '', managed: true } }] }; }
    if (command === 'environment_info' && !params.has('state')) return { os: 'Windows 11 Pro 24H2', arch: 'x86_64', cpuName: 'AMD Ryzen 9 7950X', totalMemory: 96 * 2 ** 30, availableMemory: 71 * 2 ** 30, gpus: ['NVIDIA GeForce RTX 4090, 560.94, 24564 MiB'], python: null, git: null, appVersion: '0.2.10' };
    if (command === 'list_tasks') { const tasks = await previous(command, args); return state.movingTaskId ? [...(tasks ?? []), structuredClone(moveTask)] : tasks; }
    return previous(command, args);
  };
})();
