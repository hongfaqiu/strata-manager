import type { AppLanguage } from "@strata-manager/core";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleHelp, Download, LoaderCircle, Play, Square, Timer } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { BenchmarkReport, BenchmarkSample, BenchmarkScenarioId, BenchmarkSuiteOptions, BenchmarkSuiteProgress, BenchmarkSuiteReport, BenchmarkTelemetry, ServiceProfile } from '@strata-manager/core';
import { Badge, Chart, Dialog, Empty, Field, Header, Metric, Panel } from '../components';
import { Checkbox, Dropdown, NumberField, Toggle } from '../OfficialControls';
import './benchmark.css';
import { BenchmarkComparisonPanel } from './BenchmarkComparisonPanel';

type SavedReport = BenchmarkReport | BenchmarkSuiteReport;
type Sample = BenchmarkSample | BenchmarkSuiteReport['samples'][number];
type NumericOption = { [Key in keyof BenchmarkSuiteOptions]: BenchmarkSuiteOptions[Key] extends number ? Key : never }[keyof BenchmarkSuiteOptions];
const STORE_KEY = 'benchmarkReportsV1';
const HISTORY_BYTES = 16 * 1024 * 1024;
const scenarioIds: BenchmarkScenarioId[] = ['short', 'code', 'long', 'decode', 'cache', 'conversation', 'custom'];
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nullableNumber = (value: unknown) => value === null || finite(value);
const isSuite = (report: SavedReport): report is BenchmarkSuiteReport => 'schemaVersion' in report && (report.schemaVersion === 2 || report.schemaVersion === 3);
const isSuiteSample = (sample: Sample): sample is BenchmarkSuiteReport['samples'][number] => 'scenario' in sample;

/** Preserve old serial reports; reject incomplete and unknown persisted schemas. */
function storedReport(value: unknown): SavedReport | null {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.model !== 'string' || typeof value.profileName !== 'string' || typeof value.baseUrl !== 'string'
    || !finite(value.startedAt) || !finite(value.finishedAt) || !['completed', 'failed', 'cancelled'].includes(String(value.state))
    || !isObject(value.options) || !Array.isArray(value.samples)) return null;
  const sampleValid = (sample: unknown) => isObject(sample) && finite(sample.index) && typeof sample.warmup === 'boolean'
    && ['completed', 'failed', 'cancelled'].includes(String(sample.state)) && finite(sample.wallMs) && nullableNumber(sample.ttftMs)
    && ['promptTokens', 'completionTokens', 'cachedTokens', 'prefillTokS', 'decodeTokS'].every(key => nullableNumber(sample[key]))
    && typeof sample.output === 'string' && (sample.error === undefined || typeof sample.error === 'string');
  if (!value.samples.every(sampleValid) || !finite(value.options.rounds) || !finite(value.options.maxTokens) || !finite(value.options.timeoutMs)) return null;
  if (value.schemaVersion === 2 || value.schemaVersion === 3) {
    if (!['suite', 'stress'].includes(String(value.options.kind)) || !finite(value.elapsedMs) || !finite(value.measurementElapsedMs)
      || !Array.isArray(value.options.scenarios) || !value.options.scenarios.every(id => scenarioIds.includes(id as BenchmarkScenarioId))
      || !['completed', 'requestLimit', 'duration', 'cancelled', 'error', 'modelChanged'].includes(String(value.stopReason))
      || !Array.isArray(value.stages) || !value.stages.every(stage => isObject(stage) && finite(stage.index) && finite(stage.concurrency) && finite(stage.elapsedMs) && finite(stage.startedAt) && finite(stage.finishedAt))
      || !Array.isArray(value.telemetry) || !value.telemetry.every(point => isObject(point) && finite(point.at) && finite(point.elapsedMs)
        && ['active', 'queued', 'running', 'cpuUtil', 'gpuUtil', 'gpuMemoryUsed', 'ramUsed', 'gpuTemperature'].every(key => nullableNumber(point[key])))
      || !value.samples.every(sample => isObject(sample) && scenarioIds.includes(sample.scenario as BenchmarkScenarioId) && finite(sample.stage) && finite(sample.concurrency) && finite(sample.turn))) return null;
  } else if (value.schemaVersion !== undefined && value.schemaVersion !== 1) return null;
  return value as unknown as SavedReport;
}

function retainedHistory(reports: SavedReport[]): SavedReport[] {
  const retained: SavedReport[] = [], encoder = new TextEncoder();
  let bytes = 2;
  for (const report of reports) {
    const size = encoder.encode(JSON.stringify(report)).byteLength + 1;
    if (retained.length >= 20 || retained.length > 0 && bytes + size > HISTORY_BYTES) break;
    retained.push(report); bytes += size;
  }
  return retained;
}

