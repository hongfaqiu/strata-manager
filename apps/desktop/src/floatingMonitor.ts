import { invoke } from '@tauri-apps/api/core';
import { isDesktop, type AppSettings, type JsonObject, type ProcessStatus, type ServiceProfile } from '@strata-manager/core';
import type { FloatingMonitorAction, FloatingMonitorPreferences, FloatingMonitorMode, FloatingMonitorRows } from '@strata-manager/core';

export type { FloatingMonitorAction, FloatingMonitorPreferences } from '@strata-manager/core';
export { normalizeFloatingMonitorPreferences } from '@strata-manager/core';
export type MonitorDestination = 'overview' | 'chat' | 'monitoring' | 'usage' | 'tasks' | 'settings' | 'taskbarColors' | 'quickBenchmark';

export const FLOATING_MONITOR_ACTIONS: { id: FloatingMonitorAction; label: { 'zh-CN': string; en: string } }[] = [
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
export interface MonitorModeStatus { mode: FloatingMonitorMode; supported: boolean; active: boolean; visible?: boolean; message?: string }
export const setMonitorMode = (mode: FloatingMonitorMode, preferences: FloatingMonitorPreferences, language: AppLanguage = 'zh-CN'): Promise<MonitorModeStatus> => invoke('set_monitor_mode', { mode, preferences: { ...preferences, language } });

export const readMonitorModeStatus = (): Promise<MonitorModeStatus> => invoke('monitor_mode_status');
export const readMonitorShortcutStatus = (): Promise<{ shortcut: string; active: boolean; message: string }> => invoke('monitor_shortcut_status');
export const setMonitorVisibility = (visible: boolean, mode: FloatingMonitorMode, preferences: FloatingMonitorPreferences, language: AppLanguage = 'zh-CN'): Promise<MonitorModeStatus> => invoke('set_monitor_visibility', { visible, mode, preferences: { ...preferences, language } });
// The strip's "收起到任务栏监控": the taskbar widget replaces it and is remembered for the next launch.
export const moveMonitorToTaskbar = (preferences: FloatingMonitorPreferences, language: AppLanguage = 'zh-CN'): Promise<MonitorModeStatus> => invoke('move_monitor_to_taskbar', { preferences: { ...preferences, language } });
/** Strip context menu 「文字行数」; the main window saves it like a settings edit. */
export const setMonitorRows = (rows: FloatingMonitorRows): Promise<void> => invoke('set_monitor_rows', { rows });
export const resizeMonitorWindow = (width: number, height: number): Promise<{ width: number; height: number }> => invoke('resize_monitor_window', { width, height });
import type { AppLanguage } from '@strata-manager/core';
