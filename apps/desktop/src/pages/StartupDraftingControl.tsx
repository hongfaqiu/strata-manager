import type { DraftingMode, JsonObject, ServiceProfile } from '@strata-manager/core';
import * as core from '@strata-manager/core';
import { Segmented } from '../OfficialControls';
import { Dflash2Download } from './Dflash2Download';
import './startup-drafting.css';

const labels: Record<DraftingMode, [string, string]> = { auto: ['自动', 'Auto'], mtp: ['MTP', 'MTP'], dflash2: ['DFlash2', 'DFlash2'], off: ['关', 'Off'] };

interface Props {
  zh: boolean; config: JsonObject; disabled: boolean; showParameterNames: boolean;
  /** The engine version of this configuration's installation (BUILD.json), not the release; undefined while unknown. */
  engineVersion?: string | null;
  /** Whether the engine serves DFlash2 (engine 0.1.56+, `core.engineServesDflash2`); otherwise DFlash2 stays hidden. */
  dflash2Served?: boolean | null;
  /** The managed configuration, for 「下载 DFlash2」; without it no download is offered. */
  profile?: ServiceProfile | null;
  /** Whether the host machine is macOS (Metal). */
  mac?: boolean;
  onChange: (next: JsonObject) => void;
}

/** 预测（投机解码）: Auto / MTP / DFlash2 (engine 0.1.56+) / Off, written the way upstream v0.2.6 reads it for this engine version. */
export function StartupDraftingControl({ zh, config, disabled, showParameterNames, engineVersion, dflash2Served, profile, mac, onChange }: Props) {
  const t = (cn: string, en: string) => (zh ? cn : en);
  const support = core.draftingSupport(engineVersion);
  const mode = core.draftingModeOf(config);
  const family = core.draftingFamilyOf(config);
  const choices = core.draftingChoices(family, dflash2Served, mode);
  const locked = disabled || support === 'none';
  const args = Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === 'string') : [];
  const served = dflash2Served === true && support === 'drafting' && core.DRAFTING_FAMILIES.includes(String(family));
  const concurrency = core.draftingConcurrencyPolicy({ config, engineVersion, mac, dflash2Served });
  const mtpInstead = served && concurrency.blockedToMtp && (mode === 'auto' || mode === 'dflash2');
  const namedBatch = served && concurrency.runsNamedBatchDflash2 && mode === 'dflash2';
  const concurrencyNote = (mtpInstead || namedBatch) ? core.draftingConcurrencyNote(concurrency, zh) : null;
  const usesMtp = mode === 'mtp' || (mode === 'auto' && (!served || concurrency.blockedToMtp));
  const offerDownload = served && !mtpInstead && (mode === 'auto' || mode === 'dflash2') && !!profile?.managed;
  const noDraftLayer = usesMtp && !args.some(arg => arg === '--mtp' || arg.startsWith('--mtp='));
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
    {served ? <p className="startup-drafting-hint">{t('自动：单个请求按显卡与模型量化自动选择 DFlash2 或 MTP（使用 DFlash2 需先点「下载 DFlash2」，启动时不会自动下载，未下载或显卡默认 MTP 时用 MTP），多个请求自动用 MTP；手选 DFlash2 在支持显卡上可保留多并发；“关”只用主模型逐词生成。', 'Auto: for a single request, picks DFlash2 or MTP by GPU and quantization (DFlash2 needs “Download DFlash2” first; a start never downloads it and runs MTP when undownloaded or on MTP-default cards), and uses MTP for multiple requests; choosing DFlash2 explicitly keeps concurrent slots on supported GPUs; Off generates with the main model only.')}</p>
    : <p className="startup-drafting-hint">{t('MTP 用草稿层一次预测多个词再由主模型校验，通常更快；“自动”按显卡与模型选择，“关”只用主模型逐词生成，便于对比或排查。', 'MTP drafts several tokens with a small layer and the main model checks them, usually faster. Auto picks by card and model; Off generates token by token with the main model only, for comparisons or troubleshooting.')}</p>}
    {concurrencyNote && <p className="startup-drafting-hint" role="status" data-testid="drafting-dflash2-parallel">{concurrencyNote}</p>}
    {offerDownload && profile && <Dflash2Download zh={zh} profile={profile} disabled={disabled}/>}
    <p className="startup-drafting-hint" data-support={support}>{note}</p>
    {noDraftLayer && support !== 'none' && <p className="startup-drafting-hint" role="status">{t('当前配置没有 MTP 草稿层（--mtp），自动 / MTP 实际不会启用预测。', 'This configuration has no MTP draft layer (--mtp), so Auto / MTP will not actually draft.')}</p>}
  </section>;
}
