import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as core from '@strata-manager/core';
import type { JsonObject, ServiceProfile } from '@strata-manager/core';
import { Dropdown, NumberField } from '../OfficialControls';
import { StartupTuningPanel } from './StartupTuningPanel';
import './runtime-config.css';

const configHelpZh: Record<string, string> = {
  'sampling.temperature': '未指定温度的请求所用默认值（0 = 贪心，也是没有采样配置时的默认值）',
  'sampling.top_p': '未指定 top_p 的请求所用默认值（大于 0，且不超过 1）',
  'sampling.top_k': '未指定 top_k 的请求所用默认值（1–64）',
  'sampling.min_p': '未指定 min_p 的请求所用默认值（0–1）',
  reasoning_budget_tokens: '将每个请求的思考限制在此 token 数以内（0 或留空：不限制）',
  fit_max_tokens: 'max_tokens 超出上下文时缩短输出长度，避免返回 400',
  anthropic_thinking: 'Anthropic 请求未要求思考时：按模型方式思考（model）或不思考（on_request）',
  effort_position: '非默认推理强度的位置：start（默认）或 end（改变时保留缓存）',
  aliases: '服务列出并接受的其他模型名称（逗号分隔）',
  idle_unload_s: '无请求持续此秒数后卸载模型（0 或留空：永不）',
  lazy_load: '启动时不加载模型；首个请求时加载（仅文本）',
  engine_silence_s: '引擎持续无输出此秒数后结束请求（默认 300 秒，0 = 等待）',
  api_monitor: '在内存中保留最近 100 个请求的输入和回答，供 /api-monitor 查看',
  open_browser: '模型就绪时在浏览器打开聊天页面',
  vram_reserve_mib: '引擎为其他程序保留的显存 MiB（引擎默认 700）',
};
const valuesOf = (keys: JsonObject[]) => Object.fromEntries(keys.map(k => [String(k.key), k.value == null ? '' : Array.isArray(k.value) ? k.value.join(', ') : String(k.value)]));
const configGroups = [
  { zh: '默认采样', en: 'Default sampling', keys: ['sampling.temperature', 'sampling.top_p', 'sampling.top_k', 'sampling.min_p'] },
  { zh: '推理与输出', en: 'Reasoning and output', keys: ['reasoning_budget_tokens', 'fit_max_tokens', 'anthropic_thinking', 'effort_position'] },
  { zh: '资源与运行', en: 'Resources and runtime', keys: ['idle_unload_s', 'lazy_load', 'engine_silence_s', 'vram_reserve_mib', 'open_browser'] },
  { zh: '接口与观测', en: 'API and observation', keys: ['aliases', 'api_monitor'] },
] as const;
const fieldLabels: Record<string, [string, string]> = {
  'sampling.temperature': ['温度', 'Temperature'], 'sampling.top_p': ['Top P', 'Top P'],
  'sampling.top_k': ['Top K', 'Top K'], 'sampling.min_p': ['Min P', 'Min P'],
  reasoning_budget_tokens: ['思考 token 上限', 'Thinking token limit'], fit_max_tokens: ['自动缩短输出长度', 'Fit output into context'],
  anthropic_thinking: ['Anthropic 思考策略', 'Anthropic thinking policy'], effort_position: ['推理强度的位置', 'Reasoning effort position'],
  idle_unload_s: ['空闲卸载时间（秒）', 'Idle unload time (seconds)'], lazy_load: ['首次请求再加载模型', 'Load on first request'],
  engine_silence_s: ['引擎无输出超时（秒）', 'Engine silence timeout (seconds)'], vram_reserve_mib: ['保留显存（MiB）', 'Reserved VRAM (MiB)'],
  open_browser: ['模型就绪后打开浏览器', 'Open browser when ready'], aliases: ['模型别名', 'Model aliases'], api_monitor: ['记录 API 请求', 'Record API requests'],
};
const numberRules: Record<string, { min: number; max?: number; whole?: boolean; openMin?: boolean }> = {
  'sampling.temperature': { min: 0 }, 'sampling.top_p': { min: 0, max: 1, openMin: true },
  'sampling.top_k': { min: 1, max: 64, whole: true }, 'sampling.min_p': { min: 0, max: 1 },
  reasoning_budget_tokens: { min: 0, whole: true }, idle_unload_s: { min: 0 }, engine_silence_s: { min: 0 }, vram_reserve_mib: { min: 0, whole: true },
};

export interface RuntimeConfigPageProps {
  profile?: ServiceProfile;
  online: boolean;
  language: 'zh-CN' | 'en';
  desktop?: boolean;
  onKeySaved?: () => void;
  onError: (error: unknown) => void;
  onMessage?: (message: string) => void;
  /** Request sampling changes apply to the next chat request without restarting the service. */
  onSampling?: () => void;
  /** Navigate to service management; restarting remains an explicit user action. */
  onServices?: () => void;
}

