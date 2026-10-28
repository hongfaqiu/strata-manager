import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OFFICIAL_BENCH_OPTIONS, OFFICIAL_BENCH_PROMPTS, PythonRandom, officialAgentSummary, officialCalibration, officialChatBody, officialDigest,
  officialLongPrompt, officialPromptFits, officialPromptWords, officialStat, officialTag, planOfficialBench, runOfficialBench, type OfficialAgentTurn,
} from '../src/official-bench';
import { OFFICIAL_REFERENCES, matchOfficialReference, officialComparisonRows, officialModelKey, officialPoint } from '../src/official-bench-reference';
import type { ServiceProfile } from '../src/types';

const fixtures = new URL('./fixtures/', import.meta.url);
const longPrompt = JSON.parse(readFileSync(new URL('official-bench-long-prompt.json', fixtures), 'utf8')) as Record<string, { sha256: string; head: string; len: number }>;
const py = JSON.parse(readFileSync(new URL('official-bench-python.json', fixtures), 'utf8'));
const camel = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v]));

describe('prompts match tools/ab_engine.py', () => {
  it('reproduces CPython random.Random(7) choices', () => {
    // python3 -c "import random; r=random.Random(7); print([r.getrandbits(32) for _ in range(3)])"
    const r = new PythonRandom(7);
    expect([r.next32(), r.next32(), r.next32()]).toEqual([1390851128, 4071050724, 647892279]);
  });
  it.each(Object.keys(longPrompt))('long_prompt(%s) is byte-identical (sha256)', words => {
    const text = officialLongPrompt(Number(words));
    expect(text.length).toBe(longPrompt[words]!.len);
    expect(text.startsWith(longPrompt[words]!.head)).toBe(true);
    expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(longPrompt[words]!.sha256);
  });
  it('keeps the three chat questions and the request body of chat()', () => {
    expect(OFFICIAL_BENCH_PROMPTS).toHaveLength(3);
    expect(OFFICIAL_BENCH_PROMPTS[0]).toBe('Write a Python function that merges two sorted lists into one sorted list, with a docstring and two tests.');
    expect(officialChatBody([{ role: 'user', content: 'x' }], 100)).toEqual({ model: 'strata', stream: true, max_tokens: 100, temperature: 0,
      messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } });
    expect(officialTag('1761400000', 0, 4096, 'p')).toBe('0-4096-p-1761400000');
  });
  it('sizes prompts as Suite.calibrate / prompt_for do', () => {
    for (const c of py.calibration) {
      const cal = officialCalibration(c.in[0], c.in[1]);
      expect(cal.tokensPerWord).toBeCloseTo(c.tpw, 12);
      expect(cal.overhead).toBeCloseTo(c.overhead, 9);
      for (const [tokens, words] of Object.entries(c.words)) expect(officialPromptWords(Number(tokens), cal)).toBe(words);
    }
    expect(officialPromptWords(10, { tokensPerWord: 1.1, overhead: 40 })).toBe(50);
  });
  it('skips tiers like run_prompt / run_agent', () => {
    expect(officialPromptFits(16384, 16384)).toBe(false);
    expect(officialPromptFits(4096, 8192)).toBe(true);
    expect(officialPromptFits(32768, null)).toBe(true);
    const plan = planOfficialBench(DEFAULT_OFFICIAL_BENCH_OPTIONS, 8192);
    expect(plan.phases).toEqual(['warmup', 'chat', '4K']);
    expect(plan.skipped.map(t => t.label)).toEqual(['16K', '32K']);
    expect(plan.total).toBe(4 + 9 + 3);
    expect(planOfficialBench(DEFAULT_OFFICIAL_BENCH_OPTIONS, 131072).phases).toEqual(['warmup', 'chat', '4K', '16K', 'agent', '32K']);
  });
});

