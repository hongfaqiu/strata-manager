import type { AppLanguage } from "@strata-manager/core";
import { ModelsLead, RequirementMeter, machineMemoryGB } from './D2PageStrips';
import type { HardwareReading } from './D2Visuals';
import type { EnvironmentInfo } from '@strata-manager/core';
import { useEffect, useRef, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { ChevronDown, FileText, FolderOpen, LoaderCircle, MessageSquare, Pencil, Play, RefreshCw, Server, Settings2, Square, Trash2 } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { JsonObject, LocalCandidate, LocalInstallationDetails, LocalModelConfiguration, LocalModelGroup, ProcessStatus, ServiceProfile } from '@strata-manager/core';
import { Badge, Empty } from '../components';
import { OfficialDialog } from '../OfficialControls';
import { ModelConfigurationDropdown } from './ModelConfigurationDropdown';
import { ModelDeletionDialog } from './ModelDeletionDialog';
import { ConfigurationDeletionDialog } from './ConfigurationDeletionDialog';
import './service-manager.css';

type Action = (profile: ServiceProfile) => void | Promise<unknown>;
type CandidateAction = (candidate: LocalCandidate) => void | Promise<unknown>;
type InspectedProcess = ProcessStatus & { external?: boolean; canTakeOver?: boolean; reason?: string };
type ConfirmationAction = 'stop' | 'restart' | 'takeover' | 'unload' | 'delete';

export interface ServiceManagerPageProps {
  /** Live hardware from /metrics and static environment info, used by the D2 capacity lead and per-config requirement meter. */
  hardware?: HardwareReading;
  environment?: EnvironmentInfo;
  hardwareOnline?: boolean;
  profiles: ServiceProfile[];
  activeId: string;
  lastUsedId?: string;
  preparingId?: string;
  details?: LocalInstallationDetails[];
  candidates?: LocalCandidate[];
  discoveryLoading?: boolean;
  discoveryError?: unknown;
  onUseCandidate?: CandidateAction;
  /** Register and open the configuration without loading the model. */
  onConfigCandidate?: CandidateAction;
  onRefreshDiscovery?: () => void | Promise<unknown>;
  /** Refresh saved records and discovery after deleting model weights or configuration JSON. */
  onModelDeleted?: () => void | Promise<unknown>;
  language: AppLanguage;
  desktop: boolean;
  pollInterval?: number;
  streaming?: boolean;
  busyProfileIds?: string[];
  onSelect: Action;
  onAdd: () => void;
  onImport: () => void;
  /** Directories the user added for discovery; used for empty-state guidance. */
  addedDirectories?: string[];
  onEdit: Action;
  /** Called after this page's delete confirmation. Remove the profile, never the installation. */
  onDelete: Action;
  onStart: Action;
  onStop: Action;
  onRestart: Action;
  /** Called only after explicit confirmation, and only for a verified canTakeOver process. */
  onTakeover: Action;
  onLoad: Action;
  onUnload: Action;
  onConfig: Action;
  onLogs: Action;
  onChat: Action;
  onError?: (error: unknown, profile: ServiceProfile) => void;
}

const words = {
  'zh-CN': {
    add: '添加目录', refresh: '扫描',
    chooseStep: '选择本机模型', prepareStep: '后台自动准备', switchStep: '切换模型',
    service: '后台管理', serviceHelp: '使用本机已安装的模型；还没有 Strata 时，先安装运行环境，再选择模型。',
    model: '模型', modelHelp: '后台会检查运行环境、启动 Strata 并载入选定模型。准备完成后即可聊天和使用本机 API。',
    currentHelp: '同一时间运行一个模型。选择其他模型会先结束当前模型，再载入新的模型，聊天记录会保留。',
    noServices: '尚未发现本机模型', noServicesHelp: '应用会自动扫描已有 Strata 目录，也可以添加其它目录。首次使用请从侧栏“Strata”安装运行环境，再下载模型。',
    noServicesDataHelp: '已添加的目录里没有找到可启动的模型配置。若这是官方数据目录（Strata-data / --data-dir），请改为添加含 setup.py 与 serve/server.py 的安装目录；也可在「下载模型 → 已有模型」用「导入配置」选择 strata-*.json。',
    checking: '检查中', online: '接口可用', offline: '尚未就绪', ready: '已就绪', unknown: '未提供', loaded: '已加载', unloaded: '未加载',
    owned: '后台已接管', external: '等待后台接管', connectionOnly: '等待导入', readyToStart: '尚未启用', localModel: '本机模型', api: '本机 API 地址',
    process: '进程', stopped: '未启动', running: '运行中', modelState: '模型状态', health: '服务状态',
    selected: '当前选择', select: '启用配置', chat: '聊天', start: '启用此模型', retryEnable: '重试启用', prepare: '准备模型', stop: '停止', restart: '重启',
    load: '加载模型', unload: '释放模型内存', takeover: '接管并启用', config: '运行配置', configShort: '配置', logs: '查看日志', lastActivated: '上次启用',
    details: '详情', hideDetails: '收起', edit: '重命名模型', remove: '移除保存的配置', deleteModel: '删除模型文件', retainConfigurations: '删除模型文件时保留全部 JSON 配置。', repairConfigurations: '待修复配置', repairConfigurationsHelp: '这些配置引用的模型权重缺失；仍可打开运行配置页编辑或删除 JSON。',
    installDir: 'Strata 目录', python: 'Python 路径', configPath: '模型配置文件', logPath: '引擎日志配置', version: '引擎版本', pid: '进程 ID',
    desktopRequired: '请在桌面应用中准备本机模型。',
    configure: '这份记录的安装信息不完整，请重新检测模型目录。',
    takeoverHelp: '此模型由其他程序运行。接管会结束已核验的 Strata 进程，再由后台准备；模型文件保留在原位置。',
    externalHelp: '后台正在等待可核验的本机实例。接管完成后才能聊天；无法核验时会提示具体原因。',
    waitingOwnership: '等待后台接管。可重试启用此模型，完成后即可聊天。',
    offlineHelp: '模型尚未就绪，请手动启用；失败原因会显示在这里。',
    invalidService: '本机实例尚未返回有效的 Strata 状态，请刷新或重试启用。',
    noModelHelp: '服务已运行，模型尚未加载。',
    inspectFailed: '进程状态检查失败', unverified: '身份未核验', detailFailed: '无法读取部分详情', actionFailed: '操作失败', cancel: '取消', working: '处理中…',
    stopTitle: '停止此模型服务', stopBody: '将停止这个模型的 Strata 进程并释放模型资源，正在进行的请求会被中断。之后可点击“启用此模型”恢复使用。',
    restartTitle: '重启此模型服务', restartBody: '后台将按最新运行配置重新准备此模型，正在进行的请求会被中断。',
    takeoverTitle: '交由后台接管并启用', takeoverBody: '将结束已核验的本机 Strata 进程，再由本应用后台准备此模型。原模型文件会保留，正在进行的请求会被中断；原来的启动程序可能需要手动关闭。',
    unloadTitle: '释放当前模型内存', unloadBody: '释放此模型占用的内存与显存，模型文件保留。服务程序继续运行，正在进行的请求会被中断；之后可以重新加载模型。',
    deleteTitle: '移除保存的配置', deleteBody: '仅移除本应用保存的配置记录，原始配置、Strata 和模型文件均保留。自动扫描后仍会显示，可以再次使用。正在运行的配置需要先停止服务。',
    authHelp: '服务需要 API Key 时，可在运行配置页设置。',
    configurationMissing: '尚未指定', total: '个本机模型', logsHint: '可查看本应用进程输出与模型配置中指定的引擎日志。',
    discovered: '已发现', repair: '需要修复', scan: '正在扫描本机模型…', scanFailed: '模型扫描失败', modified: '修改日期', configurations: '份配置', browsing: '查看配置不会切换模型。', current: '当前使用', lastUsed: '上次使用', preparing: '正在准备', currentConfiguration: '运行中', modelFile: '模型文件', modelSize: '模型大小', discoveredProcess: '检测到运行', useHelp: '将结束当前模型，再加载这份配置；模型文件保留。', configHelp: '查看和编辑配置，不会启动模型。', repairHelp: '请先修复配置或模型文件，再使用这份配置。',
  },
  en: {
    add: 'Add directory', refresh: 'Scan',
    chooseStep: 'Choose a local model', prepareStep: 'Automatic preparation', switchStep: 'Switch models',
    service: 'Background management', serviceHelp: 'Use a model installed on this computer. If Strata is not installed yet, install the runtime first, then choose a model.',
    model: 'Model', modelHelp: 'The background checks the runtime, starts Strata and loads your selection. Once ready, you can chat and use the local API.',
    currentHelp: 'One model runs at a time. Choosing another model ends the current model before loading the new one. Chat history is retained.',
    noServices: 'No local models found', noServicesHelp: 'Existing Strata directories are scanned automatically. You can also add another directory. For a first installation, open Strata in the sidebar to install the runtime, then download a model.',
    noServicesDataHelp: 'No runnable model configuration was found in the directories you added. If this is an official data folder (Strata-data / --data-dir), add the install directory that contains setup.py and serve/server.py instead, or use Import configuration under Download models → Existing models and pick a strata-*.json file.',
    checking: 'Checking', online: 'API available', offline: 'Not ready', ready: 'Ready', unknown: 'Not reported', loaded: 'Loaded', unloaded: 'Not loaded',
    owned: 'Managed by the background', external: 'Awaiting ownership', connectionOnly: 'Awaiting import', readyToStart: 'Not enabled', localModel: 'Local model', api: 'Local API address',
    process: 'Process', stopped: 'Not started', running: 'Running', modelState: 'Model state', health: 'Service status',
    selected: 'Selected', select: 'Enable configuration', chat: 'Chat', start: 'Enable this model', retryEnable: 'Retry enabling', prepare: 'Prepare model', stop: 'Stop', restart: 'Restart',
    load: 'Load model', unload: 'Unload model', takeover: 'Take ownership and enable', config: 'Runtime settings', configShort: 'Settings', logs: 'View logs', lastActivated: 'Last activated',
    details: 'Details', hideDetails: 'Collapse', edit: 'Rename model', remove: 'Remove saved configuration', deleteModel: 'Delete model files', retainConfigurations: 'Deleting model files retains all JSON configurations.', repairConfigurations: 'Configurations to repair', repairConfigurationsHelp: 'The model weights referenced by these configurations are missing. Open Runtime settings to edit or delete the JSON files.',
    installDir: 'Strata directory', python: 'Python path', configPath: 'Model configuration', logPath: 'Engine log setting', version: 'Engine version', pid: 'Process ID',
    desktopRequired: 'Prepare local models in the desktop app.',
    configure: 'The installation details for this record are incomplete. Detect the model directory again.',
    takeoverHelp: 'Another program is running this model. Taking ownership ends the verified Strata process and prepares the model in the background. Model files stay in their original location.',
    externalHelp: 'The background is waiting for a verifiable local instance. Chat becomes available after ownership is established. Verification failures show the specific reason.',
    waitingOwnership: 'Awaiting background ownership. Retry enabling this model to prepare it for chat.',
    offlineHelp: 'The model is not ready yet. Enable it manually; any failure will be shown here.',
    invalidService: 'The local instance has not returned a valid Strata status. Refresh or retry enabling it.',
    noModelHelp: 'The service is running; the model is not loaded yet.',
    inspectFailed: 'Process inspection failed', unverified: 'Identity unverified', detailFailed: 'Some details could not be read', actionFailed: 'Operation failed', cancel: 'Cancel', working: 'Working…',
    stopTitle: 'Stop this model service', stopBody: 'Stops this model’s Strata process and releases model resources. Active requests will be interrupted. Choose Enable this model to resume later.',
    restartTitle: 'Restart this model service', restartBody: 'The background prepares this model again using the latest runtime configuration. Active requests will be interrupted.',
    takeoverTitle: 'Transfer ownership and enable', takeoverBody: 'Ends the verified local Strata process, then prepares this model using the app background. Model files are retained. Active requests will be interrupted; its original launcher may need to be closed manually.',
    unloadTitle: 'Unload the current model', unloadBody: 'Frees RAM and VRAM without deleting model files. The service stays running. Active requests will be interrupted; you can load the model again later.',
    deleteTitle: 'Remove saved configuration', deleteBody: 'Removes only the configuration record saved by this app. Original configuration, Strata and model files are retained. Automatic discovery still shows it so you can use it again. Stop a running configuration first.',
    authHelp: 'If this service requires an API key, set it in Runtime settings.',
    configurationMissing: 'Not configured', total: 'local models', logsHint: 'View process output captured by this app and the engine log specified in the model configuration.',
    discovered: 'Discovered', repair: 'Needs repair', scan: 'Scanning local models…', scanFailed: 'Model discovery failed', modified: 'Modified', configurations: 'configurations', browsing: 'Viewing a configuration does not switch models.', current: 'In use', lastUsed: 'Last used', preparing: 'Preparing', currentConfiguration: 'Active configuration', modelFile: 'Model file', modelSize: 'Model size', discoveredProcess: 'Detected running', useHelp: 'Ends the current model and loads this configuration. Model files are retained.', configHelp: 'View and edit settings without starting the model.', repairHelp: 'Repair the configuration or model files before using this configuration.',
  },
} as const;

const textValue = (value: unknown) => typeof value === 'string' && value.trim() ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
const objectValue = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const configurationName = (entry: LocalModelConfiguration) => (entry.profile?.configPath || entry.configPath).split(/[\\/]/).at(-1) || entry.profile?.name || entry.candidate?.name || '—';
const modifiedDate = (value: number | null | undefined, language: AppLanguage) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString(language) : '—';
const modelSize = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) ? `${(value / 1024 ** 3).toFixed(1)} GiB` : '—';
const visibleConfiguration = (config: JsonObject) => JSON.stringify(config, (key, value) => /^(?:api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token)$/i.test(key) ? undefined : value, 2);
const candidateProfile = (candidate: LocalCandidate): ServiceProfile => ({ id: `configuration-${candidate.id}`, name: candidate.name, baseUrl: `http://127.0.0.1:${candidate.detectedPort ?? 18081}`, installDir: candidate.installDir, pythonPath: candidate.pythonPath, configPath: candidate.configPath, managed: false });
const hasMissingModelFiles = (group: LocalModelGroup) => group.configurations.length > 0 && group.configurations.every(entry => {
  const candidate = entry.candidate;
  return !!candidate && candidate.availability === 'repair' && !(typeof candidate.modelBytes === 'number' && candidate.modelBytes > 0) && (!entry.profile || (!!entry.config && !!candidate.config && core.modelAssetKey(entry.profile, entry.config) === core.modelAssetKey(candidateProfile(candidate), candidate.config)));
});
const modelDeletionProfiles = (configurations: LocalModelConfiguration[]) => {
  const profiles = configurations.flatMap(entry => entry.profile ? [entry.profile] : []);
  const paths = new Set(profiles.map(profile => core.configurationPathKey(profile.configPath, profile.installDir)));
  for (const entry of configurations) {
    if (entry.candidate) {
      const candidate = entry.candidate;
      const discovered = candidateProfile(candidate);
      // A retained original JSON may now target another model than its saved copy.
      const path = core.configurationPathKey(discovered.configPath, discovered.installDir);
      if (!paths.has(path) && (!entry.profile || core.modelAssetKey(entry.profile, entry.config) === core.modelAssetKey(discovered, candidate.config))) { profiles.push(discovered); paths.add(path); }
    }
  }
  return profiles;
};
const configurationSummary = (config: JsonObject | null | undefined, language: AppLanguage) => {
  const args = Array.isArray(config?.args) ? config.args : [];
  const option = (flag: string) => { let value: string | undefined; for (let index = 0; index < args.length; index++) { const arg = args[index]; if (arg === flag) { const next = textValue(args[index + 1]); if (next && !next.startsWith('-')) value = next; } else if (typeof arg === 'string' && arg.startsWith(`${flag}=`)) value = textValue(arg.slice(flag.length + 1)); } return value; };
  const context = option('--max-context');
  const kv = option('--kv');
  const parallel = textValue(config?.parallel) ?? option('--parallel');
  const model = option('--native') ?? option('--model') ?? option('-m') ?? option('--pack');
  const quant = model?.match(/(?:^|[\\/._\s-])((?:IQ\d_[A-Z\d_]+|Q\d(?:_[A-Z\d]+)+|BF16|FP16|F16|FP32))(?=$|[\\/.\s-])/i)?.[1]?.toUpperCase();
  const contextSize = context && (Number.isFinite(Number(context)) && Number(context) > 0 && Number(context) % 1024 === 0 ? `${Number(context) / 1024}K` : Number.isFinite(Number(context)) ? Number(context).toLocaleString(language) : context);
  return [quant, contextSize && `${contextSize} ${language === 'zh-CN' ? '上下文' : 'context'}`, kv && `KV ${kv}`, parallel && `${language === 'zh-CN' ? '并发' : 'Parallel'} ${parallel}`].filter(Boolean).join(' · ');
};

