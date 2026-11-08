import type { JsonObject } from './types';
import type { CalibrationBackend, CalibrationJob, CalibrationStep, TuningLiveSnapshot, TuningRestartParameters } from './tuning-types';

/** Same test as isDeepseek41Config (deepseek41-config.ts), kept local so this module has no runtime imports. */
const isDeepseek41 = (config: JsonObject | null | undefined) => !!config && config.arch === 'deepseek41';

/** Flags quick calibration may write, with their accepted ranges. */
const CALIBRATION_FLAGS: Record<string, { min: number; max: number; integer?: boolean }> = {
  '--pcie-frac': { min: 0, max: 1 },
  '--spec-min-p': { min: 0, max: 1 },
  '--prefill-pipe': { min: 0, max: 262144, integer: true },
};

const flagOfGroup = (group: readonly string[]): string => {
  const head = group[0];
  if (!head || !head.startsWith('--')) return '';
  const eq = head.indexOf('=');
  return eq >= 0 ? head.slice(0, eq) : head;
};

const argGroups = (args: unknown): string[][] => {
  const out: string[][] = [];
  if (!Array.isArray(args)) return out;
  for (const item of args) {
    if (typeof item !== 'string') continue;
    if (item.startsWith('--') || !out.length || out[out.length - 1]![0]!.includes('=')) out.push([item]);
    else out[out.length - 1]!.push(item);
  }
  return out;
};

const byFlag = (gs: string[][]): Map<string, string[][]> => {
  const map = new Map<string, string[][]>();
  for (const g of gs) {
    const f = flagOfGroup(g);
    const list = map.get(f);
    if (list) list.push(g);
    else map.set(f, [g]);
  }
  return map;
};

const captureUserArgs = (config: JsonObject): string[] => {
  const mine = byFlag(argGroups(config.user_args));
  if (Array.isArray(config.args_written) && Array.isArray(config.args)) {
    const cur = byFlag(argGroups(config.args));
    const was = byFlag(argGroups(config.args_written));
    for (const [flag, gs] of cur) {
      if (flag && JSON.stringify(was.get(flag) ?? null) !== JSON.stringify(gs)) mine.set(flag, gs);
    }
    for (const flag of [...mine.keys()]) {
      if (was.has(flag) && !cur.has(flag)) mine.delete(flag);
    }
  }
  return [...mine.values()].flat(2);
};

/**
 * Write calibration settings into a config's engine args, keeping every other
 * value (model paths, security, MCP, unknown flags). A value of `null` removes
 * the flag so the engine default applies, like upstream calibrate.py.
 * pcie_frac 0 is refused unless the GPU is a confirmed CUDA card (upstream #2498).
 * Any conflicting override in `user_args` is cleared and `args_written` refreshed
 * following upstream `strata_control/tune_apply.py` / `arg_layers.record_calibration`.
 */
export function applyCalibrationSettings(config: JsonObject, settings: Record<string, string | null>, backend: CalibrationBackend): JsonObject {
  if (!Array.isArray(config.args) || !config.args.every(arg => typeof arg === 'string')) throw new Error('args 必须为字符串数组 / args must be a string array');
  // Quick calibration measures the Qwen engine's knobs (none is in DEEPSEEK41_ENGINE_FLAGS); a job finished on a Qwen
  // config must not land in a DeepSeek one. Checked inline: this module stays free of runtime imports (node tests load it).
  const flags = Object.keys(settings);
  if (isDeepseek41(config) && flags.length) throw new Error(`DeepSeek-V4.1-Flash 使用独立引擎，不能写入 ${flags.join(' ')} / DeepSeek-V4.1-Flash uses its own engine and does not take ${flags.join(' ')}`);
  const args = [...config.args] as string[];
  for (const [flag, value] of Object.entries(settings)) {
    const rule = CALIBRATION_FLAGS[flag];
    if (!rule) throw new Error(`校准不能写入 ${flag} / calibration cannot write ${flag}`);
    if (value != null) {
      const number = Number(value);
      if (!value.trim() || !Number.isFinite(number) || number < rule.min || number > rule.max || (rule.integer && !Number.isInteger(number))) throw new Error(`${flag} 超出范围 / ${flag} is out of range`);
      if (flag === '--pcie-frac' && number === 0 && backend !== 'cuda') throw new Error('非 NVIDIA 显卡不能使用 pcie_frac 0 / pcie_frac 0 is only allowed on a confirmed NVIDIA GPU');
    }
    const positions = args.flatMap((arg, i) => (arg === flag || arg.startsWith(`${flag}=`)) ? [i] : []);
    if (positions.length > 1) throw new Error(`${flag} 重复出现，请先在配置中修正 / ${flag} appears more than once`);
    const at = positions[0];
    if (at != null) {
      const width = args[at]!.startsWith(`${flag}=`) ? 1 : (args[at + 1] != null && !args[at + 1]!.startsWith('--') ? 2 : 1);
      args.splice(at, width, ...(value == null ? [] : [flag, value]));
    } else if (value != null) args.push(flag, value);
  }
  const next: JsonObject = { ...structuredClone(config), args };
  const touched = new Set(flags);
  if (Array.isArray(config.user_args) || Array.isArray(config.args_written) || Array.isArray(config.args_derived)) {
    const mine = argGroups(captureUserArgs(config)).filter(g => !touched.has(flagOfGroup(g))).flat();
    if (mine.length) next.user_args = mine;
    else delete next.user_args;
    if (Array.isArray(config.args_written)) next.args_written = [...args];
    else delete next.args_written;
    if (Array.isArray(config.args_derived)) next.args_derived = [...args];
  }
  if (Array.isArray(next.launch_set)) {
    const rest = (next.launch_set as unknown[]).filter(x => typeof x === 'string' && !touched.has(x));
    if (rest.length) next.launch_set = rest;
    else delete next.launch_set;
  }
  if (next.calibrated && typeof next.calibrated === 'object' && !Array.isArray(next.calibrated)) {
    const rec = next.calibrated as JsonObject;
    if (rec.settings && typeof rec.settings === 'object' && !Array.isArray(rec.settings)) {
      const calSettings = { ...(rec.settings as JsonObject) };
      for (const [flag, value] of Object.entries(settings)) {
        if (value == null) delete calSettings[flag];
        else calSettings[flag] = value;
      }
      if (Object.keys(calSettings).length) next.calibrated = { ...rec, settings: calSettings };
      else delete next.calibrated;
    }
  }
  return next;
}

