import { describe, expect, it } from 'vitest';
import { applyCalibrationSettings, applySpeedFixes, argValue, engineBackend, isPcieAuto, PCIE_AUTO, speedChanges, speedConfigName, speedHealthCheck, speedResult, suggestedReserveFromLogs, validateStartupConfiguration } from '../src';
import type { CalibrationJob } from '../src';

const GIB = 1024 ** 3;
const config = (args: string[]) => ({ exe: 'strata', args: ['--native', 'model.gguf', ...args] });
const byId = (checks: ReturnType<typeof speedHealthCheck>, id: string) => checks.find(check => check.id === id)!;

describe('one-click health check', () => {
  it('reads flags in both spellings', () => {
    expect(argValue(['--a', '1', '--b=2', '--c'], '--a')).toBe('1');
    expect(argValue(['--a', '1', '--b=2', '--c'], '--b')).toBe('2');
    expect(argValue(['--a', '1', '--b=2', '--c'], '--c')).toBe('');
    expect(argValue(['--a', '1'], '--z')).toBeUndefined();
  });

  it('flags low VRAM headroom with the Windows floor and fixes it with a reserve and an automatic expert cache', () => {
    const checks = speedHealthCheck({ config: config(['--expert-cache', '900']), engine: { vram_free_mib: 640, context: 32768 }, platform: 'windows' });
    const vram = byId(checks, 'vramHeadroom');
    expect(vram.status).toBe('fix');
    expect(vram.values.floor).toBe(1024);
    expect(vram.fix).toEqual({ '--vram-reserve-mib': '1280', '--expert-cache': 'auto' });
    // 640 MiB is fine off Windows (512 MiB floor)
    expect(byId(speedHealthCheck({ config: config([]), engine: { vram_free_mib: 640 }, platform: 'other' }), 'vramHeadroom').status).toBe('ok');
    // the memory goal keeps 2 GiB
    expect(byId(speedHealthCheck({ config: config([]), engine: { vram_free_mib: 1500 }, platform: 'other', goal: 'memory' }), 'vramHeadroom').status).toBe('fix');
  });

  it('uses the reserve the engine itself suggested and never lowers an existing one', () => {
    const logs = ['strata serve: 300 MiB of VRAM free with everything loaded', 'LOW: requests may stall; add --vram-reserve-mib 1792'];
    expect(suggestedReserveFromLogs(logs)).toBe(1792);
    expect(byId(speedHealthCheck({ config: config([]), engine: {}, platform: 'other', logs }), 'vramHeadroom').fix).toEqual({ '--vram-reserve-mib': '1792' });
    const kept = byId(speedHealthCheck({ config: config(['--vram-reserve-mib', '4096']), engine: { vram_free_mib: 300 }, platform: 'other' }), 'vramHeadroom');
    expect(kept.status).toBe('info');
    expect(kept.fix).toBeUndefined();
    expect(byId(speedHealthCheck({ config: config([]), engine: {}, platform: 'other' }), 'vramHeadroom').status).toBe('unknown');
  });

  it('suggests KV in RAM at 64K+ context only when RAM allows and never under WSL', () => {
    const engine = { vram_free_mib: 4000, context: 262144, kv_resident: 0 };
    const enough = byId(speedHealthCheck({ config: config(['--max-context', '262144']), engine, hardware: { availableMemoryBytes: 48 * GIB }, platform: 'windows' }), 'kvInRam');
    expect(enough.status).toBe('fix');
    expect(enough.fix).toEqual({ '--kv-resident': '32768' });
    expect(enough.values.ram).toBeCloseTo(3.0, 0);
    expect(byId(speedHealthCheck({ config: config(['--max-context', '262144']), engine, hardware: { availableMemoryBytes: 5 * GIB }, platform: 'windows' }), 'kvInRam').status).toBe('info');
    expect(byId(speedHealthCheck({ config: config(['--max-context', '262144']), engine, hardware: { availableMemoryBytes: 48 * GIB, wsl: true }, platform: 'other' }), 'kvInRam').reason).toBe('wsl');
    expect(byId(speedHealthCheck({ config: config(['--max-context', '262144']), engine, platform: 'other' }), 'kvInRam').status).toBe('unknown');
    expect(byId(speedHealthCheck({ config: config(['--max-context', '32768']), engine: { context: 32768 }, platform: 'other' }), 'kvInRam').reason).toBe('shortContext');
    expect(byId(speedHealthCheck({ config: config(['--max-context', '131072', '--kv-resident', '32768']), engine: {}, platform: 'other' }), 'kvInRam').reason).toBe('enabled');
  });

  it('notes a fixed PCIe share and writes fixes that pass startup validation', () => {
    const base = config(['--max-context', '131072', '--pcie-frac=0.35', '--expert-cache', '900']);
    expect(byId(speedHealthCheck({ config: base, engine: {}, platform: 'other' }), 'pcieFixed').values.value).toBe('0.35');
    const next = applySpeedFixes(base, [{ '--kv-resident': '32768' }, { '--vram-reserve-mib': '1280', '--expert-cache': 'auto' }]);
    expect(next.args).toEqual(['--native', 'model.gguf', '--max-context', '131072', '--pcie-frac=0.35', '--kv-resident', '32768', '--vram-reserve-mib', '1280', '--expert-cache', 'auto']);
    expect(base.args).toContain('900');
    expect(() => validateStartupConfiguration(next)).not.toThrow();
    expect(applySpeedFixes(config(['--pcie-frac', '0.5']), [{ '--pcie-frac': null }]).args).toEqual(['--native', 'model.gguf']);
  });
});

