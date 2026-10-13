import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowUpRight, ChevronRight, Download, FolderOpen, HardDrive, RefreshCw, Search, Settings2, X } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { ServiceProfile, TaskStatus } from '@strata-manager/core';
import { NumberField, Toggle } from '../OfficialControls';
import type { SaveDraft } from '../useDraftGuard';
import { ModelInspectPanel } from './ModelInspectPanel';
import { ModelDownloadSettingsDialog } from './ModelDownloadSettingsDialog';
import { ResourceAssessmentPanel } from './ResourceAssessmentPanel';
import './model-download.css';

export interface ModelDownloadPageProps {
  language: 'zh-CN' | 'en';
  desktop: boolean;
  fallbackRuntime?: ServiceProfile;
  runtimeOverride?: ServiceProfile | null;
  runtimes: ServiceProfile[];
  busy: boolean;
  tasks: TaskStatus[];
  onRuntimeChange: (runtime: ServiceProfile | null) => void;
  onChooseDirectory: () => Promise<string | null>;
  onChooseFile: () => Promise<string | null>;
  onPrepare: (request: ReturnType<typeof core.snapshotModelDownloadRequest>) => Promise<void>;
  onImportConfig: (path: string, runtime?: ServiceProfile) => Promise<void>;
  onTasks: () => void;
  onEnvironment: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveDraftReady?: (save: SaveDraft | undefined) => void;
}

type Selection = Omit<core.ModelDownloadSelection, 'model'>;
const defaultsQueryKey = ['model-download-defaults'] as const;
const familyDescription = (family: string, zh: boolean) => ({
  qwen: zh ? '通用对话与长文' : 'General conversation and long text',
  swift: zh ? '官方系列模型' : 'Official model family',
  coder: zh ? '代码任务' : 'Coding tasks',
  unsloth: zh ? '量化分发版本' : 'Alternative quantized distribution',
}[family] ?? (zh ? '官方模型' : 'Official model'));

