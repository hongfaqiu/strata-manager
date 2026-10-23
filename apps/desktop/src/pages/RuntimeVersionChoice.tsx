// Install a chosen Strata version (up or down) and pin the installed one so newer releases
// stop prompting. Strings: zh-CN and English; other locales use English.
import type { AppLanguage } from '@strata-manager/core';
import * as core from '@strata-manager/core';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { History, LoaderCircle, RefreshCw } from 'lucide-react';
import { Checkbox, Dropdown } from '../OfficialControls';

const zh = {
  title: '安装指定版本', hint: '可以升级或降级到任一官方版本；安装同样核对官方签名和 SHA256，并先试启动，失败会自动恢复当前版本。',
  choose: '选择版本', loading: '正在读取版本列表…', refresh: '刷新版本列表',
  current: '当前', latest: '最新', engine: '引擎', prerelease: '预发布', unavailable: '本平台无安装包',
  upgrade: '升级到此版本', downgrade: '降级到此版本', reinstall: '重新安装此版本', opening: '正在读取发布信息…',
  pin: '固定在 {{version}}，不再提示更新', pinned: '已固定在 {{version}}', pinHint: '有更新的版本发布时不再弹出提示，也不显示「更新至」按钮；仍可在这里手动安装任意版本。',
  pinOther: '当前固定在 {{pin}}；本机是 {{version}}。',
  local: '已安装·无需下载', switchLocal: '切换到此版本（无需下载）',
};
const en: typeof zh = {
  title: 'Install a specific version', hint: 'Upgrade or downgrade to any official release. It is verified against the official signature and SHA256 and trial-started first; if that fails the current version is restored.',
  choose: 'Choose version', loading: 'Loading versions…', refresh: 'Refresh version list',
  current: 'current', latest: 'latest', engine: 'engine', prerelease: 'pre-release', unavailable: 'no package for this platform',
  upgrade: 'Upgrade to this version', downgrade: 'Downgrade to this version', reinstall: 'Reinstall this version', opening: 'Loading release…',
  pin: 'Stay on {{version}} and stop update prompts', pinned: 'Pinned to {{version}}', pinHint: 'Newer releases no longer prompt or show an “Update to” button; you can still install any version here.',
  pinOther: 'Pinned to {{pin}}; this machine runs {{version}}.',
  local: 'installed · no download', switchLocal: 'Switch to this version (no download)',
};
const fill = (text: string, values: Record<string, string>) => text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '');
export const runtimeVersionCopy = (language: AppLanguage) => core.legacyLanguage(language) === 'zh-CN' ? zh : en;

export function useRuntimePin(desktop: boolean) {
  return useQuery({ queryKey: ['runtime-pin'], queryFn: core.getRuntimePin, enabled: desktop, staleTime: Infinity, retry: false });
}

export interface RuntimeVersionChoiceProps {
  language: AppLanguage; desktop: boolean;
  /** Release versions (v0.2.2), not engine builds; the engines are shown beside them. */
  currentVersion?: string; latestVersion?: string; currentEngine?: string; latestEngine?: string;
  /** Installed runtimes, to read an older pin saved as an engine number. */
  runtimes?: core.RuntimeVersionFacts[];
  /** Releases already installed on this machine (not the current one): chosen ones switch locally. */
  localVersions?: string[];
  disabled?: boolean; opening?: string; onChoose: (version: string) => void;
}

