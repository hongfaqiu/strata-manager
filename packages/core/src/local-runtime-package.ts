import type { LocalRuntimeArchives } from './installation-types';

/** Where the first-run Strata/engine packages come from: downloaded automatically or chosen from disk. */
export type RuntimePackageSource = 'download' | 'local';

/** Installer host platform for package selection (not navigator alone). */
export type RuntimePackagePlatform = 'windows' | 'macos' | 'linux' | 'other';

export interface LocalRuntimePackageSelection {
  /** Archives to pass to `prepareLocalRuntime`; undefined means download everything. */
  chosen?: LocalRuntimeArchives;
  /** Local packages were requested but no ZIP/archive has been chosen yet. */
  missing: boolean;
}

const trimmed = (value?: string) => value?.trim() || undefined;

/** Resolve the package platform from a detected OS string or the browser UA. */
export function runtimePackagePlatform(os?: string): RuntimePackagePlatform {
  const fallback = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const value = os || fallback;
  if (/windows/i.test(value)) return 'windows';
  if (/mac|darwin/i.test(value) && !/iphone|ipad|ipod/i.test(value)) return 'macos';
  if (/linux|ubuntu|debian|fedora|arch/i.test(value)) return 'linux';
  return 'other';
}

/** Windows ships a separate engine ZIP; Mac ships a Metal `.tar.gz`; Linux builds from source. */
export function runtimePackageIsWindows(os?: string): boolean {
  return runtimePackagePlatform(os) === 'windows';
}

export function runtimePackageIsMac(os?: string): boolean {
  return runtimePackagePlatform(os) === 'macos';
}

/** Platforms that accept a separate engine archive during first-run install. */
export function runtimePackageOffersEngine(platform: RuntimePackagePlatform): boolean {
  return platform === 'windows' || platform === 'macos';
}

/**
 * Shared by the setup guide and the Strata page so both install from local archives the same way.
 * Unchosen parts are still downloaded; an engine archive is ignored where the platform has none.
 */
export function localRuntimePackageSelection(
  source: RuntimePackageSource,
  archives: LocalRuntimeArchives,
  platformOrWindows: RuntimePackagePlatform | boolean,
): LocalRuntimePackageSelection {
  if (source !== 'local') return { missing: false };
  const platform: RuntimePackagePlatform =
    typeof platformOrWindows === 'boolean'
      ? platformOrWindows
        ? 'windows'
        : 'linux'
      : platformOrWindows;
  const strataArchivePath = trimmed(archives.strataArchivePath);
  const engineArchivePath = runtimePackageOffersEngine(platform)
    ? trimmed(archives.engineArchivePath)
    : undefined;
  const chosen: LocalRuntimeArchives = {
    ...(strataArchivePath ? { strataArchivePath } : {}),
    ...(engineArchivePath ? { engineArchivePath } : {}),
  };
  const missing = !strataArchivePath && !engineArchivePath;
  return { chosen: missing ? undefined : chosen, missing };
}

/** Catalog families upstream has measured on Metal (hide Qwen3.6 / Swift / Coder). */
export function macCatalogFamilyAllowed(family: string): boolean {
  return family === 'qwen' || family === 'unsloth';
}

export function filterCatalogForPlatform<T extends { family: string }>(
  catalog: readonly T[],
  platform: RuntimePackagePlatform,
): T[] {
  if (platform !== 'macos') return [...catalog];
  return catalog.filter(entry => macCatalogFamilyAllowed(entry.family));
}

/** Bilingual manual-build hint (phase 2b not automated). */
export function metalManualBuildHint(language: 'zh-CN' | 'en' = 'zh-CN'): string {
  return language === 'zh-CN'
    ? '若需自行编译 Metal 引擎：在 Strata 源码目录按上游 docs/MAC.md 运行 ./setup.sh（约 1–15 分钟，需要 Command Line Tools）。Manager 目前优先安装官方预制包 strata-engine-*-macos-arm64-metal.tar.gz。'
    : 'To build the Metal engine yourself: in a Strata source tree run ./setup.sh per upstream docs/MAC.md (about 1–15 minutes; needs Command Line Tools). Manager prefers the official prebuilt package strata-engine-*-macos-arm64-metal.tar.gz.';
}

/** Mac engine argv defaults from docs/MAC.md. */
export function macDefaultEngineArgs(): string[] {
  return ['--spec', '2'];
}

export function macSupportsCalibrate(platform: RuntimePackagePlatform): boolean {
  return platform !== 'macos';
}

export function macSupportsParallel(platform: RuntimePackagePlatform): boolean {
  return platform !== 'macos';
}
