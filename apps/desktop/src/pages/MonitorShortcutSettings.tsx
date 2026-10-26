import type { AppLanguage, FloatingMonitorShortcutProblem } from '@strata-manager/core';
import { floatingMonitorShortcutFromKeyboard, floatingMonitorShortcutKeyFromCode, formatFloatingMonitorShortcut, normalizeFloatingMonitorShortcut } from '@strata-manager/core';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';

export interface MonitorShortcutStatus { shortcut: string; active: boolean; message: string }

const mac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

function Keys({ shortcut }: { shortcut: string }) {
  return <>{formatFloatingMonitorShortcut(shortcut, mac).map((part, index) => <kbd key={`${part}-${index}`}>{part}</kbd>)}</>;
}

function problemText(problem: FloatingMonitorShortcutProblem, combo: string, zh: boolean) {
  if (problem === 'reserved') return zh ? `${combo} 是系统或常用软件（如微信 / QQ 截图）的快捷键，请换一个。` : `${combo} belongs to the system or a common app (such as WeChat / QQ screenshots). Pick another.`;
  if (problem === 'modifier') return zh ? '请至少包含 Ctrl、Alt 或 Win 之一（F13–F24 可单独使用）。' : 'Include Ctrl, Alt or Win (F13–F24 can be used alone).';
  return zh ? '不支持这个按键。请使用字母、数字、F1–F24、空格、方向键或 Home / End / PageUp / PageDown / Insert。' : 'That key is not supported. Use a letter, digit, F1–F24, Space, an arrow key or Home / End / PageUp / PageDown / Insert.';
}

/**
 * Global show/hide shortcut for the monitor (strip or taskbar widget).
 * No default: the user records a combination, or leaves it unset.
 */
export function MonitorShortcutSettings({ value, desktop, language, readStatus, onChange }: {
  value?: unknown;
  desktop: boolean;
  language: AppLanguage;
  readStatus?: () => Promise<MonitorShortcutStatus>;
  onChange: (shortcut: string) => void;
}) {
  const zh = language === 'zh-CN';
  const id = useId();
  const shortcut = normalizeFloatingMonitorShortcut(value);
  const [status, setStatus] = useState<MonitorShortcutStatus>();
  const [recording, setRecording] = useState(false);
  const [pending, setPending] = useState('');
  const [problem, setProblem] = useState('');
  const field = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!desktop || !readStatus) return;
    let live = true;
    // Registration follows the settings save; read it back a moment later.
    const timer = setTimeout(() => { void readStatus().then(next => { if (live) setStatus(next); }).catch(() => {}); }, 400);
    return () => { live = false; clearTimeout(timer); };
  }, [desktop, readStatus, shortcut]);
  const registration = status && status.shortcut === shortcut && shortcut && !status.active ? status.message : '';

  const start = () => { if (!desktop) return; setProblem(''); setPending(''); setRecording(true); field.current?.focus(); };
  const stop = () => { setRecording(false); setPending(''); };
  const save = (next: string) => { stop(); setProblem(''); if (next !== shortcut) onChange(next); };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    // Tab keeps moving focus; everything else is captured for the recorder.
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) { stop(); return; }
    event.preventDefault();
    event.stopPropagation();
    const bare = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
    if (bare && event.code === 'Escape') { stop(); setProblem(''); return; }
    if (bare && (event.code === 'Backspace' || event.code === 'Delete')) { save(''); return; }
    const result = floatingMonitorShortcutFromKeyboard(event);
    if ('pending' in result) { setPending(result.pending); return; }
    if (result.problem) {
      const held = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && (mac ? 'Cmd' : 'Win')].filter(Boolean);
      setProblem(problemText(result.problem, [...held, floatingMonitorShortcutKeyFromCode(event.code) ?? event.key].join('+'), zh));
      setPending('');
      return;
    }
    save(result.shortcut);
  };

  const label = zh ? '显示快捷键' : 'Show/hide shortcut';
  const message = problem || registration;
  return <div className="monitor-shortcut-settings">
    <div className="monitor-shortcut-settings-row">
      <span className="monitor-shortcut-settings-label" id={`${id}-label`}>{label}</span>
      <div className="monitor-shortcut-settings-control">
        <button ref={field} type="button" className="monitor-shortcut-settings-field" data-recording={recording || undefined} data-empty={!shortcut || undefined}
          aria-labelledby={`${id}-label ${id}-value`} aria-describedby={`${id}-hint`} disabled={!desktop}
          onClick={() => recording ? stop() : start()} onKeyDown={onKeyDown} onKeyUp={event => { if (recording && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) setPending(''); }} onBlur={stop}>
          <span id={`${id}-value`}>{recording
            ? (pending ? <><Keys shortcut={pending}/><span aria-hidden="true">+ …</span></> : (zh ? '请按下组合键…' : 'Press a combination…'))
            : shortcut ? <Keys shortcut={shortcut}/> : (zh ? '未设置' : 'Not set')}</span>
        </button>
        {!recording && <button type="button" className="monitor-shortcut-settings-action" disabled={!desktop} onClick={start}>{shortcut ? (zh ? '更改' : 'Change') : (zh ? '录制' : 'Record')}</button>}
        {recording && <button type="button" className="monitor-shortcut-settings-action" onMouseDown={event => event.preventDefault()} onClick={() => { stop(); setProblem(''); }}>{zh ? '取消' : 'Cancel'}</button>}
        {shortcut && !recording && <button type="button" className="monitor-shortcut-settings-clear" disabled={!desktop} aria-label={zh ? '清除显示快捷键' : 'Clear the show/hide shortcut'} title={zh ? '清除' : 'Clear'} onClick={() => save('')}><X size={13} aria-hidden="true"/></button>}
      </div>
    </div>
    {message
      ? <p id={`${id}-hint`} className="monitor-shortcut-settings-error" role="alert">{message}</p>
      : <p id={`${id}-hint`} className="monitor-shortcut-settings-hint">{recording
        ? (zh ? 'Esc 取消 · Backspace 清除。需包含 Ctrl、Alt 或 Win。' : 'Esc cancels · Backspace clears. Include Ctrl, Alt or Win.')
        : (zh ? '在任何程序中按下即可显示或隐藏监控（桌面浮条或任务栏监控）。默认不设置。' : 'Press it in any app to show or hide the monitor (desktop strip or taskbar widget). Not set by default.')}</p>}
  </div>;
}
