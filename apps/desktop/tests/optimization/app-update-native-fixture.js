// Only synthetic app metadata is added to the existing in-memory native fixture.
(() => {
  const params = new URLSearchParams(location.search), fixture = window.__fixture;
  const originalInvoke = window.__TAURI_INTERNALS__.invoke;
  fixture.store.settings.language = params.get('language') || 'zh-CN';
  fixture.store.settings.theme = params.get('theme') || 'light';
  fixture.store.settings.autoCheckUpdates = params.has('automatic');
  fixture.store.sidebarCollapsed = params.has('collapsed');
  fixture.currentVersion = params.get('version') || '0.1.3';
  fixture.updateAvailable = params.has('available');
  fixture.stopped = params.has('stopped');
  fixture.copied = [];
  const source = id => id === 'official'
    ? { id, label: 'GitHub', kind: 'official', selectedBy: 'automatic', manifestUrl: 'https://github.com/hongfaqiu/strata-manager/releases/latest/download/latest.json', downloadUrl: 'https://github.com/hongfaqiu/strata-manager/releases/download/v0.2.0/Strata.Manager_0.2.0_x64-setup.exe' }
    : { id, label: id === 'gh-proxy' ? 'gh-proxy.org' : 'ghproxy.net', kind: 'mirror', selectedBy: 'automatic', manifestUrl: `https://${id === 'gh-proxy' ? 'gh-proxy.org' : 'ghproxy.net'}/https://github.com/hongfaqiu/strata-manager/releases/latest/download/latest.json`, downloadUrl: `https://${id === 'gh-proxy' ? 'gh-proxy.org' : 'ghproxy.net'}/https://github.com/hongfaqiu/strata-manager/releases/download/v0.2.0/Strata.Manager_0.2.0_x64-setup.exe` };
  // Clipboard writes stay inside the fixture rather than changing the host clipboard.
  const clipboard = navigator.clipboard || {};
  Object.defineProperty(clipboard, 'writeText', { configurable: true, value: async value => { fixture.copied.push(value); } });
  if (!navigator.clipboard) Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
  fixture.updateNotes = '## 中文\n\n- 隔离验收：新版统一应用标识和版本入口。\n\n## English\n\n- Isolated acceptance: unify the application mark and version entry.';
  window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
    if (command === 'plugin:app|version') {
      fixture.calls.push({ command, args: structuredClone(args) });
      return fixture.currentVersion;
    }
    if (command === 'check_app_update') {
      fixture.calls.push({ command, args: structuredClone(args) });
      const chosen = source(params.get('source') || 'ghproxy');
      const fallbackChain = chosen.id === 'official' ? [] : [source('official')];
      const attempts = [{ stage: 'probe', result: 'success', source: chosen, durationMs: 120 }, { stage: 'check', result: fixture.updateAvailable ? 'selected' : 'current', source: chosen, message: fixture.updateAvailable ? 'version 0.2.0' : undefined }];
      return fixture.updateAvailable ? {
        update: { id: 'fixture-update', currentVersion: fixture.currentVersion, version: '0.2.0', date: '2026-10-12T00:00:00Z', body: fixture.updateNotes, rawJson: {}, source: chosen, fallbackChain, attempts },
        source: chosen,
        fallbackChain,
        attempts,
      } : { update: null, source: chosen, fallbackChain, attempts };
    }
    if (/^(?:download_app_update|install_app_update)$/.test(command) || command === 'prepare_app_update') {
      fixture.calls.push({ command, args: structuredClone(args) });
      throw Error(`Forbidden app-update fixture mutation: ${command}`);
    }
    if (command === 'close_app_update') {
      fixture.calls.push({ command, args: structuredClone(args) });
      return null;
    }
    if (command === 'supervisor_status') {
      const status = await originalInvoke(command, args);
      if (fixture.stopped) return { ...status, activeServices: 0, health: {} };
      status.health.a.activeRequests = 0;
      return status;
    }
    if (command === 'service_status' && fixture.stopped) {
      fixture.calls.push({ command, args: structuredClone(args) });
      return { profileId: args.profileId || args.profile?.id || 'a', running: false, owned: false, pid: null, phase: 'stopped' };
    }
    if (command === 'strata_request' && args.path.startsWith('/health')) {
      const health = await originalInvoke(command, args);
      if (params.has('auth')) health.api_key = params.get('auth') === 'required';
      return health;
    }
    if (command === 'get_background_policy') {
      fixture.calls.push({ command, args: structuredClone(args) });
      return { mode: 'lazy', autoRecover: false, idleUnloadMinutes: 15 };
    }
    if (command === 'get_startup_status') {
      fixture.calls.push({ command, args: structuredClone(args) });
      return { enabled: false, supported: true, configured: false, healthy: true };
    }
    return originalInvoke(command, args);
  };
})();
