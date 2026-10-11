// Controlled telemetry for the real React App. All IO stays in memory.
(() => {
  const params = new URLSearchParams(location.search), fixture = window.__fixture;
  const originalInvoke = window.__TAURI_INTERNALS__.invoke;
  const control = { activeProfile: 'a', state: params.get('state') || 'generating', sequence: 0, instance: 0, holdMetrics: false, heldReads: 0, allowStop: params.has('allow-stop'), stopFailure: params.has('stop-fail'), stoppedResponse: params.has('stop-still-running'), missing: params.has('missing'), failMetrics: false, reads: { a: 0, b: 0 }, stopped: params.has('stopped'), unloaded: params.has('unloaded') };
  fixture.telemetry = control;
  fixture.store.settings.pollInterval = 60000;
  const record = (command, args) => fixture.calls.push({ command, args: structuredClone(args) });
  window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
    const id = args.profileId || args.profile?.id || control.activeProfile;
    const running = id === control.activeProfile && !control.stopped;
    const pid = (id === 'a' ? 99999 : 99998) + control.instance * 100;
    const creationTime = `fixture-instance-${control.instance}`;
    if (command === 'open_monitor_window') { record(command, args); fixture.openedMonitors = (fixture.openedMonitors || 0) + 1; return; }
    if (command === 'stop_service' && control.allowStop) {
      record(command, args);
      if (control.stopFailure) throw Error('停止服务失败：fixture 进程未退出，请重试。');
      if (control.stoppedResponse) return { profileId: id, running: true, owned: true, pid, creationTime, phase: 'ready' };
      control.stopped = true;
      return { profileId: id, running: false, owned: false, pid: null, phase: 'stopped' };
    }
    if (command === 'service_status') {
      record(command, args);
      return { profileId: id, running, owned: running, pid: running ? pid : null, creationTime: running ? creationTime : undefined, phase: running ? 'ready' : 'stopped' };
    }
    if (command === 'supervisor_status') {
      record(command, args);
      const selected = control.activeProfile;
      return { running: true, pid: 99000, protocolVersion: 1, activeServices: control.stopped ? 0 : 1, activeLocalInstallation: selected, version: 'fixture', health: control.stopped ? {} : { [selected]: { phase: 'healthy', apiHealthy: true, loaded: !control.unloaded, activeRequests: control.state === 'idle' ? 0 : 1, pid, checkedAt: Date.now(), observerState: control.state === 'reading' ? 'reading' : control.state === 'idle' ? 'idle' : 'generating', failures: [] } } };
    }
    if (command === 'strata_request' && args.path === '/health') {
      record(command, args);
      return { service: 'strata', status: 'ok', loaded: !control.stopped && !control.unloaded, model: `Fixture ${id.toUpperCase()}`, max_context: 8192 };
    }
    if (command === 'strata_request' && args.path.startsWith('/metrics')) {
      record(command, args);
      control.reads[id] = (control.reads[id] || 0) + 1;
      if (control.holdMetrics) await new Promise(resolve => { control.heldReads++; control.releaseMetrics = () => { control.holdMetrics = false; resolve(); }; });
      if (control.failMetrics) throw Error('Isolated telemetry collection failure');
      const state = control.unloaded ? 'unloaded' : control.state;
      if (control.missing) return { engine: { model: `Fixture ${id.toUpperCase()}` }, live: { state } };
      const offset = id === 'a' ? 0 : 200, value = 10 + control.sequence * 5 + offset;
      return {
        engine: { version: 'fixture', model: `Fixture ${id.toUpperCase()}`, max_context: 8192 },
        live: { state, tok_s: value, prefill_tok_s_mean: value * 20, prompt_read: 512, prompt_total: 1024, prompt_tokens: 1024, generated: 8, running: state === 'idle' || state === 'unloaded' ? 0 : 1, queued: state === 'idle' ? 0 : 2 },
        hardware: { gpu_util: 30 + control.sequence, gpu_mem_used: 8 * 1024 ** 3, gpu_mem_total: 32 * 1024 ** 3, gpu_temp: 48, gpu_power: 145, ram_used: 16 * 1024 ** 3, ram_total: 64 * 1024 ** 3, cpu: 12 },
        requests: state === 'idle' ? [{ decode_tok_s: value, prompt_tokens: 1024, reused: 512, prompt_ms: 400, hit_rate: 0.5 }] : [],
      };
    }
    return originalInvoke(command, args);
  };
})();
