import { normalizeError } from './errors';
import type { LocalCandidate, ProcessStatus, ServiceProfile } from './types';

export interface ServiceSelection {
  selectedId: string;
  runningOwnedIds: string[];
  hasRunningService: boolean;
  automaticStartAllowed: boolean;
  statusErrors?: string[];
}

/** Restore selection from observed state, without registering or starting anything. */
export async function restoreServiceSelection(
  profiles: ServiceProfile[],
  savedActiveId: string | null | undefined,
  serviceStatus: (profile: ServiceProfile) => Promise<ProcessStatus>,
  discover?: () => Promise<LocalCandidate[]>,
): Promise<ServiceSelection> {
  // Wrap each call in an async function so synchronous reader failures also settle
  // independently, and one failure never prevents checking the other services.
  const results = await Promise.allSettled(profiles.map(async profile => serviceStatus(profile)));
  const statusErrors: string[] = [];
  const runningOwnedIds: string[] = [];
  let hasRunningService = false;
  let allConfirmedStopped = true;
  for (const [index, result] of results.entries()) {
    const profile = profiles[index]!;
    if (result.status === 'rejected') {
      statusErrors.push(`${profile.id}: ${normalizeError(result.reason).message}`);
      allConfirmedStopped = false;
      continue;
    }
    const status = result.value;
    if (status?.running === true) hasRunningService = true;
    if (!status || typeof status.running !== 'boolean' || typeof status.owned !== 'boolean') {
      statusErrors.push(`${profile.id}: invalid service status`);
      allConfirmedStopped = false;
      continue;
    }
    const reportedId = (status as ProcessStatus & { profileId?: unknown }).profileId;
    if (reportedId !== undefined && reportedId !== profile.id) {
      statusErrors.push(`${profile.id}: mismatched service identity`);
      allConfirmedStopped = false;
      continue;
    }
    if (!status.running) continue;
    allConfirmedStopped = false;
    if (profile.managed && status.owned === true && status.external !== true && !runningOwnedIds.includes(profile.id)) runningOwnedIds.push(profile.id);
  }
  let selectedId = '';
  if (runningOwnedIds.length === 1) selectedId = runningOwnedIds[0]!;
  else if (runningOwnedIds.length > 1) selectedId = savedActiveId && runningOwnedIds.includes(savedActiveId) ? savedActiveId : '';
  else selectedId = profiles.find(profile => profile.id === savedActiveId)?.id ?? profiles[0]?.id ?? '';

  let discoveryConfirmedIdle = false;
  // Already-running owned services prevent automatic starts. Discovery is then
  // unnecessary for restoring the active selection and is left to the observer.
  if (!runningOwnedIds.length && discover) {
    try {
      const candidates = await discover();
      if (!Array.isArray(candidates) || candidates.some(candidate => !candidate || typeof candidate !== 'object' || candidate.running !== undefined && typeof candidate.running !== 'boolean')) {
        statusErrors.push('discovery: invalid discovery result');
      } else {
        const running = candidates.some(candidate => candidate.running === true);
        hasRunningService ||= running;
        discoveryConfirmedIdle = !running;
      }
    } catch (error) {
      statusErrors.push(`discovery: ${normalizeError(error).message}`);
    }
  }
  const selected = profiles.find(profile => profile.id === selectedId);
  return {
    selectedId, runningOwnedIds, hasRunningService,
    automaticStartAllowed: selected?.managed === true && allConfirmedStopped && discoveryConfirmedIdle && !statusErrors.length && !hasRunningService,
    ...(statusErrors.length ? { statusErrors } : {}),
  };
}
