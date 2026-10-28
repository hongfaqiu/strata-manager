import { isOrcaRouterEvidence } from './orca-import';
import { StrataError } from './errors';
import type { JsonObject } from './types';

/** Model-specific estimates reviewed against Strata v0.1.44, never a general GGUF capacity formula. */
export const RESOURCE_ASSESSMENT_REVISION = 'a0116b2782a5b82622358c04a06496485d12b2d6';
export interface ResourceAssessmentRequest {
  installationId: string;
  family: string;
  quant: string;
  context: number;
  images: boolean;
  kv: string;
  gpuIds: number[];
  parallel: number;
}
export interface ResourceGpuSnapshot {
  id: number;
  vendor: string;
  name: string;
  totalBytes: number | null;
  availableBytes: number | null;
  source: string;
}
export interface ResourceHardwareSnapshot {
  sampledAt: number;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  gpus: ResourceGpuSnapshot[];
  cpuName: string;
  cpuIsa: string;
  wsl: boolean;
  managedServiceRunning: boolean;
}
export interface ResourceHardwareSignature {
  cpuName: string;
  totalMemoryBytes: number;
  gpus: { id: number; name: string; totalBytes: number }[];
}
export interface ResourceHistoricalMeasurement { id: string; startedAt: number; ramPeakBytes: number | null; vramPeakBytes: number | null }
export interface ResourceAssessmentReason { code: string; severity: 'info' | 'risk' }
export interface SetupResourceAssessment {
  status: 'suggested' | 'risk' | 'unknown';
  estimate: true;
  sampledAt: number;
  hardware: ResourceHardwareSnapshot;
  ram: { baselineBytes: number | null; expertBytes: number | null; longContextBytes: number | null; mode: 'normal' | 'resident' | 'mmap' | 'budget' | 'unknown' };
  /** contextVramBytes: DeepSeek-V4.1-Flash past 8K, the context cache taken from the card's expert cache (Strata 0.2.7). */
  kv: { streaming: boolean | null; streamingRamBytes: number | null; contextVramBytes?: number };
  slots: { count: number; perSlotVramBytes: number | null; totalVramBytes: number | null };
  recommendations: { context: number | null; parallel: number | null };
  /** Present past the trained 262,144 tokens: the yarn factor setup derives and KV + RoPE table bytes. */
  contextExtension?: { trainedContext: number; scaling: string; scale: number; kvBytes: number; ropeBytes: number } | null;
  reasons: ResourceAssessmentReason[];
  unknowns: string[];
  sourceRevision: string;
}
export function validateResourceAssessmentRequest(request: ResourceAssessmentRequest): ResourceAssessmentRequest {
  if (!request || typeof request.installationId !== 'string' || !request.installationId.trim() || request.installationId.length > 256 || /[\u0000-\u001f\u007f]/.test(request.installationId)
    || typeof request.family !== 'string' || request.family.length > 64 || typeof request.quant !== 'string' || request.quant.length > 128
    || !Number.isSafeInteger(request.context) || request.context < 512 || request.context > 1_048_576
    || typeof request.images !== 'boolean' || typeof request.kv !== 'string' || request.kv.length > 32
    || !Number.isSafeInteger(request.parallel) || request.parallel < 1 || request.parallel > 64
    || !Array.isArray(request.gpuIds) || request.gpuIds.length > 8 || request.gpuIds.some(id => !Number.isSafeInteger(id) || id < 0 || id > 255) || new Set(request.gpuIds).size !== request.gpuIds.length) {
    throw new StrataError('INVALID_RESOURCE_ASSESSMENT', '资源预估参数无效 / Invalid resource assessment request');
  }
  return { ...request, installationId: request.installationId.trim(), gpuIds: [...request.gpuIds] };
}

