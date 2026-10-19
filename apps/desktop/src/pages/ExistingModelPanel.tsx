import type { AppLanguage, LocalGgufGroup, LocalModelRequest, ModelDownloadRequest, OfficialSetupOptions, OrcaImportRequest, ServiceProfile, TaskStatus } from '@strata-manager/core';
import * as core from '@strata-manager/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileSearch, FolderOpen, HardDrive, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { Dropdown, Radio } from '../OfficialControls';
import { existingModelCopy } from './existingModelCopy';
import './existing-model.css';

export type LocalSetupRequest = ModelDownloadRequest & { localModel: LocalModelRequest };
export interface ExistingModelPanelProps {
  language: AppLanguage;
  desktop: boolean;
  runtime?: ServiceProfile;
  /** Detected engine version of `runtime`, for the minEngine gate. */
  runtimeVersion?: string;
  busy: boolean;
  options: OfficialSetupOptions;
  /** START-HERE.bat on Windows, `python setup.py` elsewhere, in the command preview. */
  windows: boolean;
  /** The wizard shows a narrower layout. */
  compact?: boolean;
  onChooseDirectory: () => Promise<string | null>;
  onChooseFile: () => Promise<string | null>;
  onSetup: (request: LocalSetupRequest) => Promise<TaskStatus | void | undefined>;
  onOrcaImport?: (profile: ServiceProfile, request: OrcaImportRequest, options: OfficialSetupOptions) => Promise<TaskStatus | void | undefined>;
  /** Called after a task was submitted, with the family/quant/context that was prepared. */
  onStarted?: (task: TaskStatus | void | undefined, selection: { family: string; quant: string; context: number }) => void;
}

const CONTEXTS = [8192, 32768, 65536, 131072, 262144];
const gb = (bytes: number, language: string) => (bytes / 1e9).toLocaleString(language, { maximumFractionDigits: 1 });
const separatorOf = (path: string) => path.includes('\\') ? '\\' : '/';

