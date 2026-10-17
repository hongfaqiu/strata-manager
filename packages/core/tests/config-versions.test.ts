import { describe, expect, it } from 'vitest';
import { compareRuntimeVersions, configurationFingerprint, focusModelGroup, groupLocalModels, hiddenVersionCount, resolveCurrentInstallDir, runtimeVersionIndex, type LocalCandidate } from '../src';

// Upstream layout: each version folder has its own strata-<model>.json; all of
// them point at the same shards and MTP layer in the shared Strata-data folder.
const data = 'D:\\AI\\Strata-data';
const versions = ['0.1.38', '0.1.42', '0.1.44'] as const;
const models = [
  { tag: 'qwen-ud-q4_k_xl', weights: `${data}\\models\\Qwen-UD-Q4_K_XL-00001-of-00003.gguf`, mtp: `${data}\\mtp\\qwen-mtp.gguf`, context: '65536' },
  { tag: 'qwen-iq2_xs', weights: `${data}\\models\\Qwen-IQ2_XS-00001-of-00002.gguf`, mtp: `${data}\\mtp\\qwen-mtp.gguf`, context: '131072' },
];
const install = (version: string) => `D:\\AI\\Strata-${version}`;
function fixture(changed: (version: string, tag: string) => boolean = () => false): LocalCandidate[] {
  return versions.flatMap((version, v) => models.map((model, m) => {
    const root = install(version);
    return {
      id: `found-${version}-${model.tag}`, name: `strata-${model.tag}`, installDir: root, pythonPath: `${root}\\.venv\\Scripts\\python.exe`,
      configPath: `${root}\\strata-${model.tag}.json`, modelPath: model.weights, modelBytes: 1000, modelGroupKey: `weights-${m}`, runtimeVersion: version, configModifiedAt: 1000 + v * 10 + m,
      config: { exe: `${root}\\engine\\strata.exe`, cwd: root, tokenizer: 'pack/tokenizer', log: `strata-${model.tag}.log`, model_name: model.tag, port: 8080,
        args: ['--native', model.weights, '--mtp', model.mtp, '--max-context', changed(version, model.tag) ? '32768' : model.context] },
    };
  }));
}

describe('multi-version configuration view', () => {
  it('orders versions numerically and treats unknown as oldest', () => {
    expect(compareRuntimeVersions('0.1.44', '0.1.38')).toBeGreaterThan(0);
    expect(compareRuntimeVersions('0.1.44.1', '0.1.44')).toBeGreaterThan(0);
    expect(compareRuntimeVersions('0.1.9', '0.1.10')).toBeLessThan(0);
    expect(compareRuntimeVersions(undefined, '0.1.0')).toBeLessThan(0);
  });

  it('groups 3 versions × 2 models into two model groups sharing the weights', () => {
    const groups = groupLocalModels([], fixture());
    expect(groups).toHaveLength(2);
    expect(groups.map(group => group.configurations.length)).toEqual([3, 3]);
  });

  it('shows the current version by default, newest first, and keeps every configuration reachable', () => {
    const candidates = fixture(version => version === '0.1.38');
    const index = runtimeVersionIndex(candidates);
    for (const group of groupLocalModels([], candidates)) {
      const focused = focusModelGroup(group, { currentInstallDir: install('0.1.44'), versions: index });
      expect(focused.fallback).toBe(false);
      expect(focused.primary.map(row => row.version)).toEqual(['0.1.44']);
      // 0.1.42 is an identical copy of 0.1.44 and merges into it; 0.1.38 differs.
      expect(focused.primary[0]!.duplicates.map(row => row.version)).toEqual(['0.1.42']);
      expect(focused.others.map(row => row.version)).toEqual(['0.1.38']);
      expect(hiddenVersionCount(focused)).toBe(1);
      const reachable = [...focused.primary, ...focused.others].flatMap(row => [row.entry, ...row.duplicates.map(item => item.entry)]);
      expect(reachable).toHaveLength(focused.total);
      const all = focusModelGroup(group, { currentInstallDir: install('0.1.44'), versions: index, showAll: true });
      expect(all.others).toHaveLength(0);
      expect(all.primary.map(row => row.version)).toEqual(['0.1.44', '0.1.38']);
    }
  });

  it('falls back to the newest copy when the current version has no configuration', () => {
    const candidates = fixture(() => true).filter(candidate => candidate.runtimeVersion !== '0.1.44');
    const group = groupLocalModels([], candidates)[0]!;
    const focused = focusModelGroup(group, { currentInstallDir: install('0.1.44'), versions: runtimeVersionIndex(candidates) });
    expect(focused.fallback).toBe(true);
    expect(focused.primary.map(row => row.version)).toEqual(['0.1.42']);
    expect(focused.primary[0]!.duplicates.map(row => row.version)).toEqual(['0.1.38']);
  });

  it('never merges away a pinned (running or selected) configuration', () => {
    const candidates = fixture();
    const group = groupLocalModels([], candidates)[0]!;
    const old = group.configurations.find(entry => entry.candidate?.runtimeVersion === '0.1.38')!;
    const focused = focusModelGroup(group, { currentInstallDir: install('0.1.44'), versions: runtimeVersionIndex(candidates), pinned: [old.key] });
    expect(focused.primary.map(row => row.version)).toEqual(['0.1.44', '0.1.38']);
  });

  it('fingerprints installation-local paths but keeps shared weight paths', () => {
    const [a, b] = groupLocalModels([], fixture())[0]!.configurations;
    expect(configurationFingerprint(a!)).toBe(configurationFingerprint(b!));
    expect(configurationFingerprint(a!)).toContain('d:/ai/strata-data/models');
    expect(configurationFingerprint(a!)).toContain('<install>/engine/strata.exe');
  });

  it('chooses the current installation from running, last used, then the newest ready runtime', () => {
    const profiles = [{ id: 'p', name: 'p', baseUrl: '', installDir: install('0.1.42'), pythonPath: '', configPath: '', managed: true }];
    const runtimes = versions.map(version => ({ installDir: install(version), runtimeVersion: version, readiness: 'ready' as const }));
    expect(resolveCurrentInstallDir({ profiles, runtimes, activeId: 'p', activeRunning: true })).toBe(install('0.1.42'));
    expect(resolveCurrentInstallDir({ profiles, runtimes, lastUsedId: 'p' })).toBe(install('0.1.42'));
    expect(resolveCurrentInstallDir({ profiles: [], runtimes })).toBe(install('0.1.44'));
    expect(resolveCurrentInstallDir({ profiles: [], runtimes: [{ ...runtimes[2]!, readiness: 'repair' }], candidates: fixture() })).toBe(install('0.1.44'));
  });
});
