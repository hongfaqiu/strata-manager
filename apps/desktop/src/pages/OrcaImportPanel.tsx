import type { AppLanguage, OfficialSetupOptions, OrcaImportPlan, OrcaImportRequest, ServiceProfile } from '@strata-manager/core';
import * as core from '@strata-manager/core';
import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, FolderOpen, ShieldAlert } from 'lucide-react';
import { Radio, Toggle } from '../OfficialControls';
import { orcaCopy } from './orcaCopy';

export interface OrcaImportPanelProps {
  language: AppLanguage;
  desktop: boolean;
  runtime?: ServiceProfile;
  busy: boolean;
  options: OfficialSetupOptions;
  onChooseFile: () => Promise<string | null>;
  onImport: (profile: ServiceProfile, request: OrcaImportRequest, options: OfficialSetupOptions) => Promise<unknown>;
}

const gb = (bytes: number, language: string) => (bytes / 1e9).toLocaleString(language, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const gib = (bytes: number, language: string) => (bytes / 1024 ** 3).toLocaleString(language, { maximumFractionDigits: 1 });
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** ORCA.md's manual compatibility workflow, one restrained section of the download page. */
export function OrcaImportPanel({ language, desktop, runtime, busy, options, onChooseFile, onImport }: OrcaImportPanelProps) {
  const t = orcaCopy[language] ?? orcaCopy.en;
  const [source, setSource] = useState<'download' | 'local'>('download');
  const [shardPath, setShardPath] = useState('');
  const [mtp, setMtp] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const nameProblem = source === 'local' && shardPath ? core.orcaShardProblem(shardPath) : null;
  const request: OrcaImportRequest = source === 'local' ? { source, shardPath, mtp } : { source, mtp };
  const planEnabled = desktop && !!runtime?.installDir && (source === 'download' || (!!shardPath && !nameProblem));
  const plan = useQuery<OrcaImportPlan>({ queryKey: ['orca-import-plan', runtime?.id, runtime?.installDir, source, shardPath, mtp], queryFn: () => core.orcaImportPlan(runtime!, request), enabled: planEnabled, staleTime: 15000, retry: false, refetchOnWindowFocus: false });
  const problemText = (problem: NonNullable<ReturnType<typeof core.orcaShardProblem>>) => problem.problem === 'unvalidated' ? t.unvalidated(problem.quant ?? '') : t[problem.problem];
  const data = planEnabled ? plan.data : undefined;
  const ram = data ? core.orcaRamCheck(data.ramTotalBytes, data.ramAvailableBytes) : 'unknown';
  const diskNeed = data?.disk.additionalBytesEstimate ?? 0;
  const choose = async () => {
    setError('');
    try { const path = await onChooseFile(); if (path) setShardPath(path); }
    catch (cause) { setError(core.normalizeError(cause).message); }
  };
  const start = async () => {
    if (lock.current || !runtime || !data || data.status !== 'ready') return;
    lock.current = true; setSubmitting(true); setError('');
    try { await onImport(runtime, request, options); await plan.refetch(); }
    catch (cause) { setError(core.normalizeError(cause).message); }
    finally { lock.current = false; setSubmitting(false); }
  };
  const disabled = !desktop || !runtime?.installDir || busy || submitting;
  const shardLabel = (state: OrcaImportPlan['shards'][number]) => state.state === 'complete' ? t.shardComplete : state.state === 'partial' ? t.shardPartial(gb(state.expectedBytes - state.presentBytes, language)) : state.state === 'missing' ? t.shardMissing(gb(state.expectedBytes, language)) : t.shardWrong;
  // The title and the 「社区兼容 · 非官方菜单 · 仅文本」 badge live in the section's summary (ModelDownloadPage).
  return <section className="orca-import" data-testid="orca-import" aria-label={t.title}>
    <p className="orca-import-intro">{t.intro} <a href={core.ORCA_GUIDE_URL} target="_blank" rel="noreferrer">{t.guide}<ArrowUpRight size={12}/></a></p>
    <fieldset className="orca-import-source" disabled={disabled}>
      <legend>{t.sourceLegend}</legend>
      <label className="orca-import-option"><Radio name="orca-source" value="download" checked={source === 'download'} onChange={() => { setSource('download'); setError(''); }}/><span><strong>{t.sourceDownload} · {gb(core.ORCA_TOTAL_BYTES, language)} GB</strong><small>{t.sourceDownloadHint}</small></span></label>
      <label className="orca-import-option"><Radio name="orca-source" value="local" checked={source === 'local'} onChange={() => { setSource('local'); setError(''); }}/><span><strong>{t.sourceLocal}</strong><small>{t.sourceLocalHint}</small></span></label>
      {source === 'local' && <div className="orca-import-file"><button type="button" onClick={() => void choose()}><FolderOpen size={15}/>{t.chooseShard}</button><code title={shardPath || undefined}>{shardPath ? fileName(shardPath) : t.noShard}</code></div>}
      {nameProblem && <p role="alert" className="orca-import-error" data-testid="orca-name-problem">{problemText(nameProblem)}</p>}
    </fieldset>
    <label className="orca-import-mtp"><span><strong>{t.mtpLabel}</strong><small>{t.mtpHint}</small></span><Toggle ariaLabel={t.mtpLabel} checked={mtp} disabled={disabled} onCheckedChange={setMtp}/></label>
    {!desktop ? <p className="orca-import-note">{t.needDesktop}</p> : !runtime?.installDir ? <p className="orca-import-note">{t.needRuntime}</p> : planEnabled && <div className="orca-import-checks" aria-live="polite">
      <h4>{t.checks}</h4>
      {plan.isPending ? <p className="orca-import-note">{t.checking}</p> : plan.isError ? <p role="alert" className="orca-import-error">{core.normalizeError(plan.error).message}</p> : data && <dl>
        {data.shards.map((shard, index) => <div key={shard.name} className={`is-${shard.state === 'complete' ? 'ok' : shard.state === 'wrongSize' ? 'bad' : 'todo'}`}><dt>{t.shard(index + 1)}</dt><dd><span>{shardLabel(shard)}</span><code title={shard.path}>{shard.name}</code></dd></div>)}
        <div className={`is-${ram === 'ok' ? 'ok' : ram === 'unknown' ? 'todo' : 'warn'}`} data-testid="orca-ram"><dt>{t.ram}</dt><dd><span>{data.ramTotalBytes ? t.ramText(gib(data.ramTotalBytes, language), gib(data.ramAvailableBytes, language)) : t.ramUnknown}</span>{ram === 'insufficient' && <strong><ShieldAlert size={14}/>{t.ramInsufficient}</strong>}{ram === 'tight' && <strong><ShieldAlert size={14}/>{t.ramTight}</strong>}</dd></div>
        <div className={`is-${data.disk.status === 'ready' ? 'ok' : 'bad'}`}><dt>{t.disk}</dt><dd><span>{diskNeed > 0 ? t.diskNeed(gb(diskNeed, language)) : t.diskReady}</span><code title={data.disk.dataDirectory}>{data.disk.dataDirectory}</code></dd></div>
        <div className={data.packReady ? 'is-ok' : 'is-todo'}><dt>{t.pack}</dt><dd><span>{data.packReady ? t.packReady : t.packTodo}</span><code title={data.packDirectory}>{data.packDirectory}</code></dd></div>
        <div className="is-todo"><dt>{t.config}</dt><dd><span>{data.configExists ? t.configReplace(core.ORCA_CONFIG_FILE) : t.configNew(core.ORCA_CONFIG_FILE)}</span><code>{data.modelName}</code></dd></div>
      </dl>}
      {data?.problems.length ? <div className="orca-import-problems" role="alert" data-testid="orca-problems"><strong>{t.problems}</strong><ul>{data.problems.map(problem => <li key={problem}>{problem}</li>)}</ul></div> : null}
    </div>}
    <footer className="orca-import-submit">
      <button type="button" className="primary" data-testid="orca-import-start" disabled={disabled || !data || data.status !== 'ready' || plan.isFetching} onClick={() => void start()}>{submitting ? t.starting : t.start}</button>
      <p>{t.footnote}</p>
    </footer>
    {error && <p role="alert" className="orca-import-error">{error}</p>}
  </section>;
}
