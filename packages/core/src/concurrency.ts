import { isOrcaRouterEvidence } from './orca-import';
import type { JsonObject } from './types';
import { TRAINED_CONTEXT } from './context-extension';

/**
 * Several requests at once ("parallel" / --batch N), following upstream docs/BATCHING.md and setup.py
 * parallel_slot_gb / parallel_recommend (Strata 477ac13). Pure functions only: no I/O, no bridge.
 */
export type ConcurrencyUseCase = 'single' | 'agent' | 'multiUser' | 'batch';
export const CONCURRENCY_USE_CASES: readonly ConcurrencyUseCase[] = ['single', 'agent', 'multiUser', 'batch'];
/** Upstream: a batch window holds at most 8 rows; with a layer split, 8 per pipelined group. */
export const CONCURRENCY_ENGINE_MAX = 8;
/** --batch-mtp doubles the rows of a window: at most 4 slots in one window on a layer split. */
export const CONCURRENCY_BATCH_MTP_SPLIT_MAX = 4;
/** Opt-in, off by default upstream (BATCHING.md "One launch for all slots", "Reading a prompt beside pipelined groups"). */
export const CONCURRENCY_EXPERIMENTAL_ENV = ['STRATA_BATCH_ATTN_ROWS', 'STRATA_BATCH_GDN_GROUPS', 'STRATA_PIPED_CONCURRENT'] as const;
export type ConcurrencyExperimentalEnv = typeof CONCURRENCY_EXPERIMENTAL_ENV[number];

export interface ConcurrencySettings {
  /** The slot count the service asks for: "parallel", else --batch / --slots, else 1. */
  parallel: number;
  parallelField: number | null;
  batchArg: number | null;
  slotsArg: number | null;
  batchMtp: boolean;
  batchGroups: string | null;
  layerSplit: string | null;
  gpuIds: number[];
  gpuCount: number;
  trimStageWeights: boolean;
  adaptAsync: string | null;
  conversationCacheMib: number | null;
  conversationCacheSlots: number | null;
  context: number | null;
  kv: string;
  kvResident: number | null;
  mtp: boolean;
  promptCacheOff: boolean;
  experimental: Record<ConcurrencyExperimentalEnv, boolean>;
}

const argList = (config: JsonObject): string[] => Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === 'string') : [];
function argValue(args: string[], flag: string): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) { const value = args[i + 1]; return value !== undefined && !value.startsWith('--') ? value : ''; }
    if (args[i]!.startsWith(`${flag}=`)) return args[i]!.slice(flag.length + 1);
  }
  return null;
}
const wholeNumber = (value: unknown): number | null => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(number) ? number : null;
};
const envOn = (env: unknown, key: string) => {
  const value = env && typeof env === 'object' && !Array.isArray(env) ? (env as JsonObject)[key] : undefined;
  return value === true || value === 1 || value === '1';
};

export function readConcurrencySettings(config: JsonObject): ConcurrencySettings {
  const args = argList(config);
  const parallelField = wholeNumber(config.parallel);
  const batchArg = wholeNumber(argValue(args, '--batch'));
  const slotsArg = wholeNumber(argValue(args, '--slots'));
  const gpu = config.gpu ?? argValue(args, '--gpu');
  const gpuIds = Array.isArray(gpu) ? gpu.map(Number).filter(Number.isSafeInteger) : typeof gpu === 'string' && gpu.trim() ? gpu.split(',').map(Number).filter(Number.isSafeInteger) : typeof gpu === 'number' ? [gpu] : [];
  const layerSplit = typeof config.layer_split === 'string' && config.layer_split.trim() ? config.layer_split.trim() : argValue(args, '--layer-split') || null;
  const kv = argValue(args, '--kv') || '';
  const context = wholeNumber(argValue(args, '--max-context'));
  return {
    // serve/server.py parallel_args: an explicit --batch / --slots in args wins over "parallel".
    parallel: Math.max(1, batchArg ?? slotsArg ?? parallelField ?? 1),
    parallelField, batchArg, slotsArg,
    batchMtp: args.includes('--batch-mtp') || envOn(config.env, 'STRATA_BATCH_MTP'),
    batchGroups: argValue(args, '--batch-groups') || null,
    layerSplit, gpuIds, gpuCount: Math.max(1, gpuIds.length),
    trimStageWeights: args.includes('--trim-stage-weights') || envOn(config.env, 'STRATA_STAGE_TRIM'),
    adaptAsync: argValue(args, '--adapt-async'),
    conversationCacheMib: wholeNumber(argValue(args, '--conversation-cache-mib')),
    conversationCacheSlots: wholeNumber(argValue(args, '--conversation-cache-slots')),
    context, kv: kv || (context !== null && context <= 8192 ? 'fp16' : 'int8'),
    kvResident: wholeNumber(argValue(args, '--kv-resident')),
    mtp: argValue(args, '--mtp') !== null,
    promptCacheOff: argValue(args, '--prompt-cache') === '0',
    experimental: Object.fromEntries(CONCURRENCY_EXPERIMENTAL_ENV.map(key => [key, envOn(config.env, key)])) as Record<ConcurrencyExperimentalEnv, boolean>,
  };
}

