import { DEEPSEEK41_EXPERTS_MIN_ENGINE, deepseek41EngineVersion, versionAtLeast } from './catalog';
import type { JsonObject } from './types';

/**
 * DeepSeek-V4.1-Flash run configs (setup.py install_dsv41: arch "deepseek41", the separate strata-dsv41 engine).
 * The engine takes its own options, so the run-config page shows two choices instead of the Qwen fields:
 * - speed: `--experts 5` (fast) or `--experts 6` (full quality, the model's top-6); unset leaves the engine's default
 *   (fast or full, picked for this machine). The flag exists from engine 0.1.50 on, so it is only offered then.
 * - load mode: `--mmap-experts on|off|auto` (strata-dsv41 v0.2.6 ds4_main.cpp; ds4_model.cu copy_experts):
 *   auto (the engine default): copy every CPU-side expert into RAM at load only when all of them fit (measured decode
 *     +10-25%), otherwise read them in place from the model files with the automatic RAM store;
 *   off: copy as many CPU-side experts as fit into RAM (most-routed first); the rest are still read from the files;
 *   on: never copy, always read the experts in place from the model files through the OS page cache.
 *   The option always takes a value: a bare `--mmap-experts` swallows the next argument (or stops the engine with
 *   "needs a value"), and any value other than on/off is auto. Unset = auto.
 * The Qwen startup fields (config-tuning) are not shown or written for these configs: their boolean `--mmap-experts`
 * and the other Qwen engine options mean something else to strata-dsv41 or stop it (unknown option).
 */
export type Deepseek41Speed = '' | '5' | '6';
export type Deepseek41LoadMode = '' | 'auto' | 'off' | 'on';

const LOAD_MODES: readonly string[] = ['auto', 'off', 'on'];

/**
 * strata-dsv41's own options and how many values each takes (v0.2.6 ds4_main.cpp: every option reads one value with
 * val() except these switches). The argument list of a DeepSeek config is split and checked with this table, not the
 * Qwen engine's (where `--mmap-experts` is a switch).
 */
export const DEEPSEEK41_ENGINE_FLAGS: Readonly<Record<string, number>> = Object.freeze({
  '--pack': 1, '--gpus': 1, '--max-context': 1, '--reserve-mib': 1, '--vram-experts': 1, '--cpu-threads': 1, '--expert-profile': 1,
  '--ssd-cache': 1, '--ssd-policy': 1, '--eos': 1, '--no-expert-cache': 0, '--dspark': 1, '--dspark-conf': 1, '--experts': 1,
  '--dspark-block': 1, '--tp': 1, '--prefill-chunk': 1, '--threads': 1, '--vision': 1, '--mmap-experts': 1, '--images': 1,
  '--encode-image': 1, '--dump-image': 1, '--size': 1, '--temperature': 1, '--seed': 1, '--verbose': 0, '--version': 0, '--ids': 1,
  '--n': 1, '--window': 1, '--dump-logits': 1, '--score': 1, '--score-out': 1, '--profile-run': 1, '--spec-eval': 1, '--serve': 0,
  '--pack-info': 0, '--layer-split': 1, '--help': 0,
});
const argsOf = (config: JsonObject): string[] => Array.isArray(config.args) ? config.args.map(String) : [];

export function isDeepseek41Config(config: JsonObject | null | undefined): boolean {
  return !!config && config.arch === 'deepseek41';
}

/**
 * Engine flags among `flags` that strata-dsv41 does not take (not in DEEPSEEK41_ENGINE_FLAGS); always empty for
 * non-DeepSeek configs. Speed fixes, quick calibration and restart candidates are written for the Qwen engine
 * (`--vram-reserve-mib`, `--pool-workers`, `--pcie-frac`, …): strata-dsv41 stops on an unknown option, so nothing
 * outside its own table may reach a DeepSeek config.
 */
export function deepseek41ForeignFlags(config: JsonObject | null | undefined, flags: Iterable<string>): string[] {
  if (!isDeepseek41Config(config)) return [];
  return [...new Set(flags)].filter(flag => !Object.prototype.hasOwnProperty.call(DEEPSEEK41_ENGINE_FLAGS, flag));
}

/** Throws when `flags` would put a Qwen-only option into a DeepSeek config. */
export function assertDeepseek41Flags(config: JsonObject | null | undefined, flags: Iterable<string>): void {
  const foreign = deepseek41ForeignFlags(config, flags);
  if (foreign.length) throw new Error(`DeepSeek-V4.1-Flash 使用独立引擎，不能写入 ${foreign.join(' ')} / DeepSeek-V4.1-Flash uses its own engine and does not take ${foreign.join(' ')}`);
}

/** The engine build of a DeepSeek config (from its exe path), and whether it takes `--experts`. */
export function deepseek41SpeedSupported(config: JsonObject | null | undefined): boolean {
  return !!config && versionAtLeast(deepseek41EngineVersion(config.exe), DEEPSEEK41_EXPERTS_MIN_ENGINE);
}

