import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Activity, ArrowRight, ArrowUp, BookOpen, Bot, Check, ChevronDown, Circle, Download, FileText, FolderOpen, Globe2, HardDrive, Image, LayoutDashboard, LoaderCircle, Menu, MessageSquare, Moon, MoreHorizontal, Plus, RefreshCw, Search, Send, Server, Settings2, ShieldCheck, SlidersHorizontal, Square, Sun, Terminal, Trash2, Upload, X, Zap } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import * as core from '@strata-manager/core';
import type { AppSettings, Attachment, ChatMessage, Conversation, ServiceProfile, TaskStatus, JsonObject, ChatOptions, ToolEvent } from '@strata-manager/core';
import i18n, { type TextKey } from './i18n';
import { Badge, Chart, Dialog, Empty, Field, Header, JsonView, Metric, OfficialIcon, Panel } from './components';
import { SamplingDrawer, officialSamplingDefaults, defaultChatPreferences, type ChatPreferences } from './ChatSettings';
import { ChatPage } from './pages/ChatPage';
import { OverviewPage } from './pages/OverviewPage';
import { Onboarding, type DiscoveredService, type GuidePath } from './Onboarding';
import { RuntimeConfigPage } from './pages/RuntimeConfigPage';
import { ServiceManagerPage } from './pages/ServiceManagerPage';
import { RequestViewer } from './RequestViewer';
import { MonitoringPage } from './OfficialMonitoring';
import { AboutPage } from './OfficialAbout';
import { AppLayout, Sidebar } from './layouts/AppLayout';
import { WorkspaceHeader, WorkspaceLayout, WorkspaceStatusBar } from './layouts/WorkspaceLayout';
import { LocalSetupPage, type LocalSetupProgress } from './pages/LocalSetupPage';
import { DesktopLifecycleSettings } from './pages/DesktopLifecycleSettings';
import { useAppUpdates } from './useAppUpdates';
import { TuningPage } from './pages/TuningPage';
import { ApiUsagePage } from './pages/ApiUsagePage';
import { OverviewUsage } from './pages/OverviewUsage';
import { InstallRuntimePage } from './pages/InstallRuntimePage';
import { SetupHandoffActions } from './pages/SetupHandoffActions';
import strataLicense from './official/LICENSE.strata?raw';
import outfitLicense from './fonts/OFL.txt?raw';
import { Dropdown, NumberField, Segmented, Toggle } from './OfficialControls';

type Page = 'overview' | 'profiles' | 'models' | 'localSetup' | 'tuning' | 'chat' | 'monitoring' | 'usage' | 'requests' | 'tasks' | 'environment' | 'settings' | 'about' | 'config';
const navigation: { id: Page; icon: typeof Activity }[] = [{ id: 'overview', icon: LayoutDashboard }, { id: 'models', icon: HardDrive }, { id: 'chat', icon: MessageSquare }, { id: 'tuning', icon: SlidersHorizontal }, { id: 'monitoring', icon: Activity }, { id: 'settings', icon: Settings2 }];
const routePage=(hash:string):Page=>{const value=hash.slice(1);return value==='monitor'?'monitoring':([...navigation.map(item=>item.id),'profiles','localSetup','usage','requests','tasks','environment','about','config'] as string[]).includes(value)?value as Page:'overview';};
const parentPage=(page:Page):Page=>['profiles','localSetup'].includes(page)?'models':['usage','requests','tasks'].includes(page)?'monitoring':['environment','about','config'].includes(page)?'settings':page;
const defaults: AppSettings = { language: 'zh-CN', theme: 'system', closeToTray: false, pollInterval: 3000, autoCheckUpdates: true };
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
type Recipe = { kind: 'setup'; profile: ServiceProfile; model: string; quant: string; context: number; images: boolean } | { kind: 'install'; directory: string } | { kind: 'update'; profile: ServiceProfile };
type Modal = { kind: 'profile'; profile?: ServiceProfile } | { kind: 'modelProfiles'; models: core.LocalModel[]; runtime: ServiceProfile } | { kind: 'rename'; conversation: Conversation } | { kind: 'deleteConversation'; conversation: Conversation } | { kind: 'request'; value: unknown } | { kind: 'options' } | null;

