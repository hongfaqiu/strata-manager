import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, AlertTriangle, ArrowRight, Boxes, Check, ChevronDown, Copy, Cpu, MemoryStick, MessageSquare, MonitorSmartphone, Plug, RefreshCw, RotateCcw, Settings2, SlidersHorizontal } from 'lucide-react';
import { gpuCards, gpuSetName, modelLoadNotice, normalizeBaseUrl, type AppLanguage, type BackgroundHealthSnapshot, type JsonObject, type MetricSnapshot, type ProcessStatus, type ServiceProfile, type TaskStatus } from '@strata-manager/core';
import { ApiIntegrationDialog } from '../ApiIntegrationDialog';
import { useOverviewUsage } from './OverviewUsage';
import './overview-dashboard.css';

export type OverviewNavigationTarget = 'monitoring' | 'config' | 'tasks' | 'requests' | 'profiles' | 'environment' | 'usage';
export interface OverviewDashboardProps {
  profile: ServiceProfile; health: JsonObject; backgroundHealth?: BackgroundHealthSnapshot; metric?: MetricSnapshot; process?: ProcessStatus; tasks: TaskStatus[]; language: AppLanguage;
  online: boolean; connecting: boolean; desktop: boolean; tasksLoading: boolean; healthError?: string; metricsError?: string; taskError?: string; processError?: string;
  /** Start / stop / load / release buttons owned by App (guards and tooltips live there). */
  controls: ReactNode;
  stateLabel: (state: string) => string; onRefresh: () => void; onChat: () => void; onCopy: (content: string) => void;
  onNavigate: (page: OverviewNavigationTarget) => void; onImages?: () => void; onRestart?: () => void;
  profiles?: { id: string; name: string }[]; onSwitchProfile?: (id: string) => void; actionsDisabled?: boolean;
  /** Epoch ms when the app started a model start/load that is still in progress. */
  loadingSince?: number;
}
type Tone = 'ok' | 'warn' | 'bad' | 'idle';
const GiB = 1024 ** 3;
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const obj = (v: unknown): JsonObject => v && typeof v === 'object' && !Array.isArray(v) ? v as JsonObject : {};
const toneOf = (p: number | null, warn: number, bad: number): Tone => p === null ? 'idle' : p >= bad ? 'bad' : p >= warn ? 'warn' : 'ok';
/** Thresholds shared by bars, arcs and the attention line. */
export const overviewThresholds = { memoryWarn: 85, memoryBad: 95, gpuWarn: 90, gpuBad: 99, tempWarn: 80, tempBad: 88, tempAlert: 83, powerWarn: 90, powerBad: 98, contextWarn: 80, contextBad: 95 } as const;
const T = overviewThresholds;

