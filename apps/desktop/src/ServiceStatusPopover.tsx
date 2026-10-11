import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Activity, ChevronDown, RefreshCw, Settings2, Terminal, X } from 'lucide-react';
import type { MetricSnapshot, ProcessStatus, ServiceProfile } from '@strata-manager/core';
import { appendTelemetry, telemetryNumber, telemetryPoint, telemetrySparkline, type TelemetryHistory, type TelemetryPoint, type TelemetrySeries } from './serviceStatusTelemetry';
import './service-status-popover.css';

interface Props {
  language: 'zh-CN' | 'en';
  label: string;
  state: string;
  profile?: ServiceProfile;
  process?: ProcessStatus;
  processUnverified?: boolean;
  online: boolean;
  loaded?: boolean;
  metric?: MetricSnapshot;
  metricUpdatedAt?: number;
  metricsUnavailable?: boolean;
  connecting?: boolean;
  activity?: string;
  actions: ReactNode;
  actionsDisabled: boolean;
  onRefresh: () => Promise<unknown>;
  onNavigate: (page: 'monitoring' | 'models' | 'tasks') => void;
}

function Sparkline({ points, series, label, waiting }: { points: TelemetryPoint[]; series: TelemetrySeries; label: string; waiting: string }) {
  const graph = telemetrySparkline(points, series, series === 'gpu' ? 100 : undefined);
  return graph.count ? <svg className="service-status-sparkline" viewBox="0 0 160 48" preserveAspectRatio="none" role="img" aria-label={label} data-samples={graph.count}>
    <path d="M4 44H156" className="service-status-chart-baseline"/>
    {graph.paths.map((path, index) => <path key={index} d={path} className="service-status-chart-line"/>)}
    {graph.last && <circle cx={graph.last.x} cy={graph.last.y} r={2.3}/>}
  </svg> : <div className="service-status-chart-empty">{waiting}</div>;
}

function ResourceMeter({ label, value, percent }: { label: string; value: string; percent: number | null }) {
  const bounded = percent === null ? undefined : Math.max(0, Math.min(100, percent));
  return <div className="service-status-resource"><div><span>{label}</span><strong>{value}</strong></div><div className="service-status-meter" role={bounded === undefined ? undefined : 'meter'} aria-label={bounded === undefined ? undefined : label} aria-valuemin={bounded === undefined ? undefined : 0} aria-valuemax={bounded === undefined ? undefined : 100} aria-valuenow={bounded} aria-valuetext={bounded === undefined ? undefined : value} data-tone={percent !== null && percent >= 90 ? 'warning' : undefined}><span style={{ width: `${bounded ?? 0}%` }}/></div></div>;
}

