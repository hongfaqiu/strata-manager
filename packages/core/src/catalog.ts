/** Snapshot of official setup.py MODELS / FAMILIES / OWN_PATH_FAMILIES.
 * Checked against Niko1221/Strata v0.1.45 (docs/QWEN36.md, docs/MODELS.md, setup.py).
 * Runtime versions can differ; qwen36 needs >= 0.1.45; Unsloth UD-Q5/Q6 need >= 0.1.44. */
export const UPSTREAM_REVISION = '477ac13cbe8e582c20484871ce459d20d82df09d';
export type CatalogFamily = 'qwen' | 'swift' | 'coder' | 'unsloth' | 'qwen36';
export interface CatalogQuantInfo {
  downloadGB: number;
  ramGB: number;
  experimental?: boolean;
  nvidiaOnly?: boolean;
  visionUntested?: boolean;
  /** Minimum Strata engine for this quant (semver), from setup.py MODELS[*].engine. */
  minEngine?: string;
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
  quantInfo: Record<string, CatalogQuantInfo>;
}

const source = `https://github.com/Niko1221/Strata/blob/${UPSTREAM_REVISION}/setup.py`;
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
];

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