/** setup.py parallel_slot_gb: 12 QSA layers of KV (only the 32K window with KV streaming) + ~0.17 GB DeltaNet state. */
export function concurrencySlotVramGb(context: number, kv: string, streaming: boolean): number {
  const perToken = 12 * (kv === 'q4_0' ? 576 : 1056);
  return (streaming ? Math.min(context, 32768) : context) * perToken / 1e9 + 0.17;
}
/** BATCHING.md: with --kv-resident each slot's whole KV cache lives in pinned RAM (1.6 GB at 128K). */
export function concurrencySlotPinnedRamGb(context: number, kv: string, streaming: boolean): number {
  return streaming ? context * 12 * (kv === 'q4_0' ? 576 : 1056) / 1e9 : 0;
}
/** setup.py MODELS arena_gb (decimal GB), the same table as the native resource assessment. */
export function modelExpertArenaGb(family: string, quant: string): number | null {
  // Flash-Next: setup.py MODELS arena_gb. Qwen3.6: GGUF file size (decimal GB) — no separate pack (docs/QWEN36.md, QWEN36_FILES).
  const table: Record<string, number> = { 'qwen:Q2_0': 34, 'qwen:IQ2_XS': 35.5, 'swift:IQ2_XS': 35.5, 'qwen:IQ3_XXS': 42.9, 'swift:IQ3_XXS': 42.9, 'qwen:IQ3_S': 50.3, 'swift:IQ3_S': 50.3, 'coder:IQ1_M': 23.4, 'unsloth:UD-IQ4_XS': 59.5, 'unsloth:UD-Q4_K_XL': 77, 'qwen36:UD-Q4_K_XL': 22.9, 'qwen36:UD-Q6_K_XL': 32.6, 'qwen36:Q8_0': 37.8 };
  return table[`${family}:${quant}`] ?? null;
}
/** The family and quantization named by a config (model name, --native or --pack), or null when ambiguous. */
export function concurrencyModelIdentity(config: JsonObject): { family: string; quant: string } | null {
  const args = argList(config);
  const evidence = [config.model_name, argValue(args, '--native'), argValue(args, '--pack')].filter(value => typeof value === 'string').join(' ');
  // OrcaRouter IQ3_XXS (ORCA.md) is not the GSQ-RCO IQ3_XXS of setup.py's table.
  if (isOrcaRouterEvidence(evidence)) return null;
  const quants = [...evidence.matchAll(/(?:^|[^A-Za-z0-9])(?:UD-(?:IQ4_XS|Q4_K_XL|Q6_K_XL)|IQ(?:1_M|2_XS|3_XXS|3_S)|Q(?:2_0|8_0))(?=$|[^A-Za-z0-9])/gi)].map(match => match[0].replace(/^[^A-Za-z0-9]+/, '').toUpperCase());
  if (new Set(quants).size !== 1) return null;
  const quant = quants[0]!;
  const family = /qwen3\.?6|qwen36/i.test(evidence) ? 'qwen36' : quant.startsWith('UD-') ? 'unsloth' : /swift/i.test(evidence) ? 'swift' : /coder/i.test(evidence) ? 'coder' : 'qwen';
  return { family, quant };
}

