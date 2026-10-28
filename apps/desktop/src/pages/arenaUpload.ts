import * as core from '@strata-manager/core';
import type { ArenaBuild, BenchmarkSuiteReport, ContextBenchmarkReport, OfficialBenchReport } from '@strata-manager/core';
import { version } from '../../package.json';

export const ARENA_EVENT = 'strata-arena-updated';
/** The native side replaces os/arch with its own build constants; these are only a first guess. */
export function arenaEnvironment() {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const os = /Windows/i.test(agent) ? 'windows' : /Mac OS X|Macintosh/i.test(agent) ? 'macos' : /Linux/i.test(agent) ? 'linux' : 'other';
  const arch = /arm64|aarch64/i.test(agent) ? 'aarch64' : 'x86_64';
  return { os, arch, appVersion: version };
}
export const arenaBuild = (report: ContextBenchmarkReport | BenchmarkSuiteReport): Promise<ArenaBuild> => core.buildArenaPayload(report, arenaEnvironment());
export const arenaOfficialBuild = (report: OfficialBenchReport): Promise<ArenaBuild> => core.buildOfficialArenaPayload(report, arenaEnvironment());
const isOfficial = (report: ContextBenchmarkReport | BenchmarkSuiteReport | OfficialBenchReport): report is OfficialBenchReport => (report as { kind?: string }).kind === 'official-bench';

/** Called after a finished benchmark is saved. Uploads only with current consent and auto-upload on; never throws. */
export async function arenaAfterBenchmark(report: ContextBenchmarkReport | BenchmarkSuiteReport | OfficialBenchReport): Promise<void> {
  if (!core.isDesktop()) return;
  try {
    const status = await core.arenaStatus();
    if (!status.consented || !status.autoUpload || status.consentVersion !== core.ARENA_CONSENT_VERSION) return;
    const built = isOfficial(report) ? await arenaOfficialBuild(report) : await arenaBuild(report);
    if ('skip' in built) return;
    await core.arenaEnqueue(built.payload);
  } catch { /* Arena uploads must never disturb the benchmark itself. */ }
  finally { window.dispatchEvent(new Event(ARENA_EVENT)); }
}
