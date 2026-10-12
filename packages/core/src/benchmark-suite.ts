import { isDesktop, normalizeBaseUrl, request, serviceStatus, streamChat } from './bridge';
import { acquireBenchmarkEndpoint, BENCHMARK_PROMPTS } from './benchmark';
import { asObject, normalizeError, StrataError } from './errors';
import { normalizeMetrics } from './metrics';
import type { JsonObject, ServiceProfile } from './types';
import type { BenchmarkScenarioId, BenchmarkSuiteOptions, BenchmarkSuiteProgress, BenchmarkSuiteReport, BenchmarkSuiteSample, BenchmarkSuiteSummary, BenchmarkSuiteDistribution, BenchmarkTelemetry } from './benchmark-suite-types';

export const BENCHMARK_SCENARIOS: { id: BenchmarkScenarioId; nameZh: string; nameEn: string; descriptionZh: string; descriptionEn: string }[] = [
  { id: 'short', nameZh: '短问答', nameEn: 'Short answer', descriptionZh: '短中文问题，测量首输出与完整请求延迟。', descriptionEn: 'A short Chinese question for first output and request latency.' },
  { id: 'code', nameZh: '代码审查', nameEn: 'Code review', descriptionZh: '审查 TypeScript 并发队列，包含中文分析与代码。', descriptionEn: 'Review a TypeScript queue with Chinese analysis and code.' },
  { id: 'long', nameZh: '长输入', nameEn: 'Long input', descriptionZh: '按字符构建代码与中文材料，实际 token 数以服务为准。', descriptionEn: 'Build code and Chinese material by characters; the service reports actual tokens.' },
  { id: 'decode', nameZh: '持续生成', nameEn: 'Sustained generation', descriptionZh: '要求较长输出，观察生成速度与长度限制。', descriptionEn: 'Request a long response to observe generation throughput and length limits.' },
  { id: 'cache', nameZh: '重复输入缓存', nameEn: 'Repeated input cache', descriptionZh: '重复完全相同的提示词，不重启或清除服务缓存。', descriptionEn: 'Repeat identical prompts without restarting or clearing engine caches.' },
  { id: 'conversation', nameZh: '多轮对话', nameEn: 'Conversation', descriptionZh: '后续轮次携带完整先前消息与回答，测试真实上下文增长。', descriptionEn: 'Carry full previous messages and answers into each subsequent turn.' },
  { id: 'custom', nameZh: '自定义', nameEn: 'Custom', descriptionZh: '使用自定义提示词进行测量。', descriptionEn: 'Measure a custom prompt.' },
];

export const DEFAULT_BENCHMARK_SUITE_OPTIONS: BenchmarkSuiteOptions = {
  kind: 'suite', scenarios: ['short', 'code', 'long', 'decode', 'cache', 'conversation'], prompt: BENCHMARK_PROMPTS.mixed,
  rounds: 2, maxTokens: 256, inputChars: 8192, conversationTurns: 3, warmup: false, mode: 'unique', timeoutMs: 120_000,
  concurrency: 1, stressPattern: 'steady', stressLimit: 'duration', requestLimit: 300, durationMs: 300_000,
  stageDurationMs: 60_000, requestDelayMs: 0, stopOnError: false,
};
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const numeric = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const clock = () => performance.now();

