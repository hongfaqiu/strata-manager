import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { engineFlagSupport } from '../src';

// Flags the real 0.1.44.1 engine usage() prints (src/program/generate.cpp), trimmed.
const documented = ['--pack', '--tokens', '--gpu', '--kv', '--batch', '--batch-mtp', '--vram-elastic'];

describe('engine --help flag support', () => {
  it('marks documented, unlisted and unknown flags', () => {
    expect(engineFlagSupport('--batch', documented)).toBe('supported');
    expect(engineFlagSupport('--BATCH', new Set(documented))).toBe('supported');
    expect(engineFlagSupport('--removed-flag', documented)).toBe('unlisted');
  });
  it('never hides anything without a usable help listing or for config keys', () => {
    expect(engineFlagSupport('--batch', null)).toBe('unknown');
    expect(engineFlagSupport('--batch', ['--x'])).toBe('unknown');
    expect(engineFlagSupport('parallel', documented)).toBe('unknown');
  });
  it('covers every quick-form engine flag in the real upstream usage text when available', () => {
    let source = '';
    try { source = readFileSync(new URL('../../../.reference/strata-0.1.44.1/src/program/generate.cpp', import.meta.url), 'utf8'); } catch { return; }
    const usage = source.slice(source.indexOf('void usage()'), source.indexOf('\n}\n', source.indexOf('void usage()')));
    const flags = new Set(usage.match(/--[a-z0-9][a-z0-9-]*/g) ?? []);
    for (const flag of ['--batch', '--batch-mtp', '--vram-elastic']) expect(engineFlagSupport(flag, flags)).toBe('supported');
  });
});
