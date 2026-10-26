/**
 * DEV-only analytics client for the API usage page, used with ?mockData=1.
 * Add `usageMock=empty` to the query string for the no-data state.
 */
import type { ApiAnalyticsClient, ApiAnalyticsCoverage, ApiAnalyticsQuery, ApiOutcome, ApiRoute, ApiTrendBucket, ApiUsageRequest, ApiUsageSummary } from '@strata-manager/core';

export function apiUsageMockEmpty(): boolean {
  if (typeof window === 'undefined') return false;
  try { return new URLSearchParams(window.location.search).get('usageMock') === 'empty' || /usageMock=empty/.test(window.location.hash); } catch { return false; }
}

/** Deterministic noise in [0, 1) so screenshots stay stable between runs. */
const wave = (index: number, seed: number) => { const x = Math.sin(index * 12.9898 + seed * 78.233) * 43758.5453; return x - Math.floor(x); };
const dayCurve = (hour: number) => hour < 8 ? 0.05 : hour < 10 ? 0.5 : hour < 12 ? 1 : hour < 14 ? 0.55 : hour < 18 ? 0.9 : hour < 22 ? 0.7 : 0.3;
const clients = ['claude-code', 'cursor', 'codex', 'strata-manager', null] as const;
const models = ['Qwen3.8-Flash-Next IQ2_XXS', 'Qwen3.8-Flash-Next Coder IQ1_M'] as const;
const routes: ApiRoute[] = ['anthropic', 'chat', 'responses', 'chat', 'chat'];

function buckets(query: ApiAnalyticsQuery, empty: boolean): ApiTrendBucket[] {
  const bucketMs = query.bucketMs ?? 900_000, start = query.startMs ?? Date.now() - 86_400_000, end = query.endMs ?? Date.now();
  const first = Math.floor(start / bucketMs) * bucketMs, items: ApiTrendBucket[] = [];
  let index = 0;
  for (let at = first; at < end; at += bucketMs, index++) {
    const hourOfDay = new Date(at).getHours();
    const level = empty ? 0 : dayCurve(hourOfDay) * (bucketMs / 900_000);
    const covered = Math.max(0, Math.min(1, (end - at) / bucketMs));
    const requests = Math.round(level * covered * (4 + wave(index, 0.4) * 8));
    const active = requests > 0;
    const failed = active && index % 9 === 0 ? 1 : 0, cancelled = active && index % 13 === 0 ? 1 : 0, interrupted = active && index % 29 === 0 ? 1 : 0;
    const succeeded = Math.max(0, requests - failed - cancelled - interrupted);
    items.push({
      startMs: at, requests, succeeded, failed, cancelled, interrupted, pending: 0,
      inputTokens: requests ? requests * Math.round(2600 + wave(index, 2) * 3200) : null, outputTokens: requests ? requests * Math.round(360 + wave(index, 3) * 520) : null,
      inputTokenSamples: requests, outputTokenSamples: requests,
      firstTokenS: requests ? 0.32 + wave(index, 4) * 0.5 : null, firstTokenSamples: requests,
      durationS: requests ? 3.1 + wave(index, 5) * 6 : null, durationSamples: requests,
      prefillTokS: requests ? 760 + wave(index, 6) * 320 : null, prefillSamples: requests,
      decodeTokS: requests ? 40 + wave(index, 7) * 10 : null, decodeSamples: requests,
      cacheHitRate: requests ? 0.42 + wave(index, 8) * 0.3 : null, cacheRateSamples: requests,
      expertCacheHitRate: requests ? 0.7 + wave(index, 9) * 0.2 : null, expertCacheSamples: requests,
    });
  }
  return items;
}

function sum(items: ApiTrendBucket[], key: keyof ApiTrendBucket) { return items.reduce((total, item) => total + ((item[key] as number | null) ?? 0), 0); }
function weighted(items: ApiTrendBucket[], key: keyof ApiTrendBucket, samples: keyof ApiTrendBucket) {
  const n = sum(items, samples); return n ? items.reduce((total, item) => total + ((item[key] as number | null) ?? 0) * (item[samples] as number), 0) / n : null;
}

