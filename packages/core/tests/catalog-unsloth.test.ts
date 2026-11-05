import { describe, expect, it } from 'vitest';
import { MODEL_CATALOG, catalogQuantEngineGate, isCatalogCombination } from '../src/catalog';

describe('Unsloth higher quants', () => {
  const model = MODEL_CATALOG.find(m => m.id === 'unsloth')!;

  it('lists Unsloth Dynamic v3.1 sets and higher quants with setup.py sizes', () => {
    expect(model.quants).toEqual([
      'UD-IQ1_M', 'UD-Q2_0', 'UD-IQ2_XS', 'UD-Q2_K_XL', 'UD-IQ3_XXS', 'UD-Q3_K_XL', 'UD-IQ4_XS-v31',
      'UD-IQ4_XS', 'UD-Q4_K_XL', 'UD-Q5_K_XL', 'UD-Q6_K_XL', 'Q8_0',
    ]);
    expect(model.quantInfo['UD-IQ1_M']).toMatchObject({ downloadGB: 68.0, ramGB: 48, minEngine: '0.1.57' });
    expect(model.quantInfo['UD-Q2_0']).toMatchObject({ downloadGB: 70.5, ramGB: 48, minEngine: '0.1.57' });
    expect(model.quantInfo['UD-IQ4_XS-v31']).toMatchObject({ downloadGB: 93.7, ramGB: 48, minEngine: '0.1.57' });
    expect(model.quantInfo['UD-IQ4_XS']).toMatchObject({ downloadGB: 93.7, ramGB: 48 });
    expect(model.quantInfo['UD-Q5_K_XL']).toMatchObject({ downloadGB: 158.3, ramGB: 108, minEngine: '0.1.44' });
    expect(model.quantInfo['UD-Q6_K_XL']).toMatchObject({ downloadGB: 169.2, ramGB: 118, minEngine: '0.1.44' });
    expect(model.quantInfo.Q8_0).toMatchObject({ downloadGB: 188.2, ramGB: 136, minEngine: '0.1.38' });
    expect(isCatalogCombination('unsloth', 'UD-IQ1_M')).toBe(true);
    expect(isCatalogCombination('unsloth', 'UD-IQ4_XS-v31')).toBe(true);
    expect(isCatalogCombination('unsloth', 'UD-Q5_K_XL')).toBe(true);
    expect(isCatalogCombination('unsloth', 'Q8_0')).toBe(true);
    expect(isCatalogCombination('unsloth', 'IQ3_S')).toBe(false);
  });

  it('gates Q5/Q6 on engine 0.1.44, Q8_0 on 0.1.38, and v3.1 on 0.1.57', () => {
    expect(catalogQuantEngineGate('unsloth', 'UD-IQ4_XS', '0.1.40')).toBeNull();
    expect(catalogQuantEngineGate('unsloth', 'UD-IQ1_M', '0.1.56')).toEqual({ minEngine: '0.1.57', ok: false });
    expect(catalogQuantEngineGate('unsloth', 'UD-IQ4_XS-v31', '0.1.57')).toEqual({ minEngine: '0.1.57', ok: true });
    expect(catalogQuantEngineGate('unsloth', 'UD-Q5_K_XL', '0.1.43')).toEqual({ minEngine: '0.1.44', ok: false });
    expect(catalogQuantEngineGate('unsloth', 'UD-Q5_K_XL', '0.1.44')).toEqual({ minEngine: '0.1.44', ok: true });
    expect(catalogQuantEngineGate('unsloth', 'UD-Q6_K_XL', '0.1.45')).toEqual({ minEngine: '0.1.44', ok: true });
    expect(catalogQuantEngineGate('unsloth', 'Q8_0', '0.1.37')).toEqual({ minEngine: '0.1.38', ok: false });
    expect(catalogQuantEngineGate('unsloth', 'Q8_0', '0.1.38')).toEqual({ minEngine: '0.1.38', ok: true });
    expect(catalogQuantEngineGate('unsloth', 'UD-Q5_K_XL', null)).toEqual({ minEngine: '0.1.44', ok: false });
  });
});
