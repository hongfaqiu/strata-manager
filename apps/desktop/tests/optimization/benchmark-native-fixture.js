// Extends only the isolated in-memory native fixture. No model or native service
// is contacted. Synthetic store persistence uses this browser context's storage.
(() => {
  const fixture = window.__fixture;
  const internal = window.__TAURI_INTERNALS__;
  const originalInvoke = internal.invoke;
  const originalTransform = internal.transformCallback;
  const channelCallbacks = new Map();
  const pending = new Map();
  const query = new URLSearchParams(location.search);
  const benchmark = { mode: 'complete', stopped: query.has('stopped'), model: 'Fixture A', streams: [], cancelled: [], delayMs: 80, active: 0, peak: 0, events: [], errorEvery: 0, live: { state: 'idle', running: 0, queued: 0, slots: [] } };
  fixture.benchmark = benchmark;
  fixture.capability = 1;
  fixture.store.settings.language = query.get('language') === 'en' ? 'en' : 'zh-CN';
  fixture.store.conversations[0].messages = [];
  const saved = localStorage.getItem('benchmark-fixture-reports');
  if (saved) fixture.store.benchmarkReportsV1 = JSON.parse(saved);
  internal.transformCallback = callback => {
    const id = originalTransform(callback); channelCallbacks.set(id, callback); return id;
  };
  internal.invoke = async (command, args = {}) => {
    const record = () => fixture.calls.push({ command, args: structuredClone(args) });
    if (command === 'store_set' && args.key === 'benchmarkReportsV1') {
      await originalInvoke(command, args);
      localStorage.setItem('benchmark-fixture-reports', JSON.stringify(args.value)); return;
    }
    if (command === 'service_status') {
      record(); const id = args.profileId ?? args.profile?.id ?? 'a';
      const running = id === 'a' && !benchmark.stopped;
      return { profileId: id, running, owned: running, pid: running ? 99999 : null, phase: running ? 'ready' : 'stopped' };
    }
    if (command === 'strata_request' && args.path === '/health') {
      record(); return { service: 'strata', status: 'ok', loaded: !benchmark.stopped, model: benchmark.model, max_context: 8192 };
    }
    if (command === 'strata_request' && args.path === '/v1/status') { record(); return fixture.featureStatus; }
    if (command === 'strata_request' && args.path === '/metrics') {
      record(); return { engine: { version: 'fixture-benchmark', model: benchmark.model, max_context: 8192, prompt_per_second: 99999 }, hardware: { gpu: 'Synthetic GPU', cpu: 12, gpu_util: Math.min(100, benchmark.active * 20), gpu_mem_used: 4 * 1024 ** 3, ram_used: 8 * 1024 ** 3, gpu_temp: 48 }, live: { ...structuredClone(benchmark.live), ...(benchmark.active ? { running: benchmark.active, state: 'generating' } : {}) } };
    }
    if (command === 'chat_runtime_evidence') { record(); return fixture.runtimeEvidence; }
    if (command === 'local_runtime_installation') {
      record(); return { detectedRuntimes: [{ installDir: 'fixture/a', pythonPath: 'fixture/python.exe', readiness: 'ready', runtimeVersion: '0.1.1', profile: fixture.profiles[0] }] };
    }
    if (command === 'runtime_update_info') {
      record(); return { checkedAt: 123, supportedVersion: '0.1.1', supportedRevision: 'fixture', latestVersion: '0.1.2', assets: [], updateAvailable: true, installable: true };
    }
    if (command === 'analytics_query') {
      record(); const distribution = { samples: 0, p50: null, p95: null };
      const action = args.query?.action;
      const data = action === 'trends' ? { bucketMs: 3600000, buckets: [] }
        : action === 'requests' ? { items: [], nextCursor: null, snapshotRowId: 0, limit: 20 }
        : action === 'request_options' ? { clients: [], models: [], unknownClient: false, unknownModel: false, truncated: false }
        : { startMs: Date.now(), endMs: Date.now(), http: { requests: 0, inputTokenSamples: 0, outputTokenSamples: 0 }, inference: { runs: 0, cacheRateSamples: 0, expertCacheSamples: 0 }, groups: [], ttftS: distribution, durationS: distribution, decodeTokS: distribution, prefillTokS: distribution };
      return { data, coverage: { gaps: [], sessions: [], observerStatuses: [], collectionScope: [], journalPresent: false, historyRetentionDays: 90 } };
    }
    if (command === 'cancel_stream') {
      record(); benchmark.cancelled.push(args.requestId); pending.get(args.requestId)?.(); return;
    }
    if (command === 'strata_stream') {
      record(); benchmark.streams.push(structuredClone(args));
      const number = benchmark.streams.length, callback = channelCallbacks.get(args.onEvent.id);
      const mode = benchmark.errorEvery && number % benchmark.errorEvery === 0 ? 'error' : benchmark.mode;
      benchmark.active++; benchmark.peak = Math.max(benchmark.peak, benchmark.active);
      benchmark.events.push({ type: 'start', number, at: performance.now(), active: benchmark.active });
      await new Promise((resolve, reject) => {
        let index = 0, finished = false;
        const send = message => callback?.({ index: index++, message });
        const finish = error => { if (finished) return; finished = true; pending.delete(args.requestId); benchmark.active--; benchmark.events.push({ type: 'end', number, at: performance.now(), active: benchmark.active }); callback?.({ index, end: true }); if (error) reject(error); else resolve(); };
        pending.set(args.requestId, finish);
        setTimeout(() => {
          if (finished) return;
          send({ kind: 'data', data: `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: `fixture reasoning ${number}` } }] })}\n\n` });
          if (mode === 'hold') return;
          setTimeout(() => {
            if (finished) return;
            if (mode === 'error') { finish(Error('HTTP 503: Synthetic benchmark failure')); return; }
            const warmup = args.body.messages[0].content.includes('/warmup');
            const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: `fixture output ${number}` }, finish_reason: 'length' }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: warmup ? 100 : 40 } }, timings: { prompt_per_second: warmup ? 5000 : 1250, predicted_per_second: warmup ? 1000 : 80 } })}\n\n`;
            // Split at an arbitrary byte boundary to exercise streaming assembly.
            send({ kind: 'data', data: payload.slice(0, 41) });
            send({ kind: 'data', data: payload.slice(41) });
            if (mode !== 'incomplete') send({ kind: 'data', data: 'data: [DONE]\n\n' });
            send({ kind: 'done' }); finish();
          }, benchmark.delayMs);
        }, benchmark.delayMs);
      });
      return;
    }
    return originalInvoke(command, args);
  };
})();
