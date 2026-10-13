import { configurationPathKey, normalizeError, type LocalCandidate } from '@strata-manager/core';

function absolutePath(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const path = value.trim();
  if (!path || path.includes('\0')) return false;
  return path.startsWith('/') || /^[a-z]:[\\/]/i.test(path)
    || /^\\\\\?\\(?:[a-z]:\\|UNC\\[^\\]+\\[^\\]+(?:\\|$))/i.test(path)
    || /^\\\\[^\\/?]+[\\/][^\\/]+(?:[\\/]|$)/.test(path);
}

/** Choose only one unambiguous live instance after reading an empty backend. */
export function selectAutomaticService(
  candidates: LocalCandidate[],
  activeServices: number | undefined,
  blocked: boolean,
): LocalCandidate | undefined {
  if (blocked || activeServices !== 0) return;
  const running = new Map<string, LocalCandidate>();
  for (const candidate of candidates) {
    if (candidate.running !== true) continue;
    if (!Number.isSafeInteger(candidate.pid) || candidate.pid! <= 0 || candidate.pid! > 0xffffffff
      || !Number.isInteger(candidate.detectedPort) || candidate.detectedPort! <= 0 || candidate.detectedPort! > 65535
      || ![candidate.configPath, candidate.installDir, candidate.pythonPath].every(absolutePath)) return;
    const key = JSON.stringify([candidate.pid, configurationPathKey(candidate.configPath, candidate.installDir), candidate.detectedPort]);
    if (!running.has(key)) running.set(key, candidate);
  }
  if (running.size !== 1) return;
  return running.values().next().value;
}

/** Reconnect existing ownership first; never load an unknown unloaded model automatically. */
export async function automaticallyManageService<T>(
  candidate: LocalCandidate,
  connect: (candidate: LocalCandidate) => Promise<T>,
  manage: (candidate: LocalCandidate) => Promise<T>,
  readHealth: (candidate: LocalCandidate) => Promise<unknown>,
): Promise<T | undefined> {
  try { return await connect(candidate); }
  catch (error) {
    if (normalizeError(error).code !== 'RUNNING_OWNER_NOT_FOUND') throw error;
  }
  const value = await readHealth(candidate);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const health = value as Record<string, unknown>;
  if (health.service !== 'strata' || health.status !== 'ok' || health.loaded !== true || health.busy === true) return;
  return manage(candidate);
}
