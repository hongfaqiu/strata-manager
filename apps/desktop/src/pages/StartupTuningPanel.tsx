import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as core from '@strata-manager/core';
import type { JsonObject, ServiceProfile, StartupFieldGroup, StartupFieldSpec } from '@strata-manager/core';
import { CircleHelp, Copy, Plus, Search, Trash2 } from 'lucide-react';
import { Dialog } from '../components';
import { Dropdown, Segmented } from '../OfficialControls';
import { ConfigurationNode } from './StartupConfigurationNode';
import { StartupNetworkPowerSettings } from './StartupNetworkPowerSettings';
import './startup-tuning.css';
import './setup-tuning-interactions.css';
import { useDraftGuard, type SaveDraft } from '../useDraftGuard';

interface Props {
  profile?: ServiceProfile; desktop: boolean; language: 'zh-CN' | 'en';
  onError: (error: unknown) => void; onMessage?: (message: string) => void;
  /** Only supplied when this exact configuration can be restarted. */
  onRestart?: () => Promise<unknown>;
  onCopied?: (profile: ServiceProfile) => void | Promise<void>;
  onDeleted?: (profile: ServiceProfile) => void | Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveDraftReady?: (save: SaveDraft | undefined) => void;
}
type SettingsCategory = StartupFieldGroup | 'context-extension';
const basicContextFields = new Set(['--max-context', '--kv', '--kv-grow']);
const groups: [SettingsCategory, string, string][] = [
  ['context', '对话容量', 'Conversation capacity'], ['context-extension', '上下文扩展（进阶）', 'Context extensions (advanced)'], ['cpu', '处理器', 'CPU'],
  ['memory', '内存与显卡', 'Memory and GPUs'], ['cache', '对话缓存', 'Conversation cache'],
  ['prefill', '输入处理', 'Input processing'], ['speculation', '生成加速', 'Generation acceleration'],
  ['ple', 'PLE 表读取', 'PLE table I/O'], ['model', '模型文件与专家配置', 'Model files and expert profiles'],
  ['server', 'API 服务与加载策略', 'API service and loading'], ['vision', '视觉编码', 'Vision encoder'],
  ['sampling', '默认采样', 'Default sampling'], ['paths', '路径与 GPU 分配', 'Paths and GPU allocation'],
];

