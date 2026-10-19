import type { AppLanguage } from "@strata-manager/core";
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Boxes, LoaderCircle, Play, Plug, RefreshCw, Server } from 'lucide-react';
import { type BackgroundHealthSnapshot, type JsonObject, type MetricSnapshot, type ProcessStatus, type ServiceProfile, type TaskStatus } from '@strata-manager/core';
import { Badge } from '../components';
import './overview.css';
import { OverviewDashboard, type OverviewNavigationTarget } from './OverviewDashboard';

interface OverviewPageProps {
  profile?:ServiceProfile;health:JsonObject;backgroundHealth?:BackgroundHealthSnapshot;metric?:MetricSnapshot;process?:ProcessStatus;tasks:TaskStatus[];language:AppLanguage;
  loadingSince?:number;online:boolean;connecting:boolean;desktop:boolean;tasksLoading:boolean;healthError?:string;metricsError?:string;taskError?:string;processError?:string;
  controls:ReactNode;stateLabel:(state:string)=>string;onRefresh:()=>void;onCreateProfile:()=>void;onChat:()=>void;onCopy:(content:string)=>void;
  onNavigate:(page:OverviewNavigationTarget)=>void;
  onRestart?:()=>void;profiles?:{id:string;name:string}[];onSwitchProfile?:(id:string)=>void;actionsDisabled?:boolean;
  onImages?:()=>void;
  startupModel?:{name:string;configPath:string;lastActivatedAt?:number;onStart:()=>void};
  hasRuntime?:boolean;runtimeNeedsRepair?:boolean;setupLoading?:boolean;setupError?:string;startupBusy?:boolean;startupDisabled?:boolean;
  /** First-run guide: resume strip while active; a reopen link in the empty state after it was skipped. */
  guideNotice?:ReactNode;onOpenGuide?:()=>void;
}
const overviewLabels = {
  'zh-CN': { images: '图像支持', enabled: '已启用', disabled: '未启用', background: '后台检查', noCheck: '尚无检查记录', newProcess: '当前进程未检查', pending: '尚未完成检查', expired: '检查记录已过期', invalidTime: '检查时间待核验', deferred: '检查已延后', configuration: '运行配置', models: '模型管理', waitingService: '等待配置服务', waitingHint: '启用模型后，这里会显示实时负载、资源与近期请求。' },
  en: { images: 'Image support', enabled: 'Enabled', disabled: 'Not enabled', background: 'Background check', noCheck: 'No check recorded', newProcess: 'Current process not checked', pending: 'No completed check', expired: 'Check record expired', invalidTime: 'Check time unverified', deferred: 'Check deferred', configuration: 'Configuration', models: 'Manage models', waitingService: 'Waiting for a service', waitingHint: 'After you enable a model, live load, resources, and recent requests appear here.' },
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
export function OverviewPage({profile,health,backgroundHealth,metric,process,tasks,language,online,connecting,desktop,tasksLoading,healthError,metricsError,taskError,processError,controls,stateLabel,onRefresh,onCreateProfile,onChat,onCopy,onNavigate,onImages,onRestart,profiles,onSwitchProfile,actionsDisabled,startupModel,hasRuntime=false,runtimeNeedsRepair=false,setupLoading=false,setupError,startupBusy=false,startupDisabled=false,guideNotice,onOpenGuide,loadingSince}:OverviewPageProps) {
  const {t}=useTranslation();
    const labels = overviewLabels[(language === 'zh-CN' ? 'zh-CN' : 'en')];
  const startup = startupLabels[(language === 'zh-CN' ? 'zh-CN' : 'en')];
  const setupPending = setupLoading;
  const emptyPrimary = (
    <button type="button" className="primary" disabled={startupDisabled||startupBusy||setupPending} aria-busy={startupBusy||setupPending} onClick={setupError&&!startupModel?onRefresh:startupModel?startupModel.onStart:!desktop||hasRuntime&&!runtimeNeedsRepair?onCreateProfile:()=>onNavigate('environment')}>
      {startupBusy||setupPending?<LoaderCircle size={15} className="spin"/>:startupModel?<Play size={15}/>:<ArrowRight size={15}/>}{startupBusy?startup.starting:setupPending?t('loading'):setupError&&!startupModel?t('refresh'):startupModel?startup.start:!desktop||hasRuntime&&!runtimeNeedsRepair?startup.choose:runtimeNeedsRepair?startup.repair:startup.install}
    </button>
  );
  return <div className={`overview-page${!profile ? ' overview-page--empty' : ''}`}>
    {guideNotice}
    {!profile?<section className="service-hero overview-service overview-service-empty" aria-label={t('service')}>
      <div className="overview-service-main"><div className="hero-icon"><Server size={28} strokeWidth={1.5}/></div><div className="hero-copy">
        <div className="overview-service-title"><h2>{!desktop?t('noProfile'):setupPending?startup.checkingTitle:startupModel?startup.title:hasRuntime?startup.chooseTitle:startup.installTitle}</h2><Badge tone={hasRuntime?'positive':'muted'}>{hasRuntime?startup.runtime:t('offline')}</Badge></div>
        <p className="overview-setup-hint">{!desktop?t('noProfileHint'):setupPending?startup.checkingHint:startupModel?startupModel.lastActivatedAt?startup.recentHint:startup.modelHint:runtimeNeedsRepair?startup.repairHint:hasRuntime?startup.chooseHint:startup.installHint}</p>
        {onOpenGuide&&<button type="button" className="ob-link ob-guide-link" onClick={onOpenGuide}>{t('obOpenGuide' as never)}<ArrowRight size={13} aria-hidden="true"/></button>}
        {startupModel&&<><div className="overview-service-model"><span>{t('model')}</span><strong>{startupModel.name}</strong><Badge>{startupModel.lastActivatedAt?startup.recent:startup.available}</Badge></div><div className="overview-service-endpoint"><code data-tooltip={startupModel.configPath}>{startupModel.configPath.split(/[\\/]/).pop()}</code>{startupModel.lastActivatedAt&&<time dateTime={new Date(startupModel.lastActivatedAt).toISOString()}>{new Date(startupModel.lastActivatedAt).toLocaleString(language)}</time>}</div></>}
      </div></div>
      <div className="overview-service-cta" role="group" aria-label={t('quickActions')}>
        <div className="overview-service-cta-primary">{emptyPrimary}</div>
        <div className="overview-shortcuts overview-shortcuts-inline">
          <button type="button" className="overview-shortcut overview-shortcut-models" onClick={onCreateProfile}><Boxes size={15} aria-hidden="true"/>{labels.models}</button>
          <button type="button" className="overview-shortcut overview-shortcut-api" disabled data-tooltip={language==='zh-CN'?'启用模型后可接入 API':'Enable a model to connect to its API'}><Plug size={15} aria-hidden="true"/>{language==='zh-CN'?'接入 API':'Connect API'}</button>
          <button type="button" className="overview-shortcut" onClick={()=>onNavigate('environment')}><Server size={15} aria-hidden="true"/>Strata</button>
        </div>
        <button type="button" className="overview-refresh" onClick={onRefresh} aria-label={t('refresh')} data-tooltip={t('refresh')}><RefreshCw size={15} aria-hidden="true"/></button>
      </div>
      {setupError&&<div className="notice error" role="alert">{setupError}</div>}
    </section>:<OverviewDashboard profile={profile} health={health} backgroundHealth={backgroundHealth} metric={metric} process={process} tasks={tasks} language={language}
      online={online} connecting={connecting} desktop={desktop} tasksLoading={tasksLoading} healthError={healthError} metricsError={metricsError} taskError={taskError} processError={processError}
      controls={controls} stateLabel={stateLabel} onRefresh={onRefresh} onChat={onChat} onCopy={onCopy} onNavigate={onNavigate} onImages={onImages} onRestart={onRestart}
      profiles={profiles} onSwitchProfile={onSwitchProfile} actionsDisabled={actionsDisabled} loadingSince={loadingSince}/>}
    {!profile && <div className="overview-waiting-strip" role="status">
      <span className="overview-waiting-dot" aria-hidden="true"/>
      <div>
        <strong>{labels.waitingService}</strong>
        <p>{labels.waitingHint}</p>
      </div>
    </div>}
  </div>;
}
