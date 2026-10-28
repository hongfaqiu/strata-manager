// Models page: one community entry (built-in or discovered) — source, Mac availability, quantizations with the
// 估算 figures, risks, and the one-click download (pinned files + SHA-256, then setup --gguf-dir).
import { useState } from 'react';
import { ArrowLeft, Download } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { CommunityModel, PerformanceHardware, RuntimePackagePlatform, ServiceProfile, TaskStatus } from '@strata-manager/core';
import { Radio, Toggle } from '../OfficialControls';
import { catalogCopy } from '../catalog/catalogCopy';
import { basisText, BlockNote, CommunityBadge, CommunityDisk, CommunityRisks, CommunitySource, EstimateCell, MemoryNote, memoryLine } from '../catalog/catalogUi';

const CONTEXTS = [32768, 131072, 262144];

export interface CommunityModelDetailProps {
  model: CommunityModel;
  platform: RuntimePackagePlatform;
  hardware: PerformanceHardware;
  machineMemoryGB?: number;
  language: core.AppLanguage;
  desktop: boolean;
  runtime?: ServiceProfile;
  busy: boolean;
  options: core.OfficialSetupOptions;
  onBack: () => void;
  onOpenOrca: () => void;
  onCommunitySetup?: (profile: ServiceProfile, request: core.CommunitySetupRequest, context: number, images: boolean, options: core.OfficialSetupOptions) => Promise<TaskStatus | void | undefined>;
}

export function CommunityModelDetail({ model, platform, hardware, machineMemoryGB, language, desktop, runtime, busy, options, onBack, onOpenOrca, onCommunitySetup }: CommunityModelDetailProps) {
  const copy = catalogCopy(language);
  const zh = language === 'zh-CN' || language === 'zh-TW', text = (cn: string, en: string) => zh ? cn : en;
  const first = model.quants.find(item => core.communityQuantAvailability(model, item, platform).downloadable) ?? model.quants[0] ?? '';
  const [quant, setQuant] = useState(first);
  const [context, setContext] = useState(32768);
  const [images, setImages] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const chosen = model.quants.includes(quant) ? quant : first;
  const availability = core.communityQuantAvailability(model, chosen, platform);
  const entryBlock = core.communityAvailability(model, platform);
  const info = model.quantInfo[chosen];
  const estimate = core.estimatePerformance(model.family, chosen, hardware);
  const submit = async () => {
    if (!runtime || !onCommunitySetup || submitting) return;
    setSubmitting(true); setError('');
    try {
      const snapshot = core.snapshotModelDownloadRequest(runtime, { model: model.family, quant: chosen, context, images: images && model.images }, options);
      await onCommunitySetup(snapshot.profile, core.communitySetupRequest(model, chosen), snapshot.context, snapshot.images, snapshot.options);
    } catch (cause) { setError(core.normalizeError(cause).message); } finally { setSubmitting(false); }
  };
  return <div className="model-download-detail" data-testid="community-detail"><div className="model-download-detail-body">
    <button type="button" className="model-download-back" onClick={onBack}><ArrowLeft size={16}/>{text('返回模型列表', 'Back to models')}</button>
    <div className="model-download-detail-heading"><CommunityBadge model={model} copy={copy}/><h3 tabIndex={-1}>{model.name}</h3><CommunitySource model={model} copy={copy}/><p>{copy.communityIntro}</p></div>
    {!entryBlock.downloadable && (entryBlock.reason === 'orcaImport' ? <p className="cat-note">{copy.orcaImport}</p> : <BlockNote reason={entryBlock.reason as keyof typeof copy.block} source={model.macBlockSource} copy={copy}/>)}
    <fieldset className="model-download-variants cat-variants" disabled={submitting}><legend>{text('1. 选择量化版本', '1. Choose a quantization')}</legend>
      <div className="model-download-variant-head" aria-hidden="true"><span>{text('量化', 'Quantization')}</span><span>{text('下载大小', 'Download size')}</span><span>{text('内存', 'Memory')}</span><span>{copy.colSpeed}</span></div>
      {model.quants.map(variant => {
        const details = model.quantInfo[variant]!;
        const state = core.communityQuantAvailability(model, variant, platform);
        const row = core.estimatePerformance(model.family, variant, hardware);
        return <label key={variant} className={`model-download-variant${chosen === variant ? ' is-selected' : ''}${state.downloadable ? '' : ' is-blocked'}`} title={state.downloadable || state.reason === 'orcaImport' ? undefined : copy.block[state.reason as keyof typeof copy.block]}>
          <span><Radio name="community-quant" value={variant} checked={chosen === variant} onChange={() => setQuant(variant)}/><span>{variant}</span></span>
          <span>{details.downloadGB} GB</span>
          <span className="cat-variant-memory">{memoryLine(row, details.ramGB, machineMemoryGB, copy)}</span>
          <span><EstimateCell estimate={row} copy={copy}/></span>
        </label>;
      })}
    </fieldset>
    {entryBlock.downloadable && !availability.downloadable && availability.reason === 'macQuant' && <BlockNote reason="macQuant" copy={copy}/>}
    <MemoryNote estimate={estimate} memoryGB={machineMemoryGB} copy={copy}/>
    <p className="cat-note">{basisText(estimate, copy)}</p><p className="cat-note">{copy.estimateMethod}</p>
    {availability.downloadable && <div className="cat-preset">
      <div className="model-download-context-presets" role="group" aria-label={text('常用上下文', 'Common contexts')}>{CONTEXTS.map(value => <button key={value} type="button" className={context === value ? 'is-selected' : undefined} aria-pressed={context === value} onClick={() => setContext(value)}>{core.formatContextTokens(value, language)}</button>)}</div>
      {model.images && <label className="cat-images"><span>{text('图像支持', 'Images')}</span><Toggle ariaLabel={text('图像支持', 'Images')} checked={images} onCheckedChange={setImages}/></label>}
    </div>}
    {availability.downloadable && <CommunityDisk model={model} quant={chosen} copy={copy}/>}
    <CommunityRisks model={model} copy={copy}/>
    {model.kind === 'control-vector' && <p className="cat-note">{copy.controlVectorNote}</p>}
    {model.images && availability.downloadable && <p className="cat-note">{copy.projectorNote}</p>}
  </div><footer className="model-download-submit"><div><span>{text('已选择', 'Selected')}: <strong>{chosen} · {core.formatContextTokens(context, language)}</strong></span>
    {entryBlock.reason === 'orcaImport' && platform !== 'macos'
      ? <button type="button" className="primary" onClick={onOpenOrca}>{copy.orcaOpen}</button>
      : !availability.downloadable
        ? <button type="button" className="primary" disabled>{text('这台电脑上不可用', 'Not available on this computer')}</button>
        : <button type="button" className="primary" disabled={!desktop || !runtime?.installDir || busy || submitting || !onCommunitySetup} onClick={() => void submit()}><Download size={18}/>{copy.downloadCommunity(info?.downloadGB ?? '—')}</button>}
    </div>{error && <p role="alert" className="model-download-error">{error}</p>}{availability.downloadable && <p>{copy.pipelineNote}</p>}</footer></div>;
}
