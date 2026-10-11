import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as core from '@strata-manager/core';
import { SetupAdvancedOptions } from '../../src/pages/SetupAdvancedOptions';
import { ModelInspectPanel } from '../../src/pages/ModelInspectPanel';
import { ChatAdvancedOptions } from '../../src/ChatAdvancedOptions';
import { officialSamplingDefaults } from '../../src/ChatSettings';
import { McpIntegrationPanel } from '../../src/McpIntegrationPanel';
import { RuntimeOperationsPanel } from '../../src/RuntimeOperationsPanel';
import { SlotMonitor } from '../../src/SlotMonitor';
import { TuningPage } from '../../src/pages/TuningPage';
import '../../src/i18n';
import '../../src/styles.css';
import '../../src/official/tokens.css';
import '../../src/official/components.css';
import '../../src/official-controls.css';
import '../../src/official-pages.css';

const fixture = (window as unknown as { __fixture: { profiles: core.ServiceProfile[]; featureStatus: core.JsonObject; featureMetrics: core.JsonObject; runtimeEvidence: core.ChatRuntimeEvidence; configs: Record<string, core.JsonObject>; chatBody?:core.JsonObject } }).__fixture;
const profile = fixture.profiles[0]!;
const query = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
const docs: core.ChatMessage[] = [{ id:'document', role:'user', content:'长文😀内容供固定前缀测试。', createdAt:1 }, { id:'question', role:'user', content:'请给出 JSON 回答。', createdAt:2 }];

function FeatureFixture() {
  const tab = new URLSearchParams(location.search).get('tab') ?? 'setup';
  const [setup, setSetup] = useState<core.OfficialSetupOptions>({ ...core.DEFAULT_SETUP_OPTIONS });
  const [valid, setValid] = useState(true);
  const [chat, setChat] = useState<core.ChatOptions>({ ...officialSamplingDefaults, model: profile.name });
  const [body, setBody] = useState('');
  const capabilities = core.parseChatCapabilities(fixture.featureStatus, fixture.featureMetrics, fixture.configs.a, fixture.runtimeEvidence);
  return <main className="official-surface" style={{padding:24,maxWidth:1100,margin:'auto'}}><h1 style={{fontSize:20,marginBottom:18}}>官方功能 · 隔离交互验证</h1>
    {tab === 'setup' && <><SetupAdvancedOptions language="zh-CN" value={setup} onChange={setSetup} onValidityChange={setValid}/><button className="st-btn st-btn--primary" disabled={!valid} onClick={() => void core.runSetup(profile,'swift','IQ3_S',8192,false,core.normalizeOfficialSetupOptions(setup))}>提交准备选项</button><ModelInspectPanel language="zh-CN" desktop installationId={profile.id} onInspect={core.inspectModel}/></>}
    {tab === 'chat' && <><ChatAdvancedOptions options={chat} capabilities={capabilities} messages={docs} onChange={setChat}/><button className="st-btn st-btn--primary" onClick={() => { try { const request=core.buildChatRequest(docs,{...chat,capabilities});fixture.chatBody=request;setBody(JSON.stringify(request,null,2)); } catch(error) {setBody(String(error));} }}>构造聊天请求</button><pre data-testid="chat-request" style={{whiteSpace:'pre-wrap'}}>{body}</pre></>}
    {tab === 'mcp' && <McpIntegrationPanel profile={profile} managedServiceActive={false} canHandoff/>}
    {tab === 'resources' && <><SlotMonitor raw={fixture.featureMetrics} language="zh-CN"/><RuntimeOperationsPanel profile={profile} online owned language="zh-CN"/></>}
    {tab === 'tuning' && <TuningPage profileId={profile.id} language="zh-CN" desktop owned streaming={false} onChanged={() => {}}/>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={query}><FeatureFixture/></QueryClientProvider>);
