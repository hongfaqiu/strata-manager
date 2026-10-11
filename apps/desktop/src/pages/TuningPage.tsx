import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Check, CircleHelp, Download, FlaskConical, LoaderCircle, Play, RotateCcw, Square } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { TuningJob, TuningScene, TuningUseCase, TuningRestartParameters, TuningWorkloadKind } from '@strata-manager/core';
import { Dialog, Panel, Metric } from '../components';
import { Dropdown, Toggle } from '../OfficialControls';
import './tuning.css';
import { ExpertAdaptationCandidates } from './ExpertAdaptationCandidates';

const zh = {
  title: '为这台电脑实测调优', intro: '用同一模型和代表性任务比较参数；保留质量检查和重复测量结果，再决定是否应用。',
  profile: '请先准备一个本机模型。', native: '调优需要在桌面应用中进行。', ownership: '等待后台接管并准备模型后即可开始。',
  scenes: '测试场景', chat: '短对话', code: '代码生成', chinese: '中文长回答', rounds: '重复轮数', tokens: '每次输出上限',
  scope: '诊断比较 PCIe 预算与 MTP 参数。测量期间暂时占用模型，其他请求会等待或提示忙碌。测试保留当前配置；新参数的应用需要完整场景报告。',
  start: '开始实测', cancel: '取消测试', progress: '测量进度', requests: '请求', baseline: '当前参数', candidates: '候选参数',
  pcie: 'PCIe 预算', mtp: 'MTP 阈值', gain: '生成速度收益', drift: '基线漂移', result: '重复测量结论', apply: '应用并验证',
  restore: '恢复原参数', noRecommendation: '没有发现可靠收益，继续使用当前参数。', recommended: '已通过重复收益和输出一致性检查。', enabled: '启用', disabled: '关闭',
  details: '测量明细', scene: '场景', role: '位置', cache: '提示缓存', ttft: '首 Token', visible: '首个正文', speed: '生成速度',
  output: '输出 Token', quality: '输出检查', ok: '通过', mismatch: '未通过', export: '导出报告',
  distinctPrompt: '独立提示', repeatedPrefix: '重复前缀', baselineBefore: '前基线', candidate: '候选', baselineAfter: '后基线',
  checking: '检查模型与环境', running: '测量中', canceling: '正在取消', completed: '测量完成', canceled: '已取消', failed: '测量失败',
  interrupted: '测量中断', applying: '正在应用与验证', applied: '已应用', rollingBack: '正在恢复', restored: '已恢复',
  reproducibleGain: '收益可重复', noReliableGain: '收益未超过漂移', qualityMismatch: '输出质量不一致', incomplete: '输出不完整', missingMetrics: '缺少性能数据',
  explanation: '检查输出完整性与重复结果一致性；代码场景还检查合并算法在空列表、重复值等输入上的正确性。收益来自本次测量，不代表完整项目或所有任务。',
  fullScenarioGain: '完整场景收益可重复', noReliableFullScenarioGain: '未发现可靠完整场景收益', incompleteWorkloads: '场景测量不完整', semanticQualityFailed: '实际任务质量未通过', missingWorkloadTimings: '缺少任务耗时', stableSemanticGain: '任务收益可重复', noReliableGainBeyondDrift: '任务收益未超过漂移', wallGain: '执行耗时收益', deadline: '单任务期限',
  startupVerification: '启动参数核验', requested: '请求值', observed: '观测值', unpublished: '未公开', effective: '已核验有效值', upperBound: '已核验启动上限', reservationRequest: '已核验预留请求', startupRequest: '已核验启动请求', startupHint: '预填充分块可能动态缩小。启动上限与预留请求不等于实际分块或可用显存；未知有效状态不会当作已生效。', testDeadline: '测量期限', recoveryDeadline: '恢复期限', generationLimit: '最大生成请求', outputBudget: '输出 Token 上限', budgetHint: '输出上限只估计生成预算，不含输入、思考或计数校准；硬期限不代表预计耗时。',
  useCase: '你主要怎样使用模型？', daily: '日常聊天', agent: '编程与 Agent', longDocument: '长文分析',
  scenarioScope: '测量所选用途的完整任务，并分别检查缓存复用、会话切换和输出质量。测试期间其他请求会等待或提示忙碌；测量结束后恢复原配置，推荐结果由你决定是否应用。',
  advanced: '高级测试设置', diagnostic: '仅运行短请求诊断', diagnosticHint: '保留原短对话、代码与中文探针；不能代替完整场景结论，也不能从诊断报告应用新参数。',
  contextLimit: '本次上下文上限', contextHint: '限制本次测量，不更改模型容量。长文至少需要 16K 文档及回答余量；超出当前模型容量时后台会拒绝开始。',
  includeVision: '同时检查图像理解', visionHint: '需要当前模型已经配置图像支持；不会下载图像模型或安装组件。未勾选时视觉仍未测试。',
  restartTitle: '需要重启的候选', restartHint: '最多四个独立候选，每次只改一个选项。后台会核验能力与资源，保存恢复记录，加载候选后再复测原配置。',
  workerTest: '比较 CPU 工作线程', worker: '候选线程数', asyncTest: '比较异步换入', asyncValue: '候选启用异步换入',
  prefillTest: '比较预填充分块', prefill: '候选分块 Token', reserveTest: '比较显存预留', reserve: '候选预留 MiB', reserveHint: '仅允许增加现有预留；原值或生效能力未知时会拒绝候选。',
  durationHint: '完整测量最多 2 小时，单个长文检索任务最多 20 分钟，其余任务最多 10 分钟。取消或超时后仍须恢复原配置，恢复另有 7 分钟期限。这些是硬期限，不是预计耗时；下方显示实际阶段和已用时间。',
  fullScope: '完整场景报告', diagnosticScope: '短请求诊断报告', legacyScope: '历史短请求报告', legacyHint: '该报告不包含完整场景验收，不能新应用推荐参数。已应用的原参数仍可恢复。',
  resultFor: '查看候选结果', requestCandidate: '请求参数', restartCandidate: '重启参数', samples: '样本', elapsed: '已用时间', workloadProgress: '场景',
  waitingForIdle: '等待模型空闲', loading: '加载测试配置', restoringBaseline: '恢复原配置并核验服务', finished: '阶段已结束',
  coldInput: '冷输入', hotPrefix: '热前缀', sessionSwitch: '切换会话', sustainedGeneration: '持续生成', fullAgent: '完整 Agent', longRetrieval: '长文检索', vision: '视觉',
  wall: '任务总耗时', fullAgentWall: 'Agent 总耗时（含工具处理）', notTested: '未测试', coldVerified: '已核验重新加载模型', coldUnverified: '未核验模型冷加载；不代表磁盘缓存冷启动',
  resourceTitle: '资源成本', ramPeak: '本机 RAM 占用峰值', gpuPeak: '主 GPU 显存占用峰值', resourceHint: '测量期间整机 RAM 与主 GPU 总占用的观测峰值，包含其它进程，不是模型独占成本或容量保证；缺少遥测时显示未测。',
  resourceUnknown: '无法核验资源余量', insufficientResourceHeadroom: '抽样资源余量不足', resourceChecked: '抽样余量达到门槛', resourceUnknownBlocked: '资源余量未核验，无法应用此候选。', resourceLowBlocked: '抽样余量不足，无法应用此候选。', resourceFloor: '最低抽样余量', resourceSamples: '资源样本', ramTotal: '基线记录的 RAM 总容量', gpuTotal: '基线记录的主 GPU 显存总容量', resourceGateHint: '按整机 RAM 与主 GPU 样本做保守判断。采样可能遗漏峰值，达到余量门槛也不能保证没有内存或显存耗尽。', gainTimingHint: '收益比较普通任务各次生成请求耗时之和，不含 Token 计数校准；Agent 比较包含工具闭环的完整耗时。上方任务总耗时仍包含校准，与收益口径不同。',
  contextMeasured: '实际输入 / 目标 Token', cachedTokens: '实际缓存 Token', unknownResource: '未测', checks: '实际质量检查', outputComplete: '完整输出',
  recoveryTitle: '配置与服务恢复', notNeeded: '无需恢复', pending: '已保存恢复记录', restoring: '正在恢复原配置', recoveryRestored: '恢复完成', recoveryFailed: '恢复失败，需要修复',
  configurationRestored: '原配置已恢复', serviceVerified: '服务已重新核验', notVerified: '尚未核验', workloadDetails: '完整任务明细', diagnosticDetails: '短请求测量明细',
  scopeExplanation: '按本次实际完成的任务显示质量和耗时；未测的用途不会显示通过。报告只含计时、用量与检查结果，不含提示、回答或工具正文。',
};
const en: Record<keyof typeof zh, string> = {
  title: 'Measure tuning on this computer', intro: 'Compare parameters with the same model and representative tasks. Review repeated measurements and output checks before applying.',
  profile: 'Prepare a local model first.', native: 'Tuning requires the desktop application.', ownership: 'Wait for the background service to take ownership and prepare the model.',
  scenes: 'Test scenarios', chat: 'Short chat', code: 'Code generation', chinese: 'Long Chinese response', rounds: 'Repeated rounds', tokens: 'Output limit per request',
  scope: 'Diagnose PCIe budget and MTP parameters. Tuning temporarily occupies the model; other requests wait or report busy. Measurements preserve the current configuration. Applying new parameters requires a full scenario report.',
  start: 'Start measurement', cancel: 'Cancel test', progress: 'Measurement progress', requests: 'requests', baseline: 'Current parameters', candidates: 'Candidate parameters',
  pcie: 'PCIe budget', mtp: 'MTP threshold', gain: 'Decode speed gain', drift: 'Baseline drift', result: 'Repeated measurement result', apply: 'Apply and verify',
  restore: 'Restore original parameters', noRecommendation: 'No reliable gain was found. Keep the current parameters.', recommended: 'Passed repeated performance and output consistency checks.', enabled: 'Enabled', disabled: 'Disabled',
  details: 'Measurement details', scene: 'Scenario', role: 'Position', cache: 'Prompt cache', ttft: 'First token', visible: 'First visible text', speed: 'Decode speed',
  output: 'Output tokens', quality: 'Output checks', ok: 'Passed', mismatch: 'Not passed', export: 'Export report',
  distinctPrompt: 'Distinct prompt', repeatedPrefix: 'Repeated prefix', baselineBefore: 'Baseline before', candidate: 'Candidate', baselineAfter: 'Baseline after',
  checking: 'Checking model and environment', running: 'Measuring', canceling: 'Canceling', completed: 'Measurement complete', canceled: 'Canceled', failed: 'Measurement failed',
  interrupted: 'Measurement interrupted', applying: 'Applying and verifying', applied: 'Applied', rollingBack: 'Restoring', restored: 'Restored',
  reproducibleGain: 'Reproducible gain', noReliableGain: 'Gain below measured drift', qualityMismatch: 'Output quality mismatch', incomplete: 'Incomplete output', missingMetrics: 'Missing performance data',
  explanation: 'Checks require complete, consistent outputs. Code also checks the merge algorithm on inputs including empty lists and duplicates. Gains describe this measurement, not a complete project or every workload.',
  fullScenarioGain: 'Reproducible full scenario gain', noReliableFullScenarioGain: 'No reliable full scenario gain', incompleteWorkloads: 'Incomplete workload measurements', semanticQualityFailed: 'Task quality did not pass', missingWorkloadTimings: 'Missing workload timing', stableSemanticGain: 'Reproducible task gain', noReliableGainBeyondDrift: 'Task gain below measured drift', wallGain: 'Execution time gain', deadline: 'Per-workload deadline',
  startupVerification: 'Startup parameter verification', requested: 'Requested', observed: 'Observed', unpublished: 'Not exposed', effective: 'Effective value verified', upperBound: 'Startup ceiling verified', reservationRequest: 'Reservation request verified', startupRequest: 'Startup request verified', startupHint: 'Prefill chunks may shrink dynamically. A startup ceiling or reservation request does not establish an effective chunk or free GPU memory. Unknown effective states are not treated as active.', testDeadline: 'Measurement deadline', recoveryDeadline: 'Recovery deadline', generationLimit: 'Maximum generation requests', outputBudget: 'Output token upper bound', budgetHint: 'The output bound estimates generation budget only, excluding input, reasoning and count calibration. Hard deadlines are not duration estimates.',
  useCase: 'How do you mainly use the model?', daily: 'Everyday chat', agent: 'Coding and Agent', longDocument: 'Long document analysis',
  scenarioScope: 'Measure complete tasks for the selected use case and check cache reuse, session changes and output quality separately. Other requests wait or report busy. Measurements restore the original configuration; you decide whether to apply a recommendation.',
  advanced: 'Advanced test settings', diagnostic: 'Run short request diagnostics only', diagnosticHint: 'Keeps the original short chat, code and Chinese probes. These do not establish full scenario results and cannot apply new parameters from a diagnostic report.',
  contextLimit: 'Context limit for this test', contextHint: 'Limits this test without changing model capacity. Long documents require a 16K document plus answer headroom. The background service rejects a test beyond the current model capacity.',
  includeVision: 'Also check image understanding', visionHint: 'Requires image support already configured for this model. Does not download a vision model or install components. Vision remains untested when unchecked.',
  restartTitle: 'Candidates that require a restart', restartHint: 'Up to four independent candidates, changing one option at a time. The background checks support and resources, saves recovery records, loads the candidate and retests the original configuration.',
  workerTest: 'Compare CPU worker count', worker: 'Candidate workers', asyncTest: 'Compare asynchronous swapping', asyncValue: 'Enable asynchronous swapping for candidate',
  prefillTest: 'Compare prefill chunk size', prefill: 'Candidate chunk tokens', reserveTest: 'Compare reserved GPU memory', reserve: 'Candidate reserve MiB', reserveHint: 'Only increases the current reserve. Unknown original values or effective support cause the candidate to be rejected.',
  durationHint: 'Full measurements have a 2-hour deadline; each document retrieval workload has 20 minutes and other workloads have 10. Cancellation or timeout still requires original configuration recovery, with a separate 7-minute deadline. These are hard limits, not duration estimates; actual stage and elapsed time appear below.',
  fullScope: 'Full scenario report', diagnosticScope: 'Short request diagnostic report', legacyScope: 'Historical short request report', legacyHint: 'This report does not establish full scenario acceptance and cannot apply a new recommendation. Previously applied parameters can still be restored.',
  resultFor: 'Candidate results', requestCandidate: 'Request parameters', restartCandidate: 'Restart parameters', samples: 'samples', elapsed: 'Elapsed', workloadProgress: 'workloads',
  waitingForIdle: 'Waiting for the model to become idle', loading: 'Loading test configuration', restoringBaseline: 'Restoring configuration and verifying service', finished: 'Stage finished',
  coldInput: 'Cold input', hotPrefix: 'Hot prefix', sessionSwitch: 'Session switch', sustainedGeneration: 'Sustained generation', fullAgent: 'Full Agent', longRetrieval: 'Document retrieval', vision: 'Vision',
  wall: 'Task wall time', fullAgentWall: 'Agent wall time (including tools)', notTested: 'Not tested', coldVerified: 'Model reload verified', coldUnverified: 'Cold model loading not verified; does not establish a cold disk cache',
  resourceTitle: 'Resource cost', ramPeak: 'System RAM usage peak', gpuPeak: 'Primary GPU memory usage peak', resourceHint: 'Observed total system RAM and primary GPU usage during this workload, including other processes. These are not model-only costs or capacity guarantees. Missing telemetry is unmeasured.',
  resourceUnknown: 'Resource headroom could not be verified', insufficientResourceHeadroom: 'Insufficient sampled resource headroom', resourceChecked: 'Sampled headroom meets the floor', resourceUnknownBlocked: 'Resource headroom is unverified; this candidate cannot be applied.', resourceLowBlocked: 'Sampled headroom is insufficient; this candidate cannot be applied.', resourceFloor: 'Minimum sampled headroom', resourceSamples: 'Resource samples', ramTotal: 'Total RAM recorded at baseline', gpuTotal: 'Total primary GPU memory recorded at baseline', resourceGateHint: 'This is a conservative check of system RAM and primary GPU samples. Sampling may miss peaks; meeting the headroom floor does not guarantee against memory exhaustion.', gainTimingHint: 'Gain compares the sum of generation request times for ordinary tasks, excluding token-count calibration. Agent gain uses the complete tool-loop time. The task wall times above still include calibration and use a different timing scope.',
  contextMeasured: 'Actual input / target tokens', cachedTokens: 'Actual cached tokens', unknownResource: 'Unmeasured', checks: 'Actual quality checks', outputComplete: 'Complete output',
  recoveryTitle: 'Configuration and service recovery', notNeeded: 'No recovery needed', pending: 'Recovery record saved', restoring: 'Restoring original configuration', recoveryRestored: 'Recovery complete', recoveryFailed: 'Recovery failed; repair required',
  configurationRestored: 'Original configuration restored', serviceVerified: 'Service verified again', notVerified: 'Not yet verified', workloadDetails: 'Complete workload details', diagnosticDetails: 'Short request measurement details',
  scopeExplanation: 'Quality and timing describe tasks actually completed in this test. Untested use cases do not appear as passed. Reports contain timing, usage and checks, without prompts, answers or tool bodies.',
};
const activeStates = new Set<TuningJob['state']>(['checking', 'running', 'canceling', 'applying', 'rollingBack']);
const cancelableStates = new Set<TuningJob['state']>(['checking', 'running', 'canceling']);
const workloadKinds: TuningWorkloadKind[] = ['coldInput', 'hotPrefix', 'sessionSwitch', 'sustainedGeneration', 'fullAgent', 'longRetrieval', 'vision'];

