import type { JsonObject } from './types';

export const USER_ARGS_KEY = 'user_args';
export const ARGS_WRITTEN_KEY = 'args_written';
export const ARGS_DERIVED_KEY = 'args_derived';
export const CALIBRATED_KEY = 'calibrated';
export const LAUNCH_SET_KEY = 'launch_set';
/** Flags upstream `drafting.apply` only recognises as hand-set under DFlash2 when present in `user_args`. */
export const DFLASH2_USER_ARG_FLAGS: ReadonlySet<string> = new Set(['--spec', '--draft-conf']);

export function flagOfGroup(group: readonly string[]): string {
  const head = group[0];
  if (!head || !head.startsWith('--')) return '';
  const eq = head.indexOf('=');
  return eq >= 0 ? head.slice(0, eq) : head;
}

/**
 * Split an argv list into option groups (`--flag` + its operand tokens, or a lone positional token).
 * Preserves unknown options, multi-value flags (`--control-vector-layer-range 4 44`), repeated flags,
 * and positional arguments (even after a known 0/N-arity flag).
 */
export function argGroups(args: unknown, flags?: Readonly<Record<string, number>>): string[][] {
  const out: string[][] = [];
  if (!Array.isArray(args)) return out;
  for (const raw of args) {
    if (typeof raw !== 'string') continue;
    if (raw.startsWith('--') || !out.length) {
      out.push([raw]);
      continue;
    }
    const current = out[out.length - 1]!;
    const flag = flagOfGroup(current);
    const knownArity = flag && flags && Object.hasOwn(flags, flag) ? flags[flag] : undefined;
    if (!flag || current[0]!.includes('=') || (knownArity !== undefined && current.length - 1 >= knownArity)) {
      out.push([raw]);
    } else {
      current.push(raw);
    }
  }
  return out;
}

/** `args` with `userArgs` merged on top (upstream `strata_control/user_args.py:merge`): every flag in `userArgs` wins. */
export function mergeUserArgs(args: readonly string[], userArgs: unknown, flags?: Readonly<Record<string, number>>): string[] {
  const ug = argGroups(userArgs, flags);
  const mine = new Set(ug.map(flagOfGroup).filter(Boolean));
  if (!mine.size) return [...args];
  const kept = argGroups(args, flags).filter(g => !mine.has(flagOfGroup(g)));
  return [...kept, ...ug].flat();
}

export function byFlag(gs: string[][]): Map<string, string[][]> {
  const map = new Map<string, string[][]>();
  for (const g of gs) {
    const f = flagOfGroup(g);
    const list = map.get(f);
    if (list) list.push(g);
    else map.set(f, [g]);
  }
  return map;
}

const sameGroups = (a: string[][] | undefined, b: string[][] | undefined): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Upstream `strata_control/user_args.py:capture`: `user_args` plus any option in `args` that differs from
 * `args_written` (or minus any option in `args_written` that was removed from `args`).
 */
export function captureUserArgs(
  config: JsonObject,
  skip: ReadonlySet<string> = new Set(),
  flags?: Readonly<Record<string, number>>,
): string[] {
  const mine = byFlag(argGroups(config[USER_ARGS_KEY], flags));
  if (Array.isArray(config[ARGS_WRITTEN_KEY]) && Array.isArray(config.args)) {
    const cur = byFlag(argGroups(config.args, flags));
    const was = byFlag(argGroups(config[ARGS_WRITTEN_KEY], flags));
    for (const [flag, gs] of cur) {
      if (flag && !skip.has(flag) && !sameGroups(was.get(flag), gs)) {
        mine.set(flag, gs);
      }
    }
    for (const flag of [...mine.keys()]) {
      if (was.has(flag) && !cur.has(flag)) {
        mine.delete(flag);
      }
    }
  }
  return [...mine.values()].flat(2);
}

export function hasUserArgsLayer(config: JsonObject | null | undefined): boolean {
  if (!config) return false;
  return Array.isArray(config[USER_ARGS_KEY]) || Array.isArray(config[ARGS_WRITTEN_KEY]) || Array.isArray(config[ARGS_DERIVED_KEY]);
}

export function stampUserArgs(config: JsonObject, userArgs: readonly string[], keepWritten: boolean): void {
  if (userArgs.length > 0) {
    config[USER_ARGS_KEY] = [...userArgs];
  } else {
    delete config[USER_ARGS_KEY];
  }
  if (keepWritten && Array.isArray(config.args)) {
    config[ARGS_WRITTEN_KEY] = [...(config.args as string[])];
  } else if (!keepWritten) {
    delete config[ARGS_WRITTEN_KEY];
  }
  if (Array.isArray(config[ARGS_DERIVED_KEY]) && Array.isArray(config.args)) {
    config[ARGS_DERIVED_KEY] = [...(config.args as string[])];
  }
}

export function cleanArgLayersMetadata(
  config: JsonObject,
  touched: ReadonlySet<string>,
  calibratedUpdates?: Readonly<Record<string, string | null>>,
): void {
  if (Array.isArray(config[LAUNCH_SET_KEY])) {
    const rest = (config[LAUNCH_SET_KEY] as unknown[]).filter(x => typeof x === 'string' && !touched.has(x));
    if (rest.length) config[LAUNCH_SET_KEY] = rest;
    else delete config[LAUNCH_SET_KEY];
  }
  const calibrated = config[CALIBRATED_KEY];
  if (calibrated && typeof calibrated === 'object' && !Array.isArray(calibrated)) {
    const rec = calibrated as JsonObject;
    if (rec.settings && typeof rec.settings === 'object' && !Array.isArray(rec.settings)) {
      const settings = { ...(rec.settings as JsonObject) };
      if (calibratedUpdates) {
        for (const [flag, value] of Object.entries(calibratedUpdates)) {
          if (value == null) delete settings[flag];
          else settings[flag] = value;
        }
      } else {
        for (const flag of touched) delete settings[flag];
      }
      if (Object.keys(settings).length) config[CALIBRATED_KEY] = { ...rec, settings };
      else delete config[CALIBRATED_KEY];
    }
  }
}

/**
 * Upstream `tune_apply.py` / `arg_layers.record_calibration`: keep `user_args` except for the flags set by
 * calibration/tuning, and refresh `args_written` (only when already present). Configs without `user_args` stay untouched.
 */
export function syncCalibrationUserArgs(
  before: JsonObject,
  next: JsonObject,
  touchedFlags: Iterable<string>,
  options?: { flags?: Readonly<Record<string, number>>; calibratedUpdates?: Readonly<Record<string, string | null>> },
): JsonObject {
  const touched = new Set(touchedFlags);
  if (hasUserArgsLayer(before)) {
    const flags = options?.flags;
    const mine = argGroups(captureUserArgs(before, undefined, flags), flags)
      .filter(g => !touched.has(flagOfGroup(g)))
      .flat();
    stampUserArgs(next, mine, Array.isArray(before[ARGS_WRITTEN_KEY]));
  }
  cleanArgLayersMetadata(next, touched, options?.calibratedUpdates);
  return next;
}
