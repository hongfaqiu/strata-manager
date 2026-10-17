/**
 * Context extension past the model's trained window, following Strata's own setup rules
 * (setup.py resolve_rope / derived_factor, docs/DETAILS.md "Context extension past 262K").
 * Past 262,144 tokens setup adds `--rope-scaling yarn` and `--rope-scale <final context / 262144>`,
 * keeps any explicit method/factor verbatim, and refuses an explicit `--rope-scaling none`.
 */
export const TRAINED_CONTEXT = 262_144;
export const MAX_EXTENDED_CONTEXT = 1_048_576;
/** Context presets offered by the manager; values past TRAINED_CONTEXT are experimental. */
export const CONTEXT_PRESETS = [4096, 8192, 32768, 65536, 131072, 262144, 393216, 524288, 1048576] as const;
/** Per-token KV bytes follow the reviewed estimator (13 cells × cell bytes); RoPE tables add ~0.26 KB per token. */
const KV_CELL_BYTES: Record<string, number> = { int8: 1056, q4_0: 576, k8v4: 816 };
export const ROPE_TABLE_BYTES_PER_TOKEN = 266;
export const KV_CELLS_PER_TOKEN = 13;

export function isExtendedContext(context: number): boolean {
  return Number.isFinite(context) && context > TRAINED_CONTEXT;
}
/** final context / 262144, at least 1 (1.5 at 384K, 2 at 512K, 4 at 1M). */
export function ropeFactorFor(context: number): number {
  return Math.max(1, context / TRAINED_CONTEXT);
}
/** Formats like Python's `:g` for the factors setup writes (4, 1.5, 3.81470…). */
export function formatRopeFactor(factor: number): string {
  return String(Number(factor.toPrecision(6)));
}
/** 1M, 384K, 32K, or a plain grouped number for odd sizes. */
export function formatContextTokens(context: number, locale?: string): string {
  if (!Number.isFinite(context) || context <= 0) return '—';
  if (context >= 1_048_576 && context % 1_048_576 === 0) return `${context / 1_048_576}M`;
  if (context % 1024 === 0) return `${context / 1024}K`;
  return `${(context / 1024).toLocaleString(locale, { maximumFractionDigits: 1 })}K`;
}

export interface ContextExtensionEstimate {
  /** KV cache bytes for the whole context at the chosen precision (int8 when unknown). */
  kvBytes: number;
  /** RoPE angle tables (~0.26 KB per token). */
  ropeBytes: number;
  totalBytes: number;
  /** Extra bytes compared with the trained 262,144-token window. */
  extraBytes: number;
}
export function contextMemoryEstimate(context: number, kv = 'int8'): ContextExtensionEstimate {
  const cell = KV_CELL_BYTES[kv] ?? KV_CELL_BYTES.int8!;
  const perToken = KV_CELLS_PER_TOKEN * cell;
  const extended = isExtendedContext(context);
  const kvBytes = Math.max(0, context) * perToken;
  const ropeBytes = extended ? context * ROPE_TABLE_BYTES_PER_TOKEN : 0;
  const trained = Math.min(Math.max(0, context), TRAINED_CONTEXT) * perToken;
  return { kvBytes, ropeBytes, totalBytes: kvBytes + ropeBytes, extraBytes: kvBytes + ropeBytes - trained };
}