/** A filename is only a recipe hint; the result never asserts GGUF compatibility. Complex resource overrides stay unknown. */
export function resourceRequestFromConfiguration(config: JsonObject | undefined, installationId: string): ResourceAssessmentRequest | null {
  if (!config || !Array.isArray(config.args) || !config.args.every(arg => typeof arg === 'string')) return null;
  const args = config.args as string[];
  const read = (flag: string): string | undefined => {
    const found = args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : arg.startsWith(`${flag}=`) ? [arg.slice(flag.length + 1)] : []);
    if (found.length > 1 || found.some(value => !value || value.startsWith('--'))) throw new Error('Ambiguous argument');
    return found[0];
  };
  try {
    // The finite estimator models upstream setup defaults, not arbitrary cache/resident/split/replica settings.
    if (config.replicas || args.some(arg => /^(?:--layer-split|--peer-device|--resident-budget-gib|--resident-experts|--mmap-experts|--vram-elastic|--kv-resident)(?:=|$)/.test(arg))
      || config.env && typeof config.env === 'object' && Object.keys(config.env).some(key => /^(?:STRATA_|CUDA_|HIP_|ROCR_)/.test(key))) return null;
    if (read('--expert-cache') && read('--expert-cache') !== 'auto' || read('--vram-reserve-mib') && read('--vram-reserve-mib') !== '700') return null;
    const evidence = [config.model_name, read('--native'), read('--pack')].filter(value => typeof value === 'string').join(' ');
    const quants = [...evidence.matchAll(/(?:^|[^A-Za-z0-9])(?:UD-(?:IQ4_XS|Q4_K_XL|Q5_K_XL|Q6_K_XL)|IQ(?:1_M|2_XS|3_XXS|3_S)|Q(?:2_0|8_0))(?=$|[^A-Za-z0-9])/gi)].map(match => match[0].replace(/^[^A-Za-z0-9]+/, '').toUpperCase());
    if (new Set(quants).size !== 1) return null;
    const quant = quants[0];
    if (!quant || !/qwen|swift|coder|unsloth/i.test(evidence) || isOrcaRouterEvidence(evidence)) return null;
    const family = /qwen3\.?6|qwen36/i.test(evidence) ? 'qwen36' : quant.startsWith('UD-') || (quant === 'Q8_0' && /flash-next/i.test(evidence)) || /unsloth/i.test(evidence) ? 'unsloth' : /swift/i.test(evidence) ? 'swift' : /coder/i.test(evidence) ? 'coder' : 'qwen';
    const gpu = config.gpu ?? read('--gpu');
    const gpuIds = gpu == null ? [] : Array.isArray(gpu) ? gpu.map(Number) : String(gpu).split(',').map(Number);
    const context = Number(read('--max-context'));
    const kv = read('--kv') ?? (context <= 8192 ? 'fp16' : 'int8');
    // An explicit engine --batch can disagree with the server setting. Do not invent precedence.
    if (read('--batch') || read('--slots')) return null;
    return validateResourceAssessmentRequest({ installationId, family, quant, context, images: !!config.vision, kv, gpuIds, parallel: config.parallel == null ? 1 : Number(config.parallel) });
  } catch { return null; }
}

