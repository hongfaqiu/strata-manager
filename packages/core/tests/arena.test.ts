import { describe, expect, it } from 'vitest';
import { arenaApplyFilters, arenaExtensions, arenaFailure, ARENA_SORTS, arenaFacetOptions, arenaGpuVendor, arenaLaunchParams, arenaLeaderboardQuery, arenaModelOf, arenaName, assertArenaPayloadSafe, buildArenaPayload, arenaRecommendQuery } from '../src/arena';
import type { ArenaParams, ArenaRow } from '../src/arena';
import type { ContextBenchmarkReport } from '../src/context-benchmark-types';
import type { BenchmarkSuiteReport } from '../src/benchmark-suite-types';

const GB = 1024 ** 3;
const SECRETS = ['D:/AI/Strata', 'C:\\Users\\alice', 'DESKTOP-ALICE01', 'alice', '127.0.0.1:19001', 'sk-live-SECRET', 'Write a poem about my diary', 'The answer is 42', 'my-strata', 'swift-iq3_s.json', '4242', '1760668800123'];

function contextReport(over: Partial<ContextBenchmarkReport> = {}): ContextBenchmarkReport {
  const sample = (tier: number, decode: number, ttft: number) => ({ index: 0, round: 1, targetTokens: tier, targetPromptTokens: tier - 600, model: 'Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S at D:/AI/Strata/models',
    state: 'completed' as const, startedAt: 1760668800123, ttftMs: ttft, wallMs: ttft + 14000, inputChars: 30000, tokenCountMethod: 'count_tokens' as const, countedPromptTokens: tier - 600, estimatedPromptTokens: null,
    promptTokens: tier - 600, completionTokens: 512, cachedTokens: 0, prefillTokS: (tier - 600) / (ttft / 1000), decodeTokS: decode, peakGpuMemory: 21.4 * GB, minGpuMemoryFree: 2 * GB, peakRam: 61.5 * GB,
    resourceSamples: 20, output: 'The answer is 42', finishReason: 'length', error: 'C:\\Users\\alice failed' });
  return {
    schemaVersion: 3, id: 'r1', profileId: 'p1', profileName: 'my-strata', baseUrl: 'http://127.0.0.1:19001/v1', model: 'Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S',
    maxContext: 131072, startedAt: 1760668800123, finishedAt: 1760669172000, elapsedMs: 372000,
    options: { tiers: [8192, 32768], maxTokens: 512, timeoutMs: 600000, rounds: 1, stopOnError: true, configurationLabel: 'swift-iq3_s.json' },
    samples: [sample(8192, 36.4, 3150), sample(32768, 33.9, 14700)], skippedTiers: [], state: 'completed', stopReason: 'completed', resourceScope: 'system', resourceIntervalMs: 1000,
    hardware: { gpu_pcie_gen_max: 4, gpu_pcie_width: 16, hostname: 'DESKTOP-ALICE01', user: 'alice' }, engine: { version: '0.1.44', path: 'D:/AI/Strata/engine.exe' },
    identity: {
      schemaVersion: 1, capturedAt: 1760668800123, process: { pid: 4242, startedAt: 1760668000000, running: true },
      runtime: { strength: 'metadata', fingerprint: 'a'.repeat(64) },
      model: { strength: 'metadata', fingerprint: 'b'.repeat(64), files: [{ name: 'swift-iq3_s-00001-of-00002.gguf', size: 42 * GB, modifiedAt: '1760668800123' }, { name: 'swift-iq3_s-00002-of-00002.gguf', size: 41.6 * GB, modifiedAt: '1760668800123' }] },
      savedConfigurationHash: 'c'.repeat(64), effectiveStartupHash: null, effectiveVerified: true, engineProcess: { pid: 4242, startedAt: 1 },
      hardwareSignature: { cpuName: 'AMD Ryzen 9 7950X 16-Core Processor', totalMemoryBytes: 96 * GB, gpus: [{ id: 0, name: 'NVIDIA GeForce RTX 4090', totalBytes: 24 * GB }] },
      launch: { family: 'swift', quant: 'IQ3_S', ctx: 131072, kv: 'int8', gpuCount: 1, parallel: 1, poolWorkers: 16, expertCache: 'auto', pcieFrac: null, vision: false },
    },
    ...over,
  };
}
const env = { os: 'Windows 11 Pro 23H2', arch: 'x86_64', appVersion: '0.1.12' };

