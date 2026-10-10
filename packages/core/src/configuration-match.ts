import { configurationPathKey } from './model-groups';
import type { JsonObject, LocalCandidate, LocalInstallationDetails, ServiceProfile } from './types';

export type ConfigurationMatch = 'exact' | 'equivalent' | 'different' | 'unknown';
export type ConfigurationPathRelation = 'exact' | 'import-source' | 'none';
export interface ConfigurationDifference {
  /** JSON pointer, including array positions; an empty pointer denotes the whole value. */
  path: string;
  kind: 'value' | 'missing-running' | 'missing-candidate';
  runningValue?: unknown;
  candidateValue?: unknown;
}
export interface ConfigurationComparison {
  key: string;
  name: string;
  configPath: string;
  originalConfigPaths: string[];
  candidateIds: string[];
  profileIds: string[];
  match: ConfigurationMatch;
  pathRelation: ConfigurationPathRelation;
  contentMatch: 'equivalent' | 'different' | 'unknown';
  contentUnknownReason?: 'unreadable' | 'conflicting-snapshots';
  differences: ConfigurationDifference[];
  /** Masked credential values cannot be compared. Their presence is still compared. */
  ignoredPaths: string[];
}
export interface RunningConfigurationComparison {
  runningConfigPath: string;
  /** Only an observed config path can identify the file actually used by the process. */
  resolvedMatch?: ConfigurationComparison;
  exactMatches: ConfigurationComparison[];
  sourceMatches: ConfigurationComparison[];
  equivalentMatches: ConfigurationComparison[];
  /** Multiple matches at the strongest available level; timestamps never break a tie. */
  ambiguous: boolean;
  comparisons: ConfigurationComparison[];
}

