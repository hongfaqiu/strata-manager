import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildChatRequest, buildSharedDefaults, decodeChatChunk, hasApiKey, MODEL_CATALOG, normalizeBaseUrl, normalizeError, normalizeMetrics, request, setApiKey, SSEParser, startService, StrataError, streamChat } from '../src';
import type { ChatDelta, ChatMessage, ChatOptions, ServiceProfile } from '../src';

const profile: ServiceProfile = { id: 'test', name: 'local', baseUrl: 'http://127.0.0.1:8080', installDir: '', configPath: '', pythonPath: '', managed: false };
const options: ChatOptions = { model: 'actual-model', reasoningEffort: 'high', temperature: 0.6, topP: 0.95, maxTokens: 0, systemPrompt: '', mcp: true };
const message: ChatMessage = { id: 'message', role: 'user', content: '阅读', createdAt: 1 };
afterEach(() => vi.unstubAllGlobals());

describe('SSE protocol', () => {
  it('preserves UTF-8 split at every byte with CRLF, comment and final frame', () => {
    const bytes = new TextEncoder().encode(': keep-alive\r\ndata: {"choices":[{"delta":{"reasoning_content":"思考🦢"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"答复"}}]}\n\ndata: [DONE]');
    for (let split = 0; split <= bytes.length; split++) {
      const deltas: ChatDelta[] = [];
      const parser = new SSEParser(data => deltas.push(...decodeChatChunk(data)));
      parser.push(bytes.slice(0, split)); parser.push(bytes.slice(split)); parser.finish();
      expect(deltas).toEqual([{ reasoning: '思考🦢', content: undefined }, { content: '答复', reasoning: undefined }, { done: true }]);
    }
    const frames: string[] = [];
    const parser = new SSEParser(data => frames.push(data));
    for (const byte of bytes) parser.push(Uint8Array.of(byte));
    parser.finish();
    expect(frames).toHaveLength(3);
  });
  it('supports multiline data, lone CR and ignores event/comment fields', () => {
    const frames: string[] = [];
    const parser = new SSEParser(data => frames.push(data));
    parser.push('event: message\r:data ignored\rdata: {"hello":\rdata: "世界"}\r\r'); parser.finish();
    expect(JSON.parse(frames[0]!)).toEqual({ hello: '世界' });
  });
  it('surfaces real Strata MCP call/result/limit plus reasoning and usage', () => {
    const call = decodeChatChunk(JSON.stringify({ strata_mcp: { event: 'call', id: 'c1', name: 'web_search', server: 'web', tool: 'search', arguments: { q: 'Strata' }, round: 0 } }))[0]?.tool;
    expect(call).toMatchObject({ id: 'c1', name: 'web_search', status: 'running', round: 0, arguments: { q: 'Strata' } });
    expect(decodeChatChunk('{"strata_mcp":{"event":"result","id":"c1","ok":true,"text":"result"}}')[0]?.tool).toMatchObject({ id: 'c1', status: 'done', result: 'result' });
    expect(decodeChatChunk('{"strata_mcp":{"event":"limit","max_rounds":5}}')[0]?.tool).toMatchObject({ status: 'limit', raw: { max_rounds: 5 } });
  });
  it('rejects malformed frames and engine failures explicitly', () => {
    expect(() => decodeChatChunk('bad')).toThrowError(StrataError);
    expect(() => decodeChatChunk('{"error":{"message":"engine unavailable"}}')).toThrow('engine unavailable');
  });
});

