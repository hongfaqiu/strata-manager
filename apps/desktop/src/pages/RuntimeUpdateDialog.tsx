import { ArrowUpCircle, Copy, FolderOpen, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useQuery } from '@tanstack/react-query';
import * as core from '@strata-manager/core';
import type { DetectedRuntime, RuntimeDownloadPreferences, RuntimeUpdateInfo, RuntimeZipDownloadOptions } from '@strata-manager/core';
import { Dialog } from '../components';
import { Dropdown } from '../OfficialControls';
import { releaseNotes } from '../updateReleaseNotes';
import './runtime-update-dialog.css';

export interface RuntimeUpdateDialogProps {
  language: 'zh-CN' | 'en'; runtime: DetectedRuntime; release: RuntimeUpdateInfo;
  assetName?: string;
  initialDownload?: RuntimeZipDownloadOptions;
  initialPreferences?: RuntimeDownloadPreferences;
  onConfirm: (download?: RuntimeZipDownloadOptions, assetName?: string) => void; onDismiss: () => void;
  busy?: boolean; canConfirm?: boolean; error?: string;
}

type DownloadMode = 'official' | 'local' | 'mirror';
interface DownloadSelection { key: string; mode: DownloadMode; sourceId?: string; assetName: string; localArchivePath: string; downloadUrl: string; releaseVersion?: string }

function validMirrorUrl(value: string) {
  try { const url = new URL(value); return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !url.hash && url.pathname !== '/'; }
  catch { return false; }
}