export function deepseek41Speed(config: JsonObject): Deepseek41Speed {
  const args = argsOf(config); const index = args.indexOf('--experts');
  const value = index < 0 ? '' : args[index + 1] ?? '';
  return value === '5' || value === '6' ? value : '';
}

export function deepseek41LoadMode(config: JsonObject): Deepseek41LoadMode {
  const args = argsOf(config); const index = args.indexOf('--mmap-experts');
  if (index < 0) return '';
  const value = args[index + 1];
  // Not a mode: a bare flag (the engine would take the next option as its value) or another word (the engine reads it
  // as auto). The page shows 使用默认设置 and the next choice rewrites it; deepseek41ArgsError names it.
  return value && LOAD_MODES.includes(value) ? value as Deepseek41LoadMode : '';
}

/** What is wrong with a DeepSeek config's own options: a repeated option, `--mmap-experts` without on/off/auto, `--experts` without a number or auto. */
export function deepseek41ArgsError(config: JsonObject): string | null {
  if (!isDeepseek41Config(config)) return null;
  const args = argsOf(config);
  for (const flag of ['--mmap-experts', '--experts']) {
    const positions = args.flatMap((arg, index) => arg === flag ? [index] : []);
    if (positions.length > 1) return `${flag} 重复出现，请只保留一个 / appears more than once`;
    const value = positions.length ? args[positions[0]! + 1] : undefined;
    if (!positions.length) continue;
    if (flag === '--mmap-experts' && !(value && LOAD_MODES.includes(value))) return '--mmap-experts 需要 on / off / auto（DeepSeek 引擎不接受不带值的写法）/ needs on, off or auto';
    if (flag === '--experts' && !(value && (value === 'auto' || /^[1-9]\d*$/.test(value)))) return '--experts 需要正整数或 auto / needs a positive number or auto';
  }
  return null;
}

/** Remove every `flag [value]` occurrence, then append `flag value` when a value is chosen. */
function setValueFlag(config: JsonObject, flag: string, value: string, isValue: (token: string | undefined) => boolean): JsonObject {
  const args = argsOf(config); const next: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== flag) { next.push(args[index]!); continue; }
    if (isValue(args[index + 1])) index++;
  }
  if (value) next.push(flag, value);
  return { ...structuredClone(config), args: next };
}

/** Writes `--experts 5|6`, or removes it for the engine default. Refused when the engine predates the flag. */
export function applyDeepseek41Speed(config: JsonObject, speed: Deepseek41Speed): JsonObject {
  if (speed && !deepseek41SpeedSupported(config)) {
    throw new Error(`速度档需要 DeepSeek 引擎 ${DEEPSEEK41_EXPERTS_MIN_ENGINE} 或更新 / The speed choice needs DeepSeek engine ${DEEPSEEK41_EXPERTS_MIN_ENGINE} or newer`);
  }
  if (speed !== '' && speed !== '5' && speed !== '6') throw new Error('--experts: 5 / 6');
  return setValueFlag(config, '--experts', speed, token => token !== undefined && !token.startsWith('--'));
}

/** Writes `--mmap-experts auto|off|on`, or removes it for the engine default. */
export function applyDeepseek41LoadMode(config: JsonObject, mode: Deepseek41LoadMode): JsonObject {
  if (mode && !LOAD_MODES.includes(mode)) throw new Error('--mmap-experts: auto / off / on');
  // A following token that is not an option is the old flag's value (even an unknown word, which the engine reads as auto).
  return setValueFlag(config, '--mmap-experts', mode, token => token !== undefined && !token.startsWith('--'));
}

const VISION_ON = ['on', 'yes', 'true', '1', 'gpu', 'cpu'];

/**
 * Whether a DeepSeek config reads pictures. strata-dsv41 takes `--vision on|off` with its own picture tower (upstream
 * v0.2.8 writes it into every DeepSeek config), so only an explicit on counts: `--vision off`, a bare `--vision` or a
 * missing flag is text only. Same rule as runtime-core benchmark_identity::vision_enabled.
 */
export function deepseek41Vision(config: JsonObject): boolean {
  const args = argsOf(config); let on = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const value = arg === '--vision' ? args[index + 1] : arg.startsWith('--vision=') ? arg.slice('--vision='.length) : null;
    if (value === null) continue;
    const word = value?.toLowerCase();
    on = !!word && VISION_ON.includes(word);
  }
  return on;
}

/**
 * Writes `--vision on` or `--vision off` into a DeepSeek config (one occurrence, other arguments untouched). The Qwen
 * picture reader's `vision` section and the bare Qwen switch are never written: strata-dsv41 reads pictures itself and
 * would take the next option as the value of a bare `--vision`.
 */
export function applyDeepseek41Vision(config: JsonObject, on: boolean): JsonObject {
  if (!isDeepseek41Config(config)) throw new Error('只用于 DeepSeek-V4.1-Flash 配置 / Only for DeepSeek-V4.1-Flash configurations');
  const args = argsOf(config).flatMap(arg => arg.startsWith('--vision=') ? ['--vision', arg.slice('--vision='.length)] : [arg]);
  return setValueFlag({ ...config, args }, '--vision', on ? 'on' : 'off', token => token !== undefined && !token.startsWith('--'));
}
