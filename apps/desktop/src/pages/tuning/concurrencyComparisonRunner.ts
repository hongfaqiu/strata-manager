import * as core from '@strata-manager/core';
import type { ConcurrencyCandidate, ConcurrencyCandidateResult, ServiceProfile } from '@strata-manager/core';

/** Module-level so a run survives the Tuning page remounting while the active configuration switches. */
export interface ComparisonState {
  phase: 'idle' | 'saving' | 'switching' | 'measuring' | 'restoring' | 'done' | 'failed' | 'cancelled';
  baseProfileId?: string;
  candidates: ConcurrencyCandidate[];
  versions: Record<string, ServiceProfile>;
  results: ConcurrencyCandidateResult[];
  current?: string;
  stage?: { index: number; total: number; concurrency: number };
  error?: string;
  finishedAt?: number;
}
const STORE_KEY = 'concurrencyComparisonV1';
let state: ComparisonState = { phase: 'idle', candidates: [], versions: {}, results: [] };
const listeners = new Set<() => void>();
let controller: AbortController | null = null;
const set = (patch: Partial<ComparisonState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
export const comparisonSubscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const comparisonSnapshot = () => state;
export const comparisonRunning = () => ['saving', 'switching', 'measuring', 'restoring'].includes(state.phase);
/** Test seam. */
export function resetComparison(next: Partial<ComparisonState> = {}) { controller?.abort(); controller = null; state = { phase: 'idle', candidates: [], versions: {}, results: [], ...next }; listeners.forEach(listener => listener()); }

export async function loadComparison(baseProfileId: string) {
  if (comparisonRunning() || state.baseProfileId === baseProfileId && state.phase !== 'idle') return;
  const saved = await core.loadStore<unknown>(STORE_KEY, null).catch(() => null) as ComparisonState | null;
  if (saved && saved.baseProfileId === baseProfileId && Array.isArray(saved.results) && Array.isArray(saved.candidates)) set({ ...saved, phase: 'done' });
}

/** Saves each candidate as a new configuration version next to the base one; nothing is overwritten. */
export async function saveCandidateVersions(base: ServiceProfile, candidates: ConcurrencyCandidate[], now = new Date()): Promise<Record<string, ServiceProfile>> {
  set({ phase: 'saving', baseProfileId: base.id, candidates, results: [], error: undefined });
  try {
    const snapshot = await core.readConfigSnapshot(base);
    const versions: Record<string, ServiceProfile> = { ...(state.baseProfileId === base.id ? state.versions : {}) };
    for (const candidate of candidates) {
      if (versions[candidate.id]) continue;
      const next = core.applyConcurrencyEdits(snapshot.config, candidate.edits);
      core.validateStartupConfiguration(next);
      versions[candidate.id] = await core.copyConfiguration(base, core.concurrencyVersionName(base.configPath, candidate, now), next);
    }
    set({ phase: 'idle', versions });
    return versions;
  } catch (error) { set({ phase: 'failed', error: core.normalizeError(error).message }); throw error; }
}

async function waitReady(profile: ServiceProfile, signal: AbortSignal, timeoutMs = 15 * 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (signal.aborted) throw new Error('cancelled');
    try { const health = core.asObject(await core.request(profile, '/health')); if (health.loaded === true) return; } catch { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('timeout');
}

/** Restart-based comparison: switch to each saved version, run its ladder, then switch back to the base version. */
export async function runComparison(base: ServiceProfile, switchVersion: (profile: ServiceProfile) => Promise<void>, stageMs = 30_000) {
  if (comparisonRunning()) return;
  const abort = new AbortController(); controller = abort;
  const results: ConcurrencyCandidateResult[] = [];
  set({ phase: 'switching', results, error: undefined, finishedAt: undefined });
  try {
    for (const candidate of state.candidates) {
      if (abort.signal.aborted) break;
      const version = state.versions[candidate.id];
      if (!version) { results.push(core.concurrencyCandidateResult(candidate.id, [], 'not_saved')); continue; }
      set({ phase: 'switching', current: candidate.id, stage: undefined });
      try {
        await switchVersion(version);
        await waitReady(version, abort.signal);
        set({ phase: 'measuring' });
        const options = core.concurrencyLadderOptions(candidate.parallel, stageMs);
        const report = await core.runBenchmarkSuite(version, options, event => set({ stage: { index: event.stageIndex, total: event.totalStages, concurrency: event.concurrency } }), abort.signal);
        results.push(core.concurrencyCandidateResult(candidate.id, core.concurrencyLadderRows(report)));
      } catch (error) {
        if (abort.signal.aborted) break;
        results.push(core.concurrencyCandidateResult(candidate.id, [], core.normalizeError(error).message));
      }
      set({ results: [...results] });
    }
  } finally {
    set({ phase: 'restoring', current: undefined, stage: undefined });
    let restoreError: string | undefined;
    try { await switchVersion(base); } catch (error) { restoreError = core.normalizeError(error).message; }
    controller = null;
    set({ phase: restoreError ? 'failed' : abort.signal.aborted ? 'cancelled' : 'done', error: restoreError, results: [...results], finishedAt: Date.now() });
    const { phase: _phase, current: _current, stage: _stage, ...kept } = state;
    void core.saveStore(STORE_KEY, kept).catch(() => {});
  }
}
export const cancelComparison = () => controller?.abort();
