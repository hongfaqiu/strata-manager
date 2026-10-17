import type { AppLanguage, ConcurrencyCandidate, ConcurrencyCandidateResult, ServiceProfile } from '@strata-manager/core';
import * as core from '@strata-manager/core';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LoaderCircle, Play, Save, Square } from 'lucide-react';
import { Dialog } from '../../components';
import { Toggle } from '../../OfficialControls';
import { ConcurrencyChart } from '../ConcurrencyChart';
import { useConcurrencyHardware } from '../ConcurrencyCard';
import { cancelComparison, comparisonRunning, comparisonSnapshot, comparisonSubscribe, loadComparison, runComparison, saveCandidateVersions, type ComparisonState } from './concurrencyComparisonRunner';
import '../concurrency-ladder.css';
import './concurrency-comparison.css';

export interface ConcurrencyComparisonViewProps {
  zh: boolean;
  candidates: ConcurrencyCandidate[];
  recommended: number;
  state: ComparisonState;
  experimental: boolean;
  canSave: boolean;
  canRun: boolean;
  unavailable?: string;
  onExperimental?: (on: boolean) => void;
  onSave?: () => void;
  onRun?: () => void;
  onCancel?: () => void;
}

const fmt = (value: number | null, digits = 1) => value === null ? '—' : value.toFixed(digits);

export function candidateLabel(candidate: Pick<ConcurrencyCandidate, 'parallel' | 'experimental'>, zh: boolean): string {
  const base = candidate.parallel <= 1 ? (zh ? '一次一个' : 'One at a time') : zh ? `${candidate.parallel} 个同时` : `${candidate.parallel} at once`;
  return candidate.experimental ? `${base}${zh ? ' + 实验' : ' + experimental'}` : base;
}

