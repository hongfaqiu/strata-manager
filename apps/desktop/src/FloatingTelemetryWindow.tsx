import { isAppLanguage } from '@strata-manager/core';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Menu, type MenuOptions } from '@tauri-apps/api/menu';
import { LogicalPosition } from '@tauri-apps/api/dpi';
import { listen } from '@tauri-apps/api/event';
import { floatingMonitorDimensions, isDesktop, modelTelemetry, normalizeMetrics } from '@strata-manager/core';
import i18n from './i18n';
import { FloatingMonitorContent } from './FloatingMonitorContent';
import { appendMonitorHistory, type MonitorHistory } from './floatingMonitorHistory';
import { FLOATING_MONITOR_ACTIONS, moveMonitorToTaskbar, normalizeFloatingMonitorPreferences, readFloatingMonitor, readMonitorModeStatus, resizeMonitorWindow, setMonitorRows, showMainFromMonitor, type MonitorModeStatus, type FloatingMonitorAction, type FloatingMonitorSnapshot } from './floatingMonitor';
import './floating-telemetry-window.css';

export function FloatingTelemetryWindow() {
  const desktop = isDesktop();
  const [pinned, setPinned] = useState(true);
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [docked, setDocked] = useState(false);
  // Only Windows can host the taskbar widget; elsewhere the strip has no "move to taskbar" entry.
  const [taskbarSupported, setTaskbarSupported] = useState(false);
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
  // Fall back to two rows rather than run a single row off a narrow screen.
  const maxWidth = typeof window !== 'undefined' && window.screen?.availWidth ? window.screen.availWidth - 16 : undefined;
  const dimensions = floatingMonitorDimensions(preferences, settings?.language === 'en' ? 'en' : 'zh-CN', maxWidth);
  const [history, setHistory] = useState<MonitorHistory>({ identity: '', points: [] });
  const language = isAppLanguage(settings?.language) ? settings.language : 'en';
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
    void resizeMonitorWindow(dimensions.width, dimensions.height).catch(error => { if (mounted.current) setActionError(String(error)); });
  }, [desktop, !!settings, dimensions.width, dimensions.height]);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    void getCurrentWindow().isAlwaysOnTop().then(value => { if (!disposed) setPinned(value); }).catch(() => {});
    return () => { disposed = true; };
  }, [desktop]);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false, unlisten: (() => void) | undefined;
    void listen('monitor-suspended', () => { if (!disposed) setDocked(true); })
      .then(stop => { if (disposed) stop(); else unlisten = stop; })
      .catch(error => { if (!disposed) setActionError(String(error)); });
    return () => { disposed = true; unlisten?.(); };
  }, [desktop]);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false, unlisten: (() => void) | undefined;
    void readMonitorModeStatus().then(status => { if (!disposed) setTaskbarSupported(status.supported === true); }).catch(() => {});
    void listen<MonitorModeStatus>('monitor-mode-status', event => {
      if (disposed) return;
      setTaskbarSupported(event.payload.supported === true);
      // A closed host also reports floating/inactive while this window stays hidden.
      // Only monitor-restored may resume this window's sampling.
      if (event.payload.mode === 'taskbar' && event.payload.active) setDocked(true);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; unlisten?.(); };
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
  const metric = online && data.metrics ? normalizeMetrics(data.metrics) : undefined;
  const displayMetric = modelTelemetry(metric, typeof data?.health?.loaded === 'boolean' ? data.health.loaded : undefined);
  const historyIdentity = [data?.profile?.id, data?.process?.pid, data?.process?.startedAt, data?.process?.creationTime, metric?.model].join('|');
  const fresh = valid && !paused && !waitingForSample;
  useEffect(() => {
    setHistory(previous => appendMonitorHistory(previous, historyIdentity, fresh ? data!.sampledAt : now, fresh ? displayMetric : undefined, fresh && data?.health?.loaded === true));
  // Each snapshot is immutable. Timer ticks add gaps only while sampling is unavailable.
  }, [historyIdentity, data, fresh, fresh ? 0 : now]);
  const error = actionError || (snapshot.isError ? text('后台不可用', 'Background unavailable') : !paused && stale ? text('等待新采样', 'Waiting for a fresh sample') : !paused && !waitingForSample ? data?.error ?? '' : '');
  const stateLabel = (state: string) => {
    const labels: Record<string, string> = {
      idle: text('空闲', 'Idle'), generating: text('生成中', 'Generating'), reading: text('读取中', 'Reading'),
      prefill: text('读取中', 'Reading'), loading: text('正在载入模型', 'Loading model'), unloaded: text('未加载', 'Not loaded'),
      unloading: text('释放中', 'Unloading'), running: text('运行中', 'Running'),
    };
    return labels[state] ?? text('状态未知', 'Unknown state');
  };
  type Action = FloatingMonitorAction | 'settings' | 'taskbar' | 'close';
  const label = (operation: Action) => operation === 'pin' && pinned ? text('取消置顶', 'Unpin monitor')
    : operation === 'pause' && paused ? text('恢复采样', 'Resume sampling')
    : operation === 'settings' ? text('自定义浮条', 'Customize monitor')
    : operation === 'taskbar' ? text('收起到任务栏监控', 'Move to taskbar monitor')
    : operation === 'close' ? text('关闭浮条', 'Close monitor')
    : FLOATING_MONITOR_ACTIONS.find(item => item.id === operation)!.label[(language === 'zh-CN' ? 'zh-CN' : 'en')];
  const disabled = (operation: Action) => !desktop || busy || operation === 'copyApiUrl' && !data?.profile?.baseUrl
    || operation === 'quickBenchmark' && (!online || data?.health?.loaded !== true || !displayMetric || ['generating', 'reading', 'prefill', 'loading', 'unloading'].includes(displayMetric.state) || (displayMetric.running ?? 0) > 0 || (displayMetric.queued ?? 0) > 0);
  const action = async (operation: Action) => {
    if (disabled(operation) || operating.current) return;
    operating.current = true; setBusy(true); setActionError(''); setFeedback('');
    try {
      if (operation === 'pin') { await getCurrentWindow().setAlwaysOnTop(!pinned); setPinned(value => !value); }
      else if (operation === 'close') await getCurrentWindow().close();
      else if (operation === 'taskbar') {
        const status = await moveMonitorToTaskbar(preferences, language);
        if (!(status.mode === 'taskbar' && status.active)) throw new Error(status.message || text('任务栏监控未能显示，已保留桌面浮条', 'The taskbar monitor could not be shown; the desktop strip stays open'));
        setDocked(true);
      }
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
      // 文字行数: the same auto / single / double choice as the settings page. The panel stays a grid.
      const rows = preferences.rows ?? 'auto';
      const rowChoices = [['auto', text('自动', 'Auto')], ['single', text('单行', 'One row')], ['double', text('两行', 'Two rows')]] as const;
      items.push({ item: 'Separator' }, {
        id: 'rows', text: text('文字行数', 'Text rows'), enabled: preferences.layout !== 'panel',
        items: rowChoices.map(([id, choice]) => ({ id: `rows-${id}`, text: choice, checked: rows === id, action: () => { if (id !== rows) void setMonitorRows(id).catch(error => setActionError(error instanceof Error ? error.message : String(error))); } })),
      });
      items.push({ item: 'Separator' }, ...(taskbarSupported ? [{ id: 'taskbar', text: label('taskbar'), action: () => { void actionRef.current('taskbar'); } }] : []), { id: 'settings', text: label('settings'), action: () => { void actionRef.current('settings'); } }, { id: 'close', text: label('close'), action: () => { void actionRef.current('close'); } });
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
    <FloatingMonitorContent preferences={preferences} maxWidth={maxWidth} language={language} metric={fresh ? displayMetric : undefined}
      history={fresh && history.identity === historyIdentity ? history.points : []} loaded={data?.health?.loaded === true} sampledAt={data?.sampledAt}
      message={error || feedback} status={paused ? text('采样已暂停', 'Sampling paused') : waitingForSample || stale ? text('等待新采样', 'Waiting for fresh data') : valid && data.phase === 'stopped' ? text('未启动', 'Stopped') : valid && data.phase === 'none' ? text('未选择服务', 'No service selected') : displayMetric ? stateLabel(displayMetric.state) : valid && data.phase === 'unavailable' ? text('监控不可用', 'Metrics unavailable') : text('状态待核验', 'Unverified')}/>
  </div>;
}

function pollingInterval(value?: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(30000, Math.max(1000, value)) : 2000;
}
