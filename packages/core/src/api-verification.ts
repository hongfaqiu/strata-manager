import { request, streamChat } from './bridge';
import { normalizeError, StrataError } from './errors';
import type { ChatDelta } from './chat';
import type { JsonObject, ServiceProfile } from './types';
import { readServiceCapabilities, readServiceCapabilityIdentity, sameServiceCapabilityIdentity, serviceCapability, type ServiceCapability, type ServiceCapabilityIdentity, type ServiceCapabilityTransport } from './service-capabilities';

export type ApiVerificationKind = 'text' | 'tools' | 'vision';
export type ApiVerificationStage = 'health' | 'models' | 'capabilities' | 'inference';
export interface ApiVerificationStep {
  stage: ApiVerificationStage;
  state: 'running' | 'passed' | 'failed' | 'cancelled';
  code?: string;
  httpStatus?: number;
  elapsedMs: number;
}
/** Transient results intentionally exclude keys, prompts, responses and tool arguments. */
export interface ApiVerificationReport {
  profileId: string;
  kind: ApiVerificationKind;
  model: string | null;
  startedAt: number;
  elapsedMs: number;
  state: 'passed' | 'failed' | 'cancelled';
  steps: ApiVerificationStep[];
  /** Only fixed capability IDs/states/reason codes; excludes arbitrary upstream metadata. */
  capabilities?: ServiceCapability[];
  identity?: ServiceCapabilityIdentity;
}
export interface ApiVerificationOptions { kind: ApiVerificationKind; model?: string; ready: boolean }
export interface ApiVerificationTransport {
  identity?: ServiceCapabilityTransport['identity'];
  read: (profile: ServiceProfile, path: string) => Promise<unknown>;
  stream: (profile: ServiceProfile, body: JsonObject, onDelta: (delta: ChatDelta) => void, signal: AbortSignal) => Promise<void>;
}
const transport: ApiVerificationTransport = { read: request, stream: streamChat };
const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const fail = (code: string): never => { throw new StrataError(code, code); };
// 32×32 solid red PNG; generated fixture, no user files or network assets.
export const API_VERIFICATION_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==';

