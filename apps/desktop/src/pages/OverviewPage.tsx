import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, ArrowRight, Boxes, Copy, LoaderCircle, MessageSquare, Play, RefreshCw, Server, Settings2 } from 'lucide-react';
import { normalizeBaseUrl, type BackgroundHealthSnapshot, type JsonObject, type MetricSnapshot, type ProcessStatus, type ServiceProfile, type TaskStatus } from '@strata-manager/core';
import { Badge, Metric, Panel } from '../components';
import './overview.css';

interface OverviewPageProps {
  profile?:ServiceProfile;health:JsonObject;backgroundHealth?:BackgroundHealthSnapshot;metric?:MetricSnapshot;process?:ProcessStatus;tasks:TaskStatus[];language:'zh-CN'|'en';
  online:boolean;connecting:boolean;desktop:boolean;tasksLoading:boolean;healthError?:string;metricsError?:string;taskError?:string;processError?:string;
  controls:ReactNode;usage?:ReactNode;stateLabel:(state:string)=>string;onRefresh:()=>void;onCreateProfile:()=>void;onChat:()=>void;onCopy:(content:string)=>void;
  onNavigate:(page:'monitoring'|'config'|'tasks'|'requests'|'profiles'|'environment')=>void;
  onImages?:()=>void;
  startupModel?:{name:string;configPath:string;lastActivatedAt?:number;onStart:()=>void};
  hasRuntime?:boolean;runtimeNeedsRepair?:boolean;setupLoading?:boolean;setupError?:string;startupBusy?:boolean;startupDisabled?:boolean;
}
const obj=(v:unknown):JsonObject=>v&&typeof v==='object'&&!Array.isArray(v)?v as JsonObject:{};
const num=(v:unknown):number|null=>typeof v==='number'&&Number.isFinite(v)?v:null;
const overviewLabels = {
  'zh-CN': { images: '图像支持', enabled: '已启用', disabled: '未启用', background: '后台检查', noCheck: '尚无检查记录', newProcess: '当前进程未检查', pending: '尚未完成检查', expired: '检查记录已过期', invalidTime: '检查时间待核验', deferred: '检查已延后', configuration: '运行配置', models: '模型管理' },
  en: { images: 'Image support', enabled: 'Enabled', disabled: 'Not enabled', background: 'Background check', noCheck: 'No check recorded', newProcess: 'Current process not checked', pending: 'No completed check', expired: 'Check record expired', invalidTime: 'Check time unverified', deferred: 'Check deferred', configuration: 'Configuration', models: 'Manage models' },
} as const;
const startupLabels = {
  'zh-CN': {
    title: '启用本机模型', chooseTitle: '选择模型开始使用', installTitle: '准备模型服务', checkingTitle: '正在检查本机模型',
    recentHint: 'Strata 环境已就绪，可以继续使用最近启用过的模型。', modelHint: '已检测到本机模型，启用后即可聊天和使用 API。',
    chooseHint: '已检测到 Strata 环境，选择已有模型或准备新模型，即可开启服务。', installHint: '先安装 Strata 运行环境，再选择模型开启服务。',
    repairHint: '已检测到 Strata 环境，请先完善运行环境，再选择模型。', checkingHint: '正在检测 Strata 环境和已有模型配置。',
    recent: '最近启用', available: '可启用', runtime: '已检测到 Strata', start: '启用此模型', starting: '正在启用…', choose: '选择模型', install: '安装 Strata', repair: '完善 Strata 环境',
  },
  en: {
    title: 'Enable a local model', chooseTitle: 'Choose a model to get started', installTitle: 'Prepare a model service', checkingTitle: 'Checking local models',
    recentHint: 'Strata is ready. Continue with your most recently enabled model.', modelHint: 'A local model was found. Enable it to chat and use the API.',
    chooseHint: 'Strata was found. Choose an existing model or prepare a new one to start a service.', installHint: 'Install the Strata runtime, then choose a model to start a service.',
    repairHint: 'Strata was found. Complete the runtime setup before choosing a model.', checkingHint: 'Checking the Strata runtime and existing model configurations.',
    recent: 'Recently enabled', available: 'Available', runtime: 'Strata detected', start: 'Enable this model', starting: 'Enabling…', choose: 'Choose a model', install: 'Install Strata', repair: 'Complete Strata setup',
  },
} as const;
export function OverviewPage({profile,health,backgroundHealth,metric,process,tasks,language,online,connecting,desktop,tasksLoading,healthError,metricsError,taskError,processError,controls,usage,stateLabel,onRefresh,onCreateProfile,onChat,onCopy,onNavigate,onImages,startupModel,hasRuntime=false,runtimeNeedsRepair=false,setupLoading=false,setupError,startupBusy=false,startupDisabled=false}:OverviewPageProps) {
  const {t}=useTranslation();const fmt=(v:unknown,d=1)=>num(v)===null?'–':num(v)!.toLocaleString(language,{maximumFractionDigits:d});
  const labels = overviewLabels[language];
  const startup = startupLabels[language];
  const setupPending = setupLoading;
  const bytes=(v:unknown)=>num(v)===null?'–':`${fmt(num(v)!/1024**3)} GB`;
  const engine=obj(metric?.raw.engine),live=obj(metric?.raw.live),last=metric?.requests[0];
  const capacity=num(engine.max_context)??num(health.max_context);
  const prompt=num(live.state==='idle'?last?.prompt_tokens:live.prompt_tokens),generated=num(live.state==='idle'?last?.output_tokens:live.generated);
  const contextUsed=prompt!==null&&generated!==null?prompt+generated:null;
  const resource=(label:string,used:number|null|undefined,total:number|null|undefined)=>{const percent=num(used)!==null&&num(total)!==null&&total!>0?Math.min(100,Math.max(0,used!/total!*100)):null;return <div className="overview-resource"><div><span>{label}</span><strong>{bytes(used)} / {bytes(total)}</strong></div><div className="st-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent??undefined}><div className="st-progress__bar" style={{width:`${percent??0}%`}}/></div></div>;};
  let endpoint='–';if(profile){try{endpoint=`${normalizeBaseUrl(profile.baseUrl)}/v1`;}catch{endpoint=profile.baseUrl;}}
  const running=tasks.filter(task=>task.state==='running');
  const modelState=online&&typeof health.loaded==='boolean'?t(health.loaded?'loaded':'notLoaded'):connecting?t('loading'):'–';
  const backgroundForProcess = backgroundHealth && process?.running && process.owned
    && backgroundHealth.profileId === profile?.id && backgroundHealth.pid === process.pid ? backgroundHealth : undefined;
  const backgroundAge = backgroundForProcess ? Date.now() - backgroundForProcess.checkedAt : undefined;
  const currentBackgroundHealth = backgroundForProcess && backgroundForProcess.checkedAt > 0
    && backgroundAge! >= 0 && backgroundAge! < 65_000 ? backgroundForProcess : undefined;
  const backgroundPhase = currentBackgroundHealth?.phase ?? 'stale';
  const backgroundLabel = currentBackgroundHealth
    ? backgroundPhase === 'deferred' ? labels.deferred : t(`backgroundHealth_${backgroundPhase}`)
    : !backgroundHealth ? labels.noCheck : !backgroundForProcess ? labels.newProcess
    : backgroundForProcess.checkedAt <= 0 ? labels.pending : backgroundAge! < 0 ? labels.invalidTime : labels.expired;
  const imageSupport = online && typeof health.images === 'boolean' ? health.images ? labels.enabled : labels.disabled : t('unknown');
  const jump=(page:'monitoring'|'config'|'tasks'|'requests'|'profiles',label:string)=> <button type="button" className="text-button overview-panel-link" onClick={()=>onNavigate(page)}>{label}<ArrowRight size={14} aria-hidden="true"/></button>;
  return <div className="overview-page">
    {!profile?<section className="service-hero overview-service overview-service-empty" aria-label={t('service')}>
      <div className="overview-service-main"><div className="hero-icon"><Server size={28} strokeWidth={1.5}/></div><div className="hero-copy">
        <div className="overview-service-title"><h2>{!desktop?t('noProfile'):setupPending?startup.checkingTitle:startupModel?startup.title:hasRuntime?startup.chooseTitle:startup.installTitle}</h2><Badge tone={hasRuntime?'positive':'muted'}>{hasRuntime?startup.runtime:t('offline')}</Badge></div>
        <p className="overview-setup-hint">{!desktop?t('noProfileHint'):setupPending?startup.checkingHint:startupModel?startupModel.lastActivatedAt?startup.recentHint:startup.modelHint:runtimeNeedsRepair?startup.repairHint:hasRuntime?startup.chooseHint:startup.installHint}</p>
        {startupModel&&<><div className="overview-service-model"><span>{t('model')}</span><strong>{startupModel.name}</strong><Badge>{startupModel.lastActivatedAt?startup.recent:startup.available}</Badge></div><div className="overview-service-endpoint"><code title={startupModel.configPath}>{startupModel.configPath.split(/[\\/]/).pop()}</code>{startupModel.lastActivatedAt&&<time dateTime={new Date(startupModel.lastActivatedAt).toISOString()}>{new Date(startupModel.lastActivatedAt).toLocaleString(language)}</time>}</div></>}
      </div></div>
      <div className="hero-controls"><div className="service-actions">
        <button type="button" className="primary" disabled={startupDisabled||startupBusy||setupPending} aria-busy={startupBusy||setupPending} onClick={setupError&&!startupModel?onRefresh:startupModel?startupModel.onStart:!desktop||hasRuntime&&!runtimeNeedsRepair?onCreateProfile:()=>onNavigate('environment')}>
          {startupBusy||setupPending?<LoaderCircle size={15} className="spin"/>:startupModel?<Play size={15}/>:<ArrowRight size={15}/>}{startupBusy?startup.starting:setupPending?t('loading'):setupError&&!startupModel?t('refresh'):startupModel?startup.start:!desktop||hasRuntime&&!runtimeNeedsRepair?startup.choose:runtimeNeedsRepair?startup.repair:startup.install}
        </button>
      </div></div>
      <div className="overview-service-footer"><div className="overview-shortcuts" role="group" aria-label={t('quickActions')}><button type="button" className="overview-shortcut overview-shortcut-models" onClick={onCreateProfile}><Boxes size={15} aria-hidden="true"/>{labels.models}</button><button type="button" className="overview-shortcut" onClick={()=>onNavigate('environment')}><Server size={15} aria-hidden="true"/>Strata</button></div><button type="button" className="overview-refresh" onClick={onRefresh} aria-label={t('refresh')} title={t('refresh')}><RefreshCw size={15} aria-hidden="true"/></button></div>
      {setupError&&<div className="notice error" role="alert">{setupError}</div>}
    </section>:<>
      <section className="service-hero overview-service" aria-label={t('service')}>
        <div className="overview-service-main"><div className="hero-icon"><Server size={28} strokeWidth={1.5}/></div><div className="hero-copy">
          <div className="overview-service-title"><h2>{profile.name}</h2><Badge tone={online?'positive':'muted'}>{desktop&&process?.running===false&&!connecting?language==='zh-CN'?'未启动':'Not started':t(connecting?'connecting':online?'online':'offline')}</Badge></div>
          <div className="overview-service-model"><span>{t('model')}</span><strong>{String(health.model??engine.model??'–')}</strong><Badge>{modelState}</Badge></div>
          <div className="overview-service-endpoint"><code>{endpoint}</code><button type="button" onClick={()=>onCopy(endpoint)}><Copy size={14}/>{language==='zh-CN'?'复制 API 地址':'Copy API address'}</button></div>
        </div></div>
        <div className="hero-controls">{controls}</div>
        <div className="overview-service-facts">
          <div><span>{t('status')}</span><strong>{metric?stateLabel(metric.state):'–'}</strong></div>
          {profile.managed&&desktop&&<div title={process?.pid?`${t('pid')} ${process.pid}`:undefined}><span>{t('process')}</span><strong>{process?t(process.running?'running':'stopped'):'–'}</strong></div>}
          <div><span>{labels.images}</span><strong>{imageSupport}</strong>{onImages && <button className="overview-image-action" type="button" onClick={onImages}>{language==='zh-CN'?health.images===true&&online?'图像设置':'启用图像':health.images===true&&online?'Image settings':'Enable images'}</button>}</div>
          {desktop&&process?.owned&&process.running&&<div title={currentBackgroundHealth?.reason}><span>{labels.background}</span><Badge tone={backgroundPhase==='healthy'?'positive':backgroundPhase==='degraded'?'warning':'muted'}>{backgroundLabel}</Badge></div>}
        </div>
        <div className="overview-service-footer">
          <div className="overview-shortcuts" role="group" aria-label={t('quickActions')}>
            <button type="button" className="primary overview-shortcut overview-shortcut-chat" onClick={onChat}><MessageSquare size={15} aria-hidden="true"/><span>{t('openChat')}</span></button>
            <button type="button" className="overview-shortcut overview-shortcut-monitor" onClick={()=>onNavigate('monitoring')}><Activity size={15} aria-hidden="true"/><span>{t('openMonitor')}</span></button>
            <button type="button" className="overview-shortcut overview-shortcut-config" onClick={()=>onNavigate('config')}><Settings2 size={15} aria-hidden="true"/><span>{labels.configuration}</span></button>
            <button type="button" className="overview-shortcut overview-shortcut-models" onClick={()=>onNavigate('profiles')}><Boxes size={15} aria-hidden="true"/><span>{labels.models}</span></button>
          </div>
          <button type="button" className="overview-refresh" onClick={onRefresh} aria-label={t('refresh')} title={t('refresh')}><RefreshCw size={15} aria-hidden="true"/></button>
        </div>
        {healthError&&<div className="notice error" role="alert">{healthError}</div>}{processError&&<div className="notice error" role="alert">{processError}</div>}
        {currentBackgroundHealth&&backgroundPhase==='unknown'&&currentBackgroundHealth.apiHealthy&&<div className="notice warning" role="status">{t('backgroundHealthObservationUnknown')}</div>}
        {currentBackgroundHealth&&backgroundPhase==='degraded'&&<div className="notice warning" role="status">{t('backgroundHealthPreserved')}</div>}
      </section>
    </>}
      {usage}
      <div className="metrics-grid four"><Metric label={t('decode')} value={fmt(metric?.decodeTokS)} unit="tok/s"/><Metric label={t('gpuUtil')} value={fmt(metric?.gpuUtil)} unit="%"/><Metric label={t('activeRequests')} value={fmt(metric?.running,0)}/><Metric label={t('queued')} value={fmt(metric?.queued,0)}/></div>
      <div className="overview-grid"><Panel title={t('resourcesSummary')} action={jump('monitoring',t('openMonitor'))}>{metricsError&&<div className="notice error" role="alert">{metricsError}</div>}<div className="overview-context"><div><span>{t('contextUsage')}</span><strong>{fmt(contextUsed,0)} / {fmt(capacity,0)} tokens</strong></div><div className="st-progress" role="progressbar" aria-label={t('contextUsage')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={contextUsed!==null&&capacity!==null&&capacity>0?contextUsed/capacity*100:undefined}><div className="st-progress__bar" style={{width:contextUsed!==null&&capacity!==null&&capacity>0?`${Math.min(100,contextUsed/capacity*100)}%`:'0%'}}/></div></div>{resource(t('gpuMemory'),metric?.gpuMemoryUsed,metric?.gpuMemoryTotal)}{resource(t('ram'),metric?.ramUsed,metric?.ramTotal)}<div className="overview-resource-facts"><div><span>{t('cpuUtil')}</span><strong>{fmt(metric?.cpuUtil)} %</strong></div><div><span>{t('gpuTemperature')}</span><strong>{fmt(metric?.gpuTemperature)} °C</strong></div><div><span>{t('gpuPower')}</span><strong>{fmt(metric?.gpuPower)} W</strong></div><div><span>{t('prefill')}</span><strong>{fmt(metric?.prefillTokS)} tok/s</strong></div></div></Panel>
      <Panel title={t('runningTasks')} action={jump('tasks',t('viewAllTasks'))}>{taskError&&<div className="notice error" role="alert">{taskError}</div>}{running.length?<div className="overview-task-list">{running.map(task=><button key={task.id} onClick={()=>onNavigate('tasks')}><div><strong>{t(task.kind.includes('setup')?'setupTask':task.kind.includes('install')?'installTask':task.kind.includes('update')?'updateTask':'task')}</strong><time>{new Date(task.startedAt).toLocaleTimeString(language)}</time></div><span>{task.message||stateLabel(task.state)}</span></button>)}</div>:<p className="subtle">{t(!desktop?'nativeRequired':tasksLoading?'loading':taskError?'unavailable':'noRunningTasks')}</p>}</Panel></div>
      <Panel title={t('requestsRecent')} action={jump('requests',t('requests'))}>{metric?.requests.length?<div className="table-wrap"><table className="st-table overview-requests"><thead><tr><th>{t('timestamp')}</th><th>{t('promptTokens')}</th><th>{t('outputTokens')}</th><th>{t('decode')}</th><th>{t('finishReason')}</th></tr></thead><tbody>{metric.requests.slice(0,6).map((request,index)=><tr key={String(request.id??index)}><td>{num(request.time)!==null?new Date(num(request.time)!*1000).toLocaleTimeString(language):'–'}</td><td>{fmt(request.prompt_tokens,0)}</td><td>{fmt(request.output_tokens,0)}</td><td>{fmt(request.decode_tok_s)} tok/s</td><td>{request.finish===undefined?'–':t(({stop:'stoppedFinish',length:'lengthFinish',cancelled:'cancelledFinish',tool_calls:'toolCallsFinish'} as Record<string,string>)[String(request.finish)]??'unknown')}</td></tr>)}</tbody></table></div>:<p className="subtle">{t(!metric?'noMetrics':'overviewRequestsEmpty')}</p>}</Panel>
  </div>;
}
