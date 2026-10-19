/**
 * Self-animating HTML recreations of Strata Manager screens.
 * Used by the homepage (bilingual, data-en attributes) and the static docs pages (single language)
 * instead of product screenshots. Animation is driven by website/demo-tiles.js through data-seq,
 * data-cycle and data-jit attributes; without JavaScript or with reduced motion the final state shows.
 * All numbers are example data (RTX 4080 SUPER: ~104 tok/s decode, ~3,200 tok/s prefill).
 */
const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function textHelper({ lang = 'zh', bilingual = false } = {}) {
  // T(zh, en, tag, attrs): one translated text element.
  return (zh, en = zh, tag = 'span', attrs = '') => {
    const extra = attrs ? ` ${attrs}` : '';
    if (bilingual) return `<${tag}${extra}${en !== zh ? ` data-en="${escape(en)}"` : ''}>${escape(zh)}</${tag}>`;
    return `<${tag}${extra}>${escape(lang === 'en' ? en : zh)}</${tag}>`;
  };
}

const seq = (k) => `data-seq="${k}"`;
const bar = (w, k, color = '') => `<i class="dd-meter"${color ? ` style="--c:${color}"` : ''}><b style="--w:${w}" ${seq(k)}></b></i>`;
const jit = (value, range, digits = 1, extra = '') => `<b class="dd-num" data-jit="${value}" data-range="${range}" data-digits="${digits}"${extra}>${Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}</b>`;
const spark = (points, color = 'var(--dd-accent)', k = 1) => {
  const top = Math.max(...points), low = Math.min(...points);
  const max = top + (top - low) * 0.15 || top + 1, min = low - (top - low) * 0.6;
  const d = points.map((v, i) => `${(i / (points.length - 1) * 120).toFixed(1)} ${(30 - (v - min) / (max - min || 1) * 26).toFixed(1)}`).join(' L');
  return `<svg class="dd-spark" viewBox="0 0 120 32" preserveAspectRatio="none" aria-hidden="true" style="--c:${color}" ${seq(k)}><path d="M${d}"/></svg>`;
};
const wave = (n, base, amp, phase = 0) => Array.from({ length: n }, (_, i) => base + Math.sin(i * 0.7 + phase) * amp + Math.cos(i * 1.9 + phase) * amp * 0.4);
const cols = (n, phase, k = 1) => `<div class="dd-cols" aria-hidden="true">${Array.from({ length: n }, (_, i) => `<i style="--h:${(0.25 + 0.65 * Math.abs(Math.sin(i * 0.45 + phase))).toFixed(2)};--d:${i}" ${seq(k)}></i>`).join('')}</div>`;

