/**
 * One-click speed tuning, phase 1: a read-only health check of the running
 * model, fixes that are saved as a new configuration version, and the plain
 * summary of a quick calibration (before / after, what changed).
 *
 * Thresholds and their sources:
 * - VRAM headroom: the engine prints "N MiB of VRAM free with everything
 *   loaded" (INFO vram_free_mib) and, from 0.1.43.1, warns once less than
 *   1 GiB is free on Windows (512 MiB elsewhere) because requests may stall.
 *   The fix keeps memory free with --vram-reserve-mib and lets the expert
 *   cache size itself (--expert-cache auto) instead of a fixed slot count.
 * - KV in RAM: at 64K+ context, --kv-resident 32768 keeps 32K tokens of KV in
 *   VRAM and streams the rest from RAM (about 13.7 KB of RAM per streamed
 *   token). Upstream measured 50.9 -> 62.6 tok/s at 262K with Q2_0 and about
 *   +6% at 128K. Not available under WSL.
 * - --pcie-frac: since 0.1.42 (CUDA) / 0.1.43 (RDNA4) the engine refines the
 *   PCIe share itself unless --pcie-frac is set; the quick calibration keeps
 *   it automatic unless a fixed value is clearly faster.
 * - SYCL prompt attention batch (upstream #4731, fixed after engine 0.1.54 by
 *   870aedd9): 0.1.54 allocates the FP32 prompt-attention scratch for
 *   STRATA_ATTN_BATCH=128 but budgets 32, so an Intel card can fail its first
 *   request with "device buffers … do not fit". STRATA_ATTN_BATCH=32 is the
 *   upstream default after the fix.
 * - Route prior (upstream #4735, 0.2.8 "Faster answers on 12 GB NVIDIA
 *   cards"): STRATA_ROUTE_PRIOR=1.5 on Qwen + CUDA with a discrete NVIDIA card
 *   of 13 GiB or less. Off by default (long chats can repeat themselves); a
 *   manual switch only, never a calibration candidate.
 */
import type { JsonObject } from './types';
import type { CalibrationGoal, CalibrationJob, CalibrationRates } from './tuning-types';
import { PCIE_AUTO } from './tuning-types';
import { assertDeepseek41Flags, isDeepseek41Config } from './deepseek41-config';
import { gpuVendorOf, isIntegratedGpuName } from './integrated-gpu';

export const KV_RESIDENT_TOKENS = 32768;
export const KV_STREAM_MIN_CONTEXT = 65536;
export const KV_STREAM_BYTES_PER_TOKEN = 13.7 * 1024;
const GIB = 1024 ** 3;
/** RAM that has to stay free on top of the streamed KV. */
const RAM_MARGIN_BYTES = 4 * GIB;

export type SpeedCheckId = 'vramHeadroom' | 'kvInRam' | 'pcieFixed' | 'engine' | 'syclAttnBatch' | 'routePrior';
export type SpeedCheckStatus = 'ok' | 'fix' | 'info' | 'unknown';
/** Flags (`--flag`) or engine env (`env.NAME`) a fix writes; null removes it. Fixes take effect after a restart. */
export type SpeedFix = Record<string, string | null>;
export interface SpeedCheck {
  id: SpeedCheckId;
  status: SpeedCheckStatus;
  /** Message key suffix, e.g. vramHeadroom.low → speedBoost.check.vramHeadroom.low */
  reason: string;
  values: Record<string, number | string>;
  fix?: SpeedFix;
  /** How the row offers its fix: a fix button (default), a reset-to-default button, or an on/off switch. */
  action?: 'fix' | 'reset' | 'toggle';
  /** For a toggle: whether the switch is on now. */
  on?: boolean;
}
export interface SpeedHealthGpu { vendor?: string | null; name?: string | null; totalBytes?: number | null }
export interface SpeedHealthInput {
  config: JsonObject;
  /** `/metrics` → engine (INFO fields such as vram_free_mib, context, kv_resident). */
  engine?: JsonObject | null;
  hardware?: { availableMemoryBytes?: number | null; totalMemoryBytes?: number | null; wsl?: boolean; gpus?: SpeedHealthGpu[] } | null;
  platform: 'windows' | 'other';
  goal?: CalibrationGoal;
  /** Recent service log lines; the engine's LOW / WARNING lines name a reserve. */
  logs?: string[];
  /** The engine backend (`config.backend`, else read from /metrics hardware); see engineBackend. */
  backend?: EngineBackend;
  /** The engine build (BUILD.json, ServiceProfile.runtimeVersion). */
  engineVersion?: string | null;
}

