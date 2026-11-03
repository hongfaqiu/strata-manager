import type { AppLanguage } from '@strata-manager/core';
import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import * as core from '@strata-manager/core';
import { RuntimeSwitchDialog, installedRuntimeLabel, useInstalledRuntimes, useRuntimeSwitch } from './InstalledRuntimesPanel';

interface Props { language: AppLanguage; desktop: boolean; disabled?: boolean; onSwitchStarted?: () => void; onChooseVersion?: () => void }

/** Engine crash: switch back to the previous installed engine (local, no download), else open the version list. */
export function StartupEngineRollback({ language, desktop, disabled = false, onSwitchStarted, onChooseVersion }: Props) {
  const zh = core.legacyLanguage(language) === 'zh-CN';
  const inventory = useInstalledRuntimes(desktop, false);
  const releases = useQuery({ queryKey: ['runtime-release-versions'], queryFn: () => core.runtimeReleaseVersions(), enabled: desktop, staleTime: 6 * 60 * 60 * 1000, retry: false, refetchOnWindowFocus: false }).data?.versions ?? [];
  const switcher = useRuntimeSwitch(onSwitchStarted);
  const target = core.installedRollbackTarget(inventory.data, releases);
  const busy = disabled || !!inventory.data?.busy;
  if (!target && !onChooseVersion) return null;
  return <>
    <p>{zh ? '可能是新版引擎的问题，可回退到上一版引擎再试。' : 'This may be a problem in the new engine; you can fall back to the previous one and try again.'}</p>
    {target
      ? <button type="button" data-testid="startup-rollback-local" disabled={busy || !desktop} onClick={() => switcher.open(target)}><History size={14}/>{zh ? '回退到' : 'Fall back to'} {installedRuntimeLabel(target, releases, zh)}</button>
      : <button type="button" data-testid="startup-rollback-choose" disabled={busy} onClick={onChooseVersion}><History size={14}/>{zh ? '选择其他引擎版本' : 'Choose another engine version'}</button>}
    {switcher.target && <RuntimeSwitchDialog language={language} target={switcher.target} current={inventory.data?.runtimes.find(runtime => runtime.current)} releases={releases} busy={switcher.busy} error={switcher.error} onConfirm={() => void switcher.confirm()} onDismiss={switcher.dismiss}/>}
  </>;
}
