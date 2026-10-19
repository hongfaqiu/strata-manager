import { describe, expect, it } from 'vitest';
import { localRuntimePackageSelection, runtimePackageIsWindows } from '../src/local-runtime-package';

describe('localRuntimePackageSelection', () => {
  it('downloads everything when the automatic source is chosen', () => {
    expect(localRuntimePackageSelection('download', { strataArchivePath: 'C:\\a.zip' }, true)).toEqual({ missing: false });
  });

  it('requires at least one ZIP for the local source', () => {
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
});

describe('runtimePackageIsWindows', () => {
  it('reads the detected OS name', () => {
    expect(runtimePackageIsWindows('Windows 10 Pro')).toBe(true);
    expect(runtimePackageIsWindows('Ubuntu 24.04')).toBe(false);
  });
});