export function App() {
  const { t: translate } = useTranslation();
  const t = (key: TextKey) => translate(key);
  const desktop = core.isDesktop();
  const query = useQueryClient();
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState('');
  const [bootAttempt, setBootAttempt] = useState(0);
  const [page, setPage] = useState<Page>(()=>!location.hash && new URLSearchParams(location.search).has('q') ? 'chat' : routePage(location.hash));
  const [guideOpen, setGuideOpen] = useState(true);
  const [guidePath, setGuidePath] = useState<GuidePath>(null);
  const [discovery, setDiscovery] = useState<{ busy: boolean; searched: boolean; services: DiscoveredService[] }>({ busy: false, searched: false, services: [] });
  const [sidebarCollapsed,setSidebarCollapsed]=useState(false);
  const [profiles, setProfiles] = useState<ServiceProfile[]>([]);
  const [activeId, setActiveId] = useState('');
  const [settings, setSettings] = useState<AppSettings>(defaults);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState('');
  const [conversationIds,setConversationIds]=useState<Record<string,string>>({});
  const [profileOptions, setProfileOptions] = useState<Record<string, ChatOptions>>({});
  const [chatPreferences, setChatPreferences] = useState<ChatPreferences>(defaultChatPreferences);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [showAllRequests, setShowAllRequests] = useState(false);
  const [recipes, setRecipes] = useState<Record<string, Recipe>>({});
  const observedTasks = useRef<Map<string, TaskStatus['state']> | null>(null);
  const [preparationRuntime, setPreparationRuntime] = useState<ServiceProfile | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState('');
  const [localProgress, setLocalProgress] = useState<LocalSetupProgress>();
  const preparingLocal = useRef(false);
  const preparationGeneration = useRef(0);
  const automaticallyPrepared = useRef(new Set<string>());
  const maySelectFirstPrepared = useRef(false);
  const exporting = useRef(false);
  const [toast, setToast] = useState<{ text: string; error?: boolean; taskId?: string } | null>(null);
  const [draft, setDraft] = useState(()=>new URLSearchParams(location.search).get('q')??'');
  const initialPromptPending=useRef(new URLSearchParams(location.search).has('q'));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const appUpdates = useAppUpdates(desktop, settings.autoCheckUpdates !== false, ready);
  const [installDirectory, setInstallDirectory] = useState('');
  const [logSearch, setLogSearch] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [samples, setSamples] = useState<{ decode: (number | null)[]; gpu: (number | null)[] }>({ decode: [], gpu: [] });
  const abort = useRef<AbortController | null>(null);
  const conversationsRef = useRef(conversations); conversationsRef.current = conversations;
  const profile = profiles.find(item => item.id === activeId);
  const modelRuntime = preparationRuntime ?? profile;
  const logProfile: ServiceProfile | undefined = selectedTaskId ? { ...(profile ?? { name: '', baseUrl: 'http://127.0.0.1:8080', installDir: '', pythonPath: '', managed: false }), id: selectedTaskId, configPath: '' } : profile;
  const conversation = conversations.find(item => item.id === conversationId);
  const options = profileOptions[activeId] ?? defaultOptions;
  const setOptions = (next: ChatOptions) => setProfileOptions(old => ({ ...old, [activeId]: next }));
  const serviceState = (state: string) => {
    const keys: Record<string, TextKey> = { idle: 'idleState', reading: 'readingState', prefill: 'readingState', generating: 'generatingState', loading: 'loadingState', unloading: 'unloadingState', running: 'running', pending: 'pendingState', completed: 'completed', done: 'completed', writing: 'generatingState', cancelled: 'cancelled', skipped: 'skippedState', failed: 'failed', error: 'error', unknown: 'unknown', queued: 'queuedState', disconnected: 'disconnectedState', preparing: 'preparingState' };
    return keys[state] ? t(keys[state]!) : state;
  };

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
  const copy = async (content: string) => { try { await navigator.clipboard.writeText(content); notify(t('copied')); return true; } catch { notify(t('clipboardUnavailable'), true); return false; } };
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
    void Promise.all([desktop ? core.localInstallations() : core.loadStore<ServiceProfile[]>('profiles', []), core.loadStore<AppSettings>('settings', defaults), core.loadStore<Conversation[]>('conversations', []), core.loadStore<string>('activeProfile', ''), core.loadStore<Record<string, ChatOptions>>('chatOptionsByProfile', {}), core.loadStore<Record<string, Recipe>>('taskRecipes', {}), core.loadStore<ChatPreferences>('chatPreferences', defaultChatPreferences),core.loadStore<Record<string,string>>('activeConversationIds',{}),core.loadStore<boolean>('sidebarCollapsed',false),core.loadStore<boolean>('onboardingOpen',true)]).then(([p, s, c, a, o, r, ui, ids, collapsed, guide]) => {
      if (!mounted) return; maySelectFirstPrepared.current = p.length === 0; setGuideOpen(guide); setSidebarCollapsed(collapsed); setProfiles(p); setSettings({ ...defaults, ...s }); setConversations(c); setActiveId(p.some(x => x.id === a) ? a : p[0]?.id ?? ''); setProfileOptions(o); setRecipes(r);setConversationIds(ids);const selectedProfile=p.some(x=>x.id===a)?a:p[0]?.id??'';setConversationId(c.find(x=>x.id===ids[selectedProfile]&&x.profileId===selectedProfile)?.id??c.find(x=>x.profileId===selectedProfile)?.id??''); setChatPreferences({ ...defaultChatPreferences, ...ui }); setPreferencesReady(true); setReady(true);
      if (desktop) void core.applySettings({ ...defaults, ...s }).catch(error => notify(errorText(error), true));
    }).catch(error => { if (mounted) setBootError(errorText(error)); });
    return () => { mounted = false; abort.current?.abort(); };
  }, [bootAttempt]);
  useEffect(() => { if (ready && profiles.length) maySelectFirstPrepared.current = false; }, [ready, profiles.length]);
  useEffect(() => { if (!ready) return; void Promise.all([...(desktop ? [] : [core.saveStore('profiles', profiles)]), core.saveStore('settings', settings), core.saveStore('activeProfile', activeId), core.saveStore('chatOptionsByProfile', profileOptions), core.saveStore('taskRecipes', recipes),core.saveStore('activeConversationIds',conversationIds),core.saveStore('sidebarCollapsed',sidebarCollapsed),core.saveStore('onboardingOpen',guideOpen)]).catch(error => notify(errorText(error), true)); }, [ready, profiles, settings, activeId, profileOptions, recipes,conversationIds,sidebarCollapsed,guideOpen]);
  useEffect(() => { if (preferencesReady) void core.saveStore('chatPreferences', chatPreferences).catch(error => notify(errorText(error), true)); }, [preferencesReady, chatPreferences]);
  useEffect(() => { if (ready && !streaming) void core.saveStore('conversations', conversations).catch(error => notify(errorText(error), true)); }, [ready, conversations, streaming]);
  useEffect(()=>{if(ready)setConversationId(conversations.find(c=>c.id===conversationIds[activeId]&&c.profileId===activeId)?.id??conversations.find(c=>c.profileId===activeId)?.id??'');},[ready,activeId]);
  useEffect(() => { if (!ready || !streaming) return; const persist = () => { void core.saveStore('conversations', conversationsRef.current).catch(error => notify(errorText(error), true)); }; persist(); const timer = setInterval(persist, 1000); return () => clearInterval(timer); }, [ready, streaming]);
  useEffect(() => { void i18n.changeLanguage(settings.language); document.documentElement.lang = settings.language; const media = matchMedia('(prefers-color-scheme: dark)'); const apply = () => { document.documentElement.dataset.theme = settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : settings.theme; }; apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply); }, [settings.language, settings.theme]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), toast.error ? 10000 : 4500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { setSamples({ decode: [], gpu: [] }); }, [activeId, profile?.baseUrl]);


  const health = useQuery({ queryKey: ['health', activeId, profile?.baseUrl], queryFn: () => core.request(profile!, '/health'), enabled: ready && !!profile, refetchInterval: settings.pollInterval });
  const healthData = object(health.data);
  const online = health.isSuccess;
  const loaded = online && healthData.loaded === true;
  const supportsImages = online && healthData.images === true;
  const process = useQuery({ queryKey: ['process', activeId, profile?.baseUrl, profile?.configPath, profile?.pythonPath, profile?.managed], queryFn: () => core.serviceStatus(activeId, profile), enabled: desktop && !!profile, refetchInterval: Math.max(10000,settings.pollInterval), refetchOnWindowFocus: false });
  const chatReady = online && (!desktop || (loaded && process.data?.owned === true && process.data?.running === true && !localProgress));
  const metrics = useQuery({ queryKey: ['metrics', activeId, profile?.baseUrl, showAllRequests], queryFn: async () => core.normalizeMetrics(await core.request(profile!, `/metrics${showAllRequests ? '?requests=all' : ''}`)), enabled: !!profile && online && (page === 'overview' || page === 'monitoring' || page === 'chat' || page === 'about' || page === 'config'), refetchInterval: settings.pollInterval });
  const metric = online ? metrics.data : undefined;
  const projection = object(metric?.raw.engine).cvec;
  const hasProjection = !!projection && projection !== '0';
  const mcpQuery = useQuery({ queryKey: ['mcp', activeId, profile?.baseUrl], queryFn: () => core.request(profile!, '/mcp'), enabled: !!profile && online && (page === 'monitoring' || page === 'chat' || modal?.kind === 'options'), refetchInterval: settings.pollInterval });
  useEffect(() => { if (metric) setSamples(old => ({ decode: [...old.decode, metric.decodeTokS].slice(-60), gpu: [...old.gpu, metric.gpuUtil].slice(-60) })); }, [metric]);
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: core.listTasks, enabled: desktop && ready, refetchInterval: settings.pollInterval, refetchIntervalInBackground: true });
  const handoffs = useQuery({ queryKey: ['setupHandoffs'], queryFn: core.listSetupHandoffs, enabled: desktop && ready, refetchInterval: settings.pollInterval, refetchIntervalInBackground: true });
  const registeredSetupTasks = handoffs.data?.filter(item => item.status === 'registered').map(item => item.taskId).sort().join(',') ?? '';
  const finishedRuntimeUpdates = tasks.data?.filter(task => task.kind.includes('update') && task.state !== 'running').map(task => `${task.id}:${task.state}`).sort().join(',') ?? '';
  const preparedProfiles = useQuery({ queryKey: ['setupRegistrations', registeredSetupTasks, finishedRuntimeUpdates], queryFn: core.localInstallations, enabled: desktop && ready && !!(registeredSetupTasks || finishedRuntimeUpdates), refetchOnWindowFocus: false });
  useEffect(() => {
    if (!ready || !preparedProfiles.data) return;
    const firstPrepared = maySelectFirstPrepared.current ? preparedProfiles.data.find(item => handoffs.data?.some(handoff => handoff.status === 'registered' && handoff.profileId === item.id)) : undefined;
    if (preparedProfiles.data.length) maySelectFirstPrepared.current = false;
    setProfiles(preparedProfiles.data);
    if (firstPrepared) setActiveId(current => current || firstPrepared.id);
  }, [ready, preparedProfiles.data]);
  const supervisor = useQuery({ queryKey: ['supervisor'], queryFn: core.supervisorStatus, enabled: desktop && ready, refetchInterval: 10000, refetchOnWindowFocus: false });
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
  const logs = useQuery({ queryKey: ['logs', selectedTaskId || activeId], queryFn: () => core.readLogs(logProfile!, 2000), enabled: desktop && !!logProfile && page === 'tasks', refetchInterval: settings.pollInterval });
  const environment = useQuery({ queryKey: ['environment'], queryFn: core.environmentInfo, enabled: desktop && page === 'environment' });
  const localModels = useQuery({ queryKey: ['localModels', modelRuntime?.id, modelRuntime?.installDir, modelRuntime?.configPath], queryFn: () => core.listLocalModels(modelRuntime!), enabled: desktop && !!modelRuntime?.installDir && page === 'models' });
  const availableModels = useQuery({ queryKey: ['availableModels', activeId, profile?.baseUrl], queryFn: () => core.request(profile!, '/v1/models'), enabled: !!profile && online && page === 'chat' });
  const apiModels = Array.isArray(object(availableModels.data).data) ? (object(availableModels.data).data as unknown[]).map(x => String(object(x).id ?? '')).filter(Boolean) : [];

  const choose = async (directory: boolean): Promise<string | null> => {
    if (!desktop) return null;
    try { const { open } = await import('@tauri-apps/plugin-dialog'); const selected = await open({ directory, multiple: false }); return typeof selected === 'string' ? selected : null; } catch (error) { notify(errorText(error), true); return null; }
  };
  const discoverServices = async () => {
    if (discovery.busy) return;
    setDiscovery({ busy: true, searched: false, services: [] });
    const configuredPorts = profiles.flatMap(saved => {
      try { const url = new URL(saved.baseUrl); return url.hostname === 'localhost' || /^127\./.test(url.hostname) ? [Number(url.port || (url.protocol === 'https:' ? 443 : 80))] : []; }
      catch { return []; }
    });
    const ports = [...new Set([8080, 18081, ...configuredPorts])].slice(0, 4);
    const results = await Promise.allSettled(ports.map(async port => {
      const candidate: ServiceProfile = { id: id(), name: 'Strata', baseUrl: `http://127.0.0.1:${port}`, installDir: '', configPath: '', pythonPath: '', managed: false };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const health = await Promise.race([core.request(candidate, '/health', 'GET'), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Service discovery timed out')), 3000); })]);
        if (health.service !== 'strata' || health.status !== 'ok' || typeof health.loaded !== 'boolean' || typeof health.images !== 'boolean' || typeof health.model !== 'string' || typeof health.max_context !== 'number' || !Number.isFinite(health.max_context)) return null;
        return { baseUrl: candidate.baseUrl, health };
      } finally { clearTimeout(timer); }
    }));
    setDiscovery({ busy: false, searched: true, services: results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []) });
  };
  const connectDiscovered = (service?: DiscoveredService) => {
    const existing = service && profiles.find(saved => { try { return core.normalizeBaseUrl(saved.baseUrl) === service.baseUrl; } catch { return false; } });
    if (existing) { setActiveId(existing.id); return; }
    setModal({ kind: 'profile', profile: { id: id(), name: service ? String(service.health.model || 'Strata') : 'Strata', baseUrl: service?.baseUrl ?? 'http://127.0.0.1:8080', installDir: '', configPath: '', pythonPath: '', managed: false } });
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
  const go=(next:Page)=>{setPage(next);const hash=`#${next==='monitoring'?'monitor':next}`;if(location.hash!==hash)history.pushState(null,'',`${location.pathname}${location.search}${hash}`);};
  const prepareImported = async (candidate: core.LocalCandidate) => {
    if (preparingLocal.current || streaming) throw new Error(t('busyHint'));
    preparingLocal.current = true;
    const generation = ++preparationGeneration.current;
    setLocalProgress({ phase: 'importing' });
    try {
      const imported = await core.importLocal(candidate);
      setLocalProgress({ phase: 'starting', message: t('preparingLocal') });
      await core.ensureLocalService(imported.id);
      automaticallyPrepared.current.add(imported.id);
      setProfiles(old => old.some(item => item.id === imported.id) ? old.map(item => item.id === imported.id ? imported : item) : [...old, imported]);
      setActiveId(imported.id);
      setPreparationRuntime(null);
      await query.invalidateQueries();
    } catch (error) {
      notify(errorText(error), true);
      throw error;
    } finally {
      if (generation === preparationGeneration.current) { preparingLocal.current = false; setLocalProgress(undefined); }
    }
  };
  const activateLocal = async (selected: ServiceProfile) => {
    if (!desktop) { setActiveId(selected.id); return; }
    if (streaming || preparingLocal.current) throw new Error(t('busyHint'));
    const generation = ++preparationGeneration.current;
    preparingLocal.current = true;
    setLocalProgress({ phase: 'starting', message: t('preparingLocal') });
    try {
      await core.switchLocalService(selected.id);
      automaticallyPrepared.current.add(selected.id);
      setActiveId(selected.id);
      await query.invalidateQueries();
    } finally {
      if (generation === preparationGeneration.current) { preparingLocal.current = false; setLocalProgress(undefined); }
    }
  };
  useEffect(() => {
    if (!desktop || !ready || !profile?.managed || !profile.installDir || !profile.configPath || automaticallyPrepared.current.has(profile.id) || preparingLocal.current) return;
    automaticallyPrepared.current.add(profile.id);
    preparingLocal.current = true;
    const generation = ++preparationGeneration.current;
    setLocalProgress({ phase: 'starting', message: t('preparingLocal') });
    void core.ensureLocalService(profile.id).then(() => query.invalidateQueries()).catch(error => { automaticallyPrepared.current.delete(profile.id); notify(errorText(error), true); }).finally(() => { if (generation === preparationGeneration.current) { preparingLocal.current = false; setLocalProgress(undefined); } });
  }, [desktop, ready, profile?.id]);
  const renderLocalSetup = () => <LocalSetupPage language={settings.language} desktop={desktop} progress={localProgress} onDiscover={core.discoverLocal} onChooseDirectory={() => choose(true)} onImport={prepareImported} onInstall={() => go('environment')} onChat={() => conversation ? go('chat') : addConversation()}/>;
  useEffect(()=>{const change=()=>setPage(routePage(location.hash));window.addEventListener('hashchange',change);window.addEventListener('popstate',change);return()=>{window.removeEventListener('hashchange',change);window.removeEventListener('popstate',change);};},[]);
  const nativeTitle = desktop ? undefined : t('nativeRequired');
  const addConversation = () => {
    if (!profile || streaming) return;
    const item: Conversation = { id: id(), title: t('unnamed'), profileId: profile.id, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    setConversations(old => [item, ...old]); setConversationId(item.id);setConversationIds(old=>({...old,[profile.id]:item.id})); setDraft(''); setAttachments([]); go('chat');
  };
  const selectConversation = (item: Conversation) => {
    if (streaming || preparingLocal.current) return;
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
    if (!profile || !chatReady || streaming || (!draft.trim() && !attachments.length)) return;
    if (attachments.some(a => a.type === 'image') && !supportsImages) { notify(t('imageUnavailable'), true); return; }
    if (conversation && conversation.profileId !== profile.id) { notify(t('conversationOtherProfile'), true); return; }
    const user: ChatMessage = { id: id(), role: 'user', content: draft.trim(), attachments: [...attachments], createdAt: Date.now() };
    const assistant: ChatMessage = { id: id(), role: 'assistant', content: '', createdAt: Date.now() };
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
      const body = core.buildChatRequest([...previous.filter(m => !m.error), user], { ...options, model: selectedModel, mcp: options.mcp && mcpAvailable, images: supportsImages, experimentalSpeedProjection: hasProjection ? options.experimentalSpeedProjection !== false : undefined });
      await core.streamChat(profile, body, delta => {
        if(delta.reasoning && thinkingStarted===undefined) thinkingStarted=performance.now();
        if(delta.content && firstTokenMs===undefined) {firstTokenMs=performance.now()-started;if(thinkingStarted!==undefined)reasoningMs=performance.now()-thinkingStarted;}
        updateMessage(cid, assistant.id, message => {
          const next = { ...message, content: message.content + (delta.content ?? ''), reasoning: (message.reasoning ?? '') + (delta.reasoning ?? '') };
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
    finally { updateMessage(cid, assistant.id, message => ({ ...message, elapsedMs: performance.now() - started, firstTokenMs, reasoningMs: reasoningMs ?? (thinkingStarted===undefined ? undefined : performance.now()-thinkingStarted), stopped: controller.signal.aborted, tools: message.tools?.map(tool=>['writing','running'].includes(tool.status)?{...tool,status:'skipped'}:tool) })); setStreaming(false); abort.current = null; }
  };
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
    const task = recipe.kind === 'setup' ? await core.runSetup(recipe.profile, recipe.model, recipe.quant, recipe.context, recipe.images) : recipe.kind === 'install' ? await core.installRuntime(recipe.directory) : await core.updateRuntime(recipe.profile);
    observedTasks.current ??= new Map();
    observedTasks.current.set(task.id, task.state);
    setRecipes(old => ({ ...old, [task.id]: recipe })); return task;
  };
  const openConfigProfile = async (configPath: string, previous?: ServiceProfile) => {
    const directory = previous?.installDir || configPath.slice(0, Math.max(configPath.lastIndexOf('\\'), configPath.lastIndexOf('/')));
    const found = await core.discoverLocal([directory]);
    const canonical = (value: string) => value.replace(/\\/g, '/').toLocaleLowerCase();
    const candidate = found.find(item => canonical(item.configPath) === canonical(configPath));
    if (!candidate) throw new Error(t('localSetupNothingFoundHint'));
    await prepareImported(candidate);
    setModal(null);
  };
  const selectPreparationRuntime = (directory: string) => {
    setPreparationRuntime({ id: id(), name: 'Strata', baseUrl: 'http://127.0.0.1:8080', installDir: directory, configPath: '', pythonPath: '', managed: true });
    go('models');
  };
  const createTaskProfile = async (recipe: Recipe) => {
    const runtime: ServiceProfile = recipe.kind === 'install'
      ? { id: id(), name: 'Strata', baseUrl: 'http://127.0.0.1:8080', installDir: recipe.directory, configPath: '', pythonPath: '', managed: true }
      : recipe.profile;
    const models = await core.listLocalModels({ ...runtime, configPath: '' });
    if (!models.length) { selectPreparationRuntime(runtime.installDir); notify(t('prepareBeforeProfile')); return; }
    if (recipe.kind === 'setup') {
      // setup.py FAMILIES.name determines model_name; verify it against actual discovered configs.
      const familyNames: Record<string, string> = { qwen: 'qwen3.8-flash-next', swift: 'swift-1.5', coder: 'qwen3.8-flash-next-coder', unsloth: 'qwen3.8-flash-next-unsloth' };
      const expected = `${familyNames[recipe.model]}-${recipe.quant.toLowerCase()}`;
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
    if (handoff) return <SetupHandoffActions handoff={handoff} canRecheck={task.state === 'completed'} disabled={!!busy || streaming || !!localProgress} onResolve={async path => { await core.resolveSetupHandoff(task.id, path); await query.invalidateQueries(); }} onUse={async profileId => { const registered = await core.localInstallations(); const selected = registered.find(item => item.id === profileId); if (!selected) throw new Error(t('noProfileHint')); setProfiles(registered); await activateLocal(selected); go('chat'); }} onView={() => go('profiles')} onError={error => notify(errorText(error), true)}/>;
    const recipe = recipes[task.id];
    if (task.state !== 'completed' || !recipe || recipe.kind === 'update') return null;
    return <>{recipe.kind === 'install' && <button className="st-btn st-btn--secondary" disabled={streaming} onClick={() => selectPreparationRuntime(recipe.directory)}>{t('prepareModels')}</button>}<button className="st-btn st-btn--secondary" disabled={!!busy || streaming || !!localProgress} onClick={() => void act('taskProfile', () => createTaskProfile(recipe))}>{t('usePreparedModel')}</button></>;
  };
  const diagnostics = () => { if (profile) void act('diagnostics', async () => { const path = await core.exportDiagnostics(profile); notify(`${t('diagnosticSaved')} ${path}`); }); };

  const ErrorBlock = ({ error }: { error: unknown }) => error ? <div className="notice error" role="alert">{errorText(error)}</div> : null;
  const NeedProfile = () => <Empty title={t('noProfile')} hint={t('localSetupIntro')}><button className="primary" onClick={() => go('localSetup')}><FolderOpen size={16} />{t('localSetupTitle')}</button></Empty>;
  const serviceActions = <div className="actions service-actions">
    <button title={nativeTitle} disabled={!desktop || !profile?.managed || !!busy || !!localProgress || (process.data?.owned === true && loaded)} onClick={() => profile && void act('start', () => activateLocal(profile), 'success')}><Zap size={15} />{t('start')}</button>
    <button title={nativeTitle} disabled={!desktop || !profile?.managed || !!busy || (process.data?.running !== true || process.data?.owned !== true)} onClick={() => void act('stop', () => core.stopService(activeId), 'success')}><Square size={14} />{t('stop')}</button>
    <button disabled={!profile || !online || loaded || !!busy || (desktop && process.data?.owned !== true)} onClick={() => profile && void act('load', () => core.request(profile, '/load', 'POST', {}), 'success')}><Upload size={15} />{t('load')}</button>
    <button disabled={!profile || !online || !loaded || !!busy || (desktop && process.data?.owned !== true)} onClick={() => profile && void act('unload', () => core.request(profile, '/unload', 'POST', {}), 'success')}><Download size={15} />{t('unload')}</button>
  </div>;

  const guideTasks = [...(tasks.data ?? [])].sort((a, b) => b.startedAt - a.startedAt);
  const latestInstallRecipe = guideTasks.map(task => recipes[task.id]).find(recipe => recipe?.kind === 'install');
  const guideDirectory = installDirectory || preparationRuntime?.installDir || (profile?.managed ? profile.installDir : '') || (latestInstallRecipe?.kind === 'install' ? latestInstallRecipe.directory : '');
  const guideInstallTask = guideTasks.find(task => { const recipe = recipes[task.id]; return recipe?.kind === 'install' && recipe.directory === guideDirectory; });
  const guideSetupTask = guideTasks.find(task => { const recipe = recipes[task.id]; return recipe?.kind === 'setup' && recipe.profile.installDir === guideDirectory; });
  const guideConfigured = !!profile?.managed && !!profile.configPath && profile.installDir === guideDirectory;
  const guideService = () => {
    if (!profile || !online && (!desktop || !profile.managed || process.data?.running === true)) { go('profiles'); return; }
    if (online && !loaded) { void act('load', () => core.request(profile, '/load', 'POST', {}), 'success'); return; }
    if (!online && desktop && profile.managed) { void act('start', () => core.startService(profile), 'success'); return; }
    go('profiles');
  };
  const guidePrepare = () => { if (guideDirectory) selectPreparationRuntime(guideDirectory); else { go('environment'); notify(t('runtimePathRequired')); } };
  const guideCreateProfile = () => {
    const recipe = guideSetupTask?.state === 'completed' ? recipes[guideSetupTask.id] : undefined;
    if (recipe) { void act('taskProfile', () => createTaskProfile(recipe)); return; }
    if (guideDirectory) { void act('taskProfile', () => createTaskProfile({ kind: 'install', directory: guideDirectory })); return; }
    go('models');
  };
  const renderOverviewPage=()=> !profile ? renderLocalSetup() : <OverviewPage profile={profile} health={healthData} backgroundHealth={supervisor.data?.health?.[profile.id]} metric={metric} process={process.data} tasks={tasks.data??[]} tasksLoading={tasks.isPending} language={settings.language} online={online} connecting={!!localProgress || health.isFetching&&!health.data} desktop={desktop} healthError={health.error?errorText(health.error):undefined} metricsError={metrics.error?errorText(metrics.error):undefined} taskError={tasks.error?errorText(tasks.error):undefined} processError={process.error?errorText(process.error):supervisor.data?.preparationFailures?.find(item=>item.profileId===profile.id)?.lastError} controls={serviceActions} usage={<OverviewUsage key={profile.id} profile={profile} language={settings.language} desktop={desktop} onOpen={()=>go('usage')} onCopy={content=>void copy(content)}/>} stateLabel={serviceState} onRefresh={()=>void query.invalidateQueries()} onCreateProfile={()=>go('localSetup')} onChat={()=>conversation?go('chat'):addConversation()} onNavigate={go}/>;

  const operateService = async (action: () => Promise<unknown>) => { await action(); await query.invalidateQueries(); notify(t('success')); };
  const servicePage = async (p: ServiceProfile, next: Page) => {
    if (p.id !== activeId) await activateLocal(p);
    if (next === 'tasks') setSelectedTaskId('');
    go(next);
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
  const ProfilesPage = () => <ServiceManagerPage profiles={profiles} activeId={activeId} language={settings.language} desktop={desktop} pollInterval={settings.pollInterval} streaming={streaming} busyProfileIds={busy || tasks.data?.some(task => task.state === 'running' && task.kind.includes('update')) ? profiles.map(p=>p.id) : []}
    onSelect={activateLocal} onAdd={()=>go('localSetup')} onImport={()=>go('localSetup')}
    onEdit={p=>setModal({kind:'profile',profile:p})} onDelete={removeService}
    onStart={p=>operateService(()=>activateLocal(p))} onStop={p=>operateService(()=>core.stopService(p.id))} onRestart={p=>operateService(()=>core.restartService(p))} onTakeover={p=>operateService(()=>activateLocal(p))}
    onUpdate={async p => { const task = await runRecipe({ kind: 'update', profile: p }); setSelectedTaskId(task.id); await query.invalidateQueries({ queryKey: ['tasks'] }); go('tasks'); }}
    onLoad={p=>operateService(()=>core.request(p,'/load','POST',{}))} onUnload={p=>operateService(()=>core.request(p,'/unload','POST',{}))}
    onConfig={p=>servicePage(p,'config')} onLogs={p=>servicePage(p,'tasks')} onChat={p=>servicePage(p,'chat')}
    onOnboarding={()=>go('localSetup')} onEnvironment={()=>go('environment')} onInstall={()=>go('environment')}
    onError={error=>notify(errorText(error),true)}/>;

  const ModelsPage = () => <><Header title={t('officialModels')} hint={t('catalogHint')}><button title={nativeTitle} disabled={!desktop || streaming || !!busy} onClick={() => void choose(true).then(directory => directory && selectPreparationRuntime(directory))}><FolderOpen size={15}/>{t('selectRuntime')}</button><button title={nativeTitle} disabled={!desktop || streaming || !!busy} onClick={() => void act('import', async () => { const path = await choose(false); if (!path) return; await openConfigProfile(path, profile); })}><FolderOpen size={15} />{t('importConfig')}</button></Header>{modelRuntime?.installDir && <Panel title={t('preparationRuntime')}><code>{modelRuntime.installDir}</code>{preparationRuntime && profile && <div className="panel-footer"><button onClick={() => setPreparationRuntime(null)}>{t('useCurrentRuntime')}</button></div>}</Panel>}{!modelRuntime && <div className="notice">{t('modelRuntimeNeeded')}<div className="actions"><button className="primary" onClick={() => go('environment')}>{t('automaticRuntime')}</button><button onClick={() => go('localSetup')}>{t('useExistingModel')}</button></div></div>}<div className="model-grid">{core.MODEL_CATALOG.map(entry => <ModelCard key={entry.id} entry={entry} desktop={desktop} profile={modelRuntime} busy={!!busy} onPrepare={recipe => void act('setup', () => runRecipe(recipe), 'modelPrepared')} />)}</div><p className="subtle">{t('snapshot')}: {core.MODEL_CATALOG[0]?.snapshotDate}</p><Panel title={t('localModels')} action={<button title={nativeTitle} disabled={!desktop || !modelRuntime?.installDir} onClick={() => void localModels.refetch()}><RefreshCw size={14} />{t('refresh')}</button>}><p className="subtle">{t('localHint')}</p><ErrorBlock error={localModels.error} />{localModels.data?.length ? <div className="table-wrap"><table><thead><tr><th>{t('name')}</th><th>{t('configPath')}</th><th>{t('modelPath')}</th><th>{t('size')}</th><th>{t('actions')}</th></tr></thead><tbody>{localModels.data.map((m, index) => <tr key={index}><td>{m.name}</td><td><code>{m.configPath}</code></td><td><code>{m.modelPath}</code></td><td>{bytes(m.sizeBytes)}</td><td><button disabled={streaming || !!busy} onClick={() => modelRuntime && void act('import', () => openConfigProfile(m.configPath, modelRuntime))}>{t('createProfile')}</button></td></tr>)}</tbody></table></div> : <Empty title={t('noLocalModels')} hint={!desktop ? t('nativeRequired') : t('localHint')} />}</Panel></>;

  const renderChatPage=()=> <ChatPage conversation={conversation} conversations={conversations} activeConversationId={conversationId} onSelectConversation={selectConversation} onRenameConversation={conversation=>setModal({kind:'rename',conversation})} onDeleteConversation={conversation=>setModal({kind:'deleteConversation',conversation})} profile={profile} online={chatReady} supportsImages={supportsImages} modelName={healthData.model} language={settings.language} draft={draft} onDraftChange={setDraft} attachments={attachments} streaming={streaming} showReasoning={chatPreferences.showReasoning} onSend={send} onCancel={()=>abort.current?.abort()} onNewConversation={addConversation} onExport={exportConversation} onOpenSampling={()=>setModal({kind:'options'})} onAddFiles={addFiles} onRemoveAttachment={id=>setAttachments(old=>old.filter(file=>file.id!==id))} stateLabel={serviceState} onCopy={copy}/>;

  const RequestTable = ({ records }: { records: JsonObject[] }) => {
    const finish = (value: unknown) => { const keys: Record<string, TextKey> = { stop: 'stoppedFinish', length: 'lengthFinish', cancel: 'cancelledFinish', disconnect: 'disconnectedState', error: 'error', tool_calls: 'toolCallsFinish' }; return keys[String(value)] ? t(keys[String(value)]!) : value ? String(value) : '—'; };
    return <div className="table-wrap"><table><thead><tr><th>{t('timestamp')}</th><th>{t('status')}</th><th>{t('promptTokens')}</th><th>{t('reusedTokens')}</th><th>{t('outputTokens')}</th><th>Tok/s</th><th>{t('cacheHit')}</th><th>{t('duration')}</th></tr></thead><tbody>{records.map((r, index) => <tr key={String(r.id ?? `${r.time}-${index}`)}><td><button className="text-button" aria-label={`${t('details')} ${index + 1}`} onClick={() => setModal({kind:'request',value:r})}>{typeof r.time === 'number' ? new Date(r.time * 1000).toLocaleTimeString(settings.language) : '—'}</button></td><td><Badge tone={r.finish === 'error' ? 'warning' : ''}>{finish(r.finish)}</Badge>{r.projection === true && <Badge>ESP</Badge>}</td><td>{number(numeric(r.prompt_tokens),0)}</td><td>{number(numeric(r.reused),0)}</td><td>{number(numeric(r.output_tokens),0)}</td><td>{number(numeric(r.decode_tok_s))}</td><td>{number(numeric(r.hit_rate) === null ? null : numeric(r.hit_rate)! * 100)}{numeric(r.hit_rate) !== null && '%'}{numeric(r.pcie_share) !== null && <small> +{number(numeric(r.pcie_share)! * 100)}% PCIe</small>}</td><td>{number(numeric(r.duration_s))} {numeric(r.duration_s) !== null && 's'}</td></tr>)}</tbody></table></div>;
  };
  const renderMonitoringPage = () => <MonitoringPage raw={{...(metric?.raw??{}),...(mcpQuery.data?{mcp:mcpQuery.data}:{})}} language={settings.language} showAll={showAllRequests} onShowAll={()=>setShowAllRequests(!showAllRequests)} onRequest={value=>setModal({kind:'request',value})} error={metrics.error?errorText(metrics.error):undefined}/>;
  const renderAboutPage = () => <AboutPage raw={metric?.raw??{}} health={healthData} profile={profile} online={online} language={settings.language} desktop={desktop} onOpenSettings={()=>go('settings')} onOpenConfig={()=>go('config')} onCopy={content=>copy(content)} onError={error=>notify(errorText(error),true)}/>;
  const RequestsPage = () => <RequestViewer embedded profile={profile} online={online} language={settings.language} pollInterval={settings.pollInterval} noProfile={<NeedProfile/>} errorText={errorText} onError={error => notify(errorText(error),true)} onMessage={notify}/>;
  const taskState = (state: TaskStatus['state']): TextKey => state === 'completed' ? 'completed' : state === 'failed' ? 'taskFailed' : state === 'cancelled' ? 'taskCancelled' : 'taskRunning';
  const TasksPage = () => <><Header title={t('tasks')} hint={t('taskIntro')}><button disabled={!desktop || !profile || !!busy} title={nativeTitle} onClick={diagnostics}><Download size={15} />{t('diagnostics')}</button><button disabled={!desktop} title={nativeTitle} onClick={() => void query.invalidateQueries()}><RefreshCw size={15} />{t('refresh')}</button></Header><ErrorBlock error={tasks.error} /><ErrorBlock error={handoffs.error ?? preparedProfiles.error} /><Panel title={t('tasks')}>{tasks.data?.length ? <div className="task-list">{[...tasks.data].sort((a, b) => b.startedAt - a.startedAt).map(task => <div className="task-row" key={task.id}><div className={`task-icon ${task.state}`}>{task.state === 'running' ? <LoaderCircle className="spin" size={20} /> : task.state === 'completed' ? <Check size={20} /> : <Terminal size={20} />}</div><div className="task-copy"><div><strong>{t(task.kind.includes('setup') ? 'setupTask' : task.kind.includes('install') ? 'installTask' : task.kind.includes('update') ? 'updateTask' : 'task')}</strong><Badge tone={task.state === 'completed' ? 'positive' : task.state === 'failed' ? 'warning' : ''}>{t(taskState(task.state))}</Badge></div><p>{task.message}</p><small>{new Date(task.startedAt).toLocaleString(settings.language)} · {task.id}</small></div><div className="actions">{taskNextActions(task)}<button disabled={!desktop} onClick={() => setSelectedTaskId(task.id)}><FileText size={14}/>{t('viewLogs')}</button>{task.state === 'running' ? <button disabled={!!busy} onClick={() => void act('cancelTask', () => core.cancelTask(task.id), 'success')}><Square size={13} />{t('cancelTask')}</button> : task.state !== 'completed' && <button disabled={!!busy} onClick={() => { const recipe = recipes[task.id]; if (!recipe) notify(t('retryUnavailable'), true); else void act('retryTask', () => runRecipe(recipe), 'taskStarted'); }}><RefreshCw size={14} />{t('retry')}</button>}</div></div>)}</div> : <Empty title={t('noTasks')} hint={!desktop ? t('nativeRequired') : undefined} />}</Panel><Panel title={t('logs')} action={<div className="search-field"><Search size={15} /><input aria-label={t('searchLogs')} placeholder={t('searchLogs')} value={logSearch} onChange={event => setLogSearch(event.target.value)} /></div>}><Field label={t('logSource')}><Dropdown ariaLabel={t('logSource')} value={selectedTaskId} disabled={!desktop} onValueChange={setSelectedTaskId} options={[{value:'',label:t('serviceLogs'),disabled:!profile},...(tasks.data ?? []).map(task => ({value:task.id,label:`${t(task.kind.includes('setup') ? 'setupTask' : task.kind.includes('install') ? 'installTask' : task.kind.includes('update') ? 'updateTask' : 'task')} · ${new Date(task.startedAt).toLocaleString(settings.language)} · ${task.id.slice(0,8)}`}))]} /></Field><ErrorBlock error={logs.error} />{logs.data?.length ? <div className="log-view" role="log">{logs.data.filter(log => `${log.level} ${log.message}`.toLowerCase().includes(logSearch.toLowerCase())).map((log, index) => <div className="log-line" key={index}><time>{new Date(log.timestamp).toLocaleTimeString(settings.language)}</time><span className={`log-level ${log.level.toLowerCase()}`}>{log.level}</span><span>{log.message}</span></div>)}</div> : <Empty title={t('noLogs')} hint={!desktop ? t('nativeRequired') : !logProfile ? t('selectLogSourceHint') : undefined} />}</Panel></>;
  const EnvironmentPage = () => <><InstallRuntimePage language={settings.language} desktop={desktop} onPrepared={runtime => { setPreparationRuntime(runtime.profile); go('models'); }}/><Panel title={t('system')} action={<button disabled={!desktop} onClick={() => void environment.refetch()}><RefreshCw size={15}/>{t('refresh')}</button>}><ErrorBlock error={environment.error}/>{environment.data ? <div className="environment-grid">{[[t('system'),environment.data.os],[t('architecture'),environment.data.arch],[t('cpu'),environment.data.cpuName],[t('totalMemory'),bytes(environment.data.totalMemory)],[t('availableMemory'),bytes(environment.data.availableMemory)],[t('gpus'),environment.data.gpus.join(', ')||t('missing')],['Python',environment.data.python??t('missing')],[t('appVersion'),environment.data.appVersion]].map(([label,value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div> : <Empty title={desktop?environment.isPending?t('loading'):t('empty'):t('nativeRequired')}/>}</Panel></>;
  const changeSettings = (patch: Partial<AppSettings>) => { const next = { ...settings, ...patch }; setSettings(next); if (desktop) void core.applySettings(next).catch(error => notify(errorText(error), true)); };
  const SettingsPage = () => <><Header title={t('settings')} hint={t('settingsIntro')} /><div className="settings-layout"><DesktopLifecycleSettings desktop={desktop} streaming={streaming} autoCheck={settings.autoCheckUpdates !== false} onAutoCheck={enabled => changeSettings({autoCheckUpdates:enabled})} update={appUpdates.state} onCheck={appUpdates.check} onInstall={appUpdates.install} onError={error => notify(errorText(error),true)}/><Panel title={t('appearance')}><Field label={t('theme')}><Segmented ariaLabel={t('theme')} value={settings.theme} onValueChange={theme => changeSettings({theme:theme as AppSettings['theme']})} options={(['dark','light','system'] as const).map(theme => ({value:theme,label:t(theme === 'system' ? 'systemTheme' : theme),icon:theme === 'dark' ? <OfficialIcon name="moon" size={15}/> : theme === 'light' ? <OfficialIcon name="sun" size={15}/> : <Settings2 size={15}/>}))} /></Field><Field label={t('language')}><Dropdown ariaLabel={t('language')} value={settings.language} onValueChange={language => changeSettings({language:language as AppSettings['language']})} options={[{value:'zh-CN',label:'简体中文'},{value:'en',label:'English'}]} /></Field></Panel><Panel title={t('behavior')}><label className="setting-toggle"><span><strong>{t('closeToTray')}</strong><small>{t('closeToTrayHint')}</small></span><Toggle ariaLabel={t('closeToTray')} disabled={!desktop} title={nativeTitle} checked={settings.closeToTray} onCheckedChange={checked => changeSettings({closeToTray:checked})} /></label><Field label={t('pollInterval')}><Dropdown ariaLabel={t('pollInterval')} value={String(settings.pollInterval)} onValueChange={value => changeSettings({pollInterval:Number(value)})} options={[2000,3000,5000,10000,30000].map(value => ({value:String(value),label:`${value/1000} ${t('seconds')}`}))} /></Field></Panel><Panel title={t('chatOptions')}><Field label={t('model')}><Dropdown editable ariaLabel={t('model')} value={options.model} placeholder={t('modelPlaceholder')} options={apiModels.map(model=>({value:model,label:model}))} onValueChange={model=>setOptions({...options,model})}/></Field><Field label={t('systemPrompt')}><textarea rows={4} value={options.systemPrompt} placeholder={t('systemPromptPlaceholder')} onChange={event=>setOptions({...options,systemPrompt:event.target.value})}/></Field></Panel></div></>;

  const exportConversation = (c: Conversation) => { const content = `# ${c.title}\n\n${c.messages.map(m => `## ${t(m.role === 'user' ? 'you' : 'assistant')}\n\n${m.reasoning ? `<details><summary>${t('thinking')}</summary>\n\n${m.reasoning}\n\n</details>\n\n` : ''}${m.content}${m.attachments?.length ? '\n\n' + m.attachments.map(a => a.type === 'image' ? `![${a.name}](${a.content})` : `### ${a.name}\n\n\`\`\`\n${a.content}\n\`\`\``).join('\n\n') : ''}${m.tools?.length ? `\n\n\`\`\`json\n${JSON.stringify(m.tools, null, 2)}\n\`\`\`` : ''}${m.error ? `\n\n> ${m.error}` : ''}`).join('\n\n---\n\n')}\n`; void saveFile(markdownFileName(c.title), content); };
  const renderRuntimeConfig = () => <RuntimeConfigPage profile={profile} online={online} language={settings.language} desktop={desktop} onSampling={()=>setModal({kind:'options'})} onServices={()=>go('profiles')} onKeySaved={()=>{void query.invalidateQueries();notify(t('saved'));}} onError={error=>notify(errorText(error),true)} onMessage={notify}/>;
  const pages: Record<Page, () => ReactNode> = { about: renderAboutPage, overview: renderOverviewPage, localSetup: renderLocalSetup, tuning: () => <TuningPage key={profile?.id} profileId={profile?.id} language={settings.language} desktop={desktop} owned={process.data?.owned === true && process.data?.running === true} streaming={streaming} onChanged={() => void query.invalidateQueries()}/>, config: renderRuntimeConfig, profiles: ProfilesPage, models: ModelsPage, chat: renderChatPage, monitoring: renderMonitoringPage, usage: () => <ApiUsagePage language={settings.language} profileId={profile?.id} desktop={desktop} onQuery={core.analyticsQuery}/>, requests: RequestsPage, tasks: TasksPage, environment: EnvironmentPage, settings: SettingsPage };

  if (!ready) return <div className="boot">{bootError ? <><p role="alert">{t('workspaceLoadFailed')}</p><details><summary>{t('details')}</summary>{bootError}</details><button onClick={() => setBootAttempt(value => value + 1)}><RefreshCw size={15}/>{t('retry')}</button></> : <><LoaderCircle className="spin" size={28}/><span>{t('loading')}</span></>}</div>;
  const officialPage = page==='chat'||page==='monitoring'||page==='about'||page==='config';
  const live=object(metric?.raw.live);const pillState=!online?'queued':Number(live.queued)>0?'queued':String(live.state??'unknown');
  const pillText=!profile?t('noProfile'):!online?t(health.isFetching?'connecting':'offline'):Number(live.queued)>0?`${number(numeric(live.queued),0)} ${t('queuedState')}`:pillState==='generating'?`${t('generatingState')} · ${number(numeric(live.tok_s))} tok/s`:pillState==='reading'?`${t('readingState')}${Number(live.prompt_total)>0?` · ${Math.round(Number(live.prompt_read)/Number(live.prompt_total)*100)}%`:''}`:typeof live.state==='string'?serviceState(live.state):typeof healthData.loaded==='boolean'?t(loaded?'loaded':'notLoaded'):t('online');
  const toggleTheme=()=>changeSettings({theme:document.documentElement.dataset.theme==='dark'?'light':'dark'});
  const toggleLanguage=()=>changeSettings({language:settings.language==='zh-CN'?'en':'zh-CN'});
  const navItems=navigation.map(item=>({id:item.id,label:item.id==='monitoring'?t('monitorWorkspace'):item.id==='models'?t('modelWorkspace'):t(item.id as TextKey),group:'',icon:<item.icon size={18}/>}));
  const parent=parentPage(page);
  const subpages:Page[]=parent==='models'?['profiles','models','localSetup']:parent==='monitoring'?['usage','monitoring','requests','tasks']:parent==='settings'?['settings','config','environment','about']:[];
  const sidebarNode=<Sidebar items={navItems} page={parent} profiles={profiles} activeId={activeId} disabled={streaming} collapsed={sidebarCollapsed} language={settings.language} theme={document.documentElement.dataset.theme??'light'} onCollapse={()=>setSidebarCollapsed(old=>!old)} onNavigate={next=>go(next as Page)} onProfile={setActiveId} onLanguage={toggleLanguage} onTheme={toggleTheme}/>;
  const headerNode=<WorkspaceHeader title={navItems.find(item=>item.id===parent)?.label} status={<span className="st-pill" id="pill" data-state={pillState} role="status" aria-live="polite"><span className="st-pill__dot"/><span id="pill-text">{localProgress?t('preparingLocal'):pillText}</span></span>}/>;
  const statusBar=<WorkspaceStatusBar status={desktop?t(supervisor.data?.running?'supervisorRunning':'supervisorOffline'):t('nativeRequired')} activity={profile?.name} actions={<span title={t('backgroundKeepsServing')}>{supervisor.data?.pid?`PID ${supervisor.data.pid}`:null}</span>}/>;
  const subnavigation=subpages.length>0&&<nav className="workspace-subnav" aria-label={navItems.find(item=>item.id===parent)?.label}>{subpages.map(item=><button key={item} type="button" className={page===item?'is-active':''} aria-current={page===item?'page':undefined} onClick={()=>go(item)}>{item==='requests'?t('apiMonitorTitle'):item==='profiles'?t('myModels'):item==='models'?t('downloadModels'):item==='localSetup'?t('localSetupTitle'):t(item as TextKey)}</button>)}</nav>;
  return <AppLayout sidebar={sidebarNode} collapsed={sidebarCollapsed}><WorkspaceLayout header={headerNode} statusBar={statusBar}>{subnavigation}{officialPage?pages[page]():<div className={`management-content management-content--${page}`}><div className="main-content">{pages[page]()}</div></div>}</WorkspaceLayout>
    {toast&&<div className="st-toasts" id="toasts" aria-live="polite"><div className={`st-toast st-toast--${toast.error?'error':'success'}`} role={toast.error?'alert':'status'}><OfficialIcon name={toast.error?'error':'check'}/><div><div className="st-toast__title">{t(toast.error?'error':'success')}</div><span>{toast.text}</span>{toast.taskId && <div className="actions">{tasks.data?.find(task => task.id === toast.taskId) && taskNextActions(tasks.data.find(task => task.id === toast.taskId)!)}<button className="st-btn st-btn--secondary" onClick={() => go('tasks')}>{t('viewAllTasks')}</button></div>}</div><button className="st-btn st-btn--icon" aria-label={t('close')} onClick={()=>setToast(null)}><X size={16}/></button></div></div>}{busy&&<div className="busy-indicator" role="status"><LoaderCircle className="spin" size={14}/>{t('working')}</div>}
    {modal?.kind === 'modelProfiles' && <ModelProfilesDialog models={modal.models} disabled={!!busy} onClose={() => setModal(null)} onChoose={path => void act('taskProfile', () => openConfigProfile(path, modal.runtime))}/>}
    {modal?.kind === 'profile' && <ProfileDialog key={modal.profile?.id ?? 'new'} existing={modal.profile} onClose={() => setModal(null)} onSave={async (p, key) => { if (desktop) p = await core.renameLocalInstallation(p.id, p.name); if (key.trim()) await core.setApiKey(p.id, key.trim()); setProfiles(old => old.some(x => x.id === p.id) ? old.map(x => x.id === p.id ? p : x) : [...old, p]); if (!desktop && !profiles.some(item => item.id === p.id)) setActiveId(p.id); setModal(null); await query.invalidateQueries(); notify(t('saved')); }} choose={choose} native={desktop} errorText={errorText} />}
    {modal?.kind === 'rename' && <RenameDialog title={modal.conversation.title} onClose={() => setModal(null)} onSave={title => { const cid = modal.conversation.id; setConversations(old => old.map(c => c.id === cid ? { ...c, title, updatedAt: Date.now() } : c)); setModal(null); }} />}
    {modal?.kind === 'deleteConversation' && <Dialog title={t('deleteConversation')} onClose={() => setModal(null)}><p>{t('deleteConversationHint')}</p><div className="dialog-footer"><button onClick={() => setModal(null)}>{t('cancel')}</button><button className="danger-solid" onClick={() => { const cid = modal.conversation.id; setConversations(old => old.filter(c => c.id !== cid)); if (conversationId === cid) setConversationId('');setConversationIds(old=>Object.fromEntries(Object.entries(old).filter(([,value])=>value!==cid))); setModal(null); }}>{t('confirmDelete')}</button></div></Dialog>}
    {modal?.kind === 'request' && <Dialog title={t('requestDetails')} wide onClose={() => setModal(null)}><RequestViewer profile={profile} online={online} language={settings.language} pollInterval={settings.pollInterval} initialSelected={typeof object(modal.value).id==='string'?String(object(modal.value).id):undefined} noProfile={<NeedProfile/>} errorText={errorText} onError={error=>notify(errorText(error),true)} onMessage={notify}/></Dialog>}
    {modal?.kind === 'options' && <SamplingDrawer profile={profile} options={options} preferences={chatPreferences} models={apiModels} hasProjection={hasProjection} online={online} mcpInfo={mcpQuery.data} onApply={(next, ui) => { setOptions(next); setChatPreferences(ui); notify(t('saved')); }} onClose={() => setModal(null)} onError={error => notify(errorText(error), true)} onMessage={notify} />}
  </AppLayout>;
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
  function ModelCard({ entry, desktop, profile, busy, onPrepare }: { entry: (typeof core.MODEL_CATALOG)[number]; desktop: boolean; profile?: ServiceProfile; busy: boolean; onPrepare: (recipe: Recipe) => void }) {
    const { t } = useTranslation();
    const nativeTitle = desktop ? undefined : t('nativeRequired');
    const [quant, setQuant] = useState(entry.quants[0] ?? '');
    const [context, setContext] = useState(32768);
    const [images, setImages] = useState(false);
    const info = entry.quantInfo[quant];
    return <section className="model-card"><div className="model-symbol"><HardDrive size={25} /></div><div className="model-heading"><div className="eyebrow">{entry.family}</div><h2>{entry.name}</h2></div><div className="model-tags">{entry.images && <Badge><Image size={12} />{t('images')}</Badge>}{info?.experimental && <Badge tone="warning">{t('experimental')}</Badge>}{info?.nvidiaOnly && <Badge>{t('nvidiaOnly')}</Badge>}{info?.visionUntested && <Badge tone="warning">{t('visionUntested')}</Badge>}</div><div className="form-grid"><Field label={t('quant')}><Dropdown ariaLabel={t('quant')} value={quant} onValueChange={setQuant} options={entry.quants.map(q => ({value:q,label:q}))} /></Field><Field label={t('context')}><NumberField min={512} max={1048576} step={512} value={context} onChange={event => setContext(Number(event.target.value))} /></Field></div><div className="model-info"><span>{t('downloadSize')} <strong>{info ? `${info.downloadGB} GB` : '—'}</strong></span><span>{t('memoryRequired')} <strong>{info ? `${info.ramGB} GB` : '—'}</strong></span></div><label className="checkbox"><Toggle ariaLabel={t('images')} disabled={!entry.images} checked={images} onCheckedChange={setImages} />{t('images')}</label><div className="model-bottom"><a href={entry.source} target="_blank" rel="noreferrer">{t('source')}<ArrowUp size={13} /></a><button className="primary" title={nativeTitle} disabled={!desktop || !profile?.installDir || !!busy || context < 512 || !Number.isInteger(context)} onClick={() => profile && onPrepare({ kind: 'setup', profile, model: entry.family, quant, context, images })}><Download size={15} />{t('prepare')}</button></div></section>;
  }
