import { describe, expect, it } from 'vitest';
import { buildChatRequest, type ChatOptions } from '../src/chat';
import {
  DEFAULT_COMMON_CHAT_DEFAULTS, normalizeCommonChatDefaults, prepareModelChatOptionsForSave,
  resolveCommonChatOptions, usesCommonChatDefaults,
} from '../src/shared-chat-settings';

const defaults: ChatOptions = { ...DEFAULT_COMMON_CHAT_DEFAULTS, model: 'current-model' };
const common = normalizeCommonChatDefaults({
  temperature: .25, topP: .8, topK: 12, maxTokens: 2048, seed: 42,
  reasoningEffort: 'low', systemPrompt: '公共提示词', mcp: false,
});

describe('shared chat settings', () => {
  it('preserves legacy per-model options without modifying stored data', () => {
    const saved: ChatOptions = { ...defaults, model: 'saved-model', temperature: 1.1, systemPrompt: '原有提示词' };
    const original = structuredClone(saved);
    expect(usesCommonChatDefaults(saved)).toBe(false);
    expect(resolveCommonChatOptions(defaults, common, saved)).toEqual(saved);
    expect(saved).toEqual(original);
  });

  it('uses shared values for new models while retaining their model ID', () => {
    expect(usesCommonChatDefaults()).toBe(true);
    expect(resolveCommonChatOptions(defaults, common)).toEqual({ ...defaults, ...common });
    expect(resolveCommonChatOptions({ ...defaults, model: 'another-model' }, common).model).toBe('another-model');
  });

  it('inherits common settings only when explicitly enabled for existing values', () => {
    const saved = { ...defaults, model: 'saved-model', temperature: 1.1, experimentalSpeedProjection: true };
    expect(usesCommonChatDefaults(saved, true)).toBe(true);
    expect(resolveCommonChatOptions(defaults, common, saved, true)).toEqual({ ...saved, ...common });
    expect(resolveCommonChatOptions(defaults, common, saved, false)).toEqual(saved);
    expect(usesCommonChatDefaults(undefined, false)).toBe(false);
    expect(resolveCommonChatOptions(defaults, common, undefined, false)).toEqual(defaults);
  });

  it('does not carry model identity, advanced settings, live capabilities or projection between models', () => {
    const unsafeCommon = {
      ...common, model: 'wrong-model', advanced: { responseFormat: 'json_schema' },
      fixedPrefix: { messageId: 'wrong-conversation' }, experimentalSpeedProjection: true,
      images: true, capabilities: { sampling: true },
    };
    const saved: ChatOptions = {
      ...defaults, model: 'saved-model', advanced: { responseFormat: 'json_object' },
      experimentalSpeedProjection: false, images: false,
      capabilities: { structuredFormats: [], sampling: false, stops: false, prefix: false, logitBias: false, prefixReason: '未核验' },
    };
    const next = resolveCommonChatOptions(defaults, unsafeCommon, saved, true);
    expect(next).toEqual({ ...saved, ...common });
    expect(resolveCommonChatOptions(defaults, unsafeCommon)).toEqual({ ...defaults, ...common });
    expect(next.images).toBe(saved.images);
    expect(next.capabilities).toBe(saved.capabilities);
    expect(next).not.toHaveProperty('fixedPrefix');
  });

  it.each(['json_object', 'json_schema'] as const)('keeps %s output compatible with inherited MCP defaults', responseFormat => {
    const saved: ChatOptions = {
      ...defaults, model: 'structured-model', mcp: true, images: true, experimentalSpeedProjection: false,
      advanced: { responseFormat, schemaName: 'result', schemaText: '{"type":"object","properties":{"answer":{"type":"string"}}}' },
      capabilities: { structuredFormats: [responseFormat], sampling: false, stops: false, prefix: false, logitBias: false, prefixReason: '' },
    };
    const original = structuredClone(saved);
    const next = resolveCommonChatOptions(defaults, { ...common, mcp: true }, saved, true);
    expect(next.mcp).toBe(false);
    expect(next.advanced).toBe(saved.advanced);
    expect(next.capabilities).toBe(saved.capabilities);
    expect(next.images).toBe(true);
    expect(next.model).toBe('structured-model');
    expect(next.experimentalSpeedProjection).toBe(false);
    expect(buildChatRequest([], next)).toMatchObject({ model: 'structured-model', response_format: { type: responseFormat } });
    expect(buildChatRequest([], next)).not.toHaveProperty('strata_mcp');
    expect(saved).toEqual(original);
    expect(resolveCommonChatOptions(defaults, common, saved, false)).toEqual(saved);
  });

  it('keeps inherited MCP enabled for text output', () => {
    const saved: ChatOptions = { ...defaults, advanced: { responseFormat: 'text' } };
    const next = resolveCommonChatOptions(defaults, { ...common, mcp: true }, saved, true);
    expect(buildChatRequest([], next)).toHaveProperty('strata_mcp', true);
  });

  it('preserves all old dedicated values when only model-specific options change during inheritance', () => {
    const saved: ChatOptions = { ...defaults, model: 'saved-model', temperature: 1.1, systemPrompt: '专用提示词' };
    const original = structuredClone(saved);
    const effective = resolveCommonChatOptions(defaults, common, saved, true);
    const next = { ...effective, advanced: { minP: .1 }, experimentalSpeedProjection: false };
    const stored = prepareModelChatOptionsForSave(next, saved, true);
    for (const key of Object.keys(DEFAULT_COMMON_CHAT_DEFAULTS) as (keyof typeof DEFAULT_COMMON_CHAT_DEFAULTS)[]) {
      expect(stored[key]).toEqual(saved[key]);
    }
    expect(resolveCommonChatOptions(defaults, common, stored, false)).toEqual({
      ...saved, advanced: { minP: .1 }, experimentalSpeedProjection: false,
    });
    expect(resolveCommonChatOptions(defaults, common, stored, true)).toEqual(next);
    expect(prepareModelChatOptionsForSave(effective, saved, true)).toEqual(saved);
    expect(saved).toEqual(original);
  });

  it('retains official dedicated fallbacks for a new model instead of copying inherited common values', () => {
    const next = {
      ...resolveCommonChatOptions(defaults, common),
      model: 'new-model', advanced: { minP: .1 }, images: false, experimentalSpeedProjection: false,
    };
    const stored = prepareModelChatOptionsForSave(next, undefined, true);
    expect(stored).toEqual({ ...next, ...DEFAULT_COMMON_CHAT_DEFAULTS });
    expect(resolveCommonChatOptions(defaults, common, stored, true)).toEqual(next);
    expect(stored.model).toBe('new-model');
    expect(stored.temperature).not.toBe(common.temperature);
  });

  it('stores the complete new dedicated options when a common parameter is explicitly changed', () => {
    const saved: ChatOptions = { ...defaults, temperature: 1.1 };
    const next = { ...resolveCommonChatOptions(defaults, common, saved, true), temperature: .75, advanced: { minP: .1 } };
    const stored = prepareModelChatOptionsForSave(next, saved, false);
    expect(stored).toEqual(next);
    expect(resolveCommonChatOptions(defaults, common, stored, false)).toEqual(next);
    expect(saved.temperature).toBe(1.1);
  });

  it('normalizes each invalid storage field to the official default', () => {
    for (const raw of [null, undefined, true, 3, 'text', [], {
      reasoningEffort: 'none', temperature: Infinity, topP: 0, topK: 65,
      maxTokens: -1, seed: 0, systemPrompt: {}, mcp: 'true',
    }]) expect(normalizeCommonChatDefaults(raw)).toEqual(DEFAULT_COMMON_CHAT_DEFAULTS);
    expect(normalizeCommonChatDefaults({ temperature: .3, topP: NaN, topK: 1.5, maxTokens: Number.MAX_SAFE_INTEGER + 1, seed: -1 }))
      .toEqual({ ...DEFAULT_COMMON_CHAT_DEFAULTS, temperature: .3 });
    expect(normalizeCommonChatDefaults({ temperature: '0.3', seed: '42', maxTokens: '2048' })).toEqual(DEFAULT_COMMON_CHAT_DEFAULTS);
  });

  it('keeps valid zero, false, empty prompt and random seed choices', () => {
    expect(normalizeCommonChatDefaults({
      reasoningEffort: 'off', temperature: 0, topP: 1, topK: 64,
      maxTokens: 0, seed: null, systemPrompt: '', mcp: false,
    })).toEqual({ ...DEFAULT_COMMON_CHAT_DEFAULTS, reasoningEffort: 'off', temperature: 0, topP: 1, topK: 64, mcp: false });
  });
});
