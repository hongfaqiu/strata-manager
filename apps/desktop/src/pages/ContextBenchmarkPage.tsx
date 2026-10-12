import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleHelp, Copy, Download, ImageDown, LoaderCircle, Play, Square } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { ContextBenchmarkOptions, ContextBenchmarkProgress, ContextBenchmarkReport, ContextBenchmarkSample, ServiceProfile } from '@strata-manager/core';
import { Badge, Dialog, Empty, Field, Header, Panel } from '../components';
import { Checkbox, Dropdown, NumberField, Toggle } from '../OfficialControls';
import { ContextBenchmarkCharts, contextTierLabel } from './ContextBenchmarkCharts';
import { useBenchmarkContext } from './useBenchmarkContext';
import { createContextBenchmarkImage } from './contextBenchmarkImage';

const STORE_KEY = 'contextBenchmarkReportsV1';
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const optionalNumber = (value: unknown) => value === null || finite(value);
function storedReport(value: unknown): value is ContextBenchmarkReport {
  if (!isObject(value) || value.schemaVersion !== 3 || typeof value.id !== 'string' || typeof value.model !== 'string'
    || typeof value.profileName !== 'string' || typeof value.baseUrl !== 'string' || !finite(value.startedAt) || !finite(value.finishedAt)
    || !isObject(value.options) || !Array.isArray(value.samples) || !Array.isArray(value.skippedTiers)
    || !['completed', 'failed', 'cancelled'].includes(String(value.state))) return false;
  try { core.validateContextBenchmarkOptions(value.options as unknown as ContextBenchmarkOptions); } catch { return false; }
  return value.samples.every(sample => isObject(sample) && finite(sample.index) && finite(sample.round) && finite(sample.targetTokens)
    && ['completed', 'failed', 'cancelled'].includes(String(sample.state)) && finite(sample.wallMs)
    && ['promptTokens', 'completionTokens', 'cachedTokens', 'prefillTokS', 'decodeTokS', 'peakGpuMemory', 'minGpuMemoryFree', 'peakRam', 'ttftMs'].every(key => optionalNumber(sample[key]))
    && ['count_tokens', 'estimated'].includes(String(sample.tokenCountMethod)) && typeof sample.output === 'string'
    && ['error', 'finishReason', 'calibrationReason'].every(key => sample[key] === undefined || typeof sample[key] === 'string'))
    && value.skippedTiers.every(tier => isObject(tier) && finite(tier.targetTokens) && typeof tier.reason === 'string');
}
function retain(reports: ContextBenchmarkReport[]) {
  const encoder = new TextEncoder(); let bytes = 0;
  return reports.slice(0, 20).filter((report, index) => { bytes += encoder.encode(JSON.stringify(report)).byteLength; return index === 0 || bytes <= 16 * 1024 * 1024; });
}
function download(name: string, body: string, type: string) {
  downloadBlob(name, new Blob([body], { type }));
}
function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function csv(report: ContextBenchmarkReport) {
  const cell = (value: unknown) => { let text = value == null ? '' : String(value); if (typeof value === 'string' && /^[=+\-@]/.test(text)) text = `\t${text}`; return `"${text.replaceAll('"', '""')}"`; };
  const columns = ['configuration', 'tier_tokens', 'round', 'state', 'actual_input_tokens', 'actual_output_tokens', 'prefill_tok_s', 'decode_tok_s', 'peak_gpu_memory_mib', 'min_gpu_free_mib', 'peak_ram_gib', 'wall_s', 'ttft_s', 'cached_tokens', 'token_count_method', 'counted_input_tokens', 'error'];
  const rows = report.samples.map(sample => [report.options.configurationLabel || report.profileName, sample.targetTokens, sample.round, sample.state,
    sample.promptTokens, sample.completionTokens, sample.prefillTokS, sample.decodeTokS, sample.peakGpuMemory === null ? null : sample.peakGpuMemory / 2 ** 20,
    sample.minGpuMemoryFree === null ? null : sample.minGpuMemoryFree / 2 ** 20, sample.peakRam === null ? null : sample.peakRam / 2 ** 30,
    sample.wallMs / 1000, sample.ttftMs === null ? null : sample.ttftMs / 1000, sample.cachedTokens, sample.tokenCountMethod, sample.countedPromptTokens, sample.error].map(cell).join(','));
  return `\uFEFF${[columns.join(','), ...rows].join('\r\n')}`;
}

