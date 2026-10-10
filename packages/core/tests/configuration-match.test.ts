import { describe, expect, it } from 'vitest';
import { compareRunningConfiguration, type JsonObject, type LocalCandidate, type ServiceProfile } from '../src';

const root = 'D:/AI/Strata';
const config = { exe: 'engine/strata.exe', cwd: root, args: ['--native', 'models/qwen.gguf', '--max-context', '524288'], model_name: 'Qwen', port: 18081, parallel: 1, sampling: { temperature: 0.6 } };
const running: LocalCandidate = { id: 'running', name: 'Qwen', configPath: `${root}/actual.json`, installDir: root, pythonPath: '', modelPath: `${root}/models/qwen.gguf`, modelBytes: 100, running: true, pid: 101, detectedPort: 18081, config };
const candidate = (id: string, settings: JsonObject = config): LocalCandidate => ({ ...running, id, configPath: `${root}/${id}.json`, running: false, config: settings });
const profile: ServiceProfile = { id: 'imported', name: 'Imported Qwen', configPath: 'C:/Manager/imports/qwen/config.json', installDir: root, pythonPath: '', baseUrl: 'http://127.0.0.1:18081', managed: true };

describe('running configuration identification', () => {
  it('identifies the observed file by normalized path before equivalent names or timestamps', () => {
    const exact = { ...candidate('actual'), configPath: 'd:\\AI\\Strata\\folder\\..\\actual.json' };
    const other = { ...candidate('recent'), configModifiedAt: Date.now() };
    const result = compareRunningConfiguration(running, [other, exact]);
    expect(result.resolvedMatch?.candidateIds).toEqual(['actual']);
    expect(result.exactMatches[0]?.match).toBe('exact');
    expect(result.equivalentMatches.map(entry => entry.candidateIds)).toEqual([['recent']]);
    expect(result.ambiguous).toBe(false);
  });
  it('keeps a Manager private copy and its manifest source distinct, including import rewrites', () => {
    const importedConfig = { ...config, log: 'C:/Manager/imports/qwen/engine.log', open_browser: false, host: '127.0.0.1' };
    const actual = { ...running, configPath: profile.configPath, config: importedConfig };
    const original = candidate('original', { ...config, log: 'strata.log', open_browser: true, host: '0.0.0.0' });
    const result = compareRunningConfiguration(actual, [original], [profile], [{ profileId: profile.id, originalConfigPath: original.configPath, config: importedConfig }]);
    expect(result.resolvedMatch).toMatchObject({ configPath: profile.configPath, profileIds: [profile.id], match: 'exact', originalConfigPaths: [original.configPath] });
    expect(result.sourceMatches).toHaveLength(1);
    expect(result.sourceMatches[0]).toMatchObject({ configPath: original.configPath, pathRelation: 'import-source', match: 'different', contentMatch: 'different' });
    expect(result.sourceMatches[0]?.differences.map(item => item.path)).toEqual(['/host', '/log', '/open_browser']);
  });
  it('deduplicates records of the same path, without merging different files with equal contents', () => {
    const actual = { ...running, configPath: profile.configPath };
    const result = compareRunningConfiguration(actual, [actual, { ...actual, id: 'duplicate' }, candidate('same-content')], [profile], [{ profileId: profile.id, config }]);
    expect(result.comparisons).toHaveLength(2);
    expect(result.resolvedMatch).toMatchObject({ candidateIds: ['running', 'duplicate'], profileIds: [profile.id] });
  });
  it('does not present a derived private copy as the original file used by an external process', () => {
    const result = compareRunningConfiguration(running, [], [profile], [{ profileId: profile.id, originalConfigPath: running.configPath, config }]);
    expect(result.resolvedMatch).toBeUndefined();
    expect(result.sourceMatches).toEqual([]);
    expect(result.comparisons[0]).toMatchObject({ pathRelation: 'none', match: 'equivalent', configPath: profile.configPath });
  });
  it('reports multiple equal-content files as ambiguous and never chooses the newest one', () => {
    const result = compareRunningConfiguration(running, [candidate('a'), { ...candidate('b'), configModifiedAt: Date.now() }]);
    expect(result.resolvedMatch).toBeUndefined();
    expect(result.equivalentMatches.map(entry => entry.configPath)).toEqual([`${root}/a.json`, `${root}/b.json`]);
    expect(result.ambiguous).toBe(true);
  });
  it('retains case-sensitive POSIX paths', () => {
    const actual = { ...running, installDir: '/opt/strata', configPath: '/opt/strata/A.json' };
    const result = compareRunningConfiguration(actual, [{ ...actual, id: 'lower', configPath: '/opt/strata/a.json' }]);
    expect(result.exactMatches).toEqual([]);
    expect(result.equivalentMatches).toHaveLength(1);
  });
  it('does not replace unreadable registered config with a discovered snapshot', () => {
    const actual = { ...running, configPath: profile.configPath };
    const result = compareRunningConfiguration(actual, [actual], [profile], [{ profileId: profile.id, config: null }]);
    expect(result.resolvedMatch).toMatchObject({ match: 'exact', contentMatch: 'unknown', differences: [] });
  });
  it('reports conflicting snapshots of the same path without relying on list order', () => {
    const changed = { ...running, id: 'changed-snapshot', config: { ...config, port: 18082 } };
    for (const candidates of [[running, changed], [changed, running]]) {
      const result = compareRunningConfiguration(running, candidates);
      expect(result.comparisons).toHaveLength(1);
      expect(result.resolvedMatch).toMatchObject({ match: 'exact', contentMatch: 'unknown', contentUnknownReason: 'conflicting-snapshots' });
    }
  });
  it('includes later profile snapshots and preserves explicit unreadability for duplicate paths', () => {
    const actual = { ...running, configPath: profile.configPath };
    const second = { ...profile, id: 'second' };
    const known = compareRunningConfiguration(actual, [], [profile, second], [{ profileId: second.id, config }]);
    expect(known.resolvedMatch?.contentMatch).toBe('equivalent');
    for (const profiles of [[profile, second], [second, profile]]) {
      const unavailable = compareRunningConfiguration(actual, [actual], profiles, [{ profileId: second.id, config: null }]);
      expect(unavailable.resolvedMatch).toMatchObject({ match: 'exact', contentMatch: 'unknown', contentUnknownReason: 'unreadable' });
    }
  });
  it('compares all mixed masked and raw snapshots without treating masked compatibility as transitive equality', () => {
    const actual = { ...running, config: { ...config, api_key: 'private-first' } };
    const masked = { ...actual, id: 'masked', config: { ...config, api_key: '[已隐藏]' } };
    const different = { ...actual, id: 'different', config: { ...config, api_key: 'private-second' } };
    for (const candidates of [[masked, different], [different, masked]]) {
      const result = compareRunningConfiguration(actual, candidates);
      expect(result.resolvedMatch?.contentMatch).toBe('different');
      expect(JSON.stringify(result)).not.toContain('private-first');
      expect(JSON.stringify(result)).not.toContain('private-second');
    }
    for (const candidates of [[masked, actual, different], [actual, masked, different], [different, actual, masked]]) {
      const result = compareRunningConfiguration(actual, candidates);
      expect(result.resolvedMatch).toMatchObject({ contentMatch: 'unknown', contentUnknownReason: 'conflicting-snapshots' });
    }
  });
});

