import { OBSERVER_MODE_LABELS, type AppLanguage } from "@strata-manager/core";
import { useEffect, useRef, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Download, LoaderCircle, RefreshCw } from 'lucide-react';
import type { ApiAnalyticsClient, ApiAnalyticsCoverage, ApiAnalyticsQuery, ApiCsvExport, ApiOutcome, ApiRequestOptions, ApiRequestPage, ApiRoute, ApiTrendBucket, ApiUsageSummary, ApiUsageTrends, JsonObject } from '@strata-manager/core';
import { Empty, Panel } from '../components';
import { Dropdown, type DropdownOption } from '../OfficialControls';
import { apiUsageStrings } from './ApiUsageStrings';
import { UsageChart, UsageSparkline, bucketMetric, type ChartColor } from './ApiUsageCharts';
import { ApiUsageLive } from './ApiUsageLive';
import './api-usage.css';

export interface ApiUsagePageProps {
  language: AppLanguage; profileId?: string; desktop: boolean; onQuery: ApiAnalyticsClient;
  onOpenDiagnostics?: () => void;
  profileName?: string;
  live?: { raw?: JsonObject; sampledAt?: number; stale?: boolean; stopped?: boolean };
}
type Period = 'hour' | 'today' | 'day' | 'threeDays' | 'week' | 'history';
const periodBuckets: Record<Period, number> = { hour: 60_000, today: 900_000, day: 900_000, threeDays: 3_600_000, week: 10_800_000, history: 86_400_000 };
interface Snapshot { summary: ApiUsageSummary; trends: ApiUsageTrends; coverage: ApiAnalyticsCoverage; fetchedAtMs: number }
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function periodRange(period: Period) {
  const endMs = Date.now() + 1;
  const midnight = new Date(endMs); midnight.setHours(0, 0, 0, 0);
  return { startMs: period === 'today' ? midnight.getTime() : endMs - (period === 'hour' ? 3_600_000 : (period === 'history' ? 90 : period === 'week' ? 7 : period === 'threeDays' ? 3 : 1) * 86_400_000), endMs };
}