describe('chat request semantics', () => {
  it('maps optional sampling parameters and official shared defaults without local-only fields', () => {
    const sampling = { ...options, topK: 32, seed: 42, experimentalSpeedProjection: false, maxTokens: 2048 };
    expect(buildChatRequest([message], sampling)).toMatchObject({ top_k: 32, seed: 42, experimental_speed_projection: false, max_tokens: 2048 });
    expect(buildSharedDefaults({ ...sampling, model: '', systemPrompt: 'local', mcp: true })).toEqual({ reasoning_effort: 'high', temperature: 0.6, top_p: 0.95, top_k: 32, seed: 42, max_tokens: 2048, experimental_speed_projection: false });
    const greedy = buildChatRequest([message], { ...options, temperature: 0, seed: null });
    expect(greedy).not.toHaveProperty('top_k'); expect(greedy).not.toHaveProperty('top_p'); expect(greedy).not.toHaveProperty('seed'); expect(greedy).not.toHaveProperty('experimental_speed_projection');
    expect(() => buildSharedDefaults({ ...options, topK: 65 })).toThrow('topK');
    expect(() => buildSharedDefaults({ ...options, seed: 0 })).toThrow('seed');
  });
  it('retains text files and images with upstream message syntax and safe fences', () => {
    const input: ChatMessage = { ...message, attachments: [
      { id: 'txt', type: 'text', mimeType: 'text/plain', name: 'code.ts', content: '```\nconst a = 1;' },
      { id: 'img', type: 'image', mimeType: 'image/png', name: 'chart.png', content: 'data:image/png;base64,aGVsbG8=' },
    ] };
    const body = buildChatRequest([input], { ...options, images: true });
    expect(body).toMatchObject({ model: 'actual-model', stream: true, strata_mcp: true, reasoning_effort: 'high', messages: [{ role: 'user', content: [{ type: 'text', text: '阅读\n\nFile: code.ts\n````\n```\nconst a = 1;\n````' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }] });
    expect(body).not.toHaveProperty('mcp');
    expect(body).not.toHaveProperty('max_tokens');
    expect(() => buildChatRequest([input], options)).toThrow('服务未确认支持图片');
  });
  it('rejects binary/oversize unsupported attachments without silently dropping them', () => {
    const withText = (content: string): ChatMessage => ({ ...message, attachments: [{ id: 'a', type: 'text', mimeType: 'text/plain', name: 'file', content }] });
    expect(() => buildChatRequest([withText('a\0b')], options)).toThrow('二进制');
    expect(() => buildChatRequest([withText('汉'.repeat(180000))], options)).toThrow('512 KB');
    expect(() => buildChatRequest([{ ...message, attachments: [{ id: 'a', type: 'image', mimeType: 'image/svg+xml', name: 'vector.svg', content: '<svg/>' }] }], { ...options, images: true })).toThrow('格式');
  });
  it('replays completed MCP rounds and reasoning-only turns as upstream does', () => {
    const assistant: ChatMessage = { ...message, role: 'assistant', content: '检查中。结果是 42', tools: [{ name: 'calculator', status: 'done', id: 't1', arguments: { n: 42 }, result: '42', round: 0, at: 4 }] };
    expect(buildChatRequest([assistant], options).messages).toEqual([
      { role: 'assistant', content: '检查中。', tool_calls: [{ id: 't1', type: 'function', function: { name: 'calculator', arguments: '{"n":42}' } }] },
      { role: 'tool', tool_call_id: 't1', content: '42' }, { role: 'assistant', content: '结果是 42' },
    ]);
    expect(buildChatRequest([{ ...assistant, content: '', reasoning: 'thinking', tools: [] }], options).messages).toEqual([{ role: 'assistant', content: '', reasoning_content: 'thinking' }]);
    expect(buildChatRequest([message], { ...options, reasoningEffort: 'off' }).reasoning_effort).toBe('none');
  });
});

describe('actual metrics layout', () => {
  it('keeps missing hardware null and missing state unknown, preserves observed zero', () => {
    const empty = normalizeMetrics({});
    expect(empty).toMatchObject({ state: 'unknown', model: '', decodeTokS: null, gpuUtil: null, queued: null, running: null, cacheHitRate: null });
    const metrics = normalizeMetrics({ live: { state: 'generating', tok_s: 41.2, queued: 0, running: 1, prefill_tok_s_mean: 1100 }, engine: { model: 'real-model' }, hardware: { gpu_util: 0, gpu_mem_used: 2048, cpu: 5 }, history: { gpu_util: [null, 0, 32, 'bad'] } });
    expect(metrics).toMatchObject({ decodeTokS: 41.2, prefillTokS: 1100, gpuUtil: 0, gpuMemoryUsed: 2048, queued: 0, running: 1, ramUsed: null });
    expect(metrics.history.gpu_util).toEqual([null, 0, 32, null]);
  });
  it('uses newest request decode and non-reused prompt time while idle', () => {
    expect(normalizeMetrics({ live: { state: 'idle' }, requests: [{ decode_tok_s: 40, prompt_tokens: 1000, reused: 800, prompt_ms: 500, hit_rate: 0.75 }] })).toMatchObject({ decodeTokS: 40, prefillTokS: 400, cacheHitRate: 0.75 });
    expect(normalizeMetrics({ live: { state: 'idle' }, requests: [{ prompt_tokens: 1000, prompt_ms: 0 }] }).prefillTokS).toBeNull();
  });
  it('uses official multi-GPU aggregation rules and keeps per-card raw data', () => {
    const hardware = { gpus: [{ index: 0, util: 40, mem_used: 10, mem_total: 20, temp: 60, power: 50 }, { index: 1, util: 80, mem_used: 5, mem_total: 20, temp: 70, power: 30 }] };
    const metrics = normalizeMetrics({ hardware });
    expect(metrics).toMatchObject({ gpuUtil: 60, gpuMemoryUsed: 15, gpuMemoryTotal: 40, gpuTemperature: 70, gpuPower: 80 });
    expect(metrics.raw.hardware).toBe(hardware);
    expect(normalizeMetrics({ hardware: { ...hardware, gpu_util: 57 } }).gpuUtil).toBe(57);
    expect(normalizeMetrics({ hardware: { gpus: [{ util: null }, {}] } }).gpuUtil).toBeNull();
  });
});

describe('bridge requests and errors', () => {
  it('normalizes copied /v1 endpoints identically before browser proxy access', async () => {
    expect(normalizeBaseUrl(' http://localhost:8080/v1/ ')).toBe('http://localhost:8080');
    expect(() => normalizeBaseUrl('http://localhost:8080/other')).toThrow('根地址');
    const fetch = vi.fn().mockResolvedValue(new Response('{"status":"ok"}')); vi.stubGlobal('fetch', fetch);
    await request({ ...profile, baseUrl: 'http://127.0.0.1:8080/v1' }, '/health');
    expect(fetch.mock.calls[0]?.[0]).toBe('/__strata_proxy?baseUrl=http%3A%2F%2F127.0.0.1%3A8080&path=%2Fhealth');
  });
  it('uses the real preview proxy and session-only Authorization; preserves HTTP 409', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"error":{"message":"a request is running or queued"}}', { status: 409, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    await setApiKey(profile.id, 'secret-for-test');
    expect(await hasApiKey(profile.id)).toBe(true);
    await expect(request(profile, '/unload', 'POST', {})).rejects.toMatchObject({ code: 'BUSY', status: 409, message: 'a request is running or queued' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/__strata_proxy?baseUrl=http%3A%2F%2F127.0.0.1%3A8080&path=%2Funload');
    expect(init).toMatchObject({ method: 'POST', body: '{}', headers: { Authorization: 'Bearer secret-for-test' } });
    expect(url).not.toContain('secret-for-test');
    await setApiKey(profile.id, '');
    expect(await hasApiKey(profile.id)).toBe(false);
  });
  it('rejects remote preview, path traversal, native-only operations and invalid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>wrong endpoint</html>')));
    await expect(request({ ...profile, baseUrl: 'http://remote.example:8080' }, '/health')).rejects.toMatchObject({ code: 'LOCAL_SERVICE_ONLY' });
    await expect(request(profile, '/%2e%2e/health')).rejects.toMatchObject({ code: 'INVALID_API_PATH' });
    await expect(startService(profile)).rejects.toMatchObject({ code: 'DESKTOP_REQUIRED' });
    await expect(request(profile, '/health')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(normalizeError('{"code":"CONFIG_INVALID","message":"bad"}')).toMatchObject({ code: 'CONFIG_INVALID', message: 'bad' });
  });
  it('streams real MCP round state through fragmented bytes and rejects a dropped stream', async () => {
    const payload = [
      { choices: [{ delta: { content: '先查询。' } }] },
      { strata_mcp: { event: 'call', id: 'c', name: 'search', round: 0, arguments: { q: 'x' } } },
      { strata_mcp: { event: 'result', id: 'c', ok: true, text: 'found' } },
      { choices: [{ delta: { content: '完成。' } }] },
    ].map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n';
    const bytes = new TextEncoder().encode(payload);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(new ReadableStream({ start(controller) { for (const b of bytes) controller.enqueue(Uint8Array.of(b)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } }))));
    const deltas: ChatDelta[] = [];
    await streamChat(profile, {}, delta => deltas.push(delta));
    expect(deltas[2]?.tool).toMatchObject({ name: 'search', round: 0, at: 4, result: 'found', arguments: { q: 'x' }, status: 'done' });
    expect(deltas.at(-1)).toEqual({ done: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('data: {"choices":[]}\n\n', { headers: { 'content-type': 'text/event-stream' } })));
    await expect(streamChat(profile, {}, () => {})).rejects.toMatchObject({ code: 'STREAM_INCOMPLETE' });
  });
  it('cancels before issuing a request', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const controller = new AbortController(); controller.abort();
    await expect(streamChat(profile, {}, () => {}, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('catalog contains only the upstream family/quant combinations', () => {
    expect(MODEL_CATALOG.find(m => m.id === 'swift')?.quants).toEqual(['IQ2_XS', 'IQ3_XXS']);
    expect(MODEL_CATALOG.find(m => m.id === 'coder')?.quants).toEqual(['IQ1_M']);
    expect(MODEL_CATALOG.every(m => m.source.includes('Niko1221/Strata'))).toBe(true);
  });
});
