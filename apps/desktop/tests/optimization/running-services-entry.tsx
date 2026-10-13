import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LocalCandidate } from '@strata-manager/core';
import { RunningServicesPanel } from '../../src/pages/RunningServicesPanel';
import '../../src/official/tokens.css';
import '../../src/official/components.css';
import '../../src/styles.css';
import '../../src/official-alignment.css';
import '../../src/official-controls.css';
import '../../src/official-pages.css';

type Fixture = { actions: { action: string; candidateId: string }[]; failure?: string; release?: () => void };
const fixture = (window as unknown as { __runningFixture: Fixture }).__runningFixture;
const params = new URLSearchParams(location.search);
const candidate: LocalCandidate = { id: 'running-service-fixture', name: 'qwen-fixture-IQ3_S', running: true, pid: 99091, detectedPort: 19091, installDir: 'D:\\Fixture\\Strata', pythonPath: 'D:\\Fixture\\python.exe', configPath: 'C:\\Fixture\\Manager\\imports\\running-service-fixture\\config.json', modelPath: 'D:\\Fixture\\Model\\qwen-fixture.gguf', modelBytes: null, configModifiedAt: 1791907223000, runtimeVersion: '0.1.43.1', config: { model_name: 'qwen-fixture-IQ3_S', lazy_load: true } };
const action = async (name: string, service: LocalCandidate) => {
  fixture.actions.push({ action: name, candidateId: service.id });
  await new Promise<void>(resolve => { fixture.release = resolve; });
  fixture.release = undefined;
  if (fixture.failure) throw fixture.failure;
};
const query = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
document.body.style.padding = '24px';
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={query}><RunningServicesPanel candidates={[candidate]} language={params.get('language') === 'en' ? 'en' : 'zh-CN'} onRefresh={() => {}} onConnect={item => action('connect', item)} onManage={item => action('manage', item)}/></QueryClientProvider>);