export type EngineBackend = 'cuda' | 'hip' | 'sycl' | 'unknown';
/**
 * Same rule as runtime-core tuning_calibrate::detect_backend: config.backend first, then the engine's hardware text.
 * With the model stopped (no /metrics), the cards themselves decide when they are all of one make.
 */
export function engineBackend(config: JsonObject, metrics?: JsonObject | null, gpus?: SpeedHealthGpu[]): EngineBackend {
  const named = config.backend;
  if (named === 'cuda' || named === 'hip' || named === 'sycl') return named;
  let text = '';
  try { text = JSON.stringify(metrics?.hardware_static ?? null).toLowerCase(); } catch { text = ''; }
  if (['amd', 'radeon', 'gfx1', 'gfx9', 'hip'].some(key => text.includes(key))) return 'hip';
  if (['intel arc', 'sycl', 'level-zero'].some(key => text.includes(key))) return 'sycl';
  if (['nvidia', 'geforce', 'rtx', 'tesla', 'quadro', 'cuda'].some(key => text.includes(key))) return 'cuda';
  if (config.backend != null && config.backend !== 'auto') return 'unknown';
  const makes = new Set((gpus ?? []).filter(gpu => !isIntegratedGpuName(gpu.name)).map(gpu => gpuVendorOf(gpu.vendor) ?? gpuVendorOf(gpu.name)));
  return makes.size === 1 && makes.has('nvidia') ? 'cuda' : 'unknown';
}

export const ROUTE_PRIOR_ENV = 'STRATA_ROUTE_PRIOR';
export const ROUTE_PRIOR_ON = '1.5';
export const ATTN_BATCH_ENV = 'STRATA_ATTN_BATCH';
export const ATTN_BATCH_SAFE = '32';
/** The SYCL engine build whose prompt-attention budget is short (#4731). */
export const SYCL_ATTN_BATCH_BROKEN = '0.1.54';
const SMALL_CARD_BYTES = 13 * GIB;

const envOf = (config: JsonObject): Record<string, unknown> => config.env && typeof config.env === 'object' && !Array.isArray(config.env) ? config.env as Record<string, unknown> : {};
const envValue = (config: JsonObject, name: string): string | undefined => {
  const value = envOf(config)[name];
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
};
const isVersion = (version: string | null | undefined, wanted: string) => !!version && new RegExp(`^v?${wanted.replace(/\./g, '\\.')}(?:[.+-]|$)`).test(version.trim());
/** A discrete NVIDIA card of 13 GiB or less; GB10 / Jetson share system memory and do not count. */
export function hasSmallNvidiaCard(gpus: SpeedHealthGpu[] | undefined): boolean {
  return (gpus ?? []).some(gpu => {
    const name = String(gpu.name ?? '');
    const nvidia = /nvidia/i.test(String(gpu.vendor ?? '')) || /nvidia|geforce|quadro|tesla|rtx/i.test(name);
    if (!nvidia || /\bgb10\b|jetson|orin|thor|tegra|spark/i.test(name)) return false;
    const total = finite(gpu.totalBytes);
    return total != null && total > 0 && total <= SMALL_CARD_BYTES;
  });
}

