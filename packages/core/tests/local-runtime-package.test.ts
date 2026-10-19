import { describe, expect, it } from 'vitest';
import {
  filterCatalogForPlatform,
  localRuntimePackageSelection,
  macCatalogFamilyAllowed,
  macDefaultEngineArgs,
  macSupportsCalibrate,
  macSupportsParallel,
  metalManualBuildHint,
  runtimePackageIsMac,
  runtimePackageIsWindows,
  runtimePackageOffersEngine,
  runtimePackagePlatform,
} from '../src/local-runtime-package';

describe('localRuntimePackageSelection', () => {
  it('downloads everything when the automatic source is chosen', () => {
    expect(localRuntimePackageSelection('download', { strataArchivePath: 'C:\\a.zip' }, true)).toEqual({ missing: false });
  });

  it('requires at least one archive for the local source', () => {
    expect(localRuntimePackageSelection('local', {}, true)).toEqual({ chosen: undefined, missing: true });
    expect(localRuntimePackageSelection('local', { strataArchivePath: '  ' }, false)).toEqual({ chosen: undefined, missing: true });
  });

  it('passes the chosen Strata and engine ZIPs on Windows', () => {
    expect(localRuntimePackageSelection('local', { strataArchivePath: 'C:\\Strata-0.1.45.zip', engineArchivePath: 'C:\\strata-windows-x64.zip' }, true))
      .toEqual({ chosen: { strataArchivePath: 'C:\\Strata-0.1.45.zip', engineArchivePath: 'C:\\strata-windows-x64.zip' }, missing: false });
    expect(localRuntimePackageSelection('local', { engineArchivePath: 'C:\\strata-windows-x64.zip' }, true))
      .toEqual({ chosen: { engineArchivePath: 'C:\\strata-windows-x64.zip' }, missing: false });
  });

  it('drops an engine ZIP on Linux, where the engine is built from source', () => {
    expect(localRuntimePackageSelection('local', { engineArchivePath: '/tmp/engine.zip' }, false)).toEqual({ chosen: undefined, missing: true });
    expect(localRuntimePackageSelection('local', { strataArchivePath: '/tmp/Strata.zip', engineArchivePath: '/tmp/engine.zip' }, false))
      .toEqual({ chosen: { strataArchivePath: '/tmp/Strata.zip' }, missing: false });
  });

  it('keeps the Metal engine tar.gz on macOS', () => {
    expect(localRuntimePackageSelection('local', {
      strataArchivePath: '/tmp/Strata.zip',
      engineArchivePath: '/tmp/strata-engine-0.1.45.3-macos-arm64-metal.tar.gz',
    }, 'macos')).toEqual({
      chosen: {
        strataArchivePath: '/tmp/Strata.zip',
        engineArchivePath: '/tmp/strata-engine-0.1.45.3-macos-arm64-metal.tar.gz',
      },
      missing: false,
    });
  });
});

describe('runtimePackagePlatform', () => {
  it('reads the detected OS name', () => {
    expect(runtimePackageIsWindows('Windows 10 Pro')).toBe(true);
    expect(runtimePackageIsWindows('Ubuntu 24.04')).toBe(false);
    expect(runtimePackageIsMac('macOS 15.1')).toBe(true);
    expect(runtimePackagePlatform('Darwin')).toBe('macos');
    expect(runtimePackageOffersEngine('macos')).toBe(true);
    expect(runtimePackageOffersEngine('linux')).toBe(false);
  });
});

describe('mac metal catalog and defaults', () => {
  it('hides qwen36/swift/coder and keeps qwen/unsloth', () => {
    expect(macCatalogFamilyAllowed('qwen')).toBe(true);
    expect(macCatalogFamilyAllowed('unsloth')).toBe(true);
    expect(macCatalogFamilyAllowed('qwen36')).toBe(false);
    expect(filterCatalogForPlatform(
      [{ family: 'qwen' }, { family: 'swift' }, { family: 'qwen36' }, { family: 'unsloth' }],
      'macos',
    ).map(e => e.family)).toEqual(['qwen', 'unsloth']);
    expect(filterCatalogForPlatform([{ family: 'qwen36' }], 'windows')).toHaveLength(1);
  });

  it('uses Mac defaults without parallel or calibrate', () => {
    expect(macDefaultEngineArgs()).toEqual(['--spec', '2']);
    expect(macSupportsParallel('macos')).toBe(false);
    expect(macSupportsCalibrate('macos')).toBe(false);
    expect(macSupportsCalibrate('linux')).toBe(true);
    expect(metalManualBuildHint('en')).toContain('./setup.sh');
  });
});
