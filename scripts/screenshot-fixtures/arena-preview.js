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
  // 「官方基准」 board: official-method rows plus the maintainers' published numbers as unranked reference rows.
  const metrics = (chat, scale = 1) => ({ chatDecodeTps: chat, chatTtftS: +(0.5 + 10 / chat).toFixed(2), p4kTps: Math.round(chat * 17 * scale), p16kTps: Math.round(chat * 18.5 * scale), p32kTps: Math.round(chat * 17.6 * scale), agentDecodeTps: +(chat * 1.04).toFixed(1), agentHitPct: 70 });
  const orow = (rank, gpu, vramGB, ramGB, p, machines, confidence, chat, scale) => ({ rank, hw: { gpu, vramGB, ramGB }, params: p, seed: false, machines, confidence, metrics: metrics(chat, scale), spread: { p25: +(chat * 0.95).toFixed(1), p75: +(chat * 1.04).toFixed(1) } });
  const official = { computedAt: Date.now() - 18 * 60000, machines: 37, runs: 102, groups: [
    { group: 'qwen:IQ3_S', family: 'qwen', quant: 'IQ3_S', machines: 21, seedMachines: 0, configs: 6, best: 52.3, references: 1 },
    { group: 'swift:IQ3_S', family: 'swift', quant: 'IQ3_S', machines: 16, seedMachines: 0, configs: 5, best: 41.6, references: 0 },
    { group: 'deepseek41:IST-DAS-2.00bpw', family: 'deepseek41', quant: 'IST-DAS-2.00bpw', machines: 0, seedMachines: 0, configs: 0, best: null, references: 1 },
    { group: 'qwen:NVFP4-QAD', family: 'qwen', quant: 'NVFP4-QAD', machines: 0, seedMachines: 0, configs: 0, best: null, references: 1 },
  ], rows: [
    orow(1, 'RTX 5090', 32, 128, params(131072, 'int8'), 4, 'medium', 52.3, 2.4), orow(2, 'RTX 4090', 24, 96, params(131072, 'int8'), 9, 'high', 46.8, 1.9),
    orow(3, 'AMD Radeon(TM) 8060S Graphics', 96, 128, params(131072, 'int8'), 5, 'medium', 43.1, 1), orow(4, 'RTX 3090', 24, 128, params(65536, 'int8'), 3, 'low', 37.4, 1.4),
  ], references: [{ official: true, id: 'strix-halo-windows-qwen-iq3s-0.2.7', group: 'qwen:IQ3_S', family: 'qwen', quant: 'IQ3_S', hardware: 'Ryzen AI Max+ 395 · Radeon 8060S (Strix Halo)', setup: 'strata launch 默认参数 · 131,072 上下文 · int8 KV',
    measured: { date: '2026-10-26', strata: '0.2.7 RC' }, source: { title: 'docs/STRIX_HALO_WINDOWS.md §1', url: 'https://github.com/Niko1221/Strata/blob/46c152a1310f77cd2f0ce2c7cd213962df14fe83/docs/STRIX_HALO_WINDOWS.md#1-what-this-pc-reaches' },
    metrics: { chatDecodeTps: 44, chatTtftS: 0.6, p4kTps: 755, p16kTps: 821, p32kTps: 792, agentDecodeTps: 47, agentHitPct: 69 }, printed: { chatDecodeTps: '44.0' } }] };
  const officialKey = { chatDecode: 'chatDecodeTps', prefill4k: 'p4kTps', prefill16k: 'p16kTps', prefill32k: 'p32kTps', agentDecode: 'agentDecodeTps' };
  const officialBoard = query => {
    const sort = query?.sort ?? 'chatDecode', key = officialKey[sort], group = query?.group ?? 'qwen:IQ3_S';
    const value = r => sort === 'machines' ? r.machines : r.metrics[key];
    const rows = group === 'qwen:IQ3_S' ? structuredClone(official.rows).sort((a, b) => value(b) - value(a)).map((r, i) => ({ ...r, rank: i + 1 })) : [];
    const summary = official.groups.find(g => g.group === group);
    return { computedAt: official.computedAt, machines: official.machines, runs: official.runs, groups: structuredClone(official.groups), group, family: summary?.family, quant: summary?.quant, total: rows.length, sort, rows,
      median: rows.length ? value(rows[Math.floor(rows.length / 2)]) : null, references: structuredClone(official.references.filter(r => r.group === group)) };
  };
  window.__arenaPreview = { groups, boards, fallback, recommendation, status, official };
  let bridge;
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, get: () => bridge, set: value => {
    const original = value.invoke.bind(value);
    value.invoke = async (command, args = {}) => {
      if (command === 'arena_get') {
        if (args.path === 'groups') return structuredClone(groups);
        if (args.path === 'leaderboard') { const group = args.query?.group ?? 'swift:IQ3_S'; const summary = groups.groups.find(item => item.group === group) ?? groups.groups[0]; const rows = boards[group] ?? fallback(group); return { ...structuredClone(summary), group, rows: structuredClone(rows), tierMedian: rows[Math.floor(rows.length / 2)].decode.median }; }
        if (args.path === 'recommend') return structuredClone(recommendation);
        if (args.path === 'official') return officialBoard(args.query);
      }
      if (command === 'arena_status' || command === 'arena_flush' || command === 'arena_set_auto_upload') return structuredClone(status);
      return original(command, args);
    };
    bridge = value;
  } });
})();
