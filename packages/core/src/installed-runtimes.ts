// Installed Strata versions: list, delete, 一键清理 and switching between them.
// The background service decides what is protected; the UI only shows and confirms.
import { MODEL_CATALOG } from './catalog';
import { compareReleaseVersions, runtimeReleaseOf, type RuntimeReleaseVersion } from './runtime-versions';

export interface RuntimeReference { id: string; name: string }
export interface InstalledRuntime {
  installDir: string; pythonPath: string;
  releaseVersion?: string; engineVersion?: string;
  readiness: string;
  /** Installed by Manager in its own runtimes folder; only these can be deleted. */
  owned: boolean;
  current: boolean; running: boolean;
  /** Kept as the version to switch back to. */
  rollback: boolean;
  switching: boolean;
  profiles: RuntimeReference[];
  installedAt?: number; lastUsedAt?: number;
  /** Selected by 一键清理 (keeps the current version + 1). */
  cleanup: boolean;
  /** Why 删除 is unavailable. */
  protectedReason?: string;
}
export type RuntimeLeftoverKind = 'partialDownload' | 'archive' | 'failedInstall' | 'trash' | 'updateWork';
export interface RuntimeLeftover { path: string; kind: RuntimeLeftoverKind }
export interface RuntimeInventory { runtimes: InstalledRuntime[]; leftovers: RuntimeLeftover[]; autoCleanup: boolean; busy: boolean }
export interface RuntimeCleanupResult { removed: string[]; skipped: { path: string; reason: string }[]; freedBytes: number }

/** Store key of 「更新成功后自动清理旧版本」; missing means on. */
export const RUNTIME_AUTO_CLEANUP_KEY = 'runtimeAutoCleanup';

const facts = (runtime: InstalledRuntime) => ({ releaseVersion: runtime.releaseVersion, runtimeVersion: runtime.engineVersion });
type Releases = Pick<RuntimeReleaseVersion, 'version' | 'engineVersion' | 'prerelease'>[];

/** The release a listed runtime is, from its own record or the release that shipped its engine. */
export const installedRuntimeRelease = (runtime: InstalledRuntime, releases: Releases = []) => runtimeReleaseOf(facts(runtime), releases);

/** A complete local copy of `version` that is not the one in use: switch instead of downloading. */
export function installedRuntimeForRelease(inventory: RuntimeInventory | undefined, version: string, releases: Releases = []): InstalledRuntime | undefined {
  return inventory?.runtimes.find(runtime => {
    const release = installedRuntimeRelease(runtime, releases);
    return !runtime.current && runtime.readiness === 'ready' && !!runtime.pythonPath && !!release && compareReleaseVersions(release, version) === 0;
  });
}

/** Newest first; the version in use leads. */
export function sortInstalledRuntimes(runtimes: InstalledRuntime[], releases: Releases = []): InstalledRuntime[] {
  return [...runtimes].sort((a, b) => Number(b.current) - Number(a.current)
    || compareReleaseVersions(installedRuntimeRelease(b, releases) ?? b.engineVersion, installedRuntimeRelease(a, releases) ?? a.engineVersion)
    || (b.installedAt ?? 0) - (a.installedAt ?? 0));
}

/** The local version an engine crash can fall back to: the one kept for switching back, else the newest older one. */
export function installedRollbackTarget(inventory: RuntimeInventory | undefined, releases: Releases = []): InstalledRuntime | undefined {
  const runtimes = inventory?.runtimes ?? [];
  const current = runtimes.find(runtime => runtime.current);
  const usable = runtimes.filter(runtime => !runtime.current && !runtime.switching && runtime.readiness === 'ready' && !!runtime.pythonPath);
  const version = (runtime: InstalledRuntime) => installedRuntimeRelease(runtime, releases) ?? runtime.engineVersion;
  const older = current ? usable.filter(runtime => compareReleaseVersions(version(runtime), version(current)) < 0) : usable;
  return older.find(runtime => runtime.rollback) ?? sortInstalledRuntimes(older, releases)[0];
}

/** What 一键清理 deletes: older Manager versions plus leftovers. */
export const cleanupPaths = (inventory: RuntimeInventory | undefined): string[] =>
  inventory ? [...inventory.runtimes.filter(runtime => runtime.cleanup).map(runtime => runtime.installDir), ...inventory.leftovers.map(item => item.path)] : [];

/** Sum of the known sizes; `undefined` while any is still being measured. */
export function totalBytes(paths: string[], sizes: Record<string, number | undefined>): number | undefined {
  let total = 0;
  for (const path of paths) {
    const size = sizes[path];
    if (size === undefined) return undefined;
    total += size;
  }
  return total;
}

export function formatRuntimeBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '…';
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export interface ModelMinEngineRequirement {
  label: string;
  minEngine: string;
}

const V31_FOUR_SHARD_RE = /UD-IQ4_XS-0000[1-4]-of-00004\.gguf/i;
const QWEN36_RE = /\bqwen3\.?6\b|qwen35moe/i;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface CatalogMinEngineRule {
  label: string;
  minEngine: string;
  pattern: RegExp;
}

const QWEN36_CATALOG = MODEL_CATALOG.find(model => model.family === 'qwen36');
const UNSLOTH_V31_IQ4_MIN_ENGINE = MODEL_CATALOG.find(model => model.family === 'unsloth')?.quantInfo['UD-IQ4_XS-v31']?.minEngine;

