import { useQuery } from '@tanstack/react-query';
import * as core from '@strata-manager/core';
import type { ServiceProfile } from '@strata-manager/core';

const capacity = (value: unknown): number | null => {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 && number <= 2147483647 ? number : null;
};

/** Read configuration without starting a stopped service; a loaded service is authoritative. */
export function useBenchmarkContext(profile: ServiceProfile | undefined, online: boolean) {
  const local = core.isDesktop() && !!profile?.configPath;
  const config = useQuery({
    queryKey: ['startup-config', profile?.id, profile?.configPath],
    queryFn: () => core.readConfigSnapshot(profile!),
    enabled: !!profile && local,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const health = useQuery({
    queryKey: ['benchmark-context', profile?.id, profile?.baseUrl],
    queryFn: () => core.request(profile!, '/health'),
    enabled: !!profile && online,
    retry: false,
    refetchInterval: online ? 15000 : false,
    refetchOnWindowFocus: true,
  });
  let configured: number | null = null;
  if (config.data) {
    try { configured = capacity(core.startupTuningOf(config.data.config).context); } catch { /* Invalid configuration stays unknown. */ }
  }
  const loaded = health.data?.service === 'strata' && health.data.status === 'ok' && health.data.loaded === true;
  const runtime = online && loaded && !health.isError ? capacity(health.data?.max_context) : null;
  const maxContext = !profile ? null : online ? runtime : configured;
  const loading = !!profile && (online ? health.isPending : local && config.isPending);
  const error = !profile || loading || maxContext !== null ? ''
    : online ? '无法核验当前模型的上下文上限，请检查服务状态。'
    : local ? '当前配置未提供有效的上下文上限。' : '模型就绪后可读取上下文上限。';
  return { maxContext, loading, error };
}
