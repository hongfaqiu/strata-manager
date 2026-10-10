import { useEffect, useRef, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { ArrowRight, ChevronDown, Download, FileText, FolderOpen, LoaderCircle, MessageSquare, PackageCheck, Pencil, Play, Plus, RefreshCw, ScanSearch, Server, Settings2, Square, Trash2 } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { JsonObject, ProcessStatus, ServiceProfile } from '@strata-manager/core';
import { Badge, Empty } from '../components';
import { OfficialDialog } from '../OfficialControls';
import './service-manager.css';

type Action = (profile: ServiceProfile) => void | Promise<unknown>;
type InspectedProcess = ProcessStatus & { external?: boolean; canTakeOver?: boolean; reason?: string };
type ConfirmationAction = 'stop' | 'restart' | 'takeover' | 'unload' | 'delete' | 'update';

export interface ServiceManagerPageProps {
  profiles: ServiceProfile[];
  activeId: string;
  language: 'zh-CN' | 'en';
  desktop: boolean;
  pollInterval?: number;
  streaming?: boolean;
  busyProfileIds?: string[];
  onSelect: Action;
  onAdd: () => void;
  onImport: () => void;
  onEdit: Action;
  /** Called after this page's delete confirmation. Remove the profile, never the installation. */
  onDelete: Action;
  onStart: Action;
  onStop: Action;
  onRestart: Action;
  onUpdate: Action;
  /** Called only after explicit confirmation, and only for a verified canTakeOver process. */
  onTakeover: Action;
  onLoad: Action;
  onUnload: Action;
  onConfig: Action;
  onLogs: Action;
  onChat: Action;
  onOnboarding: () => void;
  onEnvironment: () => void;
  onInstall?: () => void;
  onError?: (error: unknown, profile: ServiceProfile) => void;
}

const words = {
  'zh-CN': {
    intro: '选择这台电脑上已有的模型，后台会检测、接管并准备模型。切换时会先结束旧模型，再载入选定模型。',
    add: '使用已有模型', install: '安装 Strata', detect: '查看本机环境', guide: '使用向导', refresh: '刷新状态',
    chooseStep: '选择本机模型', prepareStep: '后台自动准备', switchStep: '切换模型',
    service: '后台管理', serviceHelp: '使用本机已安装的模型；还没有 Strata 时，先安装运行环境，再选择模型。',
    model: '模型', modelHelp: '后台会检查运行环境、启动 Strata 并载入选定模型。准备完成后即可聊天和使用本机 API。',
    currentHelp: '同一时间运行一个模型。选择其他模型会先结束当前模型，再载入新的模型，聊天记录会保留。',
    noServices: '先添加一个本机模型', noServicesHelp: '已经有 Strata 和模型时，点击“使用已有模型”检测并导入。首次使用可先安装 Strata，再选择要下载的模型。',
    checking: '检查中', online: '接口可用', offline: '尚未就绪', ready: '可以聊天', unknown: '未提供', loaded: '已加载', unloaded: '未加载',
    owned: '后台已接管', external: '等待后台接管', connectionOnly: '等待导入', readyToStart: '等待后台准备', localModel: '本机模型', api: '本机 API 地址',
    process: '进程', stopped: '未运行', running: '运行中', modelState: '模型状态', health: '服务状态',
    selected: '当前选择', select: '使用此模型', chat: '开始聊天', start: '启用此模型', retryEnable: '重试启用', prepare: '准备模型', stop: '停止模型服务', restart: '重启模型服务',
    load: '加载模型', unload: '卸载模型', takeover: '接管并启用', config: '运行配置', logs: '查看日志',
    update: '检查并更新 Strata', updateTitle: '更新此模型的 Strata 运行环境',
    updateBody: '后台会检查应用支持的兼容版本，在新目录准备运行环境。当前请求结束后才切换，期间 API 会短暂不可用；验证失败会恢复原环境。原仓库、配置和模型文件保留，不重复下载模型权重。',
    details: '详情与管理', hideDetails: '收起详情', edit: '重命名模型', remove: '移出模型列表',
    installDir: 'Strata 目录', python: 'Python 路径', configPath: '模型配置文件', logPath: '引擎日志配置', version: '引擎版本', pid: '进程 ID',
    desktopRequired: '请在桌面应用中准备本机模型。',
    configure: '这个模型还需要检测并导入。点击“使用已有模型”，由应用检查安装和模型配置。',
    takeoverHelp: '此模型由其他程序运行。接管会结束已核验的 Strata 进程，再由后台准备；模型文件保留在原位置。',
    externalHelp: '后台正在等待可核验的本机实例。接管完成后才能聊天；无法核验时会提示具体原因。',
    waitingOwnership: '等待后台接管。可重试启用此模型，完成后即可聊天。',
    offlineHelp: '模型暂未就绪。后台会自动准备；可重试启用，失败原因会显示在这里。',
    invalidService: '本机实例尚未返回有效的 Strata 状态，请刷新或重试启用。',
    noModelHelp: '模型尚未载入。点击“准备模型”，后台完成准备后即可聊天。',
    inspectFailed: '进程状态检查失败', unverified: '身份未核验', detailFailed: '无法读取部分详情', actionFailed: '操作失败', cancel: '取消', working: '处理中…',
    stopTitle: '停止此模型服务', stopBody: '将停止这个模型的 Strata 进程并释放模型资源，正在进行的请求会被中断。之后可点击“启用此模型”恢复使用。',
    restartTitle: '重启此模型服务', restartBody: '后台将按最新运行配置重新准备此模型，正在进行的请求会被中断。',
    takeoverTitle: '交由后台接管并启用', takeoverBody: '将结束已核验的本机 Strata 进程，再由本应用后台准备此模型。原模型文件会保留，正在进行的请求会被中断；原来的启动程序可能需要手动关闭。',
    unloadTitle: '卸载当前模型', unloadBody: '释放此模型占用的内存与显存。服务程序继续运行，正在进行的请求会被中断；之后可以重新加载模型。',
    deleteTitle: '移出本机模型列表', deleteBody: '移除本应用保存的模型记录，Strata 和模型文件会保留。正在使用的模型需要先在详情中停止服务。',
    authHelp: '服务需要 API Key 时，可在运行配置页设置。',
    configurationMissing: '尚未指定', total: '个本机模型', logsHint: '可查看本应用进程输出与模型配置中指定的引擎日志。',
  },
  en: {
    intro: 'Choose an existing model on this computer. The background checks, takes ownership of and prepares the model. Switching ends the previous model before loading your selection.',
    add: 'Use an existing model', install: 'Install Strata', detect: 'View local environment', guide: 'Setup guide', refresh: 'Refresh status',
    chooseStep: 'Choose a local model', prepareStep: 'Automatic preparation', switchStep: 'Switch models',
    service: 'Background management', serviceHelp: 'Use a model installed on this computer. If Strata is not installed yet, install the runtime first, then choose a model.',
    model: 'Model', modelHelp: 'The background checks the runtime, starts Strata and loads your selection. Once ready, you can chat and use the local API.',
    currentHelp: 'One model runs at a time. Choosing another model ends the current model before loading the new one. Chat history is retained.',
    noServices: 'Add your first local model', noServicesHelp: 'Already have Strata and a model? Use an existing model to detect and import it. For a first installation, install Strata, then choose a model to download.',
    checking: 'Checking', online: 'API available', offline: 'Not ready', ready: 'Ready to chat', unknown: 'Not reported', loaded: 'Loaded', unloaded: 'Not loaded',
    owned: 'Managed by the background', external: 'Awaiting ownership', connectionOnly: 'Awaiting import', readyToStart: 'Awaiting preparation', localModel: 'Local model', api: 'Local API address',
    process: 'Process', stopped: 'Not running', running: 'Running', modelState: 'Model state', health: 'Service status',
    selected: 'Selected', select: 'Use this model', chat: 'Start chatting', start: 'Enable this model', retryEnable: 'Retry enabling', prepare: 'Prepare model', stop: 'Stop model service', restart: 'Restart model service',
    load: 'Load model', unload: 'Unload model', takeover: 'Take ownership and enable', config: 'Runtime settings', logs: 'View logs',
    update: 'Check and update Strata', updateTitle: 'Update this model’s Strata runtime',
    updateBody: 'The background checks the app-supported compatible version and prepares it in a new directory. It waits for current requests before switching, with a brief API interruption. Failed verification restores the original environment. Your source, configuration and model files are retained; model weights are not downloaded again.',
    details: 'Details and management', hideDetails: 'Hide details', edit: 'Rename model', remove: 'Remove from model list',
    installDir: 'Strata directory', python: 'Python path', configPath: 'Model configuration', logPath: 'Engine log setting', version: 'Engine version', pid: 'Process ID',
    desktopRequired: 'Prepare local models in the desktop app.',
    configure: 'This model still needs detection and import. Use an existing model so the app can check its installation and configuration.',
    takeoverHelp: 'Another program is running this model. Taking ownership ends the verified Strata process and prepares the model in the background. Model files stay in their original location.',
    externalHelp: 'The background is waiting for a verifiable local instance. Chat becomes available after ownership is established. Verification failures show the specific reason.',
    waitingOwnership: 'Awaiting background ownership. Retry enabling this model to prepare it for chat.',
    offlineHelp: 'The model is not ready yet. The background prepares it automatically. Retry enabling it; any failure will be shown here.',
    invalidService: 'The local instance has not returned a valid Strata status. Refresh or retry enabling it.',
    noModelHelp: 'The model is not loaded yet. Choose Prepare model; chat becomes available when preparation finishes.',
    inspectFailed: 'Process inspection failed', unverified: 'Identity unverified', detailFailed: 'Some details could not be read', actionFailed: 'Operation failed', cancel: 'Cancel', working: 'Working…',
    stopTitle: 'Stop this model service', stopBody: 'Stops this model’s Strata process and releases model resources. Active requests will be interrupted. Choose Enable this model to resume later.',
    restartTitle: 'Restart this model service', restartBody: 'The background prepares this model again using the latest runtime configuration. Active requests will be interrupted.',
    takeoverTitle: 'Transfer ownership and enable', takeoverBody: 'Ends the verified local Strata process, then prepares this model using the app background. Model files are retained. Active requests will be interrupted; its original launcher may need to be closed manually.',
    unloadTitle: 'Unload the current model', unloadBody: 'Frees the RAM and VRAM used by the model. The service stays running. Active requests will be interrupted; you can load the model again later.',
    deleteTitle: 'Remove from local model list', deleteBody: 'Removes the saved model record while retaining Strata and model files. Stop an active model service from its details first.',
    authHelp: 'If this service requires an API key, set it in Runtime settings.',
    configurationMissing: 'Not configured', total: 'local models', logsHint: 'View process output captured by this app and the engine log specified in the model configuration.',
  },
} as const;

const textValue = (value: unknown) => typeof value === 'string' && value.trim() ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
const objectValue = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};

