import { Check, RotateCcw, SquareArrowOutUpRight } from 'lucide-react';
import { Panel } from '../components';
import { Toggle } from '../OfficialControls';
import { normalizeFloatingMonitorPreferences, type FloatingMonitorPreferences } from '../floatingMonitor';
import './floating-monitor-settings.css';

interface Props {
  preferences: FloatingMonitorPreferences;
  desktop: boolean;
  language: 'zh-CN' | 'en';
  onChange: (next: FloatingMonitorPreferences) => void;
  onOpen: () => void;
}

export function FloatingMonitorSettings({ preferences, desktop, language, onChange, onOpen }: Props) {
  const zh = language === 'zh-CN';
  const value = normalizeFloatingMonitorPreferences(preferences);
  const update = (patch: Partial<FloatingMonitorPreferences>) => onChange(normalizeFloatingMonitorPreferences({ ...value, ...patch }));

  return <div id="settings-floating-monitor"><Panel className="floating-monitor-settings" title={zh ? '监控浮动条' : 'Floating monitor'} action={<button type="button" disabled={!desktop} onClick={onOpen}><SquareArrowOutUpRight size={14} aria-hidden="true"/>{zh ? '打开浮动条' : 'Open monitor'}</button>}>
    {!desktop && <p className="subtle" role="status">{zh ? '请在桌面应用中使用监控浮动条。' : 'Use the floating monitor in the desktop app.'}</p>}
    <p className="floating-monitor-settings-hint">{zh ? '浮条仅显示监控数据，按住任意位置拖动。右键（或 Shift+F10）可测速、收起到托盘、关闭及使用其他操作。' : 'The strip shows metrics only. Drag anywhere; right-click (or Shift+F10) to test speed, move to tray, close, or access other actions.'}</p>
    <div className="setting-toggle floating-monitor-settings-option"><span><strong>{zh ? '默认置顶' : 'Always on top by default'}</strong><small>{zh ? '浮动条保持在其他窗口上方，也可通过右键菜单切换。' : 'Keep the monitor above other windows. You can also toggle this from its context menu.'}</small></span><Toggle ariaLabel={zh ? '监控浮动条默认置顶' : 'Floating monitor always on top by default'} checked={value.alwaysOnTop} disabled={!desktop} onCheckedChange={alwaysOnTop => update({ alwaysOnTop })}/></div>
    <div className="setting-toggle floating-monitor-settings-option"><span><strong>{zh ? '显示采样时间' : 'Show sample time'}</strong><small>{zh ? '显示最近一次监控数据的采样时间。' : 'Show when the latest monitor data was sampled.'}</small></span><Toggle ariaLabel={zh ? '监控浮动条显示采样时间' : 'Floating monitor show sample time'} checked={value.showSampleTime} disabled={!desktop} onCheckedChange={showSampleTime => update({ showSampleTime })}/></div>
    <div className="setting-toggle floating-monitor-settings-option"><span><strong>{zh ? '在系统托盘显示监控' : 'Show monitor in the system tray'}</strong><small>{zh ? '托盘独立更新状态和速度，点击图标可恢复浮动条。' : 'The tray updates status and speed independently. Click its icon to restore the monitor.'}</small></span><Toggle ariaLabel={zh ? '在系统托盘显示监控' : 'Show monitor in the system tray'} checked={value.showInTray} disabled={!desktop} onCheckedChange={showInTray => update({ showInTray })}/></div>
    <div className="floating-monitor-settings-footer"><span><Check size={13} aria-hidden="true"/>{zh ? '设置自动保存' : 'Settings save automatically'}</span><button type="button" disabled={!desktop} onClick={() => onChange(normalizeFloatingMonitorPreferences(undefined))}><RotateCcw size={14} aria-hidden="true"/>{zh ? '恢复默认' : 'Restore defaults'}</button></div>
  </Panel></div>;
}
