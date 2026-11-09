import { describe, expect, it } from 'vitest';
import { latestStartupDiagnostic, parseStartupDiagnostic, primaryStartupDiagnosticAction, readStartupDiagnostic, startupEngineCrashed, startupMemoryShortage, startupWindowsSacBlocked } from '../src/startup-diagnostics';

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
    expect(text).toContain('本机服务没有响应这次请求');
    expect(text).toContain('启动日志');
    expect(text).not.toContain('error sending request');
    expect(text).not.toContain('http://127.0.0.1:8080/load');
    expect(text).not.toContain('{');
    expect(readableServiceError('plain failure')).toBe('plain failure');
    expect(readableServiceError(undefined)).toBeUndefined();
    expect(readableServiceError(JSON.stringify({ message: '{"nested":true}' }))).toContain('导出诊断');
  });
});

describe('issue #78 load failure categories', () => {
  it('accepts the engine and python categories from the supervisor', async () => {
    const { parseStartupDiagnostic, primaryStartupDiagnosticAction } = await import('../src/startup-diagnostics');
    for (const [category, code, action] of [['engine', 'STARTUP_ENGINE_CRASHED', 'viewLogs'], ['python', 'STARTUP_PYTHON_ENV_MISMATCH', 'openFiles']] as const) {
      const value = parseStartupDiagnostic({ profileId: 'p', attemptStartedAt: 100, failedAt: 200, phase: 'loading', category, confidence: 'confirmed', code,
        message: '引擎在加载模型时崩溃：FileNotFoundError: [WinError 2]', evidence: [{ source: 'serviceLog', at: 150, message: 'FileNotFoundError: [WinError 2] 系统找不到指定的文件。' }],
        actions: [action, 'viewLogs', 'exportDiagnostics'] }, 'p')!;
      expect(value.category).toBe(category);
      expect(value.code).toBe(code);
      expect(value.evidence[0]?.message).toContain('WinError 2');
      expect(primaryStartupDiagnosticAction(value)).toBe(action);
    }
  });
});

describe('startup memory shortage', () => {
  it('maps the runtime memory codes and nothing else', () => {
    expect(startupMemoryShortage({ code: 'STARTUP_VRAM_INSUFFICIENT' })).toBe('vram');
    expect(startupMemoryShortage({ code: 'STARTUP_WINDOWS_COMMIT_LOW' })).toBe('commit');
    expect(startupMemoryShortage({ code: 'STARTUP_ENGINE_CRASHED' })).toBeUndefined();
    expect(startupMemoryShortage({ code: 'STARTUP_RESOURCE_REPORTED' })).toBeUndefined();
  });
  it('keeps a stored memory diagnostic with its resource category and evidence', () => {
    const stored = { ...diagnostic, phase: 'loading', category: 'resource', code: 'STARTUP_VRAM_INSUFFICIENT', actions: ['openResources', 'viewLogs', 'exportDiagnostics'],
      evidence: [{ source: 'serviceLog', at: 200, message: 'strata generate: the logits buffer failed (310 MiB of 16303 MiB VRAM free on this GPU)' }] };
    const parsed = parseStartupDiagnostic(stored, 'model-a')!;
    expect(startupMemoryShortage(parsed)).toBe('vram');
    expect(parsed.evidence[0]!.message).toContain('VRAM free on this GPU');
    expect(primaryStartupDiagnosticAction(parsed)).toBe('openResources');
  });
  it('treats an engine crash or abnormal exit as a reason to fall back, not memory or log problems', () => {
    expect(startupEngineCrashed({ code: 'STARTUP_ENGINE_CRASH', category: 'engine' })).toBe(true);
    expect(startupEngineCrashed({ code: 'STARTUP_UNKNOWN', category: 'unknown', exitCode: -1073741819 })).toBe(true);
    expect(startupEngineCrashed({ code: 'STARTUP_UNKNOWN', category: 'unknown', exitCode: 0 })).toBe(false);
    expect(startupEngineCrashed({ code: 'STARTUP_API_TIMEOUT', category: 'timeout' })).toBe(false);
    expect(startupEngineCrashed({ code: 'STARTUP_VRAM_INSUFFICIENT', category: 'engine', exitCode: 1 })).toBe(false);
    expect(startupEngineCrashed({ code: 'STARTUP_LOG_UNWRITABLE', category: 'engine', exitCode: 1 })).toBe(false);
    expect(startupEngineCrashed({ code: 'STARTUP_WINDOWS_SAC_BLOCKED', category: 'engine', exitCode: 1 })).toBe(false);
  });
  it('recognizes the Windows Smart App Control diagnostic code', () => {
    expect(startupWindowsSacBlocked({ code: 'STARTUP_WINDOWS_SAC_BLOCKED' })).toBe(true);
    expect(startupWindowsSacBlocked({ code: 'STARTUP_ENGINE_CRASHED' })).toBe(false);
    const stored = { ...diagnostic, phase: 'loading', category: 'engine', confidence: 'confirmed', code: 'STARTUP_WINDOWS_SAC_BLOCKED',
      message: 'Windows Smart App Control blocked the engine', actions: ['viewLogs', 'exportDiagnostics'],
      evidence: [{ source: 'serviceLog', at: 200, message: 'OSError: [WinError 4551] An Application Control policy has blocked this file.' }] };
    const parsed = parseStartupDiagnostic(stored, 'model-a')!;
    expect(startupWindowsSacBlocked(parsed)).toBe(true);
    expect(primaryStartupDiagnosticAction(parsed)).toBe('viewLogs');
  });
});
