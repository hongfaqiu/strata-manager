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
// `?gpu=none` (or `?gpu=intel`, the Windows Intel-only answer) makes automatic matching ask for a manual package; `?fail` turns the started update into a
// trial-start rollback reported by the backend; `?cpu=old` is a CPU without AVX2 (「只更新代码」).
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
// What a Windows computer with only Intel graphics is told (release_zip::NO_WINDOWS_INTEL_ENGINE).
const intelOnlyReason = '没有匹配的官方引擎：这台 Windows 电脑只检测到 Intel 显卡，而官方 Windows 引擎只有 NVIDIA（CUDA）和 AMD（HIP）版本，暂无 Intel 版本；不会改装 CUDA 包。如确实要装，请手动选择更新包 / No matching official engine: only Intel graphics were found on this Windows PC, and the official Windows engines are NVIDIA (CUDA) and AMD (HIP) only, with no Intel build. A CUDA package is not installed instead; choose a package by hand if you really want one';
const rollback = '新引擎试启动未通过，已自动恢复原版本 0.1.44，模型与配置未改动 / The new engine failed its trial start; the previous version 0.1.44 was restored and models and settings are unchanged. 原因 / Reason: engine: --version 退出码 127 / --version exited 127\n./strata: error while loading shared libraries: libcudart.so.13: cannot open shared object file: No such file or directory';
const tasks: { id: string; kind: string; state: string; message: string; startedAt: number }[] = [];
Object.assign(window, {
  __TAURI_INTERNALS__: {
    async invoke(command: string, args: Record<string, unknown> = {}) {
      if (command === 'local_installations') return [];
      if (command === 'runtime_update_info') return release;
      if (command === 'runtime_cpu_check') return params.get('cpu') === 'old'
        ? { avx2: false, engineBlocked: '这台电脑的 CPU 不支持 AVX2，官方预编译引擎无法运行，已拦下引擎更新；可选择「只更新代码」，保留当前引擎 / This CPU has no AVX2, which the official prebuilt engines need, so the engine update was stopped; choose "Update code only" to keep the current engine' }
        : { avx2: true, engineBlocked: null };
      if (command === 'resolve_runtime_zip_asset') {
        if (params.get('gpu') === 'none') throw new Error(manualReason);
        if (params.get('gpu') === 'intel') throw new Error(intelOnlyReason);
        return { ...release.assets[1], matchReason };
      }
      if (command === 'list_tasks') return tasks;
      if (command === 'read_task_logs' || command === 'read_logs') return [];
      if (command === 'store_get') return null;
      if (command === 'store_set') return null;
      if (command === 'update_runtime_zip') {
        const task = { id: 'fixture-update', kind: 'update', state: 'running', message: args.sourceOnly ? '只更新代码：正在下载官方Release v0.2.0-beta的同提交源码，引擎 0.1.44 保持不变 / Code only: downloading the v0.2.0-beta source; engine 0.1.44 stays' : '正在试启动新引擎… / Trial-starting the new engine…', startedAt: Date.now() };
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
