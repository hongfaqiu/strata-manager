export type TuningScene = 'chat' | 'code' | 'chinese';
export type TuningUseCase = 'chat' | 'agent' | 'longDocument';
export type TuningWorkloadKind = 'coldInput' | 'hotPrefix' | 'sessionSwitch' | 'sustainedGeneration' | 'fullAgent' | 'longRetrieval' | 'vision';
export interface TuningRestartParameters {
  poolWorkers?: number;
  adaptAsync?: boolean;
  prefill?: number;
  vramReserveMib?: number;
  adaptEvery?: number;
  adaptSwaps?: number;
  adaptDecay?: number;
  /** MTP drafting on/off for the candidate; written as config "mtp": false / "drafting", needs an MTP draft layer. */
  mtp?: boolean;
}
export interface TuningStartRequest {
  /** Omit useCase for the historical short request diagnostic. */
  useCase?: TuningUseCase;
  contextLimit?: number;
  includeVision?: boolean;
  /** At most four independent restart candidates; omitted means none. */
  restartCandidates?: TuningRestartParameters[];
  scenes?: TuningScene[];
  /** 2-4 interleaved A/B/A rounds; default 2. */
  rounds?: number;
  /** Diagnostic: 128-1024, default 512. Full scenario: 1024. Truncation cannot pass. */
  maxTokens?: number;
  /** Optional expert candidates; omitted means a bounded neighboring search. */
  candidates?: { pcieFrac: number; specMinP: number }[];
}
export interface TuningParameters { pcieFrac: number; specMinP: number }
export interface TuningMeasurement {
  id: string;
  candidateId: string;
  scene: TuningScene;
  round: number;
  position: 'baselineBefore' | 'candidate' | 'baselineAfter';
  cacheMode: 'distinctPrompt' | 'repeatedPrefix';
  startedAt: number;
  wallMs: number;
  firstTokenMs: number | null;
  firstVisibleMs: number | null;
  decodeTokS: number | null;
  decodeMs: number | null;
  promptMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  finish: string | null;
  complete: boolean;
  qualityPassed: boolean;
  outputFingerprint: string | null;
  error?: string;
}
export interface TuningEvaluation {
  gain: number | null;
  drift: number | null;
  pairs: number;
  accepted: boolean;
  reason: 'reproducibleGain' | 'noReliableGain' | 'qualityMismatch' | 'incomplete' | 'missingMetrics'
    | 'fullScenarioGain' | 'noReliableFullScenarioGain' | 'incompleteWorkloads' | 'semanticQualityFailed'
    | 'missingWorkloadTimings' | 'stableSemanticGain' | 'noReliableGainBeyondDrift'
    | 'resourceUnknown' | 'insufficientResourceHeadroom';
}
export interface TuningResourceAssessment {
  status: 'checked' | 'unknown' | 'insufficientHeadroom';
  dataScope: 'systemAndPrimaryGpu';
  sampleCount: number;
  ramPeakBytes: number | null;
  gpuPeakBytes: number | null;
  ramTotalBytes: number | null;
  gpuTotalBytes: number | null;
  minimumRamHeadroomBytes: number;
  minimumGpuHeadroomBytes: number;
  note: string;
}
export interface TuningCandidate extends TuningParameters {
  id: string;
  kind?: 'request' | 'restart';
  restart?: TuningRestartParameters;
  resourceAssessment?: TuningResourceAssessment;
  startupVerification?: {
    parameters: {
      name: string;
      requested: number | boolean;
      observed: number | boolean | null;
      status: 'effective' | 'upperBound' | 'reservationRequest' | 'startupRequest';
    }[];
    checkedAt: number;
    note: string;
  };
  evaluation?: TuningEvaluation;
  dimensions?: Partial<Record<TuningWorkloadKind, TuningEvaluation>>;
}
export interface TuningResourcePeak {
  scope: 'workload';
  dataScope: 'systemAndPrimaryGpu';
  sampleCount: number;
  ramUsedBytes: number | null;
  gpuMemoryUsedBytes: number | null;
  telemetryAvailable: boolean;
}
/** Per-turn timing/usage metadata. Never contains a prompt, answer or tool body. */
export interface TuningWorkloadTurn {
  wallMs: number;
  firstTokenMs: number | null;
  firstVisibleMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  promptMs: number | null;
  decodeMs: number | null;
  decodeTokS: number | null;
  finish: string | null;
  complete: boolean;
}
export interface TuningWorkloadResult {
  benchmarkVersion: string;
  workloadId: string;
  useCase: TuningUseCase;
  kind: TuningWorkloadKind;
  qualityPassed: boolean;
  complete: boolean;
  wallMs: number;
  firstTokenMs: number | null;
  firstVisibleMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  actualContextTokens: number | null;
  requestCount: number;
  tokenCountRequests: number;
  finish: string | null;
  qualityReason: string | null;
  /** Static diagnostic only; never contains model-generated source/output. */
  qualityDetail?: string | null;
  qualityDiagnostic?: { stage: string; code: string; detail: string } | null;
  fullAgentWallMs: number | null;
  coldModelVerified: boolean;
  targetInputTokens: number | null;
  resourcePeak: TuningResourcePeak;
  turns: TuningWorkloadTurn[];
  limits: {
    maxGenerationRequests: number;
    deadlineSeconds: number;
    resourcesAreSampled: boolean;
    modelColdDoesNotProveOsCacheCold: boolean;
  };
}
export interface TuningWorkloadMeasurement {
  id: string;
  candidateId: string;
  round: number;
  position: TuningMeasurement['position'];
  workloadId: string;
  kind: TuningWorkloadKind;
  freshlyLoaded: boolean;
  result: TuningWorkloadResult;
}
export interface TuningProgress {
  phase: 'waitingForIdle' | 'loading' | 'baselineBefore' | 'candidate' | 'baselineAfter' | 'restoringBaseline' | 'finished';
  candidateId?: string;
  workloadKind?: TuningWorkloadKind;
  round?: number;
  completedWorkloads: number;
  totalWorkloads: number;
}
export interface TuningRecovery {
  state: 'notNeeded' | 'pending' | 'restoring' | 'restored' | 'failed';
  configurationRestored: boolean;
  serviceVerified: boolean;
  error?: string;
}
export interface TuningJob {
  id: string;
  profileId: string;
  state: 'checking' | 'running' | 'canceling' | 'completed' | 'canceled' | 'failed' | 'interrupted' | 'applying' | 'applied' | 'rollingBack' | 'restored';
  /** Absent in reports created before scenario tuning. */
  reportVersion?: number;
  scope?: 'fullScenario' | 'requestDiagnostic';
  useCase?: TuningUseCase;
  contextLimit?: number;
  includeVision?: boolean;
  restartBaseline?: TuningRestartParameters;
  workloadMeasurements?: TuningWorkloadMeasurement[];
  progress?: TuningProgress;
  recovery?: TuningRecovery;
  limits?: {
    maxDurationSeconds: number;
    generationRequestLimit: number;
    /** Output budget only; excludes reasoning, input and token-count calibration. */
    outputTokenUpperBound: number;
    recoveryDeadlineSeconds: number;
  };
  scenes: TuningScene[];
  rounds: number;
  maxTokens: number;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  completedRequests: number;
  totalRequests: number;
  currentStep: string;
  baseline: TuningParameters;
  candidates: TuningCandidate[];
  measurements: TuningMeasurement[];
  recommendedCandidateId: string | null;
  /** Hardware/model/version/config identity, without credentials or prompt/response text. */
  identity: Record<string, unknown>;
  configFingerprint: string;
  appliedConfigFingerprint?: string;
  error?: string;
  notes: string[];
  /** Sanitized, size-capped live log attached when the job ended (older reports have none). */
  liveLog?: TuningLiveLogLine[];
}

