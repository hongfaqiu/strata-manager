// Engine and model storage locations (user feedback: "the engine and models can only go on C:").
// One panel on the Strata page, one line on Download models, two rows in the first-run guide;
// all open the same model-location dialog. Strings: zh-CN and English, other locales use English.
import type { AppLanguage } from '@strata-manager/core';
import * as core from '@strata-manager/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, FolderOpen, HardDrive, LoaderCircle, RotateCcw, Square } from 'lucide-react';
import { Dialog, Panel } from '../components';
import { Radio } from '../OfficialControls';
import './storage-location.css';

const zh = {
  title: '存储位置',
  intro: '模型文件很大（通常 70–120 GB），可以放到任意磁盘。',
  model: '模型文件', modelHint: '下载的模型、打包文件和 MTP 都放在这里。',
  engine: '新引擎安装位置', engineHint: '之后新安装的 Strata 引擎放在这里（约 1 GB）。已安装的引擎留在原位置。',
  currentEngine: '当前引擎', change: '更改…', reset: '恢复默认', choosing: '选择中…',
  used: '已用 {{size}}', free: '{{volume}} 剩余 {{size}}', freeUnknown: '剩余空间未知',
  sourceRemembered: '与官方 Strata 共用', sourceDefault: '默认位置', sourceCustom: '已自定义',
  stripLabel: '模型保存位置',
  dialogTitle: '更改模型保存位置', from: '当前位置', to: '新位置', chooseFolder: '选择文件夹…', chooseAgain: '换一个',
  notChosen: '还没有选择', driveRootNote: '选择盘符根目录时，会自动使用其中的 Strata-data 文件夹。',
  moveTitle: '把已有模型移动过去（推荐）', moveHint: '先复制到新位置并逐字节核对，确认无误后更新模型配置里的路径，再删除旧文件。中途失败或取消，旧文件和设置都不变。移动期间不能启动模型。',
  keepTitle: '只让新下载使用新位置', keepHint: '已有模型留在原处，照常可以使用；以后下载的模型放到新位置。',
  noFiles: '当前位置还没有模型文件，直接切换即可。', sameVolume: '在同一个磁盘内移动，几乎不占额外空间。',
  needSpace: '新位置剩余空间不足：需要 {{need}}，可用 {{free}}。请选择其他磁盘，或选择「只让新下载使用新位置」。',
  confirm: '确认更改', confirmMove: '开始移动', cancel: '取消', saving: '正在保存…',
  moving: '正在移动模型文件', cancelMove: '取消移动', moveDone: '模型文件已移动完成。', changed: '已更改模型保存位置。',
  engineChanged: '之后新安装的引擎会放在 {{path}}。',
  desktopOnly: '需要桌面后台才能更改。',
};
const en: typeof zh = {
  title: 'Storage locations',
  intro: 'Model files are large (usually 70–120 GB) and can live on any drive.',
  model: 'Model files', modelHint: 'Downloaded models, packed files and the MTP layer go here.',
  engine: 'New engine install location', engineHint: 'Strata engines installed from now on go here (about 1 GB). Installed engines stay where they are.',
  currentEngine: 'Current engine', change: 'Change…', reset: 'Use default', choosing: 'Choosing…',
  used: '{{size}} used', free: '{{size}} free on {{volume}}', freeUnknown: 'Free space unknown',
  sourceRemembered: 'Shared with official Strata', sourceDefault: 'Default', sourceCustom: 'Custom',
  stripLabel: 'Models are saved to',
  dialogTitle: 'Change where models are saved', from: 'Current location', to: 'New location', chooseFolder: 'Choose folder…', chooseAgain: 'Choose another',
  notChosen: 'Not chosen yet', driveRootNote: 'Choosing a drive root uses a Strata-data folder inside it.',
  moveTitle: 'Move my existing models there (recommended)', moveHint: 'Files are copied to the new folder and verified byte by byte; then the paths in model configurations are updated and the old files are deleted. If anything fails or you cancel, the old files and setting stay as they were. Models cannot start while files move.',
  keepTitle: 'Use the new location for new downloads only', keepHint: 'Existing models stay where they are and keep working; new downloads go to the new folder.',
  noFiles: 'There are no model files here yet; the location simply switches.', sameVolume: 'Same drive: the folders are moved in place without extra space.',
  needSpace: 'Not enough free space on the new drive: {{need}} needed, {{free}} free. Choose another drive, or use the new location for new downloads only.',
  confirm: 'Change location', confirmMove: 'Start moving', cancel: 'Cancel', saving: 'Saving…',
  moving: 'Moving model files', cancelMove: 'Cancel move', moveDone: 'Model files moved.', changed: 'Model location changed.',
  engineChanged: 'Engines installed from now on go to {{path}}.',
  desktopOnly: 'Changing locations requires the desktop backend.',
};
export type StorageCopy = typeof zh;
export const storageCopy = (language: AppLanguage): StorageCopy => core.legacyLanguage(language) === 'zh-CN' ? zh : en;
const fill = (text: string, values: Record<string, string>) => text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '');

