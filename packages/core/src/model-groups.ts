import type { JsonObject, LocalCandidate, LocalInstallationDetails, ServiceProfile } from './types';
import type { DetectedRuntime } from './installation-types';

const canonical = (value: string) => {
  const path = value.replace(/\\/g, '/').replace(/^\/\/\?\/([a-z]:\/)/i, '$1');
  const root = path.match(/^(?:[a-z]:\/|\/\/[^/]+\/[^/]+\/?|\/)/i)?.[0] ?? '';
  const parts: string[] = [];
  for (const part of path.slice(root.length).split('/')) {
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part === '..' && root) continue;
    else if (part && part !== '.') parts.push(part);
  }
  const normalized = `${root}${root && !root.endsWith('/') && parts.length ? '/' : ''}${parts.join('/')}`;
  return /^[a-z]:|^\/\//i.test(root) ? normalized.toLowerCase() : normalized;
};
const resolve = (root: string, path: string) => canonical(/^(?:[a-z]:[\\/]|[\\/]{2}|\/)/i.test(path) ? path : `${root}/${path}`);
const primaryFlags = ['--native', '--model', '-m', '--pack'];
function optionPaths(args: unknown[], flag: string): (string | undefined)[] {
  return args.flatMap((arg, index) => {
    if (typeof arg !== 'string' || (arg !== flag && !arg.startsWith(`${flag}=`))) return [];
    const value = arg === flag ? args[index + 1] : arg.slice(flag.length + 1);
    return [typeof value === 'string' && value && !value.startsWith('-') ? value : undefined];
  });
}
const configRoot = (profile: ServiceProfile, config: JsonObject) => typeof config.cwd === 'string' ? resolve(profile.installDir, config.cwd) : profile.installDir;
function weightPathKey(root: string, path: string): string {
  const resolved = resolve(root, path);
  // GGUF split files share one bundle; keep the stem, directory and shard count.
  const split = /^(.*)-(\d{5})-of-(\d{5})(\.gguf)$/i.exec(resolved);
  return split && Number(split[2]) > 0 && Number(split[2]) <= Number(split[3])
    ? `${split[1]}-00001-of-${split[3]}${split[4]}` : resolved;
}
export function modelAssetKey(profile: ServiceProfile, config?: JsonObject | null): string {
  if (!config) return profile.id;
  const root = configRoot(profile, config);
  const args = Array.isArray(config.args) ? config.args : [];
  // Match discovery's first-model precedence. PLE, vision and cache files are
  // companions/settings, and do not change the main language-model weights.
  for (const flag of primaryFlags) {
    const paths = optionPaths(args, flag);
    if (paths.length) return paths.length === 1 && paths[0] ? `weights:${weightPathKey(root, paths[0])}` : profile.id;
  }
  return profile.id;
}
export function groupModelProfiles(profiles: ServiceProfile[], details: LocalInstallationDetails[] = []) {
  const groups = new Map<string, { key: string; name: string; profiles: ServiceProfile[] }>();
  for (const profile of profiles) {
    const config = details.find(item => item.profileId === profile.id)?.config;
    const key = modelAssetKey(profile, config);
    const group = groups.get(key) ?? { key, name: typeof config?.model_name === 'string' ? config.model_name : profile.name, profiles: [] };
    group.profiles.push(profile); groups.set(key, group);
  }
  return [...groups.values()];
}

export interface LocalModelConfiguration {
  key: string;
  profile?: ServiceProfile;
  candidate?: LocalCandidate;
  configPath: string;
  config?: JsonObject | null;
  modifiedAt?: number | null;
  lastActivatedAt?: number | null;
}
export interface LocalModelGroup { key: string; name: string; configurations: LocalModelConfiguration[] }
/** Compare configuration paths, never display names. The supervisor resolves real paths during discovery. */
export const configurationPathKey = (path: string, root = '') => resolve(root, path);

