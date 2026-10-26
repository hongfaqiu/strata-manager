import { asObject } from './errors';
import { defaultGpuSet } from './integrated-gpu';
import type { EnvironmentInfo, GpuDetail, JsonObject } from './types';

/** One card from the official `/metrics` `hardware.gpus` records (bytes, %, °C, W). */
export interface GpuCard {
  index: number; name: string | null; memUsed: number | null; memTotal: number | null; util: number | null; temp: number | null; power: number | null;
  /** Set by the manager's AMD merge on a small integrated Radeon beside a real card: listed, but not in the All totals. */
  integrated?: boolean;
}

const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Upstream `hardware_static.gpu_name` joins every card's name with " + " (serve/telemetry.py). */
export function splitGpuNames(joined: unknown): string[] {
  return typeof joined === 'string' ? joined.split(' + ').map(name => name.trim()).filter(Boolean) : [];
}

/** "2× NVIDIA GeForce RTX 2080 Ti", "RTX 4090 + RTX 3090" or "RTX 4090 + 2× RTX 3090"; keeps first-seen order. */
export function gpuSummary(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names.map(item => item.trim()).filter(Boolean)) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => count > 1 ? `${count}× ${name}` : name).join(' + ');
}

/** Per-card records, named from the joined static name when it has one entry per card. */
export function gpuCards(raw: unknown): GpuCard[] {
  const metrics = asObject(raw), hw = asObject(metrics.hardware), names = splitGpuNames(asObject(metrics.hardware_static).gpu_name);
  const records = Array.isArray(hw.gpus) ? hw.gpus.map(asObject) : [];
  return records.map((gpu: JsonObject, position) => ({
    index: number(gpu.index) ?? position,
    name: typeof gpu.name === 'string' && gpu.name.trim() ? gpu.name.trim() : names.length === records.length ? names[position] ?? null : null,
    memUsed: number(gpu.mem_used), memTotal: number(gpu.mem_total), util: number(gpu.util), temp: number(gpu.temp), power: number(gpu.power),
    ...(gpu.integrated === true ? { integrated: true } : {}),
  }));
}

/** The cards behind the "All GPUs" totals and count: a small integrated GPU beside a real card is left out (upstream `defaultGpuSet`). */
export function defaultGpuCards(raw: unknown): GpuCard[] {
  return defaultGpuSet(gpuCards(raw));
}

/** Display name for the whole GPU set: per-card names, else the static name, deduplicated as "N× name". */
export function gpuSetName(raw: unknown): string | null {
  const metrics = asObject(raw), names = splitGpuNames(asObject(metrics.hardware_static).gpu_name);
  const all = gpuCards(raw), cards = defaultGpuSet(all);
  // Named per-card records: the All set's names, so an integrated GPU left out of the totals is not in the title either.
  if (cards.length < all.length && cards.every(card => card.name)) return gpuSummary(cards.map(card => card.name!));
  if (cards.length > 1 && names.length === 1) return `${cards.length}× ${names[0]}`;
  return names.length ? gpuSummary(names) : null;
}

/**
 * The Apple Silicon GPU of this machine, if any. Its memory is the system RAM (unified), so callers must not add
 * it to RAM as if it were separate VRAM. `liveGpuName` (upstream `hardware_static.gpu_name`) covers a running
 * service when the environment probe is unavailable; an Apple vendor name is enough, no chip list is kept.
 */
export function unifiedGpu(environment?: Pick<EnvironmentInfo, 'gpuDetails'> | null): GpuDetail | undefined {
  return environment?.gpuDetails?.find(gpu => gpu.unifiedMemory && gpu.vendor === 'apple');
}
export function isUnifiedGpuName(name: unknown): boolean {
  return typeof name === 'string' && /^Apple\b/i.test(name.trim());
}
