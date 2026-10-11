import { Copy, FlaskConical, FolderOpen, LoaderCircle, Save } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as core from '@strata-manager/core';
import { Dropdown } from '../OfficialControls';
import './runtime-download-settings.css';

interface Props { language: 'zh-CN' | 'en'; desktop: boolean; release?: core.RuntimeUpdateInfo; releaseLoading?: boolean; runtime?: core.DetectedRuntime }
const preferencesKey = ['runtime-download-preferences'];
const hasTemplate = (value?: string) => /\{(?:url|version|asset)\}/.test(value ?? '');

export function RuntimeDownloadSettings({ language, desktop, release, releaseLoading = false, runtime }: Props) {
  const zh = language === 'zh-CN', query = useQueryClient();
  const preferences = useQuery({ queryKey: preferencesKey, queryFn: core.getRuntimeDownloadPreferences, enabled: desktop, retry: false });
  const version = release?.latestVersion ?? release?.supportedVersion;
  const assetReleaseKey = JSON.stringify([version, release?.sourceRevision, release?.assets.map(asset => [asset.name, asset.sha256, asset.url])]);
  const releaseKey = JSON.stringify([runtime?.installDir, assetReleaseKey]);
  const automatic = useQuery({ queryKey: ['runtime-download-asset', runtime?.installDir, assetReleaseKey], queryFn: () => core.resolveRuntimeZipAsset(runtime!.installDir), enabled: desktop && !!runtime && !!release?.assets.length, retry: false });
  const automaticAsset = automatic.isSuccess ? release?.assets.find(asset => asset.name === automatic.data?.name && asset.url === automatic.data?.url && asset.sha256 === automatic.data?.sha256) : undefined;
  const [draft, setDraft] = useState<{ key: string; value: core.RuntimeDownloadPreferences } | null>(null);
  const [saving, setSaving] = useState(false), [testing, setTesting] = useState(false), [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [result, setResult] = useState<core.RuntimeZipDownloadCheckResult | null>(null);
  const operation = useRef(false), alive = useRef(false), currentRelease = useRef(releaseKey); currentRelease.current = releaseKey;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setResult(null); setError(''); setMessage(''); }, [releaseKey]);
  let savedRequiresSelection = false;
  let preferenceProblem = '';
  if (release && preferences.data) {
    try { savedRequiresSelection = core.resolveRuntimeDownloadPreferences(preferences.data, release, automaticAsset?.name).requiresSelection && (!!preferences.data.assetName || !!automaticAsset || automatic.isError || !runtime); }
    catch (failure) { preferenceProblem = core.normalizeError(failure).message; }
  }
  const initialDraft = (): core.RuntimeDownloadPreferences => {
    const saved = preferences.data ?? { mode: 'official' as const };
    const fixedSource = saved.mode === 'local' || saved.mode === 'mirror' && !saved.sourceId && !hasTemplate(saved.mirrorUrl);
    if (!release || !fixedSource || saved.releaseVersion === version) return { ...saved };
    return { ...saved, releaseVersion: version, ...(saved.mode === 'local' ? { localArchivePath: '' } : { mirrorUrl: '' }) };
  };
  const selection = draft?.key === releaseKey ? draft.value : initialDraft();
  const selectedAsset = selection.assetName ? release?.assets.find(asset => asset.name === selection.assetName) : automaticAsset;
  const sourceValue = selection.mode === 'official' ? 'official' : selection.mode === 'local' ? 'local' : selection.sourceId || 'custom';
  const shownAssets = selectedAsset ? [selectedAsset] : release?.assets ?? [];
  const busy = saving || testing || browsing;
  const disabled = !desktop || preferences.isPending || busy;
  const candidate: core.RuntimeDownloadPreferences = selection.mode === 'official'
    ? { mode: 'official', ...(selection.assetName ? { assetName: selection.assetName } : {}) }
    : { mode: selection.mode, ...(selection.assetName ? { assetName: selection.assetName } : {}), releaseVersion: version, ...(selection.mode === 'local' ? { localArchivePath: selection.localArchivePath?.trim() } : selection.sourceId ? { sourceId: selection.sourceId } : { mirrorUrl: selection.mirrorUrl?.trim() }) };
  let resolved: ReturnType<typeof core.resolveRuntimeDownloadPreferences> | undefined;
  let validation = '';
  if (release) {
    try { resolved = core.resolveRuntimeDownloadPreferences(candidate, release, automaticAsset?.name); }
    catch (failure) { validation = core.normalizeError(failure).message; }
  }
  if (!validation && selection.mode === 'mirror' && selectedAsset && candidate.mirrorUrl && resolved?.requiresSelection) validation = zh ? '请填写无账号密码或片段的完整 HTTPS 下载地址，模板仅支持 {url}、{version}、{asset}。' : 'Enter a complete HTTPS download URL without credentials or a fragment. Templates support only {url}, {version} and {asset}.';
  const sourceReady = selection.mode === 'official' && (!selection.assetName || !!selectedAsset) || !!resolved && !resolved.requiresSelection && !!selectedAsset;
  const canSave = !disabled && !preferences.error && sourceReady && (selection.mode === 'official' || !!release);
  const canTest = !disabled && !preferences.error && sourceReady && !!selectedAsset && !!resolved;
  const change = (patch: Partial<core.RuntimeDownloadPreferences>) => {
    if (disabled || operation.current || currentRelease.current !== releaseKey) return;
    setDraft({ key: releaseKey, value: { ...selection, ...patch } }); setResult(null); setError(''); setMessage('');
  };
  const chooseAsset = (assetName: string) => change({ assetName: assetName || undefined, localArchivePath: '', ...(!hasTemplate(selection.mirrorUrl) ? { mirrorUrl: '' } : {}) });
  const chooseSource = (source: string) => change(source === 'official' ? { mode: 'official', sourceId: undefined } : source === 'local' ? { mode: 'local', sourceId: undefined } : source === 'custom' ? { mode: 'mirror', sourceId: undefined } : { mode: 'mirror', sourceId: source });
  const browse = async () => {
    if (disabled || operation.current || currentRelease.current !== releaseKey || selection.mode !== 'local') return;
    const target = releaseKey; operation.current = true; setBrowsing(true); setError(''); setMessage('');
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const path = await open({ title: zh ? '选择已下载的 Strata 引擎 ZIP' : 'Choose a downloaded Strata engine ZIP', multiple: false, directory: false, filters: [{ name: 'ZIP', extensions: ['zip'] }] });
      if (alive.current && currentRelease.current === target && typeof path === 'string') { setDraft({ key: target, value: { ...selection, localArchivePath: path } }); setResult(null); }
    } catch (failure) { if (alive.current && currentRelease.current === target) setError(core.normalizeError(failure).message); }
    finally { operation.current = false; if (alive.current) setBrowsing(false); }
  };
  const save = async (reset = false) => {
    if (operation.current || currentRelease.current !== releaseKey || !desktop || (!reset && !canSave)) return;
    const target = releaseKey, value: core.RuntimeDownloadPreferences = reset ? { mode: 'official' } : candidate;
    operation.current = true; setSaving(true); setError(''); setMessage('');
    try {
      await core.saveRuntimeDownloadPreferences(value);
      query.setQueryData(preferencesKey, value);
      if (alive.current && currentRelease.current === target) { setDraft(null); setResult(null); setMessage(zh ? reset ? '已恢复官方下载。' : '下载设置已保存。' : reset ? 'Official download restored.' : 'Download settings saved.'); }
    } catch (failure) { if (alive.current && currentRelease.current === target) setError(core.normalizeError(failure).message); }
    finally { operation.current = false; if (alive.current) setSaving(false); }
  };
  const testSource = async () => {
    if (operation.current || currentRelease.current !== releaseKey || !canTest || !selectedAsset || !resolved) return;
    const target = releaseKey; operation.current = true; setTesting(true); setResult(null); setError(''); setMessage('');
    try {
      const checked = await core.testRuntimeZipDownload(selectedAsset.name, resolved.download);
      if (alive.current && currentRelease.current === target) setResult(checked);
    } catch (failure) { if (alive.current && currentRelease.current === target) setError(`${zh ? '下载测试失败：' : 'Download test failed: '}${core.normalizeError(failure).message}`); }
    finally { operation.current = false; if (alive.current) setTesting(false); }
  };
  const copy = async (value: string, label: string) => {
    try { await navigator.clipboard.writeText(value); if (alive.current) setMessage(label); }
    catch { if (alive.current) setError(zh ? '无法自动复制，请选中内容手动复制。' : 'Automatic copying is unavailable. Select and copy the text manually.'); }
  };
  const savedMode = preferences.data?.mode ?? 'official';
  const modeSummary = savedMode === 'local' ? zh ? '本地 ZIP' : 'Local ZIP' : savedMode === 'mirror' ? core.runtimeDownloadSources.find(source => source.id === preferences.data?.sourceId)?.label ?? (zh ? '自定义' : 'Custom') : zh ? '官方' : 'Official';
  const summary = preferences.error || preferenceProblem ? zh ? '读取失败' : 'Read failed' : preferences.isPending && desktop ? zh ? '读取中…' : 'Loading…' : `${modeSummary}${savedRequiresSelection ? zh ? ' · 需重选' : ' · Reselect' : ''}`;
  return <section className="runtime-download-settings" aria-label={zh ? '下载设置与测试' : 'Download settings and test'}>
    <details className="runtime-download-settings-details">
      <summary><strong>{zh ? '下载设置与测试' : 'Download settings and test'}</strong><span className={savedRequiresSelection || preferences.error ? 'runtime-download-settings-summary-warning' : ''}>{summary}</span></summary>
      <div className="runtime-download-settings-body">
        {preferences.isPending && desktop && <p role="status">{zh ? '正在读取下载设置…' : 'Loading download settings…'}</p>}
        {!desktop && <p role="status">{zh ? '请在桌面应用中设置。' : 'Open the desktop app to configure downloads.'}</p>}
        {preferences.error && <div className="notice error" role="alert"><p>{zh ? '设置读取失败，请重试或恢复官方下载。' : 'Settings could not be read; retry or restore official downloading.'}</p><p>{core.normalizeError(preferences.error).message}</p><button type="button" disabled={busy} onClick={() => void preferences.refetch()}>{zh ? '重新读取下载设置' : 'Reload download settings'}</button></div>}
        {preferenceProblem && <p className="notice error" role="alert">{zh ? '设置无效，请重新设置或恢复官方下载：' : 'Invalid settings; reconfigure or restore official downloading: '}{preferenceProblem}</p>}
        {savedRequiresSelection && draft?.key !== releaseKey && <p className="notice warning" role="status">{zh ? '下载来源已过期，请选择当前包和来源后保存。' : 'The source is outdated; select the current package and source, then save.'}</p>}
        <fieldset disabled={disabled || !!preferences.error}>
          <legend>{zh ? '下载方式' : 'Download source'}</legend>
          <div className="runtime-download-settings-field"><span>{zh ? '下载来源' : 'Download source'}</span><Dropdown ariaLabel={zh ? '下载方式' : 'Download source'} value={sourceValue} disabled={disabled || !!preferences.error} onValueChange={chooseSource} options={[{ value: 'official', label: zh ? '官方自动下载' : 'Official download' }, ...core.runtimeDownloadSources.map(source => ({ value: source.id, label: source.label })), { value: 'custom', label: zh ? '自定义 HTTPS' : 'Custom HTTPS' }, { value: 'local', label: zh ? '本地已下载 ZIP' : 'Downloaded ZIP' }]}/></div>
          <div className="runtime-download-settings-field"><span>{zh ? '官方更新包' : 'Official update package'}</span><Dropdown ariaLabel={zh ? '下载设置官方包' : 'Download settings official package'} value={selection.assetName ?? ''} disabled={disabled || !!preferences.error} onValueChange={chooseAsset} options={[{ value: '', label: zh ? '自动匹配当前引擎' : 'Match the current engine' }, ...(release?.assets ?? []).map(asset => ({ value: asset.name, label: asset.variant.toUpperCase() }))]}/></div>
          {!selection.assetName && <p className={automatic.isError || automatic.isSuccess && !automaticAsset ? 'runtime-download-settings-validation' : 'runtime-download-settings-hint'} role={automatic.isError || automatic.isSuccess && !automaticAsset ? 'alert' : 'status'}>{automaticAsset ? `${zh ? '自动匹配' : 'Auto matched'} · ${automaticAsset.variant.toUpperCase()}` : automatic.isError ? zh ? '自动匹配失败，请手动选择包。' : 'Automatic matching failed; select a package manually.' : automatic.isSuccess ? zh ? '包信息已变化，请检查更新或手动选择包。' : 'Package details changed; check for updates or select a package.' : runtime && release?.assets.length ? zh ? '正在匹配当前引擎…' : 'Matching the current engine…' : zh ? '可手动选择更新包。' : 'Select a package manually.'}</p>}
          {!release && <p role="status" className="runtime-download-settings-hint">{releaseLoading ? zh ? '正在读取发布信息…' : 'Loading release information…' : zh ? '请先检查更新。' : 'Check for updates first.'}</p>}
          {!!release && !release.assets.length && <p className="runtime-download-settings-hint">{zh ? '当前平台暂无引擎 ZIP。' : 'No engine ZIP is available for this platform.'}</p>}
          {selection.mode === 'local' && <div className="runtime-download-settings-file"><button type="button" onClick={() => void browse()}><FolderOpen size={14}/>{browsing ? zh ? '正在选择…' : 'Choosing…' : zh ? '选择 ZIP 文件' : 'Choose ZIP file'}</button><code>{selection.localArchivePath || (zh ? '尚未选择文件' : 'No file selected')}</code></div>}
          {selection.mode === 'mirror' && !selection.sourceId && <label className="runtime-download-settings-field"><span>{zh ? '镜像地址或模板' : 'Mirror URL or template'}</span><input className="st-input" type="text" aria-label={zh ? '镜像地址或模板' : 'Mirror URL or template'} placeholder="https://mirror.example.com/{version}/{asset}" value={selection.mirrorUrl ?? ''} onChange={event => change({ mirrorUrl: event.target.value })}/></label>}
          {validation && selection.mode === 'mirror' && selection.mirrorUrl && <p className="runtime-download-settings-validation" role="alert">{validation}</p>}
          {!!shownAssets.length && <details className="runtime-download-settings-package-details"><summary>{zh ? '包信息' : 'Package details'}</summary><div className="runtime-download-settings-assets">{shownAssets.map(asset => <div className="runtime-download-settings-asset" key={asset.name}><strong>{asset.variant.toUpperCase()} · {asset.name}</strong><span>{zh ? '大小' : 'Size'}: {(asset.size / 1024 / 1024).toFixed(1)} MiB · {asset.size.toLocaleString(language)} {zh ? '字节' : 'bytes'}</span><div className="runtime-download-settings-value"><a href={asset.url} target="_blank" rel="noreferrer">{asset.url}</a><button type="button" aria-label={zh ? `下载设置复制链接 ${asset.name}` : `Settings copy URL ${asset.name}`} onClick={() => void copy(asset.url, zh ? '下载链接已复制。' : 'Download URL copied.')}><Copy size={13}/>{zh ? '复制链接' : 'Copy URL'}</button></div><div className="runtime-download-settings-value"><code>SHA256: {asset.sha256}</code><button type="button" aria-label={zh ? `下载设置复制 SHA256 ${asset.name}` : `Settings copy SHA256 ${asset.name}`} onClick={() => void copy(asset.sha256, zh ? 'SHA256 已复制。' : 'SHA256 copied.')}><Copy size={13}/>{zh ? '复制 SHA256' : 'Copy SHA256'}</button></div></div>)}</div></details>}
          <details className="runtime-download-settings-help"><summary>{zh ? '更多说明' : 'More information'}</summary><div className="runtime-download-settings-help-body">
            <p>{zh ? '测试不会创建更新任务或停止服务，已是最新版本时也可测试。' : 'Tests do not create update tasks or stop services, including when Strata is up to date.'}</p>
            <p>{zh ? '所有方式使用官方 SHA256，不能自填校验值。' : 'Every source uses the official SHA256, with no custom checksum.'}</p>
            <p>{zh ? '本地 ZIP 只省去引擎下载，源码和发布信息仍需网络。' : 'A local ZIP skips the engine download; source and release information still need network access.'}</p>
            {selection.mode === 'mirror' && <>{!selection.sourceId && <><p>{zh ? '模板支持 {url}（完整官方链接）、{version}（版本）、{asset}（文件名），版本和文件名会编码。' : 'Templates support {url} (full official URL), {version} and {asset}, with version and filename encoded.'}</p><p>{zh ? '模板可复用于后续版本的同名包，固定地址仅用于当前版本。' : 'Templates can track later releases with the same package name; fixed URLs apply to this release.'}</p></>}{resolved?.download.downloadUrl && <code className="runtime-download-settings-resolved">{zh ? '本次地址：' : 'Resolved URL: '}{resolved.download.downloadUrl}</code>}</>}
          </div></details>
        </fieldset>
        <div className="runtime-download-settings-actions"><button type="button" className="primary" aria-label={zh ? '保存下载设置' : 'Save download settings'} disabled={!canSave} onClick={() => void save()}>{saving ? <LoaderCircle size={14} className="spin"/> : <Save size={14}/>} {zh ? '保存设置' : 'Save settings'}</button><button type="button" aria-label={zh ? '测试下载来源' : 'Test download source'} disabled={!canTest} onClick={() => void testSource()}>{testing ? <LoaderCircle size={14} className="spin"/> : <FlaskConical size={14}/>} {testing ? zh ? '正在测试…' : 'Testing…' : zh ? '测试' : 'Test'}</button><button type="button" className="runtime-download-settings-reset" aria-label={zh ? '恢复官方自动下载' : 'Restore official download'} disabled={!desktop || busy || preferences.isPending} onClick={() => void save(true)}>{zh ? '恢复官方' : 'Restore official'}</button></div>
        {message && <p role="status" className="runtime-download-settings-hint">{message}</p>}
        {error && <p className="notice error" role="alert">{error}</p>}
        {result && <div className="runtime-download-settings-result" role="status"><strong>{result.sha256Verified ? zh ? '文件校验通过' : 'File verified' : zh ? `连接正常${result.rangeSupported != null ? result.rangeSupported ? ' · 支持续传' : ' · 不支持续传' : ''}` : `Connected${result.rangeSupported != null ? result.rangeSupported ? ' · Resume supported' : ' · Resume unavailable' : ''}`}</strong>{!result.sha256Verified && <p>{zh ? '最多 64 KiB 样本，安装时完整校验。' : 'Up to 64 KiB sampled; full verification during installation.'}</p>}<details className="runtime-download-settings-check-details"><summary>{zh ? '测试详情' : 'Test details'}</summary><p>{result.sha256Verified ? zh ? '本地完整 SHA256 校验通过。' : 'Full local SHA256 verification passed.' : zh ? '仅验证网络样本，完整文件 SHA256 尚未验证。' : 'Only a network sample was checked; the full file SHA256 remains unverified.'}</p><p>{zh ? '已读取' : 'Read'} {result.checkedBytes.toLocaleString(language)} {zh ? '字节' : 'bytes'}{result.totalBytes != null ? ` / ${result.totalBytes.toLocaleString(language)} ${zh ? '字节' : 'bytes'}` : ''}</p>{result.rangeSupported != null && <p>{zh ? '断点续传（Range）' : 'Resume support (Range)'}: {result.rangeSupported ? zh ? '支持' : 'Supported' : zh ? '服务器未提供支持' : 'Not supported by this server'}</p>}</details></div>}
      </div>
    </details>
  </section>;
}