export interface ConcurrencyHardwareGpu { id: number; name: string; vendor: string; totalBytes: number | null }
export interface ConcurrencyHardware { gpus: ConcurrencyHardwareGpu[]; totalMemoryBytes: number | null }
export interface ConcurrencyChange { key: string; value: string }
export interface ConcurrencyPlan {
  useCase: ConcurrencyUseCase;
  /** Slots this plan writes (1 = one at a time). */
  parallel: number;
  /** setup.py parallel_recommend for this hardware: 1 when it would cost speed. */
  officialParallel: number;
  vramGbs: number[];
  cacheGb: number | null;
  arenaGb: number | null;
  perSlotVramGb: number;
  totalSlotVramGb: number;
  perSlotPinnedRamGb: number;
  /** Share of the model's experts the expert cache still holds beside the slots (0-1), null when unknown. */
  expertShare: number | null;
  /** Expected slowdown of a request running alone, as a [low, high] fraction; null when not estimated. */
  slowdown: [number, number] | null;
  conversationCache: { mib: number; slots: number } | null;
  /** Companion flags written with the slot count, with a reason code each. */
  companions: (ConcurrencyChange & { reason: string })[];
  /** Why the plan looks the way it does (message codes). */
  reasons: string[];
  layerSplit: boolean;
}

const GB = 1e9, GIB = 2 ** 30;
function officialRecommend(vramGbs: number[], arenaGb: number, context: number, kv: string, streaming: boolean): number {
  const cache = vramGbs.reduce((sum, v) => sum + Math.max(0, v - 5), 0);
  const slot = concurrencySlotVramGb(context, kv, streaming);
  let best = 1;
  for (const n of [2, 3, 4]) if (n * slot <= 0.2 * cache && cache - n * slot >= 0.5 * arenaGb) best = n;
  return best;
}
/** The cards this config uses (its "gpu" list), else the largest card, as setup chooses. */
export function concurrencyVramGbs(settings: ConcurrencySettings, hardware: ConcurrencyHardware | null | undefined): number[] {
  if (!hardware?.gpus.length) return [];
  const known = hardware.gpus.filter(gpu => typeof gpu.totalBytes === 'number' && gpu.totalBytes > 0);
  const chosen = settings.gpuIds.length ? settings.gpuIds.flatMap(id => known.filter(gpu => gpu.id === id)) : known.sort((a, b) => b.totalBytes! - a.totalBytes!).slice(0, 1);
  return chosen.map(gpu => gpu.totalBytes! / GIB);
}