describe('arena payload whitelist', () => {
  it('builds the documented context payload and nothing else', async () => {
    const built = await buildArenaPayload(contextReport(), env);
    expect('payload' in built).toBe(true);
    if (!('payload' in built)) return;
    const p = built.payload;
    expect(p).toMatchObject({ schema: 1, app: '0.1.12', strata: '0.1.44', kind: 'context', day: '2025-10-17',
      hw: { os: 'windows', arch: 'x86_64', cpu: 'AMD Ryzen 9 7950X 16-Core Processor', ramGB: 96, gpus: [{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090', vramGB: 24 }], pcie: 'Gen4 x16', wsl: false },
      model: { family: 'swift', quant: 'IQ3_S', sizeGB: 83.6 }, params: { ctx: 131072, kv: 'int8', poolWorkers: 16 } });
    expect(p.tiers).toEqual([
      { ctx: 8192, prefill: 2410.2, decode: 36.4, ttftMs: 3150, peakVramGB: 21.4, peakRamGB: 61.5, ok: true },
      { ctx: 32768, prefill: 2188.3, decode: 33.9, ttftMs: 14700, peakVramGB: 21.4, peakRamGB: 61.5, ok: true }]);
    expect(p.model.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => assertArenaPayloadSafe(p)).not.toThrow();
    const text = JSON.stringify(p);
    for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
    const strings: string[] = []; const walk = (v: unknown): void => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); }; walk(p);
    for (const value of strings) expect(value).not.toMatch(/[/\\@:]/);
  });

  it('adds whitelisted run evidence: offsets, timings, token counts, resource series and engine counters only', async () => {
    const series = { count: 41, stepMs: 9000, vramGB: [18.2, 21.4, 21.1], ramGB: [60.1, 61.5, 61.2], gpuUtil: [12, 88, 85] };
    const report = contextReport({ evidence: { counters: { before: { requests: 37, promptTokens: 910000, outputTokens: 15000 }, after: { requests: 39, promptTokens: 950368, outputTokens: 16024 } }, series } });
    report.samples[1]!.startedAt = report.startedAt + 17_500;
    report.samples.push({ ...report.samples[0]!, targetTokens: 65536, state: 'failed', decodeTokS: null });
    const built = await buildArenaPayload(report, env);
    if (!('payload' in built)) throw new Error('expected payload');
    const e = built.payload.evidence!;
    expect(e).toEqual({ v: 1, engine: '0.1.44', durationMs: 372000, intervalMs: 1000, series, counters: report.evidence!.counters,
      runs: [{ ctx: 8192, startMs: 0, endMs: 17150, ttftMs: 3150, promptTokens: 7592, cachedTokens: 0, completionTokens: 512, prefill: 2410.2, decode: 36.4, resourceSamples: 20 },
        { ctx: 32768, startMs: 17500, endMs: 46200, ttftMs: 14700, promptTokens: 32168, cachedTokens: 0, completionTokens: 512, prefill: 2188.3, decode: 33.9, resourceSamples: 20 }] });
    expect(() => assertArenaPayloadSafe(built.payload)).not.toThrow();
    const text = JSON.stringify(built.payload);
    for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
    const leaked = structuredClone(built.payload); (leaked.evidence!.runs[0] as unknown as Record<string, unknown>).output = 'hi';
    expect(() => assertArenaPayloadSafe(leaked)).toThrow(/whitelisted/);
    const texty = structuredClone(built.payload); (texty.evidence!.series.vramGB as unknown[])[0] = 'D 1';
    expect(() => assertArenaPayloadSafe(texty)).toThrow(/not a number/);
    const noEvidence = await buildArenaPayload(contextReport(), env);
    expect('payload' in noEvidence && noEvidence.payload.evidence).toBeUndefined();
  });

  it('fingerprint ignores modification times and paths', async () => {
    const a = await buildArenaPayload(contextReport(), env);
    const r = contextReport(); r.identity!.model.files = r.identity!.model.files!.map(f => ({ ...f, name: 'E:/other/' + f.name, modifiedAt: '1' }));
    const b = await buildArenaPayload(r, env);
    expect('payload' in a && 'payload' in b && a.payload.model.sha256 === b.payload.model.sha256).toBe(true);
  });

  it('builds a scenario summary without prompts or outputs', async () => {
    const report = { schemaVersion: 3, id: 's', profileId: 'p', profileName: 'my-strata', baseUrl: 'http://127.0.0.1:19001/v1', model: 'm', startedAt: 1, finishedAt: 1760669172000, elapsedMs: 1, measurementElapsedMs: 1,
      options: { prompt: 'Write a poem about my diary' }, samples: [
        { warmup: true, state: 'completed', decodeTokS: 99, prefillTokS: 1, ttftMs: 1, output: 'The answer is 42' },
        { warmup: false, state: 'completed', decodeTokS: 30, prefillTokS: 2000, ttftMs: 900, output: 'The answer is 42' },
        { warmup: false, state: 'failed', decodeTokS: null, prefillTokS: null, ttftMs: null, output: '', error: 'C:\\Users\\alice' }],
      stages: [{ index: 0, concurrency: 1 }, { index: 1, concurrency: 4 }], telemetry: [], state: 'completed', stopReason: 'completed', identity: contextReport().identity } as unknown as BenchmarkSuiteReport;
    const built = await buildArenaPayload(report, env);
    if (!('payload' in built)) throw new Error('expected payload');
    expect(built.payload.scenario).toEqual({ decode: 30, prefill: 2000, ttftMs: 900, maxConcurrency: 4, requests: 2, failed: 1 });
    expect(built.payload.tiers).toBeUndefined();
    const text = JSON.stringify(built.payload);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });

  it('adds enum-only extensions: track, drafting / MTP, GPU roles and expert placement', async () => {
    const built = await buildArenaPayload(contextReport(), env);
    if (!('payload' in built)) throw new Error('expected payload');
    // No setup recipe on this identity, so it is a custom run even with automatic drafting.
    expect(built.payload.extensions).toEqual({ track: 'custom', drafting: null, mtp: null, gpuRoles: null, experts: null });
    const r = contextReport();
    r.identity = { ...r.identity!, resourceRequest: {} as never, drafting: { requested: 'auto', mtpSwitch: null, effective: 'mtp' } };
    const def = await buildArenaPayload(r, env);
    if (!('payload' in def)) throw new Error('expected payload');
    expect(def.payload.extensions).toEqual({ track: 'default', drafting: 'mtp', mtp: true, gpuRoles: null, experts: null });
    expect(() => assertArenaPayloadSafe(def.payload)).not.toThrow();
    expect(arenaExtensions({ ...r.identity, drafting: { requested: 'off', mtpSwitch: false, effective: 'off' }, gpuRoles: ['main', 'helper', 'off'] }, { ...r.identity.launch!, experts: 'resident' }))
      .toEqual({ track: 'custom', drafting: 'off', mtp: false, gpuRoles: ['main', 'helper', 'off'], experts: 'resident' });
    expect(arenaExtensions({ ...r.identity, gpuRoles: ['main', 'C:/x' as never] }, null).gpuRoles).toBeNull();
    expect(arenaLaunchParams({ args: ['--max-context', '8192', '--native', 'swift-IQ3_S.gguf', '--mmap-experts'] })?.experts).toBe('mmap');
    expect(arenaLaunchParams({ args: ['--max-context', '8192', '--native', 'swift-IQ3_S.gguf', '--expert-cache', '12'] })?.experts).toBe('cache');
    const p = def.payload;
    expect(() => assertArenaPayloadSafe({ ...p, extensions: { ...p.extensions!, profile: 'x' } })).toThrow(/not whitelisted/);
    expect(() => assertArenaPayloadSafe({ ...p, extensions: { ...p.extensions!, track: 'mine' as never } })).toThrow(/extensions.track/);
    expect(() => assertArenaPayloadSafe({ ...p, extensions: { ...p.extensions!, gpuRoles: ['boss' as never] } })).toThrow(/extensions.gpuRoles/);
    expect(() => assertArenaPayloadSafe({ ...p, extensions: { ...p.extensions!, mtp: 'yes' as never } })).toThrow(/extensions.mtp/);
  });

  it('skips instead of guessing', async () => {
    expect(await buildArenaPayload(contextReport({ state: 'cancelled' }), env)).toEqual({ skip: 'not_completed' });
    expect(await buildArenaPayload(contextReport({ identity: undefined }), env)).toEqual({ skip: 'no_identity' });
    const r = contextReport(); r.identity!.launch = null;
    expect(await buildArenaPayload(r, env)).toEqual({ skip: 'unknown_model' });
    expect(await buildArenaPayload(contextReport(), { ...env, os: 'FreeBSD' })).toEqual({ skip: 'unsupported_platform' });
  });

  it('rejects non-whitelisted keys and unsafe strings right before upload', async () => {
    const built = await buildArenaPayload(contextReport(), env);
    if (!('payload' in built)) throw new Error('expected payload');
    expect(() => assertArenaPayloadSafe({ ...built.payload, baseUrl: 'x' })).toThrow(/not whitelisted/);
    expect(() => assertArenaPayloadSafe({ ...built.payload, hw: { ...built.payload.hw, cpu: 'C:\\Users\\alice' } })).toThrow(/unsafe/);
    expect(() => assertArenaPayloadSafe({ ...built.payload, params: { ...built.payload.params, apiKey: 'sk' } })).toThrow(/not whitelisted/);
  });
});

describe('arena helpers', () => {
  it('sanitizes hardware names', () => {
    expect(arenaName('Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz')).toBe('Intel Xeon CPU E5-2680 v4 2.40GHz');
    expect(arenaName('C:\\Users\\alice\\gpu')).toBe('C Users alice gpu');
    expect(arenaGpuVendor('AMD Radeon RX 7900 XTX')).toBe('amd');
    expect(arenaGpuVendor('NVIDIA GeForce RTX 4080 SUPER')).toBe('nvidia');
  });
  it('reads model + quant from file names and launch flags from the sanitized recipe', () => {
    expect(arenaModelOf('Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S.gguf')).toEqual({ family: 'swift', quant: 'IQ3_S' });
    expect(arenaModelOf('Qwen3.8-Flash-Next-UD-IQ4_XS.gguf')).toEqual({ family: 'unsloth', quant: 'UD-IQ4_XS' });
    expect(arenaModelOf('Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf')).toEqual({ family: 'qwen36', quant: 'UD-Q4_K_XL' });
    expect(arenaModelOf('Qwen3.8-Flash-Next-UD-Q5_K_XL-00001-of-00006.gguf')).toEqual({ family: 'unsloth', quant: 'UD-Q5_K_XL' });
    expect(arenaModelOf('Qwen3.8-Flash-Next-Q8_0-00001-of-00006.gguf')).toEqual({ family: 'unsloth', quant: 'Q8_0' });
    expect(arenaModelOf('my-model.gguf')).toBeNull();
    expect(arenaModelOf('a-IQ3_S b-IQ2_XS')).toBeNull();
    expect(arenaLaunchParams({ args: ['--max-context', '65536', '--native', 'qwen3.8-flash-next-q2_0.gguf', '--kv', 'q4_0', '--pool-workers', '24', '--pcie-frac', '0.25'], parallel: 2, gpu: [0, 1], vision: true }))
      .toEqual({ family: 'qwen', quant: 'Q2_0', ctx: 65536, kv: 'q4_0', gpuCount: 2, parallel: 2, poolWorkers: 24, expertCache: 'auto', pcieFrac: 0.25, vision: true, experts: null });
    expect(arenaLaunchParams({ args: ['--native', 'swift-IQ3_S.gguf'] })).toBeNull();
  });
  it('builds a recommend query', () => {
    expect(arenaRecommendQuery({ gpu: 'NVIDIA GeForce RTX 4090', vramGB: 24, ramGB: 96 }, contextReport().identity!.launch, 'long'))
      .toEqual({ scene: 'long', gpu: 'NVIDIA GeForce RTX 4090', vram: '24', ram: '96', family: 'swift', quant: 'IQ3_S', ctx: '131072', kv: 'int8', parallel: '1', poolWorkers: '16', expertCache: 'auto', gpuCount: '1' });
  });
});

describe('leaderboard filters and sorting', () => {
  const row = (gpu: string, vramGB: number, decode: number, decode128k: number | null, params: Partial<ArenaParams> = {}, machines = 3): ArenaRow => ({
    hw: { gpu, vramGB, ramGB: 64 }, params: { ctx: 131072, kv: 'int8', gpuCount: 1, parallel: 1, poolWorkers: null, expertCache: null, pcieFrac: null, vision: false, ...params },
    seed: false, machines, confidence: 'low', decode: { p25: null, median: decode, p75: null }, prefill: decode * 50, ttftMs: null, decode32k: null, decode128k, peakRamGB: null, peakVramGB: null });
  const rows = [row('NVIDIA GeForce RTX 4090', 24, 40, null), row('NVIDIA GeForce RTX 4080', 16, 30, 25, { kv: 'q4_0' }, 9), row('NVIDIA GeForce RTX 3090', 24, 28, 22, { parallel: 2 })];

  it('lists only existing facet values, ascending, with a missing expert cache as auto', () => {
    const options = arenaFacetOptions(rows);
    expect(options.vram).toEqual([16, 24]); expect(options.kv).toEqual(['int8', 'q4_0']); expect(options.parallel).toEqual([1, 2]); expect(options.expertCache).toEqual(['auto']);
  });
  it('filters by facet, GPU and keyword and re-ranks inside the result', () => {
    expect(arenaApplyFilters(rows, { vram: '24' }).rows.map(r => r.rank)).toEqual([1, 2]);
    expect(arenaApplyFilters(rows, { kv: 'q4_0' }).rows.map(r => r.hw.gpu)).toEqual(['NVIDIA GeForce RTX 4080']);
    expect(arenaApplyFilters(rows, { q: '3090' }).rows).toHaveLength(1);
    expect(arenaApplyFilters(rows, { gpu: 'NVIDIA GeForce RTX 4090', parallel: '' }).rows).toHaveLength(1);
    expect(arenaApplyFilters(rows, { vram: '24' }).tierMedian).toBe(34);
  });
  it('sorts by the chosen metric with missing values last and unranked', () => {
    expect(arenaApplyFilters(rows, {}, 'decode128k').rows.map(r => [r.hw.vramGB, r.rank])).toEqual([[16, 1], [24, 2], [24, null]]);
    expect(arenaApplyFilters(rows, {}, 'machines').rows[0]!.machines).toBe(9);
    expect(arenaApplyFilters(rows, {}).rows.map(r => r.decode.median)).toEqual([40, 30, 28]);
  });
  it('builds the leaderboard query without empty values or the default sort', () => {
    expect(arenaLeaderboardQuery('swift:IQ3_S', { vram: '24', kv: '' })).toEqual({ group: 'swift:IQ3_S', vram: '24' });
    expect(arenaLeaderboardQuery('swift:IQ3_S', {}, 'prefill')).toEqual({ group: 'swift:IQ3_S', sort: 'prefill' });
  });
});

describe('arena_get failures', () => {
  it('treats only unreachable or temporarily failing servers as network trouble', () => {
    expect(arenaFailure('network: error sending request')).toEqual({ kind: 'network', code: 'network: error sending request' });
    for (const status of [500, 502, 503, 429, 408]) expect(arenaFailure(`arena_http_${status}`).kind).toBe('network');
    expect(arenaFailure(new Error('network: operation timed out')).kind).toBe('network');
  });
  it('keeps app-side failures distinct and preserves the code for the user', () => {
    for (const code of ['arena_query_invalid: sort', 'arena_path_invalid', 'arena_http_400', 'arena_http_404', 'arena_response_invalid: expected value at line 1 column 1', 'arena_response_too_large'])
      expect(arenaFailure(code)).toEqual({ kind: 'app', code });
    expect(arenaFailure({ code: 'X', message: 'arena_query_invalid: q' })).toEqual({ kind: 'app', code: 'arena_query_invalid: q' });
  });
});

describe('leaderboard query keys reach the native allow-list', () => {
  it('every key arenaLeaderboardQuery can produce is in arena.rs QUERY_KEYS', async () => {
    const { readFileSync } = await import('node:fs');
    const rust = readFileSync(new URL('../../../apps/desktop/src-tauri/src/arena.rs', import.meta.url), 'utf8');
    const allowed = new Set([...(/const QUERY_KEYS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map(m => m[1]));
    const all = { gpu: 'NVIDIA GeForce RTX 4080 SUPER', q: '4080', vram: '16', ram: '64', ctx: '524288', kv: 'int8', parallel: '1', gpuCount: '1', expertCache: 'auto' };
    for (const sort of ARENA_SORTS) for (const key of Object.keys(arenaLeaderboardQuery('qwen:IQ3_S', all, sort))) expect(allowed, `${key} (sort=${sort})`).toContain(key);
  });
});
