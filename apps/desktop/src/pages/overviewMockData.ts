/**
 * TEMPORARY DEV-only Overview mock.
 * Enable with ?mockData=1 | #mockData=1 | localStorage mockData=1
 * Optional state: ?mockData=generating (default idle)
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

export type OverviewMockState = 'idle' | 'generating' | 'stopped';

export function overviewMockEnabled(): boolean {
  if (typeof import.meta !== 'undefined' && import.meta.env?.DEV !== true) return false;
  if (typeof window === 'undefined') return false;
  try {
    const q = new URLSearchParams(window.location.search).get('mockData');
    if (q === '1' || q === 'idle' || q === 'generating' || q === 'stopped') return true;
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

export function buildOverviewMock(state: OverviewMockState = overviewMockState()) {
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

export type OverviewMockBundle = ReturnType<typeof buildOverviewMock>;
