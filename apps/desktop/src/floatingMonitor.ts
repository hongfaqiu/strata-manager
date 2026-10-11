import { invoke } from '@tauri-apps/api/core';
import { isDesktop, type AppSettings, type JsonObject, type ProcessStatus, type ServiceProfile } from '@strata-manager/core';

export interface FloatingMonitorSnapshot {
  settings?: Pick<AppSettings, 'language' | 'theme' | 'pollInterval'>;
  profile?: ServiceProfile;
  process?: ProcessStatus;
  phase: 'none' | 'stopped' | 'disconnected' | 'unavailable' | 'online';
  health?: JsonObject;
  metrics?: JsonObject;
  sampledAt: number;
  error?: string;
}

export async function openFloatingMonitor(): Promise<void> {
  if (!isDesktop()) throw new Error('监控浮条需要桌面应用');
  await invoke('open_monitor_window');
}

// This dedicated native command reads the already running supervisor directly.
// General bridge calls may start or replace a supervisor during connection recovery.
export const readFloatingMonitor = (): Promise<FloatingMonitorSnapshot> => invoke('monitor_snapshot');
export const showMainFromMonitor = (): Promise<void> => invoke('show_main_from_monitor');
