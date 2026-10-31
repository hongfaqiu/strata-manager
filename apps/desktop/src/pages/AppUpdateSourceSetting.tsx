import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { LoaderCircle, Save } from 'lucide-react';
import * as core from '@strata-manager/core';
import { Dropdown } from '../OfficialControls';
import { appUpdateMirrorProblem, appUpdateSourceChoice, appUpdateUsesSource, withAppUpdateSource, type AppUpdateSourceChoice } from '../appUpdateSource';

// Same query and store as the engine download settings, so both entries stay in sync.
const preferencesKey = ['runtime-download-preferences'];
const problemKey = { https: 'appUpdateSourceHttps', url: 'appUpdateSourceNeedUrl', engineOnly: 'appUpdateSourceEngineOnly', placeholder: 'appUpdateSourcePlaceholder' } as const;

export function AppUpdateSourceSetting({ desktop, onError }: { desktop: boolean; onError: (error: unknown) => void }) {
  const { t } = useTranslation();
  const query = useQueryClient();
  const preferences = useQuery({ queryKey: preferencesKey, queryFn: core.getRuntimeDownloadPreferences, enabled: desktop, retry: false });
  const [saving, setSaving] = useState(false);
  const [customDraft, setCustomDraft] = useState<string | null>(null);
  const saved = preferences.data;
  const savedChoice = appUpdateSourceChoice(saved);
  const choice: AppUpdateSourceChoice = customDraft !== null ? 'custom' : savedChoice;
  const mirrorUrl = customDraft ?? (savedChoice === 'custom' ? saved?.mirrorUrl ?? '' : '');
  const problem = mirrorUrl.trim() ? appUpdateMirrorProblem(mirrorUrl) : null;
  const disabled = !desktop || !saved || saving;
  const save = async (value: core.RuntimeDownloadPreferences) => {
    if (saving) return;
    setSaving(true);
    try {
      await core.saveRuntimeDownloadPreferences(value);
      query.setQueryData(preferencesKey, value);
      await query.invalidateQueries({ queryKey: preferencesKey });
      setCustomDraft(null);
    } catch (error) { onError(error); }
    finally { setSaving(false); }
  };
  const choose = (value: string) => {
    if (value === choice || value === 'local') return;
    if (value === 'custom') { setCustomDraft(mirrorUrl); return; }
    void save(withAppUpdateSource(saved, value as Exclude<AppUpdateSourceChoice, 'local' | 'custom'>));
  };
  const canSaveCustom = !disabled && !!mirrorUrl.trim() && !problem && (customDraft !== null && (savedChoice !== 'custom' || customDraft.trim() !== (saved?.mirrorUrl ?? '')));
  const options = [
    { value: 'auto', label: t('appUpdateSourceAutoOption') },
    { value: 'official', label: t('appUpdateSourceOfficial') },
    ...core.runtimeDownloadSources.map(source => ({ value: source.id, label: source.label })),
    { value: 'custom', label: t('appUpdateSourceCustom') },
    ...(savedChoice === 'local' ? [{ value: 'local', label: t('appUpdateSourceLocal') }] : []),
  ];
  const automatic = saved && customDraft === null && choice !== 'auto' && !appUpdateUsesSource(saved);

  return <div className="app-update-source" data-testid="app-update-source">
    <div className="setting-toggle">
      <span><strong>{t('appUpdateSource')}</strong><small>{t('appUpdateSourceShared')}</small></span>
      <div style={{ width: 220, maxWidth: '55%', flexShrink: 0 }}><Dropdown ariaLabel={t('appUpdateSource')} value={choice} options={options} disabled={disabled} onValueChange={choose}/></div>
    </div>
    {choice === 'custom' && <div className="app-update-source-custom">
      <input type="url" aria-label={t('appUpdateSourceCustom')} placeholder="https://mirror.example.com/{url}" value={mirrorUrl} disabled={disabled} aria-invalid={!!problem} spellCheck={false} onChange={event => setCustomDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && canSaveCustom) void save(withAppUpdateSource(saved, 'custom', mirrorUrl)); }}/>
      <button type="button" disabled={!canSaveCustom} onClick={() => void save(withAppUpdateSource(saved, 'custom', mirrorUrl))}>{saving ? <LoaderCircle className="spin" size={15}/> : <Save size={15}/>}{t('save')}</button>
    </div>}
    {problem && <p className="app-update-source-problem" role="alert">{t(problemKey[problem])}</p>}
    {automatic && <p className="subtle app-update-source-auto" role="status">{t('appUpdateSourceAuto')}</p>}
    {preferences.error && <p className="app-update-source-problem" role="alert">{core.normalizeError(preferences.error).message}</p>}
  </div>;
}