function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new StrataError('CANCELLED', 'CANCELLED'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new StrataError('CANCELLED', 'CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Explicit, bounded checks against an already-ready service. Never starts or loads it. */
export async function verifyApi(
  profile: ServiceProfile, options: ApiVerificationOptions,
  onProgress?: (step: ApiVerificationStep) => void, signal?: AbortSignal,
  io: ApiVerificationTransport = transport,
): Promise<ApiVerificationReport> {
  const startedAt = Date.now(), began = performance.now();
  const report: ApiVerificationReport = { profileId: profile.id, kind: options.kind, model: null, startedAt, elapsedMs: 0, state: 'failed', steps: [] };
  const controller = new AbortController();
  let timedOut = false, stage: ApiVerificationStage = 'health', stageAt = performance.now();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 60_000);
  const update = (state: ApiVerificationStep['state'], code?: string, httpStatus?: number) => {
    const step: ApiVerificationStep = { stage, state, elapsedMs: Math.max(0, performance.now() - stageAt), ...(code ? { code } : {}), ...(httpStatus ? { httpStatus } : {}) };
    if (state !== 'running') report.steps.push(step);
    onProgress?.(step);
  };
  const read = (path: string) => bounded(io.read(profile, path), controller.signal);
  const health = async (): Promise<JsonObject> => {
    const value = object(await read('/health'));
    if (value.service !== 'strata' || value.status !== 'ok') fail('VERIFICATION_IDENTITY');
    if (value.loaded !== true) fail('VERIFICATION_NOT_READY');
    return value;
  };
  try {
    if (controller.signal.aborted) fail('CANCELLED');
    if (!options.ready) fail('VERIFICATION_NOT_READY');
    if (!['text', 'tools', 'vision'].includes(options.kind)) fail('VERIFICATION_KIND');
    update('running');
    const initialHealth = await health();
    update('passed'); stage = 'models'; stageAt = performance.now(); update('running');
    const listing = object(await read('/v1/models'));
    const ids = Array.isArray(listing.data) ? listing.data.map(item => object(item).id).filter((id): id is string => typeof id === 'string' && !!id.trim()) : [];
    const model = options.model?.trim() || (typeof initialHealth.model === 'string' ? initialHealth.model : '') || (ids.length === 1 ? ids[0] ?? '' : '');
    if (!model || !ids.includes(model)) fail('VERIFICATION_MODEL_MISSING');
    if (typeof initialHealth.model === 'string' && initialHealth.model !== model) fail('VERIFICATION_MODEL_CHANGED');
    report.model = model; update('passed'); stage = 'capabilities'; stageAt = performance.now(); update('running');
    const evidence = await bounded(io === transport ? readServiceCapabilities(profile) : readServiceCapabilities(profile, {}, { read: (_profile, path) => read(path), identity: io.identity }), controller.signal);
    report.capabilities = evidence.items;
    report.identity = evidence.identity;
    if (evidence.identity?.model && evidence.identity.model !== model) fail('VERIFICATION_MODEL_CHANGED');
    if (evidence.evidenceCurrent === false) fail('VERIFICATION_IDENTITY_CHANGED');
    const chat = serviceCapability(evidence, 'chat');
    const feature = serviceCapability(evidence, options.kind === 'tools' ? 'tools' : options.kind === 'vision' ? 'images' : 'chat');
    if (chat.state === 'unavailable' || feature.state === 'unavailable' || feature.state === 'restartRequired') fail(options.kind === 'vision' ? 'VERIFICATION_VISION_UNAVAILABLE' : 'VERIFICATION_CAPABILITY_UNAVAILABLE');
    // Unknown metadata is preserved. This explicit bounded test can collect one-run evidence,
    // but never promotes a missing metadata field into blanket support.
    update('passed'); stage = 'inference'; stageAt = performance.now(); update('running');
    // Re-check immediately before inference: an unloaded service must not be lazily loaded by a test.
    const current = await health();
    if (typeof current.model === 'string' && current.model !== model) fail('VERIFICATION_MODEL_CHANGED');
    if (options.kind === 'vision' && current.images !== true) fail('VERIFICATION_VISION_UNAVAILABLE');
    if (controller.signal.aborted) fail('CANCELLED');
    const body: JsonObject = { model, stream: true, max_tokens: 256, reasoning_effort: 'off', temperature: 0, strata_mcp: false,
      messages: [{ role: 'user', content: 'Reply exactly STRATA_API_OK.' }] };
    if (options.kind === 'tools') {
      body.messages = [{ role: 'user', content: 'Call strata_api_check with value "strata-ok". Do not answer with text.' }];
      body.tools = [{ type: 'function', function: { name: 'strata_api_check', description: 'Return a verification value. This function is never executed.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } }];
      body.tool_choice = { type: 'function', function: { name: 'strata_api_check' } };
    } else if (options.kind === 'vision') body.messages = [{ role: 'user', content: [{ type: 'text', text: 'What is the dominant color of this image? Reply with one English word.' }, { type: 'image_url', image_url: { url: API_VERIFICATION_IMAGE } }] }];
    let content = '', finish = '', mcp = false;
    const calls = new Map<string, { id: string; name: string; arguments: string; type: string }>();
    await bounded(io.stream(profile, body, delta => {
      if (controller.signal.aborted) return;
      if (delta.content) content = (content + delta.content).slice(0, 8192);
      if (delta.error) fail('VERIFICATION_RESPONSE');
      if (delta.finishReason) finish = delta.finishReason;
      if (delta.tool) {
        const raw = object(delta.tool.raw);
        if (raw.event !== undefined || delta.tool.round !== undefined || delta.tool.result !== undefined) { mcp = true; return; }
        const fn = object(raw.function), slot = typeof raw.index === 'number' ? String(raw.index) : typeof raw.id === 'string' ? raw.id : '0';
        const call = calls.get(slot) ?? { id: '', name: '', arguments: '', type: '' };
        if (typeof raw.id === 'string') call.id = raw.id;
        if (typeof raw.type === 'string') call.type = raw.type;
        if (typeof fn.name === 'string') call.name += fn.name;
        if (typeof fn.arguments === 'string') call.arguments = (call.arguments + fn.arguments).slice(0, 8192);
        calls.set(slot, call);
      }
    }, controller.signal), controller.signal);
    if (controller.signal.aborted) fail('CANCELLED');
    if (mcp) fail('VERIFICATION_UNEXPECTED_MCP');
    if (finish === 'length') fail('VERIFICATION_TRUNCATED');
    if (options.kind === 'tools') {
      if (finish !== 'tool_calls' || calls.size !== 1) fail('VERIFICATION_TOOL_STRUCTURE');
      const call = [...calls.values()][0]!;
      let args: JsonObject;
      try { args = object(JSON.parse(call.arguments)); } catch { return fail('VERIFICATION_TOOL_STRUCTURE'); }
      if (!call.id || call.type !== 'function' || call.name !== 'strata_api_check' || args.value !== 'strata-ok' || Object.keys(args).length !== 1) fail('VERIFICATION_TOOL_STRUCTURE');
    } else if (calls.size || (options.kind === 'text' ? !content.includes('STRATA_API_OK') : !/\bred\b|红/i.test(content))) fail('VERIFICATION_RESPONSE');
    const finalIdentity = await bounded(io === transport ? readServiceCapabilityIdentity(profile) : readServiceCapabilityIdentity(profile, { read: (_profile, path) => read(path), identity: io.identity }), controller.signal);
    if (!sameServiceCapabilityIdentity(report.identity, finalIdentity)) {
      report.capabilities = report.capabilities.map(item => ({ ...item, state: 'unknown', reason: 'identityChanged' }));
      fail('VERIFICATION_IDENTITY_CHANGED');
    }
    update('passed'); report.state = 'passed';
  } catch (cause) {
    const error = normalizeError(cause);
    const cancelled = controller.signal.aborted && !timedOut;
    // Never expose arbitrary upstream error bodies, which can echo credentials or requests.
    const code = timedOut ? 'VERIFICATION_TIMEOUT' : cancelled ? 'CANCELLED' : /^VERIFICATION_[A-Z_]+$/.test(error.code) ? error.code : error.status === 401 || error.status === 403 ? 'VERIFICATION_AUTH' : error.status === 404 ? 'VERIFICATION_NOT_FOUND' : 'VERIFICATION_TRANSPORT';
    update(cancelled ? 'cancelled' : 'failed', code, error.status ?? undefined);
    report.state = cancelled ? 'cancelled' : 'failed';
  } finally {
    clearTimeout(timeout); signal?.removeEventListener('abort', abort);
    report.elapsedMs = Math.max(0, performance.now() - began);
  }
  return report;
}
