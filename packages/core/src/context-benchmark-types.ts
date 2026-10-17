import type { JsonObject } from './types';

export interface ContextBenchmarkOptions {
  /** Complete context capacities, including the output allowance. */
  tiers: number[];
  maxTokens: number;
  timeoutMs: number;
  rounds: number;
  stopOnError: boolean;
  configurationLabel?: string;
}

export interface ContextBenchmarkSample {
  /** First non-empty answer text; missing in older schema-3 history. */
  firstVisibleMs?: number | null;
  index: number;
  round: number;
  targetTokens: number;
  targetPromptTokens: number;
  model: string;
  state: 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  ttftMs: number | null;
  wallMs: number;
  inputChars: number;
  /** Calibration is metadata-only; actual generation usage remains authoritative. */
  tokenCountMethod: 'count_tokens' | 'estimated';
  countedPromptTokens: number | null;
  estimatedPromptTokens: number | null;
  calibrationReason?: string;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  prefillTokS: number | null;
  decodeTokS: number | null;
  /** Bytes, sampled across all GPUs/the whole host, never model-only allocation. */
  peakGpuMemory: number | null;
  minGpuMemoryFree: number | null;
  peakRam: number | null;
  resourceSamples: number;
  output: string;
  finishReason?: string;
  error?: string;
  errorCode?: string;
  httpStatus?: number | null;
}

export interface ContextBenchmarkSkippedTier {
  targetTokens: number;
  reason: string;
}

export interface ContextBenchmarkProgress {
  currentTier: number | null;
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
  active: 0 | 1;
  elapsedMs: number;
  sample?: ContextBenchmarkSample;
}

export interface ContextBenchmarkReport {
  /** Optional read-only provenance; older schema-3 reports remain valid. */
  identity?: import('./benchmark-comparison').BenchmarkIdentity;
  schemaVersion: 3;
  id: string;
  profileId: string;
  profileName: string;
  baseUrl: string;
  model: string;
  maxContext: number | null;
  startedAt: number;
  finishedAt: number;
  elapsedMs: number;
  options: ContextBenchmarkOptions;
  samples: ContextBenchmarkSample[];
  skippedTiers: ContextBenchmarkSkippedTier[];
  state: 'completed' | 'failed' | 'cancelled';
  stopReason: 'completed' | 'cancelled' | 'error' | 'modelChanged';
  resourceScope: 'system';
  resourceIntervalMs: 1000;
  hardware?: JsonObject;
  engine?: JsonObject;
  /** Content-free run trace kept for signed Arena run evidence: engine counters and a downsampled resource series. */
  evidence?: ContextBenchmarkEvidence;
}

/** Engine /metrics `totals` counters. */
export interface ContextBenchmarkCounters { requests: number; promptTokens: number; outputTokens: number }
export interface ContextBenchmarkEvidence {
  /** Counters before the first and after the last request; null when the engine does not report totals. */
  counters: { before: ContextBenchmarkCounters; after: ContextBenchmarkCounters } | null;
  /** Every resource sample of the run (count), bucketed into at most 120 steps: peak memory in GB, mean GPU utilization in %. */
  series: { count: number; stepMs: number; vramGB: (number | null)[]; ramGB: (number | null)[]; gpuUtil: (number | null)[] };
}
