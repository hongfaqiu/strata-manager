/**
 * DEV-only Overview redesign drafts. Enable with ?overviewDraft=a|b|c (dev server only).
 * Default Overview is untouched; these reuse the same props and data.
 */
import { useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowRight, Boxes, Copy, MessageSquare, Plug, RefreshCw, Settings2 } from 'lucide-react';
import * as core from '@strata-manager/core';
import { normalizeBaseUrl, type ApiUsageSummary, type JsonObject } from '@strata-manager/core';
import { ApiIntegrationDialog } from '../ApiIntegrationDialog';
import type { OverviewPage } from './OverviewPage';
import { buildOverviewMock, overviewMockEnabled } from './overviewMockData';
import './overview-drafts.css';
import { VisualDraft } from './OverviewDraftsVisual';

export type OverviewDraftVariant = 'a' | 'b' | 'c' | 'd' | 'e' | 'f';
export function overviewDraftVariant(): OverviewDraftVariant | null {
  if (import.meta.env?.DEV !== true || typeof window === 'undefined') return null;
  const v = new URLSearchParams(window.location.search).get('overviewDraft');
  return v && /^[a-f]$/.test(v) ? v as OverviewDraftVariant : null;
}
type Props = ComponentProps<typeof OverviewPage>;
const obj = (v: unknown): JsonObject => v && typeof v === 'object' && !Array.isArray(v) ? v as JsonObject : {};
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;

function useTodayUsage(p: Props) {
  const mock = overviewMockEnabled();
  const q = useQuery({ queryKey: ['overview-api', p.profile?.id], enabled: !mock && p.desktop && !!p.profile, refetchInterval: 8000, queryFn: () => {
    const endMs = Date.now() + 1; const d = new Date(endMs); d.setHours(0, 0, 0, 0);
    return core.analyticsQuery<ApiUsageSummary>({ action: 'summary', serviceId: p.profile!.id, startMs: d.getTime(), endMs });
  } });
  const m = mock ? buildOverviewMock() : null;
  const summary = m?.usageSummary ?? q.data?.data;
  const coverage = m?.usageCoverage ?? q.data?.coverage;
  const available = mock || (!!coverage && (coverage.dataAvailableFromMs !== null || coverage.observerStatuses.some(s => s.supported && s.observerActive && s.heartbeatFresh)));
  return { summary: available ? summary : undefined, error: !mock && q.error ? String(q.error) : undefined };
}

function Spark({ values, height = 96, className = '' }: { values: (number | null)[]; height?: number; className?: string }) {
  const pts = values.map((v, i) => [i, v] as const).filter((x): x is readonly [number, number] => x[1] !== null);
  if (pts.length < 2) return <div className={`ovd-spark is-empty ${className}`} style={{ height }} />;
  const max = Math.max(...pts.map(p => p[1])) * 1.15, min = Math.min(...pts.map(p => p[1])) * 0.85, w = 100, n = values.length - 1 || 1;
  const xy = pts.map(([i, v]) => [i / n * w, height - (v - min) / (max - min || 1) * (height - 8) - 4]);
  const a0 = xy[0]!, z = xy[xy.length - 1]!;
  const line = xy.map((p, i) => `${i ? 'L' : 'M'}${p[0]!.toFixed(2)} ${p[1]!.toFixed(2)}`).join(' ');
  return <svg className={`ovd-spark ${className}`} viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ height }} aria-hidden="true">
    <path d={`${line} L${z[0]} ${height} L${a0[0]} ${height} Z`} className="ovd-spark-area" />
    <path d={line} className="ovd-spark-line" vectorEffect="non-scaling-stroke" />
    <circle cx={z[0]} cy={z[1]} r="2.2" className="ovd-spark-dot" />
  </svg>;
}
function Bar({ pct }: { pct: number | null }) { return <span className="ovd-bar" aria-hidden="true"><i style={{ '--p': `${pct ?? 0}%` } as CSSProperties} /></span>; }

