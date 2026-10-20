// Dedicated monitor IO is entirely synthetic and never touches the supervisor.
(() => {
  const params = new URLSearchParams(location.search), fixture = window.__fixture;
  const originalInvoke = window.__TAURI_INTERNALS__.invoke;
  fixture.store.settings = { ...fixture.store.settings, language: params.get('language') || 'zh-CN', theme: params.get('theme') || 'light', pollInterval: 1000, floatingMonitor: { actions: [], alwaysOnTop: true, showSampleTime: false, layout: params.get('layout') || 'twoRow', fontSize: Number(params.get('fontSize') || 16), showGraphs: !params.has('noGraphs'), showLabels: !params.has('noLabels'), showStatus: params.has('showStatus'), snapToEdge: false, ...(params.has('floating-settings') ? fixture.store.settings.floatingMonitor : {}) } };
  const control = { visible: params.get('window') === 'monitor' || params.has('visible'), state: params.get('state') || 'generating', phase: params.has('stopped') ? 'stopped' : params.has('unavailable') ? 'unavailable' : 'online', loaded: !params.has('unloaded'), queued: params.has('queued') ? 2 : 0, stale: params.has('stale'), fail: params.has('failed'), holdSnapshot: false, heldSnapshots: 0, reads: 0, pinned: true, closed: false, shownMain: 0, destinations: [], opened: 0, menus: [], popups: [] };
  fixture.monitor = control;
  if (params.has('dock-close')) {
    setTimeout(() => fixture.emitEvent('monitor-mode-status', { mode: 'taskbar', active: true, supported: true }), 600);
    setTimeout(() => fixture.emitEvent('monitor-mode-status', { mode: 'floating', active: false, supported: true }), 1200);
  }
  const pendingSnapshots = [];
  control.releaseSnapshot = () => { control.holdSnapshot = false; for (const release of pendingSnapshots.splice(0)) release(); };
  if (params.get('window') === 'monitor') window.__TAURI_INTERNALS__.metadata.currentWindow.label = 'service-monitor';
  if (params.get('window') === 'monitor') window.__TAURI_INTERNALS__.metadata.currentWebview.label = 'service-monitor';
  const record = (command, args) => { fixture.calls.push({ command, args: structuredClone(args) }); document.documentElement.dataset.monitorEvidence = JSON.stringify({ calls: fixture.calls.reduce((counts, call) => ({ ...counts, [call.command]: (counts[call.command] || 0) + 1 }), {}), mode: control.mode || 'floating', visible: control.visible, size: control.size }); };
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
    if (command === 'resize_monitor_window') { control.size = { width: args.width, height: args.height }; record(command, args); return control.size; }
    if (command === 'set_monitor_visibility') {
      if (params.has('visibilityFail')) throw Error('Synthetic visibility failure');
      control.visible = args.visible;
      if (args.visible) control.mode = params.has('taskbarFail') ? 'floating' : args.mode;
      else fixture.emitEvent('monitor-suspended', null);
      const status = { mode: control.mode || args.mode, visible: control.visible, active: control.visible && control.mode === 'taskbar', supported: true, message: params.has('taskbarFail') ? '任务栏空间不足，保留桌面浮条（模拟）' : '浏览器夹具：显示状态已更新' };
      record(command, args); fixture.emitEvent('monitor-mode-status', status); return status;
    }
    if (command === 'monitor_mode_status') { record(command, args); return { mode: control.mode || 'floating', supported: true, visible: control.visible, active: control.visible && control.mode === 'taskbar', message: '浏览器夹具：未连接实际任务栏' }; }
    if (command === 'set_monitor_mode') {
      control.visible = true; control.mode = params.has('taskbarFail') ? 'floating' : args.mode; record(command, args);
      const status = { mode: control.mode, supported: true, visible: control.visible, active: control.visible && control.mode === 'taskbar', message: params.has('taskbarFail') ? '任务栏空间不足，已保留桌面浮条（模拟）' : '浏览器夹具：仅验证模式交互' };
      if (params.has('rapidPatch')) fixture.emitEvent('monitor-preferences-patch', { metrics: ['cpu'] });
      fixture.emitEvent('monitor-mode-status', status); return status;
    }
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
        metrics: control.phase === 'unavailable' ? undefined : { engine: { model: 'Fixture A' }, live: { state: control.state, tok_s: 60 + Math.sin(control.reads * .8) * 12, prefill_tok_s_mean: 1200 + Math.sin(control.reads * .5) * 180, running: control.state === 'idle' ? 0 : 1, queued: control.queued }, hardware: { gpu_util: 35 + Math.sin(control.reads * .5) * 10, cpu: 12, gpu_temp: 50, gpu_power: 140, gpu_mem_used: 12.4 * 1073741824, gpu_mem_total: 32 * 1073741824, ram_used: 24.2 * 1073741824, ram_total: 64 * 1073741824 }, requests: control.state === 'idle' ? [{ decode_tok_s: 33 }] : [] },
        error: control.phase === 'unavailable' ? 'Fixture metrics unavailable' : undefined,
        sampledAt: Date.now() - (control.stale ? 60000 : 0),
      };
    }
    if (command === 'plugin:window|is_always_on_top') { record(command, args); return control.pinned; }
    if (command === 'plugin:window|set_always_on_top') { record(command, args); control.pinned = args.value; return; }
    if (command === 'plugin:window|set_size') { record(command, args); control.size = structuredClone(args.value?.size || args.value?.Logical || args.value); return; }
    if (command === 'plugin:window|start_dragging') { record(command, args); control.drags = (control.drags || 0) + 1; return; }
    if (command === 'move_monitor_to_taskbar') { record(command, args); control.taskbarMoves = (control.taskbarMoves || 0) + 1; control.visible = true; control.mode = 'taskbar'; const status = { mode: 'taskbar', active: true, visible: true, supported: true, message: '浏览器夹具：已收起到任务栏监控' }; fixture.emitEvent('monitor-mode-status', status); return status; }
    if (command === 'plugin:window|close') { record(command, args); control.closed = true; control.visible = false; fixture.emitEvent('monitor-mode-status', { mode: 'floating', active: false, visible: false, supported: true }); return; }
    if (command === 'show_main_from_monitor') { record(command, args); control.shownMain++; control.destinations.push(args.destination ?? null); return; }
    if (command === 'open_monitor_window') { record(command, args); control.opened++; control.visible = true; fixture.emitEvent('monitor-mode-status', { mode: 'floating', active: false, visible: true, supported: true }); return; }
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
