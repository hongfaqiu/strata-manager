import type { AppLanguage } from '@strata-manager/core';
import { normalizeGpuSelection } from '@strata-manager/core';
import { Checkbox } from '../OfficialControls';
import './gpu-selector.css';

export type GpuOption = { id: number; name: string };

export const MOCK_GPUS: GpuOption[] = [
  { id: 0, name: 'NVIDIA GeForce RTX 4090 (24 GB)' },
  { id: 1, name: 'NVIDIA GeForce RTX 4090 (24 GB)' },
];

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

export function GpuSelector({
  language, value, onChange, availableGpus, disabled = false, allowMockFallback = true,
}: {
  language: AppLanguage;
  value: string;
  onChange: (gpus: string) => void;
  availableGpus?: GpuOption[];
  disabled?: boolean;
  allowMockFallback?: boolean;
}) {
  const zh = language === 'zh-CN';
  const t = (cn: string, en: string) => (zh ? cn : en);
  const detected = (availableGpus?.length ? availableGpus : allowMockFallback ? MOCK_GPUS : []).slice(0, 8);
  const usingMock = !availableGpus?.length && allowMockFallback && detected.length > 0;
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
    <div className="gpu-selector" data-testid="gpu-selector" data-mode={selection.mode} data-mock={usingMock || undefined}>
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
      {selection.mode === 'all' && <p className="gpu-selector-note">{t('全部显卡适合多卡推理；资源预估在“全部”模式下无法完整计算，建议改为指定编号后查看建议。', 'All GPUs suit multi-GPU inference. Resource estimates cannot fully cover “all”; choose indices to review guidance.')}</p>}
      {usingMock && <p className="gpu-selector-note" role="status">{t('浏览器预览使用模拟双卡列表；桌面应用会读取本机检测结果。', 'Browser preview uses a simulated dual-GPU list; the desktop app reads detected hardware.')}</p>}
    </div>
  );
}
