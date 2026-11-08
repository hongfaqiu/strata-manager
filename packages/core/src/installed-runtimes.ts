// Installed Strata versions: list, delete, 一键清理 and switching between them.
// The background service decides what is protected; the UI only shows and confirms.
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

const V31_QUANT_RE = /(?:^|[^A-Za-z0-9])(UD-(?:IQ1_M|Q2_0|IQ2_XS|Q2_K_XL|IQ3_XXS|Q3_K_XL|IQ4_XS-v31))(?=$|[^A-Za-z0-9])/i;
const V31_FOUR_SHARD_RE = /UD-IQ4_XS-0000[1-4]-of-00004\.gguf/i;
const QWEN36_RE = /\bqwen3\.?6\b|qwen35moe/i;
const NVFP4_QAD_RE = /\bNVFP4-QAD\b/i;
const NVFP4_RE = /\bNVFP4(?:-NVIDIA)?\b/i;
const UD_Q5_Q6_RE = /\b(UD-Q[56]_K_XL)\b/i;

/**
 * Infers a model's minimum Strata engine version from a profile name, model_name, or config object
 * (aligned with `MODEL_CATALOG` in `catalog.ts`: Unsloth Dynamic v3.1 requires 0.1.57, Qwen3.6 / NVFP4-QAD 0.1.45,
 * NVFP4 / UD-Q5_K_XL / UD-Q6_K_XL 0.1.44). DeepSeek configs run `strata-dsv41` and return null here.
 */
export function modelMinEngineOf(input: string | Record<string, unknown> | null | undefined): ModelMinEngineRequirement | null {
  if (!input) return null;
  let evidence = '';
  if (typeof input === 'string') {
    evidence = input;
  } else if (typeof input === 'object') {
    if (input.arch === 'deepseek41') return null;
    const args = Array.isArray(input.args) ? input.args.filter(x => typeof x === 'string').join(' ') : '';
    evidence = [input.name, input.model_name, input.configPath, args].filter(x => typeof x === 'string').join(' ');
  }
  if (!evidence.trim() || /\bdeepseek/i.test(evidence)) return null;
  const v31 = V31_QUANT_RE.exec(evidence);
  if (v31) {
    const raw = v31[1]!;
    const label = /^ud-iq4_xs-v31$/i.test(raw) ? 'UD-IQ4_XS-v31' : raw.toUpperCase();
    return { label, minEngine: '0.1.57' };
  }
  if (V31_FOUR_SHARD_RE.test(evidence)) return { label: 'UD-IQ4_XS-v31', minEngine: '0.1.57' };
  if (QWEN36_RE.test(evidence)) return { label: 'Qwen3.6-35B-A3B', minEngine: '0.1.45' };
  if (NVFP4_QAD_RE.test(evidence)) return { label: 'NVFP4-QAD', minEngine: '0.1.45' };
  if (NVFP4_RE.test(evidence)) return { label: 'NVFP4', minEngine: '0.1.44' };
  const q56 = UD_Q5_Q6_RE.exec(evidence);
  if (q56) return { label: q56[1]!.toUpperCase(), minEngine: '0.1.44' };
  return null;
}

/**
 * Returns a bilingual warning when any model in `models` requires a newer engine than `targetEngineVersion`
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
        ? `当前模型（${req.label}）最低需要引擎 ${req.minEngine}，所选旧版本（引擎 ${target}）无法直接运行它；回退到 0.1.55 / 0.1.56 需同时换回老格式模型。`
        : `The current model (${req.label}) requires engine ${req.minEngine}+ and cannot run on engine ${target}; rolling back to 0.1.55 / 0.1.56 requires switching back to an older-format model.`;
    }
  }
  return null;
}

/** Concise compatibility & retention explanation shown at engine rollback / version selection entries (U10A). */
export function engineRollbackRetentionNote(zh: boolean): string {
  return zh
    ? 'Unsloth v3.1 新模型最低需引擎 0.1.57，回退到 0.1.55 / 0.1.56 需换回老格式模型；开启自动清理时只保留当前版本 + 1 个旧版本（运行中或被配置引用的版本受保护），多次更新后不保证更早版本永久保留。'
    : 'Unsloth v3.1 models require engine 0.1.57+ (rolling back to 0.1.55 / 0.1.56 requires an older-format model). Automatic cleanup keeps only the current version + 1 previous version (running or referenced versions stay protected), so older versions are not kept permanently across multiple updates.';
}

