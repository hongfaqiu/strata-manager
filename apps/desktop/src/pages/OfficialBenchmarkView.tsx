/** Official benchmark (tools/strata_bench.py) views: the one-click run card and the official-vs-yours comparison. */
import { ArrowUpRight, Check, LoaderCircle, Play, Square } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { OfficialBenchPhase, OfficialBenchProgress, OfficialBenchReport, OfficialComparisonRow, OfficialMetricKey, OfficialReference, OfficialValue } from '@strata-manager/core';
import { Toggle } from '../OfficialControls';
import { ComparisonHighlightCard, ComparisonValueCells } from './BenchmarkComparisonParts';
import type { ValueDelta } from './benchmarkComparisonView';
import './benchmark-history-comparison.css';
import './official-benchmark.css';

type Text = (cn: string, en: string) => string;
export const officialText = (language: string): Text => (cn, en) => language === 'zh-CN' ? cn : en;

export function officialPhaseLabel(phase: OfficialBenchPhase, t: Text): string {
  return { warmup: t('预热', 'Warm-up'), chat: t('对话', 'Chat'), '4K': '4K', '16K': '16K', '32K': '32K', agent: t('智能体', 'Agent'), done: t('完成', 'Done') }[phase];
}
export function officialMetricLabel(key: OfficialMetricKey, t: Text): string {
  return {
    chatDecodeTps: t('对话解码', 'Chat decode'), chatTtftS: t('对话首字', 'Chat first token'),
    p4kTps: t('4K 预填充', '4K prompt'), p4kTtftS: t('4K 首字', '4K first token'), p16kTps: t('16K 预填充', '16K prompt'), p16kTtftS: t('16K 首字', '16K first token'),
    p32kTps: t('32K 预填充', '32K prompt'), p32kTtftS: t('32K 首字', '32K first token'),
    agentHitPct: t('智能体缓存命中', 'Agent cache hit'), agentDecodeTps: t('智能体解码', 'Agent decode'), agentTurnTtftS: t('智能体每轮首字', 'Agent first token per turn'),
  }[key];
}
const digitsFor = (value: number, unit: string) => unit === 's' ? (value < 10 ? 2 : 1) : unit === '%' ? 0 : value >= 100 ? 0 : 1;
const minDigits = (value: number, unit: string) => unit === 's' ? 1 : unit === 'tok/s' && value < 100 ? 1 : 0;
export function formatOfficialNumber(value: number | null | undefined, unit: string, language: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString(language, { maximumFractionDigits: digitsFor(value, unit), minimumFractionDigits: minDigits(value, unit) });
}
export function formatOfficialValue(value: OfficialValue | null, unit: string, language: string): string {
  if (!value) return '—';
  const n = (x: number) => formatOfficialNumber(x, unit, language);
  if (typeof value.median === 'number') return `${value.approx ? '≈' : ''}${value.printed ?? n(value.median)}`;
  return typeof value.min === 'number' && typeof value.max === 'number' ? `${n(value.min)}–${n(value.max)}` : '—';
}
const deltaOf = (row: OfficialComparisonRow): ValueDelta => ({ relative: row.relative, absolute: row.official === null || row.yours === null ? null : row.yours - row.official, improved: row.improved });

/** One-click start, the 32K switch and, while running, the step strip. */
export function OfficialBenchmarkRunCard({ language, ready, running, stopping, progress, long, elapsedMs, onLong, onStart, onStop }: {
  language: string; ready: boolean; running: boolean; stopping: boolean; progress?: OfficialBenchProgress; long: boolean; elapsedMs: number;
  onLong: (value: boolean) => void; onStart: () => void; onStop: () => void;
}) {
  const t = officialText(language);
  const plan = core.planOfficialBench({ ...core.DEFAULT_OFFICIAL_BENCH_OPTIONS, long }, null);
  const phases = progress?.phases ?? plan.phases;
  const current = progress ? phases.indexOf(progress.phase) : -1;
  const pct = progress && progress.total ? Math.min(100, Math.round(progress.done / progress.total * 100)) : 0;
  return <div className="obench-run" data-testid="official-run">
    <div className="obench-run-main">
      {running
        ? <button type="button" className="benchmark-stop obench-stop" disabled={stopping} onClick={onStop}><Square size={14}/>{stopping ? t('正在停止', 'Stopping') : t('停止', 'Stop')}</button>
        : <button type="button" className="st-btn st-btn--primary obench-start" disabled={!ready} onClick={onStart}><Play size={16}/>{t('一键开始（官方参数）', 'Start (official settings)')}</button>}
      <span className="obench-params">{t('3 轮 · 关闭思考 · 温度 0', '3 runs · thinking off · temperature 0')}</span>
      <label className="obench-long"><Toggle ariaLabel={t('含 32K', 'Include 32K')} checked={long} disabled={running} onCheckedChange={onLong}/>{t('含 32K', '32K')}</label>
    </div>
    <ol className="obench-steps" aria-label={t('测试步骤', 'Steps')}>
      {phases.map((phase, i) => {
        const state = !progress ? 'todo' : progress.phase === 'done' || i < current ? 'done' : i === current ? 'now' : 'todo';
        return <li key={phase} data-state={state}>{state === 'done' ? <Check size={12}/> : state === 'now' && running ? <LoaderCircle size={12} className="spin"/> : <i/>}{officialPhaseLabel(phase, t)}</li>;
      })}
    </ol>
    {running && <div className="obench-progress" role="status"><span style={{ width: `${pct}%` }}/><em>{progress ? `${progress.done}/${progress.total}` : ''} · {Math.round(elapsedMs / 1000)} s</em></div>}
  </div>;
}

