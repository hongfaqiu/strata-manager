import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from '../../src/App';
import { RuntimeConfigPage } from '../../src/pages/RuntimeConfigPage';
import i18n from '../../src/i18n';
import '../../src/styles.css';
import '../../src/official/tokens.css';
import '../../src/official/components.css';
import '../../src/official-controls.css';
import '../../src/official-pages.css';

const query = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
Object.assign(window, { __query: query, __i18n: i18n });
function RemoteFixture() {
  const [dirty, setDirty] = React.useState(false);
  return <><output data-testid="dirty">{String(dirty)}</output><RuntimeConfigPage profile={{ id: 'remote-fixture', name: 'Remote fixture', baseUrl: 'http://127.0.0.1:19003', installDir: '', configPath: '', pythonPath: '', managed: false }} online language="zh-CN" desktop onError={() => {}} onDirtyChange={setDirty}/></>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={query}>{location.search.includes('remote') ? <RemoteFixture/> : <App/>}</QueryClientProvider>);