export function freeText(t: StorageCopy, location: core.StorageLocation | undefined) {
  if (!location || location.availableBytes === undefined) return t.freeUnknown;
  return fill(t.free, { volume: core.storageVolumeLabel(location), size: core.formatStorageBytes(location.availableBytes) });
}

export function useStorageLocations(desktop: boolean, installDir?: string) {
  return useQuery({
    queryKey: ['storage-locations', installDir ?? ''],
    queryFn: () => core.storageLocations(installDir),
    enabled: desktop, staleTime: 15000, retry: false, refetchOnWindowFocus: false,
    refetchInterval: query => query.state.data?.movingTaskId ? 2000 : 60000,
  });
}

function useMoveTask(desktop: boolean, taskId?: string) {
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: core.listTasks, enabled: desktop && !!taskId, refetchInterval: taskId ? 1500 : false });
  return taskId ? tasks.data?.find(task => task.id === taskId) : undefined;
}

function invalidateStorage(query: ReturnType<typeof useQueryClient>) {
  for (const key of ['storage-locations', 'setupDisk', 'setup-disk', 'localModels', 'runtime-installation']) void query.invalidateQueries({ queryKey: [key] });
}

export interface ModelLocationDialogProps {
  language: AppLanguage; desktop: boolean; installDir?: string; current: core.StorageLocation;
  onChooseDirectory: () => Promise<string | null>; onClose: () => void; onChanged?: (result: core.ModelDirectoryChange) => void;
  /** Screenshot fixtures start with a folder already chosen. */
  initialTarget?: string;
}

