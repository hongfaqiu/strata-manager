import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './i18n';
import { App } from './App';
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

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 1000, refetchOnWindowFocus: false } } });
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><QueryClientProvider client={client}>{new URLSearchParams(location.search).get('window') === 'monitor' ? <FloatingTelemetryWindow/> : <App />}<TooltipLayer/></QueryClientProvider></React.StrictMode>,
);
