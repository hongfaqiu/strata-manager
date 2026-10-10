import type { JsonObject } from './types';

export interface StartupTuning { context: string; kv: string; threads: string }
const kvKinds = ['fp16', 'int8', 'q4_0', 'k8v4'];
function argsOf(config: JsonObject): string[] {
  if (!Array.isArray(config.args) || !config.args.every(x => typeof x === 'string')) throw new Error('args 必须为字符串数组 / args must be a string array');
  return [...config.args] as string[];
}
function valueOf(args: string[], flag: string): string {
  const positions = args.flatMap((value, i) => value === flag ? [i] : []);
  if (positions.length > 1) throw new Error(`${flag} 重复，请在原始配置中修正 / duplicate option`);
  if (!positions.length) return '';
  const value = args[positions[0]! + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} 缺少参数 / missing value`);
  return value;
}
export function startupTuningOf(config: JsonObject): StartupTuning {
  const args = argsOf(config);
  const argThreads = valueOf(args, '--threads');
  return { context: valueOf(args, '--max-context'), kv: valueOf(args, '--kv'), threads: config.threads == null ? argThreads : String(config.threads) };
}
function integer(text: string, label: string, max: number): number | undefined {
  if (!text.trim()) return undefined;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new Error(`${label} 必须为 1–${max} 的整数 / must be a whole number in this range`);
  return value;
}
/** Change only known engine options, retaining model paths, security, MCP and unknown flags. */
export function applyStartupTuning(config: JsonObject, tuning: StartupTuning): JsonObject {
  const current = startupTuningOf(config);
  const context = integer(tuning.context, '--max-context', 2147483647);
  const threads = integer(tuning.threads, 'threads', 65535);
  if (tuning.kv !== current.kv && tuning.kv && !kvKinds.includes(tuning.kv)) throw new Error('KV 必须为 fp16 / int8 / q4_0 / k8v4');
  const args = argsOf(config);
  const setArg = (flag: string, value: string | undefined) => {
    const i = args.indexOf(flag);
    if (i >= 0) args.splice(i, 2, ...(value ? [flag, value] : []));
    else if (value) args.push(flag, value);
  };
  setArg('--max-context', context == null ? undefined : String(context));
  setArg('--kv', tuning.kv || undefined);
  if (args.includes('--threads')) setArg('--threads', threads == null ? undefined : String(threads));
  const resident = valueOf(args, '--kv-resident');
  if (resident && Number(resident) > (context ?? 4096)) throw new Error('上下文不能小于现有 --kv-resident；请通过模型准备重新生成匹配配置 / context is below the existing resident KV window');
  const next: JsonObject = { ...structuredClone(config), args };
  if (threads == null) delete next.threads; else if ('threads' in config || !config.args || !(config.args as string[]).includes('--threads')) next.threads = threads;
  return next;
}
