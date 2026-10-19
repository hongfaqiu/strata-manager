import type { LocalRuntimeArchives } from './installation-types';

/** Where the first-run Strata/engine packages come from: downloaded automatically or chosen from disk. */
export type RuntimePackageSource = 'download' | 'local';

export interface LocalRuntimePackageSelection {
  /** Archives to pass to `prepareLocalRuntime`; undefined means download everything. */
  chosen?: LocalRuntimeArchives;
  /** Local packages were requested but no ZIP has been chosen yet. */
  missing: boolean;
}

/** Windows ships a separate engine ZIP; Linux builds the engine from the Strata source ZIP. */
export function runtimePackageIsWindows(os?: string): boolean {
  const fallback = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return /windows/i.test(os || fallback);
}

const trimmed = (value?: string) => value?.trim() || undefined;

/**
 * Shared by the setup guide and the Strata page so both install from local ZIPs the same way.
 * Unchosen parts are still downloaded; an engine ZIP is ignored where the platform has none.
 */
export function localRuntimePackageSelection(source: RuntimePackageSource, archives: LocalRuntimeArchives, windows: boolean): LocalRuntimePackageSelection {
  if (source !== 'local') return { missing: false };
  const strataArchivePath = trimmed(archives.strataArchivePath);
  const engineArchivePath = windows ? trimmed(archives.engineArchivePath) : undefined;
  const chosen: LocalRuntimeArchives = { ...(strataArchivePath ? { strataArchivePath } : {}), ...(engineArchivePath ? { engineArchivePath } : {}) };
  const missing = !strataArchivePath && !engineArchivePath;
  return { chosen: missing ? undefined : chosen, missing };
}
