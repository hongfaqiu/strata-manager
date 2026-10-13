import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as core from '@strata-manager/core';
import type { ServiceProfile } from '@strata-manager/core';
import { Panel } from './components';
import type { SaveDraft } from './useDraftGuard';
import { ServiceSharingPanel } from './ServiceSharingPanel';

interface Props {
  profile?: ServiceProfile;
  language: 'zh-CN' | 'en';
  desktop: boolean;
  onError: (error: unknown) => void;
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaveDraftReady: (save: SaveDraft | undefined) => void;
}

/** Credentials remain scoped to the selected service; this is a shared editing entry. */
export function ServiceConnectionPanel(props: Props) {
  return <ConnectionSession key={props.profile?.id ?? 'none'} {...props}/>;
}

function ConnectionSession({ profile, language, desktop, onError, onSaved, onDirtyChange, onSaveDraftReady }: Props) {
  const zh = language === 'zh-CN';
  const [key, setKey] = useState(''), [dirty, setDirty] = useState(false);
  const [sharingDirty, setSharingDirty] = useState(false);
  const [saving, setSaving] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const mounted = useRef(true), savingRef = useRef(false), dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; dirtyCallback.current(false); }; }, []);
  useEffect(() => { onDirtyChange(dirty || sharingDirty); }, [dirty, sharingDirty, onDirtyChange]);
  const credential = useQuery({ queryKey: ['runtime-config-key', profile?.id], queryFn: () => core.hasApiKey(profile!.id), enabled: !!profile, retry: false });
  const save = async (remove = false): Promise<boolean> => {
    if (!profile || savingRef.current) return false;
    if (!remove && !dirty) return true;
    savingRef.current = true; setSaving(true); setError(''); setMessage('');
    try {
      const next = remove ? '' : key.trim();
      await core.setApiKey(profile.id, next);
      if (!mounted.current) return false;
      setKey(''); setDirty(false);
      setMessage(next ? (zh ? 'API Key 已保存。' : 'API key saved.') : (zh ? 'API Key 已移除。' : 'API key removed.'));
      onSaved(); await credential.refetch(); return true;
    } catch (cause) { if (mounted.current) { setError(core.normalizeError(cause).message); onError(cause); } return false; }
    finally { savingRef.current = false; if (mounted.current) setSaving(false); }
  };
  useEffect(() => { onSaveDraftReady(() => {
    if (sharingDirty) { setError(zh ? '请先预览并保存局域网设置，或取消该草稿，再切换服务。' : 'Review and save LAN changes, or discard the draft, before switching services.'); return Promise.resolve(false); }
    return save();
  }); return () => onSaveDraftReady(undefined); });
  let address = '';
  try { address = profile ? core.normalizeBaseUrl(profile.baseUrl) : ''; } catch { /* Keep the credential editor usable for a stale service address. */ }
  return <Panel title={zh ? '服务连接与 API Key' : 'Service connection and API key'} className="service-connection-panel">
    {profile ? <><p><strong>{profile.name}</strong><code className="shared-service-address">{address || profile.baseUrl}</code></p>
      <p className="subtle">{zh ? '连接信息属于上方所选服务。切换目标不会启动模型，密钥仍分别保存在系统凭据库。这里保存的是应用访问服务的密钥，不会修改服务端鉴权。' : 'Connection details belong to the selected service. Selecting a target does not start it; credentials stay separate in the system vault. This stores the app’s access key and does not change server authentication.'}</p>
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <label className="field"><span>API Key</span><input aria-label="API Key" type="password" autoComplete="new-password" placeholder={credential.data ? (zh ? '已保存；输入以替换' : 'Saved; enter to replace') : (zh ? '无密钥时留空' : 'Leave empty if not required')} disabled={saving} value={key} onChange={event => { setKey(event.target.value); setDirty(true); setMessage(''); setError(''); }}/></label>
        <p className="subtle">{desktop ? (zh ? '密钥不会回显。' : 'Saved keys are never displayed.') : (zh ? '浏览器预览中的密钥仅在当前会话保留。' : 'Browser preview keys last only for the current session.')}</p>
        <div className="actions"><button className="primary" type="submit" disabled={saving || !dirty}>{saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存密钥' : 'Save key')}</button><button type="button" disabled={saving || !credential.data} onClick={() => void save(true)}>{zh ? '移除密钥' : 'Remove key'}</button><span role="status">{message}</span></div>
      </form>{(error || credential.error) && <p className="notice error" role="alert">{error || core.normalizeError(credential.error).message}</p>}
      <ServiceSharingPanel profile={profile} language={language} desktop={desktop} onSaved={onSaved} onDirtyChange={setSharingDirty}/>
    </> : <p className="subtle">{zh ? '添加模型后，可在这里统一管理连接信息。' : 'Add a model to manage its connection details here.'}</p>}
  </Panel>;
}
