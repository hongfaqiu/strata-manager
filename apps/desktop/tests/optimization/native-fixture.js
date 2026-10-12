// All native IO is synthetic and in-memory. No real ports, paths or credentials.
const profiles = ['a', 'b'].map(id => ({ id, name: `Fixture ${id.toUpperCase()}`, baseUrl: `http://127.0.0.1:${id === 'a' ? 19001 : 19002}`, installDir: `fixture/${id}`, pythonPath: 'fixture/python.exe', configPath: `fixture/${id}.json`, managed: true }));
const configs = Object.fromEntries(profiles.map(profile => [profile.id, { exe: 'fixture/python.exe', cwd: profile.installDir, args: ['--model', `fixture/${profile.id}.gguf`, '--pool-workers', '4'], model_name: profile.name }]));
const message = { id: 'partial', role: 'assistant', content: '已收到的部分回答', error: 'STREAM_INCOMPLETE', createdAt: Date.now() };
const store = { settings: { language: 'zh-CN', theme: 'light', pollInterval: 60000, autoCheckUpdates: false, closeToTray: false, skipExitConfirmation: false }, activeProfile: 'a', onboardingOpen: false, conversations: [{ id: 'conversation', profileId: 'a', title: 'Partial answer fixture', messages: [message], createdAt: Date.now(), updatedAt: Date.now() }], activeConversationIds: { a: 'conversation' } };
// Only the floating-settings replay persists its synthetic preferences on reload.
const floatingSettingsParams = new URLSearchParams(location.search);
const floatingSettingsKey = floatingSettingsParams.has('floating-settings') ? `strata-floating-settings-fixture-${floatingSettingsParams.get('case') || 'default'}-${floatingSettingsParams.get('replay') || 'default'}` : null;
if (floatingSettingsKey) { try { Object.assign(store.settings, JSON.parse(sessionStorage.getItem(floatingSettingsKey) || '{}')); } catch {} }
const calls = [];
const callbacks = new Map(); let callbackId = 0;
const channelIndexes = new Map();
const listeners = new Map(); let listenerId = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(_event, id) { const listener = listeners.get(id); if (listener !== undefined) callbacks.delete(listener.handler); listeners.delete(id); } };
window.__fixture = { calls, configs, store, profiles, supervisor: {}, serviceStatuses: {}, capability: 0, failReads: false, metricFailure: false, remoteValue: 100, emit: () => {} };
window.__fixture.emitEvent = (event, payload) => {
  let delivered = 0;
  for (const [id, listener] of [...listeners]) if (listener.event === event) { callbacks.get(listener.handler)?.({ event, id, payload: structuredClone(payload) }); delivered++; }
  return delivered;
};
window.__fixture.hasListener = event => [...listeners.values()].some(listener => listener.event === event);
window.__fixture.deliverChannel = (channel, message) => {
  const id = typeof channel === 'string' ? Number(channel.replace('__CHANNEL__:', '')) : channel?.id;
  const callback = callbacks.get(id);
  if (!callback) throw Error(`Missing synthetic Tauri channel: ${id}`);
  const index = channelIndexes.get(id) || 0;
  channelIndexes.set(id, index + 1);
  callback({ index, message });
};
const featureTasks = [], featureLogs = new Map(), externalOwners = new Set();
const officialApp = location.pathname.endsWith('/official-app.html');
const officialFeatures = officialApp || location.pathname.endsWith('/official-features.html');
const featureStatus = { service: 'strata', engine: '0.1.42', loaded: true, dialects: ['/v1/chat/completions'], structured_output: { formats: ['json_object', 'json_schema'] }, concurrency: { serving: 1 }, vram: { elastic: true } };
const featureMetrics = { engine: { version: '0.1.42', max_context: 8192, logit_bias: 1, vocab_size: 100000 }, live: { parallel: 2, running: 1, waiting: 1, slots: [{ slot: 0, state: 'decoding', prompt_tokens: 1024, generated: 32, tok_s: 64, elapsed_s: 0.5 }, { slot: 1, state: 'idle', held_tokens: 512 }] } };
Object.assign(window.__fixture, { featureStatus, featureMetrics, runtimeEvidence: { verified: true, promptCache: 4, pid: 99999, startedAt: Date.now() } });
if (officialFeatures) { window.__fixture.capability = 1; for (const profile of profiles) { profile.installDir = 'C:\\fixture\\Strata'; profile.pythonPath = 'C:\\fixture\\python.exe'; } configs.a.args.push('--prompt-cache', '4', '--vram-elastic'); configs.a.slot_save_path = 'fixture/sessions'; }
if (officialApp) store.conversations[0].messages = [{ id: 'document', role: 'user', content: '长文😀内容供固定前缀测试。', createdAt: Date.now() }];
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, convertFileSrc: path => path,
  transformCallback(callback) { const id = ++callbackId; callbacks.set(id, callback); return id; }, unregisterCallback(id) { callbacks.delete(id); },
  async invoke(command, args = {}) {
    calls.push({ command, args: structuredClone(args) });
    const profile = args.profile ?? profiles.find(profile => profile.id === args.profileId) ?? profiles[0];
    if (command === 'store_get') return structuredClone(store[args.key] ?? null);
    if (command === 'store_set') {
      if (window.__fixture.holdStore) await new Promise(resolve => { window.__fixture.releaseStore = () => { window.__fixture.holdStore = false; resolve(); }; });
      if (window.__fixture.failStoreWrites) { window.__fixture.storeFailures = (window.__fixture.storeFailures ?? 0) + 1; throw Error('Fixture disk write failed'); }
      store[args.key] = structuredClone(args.value);
      if (floatingSettingsKey && args.key === 'settings') sessionStorage.setItem(floatingSettingsKey, JSON.stringify(store.settings));
      return;
    }
    if (command === 'local_installations') return profiles;
    if (command === 'local_installation_details') return profiles.map(profile => ({ profileId: profile.id, configModifiedAt: 1000, lastActivatedAt: profile.id === 'a' ? 2000 : 1000 }));
    if (command === 'service_status') return structuredClone(window.__fixture.serviceStatuses[profile.id] ?? { profileId: profile.id, running: profile.id === 'a', owned: profile.id === 'a', pid: profile.id === 'a' ? 99999 : null, phase: profile.id === 'a' ? 'ready' : 'stopped' });
    if (command === 'assert_profile_management') return;
    if (['switch_local_service', 'ensure_local_service', 'start_service', 'stop_service', 'restart_service', 'take_over_service'].includes(command)) throw Error(`Forbidden fixture lifecycle: ${command}`);
    if (command === 'strata_request') {
      if (officialFeatures && args.path === '/v1/status') { if (window.__fixture.holdCapabilities) await new Promise(resolve => { window.__fixture.metadataReadHeld = true; window.__fixture.releaseCapabilities = () => { window.__fixture.holdCapabilities = false; window.__fixture.metadataReadCompleted = true; resolve(); }; }); return featureStatus; }
      if (officialFeatures && args.path === '/settings') return { shared: false };
      if (officialFeatures && args.path === '/v1/vram') return { status: 'ok', reserve_mib: args.body.reserve_mib ?? 700, vram_free_mib: args.body.reserve_mib === null ? 2048 : 6144, expert_cache_mib: args.body.reserve_mib === null ? 12000 : 8192, expert_cache_full_mib: 12000 };
      if (officialFeatures && args.path.startsWith('/slots/0?action=')) {
        if (args.body.filename === '') throw 'HTTP 400: {"error":{"message":"filename must be a non-empty string"}}';
        if (window.__fixture.sessionFailure) throw 'HTTP 507: {"error":{"message":"Insufficient session save reserve","kind":"disk"}}';
        const saving = args.path.endsWith('=save'); return { id_slot: 0, filename: args.body.filename, [saving ? 'n_saved' : 'n_restored']: 1024, [saving ? 'n_written' : 'n_read']: 1048576, timings: { [saving ? 'save_ms' : 'restore_ms']: 25 } };
      }
      if (args.path.startsWith('/health')) return { service: 'strata', status: 'ok', loaded: true, model: profile.name };
      if (args.path.startsWith('/metrics')) { if (window.__fixture.metricFailure) throw Error('Fixture telemetry disconnected'); if (officialFeatures) return featureMetrics; return { live: { state: 'generating', generated: 20, max_tokens: 100 }, engine: { model: profile.name, max_context: 8192 }, hardware: { gpu_util: 42 }, requests: [] }; }
      if (args.path.startsWith('/config')) {
        if (args.method === 'POST') window.__fixture.remoteValue = args.body.set?.idle_unload_s ?? window.__fixture.remoteValue;
        return { keys: [{ key: 'idle_unload_s', kind: 'number', value: window.__fixture.remoteValue }], changed: ['idle_unload_s'] };
      }
      if (args.path.startsWith('/v1/models')) return { data: [{ id: 'Fixture A' }] };
      return {};
    }
    if (officialFeatures && command === 'chat_runtime_evidence') return structuredClone(window.__fixture.runtimeEvidence);
    if (officialFeatures && command === 'strata_stream') {
      window.__fixture.chatBody = structuredClone(args.body);
      const callback = callbacks.get(args.onEvent.id);
      callback?.({ index: 0, message: { kind: 'data', data: 'data: {"choices":[{"delta":{"content":"{\\"answer\\":\\"fixture\\"}"}}]}\n\ndata: [DONE]\n\n' } });
      callback?.({ index: 1, message: { kind: 'done' } });
      callback?.({ index: 2, end: true }); return;
    }
    if (command === 'supervisor_status') return structuredClone({ running: true, protocolVersion: 1, activeServices: 1, version: 'fixture-old', capabilities: window.__fixture.capability ? { fullScenarioTuning: window.__fixture.capability } : undefined, health: { a: { phase: 'healthy', apiHealthy: true, loaded: true, pid: 99999, checkedAt: Date.now(), lastHealthyAt: Date.now(), reason: '', failures: [], observerState: 'idle' } }, ...window.__fixture.supervisor });
    if (command === 'read_config') { if (window.__fixture.failReads) throw Error('Fixture read failed'); return structuredClone(configs[profile.id]); }
    if (command === 'read_config_snapshot') { if (window.__fixture.failReads) throw Error('Fixture read failed'); return { config: structuredClone(configs[profile.id]), revision: JSON.stringify(configs[profile.id]) }; }
    if (command === 'write_config') {
      if (args.expectedRevision !== JSON.stringify(configs[profile.id])) throw Error('CONFIG_REVISION_CONFLICT: 配置已被其他操作修改；草稿已保留');
      configs[profile.id] = structuredClone(args.config); if (window.__fixture.failAfterWrite) window.__fixture.failReads = true;
      return { revision: JSON.stringify(configs[profile.id]) };
    }
    if (command === 'copy_configuration') { const copied = { ...profile, id: `copy-${profiles.length}`, name: 'Fixture copy', configPath: `fixture/${args.filename}` }; profiles.push(copied); configs[copied.id] = structuredClone(args.config); return copied; }
    if (command === 'read_logs') return featureLogs.get(args.profile?.id) ?? [{ timestamp: Date.now(), level: 'INFO', message: `logs for ${profile.id}` }];
    if (command === 'external_management_status') return { profileId: args.profileId, external: externalOwners.has(args.profileId), scope: 'installation', canHandoff: officialFeatures, canResume: officialFeatures, installDir: 'C:\\fixture\\Strata' };
    if (officialFeatures && command === 'set_external_management') { if (args.external) externalOwners.add(args.profileId); else externalOwners.delete(args.profileId); return { profileId: args.profileId, external: !!args.external, scope: 'installation', canHandoff: true, canResume: true, installDir: 'C:\\fixture\\Strata' }; }
    if (command === 'manager_mcp_connection') return { protocolVersion: '2025-06-18', serverName: 'strata-manager', profileId: args.profileId, command: 'C:\\fixture\\strata-supervisor.exe', args: ['--mcp-server', '--data-dir', 'C:\\fixture\\manager-data', '--profile-id', args.profileId], tools: [{ name: 'strata_status', readOnly: true }, { name: 'strata_start', readOnly: false }], installDir: 'C:\\fixture\\Strata' };
    if (command === 'probe_official_mcp') return { protocolVersion: '2024-11-05', serverName: 'strata', readOnlyProbe: true, tools: [{ name: 'strata_status', readOnly: true }, { name: 'strata_start', readOnly: false }], scriptPath: 'C:\\fixture\\Strata\\tools\\strata_mcp.py', pythonPath: 'C:\\fixture\\python.exe', installDir: 'C:\\fixture\\Strata' };
    if (command === 'inspect_gguf' || (officialFeatures && command === 'run_setup')) {
      const id = `fixture-task-${featureTasks.length}`;
      const task = { id, kind: command === 'inspect_gguf' ? 'model-inspect' : 'setup', state: 'running', message: 'Fixture task started', startedAt: Date.now() };
      featureTasks.push(task); featureLogs.set(id, [{ timestamp: Date.now(), level: 'stdout', message: 'GGUF: routed experts IQ3_S; compatible with Strata' }]);
      if (!args.request?.target?.includes('wait.gguf')) setTimeout(() => { task.state = 'completed'; task.finishedAt = Date.now(); task.message = 'Fixture command completed'; }, 80);
      return structuredClone(task);
    }
    if (officialFeatures && command === 'setup_disk_preflight') return { status: 'ready', dataDirectory: 'C:\\fixture\\Strata', modelDirectory: 'C:\\fixture\\Strata\\models', modelDownloadBytesEstimate: 83600000000, reusableModelBytes: 0, additionalBytesEstimate: 90000000000, estimate: true, volumes: [{ directory: 'C:\\fixture\\Strata', mountPoint: 'C:\\', availableBytes: 1000000000000, requiredAdditionalBytesEstimate: 90000000000 }], reason: '', source: 'Isolated fixture disk estimate' };
    if (command === 'cancel_task') { const task = featureTasks.find(task => task.id === args.taskId); if (task) task.state = 'cancelled'; return; }
    if (officialFeatures && command === 'tuning_start') return null;
    if (command === 'has_api_key') return false;
    if (command === 'set_api_key') return;
    if (command === 'tuning_status') return null;
    if (command === 'analytics_query') return { data: { http: {}, inference: {}, groups: [], buckets: [] }, coverage: { gaps: [], sessions: [], observerStatuses: [], collectionScope: [] } };
    if (command === 'list_tasks') return structuredClone(featureTasks);
    if (['discover_local', 'list_setup_handoffs', 'list_local_models'].includes(command)) return [];
    if (command === 'get_background_policy') return { mode: 'alwaysReady', autoRecover: false };
    if (command === 'get_startup_status') return { enabled: false, supported: true };
    if (command === 'plugin:event|listen') { const id = ++listenerId; listeners.set(id, { event: args.event, handler: args.handler, target: args.target }); if (args.event === 'window-exit-requested') window.__fixture.emit = () => window.__fixture.emitEvent(args.event, null); return id; }
    if (command === 'plugin:event|emit' || command === 'plugin:event|emit_to') { window.__fixture.emitEvent(args.event, args.payload); return; }
    if (command === 'apply_settings') { store.settings = structuredClone(args.settings); window.__fixture.emitEvent('monitor-preferences-changed', store.settings); return; }
    if (command === 'confirm_window_close') return;
    if (command.startsWith('plugin:') || ['apply_settings', 'local_runtime_installation'].includes(command)) return null;
    throw Error(`Unmocked fixture command: ${command}`);
  },
};
