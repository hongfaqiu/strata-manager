import type { AppLanguage, BenchmarkSuiteProgress, BenchmarkSuiteReport, BenchmarkSuiteSample, ServiceProfile } from '@strata-manager/core';
import * as core from '@strata-manager/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, Play, Square } from 'lucide-react';
import { ConcurrencyChart } from './ConcurrencyChart';
import './concurrency-ladder.css';

const STORE_KEY = 'concurrencyLadderV1';
const KEEP = 5;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const storedLadder = (value: unknown): BenchmarkSuiteReport | null => {
  const report = value as BenchmarkSuiteReport;
  return report && typeof report === 'object' && typeof report.id === 'string' && Array.isArray(report.stages) && Array.isArray(report.samples) && report.options?.kind === 'stress'
    && report.stages.every(stage => finite(stage.index) && finite(stage.concurrency)) ? report : null;
};

export interface ConcurrencyLadderViewProps {
  zh: boolean;
  slots: number | null;
  running: boolean;
  disabled?: boolean;
  /** Steps the run walks through. */
  levels: number[];
  progress?: Pick<BenchmarkSuiteProgress, 'stageIndex' | 'concurrency' | 'completed' | 'failed' | 'elapsedMs'>;
  rows: core.ConcurrencyLadderRow[];
  finishedAt?: number;
  error?: string;
  onStart?: () => void;
  onStop?: () => void;
}

/** Pure view: running steps, bars + line, and the one-line verdict. */
export function ConcurrencyLadderView({ zh, slots, running, disabled, levels, progress, rows, finishedAt, error, onStart, onStop }: ConcurrencyLadderViewProps) {
  const t = (cn: string, en: string) => zh ? cn : en;
  const conclusion = !running && rows.length ? core.concurrencyLadderConclusion(rows) : null;
  const items = levels.map((level, i) => {
    const row = rows.find(item => item.concurrency === level);
    const live = running && progress?.stageIndex === i + 1;
    return { key: String(level), label: t(`${level} 个同时`, `${level} at once`), total: live ? null : row?.totalTokS ?? null, perRequest: row?.perRequestTokS ?? null, highlight: conclusion?.best === level && conclusion.code !== 'ladder_empty', pending: live };
  });
  const fmt = (value: number | null, digits = 1) => value === null ? '—' : value.toFixed(digits);
  const sec = (ms: number | null) => ms === null ? '—' : (ms / 1000).toFixed(2);
  return <section className="concurrency-ladder" data-testid="concurrency-ladder" data-state={running ? 'running' : rows.length ? 'result' : 'idle'}>
    <header className="concurrency-ladder-head">
      <div>
        <h3>{t('并发阶梯', 'Concurrency ladder')}</h3>
        <p>{t(`按 ${levels.join(' → ')} 个同时请求逐级加压，每级约 40 秒，看总吞吐和单个请求怎么变。`, `Steps through ${levels.join(' → ')} requests at once, about 40 s each, to show total throughput against one request's speed.`)}{slots !== null && <b>{t(` 服务当前 ${slots} 个槽。`, ` The service runs ${slots} slot${slots === 1 ? '' : 's'}.`)}</b>}</p>
      </div>
      {running ? <button type="button" className="benchmark-stop" onClick={onStop}><Square size={14}/>{t('停止', 'Stop')}</button>
        : <button type="button" className="primary" disabled={disabled} onClick={onStart} data-testid="concurrency-ladder-start"><Play size={14}/>{rows.length ? t('重新跑阶梯', 'Run ladder again') : t('开始阶梯测试', 'Run ladder')}</button>}
    </header>
    {slots === 1 && !running && <p className="concurrency-ladder-note">{t('当前一次一个：多出的请求只会排队。在配置页开启并发后再测，可看到并发的真实收益。', 'One at a time now: extra requests only queue. Turn on concurrency in the configuration page to measure its real gain.')}</p>}
    {running && progress && <ol className="concurrency-ladder-steps" aria-label={t('进度', 'Progress')}>
      {levels.map((level, i) => <li key={level} data-state={i + 1 < progress.stageIndex ? 'done' : i + 1 === progress.stageIndex ? 'live' : 'next'}>
        <strong>{level}</strong><span>{i + 1 < progress.stageIndex ? t('完成', 'done') : i + 1 === progress.stageIndex ? <><LoaderCircle size={12} className="spin"/>{t('进行中', 'running')}</> : t('等待', 'next')}</span>
      </li>)}
      <li className="concurrency-ladder-live">{t(`已完成 ${progress.completed} 个请求`, `${progress.completed} requests done`)}{progress.failed > 0 && t(` · 失败 ${progress.failed}`, ` · ${progress.failed} failed`)} · {Math.round(progress.elapsedMs / 1000)} s</li>
    </ol>}
    {conclusion && <p className="concurrency-ladder-verdict" data-code={conclusion.code} data-testid="concurrency-ladder-verdict">{core.concurrencyLadderMessage(conclusion, zh)}</p>}
    {(running || rows.length > 0) && <div className="concurrency-ladder-body">
      <ConcurrencyChart items={items} zh={zh} ariaLabel={t('并发阶梯结果', 'Concurrency ladder results')}/>
      <table className="concurrency-ladder-table">
        <thead><tr><th>{t('同时请求', 'At once')}</th><th>{t('总吞吐', 'Total')}</th><th>{t('单个请求', 'One request')}</th><th>TTFT P50</th><th>TTFT P95</th><th>{t('完成 / 失败', 'Done / failed')}</th></tr></thead>
        <tbody>{levels.map(level => { const row = rows.find(item => item.concurrency === level); return <tr key={level} data-best={conclusion?.best === level && conclusion.code === 'ladder_gain' || undefined}>
          <td>{level}</td><td>{fmt(row?.totalTokS ?? null)} <small>tok/s</small></td><td>{fmt(row?.perRequestTokS ?? null)} <small>tok/s</small></td><td>{sec(row?.ttftP50Ms ?? null)} <small>s</small></td><td>{sec(row?.ttftP95Ms ?? null)} <small>s</small></td><td>{row ? `${row.completed} / ${row.failed}` : '—'}</td>
        </tr>; })}</tbody>
      </table>
    </div>}
    {!running && finishedAt && <p className="concurrency-ladder-meta">{t('测于 ', 'Measured ')}{new Date(finishedAt).toLocaleString(zh ? 'zh-CN' : 'en-US')} · {t('输出 256 token 的持续生成请求；TTFT 包含排队。', '256-token generation requests; TTFT includes queueing.')}</p>}
    {error && <p className="concurrency-ladder-error" role="alert">{error}</p>}
  </section>;
}

