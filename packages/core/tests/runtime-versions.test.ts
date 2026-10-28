import { describe, expect, it } from 'vitest';
import { compareReleaseVersions, releaseEngineVersion, runtimePinRelease, runtimeReleaseIsNewer, runtimeReleaseOf, runtimeUpdateAllowedByPin, runtimeUpdateAvailable, runtimeVersionDirection, runtimeVersionLabel } from '../src/runtime-versions';

describe('runtime versions', () => {
  it('orders numbers, then a release after its pre-releases', () => {
    const sorted = ['0.1.9', '0.2.1', '0.2.0-beta', '0.1.44', '0.2.0', 'v0.1.10'].sort(compareReleaseVersions);
    expect(sorted).toEqual(['0.1.9', 'v0.1.10', '0.1.44', '0.2.0-beta', '0.2.0', '0.2.1']);
    expect(compareReleaseVersions('0.2', '0.2.0')).toBe(0);
    expect(compareReleaseVersions('nightly', '0.2.0')).toBe(0);
  });
  it('a pin stops prompts only beyond the pinned version', () => {
    expect(runtimeUpdateAllowedByPin('0.2.1', '')).toBe(true);
    expect(runtimeUpdateAllowedByPin('0.2.1', '0.1.44')).toBe(false);
    expect(runtimeUpdateAllowedByPin('0.1.44', '0.1.44')).toBe(true);
    expect(runtimeUpdateAllowedByPin('0.2.0-beta', '0.2.0')).toBe(true);
    expect(runtimeUpdateAllowedByPin(undefined, '0.1.44')).toBe(true);
  });
  it('names the direction of a switch', () => {
    expect(runtimeVersionDirection('0.2.1', '0.1.44')).toBe('downgrade');
    expect(runtimeVersionDirection('0.1.44', '0.2.1')).toBe('upgrade');
    expect(runtimeVersionDirection('0.2.1', 'v0.2.1')).toBe('same');
    expect(runtimeVersionDirection(undefined, '0.2.1')).toBe('unknown');
  });

});

describe('release and engine versions', () => {
  const releases = [
    { version: '0.2.3', engineVersion: '0.1.48', prerelease: false },
    { version: '0.2.2', engineVersion: '0.1.47', prerelease: false },
    { version: '0.2.0', engineVersion: '0.1.45.3', prerelease: false },
    { version: '0.2.0-beta', engineVersion: '0.1.45.3', prerelease: true },
    { version: '0.1.44', engineVersion: '0.1.44', prerelease: false },
  ];
  const latest = { latestVersion: '0.2.3', assets: [{ engineVersion: '0.1.48' }] };
  it('labels the release first and the engine second', () => {
    expect(runtimeVersionLabel({ release: '0.2.2', engine: '0.1.47' }, true)).toBe('Release v0.2.2 · 引擎 0.1.47');
    expect(runtimeVersionLabel({ release: 'v0.2.3', engine: '0.1.48' }, false)).toBe('Release v0.2.3 · engine 0.1.48');
    expect(runtimeVersionLabel({ engine: '0.1.47' }, false)).toBe('Engine 0.1.47');
    expect(runtimeVersionLabel({}, true)).toBe('');
  });
  it('finds the release a runtime came from', () => {
    expect(runtimeReleaseOf({ releaseVersion: 'v0.2.2', runtimeVersion: '0.1.47' })).toBe('0.2.2');
    expect(runtimeReleaseOf({ runtimeVersion: '0.1.47' }, releases)).toBe('0.2.2');
    expect(runtimeReleaseOf({ runtimeVersion: '0.1.45.3' }, releases)).toBe('0.2.0');
    expect(runtimeReleaseOf({ runtimeVersion: '0.1.47' })).toBeUndefined();
    expect(releaseEngineVersion(latest)).toBe('0.1.48');
  });
  it('compares like with like, never engine 0.1.47 with release 0.2.3', () => {
    expect(runtimeReleaseIsNewer({ releaseVersion: '0.2.2', runtimeVersion: '0.1.47' }, latest)).toBe(true);
    expect(runtimeReleaseIsNewer({ releaseVersion: '0.2.3', runtimeVersion: '0.1.48' }, latest)).toBe(false);
    // No release recorded and no release list: the engines are compared.
    expect(runtimeReleaseIsNewer({ runtimeVersion: '0.1.48' }, latest)).toBe(false);
    expect(runtimeReleaseIsNewer({ runtimeVersion: '0.1.47' }, latest)).toBe(true);
    expect(runtimeReleaseIsNewer({ runtimeVersion: '0.1.47' }, { latestVersion: '0.2.3', assets: [] })).toBeUndefined();
    expect(runtimeUpdateAvailable({ runtimeVersion: '0.1.48' }, { latestVersion: '0.2.3', assets: [{ engineVersion: '0.1.48' }] })).toBe(false);
    expect(runtimeUpdateAvailable({}, latest)).toBe(true);
    expect(runtimeUpdateAvailable({ releaseVersion: '0.2.3' }, undefined)).toBe(false);
  });
  it('reads a pin saved as an engine number as its release', () => {
    expect(runtimePinRelease('0.1.47', [{ releaseVersion: '0.2.2', runtimeVersion: '0.1.47' }])).toBe('0.2.2');
    expect(runtimePinRelease('0.1.47', [], releases)).toBe('0.2.2');
    expect(runtimePinRelease('0.2.2', [], releases)).toBe('0.2.2');
    expect(runtimePinRelease('0.1.44', [{ releaseVersion: '0.1.44', runtimeVersion: '0.1.44' }], releases)).toBe('0.1.44');
    expect(runtimePinRelease('', [], releases)).toBeUndefined();
    expect(runtimeUpdateAllowedByPin('0.2.3', runtimePinRelease('0.1.47', [], releases))).toBe(false);
    expect(runtimeUpdateAllowedByPin('0.2.2', runtimePinRelease('0.1.47', [], releases))).toBe(true);
  });
  it('the 0.2.7 tag released as "Strata 0.2.7.1" is current once installed', () => {
    const latest = { latestVersion: '0.2.7', assets: [{ engineVersion: '0.1.52' }] };
    expect(runtimeUpdateAvailable({ releaseVersion: '0.2.7', runtimeVersion: '0.1.52' }, latest)).toBe(false);
    expect(runtimeUpdateAvailable({ releaseVersion: '0.2.7.1', runtimeVersion: '0.1.52' }, latest)).toBe(false);
    expect(runtimeUpdateAvailable({ runtimeVersion: '0.1.52' }, latest, [{ version: '0.2.7', engineVersion: '0.1.52', prerelease: false }])).toBe(false);
    expect(runtimeUpdateAvailable({ releaseVersion: '0.2.2', runtimeVersion: '0.1.47' }, latest)).toBe(true);
  });
});
