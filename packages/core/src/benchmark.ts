import { isDesktop, normalizeBaseUrl, request, serviceStatus, streamChat } from './bridge';
import { asObject, normalizeError, StrataError } from './errors';
import type { JsonObject, ServiceProfile } from './types';

export interface BenchmarkOptions {
  prompt: string;
  rounds: number;
  maxTokens: number;
  warmup: boolean;
  /** Unique changes the start of each prompt; it does not restart or clear engine caches. */
  mode: 'unique' | 'repeat';
  timeoutMs: number;
}

export interface BenchmarkSample {
  index: number;
  warmup: boolean;
  state: 'completed' | 'failed' | 'cancelled';
  model: string;
  startedAt: number;
  ttftMs: number | null;
  wallMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  prefillTokS: number | null;
  decodeTokS: number | null;
  output: string;
  error?: string;
  finishReason?: string;
}

export interface BenchmarkReport {
  id: string;
  profileId: string;
  profileName: string;
  baseUrl: string;
  model: string;
  startedAt: number;
  finishedAt: number;
  options: BenchmarkOptions;
  samples: BenchmarkSample[];
  state: 'completed' | 'failed' | 'cancelled';
  /** Read-only snapshots captured before the first request. */
  hardware?: JsonObject;
  engine?: JsonObject;
}

const mixedPrompt = `请审查下面的 TypeScript 异步任务队列，并用中文解释潜在问题，然后给出一个更可靠的实现。重点检查并发上限、同步抛错、Promise 拒绝、finally 释放槽位，以及任务执行顺序。请先写简洁的分析，再输出完整代码和三个可以实际运行的测试案例。不要仅重复原代码，也不要使用第三方依赖。

class TaskQueue {
  running = 0;
  waiting: Array<() => void> = [];
  constructor(public limit = 2) {}
  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const start = () => {
        this.running++;
        task().then(resolve, reject).finally(() => {
          this.running--;
          this.waiting.shift()?.();
        });
      };
      if (this.running < this.limit) start();
      else this.waiting.push(start);
    });
  }
}

补充要求：limit 必须是正整数；task 可能在返回 Promise 之前抛错；某个任务失败不能阻止其他任务。请说明为什么你的实现能在所有这些情况下正确释放并发槽位。`;

export const BENCHMARK_PROMPTS = {
  short: '请用中文解释 Promise 的 resolve、reject 与 finally 的用途，给出一个会失败但仍执行清理的 TypeScript 示例。',
  mixed: mixedPrompt,
  long: `${Array.from({ length: 6 }, (_, index) => `审查材料 ${index + 1}：\n${mixedPrompt}`).join('\n\n')}\n\n请综合所有材料，输出统一的可靠实现与测试说明。`,
} as const;

export const DEFAULT_BENCHMARK_OPTIONS: BenchmarkOptions = {
  prompt: BENCHMARK_PROMPTS.mixed, rounds: 3, maxTokens: 256,
  warmup: false, mode: 'unique', timeoutMs: 120_000,
};

const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const nonnegative = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const now = () => performance.now();
const activeServices = new Set<string>();

/** Shared by serial, suite and stress runs, including loopback host aliases. */
export function acquireBenchmarkEndpoint(baseUrl: string): () => void {
  const serviceKey = new URL(normalizeBaseUrl(baseUrl)).port || '80';
  if (activeServices.has(serviceKey)) throw new StrataError('BENCHMARK_ALREADY_RUNNING', '此服务已有一组测试正在执行');
  activeServices.add(serviceKey);
  return () => { activeServices.delete(serviceKey); };
}

function validateOptions(options: BenchmarkOptions): void {
  const invalid = (message: string) => { throw new StrataError('INVALID_BENCHMARK_OPTIONS', message); };
  if (typeof options.prompt !== 'string' || !options.prompt.trim() || options.prompt.length > 65_536) invalid('测试提示词不能为空，且最多为 65,536 个字符');
  if (!Number.isSafeInteger(options.rounds) || options.rounds < 1 || options.rounds > 10) invalid('测试轮数必须为 1–10 的整数');
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 16 || options.maxTokens > 4096) invalid('最大输出 token 必须为 16–4096 的整数');
  if (options.mode !== 'unique' && options.mode !== 'repeat') invalid('请选择独立提示词或重复提示词模式');
  if (typeof options.warmup !== 'boolean') invalid('预热选项必须为布尔值');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 600_000) invalid('每轮超时必须为 1–600 秒');
}

/** Bounds read-only preflight calls even when the transport has no AbortSignal API. */
async function bounded<T>(work: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new StrataError('CANCELLED', '测试已取消');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StrataError('BENCHMARK_TIMEOUT', '测试请求超时')), timeoutMs);
    cancel = () => reject(new StrataError('CANCELLED', '测试已取消'));
    signal?.addEventListener('abort', cancel, { once: true });
  });
  try { return await Promise.race([work, interrupted]); }
  finally { clearTimeout(timer); if (cancel) signal?.removeEventListener('abort', cancel); }
}

