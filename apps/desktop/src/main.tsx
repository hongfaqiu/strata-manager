import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './i18n';
import { isTauri } from '@tauri-apps/api/core';
import { App } from './App';
import { detectWindowChrome } from './windowChrome.mjs';
import { FloatingTelemetryWindow } from './FloatingTelemetryWindow';
import { TooltipLayer } from './TooltipLayer';
import './official/tokens.css';
import './official/components.css';
import './styles.css';
import './official-alignment.css';
import './official-controls.css';
import './official/scoped-components.css';
import './official/scoped-app.css';
import './official/api-monitor.css';
import './official-pages.css';

const monitorWindow = new URLSearchParams(location.search).get('window') === 'monitor';
// Main window only: the floating strip is a borderless panel on every system.
// `?chrome=macos|custom` previews the other platform's header in dev builds.
if (!monitorWindow) document.documentElement.dataset.windowChrome = detectWindowChrome({
  desktop: isTauri(),
  platform: (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform,
  userAgent: navigator.userAgent,
  override: import.meta.env.DEV ? new URLSearchParams(location.search).get('chrome') : null,
});

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 1000, refetchOnWindowFocus: false } } });
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><QueryClientProvider client={client}>{monitorWindow ? <FloatingTelemetryWindow/> : <App />}<TooltipLayer/></QueryClientProvider></React.StrictMode>,
);