/** Derived from `MODEL_CATALOG` in `catalog.ts` (longest quant token first so specific variants match before prefixes). */
const CATALOG_QUANT_RULES: readonly CatalogMinEngineRule[] = (() => {
  const rules: (CatalogMinEngineRule & { keyLen: number })[] = [];
  for (const model of MODEL_CATALOG) {
    if (model.family === 'deepseek41' || model.family === 'qwen36') continue;
    for (const quant of model.quants) {
      const minEngine = model.quantInfo[quant]?.minEngine ?? model.minEngine;
      if (!minEngine || quant === 'Q8_0') continue;
      const flexQuant = escapeRegex(quant).replace(/[-_]/g, '[-_]');
      rules.push({
        label: quant,
        minEngine,
        keyLen: quant.length,
        pattern: new RegExp(`(?:^|[^A-Za-z0-9])(${flexQuant})(?=$|[^A-Za-z0-9])`, 'i'),
      });
    }
  }
  return rules.sort((a, b) => b.keyLen - a.keyLen);
})();

function matchMinEngineFromText(evidence: string): ModelMinEngineRequirement | null {
  if (!evidence.trim() || /\bdeepseek/i.test(evidence)) return null;
  if (QWEN36_CATALOG?.minEngine && QWEN36_RE.test(evidence)) {
    return { label: QWEN36_CATALOG.name, minEngine: QWEN36_CATALOG.minEngine };
  }
  if (UNSLOTH_V31_IQ4_MIN_ENGINE && V31_FOUR_SHARD_RE.test(evidence)) {
    return { label: 'UD-IQ4_XS-v31', minEngine: UNSLOTH_V31_IQ4_MIN_ENGINE };
  }
  for (const rule of CATALOG_QUANT_RULES) {
    if (rule.pattern.test(evidence)) {
      return { label: rule.label, minEngine: rule.minEngine };
    }
  }
  return null;
}

/**
 * Infers a model's minimum Strata engine version from a config or profile object (prioritizing real config fields
 * `model_name`, `arch`, `args`, `user_args`, and `configPath` before falling back to a display `name`), derived from
 * `MODEL_CATALOG` in `catalog.ts`. DeepSeek configs run `strata-dsv41` and return null here.
 */
export function modelMinEngineOf(input: string | Record<string, unknown> | null | undefined): ModelMinEngineRequirement | null {
  if (!input) return null;
  if (typeof input === 'string') return matchMinEngineFromText(input);
  if (typeof input !== 'object') return null;
  const nestedConfig = input.config && typeof input.config === 'object' && !Array.isArray(input.config)
    ? (input.config as Record<string, unknown>)
    : null;
  const arch = nestedConfig?.arch ?? input.arch;
  if (arch === 'deepseek41') return null;
  const collectArgs = (obj: Record<string, unknown> | null) => {
    if (!obj) return '';
    const raw = Array.isArray(obj.args) ? obj.args.filter(x => typeof x === 'string').join(' ') : '';
    const user = Array.isArray(obj.user_args) ? obj.user_args.filter(x => typeof x === 'string').join(' ') : '';
    return `${raw} ${user}`.trim();
  };
  const structuredEvidence = [
    nestedConfig?.model_name,
    input.model_name,
    arch,
    collectArgs(nestedConfig),
    collectArgs(input),
    nestedConfig?.configPath,
    input.configPath,
  ]
    .filter(x => typeof x === 'string' && x.trim())
    .join(' ');
  if (structuredEvidence) {
    if (/\bdeepseek/i.test(structuredEvidence)) return null;
    const matched = matchMinEngineFromText(structuredEvidence);
    if (matched) return matched;
    // If real model_name or args are present and have no minEngine gate, do not let a user-edited display name override them.
    const hasAuthoritativeModelField = [nestedConfig?.model_name, input.model_name, collectArgs(nestedConfig), collectArgs(input)]
      .some(x => typeof x === 'string' && x.trim().length > 0);
    if (hasAuthoritativeModelField) return null;
  }
  const fallbackName = typeof input.name === 'string' ? input.name : '';
  return matchMinEngineFromText(fallbackName);
}

/**
 * Returns a concise bilingual warning when any model in `models` requires a newer engine than `targetEngineVersion`
 * (for example, Unsloth v3.1 requires 0.1.57 when rolling back to 0.1.55 / 0.1.56); null when compatible or unknown.
 */
export function engineRollbackCompatibilityWarning(
  targetEngineVersion: string | null | undefined,
  models: Iterable<string | Record<string, unknown> | null | undefined>,
  zh: boolean,
): string | null {
  const target = targetEngineVersion?.trim().replace(/^v/i, '');
  if (!target || !/^\d+\.\d+\.\d+/.test(target)) return null;
  for (const item of models) {
    const req = modelMinEngineOf(item);
    if (req && compareReleaseVersions(target, req.minEngine) < 0) {
      return zh
        ? `当前模型（${req.label}）最低需引擎 ${req.minEngine}，回退到引擎 ${target} 需换回老格式模型。`
        : `The current model (${req.label}) requires engine ${req.minEngine}+; rolling back to engine ${target} requires switching to an older-format model.`;
    }
  }
  return null;
}

/** Concise retention rule note (keeps current + 1 previous version). */
export function engineRollbackRetentionNote(zh: boolean): string {
  return zh
    ? '自动清理只保留当前版本 + 1 个旧版本（运行中或被配置引用的版本受保护），多次更新后不保证更早版本长期保留。'
    : 'Automatic cleanup keeps only the current version + 1 previous version (running or referenced versions stay protected), so earlier versions are not kept permanently.';
}