describe('complete configuration comparison', () => {
  it('ignores object key ordering and resolves the cwd materialized during import', () => {
    const variant = { sampling: { temperature: 0.6 }, parallel: 1, port: 18081, model_name: 'Qwen', args: [...config.args], cwd: '.', exe: 'engine/strata.exe' };
    expect(compareRunningConfiguration(running, [candidate('ordered', variant)]).equivalentMatches).toHaveLength(1);
  });
  it('compares startup, cache, sampling, vision and custom fields beyond weights/name/port', () => {
    const actual = { ...running, config: { ...config, conversation_cache_mib: 0, vision: { model: 'vision-a.gguf' }, custom: { feature: true } } };
    const changed = candidate('changed', { ...config, args: ['--native', 'models/qwen.gguf', '--max-context', '262144'], parallel: 2, sampling: { temperature: 0.7 }, conversation_cache_mib: 512, vision: { model: 'vision-b.gguf' }, custom: { feature: false } });
    const compared = compareRunningConfiguration(actual, [changed]).comparisons[0];
    expect(compared).toMatchObject({ match: 'different', contentMatch: 'different' });
    expect(compared?.differences.map(item => item.path)).toEqual(['/args/3', '/conversation_cache_mib', '/custom/feature', '/parallel', '/sampling/temperature', '/vision/model']);
  });
  it('preserves array order and differences between absence and null', () => {
    const actual = { ...running, config: { ...config, extras: [1, 2], optional: null } };
    const changed = candidate('changed', { ...config, extras: [2, 1] });
    expect(compareRunningConfiguration(actual, [changed]).comparisons[0]?.differences.map(item => item.path)).toEqual(['/extras/0', '/extras/1', '/optional']);
  });
  it('ignores only masked credential values, keeps field presence and never emits secrets', () => {
    const actual = { ...running, config: { ...config, api_key: '[已隐藏]', nested: { authorization: '[已隐藏]', visible: 1 } } };
    const same = candidate('same', { ...config, api_key: 'do-not-expose', nested: { authorization: 'Bearer do-not-expose', visible: 1 } });
    const result = compareRunningConfiguration(actual, [same]);
    expect(result.equivalentMatches[0]?.ignoredPaths).toEqual(['/api_key', '/nested/authorization']);
    expect(JSON.stringify(result)).not.toContain('do-not-expose');
    const absent = compareRunningConfiguration(actual, [candidate('absent')]).comparisons[0];
    expect(absent?.contentMatch).toBe('different');
    expect(absent?.differences).toContainEqual({ path: '/api_key', kind: 'missing-candidate', runningValue: '[已隐藏]', candidateValue: undefined });
    const raw = compareRunningConfiguration({ ...running, config: { ...config, api_key: 'one-secret' } }, [candidate('raw', { ...config, api_key: 'another-secret' })]);
    expect(raw.comparisons[0]?.contentMatch).toBe('different');
    expect(JSON.stringify(raw)).not.toContain('one-secret');
    expect(JSON.stringify(raw)).not.toContain('another-secret');
    const structured = compareRunningConfiguration({ ...running, config: { ...config, credentials: { service: ['hidden-first'] } } }, [candidate('structured', { ...config, credentials: { service: ['hidden-second', 'hidden-third'] } })]);
    expect(structured.comparisons[0]?.contentMatch).toBe('different');
    expect(JSON.stringify(structured)).not.toContain('hidden-first');
    expect(JSON.stringify(structured)).not.toContain('hidden-second');
    expect(JSON.stringify(structured)).not.toContain('hidden-third');
  });
  it('does not discard guessed Manager metadata or a matching model name', () => {
    const actual = { ...running, config: { ...config, _manager: { mode: 1 } } };
    expect(compareRunningConfiguration(actual, [candidate('changed', { ...config, _manager: { mode: 2 } })]).comparisons[0]?.differences[0]?.path).toBe('/_manager/mode');
  });
  it('keeps missing or invalid JSON content unknown instead of inferring from model assets', () => {
    for (const value of [undefined, { ...config, unknown: undefined }, { ...config, port: NaN }, { ...config, cwd: 1 }]) {
      const result = compareRunningConfiguration(running, [{ ...candidate('unreadable'), config: value }]);
      expect(result.comparisons[0]).toMatchObject({ match: 'unknown', contentMatch: 'unknown' });
      expect(result.equivalentMatches).toEqual([]);
    }
  });
});
