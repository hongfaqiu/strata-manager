import { describe, expect, it } from 'vitest';
import { latestStartupDiagnostic, parseStartupDiagnostic, primaryStartupDiagnosticAction, readStartupDiagnostic } from '../src/startup-diagnostics';

const diagnostic = { profileId: 'model-a', attemptStartedAt: 100, failedAt: 200, phase: 'starting', category: 'timeout', confidence: 'confirmed',
  code: 'STARTUP_API_TIMEOUT', message: 'API not ready; process retained', evidence: [{ source: 'startupError', at: 200, message: 'not ready' }],
  actions: ['checkStatus', 'viewLogs', 'exportDiagnostics'], processRunning: true, pid: 42 };

describe('startup diagnostics', () => {
  it('reads the structured native error and keeps its attempt identity', () => {
    const result = readStartupDiagnostic(JSON.stringify({ code: diagnostic.code, message: diagnostic.message, details: { startupDiagnostic: diagnostic } }), 'model-a', 99);
    expect(result).toMatchObject({ category: 'timeout', attemptStartedAt: 100, processRunning: true });
    expect(primaryStartupDiagnosticAction(result)).toBe('checkStatus');
  });
  it('never treats a legacy OOM keyword, exit 137 or permission text as a confirmed cause', () => {
    for (const error of ['exit 137 OOM', 'permission denied', 'missing model?']) {
      expect(readStartupDiagnostic(error, 'model-a', 100)).toMatchObject({ category: 'unknown', confidence: 'unknown', actions: ['viewLogs', 'exportDiagnostics'] });
    }
  });
  it('ignores stale and other-profile records and remains compatible with older supervisors', () => {
    expect(latestStartupDiagnostic(undefined, 'model-a')).toBeUndefined();
    expect(latestStartupDiagnostic([diagnostic], 'model-b')).toBeUndefined();
    expect(latestStartupDiagnostic([diagnostic], 'model-a', 101)).toBeUndefined();
    expect(latestStartupDiagnostic([diagnostic, { ...diagnostic, failedAt: 300 }], 'model-a')?.failedAt).toBe(300);
  });
  it('bounds, redacts and rejects evidence from outside this attempt', () => {
    const evidence = [{ source: 'serviceLog', at: 99, message: 'old error' },
      ...Array.from({ length: 9 }, (_, index) => ({ source: 'serviceLog', at: 120 + index, message: 'x'.repeat(4000) })),
      { source: 'serviceLog', at: 180, message: 'Authorization: Bearer key-value' }];
    const result = parseStartupDiagnostic({ ...diagnostic, evidence })!;
    expect(result.evidence).toHaveLength(6);
    expect(result.evidence.some(item => item.message === 'old error')).toBe(false);
    expect(result.evidence.every(item => item.message.length <= 1024)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('key-value');
  });
  it('accepts only safe actions and never refreshes a stopped process by suggesting load', () => {
    const result = parseStartupDiagnostic({ ...diagnostic, processRunning: false, actions: ['restart', 'load', 'checkStatus'] })!;
    expect(result.actions).toEqual(['viewLogs', 'exportDiagnostics']);
    expect(primaryStartupDiagnosticAction(result)).toBe('viewLogs');
  });
  it('rejects future categories instead of guessing a cause', () => {
    expect(parseStartupDiagnostic({ ...diagnostic, category: 'oom' })).toBeNull();
    expect(parseStartupDiagnostic({ ...diagnostic, failedAt: 50 })).toBeNull();
  });
  it('scrubs credentials and query values from diagnostic URLs even without a known key prefix', () => {
    const value = readStartupDiagnostic('failed (https://alice:p4ss@localhost:8080/health?custom=plain-value#private)', 'model-a', 100);
    expect(JSON.stringify(value)).not.toContain('p4ss');
    expect(JSON.stringify(value)).not.toContain('plain-value');
    expect(JSON.stringify(value)).not.toContain('alice');
  });
  it('does not reuse a wrong-profile or stale embedded message for the current startup', () => {
    const error = JSON.stringify({ message: 'wrong model error', details: { startupDiagnostic: { ...diagnostic, profileId: 'model-b' } } });
    const value = readStartupDiagnostic(error, 'model-a', 100);
    expect(value.category).toBe('unknown');
    expect(value.message).not.toContain('wrong model error');
  });
  it('drops auth response bodies and service output even if an echoed key has no recognizable prefix', () => {
    const value = parseStartupDiagnostic({ ...diagnostic, category: 'auth', message: 'plain-value-with-no-prefix', evidence: [
      { source: 'startupError', at: 200, message: 'plain-value-with-no-prefix' },
      { source: 'serviceLog', at: 150, message: 'plain-value-with-no-prefix' },
      { source: 'httpStatus', at: 200, message: 'HTTP 401' },
    ] })!;
    expect(JSON.stringify(value)).not.toContain('plain-value-with-no-prefix');
    expect(value.evidence).toEqual([{ source: 'httpStatus', at: 200, message: 'HTTP 401' }]);
  });
});

describe('readable service errors', () => {
  it('never shows the native JSON envelope of a preparation failure', async () => {
    const { readableServiceError } = await import('../src/startup-diagnostics');
    const raw = JSON.stringify({ code: 'STARTUP_UNKNOWN', details: { startupDiagnostic: { phase: 'loading', evidence: [{ source: 'serviceLog', message: '[strata] still starting (261 s) - please wait ...' }] } }, message: 'error sending request for url (http://127.0.0.1:8080/load)' });
    const text = readableServiceError(raw)!;
    expect(text).toContain('本机服务未及时响应');
    expect(text).toContain('http://127.0.0.1:8080/load');
    expect(text).not.toContain('{');
    expect(readableServiceError('plain failure')).toBe('plain failure');
    expect(readableServiceError(undefined)).toBeUndefined();
    expect(readableServiceError(JSON.stringify({ message: '{"nested":true}' }))).toContain('导出诊断');
  });
});
