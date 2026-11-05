/** Snapshot of official setup.py MODELS / FAMILIES / OWN_PATH_FAMILIES.
 * Checked against Niko1221/Strata v0.2.11 (docs/MODELS.md, setup.py MODELS / OWN_PATH_FAMILIES).
 * Runtime versions can differ; qwen36 needs >= 0.1.45; Unsloth v3.1 needs >= 0.1.57; UD-Q5/Q6 need >= 0.1.44. */
export const UPSTREAM_REVISION = 'c3b3f5035506f3e966f1b4b7b188aeaabae92f1d';
export type CatalogFamily = 'qwen' | 'swift' | 'coder' | 'unsloth' | 'qwen36' | 'deepseek41';
export interface CatalogQuantInfo {
  downloadGB: number;
  ramGB: number;
  experimental?: boolean;
  nvidiaOnly?: boolean;
  visionUntested?: boolean;
  /** Minimum Strata engine for this quant (semver), from setup.py MODELS[*].engine. */
  minEngine?: string;
  /** Never the automatic pick (dsv41_fit.recommend never returns it); shown with 「仅手动选择」. */
  manualOnly?: boolean;
  /** Perplexity loss against the full model (dsv41_fit ISTA_SETS[*].ppl), shown as quality. */
  qualityLoss?: string;
  /** GB of routed experts (dsv41_fit ISTA_SETS[*].experts_gb): all of them fit in RAM at experts + 9 GB. */
  expertsGB?: number;
  /** Strata release (setup.py PRODUCT_VERSION) whose installer first takes this quant; hidden for an older or unknown release. */
  minRelease?: string;
  /** What upstream says of the quality when it has no measured perplexity (dsv41_fit ISTA_SETS[*].quality, release notes). */
  qualityNote?: { zh: string; en: string };
}
export interface CatalogModel {
  id: string;
  family: CatalogFamily;
  name: string;
  quants: string[];
  images: boolean;
  source: string;
  snapshotDate: string;
  /** Minimum Strata engine version that can install/run this family (semver). */
  minEngine?: string;
  /** Minimum Strata release (setup.py PRODUCT_VERSION, not the engine build) that ships this family's installer. */
  minRelease?: string;
  /** Fixed launch context (the installer accepts no other); the download page shows no context choice. */
  fixedContext?: number;
  /**
   * From this Strata release on, `fixedContext` is only the default: the installer takes the family's own context
   * choices (DeepSeek: deepseek41-context, 8K to 1M). Older or unknown releases keep the fixed context.
   */
  contextChoicesRelease?: string;
  quantInfo: Record<string, CatalogQuantInfo>;
}

