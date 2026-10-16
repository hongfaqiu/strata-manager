/* DEV-only refined D (?overviewDraft=d2): hardware map driven only by fields /metrics already reports. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, type ReactNode } from 'react';
import { AlertTriangle, Boxes, Check, ChevronDown, Copy, Cpu, Download, MemoryStick, MessageSquare, MonitorSmartphone, Play, Plug, RefreshCw, RotateCcw, Settings2, Activity, Square, Upload } from 'lucide-react';
import './overview-draft-d2.css';

const n = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const o = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const GiB = 1024 ** 3;
type Tone = 'ok' | 'warn' | 'bad' | 'idle';
const tone = (p: number | null, warn: number, bad: number): Tone => p === null ? 'idle' : p >= bad ? 'bad' : p >= warn ? 'warn' : 'ok';

/** Smooth (Catmull-Rom → Bézier) area sparkline. */
function Spark({ values, height = 64, label }: { values: (number | null)[]; height?: number; label: string }) {
  const pts = values.map((v, i) => [i, v] as const).filter((q): q is readonly [number, number] => q[1] !== null);
  if (pts.length < 2) return <div className="d2-spark is-empty" style={{ height }} />;
  const w = 320, nn = Math.max(1, values.length - 1), hi = Math.max(...pts.map(q => q[1])), lo = Math.min(...pts.map(q => q[1]));
  const pad = (hi - lo) * 0.35 || 1, top = hi + pad, bot = Math.max(0, lo - pad);
  const xy = pts.map(([i, v]) => [i / nn * w, 4 + (1 - (v - bot) / (top - bot)) * (height - 8)] as [number, number]);
  let d = `M${xy[0]![0]} ${xy[0]![1]}`;
  for (let i = 0; i < xy.length - 1; i++) { const p0 = xy[i - 1] ?? xy[i]!, p1 = xy[i]!, p2 = xy[i + 1]!, p3 = xy[i + 2] ?? p2;
    d += ` C${p1[0] + (p2[0] - p0[0]) / 6} ${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6} ${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]} ${p2[1]}`; }
  const z = xy[xy.length - 1]!;
  return <svg className="d2-spark" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ height }} role="img" aria-label={label}>
    <defs><linearGradient id="d2-fade" x1="0" x2="0" y1="0" y2="1"><stop offset="0" className="d2-fade-a" /><stop offset="1" className="d2-fade-b" /></linearGradient></defs>
    <path d={`${d} L${w} ${height} L0 ${height} Z`} fill="url(#d2-fade)" /><path d={d} className="d2-spark-l" vectorEffect="non-scaling-stroke" />
    <circle cx={z[0]} cy={z[1]} r="3" className="d2-spark-d" />
  </svg>;
}
/** Small 240° arc gauge with a threshold tick. */
function Arc({ value, max, label, text, warn, bad, size = 64 }: { value: number | null; max: number; label: string; text: ReactNode; warn: number; bad: number; size?: number }) {
  const p = value === null ? null : Math.min(1, Math.max(0, value / max)), r = size / 2 - 5, c = 2 * Math.PI * r, sw = 2 / 3;
  const th = (warn / 100) * sw * 2 * Math.PI + Math.PI * 5 / 6, tx = (rr: number) => [size / 2 + rr * Math.cos(th), size / 2 + rr * Math.sin(th)];
  const [a1, b1] = tx(r - 5), [a2, b2] = tx(r + 4);
  return <div className={`d2-arc t-${tone(p === null ? null : p * 100, warn, bad)}`} role="meter" aria-label={label} aria-valuenow={p === null ? undefined : Math.round(p * 100)}>
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}><g transform={`rotate(150 ${size / 2} ${size / 2})`}>
      <circle cx={size / 2} cy={size / 2} r={r} className="d2-arc-t" strokeDasharray={`${c * sw} ${c}`} />
      <circle cx={size / 2} cy={size / 2} r={r} className="d2-arc-f" strokeDasharray={`${c * sw * (p ?? 0)} ${c}`} /></g>
      <line x1={a1} y1={b1} x2={a2} y2={b2} className="d2-arc-w" /></svg>
    <b className="ovd-num">{text}</b><span>{label}</span>
  </div>;
}

