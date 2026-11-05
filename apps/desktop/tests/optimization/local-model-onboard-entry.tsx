import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '../../src/i18n';
import { ModelDownloadPage } from '../../src/pages/ModelDownloadPage';
import { ServiceManagerPage } from '../../src/pages/ServiceManagerPage';
import type { ExistingPrefill } from '../../src/pages/downloadedModels';
import '../../src/styles.css';
import '../../src/official/tokens.css';
import '../../src/official/components.css';
import '../../src/official-controls.css';
import '../../src/official-pages.css';
import '../../src/official-alignment.css';

// Isolated fixture for 「发现 N 个已下载模型 · 一键加入」, 在线下载 | 使用已有模型 and 本机已有 · 直接使用: native IO is mocked.
// `?none` has no downloaded models; `&view=models` is 我的模型 (empty); `&en` switches to English.
const params = new URLSearchParams(location.search);
const language = params.has('en') ? 'en' : 'zh-CN';
void i18n.changeLanguage(language);
document.documentElement.lang = language;
const base = 'C:\\Users\\me\\Documents\\Strata\\Models';
const shards = (name: string, count: number, bytes: number) => Array.from({ length: count }, (_, i) => ({ name: `${name}-${String(i + 1).padStart(5, '0')}-of-${String(count).padStart(5, '0')}.gguf`, bytes: bytes / count, state: 'ok' }));
const group = (id: string, name: string, family: string, quant: string, count: number, bytes: number) => ({ id, name, firstShard: shards(name, count, bytes)[0]!.name, quant, kind: 'official', family, shards: shards(name, count, bytes), totalBytes: bytes, complete: true, installable: true, warnings: [], problems: [] });
const v31 = params.has('v31');
const found = params.has('none') ? [] : v31 ? [
  { directory: `${base}\\ud-iq1_m`, root: base, group: group('unsloth-ud-iq1_m', 'Qwen3.8-Flash-Next-UD-IQ1_M', 'unsloth', 'UD-IQ1_M', 3, 68e9) },
  { directory: `${base}\\ud-iq4-xs-v31`, root: base, group: group('unsloth-ud-iq4-xs-v31', 'Qwen3.8-Flash-Next-UD-IQ4_XS', 'unsloth', 'UD-IQ4_XS-v31', 4, 93.7e9) },
] : [
  { directory: `${base}\\iq3_s`, root: base, group: group('qwen-iq3_s', 'Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S', 'qwen', 'IQ3_S', 2, 79.6e9) },
  { directory: `${base}\\swift-iq2_xs`, root: base, group: group('swift-iq2_xs', 'Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ2_XS', 'swift', 'IQ2_XS', 2, 56.1e9) },
];
const profile = { id: 'rt', name: 'Strata', baseUrl: 'http://127.0.0.1:8080', installDir: 'C:\\Users\\me\\AppData\\Local\\Programs\\Strata\\control', pythonPath: '', configPath: '', managed: true };
Object.assign(window, {
  __TAURI_INTERNALS__: {
    async invoke(command: string, args: Record<string, unknown> = {}) {
      if (command === 'find_downloaded_models') return structuredClone(found);
      if (command === 'scan_local_models') { const item = found.find(model => model.directory === args.path); return { directory: String(args.path), selectedFile: null, groups: item ? [structuredClone(item.group)] : [], problems: item ? [] : ['没有找到 GGUF 文件'] }; }
      if (command === 'setup_disk_preflight') return { status: 'ready', dataDirectory: 'C:\\Users\\me\\Documents\\Strata', modelDirectory: base, modelDownloadBytesEstimate: 79.6e9, reusableModelBytes: args.localModel ? 79.6e9 : 0, additionalBytesEstimate: args.localModel ? 2e9 : 86e9, estimate: true, volumes: [{ directory: 'C:\\Users\\me\\Documents\\Strata', mountPoint: 'C:\\', availableBytes: 612e9, requiredAdditionalBytesEstimate: 86e9 }], reason: '', source: 'fixture' };
      if (command === 'list_local_models') return [];
      if (command === 'list_tasks') return [];
      if (command === 'read_config') return null;
      if (command === 'store_get' || command === 'store_set') return null;
      if (command.startsWith('plugin:')) return null;
      console.warn(`fixture: unmocked ${command}`);
      return null;
    },
  },
});
const query = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
const noop = async () => undefined;
function View() {
  const [view, setView] = useState(params.get('view') ?? 'download');
  const [request, setRequest] = useState<ExistingPrefill>();
  return view === 'models'
    ? <ServiceManagerPage profiles={[]} candidates={[]} runtimes={[]} language={language} desktop pollInterval={60000} onUseDownloaded={model => { setRequest({ directory: model.directory, groupId: model.group.id, key: Date.now() }); setView('download'); }} onSelect={() => undefined} onAdd={() => undefined} onImport={() => undefined} onEdit={() => undefined} onLogs={() => undefined} onDelete={() => undefined} {...({} as never)}/>
    : <ModelDownloadPage language={language} desktop machineMemoryGB={128} platform="windows" gpus={['NVIDIA GeForce RTX 4090 24 GB']} fallbackRuntime={profile} runtimes={[profile]} runtimeVersions={[{ installDir: profile.installDir, runtimeVersion: v31 ? '0.1.57' : '0.1.56', releaseVersion: v31 ? '0.2.11' : '0.2.10' }]} windows busy={false} tasks={[]}
      onRuntimeChange={() => undefined} onChooseDirectory={async () => null} onChooseFile={async () => null} onPrepare={noop} onLocalSetup={noop} onImportConfig={noop} onOrcaImport={noop} onTasks={() => undefined} onEnvironment={() => undefined} existingRequest={request}/>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={query}><div className="manager-workspace"><main className="main-content"><View/></main></div></QueryClientProvider>);