export function recommendConcurrency(input: { settings: ConcurrencySettings; hardware?: ConcurrencyHardware | null; arenaGb: number | null; useCase: ConcurrencyUseCase }): ConcurrencyPlan {
  const { settings, arenaGb, useCase } = input;
  const context = settings.context ?? 32768;
  const streaming = settings.kvResident !== null && settings.kvResident > 0;
  const vramGbs = concurrencyVramGbs(settings, input.hardware);
  const split = vramGbs.length > 1 || (!!settings.layerSplit && settings.gpuCount > 1);
  const cacheGb = vramGbs.length ? vramGbs.reduce((sum, v) => sum + Math.max(0, v - 5), 0) : null;
  const officialParallel = vramGbs.length && arenaGb !== null ? officialRecommend(vramGbs, arenaGb, context, settings.kv, streaming) : 1;
  const fits = officialParallel >= 2;
  const reasons: string[] = [];
  const companions: ConcurrencyPlan['companions'] = [];
  let parallel = 1;
  let conversationCache: ConcurrencyPlan['conversationCache'] = null;
  const ramGib = input.hardware?.totalMemoryBytes ? input.hardware.totalMemoryBytes / GIB : null;
  const spareRam = ramGib !== null && arenaGb !== null ? ramGib - arenaGb * GB / GIB - 8 : null; // 8 GiB left for the OS and the engine host side
  const cacheFor = (slots: number) => spareRam === null || spareRam >= 8 ? { mib: 8192, slots } : spareRam >= 4 ? { mib: 4096, slots: Math.min(slots, 2) } : null;
  if (!vramGbs.length || arenaGb === null) reasons.push('hardware_unknown');
  if (useCase === 'single') { parallel = 1; reasons.push('use_single'); }
  else if (useCase === 'agent') {
    if (fits) { parallel = Math.min(officialParallel, 4); reasons.push('use_agent_slots'); }
    else reasons.push('use_agent_cache');
    conversationCache = cacheFor(4);
    if (!conversationCache) reasons.push('ram_no_cache');
  } else if (useCase === 'multiUser') {
    if (fits) { parallel = officialParallel; reasons.push('use_multi_slots'); }
    else { conversationCache = cacheFor(4); reasons.push('use_multi_small_card'); }
  } else {
    parallel = fits ? (split ? Math.min(CONCURRENCY_ENGINE_MAX, Math.max(officialParallel, vramGbs.length * 2)) : officialParallel) : 1;
    reasons.push(fits ? 'use_batch_slots' : 'use_batch_small_card');
  }
  if (parallel > 1) {
    if (split) {
      if (settings.batchGroups && settings.batchGroups !== 'auto') companions.push({ key: '--batch-groups', value: '', reason: 'groups_auto' });
      if (settings.layerSplit && settings.layerSplit !== 'auto' && !settings.trimStageWeights) companions.push({ key: '--trim-stage-weights', value: 'true', reason: 'trim_stage' });
      if (settings.layerSplit === 'auto') reasons.push('trim_needs_explicit_split');
      if (settings.batchMtp) companions.push({ key: '--batch-mtp', value: '', reason: 'batch_mtp_pipeline' });
    } else {
      if (settings.mtp && !settings.batchMtp && fits) companions.push({ key: '--batch-mtp', value: 'true', reason: 'batch_mtp_single' });
      if (cacheGb !== null && arenaGb !== null && cacheGb < arenaGb && settings.adaptAsync !== '1') companions.push({ key: '--adapt-async', value: '1', reason: 'adapt_async' });
    }
  }
  const perSlotVramGb = concurrencySlotVramGb(context, settings.kv, streaming);
  const totalSlotVramGb = parallel > 1 ? perSlotVramGb * parallel : 0;
  const expertShare = cacheGb !== null && arenaGb ? Math.max(0, Math.min(1, (cacheGb - totalSlotVramGb) / arenaGb)) : null;
  let slowdown: [number, number] | null = null;
  if (parallel > 1 && cacheGb !== null) {
    // BATCHING.md measured: 12 GB card 2 slots -11%, 4 slots -24%; experts all in VRAM ~0-4%.
    if (!fits) slowdown = [Math.min(0.5, 0.11 + (parallel - 2) * 0.065), Math.min(0.6, 0.11 + (parallel - 2) * 0.065 + 0.05)];
    else if (expertShare !== null && expertShare >= 0.95) slowdown = [0, 0.05];
    else slowdown = [0.05, 0.15];
  }
  if (context > TRAINED_CONTEXT && parallel > 1) reasons.push('long_context_conflict');
  return { useCase, parallel, officialParallel, vramGbs, cacheGb, arenaGb, perSlotVramGb, totalSlotVramGb, perSlotPinnedRamGb: concurrencySlotPinnedRamGb(context, settings.kv, streaming), expertShare, slowdown, conversationCache, companions, reasons, layerSplit: split };
}

/** Field edits (STARTUP_TUNING_FIELDS keys) that write a plan; "" removes a value. */
export function concurrencyPlanEdits(settings: ConcurrencySettings, plan: ConcurrencyPlan): ConcurrencyChange[] {
  const edits: ConcurrencyChange[] = [];
  edits.push({ key: 'parallel', value: plan.parallel > 1 || settings.parallelField !== null ? String(plan.parallel) : '' });
  if (settings.batchArg !== null) edits.push({ key: '--batch', value: '' });
  for (const companion of plan.companions) edits.push({ key: companion.key, value: companion.value });
  if (plan.parallel <= 1) {
    if (settings.batchMtp) edits.push({ key: '--batch-mtp', value: '' });
    if (settings.batchGroups) edits.push({ key: '--batch-groups', value: '' });
  }
  if (plan.conversationCache && (settings.conversationCacheMib ?? 0) <= 0) {
    edits.push({ key: '--conversation-cache-mib', value: String(plan.conversationCache.mib) }, { key: '--conversation-cache-slots', value: String(plan.conversationCache.slots) });
  }
  const seen = new Set<string>();
  return edits.reverse().filter(edit => !seen.has(edit.key) && seen.add(edit.key)).reverse();
}

