import { loadStore, saveStore } from './bridge';
import type { RuntimeDownloadPreferences, RuntimeReleaseAsset, RuntimeUpdateInfo, RuntimeZipDownloadOptions } from './runtime-types';

const storeKey = 'runtimeDownloadPreferences';
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

/** Third-party GitHub release proxies; the official source remains the default. */
export const runtimeDownloadSources = [
  { id: 'gh-proxy', label: 'GH Proxy', urlTemplate: 'https://gh-proxy.org/{url}' },
  { id: 'ghproxy', label: 'GHProxy', urlTemplate: 'https://ghproxy.net/{url}' },
] as const;

function normalize(value: unknown): RuntimeDownloadPreferences {
  if (!value || typeof value !== 'object') return { mode: 'official' };
  const raw = value as Record<string, unknown>;
  const mode = raw.mode === 'local' || raw.mode === 'mirror' ? raw.mode : 'official';
  return {
    mode,
    ...(mode === 'mirror' && runtimeDownloadSources.some(source => source.id === raw.sourceId) ? { sourceId: text(raw.sourceId) } : {}),
    ...(text(raw.assetName) ? { assetName: text(raw.assetName) } : {}),
    ...(text(raw.releaseVersion) ? { releaseVersion: text(raw.releaseVersion) } : {}),
    ...(mode === 'local' && text(raw.localArchivePath) ? { localArchivePath: text(raw.localArchivePath) } : {}),
    ...(mode === 'mirror' && text(raw.mirrorUrl) ? { mirrorUrl: text(raw.mirrorUrl) } : {}),
  };
}

export async function getRuntimeDownloadPreferences(): Promise<RuntimeDownloadPreferences> {
  return normalize(await loadStore<unknown>(storeKey, { mode: 'official' }));
}

export function saveRuntimeDownloadPreferences(value: RuntimeDownloadPreferences): Promise<void> {
  return saveStore(storeKey, normalize(value));
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !url.hash && url.pathname !== '/';
  } catch { return false; }
}

/** Resolve against the current official asset; stale custom sources require reselection. */
export function resolveRuntimeDownloadPreferences(value: RuntimeDownloadPreferences, release: RuntimeUpdateInfo, automaticAssetName?: string): {
  assetName?: string; download: RuntimeZipDownloadOptions; requiresSelection: boolean;
} {
  const preferences = normalize(value);
  const asset = release.assets.find(item => item.name === (preferences.assetName || automaticAssetName));
  const assetName = asset?.name;
  if (preferences.mode === 'official') return { assetName, download: {}, requiresSelection: false };
  const version = release.latestVersion ?? release.supportedVersion;
  const sameRelease = preferences.releaseVersion === version;
  if (preferences.mode === 'local') {
    const valid = !!asset && sameRelease && !!preferences.localArchivePath;
    return { assetName, download: { localArchivePath: valid ? preferences.localArchivePath : '' }, requiresSelection: !valid };
  }
  const template = runtimeDownloadSources.find(source => source.id === preferences.sourceId)?.urlTemplate ?? preferences.mirrorUrl ?? '';
  const hasTemplate = /\{(?:url|version|asset)\}/.test(template);
  const unsupportedTemplate = /\{[^}]*\}/.test(template.replace(/\{(?:url|version|asset)\}/g, ''));
  const resolved = asset ? template.replace(/\{(url|version|asset)\}/g, (_, key: string) => (
    key === 'url' ? asset.url : encodeURIComponent(key === 'version' ? version : asset.name)
  )) : '';
  const valid = !!asset && (sameRelease || hasTemplate) && !unsupportedTemplate && validUrl(resolved);
  return { assetName, download: { downloadUrl: valid ? resolved : '' }, requiresSelection: !valid };
}

/** File-picker filter for a downloaded engine package: Strata 0.2+ `.tar.gz` or a legacy ZIP. */
export function runtimeEngineArchiveFilters(zh: boolean): { name: string; extensions: string[] }[] {
  return [{ name: zh ? '引擎包（tar.gz / ZIP）' : 'Engine package (tar.gz / ZIP)', extensions: ['gz', 'tgz', 'zip'] }];
}

/** Short GPU label of an official engine package. */
export function runtimeAssetLabel(asset: Pick<RuntimeReleaseAsset, 'name' | 'variant'>): string {
  switch (asset.variant) {
    case 'cuda13': return 'CUDA 13';
    case 'cuda12': return 'CUDA 12';
    case 'hip-rdna3': return 'AMD HIP · RX 7000 / Strix Halo';
    case 'hip': return asset.name.endsWith('.zip') ? 'AMD HIP' : 'AMD HIP · RX 9000 / R9700';
    default: return String(asset.variant).toUpperCase();
  }
}

/**
 * Strata 0.2+ release versions differ from their engine version (0.2.0-beta ships engine 0.1.45.3).
 * A runtime whose engine already matches a package of the release is up to date.
 */
export function runtimeEngineIsCurrent(runtimeVersion: string | undefined, release: Pick<RuntimeUpdateInfo, 'assets'> | undefined): boolean {
  return !!runtimeVersion && !!release?.assets.some(asset => !!asset.engineVersion && asset.engineVersion === runtimeVersion);
}
