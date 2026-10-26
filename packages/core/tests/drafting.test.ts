import { describe, expect, it } from 'vitest';
import { applyDrafting, draftingChoices, draftingFamilyOf, draftingModeOf, draftingSupport, effectiveDraftingOf, normalizeDrafting } from '../src/drafting';

describe('drafting (upstream v0.2.6 drafting.py / drafting.ts)', () => {
  it('maps engine versions to the key they read', () => {
    expect(draftingSupport('0.1.51')).toBe('drafting');
    expect(draftingSupport('0.1.48')).toBe('drafting');
    expect(draftingSupport('0.1.47')).toBe('mtpSwitch');
    expect(draftingSupport('v0.1.46')).toBe('mtpSwitch');
    expect(draftingSupport('0.1.43.1')).toBe('none');
    expect(draftingSupport(undefined)).toBe('unknown');
    expect(draftingSupport('nightly')).toBe('unknown');
  });
  it('normalizes like upstream and reads the legacy mtp switch', () => {
    expect(normalizeDrafting(' MTP ')).toBe('mtp');
    expect(normalizeDrafting('eagle')).toBe('auto');
    expect(draftingModeOf({ args: [] })).toBe('auto');
    expect(draftingModeOf({ mtp: false })).toBe('off');
    expect(draftingModeOf({ mtp: '/data/mtp/rt' })).toBe('auto');
    expect(draftingModeOf({ drafting: 'mtp', mtp: false })).toBe('mtp');
    expect(draftingModeOf({ drafting: 'bogus' })).toBe('auto');
  });
  it('hides DFlash2 unless the family is supported and Control serves it', () => {
    expect(draftingChoices('qwen', undefined)).toEqual(['auto', 'mtp', 'off']);
    expect(draftingChoices('qwen', false)).toEqual(['auto', 'mtp', 'off']);
    expect(draftingChoices('swift', true)).toEqual(['auto', 'mtp', 'off']);
    expect(draftingChoices('gyro', true)).toEqual(['auto', 'mtp', 'dflash2', 'off']);
    expect(draftingChoices(null, false, 'dflash2')).toContain('dflash2');
    expect(draftingFamilyOf({ model_name: 'qwen3.8-flash-next-iq3_s' })).toBe('qwen');
    expect(draftingFamilyOf({ model_name: 'Qwen3.8-Flash-Next-gyro-v2' })).toBe('gyro');
    expect(draftingFamilyOf({ model_name: 'qwen3.6-35b' })).toBeNull();
  });
  it('0.1.48+ writes drafting and clears a stale mtp:false so server.py does not keep MTP off', () => {
    expect(applyDrafting({ args: [], mtp: false }, 'auto', '0.1.51')).toEqual({ args: [], drafting: 'auto' });
    expect(applyDrafting({ args: [] }, 'mtp', '0.1.48')).toEqual({ args: [], drafting: 'mtp' });
    expect(applyDrafting({ args: [] }, 'off', '0.1.48')).toEqual({ args: [], drafting: 'off' });
    expect(applyDrafting({ args: [], mtp: '/d/mtp/rt' }, 'off', '0.1.48')).toEqual({ args: [], mtp: '/d/mtp/rt', drafting: 'off' });
  });
  it('0.1.46-0.1.47: Off is mtp:false, Auto/MTP write no field', () => {
    expect(applyDrafting({ args: [] }, 'off', '0.1.47')).toEqual({ args: [], mtp: false });
    expect(applyDrafting({ args: [], mtp: false, drafting: 'off' }, 'auto', '0.1.47')).toEqual({ args: [] });
    expect(applyDrafting({ args: [], mtp: false }, 'mtp', '0.1.46')).toEqual({ args: [] });
    expect(applyDrafting({ args: [] }, 'dflash2', '0.1.47')).toEqual({ args: [] });
  });
  it('an unknown version writes both keys for Off and never adds drafting for Auto/MTP; too-old engines are untouched', () => {
    expect(applyDrafting({ args: [] }, 'off', null)).toEqual({ args: [], drafting: 'off', mtp: false });
    expect(applyDrafting({ args: [], mtp: false }, 'auto', null)).toEqual({ args: [] });
    expect(applyDrafting({ args: [], drafting: 'off', mtp: false }, 'mtp', null)).toEqual({ args: [], drafting: 'mtp' });
    const old = { args: [], mtp: false };
    expect(applyDrafting(old, 'auto', '0.1.45')).toBe(old);
  });
  it('derives what ran from the effective args', () => {
    expect(effectiveDraftingOf(['--mtp', '/d/mtp/rt', '--spec'])).toBe('mtp');
    expect(effectiveDraftingOf(['--draft', 'dflash2', '--draft-model', 'p'])).toBe('dflash2');
    expect(effectiveDraftingOf(['--spec'])).toBe('off');
    expect(effectiveDraftingOf(undefined)).toBeNull();
  });
});
