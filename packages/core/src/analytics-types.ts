/** Metadata-only API usage; HTTP boundaries differ from engine runs/MCP work. */
export type ApiRoute = 'chat' | 'responses' | 'anthropic' | 'token_count';
export type ApiOutcome = 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export interface ApiAnalyticsQuery {
  action?: 'summary' | 'recent' | 'trends' | 'requests' | 'request_options' | 'export_csv';
  startMs?: number; endMs?: number; serviceId?: string; limit?: number; bucketMs?: number;
  /** Empty means all; null selects unlabelled requests, not an empty string. */
  clientId?: string | null; modelId?: string | null; outcome?: ApiOutcome;
  sort?: 'newest' | 'oldest'; cursor?: string; snapshotRowId?: number;
  /** Native save dialog target. CSV is generated only from backend metadata. */
  path?: string;
}
export interface ApiDistribution {
  samples: number; p50: number | null; p95: number | null;
  /** Optional for compatibility with older analytics backends. */
  mean?: number | null; p20?: number | null;
}
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
  prefillTokens: number | null; prefillS: number | null; decodeS: number | null;
  prefillSpeedSamples: number; cacheHitRate: number | null; cacheRateSamples: number;
  expertCacheHitRate: number | null; expertCacheSamples: number;
}
export interface ApiUsageGroup { route: ApiRoute; clientId: string | null; requests: number; succeeded: number }
export interface ApiUsageSummary {
  startMs: number; endMs: number; http: ApiHttpTotals; inference: ApiInferenceTotals;
  groups: ApiUsageGroup[]; ttftS: ApiDistribution; durationS: ApiDistribution; decodeTokS: ApiDistribution; prefillTokS: ApiDistribution;
  retentionDays: number; successRateDefinition: string; tokenDefinition: string;
}
export interface ApiUsageRequest {
  requestId: string; serviceId: string; startedAtMs: number; endedAtMs: number | null;
  route: ApiRoute; clientId: string | null; outcome: ApiOutcome; httpStatus: number | null;
  stream: boolean | null; inputTokens: number | null; outputTokens: number | null;
  cacheReadTokens: number | null; firstTokenS: number | null; durationS: number | null;
  /** Mean of measured engine runs; cache ratio is token-weighted over known runs. */
  prefillTokS: number | null; decodeTokS: number | null; cacheHitRate: number | null;
  expertCacheHitRate: number | null;
  errorKind: string | null; mcpToolCalls: number; inferenceRuns: number;
  /** Older observer records have no verified model identity. */
  modelId: string | null;
}
export interface ApiRequestPage {
  items: ApiUsageRequest[]; nextCursor: string | null; snapshotRowId: number; limit: number;
}
export interface ApiRequestOptions {
  clients: string[]; models: string[]; unknownClient: boolean; unknownModel: boolean; truncated: boolean;
}
export interface ApiCsvExport {
  path: string; rows: number; rowLimit: number; snapshotRowId: number;
}
export interface ApiTrendBucket {
  startMs: number; requests: number; succeeded: number; failed: number; cancelled: number; interrupted: number; pending: number;
  inputTokens: number | null; outputTokens: number | null;
  inputTokenSamples: number; outputTokenSamples: number;
  /** Mean over known HTTP timings or engine-run speeds, never wall-time-derived. */
  firstTokenS: number | null; firstTokenSamples: number; durationS: number | null; durationSamples: number;
  prefillTokS: number | null; prefillSamples: number; decodeTokS: number | null; decodeSamples: number;
  cacheHitRate: number | null; cacheRateSamples: number; expertCacheHitRate: number | null; expertCacheSamples: number;
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
  /** reviewed = known hash; structural/partial = unreviewed source detected by structure; disabled = public endpoints only. */
  observerMode?: 'reviewed' | 'structural' | 'partial' | 'disabled' | null;
  capabilities?: Partial<Record<'core' | 'load_state' | 'expert_stats' | 'mcp', boolean>> | null;
}
export interface ApiAnalyticsCoverage {
  sessions: ApiObserverSession[]; gaps: ApiCollectionGap[]; observerStatuses: ApiObserverStatus[];
  journalPresent: boolean; metadataOnly: boolean; dataAvailableFromMs: number | null;
  journalSyncFailed?: boolean;
  collectionScope: string[]; historyRetentionDays: number; journalRetentionDays: number; journalMaxEvents: number;
}
export type ApiAnalyticsData = ApiUsageSummary | ApiUsageRequest[] | ApiUsageTrends | ApiRequestPage | ApiRequestOptions | ApiCsvExport;
export interface ApiAnalyticsResult<T = ApiAnalyticsData> { data: T; coverage: ApiAnalyticsCoverage }
export type ApiAnalyticsClient = (query: ApiAnalyticsQuery) => Promise<ApiAnalyticsResult<unknown>>;
