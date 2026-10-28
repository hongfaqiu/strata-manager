import { afterEach, describe, expect, it, vi } from 'vitest';
import { arenaOfficialModelKey, assertArenaPayloadSafe } from '../src/arena';
import { DEFAULT_OFFICIAL_BENCH_OPTIONS, runOfficialBench } from '../src/official-bench';
import { OFFICIAL_EVIDENCE_SLOTS, buildOfficialArenaPayload, officialArenaBlock, officialArenaEvidence } from '../src/official-arena';
import type { ServiceProfile } from '../src/types';

const GB = 1024 ** 3;
const profile: ServiceProfile = { id: 'official', name: 'my-strata', baseUrl: 'http://127.0.0.1:19001', installDir: 'D:/AI/Strata', configPath: '', pythonPath: '', managed: false };
const env = { os: 'Windows 11 Pro 23H2', arch: 'x86_64', appVersion: '0.1.12' };
afterEach(() => { vi.unstubAllGlobals(); });

/** A mocked engine with request counters, so the run captures before/after totals. */
function server() {
  let requests = 100, prompt = 1_000_000;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input, 'http://preview').searchParams.get('path');
    if (path === '/health') return new Response(JSON.stringify({ service: 'strata', status: 'ok', loaded: true, model: 'Qwen3.8-Flash-Next-IQ3_S', max_context: 131072 }));
    if (path === '/metrics') return new Response(JSON.stringify({ live: { running: 0, queued: 0 }, totals: { requests, prompt_tokens: prompt, output_tokens: 5000 }, hardware_static: { gpu_name: 'AMD Radeon(TM) 8060S Graphics' } }));
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[]; max_tokens: number };
    const chars = body.messages.reduce((a, m) => a + m.content.length, 0), tokens = Math.round(chars / 5) + 20;
    requests++; prompt += tokens;
    const chunks = [
      { choices: [{ delta: { content: 'The answer is 42' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: tokens, completion_tokens: body.max_tokens, prompt_tokens_details: { cached_tokens: 0 } },
        timings: { prompt_per_second: 800, predicted_per_second: 44, prompt_n: tokens } },
    ];
    return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }));
}
const identity = {
  schemaVersion: 1, capturedAt: 1, process: { pid: 4242, startedAt: 1, running: true }, runtime: { strength: 'metadata', fingerprint: 'a'.repeat(64) },
  model: { strength: 'metadata', fingerprint: 'b'.repeat(64), files: [{ name: 'swift-iq3_s.gguf', size: 42 * GB, modifiedAt: '1' }] },
  savedConfigurationHash: null, effectiveStartupHash: null, effectiveVerified: true,
  hardwareSignature: { cpuName: 'AMD RYZEN AI MAX+ 395 w/ Radeon 8060S', totalMemoryBytes: 128 * GB, gpus: [{ id: 0, name: 'AMD Radeon(TM) 8060S Graphics', totalBytes: 96 * GB }] },
  officialLaunch: { family: 'qwen', quant: 'IQ3_S', ctx: 131072, kv: 'int8', gpuCount: 1, parallel: 1, poolWorkers: 16, expertCache: 'auto', pcieFrac: null, vision: false },
} as never;

describe('official-method Arena upload', () => {
  it('uploads the medians the run shows plus request-level evidence, and nothing private', async () => {
    server();
    const report = { ...await runOfficialBench(profile, { ...DEFAULT_OFFICIAL_BENCH_OPTIONS, runs: 1 }), identity, engineVersion: '0.2.7' };
    expect(report.evidence?.counters?.before.requests).toBe(100);
    expect(report.evidence?.counters?.after.requests).toBeGreaterThan(100);
    const built = await buildOfficialArenaPayload(report, env);
    if (!('payload' in built)) throw new Error(JSON.stringify(built));
    const p = built.payload;
    expect(p).toMatchObject({ kind: 'official', strata: '0.2.7', model: { family: 'qwen', quant: 'IQ3_S' }, official: { runs: 1, long: true } });
    expect(p.official!.upstream).toMatch(/^[a-f0-9]{12}$/);
    expect(p.official!.metrics.chatDecodeTps).toBe(44);
    expect(p).not.toHaveProperty('tiers');
    expect(() => assertArenaPayloadSafe(p)).not.toThrow();
    const text = JSON.stringify(p);
    for (const secret of ['D:/AI/Strata', '127.0.0.1', 'my-strata', 'The answer is 42', 'Write a Python']) expect(text).not.toContain(secret);
    // One evidence run per measured request: 3 chat, 4K/16K/32K, 5 agent follow-ups; the script samples no resources.
    const ev = p.evidence!;
    const slots = ev.runs.map(r => r.ctx);
    expect(slots.filter(s => s === OFFICIAL_EVIDENCE_SLOTS.chat)).toHaveLength(3);
    expect(slots.filter(s => s === OFFICIAL_EVIDENCE_SLOTS.agent)).toHaveLength(5);
    expect(slots).toEqual(expect.arrayContaining([4096, 16384, 32768]));
    expect(ev.series.count).toBe(0);
    expect(ev.runs.every(r => r.resourceSamples === 0 && r.endMs >= r.startMs)).toBe(true);
    expect(ev.counters).not.toBeNull();
  });
  it('skips incomplete runs and leaves out evidence it cannot back', async () => {
    server();
    const report = { ...await runOfficialBench(profile, { ...DEFAULT_OFFICIAL_BENCH_OPTIONS, runs: 1 }), identity };
    expect(await buildOfficialArenaPayload({ ...report, state: 'cancelled' }, env)).toEqual({ skip: 'not_completed' });
    expect(await buildOfficialArenaPayload({ ...report, identity: undefined }, env)).toEqual({ skip: 'no_identity' });
    expect(await buildOfficialArenaPayload({ ...report, results: { ...report.results, chat: null } }, env)).toEqual({ skip: 'no_results' });
    expect(officialArenaEvidence({ ...report, evidence: undefined }, null)).toBeNull();
    expect(officialArenaBlock({ ...report, results: { ...report.results, prompts: {} } }).metrics.p4kTps).toBeNull();
  });
  it('keys official setups the way the published numbers are keyed', () => {
    expect(arenaOfficialModelKey('Qwen3.8-FP4-Local')).toEqual({ family: 'qwen', quant: 'NVFP4-QAD' });
    expect(arenaOfficialModelKey('DeepSeek-V4.1 IST-DAS 2.00 bpw')).toEqual({ family: 'deepseek41', quant: 'IST-DAS-2.00bpw' });
    expect(arenaOfficialModelKey('deepseek pack')).toEqual({ family: 'deepseek41', quant: null });
    expect(arenaOfficialModelKey('')).toBeNull();
  });
});
