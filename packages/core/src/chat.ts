import type { Attachment, ChatMessage, JsonObject, ToolEvent } from './types';
import { asObject, StrataError } from './errors';

export interface ChatOptions {
  model: string;
  reasoningEffort: 'off' | 'low' | 'medium' | 'high';
  temperature: number; topP: number; maxTokens: number;
  systemPrompt: string; mcp: boolean;
  topK?: number;
  /** null or undefined uses the upstream random seed. */
  seed?: number | null;
  /** Set only when /metrics engine.cvec confirms the projection vector is loaded. */
  experimentalSpeedProjection?: boolean;
  /** Set only after /health reports images:true. */
  images?: boolean;
}
export interface StreamToolEvent extends ToolEvent {
  id?: string; server?: string; tool?: string; arguments?: unknown; result?: string;
  round?: number; at?: number; ok?: boolean; skipped?: boolean; raw?: JsonObject;
}
export interface ChatDelta {
  content?: string; reasoning?: string; tool?: StreamToolEvent; usage?: JsonObject; done?: boolean; error?: string;
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
  const api: JsonObject[] = options.systemPrompt.trim() ? [{ role: 'system', content: options.systemPrompt }] : [];
  for (const message of messages) api.push(...(message.role === 'assistant' ? assistantMessages(message) : [userMessage(message, options)]));
  return { model: options.model, messages: api, stream: true, ...sampling, ...(options.mcp ? { strata_mcp: true } : {}) };
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
  if (chunk.usage) output.push({ usage: asObject(chunk.usage) });
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
