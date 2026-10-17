import { vramTier, ramTier } from './schema.js';

export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
export const median = values => { const s = values.filter(v => v !== null && Number.isFinite(v)).sort((a, b) => a - b); return quantile(s, 0.5); };
const r1 = v => v === null ? null : Math.round(v * 10) / 10;

/** Drops machine medians that are robust outliers: |x - median| > 3.5 * 1.4826 * MAD, or beyond 3x / 0.33x of the median. */
export function filterOutliers(values) {
  if (values.length < 3) return values;
  const m = median(values.map(v => v.decode));
  const ratioOk = values.filter(v => v.decode <= m * 3 && v.decode >= m / 3);
  if (ratioOk.length < 5) return ratioOk;
  const mad = median(ratioOk.map(v => Math.abs(v.decode - m)));
  if (!mad) return ratioOk;
  return ratioOk.filter(v => Math.abs(v.decode - m) <= 3.5 * 1.4826 * mad);
}

export const PARAM_KEYS = ['ctx', 'kv', 'parallel', 'poolWorkers', 'expertCache', 'pcieFrac', 'gpuCount', 'vision'];
export const confidence = n => n >= 25 ? 'high' : n >= 10 ? 'medium' : n >= 3 ? 'low' : 'none';
export const MIN_MACHINES = 3;
/** A verified run forms a row on its own; rows with fewer than MIN_MACHINES are labeled low-confidence and never drive recommendations. */
export const MIN_ROW_MACHINES = 1;

/**
 * Builds leaderboard rows from raw submissions.
 * Group = model family + quant. Row = one hardware + key-parameter configuration inside the group.
 * Each machine contributes the median of its latest three runs, so one machine cannot dominate a row.
 */
export function aggregate(subs) {
  const groups = new Map();
  for (const s of subs) {
    if (s.decode_8k === null || s.decode_8k === undefined) continue;
    const gk = `${s.family}:${s.quant}`;
    const params = { ctx: s.ctx, kv: s.kv, parallel: s.parallel, poolWorkers: s.pool_workers, expertCache: s.expert_cache, pcieFrac: s.pcie_frac, gpuCount: s.gpu_count, vision: !!s.vision };
    const hw = { gpu: s.gpu_name ?? 'CPU', vramGB: vramTier(s.vram_gb), ramGB: ramTier(s.ram_gb) };
    const ck = JSON.stringify([hw.gpu, hw.vramGB, hw.ramGB, ...PARAM_KEYS.map(k => params[k]), s.seed ? 1 : 0]);
    if (!groups.has(gk)) groups.set(gk, { family: s.family, quant: s.quant, configs: new Map(), machines: new Set(), seedMachines: new Set() });
    const g = groups.get(gk);
    (s.seed ? g.seedMachines : g.machines).add(s.install_hash);
    if (!g.configs.has(ck)) g.configs.set(ck, { hw, params, seed: !!s.seed, runs: new Map() });
    const c = g.configs.get(ck);
    if (!c.runs.has(s.install_hash)) c.runs.set(s.install_hash, []);
    c.runs.get(s.install_hash).push(s);
  }
  const out = [];
  for (const g of groups.values()) {
    const rows = [];
    for (const c of g.configs.values()) {
      const machines = [...c.runs.values()].map(runs => {
        const latest = runs.sort((a, b) => b.received_at - a.received_at).slice(0, 3);
        return { decode: median(latest.map(r => r.decode_8k)), prefill: median(latest.map(r => r.prefill_8k)), ttft: median(latest.map(r => r.ttft_8k_ms)),
          d32: median(latest.map(r => r.decode_32k)), d128: median(latest.map(r => r.decode_128k)), ram: median(latest.map(r => r.peak_ram_gb)), vram: median(latest.map(r => r.peak_vram_gb)) };
      });
      const kept = filterOutliers(machines);
      if (!kept.length || (!c.seed && kept.length < MIN_ROW_MACHINES)) continue;
      const d = kept.map(m => m.decode).sort((a, b) => a - b);
      rows.push({ hw: c.hw, params: c.params, seed: c.seed, machines: kept.length, confidence: c.seed ? 'seed' : confidence(kept.length),
        decode: { p25: r1(quantile(d, 0.25)), median: r1(quantile(d, 0.5)), p75: r1(quantile(d, 0.75)) },
        prefill: r1(median(kept.map(m => m.prefill))), ttftMs: Math.round(median(kept.map(m => m.ttft)) ?? 0) || null,
        decode32k: r1(median(kept.map(m => m.d32))), decode128k: r1(median(kept.map(m => m.d128))),
        peakRamGB: r1(median(kept.map(m => m.ram))), peakVramGB: r1(median(kept.map(m => m.vram))) });
    }
    rows.sort((a, b) => b.decode.median - a.decode.median);
    if (!rows.length) continue;
    const gpus = new Map();
    for (const r of rows) { const k = `${r.hw.gpu}|${r.hw.vramGB}`; gpus.set(k, (gpus.get(k) ?? 0) + r.machines); }
    out.push({ group: `${g.family}:${g.quant}`, family: g.family, quant: g.quant, machines: g.machines.size, seedMachines: g.seedMachines.size, configs: rows.length,
      bestDecode: rows.find(r => !r.seed)?.decode.median ?? rows[0].decode.median,
      gpus: [...gpus].map(([k, n]) => { const [gpu, vram] = k.split('|'); return { gpu, vramGB: Number(vram), machines: n }; }).sort((a, b) => b.machines - a.machines),
      rows });
  }
  return out.sort((a, b) => b.machines - a.machines);
}

