import type { AppLanguage } from "@strata-manager/core";
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as core from '@strata-manager/core';
import type { JsonObject, ServiceProfile } from '@strata-manager/core';
import type { TextKey } from './i18n';
import { Dropdown } from './OfficialControls';
import { WorkspaceHeader, WorkspaceLayout } from './layouts/WorkspaceLayout';
const obj=(value:unknown):JsonObject=>value&&typeof value==='object'&&!Array.isArray(value)?value as JsonObject:{};
const httpStatus=(error:unknown)=>num(obj(error).status)??num(obj(error).statusCode)??Number(/\bHTTP\s+(\d{3})\b/.exec(String(error))?.[1]??0);
const retryPolling=(error:unknown)=>![401,403,404].includes(httpStatus(error));
// A query clears uncached errors while fetching; keep the notice until it succeeds.
function useRetainedQueryError(error:unknown,succeeded:boolean,scope:string) {
  const [previous,setPrevious]=useState<{scope:string;error:unknown}>({scope,error:null});
  useEffect(()=>{if(error||succeeded)setPrevious({scope,error:error??null});},[scope,error,succeeded]);
  return error??(previous.scope===scope?previous.error:null);
}
const num=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:null;
const terminal=(value:unknown)=>['completed','error','disconnected','cancelled'].includes(String(value));
const seconds=(value:unknown,locale:string)=>num(value)===null?'—':`${num(value)!.toLocaleString(locale,{minimumFractionDigits:2,maximumFractionDigits:2})} s`;
const textValue=(value:unknown):string=>typeof value==='string'?value:value==null?'':JSON.stringify(value,null,2);
const stateKey=(value:unknown):TextKey=>({completed:'completed',error:'error',disconnected:'disconnectedState',cancelled:'cancelled',loading:'loadingState',reading:'readingState',generating:'generatingState',queued:'queuedState',pending:'pendingState',preparing:'preparingState'} as Record<string,TextKey>)[String(value)]??'unknown';
export function RequestViewer({profile,online,language,pollInterval,noProfile,errorText,onError,onMessage,initialSelected,embedded=false,onEnableViewer,onOpenUsage}: {
  profile?:ServiceProfile;online:boolean;language:AppLanguage;pollInterval:number;controls?:ReactNode;noProfile:ReactNode;initialSelected?:string;embedded?:boolean;
  errorText:(error:unknown)=>string;onError:(error:unknown)=>void;onMessage:(value:string)=>void;
  onEnableViewer?:(minutes:0|5|15|30)=>Promise<core.RequestCaptureStatus>;onOpenUsage?:()=>void;
}) {
  const {t}=useTranslation();const [search,setSearch]=useState('');const [filter,setFilter]=useState('all');const [selected,setSelected]=useState<string|null>(initialSelected??null);const [pane,setPane]=useState<'input'|'output'|'reasoning'|'response'>('input');const [auth,setAuth]=useState(false);const [key,setKey]=useState('');const [operating,setOperating]=useState<'load'|'unload'|null>(null);const [actionError,setActionError]=useState('');const [copied,setCopied]=useState(false);
  const [enabling,setEnabling]=useState(false);
  const [captureMinutes,setCaptureMinutes]=useState<5|15|30>(15);
  const [captureClock,setCaptureClock]=useState(Date.now());
  const queryClient=useQueryClient();
  const captureWasActive=useRef<{active:boolean;profileId?:string}>({active:false});
  const captureLease=useQuery({queryKey:['request-capture',profile?.id],queryFn:()=>core.requestCaptureStatus(profile!.id),enabled:core.isDesktop()&&!!profile?.managed,refetchInterval:1000});
  const captureState=captureLease.data?.state;
  const captureActive=captureState==='temporary'&&!captureLease.error&&captureLease.data!.expiresAtMs!==null&&captureLease.data!.expiresAtMs!>captureClock;
  useEffect(()=>{if(captureState!=='temporary')return;const timer=setInterval(()=>setCaptureClock(Date.now()),1000);return()=>clearInterval(timer);},[captureState]);
  useEffect(()=>{
    if((captureWasActive.current.active&&!captureActive)||captureState==='disabled'||(captureState==='temporary'&&!captureActive)){
      setSelected(null);
      const id=captureWasActive.current.active?captureWasActive.current.profileId:profile?.id;
      queryClient.removeQueries({queryKey:['request-detail',id]});
      queryClient.removeQueries({queryKey:['requests',id]});
    }
    captureWasActive.current={active:captureActive,profileId:profile?.id};
  },[captureActive,captureState,profile?.id,queryClient]);
  useEffect(()=>()=>{
    void queryClient.cancelQueries({queryKey:['request-detail',profile?.id]});
    void queryClient.cancelQueries({queryKey:['requests',profile?.id]});
    queryClient.removeQueries({queryKey:['request-detail',profile?.id]});
    queryClient.removeQueries({queryKey:['requests',profile?.id]});
  },[profile?.id,queryClient]);
  const [refreshing,setRefreshing]=useState(false);
  const localText=language==='zh-CN'?{
    distinction:'请求查看器用于查看当前服务最近 100 条请求的输入和回答；API 使用统计持续保存调用量、缓存率和速度，关闭服务后仍可查询。',
    disabled:'当前 Strata 未开启请求查看器。API 使用统计仍可持续记录调用元数据。',
    enable:'开启临时诊断',enabling:'正在应用诊断设置',usage:'查看持久化 API 使用统计',
    enableHint:'按需在内存中保留最近 100 条输入、推理和回答；到期或关闭立即清空。服务继续运行，原配置不变。',
    retention:'临时诊断最多保留最近 100 条请求，关闭或到期后清空正文。API 统计持续保存元数据。',duration:'诊断时长',minutes:'分钟',close:'关闭并清空正文',active:'临时正文诊断已开启，自动关闭时间：',external:'请求查看器已由用户配置开启；请在原配置中管理。应用不会认领或关闭此设置。',unavailable:'临时诊断暂不可用',
    manual:'临时正文诊断需要已登记、由本应用管理的本机 Strata 和兼容的观察器。API 使用统计默认仅保存元数据。',
    unloadedHint:'释放模型占用的内存和显存，保留模型文件；下次请求可重新加载。',
  }:{
    distinction:'The request viewer shows the current service’s last 100 inputs and replies. API usage keeps call counts, cache reuse and speed after the service stops.',
    disabled:'This Strata service has not enabled the request viewer. API usage can still collect call metadata.',
    enable:'Enable temporary capture',enabling:'Applying capture settings',usage:'View persistent API usage',
    enableHint:'Keep the last 100 inputs, reasoning and replies in memory on demand. Disable or expiry erases captured bodies. The API keeps running and the original config stays unchanged.',
    retention:'Temporary capture keeps up to 100 requests in memory and erases bodies on disable or expiry. API statistics keep metadata.',duration:'Capture duration',minutes:'minutes',close:'Disable and erase bodies',active:'Temporary capture is active until ',external:'The request viewer was enabled in your configuration. Manage it in that configuration; the app will not claim or disable it.',unavailable:'Temporary capture is unavailable',
    manual:'Temporary body capture requires a registered, app-managed local Strata with a compatible observer. API usage stores metadata only by default.',
    unloadedHint:'Release model RAM and VRAM while keeping model files. The next request can load it again.',
  };
  const captureError=(error:unknown)=>{
    const message=errorText(error);
    if(language==='zh-CN'||!/[\u3400-\u9fff]/.test(message))return message;
    if(/进行中的请求|启动或维护|模型切换|正在维护|后台退出|安装或准备/.test(message))return 'The service is busy or under maintenance. Complete the current operation and retry.';
    if(/用户配置启用|用户配置已开启/.test(message))return 'The request viewer is enabled in your configuration. The app will not claim or disable it.';
    if(/兼容性|无法核验|归属|进程|登记|观察器|会话|心跳/.test(message))return 'The app cannot verify service ownership or observer compatibility. Check Diagnostics and retry.';
    return 'Temporary capture could not be confirmed. Check Diagnostics before retrying.';
  };
  const list=useQuery({queryKey:['requests',profile?.id,profile?.baseUrl],queryFn:()=>core.request(profile!,'/api/requests'),enabled:!!profile&&online,refetchInterval:query=>retryPolling(query.state.error)?pollInterval:false});
  const status=useQuery({queryKey:['api-status',profile?.id,profile?.baseUrl],queryFn:()=>core.request(profile!,'/v1/status'),enabled:!!profile&&online,refetchInterval:query=>retryPolling(query.state.error)?pollInterval:false});
  const records=Array.isArray(list.data?.requests)?list.data.requests.map(obj):[];
  const detail=useQuery({queryKey:['request-detail',profile?.id,profile?.baseUrl,selected],queryFn:()=>core.request(profile!,`/api/requests?id=${encodeURIComponent(selected!)}`),enabled:!!selected&&!!profile&&online,refetchInterval:query=>terminal(obj(query.state.data).state)||!retryPolling(query.state.error)?false:pollInterval});
  const scope=`${profile?.id}:${profile?.baseUrl}`;
  const listError=useRetainedQueryError(list.error,list.isSuccess,scope);
  const statusError=useRetainedQueryError(status.error,status.isSuccess,scope);
  const detailError=useRetainedQueryError(detail.error,detail.isSuccess,`${scope}:${selected}`);
  useEffect(()=>{setSelected(initialSelected??null);setKey('');setAuth(false);setActionError('');},[profile?.id,profile?.baseUrl]);
  useEffect(()=>{if(selected&&list.data&&!records.some(r=>String(r.id)===selected))setSelected(null);},[list.data,selected]);
  useEffect(()=>{if(httpStatus(listError)===401||httpStatus(statusError)===401)setAuth(true);},[listError,statusError]);
  useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(false),1500);return()=>clearTimeout(timer);},[copied]);
  const visible=records.filter(record=>`${record.id} ${record.path} ${record.model}`.toLowerCase().includes(search.toLowerCase())&&(filter==='all'||(filter==='active'?!terminal(record.state):record.state===filter)));
  const last=records.find(record=>terminal(record.state));const activity=obj(status.data?.activity);const inflight=Math.max(Number(activity.in_flight??0),records.filter(record=>!terminal(record.state)).length);const loading=records.some(record=>record.state==='loading');const loaded=status.data?.loaded===true||list.data?.loaded===true;
  const value=captureState==='disabled'||(captureState==='temporary'&&!captureActive)?undefined:detail.data;const usage=obj(value?.usage),timings=obj(value?.timings);
  let paneValue=value?textValue(value[pane])||(pane==='response'&&value.stream?t('streamResponseHint'):t('noCapturedContent')):'';if(pane==='output'){try{paneValue=JSON.stringify(JSON.parse(paneValue),null,2);}catch{/* plain model output */}}
  const format=(value:unknown,digits=0)=>num(value)===null?'—':num(value)!.toLocaleString(language,{maximumFractionDigits:digits});
  const refresh=()=>Promise.all([list.refetch(),status.refetch(),...(core.isDesktop()&&profile?.managed?[captureLease.refetch()]:[]),...(selected?[detail.refetch()]:[])]);
  const manualRefresh=async()=>{if(refreshing)return;setRefreshing(true);try{await refresh();}finally{setRefreshing(false);}};
  const control=async(action:'load'|'unload')=>{if(!profile||operating)return;setOperating(action);setActionError('');try{await core.request(profile,`/${action}`,'POST',{});}catch(error){setActionError(errorText(error));onError(error);}finally{setOperating(null);await refresh();}};
  const connect=async()=>{if(!profile)return;try{await core.setApiKey(profile.id,key.trim());setAuth(false);await refresh();onMessage(t('saved'));}catch(error){onError(error);}};
  const copy=async()=>{try{await navigator.clipboard.writeText(paneValue);setCopied(true);}catch(error){onError(new Error(t('clipboardUnavailable')));}};
  const error=statusError??listError;const notEnabled=httpStatus(listError)===404;const notice=actionError||(error?error===listError&&notEnabled?localText.disabled:errorText(error):!online?t('connectionHint'):'');
  const enableViewer=async(minutes:0|5|15|30)=>{if(!onEnableViewer||enabling)return;setEnabling(true);setActionError('');try{const lease=await onEnableViewer(minutes);queryClient.setQueryData(['request-capture',profile?.id],lease);setCaptureClock(Date.now());if(minutes===0){setSelected(null);queryClient.removeQueries({queryKey:['request-detail',profile?.id]});queryClient.removeQueries({queryKey:['requests',profile?.id]});}await refresh();}catch(error){const message=captureError(error);setActionError(message);onError(new Error(message));}finally{setEnabling(false);}};
  const facts:[TextKey,string,string][]=[['requestWall',seconds(value?.wallclock_s??(num(value?.started_at)!==null?Date.now()/1000-num(value?.started_at)!:null),language),'detail-wall'],['requestLoad',seconds(value?.load_s,language),'detail-load'],['requestQueue',seconds(value?.queue_s,language),'detail-queue'],['requestFirstToken',seconds(value?.first_token_s,language),'detail-first'],['promptTokens',format(usage.prompt_tokens??usage.input_tokens),'detail-prompt'],['outputTokens',format(usage.completion_tokens??usage.output_tokens),'detail-tokens'],['decode',format(timings.predicted_per_second,1),'detail-speed'],['responseFormat',String(value?.response_format??'text'),'detail-format']];
  const note=pane==='output'&&value?.error?'requestNoteDiagnosis':pane==='input'?'requestNoteInput':pane==='output'?'requestNoteOutput':pane==='reasoning'?'requestNoteReasoning':'requestNoteResponse';
  const busy=inflight>0||loading;const controlsDisabled=!profile||!online||!!statusError||(!notEnabled&&!!listError)||!!operating||enabling||inflight>0;
  const content = <><div className="request-viewer-toolbar">{onOpenUsage&&<button type="button" onClick={onOpenUsage}>{localText.usage}</button>}<div className="controls"><button type="button" disabled={!profile||!online||refreshing} onClick={()=>void manualRefresh()}>{t(refreshing?'loading':'refresh')}</button><button id="key" onClick={()=>setAuth(!auth)}>{t('apiKey')}</button></div></div>
    <p className="sub">{localText.distinction}</p>
    {(notEnabled||captureState)&&<section className="panel request-capture-notice" aria-label={localText.duration}><p>{captureState==='external'?localText.external:localText.enableHint}</p>
      {captureActive&&<p role="status">{localText.active}{new Date(captureLease.data!.expiresAtMs!).toLocaleTimeString(language)}</p>}
      {captureState==='unavailable'&&<p className="notice">{localText.unavailable}: {captureLease.data?.reason&&captureError(captureLease.data.reason)}</p>}
      {captureLease.error&&<p className="notice">{captureError(captureLease.error)}</p>}
      <div className="controls">{onEnableViewer&&profile?.managed&&captureState!=='external'&&<>{captureActive?<button type="button" disabled={enabling} onClick={()=>void enableViewer(0)}>{enabling?localText.enabling:localText.close}</button>:<><Dropdown ariaLabel={localText.duration} value={String(captureMinutes)} onValueChange={value=>setCaptureMinutes(Number(value) as 5|15|30)} disabled={enabling} options={[5,15,30].map(value=>({value:String(value),label:`${value} ${localText.minutes}`}))}/><button type="button" className="primary" disabled={enabling||inflight>0||!online||captureState!=='disabled'} onClick={()=>void enableViewer(captureMinutes)}>{enabling?localText.enabling:localText.enable}</button></>}</>}</div>
      {(!onEnableViewer||!profile?.managed)&&captureState!=='external'&&<p className="small">{localText.manual}</p>}
    </section>}

