import { describe, expect, it } from 'vitest';
import { normalizeError } from '../src/errors';

describe('native supervisor errors', () => {
  it('extracts the actionable message and code from a framed supervisor diagnostic', () => {
    const diagnostic = { code: 'STARTUP_RUNTIME_ALREADY_MANAGED', message: '请连接已有管理后台', details: { startupDiagnostic: { phase: 'prepare' } } };
    const error = normalizeError(`runtime_operation: ${JSON.stringify(diagnostic)}`);
    expect(error.code).toBe(diagnostic.code);
    expect(error.message).toBe(diagnostic.message);
    expect(error.details).toEqual(diagnostic);
  });

  it('preserves unstructured native messages and native HTTP status', () => {
    expect(normalizeError('runtime_operation: 服务忙碌').message).toBe('runtime_operation: 服务忙碌');
    const error = normalizeError('HTTP 409: {"code":"BUSY","message":"仍有活动请求"}');
    expect(error.code).toBe('BUSY');
    expect(error.status).toBe(409);
    expect(error.message).toBe('仍有活动请求');
  });
});
