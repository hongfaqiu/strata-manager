import type { AppLanguage, OfficialBenchProgress, OfficialBenchReport, ServiceProfile } from '@strata-manager/core';
import { useEffect, useRef, useState } from 'react';
import * as core from '@strata-manager/core';
import { Badge, Empty, Header, Panel } from '../components';
import { Dropdown } from '../OfficialControls';
import { OfficialBenchmarkResult, OfficialBenchmarkRunCard, officialText } from './OfficialBenchmarkView';

const STORE_KEY = 'officialBenchmarkReportsV1';
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function storedOfficialReport(value: unknown): value is OfficialBenchReport {
  if (!isObject(value) || value.schemaVersion !== 1 || value.kind !== 'official-bench' || typeof value.id !== 'string' || typeof value.model !== 'string'
    || typeof value.startedAt !== 'number' || !isObject(value.results) || !isObject(value.machine) || !Array.isArray(value.machine.gpuNames)
    || !Array.isArray(value.machine.modelEvidence) || !['completed', 'failed', 'cancelled'].includes(String(value.state))) return false;
  const results = value.results;
  return isObject(results.prompts) && isObject(results.skipped) && Array.isArray(results.failures);
}
const retain = (reports: OfficialBenchReport[]) => reports.slice(0, 20);

/** 「官方基准」: the strata_bench.py suite with its default parameters, compared with the maintainers' published numbers. */
export function OfficialBenchmarkPage({ profile, online, disabled, language, onRunningChange }: {
  profile?: ServiceProfile; online: boolean; disabled: boolean; language: AppLanguage; onRunningChange: (running: boolean) => void;
}) {
  const t = officialText(language);
  const [history, setHistory] = useState<OfficialBenchReport[]>([]), [selectedId, setSelectedId] = useState('');
  const [progress, setProgress] = useState<OfficialBenchProgress>(), [long, setLong] = useState(core.DEFAULT_OFFICIAL_BENCH_OPTIONS.long);
  const [running, setRunning] = useState(false), [stopping, setStopping] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState('');
  const [startedAt, setStartedAt] = useState(0), [elapsedMs, setElapsedMs] = useState(0);
  const controller = useRef<AbortController | null>(null), mounted = useRef(false), historyRef = useRef(history); historyRef.current = history;
  useEffect(() => {
    mounted.current = true;
    void core.loadStore<unknown>(STORE_KEY, []).then(saved => {
      if (!mounted.current) return;
      setHistory(retain(Array.isArray(saved) ? saved.filter(storedOfficialReport) : [])); setLoaded(true);
    }).catch(err => { if (mounted.current) { setError(core.normalizeError(err).message); setLoaded(true); } });
    return () => { mounted.current = false; controller.current?.abort(); onRunningChange(false); };
  }, [onRunningChange]);
  useEffect(() => { controller.current?.abort(); }, [profile?.id, profile?.baseUrl]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 500);
    return () => clearInterval(timer);
  }, [running, startedAt]);
  const start = async () => {
    if (!profile || !online || disabled || !loaded || controller.current) return;
    const abort = new AbortController(); controller.current = abort;
    setProgress(undefined); setError(''); setStopping(false); setStartedAt(Date.now()); setElapsedMs(0); setRunning(true); onRunningChange(true);
    try {
      const report = await core.runOfficialBench(profile, { ...core.DEFAULT_OFFICIAL_BENCH_OPTIONS, long }, event => { if (mounted.current) setProgress(event); }, abort.signal);
      if (!mounted.current) return;
      const next = retain([report, ...historyRef.current]); setHistory(next); setSelectedId(report.id); await core.saveStore(STORE_KEY, next);
    } catch (err) { if (mounted.current) setError(core.normalizeError(err).message); }
    finally { controller.current = null; if (mounted.current) setRunning(false); onRunningChange(false); }
  };
  const selected = history.find(r => r.id === selectedId) ?? history[0];
  const when = (r: OfficialBenchReport) => new Date(r.startedAt).toLocaleString(language, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return <div className={`benchmark-page official-benchmark-page${running ? ' is-running' : ''}`}>
    <Header title={t('官方基准', 'Official benchmark')} hint={t('与 Strata 官方 strata_bench.py 同样的跑法，对照官方公布数字', 'Runs Strata\'s tools/strata_bench.py suite and compares with the published numbers')}/>
    {!profile ? <Empty title={t('请先选择模型', 'Select a model first')}/> : <Panel className="benchmark-plan" title={t('测试', 'Run')} action={<div className="benchmark-service"><strong data-tooltip={profile.baseUrl}>{profile.name}</strong><Badge tone={online ? 'success' : ''}>{online ? t('模型已就绪', 'Model ready') : t('未启动或模型未就绪', 'Service stopped or model not ready')}</Badge></div>}>
      <OfficialBenchmarkRunCard language={language} ready={online && !disabled && loaded} running={running} stopping={stopping} progress={progress} long={long} elapsedMs={elapsedMs}
        onLong={setLong} onStart={() => void start()} onStop={() => { setStopping(true); controller.current?.abort(); }}/>
      {error && <p className="notice error" role="alert">{error}</p>}
    </Panel>}
    {selected && !running && <Panel className="obench-result-panel" title={t('结果对比', 'Official vs yours')} action={history.length > 1 ? <Dropdown compact ariaLabel={t('选择报告', 'Pick a report')} value={selected.id}
      options={history.map(r => ({ value: r.id, label: `${when(r)} · ${r.model}` }))} onValueChange={setSelectedId}/> : <span className="obench-when">{when(selected)}</span>}>
      <OfficialBenchmarkResult report={selected} language={language}/>
    </Panel>}
  </div>;
}
