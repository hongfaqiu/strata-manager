import type { AppLanguage } from "@strata-manager/core";
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, FolderOpen, ImageOff, Laptop, LoaderCircle, RefreshCw } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { JsonObject, ServiceProfile } from '@strata-manager/core';
import { Dialog } from '../components';
import { Dropdown } from '../OfficialControls';
import { configureVisionSupport, visionDraftOf, type VisionSupportDraft } from './visionSupportConfiguration';
import { macVisionText, shortMacVersion } from './macVisionStrings';
import './vision-support-dialog.css';

export interface VisionSupportDialogProps {
  profile: ServiceProfile; language: AppLanguage; onClose: () => void;
  onSaved?: () => Promise<void> | void; onRestart?: () => Promise<void>;
}

export function VisionSupportDialog({ profile, language, onClose, onSaved, onRestart }: VisionSupportDialogProps) {
  const zh = language === 'zh-CN';
  const [baseline, setBaseline] = useState<{ config: JsonObject; revision: string; profileId: string; configPath: string } | null>(null);
  const [draft, setDraft] = useState<VisionSupportDraft | null>(null);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [browsing, setBrowsing] = useState(false);
  const [reload, setReload] = useState(0), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [mac, setMac] = useState<core.MacVisionSupport | null>(null);
  const current = useRef({ profile, onRestart, onSaved }); current.current = { profile, onRestart, onSaved };
  const savingRef = useRef(false), browsingRef = useRef(false), alive = useRef(false);
  const busy = loading || saving || browsing;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // macOS only: the vision engine's minimum macOS against this Mac (null elsewhere or when it can't be read).
  const visionExe = draft?.exe.trim() ?? '';
  useEffect(() => {
    let stopped = false;
    setMac(null);
    if (!baseline || !visionExe) return;
    void core.macVisionSupport(profile, { ...baseline.config, vision: { exe: visionExe } })
      .then(result => { if (!stopped) setMac(result ?? null); }).catch(() => { if (!stopped) setMac(null); });
    return () => { stopped = true; };
  }, [baseline, visionExe, profile.id, profile.configPath]);
  const macBlocked = mac?.supported === false;
  useEffect(() => {
    let stopped = false;
    setLoading(true); setBaseline(null); setDraft(null); setError(''); setMessage(''); setEnabled(false);
    void core.readConfigSnapshot(profile).then(({ config, revision }) => {
      const next = visionDraftOf(config, profile.installDir);
      if (!stopped) { setBaseline({ config, revision, profileId: profile.id, configPath: profile.configPath }); setDraft(next); }
    }).catch(failure => { if (!stopped) setError(core.normalizeError(failure).message); }).finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [profile.id, profile.configPath, reload]);
  const changedProfile = (target: typeof baseline) => !target || current.current.profile.id !== target.profileId || current.current.profile.configPath !== target.configPath;
  const close = () => { if (!busy && !savingRef.current && !browsingRef.current) onClose(); };
  const edit = <Key extends keyof VisionSupportDraft>(key: Key, value: VisionSupportDraft[Key]) => { setDraft(previous => previous ? { ...previous, [key]: value } : previous); setMessage(''); setError(''); setEnabled(false); };
  const browse = async (key: 'exe' | 'model' | 'mmproj') => {
    if (busy || browsingRef.current || !draft) return;
    browsingRef.current = true; setBrowsing(true); setError('');
    const target = baseline;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ title: zh ? '选择图像服务文件' : 'Choose a vision service file', multiple: false, directory: false, defaultPath: draft[key] || undefined, filters: key === 'exe' ? undefined : [{ name: 'GGUF', extensions: ['gguf'] }] });
      if (alive.current && !changedProfile(target) && typeof selected === 'string') edit(key, selected);
    } catch (failure) { if (alive.current) setError(core.normalizeError(failure).message); }
    finally { browsingRef.current = false; if (alive.current) setBrowsing(false); }
  };
  const save = async (restart: boolean) => {
    if (busy || savingRef.current || !baseline || !draft || macBlocked) return;
    const target = baseline, selectedProfile = profile;
    let persisted = false;
    savingRef.current = true; setSaving(true); setError(''); setMessage('');
    try {
      if (changedProfile(target)) throw new Error(zh ? '当前服务配置已改变，请重新读取。' : 'The selected configuration changed. Reload it.');
      if (restart && !current.current.onRestart) throw new Error(zh ? '当前服务无法重启，请仅保存配置。' : 'Restart is unavailable. Save the configuration only.');
      const next = configureVisionSupport(target.config, draft);
      core.validateStartupConfiguration(next);
      await core.validateVisionFiles(selectedProfile, next);
      if (changedProfile(target)) throw new Error(zh ? '当前服务配置已改变，请重新读取。' : 'The selected configuration changed. Reload it.');
      const written = await core.writeConfig(selectedProfile, next, target.revision); persisted = true;
      if (!alive.current) return;
      setBaseline({ config: next, revision: written.revision, profileId: target.profileId, configPath: target.configPath });
      setMessage(zh ? '图像配置已保存并备份，重启服务后生效。' : 'Vision configuration saved with a backup. Restart the service to apply it.');
      if (restart) {
        if (changedProfile(target) || !current.current.onRestart) throw new Error(zh ? '服务状态已改变，请检查后重启。' : 'The service state changed. Check it before restarting.');
        setMessage(zh ? '配置已保存，正在启用图像服务…' : 'Configuration saved; enabling vision…');
        await current.current.onRestart();
        const health = await core.request<JsonObject>(selectedProfile, '/health');
        if (health.images !== true) throw new Error(zh ? '服务未确认图像支持，请检查视觉引擎和投影文件。' : 'The service did not confirm image support. Check the vision engine and projector.');
        if (alive.current) { setEnabled(true); setMessage(zh ? '图像服务已启用。' : 'Image support is enabled.'); }
      }
      await current.current.onSaved?.();
    } catch (failure) {
      if (alive.current) {
        if (persisted) setMessage(zh ? '图像配置已保存；请检查后重启服务。' : 'Vision configuration is saved. Check it and restart the service.');
        setError(`${persisted ? (zh ? '配置已保存，但后续操作失败：' : 'Configuration saved, but the next step failed: ') : ''}${core.normalizeError(failure).message}`);
      }
    } finally { savingRef.current = false; if (alive.current) setSaving(false); }
  };
  const labels = { exe: zh ? '视觉引擎' : 'Vision engine', model: zh ? '模型 GGUF' : 'Model GGUF', mmproj: zh ? '图像投影文件' : 'Image projector' };
  const complete = !!draft && [draft.exe, draft.model, draft.mmproj].every(path => path.trim()) && Number.isSafeInteger(Number(draft.threads)) && Number(draft.threads) > 0 && Number.isSafeInteger(Number(draft.maxTokens)) && Number(draft.maxTokens) > 0;
  return <Dialog title={zh ? '启用图像支持' : 'Enable image support'} onClose={close}>
    <div className="vision-support-dialog">
      {loading && <p className="vision-support-status" role="status"><LoaderCircle size={17} className="spin"/>{zh ? '正在读取现有配置…' : 'Reading the existing configuration…'}</p>}
      {macBlocked && mac && <div className="vision-support-mac" role="alert">
        <ImageOff size={22} aria-hidden="true"/>
        <div>
          <strong>{macVisionText(language, 'mvTitle', shortMacVersion(mac.required))}</strong>
          <span className="vision-support-mac-versions">
            <span className="is-current"><Laptop size={13} aria-hidden="true"/>{macVisionText(language, 'mvThisMac')} {mac.system}</span>
            <ArrowRight size={13} aria-hidden="true"/>
            <span>{macVisionText(language, 'mvNeeded')} {shortMacVersion(mac.required)}+</span>
          </span>
          <small>{macVisionText(language, 'mvBody')}</small>
        </div>
      </div>}
      {draft && <>
        <p className="vision-support-intro">{zh ? '选择已有的视觉引擎、模型和匹配投影文件。' : 'Choose an existing vision engine, model and matching projector.'}</p>
        <div className="vision-support-paths">{(['exe', 'model', 'mmproj'] as const).map(key => <label key={key}><span>{labels[key]}</span><div><input value={draft[key]} aria-label={labels[key]} disabled={busy} onChange={event => edit(key, event.target.value)} placeholder={key === 'mmproj' ? (zh ? '选择匹配模型的 mmproj GGUF' : 'Choose the matching mmproj GGUF') : ''}/><button type="button" disabled={busy} aria-label={`${zh ? '选择' : 'Choose'} ${labels[key]}`} onClick={() => void browse(key)}><FolderOpen size={16}/></button></div></label>)}</div>
        <p className="vision-support-settings">{draft.gpu ? 'GPU' : 'CPU'} · {draft.threads} {zh ? '线程' : 'threads'} · {zh ? '图片上限' : 'Image limit'} {draft.maxTokens} tokens</p>
        <details className="vision-support-options"><summary>{zh ? '编码设置' : 'Encoder settings'}</summary><div>
          <label><span>{zh ? '编码设备' : 'Encoder device'}</span><Dropdown ariaLabel={zh ? '编码设备' : 'Encoder device'} value={draft.gpu ? 'gpu' : 'cpu'} disabled={busy} onValueChange={value => edit('gpu', value === 'gpu')} options={[{ value: 'cpu', label: 'CPU' }, { value: 'gpu', label: 'GPU' }]}/></label>
          <label><span>{zh ? 'CPU 线程' : 'CPU threads'}</span><input type="number" min={1} max={65535} value={draft.threads} disabled={busy} onChange={event => edit('threads', event.target.value)}/></label>
          <label><span>{zh ? '图片 Token 上限' : 'Image token limit'}</span><input type="number" min={1} max={2147483647} value={draft.maxTokens} disabled={busy} onChange={event => edit('maxTokens', event.target.value)}/></label>
        </div></details>
      </>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {message && <p className={`notice ${enabled ? 'vision-support-enabled' : ''}`} role="status">{enabled && <Check size={16}/>} {message}</p>}
      <div className="dialog-footer">
        <button type="button" disabled={busy} onClick={close}>{zh ? '关闭' : 'Close'}</button>
        {error && <button type="button" disabled={busy} onClick={() => setReload(value => value + 1)}><RefreshCw size={15}/>{draft ? (zh ? '放弃草稿并重新读取' : 'Discard draft and reload') : (zh ? '重新读取' : 'Reload')}</button>}
        <button type="button" className="primary" disabled={busy || !complete || enabled || macBlocked} onClick={() => void save(!!onRestart)}>{saving ? <LoaderCircle size={15} className="spin"/> : <Check size={15}/>} {saving ? (zh ? '正在保存…' : 'Saving…') : onRestart ? (zh ? '保存并启用' : 'Save and enable') : (zh ? '保存图像配置' : 'Save vision configuration')}</button>
      </div>
    </div>
  </Dialog>;
}