<div className="top"><div><h1>{t('apiMonitorTitle')}</h1><p className="sub">{t('apiMonitorIntro')}</p></div><div className="controls"><button id="load" className="primary" disabled={controlsDisabled||loaded} onClick={()=>void control('load')}>{t('load')}</button><button id="unload" data-tooltip={localText.unloadedHint} disabled={controlsDisabled||!loaded} onClick={()=>void control('unload')}>{t('unload')}</button></div></div><div id="error" className="notice" role="status" hidden={!notice}>{notice}</div><form id="auth" className="panel" hidden={!auth} noValidate onSubmit={event=>{event.preventDefault();void connect();}}><label htmlFor="monitor-api-key">{t('apiKey')}</label><input id="monitor-api-key" type="password" autoComplete="off" placeholder={t('apiKeyOnly')} value={key} disabled={!profile} onChange={event=>setKey(event.target.value)}/><button className="primary" disabled={!profile}>{t('connect')}</button></form>{!profile&&noProfile}
    <div className="cards"><div className="card"><div className="label">{t('model')}</div><div id="model-state" className={`value ${busy?'busy':loaded?'loaded':''}`}><span className="dot"/><span id="loaded">{t(operating==='load'?'loadingState':operating==='unload'?'unloadingState':loading?'loadingState':inflight?'modelInUse':status.data||list.data?loaded?'loaded':'modelUnloaded':'connecting')}</span></div><div id="model" className="model">{String(status.data?.model??profile?.baseUrl??'—')}</div></div><div className="card"><div className="label">{t('retainedRequests')}</div><div id="count" className="value">{list.data?records.length:'—'}</div><div id="active" className="small">{list.data?inflight?t('activeQueued',{count:inflight}):list.data.auto_load?t('autoLoads'):t('noActiveRequests'):t('waitingServer')}</div></div><div className="card"><div className="label">{t('lastWallClock')}</div><div id="wall" className="value">{seconds(last?.wallclock_s,language)}</div><div className="small">{t('wallClockIncludes')}</div></div><div className="card"><div className="label">{t('lastDecodeSpeed')}</div><div id="speed" className="value">{format(obj(last?.timings).predicted_per_second,1)}</div><div className="small">{t('engineTiming')}</div></div></div>
    <section className="panel"><div className="panel-bar"><h2>{t('requests')}</h2><div className="filters"><input id="search" aria-label={t('searchRequests')} placeholder={t('searchRequests')} value={search} onChange={event=>setSearch(event.target.value)}/><Dropdown ariaLabel={t('status')} value={filter} onValueChange={setFilter} options={[{value:'all',label:t('allStatuses')},{value:'active',label:t('activeStatus')},{value:'completed',label:t('completed')},{value:'error',label:t('errorsStatus')}]}/></div></div><div className="workspace"><div id="requests" className="requests" aria-label={t('requests')}>{visible.length?visible.map(record=><button className={`request ${String(record.id)===selected?'selected':''}`} data-request={record.id} aria-pressed={String(record.id)===selected} aria-label={`${t('requestId')} ${record.id}`} key={String(record.id)} onClick={()=>setSelected(String(record.id))}><div className="row"><span>{num(record.started_at)!==null?new Date(num(record.started_at)!*1000).toLocaleTimeString(language):'—'}</span><span className={`tag ${record.state}`}>{t(stateKey(record.state))}</span></div><div className="endpoint">{String(record.method??'POST')} {String(record.path??'—')}</div><div className="small">{String(record.id)} · {seconds(record.wallclock_s,language)} · {t(record.stream?'requestStream':'requestJson')}{record.http_status?` · HTTP ${record.http_status}`:''}</div></button>):<div className="empty">{t(records.length?'noMatchingRequests':'requestEmptyOfficial')}</div>}</div><div className="detail"><div id="no-selection" className="empty" hidden={!!selected}><strong>{t('noRequestSelected')}</strong>{t('selectRequestHint')}</div><div id="selection" hidden={!selected}>{detailError?<div className="detail-error">{errorText(detailError)}</div>:!value?<div className="empty">{t('loading')}</div>:<><div className="row"><div id="detail-title" className="detail-title">{String(value.id)} · {String(value.path??'—')}</div><span id="detail-status" className={`tag ${value.state}`}>{t(stateKey(value.state))}</span></div><div id="detail-time" className="small">{num(value.started_at)!==null?new Date(num(value.started_at)!*1000).toLocaleString(language):'—'}</div><div className="facts">{facts.map(([label,content,id])=><div className="fact" key={id}><span>{t(label)}</span><b id={id}>{content}</b></div>)}</div><div id="detail-error" className="detail-error" hidden={!value.error}>{textValue(obj(value.error).message??value.error)}</div><div className="tabs" role="tablist" aria-label={t('requestBody')}>{(['input','output','reasoning','response'] as const).map(item=><button role="tab" data-pane={item} aria-selected={pane===item} aria-controls="content" key={item} onClick={()=>setPane(item)}>{t(item==='input'?'requestInput':item==='output'?'requestOutput':item==='reasoning'?'requestReasoning':'requestResponse')}</button>)}<button id="copy" onClick={()=>void copy()}>{t(copied?'copied':'copy')}</button></div><div id="content-note" className="small" style={{marginTop:10}}>{t(note)}{value[`${pane}_truncated`]===true&&` ${t('captureTruncated')}`}</div><pre id="content" role="tabpanel" aria-label={t('requestBody')}>{paneValue}</pre></>}</div></div></div></section>
    <footer><span>{captureState&&captureState!=='external'?localText.retention:t('requestRetentionOfficial',{count:list.data?.retention??100})}</span><span id="updated">{notEnabled?localText.disabled:error||!online?t('requestDisconnected'):list.dataUpdatedAt?`${t('requestUpdated')} ${new Date(list.dataUpdatedAt).toLocaleTimeString(language)}`:t('connecting')}</span></footer></>;
  return embedded ? <div className="api-monitor-page embedded-api-monitor">{content}</div> : <WorkspaceLayout variant="api" header={<WorkspaceHeader variant="api" title={t('apiMonitorTitle')} status={<span className="st-pill" data-state={!online?'queued':busy?'generating':'idle'}><span className="st-pill__dot"/>{t(!online?'offline':loaded?'loaded':'modelUnloaded')}</span>}/>}>{content}</WorkspaceLayout>;
}
