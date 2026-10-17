import type { JsonObject } from './types';
import type { CalibrationBackend, CalibrationJob, CalibrationStep, TuningLiveSnapshot, TuningRestartParameters } from './tuning-types';

/** Flags quick calibration may write, with their accepted ranges. */
const CALIBRATION_FLAGS: Record<string, { min: number; max: number; integer?: boolean }> = {
  '--pcie-frac': { min: 0, max: 1 },
  '--spec-min-p': { min: 0, max: 1 },
  '--prefill-pipe': { min: 0, max: 262144, integer: true },
};

/**
 * Write calibration settings into a config's engine args, keeping every other
 * value (model paths, security, MCP, unknown flags). A value of `null` removes
 * the flag so the engine default applies, like upstream calibrate.py.
 * pcie_frac 0 is refused unless the GPU is a confirmed CUDA card (upstream #2498).
 */
export function applyCalibrationSettings(config: JsonObject, settings: Record<string, string | null>, backend: CalibrationBackend): JsonObject {
  if (!Array.isArray(config.args) || !config.args.every(arg => typeof arg === 'string')) throw new Error('args 必须为字符串数组 / args must be a string array');
  const args = [...config.args] as string[];
  for (const [flag, value] of Object.entries(settings)) {
    const rule = CALIBRATION_FLAGS[flag];
    if (!rule) throw new Error(`校准不能写入 ${flag} / calibration cannot write ${flag}`);
    if (value != null) {
      const number = Number(value);
      if (!value.trim() || !Number.isFinite(number) || number < rule.min || number > rule.max || (rule.integer && !Number.isInteger(number))) throw new Error(`${flag} 超出范围 / ${flag} is out of range`);
      if (flag === '--pcie-frac' && number === 0 && backend !== 'cuda') throw new Error('非 NVIDIA 显卡不能使用 pcie_frac 0 / pcie_frac 0 is only allowed on a confirmed NVIDIA GPU');
    }
    const positions = args.flatMap((arg, i) => arg === flag ? [i] : []);
    if (positions.length > 1) throw new Error(`${flag} 重复出现，请先在配置中修正 / ${flag} appears more than once`);
    const at = positions[0];
    if (at != null) args.splice(at, 2, ...(value == null ? [] : [flag, value]));
    else if (value != null) args.push(flag, value);
  }
  return { ...structuredClone(config), args };
}

/** File name for a new config version, next to the current one. */
export function calibratedConfigName(configPath: string, at: Date): string {
  const base = configPath.split(/[\\/]/).at(-1)?.replace(/\.json$/i, '').replace(/-calibrated-\d{8}-\d{4}$/, '') || 'configuration';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${base}-calibrated-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}.json`;
}

/** Scenario verification takes at most four restart candidates. */
export function restartCandidatesFromCalibration(job: Pick<CalibrationJob, 'restartSuggestions'> | null | undefined): TuningRestartParameters[] {
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
