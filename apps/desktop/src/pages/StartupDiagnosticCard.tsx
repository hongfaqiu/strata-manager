import type { AppLanguage } from "@strata-manager/core";
import type { ReactNode } from 'react';
import { AlertTriangle, FileText, RotateCcw } from 'lucide-react';
import { primaryStartupDiagnosticAction, startupEngineCrashed, startupMemoryShortage, startupWindowsSacBlocked, type StartupDiagnosticAction, type StartupFailureDiagnostic } from '../../../../packages/core/src/startup-diagnostics';
import './startup-diagnostic.css';

export interface StartupDiagnosticCardProps {
  profileName?: string;
  language: AppLanguage;
  diagnostic: StartupFailureDiagnostic;
  onAction?: (action: StartupDiagnosticAction, diagnostic: StartupFailureDiagnostic) => void;
  disabled?: boolean;
  /** The next --vram-reserve-mib for a memory failure (1536, then 2048); omitted when there is none to offer. */
  reserveFixMib?: number;
  /** Writes the reserve into the model configuration and starts the model again. */
  onReserveFix?: (mib: number, diagnostic: StartupFailureDiagnostic) => void;
  /** Shown when the engine crashed or exited abnormally: the entry to fall back to the previous engine. */
  engineRollback?: ReactNode;
}