export function ServiceStatusPopover({ language, label, state, profile, process, processUnverified = false, online, loaded, metric, metricUpdatedAt = 0, metricsUnavailable = false, connecting = false, activity, actions, actionsDisabled, onRefresh, onNavigate }: Props) {
  const zh = language === 'zh-CN', text = (cn: string, en: string) => zh ? cn : en;
  const uid = useId();
  const anchor = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [refreshing, setRefreshing] = useState(false), [refreshError, setRefreshError] = useState('');
  const [position, setPosition] = useState<CSSProperties>({});
  const [history, setHistory] = useState<TelemetryHistory>({ identity: '', points: [] });
  const identity = `${profile?.id ?? ''}|${profile?.baseUrl ?? ''}|${process?.pid ?? ''}|${process?.creationTime ?? process?.startedAt ?? ''}`;
  const stopped = !processUnverified && process?.running === false && !connecting;
  const liveMetrics = !!profile && !processUnverified && online && !stopped && !metricsUnavailable && !!metric;
  const points = history.identity === identity ? history.points : [];
  useEffect(() => {
    if (!profile) { setHistory({ identity, points: [] }); return; }
    // A gap marks connection failures. A refresh never clears successful samples.
    setHistory(previous => appendTelemetry(previous, identity, telemetryPoint(liveMetrics ? metricUpdatedAt || Date.now() : Date.now(), liveMetrics ? metric : undefined, loaded)));
  }, [identity, liveMetrics, metric, metricUpdatedAt, loaded, profile?.id]);
  const close = (restoreFocus = false) => { setOpen(false); if (restoreFocus) anchor.current?.focus({ preventScroll: true }); };
  useEffect(() => { setOpen(false); setRefreshError(''); }, [profile?.id]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect(); if (!rect) return;
      const width = Math.min(408, innerWidth - 24);
      setPosition({ width, left: Math.max(12, Math.min(rect.right - width, innerWidth - width - 12)), top: rect.bottom + 10, maxHeight: Math.max(100, innerHeight - rect.bottom - 22) });
    };
    const outside = (event: PointerEvent) => { const target = event.target as Node; if (!anchor.current?.contains(target) && !panel.current?.contains(target)) close(); };
    const keys = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(true); } };
    const focus = (event: FocusEvent) => { const target = event.target as Node; if (!anchor.current?.contains(target) && !panel.current?.contains(target)) close(); };
    place(); panel.current?.focus({ preventScroll: true });
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', keys); document.addEventListener('focusin', focus); window.addEventListener('resize', place);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', keys); document.removeEventListener('focusin', focus); window.removeEventListener('resize', place); };
  }, [open]);
  const jump = (page: 'monitoring' | 'models' | 'tasks') => { close(); onNavigate(page); };
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true); setRefreshError('');
    try { await onRefresh(); } catch (error) { setRefreshError(String(error)); }
    finally { setRefreshing(false); }
  };
  const format = (value: unknown, digits = 0) => telemetryNumber(value) === null ? '–' : (value as number).toLocaleString(language, { maximumFractionDigits: digits });
  const memory = (used: number | null | undefined, total: number | null | undefined) => {
    const validUsed = liveMetrics ? telemetryNumber(used) : null, validTotal = liveMetrics ? telemetryNumber(total) : null;
    return { value: validUsed === null || !validTotal ? '–' : `${format(validUsed / 1024 ** 3, 1)} / ${format(validTotal / 1024 ** 3, 1)} GB`, percent: validUsed === null || !validTotal ? null : validUsed / validTotal * 100 };
  };
  const vram = memory(metric?.gpuMemoryUsed, metric?.gpuMemoryTotal), ram = memory(metric?.ramUsed, metric?.ramTotal);
  const reading = ['reading', 'prefill'].includes(metric?.state ?? '');
  const speedSeries = reading ? 'prefill' : 'decode';
  const speedTrend = reading ? text('输入速度趋势', 'Input speed trend') : text('生成速度趋势', 'Generation speed trend');
  const rawObject = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const live = rawObject(metric?.raw.live), engine = rawObject(metric?.raw.engine);
  const prompt = reading ? telemetryNumber(live.prompt_read) : telemetryNumber(live.prompt_tokens);
  const contextTotal = reading ? telemetryNumber(live.prompt_total) : telemetryNumber(engine.max_context);
  const recent = metric?.state === 'idle' ? metric.requests[0] : undefined;
  const contextUsed = recent ? telemetryNumber(recent.prompt_tokens) !== null && telemetryNumber(recent.output_tokens) !== null ? Number(recent.prompt_tokens) + Number(recent.output_tokens) : null : reading ? prompt : prompt === null ? null : prompt + (telemetryNumber(live.generated) ?? 0);
  const contextLabel = reading ? text('输入处理', 'Input progress') : recent ? text('最近请求上下文', 'Last request context') : text('上下文', 'Context');
  const modelState = !profile ? text('尚未选择', 'No model selected') : processUnverified ? text('状态待核验', 'State unverified') : connecting ? text('连接中', 'Connecting') : stopped ? text('未启动', 'Not started') : !online ? text('尚未核验', 'Unverified') : loaded === true ? text('已就绪', 'Ready') : loaded === false ? text('未加载', 'Not loaded') : text('未知', 'Unknown');
  const unloadedHint = activity || (loaded === false && online ? text('API 在线，模型未占用推理内存。点击加载即可使用。', 'API is online. Load the model to use it.') : undefined);
  return <>
    <button ref={anchor} type="button" className="st-pill service-status-trigger" id="pill" data-state={state} aria-label={text('服务状态与快捷操作', 'Service status and quick actions')} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? uid : undefined} data-tauri-drag-region="false" onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={() => setOpen(value => !value)}>
      <span className="st-pill__dot" aria-hidden="true"/><span id="pill-text" role="status" aria-live="polite">{label}</span><ChevronDown size={12} aria-hidden="true"/>
    </button>
    {open && createPortal(<div className="service-status-popover official-surface" ref={panel} id={uid} role="dialog" aria-modal="false" aria-labelledby={`${uid}-title`} tabIndex={-1} style={position} data-state={processUnverified ? 'unverified' : stopped ? 'stopped' : metricsUnavailable ? 'unavailable' : online ? metric?.state ?? state : 'disconnected'}>
      <header><div className="service-status-heading"><span>{text('服务状态', 'Service status')}</span><strong id={`${uid}-title`} className="service-status-model">{profile?.name ?? text('选择一个模型开始', 'Choose a model to start')}</strong></div><div className="service-status-header-actions"><button type="button" className="icon-button" aria-label={text('刷新状态', 'Refresh status')} disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={15} className={refreshing ? 'spin' : ''}/></button><button type="button" className="icon-button" aria-label={text('关闭快捷面板', 'Close quick panel')} onClick={() => close(true)}><X size={16}/></button></div></header>
      <div className="service-status-summary"><span className={`service-status-chip${!processUnverified && online && !stopped ? ' is-online' : ''}`}>{processUnverified ? text('服务状态待核验', 'Service state unverified') : online && !stopped ? text('API 在线', 'API online') : stopped ? text('未启动', 'Not started') : text('尚未连接', 'Disconnected')}</span><span className="service-status-model-state">{modelState}</span>{!processUnverified && process?.running && <span className="service-status-owner" title={process.pid ? `PID ${process.pid}` : undefined}>{process.owned ? text('受管', 'Managed') : text('外部服务', 'External service')}</span>}</div>
      {profile && <small className="service-status-endpoint" title={profile.baseUrl}>{profile.baseUrl}</small>}
      {profile && !processUnverified && online && !stopped ? <div className="service-status-monitor" data-paused={metricsUnavailable}>
        <div className="service-status-trends"><section><header><span>{speedTrend}</span><small>tok/s</small></header><Sparkline points={points} series={speedSeries} label={speedTrend} waiting={text('等待速度采样', 'Waiting for speed samples')}/></section><section><header><span>{text('GPU 负载趋势', 'GPU load trend')}</span><small>%</small></header><Sparkline points={points} series="gpu" label={text('GPU 负载趋势', 'GPU load trend')} waiting={text('等待 GPU 采样', 'Waiting for GPU samples')}/></section></div>
        <div className="service-status-resources"><ResourceMeter label={text('显存', 'VRAM')} {...vram}/><ResourceMeter label={text('内存', 'RAM')} {...ram}/></div>
        {liveMetrics && contextUsed !== null && contextTotal !== null && contextTotal > 0 && <ResourceMeter label={contextLabel} value={`${format(contextUsed)} / ${format(contextTotal)} tokens`} percent={contextUsed / contextTotal * 100}/>}
        <div className="service-status-telemetry-meta"><span>{text('近 3 分钟采样', 'Samples from the last 3 min')}</span><span role={metricsUnavailable ? 'status' : undefined}>{metricsUnavailable ? text('采集暂停 · 保留历史', 'Paused · history retained') : metricUpdatedAt ? new Date(metricUpdatedAt).toLocaleTimeString(language, {hour:'2-digit', minute:'2-digit', second:'2-digit'}) : text('等待监控', 'Waiting for metrics')}</span></div>
      </div> : <div className="service-status-empty">{!profile ? text('选择模型后查看实时负载', 'Select a model to view live load') : stopped ? text('启动服务后查看实时负载', 'Start the service to view live load') : text('连接服务后查看实时负载', 'Connect to view live load')}</div>}
      {unloadedHint && <p className="service-status-context">{unloadedHint}</p>}
      {refreshError && <p className="notice error" role="alert">{refreshError}</p>}
      {profile && <fieldset className="service-status-actions" disabled={actionsDisabled || processUnverified}>{actions}</fieldset>}
      <nav aria-label={text('快捷跳转', 'Quick navigation')}><button type="button" onClick={() => jump('monitoring')}><Activity size={15}/>{text('监控', 'Monitor')}</button><button type="button" onClick={() => jump('models')}><Settings2 size={15}/>{text('模型管理', 'Models')}</button><button type="button" onClick={() => jump('tasks')}><Terminal size={15}/>{text('任务与日志', 'Tasks & logs')}</button></nav>
    </div>, document.body)}
  </>;
}
