import type { Attachment, ChatMessage, JsonObject, ToolEvent } from './types';
import { asObject, StrataError } from './errors';
import { configuredPromptCache, describeServiceCapability, parseServiceCapabilities, serviceCapability, type ServiceCapabilities, type ServiceCapability, type ServiceCapabilityId } from './service-capabilities';

export interface ChatOptions {
  model: string;
  reasoningEffort: 'off' | 'low' | 'medium' | 'high';
  /**
   * Hard cap on thinking tokens. null/undefined/0 means no cap (the server's own default applies).
   * Sent as Strata's `reasoning_budget_tokens` and llama-server's `thinking_budget_tokens`; ignored when thinking is off.
   */
  thinkingBudgetTokens?: number | null;
  temperature: number; topP: number; maxTokens: number;
  systemPrompt: string; mcp: boolean;
  topK?: number;
  /** null or undefined uses the upstream random seed. */
  seed?: number | null;
  /** Set only when /metrics engine.cvec confirms the projection vector is loaded. */
  experimentalSpeedProjection?: boolean;
  /** Set only after /health reports images:true. */
  images?: boolean;
  /** Request-local options. They never become /settings defaults. */
  advanced?: AdvancedChatOptions;
  /** Identify the document by message ID, never by matching its text. */
  fixedPrefix?: { messageId: string; chars?: number };
  /** Inject fresh service evidence when sending; do not trust persisted evidence. */
  capabilities?: ChatCapabilities;
}
export interface AdvancedChatOptions {
  responseFormat?: 'text' | 'json_object' | 'json_schema';
  schemaName?: string;
  schemaText?: string;
  minP?: number;
  stop?: string[];
  repetitionPenalty?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  penaltyLastN?: number;
  logitBiasText?: string;
}
export interface ChatCapabilities {
  /** Additive four-state evidence; legacy manually constructed capabilities remain readable. */
  states?: Partial<Record<ServiceCapabilityId, ServiceCapability>>;
  structuredFormats: ('json_object' | 'json_schema')[];
  sampling: boolean;
  stops: boolean;
  prefix: boolean;
  logitBias: boolean;
  vocabularySize?: number;
  prefixReason: string;
}
/** Fresh native process evidence from the Supervisor, never persisted UI options. */
export interface ChatRuntimeEvidence { verified: boolean; promptCache?: number; pid?: number; startedAt?: number }
const record = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
/** Only metadata reads; never test a feature by generating or changing the model. */
export function parseChatCapabilities(status: unknown, metrics?: unknown, config?: unknown, runtimeEvidence?: ChatRuntimeEvidence): ChatCapabilities {
  return chatCapabilitiesFromService(parseServiceCapabilities({ profileId: '', status, metrics, runtime: runtimeEvidence, configuredPromptCache: configuredPromptCache(config) }));
}
export function chatCapabilitiesFromService(evidence: ServiceCapabilities): ChatCapabilities {
  const available = (id: ServiceCapabilityId) => serviceCapability(evidence, id).state === 'available';
  return { states: Object.fromEntries(evidence.items.map(item => [item.id, item])),
    structuredFormats: [ ...(available('jsonObject') ? ['json_object' as const] : []), ...(available('jsonSchema') ? ['json_schema' as const] : []) ],
    sampling: available('sampling'), stops: available('stops'), prefix: available('prefix'), logitBias: available('logitBias'),
    ...(evidence.vocabularySize ? { vocabularySize: evidence.vocabularySize } : {}),
    prefixReason: available('prefix') ? '' : describeServiceCapability(serviceCapability(evidence, 'prefix')),
  };
}
function invalid(message: string): never { throw new StrataError('INVALID_CHAT_OPTIONS', message); }
function supported(ok: boolean | undefined, feature: string, evidence?: ServiceCapability): void {
  if (ok && (!evidence || evidence.state === 'available')) return;
  const code = evidence?.state === 'restartRequired' ? 'CHAT_FEATURE_RESTART_REQUIRED' : !evidence || evidence.state === 'unknown' ? 'CHAT_FEATURE_UNVERIFIED' : 'CHAT_FEATURE_UNSUPPORTED';
  throw new StrataError(code, `${feature}：${evidence ? describeServiceCapability(evidence) : '当前服务未确认支持此设置，请刷新服务能力或移除此设置'}`);
}
/** JSON syntax and upstream root/reference rules; full metaschema/output validation is the server's job. */
export function parseChatSchema(text: string): JsonObject {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return invalid('JSON Schema 不是有效 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('JSON Schema 必须为对象');
  const root = value as JsonObject;
  const resolve = (ref: string): unknown => {
    let target: unknown = root;
    for (const part of ref.slice(1).split('/').slice(1)) { const key = part.replace(/~1/g, '/').replace(/~0/g, '~'); if (!target || typeof target !== 'object' || Array.isArray(target)) return undefined; target = (target as JsonObject)[key]; }
    return target;
  };
  const onlyObjects = (node: unknown, refs: string[] = []): boolean => {
    const n = record(node); if (n.type === 'object') return true;
    if (typeof n.$ref === 'string' && n.$ref.startsWith('#') && !refs.includes(n.$ref) && onlyObjects(resolve(n.$ref), [...refs, n.$ref])) return true;
    for (const key of ['anyOf', 'oneOf']) if (Array.isArray(n[key]) && n[key].length && n[key].every(branch => onlyObjects(branch, refs))) return true;
    return Array.isArray(n.allOf) && n.allOf.some(branch => onlyObjects(branch, refs));
  };
  const walk = (node: unknown, depth = 0): void => {
    if (depth > 100) invalid('JSON Schema 嵌套过深');
    if (Array.isArray(node)) { node.forEach(child => walk(child, depth + 1)); return; }
    if (typeof node === 'number' && !Number.isFinite(node)) invalid('JSON Schema 数值必须有限');
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if ((key === '$ref' || key === '$dynamicRef') && (typeof child !== 'string' || !child.startsWith('#'))) invalid('JSON Schema 只允许本地 # 引用');
      if (key === '$ref' && resolve(child as string) === undefined) invalid('JSON Schema 本地引用不存在');
      walk(child, depth + 1);
    }
  };
  walk(root); if (!onlyObjects(root)) invalid('JSON Schema 根类型必须只接受对象');
  return root;
}
export function parseChatLogitBias(text: string, vocabularySize?: number): JsonObject {
  let value: unknown; try { value = JSON.parse(text); } catch { return invalid('logit_bias 不是有效 JSON'); }
  if (!Array.isArray(value) && (!value || typeof value !== 'object')) return invalid('logit_bias 需为对象或 [token_id, bias] 列表');
  const pairs = Array.isArray(value), entries: unknown[] = Array.isArray(value) ? value : Object.entries(value as JsonObject);
  const out: JsonObject = {};
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) invalid('logit_bias 每项需包含 token ID 与偏置');
    const [id, raw] = entry;
    if ((typeof id !== 'number' && typeof id !== 'string') || !/^\d+$/.test(String(id))) invalid('logit_bias token ID 需为非负整数');
    const token = Number(id);
    if (!Number.isSafeInteger(token) || token > 2147483647 || (vocabularySize !== undefined && token >= vocabularySize)) invalid('logit_bias token ID 超出词表范围');
    if (Object.hasOwn(out, String(token))) invalid('logit_bias 包含重复 token ID');
    const bias = pairs && raw === false ? -100 : raw;
    if (typeof bias !== 'number' || !Number.isFinite(bias) || bias < -100 || bias > 100) invalid('logit_bias 偏置需在 -100 到 100');
    out[String(token)] = bias;
  }
  if (vocabularySize !== undefined && Object.values(out).filter(v => v === -100).length === vocabularySize) invalid('logit_bias 不能禁止整个词表');
  return out;
}
/** Validate before applying settings, and again immediately before sending. */
export function buildAdvancedChatFields(options: ChatOptions): JsonObject {
  const a = options.advanced ?? {}, caps = options.capabilities, out: JsonObject = {};
  const number = (value: unknown, key: string, min: number, max = Infinity, strict = false): void => {
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || (strict ? value <= min : value < min) || value > max) invalid(`${key} 数值范围无效`);
    supported(caps?.sampling, key, caps?.states?.sampling); out[key] = value;
  };
  number(a.minP, 'min_p', 0, 1); number(a.repetitionPenalty, 'repetition_penalty', 0, Infinity, true);
  number(a.presencePenalty, 'presence_penalty', 0); number(a.frequencyPenalty, 'frequency_penalty', 0);
  if (a.penaltyLastN !== undefined) { if (!Number.isSafeInteger(a.penaltyLastN) || a.penaltyLastN < 0) invalid('penalty_last_n 需为非负整数'); supported(caps?.sampling, 'penalty_last_n', caps?.states?.sampling); out.penalty_last_n = a.penaltyLastN; }
  if (a.stop !== undefined) { if (!Array.isArray(a.stop) || a.stop.length > 4 || a.stop.some(s => typeof s !== 'string' || !s.length)) invalid('stop 需为最多 4 个非空字符串'); if (a.stop.length) { supported(caps?.stops, 'stop', caps?.states?.stops); out.stop = a.stop; } }
  if (a.logitBiasText?.trim()) { const bias = parseChatLogitBias(a.logitBiasText, caps?.vocabularySize); if (Object.keys(bias).length) { supported(caps?.logitBias, 'logit_bias（需支持的引擎且关闭连续批处理）', caps?.states?.logitBias); out.logit_bias = bias; } }
  const format = a.responseFormat ?? 'text';
  if (!['text', 'json_object', 'json_schema'].includes(format)) invalid('输出格式无效');
  if (format !== 'text') {
    supported(caps?.structuredFormats.includes(format), format, caps?.states?.[format === 'json_schema' ? 'jsonSchema' : 'jsonObject']);
    if (options.mcp) invalid('JSON 输出与 MCP 工具互斥，请先关闭 MCP');
    if (format === 'json_schema') { if (!a.schemaName?.trim() || a.schemaName.length > 64 || !/^[\w-]+$/.test(a.schemaName)) invalid('Schema 名称需为 1–64 个英文字母、数字、下划线或连字符'); out.response_format = { type: format, json_schema: { name: a.schemaName, strict: true, schema: parseChatSchema(a.schemaText ?? '') } }; }
    else out.response_format = { type: format };
  }
  if (options.fixedPrefix) { supported(caps?.prefix, '固定前缀', caps?.states?.prefix); if (!options.fixedPrefix.messageId || (options.fixedPrefix.chars !== undefined && (!Number.isSafeInteger(options.fixedPrefix.chars) || options.fixedPrefix.chars < 1))) invalid('固定前缀需有效消息和正整数字符边界'); }
  return out;
}
export interface StreamToolEvent extends ToolEvent {
  id?: string; server?: string; tool?: string; arguments?: unknown; result?: string;
  round?: number; at?: number; ok?: boolean; skipped?: boolean; raw?: JsonObject;
}
export interface ChatDelta {
  /** Response IDs are not interchangeable with an observer's request ID. */
  responseId?: string; serviceRequestId?: string;
  content?: string; reasoning?: string; tool?: StreamToolEvent; usage?: JsonObject; done?: boolean; error?: string;
  /** Engine timings carried by this response; never a global last-request snapshot. */
  timings?: JsonObject; finishReason?: string;
}

