import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as core from '@strata-manager/core';
import type { ChatMessage, ChatOptions, ChatRuntimeEvidence, JsonObject, ServiceProfile } from '@strata-manager/core';
import { Dialog } from './components';
import { NumberField, Segmented, Slider, Toggle } from './OfficialControls';
import { ChatAdvancedOptions } from './ChatAdvancedOptions';

export type ChatPreferences={showReasoning:boolean};
export const defaultChatPreferences:ChatPreferences={showReasoning:true};
export const officialSamplingDefaults:ChatOptions={model:'',reasoningEffort:'high',temperature:0.6,topP:0.95,topK:20,seed:null,maxTokens:0,systemPrompt:'',mcp:true,experimentalSpeedProjection:true};
const obj=(value:unknown):JsonObject=>value&&typeof value==='object'&&!Array.isArray(value)?value as JsonObject:{};
export function SamplingDrawer({profile,options,preferences,hasProjection,online,mcpInfo,messages,statusInfo,metricsInfo,configInfo,runtimeEvidence,onApply,onClose,onError,onMessage}: {
  profile?:ServiceProfile;options:ChatOptions;preferences:ChatPreferences;models?:string[];hasProjection:boolean;online:boolean;mcpInfo?:JsonObject;
  messages?:ChatMessage[];statusInfo?:JsonObject;metricsInfo?:JsonObject;configInfo?:JsonObject;runtimeEvidence?:ChatRuntimeEvidence;
  onApply:(options:ChatOptions,preferences:ChatPreferences)=>void;onClose:()=>void;onError:(error:unknown)=>void;onMessage:(message:string)=>void;
}) {
  const {t}=useTranslation();const [draft,setDraft]=useState({...officialSamplingDefaults,...options});const [ui,setUi]=useState(preferences);const [share,setShare]=useState(false);const [saving,setSaving]=useState(false);
  const shared=useQuery({queryKey:['shared-sampling',profile?.id,profile?.baseUrl],queryFn:()=>core.request(profile!,'/settings'),enabled:!!profile&&online});
  const status=useQuery({queryKey:['chat-capabilities',profile?.id,profile?.baseUrl],queryFn:()=>core.request(profile!,'/v1/status'),enabled:!!profile&&online&&!statusInfo});
  const metrics=useQuery({queryKey:['chat-capabilities-metrics',profile?.id,profile?.baseUrl],queryFn:()=>core.request(profile!,'/metrics'),enabled:!!profile&&online&&!metricsInfo});
  const runtime=useQuery({queryKey:['chat-runtime-evidence',profile?.id,profile?.baseUrl,profile?.configPath],queryFn:()=>core.getChatRuntimeEvidence(profile!.id),enabled:core.isDesktop()&&!!profile&&online&&!runtimeEvidence,retry:false,refetchOnWindowFocus:false});
  const capabilities=core.parseChatCapabilities(online?(statusInfo??status.data):undefined,online?(metricsInfo??metrics.data):undefined,configInfo,online?(runtimeEvidence??runtime.data):undefined);
  if(!capabilities.prefix&&runtime.error)capabilities.prefixReason='无法核验当前引擎的实际启动参数；固定前缀暂不可用';
  useEffect(()=>{if(shared.data)setShare(shared.data.shared===true);},[shared.data]);
  const update=<K extends keyof ChatOptions>(key:K,value:ChatOptions[K])=>setDraft(old=>({...old,[key]:value}));
  const apply=async()=>{setSaving(true);try{const value={...draft,capabilities,experimentalSpeedProjection:hasProjection?draft.experimentalSpeedProjection!==false:undefined};const defaults=core.buildSharedDefaults(value);core.buildAdvancedChatFields(value);if(profile&&online&&(share||shared.data?.shared===true))await core.request(profile,'/settings','POST',{defaults:share?defaults:null});onApply({...value,capabilities:undefined},ui);onClose();}catch(error){onError(error);}finally{setSaving(false);}};
  const servers=Array.isArray(mcpInfo?.servers)?mcpInfo.servers.map(obj):[];
  const thinkingOutput=draft.reasoningEffort==='off'?'samplingImmediate':draft.reasoningEffort==='low'?'samplingShort':draft.reasoningEffort==='medium'?'samplingMedium':'samplingThorough';
  return <Dialog title={t('sampling')} drawer onClose={()=>{if(!saving)onClose();}}>
    <div className="st-field"><label className="st-label" htmlFor="s-thinking">{t('samplingThinking')}<output id="o-thinking">{t(thinkingOutput)}</output></label><Segmented id="s-thinking" ariaLabel={t('samplingThinking')} value={draft.reasoningEffort} onValueChange={value=>update('reasoningEffort',value as ChatOptions['reasoningEffort'])} options={[{value:'off',label:t('reasoningOff')},{value:'low',label:t('reasoningLow')},{value:'medium',label:t('reasoningMedium')},{value:'high',label:'xhigh'}]}/></div>
    <div className="st-field"><label className="st-label" htmlFor="s-temp">{t('temperature')}<output id="o-temp">{draft.temperature===0?t('temperatureGreedy'):draft.temperature.toFixed(2)}</output></label><Slider id="s-temp" ariaLabel={t('temperature')} min={0} max={1.5} step={0.05} value={draft.temperature} onValueChange={value=>update('temperature',value)}/><span className="muted small">{t('temperatureHint')}</span></div>
    <div className="st-field"><label className="st-label" htmlFor="s-topp">Top-p<output id="o-topp">{draft.topP.toFixed(2)}</output></label><Slider id="s-topp" ariaLabel={t('topP')} min={0.05} max={1} step={0.05} value={draft.topP} disabled={draft.temperature===0} onValueChange={value=>update('topP',value)}/></div>
    <div className="st-field"><label className="st-label" htmlFor="s-topk">Top-k<output id="o-topk">{draft.topK??20}</output></label><Slider id="s-topk" ariaLabel={t('topK')} min={1} max={64} step={1} value={draft.topK??20} disabled={draft.temperature===0} onValueChange={value=>update('topK',value)}/></div>
    <div className="st-field"><label className="st-label" htmlFor="s-max">{t('samplingMax')}<output>{t('emptyUntilDone')}</output></label><NumberField className="st-input" id="s-max" min={1} step={1} placeholder={t('untilDone')} value={draft.maxTokens||''} onChange={event=>update('maxTokens',event.target.value===''?0:Math.max(1,Math.floor(Number(event.target.value))))}/></div>
    <div className="st-field"><label className="st-label" htmlFor="s-seed">{t('samplingSeed')}<output>{t('emptyRandom')}</output></label><NumberField className="st-input" id="s-seed" min={1} step={1} placeholder={t('randomSeed')} value={draft.seed??''} onChange={event=>update('seed',event.target.value===''?null:Math.max(1,Math.floor(Number(event.target.value))))}/></div>
    <div className="toggle-row"><span>{t('showThinking')}<br/><span className="muted small">{t('showThinkingHint')}</span></span><Toggle id="s-show" ariaLabel={t('showThinking')} checked={ui.showReasoning} onCheckedChange={checked=>setUi({showReasoning:checked})}/></div>
    {!!servers.length&&<div className="toggle-row" id="mcp-row"><span>{t('mcpSampling')}<br/><span className="muted small" id="mcp-row-sub">{mcpInfo?.tools?t('mcpToolsFrom',{count:mcpInfo.tools,servers:servers.filter(server=>server.status==='ready'||server.status==='stopped').map(server=>server.name).join(', ')}):t('mcpNoServer')}</span></span><Toggle id="s-mcp" ariaLabel={t('mcpSampling')} checked={draft.mcp} disabled={saving||(draft.advanced?.responseFormat!==undefined&&draft.advanced.responseFormat!=='text')} onCheckedChange={checked=>update('mcp',checked)}/></div>}
    {hasProjection&&<div className="toggle-row" id="esp-row"><span>{t('esp')}<br/><span className="muted small">{t('espSamplingHint')}</span></span><Toggle id="s-esp" ariaLabel={t('esp')} checked={draft.experimentalSpeedProjection!==false} onCheckedChange={checked=>update('experimentalSpeedProjection',checked)}/></div>}
    <div className="toggle-row"><span>{t('sharedSampling')}<br/><span className="muted small">{t('shareSamplingHint')}</span></span><Toggle id="s-share" ariaLabel={t('sharedSampling')} checked={share} disabled={!online||!profile||!!shared.error||shared.isPending} onCheckedChange={setShare}/></div>
    <ChatAdvancedOptions options={draft} capabilities={capabilities} messages={messages} disabled={saving} onChange={setDraft}/>
    <div className="drawer-actions"><button className="st-btn st-btn--secondary" id="s-reset" type="button" disabled={saving} onClick={()=>{setDraft({...officialSamplingDefaults,model:draft.model,systemPrompt:draft.systemPrompt});setUi(defaultChatPreferences);}}>{t('reset')}</button><button className="st-btn st-btn--primary" id="s-apply" type="button" disabled={saving} onClick={()=>void apply()}>{t('apply')}</button></div>
  </Dialog>;
}
