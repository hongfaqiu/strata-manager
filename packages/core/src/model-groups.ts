import type { JsonObject, LocalCandidate, LocalInstallationDetails, ServiceProfile } from './types';

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