export function ApiUsagePage({ language, profileId, profileName, desktop, onQuery, onOpenDiagnostics, live }: ApiUsagePageProps) {
  const text = apiUsageStrings[(language === 'zh-CN' ? 'zh-CN' : 'en')];
  const [period, setPeriod] = useState<Period>('today');
  const [refresh, setRefresh] = useState(0);
  const [refreshSeconds, setRefreshSeconds] = useState(5);
  const [inspectedAt, setInspectedAt] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(desktop);
  const [error, setError] = useState('');
  const client = useRef(onQuery); client.current = onQuery;
  const previousScope = useRef('');
  const pollingLoad = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    let stopped = false, busy = false;
    const scope = `${desktop}:${profileId ?? ''}:${period}`;
    if (scope !== previousScope.current) { setSnapshot(null); setInspectedAt(null); }
    previousScope.current = scope;
    setError(''); setLoading(desktop);
    if (!desktop) return;
    const load = async (foreground = false) => {
      if (busy || stopped) return;
      busy = true;
      if (foreground) setLoading(true);
      const common: ApiAnalyticsQuery = { ...periodRange(period), serviceId: profileId };
      try {
        const [summary, trends] = await Promise.all([
          client.current({ ...common, action: 'summary' }),
          client.current({ ...common, action: 'trends', bucketMs: periodBuckets[period] }),
        ]);
        if (stopped) return;
        if (!isObject(summary.data) || !isObject(summary.data.http) || !isObject(summary.data.inference) || !isObject(trends.data) || !Array.isArray(trends.data.buckets)) throw new Error(language === 'zh-CN' ? '后台统计格式不匹配，请更新应用后台。' : 'The statistics format does not match. Update the app background process.');
        setSnapshot({ summary: summary.data as unknown as ApiUsageSummary, trends: trends.data as unknown as ApiUsageTrends, coverage: summary.coverage, fetchedAtMs: Date.now() });
        setError('');
      } catch (failure) {
        if (!stopped) setError(failure instanceof Error ? failure.message : String(failure));
      } finally { busy = false; if (!stopped && foreground) setLoading(false); }
    };
    pollingLoad.current = () => load();
    void load(true);
    return () => { stopped = true; pollingLoad.current = null; };
  }, [desktop, profileId, period, refresh, language]);

  useEffect(() => {
    if (!desktop || refreshSeconds === 0) return;
    const timer = window.setInterval(() => { if (!document.hidden) void pollingLoad.current?.(); }, refreshSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [desktop, refreshSeconds]);

  const number = (value: number | null | undefined, digits = 0) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(language, { maximumFractionDigits: digits }) : '—';
  const seconds = (value: number | null | undefined) => value == null ? '—' : `${number(value, 2)} ${text.seconds}`;
  const speed = (value: number | null | undefined) => value == null ? '—' : `${number(value, 1)} tok/s`;
  const percentage = (value: number | null | undefined) => value == null ? '—' : `${number(value * 100, 1)}%`;
  const date = (value: number | null | undefined, timeOnly = false) => value == null ? '—' : new Date(value).toLocaleString(language, timeOnly ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const route = (value: ApiRoute) => ({ chat: 'Chat Completions', responses: 'Responses', anthropic: 'Anthropic Messages', token_count: text.tokenCount })[value];
  const s = snapshot?.summary, coverage = snapshot?.coverage;
  const observerStatuses = coverage?.observerStatuses ?? [];
  const unsupported = observerStatuses.some(value => value.error === 'unsupported_runtime');
  const observerMode = observerStatuses.find(value => value.observerMode && value.observerMode !== 'reviewed')?.observerMode;
  const incomplete = observerStatuses.some(value => value.journalWriteFailed) || !!coverage?.gaps.length || !!coverage?.journalSyncFailed;
  const collecting = observerStatuses.some(value => value.observerActive && value.heartbeatFresh);
  const measured = collecting || !!coverage?.sessions.some(session => session.supported) || (s?.http.requests ?? 0) > 0;
  const count = (value: number | null | undefined) => measured ? number(value) : '—';
  const compact = (value: number | null | undefined, digits = 2) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(language, { notation: 'compact', maximumFractionDigits: digits }) : '—';
  const coverageLabel = unsupported ? text.unsupported : incomplete ? text.incomplete : collecting ? text.collecting : text.inactive;
  const gapReason = (reason: string) => ({ journal_retention: text.gapRetention, missing_sequence: text.gapSequence, invalid_metadata: text.gapInvalid })[reason] ?? text.unknown;
  const tile = (label: string, value: string, detail?: string, values?: (number | null)[], color: ChartColor = 'accent') => <div className={`api-usage-tile api-usage-kpi-${color}`}><span>{label}</span><strong data-tooltip={value}>{value}</strong>{detail && <small>{detail}</small>}{values && <UsageSparkline values={values} color={color}/>}</div>;
  const buckets = snapshot?.trends.buckets ?? [];
  const cumulative = (key: keyof ApiTrendBucket) => {
    let total = 0;
    return buckets.map(bucket => { const value = bucketMetric(bucket, key); if (value === null) return null; total += value; return total; });
  };
  const chartScope = snapshot && s ? { range: { startMs: s.startMs, endMs: s.endMs }, inspectedAt, onInspect: setInspectedAt } : {};
  const meanSpeed = s?.decodeTokS.mean ?? (() => { const samples = buckets.reduce((total, bucket) => total + (bucket.decodeTokS == null ? 0 : bucket.decodeSamples), 0); return samples ? buckets.reduce((total, bucket) => total + (bucket.decodeTokS ?? 0) * bucket.decodeSamples, 0) / samples : null; })();
  const distributions = s ? [{ title: text.ttft, distribution: s.ttftS, format: seconds }, { title: text.duration, distribution: s.durationS, format: seconds }, { title: text.prefill, distribution: s.prefillTokS ?? { samples: 0, p50: null, p95: null }, format: speed }, { title: text.speed, distribution: s.decodeTokS, format: speed }] : [];
  const sampleMetrics: { label: string; total: number; key: keyof ApiTrendBucket }[] = s ? [
    { label: text.input, total: s.http.inputTokenSamples, key: 'inputTokenSamples' },
    { label: text.output, total: s.http.outputTokenSamples, key: 'outputTokenSamples' },
    { label: text.ttft, total: s.ttftS.samples, key: 'firstTokenSamples' },
    { label: text.duration, total: s.durationS.samples, key: 'durationSamples' },
    { label: text.prefill, total: s.prefillTokS?.samples ?? 0, key: 'prefillSamples' },
    { label: text.speed, total: s.decodeTokS.samples, key: 'decodeSamples' },
    { label: text.cacheRate, total: s.inference.cacheRateSamples, key: 'cacheRateSamples' },
    { label: text.expertCache, total: s.inference.expertCacheSamples, key: 'expertCacheSamples' },
  ] : [];

  return <div className="api-usage-page">
    <div className="api-usage-toolbar"><div className="api-usage-heading"><Activity size={18}/><strong>{text.dashboard}</strong><span>{profileName ?? (profileId ? profileId : text.allServices)}</span></div><div className="api-usage-toolbar-actions"><Dropdown ariaLabel={text.period} value={period} options={(['hour', 'today', 'day', 'threeDays', 'week', 'history'] as const).map(value => ({ value, label: text[value] }))} onValueChange={value => setPeriod(value as Period)}/><Dropdown ariaLabel={text.autoRefresh} value={String(refreshSeconds)} options={[5, 15, 30, 0].map(value => ({ value: String(value), label: value ? text.refreshEvery.replace('{{seconds}}', String(value)) : text.paused }))} onValueChange={value => setRefreshSeconds(Number(value))}/><button type="button" disabled={!desktop || loading} onClick={() => setRefresh(value => value + 1)} aria-label={text.refresh}>{loading ? <LoaderCircle size={15} className="spin"/> : <RefreshCw size={15}/>}{text.refresh}</button></div></div>
    {!desktop ? <Empty title={text.title} hint={text.nativeRequired}/> : <>
      {error && <div className="notice error" role="alert">{snapshot && <p>{text.stale}</p>}{error}</div>}
      {!snapshot && loading && <div className="api-usage-loading" role="status"><LoaderCircle size={19} className="spin"/>{text.loading}</div>}
      {snapshot && s && <>
        <div className="api-usage-range"><span>{date(s.startMs)} — {date(s.endMs)}</span><div><span>{text.lastUpdate}: {date(snapshot.fetchedAtMs, true)}</span>{coverage && !unsupported && !incomplete && <span className={`api-usage-collection ${collecting ? 'active' : ''}`}>{collecting ? text.collectingShort : text.inactiveShort}</span>}{refreshSeconds === 0 && <span>{text.paused}</span>}</div></div>
        {(unsupported || incomplete) ? <p className="notice" role="status"><AlertTriangle size={16}/> {coverageLabel}</p> : !measured && <p className="notice" role="status">{text.noDataHint}</p>}
        <div className="api-usage-totals">
          {tile(text.requests, measured ? compact(s.http.requests) : '—', `${text.pending} ${count(s.http.pending)}`, cumulative('requests'))}
          {tile(text.prefixCache, percentage(s.inference.cacheHitRate), `${text.expertCache} ${percentage(s.inference.expertCacheHitRate)}`, buckets.map(bucket => bucket.cacheHitRate))}
          {tile(text.output, compact(s.http.outputTokens), `${text.input} ${compact(s.http.inputTokens)}`, cumulative('outputTokens'), 'blue')}
          <div className="api-usage-tile api-usage-input-split"><span>{text.inferenceInput}</span><div><div><small>{text.recomputed}</small><strong data-tooltip={number(s.inference.prefillTokens)}>{compact(s.inference.prefillTokens, 1)}</strong></div><div><small>{text.reused}</small><strong data-tooltip={number(s.inference.cacheReadTokens)}>{compact(s.inference.cacheReadTokens, 1)}</strong></div></div><small>{text.runs} {count(s.inference.runs)}</small></div>
          <div className="api-usage-tile api-usage-speed-summary"><span>{text.speedDistribution}</span><div>{[{ label: text.mean, value: meanSpeed, color: 'accent' }, { label: text.p50, value: s.decodeTokS.p50, color: 'gold' }, { label: text.p20, value: s.decodeTokS.p20, color: 'blue' }].map(item => <div key={item.label} className={`api-usage-kpi-${item.color}`}><small>{item.label}</small><strong>{number(item.value, 2)}<em>tok/s</em></strong></div>)}</div><small>{text.speedSamples.replace('{{count}}', number(s.decodeTokS.samples))}</small><UsageSparkline values={buckets.map(bucket => bucket.decodeTokS)}/></div>
        </div>
        <div className="api-usage-reliability" aria-label={text.reliability}><strong>{text.successRate} <span>{percentage(s.http.successRate)}</span></strong><span>{text.succeeded} <b>{count(s.http.succeeded)}</b></span><span className={s.http.failed ? 'has-failures' : ''}>{text.failed} <b>{count(s.http.failed)}</b></span><span>{text.cancelled} <b>{count(s.http.cancelled)}</b></span><span className={s.http.interrupted ? 'has-failures' : ''}>{text.interrupted} <b>{count(s.http.interrupted)}</b></span><span>{text.runs} <b>{count(s.inference.runs)}</b></span></div>
        <div className="api-usage-charts" key={period}>
          <Panel title={`${text.requestRate} (${text.perMinute})`} className="api-usage-panel"><UsageChart {...chartScope} trends={snapshot.trends} language={language} title={text.requestRate} unit={text.perMinute} mode="stack" series={[{key:'succeeded',label:text.succeeded,color:'accent',scale:60000/snapshot.trends.bucketMs},{key:'failed',label:text.failed,color:'danger',scale:60000/snapshot.trends.bucketMs},{key:'cancelled',label:text.cancelled,color:'gold',scale:60000/snapshot.trends.bucketMs},{key:'interrupted',label:text.interrupted,color:'violet',scale:60000/snapshot.trends.bucketMs},{key:'pending',label:text.pending,color:'muted',scale:60000/snapshot.trends.bucketMs}]}/></Panel>
          <Panel title={text.decodeTrend} className="api-usage-panel"><UsageChart {...chartScope} trends={snapshot.trends} language={language} title={text.decodeTrend} unit="tok/s" series={[{key:'decodeTokS',label:text.speed,color:'accent',samples:'decodeSamples'}]}/></Panel>
          <Panel title={text.latencyTrend} className="api-usage-panel"><UsageChart {...chartScope} trends={snapshot.trends} language={language} title={text.latencyTrend} unit={text.seconds} series={[{key:'firstTokenS',label:text.ttft,color:'blue',samples:'firstTokenSamples'},{key:'durationS',label:text.duration,color:'gold',samples:'durationSamples'}]}/></Panel>
          <Panel title={text.tokenTrend} className="api-usage-panel"><UsageChart {...chartScope} trends={snapshot.trends} language={language} title={text.tokenTrend} series={[{key:'inputTokens',label:text.input,color:'blue',samples:'inputTokenSamples'},{key:'outputTokens',label:text.output,color:'accent',samples:'outputTokenSamples'}]}/></Panel>
          <Panel title={text.cacheTrend} className="api-usage-panel"><UsageChart {...chartScope} trends={snapshot.trends} language={language} title={text.cacheTrend} percentage series={[{key:'cacheHitRate',label:text.cacheRate,color:'accent',samples:'cacheRateSamples'},{key:'expertCacheHitRate',label:text.expertCache,color:'blue',samples:'expertCacheSamples'}]}/></Panel>
          <Panel title={text.prefillTrend} className="api-usage-panel"><UsageChart {...chartScope} trends={snapshot.trends} language={language} title={text.prefillTrend} unit="tok/s" series={[{key:'prefillTokS',label:text.prefill,color:'blue',samples:'prefillSamples'}]}/></Panel>
        </div>
          <Panel title={text.latency} className="api-usage-panel api-usage-latency-summary"><div className="api-usage-latencies">
            {distributions.map(item => <div key={item.title}><span>{item.title}</span><dl><div><dt>{text.p50}</dt><dd>{item.format(item.distribution.p50)}</dd></div><div><dt>{text.p95}</dt><dd>{item.format(item.distribution.p95)}</dd></div></dl></div>)}
          </div></Panel>
        {live && <ApiUsageLive {...live} language={language} serviceId={profileId}/>}
        <details className="api-usage-explanation api-usage-sources"><summary>{text.sourceDetails}</summary><div className="api-usage-workload">
          {tile(text.tools, count(s.inference.toolCalls))}{tile(text.mcp, count(s.http.mcpToolCalls))}{tile(text.mcpFailures, count(s.http.mcpToolFailures))}
        </div>
        <Panel title={text.sources} className="api-usage-panel"><div className="api-usage-table-scroll"><table><thead><tr><th>{text.route}</th><th>{text.client}</th><th>{text.requestsCount}</th><th>{text.succeeded}</th></tr></thead><tbody>{s.groups.map(group => <tr key={JSON.stringify([group.route, group.clientId])}><td>{route(group.route)}</td><td>{group.clientId == null ? text.unknownClient : group.clientId}</td><td>{number(group.requests)}</td><td>{number(group.succeeded)}</td></tr>)}</tbody></table></div>{!s.groups.length && <p className="api-usage-table-empty">{text.noRequests}</p>}</Panel>
        </details>
        <details className="api-usage-explanation api-usage-history"><summary>{text.requestDetails}</summary><RequestHistory key={`${profileId ?? ''}:${period}`} language={language} profileId={profileId} period={period} onQuery={onQuery}/></details>
        <details className="api-usage-explanation"><summary>{text.statisticsNotes}</summary>
          <Panel title={text.definitions} className="api-usage-panel">
            {[text.persistence, text.successHint, text.usageHint, text.rateNotes, text.inputSplitNotes, text.distributionNotes, text.resultTrendHint, text.tokenTrendHint, text.cacheTrendHint, text.averageTrendHint, text.engineTrendHint, text.distributionHint, text.workHint, text.missingValue, text.sourceHint, text.tokenCountHint, `${text.historyFilterHint} ${text.customTimeHint}`, text.snapshotHint, text.exportHint, `${text.chartInteraction} ${text.chartMissingHint}`].map(note => <p className="api-usage-footnote" key={note}>{note}</p>)}
            <p className="api-usage-footnote">{text.mcpFailures}: {count(s.http.mcpToolFailures)}</p>
          </Panel>
          <Panel title={text.sampleTotals} className="api-usage-panel"><p className="api-usage-footnote">{text.sampleUnitHint}</p><div className="api-usage-table-scroll"><table><thead><tr><th>{text.metric}</th><th>{text.samples}</th></tr></thead><tbody>{sampleMetrics.map(metric => <tr key={metric.key}><td>{metric.label}</td><td>{number(metric.total)}</td></tr>)}</tbody></table></div></Panel>
          <Panel title={text.sampleIntervals} className="api-usage-panel"><div className="api-usage-table-scroll"><table><thead><tr><th>{text.chartBucket}</th>{sampleMetrics.map(metric => <th key={metric.key}>{metric.label}</th>)}</tr></thead><tbody>{snapshot.trends.buckets.map(bucket => <tr key={bucket.startMs}><td>{date(bucket.startMs)}</td>{sampleMetrics.map(metric => <td key={metric.key}>{number(bucketMetric(bucket, metric.key))}</td>)}</tr>)}</tbody></table></div></Panel>
          {coverage && <Panel title={text.coverage} className="api-usage-panel"><div className={`api-usage-coverage-state ${unsupported || incomplete ? 'warning' : ''}`}>{unsupported || incomplete ? <AlertTriangle size={16}/> : collecting ? <CheckCircle2 size={16}/> : <Activity size={16}/>}<strong>{coverageLabel}</strong></div>{observerMode && <p className="api-usage-footnote" data-observer-mode={observerMode}>{OBSERVER_MODE_LABELS[observerMode]}</p>}<p className="api-usage-footnote">{text.coverageHint}</p><p className="api-usage-footnote">{text.metadataHint}</p><div className="api-usage-coverage-facts"><div><span>{text.since}</span><strong>{date(coverage.dataAvailableFromMs)}</strong></div><div><span>{text.retention}</span><strong>{number(coverage.historyRetentionDays)} {text.days}</strong></div><div><span>{text.gaps}</span><strong>{number(coverage.gaps.length)}</strong></div></div>
            {!coverage.journalPresent && <p className="api-usage-footnote">{text.noDataHint}</p>}
            {!!coverage.gaps.length && <div className="api-usage-gaps" role="status">{coverage.gaps.map(gap => <div key={`${gap.firstSeq}-${gap.lastSeq}-${gap.reason}`}><span>{date(gap.observedAtMs)} · {gapReason(gap.reason)}</span><strong>{text.gapEvents}: {number(gap.lastSeq - gap.firstSeq + 1)}</strong></div>)}</div>}
            <p className="api-usage-footnote">{text.interruptedHint}</p><div className="api-usage-scope"><span>{text.scope}</span>{coverage.collectionScope.map(path => <code key={path}>{path}</code>)}</div>
          </Panel>}
        </details>
      </>}
    </>}
    {onOpenDiagnostics && <details className="api-usage-diagnostics"><summary>{text.diagnostics}</summary><p>{text.diagnosticsHint}</p><button type="button" onClick={onOpenDiagnostics}>{text.openDiagnostics}</button></details>}
  </div>;
}

interface RequestFilters {
  client: string | null; model: string | null; outcome: ApiOutcome | ''; sort: 'newest' | 'oldest'; from: string; to: string;
}
const initialFilters = (): RequestFilters => ({ client: '', model: '', outcome: '', sort: 'newest', from: '', to: '' });
function localTimestamp(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error('invalid local time');
  const [year, month, day, hours, minutes] = match.slice(1).map(Number);
  const date = new Date(year!, month! - 1, day, hours, minutes);
  if (date.getFullYear() !== year || date.getMonth() !== month! - 1 || date.getDate() !== day || date.getHours() !== hours || date.getMinutes() !== minutes) throw new Error('invalid local time');
  return date.getTime();
}

const allMetadataOption = '$strata:all';
const unknownMetadataOption = '$strata:unknown';
const encodeMetadataOption = (value: string | null) => value === null ? unknownMetadataOption : value === '' ? allMetadataOption : `$strata:value:${encodeURIComponent(value)}`;
const decodeMetadataOption = (value: string) => value === unknownMetadataOption ? null : value === allMetadataOption ? '' : decodeURIComponent(value.slice('$strata:value:'.length));
function MetadataFilter({ label, allLabel, unknownLabel, unknown, labels, value, onChange, disabled }: { label: string; allLabel: string; unknownLabel: string; unknown: boolean; labels: string[]; value: string | null; onChange: (value: string | null) => void; disabled: boolean }) {
  const options: DropdownOption[] = [{ value: allMetadataOption, label: allLabel }, ...(unknown ? [{ value: unknownMetadataOption, label: unknownLabel }] : []), ...labels.map(label => ({ value: encodeMetadataOption(label), label }))];
  return <label><span>{label}</span><Dropdown editable ariaLabel={label} placeholder={allLabel} value={encodeMetadataOption(value)} editableDisplayValue={value ?? unknownLabel} onInputChange={onChange} onValueChange={option => onChange(decodeMetadataOption(option))} disabled={disabled} options={options}/></label>;
}

/** Freeze the collection boundary and time range independently of live polling. */
function RequestHistory({ language, profileId, period, onQuery }: { language: AppLanguage; profileId?: string; period: Period; onQuery: ApiAnalyticsClient }) {
  const text = apiUsageStrings[(language === 'zh-CN' ? 'zh-CN' : 'en')];
  const [draft, setDraft] = useState<RequestFilters>(initialFilters);
  const [applied, setApplied] = useState<RequestFilters>(initialFilters);
  const [selection, setSelection] = useState<ApiAnalyticsQuery>(() => ({ ...periodRange(period), serviceId: profileId, sort: 'newest' }));
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [page, setPage] = useState<ApiRequestPage | null>(null);
  const [labels, setLabels] = useState<ApiRequestOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const snapshot = useRef<number | undefined>(undefined);
  const query = useRef(onQuery); query.current = onQuery;
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const currentCursor = cursors[pageIndex];

  useEffect(() => {
    let stopped = false;
    setLoading(true); setPage(null); setError(''); setExportMessage('');
    const load = async () => {
      try {
        const [requests, options] = await Promise.all([
          query.current({ ...selection, action: 'requests', limit: 50, cursor: currentCursor, snapshotRowId: snapshot.current }),
          query.current({ startMs: selection.startMs, endMs: selection.endMs, serviceId: profileId, action: 'request_options' }),
        ]);
        if (stopped) return;
        const data = requests.data;
        if (!isObject(data) || !Array.isArray(data.items) || !data.items.every(item => isObject(item) && typeof item.requestId === 'string' && typeof item.startedAtMs === 'number') || !(data.nextCursor === null || typeof data.nextCursor === 'string') || !Number.isSafeInteger(data.snapshotRowId) || typeof data.limit !== 'number') throw new Error(text.requestPageMismatch);
        snapshot.current = data.snapshotRowId as number;
        setPage(data as unknown as ApiRequestPage);
        if (isObject(options.data) && Array.isArray(options.data.clients) && options.data.clients.every(value => typeof value === 'string') && Array.isArray(options.data.models) && options.data.models.every(value => typeof value === 'string')) setLabels(options.data as unknown as ApiRequestOptions);
      } catch (cause) { if (!stopped) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (!stopped) setLoading(false); }
    };
    void load();
    return () => { stopped = true; };
  }, [selection, currentCursor, pageIndex, profileId, language]);

  const begin = (filters: RequestFilters) => {
    try {
      const preset = periodRange(period);
      const startMs = localTimestamp(filters.from) ?? preset.startMs, endMs = localTimestamp(filters.to) ?? preset.endMs;
      if (startMs < 0 || endMs <= startMs || endMs - startMs > 90 * 86_400_000) throw new Error('invalid range');
      snapshot.current = undefined; setCursors([undefined]); setPageIndex(0); setPage(null); setApplied(filters);
      setSelection({ startMs, endMs, serviceId: profileId, clientId: filters.client, modelId: filters.model, outcome: filters.outcome || undefined, sort: filters.sort });
    } catch { setError(text.invalidRange); }
  };
  const number = (value: number | null | undefined, digits = 0) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(language, { maximumFractionDigits: digits }) : '—';
  const seconds = (value: number | null | undefined) => value == null ? '—' : `${number(value, 2)} ${text.seconds}`;
  const time = (value: number) => new Date(value).toLocaleString(language, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const outcome = (value: ApiOutcome) => ({ pending: text.pending, succeeded: text.succeeded, failed: text.failed, cancelled: text.cancelled, interrupted: text.interrupted })[value];
  const route = (value: ApiRoute) => ({ chat: 'Chat Completions', responses: 'Responses', anthropic: 'Anthropic Messages', token_count: text.tokenCount })[value];
  const exportCsv = async () => {
    if (exporting || loading || snapshot.current === undefined) return;
    setExporting(true); setExportMessage(''); setError('');
    const scope = { ...selection, snapshotRowId: snapshot.current };
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const path = await save({ defaultPath: `strata-api-${new Date().toISOString().slice(0, 10)}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
      if (!path || !alive.current) return;
      const result = await query.current({ ...scope, action: 'export_csv', path });
      if (!isObject(result.data) || typeof result.data.rows !== 'number') throw new Error(text.requestPageMismatch);
      if (alive.current) setExportMessage(text.exportSaved.replace('{{rows}}', (result.data as unknown as ApiCsvExport).rows.toLocaleString(language)));
    } catch (cause) {
      if (alive.current) { const message = cause instanceof Error ? cause.message : String(cause); setError(message.includes('CSV export matches more than 5000') ? text.exportTooMany : message); }
    } finally { if (alive.current) setExporting(false); }
  };
  const update = <Key extends keyof RequestFilters>(key: Key, value: RequestFilters[Key]) => setDraft(previous => ({ ...previous, [key]: value }));
  const reset = () => { const next = initialFilters(); setDraft(next); begin(next); };
  const next = () => { if (!page?.nextCursor || loading || exporting) return; setCursors(previous => [...previous.slice(0, pageIndex + 1), page.nextCursor!]); setPageIndex(previous => previous + 1); };

  return <Panel title={text.requestHistory} className="api-usage-panel api-request-history" action={<button type="button" disabled={loading || exporting} onClick={() => begin(applied)}><RefreshCw size={14}/>{text.historyRefresh}</button>}>
    <form className="api-request-filters" onSubmit={event => { event.preventDefault(); begin(draft); }}>
      <MetadataFilter label={text.client} allLabel={text.allClients} unknownLabel={text.unknownClient} unknown={labels?.unknownClient ?? false} labels={labels?.clients ?? []} value={draft.client} onChange={value => update('client', value)} disabled={exporting}/>
      <MetadataFilter label={text.model} allLabel={text.allModels} unknownLabel={text.unknownModel} unknown={labels?.unknownModel ?? false} labels={labels?.models ?? []} value={draft.model} onChange={value => update('model', value)} disabled={exporting}/>
      <label><span>{text.result}</span><Dropdown ariaLabel={text.result} value={draft.outcome} onValueChange={value => update('outcome', value as ApiOutcome | '')} disabled={exporting} options={[{ value: '', label: text.allOutcomes }, ...(['pending', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const).map(value => ({ value, label: outcome(value) }))]}/></label>
      <label><span>{text.sort}</span><Dropdown ariaLabel={text.sort} value={draft.sort} onValueChange={value => update('sort', value as 'newest' | 'oldest')} disabled={exporting} options={[{ value: 'newest', label: text.newest }, { value: 'oldest', label: text.oldest }]}/></label>
      <label><span>{text.filterFrom}</span><input aria-label={text.filterFrom} type="text" placeholder="YYYY-MM-DD HH:mm" data-tooltip={text.timeFormat} value={draft.from} disabled={exporting} onChange={event => update('from', event.target.value)}/></label>
      <label><span>{text.filterTo}</span><input aria-label={text.filterTo} type="text" placeholder="YYYY-MM-DD HH:mm" data-tooltip={text.timeFormat} value={draft.to} disabled={exporting} onChange={event => update('to', event.target.value)}/></label>
      <div className="api-request-filter-actions"><button type="submit" className="primary" disabled={loading || exporting}>{text.applyFilters}</button><button type="button" onClick={reset} disabled={loading || exporting}>{text.resetFilters}</button></div>
    </form>
    {labels?.truncated && <p className="api-usage-footnote">{text.optionsLimited}</p>}
    {error && <div className="notice error" role="alert"><strong>{text.historyFailed}</strong><p>{error}</p></div>}
    {exportMessage && <p className="notice" role="status">{exportMessage}</p>}
    <p className="api-usage-footnote api-request-range">{text.range}: {time(selection.startMs!)} — {time(selection.endMs!)}</p>
    {loading && <div className="api-request-loading" role="status"><LoaderCircle size={16} className="spin"/>{text.historyLoading}</div>}
    {!loading && page && <>
      <div className="api-usage-table-scroll" tabIndex={0} aria-label={text.requestHistory}><table className="api-usage-recent"><thead><tr><th>{text.time}</th><th>{text.model}</th><th>{text.client}</th><th>{text.route}</th><th>{text.result}</th><th>{text.http}</th><th>{text.stream}</th><th>{text.input} / {text.output}</th><th>{text.ttft}</th><th>{text.duration}</th><th>{text.cacheRate}</th><th>{text.expertCache}</th><th>{text.prefill}</th><th>{text.speed}</th><th>{text.runs}</th></tr></thead><tbody>{page.items.map(request => <tr key={request.requestId} data-tooltip={`${text.requestId}: ${request.requestId}`}><td>{time(request.startedAtMs)}</td><td>{request.modelId ?? text.unknownModel}</td><td>{request.clientId ?? text.unknownClient}</td><td>{route(request.route)}</td><td><span className={`api-usage-outcome ${request.outcome}`}>{outcome(request.outcome)}</span></td><td>{number(request.httpStatus)}</td><td>{request.stream == null ? '—' : request.stream ? text.yes : text.no}</td><td>{number(request.inputTokens)} / {number(request.outputTokens)}</td><td>{seconds(request.firstTokenS)}</td><td>{seconds(request.durationS)}</td><td>{request.cacheHitRate == null ? '—' : `${number(request.cacheHitRate * 100, 1)}%`}</td><td>{request.expertCacheHitRate == null ? '—' : `${number(request.expertCacheHitRate * 100, 1)}%`}</td><td>{request.prefillTokS == null ? '—' : `${number(request.prefillTokS, 1)} tok/s`}</td><td>{request.decodeTokS == null ? '—' : `${number(request.decodeTokS, 1)} tok/s`}</td><td>{number(request.inferenceRuns)}</td></tr>)}</tbody></table></div>
      {!page.items.length && <div className="api-usage-table-empty"><p>{text.historyEmpty}</p><small>{text.noRequestsHint}</small></div>}
    </>}
    <div className="api-request-pagination"><span role="status">{text.page.replace('{{page}}', (pageIndex + 1).toLocaleString(language)).replace('{{count}}', (page?.items.length ?? 0).toLocaleString(language))}</span><div><button type="button" disabled={loading || exporting || !pageIndex} onClick={() => setPageIndex(previous => previous - 1)}><ChevronLeft size={15}/>{text.previousPage}</button><button type="button" disabled={loading || exporting || !page?.nextCursor} onClick={next}>{text.nextPage}<ChevronRight size={15}/></button><button type="button" disabled={loading || exporting || !page?.items.length} onClick={() => void exportCsv()}>{exporting ? <LoaderCircle size={14} className="spin"/> : <Download size={14}/>} {exporting ? text.exporting : text.exportCsv}</button></div></div>
  </Panel>;
}