export interface ConcurrencyIssue { code: string; severity: 'error' | 'warning' | 'info'; fix?: ConcurrencyChange[]; values?: Record<string, string | number> }
export function concurrencyIssues(settings: ConcurrencySettings, options: { platform?: 'mac' | 'other'; officialParallel?: number; ramGib?: number | null } = {}): ConcurrencyIssue[] {
  const issues: ConcurrencyIssue[] = [];
  const n = settings.parallel, split = !!settings.layerSplit && settings.gpuCount > 1;
  const slotArgs = [settings.batchArg, settings.slotsArg].filter((value): value is number => value !== null);
  if (settings.parallelField !== null && slotArgs.some(value => value !== settings.parallelField)) issues.push({ code: 'parallel_batch_conflict', severity: 'error', values: { parallel: settings.parallelField, batch: slotArgs[0]! }, fix: settings.batchArg !== null ? [{ key: 'parallel', value: String(settings.batchArg) }, { key: '--batch', value: '' }] : undefined });
  else if (settings.parallelField === null && settings.batchArg !== null) issues.push({ code: 'batch_arg_merge', severity: 'info', values: { batch: settings.batchArg }, fix: [{ key: 'parallel', value: String(settings.batchArg) }, { key: '--batch', value: '' }] });
  if (n > 1 && options.platform === 'mac') issues.push({ code: 'metal_unsupported', severity: 'error', fix: [{ key: 'parallel', value: '1' }, { key: '--batch', value: '' }] });
  if (n > CONCURRENCY_ENGINE_MAX && !split) issues.push({ code: 'engine_cap', severity: 'warning', values: { max: CONCURRENCY_ENGINE_MAX }, fix: [{ key: 'parallel', value: String(CONCURRENCY_ENGINE_MAX) }] });
  const groups = wholeNumber(settings.batchGroups);
  if (groups !== null && groups > 0 && n > 1 && n % groups !== 0) issues.push({ code: 'groups_divide', severity: 'error', values: { groups, slots: n }, fix: [{ key: '--batch-groups', value: '' }] });
  if (split && n > CONCURRENCY_ENGINE_MAX && (groups === null ? settings.gpuCount : groups) * CONCURRENCY_ENGINE_MAX < n) issues.push({ code: 'group_cap', severity: 'warning', values: { max: CONCURRENCY_ENGINE_MAX } });
  if (settings.batchGroups && !split) issues.push({ code: 'groups_need_split', severity: 'info' });
  if (settings.batchMtp && !settings.mtp) issues.push({ code: 'batch_mtp_needs_mtp', severity: 'warning', fix: [{ key: '--batch-mtp', value: '' }] });
  if (settings.batchMtp && n <= 1) issues.push({ code: 'batch_mtp_one_slot', severity: 'info' });
  // BATCHING.md: no --batch-groups pipelines by default, except --adapt-async 1 keeps one group; an explicit G > 1 or auto pipelines.
  const pipelined = split && n > 1 && (settings.batchGroups === null ? settings.adaptAsync !== '1' : settings.batchGroups === 'auto' || (groups ?? 1) > 1);
  if (settings.batchMtp && pipelined) issues.push({ code: 'batch_mtp_pipeline_off', severity: 'warning', fix: [{ key: '--batch-groups', value: '1' }] });
  if (settings.batchMtp && split && n > CONCURRENCY_BATCH_MTP_SPLIT_MAX) issues.push({ code: 'batch_mtp_split_cap', severity: 'warning', values: { max: CONCURRENCY_BATCH_MTP_SPLIT_MAX } });
  if (settings.trimStageWeights && (!settings.layerSplit || settings.layerSplit === 'auto')) issues.push({ code: 'trim_needs_explicit_split', severity: 'warning' });
  if (settings.adaptAsync === '1' && pipelined) issues.push({ code: 'adapt_async_pipeline', severity: 'info' });
  if (settings.experimental.STRATA_PIPED_CONCURRENT && !split) issues.push({ code: 'piped_needs_split', severity: 'info' });
  if (n > 1 && (settings.context ?? 0) > TRAINED_CONTEXT) issues.push({ code: 'long_context_conflict', severity: 'warning' });
  if (n > 1 && options.officialParallel !== undefined && n > Math.max(1, options.officialParallel)) issues.push({ code: options.officialParallel <= 1 ? 'slow_per_request' : 'above_recommendation', severity: 'warning', values: { recommended: options.officialParallel } });
  if (n > 1 && settings.kvResident && settings.context && options.ramGib) {
    const pinned = concurrencySlotPinnedRamGb(settings.context, settings.kv, true) * n * GB / GIB;
    if (pinned > options.ramGib * 0.25) issues.push({ code: 'pinned_ram', severity: 'warning', values: { gib: Math.round(pinned * 10) / 10 } });
  }
  if (n > 1 && settings.promptCacheOff) issues.push({ code: 'prompt_cache_off', severity: 'info' });
  if (n > 1) issues.push({ code: 'parallel_limits', severity: 'info' });
  return issues;
}

