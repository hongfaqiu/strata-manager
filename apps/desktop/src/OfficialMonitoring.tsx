import type { AppLanguage } from "@strata-manager/core";
import { Fragment, type ReactNode } from 'react';
import { asObject, decodeStreams, decodeStreamsLabel, normalizeMetrics, requestPrefillTokS, type JsonObject } from '@strata-manager/core';
import sprite from './official/sprite.svg';
import { SlotMonitor } from './SlotMonitor';

export interface OfficialMonitoringProps {
  raw: JsonObject;
  language: AppLanguage;
  showAll: boolean;
  onShowAll: () => void;
  onRequest?: (request: JsonObject) => void;
  error?: string;
  sampledAt?: number;
  stale?: boolean;
}
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const objects = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(asObject) : [];
const metricDefinitions = [
  { key: 'speed', cn: '速度', en: 'Speed', icon: 'gauge', series: 'tok_s' },
  { key: 'gpu', cn: 'GPU 负载', en: 'GPU load', icon: 'gpu', series: 'gpu_util', max: 100 },
  { key: 'vram', cn: '显存', en: 'VRAM', icon: 'layers', series: 'gpu_mem_used' },
  { key: 'temp', cn: 'GPU 温度', en: 'GPU temp', icon: 'thermometer', series: 'gpu_temp', max: 90, tone: 'warn' },
  { key: 'power', cn: '功耗', en: 'Power', icon: 'bolt', series: 'gpu_power' },
  { key: 'pcie', cn: 'PCIe', en: 'PCIe', icon: 'link', series: 'gpu_pcie_rx_mb', tone: 'info' },
  { key: 'cpu', cn: 'CPU', en: 'CPU', icon: 'cpu', series: 'cpu', max: 100 },
  { key: 'disk', cn: '磁盘读取', en: 'Disk read', icon: 'disk', series: 'disk_read_mb', tone: 'info' },
] as const;

/** Official spark geometry. Missing samples break the line rather than inventing zero measurements. */
function sparkPaths(value: unknown, fixedMax?: number | null): { line: string; area: string } {
  if (!Array.isArray(value) || value.length < 2) return { line: '', area: '' };
  const samples = value.map(number), finite = samples.filter((n): n is number => n !== null);
  if (finite.length < 2) return { line: '', area: '' };
  const top = Math.max(fixedMax ?? 0, ...finite, 1e-9);
  const segments: { x: number; y: number }[][] = [];
  let segment: { x: number; y: number }[] = [];
  samples.forEach((n, i) => {
    if (n === null) { if (segment.length) segments.push(segment); segment = []; return; }
    segment.push({ x: i / (samples.length - 1) * 100, y: 30 - n / top * 26 });
  });
  if (segment.length) segments.push(segment);
  const lines: string[] = [], areas: string[] = [];
  for (const points of segments) {
    if (points.length < 2) continue;
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join('');
    lines.push(line);
    areas.push(`${line}L${points.at(-1)!.x.toFixed(2)},32L${points[0]!.x.toFixed(2)},32Z`);
  }
  return { line: lines.join(''), area: areas.join('') };
}
function SparkPaths({ values, max }: { values: unknown; max?: number | null }) {
  const paths = sparkPaths(values, max);
  return <><path className="area" fill="currentColor" opacity=".12" d={paths.area} /><path className="line" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" d={paths.line} /></>;
}