function fileText(file: Attachment): string {
  if (file.content.includes('\0')) throw new StrataError('UNSUPPORTED_ATTACHMENT', `${file.name} 包含二进制内容，请使用文本文件`);
  if (new TextEncoder().encode(file.content).byteLength > 512 * 1024) throw new StrataError('ATTACHMENT_TOO_LARGE', `${file.name} 超出上游 512 KB 文本附件限制`);
  const longest = Math.max(2, ...(file.content.match(/`+/g) ?? []).map(x => x.length));
  const fence = '`'.repeat(longest + 1);
  return `File: ${file.name}\n${fence}\n${file.content}\n${fence}`;
}

function userMessage(message: ChatMessage, options: ChatOptions): JsonObject {
  const attachments = message.attachments ?? [];
  if (attachments.some(a => a.type !== 'text' && a.type !== 'image')) throw new StrataError('UNSUPPORTED_ATTACHMENT', '仅支持文本文件和图片附件');
  const text = [message.content, ...attachments.filter(a => a.type === 'text').map(fileText)].filter(Boolean).join('\n\n');
  const images = attachments.filter(a => a.type === 'image');
  if (!images.length) return { role: message.role, content: text };
  if (options.images !== true) throw new StrataError('IMAGES_UNSUPPORTED', '服务未确认支持图片，请启用视觉模型并确认 /health 的 images=true');
  const parts: JsonObject[] = [{ type: 'text', text }];
  for (const image of images) {
    if (!/^image\/(png|jpeg|webp|gif)$/i.test(image.mimeType)) throw new StrataError('UNSUPPORTED_ATTACHMENT', `${image.name} 图片格式不受支持`);
    const url = image.content.startsWith('data:') ? image.content : `data:${image.mimeType};base64,${image.content}`;
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(url);
    if (!match || match[1]?.toLowerCase() !== image.mimeType.toLowerCase()) throw new StrataError('INVALID_ATTACHMENT', `${image.name} 图片内容必须为有效 base64 Data URL`);
    const encoded = (match[2] ?? '').replace(/[\r\n]/g, '');
    const bytes = Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
    if (bytes > 20e6) throw new StrataError('ATTACHMENT_TOO_LARGE', `${image.name} 超出上游 20 MB 图片限制`);
    parts.push({ type: 'image_url', image_url: { url } });
  }
  return { role: message.role, content: parts };
}

/** Mirrors official serve/web/app.js assistantMessages(): replay completed MCP rounds. */
function assistantMessages(message: ChatMessage): JsonObject[] {
  const tools = (message.tools ?? []) as StreamToolEvent[];
  const ran = tools.filter(t => t.round !== undefined && t.result !== undefined && !t.skipped && t.status !== 'skipped');
  if (!ran.length) return [{ role: 'assistant', content: message.content, ...(!message.content && message.reasoning ? { reasoning_content: message.reasoning } : {}) }];
  const out: JsonObject[] = [];
  let pos = 0;
  for (const round of new Set(ran.map(t => t.round))) {
    const calls = ran.filter(t => t.round === round);
    const at = Math.min(Math.max(pos, calls[0]?.at ?? 0), message.content.length);
    // Incomplete legacy tool metadata cannot be reconstructed safely.
    if (calls.some(t => !t.id)) throw new StrataError('TOOL_HISTORY_INCOMPLETE', '工具历史缺少调用 ID，无法重放该会话');
    out.push({ role: 'assistant', content: message.content.slice(pos, at).trim(), tool_calls: calls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.arguments ?? {}) } })) });
    for (const tool of calls) out.push({ role: 'tool', tool_call_id: tool.id, content: tool.result });
    pos = at;
  }
  const rest = message.content.slice(pos).trim();
  if (rest) out.push({ role: 'assistant', content: rest });
  return out;
}

