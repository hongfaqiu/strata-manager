import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '../../src/i18n';
import { StartupDraftingControl } from '../../src/pages/StartupDraftingControl';
import { ServiceManagerPage } from '../../src/pages/ServiceManagerPage';
import '../../src/styles.css';
import '../../src/official/tokens.css';
import '../../src/official/components.css';
import '../../src/official-controls.css';
import '../../src/official-pages.css';
import '../../src/official-alignment.css';

// Isolated fixture for 「下载 DFlash2」 and the drafter in use: native IO is mocked, nothing is downloaded or started.
// `?view=run` shows the model list details; `&run=mtp|dflash2` is the verified engine drafter; `&ready` means the pack is there;
// `&fail` makes the download fail; `&en` switches to English.
const params = new URLSearchParams(location.search);
const language = params.has('en') ? 'en' : 'zh-CN';
void i18n.changeLanguage(language);
document.documentElement.lang = language;
const profile = { id: 'a', name: 'Qwen3.8-Flash-Next IQ3_S', baseUrl: 'http://127.0.0.1:8080', installDir: '/home/ai/Strata', pythonPath: '/home/ai/Strata/.venv/bin/python', configPath: '/home/ai/Strata/strata-qwen3.8-flash-next-iq3_s.json', managed: true };
const config = { exe: 'engine/strata', cwd: '/home/ai/Strata', model_name: 'qwen3.8-flash-next-iq3_s', drafting: params.get('drafting') ?? 'auto', args: ['--pack', '/home/ai/Strata-data/packs/iq3_s', '--mtp', '/home/ai/Strata-data/mtp/rt', '--max-context', '65536'] };
const tasks: { id: string; kind: string; state: string; message: string; startedAt: number }[] = [];
const logs: { timestamp: number; level: string; message: string }[] = [];
let ready = params.has('ready');
Object.assign(window, {
  __fixture: { tasks, logs },
  __TAURI_INTERNALS__: {
    async invoke(command: string, args: Record<string, unknown> = {}) {
      if (command === 'dflash2_status') return { ready, fetchable: true };
      if (command === 'fetch_dflash2') {
        const task = { id: 'dflash2-task', kind: 'dflash2-fetch', state: 'running', message: 'strata drafting fetch', startedAt: Date.now() };
        tasks.push(task);
        const total = 1_204_000_000;
        let done = 0, steps = 0;
        const step = () => {
          if (params.has('hold') && steps >= 3) return;
          steps += 1;
          done = Math.min(total, Math.round(total * steps * 0.15));
          logs.push({ timestamp: Date.now(), level: 'stdout', message: JSON.stringify({ event: 'progress', step: 'download', done: Math.round(done), total }) });
          if (params.has('fail') && steps >= 2) { logs.push({ timestamp: Date.now(), level: 'stdout', message: JSON.stringify({ schema_version: 1, ok: false, error: { code: 'drafting_failed', message: '磁盘空间不足 / Not enough disk space' } }) }); Object.assign(task, { state: 'failed', message: 'exit 5' }); return; }
          if (steps >= 7) { done = total; logs.push({ timestamp: Date.now(), level: 'stdout', message: JSON.stringify({ schema_version: 1, ok: true, event: 'result', pack: '/home/ai/Strata-data/dflash2/qwen3.8-flash-next-dflash2.q4_0.pack' }) }); Object.assign(task, { state: 'completed' }); ready = true; return; }
          setTimeout(step, 400);
        };
        setTimeout(step, 200);
        return { ...task };
      }
      if (command === 'list_tasks') return tasks.map(task => ({ ...task }));
      if (command === 'read_task_logs' || command === 'read_logs') return logs.slice();
      if (command === 'cancel_task') { tasks.forEach(task => { task.state = 'cancelled'; }); return null; }
      if (command === 'service_status') return { profileId: 'a', running: true, owned: true, pid: 4242, phase: 'ready' };
      if (command === 'running_drafting') return params.get('run') === 'unverified' ? { verified: false, reason: '没有找到身份匹配的受管原生引擎进程' } : { verified: true, drafter: params.get('run') ?? 'mtp' };
      if (command === 'strata_request') {
        const path = String(args.path);
        if (path.startsWith('/health')) return { service: 'strata', status: 'ok', loaded: true, model: config.model_name };
        if (path.startsWith('/metrics')) return { engine: { version: '0.1.56', model: config.model_name, max_context: 65536 } };
        return {};
      }
      if (command === 'read_config') return structuredClone(config);
      if (command === 'store_get' || command === 'store_set') return null;
      if (command.startsWith('plugin:')) return null;
      console.warn(`fixture: unmocked ${command}`);
      return null;
    },
  },
});
const query = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
const zh = language === 'zh-CN';
const view = params.get('view') === 'run'
  ? <ServiceManagerPage profiles={[profile]} activeId="a" language={language} desktop pollInterval={60000} runtimes={[{ installDir: profile.installDir, pythonPath: profile.pythonPath, runtimeVersion: '0.1.56', readiness: 'ready', profile } as never]} onSelect={() => undefined} onAdd={() => undefined} onImport={() => undefined} onEdit={() => undefined} onLogs={() => undefined} onDelete={() => undefined} {...({} as never)}/>
  : <div className="st-card startup-tuning" style={{ maxWidth: 820, margin: 24 }}><StartupDraftingControl zh={zh} config={config} engineVersion="0.1.56" dflash2Served profile={profile} disabled={false} showParameterNames={false} onChange={() => undefined}/></div>;
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={query}><div className="manager-workspace"><main className="main-content">{view}</main></div></QueryClientProvider>);