/** Pure view: candidates, optional version saving and restart run, vertical bars + verdict. */
export function ConcurrencyComparisonView({ zh, candidates, recommended, state, experimental, canSave, canRun, unavailable, onExperimental, onSave, onRun, onCancel }: ConcurrencyComparisonViewProps) {
  const t = (cn: string, en: string) => zh ? cn : en;
  const running = ['saving', 'switching', 'measuring', 'restoring'].includes(state.phase);
  const result = (id: string) => state.results.find(item => item.id === id);
  const measured = state.results.filter(item => item.peakTotalTokS !== null);
  const best = measured.length ? measured.reduce((a, b) => b.peakTotalTokS! > a.peakTotalTokS! ? b : a) : null;
  const bestCandidate = best ? candidates.find(item => item.id === best.id) : null;
  const solo = state.results.find(item => item.id === 'p1');
  const current = candidates.find(item => item.id === state.current);
  const saved = candidates.filter(item => state.versions[item.id]).length;
  const items = candidates.map(candidate => { const r = result(candidate.id); return { key: candidate.id, label: candidateLabel(candidate, zh), total: r?.peakTotalTokS ?? null, perRequest: r?.soloTokS ?? null, highlight: best?.id === candidate.id, pending: running && state.current === candidate.id }; });
  return <section className="concurrency-comparison" data-testid="concurrency-comparison" data-phase={state.phase}>
    <header>
      <div><h3>{t('并发对比', 'Concurrency comparison')}</h3><p>{t('把几种并发数各存成一个配置版本，依次重启并跑并发阶梯，比较总吞吐和单个请求速度。两步都可选，原配置不会被改动。', 'Save each slot count as its own configuration version, then optionally restart into each and run the ladder to compare total throughput and single-request speed. The original configuration is never changed.')}</p></div>
    </header>
    {unavailable && <p className="concurrency-comparison-note">{unavailable}</p>}
    <ol className="concurrency-comparison-candidates">
      {candidates.map(candidate => { const version = state.versions[candidate.id]; const r = result(candidate.id); return <li key={candidate.id} data-current={state.current === candidate.id || undefined}>
        <strong>{candidateLabel(candidate, zh)}{candidate.parallel === recommended && !candidate.experimental && <em>{t('推荐', 'Recommended')}</em>}</strong>
        <code>{candidate.edits.filter(edit => edit.value !== '').map(edit => edit.key.startsWith('env.') ? `${edit.key.slice(4)}=1` : edit.value === 'true' ? edit.key : `${edit.key} ${edit.value}`).join(' ') || t('不设 parallel', 'no parallel')}</code>
        <span>{version ? version.configPath.split(/[\\/]/).at(-1) : t('未保存', 'not saved')}</span>
        {r?.error && <span className="concurrency-comparison-error">{r.error === 'not_saved' ? t('未保存，已跳过', 'not saved; skipped') : r.error}</span>}
      </li>; })}
    </ol>
    <label className="concurrency-comparison-exp"><Toggle ariaLabel={t('加入实验开关候选', 'Add an experimental candidate')} checked={experimental} disabled={running} onCheckedChange={on => onExperimental?.(on)}/><span><b>{t('加入实验开关候选', 'Add an experimental candidate')}</b><em className="concurrency-card-tag">{t('实验', 'Experimental')}</em><small>{t('推荐并发数 + STRATA_BATCH_ATTN_ROWS / STRATA_BATCH_GDN_GROUPS，官方默认关闭。', 'Recommended slots + STRATA_BATCH_ATTN_ROWS / STRATA_BATCH_GDN_GROUPS, off by default upstream.')}</small></span></label>
    <div className="concurrency-comparison-actions">
      <button type="button" disabled={!canSave || running || saved === candidates.length} onClick={onSave} data-testid="concurrency-save-versions"><Save size={14}/>{saved === candidates.length ? t('已保存全部版本', 'All versions saved') : t(`另存为 ${candidates.length - saved} 个配置版本`, `Save ${candidates.length - saved} configuration versions`)}</button>
      {running ? <button type="button" className="benchmark-stop" onClick={onCancel}><Square size={14}/>{t('停止并恢复', 'Stop and restore')}</button>
        : <button type="button" className="primary" disabled={!canRun || saved === 0} onClick={onRun} data-testid="concurrency-run"><Play size={14}/>{t('依次重启并测量', 'Restart into each and measure')}</button>}
      <small>{t(`约 ${Math.max(1, Math.round(candidates.reduce((sum, c) => sum + core.concurrencyLadderLevels(Math.max(2, c.parallel)).length * 0.5 + 1.5, 0)))} 分钟，期间模型会多次重启。`, `About ${Math.max(1, Math.round(candidates.reduce((sum, c) => sum + core.concurrencyLadderLevels(Math.max(2, c.parallel)).length * 0.5 + 1.5, 0)))} min; the model restarts several times.`)}</small>
    </div>
    {running && <p className="concurrency-comparison-status" role="status"><LoaderCircle size={14} className="spin"/>{state.phase === 'saving' ? t('正在保存配置版本…', 'Saving configuration versions…') : state.phase === 'restoring' ? t('正在切回原配置…', 'Switching back to the original configuration…') : current ? state.phase === 'switching' ? t(`正在切换到「${candidateLabel(current, true)}」并等待模型就绪…`, `Switching to “${candidateLabel(current, false)}” and waiting for the model…`) : t(`测量「${candidateLabel(current, true)}」：第 ${state.stage?.index ?? 1}/${state.stage?.total ?? 1} 级 · ${state.stage?.concurrency ?? 1} 个同时`, `Measuring “${candidateLabel(current, false)}”: step ${state.stage?.index ?? 1}/${state.stage?.total ?? 1} · ${state.stage?.concurrency ?? 1} at once`) : ''}</p>}
    {state.error && <p className="concurrency-comparison-error" role="alert">{state.error}</p>}
    {bestCandidate && best && !running && <p className="concurrency-comparison-verdict" data-testid="concurrency-comparison-verdict">{bestCandidate.parallel > 1
      ? t(`「${candidateLabel(bestCandidate, true)}」总吞吐最高：${fmt(best.peakTotalTokS, 0)} tok/s${solo?.peakTotalTokS ? `（一次一个 ${fmt(solo.peakTotalTokS, 0)}）` : ''}；单个请求 ${fmt(best.soloTokS)} tok/s${solo?.soloTokS && best.soloTokS ? `（${best.soloTokS >= solo.soloTokS ? '+' : '−'}${Math.abs(Math.round((best.soloTokS / solo.soloTokS - 1) * 100))}%）` : ''}。`, `“${candidateLabel(bestCandidate, false)}” gives the most total throughput: ${fmt(best.peakTotalTokS, 0)} tok/s${solo?.peakTotalTokS ? ` (one at a time ${fmt(solo.peakTotalTokS, 0)})` : ''}; one request alone ${fmt(best.soloTokS)} tok/s.`)
      : t('一次一个总吞吐最高，这台电脑不建议开启并发。', 'One at a time gives the most total throughput; concurrency is not worth it here.')}</p>}
    {(running || measured.length > 0) && <div className="concurrency-comparison-body">
      <ConcurrencyChart items={items} zh={zh} ariaLabel={t('并发对比结果', 'Concurrency comparison results')}/>
      <table className="concurrency-ladder-table">
        <thead><tr><th>{t('配置版本', 'Version')}</th><th>{t('峰值总吞吐', 'Peak total')}</th><th>{t('单个请求', 'One request')}</th><th>{t('最高级 TTFT P95', 'TTFT P95 at top step')}</th></tr></thead>
        <tbody>{candidates.map(candidate => { const r: ConcurrencyCandidateResult | undefined = result(candidate.id); return <tr key={candidate.id} data-best={best?.id === candidate.id || undefined}><td>{candidateLabel(candidate, zh)}</td><td>{fmt(r?.peakTotalTokS ?? null)} <small>tok/s</small></td><td>{fmt(r?.soloTokS ?? null)} <small>tok/s</small></td><td>{r?.topTtftP95Ms == null ? '—' : (r.topTtftP95Ms / 1000).toFixed(2)} <small>s</small></td></tr>; })}</tbody>
      </table>
    </div>}
  </section>;
}