/** File name for a new config version, next to the current one. */
export function calibratedConfigName(configPath: string, at: Date): string {
  const base = configPath.split(/[\\/]/).at(-1)?.replace(/\.json$/i, '').replace(/-calibrated-\d{8}-\d{4}$/, '') || 'configuration';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${base}-calibrated-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}.json`;
}

/**
 * Scenario verification takes at most four restart candidates. They restart with Qwen-engine flags
 * (--pool-workers, --vram-reserve-mib, --adapt-*), so a DeepSeek config gets none.
 */
export function restartCandidatesFromCalibration(job: Pick<CalibrationJob, 'restartSuggestions'> | null | undefined, config?: JsonObject | null): TuningRestartParameters[] {
  if (isDeepseek41(config)) return [];
  return (job?.restartSuggestions ?? []).slice(0, 4).map(item => ({ ...item }));
}

export interface SweepPoint { value: number; median: number | null; min: number | null; max: number | null; samples: number; current: boolean; chosen: boolean; excluded: boolean }
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const same = (a: number | undefined, b: number) => a != null && Math.abs(a - b) < 1e-9;

/** One point per candidate value of a sweep, for the per-parameter chart and table. */
export function sweepPoints(step: CalibrationStep): SweepPoint[] {
  const excluded = (step.excluded ?? []).map(item => item.value);
  const values = [...new Set([...step.values, ...excluded])].sort((a, b) => a - b);
  return values.map(value => {
    const rates = step.samples.filter(sample => same(sample.value, value)).map(sample => sample.rate);
    return { value, median: median(rates), min: rates.length ? Math.min(...rates) : null, max: rates.length ? Math.max(...rates) : null, samples: rates.length, current: same(step.currentValue, value), chosen: same(step.chosen, value), excluded: excluded.some(item => same(item, value)) };
  });
}

/** Overall progress from the persisted job, refined by the live snapshot while running. */
export function calibrationProgress(job: Pick<CalibrationJob, 'completedRequests' | 'totalRequests'>, live?: Pick<TuningLiveSnapshot, 'completedUnits' | 'totalUnits'> | null): { done: number; total: number; fraction: number } {
  const done = Math.max(job.completedRequests, live?.completedUnits ?? 0);
  const total = Math.max(job.totalRequests, live?.totalUnits ?? 0, done);
  return { done, total, fraction: total > 0 ? Math.min(1, done / total) : 0 };
}

/** The recommendation only exists when the confirmation beat the current values by more than minGain. */
export function calibrationHasChange(job: Pick<CalibrationJob, 'state' | 'settings'> | null | undefined): boolean {
  return job?.state === 'completed' && Object.keys(job.settings ?? {}).length > 0;
}

/**
 * True when the config file changed since calibration started: the snapshot
 * revision and the job's fingerprint are both SHA-256 of the file bytes.
 * Applying is still allowed after an explicit confirmation.
 */
export function calibrationConfigChanged(job: Pick<CalibrationJob, 'configFingerprint'> | null | undefined, revision: string): boolean {
  return !!job?.configFingerprint && !!revision && job.configFingerprint.toLowerCase() !== revision.toLowerCase();
}

/**
 * Upstream #4841: a calibration measured on an older engine says little about a newer one (0.1.55 changed the parallel
 * defaults and the GDN kernels). The finished job's engine (identity.engineVersion) against the profile's current engine;
 * null when they match, either is unknown, or the job did not finish.
 */
export function calibrationEngineOutdated(job: Pick<CalibrationJob, 'state' | 'identity'> | null | undefined, currentEngine: string | null | undefined): { from: string; to: string } | null {
  const plain = (value: unknown) => typeof value === 'string' && /^v?\d+\.\d+\.\d+(?:\.\d+)?$/.test(value.trim()) ? value.trim().replace(/^v/i, '') : null;
  const from = plain(job?.identity?.engineVersion), to = plain(currentEngine);
  if (!job || (job.state !== 'completed' && job.state !== 'applied') || !from || !to) return null;
  const a = from.split('.').map(Number), b = to.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return y > x ? { from, to } : null;
  }
  return null;
}
