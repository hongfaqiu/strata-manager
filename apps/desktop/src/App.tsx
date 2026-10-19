import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { EndpointHero, EnvironmentDevices, TasksTimeline, VramReserveBar, machineMemoryGB } from './pages/D2PageStrips';
import { readHardware } from './pages/D2Visuals';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Activity, ArrowRight, Check, Download, FileText, Flag, FolderOpen, Gauge, HardDrive, LayoutDashboard, LoaderCircle, MessageSquare, RefreshCw, Search, Server, Settings2, SlidersHorizontal, Square, Terminal, Upload, X, Zap } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { AppSettings, Attachment, ChatMessage, Conversation, ServiceProfile, TaskStatus, JsonObject, ChatOptions, ToolEvent } from '@strata-manager/core';
import i18n, { type TextKey } from './i18n';
import { LanguageSetupDialog } from './LanguageSetupDialog';
import { Badge, Dialog, Empty, Field, Header, OfficialIcon, Panel } from './components';
import { SamplingDrawer, officialSamplingDefaults, defaultChatPreferences, type ChatPreferences } from './ChatSettings';
import { ChatPage } from './pages/ChatPage';
import { OverviewPage } from './pages/OverviewPage';
import { selectOverviewStartup } from './pages/overviewStartup';
import { RuntimeConfigPage } from './pages/RuntimeConfigPage';
import { CommonChatSettingsPanel } from './CommonChatSettingsPanel';
import { ServiceConnectionPanel } from './ServiceConnectionPanel';
import { McpIntegrationPanel } from './McpIntegrationPanel';
import { RuntimeOperationsPanel } from './RuntimeOperationsPanel';
import { ApiIntegrationDialog } from './ApiIntegrationDialog';
import './shared-settings.css';
import { ServiceManagerPage } from './pages/ServiceManagerPage';
import { RequestViewer } from './RequestViewer';
import { MonitoringPage } from './OfficialMonitoring';
import { AboutPage } from './OfficialAbout';
import { AppLayout, Sidebar } from './layouts/AppLayout';
import { WorkspaceLayout } from './layouts/WorkspaceLayout';
import { ServiceTelemetryStatusBar } from './layouts/ServiceTelemetryStatusBar';
import { normalizeFloatingMonitorPreferences, openFloatingMonitor, readMonitorModeStatus, setMonitorVisibility, type MonitorModeStatus, type MonitorDestination } from './floatingMonitor';
import { FloatingMonitorSettings } from './pages/FloatingMonitorSettings';
import type { LocalSetupProgress } from './pages/LocalSetupPage';
import { DesktopLifecycleSettings } from './pages/DesktopLifecycleSettings';
import { useAppUpdates } from './useAppUpdates';
import { useAppVersion } from './useAppVersion';
import { ServiceCapabilityPanel } from './ServiceCapabilityPanel';
import { StartupDiagnosticCard } from './pages/StartupDiagnosticCard';
import { ModelDownloadPage } from './pages/ModelDownloadPage';
import { TuningPage } from './pages/TuningPage';
import { ApiUsagePage } from './pages/ApiUsagePage';
import { BenchmarkPage } from './pages/BenchmarkPage';
import { buildOverviewMock, overviewMockEnabled } from './pages/overviewMockData';
import { createApiUsageMockClient } from './pages/apiUsageMock';
const apiUsageMockClient = createApiUsageMockClient();
import { InstallRuntimePage } from './pages/InstallRuntimePage';
import { SetupHandoffActions } from './pages/SetupHandoffActions';
import { StartupProgress, startupPhaseLabel } from './pages/StartupProgress';
import { WindowTitleBar } from './WindowTitleBar';
import { ServiceStatusPopover } from './ServiceStatusPopover';
import { useWindowClose } from './useWindowClose';
import { useRuntimeUpdates } from './useRuntimeUpdates';
import { AppUpdateDialog } from './AppUpdateDialog';
import { VisionSupportDialog } from './pages/VisionSupportDialog';
import { ConfigurationList } from './pages/ConfigurationList';
import { ConfigurationDeletionDialog } from './pages/ConfigurationDeletionDialog';
import { RunningServicesPanel } from './pages/RunningServicesPanel';
import { manageRunningService } from './runningServiceManagement';
import { automaticallyManageService, selectAutomaticService } from './autoRunningServiceConnection';
import { Dropdown, Segmented, Toggle } from './OfficialControls';
import { useDraftGuard, type SaveDraft } from './useDraftGuard';
import { createLatestStoreWriter, type LatestStoreWriter } from './storeWriteQueue.mjs';
import { abortableRead } from './abortableRead';
import { GuideResume, OnboardingPage } from './onboarding/OnboardingPage';
import { ONBOARDING_KEY, deriveGuide, effectiveStatus, newProgress, normalizeProgress, type OnboardingProgress } from './onboarding/onboardingModel';

function useStoredValue(writer: LatestStoreWriter, key: string, value: unknown, enabled: boolean, onError: (error: unknown) => void) {
  useEffect(() => { if (!enabled) return; writer.stage(key, value); void writer.flush(key).catch(onError); }, [writer, key, value, enabled, onError]);
}

type Page = 'guide' | 'overview' | 'profiles' | 'models' | 'catalog' | 'tuning' | 'chat' | 'monitoring' | 'benchmark' | 'usage' | 'requests' | 'tasks' | 'environment' | 'settings' | 'monitor-settings' | 'chat-defaults' | 'connections' | 'runtime-tools' | 'updates' | 'about' | 'config';
const navigation: { id: Page; icon: typeof Activity; group: 'navDaily' | 'navModels' | 'navApplication' }[] = [
  { id: 'overview', icon: LayoutDashboard, group: 'navDaily' },
  { id: 'chat', icon: MessageSquare, group: 'navDaily' },
  { id: 'monitoring', icon: Activity, group: 'navDaily' },
  { id: 'benchmark', icon: Gauge, group: 'navDaily' },
  { id: 'models', icon: HardDrive, group: 'navModels' },
  { id: 'environment', icon: Server, group: 'navModels' },
  { id: 'tuning', icon: SlidersHorizontal, group: 'navModels' },
  { id: 'tasks', icon: Terminal, group: 'navModels' },
  { id: 'settings', icon: Settings2, group: 'navApplication' },
];
const routePage=(hash:string):Page=>{const value=hash.slice(1);return value==='localSetup'?'models':value==='monitor'?'monitoring':([...navigation.map(item=>item.id),'guide','profiles','catalog','benchmark','usage','requests','tasks','environment','monitor-settings','chat-defaults','connections','runtime-tools','updates','about','config'] as string[]).includes(value)?value as Page:'overview';};
const parentPage=(page:Page):Page=>['profiles','catalog','config'].includes(page)?'models':['usage','requests'].includes(page)?'monitoring':['about','updates','monitor-settings','chat-defaults','connections','runtime-tools'].includes(page)?'settings':page;
const defaults: AppSettings = { language: core.matchAppLanguage(navigator.language), languagePreference: 'system', theme: 'system', closeToTray: true, skipExitConfirmation: false, pollInterval: 3000, autoCheckUpdates: true };

const defaultOptions: ChatOptions = officialSamplingDefaults;
const id = () => crypto.randomUUID();
const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const number = (value: number | null | undefined, digits = 1) => value == null ? '—' : value.toLocaleString(i18n.language, { maximumFractionDigits: digits });
const bytes = (value: number | null | undefined) => value == null ? '—' : value >= 1024 ** 3 ? `${number(value / 1024 ** 3)} GB` : value >= 1024 ** 2 ? `${number(value / 1024 ** 2)} MB` : `${number(value / 1024)} KB`;
const downloadMarkdown = (name: string, content: string) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
const markdownFileName = (title: string) => {
  const clean = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[ .]+$/g, '').trim() || 'conversation';
  return `${/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(clean) ? '_' : ''}${clean}.md`;
};
type Recipe = { kind: 'setup'; profile: ServiceProfile; model: string; quant: string; context: number; images: boolean; options?: core.OfficialSetupOptions } | { kind: 'orca'; profile: ServiceProfile; request: core.OrcaImportRequest; options?: core.OfficialSetupOptions } | { kind: 'install'; directory: string } | { kind: 'update'; profile: ServiceProfile };
type Modal = { kind: 'profile'; profile?: ServiceProfile } | { kind: 'modelProfiles'; models: core.LocalModel[]; runtime: ServiceProfile } | { kind: 'rename'; conversation: Conversation } | { kind: 'deleteConversation'; conversation: Conversation } | { kind: 'request'; value: unknown } | { kind: 'options' } | { kind: 'vision'; profile: ServiceProfile } | { kind: 'deleteConfiguration'; profile: ServiceProfile } | null;

