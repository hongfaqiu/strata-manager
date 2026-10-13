import type { AppLanguage } from "@strata-manager/core";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Check, CircleAlert, Download, FolderOpen, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import type { LocalCandidate } from '@strata-manager/core';
import { StartupProgress, type StartupProgressState } from './StartupProgress';
import './local-setup.css';

export type LocalSetupProgress = StartupProgressState;

export interface LocalSetupPageProps {
  language: AppLanguage;
  desktop: boolean;
  progress?: LocalSetupProgress;
  currentCandidateId?: string;
  currentConfigPath?: string;
  lastUsedCandidateId?: string;
  lastUsedConfigPath?: string;
  onDiscover: (directories?: string[]) => Promise<LocalCandidate[]>;
  onChooseDirectory: () => Promise<string | null>;
  onImport: (candidate: LocalCandidate) => Promise<void>;
  onInstall: () => void;
  onChat: () => void;
  inspectPanel?: ReactNode;
}

const pathKey = (value: string | undefined) => value?.replace(/\\/g, '/').toLowerCase();
const sameCandidate = (candidate: LocalCandidate, id?: string, configPath?: string) =>
  (!!id && candidate.id === id) || (!!configPath && pathKey(candidate.configPath) === pathKey(configPath));
const configOption = (candidate: LocalCandidate, flag: string) => {
  const args = candidate.config?.args;
  if (!Array.isArray(args)) return undefined;
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return typeof value === 'string' && !value.startsWith('-') ? value : undefined;
};
const configSummary = (candidate: LocalCandidate, language: AppLanguage) => {
  const context = configOption(candidate, '--max-context');
  const parallel = candidate.config?.parallel;
  const kv = configOption(candidate, '--kv');
  return [context && `${language === 'zh-CN' ? '上下文' : 'Context'} ${Number(context).toLocaleString(language)}`,
    parallel != null && `${language === 'zh-CN' ? '并发' : 'Parallel'} ${String(parallel)}`,
    kv && `KV ${kv}`].filter(Boolean).join(' · ');
};

const localWords = {
  'zh-CN': { models: '个模型', configurations: '个配置', current: '当前使用', last: '上次使用', modified: '修改时间', unknownDate: '未提供修改时间', configTitle: '选择运行配置', configHint: '这些配置使用同一组模型文件，可选择不同的上下文、并发和缓存设置。', modelPath: '模型文件', details: '查看详细配置', hidden: '凭据已隐藏', runtimeDetected: '已检测到 Strata。此配置缺少的文件不影响其它完整配置的使用。', choose: '使用此配置', profileHint: '使用模型会将运行配置加入“我的模型”，模型文件仍保留在原位置。' },
  en: { models: 'models', configurations: 'configurations', current: 'In use', last: 'Last used', modified: 'Modified', unknownDate: 'Modification time unavailable', configTitle: 'Choose a runtime configuration', configHint: 'These configurations share the same model files with different context, concurrency and cache settings.', modelPath: 'Model files', details: 'View full configuration', hidden: 'Credentials hidden', runtimeDetected: 'Strata was detected. Missing files in this configuration do not prevent other complete configurations from being used.', choose: 'Use this configuration', profileHint: 'Using a model adds its runtime configuration to My models. Model files stay in their original location.' },
} as const;

