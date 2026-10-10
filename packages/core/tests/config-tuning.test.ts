import { describe, expect, it } from 'vitest';
import { applyStartupTuning, startupTuningOf } from '../src/config-tuning';

const config = { exe: 'engine.exe', args: ['--native', '模型.gguf', '--max-context', '524288', '--kv', 'int8', '--rope-scale', '2'], threads: 8, sampling: { temperature: .6 }, vision: { gpu: true }, mcp: [{ name: 'calculator' }], api_key: 'preserved' };
describe('startup configuration tuning', () => {
  it('reads options and changes their existing positions while preserving unrelated configuration', () => {
    expect(startupTuningOf(config)).toEqual({ context: '524288', kv: 'int8', threads: '8' });
    const result = applyStartupTuning(config, { context: '65536', kv: 'q4_0', threads: '4' });
    expect(result).toEqual({ ...config, args: ['--native', '模型.gguf', '--max-context', '65536', '--kv', 'q4_0', '--rope-scale', '2'], threads: 4 });
    expect(config.threads).toBe(8);
  });
  it('removes only the selected overrides for engine defaults', () => {
    const result = applyStartupTuning(config, { context: '', kv: '', threads: '' });
    expect(result.args).toEqual(['--native', '模型.gguf', '--rope-scale', '2']);
    expect(result).not.toHaveProperty('threads');
    expect(result.api_key).toBe('preserved');
  });
  it('rejects malformed, duplicate or out-of-range options', () => {
    for (const context of ['0', '-1', '1.5', '2147483648', 'not-a-number']) expect(() => applyStartupTuning(config, { context, kv: 'int8', threads: '8' })).toThrow();
    expect(() => startupTuningOf({ args: ['--max-context', '--kv', 'int8'] })).toThrow();
    expect(() => startupTuningOf({ args: ['--max-context', '4096', '--max-context', '8192'] })).toThrow();
    expect(() => applyStartupTuning(config, { context: '65536', kv: 'unsupported', threads: '8' })).toThrow();
  });
  it('does not shrink context below the installed resident KV window', () => {
    const streamed = { ...config, args: [...config.args, '--kv-resident', '32768'] };
    expect(() => applyStartupTuning(streamed, { context: '8192', kv: 'int8', threads: '8' })).toThrow('kv-resident');
    expect(applyStartupTuning(streamed, { context: '65536', kv: 'int8', threads: '8' }).args).toContain('--kv-resident');
  });
  it('retains an unknown installed KV format unless explicitly changed', () => {
    const future = { args: ['--kv', 'future-format'] };
    expect(applyStartupTuning(future, { context: '', kv: 'future-format', threads: '' })).toEqual(future);
  });
  it('reads and changes an existing engine threads flag without contradictory overrides', () => {
    const flags = { args: ['--native', 'weights.gguf', '--threads', '8'] };
    expect(startupTuningOf(flags).threads).toBe('8');
    expect(applyStartupTuning(flags, { context: '', kv: '', threads: '4' })).toEqual({ args: ['--native', 'weights.gguf', '--threads', '4'] });
    expect(applyStartupTuning(flags, { context: '', kv: '', threads: '' })).toEqual({ args: ['--native', 'weights.gguf'] });
  });
});
