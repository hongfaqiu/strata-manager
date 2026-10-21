import type { AppLanguage } from "@strata-manager/core";
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as core from '@strata-manager/core';
import type { ServiceProfile, SetServiceAuthRequest, SharingPreview } from '@strata-manager/core';
import { Dialog } from './components';
import { Dropdown, Segmented } from './OfficialControls';
import './service-access.css';

interface Props { profile: ServiceProfile; language: AppLanguage; desktop: boolean; onSaved: () => void; onDirtyChange: (dirty: boolean) => void }

/** Configuration editing and explicit restart are deliberately separate actions. */
export function ServiceSharingPanel({ profile, language, desktop, onSaved, onDirtyChange }: Props) {
  const zh = language === 'zh-CN', client = useQueryClient();
  const [host, setHost] = useState(''), [port, setPort] = useState('');
  const [keyAction, setKeyAction] = useState<SetServiceAuthRequest['keyAction']>('keep'), [serverKey, setServerKey] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [failure, setFailure] = useState('');
  const [review, setReview] = useState<{ request: SetServiceAuthRequest; preview: SharingPreview }>();
  const [copied, setCopied] = useState(false), mounted = useRef(true), working = useRef(false), initialized = useRef(false), dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  const queryKey = ['service-sharing', profile.id, profile.configPath];
  const status = useQuery({ queryKey, queryFn: () => core.serviceSharingStatus(profile), enabled: desktop && profile.managed, retry: false });
  const dirty = initialized.current && !!status.data && (host !== status.data.host || port !== String(status.data.port) || keyAction !== 'keep');
  useEffect(() => { dirtyCallback.current(dirty); }, [dirty]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; dirtyCallback.current(false); }; }, []);
  useEffect(() => { if (status.data && (!initialized.current || !dirty) && !working.current) { initialized.current = true; setHost(status.data.host); setPort(String(status.data.port)); } }, [status.data?.configRevision]); // A remote refresh never discards a draft.
  const reset = () => { if (status.data) { setHost(status.data.host); setPort(String(status.data.port)); } setKeyAction('keep'); setServerKey(''); setReview(undefined); setFailure(''); setMessage(''); };
  const explain = (cause: unknown) => {
    const raw = core.normalizeError(cause).message;
    if (raw.includes('SHARING_KEY_REQUIRED')) return zh ? '局域网共享需要服务端密钥。请填写新密钥、保留现有密钥，或选择“明确不使用密钥”。' : 'LAN sharing needs a server key. Set a new key, keep an existing one, or choose “Serve without a key”.';
    if (raw.includes('SHARING_KEY_INVALID')) return zh ? '新密钥需为非空文本，不能包含换行或控制字符。' : 'A new key must be nonempty and contain no line breaks or control characters.';
    if (raw.includes('SHARING_PORT_INVALID')) return zh ? '端口需为 1–65535 的整数。' : 'The port must be an integer from 1 to 65535.';
    if (raw.includes('CONFIG_REVISION_CONFLICT')) return zh ? '配置已被其它操作修改，草稿已保留。请重新读取后预览并保存。' : 'Another operation changed the configuration. Your draft is retained; refresh, review and save again.';
    // Server errors may mention paths, but never show the user-entered server key.
    return serverKey ? raw.replaceAll(serverKey, '[REDACTED]') : raw;
  };
  const preview = () => {
    if (!status.data || working.current) return;
    setFailure(''); setMessage('');
    const request: SetServiceAuthRequest = { expectedRevision: status.data.configRevision, host, port: Number(port), keyAction, ...(keyAction === 'set' ? { serverKey } : {}) };
    try { setReview({ request, preview: core.buildSharingPreview(status.data, request) }); } catch (cause) { setFailure(explain(cause)); }
  };
  const save = async () => {
    if (!review || working.current) return;
    working.current = true; setBusy(true); setFailure('');
    try {
      const saved = await core.setServiceAuth(profile, review.request);
      if (!mounted.current) return;
      client.setQueryData(queryKey, saved.status); setHost(saved.status.host); setPort(String(saved.status.port)); setKeyAction('keep'); setServerKey(''); setReview(undefined);
      setMessage(saved.restartRequired ? (zh ? '配置已备份并保存。当前服务仍使用原设置；点击“重启使共享生效”才会重启。' : 'Configuration backed up and saved. The running service keeps its previous settings until you explicitly restart.') : (zh ? '配置已备份并保存。服务保持未启动，下次手动启动时生效。' : 'Configuration backed up and saved. The service stays stopped; changes apply on your next manual start.'));
      if (saved.clientCredentialNeedsUpdate) setMessage(previous => `${previous} ${zh ? '应用客户端密钥没有改变，请在上方另行更新。' : 'The app’s client access key did not change; update it separately above.'}`);
      onSaved();
    } catch (cause) { if (mounted.current) setFailure(explain(cause)); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  };
  const restart = async () => {
    if (working.current || dirty) return;
    working.current = true; setBusy(true); setFailure('');
    try {
      const current = await core.serviceStatus(profile.id, profile);
      if (!mounted.current) return;
      if (!current.running || !current.owned) throw new Error(zh ? '当前服务未启动或不属于本应用，未重启。' : 'The service is stopped or not owned by this app; no restart was sent.');
      await core.restartService(profile);
      if (!mounted.current) return;
      setMessage(zh ? '已请求重启。请等待模型就绪，再从另一台设备测试；跨设备连接尚未验证。' : 'Restart requested. Wait for readiness and test from another device; cross-device access remains unverified.');
      onSaved(); await status.refetch();
    } catch (cause) { if (mounted.current) setFailure(explain(cause)); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  };
  const copy = async (value: string) => { try { await navigator.clipboard.writeText(value); if (mounted.current) setCopied(true); } catch { if (mounted.current) setFailure(zh ? '复制失败，请手动选择地址。' : 'Copy failed; select the address manually.'); } };
  const data = status.data;
  let currentPreview: SharingPreview | undefined;
  if (data) { try { currentPreview = core.buildSharingPreview(data, { expectedRevision: data.configRevision, host: data.host, port: data.port, keyAction: 'keep' }); } catch { /* Existing unauthenticated LAN configs remain readable but are not recommended for client setup. */ } }
  const hosts = [...new Set(['127.0.0.1', '0.0.0.0', ...(data?.lanAddresses ?? []), ...(data ? [data.host] : [])])];
  return <section className="service-sharing-panel" aria-label={zh ? '局域网共享' : 'LAN sharing'}>
    <h3>{zh ? '局域网共享与服务端鉴权' : 'LAN sharing and server authentication'}</h3>
    <p className="subtle">{zh ? '允许同一局域网的设备调用本机 API。保存只修改受管配置并保留备份，不启动模型、不改防火墙。服务端密钥保护共享 API，与上方客户端密钥分别管理。' : 'Allow devices on your LAN to use this API. Saving backs up and edits only the managed configuration; it never starts a model or changes the firewall. Server and client keys are managed separately.'}</p>
    {!desktop ? <p className="notice">{zh ? '局域网设置需要桌面应用。' : 'LAN configuration requires the desktop app.'}</p> : !profile.managed ? <p className="notice">{zh ? '请先导入本机模型配置；未受管的服务不可在这里修改。' : 'Import the local configuration first. Unmanaged services cannot be edited here.'}</p> : data ? <>
      <div className="service-sharing-fields"><label className="field"><span>{zh ? '监听范围' : 'Listen address'}</span><Dropdown ariaLabel={zh ? '监听范围' : 'Listen address'} value={host} disabled={busy} onValueChange={value => { setHost(value); setMessage(''); setCopied(false); }} options={hosts.map(value => ({ value, label: value === '127.0.0.1' ? (zh ? '仅本机 · 127.0.0.1' : 'This computer · 127.0.0.1') : value === '0.0.0.0' ? (zh ? '所有 IPv4 接口 · 0.0.0.0' : 'All IPv4 interfaces · 0.0.0.0') : value }))}/></label><label className="field"><span>{zh ? '端口' : 'Port'}</span><input type="number" min={1} max={65535} value={port} disabled={busy} onChange={event => { setPort(event.target.value); setMessage(''); }} aria-label={zh ? '共享端口' : 'Sharing port'}/></label></div>
      <p className="subtle">{zh ? data.noKeyChosen ? '当前配置明确不使用服务端密钥（"api_key": "none"）。' : `服务端已配置 ${data.keyCount} 个密钥，密钥不会回显。保留现有设置不会将密钥数组改成单个密钥。` : data.noKeyChosen ? 'This configuration serves without a key on purpose ("api_key": "none").' : `${data.keyCount} server keys configured; values are never displayed. Keeping settings preserves existing key arrays.`}</p>
      <Segmented ariaLabel={zh ? '服务端密钥操作' : 'Server key action'} value={keyAction} onValueChange={value => { if (!busy) { setKeyAction(value as SetServiceAuthRequest['keyAction']); setServerKey(''); setMessage(''); } }} options={[{ value: 'keep', label: zh ? '保留' : 'Keep', disabled: busy }, { value: 'set', label: zh ? '设置单个新密钥' : 'Set one new key', disabled: busy }, { value: 'clear', label: zh ? '移除鉴权' : 'Remove authentication', disabled: busy }, { value: 'none', label: zh ? '明确不使用密钥' : 'Serve without a key', disabled: busy }]}/>
      {(keyAction === 'none' || (keyAction === 'keep' && data.noKeyChosen)) && <p className="notice warning" role="status">{zh ? '将写入 "api_key": "none"：明确不使用密钥（Strata 0.2.2 起支持；更早的版本会把 none 当成一个名为 none 的密钥）。局域网内任何能访问此端口的设备都可以使用模型' + (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' ? '，建议只在可信网络中这样做。' : '。') : 'Writes "api_key": "none": serve without a key on purpose (Strata 0.2.2 and newer; older versions treat none as a key named none). Anyone who can reach this port can use the model' + (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' ? '; only do this on a network you trust.' : '.')}</p>}
      {keyAction === 'set' && <label className="field"><span>{zh ? '新的服务端密钥' : 'New server key'}</span><input type="password" autoComplete="new-password" value={serverKey} disabled={busy} onChange={event => setServerKey(event.target.value)} aria-label={zh ? '新的服务端密钥' : 'New server key'}/></label>}
      <div className="actions"><button type="button" className="primary" disabled={busy || !dirty} onClick={preview}>{zh ? '预览变更' : 'Review changes'}</button><button type="button" disabled={busy || !dirty} onClick={reset}>{zh ? '取消草稿' : 'Discard draft'}</button><button type="button" disabled={busy || status.isFetching} onClick={() => void status.refetch()}>{zh ? '重新读取' : 'Refresh'}</button>{data.running && data.owned && data.restartRequired && <button type="button" disabled={busy || dirty} onClick={() => void restart()}>{zh ? '重启使共享生效' : 'Restart to apply'}</button>}</div>
      {(data.restartRequired || (data.running && dirty)) && <p className="subtle">{zh ? `当前运行监听：${data.liveHost ?? '未核验'}:${data.livePort ?? '未核验'}。保存配置与当前运行设置可能不同。` : `Live listener: ${data.liveHost ?? 'unverified'}:${data.livePort ?? 'unverified'}. Saved and running settings may differ.`}</p>}
      {currentPreview?.lan && <div className="service-sharing-addresses"><h4>{zh ? '客户端地址' : 'Client addresses'}</h4>{currentPreview.urls.length ? currentPreview.urls.map(url => <div key={url}><code>{url}</code><button type="button" onClick={() => void copy(url)}>{zh ? '复制地址' : 'Copy URL'}</button><button type="button" onClick={() => void copy(core.sharingClientExample(url))}>{zh ? '复制调用示例' : 'Copy example'}</button></div>) : <p className="subtle">{zh ? '未检测到与监听设置匹配的本机局域网地址。' : 'No assigned LAN address matches this listener.'}</p>}<p className="subtle">{zh ? '示例使用 STRATA_API_KEY 环境变量占位；请在客户端自行填写服务端密钥。地址来自本机网卡，跨设备连通性需实际验证。' : 'Examples use a STRATA_API_KEY environment placeholder. Enter the server key on your client. Addresses come from local interfaces; cross-device connectivity requires a real test.'}</p></div>}
    </> : <p role="status">{status.isPending ? (zh ? '正在读取共享设置…' : 'Reading sharing settings…') : (zh ? '共享设置不可用。' : 'Sharing settings unavailable.')}</p>}
    {copied && <p role="status">{zh ? '已复制。' : 'Copied.'}</p>}{message && <p className="notice" role="status">{message}</p>}{(failure || status.error) && <p className="notice error" role="alert">{failure || explain(status.error)}</p>}
    {review && data && <Dialog title={zh ? '确认局域网设置变更' : 'Review LAN changes'} onClose={() => { if (!busy) setReview(undefined); }}><div className="service-sharing-review"><p>{zh ? '以下更改将在同一次配置写入中保存，并保留原配置备份。' : 'These changes are saved atomically with a backup of the original configuration.'}</p><dl><dt>{zh ? '监听地址' : 'Listen address'}</dt><dd>{data.host} → {review.request.host}</dd><dt>{zh ? '端口' : 'Port'}</dt><dd>{data.port} → {review.request.port}</dd><dt>{zh ? '服务端鉴权' : 'Server authentication'}</dt><dd>{review.request.keyAction === 'none' ? (zh ? '明确不使用密钥（"api_key": "none"）' : 'Serve without a key ("api_key": "none")') : review.request.keyAction === 'keep' ? (data.noKeyChosen ? (zh ? '保持不使用密钥' : 'Keep serving without a key') : zh ? `保留 ${data.keyCount} 个现有密钥` : `Keep ${data.keyCount} existing keys`) : review.request.keyAction === 'set' ? (zh ? '替换为单个新密钥（不回显）' : 'Replace with one new key (hidden)') : (zh ? '移除服务端鉴权' : 'Remove server authentication')}</dd></dl><p>{data.running ? (zh ? '当前服务将继续运行，保存后仍需单独点击重启。' : 'The service keeps running; restart is a separate action after saving.') : (zh ? '当前服务保持未启动，下次手动启动时生效。' : 'The service remains stopped; changes apply on the next manual start.')}</p><p>{zh ? '客户端密钥不会随这次保存而改变。' : 'The client access key will not change with this save.'}</p>{failure && <p className="notice error" role="alert">{failure}</p>}<div className="actions"><button type="button" className="primary" disabled={busy} onClick={() => void save()}>{busy ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存配置' : 'Save configuration')}</button><button type="button" disabled={busy} onClick={() => setReview(undefined)}>{zh ? '返回编辑' : 'Back to editing'}</button></div></div></Dialog>}
  </section>;
}
