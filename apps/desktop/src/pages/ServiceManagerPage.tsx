import { useEffect, useRef, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { ArrowRight, ChevronDown, Download, FileText, FolderOpen, LoaderCircle, MessageSquare, Pencil, Play, Plus, RefreshCw, ScanSearch, Server, Settings2, Square, Trash2, Upload } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { JsonObject, ProcessStatus, ServiceProfile } from '@strata-manager/core';
import { Badge, Empty } from '../components';
import { OfficialDialog } from '../OfficialControls';
import './service-manager.css';

type Action = (profile: ServiceProfile) => void | Promise<unknown>;
type InspectedProcess = ProcessStatus & { external?: boolean; canTakeOver?: boolean; reason?: string };
type ConfirmationAction = 'stop' | 'restart' | 'takeover' | 'unload' | 'delete';

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
    intro: '在这里连接或启动 Strata 服务，再加载模型开始聊天。每个服务可以使用不同的模型配置与端口。',
    add: '连接已有服务', import: '导入模型配置', install: '安装 Strata', detect: '检测本机环境', tune: '调优参数', guide: '使用向导', refresh: '刷新状态',
    service: '服务程序', serviceHelp: '提供聊天 API。启动后地址可连接，停止后该地址不可用。',
    model: '模型', modelHelp: '加载到内存 / 显存后才能回答。卸载模型可释放资源，服务地址仍然可用。',
    current: '当前服务', currentHelp: '左侧选择的服务用于聊天、监控和运行配置。切换服务不会关闭其他服务。',
    noServices: '先连接一个 Strata 服务', noServicesHelp: '已经在本机运行 Strata：填写地址连接。还没有安装：进入安装向导，准备运行环境和模型。',
    checking: '检查中', online: '可连接', offline: '未连接', unknown: '未提供', loaded: '已加载', unloaded: '未加载',
    owned: '由本应用管理', external: '由其他程序启动', connectionOnly: '仅连接', readyToStart: '可由本应用启动',
    process: '进程', stopped: '未运行', running: '运行中', modelState: '模型状态', health: '服务状态',
    selected: '当前使用', select: '设为当前', chat: '开始聊天', start: '启动服务', stop: '停止服务', restart: '重启服务',
    load: '加载模型', unload: '卸载模型', takeover: '接管并重启', config: '运行配置', logs: '查看日志',
    details: '详情与管理', hideDetails: '收起详情', edit: '编辑连接信息', remove: '移除服务',
    installDir: 'Strata 目录', python: 'Python 路径', configPath: '模型配置文件', logPath: '引擎日志配置', version: '引擎版本', pid: '进程 ID',
    desktopRequired: '服务进程操作需使用桌面应用。',
    configure: '需要管理此服务的启动和停止：先填写正确的 Strata 目录、Python 路径和模型配置文件，并启用本应用管理。',
    takeoverHelp: '此进程由其他程序启动。接管会结束经核验的 Strata 进程，并使用本档案配置重新启动；之后可在这里停止或重启。',
    externalHelp: '当前可以连接、聊天和监控。进程归属核验通过后才能接管；未核验的进程不会被停止。',
    offlineHelp: '检查地址和端口，或启动服务。已经由其他程序启动时，确认其终端是否报错。',
    invalidService: '此地址有响应，但未识别为有效的 Strata 服务。请检查地址与端口。',
    noModelHelp: '服务已连接，模型尚未加载。点击“加载模型”，加载完成后即可聊天。',
    inspectFailed: '进程状态检查失败', unverified: '身份未核验', detailFailed: '无法读取部分详情', actionFailed: '操作失败', cancel: '取消', working: '处理中…',
    stopTitle: '停止 Strata 服务', stopBody: '将停止此服务程序及其模型，正在进行的请求会被中断。需要使用时可再次启动。',
    restartTitle: '重启 Strata 服务', restartBody: '将停止并重新启动此服务，使用模型配置文件中的最新配置。正在进行的请求会被中断。',
    takeoverTitle: '接管并重启 Strata 服务', takeoverBody: '将结束此地址对应且身份已核验的外部 Strata 进程，再用本档案中的运行目录、Python 和模型配置重新启动。正在进行的请求会被中断；原来的启动程序可能需要手动关闭。',
    unloadTitle: '卸载当前模型', unloadBody: '释放此模型占用的内存与显存。服务程序继续运行，正在进行的请求会被中断；之后可以重新加载模型。',
    deleteTitle: '移除这个服务档案', deleteBody: '仅移除本应用保存的连接信息。不会卸载 Strata、删除模型文件或停止正在运行的服务。',
    authHelp: '服务需要 API Key 时，可在运行配置页设置。',
    configurationMissing: '尚未指定', refreshing: '刷新中', total: '个服务', logsHint: '可查看本应用进程输出与模型配置中指定的引擎日志。',
  },
  en: {
    intro: 'Connect to or start a Strata service, then load a model to chat. Each service can use a different model configuration and port.',
    add: 'Connect existing service', import: 'Import model config', install: 'Install Strata', detect: 'Check local environment', tune: 'Tune parameters', guide: 'Setup guide', refresh: 'Refresh status',
    service: 'Service program', serviceHelp: 'Provides the chat API. Its address is reachable while the service is running.',
    model: 'Model', modelHelp: 'Must be loaded into RAM / VRAM to answer. Unloading frees resources while the service stays reachable.',
    current: 'Current service', currentHelp: 'The service selected in the sidebar is used for chat, monitoring and runtime settings. Switching does not stop other services.',
    noServices: 'Connect your first Strata service', noServicesHelp: 'Already running Strata locally? Connect using its address. Not installed yet? Use the setup guide to prepare the runtime and a model.',
    checking: 'Checking', online: 'Reachable', offline: 'Not connected', unknown: 'Not reported', loaded: 'Loaded', unloaded: 'Not loaded',
    owned: 'Managed by this app', external: 'Started by another program', connectionOnly: 'Connection only', readyToStart: 'Can be started by this app',
    process: 'Process', stopped: 'Not running', running: 'Running', modelState: 'Model state', health: 'Service status',
    selected: 'Current', select: 'Set as current', chat: 'Start chatting', start: 'Start service', stop: 'Stop service', restart: 'Restart service',
    load: 'Load model', unload: 'Unload model', takeover: 'Take over and restart', config: 'Runtime settings', logs: 'View logs',
    details: 'Details and management', hideDetails: 'Hide details', edit: 'Edit connection', remove: 'Remove service',
    installDir: 'Strata directory', python: 'Python path', configPath: 'Model configuration', logPath: 'Engine log setting', version: 'Engine version', pid: 'Process ID',
    desktopRequired: 'Use the desktop app to manage service processes.',
    configure: 'To manage startup and shutdown, provide the correct Strata directory, Python path and model configuration, and enable management by this app.',
    takeoverHelp: 'Another program started this process. Taking over ends the verified Strata process and restarts it using this profile, so this app can stop or restart it.',
    externalHelp: 'You can connect, chat and monitor now. Taking over requires a verified process identity; an unverified process will not be stopped.',
    offlineHelp: 'Check the address and port, or start the service. If another program started it, check its terminal for errors.',
    invalidService: 'This address responded but was not identified as a valid Strata service. Check its address and port.',
    noModelHelp: 'The service is connected, but its model is not loaded. Load the model to start chatting.',
    inspectFailed: 'Process inspection failed', unverified: 'Identity unverified', detailFailed: 'Some details could not be read', actionFailed: 'Operation failed', cancel: 'Cancel', working: 'Working…',
    stopTitle: 'Stop the Strata service', stopBody: 'Stops this service and its model. Active requests will be interrupted. You can start it again when needed.',
    restartTitle: 'Restart the Strata service', restartBody: 'Stops and restarts this service using the latest model configuration. Active requests will be interrupted.',
    takeoverTitle: 'Take over and restart Strata', takeoverBody: 'Ends the verified external Strata process serving this address, then restarts it using this profile’s runtime directory, Python and model configuration. Active requests will be interrupted. You may need to close its original launcher manually.',
    unloadTitle: 'Unload the current model', unloadBody: 'Frees the RAM and VRAM used by the model. The service stays running. Active requests will be interrupted; you can load the model again later.',
    deleteTitle: 'Remove this service profile', deleteBody: 'Removes only the saved connection information. Does not uninstall Strata, delete model files or stop a running service.',
    authHelp: 'If this service requires an API key, set it in Runtime settings.',
    configurationMissing: 'Not configured', refreshing: 'Refreshing', total: 'services', logsHint: 'View process output captured by this app and the engine log specified in the model configuration.',
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
    if (busy[profile.id] || busyProfileIds.includes(profile.id)) return;
    setBusy(previous => ({ ...previous, [profile.id]: name }));
    setErrors(previous => ({ ...previous, [profile.id]: '' }));
    try { await action(profile); if (mounted.current) { setConfirmation(null); refresh(profile); } }
    catch (error) { if (mounted.current) { setErrors(previous => ({ ...previous, [profile.id]: core.normalizeError(error).message })); props.onError?.(error, profile); } }
    finally { if (mounted.current) setBusy(previous => ({ ...previous, [profile.id]: '' })); }
  };
  const confirmActions: Record<ConfirmationAction, { label: string; title: string; body: string; callback: Action }> = {
    stop: { label: w.stop, title: w.stopTitle, body: w.stopBody, callback: props.onStop },
    restart: { label: w.restart, title: w.restartTitle, body: w.restartBody, callback: props.onRestart },
    takeover: { label: w.takeover, title: w.takeoverTitle, body: w.takeoverBody, callback: props.onTakeover },
    unload: { label: w.unload, title: w.unloadTitle, body: w.unloadBody, callback: props.onUnload },
    delete: { label: w.remove, title: w.deleteTitle, body: w.deleteBody, callback: props.onDelete },
  };
  const confirm = confirmation ? confirmActions[confirmation.action] : null;
  return <div className="service-manager" data-testid="service-manager">
    <div className="service-manager-intro"><p>{w.intro}</p><div className="service-manager-toolbar">
      <button className="primary" onClick={props.onAdd} disabled={streaming}><Plus size={16} />{w.add}</button>
      <button onClick={props.onImport} disabled={!desktop || streaming} title={!desktop ? w.desktopRequired : undefined}><Upload size={16} />{w.import}</button>
      <button onClick={props.onEnvironment}><ScanSearch size={16} />{w.detect}</button>
      <button onClick={props.onInstall ?? props.onEnvironment}><Download size={16} />{w.install}</button>
      <button className="text-button" onClick={props.onOnboarding}>{w.guide}<ArrowRight size={14} /></button>
    </div></div>
    <section className="service-manager-guide st-card" aria-label={w.guide}>
      <div><strong><span>1</span>{w.service}</strong><p>{w.serviceHelp}</p></div>
      <div><strong><span>2</span>{w.model}</strong><p>{w.modelHelp}</p></div>
      <div><strong><span>3</span>{w.current}</strong><p>{w.currentHelp}</p></div>
    </section>
    {!profiles.length ? <div className="service-manager-empty st-card"><Empty title={w.noServices} hint={w.noServicesHelp}><div className="service-manager-toolbar"><button className="primary" onClick={props.onAdd}><Plus size={16} />{w.add}</button><button onClick={props.onInstall ?? props.onEnvironment}><Download size={16} />{w.install}</button></div></Empty></div> : <>
      <div className="service-manager-list-heading"><span>{profiles.length} {w.total}</span><button onClick={() => refresh()} disabled={healthQueries.some(query => query.isFetching)}><RefreshCw size={14} className={healthQueries.some(query => query.isFetching) ? 'spin' : ''} />{w.refresh}</button></div>
      <div className="service-manager-list">{profiles.map((profile, index) => {
        const healthQuery = healthQueries[index]!; const processQuery = processQueries[index]!;
        const health = healthQuery.data ?? {}; const process = processQuery.data;
        const online = healthQuery.isSuccess && !healthQuery.isError && health.service === 'strata' && health.status === 'ok';
        const checking = healthQuery.isPending;
        const loaded = online && typeof health.loaded === 'boolean' ? health.loaded : undefined;
        const owned = process?.owned === true && process.running;
        const external = process?.external === true || (process?.running === true && !owned) || (online && !owned);
        const isBusy = !!busy[profile.id] || busyProfileIds.includes(profile.id);
        const locked = isBusy || streaming;
        const canStart = desktop && profile.managed && !online && process?.running === false && !processQuery.isError;
        const canTakeOver = desktop && !owned && process?.canTakeOver === true;
        const isExpanded = expanded.includes(profile.id);
        const engine = objectValue(metricQueries[index]?.data?.engine);
        const version = textValue(engine.version) ?? textValue(health.engine_version);
        const config = configQueries[index]?.data;
        const processLabel = !desktop ? w.unknown : processQuery.isPending ? w.checking : processQuery.isError ? w.unknown : process?.reason && process.external && !process.pid ? w.unverified : process?.running ? `${w.running}${process.pid ? ` · PID ${process.pid}` : ''}` : process?.running === false ? w.stopped : w.unknown;
        const modelLabel = loaded === true ? w.loaded : loaded === false ? w.unloaded : w.unknown;
        const ownerLabel = owned ? w.owned : external ? w.external : profile.managed ? w.readyToStart : w.connectionOnly;
        return <section key={profile.id} className={`service-manager-card st-card ${profile.id === activeId ? 'is-current' : ''}`} data-profile-id={profile.id}>
          <div className="service-manager-card-top"><div className="service-manager-identity"><span className="service-manager-symbol"><Server size={23} strokeWidth={1.6} /></span><div><div className="service-manager-name"><h2>{profile.name}</h2>{profile.id === activeId && <Badge tone="positive">{w.selected}</Badge>}</div><code>{profile.baseUrl}</code></div></div><Badge tone={online ? 'positive' : ''}>{checking ? w.checking : online ? w.online : w.offline}</Badge></div>
          <div className="service-manager-statuses"><div><span>{w.service}</span><strong>{ownerLabel}</strong></div><div><span>{w.process}</span><strong>{processLabel}</strong></div><div><span>{w.modelState}</span><strong>{modelLabel}</strong></div><div className="service-manager-model"><span>{w.model}</span><strong>{textValue(health.model) ?? w.unknown}</strong></div></div>
          {healthQuery.isError && <div className="service-manager-hint"><p>{w.offlineHelp}</p><span>{core.normalizeError(healthQuery.error).message}</span></div>}
          {healthQuery.isSuccess && !online && <p className="service-manager-error" role="alert">{w.invalidService}</p>}
          {online && loaded === false && <p className="service-manager-hint">{w.noModelHelp}</p>}
          {processQuery.isError && <p className="service-manager-error" role="alert">{w.inspectFailed}: {core.normalizeError(processQuery.error).message}</p>}
          {errors[profile.id] && <p className="service-manager-error" role="alert">{w.actionFailed}: {errors[profile.id]}</p>}
          <div className="service-manager-actions">
            {profile.id !== activeId && <button onClick={() => void run('select', profile, props.onSelect)} disabled={locked}><ArrowRight size={15} />{w.select}</button>}
            {online && loaded === true && <button className="primary" onClick={() => void run('chat', profile, props.onChat)} disabled={locked}><MessageSquare size={15} />{w.chat}</button>}
            {owned && online && loaded === false && <button className="primary" onClick={() => void run('load', profile, props.onLoad)} disabled={locked}><Play size={15} />{w.load}</button>}
            {canStart && <button className="primary" onClick={() => void run('start', profile, props.onStart)} disabled={locked}><Play size={15} />{w.start}</button>}
            <button onClick={() => void run('config', profile, props.onConfig)} disabled={locked}><Settings2 size={15} />{w.tune}</button>
            {owned && <><button onClick={() => setConfirmation({ action: 'stop', profile })} disabled={locked}><Square size={14} />{w.stop}</button><button onClick={() => setConfirmation({ action: 'restart', profile })} disabled={locked}><RefreshCw size={14} />{w.restart}</button></>}
            {isBusy && <span className="service-manager-working" role="status"><LoaderCircle size={14} className="spin" />{w.working}</span>}
            <button className="service-manager-expand" aria-expanded={isExpanded} aria-controls={`service-details-${profile.id}`} onClick={() => setExpanded(previous => previous.includes(profile.id) ? previous.filter(id => id !== profile.id) : [...previous, profile.id])}><ChevronDown size={15} />{isExpanded ? w.hideDetails : w.details}</button>
          </div>
          {isExpanded && <div className="service-manager-details" id={`service-details-${profile.id}`}>
            <dl><div><dt>{w.health}</dt><dd>{online ? textValue(health.status) ?? w.unknown : w.unknown}</dd></div><div><dt>{w.version}</dt><dd>{metricQueries[index]?.isFetching ? w.checking : version ?? w.unknown}</dd></div><div><dt>{w.installDir}</dt><dd><code>{profile.installDir || w.configurationMissing}</code></dd></div><div><dt>{w.python}</dt><dd><code>{profile.pythonPath || w.configurationMissing}</code></dd></div><div><dt>{w.configPath}</dt><dd><code>{profile.configPath || w.configurationMissing}</code></dd></div><div><dt>{w.logPath}</dt><dd><code>{configQueries[index]?.isFetching ? w.checking : textValue(config?.log) ?? w.unknown}</code></dd></div>{process?.pid && <div><dt>{w.pid}</dt><dd>{process.pid}</dd></div>}</dl>
            {(metricQueries[index]?.isError || configQueries[index]?.isError) && <p className="service-manager-error">{w.detailFailed}: {core.normalizeError(configQueries[index]?.error ?? metricQueries[index]?.error).message}</p>}
            <div className="service-manager-detail-actions"><button onClick={() => void run('edit', profile, props.onEdit)} disabled={locked}><Pencil size={15} />{w.edit}</button><button onClick={() => void run('config', profile, props.onConfig)} disabled={locked}><Settings2 size={15} />{w.config}</button><button onClick={() => void run('logs', profile, props.onLogs)} disabled={locked || !desktop} title={desktop ? w.logsHint : w.desktopRequired}><FileText size={15} />{w.logs}</button>{owned && online && loaded === true && <button onClick={() => setConfirmation({ action: 'unload', profile })} disabled={locked}><Square size={14} />{w.unload}</button>}<button className="danger" onClick={() => setConfirmation({ action: 'delete', profile })} disabled={locked}><Trash2 size={15} />{w.remove}</button></div>
            {external && <div className="service-manager-ownership"><p>{canTakeOver ? w.takeoverHelp : w.externalHelp}</p>{process?.reason && <span>{process.reason}</span>}{canTakeOver && <button onClick={() => setConfirmation({ action: 'takeover', profile })} disabled={locked}><RefreshCw size={15} />{w.takeover}</button>}</div>}
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
