import { configurationPathKey } from '@strata-manager/core';
import type { LocalCandidate, LocalInstallationDetails, ServiceProfile } from '@strata-manager/core';

export interface OverviewStartup {
  profile?: ServiceProfile;
  candidate?: LocalCandidate;
  lastActivatedAt?: number;
}

const complete = (...paths: string[]) => paths.every(path => path.trim().length > 0);
const activationTime = (value: number | null | undefined) => typeof value === 'number' && value > 0 && Number.isFinite(new Date(value).getTime()) ? value : undefined;

/** Recommend an existing configuration without registering or starting a service. */
export function selectOverviewStartup(
  profiles: ServiceProfile[],
  details: LocalInstallationDetails[] = [],
  candidates: LocalCandidate[] = [],
  lastUsedId?: string,
): OverviewStartup | undefined {
  const available = profiles.filter(profile => {
    if (!profile.managed || !complete(profile.installDir, profile.configPath, profile.pythonPath)) return false;
    const original = details.find(detail => detail.profileId === profile.id)?.originalConfigPath;
    const paths = [configurationPathKey(profile.configPath, profile.installDir)];
    if (original) paths.push(configurationPathKey(original, profile.installDir));
    return !candidates.some(candidate => candidate.availability === 'repair'
      && paths.includes(configurationPathKey(candidate.configPath, candidate.installDir)));
  });
  let recent: OverviewStartup | undefined;
  for (const profile of available) {
    const lastActivatedAt = activationTime(details.find(detail => detail.profileId === profile.id)?.lastActivatedAt);
    if (lastActivatedAt !== undefined && (!recent || lastActivatedAt > recent.lastActivatedAt!)) {
      recent = { profile, lastActivatedAt };
    }
  }
  if (recent) return recent;
  const profile = available.find(item => item.id === lastUsedId) ?? available[0];
  if (profile) return { profile };
  const usable = candidates.filter(candidate => candidate.availability !== 'repair'
    && complete(candidate.installDir, candidate.configPath, candidate.pythonPath, candidate.modelPath));
  const candidate = usable.find(item => item.running === true) ?? usable[0];
  return candidate ? { candidate } : undefined;
}
