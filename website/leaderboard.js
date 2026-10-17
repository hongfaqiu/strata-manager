// Benchmark Arena leaderboard. Reads the public aggregate API; falls back to the build-time snapshot.
(() => {
  'use strict';
  const main = document.querySelector('.lb-main');
  if (!main) return;
  const en = document.documentElement.lang === 'en';
  const api = main.dataset.api, privacy = main.dataset.privacy;
  const T = en ? {
    machines: n => `${n} ${n === 1 ? 'machine' : 'machines'}`, runs: n => `${n} runs`, updated: t => `updated ${t}`, snapshot: t => `Showing the snapshot from ${t}; live data is unavailable right now.`,
    offline: 'Live data is unavailable right now and there is no snapshot yet.', emptyTitle: 'No results yet', emptyHint: 'Results appear after Strata Manager users join from the Benchmark → Leaderboard tab. Ranking starts once 3 machines share a model, quantization and configuration.',
    hardware: 'Hardware', allHardware: 'All hardware', config: 'Hardware · parameters', range: '8K decode tok/s', median: 'Median', prefill: 'Prefill', machinesCol: 'Machines', ram: g => `${g} GB RAM`, threads: n => `${n} threads`, parallel: n => `${n} parallel`, gpus: n => `GPU ×${n}`, vision: 'vision', seed: 'Maintainer run',
    legend: m => `● median   ▬ middle 50% of machines   ┆ group median ${m}`, method: 'Only verified machines count (3 runs over 2 days that agree with peers). Each machine counts as the median of its last 3 runs; outliers are removed; configurations need 3 machines to be ranked. Maintainer runs are labelled separately. Data is kept for 12 months.', privacy: 'What is uploaded', join: 'Join from Strata Manager → Benchmark → Leaderboard.', noRows: 'No ranked configurations for this hardware yet.', groupLabel: 'Model and quantization', configs: n => `${n} configurations`, tps: 'tok/s',
  } : {
    machines: n => `${n} 台机器`, runs: n => `${n} 次测试`, updated: t => `${t} 更新`, snapshot: t => `实时数据暂不可用，显示 ${t} 的快照。`,
    offline: '实时数据暂不可用，也还没有快照。', emptyTitle: '排行榜还没有数据', emptyHint: 'Strata Manager 用户在「Benchmark → 排行榜」加入后，结果会显示在这里。同一模型、同一量化、同一配置有 3 台机器后开始排名。',
    hardware: '硬件', allHardware: '全部硬件', config: '硬件 · 参数', range: '8K 解码 tok/s', median: '中位数', prefill: '预填充', machinesCol: '机器', ram: g => `内存 ${g} GB`, threads: n => `${n} 线程`, parallel: n => `并行 ${n}`, gpus: n => `GPU ×${n}`, vision: '视觉', seed: '维护者实测',
    legend: m => `● 中位数　▬ 中间 50% 机器　┆ 组中位数 ${m}`, method: '只统计已通过验证的机器（2 天内 3 次、与同配置结果一致）。每台机器取最近 3 次的中位数，剔除离群值；同一配置至少 3 台机器才排名。维护者实测单独标注。数据保留 12 个月。', privacy: '会上传什么', join: '在 Strata Manager「Benchmark → 排行榜」中加入。', noRows: '这个硬件范围还没有可排名的配置。', groupLabel: '模型与量化', configs: n => `${n} 种配置`, tps: 'tok/s',
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
  const state = { live: true, groups: null, snapshot: null, group: null, gpu: '' };

  async function json(url, ms = 6000) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), ms);
    try { const r = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    finally { clearTimeout(timer); }
  }
  async function snapshot() { if (!state.snapshot) state.snapshot = await json(main.dataset.snapshot).catch(() => null); return state.snapshot; }
  async function board(group, gpu) {
    if (state.live) {
      try { return await json(`${api}/v1/leaderboard?group=${encodeURIComponent(group)}${gpu ? '&gpu=' + encodeURIComponent(gpu) : ''}`); }
      catch { state.live = false; }
    }
    const snap = await snapshot(), b = snap?.boards?.[group];
    if (!b) return null;
    const rows = gpu ? b.rows.filter(r => r.hw.gpu === gpu).map((r, i) => ({ ...r, rank: i + 1 })) : b.rows;
    return { ...b, rows };
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
    const gpus = (summary.gpus || []).filter(x => x.gpu);
    const filter = `<label class="lb-filter"><span>${esc(T.hardware)}</span><select id="lb-gpu"><option value="">${esc(T.allHardware)}</option>${gpus.map(x => `<option value="${esc(x.gpu)}"${x.gpu === state.gpu ? ' selected' : ''}>${esc(gpuLabel(x.gpu))} · ${x.vramGB} GB (${x.machines})</option>`).join('')}</select></label>`;
    const head = `<div class="lb-toolbar"><div><h2>${esc(family(summary.family))} <span class="lb-quant">${esc(summary.quant)}</span></h2><span class="lb-muted">${esc(T.configs(summary.configs))} · ${esc(T.machines(summary.machines))}</span></div>${filter}</div>`;
    shell(`${tabs}<section class="lb-card">${head}<div id="lb-board" class="lb-board"><p class="lb-status">…</p></div></section>`, note);
    root.querySelectorAll('[data-group]').forEach(b => b.addEventListener('click', () => { state.group = b.dataset.group; state.gpu = ''; history.replaceState(null, '', '#' + encodeURIComponent(state.group)); void render(); }));
    root.querySelector('#lb-gpu')?.addEventListener('change', e => { state.gpu = e.target.value; void renderBoard(); });
    await renderBoard();
  }
  async function renderBoard() {
    const target = document.getElementById('lb-board');
    const b = await board(state.group, state.gpu);
    if (!state.live) { const n = root.querySelector('.lb-note'); if (!n && state.snapshot?.capturedAt) root.insertAdjacentHTML('afterbegin', `<p class="lb-note">${esc(T.snapshot(time(state.snapshot.capturedAt)))}</p>`); }
    const rows = b?.rows || [];
    if (!rows.length) { target.innerHTML = `<p class="lb-status">${esc(T.noRows)}</p>`; return; }
    const lo = Math.floor(Math.min(...rows.map(r => r.decode.p25 ?? r.decode.median)) * 0.92), hi = Math.ceil(Math.max(...rows.map(r => r.decode.p75 ?? r.decode.median)) * 1.04);
    const x = v => ((v - lo) / Math.max(1, hi - lo) * 100).toFixed(1) + '%';
    const hw = r => `<b>${esc(gpuLabel(r.hw.gpu))}</b> <span class="lb-muted">${r.hw.vramGB} GB · ${esc(T.ram(r.hw.ramGB))}</span>${r.seed ? `<span class="lb-tag">${esc(T.seed)}</span>` : ''}`;
    const podium = `<div class="lb-podium">${rows.slice(0, 3).map((r, i) => `<div class="${i === 0 ? 'first' : ''}"><span class="lb-rank">NO.${i + 1}</span><div class="lb-podium-hw">${hw(r)}</div><div class="lb-podium-value">${num(r.decode.median)}<small>${T.tps}</small></div>${chips(r.params)}</div>`).join('')}</div>`;
    const range = r => `<span class="lb-range">${b.tierMedian != null ? `<span class="ref" style="left:${x(b.tierMedian)}"></span>` : ''}${r.decode.p25 != null && r.decode.p75 != null ? `<span class="iqr" style="left:${x(r.decode.p25)};width:calc(${x(r.decode.p75)} - ${x(r.decode.p25)})"></span>` : ''}<i style="left:${x(r.decode.median)}"></i></span>`;
    const table = `<table class="lb-table"><thead><tr><th></th><th>${esc(T.config)}</th><th class="lb-col-range">${esc(T.range)}</th><th class="r">${esc(T.median)}</th><th class="r">${esc(T.prefill)}</th><th class="r">128K</th><th class="r">${esc(T.machinesCol)}</th></tr></thead><tbody>${rows.map((r, i) => `<tr><td class="lb-rank">${String(r.rank ?? i + 1).padStart(2, '0')}</td><td class="lb-config">${hw(r)}${chips(r.params)}</td><td class="lb-col-range">${range(r)}</td><td class="r lb-value" data-label="${esc(T.median)}">${num(r.decode.median)}</td><td class="r lb-num" data-label="${esc(T.prefill)}">${num(r.prefill, 0)}</td><td class="r lb-num" data-label="128K">${num(r.decode128k)}</td><td class="r lb-num" data-label="${esc(T.machinesCol)}">${signal(r.machines, r.seed)} ${r.machines}</td></tr>`).join('')}</tbody></table>`;
    target.innerHTML = podium + table + `<p class="lb-legend">${esc(T.legend(num(b.tierMedian)))}</p>`;
  }
  async function start() {
    try { state.groups = await json(`${api}/v1/groups`); }
    catch { state.live = false; const snap = await snapshot(); state.groups = snap?.capturedAt ? snap.groups : null; }
    const hash = decodeURIComponent(location.hash.slice(1));
    if (hash && state.groups?.groups.some(g => g.group === hash)) state.group = hash;
    renderStats(); await render();
  }
  void start();
})();
