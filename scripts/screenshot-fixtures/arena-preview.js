// Synthetic Benchmark leaderboard data for documentation screenshots. Served only
// through the mocked native `arena_get`; the webview never reaches the network.
(() => {
  const params = (ctx, kv, parallel = 1, gpuCount = 1) => ({ ctx, kv, gpuCount, parallel, poolWorkers: null, expertCache: null, pcieFrac: null, vision: false });
  const row = (rank, gpu, vramGB, ramGB, p, machines, confidence, median, extra = {}) => ({ rank, hw: { gpu, vramGB, ramGB }, params: p, seed: false, machines, confidence,
    decode: { p25: +(median * 0.94).toFixed(1), median, p75: +(median * 1.05).toFixed(1) }, prefill: Math.round(median * 52), ttftMs: Math.round(42000 / median), decode32k: +(median * 0.9).toFixed(1), decode128k: +(median * 0.74).toFixed(1), peakRamGB: extra.ram ?? 48, peakVramGB: extra.vram ?? Math.min(vramGB - 1, 22) });
  const groups = { computedAt: Date.now() - 18 * 60000, machines: 128, runs: 611, groups: [
    { group: 'swift:IQ3_S', family: 'swift', quant: 'IQ3_S', machines: 46, seedMachines: 0, configs: 19, bestDecode: 41.6, gpus: [{ gpu: 'RTX 4090', vramGB: 24, machines: 18 }, { gpu: 'RTX 3090', vramGB: 24, machines: 13 }, { gpu: 'RTX 4080 SUPER', vramGB: 16, machines: 9 }, { gpu: 'RTX 5090', vramGB: 32, machines: 6 }] },
    { group: 'qwen:IQ3_S', family: 'qwen', quant: 'IQ3_S', machines: 31, seedMachines: 0, configs: 12, bestDecode: 37.9, gpus: [{ gpu: 'RTX 4090', vramGB: 24, machines: 14 }, { gpu: 'RTX 3090', vramGB: 24, machines: 10 }, { gpu: 'RTX 4070 Ti SUPER', vramGB: 16, machines: 7 }] },
    { group: 'swift:IQ4_XS', family: 'swift', quant: 'IQ4_XS', machines: 22, seedMachines: 0, configs: 9, bestDecode: 33.2, gpus: [{ gpu: 'RTX 5090', vramGB: 32, machines: 8 }, { gpu: 'RTX 4090', vramGB: 24, machines: 14 }] },
    { group: 'coder:IQ1_M', family: 'coder', quant: 'IQ1_M', machines: 12, seedMachines: 0, configs: 5, bestDecode: 35.4, gpus: [{ gpu: 'RTX 4090', vramGB: 24, machines: 7 }, { gpu: 'RTX 3090', vramGB: 24, machines: 5 }] },
  ] };
  const boards = {
    'swift:IQ3_S': [row(1, 'RTX 5090', 32, 128, params(65536, 'int8'), 6, 'medium', 41.6, { vram: 30 }), row(2, 'RTX 4090', 24, 96, params(32768, 'int8'), 11, 'high', 38.9), row(3, 'RTX 4090', 24, 64, params(65536, 'q8', 2), 5, 'medium', 36.2), row(4, 'RTX 3090', 24, 128, params(32768, 'int8'), 9, 'high', 33.7), row(5, 'RTX 4080 SUPER', 16, 96, params(32768, 'int8'), 7, 'medium', 30.4, { vram: 15 }), row(6, 'RTX 3090', 24, 64, params(131072, 'q8'), 3, 'low', 27.8), row(7, 'RTX 4070 Ti SUPER', 16, 64, params(16384, 'int8'), 4, 'low', 24.9, { vram: 15 })],
  };
  const fallback = group => (boards['swift:IQ3_S']).map(item => ({ ...item, decode: { ...item.decode, median: +(item.decode.median * (group.startsWith('qwen') ? 0.91 : 0.8)).toFixed(1) } }));
  const recommendRow = { hw: { gpu: 'RTX 4090', vramGB: 24, ramGB: 96 }, params: params(32768, 'int8'), seed: false, machines: 11, confidence: 'high', speed: 38.9, decode: { p25: 36.6, median: 38.9, p75: 40.8 }, peakRamGB: 48, peakVramGB: 22 };
  const recommendation = { scene: 'chat', level: 'gpu', sameModel: { group: 'swift:IQ3_S', level: 'gpu', best: recommendRow, current: { ...recommendRow, params: params(65536, 'q8'), speed: 34.1, decode: { p25: 32.2, median: 34.1, p75: 35.9 }, machines: 4, confidence: 'medium' }, changes: [{ param: 'kv', from: 'q8', to: 'int8', gainPct: 9, machines: 11, confidence: 'high', peakRamGB: 48 }, { param: 'ctx', from: 65536, to: 32768, gainPct: 4, machines: 7, confidence: 'medium', peakRamGB: 44 }], alternatives: [] },
    otherModels: [{ ...recommendRow, group: 'qwen:IQ3_S', family: 'qwen', quant: 'IQ3_S', level: 'gpu', speed: 35.6, decode: { p25: 33.4, median: 35.6, p75: 37.1 } }] };
  const status = { consented: true, consentVersion: 1, autoUpload: true, queued: 0, log: [{ at: Date.now() - 2 * 3600000, kind: 'context', status: 'uploaded', group: 'swift:IQ3_S' }, { at: Date.now() - 26 * 3600000, kind: 'register', status: 'registered' }], endpoint: 'https://strata-manager.cosfoc.com', uploadAvailable: true, registered: true, banned: false };
  window.__arenaPreview = { groups, boards, fallback, recommendation, status };
  let bridge;
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, get: () => bridge, set: value => {
    const original = value.invoke.bind(value);
    value.invoke = async (command, args = {}) => {
      if (command === 'arena_get') {
        if (args.path === 'groups') return structuredClone(groups);
        if (args.path === 'leaderboard') { const group = args.query?.group ?? 'swift:IQ3_S'; const summary = groups.groups.find(item => item.group === group) ?? groups.groups[0]; const rows = boards[group] ?? fallback(group); return { ...structuredClone(summary), group, rows: structuredClone(rows), tierMedian: rows[Math.floor(rows.length / 2)].decode.median }; }
        if (args.path === 'recommend') return structuredClone(recommendation);
      }
      if (command === 'arena_status' || command === 'arena_flush' || command === 'arena_set_auto_upload') return structuredClone(status);
      return original(command, args);
    };
    bridge = value;
  } });
})();
