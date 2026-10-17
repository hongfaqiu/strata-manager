import type { AppLanguage } from "@strata-manager/core";
import { useState } from 'react';
import { Copy, ExternalLink } from 'lucide-react';
import { normalizeBaseUrl, type ServiceProfile } from '@strata-manager/core';
import { Dialog } from './components';
import { Dropdown, Segmented } from './OfficialControls';
import { apiCodeExample, apiIntegrationDocs, claudeCodeLaunch, codexConfigToml, codexLaunch, cursorEnvConfig, openCodeConfig, openCodeLaunch, type ApiCodeExample, type ApiConnection, type ApiShell } from './apiIntegration';
import './api-integration-dialog.css';
import { ApiVerificationPanel } from './ApiVerificationPanel';

interface Props {
  profile: ServiceProfile;
  model?: string;
  online: boolean;
  loaded: boolean;
  keyRequired?: boolean;
  language: AppLanguage;
  onCopy: (content: string) => void;
  onClose: () => void;
}

type Method = 'code' | 'cherry' | 'opencode' | 'claude' | 'cursor' | 'codex';

export function ApiIntegrationDialog({ profile, model, online, loaded, keyRequired, language, onCopy, onClose }: Props) {
  const zh = language === 'zh-CN';
  const [method, setMethod] = useState<Method>('cherry');
  const [example, setExample] = useState<ApiCodeExample>('powershell');
  const [shell, setShell] = useState<ApiShell>('powershell');
  let rootUrl = '';
  try { rootUrl = normalizeBaseUrl(profile.baseUrl); } catch { /* Invalid profile addresses cannot generate runnable examples. */ }
  const actualModel = model?.trim() ? model : '';
  const connection: ApiConnection = { rootUrl, model: actualModel, keyRequired };
  const configured = !!rootUrl && !!actualModel;
  const code = (title: string, content: string) => <section className="api-integration-code"><header><strong>{title}</strong><button type="button" disabled={!configured} onClick={() => onCopy(content)}><Copy size={14}/>{zh ? '复制' : 'Copy'}</button></header><pre tabIndex={0} aria-label={title}>{content}</pre></section>;
  const copyValue = (label: string, value: string, hint?: string) => <div className="api-integration-value"><span>{label}{hint && <small>{hint}</small>}</span><code>{value || '—'}</code><button type="button" className="st-btn st-btn--icon" disabled={!value} data-tooltip={zh ? `复制${label}` : `Copy ${label}`} aria-label={zh ? `复制${label}` : `Copy ${label}`} onClick={() => onCopy(value)}><Copy size={14}/></button></div>;
  const shellPicker = <Dropdown ariaLabel={zh ? '终端类型' : 'Shell'} value={shell} onValueChange={value => setShell(value as ApiShell)} compact options={[{value:'powershell',label:'PowerShell'},{value:'bash',label:'Bash / zsh'}]}/>;
  const officialLink = (url: string) => <a className="api-integration-docs" href={url} target="_blank" rel="noreferrer">{zh ? '官方配置说明' : 'Official setup guide'}<ExternalLink size={13}/></a>;

  return <Dialog wide title={zh ? '接入 API' : 'Connect to the API'} onClose={onClose}><div className="api-integration-dialog">
    <div className="api-integration-summary">
      {copyValue(zh ? 'OpenAI 地址' : 'OpenAI base URL', rootUrl ? `${rootUrl}/v1` : '')}
      {copyValue(zh ? '模型名' : 'Model ID', actualModel)}
    </div>
    {!rootUrl ? <p className="notice error" role="alert">{zh ? '服务地址无效，请检查服务配置。' : 'The service address is invalid. Check the service configuration first.'}</p> : !online ? <p className="notice warning" role="status">{zh ? '当前服务未连接。请确认服务已启动；接入方式可以先看。' : 'The service is disconnected. Check that it is running; you can review the setup steps now.'}</p> : !loaded ? <p className="notice warning" role="status">{zh ? '模型还在加载，完成后再调用。' : 'The model is still loading. Send requests once it is ready.'}</p> : null}
    {!actualModel && <p className="api-integration-hint" role="status">{zh ? '启用模型后会填入模型名，并可复制示例。' : 'Enable a model to fill in its ID and copy the examples.'}</p>}
    <p className="api-integration-hint">{keyRequired === false ? (zh ? '无需密钥。客户端必填时写 strata-local。' : 'No key required. Use strata-local if the client asks for one.') : keyRequired === true ? (zh ? '把 YOUR_STRATA_API_KEY 换成服务密钥。' : 'Replace YOUR_STRATA_API_KEY with your current service key.') : (zh ? '尚未确认是否需要密钥。有密钥就填密钥，没有就写 strata-local。' : 'Key requirement not checked yet. Use your service key, or strata-local if there is none.')}</p>
    <ApiVerificationPanel profile={profile} model={model} ready={online && loaded} language={language}/>
    <Segmented ariaLabel={zh ? '接入方式' : 'Connection method'} value={method} onValueChange={value => setMethod(value as Method)} options={[{value:'cherry',label:'Cherry Studio'},{value:'code',label:zh?'代码调用':'Code'},{value:'cursor',label:'Cursor'},{value:'claude',label:'Claude Code'},{value:'codex',label:'Codex'},{value:'opencode',label:'OpenCode'}]}/>
    <div className="api-integration-method">
      {method === 'cherry' && <>
        <ol className="api-integration-steps"><li>{zh ? '设置 → 模型服务 → 添加，类型选 OpenAI，命名为 Strata。' : 'Settings → Model Provider → Add. Choose OpenAI and name it Strata.'}</li><li>{zh ? '填入下方地址、密钥和模型 ID，或点“同步模型”。' : 'Enter the address below, your key and the model ID, or use Sync models.'}</li><li>{zh ? '打开启用开关并做一次“模型检测”，即可在聊天里使用。' : 'Enable the provider, run Model Check, then pick the model in chat.'}</li></ol>
        <div className="api-integration-summary">{copyValue(zh ? 'Cherry API 地址' : 'Cherry API host', rootUrl, zh ? '自动追加 /v1/chat/completions' : 'Appends /v1/chat/completions automatically')}{copyValue(zh ? '模型 ID' : 'Model ID', actualModel)}</div>
        {officialLink(apiIntegrationDocs.cherry)}
      </>}
      {method === 'code' && <>
        <div className="api-integration-toolbar"><span>{zh ? 'OpenAI 兼容调用' : 'OpenAI compatible request'}</span><Dropdown ariaLabel={zh ? '代码语言' : 'Code language'} value={example} onValueChange={value => setExample(value as ApiCodeExample)} compact options={[{value:'powershell',label:'PowerShell'},{value:'curl',label:'curl (Bash)'},{value:'python',label:'Python'},{value:'javascript',label:'JavaScript (Node.js)'}]}/></div>
        {configured ? code(zh ? '请求示例' : 'Request example', apiCodeExample(connection, example)) : <p className="api-integration-hint">{zh ? '服务就绪后显示请求示例。' : 'The request example appears once the service is ready.'}</p>}
      </>}
      {method === 'opencode' && <>
        <p className="api-integration-hint">{zh ? '把配置合并进项目根目录的 opencode.json（保留原有内容），再在同一终端启动 OpenCode。' : 'Merge into opencode.json in your project root (keep existing settings), then start OpenCode from the same terminal.'}</p>
        {configured && code('opencode.json', openCodeConfig(connection))}
        <div className="api-integration-toolbar"><span>{zh ? '启动命令' : 'Launch command'}</span>{shellPicker}</div>
        {configured && code(zh ? '终端命令' : 'Terminal command', openCodeLaunch(connection, shell))}
        <p className="api-integration-hint">{zh ? '需选支持工具调用的模型；实际效果以 OpenCode 中使用为准。' : 'Use a model that supports tool calls; confirm results in OpenCode.'}</p>
        {officialLink(apiIntegrationDocs.opencode)}
      </>}
      {method === 'claude' && <>
        <p className="api-integration-hint">{zh ? '在装有 Claude Code 的终端运行，只对当前终端生效；主模型和后台模型都指向本机模型。' : 'Run in a terminal with Claude Code installed. Applies to that terminal only; main and background models both use the local model.'}</p>
        <div className="api-integration-summary">{copyValue('Anthropic Base URL', rootUrl, zh ? '使用根地址，不附加 /v1' : 'Use the service root, without /v1')}</div>
        <div className="api-integration-toolbar"><span>{zh ? '终端类型' : 'Shell'}</span>{shellPicker}</div>
        {configured && code(zh ? '配置并启动' : 'Configure and launch', claudeCodeLaunch(connection, shell))}
        <p className="api-integration-hint">{zh ? '走 Anthropic Messages 接口；工具调用效果取决于模型。' : 'Uses Anthropic Messages; tool use depends on the model.'}</p>
        {officialLink(apiIntegrationDocs.claude)}
      </>}
      {method === 'cursor' && <>
        <p className="api-integration-hint">{zh ? '在装有 Cursor 的终端设置环境变量并打开项目，再在 Cursor 里选本地模型名。' : 'Set the variables in a terminal with Cursor installed, open the project, then pick the local model in Cursor.'}</p>
        <div className="api-integration-toolbar"><span>{zh ? '终端类型' : 'Shell'}</span>{shellPicker}</div>
        {configured && code(zh ? '配置并打开 Cursor' : 'Configure and open Cursor', cursorEnvConfig(connection, shell))}
        <p className="api-integration-hint">{zh ? '走 OpenAI 兼容 /v1；模型列表和工具能力以 Cursor 为准。' : 'Uses OpenAI-compatible /v1; model list and tools depend on Cursor.'}</p>
        {officialLink(apiIntegrationDocs.cursor)}
      </>}
      {method === 'codex' && <>
        <p className="api-integration-hint">{zh ? '把片段合并进 ~/.codex/config.toml（保留原有内容），再在同一终端启动 Codex。' : 'Merge into ~/.codex/config.toml (keep existing settings), then start Codex from the same terminal.'}</p>
        {configured && code('config.toml', codexConfigToml(connection))}
        <div className="api-integration-toolbar"><span>{zh ? '启动命令' : 'Launch command'}</span>{shellPicker}</div>
        {configured && code(zh ? '终端命令' : 'Terminal command', codexLaunch(connection, shell))}
        <p className="api-integration-hint">{zh ? '走 OpenAI 兼容接口；Agent 完整流程取决于 Codex 版本。' : 'Uses the OpenAI-compatible API; the agent flow depends on your Codex version.'}</p>
        {officialLink(apiIntegrationDocs.codex)}
      </>}
    </div>
  </div></Dialog>;
}
