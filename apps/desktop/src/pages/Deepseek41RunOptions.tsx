import type { AppLanguage, JsonObject } from '@strata-manager/core';
import * as core from '@strata-manager/core';
import { Dropdown } from '../OfficialControls';
import './startup-quick-params.css';

/** DeepSeek-V4.1-Flash run options: speed (--experts 5/6, engine 0.1.50+) and load mode (--mmap-experts auto|off|on, always with a value; see deepseek41-config). */
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
  // The context setup wrote (--max-context); changing it means preparing the model again, so it is shown, not edited.
  const args = Array.isArray(draft.args) ? draft.args : [];
  const at = args.indexOf('--max-context');
  const context = at >= 0 ? Number(args[at + 1]) : NaN;
  const contextText = Number.isInteger(context) && context > 0 ? core.formatContextTokens(context, language) : '8K';
  return (
    <section className="startup-quick-params" data-testid="dsv41-run-options" aria-label={text('DeepSeek-V4.1-Flash 运行选项', 'DeepSeek-V4.1-Flash run options')}>
      <div className="startup-quick-params-heading">
        <strong>{text('DeepSeek-V4.1-Flash 运行选项', 'DeepSeek-V4.1-Flash run options')}</strong>
        <p>{text(`独立引擎${engine ? ` ${engine}` : ''}，上下文 ${contextText}（安装时选定）、仅文本；不支持速度调优与校准。保存后重启模型生效。`, `Separate engine${engine ? ` ${engine}` : ''}, ${contextText} text-only context (chosen at install); speed tuning and calibration are not supported. Restart the model after saving.`)}</p>
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
          <Dropdown ariaLabel={text('加载方式', 'Load mode')} disabled={disabled} value={load} placeholder={text('默认（自动）', 'Default (auto)')}
            options={[{ value: '', label: text('默认（自动）', 'Default (auto)') }, { value: 'auto', label: text('自动', 'Auto') }, { value: 'off', label: text('尽量复制进内存', 'Copy as much as fits into RAM') }, { value: 'on', label: text('始终从模型文件读取', 'Always read from the model files') }]}
            onValueChange={next => onChange(config => core.applyDeepseek41LoadMode(config, next as core.Deepseek41LoadMode))}/>
          <small>{text('自动（默认）：内存放得下全部专家时在加载时复制进内存（上游实测解码快 10–25%），放不下就从模型文件按需读取。尽量复制：放得下的常用专家复制进内存，其余仍从文件读取。始终从模型文件读取：不复制，经系统页缓存读取。一般无需修改。', 'Auto (default): copies every expert into RAM at load when they all fit (measured upstream: decode 10–25% faster), otherwise reads them from the model files on demand. Copy as much as fits: the most-used experts go into RAM, the rest are still read from the files. Always read from the model files: nothing is copied; reads go through the OS page cache. Usually leave it as is.')}</small>
        </div>
      </div>
      {!speedSupported && <p className="startup-quick-params-help-error" role="status" data-testid="dsv41-speed-unavailable">{text(`速度档需要 DeepSeek 引擎 ${core.DEEPSEEK41_EXPERTS_MIN_ENGINE} 或更新${engine ? `（当前 ${engine}）` : '（当前版本未知）'}，更新 Strata 后可选。`, `The speed choice needs DeepSeek engine ${core.DEEPSEEK41_EXPERTS_MIN_ENGINE} or newer${engine ? ` (current ${engine})` : ' (current version unknown)'}; update Strata to choose it.`)}</p>}
    </section>
  );
}