export function DraftD2({ p, x }: { p: any; x: any }) {
  const { L, f, t, metric, proc, health } = x;
  const ops = p.draftOps ?? { profiles: [], onSelect: () => {} };
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const raw = o(metric?.raw), hw = o(raw.hardware), st = o(raw.hardware_static), eng = o(raw.engine), cc = o(raw.conversation_cache);
  const stopped = !x.online && !x.connecting;
  const generating = metric?.state === 'generating' || metric?.state === 'reading';
  const loaded = x.online && health.loaded === true;
  const g = (v: number | null, d = 1) => v === null ? '–' : (v / GiB).toLocaleString(p.language, { maximumFractionDigits: d });
  const vU = n(metric?.gpuMemoryUsed), vT = n(metric?.gpuMemoryTotal), rU = n(metric?.ramUsed), rT = n(metric?.ramTotal);
  const vP = vU !== null && vT ? vU / vT * 100 : null, rP = rU !== null && rT ? rU / rT * 100 : null;
  const experts = n(eng.expert_cache_mib) === null ? null : n(eng.expert_cache_mib)! * 1048576;
  const parked = cc.enabled === true ? n(cc.bytes) : null;
  const vOther = vU !== null ? Math.max(0, vU - (experts ?? 0)) : null, rOther = rU !== null ? Math.max(0, rU - (parked ?? 0)) : null;
  const pct = (v: number | null, tot: number | null) => v !== null && tot ? `${Math.max(0, Math.min(100, v / tot * 100))}%` : '0%';
  const gpus = Array.isArray(hw.gpus) ? hw.gpus.length : 0;
  const powerLimit = n(hw.gpu_power_limit);
  const ctxP = x.ctxUsed !== null && x.capacity ? x.ctxUsed / x.capacity * 100 : null;
  const reqs = [...x.recent].reverse();
  const speeds = [...x.recent].map((r: any) => n(r.decode_tok_s));
  const http = x.usage?.http, total = n(http?.requests) ?? 0, failed = (n(http?.failed) ?? 0) + (n(http?.interrupted) ?? 0), rate = n(http?.successRate);
  const queued = n(metric?.queued) ?? 0, running = n(metric?.running) ?? 0;
  const truncated = x.recent.filter((r: any) => r.finish === 'length').length;
  const copy = () => { p.onCopy(x.endpoint); setCopied(true); window.setTimeout(() => setCopied(false), 1400); };
  const b = (k: string, icon: ReactNode, label: string, on?: () => void, cls = '') => on ? <button key={k} type="button" className={`d2-btn ${cls}`} disabled={ops.disabled} onClick={on}>{icon}<span>{label}</span></button> : null;
  const start = b('start', <Play size={14} />, L('启动服务', 'Start service'), ops.onStart, 'primary');

  // attention: most severe first
  const issues: { tone: Tone; text: string; action?: ReactNode }[] = [];
  if (stopped) issues.push({ tone: 'bad', text: proc?.running === false ? L('服务未运行，聊天和 API 暂不可用', 'Service is not running — chat and API are unavailable') : L('无法连接到服务', 'Cannot reach the service'), action: <>{start}<button type="button" className="ovd-link" onClick={() => p.onNavigate('tasks')}>{L('查看日志', 'View logs')}</button></> });
  if (x.online && health.loaded === false) issues.push({ tone: 'warn', text: L('API 在线，但模型未加载', 'API is up, but no model is loaded'), action: b('load', <Upload size={14} />, t('load'), ops.onLoad, 'primary') });
  if (vP !== null && vP >= 85) issues.push({ tone: vP >= 95 ? 'bad' : 'warn', text: L(`显存已用 ${Math.round(vP)}%，长上下文可能失败`, `VRAM at ${Math.round(vP)}% — long contexts may fail`), action: b('unload', <Download size={14} />, L('释放内存', 'Release memory'), ops.onUnload) });
  if (n(metric?.gpuTemperature) !== null && metric.gpuTemperature >= 83) issues.push({ tone: 'warn', text: L(`GPU 温度 ${f(metric.gpuTemperature, 0)}°C`, `GPU at ${f(metric.gpuTemperature, 0)}°C`) });
  if (queued > 0) issues.push({ tone: 'warn', text: L(`${queued} 个请求在排队，正在处理 ${running} 个`, `${queued} queued, ${running} running`), action: x.link('monitoring', t('openMonitor')) });
  if (failed > 0) issues.push({ tone: 'warn', text: L(`今日 ${failed} 次请求失败`, `${failed} failed request(s) today`), action: <button type="button" className="ovd-link" onClick={x.usageOpen}>{L('查看', 'View')}</button> });
  if (truncated) issues.push({ tone: 'idle', text: L(`最近 ${truncated} 次回答被长度截断`, `${truncated} recent answer(s) hit the length limit`), action: <button type="button" className="ovd-link" onClick={() => p.onNavigate('config')}>{L('调整', 'Adjust')}</button> });
  const [first, ...rest] = issues;
  const [showAll, setShowAll] = useState(false);

  const stateTone: Tone = stopped ? 'bad' : x.connecting || !loaded ? 'warn' : 'ok';
  const stateWord = stopped ? (proc?.running === false ? L('已停止', 'Stopped') : L('无法连接', 'Unreachable')) : x.connecting ? L('启动中', 'Starting') : x.stateText;
  const legend = (items: [string, number | null, string][], free: number | null) => <ul className="d2-legend">{items.filter(i => i[1] !== null).map(([k, v, c]) => <li key={k}><i className={c} />{k}<b className="ovd-num">{g(v)}</b></li>)}<li><i className="free" />{L('可用', 'Free')}<b className="ovd-num">{g(free)}</b></li></ul>;

  return <div className="ovd d2">
    <header className="d2-top">
      <div className="d2-id">
        <span className={`d2-state t-${stateTone}`}><i />{stateWord}</span>
        <h2 title={x.model}>{x.model !== '–' ? x.model : x.profile.name}</h2>
        <span className="d2-sub">{x.profile.name}{proc?.pid ? ` · PID ${proc.pid}` : ''}</span>
      </div>
      <div className="d2-ep"><code>{x.endpoint}</code><button type="button" className="d2-btn d2-btn-ghost" onClick={copy}>{copied ? <Check size={14} /> : <Copy size={14} />}<span>{copied ? L('已复制', 'Copied') : L('复制 API', 'Copy API')}</span></button></div>
      <div className="d2-actions">
        {stopped ? start : <button type="button" className="d2-btn primary" onClick={p.onChat} disabled={!loaded}><MessageSquare size={14} /><span>{t('openChat')}</span></button>}
        <div className="d2-switch"><button type="button" className="d2-btn" aria-expanded={menu} onClick={() => setMenu(v => !v)} disabled={ops.disabled || ops.profiles.length < 2}><Boxes size={14} /><span>{L('切换模型', 'Switch model')}</span><ChevronDown size={13} /></button>
          {menu && <ul className="d2-menu" role="listbox">{ops.profiles.map((m: any) => <li key={m.id}><button type="button" role="option" aria-selected={m.active} onClick={() => { ops.onSelect(m.id); setMenu(false); }}>{m.active ? <Check size={13} /> : <span className="d2-sp" />}{m.name}</button></li>)}<li className="d2-menu-foot"><button type="button" onClick={() => p.onNavigate('profiles')}>{L('管理模型…', 'Manage models…')}</button></li></ul>}</div>
        {b('restart', <RotateCcw size={14} />, L('重启', 'Restart'), ops.onRestart)}
        {b('unload', <Download size={14} />, L('释放内存', 'Release memory'), ops.onUnload)}
        {b('load', <Upload size={14} />, t('load'), ops.onLoad)}
        {b('stop', <Square size={12} />, t('stop'), ops.onStop, 'danger')}
      </div>
    </header>
    {first && <div className={`d2-attn t-${first.tone}`} role="status">
      <AlertTriangle size={15} /><span className="d2-attn-t">{first.text}</span>
      {rest.length > 0 && <button type="button" className="ovd-link" onClick={() => setShowAll(v => !v)}>{showAll ? L('收起', 'Less') : L(`另有 ${rest.length} 项`, `+${rest.length} more`)}</button>}
      <span className="d2-grow" /><div className="d2-attn-a">{first.action}</div>
    </div>}
    {showAll && rest.map((i, k) => <div key={k} className={`d2-attn d2-attn-more t-${i.tone}`}><span className="d2-attn-dot" /><span className="d2-attn-t">{i.text}</span><span className="d2-grow" /><div className="d2-attn-a">{i.action}</div></div>)}
    {x.notices}

    <section className={`d2-map${stopped ? ' is-off' : ''}`} aria-label={L('硬件占用', 'Hardware usage')}>
      <div className="d2-dev">
        <div className="d2-dev-h"><MonitorSmartphone size={15} /><strong>{typeof st.gpu_name === 'string' ? st.gpu_name : 'GPU'}</strong>{gpus > 1 && <em>×{gpus}</em>}<span className="d2-grow" /><span className="d2-dev-k">{L('显存', 'VRAM')}</span><b className={`ovd-num d2-dev-v t-${tone(vP, 85, 95)}`}>{g(vU)}<small> / {g(vT, 0)} GB</small></b></div>
        <div className={`d2-mem t-${tone(vP, 85, 95)}`} role="meter" aria-label={L('显存', 'VRAM')} aria-valuenow={vP === null ? undefined : Math.round(vP)}>
          {experts !== null && <i className="seg-a" style={{ width: pct(experts, vT) }} />}<i className="seg-b" style={{ width: pct(vOther, vT) }} /><s style={{ left: '85%' }} />
        </div>
        {legend([[L('显存中的专家', 'Experts in VRAM'), experts, 'seg-a'], [L('模型与运行时', 'Model & runtime'), vOther, 'seg-b']], vU !== null && vT !== null ? vT - vU : null)}
        <div className="d2-arcs">
          <Arc value={n(metric?.gpuUtil)} max={100} label={L('负载', 'Load')} text={<>{f(metric?.gpuUtil, 0)}<small>%</small></>} warn={90} bad={99} />
          <Arc value={n(metric?.gpuTemperature)} max={100} label={L('温度', 'Temp')} text={<>{f(metric?.gpuTemperature, 0)}<small>°C</small></>} warn={80} bad={88} />
          <Arc value={n(metric?.gpuPower)} max={powerLimit ?? 450} label={powerLimit ? L(`功率 / ${powerLimit} W`, `Power / ${powerLimit} W`) : L('功率', 'Power')} text={<>{f(metric?.gpuPower, 0)}<small>W</small></>} warn={90} bad={98} />
        </div>
      </div>
      <div className={`d2-bus${generating ? ' is-on' : ''}`} aria-hidden="true">
        <span className="d2-bus-line" />
        <b className="ovd-num">{n(hw.gpu_pcie_gen) !== null ? `PCIe ${hw.gpu_pcie_gen}.0` : 'PCIe'}{n(hw.gpu_pcie_width) !== null ? ` ×${hw.gpu_pcie_width}` : ''}</b>
        {n(hw.gpu_pcie_rx_mb) !== null && <small className="ovd-num">↓ {f(hw.gpu_pcie_rx_mb, 0)} MB/s</small>}
      </div>
      <div className="d2-dev">
        <div className="d2-dev-h"><MemoryStick size={15} /><strong>{L('系统内存', 'System memory')}</strong><span className="d2-grow" /><span className="d2-dev-k">RAM</span><b className={`ovd-num d2-dev-v t-${tone(rP, 85, 95)}`}>{g(rU)}<small> / {g(rT, 0)} GB</small></b></div>
        <div className={`d2-mem t-${tone(rP, 85, 95)}`} role="meter" aria-label="RAM" aria-valuenow={rP === null ? undefined : Math.round(rP)}>
          {parked !== null && <i className="seg-a" style={{ width: pct(parked, rT) }} />}<i className="seg-b" style={{ width: pct(rOther, rT) }} /><s style={{ left: '85%' }} />
        </div>
        {legend([[L('停放的会话', 'Parked conversations'), parked, 'seg-a'], [L('其余占用', 'Everything else'), rOther, 'seg-b']], rU !== null && rT !== null ? rT - rU : null)}
        <div className="d2-arcs">
          <Arc value={n(metric?.cpuUtil)} max={100} label="CPU" text={<>{f(metric?.cpuUtil, 0)}<small>%</small></>} warn={90} bad={98} />
          <Arc value={ctxP} max={100} label={L('上下文', 'Context')} text={<>{ctxP === null ? '–' : Math.round(ctxP)}<small>%</small></>} warn={80} bad={95} />
          <div className="d2-dev-facts">{n(st.cores) !== null && <span><b className="ovd-num">{st.cores}</b> {L('核', 'cores')} · <b className="ovd-num">{st.threads}</b> {L('线程', 'threads')}</span>}<span>{L('上下文', 'Context')} <b className="ovd-num">{f(x.ctxUsed, 0)}</b> / {f(x.capacity, 0)}</span></div>
        </div>
      </div>
      {stopped && <div className="d2-off"><Cpu size={18} /><div><strong>{L('服务未运行，暂无实时硬件数据', 'Service is not running — no live hardware data')}</strong><span>{L('启动后显示显存、内存和 GPU 负载。', 'VRAM, RAM and GPU load appear after start.')}</span></div></div>}
    </section>

    <div className="d2-low">
      <section className="d2-speed">
        <div className="d2-h"><h3>{generating ? L('生成速度', 'Decode speed') : L('最近生成速度', 'Last decode speed')}</h3><span className="d2-grow" />{x.link('monitoring', t('openMonitor'))}</div>
        <div className="d2-speed-n"><b className="ovd-num">{stopped ? '–' : f(x.speed)}</b><small>tok/s</small>{n(x.usage?.decodeTokS?.p50) !== null && <span>{L('今日中位', 'Today p50')} <b className="ovd-num">{f(x.usage.decodeTokS.p50, 1)}</b></span>}</div>
        {stopped ? <p className="d2-quiet">{t('noMetrics')}</p> : <Spark values={speeds} label={L('最近请求的生成速度', 'Decode speed of recent requests')} />}
        <dl className="d2-kv">
          <div><dt>{t('activeRequests')}</dt><dd className="ovd-num">{running}</dd></div>
          <div><dt>{t('queued')}</dt><dd className={`ovd-num${queued ? ' is-warn' : ''}`}>{queued}</dd></div>
          <div><dt>{t('prefill')}</dt><dd className="ovd-num">{f(metric?.prefillTokS, 0)}<small> tok/s</small></dd></div>
          <div><dt>{L('首字 p50', 'TTFT p50')}</dt><dd className="ovd-num">{n(x.usage?.ttftS?.p50) === null ? '–' : `${f(x.usage.ttftS.p50, 2)}`}<small> s</small></dd></div>
        </dl>
      </section>
      <section className="d2-reqs">
        <div className="d2-h"><h3>{t('requestsRecent')}</h3><span className="d2-grow" />{x.link('requests', t('requests'))}</div>
        {reqs.length ? <ol className="d2-list">{reqs.slice(0, 7).map((r: any, i: number) => <li key={String(r.id ?? i)}>
          <i className={`d2-fin f-${r.finish === 'length' ? 'warn' : r.finish === 'cancelled' ? 'idle' : 'ok'}`} title={x.finish(r.finish)} />
          <time className="ovd-num">{x.time(r.time)}</time>
          <span className="ovd-num d2-tok">{f(r.prompt_tokens, 0)} <em>→</em> {f(r.output_tokens, 0)}</span>
          <span className="ovd-num d2-spd">{f(r.decode_tok_s, 1)}<small> tok/s</small></span>
          <span className="d2-finx">{x.finish(r.finish)}</span></li>)}</ol>
          : <p className="d2-quiet">{t(!metric ? 'noMetrics' : 'overviewRequestsEmpty')}</p>}
      </section>
      <aside className="d2-side">
        <section>
          <div className="d2-h"><h3>{L('今日 API', "Today's API")}</h3><span className="d2-grow" /><button type="button" className="ovd-link" onClick={x.usageOpen}>{L('统计详情', 'Usage details')}</button></div>
          <div className="d2-today"><b className="ovd-num">{f(total, 0)}</b><span>{L('次请求', 'requests')}</span><span className="d2-grow" /><span className={`ovd-num d2-rate${failed ? ' is-warn' : ''}`}>{rate === null ? '–' : f(rate * 100, 1)}%</span><span className="d2-quiet">{L('成功', 'ok')}</span></div>
          <p className="d2-quiet d2-today-s">{L('输入', 'In')} <b className="ovd-num">{f(http?.inputTokens, 0)}</b> · {L('输出', 'Out')} <b className="ovd-num">{f(http?.outputTokens, 0)}</b> · {L('失败', 'Failed')} <b className="ovd-num">{failed}</b></p>
        </section>
        <section><div className="d2-h"><h3>{t('runningTasks')}</h3><span className="d2-grow" />{x.link('tasks', t('viewAllTasks'))}</div>{x.taskList}</section>
        <section>{x.factList}<div className="d2-more">
          <button type="button" className="ovd-link" onClick={x.openApi}><Plug size={13} />{L('接入向导', 'Integration')}</button>
          <button type="button" className="ovd-link" onClick={() => p.onNavigate('monitoring')}><Activity size={13} />{t('openMonitor')}</button>
          <button type="button" className="ovd-link" onClick={() => p.onNavigate('config')}><Settings2 size={13} />{L('运行配置', 'Configuration')}</button>
          <button type="button" className="ovd-icon" onClick={p.onRefresh} aria-label={t('refresh')} data-tooltip={t('refresh')}><RefreshCw size={13} /></button></div></section>
      </aside>
    </div>
    {x.dialog}
  </div>;
}