/** Blocking errors for a saved configuration (the engine refuses these); a parallel/--batch mismatch still runs (--batch wins), so it stays a card error with a fix. */
export function concurrencyConfigError(config: JsonObject): string | null {
  for (const issue of concurrencyIssues(readConcurrencySettings(config))) {
    if (issue.severity !== 'error') continue;
    if (issue.code === 'groups_divide') return `--batch-groups ${issue.values?.groups} 必须整除并发槽数 ${issue.values?.slots} / --batch-groups must divide the slot count`;
  }
  return null;
}

const messages: Record<string, [string, string]> = {
  hardware_unknown: ['未读到这台电脑的显卡或模型规格，推荐值按一次一个处理。', 'GPU or model details are unknown here, so the recommendation stays at one request at a time.'],
  use_single: ['一次处理一个请求，单个请求最快；其余请求排队。', 'One request at a time is the fastest single stream; others wait in line.'],
  use_agent_slots: ['专家大多在显存里：主 Agent 与子 Agent 可以同时出字，另加会话暂存让轮流的会话不重读历史。', 'Most experts fit in VRAM: the main agent and sub-agents decode together, and conversation parking keeps alternating chats from rereading history.'],
  use_agent_cache: ['这张卡放不下足够专家，并发会让每个请求变慢。改用会话暂存：子 Agent 轮流时不重读历史。', 'This card cannot hold enough experts, so slots would slow every request. Conversation parking keeps sub-agents from rereading history when they alternate.'],
  use_multi_slots: ['多人或多个客户端同时用：每人都能马上出字，不必等前一个回答结束。', 'Several users or clients at once: everyone starts right away instead of waiting for the previous answer.'],
  use_multi_small_card: ['这张卡上并发只换来少排队，总速度反而下降（官方 12 GB 实测 −11% 到 −24%）。建议一次一个，配合会话暂存。', 'On this card slots trade speed for less waiting (official 12 GB measurement: −11% to −24%). Keep one at a time with conversation parking.'],
  use_batch_slots: ['批量生成看总吞吐：多卡流水线时槽数按卡数加倍。', 'Batch generation is about total throughput: on a layer split the slot count scales with the cards.'],
  use_batch_small_card: ['专家大多在 CPU 上时，批量并发不会提高总吞吐，保持一次一个。', 'With most experts on the CPU, batching does not raise total throughput; keep one at a time.'],
  ram_no_cache: ['内存余量不足，未加会话暂存。', 'Not enough spare RAM for conversation parking.'],
  groups_auto: ['多卡默认按卡流水线分组（auto）', 'Layer split pipelines one group per card (auto)'],
  trim_stage: ['每张卡只加载自己的层，省下的显存给专家缓存', 'Each card loads only its own layers; the freed VRAM goes to the expert cache'],
  trim_needs_explicit_split: ['只裁剪权重需要显式层分配（例如 24），auto 不生效。', 'Trimming stage weights needs an explicit layer split (e.g. 24); auto does not apply.'],
  batch_mtp_pipeline: ['多卡流水线时 --batch-mtp 会被引擎关闭', 'The engine turns --batch-mtp off with pipelined groups'],
  batch_mtp_single: ['单卡并发时每个槽带一个 MTP 草稿（官方 +31% 到 +39%）', 'Each slot verifies one MTP draft on one GPU (official +31% to +39%)'],
  adapt_async: ['专家放不下时，批处理窗口里异步换入专家（官方 89 对 75 tok/s）', 'Experts are swapped in asynchronously between batch windows when they do not all fit (official 89 vs 75 tok/s)'],
  long_context_conflict: ['上下文超过 262K 时并发会大幅拖慢解码（社区 1M 实测 60 → 10–15 tok/s），长上下文建议一次一个。', 'Past 262K, slots slow decoding sharply (community 1M run: 60 → 10–15 tok/s). Keep long contexts at one at a time.'],
  parallel_batch_conflict: ['parallel 为 {{parallel}}，但参数列表里的 --batch/--slots {{batch}} 实际生效。改为 parallel {{batch}} 并移除参数。', 'parallel is {{parallel}}, but --batch/--slots {{batch}} in args is what runs. Set parallel to {{batch}} and remove the argument.'],
  batch_arg_merge: ['并发写在参数列表 --batch {{batch}} 里，合并到 parallel 便于统一管理。', 'Concurrency is set as --batch {{batch}} in args; move it to parallel to manage it in one place.'],
  metal_unsupported: ['Mac（Metal）上开并发会在第一个并发请求时让引擎退出（上游 #2715），请保持一次一个。', 'On Mac (Metal), slots stop the engine at the first concurrent request (upstream #2715). Keep one at a time.'],
  engine_cap: ['单卡最多 {{max}} 个槽，多出的不会生效。', 'One GPU runs at most {{max}} slots; the rest have no effect.'],
  groups_divide: ['组数 {{groups}} 必须整除槽数 {{slots}}。', 'Groups ({{groups}}) must divide the slot count ({{slots}}).'],
  group_cap: ['多卡时每组最多 {{max}} 个槽，请增加组数或减少槽数。', 'A layer split runs at most {{max}} slots per group; add groups or reduce slots.'],
  groups_need_split: ['并发分组只在多卡层分配时生效。', 'Batch groups only apply to a layer split.'],
  batch_mtp_needs_mtp: ['--batch-mtp 需要先启用 --mtp。', '--batch-mtp needs --mtp.'],
  batch_mtp_one_slot: ['只有一个槽时 --batch-mtp 不生效。', '--batch-mtp has no effect with one slot.'],
  batch_mtp_pipeline_off: ['多卡流水线分组时引擎会关掉 --batch-mtp；要保留它需把组数设为 1（长提示词读取会变慢）。', 'With pipelined groups the engine turns --batch-mtp off; keep it with groups = 1 (long prompt reads get slower).'],
  batch_mtp_split_cap: ['多卡 + --batch-mtp 每个窗口最多 {{max}} 个槽，多出的轮流执行。', 'A layer split with --batch-mtp holds at most {{max}} slots per window; more slots rotate.'],
  adapt_async_pipeline: ['流水线分组不做专家自适应，--adapt-async 会被关闭。', 'Pipelined groups do not adapt experts; --adapt-async is turned off.'],
  piped_needs_split: ['并行读取提示词只在多卡流水线分组时生效。', 'Reading prompts beside the slots only applies to pipelined groups on a layer split.'],
  slow_per_request: ['这张卡上并发会让每个请求变慢约 10–25%，换来的是少排队。', 'On this card slots cost about 10–25% speed per request in exchange for less waiting.'],
  above_recommendation: ['高于这台电脑的推荐值 {{recommended}}，更多槽会挤占专家缓存。', 'Above this computer\'s recommendation of {{recommended}}; more slots take expert-cache room.'],
  pinned_ram: ['KV 流式时所有槽共占约 {{gib}} GiB 固定内存。', 'With KV streaming the slots take about {{gib}} GiB of pinned RAM in all.'],
  prompt_cache_off: ['--prompt-cache 0 时请求不会回到单请求快速路径。', 'With --prompt-cache 0 a request never returns to the fast solo path.'],
  parallel_limits: ['并发时不应用重复/频率/存在惩罚，logit_bias 与会话存档（slot save）不可用。', 'With slots, repetition/frequency/presence penalties are not applied; logit_bias and slot save are unavailable.'],
};
export function concurrencyMessage(code: string, zh: boolean, values: Record<string, string | number> = {}): string {
  const template = messages[code]?.[zh ? 0 : 1] ?? code;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values[key] ?? ''));
}