export function ModelLocationDialog({ language, desktop, installDir, current, onChooseDirectory, onClose, onChanged, initialTarget }: ModelLocationDialogProps) {
  const t = storageCopy(language); const query = useQueryClient();
  const [target, setTarget] = useState(initialTarget ?? '');
  const [mode, setMode] = useState<'move' | 'keep'>('move');
  const [choosing, setChoosing] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const alive = useRef(true); useEffect(() => () => { alive.current = false; }, []);
  const probe = useQuery({ queryKey: ['storage-probe', target], queryFn: () => core.storageLocations(installDir, target), enabled: desktop && !!target, retry: false, staleTime: 10000 });
  const destination = probe.data?.probe;
  const used = current.usedBytes ?? 0;
  const sameVolume = !!destination?.mountPoint && destination.mountPoint === current.mountPoint;
  const fits = core.storageMoveFits(used, destination, sameVolume);
  const moving = used > 0 && mode === 'move';
  const choose = async () => {
    if (choosing || saving) return;
    setChoosing(true); setError('');
    try { const chosen = await onChooseDirectory(); if (chosen && alive.current) setTarget(chosen); }
    catch (cause) { if (alive.current) setError(core.normalizeError(cause).message); }
    finally { if (alive.current) setChoosing(false); }
  };
  const submit = async () => {
    if (!target || saving || (moving && !fits)) return;
    setSaving(true); setError('');
    try {
      const result = await core.setModelDataDirectory(target, moving, installDir);
      invalidateStorage(query);
      onChanged?.(result); onClose();
    } catch (cause) { if (alive.current) setError(core.runtimeBilingualText(core.normalizeError(cause).message, core.legacyLanguage(language) === 'zh-CN')); }
    finally { if (alive.current) setSaving(false); }
  };
  return <Dialog title={t.dialogTitle} onClose={() => { if (!saving) onClose(); }}>
    <div className="storage-dialog" data-testid="model-location-dialog">
      <dl className="storage-dialog-paths">
        <div><dt>{t.from}</dt><dd><code>{current.path}</code><small>{used > 0 ? `${fill(t.used, { size: core.formatStorageBytes(used) })} · ` : ''}{freeText(t, current)}</small></dd></div>
        <ArrowRight className="storage-dialog-arrow" size={16} aria-hidden="true"/>
        <div><dt>{t.to}</dt><dd>{target ? <><code>{target}</code><small>{probe.isPending ? '…' : freeText(t, destination)}</small></> : <span className="storage-muted">{t.notChosen}</span>}
          <button type="button" className="st-btn st-btn--secondary storage-choose" disabled={!desktop || choosing || saving} onClick={() => void choose()}><FolderOpen size={14}/>{choosing ? t.choosing : target ? t.chooseAgain : t.chooseFolder}</button></dd></div>
      </dl>
      {used > 0 ? <fieldset className="storage-dialog-modes" disabled={saving}>
        <label className={mode === 'move' ? 'is-selected' : ''}><Radio name="storage-mode" checked={mode === 'move'} onChange={() => setMode('move')}/><span><strong>{t.moveTitle}</strong><small>{t.moveHint}</small></span></label>
        <label className={mode === 'keep' ? 'is-selected' : ''}><Radio name="storage-mode" checked={mode === 'keep'} onChange={() => setMode('keep')}/><span><strong>{t.keepTitle}</strong><small>{t.keepHint}</small></span></label>
      </fieldset> : <p className="storage-muted">{t.noFiles}</p>}
      {target && moving && sameVolume && <p className="storage-muted">{t.sameVolume}</p>}
      {target && moving && !fits && <p className="notice warning" role="alert">{fill(t.needSpace, { need: core.formatStorageBytes(used), free: core.formatStorageBytes(destination?.availableBytes) })}</p>}
      {!target && <p className="storage-muted">{t.driveRootNote}</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="storage-dialog-actions"><button type="button" disabled={saving} onClick={onClose}>{t.cancel}</button><button type="button" className="primary" disabled={!desktop || !target || saving || (moving && !fits) || probe.isPending} onClick={() => void submit()}>{saving && <LoaderCircle size={14} className="spin"/>}{saving ? t.saving : moving ? t.confirmMove : t.confirm}</button></div>
    </div>
  </Dialog>;
}

function MoveProgress({ language, desktop, taskId }: { language: AppLanguage; desktop: boolean; taskId: string }) {
  const t = storageCopy(language);
  const task = useMoveTask(desktop, taskId);
  const percent = core.storageMoveProgress(task?.message);
  const [cancelling, setCancelling] = useState(false);
  return <div className="storage-progress" role="status" data-testid="model-move-progress">
    <LoaderCircle size={15} className="spin"/>
    <div><strong>{t.moving}</strong><div className={`storage-bar${percent === undefined ? ' is-indeterminate' : ''}`}><i style={percent === undefined ? undefined : { width: `${percent}%` }}/></div><small>{core.storageMoveMessage(task?.message, core.legacyLanguage(language) === 'zh-CN') || '…'}</small></div>
    <button type="button" className="st-btn st-btn--secondary" disabled={cancelling} onClick={() => { setCancelling(true); void core.cancelTask(taskId).finally(() => setCancelling(false)); }}><Square size={12}/>{t.cancelMove}</button>
  </div>;
}

function sourceLabel(t: StorageCopy, source: core.StorageLocation['source']) {
  return source === 'remembered' ? t.sourceRemembered : source === 'custom' ? t.sourceCustom : t.sourceDefault;
}

export interface StorageLocationPanelProps { language: AppLanguage; desktop: boolean; installDir?: string; onChooseDirectory: () => Promise<string | null>; operationDisabled?: boolean; initialDialogTarget?: string }

/** Strata page: model files and the engine install folder, each with its drive's free space. */
export function StorageLocationPanel({ language, desktop, installDir, onChooseDirectory, operationDisabled = false, initialDialogTarget }: StorageLocationPanelProps) {
  const t = storageCopy(language); const query = useQueryClient();
  const locations = useStorageLocations(desktop, installDir);
  const [dialog, setDialog] = useState(!!initialDialogTarget);
  const [engineBusy, setEngineBusy] = useState(false), [note, setNote] = useState(''), [error, setError] = useState('');
  const data = locations.data;
  const changeEngine = async (reset: boolean) => {
    if (engineBusy) return;
    setEngineBusy(true); setError(''); setNote('');
    try {
      const chosen = reset ? null : await onChooseDirectory();
      if (!reset && !chosen) return;
      const engine = await core.setEngineInstallRoot(chosen);
      setNote(fill(t.engineChanged, { path: engine.path })); invalidateStorage(query);
    } catch (cause) { setError(core.runtimeBilingualText(core.normalizeError(cause).message, core.legacyLanguage(language) === 'zh-CN')); }
    finally { setEngineBusy(false); }
  };
  const busy = operationDisabled || !desktop || !!data?.movingTaskId;
  return <Panel title={t.title} className="storage-panel">
    <p className="storage-intro">{t.intro}</p>
    {locations.error && <p className="notice error" role="alert">{core.normalizeError(locations.error).message}</p>}
    <div className="storage-rows" data-testid="storage-locations">
      <div className="storage-row">
        <div className="storage-row-head"><HardDrive size={16} aria-hidden="true"/><strong>{t.model}</strong>{data && <span className="storage-tag">{sourceLabel(t, data.model.source)}</span>}</div>
        <code className="storage-path" data-tooltip={data?.model.path}>{data?.model.path ?? '…'}</code>
        <p className="storage-meta">{data ? <>{data.model.usedBytes ? <span>{fill(t.used, { size: core.formatStorageBytes(data.model.usedBytes) })}</span> : null}<span>{freeText(t, data.model)}</span></> : null}<span className="storage-hint">{t.modelHint}</span></p>
        <div className="storage-actions"><button type="button" disabled={busy || !data} onClick={() => setDialog(true)}><FolderOpen size={14}/>{t.change}</button></div>
        {data?.movingTaskId && <MoveProgress language={language} desktop={desktop} taskId={data.movingTaskId}/>}
      </div>
      <div className="storage-row">
        <div className="storage-row-head"><HardDrive size={16} aria-hidden="true"/><strong>{t.engine}</strong>{data && <span className="storage-tag">{sourceLabel(t, data.engine.source)}</span>}</div>
        <code className="storage-path" data-tooltip={data?.engine.path}>{data?.engine.path ?? '…'}</code>
        <p className="storage-meta">{data && <span>{freeText(t, data.engine)}</span>}<span className="storage-hint">{t.engineHint}</span></p>
        {data?.currentEngine && <p className="storage-meta storage-current"><span>{t.currentEngine}</span><code>{data.currentEngine.path}</code>{data.currentEngine.usedBytes ? <span>{core.formatStorageBytes(data.currentEngine.usedBytes)}</span> : null}</p>}
        <div className="storage-actions"><button type="button" disabled={busy || engineBusy} onClick={() => void changeEngine(false)}><FolderOpen size={14}/>{engineBusy ? t.choosing : t.change}</button>{data?.engine.source === 'custom' && <button type="button" disabled={busy || engineBusy} onClick={() => void changeEngine(true)}><RotateCcw size={14}/>{t.reset}</button>}</div>
      </div>
    </div>
    {!desktop && <p className="storage-muted">{t.desktopOnly}</p>}
    {note && <p className="storage-note" role="status">{note}</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {dialog && data && <ModelLocationDialog language={language} desktop={desktop} installDir={installDir} current={data.model} onChooseDirectory={onChooseDirectory} onClose={() => setDialog(false)} initialTarget={initialDialogTarget} onChanged={result => { if (!result.moving) setNote(t.changed); }}/>}
  </Panel>;
}

/** Download models page: one line above the catalog. */
export function ModelLocationStrip({ language, desktop, installDir, onChooseDirectory, disabled = false }: { language: AppLanguage; desktop: boolean; installDir?: string; onChooseDirectory: () => Promise<string | null>; disabled?: boolean }) {
  const t = storageCopy(language);
  const locations = useStorageLocations(desktop, installDir);
  const [dialog, setDialog] = useState(false);
  const data = locations.data;
  if (!desktop || !data) return null;
  return <div className="storage-strip" data-testid="model-location-strip">
    <HardDrive size={15} aria-hidden="true"/>
    <span className="storage-strip-label">{t.stripLabel}</span>
    <code className="storage-strip-path" data-tooltip={data.model.path}>{data.model.path}</code>
    <span className="storage-strip-free">{freeText(t, data.model)}</span>
    <button type="button" disabled={disabled || !!data.movingTaskId} onClick={() => setDialog(true)}>{t.change}</button>
    {data.movingTaskId && <MoveProgress language={language} desktop={desktop} taskId={data.movingTaskId}/>}
    {dialog && <ModelLocationDialog language={language} desktop={desktop} installDir={installDir} current={data.model} onChooseDirectory={onChooseDirectory} onClose={() => setDialog(false)}/>}
  </div>;
}

/** First-run guide rows: where the engine will be installed and where models will go. */
export function GuideStorageRows({ language, desktop, onChooseDirectory, renderRow }: { language: AppLanguage; desktop: boolean; onChooseDirectory?: () => Promise<string | null>; renderRow: (label: string, value: ReactNode, action?: ReactNode) => ReactNode }) {
  const t = storageCopy(language); const query = useQueryClient();
  const locations = useStorageLocations(desktop);
  const [dialog, setDialog] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const data = locations.data;
  const changeEngine = async () => {
    if (!onChooseDirectory || busy) return;
    setBusy(true); setError('');
    try { const chosen = await onChooseDirectory(); if (chosen) { await core.setEngineInstallRoot(chosen); invalidateStorage(query); } }
    catch (cause) { setError(core.runtimeBilingualText(core.normalizeError(cause).message, core.legacyLanguage(language) === 'zh-CN')); }
    finally { setBusy(false); }
  };
  const value = (location?: core.StorageLocation) => location ? <><code className="ob-mono-small">{location.path}</code><small>{freeText(t, location)}</small></> : <small>…</small>;
  const button = (onClick: () => void) => onChooseDirectory && desktop ? <button type="button" className="st-btn st-btn--secondary" disabled={busy || !data} onClick={onClick}><FolderOpen size={13}/>{t.change}</button> : undefined;
  return <>
    {renderRow(t.engine, value(data?.engine), button(() => void changeEngine()))}
    {renderRow(t.model, value(data?.model), button(() => setDialog(true)))}
    {error && <p className="ob-error" role="alert">{error}</p>}
    {dialog && data && onChooseDirectory && <ModelLocationDialog language={language} desktop={desktop} current={data.model} onChooseDirectory={onChooseDirectory} onClose={() => setDialog(false)}/>}
  </>;
}