function verifyHealth(health: JsonObject, model?: string): string {
  if (health.service !== 'strata' || health.status !== 'ok') throw new StrataError('BENCHMARK_SERVICE_UNAVAILABLE', '请先连接健康的 Strata 服务');
  if (health.loaded !== true) throw new StrataError('BENCHMARK_MODEL_UNLOADED', '模型尚未加载，请先在服务管理中启动并加载模型');
  if (typeof health.model !== 'string' || !health.model.trim()) throw new StrataError('BENCHMARK_MODEL_UNKNOWN', '服务未报告当前加载的模型名称');
  if (model && health.model !== model) throw new StrataError('BENCHMARK_MODEL_CHANGED', '测试期间模型发生变化，已停止后续轮次');
  return health.model;
}

function emptySample(index: number, warmup: boolean, model: string): BenchmarkSample {
  return { index, warmup, model, state: 'completed', startedAt: Date.now(), ttftMs: null, wallMs: 0,
    promptTokens: null, completionTokens: null, cachedTokens: null, prefillTokS: null, decodeTokS: null, output: '' };
}

async function runSample(profile: ServiceProfile, options: BenchmarkOptions, id: string, sample: BenchmarkSample, signal?: AbortSignal): Promise<void> {
  const controller = new AbortController();
  const began = now();
  let reasoning = '', active = true, cancelled = signal?.aborted ?? false, timeout = false, done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interrupt: ((reason: unknown) => void) | undefined;
  const cancel = () => {
    cancelled = true; controller.abort();
    interrupt?.(new StrataError('CANCELLED', '测试已取消'));
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const interrupted = new Promise<never>((_, reject) => {
    interrupt = reject;
    timer = setTimeout(() => {
      timeout = true; controller.abort();
      reject(new StrataError('BENCHMARK_TIMEOUT', `本轮超过 ${options.timeoutMs / 1000} 秒，已取消请求`));
    }, options.timeoutMs);
  });
  try {
    if (cancelled) throw new StrataError('CANCELLED', '测试已取消');
    const prompt = options.mode === 'unique' ? `[benchmark ${id}/${sample.warmup ? 'warmup' : sample.index}]\n${options.prompt}` : options.prompt;
    await Promise.race([streamChat(profile, { model: sample.model, messages: [{ role: 'user', content: prompt }],
      stream: true, stream_options: { include_usage: true }, max_tokens: options.maxTokens, temperature: 0, seed: 42 }, delta => {
      if (!active) return;
      if (delta.done) done = true;
      if (sample.ttftMs === null && ((delta.content?.length ?? 0) > 0 || (delta.reasoning?.length ?? 0) > 0)) sample.ttftMs = Math.max(0, now() - began);
      if (delta.content) sample.output = (sample.output + delta.content).slice(0, 4000);
      if (delta.reasoning) reasoning = (reasoning + delta.reasoning).slice(0, 4000);
      if (delta.usage) {
        sample.promptTokens = count(delta.usage.prompt_tokens);
        sample.completionTokens = count(delta.usage.completion_tokens);
        sample.cachedTokens = count(asObject(delta.usage.prompt_tokens_details).cached_tokens);
        if (sample.promptTokens !== null && sample.cachedTokens !== null && sample.cachedTokens > sample.promptTokens) sample.cachedTokens = null;
      }
      if (delta.timings) {
        sample.prefillTokS = nonnegative(delta.timings.prompt_per_second);
        sample.decodeTokS = nonnegative(delta.timings.predicted_per_second);
      }
      if (delta.finishReason) sample.finishReason = delta.finishReason;
      if (delta.error) throw new StrataError('STREAM_ERROR', delta.error);
    }, controller.signal), interrupted]);
    if (cancelled) throw new StrataError('CANCELLED', '测试已取消');
    if (!done) throw new StrataError('STREAM_INCOMPLETE', '服务数据流中断，未收到完成标记');
  } catch (error) {
    sample.state = cancelled ? 'cancelled' : 'failed';
    sample.error = timeout ? `本轮超过 ${options.timeoutMs / 1000} 秒，已取消请求` : normalizeError(error).message;
  } finally {
    active = false; sample.wallMs = Math.max(0, now() - began);
    if (!sample.output && reasoning) sample.output = `[推理输出]\n${reasoning}`;
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
  }
}

/** Serial, read-only inference benchmark. Never starts, loads or reconfigures a service. */
export async function runBenchmark(profile: ServiceProfile, input: BenchmarkOptions, onSample: (sample: BenchmarkSample) => void, signal?: AbortSignal): Promise<BenchmarkReport> {
  const options = { ...input };
  validateOptions(options);
  if (signal?.aborted) throw new StrataError('CANCELLED', '测试已取消');
  const baseUrl = normalizeBaseUrl(profile.baseUrl), release = acquireBenchmarkEndpoint(baseUrl);
  try {
    if (isDesktop()) {
      const process = await bounded(serviceStatus(profile.id, profile), options.timeoutMs, signal);
      if (process.running !== true) throw new StrataError('BENCHMARK_SERVICE_STOPPED', '服务未启动，请先在服务管理中启动');
    }
    const health = await bounded(request(profile, '/health'), options.timeoutMs, signal);
    const model = verifyHealth(health);
    const context = count(health.max_context);
    if (context !== null && options.maxTokens + 8 > context) throw new StrataError('INVALID_BENCHMARK_OPTIONS', '输出 token 上限需要在当前模型上下文内保留至少 8 token 余量');
    const metrics: JsonObject = await bounded(request(profile, '/metrics'), Math.min(options.timeoutMs, 5000), signal).catch((error): JsonObject => {
      if (signal?.aborted) throw error;
      return {};
    });
    const live = asObject(metrics.live);
    // The serial engine publishes state/queued without running; parallel engines
    // additionally publish waiting/admitting and in-flight requests outside slots.
    const busy = live.state === 'reading' || live.state === 'generating'
      || ['running', 'queued', 'waiting', 'admitting', 'outside_slots'].some(key => (count(live[key]) ?? 0) > 0)
      || (count(asObject(metrics.activity).in_flight) ?? 0) > 0;
    if (busy) throw new StrataError('BENCHMARK_SERVICE_BUSY', '服务仍有推理或排队请求，请空闲后再测试');
    const report: BenchmarkReport = { id: crypto.randomUUID(), profileId: profile.id, profileName: profile.name, baseUrl, model,
      startedAt: Date.now(), finishedAt: 0, options, samples: [], state: 'completed',
      ...(Object.keys(asObject(metrics.hardware)).length ? { hardware: asObject(metrics.hardware) } : {}),
      ...(Object.keys(asObject(metrics.engine)).length ? { engine: asObject(metrics.engine) } : {}),
    };
    const planned = options.rounds + (options.warmup ? 1 : 0);
    for (let i = 0; i < planned; i++) {
      const warmup = options.warmup && i === 0, index = warmup ? 0 : i + (options.warmup ? 0 : 1);
      const sample = emptySample(index, warmup, model);
      try {
        if (signal?.aborted) throw new StrataError('CANCELLED', '测试已取消');
        if (i > 0) verifyHealth(await bounded(request(profile, '/health'), options.timeoutMs, signal), model);
        sample.startedAt = Date.now();
        await runSample(profile, options, report.id, sample, signal);
      } catch (error) {
        sample.state = signal?.aborted ? 'cancelled' : 'failed'; sample.error = normalizeError(error).message;
      }
      report.samples.push(sample);
      onSample({ ...sample });
      if (sample.state !== 'completed') { report.state = sample.state; break; }
    }
    report.finishedAt = Date.now();
    return report;
  } finally { release(); }
}

export interface BenchmarkDistribution { mean: number | null; p50: number | null; p95: number | null }
export interface BenchmarkSummary {
  completed: number;
  failed: number;
  cancelled: number;
  ttftMs: BenchmarkDistribution;
  wallMs: BenchmarkDistribution;
  prefillTokS: number | null;
  decodeTokS: number | null;
  /** Mean of known per-request cached-token shares; missing counters are excluded. */
  cacheHitRate: number | null;
}

const mean = (values: number[]): number | null => values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
const known = (values: (number | null)[]): number[] => values.flatMap(value => value !== null && Number.isFinite(value) && value >= 0 ? [value] : []);
function distribution(values: number[]): BenchmarkDistribution {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (q: number): number | null => {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * q, low = Math.floor(position), high = Math.ceil(position);
    return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
  };
  return { mean: mean(sorted), p50: percentile(0.5), p95: percentile(0.95) };
}

/** Only completed measured rounds contribute; the optional warmup is always excluded. */
export function summarizeBenchmark(report: BenchmarkReport): BenchmarkSummary {
  const measured = report.samples.filter(sample => !sample.warmup), completed = measured.filter(sample => sample.state === 'completed');
  return { completed: completed.length, failed: measured.filter(sample => sample.state === 'failed').length,
    cancelled: measured.filter(sample => sample.state === 'cancelled').length,
    ttftMs: distribution(known(completed.map(sample => sample.ttftMs))), wallMs: distribution(known(completed.map(sample => sample.wallMs))),
    prefillTokS: mean(known(completed.map(sample => sample.prefillTokS))), decodeTokS: mean(known(completed.map(sample => sample.decodeTokS))),
    cacheHitRate: mean(completed.flatMap(sample => sample.promptTokens !== null && sample.promptTokens > 0 && sample.cachedTokens !== null && sample.cachedTokens <= sample.promptTokens ? [sample.cachedTokens / sample.promptTokens] : [])),
  };
}
