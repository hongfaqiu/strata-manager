/**
 * TEMPORARY DEV-only Overview mock.
 * Enable with ?mockData=1 | #mockData=1 | localStorage mockData=1
 * Optional state: ?mockData=generating | loading (default idle)
 * loading = Xiaohongshu feedback: two GPUs, slow cold load, startup card above the running card.
 * Keep separate from ?artDemo=1 (hero art cycle).
 */
import type {
  ApiAnalyticsCoverage,
  ApiUsageSummary,
  BackgroundHealthSnapshot,
  JsonObject,
  MetricSnapshot,
  ProcessStatus,
  ServiceProfile,
  TaskStatus,
} from '@strata-manager/core';

export type OverviewMockState = 'idle' | 'generating' | 'stopped' | 'loading';

export function overviewMockEnabled(): boolean {
  if (typeof import.meta !== 'undefined' && import.meta.env?.DEV !== true) return false;
  if (typeof window === 'undefined') return false;
  try {
    const q = new URLSearchParams(window.location.search).get('mockData');
    if (q === '1' || q === 'idle' || q === 'generating' || q === 'stopped' || q === 'loading') return true;
    if (/(?:^|[?#&])mockData(?:=1|=idle|=generating)?(?:&|$)/.test(window.location.hash)) return true;
    const stored = window.localStorage.getItem('mockData');
    if (stored === '1' || stored === 'idle' || stored === 'generating') return true;
  } catch { /* ignore */ }
  return false;
}

export function overviewMockState(): OverviewMockState {
  if (typeof window === 'undefined') return 'idle';
  try {
    const q = new URLSearchParams(window.location.search).get('mockData');
    if (q === 'generating') return 'generating';
    if (q === 'stopped') return 'stopped';
    if (q === 'loading') return 'loading';
    if (/(?:^|[?#&])mockData=generating(?:&|$)/.test(window.location.hash)) return 'generating';
    if (window.localStorage.getItem('mockData') === 'generating') return 'generating';
  } catch { /* ignore */ }
  return 'idle';
}

/** DEV-only memory pressure for screenshots: ?mockPressure=normal | high (default keeps the classic 21.4/24 GB, 66.4/96 GB). */
function overviewMockMemory(): { vramUsed: number; vramTotal: number; ramUsed: number; ramTotal: number } {
  let p: string | null = null;
  try { p = new URLSearchParams(window.location.search).get('mockPressure'); } catch { /* ignore */ }
  if (p === 'normal') return { vramUsed: 14.2, vramTotal: 24, ramUsed: 38.5, ramTotal: 96 };
  if (p === 'high') return { vramUsed: 31.2, vramTotal: 32, ramUsed: 55.5, ramTotal: 64 };
  return { vramUsed: 21.4, vramTotal: 24, ramUsed: 66.4, ramTotal: 96 };
}

/** DEV-only GPU layout for screenshots: ?mockGpu=igpu is an RTX 5070 Laptop beside a Radeon 890M, totals from the discrete card only. */
function overviewMockGpu(): string | null {
  try { return new URLSearchParams(window.location.search).get('mockGpu'); } catch { return null; }
}

function integratedGpuMock(metric: MetricSnapshot, busy: boolean) {
  const gb = (n: number) => n * 1024 ** 3;
  const card = { name: 'NVIDIA GeForce RTX 5070 Laptop GPU', util: busy ? 88 : 16, mem_used: gb(6.9), mem_total: gb(8), temp: busy ? 71 : 52, power: busy ? 92 : 24 };
  const igpu = { name: 'AMD Radeon 890M Graphics', util: 9, mem_used: gb(0.4), mem_total: gb(0.5), temp: 48, power: 6, integrated: true };
  Object.assign(metric, { gpuUtil: card.util, gpuMemoryUsed: card.mem_used, gpuMemoryTotal: card.mem_total, gpuTemperature: card.temp, gpuPower: card.power });
  const raw = metric.raw as JsonObject;
  const hardware = raw.hardware as JsonObject;
  Object.assign(hardware, { gpu_util: card.util, gpu_mem_used: card.mem_used, gpu_mem_total: card.mem_total, gpu_temp: card.temp, gpu_power: card.power, gpu_power_limit: 115, gpus: [card, igpu] });
  raw.hardware_static = { ...(raw.hardware_static as JsonObject), gpu_name: 'NVIDIA GeForce RTX 5070 Laptop GPU', gpu_count: 1 };
}

const nowSec = () => Math.floor(Date.now() / 1000);

function sampleRequests(state: OverviewMockState): JsonObject[] {
  const t = nowSec();
  const rows: JsonObject[] = [];
  // Deterministic but uneven, so charts look like real traffic.
  const prompts = [3120, 860, 5480, 1240, 2210, 9800, 640, 1880, 4150, 1020, 7340, 2650, 1530, 520, 3890, 2280];
  const outputs = [412, 96, 1280, 188, 540, 2048, 64, 322, 760, 140, 1630, 468, 236, 58, 905, 380];
  const speeds = [44.8, 51.2, 39.6, 47.9, 45.1, 36.4, 52.7, 46.3, 41.8, 49.5, 38.2, 44.0, 47.1, 53.4, 40.7, 45.9];
  for (let i = 0; i < 16; i++) {
    rows.push({
      id: `req-mock-${i}`,
      time: t - i * 71 - (i * 37) % 53 - 12,
      prompt_tokens: prompts[i],
      output_tokens: outputs[i],
      decode_tok_s: speeds[i],
      prompt_ms: 120 + prompts[i]! / 9,
      reused: i % 2 === 0 ? 64 : 0,
      hit_rate: 0.42 + (i % 4) * 0.08,
      finish: i === 5 ? 'length' : i === 9 ? 'cancelled' : i === 3 ? 'tool_calls' : 'stop',
    });
  }
  if (state === 'generating') {
    // live request is current; recent list still shows completed ones
  }
  return rows;
}

export interface OverviewMockStartup { phase: 'loading'; startedAt: number; apiUrl: string; modelName: string; logs: { timestamp: number; level: string; message: string }[] }
export type OverviewMock = ReturnType<typeof baseOverviewMock> & { startup?: OverviewMockStartup; errors?: { health: string; metrics: string } };

export function buildOverviewMock(state: OverviewMockState = overviewMockState()): OverviewMock {
  return state === 'loading' ? loadingMock(baseOverviewMock('idle')) : baseOverviewMock(state);
}

function baseOverviewMock(state: OverviewMockState) {
  const profile: ServiceProfile = {
    id: 'mock-profile-dev',
    name: 'Swift-Qwen3.8-Flash-Next IQ3_S',
    baseUrl: 'http://127.0.0.1:8080',
    installDir: '/home/dev/strata',
    pythonPath: '/home/dev/strata/.venv/bin/python',
    configPath: '/home/dev/strata/configs/swift-iq3_s.json',
    managed: true,
  };

  const health: JsonObject = {
    loaded: true,
    model: 'Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S',
    images: true,
    api_key: false,
    max_context: 131072,
  };

  const process: ProcessStatus = {
    running: state !== 'stopped',
    owned: true,
    pid: 42817,
    startedAt: Date.now() - 3_600_000,
    creationTime: new Date(Date.now() - 3_600_000).toISOString(),
  };

  const requests = sampleRequests(state);
  const last = requests[0] ?? {
    prompt_tokens: 1800,
    output_tokens: 240,
    decode_tok_s: 42.5,
  };
  const live: JsonObject = state === 'generating'
    ? {
        state: 'generating',
        queued: 1,
        running: 1,
        tok_s: 46.8,
        prompt_tokens: 2048,
        generated: 312,
        prefill_tok_s_mean: 820,
      }
    : {
        state: 'idle',
        queued: 0,
        running: 0,
        prompt_tokens: last.prompt_tokens,
        generated: last.output_tokens,
        prefill_tok_s_mean: 910,
      };

  const gb = (n: number) => n * 1024 ** 3;
  const mem = overviewMockMemory();
  const metric: MetricSnapshot = {
    state,
    model: String(health.model),
    decodeTokS: state === 'generating' ? 46.8 : Number(last.decode_tok_s),
    prefillTokS: state === 'generating' ? 820 : 910,
    gpuUtil: state === 'generating' ? 91.2 : 18.4,
    gpuMemoryUsed: gb(mem.vramUsed),
    gpuMemoryTotal: gb(mem.vramTotal),
    gpuTemperature: state === 'generating' ? 72 : 54,
    gpuPower: state === 'generating' ? 248 : 96,
    cpuUtil: state === 'generating' ? 34.2 : 8.1,
    ramUsed: gb(mem.ramUsed),
    ramTotal: gb(mem.ramTotal),
    queued: Number(live.queued),
    running: Number(live.running),
    cacheHitRate: 0.58,
    requests,
    history: {},
    raw: {
      live,
      engine: { model: health.model, max_context: 131072, expert_slots: 412, expert_cache_mib: 12288 },
      hardware: {
        cpu: state === 'generating' ? 34.2 : 8.1,
        ram_used: gb(mem.ramUsed),
        ram_total: gb(mem.ramTotal),
        gpu_util: state === 'generating' ? 91.2 : 18.4,
        gpu_mem_used: gb(mem.vramUsed),
        gpu_mem_total: gb(mem.vramTotal),
        gpu_temp: state === 'generating' ? 72 : 54,
        gpu_power: state === 'generating' ? 248 : 96,
        gpus: [{ util: state === 'generating' ? 91.2 : 18.4, mem_used: gb(mem.vramUsed), mem_total: gb(mem.vramTotal), temp: state === 'generating' ? 72 : 54, power: state === 'generating' ? 248 : 96 }],
        gpu_power_limit: 320, gpu_pcie_gen: 4, gpu_pcie_gen_max: 4, gpu_pcie_width: 16, gpu_pcie_rx_mb: state === 'generating' ? 1840 : 12,
      },
      // Same field names /metrics already reports (see OfficialMonitoring).
      hardware_static: { gpu_name: 'NVIDIA GeForce RTX 4090', cores: 16, threads: 32, psutil: true },
      conversation_cache: { enabled: true, bytes: gb(6.4), budget_mib: 8192, parked: 3, slots: 4 },
      requests,
    },
  };

  if (overviewMockGpu() === 'igpu') integratedGpuMock(metric, state === 'generating');

  const tasks: TaskStatus[] = [
    {
      id: 'mock-task-1',
      kind: 'setup',
      state: 'running',
      message: '正在准备量化配置…',
      startedAt: Date.now() - 95_000,
    },
    {
      id: 'mock-task-2',
      kind: 'update',
      state: 'completed',
      message: '运行时已更新到最新版本',
      startedAt: Date.now() - 3_600_000,
      finishedAt: Date.now() - 3_400_000,
    },
  ];

  const backgroundHealth: BackgroundHealthSnapshot = {
    profileId: profile.id,
    phase: 'healthy',
    apiHealthy: true,
    loaded: true,
    observerState: state === 'generating' ? 'busy' : 'idle',
    activeRequests: state === 'generating' ? 1 : 0,
    pid: process.pid ?? null,
    reason: 'ok',
    checkedAt: Date.now() - 8_000,
    lastHealthyAt: Date.now() - 8_000,
    probeAttempted: true,
    consecutiveFailures: 0,
    failures: [],
  };

  const endMs = Date.now() + 1;
  const dayStart = new Date(endMs);
  dayStart.setHours(0, 0, 0, 0);
  const usageSummary: ApiUsageSummary = {
    startMs: dayStart.getTime(),
    endMs,
    http: {
      requests: 128,
      succeeded: 121,
      failed: 4,
      cancelled: 2,
      interrupted: 1,
      pending: 0,
      inputTokens: 482_300,
      outputTokens: 96_840,
      cacheReadTokens: 42_100,
      cacheCreationTokens: 8_200,
      inputTokenSamples: 120,
      outputTokenSamples: 120,
      mcpToolCalls: 14,
      mcpToolFailures: 1,
      firstRequestAtMs: dayStart.getTime() + 3_600_000,
      lastFinishedAtMs: Date.now() - 40_000,
      successRate: 121 / 128,
    },
    inference: {
      runs: 118,
      inputTokens: 470_000,
      outputTokens: 94_000,
      cacheReadTokens: 40_000,
      toolCalls: 12,
      inputTokenSamples: 110,
      decodeSpeedSamples: 110,
      prefillTokens: 420_000,
      prefillS: 510,
      decodeS: 2_100,
      prefillSpeedSamples: 110,
      cacheHitRate: 0.56,
      cacheRateSamples: 100,
      expertCacheHitRate: null,
      expertCacheSamples: 0,
    },
    groups: [{ route: 'chat', clientId: 'strata-manager', requests: 98, succeeded: 94 }],
    ttftS: { samples: 100, p50: 0.42, p95: 1.1, mean: 0.51 },
    durationS: { samples: 100, p50: 4.2, p95: 18.6, mean: 5.8 },
    decodeTokS: { samples: 100, p50: 44.2, p95: 58.1, mean: 45.6 },
    prefillTokS: { samples: 100, p50: 880, p95: 1200, mean: 910 },
    retentionDays: 14,
    successRateDefinition: 'succeeded / requests',
    tokenDefinition: 'provider reported',
  };

  const usageCoverage: ApiAnalyticsCoverage = {
    sessions: [],
    gaps: [],
    observerStatuses: [{
      serviceId: profile.id,
      sessionId: 'mock-session',
      pid: process.pid ?? null,
      updatedAtMs: Date.now() - 5_000,
      supported: true,
      journalWriteFailed: false,
      observerActive: true,
      heartbeatFresh: true,
      error: null,
    }],
    journalPresent: true,
    metadataOnly: true,
    dataAvailableFromMs: dayStart.getTime(),
    collectionScope: ['http'],
    historyRetentionDays: 14,
    journalRetentionDays: 7,
    journalMaxEvents: 100_000,
  };

  return {
    profile,
    health,
    metric,
    process,
    tasks,
    backgroundHealth,
    online: state !== 'stopped',
    connecting: false,
    stopped: state === 'stopped',
    profiles: [
      { id: profile.id, name: profile.name, configPath: profile.configPath, managed: true },
      { id: 'mock-profile-coder', name: 'Qwen3.8-Flash-Next Coder IQ1_M', configPath: '/home/dev/strata/configs/coder-iq1_m.json', managed: true },
      { id: 'mock-profile-vl', name: 'Swift-Qwen3.8-Flash-Next IQ3_XXS', configPath: '/home/dev/strata/configs/swift-iq3_xxs.json', managed: true },
    ],
    desktop: true,
    tasksLoading: false,
    usageSummary,
    usageCoverage,
    pillState: state === 'stopped' ? 'disconnected' : state,
    pillLabel: state === 'generating' ? '生成中 · 46.8 tok/s' : state === 'stopped' ? '已停止' : '空闲',
    pillLabelEn: state === 'generating' ? 'Generating · 46.8 tok/s' : state === 'stopped' ? 'Stopped' : 'Idle',
  };
}

/** Engine output for the loading mock (this session only). */
export const LOADING_MOCK_LOGS: string[] = [
  'strata serve: layer split: layers 0-23 -> GPU 0, layers 24-47 -> GPU 1',
  'strata serve: loading experts: 112/512 (21.9%)',
  'strata serve: loading experts: 236/512 (46.1%)',
  'strata serve: KV streaming: 2 GPUs, 1048576 context',
  'strata serve: still starting (20 s)',
];

/** Xiaohongshu feedback (2× RTX 2080 Ti 22 GB): the picked model is still loading. */
function loadingMock(base: ReturnType<typeof baseOverviewMock>): OverviewMock {
  const gb = (n: number) => n * 1024 ** 3;
  const startedAt = Date.now() - 22_000;
  const profile: ServiceProfile = { ...base.profile, name: 'Qwen3.8-Flash-Next-refusal-Q4kxl', configPath: 'C:/Strata/configs/qwen3.8-flash-next-AP-1m.json' };
  const health: JsonObject = { loaded: false, model: 'qwen3.8-flash-next-AP-1m', images: false, api_key: false, max_context: 1048576 };
  const gpus = [{ index: 0, util: 0, mem_used: gb(1.5), mem_total: gb(22), temp: 41, power: 58 }, { index: 1, util: 33, mem_used: gb(2), mem_total: gb(22), temp: 37, power: 41 }];
  const raw: JsonObject = {
    ...base.metric.raw,
    live: { state: 'loading', queued: 0, running: 0 },
    engine: { model: health.model, max_context: 1048576 },
    requests: [],
    hardware: { ...(base.metric.raw.hardware as JsonObject), gpus, gpu_util: 33, gpu_mem_used: gb(3.5), gpu_mem_total: gb(44), gpu_temp: 41, gpu_power: 99, gpu_power_limit: 250, gpu_pcie_gen: 3, gpu_pcie_gen_max: 3, cpu: 18, ram_used: gb(40.5), ram_total: gb(64) },
    hardware_static: { gpu_name: 'NVIDIA GeForce RTX 2080 Ti', cores: 8, threads: 16, psutil: true },
    conversation_cache: { enabled: false },
  };
  const metric: MetricSnapshot = { ...base.metric, state: 'loading', model: String(health.model), decodeTokS: null, prefillTokS: null, gpuUtil: 33, gpuMemoryUsed: gb(3.5), gpuMemoryTotal: gb(44), gpuTemperature: 41, gpuPower: 99, cpuUtil: 18, ramUsed: gb(40.5), ramTotal: gb(64), queued: 0, running: 0, requests: [], raw };
  const process: ProcessStatus = { ...base.process, pid: 9780, startedAt, creationTime: new Date(startedAt).toISOString() };
  return {
    ...base,
    profile, health, metric, process, tasks: [] as TaskStatus[],
    backgroundHealth: { ...base.backgroundHealth, loaded: false, observerState: 'idle', pid: 9780 } as BackgroundHealthSnapshot,
    profiles: [{ id: profile.id, name: profile.name, configPath: profile.configPath, managed: true }, ...base.profiles.slice(1)],
    pillState: 'loading' as const, pillLabel: '加载中', pillLabelEn: 'Loading',
    /** The startup card the app shows above the running card while a start is pending. */
    startup: { phase: 'loading' as const, startedAt, apiUrl: profile.baseUrl, modelName: profile.name, logs: LOADING_MOCK_LOGS.map((message, index) => ({ timestamp: startedAt + 2_000 + index * 4_000, level: 'engine', message })) },
    /** Transient polling failures a slow cold load produces before the API answers. */
    errors: { health: 'HTTP 请求失败：error sending request for url (http://127.0.0.1:8080/health): connection refused', metrics: 'operation timed out' },
  };
}

export type OverviewMockBundle = ReturnType<typeof buildOverviewMock>;