const args = (config: JsonObject): string[] => Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === 'string') : [];
/** The value of a flag written as `flag value` or `flag=value`; '' for a bare flag. */
export function argValue(list: string[], flag: string): string | undefined {
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i]!;
    if (arg === flag) { const next = list[i + 1]; return next != null && !next.startsWith('--') ? next : ''; }
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}
const finite = (value: unknown): number | null => {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
};

/** The engine's suggested reserve from a LOW / WARNING log line, if any. */
export function suggestedReserveFromLogs(lines: string[] | undefined): number | null {
  let found: number | null = null;
  for (const line of lines ?? []) {
    const match = /--vram-reserve-mib\s+(\d{2,6})/.exec(line);
    if (match && /LOW|WARNING|stall/i.test(line)) found = Number(match[1]);
  }
  return found;
}
/** Free VRAM below this is a stall risk (upstream 0.1.43.1 warning); the memory goal keeps 2 GiB. */
export function vramFloorMib(platform: SpeedHealthInput['platform'], goal: CalibrationGoal = 'balanced'): number {
  return goal === 'memory' ? 2048 : platform === 'windows' ? 1024 : 512;
}

export function speedHealthCheck(input: SpeedHealthInput): SpeedCheck[] {
  // The checks and their fixes are Qwen-engine ones (--vram-reserve-mib, --expert-cache, --kv-resident): a DeepSeek
  // config gets one information row and no fix, so nothing Qwen-only can be written into it.
  if (isDeepseek41Config(input.config)) return [{ id: 'engine', status: 'info', reason: 'deepseek41', values: {} }];
  const list = args(input.config);
  const engine = input.engine ?? {};
  const checks: SpeedCheck[] = [];

  // 1. VRAM headroom
  const free = finite(engine.vram_free_mib);
  const floor = vramFloorMib(input.platform, input.goal);
  const reserve = finite(argValue(list, '--vram-reserve-mib')) ?? 0;
  const cache = argValue(list, '--expert-cache');
  const fixedCache = cache != null && cache !== '' && cache !== 'auto';
  const suggested = suggestedReserveFromLogs(input.logs);
  if (free == null && suggested == null) checks.push({ id: 'vramHeadroom', status: 'unknown', reason: 'unknown', values: {} });
  else if ((free != null && free < floor) || suggested != null) {
    // Keep at least the floor free; round up to 256 MiB like the engine's own figures.
    const target = Math.max(suggested ?? 0, Math.ceil((floor + 256) / 256) * 256);
    const fix: SpeedFix = {};
    if (target > reserve) fix['--vram-reserve-mib'] = String(target);
    if (fixedCache) fix['--expert-cache'] = 'auto';
    checks.push(Object.keys(fix).length
      ? { id: 'vramHeadroom', status: 'fix', reason: 'low', values: { free: free ?? 0, floor, target }, fix }
      : { id: 'vramHeadroom', status: 'info', reason: 'reserved', values: { free: free ?? 0, floor, reserve } });
  } else checks.push({ id: 'vramHeadroom', status: 'ok', reason: 'ok', values: { free: free!, floor } });

  // 2. KV cache in RAM for long context
  const context = finite(engine.context) ?? finite(argValue(list, '--max-context')) ?? finite(engine.max_context);
  const resident = finite(argValue(list, '--kv-resident')) ?? finite(engine.kv_resident) ?? 0;
  if (context == null) checks.push({ id: 'kvInRam', status: 'unknown', reason: 'unknown', values: {} });
  else if (context < KV_STREAM_MIN_CONTEXT) checks.push({ id: 'kvInRam', status: 'ok', reason: 'shortContext', values: { context } });
  else if (resident > 0) checks.push({ id: 'kvInRam', status: 'ok', reason: 'enabled', values: { context, resident } });
  else if (input.hardware?.wsl) checks.push({ id: 'kvInRam', status: 'info', reason: 'wsl', values: { context } });
  else {
    const streamed = (context - KV_RESIDENT_TOKENS) * KV_STREAM_BYTES_PER_TOKEN;
    const ramGb = Math.round(streamed / GIB * 10) / 10;
    const available = finite(input.hardware?.availableMemoryBytes);
    if (available == null) checks.push({ id: 'kvInRam', status: 'unknown', reason: 'ramUnknown', values: { context, ram: ramGb } });
    else if (available < streamed + RAM_MARGIN_BYTES) checks.push({ id: 'kvInRam', status: 'info', reason: 'ramLow', values: { context, ram: ramGb, available: Math.round(available / GIB * 10) / 10 } });
    else checks.push({ id: 'kvInRam', status: 'fix', reason: 'off', values: { context, ram: ramGb, resident: KV_RESIDENT_TOKENS }, fix: { '--kv-resident': String(KV_RESIDENT_TOKENS) } });
  }

  // 3. A fixed --pcie-frac turns the engine's own share off; the run compares both.
  const pcie = argValue(list, '--pcie-frac');
  if (pcie != null) checks.push({ id: 'pcieFixed', status: 'info', reason: 'fixed', values: { value: pcie } });

  // 4. Intel SYCL 0.1.54: the prompt attention batch does not fit (#4731). Other backends never see this row.
  if (input.backend === 'sycl') {
    const batch = envValue(input.config, ATTN_BATCH_ENV);
    if (batch != null) checks.push({ id: 'syclAttnBatch', status: 'info', reason: 'set', values: { value: batch }, fix: { [`env.${ATTN_BATCH_ENV}`]: null }, action: 'reset' });
    else if (isVersion(input.engineVersion, SYCL_ATTN_BATCH_BROKEN) && (input.logs ?? []).some(line => /do not fit/i.test(line)))
      checks.push({ id: 'syclAttnBatch', status: 'fix', reason: 'doNotFit', values: { value: ATTN_BATCH_SAFE }, fix: { [`env.${ATTN_BATCH_ENV}`]: ATTN_BATCH_SAFE } });
  }

  // 5. Route prior: a manual switch on Qwen + CUDA + a discrete NVIDIA card of 13 GiB or less (#4735), off by default.
  if (input.backend === 'cuda' && input.config.arch == null && hasSmallNvidiaCard(input.hardware?.gpus)) {
    const on = envValue(input.config, ROUTE_PRIOR_ENV) === ROUTE_PRIOR_ON;
    checks.push({ id: 'routePrior', status: 'info', reason: on ? 'on' : 'off', values: { value: ROUTE_PRIOR_ON }, fix: { [`env.${ROUTE_PRIOR_ENV}`]: on ? null : ROUTE_PRIOR_ON }, action: 'toggle', on });
  }
  return checks;
}

