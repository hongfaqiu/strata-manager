import { isDesktop, normalizeBaseUrl, request, serviceStatus, streamChat, benchmarkIdentity } from './bridge';
import { acquireBenchmarkEndpoint, type BenchmarkReport } from './benchmark';
import { compareBenchmarkReports, benchmarkComparisonMetrics, validBenchmarkIdentity, type BenchmarkComparison } from './benchmark-comparison';
import type { BenchmarkTelemetry } from './benchmark-suite-types';
import { asObject, normalizeError, StrataError } from './errors';
import { normalizeMetrics } from './metrics';
import type { JsonObject, ServiceProfile } from './types';
import type { ContextBenchmarkOptions, ContextBenchmarkProgress, ContextBenchmarkReport, ContextBenchmarkSample, ContextBenchmarkSkippedTier } from './context-benchmark-types';

export const CONTEXT_BENCHMARK_TIERS = [8, 32, 64, 128, 256, 384, 512, 768, 1024].map(k => k * 1024);
export const CONTEXT_BENCHMARK_HEADROOM = 64;
const MAX_CONTEXT_TOKENS = 2_147_483_647;
const MAX_RECORD_LINES = 100_000;
/** Default selections follow the model's actual capacity, including nonstandard maxima. */
export function getContextBenchmarkTiers(maxContext: number | null): number[] {
  if (maxContext === null || !Number.isSafeInteger(maxContext) || maxContext <= 0 || maxContext > MAX_CONTEXT_TOKENS) return [];
  return [...new Set([...CONTEXT_BENCHMARK_TIERS.filter(tier => tier <= maxContext), maxContext])].sort((a, b) => a - b);
}
export const DEFAULT_CONTEXT_BENCHMARK_OPTIONS: ContextBenchmarkOptions = {
  tiers: [], maxTokens: 512, timeoutMs: 600_000, rounds: 1, stopOnError: true,
};
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const clock = () => performance.now();

