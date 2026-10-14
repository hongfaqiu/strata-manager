import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, RefreshCw, Square, TerminalSquare } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { AppLanguage, LogEntry, ServiceProfile } from '@strata-manager/core';
import { Panel } from '../components';

export const officialUpdateWords = {
  'zh-CN': {
    title: '用官方脚本更新 Strata', run: '更新 Strata', running: '正在执行官方更新脚本…', cancel: '取消',
    intro: '调用安装目录里的官方 {script}：拉取最新代码，按需替换引擎、更新 Python 依赖并迁移每个模型的配置；不会改动模型文件。',
    stopFirst: '请先停止当前服务再更新。', notManaged: '仅支持本应用管理的本地安装。',
    dirty: '检测到已修改的跟踪文件，官方脚本会拒绝 git pull，因此暂不执行：', dirtyHint: '请先自行保存或还原这些改动（例如 git stash），本应用不会强制覆盖。',
    notGit: '此目录不是 git 克隆：官方脚本只会检查引擎和配置，无法拉取新代码（脚本会给出下载地址）。',
    logs: '官方脚本输出', completed: '官方更新已完成。重新启动服务后生效。', failed: '官方更新未完成：', recheck: '重新检查',
  },
  en: {
    title: 'Update Strata with the official script', run: 'Update Strata', running: 'Running the official update script…', cancel: 'Cancel',
    intro: 'Runs the official {script} in the installation: newest code, engine when needed, Python packages and per-model settings. Model files are not touched.',
    stopFirst: 'Stop the service before updating.', notManaged: 'Only local installations managed by this app are supported.',
    dirty: 'Tracked files were changed, so upstream git pull would refuse. Nothing was run:', dirtyHint: 'Save or revert them yourself (e.g. git stash). This app never forces.',
    notGit: 'This folder is not a git clone: the script only checks the engine and settings (it prints a download link).',
    logs: 'Official script output', completed: 'Official update finished. Restart the service to use it.', failed: 'Official update did not finish: ', recheck: 'Check again',
  },
} as const;

interface Props { profile?: ServiceProfile; desktop: boolean; language: AppLanguage; serviceRunning?: boolean; disabled?: boolean }

export function OfficialUpdatePanel({ profile, desktop, language, serviceRunning, disabled }: Props) {
  const text = officialUpdateWords[language === 'zh-CN' ? 'zh-CN' : 'en'];
  const client = useQueryClient();
  const enabled = desktop && !!profile?.managed;
  const plan = useQuery({ queryKey: ['official-update-plan', profile?.id, profile?.installDir], queryFn: () => core.officialUpdatePlan(profile!), enabled, retry: false });
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: core.listTasks, enabled: desktop, refetchInterval: 2000 });
  const [taskId, setTaskId] = useState(''), [error, setError] = useState(''), [logs, setLogs] = useState<LogEntry[]>([]);
  const task = tasks.data?.find(item => item.id === taskId) ?? tasks.data?.find(item => item.kind === 'officialUpdate' && item.state === 'running');
  const running = task?.state === 'running';
  useEffect(() => {
    if (!task) return;
    let stopped = false;
    const refresh = () => { void core.readTaskLogs(task.id, 200).then(entries => { if (!stopped) setLogs(entries); }).catch(() => {}); };
    refresh();
    const timer = running ? window.setInterval(refresh, 1000) : undefined;
    return () => { stopped = true; if (timer) window.clearInterval(timer); };
  }, [task?.id, running]);
  if (!profile) return null;
  const dirty = plan.data?.dirtyFiles ?? [];
  const blocked = !enabled || serviceRunning || disabled || running || !plan.data || dirty.length > 0 || tasks.data?.some(item => item.state === 'running');
  const start = async () => {
    setError(''); setLogs([]);
    try {
      const fresh = await core.officialUpdatePlan(profile);
      if (fresh.dirtyFiles.length) { client.setQueryData(['official-update-plan', profile.id, profile.installDir], fresh); return; }
      const created = await core.officialUpdate(profile);
      setTaskId(created.id);
      await client.invalidateQueries({ queryKey: ['tasks'] });
    } catch (reason) { setError(core.normalizeError(reason).message); }
  };
  return <Panel title={text.title} className="official-update-panel" action={<button type="button" disabled={!enabled || plan.isFetching} onClick={() => void plan.refetch()}><RefreshCw size={15} className={plan.isFetching ? 'spin' : undefined}/>{text.recheck}</button>}>
    <p>{text.intro.replace('{script}', plan.data?.script ?? 'update.sh / UPDATE.bat')}</p>
    {!profile.managed && <p className="notice" role="status">{text.notManaged}</p>}
    {plan.error && <p className="notice error" role="alert">{core.normalizeError(plan.error).message}</p>}
    {plan.data && !plan.data.gitClone && <p className="notice" role="status">{text.notGit}</p>}
    {dirty.length > 0 && <div className="notice error" role="alert" data-testid="official-update-dirty"><p>{text.dirty}</p><ul>{dirty.slice(0, 8).map(file => <li key={file}><code>{file}</code></li>)}</ul><small>{text.dirtyHint}</small></div>}
    {serviceRunning && <p className="notice" role="status">{text.stopFirst}</p>}
    <div className="actions">
      <button type="button" className="primary" disabled={blocked} onClick={() => void start()}>{running ? <LoaderCircle size={15} className="spin"/> : <TerminalSquare size={15}/>}{running ? text.running : text.run}</button>
      {running && task && <button type="button" onClick={() => void core.cancelTask(task.id).catch(reason => setError(core.normalizeError(reason).message))}><Square size={13}/>{text.cancel}</button>}
    </div>
    {error && <p className="notice error" role="alert">{error}</p>}
    {task?.state === 'completed' && <p className="runtime-ready" role="status">{text.completed}</p>}
    {task?.state === 'failed' && <p className="notice error" role="alert">{text.failed}{task.message}</p>}
    {logs.length > 0 && <details open={running}><summary>{text.logs}</summary><pre data-testid="official-update-logs">{logs.map(entry => entry.message).join('\n')}</pre></details>}
  </Panel>;
}
