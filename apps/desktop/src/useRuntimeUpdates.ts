import type { AppLanguage } from "@strata-manager/core";
import { createElement, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as core from '@strata-manager/core';
import type { AutomaticUpdateGate } from './useAppUpdates';
import { RuntimeUpdateDialog } from './pages/RuntimeUpdateDialog';

function newer(current: string | undefined, latest: string | undefined) {
  if (!current || !latest || !/^v?\d+(\.\d+)*$/.test(current) || !/^v?\d+(\.\d+)*$/.test(latest)) return false;
  const installed = current.replace(/^v/, '').split('.').map(Number), target = latest.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(installed.length, target.length); i++) {
    if ((installed[i] ?? 0) !== (target[i] ?? 0)) return (installed[i] ?? 0) < (target[i] ?? 0);
  }
  return false;
}

interface PendingUpdate { runtime: core.DetectedRuntime; release: core.RuntimeUpdateInfo }
const updateKey = ({ runtime, release }: PendingUpdate) => `${runtime.installDir}:${release.latestVersion}:${release.checkedAt}`;

/** Automatic checks propose updates; only a confirmed dialog starts a ZIP task. */
export function useRuntimeUpdates(desktop: boolean, ready: boolean, enabled: boolean, idle: boolean, tasks: core.TaskStatus[] | undefined, language: AppLanguage, onError?: (error: unknown) => void, gate?: AutomaticUpdateGate, onStarted?: () => void) {
  const query = useQueryClient();
  const enabledRef = useRef(enabled); enabledRef.current = enabled;
  const errorHandler = useRef(onError); errorHandler.current = onError;
  const started = useRef(onStarted); started.current = onStarted;
  const gateRef = useRef(gate); gateRef.current = gate;
  const heldGate = useRef<AutomaticUpdateGate | null>(null);
  const acquireGate = () => {
    if (heldGate.current || !gateRef.current) return true;
    if (!gateRef.current.acquire()) return false;
    heldGate.current = gateRef.current;
    return true;
  };
  const releaseGate = () => {
    if (!heldGate.current) return;
    const acquired = heldGate.current;
    heldGate.current = null;
    (gateRef.current ?? acquired).release();
  };
  const policy = useRef({ enabled, generation: 0 });
  if (policy.current.enabled !== enabled) { policy.current = { enabled, generation: policy.current.generation + 1 }; }
  const running = useRef(false), automaticTask = useRef('');
  const awaitingCreatedTask = useRef(false);
  const [hydrated, setHydrated] = useState(false);
  const [wake, setWake] = useState(0);
  const [pending,setPending] = useState<PendingUpdate | null>(null);
  const [starting,setStarting] = useState(false), [actionError,setActionError] = useState('');
  const attempted = useRef(new Set<string>());
  const dismissed = useRef(new Set<string>());
  const downloadPreferences = useQuery({ queryKey: ['runtime-download-preferences'], queryFn: core.getRuntimeDownloadPreferences, enabled: desktop && ready, staleTime: Infinity, retry: false });
  const installation = useQuery({ queryKey: ['runtime-installation'], queryFn: core.localRuntimeInstallation, enabled: desktop && ready && enabled, refetchInterval: enabled ? 5 * 60 * 1000 : false, refetchOnWindowFocus: false });
  const release = useQuery({ queryKey: ['runtime-update-info'], queryFn: () => core.runtimeUpdateInfo(), enabled: desktop && ready && enabled, staleTime: 12 * 60 * 60 * 1000, refetchInterval: enabled ? 12 * 60 * 60 * 1000 : false, refetchOnWindowFocus: enabled });
  useEffect(() => {
    if (enabled) {
      attempted.current.clear();
      dismissed.current.clear();
    } else { setPending(null); setActionError(''); }
  }, [enabled]);
  useEffect(() => () => {
    if (!running.current && !automaticTask.current && !awaitingCreatedTask.current) releaseGate();
  }, []);
  useEffect(() => {
    if (!desktop || !ready) return;
    let disposed = false;
    void core.loadStore<string>('automaticRuntimeUpdateTask', '').then(id => { if (!disposed) { automaticTask.current = id; setHydrated(true); void query.invalidateQueries({ queryKey: ['tasks'] }); } }).catch(() => { if (!disposed) setHydrated(true); });
    return () => { disposed = true; };
  }, [desktop, ready, query]);
  useEffect(() => {
    if (!desktop || !ready || !hydrated || !tasks) return;
    const task = tasks.find(item => item.id === automaticTask.current);
    if (task) awaitingCreatedTask.current = false;
    if (task?.state === 'running') acquireGate();
    if (!enabled && automaticTask.current && (task?.state === 'running' || awaitingCreatedTask.current)) {
      void core.cancelTask(automaticTask.current).then(() => query.invalidateQueries({ queryKey: ['tasks'] })).catch(() => {});
    }
    if (automaticTask.current && !running.current && (task ? task.state !== 'running' : !awaitingCreatedTask.current)) {
      automaticTask.current = '';
      releaseGate();
      void core.saveStore('automaticRuntimeUpdateTask', '').catch(() => {});
      void query.invalidateQueries({ queryKey: ['runtime-installation'] });
      void query.invalidateQueries({ queryKey: ['localInstallationDetails'] });
      void query.invalidateQueries({ queryKey: ['health'] });
      void query.invalidateQueries({ queryKey: ['process'] });
    }
    if (!enabled && !running.current && !automaticTask.current) releaseGate();
    if (!enabled || !idle || !downloadPreferences.isSuccess || pending || running.current || automaticTask.current || tasks.some(item => item.state === 'running') || !release.data?.installable) return;
    if (dismissed.current.has(`${release.data.latestVersion}:${release.data.checkedAt}`)) return;
    const runtime = installation.data?.detectedRuntimes?.find(item => item.readiness === 'ready' && newer(item.runtimeVersion, release.data?.latestVersion) && !core.runtimeEngineIsCurrent(item.runtimeVersion, release.data) && !attempted.current.has(`${item.installDir}:${release.data?.latestVersion}:${release.data?.checkedAt}`));
    if (!runtime) return;
    const proposed = { runtime, release: release.data };
    attempted.current.add(updateKey(proposed));
    setActionError(''); setPending(proposed);
  }, [desktop, ready, enabled, idle, hydrated, tasks, release.data, installation.data, downloadPreferences.isSuccess, query, wake, pending]);

  const confirm = async (download: core.RuntimeZipDownloadOptions = {}, assetName?: string) => {
    if (!pending || running.current || automaticTask.current || awaitingCreatedTask.current) return;
    if (!desktop || !ready || !enabled || !idle || !downloadPreferences.isSuccess || !tasks || tasks.some(item => item.state === 'running')) {
      setActionError(language === 'zh-CN' ? '当前正在处理请求或任务，请空闲后再确认。' : 'Requests or tasks are in progress. Confirm again when they finish.'); return;
    }
    const latest = release.data;
    if (!latest?.installable || release.isFetching) return;
    if (latest.checkedAt !== pending.release.checkedAt || latest.latestVersion !== pending.release.latestVersion) {
      const proposed = { runtime: pending.runtime, release: latest };
      attempted.current.add(updateKey(proposed)); setPending(proposed); setActionError(''); return;
    }
    const current = installation.data?.detectedRuntimes?.find(item => item.installDir === pending.runtime.installDir && item.readiness === 'ready');
    if (!current || !newer(current.runtimeVersion, latest.latestVersion) || core.runtimeEngineIsCurrent(current.runtimeVersion, latest)) { setPending(null); return; }
    if (!acquireGate()) {
      setActionError(language === 'zh-CN' ? '另一个更新正在进行，请完成后再确认。' : 'Another update is in progress. Confirm again when it finishes.'); return;
    }
    const generation = policy.current.generation;
    running.current = true; setStarting(true); setActionError('');
    let created = false;
    try {
      const result = await core.updateRuntimeZip(current.installDir, assetName, true, download);
      created = true;
      automaticTask.current = result.id;
      awaitingCreatedTask.current = true;
      try {
        await core.saveStore('automaticRuntimeUpdateTask', result.id);
      } catch (error) {
        await core.cancelTask(result.id);
        throw error;
      } finally {
        if (!enabledRef.current || generation !== policy.current.generation) await core.cancelTask(result.id);
        await query.invalidateQueries({ queryKey: ['tasks'] });
      }
      setPending(null);
      if (enabledRef.current && generation === policy.current.generation) started.current?.();
    } catch (error) {
      if (!created) releaseGate();
      setActionError(core.normalizeError(error).message);
      errorHandler.current?.(error);
    } finally {
      running.current = false;
      setStarting(false);
      // Refs alone do not trigger an effect when a very fast task has already
      // reached its terminal state in the last tasks-query response.
      setWake(value => value + 1);
    }
  };
  const savedDownload = pending && downloadPreferences.data ? core.resolveRuntimeDownloadPreferences(downloadPreferences.data, pending.release) : undefined;
  return { dialog: pending && desktop && ready && enabled ? createElement(RuntimeUpdateDialog, {
    language, runtime: pending.runtime, release: pending.release, busy: starting,
    assetName: savedDownload?.assetName, initialDownload: savedDownload?.download, initialPreferences: downloadPreferences.data,
    canConfirm: idle && downloadPreferences.isSuccess && !automaticTask.current && !awaitingCreatedTask.current && !!tasks && !tasks.some(item => item.state === 'running') && !release.isFetching && !!release.data?.installable,
    error: actionError || (downloadPreferences.error ? core.normalizeError(downloadPreferences.error).message : undefined), onConfirm: (download, assetName) => { void confirm(download, assetName); }, onDismiss: () => { if (!running.current) { dismissed.current.add(`${pending.release.latestVersion}:${pending.release.checkedAt}`); setPending(null); setActionError(''); } },
  }) : null };
}