export function App() {
  const { t: translate } = useTranslation();
  const t = useCallback((key: TextKey) => translate(key), [translate]);
  const [storeWriter] = useState(() => createLatestStoreWriter(core.saveStore));
  const storeErrorTime = useRef(0);
  const desktop = core.isDesktop();
  const appVersion = useAppVersion(desktop);
  const query = useQueryClient();
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState('');
  const [bootAttempt, setBootAttempt] = useState(0);
  const [page, setPage] = useState<Page>(()=>!location.hash && new URLSearchParams(location.search).has('q') ? 'chat' : routePage(location.hash));
  const [sidebarCollapsed,setSidebarCollapsed]=useState(false);
  const [profiles, setProfiles] = useState<ServiceProfile[]>([]);
  const [updateOwner, setUpdateOwner] = useState<'app' | 'runtime' | null>(null);
  const updateOwnerRef = useRef<'app' | 'runtime' | null>(null);
  const openStrataUpdates = useRef<() => void>(() => {});
  const [modelDirectories, setModelDirectories] = useState<string[]>([]);
  const [activeId, setActiveId] = useState('');
  const [configProfileId, setConfigProfileId] = useState('');
  const [discoveredConfigProfile, setDiscoveredConfigProfile] = useState<ServiceProfile>();
  const [configurationDirty, setConfigurationDirty] = useState(false);
  const [connectionProfileId, setConnectionProfileId] = useState('');
  const [connectionDirty, setConnectionDirty] = useState(false);
  const [downloadConfigurationDirty, setDownloadConfigurationDirty] = useState(false);
  const [apiIntegrationOpen, setApiIntegrationOpen] = useState(false);
  const [connectionOwnershipRevision, setConnectionOwnershipRevision] = useState(0);
  const [settings, setSettings] = useState<AppSettings>(defaults);
  const [systemLanguage, setSystemLanguage] = useState<core.SystemLanguage>({locales:[...navigator.languages]});
  const [showLanguageSetup, setShowLanguageSetup] = useState(false);
  const latestSettings = useRef(settings); latestSettings.current = settings;
  const [monitorModeStatus, setMonitorModeStatus] = useState<MonitorModeStatus>();
  const monitorModeRevision = useRef(0);
  const monitorSettingsChange = useRef<(patch: Partial<core.FloatingMonitorPreferences>) => void>(() => {});
  const configurationSave = useRef<SaveDraft | undefined>(undefined);
  const registerConfigurationSave = useCallback((save: SaveDraft | undefined) => { configurationSave.current = save; }, []);
  const connectionSave = useRef<SaveDraft | undefined>(undefined);
  const registerConnectionSave = useCallback((save: SaveDraft | undefined) => { connectionSave.current = save; }, []);
  const downloadConfigurationSave = useRef<SaveDraft | undefined>(undefined);
  const registerDownloadConfigurationSave = useCallback((save: SaveDraft | undefined) => { downloadConfigurationSave.current = save; }, []);
  const hasNavigationDraft = page === 'config' && configurationDirty || page === 'connections' && connectionDirty || page === 'catalog' && downloadConfigurationDirty;
  const navigationGuard = useDraftGuard(hasNavigationDraft, async () => await (page === 'connections' ? connectionSave.current : page === 'catalog' ? downloadConfigurationSave.current : configurationSave.current)?.() ?? false, settings.language);
  const navigationDirty = useRef(false); navigationDirty.current = hasNavigationDraft;
  const acceptedNavigation = useRef({ page, url: location.href, index: Number(history.state?.strataNavigationIndex ?? 0) });
  const restoringHistory = useRef(false);
  const replayHistory = useRef(false);
  const afterHistoryRestore = useRef<(() => void) | undefined>(undefined);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState('');
  const [conversationIds,setConversationIds]=useState<Record<string,string>>({});
  const [profileOptions, setProfileOptions] = useState<Record<string, ChatOptions>>({});
  const [commonChatDefaults, setCommonChatDefaults] = useState<core.CommonChatDefaults>({...core.DEFAULT_COMMON_CHAT_DEFAULTS});
  const [chatDefaultsInheritance, setChatDefaultsInheritance] = useState<Record<string, boolean>>({});
  const [chatPreferences, setChatPreferences] = useState<ChatPreferences>(defaultChatPreferences);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [showAllRequests, setShowAllRequests] = useState(false);
  const [recipes, setRecipes] = useState<Record<string, Recipe>>({});
  const observedTasks = useRef<Map<string, TaskStatus['state']> | null>(null);
  const [preparationRuntime, setPreparationRuntime] = useState<ServiceProfile | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState('');
  const [localProgress, setLocalProgress] = useState<LocalSetupProgress>();
  const [startupTarget, setStartupTarget] = useState<ServiceProfile>();
  const [startupStartedAt, setStartupStartedAt] = useState(0);
  const [startupFailure, setStartupFailure] = useState<core.StartupFailureDiagnostic>();
  const [resolvedStartupFailures, setResolvedStartupFailures] = useState<Record<string,number>>({});
  const [lastUsedId, setLastUsedId] = useState('');
  const [guideProgress, setGuideProgress] = useState<OnboardingProgress | null>(null);
  const [guideLoaded, setGuideLoaded] = useState(false);
  const guideAutoOpened = useRef(false);
  const pendingGuideSend = useRef(false);
  const preparingLocal = useRef(false);
  const preparationGeneration = useRef(0);
  const maySelectFirstPrepared = useRef(false);
  const exporting = useRef(false);
  const [toast, setToast] = useState<{ text: string; error?: boolean; taskId?: string } | null>(null);
  const windowClose = useWindowClose({ desktop, ready, settings, onSettings: setSettings, beforeExit: navigationGuard.request,
    saveSettings: next => { storeWriter.stage('settings', next); return storeWriter.flush('settings'); },
    flushStores: () => { if (ready) storeWriter.stage('conversations', conversationsRef.current); return storeWriter.flushAll(); },
    onError: error => setToast({ text: core.normalizeError(error).message, error: true }) });
  const [draft, setDraft] = useState(()=>new URLSearchParams(location.search).get('q')??'');
  const initialPromptPending=useRef(new URLSearchParams(location.search).has('q'));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [quickBenchmarkRequest, setQuickBenchmarkRequest] = useState(0);
  const openFloatingSettings = useRef(false);
  const subnavigationRef = useRef<HTMLElement>(null);
  const inferenceBusy = streaming || benchmarkRunning;
  const [logSearch, setLogSearch] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [logServiceId, setLogServiceId] = useState('');
  const abort = useRef<AbortController | null>(null);
  const conversationsRef = useRef(conversations); conversationsRef.current = conversations;
  const profile = profiles.find(item => item.id === activeId);
  const configProfile = discoveredConfigProfile ?? profiles.find(item => item.id === configProfileId) ?? profile;
  const connectionProfile = profiles.find(item => item.id === connectionProfileId) ?? profile ?? profiles[0];
  useEffect(() => { if (page==='connections' && !connectionProfileId && connectionProfile) setConnectionProfileId(connectionProfile.id); }, [page, connectionProfileId, connectionProfile?.id]);
  const logService = logServiceId ? profiles.find(item => item.id === logServiceId) : profile;
  const logProfile = selectedTaskId ? undefined : logService;
  const conversation = conversations.find(item => item.id === conversationId);
  const inheritsCommon = core.usesCommonChatDefaults(profileOptions[activeId], chatDefaultsInheritance[activeId]);
  const options = core.resolveCommonChatOptions(defaultOptions, commonChatDefaults, profileOptions[activeId], chatDefaultsInheritance[activeId]);
  const setOptions = (next: ChatOptions) => {
    const commonChanged = (Object.keys(core.DEFAULT_COMMON_CHAT_DEFAULTS) as (keyof core.CommonChatDefaults)[]).some(key => next[key] !== options[key]);
    setProfileOptions(old => ({ ...old, [activeId]: core.prepareModelChatOptionsForSave(next, old[activeId], inheritsCommon && !commonChanged) }));
    setChatDefaultsInheritance(old => ({...old, [activeId]: commonChanged ? false : inheritsCommon}));
  };
  const changeChatInheritance = (inherit: boolean) => {
    if (!profile) return;
    if (!inherit && !profileOptions[activeId]) setProfileOptions(old => ({...old, [activeId]: options}));
    setChatDefaultsInheritance(old => ({...old, [activeId]: inherit}));
  };
  const serviceState = useCallback((state: string) => {
    const keys: Record<string, TextKey> = { idle: 'idleState', reading: 'readingState', prefill: 'readingState', generating: 'generatingState', loading: 'loadingState', unloading: 'unloadingState', unloaded: 'notLoaded', running: 'running', pending: 'pendingState', completed: 'completed', done: 'completed', writing: 'generatingState', cancelled: 'cancelled', skipped: 'skippedState', failed: 'failed', error: 'error', unknown: 'unknown', queued: 'queuedState', disconnected: 'disconnectedState', preparing: 'preparingState' };
    return keys[state] ? t(keys[state]!) : state;
  }, [t]);

  const errorText = (error: unknown): string => {
    const data = object(error), status = data.status ?? data.statusCode;
    const raw = error instanceof Error ? error.message : String(error);
    const code = data.code;
    if (code === 'DESKTOP_REQUIRED') return t('nativeRequired');
    if (status === 401 || /HTTP 401/.test(raw)) return `${t('authHint')} (${raw})`;
    if (status === 409 || /HTTP 409/.test(raw)) return `${t('busyHint')} (${raw})`;
    if (status === 404 || /HTTP 404/.test(raw)) return `${t('unsupportedHint')} (${raw})`;
    if (/fetch|network|connect|offline/i.test(raw)) return `${t('connectionHint')} (${raw})`;
    return raw;
  };
  const notify = (text: string, error = false) => setToast({ text, error });
  const copy = useCallback(async (content: string) => { try { await navigator.clipboard.writeText(content); setToast({ text: t('copied') }); return true; } catch { setToast({ text: t('clipboardUnavailable'), error: true }); return false; } }, [t]);
  const reportStoreError = useCallback((error: unknown) => {
    if (Date.now() - storeErrorTime.current < 5000) return;
    storeErrorTime.current = Date.now(); setToast({ text: core.normalizeError(error).message, error: true });
  }, []);
  const act = async (key: string, fn: () => Promise<unknown>, success?: TextKey) => {
    if (busy) return;
    setBusy(key);
    try { const result = await fn(); if (success) notify(t(success)); await query.invalidateQueries(); return result; }
    catch (error) { notify(errorText(error), true); return undefined; }
    finally { setBusy(''); }
  };
  useEffect(() => {
    let mounted = true;
    setBootError('');
    void Promise.all([desktop ? core.localInstallations() : core.loadStore<ServiceProfile[]>('profiles', []), core.loadStore<AppSettings | null>('settings', null), core.loadStore<Conversation[]>('conversations', []), core.loadStore<string>('activeProfile', ''), core.loadStore<Record<string, ChatOptions>>('chatOptionsByProfile', {}), core.loadStore<Record<string, Recipe>>('taskRecipes', {}), core.loadStore<ChatPreferences>('chatPreferences', defaultChatPreferences),core.loadStore<Record<string,string>>('activeConversationIds',{}),core.loadStore<boolean>('sidebarCollapsed',false),core.loadStore<string[]>('modelDiscoveryDirectories',[]),core.loadStore<unknown>('commonChatDefaults',core.DEFAULT_COMMON_CHAT_DEFAULTS),core.loadStore<Record<string,boolean>>('chatDefaultsInheritance',{}), core.getSystemLanguage().catch(()=>({locales:[...navigator.languages]} as core.SystemLanguage))]).then(async ([p, s, c, a, o, r, ui, ids, collapsed, directories, common, inheritance, detectedLanguage]) => {
      const restored = desktop ? await core.restoreServiceSelection(p, a, item => core.serviceStatus(item.id, item), () => core.discoverLocal(directories.length ? directories : undefined)) : undefined;
      if (!mounted) return;
      const restoredSettings: AppSettings = {...defaults, ...s, ...core.resolveLanguageSettings(s, detectedLanguage.locales, detectedLanguage.installerLanguage), floatingMonitor: {...s?.floatingMonitor, ...normalizeFloatingMonitorPreferences(s?.floatingMonitor)}};
      setSystemLanguage(detectedLanguage);
      setShowLanguageSetup(s === null);
      storeWriter.seed('conversations', c);
      const selectedProfile = restored?.selectedId ?? (p.some(x => x.id === a) ? a : p[0]?.id ?? '');

      maySelectFirstPrepared.current = p.length === 0; setSidebarCollapsed(collapsed); setModelDirectories(directories); setProfiles(p); setSettings(restoredSettings); setConversations(c); setActiveId(selectedProfile); setConnectionProfileId(selectedProfile); setCommonChatDefaults(core.normalizeCommonChatDefaults(common)); setChatDefaultsInheritance(Object.fromEntries(Object.entries(inheritance??{}).filter(([,value])=>typeof value==='boolean'))); setProfileOptions(o); setRecipes(r);setConversationIds(ids);setConversationId(c.find(x=>x.id===ids[selectedProfile]&&x.profileId===selectedProfile)?.id??c.find(x=>x.profileId===selectedProfile)?.id??''); setChatPreferences({ ...defaultChatPreferences, ...ui }); setPreferencesReady(true); setReady(true);
      if (desktop) void core.applySettings(restoredSettings).catch(error => notify(errorText(error), true));
    }).catch(error => { if (mounted) setBootError(errorText(error)); });
    return () => { mounted = false; abort.current?.abort(); };
  }, [bootAttempt]);
  useEffect(() => { if (ready && profiles.length) maySelectFirstPrepared.current = false; }, [ready, profiles.length]);
  useEffect(() => { if (ready) void core.loadStore<string>('lastUsedLocalInstallation', '').then(setLastUsedId); }, [ready]);
  useEffect(() => { if (!ready) return; void core.loadStore<unknown>(ONBOARDING_KEY, null).then(value => setGuideProgress(normalizeProgress(value))).catch(reportStoreError).finally(() => setGuideLoaded(true)); }, [ready]);
  useEffect(() => { if (!desktop || !ready) return; let disposed=false;let unlisten: (() => void) | undefined; void import('@tauri-apps/api/event').then(({listen}) => listen<string>('tray-action-error', event => {if(!disposed)notify(event.payload, true);})).then(fn => {if(disposed)fn();else unlisten=fn;}).catch(error=>{if(!disposed)notify(errorText(error),true);}); return () => {disposed=true;unlisten?.();}; }, [desktop, ready]);
  useStoredValue(storeWriter, 'profiles', profiles, ready && !desktop, reportStoreError);
  useStoredValue(storeWriter, 'settings', settings, ready && !showLanguageSetup, reportStoreError);
  useStoredValue(storeWriter, 'activeProfile', activeId, ready, reportStoreError);
  useStoredValue(storeWriter, 'chatOptionsByProfile', profileOptions, ready, reportStoreError);
  useStoredValue(storeWriter, 'commonChatDefaults', commonChatDefaults, ready, reportStoreError);
  useStoredValue(storeWriter, 'chatDefaultsInheritance', chatDefaultsInheritance, ready, reportStoreError);
  useStoredValue(storeWriter, 'taskRecipes', recipes, ready, reportStoreError);
  useStoredValue(storeWriter, 'activeConversationIds', conversationIds, ready, reportStoreError);
  useStoredValue(storeWriter, 'sidebarCollapsed', sidebarCollapsed, ready, reportStoreError);
  useStoredValue(storeWriter, 'modelDiscoveryDirectories', modelDirectories, ready, reportStoreError);
  useStoredValue(storeWriter, 'chatPreferences', chatPreferences, preferencesReady, reportStoreError);
  useStoredValue(storeWriter, ONBOARDING_KEY, guideProgress, ready && guideLoaded && guideProgress !== null, reportStoreError);
  useEffect(() => { if (!ready) return; storeWriter.stage('conversations', conversations); if (!streaming) void storeWriter.flush('conversations').catch(reportStoreError); }, [storeWriter, ready, conversations, streaming, reportStoreError]);
  useEffect(()=>{if(ready)setConversationId(conversations.find(c=>c.id===conversationIds[activeId]&&c.profileId===activeId)?.id??conversations.find(c=>c.profileId===activeId)?.id??'');},[ready,activeId]);
  useEffect(() => { if (!ready) return; const timer = setInterval(() => { void storeWriter.flushAll().catch(reportStoreError); }, 1000); return () => { clearInterval(timer); void storeWriter.flushAll().catch(reportStoreError); }; }, [storeWriter, ready, reportStoreError]);
  useEffect(() => { void i18n.changeLanguage(settings.language); document.documentElement.lang = settings.language; const media = matchMedia('(prefers-color-scheme: dark)'); const apply = () => { document.documentElement.dataset.theme = settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : settings.theme; }; apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply); }, [settings.language, settings.theme]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), toast.error ? 10000 : 4500); return () => clearTimeout(timer); }, [toast]);


  const process = useQuery({ queryKey: ['process', activeId, profile?.baseUrl, profile?.configPath, profile?.pythonPath, profile?.managed], queryFn: () => core.serviceStatus(activeId, profile), enabled: desktop && !!profile, refetchInterval: Math.max(10000,settings.pollInterval), refetchOnWindowFocus: false });
  // A failed native read leaves query data cached; that cache cannot establish ownership.
  const processUnverified = desktop && process.isError;
  const processStatus = processUnverified ? undefined : process.data;
  const serviceRunning = !desktop || processStatus?.running === true;
  const health = useQuery({ queryKey: ['health', activeId, profile?.baseUrl, processStatus?.pid, processStatus?.creationTime ?? processStatus?.startedAt], queryFn: () => core.request(profile!, '/health'), enabled: ready && !!profile && serviceRunning, refetchInterval: settings.pollInterval });
  const online = serviceRunning && health.isSuccess;
  const healthData = online ? object(health.data) : {};
  const connecting = !!localProgress || serviceRunning && health.isLoading;
  const serviceStopped = desktop && !!profile && processStatus?.running === false && !localProgress;
  const loaded = online && healthData.loaded === true;
  const supportsImages = online && healthData.images === true;
  const chatReady = online && (!desktop || (loaded && processStatus?.owned === true && processStatus?.running === true && !localProgress));
  const metrics = useQuery({ queryKey: ['metrics', activeId, profile?.baseUrl, showAllRequests, processStatus?.pid, processStatus?.creationTime ?? processStatus?.startedAt], queryFn: async () => core.normalizeMetrics(await core.request(profile!, `/metrics${showAllRequests ? '?requests=all' : ''}`)), enabled: !!profile && online, refetchInterval: settings.pollInterval });
  // Health can recover with the same PID while metrics still contain a pre-outage reply.
  // Refetching alone keeps successful values; only actual failures advance this boundary.
  const metricsFailureBoundary = Math.max(health.errorUpdatedAt, metrics.errorUpdatedAt, desktop ? process.errorUpdatedAt : 0);
  const metricsUnavailable = metrics.isError || (!!metrics.data && metrics.dataUpdatedAt <= metricsFailureBoundary);
  const metric = core.modelTelemetry(online && !metricsUnavailable ? metrics.data : undefined, typeof healthData.loaded === 'boolean' ? healthData.loaded : undefined);
  const projection = object(metric?.raw.engine).cvec;
  const hasProjection = !!projection && projection !== '0';
  const mcpQuery = useQuery({ queryKey: ['mcp', activeId, profile?.baseUrl], queryFn: () => core.request(profile!, '/mcp'), enabled: !!profile && online && (page === 'monitoring' || page === 'chat' || modal?.kind === 'options'), refetchInterval: settings.pollInterval });
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: core.listTasks, enabled: desktop && ready, refetchInterval: settings.pollInterval, refetchIntervalInBackground: true });
  const handoffs = useQuery({ queryKey: ['setupHandoffs'], queryFn: core.listSetupHandoffs, enabled: desktop && ready, refetchInterval: settings.pollInterval, refetchIntervalInBackground: true });
  const registeredSetupTasks = handoffs.data?.filter(item => item.status === 'registered').map(item => item.taskId).sort().join(',') ?? '';
  const finishedRuntimeUpdates = tasks.data?.filter(task => task.kind.includes('update') && task.state !== 'running').map(task => `${task.id}:${task.state}`).sort().join(',') ?? '';
  const preparedProfiles = useQuery({ queryKey: ['setupRegistrations', registeredSetupTasks, finishedRuntimeUpdates], queryFn: core.localInstallations, enabled: desktop && ready, refetchOnWindowFocus: false });
  const refreshLocalProfiles = async () => {
    if (!desktop) return profiles;
    const refreshed = await preparedProfiles.refetch({ throwOnError: true });
    if (refreshed.data) setProfiles(refreshed.data);
    return refreshed.data ?? [];
  };
  useEffect(() => {
    if (!ready || !preparedProfiles.data) return;
    let disposed = false;
    const firstPrepared = maySelectFirstPrepared.current ? preparedProfiles.data.find(item => handoffs.data?.some(handoff => handoff.status === 'registered' && handoff.profileId === item.id)) : undefined;
    if (preparedProfiles.data.length) maySelectFirstPrepared.current = false;
    setProfiles(preparedProfiles.data);
    if (firstPrepared) setActiveId(current => current || firstPrepared.id);
    void core.restoreServiceSelection(preparedProfiles.data, activeId, selected => core.serviceStatus(selected.id, selected)).then(selection => {
      if (disposed || selection.runningOwnedIds.length !== 1 || !selection.selectedId) return;
      setActiveId(selection.selectedId);
    }).catch(error => { if (!disposed) notify(errorText(error), true); });
    return () => { disposed = true; };
  }, [ready, preparedProfiles.data, activeId]);
  const discoveredCandidates = useQuery({ queryKey: ['discovered-local-models', modelDirectories.join('|')], queryFn: () => core.discoverLocal(modelDirectories.length ? modelDirectories : undefined), enabled: desktop && ready, staleTime: 30000, refetchInterval: ['overview', 'models', 'profiles', 'environment', 'guide'].includes(page) ? 30000 : false, refetchOnWindowFocus: false });
  const supervisor = useQuery({ queryKey: ['supervisor'], queryFn: core.supervisorStatus, enabled: desktop && ready, refetchInterval: 10000, refetchOnWindowFocus: false });
  const observedSupervisorSelection = useRef({ signature: '', uiProfileId: activeId });
  const supervisorSelectedId = supervisor.data?.activeLocalInstallation;
  const supervisorSelectionSignature = supervisorSelectedId && supervisor.data?.pid != null ? `${supervisor.data.pid}:${supervisorSelectedId}` : '';
  const supervisorSelectedProfileExists = !!supervisorSelectedId && profiles.some(item => item.id === supervisorSelectedId);
  useEffect(() => {
    const observed = observedSupervisorSelection.current;
    if (observed.uiProfileId !== activeId) {
      // A GUI selection takes priority over the currently cached backend snapshot.
      // Consume that snapshot once so becoming idle cannot replay it over the GUI choice.
      observed.uiProfileId = activeId;
      observed.signature = supervisorSelectionSignature;
      return;
    }
    if (!desktop || !ready || busy || inferenceBusy || localProgress || supervisor.data?.running !== true
      || (supervisor.data?.activeServices ?? 0) <= 0 || !supervisorSelectedProfileExists || !supervisorSelectedId
      || !supervisorSelectionSignature || observed.signature === supervisorSelectionSignature) return;
    observed.signature = supervisorSelectionSignature;
    setActiveId(current => current === activeId ? supervisorSelectedId : current);
  }, [desktop, ready, busy, inferenceBusy, !!localProgress, activeId, supervisor.data?.running, supervisor.data?.activeServices, supervisorSelectionSignature, supervisorSelectedId, supervisorSelectedProfileExists]);
  const backgroundTuning = useQuery({ queryKey: ['automatic-update-tuning', profiles.map(item => item.id).join(',')], queryFn: () => Promise.all(profiles.map(item => core.tuningStatus(item.id))), enabled: desktop && ready, refetchInterval: 10000, refetchOnWindowFocus: false });
  const backgroundHealth = Object.values(supervisor.data?.health ?? {}).filter(item => item.pid !== null && item.phase !== 'stopped');
  const unobservedRunningService = discoveredCandidates.data?.some(candidate => candidate.running === true && !profiles.some(saved =>
    core.configurationPathKey(saved.configPath, saved.installDir) === core.configurationPathKey(candidate.configPath, candidate.installDir)
    && supervisor.data?.health?.[saved.id]?.pid != null && supervisor.data.health[saved.id]?.phase !== 'stopped'));
  const automaticUpdatesIdle = (!desktop || discoveredCandidates.isSuccess && !unobservedRunningService) && !inferenceBusy && !busy && !localProgress && !modal && !!tasks.data && !tasks.data.some(task => task.state === 'running') && !!supervisor.data && (supervisor.data.activeServices === 0 || backgroundHealth.length >= supervisor.data.activeServices && backgroundHealth.every(item => item.observerState === 'idle' && item.activeRequests === 0 && Date.now() - item.checkedAt < 20000)) && !!backgroundTuning.data && !backgroundTuning.data.some(job => job && ['checking', 'running', 'canceling', 'applying', 'rollingBack'].includes(job.state));
  const updateGate = (owner: 'app' | 'runtime') => ({
    acquire: () => { if (updateOwnerRef.current) return false; updateOwnerRef.current=owner; setUpdateOwner(owner); return true; },
    release: () => { if (updateOwnerRef.current===owner) { updateOwnerRef.current=null; setUpdateOwner(null); } },
  });
  const appUpdates = useAppUpdates(desktop, settings.autoCheckUpdates !== false, ready, automaticUpdatesIdle && updateOwner !== 'runtime', updateGate('app'));
  const runtimeUpdates = useRuntimeUpdates(desktop, ready, settings.autoCheckUpdates !== false, automaticUpdatesIdle && updateOwner !== 'app' && !appUpdates.dialogOpen && !['checking','downloading','installing'].includes(appUpdates.state.phase), tasks.data, settings.language, error => notify(errorText(error), true), updateGate('runtime'), () => openStrataUpdates.current());
  const installationDetails = useQuery({ queryKey: ['localInstallationDetails', profiles.map(p => p.id).join(',')], queryFn: core.localInstallationDetails, enabled: desktop && ready, staleTime: 5000 });
  const startupLogs = useQuery({ queryKey: ['startupLogs', startupTarget?.id], queryFn: () => core.readLogs(startupTarget!, 80), enabled: desktop && !!localProgress && !!startupTarget, refetchInterval: 1000, refetchIntervalInBackground: true, retry: false });
  useEffect(() => {
    if (!localProgress || localProgress.phase === 'loading') return;
    if (startupLogs.data?.some(log => log.timestamp >= startupStartedAt && log.message.includes('本机 API 已就绪，正在加载模型'))) setLocalProgress(old => old ? {...old,phase:'loading',message:undefined} : old);
  }, [startupLogs.data, startupStartedAt, localProgress?.phase]);
  useEffect(() => {
    if (!desktop || !ready || !tasks.data) return;
    const previous = observedTasks.current;
    observedTasks.current = new Map(tasks.data.map(task => [task.id, task.state]));
    if (!previous) return; // Saved terminal tasks establish the baseline without old notifications.
    const finished = tasks.data.filter(task => previous.get(task.id) === 'running' && task.state !== 'running');
    if (!finished.length) return;
    const refreshKeys = new Set(['localModels', 'environment', 'health', 'metrics', 'official-config', 'availableModels', 'process', 'logs', 'mcp']);
    if (finished.some(task => task.state === 'completed' && /setup|update|install/.test(task.kind))) {
      void query.invalidateQueries({ predicate: item => refreshKeys.has(String(item.queryKey[0])) });
    }
    const last = finished[finished.length - 1]!;
    setToast({
      text: finished.map(task => `${t(task.kind.includes('setup') ? 'setupTask' : task.kind.includes('install') ? 'installTask' : task.kind.includes('update') ? 'updateTask' : 'task')} · ${t(task.state === 'completed' ? 'completed' : task.state === 'cancelled' ? 'taskCancelled' : 'taskFailed')}${task.state === 'failed' ? `: ${task.message}` : ''}`).join(' · '),
      error: finished.some(task => task.state === 'failed'), taskId: finished.length === 1 ? last.id : undefined,
    });
  }, [desktop, ready, tasks.data, query]);
  const logs = useQuery({ queryKey: ['logs', selectedTaskId ? 'task' : 'service', selectedTaskId || logProfile?.id, logProfile?.configPath], queryFn: () => selectedTaskId ? core.readTaskLogs(selectedTaskId, 2000) : core.readLogs(logProfile!, 2000), enabled: desktop && (!!selectedTaskId || !!logProfile) && page === 'tasks', refetchInterval: settings.pollInterval });
  const guideStatus = effectiveStatus(guideProgress, profiles.length > 0);
  const guideActive = guideLoaded && guideStatus === 'active';
  const environment = useQuery({ queryKey: ['environment'], queryFn: core.environmentInfo, enabled: desktop && ready && (page === 'guide' || guideActive || page === 'environment' || page === 'models' || page === 'profiles' || page === 'catalog' || page === 'config'), staleTime: 30000 });
  const overviewRuntime = useQuery({ queryKey: ['runtime-installation'], queryFn: core.localRuntimeInstallation, enabled: desktop && ready && page === 'overview' && !profile, staleTime: 30000 });
  // Version labels and the current installation for model configuration lists.
  const versionRuntime = useQuery({ queryKey: ['runtime-installation'], queryFn: core.localRuntimeInstallation, enabled: desktop && ready && ['models', 'profiles', 'config'].includes(page), staleTime: 30000 });
  const detectedRuntimes = versionRuntime.data?.detectedRuntimes;
  const guideInstallRunning = !!tasks.data?.some(task => task.kind.includes('install') && task.state === 'running');
  const guideRuntime = useQuery({ queryKey: ['runtime-installation'], queryFn: core.localRuntimeInstallation, enabled: desktop && ready && (page === 'guide' || guideActive), staleTime: 5000, refetchInterval: page === 'guide' ? (guideInstallRunning ? 2000 : 15000) : false });
  const availableModels = useQuery({ queryKey: ['availableModels', activeId, profile?.baseUrl], queryFn: () => core.request(profile!, '/v1/models'), enabled: !!profile && online && page === 'chat' });
  const apiModels = Array.isArray(object(availableModels.data).data) ? (object(availableModels.data).data as unknown[]).map(x => String(object(x).id ?? '')).filter(Boolean) : [];

  const choose = async (directory: boolean): Promise<string | null> => {
    if (!desktop) return null;
    try { const { open } = await import('@tauri-apps/plugin-dialog'); const selected = await open({ directory, multiple: false }); return typeof selected === 'string' ? selected : null; } catch (error) { notify(errorText(error), true); return null; }
  };
  const saveFile = async (name: string, content: string) => {
    if (exporting.current) return;
    exporting.current = true;
    try {
      if (!desktop) { downloadMarkdown(name, content); notify(t('saved')); return; }
      const { save } = await import('@tauri-apps/plugin-dialog');
      const selected = await save({ defaultPath: name, filters: [{ name: 'Markdown', extensions: ['md'] }] });
      if (!selected) return;
      const path = /\.md$/i.test(selected) ? selected : `${selected}.md`;
      const saved = await core.saveMarkdown(path, content);
      notify(`${t('saved')}: ${saved}`);
    } catch (error) { notify(errorText(error), true); }
    finally { exporting.current = false; }
  };
  const navigate = (next: Page) => {
    const hash = `#${next === 'monitoring' ? 'monitor' : next}`;
    const index = acceptedNavigation.current.index + (location.hash === hash ? 0 : 1);
    if (location.hash !== hash) history.pushState({ ...history.state, strataNavigationIndex: index }, '', `${location.pathname}${location.search}${hash}`);
    acceptedNavigation.current = { page: next, url: location.href, index }; setPage(next);
  };
  const go = (next: Page) => { if (next !== page) navigationGuard.request(() => navigate(next)); };
  openStrataUpdates.current = () => go('environment');
  const monitorNavigation = useRef<(destination: MonitorDestination) => void>(() => {});
  monitorNavigation.current = destination => {
    if (destination === 'quickBenchmark') {
      if (!profile || !online || !loaded || inferenceBusy || busy || localProgress || tasks.data?.some(task => task.state === 'running') || backgroundTuning.data?.some(job => job && ['checking', 'running', 'canceling', 'applying', 'rollingBack'].includes(job.state)) || updateOwner !== null) {
        notify(settings.language === 'zh-CN' ? '模型未就绪或有任务运行，请空闲后再测速' : 'The model is not ready or is busy. Run the speed test when idle.', true);
        return;
      }
      navigationGuard.request(() => { navigate('benchmark'); setQuickBenchmarkRequest(value => value + 1); });
      return;
    }
    if (destination === 'settings') {
      openFloatingSettings.current = true;
      if (page === 'monitor-settings') { document.getElementById('settings-floating-monitor')?.scrollIntoView({ block: 'start' }); openFloatingSettings.current = false; }
      go('monitor-settings');
      return;
    }
    go(destination);
  };
  useEffect(() => {
    if (!desktop || !ready) return;
    let disposed = false, unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/event').then(({ listen }) => listen<MonitorDestination>('monitor-navigate', event => {
      if (!disposed && ['overview', 'chat', 'monitoring', 'usage', 'tasks', 'settings', 'quickBenchmark'].includes(event.payload)) monitorNavigation.current(event.payload);
    })).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(error => { if (!disposed) notify(errorText(error), true); });
    return () => { disposed = true; unlisten?.(); };
  }, [desktop, ready]);
  useEffect(() => {
    if (page === 'monitor-settings' && openFloatingSettings.current) {
      openFloatingSettings.current = false;
      document.getElementById('settings-floating-monitor')?.scrollIntoView({ block: 'start' });
    }
  }, [page]);
  useEffect(() => {
    subnavigationRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [page, ready, settings.language]);
  useEffect(() => {
    if (!desktop || !ready) return;
    let disposed = false, unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/event').then(({ listen }) => listen<boolean>('monitor-tray-preference', event => {
      if (!disposed && typeof event.payload === 'boolean') monitorSettingsChange.current({ showInTray: event.payload });
    })).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(error => { if (!disposed) notify(errorText(error), true); });
    return () => { disposed = true; unlisten?.(); };
  }, [desktop, ready]);
  useEffect(() => {
    if (!desktop || !ready) return;
    let disposed = false;
    const stops: (() => void)[] = [];
    const revision = monitorModeRevision.current;
    void readMonitorModeStatus().then(value => { if (!disposed && revision === monitorModeRevision.current) setMonitorModeStatus(value); }).catch(() => {});
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      for (const stop of await Promise.all([
        listen<Partial<core.FloatingMonitorPreferences>>('monitor-preferences-patch', event => { if (!disposed) monitorSettingsChange.current(event.payload); }),
        listen<MonitorModeStatus>('monitor-mode-status', event => {
          if (!disposed) {
            monitorModeRevision.current++;
            setMonitorModeStatus(event.payload);
            if (event.payload.visible === true || event.payload.active) monitorSettingsChange.current({ mode: event.payload.mode });
          }
        }),
      ])) { if (disposed) stop(); else stops.push(stop); }
    }).catch(error => { if (!disposed) notify(errorText(error), true); });
    return () => { disposed = true; for (const stop of stops) stop(); };
  }, [desktop, ready]);
  const appUpdateVersion = appUpdates.state.version && !['idle', 'current', 'installed'].includes(appUpdates.state.phase) ? appUpdates.state.version : undefined;
  const openAppUpdates = () => { if (appUpdateVersion) void appUpdates.openDialog(); else go('updates'); };
  const prepareImported = async (candidate: core.LocalCandidate, destination: Page = 'models') => {
    if (preparingLocal.current || inferenceBusy) throw new Error(t('busyHint'));
    // A detected private copy or its recorded source is already registered.
    // Reuse that record so choosing the current configuration cannot re-import/restart it.
    const candidatePath = core.configurationPathKey(candidate.configPath, candidate.installDir);
    const registered = profiles.find(item => core.configurationPathKey(item.configPath, item.installDir) === candidatePath
      || installationDetails.data?.some(detail => detail.profileId === item.id && detail.originalConfigPath
        && core.configurationPathKey(detail.originalConfigPath, item.installDir) === candidatePath));
    if (registered) { await activateLocal(registered); go(destination); return; }
    preparingLocal.current = true;
    const generation = ++preparationGeneration.current;
    setStartupStartedAt(Date.now());
    setLocalProgress({ phase: 'importing' });
    try {
      const imported = await core.importLocal(candidate);
      setProfiles(old => old.some(item => item.id === imported.id) ? old.map(item => item.id === imported.id ? imported : item) : [...old, imported]);
      setStartupTarget(imported);
      go(destination);
      setLocalProgress({ phase: 'starting' });
      await core.switchLocalService(imported.id);
      await refreshLocalProfiles();
      setActiveId(imported.id);
      setLastUsedId(activeId || imported.id); storeWriter.stage('lastUsedLocalInstallation', activeId || imported.id); void storeWriter.flush('lastUsedLocalInstallation').catch(reportStoreError);
      setPreparationRuntime(null);
      await query.invalidateQueries();
    } catch (error) {
      notify(errorText(error), true);
      throw error;
    } finally {
      if (generation === preparationGeneration.current) { preparingLocal.current = false; setLocalProgress(undefined); setStartupTarget(undefined); }
    }
  };
  const activateLocal = async (selected: ServiceProfile) => {
    if (!desktop) { setActiveId(selected.id); return; }
    if (inferenceBusy || preparingLocal.current) throw new Error(t('busyHint'));
    const existing = await core.serviceStatus(selected.id, selected);
    if (existing.owned && existing.running) {
      setStartupFailure(undefined);
      setActiveId(selected.id);
      await refreshLocalProfiles();
      await query.invalidateQueries();
      return;
    }
    const generation = ++preparationGeneration.current;
    preparingLocal.current = true;
    const attemptStartedAt = Date.now(); setStartupStartedAt(attemptStartedAt); setStartupTarget(selected); setStartupFailure(undefined);
    setLocalProgress({ phase: 'starting' });
    try {
      await core.switchLocalService(selected.id);
      await refreshLocalProfiles();
      setActiveId(selected.id);
      if(selected.id !== activeId){setLastUsedId(activeId || selected.id); storeWriter.stage('lastUsedLocalInstallation', activeId || selected.id); void storeWriter.flush('lastUsedLocalInstallation').catch(reportStoreError);}
      await query.invalidateQueries();
    } catch (error) {
      setStartupFailure(core.readStartupDiagnostic(error, selected.id, attemptStartedAt));
      void supervisor.refetch();
      throw error;
    } finally {
      if (generation === preparationGeneration.current) { preparingLocal.current = false; setLocalProgress(undefined); setStartupTarget(undefined); }
    }
  };
  useEffect(() => {
    history.replaceState({ ...history.state, strataNavigationIndex: acceptedNavigation.current.index }, '', location.href);
    const change = () => {
      const current = acceptedNavigation.current;
      if (restoringHistory.current) {
        if (location.href === current.url) { restoringHistory.current = false; const replay = afterHistoryRestore.current; afterHistoryRestore.current = undefined; replay?.(); }
        return;
      }
      const next = routePage(location.hash), url = location.href;
      const recordedIndex = history.state?.strataNavigationIndex;
      const knownIndex = Number.isSafeInteger(recordedIndex);
      const index = knownIndex ? Number(recordedIndex) : current.index + (navigationDirty.current ? 0 : 1);
      const accept = () => {
        if (!knownIndex) history.replaceState({ ...history.state, strataNavigationIndex: index }, '', url);
        acceptedNavigation.current = { page: next, url, index }; setPage(next);
      };
      if (replayHistory.current) { replayHistory.current = false; accept(); return; }
      if (next === current.page) { accept(); return; }
      if (!navigationDirty.current) { accept(); return; }
      const delta = knownIndex ? index - current.index : 0;
      if (!delta) {
        history.replaceState({ ...history.state, strataNavigationIndex: current.index }, '', current.url);
        navigationGuard.request(() => { history.replaceState(history.state, '', url); accept(); });
        return;
      }
      // Return to the existing accepted entry. Approval replays the original
      // Back/Forward transition; neither cancel nor approval pushes a new entry.
      restoringHistory.current = true; history.go(-delta);
      navigationGuard.request(() => {
        const replay = () => { replayHistory.current = true; history.go(delta); };
        if (restoringHistory.current) afterHistoryRestore.current = replay; else replay();
      });
    };
    window.addEventListener('hashchange', change); window.addEventListener('popstate', change);
    return () => { window.removeEventListener('hashchange', change); window.removeEventListener('popstate', change); };
  }, [navigationGuard.request]);
  const nativeTitle = desktop ? undefined : t('nativeRequired');
  const addConversation = () => {
    if (!profile || inferenceBusy) return;
    const item: Conversation = { id: id(), title: t('unnamed'), profileId: profile.id, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    setConversations(old => [item, ...old]); setConversationId(item.id);setConversationIds(old=>({...old,[profile.id]:item.id})); setDraft(''); setAttachments([]); go('chat');
  };
  const selectConversation = (item: Conversation) => {
    if (inferenceBusy || preparingLocal.current) return;
    const selected = profiles.find(p => p.id === item.profileId);
    if (!selected) { notify(t('noProfileHint'), true); return; }
    void (async () => {
      if (selected.id !== activeId) await activateLocal(selected);
      setConversationId(item.id);
      setConversationIds(old => ({ ...old, [item.profileId]: item.id }));
      setAttachments([]); setDraft(''); go('chat');
    })().catch(error => notify(errorText(error), true));
  };
  const updateMessage = (cid: string, mid: string, update: (message: ChatMessage) => ChatMessage) => setConversations(old => old.map(c => c.id === cid ? { ...c, updatedAt: Date.now(), messages: c.messages.map(m => m.id === mid ? update(m) : m) } : c));
  const send = async () => {
    if (!profile || !chatReady || inferenceBusy || (!draft.trim() && !attachments.length)) return;
    if (attachments.some(a => a.type === 'image') && !supportsImages) { notify(t('imageUnavailable'), true); return; }
    if (conversation && conversation.profileId !== profile.id) { notify(t('conversationOtherProfile'), true); return; }
    const user: ChatMessage = { id: id(), role: 'user', content: draft.trim(), attachments: [...attachments], createdAt: Date.now() };
    const assistant: ChatMessage = { id: id(), role: 'assistant', content: '', createdAt: Date.now(), execution: core.newChatExecution(id()) };
    const cid = conversation?.id ?? id();
    const previous = conversation?.messages ?? [];
    if (!conversation) {
      setConversations(old => [{ id: cid, profileId: profile.id, title: user.content.slice(0, 42) || user.attachments?.[0]?.name || t('unnamed'), messages: [user, assistant], createdAt: Date.now(), updatedAt: Date.now() }, ...old]);
      setConversationId(cid);setConversationIds(old=>({...old,[profile.id]:cid}));
    } else setConversations(old => old.map(c => c.id === cid ? { ...c, title: c.messages.length ? c.title : user.content.slice(0, 42) || t('unnamed'), messages: [...previous, user, assistant], updatedAt: Date.now() } : c));
    setDraft(''); setAttachments([]); setStreaming(true); const controller = new AbortController(); abort.current = controller;
    const started = performance.now(); let firstTokenMs: number | undefined; let thinkingStarted: number | undefined; let reasoningMs: number | undefined;
    try {
      const selectedModel = options.model.trim() || (typeof healthData.model === 'string' ? healthData.model.trim() : '') || apiModels[0] || '';
      const mcpServers = Array.isArray(mcpQuery.data?.servers) ? mcpQuery.data.servers.map(object) : [];
      const mcpAvailable = mcpServers.some(server => (server.status === 'ready' || server.status === 'stopped') && Array.isArray(server.tools) && server.tools.length > 0);
      const requestMessages = [...previous.filter(m => !m.error), user];
      const hasImages = requestMessages.some(message => message.attachments?.some(attachment => attachment.type === 'image'));
      const needsCapabilities = hasImages || !!options.fixedPrefix || Object.values(options.advanced ?? {}).some(value => value !== undefined && value !== 'text' && value !== '');
      let capabilities: core.ChatCapabilities | undefined;
      let requestImages = supportsImages;
      if (needsCapabilities) {
        const evidence = await abortableRead(core.readServiceCapabilities(profile), controller.signal);
        capabilities = core.chatCapabilitiesFromService(evidence);
        requestImages = core.serviceCapability(evidence, 'images').state === 'available';
      }
      const body = core.buildChatRequest(requestMessages, { ...options, capabilities, model: selectedModel, mcp: options.mcp && mcpAvailable, images: requestImages, experimentalSpeedProjection: hasProjection ? options.experimentalSpeedProjection !== false : undefined });
      const requestStartedAt = Date.now();
      updateMessage(cid,assistant.id,message=>({...message,execution:{...(message.execution??assistant.execution!),requestStartedAt}}));
      await core.streamChat(profile, body, delta => {
        if(delta.reasoning && thinkingStarted===undefined) thinkingStarted=performance.now();
        if(delta.content && firstTokenMs===undefined) {firstTokenMs=performance.now()-started;if(thinkingStarted!==undefined)reasoningMs=performance.now()-thinkingStarted;}
        updateMessage(cid, assistant.id, message => {
          const next = { ...message, content: message.content + (delta.content ?? ''), reasoning: (message.reasoning ?? '') + (delta.reasoning ?? ''), execution: core.advanceChatExecution(message.execution ?? assistant.execution!, delta) };
          if (delta.usage) next.usage = { ...message.usage, ...delta.usage };
          if (delta.error) next.error = delta.error;
          if (delta.tool) {
            const incoming = delta.tool as ToolEvent & { id?: string };
            const tools = [...(message.tools ?? [])];
            const index = incoming.id ? tools.findIndex(tool => (tool as ToolEvent & { id?: string }).id === incoming.id) : -1;
            if (index >= 0) tools[index] = { ...tools[index], ...incoming } as ToolEvent; else tools.push(incoming);
            next.tools = tools;
          }
          return next;
        });
      }, controller.signal);
    } catch (error) { if (!controller.signal.aborted) updateMessage(cid, assistant.id, message => ({ ...message, error: errorText(error) })); }
    finally { updateMessage(cid, assistant.id, message => ({ ...message, execution: core.finishChatExecution(message.execution ?? assistant.execution!, controller.signal.aborted, !!message.error), elapsedMs: performance.now() - started, firstTokenMs, reasoningMs: reasoningMs ?? (thinkingStarted===undefined ? undefined : performance.now()-thinkingStarted), stopped: controller.signal.aborted, tools: message.tools?.map(tool=>['writing','running'].includes(tool.status)?{...tool,status:'skipped'}:tool) })); setStreaming(false); abort.current = null; }
  };
  useEffect(()=>{if(page==='chat'&&pendingGuideSend.current&&profile&&chatReady&&conversation&&draft.trim()){pendingGuideSend.current=false;void send();}},[page,chatReady,conversation?.id,draft]);
  useEffect(()=>{if(ready&&profile&&chatReady&&initialPromptPending.current){initialPromptPending.current=false;const url=new URL(location.href);url.searchParams.delete('q');history.replaceState(null,'',`${url.pathname}${url.search}${url.hash}`);if(draft.trim())void send();}},[ready,profile?.id,chatReady]);
  const addFiles = async (list: File[]) => {
    const added: Attachment[] = [];
    for (const file of list) {
      if (file.size > 20e6) { notify(`${file.name}: ${t('attachmentTooLarge')}`, true); continue; }
      if (/^image\/(png|jpeg|webp|gif)$/i.test(file.type)) {
        if (!supportsImages) { notify(t('imageUnavailable'), true); continue; }
        const content = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
        added.push({ id: id(), name: file.name, type: 'image', mimeType: file.type, content });
      } else if (file.type.startsWith('text/') || /\.(txt|md|json|csv|tsv|xml|yaml|yml|py|js|ts|tsx|jsx|html|css|log|sql|sh|ps1|c|cpp|h|rs)$/i.test(file.name)) {
        if (file.size > 512 * 1024) { notify(`${file.name}: ${t('textAttachmentTooLarge')}`, true); continue; }
        added.push({ id: id(), name: file.name, type: 'text', mimeType: file.type || 'text/plain', content: await file.text() });
      }
      else notify(`${file.name}: ${t('attachmentUnsupported')}`, true);
    }
    setAttachments(old => [...old, ...added]);
  };
  const runRecipe = async (recipe: Recipe) => {
    const task = recipe.kind === 'setup' ? await core.runSetup(recipe.profile, recipe.model, recipe.quant, recipe.context, recipe.images, recipe.options) : recipe.kind === 'orca' ? await core.runOrcaImport(recipe.profile, recipe.request, recipe.options) : recipe.kind === 'install' ? await core.installRuntime(recipe.directory) : await core.updateRuntime(recipe.profile);
    observedTasks.current ??= new Map();
    observedTasks.current.set(task.id, task.state);
    setRecipes(old => ({ ...old, [task.id]: recipe })); return task;
  };
  const openConfigProfile = async (configPath: string, previous?: ServiceProfile, activate = true) => {
    const directory = previous?.installDir || configPath.slice(0, Math.max(configPath.lastIndexOf('\\'), configPath.lastIndexOf('/')));
    const found = await core.discoverLocal([directory]);
    const canonical = (value: string) => value.replace(/\\/g, '/').toLocaleLowerCase();
    const candidate = found.find(item => canonical(item.configPath) === canonical(configPath));
    if (!candidate) throw new Error(t('localSetupNothingFoundHint'));
    if (activate) await prepareImported(candidate);
    else {
      const imported = await core.importLocal(candidate);
      setProfiles(current => current.some(item => item.id === imported.id) ? current.map(item => item.id === imported.id ? imported : item) : [...current, imported]);
      await query.invalidateQueries();
      go('models');
    }
    setModal(null);
  };
  const selectPreparationRuntime = async (directory: string) => {
    try {
      const status = await core.localRuntimeInstallation();
      const known = [...profiles, ...(status.result ? [status.result.profile] : []), ...(status.detectedRuntimes ?? []).filter(item => item.readiness === 'ready').map(item => item.profile)];
      const runtime = known.find(item => core.configurationPathKey(item.installDir) === core.configurationPathKey(directory));
      if (!runtime) throw new Error(settings.language === 'zh-CN' ? '运行环境尚未识别，请在 Strata 页面重新检测。' : 'The runtime has not been recognized. Detect it again on the Strata page.');
      setPreparationRuntime({ ...runtime });
      go('catalog');
    } catch (error) { notify(errorText(error), true); }
  };
  const createTaskProfile = async (recipe: Recipe) => {
    const runtime: ServiceProfile = recipe.kind === 'install'
      ? { id: id(), name: 'Strata', baseUrl: 'http://127.0.0.1:8080', installDir: recipe.directory, configPath: '', pythonPath: '', managed: true }
      : recipe.profile;
    const models = await core.listLocalModels({ ...runtime, configPath: '' });
    if (!models.length) { selectPreparationRuntime(runtime.installDir); notify(t('prepareBeforeProfile')); return; }
    if (recipe.kind === 'setup' || recipe.kind === 'orca') {
      // setup.py FAMILIES.name determines model_name; verify it against actual discovered configs.
      const familyNames: Record<string, string> = { qwen: 'qwen3.8-flash-next', swift: 'swift-1.5', coder: 'qwen3.8-flash-next-coder', unsloth: 'qwen3.8-flash-next-unsloth', qwen36: 'qwen3.6-35b-a3b' };
      const expected = recipe.kind === 'orca' ? core.ORCA_MODEL_NAME : `${familyNames[recipe.model]}-${recipe.quant.toLowerCase()}`;
      const matches = models.filter(model => model.name.toLowerCase() === expected);
      if (matches.length === 1) { await openConfigProfile(matches[0]!.configPath, runtime); return; }
      setModal({ kind: 'modelProfiles', models, runtime });
      return;
    }
    if (models.length === 1) { await openConfigProfile(models[0]!.configPath, runtime); return; }
    setModal({ kind: 'modelProfiles', models, runtime });
  };
  const taskNextActions = (task: TaskStatus) => {
    const handoff = handoffs.data?.find(item => item.taskId === task.id);
    if (handoff) return <SetupHandoffActions handoff={handoff} canRecheck={task.state === 'completed'} disabled={!!busy || inferenceBusy || !!localProgress} onResolve={async path => { await core.resolveSetupHandoff(task.id, path); await query.invalidateQueries(); }} onUse={async profileId => { const registered = await core.localInstallations(); const selected = registered.find(item => item.id === profileId); if (!selected) throw new Error(t('noProfileHint')); setProfiles(registered); await activateLocal(selected); go('chat'); }} onView={() => go('profiles')} onError={error => notify(errorText(error), true)}/>;
    const recipe = recipes[task.id];
    if (task.state !== 'completed' || !recipe || recipe.kind === 'update') return null;
    return <>{recipe.kind === 'install' && <button className="st-btn st-btn--secondary" disabled={inferenceBusy} onClick={() => selectPreparationRuntime(recipe.directory)}>{t('prepareModels')}</button>}<button className="st-btn st-btn--secondary" disabled={!!busy || inferenceBusy || !!localProgress} onClick={() => void act('taskProfile', () => createTaskProfile(recipe))}>{t('usePreparedModel')}</button></>;
  };
  const diagnostics = () => { if (profile) void act('diagnostics', async () => { const path = await core.exportDiagnostics(profile); notify(`${t('diagnosticSaved')} ${path}`); }); };

  const ErrorBlock = ({ error }: { error: unknown }) => error ? <div className="notice error" role="alert">{errorText(error)}</div> : null;
  const NeedProfile = () => <Empty title={t('noProfile')}><button className="primary" onClick={() => go('models')}><FolderOpen size={16} />{t('myModels')}</button></Empty>;
  const stopManagedService = async (profileId: string) => {
    await query.cancelQueries({ queryKey: ['process', profileId] });
    let status: core.ProcessStatus;
    try { status = await core.stopService(profileId); }
    catch (error) { throw new Error(`${settings.language === 'zh-CN' ? '停止服务失败：' : 'Failed to stop the service: '}${errorText(error)}`); }
    if (status.running !== false) throw new Error(settings.language === 'zh-CN' ? '停止服务未完成：进程仍在运行，请重试。' : 'Stop did not complete: the process is still running. Please retry.');
    // The stop response is verified native state. Apply it before refreshing other queries,
    // and discard in-flight status replies that could repaint the old running process.
    query.setQueriesData<core.ProcessStatus>({ queryKey: ['process', profileId] }, status);
    await refreshLocalProfiles();
    return status;
  };
  const serviceActions = <div className="actions service-actions">
    {processStatus?.running !== true && <button className="primary" data-tooltip={!desktop ? nativeTitle : settings.language === 'zh-CN' ? '启动本机 API 并准备模型' : 'Start the local API and prepare the model'} disabled={!desktop || !profile?.managed || processUnverified || !!busy || !!localProgress} onClick={() => profile && void act('start', () => activateLocal(profile), 'success')}><Zap size={15} />{t('start')}</button>}
    {processStatus?.running === true && <button className="danger" data-tooltip={!desktop ? nativeTitle : settings.language === 'zh-CN' ? '停止本机 API 服务并释放模型内存，不删除模型文件' : 'Stop the local API and release model memory; model files are preserved'} disabled={!desktop || !profile?.managed || !!busy || !!localProgress || processStatus.owned !== true} onClick={() => void act('stop', () => stopManagedService(activeId), 'success')}><Square size={14} />{t('stop')}</button>}
    {online && healthData.loaded === false && <button data-tooltip={settings.language === 'zh-CN' ? '将已有模型载入内存和显存，供正在运行的 API 使用' : 'Load the existing model into RAM and VRAM for the running API'} disabled={!profile || !!busy || !!localProgress || (desktop && processStatus?.owned !== true)} onClick={() => profile && void act('load', () => core.request(profile, '/load', 'POST', {}), 'success')}><Upload size={15} />{t('load')}</button>}
    {loaded && <button data-tooltip={settings.language === 'zh-CN' ? '释放模型占用的内存和显存，保留 API 服务和模型文件；再次使用时可重新加载' : 'Release model RAM and VRAM, keeping the API and model files; load again when needed'} disabled={!profile || !!busy || !!localProgress || (desktop && processStatus?.owned !== true)} onClick={() => profile && void act('unload', () => core.request(profile, '/unload', 'POST', {}), 'success')}><Download size={15} />{t('unload')}</button>}
  </div>;

  const overviewStartup = desktop ? selectOverviewStartup(profiles, installationDetails.data, discoveredCandidates.data, lastUsedId) : undefined;
  const overviewModel = overviewStartup?.profile ?? overviewStartup?.candidate;
  const legacyOverviewRuntime = overviewRuntime.data?.result;
  const overviewRuntimes = overviewRuntime.data?.detectedRuntimes ?? (legacyOverviewRuntime?[{readiness:'ready' as const}]:[]);
  const hasOverviewRuntime = !!overviewModel || overviewRuntimes.length > 0 || !!discoveredCandidates.data?.length;
  const overviewNeedsRepair = hasOverviewRuntime && !overviewModel && !overviewRuntimes.some(runtime => runtime.readiness === 'ready');
  const overviewSetupError = discoveredCandidates.error ?? overviewRuntime.error ?? installationDetails.error;
  const overviewMock = overviewMockEnabled() ? buildOverviewMock() : null;
  const overviewProfile = overviewMock?.profile ?? profile;
  const overviewHealth = overviewMock ? (overviewMock.stopped ? {} : overviewMock.health) : healthData;
  const overviewMetric = overviewMock ? (overviewMock.stopped ? undefined : overviewMock.metric) : metric;
  const overviewProcess = overviewMock?.process ?? processStatus;
  const overviewTasks = overviewMock?.tasks ?? (tasks.data ?? []);
  const overviewOnline = overviewMock ? overviewMock.online : online;
  const overviewConnecting = overviewMock ? false : connecting;
  // D2 page visuals read the same live /metrics hardware block; DEV mock mode substitutes the overview mock so screenshots cover running/stopped states.
  const hardware = readHardware((overviewMock ? overviewMetric : metric)?.raw as Record<string, unknown> | undefined);
  const hardwareOnline = overviewMock ? overviewOnline : online;
  const overviewDesktop = overviewMock ? true : desktop;
  const overviewBackground = overviewMock?.backgroundHealth ?? (profile ? supervisor.data?.health?.[profile.id] : undefined);
  const updateGuide = (patch: Partial<OnboardingProgress>) => setGuideProgress(old => ({ ...(old ?? newProgress(Date.now())), ...patch, updatedAt: Date.now() }));
  const completeGuide = () => updateGuide({ status: 'completed', completedAt: Date.now() });
  const openGuide = () => { setGuideProgress(old => old && old.status !== 'active' ? { ...old, status: 'active', updatedAt: Date.now() } : old ?? newProgress(Date.now())); go('guide'); };
  const guide = deriveGuide({ progress: guideProgress, desktop, tasks: tasks.data ?? [], handoffs: handoffs.data ?? [], runtime: guideRuntime.data, runtimePending: guideRuntime.isPending,
    environment: environment.data, environmentFailed: environment.isError, profiles, candidates: discoveredCandidates.data ?? [], activeProfile: profile, online, loaded, starting: !!localProgress });
  useEffect(() => {
    // First run only: no stored guide record, nothing configured, nothing discovered yet → open the guide once.
    if (guideAutoOpened.current || !desktop || !ready || !guideLoaded || guideProgress || profiles.length || !discoveredCandidates.isSuccess) return;
    guideAutoOpened.current = true;
    if (page === 'overview' && !location.hash && !initialPromptPending.current) navigate('guide');
  }, [desktop, ready, guideLoaded, !!guideProgress, profiles.length, discoveredCandidates.isSuccess]);
  const startGuideChat = (text: string) => {
    if (!profile || inferenceBusy) return;
    const item: Conversation = { id: id(), title: t('unnamed'), profileId: profile.id, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    setConversations(old => [item, ...old]); setConversationId(item.id); setConversationIds(old => ({ ...old, [profile.id]: item.id })); setAttachments([]); setDraft(text);
    pendingGuideSend.current = true; completeGuide(); go('chat');
  };
  const renderGuidePage = () => <OnboardingPage language={settings.language} desktop={desktop} progress={guideProgress} guide={guide} onProgress={updateGuide}
    onRefreshRuntime={() => void guideRuntime.refetch()} environment={environment.data} environmentError={environment.error ? errorText(environment.error) : undefined} environmentLoading={environment.isFetching}
    onRecheckEnvironment={() => void environment.refetch()} memoryGB={machineMemoryGB(hardware, environment.data)} tasks={tasks.data ?? []} handoffs={handoffs.data ?? []} profiles={profiles}
    candidates={discoveredCandidates.data ?? []} candidatesLoading={discoveredCandidates.isFetching} activeProfile={profile} online={online} loaded={loaded} starting={!!localProgress}
    startupLogs={startupLogs.data ?? []} modelName={typeof healthData.model === 'string' ? healthData.model : undefined} busy={!!busy || inferenceBusy || !!localProgress}
    onPrepareModel={request => act('setup', () => runRecipe({ kind: 'setup', ...request }), 'modelPrepared') as Promise<TaskStatus | undefined>}
    onStart={async selected => { await activateLocal(selected); }}
    onLoad={async selected => { await core.request(selected, '/load', 'POST', {}); await query.invalidateQueries(); }}
    onConnectCandidate={async candidate => { if (candidate.running) await connectObservedService(candidate); else await prepareImported(candidate, 'guide'); }}
    onResolveHandoff={async (taskId, configPath) => { await core.resolveSetupHandoff(taskId, configPath); await query.invalidateQueries(); }}
    onRefreshProfiles={refreshLocalProfiles} onRescan={() => void discoveredCandidates.refetch()} onAddDirectory={addModelDirectory}
    onOpenCatalog={() => go('catalog')} onOpenConfig={selected => openModelConfig(selected)} onOpenTasks={() => { setSelectedTaskId(guide.setupTask?.id ?? guide.runtimeTask?.id ?? ''); go('tasks'); }}
    onOpenBenchmark={() => monitorNavigation.current('quickBenchmark')} onCopy={content => void copy(content)} onSendFirstMessage={startGuideChat}
    onFinish={() => { completeGuide(); go('overview'); }} onSkip={() => { updateGuide({ status: 'skipped' }); go('overview'); }} onLater={() => go('overview')} onError={error => notify(errorText(error), true)}/>;
  const renderOverviewPage=()=> <OverviewPage
    guideNotice={guideActive && desktop && !overviewMock ? <GuideResume plan={guide.plan} onResume={() => go('guide')}/> : undefined}
    onOpenGuide={!guideActive && desktop && !overviewMock ? openGuide : undefined}
    profile={overviewProfile} health={overviewHealth} backgroundHealth={overviewBackground} metric={overviewMetric} process={overviewProcess}
    tasks={overviewTasks} tasksLoading={overviewMock?false:tasks.isPending} language={settings.language} online={overviewOnline} connecting={overviewConnecting} desktop={overviewDesktop}
    healthError={overviewMock?undefined:(serviceRunning&&health.error?errorText(health.error):undefined)} metricsError={overviewMock?undefined:(online&&metrics.error?errorText(metrics.error):undefined)} taskError={overviewMock?undefined:(tasks.error?errorText(tasks.error):undefined)}
    processError={overviewMock?undefined:(process.error?errorText(process.error):loaded||localProgress?undefined:core.readableServiceError(supervisor.data?.preparationFailures?.find(item=>item.profileId===profile?.id)?.lastError))} loadingSince={overviewMock?undefined:(localProgress?startupStartedAt||undefined:undefined)}
    controls={overviewMock ? <div className="actions service-actions" aria-hidden="true">{overviewMock.stopped ? <button type="button" className="primary" tabIndex={-1}>{t('start')}</button> : <><button type="button" className="danger" tabIndex={-1}>{t('stop')}</button><button type="button" tabIndex={-1}>{t('unload')}</button></>}</div> : serviceActions}
    startupModel={overviewModel&&overviewStartup?{name:overviewModel.name,configPath:overviewModel.configPath,lastActivatedAt:overviewStartup.lastActivatedAt,onStart:()=>void act('overviewStart',async()=>{if(overviewStartup.profile)await activateLocal(overviewStartup.profile);else if(overviewStartup.candidate)await prepareImported(overviewStartup.candidate,'overview');},'success')}:undefined}
    hasRuntime={hasOverviewRuntime} runtimeNeedsRepair={overviewNeedsRepair} setupLoading={desktop&&(discoveredCandidates.isPending||overviewRuntime.isPending||installationDetails.isPending)}
    setupError={overviewSetupError?errorText(overviewSetupError):undefined} startupBusy={busy==='overviewStart'||!!localProgress} startupDisabled={processUnverified||!!busy||inferenceBusy||!!tasks.data?.some(task=>task.state==='running'&&task.kind.includes('update'))}
    onCopy={content=>void copy(content)} onRestart={overviewMock?(overviewMock.stopped?undefined:()=>undefined):desktop&&profile?.managed&&processStatus?.running===true&&processStatus.owned===true?()=>void act('restart',()=>core.restartService(profile),'success'):undefined}
    profiles={overviewMock?overviewMock.profiles.map(item=>({id:item.id,name:item.name})):profiles.map(item=>({id:item.id,name:item.name}))}
    onSwitchProfile={overviewMock?()=>undefined:id=>{const next=profiles.find(item=>item.id===id);if(next)void act('switchProfile',()=>activateLocal(next),'success');}}
    actionsDisabled={!!busy||!!localProgress||inferenceBusy||processUnverified}
    onImages={desktop&&profile?.configPath&&!busy&&!inferenceBusy&&!localProgress?()=>setModal({kind:'vision',profile}):undefined}
    stateLabel={serviceState} onRefresh={()=>void query.invalidateQueries()} onCreateProfile={()=>go('models')} onChat={()=>conversation?go('chat'):addConversation()} onNavigate={go}/>;

  const operateService = async (action: () => Promise<unknown>) => { await action(); await refreshLocalProfiles(); await query.invalidateQueries(); notify(t('success')); };
  const connectObservedService = async (candidate: core.LocalCandidate) => {
    if (preparingLocal.current || inferenceBusy) throw new Error(t('busyHint'));
    await storeWriter.flushAll();
    const connection = await core.connectRunningService(candidate);
    if (!connection.restarting) {
      await refreshLocalProfiles();
      setActiveId(connection.profileId);
      await query.invalidateQueries();
    }
  };
  const manageObservedService = (candidate: core.LocalCandidate) => manageRunningService(
    () => connectObservedService(candidate),
    () => prepareImported(candidate),
  );
  const automaticRunningAttempt = useRef('');
  const automaticCandidate = selectAutomaticService(discoveredCandidates.data ?? [], supervisor.data?.activeServices,
    !desktop || !ready || !!busy || inferenceBusy || !!localProgress || !!modal || !!tasks.data?.some(task => task.state === 'running'));
  const automaticCandidateKey = automaticCandidate ? `${automaticCandidate.pid}:${automaticCandidate.detectedPort}:${automaticCandidate.configPath}` : '';
  useEffect(() => {
    if (!automaticCandidate || !automaticCandidateKey || automaticRunningAttempt.current === automaticCandidateKey) return;
    automaticRunningAttempt.current = automaticCandidateKey;
    // Reconnect already managed services without touching their process tree.
    // A plain external service is migrated only after confirming it is loaded;
    // the backend then rechecks identity, activity and the runtime lease.
    void automaticallyManageService(automaticCandidate, connectObservedService, candidate => prepareImported(candidate), candidate => core.request({
      id: `running-${candidate.id}`, name: candidate.name, managed: false,
      baseUrl: `http://127.0.0.1:${candidate.detectedPort}`, installDir: candidate.installDir,
      pythonPath: candidate.pythonPath, configPath: candidate.configPath,
    }, '/health', 'GET')).catch(error => notify(errorText(error), true));
  }, [automaticCandidateKey]);
  const servicePage = async (p: ServiceProfile, next: Page) => {
    if (p.id !== activeId) await activateLocal(p);
    if (next === 'tasks') setSelectedTaskId('');
    go(next);
  };
  const openServiceLogs = (p: ServiceProfile) => navigationGuard.request(() => {
    setLogServiceId(p.id); setSelectedTaskId(''); navigate('tasks');
  });
  const openModelConfig = (selected?: ServiceProfile, accepted = false) => {
    if (page === 'config' && configProfile?.id === (selected?.id ?? activeId)) return;
    const open = () => {
    setDiscoveredConfigProfile(undefined);
    setConfigProfileId(selected?.id ?? activeId);
    navigate('config');
    };
    if (accepted) open(); else navigationGuard.request(open);
  };
  const openDiscoveredConfig = (candidate: core.LocalCandidate) => {
    if (page === 'config' && configProfile?.configPath === candidate.configPath) return;
    navigationGuard.request(() => {
    setDiscoveredConfigProfile({id:`configuration-${candidate.id}`,name:candidate.name,baseUrl:`http://127.0.0.1:${candidate.detectedPort ?? 8080}`,installDir:candidate.installDir,pythonPath:candidate.pythonPath,configPath:candidate.configPath,managed:false});
    navigate('config');
    });
  };
  const removeService = async (p:ServiceProfile) => {
    if(desktop) { const status=await core.serviceStatus(p.id); if(status.running&&status.owned)throw new Error(t('profileStopFirst')); }
    if (desktop) await core.removeLocalInstallation(p.id);
    await core.setApiKey(p.id,'');
    setProfiles(old=>old.filter(item=>item.id!==p.id));
    setActiveId(current=>current===p.id?'':current);
    setConversationIds(old=>Object.fromEntries(Object.entries(old).filter(([key])=>key!==p.id)));
    notify(t('success'));
  };
  const addModelDirectory = () => { void choose(true).then(directory => { if (!directory) return; setModelDirectories(old => [...new Set([...old, directory])]); void query.invalidateQueries({ queryKey: ['discovered-local-models'] }); }).catch(error => notify(errorText(error), true)); };
  const ProfilesPage = () => <ServiceManagerPage hardware={hardware} environment={environment.data} hardwareOnline={hardwareOnline} profiles={profiles} activeId={activeId} lastUsedId={lastUsedId} preparingId={startupTarget?.id} details={installationDetails.data} candidates={discoveredCandidates.data} runtimes={detectedRuntimes} discoveryLoading={discoveredCandidates.isPending} discoveryError={discoveredCandidates.error} addedDirectories={modelDirectories} onRepairPython={async installDir => { const result = await core.repairPythonDependencies(installDir); notify(result.message || t('repairPythonEnvDone')); await discoveredCandidates.refetch(); }} onCopyDiagnostics={async target => { const text = await core.supportDiagnosticsText(target); try { await navigator.clipboard.writeText(text); notify(t('copyDiagnosticsDone')); } catch { notify(t('clipboardUnavailable'), true); } }} onUseCandidate={prepareImported} onConfigCandidate={openDiscoveredConfig} onRefreshDiscovery={()=>discoveredCandidates.refetch()} language={settings.language} desktop={desktop} pollInterval={settings.pollInterval} streaming={inferenceBusy} busyProfileIds={busy || localProgress || tasks.data?.some(task => task.state === 'running' && task.kind.includes('update')) ? profiles.map(p=>p.id) : []}
    onSelect={activateLocal} onAdd={addModelDirectory} onImport={addModelDirectory}
    onEdit={p=>setModal({kind:'profile',profile:p})} onDelete={removeService} onModelDeleted={()=>query.invalidateQueries()}
    onStart={p=>operateService(()=>activateLocal(p))} onStop={p=>operateService(()=>stopManagedService(p.id))} onRestart={p=>operateService(()=>core.restartService(p))} onTakeover={p=>operateService(()=>activateLocal(p))}
    onLoad={p=>operateService(()=>core.request(p,'/load','POST',{}))} onUnload={p=>operateService(()=>core.request(p,'/unload','POST',{}))}
    onConfig={openModelConfig} onLogs={openServiceLogs} onChat={p=>servicePage(p,'chat')}
    onError={error=>notify(errorText(error),true)}/>;

  const ModelsPage = () => <ModelDownloadPage machineMemoryGB={machineMemoryGB(hardware, environment.data)} language={settings.language} desktop={desktop}
    fallbackRuntime={profile} runtimeOverride={preparationRuntime} runtimes={profiles}
    runtimeVersions={detectedRuntimes ?? []}
    busy={!!busy || inferenceBusy || !!localProgress} tasks={tasks.data ?? []}
    onRuntimeChange={setPreparationRuntime} onChooseDirectory={() => choose(true)} onChooseFile={() => choose(false)}
    onPrepare={async request => { await act('setup', () => runRecipe({ kind: 'setup', ...request }), 'modelPrepared'); }}
    onImportConfig={async (path, runtime) => { await act('import', () => openConfigProfile(path, runtime, false)); }}
    onOrcaImport={async (runtime, request, options) => { await act('setup', () => runRecipe({ kind: 'orca', profile: runtime, request, options }), 'modelPrepared'); }}
    onTasks={() => go('tasks')} onEnvironment={() => go('environment')}
    onDirtyChange={setDownloadConfigurationDirty} onSaveDraftReady={registerDownloadConfigurationSave}/>;

  const renderChatPage=()=> <ChatPage conversation={conversation} conversations={conversations} activeConversationId={conversationId} onSelectConversation={selectConversation} onRenameConversation={conversation=>setModal({kind:'rename',conversation})} onDeleteConversation={conversation=>setModal({kind:'deleteConversation',conversation})} profile={profile} online={chatReady && !benchmarkRunning} supportsImages={supportsImages} modelName={healthData.model} language={settings.language} draft={draft} onDraftChange={setDraft} attachments={attachments} streaming={streaming} showReasoning={chatPreferences.showReasoning} onSend={send} onCancel={()=>abort.current?.abort()} onNewConversation={addConversation} onExport={exportConversation} onOpenSampling={()=>setModal({kind:'options'})} onAddFiles={addFiles} onRemoveAttachment={id=>setAttachments(old=>old.filter(file=>file.id!==id))} stateLabel={serviceState} onCopy={copy}/>;

  const renderMonitoringPage = () => <MonitoringPage raw={{...(metric?.raw??{}),...(mcpQuery.data?{mcp:mcpQuery.data}:{})}} language={settings.language} showAll={showAllRequests} onShowAll={()=>setShowAllRequests(!showAllRequests)} onRequest={value=>setModal({kind:'request',value})} sampledAt={metrics.dataUpdatedAt || undefined} stale={!online || metrics.isError || (metrics.dataUpdatedAt > 0 && Date.now() - metrics.dataUpdatedAt > Math.max(15000, settings.pollInterval * 3))} error={metrics.error?errorText(metrics.error):undefined}/>;
  const renderAboutPage = () => <AboutPage raw={metric?.raw??{}} health={healthData} profile={profile} online={online} language={settings.language} desktop={desktop} onOpenSettings={()=>go('settings')} onOpenConfig={()=>openModelConfig(profile)} onCopy={content=>copy(content)} onError={error=>notify(errorText(error),true)}/>;
  const enableRequestViewer = async (minutes: 0 | 5 | 15 | 30) => {
    if (!profile || !desktop || processStatus?.owned !== true || (minutes > 0 && (localProgress || busy || inferenceBusy))) throw new Error(t('busyHint'));
    return core.setRequestCapture(profile.id, minutes);
  };
  const RequestsPage = () => <RequestViewer embedded profile={profile} online={online} language={settings.language} pollInterval={settings.pollInterval} noProfile={<NeedProfile/>} errorText={errorText} onError={error => notify(errorText(error),true)} onMessage={notify} onEnableViewer={desktop && processStatus?.owned === true ? enableRequestViewer : undefined} onOpenUsage={()=>go('usage')}/>;
  const taskState = (state: TaskStatus['state']): TextKey => state === 'completed' ? 'completed' : state === 'failed' ? 'taskFailed' : state === 'cancelled' ? 'taskCancelled' : 'taskRunning';
  const TasksPage = () => <><Header title={t('tasks')} hint={t('taskIntro')}><button disabled={!desktop || !profile || !!busy} data-tooltip={nativeTitle} onClick={diagnostics}><Download size={15} />{t('diagnostics')}</button><button disabled={!desktop} data-tooltip={nativeTitle} onClick={() => void query.invalidateQueries()}><RefreshCw size={15} />{t('refresh')}</button></Header><ErrorBlock error={tasks.error} /><ErrorBlock error={handoffs.error ?? preparedProfiles.error} /><Panel title={t('tasks')}><TasksTimeline tasks={tasks.data ?? []} selected={selectedTaskId} onSelect={task => { if (desktop) setSelectedTaskId(task.id); document.getElementById(`task-${task.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }}/>{tasks.data?.length ? <div className="task-list">{[...tasks.data].sort((a, b) => b.startedAt - a.startedAt).map(task => <div className="task-row" key={task.id} id={`task-${task.id}`} data-selected={selectedTaskId === task.id || undefined}><div className={`task-icon ${task.state}`}>{task.state === 'running' ? <LoaderCircle className="spin" size={20} /> : task.state === 'completed' ? <Check size={20} /> : <Terminal size={20} />}</div><div className="task-copy"><div><strong>{t(task.kind.includes('setup') ? 'setupTask' : task.kind.includes('install') ? 'installTask' : task.kind.includes('update') ? 'updateTask' : 'task')}</strong><Badge tone={task.state === 'completed' ? 'positive' : task.state === 'failed' ? 'warning' : ''}>{t(taskState(task.state))}</Badge></div><p>{task.message}</p><small>{new Date(task.startedAt).toLocaleString(settings.language)} · {task.id}</small></div><div className="actions">{taskNextActions(task)}<button disabled={!desktop} onClick={() => setSelectedTaskId(task.id)}><FileText size={14}/>{t('viewLogs')}</button>{task.state === 'running' ? <button disabled={!!busy} onClick={() => void act('cancelTask', () => core.cancelTask(task.id), 'success')}><Square size={13} />{t('cancelTask')}</button> : task.state !== 'completed' && <button disabled={!!busy} onClick={() => { if (task.kind.includes('update')) { go('environment'); return; } const recipe = recipes[task.id]; if (!recipe) notify(t('retryUnavailable'), true); else void act('retryTask', () => runRecipe(recipe), 'taskStarted'); }}><RefreshCw size={14} />{t('retry')}</button>}</div></div>)}</div> : <Empty title={t('noTasks')} hint={!desktop ? t('nativeRequired') : undefined} />}</Panel><Panel title={t('logs')} action={<div className="search-field"><Search size={15} /><input aria-label={t('searchLogs')} placeholder={t('searchLogs')} value={logSearch} onChange={event => setLogSearch(event.target.value)} /></div>}><Field label={t('logSource')}><Dropdown ariaLabel={t('logSource')} value={selectedTaskId} disabled={!desktop} onValueChange={setSelectedTaskId} options={[{value:'',label:`${t('serviceLogs')}${logService ? ` · ${logService.name} · ${logService.configPath.split(/[\\/]/).at(-1) ?? logService.id}` : ''}`,disabled:!logService},...(tasks.data ?? []).map(task => ({value:task.id,label:`${t(task.kind.includes('setup') ? 'setupTask' : task.kind.includes('install') ? 'installTask' : task.kind.includes('update') ? 'updateTask' : 'task')} · ${new Date(task.startedAt).toLocaleString(settings.language)} · ${task.id.slice(0,8)}`}))]} /></Field><ErrorBlock error={logs.error} />{logs.data?.length ? <div className="log-view" role="log">{logs.data.filter(log => `${log.level} ${log.message}`.toLowerCase().includes(logSearch.toLowerCase())).map((log, index) => <div className="log-line" key={index}><time>{new Date(log.timestamp).toLocaleTimeString(settings.language)}</time><span className={`log-level ${log.level.toLowerCase()}`}>{log.level}</span><span>{log.message}</span></div>)}</div> : <Empty title={t('noLogs')} hint={!desktop ? t('nativeRequired') : !selectedTaskId && !logProfile ? t('selectLogSourceHint') : undefined} />}</Panel></>;
  const EnvironmentPage = () => <><EnvironmentDevices hardware={hardware} environment={environment.data}/><InstallRuntimePage autoCheck={settings.autoCheckUpdates !== false} language={settings.language} desktop={desktop} operationDisabled={inferenceBusy} onUpdateStarted={() => go('environment')}/><Panel title={t('system')} action={<button disabled={!desktop} onClick={() => void environment.refetch()}><RefreshCw size={15}/>{t('refresh')}</button>}><ErrorBlock error={environment.error}/>{environment.data ? <div className="environment-grid">{[[t('system'),environment.data.os],[t('architecture'),environment.data.arch],[t('cpu'),environment.data.cpuName],[t('totalMemory'),bytes(environment.data.totalMemory)],[t('availableMemory'),bytes(environment.data.availableMemory)],[t('gpus'),environment.data.gpus.join(', ')||t('missing')],['Python',environment.data.python??t('missing')],[t('appVersion'),environment.data.appVersion]].map(([label,value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div> : <Empty title={desktop?environment.isPending?t('loading'):t('empty'):t('nativeRequired')}/>}</Panel></>;
  const changeSettings = (patch: Partial<AppSettings>) => { const next = { ...latestSettings.current, ...patch }; latestSettings.current = next; setSettings(next); if (desktop) void core.applySettings(next).catch(error => notify(errorText(error), true)); };
  monitorSettingsChange.current = patch => {
    const previous = normalizeFloatingMonitorPreferences(latestSettings.current.floatingMonitor);
    const allowed: Partial<core.FloatingMonitorPreferences> = {};
    if (Array.isArray(patch.metrics)) allowed.metrics = patch.metrics;
    if (typeof patch.showGraphs === 'boolean') allowed.showGraphs = patch.showGraphs;
    if (typeof patch.showInTray === 'boolean') allowed.showInTray = patch.showInTray;
    const next = normalizeFloatingMonitorPreferences({ ...previous, ...allowed });
    if (JSON.stringify(previous) !== JSON.stringify(next)) changeSettings({ floatingMonitor: next });
  };
  const changeMonitorVisibility = async (visible: boolean) => {
    await storeWriter.flush('settings');
    const preferences = normalizeFloatingMonitorPreferences(latestSettings.current.floatingMonitor);
    const status = await setMonitorVisibility(visible, 'floating', preferences, latestSettings.current.language);
    monitorModeRevision.current++;
    setMonitorModeStatus(status);
    if (status.visible === true || status.active) monitorSettingsChange.current({ mode: status.mode });
    if ((status.visible ?? status.active) !== visible) throw new Error(status.message || 'Monitor visibility could not be changed');
  };
  const UpdatesPage = () => <><Header title={t('appUpdates')} /><div className="settings-layout"><DesktopLifecycleSettings section="updates" currentVersion={appVersion} desktop={desktop} streaming={inferenceBusy} autoCheck={settings.autoCheckUpdates !== false} onAutoCheck={enabled => changeSettings({autoCheckUpdates:enabled})} update={appUpdates.state} onCheck={appUpdates.check} onDownload={appUpdates.download} onInstall={appUpdates.install} onError={error => notify(errorText(error),true)}/></div></>;
  const setInterfaceLanguage = (preference: core.LanguagePreference) => {
    const next = core.resolveLanguageSettings({languagePreference:preference}, systemLanguage.locales);
    changeSettings(next);
  };
  const confirmLanguage = async () => {
    storeWriter.stage('settings', latestSettings.current);
    await storeWriter.flush('settings');
    setShowLanguageSetup(false);
  };
  const SettingsPage = () => <><Header title={t('settings')} /><div className="settings-layout d2-settings">
    <Panel title={t('obSettingsTitle' as TextKey)}><div className="setting-toggle"><span><strong>{t('guideTitle')}</strong><small className="d2-setting-hint">{t('obSettingsHint' as TextKey)}</small></span><button type="button" className="st-btn st-btn--secondary" onClick={openGuide}><Flag size={14}/>{t('obReopen' as TextKey)}</button></div></Panel>
    <Panel title={t('appearance')}><Field label={t('theme')}><Segmented ariaLabel={t('theme')} value={settings.theme} onValueChange={theme => changeSettings({theme:theme as AppSettings['theme']})} options={(['dark','light','system'] as const).map(theme => ({value:theme,label:t(theme === 'system' ? 'systemTheme' : theme),icon:theme === 'dark' ? <OfficialIcon name="moon" size={15}/> : theme === 'light' ? <OfficialIcon name="sun" size={15}/> : <Settings2 size={15}/>}))} /></Field><Field label={t('language')} hint={settings.language === 'en' || settings.language === 'zh-CN' ? translate('d2LanguageCount', { count: core.supportedLanguages.length }) : `${translate('d2LanguageCount', { count: core.supportedLanguages.length })} · ${t('translationFallbackHint')}`}><Dropdown ariaLabel={t('language')} value={settings.languagePreference ?? settings.language} onValueChange={value => setInterfaceLanguage(value as core.LanguagePreference)} options={[{value:'system',label:t('systemLanguage')},...core.supportedLanguages.map(item=>({value:item.code,label:item.label}))]} /></Field></Panel>
    <Panel title={t('behavior')}><div className="setting-toggle"><span><strong data-tooltip={t('closeToTrayHint')}>{t('closeToTray')}</strong><small className="d2-setting-hint">{t('closeToTrayHint')}</small></span><Toggle ariaLabel={t('closeToTray')} disabled={!desktop} tooltip={nativeTitle} checked={settings.closeToTray} onCheckedChange={checked => changeSettings({closeToTray:checked})} /></div>{!settings.closeToTray && <label className="setting-toggle"><span><strong>{settings.language === 'zh-CN' ? '退出前询问' : 'Confirm before exiting'}</strong></span><Toggle ariaLabel={settings.language === 'zh-CN' ? '退出前询问' : 'Confirm before exiting'} checked={!settings.skipExitConfirmation} onCheckedChange={checked => changeSettings({skipExitConfirmation:!checked})}/></label>}</Panel>
    <DesktopLifecycleSettings section="background" currentVersion={appVersion} desktop={desktop} streaming={inferenceBusy} autoCheck={settings.autoCheckUpdates !== false} onAutoCheck={enabled => changeSettings({autoCheckUpdates:enabled})} update={appUpdates.state} onCheck={appUpdates.check} onDownload={appUpdates.download} onInstall={appUpdates.install} onError={error => notify(errorText(error),true)}/>
  </div></>;
  const MonitorSettingsPage = () => <><Header title={t('monitorSettings')} /><div className="settings-layout settings-layout--single">
    <Panel title={t('monitorRefresh')}><Field label={t('pollInterval')}><Dropdown ariaLabel={t('pollInterval')} value={String(settings.pollInterval)} onValueChange={value => changeSettings({pollInterval:Number(value)})} options={[2000,3000,5000,10000,30000].map(value => ({value:String(value),label:`${value/1000} ${t('seconds')}`}))} /></Field></Panel>
    <FloatingMonitorSettings preferences={normalizeFloatingMonitorPreferences(settings.floatingMonitor)} desktop={desktop} language={settings.language} onChange={floatingMonitor => changeSettings({floatingMonitor})} modeStatus={monitorModeStatus} onVisibilityChange={changeMonitorVisibility} onOpen={() => {void changeMonitorVisibility(true).catch(error => notify(errorText(error), true));}}/>
  </div></>;
  const ChatDefaultsPage = () => <><Header title={t('chatDefaults')} /><div className="settings-layout">
    <CommonChatSettingsPanel value={commonChatDefaults} onChange={next=>setCommonChatDefaults(core.normalizeCommonChatDefaults(next))} language={settings.language} profileName={profile?.name} inheritsCommon={inheritsCommon} onInheritanceChange={profile?changeChatInheritance:undefined}/>
  </div></>;


  const exportConversation = (c: Conversation) => { const content = `# ${c.title}\n\n${c.messages.map(m => `## ${t(m.role === 'user' ? 'you' : 'assistant')}\n\n${m.reasoning ? `<details><summary>${t('thinking')}</summary>\n\n${m.reasoning}\n\n</details>\n\n` : ''}${m.content}${m.attachments?.length ? '\n\n' + m.attachments.map(a => a.type === 'image' ? `![${a.name}](${a.content})` : `### ${a.name}\n\n\`\`\`\n${a.content}\n\`\`\``).join('\n\n') : ''}${m.tools?.length ? `\n\n\`\`\`json\n${JSON.stringify(m.tools, null, 2)}\n\`\`\`` : ''}${m.error ? `\n\n> ${m.error}` : ''}`).join('\n\n---\n\n')}\n`; void saveFile(markdownFileName(c.title), content); };
  const configProcess = useQuery({queryKey:['model-config-process',configProfile?.id],queryFn:()=>core.serviceStatus(configProfile!.id,configProfile),enabled:desktop && page==='config' && !!configProfile && !discoveredConfigProfile,refetchInterval:settings.pollInterval});
  const configOnline = configProfile?.id===activeId ? online : !desktop || !configProcess.isError && configProcess.data?.running===true && configProcess.data?.owned===true;
  const connectionProcess = useQuery({queryKey:['connection-process',connectionProfile?.id,connectionProfile?.baseUrl],queryFn:()=>core.serviceStatus(connectionProfile!.id,connectionProfile),enabled:desktop && page==='connections' && !!connectionProfile,refetchInterval:10000,refetchOnWindowFocus:false});
  const connectionRunning = !desktop || (connectionProfile?.id===activeId ? serviceRunning : !connectionProcess.isError && connectionProcess.data?.running===true);
  const connectionHealth = useQuery({queryKey:['connection-health',connectionProfile?.id,connectionProfile?.baseUrl],queryFn:()=>core.request(connectionProfile!,'/health'),enabled:page==='connections' && !!connectionProfile && connectionRunning && connectionProfile.id!==activeId,retry:false,refetchOnWindowFocus:false});
  const connectionOnline = connectionProfile?.id===activeId ? online : connectionRunning && connectionHealth.isSuccess;
  const connectionHealthData = connectionProfile?.id===activeId ? healthData : connectionOnline ? object(connectionHealth.data) : {};
  const renderConnectionsPage = () => <>
    <Header title={settings.language==='zh-CN'?'API 与外部助手':'API and external assistants'} hint={settings.language==='zh-CN'?'在这里统一配置服务接入。选择目标不会启动或切换正在运行的模型。':'Manage service connections here. Selecting a target does not start or switch the running model.'}/>
    <div className="shared-settings-target"><div><strong>{settings.language==='zh-CN'?'连接目标':'Connection target'}</strong><p>{settings.language==='zh-CN'?'API 密钥与 MCP 配置明确绑定所选服务。':'API credentials and MCP configuration belong to the selected service.'}</p></div><Field label={settings.language==='zh-CN'?'目标服务':'Target service'}><Dropdown ariaLabel={settings.language==='zh-CN'?'目标服务':'Target service'} value={connectionProfile?.id??''} disabled={!profiles.length} options={profiles.map(item=>({value:item.id,label:`${item.name} · ${item.configPath.split(/[\\/]/).at(-1)??item.id}`}))} onValueChange={next=>navigationGuard.request(()=>{setConnectionProfileId(next);setApiIntegrationOpen(false);})}/></Field><button disabled={!connectionProfile} onClick={()=>setApiIntegrationOpen(true)}>{settings.language==='zh-CN'?'接入 API':'Connect to the API'}</button></div>
    <EndpointHero url={connectionProfile?.baseUrl} online={connectionOnline} model={typeof connectionHealthData.model === 'string' ? connectionHealthData.model : undefined}/>
    <div className="shared-settings-stack">
      <ServiceCapabilityPanel profile={connectionProfile} online={connectionOnline} language={settings.language} identityToken={connectionProfile?.id === activeId ? `${processStatus?.pid}:${processStatus?.startedAt}:${healthData.loaded}:${healthData.model}` : `${connectionProcess.data?.pid}:${connectionProcess.data?.startedAt}:${connectionHealthData.loaded}:${connectionHealthData.model}`}/>
      <ServiceConnectionPanel profile={connectionProfile} desktop={desktop} language={settings.language} onDirtyChange={setConnectionDirty} onSaveDraftReady={registerConnectionSave} onSaved={()=>{void query.invalidateQueries();}} onError={error=>notify(errorText(error),true)}/>
      {desktop && <div className="official-surface"><McpIntegrationPanel profile={connectionProfile} canHandoff={!quickActionsDisabled} refreshToken={connectionOwnershipRevision} onOwnershipChange={()=>{setConnectionOwnershipRevision(previous=>previous+1);void query.invalidateQueries();}}/></div>}
    </div>
    {apiIntegrationOpen && connectionProfile && <ApiIntegrationDialog key={connectionProfile.id} profile={connectionProfile} model={typeof connectionHealthData.model==='string'?connectionHealthData.model:undefined} online={connectionOnline} loaded={connectionHealthData.loaded===true} keyRequired={connectionOnline&&typeof connectionHealthData.api_key==='boolean'?connectionHealthData.api_key:undefined} language={settings.language} onCopy={content=>{void copy(content);}} onClose={()=>setApiIntegrationOpen(false)}/>}
  </>;
  const renderRuntimeToolsPage = () => <>
    <Header title={settings.language==='zh-CN'?'显存与会话':'VRAM and sessions'} hint={settings.language==='zh-CN'?'工具作用于当前模型，执行结果和会话存档随模型区分。':'Tools act on the current model; results and session files remain model specific.'}/>
    <div className="shared-settings-target"><div><strong>{profile?.name ?? (settings.language==='zh-CN'?'尚未选择模型':'No model selected')}</strong><p>{profile ? online ? (settings.language==='zh-CN'?'当前服务已连接':'Current service is connected') : (settings.language==='zh-CN'?'当前服务未启动或尚未连接':'Current service is not started or connected') : (settings.language==='zh-CN'?'先在我的模型中启用一个模型。':'Enable a model in My models first.')}</p></div><button onClick={()=>go('models')}>{t('myModels')}</button></div>
    <VramReserveBar hardware={hardwareOnline ? hardware : {}} environment={environment.data}/>
    <div className="shared-settings-stack"><div className="official-surface"><RuntimeOperationsPanel profile={profile} online={online} owned={processStatus?.owned===true && processStatus?.running===true} language={settings.language} disabled={quickActionsDisabled} onError={error=>notify(errorText(error),true)} onMessage={notify}/></div></div>
  </>;
  const restartSelectedService = async (selected:ServiceProfile) => {
    if (selected.id!==activeId || selected.configPath!==profile?.configPath || !desktop || busy || inferenceBusy || preparingLocal.current) throw new Error(t('busyHint'));
    const current = await core.serviceStatus(selected.id,selected);
    if (!current.owned || !current.running) throw new Error(t('busyHint'));
    const generation=++preparationGeneration.current;
    preparingLocal.current=true;
    setBusy('restart-config'); setStartupStartedAt(Date.now()); setStartupTarget(selected); setLocalProgress({phase:'starting'});
    try {
      await core.restartService(selected);
      await core.switchLocalService(selected.id);
      await refreshLocalProfiles();
      await query.invalidateQueries();
    } finally {
      setBusy('');
      if(generation===preparationGeneration.current){preparingLocal.current=false;setLocalProgress(undefined);setStartupTarget(undefined);}
    }
  };
  const configurationCopied = async (copied:ServiceProfile) => {
    // Copies of registered configurations are registered by the backend: open the
    // saved record so it is listed and selectable. Nothing is started here.
    const refreshed=desktop?await refreshLocalProfiles().catch(()=>profiles):profiles;
    const registered=refreshed.find(item=>item.id===copied.id);
    if(registered){navigationGuard.request(() => { setDiscoveredConfigProfile(undefined);setConfigProfileId(registered.id);navigate('config'); });return;}
    const directory=copied.configPath.replace(/[\\/][^\\/]+$/,'');
    setModelDirectories(previous=>[...new Set([...previous,directory])]);
    navigationGuard.request(() => { setDiscoveredConfigProfile(copied);setConfigProfileId('');navigate('config'); });
  };
  const configurationDeleted = async (deleted:ServiceProfile) => {
    const remaining=await core.localInstallations();setProfiles(remaining);
    if(activeId===deleted.id)setActiveId('');
    setDiscoveredConfigProfile(undefined);setConfigProfileId('');go('models');
  };
  const configurationSaved = async (message: string) => {
    try {
      // The registry keeps the live endpoint until restart, and updates an idle
      // profile immediately. Read it instead of deriving a URL from the draft.
      await refreshLocalProfiles();
      await Promise.all([
        query.invalidateQueries({ queryKey: ['discovered-local-models'] }),
        query.invalidateQueries({ queryKey: ['localInstallationDetails'] }),
      ]);
      notify(message);
    } catch (error) {
      notify(`${message} ${settings.language === 'zh-CN' ? '刷新服务地址失败：' : 'Could not refresh the service address: '}${errorText(error)}`, true);
    }
  };
  const allConfigurationGroups=core.groupLocalModels(profiles,discoveredCandidates.data,installationDetails.data);
  const configurationVersions=core.runtimeVersionIndex(discoveredCandidates.data,detectedRuntimes);
  const configurationCurrentInstall=core.resolveCurrentInstallDir({profiles,candidates:discoveredCandidates.data,runtimes:detectedRuntimes,activeId,activeRunning:processStatus?.owned===true&&processStatus?.running===true,lastUsedId});
  const selectedConfigurationGroup=allConfigurationGroups.find(group=>group.configurations.some(entry=>entry.profile?.id===configProfile?.id||!!configProfile?.configPath&&core.configurationPathKey(entry.configPath)===core.configurationPathKey(configProfile.configPath)));
  const renderRuntimeConfig = () => <>
    <RuntimeConfigPage configurations={desktop && <ConfigurationList versions={configurationVersions} currentInstallDir={configurationCurrentInstall} groups={selectedConfigurationGroup?[selectedConfigurationGroup]:[]} selectedPath={configProfile?.configPath} activeId={activeId} running={processStatus?.owned===true&&processStatus?.running===true} lastUsedId={lastUsedId} disabled={processUnverified||!!busy||inferenceBusy||!!localProgress} dirty={configurationDirty} loading={discoveredCandidates.isPending} error={discoveredCandidates.error?errorText(discoveredCandidates.error):undefined} language={settings.language} onRefresh={()=>{void discoveredCandidates.refetch();void installationDetails.refetch();}} onDelete={entry=>{const candidate=entry.candidate;const selected=entry.profile??(candidate?{id:`configuration-${candidate.id}`,name:candidate.name,baseUrl:`http://127.0.0.1:${candidate.detectedPort??8080}`,installDir:candidate.installDir,pythonPath:candidate.pythonPath,configPath:candidate.configPath,managed:false}:undefined);if(selected)setModal({kind:'deleteConfiguration',profile:selected});}} onOpen={entry=>{if(entry.profile)openModelConfig(entry.profile);else if(entry.candidate)openDiscoveredConfig(entry.candidate);}} onUse={(entry,restart)=>navigationGuard.requestAsync(async()=>{if(entry.profile){openModelConfig(entry.profile,true);if(restart)await restartSelectedService(entry.profile);else await activateLocal(entry.profile);}else if(entry.candidate){navigate('models');await prepareImported(entry.candidate);}})}/>} profile={configProfile} online={configOnline} language={settings.language} desktop={desktop} onSharedSettings={()=>go('settings')} onServices={()=>go('models')} onImages={desktop&&configProfile?.configPath&&!busy&&!inferenceBusy&&!localProgress?()=>setModal({kind:'vision',profile:configProfile}):undefined} onDirtyChange={setConfigurationDirty} onSaveDraftReady={registerConfigurationSave} onCopied={configurationCopied} onDeleted={configurationDeleted} onRestart={desktop && configProfile?.id===activeId && processStatus?.owned===true && processStatus?.running===true && !busy && !inferenceBusy && !localProgress ? ()=>restartSelectedService(configProfile) : undefined} onError={error=>notify(errorText(error),true)} onMessage={configurationSaved}/></>;
  const renderTuningPage = () => <><div className="tuning-config-entry"><div><strong>{settings.language==='zh-CN'?'调整模型设置':'Model settings'}</strong><p>{settings.language==='zh-CN'?'保存后重启生效':'Restart to apply changes'}</p></div><button disabled={!profile} onClick={()=>openModelConfig(profile)}><Settings2 size={15}/>{t('config')}</button></div><TuningPage key={profile?.id} profileId={profile?.id} profile={profile} language={settings.language} desktop={desktop} owned={processStatus?.owned === true && processStatus?.running === true} streaming={inferenceBusy} onChanged={() => void query.invalidateQueries()} onCopied={configurationCopied} onRestart={profile && profile.id===activeId && processStatus?.owned===true && processStatus?.running===true && !busy && !inferenceBusy && !localProgress ? ()=>restartSelectedService(profile) : undefined} onBenchmark={()=>go('benchmark')} onSwitchVersion={desktop && processStatus?.owned===true ? activateLocal : undefined}/></>;
  const pages: Record<Page, () => ReactNode> = { guide: renderGuidePage, benchmark: () => null, about: renderAboutPage, overview: renderOverviewPage, tuning: renderTuningPage, config: renderRuntimeConfig, profiles: ProfilesPage, models: ProfilesPage, catalog: ModelsPage, chat: renderChatPage, monitoring: renderMonitoringPage, usage: () => <ApiUsagePage language={settings.language} profileId={overviewMock?overviewMock.profile.id:profile?.id} profileName={overviewMock?overviewMock.profile.name:profile?.name} desktop={overviewMock?true:desktop} onQuery={overviewMock?apiUsageMockClient:core.analyticsQuery} live={overviewMock?{raw:overviewMock.stopped?undefined:overviewMock.metric?.raw,sampledAt:Date.now(),stopped:overviewMock.stopped}:{raw:metric?.raw,sampledAt:metrics.dataUpdatedAt || undefined,stale:!online || metricsUnavailable || (metrics.dataUpdatedAt > 0 && Date.now()-metrics.dataUpdatedAt > Math.max(15000,settings.pollInterval*3)),stopped:serviceStopped}} onOpenDiagnostics={()=>go('requests')}/>, requests: RequestsPage, tasks: TasksPage, environment: EnvironmentPage, settings: SettingsPage, 'monitor-settings': MonitorSettingsPage, 'chat-defaults': ChatDefaultsPage, connections: renderConnectionsPage, 'runtime-tools': renderRuntimeToolsPage, updates: UpdatesPage };

  if (!ready) return <div className="desktop-app-frame"><WindowTitleBar desktop={desktop} language={settings.language} collapsed={sidebarCollapsed} version={appVersion} onClose={windowClose.requestClose} onError={error=>notify(errorText(error),true)}/>{windowClose.dialog}<div className="boot">{bootError ? <><p role="alert">{t('workspaceLoadFailed')}</p><details><summary>{t('details')}</summary>{bootError}</details><button onClick={() => setBootAttempt(value => value + 1)}><RefreshCw size={15}/>{t('retry')}</button></> : <><LoaderCircle className="spin" size={28}/><span>{t('loading')}</span></>}</div></div>;
  const runningCandidates = (discoveredCandidates.data ?? []).filter(candidate => candidate.running === true && typeof candidate.pid === 'number' && candidate.pid > 0 && typeof candidate.detectedPort === 'number' && candidate.detectedPort > 0);
  const observedRunningCandidates = runningCandidates.filter(candidate => !profiles.some(saved =>
    core.configurationPathKey(saved.configPath, saved.installDir) === core.configurationPathKey(candidate.configPath, candidate.installDir)
    && (saved.id === activeId && processStatus?.running === true && processStatus.owned === true || (supervisor.data?.health?.[saved.id]?.pid != null && supervisor.data.health[saved.id]?.phase !== 'stopped'))));
  const runningServicePanel = desktop && ['overview', 'models', 'profiles', 'environment'].includes(page) ? <RunningServicesPanel candidates={observedRunningCandidates} language={settings.language} loading={discoveredCandidates.isFetching} pending={discoveredCandidates.isPending} error={discoveredCandidates.error} onRefresh={()=>{void discoveredCandidates.refetch();}} onCopy={content=>{void copy(content);}} onConnect={connectObservedService} onManage={manageObservedService}/> : null;
  const detectedOutsideSelection = observedRunningCandidates.length > 0 && (!profile || serviceStopped);
  const officialPage = page==='chat'||page==='monitoring'||page==='about'||page==='config';
  const live=object(metric?.raw.live);const modelTransition=metric?.state==='loading'||metric?.state==='unloading';const pillState=processUnverified?'unknown':!online?(connecting?'connecting':'disconnected'):metricsUnavailable?'unknown':modelTransition||metric?.state==='unloaded'?metric.state:Number(live.queued)>0?'queued':metric?.state??'unknown';
  const pillText=detectedOutsideSelection?(settings.language==='zh-CN'?'检测到运行中服务':'Running service detected'):!profile?((discoveredCandidates.data?.length)?t('modelsFoundCta'):t('noProfile')):processUnverified?(settings.language==='zh-CN'?'服务状态待核验':'Service state unverified'):serviceStopped?(settings.language==='zh-CN'?'未启动':'Not started'):!online?t(connecting?'connecting':'offline'):metricsUnavailable?(settings.language==='zh-CN'?'实时状态未核验':'Live state unverified'):modelTransition||metric?.state==='unloaded'?serviceState(metric.state):Number(live.queued)>0?`${number(numeric(live.queued),0)} ${t('queuedState')}`:pillState==='generating'?`${t('generatingState')} · ${number(numeric(live.tok_s))} tok/s`:pillState==='reading'?`${t('readingState')}${Number(live.prompt_total)>0?` · ${Math.round(Number(live.prompt_read)/Number(live.prompt_total)*100)}%`:''}`:typeof live.state==='string'?serviceState(live.state):typeof healthData.loaded==='boolean'?t(loaded?'loaded':'notLoaded'):t('online');
  const navItems=[...(guideActive||page==='guide'?[{id:'guide' as Page,label:t('guideTitle'),group:t('navDaily'),icon:<Flag size={18}/>,badge:guide.plan?`${guide.plan.doneCount}/${guide.plan.total}`:undefined}]:[]),...navigation.map(item=>({id:item.id,label:item.id==='monitoring'?t('monitorWorkspace'):item.id==='models'?t('modelWorkspace'):item.id==='environment'?'Strata':item.id==='settings'?t('navSettings'):t(item.id as TextKey),group:t(item.group),icon:<item.icon size={18}/>}))];
  const parent=parentPage(page);
  const subpages:Page[]=parent==='models'?['models','catalog']:parent==='monitoring'?['monitoring','usage']:parent==='settings'?['settings','monitor-settings','chat-defaults','connections','runtime-tools','updates','about']:[];
  const sidebarNode=<Sidebar showBrand={false} items={navItems} page={parent} profiles={profiles} activeId={activeId} disabled={inferenceBusy} collapsed={sidebarCollapsed} onCollapse={()=>setSidebarCollapsed(old=>!old)} onNavigate={next=>go(next as Page)} onProfile={profileId=>{const selected=profiles.find(p=>p.id===profileId);if(selected)void activateLocal(selected).catch(error=>notify(errorText(error),true));}}/>;
  const selectedTuning = backgroundTuning.data?.find(job=>job?.profileId===activeId);
  const tuningActive = !!selectedTuning && ['checking','running','canceling','applying','rollingBack'].includes(selectedTuning.state);
  const quickActionsDisabled = processUnverified || inferenceBusy || modelTransition || !!busy || !!localProgress || tuningActive || updateOwner!==null || !!tasks.data?.some(task=>task.state==='running');
  const statusActivity = localProgress ? undefined : benchmarkRunning ? (settings.language==='zh-CN'?'Benchmark 正在运行':'Benchmark is running') : streaming ? t('generatingState') : tuningActive ? selectedTuning.recovery?.state==='restoring' ? (settings.language==='zh-CN'?'正在恢复原配置与模型':'Restoring the original configuration and model') : (settings.language==='zh-CN'?'参数调优正在运行':'Parameter tuning is running') : undefined;
  const startupStatus = localProgress ? { label: startupPhaseLabel(settings.language, localProgress.phase), modelName: startupTarget?.name, pid: startupTarget?.id === profile?.id && processStatus?.running ? processStatus.pid : undefined, apiUrl: startupTarget?.baseUrl } : undefined;
  const statusProfile = overviewMock?.profile ?? profile;
  const statusOnline = overviewMock ? overviewMock.online : online;
  const statusConnecting = overviewMock ? false : connecting;
  const statusMetric = overviewMock ? (overviewMock.stopped ? undefined : overviewMock.metric) : metric;
  const statusProcess = overviewMock?.process ?? processStatus;
  const statusPillState = overviewMock?.pillState ?? (localProgress ? 'loading' : pillState);
  const statusPillText = overviewMock
    ? (settings.language === 'zh-CN' ? overviewMock.pillLabel : overviewMock.pillLabelEn)
    : (startupStatus?.label ?? pillText);
  const titleBar=<WindowTitleBar desktop={desktop} language={settings.language} collapsed={sidebarCollapsed} version={appVersion} updateVersion={appUpdateVersion} onVersionClick={openAppUpdates} title={navItems.find(item=>item.id===parent)?.label} onClose={windowClose.requestClose} onError={error=>notify(errorText(error),true)} status={<ServiceStatusPopover language={settings.language} label={statusPillText} state={statusPillState} profile={statusProfile} process={statusProcess} processUnverified={overviewMock?false:processUnverified} online={statusOnline} loaded={overviewMock?true:(online&&typeof healthData.loaded==='boolean'?healthData.loaded:undefined)} metric={statusMetric} metricUpdatedAt={overviewMock?Date.now():metrics.dataUpdatedAt} metricsUnavailable={overviewMock?false:metricsUnavailable} connecting={statusConnecting} activity={statusActivity} startup={startupStatus} actions={serviceActions} actionsDisabled={quickActionsDisabled} onRefresh={()=>query.invalidateQueries()} onNavigate={go}/>}/>;
  const statusBar=processUnverified?<footer className="workspace-statusbar service-telemetry-statusbar" aria-label={settings.language==='zh-CN'?'服务监控':'Service telemetry'} data-state="unverified"><span className="workspace-statusbar-state service-telemetry-state"><span className="service-telemetry-dot" aria-hidden="true"/>{settings.language==='zh-CN'?'服务状态待核验':'Service state unverified'}</span><button type="button" className="service-telemetry-floating" onClick={()=>void openFloatingMonitor().catch(error=>notify(errorText(error),true))} aria-label={settings.language==='zh-CN'?'打开监控浮条':'Open floating monitor'} data-tooltip={settings.language==='zh-CN'?'打开监控浮条':'Open floating monitor'}><Activity size={14}/></button></footer>:<ServiceTelemetryStatusBar language={settings.language} hasProfile={!!statusProfile} online={statusOnline} connecting={statusConnecting} stopped={overviewMock?false:serviceStopped} detected={overviewMock?false:detectedOutsideSelection} metric={statusMetric} unavailable={overviewMock?false:metricsUnavailable} stateLabel={serviceState} desktop={overviewDesktop} onOpenFloating={()=>void openFloatingMonitor().catch(error=>notify(errorText(error),true))}/>;
  const subnavigation=page==='config'?<nav className="workspace-subnav model-config-breadcrumb" aria-label={t('config')}><button type="button" onClick={()=>go('models')}><ArrowRight size={15} className="back-arrow"/>{t('myModels')}</button><span aria-hidden="true">/</span><strong>{configProfile?.name ?? t('model')} · {t('config')}</strong></nav>:subpages.length>0&&<nav ref={subnavigationRef} className="workspace-subnav" aria-label={navItems.find(item=>item.id===parent)?.label}>{subpages.map(item=><button key={item} type="button" className={(page===item || item==='models' && page==='profiles')?'is-active':''} aria-current={(page===item || item==='models' && page==='profiles')?'page':undefined} onClick={()=>go(item)}>{item==='monitor-settings'?t('monitorSettings'):item==='chat-defaults'?t('chatDefaults'):item==='connections'?(settings.language==='zh-CN'?'API 与外部助手':'API and assistants'):item==='runtime-tools'?(settings.language==='zh-CN'?'显存与会话':'VRAM and sessions'):item==='settings'?(settings.language==='zh-CN'?'公共设置':'Shared settings'):item==='updates'?t('appUpdates'):item==='requests'?t('apiMonitorTitle'):item==='models'?t('myModels'):item==='catalog'?t('downloadModels'):t(item as TextKey)}</button>)}</nav>;
  const failureCandidate = page==='tasks' ? startupFailure ?? core.latestStartupDiagnostic(supervisor.data?.startupFailures,logProfile?.id??profile?.id??'') : startupFailure?.profileId===profile?.id ? startupFailure : core.latestStartupDiagnostic(supervisor.data?.startupFailures,profile?.id??'');
  // A failure recorded for a model that has since become ready (a slow load that finished on its own) is stale.
  const failureResolvedByReady = !!failureCandidate && failureCandidate.profileId===profile?.id && loaded;
  const shownStartupFailure = !localProgress && failureCandidate && !failureResolvedByReady && (resolvedStartupFailures[failureCandidate.profileId]??0)<failureCandidate.failedAt ? failureCandidate : undefined;
  const onStartupDiagnostic = (action: core.StartupDiagnosticAction, diagnostic: core.StartupFailureDiagnostic) => {
    const target = profiles.find(item => item.id === diagnostic.profileId);
    if (action === 'checkStatus') { if(target) void core.serviceStatus(target.id,target).then(async status=>{ if(status.running){const health=await core.request(target,'/health');if(health.loaded===true){setResolvedStartupFailures(old=>({...old,[target.id]:diagnostic.failedAt}));setStartupFailure(undefined);}}await query.invalidateQueries(); }).catch(error=>notify(errorText(error),true)); return; }
    if (action === 'viewLogs') { if(target) openServiceLogs(target); else go('tasks'); return; }
    if (action === 'exportDiagnostics') { if(target) void core.exportDiagnostics(target).then(path=>notify(`${t('diagnosticSaved')} ${path}`)).catch(error=>notify(errorText(error),true)); return; }
    if (action === 'openCredentials') { setConnectionProfileId(diagnostic.profileId); go('connections'); return; }
    if (action === 'openFiles') { go('environment'); return; }
    if (target) openModelConfig(target); else go('models');
  };
  return <div className="desktop-app-frame">{ready && showLanguageSetup && <LanguageSetupDialog settings={settings} onChange={setInterfaceLanguage} onConfirm={confirmLanguage}/>} {titleBar}<AppLayout sidebar={sidebarNode} collapsed={sidebarCollapsed}><WorkspaceLayout statusBar={statusBar}>{subnavigation}{shownStartupFailure && ["overview","models","profiles","tasks"].includes(page) && <StartupDiagnosticCard language={settings.language} diagnostic={shownStartupFailure} profileName={profiles.find(p=>p.id===shownStartupFailure.profileId)?.name} onAction={onStartupDiagnostic} disabled={!!busy || inferenceBusy}/>} {localProgress && ['overview','models','profiles','tasks'].includes(page) && <StartupProgress language={settings.language} progress={{...localProgress,startedAt:startupStartedAt,logs:startupLogs.data??[]}} modelName={startupTarget?.name} apiUrl={startupTarget?.baseUrl}/>} {page==='benchmark'?null:officialPage?pages[page]():<div className={`management-content management-content--${page}`}><div className="main-content">{runningServicePanel}{pages[page]()}</div></div>}<div hidden={page!=='benchmark'} className="management-content management-content--benchmark"><div className="main-content"><BenchmarkPage profile={profile} online={online && loaded} disabled={streaming || !!busy || !!localProgress || !!tasks.data?.some(task=>task.state==='running') || !!backgroundTuning.data?.some(job=>job && ['checking','running','canceling','applying','rollingBack'].includes(job.state)) || updateOwner!==null} language={settings.language} onRunningChange={setBenchmarkRunning} quickRunRequest={quickBenchmarkRequest}/></div></div></WorkspaceLayout>
    {toast&&<div className="st-toasts" id="toasts" aria-live="polite"><div className={`st-toast st-toast--${toast.error?'error':'success'}`} role={toast.error?'alert':'status'}><OfficialIcon name={toast.error?'error':'check'}/><div><div className="st-toast__title">{t(toast.error?'error':'success')}</div><span>{toast.text}</span>{toast.taskId && <div className="actions">{tasks.data?.find(task => task.id === toast.taskId) && taskNextActions(tasks.data.find(task => task.id === toast.taskId)!)}<button className="st-btn st-btn--secondary" onClick={() => go('tasks')}>{t('viewAllTasks')}</button></div>}</div><button className="st-btn st-btn--icon" aria-label={t('close')} onClick={()=>setToast(null)}><X size={16}/></button></div></div>}{busy&&<div className="busy-indicator" role="status"><LoaderCircle className="spin" size={14}/>{t('working')}</div>}
    {modal?.kind === 'modelProfiles' && <ModelProfilesDialog models={modal.models} disabled={!!busy} onClose={() => setModal(null)} onChoose={path => void act('taskProfile', () => openConfigProfile(path, modal.runtime))}/>}
    {modal?.kind === 'profile' && <ProfileDialog key={modal.profile?.id ?? 'new'} existing={modal.profile} onClose={() => setModal(null)} onSave={async (p, key) => { if (desktop) p = await core.renameLocalInstallation(p.id, p.name); if (key.trim()) await core.setApiKey(p.id, key.trim()); setProfiles(old => old.some(x => x.id === p.id) ? old.map(x => x.id === p.id ? p : x) : [...old, p]); if (!desktop && !profiles.some(item => item.id === p.id)) setActiveId(p.id); setModal(null); await query.invalidateQueries(); notify(t('saved')); }} choose={choose} native={desktop} errorText={errorText} />}
    {modal?.kind === 'rename' && <RenameDialog title={modal.conversation.title} onClose={() => setModal(null)} onSave={title => { const cid = modal.conversation.id; setConversations(old => old.map(c => c.id === cid ? { ...c, title, updatedAt: Date.now() } : c)); setModal(null); }} />}
    {modal?.kind === 'deleteConversation' && <Dialog title={t('deleteConversation')} onClose={() => setModal(null)}><p>{t('deleteConversationHint')}</p><div className="dialog-footer"><button onClick={() => setModal(null)}>{t('cancel')}</button><button className="danger-solid" onClick={() => { const cid = modal.conversation.id; setConversations(old => old.filter(c => c.id !== cid)); if (conversationId === cid) setConversationId('');setConversationIds(old=>Object.fromEntries(Object.entries(old).filter(([,value])=>value!==cid))); setModal(null); }}>{t('confirmDelete')}</button></div></Dialog>}
    {modal?.kind === 'request' && <Dialog title={t('requestDetails')} wide onClose={() => setModal(null)}><RequestViewer profile={profile} online={online} language={settings.language} pollInterval={settings.pollInterval} onEnableViewer={desktop && processStatus?.owned === true ? enableRequestViewer : undefined} onOpenUsage={()=>{setModal(null);go('usage');}} initialSelected={typeof object(modal.value).id==='string'?String(object(modal.value).id):undefined} noProfile={<NeedProfile/>} errorText={errorText} onError={error=>notify(errorText(error),true)} onMessage={notify}/></Dialog>}
    {modal?.kind === 'options' && <SamplingDrawer identityToken={`${processStatus?.pid}:${processStatus?.startedAt}:${healthData.loaded}:${healthData.model}`} key={`${profile?.id}:${profile?.baseUrl}:${profile?.configPath}`} profile={profile} options={options} inheritsCommon={inheritsCommon} onCommonSettings={()=>{setModal(null);go('chat-defaults');}} messages={conversation?.messages ?? []} metricsInfo={metric?.raw} preferences={chatPreferences} models={apiModels} hasProjection={hasProjection} online={online} mcpInfo={mcpQuery.data} onApply={(next, ui) => { setOptions(next); setChatPreferences(ui); notify(t('saved')); }} onClose={() => setModal(null)} onError={error => notify(errorText(error), true)} onMessage={notify} />}
    {modal?.kind==='deleteConfiguration'&&<ConfigurationDeletionDialog profile={modal.profile} language={settings.language} onClose={()=>setModal(null)} onDeleted={async deleted=>{if(configProfile?.configPath&&core.configurationPathKey(deleted.configPath)===core.configurationPathKey(configProfile.configPath))await configurationDeleted(deleted);await query.invalidateQueries();}}/>}
    {modal?.kind === 'vision' && <VisionSupportDialog key={`${modal.profile.id}:${modal.profile.configPath}`} profile={modal.profile} language={settings.language} onClose={()=>setModal(null)} onSaved={()=>query.invalidateQueries()} onRestart={modal.profile.id===activeId && processStatus?.owned && processStatus.running && !busy && !inferenceBusy && !localProgress ? ()=>restartSelectedService(modal.profile) : undefined}/>}
    {windowClose.dialog}
    {navigationGuard.dialog}
    {!modal && (appUpdates.dialogOpen ? <AppUpdateDialog language={settings.language} state={appUpdates.state} idle={automaticUpdatesIdle && updateOwner !== 'runtime'} onConfirm={appUpdates.confirm} onClose={appUpdates.dismiss}/> : runtimeUpdates.dialog)}
  </AppLayout></div>;
}

function ProfileDialog({ existing, onClose, onSave, errorText }: { existing?: ServiceProfile; onClose: () => void; onSave: (profile: ServiceProfile, key: string) => Promise<void>; choose: (directory: boolean) => Promise<string | null>; native: boolean; errorText: (error: unknown) => string }) {
  const { t } = useTranslation();
  const [value, setValue] = useState<ServiceProfile>(existing ?? { id: id(), name: '', baseUrl: 'http://127.0.0.1:8080', installDir: '', pythonPath: '', configPath: '', managed: false });
  const [key, setKey] = useState(''); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const update = <K extends keyof ServiceProfile>(field: K, input: ServiceProfile[K]) => setValue(old => ({ ...old, [field]: input }));
  const submit = async () => {
    if (!value.name.trim()) { setError(t('nameRequired')); return; }
    try { core.normalizeBaseUrl(value.baseUrl); } catch { setError(t('addressInvalid')); return; }
    if (value.managed && (!value.installDir.trim() || !value.configPath.trim())) { setError(t('managedPathsRequired')); return; }
    setSaving(true); setError(''); try { await onSave({ ...value, name: value.name.trim(), baseUrl: value.baseUrl.trim().replace(/\/$/, '') }, key); } catch (err) { setError(errorText(err)); } finally { setSaving(false); }
  };
  return <Dialog title={t('editProfile')} onClose={() => { if (!saving) onClose(); }}><form noValidate onSubmit={event => { event.preventDefault(); void submit(); }}><Field label={t('name')}><input autoFocus value={value.name} onChange={event => update('name', event.target.value)} required /></Field><Field label={t('baseUrl')}><code>{value.baseUrl}</code></Field><Field label={t('apiKey')}><input type="password" autoComplete="new-password" placeholder={t('keyPlaceholder')} value={key} onChange={event => setKey(event.target.value)} /></Field>{error && <div className="notice error" role="alert">{error}</div>}<div className="dialog-footer"><button type="button" disabled={saving} onClick={onClose}>{t('cancel')}</button><button className="primary" type="submit" disabled={saving || !existing}>{saving ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{t('save')}</button></div></form></Dialog>;
}
function ModelProfilesDialog({ models, disabled, onClose, onChoose }: { models: core.LocalModel[]; disabled: boolean; onClose: () => void; onChoose: (path: string) => void }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(models[0]?.configPath ?? '');
  return <Dialog title={t('choosePreparedModel')} onClose={onClose}><Field label={t('model')}><Dropdown ariaLabel={t('model')} value={selected} disabled={disabled} onValueChange={setSelected} options={models.map(model => ({ value: model.configPath, label: model.name }))}/></Field><code>{selected}</code><div className="dialog-footer"><button disabled={disabled} onClick={onClose}>{t('cancel')}</button><button className="primary" disabled={disabled || !selected} onClick={() => onChoose(selected)}>{t('createProfile')}</button></div></Dialog>;
}
function RenameDialog({ title, onClose, onSave }: { title: string; onClose: () => void; onSave: (title: string) => void }) { const { t } = useTranslation(); const [value, setValue] = useState(title); return <Dialog title={t('renameConversation')} onClose={onClose}><form noValidate onSubmit={event => { event.preventDefault(); if (value.trim()) onSave(value.trim()); }}><Field label={t('conversationTitle')}><input autoFocus value={value} onChange={event => setValue(event.target.value)} required /></Field><div className="dialog-footer"><button type="button" onClick={onClose}>{t('cancel')}</button><button className="primary" disabled={!value.trim()}>{t('save')}</button></div></form></Dialog>; }
