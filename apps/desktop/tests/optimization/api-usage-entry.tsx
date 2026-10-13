import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ApiAnalyticsQuery, ApiAnalyticsClient, ApiUsageSummary, ApiTrendBucket, JsonObject } from '@strata-manager/core';
import { ApiUsagePage } from '../../src/pages/ApiUsagePage';
import '../../src/i18n';
import '../../src/styles.css';
import '../../src/official/tokens.css';
import '../../src/official/components.css';
import '../../src/official-controls.css';
import '../../src/official-alignment.css';
import '../../src/official/scoped-components.css';
import '../../src/official/scoped-app.css';
import '../../src/official/api-monitor.css';
import '../../src/official-pages.css';

const state = { calls: [] as ApiAnalyticsQuery[], fail: false, empty: false, legacy: false, delay: 40 };
let onCall: (() => void) | undefined;
Object.assign(window, { __apiFixture: state });
const coverage = { sessions: [], gaps: [], observerStatuses: [{ serviceId: 'fixture', sessionId: 'sample', pid: 10, updatedAtMs: Date.now(), supported: true, journalWriteFailed: false, observerActive: true, heartbeatFresh: true, error: null }], journalPresent: true, metadataOnly: true, dataAvailableFromMs: Date.now() - 7 * 86400000, collectionScope: ['/v1/chat/completions', '/v1/responses'], historyRetentionDays: 90, journalRetentionDays: 3, journalMaxEvents: 100000 };
const distribution = (mean: number, p50: number, p20: number, p95: number) => ({ samples: state.empty ? 0 : 682, p50: state.empty ? null : p50, p95: state.empty ? null : p95, ...(state.legacy ? {} : { mean: state.empty ? null : mean, p20: state.empty ? null : p20 }) });
const onQuery: ApiAnalyticsClient = async query => {
  state.calls.push(query);
  onCall?.();
  await new Promise(resolve => setTimeout(resolve, state.delay));
  if (state.fail) throw new Error('隔离验收：模拟后台暂时不可用');
  const startMs = query.startMs!, endMs = query.endMs!;
  if (query.action === 'summary') {
    const zero = (value: number) => state.empty ? 0 : value;
    const value = (value: number) => state.empty ? null : value;
    const summary: ApiUsageSummary = { startMs, endMs,
      http: { requests: zero(682), succeeded: zero(676), failed: zero(2), cancelled: zero(3), interrupted: zero(1), pending: 0, inputTokens: value(48200121), outputTokens: value(2104800), cacheReadTokens: value(47477380), cacheCreationTokens: null, inputTokenSamples: zero(678), outputTokenSamples: zero(678), mcpToolCalls: zero(21), mcpToolFailures: 0, firstRequestAtMs: state.empty ? null : startMs + 10000, lastFinishedAtMs: state.empty ? null : endMs - 1000, successRate: value(676 / 682) },
      inference: { runs: zero(708), inputTokens: value(48200121), outputTokens: value(2143890), cacheReadTokens: value(47477380), toolCalls: zero(26), inputTokenSamples: zero(708), decodeSpeedSamples: zero(682), prefillTokens: value(722741), prefillS: value(360), decodeS: value(23753), prefillSpeedSamples: zero(682), cacheHitRate: value(.985), cacheRateSamples: zero(708), expertCacheHitRate: value(.864), expertCacheSamples: zero(682) },
      groups: state.empty ? [] : [{ route: 'chat', clientId: 'VS Code', requests: 401, succeeded: 397 }, { route: 'responses', clientId: '本机助手', requests: 281, succeeded: 279 }], ttftS: distribution(1.22, .64, .4, 3.86), durationS: distribution(34.5, 18.2, 12, 103.4), decodeTokS: distribution(94.6, 86.6, 62.2, 123.8), prefillTokS: distribution(2180, 1924, 1270, 3890), retentionDays: 90, successRateDefinition: '', tokenDefinition: '' };
    return { data: summary, coverage };
  }
  if (query.action === 'trends') {
    const bucketMs = query.bucketMs!;
    const buckets: ApiTrendBucket[] = Array.from({ length: Math.ceil((endMs - startMs) / bucketMs) }, (_, index) => {
      const active = !state.empty && index % 18 > 3 && index % 18 < 17;
      const requests = active ? 3 + Math.round((Math.sin(index * .75) + 1) * 6) : 0;
      const speed = active ? 84 + Math.sin(index * 1.2) * 17 + (index % 4) * 3 : null;
      return { startMs: startMs + index * bucketMs, requests, succeeded: requests, failed: 0, cancelled: 0, interrupted: 0, pending: 0, inputTokens: active ? requests * 28000 : null, outputTokens: active ? requests * 1200 : null, inputTokenSamples: requests, outputTokenSamples: requests, firstTokenS: active ? .5 + (index % 12 === 0 ? 3.5 : .2 * Math.sin(index)) : null, firstTokenSamples: requests, durationS: active ? 20 + (index % 13 === 0 ? 95 : 4 * Math.sin(index)) : null, durationSamples: requests, prefillTokS: active ? 1950 + Math.sin(index) * 480 : null, prefillSamples: requests, decodeTokS: speed, decodeSamples: requests, cacheHitRate: active ? .97 + Math.cos(index) * .017 : null, cacheRateSamples: requests, expertCacheHitRate: active ? .85 + Math.sin(index) * .08 : null, expertCacheSamples: requests };
    });
    return { data: { bucketMs, buckets }, coverage };
  }
  if (query.action === 'request_options') return { data: { clients: ['VS Code', '本机助手'], models: ['示例模型'], unknownClient: false, unknownModel: false, truncated: false }, coverage };
  if (query.action === 'requests') return { data: { items: state.empty ? [] : [{ requestId: 'sample-request', serviceId: 'fixture', startedAtMs: endMs - 120000, endedAtMs: endMs - 100000, route: 'chat', clientId: 'VS Code', modelId: '示例模型', outcome: 'succeeded', httpStatus: 200, stream: true, inputTokens: 28000, outputTokens: 1820, cacheReadTokens: 27000, firstTokenS: .6, durationS: 20, prefillTokS: 1950, decodeTokS: 94.6, cacheHitRate: .985, expertCacheHitRate: .864, errorKind: null, mcpToolCalls: 0, inferenceRuns: 1 }], nextCursor: null, snapshotRowId: 1, limit: 50 }, coverage };
  return { data: { path: 'fixture.csv', rows: 1, rowLimit: 5000, snapshotRowId: 1 }, coverage };
};
const raw: JsonObject = { engine: { max_context: 131072 }, live: { state: 'generating', running: 1, waiting: 0, queued: 0, parallel: 2, slots: [{ slot: 0, state: 'decoding', prompt_tokens: 28000, generated: 821, held_tokens: 0, tok_s: 94.6, elapsed_s: 12.6 }, { slot: 1, state: 'reading', prompt_tokens: 42000, prompt_read: 21000, prompt_total: 42000, generated: 0, held_tokens: 0, tok_s: null, elapsed_s: 3.4 }] }, hardware: { cpu: 42.6, ram_used: 32 * 1073741824, ram_total: 64 * 1073741824, gpu_util: 87, gpu_mem_used: 26.8 * 1073741824, gpu_mem_total: 32 * 1073741824 }, history: { cpu: [20, 31, 25, 45, null, 63, 41, 39, 42.6], gpu_util: [70, 89, 91, 82, 86, 92, 87], ram_used: [31, 31.5, 32, 32.1, 31.8, 32].map(value => value * 1073741824), gpu_mem_used: [26.1, 26.5, 26.8, 26.7, 26.8].map(value => value * 1073741824) } };
function Fixture() {
  const [language, setLanguage] = useState<'zh-CN' | 'en'>('zh-CN');
  const [stopped, setStopped] = useState(false);
  const [calls, setCalls] = useState(0);
  useEffect(() => { onCall = () => setCalls(state.calls.length); return () => { onCall = undefined; }; }, []);
  return <main className="official-surface" style={{ padding: '16px 20px', maxWidth: 1600, margin: 'auto' }}><div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, fontSize: 12, color: 'var(--st-ink-muted)', flexWrap: 'wrap' }}><span>隔离验收数据 · 不连接或启动模型服务</span><button onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; }}>切换主题</button><button onClick={() => setLanguage(value => value === 'zh-CN' ? 'en' : 'zh-CN')}>中 / EN</button><button onClick={() => setStopped(value => !value)}>切换服务状态</button><details><summary>异常状态验收</summary><div><output data-testid="query-count">读取次数 {calls}</output><button onClick={() => { state.fail = true; }}>模拟失败</button><button onClick={() => { state.empty = true; state.fail = false; }}>空统计</button><button onClick={() => { state.legacy = true; state.empty = false; state.fail = false; }}>旧后台</button><button onClick={() => { state.legacy = false; state.empty = false; state.fail = false; }}>恢复数据</button></div></details></div><ApiUsagePage language={language} profileId="fixture" profileName="示例本机服务" desktop onQuery={onQuery} live={{ raw, sampledAt: Date.now(), stopped }} onOpenDiagnostics={() => alert('隔离诊断入口')}/></main>;
}
const fixtureRoot = import.meta.hot?.data.fixtureRoot ?? createRoot(document.getElementById('root')!);
if (import.meta.hot) import.meta.hot.data.fixtureRoot = fixtureRoot;
fixtureRoot.render(<Fixture/>);
