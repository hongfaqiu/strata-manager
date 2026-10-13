import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supportedLanguages, type LanguagePreference, type AppSettings } from '@strata-manager/core';
import { Dialog, Field } from './components';
import { Dropdown } from './OfficialControls';

export function LanguageSetupDialog({settings, onChange, onConfirm}: {
  settings: AppSettings;
  onChange: (preference: LanguagePreference) => void;
  onConfirm: () => Promise<void>;
}) {
  const {t} = useTranslation();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const confirm = async () => {
    if (saving) return;
    setSaving(true); setError('');
    try { await onConfirm(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setSaving(false); }
  };
  return <Dialog title={t('chooseLanguage')} onClose={()=>{void confirm();}}>
    <p>{t('chooseLanguageHint')}</p>
    <Field label={t('language')}>
      <Dropdown ariaLabel={t('language')} value={settings.languagePreference ?? settings.language} disabled={saving}
        onValueChange={value=>onChange(value as LanguagePreference)}
        options={[{value:'system',label:t('systemLanguage')},...supportedLanguages.map(item=>({value:item.code,label:item.label}))]}/>
    </Field>
    {error && <p role="alert">{error}</p>}
    <div className="dialog-footer"><button className="primary" disabled={saving} onClick={()=>{void confirm();}}>{t('continueLanguage')}</button></div>
  </Dialog>;
}
