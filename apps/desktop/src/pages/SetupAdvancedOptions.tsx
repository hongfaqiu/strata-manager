import type { AppLanguage } from "@strata-manager/core";
import { useEffect, useState } from 'react';
import { CircleHelp, Copy } from 'lucide-react';
import { gpuRoles, normalizeOfficialSetupOptions, type OfficialSetupOptions } from '@strata-manager/core';
import { Dialog } from '../components';
import { Dropdown, Toggle } from '../OfficialControls';
import { GpuSelector, parseGpuSelection, type GpuOption } from './GpuSelector';
import './official-setup.css';
import './setup-tuning-interactions.css';
import './calibrate-entry.css';

export function SetupAdvancedOptions({ language, value, onChange, onValidityChange, disabled = false, embedded = false, availableGpus }: {
  language: AppLanguage; value: OfficialSetupOptions;
  onChange: (value: OfficialSetupOptions) => void;
  onValidityChange?: (valid: boolean) => void;
  disabled?: boolean;
  /** A shared settings dialog already provides the section heading. */
  embedded?: boolean;
  availableGpus?: GpuOption[];
}) {
  const zh = language === 'zh-CN';
  const [helpOpen, setHelpOpen] = useState(false);
  const [calibratePreview, setCalibratePreview] = useState(false);
  const [copied, setCopied] = useState(false);
  let error = '';
  try { normalizeOfficialSetupOptions(value); } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
  useEffect(() => { onValidityChange?.(!error); }, [error, onValidityChange]);
  const update = (patch: Partial<OfficialSetupOptions>) => onChange({ ...value, ...patch });
  const selected = parseGpuSelection(value.gpus).mode === 'ids' ? parseGpuSelection(value.gpus).ids : [];
  const mainOf = (roles?: string) => { const parsed = roles ? gpuRoles.parseRolesText(roles) : null; const main = parsed && Object.keys(parsed).find(key => parsed[Number(key)] === 'main'); return main ?? undefined; };
  /** The chosen cards as Helpers with `main` as Main; undefined (plain --gpu / --gpus) when no Main is picked or it is no longer chosen. */
  const rolesFor = (gpus: string, main?: string) => {
    const ids = parseGpuSelection(gpus).mode === 'ids' ? parseGpuSelection(gpus).ids : [];
    if (!main || ids.length < 2 || !ids.includes(Number(main))) return undefined;
    return gpuRoles.rolesText(Object.fromEntries(ids.map(id => [id, id === Number(main) ? 'main' : 'helper'])) as gpuRoles.Roles);
  };
  const customized = (value.source ?? 'official') !== 'official' || (value.backend ?? 'auto') !== 'auto' || !!value.gpus?.trim();
  const calibrateCommand = [
    zh ? '# 在已安装的 Strata 目录中执行（不会由本应用直接启动）' : '# Run inside your Strata install directory (this app does not execute it)',
    zh ? './setup.sh --calibrate' : './setup.sh --calibrate   # Linux/macOS',
    'SETUP.bat --calibrate   # Windows',
  ].join('\n');
  const copyCalibrate = async () => {
    try {
      await navigator.clipboard.writeText(calibrateCommand);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { /* Clipboard may be unavailable in locked-down contexts. */ }
  };
  return <><details className={`official-setup-options${embedded ? ' is-embedded' : ''}`} open={embedded || undefined} data-testid="setup-advanced-options">
    <summary>{zh ? '下载与显卡设置' : 'Download and GPU settings'} <span className="official-setup-summary-state">{error ? (zh ? '请检查' : 'Needs attention') : customized ? (zh ? '已自定义' : 'Customized') : (zh ? '默认' : 'Default')}</span></summary>
    <fieldset disabled={disabled}>
      <div className="official-setup-fields">
        <label><span>{zh ? '下载来源' : 'Download source'}</span><Dropdown ariaLabel={zh ? '下载来源' : 'Download source'} value={value.source ?? 'official'} onValueChange={source => update({ source: source as OfficialSetupOptions['source'] })} options={[{value:'official',label:zh?'Hugging Face 官方':'Hugging Face official'},{value:'mirror',label:zh?'Hugging Face 镜像':'Hugging Face mirror'},{value:'modelscope',label:zh?'ModelScope 魔搭':'ModelScope'}]}/></label>
        {value.source === 'mirror' && <label className="official-setup-wide"><span>{zh ? 'HF 镜像地址' : 'HF mirror URL'}</span><input type="url" aria-label={zh ? 'HF 镜像地址' : 'HF mirror URL'} placeholder="https://hf-mirror.com" value={value.hfEndpoint ?? ''} onChange={event => update({ hfEndpoint: event.target.value })}/></label>}
        <label><span>{zh ? '显卡类型' : 'GPU type'}</span><Dropdown ariaLabel={zh ? '显卡类型' : 'GPU type'} value={value.backend ?? 'auto'} onValueChange={backend => update({ backend: backend as OfficialSetupOptions['backend'] })} options={[{value:'auto',label:zh?'自动识别（推荐）':'Automatic (recommended)'},{value:'cuda',label:zh?'NVIDIA 显卡（CUDA）':'NVIDIA (CUDA)'},{value:'hip',label:zh?'AMD 显卡（HIP）':'AMD (HIP)'},{value:'sycl',label:zh?'Intel 显卡（SYCL）':'Intel (SYCL)'}]}/></label>
        <div className="official-setup-wide" data-testid="setup-gpu-selector">
          <span className="official-setup-field-label">{zh ? '使用哪些显卡' : 'GPUs to use'}</span>
          <GpuSelector language={language} value={value.gpus ?? ''} onChange={gpus => update({ gpus, gpuRoles: rolesFor(gpus, mainOf(value.gpuRoles)) })} availableGpus={availableGpus} disabled={disabled}/>
        </div>
        {selected.length > 1 && <label className="official-setup-wide"><span>{zh ? '主卡（Strata 0.2.2 起）' : 'Main card (Strata 0.2.2+)'}</span><Dropdown ariaLabel={zh ? '主卡' : 'Main card'} value={mainOf(value.gpuRoles) ?? ''} onValueChange={main => update({ gpuRoles: rolesFor(value.gpus ?? '', main) })} options={[{ value: '', label: zh ? '由安装器决定（按编号顺序，最后一张为主卡）' : 'Let setup decide (index order, last is Main)' }, ...selected.map(id => ({ value: String(id), label: `GPU ${id}${availableGpus?.find(gpu => gpu.id === id) ? ` · ${availableGpus.find(gpu => gpu.id === id)!.name}` : ''}` }))]}/><small className="official-setup-note">{zh ? '主卡运行每次回答的最后一段，其余所选显卡为辅助卡，未选的显卡关闭（写入 --gpu-roles）。需要 Strata 0.2.2 或更新的运行环境。' : 'Main runs the last stage of every answer; the other chosen cards are Helpers and the rest are Off (passed as --gpu-roles). Needs a Strata 0.2.2 or newer runtime.'}</small></label>}
      </div>
      {value.backend === 'hip' && <p className="official-setup-note">{zh ? 'Windows 上的 AMD 显卡仅支持单卡。' : 'AMD on Windows supports one GPU only.'}</p>}
      <section className="calibrate-entry" data-testid="calibrate-entry" aria-label={zh ? '一键校准入口' : 'One-click calibrate entry'}>
        <div className="calibrate-entry-heading">
          <div>
            <strong>{zh ? '官方校准（--calibrate）' : 'Official calibrate (--calibrate)'}</strong>
            <p>{zh ? '生成校准命令供本机终端执行；本应用不会启动真实校准或改写引擎。' : 'Prepare the calibrate command for a local terminal. This app does not run real calibration or change the engine.'}</p>
          </div>
          <Toggle ariaLabel={zh ? '显示校准命令' : 'Show calibrate command'} checked={calibratePreview} onCheckedChange={setCalibratePreview} disabled={disabled}/>
        </div>
        {calibratePreview && <>
          <pre className="calibrate-entry-command" tabIndex={0} aria-label={zh ? '校准命令' : 'Calibrate command'}>{calibrateCommand}</pre>
          <button type="button" className="calibrate-entry-copy" disabled={disabled} onClick={() => void copyCalibrate()}><Copy size={14}/>{copied ? (zh ? '已复制' : 'Copied') : (zh ? '复制命令' : 'Copy command')}</button>
        </>}
      </section>
    </fieldset>
    <div className="setup-tuning-toolbar"><button type="button" className="setup-tuning-help-button" aria-label={zh ? '下载与显卡设置帮助' : 'Download and GPU settings help'} data-tooltip={zh ? '帮助' : 'Help'} onClick={() => setHelpOpen(true)}><CircleHelp size={16}/></button></div>
  </details>{error && <p className="official-setup-error official-setup-wide" role="alert">{error}</p>}{helpOpen && <Dialog title={zh ? '下载与显卡设置帮助' : 'Download and GPU settings help'} onClose={() => setHelpOpen(false)}><div className="setup-tuning-help-content"><p>{zh ? '通常保留自动选择即可。指定显卡时勾选编号；全部显卡用于多卡推理，但资源预估会受限。' : 'Automatic selection works for most users. Choose GPU indices explicitly, or select all for multi-GPU inference (resource estimates are limited).'}</p><p>{zh ? '镜像需要填写 HTTPS 地址。魔搭下载仓库当前版本，安装时会校验文件。校准命令来自官方安装器，请在本机终端执行。' : 'Mirror URLs must use HTTPS. ModelScope downloads the current repository version; files are verified during installation. The calibrate command comes from the official installer—run it in a local terminal.'}</p></div></Dialog>}</>;
}
