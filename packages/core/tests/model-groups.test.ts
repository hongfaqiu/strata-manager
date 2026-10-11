import { describe, expect, it } from 'vitest';
import { configurationPathKey, groupLocalModels, groupModelProfiles, modelAssetKey, type LocalCandidate, type ServiceProfile } from '../src';
const profile: ServiceProfile = { id: 'a', name: 'model', baseUrl: 'http://127.0.0.1:18081', installDir: 'D:\\AI\\Strata', pythonPath: '', configPath: 'D:\\AI\\Strata\\a.json', managed: true };
describe('local model identity', () => {
  it('groups context variants of the same weight while preserving all configurations', () => {
    const profiles = [profile, { ...profile, id: 'b' }];
    const groups = groupModelProfiles(profiles, [
      { profileId: 'a', config: { args: ['--native', 'Models/weights.gguf', '--max-context', '65536'] } },
      { profileId: 'b', config: { args: ['--native=D:\\AI\\Strata\\models\\weights.gguf', '--max-context', '524288'] } },
    ]);
    expect(groups).toHaveLength(1); expect(groups[0]?.profiles.map(p => p.id)).toEqual(['a', 'b']);
  });
  it('keeps different weights and case-sensitive POSIX files distinct', () => {
    const linux = { ...profile, installDir: '/opt/strata' };
    expect(modelAssetKey(linux, { args: ['--native', 'A.gguf'] })).not.toBe(modelAssetKey(linux, { args: ['--native', 'a.gguf'] }));
    expect(modelAssetKey(profile, { args: ['--native', 'iq2.gguf'] })).not.toBe(modelAssetKey(profile, { args: ['--native', 'iq3.gguf'] }));
  });
  it('uses the main weights across supported flag spellings and ignores companion settings', () => {
    const expected = modelAssetKey(profile, { args: ['--native', 'models/weights.gguf'] });
    for (const flag of ['--native', '--model', '-m', '--pack']) {
      expect(modelAssetKey(profile, { args: [`${flag}=models/weights.gguf`] })).toBe(expected);
    }
    expect(modelAssetKey(profile, {
      args: ['--native', 'models/weights.gguf', '--ple-gguf', 'models/ple.gguf', '--pack', 'cache/packed', '--kv', 'int8'],
      vision: { model: 'models/vision.gguf' }, parallel: 2, conversation_cache_mib: 1024,
    })).toBe(expected);
  });
  it('groups standard GGUF shard entry points using cwd and Windows path normalization', () => {
    const first = modelAssetKey(profile, { cwd: './models', args: ['--native', 'Qwen-IQ3_S-00001-of-00004.gguf'] });
    const last = modelAssetKey(profile, { cwd: 'D:\\AI\\Strata\\models\\cache\\..', args: ['--model', '.\\QWEN-IQ3_S-00004-of-00004.GGUF'] });
    expect(first).toBe(last);
    for (const path of ['models/Qwen-IQ2_XS-00001-of-00004.gguf', 'models/Qwen-IQ3_S-00001-of-00002.gguf', 'other/Qwen-IQ3_S-00001-of-00004.gguf']) {
      expect(modelAssetKey(profile, { args: ['--native', path] })).not.toBe(first);
    }
  });
  it('does not infer weight identity from malformed or repeated main flags', () => {
    expect(modelAssetKey(profile, { args: ['--native', 'a.gguf', '--native', 'b.gguf'] })).toBe(profile.id);
    expect(modelAssetKey(profile, { args: ['--native=', '--pack', 'cache.pack'] })).toBe(profile.id);
    expect(modelAssetKey(profile, { args: ['--ple-gguf', 'ple.gguf'] })).toBe(profile.id);
  });
  it('does not merge same-name profiles when asset identity cannot be read', () => {
    expect(groupModelProfiles([profile, { ...profile, id: 'b' }])).toHaveLength(2);
  });
});

