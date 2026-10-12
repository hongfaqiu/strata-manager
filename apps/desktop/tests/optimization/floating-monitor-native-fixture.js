// Dedicated monitor IO is entirely synthetic and never touches the supervisor.
(() => {
  const params = new URLSearchParams(location.search), fixture = window.__fixture;
  const originalInvoke = window.__TAURI_INTERNALS__.invoke;
  fixture.store.settings = { ...fixture.store.settings, language: params.get('language') || 'zh-CN', theme: params.get('theme') || 'light', pollInterval: 1000, floatingMonitor: { actions: [], alwaysOnTop: true, showSampleTime: false, showInTray: false } };
  const control = { state: params.get('state') || 'generating', phase: params.has('stopped') ? 'stopped' : params.has('unavailable') ? 'unavailable' : 'online', loaded: !params.has('unloaded'), queued: params.has('queued') ? 2 : 0, stale: false, fail: false, holdSnapshot: false, heldSnapshots: 0, reads: 0, pinned: true, closed: false, shownMain: 0, destinations: [], opened: 0, menus: [], popups: [] };
  fixture.monitor = control;
  const pendingSnapshots = [];
  control.releaseSnapshot = () => { control.holdSnapshot = false; for (const release of pendingSnapshots.splice(0)) release(); };
  window.__TAURI_INTERNALS__.metadata.currentWindow.label = 'service-monitor';
  window.__TAURI_INTERNALS__.metadata.currentWebview.label = 'service-monitor';
  const record = (command, args) => fixture.calls.push({ command, args: structuredClone(args) });
  let menuId = 8000;
  const menus = new Map();
  fixture.copied = [];
  const clipboard = navigator.clipboard || {};
  Object.defineProperty(clipboard, 'writeText', { configurable: true, value: async value => { fixture.copied.push(value); } });
  if (!navigator.clipboard) Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
  fixture.selectMenu = id => {
    const popup = control.popups.at(-1), menu = popup && menus.get(popup.rid);
    const item = menu?.items.find(item => item.id === id);
    if (!item || item.enabled === false || !item.handler) throw Error(`Unavailable synthetic menu item: ${id}`);
    fixture.deliverChannel(item.handler, id);
  };
  fixture.emitPreferences = preferences => {
    fixture.store.settings = { ...fixture.store.settings, floatingMonitor: structuredClone(preferences) };
    fixture.emitEvent('monitor-preferences-changed', fixture.store.settings);
  };
  window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
    if (command === 'monitor_snapshot') {
      record(command, args); control.reads++;
      if (control.fail) throw Error('Fixture snapshot failure');
      if (control.holdSnapshot) await new Promise(resolve => { control.heldSnapshots++; pendingSnapshots.push(resolve); });
      return {
        settings: structuredClone(fixture.store.settings),
        profile: fixture.profiles[0],
        process: { profileId: 'a', running: control.phase !== 'stopped', owned: true, pid: control.phase === 'stopped' ? null : 99999, phase: control.phase === 'stopped' ? 'stopped' : 'ready' },
        phase: control.phase,
        health: { service: 'strata', status: 'ok', loaded: control.loaded },
        metrics: control.phase === 'unavailable' ? undefined : { engine: { model: 'Fixture A' }, live: { state: control.state, tok_s: 60, prefill_tok_s_mean: 1200, running: control.state === 'idle' ? 0 : 1, queued: control.queued }, hardware: { gpu_util: 35, cpu: 12, gpu_temp: 50, gpu_power: 140 }, requests: control.state === 'idle' ? [{ decode_tok_s: 33 }] : [] },
        error: control.phase === 'unavailable' ? 'Fixture metrics unavailable' : undefined,
        sampledAt: Date.now() - (control.stale ? 60000 : 0),
      };
    }
    if (command === 'plugin:window|is_always_on_top') { record(command, args); return control.pinned; }
    if (command === 'plugin:window|set_always_on_top') { record(command, args); control.pinned = args.value; return; }
    if (command === 'plugin:window|set_size') { record(command, args); control.size = structuredClone(args.value?.size || args.value?.Logical || args.value); return; }
    if (command === 'plugin:window|start_dragging') { record(command, args); control.drags = (control.drags || 0) + 1; return; }
    if (command === 'minimize_monitor_to_tray') { record(command, args); control.trayMinimized = (control.trayMinimized || 0) + 1; return; }
    if (command === 'plugin:window|close') { record(command, args); control.closed = true; return; }
    if (command === 'show_main_from_monitor') { record(command, args); control.shownMain++; control.destinations.push(args.destination ?? null); return; }
    if (command === 'open_monitor_window') { record(command, args); control.opened++; return; }
    if (command === 'plugin:menu|new') {
      record(command, args);
      const rid = ++menuId, id = args.options?.id || `fixture-monitor-menu-${rid}`;
      const menu = { rid, id, items: args.options?.items || [], handler: args.handler };
      menus.set(rid, menu);
      control.menus.push({ rid, id, items: structuredClone(menu.items) });
      return [rid, id];
    }
    if (command === 'plugin:menu|popup') { record(command, args); if (!menus.has(args.rid)) throw Error('Synthetic menu popup requires an existing menu'); control.popups.push(structuredClone(args)); return; }
    return originalInvoke(command, args);
  };
})();
