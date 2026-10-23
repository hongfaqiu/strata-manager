// Choosing a Strata version: the release list, version ordering and the "pin" that stops
// update prompts beyond a chosen version. Installing still goes through the verified update.
import { loadStore, saveStore } from './bridge';

export interface RuntimeReleaseVersion {
  version: string; tag: string; name?: string; publishedAt?: string; prerelease: boolean;
  /** `feed`: signed engine packages (0.2+); `zip`: legacy Windows ZIPs. */
  packaging: 'feed' | 'zip';
  /** Has an engine package Manager installs on this platform. */
  installable: boolean;
  releaseUrl?: string;
  /** Engine build the release ships (from its asset names); display only. */
  engineVersion?: string;
}
export interface RuntimeReleaseVersions { checkedAt: number; versions: RuntimeReleaseVersion[]; error?: string }

export const RUNTIME_PIN_KEY = 'runtimePinnedVersion';

function parts(version: string) {
  const [core = '', ...pre] = version.trim().replace(/^v/i, '').split('-');
  const numbers = core.split('.').map(part => /^\d+$/.test(part) ? Number(part) : NaN);
  return numbers.some(Number.isNaN) ? undefined : { numbers, pre: pre.join('-') };
}

/** Negative when `a` is older; a release sorts after its pre-releases. Unparseable versions compare equal. */
export function compareReleaseVersions(a: string | undefined, b: string | undefined): number {
  const x = a ? parts(a) : undefined, y = b ? parts(b) : undefined;
  if (!x || !y) return 0;
  for (let index = 0; index < Math.max(x.numbers.length, y.numbers.length); index++) {
    const difference = (x.numbers[index] ?? 0) - (y.numbers[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** With a pin, versions newer than it are not offered as updates. */
export function runtimeUpdateAllowedByPin(latest: string | undefined, pin: string | null | undefined): boolean {
  return !pin || !latest || compareReleaseVersions(latest, pin) <= 0;
}

export type RuntimeVersionDirection = 'same' | 'upgrade' | 'downgrade' | 'unknown';
export function runtimeVersionDirection(current: string | undefined, target: string): RuntimeVersionDirection {
  if (!current || !parts(current) || !parts(target)) return 'unknown';
  const order = compareReleaseVersions(target, current);
  return order === 0 ? 'same' : order > 0 ? 'upgrade' : 'downgrade';
}

export const getRuntimePin = async (): Promise<string> => (await loadStore<string>(RUNTIME_PIN_KEY, '')) || '';
export const setRuntimePin = (version: string | null): Promise<void> => saveStore(RUNTIME_PIN_KEY, version?.trim().replace(/^v/i, '') ?? '');

/**
 * Release ≠ engine. From 0.2 a Strata release (v0.2.3) ships an engine build with its own
 * number (0.1.48), so the two are labelled separately and only compared like with like.
 */
export interface RuntimeVersionFacts { releaseVersion?: string; runtimeVersion?: string }
/** Releases before this one shipped an engine with the same number. */
const FIRST_SEPARATE_RELEASE = '0.1.45';
const plain = (value?: string | null) => value?.trim().replace(/^v/i, '') || undefined;

/** The release of a runtime: what the folder records, else the one release that shipped its engine. */
export function runtimeReleaseOf(runtime: RuntimeVersionFacts | undefined, releases: Pick<RuntimeReleaseVersion, 'version' | 'engineVersion' | 'prerelease'>[] = []): string | undefined {
  const own = plain(runtime?.releaseVersion);
  if (own) return own;
  const engine = plain(runtime?.runtimeVersion);
  if (!engine) return undefined;
  const shipped = releases.filter(release => plain(release.engineVersion) === engine);
  const matched = shipped.length === 1 ? shipped[0]?.version : shipped.find(release => !release.prerelease)?.version;
  return matched ?? (parts(engine) && compareReleaseVersions(engine, FIRST_SEPARATE_RELEASE) < 0 ? engine : undefined);
}

/** Engine build of a release's packages (all platforms of one release share it). */
export function releaseEngineVersion(info: { assets?: { engineVersion?: string }[] } | undefined): string | undefined {
  return plain(info?.assets?.find(asset => !!plain(asset.engineVersion))?.engineVersion);
}

/** 「Release v0.2.2 · 引擎 0.1.47」; either half is left out when unknown. */
export function runtimeVersionLabel(facts: { release?: string; engine?: string }, zh: boolean): string {
  const release = plain(facts.release), engine = plain(facts.engine);
  return [release && `Release v${release}`, engine && `${zh ? '引擎' : release ? 'engine' : 'Engine'} ${engine}`].filter(Boolean).join(' · ');
}

/** Is `latest` newer than the runtime? Release against release, else engine against engine; undefined when neither pair is known. */
export function runtimeReleaseIsNewer(runtime: RuntimeVersionFacts, latest: { latestVersion?: string; assets?: { engineVersion?: string }[] } | undefined, releases: Pick<RuntimeReleaseVersion, 'version' | 'engineVersion' | 'prerelease'>[] = []): boolean | undefined {
  const release = runtimeReleaseOf(runtime, releases), target = plain(latest?.latestVersion);
  if (release && target && parts(release) && parts(target)) return compareReleaseVersions(target, release) > 0;
  const engine = plain(runtime.runtimeVersion), targetEngine = releaseEngineVersion(latest);
  if (engine && targetEngine && parts(engine) && parts(targetEngine)) return compareReleaseVersions(targetEngine, engine) > 0;
  return undefined;
}

/** Offer `latest` to this runtime. Without a comparable pair it is offered unless the engine is already the latest one. */
export function runtimeUpdateAvailable(runtime: RuntimeVersionFacts, latest: { latestVersion?: string; assets: { engineVersion?: string }[] } | undefined, releases: Pick<RuntimeReleaseVersion, 'version' | 'engineVersion' | 'prerelease'>[] = []): boolean {
  if (!latest?.latestVersion) return false;
  const newer = runtimeReleaseIsNewer(runtime, latest, releases);
  if (newer !== undefined) return newer;
  const engine = plain(runtime.runtimeVersion);
  return !engine || !latest.assets.some(asset => plain(asset.engineVersion) === engine);
}

/**
 * The pin as a release. Before release and engine were told apart a pin could hold the engine
 * number (0.1.47); it means the release that shipped that engine, so it no longer blocks every
 * 0.2 update. Unknown values are kept.
 */
export function runtimePinRelease(pin: string | null | undefined, runtimes: RuntimeVersionFacts[] = [], releases: Pick<RuntimeReleaseVersion, 'version' | 'engineVersion' | 'prerelease'>[] = []): string | undefined {
  const value = plain(pin);
  if (!value) return undefined;
  if (releases.some(release => plain(release.version) === value)) return value;
  const local = runtimes.map(runtime => ({ engine: plain(runtime.runtimeVersion), release: plain(runtime.releaseVersion) })).find(item => item.engine === value && item.release);
  if (local?.release) return local.release;
  return runtimeReleaseOf({ runtimeVersion: value }, releases) ?? value;
}
