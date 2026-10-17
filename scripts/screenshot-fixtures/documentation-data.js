// Only documentation data changes. The production App, components and CSS are untouched.
// No native handler, service, file, credential, installer or inference is contacted.
(() => {
  const f = window.__fixture, native = window.__TAURI_INTERNALS__, original = native.invoke;
  const params = new URLSearchParams(location.search), en = params.get('language') === 'en';
  const language = en ? 'en' : 'zh-CN', version = params.get('version') || '0.1.4', floating = params.get('window') === 'monitor';
  const now = Date.now(), model = 'Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S';
  f.documentation = { synthetic: true, language, version, windowMode: floating ? 'monitor' : 'main', forbiddenCalls: [], metricReads: 0, copied: [], scope: 'All RPC, models, reports, status and hardware values are isolated documentation examples.' };
  if (floating) {
    native.metadata.currentWindow.label = 'service-monitor';
    native.metadata.currentWebview.label = 'service-monitor';
  }
  for (const [index, p] of f.profiles.entries()) {
    Object.assign(p, { name: index ? `${model} · Vision` : model, installDir: 'D:/AI/Strata', pythonPath: 'D:/AI/Strata/.venv/Scripts/python.exe', configPath: `D:/AI/Strata/config/${index ? 'vision' : 'qwen'}.json` });
    Object.assign(f.configs[p.id], { exe: p.pythonPath, cwd: p.installDir, args: ['--model', `D:/AI/models/${index ? 'vision' : 'qwen'}.gguf`, '--max-context', '131072', '--kv', 'int8', '--pool-workers', '4'], model_name: p.name, slot_save_path: 'D:/AI/Strata/sessions' });
  }
  const profile = f.profiles[0];
  Object.assign(f.store.settings, { language, theme: 'light', pollInterval: 30000, autoCheckUpdates: false, closeToTray: true });
  Object.assign(f.store, { activeProfile: profile.id, sidebarCollapsed: false, onboardingOpen: false, commonChatDefaults: { reasoningEffort: 'high', temperature: .6, topP: .95, topK: 20, maxTokens: 0, seed: null, systemPrompt: '', mcp: true }, chatDefaultsInheritance: { a: true }, runtimeDownloadPreferences: { mode: 'official' } });
  const answer = en ? '1. Choose a configuration in **Models** and select **Use**.\n2. Wait for the model to be ready, then open **Chat**.\n3. Review requests, tokens and latency in **Monitoring → API usage**.\n\n```text\nhttp://127.0.0.1:19001/v1\n```\n\nA stopped service stays stopped until you enable it.' : '1. 在 **模型** 中选择配置并点击 **使用**。\n2. 等待模型就绪后打开 **聊天**。\n3. 在 **监控 → API 使用统计** 中查看请求、Token 和响应耗时。\n\n```text\nhttp://127.0.0.1:19001/v1\n```\n\n停止的服务会保持未启动，直到手动启用。';
  f.store.conversations = [{ id: 'documentation-chat', profileId: 'a', title: en ? 'Getting started with a local model' : '开始使用本机模型', createdAt: now, updatedAt: now, messages: [{ id: 'question', role: 'user', content: en ? 'How do I start using a local model and inspect API usage?' : '怎样开始使用本机模型，并查看调用情况？', createdAt: now }, { id: 'answer', role: 'assistant', content: answer, createdAt: now }] }];
  f.store.activeConversationIds = { a: 'documentation-chat' };
  f.benchmark.model = model;
  f.capability = 1;
  Object.assign(f.featureStatus, { engine: '0.1.43', loaded: true });
  const assets = [['strata-windows-x64.zip', 'cuda13'], ['strata-windows-x64-cuda12.zip', 'cuda12'], ['strata-windows-x64-hip.zip', 'hip']].map(([name, variant], i) => ({ name, variant, size: (220 + i * 20) * 1024 ** 2, sha256: String(i + 1).repeat(64), url: `https://github.com/Niko1221/Strata/releases/download/v0.1.43/${name}` }));
  const release = { checkedAt: now, supportedVersion: '0.1.43', supportedRevision: 'a'.repeat(40), latestVersion: '0.1.43', sourceRevision: 'a'.repeat(40), releaseName: 'Strata 0.1.43', releaseUrl: 'https://github.com/Niko1221/Strata/releases/tag/v0.1.43', publishedAt: '2026-10-11T00:00:00Z', assets, updateAvailable: false, installable: true, notes: '## 中文\n\n- 运行环境更新与兼容性说明。\n\n## English\n\n- Runtime updates and compatibility notes.' };
  const requests = Array.from({ length: 8 }, (_, i) => ({ id: `request-${i}`, time: now / 1000 - i * 20, state: 'done', prompt_tokens: 4096, reused: 1024, output_tokens: 384, decode_tok_s: 30.5 + i, duration_s: 14.8, prompt_ms: 1500, hit_rate: .82 }));
  const metric = () => {
    const sample = f.documentation.metricReads++, phase = sample % 8;
    return { state: 'generating', engine: { version: '0.1.43', model, max_context: 131072, context_used: 32768, expert_slots: 42, expert_bytes: 8 * 1024 ** 3, expert_cache_mib: 8192 }, live: { state: 'generating', tok_s: 30 + phase * 2, running: 1, queued: phase > 3 ? 2 : 1, parallel: 2, prompt_read: 32768, prompt_total: 32768, prompt_tokens: 32768, generated: 384, prefill_tok_s_mean: 2048 }, hardware: { gpu_name: 'RTX 4080 SUPER', gpu_util: 35 + phase * 5, gpu_mem_total: 32 * 1024 ** 3, gpu_mem_used: 21 * 1024 ** 3, ram_total: 96 * 1024 ** 3, ram_used: 62 * 1024 ** 3, gpu_temp: 58, gpu_power: 210, cpu: 12, gpu_pcie_gen_max: 4, gpu_pcie_gen: 4, gpu_pcie_width: 16, gpu_pcie_rx_mb: 256, disk_read_mb: 84, disk_write_mb: 2.5 }, hardware_static: { gpu_name: 'RTX 4080 SUPER', cores: 16, threads: 24, psutil: true }, requests, decode: { tok_s: 30.5, prefill_tok_s: 2048 }, history: { tok_s: [12, 23, 15, 40, 33] }, conversation_cache: { enabled: true, requests: 12, requests_reused: 8, parked: 2, slots: 4, bytes: 536870912, budget_mib: 2048, reused_tokens: 8192, prompt_tokens: 32768, parks: 4, restores: 3 } };
  };
  const coverage = { sessions: [{ sessionId: 'documentation', serviceId: 'a', startedAtMs: now - 3600000, endedAtMs: null, supported: true }], gaps: [], observerStatuses: [{ serviceId: 'a', sessionId: 'documentation', pid: 99999, updatedAtMs: now, supported: true, journalWriteFailed: false, observerActive: true, heartbeatFresh: true, error: null }], journalPresent: true, metadataOnly: true, dataAvailableFromMs: now - 3600000, collectionScope: ['chat', 'responses', 'anthropic', 'token_count'], historyRetentionDays: 90, journalRetentionDays: 7, journalMaxEvents: 50000 };
  const distribution = (p50, p95) => ({ samples: 30, p50, p95 });
  const summary = { startMs: now - 3600000, endMs: now, http: { requests: 128, succeeded: 124, failed: 2, cancelled: 2, interrupted: 0, pending: 0, inputTokens: 262144, outputTokens: 16384, cacheReadTokens: 32768, cacheCreationTokens: 1024, inputTokenSamples: 128, outputTokenSamples: 128, mcpToolCalls: 12, mcpToolFailures: 0, firstRequestAtMs: now - 3600000, lastFinishedAtMs: now, successRate: 124 / 128 }, inference: { runs: 137, inputTokens: 290816, outputTokens: 17408, cacheReadTokens: 34816, toolCalls: 12, inputTokenSamples: 30, decodeSpeedSamples: 30 }, groups: [{ route: 'chat', clientId: 'strata-manager.desktop', requests: 92, succeeded: 89 }, { route: 'responses', clientId: null, requests: 36, succeeded: 35 }], ttftS: distribution(3.12, 25.6), durationS: distribution(30.123, 80.54), decodeTokS: distribution(30.5, 42), prefillTokS: distribution(2048, 2600), retentionDays: 90 };
  const mutating = /^(?:switch_local_service|ensure_local_service|start_service|stop_service|restart_service|take_over_service|strata_stream|cancel_stream|tuning_start|tuning_cancel|tuning_apply|tuning_restore|update_runtime|update_runtime_zip|prepare_app_update|prepare_local_runtime|install_runtime|run_setup|inspect_gguf|write_config|copy_configuration|delete_configuration|delete_model|set_api_key|set_external_management|set_startup|set_background_policy|confirm_window_close|cancel_task)$/;
  const record = (command, args) => f.calls.push({ command, args: structuredClone(args) });
  native.invoke = async (command, args = {}) => {
    if (floating && !['monitor_snapshot', 'plugin:window|is_always_on_top'].includes(command)) {
      record(command, args); f.documentation.forbiddenCalls.push({ command, method: args.method }); throw Error(`Forbidden screenshot operation: ${command}`);
    }
    if (command === 'monitor_snapshot') {
      record(command, args); return { settings: { language, theme: 'light', pollInterval: 10000 }, profile, process: { profileId: 'a', running: true, owned: true, pid: 99999, creationTime: 'documentation-instance-1', phase: 'ready' }, phase: 'online', health: { service: 'strata', status: 'ok', loaded: true, model }, metrics: metric(), sampledAt: Date.now() };
    }
    if (command === 'plugin:window|is_always_on_top') { record(command, args); return true; }
    if (['open_monitor_window', 'show_main_from_monitor'].includes(command) || /^plugin:window\|(?:set_always_on_top|close|show|set_focus|unminimize|start_dragging)$/.test(command)) {
      record(command, args); f.documentation.forbiddenCalls.push({ command }); throw Error(`Forbidden screenshot operation: ${command}`);
    }
    if (mutating.test(command) || /^plugin:(?:updater\|(?:download|install|download_and_install)|dialog\||opener\|)/.test(command) || command === 'strata_request' && args.method && args.method !== 'GET') {
      record(command, args); f.documentation.forbiddenCalls.push({ command, method: args.method }); throw Error(`Forbidden screenshot operation: ${command}`);
    }
    if (command === 'plugin:app|version') { record(command, args); return version; }
    if (command === 'plugin:updater|check') { record(command, args); return null; }
    if (command === 'supervisor_status') { record(command, args); return { running: true, pid: 99000, protocolVersion: 1, activeServices: 1, activeLocalInstallation: 'a', version, capabilities: { fullScenarioTuning: 1, quickCalibration: 1, tuningLive: 1, runtimeZipDownloadTest: 1 }, health: { a: { phase: 'healthy', apiHealthy: true, loaded: true, activeRequests: 1, pid: 99999, checkedAt: Date.now(), observerState: 'generating', failures: [] } } }; }
    if (command === 'service_status') { record(command, args); const id = args.profileId || args.profile?.id || 'a'; return { profileId: id, running: id === 'a', owned: id === 'a', pid: id === 'a' ? 99999 : null, creationTime: id === 'a' ? 'documentation-instance-1' : undefined, phase: id === 'a' ? 'ready' : 'stopped' }; }
    if (command === 'strata_request') {
      record(command, args);
      if (args.path.startsWith('/health')) return { service: 'strata', status: 'ok', loaded: true, images: true, model, max_context: 131072, api_key: false };
      if (args.path.startsWith('/metrics')) return metric();
      if (args.path === '/v1/status') return f.featureStatus;
      if (args.path === '/settings') return { shared: false };
      if (args.path.startsWith('/config')) return { keys: [{ key: 'temperature', kind: 'number', value: .6 }, { key: 'top_p', kind: 'number', value: .95 }, { key: 'idle_unload_s', kind: 'number', value: 900 }], changed: [], config: { max_context: 131072 } };
      if (args.path.startsWith('/v1/models')) return { data: [{ id: model }] };
      if (args.path === '/mcp') return { servers: [], tools: [] };
      return {};
    }
    if (command === 'local_runtime_installation') { record(command, args); return { detectedRuntimes: [{ installDir: profile.installDir, pythonPath: profile.pythonPath, readiness: 'ready', runtimeVersion: '0.1.43', sourceRevision: 'a'.repeat(40), profile }] }; }
    if (command === 'runtime_update_info') { record(command, args); return release; }
    if (command === 'resolve_runtime_zip_asset') { record(command, args); return assets.find(asset => asset.name === (args.assetName || assets[1].name)); }
    if (command === 'test_runtime_zip_download') { record(command, args); return { source: 'official', assetName: args.assetName, checkedAt: now, checkedBytes: 65536, totalBytes: assets[1].size, rangeSupported: true, sha256Verified: false }; }
    if (command === 'assess_setup_resources') { record(command, args); const context = args.request?.context ?? 131072, parallel = args.request?.parallel ?? 1; return { status: context > 131072 ? 'risk' : 'suggested', estimate: true, sampledAt: Date.now(), hardware: { sampledAt: Date.now(), cpuName: 'AMD Ryzen 9 7950X', totalMemoryBytes: 96 * 2 ** 30, availableMemoryBytes: 34 * 2 ** 30, gpus: [{ id: 0, vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4080 SUPER', totalBytes: 32 * 2 ** 30, availableBytes: 11 * 2 ** 30, source: 'nvml' }], cpuIsa: 'avx512', wsl: false, managedServiceRunning: true }, ram: { baselineBytes: 48 * 2 ** 30, expertBytes: 40 * 2 ** 30, longContextBytes: 62 * 2 ** 30, mode: 'normal' }, kv: { streaming: true, streamingRamBytes: context * 8192 }, slots: { count: parallel, perSlotVramBytes: 2 ** 30, totalVramBytes: parallel * 2 ** 30 }, recommendations: { context: 131072, parallel: 1 }, reasons: [{ code: 'estimate_scope', severity: 'info' }], unknowns: [], sourceRevision: 'a0116b2782a5b82622358c04a06496485d12b2d6' }; }
    if (command === 'environment_info') { record(command, args); return { os: 'Windows', arch: 'x86_64', cpuName: 'Intel Core i9', totalMemory: 64 * 1024 ** 3, availableMemory: 36 * 1024 ** 3, gpus: ['RTX 4080 SUPER'], python: '3.10.11', git: '2.51.0', appVersion: version }; }
    if (command === 'discover_local') { record(command, args); return f.profiles.map((p, i) => ({ id: `documentation-${p.id}`, name: p.name, installDir: p.installDir, pythonPath: p.pythonPath, configPath: p.configPath, modelPath: `D:/AI/models/${i ? 'vision' : 'qwen'}.gguf`, modelBytes: 78 * 1024 ** 3, availability: 'ready', running: i === 0, detectedPort: i ? 19002 : 19001 })); }
    if (command === 'list_local_models') { record(command, args); return [{ name: model, configPath: profile.configPath, modelPath: 'D:/AI/models/qwen.gguf', sizeBytes: 83.6e9 }]; }
    if (command === 'get_api_key') { record(command, args); return ''; }
    if (command === 'manager_mcp_connection') { record(command, args); return { protocolVersion: '2025-06-18', serverName: 'strata-manager', profileId: args.profileId || 'a', command: 'D:/Apps/Strata Manager/strata-supervisor.exe', args: ['--mcp-server', '--data-dir', 'D:/Apps/Strata Manager/data', '--profile-id', args.profileId || 'a'], tools: [{ name: 'strata_status', readOnly: true }, { name: 'strata_start', readOnly: false }], installDir: profile.installDir }; }
    if (command === 'external_management_status') { record(command, args); return { profileId: args.profileId || 'a', external: false, scope: 'installation', canHandoff: true, canResume: true, installDir: profile.installDir }; }
    if (command === 'tuning_status') { record(command, args); return null; }
    if (command === 'list_tasks') { record(command, args); return [{ id: 'documentation-preparation', kind: 'setup', state: 'completed', startedAt: now - 300000, finishedAt: now - 60000, message: en ? 'Runtime and model configuration prepared.' : '运行环境和模型配置准备完成。' }]; }
    if (command === 'read_logs') { record(command, args); return Array.from({ length: 8 }, (_, i) => ({ timestamp: now - i * 1000, level: 'INFO', message: en ? 'Configuration and managed-service identity verified.' : '已核验配置与受管服务归属。' })); }
    if (command === 'analytics_query') {
      record(command, args); const action = args.query?.action;
      const rows = Array.from({ length: 8 }, (_, i) => ({ requestId: `request-${i}`, serviceId: 'a', startedAtMs: now - i * 100000, endedAtMs: now - i * 100000 + 10000, route: i % 2 ? 'responses' : 'chat', clientId: 'strata-manager.desktop', model, outcome: 'succeeded', httpStatus: 200, stream: true, inputTokens: 4096, outputTokens: 384, cacheReadTokens: 1024, firstTokenS: 3.51, durationS: 15.79, errorKind: null, mcpToolCalls: 2, inferenceRuns: 3 }));
      const data = action === 'trends' ? { bucketMs: 3600000, buckets: Array.from({ length: 24 }, (_, i) => ({ startMs: now - (24 - i) * 3600000, requests: i + 1, succeeded: i + 1, failed: 0, cancelled: 0, inputTokens: (i + 1) * 2048, outputTokens: (i + 1) * 128 })) } : action === 'requests' ? { items: rows, nextCursor: null, snapshotRowId: 128, limit: 20 } : action === 'request_options' ? { clients: ['strata-manager.desktop'], models: [model], unknownClient: false, unknownModel: false, truncated: false } : action === 'recent' ? rows : summary;
      return { data, coverage };
    }
    return original(command, args);
  };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { f.documentation.copied.push(value); } } });
})();