function requests(query: ApiAnalyticsQuery, empty: boolean): ApiUsageRequest[] {
  if (empty) return [];
  const end = query.endMs ?? Date.now(), outcomes: ApiOutcome[] = ['succeeded', 'succeeded', 'succeeded', 'succeeded', 'failed', 'succeeded', 'succeeded', 'cancelled', 'succeeded', 'succeeded', 'succeeded', 'interrupted'];
  return Array.from({ length: 120 }, (_, index): ApiUsageRequest => {
    const outcome = outcomes[index % outcomes.length]!, started = end - 40_000 - index * 173_000 - (index * 37 % 53) * 1000;
    const ok = outcome === 'succeeded', input = 1200 + Math.round(wave(index, 1) * 7400), output = ok ? 120 + Math.round(wave(index, 2) * 1400) : outcome === 'failed' ? null : 40;
    return {
      requestId: `req_mock_${(9000 - index).toString(36)}`, serviceId: 'mock-profile-dev', startedAtMs: started, endedAtMs: started + 4000,
      route: routes[index % routes.length]!, clientId: clients[index % clients.length]!, outcome, httpStatus: outcome === 'failed' ? (index % 2 ? 500 : 400) : outcome === 'interrupted' ? null : 200,
      stream: index % 4 !== 1, inputTokens: input, outputTokens: output, cacheReadTokens: Math.round(input * 0.4),
      firstTokenS: outcome === 'failed' ? null : 0.3 + wave(index, 3) * 0.7, durationS: 2 + wave(index, 4) * 9,
      prefillTokS: 780 + wave(index, 5) * 300, decodeTokS: ok ? 39 + wave(index, 6) * 12 : null, cacheHitRate: 0.4 + wave(index, 7) * 0.4, expertCacheHitRate: 0.72 + wave(index, 8) * 0.18,
      errorKind: outcome === 'failed' ? (index % 2 ? 'engine_error' : 'context_overflow') : null, mcpToolCalls: index % 6 === 0 ? 2 : 0, inferenceRuns: index % 6 === 0 ? 3 : 1,
      modelId: index % 7 === 3 ? null : models[index % 3 === 0 ? 1 : 0]!,
    };
  }).filter(item => item.startedAtMs >= (query.startMs ?? 0) && item.startedAtMs < end);
}

