import type { AppLanguage, JsonObject } from '@strata-manager/core';
import * as core from '@strata-manager/core';
import { Dropdown } from '../OfficialControls';
import './startup-quick-params.css';

/** DeepSeek-V4.1-Flash run options: speed (--experts 5/6, engine 0.1.50+) and load mode (--mmap-experts auto|off|on). */
export function Deepseek41RunOptions({ language, draft, disabled, showParameterNames, onChange }: {
  language: AppLanguage;
  draft: JsonObject;
  disabled?: boolean;
  showParameterNames: boolean;
  onChange: (operation: (config: JsonObject) => JsonObject) => void;
}) {
  const zh = language === 'zh-CN', text = (cn: string, en: string) => zh ? cn : en;
  const speedSupported = core.deepseek41SpeedSupported(draft);
  const speed = core.deepseek41Speed(draft);
  const load = core.deepseek41LoadMode(draft);
  const engine = core.deepseek41EngineVersion(draft.exe);
  return (
    <section className="startup-quick-params" data-testid="dsv41-run-options" aria-label={text('DeepSeek-V4.1-Flash 运行选项', 'DeepSeek-V4.1-Flash run options')}>
      <div className="startup-quick-params-heading">
        <strong>{text('DeepSeek-V4.1-Flash 运行选项', 'DeepSeek-V4.1-Flash run options')}</strong>
        <p>{text(`独立引擎${engine ? ` ${engine}` : ''}，上下文固定 8K、仅文本；不支持速度调优与校准。保存后重启模型生效。`, `Separate engine${engine ? ` ${engine}` : ''}, fixed 8K text-only context; speed tuning and calibration are not supported. Restart the model after saving.`)}</p>
      </div>
      <div className="startup-quick-params-grid">
        {speedSupported && <div className="st-field" data-testid="dsv41-speed">
          <span className="st-label">{text('速度档', 'Speed')}</span>
          {showParameterNames && <code>--experts</code>}
          <Dropdown ariaLabel={text('速度档', 'Speed')} disabled={disabled} value={speed} placeholder={text('默认（本机为快速/完整）', 'Default (fast or full for this PC)')}
            options={[{ value: '', label: text('默认（本机为快速/完整）', 'Default (fast or full for this PC)') }, { value: '5', label: text('快速', 'Fast') }, { value: '6', label: text('完整质量', 'Full quality') }]}
            onValueChange={next => onChange(config => core.applyDeepseek41Speed(config, next as core.Deepseek41Speed))}/>
          <small>{text('快速：每个词用 5 个专家，更快、质量略降；完整质量：6 个专家。', 'Fast: 5 experts per token, quicker with slightly lower quality; Full quality: 6 experts.')}</small>
        </div>}
        <div className="st-field" data-testid="dsv41-load-mode">
          <span className="st-label">{text('加载方式', 'Load mode')}</span>
          {showParameterNames && <code>--mmap-experts</code>}
          <Dropdown ariaLabel={text('加载方式', 'Load mode')} disabled={disabled} value={load} placeholder={text('使用默认设置', 'Use default')}
            options={[{ value: '', label: text('使用默认设置', 'Use default') }, { value: 'auto', label: text('自动', 'Auto') }, { value: 'off', label: text('全部载入内存', 'Load all into RAM') }, { value: 'on', label: text('读盘', 'Read from disk') }]}
            onValueChange={next => onChange(config => core.applyDeepseek41LoadMode(config, next as core.Deepseek41LoadMode))}/>
          <small>{text('内存不够放下全部专家时选“读盘”：专家从 SSD 读取，较慢但能运行。', 'Choose “Read from disk” when RAM cannot hold every expert: they are read from the SSD, slower but it runs.')}</small>
        </div>
      </div>
      {!speedSupported && <p className="startup-quick-params-help-error" role="status" data-testid="dsv41-speed-unavailable">{text(`速度档需要 DeepSeek 引擎 ${core.DEEPSEEK41_EXPERTS_MIN_ENGINE} 或更新${engine ? `（当前 ${engine}）` : '（当前版本未知）'}，更新 Strata 后可选。`, `The speed choice needs DeepSeek engine ${core.DEEPSEEK41_EXPERTS_MIN_ENGINE} or newer${engine ? ` (current ${engine})` : ' (current version unknown)'}; update Strata to choose it.`)}</p>}
    </section>
  );
}