/** Merge read-only discoveries with saved records without registering or starting any model. */
export function groupLocalModels(profiles: ServiceProfile[], candidates: LocalCandidate[] = [], details: LocalInstallationDetails[] = []): LocalModelGroup[] {
  const entries: LocalModelConfiguration[] = [];
  const byConfiguration = new Map<string, LocalModelConfiguration>();
  const weightAliases = new Map<string, string>();
  const candidateProfile = (candidate: LocalCandidate): ServiceProfile => ({ ...candidate, baseUrl: '', managed: true });
  const assetRoot = (key: string): string => {
    const alias = weightAliases.get(key);
    if (!alias || alias === key) return key;
    const root = assetRoot(alias); weightAliases.set(key, root); return root;
  };
  const aliasAssets = (first: string, second: string) => {
    const roots = [assetRoot(first), assetRoot(second)].sort();
    if (roots[0] !== roots[1]) weightAliases.set(roots[1]!, roots[0]!);
  };
  const pureWeightHashes = new Map<string, string>();
  for (const candidate of candidates) {
    const profile = candidateProfile(candidate);
    const asset = modelAssetKey(profile, candidate.config);
    const discoveredAsset = candidate.modelPath ? `weights:${weightPathKey(candidate.installDir, candidate.modelPath)}` : undefined;
    // Native hashes currently include --ple-gguf. Only use them as real-path
    // aliases when every hashed asset belongs to the same primary GGUF bundle.
    if (asset === profile.id || discoveredAsset !== asset || !candidate.modelGroupKey || !candidate.config) continue;
    const root = configRoot(profile, candidate.config);
    const args = Array.isArray(candidate.config.args) ? candidate.config.args : [];
    const hashedPaths = ['--native', '--model', '-m', '--ple-gguf'].flatMap(flag => optionPaths(args, flag));
    if (hashedPaths.some(path => !path || `weights:${weightPathKey(root, path)}` !== asset)) continue;
    const previous = pureWeightHashes.get(candidate.modelGroupKey);
    if (previous) aliasAssets(asset, previous);
    else pureWeightHashes.set(candidate.modelGroupKey, asset);
  }
  for (const profile of profiles) {
    const detail = details.find(item => item.profileId === profile.id);
    const entry: LocalModelConfiguration = { key: `profile:${profile.id}`, profile, configPath: profile.configPath, config: detail?.config, modifiedAt: detail?.configModifiedAt, lastActivatedAt: detail?.lastActivatedAt };
    entries.push(entry);
    if (entry.configPath) byConfiguration.set(configurationPathKey(entry.configPath, profile.installDir), entry);
    if (detail?.originalConfigPath) byConfiguration.set(configurationPathKey(detail.originalConfigPath, profile.installDir), entry);
  }
  for (const candidate of candidates) {
    const path = configurationPathKey(candidate.configPath, candidate.installDir);
    const found = byConfiguration.get(path);
    if (found) {
      found.candidate ??= candidate;
      if (found.config === undefined) found.config = candidate.config;
      if (!found.profile) found.modifiedAt ??= candidate.configModifiedAt;
      continue;
    }
    const entry: LocalModelConfiguration = { key: `candidate:${candidate.id}`, candidate, configPath: candidate.configPath, config: candidate.config, modifiedAt: candidate.configModifiedAt };
    entries.push(entry); byConfiguration.set(path, entry);
  }
  const groups = new Map<string, LocalModelGroup>();
  for (const entry of entries) {
    const source = entry.profile ?? candidateProfile(entry.candidate!);
    const asset = modelAssetKey(source, entry.config);
    // A saved copy may reference different weights than its original discovery.
    // Its current configuration remains authoritative; unknown discoveries can
    // still use their resolved model path before falling back to an opaque hash.
    const unreadDiscovery = !entry.profile && !entry.config ? entry.candidate : undefined;
    const discoveredAsset = unreadDiscovery?.modelPath ? `weights:${weightPathKey(source.installDir, unreadDiscovery.modelPath)}` : undefined;
    const key = asset !== source.id ? assetRoot(asset) : discoveredAsset ? assetRoot(discoveredAsset) : unreadDiscovery?.modelGroupKey ? `weight:${unreadDiscovery.modelGroupKey}` : entry.key;
    const name = typeof entry.config?.model_name === 'string' && entry.config.model_name ? entry.config.model_name : entry.candidate?.name ?? source.name;
    const group = groups.get(key) ?? { key, name, configurations: [] };
    group.configurations.push(entry); groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Upstream Strata keeps one `strata-<model>.json` per installed version while
 * every version shares the same `Strata-data` weights. These helpers only shape
 * the display: which version a configuration belongs to, which version is
 * current, and which copies are identical. Nothing here reads or writes files.
 */

const absolute = /^(?:[a-z]:[\\/]|[\\/]{2}|\/)/i;
/** Comparable key for an installation directory, without a trailing separator. */
export const installDirKey = (dir: string | undefined | null): string => dir ? configurationPathKey(dir).replace(/\/+$/, '') : '';

const versionParts = (version: string) => version.trim().replace(/^v/i, '').split(/[.\-+_]/).filter(Boolean);
/** Positive when `a` is newer. A known version is always newer than an unknown one. */
export function compareRuntimeVersions(a?: string | null, b?: string | null): number {
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  const left = versionParts(a), right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index], y = right[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x) ? Number(x) : NaN, ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) { if (nx !== ny) return nx - ny; continue; }
    if (!Number.isNaN(nx) !== !Number.isNaN(ny)) return Number.isNaN(nx) ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export const configurationInstallDir = (entry: LocalModelConfiguration): string => entry.profile?.installDir || entry.candidate?.installDir || '';

/** Installation directory → runtime version, from discovery first and detected runtimes second. */
export function runtimeVersionIndex(candidates: LocalCandidate[] = [], runtimes: Pick<DetectedRuntime, 'installDir' | 'runtimeVersion'>[] = []): Map<string, string> {
  const index = new Map<string, string>();
  for (const runtime of runtimes) if (runtime.runtimeVersion) index.set(installDirKey(runtime.installDir), runtime.runtimeVersion);
  for (const candidate of candidates) if (candidate.runtimeVersion) index.set(installDirKey(candidate.installDir), candidate.runtimeVersion);
  return index;
}

export const configurationVersion = (entry: LocalModelConfiguration, versions: Map<string, string>): string | undefined =>
  entry.candidate?.runtimeVersion ?? versions.get(installDirKey(configurationInstallDir(entry)));

export interface CurrentInstallInput {
  profiles: ServiceProfile[];
  candidates?: LocalCandidate[];
  runtimes?: Pick<DetectedRuntime, 'installDir' | 'runtimeVersion' | 'readiness'>[];
  activeId?: string;
  /** Whether the active profile is the service this application currently runs. */
  activeRunning?: boolean;
  lastUsedId?: string;
}

/** Running → last used → active profile → newest ready runtime → newest discovered version. */
export function resolveCurrentInstallDir(input: CurrentInstallInput): string | undefined {
  const dir = (id?: string) => id ? input.profiles.find(profile => profile.id === id)?.installDir || undefined : undefined;
  if (input.activeRunning) { const running = dir(input.activeId); if (running) return running; }
  const discoveredRunning = input.candidates?.find(candidate => candidate.running === true)?.installDir;
  if (discoveredRunning) return discoveredRunning;
  const remembered = dir(input.lastUsedId) ?? dir(input.activeId);
  if (remembered) return remembered;
  const newest = <T extends { installDir: string; runtimeVersion?: string }>(items: T[]) => [...items].sort((a, b) => compareRuntimeVersions(b.runtimeVersion, a.runtimeVersion))[0]?.installDir;
  return newest((input.runtimes ?? []).filter(runtime => runtime.readiness === 'ready')) ?? newest(input.candidates ?? []);
}

const PATH_KEYS = new Set(['exe', 'cwd', 'log', 'tokenizer', 'lib_dirs']);
/**
 * Settings identity of a configuration with installation-local paths written as
 * `<install>/…`, so two versions' copies of the same setup compare equal. Shared
 * weights keep their real paths: copies pointing at different files never merge.
 */
export function configurationFingerprint(entry: LocalModelConfiguration): string | undefined {
  const config = entry.config;
  if (!config || typeof config !== 'object') return undefined;
  const root = installDirKey(configurationInstallDir(entry));
  const local = (value: string, pathField: boolean): string => {
    if (!root) return value;
    if (absolute.test(value)) {
      const key = configurationPathKey(value);
      if (key === root) return '<install>';
      if (key.startsWith(`${root}/`)) return `<install>${key.slice(root.length)}`;
      return key;
    }
    // Relative path fields already resolve against the installation. Other
    // relative strings are compared as written; a group already shares weights.
    return pathField ? `<install>/${value.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')}` : value;
  };
  const walk = (value: unknown, pathField = false): unknown => {
    if (typeof value === 'string') return local(value, pathField);
    if (Array.isArray(value)) return value.map(item => walk(item, pathField));
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, walk((value as JsonObject)[key], PATH_KEYS.has(key))]));
    return value;
  };
  return JSON.stringify(walk(config));
}

