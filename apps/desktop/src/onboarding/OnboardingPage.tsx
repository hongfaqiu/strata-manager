import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Check, Copy, FolderPlus, LoaderCircle, Minus, RefreshCw, Square, TriangleAlert, X } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { LogEntry, ServiceProfile, TaskStatus } from '@strata-manager/core';
import { Dropdown, Segmented, Toggle } from '../OfficialControls';
import { D2DotAxis } from '../pages/D2Visuals';
import { ResourceAssessmentPanel } from '../pages/ResourceAssessmentPanel';
import { ContextExtensionNotice } from '../pages/ContextExtensionNotice';
import { SetupHandoffActions } from '../pages/SetupHandoffActions';
import { taskProgress } from '../pages/d2Estimates';
import { ManagedPythonPanel } from '../pages/ManagedPythonPanel';
import { useLocalRuntimePackages } from '../pages/LocalRuntimePackage';
import { ExistingModelPanel } from '../pages/ExistingModelPanel';
import { GuideStorageRows } from '../pages/StorageLocation';
import { fetchArenaGroups, fetchArenaTier } from './arenaPublic';
import {
  arenaLeaderboardQuery, arenaMatch, confidenceBars, defaultContext, gpuRowValue, parseGpu,
  recommendations, smallestCatalogRamGB, type EnvironmentCheck, type GuideFacts, type GuidePath, type GuidePlan, type GuideState, type GuideSelection, type OnboardingProgress,
  type Recommendation, type Scene, type StepId, type StepState,
} from './onboardingModel';
import '../pages/d2-visuals.css';
import './onboarding.css';

export type ModelPrepareRequest = ReturnType<typeof core.snapshotModelDownloadRequest>;
export interface OnboardingPageProps {
  language: core.AppLanguage;
  desktop: boolean;
  progress: OnboardingProgress | null;
  guide: GuideState;
  onRefreshRuntime: () => void;
  onProgress: (patch: Partial<OnboardingProgress>) => void;
  environment?: core.EnvironmentInfo;
  environmentError?: string;
  environmentLoading: boolean;
  onRecheckEnvironment: () => void;
  memoryGB?: number;
  tasks: TaskStatus[];
  handoffs: core.SetupHandoff[];
  profiles: ServiceProfile[];
  candidates: core.LocalCandidate[];
  candidatesLoading: boolean;
  activeProfile?: ServiceProfile;
  online: boolean;
  loaded: boolean;
  starting: boolean;
  startupLogs: LogEntry[];
  modelName?: string;
  busy: boolean;
  onPrepareModel: (request: ModelPrepareRequest) => Promise<TaskStatus | undefined>;
  /** 「使用已有模型」(#75): ORCA.md import of local OrcaRouter shards. */
  onOrcaImport?: (profile: ServiceProfile, request: core.OrcaImportRequest, options: core.OfficialSetupOptions) => Promise<TaskStatus | undefined>;
  onChooseDirectory?: () => Promise<string | null>;
  onChooseFile?: () => Promise<string | null>;
  onStart: (profile: ServiceProfile) => Promise<void>;
  onLoad: (profile: ServiceProfile) => Promise<void>;
  onConnectCandidate: (candidate: core.LocalCandidate) => Promise<void>;
  onResolveHandoff: (taskId: string, configPath?: string) => Promise<void>;
  onRefreshProfiles: () => Promise<ServiceProfile[]>;
  onRescan: () => void;
  onAddDirectory: () => void;
  onOpenCatalog: () => void;
  onOpenConfig: (profile: ServiceProfile) => void;
  onOpenTasks: () => void;
  onOpenBenchmark: () => void;
  onCopy: (text: string) => void;
  onSendFirstMessage: (text: string) => void;
  onFinish: () => void;
  onSkip: () => void;
  onLater: () => void;
  onError: (error: unknown) => void;
}

