import { describe, expect, it } from 'vitest';
import { ORCA_ARENA_GIB, ORCA_CONTEXT, ORCA_MODEL_NAME, ORCA_SHARDS, ORCA_TOTAL_BYTES, isOrcaRouterEvidence, orcaRamCheck, orcaShardProblem } from '../src/orca-import';
import { arenaModelOf } from '../src/arena';
import { concurrencyModelIdentity } from '../src/concurrency';
import { resourceRequestFromConfiguration } from '../src/resource-assessment';

const GIB = 1024 ** 3;
const shard1 = 'Qwen3.8-Flash-Next-Uncensored-IQ3_XXS-00001-of-00002.gguf';
const orcaConfig = {
  exe: 'engine/strata', model_name: ORCA_MODEL_NAME,
  args: ['--pack', '/data/packs/orca-iq3_xxs', '--native', `/hf/${shard1}`, '--ple-gguf', `/hf/${shard1}`, '--expert-cache', 'auto', '--prefill', '512', '--max-context', '32768', '--kv', 'int8'],
};

describe('OrcaRouter import (ORCA.md)', () => {
  it('pins the validated IQ3_XXS shards: 2 files, 85.20 GB, 32K context, 49.8 GiB arena', () => {
    expect(ORCA_SHARDS.map(s => s.name)).toEqual([shard1, 'Qwen3.8-Flash-Next-Uncensored-IQ3_XXS-00002-of-00002.gguf']);
    expect((ORCA_TOTAL_BYTES / 1e9).toFixed(2)).toBe('85.20');
    expect(ORCA_CONTEXT).toBe(32768);
    expect(ORCA_ARENA_GIB).toBe(49.8);
  });

  it('accepts only shard 1 of IQ3_XXS and names why the rest are refused (Windows and POSIX paths)', () => {
    expect(orcaShardProblem(`C:\\Users\\a\\Downloads\\${shard1}`)).toBeNull();
    expect(orcaShardProblem(`/home/a/.cache/huggingface/hub/models--orcarouter/snapshots/x/${shard1}`)).toBeNull();
    expect(orcaShardProblem('D:\\m\\Qwen3.8-Flash-Next-Uncensored-IQ3_XXS-00002-of-00002.gguf')).toEqual({ problem: 'second' });
    expect(orcaShardProblem('/m/Qwen3.8-Flash-Next-Uncensored-IQ3_M-00001-of-00002.gguf')).toEqual({ problem: 'iq3m', quant: 'IQ3_M' });
    expect(orcaShardProblem('/m/Qwen3.8-Flash-Next-Uncensored-Q4_K_M-00001-of-00003.gguf')).toEqual({ problem: 'unvalidated', quant: 'Q4_K_M' });
    expect(orcaShardProblem('/m/Qwen3.8-Flash-Next-Uncensored-IQ4_XS-MTP-00001-of-00003.gguf')).toEqual({ problem: 'unvalidated', quant: 'IQ4_XS-MTP' });
    expect(orcaShardProblem('/m/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf')).toEqual({ problem: 'gsq' });
    expect(orcaShardProblem('/m/other.gguf')).toEqual({ problem: 'foreign' });
  });

  it('warns on RAM without refusing', () => {
    expect(orcaRamCheck(128 * GIB, 100 * GIB)).toBe('ok');
    expect(orcaRamCheck(64 * GIB, 40 * GIB)).toBe('tight');
    expect(orcaRamCheck(48 * GIB, 40 * GIB)).toBe('insufficient');
    expect(orcaRamCheck(null)).toBe('unknown');
  });

  it('is never estimated as the official GSQ-RCO IQ3_XXS', () => {
    expect(isOrcaRouterEvidence(ORCA_MODEL_NAME)).toBe(true);
    expect(isOrcaRouterEvidence('qwen3.8-flash-next-iq3_xxs')).toBe(false);
    expect(concurrencyModelIdentity(orcaConfig)).toBeNull();
    expect(resourceRequestFromConfiguration(orcaConfig, 'id')).toBeNull();
    expect(resourceRequestFromConfiguration({ ...orcaConfig, model_name: 'qwen3.8-flash-next-iq3_xxs', args: ['--native', '/m/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf', '--max-context', '32768', '--kv', 'int8'] }, 'id')).toMatchObject({ family: 'qwen', quant: 'IQ3_XXS' });
    expect(arenaModelOf(`${shard1} orca-iq3_xxs`)).toBeNull();
    // the official file is still recognized
    expect(arenaModelOf('Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf')).toEqual({ family: 'qwen', quant: 'IQ3_XXS' });
    expect(concurrencyModelIdentity({ ...orcaConfig, model_name: 'qwen3.8-flash-next-iq3_xxs', args: ['--native', '/m/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf'] })).toEqual({ family: 'qwen', quant: 'IQ3_XXS' });
  });
});
