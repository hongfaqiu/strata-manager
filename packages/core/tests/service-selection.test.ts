import { describe, expect, it, vi } from 'vitest';
import { restoreServiceSelection, type LocalCandidate, type ProcessStatus, type ServiceProfile } from '../src';

const profile = (id: string, managed = true): ServiceProfile => ({ id, name: id, baseUrl: 'http://127.0.0.1:18081', configPath: `D:/AI/Strata/${id}.json`, installDir: 'D:/AI/Strata', pythonPath: '', managed });
const stopped: ProcessStatus = { running: false, owned: false };
const owned: ProcessStatus = { running: true, owned: true, pid: 101 };
const external: ProcessStatus = { running: true, owned: false, external: true, pid: 102 };
const observed: LocalCandidate = { id: 'observed', name: 'Observed', installDir: 'D:/AI/Strata', pythonPath: '', configPath: 'D:/AI/Strata/external.json', modelPath: 'D:/AI/Strata/model.gguf', modelBytes: null, running: true, pid: 102, detectedPort: 18081 };

describe('read-only service selection restoration', () => {
  it('selects the actual running owned configuration over the saved wrong configuration without starting anything', async () => {
    const profiles = [profile('saved-wrong'), profile('actual')];
    const ensure = vi.fn();
    const status = vi.fn(async (profile: ServiceProfile) => profile.id === 'actual' ? owned : stopped);
    const discover = vi.fn(async () => [observed]);
    const result = await restoreServiceSelection(profiles, 'saved-wrong', status, discover);
    // Mirrors the caller's automatic preparation gate; restoring must not trigger it.
    if (result.automaticStartAllowed) ensure(result.selectedId);
    expect(result).toEqual({ selectedId: 'actual', runningOwnedIds: ['actual'], hasRunningService: true, automaticStartAllowed: false });
    expect(status.mock.calls.map(([profile]) => profile.id)).toEqual(['saved-wrong', 'actual']);
    expect(discover).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(profiles.map(profile => profile.id)).toEqual(['saved-wrong', 'actual']);
  });
  it('reads all profile states concurrently', async () => {
    const pending = new Map<string, (status: ProcessStatus) => void>();
    const status = vi.fn((profile: ServiceProfile) => new Promise<ProcessStatus>(resolve => pending.set(profile.id, resolve)));
    const result = restoreServiceSelection([profile('a'), profile('b')], 'a', status, async () => []);
    expect(status).toHaveBeenCalledTimes(2);
    pending.get('b')!(stopped);
    pending.get('a')!(owned);
    expect((await result).selectedId).toBe('a');
  });
  it('keeps a saved running owned choice among multiple running services', async () => {
    const result = await restoreServiceSelection([profile('a'), profile('b')], 'b', async () => owned);
    expect(result).toEqual({ selectedId: 'b', runningOwnedIds: ['a', 'b'], hasRunningService: true, automaticStartAllowed: false });
  });
  it('does not guess a first running service when multiple owned services are active', async () => {
    for (const saved of ['stopped', 'missing', undefined]) {
      const result = await restoreServiceSelection([profile('a'), profile('b'), profile('stopped')], saved, async profile => profile.id === 'stopped' ? stopped : owned);
      expect(result.selectedId).toBe('');
      expect(result.runningOwnedIds).toEqual(['a', 'b']);
      expect(result.automaticStartAllowed).toBe(false);
    }
  });
  it('allows automatic preparation only after all profiles stopped and discovery confirms no running service', async () => {
    const discover = vi.fn(async () => [{ ...observed, running: false }]);
    const result = await restoreServiceSelection([profile('a'), profile('saved')], 'saved', async () => stopped, discover);
    expect(result).toEqual({ selectedId: 'saved', runningOwnedIds: [], hasRunningService: false, automaticStartAllowed: true });
    expect(discover).toHaveBeenCalledOnce();
  });
  it('falls back to the first profile only when no running owned service is active', async () => {
    expect((await restoreServiceSelection([profile('a'), profile('b')], 'missing', async () => stopped, async () => [])).selectedId).toBe('a');
  });
  it('blocks automatic starts without an external discovery confirmation', async () => {
    const result = await restoreServiceSelection([profile('saved')], 'saved', async () => stopped);
    expect(result.automaticStartAllowed).toBe(false);
    expect(result.statusErrors).toBeUndefined();
  });
  it('blocks automatic starts for running external profiles and unmanaged services', async () => {
    for (const managed of [true, false]) {
      const result = await restoreServiceSelection([profile('saved'), profile('external', managed)], 'saved', async profile => profile.id === 'external' ? external : stopped, async () => []);
      expect(result).toEqual({ selectedId: 'saved', runningOwnedIds: [], hasRunningService: true, automaticStartAllowed: false });
    }
    const unmanaged = await restoreServiceSelection([profile('external', false)], 'external', async () => owned, async () => []);
    expect(unmanaged.runningOwnedIds).toEqual([]);
    expect(unmanaged.automaticStartAllowed).toBe(false);
  });
  it('blocks automatic starts if discovery finds an unregistered running service regardless of repair status', async () => {
    const result = await restoreServiceSelection([profile('saved')], 'saved', async () => stopped, async () => [{ ...observed, availability: 'repair' }]);
    expect(result).toEqual({ selectedId: 'saved', runningOwnedIds: [], hasRunningService: true, automaticStartAllowed: false });
  });
  it('continues other status reads after rejected or synchronously throwing readers and never starts automatically', async () => {
    for (const synchronous of [true, false]) {
      const status = vi.fn((profile: ServiceProfile) => {
        if (profile.id === 'failed') {
          if (synchronous) throw new Error('status unavailable');
          return Promise.reject(new Error('status unavailable'));
        }
        return Promise.resolve(stopped);
      });
      const result = await restoreServiceSelection([profile('failed'), profile('saved')], 'saved', status, async () => []);
      expect(status).toHaveBeenCalledTimes(2);
      expect(result.selectedId).toBe('saved');
      expect(result.automaticStartAllowed).toBe(false);
      expect(result.statusErrors).toEqual(['failed: status unavailable']);
    }
  });
  it('still restores a unique running owned service when another profile status is unknown', async () => {
    const result = await restoreServiceSelection([profile('failed'), profile('actual')], 'failed', async profile => {
      if (profile.id === 'failed') throw new Error('status unavailable');
      return owned;
    });
    expect(result).toMatchObject({ selectedId: 'actual', runningOwnedIds: ['actual'], hasRunningService: true, automaticStartAllowed: false });
    expect(result.statusErrors).toEqual(['failed: status unavailable']);
  });
  it('blocks automatic starts on unknown protocol status or discovery errors', async () => {
    for (const status of [null, {}, { running: false }, { running: 'false', owned: false }]) {
      const result = await restoreServiceSelection([profile('saved')], 'saved', async () => status as unknown as ProcessStatus, async () => []);
      expect(result.automaticStartAllowed).toBe(false);
      expect(result.statusErrors).toEqual(['saved: invalid service status']);
    }
    const failed = await restoreServiceSelection([profile('saved')], 'saved', async () => stopped, async () => { throw new Error('discovery unavailable'); });
    expect(failed.automaticStartAllowed).toBe(false);
    expect(failed.statusErrors).toEqual(['discovery: discovery unavailable']);
    const malformed = await restoreServiceSelection([profile('saved')], 'saved', async () => stopped, async () => null as unknown as LocalCandidate[]);
    expect(malformed.automaticStartAllowed).toBe(false);
    expect(malformed.statusErrors).toEqual(['discovery: invalid discovery result']);
    const malformedRunning = await restoreServiceSelection([profile('saved')], 'saved', async () => stopped, async () => [{ ...observed, running: 'true' }] as unknown as LocalCandidate[]);
    expect(malformedRunning.automaticStartAllowed).toBe(false);
    expect(malformedRunning.statusErrors).toEqual(['discovery: invalid discovery result']);
  });
  it('rejects process evidence explicitly identifying a different service', async () => {
    const result = await restoreServiceSelection([profile('saved')], 'saved', async () => ({ ...owned, profileId: 'other' }), async () => []);
    expect(result.runningOwnedIds).toEqual([]);
    expect(result.hasRunningService).toBe(true);
    expect(result.automaticStartAllowed).toBe(false);
    expect(result.statusErrors).toEqual(['saved: mismatched service identity']);
  });
  it('does not permit automatic preparation with no selection or an unmanaged selected profile', async () => {
    const empty = await restoreServiceSelection([], 'missing', async () => stopped, async () => []);
    expect(empty.selectedId).toBe('');
    expect(empty.automaticStartAllowed).toBe(false);
    const observer = await restoreServiceSelection([profile('observer', false)], 'observer', async () => stopped, async () => []);
    expect(observer.selectedId).toBe('observer');
    expect(observer.automaticStartAllowed).toBe(false);
  });
});