export function TuningPage({ profileId, language, desktop, owned, streaming, onChanged }: { profileId?: string; language: 'zh-CN' | 'en'; desktop: boolean; owned: boolean; streaming: boolean; onChanged: () => void }) {
  const text = language === 'zh-CN' ? zh : en;
  const query = useQueryClient();
  const [useCase, setUseCase] = useState<TuningUseCase>('chat');
  const [helpOpen, setHelpOpen] = useState(false);
  const [diagnostic, setDiagnostic] = useState(false);
  const [contextLimit, setContextLimit] = useState(8192);
  const [includeVision, setIncludeVision] = useState(false);
  const [workerTest, setWorkerTest] = useState(false);
  const [poolWorkers, setPoolWorkers] = useState(8);
  const [asyncTest, setAsyncTest] = useState(false);
  const [adaptAsync, setAdaptAsync] = useState(true);
  const [prefillTest, setPrefillTest] = useState(false);
  const [prefill, setPrefill] = useState(4096);
  const [reserveTest, setReserveTest] = useState(false);
  const [vramReserveMib, setVramReserveMib] = useState(2048);
  const [adaptation, setAdaptation] = useState<TuningRestartParameters>({});
  const [resultCandidate, setResultCandidate] = useState('');
  const [clock, setClock] = useState(Date.now);
  const [scenes, setScenes] = useState<TuningScene[]>(['chat', 'code', 'chinese']);
  const [rounds, setRounds] = useState(2);
  const [maxTokens, setMaxTokens] = useState(512);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const capability = useQuery({ queryKey: ['tuning-capability'], queryFn: core.supervisorStatus, enabled: desktop, refetchInterval: 5000, retry: false });
  const fullSupported = core.supportsFullScenarioTuning(capability.data);
  const status = useQuery({ queryKey: ['tuning', profileId], queryFn: () => core.tuningStatus(profileId!), enabled: desktop && !!profileId, refetchInterval: data => activeStates.has(data.state.data?.state as TuningJob['state']) ? 1000 : 5000, refetchIntervalInBackground: true });
  const job = status.data;
  const active = !!job && activeStates.has(job.state);
  useEffect(() => { if (!active) return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [active]);
  const fullReport = job?.reportVersion === 2 && job.scope === 'fullScenario';
  const legacyReport = !!job && (job.reportVersion ?? 1) < 2;
  const recovery = job?.recovery;
  const selectedCandidate = job?.candidates.find(candidate => candidate.id === resultCandidate)?.id ?? job?.recommendedCandidateId ?? job?.candidates[0]?.id ?? '';
  const resourceAssessment = job?.candidates.find(candidate => candidate.id === selectedCandidate)?.resourceAssessment;
  const recommendedResources = job?.candidates.find(candidate => candidate.id === job.recommendedCandidateId)?.resourceAssessment;
  const workloadMeasurements = job?.workloadMeasurements ?? [];
  const selectedMeasurements = workloadMeasurements.filter(measurement => measurement.candidateId === selectedCandidate && measurement.position === 'candidate');
  const restartCandidates: TuningRestartParameters[] = [...(workerTest ? [{ poolWorkers }] : []), ...(asyncTest ? [{ adaptAsync }] : []), ...(prefillTest ? [{ prefill }] : []), ...(reserveTest ? [{ vramReserveMib }] : []), ...Object.entries(adaptation).map(([key, value]) => ({ [key]: value }))];
  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await operation(); await query.invalidateQueries({ queryKey: ['tuning', profileId] }); onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const numeric = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString(language, { maximumFractionDigits: digits });
  const seconds = (value: number | null | undefined) => value == null ? text.notTested : `${numeric(value / 1000)} s`;
  const size = (value: number | null | undefined) => value == null ? text.unknownResource : `${numeric(value / 1024 ** 3)} GiB`;
  const headroomSize = (value: number | null | undefined) => value == null ? text.unknownResource : value < 1024 ** 3 ? `${numeric(value / 1024 ** 2)} MiB` : size(value);
  const median = (values: number[]) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2; };
  const peak = (values: (number | null | undefined)[]) => { const measured = values.filter((value): value is number => value != null && Number.isFinite(value)); return measured.length ? Math.max(...measured) : null; };
  const restartDescription = (parameters?: TuningRestartParameters) => parameters ? [parameters.poolWorkers == null ? null : `${text.worker}: ${parameters.poolWorkers}`, parameters.adaptAsync == null ? null : `${text.asyncValue}: ${parameters.adaptAsync ? text.enabled : text.disabled}`, parameters.prefill == null ? null : `${text.prefill}: ${parameters.prefill}`, parameters.vramReserveMib == null ? null : `${text.reserve}: ${parameters.vramReserveMib}`, ...Object.entries(parameters).filter(([key]) => ['adaptEvery', 'adaptSwaps', 'adaptDecay'].includes(key)).map(([key, value]) => `${key}: ${value}`)].filter(Boolean).join(' · ') : '—';
  const parameterLabels: Record<string, string> = { pool_workers: text.worker, adapt_async: text.asyncValue, prefill: text.prefill, vram_reserve_mib: text.reserve, adapt_every: language === 'zh-CN' ? '专家重排间隔' : 'Expert adaptation interval', adapt_swaps: language === 'zh-CN' ? '每轮专家交换上限' : 'Expert swaps per round', adapt_decay: language === 'zh-CN' ? '专家计数衰减' : 'Expert count decay' };
  const startupValue = (name: string, value: number | null) => value == null ? text.unpublished : name === 'adapt_async' ? value ? text.enabled : text.disabled : numeric(value, name === 'adapt_decay' ? 3 : 0);
  const useCaseLabels = { chat: text.daily, agent: text.agent, longDocument: text.longDocument };
  const recoveryLabels = { notNeeded: text.notNeeded, pending: text.pending, restoring: text.restoring, restored: text.recoveryRestored, failed: text.recoveryFailed };
  const exportReport = () => {
    if (!job) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(job, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `strata-tuning-${new Date(job.startedAt).toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return <div className="tuning-page">
    <div className="tuning-heading"><h2><FlaskConical size={19}/>{text.title}</h2><button type="button" className="st-btn st-btn--icon" aria-label={language === 'zh-CN' ? '调优测试帮助' : 'Tuning test help'} title={language === 'zh-CN' ? '调优测试帮助' : 'Tuning test help'} onClick={() => setHelpOpen(true)}><CircleHelp size={16}/></button></div>
    {!desktop || !profileId || !owned ? <p className="notice">{!desktop ? text.native : !profileId ? text.profile : text.ownership}</p> : null}
    <Panel title={text.useCase}>
      <div className="tuning-purpose"><Dropdown ariaLabel={text.useCase} value={useCase} disabled={active || busy || diagnostic} options={(['chat', 'agent', 'longDocument'] as const).map(value => ({ value, label: useCaseLabels[value] }))} onValueChange={value => { setUseCase(value as TuningUseCase); setContextLimit(value === 'longDocument' ? 32768 : 8192); }}/></div>
      <p className="tuning-impact">{language === 'zh-CN' ? '测试时模型会暂停处理其他请求，结束后恢复原配置。' : 'The model pauses other requests during testing and restores its original configuration afterward.'}</p>
      {desktop && !diagnostic && !fullSupported && <p className="notice" role="status">{capability.isPending ? (language === 'zh-CN' ? '正在核对后台的完整实测能力…' : 'Checking full scenario support…') : capability.error ? core.normalizeError(capability.error).message : language === 'zh-CN' ? '当前后台不支持完整场景实测。请完成当前请求并停止模型服务，让后台更新后再重新核对。短请求诊断不能替代完整实测。' : 'The current supervisor does not support full scenarios. Finish current requests and stop the model service so the supervisor can update, then check again. Short diagnostics do not replace full scenarios.'}<button disabled={capability.isFetching} onClick={() => void capability.refetch()}>{language === 'zh-CN' ? '重新核对' : 'Check again'}</button></p>}
      <details className="tuning-advanced"><summary>{text.advanced}</summary>
        <label className="tuning-toggle"><Toggle ariaLabel={text.diagnostic} checked={diagnostic} disabled={active || busy} onCheckedChange={setDiagnostic}/><span>{text.diagnostic}</span></label>
        {diagnostic && <><div className="tuning-options">{(['chat', 'code', 'chinese'] as const).map(scene => <label key={scene}><Toggle ariaLabel={text[scene]} checked={scenes.includes(scene)} disabled={active || busy} onCheckedChange={checked => setScenes(old => checked ? [...old, scene] : old.filter(item => item !== scene))}/>{text[scene]}</label>)}</div><p className="subtle">{text.scope}</p></>}
        <div className="tuning-fields"><label><span>{text.rounds}</span><Dropdown ariaLabel={text.rounds} value={String(rounds)} disabled={active || busy} options={[2, 3, 4].map(value => ({ value: String(value), label: String(value) }))} onValueChange={value => setRounds(Number(value))}/></label>
          {diagnostic ? <label><span>{text.tokens}</span><Dropdown ariaLabel={text.tokens} value={String(maxTokens)} disabled={active || busy} options={[128, 256, 512, 1024].map(value => ({ value: String(value), label: String(value) }))} onValueChange={value => setMaxTokens(Number(value))}/></label> : <label><span>{text.contextLimit}</span><Dropdown ariaLabel={text.contextLimit} value={String(contextLimit)} disabled={active || busy} options={[4096, 8192, 16384, 32768, 65536, 131072].map(value => ({ value: String(value), label: value.toLocaleString(language) }))} onValueChange={value => setContextLimit(Number(value))}/></label>}
        </div>
        {!diagnostic && <><p className="subtle">{text.contextHint}</p><label className="tuning-toggle"><Toggle ariaLabel={text.includeVision} checked={includeVision} disabled={active || busy} onCheckedChange={setIncludeVision}/><span>{text.includeVision}</span></label><p className="subtle">{text.visionHint}</p>
          <h3>{text.restartTitle}</h3><p className="subtle">{text.restartHint}</p><div className="tuning-restart-options">
            <div><label className="tuning-toggle"><Toggle ariaLabel={text.workerTest} checked={workerTest} disabled={active || busy} onCheckedChange={setWorkerTest}/><span>{text.workerTest}</span></label>{workerTest && <Dropdown ariaLabel={text.worker} value={String(poolWorkers)} disabled={active || busy} options={[1, 2, 4, 8, 12, 16, 24, 32].map(value => ({ value: String(value), label: String(value) }))} onValueChange={value => setPoolWorkers(Number(value))}/>}</div>
            <div><label className="tuning-toggle"><Toggle ariaLabel={text.asyncTest} checked={asyncTest} disabled={active || busy} onCheckedChange={setAsyncTest}/><span>{text.asyncTest}</span></label>{asyncTest && <label className="tuning-toggle"><Toggle ariaLabel={text.asyncValue} checked={adaptAsync} disabled={active || busy} onCheckedChange={setAdaptAsync}/><span>{text.asyncValue}</span></label>}</div>
            <div><label className="tuning-toggle"><Toggle ariaLabel={text.prefillTest} checked={prefillTest} disabled={active || busy} onCheckedChange={setPrefillTest}/><span>{text.prefillTest}</span></label>{prefillTest && <Dropdown ariaLabel={text.prefill} value={String(prefill)} disabled={active || busy} options={[512, 1024, 2048, 4096, 8192, 16384, 32768].map(value => ({ value: String(value), label: value.toLocaleString(language) }))} onValueChange={value => setPrefill(Number(value))}/>}</div>
            <div><label className="tuning-toggle"><Toggle ariaLabel={text.reserveTest} checked={reserveTest} disabled={active || busy} onCheckedChange={setReserveTest}/><span>{text.reserveTest}</span></label>{reserveTest && <Dropdown ariaLabel={text.reserve} value={String(vramReserveMib)} disabled={active || busy} options={[256, 512, 1024, 2048, 4096, 8192].map(value => ({ value: String(value), label: value.toLocaleString(language) }))} onValueChange={value => setVramReserveMib(Number(value))}/>}</div>
            <ExpertAdaptationCandidates value={adaptation} onChange={setAdaptation} language={language} disabled={active || busy}/>
          </div><p className="subtle">{text.reserveHint}</p><p className="subtle">{language === 'zh-CN' ? '专家策略在引擎未公开有效值时仅核验启动参数，并保留完整场景质量与耗时比较。' : 'When effective adaptive values are unpublished, the owned startup arguments are checked and full scenario quality and timings are compared.'}</p>{restartCandidates.length > 4 && <p className="notice" role="alert">{language === 'zh-CN' ? '最多选择四个重启候选，请减少选项。' : 'Select no more than four restart candidates.'}</p>}</>}
      </details>
      <div className="actions"><button className="primary" disabled={!desktop || !profileId || !owned || streaming || active || busy || (!diagnostic && (!fullSupported || restartCandidates.length > 4)) || (diagnostic && !scenes.length) || recovery?.state === 'failed'} onClick={() => void run(() => core.tuningStart(profileId!, diagnostic ? { scenes, rounds, maxTokens } : { useCase, contextLimit, includeVision, rounds, maxTokens: 1024, ...(restartCandidates.length ? { restartCandidates } : {}) }))}><Play size={15}/>{text.start}</button>{job && cancelableStates.has(job.state) && <button disabled={busy || job.state === 'canceling' || recovery?.state === 'restoring'} onClick={() => void run(() => core.tuningCancel(job.id))}><Square size={15}/>{text.cancel}</button>}</div>
    </Panel>
    {(error || status.error || job?.error) && <div className="notice error" role="alert">{error || String(status.error ?? job?.error)}</div>}
    {job && <>
      <Panel title={text.progress} action={<button onClick={exportReport}><Download size={14}/>{text.export}</button>}>
        <p className="tuning-report-scope">{legacyReport ? text.legacyScope : fullReport ? text.fullScope : text.diagnosticScope}{fullReport && job.useCase ? ` · ${useCaseLabels[job.useCase]}` : ''}</p>
        {legacyReport && <p className="notice">{text.legacyHint}</p>}
        <div className="tuning-progress" role="status" aria-live="polite">{active ? <LoaderCircle className="spin" size={16}/> : <Activity size={16}/>}<strong>{text[job.state]}</strong><span>{job.completedRequests} / {job.totalRequests} {text.requests}</span></div>
        {job.progress && <div className="tuning-stage"><strong>{text[job.progress.phase]}</strong><span>{job.progress.completedWorkloads} / {job.progress.totalWorkloads} {text.workloadProgress}{job.progress.workloadKind ? ` · ${text[job.progress.workloadKind]}` : ''}{job.progress.candidateId ? ` · ${job.progress.candidateId}` : ''}</span></div>}
        {fullReport && job.limits && <><p className="subtle">{text.testDeadline}: {numeric(job.limits.maxDurationSeconds / 60, 0)} min · {text.recoveryDeadline}: {numeric(job.limits.recoveryDeadlineSeconds / 60, 0)} min · {text.generationLimit}: {numeric(job.limits.generationRequestLimit, 0)} · {text.outputBudget}: {numeric(job.limits.outputTokenUpperBound, 0)}</p><p className="subtle">{text.budgetHint}</p></>}
        <p className="subtle">{text.elapsed}: {seconds(Math.max(0, (job.finishedAt ?? clock) - job.startedAt))}</p>
        <div className="st-progress" role="progressbar" aria-label={text.progress} aria-valuenow={job.completedRequests} aria-valuemin={0} aria-valuemax={job.totalRequests}><div className="st-progress__bar" style={{ width: `${job.totalRequests > 0 ? job.completedRequests / job.totalRequests * 100 : 0}%` }}/></div>
        <div className="metrics-grid"><Metric label={`${text.baseline} · ${text.pcie}`} value={numeric(job.baseline.pcieFrac)}/><Metric label={`${text.baseline} · ${text.mtp}`} value={numeric(job.baseline.specMinP)}/></div>{fullReport && job.restartBaseline && <p className="subtle">{text.baseline}: {restartDescription(job.restartBaseline)}</p>}
      </Panel>
      {recovery && <Panel title={text.recoveryTitle}><div className={`tuning-recovery ${recovery.state === 'failed' ? 'is-failed' : ''}`} role={recovery.state === 'failed' ? 'alert' : 'status'}><strong>{recoveryLabels[recovery.state]}</strong>{recovery.state !== 'notNeeded' && <p>{recovery.configurationRestored ? text.configurationRestored : `${text.configurationRestored}: ${text.notVerified}`} · {recovery.serviceVerified ? text.serviceVerified : `${text.serviceVerified}: ${text.notVerified}`}</p>}{recovery.error && <p>{recovery.error}</p>}</div></Panel>}
      {fullReport && <Panel title={text.result}>
        <p className="subtle">{text.scopeExplanation}</p>
        {!!job.candidates.length && <div className="tuning-purpose"><Dropdown ariaLabel={text.resultFor} value={selectedCandidate} onValueChange={setResultCandidate} options={job.candidates.map(candidate => ({ value: candidate.id, label: `${candidate.id} · ${candidate.kind === 'restart' ? text.restartCandidate : text.requestCandidate}` }))}/></div>}
        <div className="tuning-workloads">{workloadKinds.map(kind => {
          const rows = selectedMeasurements.filter(measurement => measurement.kind === kind);
          const times = rows.flatMap(({ result }) => { const value = kind === 'fullAgent' ? result.fullAgentWallMs : result.wallMs; return value == null ? [] : [value]; });
          const passed = rows.length > 0 && rows.every(({ result }) => result.complete && result.qualityPassed);
          return <section className="tuning-workload" key={kind} data-testid={`tuning-${kind}`}><div><h3>{text[kind]}</h3><span className={passed ? 'is-passed' : ''}>{rows.length ? passed ? text.ok : text.mismatch : text.notTested}</span></div><strong>{seconds(median(times))}</strong><p>{kind === 'fullAgent' ? text.fullAgentWall : text.wall} · {rows.length} {text.samples}</p>{kind === 'coldInput' && rows.length > 0 && <p>{rows.every(({ result }) => result.coldModelVerified) ? text.coldVerified : text.coldUnverified}</p>}{rows.length > 0 && <><p>{text.ttft}: {seconds(median(rows.flatMap(({ result }) => result.firstTokenMs == null ? [] : [result.firstTokenMs])))} · {text.visible}: {seconds(median(rows.flatMap(({ result }) => result.firstVisibleMs == null ? [] : [result.firstVisibleMs])))}</p><p>{text.cachedTokens}: {numeric(median(rows.flatMap(({ result }) => result.cachedTokens == null ? [] : [result.cachedTokens])), 0)}</p></>}</section>;
        })}</div>
        <p className="subtle">{text.startupHint}</p><h3 className="tuning-resource-title">{text.resourceTitle}</h3><div className="metrics-grid"><Metric label={text.ramPeak} value={size(resourceAssessment ? resourceAssessment.ramPeakBytes : peak(selectedMeasurements.map(measurement => measurement.result.resourcePeak?.ramUsedBytes)))}/><Metric label={text.gpuPeak} value={size(resourceAssessment ? resourceAssessment.gpuPeakBytes : peak(selectedMeasurements.map(measurement => measurement.result.resourcePeak?.gpuMemoryUsedBytes)))}/></div><p className="subtle">{text.resourceHint}</p>
        <div className={`tuning-resource-assessment ${resourceAssessment?.status === 'checked' ? 'is-checked' : ''}`} data-testid="tuning-resource-assessment" role={resourceAssessment?.status === 'insufficientHeadroom' ? 'alert' : 'status'}>
          <strong>{resourceAssessment?.status === 'checked' ? text.resourceChecked : resourceAssessment?.status === 'insufficientHeadroom' ? text.resourceLowBlocked : text.resourceUnknownBlocked}</strong>
          {resourceAssessment && <><p>{text.resourceSamples}: {numeric(resourceAssessment.sampleCount, 0)} · {text.resourceFloor}: RAM {headroomSize(resourceAssessment.minimumRamHeadroomBytes)} / GPU {headroomSize(resourceAssessment.minimumGpuHeadroomBytes)}</p><p>{text.ramTotal}: {size(resourceAssessment.ramTotalBytes)} · {text.gpuTotal}: {size(resourceAssessment.gpuTotalBytes)}</p></>}
          <p>{text.resourceGateHint}</p>
        </div>
      </Panel>}
      <Panel title={text.candidates}>{fullReport && <p className="subtle">{text.gainTimingHint}</p>}
        <div className="table-wrap"><table className="st-table tuning-candidates"><thead><tr><th>{text.candidate}</th><th>{text.pcie}</th><th>{text.mtp}</th><th>{fullReport ? text.wallGain : text.gain}</th><th>{text.drift}</th><th>{text.result}</th><th/></tr></thead><tbody>{job.candidates.map(candidate => <tr key={candidate.id}><td><strong>{candidate.id}</strong><small className="tuning-candidate-kind">{candidate.kind === 'restart' ? restartDescription(candidate.restart) : text.requestCandidate}</small>{candidate.startupVerification && <small className="tuning-candidate-kind" data-testid={`startup-verification-${candidate.id}`}><strong>{text.startupVerification}</strong>{candidate.startupVerification.parameters.map(parameter => <span key={parameter.name}>{parameterLabels[parameter.name] ?? parameter.name} · {text[parameter.status]}<br/>{text.requested}: {startupValue(parameter.name, parameter.requested)} · {text.observed}: {startupValue(parameter.name, parameter.observed)}</span>)}</small>}</td><td>{numeric(candidate.pcieFrac)}</td><td>{numeric(candidate.specMinP)}</td><td>{candidate.evaluation?.gain == null ? '—' : `${numeric(candidate.evaluation.gain * 100, 1)}%`}</td><td>{candidate.evaluation?.drift == null ? '—' : `${numeric(candidate.evaluation.drift * 100, 1)}%`}</td><td>{candidate.evaluation ? text[candidate.evaluation.reason] ?? candidate.evaluation.reason : '—'}{candidate.dimensions && <small className="tuning-candidate-kind">{Object.entries(candidate.dimensions).map(([kind, evaluation]) => <span key={kind}>{text[kind as TuningWorkloadKind]}: {evaluation?.gain == null ? text.notTested : `${numeric(evaluation.gain * 100, 1)}%`} · {evaluation?.accepted ? text.ok : text.mismatch}</span>)}</small>}</td><td>{fullReport && candidate.id === job.recommendedCandidateId && candidate.evaluation?.accepted && <button className="primary" disabled={candidate.resourceAssessment?.status !== 'checked' || active || busy || streaming || job.state !== 'completed' || (candidate.kind === 'restart' && !candidate.startupVerification?.parameters.length) || (recovery != null && recovery.state !== 'notNeeded' && (!recovery.configurationRestored || !recovery.serviceVerified))} onClick={() => void run(() => core.tuningApply(job.id, candidate.id))}><Check size={14}/>{text.apply}</button>}</td></tr>)}</tbody></table></div>
        {job.state === 'completed' && <p className="subtle">{job.recommendedCandidateId ? fullReport && recommendedResources?.status !== 'checked' ? recommendedResources?.status === 'insufficientHeadroom' ? text.resourceLowBlocked : text.resourceUnknownBlocked : text.recommended : text.noRecommendation}</p>}
        {job.state === 'applied' && <button disabled={busy || streaming} onClick={() => void run(() => core.tuningRestore(job.id))}><RotateCcw size={15}/>{text.restore}</button>}
      </Panel>
      {fullReport && <Panel title={text.workloadDetails}><div className="table-wrap"><table className="st-table"><thead><tr><th>{text.scene}</th><th>{text.candidate}</th><th>{text.role}</th><th>{text.wall}</th><th>{text.ttft}</th><th>{text.visible}</th><th>{text.cachedTokens}</th><th>{text.contextMeasured}</th><th>{text.checks}</th></tr></thead><tbody>{workloadMeasurements.map(measurement => <tr key={measurement.id}><td>{text[measurement.kind]} · {measurement.round + 1}</td><td>{measurement.candidateId}</td><td>{text[measurement.position]}</td><td>{seconds(measurement.kind === 'fullAgent' ? measurement.result.fullAgentWallMs : measurement.result.wallMs)}</td><td>{seconds(measurement.result.firstTokenMs)}</td><td>{seconds(measurement.result.firstVisibleMs)}</td><td>{numeric(measurement.result.cachedTokens, 0)}</td><td>{numeric(measurement.result.actualContextTokens ?? measurement.result.inputTokens, 0)} / {numeric(measurement.result.targetInputTokens, 0)}</td><td><strong>{measurement.result.complete && measurement.result.qualityPassed ? text.ok : text.mismatch}</strong>{measurement.result.qualityReason && <small className="tuning-candidate-kind">{measurement.result.qualityReason}</small>}</td></tr>)}</tbody></table></div></Panel>}
      <details className="tuning-diagnostic-details" open={!fullReport}><summary>{text.diagnosticDetails}</summary><Panel title={text.details}><p className="subtle">{text.explanation}</p><div className="table-wrap"><table className="st-table"><thead><tr><th>{text.scene}</th><th>{text.role}</th><th>{text.cache}</th><th>{text.ttft}</th><th>{text.visible}</th><th>{text.speed}</th><th>{text.output}</th><th>{text.quality}</th></tr></thead><tbody>{job.measurements.map(measurement => <tr key={measurement.id}><td>{text[measurement.scene]} · {measurement.round + 1}</td><td>{text[measurement.position]}</td><td>{text[measurement.cacheMode]}</td><td>{measurement.firstTokenMs == null ? '—' : `${numeric(measurement.firstTokenMs / 1000)} s`}</td><td>{measurement.firstVisibleMs == null ? '—' : `${numeric(measurement.firstVisibleMs / 1000)} s`}</td><td>{numeric(measurement.decodeTokS)} tok/s</td><td>{numeric(measurement.outputTokens, 0)}</td><td title={measurement.error}>{measurement.complete && measurement.qualityPassed ? text.ok : text.mismatch}</td></tr>)}</tbody></table></div></Panel></details>
    </>}
    {helpOpen && <Dialog title={language === 'zh-CN' ? '调优测试说明' : 'Tuning test details'} onClose={() => setHelpOpen(false)}><div className="tuning-help-content"><p>{text.intro}</p><p>{diagnostic ? text.diagnosticHint : text.scenarioScope}</p><p>{diagnostic ? text.explanation : text.durationHint}</p></div></Dialog>}
  </div>;
}