describe('timing and metrics match digest() / stat() / run_agent()', () => {
  it('digests each request as the script does', () => {
    py.raws.forEach((raw: never, i: number) => expect(officialDigest(raw)).toMatchObject(camel(py.digests[i])));
  });
  it('uses statistics.median, min, max and n with 3 decimals', () => {
    expect([officialStat([3, 1, 2]), officialStat([4, 1, 3, 2]), officialStat([1.23456, null, 2]), officialStat([])]).toEqual(py.stats);
  });
  it('summarises agent sessions identically', () => {
    const sessions: OfficialAgentTurn[][] = py.sessions.map((s: Record<string, unknown>[]) => s.map(d => ({ ...camel(d) }) as unknown as OfficialAgentTurn));
    const { sessions: _, ...summary } = officialAgentSummary(sessions);
    expect(summary).toEqual(camel(py.agent));
  });
});

describe('official reference matching', () => {
  const strix = { gpuNames: ['AMD Radeon(TM) 8060S Graphics'], vramGB: 64, cpuName: 'AMD RYZEN AI MAX+ 395 w/ Radeon 8060S', modelEvidence: [] as string[] };
  it('matches hardware + model + quant only', () => {
    expect(matchOfficialReference({ ...strix, modelEvidence: ['Qwen3.8-Flash-Next-IQ3_S-00001-of-00002.gguf', 'qwen', 'IQ3_S'] }).reference?.id).toBe('strix-halo-windows-qwen-iq3s-0.2.7');
    expect(matchOfficialReference({ ...strix, modelEvidence: ['deepseek-v4.1-flash', 'IST-DAS-2.00bpw'] }).reference?.id).toBe('strix-halo-windows-deepseek-2.00-0.2.7');
    expect(matchOfficialReference({ gpuNames: ['NVIDIA RTX PRO 5000 Blackwell'], vramGB: 72, cpuName: null, modelEvidence: ['Qwen3.8-Flash-Next-FP4-Local'] }).reference?.id).toBe('rtx-pro-5000-nvfp4-qad');
  });
  it('reports no match for other quants, models or hardware', () => {
    const other = matchOfficialReference({ ...strix, modelEvidence: ['deepseek41', 'IST-DAS-1.75bpw'] });
    expect(other).toMatchObject({ reference: null, hardwareKnown: true, model: { family: 'deepseek41', quant: 'IST-DAS-1.75bpw' } });
    expect(matchOfficialReference({ ...strix, modelEvidence: ['Qwen3.8-Swift-IQ3_S.gguf'] }).reference).toBeNull();
    expect(matchOfficialReference({ ...strix, modelEvidence: ['Qwen3.8-Flash-Next-UD-IQ3_XXS.gguf'] }).reference).toBeNull();
    expect(matchOfficialReference({ gpuNames: ['NVIDIA GeForce RTX 4090'], vramGB: 24, cpuName: 'AMD Ryzen 9 7950X', modelEvidence: ['qwen3.8-iq3_s'] }))
      .toMatchObject({ reference: null, hardwareKnown: false });
    expect(officialModelKey(['deepseek'])).toEqual({ family: 'deepseek41', quant: null });
  });
  it('every reference carries a pinned source link and only published values', () => {
    for (const ref of OFFICIAL_REFERENCES) {
      expect(ref.source.url).toMatch(/^https:\/\/github\.com\/Niko1221\/Strata\/blob\/46c152a1310f77cd2f0ce2c7cd213962df14fe83\/docs\//);
      for (const v of Object.values(ref.metrics)) {
        if (v.printed !== undefined) expect(Number(v.printed)).toBe(v.median);
        expect(typeof v.median === 'number' || (typeof v.min === 'number' && typeof v.max === 'number')).toBe(true);
      }
    }
    expect(officialPoint({ min: 12.1, max: 13.6 })).toEqual({ value: 12.85, isRange: true });
  });
});

const profile: ServiceProfile = { id: 'official', name: 'Official', baseUrl: 'http://127.0.0.1:8080', installDir: '', configPath: '', pythonPath: '', managed: false };
afterEach(() => { vi.unstubAllGlobals(); });

function server(maxContext: number) {
  const bodies: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input, 'http://preview').searchParams.get('path');
    if (path === '/health') return new Response(JSON.stringify({ service: 'strata', status: 'ok', loaded: true, model: 'Qwen3.8-Flash-Next-IQ3_S', max_context: maxContext }));
    if (path === '/metrics') return new Response(JSON.stringify({ live: { running: 0, queued: 0 }, hardware_static: { gpu_name: 'AMD Radeon(TM) 8060S Graphics' } }));
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[]; max_tokens: number };
    bodies.push(body);
    const chars = body.messages.reduce((a, m) => a + m.content.length, 0), prompt = Math.round(chars / 5) + 20;
    const chunks = [
      { choices: [{ delta: { reasoning_content: '' } }] },
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' world' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: prompt, completion_tokens: body.max_tokens, prompt_tokens_details: { cached_tokens: body.messages.length > 2 ? prompt - 1800 : 0 } },
        timings: { prompt_per_second: 800 + body.max_tokens, predicted_per_second: 40 + bodies.length % 3, prompt_n: body.messages.length > 2 ? 1800 : prompt } },
    ];
    return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  vi.stubGlobal('fetch', fetch);
  return bodies;
}

