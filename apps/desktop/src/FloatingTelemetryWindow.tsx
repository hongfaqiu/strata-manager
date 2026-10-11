import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GripVertical, Pin, PinOff, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isDesktop, normalizeMetrics } from '@strata-manager/core';
import i18n from './i18n';
import { AppLogo } from './AppLogo';
import { ServiceTelemetryStatusBar } from './layouts/ServiceTelemetryStatusBar';
import { readFloatingMonitor, showMainFromMonitor } from './floatingMonitor';
import './floating-telemetry-window.css';

export function FloatingTelemetryWindow() {
  const desktop = isDesktop();
  const [pinned, setPinned] = useState(true);
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  const operating = useRef(false);
  const snapshot = useQuery({
    queryKey: ['floating-monitor'], queryFn: readFloatingMonitor, enabled: desktop,
    refetchInterval: query => pollingInterval(query.state.data?.settings?.pollInterval),
    refetchIntervalInBackground: true, refetchOnWindowFocus: false, retry: false,
  });
  const settings = snapshot.data?.settings;
  const language = settings?.language === 'en' ? 'en' : 'zh-CN';
  const theme = ['dark', 'light', 'system'].includes(settings?.theme ?? '') ? settings!.theme : 'system';
  const text = (zh: string, en: string) => language === 'zh-CN' ? zh : en;

  useEffect(() => {
    document.documentElement.dataset.window = 'monitor';
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(timer); delete document.documentElement.dataset.window; };
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
    if (!desktop) return;
    let disposed = false;
    void getCurrentWindow().isAlwaysOnTop().then(value => { if (!disposed) setPinned(value); }).catch(() => {});
    return () => { disposed = true; };
  }, [desktop]);

  const data = snapshot.data;
  const stale = !!data && now - data.sampledAt > Math.max(15000, pollingInterval(settings?.pollInterval) * 3);
  const valid = !!data && !snapshot.isError && !stale;
  const online = valid && data.phase === 'online';
  const apiOnline = online || valid && data.phase === 'unavailable' && data.health?.service === 'strata' && data.health?.status === 'ok';
  const metric = online && data.metrics ? normalizeMetrics(data.metrics) : undefined;
  const displayMetric = metric && data?.health?.loaded === false ? { ...metric, state: 'unloaded', decodeTokS: null, prefillTokS: null } : metric;
  const error = actionError || (snapshot.isError ? text('后台不可用', 'Background unavailable') : stale ? text('等待新采样', 'Waiting for a fresh sample') : data?.error ?? '');
  const stateLabel = (state: string) => {
    const labels: Record<string, string> = {
      idle: text('空闲', 'Idle'), generating: text('生成中', 'Generating'), reading: text('读取中', 'Reading'),
      prefill: text('读取中', 'Reading'), loading: text('加载中', 'Loading'), unloaded: text('未加载', 'Not loaded'),
      unloading: text('释放中', 'Unloading'), running: text('运行中', 'Running'),
    };
    return labels[state] ?? text('状态未知', 'Unknown state');
  };
  const action = async (operation: 'pin' | 'close' | 'main') => {
    if (!desktop || operating.current) return;
    operating.current = true; setBusy(true); setActionError('');
    try {
      if (operation === 'pin') { await getCurrentWindow().setAlwaysOnTop(!pinned); setPinned(value => !value); }
      else if (operation === 'close') await getCurrentWindow().close();
      else await showMainFromMonitor();
    } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { operating.current = false; setBusy(false); }
  };

  return <div className="floating-telemetry-window official-surface" aria-label={text('桌面监控浮条', 'Floating desktop monitor')}>
    <header className="floating-telemetry-header">
      <div className="floating-telemetry-drag" data-tauri-drag-region={desktop ? 'deep' : undefined} title={text('拖动浮条', 'Drag monitor')}>
        <GripVertical size={14}/><AppLogo size={18}/><span>{text('监控', 'Monitor')}</span>
      </div>
      <button type="button" className="floating-telemetry-profile" onClick={() => void action('main')} disabled={busy || !desktop} title={`${data?.profile?.name ?? 'Strata Manager'} · ${text('显示主窗口', 'Show main window')}`}>{data?.profile?.name ?? 'Strata Manager'}</button>
      {error ? <span className="floating-telemetry-notice" title={error} role="status">{text('状态待核验', 'Unverified')}</span> : data?.sampledAt ? <time className="floating-telemetry-time" title={text('最近采样', 'Last sample')} dateTime={new Date(data.sampledAt).toISOString()}>{new Date(data.sampledAt).toLocaleTimeString(language, { hour12: false })}</time> : null}
      <div className="floating-telemetry-actions">
        <button type="button" onClick={() => void action('pin')} disabled={busy || !desktop} aria-pressed={pinned} aria-label={pinned ? text('取消置顶', 'Unpin monitor') : text('置顶浮条', 'Keep monitor on top')} title={pinned ? text('取消置顶', 'Unpin monitor') : text('置顶浮条', 'Keep monitor on top')}>{pinned ? <Pin size={14}/> : <PinOff size={14}/>}</button>
        <button type="button" onClick={() => void action('close')} disabled={busy || !desktop} aria-label={text('关闭浮条', 'Close monitor')} title={text('关闭浮条', 'Close monitor')}><X size={15}/></button>
      </div>
    </header>
    <ServiceTelemetryStatusBar language={language} hasProfile={!!data?.profile || snapshot.isError || snapshot.isPending} online={apiOnline} connecting={snapshot.isPending && desktop} stopped={valid && data.phase === 'stopped'} metric={displayMetric} unavailable={!valid || data.phase === 'unavailable'} stateLabel={stateLabel}/>
  </div>;
}

function pollingInterval(value?: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(10000, Math.max(1000, value)) : 2000;
}
