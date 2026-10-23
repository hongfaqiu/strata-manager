import type { AppLanguage, FloatingMonitorShortcut } from '@strata-manager/core';
import { FLOATING_MONITOR_SHORTCUTS, resolveFloatingMonitorShortcut } from '@strata-manager/core';
import { useEffect, useState } from 'react';

import { Panel } from '../components';
import { Segmented } from '../OfficialControls';

export interface MonitorShortcutStatus { shortcut: string; active: boolean; message: string }

/**
 * Global show/hide shortcut for the monitor (strip or taskbar widget).
 * Presets only: Alt+A and Ctrl+Alt+A are WeChat/QQ screenshot keys.
 */
export function MonitorShortcutSettings({ value, desktop, language, readStatus, onChange }: {
  value?: unknown;
  desktop: boolean;
  language: AppLanguage;
  readStatus?: () => Promise<MonitorShortcutStatus>;
  onChange: (shortcut: FloatingMonitorShortcut) => void;
}) {
  const zh = language === 'zh-CN';
  const shortcut = resolveFloatingMonitorShortcut(value);
  const [status, setStatus] = useState<MonitorShortcutStatus>();
  useEffect(() => {
    if (!desktop || !readStatus) return;
    let live = true;
    // Registration follows the settings save; read it back a moment later.
    const timer = setTimeout(() => { void readStatus().then(next => { if (live) setStatus(next); }).catch(() => {}); }, 400);
    return () => { live = false; clearTimeout(timer); };
  }, [desktop, readStatus, shortcut]);
  const problem = status && status.shortcut === shortcut && shortcut && !status.active ? status.message : '';
  return <Panel title={zh ? '显示快捷键' : 'Show/hide shortcut'}>
    <Segmented
      ariaLabel={zh ? '显示快捷键' : 'Show/hide shortcut'}
      value={shortcut}
      options={FLOATING_MONITOR_SHORTCUTS.map(option => ({ value: option, label: option || (zh ? '关闭' : 'Off'), disabled: !desktop }))}
      onValueChange={next => onChange(resolveFloatingMonitorShortcut(next))}
    />
    {problem
      ? <p className="floating-monitor-settings-error" role="alert">{problem}</p>
      : <p className="taskbar-monitor-settings-hint">{zh
        ? '在任何程序中按下即可显示或隐藏监控（桌面浮条或任务栏监控，按当前使用的方式）。默认 Ctrl+Alt+M，避开微信截图 Alt+A 和 QQ 截图 Ctrl+Alt+A。'
        : 'Press it in any app to show or hide the monitor (desktop strip or taskbar widget, whichever you use). Defaults to Ctrl+Alt+M, clear of the WeChat (Alt+A) and QQ (Ctrl+Alt+A) screenshot keys.'}</p>}
  </Panel>;
}