export const MAX_THINKING_BUDGET_TOKENS = 1_000_000;
/** Request-only thinking cap. Strata reads `reasoning_budget_tokens` (and, since upstream #2141, llama.cpp's `thinking_budget_tokens`). */
export function buildThinkingBudgetFields(options: Pick<ChatOptions, 'reasoningEffort' | 'thinkingBudgetTokens'>): JsonObject {
  const budget = options.thinkingBudgetTokens;
  if (budget == null || budget === 0) return {};
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > MAX_THINKING_BUDGET_TOKENS) invalid(`思考长度上限需为 1–${MAX_THINKING_BUDGET_TOKENS} 的整数，留空表示不限`);
  if (options.reasoningEffort === 'off') return {};
  return { reasoning_budget_tokens: budget, thinking_budget_tokens: budget };
}
/** The official /settings defaults object, shared by all API clients (MCP/system prompt are not defaults). */
export function buildSharedDefaults(options: ChatOptions): JsonObject {
  if (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2 || !Number.isFinite(options.topP) || options.topP <= 0 || options.topP > 1) throw new StrataError('INVALID_CHAT_OPTIONS', 'temperature 需在 0–2，topP 需在 (0,1]');
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 0) throw new StrataError('INVALID_CHAT_OPTIONS', 'maxTokens 需为非负整数，0 使用服务默认值');
  const topK = options.topK ?? 20;
  if (!Number.isInteger(topK) || topK < 1 || topK > 64) throw new StrataError('INVALID_CHAT_OPTIONS', 'topK 需为 1–64 的整数');
  if (options.seed != null && (!Number.isSafeInteger(options.seed) || options.seed <= 0)) throw new StrataError('INVALID_CHAT_OPTIONS', 'seed 需为正整数，留空使用随机种子');
  if (!['off', 'low', 'medium', 'high'].includes(options.reasoningEffort)) throw new StrataError('INVALID_CHAT_OPTIONS', 'reasoningEffort 无效');
  if (options.experimentalSpeedProjection !== undefined && typeof options.experimentalSpeedProjection !== 'boolean') throw new StrataError('INVALID_CHAT_OPTIONS', 'experimentalSpeedProjection 需为布尔值');
  return { reasoning_effort: options.reasoningEffort === 'off' ? 'none' : options.reasoningEffort, temperature: options.temperature,
    ...(options.temperature > 0 ? { top_p: options.topP, top_k: topK } : {}), ...(options.maxTokens > 0 ? { max_tokens: options.maxTokens } : {}),
    ...(options.seed != null ? { seed: options.seed } : {}), ...(options.experimentalSpeedProjection !== undefined ? { experimental_speed_projection: options.experimentalSpeedProjection } : {}) };
}

