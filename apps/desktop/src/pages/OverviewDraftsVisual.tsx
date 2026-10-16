/* DEV-only graphical Overview drafts d/e/f (?overviewDraft=d|e|f). */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState, type ReactNode } from 'react';
import { Cpu, MemoryStick, MonitorSmartphone, Server, Layers3 } from 'lucide-react';
import './overview-drafts-visual.css';

const n = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const o = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const GiB = 1024 ** 3;

/** Shifts a series one step per second so the mock reads as a live feed; real data updates on each poll. */
function useLive(series: (number | null)[] | undefined, fallback: (number | null)[]) {
  const base = series && series.length > 4 ? series : fallback;
  const [k, setK] = useState(0);
  useEffect(() => { const id = window.setInterval(() => setK(v => v + 1), 1000); return () => window.clearInterval(id); }, []);
  if (!base.length) return base;
  const s = k % base.length;
  return [...base.slice(s), ...base.slice(0, s)];
}

function Gauge({ value, max, label, unit, size = 120, stroke = 8, accent = false, digits = 0, children }: { value: number | null; max: number; label: string; unit?: string; size?: number; stroke?: number; accent?: boolean; digits?: number; children?: ReactNode }) {
  const r = size / 2 - stroke, c = 2 * Math.PI * r, sweep = 0.75, frac = value === null ? 0 : Math.min(1, Math.max(0, value / max));
  return <div className={`gv-gauge${accent ? ' is-accent' : ''}`} style={{ width: size }}>
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={`${label} ${value ?? '–'}${unit ?? ''}`}>
      <g transform={`rotate(135 ${size / 2} ${size / 2})`}>
        <circle cx={size / 2} cy={size / 2} r={r} className="gv-track" strokeWidth={stroke} strokeDasharray={`${c * sweep} ${c}`} />
        <circle cx={size / 2} cy={size / 2} r={r} className="gv-fill" strokeWidth={stroke} strokeDasharray={`${c * sweep * frac} ${c}`} />
        {Array.from({ length: 11 }, (_, i) => { const a = i / 10 * sweep * 2 * Math.PI; const r1 = r + stroke / 2 + 3, r2 = r1 + (i % 5 ? 3 : 6); return <line key={i} className="gv-tick" x1={size / 2 + r1 * Math.cos(a)} y1={size / 2 + r1 * Math.sin(a)} x2={size / 2 + r2 * Math.cos(a)} y2={size / 2 + r2 * Math.sin(a)} />; })}
      </g>
    </svg>
    <div className="gv-gauge-v"><strong>{value === null ? '–' : value.toLocaleString(undefined, { maximumFractionDigits: digits })}</strong>{unit && <small>{unit}</small>}</div>
    <span className="gv-gauge-l">{label}</span>{children}
  </div>;
}

function LineChart({ series, height = 140, max, label, unitLabel }: { series: { values: (number | null)[]; cls: string; max?: number }[]; height?: number; max?: number; label: string; unitLabel?: string }) {
  const w = 600;
  return <svg className="gv-chart" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ height }} role="img" aria-label={label}>
    {[0.25, 0.5, 0.75].map(g => <line key={g} x1="0" x2={w} y1={height * g} y2={height * g} className="gv-grid" vectorEffect="non-scaling-stroke" />)}
    {series.map(({ values, cls, max: m }) => {
      const pts = values.map((v, i) => [i, v] as const).filter((q): q is readonly [number, number] => q[1] !== null);
      if (pts.length < 2) return null;
      const top = m ?? max ?? Math.max(...pts.map(q => q[1])) * 1.2, nn = values.length - 1 || 1;
      const xy = pts.map(([i, v]) => `${(i / nn * w).toFixed(1)} ${(height - 4 - v / top * (height - 10)).toFixed(1)}`);
      const d = 'M' + xy.join(' L');
      return <g key={cls} className={cls}><path d={`${d} L${w} ${height} L0 ${height} Z`} className="gv-area" /><path d={d} className="gv-line" vectorEffect="non-scaling-stroke" /></g>;
    })}
    {unitLabel && <text x="6" y="14" className="gv-axis">{unitLabel}</text>}
  </svg>;
}