/** Smooth area sparkline (Catmull-Rom to cubic Bézier). */
function Sparkline({ values, label, height = 64 }: { values: (number | null)[]; label: string; height?: number }) {
  const points = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  if (points.length < 2) return <div className="ovw-spark is-empty" style={{ height }} />;
  const width = 320, last = Math.max(1, values.length - 1), hi = Math.max(...points.map(p => p[1])), lo = Math.min(...points.map(p => p[1]));
  const pad = (hi - lo) * .35 || 1, top = hi + pad, bottom = Math.max(0, lo - pad);
  const xy = points.map(([i, v]) => [i / last * width, 4 + (1 - (v - bottom) / (top - bottom)) * (height - 8)] as [number, number]);
  let d = `M${xy[0]![0]} ${xy[0]![1]}`;
  for (let i = 0; i < xy.length - 1; i++) {
    const p0 = xy[i - 1] ?? xy[i]!, p1 = xy[i]!, p2 = xy[i + 1]!, p3 = xy[i + 2] ?? p2;
    d += ` C${p1[0] + (p2[0] - p0[0]) / 6} ${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6} ${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]} ${p2[1]}`;
  }
  const end = xy[xy.length - 1]!;
  return <svg className="ovw-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ height }} role="img" aria-label={label}>
    <defs><linearGradient id="ovw-spark-fade" x1="0" x2="0" y1="0" y2="1"><stop offset="0" className="ovw-fade-a" /><stop offset="1" className="ovw-fade-b" /></linearGradient></defs>
    <path d={`${d} L${width} ${height} L0 ${height} Z`} fill="url(#ovw-spark-fade)" /><path d={d} className="ovw-spark-line" vectorEffect="non-scaling-stroke" />
    <circle cx={end[0]} cy={end[1]} r="3" className="ovw-spark-dot" />
  </svg>;
}
/** 240° arc gauge with a threshold tick. */
function Arc({ value, max, label, text, warn, bad, size = 64 }: { value: number | null; max: number; label: string; text: ReactNode; warn: number; bad: number; size?: number }) {
  const share = value === null ? null : Math.min(1, Math.max(0, value / max)), r = size / 2 - 5, c = 2 * Math.PI * r, sweep = 2 / 3;
  const angle = warn / 100 * sweep * 2 * Math.PI + Math.PI * 5 / 6, at = (radius: number) => [size / 2 + radius * Math.cos(angle), size / 2 + radius * Math.sin(angle)] as const;
  const [x1, y1] = at(r - 5), [x2, y2] = at(r + 4);
  return <div className={`ovw-arc t-${toneOf(share === null ? null : share * 100, warn, bad)}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={share === null ? undefined : Math.round(share * 100)}>
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true"><g transform={`rotate(150 ${size / 2} ${size / 2})`}>
      <circle cx={size / 2} cy={size / 2} r={r} className="ovw-arc-track" strokeDasharray={`${c * sweep} ${c}`} />
      <circle cx={size / 2} cy={size / 2} r={r} className="ovw-arc-fill" strokeDasharray={`${c * sweep * (share ?? 0)} ${c}`} /></g>
      <line x1={x1} y1={y1} x2={x2} y2={y2} className="ovw-arc-tick" /></svg>
    <b className="ovw-num">{text}</b><span>{label}</span>
  </div>;
}

export function OverviewDashboard(props: OverviewDashboardProps) {
  const { profile, health, metric, process: proc, tasks, language, online, connecting, desktop, onNavigate } = props;
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [apiOpen, setApiOpen] = useState(false);
  const [showAllIssues, setShowAllIssues] = useState(false);
  const usage = useOverviewUsage(profile, desktop);
  const fmt = (v: unknown, digits = 1) => num(v) === null ? '–' : num(v)!.toLocaleString(language, { maximumFractionDigits: digits });
  const gib = (v: number | null, digits = 1) => v === null ? '–' : (v / GiB).toLocaleString(language, { maximumFractionDigits: digits });
  const time = (s: unknown) => num(s) === null ? '–' : new Date(num(s)! * 1000).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const finishLabel = (finish: unknown) => finish === undefined ? '–' : t(({ stop: 'stoppedFinish', length: 'lengthFinish', cancelled: 'cancelledFinish', tool_calls: 'toolCallsFinish' } as Record<string, string>)[String(finish)] ?? 'unknown');

  const raw = obj(metric?.raw), hw = obj(raw.hardware), hwStatic = obj(raw.hardware_static), engine = obj(raw.engine), live = obj(raw.live), parkedCache = obj(raw.conversation_cache);
  const stopped = !online && !connecting;
  const generating = metric?.state === 'generating' || metric?.state === 'reading';
  const loaded = online && health.loaded === true;
  // One name everywhere (Xiaohongshu feedback): the model the user picked, as in the startup card, the
  // sidebar and the switch menu. The name clients send to the API (config model_name) is a labeled detail.
  const servedModel = String(health.model ?? engine.model ?? '');
  const model = profile.name || servedModel;
  let endpoint = profile.baseUrl; try { endpoint = `${normalizeBaseUrl(profile.baseUrl)}/v1`; } catch { /* keep raw */ }

  const vramUsed = num(metric?.gpuMemoryUsed), vramTotal = num(metric?.gpuMemoryTotal), ramUsed = num(metric?.ramUsed), ramTotal = num(metric?.ramTotal);
  const vramPct = vramUsed !== null && vramTotal ? vramUsed / vramTotal * 100 : null, ramPct = ramUsed !== null && ramTotal ? ramUsed / ramTotal * 100 : null;
  const experts = num(engine.expert_cache_mib) === null ? null : num(engine.expert_cache_mib)! * 1048576;
  const parked = parkedCache.enabled === true ? num(parkedCache.bytes) : null;
  const vramOther = vramUsed === null ? null : Math.max(0, vramUsed - (experts ?? 0)), ramOther = ramUsed === null ? null : Math.max(0, ramUsed - (parked ?? 0));
  const width = (v: number | null, total: number | null) => v !== null && total ? `${Math.max(0, Math.min(100, v / total * 100))}%` : '0%';
  const cards = gpuCards(raw), multiGpu = cards.length > 1, gpuName = gpuSetName(raw) ?? 'GPU', powerLimit = num(hw.gpu_power_limit);
  const loadNotice = modelLoadNotice({ online, loaded: health.loaded, metric, loadingSince: props.loadingSince });
  const lastRequest = metric?.requests[0];
  const capacity = num(engine.max_context) ?? num(health.max_context);
  const prompt = num(live.state === 'idle' ? lastRequest?.prompt_tokens : live.prompt_tokens), generated = num(live.state === 'idle' ? lastRequest?.output_tokens : live.generated);
  const contextUsed = prompt !== null && generated !== null ? prompt + generated : null, contextPct = contextUsed !== null && capacity ? contextUsed / capacity * 100 : null;

  const recent = [...(metric?.requests ?? [])].filter(r => num(r.time) !== null).sort((a, b) => (a.time as number) - (b.time as number)).slice(-16);
  const speeds = recent.map(r => num(r.decode_tok_s));
  const speed = generating ? metric?.decodeTokS ?? null : num(recent.at(-1)?.decode_tok_s);
  const http = usage.summary?.http, p50 = num(usage.summary?.decodeTokS?.p50), ttft = num(usage.summary?.ttftS?.p50);
  const failed = (num(http?.failed) ?? 0) + (num(http?.interrupted) ?? 0), rate = num(http?.successRate);
  const queued = num(metric?.queued) ?? 0, active = num(metric?.running) ?? 0;
  const truncated = recent.filter(r => r.finish === 'length').length;
  const runningTasks = tasks.filter(task => task.state === 'running');
  const background = props.backgroundHealth && proc?.running && proc.owned && props.backgroundHealth.profileId === profile.id && props.backgroundHealth.pid === proc.pid ? props.backgroundHealth : undefined;
  const backgroundFresh = background && background.checkedAt > 0 && Date.now() - background.checkedAt < 65_000 ? background : undefined;

  const issues: { tone: Tone; text: string; action?: ReactNode }[] = [];
  const link = (label: string, page: OverviewNavigationTarget) => <button type="button" className="text-button ovw-link" onClick={() => onNavigate(page)}>{label}<ArrowRight size={13} aria-hidden="true" /></button>;
  if (stopped) issues.push({ tone: 'bad', text: desktop && proc?.running === false ? t('ovIssueStopped') : t('ovIssueUnreachable'), action: link(t('ovViewLogs'), 'tasks') });
  // A slow cold load is normal progress, not a warning (Xiaohongshu feedback).
  if (loadNotice?.kind === 'loading') issues.push({ tone: 'idle', text: loadNotice.seconds !== null ? t('ovIssueLoading', { seconds: loadNotice.seconds }) : t('ovIssueLoadingNow') });
  else if (loadNotice?.kind === 'notLoaded') issues.push({ tone: 'warn', text: t('ovIssueNotLoaded') });
  if (vramPct !== null && vramPct >= T.memoryWarn) issues.push({ tone: vramPct >= T.memoryBad ? 'bad' : 'warn', text: t('ovIssueVram', { pct: Math.round(vramPct) }), action: link(t('openMonitor'), 'monitoring') });
  if (num(metric?.gpuTemperature) !== null && metric!.gpuTemperature! >= T.tempAlert) issues.push({ tone: 'warn', text: t('ovIssueTemp', { temp: fmt(metric!.gpuTemperature, 0) }) });
  if (queued > 0) issues.push({ tone: 'warn', text: t('ovIssueQueue', { queued, running: active }), action: link(t('openMonitor'), 'monitoring') });
  if (failed > 0) issues.push({ tone: 'warn', text: t('ovIssueFailed', { count: failed }), action: link(t('ovView'), 'usage') });
  if (truncated) issues.push({ tone: 'idle', text: t('ovIssueTruncated', { count: truncated }), action: link(t('ovAdjust'), 'config') });
  if (backgroundFresh?.phase === 'degraded') issues.push({ tone: 'warn', text: t('backgroundHealthPreserved') });
  const [firstIssue, ...moreIssues] = issues;

  const stateTone: Tone = stopped ? 'bad' : connecting || !loaded ? 'warn' : 'ok';
  const stateWord = stopped ? (desktop && proc?.running === false ? t('ovStopped') : t('ovUnreachable')) : connecting ? t('ovStarting') : metric ? props.stateLabel(metric.state) : t(online ? 'online' : 'offline');
  const imageSupport = online && typeof health.images === 'boolean' ? t(health.images ? 'ovEnabled' : 'ovDisabled') : t('unknown');
  const copy = () => { props.onCopy(endpoint); setCopied(true); window.setTimeout(() => setCopied(false), 1400); };
  const switchable = (props.profiles?.length ?? 0) > 1 && !!props.onSwitchProfile;
  const legend = (items: [string, number | null, string][], free: number | null) => <ul className="ovw-legend">
    {items.filter(item => item[1] !== null).map(([label, value, cls]) => <li key={label}><i className={cls} />{label}<b className="ovw-num">{gib(value)}</b></li>)}
    <li><i className="free" />{t('ovFree')}<b className="ovw-num">{gib(free)}</b></li></ul>;

  return <div className="ovw">
    <section className="overview-service ovw-top" aria-label={t('service')}>
      <div className="ovw-id">
        <span className={`ovw-state t-${stateTone}`}><i aria-hidden="true" />{stateWord}</span>
        <h2 title={model}>{model}</h2>
        <span className="ovw-sub">{servedModel && servedModel !== model && <span className="ovw-api-name" data-tooltip={t('ovApiModelHint')}>{t('ovApiModel')} <code>{servedModel}</code></span>}{servedModel && servedModel !== model && proc?.pid ? ' · ' : ''}{proc?.pid ? `PID ${proc.pid}` : ''}</span>
      </div>
      <div className="ovw-endpoint"><code>{endpoint}</code><button type="button" className="ovw-btn ovw-btn-ghost" onClick={copy}>{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}<span>{copied ? t('ovCopied') : t('ovCopyApi')}</span></button></div>
      <div className="ovw-actions" role="group" aria-label={t('quickActions')}>
        {!stopped && <button type="button" className="primary ovw-btn" onClick={props.onChat} disabled={!loaded}><MessageSquare size={14} aria-hidden="true" /><span>{t('openChat')}</span></button>}
        {props.controls}
        {props.onRestart && <button type="button" className="ovw-btn" onClick={props.onRestart} disabled={props.actionsDisabled}><RotateCcw size={14} aria-hidden="true" /><span>{t('ovRestart')}</span></button>}
        {switchable && <div className="ovw-switch"><button type="button" className="ovw-btn" aria-expanded={menuOpen} aria-haspopup="listbox" onClick={() => setMenuOpen(v => !v)} disabled={props.actionsDisabled}><Boxes size={14} aria-hidden="true" /><span>{t('ovSwitchModel')}</span><ChevronDown size={13} aria-hidden="true" /></button>
          {menuOpen && <ul className="ovw-menu" role="listbox" aria-label={t('ovSwitchModel')}>{props.profiles!.map(item => <li key={item.id}><button type="button" role="option" aria-selected={item.id === profile.id} onClick={() => { setMenuOpen(false); if (item.id !== profile.id) props.onSwitchProfile!(item.id); }}>{item.id === profile.id ? <Check size={13} aria-hidden="true" /> : <span className="ovw-menu-pad" />}{item.name}</button></li>)}
            <li className="ovw-menu-foot"><button type="button" onClick={() => { setMenuOpen(false); onNavigate('profiles'); }}>{t('ovManageModels')}</button></li></ul>}</div>}
        {desktop && profile.managed && profile.configPath && <button type="button" className="ovw-btn" data-testid="overview-startup-params" data-tooltip={t('ovLaunchParamsHint')} onClick={() => onNavigate('config')}><SlidersHorizontal size={14} aria-hidden="true" /><span>{t('ovLaunchParams')}</span></button>}
        <button type="button" className="ovw-btn overview-shortcut-api" onClick={() => setApiOpen(true)}><Plug size={14} aria-hidden="true" /><span>{t('ovIntegration')}</span></button>
      </div>
    </section>
    {firstIssue && <div className={`ovw-attn t-${firstIssue.tone}`} role="status">
      <AlertTriangle size={15} aria-hidden="true" /><span className="ovw-attn-text">{firstIssue.text}</span>
      {moreIssues.length > 0 && <button type="button" className="text-button ovw-link" aria-expanded={showAllIssues} onClick={() => setShowAllIssues(v => !v)}>{showAllIssues ? t('ovLess') : t('ovMore', { count: moreIssues.length })}</button>}
      <span className="ovw-grow" />{firstIssue.action}
    </div>}
    {showAllIssues && moreIssues.map((issue, i) => <div key={i} className={`ovw-attn ovw-attn-more t-${issue.tone}`}><span className="ovw-attn-dot" aria-hidden="true" /><span className="ovw-attn-text">{issue.text}</span><span className="ovw-grow" />{issue.action}</div>)}
    {[props.healthError, props.processError, props.metricsError, usage.error].filter(Boolean).map((error, i) => <div key={i} className="notice error ovw-notice" role="alert">{error}</div>)}

    <section className={`ovw-map${stopped ? ' is-off' : ''}`} aria-label={t('ovHardware')}>
      <div className="ovw-dev ovw-dev-gpu">
        <div className="ovw-dev-head"><MonitorSmartphone size={15} aria-hidden="true" /><strong title={typeof hwStatic.gpu_name === 'string' ? hwStatic.gpu_name : undefined}>{gpuName}</strong><span className="ovw-grow" /><span className="ovw-dev-key">{t('ovVram')}</span><b className={`ovw-num ovw-dev-value t-${toneOf(vramPct, T.memoryWarn, T.memoryBad)}`}>{gib(vramUsed)}<small> / {gib(vramTotal, 0)} GB</small></b></div>
        <div className={`ovw-mem t-${toneOf(vramPct, T.memoryWarn, T.memoryBad)}`} role="meter" aria-label={t('ovVram')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={vramPct === null ? undefined : Math.round(vramPct)}>
          {experts !== null && <i className="seg-a" style={{ width: width(experts, vramTotal) }} />}<i className="seg-b" style={{ width: width(vramOther, vramTotal) }} /><s style={{ left: `${T.memoryWarn}%` }} />
        </div>
        {legend([[t('ovExperts'), experts, 'seg-a'], [t('ovModelRuntime'), vramOther, 'seg-b']], vramUsed !== null && vramTotal !== null ? vramTotal - vramUsed : null)}
        {multiGpu && <ul className="ovw-gpu-cards" aria-label={t('ovGpuCards')} data-testid="overview-gpu-cards">{cards.map(card => {
          const pct = card.memUsed !== null && card.memTotal ? card.memUsed / card.memTotal * 100 : null;
          return <li key={card.index} title={card.name ?? undefined}>
            <span className="ovw-gpu-id">GPU {card.index}</span>
            <span className={`ovw-gpu-bar t-${toneOf(pct, T.memoryWarn, T.memoryBad)}`} aria-hidden="true"><i style={{ width: width(card.memUsed, card.memTotal) }} /></span>
            <b className="ovw-num">{gib(card.memUsed)}<small> / {gib(card.memTotal, 0)} GB</small></b>
            <span className="ovw-num">{fmt(card.util, 0)}%</span>
            <span className="ovw-num">{fmt(card.temp, 0)}°C</span>
          </li>;
        })}</ul>}
        <div className="ovw-arcs">
          <Arc value={num(metric?.gpuUtil)} max={100} label={t('ovLoad')} text={<>{fmt(metric?.gpuUtil, 0)}<small>%</small></>} warn={T.gpuWarn} bad={T.gpuBad} />
          <Arc value={num(metric?.gpuTemperature)} max={100} label={t('ovTemp')} text={<>{fmt(metric?.gpuTemperature, 0)}<small>°C</small></>} warn={T.tempWarn} bad={T.tempBad} />
          <Arc value={num(metric?.gpuPower)} max={powerLimit ?? 450} label={powerLimit ? t('ovPowerOf', { limit: fmt(powerLimit, 0) }) : t('ovPower')} text={<>{fmt(metric?.gpuPower, 0)}<small>W</small></>} warn={T.powerWarn} bad={T.powerBad} />
        </div>
      </div>
      <div className={`ovw-bus${generating ? ' is-on' : ''}`} aria-hidden="true">
        <span className="ovw-bus-line" />
        <b className="ovw-num">{num(hw.gpu_pcie_gen) !== null ? `PCIe ${hw.gpu_pcie_gen}.0` : 'PCIe'}{num(hw.gpu_pcie_width) !== null ? ` ×${hw.gpu_pcie_width}` : ''}</b>
        {num(hw.gpu_pcie_rx_mb) !== null && <small className="ovw-num">↓ {fmt(hw.gpu_pcie_rx_mb, 0)} MB/s</small>}
        {multiGpu && num(hw.gpu_pcie_gen) !== null && <small>{t('ovPcieFirstCard')}</small>}
      </div>
      <div className="ovw-dev ovw-dev-ram">
        <div className="ovw-dev-head"><MemoryStick size={15} aria-hidden="true" /><strong>{t('ram')}</strong><span className="ovw-grow" /><span className="ovw-dev-key">RAM</span><b className={`ovw-num ovw-dev-value t-${toneOf(ramPct, T.memoryWarn, T.memoryBad)}`}>{gib(ramUsed)}<small> / {gib(ramTotal, 0)} GB</small></b></div>
        <div className={`ovw-mem t-${toneOf(ramPct, T.memoryWarn, T.memoryBad)}`} role="meter" aria-label={t('ram')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={ramPct === null ? undefined : Math.round(ramPct)}>
          {parked !== null && <i className="seg-a" style={{ width: width(parked, ramTotal) }} />}<i className="seg-b" style={{ width: width(ramOther, ramTotal) }} /><s style={{ left: `${T.memoryWarn}%` }} />
        </div>
        {legend([[t('ovParked'), parked, 'seg-a'], [t('ovOtherUse'), ramOther, 'seg-b']], ramUsed !== null && ramTotal !== null ? ramTotal - ramUsed : null)}
        <div className="ovw-arcs">
          <Arc value={num(metric?.cpuUtil)} max={100} label="CPU" text={<>{fmt(metric?.cpuUtil, 0)}<small>%</small></>} warn={T.gpuWarn} bad={T.gpuBad} />
          <Arc value={contextPct} max={100} label={t('ovContext')} text={<>{contextPct === null ? '–' : Math.round(contextPct)}<small>%</small></>} warn={T.contextWarn} bad={T.contextBad} />
          <div className="ovw-dev-facts">{num(hwStatic.cores) !== null && <span>{t('ovCores', { cores: hwStatic.cores, threads: hwStatic.threads ?? '–' })}</span>}<span>{t('ovContext')} <b className="ovw-num">{fmt(contextUsed, 0)}</b> / {fmt(capacity, 0)}</span></div>
        </div>
      </div>
      {stopped && <div className="ovw-off" role="status"><Cpu size={18} aria-hidden="true" /><div><strong>{t('ovOffTitle')}</strong><span>{t('ovOffHint')}</span></div></div>}
    </section>

    <div className="ovw-low">
      <section className="ovw-speed">
        <div className="ovw-head"><h3>{generating ? t('decode') : t('ovSpeedLast')}</h3><span className="ovw-grow" />{link(t('openMonitor'), 'monitoring')}</div>
        <div className="ovw-speed-value"><b className="ovw-num">{stopped ? '–' : fmt(speed)}</b><small>tok/s</small>{p50 !== null && <span>{t('ovTodayP50')} <b className="ovw-num">{fmt(p50)}</b></span>}</div>
        {stopped || !metric ? <p className="ovw-quiet">{t('noMetrics')}</p> : <Sparkline values={speeds} label={t('ovSpeedTrend')} />}
        <dl className="ovw-kv">
          <div><dt>{t('activeRequests')}</dt><dd className="ovw-num">{active}</dd></div>
          <div><dt>{t('queued')}</dt><dd className={`ovw-num${queued ? ' is-warn' : ''}`}>{queued}</dd></div>
          <div><dt>{t('prefill')}</dt><dd className="ovw-num">{fmt(metric?.prefillTokS, 0)}<small> tok/s</small></dd></div>
          <div><dt>{t('ovTtft')}</dt><dd className="ovw-num">{ttft === null ? '–' : fmt(ttft, 2)}<small> s</small></dd></div>
        </dl>
      </section>
      <section className="ovw-requests">
        <div className="ovw-head"><h3>{t('requestsRecent')}</h3><span className="ovw-grow" />{link(t('requests'), 'requests')}</div>
        {recent.length ? <ol className="ovw-list">{[...recent].reverse().slice(0, 7).map((request, index) => <li key={String(request.id ?? index)}>
          <i className={`ovw-finish f-${request.finish === 'length' ? 'warn' : request.finish === 'cancelled' ? 'idle' : 'ok'}`} aria-hidden="true" />
          <time className="ovw-num">{time(request.time)}</time>
          <span className="ovw-num ovw-tokens">{fmt(request.prompt_tokens, 0)} <em>→</em> {fmt(request.output_tokens, 0)}</span>
          <span className="ovw-num ovw-rate">{fmt(request.decode_tok_s)}<small> tok/s</small></span>
          <span className="ovw-finish-text">{finishLabel(request.finish)}</span></li>)}</ol>
          : <p className="ovw-quiet">{t(!metric ? 'noMetrics' : 'overviewRequestsEmpty')}</p>}
      </section>
      <aside className="ovw-side">
        <section>
          <div className="ovw-head"><h3>{t('ovTodayApi')}</h3><span className="ovw-grow" />{link(t('ovUsageDetails'), 'usage')}</div>
          <div className="ovw-today"><b className="ovw-num">{fmt(http?.requests, 0)}</b><span>{t('ovRequestsUnit')}</span><span className="ovw-grow" /><span className={`ovw-num ovw-success${failed ? ' is-warn' : ''}`}>{rate === null ? '–' : fmt(rate * 100)}%</span><span className="ovw-quiet">{t('ovSuccess')}</span></div>
          <p className="ovw-quiet ovw-today-sub">{t('ovIn')} <b className="ovw-num">{fmt(http?.inputTokens, 0)}</b> · {t('ovOut')} <b className="ovw-num">{fmt(http?.outputTokens, 0)}</b> · {t('ovFailed')} <b className="ovw-num">{http ? failed : '–'}</b></p>
        </section>
        <section>
          <div className="ovw-head"><h3>{t('runningTasks')}</h3><span className="ovw-grow" />{link(t('viewAllTasks'), 'tasks')}</div>
          {props.taskError && <div className="notice error" role="alert">{props.taskError}</div>}
          {runningTasks.length ? <ul className="ovw-tasks">{runningTasks.map(task => <li key={task.id}><button type="button" onClick={() => onNavigate('tasks')}><strong>{t(task.kind.includes('setup') ? 'setupTask' : task.kind.includes('install') ? 'installTask' : task.kind.includes('update') ? 'updateTask' : 'task')}</strong><span>{task.message || props.stateLabel(task.state)}</span><time>{new Date(task.startedAt).toLocaleTimeString(language)}</time></button></li>)}</ul>
            : <p className="ovw-quiet">{t(!desktop ? 'nativeRequired' : props.tasksLoading ? 'loading' : props.taskError ? 'unavailable' : 'noRunningTasks')}</p>}
        </section>
        <section>
          <dl className="ovw-facts">
            <div><dt>{t('status')}</dt><dd>{metric ? props.stateLabel(metric.state) : '–'}</dd></div>
            {profile.managed && desktop && <div data-tooltip={proc?.pid ? `${t('pid')} ${proc.pid}` : undefined}><dt>{t('process')}</dt><dd>{proc ? t(proc.running ? 'running' : 'stopped') : '–'}</dd></div>}
            <div><dt>{t('ovImages')}</dt><dd>{imageSupport}{props.onImages && <button type="button" className="text-button ovw-link" onClick={props.onImages}>{health.images === true && online ? t('ovImageSettings') : t('ovEnableImages')}</button>}</dd></div>
            {desktop && proc?.owned && proc.running && <div data-tooltip={backgroundFresh?.reason}><dt>{t('ovBackground')}</dt><dd>{backgroundFresh ? t(`backgroundHealth_${backgroundFresh.phase}`) : t('ovNotChecked')}</dd></div>}
          </dl>
          <div className="ovw-more">
            <button type="button" className="text-button ovw-link" onClick={() => onNavigate('monitoring')}><Activity size={13} aria-hidden="true" />{t('openMonitor')}</button>
            <button type="button" className="text-button ovw-link" onClick={() => onNavigate('config')}><Settings2 size={13} aria-hidden="true" />{t('ovConfiguration')}</button>
            <button type="button" className="ovw-icon" onClick={props.onRefresh} aria-label={t('refresh')} data-tooltip={t('refresh')}><RefreshCw size={13} aria-hidden="true" /></button>
          </div>
        </section>
      </aside>
    </div>
    {apiOpen && <ApiIntegrationDialog key={`api-integration-${profile.id}`} profile={profile} model={typeof health.model === 'string' ? health.model : typeof engine.model === 'string' ? engine.model : undefined} online={online} loaded={health.loaded === true} keyRequired={online && typeof health.api_key === 'boolean' ? health.api_key : undefined} language={language} onCopy={props.onCopy} onClose={() => setApiOpen(false)} />}
  </div>;
}
