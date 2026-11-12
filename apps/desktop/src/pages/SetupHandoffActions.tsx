import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LoaderCircle } from 'lucide-react';
import type { SetupHandoff, SetupHandoffDifference } from '@strata-manager/core';
import { Dropdown } from '../OfficialControls';
import './setup-handoff.css';

const differenceLabel = { model: 'setupDiffModel', weights: 'setupDiffWeights', context: 'setupDiffContext', images: 'setupDiffImages' } as const;

/** #225: the model already in My models keeps its settings; show exactly what differs from this preparation. */
function KeptSettings({ differences }: { differences: SetupHandoffDifference[] }) {
  const { t } = useTranslation();
  const value = (item: SetupHandoffDifference, text: string) => item.field === 'images' ? t(text === 'true' ? 'setupImagesOn' : 'setupImagesOff') : text;
  return <div className="notice warning setup-kept-settings" role="status" data-testid="setup-kept-settings">
    <strong>{t('setupKeptSettingsTitle')}</strong>
    <dl>{differences.map(item => <div key={item.field} data-field={item.field}><dt>{t(differenceLabel[item.field] ?? 'setupDiffModel')}</dt><dd><span>{t('setupDiffNow')} <b>{value(item, item.current)}</b></span><span aria-hidden="true">→</span><span>{t('setupDiffThisTime')} <b>{value(item, item.prepared)}</b></span></dd></div>)}</dl>
    <p>{t('setupKeptSettingsHint')}</p>
  </div>;
}

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
  const differences = handoff.status === 'needs-choice' ? handoff.differences ?? [] : [];
  return <div>
    {differences.length ? <KeptSettings differences={differences}/> : handoff.error && <p className={`notice ${handoff.status === 'needs-choice' ? 'warning' : 'error'}`} role={handoff.status === 'needs-choice' ? 'status' : 'alert'}>{handoff.error}</p>}
    <div className="actions">
      {handoff.status === 'registered' ? <>
        <span className="subtle">{t('setupRegistered')}</span>
        <button className="st-btn st-btn--secondary" onClick={onView}>{t('viewModels')}</button>
        {handoff.profileId && <button className="st-btn st-btn--secondary" disabled={disabled || working} onClick={() => void run(() => onUse(handoff.profileId!))}>{working && <LoaderCircle size={14} className="spin"/>}{t('usePreparedModel')}</button>}
      </> : <>
        {!!handoff.choices?.length && <Dropdown ariaLabel={t('setupNeedsChoice')} value={selected} disabled={disabled || working} onValueChange={setSelected} options={handoff.choices.map(choice => ({value:choice.configPath,label:choice.name}))}/>}
        {handoff.status === 'needs-choice' && handoff.profileId && !handoff.choices?.length ? <>
          <button className="st-btn st-btn--secondary" disabled={disabled || working} onClick={() => void run(() => onUse(handoff.profileId!))}>{working && <LoaderCircle size={14} className="spin"/>}{t('useRegisteredConfig')}</button>
          <button className="st-btn st-btn--secondary" onClick={onView}>{t('setupChangeSettings')}</button>
          {canRecheck && <button className="st-btn st-btn--secondary" disabled={disabled || working} onClick={() => void run(() => onResolve())}>{t('localSetupDetectAgain')}</button>}
        </> : <button className="st-btn st-btn--secondary" disabled={disabled || working} onClick={() => void run(() => onResolve(selected || undefined))}>{working && <LoaderCircle size={14} className="spin"/>}{t(handoff.choices?.length ? 'setupNeedsChoice' : 'localSetupDetectAgain')}</button>}
      </>}
    </div>
  </div>;
}
