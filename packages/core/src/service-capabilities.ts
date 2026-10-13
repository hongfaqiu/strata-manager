import { asObject } from './errors';
import type { ChatRuntimeEvidence } from './chat';
import { benchmarkIdentity, getChatRuntimeEvidence, isDesktop, readConfig, request, serviceStatus } from './bridge';
import type { ServiceProfile } from './types';

export type CapabilityState = 'available' | 'unavailable' | 'unknown' | 'restartRequired';
export type ServiceCapabilityId = 'chat' | 'messages' | 'responses' | 'images' | 'tools' | 'json' | 'jsonObject' | 'jsonSchema' | 'prefix' | 'logitBias' | 'sampling' | 'stops';
export interface ServiceCapability { id: ServiceCapabilityId; state: CapabilityState; reason: string; source: string }
export interface ServiceCapabilities {
  sampledAt: number; profileId: string; pid: number | null; startedAt: number | null; runtimeVersion: string | null;
  vocabularySize?: number;
  evidenceCurrent?: boolean;
  identity?: ServiceCapabilityIdentity;
  items: ServiceCapability[];
}
export interface ServiceCapabilityIdentity {
  running?: boolean; pid?: number; startedAt?: number; engine?: { pid: number; startedAt: number } | null;
  service?: string; loaded?: boolean; model?: string; version?: string;
}
export interface ServiceCapabilityTransport {
  read: (profile: ServiceProfile, path: string) => Promise<unknown>;
  runtime?: (profile: ServiceProfile) => Promise<ChatRuntimeEvidence | undefined>;
  configuration?: (profile: ServiceProfile) => Promise<unknown>;
  identity?: (profile: ServiceProfile) => Promise<ServiceCapabilityIdentity | undefined>;
}
export interface ServiceCapabilityInput {
  profileId: string; health?: unknown; status?: unknown; metrics?: unknown; runtime?: ChatRuntimeEvidence;
  sampledAt?: number; configuredPromptCache?: number;
  /** null means that the reader could not establish a current native engine. */
  engineIdentity?: { pid: number; startedAt: number } | null;
  evidenceCurrent?: boolean;
}
const safeInteger = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
function prefixVersion(value: unknown): boolean | undefined {
  const match = typeof value === 'string' && /(?:^|\D)(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/.exec(value);
  if (!match) return undefined;
  const minimum = [0, 1, 40, 2];
  for (let i = 0; i < minimum.length; i++) { const part = Number(match[i + 1] ?? 0); if (part !== minimum[i]) return part > minimum[i]!; }
  return true;
}
/** Read saved argv only to explain unapplied edits; this never establishes live support. */
export function configuredPromptCache(config: unknown): number | undefined {
  const args = asObject(config).args;
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) return undefined;
  const values = args.flatMap((arg: string, index) => arg === '--prompt-cache' ? [args[index + 1]] : arg.startsWith('--prompt-cache=') ? [arg.slice('--prompt-cache='.length)] : []);
  if (values.length !== 1 || typeof values[0] !== 'string' || !/^\d+$/.test(values[0])) return undefined;
  const value = Number(values[0]); return safeInteger(value) ? value : undefined;
}
export function serviceCapability(capabilities: ServiceCapabilities, id: ServiceCapabilityId): ServiceCapability {
  return capabilities.items.find(item => item.id === id) ?? { id, state: 'unknown', reason: 'notReported', source: '' };
}
export function describeServiceCapability(item: ServiceCapability, language: 'zh-CN' | 'en' = 'zh-CN'): string {
  const reasons: Record<string, [string, string]> = {
    confirmed: ['服务已报告可用', 'Reported available by the service'],
    notSupported: ['服务明确报告不支持', 'Reported unsupported by the service'],
    notReported: ['缺少有效服务证据，能力未核验', 'Missing valid service evidence; support is unverified'],
    engineVersionUnknown: ['引擎版本未核验', 'The engine version is unverified'],
    prefixEngineTooOld: ['固定前缀需要引擎 0.1.40.2 或更新版本', 'Fixed prefixes require engine 0.1.40.2 or newer'],
    residentUnverified: ['当前引擎的实际启动参数未核验；保存配置不能证明已生效', 'The resident engine startup is unverified; saved settings do not prove live support'],
    promptCacheTooSmall: ['当前引擎实际 --prompt-cache 需为 3 或更大', 'The resident engine needs --prompt-cache 3 or greater'],
    savedCacheNeedsRestart: ['已保存的缓存深度可满足要求，需手动重启后重新核验', 'The saved cache depth meets the requirement; restart manually and check again'],
    requiresSupportedEngineAndSingleSlot: ['当前配置需支持的引擎并使用单槽', 'The current configuration needs a supported engine and a single slot'],
    identityChanged: ['服务、引擎或加载状态已改变，请重新核验', 'The service, engine or load state changed; check again'],
  };
  return reasons[item.reason]?.[language === 'zh-CN' ? 0 : 1] ?? reasons.notReported![language === 'zh-CN' ? 0 : 1];
}
/** The shared parser used by presentation and request guards. Missing or malformed evidence stays unknown. */
export function parseServiceCapabilities(input: ServiceCapabilityInput): ServiceCapabilities {
  const health = asObject(input.health), status = asObject(input.status), engine = asObject(asObject(input.metrics).engine);
  const official = status.service === 'strata';
  const list = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
  const dialects = list(status.dialects) ? status.dialects : undefined;
  const formats = asObject(status.structured_output).formats;
  const parallel = asObject(asObject(input.metrics).live).parallel ?? asObject(status.concurrency).serving;
  const item = (id: ServiceCapabilityId, state: CapabilityState, reason: string, source: string): ServiceCapability => ({ id, state, reason, source });
  const declared = (id: ServiceCapabilityId, value: unknown, source: string) => item(id, value === true ? 'available' : value === false ? 'unavailable' : 'unknown', value === true ? 'confirmed' : value === false ? 'notSupported' : 'notReported', source);
  const protocol = (id: ServiceCapabilityId, path: string) => declared(id, official && dialects ? dialects.includes(path) : undefined, '/v1/status.dialects');
  const chat = protocol('chat', '/v1/chat/completions');
  const json = (id: ServiceCapabilityId, format?: string) => declared(id, chat.state === 'unavailable' ? false : chat.state !== 'available' || !list(formats) ? undefined : format ? formats.includes(format) : formats.some(value => value === 'json_object' || value === 'json_schema'), '/v1/status.structured_output.formats');
  const runtime = input.runtime;
  const verified = runtime?.verified === true && safeInteger(runtime.pid, 1) && safeInteger(runtime.startedAt, 1) && (input.engineIdentity === undefined || !!input.engineIdentity && runtime.pid === input.engineIdentity.pid && runtime.startedAt === input.engineIdentity.startedAt);
  const version = prefixVersion(engine.version ?? status.engine);
  let prefix: ServiceCapability;
  if (chat.state !== 'available') prefix = item('prefix', chat.state, chat.reason, '/v1/status.dialects');
  else if (version === undefined) prefix = item('prefix', 'unknown', 'engineVersionUnknown', '/metrics.engine.version');
  else if (!version) prefix = item('prefix', 'unavailable', 'prefixEngineTooOld', '/metrics.engine.version');
  else if (!verified || !safeInteger(runtime?.promptCache)) prefix = item('prefix', 'unknown', 'residentUnverified', 'resident argv');
  else if (runtime.promptCache! >= 3) prefix = item('prefix', 'available', 'confirmed', 'resident argv + /metrics');
  else if (safeInteger(input.configuredPromptCache, 3)) prefix = item('prefix', 'restartRequired', 'savedCacheNeedsRestart', 'saved argv compared with resident argv');
  else prefix = item('prefix', 'unavailable', 'promptCacheTooSmall', 'resident argv');
  const bias = chat.state !== 'available' ? item('logitBias', chat.state, chat.reason, '/v1/status.dialects')
    : engine.logit_bias === 0 || engine.logit_bias === false ? item('logitBias', 'unavailable', 'notSupported', '/metrics.engine.logit_bias')
    : engine.logit_bias !== 1 && engine.logit_bias !== true || !safeInteger(parallel, 1) ? item('logitBias', 'unknown', 'notReported', '/metrics.engine + concurrency')
    : item('logitBias', parallel <= 1 ? 'available' : 'unavailable', parallel <= 1 ? 'confirmed' : 'requiresSupportedEngineAndSingleSlot', '/metrics.engine + concurrency');
  const vocab = engine.vocab ?? engine.vocab_size;
  const items = [chat, protocol('messages', '/v1/messages'), protocol('responses', '/v1/responses'),
    declared('images', health.service === 'strata' ? health.images : undefined, '/health.images'),
    declared('tools', official ? status.tools ?? status.tool_calling : undefined, '/v1/status'),
    json('json'), json('jsonObject', 'json_object'), json('jsonSchema', 'json_schema'), prefix, bias,
    { ...chat, id: 'sampling' as const }, { ...chat, id: 'stops' as const }];
  return { sampledAt: input.sampledAt ?? Date.now(), profileId: input.profileId,
    pid: verified && input.evidenceCurrent !== false ? runtime.pid! : null, startedAt: verified && input.evidenceCurrent !== false ? runtime.startedAt! : null,
    runtimeVersion: typeof engine.version === 'string' ? engine.version : typeof status.engine === 'string' ? status.engine : typeof health.engine === 'string' ? health.engine : null,
    ...(safeInteger(vocab, 1) ? { vocabularySize: vocab } : {}),
    items: input.evidenceCurrent === false ? items.map(value => ({ ...value, state: 'unknown', reason: 'identityChanged' })) : items,
  };
}