/** 「使用已有模型」 (#75): one flow for the wizard's model step and the Models page. */
export function ExistingModelPanel({ language, desktop, runtime, runtimeVersion, busy, options, windows, compact, onChooseDirectory, onChooseFile, onSetup, onOrcaImport, onStarted }: ExistingModelPanelProps) {
  const t = existingModelCopy(language);
  const [path, setPath] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [mtpPath, setMtpPath] = useState('');
  const [context, setContext] = useState(32768);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const scan = useQuery({ queryKey: ['local-model-scan', path], queryFn: () => core.scanLocalModels(path), enabled: desktop && !!path, retry: false, staleTime: 15000, refetchOnWindowFocus: false });
  const choices = useMemo(() => core.groupLocalGgufs(scan.data), [scan.data]);
  const groups = choices.flatMap(choice => choice.variants);
  const group: LocalGgufGroup | undefined = groups.find(item => item.id === selectedId);
  useEffect(() => {
    // Preselect the picked file's group, else the first usable one.
    if (!scan.data || groups.some(item => item.id === selectedId)) return;
    const picked = scan.data.selectedFile ? groups.find(item => item.shards.some(shard => shard.name === scan.data!.selectedFile)) : undefined;
    setSelectedId((picked ?? core.defaultLocalGgufGroup(scan.data) ?? groups[0])?.id ?? '');
  }, [scan.data]);
  const mtp = useQuery({ queryKey: ['local-mtp-check', mtpPath], queryFn: () => core.checkMtpPath(mtpPath), enabled: desktop && !!mtpPath, retry: false, staleTime: 15000, refetchOnWindowFocus: false });
  const action = core.localModelAction(group);
  const orca = action === 'orca';
  const directory = scan.data?.directory ?? '';
  const request: LocalModelRequest = { ggufDirectory: directory, ...(mtpPath ? { mtpPath } : {}) };
  const mtpProblem = mtpPath ? (mtp.isError ? core.normalizeError(mtp.error).message : mtp.data?.problems[0]) : undefined;
  const mtpReady = !mtpPath || (!!mtp.data && !mtp.data.problems.length);
  const engineGate = group?.family && group.quant && action === 'setup' ? (core.catalogQuantEngineGate(group.family, group.quant, runtimeVersion) ?? core.catalogEngineGate(group.family, runtimeVersion)) : null;
  const engineBlocked = !!engineGate && !engineGate.ok;
  const checkEnabled = desktop && !!runtime?.installDir && !!group && action !== 'blocked' && mtpReady && !mtp.isFetching;
  const disk = useQuery({
    queryKey: ['local-model-disk', runtime?.id, runtime?.installDir, group?.id, directory, mtpPath],
    queryFn: () => core.setupDiskPreflight(runtime!, group!.family!, group!.quant!, false, request),
    enabled: checkEnabled && action === 'setup', retry: false, staleTime: 15000, refetchOnWindowFocus: false,
  });
  const orcaPlan = useQuery({
    queryKey: ['local-model-orca', runtime?.id, runtime?.installDir, group?.id, directory, mtpPath],
    queryFn: () => core.orcaImportPlan(runtime!, core.localOrcaRequest(group!, request, separatorOf(directory))),
    enabled: checkEnabled && orca && !!onOrcaImport, retry: false, staleTime: 15000, refetchOnWindowFocus: false,
  });
  const diskReport = orca ? orcaPlan.data?.disk : disk.data;
  const checkPending = orca ? orcaPlan.isFetching : disk.isFetching;
  const checkError = orca ? orcaPlan.error : disk.error;
  const checkProblems = orca ? orcaPlan.data?.problems ?? [] : disk.data && disk.data.status !== 'ready' && disk.data.reason ? [disk.data.reason] : [];
  const ready = !!group && action !== 'blocked' && !engineBlocked && mtpReady && !checkPending && !checkError && (orca ? orcaPlan.data?.status === 'ready' : disk.data?.status === 'ready');
  const command = group && action !== 'blocked' && directory ? core.localModelCommand(group, request, mtp.data, orca ? core.ORCA_CONTEXT : context, windows) : '';
  const disabled = !desktop || busy || submitting;

  const pick = async (kind: 'folder' | 'file' | 'mtp') => {
    setError(''); setNotice('');
    try {
      const chosen = kind === 'file' ? await onChooseFile() : await onChooseDirectory();
      if (!chosen) return;
      if (kind === 'mtp') setMtpPath(chosen); else { setPath(chosen); setSelectedId(''); }
    } catch (cause) { setError(core.normalizeError(cause).message); }
  };
  const start = async () => {
    if (lock.current || !runtime || !group || !ready) return;
    lock.current = true; setSubmitting(true); setError(''); setNotice('');
    try {
      let task: TaskStatus | void | undefined;
      if (orca) {
        task = await onOrcaImport?.(runtime, core.localOrcaRequest(group, request, separatorOf(directory)), options);
      } else {
        const base = core.snapshotModelDownloadRequest(runtime, { model: group.family!, quant: group.quant!, context, images: false }, options);
        const setup = core.localSetupRequest(base, group, request);
        // Revalidate the captured files right before submitting (they may have moved since the scan).
        const checked = await core.setupDiskPreflight(setup.profile, setup.model, setup.quant, false, setup.localModel);
        if (checked.status !== 'ready') throw new Error(checked.reason || (checked.status === 'insufficient' ? t.diskLow : t.diskUnknown));
        task = await onSetup(setup);
      }
      if (!task) return; // The app reports a failed submission itself.
      setNotice(t.started);
      onStarted?.(task, { family: orca ? 'orca' : group.family!, quant: group.quant!, context: orca ? core.ORCA_CONTEXT : context });
    } catch (cause) { setError(core.normalizeError(cause).message); }
    finally { lock.current = false; setSubmitting(false); }
  };

  const status = (item: LocalGgufGroup) => !item.installable ? 'bad' : item.warnings.length && item.kind !== 'official' ? 'warn' : 'ok';
  const statusLabel = (item: LocalGgufGroup) => ({ ok: t.usable, warn: t.checkFirst, bad: t.unusable })[status(item)];
  return <section className={`existing-model${compact ? ' is-compact' : ''}`} data-testid="existing-model" aria-label={t.title}>
    {!compact && <p className="existing-model-intro">{t.intro}</p>}
    <div className="existing-model-row">
      <span className="existing-model-label">{t.files}</span>
      <div className="existing-model-pick">
        <button type="button" disabled={disabled} data-testid="existing-model-folder" onClick={() => void pick('folder')}><FolderOpen size={15}/>{t.chooseFolder}</button>
        <button type="button" disabled={disabled} data-testid="existing-model-file" onClick={() => void pick('file')}><FileSearch size={15}/>{t.chooseFile}</button>
        {path && <button type="button" className="existing-model-icon" aria-label={t.rescan} title={t.rescan} disabled={disabled || scan.isFetching} onClick={() => void scan.refetch()}><RefreshCw size={14} className={scan.isFetching ? 'spin' : ''}/></button>}
      </div>
      <code className="existing-model-path" title={path || undefined} data-testid="existing-model-path">{path || t.noPath}</code>
    </div>
    {!desktop ? <p className="existing-model-note">{t.needDesktop}</p> : path && (scan.isPending ? <p className="existing-model-note" role="status">{t.scanning}</p>
      : scan.isError ? <p role="alert" className="existing-model-error">{core.normalizeError(scan.error).message}</p>
      : scan.data && <>
        {scan.data.problems.map(problem => <p key={problem} role="alert" className="existing-model-error">{problem}</p>)}
        {!groups.length ? <p className="existing-model-note" data-testid="existing-model-empty">{t.noGgufs}</p> : <fieldset className="existing-model-groups" disabled={disabled} data-testid="existing-model-groups">
          <legend>{t.quantLegend}</legend>
          {choices.map(choice => <div key={choice.model} className="existing-model-group">
            <div className="existing-model-group-head"><HardDrive size={16}/><strong>{choice.model}</strong><small>{t.variants(choice.variants.length)}</small></div>
            {choice.variants.map(item => <label key={item.id} className={`existing-model-variant is-${status(item)}${item.id === selectedId ? ' is-selected' : ''}`} data-testid={`existing-model-variant-${item.quant ?? item.id}`}>
              <Radio name="existing-model-variant" value={item.id} checked={item.id === selectedId} onChange={() => { setSelectedId(item.id); setError(''); setNotice(''); }}/>
              <span className="existing-model-quant"><code>{item.quant ?? '—'}</code><small>{t.kind[item.kind]}</small></span>
              <span className="existing-model-size">{gb(item.totalBytes, language)} GB · {t.shards(item.shards.length)}</span>
              <span className={`existing-model-badge is-${status(item)}`}>{statusLabel(item)}</span>
            </label>)}
          </div>)}
        </fieldset>}
        {group && <div className="existing-model-detail" data-testid="existing-model-detail" aria-live="polite">
          {group.problems.length > 0 && <ul className="existing-model-problems" role="alert">{group.problems.map(problem => <li key={problem}><X size={13}/>{problem}</li>)}</ul>}
          {group.warnings.length > 0 && <ul className="existing-model-warnings" data-testid="existing-model-warnings">{group.warnings.map(warning => <li key={warning}><TriangleAlert size={13}/>{warning}</li>)}</ul>}
          {group.shards.some(shard => shard.state !== 'ok') && <ul className="existing-model-shards">{group.shards.map(shard => <li key={shard.name} className={`is-${shard.state === 'ok' ? 'ok' : 'bad'}`}><code>{shard.name}</code><span>{t.shardState[shard.state]}</span></li>)}</ul>}
        </div>}
      </>)}
    {group && action !== 'blocked' && <>
      <div className="existing-model-row is-mtp">
        <span className="existing-model-label">{t.mtpTitle}</span>
        <div className="existing-model-pick">
          <button type="button" disabled={disabled} data-testid="existing-model-mtp" onClick={() => void pick('mtp')}><FolderOpen size={15}/>{t.mtpChoose}</button>
          {mtpPath && <button type="button" className="existing-model-link" disabled={disabled} onClick={() => setMtpPath('')}>{t.mtpClear}</button>}
        </div>
        <code className="existing-model-path" title={mtpPath || undefined}>{mtpPath || t.mtpNone}</code>
        <small className="existing-model-hint">{t.mtpHint}</small>
        {mtpPath && (mtp.isFetching ? <small className="existing-model-hint">{t.mtpChecking}</small> : mtpProblem ? <p role="alert" className="existing-model-error" data-testid="existing-model-mtp-problem">{mtpProblem}</p> : mtp.data?.rtDirectory && <small className="existing-model-ok" data-testid="existing-model-mtp-ok">{t.mtpFound(gb(mtp.data.expertsBytes, language))} · {orca ? t.mtpOrcaMap : mtp.data.dataDirectory ? t.mtpSetupMap(mtp.data.dataDirectory) : ''}</small>)}
      </div>
      <div className="existing-model-row">
        <span className="existing-model-label">{t.context}</span>
        {orca ? <span className="existing-model-hint">{t.orcaContext}</span> : <Dropdown ariaLabel={t.context} value={String(context)} onValueChange={value => setContext(Number(value))} options={CONTEXTS.map(value => ({ value: String(value), label: core.formatContextTokens(value, language) }))}/>}
      </div>
      <p className="existing-model-hint">{t.vision}</p>
      {!runtime?.installDir ? <p className="existing-model-note" role="alert" data-testid="existing-model-need-runtime">{t.needRuntime}</p> : <div className="existing-model-checks" data-testid="existing-model-checks">
        <h4>{t.checks}</h4>
        {engineBlocked && <p role="alert" className="existing-model-error">{t.engine(engineGate!.minEngine ?? '', runtimeVersion ?? '—')}</p>}
        {checkPending ? <p className="existing-model-note">{t.checking}</p> : checkError ? <p role="alert" className="existing-model-error">{core.normalizeError(checkError).message}</p> : diskReport && <dl>
          <div className={`is-${diskReport.status === 'ready' ? 'ok' : 'bad'}`}><dt>{t.disk}</dt><dd><span>{diskReport.status === 'ready' ? ((diskReport.additionalBytesEstimate ?? 0) > 0 ? t.diskNeed(gb(diskReport.additionalBytesEstimate ?? 0, language)) : t.diskReady) : diskReport.status === 'insufficient' ? t.diskLow : t.diskUnknown}</span><code title={diskReport.dataDirectory}>{diskReport.dataDirectory}</code></dd></div>
        </dl>}
        {checkProblems.length > 0 && <ul className="existing-model-problems" role="alert" data-testid="existing-model-check-problems">{checkProblems.map(problem => <li key={problem}><X size={13}/>{problem}</li>)}</ul>}
      </div>}
      {command && <div className="existing-model-command"><span className="existing-model-label">{t.command}</span><code data-testid="existing-model-command">{command}</code><small className="existing-model-hint">{t.commandHint}</small></div>}
    </>}
    <footer className="existing-model-submit">
      <button type="button" className="primary" data-testid="existing-model-start" disabled={disabled || !runtime?.installDir || !ready || (orca && !onOrcaImport)} onClick={() => void start()}>{submitting ? t.starting : t.start}</button>
      <small>{group && !group.installable ? t.chooseVariant : orca ? t.orcaFootnote : t.footnote}</small>
    </footer>
    {error && <p role="alert" className="existing-model-error" data-testid="existing-model-error">{error}</p>}
    {notice && <p role="status" className="existing-model-ok">{notice}</p>}
  </section>;
}
