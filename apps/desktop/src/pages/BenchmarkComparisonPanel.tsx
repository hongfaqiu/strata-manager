import type { AppLanguage } from '@strata-manager/core';
import { useState } from 'react';
import * as core from '@strata-manager/core';
import type { ComparableBenchmarkReport } from '@strata-manager/core';
import { Panel } from '../components';
import {
  COMPARISON_FIELDS,
  displayMetric,
  formatMetric,
  metricDelta,
  type ComparisonMetricKey,
} from './benchmarkComparisonView';
import { ComparisonHighlightCard, ComparisonPickers, ComparisonValueCells, ComparisonVerdict } from './BenchmarkComparisonParts';

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
    ? { model: '模型名称', options: '测试与缓存条件', hardware: '硬件', identity: '身份记录缺失', process: '服务与引擎进程证明', effectiveConfiguration: '实际启动配置', drafting: '预测（投机解码）', modelContent: '模型内容摘要未验证', modelIdentity: '模型文件身份', runtime: '运行时', runtimeContent: '运行时内容摘要未验证', testInput: '测试文本缺失或已省略', inputConditions: '实际输入量与缓存复用', cacheConditions: '实际缓存计数', incomplete: '包含失败、缺少轮次或未完成结果' }
    : { model: 'Model name', options: 'Test and cache conditions', hardware: 'Hardware', identity: 'Identity missing', process: 'Service and engine process evidence', effectiveConfiguration: 'Resident startup configuration', drafting: 'Drafting (speculative decoding)', modelContent: 'Model content digest unverified', modelIdentity: 'Model file identity', runtime: 'Runtime', runtimeContent: 'Runtime content digest unverified', testInput: 'Test text missing or omitted', inputConditions: 'Actual input and cache reuse', cacheConditions: 'Actual cache counters', incomplete: 'Failed, missing or incomplete samples' };
  const a = left ? core.benchmarkComparisonMetrics(left) : undefined;
  const b = right ? core.benchmarkComparisonMetrics(right) : undefined;
  const fieldName = (key: ComparisonMetricKey) => {
    const field = COMPARISON_FIELDS.find(item => item.key === key)!;
    return zh ? field.nameZh : field.nameEn;
  };
  const deltas = COMPARISON_FIELDS.map(field => metricDelta(a?.[field.key] ?? null, b?.[field.key] ?? null, field.key, field.higherBetter));
  const highlights = COMPARISON_FIELDS.filter(field => field.highlight);
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

    <ComparisonPickers t={t} options={options} leftId={left?.id ?? ''} rightId={right?.id ?? ''} leftMeta={meta(left)} rightMeta={meta(right)} onLeft={setLeftId} onRight={setRightId}/>

    {comparison && a && b ? <>
      <ComparisonVerdict t={t} comparable={comparison.comparable} chips={[
        ...comparison.differences.map(key => ({ key, kind: 'diff' as const, label: names[key] ?? key })),
        ...comparison.unknowns.map(key => ({ key, kind: 'unknown' as const, label: names[key] ?? key })),
      ]}/>

      <div className="bhc-highlights" aria-label={t('重点指标', 'Highlighted metrics')}>
        {highlights.map(field => <ComparisonHighlightCard key={field.key} metric={field.key} label={fieldName(field.key)} unit={field.unit}
          a={displayMetric(a[field.key], field.key)} b={displayMetric(b[field.key], field.key)}
          aShown={formatMetric(a[field.key], field.key, language)} bShown={formatMetric(b[field.key], field.key, language)}
          delta={deltas.find(item => item.key === field.key)!} language={language}/>)}
      </div>

      <div className="bhc-table-wrap">
        <table className="bhc-table st-table">
          <thead><tr><th>{t('指标', 'Metric')}</th><th>A</th><th>B</th><th>{t('B 相对 A', 'B vs A')}</th></tr></thead>
          <tbody>{COMPARISON_FIELDS.map(field => {
            const delta = deltas.find(item => item.key === field.key)!;
            return <tr key={field.key} data-highlight={field.highlight || undefined}>
              <td>{fieldName(field.key)} ({field.unit})</td>
              <ComparisonValueCells aShown={formatMetric(a[field.key], field.key, language)} bShown={formatMetric(b[field.key], field.key, language)} delta={delta} language={language}/>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <p className="bhc-note">{t('加粗为该项更好的一方，绿色表示 B 优于 A（延迟与占用更低，或速度与命中更高）；灰色为持平或无法计算。保存基线不会更新或启动模型。', 'Bold marks the better value. Green means B improves on A (lower latency/memory, or higher speed/hit rate). Gray is unchanged or unknown. Saving a baseline does not update or start a model.')}</p>
    </> : <p className="bhc-empty">{t('选择两份不同报告进行对照。保存基线不会更新或启动模型。', 'Select two different reports. Saving a baseline does not update or start a model.')}</p>}
  </Panel>;
}

