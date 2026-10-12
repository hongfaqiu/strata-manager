import type { JsonObject } from './types';
import { STARTUP_ENGINE_FLAGS } from './startup-engine-flags';
import { startupServiceEndpoint } from './config-profile';
export { STARTUP_ENGINE_FLAGS } from './startup-engine-flags';

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
    ['--max-context', '上下文容量（token）', 'Context capacity (tokens)', 'integer', ['4096', '32768', '65536', '131072', '262144', '524288'], 1, 2147483647],
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
  ...fields('prefill', 'arg', [
    ['--prefill', 'Prefill 分块（token）', 'Prefill chunk (tokens)', 'text', ['auto', 'auto:16384', 'auto:32768']],
    ['--no-prefill-borrow', '不借用专家缓存给 Prefill', 'Disable prefill borrowing', 'boolean'],
    ['--no-split-rows', '禁用分行 Prefill', 'Disable split rows', 'boolean'],
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
];

export function startupArgsOf(config: JsonObject): string[] { return config.args === undefined ? [] : argsOf(config); }
export function startupFieldValue(config: JsonObject, field: StartupFieldSpec): string {
  if (field.target === 'arg') {
    const args = startupArgsOf(config); const index = args.indexOf(field.key);
    return index < 0 ? '' : field.kind === 'boolean' ? 'true' : args[index + 1] ?? '';
  }
  let value: unknown = config;
  for (const key of field.key.split('.')) value = value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key) ? (value as JsonObject)[key] : undefined;
  return value === undefined ? '' : value === null ? 'null' : typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function applyStartupField(config: JsonObject, field: StartupFieldSpec, text: string): JsonObject {
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
    const args = startupArgsOf(config);
    const positions = args.flatMap((arg, index) => arg === field.key ? [index] : []);
    if (positions.length > 1) throw new Error(`${field.key}: 参数重复，请在完整参数列表中分别编辑 / edit duplicate options in the full argument list`);
    const arity = STARTUP_ENGINE_FLAGS[field.key] ?? (field.kind === 'boolean' ? 0 : 1);
    if (arity > 1) throw new Error(`${field.key}: 请在完整参数列表中编辑多个值 / edit multiple operands in the argument list`);
    const index = positions[0];
    const replacement = text === '' || (field.kind === 'boolean' && value === false) ? [] : arity === 0 ? [field.key] : [field.key, String(value)];
    if (index === undefined) args.push(...replacement);
    else args.splice(index, 1 + (arity && args[index + 1] !== undefined && !args[index + 1]!.startsWith('--') ? 1 : 0), ...replacement);
    next.args = args;
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
  return next;
}

export interface StartupArgRow { offset: number; tokens: string[]; known: boolean; arity: number }
/** Rows keep exact token order, repeated flags, unknown options and positional values. */
export function startupArgumentRows(config: JsonObject): StartupArgRow[] {
  const args = startupArgsOf(config); const rows: StartupArgRow[] = [];
  for (let offset = 0; offset < args.length;) {
    const token = args[offset]!;
    const known = Object.hasOwn(STARTUP_ENGINE_FLAGS, token);
    const arity = known ? STARTUP_ENGINE_FLAGS[token]! : token.startsWith('--') && args[offset + 1] !== undefined && !args[offset + 1]!.startsWith('--') ? 1 : 0;
    let length = 1;
    while (length <= arity && args[offset + length] !== undefined && !args[offset + length]!.startsWith('--')) length++;
    rows.push({ offset, tokens: args.slice(offset, offset + length), known, arity }); offset += length;
  }
  return rows;
}
export function replaceStartupArgument(config: JsonObject, row: StartupArgRow, tokens: string[]): JsonObject {
  const args = startupArgsOf(config);
  args.splice(row.offset, row.tokens.length, ...tokens);
  return { ...structuredClone(config), args };
}
export function parseStartupConfiguration(raw: string): JsonObject {
  const config: unknown = JSON.parse(raw);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('完整配置必须为 JSON 对象 / configuration must be a JSON object');
  startupArgsOf(config as JsonObject);
  return config as JsonObject;
}
export function validateStartupConfiguration(config: JsonObject): void {
  startupServiceEndpoint(config);
  for (const field of STARTUP_TUNING_FIELDS.filter(item => item.group === 'power')) {
    const value = config[field.key];
    if (value === undefined) continue;
    if (value === null) continue;
    if (typeof value !== 'number') throw new Error(`${field.key}: 必须为数值 / must be a number`);
    applyStartupField(config, field, String(value));
  }
  const args = startupArgsOf(config);
  if (args.some(value => !value.length)) throw new Error('args 包含空参数，请填写或移除 / remove or fill empty arguments');
  for (const row of startupArgumentRows(config)) if (row.known && row.tokens.length - 1 < row.arity) throw new Error(`${row.tokens[0]} 缺少参数值，需要 ${row.arity} 个 / missing operand(s), expected ${row.arity}`);
  const context = valueOf(args, '--max-context'); const resident = valueOf(args, '--kv-resident');
  const capacity = integer(context, '--max-context', 2147483647);
  if (resident && (!Number.isSafeInteger(Number(resident)) || Number(resident) < 0)) throw new Error('--kv-resident 必须为非负整数 / must be a nonnegative integer');
  if (resident && Number(resident) > (capacity ?? 4096)) throw new Error('上下文不能小于 --kv-resident，请同时调整两个参数 / context is below resident KV; adjust both options');
  for (const key of ['exe', 'cwd', 'tokenizer', 'model_name', 'log', 'host', 'api_key']) if (config[key] !== undefined && typeof config[key] !== 'string') throw new Error(`${key}: 必须为字符串 / must be a string`);
  for (const key of ['sampling', 'env', 'vision']) if (config[key] !== undefined && config[key] !== null && (!config[key] || typeof config[key] !== 'object' || Array.isArray(config[key]))) throw new Error(`${key}: 必须为对象或 null / must be an object or null`);
  for (const key of ['api_monitor', 'open_browser', 'lazy_load', 'fit_max_tokens']) if (config[key] !== undefined && typeof config[key] !== 'boolean') throw new Error(`${key}: 必须为布尔值 / must be a boolean`);
}