export function RuntimeUpdateDialog({ language, runtime, release, assetName, initialDownload, initialPreferences, onConfirm, onDismiss, busy = false, canConfirm = true, error }: RuntimeUpdateDialogProps) {
  const zh = language === 'zh-CN';
  const notes = releaseNotes(release.notes);
  const version = release.latestVersion ?? release.supportedVersion;
  const releaseKey = JSON.stringify([version, release.sourceRevision, release.assets.map(asset => [asset.name, asset.sha256, asset.url])]);
  const automatic = useQuery({ queryKey: ['runtime-download-asset', runtime.installDir, releaseKey], queryFn: () => core.resolveRuntimeZipAsset(runtime.installDir), enabled: core.isDesktop() && !!release.assets.length, retry: false });
  const automaticAsset = automatic.isSuccess ? release.assets.find(asset => asset.name === automatic.data?.name && asset.url === automatic.data?.url && asset.sha256 === automatic.data?.sha256) : undefined;
  const initialMode: DownloadMode = initialPreferences?.mode ?? (initialDownload?.localArchivePath !== undefined ? 'local' : initialDownload?.downloadUrl !== undefined ? 'mirror' : 'official');
  const selectionKey = JSON.stringify([runtime.installDir, release.latestVersion, release.checkedAt, release.sourceRevision, release.assets.map(asset => [asset.name, asset.sha256, asset.url]), assetName, initialDownload?.localArchivePath, initialDownload?.downloadUrl, initialPreferences]);
  const initialSelection = (): DownloadSelection => {
    const fixedSource = initialMode === 'local' || initialMode === 'mirror' && !initialPreferences?.sourceId && !/\{(?:url|version|asset)\}/.test(initialPreferences?.mirrorUrl ?? '');
    const staleSource = !!initialPreferences && fixedSource && initialPreferences.releaseVersion !== version;
    return { key: selectionKey, mode: initialMode, sourceId: initialPreferences?.sourceId, assetName: initialPreferences ? initialPreferences.assetName ?? '' : release.assets.some(asset => asset.name === assetName) ? assetName! : '', localArchivePath: staleSource ? '' : initialPreferences?.localArchivePath ?? initialDownload?.localArchivePath ?? '', downloadUrl: staleSource ? '' : initialPreferences?.mirrorUrl ?? initialDownload?.downloadUrl ?? '', releaseVersion: staleSource ? version : initialPreferences?.releaseVersion ?? version };
  };
  const [savedSelection, setSelection] = useState(initialSelection);
  const selection = savedSelection.key === selectionKey ? savedSelection : initialSelection();
  const [browsing, setBrowsing] = useState(false), [downloadError, setDownloadError] = useState(''), [copied, setCopied] = useState('');
  const browsingRef = useRef(false), alive = useRef(false);
  const currentSelection = useRef(selection); currentSelection.current = selection;
  const currentState = useRef({ selectionKey, busy, canConfirm }); currentState.current = { selectionKey, busy, canConfirm };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setSelection(initialSelection()); setDownloadError(''); setCopied(''); }, [selectionKey]);
  const selectedAsset = selection.assetName ? release.assets.find(asset => asset.name === selection.assetName) : automaticAsset;
  const sourceValue = selection.mode === 'official' ? 'official' : selection.mode === 'local' ? 'local' : selection.sourceId || 'custom';
  const shownAssets = selectedAsset ? [selectedAsset] : release.assets;
  const inputsDisabled = busy || !canConfirm || browsing;
  const preferences: RuntimeDownloadPreferences = { mode: selection.mode, ...(selection.assetName ? { assetName: selection.assetName } : {}), releaseVersion: selection.releaseVersion, ...(selection.mode === 'local' ? { localArchivePath: selection.localArchivePath } : selection.mode === 'mirror' ? selection.sourceId ? { sourceId: selection.sourceId } : { mirrorUrl: selection.downloadUrl } : {}) };
  const resolved = core.resolveRuntimeDownloadPreferences(preferences, release, automaticAsset?.name);
  const sourceReady = !!selectedAsset && !resolved.requiresSelection;
  const savedSourceNeedsSelection = initialMode !== 'official' && selection.mode === initialMode && !sourceReady && (!!selectedAsset || automatic.isError || selection.mode === 'local' && !selection.localArchivePath || selection.mode === 'mirror' && !selection.sourceId && !selection.downloadUrl);
  const changeSelection = (changes: Partial<DownloadSelection>) => {
    if (inputsDisabled || currentState.current.busy || !currentState.current.canConfirm || currentSelection.current !== selection) return;
    setSelection({ ...selection, ...changes }); setDownloadError(''); setCopied('');
  };
  const chooseSource = (source: string) => changeSelection(source === 'official' ? { mode: 'official', sourceId: undefined } : source === 'local' ? { mode: 'local', sourceId: undefined } : source === 'custom' ? { mode: 'mirror', sourceId: undefined } : { mode: 'mirror', sourceId: source });
  const chooseAsset = (assetName: string) => changeSelection({ assetName, localArchivePath: '', ...(!/\{(?:url|version|asset)\}/.test(selection.downloadUrl) ? { downloadUrl: '' } : {}), releaseVersion: version });
  const browse = async () => {
    if (inputsDisabled || browsingRef.current || selection.mode !== 'local') return;
    const target = selectionKey;
    browsingRef.current = true; setBrowsing(true); setDownloadError('');
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const path = await open({ title: zh ? '选择已下载的 Strata 引擎 ZIP' : 'Choose a downloaded Strata engine ZIP', multiple: false, directory: false, filters: [{ name: 'ZIP', extensions: ['zip'] }] });
      if (alive.current && currentState.current.selectionKey === target && !currentState.current.busy && currentState.current.canConfirm && typeof path === 'string') setSelection(previous => previous.key === target ? { ...previous, localArchivePath: path, releaseVersion: version } : previous);
    } catch (failure) { if (alive.current && currentState.current.selectionKey === target) setDownloadError(core.normalizeError(failure).message); }
    finally { browsingRef.current = false; if (alive.current) setBrowsing(false); }
  };
  const copy = async (value: string, label: string) => {
    try { await navigator.clipboard.writeText(value); if (alive.current) { setCopied(label); setDownloadError(''); } }
    catch (failure) { if (alive.current) setDownloadError(core.normalizeError(failure).message); }
  };
  const services = useQuery({
    queryKey: ['runtime-update-services', runtime.installDir],
    queryFn: async () => {
      const profiles = (await core.localInstallations()).filter(item => core.configurationPathKey(item.installDir) === core.configurationPathKey(runtime.installDir));
      const statuses = await Promise.all(profiles.map(async profile => ({ profile, status: await core.serviceStatus(profile.id, profile) })));
      return statuses.filter(item => item.status.running);
    },
    enabled: core.isDesktop(), refetchInterval: busy ? false : 5000, retry: false,
  });
  const checkingServices = core.isDesktop() && !services.isSuccess;
  const willStop = !!services.data?.length;
  const confirming = useRef(false);
  useEffect(() => { if (!busy) confirming.current = false; }, [busy, error, release.checkedAt, runtime.installDir]);
  const confirm = () => {
    if (confirming.current || busy || !canConfirm || currentState.current.busy || !currentState.current.canConfirm || checkingServices || browsing || browsingRef.current || !sourceReady || currentState.current.selectionKey !== selectionKey || currentSelection.current !== selection) return;
    confirming.current = true;
    onConfirm(resolved.download, selectedAsset?.name || selection.assetName || undefined);
  };
  const dismiss = () => { if (!busy && !currentState.current.busy) onDismiss(); };
  return <Dialog title={zh ? '确认更新 Strata' : 'Confirm Strata update'} wide onClose={dismiss}>
    <div className="runtime-update-dialog">
      <p className="runtime-update-release-name">{release.releaseName || `Strata ${version}`}</p>
      <dl className="runtime-update-details"><div><dt>{zh ? '本机版本' : 'Installed version'}</dt><dd>{runtime.runtimeVersion ?? '—'}</dd></div><div><dt>{zh ? '更新至' : 'Update to'}</dt><dd>{version}</dd></div></dl>
      <code className="runtime-update-directory">{runtime.installDir}</code>
      <fieldset className="runtime-update-download" disabled={inputsDisabled}>
        <legend>{zh ? '引擎 ZIP 下载方式' : 'Engine ZIP source'}</legend>
        {savedSourceNeedsSelection && <p className="notice warning" role="status">{zh ? '已保存的下载来源需要重新选择，或改用官方下载。' : 'Reselect the saved source, or choose official downloading.'}</p>}
        <div className="runtime-update-source-options"><span>{zh ? '下载来源' : 'Download source'}</span><Dropdown ariaLabel={zh ? '引擎 ZIP 下载方式' : 'Engine ZIP source'} value={sourceValue} disabled={inputsDisabled} onValueChange={chooseSource} options={[{ value: 'official', label: zh ? '官方自动下载' : 'Official download' }, ...core.runtimeDownloadSources.map(source => ({ value: source.id, label: source.label })), { value: 'custom', label: zh ? '自定义 HTTPS' : 'Custom HTTPS' }, { value: 'local', label: zh ? '本地已下载 ZIP' : 'Downloaded ZIP' }]}/></div>
        <div className="runtime-update-asset-selector"><span>{zh ? '官方更新包' : 'Official update package'}</span><Dropdown ariaLabel={zh ? '官方更新包' : 'Official update package'} value={selection.assetName} disabled={inputsDisabled} onValueChange={chooseAsset} options={[{ value: '', label: zh ? '自动匹配当前引擎' : 'Match the current engine' }, ...release.assets.map(asset => ({ value: asset.name, label: asset.variant.toUpperCase() }))]}/></div>
        {!selection.assetName && <p className={automatic.isError || automatic.isSuccess && !automaticAsset ? 'runtime-update-validation' : 'runtime-update-download-hint'} role={automatic.isError || automatic.isSuccess && !automaticAsset ? 'alert' : 'status'}>{automaticAsset ? `${zh ? '自动匹配' : 'Auto matched'} · ${automaticAsset.variant.toUpperCase()}` : automatic.isError ? zh ? '自动匹配失败，请手动选择包。' : 'Automatic matching failed; select a package manually.' : automatic.isSuccess ? zh ? '包信息已变化，请检查更新或手动选择包。' : 'Package details changed; check for updates or select a package.' : zh ? '正在匹配当前引擎…' : 'Matching the current engine…'}</p>}
        {selection.mode === 'local' && <div className="runtime-update-local-file"><button type="button" onClick={() => void browse()}><FolderOpen size={14}/>{browsing ? zh ? '正在选择…' : 'Choosing…' : zh ? '选择 ZIP 文件' : 'Choose ZIP file'}</button><code>{selection.localArchivePath || (zh ? '尚未选择文件' : 'No file selected')}</code></div>}
        {selection.mode === 'mirror' && !selection.sourceId && <label className="runtime-update-mirror"><span>{zh ? '引擎 ZIP 下载地址' : 'Engine ZIP download URL'}</span><input className="st-input" type="url" aria-label={zh ? 'HTTPS 镜像地址' : 'HTTPS mirror URL'} placeholder="https://mirror.example.com/Strata-cuda12.zip" value={selection.downloadUrl} onChange={event => changeSelection({ downloadUrl: event.target.value, releaseVersion: version })}/>{selection.downloadUrl && selectedAsset && (!resolved.download.downloadUrl || !validMirrorUrl(resolved.download.downloadUrl)) && <span className="runtime-update-validation" role="alert">{zh ? '请填写有效的完整 HTTPS 地址或模板。' : 'Enter a valid complete HTTPS URL or template.'}</span>}</label>}
        <details className="runtime-update-package-details"><summary>{zh ? '包信息' : 'Package details'}</summary><div className="runtime-update-assets">{shownAssets.map(asset => <div className="runtime-update-asset" key={asset.name}><strong>{asset.variant.toUpperCase()} · {asset.name}</strong><span>{zh ? '大小' : 'Size'}: {(asset.size / 1024 / 1024).toFixed(1)} MiB · {asset.size.toLocaleString(language)} {zh ? '字节' : 'bytes'}</span><div className="runtime-update-download-value"><a href={asset.url} target="_blank" rel="noreferrer">{asset.url}</a><button type="button" aria-label={zh ? `复制下载链接 ${asset.name}` : `Copy download URL ${asset.name}`} onClick={() => void copy(asset.url, zh ? '下载链接已复制' : 'Download URL copied')}><Copy size={13}/>{zh ? '复制链接' : 'Copy URL'}</button></div><div className="runtime-update-download-value"><code>SHA256: {asset.sha256}</code><button type="button" aria-label={zh ? `复制 SHA256 ${asset.name}` : `Copy SHA256 ${asset.name}`} onClick={() => void copy(asset.sha256, zh ? 'SHA256 已复制' : 'SHA256 copied')}><Copy size={13}/>{zh ? '复制 SHA256' : 'Copy SHA256'}</button></div></div>)}</div></details>
        <details className="runtime-update-help"><summary>{zh ? '更多说明' : 'More information'}</summary><div className="runtime-update-help-body"><p>{zh ? '所有来源均按官方 SHA256 校验，不匹配会拒绝安装。' : 'Every source is verified against the official SHA256; mismatches are rejected.'}</p><p>{zh ? '本地 ZIP 只跳过引擎下载，同版本源码和发布信息仍需网络。' : 'A local ZIP skips the engine download; same-version source and release information still need network access.'}</p><p>{zh ? '选择文件不会停止服务，最终确认后才开始更新。' : 'Choosing a file leaves services running; final confirmation starts the update.'}</p></div></details>
      </fieldset>
      {copied && <p role="status" className="runtime-update-download-hint">{copied}</p>}
      {downloadError && <p className="notice error" role="alert">{downloadError}</p>}
      {willStop && <div className="notice warning runtime-update-service-warning" role="status"><strong>{zh ? '更新需要停止当前服务' : 'Updating requires stopping the current service'}</strong><p>{zh ? '确认后停止以下服务并更新 Strata，完成后恢复服务。正在进行的请求会中断。' : 'Confirm to stop the services below and update Strata. Services resume afterward. Active requests will be interrupted.'}</p>{services.data?.map(({ profile, status }) => <div key={profile.id}><strong>{profile.name}</strong> · PID {status.pid ?? '—'}<code className="runtime-update-directory">{profile.configPath}</code></div>)}</div>}
      {checkingServices && !services.error && <p role="status">{zh ? '正在检查当前服务…' : 'Checking running services…'}</p>}
      {services.error && <p className="notice error" role="alert">{core.normalizeError(services.error).message}</p>}
      <details className="runtime-update-release-details"><summary>{zh ? '更新日志' : 'Release notes'}</summary><div className="runtime-update-notes" role="region" aria-label={zh ? '更新日志' : 'Release notes'} tabIndex={0}>
        {notes ? <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ node: _node, title, children, ...props }) => <a {...props} data-tooltip={title} target="_blank" rel="noreferrer">{children}</a>, img: ({ node: _node, title, ...props }) => <img {...props} data-tooltip={title}/> }}>{notes}</ReactMarkdown> : <p>{zh ? '此 Release 暂无更新日志。' : 'This release has no release notes.'}</p>}
      </div></details>
      {!canConfirm && !busy && <p className="runtime-update-waiting" role="status">{zh ? '当前正在处理请求或任务，空闲后可确认更新。' : 'Requests or tasks are in progress. You can confirm the update when they finish.'}</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="runtime-update-dialog-actions"><button type="button" disabled={busy} onClick={dismiss}>{zh ? '暂不更新' : 'Not now'}</button><button type="button" className="primary" disabled={busy || !canConfirm || checkingServices || browsing || !sourceReady} onClick={confirm}>{busy ? <LoaderCircle size={15} className="spin"/> : <ArrowUpCircle size={15}/>} {busy ? zh ? '正在开始更新…' : 'Starting update…' : willStop ? zh ? '停止服务并更新' : 'Stop services and update' : zh ? '确认更新' : 'Confirm update'}</button></div>
    </div>
  </Dialog>;
}
