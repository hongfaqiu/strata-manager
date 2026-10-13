import type { AppLanguage } from "@strata-manager/core";
import { Dropdown, Toggle } from '../OfficialControls';
import type { TuningRestartParameters } from '@strata-manager/core';
import './setup-tuning-interactions.css';

export function ExpertAdaptationCandidates({ value, onChange, language, disabled }: {
  value: TuningRestartParameters;
  onChange: (value: TuningRestartParameters) => void;
  language: AppLanguage;
  disabled: boolean;
}) {
  const zh = language === 'zh-CN';
  const fields = [
    { key: 'adaptEvery', label: zh ? '重排间隔' : 'Adaptation interval', values: [1, 2, 4, 8, 16], initial: 1 },
    { key: 'adaptSwaps', label: zh ? '每轮交换上限' : 'Swaps per round', values: [0, 32, 64, 80, 96, 160, 192, 256], initial: 160 },
    { key: 'adaptDecay', label: zh ? '计数衰减' : 'Count decay', values: [0.5, 0.7, 0.9, 0.92, 0.97, 1], initial: 0.97 },
  ] as const;
  const selected = fields.filter(field => value[field.key] !== undefined).length;
  return <section className="tuning-expert-options"><h4>{zh ? '专家策略（进阶）' : 'Expert strategy (advanced)'}{selected > 0 && <span>{zh ? `已选 ${selected} 项` : `${selected} selected`}</span>}</h4><div className="tuning-expert-fields">{fields.map(field => <div key={field.key}>
    <label className="tuning-toggle"><Toggle ariaLabel={field.label} disabled={disabled} checked={value[field.key] !== undefined}
      onCheckedChange={checked => { const next = { ...value }; if (checked) next[field.key] = field.initial; else delete next[field.key]; onChange(next); }}/><span>{field.label}</span></label>
    {value[field.key] !== undefined && <Dropdown ariaLabel={`${field.label} ${zh ? '候选值' : 'candidate value'}`} disabled={disabled} value={String(value[field.key])}
      options={field.values.map(n => ({ value: String(n), label: String(n) }))} onValueChange={n => onChange({ ...value, [field.key]: Number(n) })}/>}
  </div>)}</div></section>;
}