const source = `https://github.com/Niko1221/Strata/blob/${UPSTREAM_REVISION}/setup.py`;
const DEEPSEEK41_SOURCE = 'https://github.com/Niko1221/Strata/blob/v0.2.9/setup.py';
const snapshotDate = '2026-11-05';
export const MODEL_CATALOG: CatalogModel[] = [
  { id: 'qwen', family: 'qwen', name: 'Qwen3.8-Flash-Next', quants: ['Q2_0', 'IQ2_XS', 'IQ3_XXS', 'IQ3_S'], images: true, source, snapshotDate,
    quantInfo: { Q2_0: { downloadGB: 66.4, ramGB: 48 }, IQ2_XS: { downloadGB: 68, ramGB: 48 }, IQ3_XXS: { downloadGB: 75.8, ramGB: 60 }, IQ3_S: { downloadGB: 83.6, ramGB: 62 } } },
  { id: 'swift', family: 'swift', name: 'Swift 1.5', quants: ['IQ2_XS', 'IQ3_XXS', 'IQ3_S'], images: true, source, snapshotDate,
    quantInfo: { IQ2_XS: { downloadGB: 68, ramGB: 48 }, IQ3_XXS: { downloadGB: 75.8, ramGB: 60 }, IQ3_S: { downloadGB: 83.6, ramGB: 62 } } },
  { id: 'coder', family: 'coder', name: 'Qwen3.8-Flash-Next Coder', quants: ['IQ1_M'], images: true, source, snapshotDate,
    quantInfo: { IQ1_M: { downloadGB: 58.4, ramGB: 32 } } },
  // Unsloth: setup.py MODELS — download_gb / ram_gb. Dynamic v3.1 (engine 0.1.57, Strata 0.2.11): seven new sets;
  // UD-IQ4_XS-v31 is a new catalog name (Hub files still named UD-IQ4_XS, four shards); old UD-IQ4_XS stays three shards.
  // Vision on for all (setup vision: True). UD-Q4_K_XL historical Manager flags kept.
  { id: 'unsloth', family: 'unsloth', name: 'Qwen3.8-Flash-Next (Unsloth)', quants: [
      'UD-IQ1_M', 'UD-Q2_0', 'UD-IQ2_XS', 'UD-Q2_K_XL', 'UD-IQ3_XXS', 'UD-Q3_K_XL', 'UD-IQ4_XS-v31',
      'UD-IQ4_XS', 'UD-Q4_K_XL', 'UD-Q5_K_XL', 'UD-Q6_K_XL', 'Q8_0',
    ], images: true, source, snapshotDate,
    quantInfo: {
      'UD-IQ1_M': { downloadGB: 68.0, ramGB: 48, minEngine: '0.1.57' },
      'UD-Q2_0': { downloadGB: 70.5, ramGB: 48, minEngine: '0.1.57' },
      'UD-IQ2_XS': { downloadGB: 75.8, ramGB: 48, minEngine: '0.1.57' },
      'UD-Q2_K_XL': { downloadGB: 79.6, ramGB: 48, minEngine: '0.1.57' },
      'UD-IQ3_XXS': { downloadGB: 83.6, ramGB: 48, minEngine: '0.1.57' },
      'UD-Q3_K_XL': { downloadGB: 89.5, ramGB: 48, minEngine: '0.1.57' },
      'UD-IQ4_XS-v31': { downloadGB: 93.7, ramGB: 48, minEngine: '0.1.57' },
      'UD-IQ4_XS': { downloadGB: 93.7, ramGB: 48 },
      'UD-Q4_K_XL': { downloadGB: 111.3, ramGB: 48, experimental: true, nvidiaOnly: true, visionUntested: true },
      'UD-Q5_K_XL': { downloadGB: 158.3, ramGB: 108, minEngine: '0.1.44' },
      'UD-Q6_K_XL': { downloadGB: 169.2, ramGB: 118, minEngine: '0.1.44' },
      Q8_0: { downloadGB: 188.2, ramGB: 136, minEngine: '0.1.38' },
    } },
  // OWN_PATH_FAMILIES qwen36: Unsloth MTP GGUFs, single file, no pack/MTP draft fetch.
  // Sizes: QWEN36_FILES bytes / 1e9; RAM: OWN_PATH_FAMILIES.models[*].ram_gb; engine MIN_ENGINE (0,1,45).
  { id: 'qwen36', family: 'qwen36', name: 'Qwen3.6-35B-A3B', quants: ['UD-Q4_K_XL', 'UD-Q6_K_XL', 'Q8_0'], images: true, source, snapshotDate, minEngine: '0.1.45',
    quantInfo: { 'UD-Q4_K_XL': { downloadGB: 22.9, ramGB: 32 }, 'UD-Q6_K_XL': { downloadGB: 32.6, ramGB: 44 }, Q8_0: { downloadGB: 37.8, ramGB: 52 } } },
  // Strata v0.2.5+ setup.py --family deepseek41 (IST-DAS sets) and strata_control/dsv41_fit.py ISTA_SETS, checked at v0.2.6.
  // downloadGB: four shards + the shared Engram table, meta and DSpark drafter (downloaded once for every set) / 1e9.
  // ramGB: ISTA_SETS[*].ram_ok_gb (below it the experts are read from the SSD: slow, still allowed). Text only.
  // Context: 8K on 0.2.5/0.2.6; Strata 0.2.7 (dsv41_context.py) takes 8K to 1M, 8K stays the default.
  // Strata 0.2.9 (#4814): Unsloth's UD-IQ1_S / UD-IQ1_M (setup.py DSV41_UD_FILES, dsv41_fit ISTA_SETS["UD-IQ1_*"]): shards 1-4 + the
  // shared Engram and DSpark (their shard 5 is the Engram; no metadata shard of their own). recommend() never returns them.
  { id: 'deepseek41', family: 'deepseek41', name: 'DeepSeek-V4.1-Flash', quants: ['IST-DAS-2.00bpw', 'IST-DAS-1.75bpw', 'IST-DAS-2.25bpw', 'UD-IQ1_S', 'UD-IQ1_M'], images: false,
    source: DEEPSEEK41_SOURCE, snapshotDate: '2026-10-26', minRelease: '0.2.5', fixedContext: 8192, contextChoicesRelease: '0.2.7',
    quantInfo: {
      'IST-DAS-2.00bpw': { downloadGB: 256.8, ramGB: 40, expertsGB: 132.07, qualityLoss: '+15.5%' },
      'IST-DAS-1.75bpw': { downloadGB: 239.3, ramGB: 34, expertsGB: 114.56, qualityLoss: '+21%' },
      'IST-DAS-2.25bpw': { downloadGB: 273.8, ramGB: 44, expertsGB: 149.06, qualityLoss: '+7.3%', manualOnly: true },
      'UD-IQ1_S': { downloadGB: 241.0, ramGB: 36, expertsGB: 115.23, manualOnly: true, minRelease: '0.2.9',
        qualityNote: { zh: 'Unsloth 最小的动态量化，与 IST-DAS 1.75 bpw 同等大小；上游未测困惑度，任务测试 61 项答对 53 项（IST-DAS 2.25 为 56 项），尚未在 Windows 和 Strix Halo 上测试。', en: 'Unsloth\'s smallest dynamic quant, the size of IST-DAS 1.75 bpw; upstream has not measured its perplexity; 53 of 61 test tasks right (IST-DAS 2.25: 56); not yet tested on Windows or Strix Halo.' } },
      'UD-IQ1_M': { downloadGB: 258.4, ramGB: 40, expertsGB: 132.21, manualOnly: true, minRelease: '0.2.9',
        qualityNote: { zh: 'Unsloth 的下一档动态量化，与 IST-DAS 2.00 bpw 同等大小；上游未测困惑度，任务测试 61 项答对 53 项（IST-DAS 2.25 为 56 项），尚未在 Windows 和 Strix Halo 上测试。', en: 'Unsloth\'s next dynamic quant, the size of IST-DAS 2.00 bpw; upstream has not measured its perplexity; 53 of 61 test tasks right (IST-DAS 2.25: 56); not yet tested on Windows or Strix Halo.' } },
    } },
];

