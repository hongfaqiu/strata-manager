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

/** Leaderboard orderings. Rows without the measured value sort last and stay unranked. */
export const SORTS = { decode8k: r => r.decode?.median ?? null, decode128k: r => r.decode128k ?? null, prefill: r => r.prefill ?? null, machines: r => r.machines ?? null };
export const DEFAULT_SORT = 'decode8k';
/** Facets a group can be narrowed by: hardware tiers and the launch parameters that most change speed. */
export const FACETS = {
  vram: r => r.hw.vramGB, ram: r => r.hw.ramGB,
  ctx: r => r.params.ctx, kv: r => r.params.kv, parallel: r => r.params.parallel, gpuCount: r => r.params.gpuCount, expertCache: r => r.params.expertCache ?? 'auto',
};
export const FILTER_KEYS = ['gpu', 'q', ...Object.keys(FACETS), 'sort'];
const NUMERIC = new Set(['vram', 'ram', 'ctx', 'parallel', 'gpuCount']);
const fin = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

/** Distinct values per facet across the whole group, so clients only offer options that exist. */
export function facetOptions(rows) {
  const gpus = new Map();
  for (const r of rows) { const k = `${r.hw.gpu}|${r.hw.vramGB}`; gpus.set(k, (gpus.get(k) ?? 0) + r.machines); }
  const out = { gpus: [...gpus].map(([k, n]) => { const i = k.lastIndexOf('|'); return { gpu: k.slice(0, i), vramGB: Number(k.slice(i + 1)), machines: n }; }).sort((a, b) => b.machines - a.machines || a.gpu.localeCompare(b.gpu)) };
  for (const [key, get] of Object.entries(FACETS)) {
    const values = [...new Set(rows.map(get).filter(v => v !== null && v !== undefined))];
    out[key] = NUMERIC.has(key) ? values.sort((a, b) => a - b) : values.sort((a, b) => String(a).localeCompare(String(b)));
  }
  return out;
}

/**
 * Narrows a group's rows and re-ranks them.
 * gpu: exact name; q: GPU name keyword; vram / ram: any size, matched to its tier; ctx, kv, parallel, gpuCount, expertCache: exact.
 * sort: one of SORTS (default 8K decode median). Unknown or malformed values are ignored, so older clients keep working.
 */
export function filterRows(group, query = {}) {
  let rows = group.rows;
  const { gpu, q } = query;
  if (gpu) rows = rows.filter(r => r.hw.gpu === gpu);
  if (q && String(q).trim()) { const k = String(q).trim().toLowerCase(); rows = rows.filter(r => String(r.hw.gpu).toLowerCase().includes(k)); }
  if (fin(query.vram)) rows = rows.filter(r => r.hw.vramGB === vramTier(Number(query.vram)));
  if (fin(query.ram)) rows = rows.filter(r => r.hw.ramGB === ramTier(Number(query.ram)));
  for (const key of ['ctx', 'parallel', 'gpuCount']) if (fin(query[key])) rows = rows.filter(r => FACETS[key](r) === Number(query[key]));
  for (const key of ['kv', 'expertCache']) if (query[key]) rows = rows.filter(r => FACETS[key](r) === query[key]);
  const sort = SORTS[query.sort] ? query.sort : DEFAULT_SORT, value = SORTS[sort];
  const ordered = [...rows].sort((a, b) => {
    const va = value(a), vb = value(b);
    if (va === null || vb === null) return (va === null) - (vb === null);
    return vb - va || b.decode.median - a.decode.median;
  });
  const ref = median(ordered.filter(r => !r.seed).map(r => r.decode.median));
  let rank = 0;
  return { sort, rows: ordered.map(r => ({ ...r, rank: value(r) === null ? null : ++rank })), tierMedian: r1(ref) };
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

// ---------- official-method board (tools/strata_bench.py as run in the app) ----------
/** Figures a row carries: per-machine medians of the latest three runs, then the median over machines. */
export const OFFICIAL_ROW_METRICS = Object.freeze({
  chatDecodeTps: 'off_chat_decode', chatTtftS: 'off_chat_ttft_s', p4kTps: 'off_prefill_4k', p16kTps: 'off_prefill_16k', p32kTps: 'off_prefill_32k',
  agentDecodeTps: 'off_agent_decode', agentHitPct: 'off_agent_hit',
});
/** Orderings of the official board. Chat decode, the figure the maintainers headline, is the default. */
export const OFFICIAL_SORTS = {
  chatDecode: r => r.metrics?.chatDecodeTps ?? null, prefill4k: r => r.metrics?.p4kTps ?? null, prefill16k: r => r.metrics?.p16kTps ?? null,
  prefill32k: r => r.metrics?.p32kTps ?? null, agentDecode: r => r.metrics?.agentDecodeTps ?? null, machines: r => r.machines ?? null,
};
export const OFFICIAL_DEFAULT_SORT = 'chatDecode';
const r2 = v => v === null ? null : Math.round(v * 100) / 100;

/** Rows from counting official-method submissions, grouped by model + quant like the context board. */
export function aggregateOfficial(subs) {
  const groups = new Map();
  for (const s of subs) {
    if (s.kind !== 'official' || s.off_chat_decode === null || s.off_chat_decode === undefined) continue;
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
        const m = Object.fromEntries(Object.entries(OFFICIAL_ROW_METRICS).map(([k, col]) => [k, median(latest.map(r => r[col] ?? null))]));
        return { ...m, decode: m.chatDecodeTps };
      });
      const kept = filterOutliers(machines);
      if (!kept.length || (!c.seed && kept.length < MIN_ROW_MACHINES)) continue;
      const d = kept.map(m => m.decode).sort((a, b) => a - b);
      const metrics = Object.fromEntries(Object.keys(OFFICIAL_ROW_METRICS).map(k => [k, k === 'chatTtftS' ? r2(median(kept.map(m => m[k]))) : r1(median(kept.map(m => m[k])))]));
      rows.push({ hw: c.hw, params: c.params, seed: c.seed, machines: kept.length, confidence: c.seed ? 'seed' : confidence(kept.length),
        metrics, spread: { p25: r1(quantile(d, 0.25)), p75: r1(quantile(d, 0.75)) } });
    }
    if (!rows.length) continue;
    rows.sort((a, b) => b.metrics.chatDecodeTps - a.metrics.chatDecodeTps);
    out.push({ group: `${g.family}:${g.quant}`, family: g.family, quant: g.quant, machines: g.machines.size, seedMachines: g.seedMachines.size, configs: rows.length,
      best: rows.find(r => !r.seed)?.metrics.chatDecodeTps ?? rows[0].metrics.chatDecodeTps, rows });
  }
  return out.sort((a, b) => b.machines - a.machines);
}

