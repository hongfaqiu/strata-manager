// Benchmark Arena leaderboard. Reads the public aggregate API; falls back to the build-time snapshot.
(() => {
  'use strict';
  const main = document.querySelector('.lb-main');
  if (!main) return;
  const en = document.documentElement.lang === 'en';
  const api = main.dataset.api, privacy = main.dataset.privacy;
  const T = en ? {
    machines: n => `${n} ${n === 1 ? 'machine' : 'machines'}`, runs: n => `${n} runs`, updated: t => `updated ${t}`, snapshot: t => `Showing the snapshot from ${t}; live data is unavailable right now.`,
    offline: 'Live data is unavailable right now and there is no snapshot yet.', emptyTitle: 'No results yet', emptyHint: 'Results appear after Strata Manager users join from the Benchmark → Leaderboard tab. A run measured in the app counts as soon as its run evidence passes the checks.',
    hardware: 'Hardware', allHardware: 'All hardware', config: 'Hardware · parameters', range: '8K decode tok/s', median: 'Median', prefill: 'Prefill', machinesCol: 'Machines', ram: g => `${g} GB RAM`, threads: n => `${n} threads`, parallel: n => `${n} parallel`, gpus: n => `GPU ×${n}`, vision: 'vision', seed: 'Maintainer run',
    legend: m => `● median   ▬ middle 50% of machines   ┆ group median ${m}`, method: 'Only runs measured in Strata Manager whose run evidence passes the consistency checks count, from the first upload. Each machine counts as the median of its last 3 runs; runs far from the same configuration on other machines are removed afterwards. Configurations with fewer than 3 machines are for reference. Maintainer runs are labelled separately. Data is kept for 12 months.', privacy: 'What is uploaded', join: 'Join from Strata Manager → Benchmark → Leaderboard.', noRows: 'No ranked configurations for this hardware yet.', groupLabel: 'Model and quantization', configs: n => `${n} configurations`, tps: 'tok/s',
    sortLabel: 'Sort', sorts: { decode8k: '8K decode', decode128k: '128K decode', prefill: 'Prefill', machines: 'Machines' }, search: 'Search GPU model', filtersLabel: 'Filters',
    facets: { vram: 'VRAM', ram: 'RAM', ctx: 'Context', kv: 'KV cache', parallel: 'Parallel', gpuCount: 'GPUs', expertCache: 'Expert cache' }, any: 'Any', reset: 'Clear filters', shown: (n, t) => `${n} of ${t} configurations`, noMatch: 'No configurations match these filters.', unitMachines: n => n === 1 ? 'machine' : 'machines', gb: v => `${v} GB`,
  } : {
    machines: n => `${n} 台机器`, runs: n => `${n} 次测试`, updated: t => `${t} 更新`, snapshot: t => `实时数据暂不可用，显示 ${t} 的快照。`,
    offline: '实时数据暂不可用，也还没有快照。', emptyTitle: '排行榜还没有数据', emptyHint: 'Strata Manager 用户在「Benchmark → 排行榜」加入后，结果会显示在这里。应用内完成的测试，运行证据通过核对后立即计入。',
    hardware: '硬件', allHardware: '全部硬件', config: '硬件 · 参数', range: '8K 解码 tok/s', median: '中位数', prefill: '预填充', machinesCol: '机器', ram: g => `内存 ${g} GB`, threads: n => `${n} 线程`, parallel: n => `并行 ${n}`, gpus: n => `GPU ×${n}`, vision: '视觉', seed: '维护者实测',
    legend: m => `● 中位数　▬ 中间 50% 机器　┆ 组中位数 ${m}`, method: '只统计在 Strata Manager 内完成、运行证据通过一致性核对的结果，第一次上传即计入。每台机器取最近 3 次的中位数；与同配置其他机器差距过大的结果会事后剔除。不足 3 台机器的配置仅供参考。维护者实测单独标注。数据保留 12 个月。', privacy: '会上传什么', join: '在 Strata Manager「Benchmark → 排行榜」中加入。', noRows: '这个硬件范围还没有可排名的配置。', groupLabel: '模型与量化', configs: n => `${n} 种配置`, tps: 'tok/s',
    sortLabel: '排序', sorts: { decode8k: '8K 解码', decode128k: '128K 解码', prefill: '预填充', machines: '机器数' }, search: '搜索 GPU 型号', filtersLabel: '筛选',
    facets: { vram: '显存', ram: '内存', ctx: '上下文', kv: 'KV 缓存', parallel: '并行', gpuCount: 'GPU 数', expertCache: '专家缓存' }, any: '全部', reset: '清除筛选', shown: (n, t) => `显示 ${n} / ${t} 种配置`, noMatch: '没有符合这些条件的配置。', unitMachines: () => '台', gb: v => `${v} GB`,
  };
  const FAMILY = { swift: 'Swift 1.5', qwen: 'Qwen3.8-Flash-Next', coder: 'Qwen3.8-Flash-Next Coder', unsloth: 'Qwen3.8-Flash-Next (Unsloth)' };
  const family = f => FAMILY[f] || f;
  const gpuLabel = name => String(name).replace(/^NVIDIA GeForce |^NVIDIA |^AMD Radeon |^AMD /, '');
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d = 1) => v == null || !Number.isFinite(v) ? '—' : v.toLocaleString(en ? 'en' : 'zh-CN', { maximumFractionDigits: d, minimumFractionDigits: d && v < 1000 ? d : 0 });
  const time = ms => new Date(ms).toLocaleString(en ? 'en' : 'zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const ctx = c => c >= 1024 ? `${Math.round(c / 1024)}K` : String(c);
  const chips = p => {
    const list = [ctx(p.ctx), `KV ${p.kv}`];
    if (p.poolWorkers) list.push(T.threads(p.poolWorkers));
    list.push(T.parallel(p.parallel), T.gpus(p.gpuCount));
    if (p.expertCache && p.expertCache !== 'auto') list.push(`expert ${p.expertCache}`);
    if (p.pcieFrac != null) list.push(`PCIe ${p.pcieFrac}`);
    if (p.vision) list.push(T.vision);
    return `<span class="lb-params">${list.map(x => `<span>${esc(x)}</span>`).join('')}</span>`;
  };
  const signal = (n, seed) => { const lv = seed ? 3 : n >= 25 ? 3 : n >= 10 ? 2 : n >= 3 ? 1 : 0; return `<span class="lb-signal" aria-hidden="true">${[0, 1, 2].map(i => `<i class="${i < lv ? 'on' : ''}" style="height:${5 + i * 3}px"></i>`).join('')}</span>`; };
  const root = document.getElementById('lb-root'), stats = document.getElementById('lb-stats');

  // ---- filtering and sorting (mirrors services/arena/src/stats.js filterRows, so live data and the snapshot behave the same) ----
  const SORTS = { decode8k: r => r.decode?.median ?? null, decode128k: r => r.decode128k ?? null, prefill: r => r.prefill ?? null, machines: r => r.machines ?? null };
  const FACETS = { vram: r => r.hw.vramGB, ram: r => r.hw.ramGB, ctx: r => r.params.ctx, kv: r => r.params.kv, parallel: r => r.params.parallel, gpuCount: r => r.params.gpuCount, expertCache: r => r.params.expertCache ?? 'auto' };
  const NUMERIC = new Set(['vram', 'ram', 'ctx', 'parallel', 'gpuCount']);
  const FILTERS = ['gpu', 'q', ...Object.keys(FACETS)];
  const blank = () => Object.fromEntries(FILTERS.map(k => [k, '']));
  const median = values => { const s = values.filter(v => v != null && Number.isFinite(v)).sort((a, b) => a - b); if (!s.length) return null; const p = (s.length - 1) / 2; return (s[Math.floor(p)] + s[Math.ceil(p)]) / 2; };
  function facetOptions(rows) {
    const out = {};
    for (const [key, get] of Object.entries(FACETS)) {
      const values = [...new Set(rows.map(get).filter(v => v != null))];
      out[key] = NUMERIC.has(key) ? values.sort((a, b) => a - b) : values.sort((a, b) => String(a).localeCompare(String(b)));
    }
    return out;
  }
  function applyFilters(rows, f, sort) {
    let out = rows;
    if (f.gpu) out = out.filter(r => r.hw.gpu === f.gpu);
    if (f.q.trim()) { const k = f.q.trim().toLowerCase(); out = out.filter(r => String(r.hw.gpu).toLowerCase().includes(k)); }
    for (const key of Object.keys(FACETS)) if (f[key] !== '') out = out.filter(r => String(FACETS[key](r)) === String(f[key]));
    const value = SORTS[sort] || SORTS.decode8k;
    out = [...out].sort((a, b) => { const va = value(a), vb = value(b); if (va == null || vb == null) return (va == null) - (vb == null); return vb - va || b.decode.median - a.decode.median; });
    let rank = 0;
    return { rows: out.map(r => ({ ...r, rank: value(r) == null ? null : ++rank })), tierMedian: median(out.filter(r => !r.seed).map(r => r.decode.median)) };
  }

  // ---- URL state: #group=<model:quant>&vram=24&sort=prefill (a bare #<model:quant> from older links still works) ----
  const wide = window.matchMedia('(min-width: 851px)');
  // Wide screens always show every filter; narrow screens fold them under one summary row.
  wide.addEventListener?.('change', e => { if (e.matches) root.querySelector('.lb-facets')?.setAttribute('open', ''); });
  const state = { live: true, groups: null, snapshot: null, group: null, boards: new Map(), f: blank(), sort: 'decode8k' };
  function readHash() {
    const raw = location.hash.slice(1);
    if (!raw) return;
    if (!raw.includes('=')) { state.group = decodeURIComponent(raw); return; }
    const p = new URLSearchParams(raw);
    state.group = p.get('group') || null;
    for (const k of FILTERS) state.f[k] = p.get(k) ?? '';
    state.sort = SORTS[p.get('sort')] ? p.get('sort') : 'decode8k';
  }
  function writeHash() {
    const p = new URLSearchParams();
    if (state.group) p.set('group', state.group);
    for (const k of FILTERS) if (state.f[k] !== '') p.set(k, state.f[k]);
    if (state.sort !== 'decode8k') p.set('sort', state.sort);
    history.replaceState(null, '', '#' + p.toString().replace(/%3A/gi, ':'));
  }

  async function json(url, ms = 6000) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), ms);
    try { const r = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    finally { clearTimeout(timer); }
  }
  async function snapshot() { if (!state.snapshot) state.snapshot = await json(main.dataset.snapshot).catch(() => null); return state.snapshot; }
  /** The whole group's board, fetched once; filters and sorting then run locally. */
  async function board(group) {
    if (state.boards.has(group)) return state.boards.get(group);
    let b = null;
    if (state.live) {
      try { b = await json(`${api}/v1/leaderboard?group=${encodeURIComponent(group)}`); }
      catch { state.live = false; }
    }
    if (!b) b = (await snapshot())?.boards?.[group] ?? null;
    if (b) state.boards.set(group, b);
    return b;
  }
  function renderStats() {
    const g = state.groups;
    if (!g) { stats.innerHTML = ''; return; }
    const parts = [T.machines(g.machines), T.runs(g.runs)];
    if (g.computedAt) parts.push(T.updated(time(g.computedAt)));
    stats.innerHTML = parts.map(p => `<span>${esc(p)}</span>`).join('');
  }
  function shell(inner, note = '') {
    root.innerHTML = `${note ? `<p class="lb-note">${esc(note)}</p>` : ''}${inner}<p class="lb-method">${esc(T.method)} <a href="${esc(privacy)}">${esc(T.privacy)}</a> · ${esc(T.join)}</p>`;
  }
  async function render() {
    const g = state.groups;
    const note = !state.live && state.snapshot?.capturedAt ? T.snapshot(time(state.snapshot.capturedAt)) : '';
    if (!g || !g.groups.length) {
      shell(`<div class="lb-empty"><h2>${esc(g ? T.emptyTitle : T.offline)}</h2>${g ? `<p>${esc(T.emptyHint)}</p>` : ''}</div>`, note);
      return;
    }
    const summary = g.groups.find(x => x.group === state.group) || g.groups[0];
    state.group = summary.group;
    const tabs = `<div class="lb-groups" role="tablist" aria-label="${esc(T.groupLabel)}">${g.groups.map(x => `<button type="button" role="tab" aria-selected="${x.group === state.group}" data-group="${esc(x.group)}"><b>${esc(family(x.family))}</b><span class="lb-quant">${esc(x.quant)}</span><em>${x.machines}</em></button>`).join('')}</div>`;
    const b = await board(state.group);
    const all = b?.rows || [];
    const gpus = (summary.gpus || []).filter(x => x.gpu);
    const opts = facetOptions(all);
    for (const k of Object.keys(FACETS)) if (state.f[k] !== '' && !opts[k].some(v => String(v) === String(state.f[k]))) state.f[k] = '';
    if (state.f.gpu && !gpus.some(x => x.gpu === state.f.gpu) && !all.some(r => r.hw.gpu === state.f.gpu)) state.f.gpu = '';
    const facetLabel = (k, v) => k === 'ctx' ? ctx(v) : k === 'vram' || k === 'ram' ? T.gb(v) : String(v);
    const select = (id, label, options, value) => `<label class="lb-filter"><span>${esc(label)}</span><select data-filter="${id}"><option value="">${esc(id === 'gpu' ? T.allHardware : T.any)}</option>${options.map(o => `<option value="${esc(o.value)}"${String(o.value) === String(value) ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
    const selects = [select('gpu', T.hardware, gpus.map(x => ({ value: x.gpu, label: `${gpuLabel(x.gpu)} · ${x.vramGB} GB (${x.machines})` })), state.f.gpu)];
    for (const k of Object.keys(FACETS)) if (opts[k].length > 1) selects.push(select(k, T.facets[k], opts[k].map(v => ({ value: v, label: facetLabel(k, v) })), state.f[k]));
    const sorter = `<div class="lb-sort" role="group" aria-label="${esc(T.sortLabel)}"><span>${esc(T.sortLabel)}</span>${Object.keys(SORTS).map(k => `<button type="button" data-sort="${k}" aria-pressed="${k === state.sort}">${esc(T.sorts[k])}</button>`).join('')}</div>`;
    const head = `<div class="lb-toolbar"><div><h2>${esc(family(summary.family))} <span class="lb-quant">${esc(summary.quant)}</span></h2><span class="lb-muted">${esc(T.configs(summary.configs))} · ${esc(T.machines(summary.machines))}</span></div>${sorter}</div>`;
    const picked = FILTERS.filter(k => k !== 'q' && state.f[k] !== '').length;
    const open = wide.matches || picked > 0;
    const filters = `<div class="lb-filters" role="search" aria-label="${esc(T.filtersLabel)}"><label class="lb-search"><span class="lb-sr">${esc(T.search)}</span><input type="search" data-filter="q" value="${esc(state.f.q)}" placeholder="${esc(T.search)}" autocomplete="off" spellcheck="false"></label><details class="lb-facets"${open ? ' open' : ''}><summary>${esc(T.filtersLabel)}<span id="lb-picked">${picked ? ` · ${picked}` : ''}</span></summary><div class="lb-facet-grid">${selects.join('')}</div></details><div class="lb-filter-meta"><span id="lb-count" class="lb-muted" aria-live="polite"></span><button type="button" class="lb-reset" id="lb-reset" hidden>${esc(T.reset)}</button></div></div>`;
    shell(`${tabs}<section class="lb-card">${head}${filters}<div id="lb-board" class="lb-board"><p class="lb-status">…</p></div></section>`, note);
    root.querySelectorAll('[data-group]').forEach(btn => btn.addEventListener('click', () => { state.group = btn.dataset.group; state.f = blank(); writeHash(); void render(); }));
    root.querySelectorAll('select[data-filter]').forEach(el => el.addEventListener('change', () => { state.f[el.dataset.filter] = el.value; writeHash(); renderBoard(); }));
    root.querySelector('input[data-filter="q"]')?.addEventListener('input', e => { state.f.q = e.target.value; writeHash(); renderBoard(); });
    root.querySelectorAll('[data-sort]').forEach(btn => btn.addEventListener('click', () => { state.sort = btn.dataset.sort; root.querySelectorAll('[data-sort]').forEach(x => x.setAttribute('aria-pressed', String(x === btn))); writeHash(); renderBoard(); }));
    root.querySelector('#lb-reset')?.addEventListener('click', () => { state.f = blank(); root.querySelectorAll('[data-filter]').forEach(el => { el.value = ''; }); writeHash(); renderBoard(); });
    writeHash();
    renderBoard();
  }
  function renderBoard() {
    const target = document.getElementById('lb-board');
    const b = state.boards.get(state.group);
    if (!state.live) { const n = root.querySelector('.lb-note'); if (!n && state.snapshot?.capturedAt) root.insertAdjacentHTML('afterbegin', `<p class="lb-note">${esc(T.snapshot(time(state.snapshot.capturedAt)))}</p>`); }
    const all = b?.rows || [];
    const { rows, tierMedian } = applyFilters(all, state.f, state.sort);
    const filtered = FILTERS.some(k => state.f[k] !== '');
    const count = document.getElementById('lb-count'), reset = document.getElementById('lb-reset');
    if (count) count.textContent = all.length ? T.shown(rows.length, all.length) : '';
    if (reset) reset.hidden = !filtered;
    const picked = FILTERS.filter(k => k !== 'q' && state.f[k] !== '').length, badge = document.getElementById('lb-picked');
    if (badge) badge.textContent = picked ? ` · ${picked}` : '';
    if (!rows.length) { target.innerHTML = `<p class="lb-status">${esc(filtered && all.length ? T.noMatch : T.noRows)}</p>`; return; }
    const sort = state.sort, metric = SORTS[sort];
    const lo = Math.floor(Math.min(...rows.map(r => r.decode.p25 ?? r.decode.median)) * 0.92), hi = Math.ceil(Math.max(...rows.map(r => r.decode.p75 ?? r.decode.median)) * 1.04);
    const x = v => ((v - lo) / Math.max(1, hi - lo) * 100).toFixed(1) + '%';
    const hw = r => `<b>${esc(gpuLabel(r.hw.gpu))}</b> <span class="lb-muted">${r.hw.vramGB} GB · ${esc(T.ram(r.hw.ramGB))}</span>${r.seed ? `<span class="lb-tag">${esc(T.seed)}</span>` : ''}`;
    const big = r => sort === 'machines' ? `${r.machines}<small>${esc(T.unitMachines(r.machines))}</small>` : `${num(metric(r), sort === 'prefill' ? 0 : 1)}<small>${T.tps}</small>`;
    const podiumLabel = sort === 'decode8k' ? '' : `<span class="lb-podium-metric">${esc(T.sorts[sort])}</span>`;
    const podium = `<div class="lb-podium">${rows.slice(0, 3).map((r, i) => `<div class="${i === 0 && r.rank === 1 ? 'first' : ''}"><span class="lb-rank">NO.${r.rank ?? '—'}</span>${podiumLabel}<div class="lb-podium-hw">${hw(r)}</div><div class="lb-podium-value">${big(r)}</div>${chips(r.params)}</div>`).join('')}</div>`;
    const range = r => `<span class="lb-range">${tierMedian != null ? `<span class="ref" style="left:${x(tierMedian)}"></span>` : ''}${r.decode.p25 != null && r.decode.p75 != null ? `<span class="iqr" style="left:${x(r.decode.p25)};width:calc(${x(r.decode.p75)} - ${x(r.decode.p25)})"></span>` : ''}<i style="left:${x(r.decode.median)}"></i></span>`;
    const on = k => sort === k ? ' is-sorted' : '';
    const th = (k, label) => `<th class="r${on(k)}"${sort === k ? ' aria-sort="descending"' : ''}>${esc(label)}</th>`;
    const table = `<table class="lb-table"><thead><tr><th></th><th>${esc(T.config)}</th><th class="lb-col-range">${esc(T.range)}</th>${th('decode8k', T.median)}${th('prefill', T.prefill)}${th('decode128k', '128K')}${th('machines', T.machinesCol)}</tr></thead><tbody>${rows.map(r => `<tr><td class="lb-rank">${r.rank == null ? '—' : String(r.rank).padStart(2, '0')}</td><td class="lb-config">${hw(r)}${chips(r.params)}</td><td class="lb-col-range">${range(r)}</td><td class="r lb-value${on('decode8k')}" data-label="${esc(T.median)}">${num(r.decode.median)}</td><td class="r lb-num${on('prefill')}" data-label="${esc(T.prefill)}">${num(r.prefill, 0)}</td><td class="r lb-num${on('decode128k')}" data-label="128K">${num(r.decode128k)}</td><td class="r lb-num${on('machines')}" data-label="${esc(T.machinesCol)}">${signal(r.machines, r.seed)} ${r.machines}</td></tr>`).join('')}</tbody></table>`;
    target.innerHTML = podium + table + `<p class="lb-legend">${esc(T.legend(num(tierMedian)))}</p>`;
  }
  async function start() {
    try { state.groups = await json(`${api}/v1/groups`); }
    catch { state.live = false; const snap = await snapshot(); state.groups = snap?.capturedAt ? snap.groups : null; }
    readHash();
    if (state.group && !state.groups?.groups.some(g => g.group === state.group)) { state.group = null; state.f = blank(); }
    renderStats(); await render();
  }
  void start();
})();