export function VisualDraft({ variant, x }: { variant: 'd' | 'e' | 'f'; x: any }) {
  const { L, f, t, metric } = x;
  const raw = o(metric?.raw), place = o(raw.placement);
  const hist = metric?.history ?? {};
  const fallbackDecode = [...x.recent].map((r: any) => n(r.decode_tok_s));
  const decode = useLive(hist.decode, fallbackDecode);
  const gpuSeries = useLive(hist.gpu, []);
  const vramU = n(metric?.gpuMemoryUsed), vramT = n(metric?.gpuMemoryTotal), ramU = n(metric?.ramUsed), ramT = n(metric?.ramTotal);
  const header = (cls: string) => <header className={`gv-head ${cls}`}>
    <div className="gv-id">{x.dot}<div><h2>{x.profile.name}</h2><p><span>{x.statusText}</span><span>·</span><code>{x.model}</code><em>{x.modelState}</em></p></div></div>
    <div className="gv-endpoint">{x.copyBtn && <code>{x.endpoint}</code>}{x.copyBtn}</div>
    <div className="gv-ctrl">{x.controls}</div>
    <span className="gv-grow" />
    {x.chatBtn}
    <div className="gv-tools" role="group" aria-label={t('quickActions')}>{x.secondary.map((s: any) => <button type="button" key={s.label} onClick={s.on} data-tooltip={s.label}>{s.icon}<span>{s.label}</span></button>)}{x.refresh}</div>
  </header>;
  const sideInfo = <>
    <section><div className="gv-sub"><h3>{L('今日 API 使用', "Today's API usage")}</h3><button type="button" className="ovd-link" onClick={x.usageOpen}>{L('统计详情', 'Usage details')}</button></div>{x.kv(x.usageItems, 'gv-kv')}</section>
    <section><div className="gv-sub"><h3>{t('service')}</h3></div>{x.factList}</section>
    <section><div className="gv-sub"><h3>{t('runningTasks')}</h3>{x.link('tasks', t('viewAllTasks'))}</div>{x.taskList}</section>
  </>;

  /* ---------------- D · 硬件拓扑 / 显存分配图 ---------------- */
  if (variant === 'd') {
    const total = n(place.layers_total), onGpu = n(place.layers_gpu), onCpu = n(place.layers_cpu);
    const wG = n(place.weights_gpu), kv = n(place.kv_cache_gpu), wC = n(place.weights_cpu);
    const seg = (v: number | null, tot: number | null) => v !== null && tot ? `${Math.max(0, v / tot * 100)}%` : '0%';
    const otherGpu = vramU !== null && wG !== null && kv !== null ? Math.max(0, vramU - wG - kv) : null;
    const otherRam = ramU !== null && wC !== null ? Math.max(0, ramU - wC) : null;
    const g = (v: number | null) => v === null ? '–' : (v / GiB).toLocaleString(x.zh ? 'zh-CN' : 'en', { maximumFractionDigits: 1 });
    const layers = total ? Array.from({ length: total }, (_, i) => i < (onGpu ?? 0) ? 'g' : 'c') : [];
    const device = (kind: 'gpu' | 'ram', title: string, icon: ReactNode, used: number | null, tot: number | null, parts: [string, number | null, string][], meta: ReactNode, layerCount: number | null) =>
      <div className={`gv-dev gv-dev-${kind}`} style={{ flexGrow: kind === 'gpu' ? 1.25 : 1 }}>
        <div className="gv-dev-top">{icon}<strong>{title}</strong><span className="ovd-num">{g(used)} / {g(tot)} GB</span></div>
        <div className="gv-mem" role="img" aria-label={`${title} ${g(used)} / ${g(tot)} GB`}>{parts.map(([k, v, cls]) => <i key={k} className={cls} style={{ width: seg(v, tot) }} />)}</div>
        <ul className="gv-legend">{parts.map(([k, v, cls]) => <li key={k}><i className={cls} />{k}<b className="ovd-num">{g(v)}</b></li>)}<li><i className="free" />{L('空闲', 'Free')}<b className="ovd-num">{g(used !== null && tot !== null ? tot - used : null)}</b></li></ul>
        {layerCount !== null && <div className="gv-dev-layers"><span>{L('承载层', 'Layers')}</span><b className="ovd-num">{layerCount}</b><small>/ {total}</small></div>}
        <div className="gv-dev-meta">{meta}</div>
      </div>;
    return <div className="ovd gv gv-d">
      {header('')}
      {x.notices}
      <section className="gv-d-hero" aria-label={L('模型在硬件上的分布', 'Model placement across hardware')}>
        <div className="gv-d-title"><h3>{L('模型分布', 'Model placement')}</h3><span className="ovd-quiet">{L(`${x.model} · ${total ?? '–'} 层，${onGpu ?? '–'} 层在显卡，${onCpu ?? '–'} 层在内存`, `${x.model} · ${total ?? '–'} layers: ${onGpu ?? '–'} on GPU, ${onCpu ?? '–'} in RAM`)}</span>{x.link('monitoring', t('openMonitor'))}</div>
        <div className="gv-strip" role="img" aria-label={L('层分布', 'Layer split')}>{layers.map((k, i) => <i key={i} className={k} />)}</div>
        <div className="gv-strip-axis"><span>L0</span><span>{L('显卡', 'GPU')} ← → {L('内存', 'RAM')}</span><span>L{(total ?? 1) - 1}</span></div>
        <div className="gv-devs">
          {device('gpu', L('显卡 · 显存', 'GPU · VRAM'), <MonitorSmartphone size={16} />, vramU, vramT, [[L('模型权重', 'Weights'), wG, 'w'], [L('KV 缓存', 'KV cache'), kv, 'kv'], [L('其他', 'Other'), otherGpu, 'ot']],
            <><span>{t('gpuUtil')} <b className="ovd-num">{f(metric?.gpuUtil)}%</b></span><span>{t('gpuTemperature')} <b className="ovd-num">{f(metric?.gpuTemperature, 0)}°C</b></span><span>{t('gpuPower')} <b className="ovd-num">{f(metric?.gpuPower, 0)} W</b></span></>, onGpu)}
          <div className="gv-link" aria-hidden="true"><span className="gv-link-line" /><small>PCIe</small></div>
          {device('ram', L('系统内存', 'System RAM'), <MemoryStick size={16} />, ramU, ramT, [[L('卸载层权重', 'Offloaded weights'), wC, 'wc'], [L('其他程序', 'Other apps'), otherRam, 'ot']],
            <><span>{t('cpuUtil')} <b className="ovd-num">{f(metric?.cpuUtil)}%</b></span><span>{t('contextUsage')} <b className="ovd-num">{f(x.ctxUsed, 0)} / {f(x.capacity, 0)}</b></span></>, onCpu)}
        </div>
      </section>
      <div className="gv-d-below">
        <section className="gv-d-live"><div className="gv-sub"><h3>{x.speedLabel}</h3><b className="ovd-num gv-big">{f(x.speed)}<small>tok/s</small></b><span className="gv-grow" />{x.kv(x.readouts.slice(1, 4), 'gv-kv-inline')}</div>
          <LineChart series={[{ values: decode, cls: 'gv-s-accent' }]} height={120} label={L('生成速度走势', 'Decode speed trend')} />
          <div className="gv-sub gv-mt"><h3>{t('requestsRecent')}</h3>{x.link('requests', t('requests'))}</div>{x.reqTable}</section>
        <aside className="gv-side">{sideInfo}</aside>
      </div>
      {x.dialog}
    </div>;
  }

  /* ---------------- E · 仪表簇 + 实时曲线 ---------------- */
  if (variant === 'e') {
    const decodeMax = Math.max(60, Math.ceil(Math.max(...decode.filter((v: any) => v !== null) as number[], x.speed ?? 0) / 20) * 20);
    return <div className="ovd gv gv-e">
      <aside className="gv-e-rail">
        <div className="gv-id">{x.dot}<div><h2>{x.profile.name}</h2><p><span>{x.statusText}</span></p></div></div>
        <p className="gv-e-model"><span>{t('model')}</span><code>{x.model}</code><em>{x.modelState}</em></p>
        <div className="gv-endpoint gv-endpoint-stack"><code>{x.endpoint}</code>{x.copyBtn}</div>
        <div className="gv-ctrl">{x.controls}</div>
        {x.chatBtn}
        <nav className="gv-e-nav">{x.secondary.map((s: any) => <button type="button" key={s.label} onClick={s.on}>{s.icon}<span>{s.label}</span></button>)}</nav>
        {x.factList}
        <div className="gv-e-foot">{x.refresh}</div>
      </aside>
      <main className="gv-e-main">
        {x.notices}
        <section className="gv-e-cluster" aria-label={L('实时仪表', 'Live gauges')}>
          <div className="gv-e-sat gv-e-sat-l"><Gauge value={n(metric?.gpuUtil)} max={100} label={t('gpuUtil')} unit="%" size={132} /><Gauge value={n(metric?.gpuTemperature)} max={100} label={t('gpuTemperature')} unit="°C" size={108} stroke={6} /></div>
          <Gauge value={n(x.speed)} max={decodeMax} label={x.speedLabel} unit="tok/s" size={268} stroke={14} accent digits={1}>
            <div className="gv-e-sub"><span>{t('activeRequests')} <b className="ovd-num">{f(metric?.running, 0)}</b></span><span>{t('queued')} <b className="ovd-num">{f(metric?.queued, 0)}</b></span></div>
          </Gauge>
          <div className="gv-e-sat gv-e-sat-r"><Gauge value={n(metric?.gpuPower)} max={350} label={t('gpuPower')} unit="W" size={132} /><Gauge value={n(metric?.prefillTokS)} max={2000} label={t('prefill')} unit="tok/s" size={108} stroke={6} /></div>
        </section>
        <section className="gv-e-chart">
          <div className="gv-sub"><h3>{L('最近 60 秒', 'Last 60 seconds')}</h3><span className="gv-key"><i className="gv-s-accent" />{L('生成速度', 'Decode')}<i className="gv-s-muted" />{t('gpuUtil')}</span><span className="gv-grow" />{x.link('monitoring', t('openMonitor'))}</div>
          <LineChart series={[{ values: gpuSeries, cls: 'gv-s-muted', max: 100 }, { values: decode, cls: 'gv-s-accent', max: decodeMax }]} height={150} label={L('实时吞吐', 'Live throughput')} />
        </section>
        <section className="gv-e-res"><div className="gv-sub"><h3>{t('resourcesSummary')}</h3></div>{x.resourceRows}</section>
        <section className="gv-e-req"><div className="gv-sub"><h3>{t('requestsRecent')}</h3>{x.link('requests', t('requests'))}</div>{x.reqTable}</section>
      </main>
      <aside className="gv-side gv-e-side">{sideInfo}</aside>
      {x.dialog}
    </div>;
  }

  /* ---------------- F · 数据流水线 ---------------- */
  const running = n(metric?.running) ?? 0, queued = n(metric?.queued) ?? 0;
  const busy = metric?.state === 'generating' || metric?.state === 'reading';
  const u = x.usage?.http;
  const now = Date.now() / 1000;
  const reqs = [...x.recent].map((r: any) => { const end = n(r.time) ?? now, dur = (n(r.prompt_ms) ?? 0) / 1000 + (n(r.output_tokens) ?? 0) / Math.max(1, n(r.decode_tok_s) ?? 40); return { r, start: end - dur, end, dur }; });
  const t0 = Math.min(now - 600, ...reqs.map(q => q.start)), span = now - t0;
  const node = (key: string, icon: ReactNode, title: string, body: ReactNode, extra?: ReactNode, state = '') => <div className={`gv-node gv-node-${key} ${state}`}><div className="gv-node-h">{icon}<strong>{title}</strong></div><div className="gv-node-b">{body}</div>{extra && <div className="gv-node-x">{extra}</div>}</div>;
  const edge = (on: boolean, label?: string) => <div className={`gv-edge${on ? ' is-on' : ''}`} aria-hidden="true"><svg viewBox="0 0 100 10" preserveAspectRatio="none"><line x1="0" y1="5" x2="100" y2="5" /></svg>{label && <small>{label}</small>}</div>;
  return <div className="ovd gv gv-f">
    <header className="gv-f-head">
      <div className="gv-id">{x.dot}<div><h2>{x.profile.name}</h2><p><span>{x.statusText}</span><span>·</span><span>{x.stateText}</span></p></div></div>
      <span className="gv-grow" />{x.chatBtn}
      <div className="gv-tools">{x.secondary.slice(1).map((s: any) => <button type="button" key={s.label} onClick={s.on}>{s.icon}<span>{s.label}</span></button>)}{x.refresh}</div>
    </header>
    {x.notices}
    <section className="gv-flow" aria-label={L('请求链路', 'Request pipeline')}>
      {node('client', <MonitorSmartphone size={16} />, L('客户端', 'Clients'), <><b className="ovd-num gv-big">{f(u?.requests, 0)}</b><span>{L('今日请求', 'requests today')}</span><span>{L('成功率', 'Success')} <b className="ovd-num">{u?.successRate == null ? '–' : f(u.successRate * 100, 1)}%</b></span></>, <button type="button" className="ovd-link" onClick={x.usageOpen}>{L('统计详情', 'Usage details')}</button>)}
      {edge(x.online, 'HTTP')}
      {node('api', <Server size={16} />, 'API', <><code className="gv-f-ep">{x.endpoint}</code><span className="gv-f-ok">{x.statusText}</span></>, <>{x.copyBtn}{x.secondary[0] && <button type="button" className="ovd-link" onClick={x.secondary[0].on}>{x.secondary[0].label}</button>}</>)}
      {edge(x.online)}
      {node('queue', <Layers3 size={16} />, L('排队', 'Queue'), <><div className="gv-q">{Array.from({ length: 6 }, (_, i) => <i key={i} className={i < queued ? 'on' : ''} />)}</div><span><b className="ovd-num">{queued}</b> {L('个等待', 'waiting')}</span></>, undefined, queued ? 'is-warn' : '')}
      {edge(busy, `${running} ${L('运行中', 'running')}`)}
      {node('engine', <Cpu size={16} />, L('推理引擎', 'Engine'), <><b className="ovd-num gv-big gv-accent">{f(x.speed)}<small>tok/s</small></b><code>{x.model}</code><span>{x.modelState}</span></>, <div className="gv-ctrl">{x.controls}</div>, busy ? 'is-busy' : '')}
      {edge(busy)}
      <div className="gv-node gv-node-hw"><div className="gv-node-h"><MemoryStick size={16} /><strong>{L('硬件', 'Hardware')}</strong></div>
        {[[L('GPU 负载', 'GPU'), n(metric?.gpuUtil)], [L('显存', 'VRAM'), x.pct(vramU, vramT)], [L('内存', 'RAM'), x.pct(ramU, ramT)], ['CPU', n(metric?.cpuUtil)]].map(([k, v]: any) => <div key={k} className="gv-hw"><span>{k}</span><span className="gv-hw-bar"><i style={{ width: `${v ?? 0}%` }} /></span><b className="ovd-num">{v === null ? '–' : Math.round(v)}%</b></div>)}
        <div className="gv-node-x"><span>{f(metric?.gpuTemperature, 0)}°C · {f(metric?.gpuPower, 0)} W</span>{x.link('monitoring', t('openMonitor'))}</div>
      </div>
    </section>
    <div className="gv-f-below">
      <section className="gv-f-lanes">
        <div className="gv-sub"><h3>{L('请求时间线', 'Request timeline')}</h3><span className="ovd-quiet">{L('条长为耗时，深色段为输出', 'Length is duration; dark part is output')}</span><span className="gv-grow" />{x.link('requests', t('requests'))}</div>
        <div className="gv-lanes">{reqs.slice(-16).map(({ r, start, dur }: any, i: number) => { const pf = (n(r.prompt_ms) ?? 0) / 1000 / (dur || 1); return <div key={String(r.id ?? i)} className="gv-lane" data-tooltip={`${x.time(r.time)} · ${f(r.prompt_tokens, 0)} → ${f(r.output_tokens, 0)} · ${f(r.decode_tok_s)} tok/s · ${x.finish(r.finish)}`}>
          <time>{x.time(r.time)}</time><span className="gv-lane-track"><i className={`gv-lane-bar${r.finish === 'length' ? ' is-cut' : r.finish === 'cancelled' ? ' is-cancel' : ''}`} style={{ left: `${(start - t0) / span * 100}%`, width: `${Math.max(0.6, dur / span * 100)}%`, ['--pf' as any]: `${pf * 100}%` }} /></span><b className="ovd-num">{f(r.output_tokens, 0)}</b></div>; })}</div>
        <div className="gv-lane-axis"><span>{L(`${Math.round(span / 60)} 分钟前`, `${Math.round(span / 60)} min ago`)}</span><span>{L('现在', 'Now')}</span></div>
      </section>
      <aside className="gv-side">
        <section><div className="gv-sub"><h3>{t('resourcesSummary')}</h3></div>{x.resourceRows}</section>
        {sideInfo}
      </aside>
    </div>
    {x.dialog}
  </div>;
}
