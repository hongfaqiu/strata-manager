import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Check, Download, FlaskConical, LoaderCircle, Play, RotateCcw, Square } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { TuningJob, TuningScene } from '@strata-manager/core';
import { Panel, Metric } from '../components';
import { Dropdown, Toggle } from '../OfficialControls';
import './tuning.css';

const zh = {
  title: '为这台电脑实测调优', intro: '用同一模型和代表性任务比较参数；保留质量检查和重复测量结果，再决定是否应用。',
  profile: '请先准备一个本机模型。', native: '调优需要在桌面应用中进行。', ownership: '等待后台接管并准备模型后即可开始。',
  scenes: '测试场景', chat: '短对话', code: '代码生成', chinese: '中文长回答', rounds: '重复轮数', tokens: '每次输出上限',
  scope: '比较 PCIe 预算与 MTP 参数。测量期间暂时占用模型，其他请求会等待或提示忙碌。测试保留当前配置，应用推荐时才重启服务。',
  start: '开始实测', cancel: '取消测试', progress: '测量进度', requests: '请求', baseline: '当前参数', candidates: '候选参数',
  pcie: 'PCIe 预算', mtp: 'MTP 阈值', gain: '生成速度收益', drift: '基线漂移', result: '重复测量结论', apply: '应用并验证',
  restore: '恢复原参数', noRecommendation: '没有发现可靠收益，继续使用当前参数。', recommended: '已通过重复收益和输出一致性检查。',
  details: '测量明细', scene: '场景', role: '位置', cache: '提示缓存', ttft: '首 Token', visible: '首个正文', speed: '生成速度',
  output: '输出 Token', quality: '完整性 / 输出一致性', ok: '通过', mismatch: '未通过', export: '导出报告',
  distinctPrompt: '独立提示', repeatedPrefix: '重复前缀', baselineBefore: '前基线', candidate: '候选', baselineAfter: '后基线',
  checking: '检查模型与环境', running: '测量中', canceling: '正在取消', completed: '测量完成', canceled: '已取消', failed: '测量失败',
  interrupted: '测量中断', applying: '正在应用与验证', applied: '已应用', rollingBack: '正在恢复', restored: '已恢复',
  reproducibleGain: '收益可重复', noReliableGain: '收益未超过漂移', qualityMismatch: '输出质量不一致', incomplete: '输出不完整', missingMetrics: '缺少性能数据',
  explanation: '独立提示与重复前缀区分缓存条件；首 Token 与首个正文区分思考时间。收益来自本次测量，不代表其他机器或所有任务。',
};
const en: Record<keyof typeof zh, string> = {
  title: 'Measure tuning on this computer', intro: 'Compare parameters with the same model and representative tasks. Review repeated measurements and output checks before applying.',
  profile: 'Prepare a local model first.', native: 'Tuning requires the desktop application.', ownership: 'Wait for the background service to take ownership and prepare the model.',
  scenes: 'Test scenarios', chat: 'Short chat', code: 'Code generation', chinese: 'Long Chinese response', rounds: 'Repeated rounds', tokens: 'Output limit per request',
  scope: 'Compare PCIe budget and MTP parameters. Tuning temporarily occupies the model; other requests wait or report busy. Measurements preserve the current configuration. Applying a recommendation restarts the service.',
  start: 'Start measurement', cancel: 'Cancel test', progress: 'Measurement progress', requests: 'requests', baseline: 'Current parameters', candidates: 'Candidate parameters',
  pcie: 'PCIe budget', mtp: 'MTP threshold', gain: 'Decode speed gain', drift: 'Baseline drift', result: 'Repeated measurement result', apply: 'Apply and verify',
  restore: 'Restore original parameters', noRecommendation: 'No reliable gain was found. Keep the current parameters.', recommended: 'Passed repeated performance and output consistency checks.',
  details: 'Measurement details', scene: 'Scenario', role: 'Position', cache: 'Prompt cache', ttft: 'First token', visible: 'First visible text', speed: 'Decode speed',
  output: 'Output tokens', quality: 'Completion / output consistency', ok: 'Passed', mismatch: 'Not passed', export: 'Export report',
  distinctPrompt: 'Distinct prompt', repeatedPrefix: 'Repeated prefix', baselineBefore: 'Baseline before', candidate: 'Candidate', baselineAfter: 'Baseline after',
  checking: 'Checking model and environment', running: 'Measuring', canceling: 'Canceling', completed: 'Measurement complete', canceled: 'Canceled', failed: 'Measurement failed',
  interrupted: 'Measurement interrupted', applying: 'Applying and verifying', applied: 'Applied', rollingBack: 'Restoring', restored: 'Restored',
  reproducibleGain: 'Reproducible gain', noReliableGain: 'Gain below measured drift', qualityMismatch: 'Output quality mismatch', incomplete: 'Incomplete output', missingMetrics: 'Missing performance data',
  explanation: 'Distinct prompts and repeated prefixes separate cache conditions. First token and first visible text separate reasoning time. Gains describe this measurement, not every computer or workload.',
};
const activeStates = new Set<TuningJob['state']>(['checking', 'running', 'canceling', 'applying', 'rollingBack']);
const cancelableStates = new Set<TuningJob['state']>(['checking', 'running', 'canceling']);