/** All status requests are read-only and scoped to their own profile. Mutations remain explicit callbacks. */
export function ServiceManagerPage(props: ServiceManagerPageProps) {
  const { profiles, activeId, language, desktop, streaming = false, pollInterval = 5000, busyProfileIds = [] } = props;
  const w = words[(language === 'zh-CN' ? 'zh-CN' : 'en')];
  const configurationLabel = (entry: LocalModelConfiguration) => {
    const source = entry.profile ? props.details?.find(detail => detail.profileId === entry.profile!.id)?.originalConfigPath : undefined;
    return source?.split(/[\\/]/).at(-1) || configurationName(entry);
  };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [groupSelections, setGroupSelections] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmation, setConfirmation] = useState<{ action: ConfirmationAction; profile: ServiceProfile } | null>(null);
  const [modelDeletion, setModelDeletion] = useState<{ modelName: string; profiles: ServiceProfile[] } | null>(null);
  const [configurationDeletion, setConfigurationDeletion] = useState<ServiceProfile | null>(null);
  const [scanning, setScanning] = useState(false);
  const scanPending = useRef(false);
  const pendingAction = useRef<string | null>(null);
  const pageBusy = Object.values(busy).some(Boolean) || busyProfileIds.length > 0;
  const interval = Math.max(1000, pollInterval);
  const processQueries = useQueries({ queries: profiles.map(profile => ({
    queryKey: ['service-manager-process', profile.id, profile.baseUrl, profile.installDir, profile.pythonPath, profile.configPath, profile.managed],
    queryFn: () => core.serviceStatus(profile.id, profile) as Promise<InspectedProcess>,
    enabled: desktop, refetchInterval: Math.max(10000, interval), refetchOnWindowFocus: false, retry: false,
  })) });
  const healthQueries = useQueries({ queries: profiles.map((profile, index) => ({
    queryKey: ['service-manager-health', profile.id, profile.baseUrl],
    queryFn: () => core.request(profile, '/health'),
    enabled: !desktop || processQueries[index]?.data?.running === true,
    refetchInterval: interval, refetchOnWindowFocus: false, retry: false,
  })) });
  const metricQueries = useQueries({ queries: profiles.map((profile, index) => ({
    queryKey: ['service-manager-details', profile.id, profile.baseUrl],
    queryFn: () => core.request(profile, '/metrics'),
    enabled: expanded.includes(`profile:${profile.id}`) && healthQueries[index]?.isSuccess === true && (!desktop || processQueries[index]?.data?.running === true),
    refetchOnWindowFocus: false, retry: false,
  })) });
  const configQueries = useQueries({ queries: profiles.map(profile => ({
    queryKey: ['service-manager-local-config', profile.id, profile.configPath],
    queryFn: () => core.readConfig(profile),
    enabled: desktop && !!profile.configPath && (expanded.includes(`profile:${profile.id}`) || props.details?.find(item => item.profileId === profile.id)?.config === undefined),
    staleTime: 30_000,
    refetchOnWindowFocus: false, retry: false,
  })) });
  const refresh = (profile?: ServiceProfile) => {
    const indexes = profile ? [profiles.findIndex(item => item.id === profile.id)] : profiles.map((_, index) => index);
    const requests: Promise<unknown>[] = [];
    for (const index of indexes) if (index >= 0) { if (healthQueries[index] && (!desktop || processQueries[index]?.data?.running === true)) requests.push(healthQueries[index]!.refetch()); if (desktop && processQueries[index]) requests.push(processQueries[index]!.refetch()); if (desktop && profiles[index]?.configPath && configQueries[index]) requests.push(configQueries[index]!.refetch()); if (expanded.includes(`profile:${profiles[index]!.id}`) && metricQueries[index] && (!desktop || processQueries[index]?.data?.running === true)) requests.push(metricQueries[index]!.refetch()); }
    return Promise.allSettled(requests);
  };
  const run = async (name: string, profile: ServiceProfile, action: Action) => {
    if (pendingAction.current || streaming || busyProfileIds.includes(profile.id)) return;
    pendingAction.current = profile.id;
    setBusy(previous => ({ ...previous, [profile.id]: name }));
    setErrors(previous => ({ ...previous, [profile.id]: '' }));
    try { await action(profile); if (mounted.current) { setConfirmation(null); void refresh(profile); } }
    catch (error) { if (mounted.current) { setErrors(previous => ({ ...previous, [profile.id]: core.normalizeError(error).message })); props.onError?.(error, profile); } }
    finally { pendingAction.current = null; if (mounted.current) setBusy(previous => ({ ...previous, [profile.id]: '' })); }
  };
  const runCandidate = async (name: string, entry: LocalModelConfiguration, action?: CandidateAction) => {
    if (!entry.candidate || !action || pendingAction.current || streaming || pageBusy) return;
    pendingAction.current = entry.key;
    setBusy(previous => ({ ...previous, [entry.key]: name }));
    setErrors(previous => ({ ...previous, [entry.key]: '' }));
    try { await action(entry.candidate); }
    catch (error) { if (mounted.current) setErrors(previous => ({ ...previous, [entry.key]: core.normalizeError(error).message })); }
    finally { pendingAction.current = null; if (mounted.current) setBusy(previous => ({ ...previous, [entry.key]: '' })); }
  };
  const confirmActions: Record<ConfirmationAction, { label: string; title: string; body: string; callback: Action }> = {
    stop: { label: w.stop, title: w.stopTitle, body: w.stopBody, callback: props.onStop },
    restart: { label: w.restart, title: w.restartTitle, body: w.restartBody, callback: props.onRestart },
    takeover: { label: w.takeover, title: w.takeoverTitle, body: w.takeoverBody, callback: props.onTakeover },
    unload: { label: w.unload, title: w.unloadTitle, body: w.unloadBody, callback: props.onUnload },
    delete: { label: w.remove, title: w.deleteTitle, body: w.deleteBody, callback: props.onDelete },
  };
  const confirm = confirmation ? confirmActions[confirmation.action] : null;
  const currentIndex = profiles.findIndex(item => item.id === activeId);
  const currentHealth = healthQueries[currentIndex]?.data;
  const currentProcess = processQueries[currentIndex]?.data;
  const currentReady = props.preparingId !== activeId && healthQueries[currentIndex]?.isSuccess === true && currentHealth?.service === 'strata' && currentHealth.status === 'ok' && currentHealth.loaded === true && (!desktop || (processQueries[currentIndex]?.isSuccess === true && currentProcess?.owned === true && currentProcess.running === true));
  const currentRunning = props.preparingId !== activeId && (desktop ? processQueries[currentIndex]?.isSuccess === true && currentProcess?.owned === true && currentProcess.running === true : healthQueries[currentIndex]?.isSuccess === true && currentHealth?.service === 'strata' && currentHealth.status === 'ok');
  const modelDetails = profiles.map((profile, index) => {
    const detail = props.details?.find(item => item.profileId === profile.id);
    return { ...detail, profileId: profile.id, config: detail?.config !== undefined ? detail.config : configQueries[index]?.data ?? null };
  });
  const groupIsRunning = (group: LocalModelGroup) => group.configurations.some(entry => currentRunning && entry.profile?.id === activeId || entry.candidate?.running === true);
  const groups = core.groupLocalModels(profiles, props.candidates, modelDetails).sort((a, b) => Number(groupIsRunning(b)) - Number(groupIsRunning(a)));
  const repairGroups = groups.filter(hasMissingModelFiles);
  const repairKeys = new Set(repairGroups.map(group => group.key));
  const modelGroups = groups.filter(group => !repairKeys.has(group.key));
  const configurationCount = modelGroups.reduce((total, group) => total + group.configurations.length, 0);
  const repairConfigurationCount = repairGroups.reduce((total, group) => total + group.configurations.length, 0);
  const refreshing = scanning || (!groups.length && !!props.discoveryLoading);
  const scan = async () => {
    if (scanPending.current || pageBusy) return;
    scanPending.current = true; setScanning(true);
    try { await Promise.all([refresh(), props.onRefreshDiscovery?.()]); if (mounted.current) setErrors(previous => ({ ...previous, discovery: '' })); }
    catch (error) { if (mounted.current) setErrors(previous => ({ ...previous, discovery: core.normalizeError(error).message })); }
    finally { scanPending.current = false; if (mounted.current) setScanning(false); }
  };
  const refreshAfterDeletion = async () => { if (props.onModelDeleted) await props.onModelDeleted(); else await Promise.all([refresh(), props.onRefreshDiscovery?.()]); };
  const renderGroup = (group: LocalModelGroup) => {
      const ownedCurrentEntry = currentRunning ? group.configurations.find(item => item.profile?.id === activeId) : undefined;
      const currentEntry = ownedCurrentEntry ?? group.configurations.find(item => item.candidate?.running === true);
      const lastUsedEntry = props.lastUsedId ? group.configurations.find(item => item.profile?.id === props.lastUsedId && item !== currentEntry) : undefined;
      const preparingEntry = props.preparingId ? group.configurations.find(item => item.profile?.id === props.preparingId) : undefined;
      const entry = group.configurations.find(item => item.key === groupSelections[group.key]) ?? currentEntry ?? preparingEntry ?? group.configurations.find(item => item.profile?.id === activeId) ?? lastUsedEntry ?? group.configurations[0]!;
      const { profile, candidate } = entry;
      const index = profile ? profiles.findIndex(item => item.id === profile.id) : -1;
      const healthQuery = healthQueries[index]; const processQuery = processQueries[index];
      const health = healthQuery?.data ?? {}; const process = processQuery?.data;
      const owned = processQuery?.isSuccess === true && process?.owned === true && process.running === true;
      const runningProfile = ownedCurrentEntry?.profile ?? (owned ? profile : undefined);
      const online = healthQuery?.isSuccess === true && health.service === 'strata' && health.status === 'ok' && (!desktop || process?.running === true);
      const checking = !!profile && (healthQuery?.isLoading === true || (desktop && processQuery?.isLoading === true));
      const loaded = online && typeof health.loaded === 'boolean' ? health.loaded : undefined;
      const external = process?.external === true || (process?.running === true && !owned) || (online && !owned);
      const busyKey = profile?.id ?? entry.key;
      const isBusy = !!busy[busyKey] || (!!profile && busyProfileIds.includes(profile.id));
      const locked = pageBusy || isBusy || streaming;
      const canPrepare = !!profile && desktop && profile.managed && !!profile.installDir && !!profile.pythonPath && !!profile.configPath && processQuery?.isPending !== true && (!owned || !online);
      const canTakeOver = !!profile && desktop && !owned && process?.canTakeOver === true;
      const readyForChat = online && loaded === true && (!desktop || owned) && (!props.preparingId || props.preparingId !== profile?.id);
      const canLoad = owned && online && loaded === false;
      const needsRepair = repairKeys.has(group.key) || (!profile && candidate?.availability === 'repair');
      const isExpanded = expanded.includes(entry.key);
      const engine = objectValue(metricQueries[index]?.data?.engine);
      const version = textValue(engine.version) ?? textValue(health.engine_version) ?? candidate?.runtimeVersion;
      const config = entry.config ?? configQueries[index]?.data;
      const processLabel = !profile ? candidate?.running ? w.discoveredProcess : w.stopped : !desktop ? w.unknown : processQuery?.isPending ? w.checking : processQuery?.isError ? w.unknown : process?.reason && process.external && !process.pid ? w.unverified : process?.running ? w.running : process?.running === false ? w.stopped : w.unknown;
      const modelLabel = loaded === true ? w.loaded : loaded === false ? w.unloaded : w.unknown;
      const ownerLabel = needsRepair && !owned ? w.repair : !profile ? w.discovered : owned ? w.owned : external ? w.external : profile.managed ? w.readyToStart : w.connectionOnly;
      const status = currentEntry ? ownedCurrentEntry && currentReady ? w.ready : w.running : preparingEntry ? w.preparing : needsRepair ? w.repair : !profile ? w.discovered : checking ? w.checking : readyForChat ? w.ready : external ? w.external : process?.running === false ? w.stopped : w.offline;
      return <section key={group.key} className={'service-manager-card st-card ' + (currentEntry ? 'is-current' : '')} data-profile-id={profile?.id} data-configuration-key={entry.key}>
        <div className="service-manager-card-top"><div className="service-manager-identity"><span className="service-manager-symbol"><Server size={23} strokeWidth={1.6} /></span><div><div className="service-manager-name"><h2>{group.name}</h2></div><span className="service-manager-subtitle">{group.configurations.length} {w.configurations}</span></div></div><Badge tone={currentEntry || readyForChat ? 'positive' : needsRepair ? 'warning' : ''}>{status}</Badge></div>
        <div className="model-config-selector"><ModelConfigurationDropdown ariaLabel={group.name + ' ' + w.config} value={entry.key} language={language} modifiedLabel={w.modified} disabled={pageBusy || streaming} onValueChange={value => setGroupSelections(previous => ({ ...previous, [group.key]: value }))} onDelete={desktop ? value => { const item = group.configurations.find(configuration => configuration.key === value); if (!item || pageBusy || streaming) return; const target = item.profile ?? (item.candidate ? candidateProfile(item.candidate) : undefined); if (target) setConfigurationDeletion(target); } : undefined} options={group.configurations.map(item => {
          const detail = configurationSummary(item.config, language);
          const marker = item === currentEntry ? w.current : item === preparingEntry ? w.preparing : item === lastUsedEntry ? w.lastUsed : undefined;
          return { value: item.key, name: configurationLabel(item), summary: detail, modifiedAt: item.modifiedAt, lastActivatedAt: item.lastActivatedAt, filePath: item.profile?.configPath || item.configPath, sourcePath: item.profile ? props.details?.find(record => record.profileId === item.profile!.id)?.originalConfigPath ?? item.candidate?.configPath : item.candidate?.configPath, stateLabel: marker, state: item === currentEntry ? 'current' as const : item === preparingEntry ? 'preparing' as const : item === lastUsedEntry ? 'lastUsed' as const : undefined };
        })} /></div>
        <RequirementMeter label={`${group.name} ${configurationLabel(entry)} ${JSON.stringify(config ?? '')} ${entry.profile?.configPath ?? entry.configPath ?? ''}`} machineGB={props.hardware ? machineMemoryGB(props.hardware, props.environment) : undefined}/>
        {currentEntry && currentEntry.key !== entry.key && <div className="service-manager-current-config"><span>{w.currentConfiguration}</span><strong>{configurationLabel(currentEntry)}</strong></div>}
        {profile && healthQuery?.isError && <div className="service-manager-hint"><span>{core.normalizeError(healthQuery.error).message}</span></div>}
        {profile && healthQuery?.isSuccess && (health.service !== 'strata' || health.status !== 'ok') && <p className="service-manager-error" role="alert">{w.invalidService}</p>}
        {canLoad && <p className="service-manager-hint">{w.noModelHelp}</p>}
        {profile && desktop && !owned && !checking && !canPrepare && !canTakeOver && <p className="service-manager-hint">{w.configure}</p>}
        {needsRepair && <div className="service-manager-hint model-config-repair"><p>{w.repairHelp}</p>{candidate?.reason && <span>{candidate.reason}</span>}</div>}
        {profile && processQuery?.isError && <p className="service-manager-error" role="alert">{w.inspectFailed}: {core.normalizeError(processQuery.error).message}</p>}
        {errors[busyKey] && <p className="service-manager-error" role="alert">{w.actionFailed}: {errors[busyKey]}</p>}
        <div className="service-manager-actions">
          {profile ? <>
            {readyForChat && profile.id !== activeId && <button className="primary model-action-use" onClick={() => void run('select', profile, props.onSelect)} disabled={locked} data-tooltip={w.useHelp}><Play size={15} />{w.select}</button>}
            {readyForChat && <button className="primary model-action-use" onClick={() => void run('chat', profile, props.onChat)} disabled={locked}><MessageSquare size={15} />{w.chat}</button>}
            {canTakeOver ? <button className="primary model-action-use" onClick={() => setConfirmation({ action: 'takeover', profile })} disabled={locked}><Play size={15} />{w.takeover}</button> : canPrepare && <button className="primary model-action-use" onClick={() => void run('start', profile, props.onStart)} disabled={locked || needsRepair} data-tooltip={needsRepair ? w.repairHelp : w.useHelp}><Play size={15} />{w.select}</button>}
            {canLoad && <button className="primary model-action-use" onClick={() => void run('load', profile, profile.id === activeId ? props.onLoad : props.onStart)} disabled={locked || needsRepair} data-tooltip={needsRepair ? w.repairHelp : undefined}><Play size={15} />{w.load}</button>}
            <button className="model-action-config" onClick={() => void run('config', profile, props.onConfig)} disabled={locked} data-tooltip={w.configHelp}><Settings2 size={15} />{w.configShort}</button>
          </> : <>
            <button className="primary model-action-use" onClick={() => void runCandidate('use', entry, props.onUseCandidate)} disabled={locked || !desktop || !props.onUseCandidate || needsRepair} data-tooltip={!desktop ? w.desktopRequired : needsRepair ? w.repairHelp : w.useHelp}><Play size={15} />{w.select}</button>
            <button className="model-action-config" onClick={() => void runCandidate('config', entry, props.onConfigCandidate)} disabled={locked || !desktop || !props.onConfigCandidate} data-tooltip={w.configHelp}><Settings2 size={15} />{w.configShort}</button>
          </>}
          {runningProfile && <><button className="danger model-action-stop" onClick={() => setConfirmation({ action: 'stop', profile: runningProfile })} disabled={locked} data-tooltip={w.stopBody}><Square size={14} />{w.stop}</button><button className="model-action-restart" onClick={() => setConfirmation({ action: 'restart', profile: runningProfile })} disabled={locked} data-tooltip={w.restartBody}><RefreshCw size={14} />{w.restart}</button></>}
          {isBusy && <span className="service-manager-working" role="status"><LoaderCircle size={14} className="spin" />{w.working}</span>}
          <button className="service-manager-expand" aria-expanded={isExpanded} aria-controls={'service-details-' + entry.key} onClick={() => setExpanded(previous => previous.includes(entry.key) ? previous.filter(key => key !== entry.key) : [...previous, entry.key])}><ChevronDown size={15} />{isExpanded ? w.hideDetails : w.details}</button>
        </div>
        {isExpanded && <div className="service-manager-details" id={'service-details-' + entry.key}>
          <div className="service-manager-statuses"><div><span>{w.service}</span><strong>{ownerLabel}</strong></div><div><span>{w.process}</span><strong>{processLabel}</strong></div><div><span>{w.modelState}</span><strong>{modelLabel}</strong></div><div className="service-manager-model"><span>{w.model}</span><strong>{online ? textValue(health.model) ?? w.unknown : textValue(config?.model_name) ?? group.name}</strong></div></div>
          {config && <details className="model-config-json"><summary>{language === 'zh-CN' ? '查看详细配置（JSON）' : 'View full configuration (JSON)'}</summary><pre>{visibleConfiguration(config)}</pre></details>}
          <dl>
            {profile && <><div><dt>{w.health}</dt><dd>{online ? w.online : w.offline}</dd></div><div><dt>{w.api}</dt><dd><code>{profile.baseUrl}</code></dd></div></>}
            <div><dt>{w.version}</dt><dd>{metricQueries[index]?.isFetching ? w.checking : version ?? w.unknown}</dd></div><div><dt>{w.installDir}</dt><dd><code>{profile?.installDir || candidate?.installDir || w.configurationMissing}</code></dd></div><div><dt>{w.python}</dt><dd><code>{profile?.pythonPath || candidate?.pythonPath || w.configurationMissing}</code></dd></div><div><dt>{w.configPath}</dt><dd><code>{entry.configPath || w.configurationMissing}</code></dd></div><div><dt>{w.modified}</dt><dd>{modifiedDate(entry.modifiedAt, language)}</dd></div><div><dt>{w.lastActivated}</dt><dd>{modifiedDate(entry.lastActivatedAt, language)}</dd></div>
            {candidate?.modelPath && <><div><dt>{w.modelFile}</dt><dd><code>{candidate.modelPath}</code></dd></div><div><dt>{w.modelSize}</dt><dd>{modelSize(candidate.modelBytes)}</dd></div></>}
            <div><dt>{w.logPath}</dt><dd><code>{configQueries[index]?.isFetching ? w.checking : textValue(config?.log) ?? w.unknown}</code></dd></div>{process?.pid && <div><dt>{w.pid}</dt><dd>{process.pid}</dd></div>}
          </dl>
          {(metricQueries[index]?.isError || configQueries[index]?.isError) && <p className="service-manager-error">{w.detailFailed}: {core.normalizeError(configQueries[index]?.error ?? metricQueries[index]?.error).message}</p>}
          <div className="service-manager-detail-actions">{profile && <><button onClick={() => void run('edit', profile, props.onEdit)} disabled={locked || !desktop}><Pencil size={15} />{w.edit}</button><button onClick={() => void run('logs', profile, props.onLogs)} disabled={locked || !desktop} data-tooltip={desktop ? w.logsHint : w.desktopRequired}><FileText size={15} />{w.logs}</button>{owned && online && loaded === true && <button className="model-action-restart" onClick={() => setConfirmation({ action: 'unload', profile })} disabled={locked} data-tooltip={w.unloadBody}><Square size={14} />{w.unload}</button>}<button className="danger model-action-stop" onClick={() => setConfirmation({ action: 'delete', profile })} disabled={locked || !desktop} data-tooltip={w.deleteBody}><Trash2 size={15} />{w.remove}</button></>}<button className="danger model-action-stop" onClick={() => setModelDeletion({ modelName: group.name, profiles: modelDeletionProfiles(group.configurations) })} disabled={locked || !desktop} data-tooltip={w.retainConfigurations}><Trash2 size={15} />{w.deleteModel}</button></div>
          {profile && external && <div className="service-manager-ownership"><p>{canTakeOver ? w.takeoverHelp : w.externalHelp}</p>{process?.reason && <span>{core.normalizeError(process.reason).message}</span>}</div>}
          {profile && !owned && !canTakeOver && (!profile.managed || !profile.installDir || !profile.pythonPath || !profile.configPath) && <div className="service-manager-configure"><FolderOpen size={16} /><p>{w.configure}</p><button onClick={props.onImport} disabled={locked}>{language === 'zh-CN' ? '重新检测' : 'Detect again'}</button></div>}
          {health.api_key === true && <p className="service-manager-hint">{w.authHelp}</p>}
        </div>}
      </section>;
  };
  return <div className="service-manager" data-testid="service-manager">
    <ModelsLead hardware={props.hardware ?? {}} environment={props.environment} online={!!props.hardwareOnline} models={modelGroups.length} configurations={configurationCount} current={props.hardwareOnline ? props.profiles.find(item => item.id === props.activeId)?.name : undefined}/>
    <div className="service-manager-list-heading"><span>{modelGroups.length} {w.total} · {configurationCount} {w.configurations}</span><div className="service-manager-toolbar">
      <button className="primary" onClick={props.onAdd} disabled={!desktop || streaming || pageBusy} data-tooltip={!desktop ? w.desktopRequired : undefined}><FolderOpen size={16} />{w.add}</button>
      <button onClick={() => void scan()} disabled={refreshing || pageBusy}><RefreshCw size={14} className={refreshing ? 'spin' : ''} />{w.refresh}</button>
    </div></div>
    {refreshing && <p className="service-manager-scanning" role="status"><LoaderCircle size={15} className="spin" />{w.scan}</p>}
    {(props.discoveryError || errors.discovery) && <p className="service-manager-error" role="alert">{w.scanFailed}: {errors.discovery || core.normalizeError(props.discoveryError).message}</p>}
    {!groups.length && !props.discoveryLoading && <div className="service-manager-empty st-card"><Empty title={w.noServices} hint={(props.addedDirectories?.length ?? 0) > 0 ? w.noServicesDataHelp : w.noServicesHelp}><div className="service-manager-toolbar"><button className="primary" onClick={props.onAdd} disabled={!desktop || streaming || pageBusy}><FolderOpen size={16} />{w.add}</button></div></Empty></div>}
    <div className="service-manager-list">{modelGroups.map(renderGroup)}</div>
    {!!repairGroups.length && <details className="service-manager-repair-configurations">
      <summary>{w.repairConfigurations} · {repairConfigurationCount} {w.configurations}</summary>
      <p>{w.repairConfigurationsHelp}</p>
      <div className="service-manager-list">{repairGroups.map(renderGroup)}</div>
    </details>}
    {confirmation && confirm && <OfficialDialog title={confirm.title} onClose={() => { if (!busy[confirmation.profile.id]) setConfirmation(null); }}>
      <p>{confirm.body}</p><div className="service-manager-confirm-identity"><strong>{confirmation.profile.name}</strong><code>{confirmation.profile.baseUrl}</code>{confirmation.action === 'takeover' && <><code>{confirmation.profile.installDir}</code><code>{confirmation.profile.configPath}</code></>}</div>
      {errors[confirmation.profile.id] && <p className="service-manager-error" role="alert">{errors[confirmation.profile.id]}</p>}
      <div className="dialog-footer"><button disabled={!!busy[confirmation.profile.id]} onClick={() => setConfirmation(null)}>{w.cancel}</button><button className={confirmation.action === 'delete' || confirmation.action === 'stop' ? 'danger' : 'primary'} disabled={!!busy[confirmation.profile.id] || streaming || busyProfileIds.includes(confirmation.profile.id)} onClick={() => void run(confirmation.action, confirmation.profile, confirm.callback)}>{busy[confirmation.profile.id] ? <><LoaderCircle size={15} className="spin" />{w.working}</> : confirm.label}</button></div>
    </OfficialDialog>}
    {modelDeletion && <ModelDeletionDialog {...modelDeletion} language={language} disabled={streaming || pageBusy} onClose={() => setModelDeletion(null)} onDeleted={refreshAfterDeletion} />}
    {configurationDeletion && <ConfigurationDeletionDialog profile={configurationDeletion} language={language} onClose={() => setConfigurationDeletion(null)} onDeleted={refreshAfterDeletion} />}
  </div>;
}