export function StartupTuningPanel({ profile, desktop, language, onError, onMessage, onRestart, onCopied, onDeleted, onDirtyChange, onSaveDraftReady }: Props) {
  const zh = language === 'zh-CN'; const client = useQueryClient();
  const [draftConfig, setDraftConfig] = useState<JsonObject>();
  const [fieldEdits, setFieldEdits] = useState<Record<string, string>>({});
  const [treeIssues, setTreeIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<{ config: JsonObject; restart: boolean; profileId: string; configPath: string; expectedRevision: string } | null>(null);
  const [fileAction,setFileAction] = useState<{kind:'copy';config:JsonObject;profile:ServiceProfile}|{kind:'delete';profile:ServiceProfile}|null>(null);
  const [copyName,setCopyName] = useState('');
  const fileOperation = useRef(false);
  const restartTarget = useRef({ profileId: profile?.id, configPath: profile?.configPath, onRestart });
  restartTarget.current = { profileId: profile?.id, configPath: profile?.configPath, onRestart };
  const [view, setView] = useState('graph'); const [raw, setRaw] = useState(''); const [search, setSearch] = useState('');
  const [showParameterNames, setShowParameterNames] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<SettingsCategory>('context');
  const [helpOpen, setHelpOpen] = useState(false);
  const [newFlag, setNewFlag] = useState(''); const [newOperands, setNewOperands] = useState<string[]>([]);
  const [customArity, setCustomArity] = useState(1);
  const config = useQuery({ queryKey: ['startup-config', profile?.id, profile?.configPath], queryFn: () => core.readConfigSnapshot(profile!), enabled: desktop && !!profile?.configPath, retry: false, refetchOnWindowFocus: false });
  const baseline = useRef<core.ConfigSnapshot | undefined>(undefined);
  const dirtyRef = useRef(false);
  const reset = (data: core.ConfigSnapshot) => { baseline.current = structuredClone(data); dirtyRef.current = false; setDraftConfig(structuredClone(data.config)); setFieldEdits({}); setTreeIssues({}); setRaw(JSON.stringify(data.config, null, 2)); setError(''); setMessage(''); };
  useEffect(() => { if (config.data && !dirtyRef.current) reset(config.data); }, [config.data]);
  const draft = draftConfig ?? config.data?.config;
  const materialize = (checkTree = true) => {
    if (!draft) throw new Error(zh ? '配置尚未读取' : 'Configuration not loaded');
    const issue = Object.values(treeIssues).find(Boolean); if (checkTree && issue) throw new Error(issue);
    let next = structuredClone(draft);
    for (const field of core.STARTUP_TUNING_FIELDS) if (Object.hasOwn(fieldEdits, field.key)) next = core.applyStartupField(next, field, fieldEdits[field.key]!);
    return next;
  };
  const changed = (() => {
    if (!baseline.current) return false;
    try { return JSON.stringify(view === 'json' ? core.parseStartupConfiguration(raw) : materialize()) !== JSON.stringify(baseline.current.config); }
    catch { return true; }
  })();
  dirtyRef.current = changed;
  useEffect(() => { onDirtyChange?.(changed); return () => onDirtyChange?.(false); }, [changed, onDirtyChange]);
  const disabled = saving || config.isFetching || !draft;
  const mutate = (operation: (data: JsonObject) => JsonObject, ignoreTreeIssues = false) => {
    try { const next = operation(materialize(!ignoreTreeIssues)); setDraftConfig(next); setFieldEdits({}); setError(''); setMessage(''); }
    catch (failure) { setError(core.normalizeError(failure).message); }
  };
  const selectView = (next: string) => {
    if (view === next || disabled) return;
    try {
      if (next === 'json') { const data = materialize(); setDraftConfig(data); setFieldEdits({}); setRaw(JSON.stringify(data, null, 2)); }
      else { const data = core.parseStartupConfiguration(raw); setDraftConfig(data); setFieldEdits({}); setTreeIssues({}); }
      setView(next); setError(''); setMessage('');
    } catch (failure) { setError(core.normalizeError(failure).message); }
  };
  const prepareSave = (restart: boolean) => {
    try {
      if (!profile?.configPath || !config.data) throw new Error(zh ? '配置尚未读取' : 'Configuration not loaded');
      const next = view === 'json' ? core.parseStartupConfiguration(raw) : materialize(); core.validateStartupConfiguration(next); setError('');
      if (!baseline.current) throw new Error('Configuration not loaded');
      setConfirm({ config: next, restart, profileId: profile.id, configPath: profile.configPath, expectedRevision: baseline.current.revision });
    }
    catch (failure) { setError(core.normalizeError(failure).message); }
  };
  const prepareCopy = () => {
    try {
      if (!profile || !config.data) return;
      const next = view === 'json' ? core.parseStartupConfiguration(raw) : materialize();
      core.validateStartupConfiguration(next);
      setCopyName(`${profile.configPath.split(/[\\/]/).at(-1)?.replace(/\.json$/i,'') ?? 'configuration'}-copy.json`);
      setError('');setFileAction({kind:'copy',config:next,profile});
    } catch(failure) { setError(core.normalizeError(failure).message); }
  };
  const manageFile = async () => {
    if (!fileAction || saving || fileOperation.current) return;
    const action=fileAction;
    if(action.profile.id!==profile?.id || action.profile.configPath!==profile?.configPath) {setFileAction(null);setError(zh?'当前配置已改变，请重新选择操作。':'The selected configuration changed. Choose the action again.');return;}
    fileOperation.current=true;setSaving(true);setError('');
    try {
      if(action.kind==='copy') {
        const copied=await core.copyConfiguration(action.profile,copyName.trim(),action.config);
        setFileAction(null);onMessage?.(zh?'新配置文件已创建。':'New configuration file created.');
        await onCopied?.(copied);
      } else {
        const result=await core.deleteConfiguration(action.profile);
        setFileAction(null);onMessage?.(`${zh?'配置已删除，恢复副本保存在：':'Configuration deleted. Recovery copy: '}${result.archivedPath}`);
        await onDeleted?.(action.profile);
      }
      await client.invalidateQueries({queryKey:['discovered-local-models']});
      await client.invalidateQueries({queryKey:['localInstallationDetails']});
    } catch(failure) {const detail=core.normalizeError(failure).message;setError(detail);onError(failure);}
    finally {fileOperation.current=false;setSaving(false);}
  };
  const save = async (action = confirm): Promise<boolean> => {
    if (!profile || !config.data || !action || saving) return false;
    let persisted = false;
    setSaving(true); setError('');
    try {
      if (action.profileId !== profile.id || action.configPath !== profile.configPath) throw new Error(zh ? '正在查看的配置已改变，请重新确认保存。' : 'The selected configuration changed. Review and confirm the save again.');
      if (action.restart && !onRestart) throw new Error(zh ? '当前配置已经不能重启。请关闭弹窗并重新确认当前模型状态。' : 'This configuration can no longer be restarted. Close the dialog and check the current model state.');
      const written = await core.writeConfig(profile, action.config, action.expectedRevision);
      persisted = true; setConfirm(null); reset({ config: action.config, revision: written.revision });
      await client.invalidateQueries({ queryKey: ['official-config', profile.id] });
      await client.invalidateQueries({ queryKey: ['localInstallationDetails'] });
      const refreshed = await config.refetch();
      if (!refreshed.isError && refreshed.data) reset(refreshed.data);
      if (refreshed.isError) throw new Error(zh ? '文件已保存，但重新读取失败；当前显示刚保存的内容。' : 'The file was saved but could not be reloaded; the saved content is still displayed.');
      if (action.restart) {
        const target = restartTarget.current;
        if (!target.onRestart || target.profileId !== action.profileId || target.configPath !== action.configPath) throw new Error(zh ? '当前配置已经不能重启，请检查当前模型状态。' : 'This configuration can no longer be restarted. Check the current model state.');
        setMessage(zh ? '配置已保存，正在重启服务…' : 'Configuration saved; restarting…'); await target.onRestart();
      }
      const text = action.restart ? (zh ? '完整配置已保存并备份，服务已按新参数重启。' : 'Full configuration saved with a backup; service restarted with the new settings.') : (zh ? '完整配置已保存，原文件已备份。重启服务后生效。' : 'Full configuration saved and the previous file backed up. Restart to apply it.');
      setMessage(text); await onMessage?.(text);
      return true;
    } catch (failure) { setConfirm(null); const text = `${persisted ? (zh ? '配置已保存，但后续操作失败：' : 'Configuration saved, but the next step failed: ') : ''}${core.normalizeError(failure).message}`; setError(text); onError(failure); return false; }
    finally { setSaving(false); }
  };
  const saveDraft: SaveDraft = async () => {
    if (!changed) return true;
    try {
      if (!profile || !baseline.current) return false;
      const next = view === 'json' ? core.parseStartupConfiguration(raw) : materialize();
      core.validateStartupConfiguration(next);
      return await save({ config: next, restart: false, profileId: profile.id, configPath: profile.configPath, expectedRevision: baseline.current.revision });
    } catch (failure) { setError(core.normalizeError(failure).message); onError(failure); return false; }
  };
  useEffect(() => { onSaveDraftReady?.(saveDraft); return () => onSaveDraftReady?.(undefined); });
  const reloadGuard = useDraftGuard(changed, saveDraft, language);
  const reload = () => reloadGuard.request(() => {
    void config.refetch().then(result => { if (!result.isError && result.data) reset(result.data); });
  });
  let preview = draft;
  if (draft) try { preview = materialize(false); } catch { /* Invalid input remains visible until corrected. */ }
  let rows: core.StartupArgRow[] = []; let argumentError = '';
  if (preview) try { rows = core.startupArgumentRows(preview); } catch (failure) { argumentError = core.normalizeError(failure).message; }
  const needle = search.trim().toLowerCase();
  const fieldValue = (field: StartupFieldSpec) => {
    if (Object.hasOwn(fieldEdits, field.key)) return fieldEdits[field.key]!;
    try { return draft ? core.startupFieldValue(draft, field) : ''; } catch { return ''; }
  };
  const updateTreeIssue = (path: string, issue: string, removedIndex?: number) => setTreeIssues(previous => {
    if (issue) return { ...previous, [path]: issue };
    const cleared: string[] = JSON.parse(path);
    return Object.fromEntries(Object.entries(previous).flatMap(([key, message]) => {
      const current: string[] = JSON.parse(key);
      if (!cleared.every((part, index) => current[index] === part)) return [[key, message]];
      if (removedIndex !== undefined) {
        const index = Number(current[cleared.length]);
        if (index < removedIndex) return [[key, message]];
        if (index > removedIndex) { current[cleared.length] = String(index - 1); return [[JSON.stringify(current), message]]; }
      }
      return [];
    }));
  });
  const newArity = core.STARTUP_ENGINE_FLAGS[newFlag] ?? customArity;
  const title = zh ? '更多启动设置' : 'More startup settings';
  return <div className="st-card startup-tuning" aria-label={title}><div className="setup-tuning-panel-heading"><span className="card-title">{title}</span><button type="button" className="setup-tuning-help-button" aria-label={zh ? '启动设置帮助' : 'Startup settings help'} title={zh ? '帮助' : 'Help'} onClick={() => setHelpOpen(true)}><CircleHelp size={16}/></button></div>
    {!desktop ? <p className="muted">{zh ? '请在桌面应用中编辑本地配置。' : 'Use the desktop app to edit local configuration.'}</p> : !profile?.configPath ? <p className="muted">{zh ? '请先导入一个模型配置。' : 'Import a model configuration first.'}</p> : <>
      <div className="startup-file-actions"><code title={profile.configPath}>{profile.configPath.split(/[\\/]/).at(-1)}</code><button type="button" disabled={disabled || !config.data} onClick={prepareCopy}><Copy size={14}/>{zh?'复制为新配置':'Copy to new configuration'}</button><button type="button" className="danger" disabled={disabled || !config.data} onClick={()=>{setError('');setFileAction({kind:'delete',profile});}}><Trash2 size={14}/>{zh?'删除此配置':'Delete configuration'}</button></div>
      {(error || config.error || argumentError) && <p role="alert" className="runtime-config-error">{error || (config.error ? core.normalizeError(config.error).message : argumentError)}</p>}
      {config.isPending && <p className="muted">{zh ? '读取配置中…' : 'Reading configuration…'}</p>}
      {draft && <><div className="startup-tuning-navigation"><Segmented value={view} onValueChange={selectView} ariaLabel={zh ? '配置编辑方式' : 'Configuration editor'} options={[{ value: 'graph', label: zh ? '图形界面' : 'Graphical', disabled }, { value: 'json', label: zh ? '完整 JSON' : 'Full JSON', disabled }]}/>{view === 'graph' && <label className="startup-tuning-search"><Search size={15}/><input className="st-input" aria-label={zh ? '搜索启动参数' : 'Search startup parameters'} placeholder={zh ? '搜索名称或参数标志' : 'Search names or flags'} value={search} onChange={event => setSearch(event.target.value)}/></label>}</div>
        {view === 'json' ? <div className="startup-tuning-json-editor"><label className="st-label" htmlFor="startup-full-config-json">{zh ? '完整本地 JSON 配置' : 'Full local JSON configuration'}</label><textarea className="startup-tuning-json st-input" id="startup-full-config-json" spellCheck={false} value={raw} disabled={disabled} onChange={event => { setRaw(event.target.value); setError(''); setMessage(''); }}/></div> : <>
          <StartupNetworkPowerSettings zh={zh} disabled={disabled} fallbackBaseUrl={profile.baseUrl} showParameterNames={showParameterNames} fieldValue={fieldValue} onFieldChange={(field, value) => { setFieldEdits(previous => ({ ...previous, [field.key]: value })); setMessage(''); setError(''); }}/>
          <div className="startup-tuning-category"><label><span className="st-label">{zh ? '设置分类' : 'Settings category'}</span><Dropdown ariaLabel={zh ? '设置分类' : 'Settings category'} value={selectedGroup} disabled={disabled || !!needle} options={groups.map(([value, labelZh, labelEn]) => ({ value, label: zh ? labelZh : labelEn }))} onValueChange={value => setSelectedGroup(value as SettingsCategory)}/></label><label className="startup-tuning-parameter-names"><input type="checkbox" checked={showParameterNames} onChange={event => setShowParameterNames(event.target.checked)}/>{zh ? '显示技术参数名称' : 'Show technical parameter names'}</label></div>
          <div className="startup-tuning-groups">{groups.filter(([group]) => needle || group === selectedGroup).map(([group, labelZh, labelEn]) => {
            const groupFields = core.STARTUP_TUNING_FIELDS.filter(field => field.group === (group === 'context-extension' ? 'context' : group) && (field.group !== 'context' || basicContextFields.has(field.key) !== (group === 'context-extension')) && (!needle || `${field.key} ${field.zh} ${field.en}`.toLowerCase().includes(needle)));
            if (!groupFields.length) return null;
            return <section className="startup-tuning-group startup-tuning-active-group" aria-label={zh ? labelZh : labelEn} key={group}>{needle && <h3>{zh ? labelZh : labelEn}</h3>}<div className="startup-tuning-fields">{groupFields.map(field => {
              const value = fieldValue(field); const label = zh ? field.zh : field.en;
              const choices = field.kind === 'boolean' ? [{ value: '', label: zh ? '使用默认设置' : 'Use default' }, { value: 'true', label: field.target === 'arg' ? (zh ? '启用此选项' : 'Enable option') : (zh ? '开启' : 'On') }, { value: 'false', label: field.target === 'arg' ? (zh ? '不启用' : 'Disable option') : (zh ? '关闭' : 'Off') }] : [{ value: '', label: zh ? '使用默认设置' : 'Use default' }, ...(field.choices ?? []).map(option => ({ value: option, label: option }))];
              return <div className="st-field" key={field.key}><span className="st-label">{label}</span>{showParameterNames && <code>{field.key}</code>}<Dropdown editable={field.kind !== 'boolean'} ariaLabel={label} disabled={disabled} value={value} editableDisplayValue={field.kind === 'boolean' ? undefined : value} placeholder={zh ? '使用默认设置' : 'Use default'} options={choices} onValueChange={next => { setFieldEdits(previous => ({ ...previous, [field.key]: next })); setMessage(''); setError(''); }}/></div>;
            })}</div></section>;
          })}</div>
          <details className="startup-tuning-group startup-arguments"><summary><span>{zh ? '完整引擎参数列表（args）' : 'Full engine argument list (args)'}</span><small>{rows.length}</small></summary><div className="startup-argument-list">{rows.map(row => {
            const field = core.STARTUP_TUNING_FIELDS.find(spec => spec.target === 'arg' && spec.key === row.tokens[0]);
            const updateToken = (index: number, value: string) => mutate(data => { const tokens = [...row.tokens]; tokens[index] = value; return core.replaceStartupArgument(data, row, tokens); });
            return <div className="startup-argument-row" key={row.offset}><span className="startup-argument-number">{row.offset + 1}</span><Dropdown editable ariaLabel={`${zh ? '参数名称' : 'Argument'} ${row.offset + 1}`} disabled={disabled} value={row.tokens[0]!} editableDisplayValue={row.tokens[0]!} options={Object.keys(core.STARTUP_ENGINE_FLAGS).map(flag => ({ value: flag, label: flag }))} onValueChange={value => updateToken(0, value)}/><div className="startup-argument-operands">{row.tokens.slice(1).map((token, index) => <Dropdown key={index} editable ariaLabel={`${row.tokens[0]} ${zh ? '值' : 'value'} ${index + 1}`} disabled={disabled} value={token} editableDisplayValue={token} options={(field?.choices ?? []).map(value => ({ value, label: value }))} onValueChange={value => updateToken(index + 1, value)}/>)}{row.tokens.length === 1 && row.arity === 0 && <small>{row.known ? (zh ? '无值开关' : 'Flag without value') : (zh ? '自定义参数' : 'Custom token')}</small>}{row.tokens.length - 1 < row.arity && <button type="button" disabled={disabled} onClick={() => mutate(data => core.replaceStartupArgument(data, row, [...row.tokens, '']))}><Plus size={13}/>{zh ? '补充值' : 'Add operand'}</button>}</div><button className="startup-remove-value" type="button" disabled={disabled} aria-label={`${zh ? '移除参数' : 'Remove argument'} ${row.tokens[0]}`} onClick={() => mutate(data => core.replaceStartupArgument(data, row, []))}><Trash2 size={14}/></button></div>;
          })}</div><div className="startup-new-argument"><Dropdown editable ariaLabel={zh ? '新增参数名称' : 'New argument name'} disabled={disabled} value={newFlag} editableDisplayValue={newFlag} placeholder="--flag" options={Object.keys(core.STARTUP_ENGINE_FLAGS).map(flag => ({ value: flag, label: flag }))} onValueChange={value => { setNewFlag(value); setNewOperands([]); }}/>{!Object.hasOwn(core.STARTUP_ENGINE_FLAGS, newFlag) && <Dropdown ariaLabel={zh ? '自定义参数值数量' : 'Custom operand count'} disabled={disabled} value={String(customArity)} options={[0, 1, 2].map(value => ({ value: String(value), label: `${value} ${zh ? '个值' : 'operands'}` }))} onValueChange={value => setCustomArity(Number(value))}/>}{Array.from({ length: newArity }, (_, index) => <input className="st-input" key={index} aria-label={`${zh ? '新增参数值' : 'New operand'} ${index + 1}`} disabled={disabled} value={newOperands[index] ?? ''} onChange={event => setNewOperands(previous => { const next = [...previous]; next[index] = event.target.value; return next; })}/>)}<button type="button" disabled={disabled || !newFlag || Array.from({ length: newArity }, (_, index) => !newOperands[index]).some(Boolean)} onClick={() => { mutate(data => ({ ...data, args: [...core.startupArgsOf(data), newFlag, ...Array.from({ length: newArity }, (_, index) => newOperands[index]!)] })); setNewFlag(''); setNewOperands([]); }}><Plus size={14}/>{zh ? '添加参数' : 'Add argument'}</button></div></details>
          <details className="startup-tuning-group startup-full-graph"><summary><span>{zh ? '完整配置字段（图形编辑）' : 'Every configuration field (graphical)'}</span></summary><ConfigurationNode value={preview} path={[]} disabled={disabled} zh={zh} onIssue={updateTreeIssue} onChange={value => mutate(() => value as JsonObject, true)}/></details>
        </>}
      </>}
      <div className="cfg-actions"><button className="st-btn st-btn--primary" disabled={disabled || !config.data || !changed} onClick={() => prepareSave(false)}>{zh ? '保存完整配置' : 'Save full configuration'}</button>{onRestart && <button className="st-btn st-btn--secondary" disabled={disabled || !config.data || !changed} onClick={() => prepareSave(true)}>{zh ? '保存并重启当前模型' : 'Save and restart current model'}</button>}<button className="st-btn st-btn--secondary" disabled={saving || config.isFetching} onClick={reload}>{zh ? '重新读取' : 'Reload'}</button><span className="muted small" role="status">{message}</span></div>
    </>}
    {helpOpen && <Dialog title={zh ? '启动设置帮助' : 'Startup settings help'} onClose={() => setHelpOpen(false)}><div className="setup-tuning-help-content"><p>{zh ? '不确定时保留现有设置。修改后保存，重启模型时生效；保存前会自动备份。' : 'Keep the current settings when unsure. Save changes and restart the model to apply them; the previous file is backed up.'}</p><p>{zh ? '通过分类选择设置，搜索会查找所有分类。图形界面与 JSON 编辑同一份配置。' : 'Choose a settings category; search covers every category. Graphical and JSON editors use the same configuration.'}</p><p>{zh ? '主模型 CPU 线程由 pool-workers / pool-affinity 控制；vision.threads 仅控制视觉编码，顶层 threads 不控制主模型。自定义输入是否可用取决于当前 Strata 版本。' : 'Main-model CPU workers use pool-workers / pool-affinity. vision.threads controls only vision; top-level threads does not control the main model. Custom inputs depend on the installed Strata version.'}</p><p>{zh ? '完整引擎参数保留顺序、重复和未知选项。每个输入值对应一个参数项，路径含空格也无需加引号。完整配置字段可编辑 MCP、环境变量和自定义字段。' : 'The full engine argument list preserves order, repetition and unknown options. Each input is one argument; paths with spaces need no added quotes. The full configuration editor includes MCP, environment variables and custom fields.'}</p>{profile?.configPath && <code className="startup-tuning-path">{profile.configPath}</code>}</div></Dialog>}
    {reloadGuard.dialog}
    {confirm && <Dialog title={confirm.restart ? (zh ? '保存并重启当前模型' : 'Save and restart current model') : (zh ? '保存完整配置' : 'Save full configuration')} onClose={() => { if (!saving) setConfirm(null); }}><p>{confirm.restart ? (zh ? '将备份并保存完整配置，然后重启当前模型服务。正在进行的请求会被中断。' : 'Back up and save the full configuration, then restart the current model service. Active requests will be interrupted.') : (zh ? '将备份并保存完整配置。当前服务继续使用已有设置，重启后应用新参数。' : 'Back up and save the full configuration. The running service keeps its existing settings until restarted.')}</p><div className="dialog-footer"><button disabled={saving} onClick={() => setConfirm(null)}>{zh ? '取消' : 'Cancel'}</button><button className="primary" disabled={saving} onClick={() => void save()}>{saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '确认保存' : 'Save changes')}</button></div></Dialog>}
    {fileAction && <Dialog title={fileAction.kind==='copy'?(zh?'复制为新配置':'Copy configuration'):(zh?'删除配置文件':'Delete configuration file')} onClose={()=>{if(!saving)setFileAction(null);}}><div className="startup-file-dialog"><code>{fileAction.profile.configPath}</code>{fileAction.kind==='copy'?<label><span>{zh?'新文件名':'New file name'}</span><input value={copyName} disabled={saving} onChange={event=>setCopyName(event.target.value)} aria-label={zh?'新配置文件名':'New configuration file name'}/><p>{zh?'复制当前编辑内容，在同目录创建独立 JSON。':'Copy the current edits into a separate JSON file in the same directory.'}</p></label>:<p>{zh?'删除此 JSON 文件和对应保存记录，保留可恢复副本。正在运行的配置需要先停止服务。':'Delete this JSON file and its saved record, retaining a recovery copy. Stop the service before deleting an active configuration.'}</p>}{error&&<p className="notice error" role="alert">{error}</p>}<div className="dialog-footer"><button disabled={saving} onClick={()=>setFileAction(null)}>{zh?'取消':'Cancel'}</button><button className={fileAction.kind==='delete'?'danger-solid':'primary'} disabled={saving || fileAction.kind==='copy'&&!/^[^\\/:*?"<>|]+\.json$/i.test(copyName.trim())} onClick={()=>void manageFile()}>{saving?(zh?'处理中…':'Working…'):fileAction.kind==='copy'?(zh?'创建副本':'Create copy'):(zh?'确认删除':'Delete file')}</button></div></div></Dialog>}
  </div>;
}
