// Read-only access to the public Arena leaderboard (https://arena.cosfoc.com).
// Independent of the Benchmark Arena upload feature: GET only, no identity, no payload,
// short timeout. Any failure (offline, CSP, server error) resolves to "no data".
import type { ArenaGroupSummary } from './onboardingModel';

export const ARENA_PUBLIC_ENDPOINT = 'https://arena.cosfoc.com';
const TIMEOUT_MS = 6000;

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(`${ARENA_PUBLIC_ENDPOINT}${path}`, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`Arena HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export interface ArenaGroupsSnapshot { computedAt?: number; groups: ArenaGroupSummary[] }
export async function fetchArenaGroups(signal?: AbortSignal): Promise<ArenaGroupsSnapshot> {
  const data = await getJson('/v1/groups', signal) as { computedAt?: unknown; groups?: unknown };
  const groups = Array.isArray(data?.groups) ? data.groups.flatMap(item => {
    const group = item as Record<string, unknown>;
    if (typeof group.group !== 'string' || typeof group.family !== 'string' || typeof group.quant !== 'string') return [];
    const gpus = Array.isArray(group.gpus) ? group.gpus.flatMap(entry => {
      const gpu = entry as Record<string, unknown>;
      return typeof gpu.gpu === 'string' && num(gpu.vramGB) !== undefined ? [{ gpu: gpu.gpu, vramGB: num(gpu.vramGB)!, machines: num(gpu.machines) ?? 0 }] : [];
    }) : [];
    return [{ group: group.group, family: group.family, quant: group.quant, machines: num(group.machines) ?? 0, bestDecode: num(group.bestDecode), gpus }];
  }) : [];
  return { computedAt: num(data?.computedAt), groups };
}

export interface ArenaTierSpeed { decode?: number; rows: number }
/** Median decode tok/s of the matched GPU or VRAM tier for one model+quant group. */
export async function fetchArenaTier(query: string, signal?: AbortSignal): Promise<ArenaTierSpeed> {
  const data = await getJson(`/v1/leaderboard?${query}`, signal) as { tierMedian?: unknown; rows?: unknown };
  return { decode: num(data?.tierMedian), rows: Array.isArray(data?.rows) ? data.rows.length : 0 };
}