export function StartupDiagnosticCard({ language, diagnostic, onAction, profileName, disabled = false, reserveFixMib, onReserveFix, engineRollback }: StartupDiagnosticCardProps) {
  const zh = language === 'zh-CN';
  const category = { resource: ['资源分配可能不足', 'Possible resource shortage'], port: ['监听端口被占用', 'Listen port in use'], files: ['所需文件缺失', 'Required file missing'],
    config: ['配置未通过检查', 'Configuration check failed'], auth: ['连接鉴权失败', 'Connection authentication failed'], timeout: ['等待就绪超时', 'Readiness timed out'],
    engine: ['引擎在加载模型时崩溃', 'The engine crashed while loading the model'], python: ['Python 环境不对', 'Wrong Python environment'], unknown: ['尚未确定失败原因', 'Cause not established'] }[diagnostic.category][zh ? 0 : 1];
  // Upstream server.py opens its log for appending; Manager already tried one fresh log file.
  const logUnwritable = diagnostic.code === 'STARTUP_LOG_UNWRITABLE';
  // Win11 Smart App Control / WDAC blocked the engine or vision binary (#5619).
  const sacBlocked = startupWindowsSacBlocked(diagnostic);
  // The engine named the allocation that failed while loading (diagnostics.rs memory_report).
  const memory = startupMemoryShortage(diagnostic);
  const title = logUnwritable ? (zh ? '日志文件被占用或无权限' : 'Log file in use or not writable')
    : sacBlocked ? (zh ? 'Windows 智能应用控制拦截了引擎' : 'Windows Smart App Control blocked the engine')
    : memory === 'vram' ? (zh ? '显存不够，模型没加载上' : 'Out of VRAM while loading the model')
    : memory === 'commit' ? (zh ? 'Windows 虚拟内存不够，模型没加载上' : 'Windows ran out of virtual memory while loading the model') : category;
  const reserveFix = memory && reserveFixMib && onReserveFix ? reserveFixMib : undefined;
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
    {profileName && <strong>{profileName}</strong>}<div className="startup-diagnostic-heading" role="alert"><AlertTriangle size={19}/><div><strong>{title}</strong><p>{diagnostic.message}</p></div></div>
    <p className="startup-diagnostic-facts"><span>{confidence}</span><span>{zh ? '失败阶段' : 'Failed stage'}: {{ prepare: zh ? '环境与配置检查' : 'Environment and configuration', starting: zh ? '启动 API' : 'Starting API', loading: zh ? '加载模型' : 'Loading model' }[diagnostic.phase]}</span><span data-testid="startup-diagnostic-elapsed">{zh ? '启动耗时' : 'Startup duration'} {elapsed}</span><time>{new Date(diagnostic.failedAt).toLocaleString(language)}</time></p>
    {diagnostic.processRunning === true && <p className="startup-diagnostic-retained">{zh ? '失败时启动进程仍在运行；重新检查状态不会再次启动模型。' : 'The process was still running at failure. Checking status does not start the model again.'}</p>}
    {diagnostic.category === 'python' && <p className="startup-diagnostic-retained">{zh ? '应使用该 Strata 目录自带的 .venv 或嵌入式 Python（与 run-*.bat 一致），不是系统 Python。' : "It should run with the Strata folder's own .venv or embedded Python (as run-*.bat does), not the system Python."}</p>}
    {logUnwritable && <p className="startup-diagnostic-retained">{zh ? '每次启动前 Manager 都会先检查日志文件，打不开就自动改用同目录或 Manager 目录下的新日志文件；换了仍失败时自动恢复会停下，请按上面的步骤处理后再启动。' : 'Before every start Manager checks the log file and switches to a new one beside it or in Manager\'s folder when it cannot be opened. If that still fails, automatic recovery stops; follow the steps above, then start again.'}</p>}
    {sacBlocked && <p className="startup-diagnostic-retained" data-testid="startup-diagnostic-sac">{zh ? '常见于 Windows 11 开启「智能应用控制」时拦截 strata-vision.exe 或主引擎。可在「Windows 安全中心 › 应用和浏览器控制」关闭智能应用控制后重试；Manager 无法代为关闭。也可等上游提供已签名版本。' : 'Common when Windows 11 Smart App Control blocks strata-vision.exe or the main engine. Turn it off under Windows Security › App & browser control, then try again; Manager cannot turn it off for you. Or wait for a signed upstream build.'}</p>}
    {diagnostic.category === 'engine' && !sacBlocked && <p className="startup-diagnostic-retained">{zh ? '下方「查看诊断依据」里有引擎最后的报错，完整输出见启动日志。' : 'The engine\'s last error is under "View diagnostic evidence"; the full output is in the startup log.'}</p>}
    {diagnostic.confidence === 'suspected' && <p className="startup-diagnostic-retained">{zh ? '引擎输出提供了线索，尚不能确认整机内存耗尽。' : 'Engine output provides a clue; a system OOM has not been established.'}</p>}
    {memory && <div className="startup-diagnostic-memory" data-testid="startup-diagnostic-memory">
      {memory === 'commit' && <p>{zh ? '把 Windows 虚拟内存设为「系统管理的大小」后重启电脑：设置 › 系统 › 系统信息 › 高级系统设置 › 性能 › 高级 › 虚拟内存。' : 'Set Windows virtual memory to "System managed size", then restart the PC: Settings › System › About › Advanced system settings › Performance › Advanced › Virtual memory.'}</p>}
      <p>{zh ? '界面上的「空闲显存」是引擎自己把显存占满后读到的，不是别的程序占用。' : 'The "free VRAM" figure was read after the engine filled VRAM itself; no other program is holding it.'}</p>
      {reserveFix && <button className="primary" data-testid="startup-diagnostic-reserve-fix" disabled={disabled} onClick={() => onReserveFix?.(reserveFix, diagnostic)}><RotateCcw size={14}/> {zh ? `保留显存提到 ${reserveFix} MiB 并重启` : `Reserve ${reserveFix} MiB of VRAM and restart`}</button>}
    </div>}
    {engineRollback && startupEngineCrashed(diagnostic) && <div className="startup-diagnostic-rollback" data-testid="startup-diagnostic-rollback">{engineRollback}</div>}
    <div className="startup-diagnostic-actions">{shownActions.map(action => <button key={action} className={action === primary && !reserveFix ? 'primary' : ''} disabled={disabled || !onAction} onClick={() => onAction?.(action, diagnostic)}>{action === 'viewLogs' && <FileText size={14}/>} {labels[action]}</button>)}</div>
    <details className="startup-diagnostic-evidence"><summary>{zh ? '查看诊断依据' : 'View diagnostic evidence'} · <code>{diagnostic.code}</code></summary>
      {diagnostic.evidence.map((entry, index) => <p key={`${entry.at}-${index}`}><time>{new Date(entry.at).toLocaleTimeString(language)}</time><span>{entry.message}</span></p>)}
      {diagnostic.exitCode !== undefined && <p>{zh ? '进程退出码' : 'Process exit code'}: {diagnostic.exitCode}</p>}
    </details>
  </section>;
}
