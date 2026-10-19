import type { SetupDiskPreflight } from './types';

/**
 * 「导入 OrcaRouter 去审查模型」: upstream Strata docs/ORCA.md's manual compatibility workflow, run by the native
 * orca_import module. Only OrcaRouter's Qwen3.8-Flash-Next-Uncensored IQ3_XXS (2 shards) was validated there.
 */
export const ORCA_REPOSITORY = 'orcarouter/Qwen3.8-Flash-Next-Uncensored-GGUF';
export const ORCA_REVISION = 'd366e279688c1f2fd6e75e2f98475d38db534f1d';
export const ORCA_GUIDE_URL = 'https://github.com/Niko1221/Strata/blob/main/docs/ORCA.md';
export const ORCA_MODEL_NAME = 'orcarouter-qwen3.8-flash-next-uncensored-iq3_xxs';
export const ORCA_CONFIG_FILE = 'strata-orca-iq3_xxs.json';
export const ORCA_QUANT = 'IQ3_XXS';
/** ORCA.md: --max-context 32768 --kv int8. */
export const ORCA_CONTEXT = 32768;
/** ORCA.md: "the expert arena needs about 49.8 GiB of available system RAM". */
export const ORCA_ARENA_GIB = 49.8;
/** Hugging Face file sizes at ORCA_REVISION; ORCA.md: "2 shards, 85.20 GB total". */
export const ORCA_SHARDS = [
  { name: 'Qwen3.8-Flash-Next-Uncensored-IQ3_XXS-00001-of-00002.gguf', bytes: 44_637_691_008 },
  { name: 'Qwen3.8-Flash-Next-Uncensored-IQ3_XXS-00002-of-00002.gguf', bytes: 40_564_977_024 },
] as const;
export const ORCA_TOTAL_BYTES = ORCA_SHARDS.reduce((sum, shard) => sum + shard.bytes, 0);

/** `mtpPath`: an existing MTP draft layer (`…/mtp/rt` with experts.bin), passed to the engine as `--mtp` (#75). */
export interface OrcaImportRequest { source: 'download' | 'local'; shardPath?: string; mtp: boolean; mtpPath?: string }
export interface OrcaShardState { name: string; path: string; expectedBytes: number; presentBytes: number; state: 'complete' | 'partial' | 'missing' | 'wrongSize' }
export interface OrcaImportPlan {
  status: 'ready' | 'blocked';
  source: 'download' | 'local';
  repository: string; revision: string; modelName: string; quant: string; context: number;
  shardDirectory: string; shards: OrcaShardState[]; downloadBytes: number; totalBytes: number;
  packDirectory: string; packReady: boolean; mtp: boolean; mtpDirectory: string; mtpReady: boolean;
  configPath: string; configExists: boolean; engine: string | null;
  ramTotalBytes: number; ramAvailableBytes: number; arenaGib: number; ramStatus: 'ok' | 'insufficient';
  disk: SetupDiskPreflight; problems: string[]; sourceNote: string;
}

export type OrcaShardProblem = 'second' | 'iq3m' | 'unvalidated' | 'gsq' | 'foreign';
const PREFIX = 'Qwen3.8-Flash-Next-Uncensored-';

const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Mirrors orca_import::check_shard_name so the picker can answer before the native plan. */
export function orcaShardProblem(path: string): { problem: OrcaShardProblem; quant?: string } | null {
  const name = basename(path.trim());
  if (name === ORCA_SHARDS[0].name) return null;
  if (name === ORCA_SHARDS[1].name) return { problem: 'second' };
  if (name.startsWith(PREFIX)) {
    const rest = name.slice(PREFIX.length);
    const end = rest.indexOf('-0000') >= 0 ? rest.indexOf('-0000') : rest.indexOf('.gguf');
    const quant = end >= 0 ? rest.slice(0, end) : rest;
    return quant === 'IQ3_M' ? { problem: 'iq3m', quant } : { problem: 'unvalidated', quant };
  }
  return { problem: name.includes('GSQ-RCO') ? 'gsq' : 'foreign' };
}

/** OrcaRouter configs name qwen and IQ3_XXS too: never treat them as the official GSQ-RCO IQ3_XXS. */
export const isOrcaRouterEvidence = (evidence: string): boolean => /orcarouter|uncensored/i.test(evidence);
export const isOrcaRouterModelName = (name: string | undefined | null): boolean => !!name && isOrcaRouterEvidence(name);

/** ORCA.md's RAM figure against this PC: a warning, never a refusal. */
export function orcaRamCheck(totalBytes: number | null | undefined, availableBytes?: number | null): 'ok' | 'tight' | 'insufficient' | 'unknown' {
  if (!totalBytes || totalBytes <= 0) return 'unknown';
  const gib = 1024 ** 3;
  if (totalBytes / gib < ORCA_ARENA_GIB) return 'insufficient';
  if (availableBytes != null && availableBytes / gib < ORCA_ARENA_GIB) return 'tight';
  return 'ok';
}