describe('one-click result', () => {
  const job = (over: Partial<CalibrationJob>): CalibrationJob => ({ id: 'j', profileId: 'a', kind: 'quickCalibrate', state: 'completed', startedAt: 0, updatedAt: 0, backend: 'cuda', layerSplit: false, rounds: 2, minGain: 0.03,
    baseline: { pcieFrac: 0.55, specMinP: 0.5 }, settings: {}, steps: [], completedRequests: 1, totalRequests: 1, restartSuggestions: [], identity: {}, configFingerprint: '', notes: [], ...over });

  it('lists only what changed, including going back to the engine share', () => {
    expect(speedChanges(job({ settings: { '--pcie-frac': null } }))).toEqual([{ kind: 'pcieAuto', flag: '--pcie-frac', from: '0.55', to: null }]);
    expect(speedChanges(job({ baseline: { pcieFrac: PCIE_AUTO, specMinP: 0.5 }, settings: { '--pcie-frac': '0.35', '--spec-min-p': '0.70' } })).map(change => change.kind)).toEqual(['pcieFixed', 'specMinP']);
    expect(speedChanges(job({ baseline: { pcieFrac: PCIE_AUTO, specMinP: 0.5 }, settings: { '--pcie-frac': '0.35' } }))[0]!.from).toBeNull();
    expect(isPcieAuto(PCIE_AUTO) && !isPcieAuto(0) && !isPcieAuto(0.35)).toBe(true);
  });

  it('shows the baseline even when nothing changes', () => {
    expect(speedResult(job({ baseRate: 36.2, baseRates: { short: 38, long: 34 } }))).toEqual({ before: 36.2, after: null, gain: null, short: { before: 38, after: null }, long: { before: 34, after: null }, changed: false });
    const changed = speedResult(job({ settings: { '--pcie-frac': '0.35' }, baseRate: 36.2, tunedRate: 39.3, gain: 0.0856, baseRates: { short: 38, long: 34 }, tunedRates: { short: 41, long: 37.5 } }))!;
    expect(changed.after).toBe(39.3);
    expect(changed.long).toEqual({ before: 34, after: 37.5 });
    expect(speedResult(job({ state: 'running' }))).toBeNull();
  });

  it('removing the PCIe flag through the apply path keeps the rest of the config', () => {
    const next = applyCalibrationSettings({ args: ['--native', 'm', '--pcie-frac', '0.35', '--spec-min-p', '0.5'] }, { '--pcie-frac': null }, 'cuda');
    expect(next.args).toEqual(['--native', 'm', '--spec-min-p', '0.5']);
  });

  it('names saved versions after the current file', () => {
    const at = new Date(2026, 9, 18, 9, 5);
    expect(speedConfigName('C:\\Strata\\config-speedfix-20261001-1200.json', at, 'boost')).toBe('config-speedup-20261018-0905.json');
    expect(speedConfigName('/x/config.json', at, 'fix')).toBe('config-speedfix-20261018-0905.json');
  });
});

