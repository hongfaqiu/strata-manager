import { describe, expect, it } from 'vitest';
import { MODEL_CATALOG, catalogEngineGate, catalogQuantEngineGate, isCatalogCombination, nvfp4DiskNeedGB } from '../src/catalog';
import { OFFICIAL_REPO_OWNERS, nvidiaCardPossible, officialFamilyBlock, setupSupports } from '../src/community-catalog';
import { localModelCommand } from '../src/local-model';
import { filterCatalogForPlatform } from '../src/local-runtime-package';

describe('nvfp4 catalog', () => {
  it('lists the three setup.py NVFP4 packs, NVIDIA only, with their engines', () => {
    const model = MODEL_CATALOG.find(entry => entry.family === 'nvfp4')!;
    expect(model.quants).toEqual(['NVFP4', 'NVFP4-NVIDIA', 'NVFP4-QAD']);
    expect(model.images).toBe(true);
    expect(model.quantInfo.NVFP4).toMatchObject({ downloadGB: 128.0, ramGB: 80, nvidiaOnly: true });
    expect(model.quantInfo['NVFP4-QAD']).toMatchObject({ downloadGB: 102.2, prepareGB: 110, minEngine: '0.1.45' });
    expect(isCatalogCombination('nvfp4', 'NVFP4-NVIDIA')).toBe(true);
    expect(setupSupports('nvfp4', 'NVFP4-QAD')).toBe(true);
    expect(catalogEngineGate('nvfp4', '0.1.43')?.ok).toBe(false);
    expect(catalogEngineGate('nvfp4', '0.1.44')?.ok).toBe(true);
    expect(catalogQuantEngineGate('nvfp4', 'NVFP4-QAD', '0.1.44')?.ok).toBe(false);
    expect(OFFICIAL_REPO_OWNERS).toContain('Maximilian228');
  });

  it('reserves the QAD conversion on this PC beside its download', () => {
    expect(nvfp4DiskNeedGB('NVFP4-QAD')).toEqual({ totalGB: 102.2 + 110 + 4 + 2, downloadGB: 102.2, prepareGB: 110 });
    expect(nvfp4DiskNeedGB('NVFP4')?.totalGB).toBe(128 + 8 + 2);
    expect(nvfp4DiskNeedGB('IQ3_S')).toBeUndefined();
  });

  it('is hidden without an NVIDIA card and on a Mac', () => {
    expect(officialFamilyBlock('nvfp4', 'windows', ['NVIDIA GeForce RTX 5090, 581.15, 32607 MiB'])).toBeUndefined();
    expect(officialFamilyBlock('nvfp4', 'linux', ['AMD Radeon AI PRO R9700'])).toBe('nvidiaOnly');
    expect(officialFamilyBlock('nvfp4', 'windows', [])).toBeUndefined(); // unknown GPUs: offered, setup decides
    expect(officialFamilyBlock('qwen', 'linux', ['AMD Radeon AI PRO R9700'])).toBeUndefined();
    expect(officialFamilyBlock('nvfp4', 'macos')).toBeDefined();
    expect(filterCatalogForPlatform(MODEL_CATALOG, 'macos').some(entry => entry.family === 'nvfp4')).toBe(false);
    expect(nvidiaCardPossible(['Intel(R) Arc(TM) A770'])).toBe(false);
  });

  it('uses an existing pack by --data-dir, not --gguf-dir', () => {
    const group = { id: 'x', name: 'x', firstShard: 'qwen-nvfp4-gptq-dense.gguf', quant: 'NVFP4', kind: 'official' as const, family: 'nvfp4', totalBytes: 0, installable: true, complete: true, shards: [], warnings: [], problems: [] };
    const command = localModelCommand(group, { ggufDirectory: '/d/models/Maximilian228--Qwen3.8-Flash-Next-NVFP4-GPTQ-Strata' }, undefined, 32768, false, true, '/d');
    expect(command).toBe('python setup.py --family nvfp4 --model NVFP4 --context 32768 --vision yes --data-dir /d');
  });
});