export function resourceAssessmentMessage(code: string, zh: boolean): string {
  const messages: Record<string, [string, string]> = {
    estimate_scope: ['这是官方安装规则的预估，不能证明模型已就绪或保证速度；各分项不应直接相加。', 'These estimates follow official setup rules; they do not prove readiness or speed. Do not add the components as a total.'],
    managed_running: ['当前有受管服务运行；可用内存和显存包含它的占用，不代表停止后仍有同等压力。', 'A managed service is running. Free RAM and VRAM include its usage and may change after it stops.'],
    ram_pressure: ['当前可用内存低于模型专家的规模；准备运行前请减少其他程序占用。', 'Available RAM is below the expert arena size. Reduce other applications before running.'],
    gpu_pressure: ['当前可用显存低于官方估算为基础权重与缓冲预留的空间，请先减少其他 GPU 程序的占用。', 'Available VRAM is below the official allowance for dense weights and buffers. Reduce other GPU applications first.'],
    low_ram_resident: ['按官方低内存规则，部分专家留在 GPU，其余可驻留 RAM。', 'The official low-RAM rule keeps some experts on the GPU and the remainder in resident RAM.'],
    low_ram_mmap: ['低内存模式需要从文件读取部分专家，SSD 和系统文件缓存会明显影响速度。', 'Low-RAM mapped mode reads some experts from files. SSD and OS file-cache behavior can significantly affect speed.'],
    low_ram_shortfall: ['按官方规则，RAM 与单卡专家缓存仍不足，存在频繁磁盘读取或内存不足的风险。', 'RAM and the single-GPU expert cache remain below the official budget, risking frequent file reads or memory exhaustion.'],
    long_context_ram: ['这个上下文超出官方 RAM 建议，运行时可能分页或内存不足。', 'This context exceeds the official RAM recommendation and may page or run out of memory.'],
    context_extension: ['超过训练长度 262K 属实验性功能，按官方规则使用 YaRN（倍数 = 上下文 ÷ 262,144）；KV 与 RoPE 表按比例增加占用。', 'Past the trained 262K is experimental: the official rule uses YaRN (scale = context ÷ 262,144), and KV plus RoPE tables grow with it.'],
    expert_cache_auto: ['长上下文请保持专家缓存为 auto；显存剩余接近 0 MiB 时解码可能慢 7 倍。', 'Keep the expert cache on auto for long contexts; near 0 MiB of free VRAM, decoding can slow down 7×.'],
    above_native_context: ['超过原生 262K 上下文需扩展设置，首版无法完整预估。', 'Contexts above the native 262K window require scaling settings and cannot be fully estimated here.'],
    parallel_cost: ['并发槽占用专家缓存；减少排队等待也可能降低每个请求的速度。', 'Batch slots consume expert-cache VRAM. Less queueing can also lower per-request speed.'],
    parallel_above_recommendation: ['请求并发高于官方资源建议，更多槽位可能使每个请求变慢。', 'Requested concurrency exceeds the official recommendation and may slow each request.'],
    engine_slot_cap: ['默认批处理窗口至多 8 槽，设置值不等于引擎实际服务容量。', 'The default batch window runs at most 8 slots; configured concurrency is not actual serving capacity.'],
    wsl_streaming_off: ['WSL 按官方规则关闭 KV streaming，长上下文会占用更多显存。', 'Official setup disables KV streaming under WSL; long contexts consume more VRAM.'],
    budget_mode: ['这个 Unsloth 量化采用 RAM 预算和文件读取，首版不计算完整运行容量。', 'This Unsloth quantization uses a RAM budget and file reads; full running capacity is not estimated here.'],
    image_reserve_unknown: ['启用图片需要额外编码器与缓冲空间，首版不估算这部分容量。', 'Images require encoder and buffer memory that this estimate does not cover.'],
    multi_gpu_unknown: ['多 GPU 或多副本的资源分配超出首版估算范围。', 'Multi-GPU or replica placement is outside this estimate.'],
    gpu_auto_selection_unknown: ['本机有多张 GPU，安装器的自动选卡尚未确认；选择一张 GPU 后可计算单卡建议。', 'Multiple GPUs are present and automatic selection is unconfirmed. Select one GPU for single-card guidance.'],
    gpu_unknown: ['未取得所选 GPU 的可靠显存数据；缺失容量保留为未知。', 'Reliable VRAM data for the selected GPU is unavailable; missing capacity remains unknown.'],
    kv_unknown: ['这种 KV 精度没有可直接复用的官方估算规则。', 'No reviewed official estimate is available for this KV format.'],
    model_unknown: ['没有识别到官方模型与量化组合，不能从文件大小推导运行容量。', 'The official model and quantization recipe is unknown; file size cannot establish running capacity.'],
    dsv41_no_card: ['没有 8 GB 以上的 NVIDIA 或 AMD 显卡；DeepSeek-V4.1-Flash 需要独立显卡放置注意力权重和部分专家。', 'No NVIDIA or AMD card with 8 GB or more; DeepSeek-V4.1-Flash needs a discrete GPU for the attention weights and some experts.'],
    dsv41_ram_store: ['内存放不下全部专家：引擎在内存里保留常用专家，其余从 SSD 读取，速度会下降。', 'RAM cannot hold every expert: the engine keeps the most used ones in RAM and reads the rest from the SSD, which is slower.'],
    dsv41_ram_spill: ['内存低于这个版本的建议值：回答时会频繁从 SSD 读取专家，可以运行但很慢；内存小于 40 GiB 时建议选 1.75 bpw，或增加内存。', 'RAM is below this set\'s guidance: experts are read from the SSD while answering, which runs but is slow; under 40 GiB of RAM pick 1.75 bpw, or add RAM.'],
    dsv41_context_untested: ['超过 256K 的上下文上游尚未测试：上下文缓存占用显卡的专家缓存，长提示读取较慢，首次回复可能要很多分钟。', 'Contexts past 256K are not tested upstream yet: the context cache takes the card\'s expert cache, long prompts read slowly, and the first reply can take many minutes.'],
    cpu_experimental: ['处理器不具备 AVX2，官方建议使用实验构建，速度和兼容性另行验证。', 'This CPU lacks AVX2; official setup uses an experimental build requiring separate validation.'],
  };
  return messages[code]?.[zh ? 0 : 1] ?? code;
}

