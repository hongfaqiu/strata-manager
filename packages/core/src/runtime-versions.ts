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
