import { describe, expect, it } from 'vitest';
import { defaultLocalGgufGroup, groupLocalGgufs, localModelAction, localModelBaseName, localModelCommand, localOrcaRequest, localSetupRequest, type LocalGgufGroup } from '../src/local-model';
import type { ModelDownloadRequest } from '../src/model-download';
import { normalizeOfficialSetupOptions } from '../src/official-setup';

const group = (patch: Partial<LocalGgufGroup>): LocalGgufGroup => ({
  id: patch.name ?? 'g', name: 'Qwen3.8-Flash-Next-UD-Q4_K_XL', firstShard: 'Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00006.gguf', quant: 'UD-Q4_K_XL', kind: 'official', family: 'unsloth',
  shards: [], totalBytes: 1, complete: true, installable: true, warnings: [], problems: [], ...patch,
});
const base: ModelDownloadRequest = {
  profile: { id: 'r', name: 'Strata', baseUrl: 'http://127.0.0.1:8080', installDir: 'C:\\Strata', pythonPath: '', configPath: '', managed: true },
  model: 'unsloth', quant: 'UD-Q4_K_XL', context: 32768, images: false,
  options: normalizeOfficialSetupOptions(),
};

describe('使用已有模型 (#75)', () => {
  it('groups files by model with every quantization as a variant, installable first', () => {
    const scan = { groups: [
      group({ id: 'a', name: 'Qwen3.8-Flash-Next-UD-Q8_K_XL', quant: 'UD-Q8_K_XL', kind: 'unsupported', family: null, installable: false }),
      group({ id: 'b' }),
      group({ id: 'c', name: 'Qwen3.8-Flash-Next-Uncensored-IQ3_XXS', quant: 'IQ3_XXS', kind: 'orca', family: 'orca' }),
      group({ id: 'd', name: 'my-model', quant: null, kind: 'unknown', family: null, installable: false }),
    ] };
    const choices = groupLocalGgufs(scan);
    expect(choices.map(c => c.model)).toEqual(['Qwen3.8-Flash-Next', 'Qwen3.8-Flash-Next-Uncensored', 'my-model']);
    expect(choices[0]!.variants.map(v => v.id)).toEqual(['b', 'a']);
    expect(defaultLocalGgufGroup(scan as never)?.id).toBe('b');
    expect(localModelBaseName({ name: 'swift-1.5-IQ3_S', quant: 'IQ3_S' })).toBe('swift-1.5');
  });

  it('routes official/renamed files to setup, OrcaRouter to the ORCA.md import, and blocks the rest', () => {
    expect(localModelAction(group({}))).toBe('setup');
    expect(localModelAction(group({ kind: 'renamed' }))).toBe('setup');
    expect(localModelAction(group({ kind: 'orca', family: 'orca', quant: 'IQ3_XXS' }))).toBe('orca');
    expect(localModelAction(group({ kind: 'unsupported', installable: false }))).toBe('blocked');
    expect(localModelAction(undefined)).toBe('blocked');
  });

  it('maps an MTP folder to --data-dir in the equivalent START-HERE.bat command (setup.py has no --mtp flag)', () => {
    const mtp = { input: 'D:\\AI\\mtp\\rt', rtDirectory: 'D:\\AI\\mtp\\rt', dataDirectory: 'D:\\AI', expertsBytes: 1, problems: [] };
    expect(localModelCommand(group({}), { ggufDirectory: 'D:\\My Models\\gguf' }, mtp, 32768, true))
      .toBe('START-HERE.bat --family unsloth --model UD-Q4_K_XL --gguf-dir "D:\\My Models\\gguf" --context 32768 --data-dir D:\\AI');
    expect(localModelCommand(group({}), { ggufDirectory: '/m' }, undefined, 8192, false)).toBe('python setup.py --family unsloth --model UD-Q4_K_XL --gguf-dir /m --context 8192');
    expect(localModelCommand(group({ kind: 'orca', family: 'orca', quant: 'IQ3_XXS' }), { ggufDirectory: '/m' }, mtp, 32768, false)).toContain('--compat-bf16');
  });

  it('builds run_setup and ORCA import requests only for matching groups', () => {
    expect(localSetupRequest(base, group({}), { ggufDirectory: ' D:\\m ', mtpPath: ' ' }).localModel).toEqual({ ggufDirectory: 'D:\\m' });
    expect(localSetupRequest(base, group({}), { ggufDirectory: 'D:\\m', mtpPath: 'D:\\AI\\mtp' }).localModel).toEqual({ ggufDirectory: 'D:\\m', mtpPath: 'D:\\AI\\mtp' });
    expect(() => localSetupRequest({ ...base, quant: 'Q8_0' }, group({}), { ggufDirectory: 'D:\\m' })).toThrow();
    expect(() => localSetupRequest(base, group({ kind: 'unsupported', installable: false }), { ggufDirectory: 'D:\\m' })).toThrow();
    const orca = group({ kind: 'orca', family: 'orca', quant: 'IQ3_XXS', firstShard: 'Qwen3.8-Flash-Next-Uncensored-IQ3_XXS-00001-of-00002.gguf' });
    expect(localOrcaRequest(orca, { ggufDirectory: 'D:\\hf\\', mtpPath: 'D:\\AI\\mtp\\rt' }, '\\')).toEqual({ source: 'local', shardPath: 'D:\\hf\\Qwen3.8-Flash-Next-Uncensored-IQ3_XXS-00001-of-00002.gguf', mtp: true, mtpPath: 'D:\\AI\\mtp\\rt' });
    expect(() => localOrcaRequest(group({}), { ggufDirectory: '/m' }, '/')).toThrow();
  });
});
