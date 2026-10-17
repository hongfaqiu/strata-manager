import { describe, expect, it } from 'vitest';
import { applyStartupField, STARTUP_TUNING_FIELDS, validateStartupConfiguration } from '../src/config-tuning';
import { concurrencyConfigError, concurrencyIssues, concurrencyMessage, concurrencyModelIdentity, concurrencyPlanEdits, concurrencySlotVramGb, modelExpertArenaGb, readConcurrencySettings, recommendConcurrency, type ConcurrencyHardware } from '../src/concurrency';

const GIB = 2 ** 30;
const card = (id: number, gib: number) => ({ id, name: `GPU ${id}`, vendor: 'nvidia', totalBytes: gib * GIB });
const hw = (gpus: number[], ramGib = 64): ConcurrencyHardware => ({ gpus: gpus.map((gib, id) => card(id, gib)), totalMemoryBytes: ramGib * GIB });
const config = (args: string[], extra: Record<string, unknown> = {}) => ({ model_name: 'qwen', args: ['--native', 'D:\\m\\Qwen3.8-IQ3_S.gguf', ...args], ...extra });
const plan = (cfg: Record<string, unknown>, hardware: ConcurrencyHardware, useCase: 'single' | 'agent' | 'multiUser' | 'batch') => {
  const settings = readConcurrencySettings(cfg as never);
  const id = concurrencyModelIdentity(cfg as never)!;
  return { settings, plan: recommendConcurrency({ settings, hardware, arenaGb: modelExpertArenaGb(id.family, id.quant), useCase }) };
};

describe('concurrency settings', () => {
  it('reads parallel with an explicit --batch winning, as serve/server.py does', () => {
    expect(readConcurrencySettings(config(['--batch', '4'], { parallel: 2 })).parallel).toBe(4);
    expect(readConcurrencySettings(config([], { parallel: 3 })).parallel).toBe(3);
    expect(readConcurrencySettings(config(['--slots', '2'])).parallel).toBe(2);
    expect(readConcurrencySettings(config([])).parallel).toBe(1);
  });
  it('matches setup.py parallel_slot_gb', () => {
    expect(concurrencySlotVramGb(32768, 'int8', false)).toBeCloseTo(0.585, 2);
    expect(concurrencySlotVramGb(262144, 'int8', true)).toBeCloseTo(concurrencySlotVramGb(32768, 'int8', false), 6);
    expect(concurrencySlotVramGb(32768, 'q4_0', false)).toBeLessThan(concurrencySlotVramGb(32768, 'int8', false));
  });
});

describe('recommendations', () => {
  it('a 16 GB card keeps one at a time for agents and adds conversation parking', () => {
    const { settings, plan: p } = plan(config(['--max-context', '131072']), hw([16]), 'agent');
    expect(p.officialParallel).toBe(1); expect(p.parallel).toBe(1);
    expect(p.conversationCache).toEqual({ mib: 8192, slots: 4 });
    expect(p.reasons).toContain('use_agent_cache');
    const edits = concurrencyPlanEdits(settings, p);
    expect(edits).toEqual([{ key: 'parallel', value: '' }, { key: '--conversation-cache-mib', value: '8192' }, { key: '--conversation-cache-slots', value: '4' }]);
  });
  it('a 32 GB card serves four users with batch MTP and async adaptation', () => {
    const cfg = { model_name: 'qwen', args: ['--native', 'Qwen-Q2_0.gguf', '--max-context', '32768', '--mtp', 'mtp.gguf'] };
    const { settings, plan: p } = plan(cfg, hw([32]), 'multiUser');
    expect(p.parallel).toBe(4); expect(p.layerSplit).toBe(false);
    expect(p.companions.map(c => c.key)).toEqual(['--batch-mtp', '--adapt-async']);
    expect(p.slowdown).toEqual([0.05, 0.15]);
    expect(concurrencyPlanEdits(settings, p)[0]).toEqual({ key: 'parallel', value: '4' });
  });
  it('a layer split trims stage weights, resets fixed groups and drops batch MTP', () => {
    const cfg = config(['--max-context', '65536', '--layer-split', '24', '--batch-groups', '1', '--batch-mtp', '--mtp', 'm.gguf'], { gpu: [0, 1] });
    const { plan: p } = plan(cfg, hw([24, 24]), 'batch');
    expect(p.layerSplit).toBe(true); expect(p.parallel).toBe(4);
    expect(p.companions).toEqual([
      { key: '--batch-groups', value: '', reason: 'groups_auto' },
      { key: '--trim-stage-weights', value: 'true', reason: 'trim_stage' },
      { key: '--batch-mtp', value: '', reason: 'batch_mtp_pipeline' },
    ]);
  });
  it('notes the long-context conflict and unknown hardware', () => {
    expect(plan(config(['--max-context', '1048576', '--kv-resident', '2']), hw([96]), 'multiUser').plan.reasons).toContain('long_context_conflict');
    const settings = readConcurrencySettings(config([]));
    expect(recommendConcurrency({ settings, hardware: null, arenaGb: null, useCase: 'multiUser' })).toMatchObject({ parallel: 1, reasons: expect.arrayContaining(['hardware_unknown']) });
  });
});

