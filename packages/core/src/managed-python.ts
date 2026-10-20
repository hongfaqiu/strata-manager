import type { RuntimeDownloadPreferences } from './runtime-types';
import type { TaskStatus } from './types';
import { runtimeDownloadSources } from './runtime-download';

/** App-private CPython (python-build-standalone) for macOS and glibc Linux. */
export interface ManagedPythonStatus {
  /** One-click install is offered on this OS/arch. */
  supported: boolean;
  /** CPython version that is or would be installed, e.g. `3.12.15`. */
  version: string;
  downloadBytes?: number;
  installed: boolean;
  interpreter?: string;
  /** Latest install task remembered by the background service. */
  task?: TaskStatus;
}

/** Strata's floor: CPython 3.10 with venv/ensurepip. */
export function pythonVersionMeetsStrata(version: string | null | undefined): boolean {
  const match = version?.match(/(\d+)\.(\d+)/);
  return !!match && (Number(match[1]) > 3 || Number(match[1]) === 3 && Number(match[2]) >= 10);
}

/** A backend message that a usable Python 3.10+ is missing (install task or runtime detection). */
export function needsManagedPython(message: string | null | undefined): boolean {
  return !!message && /(缺少|没有可运行的本机|需要准备)[^。]*Python 3\.10\+|Python 3\.10\+[^.]*(is missing|is required)/.test(message);
}

export type ManagedPythonSourceId = 'official' | (typeof runtimeDownloadSources)[number]['id'];

export const managedPythonSources: { id: ManagedPythonSourceId; label: string; template?: string }[] = [
  { id: 'official', label: 'GitHub' },
  ...runtimeDownloadSources.map(source => ({ id: source.id, label: source.label, template: source.urlTemplate })),
];

/** Reuse the engine package proxy the user already chose; a fixed engine mirror URL does not apply to Python. */
export function defaultManagedPythonSource(preferences: RuntimeDownloadPreferences | undefined): ManagedPythonSourceId {
  if (preferences?.mode !== 'mirror') return 'official';
  return managedPythonSources.find(source => source.id === preferences.sourceId)?.id ?? 'official';
}

export function managedPythonSourceTemplate(id: ManagedPythonSourceId): string | undefined {
  return managedPythonSources.find(source => source.id === id)?.template;
}

/** Percent from the backend's `下载进度：12.3 MiB / 24.0 MiB（51%）` style message. */
export function managedPythonProgress(message: string | undefined): number | undefined {
  const match = message?.match(/[（(](\d{1,3})%[）)]/);
  return match ? Math.min(100, Number(match[1])) : undefined;
}

export type ManagedPythonPhase = 'idle' | 'running' | 'installed' | 'failed' | 'cancelled' | 'unsupported';

export function managedPythonPhase(status: ManagedPythonStatus | undefined): ManagedPythonPhase {
  if (!status) return 'idle';
  if (status.task?.state === 'running') return 'running';
  if (status.installed) return 'installed';
  if (!status.supported) return 'unsupported';
  if (status.task?.state === 'failed') return 'failed';
  if (status.task?.state === 'cancelled') return 'cancelled';
  return 'idle';
}