export function ContextBenchmarkPage({ profile, online, disabled, language, onRunningChange }: {
  profile?: ServiceProfile; online: boolean; disabled: boolean; language: 'zh-CN' | 'en'; onRunningChange: (running: boolean) => void;
}) {
  const zh = language === 'zh-CN', text = (cn: string, en: string) => zh ? cn : en;
  const { maxContext, loading: contextLoading, error: contextError } = useBenchmarkContext(profile, online);
  const [options, setOptions] = useState<ContextBenchmarkOptions>(() => ({ ...core.DEFAULT_CONTEXT_BENCHMARK_OPTIONS, tiers: [] }));
  const [history, setHistory] = useState<ContextBenchmarkReport[]>([]), [selected, setSelected] = useState<ContextBenchmarkReport>();
  const [samples, setSamples] = useState<ContextBenchmarkSample[]>([]), [progress, setProgress] = useState<ContextBenchmarkProgress>();
  const [running, setRunning] = useState(false), [stopping, setStopping] = useState(false), [loaded, setLoaded] = useState(false), [helpOpen, setHelpOpen] = useState(false), [error, setError] = useState('');
  const [startedAt, setStartedAt] = useState(0), [elapsedMs, setElapsedMs] = useState(0);
  const [imageBusy, setImageBusy] = useState(false), [imageMessage, setImageMessage] = useState<{ text: string; error?: boolean }>();
  const charts = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null), mounted = useRef(false), historyRef = useRef(history); historyRef.current = history;
  const contextKey = `${profile?.id ?? ''}:${profile?.baseUrl ?? ''}:${maxContext ?? ''}`;
  const previousContextKey = useRef('');
  const availableTiers = useMemo(() => [...new Set([...core.CONTEXT_BENCHMARK_TIERS, ...(maxContext ? [maxContext] : [])])].sort((a, b) => a - b), [maxContext]);
  useEffect(() => {
    if (running || contextLoading || contextKey === previousContextKey.current) return;
    previousContextKey.current = contextKey;
    setOptions(old => ({ ...old, tiers: core.getContextBenchmarkTiers(maxContext).filter(tier => tier > old.maxTokens + core.CONTEXT_BENCHMARK_HEADROOM) }));
  }, [contextKey, maxContext, contextLoading, availableTiers, running]);
  useEffect(() => {
    mounted.current = true;
    void core.loadStore<unknown>(STORE_KEY, []).then(saved => {
      if (!mounted.current) return;
      const reports = retain(Array.isArray(saved) ? saved.filter(storedReport) : []);
      setHistory(reports); setSelected(reports[0]); setLoaded(true);
    }).catch(err => { if (mounted.current) { setError(core.normalizeError(err).message); setLoaded(true); } });
    return () => { mounted.current = false; controller.current?.abort(); onRunningChange(false); };
  }, [onRunningChange]);
  useEffect(() => { controller.current?.abort(); }, [profile?.id, profile?.baseUrl]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 500);
    return () => clearInterval(timer);
  }, [running, startedAt]);
  const update = <K extends keyof ContextBenchmarkOptions>(key: K, value: ContextBenchmarkOptions[K]) => setOptions(old => ({ ...old, [key]: value,
    ...(key === 'maxTokens' ? { tiers: old.tiers.filter(tier => tier > Number(value) + core.CONTEXT_BENCHMARK_HEADROOM) } : {}) }));
  const validation = useMemo(() => { try { core.validateContextBenchmarkOptions(options); return ''; } catch (err) { return core.normalizeError(err).message; } }, [options]);
  const start = async () => {
    if (!profile || !online || disabled || !loaded || controller.current || validation || contextLoading || !maxContext || options.tiers.some(tier => tier > maxContext || tier <= options.maxTokens + core.CONTEXT_BENCHMARK_HEADROOM)) return;
    const abort = new AbortController(); controller.current = abort;
    setSelected(undefined); setSamples([]); setProgress(undefined); setError(''); setStopping(false); setStartedAt(Date.now()); setElapsedMs(0); setRunning(true); onRunningChange(true);
    try {
      const report = await core.runContextBenchmark(profile, { ...options, configurationLabel: options.configurationLabel?.trim() || profile.name }, event => {
        if (!mounted.current) return;
        setProgress(event); if (event.sample) setSamples(old => [...old, event.sample!]);
      }, abort.signal);
      if (!mounted.current) return;
      setSelected(report); const next = retain([report, ...historyRef.current]); setHistory(next); await core.saveStore(STORE_KEY, next);
    } catch (err) { if (mounted.current) setError(core.normalizeError(err).message); }
    finally { controller.current = null; if (mounted.current) setRunning(false); onRunningChange(false); }
  };
  const number = (value: number | null | undefined, digits = 1) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString(language, { maximumFractionDigits: digits });
  const tierName = contextTierLabel;
  const states = { completed: text('完成', 'Completed'), failed: text('失败', 'Failed'), cancelled: text('已停止', 'Stopped') };
  const resultSamples = running ? samples : selected?.samples ?? [];
  const configuration = selected?.options.configurationLabel || selected?.profileName || options.configurationLabel || profile?.name;
  const exportReport = (format: 'json' | 'csv') => { if (selected) download(`strata-context-benchmark-${selected.id}.${format}`, format === 'json' ? JSON.stringify(selected, null, 2) : csv(selected), format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8'); };
  const exportImage = async (copy: boolean) => {
    if (!selected?.samples.length || !charts.current || running || imageBusy) return;
    setImageBusy(true); setImageMessage(undefined);
    try {
      if (copy && (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')) throw new Error(text('当前环境不支持复制图片，请使用导出 PNG。', 'Image clipboard is unavailable. Export a PNG instead.'));
      const png = createContextBenchmarkImage(selected, charts.current, language);
      if (copy) await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      else downloadBlob(`strata-context-benchmark-${selected.id}.png`, await png);
      setImageMessage({ text: copy ? text('结果图片已复制。', 'Result image copied.') : text('结果图片已导出。', 'Result image exported.') });
    } catch (err) { setImageMessage({ text: copy ? text('复制图片失败，请使用导出 PNG。', 'Could not copy the image. Export a PNG instead.') : core.normalizeError(err).message, error: true }); }
    finally { setImageBusy(false); }
  };
  const tableHeaders = [text('测试配置', 'Configuration'), text('档位', 'Tier'), text('实际输入', 'Actual input'), text('实际输出', 'Actual output'), text('预填充', 'Prefill'), text('解码', 'Decode'), text('整卡显存峰值', 'Peak GPU memory'), text('最低空闲显存', 'Min. free GPU memory'), text('RAM 峰值', 'Peak RAM'), text('总耗时', 'Wall time'), text('状态', 'Status')];
  const units = ['', '', 'token', 'token', 'tok/s', 'tok/s', 'MiB', 'MiB', 'GiB', 's', ''];
  return <div className={`benchmark-page context-benchmark-page${running ? ' is-running' : ''}`}>
    <Header title={text('上下文档位实测', 'Context tier benchmark')} hint={text('逐档测试，单请求串行执行', 'One request at a time, tier by tier')}>
      <button type="button" disabled={!selected?.samples.length || running || imageBusy} onClick={() => void exportImage(true)}><Copy size={15}/>{text('复制图片', 'Copy image')}</button>
      <button type="button" disabled={!selected?.samples.length || running || imageBusy} onClick={() => void exportImage(false)}><ImageDown size={15}/>{text('导出 PNG', 'Export PNG')}</button>
      <button type="button" disabled={!selected || running} onClick={() => exportReport('json')}><Download size={15}/>{text('导出 JSON', 'Export JSON')}</button>
      <button type="button" disabled={!selected || running} onClick={() => exportReport('csv')}><Download size={15}/>{text('导出 CSV', 'Export CSV')}</button>
      <button type="button" onClick={() => setHelpOpen(true)}><CircleHelp size={15}/>{text('测试说明', 'Test guide')}</button>
    </Header>
    {!profile ? <Empty title={text('请先选择模型', 'Select a model first')}/> : <Panel className="benchmark-plan" title={text('测试计划', 'Test plan')} action={<div className="benchmark-service"><strong title={profile.baseUrl}>{profile.name}</strong><Badge tone={online ? 'success' : ''}>{online ? text('模型已就绪', 'Model ready') : text('未启动或模型未就绪', 'Service stopped or model not ready')}</Badge></div>}>
      <div className="benchmark-plan-body">
        <div className="benchmark-toolbar"><p className="context-benchmark-capacity">{contextLoading ? text('正在读取模型上下文…', 'Reading model context…') : maxContext ? <>{text('当前模型上限', 'Model context limit')} <strong>{tierName(maxContext)}</strong></> : text('尚未取得模型上下文上限', 'Model context limit unavailable')}</p><div className="benchmark-run-actions">
          {running ? <><span role="status"><LoaderCircle size={15} className="spin"/>{number(Math.max(elapsedMs, progress?.elapsedMs ?? 0) / 1000)} s</span><button type="button" className="benchmark-stop" disabled={stopping} onClick={() => { setStopping(true); controller.current?.abort(); }}><Square size={14}/>{stopping ? text('正在停止', 'Stopping') : text('停止测试', 'Stop benchmark')}</button></> : <button type="button" className="st-btn st-btn--primary" disabled={!online || disabled || !loaded || !!validation || contextLoading || !maxContext || options.tiers.some(tier => tier > maxContext || tier <= options.maxTokens + core.CONTEXT_BENCHMARK_HEADROOM)} onClick={() => void start()}><Play size={15}/>{text('开始测试', 'Start benchmark')}</button>}
        </div></div>
        <div className="benchmark-scenario-group"><div className="benchmark-scenario-heading"><strong>{text('上下文档位', 'Context tiers')}</strong><span>{text('超出上限不可选', 'Over-limit tiers unavailable')}</span></div><div className="benchmark-scenarios">
          {availableTiers.map(tier => <label key={tier} className={`benchmark-scenario${options.tiers.includes(tier) ? ' is-selected' : ''}`}><Checkbox checked={options.tiers.includes(tier)} disabled={running || contextLoading || !maxContext || tier > maxContext || tier <= options.maxTokens + core.CONTEXT_BENCHMARK_HEADROOM} onChange={() => update('tiers', options.tiers.includes(tier) ? options.tiers.filter(value => value !== tier) : [...options.tiers, tier].sort((a, b) => a - b))}/><span>{tierName(tier)}</span></label>)}
        </div></div>
        <div className="benchmark-settings benchmark-key-settings">
          <Field label={text('测试配置名称', 'Configuration label')}><input aria-label={text('测试配置名称', 'Configuration label')} placeholder={profile.name} maxLength={120} value={options.configurationLabel ?? ''} disabled={running} onChange={event => update('configurationLabel', event.target.value)}/></Field>
          <Field label={text('每档轮数', 'Rounds per tier')}><NumberField aria-label={text('每档轮数', 'Rounds per tier')} min={1} max={10} value={options.rounds} disabled={running} onChange={event => update('rounds', Number(event.target.value))}/></Field>
          <Field label={text('最大输出 token', 'Output token limit')}><NumberField aria-label={text('最大输出 token', 'Output token limit')} min={16} max={4096} step={16} value={options.maxTokens} disabled={running} onChange={event => update('maxTokens', Number(event.target.value))}/></Field>
          <Field label={text('每次超时（秒）', 'Timeout per request (seconds)')}><NumberField aria-label={text('每次超时（秒）', 'Timeout per request (seconds)')} min={1} max={600} value={options.timeoutMs / 1000} disabled={running} onChange={event => update('timeoutMs', Math.round(Number(event.target.value) * 1000))}/></Field>
        </div>
        <div className="context-benchmark-plan-footer"><label><Toggle ariaLabel={text('出错即停', 'Stop on error')} checked={options.stopOnError} disabled={running} onCheckedChange={value => update('stopOnError', value)}/>{text('出错即停', 'Stop on error')}</label><span>{text(`${options.tiers.length} 个档位 · ${options.tiers.length * options.rounds} 个请求`, `${options.tiers.length} tiers · ${options.tiers.length * options.rounds} requests`)}</span></div>
        {!online && <p className="benchmark-not-ready">{text('请先启用服务并等待模型就绪。', 'Start the service and wait until the model is ready.')}</p>}
        {contextError && <p className="notice error" role="alert">{contextError}</p>}
        {validation && !contextLoading && !!maxContext && <p className="notice error" role="alert">{validation}</p>}
      </div>
    </Panel>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {running && <Panel className="benchmark-live" title={text('实时测试进度', 'Live progress')}><div className="context-benchmark-live"><strong>{progress?.currentTier ? tierName(progress.currentTier) : text('正在核验服务与输入', 'Checking service and input')}</strong><span>{text('完成', 'Completed')} {progress?.completed ?? 0} / {progress?.total ?? options.tiers.length * options.rounds}</span><span>{text('失败', 'Failed')} {progress?.failed ?? 0}</span><span>{text('已停止', 'Cancelled')} {progress?.cancelled ?? 0}</span></div><div className="benchmark-live-budget"><progress aria-label={text('档位测试进度', 'Tier benchmark progress')} max={Math.max(1, progress?.total ?? options.tiers.length * options.rounds)} value={(progress?.completed ?? 0) + (progress?.failed ?? 0) + (progress?.cancelled ?? 0)}/></div></Panel>}
    <Panel className="benchmark-results" title={text('各上下文档位实测', 'Results by context tier')} action={history.length > 0 && <Dropdown ariaLabel={text('上下文测试历史', 'Context benchmark history')} value={selected?.id ?? ''} disabled={running} placeholder={text('上下文测试历史', 'Context benchmark history')} options={history.map(report => ({ value: report.id, label: `${new Date(report.startedAt).toLocaleString(language)} · ${report.options.configurationLabel || report.profileName}` }))} onValueChange={id => setSelected(history.find(report => report.id === id))}/> }>
      {selected && <div className="benchmark-result-meta"><strong>{selected.model}</strong><Badge tone={selected.state === 'failed' ? 'error' : ''}>{selected.samples.length ? states[selected.state] : text('未执行', 'No requests run')}</Badge><span>{new Date(selected.startedAt).toLocaleString(language)}{selected.maxContext != null && ` · ${text('模型上下文', 'Model context')} ${number(selected.maxContext, 0)} token`}</span></div>}
      {imageMessage && <p className={`notice${imageMessage.error ? ' error' : ''}`} role="status">{imageMessage.text}</p>}
      <div ref={charts}><ContextBenchmarkCharts samples={resultSamples} language={language}/></div>
      <div className="context-benchmark-results-heading"><h3>{text('逐次测量', 'Measurements')}</h3><span>{text('图表：成功请求的档位均值', 'Charts: mean of successful requests per tier')}</span></div>
      <div className="table-wrap"><table className="context-benchmark-table"><thead><tr>{tableHeaders.map((label, index) => <th key={label}>{label}{units[index] && <small>{units[index]}</small>}</th>)}</tr></thead><tbody>
        {resultSamples.length > 0 ? resultSamples.map(sample => <tr key={sample.index}><td>{configuration}{(selected?.options.rounds ?? options.rounds) > 1 && <small>{text('轮次', 'Round')} {sample.round}</small>}</td><td>{tierName(sample.targetTokens)}</td><td>{number(sample.promptTokens, 0)}</td><td>{number(sample.completionTokens, 0)}</td><td>{number(sample.prefillTokS)}</td><td>{number(sample.decodeTokS)}</td><td>{number(sample.peakGpuMemory === null ? null : sample.peakGpuMemory / 2 ** 20, 0)}</td><td>{number(sample.minGpuMemoryFree === null ? null : sample.minGpuMemoryFree / 2 ** 20, 0)}</td><td>{number(sample.peakRam === null ? null : sample.peakRam / 2 ** 30)}</td><td>{number(sample.wallMs / 1000)}</td><td><span className={sample.state === 'failed' ? 'context-benchmark-failed' : ''}>{states[sample.state]}</span>{sample.error && <small className="benchmark-sample-error">{sample.error}</small>}</td></tr>)
          : <tr><td colSpan={tableHeaders.length} className="context-benchmark-empty">{running ? text('正在执行首个档位，完成后逐项显示结果。', 'Running the first tier; results appear as each request finishes.') : text('选择档位并开始测试，结果会按此表逐项记录。', 'Select tiers and start a benchmark to record results in this table.')}</td></tr>}
      </tbody></table></div>
      {!!selected?.skippedTiers.length && <ul className="context-benchmark-skipped">{selected.skippedTiers.map(tier => <li key={tier.targetTokens}>{tierName(tier.targetTokens)} · {text('已跳过', 'Skipped')} · {tier.reason}</li>)}</ul>}
      {selected && selected.stopReason !== 'completed' && <p className={`notice${selected.state === 'failed' ? ' error' : ''}`} role="status">{selected.stopReason === 'cancelled' ? text('测试已停止，已完成的结果已保留。', 'Benchmark stopped; completed results were retained.') : selected.stopReason === 'modelChanged' ? text('模型已切换，测试已停止。', 'The model changed; the benchmark was stopped.') : text('测试因请求错误结束，详情见测量结果。', 'The benchmark ended after a request error. See measurements for details.')}</p>}
    </Panel>
    {helpOpen && <Dialog title={text('上下文 Benchmark 说明', 'Context benchmark guide')} onClose={() => setHelpOpen(false)}><div className="benchmark-help">
      <p>{text('按上下文档位从小到大串行执行，默认选中当前模型上限以内的全部档位，支持到 1M。每档会预留输出 token 和模板余量。', 'Tiers run serially from smallest to largest, with all tiers up to the model limit selected by default, supporting up to 1M. Each tier reserves output and template space.')}</p>
      <p>{text('使用合成文本，temperature=0、reasoning_effort=none，无图片输入。实际输入和输出以服务 usage 为准，速度取 timings；总耗时包含完整请求。输入未能精确校准时，不代表实际达到目标档位。', 'Uses synthetic text, temperature=0, reasoning_effort=none, and no images. Token counts use service usage, speeds use timings, and duration covers the full request. Estimated inputs do not establish that the target tier was reached.')}</p>
      <p>{text('图表显示成功请求的档位均值，表格保留每次测量。显存和 RAM 每秒采样，均为整卡／整机读数；缺失指标显示 —。预热、缓存和其他程序会影响结果。', 'Charts show per-tier means of successful requests; the table keeps every measurement. GPU memory and RAM are sampled each second across the whole system. Missing metrics appear as —. Warmup, caching, and other programs affect comparisons.')}</p>
      <p>{text('完整条件、输入校准、缓存与生成输出保存在 JSON 中。历史最多保存 20 组、16 MiB。', 'Full conditions, input calibration, cache information, and generated output are included in JSON. History retains up to 20 reports within 16 MiB.')}</p>
    </div></Dialog>}
  </div>;
}
