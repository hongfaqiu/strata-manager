import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { AppLanguage, ArenaGroups, ArenaLeaderboard, ArenaLogEntry, ArenaParamChange, ArenaParams, ArenaPayload, ArenaRecommendation, ArenaRecommendRow, ArenaRow, ArenaStatus, BenchmarkSuiteReport, ContextBenchmarkReport } from '@strata-manager/core';
import { Dialog, Empty } from '../components';
import { Dropdown, Segmented, Toggle } from '../OfficialControls';
import { ARENA_EVENT, arenaBuild } from './arenaUpload';
import './arena.css';

type Scene = 'chat' | 'long' | 'code';
type Filter = 'gpu' | 'vram' | 'all';
const DISMISS_KEY = 'arenaConsentDismissedV1';
const familyName = (family: string) => core.MODEL_CATALOG.find(model => model.family === family)?.name ?? family;
const groupLabel = (group: string) => { const [family = '', quant = ''] = group.split(':'); return { model: familyName(family), quant }; };
const gpuLabel = (name: string) => name.replace(/^NVIDIA GeForce |^NVIDIA |^AMD Radeon |^AMD /, '');
const ctxLabel = (ctx: number) => ctx >= 1024 ? `${Math.round(ctx / 1024)}K` : String(ctx);
const latest = <T extends { finishedAt: number; state: string }>(reports: unknown): T | undefined =>
  (Array.isArray(reports) ? reports as T[] : []).filter(report => report && report.state === 'completed').sort((a, b) => b.finishedAt - a.finishedAt)[0];
const sameParams = (a: ArenaParams, b: ArenaParams) => (['ctx', 'kv', 'gpuCount', 'parallel', 'poolWorkers', 'expertCache', 'pcieFrac', 'vision'] as const).every(key => (a[key] ?? null) === (b[key] ?? null));
const decode8k = (payload?: ArenaPayload) => payload?.tiers?.find(tier => tier.ctx >= 7000 && tier.ctx <= 9500)?.decode ?? null;

function Signal({ machines, seed }: { machines: number; seed?: boolean }) {
  const level = seed ? 3 : machines >= 25 ? 3 : machines >= 10 ? 2 : machines >= 3 ? 1 : 0;
  return <span className="arena-signal" aria-hidden>{[0, 1, 2].map(i => <i key={i} className={i < level ? 'on' : ''} style={{ height: 5 + i * 3 }}/>)}</span>;
}
function Quant({ children }: { children: string }) { return <span className="arena-quant">{children}</span>; }

