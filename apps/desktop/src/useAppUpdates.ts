import { useEffect, useRef, useState } from 'react';
import { loadStore, prepareAppUpdate, saveStore } from '@strata-manager/core';
import { AppUpdateController, CHECK_INTERVAL, type AppUpdateState } from './appUpdateController';

export type { AppUpdateState } from './appUpdateController';

export interface AutomaticUpdateGate { acquire: () => boolean; release: () => void }

export function useAppUpdates(desktop: boolean, enabled: boolean, ready: boolean, idle = true, gate?: AutomaticUpdateGate) {
  const gateRef = useRef(gate); gateRef.current = gate;
  const controllerRef = useRef<AppUpdateController | null>(null);
  if (!controllerRef.current) controllerRef.current = new AppUpdateController({
    check: async () => {
      const { check } = await import('@tauri-apps/plugin-updater');
      return check({ timeout: 30000 });
    },
    prepare: prepareAppUpdate,
    loadLastCheck: () => loadStore<number>('lastAppUpdateCheck', 0),
    saveLastCheck: time => saveStore('lastAppUpdateCheck', time),
    now: Date.now,
    acquire: () => gateRef.current?.acquire() ?? true,
    release: () => gateRef.current?.release(),
  });
  const controller = controllerRef.current;
  const [state, setState] = useState<AppUpdateState>(controller.state);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    controller.attach(setState);
    return () => controller.detach();
  }, [controller]);

  useEffect(() => {
    controller.configure({ desktop, enabled, ready, idle });
  }, [controller, desktop, ready, enabled, idle]);

  useEffect(() => {
    if (!desktop || !ready || !enabled) return;
    void controller.automatic(true);
    const checkTimer = setInterval(() => void controller.automatic(), CHECK_INTERVAL);
    return () => clearInterval(checkTimer);
  }, [controller, desktop, ready, enabled]);

  useEffect(() => {
    if (!state.version || state.phase === 'current' || state.phase === 'installed') setDialogOpen(false);
  }, [state.phase, state.version]);

  const openDialog = async () => { if (controller.state.version && controller.state.phase !== 'current' && controller.state.phase !== 'installed') setDialogOpen(true); };
  const check = async () => { await controller.check(); if (controller.state.version && controller.state.phase !== 'installed') setDialogOpen(true); };
  const confirm = async (version: string) => { await controller.confirm(version); };
  return { state, dialogOpen, check, download: openDialog, install: openDialog, openDialog, confirm, dismiss: () => setDialogOpen(false) };
}
