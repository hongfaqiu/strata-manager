// Generates static D2-style reference drafts (one HTML per page). Demo values only; field names follow the app.
import { writeFileSync } from 'node:fs';
const dir = new URL('.', import.meta.url).pathname;
const M = 'Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S', CFG = 'swift-iq3_s.json', EP = 'http://127.0.0.1:19001/v1';
const ic = {
  overview:'<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  chat:'<path d="M4 5h16v11H8l-4 4z"/>', monitor:'<path d="M3 12h4l3-7 4 14 3-7h4"/>', bench:'<path d="M5 18a8 8 0 1 1 14 0"/><path d="M12 13l4-4"/>',
  models:'<rect x="3" y="5" width="18" height="6" rx="1"/><rect x="3" y="13" width="18" height="6" rx="1"/>', strata:'<path d="M3 7h18M3 12h18M3 17h18"/>',
  tuning:'<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  tasks:'<path d="M4 6l4 4-4 4M11 16h9"/>', settings:'<circle cx="7" cy="8" r="2"/><circle cx="17" cy="16" r="2"/><path d="M9 8h11M4 16h11M4 8h1M19 16h1"/>' };
const navs = [['日常使用'],['overview','总览'],['chat','聊天'],['monitor','监控'],['bench','Benchmark 测试'],['模型与服务'],['models','模型'],['strata','Strata'],['tuning','参数调优'],['tasks','任务与日志'],['应用'],['settings','设置']];
const svg = k => `<svg viewBox="0 0 24 24">${ic[k]}</svg>`;
const shell = (active, title, body, { pill = ['', '生成中 · 46.8 tok/s'], status = true } = {}) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="shell.css"><link rel="stylesheet" href="pages.css"></head><body><div class="app">
<aside class="side"><div class="brand"><i></i><div><b>Strata</b> <span class="muted small">Manager</span><small>v0.1.10</small></div></div>
${navs.map(n => n.length === 1 ? `<div class="grp">${n[0]}</div>` : `<div class="nav${n[0] === active ? ' on' : ''}">${svg(n[0])}${n[1]}</div>`).join('')}
<div class="grow"></div><div class="collapse">‹ 收起侧栏</div></aside>
<div class="main"><header class="bar"><h1>${title}</h1><span class="sp"></span><span class="pill"><span class="dot ${pill[0]}"></span>${pill[1]}</span></header>
<div class="content">${body}</div>
<footer class="status">${status ? '<span><span class="dot"></span> 生成中</span><span>生成 <b>46.8</b> tok/s</span><span>运行 <b>1</b></span><span>排队 <b>1</b></span><span>GPU <b>91%</b></span><span>CPU <b>34%</b></span><span>温度 <b>72°C</b></span><span>功耗 <b>248 W</b></span>' : '<span><span class="dot off"></span> 服务未启动</span>'}</footer></div></div></body></html>`;
const seg = (parts, mark) => `<div class="seg">${parts.map(([c, w]) => `<i class="${c}" style="width:${w}%"></i>`).join('')}${mark ? `<span class="mark" style="left:${mark}%"></span>` : ''}</div>`;
const pages = {};

/* 1 · 我的模型 — machine capacity is the frame; each configuration shows where it lands on VRAM/RAM */
pages.models = shell('models', '模型', `
<div class="row" style="margin-bottom:14px"><div class="tabs" style="margin:0"><span class="on">我的模型</span><span>下载模型</span></div><span class="grow"></span><span class="muted small">2 个本机模型 · 3 份配置 · 目录 D:/AI/models</span><span class="btn">扫描</span><span class="btn">添加目录</span></div>
<div class="panel">
 <div class="sec mfit"><div class="row"><span class="h3">本机容量</span><span class="muted small">RTX 4090 24 GB · 内存 96 GB · 磁盘可用 412 GB</span><span class="grow"></span><span class="muted small">虚线为当前占用</span></div>
  <div class="cap"><div><div class="row small"><span class="muted">显存</span><span class="grow"></span><span class="num">21.4 / 24 GB</span></div>${seg([['a', 50], ['b', 39]], 85)}</div>
  <div><div class="row small"><span class="muted">内存</span><span class="grow"></span><span class="num">66.4 / 96 GB</span></div>${seg([['g', 52], ['h', 17]], 65)}</div></div></div>
 <div class="model on"><div class="mhead"><span class="chip"><span class="dot"></span>运行中</span><div class="grow"><div class="h2">${M}</div><div class="muted small">Swift 1.5 · IQ3_S · 83.6 GB · 2 个分片 · 图像支持</div></div><span class="btn pri">打开聊天</span><span class="btn dan">停止</span><span class="btn">重启</span></div>
  <table class="table cfg"><colgroup><col><col style="width:80px"><col style="width:70px"><col style="width:60px"><col style="width:30%"><col style="width:130px"></colgroup><tr><th>配置</th><th>上下文</th><th>KV</th><th>线程</th><th style="width:30%">资源需求（内存 62 GB）</th><th></th></tr>
  <tr class="on"><td><b>${CFG}</b> <span class="chip">当前使用</span></td><td class="num">128K</td><td class="num">int8</td><td class="num">16</td><td>${seg([['g', 64]], 0)}</td><td class="r"><span class="btn">运行配置</span></td></tr>
  <tr><td>swift-iq3_s-long.json</td><td class="num">256K</td><td class="num">q4_0</td><td class="num">16</td><td>${seg([['g', 66], ['w', 8]], 0)}<div class="small" style="color:var(--warn);margin-top:4px">上下文翻倍，预计超出空闲内存</div></td><td class="r"><span class="btn">启用配置</span></td></tr></table></div>
 <div class="model"><div class="mhead"><span class="chip off">未启动</span><div class="grow"><div class="h2" style="font-size:16px">Qwen3.8-Flash-Next Coder</div><div class="muted small">IQ1_M · 58.4 GB · 内存 32 GB</div></div><span class="btn pri">启用配置</span><span class="btn">运行配置</span></div>
  <table class="table cfg"><colgroup><col><col style="width:80px"><col style="width:70px"><col style="width:60px"><col style="width:30%"><col style="width:130px"></colgroup><tr><td><b>coder-iq1_m.json</b></td><td class="num">128K</td><td class="num">int8</td><td class="num">16</td><td style="width:30%">${seg([['g', 33]], 0)}</td><td class="r muted small">2026/10/14 更新</td></tr></table></div>
</div>`);

/* 2 · 下载模型 — every quant drawn against this machine's RAM and disk, choice first, details after */
const quants = [['Swift 1.5', 'IQ2_XS', 68, 48], ['Swift 1.5', 'IQ3_XXS', 75.8, 60], ['Swift 1.5', 'IQ3_S', 83.6, 62, '已下载'], ['Qwen3.8-Flash-Next', 'Q2_0', 66.4, 48], ['Qwen3.8-Flash-Next', 'IQ3_S', 83.6, 62], ['Qwen3.8-Flash-Next Coder', 'IQ1_M', 58.4, 32, '已下载'], ['Qwen3.8-Flash-Next (Unsloth)', 'UD-IQ4_XS', 93.7, 48], ['Qwen3.8-Flash-Next (Unsloth)', 'UD-Q4_K_XL', 111.3, 48, '实验']];
pages.catalog = shell('models', '模型', `
<div class="row" style="margin-bottom:14px"><div class="tabs" style="margin:0"><span>我的模型</span><span class="on">下载模型</span></div><span class="grow"></span><span class="muted small">官方来源 · 目录快照 2026-10-11</span><span class="btn">下载设置</span></div>
<div class="panel">
 <div class="sec"><div class="row"><span class="h3">适合这台电脑</span><span class="muted small">按内存 96 GB、磁盘可用 412 GB（D:）判断</span><span class="grow"></span><span class="legend" style="margin:0"><span><i style="background:#7b7f83"></i>运行所需内存</span><span><i style="background:#7cc2a5"></i>下载体积</span></span></div></div>
 <table class="table quant"><tr><th>模型</th><th>量化</th><th style="width:30%">内存 / 96 GB</th><th style="width:22%">下载 / 412 GB</th><th>图像</th><th></th></tr>
 ${quants.map(([n, q, d, r, tag]) => `<tr${q === 'IQ3_S' && n.startsWith('Swift') ? ' class="on"' : ''}><td>${n}</td><td class="num">${q}${tag ? ` <span class="chip ${tag === '实验' ? 'warn' : 'off'}">${tag}</span>` : ''}</td>
 <td><div class="row">${seg([['g', r / 96 * 100]], 0).replace('class="seg"', 'class="seg grow"')}<span class="num small" style="width:48px;text-align:right">${r} GB</span></div></td>
 <td><div class="row">${seg([['b', d / 412 * 100]], 0).replace('class="seg"', 'class="seg grow"')}<span class="num small" style="width:56px;text-align:right">${d} GB</span></div></td><td class="small">支持</td>
 <td class="r">${tag === '已下载' ? '<span class="muted small">已在本机</span>' : `<span class="btn${q === 'IQ3_XXS' ? ' pri' : ''}">下载</span>`}</td></tr>`).join('')}</table>
 <div class="attn ok" style="border-bottom:0"><span class="dot"></span>当前电脑可运行除 UD-Q4_K_XL 以外的全部量化；UD-Q4_K_XL 仅限 NVIDIA，图像未验证。</div>
</div>`);

/* 3 · 运行配置 — the edit form on the left, its effect on the hardware map on the right */
pages.config = shell('models', '模型', `
<div class="row" style="margin-bottom:14px"><span class="muted small">我的模型 /</span><b>${M}</b><span class="muted small">· ${CFG}</span><span class="grow"></span><span class="chip warn">未保存 · 3 项改动</span><span class="btn">完整 JSON</span><span class="btn">复制为新配置</span><span class="btn pri">保存并重启</span></div>
<div class="cfgwrap"><div class="panel">
 <div class="sec"><div class="row"><span class="h3">上下文与缓存</span><span class="grow"></span><span class="muted small">--max-context · --kv</span></div>
  <div class="grid3"><div class="field"><label>最大上下文</label><div class="input mono">131072 → <b>&nbsp;196608</b></div></div><div class="field"><label>KV 精度</label><div class="input mono">int8</div></div><div class="field"><label>线程</label><div class="input mono">16</div></div></div></div>
 <div class="sec"><div class="row"><span class="h3">网络访问</span></div><div class="grid3"><div class="field"><label>API 端口</label><div class="input mono">19001</div></div><div class="field"><label>监听地址</label><div class="input mono">127.0.0.1</div></div><div class="field"><label>启动后 API</label><div class="input mono ph">${EP}</div></div></div></div>
 <div class="sec"><div class="row"><span class="h3">GPU 功耗</span><span class="grow"></span><span class="muted small">NVIDIA · 影响整张显卡</span></div><div class="grid3"><div class="field"><label>功耗上限（W）</label><div class="input mono">320 → <b>&nbsp;280</b></div></div><div class="field"><label>GPU 编号</label><div class="input mono">0</div></div><div></div></div></div>
 <div class="sec"><div class="row"><span class="h3">会话与专家</span></div><div class="grid3"><div class="field"><label>会话缓存预算（MiB）</label><div class="input mono">8192</div></div><div class="field"><label>专家缓存（MiB）</label><div class="input mono">12288</div></div><div class="field"><label>池工作线程</label><div class="input mono">4 → <b>&nbsp;6</b></div></div></div></div>
 <div class="sec muted small">保存会备份原文件；当前服务在重启前继续使用已有配置。</div>
</div>
<div class="panel effect"><div class="sec"><span class="h3">改动后的资源预估</span><div class="muted small">按引擎上次报告的占用推算，未经实测</div></div>
 <div class="sec"><div class="row small"><span class="muted">显存</span><span class="grow"></span><span class="num">21.4 → 22.9 / 24 GB</span></div>${seg([['a', 50], ['b', 39], ['w', 6]], 85)}<div class="legend"><span><i style="background:#178a62"></i>专家<b>12</b></span><span><i style="background:#7cc2a5"></i>模型与运行时<b>9.4</b></span><span><i style="background:var(--warn)"></i>新增 KV<b>1.5</b></span></div></div>
 <div class="sec"><div class="row small"><span class="muted">内存</span><span class="grow"></span><span class="num">66.4 → 70.1 / 96 GB</span></div>${seg([['g', 52], ['h', 17], ['w', 4]], 65)}</div>
 <div class="sec"><dl class="kv"><dt>上下文</dt><dd class="num">128K → 192K</dd><dt>功耗上限</dt><dd class="num">320 → 280 W</dd><dt>池工作线程</dt><dd class="num">4 → 6</dd></dl></div>
 <div class="attn" style="border-bottom:0"><span class="dot warn"></span>显存将超过 85%，长上下文请求可能失败</div></div></div>`);

/* 4 · Strata 运行环境 — one device line: runtime → engine → this machine; update as a quiet row */
pages.environment = shell('strata', 'Strata', `
<div class="panel">
 <div class="sec envtop"><span class="chip"><span class="dot"></span>已安装</span><div class="grow"><div class="h2">Strata 0.1.43</div><div class="muted small mono">D:/AI/Strata · revision a1b2c3d</div></div><span class="btn">技术信息</span><span class="btn">重新检测</span><span class="btn">切换运行环境 ▾</span></div>
 <div class="attn ok"><span class="dot"></span>已是官方支持的最新版本 0.1.43 · 2 分钟前检查</div>
 <div class="sec"><div class="row" style="margin-bottom:12px"><span class="h3">这台电脑</span><span class="grow"></span><span class="btn ghost">刷新</span></div>
  <div class="devices"><div class="dev"><div class="muted small">处理器</div><b>Intel Core i9-13900K</b><div class="muted small">Windows · x86_64</div></div><span class="bus"></span>
  <div class="dev"><div class="muted small">内存</div><b class="num">29.6 / 96 GB 可用</b>${seg([['g', 69]])}</div><span class="bus"></span>
  <div class="dev"><div class="muted small">显卡</div><b>NVIDIA GeForce RTX 4090</b><div class="muted small">24 GB · CUDA 13 包</div></div></div></div>
 <div class="sec"><div class="grid3 facts"><dl class="kv"><dt>Python</dt><dd class="num">3.10.11</dd><dt>Git</dt><dd class="num">2.46.0</dd></dl><dl class="kv"><dt>引擎版本</dt><dd class="num">0.1.43</dd><dt>应用版本</dt><dd class="num">0.1.10</dd></dl><dl class="kv"><dt>下载来源</dt><dd>官方</dd><dt>运行包</dt><dd class="mono small">strata-windows-x64.zip</dd></dl></div></div>
 <div class="sec"><div class="row"><span class="h3">安装新的运行环境</span><span class="muted small">选择新的空目录，从官方仓库安装，不会自动下载模型</span><span class="grow"></span><span class="btn">下载设置与测试</span><span class="btn">开始安装</span></div></div>
</div>`);

/* 5 · 参数调优 — one question, one run; candidates read as a speed line, not bars */
const cands = [['当前配置', '128K', 'int8', 16, 30.5, 2048, true], ['候选 A', '128K', 'k8v4', 16, 33.1, 2190], ['候选 B', '128K', 'int8', 24, 31.2, 2420], ['候选 C', '96K', 'q4_0', 16, 34.0, 1980]];
pages.tuning = shell('tuning', '参数调优', `
<div class="panel">
 <div class="sec row"><div class="grow"><div class="h2">为这台电脑实测调优</div><div class="muted small">${M} · ${CFG} · 测试占用当前模型，完成后恢复原配置</div></div><span class="btn">运行配置</span></div>
 <div class="sec"><div class="grid4"><div class="field"><label>你主要怎样使用模型？</label><div class="input">日常聊天 ▾</div></div><div class="field"><label>测试模式</label><div class="tabs" style="margin:0"><span class="on">完整场景</span><span>短请求诊断</span></div></div><div class="field"><label>重复轮数</label><div class="input mono">2</div></div><div class="field"><label>本次上下文上限</label><div class="input mono">8,192</div></div></div>
  <div class="row" style="margin-top:12px"><span class="muted small">高级测试设置 · 已选 0 / 4</span><span class="grow"></span><span class="btn pri">开始实测</span></div></div>
 <div class="sec"><div class="row"><span class="h3">上次结果</span><span class="muted small">2026/10/16 21:40 · 日常聊天 · 2 轮</span><span class="grow"></span><span class="chip">推荐 候选 A · 解码 +8.5%</span></div>
  <table class="table" style="margin-top:8px"><tr><th>方案</th><th>上下文</th><th>KV</th><th>线程</th><th class="r">解码 tok/s</th><th style="width:28%"></th><th class="r">预填充 tok/s</th><th></th></tr>
  ${cands.map(([n, c, k, t, d, p, cur]) => `<tr${n === '候选 A' ? ' class="on"' : ''}><td>${n}${cur ? ' <span class="chip off">当前</span>' : ''}</td><td class="num">${c}</td><td class="num">${k}</td><td class="num">${t}</td><td class="r num"><b>${d.toFixed(1)}</b></td><td><div class="dotline"><i style="left:${(d - 28) / 8 * 100}%"></i></div></td><td class="r num">${p.toLocaleString()}</td><td class="r">${n === '候选 A' ? '<span class="btn pri">应用</span>' : cur ? '' : '<span class="btn">应用</span>'}</td></tr>`).join('')}</table>
  <div class="muted small" style="margin-top:8px">点位为解码速度在 28–36 tok/s 区间中的位置；应用会写入配置并重启服务，可一键恢复。</div></div>
</div>`);

/* 6 · 任务与日志 — list on the left, the selected task's log as the focal area */
const tasks = [['running', '模型准备', '正在准备量化配置…', '22:43:09'], ['completed', '运行环境更新', 'Strata 0.1.43 已安装', '21:10:32'], ['failed', '启动服务', '监听端口被占用（19001）', '20:58:04'], ['completed', '参数调优', '推荐候选 A，已恢复原配置', '20:31:47'], ['cancelled', '模型下载', 'IQ3_XXS 已取消 · 31.2 / 75.8 GB', '19:02:15'], ['completed', '模型下载', 'Swift 1.5 IQ3_S · 83.6 GB', '昨天']];
const st = { running: ['', '进行中'], completed: ['off', '完成'], failed: ['bad', '失败'], cancelled: ['off', '已取消'] };
pages.tasks = shell('tasks', '任务与日志', `
<div class="taskwrap"><div class="panel"><div class="sec row"><span class="h3">任务</span><span class="grow"></span><span class="muted small">今天 5 · 失败 1</span></div>
 ${tasks.map(([s, k, m, t], i) => `<div class="task${i === 2 ? ' on' : ''}"><span class="dot ${s === 'running' ? '' : s === 'failed' ? 'bad' : 'off'}"></span><div class="grow"><div class="row"><b>${k}</b><span class="grow"></span><span class="num small muted">${t}</span></div><div class="small muted ell">${m}</div></div></div>`).join('')}
 <div class="sec"><div class="h3" style="margin-bottom:6px">日志来源</div><div class="task"><span class="dot"></span><div class="grow"><b>当前服务日志</b><div class="small muted ell">${M}</div></div></div></div></div>
<div class="panel logp"><div class="sec row"><span class="chip bad">失败</span><div class="grow"><div class="h3">启动服务 · ${CFG}</div><div class="muted small">20:58:04 开始 · 耗时 0.8 s · 失败阶段：启动 API</div></div><span class="btn">打开网络配置</span><span class="btn">导出诊断</span><span class="btn ghost">复制日志</span></div>
 <div class="attn" style="background:#fdf2f3"><span class="dot bad"></span>检查已确认：端口 19001 被另一个进程占用。修改 API 端口或停止占用进程后重试。</div>
 <div class="log"><span class="t">20:58:04.112</span> manager  启动 ${CFG}
<span class="t">20:58:04.130</span> manager  engine D:/AI/Strata · python 3.10.11
<span class="t">20:58:04.402</span> stdout   GGUF: routed experts IQ3_S; compatible with Strata
<span class="t">20:58:04.418</span> stdout   loading 2 shards · 83.6 GB
<span class="t">20:58:04.611</span> <span class="w">stderr   warn: expert cache budget 12288 MiB</span>
<span class="t">20:58:04.880</span> <span class="e">stderr   OSError: [WinError 10048] 127.0.0.1:19001 address already in use</span>
<span class="t">20:58:04.902</span> manager  诊断 STARTUP_PORT_IN_USE · 已确认
<span class="t">20:58:04.903</span> manager  服务保持停止，未重试</div></div></div>`, { pill: ['bad', '启动失败'], status: false });

/* 7 · Benchmark — context tiers as one axis with the model limit; results as lines over the same axis */
const tiers = ['8K', '32K', '64K', '128K', '256K', '384K', '512K', '768K', '1M'];
const pts = (vals, max, h = 120) => vals.map((v, i) => `${24 + i * (252 / 3)},${h - v / max * (h - 20)}`).join(' ');
const chart = (title, unit, vals, max, fmt) => `<div class="bc"><div class="row small"><b>${title}</b><span class="grow"></span><span class="muted">${unit}</span></div>
<svg class="chart" viewBox="0 0 300 140"><path d="M24 120H276" stroke="#eee"/>${[0, 1, 2, 3].map(i => `<text x="${24 + i * 252 / 3}" y="136" font-size="11" text-anchor="middle" fill="#8a8f94" font-family="monospace">${tiers[i]}</text>`).join('')}
<polyline points="${pts(vals, max)}" fill="none" stroke="#178a62" stroke-width="2"/>${vals.map((v, i) => `<circle cx="${24 + i * 252 / 3}" cy="${120 - v / max * 100}" r="3.5" fill="#fff" stroke="#178a62" stroke-width="2"/><text x="${24 + i * 252 / 3}" y="${120 - v / max * 100 - 10}" font-size="11.5" text-anchor="middle" fill="#221e1f" font-family="monospace">${fmt(v)}</text>`).join('')}</svg></div>`;
pages.benchmark = shell('bench', 'Benchmark 测试', `
<div class="row" style="margin-bottom:14px"><div class="tabs" style="margin:0"><span class="on">上下文档位</span><span>场景测试</span></div><span class="grow"></span><span class="muted small">${M} · 模型已就绪</span></div>
<div class="panel">
 <div class="sec"><div class="row"><div class="grow"><div class="h2">上下文档位实测</div><div class="muted small">逐档测试，单请求串行执行 · 4 个档位 · 4 个请求</div></div><span class="btn">历史对比</span><span class="btn pri">开始测试</span></div>
  <div class="axis"><div class="line"></div><div class="fill" style="width:37.5%"></div>${tiers.map((t, i) => `<div class="tick ${i < 4 ? 'on' : 'dis'}" style="left:${i * 12.5}%"><i></i>${t}</div>`).join('')}<div class="limit" style="left:37.5%"></div></div>
  <div class="grid4" style="margin-top:10px"><div class="field"><label>每档轮数</label><div class="input mono">1</div></div><div class="field"><label>最大输出 token</label><div class="input mono">512</div></div><div class="field"><label>每次超时（秒）</label><div class="input mono">600</div></div><div class="field"><label>出错即停</label><div class="row" style="height:34px"><span class="switch on"></span></div></div></div></div>
 <div class="sec"><div class="row"><span class="h3">各档位结果</span><span class="muted small">2026/10/16 22:05 · 用时 6 分 12 秒</span><span class="grow"></span><span class="btn ghost">复制图片</span></div>
  <div class="grid3" style="margin-top:6px">${chart('预填充速度', 'tok/s', [2410, 2180, 1960, 1520], 2600, v => v.toLocaleString())}${chart('解码速度', 'tok/s', [36.4, 33.9, 31.2, 27.8], 40, v => v.toFixed(1))}${chart('首字时间', 's', [3.4, 14.7, 32.6, 86.2], 95, v => v.toFixed(1))}</div></div>
 <div class="attn ok" style="border-bottom:0"><span class="dot"></span>128K 档解码仍有 27.8 tok/s，较 8K 下降 24%；所有档位均成功。</div>
</div>`);

/* 8 · 设置 — sections down one quiet column, labels left, controls right; no tiles */
const setTabs = on => `<div class="tabs">${['公共设置', '桌面监控', '聊天默认', 'API 与外部助手', '显存与会话', '应用更新', '关于'].map(t => `<span${t === on ? ' class="on"' : ''}>${t}</span>`).join('')}</div>`;
const srow = (l, h, c) => `<div class="srow"><div class="grow"><div>${l}</div>${h ? `<div class="muted small">${h}</div>` : ''}</div>${c}</div>`;
pages.settings = shell('settings', '设置', `${setTabs('公共设置')}
<div class="panel narrowp">
 <div class="sec"><div class="h3 sh">外观</div>${srow('主题', '', '<div class="tabs" style="margin:0"><span>深色</span><span class="on">浅色</span><span>跟随系统</span></div>')}${srow('界面语言', '共 10 种随包语言', '<div class="input" style="width:220px">简体中文 ▾</div>')}</div>
 <div class="sec"><div class="h3 sh">运行行为</div>${srow('关闭窗口后在后台运行', '托盘图标保留，服务不中断', '<span class="switch on"></span>')}</div>
 <div class="sec"><div class="h3 sh">本机后台</div>${srow('登录时自动启动后台', '', '<span class="switch"></span>')}${srow('运行期间保持模型就绪', '', '<span class="switch on"></span>')}${srow('自动恢复服务', '后台异常退出后按上次配置重启', '<span class="switch"></span>')}${srow('空闲时释放模型内存', '', '<div class="input" style="width:140px">15 分钟 ▾</div>')}</div>
</div>`);

/* 9 · API 与外部助手 — the endpoint is the focal object; clients are a quiet list under it */
pages.connections = shell('settings', '设置', `${setTabs('API 与外部助手')}
<div class="panel">
 <div class="sec conntop"><div class="grow"><div class="muted small">连接目标</div><div class="h2">${M} · ${CFG}</div></div><div class="input" style="width:300px">${M.slice(0, 26)}… ▾</div></div>
 <div class="sec"><div class="row"><code class="ep">${EP}</code><span class="btn">复制 API</span><span class="grow"></span><span class="chip"><span class="dot"></span>身份、模型列表、就绪检查通过</span><span class="btn">在线验证</span></div>
  <dl class="kv" style="margin-top:12px;max-width:640px"><dt>模型名</dt><dd class="mono small">${M}</dd><dt>API Key</dt><dd class="small">未设置 · 客户端可填 strata-local</dd><dt>MCP</dt><dd class="small">strata_status（只读）· strata_start</dd></dl></div>
 <div class="sec"><div class="row"><span class="h3">客户端</span><span class="grow"></span><span class="muted small">复制即用的配置，不修改客户端</span></div>
  <table class="table" style="margin-top:6px">${[['Cherry Studio', 'OpenAI 兼容 · 地址自动追加 /v1/chat/completions'], ['Cursor', 'OpenAI Base URL + 模型 ID'], ['Claude Code', 'MCP 服务器 · strata-manager'], ['Codex', 'config.toml 中的 model_provider'], ['OpenCode', 'provider.openai-compatible']].map(([n, d]) => `<tr><td style="width:180px"><b>${n}</b></td><td class="muted small">${d}</td><td class="r"><span class="btn">复制配置</span></td></tr>`).join('')}</table></div>
 <div class="sec"><div class="row"><div class="grow"><div class="h3">局域网共享与服务端鉴权</div><div class="muted small">允许同一局域网的设备调用本机 API；保存只修改受管配置并保留备份</div></div><span class="switch"></span></div></div>
</div>`);

/* 10 · 显存与会话 — reserve VRAM on the map itself; sessions are a short list */
pages['runtime-tools'] = shell('settings', '设置', `${setTabs('显存与会话')}
<div class="panel">
 <div class="sec row"><div class="grow"><div class="h2" style="font-size:16px">${M}</div><div class="muted small">当前服务已连接 · 执行结果和会话存档随模型区分</div></div><span class="btn ghost">刷新状态</span></div>
 <div class="sec"><div class="row"><span class="h3">临时让出显存</span><span class="muted small">为其他程序腾出显存，回答速度可能降低</span><span class="grow"></span><span class="num small">21.4 / 24 GB</span></div>
  <div style="margin-top:12px">${seg([['a', 50], ['b', 39]], 83)}</div><div class="legend"><span><i style="background:#178a62"></i>专家<b>12 GB</b></span><span><i style="background:#7cc2a5"></i>模型与运行时<b>9.4 GB</b></span><span>虚线：保留 4 GB 空闲后的上限</span></div>
  <div class="row" style="margin-top:14px"><div class="field" style="width:220px"><label>希望保留的空闲显存（MiB）</label><div class="input mono">4096</div></div><span class="grow"></span><span class="btn">恢复默认预留</span><span class="btn pri">释放显存</span></div></div>
 <div class="sec"><div class="row"><span class="h3">保存与恢复会话</span><span class="chip off">实验</span><span class="muted small">当前模型支持存档 · 槽位 4 · 已停放 3</span><span class="grow"></span><span class="btn">保存当前会话</span></div>
  <table class="table" style="margin-top:6px">${[['chat.bin', '32,768', '1.6 GB', '22:31'], ['code-review.bin', '18,204', '0.9 GB', '昨天 18:02'], ['long-doc.bin', '96,512', '4.1 GB', '10/14']].map(([f, t, s, d]) => `<tr><td class="mono">${f}</td><td class="num muted">${t} token</td><td class="num muted">${s}</td><td class="muted small">${d}</td><td class="r"><span class="btn">恢复</span></td></tr>`).join('')}</table></div>
</div>`);

/* 11 · 应用更新 — version is the anchor; notes read as a document */
pages.updates = shell('settings', '设置', `${setTabs('应用更新')}
<div class="panel narrowp">
 <div class="sec row"><div class="grow"><div class="muted small">当前版本</div><div class="big">v0.1.10</div></div><div style="text-align:right"><div class="chip"><span class="dot"></span>已是最新</div><div class="muted small" style="margin-top:6px">2 分钟前检查 · 签名已验证</div></div></div>
 <div class="sec">${srow('自动检查应用和 Strata 更新', '每天一次，发现新版本时提示，不自动安装', '<span class="switch on"></span>')}<div class="row" style="margin-top:6px"><span class="btn">检查更新</span><span class="grow"></span><span class="link">更新日志</span></div></div>
 <div class="sec notes"><div class="row"><span class="h3">本版更新</span><span class="grow"></span><span class="mono small muted">v0.1.10 · 2026-10-16</span></div>
 <ul><li>总览改为一屏查看服务、显存与内存占用、生成速度和最近请求，异常先提示。</li><li>运行配置可直接重启服务并切换模型。</li><li>十种界面语言补齐总览新增文案。</li></ul></div>
</div>`);

/* 12 · 关于 — the product and its parts as one compact line, licences as a quiet list */
pages.about = shell('settings', '设置', `${setTabs('关于')}
<div class="panel narrowp">
 <div class="sec row"><div class="brand" style="padding:0"><i style="width:44px;height:44px;border-radius:10px"></i></div><div class="grow"><div class="h2">Strata Manager</div><div class="muted small">面向 Strata 本地推理的桌面工作台 · 开源 MIT</div></div><span class="link">GitHub</span><span class="link">官网</span></div>
 <div class="sec"><dl class="kv"><dt>应用版本</dt><dd class="num">0.1.10</dd><dt>Strata 引擎</dt><dd class="num">0.1.43</dd><dt>当前模型</dt><dd class="mono small">${M}</dd><dt>数据目录</dt><dd class="mono small">D:/Apps/Strata Manager/data</dd></dl></div>
 <div class="sec"><div class="row"><span class="h3">第三方许可</span><span class="grow"></span><span class="link">全部许可</span></div><div class="muted small" style="margin-top:6px">Tauri · React · Outfit 字体（OFL）· lucide 图标 · GSAP</div></div>
</div>`);

for (const [k, v] of Object.entries(pages)) writeFileSync(`${dir}${k}.html`, v);
console.log(Object.keys(pages).join(' '));
