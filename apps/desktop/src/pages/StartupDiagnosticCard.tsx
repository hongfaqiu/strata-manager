import type { AppLanguage } from "@strata-manager/core";
import { AlertTriangle, FileText } from 'lucide-react';
import { primaryStartupDiagnosticAction, type StartupDiagnosticAction, type StartupFailureDiagnostic } from '../../../../packages/core/src/startup-diagnostics';
import './startup-diagnostic.css';

export interface StartupDiagnosticCardProps {
  profileName?: string;
  language: AppLanguage;
  diagnostic: StartupFailureDiagnostic;
  onAction?: (action: StartupDiagnosticAction, diagnostic: StartupFailureDiagnostic) => void;
  disabled?: boolean;
}

export function StartupDiagnosticCard({ language, diagnostic, onAction, profileName, disabled = false }: StartupDiagnosticCardProps) {
  const zh = language === 'zh-CN';
  const category = { resource: ['资源分配可能不足', 'Possible resource shortage'], port: ['监听端口被占用', 'Listen port in use'], files: ['所需文件缺失', 'Required file missing'],
    config: ['配置未通过检查', 'Configuration check failed'], auth: ['连接鉴权失败', 'Connection authentication failed'], timeout: ['等待就绪超时', 'Readiness timed out'], unknown: ['尚未确定失败原因', 'Cause not established'] }[diagnostic.category][zh ? 0 : 1];
  const labels: Record<StartupDiagnosticAction, string> = zh
    ? { openResources: '查看资源状态', openNetwork: '打开网络配置', openFiles: '检查文件与运行环境', openConfig: '打开模型配置', openCredentials: '检查连接凭据', checkStatus: '重新检查状态', viewLogs: '查看启动日志', exportDiagnostics: '导出诊断' }
    : { openResources: 'View resources', openNetwork: 'Open network settings', openFiles: 'Check files and runtime', openConfig: 'Open model configuration', openCredentials: 'Check credentials', checkStatus: 'Check status again', viewLogs: 'View startup logs', exportDiagnostics: 'Export diagnostics' };
  const primary = primaryStartupDiagnosticAction(diagnostic);
  const elapsedSeconds = Math.max(0, Math.floor((diagnostic.failedAt - diagnostic.attemptStartedAt) / 1000));
  const elapsed = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, '0')}`;
  const shownActions = [...new Set<StartupDiagnosticAction>([primary, 'viewLogs', 'exportDiagnostics'])];
  const confidence = diagnostic.confidence === 'suspected' ? (zh ? '疑似原因，尚未确认' : 'Suspected cause; not confirmed')
    : diagnostic.confidence === 'confirmed' ? (zh ? '检查已确认' : 'Confirmed by the check') : (zh ? '证据不足' : 'Insufficient evidence');
  return <section className="startup-diagnostic" aria-label={zh ? '启动失败诊断' : 'Startup failure diagnostic'} data-testid="startup-diagnostic">
    {profileName && <strong>{profileName}</strong>}<div className="startup-diagnostic-heading" role="alert"><AlertTriangle size={19}/><div><strong>{category}</strong><p>{diagnostic.message}</p></div></div>
    <p className="startup-diagnostic-facts"><span>{confidence}</span><span>{zh ? '失败阶段' : 'Failed stage'}: {{ prepare: zh ? '环境与配置检查' : 'Environment and configuration', starting: zh ? '启动 API' : 'Starting API', loading: zh ? '加载模型' : 'Loading model' }[diagnostic.phase]}</span><span data-testid="startup-diagnostic-elapsed">{zh ? '启动耗时' : 'Startup duration'} {elapsed}</span><time>{new Date(diagnostic.failedAt).toLocaleString(language)}</time></p>
    {diagnostic.processRunning === true && <p className="startup-diagnostic-retained">{zh ? '失败时启动进程仍在运行；重新检查状态不会再次启动模型。' : 'The process was still running at failure. Checking status does not start the model again.'}</p>}
    {diagnostic.confidence === 'suspected' && <p className="startup-diagnostic-retained">{zh ? '引擎输出提供了线索，尚不能确认整机内存耗尽。' : 'Engine output provides a clue; a system OOM has not been established.'}</p>}
    <div className="startup-diagnostic-actions">{shownActions.map(action => <button key={action} className={action === primary ? 'primary' : ''} disabled={disabled || !onAction} onClick={() => onAction?.(action, diagnostic)}>{action === 'viewLogs' && <FileText size={14}/>} {labels[action]}</button>)}</div>
    <details className="startup-diagnostic-evidence"><summary>{zh ? '查看诊断依据' : 'View diagnostic evidence'} · <code>{diagnostic.code}</code></summary>
      {diagnostic.evidence.map((entry, index) => <p key={`${entry.at}-${index}`}><time>{new Date(entry.at).toLocaleTimeString(language)}</time><span>{entry.message}</span></p>)}
      {diagnostic.exitCode !== undefined && <p>{zh ? '进程退出码' : 'Process exit code'}: {diagnostic.exitCode}</p>}
    </details>
  </section>;
}
