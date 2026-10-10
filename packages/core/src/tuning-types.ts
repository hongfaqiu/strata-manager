/** Only request-level PCIe and MTP parameters are measured automatically. */
export type TuningScene = 'chat' | 'code' | 'chinese';
export interface TuningStartRequest {
  scenes: TuningScene[];
  /** 2-4 interleaved A/B/A rounds; default 2. */
  rounds?: number;
  /** 128-1024 output tokens; default 512. A truncated response cannot pass quality. */
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
  reason: 'reproducibleGain' | 'noReliableGain' | 'qualityMismatch' | 'incomplete' | 'missingMetrics';
}
export interface TuningCandidate extends TuningParameters { id: string; evaluation?: TuningEvaluation }
export interface TuningJob {
  id: string;
  profileId: string;
  state: 'checking' | 'running' | 'canceling' | 'completed' | 'canceled' | 'failed' | 'interrupted' | 'applying' | 'applied' | 'rollingBack' | 'restored';
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
}
