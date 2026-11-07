import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '../../src/i18n';
import { ModelDownloadPage } from '../../src/pages/ModelDownloadPage';
import '../../src/styles.css';
import '../../src/official/tokens.css';
import '../../src/official/components.css';
import '../../src/official-controls.css';
import '../../src/official-pages.css';
import '../../src/official-alignment.css';

// Isolated fixture for the official NVFP4 family (#214): native IO is mocked.
// `?amd` has only an AMD card (NVFP4 greyed out with the reason); `&en` switches to English; `&found` has a converted
// NVFP4-QAD checkpoint under <data>/models so 「使用已有模型」 can be shown.
const params = new URLSearchParams(location.search);
const language = params.has('en') ? 'en' : 'zh-CN';
void i18n.changeLanguage(language);
document.documentElement.lang = language;
const data = 'D:\\Strata-data';
const qadFolder = `${data}\\models\\nvidia--Qwen3.8-Flash-Next-FP4-Local`;
const qad = { id: 'nvidia--Qwen3.8-Flash-Next-FP4-Local', name: 'nvidia--Qwen3.8-Flash-Next-FP4-Local', firstShard: 'tensors/', quant: 'NVFP4-QAD', kind: 'official', family: 'nvfp4',
  shards: [{ name: 'prepared/dense.gguf', bytes: 6.1e9, state: 'ok', expectedBytes: 6.1e9 }, { name: 'prepared/ple-nvfp4.gguf', bytes: 28.8e9, state: 'ok', expectedBytes: 28.8e9 }],
  totalBytes: 34.9e9, complete: true, installable: true, warnings: ['仅 NVIDIA 显卡：AMD、Intel 和 Mac 的引擎没有 NVFP4 内核', '已在本机转换完成；tensors/ 下约 102 GB 的源文件不再需要，可以删除'], problems: [] };
const found = params.has('found') ? [{ directory: qadFolder, root: `${data}\\models`, group: qad }] : [];
// disk_nvfp4::plan: the files, QAD's 110 GB conversion + 4 GB PyTorch, the ready packs' 8 GB MTP layer, 2 GB room.
const need: Record<string, number> = { NVFP4: 138e9, 'NVFP4-NVIDIA': 138e9, 'NVFP4-QAD': 218.2e9 };
const profile = { id: 'rt', name: 'Strata', baseUrl: 'http://127.0.0.1:8080', installDir: 'C:\\Users\\me\\AppData\\Local\\Programs\\Strata\\control', pythonPath: '', configPath: '', managed: true };
Object.assign(window, {
  __TAURI_INTERNALS__: {
    async invoke(command: string, args: Record<string, unknown> = {}) {
      if (command === 'find_downloaded_models') return structuredClone(found);
      if (command === 'scan_local_models') return { directory: qadFolder, selectedFile: null, groups: [structuredClone(qad)], problems: [] };
      if (command === 'setup_disk_preflight') {
        const local = !!args.localModel;
        const bytes = local ? 2e9 : need[String(args.quant)] ?? 86e9;
        return { status: 'ready', dataDirectory: data, modelDirectory: `${data}\\models`, modelDownloadBytesEstimate: local ? 0 : bytes, reusableModelBytes: 0, additionalBytesEstimate: bytes, estimate: true, volumes: [{ directory: data, mountPoint: 'D:\\', availableBytes: 1840e9, requiredAdditionalBytesEstimate: bytes }], reason: '', source: 'fixture' };
      }
      if (command === 'list_local_models' || command === 'list_tasks') return [];
      if (command === 'read_config' || command === 'store_get' || command === 'store_set' || command.startsWith('plugin:')) return null;
      console.warn(`fixture: unmocked ${command}`);
      return null;
    },
  },
});
const gpus = params.has('amd') ? ['AMD Radeon AI PRO R9700, 32624 MiB'] : ['NVIDIA GeForce RTX 5090, 581.15, 32607 MiB'];
const query = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
const noop = async () => undefined;
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={query}><div className="manager-workspace"><main className="main-content">
  <ModelDownloadPage language={language} desktop machineMemoryGB={128} platform="windows" gpus={gpus} fallbackRuntime={profile} runtimes={[profile]} runtimeVersions={[{ installDir: profile.installDir, runtimeVersion: '0.1.57', releaseVersion: '0.2.11' }]} windows busy={false} tasks={[]}
    onRuntimeChange={() => undefined} onChooseDirectory={async () => null} onChooseFile={async () => null} onPrepare={noop} onLocalSetup={noop} onImportConfig={noop} onOrcaImport={noop} onTasks={() => undefined} onEnvironment={() => undefined}
    existingRequest={params.has('found') ? { directory: qadFolder, groupId: qad.id, key: 1 } : undefined}/>
</main></div></QueryClientProvider>);
