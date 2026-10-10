import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Copy } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { ApiUsageSummary, ServiceProfile } from '@strata-manager/core';
import { Metric, Panel } from '../components';

export function OverviewUsage({ profile, language, desktop, onOpen, onCopy }: { profile: ServiceProfile; language: 'zh-CN' | 'en'; desktop: boolean; onOpen: () => void; onCopy: (text: string) => void }) {
  const zh = language === 'zh-CN';
  const usage = useQuery({ queryKey: ['overview-api', profile.id], enabled: desktop, refetchInterval: 8000, queryFn: () => {
    const endMs = Date.now() + 1; const date = new Date(endMs); date.setHours(0, 0, 0, 0);
    return core.analyticsQuery<ApiUsageSummary>({ action: 'summary', serviceId: profile.id, startMs: date.getTime(), endMs });
  } });
  const summary = usage.data?.data;
  const coverage = usage.data?.coverage;
  const available = !!coverage && (coverage.dataAvailableFromMs !== null || coverage.observerStatuses.some(status => status.supported && status.observerActive && status.heartbeatFresh));
  const format = (value: number | null | undefined, digits = 0) => value == null || !available ? '—' : value.toLocaleString(language, { maximumFractionDigits: digits });
  const endpoint = `${core.normalizeBaseUrl(profile.baseUrl)}/v1`;
  return <Panel title={zh ? '今日 API 使用' : "Today's API usage"} action={<button className="text-button" onClick={onOpen}>{zh ? '统计详情' : 'Usage details'}<ArrowRight size={14}/></button>}>
    <div className="metrics-grid four"><Metric label={zh ? 'HTTP 请求' : 'HTTP requests'} value={format(summary?.http.requests)}/><Metric label={zh ? '成功率' : 'Success rate'} value={format(summary?.http.successRate == null ? null : summary.http.successRate * 100, 1)} unit="%"/><Metric label={zh ? '输入 Token' : 'Input tokens'} value={format(summary?.http.inputTokens)}/><Metric label={zh ? '输出 Token' : 'Output tokens'} value={format(summary?.http.outputTokens)}/></div>
    <div className="overview-api-connection"><div><span>{zh ? '在客户端中使用本机模型' : 'Use this model in your API client'}</span><code>{endpoint}</code></div><button onClick={() => onCopy(endpoint)}><Copy size={14}/>{zh ? '复制 API 地址' : 'Copy API address'}</button></div>
    {coverage?.dataAvailableFromMs && <p className="subtle">{zh ? '采集始于' : 'Collection started'} {new Date(coverage.dataAvailableFromMs).toLocaleString(language)} · {zh ? '成功率不包含进行中的请求；统计不保存对话正文。' : 'Success rate excludes pending requests. Statistics do not store conversation content.'}</p>}
    {!available && <p className="subtle">{zh ? '受管服务开始采集后会显示实际用量。' : 'Actual usage appears after collection begins for the managed service.'}</p>}
    {usage.error && <p className="notice error" role="alert">{String(usage.error)}</p>}
  </Panel>;
}
