import { useQuery } from '@tanstack/react-query';
import * as core from '@strata-manager/core';
import type { GpuOption } from './GpuSelector';

/** "NAME (24 GB)", or the bare name when the card reports no memory. */
export function gpuOptionsFromHardware(gpus: readonly { id: number; name: string; totalBytes?: number | null }[] | null | undefined): GpuOption[] {
  return (gpus ?? []).map(gpu => ({ id: gpu.id, name: typeof gpu.totalBytes === 'number' && gpu.totalBytes > 0 ? `${gpu.name} (${Math.round(gpu.totalBytes / 1024 ** 3)} GB)` : gpu.name }));
}

/** The cards this machine reports (the native hardware read behind the resource assessment); empty until known. */
export function useDetectedGpus(installationId: string | undefined, desktop: boolean): GpuOption[] {
  const query = useQuery({
    queryKey: ['detected-gpus', installationId], enabled: desktop && !!installationId, staleTime: 60_000, retry: false,
    queryFn: async () => gpuOptionsFromHardware((await core.assessSetupResources({ installationId: installationId!, family: 'unknown', quant: 'unknown', context: 32768, images: false, kv: 'f16', gpuIds: [], parallel: 1 })).hardware.gpus),
  });
  return query.data ?? [];
}
