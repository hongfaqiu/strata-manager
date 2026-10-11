import { loadStore, saveStore } from './bridge';
import type { RuntimeDownloadPreferences, RuntimeUpdateInfo, RuntimeZipDownloadOptions } from './runtime-types';

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
