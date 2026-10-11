import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RuntimeManagementPanel } from '../../src/pages/RuntimeManagementPanel';
import '../../src/styles.css';
import '../../src/official/tokens.css';
import '../../src/official/components.css';
import '../../src/official-controls.css';
import '../../src/official-pages.css';
import '../../src/official-alignment.css';

// Native IO is mocked; sessionStorage persists fixture preferences across reloads.
// This fixture cannot read a ZIP, download a file or stop a real service.
const runtime = { installDir: 'D:\\Fixture\\Strata', pythonPath: 'D:\\Fixture\\python.exe', runtimeVersion: '0.1.42', readiness: 'ready' as const };
const release = {
  supportedVersion: '0.1.43', latestVersion: '0.1.43', releaseName: 'Strata 0.1.43', checkedAt: 100,
  installable: true, sourceRevision: 'a'.repeat(40), notes: '## 更新\n\n- 改善下载体验。\n\n## Changes\n\n- Better downloads.',
  releaseUrl: 'https://github.com/Niko1221/Strata/releases/tag/v0.1.43',
  assets: ['strata-windows-x64.zip', 'strata-windows-x64-cuda12.zip'].map((name, index) => ({ name, variant: index ? 'cuda12' : 'cuda13', size: 137300495, sha256: String(index + 1).repeat(64), url: `https://github.com/Niko1221/Strata/releases/download/v0.1.43/${name}` })),
};
const fixture = { calls: [] as { command: string; args: Record<string, unknown> }[], tasks: [] as object[], logs: [] as object[], pick: 'D:\\Downloads\\Strata engine.zip' as string | null, resolveFailure: false, release };
const storePrefix = 'runtime-download-fixture:';
if (new URLSearchParams(location.search).has('latest')) runtime.runtimeVersion = '0.1.43';
if (new URLSearchParams(location.search).has('unknown')) fixture.resolveFailure = true;
Object.assign(window, {
  __fixture: fixture,
  __TAURI_INTERNALS__: {
    async invoke(command: string, args: Record<string, unknown> = {}) {
      fixture.calls.push({ command, args });
      if (command === 'local_installations') return [];
      if (command === 'runtime_update_info') return release;
      if (command === 'resolve_runtime_zip_asset') {
        if (fixture.resolveFailure) throw new Error('Unknown installed engine; select a package explicitly');
        return args.assetName ? release.assets.find(asset => asset.name === args.assetName) : release.assets[1];
      }
      if (command === 'list_tasks') return fixture.tasks;
      if (command === 'read_task_logs' || command === 'read_logs') return fixture.logs;
      if (command === 'plugin:dialog|open') return fixture.pick;
      if (command === 'store_get') {
        const value = sessionStorage.getItem(storePrefix + String(args.key));
        return value === null ? null : JSON.parse(value);
      }
      if (command === 'store_set') {
        sessionStorage.setItem(storePrefix + String(args.key), JSON.stringify(args.value));
        return null;
      }
      if (command === 'test_runtime_zip_download') {
        const local = !!args.localArchivePath;
        return { source: local ? 'local' : args.downloadUrl ? 'mirror' : 'official', assetName: args.assetName,
          checkedAt: Date.now(), checkedBytes: local ? 137300495 : 65536, totalBytes: 137300495,
          rangeSupported: local ? undefined : true, sha256Verified: local };
      }
      if (command === 'update_runtime_zip') {
        const task = { id: 'fixture-update', kind: 'update', state: 'running', message: '隔离更新任务已接收', startedAt: Date.now() };
        fixture.tasks.push(task); return task;
      }
      if (command === 'cancel_task') { fixture.tasks.splice(0); return null; }
      throw new Error(`Unexpected native command: ${command}`);
    },
  },
});
const query = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
query.setQueryData(['runtime-update-info'], release);
query.setQueryData(['tasks'], []);
const language = location.search.includes('en') ? 'en' : 'zh-CN';
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={query}><div className="manager-workspace"><main className="main-content"><p role="note">{language === 'zh-CN' ? '隔离测试界面 · 原生文件与下载操作为模拟，未执行真实升级' : 'Isolated test fixture · Native file/download IO is mocked; no real upgrade'}</p><RuntimeManagementPanel language={language} desktop installationStatus={{ detectedRuntimes: [runtime] }} autoCheck={false}/></main></div></QueryClientProvider>);
