import type { AppLanguage } from '@strata-manager/core';
import { isIntegratedGpuName, normalizeGpuSelection } from '@strata-manager/core';
import { Checkbox } from '../OfficialControls';
import './gpu-selector.css';

export type GpuOption = { id: number; name: string };

export function parseGpuSelection(value: string | undefined): { mode: 'auto' | 'all' | 'ids'; ids: number[] } {
  const text = (value ?? '').trim();
  if (!text) return { mode: 'auto', ids: [] };
  if (text === 'all') return { mode: 'all', ids: [] };
  try {
    const normalized = normalizeGpuSelection(text);
    return { mode: 'ids', ids: normalized.split(',').filter(Boolean).map(Number) };
  } catch {
    return { mode: 'auto', ids: [] };
  }
}

/**
 * Strata 0.2.9 multi-GPU defaults (upstream #4841 and the v0.2.9 notes): with no --gpu, DeepSeek on several AMD cards on
 * Linux and several Intel Arc cards now use them all (an iGPU beside a dGPU is left out; an earlier install moves at its next
 * start); AMD on Windows stays on one card, Qwen on several AMD cards still needs them named; `strata launch --gpu N` is kept.
 */
export function multiGpuAutoNote(zh: boolean): string {
  return zh
    ? '多卡电脑：Strata 0.2.9 起，自动选择会让 DeepSeek 在 Linux 上用上全部 AMD 显卡、多张 Intel Arc 显卡也默认全部使用（与独显同在的核显除外）；之前装好的 DeepSeek 下次启动也会改用全部显卡。Windows 上 AMD 仍只用一张；Qwen 用多张 AMD 显卡仍需在「指定显卡」里勾选。只想用一张：在「指定显卡」里选它，或运行 strata launch --gpu N，之后会被记住。'
    : 'Several GPUs: from Strata 0.2.9, automatic selection runs DeepSeek on every AMD card on Linux, and several Intel Arc cards are all used by default (an integrated GPU beside a discrete one is left out); a DeepSeek install set up earlier moves to all cards at its next start. AMD on Windows still uses one card; Qwen on several AMD cards still needs them picked under “Choose GPUs”. To stay on one card, pick it under “Choose GPUs” or run strata launch --gpu N; it is remembered.';
}

export function GpuSelector({
  language, value, onChange, availableGpus, disabled = false,
}: {
  language: AppLanguage;
  value: string;
  onChange: (gpus: string) => void;
  /** Cards detected on this machine (empty or missing: none known; nothing is simulated). */
  availableGpus?: GpuOption[];
  disabled?: boolean;
}) {
  const zh = language === 'zh-CN';
  const t = (cn: string, en: string) => (zh ? cn : en);
  const detected = (availableGpus ?? []).slice(0, 8);
  // The 0.2.9 all-cards note only matters with 2+ discrete cards detected here (an iGPU beside a dGPU is left out upstream).
  const multiGpu = detected.filter(gpu => !isIntegratedGpuName(gpu.name)).length > 1;
  const selection = parseGpuSelection(value);
  const setMode = (mode: 'auto' | 'all' | 'ids') => {
    if (mode === 'auto') onChange('');
    else if (mode === 'all') onChange('all');
    else onChange(selection.ids.length ? selection.ids.join(',') : String(detected[0]?.id ?? 0));
  };
  const toggleId = (id: number) => {
    const next = new Set(selection.mode === 'ids' ? selection.ids : []);
    if (next.has(id)) next.delete(id); else next.add(id);
    const ids = [...next].sort((a, b) => a - b);
    onChange(ids.length ? ids.join(',') : '');
  };
  return (
    <div className="gpu-selector" data-testid="gpu-selector" data-mode={selection.mode}>
      <div className="gpu-selector-modes" role="radiogroup" aria-label={t('显卡选择方式', 'GPU selection mode')}>
        {([['auto', t('自动选择（推荐）', 'Automatic (recommended)')], ['ids', t('指定显卡', 'Choose GPUs')], ['all', t('全部显卡', 'All GPUs')]] as const).map(([mode, label]) => (
          <label key={mode} className={`gpu-selector-mode${selection.mode === mode ? ' is-selected' : ''}`}>
            <input type="radio" name="gpu-selector-mode" checked={selection.mode === mode} disabled={disabled} onChange={() => setMode(mode)} />
            <span>{label}</span>
          </label>
        ))}
      </div>
      {selection.mode === 'ids' && (
        <div className="gpu-selector-list" role="group" aria-label={t('可用显卡', 'Available GPUs')}>
          {detected.length ? detected.map(gpu => (
            <label key={gpu.id} className={`gpu-selector-card${selection.ids.includes(gpu.id) ? ' is-selected' : ''}`}>
              <Checkbox checked={selection.ids.includes(gpu.id)} disabled={disabled} onChange={() => toggleId(gpu.id)} />
              <span><strong>GPU {gpu.id}</strong><small>{gpu.name}</small></span>
            </label>
          )) : <p className="gpu-selector-empty">{t('未检测到显卡列表，可改回自动选择，或稍后在系统页刷新。', 'No GPU list detected. Use automatic selection, or refresh on the System page later.')}</p>}
        </div>
      )}
      {selection.mode === 'auto' && multiGpu && <p className="gpu-selector-note" data-testid="gpu-auto-all-cards">{multiGpuAutoNote(zh)}</p>}
      {selection.mode === 'all' && <p className="gpu-selector-note">{t('全部显卡适合多卡推理；资源预估在“全部”模式下无法完整计算，建议改为指定编号后查看建议。', 'All GPUs suit multi-GPU inference. Resource estimates cannot fully cover “all”; choose indices to review guidance.')}</p>}
    </div>
  );
}
