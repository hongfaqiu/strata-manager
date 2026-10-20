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

// Isolated Linux x86_64 fixture: native IO is mocked, nothing is downloaded, installed or restarted.
// `?gpu=none` makes automatic matching ask for a manual package; `?fail` turns the started update into a
// trial-start rollback reported by the backend.
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = 'light';
const runtime = { installDir: '/home/ai/Strata', pythonPath: '/home/ai/Strata/.venv/bin/python', runtimeVersion: '0.1.44', readiness: 'ready' as const };
const variants = [['cuda12', 'cuda-cuda12'], ['cuda13', 'cuda-cuda13'], ['hip-halo', 'hip-halo'], ['hip-rx7900', 'hip-rx7900'], ['hip', 'hip-rx9070']] as const;
const release = {
  supportedVersion: '0.2.0-beta', latestVersion: '0.2.0-beta', releaseName: 'Strata 0.2.0-beta', checkedAt: 100,
  installable: true, sourceRevision: 'a'.repeat(40), notes: '## 中文\n\n- 官方 Linux 预编译引擎。\n\n## English\n\n- Official Linux prebuilt engines.',
  releaseUrl: 'https://github.com/Niko1221/Strata/releases/tag/v0.2.0-beta',
  assets: variants.map(([variant, file], index) => {
    const name = `strata-engine-0.1.45.3-linux-x86_64-${file}.tar.gz`;
    return { name, variant, size: [612, 598, 455, 470, 468][index]! * 1024 * 1024, sha256: String(index + 1).repeat(64), engineVersion: '0.1.45.3', url: `https://github.com/Niko1221/Strata/releases/download/v0.2.0-beta/${name}`, ...(variant.startsWith('cuda') ? { nvidiaMinDriver: variant === 'cuda13' ? '580.65' : '575.51' } : {}) };
  }),
};
const matchReason = '检测到 NVIDIA 驱动 580.95.05、计算能力 8.9，选择 CUDA 13 / Detected NVIDIA driver 580.95.05, compute capability 8.9: CUDA 13';
const manualReason = '没有检测到 NVIDIA 或 AMD 显卡（驱动未安装或无法读取），请在「官方更新包」中手动选择对应显卡的引擎包 / No NVIDIA or AMD GPU was detected (driver missing or unreadable); choose the engine package for your GPU under "Official update package"';
const rollback = '新引擎试启动未通过，已自动恢复原版本 0.1.44，模型与配置未改动 / The new engine failed its trial start; the previous version 0.1.44 was restored and models and settings are unchanged. 原因 / Reason: engine: --version 退出码 127 / --version exited 127\n./strata: error while loading shared libraries: libcudart.so.13: cannot open shared object file: No such file or directory';
const tasks: { id: string; kind: string; state: string; message: string; startedAt: number }[] = [];
Object.assign(window, {
  __TAURI_INTERNALS__: {
    async invoke(command: string, args: Record<string, unknown> = {}) {
      if (command === 'local_installations') return [];
      if (command === 'runtime_update_info') return release;
      if (command === 'resolve_runtime_zip_asset') {
        if (params.get('gpu') === 'none') throw new Error(manualReason);
        return { ...release.assets[1], matchReason };
      }
      if (command === 'list_tasks') return tasks;
      if (command === 'read_task_logs' || command === 'read_logs') return [];
      if (command === 'store_get') return null;
      if (command === 'store_set') return null;
      if (command === 'update_runtime_zip') {
        const task = { id: 'fixture-update', kind: 'update', state: 'running', message: '正在试启动新引擎… / Trial-starting the new engine…', startedAt: Date.now() };
        tasks.push(task);
        if (params.has('fail')) setTimeout(() => Object.assign(task, { state: 'failed', message: rollback }), 300);
        return { ...task, assetName: args.assetName };
      }
      if (command === 'cancel_task') return null;
      throw new Error(`Unexpected native command: ${command}`);
    },
  },
});
const query = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
query.setQueryData(['runtime-update-info'], release);
query.setQueryData(['tasks'], []);
const language = params.has('en') ? 'en' : 'zh-CN';
document.documentElement.lang = language;
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={query}><div className="manager-workspace"><main className="main-content"><RuntimeManagementPanel language={language} desktop installationStatus={{ detectedRuntimes: [runtime] }} autoCheck={false}/></main></div></QueryClientProvider>);
