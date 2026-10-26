import { describe, expect, it } from 'vitest';
import {
  MODEL_CATALOG, applyDeepseek41LoadMode, applyDeepseek41Speed, catalogReleaseGate, deepseek41DiskNeedGB, deepseek41EngineVersion,
  deepseek41HasCard, deepseek41LoadMode, deepseek41MemoryClass, deepseek41Speed, deepseek41SpeedSupported, filterCatalogForPlatform,
  isCatalogCombination, isDeepseek41Config, recommendDeepseek41, snapshotModelDownloadRequest, versionAtLeast,
  STARTUP_TUNING_FIELDS, applyStartupField, deepseek41ArgsError, startupArgumentRows, startupEngineFlagsFor, startupFieldApplies,
  startupFieldValue, validateStartupConfiguration, DEEPSEEK41_ENGINE_FLAGS, STARTUP_ENGINE_FLAGS,
} from '../src';
import type { ServiceProfile } from '../src';

const exe = (version: string) => `C:\\Strata\\engine-dsv41\\${version}-windows-x64-cuda\\strata-dsv41.exe`;
const config = (version = '0.1.50', args: string[] = ['--pack', '/m/pack', '--max-context', '8192']) => ({ arch: 'deepseek41', exe: exe(version), args });

describe('deepseek41 catalog', () => {
  it('lists the three IST-DAS sets with dsv41_fit sizes, 2.25 manual only, text only at 8K', () => {
    const model = MODEL_CATALOG.find(entry => entry.family === 'deepseek41')!;
    expect(model.name).toBe('DeepSeek-V4.1-Flash');
    expect(model.quants).toEqual(['IST-DAS-2.00bpw', 'IST-DAS-1.75bpw', 'IST-DAS-2.25bpw']);
    expect(model.images).toBe(false);
    expect(model.fixedContext).toBe(8192);
    expect(model.minRelease).toBe('0.2.5');
    expect(model.quantInfo['IST-DAS-2.00bpw']).toMatchObject({ downloadGB: 256.8, ramGB: 40, expertsGB: 132.07 });
    expect(model.quantInfo['IST-DAS-1.75bpw']).toMatchObject({ downloadGB: 239.3, ramGB: 34, expertsGB: 114.56 });
    expect(model.quantInfo['IST-DAS-2.25bpw']).toMatchObject({ downloadGB: 273.8, ramGB: 44, manualOnly: true });
    expect(isCatalogCombination('deepseek41', 'IST-DAS-1.75bpw')).toBe(true);
    expect(isCatalogCombination('deepseek41', 'UD-Q8_K_XL')).toBe(false);
    expect(deepseek41DiskNeedGB('IST-DAS-2.00bpw')).toBe(262.8);
  });

  it('is hidden on a Mac (the Metal engine has no DeepSeek port)', () => {
    expect(filterCatalogForPlatform(MODEL_CATALOG, 'macos').some(model => model.family === 'deepseek41')).toBe(false);
  });

  it('gates on the Strata release, not the engine build', () => {
    expect(catalogReleaseGate('deepseek41', '0.2.4')).toEqual({ minRelease: '0.2.5', ok: false });
    expect(catalogReleaseGate('deepseek41', 'v0.2.5')?.ok).toBe(true);
    expect(catalogReleaseGate('deepseek41', '0.2.10')?.ok).toBe(true);
    expect(catalogReleaseGate('deepseek41', undefined)?.ok).toBe(false);
    expect(catalogReleaseGate('qwen', '0.2.0')).toBeNull();
    expect(versionAtLeast('0.1.50', '0.1.50')).toBe(true);
    expect(versionAtLeast('0.1.49.2', '0.1.50')).toBe(false);
  });

  it('recommends like dsv41_fit: 1.75 below 40 GiB or when only 1.75 fits the disk, else 2.00, never 2.25', () => {
    expect(recommendDeepseek41(32, 1000)).toBe('IST-DAS-1.75bpw');
    expect(recommendDeepseek41(64, 250)).toBe('IST-DAS-1.75bpw');
    expect(recommendDeepseek41(64, 200)).toBe('IST-DAS-2.00bpw');
    expect(recommendDeepseek41(256, 2000)).toBe('IST-DAS-2.00bpw');
    expect(recommendDeepseek41(undefined, undefined)).toBe('IST-DAS-2.00bpw');
  });

  it('classes RAM and cards like dsv41_fit', () => {
    expect(deepseek41MemoryClass('IST-DAS-2.00bpw', 160)).toBe('fits');
    expect(deepseek41MemoryClass('IST-DAS-2.00bpw', 64)).toBe('tight');
    expect(deepseek41MemoryClass('IST-DAS-2.00bpw', 32)).toBe('spills');
    expect(deepseek41MemoryClass('IST-DAS-2.00bpw', undefined)).toBe('unknown');
    expect(deepseek41HasCard(['NVIDIA GeForce RTX 4070 12GB'])).toBe(true);
    expect(deepseek41HasCard(['Intel(R) UHD Graphics'])).toBe(false);
    expect(deepseek41HasCard([])).toBeNull();
  });

  it('refuses another context or images in a download request', () => {
    const profile = { id: 'p', name: 'S', managed: true, installDir: '/s', pythonPath: '/s/.venv/bin/python', configPath: '/s/c.json', baseUrl: 'http://127.0.0.1:8000' } as unknown as ServiceProfile;
    const base = { model: 'deepseek41', quant: 'IST-DAS-2.00bpw', images: false } as const;
    expect(snapshotModelDownloadRequest(profile, { ...base, context: 8192 }, {}).context).toBe(8192);
    expect(() => snapshotModelDownloadRequest(profile, { ...base, context: 32768 }, {})).toThrow(/8192/);
    expect(() => snapshotModelDownloadRequest(profile, { ...base, context: 8192, images: true }, {})).toThrow();
  });
});