const hidden = '[已隐藏]';
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const pointer = (path: string, key: string | number) => `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
// Mirrors discovery::display_config. No run-config field is assumed to be Manager metadata.
function credentialKey(key: string) {
  const lower = key.toLowerCase();
  return ['api_key', 'apikey', 'token', 'password', 'secret', 'authorization', 'credential', 'credentials'].includes(lower)
    || /_(?:key|token|secret)$/.test(lower) || lower.includes('password') || lower.includes('secret');
}
function displayValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(displayValue);
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, credentialKey(key) ? hidden : displayValue(child)]));
  return value;
}
function validJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!object(value) && !Array.isArray(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Object.values(value).every(child => validJson(child, seen));
  seen.delete(value);
  return valid;
}
function semanticConfig(config: JsonObject | null | undefined, root: string): JsonObject | undefined {
  if (!object(config) || !validJson(config)) return;
  if (Object.hasOwn(config, 'cwd') && typeof config.cwd !== 'string') return;
  // config_cwd resolves against the detected installation, and imports materialize
  // that same cwd as an absolute path. Other fields, including log/port, stay intact.
  const cwd = typeof config.cwd === 'string' ? configurationPathKey(config.cwd, root) : configurationPathKey(root);
  return { ...config, cwd };
}
function compareContents(running: JsonObject | undefined, candidate: JsonObject | undefined) {
  const differences: ConfigurationDifference[] = [];
  const ignoredPaths: string[] = [];
  if (!running || !candidate) return { contentMatch: 'unknown' as const, differences, ignoredPaths };
  const difference = (path: string, kind: ConfigurationDifference['kind'], first: unknown, second: unknown, secret = false) => {
    differences.push({ path, kind, runningValue: secret && first !== undefined ? hidden : displayValue(first), candidateValue: secret && second !== undefined ? hidden : displayValue(second) });
  };
  const visit = (first: unknown, second: unknown, path: string, key = '', sensitiveParent = false) => {
    const secret = sensitiveParent || credentialKey(key);
    if (secret && (first === hidden || second === hidden)) { ignoredPaths.push(path); return; }
    if (Object.is(first, second)) return;
    if (Array.isArray(first) && Array.isArray(second)) {
      for (let index = 0; index < Math.max(first.length, second.length); index++) {
        const child = pointer(path, index);
        if (index >= first.length) difference(child, 'missing-running', undefined, second[index], secret);
        else if (index >= second.length) difference(child, 'missing-candidate', first[index], undefined, secret);
        else visit(first[index], second[index], child, '', secret);
      }
    } else if (object(first) && object(second)) {
      for (const field of [...new Set([...Object.keys(first), ...Object.keys(second)])].sort()) {
        const child = pointer(path, field);
        if (!Object.hasOwn(first, field)) difference(child, 'missing-running', undefined, second[field], secret || credentialKey(field));
        else if (!Object.hasOwn(second, field)) difference(child, 'missing-candidate', first[field], undefined, secret || credentialKey(field));
        else visit(first[field], second[field], child, field, secret);
      }
    } else difference(path, 'value', first, second, secret);
  };
  visit(running, candidate, '');
  return { contentMatch: differences.length ? 'different' as const : 'equivalent' as const, differences, ignoredPaths };
}

interface Entry {
  key: string; name: string; configPath: string; root: string;
  snapshots: { config: JsonObject | null; root: string }[]; candidateIds: string[]; profileIds: string[];
  originalConfigPaths: string[];
}

function entryContent(entry: Entry): { configs?: JsonObject[]; contentUnknownReason?: ConfigurationComparison['contentUnknownReason'] } {
  const snapshots = entry.snapshots.map(snapshot => semanticConfig(snapshot.config, snapshot.root));
  if (!snapshots.length || snapshots.some(config => !config)) return { contentUnknownReason: 'unreadable' };
  const configs = snapshots as JsonObject[];
  // A masked value is compatible with either raw value, but that does not make
  // two different raw values equal. Compare every pair, never the first snapshot.
  for (let first = 0; first < configs.length; first++) {
    for (let second = first + 1; second < configs.length; second++) {
      if (compareContents(configs[first], configs[second]).contentMatch === 'different') return { contentUnknownReason: 'conflicting-snapshots' };
    }
  }
  return { configs };
}
function compareSnapshots(running: JsonObject | undefined, snapshots: JsonObject[] | undefined) {
  if (!running || !snapshots) return compareContents(undefined, undefined);
  const compared = snapshots.map(config => compareContents(running, config));
  const differences = [...new Map(compared.flatMap(result => result.differences).map(difference => [JSON.stringify(difference), difference])).values()];
  differences.sort((first, second) => first.path.localeCompare(second.path));
  const ignoredPaths = [...new Set(compared.flatMap(result => result.ignoredPaths))].sort();
  return { contentMatch: differences.length ? 'different' as const : 'equivalent' as const, differences, ignoredPaths };
}

/** Pure comparison of read-only snapshots. It never reads files, registers a service, or selects a model. */
export function compareRunningConfiguration(
  running: LocalCandidate,
  candidates: LocalCandidate[],
  profiles: ServiceProfile[] = [],
  details: LocalInstallationDetails[] = [],
): RunningConfigurationComparison {
  const entries = new Map<string, Entry>();
  for (const profile of profiles) {
    const key = configurationPathKey(profile.configPath, profile.installDir);
    if (!profile.configPath.trim()) continue;
    const detail = details.find(record => record.profileId === profile.id);
    const entry = entries.get(key) ?? { key, name: profile.name, configPath: profile.configPath, root: profile.installDir, snapshots: [], candidateIds: [], profileIds: [], originalConfigPaths: [] };
    if (detail?.config !== undefined) entry.snapshots.push({ config: detail.config, root: profile.installDir });
    if (!entry.profileIds.includes(profile.id)) entry.profileIds.push(profile.id);
    if (detail?.originalConfigPath && !entry.originalConfigPaths.includes(detail.originalConfigPath)) entry.originalConfigPaths.push(detail.originalConfigPath);
    entries.set(key, entry);
  }
  for (const candidate of candidates) {
    if (!candidate.configPath.trim()) continue;
    const key = configurationPathKey(candidate.configPath, candidate.installDir);
    const entry = entries.get(key) ?? { key, name: candidate.name, configPath: candidate.configPath, root: candidate.installDir, snapshots: [], candidateIds: [], profileIds: [], originalConfigPaths: [] };
    // Explicit null means the registered copy was unreadable; do not silently
    // replace it with an original or an older discovered snapshot.
    if (candidate.config !== undefined) entry.snapshots.push({ config: candidate.config, root: candidate.installDir });
    if (!entry.candidateIds.includes(candidate.id)) entry.candidateIds.push(candidate.id);
    entries.set(key, entry);
  }
  const runningPath = running.configPath.trim() ? configurationPathKey(running.configPath, running.installDir) : undefined;
  const sourcePaths = new Set<string>();
  for (const entry of entries.values()) {
    if (entry.key === runningPath) for (const path of entry.originalConfigPaths) sourcePaths.add(configurationPathKey(path, entry.root));
  }
  const config = semanticConfig(running.config, running.installDir);
  const comparisons: ConfigurationComparison[] = [...entries.values()].map(entry => {
    const pathRelation: ConfigurationPathRelation = entry.key === runningPath ? 'exact'
      : sourcePaths.has(entry.key) ? 'import-source' : 'none';
    const content = entryContent(entry);
    const compared = compareSnapshots(config, content.configs);
    return {
      key: entry.key, name: entry.name, configPath: entry.configPath,
      originalConfigPaths: entry.originalConfigPaths, candidateIds: entry.candidateIds, profileIds: entry.profileIds,
      pathRelation, match: pathRelation === 'exact' ? 'exact' : compared.contentMatch,
      contentUnknownReason: compared.contentMatch === 'unknown' ? !config ? 'unreadable' : content.contentUnknownReason : undefined,
      ...compared,
    };
  });
  const exactMatches = comparisons.filter(entry => entry.pathRelation === 'exact');
  const sourceMatches = comparisons.filter(entry => entry.pathRelation === 'import-source');
  const equivalentMatches = comparisons.filter(entry => entry.pathRelation !== 'exact' && entry.contentMatch === 'equivalent');
  const strongest = exactMatches.length ? exactMatches : sourceMatches.length ? sourceMatches : equivalentMatches;
  return {
    runningConfigPath: running.configPath, resolvedMatch: exactMatches.length === 1 ? exactMatches[0] : undefined,
    exactMatches, sourceMatches, equivalentMatches, ambiguous: strongest.length > 1, comparisons,
  };
}
