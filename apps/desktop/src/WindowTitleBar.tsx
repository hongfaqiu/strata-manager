import type { AppLanguage } from "@strata-manager/core";
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import type { Window as TauriWindow } from '@tauri-apps/api/window';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { AppLogo } from './AppLogo';
import { currentWindowChrome, type WindowChrome } from './windowChrome.mjs';
import './window-title-bar.css';

export interface WindowTitleBarProps {
  desktop: boolean;
  language: AppLanguage;
  title?: string;
  status?: ReactNode;
  collapsed?: boolean;
  version?: string;
  updateVersion?: string;
  /** Overrides the badge for an update in progress or ready to install. */
  updateStatus?: { badge: string; label: string; active: boolean };
  onVersionClick?: () => void;
  onError?: (error: unknown) => void;
  onClose?: () => void;
  /** Defaults to the platform detected at startup (see windowChrome.mjs). */
  chrome?: WindowChrome;
}

/** close() emits the native CloseRequested event, including the background policy. */
export function WindowTitleBar({ desktop, language, title, status, collapsed = false, version, updateVersion, updateStatus, onVersionClick, onError, onClose, chrome = currentWindowChrome() }: WindowTitleBarProps) {
  // macOS draws its own traffic lights over the header's top-left corner;
  // Windows/Linux keep the custom buttons on the right.
  const nativeControls = chrome === 'macos';
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [focused, setFocused] = useState(true);
  const [busy, setBusy] = useState(false);
  const nativeWindow = useRef<TauriWindow | null>(null);
  const mounted = useRef(false);
  const operating = useRef(false);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  const text = language !== 'zh-CN'
    ? { window: 'Application window', minimize: 'Minimize', maximize: 'Maximize', restore: 'Restore window', close: 'Close window' }
    : { window: '应用窗口', minimize: '最小化', maximize: '最大化', restore: '还原窗口', close: '关闭窗口' };
  const versionLabel = language !== 'zh-CN'
    ? `App version v${version}${updateStatus ? `, ${updateStatus.label}` : updateVersion ? `, update v${updateVersion} available, review update` : ', view app updates'}`
    : `应用版本 v${version}${updateStatus ? `，${updateStatus.label}` : updateVersion ? `，有新版本 v${updateVersion}，查看更新` : '，查看应用更新'}`;

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    const listeners: UnlistenFn[] = [];
    const synchronize = async (window: TauriWindow) => {
      const [maximized, fullscreen] = await Promise.all([window.isMaximized(), nativeControls ? window.isFullscreen() : false]);
      if (!disposed) { setMaximized(maximized); setFullscreen(fullscreen); }
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
        const [maximized, focused, fullscreen] = await Promise.all([window.isMaximized(), window.isFocused(), nativeControls ? window.isFullscreen() : false]);
        if (disposed) return;
        setMaximized(maximized); setFocused(focused); setFullscreen(fullscreen);
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
  }, [desktop, nativeControls]);

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

  return <header className={`window-title-bar official-surface${collapsed ? ' is-collapsed' : ''}`} aria-label={text.window} data-focused={focused} data-maximized={maximized} data-desktop={desktop} data-chrome={chrome} data-fullscreen={nativeControls ? fullscreen : undefined}>
    <div className="window-title-bar-drag" data-tauri-drag-region={desktop ? 'deep' : undefined} onDoubleClick={() => { if (!desktop) setMaximized(value => !value); }}>
      <div className="window-title-bar-brand" aria-label="Strata Manager">
        <AppLogo className="window-title-bar-mark"/>
        <div className="window-title-bar-brand-copy">
          <span className="window-title-bar-brand-name"><strong>Strata</strong><span>Manager</span></span>
          {version && <button id="app-version-button" type="button" className="window-title-bar-version" data-tauri-drag-region="false" aria-label={versionLabel} aria-haspopup={updateVersion ? 'dialog' : undefined} data-tooltip={versionLabel} disabled={!onVersionClick} onClick={onVersionClick} onDoubleClick={event => event.stopPropagation()}>
            <span className="window-title-bar-version-number">v{version}</span>
            {(updateVersion || updateStatus) && <span className="window-title-bar-update-badge" data-active={updateStatus?.active || undefined} aria-hidden="true"><span>{updateStatus?.badge ?? (language !== 'zh-CN' ? 'Update' : '有更新')}</span></span>}
          </button>}
        </div>
      </div>
      <div className="window-title-bar-content">{title && <h1 className="window-title-bar-title" id="workspace-page-title">{title}</h1>}</div>
    </div>
    {status && <div className="window-title-bar-status" data-tauri-drag-region="false">{status}</div>}
    {!nativeControls && <div className="window-title-bar-controls" role="group" aria-label={text.window} data-tauri-drag-region="false">
      <button type="button" className="window-title-bar-button" aria-label={text.minimize} data-tooltip={text.minimize} disabled={busy} onClick={() => void action('minimize')}><Minus size={15} strokeWidth={1.5} aria-hidden="true"/></button>
      <button type="button" className="window-title-bar-button" aria-label={maximized ? text.restore : text.maximize} data-tooltip={maximized ? text.restore : text.maximize} disabled={busy} onClick={() => void action('maximize')}>{maximized ? <Copy size={13} strokeWidth={1.4} aria-hidden="true"/> : <Square size={12} strokeWidth={1.4} aria-hidden="true"/>}</button>
      <button type="button" className="window-title-bar-button window-title-bar-close" aria-label={text.close} data-tooltip={text.close} disabled={busy} onClick={() => void action('close')}><X size={16} strokeWidth={1.5} aria-hidden="true"/></button>
    </div>}
  </header>;
}