/** Filters a group's rows to a GPU (exact name) or VRAM tier and re-ranks. */
export function filterRows(group, { gpu, vram } = {}) {
  let rows = group.rows;
  if (gpu) rows = rows.filter(r => r.hw.gpu === gpu);
  else if (vram) rows = rows.filter(r => r.hw.vramGB === vramTier(Number(vram)));
  const ref = median(rows.filter(r => !r.seed).map(r => r.decode.median));
  return { rows: rows.map((r, i) => ({ rank: i + 1, ...r })), tierMedian: r1(ref) };
}

const SCENE_FIELD = { chat: r => r.decode.median, long: r => r.decode128k, code: r => r.decode32k };

/**
 * Recommendation v1. Prefers comparisons inside the user's own model + quant: the same weights on similar hardware,
 * differing only in launch parameters, so the effect of each parameter is visible. Other models come second.
 */
export function recommend(groups, q) {
  const scene = SCENE_FIELD[q.scene] ? q.scene : 'chat', speed = SCENE_FIELD[scene];
  const fits = r => !(q.ramGB && r.peakRamGB !== null && r.peakRamGB > q.ramGB * 0.92) && !(q.vramGB && r.peakVramGB !== null && r.hw.gpu !== 'CPU' && r.peakVramGB > q.vramGB * (r.params.gpuCount || 1) * 1.02);
  const levels = [['gpu', r => q.gpu && r.hw.gpu === q.gpu], ['vram', r => q.vramGB && r.hw.vramGB === vramTier(q.vramGB)]];
  const similar = rows => { for (const [level, match] of levels) { const hit = rows.filter(r => match(r) && fits(r) && speed(r) !== null); if (hit.length) return { level, rows: hit }; } return { level: 'none', rows: [] }; };
  const ranked = rows => [...rows].sort((a, b) => (b.seed ? 0 : 1) - (a.seed ? 0 : 1) || speed(b) - speed(a));
  const view = r => ({ hw: r.hw, params: r.params, seed: r.seed, machines: r.machines, confidence: r.confidence, speed: speed(r), decode: r.decode, peakRamGB: r.peakRamGB, peakVramGB: r.peakVramGB });

  let sameModel = null;
  const mine = q.family && q.quant ? groups.find(g => g.family === q.family && g.quant === q.quant) : undefined;
  if (mine) {
    const { level, rows } = similar(mine.rows);
    const best = ranked(rows).find(r => r.machines >= MIN_MACHINES || r.seed);
    const current = q.params ? rows.find(r => PARAM_KEYS.every(k => q.params[k] === undefined || r.params[k] === q.params[k])) : undefined;
    const changes = [];
    if (current) {
      for (const k of PARAM_KEYS) {
        // Rows identical to the current configuration except for this one parameter.
        for (const alt of rows) {
          if (alt === current || alt.params[k] === current.params[k] || alt.hw.gpu !== current.hw.gpu) continue;
          if (!PARAM_KEYS.every(o => o === k || alt.params[o] === current.params[o])) continue;
          if (alt.machines < MIN_MACHINES && !alt.seed) continue;
          const gain = (speed(alt) - speed(current)) / speed(current);
          if (gain >= 0.05) changes.push({ param: k, from: current.params[k], to: alt.params[k], gainPct: Math.round(gain * 100), machines: alt.machines, confidence: alt.confidence, peakRamGB: alt.peakRamGB });
        }
      }
      changes.sort((a, b) => b.gainPct - a.gainPct);
    }
    sameModel = { group: mine.group, level, best: best ? view(best) : null, current: current ? view(current) : null, changes: changes.slice(0, 5),
      alternatives: ranked(rows).slice(0, 5).map(view) };
  }
  const others = [];
  for (const g of groups) {
    if (mine && g === mine) continue;
    const { level, rows } = similar(g.rows);
    const best = ranked(rows).find(r => r.machines >= MIN_MACHINES);
    if (best) others.push({ group: g.group, family: g.family, quant: g.quant, level, ...view(best) });
  }
  others.sort((a, b) => (a.level === 'gpu' ? 0 : 1) - (b.level === 'gpu' ? 0 : 1) || b.speed - a.speed);
  const level = sameModel?.level !== 'none' && sameModel ? sameModel.level : others[0]?.level ?? 'none';
  return { scene, level, sameModel, otherModels: others.slice(0, 5) };
}
