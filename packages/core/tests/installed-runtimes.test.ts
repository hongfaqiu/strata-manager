import { describe, expect, it } from 'vitest';
import { cleanupPaths, engineRollbackCompatibilityWarning, engineRollbackRetentionNote, formatRuntimeBytes, installedRollbackTarget, installedRuntimeForRelease, installedRuntimeRelease, modelMinEngineOf, sortInstalledRuntimes, totalBytes, type InstalledRuntime, type RuntimeInventory } from '../src/installed-runtimes';

const runtime = (installDir: string, extra: Partial<InstalledRuntime> = {}): InstalledRuntime => ({
  installDir, pythonPath: `${installDir}/python`, readiness: 'ready', owned: true, current: false, running: false, rollback: false, switching: false, profiles: [], cleanup: false, ...extra,
});
const releases = [{ version: '0.2.3', engineVersion: '0.1.48' }, { version: '0.2.2', engineVersion: '0.1.47' }, { version: '0.2.0', engineVersion: '0.1.45.3' }].map(release => ({ ...release, prerelease: false }));
const inventory = (runtimes: InstalledRuntime[], leftovers: RuntimeInventory['leftovers'] = []): RuntimeInventory => ({ runtimes, leftovers, autoCleanup: true, busy: false });

describe('installed runtimes', () => {
  it('reads the release of a folder that only records its engine', () => {
    expect(installedRuntimeRelease(runtime('/a', { engineVersion: '0.1.47' }), releases)).toBe('0.2.2');
    expect(installedRuntimeRelease(runtime('/a', { releaseVersion: '0.2.3', engineVersion: '0.1.48' }), releases)).toBe('0.2.3');
  });

  it('finds a complete local copy of a release, never the one in use', () => {
    const list = inventory([
      runtime('/current', { current: true, releaseVersion: '0.2.3' }),
      runtime('/old', { engineVersion: '0.1.47' }),
      runtime('/broken', { releaseVersion: '0.2.0', readiness: 'repair' }),
    ]);
    expect(installedRuntimeForRelease(list, 'v0.2.2', releases)?.installDir).toBe('/old');
    expect(installedRuntimeForRelease(list, '0.2.3', releases)).toBeUndefined();
    expect(installedRuntimeForRelease(list, '0.2.0', releases)).toBeUndefined();
    expect(installedRuntimeForRelease(undefined, '0.2.2', releases)).toBeUndefined();
  });

  it('lists the version in use first, then newest', () => {
    const sorted = sortInstalledRuntimes([
      runtime('/a', { releaseVersion: '0.2.0' }), runtime('/b', { releaseVersion: '0.2.2', current: true }), runtime('/c', { engineVersion: '0.1.48' }),
    ], releases);
    expect(sorted.map(item => item.installDir)).toEqual(['/b', '/c', '/a']);
  });

  it('cleans up only what the service planned, plus leftovers', () => {
    const list = inventory([runtime('/current', { current: true }), runtime('/rollback', { rollback: true }), runtime('/old', { cleanup: true })], [{ path: '/downloads/x.part', kind: 'partialDownload' }]);
    expect(cleanupPaths(list)).toEqual(['/old', '/downloads/x.part']);
    expect(cleanupPaths(undefined)).toEqual([]);
  });

  it('totals sizes once all are measured and formats them', () => {
    expect(totalBytes(['/a', '/b'], { '/a': 1024, '/b': 2048 })).toBe(3072);
    expect(totalBytes(['/a', '/b'], { '/a': 1024 })).toBeUndefined();
    expect(formatRuntimeBytes(undefined)).toBe('…');
    expect(formatRuntimeBytes(512 * 1024)).toBe('512 KB');
    expect(formatRuntimeBytes(5.5 * 1024 ** 2)).toBe('5.5 MB');
    expect(formatRuntimeBytes(320 * 1024 ** 2)).toBe('320 MB');
    expect(formatRuntimeBytes(2.25 * 1024 ** 3)).toBe('2.3 GB');
  });
  it('falls back to the kept version, else the newest older ready one, never a newer or broken one', () => {
    const current = runtime('/v48', { engineVersion: '0.1.48', current: true });
    const v47 = runtime('/v47', { engineVersion: '0.1.47' }), v45 = runtime('/v45', { engineVersion: '0.1.45.3' });
    expect(installedRollbackTarget(inventory([current, v45, v47]), releases)?.installDir).toBe('/v47');
    expect(installedRollbackTarget(inventory([current, v47, { ...v45, rollback: true }]), releases)?.installDir).toBe('/v45');
    expect(installedRollbackTarget(inventory([current, { ...v47, readiness: 'broken' }]), releases)).toBeUndefined();
    expect(installedRollbackTarget(inventory([runtime('/v47', { engineVersion: '0.1.47', current: true }), runtime('/v48', { engineVersion: '0.1.48' })]), releases)).toBeUndefined();
    expect(installedRollbackTarget(undefined)).toBeUndefined();
  });
  it('checks model minEngine compatibility from config/MODEL_CATALOG first (profile name as fallback) and explains retention rules (U10A)', () => {
    expect(modelMinEngineOf('Qwen3.8-Flash-Next (Unsloth) · UD-Q2_K_XL')).toEqual({ label: 'UD-Q2_K_XL', minEngine: '0.1.57' });
    expect(modelMinEngineOf('qwen3.8-flash-next-unsloth-ud-iq4_xs-v31')).toEqual({ label: 'UD-IQ4_XS-v31', minEngine: '0.1.57' });
    expect(modelMinEngineOf({ args: ['--native', '/d/UD-IQ4_XS-00001-of-00004.gguf'] })).toEqual({ label: 'UD-IQ4_XS-v31', minEngine: '0.1.57' });
    // Real config fields (model_name, args, configPath) take priority even when the user renamed the profile.
    expect(modelMinEngineOf({ name: '主力对话模型', model_name: 'qwen3.8-flash-next-unsloth-ud-q3_k_xl' })).toEqual({ label: 'UD-Q3_K_XL', minEngine: '0.1.57' });
    expect(modelMinEngineOf({ name: 'UD-Q2_K_XL renamed', model_name: 'qwen3.8-flash-next-iq3_s', args: ['--native', 'IQ3_S.gguf'] })).toBeNull();
    // Old 3-shard UD-IQ4_XS and DeepSeek UD-IQ1_M do not trigger the 0.1.57 Qwen v3.1 engine gate.
    expect(modelMinEngineOf('qwen3.8-flash-next-unsloth-ud-iq4_xs')).toBeNull();
    expect(modelMinEngineOf({ arch: 'deepseek41', model_name: 'deepseek-v4.1-flash-ud-iq1_m' })).toBeNull();

    // Rolling back to 0.1.56 / 0.1.55 with a v3.1 model warns that 0.1.57+ is required.
    const warnZh = engineRollbackCompatibilityWarning('0.1.56', [{ name: '我的模型', model_name: 'qwen3.8-flash-next-unsloth-ud-q2_0' }], true);
    expect(warnZh).toContain('0.1.57');
    expect(warnZh).toContain('0.1.56');
    expect(warnZh).toContain('老格式模型');
    const warnEn = engineRollbackCompatibilityWarning('0.1.55', ['qwen3.8-flash-next-unsloth-ud-iq1_m'], false);
    expect(warnEn).toContain('0.1.57+');
    expect(warnEn).toContain('0.1.55');
    expect(warnEn).toContain('older-format model');

    // Target 0.1.57 or 0.1.58 with v3.1 model: no warning.
    expect(engineRollbackCompatibilityWarning('0.1.57', ['Qwen · UD-Q2_0'], true)).toBeNull();
    expect(engineRollbackCompatibilityWarning('0.1.58', ['Qwen · UD-IQ4_XS-v31'], false)).toBeNull();

    // Retention rule note is concise (current + 1 previous version) without repeating model-specific text.
    expect(engineRollbackRetentionNote(true)).toContain('1 个旧版本');
    expect(engineRollbackRetentionNote(true)).not.toContain('Unsloth');
    expect(engineRollbackRetentionNote(false)).toContain('1 previous version');
    expect(engineRollbackRetentionNote(false)).not.toContain('Unsloth');
  });
});
