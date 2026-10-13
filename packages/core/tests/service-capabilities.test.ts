import { describe, expect, it, vi } from 'vitest';
import { buildAdvancedChatFields, parseChatCapabilities, type ChatOptions } from '../src/chat';
import { StrataError } from '../src/errors';
import { parseServiceCapabilities, readServiceCapabilities, type ServiceCapabilityTransport } from '../src/service-capabilities';
import type { ServiceProfile } from '../src/types';

const status = { service: 'strata', dialects: ['/v1/chat/completions'], structured_output: { formats: ['json_object'] } };
const runtime = { verified: true, pid: 10, startedAt: 100, promptCache: 1 };
const state = (input: Parameters<typeof parseServiceCapabilities>[0], id: string) => parseServiceCapabilities(input).items.find(item => item.id === id)?.state;

describe('shared service capability evidence', () => {
  it('does not interpret a missing or malformed engine version as lack of prefix support', () => {
    for (const version of [undefined, 'unknown', '0.1']) {
      expect(state({ profileId: 'p', status, metrics: { engine: { version } }, runtime, configuredPromptCache: 4 }, 'prefix')).toBe('unknown');
    }
    expect(state({ profileId: 'p', status, metrics: { engine: { version: '0.1.40.1' } }, runtime, configuredPromptCache: 4 }, 'prefix')).toBe('unavailable');
  });
  it('requires complete resident identity before reporting that a saved cache edit needs restart', () => {
    expect(state({ profileId: 'p', status, metrics: { engine: { version: '0.1.43.1' } }, runtime: { verified: true, promptCache: 1 }, configuredPromptCache: 4 }, 'prefix')).toBe('unknown');
    expect(state({ profileId: 'p', status, metrics: { engine: { version: '0.1.43.1' } }, runtime, configuredPromptCache: 4 }, 'prefix')).toBe('restartRequired');
    expect(state({ profileId: 'p', status, metrics: { engine: { version: '0.1.43.1' } }, configuredPromptCache: 4 }, 'prefix')).toBe('unknown');
  });
  it('never trusts capability flags from a non-Strata status', () => {
    expect(state({ profileId: 'p', status: { service: 'other', tools: true } }, 'tools')).toBe('unknown');
  });
  it('treats malformed support and concurrency fields as unknown', () => {
    for (const logit_bias of [null, '1', 2]) expect(state({ profileId: 'p', status, metrics: { engine: { logit_bias }, live: { parallel: 1 } } }, 'logitBias')).toBe('unknown');
    for (const parallel of [0, -1, NaN, 1.5]) expect(state({ profileId: 'p', status, metrics: { engine: { logit_bias: 1 }, live: { parallel } } }, 'logitBias')).toBe('unknown');
    expect(state({ profileId: 'p', status, metrics: { engine: { logit_bias: 0 } } }, 'logitBias')).toBe('unavailable');
  });
  it('keeps structured-format evidence separate and distinguishes malformed lists from explicit absence', () => {
    expect(state({ profileId: 'p', status }, 'jsonObject')).toBe('available');
    expect(state({ profileId: 'p', status }, 'jsonSchema')).toBe('unavailable');
    expect(state({ profileId: 'p', status: { ...status, structured_output: { formats: [false] } } }, 'json')).toBe('unknown');
  });
  it('uses the same prefix state for chat controls and request guards', () => {
    const caps = parseChatCapabilities(status, { engine: { version: '0.1.43.1' } }, { args: ['--prompt-cache', '4'] }, runtime);
    expect(caps).toMatchObject({ prefix: false, states: { prefix: { state: 'restartRequired' } } });
    expect(caps.prefixReason).toContain('重启');
  });
  it.each(['unknown', 'restartRequired', 'unavailable'] as const)('reports the %s reason when request-local prefix settings are blocked', expected => {
    const caps = parseChatCapabilities(status, { engine: { version: '0.1.43.1' } }, expected === 'restartRequired' ? { args: ['--prompt-cache', '4'] } : undefined, expected === 'unknown' ? undefined : runtime);
    const options: ChatOptions = { model: 'fixture', reasoningEffort: 'off', temperature: 0, topP: 1, maxTokens: 256, systemPrompt: '', mcp: false, fixedPrefix: { messageId: 'document' }, capabilities: caps };
    let error: unknown; try { buildAdvancedChatFields(options); } catch (cause) { error = cause; }
    expect(error).toBeInstanceOf(StrataError);
    expect((error as StrataError).code).toBe(expected === 'unknown' ? 'CHAT_FEATURE_UNVERIFIED' : expected === 'restartRequired' ? 'CHAT_FEATURE_RESTART_REQUIRED' : 'CHAT_FEATURE_UNSUPPORTED');
  });
});

describe('fresh read-only capability snapshots', () => {
  const profile: ServiceProfile = { id: 'p', name: 'fixture', baseUrl: 'http://127.0.0.1:19991', installDir: '', configPath: '', pythonPath: '', managed: false };
  const identity = { running: true, pid: 1, startedAt: 100, engine: { pid: 10, startedAt: 100 } };
  const health = { service: 'strata', status: 'ok', loaded: true, model: 'fixture' };
  const fixture = () => ({
    read: vi.fn<ServiceCapabilityTransport['read']>(async (_profile, path) => path === '/health' ? health : path === '/v1/status' ? status : { engine: { version: '0.1.43.1' } }),
    identity: vi.fn(async () => identity), runtime: vi.fn(async () => runtime), configuration: vi.fn(async () => ({ args: ['--prompt-cache=4'] })),
  });
  it('compares saved argv with the uniquely identified engine without writing settings or generating', async () => {
    const io = fixture(), result = await readServiceCapabilities(profile, {}, io);
    expect(result.evidenceCurrent).toBe(true);
    expect(result.items.find(item => item.id === 'prefix')?.state).toBe('restartRequired');
    expect(io.identity).toHaveBeenCalledTimes(2);
    expect(io.read.mock.calls.every(call => ['/health', '/v1/status', '/metrics'].includes(call[1]))).toBe(true);
  });
  it.each(['root', 'engine', 'load', 'model'])('invalidates every result if %s changes while sampling', async change => {
    const io = fixture();
    if (change === 'root') io.identity.mockResolvedValueOnce(identity).mockResolvedValueOnce({ ...identity, pid: 2 });
    else if (change === 'engine') io.identity.mockResolvedValueOnce(identity).mockResolvedValueOnce({ ...identity, engine: { pid: 11, startedAt: 200 } });
    else { let healthReads = 0; io.read.mockImplementation(async (_profile, path) => path === '/health' ? (++healthReads === 1 ? health : { ...health, ...(change === 'load' ? { loaded: false } : { model: 'changed' }) }) : path === '/v1/status' ? status : {}); }
    const result = await readServiceCapabilities(profile, {}, io);
    expect(result.evidenceCurrent).toBe(false);
    expect(result.items.every(item => item.state === 'unknown' && item.reason === 'identityChanged')).toBe(true);
  });
  it('rejects cached resident argv belonging to a different engine', async () => {
    const io = fixture(); io.runtime.mockResolvedValue({ ...runtime, pid: 9 });
    expect((await readServiceCapabilities(profile, {}, io)).items.find(item => item.id === 'prefix')?.state).toBe('unknown');
  });
});
