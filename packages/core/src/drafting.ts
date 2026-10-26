/**
 * The run config's draft-model choice ("预测（投机解码）" / Drafting), aligned with upstream Strata v0.2.6:
 * - strata_control/drafting.py: MODES auto | mtp | dflash2 | off, default auto; an unknown value reads as auto.
 *   `"drafting": "off"` strips --mtp / --spec-min-p / --batch-mtp (and --draft / --draft-model) at start.
 * - Engines 0.1.46–0.1.47 only know the older `"mtp": false` switch (draft_layer.is_off); `drafting` arrives in 0.1.48.
 * - apps/host/src/lib/drafting.ts: DFlash2 is offered only for the qwen / gyro families AND only while Control reports
 *   `capabilities.dflash2 === true` (ENGINE_SERVES_DFLASH2). The manager has no such capability source yet, so it stays hidden.
 * - server.py still reads the original `mtp` key: an explicit Auto / MTP must remove a stale `"mtp": false`, or MTP stays off.
 * Every change takes effect on the next start. Nothing here reads or writes files.
 */
import type { JsonObject } from './types';

export type DraftingMode = 'auto' | 'mtp' | 'dflash2' | 'off';
export const DRAFTING_MODES: readonly DraftingMode[] = ['auto', 'mtp', 'dflash2', 'off'];
export const DRAFTING_FAMILIES: readonly string[] = ['qwen', 'gyro'];
/** First engine that reads `"drafting"`. */
export const DRAFTING_KEY_SINCE = '0.1.48';
/** First engine that honours `"mtp": false`. */
export const MTP_SWITCH_SINCE = '0.1.46';
/** `drafting`: writes the key; `mtpSwitch`: only `"mtp": false`; `none`: too old; `unknown`: engine version not detected. */
export type DraftingSupport = 'drafting' | 'mtpSwitch' | 'none' | 'unknown';

const parts = (version: string) => version.trim().replace(/^v/i, '').split(/[.\-+_]/).map(part => /^\d+$/.test(part) ? Number(part) : NaN);
/** Numeric dotted comparison; null when either side is not a plain engine version such as 0.1.47 or 0.1.43.1. */
function compare(a: string, b: string): number | null {
  const x = parts(a), y = parts(b);
  if (x.some(Number.isNaN) || y.some(Number.isNaN) || !x.length) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; }
  return 0;
}

export function draftingSupport(engineVersion: string | null | undefined): DraftingSupport {
  if (!engineVersion) return 'unknown';
  const key = compare(engineVersion, DRAFTING_KEY_SINCE), mtp = compare(engineVersion, MTP_SWITCH_SINCE);
  if (key === null || mtp === null) return 'unknown';
  return key >= 0 ? 'drafting' : mtp >= 0 ? 'mtpSwitch' : 'none';
}

/** Upstream drafting.normalize: an unknown or missing value is auto. */
export function normalizeDrafting(value: unknown): DraftingMode {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (DRAFTING_MODES as readonly string[]).includes(text) ? text as DraftingMode : 'auto';
}

/** The qwen / gyro family from the run config's model name (upstream drafting._SUPPORTED_NAME), else null. */
export function draftingFamilyOf(config: JsonObject | undefined | null): 'qwen' | 'gyro' | null {
  const name = typeof config?.model_name === 'string' ? config.model_name.trim() : '';
  if (!/^qwen3\.8-flash-next(-gyro-[a-z0-9._-]+|-(q|iq|tq)\d[a-z0-9_.]*)?$/i.test(name)) return null;
  return /-gyro-/i.test(name) ? 'gyro' : 'qwen';
}

/** Choices for the toggle. DFlash2 needs a supported family and `dflash2Served === true`; a saved dflash2 still shows. */
export function draftingChoices(family: string | null | undefined, dflash2Served: boolean | null | undefined, current?: DraftingMode): DraftingMode[] {
  const served = DRAFTING_FAMILIES.includes(String(family)) && dflash2Served === true;
  return served || current === 'dflash2' ? ['auto', 'mtp', 'dflash2', 'off'] : ['auto', 'mtp', 'off'];
}

/** What the config asks for: `drafting` first, then the legacy `"mtp": false`; otherwise auto. */
export function draftingModeOf(config: JsonObject | undefined | null): DraftingMode {
  if (!config) return 'auto';
  if (typeof config.drafting === 'string') return normalizeDrafting(config.drafting);
  return config.mtp === false ? 'off' : 'auto';
}

/**
 * Write a drafting choice for the given engine version. Only the boolean `mtp: false` is ever removed; a string `mtp`
 * (an older data-folder path) is left alone.
 * - 0.1.48+: `drafting: mode`; a stale `mtp: false` is removed so server.py does not keep MTP off.
 * - 0.1.46–0.1.47: Off writes `mtp: false`; Auto / MTP write no field (and drop a `drafting` key the engine ignores).
 * - Unknown version: Off writes both keys (each engine reads the one it knows); Auto / MTP drop `mtp: false` and only
 *   update a `drafting` key that is already there.
 * - Older than 0.1.46 (or DFlash2 without the drafting key): unchanged.
 */
export function applyDrafting(config: JsonObject, mode: DraftingMode, engineVersion: string | null | undefined): JsonObject {
  const support = draftingSupport(engineVersion);
  if (support === 'none' || (mode === 'dflash2' && support !== 'drafting')) return config;
  const next: JsonObject = { ...config };
  const dropMtpOff = () => { if (next.mtp === false) delete next.mtp; };
  if (support === 'drafting') {
    next.drafting = mode;
    dropMtpOff();
  } else if (support === 'mtpSwitch') {
    delete next.drafting;
    if (mode === 'off') next.mtp = false; else dropMtpOff();
  } else if (mode === 'off') {
    next.drafting = 'off';
    next.mtp = false;
  } else {
    dropMtpOff();
    if ('drafting' in next) next.drafting = mode;
  }
  return next;
}

/** What actually ran, from the effective engine args: `--draft dflash2` → dflash2, `--mtp <dir>` → mtp, else off. */
export function effectiveDraftingOf(args: readonly string[] | undefined | null): 'mtp' | 'dflash2' | 'off' | null {
  if (!Array.isArray(args)) return null;
  const value = (flag: string) => { const i = args.findIndex(arg => arg === flag || arg.startsWith(`${flag}=`)); return i < 0 ? undefined : args[i] === flag ? args[i + 1] : args[i]!.slice(flag.length + 1); };
  if (value('--draft')?.toLowerCase() === 'dflash2') return 'dflash2';
  return args.some(arg => arg === '--mtp' || arg.startsWith('--mtp=')) ? 'mtp' : 'off';
}
