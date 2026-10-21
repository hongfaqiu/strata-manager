import { describe, expect, it } from 'vitest';
import { MODEL_CATALOG } from '../src/catalog';
import { normalizeGpuSelection, normalizeOfficialSetupOptions, validateHfEndpoint, validateModelInspectRequest } from '../src/official-setup';

describe('official setup inputs', () => {
  it('accepts per-task download choices without carrying stale mirror configuration', () => {
    expect(normalizeOfficialSetupOptions({ source: 'mirror', hfEndpoint: 'https://hf-mirror.com/' })).toEqual({ source: 'mirror', backend: 'auto', gpus: '', hfEndpoint: 'https://hf-mirror.com' });
    // Strata 0.2.2 --gpu-roles: canonical text, the chosen cards must be the ones the roles turn on.
    expect(normalizeOfficialSetupOptions({ gpus: '0,2', gpuRoles: '2=main,0=helper' })).toEqual({ source: 'official', backend: 'auto', gpus: '0,2', gpuRoles: '0=helper,2=main' });
    expect(normalizeOfficialSetupOptions({ gpus: '', gpuRoles: '1=main' }).gpuRoles).toBe('1=main');
    expect(() => normalizeOfficialSetupOptions({ gpus: '0,1', gpuRoles: '0=helper,2=main' })).toThrow();
    expect(() => normalizeOfficialSetupOptions({ gpus: 'all', gpuRoles: '0=main' })).toThrow();
    expect(() => normalizeOfficialSetupOptions({ gpuRoles: '0=main,1=main' })).toThrow();
    expect(normalizeOfficialSetupOptions({ source: 'modelscope', hfEndpoint: 'https://old.example' })).not.toHaveProperty('hfEndpoint');
  });
  it('rejects credentials, query strings, unsafe protocols and malformed endpoints', () => {
    for (const endpoint of ['http://mirror.example', 'https://u:p@mirror.example', 'https://mirror.example/?token=secret', 'https://mirror.example/#token', 'https://mirror.example\\x', 'https://mirror.example\n']) expect(() => validateHfEndpoint(endpoint)).toThrow();
  });
  it('retains GPU order, rejects duplicates and never treats user text as flags', () => {
    expect(normalizeGpuSelection('2, 0')).toBe('2,0');
    expect(normalizeGpuSelection('all')).toBe('all');
    for (const value of ['1,1', '256', '-1', '0 --build', '0,', '0\n', 'all\n', '\n', '0,1,2,3,4,5,6,7,8']) expect(() => normalizeGpuSelection(value)).toThrow();
  });
  it('permits local paths with spaces, repository filters and HTTPS files', () => {
    expect(validateModelInspectRequest({ installationId: 'runtime', target: 'D:\\模型 文件\\part.gguf' }).target).toBe('D:\\模型 文件\\part.gguf');
    expect(validateModelInspectRequest({ installationId: 'runtime', target: 'hf:owner/repo', variant: 'IQ3_S' }).variant).toBe('IQ3_S');
    expect(validateModelInspectRequest({ installationId: 'runtime', target: 'https://huggingface.co/owner/repo/resolve/main/part.gguf' }).target).toContain('https://');
  });
  it('rejects flag injection and credential-bearing remote inspection', () => {
    for (const target of ['--setup', 'relative.gguf', 'hf:owner/repo --yes', 'hf:../repo', 'ms:owner/.', 'https://u:p@host/file.gguf', 'https://host/file.gguf?token=secret', 'https://host\\file.gguf']) expect(() => validateModelInspectRequest({ installationId: 'runtime', target })).toThrow();
    expect(() => validateModelInspectRequest({ installationId: 'runtime', target: 'hf:owner/repo', variant: '--setup' })).toThrow();
  });
  it('exposes the newly supported Swift IQ3_S tier', () => {
    expect(MODEL_CATALOG.find(model => model.id === 'swift')?.quants).toContain('IQ3_S');
    expect(MODEL_CATALOG.find(model => model.id === 'qwen36')?.quants).toEqual(['UD-Q4_K_XL', 'UD-Q6_K_XL', 'Q8_0']);
  });
  it('exposes Unsloth UD-Q5_K_XL / UD-Q6_K_XL / Q8_0 for high-RAM machines', () => {
    expect(MODEL_CATALOG.find(model => model.id === 'unsloth')?.quants).toEqual([
      'UD-IQ4_XS', 'UD-Q4_K_XL', 'UD-Q5_K_XL', 'UD-Q6_K_XL', 'Q8_0',
    ]);
  });
});