/** Match recorded actual resource selections and static hardware, never a report name or saved JSON alone. */
export function matchingResourceMeasurements(reports: unknown[], request: ResourceAssessmentRequest, hardware: ResourceHardwareSnapshot): ResourceHistoricalMeasurement[] {
  const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const hardwareKey = (value: unknown): string | null => {
    const source = record(value);
    if (typeof source.cpuName !== 'string' || !source.cpuName || !finite(source.totalMemoryBytes) || !source.totalMemoryBytes || !Array.isArray(source.gpus) || !source.gpus.length) return null;
    const gpus = source.gpus.map(record);
    if (gpus.some(gpu => !Number.isInteger(gpu.id) || typeof gpu.name !== 'string' || !gpu.name || !finite(gpu.totalBytes) || !gpu.totalBytes) || new Set(gpus.map(gpu => gpu.id)).size !== gpus.length) return null;
    return JSON.stringify({ cpuName: source.cpuName, totalMemoryBytes: source.totalMemoryBytes, gpus: gpus.map(gpu => ({ id: gpu.id as number, name: gpu.name, totalBytes: gpu.totalBytes })).sort((a, b) => a.id - b.id) });
  };
  const currentHardware = hardwareKey(hardware);
  if (!currentHardware) return [];
  const requestKey = (value: unknown): string | null => {
    try {
      const source = validateResourceAssessmentRequest(value as ResourceAssessmentRequest);
      return JSON.stringify([source.installationId, source.family, source.quant, source.context, source.images, source.kv, source.gpuIds, source.parallel]);
    } catch { return null; }
  };
  const currentRequest = requestKey(request);
  if (!currentRequest) return [];
  return reports.flatMap(value => {
    const report = record(value), identity = record(report.identity);
    if (report.state !== 'completed' || typeof report.id !== 'string' || !report.id || !finite(report.startedAt) || !Array.isArray(report.samples) || !report.samples.length || report.samples.some(sample => record(sample).state !== 'completed')
      || identity.effectiveVerified !== true || typeof identity.effectiveStartupHash !== 'string' || !identity.effectiveStartupHash
      || requestKey(identity.resourceRequest) !== currentRequest || hardwareKey(identity.hardwareSignature) !== currentHardware || !Array.isArray(report.telemetry)) return [];
    const telemetry = report.telemetry.map(record);
    const peak = (key: string) => { const values = telemetry.map(point => point[key]).filter(finite); return values.length ? Math.max(...values) : null; };
    const ramPeakBytes = peak('ramUsed'), vramPeakBytes = peak('gpuMemoryUsed');
    return ramPeakBytes === null && vramPeakBytes === null ? [] : [{ id: report.id, startedAt: report.startedAt, ramPeakBytes, vramPeakBytes }];
  }).sort((a, b) => b.startedAt - a.startedAt).slice(0, 3);
}
