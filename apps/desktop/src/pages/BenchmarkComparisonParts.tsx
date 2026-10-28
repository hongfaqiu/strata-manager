/** Shared A/B comparison building blocks for the scenario and context history panels. */
import type { ReactNode } from 'react';
import { Dropdown } from '../OfficialControls';
import { deltaTone, dualBarHeights, formatRelative, winAttr, type ValueDelta } from './benchmarkComparisonView';
import './benchmark-history-comparison.css';

type Option = { value: string; label: string };
type Text = (cn: string, en: string) => string;

export function ComparisonPickers({ t, options, leftId, rightId, leftMeta, rightMeta, ariaA, ariaB, placeholderB, onLeft, onRight }: {
  t: Text; options: Option[]; leftId: string; rightId: string; leftMeta: string; rightMeta: string;
  ariaA?: string; ariaB?: string; placeholderB?: string; onLeft: (id: string) => void; onRight: (id: string) => void;
}) {
  return <div className="bhc-pickers">
    <label className="bhc-picker">
      <span>{t('报告 A', 'Report A')}<em>A</em></span>
      <Dropdown ariaLabel={ariaA ?? t('报告 A', 'Report A')} value={leftId} options={options} onValueChange={onLeft}/>
      <span className="bhc-picker-meta">{leftMeta || t('选择一份历史报告', 'Pick a historical report')}</span>
    </label>
    <label className="bhc-picker">
      <span>{t('报告 B', 'Report B')}<em>B</em></span>
      <Dropdown ariaLabel={ariaB ?? t('报告 B', 'Report B')} value={rightId} placeholder={placeholderB} options={options} onValueChange={onRight}/>
      <span className="bhc-picker-meta">{rightMeta || t('选择另一份报告对照', 'Pick another report to compare')}</span>
    </label>
  </div>;
}

export type ConditionChip = { key: string; kind: 'diff' | 'unknown'; label: string };

/** Verdict banner; condition chips are always visible, never folded. */
export function ComparisonVerdict({ t, comparable, chips }: { t: Text; comparable: boolean; chips: ConditionChip[] }) {
  return <div className="bhc-verdict" data-tone={comparable ? 'ok' : 'warn'} role="status">
    <div className="bhc-verdict-head">
      <strong>{comparable
        ? t('条件已核对，可参考速度变化', 'Conditions checked; speed change is informative')
        : t('可查看数据，条件尚不支持直接提速结论', 'Values can be inspected; conditions do not support a direct speedup conclusion')}</strong>
      <span>{comparable
        ? t('结果仍取决于采样与外部负载；下方以 B 相对 A 的变化为主。', 'Results still depend on sampling and external load. Deltas below are B relative to A.')
        : t('差异或未核验项已标出；数字可并列查看，但不合并为升级结论。', 'Differences and unverified items are listed. Numbers stay side by side and are not treated as an upgrade conclusion.')}</span>
    </div>
    {chips.length > 0 && <div className="bhc-chips" aria-label={t('条件说明', 'Condition notes')}>
      {chips.map(chip => <span key={`${chip.kind}${chip.key}`} className="bhc-chip" data-kind={chip.kind}>
        {chip.kind === 'diff' ? t('条件差异', 'Difference') : t('未核验', 'Unverified')}: {chip.label}
      </span>)}
    </div>}
  </div>;
}

/** One highlight card: B value large, A beside it, B-vs-A delta and vertical A/B bars on one scale. */
export function ComparisonHighlightCard({ metric, label, unit, a, b, aShown, bShown, delta, language, aLabel = 'A', bLabel }: {
  metric: string; label: ReactNode; unit: string; a: number | null; b: number | null; aShown: string; bShown: string; delta: ValueDelta; language: string;
  /** Side names; default "A" before the A value and nothing before B, as in the history comparison. */
  aLabel?: string; bLabel?: string;
}) {
  const heights = dualBarHeights(a, b);
  return <article className="bhc-card" data-metric={metric}>
    <div className="bhc-card-copy">
      <span className="bhc-card-label">{label} · {unit}</span>
      <div className="bhc-card-values">
        <b data-win={winAttr(delta, 'b')}>{bLabel && <small className="bhc-card-side">{bLabel}</small>}{bShown}<small>{unit}</small></b>
        <span className="bhc-card-a" data-win={winAttr(delta, 'a')}>{aLabel} {aShown}</span>
        <span className="bhc-delta" data-tone={deltaTone(delta.improved)}>{formatRelative(delta.relative, language)}</span>
      </div>
    </div>
    <div className="bhc-dual" aria-hidden="true">
      <i data-side="a" style={{ height: `${Math.max(4, heights.a * 68)}px` }}/>
      <i data-side="b" style={{ height: `${Math.max(4, heights.b * 68)}px` }}/>
    </div>
  </article>;
}

/** A, B and Δ cells for one table row; the better value is bold, the other muted, ties/gaps plain. */
export function ComparisonValueCells({ aShown, bShown, delta, language }: { aShown: string; bShown: string; delta: ValueDelta; language: string }) {
  return <>
    <td className="bhc-value" data-win={winAttr(delta, 'a')}>{aShown}</td>
    <td className="bhc-value" data-win={winAttr(delta, 'b')}>{bShown}</td>
    <td><span className="bhc-delta" data-tone={deltaTone(delta.improved)}>{formatRelative(delta.relative, language)}</span></td>
  </>;
}
