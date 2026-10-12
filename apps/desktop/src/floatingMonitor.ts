import { invoke } from '@tauri-apps/api/core';
import { isDesktop, type AppSettings, type JsonObject, type ProcessStatus, type ServiceProfile } from '@strata-manager/core';
import type { FloatingMonitorAction, FloatingMonitorPreferences } from '@strata-manager/core';

export type { FloatingMonitorAction, FloatingMonitorPreferences } from '@strata-manager/core';
export type MonitorDestination = 'overview' | 'chat' | 'monitoring' | 'usage' | 'tasks' | 'settings' | 'quickBenchmark';

export const FLOATING_MONITOR_ACTIONS: { id: FloatingMonitorAction; label: Record<'zh-CN' | 'en', string> }[] = [
  { id: 'main', label: { 'zh-CN': '显示主窗口', en: 'Show main window' } },
  { id: 'chat', label: { 'zh-CN': '打开聊天', en: 'Open chat' } },
  { id: 'monitoring', label: { 'zh-CN': '打开性能监控', en: 'Open performance monitor' } },
  { id: 'usage', label: { 'zh-CN': '打开 API 统计', en: 'Open API usage' } },
  { id: 'tasks', label: { 'zh-CN': '打开任务与日志', en: 'Open tasks and logs' } },
  { id: 'quickBenchmark', label: { 'zh-CN': '快速测速', en: 'Quick speed test' } },
  { id: 'copyApiUrl', label: { 'zh-CN': '复制 API 地址', en: 'Copy API address' } },
  { id: 'refresh', label: { 'zh-CN': '刷新采样', en: 'Refresh sample' } },
  { id: 'pause', label: { 'zh-CN': '暂停采样', en: 'Pause sampling' } },
  { id: 'pin', label: { 'zh-CN': '置顶浮条', en: 'Keep monitor on top' } },
];

export function normalizeFloatingMonitorPreferences(value?: unknown): FloatingMonitorPreferences {
  const source = value && typeof value === 'object' ? value as Partial<FloatingMonitorPreferences> : {};
  const validActions = new Set(FLOATING_MONITOR_ACTIONS.map(action => action.id));
  const actions = Array.isArray(source.actions)
    ? [...new Set(source.actions.filter((action): action is FloatingMonitorAction => validActions.has(action)))].slice(0, 6)
    : [];
  return { actions, alwaysOnTop: source.alwaysOnTop !== false, showSampleTime: source.showSampleTime === true, showInTray: source.showInTray === true };
}

export interface FloatingMonitorSnapshot {
  settings?: Pick<AppSettings, 'language' | 'theme' | 'pollInterval' | 'floatingMonitor'>;
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
export const showMainFromMonitor = (destination?: MonitorDestination): Promise<void> => invoke('show_main_from_monitor', { destination });
export const minimizeMonitorToTray = (): Promise<void> => invoke('minimize_monitor_to_tray');
