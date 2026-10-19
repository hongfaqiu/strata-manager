import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, FolderOpen, Minus } from 'lucide-react';
import * as core from '@strata-manager/core';
import { Segmented } from '../OfficialControls';

export type LocalArchiveKey = keyof core.LocalRuntimeArchives;

/**
 * Local Strata/engine ZIP choice shared by the setup guide and the Strata page (#46, #74).
 * Both hand the result to `prepareLocalRuntime`, so validation and installation are identical.
 */
export function useLocalRuntimePackages(windows: boolean, dialogTitle: (key: LocalArchiveKey) => string) {
  // Downloading stays the default; already-downloaded packages are an explicit choice.
  const [source, setSourceState] = useState<core.RuntimePackageSource>('download');
  const [archives, setArchives] = useState<core.LocalRuntimeArchives>({});
  const [pickError, setPickError] = useState('');
  const [picking, setPicking] = useState(false);
  const selection = core.localRuntimePackageSelection(source, archives, windows);
  const setSource = (value: core.RuntimePackageSource) => { setSourceState(value); setPickError(''); };
  const pick = async (key: LocalArchiveKey) => {
    if (picking) return;
    setPicking(true); setPickError('');
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const path = await open({ title: dialogTitle(key), multiple: false, directory: false, filters: [{ name: 'ZIP', extensions: ['zip'] }] });
      if (typeof path === 'string') setArchives(previous => ({ ...previous, [key]: path }));
    } catch (error) { setPickError(core.normalizeError(error).message); } finally { setPicking(false); }
  };
  const clear = (key: LocalArchiveKey) => setArchives(previous => ({ ...previous, [key]: undefined }));
  return { source, setSource, archives, pick, clear, picking, pickError, windows, chosen: selection.chosen, missing: selection.missing };
}

export type LocalRuntimePackages = ReturnType<typeof useLocalRuntimePackages>;

/** Strata page version of the guide's "使用已下载的安装包" fields, with the same strings and hints. */
export function LocalRuntimePackageFields({ packages, disabled = false }: { packages: LocalRuntimePackages; disabled?: boolean }) {
  const { t: translate } = useTranslation();
  const t = (key: string) => String(translate(key));
  const { source, archives, windows } = packages;
  const row = (key: LocalArchiveKey, label: string) => <div className="local-package-row" key={key}>
    <span className={`local-package-mark${archives[key] ? ' is-chosen' : ''}`} aria-hidden="true">{archives[key] ? <Check size={12}/> : <Minus size={12}/>}</span>
    <span className="local-package-label">{label}</span>
    <span className="local-package-value">{archives[key] ? <code data-testid={`local-package-${key}`}>{archives[key]}</code> : <small>{t('obNotChosen')}</small>}</span>
    <span className="local-package-actions">
      <button type="button" disabled={disabled || packages.picking} onClick={() => void packages.pick(key)}><FolderOpen size={14}/>{t('obChooseFile')}</button>
      {archives[key] && <button type="button" className="text-button" disabled={disabled || packages.picking} onClick={() => packages.clear(key)}>{t('obClearFile')}</button>}
    </span>
  </div>;
  return <div className="local-package" data-testid="local-runtime-package">
    <div className="local-package-source"><span>{t('obPackageSource')}</span><Segmented ariaLabel={t('obPackageSource')} value={source} onValueChange={value => packages.setSource(value as core.RuntimePackageSource)} options={[{ value: 'download', label: t('obSourceDownload'), disabled }, { value: 'local', label: t('obSourceLocal'), disabled }]}/></div>
    {source === 'local' && <>
      <p className="local-package-hint">{t(windows ? 'obLocalHintWindows' : 'obLocalHintLinux')}</p>
      <div className="local-package-rows">{row('strataArchivePath', t('obLocalStrata'))}{windows && row('engineArchivePath', t('obLocalEngine'))}</div>
      {packages.pickError && <p className="notice error" role="alert">{packages.pickError}</p>}
      {packages.missing && <p className="local-package-required" role="status">{t('obLocalRequired')}</p>}
    </>}
  </div>;
}