/** Container: reads the current config and hardware, saves versions and drives the restart run. */
export function ConcurrencyComparison({ profile, language, desktop, disabled, onSwitchVersion, onChanged }: { profile?: ServiceProfile; language: AppLanguage; desktop: boolean; disabled: boolean; onSwitchVersion?: (profile: ServiceProfile) => Promise<void>; onChanged?: () => void }) {
  const zh = language === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en;
  const state = useSyncExternalStore(comparisonSubscribe, comparisonSnapshot);
  const [experimental, setExperimental] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const base = state.baseProfileId && comparisonRunning() ? undefined : profile;
  useEffect(() => { if (profile?.id) void loadComparison(profile.id); }, [profile?.id]);
  const snapshot = useQuery({ queryKey: ['concurrency-comparison-config', base?.id, base?.configPath], enabled: desktop && !!base, queryFn: () => core.readConfigSnapshot(base!), staleTime: 10_000 });
  const config = snapshot.data?.config;
  const settings = useMemo(() => config ? core.readConcurrencySettings(config) : null, [config]);
  const identity = useMemo(() => config ? core.concurrencyModelIdentity(config) : null, [config]);
  const hardware = useConcurrencyHardware({ installationId: base?.id, desktop, identity, settings: settings ?? core.readConcurrencySettings({}) });
  const arenaGb = identity ? core.modelExpertArenaGb(identity.family, identity.quant) : null;
  const plan = useMemo(() => settings ? core.recommendConcurrency({ settings, hardware, arenaGb, useCase: 'multiUser' }) : null, [settings, hardware, arenaGb]);
  const candidates = useMemo(() => comparisonRunning() || (state.baseProfileId === profile?.id && state.candidates.length && state.phase !== 'idle') ? state.candidates : settings && plan ? core.concurrencyComparisonCandidates(settings, plan, { experimental }) : [], [settings, plan, experimental, state, profile?.id]);
  const recommended = plan ? Math.max(2, plan.officialParallel, plan.parallel) : 2;
  const mac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent) && !/Windows/i.test(navigator.userAgent);
  const unavailable = !desktop ? t('并发对比需要在桌面应用中进行。', 'The comparison runs in the desktop app.') : mac ? t('Mac（Metal）暂不支持并发（上游 #2715）。', 'Concurrency is not supported on Mac (Metal) yet (upstream #2715).') : !onSwitchVersion ? t('当前服务不由本应用管理，只能保存配置版本，不能自动重启测量。', 'This service is not managed by the app: versions can be saved, but not measured by restarting.') : undefined;
  if (!profile) return null;
  return <>
    <ConcurrencyComparisonView zh={zh} candidates={candidates} recommended={recommended} state={state.baseProfileId === profile.id || comparisonRunning() ? state : { phase: 'idle', candidates: [], versions: {}, results: [] }} experimental={experimental}
      canSave={desktop && !mac && !!config && !disabled} canRun={desktop && !mac && !!onSwitchVersion && !disabled} unavailable={unavailable}
      onExperimental={on => setExperimental(on)} onSave={() => void saveCandidateVersions(profile, candidates).then(() => onChanged?.()).catch(() => {})} onRun={() => setConfirm(true)} onCancel={cancelComparison}/>
    {confirm && <Dialog title={t('依次重启并测量？', 'Restart into each version and measure?')} onClose={() => setConfirm(false)}>
      <p>{t('将依次切换到已保存的配置版本，各跑一次并发阶梯；期间模型会多次重启，其他请求不可用。结束或停止后自动切回当前配置。', 'The app switches to each saved version and runs a ladder on it. The model restarts several times and is unavailable meanwhile. It switches back to the current configuration when done or stopped.')}</p>
      <div className="actions"><button type="button" onClick={() => setConfirm(false)}>{t('取消', 'Cancel')}</button><button type="button" className="primary" onClick={() => { setConfirm(false); void runComparison(profile, onSwitchVersion!).then(() => onChanged?.()); }}>{t('开始', 'Start')}</button></div>
    </Dialog>}
  </>;
}

/** Quick calibration measures one request at a time; with slots on, say so beside its result. */
export function QuickCalibrationConcurrencyNote({ profile, desktop, language }: { profile?: ServiceProfile; desktop: boolean; language: AppLanguage }) {
  const snapshot = useQuery({ queryKey: ['concurrency-comparison-config', profile?.id, profile?.configPath], enabled: desktop && !!profile, queryFn: () => core.readConfigSnapshot(profile!), staleTime: 10_000 });
  const parallel = snapshot.data ? core.readConcurrencySettings(snapshot.data.config).parallel : 1;
  if (parallel <= 1) return null;
  return <p className="notice concurrency-calibration-note" role="status" data-testid="calibration-concurrency-note">{language === 'zh-CN'
    ? `当前配置开启了 ${parallel} 个并发槽。快速校准一次只测一个请求，PCIe 预算等结果对并发负载不完全有代表性；并发效果请看下方「并发对比」。`
    : `This configuration runs ${parallel} slots. Quick calibration measures one request at a time, so results such as the PCIe budget do not fully represent concurrent load; see “Concurrency comparison” below.`}</p>;
}