/** Quick calibration (upstream tools/calibrate.py), a request-level sweep through the running engine. */
export type CalibrationBackend = 'cuda' | 'hip' | 'sycl' | 'unknown';
export type CalibrationStepKind = 'warmup' | 'prefillPipe' | 'pcieFrac' | 'specMinP' | 'confirm';
export interface CalibrationParameters { pcieFrac: number; specMinP: number; prefillPipe?: number }
/** `rate` is the combined decode tok/s; with long answers in the mix, `short` and `long` are the two sides. */
export interface CalibrationSample { value: number; round: number; rate: number; short?: number; long?: number }
/** What a speed measurement is made of: general mixes short chats with a 512-token answer. */
export type CalibrationWorkload = 'general' | 'chat' | 'agent' | 'longDocument';
/** speed: combined rate only; balanced / memory: short and long answers may not get slower. */
export type CalibrationGoal = 'speed' | 'balanced' | 'memory';
export interface CalibrationRates { short?: number; long?: number }
/** A pcie_frac of -1 in steps, parameters and live snapshots means "left to the engine" (no --pcie-frac). */
export const PCIE_AUTO = -1;
export interface CalibrationStep {
  kind: CalibrationStepKind;
  status: 'pending' | 'running' | 'done' | 'skipped';
  /** decode = generation tok/s; prompt = prompt read tok/s. */
  metric: 'decode' | 'prompt';
  values: number[];
  currentValue?: number;
  rounds: number;
  requests: number;
  samples: CalibrationSample[];
  best?: number;
  chosen?: number;
  /** Values never measured, e.g. pcie_frac 0 on AMD (amdPcieZero) or an unconfirmed GPU. */
  excluded?: { value: number; reason: 'amdPcieZero' | 'unconfirmedGpuPcieZero' | string }[];
  skippedReason?: 'noLayerSplit' | 'contextTooSmall' | 'sameAsCurrent' | string;
}
export interface CalibrateRequest { rounds?: number; workload?: CalibrationWorkload; goal?: CalibrationGoal }
export interface CalibrationJob {
  id: string;
  profileId: string;
  kind: 'quickCalibrate';
  state: TuningJob['state'];
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  backend: CalibrationBackend;
  layerSplit: boolean;
  rounds: number;
  /** Relative gain a value needs over the current one, 0.03 like upstream. */
  minGain: number;
  /** Absent on reports from before one-click tuning (they measured short chats only). */
  workload?: CalibrationWorkload;
  goal?: CalibrationGoal;
  /** False: the config left --pcie-frac to the engine (baseline.pcieFrac is PCIE_AUTO). */
  pcieFlag?: boolean;
  /** The engine refines its own PCIe share when no --pcie-frac is set. */
  pcieAuto?: boolean;
  enginePcieFrac?: number;
  baseline: CalibrationParameters;
  candidate?: CalibrationParameters;
  recommended?: CalibrationParameters;
  /** Engine flags to write when applying, e.g. {"--pcie-frac": "0.35"}; null removes a flag; empty means keep. */
  settings: Record<string, string | null>;
  gain?: number;
  baseRate?: number;
  tunedRate?: number;
  baseRates?: CalibrationRates;
  tunedRates?: CalibrationRates;
  /** faster | autoPreferred | belowMinGain | shortRegressed | longRegressed | noData */
  verdict?: string;
  steps: CalibrationStep[];
  completedRequests: number;
  totalRequests: number;
  /** Official restart grids, ready for scenario verification restart candidates. */
  restartSuggestions: TuningRestartParameters[];
  identity: Record<string, unknown>;
  configFingerprint: string;
  error?: string;
  notes: string[];
  /** Sanitized, size-capped live log attached when the job ended (older reports have none). */
  liveLog?: TuningLiveLogLine[];
}
/** In-memory live progress of a running tuning or calibration job. */
/** One live log line: a message key plus metadata (parameter values, rates). Never prompt or answer text. */
export interface TuningLiveLogLine { at: number; key: string; detail: Record<string, unknown> | null }
export interface TuningLiveSnapshot {
  jobId: string;
  stepKey: string;
  stepIndex: number;
  stepTotal: number;
  parameters: Record<string, unknown>;
  round: number | null;
  rounds: number | null;
  completedUnits: number;
  totalUnits: number;
  runningSince: number;
  etaMs: number | null;
  request: { startedAt: number; deltas: number; firstTokenMs: number | null; tokS: number | null } | null;
  lastTokS: number | null;
  log: TuningLiveLogLine[];
  updatedAt: number;
}
