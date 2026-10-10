import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as core from '@strata-manager/core';
import type { JsonObject, ServiceProfile, StartupTuning } from '@strata-manager/core';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Dialog } from '../components';
import { Dropdown, NumberField } from '../OfficialControls';
import './startup-tuning.css';

interface Props {
  profile?: ServiceProfile; desktop: boolean; language: 'zh-CN' | 'en';
  onError: (error: unknown) => void; onMessage?: (message: string) => void;
}
export function StartupTuningPanel({ profile, desktop, language, onError, onMessage }: Props) {
  const zh = language === 'zh-CN';
  const client = useQueryClient();
  const [values, setValues] = useState<StartupTuning>({ context: '', kv: '', threads: '' });
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<JsonObject | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const [raw, setRaw] = useState('');
  const [draftConfig, setDraftConfig] = useState<JsonObject>();
  const config = useQuery({ queryKey: ['startup-config', profile?.id, profile?.configPath], queryFn: () => core.readConfig(profile!), enabled: desktop && !!profile?.configPath, retry: false, refetchOnWindowFocus: false });
  const reset = (data: JsonObject) => {
    setDraftConfig(data); setRaw(JSON.stringify(data, null, 2)); setError(''); setMessage('');
    try { setValues(core.startupTuningOf(data)); } catch (e) { setError(core.normalizeError(e).message); }
  };
  useEffect(() => {
    if (config.data) reset(config.data);
  }, [config.data]);
  const draft = draftConfig ?? config.data;
  const loaded = draft ? (() => { try { return core.startupTuningOf(draft); } catch { return undefined; } })() : undefined;
  const changed = !!config.data && (rawOpen ? raw !== JSON.stringify(config.data, null, 2) : !!loaded && (JSON.stringify(values) !== JSON.stringify(loaded) || JSON.stringify(draft) !== JSON.stringify(config.data)));
  const disabled = saving || config.isFetching || rawOpen || !loaded;
  const update = (key: keyof StartupTuning, value: string) => { setValues(old => ({ ...old, [key]: value })); setMessage(''); setError(''); };
  const parseRaw = () => {
    let data: unknown;
    try { data = JSON.parse(raw); } catch (e) { throw new Error(`${zh ? 'JSON 语法错误' : 'Invalid JSON syntax'}: ${core.normalizeError(e).message}`); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(zh ? '完整配置必须为 JSON 对象，不能是数组、空值或其它类型。' : 'The full configuration must be a JSON object, not an array, null or another value.');
    return data as JsonObject;
  };
  const toggleRaw = () => {
    if (!draft || saving || config.isFetching) return;
    try {
      if (rawOpen) {
        const data = parseRaw();
        const tuning = core.startupTuningOf(data);
        setDraftConfig(data); setValues(tuning); setRawOpen(false);
      } else {
        const data = loaded ? core.applyStartupTuning(draft, values) : draft;
        setRaw(JSON.stringify(data, null, 2)); setRawOpen(true);
      }
      setError(''); setMessage('');
    } catch (e) { setError(core.normalizeError(e).message); }
  };
  const prepareSave = () => {
    if (!draft) return;
    try { const next = rawOpen ? parseRaw() : core.applyStartupTuning(draft, values); setError(''); setConfirm(next); }
    catch (e) { setError(core.normalizeError(e).message); }
  };
  const save = async () => {
    if (!profile || !config.data || !confirm || saving) return;
    setSaving(true); setError('');
    try {
      const current = await core.readConfig(profile);
      if (JSON.stringify(current) !== JSON.stringify(config.data)) throw new Error(zh ? '配置已被其他操作修改。请重新读取后再编辑，避免覆盖新设置。' : 'The file changed since it was loaded. Reload before editing to preserve the newer settings.');
      await core.writeConfig(profile, confirm);
      const text = rawOpen ? (zh ? '完整配置已保存，原配置已备份。重启服务后生效。' : 'Full configuration saved and the previous file backed up. Restart the service to apply it.') : (zh ? '启动参数已保存，原配置已备份。重启服务后生效。' : 'Startup parameters saved and the previous file backed up. Restart the service to apply them.');
      setMessage(text); onMessage?.(text); setConfirm(null);
      const refreshed = await config.refetch();
      if (refreshed.data) reset(refreshed.data);
      await client.invalidateQueries({ queryKey: ['official-config', profile.id] });
      setMessage(text);
    } catch (e) { setConfirm(null); setError(core.normalizeError(e).message); onError(e); }
    finally { setSaving(false); }
  };
  const title = zh ? '模型启动参数' : 'Model startup parameters';
  return <div className="st-card startup-tuning" aria-label={title}><span className="card-title">{title}</span>
    <p className="muted small">{zh ? '保存到本地配置，重启服务后生效。修改上下文不会自动重新计算 RoPE、KV 驻留窗口或模型准备参数；需要重新生成完整配置时，请到模型页面准备模型。' : 'Saved to the local file and applied after a service restart. Context edits retain the installed RoPE, resident KV and setup options. Use model preparation to regenerate the complete configuration.'}</p>
    {!desktop ? <p className="muted">{zh ? '请在桌面应用中编辑本地启动参数。' : 'Open the desktop app to edit local startup parameters.'}</p> : !profile?.configPath ? <p className="muted">{zh ? '先在服务管理中导入模型配置，或为服务指定配置路径。' : 'Import a model config or set its path in Service management first.'}</p> : <>
      <code className="startup-tuning-path">{profile.configPath}</code>
      {(error || config.error) && <p role="alert" className="runtime-config-error">{error || core.normalizeError(config.error).message}</p>}
      {config.isPending && <p className="muted">{zh ? '读取配置中…' : 'Reading configuration…'}</p>}
      {!!loaded && <div className="startup-tuning-fields">
        <label className="st-field"><span className="st-label">{zh ? '上下文容量（token）' : 'Context capacity (tokens)'}</span><NumberField className="st-input" aria-label={zh ? '上下文容量' : 'Context capacity'} disabled={disabled} min={1} max={2147483647} step={1} value={values.context} placeholder="4096" onChange={e => update('context', e.target.value)}/><small>{zh ? '容量越大，所需内存和显存通常越多。留空采用引擎默认 4096。' : 'Larger capacity usually needs more RAM and VRAM. Empty uses the engine default of 4096.'}</small><button type="button" className="text-button" disabled={disabled || !values.context} onClick={() => update('context', '')}>{zh ? '使用引擎默认' : 'Use engine default'}</button></label>
        <div className="st-field"><span className="st-label">{zh ? 'KV 缓存精度' : 'KV cache precision'}</span><Dropdown ariaLabel={zh ? 'KV 缓存精度' : 'KV cache precision'} disabled={disabled} value={values.kv} onValueChange={value => update('kv', value)} options={[{ value: '', label: zh ? '引擎默认（fp16）' : 'Engine default (fp16)' }, ...['fp16','int8','q4_0','k8v4', ...(!['','fp16','int8','q4_0','k8v4'].includes(values.kv) ? [values.kv] : [])].map(value => ({ value, label: value }))]}/><small>{zh ? 'int8 和 q4_0 可减少 KV 占用；精度、速度与输出质量需要实际对比。' : 'int8 and q4_0 reduce KV memory. Compare speed and output quality with your model.'}</small></div>
        <label className="st-field"><span className="st-label">{zh ? 'CPU 线程数' : 'CPU threads'}</span><NumberField className="st-input" aria-label={zh ? 'CPU 线程数' : 'CPU threads'} disabled={disabled} min={1} max={65535} step={1} value={values.threads} placeholder={zh ? '自动' : 'Automatic'} onChange={e => update('threads', e.target.value)}/><small>{zh ? '留空由引擎选择；更多线程不一定更快。' : 'Empty lets the engine select its thread count. More threads may not be faster.'}</small><button type="button" className="text-button" disabled={disabled || !values.threads} onClick={() => update('threads', '')}>{zh ? '自动选择' : 'Use automatic selection'}</button></label>
      </div>}
      {!!config.data && <div className="startup-tuning-advanced"><button type="button" className="st-btn st-btn--secondary startup-tuning-toggle" aria-expanded={rawOpen} aria-controls="startup-full-config" disabled={saving || config.isFetching} onClick={toggleRaw}>{zh ? '完整配置（高级）' : 'Full configuration (advanced)'}{rawOpen ? <ChevronUp size={15}/> : <ChevronDown size={15}/>}</button>
        {rawOpen && <div id="startup-full-config"><p className="muted small">{zh ? '正在编辑全部本地 JSON，包括 MCP、网络及其它字段。上方结构化参数暂时禁用；收起时会保留这些改动并同步参数。保存会备份原文件，重启服务后生效。' : 'You are editing the entire local JSON, including MCP, network and other fields. Structured controls above are disabled. Closing this editor retains your changes and syncs the parameters. Saving backs up the previous file; restart the service to apply changes.'}</p><label className="st-label" htmlFor="startup-full-config-json">{zh ? '本地 JSON 配置' : 'Local JSON configuration'}</label><textarea className="startup-tuning-json st-input" id="startup-full-config-json" spellCheck={false} value={raw} disabled={saving || config.isFetching} onChange={event=>{setRaw(event.target.value);setError('');setMessage('');}}/></div>}
      </div>}
      <div className="cfg-actions"><button className="st-btn st-btn--primary" disabled={saving || config.isFetching || !config.data || !changed} onClick={prepareSave}>{rawOpen ? (zh ? '保存完整配置' : 'Save full configuration') : (zh ? '保存启动参数' : 'Save startup parameters')}</button><button className="st-btn st-btn--secondary" disabled={saving || config.isFetching} onClick={() => { setError(''); setMessage(''); void config.refetch().then(result => { if (result.data) reset(result.data); }); }}>{zh ? '重新读取' : 'Reload'}</button><span className="muted small" role="status">{message}</span></div>
    </>}
    {confirm && <Dialog title={rawOpen ? (zh ? '保存完整配置' : 'Save full configuration') : (zh ? '保存启动参数' : 'Save startup parameters')} onClose={() => { if (!saving) setConfirm(null); }}><p>{zh ? '将修改此服务的本地配置并备份原文件。当前服务继续使用已有设置，请在服务管理页重启后应用新参数。' : 'The local configuration will be updated with a backup. The running service keeps its current settings until you restart it in Service management.'}</p><div className="dialog-footer"><button disabled={saving} onClick={() => setConfirm(null)}>{zh ? '取消' : 'Cancel'}</button><button className="primary" disabled={saving} onClick={() => void save()}>{saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '确认保存' : 'Save changes')}</button></div></Dialog>}
  </div>;
}
