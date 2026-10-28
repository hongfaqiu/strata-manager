import { Settings2 } from 'lucide-react';
import type { AppLanguage } from '@strata-manager/core';
import * as core from '@strata-manager/core';

/**
 * The DeepSeek-V4.1-Flash startup preset on Strata 0.2.7+: 8K (the default) up to 1M, as upstream setup offers before a pack
 * exists (dsv41_context.py; setup checks the pack's own ds4.txt limit afterwards). Past 256K is marked untested. Text only.
 */
export function Deepseek41ContextPreset({ language, quant, context, disabled, onChange }: {
  language: AppLanguage;
  quant: string;
  context: number;
  disabled?: boolean;
  onChange: (context: number) => void;
}) {
  const zh = language === 'zh-CN', text = (cn: string, en: string) => zh ? cn : en;
  const untested = core.deepseek41ContextUntested(context);
  const cost = core.deepseek41ContextCost(context, quant);
  const gb = (cost.vramBytes / 1e9).toLocaleString(language, { maximumFractionDigits: 2 });
  return (
    <div className="model-download-preset is-open" data-testid="dsv41-context-preset">
      <div className="model-download-preset-head"><Settings2 size={17}/><strong>{text('启动预设', 'Startup preset')}</strong><span>{core.formatContextTokens(context, language)} {text('上下文', 'context')}{untested ? text(' · 未测试', ' · not tested') : ''} · {text('图像关闭', 'Images off')}</span></div>
      <div className="model-download-preset-body">
        <div className="model-download-context-presets" role="group" aria-label={text('上下文长度', 'Context length')}>
          {core.deepseek41Contexts().map(value => <button key={value} type="button" className={context === value ? 'is-selected' : undefined} aria-pressed={context === value} disabled={disabled} onClick={() => onChange(value)}>
            {core.formatContextTokens(value, language)}{value === core.DEEPSEEK41_DEFAULT_CONTEXT && <small className="is-default">{text('默认', 'default')}</small>}{core.deepseek41ContextUntested(value) && <small>{text('未测试', 'not tested')}</small>}
          </button>)}
        </div>
        <p data-testid="dsv41-context-cost">{text(
          `上下文缓存约占 ${gb} GB 显存，从显卡的专家缓存里让出${cost.displacedExperts != null ? `（约 ${cost.displacedExperts.toLocaleString(language)} 个专家改从内存读取）` : ''}；按上游 0.2.7 实测（RTX 5070，1M 约 1 GB、挤出 136 个专家）估算。`,
          `The context cache takes about ${gb} GB of graphics memory from the card's expert cache${cost.displacedExperts != null ? ` (about ${cost.displacedExperts.toLocaleString(language)} experts are read from RAM instead)` : ''}; estimated from upstream 0.2.7's measurement (RTX 5070: 1M took about 1 GB and 136 experts).`,
        )}</p>
        {untested && <p role="note" className="model-download-warning" data-testid="dsv41-context-untested">{text('尚未测试：这么长的上下文会占用模型的显存，长提示读取较慢，首次回复可能要很多分钟。上游只测到 256K。', 'Not tested yet: a context this long takes graphics memory from the model and reads long prompts slowly; the first reply can take many minutes. Upstream tested up to 256K.')}</p>}
        <p>{text('模型文件自身的上限（包内 ds4.txt）由安装器在打包后再核对；速度档与加载方式在“运行配置”中调整。', 'The installer checks the limit the model files state (ds4.txt in the pack) after packing; set the speed and load mode in the run configuration.')}</p>
      </div>
    </div>
  );
}
