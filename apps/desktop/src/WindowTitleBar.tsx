import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import type { Window as TauriWindow } from '@tauri-apps/api/window';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { AppLogo } from './AppLogo';
import './window-title-bar.css';

export interface WindowTitleBarProps {
  desktop: boolean;
  language: 'zh-CN' | 'en';
  title?: string;
  status?: ReactNode;
  collapsed?: boolean;
  version?: string;
  updateVersion?: string;
  onVersionClick?: () => void;
  onError?: (error: unknown) => void;
  onClose?: () => void;
}

/** close() emits the native CloseRequested event, including the background policy. */
export function WindowTitleBar({ desktop, language, title, status, collapsed = false, version, updateVersion, onVersionClick, onError, onClose }: WindowTitleBarProps) {
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);
  const [busy, setBusy] = useState(false);
  const nativeWindow = useRef<TauriWindow | null>(null);
  const mounted = useRef(false);
  const operating = useRef(false);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  const text = language === 'en'
    ? { window: 'Application window', minimize: 'Minimize', maximize: 'Maximize', restore: 'Restore window', close: 'Close window' }
    : { window: '应用窗口', minimize: '最小化', maximize: '最大化', restore: '还原窗口', close: '关闭窗口' };
  const versionLabel = language === 'en'
    ? `App version v${version}${updateVersion ? `, update v${updateVersion} available, review update` : ', view app updates'}`
    : `应用版本 v${version}${updateVersion ? `，有新版本 v${updateVersion}，查看更新` : '，查看应用更新'}`;

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    const listeners: UnlistenFn[] = [];
    const synchronize = async (window: TauriWindow) => {
      const maximized = await window.isMaximized();
      if (!disposed) setMaximized(maximized);
    };
    const keepListener = async (promise: Promise<UnlistenFn>) => {
      const unlisten = await promise;
      if (disposed) unlisten(); else listeners.push(unlisten);
    };
    if (desktop) {
      void (async () => {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        if (disposed) return;
        const window = getCurrentWindow();
        nativeWindow.current = window;
        const [maximized, focused] = await Promise.all([window.isMaximized(), window.isFocused()]);
        if (disposed) return;
        setMaximized(maximized); setFocused(focused);
        await Promise.all([
          keepListener(window.onResized(() => { void synchronize(window).catch(error => { if (!disposed) errorHandler.current?.(error); }); })),
          keepListener(window.onFocusChanged(({ payload }) => {
            if (disposed) return;
            setFocused(payload);
            if (payload) void synchronize(window).catch(error => { if (!disposed) errorHandler.current?.(error); });
          })),
        ]);
      })().catch(error => { if (!disposed) errorHandler.current?.(error); });
    }
    return () => {
      disposed = true; mounted.current = false; nativeWindow.current = null;
      for (const unlisten of listeners) unlisten();
    };
  }, [desktop]);

  const action = async (operation: 'minimize' | 'maximize' | 'close') => {
    if (operating.current) return;
    if (operation === 'close' && onClose) { onClose(); return; }
    if (!desktop) {
      if (operation === 'maximize') setMaximized(value => !value);
      return;
    }
    operating.current = true; setBusy(true);
    try {
      const window = nativeWindow.current ?? (await import('@tauri-apps/api/window')).getCurrentWindow();
      if (operation === 'minimize') await window.minimize();
      else if (operation === 'close') await window.close();
      else {
        await window.toggleMaximize();
        const current = await window.isMaximized();
        if (mounted.current) setMaximized(current);
      }
    } catch (error) { errorHandler.current?.(error); }
    finally { operating.current = false; if (mounted.current) setBusy(false); }
  };

  return <header className={`window-title-bar official-surface${collapsed ? ' is-collapsed' : ''}`} aria-label={text.window} data-focused={focused} data-maximized={maximized} data-desktop={desktop}>
    <div className="window-title-bar-drag" data-tauri-drag-region={desktop ? 'deep' : undefined} onDoubleClick={() => { if (!desktop) setMaximized(value => !value); }}>
      <div className="window-title-bar-brand" aria-label="Strata Manager">
        <AppLogo className="window-title-bar-mark"/>
        <div className="window-title-bar-brand-copy">
          <span className="window-title-bar-brand-name"><strong>Strata</strong><span>Manager</span></span>
          {version && <button id="app-version-button" type="button" className="window-title-bar-version" data-tauri-drag-region="false" aria-label={versionLabel} aria-haspopup={updateVersion ? 'dialog' : undefined} title={versionLabel} disabled={!onVersionClick} onClick={onVersionClick} onDoubleClick={event => event.stopPropagation()}>
            <span className="window-title-bar-version-number">v{version}</span>
            {updateVersion && <span className="window-title-bar-update-badge" aria-hidden="true"><span>{language === 'en' ? 'Update' : '有更新'}</span></span>}
          </button>}
        </div>
      </div>
      <div className="window-title-bar-content">{title && <h1 className="window-title-bar-title" id="workspace-page-title">{title}</h1>}</div>
    </div>
    {status && <div className="window-title-bar-status" data-tauri-drag-region="false">{status}</div>}
    <div className="window-title-bar-controls" role="group" aria-label={text.window} data-tauri-drag-region="false">
      <button type="button" className="window-title-bar-button" aria-label={text.minimize} title={text.minimize} disabled={busy} onClick={() => void action('minimize')}><Minus size={15} strokeWidth={1.5} aria-hidden="true"/></button>
      <button type="button" className="window-title-bar-button" aria-label={maximized ? text.restore : text.maximize} title={maximized ? text.restore : text.maximize} disabled={busy} onClick={() => void action('maximize')}>{maximized ? <Copy size={13} strokeWidth={1.4} aria-hidden="true"/> : <Square size={12} strokeWidth={1.4} aria-hidden="true"/>}</button>
      <button type="button" className="window-title-bar-button window-title-bar-close" aria-label={text.close} title={text.close} disabled={busy} onClick={() => void action('close')}><X size={16} strokeWidth={1.5} aria-hidden="true"/></button>
    </div>
  </header>;
}