/** Runner: reads the live slot count, runs the ramp on the existing stress engine and keeps the last few ladders. */
export function ConcurrencyLadder({ profile, online, disabled, language, onRunningChange }: { profile?: ServiceProfile; online: boolean; disabled: boolean; language: AppLanguage; onRunningChange: (running: boolean) => void }) {
  const zh = language === 'zh-CN';
  const [slots, setSlots] = useState<number | null>(null);
  const [report, setReport] = useState<BenchmarkSuiteReport | null>(null);
  const [samples, setSamples] = useState<BenchmarkSuiteSample[]>([]);
  const [progress, setProgress] = useState<BenchmarkSuiteProgress>();
  const [running, setRunning] = useState(false), [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; void core.loadStore<unknown>(STORE_KEY, []).then(saved => { if (!mounted.current || !Array.isArray(saved)) return; const latest = saved.map(storedLadder).find(item => item && item.profileId === profile?.id); if (latest) setReport(latest); }).catch(() => {}); return () => { mounted.current = false; controller.current?.abort(); }; }, [profile?.id]);
  useEffect(() => {
    if (!profile || !online) { setSlots(null); return; }
    let active = true;
    void core.request(profile, '/metrics').then(raw => { if (!active) return; const live = core.asObject(core.asObject(raw).live); setSlots(typeof live.parallel === 'number' && live.parallel > 0 ? live.parallel : 1); }).catch(() => { if (active) setSlots(null); });
    return () => { active = false; };
  }, [profile, online]);
  const options = useMemo(() => core.concurrencyLadderOptions(Math.max(slots ?? 1, report?.options.concurrency && !slots ? report.options.concurrency : 1)), [slots, report]);
  const levels = running || !report ? core.concurrencyLadderLevels(options.concurrency) : report.stages.map(stage => stage.concurrency);
  const start = useCallback(async () => {
    if (!profile || !online || controller.current) return;
    const abort = new AbortController(); controller.current = abort;
    setError(''); setSamples([]); setProgress(undefined); setRunning(true); onRunningChange(true);
    try {
      const result = await core.runBenchmarkSuite(profile, options, event => {
        if (!mounted.current) return;
        setProgress(event);
        if (event.sample && !event.sample.warmup) setSamples(old => [...old, event.sample!]);
      }, abort.signal);
      if (!mounted.current) return;
      setReport(result);
      const saved = await core.loadStore<unknown>(STORE_KEY, []).catch(() => []);
      const kept = [result, ...(Array.isArray(saved) ? saved.map(storedLadder).filter((item): item is BenchmarkSuiteReport => !!item) : [])].slice(0, KEEP);
      await core.saveStore(STORE_KEY, kept);
    } catch (err) { if (mounted.current) setError(core.normalizeError(err).message); }
    finally { controller.current = null; if (mounted.current) setRunning(false); onRunningChange(false); }
  }, [profile, online, options, onRunningChange]);
  const rows = useMemo(() => running ? core.concurrencyLadderRowsFromSamples(samples) : report ? core.concurrencyLadderRows(report) : [], [running, samples, report]);
  return <ConcurrencyLadderView zh={zh} slots={slots} running={running} disabled={disabled || !online || !profile} levels={levels} progress={progress} rows={rows} finishedAt={running ? undefined : report?.finishedAt} error={error} onStart={() => void start()} onStop={() => controller.current?.abort()}/>;
}