/** Mirrors serve/web/index.html monitor DOM and app.js renderMonitor/renderConvCache/renderMcp. */
export function MonitoringPage({ raw, language, showAll, onShowAll, onRequest, error, sampledAt, stale = false }: OfficialMonitoringProps) {
  const t = (cn: string, en: string) => language === 'zh-CN' ? cn : en;
  const fmt = (value: unknown, digits = 0) => { const n = number(value); return n === null ? '–' : n.toLocaleString(language, { maximumFractionDigits: digits, minimumFractionDigits: digits }); };
  const gb = (value: unknown, digits = 1) => { const n = number(value); return n === null ? '–' : fmt(n / 1073741824, digits); };
  const kfmt = (value: unknown) => { const n = number(value); return n === null ? '–' : n >= 1000 ? `${fmt(n / 1000, n >= 10000 ? 0 : 1)}k` : fmt(n); };
  const ctxfmt = (value: unknown) => { const n = number(value); return n !== null && n > 0 && n % 1024 === 0 ? `${fmt(n / 1024)}K` : kfmt(n); };
  const live = asObject(raw.live), hw = asObject(raw.hardware), st = asObject(raw.hardware_static), eng = asObject(raw.engine), history = asObject(raw.history);
  const requests = objects(raw.requests), last = requests[0], cache = asObject(raw.conversation_cache), totals = asObject(raw.totals);
  const mcp = asObject(raw.mcp), servers = objects(mcp.servers), gpus = objects(hw.gpus), multi = gpus.length > 1;
  const metrics = normalizeMetrics(raw);
  const outdated = stale || !!error;
  const state = outdated ? 'unknown' : typeof live.state === 'string' ? live.state : 'unknown';
  const queued = outdated ? null : number(live.queued);
  const activeBadge = queued !== null && queued > 0 ? 'queued' : state;
  const ratio = (a: unknown, b: unknown) => { const x = number(a), y = number(b); return x !== null && y !== null && y > 0 ? Math.max(0, Math.min(100, x / y * 100)) : null; };
  let stateLabel = state === 'unknown' ? '–' : t('等待请求', 'Waiting for a request'), stateDetail = '', statePercent: number | null = null;
  if (outdated) { stateLabel = t('实时状态未核验', 'Live state unverified'); stateDetail = error ?? t('数据已过期或服务离线', 'Data is stale or the service is offline'); }
  else if (state === 'reading') {
    stateLabel = t('处理输入', 'Processing input');
    statePercent = ratio(live.prompt_read, live.prompt_total);
    stateDetail = statePercent !== null ? `${fmt(live.prompt_read)} / ${fmt(live.prompt_total)} tokens · ${fmt(statePercent)}%` : `${fmt(live.prompt_tokens)} tokens`;
  } else if (state === 'generating') {
    const phase = typeof live.phase === 'string' && live.phase ? live.phase : null;
    stateLabel = phase ? (language !== 'zh-CN' ? phase[0]!.toUpperCase() + phase.slice(1) : ({ reasoning: '思考', content: '生成回答' }[phase] ?? phase)) : t('生成中', 'Generating');
    statePercent = ratio(live.generated, live.max_tokens);
    stateDetail = `${fmt(live.generated)} tokens · ${fmt(live.tok_s, 1)} tok/s`;
  } else if (last) stateDetail = `${t('最近：', 'last: ')}${fmt(last.output_tokens)} tokens${number(last.decode_tok_s) !== null ? ` ${t('速度', 'at')} ${fmt(last.decode_tok_s, 1)} tok/s` : ''}`;

  const per = (fn: (gpu: JsonObject) => string) => gpus.map(gpu => `GPU ${fmt(gpu.index)} ${fn(gpu)}`).join(' · ');
  const generation = number(hw.gpu_pcie_gen_max) ?? number(hw.gpu_pcie_gen);
  const diskRead = number(hw.disk_read_mb), diskBig = diskRead !== null && diskRead >= 1000;
  const values: Record<string, { value: unknown; unit: string; sub: string }> = {
    speed: { value: metrics.decodeTokS === null ? null : fmt(metrics.decodeTokS, 1), unit: 't/s', sub: state === 'generating' ? decodeStreamsLabel(decodeStreams(raw), language === 'zh-CN') ?? t('当前生成', 'Generating now') : last ? t('最近生成', 'Last generation') : t('生成速度', 'Generation speed') },
    prefill: { value: metrics.prefillTokS === null ? null : fmt(metrics.prefillTokS), unit: 't/s', sub: state === 'reading' ? t('当前输入处理', 'Processing input now') : state === 'generating' ? t('本次输入处理', 'Input processing this request') : last ? t('最近输入处理', 'Last input processing') : t('输入处理', 'Input processing') },
    gpu: { value: number(hw.gpu_util) === null ? null : fmt(hw.gpu_util), unit: '%', sub: multi ? per(gpu => number(gpu.util) === null ? '–' : `${fmt(gpu.util)}%`) : typeof st.gpu_name === 'string' ? st.gpu_name : st.gpu_note ? t('不可用', 'not available') : '' },
    vram: { value: number(hw.gpu_mem_used) === null ? null : gb(hw.gpu_mem_used), unit: number(hw.gpu_mem_total) !== null && Number(hw.gpu_mem_total) > 0 ? `/ ${gb(hw.gpu_mem_total, 0)} GB` : 'GB', sub: multi ? per(gpu => number(gpu.mem_used) === null ? '–' : `${gb(gpu.mem_used)} GB`) : number(eng.expert_slots) !== null && Number(eng.expert_slots) > 0 ? `${fmt(eng.expert_slots)} ${t('个专家已缓存', 'experts cached')}` : st.gpu_note ? t('Windows AMD 当前不可用', 'not available on Windows AMD yet') : '' },
    temp: { value: number(hw.gpu_temp) === null ? null : fmt(hw.gpu_temp), unit: '°C', sub: multi ? per(gpu => number(gpu.temp) === null ? '–' : `${fmt(gpu.temp)}°`) : '' },
    power: { value: number(hw.gpu_power) === null ? null : fmt(hw.gpu_power), unit: 'W', sub: number(hw.gpu_power_limit) !== null && Number(hw.gpu_power_limit) > 0 ? `${t('上限', 'of')} ${fmt(hw.gpu_power_limit)} W${t('', ' limit')}` : '' },
    pcie: { value: generation === null ? null : `Gen${fmt(generation)}`, unit: number(hw.gpu_pcie_width) === null ? '' : `x${fmt(hw.gpu_pcie_width)}`, sub: number(hw.gpu_pcie_rx_mb) === null ? '' : `${t('传至 GPU', 'to GPU')} ${fmt(hw.gpu_pcie_rx_mb, Number(hw.gpu_pcie_rx_mb) < 10 ? 1 : 0)} MB/s${number(hw.gpu_pcie_gen) !== null && generation !== null && Number(hw.gpu_pcie_gen) < generation ? ` · ${t('空闲', 'idle')} Gen${fmt(hw.gpu_pcie_gen)}` : ''}` },
    cpu: { value: number(hw.cpu) === null ? null : fmt(hw.cpu), unit: '%', sub: number(st.threads) !== null && Number(st.threads) > 0 ? `${number(st.cores) !== null && Number(st.cores) > 0 ? `${fmt(st.cores)} ${t('核心', 'cores')} · ` : ''}${fmt(st.threads)} ${t('线程', 'threads')}` : '' },
    disk: { value: diskRead === null ? null : fmt(diskBig ? diskRead / 1024 : diskRead, diskBig ? 2 : diskRead < 10 ? 1 : 0), unit: diskRead === null ? '' : diskBig ? 'GB/s' : 'MB/s', sub: diskRead === null ? st.psutil ? '' : t('需要 psutil（安装时自动安装）', 'needs psutil (setup installs it)') : number(hw.disk_write_mb) === null ? '' : `${t('写入', 'write')} ${fmt(hw.disk_write_mb, 1)} MB/s` },
  };
  const metricValue = (key: string) => { const v = values[key]!; return <><span className="st-metric__value" id={`mv-${key}`}>{v.value === null ? '–' : <>{String(v.value)}{v.unit && <small>{v.unit}</small>}</>}</span><span className="st-metric__sub" id={`ms-${key}`}>{v.sub}</span></>; };
  const prompt = number(state === 'idle' ? last?.prompt_tokens : live.prompt_tokens), generated = number(state === 'idle' ? last?.output_tokens : live.generated);
  const used = !last && state === 'idle' ? 0 : prompt !== null && generated !== null ? prompt + generated : null;
  const contextPercent = ratio(used, eng.max_context), contextArc = contextPercent === null ? 0 : 235.6 * contextPercent / 100;
  const expertMiB = number(eng.expert_cache_mib), expertBytes = expertMiB === null ? null : expertMiB * 1048576;
  const ramPercent = ratio(hw.ram_used, hw.ram_total), tempPercent = ratio(hw.gpu_temp, 100);
  const progress = (barId: string, percent: number | null, containerId?: string, tone?: string) => <div className="st-progress" id={containerId} data-tone={tone}><div className="st-progress__bar" id={barId} style={{ width: `${percent ?? 0}%` }} /></div>;
  const kept = number(raw.requests_kept) ?? (Array.isArray(raw.requests) ? requests.length : null);
  const since = (value: unknown) => { const n = number(value); if (n === null) return '–'; const secs = Math.max(0, Date.now() / 1000 - n); return secs < 60 ? t('刚刚', 'just now') : secs < 3600 ? `${fmt(secs / 60)} ${t('分钟前', 'min ago')}` : `${fmt(secs / 3600, 1)} ${t('小时前', 'h ago')}`; };
  const cacheMemoryMiB = number(cache.budget_mib), cacheMemory = cacheMemoryMiB === null ? null : cacheMemoryMiB * 1048576;
  const cacheShare = ratio(cache.reused_tokens, cache.prompt_tokens);
  const cacheEvent = typeof cache.last_event === 'string' ? `${cache.last_event === 'parked' ? t('停放', 'Parked') : t('恢复', 'Restored')} ${fmt(cache.last_tokens)} tokens, ${since(cache.last_at)}` : null;
  const cacheFacts: [string, ReactNode | null][] = [
    [t('最近请求', 'Last request'), number(cache.last_prompt) === null ? null : `${fmt(cache.last_reused)} ${t('复用 / 提示词', 'of')} ${fmt(cache.last_prompt)} ${t('提示词 tokens 已复用', 'prompt tokens reused')}`],
    [t('启动以来复用', 'Reused since start'), number(cache.requests) !== null && Number(cache.requests) > 0 ? `${fmt(cache.reused_tokens)} tokens${cacheShare !== null ? ` (${fmt(cacheShare)}% ${t('占全部提示词 tokens', 'of all prompt tokens')})` : ''}` : null],
    [t('停放 / 恢复', 'Parked / restored'), cache.enabled === true ? `${fmt(cache.parks)} / ${fmt(cache.restores)}${number(cache.evictions) !== null && Number(cache.evictions) > 0 ? ` · ${fmt(cache.evictions)} ${t('已淘汰', 'evicted')}` : ''}` : null],
    [t('最近切换', 'Last switch'), cache.enabled === true ? cacheEvent : null],
  ];
  let totalText = '';
  if (number(totals.requests) !== null && Number(totals.requests) > 0) {
    const sinceAt = number(totals.since), p = number(totals.prompt_tokens), reused = number(totals.reused), read = p !== null && reused !== null ? p - reused : null;
    const promptMs = number(totals.prompt_ms), decodeMs = number(totals.decode_ms), output = number(totals.output_tokens);
    const time = sinceAt === null ? '–' : new Date(sinceAt * 1000).toLocaleString(language, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    const pSpeed = promptMs !== null && promptMs > 0 && read !== null && read > 0 ? ` ${t('速度', 'at')} ${fmt(read / (promptMs / 1000))} tok/s` : '';
    const oSpeed = decodeMs !== null && decodeMs > 0 && output !== null && output > 0 ? ` ${t('速度', 'at')} ${fmt(output / (decodeMs / 1000), 1)} tok/s` : '';
    totalText = `${t('自', 'Since')} ${time}: ${fmt(totals.requests)} ${t('个请求', 'requests')} · ${fmt(read)} ${t('提示词 tokens 已读取', 'prompt tokens read')}${pSpeed} (${fmt(reused)} ${t('已复用', 'reused')}) · ${fmt(output)} ${t('已输出', 'written')}${oSpeed}`;
  }
  const finishStates: Record<string, [string, string]> = { stop: ['', t('完成', 'Done')], length: ['', t('达到 tokens 上限', 'Max tokens')], cancel: ['st-badge--queued', t('已停止', 'Stopped')], disconnect: ['st-badge--queued', t('已断开', 'Closed')], error: ['st-badge--error', t('错误', 'Error')] };
  const mcpStates: Record<string, [string, string]> = { ready: ['st-badge--generating', t('已连接', 'Connected')], starting: ['st-badge--reading', t('启动中', 'Starting')], failed: ['st-badge--error', t('失败', 'Failed')], stopped: ['st-badge--queued', t('已停止', 'Stopped')], idle: ['', t('等待中', 'Waiting')] };
  const readyServers = servers.filter(server => server.status === 'ready' || server.status === 'stopped');

  return <section className="view view--monitor" id="view-monitor" role="tabpanel" aria-labelledby="workspace-page-title">
    <div className="monitor">
      <div className="st-card state-card">
        <p className={outdated ? "notice warning" : "subtle"} role="status">{sampledAt ? `${t("上次成功采样", "Last successful sample")}: ${new Date(sampledAt).toLocaleString(language)}` : t("尚无成功采样时间", "No successful sample time available")}{outdated && ` · ${t("下方数值为上次采样，不能代表当前实时状态。", "Values below are from the last sample and do not represent the current live state.")}`}</p><div className="state-card__head"><span className="card-title">{t('模型状态', 'Model state')}</span><span className="badges" id="state-badges">{[
          ['idle', '', t('空闲', 'Idle')], ['reading', 'st-badge--reading', t('读取中', 'Reading')], ['generating', 'st-badge--generating', t('生成中', 'Generating')], ['queued', 'st-badge--queued', t('排队中', 'Queued')], ['error', 'st-badge--error', t('错误', 'Error')],
        ].map(([badgeState, cls, title]) => <span key={badgeState} className={`st-badge ${cls} ${badgeState === activeBadge || badgeState === state ? 'on' : ''}`} data-s={badgeState}>{title}</span>)}</span></div>
        <div className="state-card__row"><span id="state-label">{stateLabel}</span><span className="muted" id="state-detail">{stateDetail}</span></div>
        {progress('state-bar', statePercent, 'state-progress', state === 'reading' ? 'info' : undefined)}
      </div>

      <SlotMonitor raw={raw} language={language}/>
      <div className="metrics" id="metrics">{metricDefinitions.map(definition => {
        const max = 'max' in definition ? definition.max : definition.key === 'vram' ? number(hw.gpu_mem_total) : definition.key === 'power' ? number(hw.gpu_power_limit) : undefined;
        return <div className="st-card metric-card" key={definition.key}><div className="st-metric"><span className="st-metric__label"><svg className="st-icon st-icon--sm" aria-hidden="true"><use href={`${sprite}#i-${definition.icon}`} /></svg>{t(definition.cn, definition.en)}</span>
          {definition.key === 'speed' ? <div className="speed-values"><div>{metricValue('speed')}</div><div className="speed-prefill">{metricValue('prefill')}</div></div> : metricValue(definition.key)}
          <svg className="st-metric__spark" id={`sp-${definition.key}`} viewBox="0 0 100 32" preserveAspectRatio="none" data-tone={'tone' in definition ? definition.tone : undefined}><SparkPaths values={history[definition.series]} max={max} />{definition.key === 'speed' && <g id="sp-prefill" className="speed-prefill"><SparkPaths values={history.prefill_tok_s_mean} /></g>}</svg>
        </div></div>;
      })}</div>

      <div className="monitor-row">
        <div className="st-card ctx-card"><span className="card-title">{t('上下文占用', 'Context fill')}</span>
          <div className="ctx-gauge"><svg className="st-gauge" viewBox="0 0 120 120" aria-hidden="true"><circle className="st-gauge__track" cx="60" cy="60" r="50" fill="none" strokeWidth="10" strokeLinecap="round" strokeDasharray="235.6 314.2" transform="rotate(135 60 60)" /><circle className="st-gauge__fill" id="ctx-fill" cx="60" cy="60" r="50" fill="none" strokeWidth="10" strokeLinecap="round" strokeDasharray={`${contextArc.toFixed(1)} 314.2`} transform="rotate(135 60 60)" style={{ opacity: contextArc >= 3 ? 1 : 0 }} /></svg><div className="ctx-gauge__label"><span className="ctx-gauge__pct" id="ctx-pct">{contextPercent === null ? '–' : `${Math.round(contextPercent)}%`}</span><span className="muted" id="ctx-sub">{number(eng.max_context) !== null && Number(eng.max_context) > 0 ? `${kfmt(used)} / ${ctxfmt(eng.max_context)}` : '–'}</span></div></div>
          <div className="bar-row"><span>{t('显存中的专家', 'Experts in VRAM')}</span><span className="muted" id="slots-text">{number(eng.expert_slots) === null ? '–' : `${fmt(eng.expert_slots)} · ${gb(expertBytes)} GB`}</span></div>{progress('slots-bar', ratio(expertBytes, hw.gpu_mem_total))}
          <div className="bar-row"><span>{t('系统内存', 'System RAM')}</span><span className="muted" id="ram-text">{number(hw.ram_total) === null ? '–' : `${gb(hw.ram_used)} / ${gb(hw.ram_total, 0)} GB`}</span></div>{progress('ram-bar', ramPercent, 'ram-progress', ramPercent !== null && ramPercent > 92 ? 'danger' : undefined)}
          <div className="bar-row"><span>{t('GPU 温度', 'GPU temperature')}</span><span className="muted" id="temp-text">{number(hw.gpu_temp) === null ? '–' : `${fmt(hw.gpu_temp)} °C`}</span></div>{progress('temp-bar', tempPercent, undefined, 'warn')}
        </div>
        <div className="st-card req-card"><div className="req-head"><span className="card-title">{t('近期请求', 'Recent requests')}</span><button className="st-btn st-btn--secondary" id="req-all" hidden={kept === null || kept <= 12} onClick={onShowAll}>{showAll ? t('收起', 'Show fewer') : `${t('显示全部', 'Show all')} (${fmt(kept)})`}</button></div>
          <div className={`table-wrap${showAll ? ' all' : ''}`} id="req-wrap"><table className="st-table"><thead><tr><th>{t('时间', 'Time')}</th><th>{t('状态', 'Status')}</th><th className="num">{t('提示词', 'Prompt')}</th><th className="num">{t('复用', 'Reused')}</th><th className="num">{t('输出', 'Output')}</th><th className="num" data-tooltip={t('每秒处理的新输入词元，不含已复用内容；按引擎处理输入的耗时计算。', 'New input tokens processed per second, excluding reused content; measured with engine input processing time.')}>{t('输入处理 t/s', 'Input t/s')}</th><th className="num">{t('生成 t/s', 'Generation t/s')}</th><th className="num" data-tooltip={t('生成回答时，查找的专家中已在显存内的份额。GPU 经 PCIe 读取的专家不计入此值；它们占全部路由专家的份额另列为 +N% PCIe。', 'While writing the answer: the share of the experts looked up that were already in VRAM. Experts the GPU read over PCIe (--pcie-frac) are not counted in it; their share of all routed experts is shown after it (+N% PCIe)')}>{t('显存命中率', 'VRAM hit rate')}</th><th className="num">{t('耗时', 'Duration')}</th></tr></thead><tbody id="req-body">{requests.length === 0 ? <tr><td colSpan={9} className="muted">{Array.isArray(raw.requests) ? t('尚无请求', 'No requests yet') : '–'}</td></tr> : requests.slice(0, showAll ? requests.length : 12).map((request, index) => {
            const finish = typeof request.finish === 'string' ? request.finish : '', [cls, title] = finishStates[finish] ?? ['', finish || '–'];
            const time = number(request.time), hit = number(request.hit_rate), pcie = number(request.pcie_share);
            return <tr key={`${time}-${index}`} onDoubleClick={onRequest ? () => onRequest(request) : undefined}><td>{time === null ? '–' : new Date(time * 1000).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td><td><span className={`st-badge ${cls}`}>{title}</span>{typeof request.projection === 'boolean' && <> <span className={`st-badge${request.projection ? ' st-badge--reading' : ''}`} data-tooltip={`${t('实验速度投影', 'experimental speed projection')} ${request.projection ? t('开启', 'on') : t('关闭', 'off')}`}>{request.projection ? 'ESP' : 'stock'}</span></>}</td><td className="num">{fmt(request.prompt_tokens)}</td><td className="num">{fmt(request.reused)}</td><td className="num">{fmt(request.output_tokens)}</td><td className="num">{fmt(requestPrefillTokS(request))}</td><td className="num">{fmt(request.decode_tok_s, 1)}</td><td className="num">{hit === null ? '–' : `${(hit * 100).toFixed(1)}%`}{pcie !== null && pcie > 0 && <> <span className="muted" data-tooltip={t('GPU 经 PCIe 读取或由其它 GPU 计算的路由专家', 'routed experts the GPU read over PCIe (--pcie-frac) or another GPU computed')}>+{(pcie * 100).toFixed(1)}% PCIe</span></>}</td><td className="num">{number(request.duration_s) === null ? '–' : `${fmt(request.duration_s, 1)} s`}</td></tr>;
          })}</tbody></table></div><p className="muted req-totals" id="req-totals">{totalText}</p>
        </div>
      </div>

      <div className="st-card cc-card" id="cc-card" hidden={Object.keys(cache).length === 0}><div className="req-head"><span className="card-title">{t('会话缓存', 'Conversation cache')}</span><span className="muted small" id="cc-sum">{number(cache.requests) !== null && Number(cache.requests) > 0 ? `${fmt(cache.requests_reused)} ${t('个请求 /', 'of')} ${fmt(cache.requests)} ${t('个请求复用了部分提示词', 'requests reused part of their prompt')}` : ''}</span></div>
        <div className="cc-bars" id="cc-bars" hidden={cache.enabled !== true}><div><div className="bar-row"><span>{t('停放会话', 'Parked conversations')}</span><span className="muted" id="cc-slots-text">{fmt(cache.parked)} / {fmt(cache.slots)}</span></div>{progress('cc-slots-bar', ratio(cache.parked, cache.slots))}</div><div><div className="bar-row"><span>{t('会话内存（RAM）', 'Their memory (RAM)')}</span><span className="muted" id="cc-mem-text">{gb(cache.bytes)} / {gb(cacheMemory)} GB</span></div>{progress('cc-mem-bar', ratio(cache.bytes, cacheMemory))}</div></div>
        <dl className="facts" id="cc-facts">{cacheFacts.filter(([, value]) => value !== null).map(([title, value]) => <Fragment key={title}><dt>{title}</dt><dd>{value}</dd></Fragment>)}</dl>
        <p className="muted small cc-note" id="cc-note">{cache.enabled === true ? t('继续停放会话的请求会恢复其状态，不再重新读取；槽位或内存满时移除最早的会话。', 'A request that continues a parked conversation gets its state back instead of reading it again; the oldest goes when the slots or the memory are full.') : cache.enabled === false ? t('引擎保留最近会话的状态，后续请求只读取新增内容。要保留多个会话（Agent 交替使用），请在运行配置的 args 中加入 "--conversation-cache-mib", "8192"（docs/DETAILS.md）。', 'The engine keeps the last conversation\'s state, so a follow-up reads only what is new. To keep several conversations (agents taking turns), add "--conversation-cache-mib", "8192" to the run config\'s args (docs/DETAILS.md).') : '–'}</p>
      </div>

      <div className="st-card mcp-card" id="mcp-card" hidden={servers.length === 0}><div className="req-head"><span className="card-title">{t('MCP 服务', 'MCP servers')}</span><span className="muted small" id="mcp-sum">{fmt(mcp.tools)} {t('个工具', 'tools')} · {fmt(readyServers.length)} {t('/ ', 'of ')}{fmt(servers.length)} {t('个服务已连接', 'servers connected')}</span></div>
        <div className="mcp-list" id="mcp-list">{servers.map((server, index) => { const status = typeof server.status === 'string' ? server.status : '', [cls, title] = mcpStates[status] ?? ['', status || '–'], tools = objects(server.tools), info = asObject(server.info); return <div className="mcp-server" key={`${String(server.name)}-${index}`}><div className="mcp-server__head"><span className={`st-badge ${cls}`}>{title}</span><strong>{typeof server.name === 'string' ? server.name : '–'}</strong><span className="muted small">{typeof server.transport === 'string' ? server.transport : '–'} · {Array.isArray(server.tools) ? fmt(tools.length) : '–'} {t('个工具', 'tools')}{typeof info.name === 'string' ? ` · ${info.name}${typeof info.version === 'string' ? ` ${info.version}` : ''}` : ''}</span></div>{typeof server.error === 'string' && server.error && <div className="msg-error">{server.error}</div>}{tools.length > 0 && <div className="mcp-server__tools">{tools.map((tool, toolIndex) => <span className="chip" key={`${String(tool.tool)}-${toolIndex}`} data-tooltip={typeof tool.description === 'string' ? tool.description : ''}>{typeof tool.tool === 'string' ? tool.tool : '–'}</span>)}</div>}</div>; })}</div>
        <p className="muted small mcp-note">{t('模型决定调用时，这些工具以你的权限在本机运行（仅本页聊天；可在采样设置中关闭）。', 'Their tools run on this PC with your rights, when the model decides to call them (in this page\'s chat only; switch it off in Sampling).')}</p>
      </div>
    </div>
  </section>;
}

export { MonitoringPage as OfficialMonitoring };
