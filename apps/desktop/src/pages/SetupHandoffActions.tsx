import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LoaderCircle } from 'lucide-react';
import type { SetupHandoff } from '@strata-manager/core';
import { Dropdown } from '../OfficialControls';

export function SetupHandoffActions({ handoff, canRecheck, disabled, onResolve, onUse, onView, onError }: {
  handoff: SetupHandoff;
  canRecheck: boolean;
  disabled: boolean;
  onResolve: (configPath?: string) => Promise<unknown>;
  onUse: (profileId: string) => Promise<unknown>;
  onView: () => void;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(handoff.choices?.[0]?.configPath ?? '');
  const [working, setWorking] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    if (!handoff.choices?.some(choice => choice.configPath === selected)) setSelected(handoff.choices?.[0]?.configPath ?? '');
  }, [handoff.taskId, handoff.choices, selected]);
  const run = async (operation: () => Promise<unknown>) => {
    if (disabled || pending.current) return;
    pending.current = true;
    setWorking(true);
    try { await operation(); } catch (error) { onError(error); }
    finally { pending.current = false; setWorking(false); }
  };
  if (handoff.status === 'cancelled') return null;
  if (handoff.status === 'pending') return <span className="subtle" role="status"><LoaderCircle size={14} className="spin"/> {t('setupRegistering')}</span>;
  if (handoff.status === 'failed' && !canRecheck) return handoff.error ? <p className="notice error" role="alert">{handoff.error}</p> : null;
  return <div>
    {handoff.error && <p className="notice error" role="alert">{handoff.error}</p>}
    <div className="actions">
      {handoff.status === 'registered' ? <>
        <span className="subtle">{t('setupRegistered')}</span>
        <button className="st-btn st-btn--secondary" onClick={onView}>{t('viewModels')}</button>
        {handoff.profileId && <button className="st-btn st-btn--secondary" disabled={disabled || working} onClick={() => void run(() => onUse(handoff.profileId!))}>{working && <LoaderCircle size={14} className="spin"/>}{t('usePreparedModel')}</button>}
      </> : <>
        {!!handoff.choices?.length && <Dropdown ariaLabel={t('setupNeedsChoice')} value={selected} disabled={disabled || working} onValueChange={setSelected} options={handoff.choices.map(choice => ({value:choice.configPath,label:choice.name}))}/>}
        {handoff.status === 'needs-choice' && handoff.profileId && !handoff.choices?.length ? <>
          <button className="st-btn st-btn--secondary" onClick={onView}>{t('viewModels')}</button>
          <button className="st-btn st-btn--secondary" disabled={disabled || working} onClick={() => void run(() => onUse(handoff.profileId!))}>{working && <LoaderCircle size={14} className="spin"/>}{t('useRegisteredConfig')}</button>
        </> : <button className="st-btn st-btn--secondary" disabled={disabled || working} onClick={() => void run(() => onResolve(selected || undefined))}>{working && <LoaderCircle size={14} className="spin"/>}{t(handoff.choices?.length ? 'setupNeedsChoice' : 'localSetupDetectAgain')}</button>}
      </>}
    </div>
  </div>;
}
