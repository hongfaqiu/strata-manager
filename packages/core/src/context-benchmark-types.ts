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
}