const kinds = {
  overview: (T) => ({
    title: T('总览', 'Overview'), right: `<span class="dd-live"><i></i>${T('生成中', 'Generating')}</span>`, steps: 4,
    body: `<div class="dd-grid2">
      <div class="dd-card"><small>${T('生成速度', 'Generation')}</small><p class="dd-big">${jit(104.6, 4)}<small>tok/s</small></p>${spark(wave(24, 103, 3), 'var(--dd-accent)', 1)}</div>
      <div class="dd-card"><small>RTX 4080 SUPER</small>
        <p class="dd-row"><span>${T('显存', 'VRAM')}</span>${bar('.66', 1)}<span class="mono">21 / 32 GB</span></p>
        <p class="dd-row"><span>${T('内存', 'RAM')}</span>${bar('.64', 2, '#4f55c4')}<span class="mono">62 / 96 GB</span></p>
        <p class="dd-row"><span>GPU</span>${bar('.86', 3, '#b4581c')}<span class="mono">86%</span></p></div></div>
      <ol class="dd-list mono">
        <li ${seq(2)}><span>14:34:51</span><span>4,096 → 384</span><span>104.2 tok/s</span></li>
        <li ${seq(3)}><span>14:34:31</span><span>2,310 → 512</span><span>101.8 tok/s</span></li>
        <li ${seq(4)}><span>14:34:11</span><span>820 → 256</span><span>106.3 tok/s</span></li></ol>`,
  }),
  benchmark: (T) => ({
    title: T('Benchmark · 上下文档位', 'Benchmark · Context tiers'), right: '<span class="mono">Qwen3.8-Flash-Next · IQ3_S</span>', steps: 5,
    body: `<p class="dd-row dd-head mono"><span>${T('档位', 'Tier')}</span><span>${T('预填充', 'Prefill')}</span><span>${T('解码', 'Decode')}</span></p>
      ${[['4K', '3,184', '104.6'], ['16K', '3,020', '101.2'], ['64K', '2,560', '93.8'], [T('128K 最大', '128K max'), '2,110', '85.7']].map(([tier, pre, dec], i) => `<p class="dd-row dd-tier mono" ${seq(i + 1)}><span>${tier}</span><span>${pre}</span><span>${dec}</span><em class="dd-check"></em></p>`).join('')}
      <p class="dd-foot"><span>${T('在核验的 128K 上限内串行测试', 'Serial run within the verified 128K limit')}</span><span class="dd-chip" ${seq(5)}>${T('完成 4 / 4', 'Done 4 / 4')}</span></p>`,
  }),
  'scenario-benchmark': (T) => ({
    title: T('场景测试', 'Scenario tests'), right: `<span class="mono">${T('串行', 'Serial')}</span>`, steps: 5,
    body: [[T('聊天短问答', 'Short chat'), '.92', '106.1 tok/s'], [T('编程补全', 'Code completion'), '.88', '102.4 tok/s'], [T('长文档总结', 'Long document'), '.74', '88.9 tok/s'], [T('工具调用', 'Tool calls'), '.84', '98.7 tok/s']]
      .map(([name, w, value], i) => `<p class="dd-row dd-scn"><span>${name}</span>${bar(w, i + 1)}<span class="mono" ${seq(i + 1)}>${value}</span></p>`).join('')
      + `<p class="dd-foot"><span>${T('每项同一模型与配置依次运行', 'Each scenario runs in turn with the same model and config')}</span><span class="dd-chip" ${seq(5)}>${T('已完成', 'Done')}</span></p>`,
  }),
  'benchmark-report': (T) => ({
    title: T('测试报告', 'Benchmark report'), right: `<span class="dd-btn">${T('复制图片', 'Copy image')}</span>`, steps: 3,
    body: `<div class="dd-grid2">
      <div class="dd-card"><small>${T('预填充 tok/s', 'Prefill tok/s')}</small><p class="dd-big mono">3,184</p>${spark([3184, 3020, 2560, 2110], '#2a6fb6', 1)}</div>
      <div class="dd-card"><small>${T('解码 tok/s', 'Decode tok/s')}</small><p class="dd-big mono">104.6</p>${spark([104.6, 101.2, 93.8, 85.7], 'var(--dd-accent)', 2)}</div></div>
      <div class="dd-card"><small>${T('资源趋势 · 显存 / GPU', 'Resource trend · VRAM / GPU')}</small>${cols(28, 0.4, 3)}</div>`,
  }),
  'history-comparison': (T) => ({
    title: T('历史与升级对照', 'History and upgrade comparison'), right: '<span class="mono">A · B</span>', steps: 4,
    body: `<p class="dd-row dd-head mono"><span>${T('指标', 'Metric')}</span><span>A</span><span>B</span></p>
      <p class="dd-row mono" ${seq(1)}><span>TTFT (ms)</span><span>210</span><span>198</span></p>
      <p class="dd-row mono" ${seq(2)}><span>Prefill (tok/s)</span><span>3,150</span><span>3,210</span></p>
      <p class="dd-row mono" ${seq(3)}><span>Decode (tok/s)</span><span>96.8</span><span class="dd-up">104.6</span></p>
      <p class="dd-foot" ${seq(4)}><span class="dd-warn">${T('未核验：硬件、身份', 'Not verified: hardware, identity')}</span><span>${T('不下直接提速结论', 'No direct speedup claim')}</span></p>`,
  }),
  'model-download-detail': (T) => ({
    title: T('模型详情 · 资源评估', 'Model details · Resource check'), right: '<span class="mono">Swift 1.5</span>', steps: 4,
    body: `<p class="dd-chips" data-cycle>${['Q8_0', 'Q4_K_M', 'IQ3_S'].map((q, i) => `<span class="dd-chip${i === 2 ? ' is-on' : ''}">${q}</span>`).join('')}</p>
      <p class="dd-row"><span>${T('显存', 'VRAM')}</span>${bar('.66', 1)}<span class="mono">21 / 32 GB</span></p>
      <p class="dd-row"><span>${T('内存', 'RAM')}</span>${bar('.65', 2, '#4f55c4')}<span class="mono">62 / 96 GB</span></p>
      <p class="dd-kv mono" ${seq(3)}><span>ctx 131072</span><span>KV int8</span><span>${T('槽 2', 'slots 2')}</span><span>GPU ${T('全部层', 'all layers')}</span></p>
      <p class="dd-foot" ${seq(4)}><span class="dd-ok">${T('适合本机', 'Fits this PC')}</span><span class="mono">≈ 104 tok/s</span></p>`,
  }),
  'api-verification': (T) => ({
    title: T('API 核验', 'API verification'), right: '<span class="mono">127.0.0.1:8080/v1</span>', steps: 4,
    body: `<ol class="dd-steps">${[[T('文本补全', 'Text completion'), '0.42 s'], [T('工具调用结构', 'Tool-call structure'), '0.88 s'], [T('图片输入', 'Image input'), '1.31 s']].map(([name, t], i) => `<li ${seq(i + 1)}><em class="dd-check"></em><span>${name}</span><span class="mono">${t}</span></li>`).join('')}</ol>
      <p class="dd-foot" ${seq(4)}><span class="dd-ok">${T('本次验证通过 · 不执行工具', 'Verification passed · tools are never executed')}</span></p>`,
  }),
  'floating-monitor': (T) => ({
    title: T('桌面监控浮条', 'Floating monitor'), right: `<span class="dd-live"><i></i>${T('生成中', 'Generating')}</span>`, steps: 1, strip: true,
    body: `<div class="dd-strip">${[[T('生成', 'Gen'), jit(104, 5, 0), 't/s', '#16834f'], [T('读取', 'Input'), jit(3.2, 0.2, 1), 'k t/s', '#2a6fb6'], ['GPU', jit(86, 5, 0), '%', '#b4581c'], [T('显存', 'VRAM'), '<b class="dd-num">21.0</b>', 'GiB', '#13797a'], ['CPU', jit(12, 3, 0), '%', '#8243b0'], [T('内存', 'RAM'), '<b class="dd-num">62.0</b>', 'GiB', '#4f55c4']]
      .map(([label, value, unit, c], i) => `<span style="--c:${c}"><small>${label}</small><span>${value}<small>${unit}</small></span>${spark(wave(16, 10, 3, i), c, 1)}</span>`).join('')}</div>`,
  }),
  'floating-monitor-settings': (T) => ({
    title: T('浮条设置', 'Floating-monitor settings'), right: `<span class="dd-toggle is-on" ${seq(1)}></span>`, steps: 3,
    body: `<p class="dd-row"><span>${T('布局', 'Layout')}</span><span class="dd-chips" data-cycle>${[T('横排', 'Row'), T('两行', 'Two rows'), T('网格', 'Grid')].map((l, i) => `<span class="dd-chip${i === 0 ? ' is-on' : ''}">${l}</span>`).join('')}</span></p>
      <p class="dd-row"><span>${T('文字大小', 'Text size')}</span>${bar('.55', 2)}<span class="mono">13 px</span></p>
      <ol class="dd-order">${[[T('生成', 'Gen'), '#16834f'], [T('读取', 'Input'), '#2a6fb6'], ['GPU', '#b4581c'], [T('显存', 'VRAM'), '#13797a']].map(([l, c], i) => `<li style="--c:${c}" ${seq(Math.min(3, i + 1))}><i></i>${l}<span class="mono">⋮⋮</span></li>`).join('')}</ol>`,
  }),
  'overview-api-guide': (T) => ({
    title: T('总览 · 接入 API', 'Overview · Connect the API'), right: `<span class="dd-btn" ${seq(1)}>${T('复制', 'Copy')}</span>`, steps: 4,
    body: `<p class="dd-code mono" data-type ${seq(1)}>http://127.0.0.1:8080/v1</p>
      <ol class="dd-steps">${[T('复制 API 地址', 'Copy the API URL'), T('选择客户端：Cursor / Codex / Claude Code', 'Pick a client: Cursor / Codex / Claude Code'), T('一键验证连接', 'Verify the connection')].map((s, i) => `<li ${seq(i + 2)}><em class="dd-check"></em><span>${s}</span></li>`).join('')}</ol>`,
  }),
  'common-chat-settings': (T) => ({
    title: T('公共聊天默认值', 'Common chat defaults'), right: `<span class="mono">${T('新模型继承', 'Inherited by new models')}</span>`, steps: 4,
    body: [['temperature', '0.7', '.35'], ['top_p', '0.95', '.95'], ['max_tokens', '4,096', '.5']].map(([k, v, w], i) => `<p class="dd-row mono"><span>${k}</span>${bar(w, i + 1)}<span>${v}</span></p>`).join('')
      + `<p class="dd-row"><span>MCP</span><span class="dd-toggle is-on" ${seq(4)}></span><span class="dd-chip">${T('已有自定义值保留', 'Custom values kept')}</span></p>`,
  }),
  connections: (T) => ({
    title: T('连接 · 客户端', 'Connections · Clients'), right: `<span class="dd-chip dd-ok" ${seq(3)}>${T('已保存访问密钥', 'Access key saved')}</span>`, steps: 3,
    body: `<p class="dd-chips" data-cycle>${['Cursor', 'Codex', 'Claude Code', 'Cherry Studio'].map((c, i) => `<span class="dd-chip${i === 0 ? ' is-on' : ''}">${c}</span>`).join('')}</p>
      <pre class="dd-code mono" ${seq(1)}><span data-type>{ "baseURL": "http://127.0.0.1:8080/v1",</span>
<span data-type>  "model": "qwen3.8-flash-next" }</span></pre>
      <p class="dd-foot" ${seq(2)}><span>${T('API 与 MCP 配置均可复制', 'Copy API or MCP configs')}</span><span class="dd-btn">${T('复制配置', 'Copy config')}</span></p>`,
  }),
  'runtime-download': (T) => ({
    title: T('Strata · 下载来源', 'Strata · Download source'), right: '<span class="mono">v0.1.43</span>', steps: 5,
    body: `<p class="dd-chips" data-cycle>${[T('官方来源', 'Official'), T('HTTPS 镜像', 'HTTPS mirror'), T('本地 ZIP', 'Local ZIP')].map((c, i) => `<span class="dd-chip${i === 0 ? ' is-on' : ''}">${c}</span>`).join('')}</p>
      <p class="dd-row"><span>${T('网络测试', 'Network test')}</span>${bar('.82', 1)}<span class="mono">38 ms</span></p>
      <p class="dd-row"><span>${T('下载', 'Download')}</span>${bar('1', 2)}<span class="mono">412 MB/s</span></p>
      <ol class="dd-steps">${[T('大小校验', 'Size check'), T('SHA256 校验', 'SHA256 check')].map((s, i) => `<li ${seq(i + 3)}><em class="dd-check"></em><span>${s}</span></li>`).join('')}</ol>
      <p class="dd-foot" ${seq(5)}><span class="dd-ok">${T('校验通过后才替换', 'Replaced only after verification')}</span></p>`,
  }),
  'service-status': (T) => ({
    title: T('服务状态', 'Service status'), right: `<span class="dd-live"><i></i>${T('生成中', 'Generating')}</span>`, steps: 2,
    body: `<div class="dd-grid2">
      <div class="dd-card"><small>${T('生成', 'Generation')}</small><p class="dd-big">${jit(104.6, 4)}<small>tok/s</small></p>${spark(wave(30, 102, 4, 1), 'var(--dd-accent)', 1)}</div>
      <div class="dd-card"><small>${T('输入处理', 'Input processing')}</small><p class="dd-big">${jit(3184, 120, 0)}<small>tok/s</small></p>${spark(wave(30, 2800, 500, 2).map((v, i) => (i % 7 === 2 ? v : v * 0.2)), '#2a6fb6', 2)}</div></div>
      <p class="dd-foot"><span>${T('最近 60 个采样 · 生成与输入处理分开统计', 'Last 60 samples · generation and input processing kept separate')}</span></p>`,
  }),
  'app-updates': (T, { appVersion } = {}) => ({
    title: T('应用更新', 'App updates'), right: appVersion ? `<span class="mono">v${escape(appVersion)}</span>` : '', steps: 4,
    body: `<p class="dd-row"><span>${T('检查更新', 'Check for updates')}</span>${bar('1', 1)}<span class="dd-chip" ${seq(1)}>${T('已是最新', 'Up to date')}</span></p>
      <ul class="dd-notes">${[T('内置双语更新日志，离线可读', 'Bundled bilingual notes, readable offline'), T('先阅读，再确认安装', 'Read first, then confirm'), T('校验 Tauri 签名', 'Tauri signature verified')].map((s, i) => `<li ${seq(i + 2)}>${s}</li>`).join('')}</ul>`,
  }),
  'runtime-tools': (T) => ({
    title: T('显存与会话工具', 'VRAM and session tools'), right: '<span class="mono">RTX 4080 SUPER</span>', steps: 4,
    body: [[T('槽 1 · 聊天', 'Slot 1 · chat'), '.42', '6.8 GB'], [T('槽 2 · Cursor', 'Slot 2 · Cursor'), '.61', '9.7 GB'], [T('KV 缓存', 'KV cache'), '.28', '4.5 GB']].map(([n, w, v], i) => `<p class="dd-row"><span>${n}</span>${bar(w, i + 1)}<span class="mono">${v}</span></p>`).join('')
      + `<p class="dd-foot" ${seq(4)}><span>${T('空闲会话可单独释放', 'Free idle sessions one by one')}</span><span class="dd-btn">${T('释放', 'Free')}</span></p>`,
  }),
  'running-services': (T) => ({
    title: T('运行中实例', 'Running instances'), right: '<span class="mono">Windows</span>', steps: 3,
    body: [['Qwen3.8-Flash-Next', 'IQ3_S · ctx 128K', ':8080'], ['Swift 1.5', 'IQ3_S · ctx 32K', ':8081']].map(([m, c, p], i) => `<p class="dd-svc" ${seq(i + 1)}><span class="dd-live"><i></i></span><b>${m}</b><span class="mono">${c}</span><span class="mono">127.0.0.1${p}/v1</span></p>`).join('')
      + `<p class="dd-foot" ${seq(3)}><span>${T('优先重连已有 Manager 后台', 'Reconnects to an existing Manager backend first')}</span></p>`,
  }),
  config: (T) => ({
    title: T('运行配置', 'Run configuration'), right: `<span class="dd-chips" data-cycle><span class="dd-chip is-on">${T('图形', 'Form')}</span><span class="dd-chip">JSON</span></span>`, steps: 4,
    body: [['--ctx-size', '131072'], ['--n-gpu-layers', '99'], ['--cache-type-k', 'q8_0'], ['--parallel', '2']].map(([k, v], i) => `<p class="dd-row mono" ${seq(i + 1)}><span>${k}</span><span class="dd-field">${v}</span><em class="dd-check"></em></p>`).join('')
      + `<p class="dd-foot"><span class="dd-ok" ${seq(4)}>${T('校验通过 · 已备份', 'Validated · backed up')}</span><span>${T('选项来自 engine --help', 'Options read from engine --help')}</span></p>`,
  }),
  chat: (T) => ({
    title: T('聊天', 'Chat'), right: '<span class="mono">104.6 tok/s · TTFT 0.38 s</span>', steps: 3,
    body: `<p class="dd-bubble is-me" ${seq(1)}>${T('用三点总结 Strata 的上下文档位测试。', 'Summarize the context-tier benchmark in three points.')}</p>
      <div class="dd-bubble" ${seq(2)}><p data-type>${T('1. 在核验上限内按 4K→128K 串行测试；2. 同时记录预填充与解码；3. 结果可匿名分享到排行榜。', '1. Tiers run serially from 4K to 128K within the verified limit; 2. prefill and decode are recorded together; 3. results can be shared anonymously.')}</p></div>
      <p class="dd-foot" ${seq(3)}><span>${T('等待 0.21 s · 思考 0.80 s · 正文 1.24 s', 'Wait 0.21 s · think 0.80 s · body 1.24 s')}</span></p>`,
  }),
  tuning: (T) => ({
    title: T('调优 · 比较配置', 'Tuning · Compare configs'), right: `<span class="dd-chips" data-cycle>${[T('聊天', 'Chat'), T('编程 / Agent', 'Coding / Agent'), T('长文档', 'Long docs')].map((c, i) => `<span class="dd-chip${i === 1 ? ' is-on' : ''}">${c}</span>`).join('')}</span>`, steps: 4,
    body: `<p class="dd-row dd-head"><span>${T('配置', 'Config')}</span><span>${T('速度', 'Speed')}</span><span>${T('显存', 'VRAM')}</span></p>
      ${[['A · ctx 32K', '.80', '92.4', '18 GB'], ['B · ctx 64K KV int8', '.90', '104.6', '21 GB'], ['C · ctx 128K', '.70', '86.1', '27 GB']].map(([n, w, s, v], i) => `<p class="dd-row dd-cfg${i === 1 ? ' is-best' : ''}" ${seq(i + 1)}><span class="mono">${n}</span>${bar(w, i + 1)}<span class="mono">${s} · ${v}</span></p>`).join('')}
      <p class="dd-foot" ${seq(4)}><span class="dd-ok">${T('推荐 B · 一键应用', 'B recommended · apply in one click')}</span></p>`,
  }),
  settings: (T) => ({
    title: T('设置', 'Settings'), right: '', steps: 2,
    body: `<div class="dd-split"><ul class="dd-menu" data-cycle>${[T('公共设置', 'Shared defaults'), T('桌面监控', 'Desktop monitor'), T('聊天', 'Chat'), 'API', T('显存与会话', 'VRAM & sessions'), T('更新', 'Updates'), T('关于', 'About')].map((m, i) => `<li${i === 0 ? ' class="is-on"' : ''}>${m}</li>`).join('')}</ul>
      <div>${[T('开机自动启动服务', 'Start service at login'), T('显示桌面浮条', 'Show floating monitor'), T('局域网访问 API', 'Allow LAN API access')].map((s, i) => `<p class="dd-row"><span>${s}</span><span class="dd-toggle${i !== 2 ? ' is-on' : ''}"${i < 2 ? ` ${seq(i + 1)}` : ''}></span></p>`).join('')}</div></div>`,
  }),
  'language-settings': (T) => ({
    title: T('语言', 'Language'), right: `<span class="dd-chip is-on">${T('跟随系统', 'Follow system')}</span>`, steps: 1,
    body: `<ul class="dd-langs" data-cycle>${['简体中文', 'English', '日本語', '한국어', 'Español', 'Français', 'Deutsch', 'Русский', 'Português', '繁體中文'].map((l, i) => `<li${i === 0 ? ' class="is-on"' : ''}>${l}</li>`).join('')}</ul>`,
  }),
};
kinds['runtime-download-settings'] = kinds['runtime-download'];
kinds['product-cover'] = kinds.overview;
kinds.models = kinds['model-download-detail'];
kinds.monitor = kinds['service-status'];
kinds.usage = (T) => ({
  title: T('API 用量', 'API usage'), right: '<span class="mono">24h</span>', steps: 2,
  body: `<p class="dd-kv mono"><span>${T('请求', 'Requests')} 315</span><span>${T('成功率', 'Success')} 95.6%</span><span>${T('生成', 'Gen')} 103.8 tok/s</span></p>${cols(32, 0.6, 1)}<p class="dd-foot" ${seq(2)}><span>${T('统计不抓请求正文', 'Request bodies are never captured')}</span></p>`,
});

