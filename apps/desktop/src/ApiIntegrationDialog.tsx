import type { AppLanguage } from "@strata-manager/core";
import { useState } from 'react';
import { Copy, ExternalLink } from 'lucide-react';
import { normalizeBaseUrl, type ServiceProfile } from '@strata-manager/core';
import { Dialog } from './components';
import { Dropdown, Segmented } from './OfficialControls';
import { apiCodeExample, apiIntegrationDocs, claudeCodeLaunch, openCodeConfig, openCodeLaunch, type ApiCodeExample, type ApiConnection, type ApiShell } from './apiIntegration';
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

type Method = 'code' | 'cherry' | 'opencode' | 'claude';

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
    {!rootUrl ? <p className="notice error" role="alert">{zh ? '当前服务地址无效，请先检查服务配置。' : 'The service address is invalid. Check the service configuration first.'}</p> : !online ? <p className="notice warning" role="status">{zh ? '当前服务未连接，请确认服务已启动且地址可访问。可先查看接入方式。' : 'The service is disconnected. Check that it is running and its address is reachable; you can review setup steps now.'}</p> : !loaded ? <p className="notice warning" role="status">{zh ? '模型尚未就绪，请等待加载完成后调用。' : 'The model is not ready yet. Wait for it to finish loading before sending requests.'}</p> : null}
    {!actualModel && <p className="api-integration-hint" role="status">{zh ? '启用模型后将自动填入实际模型名并开放示例复制。' : 'Enable a model to fill in its actual ID and copy the examples.'}</p>}
    <p className="api-integration-hint">{keyRequired === false ? (zh ? '当前服务无需密钥；客户端要求时可填写 strata-local。' : 'This service requires no key. Use strata-local if the client requires one.') : keyRequired === true ? (zh ? '请将 YOUR_STRATA_API_KEY 替换为当前服务密钥。' : 'Replace YOUR_STRATA_API_KEY with your current service key.') : (zh ? '服务鉴权状态尚未核验；有密钥时填写当前服务密钥，无密钥可填 strata-local。' : 'Authentication has not been checked. Use your service key if required, or strata-local otherwise.')}</p>
    <ApiVerificationPanel profile={profile} model={model} ready={online && loaded} language={language}/>
    <Segmented ariaLabel={zh ? '接入方式' : 'Connection method'} value={method} onValueChange={value => setMethod(value as Method)} options={[{value:'cherry',label:'Cherry Studio'},{value:'code',label:zh?'代码调用':'Code'},{value:'opencode',label:'OpenCode'},{value:'claude',label:'Claude Code'}]}/>
    <div className="api-integration-method">
      {method === 'cherry' && <>
        <ol className="api-integration-steps"><li>{zh ? '打开“设置 → 模型服务 → 添加”，选择 OpenAI 类型并命名为 Strata。' : 'Open Settings → Model Provider → Add. Choose the OpenAI type and name it Strata.'}</li><li>{zh ? '填写下方地址、当前服务密钥和模型 ID；也可用“同步模型”获取列表。' : 'Enter the address below, your service key and the model ID, or use Sync models.'}</li><li>{zh ? '打开服务商启用开关，完成“模型检测”，即可在聊天中选择模型。' : 'Enable the provider and run Model Check, then select the model in chat.'}</li></ol>
        <div className="api-integration-summary">{copyValue(zh ? 'Cherry API 地址' : 'Cherry API host', rootUrl, zh ? '自动追加 /v1/chat/completions' : 'Appends /v1/chat/completions automatically')}{copyValue(zh ? '模型 ID' : 'Model ID', actualModel)}</div>
        {officialLink(apiIntegrationDocs.cherry)}
      </>}
      {method === 'code' && <>
        <div className="api-integration-toolbar"><span>{zh ? 'OpenAI 兼容调用' : 'OpenAI compatible request'}</span><Dropdown ariaLabel={zh ? '代码语言' : 'Code language'} value={example} onValueChange={value => setExample(value as ApiCodeExample)} compact options={[{value:'powershell',label:'PowerShell'},{value:'curl',label:'curl (Bash)'},{value:'python',label:'Python'},{value:'javascript',label:'JavaScript (Node.js)'}]}/></div>
        {configured ? code(zh ? '请求示例' : 'Request example', apiCodeExample(connection, example)) : <p className="api-integration-hint">{zh ? '服务就绪后显示完整请求示例。' : 'The full request example appears when service details are available.'}</p>}
      </>}
      {method === 'opencode' && <>
        <p className="api-integration-hint">{zh ? '将配置合并到项目根目录的 opencode.json，保留已有配置。在同一终端设置密钥并启动 OpenCode。' : 'Merge into opencode.json in your project root, keeping existing settings. Set the key and start OpenCode in the same terminal.'}</p>
        {configured && code('opencode.json', openCodeConfig(connection))}
        <div className="api-integration-toolbar"><span>{zh ? '启动命令' : 'Launch command'}</span>{shellPicker}</div>
        {configured && code(zh ? '终端命令' : 'Terminal command', openCodeLaunch(connection, shell))}
        <p className="api-integration-hint">{zh ? '使用支持工具调用的模型。客户端实际调用仍需在 OpenCode 中验证。' : 'Use a model that supports tool calls. Verify actual requests in OpenCode.'}</p>
        {officialLink(apiIntegrationDocs.opencode)}
      </>}
      {method === 'claude' && <>
        <p className="api-integration-hint">{zh ? '在已安装 Claude Code 的终端运行下方配置，仅作用于当前终端。主模型与后台模型均指向当前本机模型。' : 'Run this in a terminal with Claude Code installed. It applies to that terminal only and routes main and background models to the selected local model.'}</p>
        <div className="api-integration-summary">{copyValue('Anthropic Base URL', rootUrl, zh ? '使用根地址，不附加 /v1' : 'Use the service root, without /v1')}</div>
        <div className="api-integration-toolbar"><span>{zh ? '终端类型' : 'Shell'}</span>{shellPicker}</div>
        {configured && code(zh ? '配置并启动' : 'Configure and launch', claudeCodeLaunch(connection, shell))}
        <p className="api-integration-hint">{zh ? '通过 Anthropic Messages 接口调用；工具调用效果取决于模型，客户端完整流程尚未实测。' : 'Uses Anthropic Messages. Tool use depends on the model; the complete client flow has not been tested.'}</p>
        {officialLink(apiIntegrationDocs.claude)}
      </>}
    </div>
  </div></Dialog>;
}