describe('engine env switches in the health check', () => {
  const RTX3060 = { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3060', totalBytes: 12 * GIB };
  const RTX4090 = { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090', totalBytes: 24 * GIB };
  const doNotFit = ['strata: device buffers for a chunk of 512 tokens do not fit (2098 of 32656 MiB free)'];

  it('offers STRATA_ATTN_BATCH=32 only on SYCL 0.1.54 after a "do not fit" line, and a reset once it is set', () => {
    const sycl = { ...config([]), backend: 'sycl' };
    const fix = byId(speedHealthCheck({ config: sycl, platform: 'other', backend: 'sycl', engineVersion: '0.1.54', logs: doNotFit }), 'syclAttnBatch');
    expect(fix.status).toBe('fix');
    expect(fix.fix).toEqual({ 'env.STRATA_ATTN_BATCH': '32' });
    const written = applySpeedFixes(sycl, [fix.fix!]);
    expect(written.env).toEqual({ STRATA_ATTN_BATCH: '32' });
    const reset = byId(speedHealthCheck({ config: written, platform: 'other', backend: 'sycl', engineVersion: '0.1.54', logs: doNotFit }), 'syclAttnBatch');
    expect(reset).toMatchObject({ status: 'info', reason: 'set', action: 'reset', fix: { 'env.STRATA_ATTN_BATCH': null } });
    expect(applySpeedFixes(written, [reset.fix!]).env).toBeUndefined();
    // no line, another build, or another backend: no row
    expect(byId(speedHealthCheck({ config: sycl, platform: 'other', backend: 'sycl', engineVersion: '0.1.54', logs: [] }), 'syclAttnBatch')).toBeUndefined();
    expect(byId(speedHealthCheck({ config: sycl, platform: 'other', backend: 'sycl', engineVersion: '0.1.55', logs: doNotFit }), 'syclAttnBatch')).toBeUndefined();
    for (const backend of ['cuda', 'hip', 'unknown'] as const)
      expect(byId(speedHealthCheck({ config: { ...config([]), env: { STRATA_ATTN_BATCH: '32' } }, platform: 'other', backend, engineVersion: '0.1.54', logs: doNotFit }), 'syclAttnBatch')).toBeUndefined();
  });

  it('shows the route prior switch only for Qwen + CUDA + a discrete NVIDIA card of 13 GiB or less', () => {
    const off = byId(speedHealthCheck({ config: config([]), platform: 'windows', backend: 'cuda', hardware: { gpus: [RTX3060] } }), 'routePrior');
    expect(off).toMatchObject({ status: 'info', reason: 'off', action: 'toggle', on: false, fix: { 'env.STRATA_ROUTE_PRIOR': '1.5' } });
    const on = applySpeedFixes({ ...config([]), env: { STRATA_KVA: '1' } }, [off.fix!]);
    expect(on.env).toEqual({ STRATA_KVA: '1', STRATA_ROUTE_PRIOR: '1.5' });
    const back = byId(speedHealthCheck({ config: on, platform: 'windows', backend: 'cuda', hardware: { gpus: [RTX3060] } }), 'routePrior');
    expect(back).toMatchObject({ reason: 'on', on: true, fix: { 'env.STRATA_ROUTE_PRIOR': null } });
    expect(applySpeedFixes(on, [back.fix!]).env).toEqual({ STRATA_KVA: '1' });
    // 0.2.7's Off wrote 0: that reads as off and On replaces it
    expect(byId(speedHealthCheck({ config: { ...config([]), env: { STRATA_ROUTE_PRIOR: '0' } }, platform: 'other', backend: 'cuda', hardware: { gpus: [RTX3060] } }), 'routePrior').on).toBe(false);
    const none = (input: Partial<Parameters<typeof speedHealthCheck>[0]>) => byId(speedHealthCheck({ config: config([]), platform: 'other', backend: 'cuda', hardware: { gpus: [RTX3060] }, ...input }), 'routePrior');
    expect(none({ hardware: { gpus: [RTX4090] } })).toBeUndefined();
    expect(none({ hardware: { gpus: [{ vendor: 'nvidia', name: 'NVIDIA GB10', totalBytes: 12 * GIB }] } })).toBeUndefined();
    expect(none({ hardware: { gpus: [{ vendor: 'amd', name: 'AMD Radeon RX 9060 XT', totalBytes: 12 * GIB }] } })).toBeUndefined();
    expect(none({ backend: 'hip' })).toBeUndefined();
    expect(none({ backend: 'sycl' })).toBeUndefined();
    expect(none({ config: { ...config([]), arch: 'deepseek41' } })).toBeUndefined();
    expect(none({ hardware: null })).toBeUndefined();
  });

  it('reads the backend like the native calibration does', () => {
    expect(engineBackend({ backend: 'sycl' })).toBe('sycl');
    expect(engineBackend({}, { hardware_static: { gpus: [{ name: 'NVIDIA GeForce RTX 3060' }] } })).toBe('cuda');
    expect(engineBackend({}, { hardware_static: { gpus: [{ name: 'Intel Arc Pro B65' }] } })).toBe('sycl');
    expect(engineBackend({}, null)).toBe('unknown');
    // stopped model: the cards decide when they are all NVIDIA (an integrated chip beside them does not count)
    expect(engineBackend({}, null, [{ vendor: 'intel', name: 'Intel(R) UHD Graphics 770' }, { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3060' }])).toBe('cuda');
    expect(engineBackend({}, null, [{ vendor: 'amd', name: 'AMD Radeon RX 7900 XTX' }, { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3060' }])).toBe('unknown');
    expect(engineBackend({ backend: 'metal' }, null, [{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3060' }])).toBe('unknown');
  });

  it('refuses env names outside the engine switches', () => {
    expect(() => applySpeedFixes(config([]), [{ 'env.PATH': '/tmp' }])).toThrow();
  });
});