export function ModelDownloadPage({ language, desktop, fallbackRuntime, runtimeOverride, runtimes, busy, tasks, onRuntimeChange, onChooseDirectory, onChooseFile, onPrepare, onImportConfig, onTasks, onEnvironment, onDirtyChange, onSaveDraftReady }: ModelDownloadPageProps) {
  const zh = language === 'zh-CN', text = (cn: string, en: string) => zh ? cn : en;
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(core.MODEL_CATALOG[0]?.id ?? '');
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [existingOpen, setExistingOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const submitLock = useRef(false);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const knownDirectory = useRef<{ runtimeKey: string; path: string } | undefined>(undefined);
  const defaults = useQuery({ queryKey: defaultsQueryKey, queryFn: async () => core.normalizeModelDownloadDefaults(await core.loadStore<unknown>(core.MODEL_DOWNLOAD_DEFAULTS_KEY, null)), staleTime: Infinity, retry: false, refetchOnWindowFocus: false });
  const saved = defaults.data ?? core.defaultModelDownloadDefaults();
  const runtime = [runtimeOverride, saved.runtime, fallbackRuntime].find((candidate): candidate is ServiceProfile => !!candidate?.managed && !!candidate.installDir);
  const searchTerm = search.trim().toLocaleLowerCase();
  const filtered = core.MODEL_CATALOG.filter(model => `${model.name} ${model.family} ${familyDescription(model.family, zh)}`.toLocaleLowerCase().includes(searchTerm));
  const entry = filtered.find(model => model.id === selectedId) ?? filtered[0];
  const selection: Selection = entry ? selections[entry.id] ?? { quant: entry.quants[0] ?? '', context: 32768, images: false } : { quant: '', context: 32768, images: false };
  const { quant, context, images } = selection;
  const contextValid = Number.isInteger(context) && context >= 512 && context <= 1048576;
  const info = entry?.quantInfo[quant];
  const disk = useQuery({ queryKey: ['setupDisk', runtime?.id, runtime?.installDir, runtime?.configPath, runtime?.pythonPath, entry?.family, quant, images],
    queryFn: () => core.setupDiskPreflight(runtime!, entry!.family, quant, images), enabled: desktop && defaults.isSuccess && !!runtime?.installDir && !!entry, staleTime: 15000, refetchInterval: 60000, retry: false, refetchOnWindowFocus: false });
  const localModels = useQuery({ queryKey: ['localModels', runtime?.id, runtime?.installDir, runtime?.configPath], queryFn: () => core.listLocalModels(runtime!), enabled: desktop && !!runtime?.installDir && existingOpen, staleTime: 15000, retry: false });
  const runtimeKey = JSON.stringify([runtime?.id, runtime?.installDir, runtime?.configPath]);
  if (disk.data?.dataDirectory && !disk.isError) knownDirectory.current = { runtimeKey, path: disk.data.dataDirectory };
  const modelDirectory = knownDirectory.current?.runtimeKey === runtimeKey ? knownDirectory.current.path : undefined;
  const runtimeStatus = useQuery({ queryKey: ['model-download-runtimes'], queryFn: core.localRuntimeInstallation, enabled: desktop && settingsOpen, staleTime: 15000, retry: false });
  const runtimeChoices = [...runtimes, ...(runtimeStatus.data?.result ? [runtimeStatus.data.result.profile] : []), ...(runtimeStatus.data?.detectedRuntimes ?? []).filter(item => item.readiness === 'ready').map(item => item.profile)].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
  const sourceLabel = saved.options.source === 'modelscope' ? 'ModelScope' : saved.options.source === 'mirror' ? text('HF 镜像', 'HF mirror') : 'Hugging Face';
  const backendLabel = saved.options.backend === 'cuda' ? 'CUDA' : saved.options.backend === 'hip' ? 'HIP' : saved.options.backend === 'sycl' ? 'SYCL' : text('自动', 'Auto');
  const gpuLabel = saved.options.gpus ? `${text('显卡', 'GPU')} ${saved.options.gpus}` : text('显卡自动选择', 'Automatic GPU selection');
  const downloadCount = tasks.filter(task => task.kind.includes('setup') && task.state === 'running').length;
  const setSelection = (patch: Partial<Selection>) => { if (entry) { setSelections(current => ({ ...current, [entry.id]: { ...selection, ...patch } })); setError(''); } };
  const resourceRequest = defaults.isSuccess && runtime && entry && contextValid && saved.options.gpus !== 'all' ? {
    installationId: runtime.id, family: entry.family, quant, context, images, kv: context <= 8192 ? 'fp16' : 'int8', gpuIds: saved.options.gpus ? saved.options.gpus.split(',').map(Number) : [], parallel: 1,
  } : undefined;
  const saveDefaults = async (value: core.ModelDownloadDefaults) => {
    const normalized = core.normalizeModelDownloadDefaults(value);
    await core.saveStore(core.MODEL_DOWNLOAD_DEFAULTS_KEY, normalized);
    queryClient.setQueryData(defaultsQueryKey, normalized);
    onRuntimeChange(normalized.runtime);
    setSettingsOpen(false); setError('');
  };
  const prepare = async () => {
    if (submitLock.current || busy || settingsOpen || !desktop || !runtime || !entry || !defaults.isSuccess) return;
    submitLock.current = true; setSubmitting(true); setError('');
    try {
      const snapshot = core.snapshotModelDownloadRequest(runtime, { model: entry.family, ...selection }, saved.options);
      // Revalidate the captured target, not whichever model the user views after this await.
      const checked = await core.setupDiskPreflight(snapshot.profile, snapshot.model, snapshot.quant, snapshot.images);
      if (checked.status !== 'ready') throw new Error(checked.status === 'insufficient' ? text('磁盘空间不足，请检查存储位置或清理空间。', 'Insufficient disk space. Check the storage location or free space.') : text('磁盘空间尚未核验，请重新检查。', 'Disk space is unverified. Check again.'));
      await onPrepare(snapshot);
    } catch (cause) { setError(core.normalizeError(cause).message); }
    finally { submitLock.current = false; setSubmitting(false); }
  };
  const importConfig = async () => {
    try { const path = await onChooseFile(); if (path) await onImportConfig(path, runtime); }
    catch (cause) { setError(core.normalizeError(cause).message); }
  };
  const selectModel = (id: string) => { setSelectedId(id); setShowDetail(true); setError(''); requestAnimationFrame(() => { if (window.matchMedia('(max-width: 1050px)').matches) detailHeading.current?.focus(); }); };
  return <section className="model-download-page" data-testid="model-download-page" data-detail={showDetail}>
    <header className="model-download-header"><div><h2>{text('下载模型', 'Download models')}</h2><p>{text('浏览官方模型目录，选择版本并准备到本机。', 'Browse the official catalog, choose a variant, and prepare it locally.')}</p></div><div className="model-download-actions"><button type="button" disabled={defaults.isPending || submitting} onClick={() => setSettingsOpen(true)}><Settings2 size={18}/>{text('模型下载配置', 'Download settings')}</button><button type="button" onClick={onTasks}><Download size={18}/>{text('下载任务', 'Download tasks')}<span className="model-download-count">{downloadCount}</span></button></div></header>
    <div className="model-download-common"><Settings2 size={17}/><strong>{text('公共配置', 'Shared settings')}</strong>{defaults.isPending ? <span role="status">{text('正在读取…', 'Loading…')}</span> : defaults.isError ? <span role="alert" className="model-download-error">{text('公共配置读取失败，请打开配置检查后保存。', 'Shared settings could not be read. Open settings and save to recover.')}</span> : <><span>{sourceLabel}</span><span aria-hidden="true">·</span><code title={modelDirectory ?? runtime?.installDir}>{runtime?.installDir ? modelDirectory ?? runtime.installDir : text('尚未选择运行环境', 'No runtime selected')}</code><span aria-hidden="true">·</span><span>{gpuLabel}{saved.options.backend !== 'auto' ? ` (${backendLabel})` : ''}</span></>}<small>{text('新下载任务使用这些默认设置。', 'Defaults apply to new download tasks.')}</small></div>
    {!runtime?.installDir && !defaults.isPending && <div className="model-download-runtime-needed"><p>{text('选择已有 Strata 运行环境，或先安装运行环境。模型目录可以先浏览。', 'Choose an existing Strata runtime or install one first. You can browse the catalog now.')}</p><button type="button" onClick={() => setSettingsOpen(true)}>{text('选择运行环境', 'Choose runtime')}</button><button type="button" onClick={onEnvironment}>{text('安装运行环境', 'Install runtime')}</button></div>}
    <div className="model-download-browser">
      <div className="model-download-list"><div className="model-download-search"><label><Search size={18}/><input type="search" aria-label={text('搜索模型', 'Search models')} placeholder={text('搜索模型', 'Search models')} value={search} onChange={event => { setSearch(event.target.value); setShowDetail(false); }}/>{search && <button type="button" className="model-download-clear" aria-label={text('清除搜索', 'Clear search')} onClick={() => setSearch('')}><X size={14}/></button>}</label><span>{text(`${filtered.length} 个模型`, `${filtered.length} models`)}</span></div>
        <div className="model-download-models" aria-label={text('模型目录', 'Model catalog')}>{filtered.map(model => <button key={model.id} ref={element => { if (element) rowRefs.current.set(model.id, element); else rowRefs.current.delete(model.id); }} type="button" className={`model-download-model${entry?.id === model.id ? ' is-selected' : ''}`} aria-pressed={entry?.id === model.id} onClick={() => selectModel(model.id)}><span className="model-download-model-icon"><HardDrive size={24}/></span><span className="model-download-model-copy"><strong>{model.name}</strong><span>{familyDescription(model.family, zh)}</span><small>{text(`${model.quants.length} 个量化版本`, `${model.quants.length} ${model.quants.length === 1 ? 'quantization' : 'quantizations'}`)} · {Math.min(...Object.values(model.quantInfo).map(value => value.downloadGB))} GB{model.quants.length > 1 ? text(' 起', ' +') : ''}</small></span><ChevronRight size={17}/></button>)}</div>
        {!filtered.length && <div className="model-download-empty"><Search size={26}/><h3>{text('没有匹配的模型', 'No matching models')}</h3><p>{text('试试模型名称或用途，例如 Qwen、Swift、代码。', 'Try a model name or purpose, such as Qwen, Swift, or coding.')}</p><button type="button" onClick={() => setSearch('')}>{text('清除搜索', 'Clear search')}</button></div>}
        <p className="model-download-catalog-note">{text('目录来自官方安装器快照，实际支持以所选运行环境为准。', 'Catalog from the official installer snapshot. Actual support depends on the selected runtime.')}<span>{core.MODEL_CATALOG[0]?.snapshotDate}</span></p>
      </div>
      {entry ? <div className="model-download-detail"><div className="model-download-detail-body"><button type="button" className="model-download-back" onClick={() => { setShowDetail(false); requestAnimationFrame(() => rowRefs.current.get(entry.id)?.focus()); }}><ArrowLeft size={16}/>{text('返回模型列表', 'Back to models')}</button>
        <div className="model-download-detail-heading"><span className="model-download-family">{entry.family}</span><h3 ref={detailHeading} tabIndex={-1}>{entry.name}</h3><a href={entry.source} target="_blank" rel="noreferrer">{text('官方目录', 'Official catalog')}<ArrowUpRight size={13}/></a><p>{familyDescription(entry.family, zh)}{text('。选择适合自己的量化版本。', '. Choose a quantization for your setup.')}</p></div>
        <fieldset className="model-download-variants" disabled={submitting}><legend>{text('1. 选择量化版本', '1. Choose a quantization')}</legend><div className="model-download-variant-head" aria-hidden="true"><span>{text('量化', 'Quantization')}</span><span>{text('下载大小', 'Download size')}</span><span>{text('参考 RAM', 'RAM guidance')}</span></div>{entry.quants.map(variant => { const details = entry.quantInfo[variant]; return <label key={variant} className={`model-download-variant${quant === variant ? ' is-selected' : ''}`}><span><input type="radio" name="model-download-quant" value={variant} checked={quant === variant} onChange={() => setSelection({ quant: variant })}/><span>{variant}</span>{variant === entry.quants[0] && <small>{text('起步版本', 'Starter')}</small>}</span><span>{details?.downloadGB ?? '—'} GB</span><span>{details?.ramGB ?? '—'} GB</span></label>; })}</fieldset>
        {(info?.experimental || info?.nvidiaOnly || info?.visionUntested) && <p className="model-download-variant-warning">{[info.experimental && text('实验版本', 'Experimental'), info.nvidiaOnly && text('仅支持 NVIDIA', 'NVIDIA only'), info.visionUntested && text('图像能力未验证', 'Vision unverified')].filter(Boolean).join(' · ')}</p>}
        <details className="model-download-preset" key={entry.id}><summary><Settings2 size={17}/><strong>{text('启动预设', 'Startup preset')}</strong><span>{contextValid ? `${(context / 1024).toLocaleString(language, { maximumFractionDigits: 1 })}K` : '—'} {text('上下文', 'context')} · {images ? text('图像开启', 'Images on') : text('图像关闭', 'Images off')}</span><ChevronRight size={16}/></summary><div className="model-download-preset-body"><label><span>{text('上下文长度', 'Context length')}</span><NumberField aria-label={text('上下文长度', 'Context length')} min={512} max={1048576} step={512} value={context} disabled={submitting} onChange={event => setSelection({ context: Number(event.target.value) })}/></label><label className="model-download-image-toggle"><span>{text('启用图像支持', 'Enable image support')}</span><Toggle ariaLabel={text('启用图像支持', 'Enable image support')} checked={images} disabled={!entry.images || submitting} onCheckedChange={images => setSelection({ images })}/></label>{!contextValid && <p role="alert" className="model-download-error">{text('上下文需为 512–1,048,576 的整数。', 'Context must be an integer between 512 and 1,048,576.')}</p>}<p>{text('较长上下文和图像支持可能增加资源占用。', 'Longer context and image support may increase resource use.')}</p></div></details>
        <ResourceAssessmentPanel compact desktop={desktop} language={language} request={resourceRequest} unavailableReason={!runtime ? text('选择运行环境后可检查本机资源。', 'Choose a runtime to check local resources.') : !contextValid ? text('请填写有效的上下文长度后重新预估。', 'Enter a valid context length to estimate resources.') : saved.options.gpus === 'all' ? text('已选择全部 GPU，当前规则无法完整估算多卡配置。', 'All GPUs are selected. Current rules cannot fully estimate multi-GPU configurations.') : undefined} disk={disk.data} diskPending={disk.isPending && !!runtime && desktop && defaults.isSuccess} diskError={disk.error} onRefreshDisk={() => void disk.refetch()}/>
      </div><footer className="model-download-submit"><div><span>{text('已选择', 'Selected')}: <strong>{quant} · {contextValid ? `${(context / 1024).toLocaleString(language, { maximumFractionDigits: 1 })}K` : '—'} · {images ? text('图像开启', 'Images on') : text('图像关闭', 'Images off')}</strong></span><button type="button" className="primary" disabled={!desktop || !runtime?.installDir || busy || submitting || settingsOpen || !defaults.isSuccess || !contextValid || disk.isPending || disk.isError || disk.data?.status !== 'ready'} onClick={() => void prepare()}><Download size={18}/>{submitting ? text('正在检查并提交…', 'Checking and submitting…') : `${text('下载并准备', 'Download and prepare')} · ${info?.downloadGB ?? '—'} GB`}</button></div>{error && <p role="alert" className="model-download-error">{error}</p>}<p>{!desktop ? text('需要桌面后台执行模型准备。', 'Preparing models requires the desktop backend.') : busy ? text('请等待当前操作完成后再准备模型。', 'Wait for the current operation before preparing a model.') : text('下载 → 打包 → 生成配置，完成后在“我的模型”手动启用。', 'Download → pack → create configuration. Enable it from My models when ready.')}</p></footer></div> : <div className="model-download-no-detail" aria-hidden="true"><HardDrive size={32}/></div>}
    </div>
    <details className="model-download-existing" onToggle={event => setExistingOpen(event.currentTarget.open)}><summary>{text('已有模型与兼容性检查', 'Existing models and compatibility')}</summary><div className="model-download-existing-actions"><p>{text('导入已有配置，或检查其它模型文件是否可用于当前环境。', 'Import an existing configuration, or check model-file compatibility with this runtime.')}</p><button type="button" disabled={!desktop || busy} onClick={() => void importConfig()}><FolderOpen size={16}/>{text('导入配置', 'Import configuration')}</button></div>{existingOpen && <><ModelInspectPanel key={runtime?.id ?? 'none'} language={language} desktop={desktop} installationId={runtime?.id} disabled={busy} onInspect={core.inspectModel} onChooseTarget={onChooseFile}/><div className="model-download-local-heading"><strong>{text('本地模型配置', 'Local model configurations')}</strong><button type="button" disabled={!desktop || !runtime?.installDir || localModels.isFetching} onClick={() => void localModels.refetch()}><RefreshCw size={14}/>{text('重新扫描', 'Rescan')}</button></div>{localModels.isError ? <p role="alert" className="model-download-error">{core.normalizeError(localModels.error).message}</p> : localModels.isPending && runtime ? <p>{text('正在读取…', 'Loading…')}</p> : localModels.data?.length ? <ul className="model-download-local-list">{localModels.data.map(model => <li key={model.configPath}><div><strong>{model.name}</strong><code>{model.configPath}</code></div><button type="button" disabled={busy} onClick={() => void onImportConfig(model.configPath, runtime)}>{text('导入配置', 'Import configuration')}</button></li>)}</ul> : <p>{text('所选运行环境没有可识别的本地模型配置。', 'No local model configurations were found in this runtime.')}</p>}</>}</details>
    {settingsOpen && <ModelDownloadSettingsDialog value={runtimeOverride ? { ...saved, runtime: runtimeOverride } : saved} runtimes={runtimeChoices} effectiveRuntime={runtime} modelDirectory={modelDirectory} language={language} desktop={desktop} onChooseDirectory={onChooseDirectory} onSave={saveDefaults} onClose={() => setSettingsOpen(false)} onDirtyChange={onDirtyChange} onSaveDraftReady={onSaveDraftReady}/>}
  </section>;
}