export function buildChatRequest(messages: ChatMessage[], options: ChatOptions): JsonObject {
  if (!options.model.trim()) throw new StrataError('MODEL_REQUIRED', '请先探测服务并选择模型');
  const sampling = buildSharedDefaults(options);
  const advanced = buildAdvancedChatFields(options);
  const api: JsonObject[] = options.systemPrompt.trim() ? [{ role: 'system', content: options.systemPrompt }] : [];
  let prefixIndex = -1;
  for (const message of messages) { if (message.id === options.fixedPrefix?.messageId) { if (prefixIndex !== -1) invalid('固定前缀消息 ID 重复'); prefixIndex = api.length; if (message.role !== 'user') invalid('固定前缀必须选择用户文档消息'); } api.push(...(message.role === 'assistant' ? assistantMessages(message) : [userMessage(message, options)])); }
  if (options.fixedPrefix) {
    if (prefixIndex < 0) invalid('固定前缀消息不在当前会话，请重新选择');
    if (messages.some(m => m.attachments?.some(a => a.type === 'image'))) invalid('固定前缀不支持包含图片的请求');
    const chars = options.fixedPrefix.chars, text = api[prefixIndex]?.content;
    if (typeof text !== 'string' || !text.length) invalid('固定前缀需非空文本');
    const length = Array.from(text).length;
    if (chars !== undefined && (chars > length || (prefixIndex === api.length - 1 && chars >= length))) invalid('固定前缀字符边界需在文档内，并给问题保留内容');
    if (chars === undefined && prefixIndex === api.length - 1) invalid('固定文档之后需要一条提问；或设置文档内的字符边界');
    // prepare_format prepends a system message only when the first one is not system.
    const offset = advanced.response_format && api[0]?.role !== 'system' ? 1 : 0;
    advanced.strata_prefix = chars === undefined ? { messages: prefixIndex + 1 + offset } : { message: prefixIndex + offset, chars };
  }
  return { model: options.model, messages: api, stream: true, ...sampling, ...buildThinkingBudgetFields(options), ...advanced, ...(options.mcp ? { strata_mcp: true } : {}) };
}

