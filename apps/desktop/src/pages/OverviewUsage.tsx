import { useQuery } from '@tanstack/react-query';
import * as core from '@strata-manager/core';
import type { ApiUsageSummary, ServiceProfile } from '@strata-manager/core';
import { buildOverviewMock, overviewMockEnabled } from './overviewMockData';

/** Today's API usage for the overview. Returns undefined while no observer coverage proves the numbers. */
export function useOverviewUsage(profile: ServiceProfile | undefined, desktop: boolean): { summary?: ApiUsageSummary; error?: string } {
  const mock = overviewMockEnabled();
  const usage = useQuery({ queryKey: ['overview-api', profile?.id], enabled: !mock && desktop && !!profile, refetchInterval: 8000, queryFn: () => {
    const endMs = Date.now() + 1; const date = new Date(endMs); date.setHours(0, 0, 0, 0);
    return core.analyticsQuery<ApiUsageSummary>({ action: 'summary', serviceId: profile!.id, startMs: date.getTime(), endMs });
  } });
  const mockBundle = mock ? buildOverviewMock() : null;
  const summary = mockBundle?.usageSummary ?? usage.data?.data;
  const coverage = mockBundle?.usageCoverage ?? usage.data?.coverage;
  const available = mock || (!!coverage && (coverage.dataAvailableFromMs !== null || coverage.observerStatuses.some(status => status.supported && status.observerActive && status.heartbeatFresh)));
  return { summary: available ? summary : undefined, error: !mock && usage.error ? String(usage.error) : undefined };
}
