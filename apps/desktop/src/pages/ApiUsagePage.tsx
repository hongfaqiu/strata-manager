import { useEffect, useRef, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Download, LoaderCircle, RefreshCw } from 'lucide-react';
import type { ApiAnalyticsClient, ApiAnalyticsCoverage, ApiAnalyticsQuery, ApiCsvExport, ApiOutcome, ApiRequestOptions, ApiRequestPage, ApiRoute, ApiTrendBucket, ApiUsageSummary, ApiUsageTrends } from '@strata-manager/core';
import { Empty, Panel } from '../components';
import { Dropdown, Segmented, type DropdownOption } from '../OfficialControls';
import { apiUsageStrings } from './ApiUsageStrings';
import './api-usage.css';

export interface ApiUsagePageProps {
  language: 'zh-CN' | 'en'; profileId?: string; desktop: boolean; onQuery: ApiAnalyticsClient;
  onOpenDiagnostics?: () => void;
}
type Period = 'today' | 'day' | 'week' | 'history';
interface Snapshot { summary: ApiUsageSummary; trends: ApiUsageTrends; coverage: ApiAnalyticsCoverage; fetchedAtMs: number }
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function periodRange(period: Period) {
  const endMs = Date.now() + 1;
  const midnight = new Date(endMs); midnight.setHours(0, 0, 0, 0);
  return { startMs: period === 'today' ? midnight.getTime() : endMs - (period === 'history' ? 90 : period === 'week' ? 7 : 1) * 86_400_000, endMs };
}

