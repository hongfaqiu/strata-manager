import { useTranslation } from 'react-i18next';
import { ArrowRight, BookOpen, Check, ChevronDown, ChevronUp, Download, LoaderCircle, Search, Server } from 'lucide-react';
import type { EnvironmentInfo, JsonObject, ProcessStatus, ServiceProfile, TaskStatus } from '@strata-manager/core';
import './onboarding.css';

export type GuidePath = 'existing' | 'install' | null;
export interface DiscoveredService { baseUrl: string; health: JsonObject }
interface OnboardingProps {
  open: boolean; path: GuidePath; desktop: boolean; busy: boolean;
  profile?: ServiceProfile; online: boolean; loaded: boolean; process?: ProcessStatus;
  environment?: EnvironmentInfo; installDirectory: string; installTask?: TaskStatus; setupTask?: TaskStatus;
  configuredModel: boolean; localModelCount: number;
  discovering: boolean; searched: boolean; discovered: DiscoveredService[];
  onToggle: () => void; onPath: (path: GuidePath) => void; onDiscover: () => void;
  onConnect: (service?: DiscoveredService) => void; onChat: () => void; onService: () => void;
  onNavigate: (page: 'environment' | 'models' | 'profiles' | 'tasks' | 'config') => void;
  onChooseDirectory: () => void; onPrepare: () => void; onCreateModelProfile: () => void;
}

