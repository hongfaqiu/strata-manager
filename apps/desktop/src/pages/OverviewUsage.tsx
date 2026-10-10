import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { ApiUsageSummary, ServiceProfile } from '@strata-manager/core';
import { Metric, Panel } from '../components';

export function OverviewUsage({ profile, language, desktop, onOpen }: { profile?: ServiceProfile; language: 'zh-CN' | 'en'; desktop: boolean; onOpen: () => void }) {
  const zh = language === 'zh-CN';
  const usage = useQuery({ queryKey: ['overview-api', profile?.id], enabled: desktop && !!profile, refetchInterval: 8000, queryFn: () => {
    const endMs = Date.now() + 1; const date = new Date(endMs); date.setHours(0, 0, 0, 0);
    return core.analyticsQuery<ApiUsageSummary>({ action: 'summary', serviceId: profile!.id, startMs: date.getTime(), endMs });
  } });
  const summary = usage.data?.data;
  const coverage = usage.data?.coverage;
  const available = !!coverage && (coverage.dataAvailableFromMs !== null || coverage.observerStatuses.some(status => status.supported && status.observerActive && status.heartbeatFresh));
  const format = (value: number | null | undefined, digits = 0) => value == null || !available ? '—' : value.toLocaleString(language, { maximumFractionDigits: digits });
  return <Panel title={zh ? '今日 API 使用' : "Today's API usage"} action={<button className="text-button" onClick={onOpen}>{zh ? '统计详情' : 'Usage details'}<ArrowRight size={14}/></button>}>
    <div className="metrics-grid four"><Metric label={zh ? 'HTTP 请求' : 'HTTP requests'} value={format(summary?.http.requests)}/><Metric label={zh ? '成功率' : 'Success rate'} value={format(summary?.http.successRate == null ? null : summary.http.successRate * 100, 1)} unit="%"/><Metric label={zh ? '输入 Token' : 'Input tokens'} value={format(summary?.http.inputTokens)}/><Metric label={zh ? '输出 Token' : 'Output tokens'} value={format(summary?.http.outputTokens)}/></div>
    {usage.error && <p className="notice error" role="alert">{String(usage.error)}</p>}
  </Panel>;
}