/** Writes fixes into a copy of the config's args (`flag value` form) and env (`env.NAME`), keeping everything else. */
export function applySpeedFixes(config: JsonObject, fixes: SpeedFix[]): JsonObject {
  let list = args(config);
  if (!Array.isArray(config.args) || list.length !== config.args.length) throw new Error('args 必须为字符串数组 / args must be a string array');
  const isEnv = (key: string) => key.startsWith('env.');
  assertDeepseek41Flags(config, fixes.flatMap(fix => Object.keys(fix).filter(key => !isEnv(key))));
  const env: Record<string, unknown> = { ...structuredClone(envOf(config)) };
  let envTouched = false;
  for (const fix of fixes) for (const [flag, value] of Object.entries(fix)) {
    if (isEnv(flag)) {
      const name = flag.slice(4);
      if (!/^STRATA_[A-Z0-9_]+$/.test(name)) throw new Error(`invalid env ${name}`);
      if (value == null) delete env[name]; else env[name] = value;
      envTouched = true;
      continue;
    }
    if (!/^--[a-z0-9-]+$/.test(flag)) throw new Error(`invalid flag ${flag}`);
    const next: string[] = [];
    for (let i = 0; i < list.length; i += 1) {
      const arg = list[i]!;
      if (arg === flag) { if (list[i + 1] != null && !list[i + 1]!.startsWith('--')) i += 1; continue; }
      if (arg.startsWith(`${flag}=`)) continue;
      next.push(arg);
    }
    if (value != null) next.push(flag, value);
    list = next;
  }
  const result: JsonObject = { ...structuredClone(config), args: list };
  if (envTouched) { if (Object.keys(env).length) result.env = env as JsonObject; else delete result.env; }
  return result;
}