/** Streaming SSE framer: CR/LF, multiline data and UTF-8 boundaries all survive arbitrary chunks. */
export class SSEParser {
  private buffer = '';
  private data: string[] = [];
  private decoder = new TextDecoder();
  constructor(private readonly onData: (data: string) => void) {}
  push(chunk: string | Uint8Array): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    this.drain(false);
  }
  finish(): void { this.buffer += this.decoder.decode(); this.drain(true); this.dispatch(); }
  private dispatch(): void { if (this.data.length) this.onData(this.data.join('\n')); this.data = []; }
  private drain(final: boolean): void {
    for (;;) {
      const match = /[\r\n]/.exec(this.buffer);
      if (!match) break;
      const i = match.index;
      if (!final && this.buffer[i] === '\r' && i === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, i);
      const count = this.buffer[i] === '\r' && this.buffer[i + 1] === '\n' ? 2 : 1;
      this.buffer = this.buffer.slice(i + count);
      this.line(line);
    }
    if (final && this.buffer) { this.line(this.buffer); this.buffer = ''; }
  }
  private line(line: string): void {
    if (!line) { this.dispatch(); return; }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
  }
}

export function decodeChatChunk(data: string): ChatDelta[] {
  if (data.trim() === '[DONE]') return [{ done: true }];
  let value: unknown;
  try { value = JSON.parse(data); } catch { throw new StrataError('INVALID_STREAM', '服务返回了无效 SSE JSON', null, data); }
  const chunk = asObject(value);
  if (chunk.error) throw new StrataError('STREAM_ERROR', typeof asObject(chunk.error).message === 'string' ? String(asObject(chunk.error).message) : String(chunk.error));
  const output: ChatDelta[] = [];
  if (typeof chunk.id === 'string' || typeof chunk.request_id === 'string') output.push({ ...(typeof chunk.id === 'string' ? { responseId: chunk.id } : {}), ...(typeof chunk.request_id === 'string' ? { serviceRequestId: chunk.request_id } : {}) });
  if (chunk.usage) output.push({ usage: asObject(chunk.usage) });
  if (chunk.timings) output.push({ timings: asObject(chunk.timings) });
  if (chunk.strata_mcp) {
    const t = asObject(chunk.strata_mcp), event = t.event;
    output.push({ tool: {
      name: typeof t.name === 'string' ? t.name : 'MCP', status: event === 'call' ? 'running' : event === 'result' ? t.skipped ? 'skipped' : t.ok ? 'done' : 'error' : String(event ?? 'unknown'),
      ...(typeof t.id === 'string' ? { id: t.id } : {}), ...(typeof t.server === 'string' ? { server: t.server } : {}), ...(typeof t.tool === 'string' ? { tool: t.tool } : {}),
      ...(typeof t.round === 'number' ? { round: t.round } : {}), ...(t.arguments !== undefined ? { arguments: t.arguments } : {}),
      ...(typeof t.text === 'string' ? { result: t.text, content: t.text } : {}), ...(typeof t.ok === 'boolean' ? { ok: t.ok } : {}), ...(typeof t.skipped === 'boolean' ? { skipped: t.skipped } : {}), raw: t,
    } });
  }
  const choice = asObject(Array.isArray(chunk.choices) ? chunk.choices[0] : undefined), delta = asObject(choice.delta);
  if (typeof choice.finish_reason === 'string') output.push({ finishReason: choice.finish_reason });
  const content = typeof delta.content === 'string' ? delta.content : undefined;
  const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : undefined;
  if (content !== undefined || reasoning !== undefined) output.push({ content, reasoning });
  // Generic tool-call deltas are also surfaced, without pretending MCP executed them.
  if (Array.isArray(delta.tool_calls)) for (const rawTool of delta.tool_calls) {
    const t = asObject(rawTool), fn = asObject(t.function);
    output.push({ tool: { name: typeof fn.name === 'string' ? fn.name : '', status: 'writing', ...(typeof t.id === 'string' ? { id: t.id } : {}), ...(typeof fn.arguments === 'string' ? { content: fn.arguments } : {}), raw: t } });
  }
  return output;
}
