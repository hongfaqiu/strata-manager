import type { JsonObject } from './types';
import { STARTUP_ENGINE_FLAGS } from './startup-engine-flags';
import { startupServiceEndpoint } from './config-profile';
import { concurrencyConfigError } from './concurrency';
import { contextExtensionError } from './context-extension';
import { parseSaved } from './gpu-roles';
import { isQwen36Config } from './catalog';
import { DEEPSEEK41_ENGINE_FLAGS, deepseek41ArgsError, isDeepseek41Config } from './deepseek41-config';
export { STARTUP_ENGINE_FLAGS } from './startup-engine-flags';

export interface StartupTuning { context: string; kv: string; threads: string }
const kvKinds = ['fp16', 'int8', 'q4_0', 'k8v4'];

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

function byFlag(gs: string[][]): Map<string, string[][]> {
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
export function captureUserArgs(config: JsonObject, skip: ReadonlySet<string> = new Set()): string[] {
  const flags = startupEngineFlagsFor(config);
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

function cleanArgLayersMetadata(config: JsonObject, touched: ReadonlySet<string>): void {
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
      for (const flag of touched) delete settings[flag];
      if (Object.keys(settings).length) config[CALIBRATED_KEY] = { ...rec, settings };
      else delete config[CALIBRATED_KEY];
    }
  }
}

/**
 * Upstream `tune_apply.py` / `arg_layers.record_calibration`: keep `user_args` except for the flags set by
 * calibration/tuning, and refresh `args_written` (only when already present). Configs without `user_args` stay untouched.
 */
export function syncCalibrationUserArgs(before: JsonObject, next: JsonObject, touchedFlags: Iterable<string>): JsonObject {
  const touched = new Set(touchedFlags);
  if (hasUserArgsLayer(before)) {
    const flags = startupEngineFlagsFor(before);
    const mine = argGroups(captureUserArgs(before), flags)
      .filter(g => !touched.has(flagOfGroup(g)))
      .flat();
    stampUserArgs(next, mine, Array.isArray(before[ARGS_WRITTEN_KEY]));
  }
  cleanArgLayersMetadata(next, touched);
  return next;
}

/**
 * Upstream `serve/runconfig.py`: a manual setting edit updates `user_args` (and `args_written` if present) when the
 * config already uses the `user_args` layer, or when the flag is one (`--spec`, `--draft-conf`) that upstream
 * `drafting.apply` only respects under DFlash2 from `user_args`.
 */
export function syncManualUserArgs(
  before: JsonObject,
  next: JsonObject,
  flag: string,
  replacementGroups: readonly (readonly string[])[],
): JsonObject {
  const needsDflash2Override = DFLASH2_USER_ARG_FLAGS.has(flag) && !isDeepseek41Config(before);
  if (hasUserArgsLayer(before) || (needsDflash2Override && replacementGroups.length > 0)) {
    const flags = startupEngineFlagsFor(before);
    const existing = argGroups(captureUserArgs(before), flags);
    const out: string[][] = [];
    let replaced = false;
    for (const g of existing) {
      if (flagOfGroup(g) === flag) {
        if (!replaced && replacementGroups.length > 0) {
          out.push(...replacementGroups.map(item => [...item]));
          replaced = true;
        }
      } else {
        out.push(g);
      }
    }
    if (!replaced && replacementGroups.length > 0) {
      out.push(...replacementGroups.map(item => [...item]));
    }
    stampUserArgs(next, out.flat(), Array.isArray(before[ARGS_WRITTEN_KEY]));
  }
  cleanArgLayersMetadata(next, new Set([flag]));
  return next;
}

