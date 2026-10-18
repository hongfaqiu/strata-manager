import * as core from '@strata-manager/core';

export interface CatalogRequirement { family: string; name: string; quant: string; ramGB: number; downloadGB: number }

/** Match a model/config label against the bundled catalog. Returns undefined when it cannot be identified. */
export function catalogRequirement(text: string | undefined): CatalogRequirement | undefined {
  if (!text) return undefined;
  const lower = text.toLowerCase();
  const family = /qwen3\.?6|qwen36/.test(lower) ? 'qwen36' : /swift/.test(lower) ? 'swift' : /coder/.test(lower) ? 'coder' : /unsloth|ud-/.test(lower) ? 'unsloth' : /qwen/.test(lower) ? 'qwen' : undefined;
  const model = core.MODEL_CATALOG.find(entry => entry.family === family);
  if (!model) return undefined;
  const quant = [...model.quants].sort((a, b) => b.length - a.length).find(item => lower.includes(item.toLowerCase()));
  if (!quant) return undefined;
  const info = model.quantInfo[quant];
  return info ? { family: model.family, name: model.name, quant, ramGB: info.ramGB, downloadGB: info.downloadGB } : undefined;
}

/** Fit of a requirement against total system memory (GB). undefined when memory is unknown. */
export function fitState(ramGB: number, totalGB: number | undefined): 'fits' | 'tight' | 'over' | undefined {
  if (!totalGB) return undefined;
  if (ramGB <= totalGB * .8) return 'fits';
  if (ramGB <= totalGB) return 'tight';
  return 'over';
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
