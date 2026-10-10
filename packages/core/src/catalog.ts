/** Snapshot of official setup.py MODELS/FAMILIES, checked 2026-10-10. Runtime versions can differ. */
export const UPSTREAM_REVISION = 'fb58e0dbc8399662c0e47c76578c6e878b14f6cf';
export interface CatalogModel {
  id: string;
  family: 'qwen' | 'swift' | 'coder' | 'unsloth';
  name: string;
  quants: string[];
  images: boolean;
  source: string;
  snapshotDate: string;
  quantInfo: Record<string, { downloadGB: number; ramGB: number; experimental?: boolean; nvidiaOnly?: boolean; visionUntested?: boolean }>;
}

const source = `https://github.com/Niko1221/Strata/blob/${UPSTREAM_REVISION}/setup.py`;
const snapshotDate = '2026-10-10';
export const MODEL_CATALOG: CatalogModel[] = [
  { id: 'qwen', family: 'qwen', name: 'Qwen3.8-Flash-Next', quants: ['Q2_0', 'IQ2_XS', 'IQ3_XXS', 'IQ3_S'], images: true, source, snapshotDate,
    quantInfo: { Q2_0: { downloadGB: 66.4, ramGB: 48 }, IQ2_XS: { downloadGB: 68, ramGB: 48 }, IQ3_XXS: { downloadGB: 75.8, ramGB: 60 }, IQ3_S: { downloadGB: 83.6, ramGB: 62 } } },
  { id: 'swift', family: 'swift', name: 'Swift 1.5', quants: ['IQ2_XS', 'IQ3_XXS'], images: true, source, snapshotDate,
    quantInfo: { IQ2_XS: { downloadGB: 68, ramGB: 48 }, IQ3_XXS: { downloadGB: 75.8, ramGB: 60 } } },
  { id: 'coder', family: 'coder', name: 'Qwen3.8-Flash-Next Coder', quants: ['IQ1_M'], images: true, source, snapshotDate,
    quantInfo: { IQ1_M: { downloadGB: 58.4, ramGB: 32 } } },
  { id: 'unsloth', family: 'unsloth', name: 'Qwen3.8-Flash-Next (Unsloth)', quants: ['UD-IQ4_XS', 'UD-Q4_K_XL'], images: true, source, snapshotDate,
    quantInfo: { 'UD-IQ4_XS': { downloadGB: 93.7, ramGB: 48 }, 'UD-Q4_K_XL': { downloadGB: 111.3, ramGB: 48, experimental: true, nvidiaOnly: true, visionUntested: true } } },
];
