import type { ServiceProfile } from '@strata-manager/core';

/**
 * What one-click speed-up switched to, kept so it can switch back. Applying
 * never edits a file: it saves a new version (`to`) and switches to it; the
 * rollback switches to `origin`, the version in use before the first change.
 */
export interface SpeedBoostApplied {
  kind: 'boost' | 'fix';
  /** The calibration whose result was applied; its card is dismissed on rollback. */
  jobId?: string;
  origin: ServiceProfile;
  to: string;
  name: string;
  at: number;
  before?: number | null;
  after?: number | null;
}
const KEY = 'strata.speedBoost.applied';
const DISMISSED = 'strata.speedBoost.dismissed';
const storage = (): Storage | null => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };
const read = <T>(key: string, fallback: T): T => { try { const raw = storage()?.getItem(key); return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };
const write = (key: string, value: unknown) => { try { storage()?.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked: rollback stays manual */ } };

export const appliedRecords = (): SpeedBoostApplied[] => read<SpeedBoostApplied[]>(KEY, []).filter(item => item && typeof item.to === 'string' && item.origin && typeof item.origin.id === 'string');
export const appliedFor = (profileId: string | undefined): SpeedBoostApplied | null => profileId ? appliedRecords().find(item => item.to === profileId) ?? null : null;
/** The version to roll back to: the one before any one-click change, even after several. */
export const originFor = (profile: ServiceProfile): ServiceProfile => appliedFor(profile.id)?.origin ?? profile;
export function rememberApplied(record: SpeedBoostApplied) {
  write(KEY, [record, ...appliedRecords().filter(item => item.to !== record.to)].slice(0, 20));
}
export function forgetApplied(profileId: string) {
  write(KEY, appliedRecords().filter(item => item.to !== profileId));
}
export const dismissedJobs = (): string[] => read<string[]>(DISMISSED, []);
export function dismissJob(jobId: string) { write(DISMISSED, [jobId, ...dismissedJobs().filter(id => id !== jobId)].slice(0, 20)); }

const NOTICE_KEY = 'strata.speedBoost.notice';
/** A message that must survive the page remount caused by switching versions. */
export function leaveNotice(text: string) {
  try { sessionStorage.setItem(NOTICE_KEY, text); } catch { /* storage unavailable */ }
}
export function takeNotice(): string | null {
  try { const text = sessionStorage.getItem(NOTICE_KEY); sessionStorage.removeItem(NOTICE_KEY); return text; } catch { return null; }
}