function argsOf(config: JsonObject): string[] {
  if (!Array.isArray(config.args) || !config.args.every(x => typeof x === 'string')) throw new Error('args 必须为字符串数组 / args must be a string array');
  return [...config.args] as string[];
}
/** Raw `config.args` without `user_args` merged. */
export function rawStartupArgsOf(config: JsonObject): string[] {
  return config.args === undefined ? [] : argsOf(config);
}
/** Effective engine arguments (`user_args.merge(args, user_args)` when `user_args` is present). */
export function effectiveArgsOf(config: JsonObject): string[] {
  const raw = rawStartupArgsOf(config);
  if (!Array.isArray(config[USER_ARGS_KEY]) || !config[USER_ARGS_KEY].length) return raw;
  return mergeUserArgs(raw, config[USER_ARGS_KEY], startupEngineFlagsFor(config));
}
function valueOf(args: string[], flag: string): string {
  const positions = args.flatMap((value, i) => (value === flag || value.startsWith(`${flag}=`)) ? [i] : []);
  if (positions.length > 1) throw new Error(`${flag} 重复，请在原始配置中修正 / duplicate option`);
  if (!positions.length) return '';
  const at = positions[0]!;
  if (args[at]!.startsWith(`${flag}=`)) return args[at]!.slice(flag.length + 1);
  const value = args[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} 缺少参数 / missing value`);
  return value;
}
export function startupTuningOf(config: JsonObject): StartupTuning {
  const args = effectiveArgsOf(config);
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
  const effective = effectiveArgsOf(config);
  const setArg = (flag: string, value: string | undefined) => {
    const i = args.findIndex(item => item === flag || item.startsWith(`${flag}=`));
    if (i >= 0) args.splice(i, args[i] === flag ? 2 : 1, ...(value ? [flag, value] : []));
    else if (value) args.push(flag, value);
  };
  setArg('--max-context', context == null ? undefined : String(context));
  setArg('--kv', tuning.kv || undefined);
  const touchesThreads = args.includes('--threads') || effective.includes('--threads');
  if (touchesThreads) setArg('--threads', threads == null ? undefined : String(threads));
  const resident = valueOf(mergeUserArgs(args, config[USER_ARGS_KEY], startupEngineFlagsFor(config)), '--kv-resident');
  if (resident && Number(resident) > (context ?? 4096)) throw new Error('上下文不能小于现有 --kv-resident；请通过模型准备重新生成匹配配置 / context is below the existing resident KV window');
  const next: JsonObject = { ...structuredClone(config), args };
  if (threads == null) delete next.threads; else if ('threads' in config || !touchesThreads) next.threads = threads;
  return syncCalibrationUserArgs(config, next, ['--max-context', '--kv', ...(touchesThreads ? ['--threads'] : [])]);
}

export type StartupFieldGroup = 'context' | 'memory' | 'cache' | 'cpu' | 'prefill' | 'speculation' | 'ple' | 'model' | 'server' | 'vision' | 'sampling' | 'network' | 'power' | 'paths';
export interface StartupFieldSpec {
  key: string; target: 'arg' | 'config'; group: StartupFieldGroup;
  zh: string; en: string; kind: 'text' | 'integer' | 'number' | 'boolean';
  choices?: readonly string[]; min?: number; max?: number; minExclusive?: boolean;
}
type FieldTuple = [key: string, zh: string, en: string, kind: StartupFieldSpec['kind'], choices?: readonly string[], min?: number, max?: number, minExclusive?: boolean];
const fields = (group: StartupFieldGroup, target: StartupFieldSpec['target'], values: FieldTuple[]): StartupFieldSpec[] =>
  values.map(([key, zh, en, kind, choices, min, max, minExclusive]) => ({ key, zh, en, kind, choices, min, max, minExclusive, group, target }));

/** Engine values/flags verified in Strata generate.cpp, serve/server.py and serve/runconfig.py.
 * manager_gpu_power_limit_* are manager-owned settings applied before the service starts.
 * Enumerations are suggestions, not a closed schema: newer versions/custom values remain editable.
 * --pool-workers is the main engine CPU control; top-level threads is not used by this engine.
 */
export const STARTUP_TUNING_FIELDS: readonly StartupFieldSpec[] = [
  ...fields('context', 'arg', [
    ['--max-context', '上下文容量（token）', 'Context capacity (tokens)', 'integer', ['4096', '32768', '65536', '131072', '262144', '393216', '524288', '1048576'], 1, 2147483647],
    ['--kv', 'KV 缓存精度', 'KV precision', 'text', ['fp16', 'int8', 'q4_0', 'k8v4']],
    ['--kv-resident', '显存驻留 KV（token，0 为全部驻留）', 'Resident KV (tokens; 0 = full)', 'integer', undefined, 0],
    ['--kv-grow', '动态增长 KV', 'Grow KV dynamically', 'boolean'],
    ['--rope-scaling', 'RoPE 扩展模式', 'RoPE scaling mode', 'text', ['none', 'linear', 'yarn']],
    ['--rope-scale', 'RoPE 扩展倍数', 'RoPE scale', 'number', undefined, 1],
    ['--rope-freq-base', 'RoPE 频率基数（0 使用模型值）', 'RoPE frequency base (0 = model)', 'number', undefined, 0],
    ['--rope-freq-scale', 'RoPE 频率缩放', 'RoPE frequency scale', 'number'],
    ['--yarn-orig-ctx', 'YaRN 原始上下文', 'YaRN original context', 'number'],
    ['--yarn-ext-factor', 'YaRN 外推因子', 'YaRN extension factor', 'number'],
    ['--yarn-attn-factor', 'YaRN 注意力因子', 'YaRN attention factor', 'number'],
    ['--yarn-beta-fast', 'YaRN beta fast', 'YaRN beta fast', 'number'],
    ['--yarn-beta-slow', 'YaRN beta slow', 'YaRN beta slow', 'number'],
  ]),
  ...fields('memory', 'arg', [
    ['--expert-cache', '显存专家缓存槽数', 'Expert cache slots', 'text', ['auto']],
    ['--expert-cache-device1', 'GPU 1 专家缓存', 'GPU 1 expert cache', 'text', ['auto']],
    ['--expert-cache-device2', 'GPU 2 专家缓存', 'GPU 2 expert cache', 'text', ['auto']],
    ['--expert-cache-remote-placement', '多卡专家分配', 'Remote expert placement', 'text', ['stripe', 'layer']],
    ['--vram-reserve-mib', '保留显存（MiB）', 'Reserved VRAM (MiB)', 'integer', undefined, 0],
    ['--vram-reserve-later-mib', '后续 GPU 保留显存（MiB）', 'Later GPU reserve (MiB)', 'integer', undefined, 0],
    ['--resident-experts', '专家驻留内存', 'Resident experts in RAM', 'boolean'],
    ['--resident-budget-gib', '专家驻留预算（GiB）', 'Resident expert budget (GiB)', 'number', undefined, 0, undefined, true],
    ['--mmap-experts', '内存映射专家权重', 'Memory-map experts', 'boolean'],
    ['--vram-elastic', '弹性显存', 'Elastic VRAM', 'boolean'],
    ['--vram-segment-mib', '显存分段（MiB）', 'VRAM segment (MiB)', 'integer', undefined, 1],
    ['--gpu', 'GPU 编号（逗号分隔）', 'GPU indices (comma-separated)', 'text'],
    ['--layer-split', '跨 GPU 层分配', 'GPU layer split', 'text', ['auto']],
    ['--peer-device', '专家缓存辅助 GPU', 'Peer expert GPU', 'integer', undefined, 0],
    ['--peer-reserve-mib', '辅助 GPU 保留显存（MiB）', 'Peer reserved VRAM (MiB)', 'integer', undefined, 0],
  ]),
  ...fields('cache', 'arg', [
    ['--prompt-cache', '提示词检查点数', 'Prompt checkpoints', 'integer', undefined, 0],
    ['--prompt-cache-every', '提示词检查点间隔（token）', 'Checkpoint interval (tokens)', 'integer', undefined, 0],
    ['--prompt-cache-tail', '保留提示词尾部检查点', 'Keep tail checkpoint', 'boolean'],
    ['--prompt-cache-root', '根检查点（token）', 'Root checkpoint (tokens)', 'integer', undefined, 0],
    ['--conversation-cache-mib', '会话内存缓存预算（MiB）', 'Conversation cache budget (MiB)', 'integer', undefined, 0],
    ['--conversation-cache-slots', '会话缓存槽数', 'Conversation cache slots', 'integer', undefined, 0],
    ['--conversation-cache-min-free-mib', '会话缓存剩余内存下限（MiB）', 'Conversation free RAM floor (MiB)', 'integer', undefined, 0],
    ['--session-min-free-mib', '会话剩余内存下限（MiB）', 'Session free RAM floor (MiB)', 'integer', undefined, 0],
  ]),
  ...fields('cpu', 'arg', [
    ['--pool-workers', '主模型 CPU 工作线程数（0 自动）', 'Main-model CPU workers (0 = auto)', 'integer', undefined, 0],
    ['--pool-affinity', 'CPU 核心分配', 'CPU affinity', 'text', ['auto', 'p-cores', 'all']],
    ['--pool-tasks', 'CPU 任务数（0 自动）', 'CPU tasks (0 = auto)', 'integer', undefined, 0, 4096],
    ['--host-core', '主循环核心', 'Host-loop core', 'text', ['first', 'last']],
    ['--no-host-worker', '禁用主循环工作线程', 'Disable host worker', 'boolean'],
  ]),
  ...fields('cpu', 'config', [
    ['pool_cores', '实验：CPU 专家线程使用的逻辑处理器', 'Experimental: logical processors for CPU expert workers', 'text'],
  ]),
  ...fields('prefill', 'arg', [
    ['--prefill', 'Prefill 分块（token）', 'Prefill chunk (tokens)', 'text', ['auto', 'auto:16384', 'auto:32768']],
    ['--no-prefill-borrow', '不借用专家缓存给 Prefill', 'Disable prefill borrowing', 'boolean'],
    ['--no-split-rows', '禁用分行 Prefill', 'Disable split rows', 'boolean'],
    ['--prefill-pipe', '预填充分块（prefill pipe）', 'Prefill pipe', 'number', ['0', '1'], 0, 262144],
    ['--pcie-frac', 'PCIe 专家比例', 'PCIe expert fraction', 'number', undefined, 0, 1],
    ['--pcie-mode', 'PCIe 传输模式', 'PCIe transfer mode', 'text', ['dma', 'direct']],
  ]),
  ...fields('speculation', 'arg', [
    ['--spec', '推测解码窗口', 'Speculative window', 'integer', undefined, 0],
    ['--spec-min-p', '草稿最小概率', 'Draft minimum probability', 'number', undefined, 0, 1],
    ['--batch', '引擎并发槽数', 'Engine batch slots', 'integer', undefined, 1],
    ['--batch-mtp', '启用并发 MTP', 'Enable batched MTP', 'boolean'],
    ['--batch-groups', '并发组数', 'Batch groups', 'text', ['auto']],
    ['--mtp-window', 'MTP 窗口', 'MTP window', 'integer', undefined, 0],
    ['--mtp-hnorm', 'MTP 归一化存储', 'MTP normalization', 'text', ['pooled', 'stream']],
    ['--mtp-q4', 'MTP Q4 范围', 'MTP Q4 scope', 'text', ['all', 'proj', 'head']],
    ['--adapt-every', '专家适应间隔', 'Expert adaptation interval', 'integer', undefined, 0],
    ['--adapt-swaps', '专家交换数', 'Expert swaps', 'integer', undefined, 0],
    ['--adapt-decay', '专家适应衰减', 'Expert adaptation decay', 'number', undefined, 0, 1],
    ['--adapt-async', '异步专家适应', 'Asynchronous adaptation', 'integer', ['0', '1'], 0, 1],
  ]),
  ...fields('ple', 'arg', [
    ['--ple-io', 'PLE 表读取方式', 'PLE table I/O', 'text', ['direct', 'mmap', 'ram']],
    ['--ple-row-cache', 'PLE 行缓存数', 'PLE row cache', 'integer', undefined, 0],
    ['--ple-inflight', 'PLE 并行读取数', 'PLE reads in flight', 'integer', undefined, 1],
    ['--ple-sync-submit', '同步提交 PLE 读取', 'Submit PLE reads synchronously', 'boolean'],
  ]),
  ...fields('model', 'arg', [
    ['--native', '主权重文件', 'Main weight file', 'text'],
    ['--ple-gguf', 'PLE 权重文件', 'PLE weight file', 'text'],
    ['--pack', '模型包目录', 'Model pack directory', 'text'],
    ['--mtp', 'MTP 目录', 'MTP directory', 'text'],
    ['--expert-profile', '专家配置文件', 'Expert profile file', 'text'],
    ['--expert-profile-save', '专家配置保存路径', 'Expert profile save path', 'text'],
    ['--expert-profile-save-every', '专家配置保存间隔（分钟）', 'Profile save interval (minutes)', 'number', undefined, 0],
    ['--stats', '引擎统计输出', 'Engine statistics', 'boolean'],
  ]),
  ...fields('server', 'config', [
    ['parallel', '服务并发请求数', 'Parallel requests', 'integer', undefined, 1, 64],
    ['lazy_load', '首次请求时加载', 'Load on first request', 'boolean'],
    ['idle_unload_s', '空闲释放内存（秒，0 禁用）', 'Idle unload (seconds; 0 = off)', 'number', undefined, 0],
    ['engine_silence_s', '引擎无输出超时（秒，0 等待）', 'Engine silence timeout (seconds; 0 = wait)', 'number', undefined, 0],
    ['min_free_vram_mib', '加载所需空闲显存（MiB）', 'Free VRAM required to load (MiB)', 'integer', undefined, 0],
    ['api_monitor', '请求查看器', 'Request viewer', 'boolean'],
    ['open_browser', '就绪后打开浏览器', 'Open browser when ready', 'boolean'],
    ['fit_max_tokens', '输出上限适配剩余上下文', 'Fit output to remaining context', 'boolean'],
    ['reasoning_budget_tokens', '思考 token 预算（0 不限制）', 'Thinking token budget (0 = unlimited)', 'integer', undefined, 0],
    ['anthropic_thinking', 'Anthropic 思考模式', 'Anthropic thinking mode', 'text', ['model', 'on_request']],
    ['effort_position', '推理强度提示位置', 'Effort hint position', 'text', ['start', 'end']],
    ['model_name', '模型 API 名称', 'Model API name', 'text'],
  ]),
  ...fields('vision', 'config', [
    ['vision.exe', '视觉引擎路径', 'Vision engine path', 'text'],
    ['vision.model', '视觉模型路径', 'Vision model path', 'text'],
    ['vision.mmproj', '视觉投影文件', 'Vision projector path', 'text'],
    ['vision.gpu', '视觉编码使用 GPU', 'Run vision encoder on GPU', 'boolean'],
    ['vision.cuda_device', '视觉 GPU 编号', 'Vision GPU index', 'integer', undefined, 0],
    ['vision.threads', '视觉编码 CPU 线程数', 'Vision CPU threads', 'integer', undefined, 1],
    ['vision.max_tokens', '图片最大 token 数', 'Maximum image tokens', 'integer', undefined, 1],
    ['vision.min_tokens', '图片最小 token 数', 'Minimum image tokens', 'integer', undefined, 0],
  ]),
  ...fields('sampling', 'config', [
    ['sampling.temperature', '默认 Temperature', 'Default temperature', 'number', undefined, 0],
    ['sampling.top_p', '默认 Top P', 'Default top P', 'number', undefined, 0, 1, true],
    ['sampling.top_k', '默认 Top K', 'Default top K', 'integer', undefined, 1, 64],
    ['sampling.min_p', '默认 Min P', 'Default min P', 'number', undefined, 0, 1],
    ['sampling.experimental_speed_projection', '默认实验投影', 'Default experimental speed projection', 'boolean'],
  ]),
  ...fields('network', 'config', [
    ['host', '监听地址', 'Listen address', 'text', ['127.0.0.1', 'localhost', '0.0.0.0', '::']],
    ['port', 'API 端口', 'API port', 'integer', undefined, 1, 65535],
  ]),
  ...fields('power', 'config', [
    ['manager_gpu_power_limit_watts', 'GPU 功耗上限（W）', 'GPU power limit (W)', 'number', undefined, 0, undefined, true],
    ['manager_gpu_power_limit_device', '功耗设置 GPU 编号', 'Power-limit GPU index', 'integer', undefined, 0, 4294967295],
  ]),
  ...fields('paths', 'config', [
    ['gpu', '服务 GPU 编号', 'Service GPU indices', 'text'],
    ['layer_split', '服务 GPU 层分配', 'Service GPU layer split', 'text', ['auto']],
    ['exe', '主引擎路径', 'Main engine path', 'text'],
    ['cwd', '工作目录', 'Working directory', 'text'],
    ['tokenizer', 'Tokenizer 目录', 'Tokenizer directory', 'text'],
    ['log', '引擎日志路径', 'Engine log path', 'text'],
  ]),
  // Concurrency companions (docs/BATCHING.md); the experimental switches are engine env, off by default upstream.
  ...fields('speculation', 'arg', [
    ['--trim-stage-weights', '多卡只加载本卡层权重', 'Trim stage weights per GPU', 'boolean'],
  ]),
  ...fields('speculation', 'config', [
    ['env.STRATA_BATCH_ATTN_ROWS', '实验：并发注意力合并启动', 'Experimental: one attention launch for all slots', 'text', ['1']],
    ['env.STRATA_BATCH_GDN_GROUPS', '实验：并发 GDN 合并启动', 'Experimental: one GDN launch for all slots', 'text', ['1']],
    ['env.STRATA_PIPED_CONCURRENT', '实验：流水线旁并行读取提示词', 'Experimental: read prompts beside pipelined groups', 'text', ['1']],
  ]),
];

/** Optional one-line explanations shown under a field in the graphical editor (zh + en). */
export const STARTUP_FIELD_HINTS: Readonly<Record<string, { zh: string; en: string }>> = {
  pool_cores: {
    zh: '进阶、默认关闭：把 CPU 专家线程固定到这些逻辑处理器，例如 0,2,4,6 或 2-14:2（起-止:步长）。需要 Strata 0.2.2（引擎 0.1.47）及以上；留空保持默认分配。args 里已有 --pool-cores 时以它为准。',
    en: 'Advanced, off by default: pins the CPU expert workers to these logical processors, e.g. 0,2,4,6 or 2-14:2 (start-end:step). Needs Strata 0.2.2 (engine 0.1.47) or newer; leave empty for the default placement. A --pool-cores in args wins.',
  },
  'sampling.experimental_speed_projection': {
    zh: '仅在引擎已加载实验投影控制向量时生效，不会自动加载或下载向量，也不保证提速或效果。只给没带这个参数的请求当默认值：请求里的值和共享采样设置优先，Manager 聊天仍按会话开关发送。保存后重启模型生效；“使用默认设置”会删除这一项，不会强制开启。',
    en: 'Only takes effect when the engine has already loaded an experimental projection control vector; this does not load or download one and promises no speed-up or quality change. It is the default for requests that leave the parameter out: a value in the request and the shared sampling settings come first, and Manager chat keeps sending its per-chat switch. Restart the model after saving; “Use default” removes the entry rather than forcing it on.',
  },
  '--prefill-pipe': {
    zh: '仅在跨 GPU 层分配（--layer-split）时生效：按流水线切分提示词分块。0 关闭（默认），1 仅平均分块数，大于 1 为本机 b/a（token，可由快速校准或官方 --calibrate 测得），范围 0–262144。',
    en: 'Only affects a layer split (--layer-split): sizes prompt chunks for the pipeline. 0 off (default), 1 only evens out the chunk count, > 1 is this PC\'s b/a in tokens (measured by quick calibration or the official --calibrate); range 0–262144.',
  },
  '--spec': {
    zh: '每轮推测的草稿词数上限：MTP 默认 4，DFlash2 默认 6。在此手动设置后会写入 user_args 作为手动覆盖项，DFlash2 与 MTP 均按所设值运行；“使用默认设置”则恢复当前推测解码策略的默认值。',
    en: 'Maximum drafted tokens per step: MTP defaults to 4 and DFlash2 defaults to 6. A value set here is recorded in user_args as a manual override so both DFlash2 and MTP honour it; "Use default" restores the active drafting policy default.',
  },
};

const POOL_CORES = /^[0-9]+(-[0-9]+(:[0-9]+)?)?(,[0-9]+(-[0-9]+(:[0-9]+)?)?)*$/;
/** serve/server.py pool_cores_args (v0.2.2): a text like "0,2,4,6" / "2-14:2", or a list of processor numbers. */
export function poolCoresValid(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every(v => Number.isSafeInteger(v) && (v as number) >= 0);
  return typeof value === 'string' && POOL_CORES.test(value.replace(/ /g, ''));
}
/** Config fields whose stored null means the same as leaving them out. */
const NULL_AS_DEFAULT_FIELDS: ReadonlySet<string> = new Set(['sampling.experimental_speed_projection']);

export function startupArgsOf(config: JsonObject): string[] { return effectiveArgsOf(config); }
/**
 * Whether a startup field belongs to this config. DeepSeek-V4.1-Flash runs on its own engine (strata-dsv41) with its own
 * options, set on the run-options card (deepseek41-config): no Qwen engine option field is shown or written for it
 * (the Qwen switch `--mmap-experts` would be a bare flag there, and the other options mean something else or are unknown).
 */
export function startupFieldApplies(config: JsonObject | null | undefined, field: StartupFieldSpec): boolean {
  if (field.target === 'arg' && isDeepseek41Config(config)) return false;
  // Qwen3.6's own engine path ignores --vram-reserve-mib today; upstream #5216 will refuse it. Never show or write it.
  if (field.target === 'arg' && isQwen36Config(config) && (field.key === '--vram-reserve-mib' || field.key === '--vram-reserve-later-mib')) return false;
  return true;
}
/** The option table a config's argument list is read with: strata-dsv41's own for DeepSeek configs, else the Qwen engine's. */
export function startupEngineFlagsFor(config: JsonObject | null | undefined): Readonly<Record<string, number>> {
  return isDeepseek41Config(config) ? DEEPSEEK41_ENGINE_FLAGS : STARTUP_ENGINE_FLAGS;
}
export function startupFieldValue(config: JsonObject, field: StartupFieldSpec): string {
  if (!startupFieldApplies(config, field)) return '';
  if (field.target === 'arg') {
    const args = effectiveArgsOf(config);
    const index = args.findIndex(item => item === field.key || item.startsWith(`${field.key}=`));
    if (index < 0) return '';
    if (field.kind === 'boolean') return 'true';
    const token = args[index]!;
    return token.startsWith(`${field.key}=`) ? token.slice(field.key.length + 1) : args[index + 1] ?? '';
  }
  let value: unknown = config;
  for (const key of field.key.split('.')) value = value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key) ? (value as JsonObject)[key] : undefined;
  // Strata treats a null sampling default like a missing one: show "Use default" and leave the stored null alone until edited.
  if (value === null && NULL_AS_DEFAULT_FIELDS.has(field.key)) return '';
  return value === undefined ? '' : value === null ? 'null' : typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function applyStartupField(config: JsonObject, field: StartupFieldSpec, text: string): JsonObject {
  if (!startupFieldApplies(config, field)) throw new Error(`${field.key}: DeepSeek 配置使用自己的运行选项，不写入此项 / DeepSeek configs use their own run options`);
  if (field.group === 'power' && !text.trim()) text = '';
  const next = structuredClone(config);
  let value: unknown = text;
  if (text !== '') {
    if (field.kind === 'boolean') { if (text !== 'true' && text !== 'false') throw new Error(`${field.key}: true / false`); value = text === 'true'; }
    if (field.kind === 'integer' || field.kind === 'number') {
      const number = Number(text);
      if (!text.trim() || !Number.isFinite(number) || (field.kind === 'integer' && !Number.isSafeInteger(number)) || (field.min !== undefined && (field.minExclusive ? number <= field.min : number < field.min)) || (field.max !== undefined && number > field.max)) throw new Error(`${field.key}: ${field.kind === 'integer' ? '整数 / integer' : '数值 / number'}${field.min !== undefined ? ` ${field.minExclusive ? '>' : '≥'} ${field.min}` : ''}${field.max !== undefined ? ` ≤ ${field.max}` : ''}`);
      value = number;
    }
  }
  if (field.target === 'arg') {
    const rawArgs = rawStartupArgsOf(config);
    const effective = effectiveArgsOf(config);
    const matches = (arg: string) => arg === field.key || arg.startsWith(`${field.key}=`);
    const rawPositions = rawArgs.flatMap((arg, index) => matches(arg) ? [index] : []);
    const effPositions = effective.flatMap((arg, index) => matches(arg) ? [index] : []);
    if (rawPositions.length > 1 || effPositions.length > 1) throw new Error(`${field.key}: 参数重复，请在完整参数列表中分别编辑 / edit duplicate options in the full argument list`);
    const arity = STARTUP_ENGINE_FLAGS[field.key] ?? (field.kind === 'boolean' ? 0 : 1);
    if (arity > 1) throw new Error(`${field.key}: 请在完整参数列表中编辑多个值 / edit multiple operands in the argument list`);
    const index = rawPositions[0];
    const replacement = text === '' || (field.kind === 'boolean' && value === false) ? [] : arity === 0 ? [field.key] : [field.key, String(value)];
    if (index === undefined) rawArgs.push(...replacement);
    else rawArgs.splice(index, rawArgs[index]!.startsWith(`${field.key}=`) ? 1 : 1 + (arity && rawArgs[index + 1] !== undefined && !rawArgs[index + 1]!.startsWith('--') ? 1 : 0), ...replacement);
    next.args = rawArgs;
    return syncManualUserArgs(config, next, field.key, replacement.length ? [replacement] : []);
  } else {
    const keys = field.key.split('.');
    const apply = (object: JsonObject, index: number): JsonObject => {
      const result = { ...object }; const key = keys[index]!;
      if (index === keys.length - 1) { if (text === '') delete result[key]; else result[key] = value; }
      else {
        const current = Object.hasOwn(object, key) ? object[key] : undefined;
        const child = apply(current && typeof current === 'object' && !Array.isArray(current) ? current as JsonObject : {}, index + 1);
        if (Object.keys(child).length) result[key] = child; else delete result[key];
      }
      return result;
    };
    return apply(next, 0);
  }
}

export interface StartupArgRow { offset: number; tokens: string[]; known: boolean; arity: number }
/** Rows keep exact token order, repeated flags, unknown options and positional values. */
export function startupArgumentRows(config: JsonObject): StartupArgRow[] {
  const args = startupArgsOf(config); const rows: StartupArgRow[] = []; const flags = startupEngineFlagsFor(config);
  for (let offset = 0; offset < args.length;) {
    const token = args[offset]!;
    const known = Object.hasOwn(flags, token);
    const arity = known ? flags[token]! : token.startsWith('--') && args[offset + 1] !== undefined && !args[offset + 1]!.startsWith('--') ? 1 : 0;
    let length = 1;
    while (length <= arity && args[offset + length] !== undefined && !args[offset + length]!.startsWith('--')) length++;
    rows.push({ offset, tokens: args.slice(offset, offset + length), known, arity }); offset += length;
  }
  return rows;
}
export function replaceStartupArgument(config: JsonObject, row: StartupArgRow, tokens: string[]): JsonObject {
  const args = startupArgsOf(config);
  args.splice(row.offset, row.tokens.length, ...tokens);
  const next: JsonObject = { ...structuredClone(config), args };
  const oldFlag = flagOfGroup(row.tokens);
  const newFlag = flagOfGroup(tokens);
  const touchedFlags = [...new Set([oldFlag, newFlag].filter(Boolean))];
  const flags = startupEngineFlagsFor(config);
  for (const flag of touchedFlags) {
    const groupsInArgs = argGroups(args, flags).filter(g => flagOfGroup(g) === flag);
    syncManualUserArgs(config, next, flag, groupsInArgs);
  }
  return next;
}
export function appendStartupArgument(config: JsonObject, tokens: string[]): JsonObject {
  const args = startupArgsOf(config);
  return replaceStartupArgument(config, { offset: args.length, tokens: [], known: false, arity: 0 }, tokens);
}
export function parseStartupConfiguration(raw: string): JsonObject {
  const config: unknown = JSON.parse(raw);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('完整配置必须为 JSON 对象 / configuration must be a JSON object');
  rawStartupArgsOf(config as JsonObject);
  const obj = config as JsonObject;
  if (obj[USER_ARGS_KEY] !== undefined && (!Array.isArray(obj[USER_ARGS_KEY]) || !(obj[USER_ARGS_KEY] as unknown[]).every(x => typeof x === 'string'))) {
    throw new Error('user_args 必须为字符串数组 / user_args must be a string array');
  }
  if (obj[ARGS_WRITTEN_KEY] !== undefined && (!Array.isArray(obj[ARGS_WRITTEN_KEY]) || !(obj[ARGS_WRITTEN_KEY] as unknown[]).every(x => typeof x === 'string'))) {
    throw new Error('args_written 必须为字符串数组 / args_written must be a string array');
  }
  return obj;
}
export function validateStartupConfiguration(config: JsonObject): void {
  startupServiceEndpoint(config);
  const concurrencyError = concurrencyConfigError(config); if (concurrencyError) throw new Error(concurrencyError);
  for (const field of STARTUP_TUNING_FIELDS.filter(item => item.group === 'power')) {
    const value = config[field.key];
    if (value === undefined) continue;
    if (value === null) continue;
    if (typeof value !== 'number') throw new Error(`${field.key}: 必须为数值 / must be a number`);
    applyStartupField(config, field, String(value));
  }
  const rawArgs = rawStartupArgsOf(config);
  if (config[USER_ARGS_KEY] !== undefined && (!Array.isArray(config[USER_ARGS_KEY]) || !(config[USER_ARGS_KEY] as unknown[]).every(x => typeof x === 'string'))) {
    throw new Error('user_args 必须为字符串数组 / user_args must be a string array');
  }
  if (config[ARGS_WRITTEN_KEY] !== undefined && (!Array.isArray(config[ARGS_WRITTEN_KEY]) || !(config[ARGS_WRITTEN_KEY] as unknown[]).every(x => typeof x === 'string'))) {
    throw new Error('args_written 必须为字符串数组 / args_written must be a string array');
  }
  const args = startupArgsOf(config);
  if (rawArgs.some(value => !value.length) || args.some(value => !value.length)) throw new Error('args 包含空参数，请填写或移除 / remove or fill empty arguments');
  for (const row of startupArgumentRows(config)) if (row.known && row.tokens.length - 1 < row.arity) throw new Error(`${row.tokens[0]} 缺少参数值，需要 ${row.arity} 个 / missing operand(s), expected ${row.arity}`);
  const deepseekError = deepseek41ArgsError(config); if (deepseekError) throw new Error(deepseekError);
  const context = valueOf(args, '--max-context'); const resident = valueOf(args, '--kv-resident');
  const capacity = integer(context, '--max-context', 2147483647);
  if (resident && (!Number.isSafeInteger(Number(resident)) || Number(resident) < 0)) throw new Error('--kv-resident 必须为非负整数 / must be a nonnegative integer');
  if (resident && Number(resident) > (capacity ?? 4096)) throw new Error('上下文不能小于 --kv-resident，请同时调整两个参数 / context is below resident KV; adjust both options');
  const ropeError = contextExtensionError(context, valueOf(args, '--rope-scaling'), valueOf(args, '--rope-scale'));
  if (ropeError) throw new Error(ropeError);
  for (const key of ['exe', 'cwd', 'tokenizer', 'model_name', 'log', 'host']) if (config[key] !== undefined && typeof config[key] !== 'string') throw new Error(`${key}: 必须为字符串 / must be a string`);
  if (config.api_key !== undefined && typeof config.api_key !== 'string' && !(Array.isArray(config.api_key) && config.api_key.every(key => typeof key === 'string' && !!key.trim()))) throw new Error('api_key: 必须为字符串或非空密钥的数组 / must be a string or an array of nonempty keys');
  if (config.pool_cores !== undefined && config.pool_cores !== null && config.pool_cores !== '' && !poolCoresValid(config.pool_cores)) throw new Error('pool_cores: 逻辑处理器编号，如 "0,2,4,6" 或 "2-14:2" / logical processor numbers like "0,2,4,6" or "2-14:2"');
  if (config.gpu_roles !== undefined && config.gpu_roles !== null && !parseSaved(config.gpu_roles)) throw new Error('gpu_roles: 每张卡为 main / helper / off，最多一张 main / each card is main, helper or off, with at most one main');
  for (const key of ['sampling', 'env', 'vision']) if (config[key] !== undefined && config[key] !== null && (!config[key] || typeof config[key] !== 'object' || Array.isArray(config[key]))) throw new Error(`${key}: 必须为对象或 null / must be an object or null`);
  // tool_call_recovery: Strata 0.2.8 turns it on by default and stops the start on anything but true or false (null too).
  for (const key of ['api_monitor', 'open_browser', 'lazy_load', 'fit_max_tokens', 'tool_call_recovery']) if (config[key] !== undefined && typeof config[key] !== 'boolean') throw new Error(`${key}: 必须为布尔值 / must be a boolean`);
  // Strata refuses to start on a non-boolean here ("false", 0, 1); null and a missing key mean "use the default".
  const projection = (config.sampling as JsonObject | null | undefined)?.experimental_speed_projection;
  if (projection != null && typeof projection !== 'boolean') throw new Error('sampling.experimental_speed_projection: 必须为 true、false 或 null / must be true, false or null');
}
