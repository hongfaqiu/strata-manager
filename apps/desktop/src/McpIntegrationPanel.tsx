import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { externalManagementStatus, isDesktop, managerMcpClientConfiguration, managerMcpConnection, officialMcpClientConfiguration, probeOfficialMcp, setExternalManagement, type ExternalManagementStatus, type ManagerMcpConnection, type OfficialMcpClient, type OfficialMcpProbe, type ServiceProfile } from '@strata-manager/core';
import { CircleHelp } from 'lucide-react';
import { Dropdown, OfficialDialog as Dialog } from './OfficialControls';
import './mcp-integration-panel.css';

type ConnectionMode = 'manager' | 'external';
type CheckedConnection = { identity: string; mode: 'manager'; value: ManagerMcpConnection } | { identity: string; mode: 'external'; value: OfficialMcpProbe };
const normalizedPath = (path: string) => {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
};
const failureMessage = (failure: unknown) => failure instanceof Error ? failure.message : String(failure);

export function McpIntegrationPanel({ profile, managedServiceActive, canHandoff, refreshToken, probe = probeOfficialMcp, managerProbe = managerMcpConnection, readOwnership = externalManagementStatus, changeOwnership = setExternalManagement, onOwnershipChange }: {
  profile?: ServiceProfile; managedServiceActive?: boolean; canHandoff?: boolean;
  refreshToken?: number;
  probe?: (profileId: string) => Promise<OfficialMcpProbe>;
  managerProbe?: (profileId: string) => Promise<ManagerMcpConnection>;
  readOwnership?: (profileId: string) => Promise<ExternalManagementStatus>;
  changeOwnership?: (profileId: string, external: boolean) => Promise<ExternalManagementStatus>;
  onOwnershipChange?: (status: ExternalManagementStatus) => void;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [mode, setMode] = useState<ConnectionMode>('manager');
  const [client, setClient] = useState<OfficialMcpClient>('codex');
  const [checked, setChecked] = useState<CheckedConnection>();
  const [helpOpen, setHelpOpen] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [owner, setOwner] = useState<ExternalManagementStatus>();
  const [ownershipBusy, setOwnershipBusy] = useState(false), [copied, setCopied] = useState(false);
  const generation = useRef(0), ownershipGeneration = useRef(0);
  const profileIdentity = JSON.stringify([profile?.id, profile?.installDir, profile?.pythonPath]);
  const selectionIdentity = JSON.stringify([profileIdentity, mode]);
  const currentSelection = useRef(selectionIdentity);
  currentSelection.current = selectionIdentity;

  useEffect(() => {
    generation.current++; ownershipGeneration.current++;
    setChecked(undefined); setError(''); setOwner(undefined); setBusy(false); setOwnershipBusy(false); setCopied(false); setHelpOpen(false);
  }, [profileIdentity]);
  useEffect(() => {
    if (!profile || ownershipBusy) return;
    const token = ownershipGeneration.current, identity = selectionIdentity;
    let canceled = false;
    // Background status updates retain current ownership and do not flicker controls.
    readOwnership(profile.id).then(value => {
      if (!canceled && token === ownershipGeneration.current && currentSelection.current === identity) setOwner(value);
    }).catch(failure => {
      if (!canceled && token === ownershipGeneration.current && currentSelection.current === identity) setError(failureMessage(failure));
    });
    return () => { canceled = true; };
  }, [selectionIdentity, managedServiceActive, refreshToken, readOwnership, ownershipBusy]);
  useEffect(() => () => { generation.current++; ownershipGeneration.current++; }, []);

  const changeMode = (next: ConnectionMode) => {
    if (next === mode || ownershipBusy) return;
    generation.current++; ownershipGeneration.current++;
    currentSelection.current = JSON.stringify([profileIdentity, next]);
    setMode(next); setChecked(undefined); setBusy(false); setCopied(false); setError('');
  };
  const check = async () => {
    if (!profile || busy || ownershipBusy || (mode === 'manager' && owner?.external)) return;
    const token = ++generation.current, identity = selectionIdentity;
    setBusy(true); setError(''); setChecked(undefined); setCopied(false);
    try {
      if (mode === 'manager') {
        const value = await managerProbe(profile.id);
        if (value.profileId !== profile.id || normalizedPath(value.installDir) !== normalizedPath(profile.installDir)) throw new Error(zh ? '连接信息与当前模型档案不一致，请重新检查。' : 'Connection details do not match the selected profile. Check again.');
        managerMcpClientConfiguration(value, client);
        if (token === generation.current && currentSelection.current === identity) setChecked({ identity, mode, value });
      } else {
        const value = await probe(profile.id);
        if (normalizedPath(value.installDir) !== normalizedPath(profile.installDir)) throw new Error(zh ? '官方 MCP 的安装目录与当前档案不一致，请重新检查。' : 'The official MCP installation does not match the selected profile. Check again.');
        officialMcpClientConfiguration(value, client);
        if (token === generation.current && currentSelection.current === identity) setChecked({ identity, mode, value });
      }
    } catch (failure) {
      if (token === generation.current && currentSelection.current === identity) setError(failureMessage(failure));
    } finally {
      if (token === generation.current && currentSelection.current === identity) setBusy(false);
    }
  };
  const refreshOwnership = async () => {
    if (!profile || ownershipBusy || busy) return;
    const token = ++ownershipGeneration.current, identity = selectionIdentity;
    setOwnershipBusy(true); setError('');
    try {
      const latest = await readOwnership(profile.id);
      if (token === ownershipGeneration.current && currentSelection.current === identity) setOwner(latest);
    } catch (failure) {
      if (token === ownershipGeneration.current && currentSelection.current === identity) setError(failureMessage(failure));
    } finally {
      if (token === ownershipGeneration.current && currentSelection.current === identity) setOwnershipBusy(false);
    }
  };
  const result = checked?.identity === selectionIdentity ? checked.value : undefined;
  const ownerMatches = !!owner && owner.profileId === profile?.id && !!owner.installDir && !!profile && normalizedPath(owner.installDir) === normalizedPath(profile.installDir);
  const allowed = !!result && ownerMatches && owner!.external === (mode === 'external');
  const canGiveControl = mode === 'external' && ownerMatches && !owner!.external && owner!.canHandoff === true && canHandoff !== false && managedServiceActive !== true && checked?.identity === selectionIdentity && checked.mode === 'external';
  const canRestoreControl = ownerMatches && owner!.external && owner!.canResume === true && managedServiceActive !== true;
  const handoff = async (external: boolean) => {
    if (!profile || busy || ownershipBusy || (external ? !canGiveControl : !canRestoreControl)) return;
    const token = ++ownershipGeneration.current, identity = selectionIdentity;
    setOwnershipBusy(true); setError(''); setCopied(false);
    try {
      const changed = await changeOwnership(profile.id, external);
      onOwnershipChange?.(changed);
      if (token !== ownershipGeneration.current || currentSelection.current !== identity) return;
      setOwner(changed);
      if (!external) { generation.current++; setChecked(undefined); }
      const latest = await readOwnership(profile.id);
      if (token === ownershipGeneration.current && currentSelection.current === identity) setOwner(latest);
    } catch (failure) {
      if (token === ownershipGeneration.current && currentSelection.current === identity) setError(failureMessage(failure));
    } finally {
      if (token === ownershipGeneration.current && currentSelection.current === identity) setOwnershipBusy(false);
    }
  };
  let snippet = '', snippetIssue = '';
  if (allowed && checked) {
    try { snippet = checked.mode === 'manager' ? managerMcpClientConfiguration(checked.value, client) : officialMcpClientConfiguration(checked.value, client); }
    catch (failure) { snippetIssue = failureMessage(failure); }
  }
  const copyIdentity = JSON.stringify([selectionIdentity, client, allowed, snippet]);
  const currentCopy = useRef(copyIdentity);
  currentCopy.current = copyIdentity;
  const copy = async () => {
    if (!snippet || busy || ownershipBusy) return;
    const identity = copyIdentity, token = generation.current;
    try {
      await navigator.clipboard.writeText(snippet);
      if (token === generation.current && currentCopy.current === identity) setCopied(true);
    } catch {
      if (token === generation.current && currentCopy.current === identity) setError(zh ? '复制失败，请在文本框中选择并复制。' : 'Copy failed. Select and copy the configuration below.');
    }
  };
  const defaultProbeUnavailable = !isDesktop() && (mode === 'manager' ? managerProbe === managerMcpConnection : probe === probeOfficialMcp);
  const hasOwnershipAction = mode === 'external' || owner?.external === true;

  return <section className="st-card mcp-integration-panel" aria-label={zh ? '外部助手 MCP 接入' : 'External assistant MCP integration'}>
    <div className="mcp-integration-heading"><span className="card-title">{zh ? '连接外部助手' : 'Connect an external assistant'}</span><button className="st-btn st-btn--icon" type="button" title={zh ? '接入帮助' : 'Connection help'} aria-label={zh ? '外部助手接入帮助' : 'External assistant connection help'} onClick={() => setHelpOpen(true)}><CircleHelp size={16}/></button></div>
    <p className="mcp-integration-status">{zh ? '让 Codex、Cursor 等助手查看状态并管理模型。' : 'Let assistants such as Codex or Cursor check status and manage models.'}</p>
    <div className="mcp-integration-modes" role="group" aria-label={zh ? '接入模式' : 'Connection mode'}>
      <label className={`mcp-integration-mode${mode === 'manager' ? ' is-selected' : ''}`}><input type="radio" aria-label={zh ? '通过本应用管理（推荐）' : 'Manage through this app (recommended)'} name="mcp-connection-mode" value="manager" checked={mode === 'manager'} disabled={ownershipBusy} onChange={() => changeMode('manager')}/><span><strong>{zh ? '通过本应用管理（推荐）' : 'Manage through this app (recommended)'}</strong><span>{zh ? '助手通过本应用后台执行操作，可继续使用本应用。' : 'Assistant operations go through the app’s background service. Keep using this app.'}</span></span></label>
      <label className={`mcp-integration-mode${mode === 'external' ? ' is-selected' : ''}`}><input type="radio" aria-label={zh ? '外部独立接管' : 'Independent external management'} name="mcp-connection-mode" value="external" checked={mode === 'external'} disabled={ownershipBusy} onChange={() => changeMode('external')}/><span><strong>{zh ? '外部独立接管' : 'Independent external management'}</strong><span>{zh ? '助手直接控制 Strata，需先交接管理权。' : 'The assistant controls Strata directly and requires an explicit handoff.'}</span></span></label>
    </div>
    <p className="mcp-integration-status">{mode === 'manager' ? (zh ? '保持本应用管理，无需停止模型或切换管理权即可接入。' : 'Keep this app in control. Connect without stopping models or transferring ownership.') : (zh ? '选择模式只改变展示；检查连接后，仍需手动交接才能复制独立接管配置。' : 'Selecting this mode only changes the view. Check the connection and explicitly hand off before copying independent settings.')}</p>
    <div className="mcp-integration-actions"><button type="button" className="st-btn st-btn--secondary" disabled={busy || ownershipBusy || !profile || defaultProbeUnavailable || (mode === 'manager' && owner?.external === true)} onClick={() => void check()}>{busy ? (zh ? '正在检查…' : 'Checking…') : (zh ? '检查连接' : 'Check connection')}</button>{result && <span role="status" className="mcp-integration-status">{zh ? '连接可用' : 'Connection ready'} · {result.tools.length} {zh ? '个工具' : 'tools'}</span>}</div>
    {error && <div className="mcp-integration-error" role="alert">{error.startsWith('复制失败') || error.startsWith('Copy failed') ? error : (zh ? '接入操作未完成。' : 'The connection operation did not complete.')}<button type="button" className="mcp-integration-diagnostic" onClick={() => setHelpOpen(true)}>{zh ? '查看诊断' : 'View diagnostic'}</button></div>}
    <div className="mcp-integration-ownership">
      <div className="mcp-integration-actions"><span className="mcp-integration-status" role="status">{owner?.external ? (zh ? '由外部助手管理' : 'Managed by an external assistant') : owner ? (zh ? '由本应用管理' : 'Managed by this app') : (zh ? '正在读取管理方式…' : 'Reading management mode…')}</span><button type="button" className="st-btn st-btn--secondary" disabled={!profile || ownershipBusy || busy} onClick={() => void refreshOwnership()}>{zh ? '刷新状态' : 'Refresh status'}</button>{hasOwnershipAction && <button type="button" className="st-btn st-btn--primary" disabled={ownershipBusy || busy || (owner?.external ? !canRestoreControl : !canGiveControl)} onClick={() => void handoff(!owner?.external)}>{ownershipBusy ? (zh ? '正在切换…' : 'Switching…') : owner?.external ? (zh ? '恢复本应用管理' : 'Restore app management') : (zh ? '交给外部助手独立管理' : 'Hand off to the external assistant')}</button>}</div>
      {mode === 'manager' && owner?.external && <p className="mcp-integration-status">{zh ? '当前安装目录已由外部助手接管。先停止模型、完成安装并断开助手连接，再恢复本应用管理后检查连接。' : 'An external assistant controls this installation. Stop models, finish installation and disconnect that assistant, then restore app management and check the connection.'}</p>}
      {mode === 'external' && <><p className="mcp-integration-status">{zh ? '独立接管时，本应用暂停同一安装目录内所有模型的启动、自动加载和恢复。' : 'Independent management pauses this app’s starts, auto-load and recovery for all models in the same installation.'}</p><p className="mcp-integration-status">{zh ? '交接前先停止模型、完成安装，并断开助手连接。切换本身不会启停模型。' : 'Stop models, finish installation and disconnect the assistant before handing off. Switching itself does not start or stop models.'}</p></>}
      {(mode === 'external' || owner?.external) && owner?.reason && <p className="mcp-integration-status" role="status">{owner.reason}</p>}
    </div>
    {snippetIssue && <p className="mcp-integration-error" role="alert">{snippetIssue}</p>}
    {allowed && <><div className="st-field"><label className="st-label">{zh ? '选择助手' : 'Choose an assistant'}</label><Dropdown ariaLabel={zh ? 'MCP 客户端' : 'MCP client'} value={client} onValueChange={value => { setClient(value as OfficialMcpClient); setCopied(false); }} options={[{value:'codex',label:'Codex'},{value:'cursor',label:'Cursor'},{value:'claude-desktop',label:'Claude Desktop'},{value:'vscode',label:'VS Code'}]}/></div><textarea className="st-input mcp-integration-code" rows={9} readOnly spellCheck={false} value={snippet} aria-label={zh ? '无密钥 MCP 客户端配置' : 'MCP client configuration without secrets'}/><button type="button" className="st-btn st-btn--secondary" disabled={!snippet || busy || ownershipBusy} onClick={() => void copy()}>{copied ? (zh ? '已复制' : 'Copied') : (zh ? '复制接入配置' : 'Copy connection settings')}</button><p className="mcp-integration-status">{zh ? '把配置添加到助手的 MCP 设置中，保留已有条目。' : 'Add this to the assistant’s MCP settings, keeping existing entries.'}</p></>}
    {helpOpen && <Dialog title={zh ? '外部助手接入说明' : 'External assistant connection'} onClose={() => setHelpOpen(false)}><div className="mcp-integration-help-content"><p>{zh ? '推荐模式下，助手和本应用通过同一后台管理模型，启动、停止、安装等操作使用统一的锁和任务记录。检查连接只读取连接信息和工具清单，不启停模型。' : 'In the recommended mode, the assistant and this app manage models through the same background service, with shared locks and task records for starts, stops and installation. Checking only reads connection details and tools; it does not start or stop models.'}</p><p>{zh ? '退出助手不会停止本应用后台或模型。后台未运行时，请先启动本应用，再重新连接助手。' : 'Closing the assistant does not stop the app’s background service or models. If the background service is not running, start this app before reconnecting the assistant.'}</p><p>{zh ? '外部独立接管使用 Strata 官方 MCP，由助手直接控制服务。本应用暂停同一安装目录内的启动、自动加载和恢复。选择模式不会自动交接，切换管理权本身也不会启停模型。' : 'Independent external management uses Strata’s official MCP to control services directly. This app pauses starts, auto-load and recovery for the installation. Selecting a mode does not hand off ownership, and handing off does not start or stop models.'}</p><p>{zh ? '配置不含 API Key。安装操作需要工具中的明确确认；将配置添加到助手的 MCP 设置时保留已有条目。' : 'Settings contain no API key. Installation requires explicit confirmation in the tool; keep existing entries when adding these settings to the assistant.'}</p>{result && <><h3>{zh ? '已提供的工具' : 'Available tools'}</h3><p>{result.serverName} · {result.protocolVersion}</p><div className="mcp-integration-tools">{result.tools.map(tool => <span className="chip" key={tool.name}>{tool.name}{!tool.readOnly && <span className="muted"> · {zh ? '可修改' : 'can modify'}</span>}</span>)}</div></>}{error && <><h3>{zh ? '诊断' : 'Diagnostic'}</h3><pre>{error}</pre></>}</div></Dialog>}
  </section>;
}
