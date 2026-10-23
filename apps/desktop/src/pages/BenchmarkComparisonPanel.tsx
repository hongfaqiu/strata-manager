import type { AppLanguage } from '@strata-manager/core';
import { useState } from 'react';
import * as core from '@strata-manager/core';
import type { ComparableBenchmarkReport } from '@strata-manager/core';
import { Panel } from '../components';
import { Dropdown } from '../OfficialControls';
import {
  COMPARISON_FIELDS,
  displayMetric,
  dualBarHeights,
  formatMetric,
  formatRelative,
  metricDelta,
  type ComparisonMetricKey,
} from './benchmarkComparisonView';
import './benchmark-history-comparison.css';

export function BenchmarkComparisonPanel({ reports, current, baseline, language, disabled, replayDisabled, onBaseline, onReplay }: {
  reports: ComparableBenchmarkReport[]; current?: ComparableBenchmarkReport; baseline?: ComparableBenchmarkReport;
  language: AppLanguage; disabled: boolean; replayDisabled?: boolean; onBaseline: (report: ComparableBenchmarkReport) => void; onReplay: (report: ComparableBenchmarkReport) => void;
}) {
  const [leftId, setLeftId] = useState(''), [rightId, setRightId] = useState('');
  const zh = language === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en;
  const all = baseline && !reports.some(r => r.id === baseline.id) ? [baseline, ...reports] : reports;
  const left = all.find(r => r.id === leftId) ?? baseline ?? all[1];
  const right = all.find(r => r.id === rightId) ?? current ?? all[0];
  const comparison = left && right && left.id !== right.id ? core.compareBenchmarkReports(left, right) : undefined;
  const label = (r: ComparableBenchmarkReport) => `${new Date(r.startedAt).toLocaleString(language)} · ${r.model}`;
  const meta = (r?: ComparableBenchmarkReport) => r ? `${r.model} · ${new Date(r.startedAt).toLocaleString(language)}` : '';
  const names: Record<string, string> = zh
    ? { model: '模型名称', options: '测试与缓存条件', hardware: '硬件', identity: '身份记录缺失', process: '服务与引擎进程证明', effectiveConfiguration: '实际启动配置', modelContent: '模型内容摘要未验证', modelIdentity: '模型文件身份', runtime: '运行时', runtimeContent: '运行时内容摘要未验证', testInput: '测试文本缺失或已省略', inputConditions: '实际输入量与缓存复用', cacheConditions: '实际缓存计数', incomplete: '包含失败、缺少轮次或未完成结果' }
    : { model: 'Model name', options: 'Test and cache conditions', hardware: 'Hardware', identity: 'Identity missing', process: 'Service and engine process evidence', effectiveConfiguration: 'Resident startup configuration', modelContent: 'Model content digest unverified', modelIdentity: 'Model file identity', runtime: 'Runtime', runtimeContent: 'Runtime content digest unverified', testInput: 'Test text missing or omitted', inputConditions: 'Actual input and cache reuse', cacheConditions: 'Actual cache counters', incomplete: 'Failed, missing or incomplete samples' };
  const a = left ? core.benchmarkComparisonMetrics(left) : undefined;
  const b = right ? core.benchmarkComparisonMetrics(right) : undefined;
  const fieldName = (key: ComparisonMetricKey) => {
    const field = COMPARISON_FIELDS.find(item => item.key === key)!;
    return zh ? field.nameZh : field.nameEn;
  };
  const deltas = COMPARISON_FIELDS.map(field => metricDelta(a?.[field.key] ?? null, b?.[field.key] ?? null, field.key, field.higherBetter));
  const highlights = COMPARISON_FIELDS.filter(field => field.highlight);
  const tone = (improved: boolean | null) => improved === null ? 'flat' : improved ? 'up' : 'down';
  const options = all.map(r => ({ value: r.id, label: label(r) }));
  const canReplay = !!baseline && 'schemaVersion' in baseline && [2, 3].includes(baseline.schemaVersion);

  return <Panel title={t('历史与升级对照', 'History and upgrade comparison')} className="benchmark-history-comparison">
    <div className="bhc-toolbar">
      <div className="actions">
        <button type="button" disabled={disabled || !current || current.state !== 'completed'} onClick={() => current && onBaseline(current)}>{t('保存升级前基线', 'Save pre-upgrade baseline')}</button>
        <button type="button" disabled={disabled || replayDisabled || !canReplay} onClick={() => baseline && onReplay(baseline)}>{t('按基线串行重跑', 'Replay baseline serially')}</button>
      </div>
      {baseline && <span className="bhc-baseline">{t('已保存基线', 'Saved baseline')}<strong title={label(baseline)}>{label(baseline)}</strong></span>}
    </div>

    <div className="bhc-pickers">
      <label className="bhc-picker">
        <span>{t('报告 A', 'Report A')}<em>A</em></span>
        <Dropdown ariaLabel={t('报告 A', 'Report A')} value={left?.id ?? ''} options={options} onValueChange={setLeftId}/>
        <span className="bhc-picker-meta">{meta(left) || t('选择一份历史报告', 'Pick a historical report')}</span>
      </label>
      <label className="bhc-picker">
        <span>{t('报告 B', 'Report B')}<em>B</em></span>
        <Dropdown ariaLabel={t('报告 B', 'Report B')} value={right?.id ?? ''} options={options} onValueChange={setRightId}/>
        <span className="bhc-picker-meta">{meta(right) || t('选择另一份报告对照', 'Pick another report to compare')}</span>
      </label>
    </div>

    {comparison && a && b ? <>
      <div className="bhc-verdict" data-tone={comparison.comparable ? 'ok' : 'warn'} role="status">
        <div className="bhc-verdict-head">
          <strong>{comparison.comparable
            ? t('条件已核对，可参考速度变化', 'Conditions checked; speed change is informative')
            : t('可查看数据，条件尚不支持直接提速结论', 'Values can be inspected; conditions do not support a direct speedup conclusion')}</strong>
          <span>{comparison.comparable
            ? t('结果仍取决于采样与外部负载；下方以 B 相对 A 的变化为主。', 'Results still depend on sampling and external load. Deltas below are B relative to A.')
            : t('差异或未核验项已标出；数字可并列查看，但不合并为升级结论。', 'Differences and unverified items are listed. Numbers stay side by side and are not treated as an upgrade conclusion.')}</span>
        </div>
        {(comparison.differences.length > 0 || comparison.unknowns.length > 0) && <div className="bhc-chips" aria-label={t('条件说明', 'Condition notes')}>
          {comparison.differences.map(key => <span key={`d${key}`} className="bhc-chip" data-kind="diff">{t('条件差异', 'Difference')}: {names[key] ?? key}</span>)}
          {comparison.unknowns.map(key => <span key={`u${key}`} className="bhc-chip" data-kind="unknown">{t('未核验', 'Unverified')}: {names[key] ?? key}</span>)}
        </div>}
      </div>

      <div className="bhc-highlights" aria-label={t('重点指标', 'Highlighted metrics')}>
        {highlights.map(field => {
          const delta = deltas.find(item => item.key === field.key)!;
          const heights = dualBarHeights(displayMetric(a[field.key], field.key), displayMetric(b[field.key], field.key));
          return <article key={field.key} className="bhc-card" data-metric={field.key}>
            <div className="bhc-card-copy">
              <span className="bhc-card-label">{fieldName(field.key)} · {field.unit}</span>
              <div className="bhc-card-values">
                <b>{formatMetric(b[field.key], field.key, language)}<small>{field.unit}</small></b>
                <span>A {formatMetric(a[field.key], field.key, language)}</span>
                <span className="bhc-delta" data-tone={tone(delta.improved)}>{formatRelative(delta.relative, language)}</span>
              </div>
            </div>
            <div className="bhc-dual" aria-hidden="true">
              <i data-side="a" style={{ height: `${Math.max(4, heights.a * 68)}px` }}/>
              <i data-side="b" style={{ height: `${Math.max(4, heights.b * 68)}px` }}/>
            </div>
          </article>;
        })}
      </div>

      <div className="bhc-table-wrap">
        <table className="bhc-table st-table">
          <thead><tr><th>{t('指标', 'Metric')}</th><th>A</th><th>B</th><th>{t('B 相对 A', 'B vs A')}</th></tr></thead>
          <tbody>{COMPARISON_FIELDS.map(field => {
            const delta = deltas.find(item => item.key === field.key)!;
            return <tr key={field.key} data-highlight={field.highlight || undefined}>
              <td>{fieldName(field.key)} ({field.unit})</td>
              <td>{formatMetric(a[field.key], field.key, language)}</td>
              <td>{formatMetric(b[field.key], field.key, language)}</td>
              <td><span className="bhc-delta" data-tone={tone(delta.improved)}>{formatRelative(delta.relative, language)}</span></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <p className="bhc-note">{t('绿色表示 B 优于 A（延迟与占用更低，或速度与命中更高）；灰色为持平或无法计算。保存基线不会更新或启动模型。', 'Green means B improves on A (lower latency/memory, or higher speed/hit rate). Gray is unchanged or unknown. Saving a baseline does not update or start a model.')}</p>
    </> : <p className="bhc-empty">{t('选择两份不同报告进行对照。保存基线不会更新或启动模型。', 'Select two different reports. Saving a baseline does not update or start a model.')}</p>}
  </Panel>;
}