export function validateContextBenchmarkOptions(options: ContextBenchmarkOptions): void {
  const invalid = (message: string) => { throw new StrataError('INVALID_BENCHMARK_OPTIONS', message); };
  if (!options || !Array.isArray(options.tiers) || !options.tiers.length || options.tiers.some(tier => !Number.isSafeInteger(tier) || tier <= 0 || tier > MAX_CONTEXT_TOKENS) || new Set(options.tiers).size !== options.tiers.length) invalid('请选择至少一个有效且不重复的上下文档位');
  for (const [value, min, max, label] of [[options.rounds, 1, 10, '重复次数'], [options.maxTokens, 16, 4096, '输出 token 上限'], [options.timeoutMs, 1000, 600_000, '请求超时（毫秒）']] as const) {
    if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${label}必须是 ${min}–${max} 的整数`);
  }
  if (typeof options.stopOnError !== 'boolean') invalid('遇错停止必须是布尔值');
  if (options.configurationLabel !== undefined && (typeof options.configurationLabel !== 'string' || options.configurationLabel.length > 120)) invalid('测试配置名称最多为 120 个字符');
}

/** A tier denotes total capacity; the prompt always reserves output and template slack. */
export function planContextBenchmarkTiers(tiers: number[], maxContext: number | null, maxTokens: number): { supported: number[]; skipped: ContextBenchmarkSkippedTier[] } {
  const supported: number[] = [], skipped: ContextBenchmarkSkippedTier[] = [];
  for (const tier of [...tiers].sort((a, b) => a - b)) {
    const reason = maxContext === null || !Number.isSafeInteger(maxContext) || maxContext <= 0 || maxContext > MAX_CONTEXT_TOKENS ? '服务未报告有效 max_context，无法核验安全的输入与输出预算'
      : tier > maxContext ? `档位 ${tier} token 超过服务 max_context ${maxContext} token`
      : tier <= maxTokens + CONTEXT_BENCHMARK_HEADROOM ? '此档位无法为输出与模板保留足够余量' : null;
    if (reason) skipped.push({ targetTokens: tier, reason }); else supported.push(tier);
  }
  return { supported, skipped };
}

async function bounded<T>(work: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new StrataError('CANCELLED', '测试已取消'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => reject(new StrataError('BENCHMARK_TIMEOUT', '测试请求超时，已停止后续请求')), timeoutMs);
  });
  try { return await Promise.race([work, interrupted]); }
  finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
}

function healthModel(health: JsonObject, expected?: string): string {
  if (health.service !== 'strata' || health.status !== 'ok') throw new StrataError('BENCHMARK_SERVICE_UNAVAILABLE', 'Strata 服务未就绪，已停止测试');
  if (health.loaded !== true) throw new StrataError('BENCHMARK_MODEL_UNLOADED', '模型尚未加载，已停止测试');
  if (typeof health.model !== 'string' || !health.model.trim()) throw new StrataError('BENCHMARK_MODEL_UNKNOWN', '服务未报告可核验的模型名称');
  if (expected && health.model !== expected) throw new StrataError('BENCHMARK_MODEL_CHANGED', '测试期间模型发生变化，已停止测试');
  return health.model;
}

function isBusy(metrics: JsonObject): boolean {
  const live = asObject(metrics.live);
  return ['reading', 'generating'].includes(String(live.state)) || ['running', 'queued', 'waiting', 'admitting', 'outside_slots'].some(key => (count(live[key]) ?? 0) > 0)
    || (count(asObject(metrics.activity).in_flight) ?? 0) > 0;
}

const RECORD = 'record alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron value complete.\n';
const ESTIMATED_RECORD_TOKENS = 28;
function messagesFor(lines: number, nonce: string): JsonObject[] {
  // The first user tokens differ for every request. This does not clear the engine
  // cache or establish a cold-start/cache-miss claim; returned cached_tokens do.
  const prompt = `${nonce}\nSynthetic records follow. Read all records, then write a detailed explanation of how to validate and summarize them. Continue until the output allowance is reached.\n`
    + RECORD.repeat(lines) + '\nSummarize the records in a detailed answer without repeating the input.';
  return [{ role: 'user', content: prompt }];
}

const sampling = { temperature: 0, reasoning_effort: 'none', enable_thinking: false, thinking: { type: 'disabled' }, reasoning_budget_tokens: 0 };
async function prepareMessages(profile: ServiceProfile, options: ContextBenchmarkOptions, sample: ContextBenchmarkSample, nonce: string, signal: AbortSignal): Promise<JsonObject[]> {
  let lines = Math.max(1, Math.min(MAX_RECORD_LINES, Math.floor((sample.targetPromptTokens - 128) / ESTIMATED_RECORD_TOKENS)));
  let candidate: { messages: JsonObject[]; tokens: number } | undefined;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (signal.aborted) throw new StrataError('CANCELLED', '测试已取消');
    const messages = messagesFor(lines, nonce);
    let tokens: number;
    try {
      const result = await bounded(request(profile, '/v1/messages/count_tokens', 'POST', { model: sample.model, messages, max_tokens: options.maxTokens, ...sampling }), Math.min(options.timeoutMs, 30_000), signal);
      const measured = count(result.input_tokens);
      if (measured === null || measured === 0) throw new StrataError('BENCHMARK_TOKEN_COUNT_UNAVAILABLE', '服务未返回有效的 input_tokens');
      tokens = measured;
    } catch (error) {
      const normalized = normalizeError(error);
      if (signal.aborted || normalized.code === 'BENCHMARK_TIMEOUT' || normalized.code === 'CANCELLED') throw error;
      // Only absence of the metadata endpoint permits estimation. Authentication,
      // busy and runtime errors must not silently trigger a generation request.
      const unavailable = normalized.code === 'BENCHMARK_TOKEN_COUNT_UNAVAILABLE' || normalized.code === 'INVALID_API_PATH'
        || normalized.status === 404 || normalized.status === 405 || /不支持的 Strata API 路径|not supported|route rejected/i.test(normalized.message);
      if (!unavailable) throw error;
      if (candidate) {
        sample.tokenCountMethod = 'count_tokens'; sample.countedPromptTokens = candidate.tokens;
        sample.calibrationReason = '分词端点随后不可用，采用先前已核验且保留输出余量的输入';
        sample.inputChars = String(candidate.messages[0]!.content).length; return candidate.messages;
      }
      // The fallback is deliberately smaller; its estimate is explicitly exposed.
      lines = Math.max(1, Math.floor(lines * 0.9));
      const estimated = messagesFor(lines, nonce);
      sample.tokenCountMethod = 'estimated'; sample.estimatedPromptTokens = lines * ESTIMATED_RECORD_TOKENS + 128;
      sample.calibrationReason = `分词计数不可用：${normalized.message}；按合成记录估算，实际输入以 usage 为准`;
      sample.inputChars = String(estimated[0]!.content).length; return estimated;
    }
    if (tokens <= sample.targetPromptTokens && (!candidate || tokens > candidate.tokens)) candidate = { messages, tokens };
    if (tokens <= sample.targetPromptTokens && tokens >= sample.targetPromptTokens * 0.99) break;
    const next = Math.max(1, Math.min(MAX_RECORD_LINES, Math.floor(lines * sample.targetPromptTokens / tokens * 0.995)));
    if (next === lines) break;
    lines = next;
  }
  if (!candidate) throw new StrataError('BENCHMARK_CONTEXT_OVERFLOW', '分词后的输入超过档位预算，已保留输出余量并停止请求');
  sample.tokenCountMethod = 'count_tokens'; sample.countedPromptTokens = candidate.tokens;
  sample.inputChars = String(candidate.messages[0]!.content).length;
  if (candidate.tokens < sample.targetPromptTokens * 0.99) sample.calibrationReason = '有限次校准未达到目标输入量，已采用预算内的实际分词结果';
  return candidate.messages;
}

function applyResources(sample: ContextBenchmarkSample, raw: JsonObject): void {
  const metrics = normalizeMetrics(raw), hw = asObject(raw.hardware);
  const used = numeric(metrics.gpuMemoryUsed), total = numeric(metrics.gpuMemoryTotal), ram = numeric(metrics.ramUsed);
  const directFree = numeric(hw.gpu_mem_free);
  const free = directFree ?? (used !== null && total !== null && total >= used ? total - used : null);
  const peak = (old: number | null, value: number | null) => value === null ? old : old === null ? value : Math.max(old, value);
  sample.peakGpuMemory = peak(sample.peakGpuMemory, used); sample.peakRam = peak(sample.peakRam, ram);
  if (free !== null) sample.minGpuMemoryFree = sample.minGpuMemoryFree === null ? free : Math.min(sample.minGpuMemoryFree, free);
  if (used !== null || ram !== null || free !== null) sample.resourceSamples++;
}

async function infer(profile: ServiceProfile, options: ContextBenchmarkOptions, messages: JsonObject[], sample: ContextBenchmarkSample, signal: AbortSignal, track: (transport: Promise<void>) => void): Promise<void> {
  const controller = new AbortController();
  let began = clock();
  let active = true, done = false, failure: unknown, monitorPromise: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, interval: ReturnType<typeof setInterval> | undefined;
  let rejectInterrupt: (error: unknown) => void = () => {};
  const abort = () => { controller.abort(); rejectInterrupt(new StrataError('CANCELLED', '测试已取消')); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const capture = async (checkHealth: boolean) => {
    if (controller.signal.aborted || !active) return;
    if (checkHealth) {
      try {
        const health = await bounded(request(profile, '/health'), Math.min(options.timeoutMs, 5000), controller.signal); healthModel(health, sample.model);
        if ((count(health.max_context) ?? 0) < sample.targetTokens) throw new StrataError('BENCHMARK_CONTEXT_CHANGED', '服务上下文容量发生变化，已停止测试');
      }
      catch (error) {
        if (!controller.signal.aborted && active) { failure = error; controller.abort(); rejectInterrupt(error); }
        return;
      }
    }
    try {
      const raw = await bounded(request(profile, '/metrics'), Math.min(options.timeoutMs, 5000), controller.signal);
      if (active && !controller.signal.aborted) applyResources(sample, raw);
    } catch { /* Missing host telemetry remains null; it does not replace request usage/timings. */ }
  };
  sample.startedAt = Date.now();
  try {
    if (signal.aborted) throw new StrataError('CANCELLED', '测试已取消');
    await capture(false);
    if (controller.signal.aborted) throw new StrataError('CANCELLED', '测试已取消');
    began = clock(); sample.startedAt = Date.now();
    const interrupted = new Promise<never>((_, reject) => {
      rejectInterrupt = reject;
      timer = setTimeout(() => { failure = new StrataError('BENCHMARK_TIMEOUT', '本次请求超过超时上限，已停止后续请求'); controller.abort(); reject(failure); }, options.timeoutMs);
    });
    interval = setInterval(() => { if (!monitorPromise) monitorPromise = capture(true).finally(() => { monitorPromise = undefined; }); }, 1000);
    const transport = streamChat(profile, { model: sample.model, messages, stream: true, stream_options: { include_usage: true }, max_tokens: options.maxTokens, ...sampling }, delta => {
      if (!active) return;
      if (delta.done) done = true;
      if (sample.ttftMs === null && (delta.content?.length || delta.reasoning?.length)) sample.ttftMs = Math.max(0, clock() - began);
      if (sample.firstVisibleMs == null && delta.content?.trim().length) sample.firstVisibleMs = Math.max(0, clock() - began);
      if (delta.content) sample.output = (sample.output + delta.content).slice(0, 2000);
      if (delta.usage) {
        const prompt = count(delta.usage.prompt_tokens), completion = count(delta.usage.completion_tokens), cached = count(asObject(delta.usage.prompt_tokens_details).cached_tokens);
        if (prompt !== null) sample.promptTokens = prompt;
        if (completion !== null) sample.completionTokens = completion;
        if (cached !== null) sample.cachedTokens = cached;
        if (sample.promptTokens !== null && sample.cachedTokens !== null && sample.cachedTokens > sample.promptTokens) sample.cachedTokens = null;
      }
      if (delta.timings) { sample.prefillTokS = numeric(delta.timings.prompt_per_second); sample.decodeTokS = numeric(delta.timings.predicted_per_second); }
      if (delta.finishReason) sample.finishReason = delta.finishReason;
      if (delta.error) throw new StrataError('STREAM_ERROR', delta.error);
    }, controller.signal);
    track(transport);
    await Promise.race([transport, interrupted]);
    if (signal.aborted) throw new StrataError('CANCELLED', '测试已取消');
    if (!done) throw new StrataError('STREAM_INCOMPLETE', '服务数据流中断，未收到完成标记');
    if (sample.tokenCountMethod === 'count_tokens' && sample.countedPromptTokens !== null && sample.promptTokens !== null && sample.countedPromptTokens !== sample.promptTokens) {
      sample.calibrationReason = `分词计数 ${sample.countedPromptTokens} 与实际 usage ${sample.promptTokens} 不同，实际输入以 usage 为准`;
    }
  } catch (error) {
    const normalized = normalizeError(failure ?? error);
    sample.state = signal.aborted && !failure ? 'cancelled' : 'failed'; sample.error = normalized.message;
    sample.errorCode = normalized.code; sample.httpStatus = normalized.status;
  } finally {
    active = false; clearTimeout(timer); clearInterval(interval);
    sample.wallMs = Math.max(0, clock() - began);
    // Final telemetry is outside the request wall time, and never retries after a
    // cancellation/timeout. An in-flight sampler must settle before the next row.
    if (monitorPromise) await monitorPromise;
    if (sample.state === 'completed' && !controller.signal.aborted) {
      try { applyResources(sample, await bounded(request(profile, '/metrics'), Math.min(options.timeoutMs, 5000), controller.signal)); } catch { /* Optional final sample. */ }
    }
    signal.removeEventListener('abort', abort);
  }
}

/** Serial, request-local measurements. Never starts, reloads or reconfigures a service. */
export async function runContextBenchmark(profile: ServiceProfile, input: ContextBenchmarkOptions, onProgress: (progress: ContextBenchmarkProgress) => void = () => {}, signal?: AbortSignal): Promise<ContextBenchmarkReport> {
  validateContextBenchmarkOptions(input);
  if (signal?.aborted) throw new StrataError('CANCELLED', '测试已取消');
  const options = { ...input, tiers: [...input.tiers].sort((a, b) => a - b) }, baseUrl = normalizeBaseUrl(profile.baseUrl), release = acquireBenchmarkEndpoint(baseUrl);
  const controller = new AbortController(), transports = new Set<Promise<void>>();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const track = (transport: Promise<void>) => { transports.add(transport); void transport.then(() => transports.delete(transport), () => transports.delete(transport)); };
  const began = clock();
  try {
    if (isDesktop() && (await bounded(serviceStatus(profile.id, profile), options.timeoutMs, controller.signal)).running !== true) throw new StrataError('BENCHMARK_SERVICE_STOPPED', '服务未启动，请先启动并加载模型');
    const health = await bounded(request(profile, '/health'), options.timeoutMs, controller.signal), model = healthModel(health), maxContext = count(health.max_context);
    const raw: JsonObject = await bounded(request(profile, '/metrics'), Math.min(options.timeoutMs, 5000), controller.signal).catch(error => { if (controller.signal.aborted) throw error; return {}; });
    if (isBusy(raw)) throw new StrataError('BENCHMARK_SERVICE_BUSY', '服务仍有推理或排队请求，请空闲后再测试');
    const plan = planContextBenchmarkTiers(options.tiers, maxContext, options.maxTokens);
    const identity = isDesktop() ? await bounded(benchmarkIdentity(profile), Math.min(options.timeoutMs, 5000), controller.signal)
      .catch(error => { if (controller.signal.aborted) throw error; return undefined; }) : undefined;
    const report: ContextBenchmarkReport = { schemaVersion: 3, ...(identity ? { identity } : {}), id: crypto.randomUUID(), profileId: profile.id, profileName: profile.name, baseUrl, model, maxContext,
      startedAt: Date.now(), finishedAt: 0, elapsedMs: 0, options, samples: [], skippedTiers: plan.skipped, state: 'completed', stopReason: 'completed', resourceScope: 'system', resourceIntervalMs: 1000,
      ...(Object.keys(asObject(raw.hardware)).length ? { hardware: asObject(raw.hardware) } : {}), ...(Object.keys(asObject(raw.engine)).length ? { engine: asObject(raw.engine) } : {}) };
    const total = plan.supported.length * options.rounds;
    const emit = (currentTier: number | null, active: 0 | 1, sample?: ContextBenchmarkSample) => onProgress({ currentTier, active, total, elapsedMs: Math.max(0, clock() - began),
      completed: report.samples.filter(s => s.state === 'completed').length, failed: report.samples.filter(s => s.state === 'failed').length, cancelled: report.samples.filter(s => s.state === 'cancelled').length,
      ...(sample ? { sample: { ...sample } } : {}) });
    emit(null, 0);
    outer: for (const tier of plan.supported) for (let round = 1; round <= options.rounds; round++) {
      if (controller.signal.aborted) { report.state = 'cancelled'; report.stopReason = 'cancelled'; break outer; }
      const sample: ContextBenchmarkSample = { index: report.samples.length + 1, round, targetTokens: tier, targetPromptTokens: tier - options.maxTokens - CONTEXT_BENCHMARK_HEADROOM,
        model, state: 'completed', startedAt: Date.now(), ttftMs: null, firstVisibleMs: null, wallMs: 0, inputChars: 0, tokenCountMethod: 'estimated', countedPromptTokens: null, estimatedPromptTokens: null,
        promptTokens: null, completionTokens: null, cachedTokens: null, prefillTokS: null, decodeTokS: null, peakGpuMemory: null, minGpuMemoryFree: null, peakRam: null, resourceSamples: 0, output: '' };
      emit(tier, 1);
      try {
        const current = await bounded(request(profile, '/health'), Math.min(options.timeoutMs, 5000), controller.signal); healthModel(current, model);
        if ((count(current.max_context) ?? 0) < tier) throw new StrataError('BENCHMARK_CONTEXT_CHANGED', '服务上下文容量发生变化，已停止后续请求');
        const messages = await prepareMessages(profile, options, sample, `${crypto.randomUUID()} context-benchmark ${report.id}/${sample.index}`, controller.signal);
        const ready = await bounded(request(profile, '/health'), Math.min(options.timeoutMs, 5000), controller.signal); healthModel(ready, model);
        if ((count(ready.max_context) ?? 0) < tier) throw new StrataError('BENCHMARK_CONTEXT_CHANGED', '服务上下文容量发生变化，已停止后续请求');
        await infer(profile, options, messages, sample, controller.signal, track);
      } catch (error) {
        const normalized = normalizeError(error); sample.state = controller.signal.aborted ? 'cancelled' : 'failed';
        sample.error = normalized.message; sample.errorCode = normalized.code; sample.httpStatus = normalized.status;
      }
      report.samples.push(sample); emit(tier, 0, sample);
      if (sample.state === 'cancelled') { report.state = 'cancelled'; report.stopReason = 'cancelled'; break outer; }
      if (sample.state === 'failed') {
        report.state = 'failed'; report.stopReason = sample.errorCode === 'BENCHMARK_MODEL_CHANGED' ? 'modelChanged' : 'error';
        if (options.stopOnError || !['HTTP_ERROR', 'STREAM_ERROR', 'STREAM_INCOMPLETE'].includes(sample.errorCode ?? '')) break outer;
      }
    }
    if (controller.signal.aborted && report.state === 'completed') { report.state = 'cancelled'; report.stopReason = 'cancelled'; }
    report.finishedAt = Date.now(); report.elapsedMs = Math.max(0, clock() - began); emit(null, 0);
    return report;
  } finally {
    signal?.removeEventListener('abort', cancel);
    // Native cancellation can settle after the caller receives its report. Keep
    // the shared endpoint gate until actual generation transports finish.
    if (transports.size) void Promise.allSettled([...transports]).then(release); else release();
  }
}

/** Convert one context tier to the shared comparison contract; do not duplicate its eligibility rules. */
export function contextBenchmarkComparisonAdapter(report: ContextBenchmarkReport, tier: number): BenchmarkReport & { telemetry: BenchmarkTelemetry[] } {
  const samples = report.samples.filter(sample => sample.targetTokens === tier);
  const identity = report.identity;
  const validIdentity = validBenchmarkIdentity(identity);
  return { id: report.id, profileId: report.profileId, profileName: report.profileName, baseUrl: report.baseUrl, model: report.model,
    startedAt: report.startedAt, finishedAt: report.finishedAt, state: samples.length ? report.state : 'failed',
    ...(validIdentity ? { identity } : {}), ...(report.hardware ? { hardware: report.hardware } : {}), ...(report.engine ? { engine: report.engine } : {}),
    options: { prompt: JSON.stringify({ protocol: 'context-tier-v1', targetTokens: tier, maxContext: report.maxContext,
      resourceScope: report.resourceScope, resourceIntervalMs: report.resourceIntervalMs, sampling,
      input: samples.map(sample => ({ targetPromptTokens: sample.targetPromptTokens, tokenCountMethod: sample.tokenCountMethod,
        promptTokens: sample.promptTokens, cachedTokens: sample.cachedTokens })) }),
      rounds: report.options.rounds, maxTokens: report.options.maxTokens, timeoutMs: report.options.timeoutMs, warmup: false, mode: 'unique' },
    samples: samples.map(sample => ({ ...sample, warmup: false, firstVisibleMs: sample.firstVisibleMs ?? null })),
    telemetry: samples.map(sample => ({ at: sample.startedAt, elapsedMs: Math.max(0, sample.startedAt - report.startedAt), active: 1,
      queued: null, running: null, cpuUtil: null, gpuUtil: null, gpuTemperature: null, ramUsed: sample.peakRam, gpuMemoryUsed: sample.peakGpuMemory })),
  };
}

export interface ContextBenchmarkComparisonRow {
  tier: number;
  comparison: BenchmarkComparison;
  left: ReturnType<typeof benchmarkComparisonMetrics>;
  right: ReturnType<typeof benchmarkComparisonMetrics>;
  leftSamples: number;
  rightSamples: number;
}

export function compareContextBenchmarkReports(left: ContextBenchmarkReport, right: ContextBenchmarkReport): ContextBenchmarkComparisonRow[] {
  const tiers = [...new Set([...left.samples.map(sample => sample.targetTokens), ...right.samples.map(sample => sample.targetTokens)])].sort((a, b) => a - b);
  return tiers.map(tier => {
    const a = contextBenchmarkComparisonAdapter(left, tier), b = contextBenchmarkComparisonAdapter(right, tier);
    return { tier, comparison: compareBenchmarkReports(a, b), left: benchmarkComparisonMetrics(a), right: benchmarkComparisonMetrics(b),
      leftSamples: a.samples.filter(sample => sample.state === 'completed').length, rightSamples: b.samples.filter(sample => sample.state === 'completed').length };
  });
}
