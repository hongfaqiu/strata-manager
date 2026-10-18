import * as core from '@strata-manager/core';

export interface CatalogRequirement { family: string; name: string; quant: string; ramGB: number; downloadGB: number }

/** Match a model/config label against the bundled catalog. Returns undefined when it cannot be identified. */
export function catalogRequirement(text: string | undefined): CatalogRequirement | undefined {
  if (!text || core.isOrcaRouterEvidence(text)) return undefined;
  const lower = text.toLowerCase();
  const family = /qwen3\.?6|qwen36/.test(lower) ? 'qwen36' : /swift/.test(lower) ? 'swift' : /coder/.test(lower) ? 'coder' : /unsloth|ud-|flash-next-q8_0/.test(lower) ? 'unsloth' : /qwen/.test(lower) ? 'qwen' : undefined;
  const model = core.MODEL_CATALOG.find(entry => entry.family === family);
  if (!model) return undefined;
  const quant = [...model.quants].sort((a, b) => b.length - a.length).find(item => lower.includes(item.toLowerCase()));
  if (!quant) return undefined;
  const info = model.quantInfo[quant];
  return info ? { family: model.family, name: model.name, quant, ramGB: info.ramGB, downloadGB: info.downloadGB } : undefined;
}

/**
 * Fit of a peak catalog RAM figure against this machine.
 * When VRAM is known, treat usable capacity as RAM + max(0, VRAM − 5 GiB) so GPU
 * offload does not show a hard "over" that blocks beginners from enabling a config.
 * `over` only when even that combined budget is short; UI must still allow 启用配置.
 */
export function fitState(ramGB: number, totalGB: number | undefined, vramGB?: number): 'fits' | 'tight' | 'over' | undefined {
  if (!totalGB) return undefined;
  if (ramGB <= totalGB * .8) return 'fits';
  if (ramGB <= totalGB) return 'tight';
  const offload = typeof vramGB === 'number' && vramGB > 0 ? Math.max(0, vramGB - 5) : 0;
  if (offload > 0 && ramGB <= totalGB + offload) return 'tight';
  return 'over';
}

/** Effective host+GPU budget used for the soft fit meter (GiB). */
export function usableMemoryGB(totalGB: number | undefined, vramGB?: number): number | undefined {
  if (!totalGB) return undefined;
  const offload = typeof vramGB === 'number' && vramGB > 0 ? Math.max(0, vramGB - 5) : 0;
  return totalGB + offload;
}

export const toGB = (bytes?: number) => bytes === undefined ? undefined : bytes / 1024 ** 3;

/** Parse download progress from a task message: "42%" or "12.3 / 83.6 GB". */
export function taskProgress(message: string | undefined): number | undefined {
  if (!message) return undefined;
  const percent = message.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  if (percent) return Math.min(100, Number(percent[1]));
  const ratio = message.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(?:GB|GiB)/i);
  if (ratio && Number(ratio[2]) > 0) return Math.min(100, Number(ratio[1]) / Number(ratio[2]) * 100);
  return undefined;
}

/** Best VRAM capacity (GiB) parsed from environmentInfo().gpus lines (nvidia-smi csv). */
export function environmentVramGB(gpus: string[] | undefined): number | undefined {
  if (!gpus?.length) return undefined;
  let best = 0;
  for (const line of gpus) {
    const memory = line.split(',').map(part => part.trim()).find(part => /\d\s*(MiB|MB|GiB|GB)$/i.test(part));
    if (!memory) continue;
    const amount = Number(memory.match(/[\d.]+/)?.[0]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const gb = /G/i.test(memory) ? amount : amount / 1024;
    if (gb > best) best = gb;
  }
  return best > 0 ? Math.round(best) : undefined;
}
