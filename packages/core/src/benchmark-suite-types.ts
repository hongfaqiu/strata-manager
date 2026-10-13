import type { BenchmarkSample, BenchmarkDistribution } from './benchmark';
import type { JsonObject } from './types';

export type BenchmarkScenarioId = 'short' | 'code' | 'long' | 'decode' | 'cache' | 'conversation' | 'custom';
export interface BenchmarkSuiteOptions {
  kind: 'suite' | 'stress';
  scenarios: BenchmarkScenarioId[];
  prompt: string;
  rounds: number;
  maxTokens: number;
  inputChars: number;
  conversationTurns: number;
  warmup: boolean;
  mode: 'unique' | 'repeat';
  timeoutMs: number;
  concurrency: number;
  stressPattern: 'steady' | 'ramp';
  stressLimit: 'requests' | 'duration';
  requestLimit: number;
  durationMs: number;
  stageDurationMs: number;
  requestDelayMs: number;
  stopOnError: boolean;
}
export interface BenchmarkSuiteSample extends BenchmarkSample {
  scenario: BenchmarkScenarioId;
  stage: number;
  concurrency: number;
  worker: number;
  conversationId: string | null;
  turn: number;
  inputChars: number;
  maxTokens: number;
  errorCode?: string;
  httpStatus?: number | null;
}
export interface BenchmarkTelemetry {
  at: number;
  elapsedMs: number;
  active: number;
  queued: number | null;
  running: number | null;
  cpuUtil: number | null;
  gpuUtil: number | null;
  gpuMemoryUsed: number | null;
  ramUsed: number | null;
  gpuTemperature: number | null;
}
export interface BenchmarkStage {
  index: number;
  concurrency: number;
  startedAt: number;
  finishedAt: number;
  elapsedMs: number;
}
export interface BenchmarkSuiteProgress {
  stageIndex: number;
  totalStages: number;
  concurrency: number;
  issued: number;
  completed: number;
  failed: number;
  cancelled: number;
  active: number;
  elapsedMs: number;
  sample?: BenchmarkSuiteSample;
  telemetry?: BenchmarkTelemetry;
}
export interface BenchmarkSuiteReport {
  schemaVersion: 2 | 3;
  identity?: import('./benchmark-comparison').BenchmarkIdentity;
  id: string;
  profileId: string;
  profileName: string;
  baseUrl: string;
  model: string;
  startedAt: number;
  finishedAt: number;
  elapsedMs: number;
  measurementElapsedMs: number;
  options: BenchmarkSuiteOptions;
  samples: BenchmarkSuiteSample[];
  stages: BenchmarkStage[];
  telemetry: BenchmarkTelemetry[];
  state: 'completed' | 'failed' | 'cancelled';
  stopReason: 'completed' | 'requestLimit' | 'duration' | 'cancelled' | 'error' | 'modelChanged';
  hardware?: JsonObject;
  engine?: JsonObject;
}
export interface BenchmarkSuiteDistribution extends BenchmarkDistribution { p99: number | null }
export interface BenchmarkSuiteSummary {
  completed: number;
  failed: number;
  cancelled: number;
  successRate: number | null;
  ttftMs: BenchmarkSuiteDistribution;
  wallMs: BenchmarkSuiteDistribution;
  prefillTokS: number | null;
  decodeTokS: number | null;
  cacheHitRate: number | null;
  requestsPerSecond: number | null;
  aggregateOutputTokS: number | null;
  outputTokens: number | null;
  timeoutCount: number;
  truncatedCount: number;
  errors: { code: string; status: number | null; count: number }[];
  peakQueue: number | null;
  peakGpuMemory: number | null;
  peakRam: number | null;
}