export function ArenaPage({ language, active }: { language: AppLanguage; active: boolean }) {
  const { t } = useTranslation();
  const desktop = core.isDesktop();
  const number = useCallback((value: number | null | undefined, digits = 1) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString(language, { maximumFractionDigits: digits, minimumFractionDigits: digits > 0 && value < 1000 ? digits : 0 }), [language]);
  const [status, setStatus] = useState<ArenaStatus>();
  const [dismissed, setDismissed] = useState<boolean>();
  const [view, setView] = useState<'board' | 'recommend'>('board');
  const [groups, setGroups] = useState<ArenaGroups>();
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(false);
  const [group, setGroup] = useState('');
  const [filter, setFilter] = useState<Filter>('gpu');
  const [board, setBoard] = useState<ArenaLeaderboard>();
  const [scene, setScene] = useState<Scene>('chat');
  const [recommendation, setRecommendation] = useState<ArenaRecommendation>();
  const [mine, setMine] = useState<{ payload?: ArenaPayload; launch?: core.ArenaLaunch | null; built: boolean }>({ built: false });
  const [autoUpload, setAutoUpload] = useState(true);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);

  const refreshStatus = useCallback(async () => {
    if (!desktop) return;
    try { setStatus(await core.arenaStatus()); } catch { /* keep the previous status */ }
  }, [desktop]);
  const refreshMine = useCallback(async () => {
    const [context, scenario] = await Promise.all([core.loadStore<unknown>('contextBenchmarkReportsV1', []).catch(() => []), core.loadStore<unknown>('benchmarkReportsV1', []).catch(() => [])]);
    const report = latest<ContextBenchmarkReport>(context) ?? latest<BenchmarkSuiteReport>(scenario);
    const built = report ? await arenaBuild(report).catch(() => undefined) : undefined;
    const launch = (report?.identity as { launch?: core.ArenaLaunch | null } | undefined)?.launch ?? null;
    setMine({ payload: built && 'payload' in built ? built.payload : undefined, launch, built: true });
  }, []);
  const loadGroups = useCallback(async () => {
    setLoading(true);
    try { const next = await core.arenaGet<ArenaGroups>('groups'); setGroups(next); setOffline(false); }
    catch { setOffline(true); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refreshStatus(); void refreshMine(); void loadGroups();
    void core.loadStore<boolean>(DISMISS_KEY, false).then(value => setDismissed(value === true)).catch(() => setDismissed(false));
    if (desktop) void core.arenaFlush().then(setStatus).catch(() => undefined);
  }, [active, desktop, refreshStatus, refreshMine, loadGroups]);
  useEffect(() => {
    const changed = () => { void refreshStatus(); void refreshMine(); };
    window.addEventListener(ARENA_EVENT, changed); return () => window.removeEventListener(ARENA_EVENT, changed);
  }, [refreshStatus, refreshMine]);

  const myGroup = mine.payload ? `${mine.payload.model.family}:${mine.payload.model.quant}` : mine.launch ? `${mine.launch.family}:${mine.launch.quant}` : '';
  const myGpu = mine.payload?.hw.gpus[0];
  useEffect(() => {
    if (!groups?.groups.length) return;
    if (!group || !groups.groups.some(item => item.group === group)) setGroup(groups.groups.find(item => item.group === myGroup)?.group ?? groups.groups[0]!.group);
  }, [groups, group, myGroup]);
  useEffect(() => {
    if (!active || !group || offline) return;
    const query: Record<string, string> = { group };
    if (filter === 'gpu' && myGpu) query.gpu = myGpu.name;
    if (filter === 'vram' && myGpu) query.vram = String(myGpu.vramGB);
    let current = true;
    void core.arenaGet<ArenaLeaderboard>('leaderboard', query).then(next => { if (current) setBoard(next); }).catch(() => { if (current) setOffline(true); });
    return () => { current = false; };
  }, [active, group, filter, myGpu, offline]);
  useEffect(() => {
    if (!active || view !== 'recommend' || offline) return;
    const hw = { gpu: myGpu?.name, vramGB: myGpu?.vramGB, ramGB: mine.payload?.hw.ramGB };
    let current = true;
    void core.arenaGet<ArenaRecommendation>('recommend', core.arenaRecommendQuery(hw, mine.launch, scene)).then(next => { if (current) setRecommendation(next); }).catch(() => { if (current) setOffline(true); });
    return () => { current = false; };
  }, [active, view, scene, myGpu, mine.payload, mine.launch, offline]);

  const consent = async () => {
    setBusy('consent'); setMessage('');
    try { setStatus(await core.arenaConsent(core.ARENA_CONSENT_VERSION, autoUpload)); }
    catch (error) { setMessage(core.normalizeError(error).message); }
    finally { setBusy(''); }
  };
  const dismiss = async () => { setDismissed(true); await core.saveStore(DISMISS_KEY, true).catch(() => undefined); };
  const reopen = async () => { setDismissed(false); await core.saveStore(DISMISS_KEY, false).catch(() => undefined); };
  const toggleUpload = async (enabled: boolean) => {
    setBusy('toggle');
    try { setStatus(await core.arenaSetAutoUpload(enabled)); } catch (error) { setMessage(core.normalizeError(error).message); } finally { setBusy(''); }
  };
  const flush = async () => {
    setBusy('flush');
    try { setStatus(await core.arenaFlush()); } catch (error) { setMessage(core.normalizeError(error).message); } finally { setBusy(''); }
  };
  const withdraw = async () => {
    setBusy('withdraw'); setMessage('');
    try { const { deleted } = await core.arenaWithdraw(); setConfirmWithdraw(false); setMessage(t('arenaWithdrawn', { count: deleted })); await refreshStatus(); void loadGroups(); }
    catch (error) { setMessage(t('arenaWithdrawFailed', { error: core.normalizeError(error).message })); }
    finally { setBusy(''); }
  };

  const chips = (params: ArenaParams) => {
    const list = [ctxLabel(params.ctx), `KV ${params.kv}`];
    if (params.poolWorkers) list.push(t('arenaWorkers', { count: params.poolWorkers }));
    list.push(t('arenaParallel', { count: params.parallel }));
    list.push(t('arenaGpus', { count: params.gpuCount }));
    if (params.expertCache && params.expertCache !== 'auto') list.push(t('arenaExpertCache', { value: params.expertCache }));
    if (params.pcieFrac != null) list.push(`PCIe ${params.pcieFrac}`);
    if (params.vision) list.push(t('arenaVision'));
    return <span className="arena-params">{list.map(item => <span key={item}>{item}</span>)}</span>;
  };
  const paramName = (param: keyof ArenaParams) => t(`arenaParam_${param}`);
  const paramValue = (param: keyof ArenaParams, value: unknown) => param === 'ctx' && typeof value === 'number' ? ctxLabel(value) : value === null || value === undefined ? t('arenaDefault') : String(value);
  const confidenceName = (row: { confidence: ArenaRow['confidence'] }) => t(`arenaConfidence_${row.confidence}`);

  // ---- consent ----
  const showConsent = desktop && status && !status.consented && dismissed === false;
  if (showConsent) {
    const preview = mine.payload ? JSON.stringify({ ...mine.payload, installId: '…', consentVersion: core.ARENA_CONSENT_VERSION }, null, 2) : '';
    return <div className="arena arena-consent">
      <section className="panel arena-consent-main">
        <h2>{t('arenaJoinTitle')}</h2>
        <p className="arena-muted">{t('arenaJoinIntro')}</p>
        <h3>{t('arenaUploads')}</h3>
        <ul className="arena-list">
          {(['Hardware', 'Model', 'Results', 'Versions'] as const).map(key => <li key={key}><b>{t(`arenaUpload${key}`)}</b><span>{t(`arenaUpload${key}Hint`)}</span></li>)}
        </ul>
        <h3>{t('arenaNever')}</h3>
        <p className="arena-muted">{t('arenaNeverHint')}</p>
        <label className="arena-toggle-row"><Toggle checked={autoUpload} onCheckedChange={setAutoUpload} ariaLabel={t('arenaAutoUpload')}/><span><b>{t('arenaAutoUpload')}</b><small>{t('arenaAutoUploadHint')}</small></span></label>
        {message && <p className="arena-error" role="alert">{message}</p>}
        <div className="arena-consent-actions">
          <span className="arena-muted">{t('arenaConsentFooter', { version: core.ARENA_CONSENT_VERSION })}</span>
          <button type="button" className="st-btn st-btn--secondary" onClick={() => void dismiss()}>{t('arenaNotNow')}</button>
          <button type="button" className="st-btn st-btn--primary" disabled={busy === 'consent'} onClick={() => void consent()}>{busy === 'consent' && <LoaderCircle className="spin" size={14}/>}{t('arenaAgree')}</button>
        </div>
      </section>
      <section className="panel arena-preview">
        <header><h3>{t('arenaPreviewTitle')}</h3><span className="arena-muted">{mine.payload ? t('arenaPreviewLatest') : ''}</span></header>
        {preview ? <pre className="arena-json">{preview}</pre> : <p className="arena-muted arena-preview-empty">{mine.built ? t('arenaPreviewEmpty') : t('loading')}</p>}
        <p className="arena-muted">{t('arenaPreviewHint')}</p>
      </section>
    </div>;
  }

  // ---- shared side panel ----
  const lastUpload = status?.log.find(entry => entry.status === 'uploaded');
  const uploads = status?.log.filter(entry => entry.status === 'uploaded').length ?? 0;
  const myRow = board?.rows.find(row => myGpu && row.hw.gpu === myGpu.name && mine.payload && sameParams(row.params, mine.payload.params) && !row.seed);
  const myDecode = decode8k(mine.payload);
  const logStatus = (entry: ArenaLogEntry) => t(`arenaLog_${entry.status}`);
  const side = <aside className="panel arena-side">
    <div className="arena-side-sec">
      <header><h3>{t('arenaMyMachine')}</h3><span className="arena-muted">{myGpu ? `${gpuLabel(myGpu.name)} · ${number(mine.payload?.hw.ramGB, 0)} GB` : ''}</span></header>
      {myDecode != null ? <>
        <div className="arena-big"><strong>{number(myDecode)}</strong><span>{t('arenaDecodeUnit')}</span></div>
        <p className="arena-muted">{myRow ? <><span className={myDecode >= myRow.decode.median ? 'arena-up' : 'arena-down'}>{myDecode >= myRow.decode.median ? '+' : '−'}{number(Math.abs(myDecode - myRow.decode.median))}</span> {t('arenaVsConfig', { median: number(myRow.decode.median), rank: myRow.rank ?? '—', total: board?.rows.length ?? 0 })}</> : t('arenaNoPeers')}</p>
        {mine.payload && <p className="arena-muted arena-mine-config">{groupLabel(`${mine.payload.model.family}:${mine.payload.model.quant}`).model} <Quant>{mine.payload.model.quant}</Quant>{chips(mine.payload.params)}</p>}
      </> : <p className="arena-muted">{mine.payload?.kind === 'scenario' ? t('arenaScenarioOnly') : t('arenaNoRun')}</p>}
    </div>
    {desktop && status && <div className="arena-side-sec">
      {status.consented ? <dl className="arena-kv">
        <dt>{t('arenaAutoUpload')}</dt><dd><Toggle checked={status.autoUpload} disabled={busy === 'toggle'} onCheckedChange={value => void toggleUpload(value)} ariaLabel={t('arenaAutoUpload')}/></dd>
        <dt>{t('arenaUploaded')}</dt><dd>{t('arenaRuns', { count: uploads })}</dd>
        <dt>{t('arenaLastUpload')}</dt><dd>{lastUpload ? new Date(lastUpload.at).toLocaleString(language, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</dd>
        {status.queued > 0 && <><dt>{t('arenaQueued')}</dt><dd>{status.queued} <button type="button" className="arena-link" disabled={busy === 'flush'} onClick={() => void flush()}>{t('arenaRetryNow')}</button></dd></>}
        <dt>{t('arenaConsentVersion')}</dt><dd>{status.consentVersion}</dd>
      </dl> : <div className="arena-join"><p className="arena-muted">{t('arenaNotJoined')}</p><button type="button" className="st-btn st-btn--primary" onClick={() => void reopen()}>{t('arenaJoin')}</button></div>}
    </div>}
    {desktop && status && (status.log.length > 0 || status.consented) && <div className="arena-side-sec">
      <details className="arena-log"><summary>{t('arenaLog')}</summary>
        {status.log.length ? <ol>{status.log.slice(0, 20).map((entry, index) => <li key={index}><time>{new Date(entry.at).toLocaleString(language, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time><span>{entry.group ? groupLabel(entry.group).model + ' ' + groupLabel(entry.group).quant : entry.kind === 'withdraw' ? t('arenaWithdrawShort') : ''}</span><b className={`arena-log-${entry.status}`}>{logStatus(entry)}</b></li>)}</ol> : <p className="arena-muted">{t('arenaLogEmpty')}</p>}
      </details>
      {status.consented && <button type="button" className="arena-danger" onClick={() => setConfirmWithdraw(true)}>{t('arenaWithdraw')}</button>}
    </div>}
    {message && <p className="arena-muted arena-side-message" role="status">{message}</p>}
  </aside>;
  const withdrawDialog = confirmWithdraw && <Dialog title={t('arenaWithdrawTitle')} onClose={() => setConfirmWithdraw(false)}>
    <p className="arena-dialog-text">{t('arenaWithdrawHint')}</p>
    <div className="arena-dialog-actions"><button type="button" className="st-btn st-btn--secondary" onClick={() => setConfirmWithdraw(false)}>{t('cancel')}</button><button type="button" className="st-btn st-btn--danger" disabled={busy === 'withdraw'} onClick={() => void withdraw()}>{busy === 'withdraw' && <LoaderCircle className="spin" size={14}/>}{t('arenaWithdrawConfirm')}</button></div>
  </Dialog>;

  const toolbar = <div className="arena-toolbar">
    <Segmented ariaLabel={t('arenaView')} value={view} onValueChange={value => setView(value as 'board' | 'recommend')} options={[{ value: 'board', label: t('arenaBoard') }, { value: 'recommend', label: t('arenaRecommend') }]}/>
    {groups && groups.machines > 0 && <span className="arena-muted">{t('arenaTotals', { machines: groups.machines, runs: groups.runs })}{groups.computedAt ? ' · ' + t('arenaUpdated', { time: new Date(groups.computedAt).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' }) }) : ''}</span>}
    {desktop && status && !status.consented && dismissed && <button type="button" className="arena-link" onClick={() => void reopen()}>{t('arenaJoin')}</button>}
  </div>;

  // ---- offline / empty ----
  if (offline || (!groups && loading)) return <div className="arena-page">{toolbar}<div className="arena">
    <section className="panel arena-main">{offline ? <Empty title={t('arenaOfflineTitle')} hint={t('arenaOfflineHint')}><button type="button" className="st-btn st-btn--secondary" disabled={loading} onClick={() => { setOffline(false); void loadGroups(); }}><RefreshCw size={14}/>{t('retry')}</button></Empty> : <div className="arena-loading"><LoaderCircle className="spin" size={18}/></div>}</section>
    {side}</div>{withdrawDialog}</div>;
  if (groups && !groups.groups.length) return <div className="arena-page">{toolbar}<div className="arena">
    <section className="panel arena-main"><Empty title={t('arenaEmptyTitle')} hint={t('arenaEmptyHint')}/></section>{side}</div>{withdrawDialog}</div>;

  // ---- recommend ----
  if (view === 'recommend') {
    const rec = recommendation, same = rec?.sameModel;
    const basis = !rec ? '' : rec.level === 'gpu' && myGpu ? t('arenaBasisGpu', { gpu: gpuLabel(myGpu.name) }) : rec.level === 'vram' && myGpu ? t('arenaBasisVram', { gb: myGpu.vramGB }) : t('arenaBasisNone');
    const recRow = (row: ArenaRecommendRow, label: string, action?: ReactNode) => <div className="arena-rec" key={label + JSON.stringify(row.params) + row.hw.gpu}>
      <div><b>{label}</b><div className="arena-rec-params">{chips(row.params)}</div><small className="arena-muted">{gpuLabel(row.hw.gpu)} · {t('arenaMachines', { count: row.machines })}{row.peakRamGB ? ' · ' + t('arenaPeakRam', { gb: number(row.peakRamGB, 0) }) : ''}{row.seed ? ' · ' + t('arenaSeed') : ''}</small></div>
      <div className="arena-rec-speed"><strong>{number(row.speed)}</strong><small>tok/s</small><span className="arena-muted"><Signal machines={row.machines} seed={row.seed}/> {confidenceName(row)}</span></div>
      <div className="arena-rec-action">{action}</div>
    </div>;
    const change = (item: ArenaParamChange) => <li key={item.param + String(item.to)}><span>{paramName(item.param)} <b>{paramValue(item.param, item.from)} → {paramValue(item.param, item.to)}</b></span><span className="arena-up">+{number(item.gainPct, 0)}%</span><span className="arena-muted"><Signal machines={item.machines} seed={item.confidence === 'seed'}/> {t('arenaMachines', { count: item.machines })}</span><a className="arena-link" href="#config">{t('arenaAdjust')}</a></li>;
    return <div className="arena-page">{toolbar}<div className="arena">
      <section className="panel arena-main">
        <header className="arena-head"><div><h3>{t('arenaRecTitle')}</h3><span className="arena-muted">{basis}</span></div>
          <Segmented ariaLabel={t('arenaScene')} value={scene} onValueChange={value => setScene(value as Scene)} options={(['chat', 'long', 'code'] as const).map(value => ({ value, label: t(`arenaScene_${value}`) }))}/></header>
        {!rec ? <div className="arena-loading"><LoaderCircle className="spin" size={18}/></div> : <>
          {same && (same.best || same.changes.length) ? <div className="arena-rec-group">
            <div className="arena-rec-title">{t('arenaSameModel')} <b>{groupLabel(same.group).model}</b><Quant>{groupLabel(same.group).quant}</Quant></div>
            {same.best && recRow(same.best, same.current && sameParams(same.current.params, same.best.params) ? t('arenaBestIsYours') : t('arenaBestConfig'), <a className="st-btn st-btn--primary" href="#config">{t('arenaApply')}</a>)}
            {same.current && !(same.best && sameParams(same.current.params, same.best.params)) && recRow(same.current, t('arenaYourConfig'))}
            {same.changes.length > 0 && <ul className="arena-changes">{same.changes.slice(0, 4).map(change)}</ul>}
            {same.alternatives.slice(0, 2).map(row => recRow(row, t('arenaAlternative')))}
          </div> : mine.launch ? <p className="arena-note">{t('arenaNoSameModel', { model: familyName(mine.launch.family), quant: mine.launch.quant })}</p> : null}
          {rec.otherModels.length > 0 && <div className="arena-rec-group">
            <div className="arena-rec-title">{same ? t('arenaOtherModels') : t('arenaModelsForYou')}</div>
            {rec.otherModels.slice(0, 4).map(row => recRow(row, `${familyName(row.family)} ${row.quant}`, <a className="st-btn st-btn--secondary" href="#catalog">{t('arenaDownload')}</a>))}
          </div>}
          {!same?.best && !rec.otherModels.length && <Empty title={t('arenaColdTitle')} hint={t('arenaColdHint')}><a className="st-btn st-btn--secondary" href="#catalog">{t('arenaOpenCatalog')}</a></Empty>}
        </>}
      </section>
      <aside className="panel arena-side">
        <div className="arena-side-sec"><h3>{t('arenaHowTitle')}</h3><ol className="arena-steps">{[1, 2, 3, 4].map(n => <li key={n}>{t(`arenaHow${n}`)}</li>)}</ol></div>
        <div className="arena-side-sec"><h3>{t('arenaFallbackTitle')}</h3><p className="arena-muted">{t('arenaFallbackHint')}</p></div>
      </aside>
    </div>{withdrawDialog}</div>;
  }

  // ---- leaderboard ----
  const rows = board?.rows ?? [];
  const summary = groups?.groups.find(item => item.group === group);
  const lows = rows.map(row => row.decode.p25 ?? row.decode.median), highs = rows.map(row => row.decode.p75 ?? row.decode.median);
  const lo = rows.length ? Math.floor(Math.min(...lows) * 0.92) : 0, hi = rows.length ? Math.ceil(Math.max(...highs, myDecode ?? 0) * 1.04) : 1;
  const x = (value: number) => `${((value - lo) / Math.max(1, hi - lo) * 100).toFixed(1)}%`;
  const ticks = rows.length ? Array.from({ length: 5 }, (_, i) => Math.round(lo + (hi - lo) * i / 4)) : [];
  const groupOptions = (groups?.groups ?? []).map(item => ({ value: item.group, label: `${familyName(item.family)} · ${item.quant} · ${t('arenaMachines', { count: item.machines })}` }));
  const filterOptions = [
    ...(myGpu ? [{ value: 'gpu', label: gpuLabel(myGpu.name) }, { value: 'vram', label: t('arenaVramTier', { gb: myGpu.vramGB }) }] : []),
    { value: 'all', label: t('arenaAllHardware') },
  ];
  const activeFilter = myGpu ? filter : 'all';
  const label = groupLabel(group);
  return <div className="arena-page">{toolbar}<div className="arena">
    <section className="panel arena-main">
      <header className="arena-head">
        <div className="arena-group"><Dropdown ariaLabel={t('arenaGroup')} value={group} options={groupOptions} onValueChange={setGroup}/>{summary && <span className="arena-muted">{t('arenaGroupHint', { configs: summary.configs, machines: summary.machines })}</span>}</div>
        <Segmented ariaLabel={t('arenaHardware')} value={activeFilter} onValueChange={value => setFilter(value as Filter)} options={filterOptions}/>
      </header>
      {!board ? <div className="arena-loading"><LoaderCircle className="spin" size={18}/></div> : !rows.length ? <Empty title={t('arenaNoRows')} hint={t('arenaNoRowsHint')}/> : <>
        <div className="arena-podium">{rows.slice(0, 3).map((row, index) => <div key={index} className={index === 0 ? 'first' : ''}>
          <span className="arena-podium-rank">NO.{index + 1}</span>
          <div className="arena-podium-hw">{gpuLabel(row.hw.gpu)} <span className="arena-muted">· {row.hw.vramGB} GB · {t('arenaRam', { gb: row.hw.ramGB })}</span></div>
          <div className="arena-podium-value">{number(row.decode.median)}<small>tok/s</small></div>
          <div className="arena-podium-foot">{chips(row.params)}</div>
        </div>)}</div>
        <table className="arena-table">
          <colgroup><col style={{ width: 44 }}/><col/><col style={{ width: '21%' }}/><col style={{ width: 84 }}/><col style={{ width: 78 }}/><col style={{ width: 78 }}/><col style={{ width: 70 }}/></colgroup>
          <thead><tr><th/><th>{t('arenaColConfig')}</th><th>{t('arenaColRange')}</th><th className="r">{t('arenaColMedian')}</th><th className="r">{t('arenaColPrefill')}</th><th className="r">128K</th><th className="r">{t('arenaColMachines')}</th></tr></thead>
          <tbody>{rows.map((row, index) => { const me = row === myRow; return <tr key={index} className={me ? 'me' : ''}>
            <td className="arena-rank">{String(row.rank ?? index + 1).padStart(2, '0')}</td>
            <td><div className="arena-hw"><b>{gpuLabel(row.hw.gpu)}</b> <span className="arena-muted">{row.hw.vramGB} GB · {t('arenaRam', { gb: row.hw.ramGB })}</span>{me && <span className="arena-tag mine">{t('arenaMine')}</span>}{row.seed && <span className="arena-tag">{t('arenaSeed')}</span>}</div>{chips(row.params)}</td>
            <td><span className="arena-range" title={`p25 ${number(row.decode.p25)} · p75 ${number(row.decode.p75)}`}>
              {board.tierMedian != null && <span className="ref" style={{ left: x(board.tierMedian) }}/>}
              {row.decode.p25 != null && row.decode.p75 != null && <span className="iqr" style={{ left: x(row.decode.p25), width: `calc(${x(row.decode.p75)} - ${x(row.decode.p25)})` }}/>}
              <i style={{ left: x(row.decode.median) }}/>{me && myDecode != null && <b className="you" style={{ left: x(myDecode) }}/>}
            </span></td>
            <td className="r"><span className="arena-value">{number(row.decode.median)}</span>{me && myDecode != null && <small className="arena-up">{t('arenaYou', { value: number(myDecode) })}</small>}</td>
            <td className="r arena-num">{number(row.prefill, 0)}</td>
            <td className="r arena-num">{number(row.decode128k)}</td>
            <td className="r"><Signal machines={row.machines} seed={row.seed}/> <span className="arena-num arena-muted">{row.machines}</span></td>
          </tr>; })}</tbody>
        </table>
        <div className="arena-axis"><span/><div><div className="arena-ticks">{ticks.map(v => <span key={v} style={{ left: x(v) }}>{v}</span>)}</div><small className="arena-muted">{t('arenaLegend', { median: number(board.tierMedian) })}</small></div></div>
        <p className="arena-foot arena-muted">{t('arenaFootnote', { model: label.model, quant: label.quant })}</p>
      </>}
    </section>
    {side}
  </div>{withdrawDialog}</div>;
}
