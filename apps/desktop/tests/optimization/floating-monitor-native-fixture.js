// Dedicated monitor IO is entirely synthetic and never touches the supervisor.
(() => {
  const params = new URLSearchParams(location.search), fixture = window.__fixture;
  const originalInvoke = window.__TAURI_INTERNALS__.invoke;
  const control = { state: params.get('state') || 'generating', phase: params.has('stopped') ? 'stopped' : params.has('unavailable') ? 'unavailable' : 'online', loaded: !params.has('unloaded'), stale: false, fail: false, reads: 0, pinned: true, closed: false, shownMain: 0, opened: 0 };
  fixture.monitor = control;
  window.__TAURI_INTERNALS__.metadata.currentWindow.label = 'monitor';
  window.__TAURI_INTERNALS__.metadata.currentWebview.label = 'monitor';
  const record = (command, args) => fixture.calls.push({ command, args: structuredClone(args) });
  window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
    if (command === 'monitor_snapshot') {
      record(command, args); control.reads++;
      if (control.fail) throw Error('Fixture snapshot failure');
      return {
        settings: { language: params.get('language') || 'zh-CN', theme: params.get('theme') || 'light', pollInterval: 1000 },
        profile: fixture.profiles[0],
        process: { profileId: 'a', running: control.phase !== 'stopped', owned: true, pid: control.phase === 'stopped' ? null : 99999, phase: control.phase === 'stopped' ? 'stopped' : 'ready' },
        phase: control.phase,
        health: { service: 'strata', status: 'ok', loaded: control.loaded },
        metrics: control.phase === 'unavailable' ? undefined : { engine: { model: 'Fixture A' }, live: { state: control.state, tok_s: 60, prefill_tok_s_mean: 1200, running: control.state === 'idle' ? 0 : 1, queued: 2 }, hardware: { gpu_util: 35, cpu: 12, gpu_temp: 50, gpu_power: 140 }, requests: control.state === 'idle' ? [{ decode_tok_s: 33 }] : [] },
        error: control.phase === 'unavailable' ? 'Fixture metrics unavailable' : undefined,
        sampledAt: Date.now() - (control.stale ? 60000 : 0),
      };
    }
    if (command === 'plugin:window|is_always_on_top') { record(command, args); return control.pinned; }
    if (command === 'plugin:window|set_always_on_top') { record(command, args); control.pinned = args.value; return; }
    if (command === 'plugin:window|close') { record(command, args); control.closed = true; return; }
    if (command === 'show_main_from_monitor') { record(command, args); control.shownMain++; return; }
    if (command === 'open_monitor_window') { record(command, args); control.opened++; return; }
    return originalInvoke(command, args);
  };
})();