export function OverviewDraft(p: Props & { variant: OverviewDraftVariant }) {
  const { t } = useTranslation();
  const zh = p.language === 'zh-CN';
  const L = (a: string, b: string) => zh ? a : b;
  const [apiOpen, setApiOpen] = useState(false);
  const usage = useTodayUsage(p);
  const usageOpen = () => p.onUsage ? p.onUsage() : p.onNavigate('requests');
  const { profile, health, metric, process: proc, tasks, online, connecting, desktop } = p;
  const f = (v: unknown, d = 1) => num(v) === null ? '–' : num(v)!.toLocaleString(p.language, { maximumFractionDigits: d });
  const gb = (v: unknown) => num(v) === null ? '–' : (num(v)! / 1024 ** 3).toLocaleString(p.language, { maximumFractionDigits: 1 });
  const pct = (u: unknown, tot: unknown) => num(u) !== null && num(tot) ? Math.min(100, Math.max(0, num(u)! / num(tot)! * 100)) : null;
  const engine = obj(metric?.raw.engine), live = obj(metric?.raw.live), last = metric?.requests[0];
  const capacity = num(engine.max_context) ?? num(health.max_context);
  const prompt = num(live.state === 'idle' ? last?.prompt_tokens : live.prompt_tokens), generated = num(live.state === 'idle' ? last?.output_tokens : live.generated);
  const ctxUsed = prompt !== null && generated !== null ? prompt + generated : null;
  let endpoint = '–'; if (profile) { try { endpoint = `${normalizeBaseUrl(profile.baseUrl)}/v1`; } catch { endpoint = profile.baseUrl; } }
  const running = tasks.filter(x => x.state === 'running');
  const model = String(health.model ?? engine.model ?? '–');
  const modelState = online && typeof health.loaded === 'boolean' ? t(health.loaded ? 'loaded' : 'notLoaded') : connecting ? t('loading') : '–';
  const statusText = desktop && proc?.running === false && !connecting ? L('未启动', 'Not started') : t(connecting ? 'connecting' : online ? 'online' : 'offline');
  const stateText = metric ? p.stateLabel(metric.state) : '–';
  const imageSupport = online && typeof health.images === 'boolean' ? health.images ? L('已启用', 'Enabled') : L('未启用', 'Not enabled') : t('unknown');
  const bg = p.backgroundHealth && proc?.running && proc.owned && p.backgroundHealth.profileId === profile?.id && p.backgroundHealth.pid === proc.pid ? p.backgroundHealth : undefined;
  const bgFresh = bg && bg.checkedAt > 0 && Date.now() - bg.checkedAt < 65_000 ? bg : undefined;
  const bgLabel = bgFresh ? t(`backgroundHealth_${bgFresh.phase}`) : L('当前进程未检查', 'Current process not checked');
  const recent = [...(metric?.requests ?? [])].filter(r => num(r.time) !== null).sort((a, b) => (a.time as number) - (b.time as number)).slice(-16);
  const speeds = recent.map(r => num(r.decode_tok_s));
  const speed = metric?.state === 'generating' ? metric.decodeTokS : num(recent.at(-1)?.decode_tok_s);
  const speedLabel = metric && metric.state !== 'generating' ? L('最近生成速度', 'Last generation speed') : L('生成速度', 'Generation speed');
  const finish = (x: unknown) => x === undefined ? '–' : t(({ stop: 'stoppedFinish', length: 'lengthFinish', cancelled: 'cancelledFinish', tool_calls: 'toolCallsFinish' } as Record<string, string>)[String(x)] ?? 'unknown');
  const time = (s: unknown) => num(s) !== null ? new Date(num(s)! * 1000).toLocaleTimeString(p.language, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '–';
  const u = usage.summary;
  const usageItems: [string, string, string?][] = [
    [L('HTTP 请求', 'HTTP requests'), f(u?.http.requests, 0)],
    [L('成功率', 'Success rate'), f(u?.http.successRate == null ? null : u.http.successRate * 100, 1), '%'],
    [L('输入 Token', 'Input tokens'), f(u?.http.inputTokens, 0)],
    [L('输出 Token', 'Output tokens'), f(u?.http.outputTokens, 0)],
  ];
  const resources: { k: string; v: ReactNode; pct?: number | null }[] = [
    { k: t('contextUsage'), v: <>{f(ctxUsed, 0)}<small> / {f(capacity, 0)}</small></>, pct: pct(ctxUsed, capacity) },
    { k: t('gpuMemory'), v: <>{gb(metric?.gpuMemoryUsed)}<small> / {gb(metric?.gpuMemoryTotal)} GB</small></>, pct: pct(metric?.gpuMemoryUsed, metric?.gpuMemoryTotal) },
    { k: t('ram'), v: <>{gb(metric?.ramUsed)}<small> / {gb(metric?.ramTotal)} GB</small></>, pct: pct(metric?.ramUsed, metric?.ramTotal) },
  ];
  const readouts: [string, string, string?][] = [
    [t('gpuUtil'), f(metric?.gpuUtil), '%'], [t('activeRequests'), f(metric?.running, 0)], [t('queued'), f(metric?.queued, 0)],
    [t('prefill'), f(metric?.prefillTokS, 0), 'tok/s'], [t('cpuUtil'), f(metric?.cpuUtil), '%'], [t('gpuTemperature'), f(metric?.gpuTemperature, 0), '°C'], [t('gpuPower'), f(metric?.gpuPower, 0), 'W'],
  ];
  const facts: { k: string; v: ReactNode; tip?: string }[] = [
    { k: t('status'), v: stateText },
    ...(profile?.managed && desktop ? [{ k: t('process'), v: proc ? t(proc.running ? 'running' : 'stopped') : '–', tip: proc?.pid ? `${t('pid')} ${proc.pid}` : undefined }] : []),
    { k: L('图像支持', 'Image support'), v: <>{imageSupport}{p.onImages && <button type="button" className="ovd-link" onClick={p.onImages}>{health.images === true && online ? L('设置', 'Settings') : L('启用', 'Enable')}</button>}</> },
    ...(desktop && proc?.owned && proc.running ? [{ k: L('后台检查', 'Background check'), v: bgLabel, tip: bgFresh?.reason }] : []),
  ];
  const link = (page: Parameters<Props['onNavigate']>[0], label: string) => <button type="button" className="ovd-link" onClick={() => p.onNavigate(page)}>{label}<ArrowRight size={13} aria-hidden="true" /></button>;
  const copyBtn = <button type="button" className="ovd-copy" onClick={() => p.onCopy(endpoint)} aria-label={L('复制 API 地址', 'Copy API address')} data-tooltip={L('复制 API 地址', 'Copy API address')}><Copy size={13} /><span>{L('复制', 'Copy')}</span></button>;
  const chatBtn = <button type="button" className="primary ovd-primary" onClick={p.onChat}><MessageSquare size={15} aria-hidden="true" />{t('openChat')}</button>;
  const secondary = [
    { icon: <Plug size={15} />, label: L('接入 API', 'Connect API'), on: () => setApiOpen(true) },
    { icon: <Activity size={15} />, label: t('openMonitor'), on: () => p.onNavigate('monitoring') },
    { icon: <Settings2 size={15} />, label: L('运行配置', 'Configuration'), on: () => p.onNavigate('config') },
    { icon: <Boxes size={15} />, label: L('模型管理', 'Manage models'), on: () => p.onNavigate('profiles') },
  ];
  const refresh = <button type="button" className="ovd-icon" onClick={p.onRefresh} aria-label={t('refresh')} data-tooltip={t('refresh')}><RefreshCw size={14} /></button>;
  const notices = <>{[p.healthError, p.processError, p.metricsError, p.taskError, usage.error].filter(Boolean).map((e, i) => <div key={i} className="notice error" role="alert">{e}</div>)}</>;
  const dot = <span className={`ovd-dot ${online ? metric?.state === 'generating' ? 'is-busy' : 'is-on' : 'is-off'}`} aria-hidden="true" />;
  const taskList = running.length ? <ul className="ovd-tasks">{running.map(x => <li key={x.id}><button type="button" onClick={() => p.onNavigate('tasks')}><strong>{t(x.kind.includes('setup') ? 'setupTask' : x.kind.includes('install') ? 'installTask' : x.kind.includes('update') ? 'updateTask' : 'task')}</strong><span>{x.message || p.stateLabel(x.state)}</span><time>{new Date(x.startedAt).toLocaleTimeString(p.language)}</time></button></li>)}</ul>
    : <p className="ovd-quiet">{t(!desktop ? 'nativeRequired' : p.tasksLoading ? 'loading' : p.taskError ? 'unavailable' : 'noRunningTasks')}</p>;
  const reqRows = [...recent].reverse().slice(0, 6);
  const reqTable = reqRows.length ? <div className="ovd-tablewrap"><table className="ovd-table"><thead><tr><th>{t('timestamp')}</th><th>{t('promptTokens')}</th><th>{t('outputTokens')}</th><th>{t('decode')}</th><th>{t('finishReason')}</th></tr></thead>
    <tbody>{reqRows.map((r, i) => <tr key={String(r.id ?? i)}><td>{time(r.time)}</td><td>{f(r.prompt_tokens, 0)}</td><td>{f(r.output_tokens, 0)}</td><td>{f(r.decode_tok_s)} <small>tok/s</small></td><td>{finish(r.finish)}</td></tr>)}</tbody></table></div>
    : <p className="ovd-quiet">{t(!metric ? 'noMetrics' : 'overviewRequestsEmpty')}</p>;
  const dialog = apiOpen && profile && <ApiIntegrationDialog profile={profile} model={typeof health.model === 'string' ? health.model : undefined} online={online} loaded={health.loaded === true} keyRequired={online && typeof health.api_key === 'boolean' ? health.api_key : undefined} language={p.language} onCopy={p.onCopy} onClose={() => setApiOpen(false)} />;
  const kv = (items: [string, string, string?][], cls = '') => <dl className={`ovd-kv ${cls}`}>{items.map(([k, v, unit]) => <div key={k}><dt>{k}</dt><dd>{v}{unit && <small>{unit}</small>}</dd></div>)}</dl>;
  const resourceRows = <div className="ovd-res">{resources.map(r => <div key={r.k}><span>{r.k}</span><Bar pct={r.pct ?? null} /><strong>{r.v}</strong><em>{r.pct == null ? '–' : `${Math.round(r.pct)}%`}</em></div>)}</div>;
  const factList = <dl className="ovd-facts">{facts.map(x => <div key={x.k} data-tooltip={x.tip}><dt>{x.k}</dt><dd>{x.v}</dd></div>)}</dl>;

  if (p.variant === 'd' || p.variant === 'e' || p.variant === 'f') return <VisualDraft variant={p.variant} x={{ L, zh, t, f, gb, pct, profile: profile!, model, modelState, statusText, stateText, endpoint, copyBtn, chatBtn, secondary, refresh, notices, dot, taskList, reqTable, factList, usageItems, readouts, resources, metric, controls: p.controls, link, usageOpen, recent, speed, speedLabel, finish, time, dialog, ctxUsed, capacity, online, kv, resourceRows, usage: u }} />;
  if (p.variant === 'a') return <div className="ovd ovd-a">
    <aside className="ovd-a-rail">
      <div className="ovd-a-id"><div className="ovd-a-badge">{dot}{statusText}</div><h2>{profile!.name}</h2><p className="ovd-a-model"><span>{t('model')}</span>{model}<em>{modelState}</em></p></div>
      <div className="ovd-endpoint"><code>{endpoint}</code>{copyBtn}</div>
      <div className="ovd-a-ctrl">{p.controls}</div>
      {factList}
      <nav className="ovd-a-nav" aria-label={t('quickActions')}>{chatBtn}{secondary.map(s => <button type="button" key={s.label} onClick={s.on}>{s.icon}<span>{s.label}</span><ArrowRight size={13} className="ovd-a-arrow" /></button>)}</nav>
      <div className="ovd-a-foot">{refresh}</div>
    </aside>
    <main className="ovd-a-main">
      {notices}
      <section className="ovd-a-focus">
        <header><span>{speedLabel}</span>{link('monitoring', t('openMonitor'))}</header>
        <div className="ovd-a-hero"><strong className="ovd-num">{f(speed)}</strong><small>tok/s</small>
          <div className="ovd-a-side">{kv(readouts.slice(0, 3))}</div></div>
        <Spark values={speeds} height={92} />
        <p className="ovd-a-caption">{L(`最近 ${recent.length} 次完成请求的生成速度`, `Decode speed of the last ${recent.length} completed requests`)}</p>
      </section>
      <section className="ovd-a-row">
        <div className="ovd-a-block"><header><h3>{t('resourcesSummary')}</h3></header>{resourceRows}{kv(readouts.slice(3), 'ovd-kv-inline')}</div>
        <div className="ovd-a-block"><header><h3>{L('今日 API 使用', "Today's API usage")}</h3><button type="button" className="ovd-link" onClick={usageOpen}>{L('统计详情', 'Usage details')}<ArrowRight size={13} /></button></header>{kv(usageItems, 'ovd-kv-grid')}</div>
      </section>
      <section className="ovd-a-row ovd-a-row-wide">
        <div className="ovd-a-block"><header><h3>{t('requestsRecent')}</h3>{link('requests', t('requests'))}</header>{reqTable}</div>
        <div className="ovd-a-block"><header><h3>{t('runningTasks')}</h3>{link('tasks', t('viewAllTasks'))}</header>{taskList}</div>
      </section>
    </main>{dialog}
  </div>;

  if (p.variant === 'b') {
    const maxOut = Math.max(1, ...recent.map(r => num(r.output_tokens) ?? 0));
    return <div className="ovd ovd-b">
      <header className="ovd-b-head">
        <p className="ovd-b-eyebrow">{dot}<span>{statusText}</span>{profile!.name !== model && <><span>·</span><span>{profile!.name}</span></>}{proc?.pid && <><span>·</span><span>PID {proc.pid}</span></>}</p>
        <h2>{zh ? <>{model}<br /><span>{metric?.state === 'generating' ? '正在生成，' : `${stateText}，`}最近 <b className="ovd-num">{f(speed)}</b> tok/s</span></> : <>{model}<br /><span>{stateText} · last <b className="ovd-num">{f(speed)}</b> tok/s</span></>}</h2>
        <div className="ovd-b-line"><div className="ovd-endpoint"><code>{endpoint}</code>{copyBtn}</div><span className="ovd-b-sep" /><span className="ovd-b-state">{modelState}</span><div className="ovd-b-ctrl">{p.controls}</div></div>
        <div className="ovd-b-actions">{chatBtn}{secondary.map(s => <button type="button" key={s.label} className="ovd-b-text" onClick={s.on}>{s.icon}{s.label}</button>)}{refresh}</div>
      </header>
      {notices}
      <section className="ovd-b-chart" aria-label={t('requestsRecent')}>
        <div className="ovd-b-sechead"><h3>{L('最近请求', 'Recent requests')}</h3><span className="ovd-quiet">{L('柱高为输出 Token，标注为生成速度', 'Bar height is output tokens; label is decode speed')}</span>{link('requests', t('requests'))}</div>
        <div className="ovd-b-bars">{recent.map((r, i) => <div key={String(r.id ?? i)} className={r.finish === 'length' ? 'is-cut' : ''} data-tooltip={`${time(r.time)} · ${f(r.prompt_tokens, 0)} → ${f(r.output_tokens, 0)} · ${finish(r.finish)}`}>
          <em>{f(r.decode_tok_s, 0)}</em><i style={{ height: `${(num(r.output_tokens) ?? 0) / maxOut * 100}%` }} /><span>{time(r.time).slice(0, 5)}</span></div>)}</div>
      </section>
      <section className="ovd-b-sec"><h3>{L('今日', 'Today')}</h3><div>{kv(usageItems, 'ovd-kv-row')}<button type="button" className="ovd-link" onClick={usageOpen}>{L('统计详情', 'Usage details')}<ArrowRight size={13} /></button></div></section>
      <section className="ovd-b-sec"><h3>{L('负载', 'Load')}</h3><div>{kv(readouts, 'ovd-kv-row')}</div></section>
      <section className="ovd-b-sec"><h3>{t('resourcesSummary')}</h3><div>{resourceRows}{link('monitoring', t('openMonitor'))}</div></section>
      <section className="ovd-b-sec"><h3>{t('service')}</h3><div>{factList}</div></section>
      <section className="ovd-b-sec"><h3>{t('runningTasks')}</h3><div>{taskList}{link('tasks', t('viewAllTasks'))}</div></section>
      <details className="ovd-b-sec ovd-b-details"><summary><h3>{t('requestsRecent')}</h3><span className="ovd-quiet">{L('展开明细', 'Show details')}</span></summary><div>{reqTable}</div></details>
      {dialog}
    </div>;
  }

  const maxTok = Math.max(1, ...recent.map(r => (num(r.prompt_tokens) ?? 0) + (num(r.output_tokens) ?? 0)));
  return <div className="ovd ovd-c">
    <header className="ovd-c-bar">
      <div className="ovd-c-id">{dot}<strong>{profile!.name}</strong><span className="ovd-c-tag">{statusText}</span></div>
      <div className="ovd-endpoint"><code>{endpoint}</code>{copyBtn}</div>
      <div className="ovd-c-ctrl">{p.controls}</div>
      <span className="ovd-c-grow" />
      {chatBtn}
      <div className="ovd-c-tools" role="group" aria-label={t('quickActions')}>{secondary.map(s => <button type="button" key={s.label} onClick={s.on} data-tooltip={s.label}>{s.icon}<span>{s.label}</span></button>)}{refresh}</div>
    </header>
    {notices}
    <div className="ovd-c-body">
      <main className="ovd-c-stream">
        <div className="ovd-c-streamhead">
          <div><span className="ovd-c-label">{speedLabel}</span><strong className="ovd-num">{f(speed)}<small>tok/s</small></strong></div>
          <Spark values={speeds} height={56} className="ovd-c-spark" />
          <div className="ovd-c-model"><span className="ovd-c-label">{t('model')}</span><b>{model}</b><em>{modelState}</em></div>
        </div>
        <div className="ovd-c-sub"><h3>{t('requestsRecent')}</h3><span className="ovd-c-legend"><i className="p" />{t('promptTokens')}<i className="o" />{t('outputTokens')}</span>{link('requests', t('requests'))}</div>
        <ol className="ovd-c-rows">{[...recent].reverse().slice(0, 9).map((r, i) => { const pr = num(r.prompt_tokens) ?? 0, out = num(r.output_tokens) ?? 0; return <li key={String(r.id ?? i)}>
          <time>{time(r.time)}</time><span className="ovd-c-track"><i className="p" style={{ width: `${pr / maxTok * 100}%` }} /><i className="o" style={{ width: `${out / maxTok * 100}%` }} /></span>
          <span className="ovd-c-tok">{f(pr, 0)} → {f(out, 0)}</span><span className="ovd-c-spd">{f(r.decode_tok_s)}<small> tok/s</small></span><span className={`ovd-c-fin${r.finish === 'length' ? ' is-warn' : ''}`}>{finish(r.finish)}</span></li>; })}
          {!recent.length && <li className="ovd-quiet">{t(!metric ? 'noMetrics' : 'overviewRequestsEmpty')}</li>}</ol>
        <section className="ovd-c-tasks"><div className="ovd-c-sub"><h3>{t('runningTasks')}</h3>{link('tasks', t('viewAllTasks'))}</div>{taskList}</section>
      </main>
      <aside className="ovd-c-side">
        <section><div className="ovd-c-sub"><h3>{L('实时', 'Live')}</h3>{link('monitoring', t('openMonitor'))}</div>{kv(readouts.slice(0, 4), 'ovd-kv-list')}</section>
        <section><div className="ovd-c-sub"><h3>{t('resourcesSummary')}</h3></div>{resourceRows}{kv(readouts.slice(4), 'ovd-kv-list')}</section>
        <section><div className="ovd-c-sub"><h3>{L('今日 API', 'Today’s API')}</h3><button type="button" className="ovd-link" onClick={usageOpen}>{L('详情', 'Details')}<ArrowRight size={13} /></button></div>{kv(usageItems, 'ovd-kv-list')}</section>
        <section><div className="ovd-c-sub"><h3>{t('service')}</h3></div>{factList}</section>
      </aside>
    </div>{dialog}
  </div>;
}