export function createApiUsageMockClient(): ApiAnalyticsClient {
  const empty = apiUsageMockEmpty();
  return async (query) => {
    await new Promise(resolve => setTimeout(resolve, 60));
    const now = Date.now(), dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const coverage: ApiAnalyticsCoverage = {
      sessions: empty ? [] : [{ sessionId: 'mock-session', serviceId: 'mock-profile-dev', startedAtMs: dayStart.getTime(), endedAtMs: null, supported: true, sourceHash: 'mock' }],
      gaps: [], observerStatuses: [{ serviceId: 'mock-profile-dev', sessionId: 'mock-session', pid: 4242, updatedAtMs: now - 4000, supported: true, journalWriteFailed: false, observerActive: !empty, heartbeatFresh: !empty, error: null, observerMode: 'reviewed' }],
      journalPresent: !empty, metadataOnly: true, dataAvailableFromMs: empty ? null : now - 21 * 86_400_000,
      collectionScope: ['/v1/chat/completions', '/v1/responses', '/v1/messages'], historyRetentionDays: 90, journalRetentionDays: 7, journalMaxEvents: 100_000,
    };
    if (query.action === 'trends') return { data: { bucketMs: query.bucketMs ?? 900_000, buckets: buckets(query, empty) }, coverage };
    if (query.action === 'request_options') return { data: { clients: empty ? [] : ['claude-code', 'codex', 'cursor', 'strata-manager'], models: empty ? [] : [...models], unknownClient: !empty, unknownModel: !empty, truncated: false }, coverage };
    if (query.action === 'requests') {
      let items = requests(query, empty);
      if (query.clientId !== undefined && query.clientId !== '') items = items.filter(item => item.clientId === query.clientId);
      if (query.modelId !== undefined && query.modelId !== '') items = items.filter(item => item.modelId === query.modelId);
      if (query.outcome) items = items.filter(item => item.outcome === query.outcome);
      if (query.sort === 'oldest') items.reverse();
      const offset = query.cursor ? Number(query.cursor) : 0, limit = query.limit ?? 50, page = items.slice(offset, offset + limit);
      return { data: { items: page, nextCursor: offset + limit < items.length ? String(offset + limit) : null, snapshotRowId: 900, limit }, coverage };
    }
    if (query.action === 'export_csv') return { data: { path: query.path ?? '', rows: 120, rowLimit: 5000, snapshotRowId: 900 }, coverage };
    const items = buckets({ ...query, bucketMs: 900_000 }, empty);
    const total = sum(items, 'requests'), succeeded = sum(items, 'succeeded');
    const groupTotals = new Map<string, { route: ApiRoute; clientId: string | null; requests: number; succeeded: number }>();
    if (total) [[0.42, 0], [0.27, 1], [0.16, 2], [0.1, 3], [0.05, 4]].forEach(([share, index]) => { const requests = Math.round(total * share!); groupTotals.set(String(index), { route: routes[index!]!, clientId: clients[index!]!, requests, succeeded: Math.round(requests * 0.95) }); });
    const summary: ApiUsageSummary = {
      startMs: query.startMs ?? dayStart.getTime(), endMs: query.endMs ?? now,
      http: {
        requests: total, succeeded, failed: sum(items, 'failed'), cancelled: sum(items, 'cancelled'), interrupted: sum(items, 'interrupted'), pending: empty ? 0 : 1,
        inputTokens: total ? sum(items, 'inputTokens') : null, outputTokens: total ? sum(items, 'outputTokens') : null, cacheReadTokens: total ? Math.round(sum(items, 'inputTokens') * 0.41) : null, cacheCreationTokens: null,
        inputTokenSamples: total, outputTokenSamples: total, mcpToolCalls: empty ? 0 : 38, mcpToolFailures: empty ? 0 : 2,
        firstRequestAtMs: total ? items.find(item => item.requests)?.startMs ?? null : null, lastFinishedAtMs: total ? now - 40_000 : null, successRate: total ? succeeded / total : null,
      },
      inference: {
        runs: Math.round(total * 1.14), inputTokens: total ? sum(items, 'inputTokens') : null, outputTokens: total ? sum(items, 'outputTokens') : null, cacheReadTokens: total ? Math.round(sum(items, 'inputTokens') * 0.41) : null,
        toolCalls: empty ? 0 : 64, inputTokenSamples: total, decodeSpeedSamples: total, prefillTokens: total ? Math.round(sum(items, 'inputTokens') * 0.59) : null, prefillS: total ? Math.round(sum(items, 'inputTokens') * 0.59) / 910 : null, decodeS: null,
        prefillSpeedSamples: total, cacheHitRate: weighted(items, 'cacheHitRate', 'cacheRateSamples'), cacheRateSamples: total, expertCacheHitRate: weighted(items, 'expertCacheHitRate', 'expertCacheSamples'), expertCacheSamples: total,
      },
      groups: [...groupTotals.values()],
      ttftS: { samples: total, p50: total ? 0.48 : null, p95: total ? 1.26 : null }, durationS: { samples: total, p50: total ? 5.4 : null, p95: total ? 14.8 : null },
      decodeTokS: { samples: total, p50: total ? 44.6 : null, p95: total ? 51.2 : null, mean: weighted(items, 'decodeTokS', 'decodeSamples'), p20: total ? 40.8 : null },
      prefillTokS: { samples: total, p50: total ? 910 : null, p95: total ? 1060 : null },
      retentionDays: 90, successRateDefinition: 'succeeded / requests', tokenDefinition: 'provider reported',
    };
    return { data: summary, coverage };
  };
}
