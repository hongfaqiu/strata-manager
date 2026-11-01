import { useQuery } from '@tanstack/react-query';
import * as core from '@strata-manager/core';
import type { ServiceProfile } from '@strata-manager/core';

/**
 * The engine build (BUILD.json runtimeVersion, never the release tag) of a profile's installation, from the detected runtimes.
 * Shares the ['runtime-installation'] query with the startup settings panel.
 */
export function useEngineVersion(profile: Pick<ServiceProfile, 'installDir'> | undefined, desktop: boolean): string | null {
  const installation = useQuery({ queryKey: ['runtime-installation'], queryFn: core.localRuntimeInstallation, enabled: desktop && !!profile?.installDir, retry: false, staleTime: 30000 });
  return installation.data?.detectedRuntimes?.find(runtime => core.installDirKey(runtime.installDir) === core.installDirKey(profile?.installDir))?.runtimeVersion ?? null;
}
