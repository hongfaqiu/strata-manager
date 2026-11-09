import { describe, expect, it } from 'vitest';
import { applyDrafting, dflash2DownloadCopy, dflash2FetchProgress, draftingChoices, draftingConcurrencyNote, draftingConcurrencyPolicy, draftingFamilyOf, draftingModeOf, draftingRequestsOf, draftingSupport, effectiveDraftingOf, engineServesDflash2, normalizeDrafting, resolveDraftingBackend } from '../src/drafting';

describe('drafting (upstream v0.2.6 drafting.py / drafting.ts)', () => {
  it('serves DFlash2 from engine 0.1.56 and reads the concurrent request count (Strata v0.2.10)', () => {
    expect(engineServesDflash2('0.1.56')).toBe(true);
    expect(engineServesDflash2('0.1.57.1')).toBe(true);
    expect(engineServesDflash2('0.1.55')).toBe(false);
    expect(engineServesDflash2('0.1.47')).toBe(false);
    expect(engineServesDflash2(undefined)).toBeNull();
    expect(engineServesDflash2('nightly')).toBeNull();
    expect(draftingRequestsOf({ args: [] })).toBe(1);
    expect(draftingRequestsOf({ parallel: 4 })).toBe(4);
    expect(draftingRequestsOf({ parallel: '2' })).toBe(2);
    expect(draftingRequestsOf({ args: ['--parallel', '3'] })).toBe(3);
    expect(draftingRequestsOf({ args: ['--batch=2', '--slots', '1'] })).toBe(2);
    expect(draftingRequestsOf({ args: ['--parallel', 'x'] })).toBe(1);
    expect(normalizeDrafting('mtp+dflash2')).toBe('auto');
    expect(normalizeDrafting('both')).toBe('auto');
  });
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
  it('treats Unsloth quantizations of Qwen3.8-Flash-Next as a DFlash2 family (upstream SUPPORTED_FAMILIES)', () => {
    expect(draftingFamilyOf({ model_name: 'qwen3.8-flash-next-unsloth-ud-q4_k_xl' })).toBe('unsloth');
    expect(draftingFamilyOf({ model_name: 'Qwen3.8-Flash-Next-Unsloth-UD-Q2_K_XL' })).toBe('unsloth');
    expect(draftingFamilyOf({ model_name: 'qwen3.8-flash-next-coder-iq1_m' })).toBeNull();
    expect(draftingFamilyOf({ model_name: 'qwen3.8-flash-next-nvfp4-nvfp4' })).toBeNull();
    expect(draftingChoices('unsloth', true)).toEqual(['auto', 'mtp', 'dflash2', 'off']);
    expect(draftingChoices('unsloth', false)).toEqual(['auto', 'mtp', 'off']);
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
  it('reads the DFlash2 download progress and result from strata drafting fetch --output jsonl', () => {
    expect(dflash2FetchProgress([])).toEqual({});
    const lines = ['not json', '{"event":"progress","step":"download","done":100,"total":1200}', '{"event":"progress","step":"pack","done":3,"total":6}'];
    expect(dflash2FetchProgress(lines)).toEqual({ step: 'pack', done: 3, total: 6 });
    expect(dflash2FetchProgress([...lines, '{"schema_version":1,"ok":true,"event":"result","pack":"/d/dflash2/x.pack"}']).result).toEqual({ ok: true, pack: '/d/dflash2/x.pack' });
    expect(dflash2FetchProgress(['{"schema_version":1,"ok":false,"error":{"code":"drafting_failed","message":"disk full"}}']).result).toEqual({ ok: false, message: 'disk full' });
  });
  it('centralizes DFlash2 concurrency rules across engine 0.1.56 vs 0.1.57+, backends, Auto vs named, and --pipeline-windows (U2A)', () => {
    // 0.1.56: both Auto and named dflash2 fall back to MTP when requests >= 2
    const legacyAuto = draftingConcurrencyPolicy({ config: { parallel: 4 }, engineVersion: '0.1.56' });
    expect(legacyAuto).toMatchObject({ blockedToMtp: true, runsNamedBatchDflash2: false, reason: 'auto_multi_request' });
    expect(draftingConcurrencyNote(legacyAuto, true)).toContain('DFlash2 一次只服务一个请求');

    const legacyNamed = draftingConcurrencyPolicy({ config: { parallel: 2, drafting: 'dflash2' }, engineVersion: '0.1.56' });
    expect(legacyNamed).toMatchObject({ blockedToMtp: true, runsNamedBatchDflash2: false, reason: 'legacy_multi_request' });

    // 0.1.57+ on CUDA/HIP/SYCL: Auto with 2+ requests still chooses MTP; named dflash2 keeps concurrent slots
    for (const backend of ['cuda', 'hip', 'sycl'] as const) {
      const auto57 = draftingConcurrencyPolicy({ config: { parallel: 4, backend }, engineVersion: '0.1.57' });
      expect(auto57).toMatchObject({ blockedToMtp: true, runsNamedBatchDflash2: false, reason: 'auto_multi_request', namedBatchSupported: true });
      expect(draftingConcurrencyNote(auto57, true)).toContain('手动选择「DFlash2」');

      const named57 = draftingConcurrencyPolicy({ config: { parallel: 4, drafting: 'dflash2', backend }, engineVersion: '0.1.58' });
      expect(named57).toMatchObject({ blockedToMtp: false, runsNamedBatchDflash2: true, reason: 'named_batch_allowed', backend });
      expect(draftingConcurrencyNote(named57, false)).toContain('DFlash2 drafter per request slot');
    }

    // 0.1.57+ on Metal (macOS): named dflash2 with 2+ requests still falls back to MTP
    const metalNamed = draftingConcurrencyPolicy({ config: { parallel: 2, drafting: 'dflash2' }, engineVersion: '0.1.58', mac: true });
    expect(metalNamed).toMatchObject({ blockedToMtp: true, runsNamedBatchDflash2: false, reason: 'metal_multi_request', backend: 'metal' });

    // --pipeline-windows always blocks DFlash2 even at 1 request or on 0.1.58 CUDA named dflash2
    const piped = draftingConcurrencyPolicy({ config: { drafting: 'dflash2', backend: 'cuda', args: ['--pipeline-windows', '2'] }, engineVersion: '0.1.58' });
    expect(piped).toMatchObject({ blockedToMtp: true, runsNamedBatchDflash2: false, reason: 'pipeline_windows' });

    // Structured backend resolution: config.backend, variant, mac, detected gpus, and explicit exe filename tokens;
    // never guesses from broad path substrings like 'rx' and falls back conservatively to MTP when backend is unknown.
    expect(resolveDraftingBackend({ config: { exe: '/Users/rx/models/strata/strata.exe' } })).toBe('unknown');
    expect(resolveDraftingBackend({ config: { exe: 'C:\\Users\\rx_admin\\hippo\\strata.exe' } })).toBe('unknown');
    expect(resolveDraftingBackend({ config: { exe: 'C:\\Strata\\strata-hip.exe' } })).toBe('hip');
    expect(resolveDraftingBackend({ config: { exe: '/opt/strata/strata-cuda' } })).toBe('cuda');
    expect(resolveDraftingBackend({ gpus: ['AMD Radeon(TM) Graphics, 512 MiB', 'NVIDIA GeForce RTX 4090, 24564 MiB'] })).toBe('cuda');
    expect(resolveDraftingBackend({ gpus: [{ name: 'AMD Radeon RX 7900 XTX', vendor: 'amd' }] })).toBe('hip');
    expect(resolveDraftingBackend({ gpus: [{ name: 'Intel(R) Arc(TM) A770 Graphics', vendor: 'intel' }] })).toBe('sycl');
    expect(resolveDraftingBackend({ variant: 'rocm' })).toBe('hip');

    const unknownAuto58 = draftingConcurrencyPolicy({ config: { parallel: 4, exe: '/Users/rx/strata/engine.exe' }, engineVersion: '0.1.58' });
    expect(unknownAuto58).toMatchObject({ backend: 'unknown', namedBatchSupported: false, blockedToMtp: true, runsNamedBatchDflash2: false, reason: 'auto_multi_request' });
    expect(draftingConcurrencyNote(unknownAuto58, true)).toContain('DFlash2 一次只服务一个请求，将改用 MTP');

    const unknownNamed58 = draftingConcurrencyPolicy({ config: { parallel: 4, drafting: 'dflash2', exe: '/Users/rx/strata/engine.exe' }, engineVersion: '0.1.58' });
    expect(unknownNamed58).toMatchObject({ backend: 'unknown', namedBatchSupported: false, blockedToMtp: true, runsNamedBatchDflash2: false, reason: 'legacy_multi_request' });
    expect(draftingConcurrencyNote(unknownNamed58, false)).toContain('DFlash2 serves one request at a time, so MTP runs instead');
  });
  it('formats DFlash2 download and tuned update copy from drafting plan (U2A)', () => {
    const stockCopy = dflash2DownloadCopy({ ready: false, fetchable: true }, false);
    expect(stockCopy.downloadGb).toBe(1.2);
    expect(stockCopy.confirmSourceParagraph).toContain('incoai/Qwen3.8-Flash-Next-DFlash2');
    expect(stockCopy.buttonLabel).toBe('Download DFlash2');

    const tunedUpdateCopy = dflash2DownloadCopy({
      ready: true,
      fetchable: true,
      tunedUpdate: true,
      plan: {
        ready: false,
        needed: true,
        tuned: true,
        tunedUpdate: true,
        gb: 0.34,
        downloadGb: 0.34,
        diskGb: 0.34,
        vramGb: 0.72,
      },
    }, true);
    expect(tunedUpdateCopy.tunedUpdate).toBe(true);
    expect(tunedUpdateCopy.buttonLabel).toBe('更新微调版 DFlash2');
    expect(tunedUpdateCopy.statusHint).toContain('0.34 GB');
    expect(tunedUpdateCopy.confirmSourceParagraph).toContain('Strata 签名更新源');
    expect(tunedUpdateCopy.confirmSourceParagraph).toContain('0.34 GB');
  });
});