export const demoTileKinds = Object.freeze(Object.keys(kinds));

/** Resolve a screenshot path such as docs/screenshots/changelog/0.1.5/benchmark.zh.webp to a demo kind. */
export function demoKindForScreenshot(path) {
  const name = String(path).split('/').at(-1).replace(/\.(?:zh|en)\.webp$|\.webp$/, '');
  return kinds[name] ? name : null;
}

export function renderDemoTile(kind, { lang = 'zh', bilingual = false, label, labelEn, appVersion } = {}) {
  const spec = kinds[kind];
  if (!spec) throw new Error(`Unknown demo tile: ${kind}`);
  const T = textHelper({ lang, bilingual });
  const tile = spec(T, { appVersion });
  const aria = bilingual ? `aria-label="${escape(label || kind)}"${labelEn ? ` data-label-en="${escape(labelEn)}"` : ''}` : `aria-label="${escape(label || kind)}"`;
  return `<div class="dd${tile.strip ? ' is-strip' : ''}" data-demo-tile="${kind}" data-steps="${tile.steps}" role="img" ${aria}>`
    + `<div class="dd-bar"><span class="dd-dots" aria-hidden="true"><i></i><i></i><i></i></span><b>${tile.title}</b>${tile.right ? `<span class="dd-right">${tile.right}</span>` : ''}</div>`
    + `<div class="dd-body">${tile.body}</div></div>`;
}

/**
 * Replace homepage placeholders <div class="dd-slot" data-demo-tile="kind" aria-label="…" data-label-en="…"></div>.
 * The markup sits in a <template> so these below-the-fold demos add no DOM until demo-tiles.js builds them.
 */
export function injectDemoTiles(html, { appVersion } = {}) {
  return html.replace(/<div class="dd-slot" data-demo-tile="([a-z-]+)" aria-label="([^"]*)" data-label-en="([^"]*)"><\/div>/g,
    (_, kind, label, labelEn) => `<div class="dd-slot" data-slot="${kind}"><template>${renderDemoTile(kind, { bilingual: true, label, labelEn, appVersion })}</template></div>`);
}