describe('runOfficialBench over a mocked SSE service', () => {
  it('sends the script\'s requests in order and summarises them', async () => {
    const bodies = server(131072), seen: string[] = [];
    const report = await runOfficialBench(profile, { ...DEFAULT_OFFICIAL_BENCH_OPTIONS, runs: 1 }, p => seen.push(p.phase));
    expect(report.state).toBe('completed');
    const maxTokens = bodies.map(b => b.max_tokens);
    // warm-up 24, calibration 1+1, 1K 8; chat 3x100; 4K, 16K 24; agent 6x64; 32K 24
    expect(maxTokens).toEqual([24, 1, 1, 8, 100, 100, 100, 24, 24, 64, 64, 64, 64, 64, 64, 24]);
    const content = (i: number) => (bodies[i]!.messages as { content: string }[]).at(-1)!.content;
    expect(content(1)).toMatch(/^\[cal-200-\d+\]\nHere is a list of words:/);
    expect(content(4)).toMatch(/^\[0-0-c-\d+\] Write a Python function/);
    expect(content(7)).toMatch(/^\[bench 0-4096-p-\d+\]\n/);
    expect(bodies[9]!.tools).toHaveLength(4);
    expect((bodies[14]!.messages as unknown[]).length).toBe(2 + 5 * 2);
    expect(report.results.chat?.decodeTps?.n).toBe(3);
    expect(report.results.prompts['32K']?.targetTokens).toBe(32768);
    expect(report.results.agent?.hitPct?.n).toBe(1);
    expect(report.machine.gpuNames).toEqual(['AMD Radeon(TM) 8060S Graphics']);
    expect(matchOfficialReference(report.machine).reference?.id).toBe('strix-halo-windows-qwen-iq3s-0.2.7');
    const rows = officialComparisonRows(report, matchOfficialReference(report.machine).reference);
    expect(rows.find(r => r.key === 'chatDecodeTps')).toMatchObject({ official: 44, higherBetter: true });
    expect(new Set(seen)).toEqual(new Set(['warmup', 'chat', '4K', '16K', 'agent', '32K', 'done']));
  });
  it('skips what the context cannot hold and stops on cancel', async () => {
    server(8192);
    const report = await runOfficialBench(profile, { ...DEFAULT_OFFICIAL_BENCH_OPTIONS, runs: 1 });
    expect(Object.keys(report.results.prompts)).toEqual(['4K']);
    expect(report.results.skipped).toEqual({ '16K': 'the context is 8192 tokens', '32K': 'the context is 8192 tokens', agent: 'context 8192 is below ~10K' });
    server(131072);
    const controller = new AbortController();
    const cancelled = await runOfficialBench(profile, { ...DEFAULT_OFFICIAL_BENCH_OPTIONS, runs: 1 }, p => { if (p.phase === 'chat') controller.abort(); }, controller.signal);
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.results.chat).toBeNull();
  });
});
