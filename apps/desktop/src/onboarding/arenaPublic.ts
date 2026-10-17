// Read-only access to the public Arena leaderboard through the native `arena_get` command.
// The webview never reaches the network itself (CSP connect-src stays IPC-only). GET only, no identity,
// no payload, short timeout. Any failure (browser mode, offline, server error, timeout) resolves to "no data".
import * as core from '@strata-manager/core';
import type { ArenaGroupSummary } from './onboardingModel';

const TIMEOUT_MS = 6000;

async function getJson(path: 'groups' | 'leaderboard', query: Record<string, string> = {}, signal?: AbortSignal): Promise<unknown> {
  if (!core.isDesktop()) throw new Error('arena_unavailable');
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('arena_timeout')), TIMEOUT_MS);
    abort = () => reject(new Error('arena_aborted'));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([core.arenaGet<unknown>(path, query), stop]); }
  finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
}

const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export interface ArenaGroupsSnapshot { computedAt?: number; groups: ArenaGroupSummary[] }
export async function fetchArenaGroups(signal?: AbortSignal): Promise<ArenaGroupsSnapshot> {
  const data = await getJson('groups', {}, signal) as { computedAt?: unknown; groups?: unknown };
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
export async function fetchArenaTier(query: Record<string, string>, signal?: AbortSignal): Promise<ArenaTierSpeed> {
  const data = await getJson('leaderboard', query, signal) as { tierMedian?: unknown; rows?: unknown };
  return { decode: num(data?.tierMedian), rows: Array.isArray(data?.rows) ? data.rows.length : 0 };
}
