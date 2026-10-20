import { describe, expect, it } from 'vitest';
import { defaultManagedPythonSource, managedPythonPhase, managedPythonProgress, managedPythonSourceTemplate, needsManagedPython, pythonVersionMeetsStrata } from '../src/managed-python';
import type { TaskStatus } from '../src/types';

describe('managed Python', () => {
  it('applies Strata\'s 3.10 floor to version strings', () => {
    expect(pythonVersionMeetsStrata('Python 3.9.6')).toBe(false);
    expect(pythonVersionMeetsStrata('Python 3.10.0')).toBe(true);
    expect(pythonVersionMeetsStrata('Python 3.12.15')).toBe(true);
    expect(pythonVersionMeetsStrata(null)).toBe(false);
  });

  it('recognises the backend messages that should offer one-click install', () => {
    expect(needsManagedPython('本机缺少 Python 3.10+（含 venv/ensurepip）。可一键安装应用内 Python 3.12.15，完成后重试。')).toBe(true);
    expect(needsManagedPython('本机缺少 64 位 Python 3.10+ 或 venv/ensurepip。本应用不会执行 sudo。')).toBe(true);
    expect(needsManagedPython('没有可运行的本机 Python 3.10+ 环境')).toBe(true);
    expect(needsManagedPython('需要准备 Python 3.10+ 环境')).toBe(true);
    expect(needsManagedPython('Python 运行依赖缺失：regex')).toBe(false);
    expect(needsManagedPython(undefined)).toBe(false);
  });

  it('reuses the engine GitHub proxy but never a fixed engine mirror URL', () => {
    expect(defaultManagedPythonSource(undefined)).toBe('official');
    expect(defaultManagedPythonSource({ mode: 'mirror', sourceId: 'gh-proxy' })).toBe('gh-proxy');
    expect(defaultManagedPythonSource({ mode: 'mirror', mirrorUrl: 'https://mirror.example/engine.zip' })).toBe('official');
    expect(defaultManagedPythonSource({ mode: 'local', localArchivePath: '/x.tar.gz' })).toBe('official');
    expect(managedPythonSourceTemplate('official')).toBeUndefined();
    expect(managedPythonSourceTemplate('gh-proxy')).toContain('{url}');
  });

  it('reads download percent and derives the panel phase', () => {
    expect(managedPythonProgress('下载进度：12.0 MiB / 24.0 MiB（51%）· 3.1 MiB/s')).toBe(51);
    expect(managedPythonProgress('正在解包')).toBeUndefined();
    const task = (state: TaskStatus['state']) => ({ id: 't', kind: 'install-python', state, message: '', startedAt: 1 });
    expect(managedPythonPhase({ supported: true, version: '3.12.15', installed: false })).toBe('idle');
    expect(managedPythonPhase({ supported: true, version: '3.12.15', installed: false, task: task('running') })).toBe('running');
    expect(managedPythonPhase({ supported: true, version: '3.12.15', installed: true, task: task('completed') })).toBe('installed');
    expect(managedPythonPhase({ supported: true, version: '3.12.15', installed: false, task: task('failed') })).toBe('failed');
    expect(managedPythonPhase({ supported: false, version: '3.12.15', installed: false })).toBe('unsupported');
  });
});
