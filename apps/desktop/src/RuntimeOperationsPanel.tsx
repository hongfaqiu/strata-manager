import type { AppLanguage } from "@strata-manager/core";
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleHelp, RefreshCw } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { JsonObject, RuntimeOperationFailure, ServiceProfile, SessionStorageCapability, SessionStorageResult, VramResizeResult } from '@strata-manager/core';
import { OfficialDialog as Dialog, NumberField } from './OfficialControls';
import './runtime-operations.css';

export interface RuntimeOperationsPanelProps {
  profile?: ServiceProfile;
  online: boolean;
  owned: boolean;
  language: AppLanguage;
  disabled?: boolean;
  onError?: (error: unknown) => void;
  onMessage?: (message: string) => void;
}

/** A service change creates a separate operation/result session; polling never resets inputs. */
export function RuntimeOperationsPanel(props: RuntimeOperationsPanelProps) {
  return <RuntimeOperationsSession key={`${props.profile?.id}:${props.profile?.baseUrl}:${props.profile?.configPath}`} {...props}/>;
}

function RuntimeOperationsSession({ profile, online, owned, language, disabled = false, onError, onMessage }: RuntimeOperationsPanelProps) {
  const zh = language === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en;
  const residentModeMessage = t('当前模型的低内存模式不支持在线调整显存。', 'This model’s low-memory mode does not support adjusting VRAM while running.');
  const mounted = useRef(true), busyRef = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [reserve, setReserve] = useState('4096'), [filename, setFilename] = useState('chat.bin');
  const [working, setWorking] = useState<'vram' | 'probe' | 'save' | 'restore' | 'refresh' | null>(null);
  const [capability, setCapability] = useState<SessionStorageCapability | null>(null);
  const [vramBlocked, setVramBlocked] = useState(false);
  const [failure, setFailure] = useState<RuntimeOperationFailure | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [vramResult, setVramResult] = useState<{ value: VramResizeResult; at: number } | null>(null);
  const [sessionResult, setSessionResult] = useState<{ value: SessionStorageResult; at: number } | null>(null);
  const [confirmation, setConfirmation] = useState<{ action: 'save' | 'restore'; filename: string } | null>(null);
  const status = useQuery({ queryKey: ['runtime-operation-status', profile?.id, profile?.baseUrl], queryFn: () => core.request(profile!, '/v1/status'), enabled: !!profile && online, retry: false, refetchInterval: online ? 5000 : false, refetchOnWindowFocus: false });
  const config = useQuery({ queryKey: ['runtime-operation-config', profile?.id, profile?.baseUrl, profile?.configPath], enabled: !!profile && (core.isDesktop() || online), retry: false, refetchOnWindowFocus: false,
    queryFn: async (): Promise<JsonObject> => {
      if (core.isDesktop()) return (await core.readConfigSnapshot(profile!)).config;
      const result = await core.request(profile!, '/config');
      return Object.fromEntries(Array.isArray(result.keys) ? result.keys.map(core.asObject).filter(field => typeof field.key === 'string').map(field => [String(field.key), field.value]) : []);
    } });
  const state = core.asObject(status.data), vram = core.asObject(state.vram);
  const loaded = state.loaded === true, elastic = vram.elastic === true;
  const lock = disabled || !!working || !profile || !online || !owned || status.isPending || status.isError;
  const engine = typeof state.engine === 'string' ? state.engine : '–';
  const savePath = typeof config.data?.slot_save_path === 'string' ? config.data.slot_save_path : null;
  const fmt = (value: number | null, digits = 0) => value === null ? '–' : value.toLocaleString(language, { maximumFractionDigits: digits });
  const displayTime = (value: number) => new Date(value).toLocaleTimeString(language);
  const run = async (kind: NonNullable<typeof working>, action: () => Promise<void>) => {
    if (busyRef.current || !profile || !online || !owned || disabled) return;
    busyRef.current = true; setWorking(kind); setFailure(null);
    try { await action(); } catch (error) {
      if (mounted.current) {
        const detail = core.describeRuntimeOperationFailure(error); setFailure(detail);
        if (detail.unsupported) {
          if (kind === 'vram') setVramBlocked(true);
          if (kind === 'save' || kind === 'restore') setCapability({ state: 'unsupported', reason: detail.message });
        }
        onError?.(detail.kind === 'vram-resident-low-ram' ? new core.StrataError('VRAM_RESIDENT_MODE_UNSUPPORTED', residentModeMessage, detail.status, error) : error);
      }
    } finally { busyRef.current = false; if (mounted.current) setWorking(null); }
  };
  const resize = (reset: boolean) => void run('vram', async () => {
    const value = reset ? null : reserve.trim() === '' ? NaN : Number(reserve);
    const result = await core.resizeRuntimeVram(profile!, value);
    if (!mounted.current) return;
    setVramResult({ value: result, at: Date.now() });
    if (result.state === 'applied' && result.reserveMet === true) onMessage?.(t(`显存操作完成，当前空闲 ${fmt(result.freeMiB)} MiB。`, `VRAM operation completed; ${fmt(result.freeMiB)} MiB is free.`));
    await status.refetch();
  });
  const probe = () => void run('probe', async () => {
    const next = await core.probeSessionStorage(profile!);
    if (mounted.current) setCapability(next);
  });
  const confirmSession = (action: 'save' | 'restore') => {
    try { core.validateSessionFilename(filename); setFailure(null); setConfirmation({ action, filename }); }
    catch (error) { setFailure(core.describeRuntimeOperationFailure(error)); }
  };
  const executeSession = () => {
    if (!confirmation) return;
    const selected = confirmation;
    void run(selected.action, async () => {
      const result = await core.operateSessionStorage(profile!, selected.action, selected.filename);
      if (!mounted.current) return;
      setSessionResult({ value: result, at: Date.now() }); setConfirmation(null);
      onMessage?.(selected.action === 'save' ? t(`会话已保存：${result.filename}`, `Session saved: ${result.filename}`) : t(`引擎会话已恢复：${result.filename}`, `Engine session restored: ${result.filename}`));
      await status.refetch();
    });
  };
  const refresh = () => void run('refresh', async () => {
    const [fresh] = await Promise.all([status.refetch(), config.refetch()]);
    if (fresh.isError) throw fresh.error;
    if (mounted.current) { setVramBlocked(false); setCapability(null); }
  });
  const failureNote = failure?.published ? t('文件已经替换，但服务报告后续写入失败。请检查已有文件，未自动重试。', 'The file was replaced, but a later write step failed. Check the existing file; no retry was issued.')
    : failure?.needsReload ? t('缓存调整失败。请先卸载并重新加载模型，再检查弹性显存。', 'The cache resize failed. Unload and reload the model, then check elastic VRAM again.')
    : failure?.status === 507 ? t('磁盘空间或存档预留空间不足。清理保存目录后重试。', 'The disk or its session reserve has insufficient space. Free space in the save directory before trying again.')
    : failure?.kind === 'memory' ? t('运行时拒绝内存申请。请减少其他程序或会话缓存的内存占用后重试。', 'The runtime refused the memory allocation. Reduce other applications or conversation-cache memory before trying again.')
    : failure?.status === 404 ? t('保存文件不存在，或当前服务版本没有此接口。检查文件名和运行时版本。', 'The saved file is missing, or this service version lacks the endpoint. Check the filename and runtime version.')
    : failure?.status === 409 ? t('服务正在处理请求。完成后再操作。', 'The service is processing a request. Try after it finishes.')
    : failure?.status === null && failure ? t('操作结果未确认；检查服务状态后再决定是否重试。', 'The operation outcome is unconfirmed; check service state before deciding whether to retry.') : '';
  const residentModeUnsupported = failure?.kind === 'vram-resident-low-ram';
  const failureSummary = !failure ? '' : residentModeUnsupported ? residentModeMessage
    : failure.status === null && /[\u3400-\u9fff]/.test(failure.message) ? failure.message
    : failureNote || (/[\u3400-\u9fff]/.test(failure.message) ? failure.message : t('操作未完成，请检查服务状态。', 'The operation did not complete. Check the service status.'));
  return <section className="st-card runtime-operations" aria-label={t('显存与会话', 'VRAM and sessions')}>
    <div className="runtime-operations-heading"><div className="runtime-operations-title"><h2>{t('显存与会话', 'VRAM and sessions')}</h2><button className="st-btn st-btn--icon" type="button" data-tooltip={t('显存与会话帮助', 'VRAM and session help')} aria-label={t('显存与会话帮助', 'VRAM and session help')} onClick={() => setHelpOpen(true)}><CircleHelp size={16}/></button></div><button className="st-btn st-btn--secondary" type="button" disabled={disabled || !!working || !profile || !online || !owned} onClick={refresh}><RefreshCw size={14}/>{working === 'refresh' ? t('检查中…', 'Checking…') : t('刷新状态', 'Refresh status')}</button></div>
    {!owned && <p className="muted">{t('请先由本应用启动此服务，再执行运行控制。', 'Start this service through the app before using runtime controls.')}</p>}
    {!online && <p className="muted">{t('服务未连接。', 'The service is disconnected.')}</p>}
    {status.isError && <div className="notice error runtime-operation-error" role="alert"><span>{t('无法读取服务状态。', 'Could not read the service status.')}</span><button className="runtime-operation-diagnostic" type="button" onClick={() => setHelpOpen(true)}>{t('查看诊断', 'View diagnostic')}</button></div>}
    <div className="runtime-operations-grid">
      <section className="runtime-operation-section"><h3>{t('临时让出显存', 'Temporarily release VRAM')}</h3>
        <p className="runtime-operations-state">{vramBlocked ? residentModeUnsupported ? residentModeMessage : t('当前模型不支持在线调整显存。', 'This model does not support adjusting VRAM while running.') : elastic ? t('可为其他程序腾出显存，回答速度可能降低。', 'Free VRAM for other apps; answers may become slower.') : t('当前服务暂不能调整显存。', 'VRAM adjustment is unavailable on this service.')}</p>
        <label className="st-label"><span>{t('希望保留的空闲显存（MiB）', 'Desired free VRAM (MiB)')}</span><NumberField min={0} step={256} value={reserve} disabled={!!working} onChange={event => setReserve(event.currentTarget.value)}/></label>
        <div className="runtime-operations-actions"><button className="st-btn st-btn--primary" type="button" disabled={lock || !elastic || vramBlocked} onClick={() => resize(false)}>{working === 'vram' ? t('调整中…', 'Resizing…') : t('释放显存', 'Free VRAM')}</button><button className="st-btn st-btn--secondary" type="button" disabled={lock || !elastic || vramBlocked} onClick={() => resize(true)}>{t('恢复默认预留', 'Restore default reserve')}</button></div>

        {vramResult && <div className="runtime-operation-result" data-warning={vramResult.value.state === 'deferred' || vramResult.value.reserveMet !== true}><strong>{vramResult.value.state === 'deferred' ? t('目标已登记，将在下次加载时应用；当前未释放显存。', 'The target is recorded for the next load; no VRAM was released now.') : vramResult.value.reserveMet === false ? t('调整已执行，空闲目标未完全满足。', 'The resize ran; the free VRAM target was not fully met.') : vramResult.value.reserveMet === true ? t('空闲目标已满足。', 'The free VRAM target is met.') : t('调整已执行，服务未提供足够数据确认空闲目标。', 'The resize ran, but the service did not provide enough data to verify the target.')}</strong><dl className="runtime-operation-facts"><dt>{t('结果时间', 'Result time')}</dt><dd>{displayTime(vramResult.at)}</dd><dt>{t('目标／实际空闲', 'Target / actual free')}</dt><dd>{fmt(vramResult.value.reserveMiB)} / {fmt(vramResult.value.freeMiB)} MiB</dd><dt>{t('专家缓存／完整缓存', 'Expert cache / full cache')}</dt><dd>{fmt(vramResult.value.expertCacheMiB)} / {fmt(vramResult.value.fullExpertCacheMiB)} MiB</dd><dt>{t('完整缓存恢复', 'Full cache restored')}</dt><dd>{vramResult.value.fullyRestored === null ? '–' : vramResult.value.fullyRestored ? t('是', 'Yes') : t('否', 'No')}</dd></dl></div>}
      </section>
      <section className="runtime-operation-section"><h3>{t('保存与恢复会话', 'Save and restore sessions')}<span className="runtime-operation-experimental">{t('实验', 'Experimental')}</span></h3>
        <p className="runtime-operations-state">{capability?.state === 'available' ? t('当前模型可存档。', 'Session files are available for this model.') : capability?.state === 'unsupported' ? t('当前模型暂不支持存档。', 'Session files are unavailable for this model.') : !loaded ? t('先加载模型，再检查是否可存档。', 'Load a model before checking session support.') : t('先检查当前模型是否可存档。', 'Check session support for the current model first.')}</p>
        <button className="st-btn st-btn--secondary" type="button" disabled={lock || !loaded} onClick={probe}>{working === 'probe' ? t('检查中…', 'Checking…') : t('检查是否可存档', 'Check session support')}</button>
        <label className="st-label"><span>{t('存档文件名', 'Session filename')}</span><input className="st-input" value={filename} disabled={!!working} onChange={event => setFilename(event.currentTarget.value)} placeholder="chat.bin"/></label>
        <div className="runtime-operations-actions"><button className="st-btn st-btn--primary" type="button" disabled={lock || !loaded || capability?.state !== 'available'} onClick={() => confirmSession('save')}>{working === 'save' ? t('保存中…', 'Saving…') : t('保存会话', 'Save session')}</button><button className="st-btn st-btn--secondary" type="button" disabled={lock || !loaded || capability?.state !== 'available'} onClick={() => confirmSession('restore')}>{working === 'restore' ? t('恢复中…', 'Restoring…') : t('恢复会话', 'Restore session')}</button></div>

        {sessionResult && <div className="runtime-operation-result"><strong>{sessionResult.value.action === 'save' ? t('引擎会话已保存。', 'The engine session was saved.') : t('引擎会话已恢复；继续发送匹配的聊天历史即可复用。', 'The engine session was restored; continue with matching chat history to reuse it.')}</strong><dl className="runtime-operation-facts"><dt>{t('文件', 'File')}</dt><dd>{sessionResult.value.filename}</dd><dt>{t('结果时间', 'Result time')}</dt><dd>{displayTime(sessionResult.at)}</dd><dt>Tokens</dt><dd>{fmt(sessionResult.value.tokens)}</dd><dt>{t('数据大小', 'Data size')}</dt><dd>{fmt(sessionResult.value.bytes / 1048576, 1)} MiB</dd><dt>{t('引擎耗时', 'Engine time')}</dt><dd>{sessionResult.value.elapsedMs === null ? '–' : `${fmt(sessionResult.value.elapsedMs, 1)} ms`}</dd></dl></div>}
      </section>
    </div>
    {failure && !confirmation && <div className={`notice ${residentModeUnsupported ? '' : 'error '}runtime-operation-error`} role="alert"><span>{failureSummary}</span><button className="runtime-operation-diagnostic" type="button" onClick={() => setHelpOpen(true)}>{t('查看诊断', 'View diagnostic')}</button></div>}
    {confirmation && <Dialog title={confirmation.action === 'save' ? t('保存引擎会话', 'Save engine session') : t('恢复引擎会话', 'Restore engine session')} onClose={() => { if (!working) setConfirmation(null); }}><div className="runtime-operations-confirmation"><code>{confirmation.filename}</code><p>{confirmation.action === 'save' ? t('此操作会用当前引擎状态替换保存目录内的同名存档。', 'This replaces a file with the same name in the save directory with the current engine state.') : t('此操作会用所选存档替换引擎当前会话状态。聊天列表不随之切换，请之后继续发送匹配的历史。', 'This replaces the engine’s current session state with the selected file. The chat list does not switch with it; continue with matching history afterwards.')}</p><div className="runtime-operation-error" role="alert">{failure && <><span>{failureSummary}</span><button className="runtime-operation-diagnostic" type="button" disabled={!!working} onClick={() => { setConfirmation(null); setHelpOpen(true); }}>{t('查看诊断', 'View diagnostic')}</button></>}</div><div className="runtime-operations-actions"><button className="st-btn st-btn--secondary" type="button" disabled={!!working} onClick={() => setConfirmation(null)}>{t('取消', 'Cancel')}</button><button className="st-btn st-btn--primary" type="button" disabled={lock || !loaded || capability?.state !== 'available'} onClick={executeSession}>{working ? t('处理中…', 'Working…') : confirmation.action === 'save' ? t('保存', 'Save') : t('恢复', 'Restore')}</button></div></div></Dialog>}
    {helpOpen && <Dialog title={t('显存与会话说明', 'VRAM and sessions')} onClose={() => setHelpOpen(false)}><div className="runtime-operations-help-content">
      {(failure || (capability && capability.state !== 'available') || status.isError) && <><h3>{t('诊断', 'Diagnostic')}</h3>{failure && <pre>{failure.status !== null && `HTTP ${failure.status}: `}{failure.message}</pre>}{capability && capability.state !== 'available' && <pre>{capability.reason}</pre>}{status.isError && <pre>{core.normalizeError(status.error).message}</pre>}</>}
      <h3>{t('调整显存', 'Adjust VRAM')}</h3><p>{t('在模型配置中启用“弹性显存”并重启后可用（--vram-elastic），支持单张 NVIDIA GPU。设置的是整张显卡希望保留的空闲 MiB，只调整专家缓存。低内存驻留模式、多 GPU 或忙碌并发槽可能不支持此操作。', 'Enable Elastic VRAM in model configuration and restart (--vram-elastic). This supports one NVIDIA GPU. The target is free MiB on the whole card and adjusts only the expert cache. Resident low-memory mode, multiple GPUs or busy batch slots may not support this operation.')}</p><p>{t('其他应用占用显存时可能只能部分恢复。重启服务后恢复启动时的预留值。', 'Other applications may prevent a full restore. Restarting the service restores its startup reserve.')}</p>
      <h3>{t('会话存档', 'Session files')}</h3><p>{t('在模型配置的完整 JSON 中设置 slot_save_path 保存目录，再重启模型。操作时只填写文件名。', 'Set the slot_save_path directory in the model’s full JSON configuration and restart. Enter only the filename when saving or restoring.')}{savePath && <> {t('当前目录', 'Current directory')}: <code>{savePath}</code></>}</p><p>{t('存档复用长会话的模型缓存，聊天记录单独保存。恢复需同一模型、引擎版本和兼容配置；文件可能占用数 GiB。当前仅支持单槽 0，不支持并发请求、layer-split、peer-device 或关闭 prompt-cache。', 'Files reuse a long conversation’s model cache; chat history is saved separately. Restore requires the same model, engine version and compatible configuration, and files may use several GiB. Only slot 0 is supported, without batch requests, layer-split, peer-device or disabled prompt-cache.')}</p><p>{t('引擎版本', 'Engine version')}: {engine}</p>
    </div></Dialog>}

  </section>;
}
