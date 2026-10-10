import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Check, CircleAlert, Download, FolderOpen, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import type { LocalCandidate } from '@strata-manager/core';
import './local-setup.css';

export interface LocalSetupProgress {
  phase: 'importing' | 'starting' | 'loading';
  message?: string;
}

export interface LocalSetupPageProps {
  language: 'zh-CN' | 'en';
  desktop: boolean;
  progress?: LocalSetupProgress;
  onDiscover: (directories?: string[]) => Promise<LocalCandidate[]>;
  onChooseDirectory: () => Promise<string | null>;
  onImport: (candidate: LocalCandidate) => Promise<void>;
  onInstall: () => void;
  onChat: () => void;
}

/** Import readiness comes only from onImport finishing its real backend workflow. */
export function LocalSetupPage(props: LocalSetupPageProps) {
  const { t } = useTranslation();
  const [candidates, setCandidates] = useState<LocalCandidate[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [discovering, setDiscovering] = useState(props.desktop);
  const [searched, setSearched] = useState(false);
  const [choosingDirectory, setChoosingDirectory] = useState(false);
  const [preparingId, setPreparingId] = useState('');
  const [readyId, setReadyId] = useState('');
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [directoryEmpty, setDirectoryEmpty] = useState(false);
  const candidateSnapshot = useRef<LocalCandidate[]>([]);
  const mounted = useRef(false);
  const autoDetected = useRef(false);
  const detecting = useRef(false);
  const preparing = useRef(false);
  const callbacks = useRef(props);
  callbacks.current = props;

  const describeError = (value: unknown) => value instanceof Error ? value.message : String(value);
  const detect = useCallback(async (directories?: string[]) => {
    if (detecting.current || preparing.current || !callbacks.current.desktop) return;
    detecting.current = true;
    setDiscovering(true);
    setError('');
    setActionError('');
    setDirectoryEmpty(false);
    try {
      const found = await callbacks.current.onDiscover(directories);
      if (!mounted.current) return;
      const distinct = [...new Map(found.map(candidate => [candidate.id, candidate])).values()];
      const next = directories ? [...new Map([...candidateSnapshot.current, ...distinct].map(candidate => [candidate.id, candidate])).values()] : distinct;
      candidateSnapshot.current = next;
      setCandidates(next);
      setSelectedId(previous => next.some(candidate => candidate.id === previous) ? previous : distinct[0]?.id ?? next[0]?.id ?? '');
      setDirectoryEmpty(!!directories?.length && !distinct.length);
      setReadyId('');
    } catch (failure) {
      if (mounted.current) setError(describeError(failure));
    } finally {
      detecting.current = false;
      if (mounted.current) { setDiscovering(false); setSearched(true); }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (props.desktop && !autoDetected.current) {
      autoDetected.current = true;
      void detect();
    }
    return () => { mounted.current = false; };
  }, [props.desktop, detect]);

  const browse = async () => {
    if (choosingDirectory || detecting.current || preparing.current) return;
    setChoosingDirectory(true);
    setActionError('');
    try {
      const directory = await callbacks.current.onChooseDirectory();
      if (directory && mounted.current) await detect([directory]);
    } catch (failure) {
      if (mounted.current) setActionError(describeError(failure));
    } finally {
      if (mounted.current) setChoosingDirectory(false);
    }
  };

  const importCandidate = async (candidate: LocalCandidate) => {
    if (preparing.current || detecting.current || choosingDirectory || candidate.availability === 'repair') return;
    preparing.current = true;
    setPreparingId(candidate.id);
    setSelectedId(candidate.id);
    setReadyId('');
    setActionError('');
    try {
      await callbacks.current.onImport(candidate);
      if (mounted.current) setReadyId(candidate.id);
    } catch (failure) {
      if (mounted.current) setActionError(describeError(failure));
    } finally {
      preparing.current = false;
      if (mounted.current) setPreparingId('');
    }
  };

  const selected = candidates.find(candidate => candidate.id === selectedId);
  const ready = candidates.find(candidate => candidate.id === readyId);
  const busy = discovering || choosingDirectory || !!preparingId;
  const quantization = (candidate: LocalCandidate) => candidate.modelPath.match(/(?:^|[\\/._\s-])((?:IQ\d_[A-Z\d_]+|Q\d(?:_[A-Z\d]+)+|BF16|FP16|F16|FP32))(?=$|[\\/.\s-])/i)?.[1]?.toUpperCase();
  const formatSize = (bytes: number | null) => bytes !== null && Number.isFinite(bytes) && bytes > 0
    ? `${(bytes / 1024 ** 3).toLocaleString(props.language, { maximumFractionDigits: 1 })} GiB`
    : t('localSetupSizeUnknown');

  return <section className="local-setup" aria-labelledby="local-setup-title" data-testid="local-setup">
    <div className="local-setup-heading"><div><h2 id="local-setup-title">{t('localSetupTitle')}</h2><p>{t('localSetupIntro')}</p></div>
      <button type="button" className="st-btn st-btn--secondary" disabled={!props.desktop || busy} onClick={() => void detect()}><RefreshCw size={15}/>{t('localSetupDetectAgain')}</button>
    </div>

    {!props.desktop ? <div className="local-setup-empty"><FolderOpen size={28}/><h3>{t('localSetupDesktopTitle')}</h3><p>{t('localSetupDesktopHint')}</p></div>
      : discovering ? <div className="local-setup-detection" role="status" aria-live="polite"><LoaderCircle className="spin" size={23}/><div><strong>{t('localSetupDetecting')}</strong><p>{t('localSetupDetectionScope')}</p></div></div>
      : <>
        {error && <div className="local-setup-error" role="alert"><CircleAlert size={17}/><div><strong>{t('localSetupDetectionFailed')}</strong><p>{error}</p></div></div>}
        {directoryEmpty && <p className="local-setup-note" role="status"><CircleAlert size={15}/><span>{t('localSetupDirectoryEmpty')}</span></p>}
        {!candidates.length && searched && !error && <div className="local-setup-empty"><Search size={28}/><h3>{t('localSetupNothingFound')}</h3><p>{t('localSetupNothingFoundHint')}</p><button type="button" className="st-btn st-btn--primary" disabled={busy} onClick={() => void browse()}><FolderOpen size={16}/>{t('localSetupChooseDirectory')}</button><button type="button" className="st-btn st-btn--secondary" disabled={busy} onClick={props.onInstall}><Download size={16}/>{t('localSetupInstall')}</button></div>}
        {candidates.length > 0 && <div className="local-setup-split">
          <div className="local-candidate-list" aria-label={t('localSetupCandidates')}>
            <div className="local-candidate-list-heading"><span>{t('localSetupCandidates')}</span><small>{t('localSetupCandidateCount', { count: candidates.length })}</small></div>
            {candidates.map(candidate => <button type="button" key={candidate.id} className={`local-candidate ${selectedId === candidate.id ? 'is-selected' : ''}`} disabled={!!preparingId} aria-pressed={selectedId === candidate.id} onClick={() => { setSelectedId(candidate.id); setActionError(''); }}>
              <span className="local-candidate-mark"><FolderOpen size={19}/></span><span className="local-candidate-copy"><strong>{candidate.name}</strong><span title={candidate.configPath}>{candidate.configPath.split(/[\\/]/).pop()}</span><small>{quantization(candidate) ?? t('localSetupQuantUnknown')} · {formatSize(candidate.modelBytes)}</small></span>
              <span className={`local-candidate-state ${candidate.running ? 'is-running' : ''} ${candidate.availability === 'repair' ? 'needs-repair' : ''}`}>{t(candidate.availability === 'repair' ? 'localSetupNeedsRepair' : candidate.running ? 'localSetupRunning' : 'localSetupInstalled')}</span>
            </button>)}
            <div className="local-candidate-list-actions"><button type="button" className="st-btn st-btn--secondary" disabled={busy} onClick={() => void browse()}><FolderOpen size={15}/>{t('localSetupChooseAnother')}</button><button type="button" className="st-btn st-btn--secondary" disabled={busy} onClick={props.onInstall}><Download size={15}/>{t('localSetupInstallAnother')}</button></div>
          </div>
          <div className="local-candidate-detail">
            {selected && <><div className="local-candidate-detail-heading"><h3>{selected.name}</h3><span>{t(selected.availability === 'repair' ? 'localSetupNeedsRepair' : selected.running ? 'localSetupRunning' : 'localSetupInstalled')}</span></div>
              <dl><div><dt>{t('localSetupDirectory')}</dt><dd title={selected.installDir}>{selected.installDir}</dd></div><div><dt>{t('configPath')}</dt><dd title={selected.configPath}>{selected.configPath}</dd></div><div><dt>{t('localSetupQuantization')}</dt><dd>{quantization(selected) ?? t('localSetupQuantUnknown')}</dd></div><div><dt>{t('localSetupModelSize')}</dt><dd>{formatSize(selected.modelBytes)}</dd></div>{selected.runtimeVersion && <div><dt>{t('localSetupRuntimeVersion')}</dt><dd>{selected.runtimeVersion}</dd></div>}</dl>
              {selected.reason && <p className="local-setup-note"><CircleAlert size={15}/><span>{selected.reason}</span></p>}
              <p className="local-setup-import-hint">{t(selected.availability === 'repair' ? 'localSetupRepairHint' : selected.running ? 'localSetupRunningImportHint' : 'localSetupImportHint')}</p>
              {preparingId === selected.id ? <div className="local-setup-preparing" role="status" aria-live="polite"><LoaderCircle className="spin" size={18}/><div><strong>{t(props.progress ? `localSetupPhase_${props.progress.phase}` : 'localSetupPreparing')}</strong>{props.progress?.message && <p>{props.progress.message}</p>}<small>{t('localSetupWaitHint')}</small></div></div>
                : readyId === selected.id ? <div className="local-setup-ready" role="status" aria-live="polite"><Check size={19}/><div><strong>{t('localSetupReady')}</strong><p>{t('localSetupReadyHint')}</p></div></div>
                : <button type="button" className="st-btn st-btn--primary local-setup-import" disabled={busy || selected.availability === 'repair'} onClick={() => void importCandidate(selected)}>{t(selected.availability === 'repair' ? 'localSetupNeedsRepair' : actionError ? 'localSetupRetryPrepare' : 'localSetupImportAndPrepare')}<ArrowRight size={16}/></button>}
              {actionError && <div className="local-setup-error" role="alert"><CircleAlert size={17}/><div><strong>{t('localSetupPreparationFailed')}</strong><p>{actionError}</p></div></div>}
              {readyId === selected.id && <button type="button" className="st-btn st-btn--primary local-setup-import" onClick={props.onChat}>{t('localSetupStartChat')}<ArrowRight size={16}/></button>}
            </>}
          </div>
        </div>}
        {!!actionError && !selected && <div className="local-setup-error" role="alert"><CircleAlert size={17}/><p>{actionError}</p></div>}
        {(error || candidates.length > 0) && <p className="local-setup-scope">{t('localSetupDetectionScope')}{error && <button type="button" className="st-btn st-btn--secondary" disabled={busy} onClick={() => void browse()}><FolderOpen size={15}/>{t('localSetupChooseDirectory')}</button>}</p>}
      </>}
    {ready && ready.id !== selectedId && <div className="local-setup-ready local-setup-ready-other"><Check size={17}/><span>{t('localSetupModelReady', { name: ready.name })}</span><button type="button" className="st-btn st-btn--secondary" onClick={props.onChat}>{t('localSetupStartChat')}<ArrowRight size={15}/></button></div>}
  </section>;
}