function saveDownload(name: string, data: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function reportCsv(report: SavedReport): string {
  const columns = ['round', 'scenario', 'stage', 'concurrency', 'worker', 'turn', 'warmup', 'state', 'started_at', 'ttft_ms', 'wall_ms', 'prompt_tokens', 'completion_tokens', 'cached_tokens', 'prefill_tok_s', 'decode_tok_s', 'finish_reason', 'error_code', 'http_status', 'error', 'output'];
  const cell = (value: unknown) => {
    let text = value == null ? '' : String(value);
    if (typeof value === 'string' && /^[=+\-@]/.test(text)) text = `\t${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const rows = report.samples.map(sample => {
    const suite = isSuiteSample(sample) ? sample : null;
    return [sample.index, suite?.scenario, suite?.stage, suite?.concurrency, suite?.worker, suite?.turn, sample.warmup, sample.state,
      finite(sample.startedAt) ? new Date(sample.startedAt).toISOString() : '', sample.ttftMs, sample.wallMs, sample.promptTokens, sample.completionTokens,
      sample.cachedTokens, sample.prefillTokS, sample.decodeTokS, sample.finishReason, suite?.errorCode, suite?.httpStatus, sample.error, sample.output].map(cell).join(',');
  });
  return `\uFEFF${[columns.join(','), ...rows].join('\r\n')}`;
}

export function ScenarioBenchmarkPage({ profile, online, disabled, language, onRunningChange, quickRunRequest = 0 }: {
  profile?: ServiceProfile; online: boolean; disabled: boolean; language: AppLanguage; onRunningChange: (running: boolean) => void; quickRunRequest?: number;
}) {
  const zh = language === 'zh-CN', text = (cn: string, en: string) => zh ? cn : en;
  const [options, setOptions] = useState<BenchmarkSuiteOptions>(() => ({ ...core.DEFAULT_BENCHMARK_SUITE_OPTIONS, kind: 'suite', concurrency: 1, scenarios: [...core.DEFAULT_BENCHMARK_SUITE_OPTIONS.scenarios] }));
  const [history, setHistory] = useState<SavedReport[]>([]), [selected, setSelected] = useState<SavedReport>();
  const [baseline, setBaseline] = useState<SavedReport>();
  const [includeContent, setIncludeContent] = useState(false);
  const [samples, setSamples] = useState<Sample[]>([]), [telemetry, setTelemetry] = useState<BenchmarkTelemetry[]>([]);
  const [progress, setProgress] = useState<BenchmarkSuiteProgress>(), [filter, setFilter] = useState('all');
  const [running, setRunning] = useState(false), [loaded, setLoaded] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false), [showRunningSettings, setShowRunningSettings] = useState(false);
  const [startedAt, setStartedAt] = useState(0), [elapsed, setElapsed] = useState(0), [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null), mounted = useRef(false);
  const lastQuickRunRequest = useRef(0);
  const historyRef = useRef(history); historyRef.current = history;
  useEffect(() => { let active=true; void core.loadStore<unknown>('benchmarkUpgradeBaseline',null).then(value=>{if(active){const report=storedReport(value);if(report)setBaseline(report);}}).catch(()=>{});return()=>{active=false;}; }, []);
  const saveBaseline=(report:SavedReport)=>{void core.saveStore('benchmarkUpgradeBaseline',report).then(()=>setBaseline(report)).catch(err=>setError(core.normalizeError(err).message));};
  useEffect(() => {
    let active = true;
    mounted.current = true;
    void core.loadStore<unknown>(STORE_KEY, []).then(saved => {
      if (!active || !mounted.current) return;
      const reports = Array.isArray(saved) ? retainedHistory(saved.map(storedReport).filter((report): report is SavedReport => report !== null)) : [];
      setHistory(reports); setSelected(reports[0]); setLoaded(true);
    }).catch(err => { if (active && mounted.current) { setError(core.normalizeError(err).message); setLoaded(true); } });
    return () => { active = false; mounted.current = false; controller.current?.abort(); onRunningChange(false); };
  }, [onRunningChange]);
  useEffect(() => { controller.current?.abort(); }, [profile?.id, profile?.baseUrl]);
  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => setElapsed(Date.now() - startedAt), 500);
    return () => clearInterval(interval);
  }, [running, startedAt]);
  const update = <K extends keyof BenchmarkSuiteOptions>(key: K, value: BenchmarkSuiteOptions[K]) => setOptions(old => ({ ...old, [key]: value }));
  const toggleScenario = (scenario: BenchmarkScenarioId) => setOptions(old => ({ ...old, scenarios: old.scenarios.includes(scenario) ? old.scenarios.filter(id => id !== scenario) : [...old.scenarios, scenario] }));
  const validation = useMemo(() => {
    try { core.validateBenchmarkSuiteOptions(options); return ''; }
    catch (err) { return core.normalizeError(err).message; }
  }, [options]);
  const budget = useMemo(() => validation ? null : core.estimateBenchmarkSuiteRequests(options), [options, validation]);
  const start = useCallback(async (runOptions: BenchmarkSuiteOptions = options) => {
    if (controller.current) { setError(zh ? '已有性能测试正在运行，请先停止或等待完成。' : 'A benchmark is already running. Stop it or wait for it to finish.'); return; }
    if (!profile) { setError(zh ? '无法开始测速：请先选择模型。' : 'Cannot start the benchmark: select a model first.'); return; }
    if (!online) { setError(zh ? '无法开始测速：服务未启动或模型未就绪，请先启用并等待模型就绪。' : 'Cannot start the benchmark: the service is stopped or the model is not ready. Start it and wait until ready.'); return; }
    if (disabled) { setError(zh ? '无法开始测速：应用正在执行其他操作，请稍后重试。' : 'Cannot start the benchmark: another operation is in progress. Try again when it finishes.'); return; }
    if (!loaded) { setError(zh ? '无法开始测速：测试历史尚未读取完成。' : 'Cannot start the benchmark: benchmark history is still loading.'); return; }
    try { core.validateBenchmarkSuiteOptions(runOptions); }
    catch (err) { setError(core.normalizeError(err).message); return; }
    const abort = new AbortController(); controller.current = abort;
    setOptions({ ...runOptions, scenarios: [...runOptions.scenarios] });
    setError(''); setSelected(undefined); setSamples([]); setTelemetry([]); setProgress(undefined); setFilter('all'); setShowRunningSettings(false);
    setStartedAt(Date.now()); setElapsed(0); setRunning(true); onRunningChange(true);
    try {
      const result = await core.runBenchmarkSuite(profile, { ...runOptions, kind: 'suite', concurrency: 1 }, event => {
        if (!mounted.current) return;
        setProgress(event);
        if (event.sample) setSamples(old => [...old, event.sample!]);
        if (event.telemetry) setTelemetry(old => [...old.slice(-359), event.telemetry!]);
      }, abort.signal);
      if (!mounted.current) return;
      const report: BenchmarkSuiteReport = result;
      setSelected(report);
      const next = retainedHistory([report, ...historyRef.current]); setHistory(next);
      await core.saveStore(STORE_KEY, next);
    } catch (err) { if (mounted.current) setError(core.normalizeError(err).message); }
    finally { controller.current = null; if (mounted.current) setRunning(false); onRunningChange(false); }
  }, [options, profile, online, disabled, loaded, onRunningChange, zh]);
  useEffect(() => {
    if (!loaded || !quickRunRequest || quickRunRequest === lastQuickRunRequest.current) return;
    lastQuickRunRequest.current = quickRunRequest;
    void start({ ...core.DEFAULT_BENCHMARK_SUITE_OPTIONS, kind: 'suite', scenarios: ['short', 'decode'], rounds: 1, warmup: false, maxTokens: 256, timeoutMs: 60_000, mode: 'unique', stopOnError: true, concurrency: 1 });
  }, [quickRunRequest, loaded, start]);
  const suiteSummary = useMemo(() => selected && isSuite(selected) ? core.summarizeBenchmarkSuite(selected) : null, [selected]);
  const legacySummary = useMemo(() => selected && !isSuite(selected) ? core.summarizeBenchmark(selected) : null, [selected]);
  const summary = suiteSummary ?? legacySummary;
  const resultSamples = running ? samples : selected?.samples ?? [];
  const visibleSamples = useMemo(() => resultSamples.filter(sample => filter === 'all' || isSuiteSample(sample) && sample.scenario === filter).slice(-100), [resultSamples, filter]);
  const currentTelemetry = running ? telemetry : selected && isSuite(selected) ? selected.telemetry.slice(-360) : [];
  const latestTelemetry = currentTelemetry.at(-1);
  const scenarioName = (id: string) => {
    const scenario = core.BENCHMARK_SCENARIOS.find(item => item.id === id);
    return scenario ? zh ? scenario.nameZh : scenario.nameEn : id;
  };
  const scenarioComparisons = useMemo(() => selected && isSuite(selected) ? scenarioIds.filter(id => selected.samples.some(sample => sample.scenario === id && !sample.warmup)).map(id => ({ id, summary: core.summarizeBenchmarkSuite(selected, { scenario: id }) })) : [], [selected]);
  const number = (value: number | null | undefined, digits = 1) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString(language, { maximumFractionDigits: digits });
  const seconds = (value: number | null | undefined) => value == null ? '—' : number(value / 1000, 2);
  const percent = (value: number | null | undefined) => value == null ? '—' : number(value * 100);
  const memory = (value: number | null | undefined) => value == null ? '—' : number(value / 2 ** 30, 2);
  const states = { completed: text('完成', 'Completed'), failed: text('失败', 'Failed'), cancelled: text('已停止', 'Stopped') };
  const stopReasons = { completed: text('计划完成', 'Plan completed'), requestLimit: text('达到请求预算', 'Request budget reached'), duration: text('达到持续时间', 'Duration reached'), cancelled: text('用户停止', 'Stopped by user'), error: text('发生错误后停止', 'Stopped after an error'), modelChanged: text('模型发生变化', 'Model changed') };
  const fields = (key: NumericOption, label: string, min: number, max: number, step = 1, divisor = 1, hint?: string) => <Field label={label} hint={hint}><NumberField aria-label={label} min={min} max={max} step={step} value={options[key] / divisor} disabled={running} onChange={event => update(key, Math.round(Number(event.target.value) * divisor))}/></Field>;
  const exportReport = (format: 'json' | 'csv') => {
    if (!selected) return;
    const exported=core.exportBenchmarkReport(selected,includeContent);
    saveDownload(`strata-benchmark-${selected.id}.${format}`, format === 'json' ? JSON.stringify({ ...exported, summary }, null, 2) : reportCsv(exported), format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8');
  };
  const compareHeaders = [text('成功 / 失败', 'Completed / failed'), 'TTFT (s)', text('总耗时 (s)', 'Wall time (s)'), 'Prefill (tok/s)', 'Decode (tok/s)', text('缓存命中', 'Cache hit')];
  const compareCells = (value: NonNullable<typeof suiteSummary>) => <><td>{value.completed} / {value.failed}</td><td>{seconds(value.ttftMs.mean)}</td><td>{seconds(value.wallMs.mean)}</td><td>{number(value.prefillTokS)}</td><td>{number(value.decodeTokS)}</td><td>{percent(value.cacheHitRate)}{value.cacheHitRate !== null && '%'}</td></>;
  const latestSample = useMemo(() => {
    for (let index = samples.length - 1; index >= 0; index--) {
      if (!samples[index]!.warmup && samples[index]!.state === 'completed') return samples[index];
    }
    return undefined;
  }, [samples]);
  const settled = (progress?.completed ?? 0) + (progress?.failed ?? 0) + (progress?.cancelled ?? 0);
  const elapsedSeconds = seconds(Math.max(elapsed, progress?.elapsedMs ?? 0));
  return <div className={`benchmark-page${running ? ' is-running' : ''}`}>
    <Header title={text('场景测试', 'Scenario tests')}>
      <button type="button" disabled={!selected || running} onClick={() => exportReport('json')}><Download size={15}/>{text('导出 JSON', 'Export JSON')}</button>
      <button type="button" disabled={!selected || running} onClick={() => exportReport('csv')}><Download size={15}/>{text('导出 CSV', 'Export CSV')}</button>
      <button type="button" onClick={() => setHelpOpen(true)}><CircleHelp size={15}/>{text('测试说明', 'Test guide')}</button>
    </Header>
    {!profile ? <Empty title={text('请先选择模型', 'Select a model first')}/> : <>
      <Panel className="benchmark-plan" title={text('测试计划', 'Test plan')} action={<div className="benchmark-service" data-tooltip={profile.baseUrl}><strong>{profile.name}</strong><Badge tone={online ? 'success' : ''}>{online ? text('模型已就绪', 'Model ready') : text('未启动或模型未就绪', 'Service stopped or model not ready')}</Badge></div>}>
        <div className="benchmark-plan-body">
          <div className="benchmark-toolbar">
            <p className="subtle benchmark-mode-hint">{text('按场景逐个发送单请求，观察首 token 延迟、输入处理和输出速度。','Run one request at a time to measure first-token latency, prefill and decode speed.')}</p>
            <div className="benchmark-run-actions">
              {running ? <><span role="status"><LoaderCircle size={15} className="spin"/>{elapsedSeconds} s</span><button type="button" className="benchmark-stop" onClick={() => controller.current?.abort()}><Square size={14}/>{text('停止测试','Stop benchmark')}</button></> : <button type="button" className="st-btn st-btn--primary" disabled={!online || disabled || !loaded || !!validation} onClick={() => void start()}><Play size={15}/>{text('开始测试','Start benchmark')}</button>}
            </div>
          </div>
          {running && <div className="benchmark-running-plan"><span>{options.scenarios.map(scenarioName).join(' · ')}</span><button type="button" className="text-button" aria-expanded={showRunningSettings} onClick={() => setShowRunningSettings(value => !value)}>{showRunningSettings ? text('收起设置','Hide settings') : text('查看设置','View settings')}</button></div>}
          <div className="benchmark-plan-settings" hidden={running && !showRunningSettings}>
            <div className="benchmark-settings benchmark-key-settings">
              {fields('rounds', text('测试轮数','Rounds per scenario'), 1, 20)}
              {fields('maxTokens', text('每轮最大输出 token','Output token limit'), 16, 4096, 16)}
              {options.scenarios.includes('long') && fields('inputChars', text('长输入字符数','Long input characters'), 1024, 131072, 1024)}
              {options.scenarios.includes('conversation') && fields('conversationTurns', text('连续对话轮数','Conversation turns'), 2, 10)}
            </div>
            <div className="benchmark-scenario-group">
              <div className="benchmark-scenario-heading"><strong>{text('测试场景','Scenarios')}</strong><span>{options.scenarios.length} / 7 {text('已选','selected')}</span></div>
              <div className="benchmark-scenarios">{core.BENCHMARK_SCENARIOS.map(scenario => <label key={scenario.id} data-tooltip={zh ? scenario.descriptionZh : scenario.descriptionEn} className={`benchmark-scenario ${options.scenarios.includes(scenario.id) ? 'is-selected' : ''}`}><Checkbox aria-label={scenarioName(scenario.id)} checked={options.scenarios.includes(scenario.id)} disabled={running} onChange={() => toggleScenario(scenario.id)}/><span>{scenarioName(scenario.id)}</span></label>)}</div>
            </div>
            {options.scenarios.includes('custom') && <Field label={text('测试提示词','Custom prompt')} hint={`${options.prompt.length.toLocaleString(language)} ${text('字符','characters')}`}><textarea aria-label={text('测试提示词','Custom prompt')} rows={3} value={options.prompt} disabled={running} onChange={event => update('prompt', event.target.value)}/></Field>}
            <details className="benchmark-advanced"><summary>{text('高级测试选项','Advanced test options')}</summary><div className="benchmark-settings">
              {fields('timeoutMs', text('每轮超时（秒）','Timeout per request (seconds)'), 1, 600, 1, 1000)}
              <Field label={text('输入模式','Input mode')}><Dropdown ariaLabel={text('输入模式','Input mode')} value={options.mode} disabled={running} onValueChange={value => update('mode', value as BenchmarkSuiteOptions['mode'])} options={[{value:'unique',label:text('变化输入','Varied input')},{value:'repeat',label:text('重复输入 · 测试缓存','Repeated input · cache test')}]}/></Field>
            </div><div className="benchmark-option-toggles">
              <label><Toggle ariaLabel={text('先预热一次','Run one warmup')} disabled={running} checked={options.warmup} onCheckedChange={value => update('warmup', value)}/><span>{text('每个场景先预热一次','Warm up each scenario once')}</span></label>
              <label><Toggle ariaLabel={text('发生错误后停止','Stop on error')} disabled={running} checked={options.stopOnError} onCheckedChange={value => update('stopOnError', value)}/><span>{text('发生错误后停止','Stop on error')}</span></label>
            </div><p className="subtle benchmark-mode-hint">{text('请求超时或模型变化会停止整组测试。','A timeout or model change stops the entire run.')}</p></details>
          </div>
          <div className="benchmark-budget" role="status"><span>{text(`预计 ${number(budget, 0)} 个测量请求`, `Estimated ${number(budget, 0)} measured requests`)}{options.warmup && <small>{text(` · 另加 ${options.scenarios.length} 个预热请求`, ` · plus ${options.scenarios.length} warmup requests`)}</small>}</span>{!online && <span className="benchmark-not-ready">{text('请先启用服务并等待模型就绪','Start the service and wait until ready')}</span>}</div>
          {validation && <p className="notice error" role="status">{validation}</p>}
        </div>
      </Panel>
    </>}
    {error && <div className="notice error" role="alert">{error}</div>}
    {running && <Panel className="benchmark-live" title={text('实时测试进度','Live progress')} action={<span className="benchmark-stage">{progress ? `${text('阶段','Stage')} ${progress.stageIndex} / ${progress.totalStages}` : text('正在核验服务','Checking the service')}</span>}>
      <div className="benchmark-progress" aria-live="polite"><Metric label={text('已发出','Issued')} value={number(progress?.issued,0)}/><Metric label={text('已完成','Completed')} value={number(progress?.completed,0)}/><Metric label={text('失败','Failed')} value={number(progress?.failed,0)}/><Metric label={text('已取消','Cancelled')} value={number(progress?.cancelled,0)}/></div>
      <div className="benchmark-live-budget"><progress max={Math.max(1,budget ?? 1)} value={Math.min(settled,budget ?? 1)} aria-label={text('计划进度','Plan progress')}/><span>{settled} / {number(budget,0)}</span></div>
      <div className="benchmark-live-latest"><span>{text('最近 TTFT','Latest TTFT')} <strong>{seconds(latestSample?.ttftMs)} s</strong></span><span>{text('最近 Decode','Latest decode')} <strong>{number(latestSample?.decodeTokS)} tok/s</strong></span><span>{text('实际输入 / 输出','Actual input / output')} <strong>{number(latestSample?.promptTokens,0)} / {number(latestSample?.completionTokens,0)} token</strong></span><span>GPU <strong>{number(latestTelemetry?.gpuUtil)} %</strong></span></div>
    </Panel>}
    <details className="benchmark-history-disclosure"><summary>{text("历史与升级对照", "History and upgrade comparison")}</summary><BenchmarkComparisonPanel reports={history} current={selected} baseline={baseline} language={language} disabled={running || disabled} replayDisabled={!online} onBaseline={saveBaseline} onReplay={report => { if (report.profileId !== profile?.id) { setError(text("请先选择基线对应的模型。", "Select the baseline model first.")); return; } if (isSuite(report)) void start({ ...report.options, kind: "suite", concurrency: 1 }); }}/></details>
    <details className="benchmark-export-options"><summary>{text("导出内容", "Export content")}</summary><label><Checkbox checked={includeContent} onChange={event => setIncludeContent(event.target.checked)}/>{text("导出时包含测试文本与输出", "Include test text and output in exports")}</label></details>
    {(!running || selected || resultSamples.length > 0) && <Panel className="benchmark-results" title={text('测试结果','Results')} action={history.length > 0 && <Dropdown ariaLabel={text('历史测试','Benchmark history')} value={selected?.id ?? ''} disabled={running} placeholder={text('历史测试','Benchmark history')} options={history.map(report => ({ value:report.id,label:`${new Date(report.startedAt).toLocaleString(language)} · ${report.model} · ${isSuite(report) ? report.options.kind === 'stress' ? text('旧版压力测试','Legacy stress') : text('场景测试','Suite') : text('串行测试','Serial')}` }))} onValueChange={value => { setSelected(history.find(report => report.id === value)); setFilter('all'); }}/> }>
      {selected && <div className="benchmark-result-meta"><strong>{selected.model}</strong><Badge tone={selected.state === 'failed' ? 'error' : ''}>{states[selected.state]}</Badge><span>{isSuite(selected) ? stopReasons[selected.stopReason] : text('旧版串行报告','Legacy serial report')} · {summary?.completed} {text('个请求完成','completed')}</span></div>}
      {selected && isSuite(selected) && selected.options.kind === 'stress' && <p className="notice">{text('此报告来自旧版压力测试，仅供查看和导出；并发条件可在测试条件中查看。','This legacy stress report is available for viewing and export. Its concurrency settings are listed under test conditions.')}</p>}
      {summary && <div className="benchmark-summary benchmark-summary-primary">
        <Metric label={text('平均首 token 延迟','Mean TTFT')} value={seconds(summary.ttftMs.mean)} unit="s"/>
        <Metric label={text('单请求平均输出速度','Mean per-request decode speed')} value={number(summary.decodeTokS)} unit="tok/s"/>
        <Metric label={text('平均输入处理速度','Mean prefill speed')} value={number(summary.prefillTokS)} unit="tok/s"/>
        <Metric label={text('提示缓存命中率','Prompt cache hit rate')} value={percent(summary.cacheHitRate)} unit="%"/>
      </div>}
      {suiteSummary && <div className="benchmark-result-facts"><span>{text('失败','Failed')} <strong>{suiteSummary.failed}</strong></span><span>{text('超时','Timeouts')} <strong>{suiteSummary.timeoutCount}</strong></span><span>{text('已取消','Cancelled')} <strong>{suiteSummary.cancelled}</strong></span><span>{text('达到输出上限','Output limit reached')} <strong>{suiteSummary.truncatedCount}</strong></span></div>}
      {summary && <details className="benchmark-section"><summary>{text('性能统计','Performance statistics')}</summary><div className="benchmark-summary">
        <Metric label={text('平均首 token 延迟','Mean TTFT')} value={seconds(summary.ttftMs.mean)} unit="s"><small>P50 {seconds(summary.ttftMs.p50)} · P95 {seconds(summary.ttftMs.p95)}{suiteSummary && ` · P99 ${seconds(suiteSummary.ttftMs.p99)}`} s</small></Metric>
        <Metric label={text('平均总耗时','Mean wall time')} value={seconds(summary.wallMs.mean)} unit="s"><small>P50 {seconds(summary.wallMs.p50)} · P95 {seconds(summary.wallMs.p95)}{suiteSummary && ` · P99 ${seconds(suiteSummary.wallMs.p99)}`} s</small></Metric>
        <Metric label={text('平均输入处理速度','Mean prefill speed')} value={number(summary.prefillTokS)} unit="tok/s"/>
        <Metric label={text('单请求平均输出速度','Mean per-request decode speed')} value={number(summary.decodeTokS)} unit="tok/s"/>
        <Metric label={text('提示缓存命中率','Prompt cache hit rate')} value={percent(summary.cacheHitRate)} unit="%"/>
      </div>{suiteSummary && <div className="benchmark-result-facts"><span>{text('整卡显存峰值','Whole-GPU memory peak')} <strong>{memory(suiteSummary.peakGpuMemory)} GiB</strong></span><span>{text('整机 RAM 峰值','System RAM peak')} <strong>{memory(suiteSummary.peakRam)} GiB</strong></span></div>}</details>}
      {scenarioComparisons.length > 0 && <details className="benchmark-section"><summary>{text('分场景对比','Scenario comparison')}</summary>
        {scenarioComparisons.length > 0 && <div className="benchmark-comparison"><h3>{text('分场景对比','Scenario comparison')}</h3><div className="table-wrap"><table><thead><tr><th>{text('场景','Scenario')}</th>{compareHeaders.map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{scenarioComparisons.map(row => <tr key={row.id}><td>{scenarioName(row.id)}</td>{compareCells(row.summary)}</tr>)}</tbody></table></div></div>}
      </details>}
      {suiteSummary && suiteSummary.errors.length > 0 && <details className="benchmark-section"><summary>{text('错误分类','Error breakdown')}<span className="benchmark-section-count">{suiteSummary.failed}</span></summary><ul className="benchmark-error-list">{suiteSummary.errors.map((entry,index) => <li key={index}>{entry.code}{entry.status != null && ` · HTTP ${entry.status}`} · {entry.count}</li>)}</ul></details>}
      {resultSamples.length > 0 ? <details className="benchmark-section benchmark-sample-section"><summary>{text('请求样本','Request samples')}<span className="benchmark-section-count">{resultSamples.length}</span></summary>
        <div className="benchmark-sample-toolbar"><Dropdown ariaLabel={text('筛选场景','Filter scenario')} value={filter} onValueChange={setFilter} options={[{value:'all',label:text('全部场景','All scenarios')},...scenarioIds.map(id => ({value:id,label:scenarioName(id)}))]}/><small>{text(`显示最后 ${visibleSamples.length} 条；全部 ${resultSamples.length} 条可导出。`, `Showing the latest ${visibleSamples.length}; all ${resultSamples.length} are available in exports.`)}</small></div>
        <div className="table-wrap"><table className="benchmark-samples-table"><thead><tr>{[text('轮次 / 场景','Round / scenario'),text('对话轮次','Conversation turn'),text('状态','Status'),'TTFT (s)',text('总耗时 (s)','Wall time (s)'),text('实际输入 / 输出 token','Actual input / output tokens'),text('缓存 token','Cached tokens'),'Prefill (tok/s)','Decode (tok/s)'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{visibleSamples.map((sample,index) => <tr key={`${sample.startedAt}-${sample.index}-${index}`}><td>{sample.warmup ? text('预热','Warmup') : sample.index}{isSuiteSample(sample) && <small>{scenarioName(sample.scenario)}</small>}</td><td>{isSuiteSample(sample) ? sample.turn : '—'}</td><td><span data-tooltip={sample.error}>{states[sample.state]}</span>{sample.error && <small className="benchmark-sample-error">{sample.error}</small>}</td><td>{seconds(sample.ttftMs)}</td><td>{seconds(sample.wallMs)}</td><td>{number(sample.promptTokens,0)} / {number(sample.completionTokens,0)}</td><td>{number(sample.cachedTokens,0)}</td><td>{number(sample.prefillTokS)}</td><td>{number(sample.decodeTokS)}</td></tr>)}</tbody></table></div>
        {visibleSamples.some(sample => sample.output) && <details className="benchmark-output"><summary>{text('查看最近输出片段','View recent output excerpts')}</summary>{visibleSamples.filter(sample => sample.output).slice(-10).map((sample,index) => <div key={index}><strong>{sample.warmup ? text('预热','Warmup') : `${text('请求','Request')} ${sample.index}`}{isSuiteSample(sample) && ` · ${scenarioName(sample.scenario)}`}{sample.finishReason && ` · ${sample.finishReason}`}</strong><pre>{sample.output}</pre></div>)}</details>}
      </details> : !running && <p className="benchmark-empty">{text('完成测试后，在这里查看结果。','Results will appear here after a run.')}</p>}
      {selected && <details className="benchmark-section"><summary><Timer size={14}/>{text('测试条件','Test conditions')}</summary><div className="benchmark-conditions"><p>{selected.profileName} · {selected.baseUrl}</p><p>{text('开始','Started')} {new Date(selected.startedAt).toLocaleString(language)} · {text('结束','Finished')} {new Date(selected.finishedAt).toLocaleString(language)}</p><pre>{JSON.stringify({ options:selected.options,engine:selected.engine,hardware:selected.hardware },null,2)}</pre><p className="subtle">{text('历史最多保留最近 20 组，总容量 16 MiB；始终保留最新整组报告。','History retains up to 20 recent runs within 16 MiB, always preserving the latest complete report.')}</p></div></details>}
    </Panel>}
    {(running || currentTelemetry.length > 0) && <details className="benchmark-section benchmark-resources"><summary>{text('资源趋势','Resource trends')}<span className="benchmark-section-count">CPU {number(latestTelemetry?.cpuUtil)} % · GPU {number(latestTelemetry?.gpuUtil)} %</span></summary><div className="benchmark-resource-latest"><span>{text('整卡显存','Whole-GPU memory')} {memory(latestTelemetry?.gpuMemoryUsed)} GiB</span><span>{text('整机 RAM','System RAM')} {memory(latestTelemetry?.ramUsed)} GiB</span></div><div className="benchmark-charts">
      <Chart label={text('CPU 使用率','CPU utilization')} values={currentTelemetry.map(point => point.cpuUtil)} unit="%"/><Chart label={text('GPU 使用率','GPU utilization')} values={currentTelemetry.map(point => point.gpuUtil)} unit="%"/><Chart label={text('显存使用','GPU memory used')} values={currentTelemetry.map(point => point.gpuMemoryUsed == null ? null : point.gpuMemoryUsed / 2 ** 30)} unit="GiB"/><Chart label={text('系统内存使用','RAM used')} values={currentTelemetry.map(point => point.ramUsed == null ? null : point.ramUsed / 2 ** 30)} unit="GiB"/>
    </div><p className="benchmark-metric-note subtle">{text('显示最近 360 次采样，完整数据在 JSON 中。缺失指标显示 —；资源读数是整机观测，可能包含其他进程。','Showing the latest 360 samples; JSON retains all telemetry. Missing metrics appear as —. Resource readings cover the whole system and may include other processes.')}</p></details>}
    {helpOpen && <Dialog title={text('场景测试说明','Scenario test guide')} onClose={() => setHelpOpen(false)}><div className="benchmark-help">
      <p>{text('场景测试固定一次只发送一个请求，按轮数跑完有限计划。对话的每一轮分别计为一个请求。','Scenario tests send one request at a time through a finite plan. Each conversation turn counts as a separate request.')}</p>
      <dl>{core.BENCHMARK_SCENARIOS.map(scenario => <div key={scenario.id}><dt>{scenarioName(scenario.id)}</dt><dd>{zh ? scenario.descriptionZh : scenario.descriptionEn}</dd></div>)}</dl>
      <p>{text('长输入按真实字符数构造，不是 token 数；实际 token 用量由服务返回。变化输入减少前缀命中，缓存场景仍重复输入；模型和专家缓存可能保留。','Long inputs use a character count, not tokens. Token usage comes from the service. Varied input reduces prefix reuse; the cache scenario still repeats its input, and model or expert caches may remain warm.')}</p>
      <p>{text('预热为每个所选场景各发送一个额外请求，不计入测量汇总。请求超时或模型变化会停止整组测试；其他错误是否停止由高级选项决定。','Warmup adds one request per selected scenario, excluded from measured results. A timeout or model change stops the whole run; the advanced stop-on-error option controls other errors.')}</p>
      <p>{text('离开页面后测试继续运行。停止会取消请求并保留结果；引擎释放已在处理的请求可能需要时间。','The run continues when you leave the page. Stopping requests cancellation and retains results; the engine may need time to release ongoing work.')}</p>
      <p>{text('TTFT 从请求发出计至首个内容或推理 token；总耗时包含等待与传输。Prefill 和 Decode 使用各请求返回的引擎速度，实际输入和输出 token 来自服务用量。预热、失败和停止的样本不计入速度和延迟汇总。','TTFT runs from submission to the first content or reasoning token. Wall time includes waiting and transport. Prefill and decode use the engine speed returned by each response; actual input and output tokens come from service usage. Warmup, failed and stopped samples are excluded from speed and latency summaries.')}</p>
      <p>{text('资源曲线是整机和 GPU 的总体观测，可能包含其他进程；缺少的指标不会推断。请求表只显示最近 100 条，JSON 和 CSV 可导出全部样本。','Resources describe whole-system and GPU observations and may include other processes. Missing metrics are not inferred. Tables show the latest 100 requests; JSON and CSV export all samples.')}</p>
    </div></Dialog>}
  </div>;
}
