// Additions belong only to the unreleased screenshot fixture. All settings and
// calls stay in this browser's isolated memory; no actual native IPC is present.
(() => {
  const f = window.__fixture, native = window.__TAURI_INTERNALS__, original = native.invoke;
  const query = new URLSearchParams(location.search), floating = query.get('window') === 'monitor';
  const floatingDefinition = window.__captureFloatingDefinition;
  if (!floatingDefinition?.preferencesAreCurrentDefaults) throw Error('Native floating dimensions/default preferences were not prepared');
  const preferences = structuredClone(floatingDefinition.preferences);
  f.documentation.captureBlockedOperations = [];
  f.documentation.currentAppVersion = '0.1.5';
  f.documentation.nextAppVersionExample = '0.1.6';
  const deny = operation => { f.documentation.captureBlockedOperations.push(operation); throw Error(`Screenshot operation blocked: ${operation}`); };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => deny('clipboard.writeText'), write: async () => deny('clipboard.write') } });
  const anchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (...args) {
    if (this.download || this.href.startsWith('blob:')) deny('browser.download');
    return anchorClick.apply(this,args);
  };
  f.store.settings.floatingMonitor = preferences;
  f.documentation.unreleasedCapture = { view: query.get('view'), floatingMonitorPreferences: preferences, preferencesAreCurrentDefaults: true, floatingDefinition, quickSpeedTestTriggered: false, nativeContextMenuCaptured: false, realNativeMenuOrWindowActionsVerified: false };
  // The standalone scenario page starts with its actual serial defaults. Do not
  // mislabel the pre-existing synthetic pressure report as a serial measurement.
  if (['benchmark', 'scenario-benchmark'].includes(query.get('view'))) {
    f.store.benchmarkReportsV1 = [];
    f.store.contextBenchmarkReportsV1 = [];
    localStorage.removeItem('benchmark-fixture-reports');
  }
  if (query.get('view') === 'benchmark-report') {
    const en = query.get('language') === 'en', startedAt = Date.UTC(2026, 9, 12, 0, 0, 0);
    const model = f.profiles[0].name, tiers = [8192, 32768, 65536];
    const label = en ? 'Demonstration data · not measured' : '演示数据 · 非实测';
    const samples = tiers.map((targetTokens, index) => ({
      index, round: 1, targetTokens, targetPromptTokens: targetTokens - 640, model,
      state: 'completed', startedAt: startedAt + index * 60000, ttftMs: 1500 + index * 1200,
      wallMs: 12000 + index * 8500, inputChars: (targetTokens - 640) * 4,
      tokenCountMethod: 'count_tokens', countedPromptTokens: targetTokens - 640,
      estimatedPromptTokens: targetTokens - 640, promptTokens: targetTokens - 640,
      completionTokens: 384, cachedTokens: 0, prefillTokS: 2400 - index * 240,
      decodeTokS: 42 - index * 4, peakGpuMemory: (18 + index * 2) * 2 ** 30,
      minGpuMemoryFree: (14 - index * 2) * 2 ** 30, peakRam: (26 + index * 3) * 2 ** 30,
      resourceSamples: 12 + index * 8, output: en ? 'Synthetic screenshot example. No inference was run.' : '截图合成示例，没有运行推理。', finishReason: 'stop',
    }));
    f.store.contextBenchmarkReportsV1 = [{ schemaVersion: 3, id: 'screenshot-demo-only', profileId: 'a', profileName: label,
      baseUrl: f.profiles[0].baseUrl, model, maxContext: 131072, startedAt, finishedAt: startedAt + 180000, elapsedMs: 180000,
      options: { tiers, rounds: 1, maxTokens: 512, timeoutMs: 120000, stopOnError: true, configurationLabel: label },
      samples, skippedTiers: [], state: 'completed', stopReason: 'completed', resourceScope: 'system', resourceIntervalMs: 1000,
      hardware: { description: 'Synthetic screenshot data. Not a hardware measurement.' }, engine: { documentationExample: true, model, max_context: 131072 },
    }];
    f.store.benchmarkReportsV1 = [];
    f.documentation.unreleasedCapture.reportDataIsSyntheticNotMeasured = true;
    f.documentation.unreleasedCapture.reportSchemaVersion = 3;
  }
  let listener = 90000;
  native.invoke = async (command, args = {}) => {
    if (floating && command === 'plugin:window|set_size') {
      const size = args.value?.size ?? args.value?.Logical ?? args.value?.data ?? args.size?.data ?? args.size?.Logical ?? args.size;
      if (size?.width !== floatingDefinition.width || size?.height !== floatingDefinition.height) return deny('unexpected-native-window-size');
      f.calls.push({ command, args: structuredClone(args), synthetic: true, nativeExecuted: false });
      return null;
    }
    if (command === 'read_config_snapshot') {
      const profileId = args.profile?.id ?? 'a';
      f.calls.push({ command, args: structuredClone(args), synthetic: true });
      return { config: structuredClone(f.configs[profileId]), revision: `screenshot-fixture-${profileId}` };
    }
    if (floating && ['plugin:event|listen', 'plugin:event|unlisten'].includes(command)) {
      f.calls.push({ command, args: structuredClone(args), synthetic: true });
      return command.endsWith('|listen') ? ++listener : null;
    }
    const result = await original(command, args);
    if (floating && command === 'monitor_snapshot') return { ...result, settings: { ...result.settings, floatingMonitor: preferences } };
    return result;
  };
})();
