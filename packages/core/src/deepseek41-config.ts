import { DEEPSEEK41_EXPERTS_MIN_ENGINE, deepseek41EngineVersion, versionAtLeast } from './catalog';
import type { JsonObject } from './types';

/**
 * DeepSeek-V4.1-Flash run configs (setup.py install_dsv41: arch "deepseek41", the separate strata-dsv41 engine).
 * The engine takes its own options, so the run-config page shows two choices instead of the Qwen fields:
 * - speed: `--experts 5` (fast) or `--experts 6` (full quality, the model's top-6); unset leaves the engine's default
 *   (fast or full, picked for this machine). The flag exists from engine 0.1.50 on, so it is only offered then.
 * - load mode: `--mmap-experts auto|off|on` (auto, keep the experts in RAM, read them from the disk); unset = engine default.
 */
export type Deepseek41Speed = '' | '5' | '6';
export type Deepseek41LoadMode = '' | 'auto' | 'off' | 'on';

const LOAD_MODES: readonly string[] = ['auto', 'off', 'on'];
const argsOf = (config: JsonObject): string[] => Array.isArray(config.args) ? config.args.map(String) : [];

export function isDeepseek41Config(config: JsonObject | null | undefined): boolean {
  return !!config && config.arch === 'deepseek41';
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
  // A bare --mmap-experts (no value) means "on" to the engine.
  return value && LOAD_MODES.includes(value) ? value as Deepseek41LoadMode : 'on';
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
  return setValueFlag(config, '--mmap-experts', mode, token => token !== undefined && LOAD_MODES.includes(token));
}
