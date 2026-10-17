import type { AppLanguage } from '@strata-manager/core';
import * as core from '@strata-manager/core';
import './context-extension.css';

export interface ContextExtensionNoticeProps {
  language: AppLanguage;
  context: number;
  kv?: string;
  /** 'setup': the official installer adds the flags; 'config': the flags live in this configuration. */
  mode: 'setup' | 'config';
  scaling?: string;
  scale?: string;
  /** Raw --expert-cache value; anything other than empty/auto gets the 0 MiB free warning. */
  expertCache?: string;
  disabled?: boolean;
  /** Writes yarn + the derived factor; shown when the configured flags differ from the official ones. */
  onUseRecommended?: () => void;
}

const gib = (bytes: number, language: AppLanguage) => (bytes / 1024 ** 3).toLocaleString(language, { maximumFractionDigits: 1 });

/** One always-visible line for contexts past the trained 262K: method, factor, memory cost and what to keep. */
export function ContextExtensionNotice({ language, context, kv, mode, scaling = '', scale = '', expertCache = '', disabled, onUseRecommended }: ContextExtensionNoticeProps) {
  if (!core.isExtendedContext(context)) return null;
  const zh = language === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en;
  const factor = core.formatRopeFactor(core.ropeFactorFor(context));
  const state = mode === 'config' ? core.contextExtensionState(String(context), scaling, scale) : undefined;
  const method = mode === 'config' && state?.scaling ? state.scaling : 'yarn';
  const shownScale = mode === 'config' && state?.scale ? state.scale : factor;
  const memory = core.contextMemoryEstimate(context, kv || 'int8');
  const cache = expertCache.trim();
  const fixedCache = mode === 'config' && !!cache && cache !== 'auto';
  return <section className="context-extension" data-testid="context-extension" data-issue={state?.issue ?? (fixedCache ? 'expert_cache' : undefined)} aria-label={t('上下文扩展', 'Context extension')}>
    <div className="context-extension-head">
      <span className="context-extension-badge">{t('实验性', 'Experimental')}</span>
      <strong>{core.formatContextTokens(context, language)} {t('上下文', 'context')} · {method === 'none' ? 'RoPE none' : `${method === 'linear' ? 'Linear' : 'YaRN'} ×${shownScale}`}</strong>
      <span className="context-extension-source">{mode === 'setup' ? t('安装器自动设置', 'Set by the installer') : state?.automatic ? t('已按官方规则自动设置', 'Set automatically, official rule') : t('手动设置', 'Set manually')}</span>
    </div>
    <p>{t(`模型训练长度为 262K，超出部分用 RoPE 扩展（倍数 = 上下文 ÷ 262,144）。KV 缓存与 RoPE 表约 ${gib(memory.totalBytes, language)} GiB，比 256K 多 ${gib(memory.extraBytes, language)} GiB。`, `The model is trained on 262K; RoPE scaling covers the rest (scale = context ÷ 262,144). KV cache and RoPE tables take about ${gib(memory.totalBytes, language)} GiB, ${gib(memory.extraBytes, language)} GiB more than at 256K.`)}</p>
    <p className="context-extension-keep">{t('专家缓存保持 auto，显存剩余接近 0 MiB 时解码可能慢 7 倍；需要固定大小时请调高 --vram-reserve-mib。', 'Keep the expert cache on auto: near 0 MiB of free VRAM, decoding can slow down 7×. With a fixed size, raise --vram-reserve-mib.')}</p>
    {state?.issue && <p className="context-extension-issue" role="alert">{core.contextExtensionIssueMessage(state.issue, zh, state.derivedScale)}</p>}
    {fixedCache && <p className="context-extension-issue" role="status">{t(`当前专家缓存固定为 ${cache}，长上下文可能挤满显存。`, `The expert cache is fixed at ${cache}; a long context can fill the VRAM.`)}</p>}
    {mode === 'config' && state && !state.automatic && onUseRecommended && <button type="button" className="context-extension-apply" disabled={disabled} onClick={onUseRecommended}>{t(`改为官方设置 YaRN ×${factor}`, `Use the official YaRN ×${factor}`)}</button>}
  </section>;
}
