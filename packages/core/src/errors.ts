import type { JsonObject } from './types';

export class StrataError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly details: unknown;
  constructor(code: string, message: string, status: number | null = null, details?: unknown) {
    super(message);
    this.name = 'StrataError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

export function normalizeError(error: unknown, status: number | null = null): StrataError {
  if (error instanceof StrataError) return error;
  if (error instanceof Error && error.name === 'AbortError') return new StrataError('CANCELLED', '请求已取消', status);
  let parsed: unknown = error;
  let text = typeof error === 'string' ? error : error instanceof Error ? error.message : undefined;
  let transportStatus: number | null = null;
  if (text !== undefined) {
    // Current native commands return "HTTP 409: <JSON>" (streams may include the reason phrase).
    const nativeHTTP = /^HTTP\s+(\d{3})(?:\s+[^:\n]+)?:\s*([\s\S]*)$/.exec(text);
    if (nativeHTTP) { transportStatus = Number(nativeHTTP[1]); text = nativeHTTP[2] ?? ''; }
    parsed = text;
    try { parsed = JSON.parse(text); } catch { /* Native errors may be plain strings. */ }
  }
  const outer = asObject(parsed);
  const inner = asObject(outer.error);
  const message = typeof inner.message === 'string' ? inner.message : typeof outer.message === 'string' ? outer.message
    : typeof outer.error === 'string' ? outer.error : outer.status === 'busy' ? '服务忙碌：仍有请求正在运行或排队' : text ?? '请求失败';
  const nativeStatus = typeof outer.status === 'number' ? outer.status : null;
  const actualStatus = status ?? nativeStatus ?? transportStatus;
  const code = typeof outer.code === 'string' ? outer.code : typeof inner.code === 'string' ? inner.code
    : actualStatus === 401 ? 'UNAUTHORIZED' : actualStatus === 403 ? 'FORBIDDEN' : actualStatus === 409 ? 'BUSY'
    : actualStatus !== null ? 'HTTP_ERROR' : 'NETWORK_ERROR';
  return new StrataError(code, message, actualStatus, parsed);
}
