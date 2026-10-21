import { describe, expect, it, vi } from 'vitest';
import { COMMUNITY_CACHE_TTL_MS, discoverCommunityModels, fetchCommunityModels } from '../src/community-discovery';
import type { CommunityCache } from '../src/community-discovery';

const REV = 'b'.repeat(40);
const oid = 'c'.repeat(64);
const tree = [{ path: 'Q2_0/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-Q2_0-00001-of-00001.gguf', size: 45e9, lfs: { oid, size: 45e9 } }];
function hf(fail = false) {
  return vi.fn(async (path: string) => {
    if (fail) throw new Error('offline');
    if (path.startsWith('/api/models?')) return JSON.stringify([{ id: 'someone/abliterated-GGUF', downloads: 3 }, { id: 'ISTA-DASLab/official' }, { id: '../bad' }]);
    if (path === '/api/models/someone/abliterated-GGUF') return JSON.stringify({ id: 'someone/abliterated-GGUF', sha: REV });
    if (path === `/api/models/someone/abliterated-GGUF/tree/${REV}?recursive=true`) return JSON.stringify(tree);
    throw new Error(`unexpected ${path}`);
  });
}

describe('community discovery', () => {
  it('searches, pins the revision, reads the tree, and skips official / invalid repos', async () => {
    const get = hf();
    const entries = await fetchCommunityModels(get);
    expect(entries.map(entry => entry.id)).toEqual(['hf:someone/abliterated-GGUF@qwen']);
    expect(get.mock.calls.map(call => call[0]).some(path => path.includes('ISTA-DASLab') && !path.startsWith('/api/models?'))).toBe(false);
  });
  it('serves a fresh cache without the network and refreshes after 24 h', async () => {
    const cache: CommunityCache = { fetchedAt: 1000, entries: [] };
    const get = hf();
    const save = vi.fn(async () => {});
    const cached = await discoverCommunityModels({}, { get, load: async () => cache, save, now: () => 1000 + COMMUNITY_CACHE_TTL_MS - 1 });
    expect(cached.state).toBe('cached');
    expect(get).not.toHaveBeenCalled();
    const fresh = await discoverCommunityModels({}, { get, load: async () => cache, save, now: () => 1000 + COMMUNITY_CACHE_TTL_MS });
    expect(fresh.state).toBe('fresh');
    expect(fresh.entries).toHaveLength(1);
    expect(save).toHaveBeenCalledOnce();
  });
  it('falls back to the stale cache or to nothing when offline, never throwing', async () => {
    const stale = await discoverCommunityModels({ force: true }, { get: hf(true), load: async () => ({ fetchedAt: 1, entries: [] }), save: async () => {}, now: () => 2 });
    expect(stale).toMatchObject({ state: 'stale', fetchedAt: 1 });
    const offline = await discoverCommunityModels({}, { get: hf(true), load: async () => { throw new Error('no store'); }, save: async () => { throw new Error('ro'); }, now: () => 2 });
    expect(offline).toMatchObject({ state: 'offline', entries: [] });
    const corrupt = await discoverCommunityModels({}, { get: hf(true), load: async () => ({ nonsense: true }) as never, save: async () => {}, now: () => 2 });
    expect(corrupt.state).toBe('offline');
  });
});
