// Synthetic metadata and usage for the isolated browser fixture only. Token
// counts use characters / 4 plus a template allowance, never a real tokenizer.
(() => {
  const fixture = window.__fixture, internal = window.__TAURI_INTERNALS__;
  const previousInvoke = internal.invoke, previousTransform = internal.transformCallback;
  const streamUsage = new Map();
  const params = new URLSearchParams(location.search);
  const requestedContext = params.has('maxContext') ? Number(params.get('maxContext')) : 32768;
  const context = { maxContext: requestedContext || null, capacities: { b: 65536 }, runningProfiles: ['a'], countUnavailable: false, counts: [] };
  fixture.contextBenchmark = context;
  for (const [id, config] of Object.entries(fixture.configs)) config.args.push('--max-context', String(context.capacities[id] ?? context.maxContext ?? 0));
  const saved = localStorage.getItem('context-benchmark-fixture-reports');
  if (saved) fixture.store.contextBenchmarkReportsV1 = JSON.parse(saved);
  const syntheticCount = body => Math.ceil(body.messages.reduce((sum, message) => sum + String(message.content ?? '').length, 0) / 4) + 16;
  internal.transformCallback = callback => {
    let id;
    id = previousTransform(event => {
      const usage = streamUsage.get(id);
      if (usage && event.message?.kind === 'data') {
        event = { ...event, message: { ...event.message, data: event.message.data
          .replace(/"prompt_tokens":100/g, `"prompt_tokens":${usage.prompt}`)
          .replace(/"completion_tokens":10/g, `"completion_tokens":${usage.completion}`)
          .replace(/"cached_tokens":40/g, '"cached_tokens":0') } };
      }
      callback(event);
    });
    return id;
  };
  internal.invoke = async (command, args = {}) => {
    const profileId = args.profile?.id ?? args.profileId ?? 'a';
    const maxContext = context.capacities[profileId] ?? context.maxContext;
    if (command === 'service_status' && profileId !== 'a' && context.runningProfiles.includes(profileId)) {
      fixture.calls.push({ command, args: structuredClone(args) });
      return { profileId, running: true, owned: true, pid: 99998, phase: 'ready' };
    }
    if (command === 'store_set' && args.key === 'contextBenchmarkReportsV1') {
      await previousInvoke(command, args);
      localStorage.setItem('context-benchmark-fixture-reports', JSON.stringify(args.value)); return;
    }
    if (command === 'strata_request' && args.path === '/v1/messages/count_tokens') {
      fixture.calls.push({ command, args: structuredClone(args) });
      if (context.countUnavailable) throw Error('HTTP 404: Synthetic tokenizer endpoint unavailable');
      const tokens = syntheticCount(args.body);
      context.counts.push({ inputTokens: tokens, inputChars: String(args.body.messages[0].content).length });
      return { input_tokens: tokens };
    }
    if (command === 'strata_request' && args.path === '/health') {
      const health = await previousInvoke(command, args);
      return { ...health, max_context: maxContext, ...(profileId !== 'a' ? { model: args.profile.name, loaded: context.runningProfiles.includes(profileId) } : {}) };
    }
    if (command === 'strata_request' && args.path === '/metrics') {
      const metrics = await previousInvoke(command, args);
      return { ...metrics, engine: { ...metrics.engine, max_context: maxContext, ...(profileId !== 'a' ? { model: args.profile.name } : {}) }, hardware: { ...metrics.hardware, gpu_mem_total: 8 * 1024 ** 3 } };
    }
    if (command === 'strata_stream' && String(args.body?.messages?.[0]?.content).includes(' context-benchmark ')) {
      streamUsage.set(args.onEvent.id, { prompt: syntheticCount(args.body), completion: args.body.max_tokens });
      try { return await previousInvoke(command, args); }
      finally { streamUsage.delete(args.onEvent.id); }
    }
    return previousInvoke(command, args);
  };
})();