export interface VersionedConfiguration {
  entry: LocalModelConfiguration;
  version?: string;
  installDir: string;
  /** Belongs to the current installation. */
  current: boolean;
  /** Other configurations with identical settings, shown collapsed under this row. */
  duplicates: { entry: LocalModelConfiguration; version?: string; installDir: string }[];
}

export interface FocusedModelGroup {
  /** Rows shown by default: the current version, or the newest copy when the current one has none. */
  primary: VersionedConfiguration[];
  /** Rows of other versions, collapsed under “Other versions”. Empty when every version is shown. */
  others: VersionedConfiguration[];
  /** True when the current installation has no configuration for this model. */
  fallback: boolean;
  /** Every configuration of the group, including merged duplicates. */
  total: number;
}

export interface FocusOptions {
  currentInstallDir?: string;
  versions: Map<string, string>;
  showAll?: boolean;
  /** Entry keys that always stay visible as their own row (running, selected, preparing…). */
  pinned?: Iterable<string>;
}

/** Version-aware view of one model group. Display only: every configuration remains reachable. */
export function focusModelGroup(group: LocalModelGroup, options: FocusOptions): FocusedModelGroup {
  const currentKey = installDirKey(options.currentInstallDir);
  const pinned = new Set(options.pinned ?? []);
  const rows = group.configurations.map(entry => {
    const installDir = configurationInstallDir(entry);
    return { entry, installDir, version: configurationVersion(entry, options.versions), current: !!currentKey && installDirKey(installDir) === currentKey };
  }).sort((a, b) => compareRuntimeVersions(b.version, a.version) || Number(b.current) - Number(a.current) || (b.entry.modifiedAt ?? 0) - (a.entry.modifiedAt ?? 0) || a.entry.configPath.localeCompare(b.entry.configPath));
  const buckets = new Map<string, typeof rows>();
  const representatives = new Set<(typeof rows)[number]>();
  for (const row of rows) {
    const fingerprint = configurationFingerprint(row.entry);
    if (fingerprint === undefined) { representatives.add(row); continue; }
    const bucket = buckets.get(fingerprint) ?? []; bucket.push(row); buckets.set(fingerprint, bucket);
  }
  const duplicatesOf = new Map<(typeof rows)[number], VersionedConfiguration['duplicates']>();
  for (const bucket of buckets.values()) {
    // Pinned rows stay, and so does the current version's own copy.
    const kept = bucket.filter(row => pinned.has(row.entry.key) || row === (bucket.find(item => item.current) ?? (bucket.some(item => pinned.has(item.entry.key)) ? undefined : bucket[0])));
    for (const row of kept) representatives.add(row);
    const merged = bucket.filter(row => !kept.includes(row)).map(({ entry, version, installDir }) => ({ entry, version, installDir }));
    if (merged.length) duplicatesOf.set(kept[0]!, merged);
  }
  const shown: VersionedConfiguration[] = rows.filter(row => representatives.has(row)).map(row => ({ ...row, duplicates: duplicatesOf.get(row) ?? [] }));
  const total = group.configurations.length;
  if (options.showAll) return { primary: shown, others: [], fallback: false, total };
  let primary = shown.filter(row => row.current);
  let fallback = false;
  if (!primary.length && shown.length) {
    const newest = installDirKey(shown[0]!.installDir);
    primary = shown.filter(row => installDirKey(row.installDir) === newest);
    fallback = true;
  }
  // A pinned row (for example the running configuration) is never hidden.
  primary = shown.filter(row => primary.includes(row) || pinned.has(row.entry.key));
  return { primary, others: shown.filter(row => !primary.includes(row)), fallback, total };
}

/** Number of configurations in other versions that the default view hides. */
export const hiddenVersionCount = (focused: FocusedModelGroup): number => focused.others.reduce((sum, row) => sum + 1 + row.duplicates.length, 0);
