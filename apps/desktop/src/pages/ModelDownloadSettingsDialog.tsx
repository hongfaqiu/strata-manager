import { useEffect, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { ServiceProfile } from '@strata-manager/core';
import { Dialog, Field } from '../components';
import { Dropdown } from '../OfficialControls';
import { useDraftGuard, type SaveDraft } from '../useDraftGuard';
import { SetupAdvancedOptions } from './SetupAdvancedOptions';

export interface ModelDownloadSettingsDialogProps {
  value: core.ModelDownloadDefaults;
  runtimes: ServiceProfile[];
  modelDirectory?: string;
  effectiveRuntime?: ServiceProfile;
  language: 'zh-CN' | 'en';
  desktop: boolean;
  onChooseDirectory: () => Promise<string | null>;
  onSave: (value: core.ModelDownloadDefaults) => Promise<void>;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveDraftReady?: (save: SaveDraft | undefined) => void;
}

export function ModelDownloadSettingsDialog({ value, runtimes, modelDirectory, effectiveRuntime, language, desktop, onChooseDirectory, onSave, onClose, onDirtyChange, onSaveDraftReady }: ModelDownloadSettingsDialogProps) {
  const zh = language === 'zh-CN', text = (cn: string, en: string) => zh ? cn : en;
  const [initial] = useState(() => core.normalizeModelDownloadDefaults(value));
  const [draft, setDraft] = useState(() => core.normalizeModelDownloadDefaults(value));
  const [valid, setValid] = useState(true);
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState('');
  const saveLock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dirty = JSON.stringify(initial) !== JSON.stringify(draft);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  const choices = runtimes.filter(runtime => runtime.managed && runtime.installDir);
  if (draft.runtime && !choices.some(runtime => runtime.id === draft.runtime?.id)) choices.push(draft.runtime);
  const save = async (): Promise<boolean> => {
    if (saveLock.current || choosing || !valid || !desktop) return false;
    saveLock.current = true; setSaving(true); setError('');
    try {
      const next = core.normalizeModelDownloadDefaults(draft);
      await onSave(next);
      return true;
    } catch (cause) { if (mounted.current) setError(core.normalizeError(cause).message); return false; }
    finally { saveLock.current = false; if (mounted.current) setSaving(false); }
  };
  const saveRef = useRef(save); saveRef.current = save;
  useEffect(() => { onSaveDraftReady?.(() => saveRef.current()); return () => onSaveDraftReady?.(undefined); }, [onSaveDraftReady]);
  const closeGuard = useDraftGuard(dirty, () => saveRef.current(), language);
  const close = () => { if (!saveLock.current && !choosing) closeGuard.request(onClose); };
  const chooseDirectory = async () => {
    if (choosing || saveLock.current) return;
    setChoosing(true); setError('');
    try {
      const directory = await onChooseDirectory();
      if (directory && mounted.current) {
        const status = await core.localRuntimeInstallation();
        const known = [...choices, ...(status.result ? [status.result.profile] : []), ...(status.detectedRuntimes ?? []).filter(item => item.readiness === 'ready').map(item => item.profile)];
        const runtime = known.find(item => core.configurationPathKey(item.installDir) === core.configurationPathKey(directory));
        if (!runtime) throw new Error(text('此目录尚未识别为就绪的 Strata 运行环境，请先在 Strata 页面检测或准备。', 'This folder is not a recognized ready Strata runtime. Detect or prepare it on the Strata page first.'));
        if (mounted.current) setDraft(current => ({ ...current, runtime: { ...runtime } }));
      }
    } catch (cause) { if (mounted.current) setError(core.normalizeError(cause).message); }
    finally { if (mounted.current) setChoosing(false); }
  };
  return <><Dialog title={text('模型下载配置', 'Model download settings')} wide onClose={close}>
    <form className="model-download-settings" onSubmit={event => { event.preventDefault(); void save(); }}>
      <p className="model-download-settings-intro">{text('所有模型共用的下载与显卡默认设置。保存后用于新建下载任务。', 'Shared download and GPU defaults for all models. Changes apply to new download tasks.')}</p>
      <section className="model-download-settings-section">
        <h3>{text('运行环境与存储位置', 'Runtime and storage')}</h3>
        <div className="model-download-runtime-field"><Field label={text('默认运行环境', 'Default runtime')}>
          <Dropdown ariaLabel={text('默认运行环境', 'Default runtime')} value={draft.runtime?.id ?? ''} disabled={saving || choosing || !desktop}
            options={[{ value: '', label: text('使用当前所选环境', 'Use the selected runtime') }, ...choices.map(runtime => ({ value: runtime.id, label: `${runtime.name} · ${runtime.installDir}` }))]}
            onValueChange={id => setDraft(current => ({ ...current, runtime: choices.find(runtime => runtime.id === id) ?? null }))}/>
        </Field><button type="button" disabled={saving || choosing || !desktop} onClick={() => void chooseDirectory()}><FolderOpen size={16}/>{choosing ? text('选择中…', 'Choosing…') : text('选择其他目录', 'Choose another folder')}</button></div>
        <div className="model-download-directory"><span>{text('模型数据目录', 'Model data directory')}</span><code>{(draft.runtime ?? effectiveRuntime)?.installDir === effectiveRuntime?.installDir && modelDirectory ? modelDirectory : text('保存后根据所选环境检查', 'Checked after saving the selected runtime')}</code></div>
        <p className="model-download-settings-hint">{text('模型位置由所选 Strata 运行环境决定；已有模型文件保留在原位置。', 'The selected Strata runtime determines model storage. Existing model files stay at their current locations.')}</p>
      </section>
      <section className="model-download-settings-section"><h3>{text('下载与显卡', 'Downloads and GPU')}</h3><SetupAdvancedOptions language={language} value={draft.options} onChange={options => setDraft(current => ({ ...current, options }))} onValidityChange={setValid} disabled={saving || choosing || !desktop} embedded/></section>
      {error && <p className="model-download-error" role="alert">{error}</p>}
      <div className="model-download-settings-footer"><span>{text('已提交的任务保留提交时的设置。', 'Submitted tasks keep their original settings.')}</span><div><button type="button" disabled={saving || choosing} onClick={close}>{text('取消', 'Cancel')}</button><button className="primary" type="submit" disabled={saving || choosing || !valid || !desktop}>{saving ? text('保存中…', 'Saving…') : text('保存配置', 'Save settings')}</button></div></div>
    </form>
  </Dialog>{closeGuard.dialog}</>;
}
