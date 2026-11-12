import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from '../../src/App';
import { TooltipLayer } from '../../src/TooltipLayer';
import { StartupTuningPanel } from '../../src/pages/StartupTuningPanel';
import i18n from '../../src/i18n';
import '../../src/official/tokens.css';
import '../../src/official/components.css';
import '../../src/styles.css';
import '../../src/official-alignment.css';
import '../../src/official-controls.css';
import '../../src/official/scoped-components.css';
import '../../src/official/scoped-app.css';
import '../../src/official-pages.css';

// `?panel` renders the real startup parameter panel (#226); otherwise the real App on #tasks (#225). `&en` = English.
const params = new URLSearchParams(location.search);
const language = params.has('en') ? 'en' : 'zh-CN';
const store = (window as unknown as { __fixture: { store: { settings: Record<string, unknown> }; profiles: unknown[] } }).__fixture;
store.store.settings.language = language;
void i18n.changeLanguage(language);
const query = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
const profile = store.profiles[0] as Parameters<typeof StartupTuningPanel>[0]['profile'];
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={query}>{params.has('panel')
  ? <div className="manager-workspace" style={{ padding: 24, maxWidth: 980 }}><StartupTuningPanel profile={profile} desktop language={language} onError={() => undefined}/></div>
  : <App/>}<TooltipLayer/></QueryClientProvider>);
