import { useEffect, useRef, useState } from 'react';
import { loadStore, prepareAppUpdate, saveStore } from '@strata-manager/core';
import { AppUpdateController, CHECK_INTERVAL, type AppUpdateState } from './appUpdateController';

export type { AppUpdateState } from './appUpdateController';

export function useAppUpdates(desktop: boolean, enabled: boolean, ready: boolean) {
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
  });
  const controller = controllerRef.current;
  const [state, setState] = useState<AppUpdateState>(controller.state);

  useEffect(() => {
    controller.attach(setState);
    return () => controller.detach();
  }, [controller]);

  useEffect(() => {
    controller.configure({ desktop, enabled, ready });
    if (!desktop || !ready || !enabled) return;
    void controller.automatic(true);
    const timer = setInterval(() => void controller.automatic(), CHECK_INTERVAL);
    return () => clearInterval(timer);
  }, [controller, desktop, ready, enabled]);

  return { state, check: controller.check, download: controller.download, install: controller.install };
}
