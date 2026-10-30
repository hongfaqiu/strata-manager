import { describe, expect, it } from 'vitest';
import { applyStartupField, applyStartupTuning, STARTUP_FIELD_HINTS, parseStartupConfiguration, replaceStartupArgument, STARTUP_ENGINE_FLAGS, STARTUP_TUNING_FIELDS, startupArgsOf, startupArgumentRows, startupFieldValue, startupTuningOf, validateStartupConfiguration } from '../src/config-tuning';

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

const field = (key: string) => STARTUP_TUNING_FIELDS.find(item => item.key === key)!;
const complete = {
  args: ['--native', 'D:\\AI Models\\weights.gguf', '--max-context', '65536', '--custom-next', 'alpha beta', '--control-vector-layer-range', '4', '44', '--custom-next', '-3', '--stats'],
  vision: { threads: 3, gpu: false, custom: [null, false, 1.25] },
  sampling: { temperature: .6, top_p: .95 },
  mcp: [{ name: 'calculator', args: ['--mode', 'stdio'], enabled: false }],
  env: { CUSTOM: 'keep' }, custom: { list: [12, null, 'keep'], empty: null }, api_key: 'keep-secret',
};
describe('complete graphical and JSON startup configuration', () => {
  it('keeps unknown/repeated arguments, exact paths and two-operand options in original order', () => {
    const rows = startupArgumentRows(complete);
    expect(rows.flatMap(row => row.tokens)).toEqual(complete.args);
    expect(rows.find(row => row.tokens[0] === '--control-vector-layer-range')).toMatchObject({ known: true, arity: 2, tokens: ['--control-vector-layer-range', '4', '44'] });
    expect(rows.filter(row => row.tokens[0] === '--custom-next').map(row => row.tokens)).toEqual([['--custom-next', 'alpha beta'], ['--custom-next', '-3']]);
  });
  it('updates just one curated parameter without rebuilding the complete argv or nested configuration', () => {
    const updated = applyStartupField(complete, field('--max-context'), '98304');
    expect(updated).toEqual({ ...complete, args: complete.args.map((value, index) => index === 3 ? '98304' : value) });
    expect(updated).not.toBe(complete);
    expect(complete.args[3]).toBe('65536');
  });
  it('saves a graphical → full JSON → graphical round trip without losing native JSON types', () => {
    const graph = applyStartupField(complete, field('--pool-workers'), '0');
    const json = parseStartupConfiguration(JSON.stringify(graph));
    (json.custom as { list: unknown[]; empty: null }).list = [12, null, 'keep', false];
    const saved = applyStartupField(json, field('vision.threads'), '4');
    validateStartupConfiguration(saved);
    expect(startupFieldValue(saved, field('--pool-workers'))).toBe('0');
    expect(saved.vision).toEqual({ ...complete.vision, threads: 4 });
    expect(saved.custom).toEqual({ list: [12, null, 'keep', false], empty: null });
    expect(saved.mcp).toEqual(complete.mcp);
    expect(saved.api_key).toBe('keep-secret');
    expect(startupArgsOf(saved).slice(0, complete.args.length)).toEqual(complete.args);
  });
  it('preserves a false config value and removes only an explicitly cleared override', () => {
    const falseConfig = applyStartupField(complete, field('api_monitor'), 'false');
    expect(falseConfig.api_monitor).toBe(false);
    expect(startupFieldValue(falseConfig, field('api_monitor'))).toBe('false');
    expect(applyStartupField(falseConfig, field('api_monitor'), '')).toEqual(complete);
    const noVisionThreads = applyStartupField(complete, field('vision.threads'), '');
    expect(noVisionThreads.vision).toEqual({ gpu: false, custom: [null, false, 1.25] });
  });
  it('edits/removes a selected repeated or unknown argument without changing the other occurrences', () => {
    const rows = startupArgumentRows(complete);
    const repeated = rows.filter(row => row.tokens[0] === '--custom-next')[1]!;
    const edited = replaceStartupArgument(complete, repeated, ['--custom-next', '-9']);
    expect(edited.args).toEqual(complete.args.map((value, index) => index === repeated.offset + 1 ? '-9' : value));
    const range = startupArgumentRows(edited).find(row => row.tokens[0] === '--control-vector-layer-range')!;
    expect(replaceStartupArgument(edited, range, []).args).toEqual([...complete.args.slice(0, 6), '--custom-next', '-9', '--stats']);
  });
  it('allows a custom/new enum without silently normalizing it to a catalog choice', () => {
    const next = applyStartupField(complete, field('--kv'), 'future-format');
    expect(next.args).toEqual([...complete.args, '--kv', 'future-format']);
    expect(applyStartupField(next, field('--kv'), '').args).toEqual(complete.args);
  });
  it('rejects duplicate curated edits while allowing an explicit full argument list edit', () => {
    const duplicated = { args: ['--pool-workers', '3', '--pool-workers', '5'] };
    expect(() => applyStartupField(duplicated, field('--pool-workers'), '4')).toThrow('重复');
    const edited = replaceStartupArgument(duplicated, startupArgumentRows(duplicated)[1]!, []);
    expect(applyStartupField(edited, field('--pool-workers'), '4').args).toEqual(['--pool-workers', '4']);
  });
  it('rejects missing known operands and malformed args without rejecting new custom switches', () => {
    for (const args of [['--batch'], ['--native', '--stats'], ['--control-vector-layer-range', '4'], ['--control-vector-layer-range', '4', '--stats'], ['--pool-workers', '']]) {
      expect(() => validateStartupConfiguration({ args })).toThrow();
    }
    expect(() => validateStartupConfiguration({ args: ['--future-switch', '--future-pair', 'value'] })).not.toThrow();
    for (const raw of ['[]', 'null', '{"args":[1]}', '{"args":"--stats"}']) expect(() => parseStartupConfiguration(raw)).toThrow();
  });
  it('checks verified numeric ranges and keeps main CPU threads distinct from vision threads', () => {
    expect(applyStartupField({}, field('--pool-workers'), '0')).toEqual({ args: ['--pool-workers', '0'] });
    expect(applyStartupField({ threads: 8 }, field('vision.threads'), '4')).toEqual({ threads: 8, vision: { threads: 4 } });
    for (const [key, value] of [['--pool-workers', '-1'], ['vision.threads', '0'], ['--resident-budget-gib', '0'], ['sampling.top_p', '0'], ['sampling.top_k', '65'], ['parallel', '1.5']]) expect(() => applyStartupField(complete, field(key!), value!)).toThrow();
    expect(STARTUP_ENGINE_FLAGS['--threads']).toBeUndefined();
    expect(STARTUP_ENGINE_FLAGS['--control-vector-layer-range']).toBe(2);
    for (const spec of STARTUP_TUNING_FIELDS.filter(item => item.target === 'arg')) expect(STARTUP_ENGINE_FLAGS[spec.key]).toBe(spec.kind === 'boolean' ? 0 : 1);
  });
  it('edits --prefill-pipe with the upstream 0–262144 range and a bilingual hint', () => {
    expect(STARTUP_ENGINE_FLAGS['--prefill-pipe']).toBe(1);
    const pipe = field('--prefill-pipe');
    expect(pipe.group).toBe('prefill');
    expect(applyStartupField({ args: ['--native', 'm.gguf'] }, pipe, '1536')).toEqual({ args: ['--native', 'm.gguf', '--prefill-pipe', '1536'] });
    expect(applyStartupField({ args: [] }, pipe, '0')).toEqual({ args: ['--prefill-pipe', '0'] });
    expect(applyStartupField({ args: [] }, pipe, '2.5')).toEqual({ args: ['--prefill-pipe', '2.5'] });
    for (const value of ['-1', '262145', 'auto', 'abc']) expect(() => applyStartupField({ args: [] }, pipe, value)).toThrow();
    expect(startupFieldValue({ args: ['--prefill-pipe', '768'] }, pipe)).toBe('768');
    expect(validateStartupConfiguration({ args: ['--prefill-pipe', '768', '--stats'] })).toBeUndefined();
    expect(STARTUP_FIELD_HINTS['--prefill-pipe']!.zh).toContain('0–262144');
    expect(STARTUP_FIELD_HINTS['--prefill-pipe']!.en).toContain('0–262144');
  });
  it('can repair a missing known operand without swallowing the next unrelated flag', () => {
    const broken = { args: ['--max-context', '--kv', 'int8', '--stats'] };
    const repaired = applyStartupField(broken, field('--max-context'), '8192');
    expect(repaired.args).toEqual(['--max-context', '8192', '--kv', 'int8', '--stats']);
    expect(() => validateStartupConfiguration(repaired)).not.toThrow();
  });
});

