// Strata update progress fixture. Wraps the first-run fixture (state=settings: runtime ready,
// onboarding completed) and replays backend update-task messages for ?update=<scenario>.
// All native IO stays synthetic; no download, file write or service lifecycle happens.
(() => {
  const params = new URLSearchParams(location.search);
  const scenario = params.get('update') || 'downloading';
  const base = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
  const MiB = 1024 * 1024, total = 137300495, started = Date.now() - ({ downloading: 14500, unknown: 14500, retry: 17000, source: 2000 }[scenario] ?? 64000);
  const asset = 'strata-windows-x64-cuda12.zip';
  const settings = window.__fixture.state.store.settings;
  settings.autoCheckUpdates = true;
  if (params.get('lang')) { settings.language = params.get('lang'); settings.languagePreference = params.get('lang'); }
  if (params.get('theme')) settings.theme = params.get('theme');
  const runtime = window.__fixture.state.runtime.detectedRuntimes[0];
  runtime.runtimeVersion = '0.1.43';
  const release = {
    supportedVersion: '0.1.44', latestVersion: '0.1.44', releaseName: 'Strata 0.1.44', checkedAt: Date.now() - 60000, installable: true,
    sourceRevision: 'b'.repeat(40), notes: '## 更新\n\n- 改善下载体验。', releaseUrl: 'https://github.com/Niko1221/Strata/releases/tag/v0.1.44', publishedAt: '2026-10-15T08:00:00Z',
    assets: [{ name: asset, variant: 'cuda12', size: total, sha256: '2'.repeat(64), url: `https://github.com/Niko1221/Strata/releases/download/v0.1.44/${asset}` }],
  };
  const task = { id: 'runtime-update-1', kind: 'update', state: 'running', message: '', startedAt: started };
  const logs = [];
  const log = (message, at, level = 'info') => logs.push({ timestamp: at, level, message });
  const head = () => {
    // "unknown" simulates a mirror that declares no length and a manifest without a size.
    const size = scenario === 'unknown' ? '' : `（${total}字节）`;
    log(`正在下载官方Release v0.1.44：${asset}${size}及同提交源码`, started);
    log('官方同版本源码已下载 1835008 字节', started + 1500);
    log('官方同版本源码已下载 4718592 字节', started + 2600);
    log('正在安全解包同版本源码并核验统计观察器兼容性', started + 3400);
    log(`源码兼容检查通过；正在下载官方${asset}${size}，完成后核验官方SHA256`, started + 5200);
  };
  // Download rate wobbles around ~7.6 MiB/s so smoothing has something to do.
  const rate = second => (7.6 + Math.sin(second / 3) * 1.4) * MiB;
  let received = 0, last = started + 5200;
  const downloadUntil = (until, known = true) => {
    for (let at = last + 1000; at <= until && received < total; at += 1000) {
      received = Math.min(total, received + Math.round(rate((at - started) / 1000)));
      log(known ? `下载进度：${received} / ${total} 字节` : `下载进度：${received} 字节 / 总量未知`, at); last = at;
    }
  };
  const after = [
    ['SHA256 校验通过，共 137300495 字节'],
    ['官方引擎SHA256和精确长度通过；正在安全解包运行文件'],
    ['正在验证Python依赖及新版服务源码语法'],
    ['同版本源码、引擎和原文件备份已准备；配置及模型文件保持原位'],
    ['正在等待受管服务请求完成；准备停止本应用拥有的服务'],
    ['源码与引擎已同步替换；正在恢复原受管服务状态'],
  ];
  const finishDownload = () => { downloadUntil(Infinity); };
  const through = count => { let at = last; for (const [message] of after.slice(0, count)) { at += 2200; log(message, at); } last = at; };
  head();
  const now = Date.now();
  if (scenario === 'source') { logs.splice(4); }
  else if (scenario === 'downloading') downloadUntil(now - 400);
  else if (scenario === 'unknown') { downloadUntil(now - 400, false); }
  else if (scenario === 'retry') { downloadUntil(now - 6000); log(`下载重试 2/4：下载中断: connection reset；已保存 ${received} 字节`, now - 5000, 'warn'); last = now - 4000; downloadUntil(now - 400); }
  else if (scenario === 'extracting') { finishDownload(); through(2); }
  else if (scenario === 'verifying') { finishDownload(); through(3); }
  else if (scenario === 'applying') { finishDownload(); through(5); }
  else if (scenario === 'restoring' || scenario === 'done') { finishDownload(); through(6); }
  else if (scenario === 'failed' || scenario === 'rolledback') { finishDownload(); through(5); log('更新未完成，正在恢复原程序文件和受管服务', last + 1800, 'warn'); if (scenario === 'rolledback') log('原程序文件已恢复，模型与配置保持原位；更新可重试', last + 4200); }
  else if (scenario === 'cancelled') { downloadUntil(started + 14000); }
  task.message = logs.at(-1).message;
  const finishAt = { done: 1200, failed: 1200, rolledback: 1200, cancelled: 1200 }[scenario];
  if (finishAt) setTimeout(() => {
    task.finishedAt = Date.now();
    if (scenario === 'done') { task.state = 'completed'; task.message = 'Strata已更新至官方Release v0.1.44；模型、配置及会话已保留'; log(task.message, Date.now()); runtime.runtimeVersion = '0.1.44'; }
    else if (scenario === 'cancelled') { task.state = 'cancelled'; task.message = '更新已取消，原服务保持运行'; log(task.message, Date.now(), 'warn'); }
    else { task.state = 'failed'; task.message = '新版服务健康检查超时（45 秒）；已恢复原程序版本'; log(task.message, Date.now(), 'error'); }
  }, finishAt);
  // Live scenarios keep advancing, like the backend's once-per-second progress message.
  if (['downloading', 'unknown', 'retry'].includes(scenario) && !params.has('frozen')) setInterval(() => { downloadUntil(Date.now(), scenario !== 'unknown'); task.message = logs.at(-1).message; }, 1000);
  window.__fixture.update = { task, logs, release };
  window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
    if (command === 'list_tasks') return structuredClone([task]);
    if (command === 'read_logs' && args.profile?.id === task.id) return structuredClone(logs.slice(-(args.limit ?? 200)));
    if (command === 'runtime_update_info') return structuredClone(release);
    if (command === 'resolve_runtime_zip_asset') return structuredClone(release.assets[0]);
    if (command === 'cancel_task') { task.state = 'cancelled'; task.finishedAt = Date.now(); task.message = '更新已取消，原服务保持运行'; return; }
    return base(command, args);
  };
})();