export function TuningPage({ profileId, language, desktop, owned, streaming, onChanged }: { profileId?: string; language: 'zh-CN' | 'en'; desktop: boolean; owned: boolean; streaming: boolean; onChanged: () => void }) {
  const text = language === 'zh-CN' ? zh : en;
  const query = useQueryClient();
  const [scenes, setScenes] = useState<TuningScene[]>(['chat', 'code', 'chinese']);
  const [rounds, setRounds] = useState(2);
  const [maxTokens, setMaxTokens] = useState(512);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const status = useQuery({ queryKey: ['tuning', profileId], queryFn: () => core.tuningStatus(profileId!), enabled: desktop && !!profileId, refetchInterval: data => activeStates.has(data.state.data?.state as TuningJob['state']) ? 1000 : 5000, refetchIntervalInBackground: true });
  const job = status.data;
  const active = !!job && activeStates.has(job.state);
  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await operation(); await query.invalidateQueries({ queryKey: ['tuning', profileId] }); onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const numeric = (value: number | null | undefined, digits = 2) => value == null ? '—' : value.toLocaleString(language, { maximumFractionDigits: digits });
  const exportReport = () => {
    if (!job) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(job, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `strata-tuning-${new Date(job.startedAt).toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return <div className="tuning-page">
    <div className="tuning-heading"><div><h2><FlaskConical size={19}/>{text.title}</h2><p>{text.intro}</p></div></div>
    {!desktop || !profileId || !owned ? <p className="notice">{!desktop ? text.native : !profileId ? text.profile : text.ownership}</p> : null}
    <Panel title={text.scenes}>
      <div className="tuning-options">{(['chat', 'code', 'chinese'] as const).map(scene => <label key={scene}><Toggle ariaLabel={text[scene]} checked={scenes.includes(scene)} disabled={active || busy} onCheckedChange={checked => setScenes(old => checked ? [...old, scene] : old.filter(item => item !== scene))}/>{text[scene]}</label>)}</div>
      <div className="tuning-fields"><label><span>{text.rounds}</span><Dropdown ariaLabel={text.rounds} value={String(rounds)} disabled={active || busy} options={[2, 3, 4].map(value => ({ value: String(value), label: String(value) }))} onValueChange={value => setRounds(Number(value))}/></label><label><span>{text.tokens}</span><Dropdown ariaLabel={text.tokens} value={String(maxTokens)} disabled={active || busy} options={[128, 256, 512, 1024].map(value => ({ value: String(value), label: String(value) }))} onValueChange={value => setMaxTokens(Number(value))}/></label></div>
      <p className="subtle">{text.scope}</p>
      <div className="actions"><button className="primary" disabled={!desktop || !profileId || !owned || streaming || active || busy || !scenes.length} onClick={() => void run(() => core.tuningStart(profileId!, { scenes, rounds, maxTokens }))}><Play size={15}/>{text.start}</button>{job && cancelableStates.has(job.state) && <button disabled={busy || job.state === 'canceling'} onClick={() => void run(() => core.tuningCancel(job.id))}><Square size={15}/>{text.cancel}</button>}</div>
    </Panel>
    {(error || status.error || job?.error) && <div className="notice error" role="alert">{error || String(status.error ?? job?.error)}</div>}
    {job && <>
      <Panel title={text.progress} action={<button onClick={exportReport}><Download size={14}/>{text.export}</button>}>
        <div className="tuning-progress" role="status" aria-live="polite">{active ? <LoaderCircle className="spin" size={16}/> : <Activity size={16}/>}<strong>{text[job.state]}</strong><span>{job.completedRequests} / {job.totalRequests} {text.requests}</span></div>
        <div className="st-progress" role="progressbar" aria-label={text.progress} aria-valuenow={job.completedRequests} aria-valuemin={0} aria-valuemax={job.totalRequests}><div className="st-progress__bar" style={{ width: `${job.totalRequests > 0 ? job.completedRequests / job.totalRequests * 100 : 0}%` }}/></div>
        <div className="metrics-grid"><Metric label={`${text.baseline} · ${text.pcie}`} value={numeric(job.baseline.pcieFrac)}/><Metric label={`${text.baseline} · ${text.mtp}`} value={numeric(job.baseline.specMinP)}/></div>
      </Panel>
      <Panel title={text.candidates}>
        <div className="table-wrap"><table className="st-table"><thead><tr><th>{text.pcie}</th><th>{text.mtp}</th><th>{text.gain}</th><th>{text.drift}</th><th>{text.result}</th><th/></tr></thead><tbody>{job.candidates.map(candidate => <tr key={candidate.id}><td>{numeric(candidate.pcieFrac)}</td><td>{numeric(candidate.specMinP)}</td><td>{candidate.evaluation?.gain == null ? '—' : `${numeric(candidate.evaluation.gain * 100, 1)}%`}</td><td>{candidate.evaluation?.drift == null ? '—' : `${numeric(candidate.evaluation.drift * 100, 1)}%`}</td><td>{candidate.evaluation ? text[candidate.evaluation.reason] : '—'}</td><td>{candidate.id === job.recommendedCandidateId && candidate.evaluation?.accepted && <button className="primary" disabled={active || busy || streaming || job.state !== 'completed'} onClick={() => void run(() => core.tuningApply(job.id, candidate.id))}><Check size={14}/>{text.apply}</button>}</td></tr>)}</tbody></table></div>
        {job.state === 'completed' && <p className="subtle">{job.recommendedCandidateId ? text.recommended : text.noRecommendation}</p>}
        {job.state === 'applied' && <button disabled={busy || streaming} onClick={() => void run(() => core.tuningRestore(job.id))}><RotateCcw size={15}/>{text.restore}</button>}
      </Panel>
      <Panel title={text.details}><p className="subtle">{text.explanation}</p><div className="table-wrap"><table className="st-table"><thead><tr><th>{text.scene}</th><th>{text.role}</th><th>{text.cache}</th><th>{text.ttft}</th><th>{text.visible}</th><th>{text.speed}</th><th>{text.output}</th><th>{text.quality}</th></tr></thead><tbody>{job.measurements.map(measurement => <tr key={measurement.id}><td>{text[measurement.scene]} · {measurement.round + 1}</td><td>{text[measurement.position]}</td><td>{text[measurement.cacheMode]}</td><td>{measurement.firstTokenMs == null ? '—' : `${numeric(measurement.firstTokenMs / 1000)} s`}</td><td>{measurement.firstVisibleMs == null ? '—' : `${numeric(measurement.firstVisibleMs / 1000)} s`}</td><td>{numeric(measurement.decodeTokS)} tok/s</td><td>{numeric(measurement.outputTokens, 0)}</td><td title={measurement.error}>{measurement.complete && measurement.qualityPassed ? text.ok : text.mismatch}</td></tr>)}</tbody></table></div></Panel>
    </>}
  </div>;
}
