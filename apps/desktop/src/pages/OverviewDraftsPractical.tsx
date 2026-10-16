/* DEV-only practical Overview drafts g/h/i (?overviewDraft=g|h|i). Only fields the app already receives. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, AlertTriangle, Boxes, Check, ChevronDown, Copy, Download, MessageSquare, Play, Plug, RefreshCw, RotateCcw, Settings2, Square, Upload } from 'lucide-react';
import './overview-drafts-practical.css';

const n = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const GiB = 1024 ** 3;
type Tone = 'ok' | 'warn' | 'bad' | 'idle';
const toneOf = (p: number | null, warn = 80, bad = 92): Tone => p === null ? 'idle' : p >= bad ? 'bad' : p >= warn ? 'warn' : 'ok';

/** Client-side ring buffer of polled values (real app: grows with each metrics poll). Dev mock seeds it from mock history. */
function useSamples(value: number | null, seed?: (number | null)[], size = 60) {
  const ref = useRef<(number | null)[]>(seed && seed.length ? seed.slice(-size) : []);
  const [, tick] = useState(0);
  useEffect(() => { if (value === null) return; ref.current = [...ref.current, value].slice(-size); tick(x => x + 1); }, [value]);
  return ref.current;
}

function Meter({ label, value, max, text, sub, warn = 80, bad = 92 }: { label: string; value: number | null; max: number; text: ReactNode; sub?: ReactNode; warn?: number; bad?: number }) {
  const p = value === null ? null : Math.min(100, Math.max(0, value / max * 100));
  return <div className={`pm-meter t-${toneOf(p, warn, bad)}`}>
    <div className="pm-meter-h"><span>{label}</span><b className="ovd-num">{text}</b></div>
    <div className="pm-meter-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={p ?? undefined}><i style={{ width: `${p ?? 0}%` }} /><s style={{ left: `${warn}%` }} /></div>
    {sub && <div className="pm-meter-s">{sub}</div>}
  </div>;
}
function Ring({ value, max, size = 150, label, center, warn = 80, bad = 92 }: { value: number | null; max: number; size?: number; label: string; center: ReactNode; warn?: number; bad?: number }) {
  const p = value === null ? null : Math.min(1, Math.max(0, value / max)), r = size / 2 - 9, c = 2 * Math.PI * r;
  return <div className={`pm-ring t-${toneOf(p === null ? null : p * 100, warn, bad)}`} style={{ width: size, height: size }} role="meter" aria-label={label} aria-valuenow={p === null ? undefined : Math.round(p * 100)}>
    <svg viewBox={`0 0 ${size} ${size}`}><circle cx={size / 2} cy={size / 2} r={r} className="pm-ring-t" /><circle cx={size / 2} cy={size / 2} r={r} className="pm-ring-f" strokeDasharray={`${c * (p ?? 0)} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <line className="pm-ring-w" x1={size / 2 + (r - 7) * Math.sin(warn / 100 * 2 * Math.PI)} y1={size / 2 - (r - 7) * Math.cos(warn / 100 * 2 * Math.PI)} x2={size / 2 + (r + 7) * Math.sin(warn / 100 * 2 * Math.PI)} y2={size / 2 - (r + 7) * Math.cos(warn / 100 * 2 * Math.PI)} /></svg>
    <div className="pm-ring-c">{center}</div>
  </div>;
}
function Bars({ values, height = 120, mid: refLine, label, cut }: { values: (number | null)[]; height?: number; mid?: number | null; label: string; cut?: boolean[] }) {
  const max = Math.max(1, ...values.map(v => v ?? 0), refLine ?? 0) * 1.15;
  return <div className="pm-bars" style={{ height }} role="img" aria-label={label}>
    {values.map((v, i) => <i key={i} className={cut?.[i] ? 'is-cut' : ''} style={{ height: `${(v ?? 0) / max * 100}%` }} />)}
    {refLine != null && <span className="pm-bars-ref" style={{ bottom: `${refLine / max * 100}%` }}><em>p50 {refLine.toFixed(0)}</em></span>}
  </div>;
}
function Line({ values, height = 44, max = 100, label }: { values: (number | null)[]; height?: number; max?: number; label: string }) {
  const pts = values.map((v, i) => [i, v] as const).filter((q): q is readonly [number, number] => q[1] !== null);
  if (pts.length < 2) return <div className="pm-line is-empty" style={{ height }} />;
  const w = 300, nn = Math.max(1, values.length - 1);
  const d = 'M' + pts.map(([i, v]) => `${(i / nn * w).toFixed(1)} ${(height - 2 - v / max * (height - 4)).toFixed(1)}`).join(' L');
  return <svg className="pm-line" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ height }} role="img" aria-label={label}><line x1="0" x2={w} y1={height - 2 - 0.8 * (height - 4)} y2={height - 2 - 0.8 * (height - 4)} className="pm-line-th" vectorEffect="non-scaling-stroke" /><path d={d} vectorEffect="non-scaling-stroke" /></svg>;
}

export function PracticalDraft({ variant, p, x }: { variant: 'g' | 'h' | 'i'; p: any; x: any }) {
  const { L, f, t, metric, proc, health } = x;
  const ops = p.draftOps ?? { profiles: [], onSelect: () => {} };
  const [switchOpen, setSwitchOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const stopped = !x.online && !x.connecting;
  const generating = metric?.state === 'generating' || metric?.state === 'reading';
  const loaded = x.online && health.loaded === true;
  const vU = n(metric?.gpuMemoryUsed), vT = n(metric?.gpuMemoryTotal), rU = n(metric?.ramUsed), rT = n(metric?.ramTotal);
  const vP = vU !== null && vT ? vU / vT * 100 : null, rP = rU !== null && rT ? rU / rT * 100 : null, cP = x.ctxUsed !== null && x.capacity ? x.ctxUsed / x.capacity * 100 : null;
  const g = (v: number | null) => v === null ? '–' : (v / GiB).toLocaleString(p.language, { maximumFractionDigits: 1 });
  const gpuS = useSamples(n(metric?.gpuUtil), metric?.history?.gpu);
  const reqs = [...x.recent];
  const speeds = reqs.map((r: any) => n(r.decode_tok_s));
  const cut = reqs.map((r: any) => r.finish === 'length');
  const http = x.usage?.http, p50 = n(x.usage?.decodeTokS?.p50), ttft = n(x.usage?.ttftS?.p50);
  const failed = (n(http?.failed) ?? 0) + (n(http?.interrupted) ?? 0), cancelled = n(http?.cancelled) ?? 0, ok = n(http?.succeeded) ?? 0, total = n(http?.requests) ?? 0;
  const queued = n(metric?.queued) ?? 0, runningReq = n(metric?.running) ?? 0;
  const stateTone: Tone = stopped ? 'bad' : x.connecting ? 'warn' : generating ? 'ok' : loaded ? 'ok' : 'warn';
  const stateWord = stopped ? (proc?.running === false ? L('已停止', 'Stopped') : L('无法连接', 'Unreachable')) : x.connecting ? L('启动中', 'Starting') : x.stateText;
  const copy = () => { p.onCopy(x.endpoint); setCopied(true); window.setTimeout(() => setCopied(false), 1400); };
  const btn = (key: string, icon: ReactNode, label: string, on?: () => void, cls = '') => on ? <button key={key} type="button" className={`pm-btn ${cls}`} disabled={ops.disabled} onClick={on}>{icon}<span>{label}</span></button> : null;
  const chat = <button type="button" className="primary pm-btn pm-primary" onClick={p.onChat} disabled={!loaded}><MessageSquare size={15} /><span>{t('openChat')}</span></button>;
  const startBtn = btn('start', <Play size={15} />, L('启动服务', 'Start service'), ops.onStart, 'primary pm-primary');
  const copyBtn = <button type="button" className="pm-btn" onClick={copy} disabled={x.endpoint === '–'}>{copied ? <Check size={14} /> : <Copy size={14} />}<span>{copied ? L('已复制', 'Copied') : L('复制 API', 'Copy API')}</span></button>;
  const svc = <>{btn('restart', <RotateCcw size={14} />, L('重启', 'Restart'), ops.onRestart)}{btn('unload', <Download size={14} />, L('释放内存', 'Release memory'), ops.onUnload)}{btn('load', <Upload size={14} />, t('load'), ops.onLoad)}{btn('stop', <Square size={13} />, t('stop'), ops.onStop, 'pm-danger')}</>;
  const switcher = <div className="pm-switch"><button type="button" className="pm-btn" aria-expanded={switchOpen} onClick={() => setSwitchOpen(v => !v)} disabled={ops.disabled || ops.profiles.length < 2}><Boxes size={14} /><span>{L('切换模型', 'Switch model')}</span><ChevronDown size={13} /></button>
    {switchOpen && <ul className="pm-menu" role="listbox">{ops.profiles.map((m: any) => <li key={m.id}><button type="button" role="option" aria-selected={m.active} onClick={() => { ops.onSelect(m.id); setSwitchOpen(false); }}>{m.active ? <Check size={13} /> : <span className="pm-sp" />}{m.name}</button></li>)}<li className="pm-menu-foot"><button type="button" onClick={() => p.onNavigate('profiles')}>{L('管理模型…', 'Manage models…')}</button></li></ul>}</div>;
  const more = <div className="pm-more">{[[<Plug size={14} key="i" />, L('接入向导', 'Integration guide'), x.openApi], [<Activity size={14} key="i" />, t('openMonitor'), () => p.onNavigate('monitoring')], [<Settings2 size={14} key="i" />, L('运行配置', 'Configuration'), () => p.onNavigate('config')]].map(([i, l, on]: any) => <button key={l} type="button" className="ovd-link" onClick={on}>{i}{l}</button>)}<button type="button" className="ovd-icon" onClick={p.onRefresh} aria-label={t('refresh')} data-tooltip={t('refresh')}><RefreshCw size={14} /></button></div>;
  const stateChip = <span className={`pm-state t-${stateTone}`}><i />{stateWord}</span>;
  const okBar = total ? <div className="pm-okbar" role="img" aria-label={L('今日请求结果', 'Today request outcomes')}><i className="ok" style={{ flex: ok }} /><i className="bad" style={{ flex: failed }} /><i className="mid" style={{ flex: cancelled }} /></div> : null;
  const usageBlock = <div className="pm-usage">
    <div className="pm-usage-h"><span>{L('今日 API', "Today's API")}</span><button type="button" className="ovd-link" onClick={x.usageOpen}>{L('统计详情', 'Usage details')}</button></div>
    <div className="pm-usage-n"><b className="ovd-num">{f(total, 0)}</b><span>{L('次请求', 'requests')}</span><span className="pm-usage-rate ovd-num">{http?.successRate == null ? '–' : f(http.successRate * 100, 1)}%</span></div>
    {okBar}
    <div className="pm-usage-l"><span><i className="ok" />{L('成功', 'OK')} {f(ok, 0)}</span><span><i className="bad" />{L('失败', 'Failed')} {f(failed, 0)}</span><span><i className="mid" />{L('取消', 'Cancelled')} {f(cancelled, 0)}</span></div>
    <div className="pm-usage-t"><span>{L('输入', 'In')} <b className="ovd-num">{f(http?.inputTokens, 0)}</b></span><span>{L('输出', 'Out')} <b className="ovd-num">{f(http?.outputTokens, 0)}</b></span><span>{L('首字 p50', 'TTFT p50')} <b className="ovd-num">{ttft === null ? '–' : `${f(ttft, 2)} s`}</b></span></div>
  </div>;
  const meters = <>
    <Meter label={t('gpuMemory')} value={vP} max={100} text={<>{g(vU)} <small>/ {g(vT)} GB</small></>} warn={85} bad={95} />
    <Meter label={t('ram')} value={rP} max={100} text={<>{g(rU)} <small>/ {g(rT)} GB</small></>} warn={85} bad={95} />
    <Meter label={t('gpuUtil')} value={n(metric?.gpuUtil)} max={100} text={<>{f(metric?.gpuUtil, 0)}<small>%</small></>} warn={90} bad={99} />
    <Meter label={t('gpuTemperature')} value={n(metric?.gpuTemperature)} max={100} text={<>{f(metric?.gpuTemperature, 0)}<small>°C</small></>} warn={80} bad={88} />
    <Meter label={t('contextUsage')} value={cP} max={100} text={<>{f(x.ctxUsed, 0)} <small>/ {f(x.capacity, 0)}</small></>} warn={80} bad={95} />
  </>;
  const stoppedPanel = (cls = '') => <div className={`pm-stopped ${cls}`}><AlertTriangle size={18} /><div><strong>{proc?.running === false ? L('服务未运行', 'Service is not running') : L('无法连接到服务', 'Cannot reach the service')}</strong><p>{L('启动后这里会显示实时速度、显存和请求。启动失败时，可在任务与日志里查看原因。', 'Live speed, memory and requests appear here after start. If start fails, check Tasks & logs.')}</p></div><div className="pm-stopped-a">{startBtn}<button type="button" className="ovd-link" onClick={() => p.onNavigate('tasks')}>{L('查看日志', 'View logs')}</button></div></div>;

  /* ---------- G · 状态条 + 资源条 + 实时图 ---------- */
  if (variant === 'g') return <div className="ovd pm pm-g">
    <header className={`pm-g-strip t-${stateTone}`}>
      <div className="pm-g-id">{stateChip}<h2 title={x.model}>{x.model !== "–" ? x.model : x.profile.name}</h2><span className="pm-g-prof">{x.profile.name}{proc?.pid ? ` · PID ${proc.pid}` : ''}</span></div>
      <div className="pm-g-ep"><code>{x.endpoint}</code>{copyBtn}</div>
      <div className="pm-g-act">{stopped ? startBtn : chat}{switcher}{svc}</div>
    </header>
    {x.notices}
    {stopped ? stoppedPanel('pm-g-stoppedpanel') : <div className="pm-g-body">
      <section className="pm-g-chart">
        <div className="pm-h"><h3>{L('生成速度', 'Decode speed')}</h3><b className="ovd-num pm-big">{f(x.speed)}<small> tok/s</small></b><span className="pm-quiet">{L(`最近 ${reqs.length} 次请求 · 斜纹为截断`, `Last ${reqs.length} requests · hatched = truncated`)}</span><span className="pm-grow" />{x.link('requests', t('requests'))}</div>
        <Bars values={speeds} mid={p50} cut={cut} label={L('最近请求生成速度', 'Recent decode speeds')} />
        <div className="pm-g-sub">
          <div className="pm-g-q"><span>{t('activeRequests')}</span><b className="ovd-num">{runningReq}</b><span>{t('queued')}</span><b className={`ovd-num${queued ? ' is-warn' : ''}`}>{queued}</b><span>{t('prefill')}</span><b className="ovd-num">{f(metric?.prefillTokS, 0)}</b></div>
          <div className="pm-g-gpu"><span>{L('GPU 使用率 · 近 60 次采样', 'GPU util · last 60 samples')}</span><Line values={gpuS} label="GPU" /></div>
        </div>
      </section>
      <aside className="pm-g-res"><div className="pm-h"><h3>{t('resourcesSummary')}</h3><span className="pm-grow" />{x.link('monitoring', t('openMonitor'))}</div>{meters}<p className="pm-quiet pm-g-foot">CPU <b className="ovd-num">{f(metric?.cpuUtil, 0)}%</b> · {t('gpuPower')} <b className="ovd-num">{f(metric?.gpuPower, 0)} W</b></p></aside>
    </div>}
    <footer className="pm-g-foot2">{usageBlock}<div className="pm-g-tasks"><div className="pm-h"><h3>{t('runningTasks')}</h3><span className="pm-grow" />{x.link('tasks', t('viewAllTasks'))}</div>{x.taskList}</div><div className="pm-g-facts">{x.factList}{more}</div></footer>
    {x.dialog}
  </div>;

  /* ---------- H · 以模型为中心 ---------- */
  if (variant === 'h') return <div className="ovd pm pm-h-layout">
    <section className="pm-model">
      <div className="pm-model-top">{stateChip}<span className="pm-grow" />{more}</div>
      <div className="pm-model-main">
        <Ring value={vP} max={100} label={t('gpuMemory')} warn={85} bad={95} center={<><b className="ovd-num">{vP === null ? '–' : Math.round(vP)}<small>%</small></b><span>{L('显存', 'VRAM')}</span><em className="ovd-num">{g(vU)} / {g(vT)} GB</em></>} />
        <div className="pm-model-info">
          <h2 title={x.model}>{x.model !== "–" ? x.model : x.profile.name}</h2>
          <p className="pm-quiet">{x.profile.name} · {loaded ? L('已加载', 'Loaded') : x.modelState}{health.images === true ? L(' · 支持图像', ' · Vision') : ''}{x.capacity ? ` · ${L('上下文', 'Context')} ${f(x.capacity, 0)}` : ''}</p>
          <div className="pm-model-ep"><code>{x.endpoint}</code>{copyBtn}</div>
          <div className="pm-model-act">{stopped ? startBtn : chat}{svc}</div>
        </div>
      </div>
      {stopped ? stoppedPanel('pm-h-stoppedpanel') : <div className="pm-model-meters">
        <Meter label={t('ram')} value={rP} max={100} text={<>{g(rU)} <small>/ {g(rT)} GB</small></>} warn={85} bad={95} />
        <Meter label={t('contextUsage')} value={cP} max={100} text={<>{f(x.ctxUsed, 0)} <small>/ {f(x.capacity, 0)}</small></>} />
        <Meter label={t('gpuUtil')} value={n(metric?.gpuUtil)} max={100} text={<>{f(metric?.gpuUtil, 0)}<small>%</small></>} warn={90} bad={99} sub={<Line values={gpuS} height={26} label="GPU" />} />
        <Meter label={t('gpuTemperature')} value={n(metric?.gpuTemperature)} max={100} text={<>{f(metric?.gpuTemperature, 0)}<small>°C</small> · {f(metric?.gpuPower, 0)} W</>} warn={80} bad={88} />
      </div>}
      <div className="pm-models">
        <div className="pm-h"><h3>{L('切换模型', 'Switch model')}</h3><span className="pm-grow" /><button type="button" className="ovd-link" onClick={() => p.onNavigate('profiles')}>{L('管理模型', 'Manage models')}</button></div>
        <ul>{ops.profiles.map((m: any) => <li key={m.id} className={m.active ? 'is-active' : ''}><span className="pm-models-dot" /><span className="pm-models-name">{m.name}</span>{m.active ? <em>{L('当前', 'Current')}</em> : <button type="button" className="pm-btn pm-btn-sm" disabled={ops.disabled} onClick={() => ops.onSelect(m.id)}>{L('切换', 'Switch')}</button>}</li>)}</ul>
      </div>
    </section>
    <aside className="pm-h-side">
      {x.notices}
      <section><div className="pm-h"><h3>{L('吞吐', 'Throughput')}</h3><span className="pm-grow" />{x.link('requests', t('requests'))}</div>
        <div className="pm-h-speed"><b className="ovd-num pm-big">{stopped ? '–' : f(x.speed)}<small> tok/s</small></b><span>{t('activeRequests')} <b className="ovd-num">{runningReq}</b></span><span>{t('queued')} <b className={`ovd-num${queued ? ' is-warn' : ''}`}>{queued}</b></span></div>
        {stopped ? <p className="pm-quiet">{t('noMetrics')}</p> : <Bars values={speeds} height={84} mid={p50} cut={cut} label={L('最近请求生成速度', 'Recent decode speeds')} />}
      </section>
      <section>{usageBlock}</section>
      <section><div className="pm-h"><h3>{t('runningTasks')}</h3><span className="pm-grow" />{x.link('tasks', t('viewAllTasks'))}</div>{x.taskList}</section>
      <section><div className="pm-h"><h3>{t('service')}</h3></div>{x.factList}</section>
    </aside>
    {x.dialog}
  </div>;

  /* ---------- I · 先看需要处理的事，再看指标 ---------- */
  const alerts: { tone: Tone; title: string; detail: string; action?: ReactNode }[] = [];
  if (stopped) alerts.push({ tone: 'bad', title: proc?.running === false ? L('服务未运行', 'Service is not running') : L('无法连接到服务', 'Cannot reach the service'), detail: L('聊天和 API 暂不可用。', 'Chat and API are unavailable.'), action: <>{startBtn}<button type="button" className="ovd-link" onClick={() => p.onNavigate('tasks')}>{L('查看日志', 'View logs')}</button></> });
  if (!stopped && x.online && health.loaded === false) alerts.push({ tone: 'warn', title: L('模型未加载', 'Model not loaded'), detail: L('API 在线，但还没有可用的模型。', 'The API is up but no model is loaded.'), action: btn('load2', <Upload size={14} />, t('load'), ops.onLoad, 'primary pm-primary') });
  if (vP !== null && vP >= 85) alerts.push({ tone: vP >= 95 ? 'bad' : 'warn', title: L(`显存已用 ${Math.round(vP)}%`, `VRAM at ${Math.round(vP)}%`), detail: L(`${g(vU)} / ${g(vT)} GB，长上下文可能失败。`, `${g(vU)} / ${g(vT)} GB; long contexts may fail.`), action: btn('unload2', <Download size={14} />, L('释放内存', 'Release memory'), ops.onUnload) });
  if (queued > 0) alerts.push({ tone: 'warn', title: L(`${queued} 个请求在排队`, `${queued} request(s) queued`), detail: L(`正在处理 ${runningReq} 个。`, `${runningReq} running.`), action: x.link('monitoring', t('openMonitor')) });
  if (failed > 0) alerts.push({ tone: 'warn', title: L(`今日 ${failed} 次请求失败`, `${failed} failed request(s) today`), detail: L(`共 ${f(total, 0)} 次，成功率 ${http?.successRate == null ? '–' : f(http.successRate * 100, 1)}%。`, `${f(total, 0)} total, ${http?.successRate == null ? '–' : f(http.successRate * 100, 1)}% success.`), action: <button type="button" className="ovd-link" onClick={x.usageOpen}>{L('查看失败请求', 'See failures')}</button> });
  const truncated = cut.filter(Boolean).length;
  if (truncated) alerts.push({ tone: 'idle', title: L(`最近 ${truncated} 次回答被长度截断`, `${truncated} recent answer(s) hit the length limit`), detail: L('可在运行配置里调大最大输出。', 'Raise max output in Configuration.'), action: <button type="button" className="ovd-link" onClick={() => p.onNavigate('config')}>{L('运行配置', 'Configuration')}</button> });
  if (x.bgFresh && x.bgFresh.phase === 'degraded') alerts.push({ tone: 'warn', title: x.bgLabel, detail: x.bgFresh.reason ?? '', action: x.link('tasks', t('viewAllTasks')) });
  for (const task of x.running) alerts.push({ tone: 'idle', title: task.message || t('task'), detail: L(`后台任务 · ${new Date(task.startedAt).toLocaleTimeString(p.language)} 开始`, `Background task · started ${new Date(task.startedAt).toLocaleTimeString(p.language)}`), action: x.link('tasks', t('viewAllTasks')) });
  return <div className="ovd pm pm-i">
    <header className="pm-i-head">
      <div className="pm-i-id">{stateChip}<h2 title={x.model}>{x.model !== "–" ? x.model : x.profile.name}</h2><code>{x.endpoint}</code></div>
      <div className="pm-i-act">{stopped ? startBtn : chat}{copyBtn}{switcher}{svc}</div>
    </header>
    {x.notices}
    <section className="pm-i-alerts" aria-label={L('需要关注', 'Needs attention')}>
      <div className="pm-h"><h3>{L('需要关注', 'Needs attention')}</h3><span className="pm-count ovd-num">{alerts.length}</span><span className="pm-grow" />{more}</div>
      {alerts.length ? <ol>{alerts.map((a, i) => <li key={i} className={`t-${a.tone}`}><i className="pm-i-mark" /><div><strong>{a.title}</strong><span>{a.detail}</span></div><div className="pm-i-a">{a.action}</div></li>)}</ol>
        : <p className="pm-i-fine"><Check size={16} />{L('一切正常：服务在线、资源充足、今天没有失败请求。', 'All good: service up, resources fine, no failures today.')}</p>}
    </section>
    <section className="pm-i-metrics">
      <div className="pm-i-col">
        <div className="pm-h"><h3>{L('速度', 'Speed')}</h3><b className="ovd-num pm-big">{stopped ? '–' : f(x.speed)}<small> tok/s</small></b><span className="pm-grow" />{x.link('requests', t('requests'))}</div>
        {stopped ? <p className="pm-quiet">{t('noMetrics')}</p> : <Bars values={speeds} height={92} mid={p50} cut={cut} label={L('最近请求生成速度', 'Recent decode speeds')} />}
        <p className="pm-quiet">{t('activeRequests')} <b className="ovd-num">{runningReq}</b> · {t('queued')} <b className="ovd-num">{queued}</b> · {t('prefill')} <b className="ovd-num">{f(metric?.prefillTokS, 0)}</b> tok/s</p>
      </div>
      <div className="pm-i-col">{stopped ? <><div className="pm-h"><h3>{t('resourcesSummary')}</h3></div><p className="pm-quiet">{t('noMetrics')}</p></> : <><div className="pm-h"><h3>{t('resourcesSummary')}</h3><span className="pm-grow" />{x.link('monitoring', t('openMonitor'))}</div>{meters}</>}</div>
      <div className="pm-i-col">{usageBlock}<div className="pm-i-facts">{x.factList}</div></div>
    </section>
    {x.dialog}
  </div>;
}