describe('deepseek41 run options', () => {
  it('reads the engine build from the exe path and offers --experts from 0.1.50', () => {
    expect(isDeepseek41Config(config())).toBe(true);
    expect(isDeepseek41Config({ arch: 'qwen35' })).toBe(false);
    expect(deepseek41EngineVersion(exe('0.1.50'))).toBe('0.1.50');
    expect(deepseek41EngineVersion('/opt/strata/engine-dsv41/0.1.51-linux-x64-cuda/strata-dsv41')).toBe('0.1.51');
    expect(deepseek41EngineVersion('/opt/strata/bin/strata')).toBeNull();
    expect(deepseek41SpeedSupported(config('0.1.50'))).toBe(true);
    expect(deepseek41SpeedSupported(config('0.1.49'))).toBe(false);
  });

  it('writes --experts 5/6 only when chosen and removes it for the default', () => {
    const fast = applyDeepseek41Speed(config(), '5');
    expect(fast.args).toEqual(['--pack', '/m/pack', '--max-context', '8192', '--experts', '5']);
    expect(deepseek41Speed(fast)).toBe('5');
    const full = applyDeepseek41Speed(fast, '6');
    expect((full.args as string[]).filter(arg => arg === '--experts')).toHaveLength(1);
    expect(deepseek41Speed(full)).toBe('6');
    expect(applyDeepseek41Speed(full, '').args).toEqual(['--pack', '/m/pack', '--max-context', '8192']);
    expect(() => applyDeepseek41Speed(config('0.1.49'), '5')).toThrow(/0\.1\.50/);
    expect(applyDeepseek41Speed(config('0.1.49'), '').args).toEqual(config().args);
  });

  it('maps the load mode to --mmap-experts auto|off|on', () => {
    const off = applyDeepseek41LoadMode(config(), 'off');
    expect(off.args).toEqual(['--pack', '/m/pack', '--max-context', '8192', '--mmap-experts', 'off']);
    expect(deepseek41LoadMode(off)).toBe('off');
    expect(deepseek41LoadMode(applyDeepseek41LoadMode(off, 'on'))).toBe('on');
    expect(applyDeepseek41LoadMode(off, '').args).toEqual(config().args);
    // strata-dsv41 (v0.2.6 ds4_main.cpp) always reads a value: a bare flag would swallow the next option, so it is not a
    // mode (shown as the default), the config is refused, and the next choice replaces it cleanly.
    const bare = config('0.1.50', ['--mmap-experts', '--pack', '/m/pack']);
    expect(deepseek41LoadMode(bare)).toBe('');
    expect(deepseek41ArgsError(bare)).toMatch(/on \/ off \/ auto/);
    expect(() => validateStartupConfiguration(bare)).toThrow(/--mmap-experts/);
    expect(applyDeepseek41LoadMode(bare, 'auto').args).toEqual(['--pack', '/m/pack', '--mmap-experts', 'auto']);
    // Another word (the engine reads it as auto) is not shown as a mode and is replaced with its value.
    const odd = config('0.1.50', ['--mmap-experts', 'yes', '--pack', '/m/pack']);
    expect(deepseek41LoadMode(odd)).toBe('');
    expect(applyDeepseek41LoadMode(odd, 'off').args).toEqual(['--pack', '/m/pack', '--mmap-experts', 'off']);
    expect(applyDeepseek41LoadMode(odd, '').args).toEqual(['--pack', '/m/pack']);
    expect(() => applyDeepseek41LoadMode(config(), 'yes' as never)).toThrow(/auto \/ off \/ on/);
    for (const mode of ['auto', 'off', 'on'] as const) {
      const next = applyDeepseek41LoadMode(applyDeepseek41LoadMode(config(), 'on'), mode);
      expect((next.args as string[]).filter(arg => arg === '--mmap-experts')).toHaveLength(1);
      expect(deepseek41ArgsError(next)).toBeNull();
      expect(() => validateStartupConfiguration(next)).not.toThrow();
    }
    expect(deepseek41ArgsError(config('0.1.50', ['--mmap-experts', 'on', '--mmap-experts', 'off']))).toMatch(/重复/);
    expect(deepseek41ArgsError(config('0.1.50', ['--experts']))).toMatch(/--experts/);
  });

  it('keeps the Qwen engine fields (the boolean --mmap-experts) away from DeepSeek configs', () => {
    const mmap = STARTUP_TUNING_FIELDS.find(field => field.key === '--mmap-experts' && field.target === 'arg')!;
    expect(mmap.kind).toBe('boolean');
    const deepseek = applyDeepseek41LoadMode(config(), 'off');
    // Not shown: no Qwen engine option applies; config-file fields (service, sampling) still do.
    expect(startupFieldApplies(deepseek, mmap)).toBe(false);
    expect(STARTUP_TUNING_FIELDS.filter(field => field.target === 'arg').every(field => !startupFieldApplies(deepseek, field))).toBe(true);
    expect(STARTUP_TUNING_FIELDS.filter(field => field.target === 'config').every(field => startupFieldApplies(deepseek, field))).toBe(true);
    // Not read as the Qwen switch ("true") and never written (no bare flag, no second --mmap-experts).
    expect(startupFieldValue(deepseek, mmap)).toBe('');
    expect(() => applyStartupField(deepseek, mmap, 'true')).toThrow(/DeepSeek/);
    expect(() => applyStartupField(deepseek, mmap, '')).toThrow(/DeepSeek/);
    // The argument list is split with strata-dsv41's table: "--mmap-experts off" is one option with its value.
    expect(startupEngineFlagsFor(deepseek)).toBe(DEEPSEEK41_ENGINE_FLAGS);
    const row = startupArgumentRows(deepseek).find(item => item.tokens[0] === '--mmap-experts')!;
    expect(row).toMatchObject({ tokens: ['--mmap-experts', 'off'], known: true, arity: 1 });
    expect(startupArgumentRows(config('0.1.50', ['--mmap-experts'])).at(-1)).toMatchObject({ tokens: ['--mmap-experts'], arity: 1 });
    expect(() => validateStartupConfiguration(config('0.1.50', ['--pack', '/m/pack', '--mmap-experts']))).toThrow(/缺少参数值/);
    // Qwen configs keep their switch.
    const qwen = { args: ['--mmap-experts', '--max-context', '8192'] };
    expect(startupEngineFlagsFor(qwen)).toBe(STARTUP_ENGINE_FLAGS);
    expect(startupFieldApplies(qwen, mmap)).toBe(true);
    expect(startupFieldValue(qwen, mmap)).toBe('true');
    expect(applyStartupField(qwen, mmap, 'false').args).toEqual(['--max-context', '8192']);
    expect(startupArgumentRows(qwen)[0]).toMatchObject({ tokens: ['--mmap-experts'], arity: 0 });
  });
});