const CONTEXTS = [8192, 32768, 65536, 131072, 262144, 524288, 1048576];
const contextLabel = (value: number) => core.formatContextTokens(value);
const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60; return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(r).padStart(2, '0')}`; };
const gb = (value: number, digits = 1) => value.toLocaleString(undefined, { maximumFractionDigits: digits });
const modelName = (family: string) => core.MODEL_CATALOG.find(model => model.family === family)?.name ?? family;
const settled = (state: StepState) => state === 'done' || state === 'skipped';
export const STEP_LABELS: Record<StepId, string> = { environment: 'guideCheckEnvironment', runtime: 'guideInstallRuntime', model: 'guideChooseModel', download: 'obStepDownload', start: 'guideStartAndLoad', chat: 'guideFirstChat', discover: 'guideDiscover', load: 'obStepLoad' };

/** Overview strip while the guide is active. */
export function GuideResume({ plan, onResume }: { plan?: GuidePlan; onResume: () => void }) {
  const { t } = useTranslation();
  return <section className="ob-resume" aria-label={t('guideTitle')} data-testid="guide-resume">
    <div>
      <b>{t('guideTitle')}{plan ? ` · ${t('obResumeTitle', { current: plan.index + 1, total: plan.total, step: t(STEP_LABELS[plan.current]) })}` : ''}</b>
      <p>{plan ? t('obResumeHint') : t('obEntryTitle')}</p>
      {plan && <div className="ob-progress" aria-hidden="true">{plan.steps.map(step => <i key={step.id} className={settled(step.state) ? 'is-full' : ''}/>)}</div>}
    </div>
    <button type="button" className="primary" onClick={onResume}>{t('obResume')}<ArrowRight size={14}/></button>
  </section>;
}

export function OnboardingPage(props: OnboardingPageProps) {
  const { t: translate } = useTranslation();
  const t = (key: string, values?: Record<string, unknown>) => String(translate(key, values as never));
  const { progress } = props;
  const [viewing, setViewing] = useState<StepId>();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);

  const { facts, plan, checks, runtimeTask, setupTask, handoff, readyRuntime, repairReason, target } = props.guide;
  const runtimeFact = facts.runtime, verdict = facts.environment;
  const path: GuidePath | null = progress?.path ?? null;
  const shown = viewing && plan?.steps.some(step => step.id === viewing) ? viewing : plan?.current;
  useEffect(() => { setViewing(undefined); }, [plan?.current]);

  // Remember the registered profile so a restart resumes on the same configuration.
  useEffect(() => { if (handoff?.status === 'registered' && handoff.profileId && progress?.profileId !== handoff.profileId) { props.onProgress({ profileId: handoff.profileId }); void props.onRefreshProfiles().catch(() => undefined); } }, [handoff?.status, handoff?.profileId]);
  // Optional auto start (default OFF) once the downloaded model is registered.
  const autoStarted = useRef('');
  useEffect(() => {
    if (!progress?.autoStart || handoff?.status !== 'registered' || !target || facts.online || props.starting || props.busy || autoStarted.current === handoff.taskId) return;
    autoStarted.current = handoff.taskId;
    void props.onStart(target).catch(props.onError);
  }, [progress?.autoStart, handoff?.status, target?.id, facts.online, props.starting, props.busy]);

  const stepLabel = (id: StepId) => t(STEP_LABELS[id]);
  const setupPercent = setupTask?.state === 'running' ? taskProgress(setupTask.message) : undefined;
  const stepNote = (id: StepId, state: StepState): string | undefined => {
    if (id === 'environment' && state === 'skipped') return t('obSkippedAuto');
    if (id === 'environment' && checks) return `${checks.filter(check => check.state === 'ok').length}/${checks.length}`;
    if (id === 'runtime' && state === 'running' && runtimeTask) return t('obElapsed', { time: clock(now - runtimeTask.startedAt) });
    if (id === 'runtime' && settled(state)) return readyRuntime?.runtimeVersion ? `Strata ${readyRuntime.runtimeVersion}` : t('obDetectedDone');
    if (id === 'model' && progress?.selection && state === 'done') return `${modelName(progress.selection.family)} · ${progress.selection.quant}`;
    if (id === 'download' && state === 'running') return setupPercent !== undefined ? `${Math.round(setupPercent)}%` : t('obInProgress');
    if (state === 'skipped') return t('obDetectedDone');
    if (state === 'failed') return t('obNeedsAttention');
    return undefined;
  };

  if (!plan || !path || !shown) return <EntryScreen {...props} t={t} runtimeFact={runtimeFact} readyVersion={readyRuntime?.runtimeVersion}/>;

  const rail = <aside className="ob-rail" aria-label={t('guideTitle')}>
    <span className="ob-eyebrow">{t('guideTitle')}</span>
    <h2>{t(path === 'install' ? 'guideInstall' : 'guideExisting')}</h2>
    <span className="ob-count">{t('obStepOf', { current: plan.index + 1, total: plan.total })}</span>
    <div className="ob-progress" aria-hidden="true">{plan.steps.map(step => <i key={step.id} className={settled(step.state) ? 'is-full' : step.id === 'download' && step.state === 'running' ? 'is-part' : ''} style={step.id === 'download' && setupPercent !== undefined ? { ['--p' as string]: `${setupPercent}%` } : undefined}/>)}</div>
    <ol className="ob-steps">{plan.steps.map(step => {
      const note = stepNote(step.id, step.state);
      const clickable = step.id !== shown && (settled(step.state) || step.id === plan.current);
      const body = <><span className="ob-step-icon" aria-hidden="true">{settled(step.state) ? <Check size={11} strokeWidth={3}/> : step.state === 'running' ? <LoaderCircle size={12} className="spin"/> : step.state === 'failed' ? <X size={11} strokeWidth={3}/> : null}</span><span><b>{stepLabel(step.id)}</b>{note && <small>{note}</small>}</span></>;
      return <li key={step.id} className={`ob-step is-${step.state}${step.id === shown ? ' is-shown' : ''}`} aria-current={step.id === plan.current ? 'step' : undefined}>
        {clickable ? <button type="button" onClick={() => setViewing(step.id === plan.current ? undefined : step.id)}>{body}</button> : <div>{body}</div>}
      </li>;
    })}</ol>
    <div className="ob-rail-foot">
      <button type="button" className="st-btn st-btn--secondary" onClick={props.onLater}>{t('obLater')}</button>
      <p>{t('obLaterHint')}</p>
      <button type="button" className="ob-link" onClick={() => props.onProgress({ path: path === 'install' ? 'connect' : 'install' })}>{t(path === 'install' ? 'obSwitchToConnect' : 'obSwitchToInstall')}<ArrowRight size={13}/></button>
    </div>
  </aside>;
  const viewingDone = shown !== plan.current;
  const doneNote = viewingDone ? <div className="ob-done-note"><Check size={14}/><span>{t('obStepDone')}</span><button type="button" className="ob-link" onClick={() => setViewing(undefined)}>{t('obGoCurrent')}<ArrowRight size={13}/></button></div> : null;
  const shared = { ...props, t, now, facts, target };
  const body = shown === 'environment' ? <EnvironmentStep {...shared} checks={checks} verdict={verdict} readOnly={viewingDone}/>
    : shown === 'runtime' ? <RuntimeStep {...shared} runtimeTask={runtimeTask} runtimeFact={runtimeFact} readyVersion={readyRuntime?.runtimeVersion} repairReason={repairReason} onRefreshRuntime={props.onRefreshRuntime}/>
    : shown === 'model' ? <ModelStep {...shared} runtimeProfile={readyRuntime?.profile}/>
    : shown === 'download' ? <DownloadStep {...shared} setupTask={setupTask} handoff={handoff}/>
    : shown === 'start' || shown === 'load' ? <StartStep {...shared}/>
    : shown === 'discover' ? <DiscoverStep {...shared}/>
    : <ReadyStep {...shared}/>;
  return <section className="ob" data-testid="onboarding" data-step={shown}>{rail}<div className="ob-main">{doneNote}{body}</div></section>;
}

type Translate = (key: string, values?: Record<string, unknown>) => string;
type StepProps = OnboardingPageProps & { t: Translate; now: number; facts: GuideFacts; target?: ServiceProfile };

function Mark({ state }: { state: 'ok' | 'warn' | 'fail' | 'none' | 'busy' }) {
  return <span className={`ob-mark is-${state}`} aria-hidden="true">{state === 'ok' ? <Check size={10} strokeWidth={3}/> : state === 'warn' ? <TriangleAlert size={10} strokeWidth={2.6}/> : state === 'fail' ? <X size={10} strokeWidth={3}/> : state === 'busy' ? <LoaderCircle size={11} className="spin"/> : <Minus size={10} strokeWidth={3}/>}</span>;
}
function Head({ title, children, aside }: { title: string; children?: ReactNode; aside?: ReactNode }) {
  return <header className="ob-head"><div><h3>{title}</h3>{children && <p>{children}</p>}</div>{aside}</header>;
}
function Logs({ logs, t }: { logs: LogEntry[]; t: Translate }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const element = ref.current; if (element) element.scrollTop = element.scrollHeight; }, [logs.length]);
  return <div className="ob-logs" ref={ref} tabIndex={0} aria-label={t('obLogs')}>{logs.length ? logs.slice(-60).map((log, index) => <div key={`${log.timestamp}-${index}`} className={`ob-log-line is-${log.level}`}><time>{new Date(log.timestamp).toLocaleTimeString([], { hour12: false })}</time><span>{log.message}</span></div>) : <p>{t('obNoLogs')}</p>}</div>;
}
function useTaskLogs(taskId: string | undefined, running: boolean) {
  return useQuery({ queryKey: ['onboarding-task-logs', taskId], queryFn: () => core.readTaskLogs(taskId!, 80), enabled: !!taskId, refetchInterval: running ? 2000 : false, retry: false });
}

// ---- Entry -------------------------------------------------------------------------------
function EntryScreen(props: OnboardingPageProps & { t: Translate; runtimeFact: GuideFacts['runtime']; readyVersion?: string }) {
  const { t, environment, candidates, profiles } = props;
  const running = candidates.filter(candidate => candidate.running === true);
  const gpus = environment?.gpus.map(parseGpu) ?? [];
  const appleGpu = core.unifiedGpu(environment);
  const memory = props.memoryGB;
  const sizes = core.MODEL_CATALOG.flatMap(model => Object.values(model.quantInfo).map(info => info.downloadGB));
  const suggested: GuidePath = running.length > 0 || profiles.length > 0 ? 'connect' : 'install';
  const [choice, setChoice] = useState<GuidePath>(suggested);
  useEffect(() => setChoice(suggested), [suggested]);
  const runtimeValue = props.runtimeFact === 'ready' ? `${t('obInstalled')}${props.readyVersion ? ` · ${props.readyVersion}` : ''}` : props.runtimeFact === 'repair' ? t('obNeedsRepair') : props.runtimeFact === 'running' ? t('obInProgress') : props.runtimeFact === 'unknown' ? t('obChecking') : t('obNotInstalled');
  const rows: { key: string; label: string; value: string; detail?: string; state: 'ok' | 'warn' | 'none' | 'busy' }[] = [
    { key: 'runtime', label: t('obRuntimeRow'), value: runtimeValue, state: props.runtimeFact === 'ready' ? 'ok' : props.runtimeFact === 'unknown' || props.runtimeFact === 'running' ? 'busy' : props.runtimeFact === 'repair' ? 'warn' : 'none' },
    { key: 'running', label: t('obRunningRow'), value: props.candidatesLoading ? t('obChecking') : running.length ? t('obFoundN', { count: running.length }) : t('obNotFound'), detail: running.map(candidate => candidate.detectedPort ? `127.0.0.1:${candidate.detectedPort}` : candidate.name).join(' · ') || undefined, state: props.candidatesLoading ? 'busy' : running.length ? 'ok' : 'none' },
    { key: 'gpu', label: t('obGpuRow'), value: props.environmentLoading ? t('obChecking') : gpuRowValue(environment) ?? (environment ? t('obNotFound') : t('obUnreadable')), detail: appleGpu ? appleGpuDetail(appleGpu, t) : gpus[0]?.driver ? t('obEnvDriver', { version: gpus[0].driver }) : undefined, state: props.environmentLoading ? 'busy' : gpus.length ? 'ok' : 'warn' },
    { key: 'memory', label: t('obMemoryRow'), value: memory ? `${Math.round(memory)} GB` : props.environmentLoading ? t('obChecking') : t('obUnreadable'), state: !memory ? (props.environmentLoading ? 'busy' : 'warn') : memory * .8 >= smallestCatalogRamGB() ? 'ok' : 'warn' },
  ];
  const start = () => props.onProgress({ path: choice });
  return <section className="ob-entry" data-testid="onboarding" data-step="entry">
    <div className="ob-panel">
      <header className="ob-entry-head"><span className="ob-eyebrow">{t('obEntryEyebrow')}</span><h2>{t('obEntryTitle')}</h2><p>{t('obEntryIntro')}</p></header>
      <h4 className="ob-section-title">{t('obDetectedHeading')}</h4>
      <div className="ob-checks">{rows.map(row => <div key={row.key} className="ob-check"><Mark state={row.state}/><span className="ob-check-label">{row.label}</span><span className="ob-check-value">{row.value}{row.detail && <small>{row.detail}</small>}</span></div>)}</div>
      <h4 className="ob-section-title">{t('guideChoosePath')}</h4>
      <div className="ob-choices" role="radiogroup" aria-label={t('guideChoosePath')}>
        {(['install', 'connect'] as const).map(value => <button key={value} type="button" role="radio" aria-checked={choice === value} className={`ob-choice${choice === value ? ' is-on' : ''}`} onClick={() => setChoice(value)}>
          <span className="ob-radio" aria-hidden="true"/>
          <span className="ob-choice-body"><b>{t(value === 'install' ? 'guideInstall' : 'guideExisting')}{value === suggested && <em className="ob-tag">{t('obRecommended')}</em>}</b><span>{t(value === 'install' ? 'obInstallChoiceHint' : 'obConnectIntro')}</span></span>
          <span className="ob-choice-meta">{t('obSteps', { count: value === 'install' ? 6 : 3 })}<br/>{value === 'install' ? t('obDownloadRange', { min: Math.round(Math.min(...sizes)), max: Math.round(Math.max(...sizes)) }) : t('obNoDownload')}</span>
        </button>)}
      </div>
      <footer className="ob-actions">
        <button type="button" className="st-btn st-btn--secondary" onClick={props.onSkip}>{t('obSkip')}</button>
        <span className="ob-note">{t('obSkipHint')}</span>
        <button type="button" className="primary" onClick={start}>{t(choice === 'install' ? 'obStartCheck' : 'obStartConnect')}</button>
      </footer>
    </div>
  </section>;
}

// ---- Environment -------------------------------------------------------------------------
/** "20 核 GPU · 统一内存 48 GB，GPU 可用约 36 GB" — unified memory is the system RAM, not extra VRAM. */
function appleGpuDetail(gpu: core.GpuDetail, t: Translate) {
  const gib = (bytes?: number) => bytes && bytes > 0 ? Math.round(bytes / 1024 ** 3) : 0;
  return unifiedText({ cores: gpu.cores ?? 0, total: gib(gpu.memoryBytes), budget: gib(gpu.gpuBudgetBytes) }, t);
}
function unifiedText(params: Record<string, number>, t: Translate) {
  const parts = [params.cores ? t('obEnvGpuCores', { count: params.cores }) : '', params.total ? (params.budget ? t('obEnvAppleUnified', { total: params.total, budget: params.budget }) : t('obEnvAppleUnifiedOnly', { total: params.total })) : ''];
  return parts.filter(Boolean).join(' · ') || t('obEnvAppleUnifiedShort');
}
function checkDetail(check: EnvironmentCheck, t: Translate) {
  if (!check.detail) return undefined;
  if (check.detail === 'appleUnified') return unifiedText(check.params ?? {}, t);
  if (check.detail === 'appleNoMetal') return t('obEnvAppleNoMetal');
  if (check.detail.startsWith('driver:')) return t('obEnvDriver', { version: check.detail.slice(7) });
  const minimum = smallestCatalogRamGB();
  return ({ arch: t('obEnvArch'), noGpu: t('obEnvNoGpu'), nonNvidia: t('obEnvNonNvidia'), low: t('obEnvLowMemory', { gb: minimum, need: Math.ceil(minimum / .8) }), unknown: t('obUnreadable'), bundled: t('obEnvPythonBundled'), managed: t('obEnvPythonManaged'), required: t('obEnvPythonRequired') } as Record<string, string>)[check.detail];
}
function EnvironmentStep(props: StepProps & { checks?: EnvironmentCheck[]; verdict: GuideFacts['environment']; readOnly: boolean }) {
  const { t, checks, verdict } = props;
  const label = (id: EnvironmentCheck['id']) => id === 'python' ? 'Python' : t(({ system: 'obSystemRow', gpu: 'obGpuRow', memory: 'obMemoryRow' } as Record<string, string>)[id]!);
  return <div className="ob-panel">
    <Head title={t('guideCheckEnvironment')} aside={<button type="button" className="st-btn st-btn--secondary" disabled={props.environmentLoading || !props.desktop} onClick={props.onRecheckEnvironment}><RefreshCw size={14} className={props.environmentLoading ? 'spin' : ''}/>{t('obRecheck')}</button>}>{t('obEnvIntro')}</Head>
    <div className="ob-checks">
      {!props.desktop ? <div className="ob-check"><Mark state="warn"/><span className="ob-check-label">{t('obSystemRow')}</span><span className="ob-check-value">{t('obDesktopOnly')}</span></div>
        : !checks ? <div className="ob-check"><Mark state={props.environmentError ? 'warn' : 'busy'}/><span className="ob-check-label">{t('obSystemRow')}</span><span className="ob-check-value">{props.environmentError ?? t('obChecking')}</span></div>
        : checks.map(check => <div key={check.id} className="ob-check"><Mark state={check.state}/><span className="ob-check-label">{label(check.id)}</span><span className="ob-check-value">{check.value || (checkDetail(check, t) ? '' : '—')}{checkDetail(check, t) && <small className={`${check.state === 'ok' ? '' : `is-${check.state}`}${check.value ? '' : ' is-alone'}`}>{checkDetail(check, t)}</small>}</span></div>)}
      {props.desktop ? <GuideStorageRows language={props.language} desktop={props.desktop} onChooseDirectory={props.readOnly ? undefined : props.onChooseDirectory}
        renderRow={(rowLabel, value, action) => <div key={rowLabel} className={`ob-check${action ? ' has-action' : ''}`} data-testid="ob-storage-row"><Mark state="none"/><span className="ob-check-label">{rowLabel}</span><span className="ob-check-value ob-storage-value">{value}</span>{action}</div>}/>
        : <div className="ob-check"><Mark state="none"/><span className="ob-check-label">{t('obInstallLocation')}</span><span className="ob-check-value">{t('obInstallLocationValue')}</span></div>}
    </div>
    {!props.readOnly && checks?.some(check => check.id === 'python' && check.state === 'fail') && <ManagedPythonPanel variant="compact" language={props.language} desktop={props.desktop} found={props.environment?.python} onInstalled={props.onRecheckEnvironment}/>}
    {!props.readOnly && <footer className="ob-actions">
      {verdict === 'fail' && <span className="ob-note is-bad">{t('obEnvBlocked')}</span>}
      <button type="button" className="primary" disabled={verdict === 'fail' || verdict === 'loading' || verdict === 'unavailable'} onClick={() => props.onProgress({ environmentAccepted: true })}>{t('obContinueInstall')}</button>
    </footer>}
  </div>;
}

// ---- Runtime -----------------------------------------------------------------------------
function RuntimeStep(props: StepProps & { runtimeTask?: TaskStatus; runtimeFact: GuideFacts['runtime']; readyVersion?: string; repairReason?: string; onRefreshRuntime: () => void }) {
  const { t, runtimeTask, runtimeFact } = props;
  const [starting, setStarting] = useState(false);
  const [canceling, setCanceling] = useState(false);
  // Same local-package flow as the Strata page (#74): one hook, one prepareLocalRuntime call.
  const packagePlatform = core.runtimePackagePlatform(props.environment?.os);
  const windows = packagePlatform === 'windows';
  const packages = useLocalRuntimePackages(packagePlatform, key => t(key === 'strataArchivePath' ? 'obLocalStrata' : 'obLocalEngine'));
  const { source: packageSource, archives, pickError, picking, pick, chosen, missing: localMissing } = packages;
  const running = runtimeTask?.state === 'running';
  const logs = useTaskLogs(runtimeTask?.id, running);
  const start = async () => {
    if (starting || running || localMissing) return;
    setStarting(true);
    try { const task = await core.prepareLocalRuntime(chosen); props.onProgress({ runtimeTaskId: task.id }); props.onRefreshRuntime(); }
    catch (error) { props.onError(error); } finally { setStarting(false); }
  };
  const archiveRow = (key: keyof core.LocalRuntimeArchives, label: string) => <div className="ob-check ob-archive" key={key}>
    <Mark state={archives[key] ? 'ok' : 'none'}/>
    <span className="ob-check-label">{label}</span>
    <span className="ob-check-value">{archives[key] ? <code className="ob-mono-small" data-testid={`ob-archive-${key}`}>{archives[key]}</code> : <small className="is-alone">{t('obNotChosen')}</small>}</span>
    <span className="ob-archive-actions">
      <button type="button" className="st-btn st-btn--secondary" disabled={!props.desktop || picking || starting} onClick={() => void pick(key)}>{t('obChooseFile')}</button>
      {archives[key] && <button type="button" className="ob-link" disabled={picking || starting} onClick={() => packages.clear(key)}>{t('obClearFile')}</button>}
    </span>
  </div>;
  const cancel = async () => { if (!runtimeTask || canceling) return; setCanceling(true); try { await core.cancelTask(runtimeTask.id); } catch (error) { props.onError(error); } finally { setCanceling(false); } };
  const percent = running ? taskProgress(runtimeTask?.message) : undefined;
  const failed = runtimeFact === 'failed';
  return <div className="ob-panel">
    <Head title={t('guideInstallRuntime')} aside={running ? <span className="ob-elapsed">{t('obElapsed', { time: clock(props.now - runtimeTask!.startedAt) })}</span> : undefined}>{runtimeFact === 'repair' ? t('obRuntimeRepairHint') : t('guideInstallRuntimeHint')}</Head>
    {runtimeFact === 'ready' ? <div className="ob-status is-ok"><Mark state="ok"/><div><b>{t('obRuntimeReady')}{props.readyVersion ? ` · ${props.readyVersion}` : ''}</b></div></div>
      : running ? <div className="ob-status"><Mark state="busy"/><div className="ob-status-body"><b>{runtimeTask!.message || t('obPreparing')}</b><div className={`ob-bar${percent === undefined ? ' is-indeterminate' : ''}`}><i style={percent === undefined ? undefined : { width: `${percent}%` }}/></div><small>{t('obRuntimeRunningHint')}</small></div></div>
      : failed ? <div className="ob-status is-bad"><Mark state="fail"/><div className="ob-status-body"><b>{runtimeTask?.message}</b></div></div>
      : runtimeFact === 'repair' && props.repairReason ? <div className="ob-status" data-testid="ob-runtime-repair-reason"><Mark state="warn"/><div className="ob-status-body"><small>{props.repairReason}</small></div></div>
      : null}
    {failed && core.needsManagedPython(runtimeTask?.message) && <ManagedPythonPanel variant="compact" language={props.language} desktop={props.desktop} found={props.environment?.python}/>}
    {!running && runtimeFact !== 'ready' && <div className="ob-package-source">
      <div className="ob-field is-row"><span>{t('obPackageSource')}</span><Segmented ariaLabel={t('obPackageSource')} value={packageSource} onValueChange={value => packages.setSource(value as core.RuntimePackageSource)} options={[{ value: 'download', label: t('obSourceDownload') }, { value: 'local', label: t('obSourceLocal') }]}/></div>
      {packageSource === 'local' && <>
        <p className="ob-note">{t(packagePlatform === 'windows' ? 'obLocalHintWindows' : packagePlatform === 'macos' ? 'obLocalHintMac' : 'obLocalHintLinux')}</p>
        <div className="ob-checks">{archiveRow('strataArchivePath', t('obLocalStrata'))}{windows && archiveRow('engineArchivePath', t('obLocalEngine'))}</div>
        {pickError && <p className="ob-error" role="alert">{pickError}</p>}
      </>}
    </div>}
    {(running || failed || (runtimeTask && runtimeFact !== 'ready')) && <><h4 className="ob-section-title">{t('obLogs')}</h4><Logs logs={logs.data ?? []} t={t}/></>}
    <footer className="ob-actions">
      {running && <button type="button" className="st-btn st-btn--secondary" disabled={canceling} onClick={() => void cancel()}><Square size={13}/>{t('obCancel')}</button>}
      {localMissing && <span className="ob-note">{t('obLocalRequired')}</span>}
      {!running && runtimeFact !== 'ready' && <button type="button" className="primary" disabled={!props.desktop || starting || runtimeFact === 'unknown' || localMissing} onClick={() => void start()}>{starting && <LoaderCircle size={14} className="spin"/>}{t(failed ? 'obInstallRetry' : 'obInstallNow')}</button>}
      {!props.desktop && <span className="ob-note">{t('obDesktopOnly')}</span>}
    </footer>
  </div>;
}

// ---- Model -------------------------------------------------------------------------------
const existingIntro = (language: core.AppLanguage) => core.legacyLanguage(language) === 'zh-CN'
  ? '选择已下载的 GGUF 文件夹，确认量化版本后原地使用，不再重复下载。'
  : 'Choose a folder of downloaded GGUF files, confirm the quantization, and use them in place without downloading again.';
function ModelStep(props: StepProps & { runtimeProfile?: ServiceProfile }) {
  const { t, progress, environment, memoryGB, runtimeProfile } = props;
  const scene: Scene = progress?.scene ?? 'chat';
  const gpus = environment?.gpus.map(parseGpu) ?? [];
  const gpu = gpus.find(item => item.nvidia) ?? gpus[0];
  const nvidia = gpus.some(item => item.nvidia);
  const rows = useMemo(() => recommendations(scene, memoryGB, nvidia), [scene, memoryGB, nvidia]);
  const selected = progress?.selection && rows.some(row => row.family === progress.selection!.family && row.quant === progress.selection!.quant) ? progress.selection : rows[0] ? { family: rows[0].family, quant: rows[0].quant, context: defaultContext(scene), images: false } : undefined;
  const select = (patch: Partial<GuideSelection>) => { if (selected) props.onProgress({ selection: { ...selected, ...patch } }); };
  const entry = core.MODEL_CATALOG.find(model => model.family === selected?.family);
  const info = selected ? entry?.quantInfo[selected.quant] : undefined;
  const arena = useQuery({ queryKey: ['arena-public-groups'], queryFn: ({ signal }) => fetchArenaGroups(signal), staleTime: 10 * 60_000, retry: false, refetchOnWindowFocus: false });
  const defaults = useQuery({ queryKey: ['model-download-defaults'], queryFn: async () => core.normalizeModelDownloadDefaults(await core.loadStore<unknown>(core.MODEL_DOWNLOAD_DEFAULTS_KEY, null)), staleTime: Infinity, retry: false });
  const runtime = defaults.data?.runtime ?? runtimeProfile;
  const disk = useQuery({ queryKey: ['setup-disk', runtime?.installDir, selected?.family, selected?.quant, selected?.images], queryFn: () => core.setupDiskPreflight(runtime!, selected!.family, selected!.quant, selected!.images), enabled: props.desktop && !!runtime?.installDir && !!selected, staleTime: 15000, retry: false });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [source, setSource] = useState<'catalog' | 'existing'>('catalog');
  const max = Math.max(memoryGB ?? 0, ...rows.map(row => row.ramGB)) * 1.08;
  const options = defaults.data?.options;
  const request = runtime && selected && options && options.gpus !== 'all' ? { installationId: runtime.id, family: selected.family, quant: selected.quant, context: selected.context, images: selected.images, kv: selected.context <= 8192 ? 'fp16' : 'int8', gpuIds: options.gpus ? options.gpus.split(',').map(Number) : [], parallel: 1 } : undefined;
  const prepare = async () => {
    if (!runtime || !selected || !options || submitting) return;
    setSubmitting(true); setError('');
    try {
      const snapshot = core.snapshotModelDownloadRequest(runtime, { model: selected.family, quant: selected.quant, context: selected.context, images: selected.images }, options);
      const checked = await core.setupDiskPreflight(snapshot.profile, snapshot.model, snapshot.quant, snapshot.images);
      if (checked.status !== 'ready') throw new Error(t(checked.status === 'insufficient' ? 'obDiskInsufficient' : 'obDiskUnknown'));
      const task = await props.onPrepareModel(snapshot);
      if (task) props.onProgress({ setupTaskId: task.id, selection: selected });
    } catch (cause) { setError(core.normalizeError(cause).message); } finally { setSubmitting(false); }
  };
  const sourceSwitch = props.onChooseDirectory && props.onChooseFile ? <div className="ob-model-source" data-testid="ob-model-source"><Segmented ariaLabel={t('obModelSource')} value={source} onValueChange={value => setSource(value as 'catalog' | 'existing')} options={[{ value: 'catalog', label: t('obSourceCatalog') }, { value: 'existing', label: t('obSourceExisting') }]}/></div> : null;
  // Same flow as the Models page (#75): official setup with --gguf-dir, or the ORCA.md import.
  if (source === 'existing' && props.onChooseDirectory && props.onChooseFile) return <div className="ob-panel" data-testid="ob-existing-model">
    {sourceSwitch}
    <Head title={t('obSourceExisting')}>{existingIntro(props.language)}</Head>
    <ExistingModelPanel compact language={props.language} desktop={props.desktop} runtime={runtime} runtimeVersion={props.guide.readyRuntime?.runtimeVersion} busy={props.busy} options={options ?? core.normalizeOfficialSetupOptions()} windows={core.runtimePackageIsWindows(environment?.os)}
      onChooseDirectory={props.onChooseDirectory} onChooseFile={props.onChooseFile}
      onSetup={request => props.onPrepareModel(request)} onOrcaImport={props.onOrcaImport}
      onStarted={(task, chosen) => { if (!task) return; props.onProgress({ setupTaskId: task.id, ...(chosen.family !== 'orca' && core.MODEL_CATALOG.some(model => model.family === chosen.family) ? { selection: { family: chosen.family, quant: chosen.quant, context: chosen.context, images: false } } : {}) }); }}/>
  </div>;
  return <div className="ob-split">
    <div className="ob-panel">
      {sourceSwitch}
      <Head title={t('guideChooseModel')} aside={<Segmented ariaLabel={t('guideChooseModel')} value={scene} onValueChange={value => props.onProgress({ scene: value as Scene, selection: undefined })} options={[{ value: 'chat', label: t('obSceneChat') }, { value: 'long', label: t('obSceneLong') }, { value: 'code', label: t('obSceneCode') }]}/>}>{memoryGB ? t('obModelIntro', { gb: Math.round(memoryGB) }) : t('guidePrepareModelHint')}</Head>
      <div className="ob-models" role="radiogroup" aria-label={t('guideChooseModel')}>
        <div className="ob-model is-head" aria-hidden="true"><span/><span>{t('obColModel')}</span><span>{memoryGB ? t('obColMemory', { gb: Math.round(memoryGB) }) : t('obMemoryRow')}</span><span className="ob-right">{t('obColDownload')}</span><span className="ob-right">{t('obColSpeed')}</span></div>
        {rows.map(row => <ModelRow key={`${row.family}-${row.quant}`} row={row} t={t} max={max} memoryGB={memoryGB} gpu={gpu} groups={arena.data?.groups} arenaFailed={arena.isError}
          selected={selected?.family === row.family && selected.quant === row.quant} onSelect={() => props.onProgress({ selection: { family: row.family, quant: row.quant, context: selected?.context ?? defaultContext(scene), images: false } })}/>)}
      </div>
      <footer className="ob-links">
        <button type="button" className="ob-link" onClick={props.onOpenCatalog}>{t('obAllModels')}<ArrowRight size={13}/></button>
        <button type="button" className="ob-link" onClick={props.onOpenCatalog}>{t('obImportExisting')}<ArrowRight size={13}/></button>
        <p>{arena.isError ? t('obSpeedOffline') : t('obSpeedNote')}</p>
      </footer>
    </div>
    <aside className="ob-panel ob-side">
      {selected && entry ? <>
        <div className="ob-side-sec"><span className="ob-eyebrow">{t('obSelected')}</span><h3>{entry.name} <code className="ob-quant">{selected.quant}</code></h3></div>
        <div className="ob-side-sec">
          <label className="ob-field"><span>{t('obContext')}</span><Dropdown ariaLabel={t('obContext')} value={String(selected.context)} onValueChange={value => select({ context: Number(value) })} options={[...new Set([...CONTEXTS, selected.context])].sort((a, b) => a - b).map(value => ({ value: String(value), label: core.isExtendedContext(value) ? `${contextLabel(value)} · ${t('obExperimental')}` : contextLabel(value) }))}/></label>
          <ContextExtensionNotice mode="setup" language={props.language} context={selected.context} kv={selected.context <= 8192 ? 'fp16' : 'int8'}/>
          <div className="ob-field is-row"><span>{t('obImages')}</span><Toggle ariaLabel={t('obImages')} checked={selected.images} disabled={!entry.images || !!info?.visionUntested} onCheckedChange={images => select({ images })}/></div>
        </div>
        <div className="ob-side-sec"><h4>{t('obFitHeading')}</h4>
          <ResourceAssessmentPanel compact desktop={props.desktop} language={props.language} request={request} disk={disk.data} diskPending={disk.isPending && disk.fetchStatus !== 'idle'} diskError={disk.error} onRefreshDisk={() => void disk.refetch()} unavailableReason={!runtime ? t('obNeedRuntime') : undefined}/>
        </div>
        <div className="ob-side-sec ob-side-actions">
          {error && <p className="ob-error" role="alert">{error}</p>}
          <button type="button" className="primary ob-wide" disabled={!props.desktop || !runtime || !options || submitting || props.busy || disk.data?.status === 'insufficient'} onClick={() => void prepare()}>{submitting && <LoaderCircle size={14} className="spin"/>}{t('obDownloadAndPrepare', { gb: gb(info?.downloadGB ?? 0) })}</button>
          <span className="ob-note ob-center">{t('obPipeline')}</span>
          <button type="button" className="ob-link ob-center" onClick={props.onOpenCatalog}>{t('obDownloadSettings')}<ArrowRight size={13}/></button>
        </div>
      </> : <div className="ob-side-sec"><p className="ob-note">{t('obNeedRuntime')}</p></div>}
    </aside>
  </div>;
}
function ModelRow({ row, t, max, memoryGB, gpu, groups, arenaFailed, selected, onSelect }: { row: Recommendation; t: Translate; max: number; memoryGB?: number; gpu?: ReturnType<typeof parseGpu>; groups?: Parameters<typeof arenaMatch>[0]; arenaFailed: boolean; selected: boolean; onSelect: () => void }) {
  const match = arenaMatch(groups, row.family, row.quant, gpu);
  const tier = useQuery({ queryKey: ['arena-public-tier', match ? JSON.stringify(arenaLeaderboardQuery(match)) : null], queryFn: ({ signal }) => fetchArenaTier(arenaLeaderboardQuery(match!), signal), enabled: !!match, staleTime: 10 * 60_000, retry: false, refetchOnWindowFocus: false });
  const speed = tier.data?.decode;
  const bars = match ? confidenceBars(match.machines) : 0;
  const tags = [row.recommended && <em key="r" className="ob-tag">{t('obRecommended')}</em>, row.experimental && <em key="e" className="ob-tag is-muted">{t('obExperimental')}</em>, row.nvidiaOnly && <em key="n" className="ob-tag is-muted">{t('obNvidiaOnly')}</em>].filter(Boolean);
  return <button type="button" role="radio" aria-checked={selected} className={`ob-model${selected ? ' is-on' : ''}`} onClick={onSelect}>
    <span className="ob-radio" aria-hidden="true"/>
    <span className="ob-model-name"><b>{row.name}</b><code className="ob-quant">{row.quant}</code>{tags}</span>
    <span className="ob-model-fit"><D2DotAxis value={row.ramGB} max={max} limit={memoryGB} warn={row.fit !== 'fits'} label={`${row.ramGB} GB`}/><small>{row.ramGB} GB · {t(row.fit === 'fits' ? 'obFits' : row.fit === 'tight' ? 'obTight' : row.fit === 'over' ? 'obOver' : 'obNotMeasured')}</small></span>
    <span className="ob-right ob-mono">{gb(row.downloadGB)} GB</span>
    <span className="ob-right ob-speed">{speed !== undefined && match ? <><b>{gb(speed)}</b> tok/s<small><span className="ob-sig" aria-hidden="true">{[1, 2, 3].map(level => <i key={level} className={level <= bars ? 'is-on' : ''}/>)}</span>{t(match.level === 'gpu' ? 'obArenaGpu' : 'obArenaVram')} · {t('obMachines', { count: match.machines })}</small></> : <small>{arenaFailed || !tier.isPending || !match ? t('obNotMeasured') : '…'}</small>}</span>
  </button>;
}

// ---- Download ----------------------------------------------------------------------------
function DownloadStep(props: StepProps & { setupTask?: TaskStatus; handoff?: core.SetupHandoff }) {
  const { t, setupTask, handoff, progress } = props;
  const running = setupTask?.state === 'running';
  const logs = useTaskLogs(setupTask?.id, running);
  const percent = running ? taskProgress(setupTask?.message) : setupTask?.state === 'completed' ? 100 : undefined;
  const [canceling, setCanceling] = useState(false);
  const cancel = async () => { if (!setupTask || canceling) return; setCanceling(true); try { await core.cancelTask(setupTask.id); } catch (error) { props.onError(error); } finally { setCanceling(false); } };
  const selection = progress?.selection;
  const failed = setupTask && (setupTask.state === 'failed' || setupTask.state === 'cancelled');
  return <div className="ob-panel">
    <Head title={selection ? `${t('obStepDownload')} · ${modelName(selection.family)} ${selection.quant}` : t('obStepDownload')} aside={setupTask && running ? <span className="ob-elapsed">{t('obElapsed', { time: clock(props.now - setupTask.startedAt) })}</span> : undefined}>{t('obDownloadIntro')}</Head>
    <div className="ob-download">
      <div className="ob-bignum">{percent !== undefined ? <>{Math.floor(percent)}<small>%</small></> : <LoaderCircle size={28} className="spin"/>}</div>
      <div className="ob-status-body">
        <b>{failed ? t('obDownloadFailed') : setupTask?.state === 'completed' ? (handoff?.status === 'registered' ? t('obStepDone') : t('obRegistering')) : setupTask?.message || t('obPreparing')}</b>
        <div className={`ob-bar${percent === undefined && !failed ? ' is-indeterminate' : ''}${failed ? ' is-bad' : ''}`}><i style={percent === undefined ? undefined : { width: `${percent}%` }}/></div>
        {failed && setupTask?.message && <small className="is-bad">{setupTask.message}</small>}
      </div>
    </div>
    {handoff && (handoff.status === 'needs-choice' || handoff.status === 'failed') && <div className="ob-handoff"><SetupHandoffActions handoff={handoff} canRecheck={setupTask?.state === 'completed'} disabled={props.busy} onResolve={configPath => props.onResolveHandoff(handoff.taskId, configPath)} onUse={async profileId => { props.onProgress({ profileId }); await props.onRefreshProfiles(); }} onView={props.onOpenTasks} onError={props.onError}/></div>}
    <h4 className="ob-section-title">{t('obLogs')}</h4>
    <Logs logs={logs.data ?? []} t={t}/>
    <div className="ob-option">
      <div><b>{t('obAutoStart')}</b><small>{t('obAutoStartHint')}</small></div>
      <Toggle ariaLabel={t('obAutoStart')} checked={progress?.autoStart === true} onCheckedChange={autoStart => props.onProgress({ autoStart })}/>
    </div>
    <footer className="ob-actions">
      {running && <button type="button" className="st-btn st-btn--secondary" disabled={canceling} onClick={() => void cancel()}><Square size={13}/>{t('obCancel')}</button>}
      {failed && <button type="button" className="primary" onClick={() => props.onProgress({ setupTaskId: undefined })}>{t('obChooseAnother')}</button>}
      <button type="button" className="ob-link" onClick={props.onOpenTasks}>{t('obTaskDetails')}<ArrowRight size={13}/></button>
      <span className="ob-note">{t('obSlowHint')}</span>
    </footer>
  </div>;
}

// ---- Start / load ------------------------------------------------------------------------
function StartStep(props: StepProps) {
  const { t, target, facts, profiles } = props;
  const [working, setWorking] = useState(false);
  const run = async (operation: () => Promise<void>) => { if (working) return; setWorking(true); try { await operation(); } catch (error) { props.onError(error); } finally { setWorking(false); } };
  const serviceState = facts.online ? 'ok' : props.starting ? 'busy' : 'none';
  const modelState = facts.loaded ? 'ok' : facts.online ? 'busy' : 'none';
  const logs = props.startupLogs;
  return <div className="ob-panel">
    <Head title={props.progress?.path === 'connect' ? t('obStepLoad') : t('guideStartAndLoad')}>{t('guideStartAndLoadHint')}</Head>
    {target ? <>
      {profiles.length > 1 && <div className="ob-check"><Mark state="none"/><span className="ob-check-label">{t('obChooseConfig')}</span><span className="ob-check-value"><Dropdown ariaLabel={t('obChooseConfig')} value={target.id} disabled={working || props.starting} onValueChange={profileId => props.onProgress({ profileId })} options={profiles.map(item => ({ value: item.id, label: item.name }))}/></span></div>}
      <div className="ob-checks">
        <div className="ob-check"><Mark state={serviceState}/><span className="ob-check-label">{t('obService')}</span><span className="ob-check-value">{t(facts.online ? 'obStateOnline' : props.starting ? 'obStateStarting' : 'obStateStopped')}<small>{target.baseUrl}</small></span></div>
        <div className="ob-check"><Mark state={modelState}/><span className="ob-check-label">{t('obModel')}</span><span className="ob-check-value">{t(facts.loaded ? 'obStateLoaded' : 'obStateNotLoaded')}<small>{props.modelName ?? target.name}</small></span></div>
        {target.configPath && <div className="ob-check"><Mark state="none"/><span className="ob-check-label">{t('obConfigFile')}</span><span className="ob-check-value ob-mono-small">{target.configPath}</span></div>}
      </div>
      {(props.starting || logs.length > 0) && <><h4 className="ob-section-title">{t('obLogs')}</h4><Logs logs={logs} t={t}/></>}
    </> : <p className="ob-empty">{t('obNoConfig')}</p>}
    <footer className="ob-actions">
      {target && !facts.online && <button type="button" className="primary" disabled={!props.desktop || working || props.starting || props.busy || !target.managed} onClick={() => void run(() => props.onStart(target))}>{(working || props.starting) && <LoaderCircle size={14} className="spin"/>}{t('obStartLoad')}</button>}
      {target && facts.online && !facts.loaded && <button type="button" className="primary" disabled={working || props.busy} onClick={() => void run(() => props.onLoad(target))}>{working && <LoaderCircle size={14} className="spin"/>}{t('obLoadModel')}</button>}
      {target && <button type="button" className="ob-link" onClick={() => props.onOpenConfig(target)}>{t('obAdjustConfig')}<ArrowRight size={13}/></button>}
    </footer>
  </div>;
}

// ---- Connect: discover -------------------------------------------------------------------
function DiscoverStep(props: StepProps) {
  const { t, candidates } = props;
  const [working, setWorking] = useState('');
  const sorted = [...candidates].sort((a, b) => Number(b.running === true) - Number(a.running === true));
  const connect = async (candidate: core.LocalCandidate) => { if (working) return; setWorking(candidate.id); try { await props.onConnectCandidate(candidate); } catch (error) { props.onError(error); } finally { setWorking(''); } };
  return <div className="ob-panel">
    <Head title={t('guideFoundServices')} aside={<button type="button" className="st-btn st-btn--secondary" disabled={props.candidatesLoading} onClick={props.onRescan}><RefreshCw size={14} className={props.candidatesLoading ? 'spin' : ''}/>{t('obRescan')}</button>}>{t('obConnectIntro')}</Head>
    <div className="ob-found">
      {props.candidatesLoading && !sorted.length ? <div className="ob-check"><Mark state="busy"/><span className="ob-check-label">{t('guideDiscovering')}</span><span className="ob-check-value"/></div>
        : sorted.length ? sorted.map(candidate => <div key={candidate.id} className="ob-found-row">
          <Mark state={candidate.running ? 'ok' : 'none'}/>
          <span className="ob-mono">{candidate.running && candidate.detectedPort ? `127.0.0.1:${candidate.detectedPort}` : t('obConfigured')}</span>
          <span className="ob-found-name"><b>{candidate.name}</b><small>{candidate.configPath}</small></span>
          <span className="ob-note">{candidate.running ? t('obRunningNow') : candidate.runtimeVersion ?? ''}</span>
          <button type="button" className={candidate.running ? 'primary' : 'st-btn st-btn--secondary'} disabled={!!working || props.busy || candidate.availability === 'repair'} onClick={() => void connect(candidate)}>{working === candidate.id && <LoaderCircle size={14} className="spin"/>}{t(candidate.running ? 'obConnect' : 'obStartThis')}</button>
        </div>)
        : <p className="ob-empty">{t('obNothingFound')}</p>}
    </div>
    <footer className="ob-actions">
      <button type="button" className="st-btn st-btn--secondary" disabled={!props.desktop} onClick={props.onAddDirectory}><FolderPlus size={14}/>{t('obAddDirectory')}</button>
      <span className="ob-note">{t('obConnectScope')}</span>
    </footer>
  </div>;
}

// ---- Ready / first chat ------------------------------------------------------------------
function ReadyStep(props: StepProps) {
  const { t, target } = props;
  const [text, setText] = useState('');
  const ready = props.facts.online && props.facts.loaded;
  const send = (value: string) => { const message = value.trim(); if (message && ready) props.onSendFirstMessage(message); };
  const suggestions = [t('obSuggest1'), t('obSuggest2'), t('obSuggest3')];
  return <div className="ob-split is-wide-side">
    <div className="ob-panel">
      <Head title={t('obReadyTitle')}>{t('obReadyIntro', { model: props.modelName ?? target?.name ?? '', url: target?.baseUrl ?? '' })}</Head>
      <form className="ob-composer" onSubmit={event => { event.preventDefault(); send(text); }}>
        <textarea aria-label={t('obComposerPlaceholder')} placeholder={t('obComposerPlaceholder')} value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(text); } }} rows={3}/>
        <div><span className="ob-note">{props.modelName ?? target?.name}</span><button type="submit" className="primary" disabled={!ready || !text.trim()}>{t('obSend')}</button></div>
      </form>
      <div className="ob-suggestions">{suggestions.map(item => <button key={item} type="button" disabled={!ready} onClick={() => send(item)}>{item}<span aria-hidden="true">↵</span></button>)}</div>
    </div>
    <aside className="ob-panel ob-side">
      <div className="ob-side-sec"><h4>{t('obBenchmark')}</h4><p className="ob-note">{t('obBenchmarkHint')}</p><button type="button" className="st-btn st-btn--secondary" disabled={!ready} onClick={props.onOpenBenchmark}>{t('obBenchmark')}</button></div>
      <div className="ob-side-sec"><h4>{t('obAddress')}</h4><code className="ob-mono-small">{target?.baseUrl}/v1</code><button type="button" className="ob-link" onClick={() => target && props.onCopy(`${target.baseUrl}/v1`)}><Copy size={13}/>{t('obCopyApi')}</button></div>
      <div className="ob-side-sec"><p className="ob-note">{t('guideAdvancedHint')}</p><button type="button" className="st-btn st-btn--secondary" onClick={props.onFinish}>{t('obFinish')}</button></div>
    </aside>
  </div>;
}
