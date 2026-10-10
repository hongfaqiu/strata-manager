import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AppSettings } from '@strata-manager/core';
import * as core from '@strata-manager/core';
import { Dialog } from './components';

export function useWindowClose({ desktop, ready, settings, onSettings, onError }: { desktop: boolean; ready: boolean; settings: AppSettings; onSettings: (settings: AppSettings) => void; onError: (error: unknown) => void }) {
  const [open, setOpen] = useState(false), [remember, setRemember] = useState(false), [exiting, setExiting] = useState(false);
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const handlerRef = useRef(onError); handlerRef.current = onError;
  const exitingRef = useRef(false);
  const text = settings.language === 'en'
    ? { title: 'Exit Strata Manager?', hint: 'This stops local model services and background tasks managed by this app.', remember: 'Do not ask again', cancel: 'Cancel', exit: 'Stop services and exit', exiting: 'Stopping services…' }
    : { title: '退出 Strata Manager？', hint: '退出将停止本软件管理的本机模型服务和后台任务。', remember: '不再提示', cancel: '取消', exit: '停止服务并退出', exiting: '正在停止服务…' };
  useEffect(() => {
    if (!desktop) return;
    let disposed = false, unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/event').then(({ listen }) => listen('window-exit-requested', () => { if (!disposed && !exitingRef.current) { setRemember(false); setOpen(true); } })).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(error => { if (!disposed) handlerRef.current(error); });
    return () => { disposed = true; unlisten?.(); };
  }, [desktop]);
  const requestClose = () => {
    if (!desktop || exitingRef.current) return;
    const current = settingsRef.current;
    if (!current.closeToTray && !current.skipExitConfirmation) { setRemember(false); setOpen(true); return; }
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().close()).catch(error => handlerRef.current(error));
  };
  const confirm = async () => {
    if (exitingRef.current) return;
    exitingRef.current = true; setExiting(true);
    try {
      if (remember && ready) {
        const next = { ...settingsRef.current, skipExitConfirmation: true };
        await core.saveStore('settings', next); await core.applySettings(next); onSettings(next);
      }
      await invoke('confirm_window_close'); setOpen(false);
    } catch (error) { handlerRef.current(error); }
    finally { exitingRef.current = false; setExiting(false); }
  };
  const cancel = () => { if (!exitingRef.current) setOpen(false); };
  return { requestClose, dialog: open ? <Dialog title={text.title} onClose={cancel}><p>{text.hint}</p><label className="exit-remember"><input type="checkbox" checked={remember} disabled={!ready || exiting} onChange={event => setRemember(event.target.checked)}/>{text.remember}</label><div className="dialog-footer"><button type="button" disabled={exiting} onClick={cancel}>{text.cancel}</button><button type="button" className="danger-solid" disabled={exiting} onClick={() => void confirm()}>{exiting ? text.exiting : text.exit}</button></div></Dialog> : null };
}
