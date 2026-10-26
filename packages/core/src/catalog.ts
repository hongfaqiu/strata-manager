/** Snapshot of official setup.py MODELS / FAMILIES / OWN_PATH_FAMILIES.
 * Checked against Niko1221/Strata v0.1.45 (docs/QWEN36.md, docs/MODELS.md, setup.py).
 * Runtime versions can differ; qwen36 needs >= 0.1.45; Unsloth UD-Q5/Q6 need >= 0.1.44. */
export const UPSTREAM_REVISION = '477ac13cbe8e582c20484871ce459d20d82df09d';
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
  quantInfo: Record<string, CatalogQuantInfo>;
}

const source = `https://github.com/Niko1221/Strata/blob/${UPSTREAM_REVISION}/setup.py`;
const DEEPSEEK41_SOURCE = 'https://github.com/Niko1221/Strata/blob/v0.2.6/setup.py';
const snapshotDate = '2026-10-19';
export const MODEL_CATALOG: CatalogModel[] = [
  { id: 'qwen', family: 'qwen', name: 'Qwen3.8-Flash-Next', quants: ['Q2_0', 'IQ2_XS', 'IQ3_XXS', 'IQ3_S'], images: true, source, snapshotDate,
    quantInfo: { Q2_0: { downloadGB: 66.4, ramGB: 48 }, IQ2_XS: { downloadGB: 68, ramGB: 48 }, IQ3_XXS: { downloadGB: 75.8, ramGB: 60 }, IQ3_S: { downloadGB: 83.6, ramGB: 62 } } },
  { id: 'swift', family: 'swift', name: 'Swift 1.5', quants: ['IQ2_XS', 'IQ3_XXS', 'IQ3_S'], images: true, source, snapshotDate,
    quantInfo: { IQ2_XS: { downloadGB: 68, ramGB: 48 }, IQ3_XXS: { downloadGB: 75.8, ramGB: 60 }, IQ3_S: { downloadGB: 83.6, ramGB: 62 } } },
  { id: 'coder', family: 'coder', name: 'Qwen3.8-Flash-Next Coder', quants: ['IQ1_M'], images: true, source, snapshotDate,
    quantInfo: { IQ1_M: { downloadGB: 58.4, ramGB: 32 } } },
  // Unsloth: setup.py MODELS — download_gb / ram_gb; higher quants from MODEL-UPDATE (engine 0.1.44 for Q5/Q6).
  // Vision on for all five (setup vision: True). UD-Q4_K_XL historical Manager flags kept; new tiers are regular menu options.
  { id: 'unsloth', family: 'unsloth', name: 'Qwen3.8-Flash-Next (Unsloth)', quants: ['UD-IQ4_XS', 'UD-Q4_K_XL', 'UD-Q5_K_XL', 'UD-Q6_K_XL', 'Q8_0'], images: true, source, snapshotDate,
    quantInfo: {
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
  // ramGB: ISTA_SETS[*].ram_ok_gb (below it the experts are read from the SSD: slow, still allowed). Text only, 8K.
  { id: 'deepseek41', family: 'deepseek41', name: 'DeepSeek-V4.1-Flash', quants: ['IST-DAS-2.00bpw', 'IST-DAS-1.75bpw', 'IST-DAS-2.25bpw'], images: false,
    source: DEEPSEEK41_SOURCE, snapshotDate: '2026-10-26', minRelease: '0.2.5', fixedContext: 8192,
    quantInfo: {
      'IST-DAS-2.00bpw': { downloadGB: 256.8, ramGB: 40, expertsGB: 132.07, qualityLoss: '+15.5%' },
      'IST-DAS-1.75bpw': { downloadGB: 239.3, ramGB: 34, expertsGB: 114.56, qualityLoss: '+21%' },
      'IST-DAS-2.25bpw': { downloadGB: 273.8, ramGB: 44, expertsGB: 149.06, qualityLoss: '+7.3%', manualOnly: true },
    } },
];

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
