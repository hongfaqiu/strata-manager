import { useEffect, useRef, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, LoaderCircle, RefreshCw } from 'lucide-react';
import type { ApiAnalyticsClient, ApiAnalyticsCoverage, ApiAnalyticsQuery, ApiOutcome, ApiRoute, ApiUsageRequest, ApiUsageSummary, ApiUsageTrends } from '@strata-manager/core';
import { Empty, Panel } from '../components';
import { Segmented } from '../OfficialControls';
import { apiUsageStrings } from './ApiUsageStrings';
import './api-usage.css';

export interface ApiUsagePageProps {
  language: 'zh-CN' | 'en'; profileId?: string; desktop: boolean; onQuery: ApiAnalyticsClient;
}
type Period = 'today' | 'day' | 'week';
interface Snapshot { summary: ApiUsageSummary; trends: ApiUsageTrends; recent: ApiUsageRequest[]; coverage: ApiAnalyticsCoverage; fetchedAtMs: number }
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function ApiUsagePage({ language, profileId, desktop, onQuery }: ApiUsagePageProps) {
  const text = apiUsageStrings[language];
  const [period, setPeriod] = useState<Period>('today');
  const [refresh, setRefresh] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(desktop);
  const [error, setError] = useState('');
  const client = useRef(onQuery); client.current = onQuery;
  const previousScope = useRef('');

  useEffect(() => {
    let stopped = false, busy = false;
    const scope = `${desktop}:${profileId ?? ''}:${period}`;
    if (scope !== previousScope.current) setSnapshot(null);
    previousScope.current = scope;
    setError(''); setLoading(desktop);
    if (!desktop) return;
    const load = async () => {
      if (busy || stopped) return;
      busy = true; setLoading(true);
      const endMs = Date.now() + 1;
      const midnight = new Date(endMs); midnight.setHours(0, 0, 0, 0);
      const startMs = period === 'today' ? midnight.getTime() : endMs - (period === 'week' ? 7 : 1) * 86_400_000;
      const common: ApiAnalyticsQuery = { startMs, endMs, serviceId: profileId };
      try {
        const [summary, trends, recent] = await Promise.all([
          client.current({ ...common, action: 'summary' }),
          client.current({ ...common, action: 'trends', bucketMs: period === 'week' ? 86_400_000 : 3_600_000 }),
          client.current({ ...common, action: 'recent', limit: 50 }),
        ]);
        if (stopped) return;
        if (!isObject(summary.data) || !isObject(summary.data.http) || !isObject(summary.data.inference) || !isObject(trends.data) || !Array.isArray(trends.data.buckets) || !Array.isArray(recent.data)) throw new Error(language === 'zh-CN' ? '后台统计格式不匹配，请更新应用后台。' : 'The statistics format does not match. Update the app background process.');
        setSnapshot({ summary: summary.data as unknown as ApiUsageSummary, trends: trends.data as unknown as ApiUsageTrends, recent: recent.data as ApiUsageRequest[], coverage: summary.coverage, fetchedAtMs: Date.now() });
        setError('');
      } catch (failure) {
        if (!stopped) setError(failure instanceof Error ? failure.message : String(failure));
      } finally { busy = false; if (!stopped) setLoading(false); }
    };
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [desktop, profileId, period, refresh, language]);

  const number = (value: number | null | undefined, digits = 0) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(language, { maximumFractionDigits: digits }) : '—';
  const seconds = (value: number | null | undefined) => value == null ? '—' : `${number(value, 2)} ${text.seconds}`;
  const date = (value: number | null | undefined, timeOnly = false) => value == null ? '—' : new Date(value).toLocaleString(language, timeOnly ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const route = (value: ApiRoute) => ({ chat: 'Chat Completions', responses: 'Responses', anthropic: 'Anthropic Messages', token_count: text.tokenCount })[value];
  const outcome = (value: ApiOutcome) => ({ pending: text.pending, succeeded: text.succeeded, failed: text.failed, cancelled: text.cancelled, interrupted: text.interrupted })[value];
  const s = snapshot?.summary, coverage = snapshot?.coverage;
  const observerStatuses = coverage?.observerStatuses ?? [];
  const unsupported = observerStatuses.some(value => value.error === 'unsupported_runtime');
  const incomplete = observerStatuses.some(value => value.journalWriteFailed) || !!coverage?.gaps.length;
  const collecting = observerStatuses.some(value => value.observerActive && value.heartbeatFresh);
  const measured = collecting || !!coverage?.sessions.some(session => session.supported) || (s?.http.requests ?? 0) > 0;
  const count = (value: number | null | undefined) => measured ? number(value) : '—';
  const coverageLabel = unsupported ? text.unsupported : incomplete ? text.incomplete : collecting ? text.collecting : text.inactive;
  const gapReason = (reason: string) => ({ journal_retention: text.gapRetention, missing_sequence: text.gapSequence, invalid_metadata: text.gapInvalid })[reason] ?? text.unknown;
  const tile = (label: string, value: string, detail?: string) => <div className="api-usage-tile"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;

  return <div className="api-usage-page">
    <div className="api-usage-toolbar"><p>{text.intro}</p><div className="api-usage-toolbar-actions"><Segmented ariaLabel={text.period} value={period} options={[{ value: 'today', label: text.today }, { value: 'day', label: text.day }, { value: 'week', label: text.week }]} onValueChange={value => setPeriod(value as Period)}/><button type="button" disabled={!desktop || loading} onClick={() => setRefresh(value => value + 1)} aria-label={text.refresh}>{loading ? <LoaderCircle size={15} className="spin"/> : <RefreshCw size={15}/>}{text.refresh}</button></div></div>
    {!desktop ? <Empty title={text.title} hint={text.nativeRequired}/> : <>
      {error && <div className="notice error" role="alert">{snapshot && <p>{text.stale}</p>}{error}</div>}
      {!snapshot && loading && <div className="api-usage-loading" role="status"><LoaderCircle size={19} className="spin"/>{text.loading}</div>}
      {snapshot && s && <>
        <div className="api-usage-range"><span>{text.range}: {date(s.startMs)} — {date(s.endMs)}</span><span>{text.lastUpdate}: {date(snapshot.fetchedAtMs, true)}</span></div>
        {!measured && <p className="notice" role="status">{unsupported ? text.unsupported : text.noDataHint}</p>}
        <div className="api-usage-totals">
          {tile(text.requests, count(s.http.requests), `${text.pending} ${count(s.http.pending)} · ${text.runs} ${count(s.inference.runs)}`)}
          {tile(text.successRate, s.http.successRate == null ? '—' : `${number(s.http.successRate * 100, 1)}%`, `${text.failed} ${number(s.http.failed)} · ${text.cancelled} ${number(s.http.cancelled)} · ${text.interrupted} ${number(s.http.interrupted)}`)}
          {tile(text.input, number(s.http.inputTokens), `${text.tokenSamples}: ${number(s.http.inputTokenSamples)}`)}
          {tile(text.output, number(s.http.outputTokens), `${text.tokenSamples}: ${number(s.http.outputTokenSamples)}`)}
        </div>
        <div className="api-usage-notes"><p>{text.successHint}</p><p>{text.usageHint}</p></div>
        <div className="api-usage-two-column">
          <Panel title={text.trend} className="api-usage-panel"><UsageTrend trends={snapshot.trends} language={language} label={text.trend} noData={text.noRequests}/></Panel>
          <Panel title={text.latency} className="api-usage-panel"><div className="api-usage-latencies">
            {[{ title: text.ttft, distribution: s.ttftS, format: seconds }, { title: text.duration, distribution: s.durationS, format: seconds }, { title: text.speed, distribution: s.decodeTokS, format: (v: number | null) => v == null ? '—' : `${number(v, 1)} tok/s` }].map(item => <div key={item.title}><span>{item.title}</span><dl><div><dt>{text.p50}</dt><dd>{item.format(item.distribution.p50)}</dd></div><div><dt>{text.p95}</dt><dd>{item.format(item.distribution.p95)}</dd></div></dl><small>{text.samples}: {number(item.distribution.samples)}</small></div>)}
          </div><p className="api-usage-footnote">{text.missingValue}</p></Panel>
        </div>
        <div className="api-usage-workload">
          {tile(text.cached, count(s.http.cacheReadTokens))}{tile(text.runs, count(s.inference.runs))}{tile(text.tools, count(s.inference.toolCalls))}{tile(text.mcp, count(s.http.mcpToolCalls), `${text.mcpFailures}: ${count(s.http.mcpToolFailures)}`)}
        </div><p className="api-usage-footnote">{text.workHint}</p>
        <Panel title={text.sources} className="api-usage-panel"><div className="api-usage-table-scroll"><table><thead><tr><th>{text.route}</th><th>{text.client}</th><th>{text.requestsCount}</th><th>{text.succeeded}</th></tr></thead><tbody>{s.groups.map(group => <tr key={JSON.stringify([group.route, group.clientId])}><td>{route(group.route)}</td><td>{group.clientId == null ? text.unknownClient : group.clientId}</td><td>{number(group.requests)}</td><td>{number(group.succeeded)}</td></tr>)}</tbody></table></div>{!s.groups.length && <p className="api-usage-table-empty">{text.noRequests}</p>}<p className="api-usage-footnote">{text.sourceHint}</p></Panel>
        <Panel title={text.recent} className="api-usage-panel"><div className="api-usage-table-scroll"><table className="api-usage-recent"><thead><tr><th>{text.time}</th><th>{text.route}</th><th>{text.result}</th><th>{text.http}</th><th>{text.stream}</th><th>{text.input} / {text.output}</th><th>{text.ttft}</th><th>{text.duration}</th><th>{text.runs}</th></tr></thead><tbody>{snapshot.recent.map(request => <tr key={request.requestId} title={`${text.requestId}: ${request.requestId}`}><td>{date(request.startedAtMs)}</td><td>{route(request.route)}</td><td><span className={`api-usage-outcome ${request.outcome}`}>{outcome(request.outcome)}</span></td><td>{number(request.httpStatus)}</td><td>{request.stream == null ? '—' : request.stream ? text.yes : text.no}</td><td>{number(request.inputTokens)} / {number(request.outputTokens)}</td><td>{seconds(request.firstTokenS)}</td><td>{seconds(request.durationS)}</td><td>{number(request.inferenceRuns)}</td></tr>)}</tbody></table></div>{!snapshot.recent.length && <div className="api-usage-table-empty"><p>{text.noRequests}</p><small>{text.noRequestsHint}</small></div>}<p className="api-usage-footnote">{text.tokenCountHint}</p></Panel>
        {coverage && <Panel title={text.coverage} className="api-usage-panel"><div className={`api-usage-coverage-state ${unsupported || incomplete ? 'warning' : ''}`}>{unsupported || incomplete ? <AlertTriangle size={16}/> : collecting ? <CheckCircle2 size={16}/> : <Activity size={16}/>}<strong>{coverageLabel}</strong></div><p className="api-usage-footnote">{text.coverageHint}</p><p className="api-usage-footnote">{text.metadataHint}</p><div className="api-usage-coverage-facts"><div><span>{text.since}</span><strong>{date(coverage.dataAvailableFromMs)}</strong></div><div><span>{text.retention}</span><strong>{number(coverage.historyRetentionDays)} {text.days}</strong></div><div><span>{text.gaps}</span><strong>{number(coverage.gaps.length)}</strong></div></div>
          {!coverage.journalPresent && <p className="api-usage-footnote">{text.noDataHint}</p>}
          {!!coverage.gaps.length && <div className="api-usage-gaps" role="status">{coverage.gaps.map(gap => <div key={`${gap.firstSeq}-${gap.lastSeq}-${gap.reason}`}><span>{date(gap.observedAtMs)} · {gapReason(gap.reason)}</span><strong>{text.gapEvents}: {number(gap.lastSeq - gap.firstSeq + 1)}</strong></div>)}</div>}
          <p className="api-usage-footnote">{text.interruptedHint}</p><div className="api-usage-scope"><span>{text.scope}</span>{coverage.collectionScope.map(path => <code key={path}>{path}</code>)}</div>
        </Panel>}
      </>}
    </>}
  </div>;
}

function UsageTrend({ trends, language, label, noData }: { trends: ApiUsageTrends; language: 'zh-CN' | 'en'; label: string; noData: string }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(1, ...trends.buckets.map(value => value.requests));
  const total = trends.buckets.reduce((sum, value) => sum + value.requests, 0);
  const selected = hovered == null ? undefined : trends.buckets[hovered];
  const start = trends.buckets[0]?.startMs, last = trends.buckets.at(-1)?.startMs;
  const time = (value: number) => new Date(value).toLocaleString(language, trends.bucketMs >= 86_400_000 ? { month: '2-digit', day: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
  return <div className="api-usage-trend"><div className="api-usage-trend-label"><span>{selected ? time(selected.startMs) : label}</span><strong>{selected ? selected.requests.toLocaleString(language) : total.toLocaleString(language)}</strong></div>{total ? <div className="api-usage-bars" role="group" aria-label={label}>{trends.buckets.map((bucket, index) => <button type="button" key={bucket.startMs} className={hovered === index ? 'active' : ''} onPointerEnter={() => setHovered(index)} onPointerLeave={() => setHovered(null)} onFocus={() => setHovered(index)} onBlur={() => setHovered(null)} aria-label={`${time(bucket.startMs)}: ${bucket.requests.toLocaleString(language)}`}><span style={{ height: `${bucket.requests / max * 100}%` }}/></button>)}</div> : <div className="api-usage-chart-empty">{noData}</div>}<div className="api-usage-trend-axis"><span>{start == null ? '—' : time(start)}</span><span>{last == null ? '—' : time(last)}</span></div></div>;
}
