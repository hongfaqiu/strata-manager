import type { AppLanguage, JsonObject } from '@strata-manager/core';
import * as core from '@strata-manager/core';
import { Dropdown } from '../OfficialControls';
import './startup-quick-params.css';

const QUICK_FIELDS = [
  'parallel',
  '--batch',
  '--batch-mtp',
  'idle_unload_s',
  '--vram-elastic',
] as const;

export function StartupQuickParams({
  language, draft, disabled, showParameterNames, fieldValue, onFieldChange,
}: {
  language: AppLanguage;
  draft?: JsonObject;
  disabled?: boolean;
  showParameterNames: boolean;
  fieldValue: (field: core.StartupFieldSpec) => string;
  onFieldChange: (field: core.StartupFieldSpec, value: string) => void;
}) {
  const zh = language === 'zh-CN';
  const fields = QUICK_FIELDS.map(key => core.STARTUP_TUNING_FIELDS.find(field => field.key === key)).filter((field): field is core.StartupFieldSpec => !!field);
  if (!draft || !fields.length) return null;
  return (
    <section className="startup-quick-params" data-testid="startup-quick-params" aria-label={zh ? '常用并发与启动参数' : 'Common batch and startup parameters'}>
      <div className="startup-quick-params-heading">
        <strong>{zh ? '常用并发与启动参数' : 'Common batch and startup parameters'}</strong>
        <p>{zh ? '对齐官方 --batch / parallel、空闲卸载与弹性显存等高频项；完整分类仍在下方。' : 'High-frequency controls for --batch / parallel, idle unload and elastic VRAM. Full categories remain below.'}</p>
      </div>
      <div className="startup-quick-params-grid">
        {fields.map(field => {
          const value = fieldValue(field);
          const label = zh ? field.zh : field.en;
          const choices = field.kind === 'boolean'
            ? [{ value: '', label: zh ? '使用默认设置' : 'Use default' }, { value: 'true', label: zh ? '开启' : 'On' }, { value: 'false', label: zh ? '关闭' : 'Off' }]
            : [{ value: '', label: zh ? '使用默认设置' : 'Use default' }, ...(field.choices ?? []).map(option => ({ value: option, label: option }))];
          return (
            <div className="st-field" key={field.key}>
              <span className="st-label">{label}</span>
              {showParameterNames && <code>{field.key}</code>}
              <Dropdown
                editable={field.kind !== 'boolean'}
                ariaLabel={label}
                disabled={disabled}
                value={value}
                editableDisplayValue={field.kind === 'boolean' ? undefined : value}
                placeholder={zh ? '使用默认设置' : 'Use default'}
                options={choices}
                onValueChange={next => onFieldChange(field, next)}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