export function Onboarding(props: OnboardingProps) {
  const { t } = useTranslation();
  const { open, path, desktop, busy, profile, online, loaded, environment, installDirectory, installTask, setupTask, configuredModel, localModelCount } = props;
  const missingDependencies = environment ? [!environment.python && 'Python', !environment.git && 'Git'].filter(Boolean).join(', ') : '';
  const taskStatus = (task?: TaskStatus) => task ? t(task.state === 'completed' ? 'completed' : task.state === 'failed' ? 'taskFailed' : task.state === 'cancelled' ? 'taskCancelled' : 'taskRunning') : t('guidePending');
  const installSteps = [
    { title: t('guideCheckEnvironment'), hint: t('guideCheckEnvironmentHint'), evidence: environment ? missingDependencies ? t('guideMissingDependencies', { dependencies: missingDependencies }) : t('guideEnvironmentRead') : '', done: !!environment && !missingDependencies, blocked: !!missingDependencies, action: t('guideOpenEnvironment'), click: () => props.onNavigate('environment') },
    { title: t('guideChooseDirectory'), hint: t('guideChooseDirectoryHint'), evidence: installDirectory, done: !!installDirectory, action: t('guideChooseDirectory'), click: props.onChooseDirectory },
    { title: t('guideInstallRuntime'), hint: t('guideInstallRuntimeHint'), evidence: taskStatus(installTask), done: installTask?.state === 'completed', running: installTask?.state === 'running', action: installTask?.state === 'running' ? t('viewLogs') : t('guideInstallRuntime'), click: () => props.onNavigate(installTask?.state === 'running' ? 'tasks' : 'environment') },
    { title: t('guidePrepareModel'), hint: t('guidePrepareModelHint'), evidence: taskStatus(setupTask), done: setupTask?.state === 'completed', running: setupTask?.state === 'running', action: setupTask?.state === 'running' ? t('viewLogs') : t('guideChooseModel'), click: () => setupTask?.state === 'running' ? props.onNavigate('tasks') : props.onPrepare() },
    { title: t('guideCreateModelProfile'), hint: t('guideCreateModelProfileHint'), evidence: configuredModel ? profile?.name ?? '' : localModelCount ? t('guideConfigsFound', { count: localModelCount }) : '', done: configuredModel, action: configuredModel ? t('guideViewProfile') : t('guideCreateModelProfile'), click: () => configuredModel ? props.onNavigate('profiles') : props.onCreateModelProfile() },
    { title: t('guideParameters'), hint: t('guideParametersHint'), evidence: '', done: false, action: t('guideOpenParameters'), click: () => props.onNavigate('config'), disabled: !profile },
    { title: t('guideStartAndLoad'), hint: t('guideStartAndLoadHint'), evidence: configuredModel ? online ? t(loaded ? 'loaded' : 'notLoaded') : t('offline') : '', done: configuredModel && online && loaded, action: configuredModel && online && loaded ? t('guideViewProfile') : configuredModel && online ? t('load') : configuredModel && profile?.managed && props.process?.running !== true ? t('start') : t('guideViewProfile'), click: () => !configuredModel || online && loaded ? props.onNavigate('profiles') : props.onService() },
    { title: t('guideFirstChat'), hint: t('guideFirstChatHint'), evidence: '', done: false, action: t('guideStartChat'), click: props.onChat, disabled: !configuredModel || !online || !loaded },
  ];
  return <section className={`onboarding st-card ${open ? 'is-open' : ''}`} aria-labelledby="onboarding-title">
    <div className="onboarding-heading"><div><BookOpen size={19}/><h2 id="onboarding-title">{t(open ? 'guideTitle' : 'guideEntry')}</h2></div><button className="st-btn st-btn--secondary" aria-expanded={open} aria-controls="onboarding-content" onClick={props.onToggle}>{t(open ? 'guideHide' : 'guideOpen')}{open ? <ChevronUp size={15}/> : <ChevronDown size={15}/>}</button></div>
    {open && <div id="onboarding-content"><p className="onboarding-intro">{t('guideIntro')}</p>
      <div className="onboarding-paths" aria-label={t('guideChoosePath')}>
        <button className={`onboarding-path ${path === 'existing' ? 'is-active' : ''}`} aria-pressed={path === 'existing'} onClick={() => props.onPath('existing')}><Server size={23}/><span><strong>{t('guideExisting')}</strong><small>{t('guideExistingHint')}</small></span><ArrowRight size={18}/></button>
        <button className={`onboarding-path ${path === 'install' ? 'is-active' : ''}`} aria-pressed={path === 'install'} onClick={() => props.onPath('install')}><Download size={23}/><span><strong>{t('guideInstall')}</strong><small>{t('guideInstallHint')}</small></span><ArrowRight size={18}/></button>
      </div>
      {path === 'existing' && <div className="onboarding-route"><h3>{t('guideExisting')}</h3><p>{t('guideExistingFlow')}</p><p className="onboarding-note">{t('guideDiscoveryScope')}</p><div className="onboarding-actions"><button className="st-btn st-btn--primary" disabled={props.discovering || busy} onClick={props.onDiscover}>{props.discovering ? <LoaderCircle className="spin" size={16}/> : <Search size={16}/>} {t(props.discovering ? 'guideDiscovering' : 'guideDiscover')}</button><button className="st-btn st-btn--secondary" disabled={busy} onClick={() => props.onConnect()}>{t('guideManualUrl')}</button></div>
        {props.searched && !props.discovering && !props.discovered.length && <p className="onboarding-note" role="status">{t('guideNoServiceFound')}</p>}
        {!!props.discovered.length && <div className="onboarding-discovered" aria-label={t('guideFoundServices')}>{props.discovered.map(service => <div key={service.baseUrl}><div><strong>{String(service.health.model || 'Strata')}</strong><code>{service.baseUrl}</code><small>{t(service.health.loaded === true ? 'loaded' : 'notLoaded')}{service.health.api_key === true && ` · ${t('guideNeedsKey')}`}</small></div><button className="st-btn st-btn--secondary" disabled={busy} onClick={() => props.onConnect(service)}>{t('connect')}</button></div>)}</div>}
        {profile && <div className="onboarding-connected"><div><strong>{profile.name}</strong><code>{profile.baseUrl}</code><span>{t(online ? 'online' : 'offline')} · {online ? t(loaded ? 'loaded' : 'notLoaded') : t('guideCheckConnection')}</span></div>{online && loaded ? <button className="st-btn st-btn--primary" onClick={props.onChat}>{t('guideStartChat')}<ArrowRight size={16}/></button> : <button className="st-btn st-btn--secondary" disabled={busy} onClick={() => online ? props.onService() : props.onNavigate('profiles')}>{t(online ? 'load' : 'guideCheckConnection')}</button>}</div>}
      </div>}
      {path === 'install' && <div className="onboarding-route"><h3>{t('guideInstall')}</h3>{!desktop && <p className="onboarding-note">{t('nativeRequired')}</p>}<ol className="onboarding-steps">{installSteps.map((step, index) => <li key={step.title} data-state={step.blocked ? 'blocked' : step.done ? 'done' : step.running ? 'running' : 'pending'}><span className="onboarding-step-number" aria-label={step.done ? t('completed') : undefined}>{step.done ? <Check size={16}/> : step.running ? <LoaderCircle className="spin" size={16}/> : index + 1}</span><div><strong>{step.title}</strong><p>{step.hint}</p>{step.evidence && <small>{step.evidence}</small>}</div><button className="st-btn st-btn--secondary" disabled={busy || step.disabled || (!desktop && index < 5)} onClick={step.click}>{step.action}</button></li>)}</ol></div>}
      <p className="onboarding-advanced">{t('guideAdvancedHint')}</p>
    </div>}
  </section>;
}