describe('issues', () => {
  const codes = (cfg: Record<string, unknown>, options = {}) => concurrencyIssues(readConcurrencySettings(cfg as never), options).map(i => i.code);
  it('flags conflicts with one-click fixes', () => {
    const issues = concurrencyIssues(readConcurrencySettings(config(['--batch', '4'], { parallel: 2 }) as never));
    expect(issues[0]).toMatchObject({ code: 'parallel_batch_conflict', severity: 'error', fix: [{ key: 'parallel', value: '4' }, { key: '--batch', value: '' }] });
    expect(codes(config(['--batch', '2']))).toContain('batch_arg_merge');
    expect(codes(config([], { parallel: 2 }), { platform: 'mac' })).toContain('metal_unsupported');
    expect(codes(config([], { parallel: 12 }))).toContain('engine_cap');
  });
  it('follows BATCHING.md group and MTP rules', () => {
    const split = (args: string[], parallel = 4) => config(['--layer-split', '24', ...args], { gpu: [0, 1], parallel });
    expect(codes(split(['--batch-groups', '3']))).toContain('groups_divide');
    expect(codes(split(['--batch-mtp', '--mtp', 'm']))).toContain('batch_mtp_pipeline_off');
    expect(codes(split(['--batch-mtp', '--mtp', 'm', '--batch-groups', '1']))).not.toContain('batch_mtp_pipeline_off');
    expect(codes(split(['--batch-mtp', '--mtp', 'm', '--adapt-async', '1']))).not.toContain('batch_mtp_pipeline_off');
    expect(codes(split(['--adapt-async', '1', '--batch-groups', 'auto']))).toContain('adapt_async_pipeline');
    expect(codes(split(['--batch-mtp', '--mtp', 'm', '--batch-groups', '1'], 6))).toContain('batch_mtp_split_cap');
    expect(codes(config(['--batch-mtp'], { parallel: 2 }))).toContain('batch_mtp_needs_mtp');
    expect(codes(config(['--trim-stage-weights', '--layer-split', 'auto'], { gpu: [0, 1] }))).toContain('trim_needs_explicit_split');
    expect(codes(config([], { parallel: 2, env: { STRATA_PIPED_CONCURRENT: '1' } }))).toContain('piped_needs_split');
  });
  it('warns about speed, long context, pinned RAM and request limits', () => {
    expect(codes(config([], { parallel: 4 }), { officialParallel: 1 })).toContain('slow_per_request');
    expect(codes(config([], { parallel: 4 }), { officialParallel: 2 })).toContain('above_recommendation');
    expect(codes(config(['--max-context', '524288'], { parallel: 2 }))).toContain('long_context_conflict');
    expect(codes(config(['--max-context', '262144', '--kv-resident', '2'], { parallel: 8 }), { ramGib: 32 })).toContain('pinned_ram');
    expect(codes(config(['--prompt-cache', '0'], { parallel: 2 }))).toEqual(expect.arrayContaining(['prompt_cache_off', 'parallel_limits']));
    expect(codes(config([]))).toEqual([]);
  });
  it('blocks saving only what the engine refuses', () => {
    expect(concurrencyConfigError(config(['--layer-split', '24', '--batch-groups', '3'], { gpu: [0, 1], parallel: 4 }) as never)).toMatch(/--batch-groups 3/);
    expect(concurrencyConfigError(config(['--batch', '4'], { parallel: 2 }) as never)).toBeNull();
    expect(() => validateStartupConfiguration(config(['--layer-split', '24', '--batch-groups', '3'], { gpu: [0, 1], parallel: 4 }) as never)).toThrow(/--batch-groups/);
  });
  it('has zh and en text for every message', () => {
    expect(concurrencyMessage('groups_divide', true, { groups: 3, slots: 4 })).toBe('组数 3 必须整除槽数 4。');
    expect(concurrencyMessage('engine_cap', false, { max: 8 })).toBe('One GPU runs at most 8 slots; the rest have no effect.');
  });
});

describe('startup fields', () => {
  it('adds trim stage weights and experimental env switches without removing existing fields', () => {
    const keys = STARTUP_TUNING_FIELDS.map(f => f.key);
    for (const key of ['parallel', '--batch', '--batch-mtp', '--batch-groups', '--adapt-async', '--trim-stage-weights', 'env.STRATA_BATCH_ATTN_ROWS', 'env.STRATA_BATCH_GDN_GROUPS', 'env.STRATA_PIPED_CONCURRENT']) expect(keys).toContain(key);
    const env = STARTUP_TUNING_FIELDS.find(f => f.key === 'env.STRATA_BATCH_GDN_GROUPS')!;
    const on = applyStartupField({ args: [] }, env, '1');
    expect(on.env).toEqual({ STRATA_BATCH_GDN_GROUPS: '1' });
    expect(readConcurrencySettings(on).experimental.STRATA_BATCH_GDN_GROUPS).toBe(true);
    const trim = STARTUP_TUNING_FIELDS.find(f => f.key === '--trim-stage-weights')!;
    expect(applyStartupField({ args: [] }, trim, 'true').args).toEqual(['--trim-stage-weights']);
  });
});
