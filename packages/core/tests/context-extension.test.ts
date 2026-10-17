import { describe, expect, it } from 'vitest';
import { contextExtensionError, contextExtensionState, contextMemoryEstimate, CONTEXT_PRESETS, formatContextTokens, formatRopeFactor, ropeFactorFor, STARTUP_TUNING_FIELDS, syncContextExtension, validateStartupConfiguration } from '../src';

describe('context extension past the trained 262,144 tokens', () => {
  it('derives the official yarn factor from the final context', () => {
    expect(ropeFactorFor(131072)).toBe(1);
    expect(ropeFactorFor(262144)).toBe(1);
    expect(ropeFactorFor(393216)).toBe(1.5);
    expect(ropeFactorFor(524288)).toBe(2);
    expect(ropeFactorFor(1048576)).toBe(4);
    expect(formatRopeFactor(ropeFactorFor(1000000))).toBe('3.8147');
    expect(formatContextTokens(1048576)).toBe('1M');
    expect(formatContextTokens(393216)).toBe('384K');
  });
  it('offers 384K, 512K and 1M presets on the config page', () => {
    expect(CONTEXT_PRESETS).toEqual(expect.arrayContaining([393216, 524288, 1048576]));
    expect(STARTUP_TUNING_FIELDS.find(field => field.key === '--max-context')?.choices).toEqual(expect.arrayContaining(['393216', '524288', '1048576']));
  });
  it('adds yarn and the factor automatically, follows context changes, and removes them inside the trained window', () => {
    expect(syncContextExtension('131072', '1048576', '', '')).toEqual({ scaling: 'yarn', scale: '4' });
    expect(syncContextExtension('1048576', '524288', 'yarn', '4')).toEqual({ scaling: 'yarn', scale: '2' });
    expect(syncContextExtension('524288', '131072', 'yarn', '2')).toEqual({ scaling: '', scale: '' });
  });
  it('keeps explicit methods and factors as given', () => {
    expect(syncContextExtension('131072', '1048576', 'linear', '')).toEqual({ scaling: 'linear', scale: '4' });
    expect(syncContextExtension('131072', '1048576', 'yarn', '6')).toEqual({ scaling: 'yarn', scale: '6' });
    expect(syncContextExtension('1048576', '131072', 'yarn', '6')).toEqual({ scaling: 'yarn', scale: '6' });
    expect(syncContextExtension('131072', '1048576', 'none', '')).toEqual({ scaling: 'none', scale: '' });
  });
  it('reports a too-small explicit scale, missing scaling and refuses none past 262,144', () => {
    expect(contextExtensionState('1048576', 'yarn', '4')).toMatchObject({ extended: true, automatic: true, derivedScale: 4 });
    expect(contextExtensionState('1048576', 'yarn', '2')?.issue).toBe('scale_too_small');
    expect(contextExtensionState('1048576', '', '')?.issue).toBe('not_scaled');
    expect(contextExtensionState('1048576', 'none', '')?.issue).toBe('none_refused');
    expect(contextExtensionState('131072', '', '')).toMatchObject({ extended: false, automatic: true });
    expect(contextExtensionError('1048576', 'none', '')).toMatch(/refused/);
    expect(contextExtensionError('262144', 'none', '')).toBeUndefined();
    expect(() => validateStartupConfiguration({ args: ['--max-context', '1048576', '--rope-scaling', 'none'] })).toThrow(/refused/);
    expect(() => validateStartupConfiguration({ args: ['--max-context', '1048576', '--rope-scaling', 'yarn', '--rope-scale', '4'] })).not.toThrow();
  });
  it('estimates KV plus RoPE tables per token and respects the KV precision', () => {
    const int8 = contextMemoryEstimate(1048576, 'int8');
    expect(int8.kvBytes).toBe(1048576 * 13 * 1056);
    expect(int8.ropeBytes).toBe(1048576 * 266);
    expect(int8.extraBytes).toBe(int8.totalBytes - 262144 * 13 * 1056);
    expect(contextMemoryEstimate(1048576, 'q4_0').kvBytes).toBeLessThan(int8.kvBytes);
    expect(contextMemoryEstimate(131072).ropeBytes).toBe(0);
  });
});
