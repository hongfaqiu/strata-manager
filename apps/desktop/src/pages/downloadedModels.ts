// 「发现 N 个已下载模型」: GGUF sets the upstream app, Terminal or Manager already downloaded (find_downloaded_models),
// matched to catalog rows (本机已有 · 直接使用) and to configurations that already use them.
import { useQuery } from '@tanstack/react-query';
import * as core from '@strata-manager/core';
import type { DownloadedModel } from '@strata-manager/core';
import { catalogRequirement } from './d2Estimates';

/** What 使用已有模型 opens with: the model's folder and its GGUF set. */
export interface ExistingPrefill { directory: string; groupId?: string; key: number }

const sameQuant = (a: string | null | undefined, b: string) => !!a && a.toUpperCase() === b.toUpperCase();

/** Downloaded sets no configuration uses yet (a configuration names its family and quant in its name or model path). */
export function unusedDownloaded(found: DownloadedModel[] | undefined, known: { name: string; modelPath: string }[] | undefined): DownloadedModel[] {
  const used = (known ?? []).map(item => catalogRequirement(`${item.name} ${item.modelPath}`)).filter(Boolean);
  return (found ?? []).filter(item => !used.some(req => req!.family === item.group.family && sameQuant(item.group.quant, req!.quant)));
}

/** Short label: `Qwen3.8-Flash-Next · IQ3_S`. */
export const downloadedLabel = (item: DownloadedModel) => `${core.localModelBaseName(item.group)}${item.group.quant ? ` · ${item.group.quant}` : ''}`;

export function useDownloadedModels(desktop: boolean, directories: (string | undefined)[] = []) {
  const extra = [...new Set(directories.filter((dir): dir is string => !!dir))];
  return useQuery({ queryKey: ['downloaded-models', extra.join('|')], queryFn: () => core.findDownloadedModels(extra), enabled: desktop, staleTime: 30000, refetchInterval: 60000, retry: false, refetchOnWindowFocus: false });
}
