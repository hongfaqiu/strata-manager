// Installed Strata versions: list, delete, 一键清理 and switching between them.
// The background service decides what is protected; the UI only shows and confirms.
import { compareReleaseVersions, runtimeReleaseOf, type RuntimeReleaseVersion } from './runtime-versions';

export interface RuntimeReference { id: string; name: string }
export interface InstalledRuntime {
  installDir: string; pythonPath: string;
  releaseVersion?: string; engineVersion?: string;
  readiness: string;
  /** Installed by Manager in its own runtimes folder; only these can be deleted. */
  owned: boolean;
  current: boolean; running: boolean;
  /** Kept as the version to switch back to. */
  rollback: boolean;
  switching: boolean;
  profiles: RuntimeReference[];
  installedAt?: number; lastUsedAt?: number;
  /** Selected by 一键清理 (keeps the current version + 1). */
  cleanup: boolean;
  /** Why 删除 is unavailable. */
  protectedReason?: string;
}
export type RuntimeLeftoverKind = 'partialDownload' | 'archive' | 'failedInstall' | 'trash' | 'updateWork';
export interface RuntimeLeftover { path: string; kind: RuntimeLeftoverKind }
export interface RuntimeInventory { runtimes: InstalledRuntime[]; leftovers: RuntimeLeftover[]; autoCleanup: boolean; busy: boolean }
export interface RuntimeCleanupResult { removed: string[]; skipped: { path: string; reason: string }[]; freedBytes: number }

/** Store key of 「更新成功后自动清理旧版本」; missing means on. */
export const RUNTIME_AUTO_CLEANUP_KEY = 'runtimeAutoCleanup';

const facts = (runtime: InstalledRuntime) => ({ releaseVersion: runtime.releaseVersion, runtimeVersion: runtime.engineVersion });
type Releases = Pick<RuntimeReleaseVersion, 'version' | 'engineVersion' | 'prerelease'>[];

/** The release a listed runtime is, from its own record or the release that shipped its engine. */
export const installedRuntimeRelease = (runtime: InstalledRuntime, releases: Releases = []) => runtimeReleaseOf(facts(runtime), releases);

/** A complete local copy of `version` that is not the one in use: switch instead of downloading. */
export function installedRuntimeForRelease(inventory: RuntimeInventory | undefined, version: string, releases: Releases = []): InstalledRuntime | undefined {
  return inventory?.runtimes.find(runtime => {
    const release = installedRuntimeRelease(runtime, releases);
    return !runtime.current && runtime.readiness === 'ready' && !!runtime.pythonPath && !!release && compareReleaseVersions(release, version) === 0;
  });
}

/** Newest first; the version in use leads. */
export function sortInstalledRuntimes(runtimes: InstalledRuntime[], releases: Releases = []): InstalledRuntime[] {
  return [...runtimes].sort((a, b) => Number(b.current) - Number(a.current)
    || compareReleaseVersions(installedRuntimeRelease(b, releases) ?? b.engineVersion, installedRuntimeRelease(a, releases) ?? a.engineVersion)
    || (b.installedAt ?? 0) - (a.installedAt ?? 0));
}

/** What 一键清理 deletes: older Manager versions plus leftovers. */
export const cleanupPaths = (inventory: RuntimeInventory | undefined): string[] =>
  inventory ? [...inventory.runtimes.filter(runtime => runtime.cleanup).map(runtime => runtime.installDir), ...inventory.leftovers.map(item => item.path)] : [];

/** Sum of the known sizes; `undefined` while any is still being measured. */
export function totalBytes(paths: string[], sizes: Record<string, number | undefined>): number | undefined {
  let total = 0;
  for (const path of paths) {
    const size = sizes[path];
    if (size === undefined) return undefined;
    total += size;
  }
  return total;
}

export function formatRuntimeBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '…';
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
