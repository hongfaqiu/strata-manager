// Full App integration, synthetic state only. Never discovers or modifies a real service.
(() => {
  const fixture = window.__fixture, original = window.__TAURI_INTERNALS__.invoke;
  const mode = new URLSearchParams(location.search).get('mode') || 'owned';
  const candidate = { id: 'fixture-observed', name: 'Detected running fixture', installDir: 'D:\\Fixture\\Strata', pythonPath: 'D:\\Fixture\\Strata\\python.exe', configPath: 'C:\\Fixture\\OtherManager\\imports\\fixture-actual\\config.json', modelPath: 'D:\\Fixture\\Models\\running.gguf', modelBytes: 123456, detectedPort: 19091, running: true, pid: 99091, availability: 'ready', runtimeVersion: '0.1.43.1', config: { model_name: 'fixture-running-model', args: ['--model', 'D:\\Fixture\\Models\\running.gguf'], port: 19091 } };
  const stopped = { id: 'fixture-stopped', name: 'Previously selected stopped fixture', installDir: 'D:\\Fixture\\Strata', pythonPath: 'D:\\Fixture\\Strata\\python.exe', configPath: 'C:\\Fixture\\Manager\\imports\\fixture-stopped\\config.json', baseUrl: 'http://127.0.0.1:19090', managed: true };
  const actual = { ...stopped, id: 'fixture-actual', name: candidate.name, configPath: candidate.configPath, baseUrl: 'http://127.0.0.1:19091' };
  fixture.profiles.splice(0, fixture.profiles.length, stopped);
  fixture.configs[stopped.id] = { model_name: stopped.name, args: ['--model', 'D:\\Fixture\\Models\\stopped.gguf'], port: 19090 };
  fixture.configs[actual.id] = candidate.config;
  Object.assign(fixture.store, { activeProfile: stopped.id, conversations: [], activeConversationIds: {} });
  fixture.store.settings.autoCheckUpdates = false;
  fixture.store.settings.pollInterval = 60000;
  fixture.supervisor = { activeServices: 0, activeLocalInstallation: stopped.id, localServiceDesired: false, health: {} };
  fixture.autoRunning = { mode, candidate, actual, connected: false, connectCalls: 0, forbidden: [] };
  window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
    const record = () => fixture.calls.push({ command, args: structuredClone(args) });
    if (command === 'discover_local') { record(); return [structuredClone(candidate)]; }
    if (command === 'service_status') {
      record();
      const profileId = args.profileId ?? args.profile?.id;
      const running = fixture.autoRunning.connected && profileId === actual.id;
      return { profileId, running, owned: running, phase: running ? 'ready' : 'stopped', pid: running ? candidate.pid : null, startedAt: running ? 1 : null };
    }
    if (command === 'connect_running_service') {
      record(); fixture.autoRunning.connectCalls++;
      await new Promise(resolve => setTimeout(resolve, 120));
      if (mode === 'unverified') throw JSON.stringify({ code: 'RUNNING_OWNER_UNVERIFIED', message: '隔离夹具：无法核验管理后台身份' });
      if (mode === 'unloaded') throw JSON.stringify({ code: 'RUNNING_OWNER_NOT_FOUND', message: '隔离夹具：普通外部实例没有已知后台' });
      fixture.autoRunning.connected = true;
      fixture.profiles.splice(0, fixture.profiles.length, stopped, actual);
      fixture.supervisor = { activeServices: 1, activeLocalInstallation: actual.id, localServiceDesired: true, health: { [actual.id]: { phase: 'healthy', apiHealthy: true, loaded: true, pid: candidate.pid, observerState: 'idle', activeRequests: 0, checkedAt: Date.now() } } };
      return { profileId: actual.id, restarting: false };
    }
    if (/^(import_local|switch_local_service|ensure_local_service|start_service|restart_service|stop_service|take_over_service|run_setup|prepare_local_runtime)$/.test(command)
      || command === 'strata_request' && args.method && args.method !== 'GET') {
      record(); fixture.autoRunning.forbidden.push(command);
      throw Error(`Forbidden automatic-running fixture mutation: ${command}`);
    }
    if (command === 'strata_request') {
      record();
      if (args.path === '/health') return { service: 'strata', status: 'ok', loaded: mode !== 'unloaded', model: 'fixture-running-model', max_context: 8192 };
      if (args.path.startsWith('/metrics')) return { engine: { model: 'fixture-running-model', version: '0.1.43.1', max_context: 8192 }, hardware: {}, live: { state: 'idle', running: 0, queued: 0 }, requests: [] };
      if (args.path === '/v1/status') return { service: 'strata', loaded: mode !== 'unloaded', dialects: ['/v1/chat/completions'] };
      if (args.path === '/config') return { keys: [] };
      return {};
    }
    if (command === 'local_runtime_installation') {
      record(); return { detectedRuntimes: [{ installDir: candidate.installDir, pythonPath: candidate.pythonPath, readiness: 'ready', runtimeVersion: '0.1.43.1', profile: stopped }] };
    }
    return original(command, args);
  };
})();
