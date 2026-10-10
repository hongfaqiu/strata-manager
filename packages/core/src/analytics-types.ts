/** Metadata-only API usage; HTTP boundaries differ from engine runs/MCP work. */
export type ApiRoute = 'chat' | 'responses' | 'anthropic' | 'token_count';
export type ApiOutcome = 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export interface ApiAnalyticsQuery {
  action?: 'summary' | 'recent' | 'trends';
  startMs?: number; endMs?: number; serviceId?: string; limit?: number; bucketMs?: number;
}
export interface ApiDistribution { samples: number; p50: number | null; p95: number | null }
export interface ApiHttpTotals {
  requests: number; succeeded: number; failed: number; cancelled: number; interrupted: number; pending: number;
  inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null;
  cacheCreationTokens: number | null; inputTokenSamples: number; outputTokenSamples: number;
  mcpToolCalls: number; mcpToolFailures: number; firstRequestAtMs: number | null;
  lastFinishedAtMs: number | null; successRate: number | null;
}
export interface ApiInferenceTotals {
  runs: number; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null;
  toolCalls: number; inputTokenSamples: number; decodeSpeedSamples: number;
}
export interface ApiUsageGroup { route: ApiRoute; clientId: string | null; requests: number; succeeded: number }
export interface ApiUsageSummary {
  startMs: number; endMs: number; http: ApiHttpTotals; inference: ApiInferenceTotals;
  groups: ApiUsageGroup[]; ttftS: ApiDistribution; durationS: ApiDistribution; decodeTokS: ApiDistribution;
  retentionDays: number; successRateDefinition: string; tokenDefinition: string;
}
export interface ApiUsageRequest {
  requestId: string; serviceId: string; startedAtMs: number; endedAtMs: number | null;
  route: ApiRoute; clientId: string | null; outcome: ApiOutcome; httpStatus: number | null;
  stream: boolean | null; inputTokens: number | null; outputTokens: number | null;
  cacheReadTokens: number | null; firstTokenS: number | null; durationS: number | null;
  errorKind: string | null; mcpToolCalls: number; inferenceRuns: number;
}
export interface ApiTrendBucket {
  startMs: number; requests: number; succeeded: number; failed: number; cancelled: number;
  inputTokens: number | null; outputTokens: number | null;
}
export interface ApiUsageTrends { bucketMs: number; buckets: ApiTrendBucket[] }
export interface ApiObserverSession {
  sessionId: string; serviceId: string; startedAtMs: number; endedAtMs: number | null;
  supported: boolean; sourceHash: string | null;
}
export interface ApiCollectionGap {
  firstSeq: number; lastSeq: number; observedAtMs: number;
  reason: 'journal_retention' | 'missing_sequence' | 'invalid_metadata';
}
export interface ApiObserverStatus {
  serviceId: string; sessionId: string | null; pid: number | null; updatedAtMs: number | null;
  supported: boolean; journalWriteFailed: boolean; observerActive: boolean; heartbeatFresh: boolean;
  error: 'unsupported_runtime' | 'journal_write_failed' | null;
}
export interface ApiAnalyticsCoverage {
  sessions: ApiObserverSession[]; gaps: ApiCollectionGap[]; observerStatuses: ApiObserverStatus[];
  journalPresent: boolean; metadataOnly: boolean; dataAvailableFromMs: number | null;
  collectionScope: string[]; historyRetentionDays: number; journalRetentionDays: number; journalMaxEvents: number;
}
export type ApiAnalyticsData = ApiUsageSummary | ApiUsageRequest[] | ApiUsageTrends;
export interface ApiAnalyticsResult<T = ApiAnalyticsData> { data: T; coverage: ApiAnalyticsCoverage }
export type ApiAnalyticsClient = (query: ApiAnalyticsQuery) => Promise<ApiAnalyticsResult<unknown>>;
