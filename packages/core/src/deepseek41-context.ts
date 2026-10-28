import { MODEL_CATALOG, versionAtLeast } from './catalog';

/**
 * DeepSeek-V4.1-Flash context sizes, from upstream Strata 0.2.7 (strata_control/dsv41_context.py and the app's
 * apps/host/src/lib/deepseek-context.ts): 8K up to the model's native 1,048,576 positions; past 256K is "not tested yet".
 * Strata 0.2.5 and 0.2.6 setup was checked at 8K only, so older runtimes keep the fixed 8K.
 */
export const DEEPSEEK41_CONTEXT_CHOICES: readonly number[] = Object.freeze([8192, 32768, 65536, 131072, 262144, 524288, 1048576]);
/** The largest size upstream has tested (dsv41_context.TESTED). */
export const DEEPSEEK41_TESTED_CONTEXT = 262144;
/** The model's own length (dsv41_context.NATIVE): the most any pack can say. */
export const DEEPSEEK41_NATIVE_CONTEXT = 1048576;
/** The default stays 8K (setup.py DSV41_CONTEXT). */
export const DEEPSEEK41_DEFAULT_CONTEXT = 8192;
/** The Strata release whose setup, Terminal and app offer more than 8K (control 0.1.52). */
export const DEEPSEEK41_CONTEXT_MIN_RELEASE = '0.2.7';
/**
 * Graphics memory per context token. Strata 0.2.7 release notes: on an RTX 5070 a 1M context "cost about 1 GB of
 * graphics memory, which pushed 136 experts off the card"; 136 experts of the 2.25 set (149.06 GB / 15,360 experts)
 * are 1.32 GB, so 1.32 GB / 1,048,576 ≈ 1,259 bytes. The larger figure is used; the card's expert cache gives the room.
 */
export const DEEPSEEK41_CONTEXT_VRAM_BYTES_PER_TOKEN = 1259;
/** dsv41_fit.py: every set has 15,360 routed experts (the in-memory count divides experts_gb by it). */
export const DEEPSEEK41_EXPERT_COUNT = 15360;

/** Whether this Strata release offers DeepSeek contexts past 8K. Unknown or older: no. */
export function deepseek41ContextUnlocked(releaseVersion?: string | null): boolean {
  return versionAtLeast(releaseVersion, DEEPSEEK41_CONTEXT_MIN_RELEASE);
}

/** The sizes to offer: up to the pack's limit (its ds4.txt) when known, else up to `unknownCap` (1M as setup does, before a pack exists). */
export function deepseek41Contexts(limit?: number | null, unknownCap = DEEPSEEK41_NATIVE_CONTEXT): number[] {
  const cap = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : unknownCap;
  return DEEPSEEK41_CONTEXT_CHOICES.filter(size => size <= cap);
}

/** An empty string when the size can run (dsv41_context.problem); otherwise one bilingual sentence. */
export function deepseek41ContextProblem(context: number, limit?: number | null): string {
  const cap = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : DEEPSEEK41_NATIVE_CONTEXT;
  if (!Number.isInteger(context) || context < 1024) return '上下文至少 1,024 / Choose a context of at least 1,024 tokens.';
  return context > cap ? `超过模型可读取的 ${cap.toLocaleString('en-US')} / A context past ${cap.toLocaleString('en-US')} tokens is more than this model reads.` : '';
}

/** Past 256K: not tested upstream. */
export const deepseek41ContextUntested = (context: number): boolean => context > DEEPSEEK41_TESTED_CONTEXT;

/** Graphics memory the context's cache takes from the card's expert cache, and how many experts of this set that is. */
export function deepseek41ContextCost(context: number, quant: string): { vramBytes: number; displacedExperts: number | null } {
  const vramBytes = Math.max(0, Math.round(context)) * DEEPSEEK41_CONTEXT_VRAM_BYTES_PER_TOKEN;
  const expertsGB = MODEL_CATALOG.find(entry => entry.family === 'deepseek41')?.quantInfo[quant]?.expertsGB;
  return { vramBytes, displacedExperts: expertsGB ? Math.ceil(vramBytes / (expertsGB * 1e9 / DEEPSEEK41_EXPERT_COUNT)) : null };
}