export function ApiUsagePage({ language, profileId, desktop, onQuery, onOpenDiagnostics }: ApiUsagePageProps) {
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
    const load = async (foreground = false) => {
      if (busy || stopped) return;
      busy = true;
      if (foreground) setLoading(true);
      const common: ApiAnalyticsQuery = { ...periodRange(period), serviceId: profileId };
      try {
        const [summary, trends] = await Promise.all([
          client.current({ ...common, action: 'summary' }),
          client.current({ ...common, action: 'trends', bucketMs: period === 'week' || period === 'history' ? 86_400_000 : 3_600_000 }),
        ]);
        if (stopped) return;
        if (!isObject(summary.data) || !isObject(summary.data.http) || !isObject(summary.data.inference) || !isObject(trends.data) || !Array.isArray(trends.data.buckets)) throw new Error(language === 'zh-CN' ? '后台统计格式不匹配，请更新应用后台。' : 'The statistics format does not match. Update the app background process.');
        setSnapshot({ summary: summary.data as unknown as ApiUsageSummary, trends: trends.data as unknown as ApiUsageTrends, coverage: summary.coverage, fetchedAtMs: Date.now() });
        setError('');
      } catch (failure) {
        if (!stopped) setError(failure instanceof Error ? failure.message : String(failure));
      } finally { busy = false; if (!stopped && foreground) setLoading(false); }
    };
    void load(true);
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [desktop, profileId, period, refresh, language]);

  const number = (value: number | null | undefined, digits = 0) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(language, { maximumFractionDigits: digits }) : '—';
  const seconds = (value: number | null | undefined) => value == null ? '—' : `${number(value, 2)} ${text.seconds}`;
  const speed = (value: number | null | undefined) => value == null ? '—' : `${number(value, 1)} tok/s`;
  const percentage = (value: number | null | undefined) => value == null ? '—' : `${number(value * 100, 1)}%`;
  const date = (value: number | null | undefined, timeOnly = false) => value == null ? '—' : new Date(value).toLocaleString(language, timeOnly ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const route = (value: ApiRoute) => ({ chat: 'Chat Completions', responses: 'Responses', anthropic: 'Anthropic Messages', token_count: text.tokenCount })[value];
  const s = snapshot?.summary, coverage = snapshot?.coverage;
  const observerStatuses = coverage?.observerStatuses ?? [];
  const unsupported = observerStatuses.some(value => value.error === 'unsupported_runtime');
  const incomplete = observerStatuses.some(value => value.journalWriteFailed) || !!coverage?.gaps.length || !!coverage?.journalSyncFailed;
  const collecting = observerStatuses.some(value => value.observerActive && value.heartbeatFresh);
  const measured = collecting || !!coverage?.sessions.some(session => session.supported) || (s?.http.requests ?? 0) > 0;
  const count = (value: number | null | undefined) => measured ? number(value) : '—';
  const coverageLabel = unsupported ? text.unsupported : incomplete ? text.incomplete : collecting ? text.collecting : text.inactive;
  const gapReason = (reason: string) => ({ journal_retention: text.gapRetention, missing_sequence: text.gapSequence, invalid_metadata: text.gapInvalid })[reason] ?? text.unknown;
  const tile = (label: string, value: string, detail?: string) => <div className="api-usage-tile"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;
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
    <div className="api-usage-toolbar"><p>{text.intro}</p><div className="api-usage-toolbar-actions"><Segmented ariaLabel={text.period} value={period} options={[{ value: 'today', label: text.today }, { value: 'day', label: text.day }, { value: 'week', label: text.week }, { value: 'history', label: text.history }]} onValueChange={value => setPeriod(value as Period)}/><button type="button" disabled={!desktop || loading} onClick={() => setRefresh(value => value + 1)} aria-label={text.refresh}>{loading ? <LoaderCircle size={15} className="spin"/> : <RefreshCw size={15}/>}{text.refresh}</button></div></div>
    {!desktop ? <Empty title={text.title} hint={text.nativeRequired}/> : <>
      {error && <div className="notice error" role="alert">{snapshot && <p>{text.stale}</p>}{error}</div>}
      {!snapshot && loading && <div className="api-usage-loading" role="status"><LoaderCircle size={19} className="spin"/>{text.loading}</div>}
      {snapshot && s && <>
        <div className="api-usage-range"><span>{text.range}: {date(s.startMs)} — {date(s.endMs)}</span><span>{text.lastUpdate}: {date(snapshot.fetchedAtMs, true)}</span>{coverage && !unsupported && !incomplete && <span>{collecting ? text.collectingShort : text.inactiveShort}</span>}</div>
        {(unsupported || incomplete) ? <p className="notice" role="status"><AlertTriangle size={16}/> {coverageLabel}</p> : !measured && <p className="notice" role="status">{text.noDataHint}</p>}
        <div className="api-usage-totals">
          {tile(text.requests, count(s.http.requests), `${text.pending} ${count(s.http.pending)} · ${text.runs} ${count(s.inference.runs)}`)}
          {tile(text.successRate, s.http.successRate == null ? '—' : `${number(s.http.successRate * 100, 1)}%`, `${text.failed} ${number(s.http.failed)} · ${text.cancelled} ${number(s.http.cancelled)} · ${text.interrupted} ${number(s.http.interrupted)}`)}
          {tile(text.input, number(s.http.inputTokens))}
          {tile(text.output, number(s.http.outputTokens))}
        </div>
        <div className="api-usage-charts" key={period}>
          <Panel title={text.trend} className="api-usage-panel"><UsageChart trends={snapshot.trends} language={language} title={text.trend} mode="stack" series={[{key:'succeeded',label:text.succeeded,color:'accent'},{key:'failed',label:text.failed,color:'danger'},{key:'cancelled',label:text.cancelled,color:'gold'},{key:'interrupted',label:text.interrupted,color:'violet'},{key:'pending',label:text.pending,color:'muted'}]}/></Panel>
          <Panel title={text.tokenTrend} className="api-usage-panel"><UsageChart trends={snapshot.trends} language={language} title={text.tokenTrend} series={[{key:'inputTokens',label:text.input,color:'blue',samples:'inputTokenSamples'},{key:'outputTokens',label:text.output,color:'accent',samples:'outputTokenSamples'}]}/></Panel>
          <Panel title={text.cacheTrend} className="api-usage-panel"><UsageChart trends={snapshot.trends} language={language} title={text.cacheTrend} percentage series={[{key:'cacheHitRate',label:text.cacheRate,color:'accent',samples:'cacheRateSamples'},{key:'expertCacheHitRate',label:text.expertCache,color:'blue',samples:'expertCacheSamples'}]}/></Panel>
          <Panel title={text.latencyTrend} className="api-usage-panel"><UsageChart trends={snapshot.trends} language={language} title={text.latencyTrend} unit={text.seconds} series={[{key:'firstTokenS',label:text.ttft,color:'blue',samples:'firstTokenSamples'},{key:'durationS',label:text.duration,color:'gold',samples:'durationSamples'}]}/></Panel>
          <Panel title={text.prefillTrend} className="api-usage-panel"><UsageChart trends={snapshot.trends} language={language} title={text.prefillTrend} unit="tok/s" series={[{key:'prefillTokS',label:text.prefill,color:'blue',samples:'prefillSamples'}]}/></Panel>
          <Panel title={text.decodeTrend} className="api-usage-panel"><UsageChart trends={snapshot.trends} language={language} title={text.decodeTrend} unit="tok/s" series={[{key:'decodeTokS',label:text.speed,color:'accent',samples:'decodeSamples'}]}/></Panel>
        </div>
          <Panel title={text.latency} className="api-usage-panel api-usage-latency-summary"><div className="api-usage-latencies">
            {distributions.map(item => <div key={item.title}><span>{item.title}</span><dl><div><dt>{text.p50}</dt><dd>{item.format(item.distribution.p50)}</dd></div><div><dt>{text.p95}</dt><dd>{item.format(item.distribution.p95)}</dd></div></dl></div>)}
          </div></Panel>
        <div className="api-usage-workload">
          {tile(text.expertCache, percentage(s.inference.expertCacheHitRate))}{tile(text.cacheRate, percentage(s.inference.cacheHitRate))}{tile(text.cached, count(s.inference.cacheReadTokens))}{tile(text.runs, count(s.inference.runs))}{tile(text.tools, count(s.inference.toolCalls))}{tile(text.mcp, count(s.http.mcpToolCalls))}
        </div>
        <Panel title={text.sources} className="api-usage-panel"><div className="api-usage-table-scroll"><table><thead><tr><th>{text.route}</th><th>{text.client}</th><th>{text.requestsCount}</th><th>{text.succeeded}</th></tr></thead><tbody>{s.groups.map(group => <tr key={JSON.stringify([group.route, group.clientId])}><td>{route(group.route)}</td><td>{group.clientId == null ? text.unknownClient : group.clientId}</td><td>{number(group.requests)}</td><td>{number(group.succeeded)}</td></tr>)}</tbody></table></div>{!s.groups.length && <p className="api-usage-table-empty">{text.noRequests}</p>}</Panel>
        <RequestHistory key={`${profileId ?? ''}:${period}`} language={language} profileId={profileId} period={period} onQuery={onQuery}/>
        <details className="api-usage-explanation"><summary>{text.statisticsNotes}</summary>
          <Panel title={text.definitions} className="api-usage-panel">
            {[text.persistence, text.successHint, text.usageHint, text.resultTrendHint, text.tokenTrendHint, text.cacheTrendHint, text.averageTrendHint, text.engineTrendHint, text.distributionHint, text.workHint, text.missingValue, text.sourceHint, text.tokenCountHint, `${text.historyFilterHint} ${text.customTimeHint}`, text.snapshotHint, text.exportHint, `${text.chartInteraction} ${text.chartMissingHint}`].map(note => <p className="api-usage-footnote" key={note}>{note}</p>)}
            <p className="api-usage-footnote">{text.mcpFailures}: {count(s.http.mcpToolFailures)}</p>
          </Panel>
          <Panel title={text.sampleTotals} className="api-usage-panel"><p className="api-usage-footnote">{text.sampleUnitHint}</p><div className="api-usage-table-scroll"><table><thead><tr><th>{text.metric}</th><th>{text.samples}</th></tr></thead><tbody>{sampleMetrics.map(metric => <tr key={metric.key}><td>{metric.label}</td><td>{number(metric.total)}</td></tr>)}</tbody></table></div></Panel>
          <Panel title={text.sampleIntervals} className="api-usage-panel"><div className="api-usage-table-scroll"><table><thead><tr><th>{text.chartBucket}</th>{sampleMetrics.map(metric => <th key={metric.key}>{metric.label}</th>)}</tr></thead><tbody>{snapshot.trends.buckets.map(bucket => <tr key={bucket.startMs}><td>{date(bucket.startMs)}</td>{sampleMetrics.map(metric => <td key={metric.key}>{number(bucketMetric(bucket, metric.key))}</td>)}</tr>)}</tbody></table></div></Panel>
          {coverage && <Panel title={text.coverage} className="api-usage-panel"><div className={`api-usage-coverage-state ${unsupported || incomplete ? 'warning' : ''}`}>{unsupported || incomplete ? <AlertTriangle size={16}/> : collecting ? <CheckCircle2 size={16}/> : <Activity size={16}/>}<strong>{coverageLabel}</strong></div><p className="api-usage-footnote">{text.coverageHint}</p><p className="api-usage-footnote">{text.metadataHint}</p><div className="api-usage-coverage-facts"><div><span>{text.since}</span><strong>{date(coverage.dataAvailableFromMs)}</strong></div><div><span>{text.retention}</span><strong>{number(coverage.historyRetentionDays)} {text.days}</strong></div><div><span>{text.gaps}</span><strong>{number(coverage.gaps.length)}</strong></div></div>
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
function RequestHistory({ language, profileId, period, onQuery }: { language: 'zh-CN' | 'en'; profileId?: string; period: Period; onQuery: ApiAnalyticsClient }) {
  const text = apiUsageStrings[language];
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
      <label><span>{text.filterFrom}</span><input aria-label={text.filterFrom} type="text" placeholder="YYYY-MM-DD HH:mm" title={text.timeFormat} value={draft.from} disabled={exporting} onChange={event => update('from', event.target.value)}/></label>
      <label><span>{text.filterTo}</span><input aria-label={text.filterTo} type="text" placeholder="YYYY-MM-DD HH:mm" title={text.timeFormat} value={draft.to} disabled={exporting} onChange={event => update('to', event.target.value)}/></label>
      <div className="api-request-filter-actions"><button type="submit" className="primary" disabled={loading || exporting}>{text.applyFilters}</button><button type="button" onClick={reset} disabled={loading || exporting}>{text.resetFilters}</button></div>
    </form>
    {labels?.truncated && <p className="api-usage-footnote">{text.optionsLimited}</p>}
    {error && <div className="notice error" role="alert"><strong>{text.historyFailed}</strong><p>{error}</p></div>}
    {exportMessage && <p className="notice" role="status">{exportMessage}</p>}
    <p className="api-usage-footnote api-request-range">{text.range}: {time(selection.startMs!)} — {time(selection.endMs!)}</p>
    {loading && <div className="api-request-loading" role="status"><LoaderCircle size={16} className="spin"/>{text.historyLoading}</div>}
    {!loading && page && <>
      <div className="api-usage-table-scroll" tabIndex={0} aria-label={text.requestHistory}><table className="api-usage-recent"><thead><tr><th>{text.time}</th><th>{text.model}</th><th>{text.client}</th><th>{text.route}</th><th>{text.result}</th><th>{text.http}</th><th>{text.stream}</th><th>{text.input} / {text.output}</th><th>{text.ttft}</th><th>{text.duration}</th><th>{text.cacheRate}</th><th>{text.expertCache}</th><th>{text.prefill}</th><th>{text.speed}</th><th>{text.runs}</th></tr></thead><tbody>{page.items.map(request => <tr key={request.requestId} title={`${text.requestId}: ${request.requestId}`}><td>{time(request.startedAtMs)}</td><td>{request.modelId ?? text.unknownModel}</td><td>{request.clientId ?? text.unknownClient}</td><td>{route(request.route)}</td><td><span className={`api-usage-outcome ${request.outcome}`}>{outcome(request.outcome)}</span></td><td>{number(request.httpStatus)}</td><td>{request.stream == null ? '—' : request.stream ? text.yes : text.no}</td><td>{number(request.inputTokens)} / {number(request.outputTokens)}</td><td>{seconds(request.firstTokenS)}</td><td>{seconds(request.durationS)}</td><td>{request.cacheHitRate == null ? '—' : `${number(request.cacheHitRate * 100, 1)}%`}</td><td>{request.expertCacheHitRate == null ? '—' : `${number(request.expertCacheHitRate * 100, 1)}%`}</td><td>{request.prefillTokS == null ? '—' : `${number(request.prefillTokS, 1)} tok/s`}</td><td>{request.decodeTokS == null ? '—' : `${number(request.decodeTokS, 1)} tok/s`}</td><td>{number(request.inferenceRuns)}</td></tr>)}</tbody></table></div>
      {!page.items.length && <div className="api-usage-table-empty"><p>{text.historyEmpty}</p><small>{text.noRequestsHint}</small></div>}
    </>}
    <div className="api-request-pagination"><span role="status">{text.page.replace('{{page}}', (pageIndex + 1).toLocaleString(language)).replace('{{count}}', (page?.items.length ?? 0).toLocaleString(language))}</span><div><button type="button" disabled={loading || exporting || !pageIndex} onClick={() => setPageIndex(previous => previous - 1)}><ChevronLeft size={15}/>{text.previousPage}</button><button type="button" disabled={loading || exporting || !page?.nextCursor} onClick={next}>{text.nextPage}<ChevronRight size={15}/></button><button type="button" disabled={loading || exporting || !page?.items.length} onClick={() => void exportCsv()}>{exporting ? <LoaderCircle size={14} className="spin"/> : <Download size={14}/>} {exporting ? text.exporting : text.exportCsv}</button></div></div>
  </Panel>;
}

type ChartColor = 'accent' | 'blue' | 'gold' | 'danger' | 'violet' | 'muted';
interface ChartSeries { key: keyof ApiTrendBucket; label: string; color: ChartColor; samples?: keyof ApiTrendBucket }
const knownMetric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const bucketMetric = (bucket: ApiTrendBucket, key: keyof ApiTrendBucket) => { const value = bucket[key]; return knownMetric(value) ? value : null; };

function UsageChart({ trends, language, title, series, mode = 'line', percentage = false, unit = '' }: {
  trends: ApiUsageTrends; language: 'zh-CN' | 'en'; title: string; series: ChartSeries[];
  mode?: 'line' | 'stack'; percentage?: boolean; unit?: string;
}) {
  const text = apiUsageStrings[language];
  const [inspected, setInspected] = useState<number | null>(null);
  const buckets = trends.buckets;
  const daily = trends.bucketMs >= 86_400_000;
  const time = (value: number) => new Date(value).toLocaleString(language, daily ? { month: '2-digit', day: '2-digit' } : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const format = (value: unknown) => !knownMetric(value) ? '—' : percentage ? `${(value * 100).toLocaleString(language, { maximumFractionDigits: 1 })}%` : `${value.toLocaleString(language, { maximumFractionDigits: unit ? 1 : 0 })}${unit ? ` ${unit}` : ''}`;
  const sum = (bucket: ApiTrendBucket) => series.reduce((total, item) => total + (bucketMetric(bucket, item.key) ?? 0), 0);
  const hasData = mode === 'stack' ? buckets.some(bucket => sum(bucket) > 0) : buckets.some(bucket => series.some(item => knownMetric(bucket[item.key])));
  const fallback = buckets.reduce((last, bucket, index) => (mode === 'stack' ? sum(bucket) > 0 : series.some(item => knownMetric(bucket[item.key]))) ? index : last, -1);
  const selectedIndex = inspected === null ? fallback : Math.min(buckets.length - 1, inspected);
  const selected = buckets[selectedIndex];
  const rawMax = mode === 'stack' ? Math.max(1, ...buckets.map(sum)) : Math.max(1, ...buckets.flatMap(bucket => series.map(item => bucketMetric(bucket, item.key) ?? 0)));
  const magnitude = 10 ** Math.floor(Math.log10(rawMax));
  const maximum = percentage ? 1 : Math.ceil(rawMax / magnitude) * magnitude;
  const left = 48, top = 14, width = 536, height = 154, bottom = top + height;
  const x = (index: number) => left + (index + 0.5) / Math.max(1, buckets.length) * width;
  const y = (value: number) => bottom - Math.min(maximum, value) / maximum * height;
  const axis = (value: number) => percentage ? `${Math.round(value * 100)}%` : value.toLocaleString(language, { notation: 'compact', maximumFractionDigits: 1 });
  const path = (key: keyof ApiTrendBucket) => {
    let drawing = false, result = '';
    buckets.forEach((bucket, index) => {
      const value = bucket[key];
      if (!knownMetric(value)) { drawing = false; return; }
      result += `${drawing ? 'L' : 'M'}${x(index).toFixed(2)},${y(value).toFixed(2)} `;
      drawing = true;
    });
    return result;
  };
  const inspect = (clientX: number, element: HTMLElement) => {
    const bounds = element.getBoundingClientRect();
    const position = ((clientX - bounds.left) / bounds.width * 600 - left) / width;
    setInspected(Math.max(0, Math.min(buckets.length - 1, Math.floor(position * buckets.length))));
  };
  const description = selected ? `${title}; ${time(selected.startMs)}; ${series.map(item => `${item.label}: ${format(selected[item.key])}${item.samples ? ` (${text.samples}: ${bucketMetric(selected, item.samples)?.toLocaleString(language) ?? '—'})` : ''}`).join('; ')}` : `${title}; ${text.chartNoSamples}`;

  return <div className="api-metric-chart">
    <div className="api-metric-chart-meta"><span>{daily ? text.chartDaily : text.chartHourly}</span><span>{selected ? `${text.chartBucket}: ${time(selected.startMs)}` : text.chartNoSamples}</span></div>
    {hasData ? <div className="api-metric-chart-interaction" tabIndex={0} role="group" aria-label={description} onPointerMove={event => inspect(event.clientX, event.currentTarget)} onClick={event => inspect(event.clientX, event.currentTarget)} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = selectedIndex < 0 ? 0 : selectedIndex;
      setInspected(event.key === 'Home' ? 0 : event.key === 'End' ? buckets.length - 1 : Math.max(0, Math.min(buckets.length - 1, current + (event.key === 'ArrowLeft' ? -1 : 1))));
    }}>
      <svg viewBox="0 0 600 194" role="img" aria-label={description}>
        {[0, 0.25, 0.5, 0.75, 1].map(fraction => <g key={fraction} className="api-metric-grid"><line x1={left} x2={left + width} y1={y(maximum * fraction)} y2={y(maximum * fraction)}/><text x={left - 8} y={y(maximum * fraction) + 4} textAnchor="end">{axis(maximum * fraction)}</text></g>)}
        {mode === 'stack' ? buckets.map((bucket, index) => {
          let offset = 0;
          const barWidth = Math.max(1, width / buckets.length * 0.62);
          return <g key={bucket.startMs}>{series.map(item => {
            const value = bucketMetric(bucket, item.key) ?? 0;
            const start = offset; offset += value;
            return value > 0 ? <rect key={item.key} className={`api-chart-color-${item.color}`} x={x(index) - barWidth / 2} y={y(offset)} width={barWidth} height={Math.max(0, y(start) - y(offset))}/> : null;
          })}</g>;
        }) : series.map(item => <g key={item.key} className={`api-chart-color-${item.color}`}><path className="api-metric-line" d={path(item.key)}/>{buckets.map((bucket, index) => { const value = bucketMetric(bucket, item.key); return value === null ? null : <circle key={bucket.startMs} cx={x(index)} cy={y(value)} r={index === selectedIndex ? 4 : 2.3}/>; })}</g>)}
        {selected && <line className="api-metric-cursor" x1={x(selectedIndex)} x2={x(selectedIndex)} y1={top} y2={bottom}/>}
      </svg>
    </div> : <div className="api-usage-chart-empty">{mode === 'stack' ? text.noRequests : text.chartNoSamples}</div>}
    <div className="api-usage-trend-axis"><span>{buckets[0] ? time(buckets[0].startMs) : '—'}</span><span>{buckets.at(-1) ? time(buckets.at(-1)!.startMs) : '—'}</span></div>
    <div className="api-metric-legend">{series.map(item => <div key={item.key}><span className={`api-metric-key api-chart-color-${item.color}`}/><span>{item.label}</span><strong>{selected ? format(selected[item.key]) : '—'}</strong></div>)}</div>
    {mode === 'stack' && <div className="api-metric-total">{text.chartTotal}: {buckets.reduce((total, bucket) => total + bucket.requests, 0).toLocaleString(language)}</div>}
  </div>;
}
