import type { AppLanguage } from "@strata-manager/core";
import { useQuery } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowRight, ArrowUpFromLine, CheckCircle2, MessagesSquare } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { ApiUsageSummary, ServiceProfile } from '@strata-manager/core';
import { Metric, Panel } from '../components';
import { buildOverviewMock, overviewMockEnabled } from './overviewMockData';

export function OverviewUsage({ profile, language, desktop, onOpen }: { profile?: ServiceProfile; language: AppLanguage; desktop: boolean; onOpen: () => void }) {
  const zh = language === 'zh-CN';
  const mock = overviewMockEnabled();
  const usage = useQuery({ queryKey: ['overview-api', profile?.id], enabled: !mock && desktop && !!profile, refetchInterval: 8000, queryFn: () => {
    const endMs = Date.now() + 1; const date = new Date(endMs); date.setHours(0, 0, 0, 0);
    return core.analyticsQuery<ApiUsageSummary>({ action: 'summary', serviceId: profile!.id, startMs: date.getTime(), endMs });
  } });
  const mockBundle = mock ? buildOverviewMock() : null;
  const summary = mockBundle?.usageSummary ?? usage.data?.data;
  const coverage = mockBundle?.usageCoverage ?? usage.data?.coverage;
  const available = mock || (!!coverage && (coverage.dataAvailableFromMs !== null || coverage.observerStatuses.some(status => status.supported && status.observerActive && status.heartbeatFresh)));
  const format = (value: number | null | undefined, digits = 0) => value == null || !available ? '—' : value.toLocaleString(language, { maximumFractionDigits: digits });
  return <Panel className="overview-usage-panel" title={zh ? '今日 API 使用' : "Today's API usage"} action={<button className="text-button" onClick={onOpen}>{zh ? '统计详情' : 'Usage details'}<ArrowRight size={14}/></button>}>
    <div className="metrics-grid four"><Metric label={zh ? 'HTTP 请求' : 'HTTP requests'} value={format(summary?.http.requests)}><span className="overview-usage-glyph" aria-hidden="true"><MessagesSquare size={21}/></span></Metric><Metric label={zh ? '成功率' : 'Success rate'} value={format(summary?.http.successRate == null ? null : summary.http.successRate * 100, 1)} unit="%"><span className="overview-usage-glyph" aria-hidden="true"><CheckCircle2 size={21}/></span></Metric><Metric label={zh ? '输入 Token' : 'Input tokens'} value={format(summary?.http.inputTokens)}><span className="overview-usage-glyph blue" aria-hidden="true"><ArrowDownToLine size={21}/></span></Metric><Metric label={zh ? '输出 Token' : 'Output tokens'} value={format(summary?.http.outputTokens)}><span className="overview-usage-glyph purple" aria-hidden="true"><ArrowUpFromLine size={21}/></span></Metric></div>
    {!mock && usage.error && <p className="notice error" role="alert">{String(usage.error)}</p>}
  </Panel>;
}
