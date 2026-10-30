import type { RuntimeDownloadPreferences } from '@strata-manager/core';

/**
 * The app updater (src-tauri/src/app_updates.rs) reads the engine download preferences: a built-in
 * mirror or a custom `{url}` wrap template is used for app updates; official, local and engine-only
 * templates leave the app updater on its automatic, signature-checked source choice.
 */
export type AppUpdateSourceChoice = 'official' | 'gh-proxy' | 'ghproxy' | 'custom' | 'local';
export type AppUpdateMirrorProblem = 'https' | 'url' | 'engineOnly' | 'placeholder';

const OFFICIAL_MANIFEST_URL = 'https://github.com/hongfaqiu/strata-manager/releases/latest/download/latest.json';
const BUILT_IN = ['gh-proxy', 'ghproxy'];

/** Same rules as `custom_source` in app_updates.rs: HTTPS, no credentials or fragment, `{url}` only. */
export function appUpdateMirrorProblem(value: string): AppUpdateMirrorProblem | null {
  const template = value.trim();
  const sample = template.replace(/\{(?:url|version|asset)\}/g, OFFICIAL_MANIFEST_URL);
  let url: URL;
  try { url = new URL(sample); } catch { return 'https'; }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || sample.includes('#') || url.pathname === '/' || !url.pathname) return 'https';
  if (!template.includes('{url}')) return /\{(?:version|asset)\}/.test(template) ? 'engineOnly' : 'url';
  if (/[{}]/.test(template.replaceAll('{url}', ''))) return 'placeholder';
  return null;
}

export function appUpdateSourceChoice(value: RuntimeDownloadPreferences | undefined): AppUpdateSourceChoice {
  if (!value || value.mode === 'official') return 'official';
  if (value.mode === 'local') return 'local';
  return value.sourceId && BUILT_IN.includes(value.sourceId) ? value.sourceId as AppUpdateSourceChoice : 'custom';
}

/** Whether the app updater actually uses this saved source (mirrors `preferred_source_from_preferences`). */
export function appUpdateUsesSource(value: RuntimeDownloadPreferences | undefined): boolean {
  const choice = appUpdateSourceChoice(value);
  if (choice === 'gh-proxy' || choice === 'ghproxy') return true;
  return choice === 'custom' && !!value?.mirrorUrl && appUpdateMirrorProblem(value.mirrorUrl) === null;
}

/** New shared preferences for a choice; the engine's package choice and release pin are kept. */
export function withAppUpdateSource(value: RuntimeDownloadPreferences | undefined, choice: Exclude<AppUpdateSourceChoice, 'local'>, mirrorUrl = ''): RuntimeDownloadPreferences {
  const keep = { ...(value?.assetName ? { assetName: value.assetName } : {}) };
  const release = value?.releaseVersion ? { releaseVersion: value.releaseVersion } : {};
  if (choice === 'official') return { mode: 'official', ...keep };
  if (choice === 'custom') return { mode: 'mirror', ...keep, ...release, mirrorUrl: mirrorUrl.trim() };
  return { mode: 'mirror', ...keep, ...release, sourceId: choice };
}