export function validateBenchmarkSuiteOptions(options: BenchmarkSuiteOptions): void {
  const invalid = (message: string) => { throw new StrataError('INVALID_BENCHMARK_OPTIONS', message); };
  if (!options || !['suite', 'stress'].includes(options.kind)) invalid('请选择场景套件或压力测试');
  const allowed = BENCHMARK_SCENARIOS.map(s => s.id);
  if (!Array.isArray(options.scenarios) || !options.scenarios.length || options.scenarios.some(s => !allowed.includes(s)) || new Set(options.scenarios).size !== options.scenarios.length) invalid('请选择至少一个场景，且场景不能重复');
  if (typeof options.prompt !== 'string' || options.prompt.length > 131_072 || (options.scenarios.includes('custom') && !options.prompt.trim())) invalid('自定义提示词不能为空，且最多 131,072 个字符');
  const bounds: [number, number, number, string][] = [
    [options.rounds, 1, 20, '场景重复次数'], [options.maxTokens, 16, 4096, '输出 token 上限'], [options.inputChars, 1024, 131_072, '输入字符数'],
    [options.conversationTurns, 2, 10, '对话轮数'], [options.timeoutMs, 1000, 600_000, '请求超时（毫秒）'], [options.concurrency, 1, 32, 'HTTP 并发数'],
    [options.requestLimit, 1, 5000, '总请求预算'], [options.durationMs, 10_000, 3_600_000, '测试时限（毫秒）'], [options.stageDurationMs, 5000, 600_000, '阶段时长（毫秒）'],
    [options.requestDelayMs, 0, 30_000, '请求间隔（毫秒）'],
  ];
  for (const [value, min, max, label] of bounds) if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${label}必须是 ${min}–${max} 的整数`);
  if (!['unique', 'repeat'].includes(options.mode) || !['steady', 'ramp'].includes(options.stressPattern) || !['requests', 'duration'].includes(options.stressLimit)) invalid('测试模式参数无效');
  if (typeof options.warmup !== 'boolean' || typeof options.stopOnError !== 'boolean') invalid('预热和遇错停止必须是布尔值');
}

export function estimateBenchmarkSuiteRequests(options: BenchmarkSuiteOptions): number {
  validateBenchmarkSuiteOptions(options);
  return options.kind === 'stress' ? options.requestLimit : options.rounds * options.scenarios.reduce((n, s) => n + (s === 'conversation' ? options.conversationTurns : 1), 0);
}

async function bounded<T>(work: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new StrataError('CANCELLED', '测试已取消'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => reject(new StrataError('BENCHMARK_TIMEOUT', '状态核验超时')), timeoutMs);
  });
  try { return await Promise.race([work, cancelled]); }
  finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
}

function healthModel(health: JsonObject, expected?: string): string {
  if (health.service !== 'strata' || health.status !== 'ok') throw new StrataError('BENCHMARK_SERVICE_UNAVAILABLE', '服务未就绪，已停止测试');
  if (health.loaded !== true) throw new StrataError('BENCHMARK_MODEL_UNLOADED', '模型尚未加载，已停止测试');
  if (typeof health.model !== 'string' || !health.model.trim()) throw new StrataError('BENCHMARK_MODEL_UNKNOWN', '无法核验加载模型');
  if (expected && health.model !== expected) throw new StrataError('BENCHMARK_MODEL_CHANGED', '测试期间模型发生变化，已停止测试');
  return health.model;
}

function isBusy(metrics: JsonObject): boolean {
  const live = asObject(metrics.live);
  return live.state === 'reading' || live.state === 'generating'
    || ['running', 'queued', 'waiting', 'admitting', 'outside_slots'].some(k => (count(live[k]) ?? 0) > 0)
    || (count(asObject(metrics.activity).in_flight) ?? 0) > 0;
}

function promptFor(scenario: BenchmarkScenarioId, options: BenchmarkSuiteOptions): string {
  if (scenario === 'short') return BENCHMARK_PROMPTS.short;
  if (scenario === 'code' || scenario === 'cache') return BENCHMARK_PROMPTS.mixed;
  if (scenario === 'custom') return options.prompt;
  if (scenario === 'decode') return '请持续撰写详细的 TypeScript 异步编程教程，逐节解释 Promise、取消、超时、并发、缓存、错误恢复，并给出完整代码和中文说明。不要过早总结，尽量写满允许的输出长度。';
  if (scenario === 'conversation') return '我们一起设计一个可靠的 TypeScript 任务队列。请先给出并发限制、任务取消与异常处理的基本设计和代码。后续我会继续添加要求。';
  const header = '以下是项目材料，请阅读后用中文指出并发与缓存风险，给出简洁修复方案。\n';
  const footer = '\n请综合材料回答，不要复述所有输入。';
  const block = 'interface Job { id: string; state: "queued" | "running"; }\nconst tasks = new Map<string, Job>();\n// 并发槽位必须在 finally 释放；缓存键需包含输入内容，失败应保留可重试状态。\n';
  const size = options.inputChars - header.length - footer.length;
  return header + block.repeat(Math.ceil(size / block.length)).slice(0, size) + footer;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (!ms || signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(abort, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function infer(profile: ServiceProfile, messages: JsonObject[], options: BenchmarkSuiteOptions, sample: BenchmarkSuiteSample, signal: AbortSignal, track: (transport: Promise<void>) => void): Promise<{ content: string; reasoning: string }> {
  const controller = new AbortController(), began = clock();
  let content = '', reasoning = '', done = false, active = true, timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectInterrupt: (error: unknown) => void = () => {};
  const abort = () => { controller.abort(); rejectInterrupt(new StrataError('CANCELLED', '测试请求已取消')); };
  const interrupted = new Promise<never>((_, reject) => {
    rejectInterrupt = reject;
    timer = setTimeout(() => {
      timedOut = true; controller.abort(); reject(new StrataError('BENCHMARK_TIMEOUT', '本次请求超过超时上限，已取消'));
    }, options.timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  sample.startedAt = Date.now();
  try {
    if (signal.aborted) throw new StrataError('CANCELLED', '测试请求已取消');
    const transport = streamChat(profile, { model: sample.model, messages, stream: true, stream_options: { include_usage: true }, max_tokens: options.maxTokens, temperature: 0, seed: 42 }, delta => {
      if (!active) return;
      if (delta.done) done = true;
      if (sample.ttftMs === null && (delta.content?.length || delta.reasoning?.length)) sample.ttftMs = Math.max(0, clock() - began);
      if (delta.content) content += delta.content;
      if (delta.reasoning) reasoning += delta.reasoning;
      if (delta.usage) {
        sample.promptTokens = count(delta.usage.prompt_tokens); sample.completionTokens = count(delta.usage.completion_tokens);
        sample.cachedTokens = count(asObject(delta.usage.prompt_tokens_details).cached_tokens);
        if (sample.promptTokens !== null && sample.cachedTokens !== null && sample.cachedTokens > sample.promptTokens) sample.cachedTokens = null;
      }
      if (delta.timings) { sample.prefillTokS = numeric(delta.timings.prompt_per_second); sample.decodeTokS = numeric(delta.timings.predicted_per_second); }
      if (delta.finishReason) sample.finishReason = delta.finishReason;
      if (delta.error) throw new StrataError('STREAM_ERROR', delta.error);
    }, controller.signal);
    track(transport);
    await Promise.race([transport, interrupted]);
    if (signal.aborted) throw new StrataError('CANCELLED', '测试请求已取消');
    if (!done) throw new StrataError('STREAM_INCOMPLETE', '服务数据流中断，未收到完成标记');
  } catch (error) {
    const normalized = timedOut ? new StrataError('BENCHMARK_TIMEOUT', '本次请求超过超时上限，已取消') : normalizeError(error);
    sample.state = signal.aborted && !timedOut ? 'cancelled' : 'failed'; sample.error = normalized.message;
    sample.errorCode = normalized.code; sample.httpStatus = normalized.status;
  } finally {
    active = false; clearTimeout(timer); signal.removeEventListener('abort', abort);
    sample.wallMs = Math.max(0, clock() - began); sample.output = (content || (reasoning ? `[推理输出]\n${reasoning}` : '')).slice(0, 512);
  }
  return { content, reasoning };
}

export async function runBenchmarkSuite(profile: ServiceProfile, input: BenchmarkSuiteOptions, onProgress: (progress: BenchmarkSuiteProgress) => void, signal?: AbortSignal): Promise<BenchmarkSuiteReport> {
  validateBenchmarkSuiteOptions(input);
  const options = { ...input, scenarios: [...input.scenarios] };
  const requestBudget = options.kind === 'stress' ? options.requestLimit : estimateBenchmarkSuiteRequests(options);
  if (signal?.aborted) throw new StrataError('CANCELLED', '测试已取消');
  const baseUrl = normalizeBaseUrl(profile.baseUrl), release = acquireBenchmarkEndpoint(baseUrl);
  const controller = new AbortController();
  const transports = new Set<Promise<void>>();
  const track = (transport: Promise<void>) => {
    transports.add(transport);
    void transport.then(() => transports.delete(transport), () => transports.delete(transport));
  };
  let report: BenchmarkSuiteReport | undefined, active = 0, issued = 0, flowId = 0, measuredStart = 0, stageIndex = 0, concurrency = 1;
  let interval: ReturnType<typeof setInterval> | undefined, deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let monitorPromise: Promise<void> | undefined, disposed = false;
  const levels = options.kind === 'suite' ? [1] : options.stressPattern === 'steady' ? [options.concurrency] : (() => {
    const values = [1]; while (values.at(-1)! < options.concurrency) values.push(Math.min(options.concurrency, values.at(-1)! * 2)); return values;
  })();
  const stop = (reason: BenchmarkSuiteReport['stopReason']) => {
    if (!report || controller.signal.aborted) return;
    report.stopReason = reason; report.state = reason === 'cancelled' ? 'cancelled' : reason === 'duration' ? 'completed' : 'failed'; controller.abort();
  };
  const cancel = () => { if (report) stop('cancelled'); else controller.abort(); };
  signal?.addEventListener('abort', cancel, { once: true });
  let began = clock();
  const emit = (sample?: BenchmarkSuiteSample, telemetry?: BenchmarkTelemetry) => {
    if (!report || disposed) return;
    const measured = report.samples.filter(s => !s.warmup);
    onProgress({ stageIndex, totalStages: levels.length, concurrency, issued, active,
      completed: measured.filter(s => s.state === 'completed').length, failed: measured.filter(s => s.state === 'failed').length,
      cancelled: measured.filter(s => s.state === 'cancelled').length, elapsedMs: Math.max(0, clock() - began),
      ...(sample ? { sample: { ...sample } } : {}), ...(telemetry ? { telemetry } : {}) });
  };
  const check = async () => {
    if (controller.signal.aborted) return;
    try { healthModel(await bounded(request(profile, '/health'), Math.min(options.timeoutMs, 5000), controller.signal), report?.model); }
    catch (error) { if (!controller.signal.aborted) stop(normalizeError(error).code === 'BENCHMARK_MODEL_CHANGED' ? 'modelChanged' : 'error'); }
  };
  const monitor = async () => {
    await check(); if (controller.signal.aborted || disposed || !report) return;
    try {
      const raw = await bounded(request(profile, '/metrics'), Math.min(options.timeoutMs, 5000), controller.signal);
      if (disposed || controller.signal.aborted) return;
      const m = normalizeMetrics(raw), live = asObject(raw.live);
      const queue = [count(live.waiting), count(live.queued), count(live.admitting)].filter((v): v is number => v !== null);
      const telemetry: BenchmarkTelemetry = { at: Date.now(), elapsedMs: Math.max(0, clock() - began), active,
        queued: queue.length ? Math.max(...queue) : null, running: m.running, cpuUtil: m.cpuUtil, gpuUtil: m.gpuUtil,
        gpuMemoryUsed: m.gpuMemoryUsed, ramUsed: m.ramUsed, gpuTemperature: m.gpuTemperature };
      report.telemetry.push(telemetry); if (report.telemetry.length > 2000) report.telemetry.shift(); emit(undefined, telemetry);
    } catch { /* Unavailable resource telemetry does not invent values or abort healthy inference. */ }
  };
  const runFlow = async (scenario: BenchmarkScenarioId, worker: number, warmup: boolean, stageDeadline: number) => {
    const messages: JsonObject[] = [], conversationId = scenario === 'conversation' ? `${report!.id}/${++flowId}` : null;
    const turns = !warmup && scenario === 'conversation' ? options.conversationTurns : 1;
    for (let turn = 1; turn <= turns; turn++) {
      if (controller.signal.aborted || (!warmup && (issued >= requestBudget || clock() >= stageDeadline))) return;
      if (turn > 1 && options.requestDelayMs) await wait(options.requestDelayMs, controller.signal);
      if (controller.signal.aborted || (!warmup && (issued >= requestBudget || clock() >= stageDeadline))) return;
      let prompt = turn === 1 ? promptFor(scenario, options) : `继续第 ${turn} 轮：请基于前面的完整实现，补充超时、任务取消和失败恢复，给出更新后的代码与测试。`;
      if (turn === 1 && scenario !== 'cache' && options.mode === 'unique') prompt = `[benchmark ${report!.id}/${warmup ? 'warmup' : issued + 1}/${scenario}]\n${prompt}`;
      messages.push({ role: 'user', content: prompt });
      const sample: BenchmarkSuiteSample = { index: warmup ? 0 : ++issued, warmup, model: report!.model, startedAt: Date.now(),
        scenario, stage: warmup ? 0 : stageIndex, concurrency: warmup ? 1 : concurrency, worker, conversationId, turn,
        inputChars: messages.reduce((n, msg) => n + String(msg.content ?? '').length + String(msg.reasoning_content ?? '').length, 0), maxTokens: options.maxTokens,
        state: 'completed', ttftMs: null, wallMs: 0, promptTokens: null, completionTokens: null, cachedTokens: null, prefillTokS: null, decodeTokS: null, output: '' };
      active++; emit();
      const full = await infer(profile, messages.map(msg => ({ ...msg })), options, sample, controller.signal, track);
      active--; report!.samples.push(sample); emit(sample);
      // A timed-out transport may still be settling native cancellation. Stop dispatch
      // instead of allowing unresolved requests to accumulate beyond the client limit.
      if (sample.state === 'failed' && (options.stopOnError || sample.errorCode === 'BENCHMARK_TIMEOUT')) stop('error');
      if (sample.state !== 'completed') return;
      if (scenario === 'conversation') messages.push({ role: 'assistant', content: full.content, ...(full.reasoning ? { reasoning_content: full.reasoning } : {}) });
    }
  };
  try {
    if (isDesktop() && (await bounded(serviceStatus(profile.id, profile), options.timeoutMs, controller.signal)).running !== true) throw new StrataError('BENCHMARK_SERVICE_STOPPED', '服务未启动，请先在服务管理中启动');
    const health = await bounded(request(profile, '/health'), options.timeoutMs, controller.signal), model = healthModel(health);
    if (count(health.max_context) !== null && options.maxTokens + 8 > Number(health.max_context)) throw new StrataError('INVALID_BENCHMARK_OPTIONS', '输出 token 上限需要在当前模型上下文内保留至少 8 token 余量');
    const raw: JsonObject = await bounded(request(profile, '/metrics'), Math.min(options.timeoutMs, 5000), controller.signal).catch(error => { if (controller.signal.aborted) throw error; return {}; });
    if (isBusy(raw)) throw new StrataError('BENCHMARK_SERVICE_BUSY', '服务仍有推理或排队请求，请空闲后再测试');
    began = clock();
    report = { schemaVersion: 2, id: crypto.randomUUID(), profileId: profile.id, profileName: profile.name, baseUrl, model,
      startedAt: Date.now(), finishedAt: 0, elapsedMs: 0, measurementElapsedMs: 0, options, samples: [], stages: [], telemetry: [], state: 'completed', stopReason: 'completed',
      ...(Object.keys(asObject(raw.hardware)).length ? { hardware: asObject(raw.hardware) } : {}), ...(Object.keys(asObject(raw.engine)).length ? { engine: asObject(raw.engine) } : {}) };
    interval = setInterval(() => { if (!monitorPromise) monitorPromise = monitor().finally(() => { monitorPromise = undefined; }); }, 2000);
    if (options.warmup) for (const scenario of options.scenarios) {
      await check(); if (controller.signal.aborted) break;
      await runFlow(scenario, 1, true, Infinity);
    }
    if (!controller.signal.aborted) {
      measuredStart = clock();
      if (options.kind === 'stress') deadlineTimer = setTimeout(() => stop('duration'), options.durationMs);
      const deadline = options.kind === 'stress' ? measuredStart + options.durationMs : Infinity;
      for (let stage = 0; stage < levels.length && !controller.signal.aborted && issued < requestBudget; stage++) {
        stageIndex = stage + 1; concurrency = levels[stage]!;
        await check(); if (controller.signal.aborted) break;
        const stageStart = clock(), final = stage === levels.length - 1;
        const stageDeadline = Math.min(deadline, !final && options.kind === 'stress' ? stageStart + options.stageDurationMs : deadline);
        const entry = { index: stageIndex, concurrency, startedAt: Date.now(), finishedAt: 0, elapsedMs: 0 }; report.stages.push(entry); emit();
        if (options.kind === 'suite') {
          outer: for (let round = 0; round < options.rounds; round++) for (const scenario of options.scenarios) {
            if (controller.signal.aborted || issued >= requestBudget || clock() >= stageDeadline) break outer;
            await check(); if (controller.signal.aborted) break outer;
            if (issued && options.requestDelayMs) await wait(options.requestDelayMs, controller.signal);
            await runFlow(scenario, 1, false, stageDeadline);
          }
        } else {
          let nextScenario = 0;
          await Promise.all(Array.from({ length: concurrency }, (_, worker) => (async () => {
            let first = true;
            while (!controller.signal.aborted && issued < requestBudget && clock() < stageDeadline) {
              if (!first && options.requestDelayMs) await wait(options.requestDelayMs, controller.signal);
              if (controller.signal.aborted || issued >= requestBudget || clock() >= stageDeadline) break;
              first = false; const scenario = options.scenarios[nextScenario++ % options.scenarios.length]!;
              await runFlow(scenario, worker + 1, false, stageDeadline);
            }
          })()));
        }
        entry.finishedAt = Date.now(); entry.elapsedMs = Math.max(0, clock() - stageStart);
        if (!controller.signal.aborted && clock() >= deadline) stop('duration');
      }
      report.measurementElapsedMs = Math.max(0, clock() - measuredStart);
      if (!controller.signal.aborted && options.kind === 'stress' && issued >= requestBudget) report.stopReason = 'requestLimit';
    }
    clearTimeout(deadlineTimer); clearInterval(interval);
    if (monitorPromise) await monitorPromise;
    report.finishedAt = Date.now(); report.elapsedMs = Math.max(0, clock() - began); emit();
    return report;
  } finally {
    disposed = true; clearInterval(interval); clearTimeout(deadlineTimer); signal?.removeEventListener('abort', cancel);
    // Return cancellation promptly, but keep the endpoint gate until real transports
    // settle, including requests still resolving native preparation when aborted.
    if (transports.size) void Promise.allSettled([...transports]).then(release); else release();
  }
}

const mean = (v: number[]): number | null => v.length ? v.reduce((n, x) => n + x, 0) / v.length : null;
const known = (v: (number | null)[]): number[] => v.filter((n): n is number => n !== null && Number.isFinite(n) && n >= 0);
function distribution(values: number[]): BenchmarkSuiteDistribution {
  const sorted = [...values].sort((a, b) => a - b);
  const p = (q: number) => {
    if (!sorted.length) return null;
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
  };
  return { mean: mean(sorted), p50: p(0.5), p95: p(0.95), p99: p(0.99) };
}

export function summarizeBenchmarkSuite(report: BenchmarkSuiteReport, filter?: { scenario?: BenchmarkScenarioId; stage?: number }): BenchmarkSuiteSummary {
  const samples = report.samples.filter(s => !s.warmup && (!filter?.scenario || s.scenario === filter.scenario) && (filter?.stage === undefined || s.stage === filter.stage));
  const completed = samples.filter(s => s.state === 'completed'), failed = samples.filter(s => s.state === 'failed');
  const stages = filter?.stage === undefined ? report.stages : report.stages.filter(s => s.index === filter.stage);
  const windowMs = filter?.stage === undefined ? report.measurementElapsedMs : stages.reduce((n, s) => n + s.elapsedMs, 0);
  const tokens = samples.length && samples.every(s => count(s.completionTokens) !== null) ? samples.reduce((n, s) => n + s.completionTokens!, 0) : null;
  const errors = new Map<string, { code: string; status: number | null; count: number }>();
  for (const sample of failed) {
    const code = sample.errorCode ?? 'UNKNOWN', status = sample.httpStatus ?? null, key = `${code}:${status}`;
    const previous = errors.get(key); if (previous) previous.count++; else errors.set(key, { code, status, count: 1 });
  }
  // Warmup resource observations are excluded just like warmup requests.
  const telemetry = report.telemetry.filter(t => stages.some(s => t.at >= s.startedAt && t.at <= s.finishedAt));
  const peak = (values: (number | null)[]) => { const v = known(values); return v.length ? Math.max(...v) : null; };
  return { completed: completed.length, failed: failed.length, cancelled: samples.filter(s => s.state === 'cancelled').length,
    successRate: samples.length ? completed.length / samples.length : null,
    ttftMs: distribution(known(completed.map(s => s.ttftMs))), wallMs: distribution(known(completed.map(s => s.wallMs))),
    prefillTokS: mean(known(completed.map(s => s.prefillTokS))), decodeTokS: mean(known(completed.map(s => s.decodeTokS))),
    cacheHitRate: mean(completed.flatMap(s => s.promptTokens !== null && s.promptTokens > 0 && s.cachedTokens !== null && s.cachedTokens <= s.promptTokens ? [s.cachedTokens / s.promptTokens] : [])),
    // Throughput uses successful requests and the entire measurement/stage window, including failed work and waits.
    requestsPerSecond: samples.length && windowMs > 0 ? completed.length * 1000 / windowMs : null,
    aggregateOutputTokS: tokens !== null && windowMs > 0 ? tokens * 1000 / windowMs : null, outputTokens: tokens,
    timeoutCount: failed.filter(s => s.errorCode === 'BENCHMARK_TIMEOUT').length, truncatedCount: samples.filter(s => s.finishReason === 'length').length,
    errors: [...errors.values()], peakQueue: peak(telemetry.map(t => t.queued)), peakGpuMemory: peak(telemetry.map(t => t.gpuMemoryUsed)), peakRam: peak(telemetry.map(t => t.ramUsed)) };
}
