import type { DraftingMode, JsonObject } from '@strata-manager/core';
import * as core from '@strata-manager/core';
import { Segmented } from '../OfficialControls';
import './startup-drafting.css';

const labels: Record<DraftingMode, [string, string]> = { auto: ['自动', 'Auto'], mtp: ['MTP', 'MTP'], dflash2: ['DFlash2', 'DFlash2'], off: ['关', 'Off'] };

interface Props {
  zh: boolean; config: JsonObject; disabled: boolean; showParameterNames: boolean;
  /** The engine version of this configuration's installation (BUILD.json), not the release; undefined while unknown. */
  engineVersion?: string | null;
  /** Control's `capabilities.dflash2`. The manager has no source for it yet, so DFlash2 stays hidden. */
  dflash2Served?: boolean | null;
  onChange: (next: JsonObject) => void;
}

/** 预测（投机解码）: Auto / MTP / Off, written the way upstream v0.2.6 reads it for this engine version. */
export function StartupDraftingControl({ zh, config, disabled, showParameterNames, engineVersion, dflash2Served, onChange }: Props) {
  const t = (cn: string, en: string) => (zh ? cn : en);
  const support = core.draftingSupport(engineVersion);
  const mode = core.draftingModeOf(config);
  const choices = core.draftingChoices(core.draftingFamilyOf(config), dflash2Served, mode);
  const locked = disabled || support === 'none';
  const args = Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === 'string') : [];
  const noDraftLayer = mode !== 'off' && !args.some(arg => arg === '--mtp' || arg.startsWith('--mtp='));
  const title = t('预测（投机解码）', 'Drafting (speculative decoding)');
  const note = support === 'drafting' ? t(`写入 "drafting"；关闭时 Strata 启动会去掉 --mtp / --spec-min-p / --batch-mtp。保存并重启后生效。`, `Writes "drafting"; Off makes Strata drop --mtp / --spec-min-p / --batch-mtp at start. Applies after save and restart.`)
    : support === 'mtpSwitch' ? t(`引擎 ${engineVersion} 只认旧开关：关闭写入 "mtp": false，自动 / MTP 不写字段。保存并重启后生效。`, `Engine ${engineVersion} reads only the older switch: Off writes "mtp": false; Auto / MTP write no field. Applies after save and restart.`)
    : support === 'none' ? t(`引擎 ${engineVersion} 不支持关闭预测，需要引擎 0.1.46 或更新版本。`, `Engine ${engineVersion} cannot turn drafting off; it needs engine 0.1.46 or newer.`)
    : t('未识别引擎版本：关闭会同时写入 "drafting": "off" 与 "mtp": false，新旧引擎都会读取。保存并重启后生效。', 'Engine version unknown: Off writes both "drafting": "off" and "mtp": false so any engine reads it. Applies after save and restart.');
  return <section className="startup-tuning-group startup-drafting" aria-label={title} data-testid="startup-drafting">
    <div className="startup-drafting-row">
      <span className="startup-drafting-title"><strong>{title}</strong>{showParameterNames && <code>{support === 'mtpSwitch' ? 'mtp' : 'drafting'}</code>}</span>
      <Segmented ariaLabel={title} value={mode} onValueChange={value => { if (!locked) onChange(core.applyDrafting(config, value as DraftingMode, engineVersion)); }}
        options={choices.map(value => ({ value, label: zh ? labels[value][0] : labels[value][1], disabled: locked || (value === 'dflash2' && support !== 'drafting') }))}/>
    </div>
    <p className="startup-drafting-hint">{t('MTP 用草稿层一次预测多个词再由主模型校验，通常更快；“自动”按显卡与模型选择，“关”只用主模型逐词生成，便于对比或排查。', 'MTP drafts several tokens with a small layer and the main model checks them, usually faster. Auto picks by card and model; Off generates token by token with the main model only, for comparisons or troubleshooting.')}</p>
    <p className="startup-drafting-hint" data-support={support}>{note}</p>
    {noDraftLayer && support !== 'none' && <p className="startup-drafting-hint" role="status">{t('当前配置没有 MTP 草稿层（--mtp），自动 / MTP 实际不会启用预测。', 'This configuration has no MTP draft layer (--mtp), so Auto / MTP will not actually draft.')}</p>}
  </section>;
}
