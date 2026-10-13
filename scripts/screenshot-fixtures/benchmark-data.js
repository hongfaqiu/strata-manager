// Real App/BenchmarkPage; only RPC data and saved reports are synthetic.
// This script does not start a service, access model files or run inference.
(() => {
  const fixture = window.__fixture;
  const language = new URLSearchParams(location.search).get('language') === 'en' ? 'en' : 'zh-CN';
  const model = language === 'en' ? 'Local model · example' : '本地模型 · 示例';
  fixture.store.settings = { ...fixture.store.settings, language, theme: 'light', autoCheckUpdates: false, pollInterval: 60_000 };
  fixture.profiles[0].name = model;
  fixture.configs.a.model_name = model;
  fixture.benchmark.model = model;
  const startedAt = Date.UTC(2026, 9, 12, 0, 0, 0);
  const options = {
    kind: 'stress', scenarios: ['short', 'code', 'cache'], prompt: 'Documentation example only.',
    rounds: 2, maxTokens: 256, inputChars: 8192, conversationTurns: 3, warmup: false,
    mode: 'unique', timeoutMs: 120_000, concurrency: 4, stressPattern: 'ramp',
    stressLimit: 'duration', requestLimit: 18, durationMs: 180_000,
    stageDurationMs: 60_000, requestDelayMs: 0, stopOnError: false,
  };
  const samples = Array.from({ length: 18 }, (_, index) => {
    const scenario = ['short', 'code', 'cache'][index % 3];
    const stage = Math.floor(index / 6) + 1;
    return {
    index: index + 1, scenario, stage, concurrency: [1, 2, 4][stage - 1], worker: index % [1, 2, 4][stage - 1] + 1,
    conversationId: null, turn: 1, inputChars: scenario === 'short' ? 80 : 1800,
    maxTokens: 256, warmup: false, state: 'completed', startedAt: startedAt + index * 10_000,
    ttftMs: [420, 780, 180, 440, 810, 160][index % 6], wallMs: [3600, 6400, 4200, 3800, 6600, 4000][index % 6],
    promptTokens: scenario === 'short' ? 32 : 1024, completionTokens: scenario === 'short' ? 120 : 256,
    cachedTokens: scenario === 'cache' ? 896 : 0, prefillTokS: scenario === 'cache' ? 4200 : 1600,
    decodeTokS: [36, 40, 42, 37, 39, 43][index % 6], finishReason: 'stop',
    output: language === 'en' ? 'Synthetic documentation output. No real inference was performed.' : '文档演示输出。未执行真实推理。',
  }; });
  const stages = [1, 2, 4].map((concurrency, index) => ({ index: index + 1, concurrency,
    startedAt: startedAt + index * 60_000, finishedAt: startedAt + (index + 1) * 60_000, elapsedMs: 60_000 }));
  const telemetry = Array.from({ length: 60 }, (_, index) => ({
    at: startedAt + index * 3000, elapsedMs: index * 3000,
    active: [1, 2, 4][Math.floor(index / 20)], running: 1,
    queued: index > 40 ? 2 : index > 20 ? 1 : 0,
    cpuUtil: 12 + Math.sin(index * .3) * 4 + Math.floor(index / 20) * 3,
    gpuUtil: 44 + Math.sin(index * .5) * 9 + Math.floor(index / 20) * 8,
    gpuMemoryUsed: (7.6 + Math.sin(index * .2) * .12) * 2 ** 30,
    ramUsed: (18 + Math.sin(index * .15) * .3) * 2 ** 30, gpuTemperature: 48,
  }));
  fixture.store.benchmarkReportsV1 = [{
    schemaVersion: 2, id: 'documentation-example', profileId: 'a', profileName: model,
    baseUrl: fixture.profiles[0].baseUrl, model, startedAt, finishedAt: startedAt + 180_000,
    elapsedMs: 180_000, measurementElapsedMs: 180_000, options, samples, stages,
    telemetry, state: 'completed', stopReason: 'requestLimit',
    engine: { version: '0.1.43', model, documentationExample: true },
    hardware: { description: 'Synthetic documentation data; no hardware measurement' },
  }];
  window.__benchmarkDocumentation = {
    source: 'Real App and BenchmarkPage components imported by src/main.tsx',
    scope: 'All native RPC, service states, model identity, reports and metrics are synthetic. No inference, file access, update or service lifecycle operation.',
    language,
  };
})();
