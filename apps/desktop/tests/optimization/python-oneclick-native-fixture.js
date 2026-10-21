// One-click Python fixture layered over onboarding-native-fixture.js. A Mac whose system Python is 3.9.6.
// ?python=idle|running|done|failed picks the managed-Python state; ?page=runtime-failed shows the failed
// runtime install in the guide, ?page=strata-failed the same failure on the Strata page. All IO is synthetic.
(() => {
  const params = new URLSearchParams(location.search), mode = params.get('python') || 'idle', page = params.get('page');
  const { state } = window.__fixture, previous = window.__TAURI_INTERNALS__.invoke, now = Date.now();
  const interpreter = '/Users/fixture/Library/Application Support/io.strata.manager/toolchains/python-3.12.15-pbs20261009/python/bin/python3';
  const missing = '本机缺少 Python 3.10+（含 venv/ensurepip）。可一键安装应用内 Python 3.12.15，完成后重试。';
  const python = { supported: true, version: '3.12.15', downloadBytes: 25165569, installed: mode === 'done', ...(mode === 'done' ? { interpreter } : {}) };
  const task = state => ({ id: 'py-1', kind: 'install-python', state, startedAt: now - 21000, ...(state === 'running' ? {} : { finishedAt: now - 2000 }) });
  if (mode === 'running') python.task = { ...task('running'), message: '下载进度：15.1 MiB / 24.0 MiB（62%）· 3.4 MiB/s' };
  if (mode === 'done') python.task = { ...task('completed'), message: `Python 3.12.15 已安装到应用目录，Strata 会自动使用它 / Python 3.12.15 is installed for this app: ${interpreter}` };
  if (mode === 'failed') python.task = { ...task('failed'), message: '下载中断: error sending request for url (https://github.com/astral-sh/python-build-standalone/releases/download/20261009/…)' };
  const environment = { os: 'macOS 15.5 Sequoia', arch: 'aarch64', cpuName: 'Apple M4 Max', totalMemory: 128 * 2 ** 30, availableMemory: 92 * 2 ** 30, gpus: [], python: 'Python 3.9.6', git: 'git version 2.39.5 (Apple Git-154)', appVersion: '0.2.10' };
  const failedRuntime = { id: 'rt-mac', kind: 'install-runtime', state: 'failed', message: missing, startedAt: now - 64000, finishedAt: now - 60000 };
  if (page === 'runtime-failed' || page === 'strata-failed') {
    state.tasks.push(failedRuntime);
    state.runtime = { taskId: failedRuntime.id };
    state.logs[failedRuntime.id] = [{ timestamp: now - 63000, level: 'info', message: '正在检测 64 位 Python 3.10+、venv 与 ensurepip' }, { timestamp: now - 60000, level: 'failed', message: missing }];
  }
  if (page === 'runtime-failed') state.store.onboardingV1 = { schemaVersion: 1, status: 'active', path: 'install', scene: 'chat', autoStart: false, startedAt: now - 900000, updatedAt: now - 1000, environmentAccepted: true, runtimeTaskId: failedRuntime.id };
  if (page === 'strata-failed') state.store.onboardingV1 = { schemaVersion: 1, status: 'skipped', path: null, startedAt: now - 900000, updatedAt: now - 1000 };
  let tick;
  const simulate = () => {
    const steps = ['正在下载 Python 3.12.15（python-build-standalone 20261009，24.0 MiB）', '下载进度：6.2 MiB / 24.0 MiB（25%）· 3.1 MiB/s', '下载进度：15.1 MiB / 24.0 MiB（62%）· 3.4 MiB/s', '下载进度：24.0 MiB / 24.0 MiB（100%）', 'SHA-256 校验通过，正在解包到应用目录', '正在检查 Python 版本、venv 与 ensurepip'];
    let index = 0;
    python.task = { ...task('running'), startedAt: Date.now(), message: steps[0] };
    clearInterval(tick);
    tick = setInterval(() => {
      if (python.task.state !== 'running') return clearInterval(tick);
      index += 1;
      if (index < steps.length) { python.task.message = steps[index]; return; }
      clearInterval(tick);
      Object.assign(python, { installed: true, interpreter });
      python.task = { ...python.task, state: 'completed', finishedAt: Date.now(), message: `Python 3.12.15 已安装到应用目录，Strata 会自动使用它 / Python 3.12.15 is installed for this app: ${interpreter}` };
    }, Number(params.get('step') || 700));
  };
  window.__pythonFixture = python;
  window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
    if (command === 'environment_info') return structuredClone(python.installed ? { ...environment, python: 'Python 3.12.15', pythonManaged: true } : environment);
    if (command === 'managed_python_status') return structuredClone(python);
    if (command === 'install_managed_python') { window.__fixture.calls.push({ command, args: structuredClone(args) }); simulate(); return structuredClone(python.task); }
    if (command === 'cancel_task' && args.taskId === python.task?.id) { python.task = { ...python.task, state: 'cancelled', finishedAt: Date.now(), message: '已取消安装 Python / Python installation cancelled' }; return; }
    return previous(command, args);
  };
})();