export function RuntimeVersionChoice({ language, desktop, currentVersion, latestVersion, currentEngine, latestEngine, runtimes = [], localVersions = [], disabled = false, opening, onChoose }: RuntimeVersionChoiceProps) {
  const t = runtimeVersionCopy(language); const query = useQueryClient();
  const versions = useQuery({ queryKey: ['runtime-release-versions'], queryFn: () => core.runtimeReleaseVersions(), enabled: desktop, staleTime: 6 * 60 * 60 * 1000, retry: false, refetchOnWindowFocus: false });
  const pin = useRuntimePin(desktop);
  const [chosen, setChosen] = useState(''), [refreshing, setRefreshing] = useState(false), [pinError, setPinError] = useState('');
  const list = versions.data?.versions ?? [];
  const same = (a?: string, b?: string) => !!a && !!b && core.compareReleaseVersions(a, b) === 0 && a.replace(/^v/, '') === b.replace(/^v/, '');
  const local = (version?: string) => !!version && localVersions.some(item => core.compareReleaseVersions(item, version) === 0);
  const usable = (item: core.RuntimeReleaseVersion) => item.installable || local(item.version);
  const selected = chosen || list.find(item => !same(item.version, currentVersion) && usable(item))?.version || '';
  const direction = selected ? core.runtimeVersionDirection(currentVersion, selected) : 'unknown';
  const engineOf = (item: core.RuntimeReleaseVersion) => item.engineVersion ?? (same(item.version, latestVersion) ? latestEngine : same(item.version, currentVersion) ? currentEngine : undefined);
  const label = (item: core.RuntimeReleaseVersion) => [`v${item.version.replace(/^v/, '')}`, engineOf(item) && `${t.engine} ${engineOf(item)}`, same(item.version, currentVersion) && t.current, same(item.version, latestVersion) && t.latest, local(item.version) && t.local, item.prerelease && t.prerelease, !usable(item) && t.unavailable].filter(Boolean).join(' · ');
  const refresh = async () => {
    setRefreshing(true);
    try { query.setQueryData(['runtime-release-versions'], await core.runtimeReleaseVersions(true)); }
    catch { await versions.refetch(); }
    finally { setRefreshing(false); }
  };
  const setPin = async (version: string | null) => {
    setPinError('');
    try { await core.setRuntimePin(version); query.setQueryData(['runtime-pin'], version ?? ''); }
    catch (error) { setPinError(core.normalizeError(error).message); }
  };
  const pinned = core.runtimePinRelease(pin.data, runtimes, list) ?? '';
  const v = (version: string) => `v${version.replace(/^v/, '')}`;
  const error = versions.error ? core.normalizeError(versions.error).message : versions.data?.error;
  return <section className="runtime-version-choice" data-testid="runtime-version-choice" aria-label={t.title}>
    <div className="runtime-version-choice-head"><History size={15} aria-hidden="true"/><strong>{t.title}</strong></div>
    <p className="runtime-version-choice-hint">{t.hint}</p>
    <div className="runtime-version-choice-row">
      <Dropdown ariaLabel={t.choose} value={selected} disabled={!desktop || !list.length || disabled} placeholder={versions.isPending ? t.loading : t.choose}
        options={list.map(item => ({ value: item.version, label: label(item), disabled: !usable(item) }))} onValueChange={setChosen}/>
      <button type="button" disabled={!desktop || disabled || !selected || !!opening || !list.some(item => item.version === selected && usable(item))} onClick={() => onChoose(selected)}>
        {opening === selected ? <><LoaderCircle size={14} className="spin"/>{t.opening}</> : local(selected) ? t.switchLocal : direction === 'downgrade' ? t.downgrade : direction === 'same' ? t.reinstall : t.upgrade}
      </button>
      <button type="button" className="icon-button" aria-label={t.refresh} data-tooltip={t.refresh} disabled={!desktop || refreshing || versions.isFetching} onClick={() => void refresh()}>{refreshing || versions.isFetching ? <LoaderCircle size={15} className="spin"/> : <RefreshCw size={15}/>}</button>
    </div>
    {error && <p className="notice warning" role="status">{core.runtimeBilingualText(error, core.legacyLanguage(language) === 'zh-CN')}</p>}
    {currentVersion && <label className="runtime-pin">
      <Checkbox checked={!!pinned} disabled={!desktop || pin.isPending} onChange={event => void setPin(event.target.checked ? currentVersion : null)}/>
      <span><strong>{pinned ? fill(t.pinned, { version: v(pinned) }) : fill(t.pin, { version: v(currentVersion) })}</strong><small>{pinned && !same(pinned, currentVersion) ? `${fill(t.pinOther, { pin: v(pinned), version: v(currentVersion) })} ` : ''}{t.pinHint}</small></span>
    </label>}
    {pinError && <p className="notice error" role="alert">{pinError}</p>}
  </section>;
}