/** A published figure as one number: the median, else the middle of the published range. */
const point = v => !v ? null : typeof v.median === 'number' ? v.median : typeof v.min === 'number' && typeof v.max === 'number' ? (v.min + v.max) / 2 : null;
const printed = v => !v ? null : (v.approx ? '~' : '') + (typeof v.median === 'number' ? v.printed ?? String(v.median) : typeof v.min === 'number' ? `${v.min}–${v.max}` : '');
/**
 * Reference rows from the maintainers' published strata_bench.py numbers (packages/core/src/official-bench-reference.json).
 * They are labelled `official`, never ranked and never part of a group's machines or median.
 */
export function officialReferenceRows(references) {
  return references.map(ref => ({
    official: true, id: ref.id, group: `${ref.model.family}:${ref.model.quant}`, family: ref.model.family, quant: ref.model.quant,
    hardware: ref.hardware.label, setup: ref.setup, measured: { date: ref.measured.date, strata: ref.measured.strata }, source: { title: ref.source.title, url: ref.source.url },
    metrics: Object.fromEntries(Object.keys(OFFICIAL_ROW_METRICS).map(k => [k, point(ref.metrics[k])])),
    printed: Object.fromEntries(Object.keys(OFFICIAL_ROW_METRICS).flatMap(k => ref.metrics[k] ? [[k, printed(ref.metrics[k])]] : [])),
  }));
}

/** Group list of the official board: every group with uploads or a published reference. */
export function officialGroups(groups, references) {
  const out = groups.map(({ rows, ...g }) => ({ ...g, references: references.filter(r => r.group === g.group).length }));
  for (const ref of references) if (!out.some(g => g.group === ref.group))
    out.push({ group: ref.group, family: ref.family, quant: ref.quant, machines: 0, seedMachines: 0, configs: 0, best: null, references: references.filter(r => r.group === ref.group).length });
  return out.sort((a, b) => b.machines - a.machines || b.references - a.references || a.group.localeCompare(b.group));
}

/** filterRows for the official board: the same filters, its own orderings; ties fall back to chat decode. */
export function filterOfficialRows(group, query = {}) {
  const sort = OFFICIAL_SORTS[query.sort] ? query.sort : OFFICIAL_DEFAULT_SORT;
  const { rows } = filterRows({ rows: group.rows.map(r => ({ ...r, decode: { median: r.metrics.chatDecodeTps } })) }, { ...query, sort: undefined });
  const value = OFFICIAL_SORTS[sort];
  const ordered = rows.map(({ decode, rank, ...r }) => r).sort((a, b) => {
    const va = value(a), vb = value(b);
    if (va === null || vb === null) return (va === null) - (vb === null);
    return vb - va || b.metrics.chatDecodeTps - a.metrics.chatDecodeTps;
  });
  let rank = 0;
  const middle = sort === 'machines' ? OFFICIAL_SORTS.chatDecode : value;
  return { sort, rows: ordered.map(r => ({ ...r, rank: value(r) === null ? null : ++rank })), median: r1(median(ordered.filter(r => !r.seed).map(middle))) };
}