const liveTransport: ServiceCapabilityTransport = {
  read: request,
  runtime: profile => isDesktop() ? getChatRuntimeEvidence(profile.id) : Promise.resolve(undefined),
  configuration: profile => isDesktop() ? readConfig(profile) : Promise.resolve(undefined),
  identity: async profile => {
    if (!isDesktop()) return undefined;
    const [process, engine] = await Promise.all([serviceStatus(profile.id, profile), benchmarkIdentity(profile).catch(() => undefined)]);
    return { running: process.running, pid: process.pid, startedAt: process.startedAt, engine: engine?.engineProcess ?? null };
  },
};
/** Compare PID and creation time together, including a loss of previously known evidence. */
export function sameServiceCapabilityIdentity(a: ServiceCapabilityIdentity | undefined, b: ServiceCapabilityIdentity | undefined): boolean {
  if (!a || !b) return a === b;
  return (['running', 'pid', 'startedAt', 'service', 'loaded', 'model', 'version'] as const).every(key => a[key] === b[key])
    && a.engine?.pid === b.engine?.pid && a.engine?.startedAt === b.engine?.startedAt;
}
async function sampleIdentity(profile: ServiceProfile, io: ServiceCapabilityTransport) {
  const values = await Promise.allSettled([io.read(profile, '/health'), io.read(profile, '/v1/status'), io.identity?.(profile)]);
  const value = (i: number) => values[i]?.status === 'fulfilled' ? values[i].value : undefined;
  const health = asObject(value(0)), status = asObject(value(1));
  const native = value(2) as ServiceCapabilityIdentity | undefined;
  const identity: ServiceCapabilityIdentity = { ...native,
    service: typeof health.service === 'string' ? health.service : typeof status.service === 'string' ? status.service : undefined,
    loaded: typeof health.loaded === 'boolean' ? health.loaded : typeof status.loaded === 'boolean' ? status.loaded : undefined,
    model: typeof health.model === 'string' ? health.model : typeof status.model === 'string' ? status.model : undefined,
    version: typeof status.engine === 'string' && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(status.engine) ? status.engine : undefined,
  };
  return { identity, health, status };
}
/** Lightweight read-only identity refresh for a displayed snapshot; never generates or changes lifecycle. */
export async function readServiceCapabilityIdentity(profile: ServiceProfile, io: ServiceCapabilityTransport = liveTransport): Promise<ServiceCapabilityIdentity> {
  return (await sampleIdentity(profile, io)).identity;
}
/** A fresh bracketed sample, shared by chat, API verification and capability presentation. */
export async function readServiceCapabilities(profile: ServiceProfile, options: { configuredPromptCache?: number } = {}, io: ServiceCapabilityTransport = liveTransport): Promise<ServiceCapabilities> {
  const before = await sampleIdentity(profile, io);
  const values = await Promise.allSettled([io.read(profile, '/metrics'), io.runtime?.(profile), options.configuredPromptCache === undefined ? io.configuration?.(profile) : undefined]);
  const value = (i: number) => values[i]?.status === 'fulfilled' ? values[i].value : undefined;
  const after = await sampleIdentity(profile, io);
  const consistent = (sample: typeof before) => !(typeof sample.health.service === 'string' && typeof sample.status.service === 'string' && sample.health.service !== sample.status.service)
    && !(typeof sample.health.loaded === 'boolean' && typeof sample.status.loaded === 'boolean' && sample.health.loaded !== sample.status.loaded)
    && !(typeof sample.health.model === 'string' && typeof sample.status.model === 'string' && sample.health.model !== sample.status.model);
  const evidenceCurrent = before.identity.running !== false && after.identity.running !== false && sameServiceCapabilityIdentity(before.identity, after.identity) && consistent(before) && consistent(after);
  return { ...parseServiceCapabilities({ profileId: profile.id, health: before.health, status: before.status, metrics: value(0), runtime: value(1) as ChatRuntimeEvidence | undefined,
    configuredPromptCache: options.configuredPromptCache ?? configuredPromptCache(value(2)), engineIdentity: io.identity ? safeInteger(before.identity.pid, 1) && safeInteger(before.identity.startedAt, 1) && safeInteger(after.identity.pid, 1) && safeInteger(after.identity.startedAt, 1) ? after.identity.engine ?? null : null : undefined, evidenceCurrent }),
    evidenceCurrent, identity: after.identity };
}