/** Import readiness comes only from onImport finishing its real backend workflow. */
export function LocalSetupPage(props: LocalSetupPageProps) {
  const { t } = useTranslation();
  const text = localWords[(props.language === 'zh-CN' ? 'zh-CN' : 'en')];
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
      const current = next.find(candidate => sameCandidate(candidate, callbacks.current.currentCandidateId, callbacks.current.currentConfigPath));
      setSelectedId(previous => next.some(candidate => candidate.id === previous) ? previous : current?.id ?? distinct.find(candidate => candidate.running || candidate.availability !== 'repair')?.id ?? distinct[0]?.id ?? next[0]?.id ?? '');
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
  const groups = useMemo(() => {
    const grouped = new Map<string, LocalCandidate[]>();
    for (const candidate of candidates) {
      const key = candidate.modelGroupKey ?? pathKey(candidate.modelPath) ?? candidate.id;
      grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
    }
    return [...grouped.entries()].map(([id, configs]) => ({ id, configs }));
  }, [candidates]);
  const selectedGroup = groups.find(group => group.configs.some(candidate => candidate.id === selectedId));
  const candidateBadge = (candidate: LocalCandidate) => sameCandidate(candidate, props.currentCandidateId, props.currentConfigPath) || candidate.running
    ? text.current : sameCandidate(candidate, props.lastUsedCandidateId, props.lastUsedConfigPath) ? text.last : undefined;
  const modified = (candidate: LocalCandidate) => candidate.configModifiedAt ? new Date(candidate.configModifiedAt).toLocaleString(props.language) : text.unknownDate;
  const formatSize = (bytes: number | null) => bytes !== null && Number.isFinite(bytes) && bytes > 0
    ? `${(bytes / 1024 ** 3).toLocaleString(props.language, { maximumFractionDigits: 1 })} GiB`
    : t('localSetupSizeUnknown');

  return <section className="local-setup" aria-labelledby="local-setup-title" data-testid="local-setup">
    <div className="local-setup-heading"><div><h2 id="local-setup-title">{t('localSetupTitle')}</h2><p>{t('localSetupIntro')}</p></div>
      <button type="button" className="st-btn st-btn--secondary" disabled={!props.desktop || busy} aria-busy={discovering} onClick={() => void detect()}><RefreshCw size={15} className={discovering ? 'spin' : undefined}/>{t('localSetupDetectAgain')}</button>
    </div>

    {!props.desktop ? <div className="local-setup-empty"><FolderOpen size={28}/><h3>{t('localSetupDesktopTitle')}</h3><p>{t('localSetupDesktopHint')}</p></div>
      : discovering && !searched ? <div className="local-setup-detection" role="status" aria-live="polite"><LoaderCircle className="spin" size={23}/><div><strong>{t('localSetupDetecting')}</strong><p>{t('localSetupDetectionScope')}</p></div></div>
      : <>
        {error && <div className="local-setup-error" role="alert"><CircleAlert size={17}/><div><strong>{t('localSetupDetectionFailed')}</strong><p>{error}</p></div></div>}
        {directoryEmpty && <p className="local-setup-note" role="status"><CircleAlert size={15}/><span>{t('localSetupDirectoryEmpty')}</span></p>}
        {!candidates.length && searched && !error && <div className="local-setup-empty"><Search size={28}/><h3>{t('localSetupNothingFound')}</h3><p>{t('localSetupNothingFoundHint')}</p><button type="button" className="st-btn st-btn--primary" disabled={busy} onClick={() => void browse()}><FolderOpen size={16}/>{t('localSetupChooseDirectory')}</button><button type="button" className="st-btn st-btn--secondary" disabled={busy} onClick={props.onInstall}><Download size={16}/>{t('localSetupInstall')}</button></div>}
        {candidates.length > 0 && <div className="local-setup-split">
          <div className="local-candidate-list" aria-label={t('localSetupCandidates')}>
            <div className="local-candidate-list-heading"><span>{t('localSetupCandidates')}</span><small>{groups.length} {text.models} · {candidates.length} {text.configurations}</small></div>
            {groups.map(group => {
              const candidate = group.configs.find(item => sameCandidate(item, props.currentCandidateId, props.currentConfigPath) || item.running)
                ?? group.configs.find(item => item.availability !== 'repair') ?? group.configs[0]!;
              const active = group === selectedGroup;
              const badge = group.configs.map(candidateBadge).find(value => value === text.current)
                ?? group.configs.map(candidateBadge).find(Boolean);
              const repair = group.configs.every(item => item.availability === 'repair');
              return <button type="button" key={group.id} className={`local-candidate ${active ? 'is-selected' : ''}`} disabled={!!preparingId} aria-pressed={active} onClick={() => { setSelectedId(candidate.id); setActionError(''); }}>
                <span className="local-candidate-mark"><FolderOpen size={19}/></span><span className="local-candidate-copy"><strong>{candidate.name}</strong><span>{group.configs.length} {text.configurations}</span><small>{quantization(candidate) ?? t('localSetupQuantUnknown')} · {formatSize(candidate.modelBytes)}</small></span>
                <span className={`local-candidate-state ${badge === text.current ? 'is-running' : ''} ${repair ? 'needs-repair' : ''}`}>{badge ?? t(repair ? 'localSetupNeedsRepair' : 'localSetupInstalled')}</span>
              </button>;
            })}
            <div className="local-candidate-list-actions"><button type="button" className="st-btn st-btn--secondary" disabled={busy} onClick={() => void browse()}><FolderOpen size={15}/>{t('localSetupChooseAnother')}</button><button type="button" className="st-btn st-btn--secondary" disabled={busy} onClick={props.onInstall}><Download size={15}/>{t('localSetupInstallAnother')}</button></div>
          </div>
          <div className="local-candidate-detail">
            {selected && <><div className="local-candidate-detail-heading"><h3>{selected.name}</h3><span>{t(selected.availability === 'repair' ? 'localSetupNeedsRepair' : selected.running ? 'localSetupRunning' : 'localSetupInstalled')}</span></div>
              <div className="local-configuration-picker"><h4>{text.configTitle}</h4>{(selectedGroup?.configs.length ?? 0) > 1 && <p>{text.configHint}</p>}<div className="local-configuration-list">{selectedGroup?.configs.map(candidate => <button type="button" key={candidate.id} disabled={!!preparingId} className={`local-configuration ${candidate.id === selectedId ? 'is-selected' : ''}`} aria-pressed={candidate.id === selectedId} onClick={() => { setSelectedId(candidate.id); setActionError(''); }}>
                <span className="local-configuration-title"><strong data-tooltip={candidate.configPath}>{candidate.configPath.split(/[\\/]/).pop()}</strong>{candidateBadge(candidate) && <em>{candidateBadge(candidate)}</em>}{candidate.availability === 'repair' && <em className="needs-repair">{t('localSetupNeedsRepair')}</em>}</span>
                {configSummary(candidate, props.language) && <span>{configSummary(candidate, props.language)}</span>}<small>{text.modified} · {modified(candidate)}</small>
              </button>)}</div></div>
              <dl><div><dt>{t('localSetupDirectory')}</dt><dd data-tooltip={selected.installDir}>{selected.installDir}</dd></div><div><dt>{t('configPath')}</dt><dd data-tooltip={selected.configPath}>{selected.configPath}</dd></div><div><dt>{text.modified}</dt><dd>{modified(selected)}</dd></div><div><dt>{text.modelPath}</dt><dd data-tooltip={selected.modelPath}>{selected.modelPath}</dd></div><div><dt>{t('localSetupQuantization')}</dt><dd>{quantization(selected) ?? t('localSetupQuantUnknown')}</dd></div><div><dt>{t('localSetupModelSize')}</dt><dd>{formatSize(selected.modelBytes)}</dd></div>{selected.runtimeVersion && <div><dt>{t('localSetupRuntimeVersion')}</dt><dd>{selected.runtimeVersion}</dd></div>}</dl>
              {selected.config && <details className="local-configuration-details"><summary>{text.details}<small>{text.hidden}</small></summary><pre tabIndex={0}>{JSON.stringify(selected.config, null, 2)}</pre></details>}
              {selected.reason && <p className="local-setup-note"><CircleAlert size={15}/><span>{selected.reason}</span></p>}
              <p className="local-setup-import-hint">{selected.availability === 'repair' ? text.runtimeDetected : selected.running ? t('localSetupRunningImportHint') : text.profileHint}</p>
              {preparingId === selected.id ? <StartupProgress language={props.language} progress={props.progress ?? { phase: 'importing', modelName: selected.name }}/>
                : readyId === selected.id ? <div className="local-setup-ready" role="status" aria-live="polite"><Check size={19}/><div><strong>{t('localSetupReady')}</strong><p>{t('localSetupReadyHint')}</p></div></div>
                : <button type="button" className="st-btn st-btn--primary local-setup-import" disabled={busy || selected.availability === 'repair'} onClick={() => void importCandidate(selected)}>{selected.availability === 'repair' ? t('localSetupNeedsRepair') : actionError ? t('localSetupRetryPrepare') : text.choose}<ArrowRight size={16}/></button>}
              {actionError && <div className="local-setup-error" role="alert"><CircleAlert size={17}/><div><strong>{t('localSetupPreparationFailed')}</strong><p>{actionError}</p></div></div>}
              {readyId === selected.id && <button type="button" className="st-btn st-btn--primary local-setup-import" onClick={props.onChat}>{t('localSetupStartChat')}<ArrowRight size={16}/></button>}
            </>}
          </div>
        </div>}
        {!!actionError && !selected && <div className="local-setup-error" role="alert"><CircleAlert size={17}/><p>{actionError}</p></div>}
        {(error || candidates.length > 0) && <p className="local-setup-scope">{t('localSetupDetectionScope')}{error && <button type="button" className="st-btn st-btn--secondary" disabled={busy} onClick={() => void browse()}><FolderOpen size={15}/>{t('localSetupChooseDirectory')}</button>}</p>}
      </>}
    {props.inspectPanel}
    {ready && ready.id !== selectedId && <div className="local-setup-ready local-setup-ready-other"><Check size={17}/><span>{t('localSetupModelReady', { name: ready.name })}</span><button type="button" className="st-btn st-btn--secondary" onClick={props.onChat}>{t('localSetupStartChat')}<ArrowRight size={15}/></button></div>}
  </section>;
}