/** All status requests are read-only and scoped to their own profile. Mutations remain explicit callbacks. */
export function ServiceManagerPage(props: ServiceManagerPageProps) {
  const { profiles, activeId, language, desktop, streaming = false, pollInterval = 5000, busyProfileIds = [] } = props;
  const w = words[language];
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmation, setConfirmation] = useState<{ action: ConfirmationAction; profile: ServiceProfile } | null>(null);
  const pendingAction = useRef<string | null>(null);
  const pageBusy = Object.values(busy).some(Boolean) || busyProfileIds.length > 0;
  const interval = Math.max(1000, pollInterval);
  const healthQueries = useQueries({ queries: profiles.map(profile => ({
    queryKey: ['service-manager-health', profile.id, profile.baseUrl],
    queryFn: () => core.request(profile, '/health'),
    refetchInterval: interval, refetchOnWindowFocus: false, retry: false,
  })) });
  const processQueries = useQueries({ queries: profiles.map(profile => ({
    queryKey: ['service-manager-process', profile.id, profile.baseUrl, profile.installDir, profile.pythonPath, profile.configPath, profile.managed],
    queryFn: () => core.serviceStatus(profile.id, profile) as Promise<InspectedProcess>,
    enabled: desktop, refetchInterval: Math.max(10000, interval), refetchOnWindowFocus: false, retry: false,
  })) });
  const metricQueries = useQueries({ queries: profiles.map((profile, index) => ({
    queryKey: ['service-manager-details', profile.id, profile.baseUrl],
    queryFn: () => core.request(profile, '/metrics'),
    enabled: expanded.includes(profile.id) && healthQueries[index]?.isSuccess === true,
    refetchOnWindowFocus: false, retry: false,
  })) });
  const configQueries = useQueries({ queries: profiles.map(profile => ({
    queryKey: ['service-manager-local-config', profile.id, profile.configPath],
    queryFn: () => core.readConfig(profile),
    enabled: desktop && expanded.includes(profile.id) && !!profile.configPath,
    refetchOnWindowFocus: false, retry: false,
  })) });
  const refresh = (profile?: ServiceProfile) => {
    const indexes = profile ? [profiles.findIndex(item => item.id === profile.id)] : profiles.map((_, index) => index);
    for (const index of indexes) if (index >= 0) { void healthQueries[index]?.refetch(); if (desktop) void processQueries[index]?.refetch(); if (expanded.includes(profiles[index]!.id)) { void metricQueries[index]?.refetch(); if (desktop && profiles[index]?.configPath) void configQueries[index]?.refetch(); } }
  };
  const run = async (name: string, profile: ServiceProfile, action: Action) => {
    if (pendingAction.current || streaming || busyProfileIds.includes(profile.id)) return;
    pendingAction.current = profile.id;
    setBusy(previous => ({ ...previous, [profile.id]: name }));
    setErrors(previous => ({ ...previous, [profile.id]: '' }));
    try { await action(profile); if (mounted.current) { setConfirmation(null); refresh(profile); } }
    catch (error) { if (mounted.current) { setErrors(previous => ({ ...previous, [profile.id]: core.normalizeError(error).message })); props.onError?.(error, profile); } }
    finally { pendingAction.current = null; if (mounted.current) setBusy(previous => ({ ...previous, [profile.id]: '' })); }
  };
  const confirmActions: Record<ConfirmationAction, { label: string; title: string; body: string; callback: Action }> = {
    stop: { label: w.stop, title: w.stopTitle, body: w.stopBody, callback: props.onStop },
    restart: { label: w.restart, title: w.restartTitle, body: w.restartBody, callback: props.onRestart },
    takeover: { label: w.takeover, title: w.takeoverTitle, body: w.takeoverBody, callback: props.onTakeover },
    unload: { label: w.unload, title: w.unloadTitle, body: w.unloadBody, callback: props.onUnload },
    delete: { label: w.remove, title: w.deleteTitle, body: w.deleteBody, callback: props.onDelete },
    update: { label: w.update, title: w.updateTitle, body: w.updateBody, callback: props.onUpdate },
  };
  const confirm = confirmation ? confirmActions[confirmation.action] : null;
  return <div className="service-manager" data-testid="service-manager">
    <div className="service-manager-intro"><p>{w.intro}</p><div className="service-manager-toolbar">
      <button className="primary" onClick={props.onAdd} disabled={!desktop || streaming || pageBusy} title={!desktop ? w.desktopRequired : undefined}><Plus size={16} />{w.add}</button>
      <button onClick={props.onEnvironment}><ScanSearch size={16} />{w.detect}</button>
      <button onClick={props.onInstall ?? props.onEnvironment} disabled={!desktop || streaming || pageBusy} title={!desktop ? w.desktopRequired : undefined}><Download size={16} />{w.install}</button>
      <button className="text-button" onClick={props.onOnboarding}>{w.guide}<ArrowRight size={14} /></button>
    </div></div>
    <section className="service-manager-guide st-card" aria-label={w.guide}>
      <div><strong><span>1</span>{w.chooseStep}</strong><p>{w.serviceHelp}</p></div>
      <div><strong><span>2</span>{w.prepareStep}</strong><p>{w.modelHelp}</p></div>
      <div><strong><span>3</span>{w.switchStep}</strong><p>{w.currentHelp}</p></div>
    </section>
    {!profiles.length ? <div className="service-manager-empty st-card"><Empty title={w.noServices} hint={w.noServicesHelp}><div className="service-manager-toolbar"><button className="primary" onClick={props.onAdd} disabled={!desktop || streaming || pageBusy}><Plus size={16} />{w.add}</button><button onClick={props.onInstall ?? props.onEnvironment} disabled={!desktop || streaming || pageBusy}><Download size={16} />{w.install}</button></div></Empty></div> : <>
      <div className="service-manager-list-heading"><span>{profiles.length} {w.total}</span><button onClick={() => refresh()} disabled={healthQueries.some(query => query.isFetching)}><RefreshCw size={14} className={healthQueries.some(query => query.isFetching) ? 'spin' : ''} />{w.refresh}</button></div>
      <div className="service-manager-list">{profiles.map((profile, index) => {
        const healthQuery = healthQueries[index]!; const processQuery = processQueries[index]!;
        const health = healthQuery.data ?? {}; const process = processQuery.data;
        const online = healthQuery.isSuccess && !healthQuery.isError && health.service === 'strata' && health.status === 'ok';
        const checking = healthQuery.isPending || (desktop && processQuery.isPending);
        const loaded = online && typeof health.loaded === 'boolean' ? health.loaded : undefined;
        const owned = process?.owned === true && process.running;
        const external = process?.external === true || (process?.running === true && !owned) || (online && !owned);
        const isBusy = !!busy[profile.id] || busyProfileIds.includes(profile.id);
        const locked = pageBusy || isBusy || streaming;
        const canPrepare = desktop && profile.managed && !!profile.installDir && !!profile.pythonPath && !!profile.configPath && !processQuery.isPending && (!owned || !online || loaded !== true);
        const canTakeOver = desktop && !owned && process?.canTakeOver === true;
        const readyForChat = online && loaded === true && (!desktop || owned);
        const isExpanded = expanded.includes(profile.id);
        const engine = objectValue(metricQueries[index]?.data?.engine);
        const version = textValue(engine.version) ?? textValue(health.engine_version);
        const config = configQueries[index]?.data;
        const processLabel = !desktop ? w.unknown : processQuery.isPending ? w.checking : processQuery.isError ? w.unknown : process?.reason && process.external && !process.pid ? w.unverified : process?.running ? w.running : process?.running === false ? w.stopped : w.unknown;
        const modelLabel = loaded === true ? w.loaded : loaded === false ? w.unloaded : w.unknown;
        const ownerLabel = owned ? w.owned : external ? w.external : profile.managed ? w.readyToStart : w.connectionOnly;
        return <section key={profile.id} className={`service-manager-card st-card ${profile.id === activeId ? 'is-current' : ''}`} data-profile-id={profile.id}>
          <div className="service-manager-card-top"><div className="service-manager-identity"><span className="service-manager-symbol"><Server size={23} strokeWidth={1.6} /></span><div><div className="service-manager-name"><h2>{profile.name}</h2>{profile.id === activeId && <Badge tone="positive">{w.selected}</Badge>}</div><span className="service-manager-subtitle">{w.localModel}</span></div></div><Badge tone={readyForChat ? 'positive' : ''}>{checking ? w.checking : readyForChat ? w.ready : desktop && !owned ? w.external : w.offline}</Badge></div>
          <div className="service-manager-statuses"><div><span>{w.service}</span><strong>{ownerLabel}</strong></div><div><span>{w.process}</span><strong>{processLabel}</strong></div><div><span>{w.modelState}</span><strong>{modelLabel}</strong></div><div className="service-manager-model"><span>{w.model}</span><strong>{textValue(health.model) ?? w.unknown}</strong></div></div>
          {healthQuery.isError && <div className="service-manager-hint"><p>{w.offlineHelp}</p><span>{core.normalizeError(healthQuery.error).message}</span></div>}
          {healthQuery.isSuccess && !online && <p className="service-manager-error" role="alert">{w.invalidService}</p>}
          {owned && online && loaded === false && <p className="service-manager-hint">{w.noModelHelp}</p>}
          {desktop && !owned && !checking && <p className="service-manager-hint">{canPrepare || canTakeOver ? w.waitingOwnership : w.configure}</p>}
          {processQuery.isError && <p className="service-manager-error" role="alert">{w.inspectFailed}: {core.normalizeError(processQuery.error).message}</p>}
          {errors[profile.id] && <p className="service-manager-error" role="alert">{w.actionFailed}: {errors[profile.id]}</p>}
          <div className="service-manager-actions">
            {profile.id !== activeId && (!desktop || owned) && <button onClick={() => void run('select', profile, props.onSelect)} disabled={locked}><ArrowRight size={15} />{w.select}</button>}
            {readyForChat && <button className="primary" onClick={() => void run('chat', profile, props.onChat)} disabled={locked}><MessageSquare size={15} />{w.chat}</button>}
            {canTakeOver ? <button className="primary" onClick={() => setConfirmation({ action: 'takeover', profile })} disabled={locked}><Play size={15} />{w.takeover}</button> : canPrepare && <button className="primary" onClick={() => void run('start', profile, props.onStart)} disabled={locked}><Play size={15} />{owned ? w.prepare : w.retryEnable}</button>}
            {desktop && !owned && !canTakeOver && !canPrepare && !checking && <button onClick={props.onImport} disabled={locked}><FolderOpen size={15}/>{w.add}</button>}
            {isBusy && <span className="service-manager-working" role="status"><LoaderCircle size={14} className="spin" />{w.working}</span>}
            <button className="service-manager-expand" aria-expanded={isExpanded} aria-controls={`service-details-${profile.id}`} onClick={() => setExpanded(previous => previous.includes(profile.id) ? previous.filter(id => id !== profile.id) : [...previous, profile.id])}><ChevronDown size={15} />{isExpanded ? w.hideDetails : w.details}</button>
          </div>
          {isExpanded && <div className="service-manager-details" id={`service-details-${profile.id}`}>
            <dl><div><dt>{w.health}</dt><dd>{online ? w.online : w.offline}</dd></div><div><dt>{w.api}</dt><dd><code>{profile.baseUrl}</code></dd></div><div><dt>{w.version}</dt><dd>{metricQueries[index]?.isFetching ? w.checking : version ?? w.unknown}</dd></div><div><dt>{w.installDir}</dt><dd><code>{profile.installDir || w.configurationMissing}</code></dd></div><div><dt>{w.python}</dt><dd><code>{profile.pythonPath || w.configurationMissing}</code></dd></div><div><dt>{w.configPath}</dt><dd><code>{profile.configPath || w.configurationMissing}</code></dd></div><div><dt>{w.logPath}</dt><dd><code>{configQueries[index]?.isFetching ? w.checking : textValue(config?.log) ?? w.unknown}</code></dd></div>{process?.pid && <div><dt>{w.pid}</dt><dd>{process.pid}</dd></div>}</dl>
            {(metricQueries[index]?.isError || configQueries[index]?.isError) && <p className="service-manager-error">{w.detailFailed}: {core.normalizeError(configQueries[index]?.error ?? metricQueries[index]?.error).message}</p>}
            <div className="service-manager-detail-actions"><button onClick={() => void run('edit', profile, props.onEdit)} disabled={locked || !desktop}><Pencil size={15} />{w.edit}</button><button onClick={() => void run('config', profile, props.onConfig)} disabled={locked}><Settings2 size={15} />{w.config}</button><button onClick={() => void run('logs', profile, props.onLogs)} disabled={locked || !desktop} title={desktop ? w.logsHint : w.desktopRequired}><FileText size={15} />{w.logs}</button>{desktop && profile.managed && profile.installDir && profile.configPath && !external && <button onClick={() => setConfirmation({ action: 'update', profile })} disabled={locked || processQuery.isPending}><PackageCheck size={15} />{w.update}</button>}{owned && <><button onClick={() => setConfirmation({ action: 'stop', profile })} disabled={locked}><Square size={14} />{w.stop}</button><button onClick={() => setConfirmation({ action: 'restart', profile })} disabled={locked}><RefreshCw size={14} />{w.restart}</button></>}{owned && online && loaded === false && <button onClick={() => void run('load', profile, props.onLoad)} disabled={locked}><Play size={15}/>{w.load}</button>}{owned && online && loaded === true && <button onClick={() => setConfirmation({ action: 'unload', profile })} disabled={locked}><Square size={14} />{w.unload}</button>}<button className="danger" onClick={() => setConfirmation({ action: 'delete', profile })} disabled={locked || !desktop}><Trash2 size={15} />{w.remove}</button></div>
            {external && <div className="service-manager-ownership"><p>{canTakeOver ? w.takeoverHelp : w.externalHelp}</p>{process?.reason && <span>{process.reason}</span>}</div>}
            {!owned && !canTakeOver && (!profile.managed || !profile.installDir || !profile.pythonPath || !profile.configPath) && <div className="service-manager-configure"><FolderOpen size={16} /><p>{w.configure}</p></div>}
            {health.api_key === true && <p className="service-manager-hint">{w.authHelp}</p>}
          </div>}
        </section>;
      })}</div>
    </>}
    {confirmation && confirm && <OfficialDialog title={confirm.title} onClose={() => { if (!busy[confirmation.profile.id]) setConfirmation(null); }}>
      <p>{confirm.body}</p><div className="service-manager-confirm-identity"><strong>{confirmation.profile.name}</strong><code>{confirmation.profile.baseUrl}</code>{confirmation.action === 'takeover' && <><code>{confirmation.profile.installDir}</code><code>{confirmation.profile.configPath}</code></>}</div>
      {errors[confirmation.profile.id] && <p className="service-manager-error" role="alert">{errors[confirmation.profile.id]}</p>}
      <div className="dialog-footer"><button disabled={!!busy[confirmation.profile.id]} onClick={() => setConfirmation(null)}>{w.cancel}</button><button className={confirmation.action === 'delete' ? 'danger' : 'primary'} disabled={!!busy[confirmation.profile.id] || streaming || busyProfileIds.includes(confirmation.profile.id)} onClick={() => void run(confirmation.action, confirmation.profile, confirm.callback)}>{busy[confirmation.profile.id] ? <><LoaderCircle size={15} className="spin" />{w.working}</> : confirm.label}</button></div>
    </OfficialDialog>}
  </div>;
}
