import type { ChatOptions } from './chat';

/** Request defaults that are safe to share independently of a model's capabilities. */
export type CommonChatDefaults = Pick<ChatOptions,
  'reasoningEffort' | 'temperature' | 'topP' | 'topK' | 'maxTokens' | 'seed' | 'systemPrompt' | 'mcp'>;

export const DEFAULT_COMMON_CHAT_DEFAULTS: Readonly<CommonChatDefaults> = Object.freeze({
  reasoningEffort: 'high', temperature: .6, topP: .95, topK: 20,
  maxTokens: 0, seed: null, systemPrompt: '', mcp: true,
});

/** Invalid persisted fields fall back individually; model-bound fields never enter this object. */
export function normalizeCommonChatDefaults(value: unknown): CommonChatDefaults {
  const stored = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const numberInRange = (input: unknown, min: number, max: number, openMin = false): input is number =>
    typeof input === 'number' && Number.isFinite(input)
      && (openMin ? input > min : input >= min) && input <= max;
  return {
    reasoningEffort: typeof stored.reasoningEffort === 'string'
      && ['off', 'low', 'medium', 'high'].includes(stored.reasoningEffort)
      ? stored.reasoningEffort as ChatOptions['reasoningEffort'] : DEFAULT_COMMON_CHAT_DEFAULTS.reasoningEffort,
    temperature: numberInRange(stored.temperature, 0, 2) ? stored.temperature : DEFAULT_COMMON_CHAT_DEFAULTS.temperature,
    topP: numberInRange(stored.topP, 0, 1, true) ? stored.topP : DEFAULT_COMMON_CHAT_DEFAULTS.topP,
    topK: typeof stored.topK === 'number' && Number.isInteger(stored.topK) && stored.topK >= 1 && stored.topK <= 64
      ? stored.topK : DEFAULT_COMMON_CHAT_DEFAULTS.topK,
    maxTokens: typeof stored.maxTokens === 'number' && Number.isSafeInteger(stored.maxTokens) && stored.maxTokens >= 0
      ? stored.maxTokens : DEFAULT_COMMON_CHAT_DEFAULTS.maxTokens,
    seed: typeof stored.seed === 'number' && Number.isSafeInteger(stored.seed) && stored.seed > 0
      ? stored.seed : DEFAULT_COMMON_CHAT_DEFAULTS.seed,
    systemPrompt: typeof stored.systemPrompt === 'string' ? stored.systemPrompt : DEFAULT_COMMON_CHAT_DEFAULTS.systemPrompt,
    mcp: typeof stored.mcp === 'boolean' ? stored.mcp : DEFAULT_COMMON_CHAT_DEFAULTS.mcp,
  };
}

/** Existing per-model values stay independent until the user explicitly opts in. */
export function usesCommonChatDefaults(saved?: ChatOptions, explicit?: boolean): boolean {
  return explicit ?? !saved;
}

export function resolveCommonChatOptions(
  defaults: ChatOptions,
  common: CommonChatDefaults,
  saved?: ChatOptions,
  explicit?: boolean,
): ChatOptions {
  const resolved = { ...defaults, ...saved };
  if (!usesCommonChatDefaults(saved, explicit)) return resolved;
  const inherited = { ...resolved, ...normalizeCommonChatDefaults(common) };
  // Preserve the model's structured output choice, which cannot be combined with MCP.
  if (inherited.advanced?.responseFormat && inherited.advanced.responseFormat !== 'text') inherited.mcp = false;
  return inherited;
}

/** Save model-specific changes without replacing dedicated defaults with inherited values. */
export function prepareModelChatOptionsForSave(
  next: ChatOptions,
  saved: ChatOptions | undefined,
  continuesInheritance: boolean,
): ChatOptions {
  if (!continuesInheritance) return { ...next };
  // New inheriting models retain the official fallback, rather than a snapshot of common values.
  const dedicated = saved ?? DEFAULT_COMMON_CHAT_DEFAULTS;
  return {
    ...next,
    reasoningEffort: dedicated.reasoningEffort,
    temperature: dedicated.temperature,
    topP: dedicated.topP,
    topK: dedicated.topK,
    maxTokens: dedicated.maxTokens,
    seed: dedicated.seed,
    systemPrompt: dedicated.systemPrompt,
    mcp: dedicated.mcp,
  };
}
