import { loadStore, saveStore } from './bridge';
import type { RuntimeDownloadPreferences, RuntimeReleaseAsset, RuntimeUpdateInfo, RuntimeZipDownloadOptions } from './runtime-types';

const storeKey = 'runtimeDownloadPreferences';
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

/**
 * GitHub release proxies. gh-proxy.org is the default source and GitHub the fallback; every
 * package is still checked against the official size and SHA-256 whichever host serves it.
 * Labels are the proxy hostnames so the two similarly named services stay distinguishable (#126).
 */
export const runtimeDownloadSources = [
  { id: 'gh-proxy', label: 'gh-proxy.org', urlTemplate: 'https://gh-proxy.org/{url}' },
  { id: 'ghproxy', label: 'ghproxy.net', urlTemplate: 'https://ghproxy.net/{url}' },
] as const;

/** Nothing saved yet: the domestic mirror first, GitHub as the fallback. */
export const RUNTIME_DOWNLOAD_DEFAULTS: RuntimeDownloadPreferences = { mode: 'mirror', sourceId: 'gh-proxy' };

function normalize(value: unknown): RuntimeDownloadPreferences {
  if (!value || typeof value !== 'object') return { ...RUNTIME_DOWNLOAD_DEFAULTS };
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
  return normalize(await loadStore<unknown>(storeKey, RUNTIME_DOWNLOAD_DEFAULTS));
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

/** Short GPU label of an official engine package; `zh` picks the language of the "untested" note. */
export function runtimeAssetLabel(asset: Pick<RuntimeReleaseAsset, 'name' | 'variant'>, zh = false): string {
  switch (asset.variant) {
    case 'hip-rx6000':
    case 'hip-rdna2': return zh ? 'AMD HIP · RX 6000（上游未经实机测试）' : 'AMD HIP · RX 6000 (untested by upstream on a real card)';
    case 'cuda13': return 'CUDA 13';
    case 'cuda12': return 'CUDA 12';
    case 'hip-rdna3': return 'AMD HIP · RX 7000 / Strix Halo';
    case 'hip-rx7900': return 'AMD HIP · RX 7000';
    case 'hip-halo': return 'AMD HIP · Strix Halo';
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

const CJK = /[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/;

/**
 * Picks one language from a backend `中文 / English` message. The split is the first ` / ` after which no
 * Chinese text follows, so labels such as `RX 7000 / Strix Halo` inside either half stay intact.
 */
export function runtimeBilingualText(text: string, zh: boolean): string {
  let from = 0;
  for (;;) {
    const at = text.indexOf(' / ', from);
    if (at < 0) return text;
    const before = text.slice(0, at), after = text.slice(at + 3);
    if (CJK.test(before) && !CJK.test(after)) return (zh ? before : after).trim();
    from = at + 3;
  }
}

export interface RuntimeTrialRollback {
  /** Version restored after the failed trial; absent when a first installation was undone. */
  restoredVersion?: string;
  /** Reason as reported by the engine or health check, one language per line where the backend is bilingual. */
  reason: string;
}

/** Localises each line of a multi-line backend reason, keeping an engine folder prefix such as `engine-cuda12: `. */
export function runtimeReasonText(reason: string, zh: boolean): string {
  return reason.split('\n').map(line => {
    const prefix = /^[\w.-]+: (?=.*[\u3400-\u9fff])/.exec(line)?.[0] ?? '';
    return prefix + runtimeBilingualText(line.slice(prefix.length), zh);
  }).join('\n');
}

/** Recognises the backend message of an engine update that failed its trial start and was rolled back. */
export function runtimeTrialRollback(message: string | undefined): RuntimeTrialRollback | undefined {
  if (!message || !message.includes('新引擎试启动未通过')) return undefined;
  const restoredVersion = /已自动恢复原版本 (\S+?)，/.exec(message)?.[1];
  const marker = message.indexOf('原因 / Reason: ');
  const reason = marker >= 0 ? message.slice(marker + '原因 / Reason: '.length).trim() : '';
  return { ...(restoredVersion ? { restoredVersion } : {}), reason };
}