const candidate: LocalCandidate = { id: 'found-a', name: 'model', installDir: profile.installDir, pythonPath: '', configPath: 'D:\\AI\\Strata\\original-a.json', modelPath: 'D:\\AI\\Strata\\models\\weights.gguf', modelBytes: 100, modelGroupKey: 'real-weights', config: { args: ['--native', 'models/weights.gguf', '--max-context', '65536'] }, configModifiedAt: 1000 };
describe('automatically discovered local models', () => {
  it('shows all discovered configurations before any model has been registered', () => {
    const groups = groupLocalModels([], [candidate, { ...candidate, id: 'found-b', configPath: 'D:\\AI\\Strata\\b.json', config: { ...candidate.config, args: ['--native', 'models/weights.gguf', '--max-context', '262144'] } }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.configurations.map(item => item.candidate?.id)).toEqual(['found-a', 'found-b']);
    expect(groups[0]?.configurations.every(item => !item.profile)).toBe(true);
  });
  it('deduplicates a registered managed copy with its original discovery and keeps edited settings', () => {
    const groups = groupLocalModels([profile], [candidate], [{ profileId: profile.id, originalConfigPath: 'd:/ai/strata/./original-a.json', config: { ...candidate.config, api_monitor: true }, configModifiedAt: 2000, lastActivatedAt: 3000 }]);
    expect(groups).toHaveLength(1); expect(groups[0]?.configurations).toHaveLength(1);
    expect(groups[0]?.configurations[0]).toMatchObject({ profile, candidate, configPath: profile.configPath, modifiedAt: 2000, lastActivatedAt: 3000, config: { api_monitor: true } });
  });
  it('deduplicates repeated discoveries using configuration path rather than candidate ids', () => {
    const groups = groupLocalModels([], [candidate, { ...candidate, id: 'another-id', configPath: 'd:/AI/Strata/original-a.json' }]);
    expect(groups[0]?.configurations).toHaveLength(1);
  });
  it('does not fill unreadable managed metadata from its original discovered file', () => {
    const groups = groupLocalModels([profile], [candidate, { ...candidate, id: 'variant', configPath: 'D:\\AI\\Strata\\variant.json' }], [{ profileId: profile.id, originalConfigPath: candidate.configPath, config: null, configModifiedAt: null }]);
    expect(groups).toHaveLength(2);
    const saved = groups.flatMap(group => group.configurations).find(entry => entry.profile);
    expect(saved).toMatchObject({ configPath: profile.configPath, config: null, modifiedAt: null });
  });
  it('merges a saved configuration with a newly found variation through real asset identity', () => {
    const groups = groupLocalModels([profile], [candidate], [{ profileId: profile.id, config: { args: ['--native', 'D:\\AI\\Strata\\models\\weights.gguf', '--max-context', '524288'] } }]);
    expect(groups).toHaveLength(1); expect(groups[0]?.configurations).toHaveLength(2);
  });
  it('does not group an edited saved copy with the original weights it used before', () => {
    const variation = { ...candidate, id: 'variation', configPath: 'D:\\AI\\Strata\\variation.json' };
    const groups = groupLocalModels([profile], [candidate, variation], [{ profileId: profile.id, originalConfigPath: candidate.configPath, config: { args: ['--native', 'models/new-weights.gguf'] } }]);
    expect(groups).toHaveLength(2);
    expect(groups.find(group => group.configurations.some(entry => entry.profile?.id === profile.id))?.configurations).toHaveLength(1);
  });
  it('groups the main GGUF bundle despite distinct native hashes for PLE and startup variations', () => {
    const first = { ...candidate, modelGroupKey: 'main-and-ple-a', modelPath: 'D:\\AI\\Strata\\models\\Qwen-00001-of-00002.gguf', config: { args: ['--native', 'models/Qwen-00001-of-00002.gguf', '--ple-gguf', 'models/ple-a.gguf'] } };
    const second = { ...candidate, id: 'variant', configPath: 'D:\\AI\\Strata\\variant.json', modelGroupKey: 'main-and-ple-b', modelPath: 'D:\\AI\\Strata\\models\\Qwen-00002-of-00002.gguf', config: { args: ['--native', 'models/Qwen-00002-of-00002.gguf', '--ple-gguf', 'models/ple-b.gguf', '--max-context', '524288'], parallel: 2, vision: { model: 'vision.gguf' }, conversation_cache_mib: 0 } };
    const groups = groupLocalModels([profile], [first, second], [{ profileId: profile.id, config: { cwd: './models', args: ['--native', 'Qwen-00002-of-00002.gguf'] } }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.configurations).toHaveLength(3);
  });
  it('does not let the native combined-asset hash merge swapped main and PLE files', () => {
    const first = { ...candidate, modelGroupKey: 'same-assets', modelPath: 'D:\\AI\\Strata\\models\\a.gguf', config: { args: ['--native', 'models/a.gguf', '--ple-gguf', 'models/b.gguf'] } };
    const second = { ...candidate, id: 'other-main', configPath: 'D:\\AI\\Strata\\other.json', modelGroupKey: 'same-assets', modelPath: 'D:\\AI\\Strata\\models\\b.gguf', config: { args: ['--native', 'models/b.gguf', '--ple-gguf', 'models/a.gguf'] } };
    expect(groupLocalModels([], [first, second])).toHaveLength(2);
  });
  it('uses a pure native main-weight hash to retain real-path aliases', () => {
    const alias = { ...candidate, id: 'alias', configPath: 'D:\\AI\\Strata\\alias.json', modelPath: 'D:\\AI\\Strata\\models\\alias.gguf', config: { args: ['--native', 'models/alias.gguf'] } };
    const groups = groupLocalModels([profile], [candidate, alias], [{ profileId: profile.id, config: { args: ['--native', 'models/alias.gguf'] } }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.configurations).toHaveLength(3);
  });
  it('does not use stale discovery metadata to alias a changed main configuration', () => {
    const stale = { ...candidate, id: 'stale', configPath: 'D:\\AI\\Strata\\stale.json', config: { args: ['--native', 'models/new-weights.gguf'] } };
    expect(groupLocalModels([], [candidate, stale])).toHaveLength(2);
  });
  it('uses the resolved model path when discovery cannot include config contents', () => {
    const first = { ...candidate, config: undefined, modelGroupKey: 'shard-1', modelPath: 'D:\\AI\\Strata\\models\\Qwen-00001-of-00002.gguf' };
    const second = { ...first, id: 'shard-2', configPath: 'D:\\AI\\Strata\\b.json', modelGroupKey: 'shard-2', modelPath: 'd:/ai/strata/models/QWEN-00002-of-00002.gguf' };
    expect(groupLocalModels([], [first, second])).toHaveLength(1);
  });
  it('keeps different weights and unreadable identities separate even when their names match', () => {
    const other = { ...candidate, id: 'different', configPath: 'D:\\AI\\Strata\\other.json', modelGroupKey: 'other-weights', config: { args: ['--native', 'models/other.gguf'] } };
    expect(groupLocalModels([], [candidate, other])).toHaveLength(2);
    expect(groupLocalModels([profile, { ...profile, id: 'unknown' }], [])).toHaveLength(2);
  });
  it('normalizes Windows path spelling while retaining POSIX case sensitivity', () => {
    expect(configurationPathKey('d:/AI/Strata/folder/../original-a.json')).toBe(configurationPathKey(candidate.configPath));
    expect(configurationPathKey('/opt/Strata/A.json')).not.toBe(configurationPathKey('/opt/Strata/a.json'));
    expect(configurationPathKey('\\\\?\\D:\\AI\\Strata\\original-a.json')).toBe(configurationPathKey(candidate.configPath));
    expect(configurationPathKey('D:/../../weights.gguf')).toBe('d:/weights.gguf');
  });
});