export type ContextExtensionIssue = 'not_scaled' | 'none_refused' | 'scale_too_small' | 'scale_without_method' | 'invalid_scale';
export interface ContextExtensionState {
  context: number;
  extended: boolean;
  /** The factor setup would derive for this context. */
  derivedScale: number;
  scaling: string;
  scale: string;
  /** True when the rope flags equal the automatic values (or are absent inside the trained window). */
  automatic: boolean;
  issue?: ContextExtensionIssue;
}
/** Reads the rope flags for a context and reports whether they match setup's rules. Strings are raw field values. */
export function contextExtensionState(contextText: string, scaling: string, scale: string): ContextExtensionState | undefined {
  const context = Number(contextText);
  if (!contextText.trim() || !Number.isSafeInteger(context) || context <= 0) return undefined;
  const extended = isExtendedContext(context), derivedScale = ropeFactorFor(context);
  const method = scaling.trim(), factorText = scale.trim(), factor = Number(factorText);
  let issue: ContextExtensionIssue | undefined;
  if (factorText && (!Number.isFinite(factor) || factor <= 0)) issue = 'invalid_scale';
  else if (extended && method === 'none') issue = 'none_refused';
  else if (extended && method === '') issue = 'not_scaled';
  else if (extended && (!factorText || factor + 1e-9 < derivedScale)) issue = 'scale_too_small';
  else if (!extended && factorText && (method === '' || method === 'none')) issue = 'scale_without_method';
  const automatic = extended ? method === 'yarn' && !!factorText && Math.abs(factor - derivedScale) < 1e-6 : method === '' && factorText === '';
  return { context, extended, derivedScale, scaling: method, scale: factorText, automatic, ...(issue ? { issue } : {}) };
}

/**
 * The rope flag values to use after the context changes from `previous` to `next`.
 * Flags that were automatic for the previous context follow the new one (added past 262,144, removed inside it);
 * explicit values are kept as given, like setup does.
 */
export function syncContextExtension(previousContext: string, nextContext: string, scaling: string, scale: string): { scaling: string; scale: string } {
  const previous = Number(previousContext), next = Number(nextContext);
  const method = scaling.trim(), factorText = scale.trim();
  if (!nextContext.trim() || !Number.isSafeInteger(next) || next <= 0) return { scaling: method, scale: factorText };
  const previousExtended = Number.isSafeInteger(previous) && isExtendedContext(previous);
  const scaleWasAutomatic = factorText === '' || previousExtended && Math.abs(Number(factorText) - ropeFactorFor(previous)) < 1e-6;
  const methodWasAutomatic = method === '' || method === 'yarn' && previousExtended && scaleWasAutomatic;
  if (isExtendedContext(next)) {
    if (method === 'none') return { scaling: method, scale: factorText };
    return { scaling: methodWasAutomatic ? 'yarn' : method, scale: scaleWasAutomatic ? formatRopeFactor(ropeFactorFor(next)) : factorText };
  }
  if (methodWasAutomatic && scaleWasAutomatic) return { scaling: '', scale: '' };
  return { scaling: method, scale: factorText };
}

/** Setup refuses `--rope-scaling none` past the trained window; saving such a configuration is refused the same way. */
export function contextExtensionError(contextText: string, scaling: string, scale: string): string | undefined {
  const state = contextExtensionState(contextText, scaling, scale);
  if (state?.issue === 'none_refused') return `--rope-scaling none 不能用于超过 262,144 的上下文，请改为 yarn 或把上下文调回 262,144 以内 / --rope-scaling none is refused past the trained 262,144 tokens; use yarn or a context of 262,144 or less`;
  return undefined;
}

export function contextExtensionIssueMessage(issue: ContextExtensionIssue, zh: boolean, derivedScale: number): string {
  const factor = formatRopeFactor(derivedScale);
  const messages: Record<ContextExtensionIssue, [string, string]> = {
    not_scaled: ['尚未开启 RoPE 扩展，超过 262K 的位置模型没有训练过。', 'RoPE scaling is off, so positions past 262K are untrained.'],
    none_refused: ['RoPE 设为 none 时不能超过 262K，官方安装器也会拒绝。请改用 yarn。', 'RoPE none cannot run past 262K; the official setup refuses it. Use yarn.'],
    scale_too_small: [`倍数低于此上下文所需的 ${factor}，超出部分模型没有训练过。`, `The scale is below the ${factor} this context needs; positions past it are untrained.`],
    scale_without_method: ['在 262K 以内只设倍数不会生效，需同时选择 linear 或 yarn。', 'Inside 262K a scale needs linear or yarn as the method.'],
    invalid_scale: ['RoPE 扩展倍数需为正数。', 'The RoPE scale must be a positive number.'],
  };
  return messages[issue][zh ? 0 : 1];
}