/** A new service gets an independent editing session, including its key and unsaved changes. */
export function RuntimeConfigPage(props: RuntimeConfigPageProps) {
  const identity = props.profile ? `${props.profile.id}:${props.profile.baseUrl}:${props.profile.configPath}` : 'none';
  return <RuntimeConfigSession key={identity} {...props} />;
}

function RuntimeConfigSession({ profile, online, language, desktop = core.isDesktop(), onKeySaved, onError, onMessage, onSampling, onServices }: RuntimeConfigPageProps) {
  const { t } = useTranslation();
  const zh = language === 'zh-CN';
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [key, setKey] = useState('');
  const [keyDirty, setKeyDirty] = useState(false);
  const [keySaving, setKeySaving] = useState(false);
  const [keyMessage, setKeyMessage] = useState('');
  const [keyError, setKeyError] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  const config = useQuery({
    queryKey: ['official-config', profile?.id, profile?.baseUrl, profile?.configPath],
    queryFn: () => core.request(profile!, '/config'),
    enabled: !!profile && online,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const credential = useQuery({ queryKey: ['runtime-config-key', profile?.id], queryFn: () => core.hasApiKey(profile!.id), enabled: !!profile, retry: false });
  const keys = useMemo(() => Array.isArray(config.data?.keys) ? config.data.keys.map(core.asObject) : [], [config.data]);
  const groups = useMemo(() => {
    const grouped = configGroups.map(group => ({ title: zh ? group.zh : group.en, fields: group.keys.flatMap(name => keys.filter(key => key.key === name)) }));
    const known = new Set<string>(configGroups.flatMap(group => [...group.keys]));
    const other = keys.filter(key => !known.has(String(key.key)));
    return [...grouped, ...(other.length ? [{ title: zh ? '其他服务参数' : 'Other service parameters', fields: other }] : [])].filter(group => group.fields.length);
  }, [keys, zh]);
  useEffect(() => {
    setValues(valuesOf(keys));
  }, [keys]);
  const fail = (error: unknown, setError: (message: string) => void) => {
    if (!active.current) return;
    setError(core.normalizeError(error).message);
    onError(error);
  };
  const saveKey = async (remove = false) => {
    if (!profile || keySaving || (!remove && !keyDirty)) return;
    setKeySaving(true); setKeyError(''); setKeyMessage('');
    try {
      const next = remove ? '' : key.trim();
      await core.setApiKey(profile.id, next);
      if (!active.current) return;
      setKey(''); setKeyDirty(false);
      const text = next ? (zh ? 'API Key 已保存。' : 'API key saved.') : (zh ? 'API Key 已移除。' : 'API key removed.');
      setKeyMessage(text); onMessage?.(text); onKeySaved?.();
      await credential.refetch();
      if (active.current && online) await config.refetch();
    } catch (error) { fail(error, setKeyError); }
    finally { if (active.current) setKeySaving(false); }
  };
  const saveConfig = async () => {
    if (!profile || !online || saving || config.isFetching || config.isError) return;
    setSaveError(''); setMessage('');
    const set: JsonObject = {};
    for (const k of keys) {
      const name = String(k.key), text = (values[name] ?? '').trim();
      const value = text === '' ? null : k.kind === 'bool' ? text === 'true' : k.kind === 'number' ? Number(text) : text;
      if (typeof value === 'number' && !Number.isFinite(value)) {
        setSaveError(zh ? `${name} 必须是有效数字。` : `${name} must be a valid number.`); return;
      }
      const rule = numberRules[name];
      if (typeof value === 'number' && rule && ((rule.whole && !Number.isInteger(value)) || (rule.openMin ? value <= rule.min : value < rule.min) || (rule.max !== undefined && value > rule.max))) {
        const range = `${rule.openMin ? '>' : '≥'} ${rule.min}${rule.max === undefined ? '' : `, ≤ ${rule.max}`}`;
        setSaveError(zh ? `${name} 必须${rule.whole ? '为整数且' : ''}满足 ${range}。` : `${name} must be ${rule.whole ? 'a whole number ' : ''}in range ${range}.`); return;
      }
      const previous = Array.isArray(k.value) ? k.value.join(', ') : k.value ?? null;
      if (JSON.stringify(value) !== JSON.stringify(previous)) set[name] = value;
    }
    if (!Object.keys(set).length) { setMessage(t('configNothingChanged')); return; }
    setSaving(true);
    try {
      const result = await core.request(profile, '/config', 'POST', { set });
      if (!active.current) return;
      const text = Array.isArray(result.changed) && result.changed.length
        ? t('configSavedRestart', { keys: result.changed.join(', '), file: result.file ?? config.data?.file ?? '' })
        : t('configNothingChanged');
      setMessage(text); onMessage?.(text);
      await config.refetch();
    } catch (error) { fail(error, setSaveError); }
    finally { if (active.current) setSaving(false); }
  };
  const reloadConfig = async () => {
    setSaveError(''); setMessage('');
    const result = await config.refetch();
    // React Query preserves equal data references; an explicit reload still discards edits.
    if (active.current && result.data && !result.isError) {
      setValues(valuesOf(Array.isArray(result.data.keys) ? result.data.keys.map(core.asObject) : []));
    }
  };
  const locked = saving || config.isFetching || !online || config.isError;
  return <section className="view view--runtime-config" id="view-config" aria-labelledby="workspace-page-title"><div className="runtime-config">
    <section className="st-card runtime-config-guide" aria-label={zh ? '参数调整说明' : 'Parameter guide'}>
      <div><strong>{zh ? '聊天采样：下一次提问生效' : 'Chat sampling: applies to your next request'}</strong><p>{zh ? '温度、Top P、Top K 与思考强度影响回答方式。可先调整聊天采样并比较回答，无需重启服务。' : 'Temperature, Top P, Top K and reasoning effort affect responses. Adjust chat sampling and compare answers without restarting.'}</p>{onSampling && <button type="button" onClick={onSampling} disabled={!profile}><SlidersHorizontal size={15}/>{zh ? '调整聊天采样' : 'Adjust chat sampling'}</button>}</div>
      <div><strong>{zh ? '服务配置：保存后重启生效' : 'Service configuration: restart after saving'}</strong><p>{zh ? '下方的启动参数和默认运行配置保存到文件，不会立即改变正在运行的服务。保存后请到服务管理页主动重启；未接管的外部服务需从原启动程序重启。' : 'Startup parameters and default runtime settings below are saved to the file. Restart explicitly in Service management to apply them; restart an external service using its launcher until it is taken over.'}</p>{onServices && <button type="button" onClick={onServices}><ArrowRight size={15}/>{zh ? '前往服务管理' : 'Open Service management'}</button>}</div>
    </section>
    <div className="st-card runtime-config-connection"><span className="card-title">{zh ? '服务连接' : 'Service connection'}</span>
      {profile ? <><p><strong>{profile.name}</strong><code className="runtime-config-address">{core.normalizeBaseUrl(profile.baseUrl)}</code></p>
        <form onSubmit={event => { event.preventDefault(); void saveKey(); }}>
          <div className="st-field"><label className="st-label" htmlFor="api-key">{t('apiKey')}<output>{t('apiKeyOnly')}</output></label>
            <input className="st-input" id="api-key" type="password" autoComplete="new-password" placeholder={credential.data ? (zh ? '已保存；输入以替换' : 'Saved; enter to replace') : t('notNeeded')} disabled={keySaving} value={key} onChange={event => { setKey(event.target.value); setKeyDirty(true); setKeyMessage(''); }} />
          </div><p className="muted small">{desktop ? (zh ? '保存在系统凭据库，不会回显。' : 'Stored in the system credential vault and never displayed.') : (zh ? '密钥仅在当前会话保留，关闭后清除。' : 'Keys are kept only for the current session.')}</p>
          <div className="cfg-actions"><button className="st-btn st-btn--primary" type="submit" disabled={keySaving || !keyDirty}>{keySaving ? (zh ? '保存中…' : 'Saving…') : t('save')}</button>
            <button className="st-btn st-btn--secondary" type="button" disabled={keySaving || !credential.data} onClick={() => void saveKey(true)}>{zh ? '移除密钥' : 'Remove key'}</button><span className="muted small" role="status">{keyMessage}</span></div>
        </form>{(keyError || credential.error) && <p className="runtime-config-error" role="alert">{keyError || core.normalizeError(credential.error).message}</p>}
      </> : <p className="muted">{zh ? '先创建或选择一个服务配置。' : 'Create or select a service profile first.'}</p>}
    </div>
    <StartupTuningPanel profile={profile} desktop={desktop} language={language} onError={onError} onMessage={onMessage}/>
    <div className="st-card cfg-card" id="cfg-card"><div className="req-head"><span className="card-title">{t('modelSettings')}</span><span className="muted small" id="cfg-file">{online ? String(config.data?.file ?? '') : ''}</span></div>
      <p className="muted small">{zh ? '默认采样用于未指定采样参数的请求；其他运行项影响所有客户端。配置保存到此服务的模型配置文件。' : 'Sampling defaults apply to requests that omit those parameters; other runtime settings affect all clients. Changes are saved to this service’s model configuration file.'}</p><p className="runtime-config-restart-note">{zh ? '此处所有字段保存后均需重启 Strata 服务才能生效。恢复默认会清除此字段的自定义值，点击保存后写入配置。' : 'All fields here require a Strata service restart after saving. Resetting a field clears its custom value; save to write that change to the file.'}</p>
      {!profile ? <p className="muted">{zh ? '选择服务后可读取运行配置。' : 'Select a service to read its run configuration.'}</p> : !online ? <p className="muted" role="status">{zh ? '服务离线。连接成功后会自动读取运行配置；API Key 可在上方保存。' : 'Service is offline. Run configuration loads when connected; the API key can still be saved above.'}</p> : <>
        <div className="runtime-config-refresh"><button className="st-btn st-btn--secondary" type="button" disabled={saving || config.isFetching} onClick={() => void reloadConfig()}>{config.isFetching ? (zh ? '读取中…' : 'Loading…') : (zh ? '重新读取' : 'Reload')}</button><span className="muted small">{zh ? '重新读取会舍弃未保存的改动。' : 'Reloading discards unsaved changes.'}</span></div>
        {config.error && <p className="runtime-config-error" role="alert">{core.normalizeError(config.error).message}</p>}
        {!!keys.length && <><form className="cfg-form runtime-config-form" id="cfg-form" noValidate onSubmit={event => { event.preventDefault(); void saveConfig(); }}>{groups.map(group => <fieldset className="runtime-config-group" key={group.title}><legend>{group.title}</legend>{group.fields.map(k => {
          const name = String(k.key), help = zh ? configHelpZh[name] ?? String(k.help ?? name) : String(k.help ?? name), field = `cfg-${keys.indexOf(k)}`;
          const label = fieldLabels[name]?.[zh ? 0 : 1] ?? name, rule = numberRules[name];
          const update = (value: string) => { setValues(old => ({ ...old, [name]: value })); setMessage(''); setSaveError(''); };
          return <div className="runtime-config-field" key={name} data-config-key={name}><label htmlFor={field}><strong>{label}</strong><code>{name}</code><small id={`${field}-help`}>{help}</small></label><div className="runtime-config-control">
            {k.kind === 'bool' || k.kind === 'enum' ? <Dropdown id={field} ariaLabel={label} disabled={locked} value={values[name] ?? ''} options={[{ value: '', label: t('configDefault') }, ...(k.kind === 'bool' ? [{ value: 'true', label: t('enabledOn') }, { value: 'false', label: t('enabledOff') }] : Array.isArray(k.choices) ? k.choices.map(choice => ({ value: String(choice), label: String(choice) })) : [])]} onValueChange={update} />
              : k.kind === 'number' ? <NumberField className="st-input" id={field} aria-label={label} aria-describedby={`${field}-help`} disabled={locked} step={rule?.whole ? 1 : 'any'} min={rule?.min ?? 0} max={rule?.max} value={values[name] ?? ''} placeholder={t('configDefault')} onChange={event => update(event.target.value)} />
                : <input className="st-input" id={field} aria-label={label} aria-describedby={`${field}-help`} disabled={locked} autoComplete="off" value={values[name] ?? ''} placeholder={t('configDefault')} onChange={event => update(event.target.value)} />}
            <button type="button" className="runtime-config-reset" disabled={locked || !values[name]} aria-label={`${zh ? '恢复默认' : 'Reset to default'}: ${label}`} title={zh ? '清除自定义值，保存后采用默认值' : 'Clear the custom value; defaults apply after saving'} onClick={() => update('')}><RotateCcw size={14}/>{zh ? '默认' : 'Default'}</button>
          </div></div>;
        })}</fieldset>)}</form><div className="cfg-actions"><button className="st-btn st-btn--primary" id="cfg-save" type="button" disabled={locked} onClick={() => void saveConfig()}>{saving ? (zh ? '保存中…' : 'Saving…') : t('save')}</button><span className="muted small" id="cfg-msg" role="status">{message}</span>{message && onServices && <button className="st-btn st-btn--secondary" type="button" onClick={onServices}>{zh ? '前往服务管理重启' : 'Restart in Service management'}<ArrowRight size={14}/></button>}</div></>}
        {!config.isPending && !config.error && !keys.length && <p className="muted">{zh ? '此服务未提供可编辑的运行配置字段。' : 'This service provides no editable run configuration fields.'}</p>}
        {saveError && <p className="runtime-config-error" role="alert">{saveError}</p>}
      </>}
    </div>
  </div></section>;
}
