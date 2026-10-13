import type { AppLanguage } from "@strata-manager/core";
import { useEffect, useState } from 'react';
import { CircleHelp } from 'lucide-react';
import { normalizeOfficialSetupOptions, type OfficialSetupOptions } from '@strata-manager/core';
import { Dialog } from '../components';
import { Dropdown } from '../OfficialControls';
import './official-setup.css';
import './setup-tuning-interactions.css';

export function SetupAdvancedOptions({ language, value, onChange, onValidityChange, disabled = false, embedded = false }: {
  language: AppLanguage; value: OfficialSetupOptions;
  onChange: (value: OfficialSetupOptions) => void;
  onValidityChange?: (valid: boolean) => void;
  disabled?: boolean;
  /** A shared settings dialog already provides the section heading. */
  embedded?: boolean;
}) {
  const zh = language === 'zh-CN';
  const [helpOpen, setHelpOpen] = useState(false);
  let error = '';
  try { normalizeOfficialSetupOptions(value); } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
  useEffect(() => { onValidityChange?.(!error); }, [error, onValidityChange]);
  const update = (patch: Partial<OfficialSetupOptions>) => onChange({ ...value, ...patch });
  const customized = (value.source ?? 'official') !== 'official' || (value.backend ?? 'auto') !== 'auto' || !!value.gpus?.trim();
  return <><details className={`official-setup-options${embedded ? ' is-embedded' : ''}`} open={embedded || undefined} data-testid="setup-advanced-options">
    <summary>{zh ? '下载与显卡设置' : 'Download and GPU settings'} <span className="official-setup-summary-state">{error ? (zh ? '请检查' : 'Needs attention') : customized ? (zh ? '已自定义' : 'Customized') : (zh ? '默认' : 'Default')}</span></summary>
    <fieldset disabled={disabled}>
      <div className="official-setup-fields">
        <label><span>{zh ? '下载来源' : 'Download source'}</span><Dropdown ariaLabel={zh ? '下载来源' : 'Download source'} value={value.source ?? 'official'} onValueChange={source => update({ source: source as OfficialSetupOptions['source'] })} options={[{value:'official',label:zh?'Hugging Face 官方':'Hugging Face official'},{value:'mirror',label:zh?'Hugging Face 镜像':'Hugging Face mirror'},{value:'modelscope',label:zh?'ModelScope 魔搭':'ModelScope'}]}/></label>
        {value.source === 'mirror' && <label className="official-setup-wide"><span>{zh ? 'HF 镜像地址' : 'HF mirror URL'}</span><input type="url" aria-label={zh ? 'HF 镜像地址' : 'HF mirror URL'} placeholder="https://hf-mirror.com" value={value.hfEndpoint ?? ''} onChange={event => update({ hfEndpoint: event.target.value })}/></label>}
        <label><span>{zh ? '显卡类型' : 'GPU type'}</span><Dropdown ariaLabel={zh ? '显卡类型' : 'GPU type'} value={value.backend ?? 'auto'} onValueChange={backend => update({ backend: backend as OfficialSetupOptions['backend'] })} options={[{value:'auto',label:zh?'自动识别（推荐）':'Automatic (recommended)'},{value:'cuda',label:zh?'NVIDIA 显卡（CUDA）':'NVIDIA (CUDA)'},{value:'hip',label:zh?'AMD 显卡（HIP）':'AMD (HIP)'},{value:'sycl',label:zh?'Intel 显卡（SYCL）':'Intel (SYCL)'}]}/></label>
        <label><span>{zh ? '使用哪些显卡' : 'GPUs to use'}</span><input aria-label={zh ? '使用哪些显卡' : 'GPUs to use'} placeholder={zh ? '留空自动选择' : 'Leave blank for automatic selection'} value={value.gpus ?? ''} onChange={event => update({ gpus: event.target.value })}/></label>
      </div>
      {value.backend === 'hip' && <p className="official-setup-note">{zh ? 'Windows 上的 AMD 显卡仅支持单卡。' : 'AMD on Windows supports one GPU only.'}</p>}
    </fieldset>
    <div className="setup-tuning-toolbar"><button type="button" className="setup-tuning-help-button" aria-label={zh ? '下载与显卡设置帮助' : 'Download and GPU settings help'} data-tooltip={zh ? '帮助' : 'Help'} onClick={() => setHelpOpen(true)}><CircleHelp size={16}/></button></div>
  </details>{error && <p className="official-setup-error official-setup-wide" role="alert">{error}</p>}{helpOpen && <Dialog title={zh ? '下载与显卡设置帮助' : 'Download and GPU settings help'} onClose={() => setHelpOpen(false)}><div className="setup-tuning-help-content"><p>{zh ? '通常保留自动选择即可。指定显卡时，填写编号，例如 0 或 0,1；all 表示全部显卡。' : 'Automatic selection works for most users. To choose GPUs, enter indices such as 0 or 0,1; all selects every GPU.'}</p><p>{zh ? '镜像需要填写 HTTPS 地址。魔搭下载仓库当前版本，安装时会校验文件。' : 'Mirror URLs must use HTTPS. ModelScope downloads the current repository version; files are verified during installation.'}</p></div></Dialog>}</>;
}
