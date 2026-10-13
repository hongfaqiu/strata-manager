import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Menu, type MenuOptions } from '@tauri-apps/api/menu';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';
import { listen } from '@tauri-apps/api/event';
import { isDesktop, normalizeMetrics } from '@strata-manager/core';
import i18n from './i18n';
import { ServiceTelemetryStatusBar } from './layouts/ServiceTelemetryStatusBar';
import { FLOATING_MONITOR_ACTIONS, minimizeMonitorToTray, normalizeFloatingMonitorPreferences, readFloatingMonitor, showMainFromMonitor, type FloatingMonitorAction, type FloatingMonitorSnapshot } from './floatingMonitor';
import './floating-telemetry-window.css';

export function FloatingTelemetryWindow() {
  const desktop = isDesktop();
  const [pinned, setPinned] = useState(true);
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [docked, setDocked] = useState(false);
  const [resumeAfter, setResumeAfter] = useState<number | null>(null);
  const [feedback, setFeedback] = useState('');
  const [liveSettings, setLiveSettings] = useState<FloatingMonitorSnapshot['settings']>();
  const [now, setNow] = useState(Date.now);
  const operating = useRef(false);
  const menu = useRef<Menu | null>(null);
  const openingMenu = useRef(false);
  const mounted = useRef(false);
  const pinPreference = useRef<boolean | undefined>(undefined);
  const dragOrigin = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const dragging = useRef(false);
  const suppressClick = useRef(false);
  const snapshot = useQuery({
    queryKey: ['floating-monitor'], queryFn: readFloatingMonitor, enabled: desktop && !paused && !docked,
    refetchInterval: query => paused || docked ? false : pollingInterval(liveSettings?.pollInterval ?? query.state.data?.settings?.pollInterval),
    refetchIntervalInBackground: true, refetchOnWindowFocus: false, retry: false,
  });
  const settings = liveSettings ?? snapshot.data?.settings;
  const lastSampleUpdatedAt = useRef(snapshot.dataUpdatedAt); lastSampleUpdatedAt.current = snapshot.dataUpdatedAt;
  const refreshSnapshot = useRef(snapshot.refetch); refreshSnapshot.current = snapshot.refetch;
  const samplingPaused = useRef(paused); samplingPaused.current = paused;
  const preferences = normalizeFloatingMonitorPreferences(settings?.floatingMonitor);
  const windowWidth = 220 + (preferences.showSampleTime ? 48 : 0);
  const language = settings?.language === 'en' ? 'en' : 'zh-CN';
  const theme = ['dark', 'light', 'system'].includes(settings?.theme ?? '') ? settings!.theme : 'system';
  const text = (zh: string, en: string) => language === 'zh-CN' ? zh : en;

  useEffect(() => {
    mounted.current = true;
    document.documentElement.dataset.window = 'monitor';
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { mounted.current = false; clearInterval(timer); delete document.documentElement.dataset.window; void menu.current?.close().catch(() => {}); menu.current = null; };
  }, []);
  useEffect(() => {
    void i18n.changeLanguage(language);
    document.documentElement.lang = language;
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; };
    apply(); media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [language, theme]);
  useEffect(() => {
    if (!desktop || !settings) return;
    void getCurrentWindow().setSize(new LogicalSize(windowWidth, 40)).catch(error => { if (mounted.current) setActionError(String(error)); });
  }, [desktop, !!settings, windowWidth]);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    void getCurrentWindow().isAlwaysOnTop().then(value => { if (!disposed) setPinned(value); }).catch(() => {});
    return () => { disposed = true; };
  }, [desktop]);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false, unlisten: (() => void) | undefined;
    void listen('monitor-restored', () => {
      if (!disposed) {
        setResumeAfter(lastSampleUpdatedAt.current); setDocked(false);
        if (!samplingPaused.current) void refreshSnapshot.current();
      }
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(error => { if (!disposed) setActionError(String(error)); });
    return () => { disposed = true; unlisten?.(); };
  }, [desktop]);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<NonNullable<FloatingMonitorSnapshot['settings']>>('monitor-preferences-changed', event => {
      if (!disposed) setLiveSettings(event.payload);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(error => {
      if (!disposed) setActionError(String(error));
    });
    return () => { disposed = true; unlisten?.(); };
  }, [desktop]);
  useEffect(() => {
    if (!desktop || !settings) return;
    const next = preferences.alwaysOnTop;
    const changed = pinPreference.current !== undefined ? pinPreference.current !== next : liveSettings !== undefined;
    pinPreference.current = next;
    if (changed) void getCurrentWindow().setAlwaysOnTop(next).then(() => setPinned(next)).catch(error => setActionError(String(error)));
  }, [desktop, !!settings, preferences.alwaysOnTop, liveSettings !== undefined]);
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(''), 4000);
    return () => clearTimeout(timer);
  }, [feedback]);

  const data = snapshot.data;
  const waitingForSample = !paused && resumeAfter !== null && snapshot.dataUpdatedAt <= resumeAfter;
  const stale = !!data && now - data.sampledAt > Math.max(15000, pollingInterval(settings?.pollInterval) * 3);
  const valid = !!data && !snapshot.isError && !stale && !waitingForSample;
  const online = valid && data.phase === 'online';
  const apiOnline = online || valid && data.phase === 'unavailable' && data.health?.service === 'strata' && data.health?.status === 'ok';
  const metric = online && data.metrics ? normalizeMetrics(data.metrics) : undefined;
  const displayMetric = metric && data?.health?.loaded === false ? { ...metric, state: 'unloaded', decodeTokS: null, prefillTokS: null } : metric;
  const error = actionError || (snapshot.isError ? text('后台不可用', 'Background unavailable') : !paused && stale ? text('等待新采样', 'Waiting for a fresh sample') : !paused && !waitingForSample ? data?.error ?? '' : '');
  const stateLabel = (state: string) => {
    const labels: Record<string, string> = {
      idle: text('空闲', 'Idle'), generating: text('生成中', 'Generating'), reading: text('读取中', 'Reading'),
      prefill: text('读取中', 'Reading'), loading: text('加载中', 'Loading'), unloaded: text('未加载', 'Not loaded'),
      unloading: text('释放中', 'Unloading'), running: text('运行中', 'Running'),
    };
    return labels[state] ?? text('状态未知', 'Unknown state');
  };
  type Action = FloatingMonitorAction | 'settings' | 'tray' | 'close';
  const label = (operation: Action) => operation === 'pin' && pinned ? text('取消置顶', 'Unpin monitor')
    : operation === 'pause' && paused ? text('恢复采样', 'Resume sampling')
    : operation === 'settings' ? text('自定义浮条', 'Customize monitor')
    : operation === 'tray' ? text('收起到系统托盘', 'Move to system tray')
    : operation === 'close' ? text('关闭浮条', 'Close monitor')
    : FLOATING_MONITOR_ACTIONS.find(item => item.id === operation)!.label[language];
  const disabled = (operation: Action) => !desktop || busy || operation === 'copyApiUrl' && !data?.profile?.baseUrl
    || operation === 'quickBenchmark' && (!online || data?.health?.loaded !== true || !displayMetric || ['generating', 'reading', 'prefill', 'loading', 'unloading'].includes(displayMetric.state) || (displayMetric.running ?? 0) > 0 || (displayMetric.queued ?? 0) > 0);
  const action = async (operation: Action) => {
    if (disabled(operation) || operating.current) return;
    operating.current = true; setBusy(true); setActionError(''); setFeedback('');
    try {
      if (operation === 'pin') { await getCurrentWindow().setAlwaysOnTop(!pinned); setPinned(value => !value); }
      else if (operation === 'close') await getCurrentWindow().close();
      else if (operation === 'tray') { await minimizeMonitorToTray(); setDocked(true); }
      else if (operation === 'pause') { if (paused) { setResumeAfter(snapshot.dataUpdatedAt); void snapshot.refetch(); } setPaused(value => !value); }
      else if (operation === 'refresh') {
        const result = await snapshot.refetch();
        if (result.error) throw result.error;
        setFeedback(text('已刷新', 'Refreshed'));
      } else if (operation === 'copyApiUrl') {
        if (!data?.profile?.baseUrl) return;
        await navigator.clipboard.writeText(data.profile.baseUrl);
        setFeedback(text('API 地址已复制', 'API address copied'));
      } else await showMainFromMonitor(operation === 'main' ? undefined : operation);
    } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { operating.current = false; setBusy(false); }
  };
  const actionRef = useRef(action); actionRef.current = action;
  const openMenu = async (position?: LogicalPosition) => {
    if (!desktop || openingMenu.current || operating.current) return;
    openingMenu.current = true;
    try {
      await menu.current?.close(); menu.current = null;
      const items: NonNullable<MenuOptions['items']> = FLOATING_MONITOR_ACTIONS.map(item => ({
        id: item.id, text: label(item.id), enabled: !disabled(item.id),
        ...(['pause', 'pin'].includes(item.id) ? { checked: item.id === 'pause' ? paused : pinned } : {}),
        action: () => { void actionRef.current(item.id); },
      }));
      items.push({ item: 'Separator' }, { id: 'tray', text: label('tray'), action: () => { void actionRef.current('tray'); } }, { id: 'settings', text: label('settings'), action: () => { void actionRef.current('settings'); } }, { id: 'close', text: label('close'), action: () => { void actionRef.current('close'); } });
      const next = await Menu.new({ items });
      if (!mounted.current) { await next.close(); return; }
      menu.current = next;
      await next.popup(position, getCurrentWindow());
    } catch (error) { if (mounted.current) setActionError(error instanceof Error ? error.message : String(error)); }
    finally { openingMenu.current = false; }
  };

  return <div className="floating-telemetry-window official-surface" aria-label={text('桌面监控浮条', 'Floating desktop monitor')} tabIndex={0}
    onPointerDownCapture={event => {
      if (!desktop || event.button !== 0 || !event.isPrimary || dragging.current) return;
      suppressClick.current = false;
      dragOrigin.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    }}
    onPointerMoveCapture={event => {
      const origin = dragOrigin.current;
      if (!origin || event.pointerId !== origin.pointerId || !(event.buttons & 1) || dragging.current || Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < 4) return;
      dragOrigin.current = null; dragging.current = true; suppressClick.current = true;
      event.preventDefault();
      void getCurrentWindow().startDragging().catch(error => { if (mounted.current) setActionError(String(error)); }).finally(() => { dragging.current = false; });
    }}
    onPointerUpCapture={() => { dragOrigin.current = null; }}
    onPointerCancel={() => { dragOrigin.current = null; }}
    onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }}
    onContextMenu={event => { event.preventDefault(); void openMenu(new LogicalPosition(event.clientX, event.clientY)); }}
    onKeyDown={event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); void openMenu(); } }}>
    <header className="floating-telemetry-header">
      <div className="floating-telemetry-message">
        {error ? <span className="floating-telemetry-notice" data-tooltip={error} role="status">{text('状态待核验', 'Unverified')}</span> : feedback ? <span data-tooltip={feedback} role="status">{feedback}</span> : preferences.showSampleTime && data?.sampledAt ? <time className="floating-telemetry-time" data-tooltip={text('最近采样', 'Last sample')} dateTime={new Date(data.sampledAt).toISOString()}>{new Date(data.sampledAt).toLocaleTimeString(language, { hour12: false })}</time> : null}
      </div>
    </header>
    {paused || waitingForSample ? <footer className="workspace-statusbar service-telemetry-statusbar" data-state={paused ? 'paused' : 'waiting'} role="status"><span>{paused ? text('采样已暂停', 'Sampling paused') : text('等待新采样', 'Waiting for a fresh sample')}</span>{paused && <span className="floating-telemetry-paused-hint">{text('恢复采样后更新指标', 'Resume sampling to update metrics')}</span>}</footer>
      : <ServiceTelemetryStatusBar language={language} hasProfile={!!data?.profile || snapshot.isError || snapshot.isPending} online={apiOnline} connecting={snapshot.isPending && desktop} stopped={valid && data.phase === 'stopped'} metric={displayMetric} unavailable={!valid || data.phase === 'unavailable'} stateLabel={stateLabel}/>}
  </div>;
}

function pollingInterval(value?: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(30000, Math.max(1000, value)) : 2000;
}
