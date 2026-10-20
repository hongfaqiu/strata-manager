// Engine and model storage locations (user feedback: "the engine and models can only go on C:").
import type { TaskStatus } from './types';

/** `remembered`: upstream Strata settings.json `data_dir`; `custom`: chosen in Manager; `current`: the selected engine. */
export interface StorageLocation { path: string; source: 'remembered' | 'default' | 'custom' | 'current' | 'probe'; availableBytes?: number; mountPoint?: string; usedBytes?: number; error?: string }
export interface StorageLocations { model: StorageLocation; engine: StorageLocation; currentEngine?: StorageLocation; movingTaskId?: string; probe?: StorageLocation }
export interface ModelDirectoryChange { changed: boolean; path: string; moving: boolean; task?: TaskStatus }

export const MOVE_MODEL_DATA_TASK = 'move-model-data';

/** Decimal GB like the model catalog: `82.4 GB`, `3.25 GB`, `512 MB`. */
export function formatStorageBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1e9) return `${Math.max(0, Math.round(bytes / 1e6))} MB`;
  const gb = bytes / 1e9;
  return `${gb < 10 ? gb.toFixed(2) : gb < 1000 ? gb.toFixed(1) : Math.round(gb).toLocaleString('en-US')} GB`;
}

/** The drive or mount a path lives on, for short labels: `D:`, `/mnt/data`. */
export function storageVolumeLabel(location: Pick<StorageLocation, 'path' | 'mountPoint'>): string {
  const drive = /^([a-zA-Z]:)[\\/]?/.exec(location.path)?.[1];
  if (drive) return drive.toUpperCase();
  const mount = location.mountPoint?.replace(/\\$/, '');
  return mount && mount !== '' ? mount : '/';
}

/** Progress percent from a move task message such as `正在复制模型文件：1.23 GiB / 2.10 GiB（58%）`. */
export function storageMoveProgress(message: string | undefined): number | undefined {
  const match = /[（(](\d{1,3})%[)）]/.exec(message ?? '');
  return match ? Math.min(100, Number(match[1])) : undefined;
}

/** True when moving `usedBytes` to `target` fits, keeping 1 GB spare (same rule as the backend). */
export function storageMoveFits(usedBytes: number | undefined, target: Pick<StorageLocation, 'availableBytes'> | undefined, sameVolume: boolean): boolean {
  if (sameVolume || !usedBytes) return true;
  if (target?.availableBytes === undefined) return true;
  return usedBytes <= Math.max(0, target.availableBytes - 1024 ** 3);
}

/** Move task messages are `中文 / English：amount`; show one language and keep the amount. */
export function storageMoveMessage(message: string | undefined, zh: boolean): string {
  if (!message) return '';
  const at = message.indexOf('：');
  const label = at < 0 ? message : message.slice(0, at), amount = at < 0 ? '' : message.slice(at + 1).trim();
  const slash = label.indexOf(' / ');
  const text = slash < 0 ? label.trim() : (zh ? label.slice(0, slash) : label.slice(slash + 3)).trim();
  return amount ? `${text}${zh ? '：' : ': '}${amount}` : text;
}