/** Qwen3.6-35B-A3B run configs (setup.py OWN_PATH_FAMILIES: arch "qwen35moe"). */
export function isQwen36Config(config: { arch?: unknown } | null | undefined): boolean {
  return !!config && config.arch === 'qwen35moe';
}

/** setup.py DISK_HEADROOM_GB for deepseek41: setup warns below download + 6 GB; Manager requires it. */
export const DEEPSEEK41_DISK_HEADROOM_GB = 6;
/** Engine build that first accepts `--experts` (the speed choice). */
export const DEEPSEEK41_EXPERTS_MIN_ENGINE = '0.1.50';

/** Whether `have` is at least `want` (dotted numbers; a missing or unparsable version is not). */
export function versionAtLeast(have: string | null | undefined, want: string): boolean {
  if (!have) return false;
  const parts = (v: string) => v.trim().replace(/^v/i, '').split(/[.\-+_]/).filter(Boolean);
  const left = parts(have), right = parts(want);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i], y = right[i];
    if (x === undefined) return false;
    if (y === undefined) return true;
    const nx = /^\d+$/.test(x) ? Number(x) : NaN, ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx > ny;
      continue;
    }
    if (x !== y) return x > y;
  }
  return true;
}

/** A catalog model with only the quants this Strata release's installer takes (quantInfo minRelease; all of them when no runtime is chosen). */
export function catalogQuantsForRelease<T extends CatalogModel>(model: T, releaseVersion?: string | null, runtimeChosen = true): T {
  if (!runtimeChosen) return model;
  const quants = model.quants.filter(quant => {
    const need = model.quantInfo[quant]?.minRelease;
    return !need || versionAtLeast(releaseVersion, need);
  });
  return quants.length === model.quants.length ? model : { ...model, quants };
}

/** Strata release gate for a family (minRelease): null when none; ok=false when the release is unknown or older. */
export function catalogReleaseGate(family: string, releaseVersion?: string | null): { minRelease: string; ok: boolean } | null {
  const model = MODEL_CATALOG.find(entry => entry.family === family);
  if (!model?.minRelease) return null;
  return { minRelease: model.minRelease, ok: versionAtLeast(releaseVersion, model.minRelease) };
}

/** Disk a full deepseek41 set download needs, in GB (download + headroom), when nothing is on disk yet. */
export function deepseek41DiskNeedGB(quant: string): number | null {
  const info = MODEL_CATALOG.find(entry => entry.family === 'deepseek41')?.quantInfo[quant];
  return info ? Math.round((info.downloadGB + DEEPSEEK41_DISK_HEADROOM_GB) * 10) / 10 : null;
}

/** dsv41_fit.recommend(): 1.75 below 40 GiB of RAM, or when only 1.75 fits the free disk (GB, 10^9 bytes); otherwise 2.00. 2.25 is never automatic. */
export function recommendDeepseek41(ramGB?: number | null, diskFreeGB?: number | null): string {
  const need = (quant: string) => deepseek41DiskNeedGB(quant)!;
  if (ramGB != null && ramGB < 40) return 'IST-DAS-1.75bpw';
  if (diskFreeGB != null && diskFreeGB < need('IST-DAS-2.00bpw') && diskFreeGB >= need('IST-DAS-1.75bpw')) return 'IST-DAS-1.75bpw';
  return 'IST-DAS-2.00bpw';
}