function SourceLink({ reference, t }: { reference: OfficialReference; t: Text }) {
  return <a className="obench-source" href={reference.source.url} target="_blank" rel="noopener noreferrer">{t('来源', 'Source')} {reference.source.title}<ArrowUpRight size={11}/></a>;
}

/** The match banner: which published row this report is compared with, or that none exists. */
export function OfficialMatchBanner({ report, reference, language }: { report: OfficialBenchReport; reference: OfficialReference | null; language: string }) {
  const t = officialText(language);
  const match = core.matchOfficialReference(report.machine);
  const gpu = report.machine.gpuNames.join(' + ') || report.machine.cpuName || t('未识别硬件', 'Unknown hardware');
  if (!reference) return <div className="obench-banner" data-tone="none" data-testid="official-match">
    <strong>{t('官方暂无此配置数据', 'No official numbers for this setup')}</strong>
    <span>{t('本机', 'This PC')}：{gpu} · {report.model}{match.hardwareKnown ? t('（同硬件，但模型或量化未被官方测过）', ' (same hardware; this model or quant was not measured)') : ''}</span>
    <small>{t('官方已公布：', 'Published: ')}{core.OFFICIAL_REFERENCES.map(r => `${r.hardware.label.split(' · ')[0]} · ${r.model.label}`).join('；')}</small>
  </div>;
  return <div className="obench-banner" data-tone="match" data-testid="official-match">
    <strong>{t('官方对照', 'Official reference')} · {reference.hardware.label} · {reference.model.label}</strong>
    <span>{reference.setup}</span>
    <small>{reference.measured.date ? `${reference.measured.date} · ` : ''}Strata {reference.measured.strata} · <SourceLink reference={reference} t={t}/></small>
  </div>;
}

const HIGHLIGHTS: OfficialMetricKey[] = ['chatDecodeTps', 'p4kTps', 'p16kTps', 'p32kTps'];

/** Official vs yours: highlight cards with dual bars, then one compact table. */
export function OfficialBenchmarkResult({ report, language }: { report: OfficialBenchReport; language: string }) {
  const t = officialText(language);
  const reference = core.matchOfficialReference(report.machine).reference;
  const rows = core.officialComparisonRows(report, reference);
  const byKey = new Map(rows.map(r => [r.key, r]));
  const cards = reference ? HIGHLIGHTS.map(k => byKey.get(k)).filter((r): r is OfficialComparisonRow => !!r && r.yours !== null && r.official !== null) : [];
  const ranged = rows.some(r => r.officialIsRange && reference);
  const n = (v: number, unit: string) => formatOfficialNumber(v, unit, language);
  const yoursShown = (row: OfficialComparisonRow) => {
    if (!row.yoursStat) return '—';
    const lo = n(row.yoursStat.min, row.unit), hi = n(row.yoursStat.max, row.unit);
    return `${n(row.yoursStat.median, row.unit)}${lo !== hi ? ` (${lo}–${hi})` : ''}`;
  };
  const failures = report.results.failures.length, skipped = Object.keys(report.results.skipped);
  return <div className="obench-result" data-testid="official-result">
    <OfficialMatchBanner report={report} reference={reference} language={language}/>
    {cards.length > 0 && <div className="bhc-highlights obench-highlights">
      {cards.map(row => <ComparisonHighlightCard key={row.key} metric={row.key} label={officialMetricLabel(row.key, t)} unit={row.unit}
        a={row.official} b={row.yours} aLabel={t('官方', 'Official')} bLabel={t('你', 'You')}
        aShown={reference ? formatOfficialValue(row.officialValue, row.unit, language) : '—'} bShown={formatOfficialNumber(row.yours, row.unit, language)}
        delta={deltaOf(row)} language={language}/>)}
    </div>}
    <div className="bhc-table-wrap"><table className="bhc-table obench-table">
      <thead><tr><th>{t('指标', 'Metric')}</th>{reference && <th>{t('官方', 'Official')}</th>}<th>{t('你', 'You')}</th>{reference && <th>{t('差异', 'Change')}</th>}</tr></thead>
      <tbody>{rows.map(row => <tr key={row.key} data-highlight={HIGHLIGHTS.includes(row.key) || undefined}>
        <td>{officialMetricLabel(row.key, t)} <small>{row.unit}</small></td>
        {reference ? <ComparisonValueCells language={language} delta={deltaOf(row)} aShown={formatOfficialValue(row.officialValue, row.unit, language)} bShown={yoursShown(row)}/>
          : <td className="bhc-value">{yoursShown(row)}</td>}
      </tr>)}</tbody>
    </table></div>
    <p className="bhc-note obench-note">
      {t('你的数值为中位数（最小–最大）', 'Your values are medians (min–max)')}
      {ranged ? t('；官方仅给区间时按区间中点比较', '; where only a range is published, its midpoint is compared') : ''}
      {skipped.length ? t(`；已跳过 ${skipped.join('、')}（上下文不足）`, `; skipped ${skipped.join(', ')} (context too small)`) : ''}
      {failures ? t(`；${failures} 个请求失败`, `; ${failures} requests failed`) : ''}
      {report.state === 'cancelled' ? t('；测试已中途停止', '; stopped early') : ''}
    </p>
    {reference?.notes?.length ? <p className="bhc-note">{reference.notes.join(' ')}</p> : null}
  </div>;
}
