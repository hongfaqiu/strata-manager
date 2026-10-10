import { useCallback, useEffect, useRef, useState } from 'react';
import type { Update } from '@tauri-apps/plugin-updater';
import { loadStore, prepareAppUpdate, saveStore } from '@strata-manager/core';

export interface AppUpdateState {
  phase: 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'installing' | 'installed' | 'error';
  version?: string;
  notes?: string;
  received: number;
  total?: number;
  error?: string;
}

const CHECK_INTERVAL = 12 * 60 * 60 * 1000;

export function useAppUpdates(desktop: boolean, enabled: boolean, ready: boolean) {
  const [state, setState] = useState<AppUpdateState>({ phase: 'idle', received: 0 });
  const resource = useRef<Update | null>(null);
  const working = useRef(false);
  const mounted = useRef(false);

  const check = useCallback(async () => {
    if (!desktop || !ready || working.current) return;
    working.current = true;
    setState({ phase: 'checking', received: 0 });
    try {
      const { check: checkSignedUpdate } = await import('@tauri-apps/plugin-updater');
      const next = await checkSignedUpdate({ timeout: 30000 });
      if (!mounted.current) { await next?.close(); return; }
      await resource.current?.close();
      resource.current = next;
      setState(next ? { phase: 'available', version: next.version, notes: next.body, received: 0 } : { phase: 'current', received: 0 });
      await saveStore('lastAppUpdateCheck', Date.now());
    } catch (error) {
      if (mounted.current) setState({ phase: 'error', received: 0, error: error instanceof Error ? error.message : String(error) });
    } finally { working.current = false; }
  }, [desktop, ready]);

  const install = useCallback(async () => {
    const update = resource.current;
    if (!desktop || !update || working.current) return;
    working.current = true;
    let received = 0;
    let total: number | undefined;
    try {
      await prepareAppUpdate();
      setState({ phase: 'downloading', version: update.version, received });
      await update.download(event => {
        if (event.event === 'Started') total = event.data.contentLength;
        if (event.event === 'Progress') received += event.data.chunkLength;
        if (mounted.current) setState({ phase: 'downloading', version: update.version, received, total });
      }, { timeout: 600000 });
      // Downloads may be long enough for a model/task to become busy again.
      await prepareAppUpdate();
      setState({ phase: 'installing', version: update.version, received, total });
      await update.install({ restartAfterInstall: true });
      if (mounted.current) setState({ phase: 'installed', version: update.version, received, total });
    } catch (error) {
      if (mounted.current) setState({ phase: 'error', version: update.version, received, total, error: error instanceof Error ? error.message : String(error) });
    } finally { working.current = false; }
  }, [desktop]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const update = resource.current;
      resource.current = null;
      void update?.close();
    };
  }, []);

  useEffect(() => {
    if (!desktop || !ready || !enabled) return;
    let cancelled = false;
    const automaticCheck = async () => {
      try {
        const last = await loadStore<number>('lastAppUpdateCheck', 0);
        if (!cancelled && Date.now() - last >= CHECK_INTERVAL) await check();
      } catch (error) {
        if (!cancelled) setState({ phase: 'error', received: 0, error: error instanceof Error ? error.message : String(error) });
      }
    };
    void automaticCheck();
    const timer = setInterval(() => void automaticCheck(), CHECK_INTERVAL);
    return () => { cancelled = true; clearInterval(timer); };
  }, [desktop, ready, enabled, check]);

  return { state, check, install };
}