/**
 * dsv41_fit RAM class, the one judgment the catalog card, the quantization table and the download panel share
 * (desktop quantFitState): fits (all experts + 9 GiB cached), tight (ram_ok_gb: the most-used experts cached, the rest
 * read from the model files), spills (most experts read from the SSD, slow but allowed). RAM is GiB, as setup.py's
 * ram_gb() measures it (2**30) and compares with these numbers. dsv41_fit subtracts the experts a card holds first; the
 * catalog does not know the card split, so it counts them all (never more optimistic than setup).
 */
export function deepseek41MemoryClass(quant: string, ramGB?: number | null): 'fits' | 'tight' | 'spills' | 'unknown' {
  const info = MODEL_CATALOG.find(entry => entry.family === 'deepseek41')?.quantInfo[quant];
  if (!info?.expertsGB || ramGB == null || !Number.isFinite(ramGB)) return 'unknown';
  if (ramGB >= info.expertsGB + 9) return 'fits';
  return ramGB >= info.ramGB ? 'tight' : 'spills';
}

/** dsv41_fit no_card: none of the GPU lines is an NVIDIA or AMD card (null when no GPU lines are known). */
export function deepseek41HasCard(gpus?: readonly string[] | null): boolean | null {
  if (!gpus?.length) return null;
  return gpus.some(line => /nvidia|geforce|rtx|quadro|tesla|radeon|amd/i.test(line));
}

/** The DeepSeek engine build in a config's `exe` (engine-dsv41/<version>-<platform>/…), or null. */
export function deepseek41EngineVersion(exe: unknown): string | null {
  if (typeof exe !== 'string') return null;
  return /(?:^|[\\/])engine-dsv41[\\/](\d+(?:\.\d+)+)-[^\\/]+[\\/]/i.exec(exe)?.[1] ?? null;
}

/** Whether family+quant is in the verified catalog. */
export function isCatalogCombination(family: string, quant: string): boolean {
  const model = MODEL_CATALOG.find(entry => entry.family === family);
  return !!model?.quants.includes(quant);
}

/** Engine gate for a family: null when none; ok=false when runtime is missing or too old. */
export function catalogEngineGate(family: string, runtimeVersion?: string | null): { minEngine: string; ok: boolean } | null {
  const model = MODEL_CATALOG.find(entry => entry.family === family);
  if (!model?.minEngine) return null;
  if (!runtimeVersion) return { minEngine: model.minEngine, ok: false };
  const parts = (v: string) => v.trim().replace(/^v/i, '').split(/[.\-+_]/).filter(Boolean);
  const left = parts(runtimeVersion), right = parts(model.minEngine);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i], y = right[i];
    if (x === undefined) return { minEngine: model.minEngine, ok: false };
    if (y === undefined) return { minEngine: model.minEngine, ok: true };
    const nx = /^\d+$/.test(x) ? Number(x) : NaN, ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return { minEngine: model.minEngine, ok: nx > ny };
      continue;
    }
    if (x !== y) return { minEngine: model.minEngine, ok: x > y };
  }
  return { minEngine: model.minEngine, ok: true };
}

/** Engine gate for a catalog quant: null when none; ok=false when runtime is missing or too old. */
export function catalogQuantEngineGate(family: string, quant: string, runtimeVersion?: string | null): { minEngine: string; ok: boolean } | null {
  const model = MODEL_CATALOG.find(entry => entry.family === family);
  const minEngine = model?.quantInfo[quant]?.minEngine;
  if (!minEngine) return null;
  if (!runtimeVersion) return { minEngine, ok: false };
  const parts = (v: string) => v.trim().replace(/^v/i, '').split(/[.\-+_]/).filter(Boolean);
  const left = parts(runtimeVersion), right = parts(minEngine);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i], y = right[i];
    if (x === undefined) return { minEngine, ok: false };
    if (y === undefined) return { minEngine, ok: true };
    const nx = /^\d+$/.test(x) ? Number(x) : NaN, ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return { minEngine, ok: nx > ny };
      continue;
    }
    if (x !== y) return { minEngine, ok: x > y };
  }
  return { minEngine, ok: true };
}

/** Whether a model's context is locked to `fixedContext` on this Strata release (no `contextChoicesRelease`, or an older/unknown release). */
export function catalogContextLocked(model: CatalogModel, releaseVersion?: string | null): boolean {
  return !!model.fixedContext && !(model.contextChoicesRelease && versionAtLeast(releaseVersion, model.contextChoicesRelease));
}
