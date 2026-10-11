import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { externalManagementStatus, isDesktop, officialMcpClientConfiguration, probeOfficialMcp, setExternalManagement, type ExternalManagementStatus, type OfficialMcpClient, type OfficialMcpProbe, type ServiceProfile } from '@strata-manager/core';
import { CircleHelp } from 'lucide-react';
import { Dropdown, OfficialDialog as Dialog } from './OfficialControls';
import './mcp-integration-panel.css';

export function McpIntegrationPanel({ profile, managedServiceActive, probe = probeOfficialMcp, readOwnership = externalManagementStatus, changeOwnership = setExternalManagement, onOwnershipChange }: {
  profile?: ServiceProfile; managedServiceActive?: boolean; canHandoff?: boolean; probe?: (profileId: string) => Promise<OfficialMcpProbe>;
  readOwnership?: (profileId: string) => Promise<ExternalManagementStatus>; changeOwnership?: (profileId: string, external: boolean) => Promise<ExternalManagementStatus>; onOwnershipChange?: (status: ExternalManagementStatus) => void;
}) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const [client, setClient] = useState<OfficialMcpClient>('codex'); const [result, setResult] = useState<OfficialMcpProbe>();
  const [checkedProfile, setCheckedProfile] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [owner, setOwner] = useState<ExternalManagementStatus>(); const [ownershipBusy, setOwnershipBusy] = useState(false); const [copied, setCopied] = useState(false);
  const generation = useRef(0), ownershipGeneration = useRef(0);
  const profileIdentity = JSON.stringify([profile?.id, profile?.installDir, profile?.pythonPath]);
  useEffect(() => { generation.current++; ownershipGeneration.current++; setResult(undefined); setCheckedProfile(''); setError(''); setOwner(undefined); setBusy(false); setOwnershipBusy(false); setCopied(false); setHelpOpen(false); }, [profile?.id, profile?.installDir, profile?.pythonPath]);
  useEffect(() => {
    if (!profile || ownershipBusy) return;
    const token = ownershipGeneration.current; let canceled = false;
    // A status refresh retains the last visible ownership. Only explicit
    // handoff/refresh actions use the button's busy state.
    readOwnership(profile.id).then(value => { if (!canceled && token === ownershipGeneration.current) setOwner(value); }).catch(failure => { if (!canceled && token === ownershipGeneration.current) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => { canceled = true; };
  }, [profile?.id, profile?.installDir, profile?.pythonPath, managedServiceActive, readOwnership, ownershipBusy]);
  useEffect(() => () => { generation.current++; ownershipGeneration.current++; }, []);
  const check = async () => {
    if (!profile || busy) return;
    const token = ++generation.current; setBusy(true); setError(''); setResult(undefined);
    try { const value = await probe(profile.id); if (token === generation.current) { setResult(value); setCheckedProfile(profileIdentity); } }
    catch (failure) { if (token === generation.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (token === generation.current) setBusy(false); }
  };
  const refreshOwnership = async () => {
    if (!profile || ownershipBusy) return; const token = ++ownershipGeneration.current; setOwnershipBusy(true); setError('');
    try { const latest = await readOwnership(profile.id); if (token === ownershipGeneration.current) setOwner(latest); }
    catch (failure) { if (token === ownershipGeneration.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (token === ownershipGeneration.current) setOwnershipBusy(false); }
  };
  const handoff = async (external: boolean) => {
    if (!profile || busy || ownershipBusy) return; const token = ++ownershipGeneration.current; setOwnershipBusy(true); setError('');
    try {
      const changed = await changeOwnership(profile.id, external); if (token !== ownershipGeneration.current) return;
      setOwner(changed); setCopied(false); onOwnershipChange?.(changed);
      const latest = await readOwnership(profile.id); if (token === ownershipGeneration.current) setOwner(latest);
    } catch (failure) { if (token === ownershipGeneration.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (token === ownershipGeneration.current) setOwnershipBusy(false); }
  };
  const normalizedPath = (path: string) => { const normalized = path.replaceAll('\\', '/').replace(/\/+$/, ''); return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized; };
  const allowed = !!result && checkedProfile === profileIdentity && owner?.external === true && owner.profileId === profile?.id && !!owner.installDir && normalizedPath(owner.installDir) === normalizedPath(result.installDir);
  let snippet = '', snippetIssue = ''; if (allowed && result) { try { snippet = officialMcpClientConfiguration(result, client); } catch (failure) { snippetIssue = failure instanceof Error ? failure.message : String(failure); } }
  const copy = async () => { try { await navigator.clipboard.writeText(snippet); setCopied(true); } catch { setError(zh ? '复制失败，请在文本框中选择并复制。' : 'Copy failed. Select and copy the configuration below.'); } };
  return <section className="st-card mcp-integration-panel" aria-label={zh ? '外部助手 MCP 接入' : 'External assistant MCP integration'}>
    <div className="mcp-integration-heading"><span className="card-title">{zh ? '连接外部助手' : 'Connect an external assistant'}</span><button className="st-btn st-btn--icon" type="button" title={zh ? '接入帮助' : 'Connection help'} aria-label={zh ? '外部助手接入帮助' : 'External assistant connection help'} onClick={() => setHelpOpen(true)}><CircleHelp size={16}/></button></div>
    <p className="mcp-integration-status">{zh ? '让 Codex、Cursor 等助手查看状态并管理模型。' : 'Let assistants such as Codex or Cursor check status and manage models.'}</p>
    <div className="mcp-integration-actions"><button type="button" className="st-btn st-btn--secondary" disabled={busy || !profile || (!isDesktop() && probe === probeOfficialMcp)} onClick={() => void check()}>{busy ? (zh ? '正在检查…' : 'Checking…') : (zh ? '检查连接' : 'Check connection')}</button>{result && <span role="status" className="mcp-integration-status">{zh ? '连接可用' : 'Connection ready'} · {result.tools.length} {zh ? '个工具' : 'tools'}</span>}</div>
    {error && <div className="mcp-integration-error" role="alert">{error.startsWith('复制失败') || error.startsWith('Copy failed') ? error : (zh ? '接入操作未完成。' : 'The connection operation did not complete.')}<button type="button" className="mcp-integration-diagnostic" onClick={() => setHelpOpen(true)}>{zh ? '查看诊断' : 'View diagnostic'}</button></div>}
    <div className="mcp-integration-ownership">
    <div className="mcp-integration-actions"><span className="mcp-integration-status" role="status">{owner?.external ? (zh ? '由外部助手管理' : 'Managed by an external assistant') : owner ? (zh ? '由本应用管理' : 'Managed by this app') : (zh ? '正在读取管理方式…' : 'Reading management mode…')}</span><button type="button" className="st-btn st-btn--secondary" disabled={!profile || ownershipBusy || busy} onClick={() => void refreshOwnership()}>{zh ? '刷新状态' : 'Refresh status'}</button><button type="button" className="st-btn st-btn--primary" disabled={ownershipBusy || busy || !owner || (owner.external ? !owner.canResume : !owner.canHandoff || !result)} onClick={() => void handoff(!owner?.external)}>{ownershipBusy ? (zh ? '正在切换…' : 'Switching…') : owner?.external ? (zh ? '改由本应用管理' : 'Manage with this app') : (zh ? '改由外部助手管理' : 'Manage with an external assistant')}</button></div>
    <p className="mcp-integration-status">{zh ? '外部助手管理时，本应用暂停启动和自动恢复。切换影响同一安装目录内的所有模型。' : 'External management pauses this app’s starts and recovery for every model in the same installation.'}</p>
    <p className="mcp-integration-status">{zh ? '切换前先停止模型、完成安装，并断开助手连接。' : 'Stop models, finish installation and disconnect the assistant before switching.'}</p>
    {owner?.reason && <p className="mcp-integration-status" role="status">{owner.reason}</p>}
    </div>
    {snippetIssue && <p className="mcp-integration-error" role="alert">{snippetIssue}</p>}
    {allowed && <><div className="st-field"><label className="st-label">{zh ? '选择助手' : 'Choose an assistant'}</label><Dropdown ariaLabel={zh ? 'MCP 客户端' : 'MCP client'} value={client} onValueChange={value => { setClient(value as OfficialMcpClient); setCopied(false); }} options={[{value:'codex',label:'Codex'},{value:'cursor',label:'Cursor'},{value:'claude-desktop',label:'Claude Desktop'},{value:'vscode',label:'VS Code'}]}/></div><textarea className="st-input mcp-integration-code" rows={9} readOnly spellCheck={false} value={snippet} aria-label={zh ? '无密钥 MCP 客户端配置' : 'MCP client configuration without secrets'}/><button type="button" className="st-btn st-btn--secondary" disabled={!snippet} onClick={() => void copy()}>{copied ? (zh ? '已复制' : 'Copied') : (zh ? '复制接入配置' : 'Copy connection settings')}</button><p className="mcp-integration-status">{zh ? '把配置添加到助手的 MCP 设置中，保留已有条目。' : 'Add this to the assistant’s MCP settings, keeping existing entries.'}</p></>}
    {helpOpen && <Dialog title={zh ? '外部助手接入说明' : 'External assistant connection'} onClose={() => setHelpOpen(false)}><div className="mcp-integration-help-content"><p>{zh ? '检查连接只读取官方 MCP 的连接信息和工具清单，不运行工具。交给外部助手后，本应用会暂停此安装目录内的启动、自动加载和恢复；切回后才恢复本应用管理。切换本身不会启停模型。' : 'The connection check reads official MCP information and lists tools without running them. External management pauses this app’s starts, auto-load and recovery for the installation; switching back restores management. Switching itself does not start or stop models.'}</p><p>{zh ? '配置不含 API Key。复制后添加到助手的 MCP 设置，保留已有条目；官方安装工具仍会要求确认。' : 'Settings contain no API key. Add the copied settings to the assistant’s MCP configuration, keeping existing entries; official installation tools still require confirmation.'}</p>{result && <><h3>{zh ? '已提供的工具' : 'Available tools'}</h3><p>{result.serverName} · {result.protocolVersion}</p><div className="mcp-integration-tools">{result.tools.map(tool => <span className="chip" key={tool.name}>{tool.name}{!tool.readOnly && <span className="muted"> · {zh ? '可修改' : 'can modify'}</span>}</span>)}</div></>}{error && <><h3>{zh ? '诊断' : 'Diagnostic'}</h3><pre>{error}</pre></>}</div></Dialog>}

  </section>;
}
