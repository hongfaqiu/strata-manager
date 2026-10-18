import { describe, expect, it } from 'vitest';
import { MODEL_CATALOG, catalogEngineGate, isCatalogCombination } from '../src/catalog';

describe('qwen36 catalog', () => {
  it('lists Unsloth MTP quants with engine 0.1.45 gate', () => {
    const model = MODEL_CATALOG.find(entry => entry.family === 'qwen36')!;
    expect(model.name).toBe('Qwen3.6-35B-A3B');
    expect(model.quants).toEqual(['UD-Q4_K_XL', 'UD-Q6_K_XL', 'Q8_0']);
    expect(model.minEngine).toBe('0.1.45');
    expect(model.quantInfo['UD-Q4_K_XL']).toMatchObject({ downloadGB: 22.9, ramGB: 32 });
    expect(isCatalogCombination('qwen36', 'UD-Q4_K_XL')).toBe(true);
    expect(isCatalogCombination('qwen36', 'IQ3_S')).toBe(false);
  });

  it('gates install until the runtime is 0.1.45 or newer', () => {
    expect(catalogEngineGate('qwen36', null)?.ok).toBe(false);
    expect(catalogEngineGate('qwen36', '0.1.44.1')?.ok).toBe(false);
    expect(catalogEngineGate('qwen36', '0.1.45')?.ok).toBe(true);
    expect(catalogEngineGate('qwen36', '0.1.46')?.ok).toBe(true);
    expect(catalogEngineGate('qwen', '0.1.40')).toBeNull();
  });
});