describe('network and GPU power startup settings', () => {
  it('updates network and power settings without dropping secrets, unknown fields or engine arguments', () => {
    let edited = applyStartupField(complete, field('host'), '0.0.0.0');
    edited = applyStartupField(edited, field('port'), '18082');
    edited = applyStartupField(edited, field('manager_gpu_power_limit_watts'), '220.5');
    edited = applyStartupField(edited, field('manager_gpu_power_limit_device'), '1');
    expect(edited).toEqual({ ...complete, host: '0.0.0.0', port: 18082, manager_gpu_power_limit_watts: 220.5, manager_gpu_power_limit_device: 1 });
    expect(complete).not.toHaveProperty('port');
    expect(() => validateStartupConfiguration(parseStartupConfiguration(JSON.stringify(edited)))).not.toThrow();
    expect(applyStartupField(edited, field('manager_gpu_power_limit_watts'), '  ')).toEqual({ ...complete, host: '0.0.0.0', port: 18082, manager_gpu_power_limit_device: 1 });
  });
  it('validates the same networking boundaries in JSON and graphical saves', () => {
    for (const port of [0, 65536, 1.5, '8080', null, NaN]) expect(() => validateStartupConfiguration({ ...complete, port })).toThrow('port');
    for (const host of ['localhost/path', 'localhost?key=value', 'user@localhost', 'http://localhost', null]) expect(() => validateStartupConfiguration({ ...complete, host })).toThrow('host');
    for (const host of ['localhost', '127.0.0.1', '0.0.0.0', '::', '[::1]', '192.168.1.20']) expect(() => validateStartupConfiguration({ ...complete, host, port: 18082 })).not.toThrow();
  });
  it('accepts tool_call_recovery only as true or false, as Strata 0.2.8 does', () => {
    for (const value of [true, false]) expect(() => validateStartupConfiguration({ ...complete, tool_call_recovery: value })).not.toThrow();
    for (const value of ['true', 0, 1, null, 'recover']) expect(() => validateStartupConfiguration({ ...complete, tool_call_recovery: value })).toThrow('tool_call_recovery');
  });
  it('accepts positive fractional watts and u32 device indices while rejecting invalid values', () => {
    expect(() => validateStartupConfiguration({ ...complete, manager_gpu_power_limit_watts: null })).not.toThrow();
    expect(() => validateStartupConfiguration({ ...complete, manager_gpu_power_limit_device: null })).not.toThrow();
    expect(() => validateStartupConfiguration({ ...complete, manager_gpu_power_limit_watts: 150.5, manager_gpu_power_limit_device: 4294967295 })).not.toThrow();
    for (const watts of [0, -1, Infinity, NaN, '220', true]) expect(() => validateStartupConfiguration({ ...complete, manager_gpu_power_limit_watts: watts })).toThrow('manager_gpu_power_limit_watts');
    for (const device of [-1, .5, 4294967296, Infinity, '0']) expect(() => validateStartupConfiguration({ ...complete, manager_gpu_power_limit_device: device })).toThrow('manager_gpu_power_limit_device');
    expect(applyStartupField({ manager_gpu_power_limit_device: 2 }, field('manager_gpu_power_limit_device'), '')).toEqual({});
  });
  describe('default experimental speed projection (#104)', () => {
    const projection = field('sampling.experimental_speed_projection');
    const base = { exe: 'engine.exe', args: ['--native', 'm.gguf', '--unknown-flag', 'x'], sampling: { temperature: .6, top_k: 20, future_key: 'kept' }, custom: { nested: [1, 2] } };
    it('is a boolean field in the default sampling category with a hint', () => {
      expect(projection).toMatchObject({ group: 'sampling', target: 'config', kind: 'boolean' });
      expect(STARTUP_FIELD_HINTS['sampling.experimental_speed_projection']?.zh).toContain('控制向量');
      expect(STARTUP_FIELD_HINTS['sampling.experimental_speed_projection']?.en).toContain('control vector');
    });
    it('shows a missing or null value as "use default" without rewriting it', () => {
      expect(startupFieldValue(base, projection)).toBe('');
      const stored = { ...base, sampling: { ...base.sampling, experimental_speed_projection: null } };
      expect(startupFieldValue(stored, projection)).toBe('');
      expect(stored.sampling.experimental_speed_projection).toBeNull();
      expect(() => validateStartupConfiguration(stored)).not.toThrow();
      expect(startupFieldValue({ sampling: { experimental_speed_projection: true } }, projection)).toBe('true');
      expect(startupFieldValue({ sampling: { experimental_speed_projection: false } }, projection)).toBe('false');
      // Other fields still show a stored null as such.
      expect(startupFieldValue({ sampling: { temperature: null } }, field('sampling.temperature'))).toBe('null');
    });
    it('writes JSON booleans or removes only the target field', () => {
      const on = applyStartupField(base, projection, 'true');
      expect(on).toEqual({ ...base, sampling: { ...base.sampling, experimental_speed_projection: true } });
      expect(base.sampling).not.toHaveProperty('experimental_speed_projection');
      const off = applyStartupField(on, projection, 'false');
      expect(off.sampling).toEqual({ ...base.sampling, experimental_speed_projection: false });
      expect(applyStartupField(off, projection, '')).toEqual(base);
      const fromNull = applyStartupField({ ...base, sampling: { ...base.sampling, experimental_speed_projection: null } }, projection, '');
      expect(fromNull).toEqual(base);
      expect(applyStartupField({ exe: 'engine.exe' }, projection, 'false')).toEqual({ exe: 'engine.exe', sampling: { experimental_speed_projection: false } });
      for (const value of [on, off]) expect(() => validateStartupConfiguration(parseStartupConfiguration(JSON.stringify(value)))).not.toThrow();
    });
    it('rejects non-boolean values in the graphical editor and in JSON', () => {
      for (const text of ['1', '0', 'yes', 'False']) expect(() => applyStartupField(base, projection, text)).toThrow('experimental_speed_projection');
      for (const value of ['false', 'true', 0, 1, {}, []]) expect(() => validateStartupConfiguration({ ...base, sampling: { experimental_speed_projection: value } })).toThrow('experimental_speed_projection');
    });
  });
});
