import { request } from './bridge';
import { asObject, normalizeError, StrataError } from './errors';
import type { JsonObject, ServiceProfile } from './types';

const nonnegative = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export interface VramResizeResult {
  state: 'applied' | 'deferred';
  reserveMiB: number | null;
  freeMiB: number | null;
  expertCacheMiB: number | null;
  fullExpertCacheMiB: number | null;
  reserveMet: boolean | null;
  fullyRestored: boolean | null;
}

/** reserve_mib is free VRAM on the whole card, rather than the amount to release. */
export async function resizeRuntimeVram(profile: ServiceProfile, reserveMiB: number | null): Promise<VramResizeResult> {
  if (reserveMiB !== null && count(reserveMiB) === null) throw new StrataError('INVALID_VRAM_RESERVE', '保留显存必须为非负整数 MiB');
  const response = await request(profile, '/v1/vram', 'POST', { reserve_mib: reserveMiB });
  if (response.status !== 'ok' && response.status !== 'not loaded') throw new StrataError('INVALID_CONTROL_RESPONSE', '服务未返回可核验的显存操作结果', null, response);
  const reserve = nonnegative(response.reserve_mib) ?? reserveMiB;
  const free = nonnegative(response.vram_free_mib);
  const cache = nonnegative(response.expert_cache_mib), full = nonnegative(response.expert_cache_full_mib);
  const applied = response.status === 'ok';
  return { state: applied ? 'applied' : 'deferred', reserveMiB: reserve, freeMiB: free, expertCacheMiB: cache, fullExpertCacheMiB: full,
    reserveMet: applied && reserve !== null && free !== null ? free >= reserve : null,
    fullyRestored: applied && cache !== null && full !== null ? cache >= full : null };
}

/** Mirrors upstream slot_filename_problem, including its cross-platform Windows device checks. */
export function validateSessionFilename(filename: string): void {
  const invalidUnicode = [...filename].some(char => { const point = char.codePointAt(0)!; return point >= 0xd800 && point <= 0xdfff; });
  const stem = filename.split('.')[0]!.replace(/ +$/, '').toLowerCase();
  if (!filename || invalidUnicode || new TextEncoder().encode(filename).length > 200 || /[\x00-\x1f\x7f/\\:*?"<>|]/.test(filename)
    || filename.startsWith('.') || /[. ]$/.test(filename) || /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/.test(stem)) {
    throw new StrataError('INVALID_SESSION_FILENAME', '请输入保存目录内的普通文件名（最多 200 字节，不含路径、控制字符或 Windows 设备名）');
  }
}

export interface SessionStorageCapability {
  state: 'available' | 'unsupported' | 'unknown';
  reason: string;
}

/**
 * Upstream validates an empty filename before FIFO admission, engine commands or file I/O.
 * Its specific 400 proves the configured endpoint is present, not that a particular engine
 * build/platform can serialize a session. Actual operations remain experimental until verified.
 */
export async function probeSessionStorage(profile: ServiceProfile): Promise<SessionStorageCapability> {
  try {
    await request(profile, '/slots/0?action=save', 'POST', { filename: '' });
    return { state: 'unknown', reason: '服务未按官方协议拒绝空文件名，未开放会话存档操作' };
  } catch (error) {
    const failure = normalizeError(error);
    if (failure.status === 400 && /filename\s+must be a non-empty string/i.test(failure.message)) return { state: 'available', reason: failure.message };
    return { state: failure.status === 501 || failure.status === 404 ? 'unsupported' : 'unknown', reason: failure.message };
  }
}

export interface SessionStorageResult { action: 'save' | 'restore'; filename: string; tokens: number; bytes: number; elapsedMs: number | null }

export async function operateSessionStorage(profile: ServiceProfile, action: 'save' | 'restore', filename: string): Promise<SessionStorageResult> {
  if (action !== 'save' && action !== 'restore') throw new StrataError('INVALID_SESSION_ACTION', '会话操作只能保存或恢复');
  validateSessionFilename(filename);
  const response = await request(profile, `/slots/0?action=${action}`, 'POST', { filename });
  const tokens = count(response[action === 'save' ? 'n_saved' : 'n_restored']);
  const bytes = count(response[action === 'save' ? 'n_written' : 'n_read']);
  if (response.id_slot !== 0 || response.filename !== filename || tokens === null || bytes === null) {
    throw new StrataError('INVALID_CONTROL_RESPONSE', '服务未返回可核验的会话操作结果；未自动重试', null, response);
  }
  return { action, filename, tokens, bytes, elapsedMs: nonnegative(asObject(response.timings)[action === 'save' ? 'save_ms' : 'restore_ms']) };
}

export interface RuntimeOperationFailure {
  message: string;
  status: number | null;
  kind: string | null;
  published: boolean;
  unsupported: boolean;
  needsReload: boolean;
}

export function describeRuntimeOperationFailure(error: unknown): RuntimeOperationFailure {
  const failure = normalizeError(error), details = asObject(asObject(failure.details).error);
  // This exact runtime refusal describes an incompatible cache mode, not an
  // invalid reserve value or a failed GPU. Keep other 400 responses unchanged.
  const residentLowRam = failure.status === 400 && /^VRAM:\s*not with the resident low-RAM mode \(the cache holds experts RAM does not\)$/i.test(failure.message.trim());
  return { message: failure.message, status: failure.status, kind: residentLowRam ? 'vram-resident-low-ram' : typeof details.kind === 'string' ? details.kind : null,
    published: details.published === true,
    unsupported: residentLowRam || failure.status === 501 || (failure.status === 400 && /not (?:supported|with|available)|unsupported|disabled|needs an engine started|not implemented/i.test(failure.message)),
    needsReload: /driver refused to release|refilling the cache failed/i.test(failure.message) };
}

export interface RuntimeSlot {
  id: number;
  state: string;
  promptTokens: number | null;
  generatedTokens: number | null;
  heldTokens: number | null;
  tokS: number | null;
  elapsedS: number | null;
  context: number | null;
  usedContext: number | null;
}

/** No synthetic slot/zero when an older engine does not publish live.slots. */
export function runtimeSlots(raw: JsonObject): RuntimeSlot[] | null {
  const live = asObject(raw.live);
  if (!Array.isArray(live.slots)) return null;
  const context = count(asObject(raw.engine).max_context), seen = new Set<number>();
  return live.slots.flatMap(value => {
    const slot = asObject(value), id = count(slot.slot);
    if (id === null || seen.has(id)) return [];
    seen.add(id);
    const prompt = count(slot.prompt_tokens), generated = count(slot.generated), held = count(slot.held_tokens);
    const state = typeof slot.state === 'string' ? slot.state : 'unknown';
    return [{ id, state, promptTokens: prompt, generatedTokens: generated, heldTokens: held, tokS: nonnegative(slot.tok_s), elapsedS: nonnegative(slot.elapsed_s),
      context, usedContext: state === 'idle' ? held : prompt !== null && generated !== null ? prompt + generated : null }];
  });
}

export function requestPrefillTokS(value: JsonObject): number | null {
  const prompt = count(value.prompt_tokens), reused = count(value.reused), ms = nonnegative(value.prompt_ms);
  // An absent reuse count is unknown, rather than a measured zero.
  if (prompt === null || reused === null || ms === null || ms <= 0) return null;
  const fresh = Math.max(0, prompt - reused);
  return fresh > 0 ? fresh * 1000 / ms : null;
}
