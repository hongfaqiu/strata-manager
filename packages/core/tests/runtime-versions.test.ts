import { describe, expect, it } from 'vitest';
import { compareReleaseVersions, runtimeUpdateAllowedByPin, runtimeVersionDirection } from '../src/runtime-versions';

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