/** File name for a version saved by one-click tuning, next to the current one. */
export function speedConfigName(configPath: string, at: Date, kind: 'fix' | 'boost'): string {
  const base = configPath.split(/[\\/]/).at(-1)?.replace(/\.json$/i, '').replace(/-(calibrated|speedfix|speedup)-\d{8}-\d{4}$/, '') || 'configuration';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${base}-${kind === 'fix' ? 'speedfix' : 'speedup'}-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}.json`;
}

export type SpeedChangeKind = 'pcieAuto' | 'pcieFixed' | 'specMinP' | 'prefillPipe';
export interface SpeedChange { kind: SpeedChangeKind; flag: string; from: string | null; to: string | null }
const two = (value: number) => value.toFixed(2);

/** The calibration's settings as plain changes (what the result card lists). */
export function speedChanges(job: Pick<CalibrationJob, 'settings' | 'baseline'> | null | undefined): SpeedChange[] {
  if (!job) return [];
  const out: SpeedChange[] = [];
  for (const [flag, value] of Object.entries(job.settings ?? {})) {
    if (flag === '--pcie-frac') out.push(value == null
      ? { kind: 'pcieAuto', flag, from: job.baseline.pcieFrac >= 0 ? two(job.baseline.pcieFrac) : null, to: null }
      : { kind: 'pcieFixed', flag, from: job.baseline.pcieFrac >= 0 ? two(job.baseline.pcieFrac) : null, to: value });
    else if (flag === '--spec-min-p') out.push({ kind: 'specMinP', flag, from: two(job.baseline.specMinP), to: value });
    else if (flag === '--prefill-pipe') out.push({ kind: 'prefillPipe', flag, from: job.baseline.prefillPipe != null ? String(job.baseline.prefillPipe) : null, to: value });
  }
  return out;
}

export interface SpeedResult {
  /** Combined decode tok/s with the current settings. */
  before: number | null;
  /** With the recommendation (null: nothing to change). */
  after: number | null;
  gain: number | null;
  short: { before: number | null; after: number | null };
  long: { before: number | null; after: number | null };
  changed: boolean;
}
export function speedResult(job: Pick<CalibrationJob, 'state' | 'settings' | 'baseRate' | 'tunedRate' | 'gain' | 'baseRates' | 'tunedRates'> | null | undefined): SpeedResult | null {
  if (!job || job.state !== 'completed') return null;
  const changed = Object.keys(job.settings ?? {}).length > 0;
  const side = (rates: CalibrationRates | undefined, key: keyof CalibrationRates) => rates?.[key] ?? null;
  return {
    before: job.baseRate ?? null,
    after: changed ? job.tunedRate ?? null : null,
    gain: changed ? job.gain ?? null : null,
    short: { before: side(job.baseRates, 'short'), after: changed ? side(job.tunedRates, 'short') : null },
    long: { before: side(job.baseRates, 'long'), after: changed ? side(job.tunedRates, 'long') : null },
    changed,
  };
}

/** Display a PCIe share; PCIE_AUTO (-1) is the engine's own. */
export const isPcieAuto = (value: number | null | undefined) => value != null && value < 0 && Math.abs(value - PCIE_AUTO) < 1e-9;
