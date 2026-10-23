import { describe, expect, it } from 'vitest';
import { cleanupPaths, formatRuntimeBytes, installedRuntimeForRelease, installedRuntimeRelease, sortInstalledRuntimes, totalBytes, type InstalledRuntime, type RuntimeInventory } from '../src/installed-runtimes';

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
});
