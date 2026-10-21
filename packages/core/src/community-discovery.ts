/**
 * Automatic community discovery from the Hugging Face API, with a 24 h store cache and an offline
 * fallback to the built-in entries. Failures never throw to the page: the result says what happened.
 */
import { huggingFaceApi, loadStore, saveStore } from './bridge';
import { communityFromTree, isKnownRepo, isRepoId, isRevision } from './community-catalog';
import type { CommunityModel, HfModelInfo, HfTreeEntry } from './community-catalog';

export const COMMUNITY_CACHE_KEY = 'communityDiscoveryV1';
export const COMMUNITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Searches that cover Strata's runnable layouts (GSQ-RCO shards; Unsloth UD files of Qwen3.8-Flash-Next). */
export const COMMUNITY_SEARCHES = ['GSQ-RCO', 'Qwen3.8-Flash-Next'];
const MAX_CANDIDATES = 12;

export interface CommunityCache { fetchedAt: number; entries: CommunityModel[] }
export type DiscoveryState = 'fresh' | 'cached' | 'stale' | 'offline';
export interface DiscoveryResult { entries: CommunityModel[]; fetchedAt?: number; state: DiscoveryState; error?: string }
export interface DiscoveryDeps {
  get: (path: string) => Promise<string>;
  load: () => Promise<CommunityCache | null>;
  save: (cache: CommunityCache) => Promise<void>;
  now: () => number;
}
const defaults: DiscoveryDeps = {
  get: huggingFaceApi,
  load: () => loadStore<CommunityCache | null>(COMMUNITY_CACHE_KEY, null),
  save: cache => saveStore(COMMUNITY_CACHE_KEY, cache),
  now: () => Date.now(),
};

const validCache = (value: unknown): value is CommunityCache => !!value && typeof value === 'object'
  && typeof (value as CommunityCache).fetchedAt === 'number' && Array.isArray((value as CommunityCache).entries);

/** Search → candidates (GGUF, not official / built-in) → pinned revision → tree → runnable entries. */
export async function fetchCommunityModels(get: DiscoveryDeps['get']): Promise<CommunityModel[]> {
  const seen = new Map<string, HfModelInfo>();
  let searched = 0;
  for (const term of COMMUNITY_SEARCHES) {
    try {
      const list = JSON.parse(await get(`/api/models?search=${encodeURIComponent(term)}&filter=gguf&sort=downloads&direction=-1&limit=40`)) as HfModelInfo[];
      searched++;
      for (const item of Array.isArray(list) ? list : []) {
        if (item && typeof item.id === 'string' && isRepoId(item.id) && !isKnownRepo(item.id) && !seen.has(item.id)) seen.set(item.id, item);
      }
    } catch { /* one failing search does not drop the other */ }
  }
  if (!searched) throw new Error('Hugging Face search unavailable');
  const candidates = [...seen.values()].sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0)).slice(0, MAX_CANDIDATES);
  const results = await Promise.all(candidates.map(async candidate => {
    try {
      const info = JSON.parse(await get(`/api/models/${candidate.id}`)) as HfModelInfo;
      if (!info?.sha || !isRevision(info.sha) || info.id !== candidate.id) return [];
      const tree = JSON.parse(await get(`/api/models/${candidate.id}/tree/${info.sha}?recursive=true`)) as HfTreeEntry[];
      return Array.isArray(tree) ? communityFromTree({ ...candidate, ...info }, tree) : [];
    } catch { return []; }
  }));
  return results.flat();
}

/** Cached for 24 h; `force` refreshes. Offline: the last cache (stale) or nothing (built-ins still show). */
export async function discoverCommunityModels(options: { force?: boolean } = {}, deps: Partial<DiscoveryDeps> = {}): Promise<DiscoveryResult> {
  const d = { ...defaults, ...deps };
  let cache: CommunityCache | null = null;
  try { const loaded = await d.load(); cache = validCache(loaded) ? loaded : null; } catch { cache = null; }
  const now = d.now();
  if (cache && !options.force && now - cache.fetchedAt < COMMUNITY_CACHE_TTL_MS) return { entries: cache.entries, fetchedAt: cache.fetchedAt, state: 'cached' };
  try {
    const entries = await fetchCommunityModels(d.get);
    const next = { fetchedAt: now, entries };
    try { await d.save(next); } catch { /* the list still shows */ }
    return { entries, fetchedAt: now, state: 'fresh' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return cache ? { entries: cache.entries, fetchedAt: cache.fetchedAt, state: 'stale', error: message } : { entries: [], state: 'offline', error: message };
  }
}
