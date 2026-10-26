import type { AppLanguage, CalibrationJob, ServiceProfile } from "@strata-manager/core";
import { GainDotPlot } from './D2PageStrips';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Check, ChevronRight, CircleHelp, Download, Play, RotateCcw, X, Zap } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { CalibrationGoal, CalibrationWorkload, SpeedFix, TuningJob, TuningUseCase, TuningRestartParameters, TuningWorkloadKind } from '@strata-manager/core';
import { useTranslation } from 'react-i18next';
import { Dialog, Panel, Metric } from '../components';
import { Dropdown, Segmented, Toggle } from '../OfficialControls';
import './tuning.css';
import { ExpertAdaptationCandidates } from './ExpertAdaptationCandidates';
import { calibrationText } from './tuning/strings';
import { LiveLog, LiveStatus } from './tuning/TuningLive';
import { QuickCalibrationView } from './tuning/QuickCalibration';
import { ConcurrencyComparison, QuickCalibrationConcurrencyNote } from './tuning/ConcurrencyComparison';
import { speedBoostFailureText } from './tuning/speedBoostFailure';
import { SpeedBoost, useSpeedHealth } from './tuning/SpeedBoost';
import { appliedFor, dismissJob, forgetApplied, leaveNotice, originFor, rememberApplied, takeNotice, type SpeedBoostApplied } from './tuning/speedBoostRecord';

const zh = {
  setup: '测试设置', mode: '测试模式', fullMode: '完整场景', diagnosticMode: '短请求诊断',
  scenarioSettings: '场景设置', comparisons: '候选比较', sceneResults: '场景结果', baselineDetails: '基线与测量预算',
  impact: '测试占用当前模型，完成后恢复原配置。', diagnosticOnly: '诊断报告仅供比较，不能应用参数。',
  recommendation: '推荐参数', selected: '已选', startupUnverified: '启动参数尚未核验，暂不能应用。',
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
  workerTest: '比较 CPU 工作线程', worker: '候选线程数', asyncTest: '比较异步换入', asyncValue: '候选启用异步换入', mtpTest: '比较预测（MTP 开 / 关）', mtpValue: '候选开启 MTP', mtpSwitch: 'MTP 预测',
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
  setup: 'Test settings', mode: 'Test mode', fullMode: 'Full scenarios', diagnosticMode: 'Short diagnostics',
  scenarioSettings: 'Scenario settings', comparisons: 'Candidate comparison', sceneResults: 'Scenario results', baselineDetails: 'Baseline and measurement budget',
  impact: 'Testing occupies this model and restores the original configuration afterward.', diagnosticOnly: 'Diagnostic reports compare parameters but cannot apply them.',
  recommendation: 'Recommended parameters', selected: 'Selected', startupUnverified: 'Startup parameters are not verified yet; this candidate cannot be applied.',
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
  workerTest: 'Compare CPU worker count', worker: 'Candidate workers', asyncTest: 'Compare asynchronous swapping', asyncValue: 'Enable asynchronous swapping for candidate', mtpTest: 'Compare drafting (MTP on / off)', mtpValue: 'Turn MTP on for candidate', mtpSwitch: 'MTP drafting',
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

/** Where an applied calibration goes: a new version that is switched to (one-click), a new version only, or the current file. */
type ApplyTarget = 'switch' | 'version' | 'overwrite';
type ApplyNotice = { kind: 'saved' | 'overwritten'; onOpen?: () => void; onRestart?: () => void } | null;

export function TuningPage({ profileId, profile, language, desktop, owned, streaming, onChanged, onCopied, onRestart, onBenchmark, onSwitchVersion }: { profileId?: string; profile?: ServiceProfile; language: AppLanguage; desktop: boolean; owned: boolean; streaming: boolean; onChanged: () => void; onCopied?: (profile: ServiceProfile) => void | Promise<void>; onRestart?: () => void | Promise<void>; onBenchmark?: () => void; onSwitchVersion?: (profile: ServiceProfile) => Promise<void> }) {
  const text = language === 'zh-CN' ? zh : en;
  const cal = calibrationText(language);
  const { t } = useTranslation();
  const query = useQueryClient();
  // One-click speed-up (quick calibration with short + long answers) is the page.
  // Scenario verification and past reports live in the collapsed expert area.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [workload, setWorkload] = useState<CalibrationWorkload>('general');
  const [goal, setGoal] = useState<CalibrationGoal>('balanced');
  const [boostNotice, setBoostNotice] = useState<string | null>(takeNotice);
  const [calibrationRounds, setCalibrationRounds] = useState(2);
  const [suggested, setSuggested] = useState<TuningRestartParameters[]>([]);
  const [notice, setNotice] = useState<ApplyNotice>(null);
  const [overwriteOpen, setOverwriteOpen] = useState(false);
  /** Set when the config changed since calibration started; applying waits for confirmation. */
  const [driftPending, setDriftPending] = useState<{ target: ApplyTarget } | null>(null);
  const [useCase, setUseCase] = useState<TuningUseCase>('chat');
  const [helpOpen, setHelpOpen] = useState(false);
  const [contextLimit, setContextLimit] = useState(8192);
  const [includeVision, setIncludeVision] = useState(false);
  const [workerTest, setWorkerTest] = useState(false);
  const [poolWorkers, setPoolWorkers] = useState(8);
  const [asyncTest, setAsyncTest] = useState(false);
  const [mtpTest, setMtpTest] = useState(false);
  const [mtpOn, setMtpOn] = useState(false);
  const [adaptAsync, setAdaptAsync] = useState(true);
  const [prefillTest, setPrefillTest] = useState(false);
  const [prefill, setPrefill] = useState(4096);
  const [reserveTest, setReserveTest] = useState(false);
  const [vramReserveMib, setVramReserveMib] = useState(2048);
  const [adaptation, setAdaptation] = useState<TuningRestartParameters>({});
  const [resultCandidate, setResultCandidate] = useState('');
  const [clock, setClock] = useState(Date.now);
  const [rounds, setRounds] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const capability = useQuery({ queryKey: ['tuning-capability'], queryFn: core.supervisorStatus, enabled: desktop, refetchInterval: 5000, retry: false });
  const fullSupported = core.supportsFullScenarioTuning(capability.data);
  const quickSupported = core.supportsQuickCalibration(capability.data);
  const liveSupported = core.supportsTuningLive(capability.data);
  const status = useQuery({ queryKey: ['tuning', profileId], queryFn: () => core.tuningStatus(profileId!), enabled: desktop && !!profileId, refetchInterval: data => activeStates.has(data.state.data?.state as TuningJob['state']) ? 1000 : 5000, refetchIntervalInBackground: true });
  const calibration = useQuery({ queryKey: ['calibration', profileId], queryFn: () => core.calibrateStatus(profileId!), enabled: desktop && !!profileId && quickSupported, refetchInterval: data => activeStates.has(data.state.data?.state as TuningJob['state']) ? 1000 : 5000, refetchIntervalInBackground: true });
  const job = status.data;
  const calibrationJob: CalibrationJob | null = calibration.data ?? null;
  const active = !!job && activeStates.has(job.state);
  const calibrationActive = !!calibrationJob && activeStates.has(calibrationJob.state);
  const anyActive = active || calibrationActive;
  // A scenario verification that is already running opens the expert area.
  useEffect(() => { if (active) setAdvancedOpen(true); }, [active]);
  const liveJobId = calibrationActive ? calibrationJob!.id : active ? job!.id : undefined;
  const live = useQuery({ queryKey: ['tuning-live', liveJobId], queryFn: () => core.tuningLive(liveJobId!), enabled: desktop && !!liveJobId && liveSupported, refetchInterval: 1000, refetchIntervalInBackground: true, retry: false });
  const liveSnapshot = live.data && live.data.jobId === liveJobId ? live.data : null;
  useEffect(() => { if (!anyActive) return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [anyActive]);
  const fullReport = job?.reportVersion === 2 && job.scope === 'fullScenario';
  const legacyReport = !!job && (job.reportVersion ?? 1) < 2;
  const recovery = job?.recovery;
  const selectedCandidate = job?.candidates.find(candidate => candidate.id === resultCandidate)?.id ?? job?.recommendedCandidateId ?? job?.candidates[0]?.id ?? '';
  const resourceAssessment = job?.candidates.find(candidate => candidate.id === selectedCandidate)?.resourceAssessment;
  const recommendedResources = job?.candidates.find(candidate => candidate.id === job.recommendedCandidateId)?.resourceAssessment;
  const workloadMeasurements = job?.workloadMeasurements ?? [];
  const selectedMeasurements = workloadMeasurements.filter(measurement => measurement.candidateId === selectedCandidate && measurement.position === 'candidate');
  const manualRestartCandidates: TuningRestartParameters[] = [...(workerTest ? [{ poolWorkers }] : []), ...(asyncTest ? [{ adaptAsync }] : []), ...(prefillTest ? [{ prefill }] : []), ...(reserveTest ? [{ vramReserveMib }] : []), ...(mtpTest ? [{ mtp: mtpOn }] : []), ...Object.entries(adaptation).map(([key, value]) => ({ [key]: value }))];
  const restartCandidates: TuningRestartParameters[] = [...suggested, ...manualRestartCandidates];
  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await operation(); await Promise.all([query.invalidateQueries({ queryKey: ['tuning', profileId] }), query.invalidateQueries({ queryKey: ['calibration', profileId] })]); onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : core.normalizeError(cause).message); }
    finally { setBusy(false); }
  };
  const numeric = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString(language, { maximumFractionDigits: digits });
  const seconds = (value: number | null | undefined) => value == null ? text.notTested : `${numeric(value / 1000)} s`;
  const size = (value: number | null | undefined) => value == null ? text.unknownResource : `${numeric(value / 1024 ** 3)} GiB`;
  const headroomSize = (value: number | null | undefined) => value == null ? text.unknownResource : value < 1024 ** 3 ? `${numeric(value / 1024 ** 2)} MiB` : size(value);
  const median = (values: number[]) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2; };
  const peak = (values: (number | null | undefined)[]) => { const measured = values.filter((value): value is number => value != null && Number.isFinite(value)); return measured.length ? Math.max(...measured) : null; };
  const restartDescription = (parameters?: TuningRestartParameters) => parameters ? [parameters.poolWorkers == null ? null : `${text.worker}: ${parameters.poolWorkers}`, parameters.adaptAsync == null ? null : `${text.asyncValue}: ${parameters.adaptAsync ? text.enabled : text.disabled}`, parameters.prefill == null ? null : `${text.prefill}: ${parameters.prefill}`, parameters.vramReserveMib == null ? null : `${text.reserve}: ${parameters.vramReserveMib}`, parameters.mtp == null ? null : `${text.mtpSwitch}: ${parameters.mtp ? text.enabled : text.disabled}`, ...Object.entries(parameters).filter(([key]) => ['adaptEvery', 'adaptSwaps', 'adaptDecay'].includes(key)).map(([key, value]) => `${key}: ${value}`)].filter(Boolean).join(' · ') : '—';
  const parameterLabels: Record<string, string> = { pool_workers: text.worker, adapt_async: text.asyncValue, prefill: text.prefill, vram_reserve_mib: text.reserve, mtp: text.mtpSwitch, adapt_every: language === 'zh-CN' ? '专家重排间隔' : 'Expert adaptation interval', adapt_swaps: language === 'zh-CN' ? '每轮专家交换上限' : 'Expert swaps per round', adapt_decay: language === 'zh-CN' ? '专家计数衰减' : 'Expert count decay' };
  const startupValue = (name: string, value: number | boolean | null) => value == null ? text.unpublished : name === 'adapt_async' || name === 'mtp' ? value ? text.enabled : text.disabled : typeof value === 'boolean' ? String(value) : numeric(value, name === 'adapt_decay' ? 3 : 0);
  const useCaseLabels = { chat: text.daily, agent: text.agent, longDocument: text.longDocument };
  const recoveryLabels = { notNeeded: text.notNeeded, pending: text.pending, restoring: text.restoring, restored: text.recoveryRestored, failed: text.recoveryFailed };
  const exportReport = () => {
    if (!job) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(job, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `strata-tuning-${new Date(job.startedAt).toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const exportCalibration = () => {
    if (!calibrationJob) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(calibrationJob, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `strata-calibration-${new Date(calibrationJob.startedAt).toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  /** One-click: a new config version that is switched to (the original file is untouched).
   * Expert area: a new version only, or overwrite (keeps a .bak copy). */
  const applyCalibration = (target: ApplyTarget, configChangeConfirmed = false) => run(async () => {
    if (!profile || !calibrationJob) return;
    setNotice(null); setBoostNotice(null);
    const snapshot = await core.readConfigSnapshot(profile);
    if (!configChangeConfirmed && core.calibrationConfigChanged(calibrationJob, snapshot.revision)) { setDriftPending({ target }); return; }
    const next = core.applyCalibrationSettings(snapshot.config, calibrationJob.settings, calibrationJob.backend);
    core.validateStartupConfiguration(next);
    if (target === 'overwrite') {
      await core.writeConfig(profile, next, snapshot.revision);
      setNotice({ kind: 'overwritten', onRestart: onRestart ? () => { void onRestart(); } : undefined });
    } else if (target === 'version') {
      const copied = await core.copyConfiguration(profile, core.calibratedConfigName(profile.configPath, new Date()), next);
      onChanged();
      setNotice({ kind: 'saved', onOpen: onCopied ? () => { void onCopied(copied); } : undefined });
    } else {
      const copied = await core.copyConfiguration(profile, core.speedConfigName(profile.configPath, new Date(), 'boost'), next);
      onChanged();
      if (!onSwitchVersion) { setBoostNotice(t('sbSavedOnly', { name: copied.name })); return; }
      rememberApplied({ kind: 'boost', jobId: calibrationJob.id, origin: originFor(profile), to: copied.id, name: copied.name, at: Date.now(), before: calibrationJob.baseRate ?? null, after: calibrationJob.tunedRate ?? null });
      await onSwitchVersion(copied);
    }
  });
  /** Health fixes are saved the same way: a new version, then switched to. */
  const applyFixes = (fixes: SpeedFix[]) => run(async () => {
    if (!profile || !fixes.length) return;
    setBoostNotice(null);
    const snapshot = await core.readConfigSnapshot(profile);
    const next = core.applySpeedFixes(snapshot.config, fixes);
    core.validateStartupConfiguration(next);
    const copied = await core.copyConfiguration(profile, core.speedConfigName(profile.configPath, new Date(), 'fix'), next);
    onChanged();
    if (!onSwitchVersion) { setBoostNotice(t('sbSavedOnly', { name: copied.name })); return; }
    const previous = appliedFor(profile.id);
    rememberApplied({ kind: previous?.kind === 'boost' ? 'boost' : 'fix', jobId: previous?.jobId, origin: originFor(profile), to: copied.id, name: copied.name, at: Date.now(), before: previous?.before ?? null, after: previous?.after ?? null });
    await onSwitchVersion(copied);
  });
  /** Rollback switches back to the version in use before the first one-click change. */
  const rollback = (record: SpeedBoostApplied) => run(async () => {
    if (!onSwitchVersion) return;
    const installed = await core.localInstallations().catch(() => [] as ServiceProfile[]);
    const origin = installed.find(item => item.id === record.origin.id) ?? record.origin;
    if (record.jobId) dismissJob(record.jobId);
    forgetApplied(record.to);
    leaveNotice(t('sbRolledBack'));
    await onSwitchVersion(origin);
    setBoostNotice(takeNotice());
  });
  const verifyWithScenarios = () => {
    setSuggested(core.restartCandidatesFromCalibration(calibrationJob));
    setWorkerTest(false); setAdaptation({});
    setAdvancedOpen(true);
    requestAnimationFrame(() => document.querySelector('.tuning-setup')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  const health = useSpeedHealth({ profile, desktop, owned, goal });
  const canApplyCalibration = !!profile && !busy && !streaming && !anyActive && core.calibrationHasChange(calibrationJob);

  const recommendedCandidate = job?.candidates.find(candidate => candidate.id === job.recommendedCandidateId);
  const canApply = fullReport && recommendedCandidate?.evaluation?.accepted && recommendedResources?.status === 'checked'
    && !active && !busy && !streaming && job?.state === 'completed'
    && (recommendedCandidate.kind !== 'restart' || !!recommendedCandidate.startupVerification?.parameters.length)
    && (!recovery || recovery.state === 'notNeeded' || (recovery.configurationRestored && recovery.serviceVerified));
  const errorMessages = [...new Set([error, status.error ? core.normalizeError(status.error).message : ''].filter((message): message is string => !!message))];
  const reportErrors = [...new Set([job?.error, ...(job?.measurements.flatMap(measurement => measurement.error ? [measurement.error] : []) ?? [])].filter((message): message is string => !!message).map(message => speedBoostFailureText(message, t)))];
  const qualityFailures = workloadMeasurements.filter(measurement => !measurement.result.complete || !measurement.result.qualityPassed).length;
  const startDisabled = !desktop || !profileId || !owned || streaming || anyActive || busy || recovery?.state === 'failed';
  const liveStep = liveSnapshot?.stepKey ?? job?.progress?.phase;
  const tuningStepLabel = liveStep && liveStep in text ? text[liveStep as keyof typeof text] : job?.currentStep ?? text.running;

  const setupPanel = <>
    <Panel title={cal.fullMode} className="tuning-setup">
      <p className="tuning-lede">{cal.fullHint}</p>
      {<div className="tuning-main-fields">
        {<label className="tuning-field"><span>{text.useCase}</span><Dropdown ariaLabel={text.useCase} value={useCase} disabled={anyActive || busy} options={(['chat', 'agent', 'longDocument'] as const).map(value => ({ value, label: useCaseLabels[value] }))} onValueChange={value => { setUseCase(value as TuningUseCase); setContextLimit(value === 'longDocument' ? 32768 : 8192); }}/></label>}
        <label className="tuning-field"><span>{text.rounds}</span><Dropdown ariaLabel={text.rounds} value={String(rounds)} disabled={anyActive || busy} options={[2, 3, 4].map(value => ({ value: String(value), label: String(value) }))} onValueChange={value => setRounds(Number(value))}/></label>
        <label className="tuning-field"><span>{text.contextLimit}</span><Dropdown ariaLabel={text.contextLimit} value={String(contextLimit)} disabled={anyActive || busy} options={[4096, 8192, 16384, 32768, 65536, 131072].map(value => ({ value: String(value), label: value.toLocaleString(language) }))} onValueChange={value => setContextLimit(Number(value))}/></label>
      </div>}
      {desktop && !fullSupported && <p className="notice" role="status">{capability.isPending ? (language === 'zh-CN' ? '正在核对后台的完整实测能力…' : 'Checking full scenario support…') : capability.error ? core.normalizeError(capability.error).message : language === 'zh-CN' ? '当前后台不支持完整场景实测。请完成当前请求并停止模型服务，让后台更新后再重新核对。' : 'The current supervisor does not support full scenarios. Finish current requests and stop the model service so the supervisor can update, then check again.'}<button disabled={capability.isFetching} onClick={() => void capability.refetch()}>{language === 'zh-CN' ? '重新核对' : 'Check again'}</button></p>}
      <div className="tuning-setup-footer"><p className="tuning-impact">{text.impact}</p>
      <div className="actions">
        <button className="primary" data-testid="tuning-start" disabled={startDisabled || !fullSupported || restartCandidates.length > 4} onClick={() => void run(() => core.tuningStart(profileId!, { useCase, contextLimit, includeVision, rounds, maxTokens: 1024, ...(restartCandidates.length ? { restartCandidates } : {}) }))}><Play size={15}/>{text.start}</button>
      </div>
      </div>
      {restartCandidates.length > 4 && <p className="notice" role="alert">{language === 'zh-CN' ? '最多选择四个重启候选，请减少选项。' : 'Select no more than four restart candidates.'}</p>}
      {<section className="tuning-advanced" data-testid="tuning-advanced"><h3>{text.advanced}<small>{text.selected} {restartCandidates.length} / 4</small></h3>
        <p className="subtle">{text.contextHint}</p><label className="tuning-toggle"><Toggle ariaLabel={text.includeVision} checked={includeVision} disabled={anyActive || busy} onCheckedChange={setIncludeVision}/><span>{text.includeVision}</span></label><p className="subtle">{text.visionHint}</p>
        {!!suggested.length && <div className="tuning-suggested" data-testid="tuning-suggested"><h4>{cal.suggestions}</h4><ul>{suggested.map((item, index) => <li key={JSON.stringify(item)}><span>{item.poolWorkers != null ? `${cal.workers} ${item.poolWorkers}` : `${cal.adaptPreset} ${item.adaptEvery ?? '—'}/${item.adaptSwaps ?? '—'}/${item.adaptDecay ?? '—'}`}</span><button type="button" className="st-btn st-btn--icon" aria-label={cal.removeSuggestion} data-tooltip={cal.removeSuggestion} disabled={anyActive || busy} onClick={() => setSuggested(old => old.filter((_, i) => i !== index))}><X size={14}/></button></li>)}</ul><p className="subtle">{cal.verifyHint}</p></div>}
        <h3>{text.restartTitle}</h3><p className="subtle">{text.restartHint}</p><div className="tuning-restart-options">
          <div><label className="tuning-toggle"><Toggle ariaLabel={text.workerTest} checked={workerTest} disabled={anyActive || busy} onCheckedChange={setWorkerTest}/><span>{text.workerTest}</span></label>{workerTest && <Dropdown ariaLabel={text.worker} value={String(poolWorkers)} disabled={anyActive || busy} options={[1, 2, 4, 8, 12, 16, 24, 32].map(value => ({ value: String(value), label: String(value) }))} onValueChange={value => setPoolWorkers(Number(value))}/>}</div>
          <div><label className="tuning-toggle"><Toggle ariaLabel={text.asyncTest} checked={asyncTest} disabled={anyActive || busy} onCheckedChange={setAsyncTest}/><span>{text.asyncTest}</span></label>{asyncTest && <label className="tuning-toggle"><Toggle ariaLabel={text.asyncValue} checked={adaptAsync} disabled={anyActive || busy} onCheckedChange={setAdaptAsync}/><span>{text.asyncValue}</span></label>}</div>
          <div><label className="tuning-toggle"><Toggle ariaLabel={text.prefillTest} checked={prefillTest} disabled={anyActive || busy} onCheckedChange={setPrefillTest}/><span>{text.prefillTest}</span></label>{prefillTest && <Dropdown ariaLabel={text.prefill} value={String(prefill)} disabled={anyActive || busy} options={[512, 1024, 2048, 4096, 8192, 16384, 32768].map(value => ({ value: String(value), label: value.toLocaleString(language) }))} onValueChange={value => setPrefill(Number(value))}/>}</div>
          <div><label className="tuning-toggle"><Toggle ariaLabel={text.reserveTest} checked={reserveTest} disabled={anyActive || busy} onCheckedChange={setReserveTest}/><span>{text.reserveTest}</span></label>{reserveTest && <Dropdown ariaLabel={text.reserve} value={String(vramReserveMib)} disabled={anyActive || busy} options={[256, 512, 1024, 2048, 4096, 8192].map(value => ({ value: String(value), label: value.toLocaleString(language) }))} onValueChange={value => setVramReserveMib(Number(value))}/>}</div>
          <div><label className="tuning-toggle"><Toggle ariaLabel={text.mtpTest} checked={mtpTest} disabled={anyActive || busy} onCheckedChange={setMtpTest}/><span>{text.mtpTest}</span></label>{mtpTest && <label className="tuning-toggle"><Toggle ariaLabel={text.mtpValue} checked={mtpOn} disabled={anyActive || busy} onCheckedChange={setMtpOn}/><span>{text.mtpValue}</span></label>}</div>
          <ExpertAdaptationCandidates value={adaptation} onChange={setAdaptation} language={language} disabled={anyActive || busy}/>
        </div><p className="subtle">{text.reserveHint}</p><p className="subtle">{language === 'zh-CN' ? '专家策略在引擎未公开有效值时仅核验启动参数，并保留完整场景质量与耗时比较。' : 'When effective adaptive values are unpublished, the owned startup arguments are checked and full scenario quality and timings are compared.'}</p></section>}
    </Panel>
  </>;

  const blocked = !desktop ? t('sbNeedDesktop') : !profileId ? t('sbNeedProfile') : !owned ? t('sbNeedOwned')
    : desktop && !capability.isPending && !quickSupported ? t('sbUnsupported') : streaming ? t('sbBusy')
    : active && job ? `${cal.fullMode} · ${text[job.state]}` : recovery?.state === 'failed' ? text.recoveryFailed : undefined;
  const option = (value: string, label: string) => ({ value, label, disabled: anyActive || busy });

  return <div className="tuning-page">
    <div className="tuning-heading sb-heading"><div><h2><Zap size={19}/>{t('sbTitle')}</h2><p className="sb-subtitle">{t('sbSubtitle')}</p></div><button type="button" className="st-btn st-btn--icon" aria-label={language === 'zh-CN' ? '调优测试帮助' : 'Tuning test help'} data-tooltip={language === 'zh-CN' ? '调优测试帮助' : 'Tuning test help'} onClick={() => setHelpOpen(true)}><CircleHelp size={16}/></button></div>
    {!!errorMessages.length && <div className="notice error tuning-errors" role="alert">{errorMessages.map(message => <p key={message}>{message}</p>)}</div>}
    <SpeedBoost language={language} job={calibrationJob && calibrationJob.profileId === profileId ? calibrationJob : null} live={calibrationActive ? liveSnapshot : null} clock={clock} profile={profile}
      blocked={blocked} busy={busy} canApply={canApplyCalibration} canSwitch={!!onSwitchVersion} checks={health.checks} notice={boostNotice}
      onStart={() => void run(async () => { setNotice(null); setBoostNotice(null); await core.calibrateStart(profileId!, { rounds: calibrationRounds, workload, goal }); })}
      onCancel={() => calibrationJob && void run(() => core.calibrateCancel(calibrationJob.id))}
      onApply={() => void applyCalibration('switch')} onFix={fixes => void applyFixes(fixes)} onRollback={record => void rollback(record)}/>
    <QuickCalibrationConcurrencyNote profile={profile} desktop={desktop} language={language}/>
    <ConcurrencyComparison profile={profile} language={language} desktop={desktop} disabled={anyActive || busy || streaming} onSwitchVersion={onSwitchVersion} onChanged={onChanged}/>

    {/* The expert area is the one collapsed region of the page (lifted from #38 by decision for one-click tuning). */}
    <details className="tuning-expert" data-testid="tuning-expert" open={advancedOpen} onToggle={event => setAdvancedOpen(event.currentTarget.open)}>
      <summary><ChevronRight size={16} className="tuning-expert-chevron" aria-hidden/><span><strong>{t('sbAdvanced')}</strong><small>{t('sbAdvancedHint')}</small></span></summary>
      <div className="tuning-expert-body">
      <section className="sb-options" data-testid="speed-boost-options">
        <div className="sb-option"><span>{t('sbUseCase')}</span><Segmented ariaLabel={t('sbUseCase')} value={workload} options={[option('general', t('sbUseCaseGeneral')), option('chat', t('sbUseCaseChat')), option('agent', t('sbUseCaseAgent')), option('longDocument', t('sbUseCaseLong'))]} onValueChange={value => setWorkload(value as CalibrationWorkload)}/><p className="sb-muted">{t('sbUseCaseHint')}</p></div>
        <div className="sb-option"><span>{t('sbGoal')}</span><Segmented ariaLabel={t('sbGoal')} value={goal} options={[option('speed', t('sbGoalSpeed')), option('balanced', t('sbGoalBalanced')), option('memory', t('sbGoalMemory'))]} onValueChange={value => setGoal(value as CalibrationGoal)}/><p className="sb-muted">{t('sbGoalHint')}</p></div>
        <div className="sb-option is-narrow"><span>{t('sbRounds')}</span><Dropdown ariaLabel={t('sbRounds')} value={String(calibrationRounds)} disabled={anyActive || busy} options={[2, 3, 4].map(value => ({ value: String(value), label: t('sbRoundsValue', { count: value }) }))} onValueChange={value => setCalibrationRounds(Number(value))}/><p className="sb-muted">{t('sbRoundsHint')}</p></div>
      </section>
      {calibrationJob && <Panel title={cal.detailsTitle} className="tuning-calibration-panel" action={<button onClick={exportCalibration}><Download size={14}/>{text.export}</button>}>
        <p className="tuning-lede">{cal.detailsHint}</p>
        <QuickCalibrationView job={calibrationJob.error ? { ...calibrationJob, error: speedBoostFailureText(calibrationJob.error, t) } : calibrationJob} live={calibrationActive ? liveSnapshot : null} text={cal} language={language} states={text as unknown as Record<string, string>} clock={clock} busy={busy}
          canApply={canApplyCalibration} notice={notice} onCancel={() => void run(() => core.calibrateCancel(calibrationJob.id))}
          onSaveVersion={() => void applyCalibration('version')} onOverwrite={() => setOverwriteOpen(true)} onVerify={verifyWithScenarios} onBenchmark={onBenchmark}/>
      </Panel>}
      {setupPanel}
    {job && <>
      {!fullReport && <div className="tuning-history-head"><h3>{cal.historyTitle}</h3><p className="sb-muted">{cal.historyHint}</p></div>}
      <Panel title={text.progress} className="tuning-progress-panel" action={<button onClick={exportReport}><Download size={14}/>{text.export}</button>}>
        <p className="tuning-report-scope">{legacyReport ? text.legacyScope : fullReport ? text.fullScope : text.diagnosticScope}{fullReport && job.useCase ? ` · ${useCaseLabels[job.useCase]}` : ''}</p>
        {legacyReport && <p className="notice">{text.legacyHint}</p>}
        {!!reportErrors.length && <div className="notice error tuning-errors" role="alert">{reportErrors.map(message => <p key={message}>{message}</p>)}</div>}
        {active ? <LiveStatus text={cal} language={language} state={text[job.state]} stepLabel={tuningStepLabel}
          stepIndex={liveSnapshot?.stepIndex} stepTotal={liveSnapshot?.stepTotal} round={liveSnapshot?.round ?? job.progress?.round} rounds={liveSnapshot?.rounds ?? job.rounds}
          parameters={[liveSnapshot?.parameters.candidateId ?? job.progress?.candidateId, job.progress?.workloadKind ? text[job.progress.workloadKind] : null, liveSnapshot?.parameters.pcieFrac != null ? `${text.pcie} ${liveSnapshot.parameters.pcieFrac}` : null, liveSnapshot?.parameters.specMinP != null ? `${text.mtp} ${liveSnapshot.parameters.specMinP}` : null].filter(Boolean).join(' · ')}
          liveRate={liveSnapshot?.request?.tokS ?? null} lastRate={liveSnapshot?.lastTokS ?? null} elapsedMs={clock - job.startedAt} etaMs={liveSnapshot?.etaMs ?? null}
          done={job.progress ? Math.max(job.progress.completedWorkloads, liveSnapshot?.completedUnits ?? 0) : Math.max(job.completedRequests, liveSnapshot?.completedUnits ?? 0)}
          total={job.progress ? job.progress.totalWorkloads : job.totalRequests} unit={job.progress ? cal.progressWorkloads : cal.progressRequests}
          cancelLabel={text.cancel} onCancel={cancelableStates.has(job.state) ? () => void run(() => core.tuningCancel(job.id)) : undefined} cancelDisabled={busy || job.state === 'canceling' || recovery?.state === 'restoring'}/>
        : <><div className="tuning-progress" role="status" aria-live="polite"><Activity size={16}/><strong>{text[job.state]}</strong><span>{job.progress ? `${job.progress.completedWorkloads} / ${job.progress.totalWorkloads} ${text.workloadProgress}` : `${job.completedRequests} / ${job.totalRequests} ${text.requests}`}</span></div>
          <p className="subtle">{text.elapsed}: {seconds(Math.max(0, (job.finishedAt ?? clock) - job.startedAt))}</p></>}
        {active && liveSnapshot ? <LiveLog text={cal} language={language} lines={liveSnapshot.log}/> : !active && job.liveLog?.length ? <LiveLog text={cal} language={language} lines={job.liveLog} saved/> : null}
        {recovery && <div className={`tuning-recovery ${recovery.state === 'failed' ? 'is-failed' : ''}`} role={recovery.state === 'failed' ? 'alert' : 'status'}><strong>{text.recoveryTitle}: {recoveryLabels[recovery.state]}</strong>{recovery.state !== 'notNeeded' && <p>{recovery.configurationRestored ? text.configurationRestored : `${text.configurationRestored}: ${text.notVerified}`} · {recovery.serviceVerified ? text.serviceVerified : `${text.serviceVerified}: ${text.notVerified}`}</p>}{recovery.error && <p>{recovery.error}</p>}</div>}
        <section className="tuning-baseline"><h3>{text.baselineDetails}</h3>
        <div className="metrics-grid"><Metric label={`${text.baseline} · ${text.pcie}`} value={numeric(job.baseline.pcieFrac)}/><Metric label={`${text.baseline} · ${text.mtp}`} value={numeric(job.baseline.specMinP)}/></div>{fullReport && job.restartBaseline && <p className="subtle">{text.baseline}: {restartDescription(job.restartBaseline)}</p>}
        {fullReport && job.limits && <><p className="subtle">{text.testDeadline}: {numeric(job.limits.maxDurationSeconds / 60, 0)} min · {text.recoveryDeadline}: {numeric(job.limits.recoveryDeadlineSeconds / 60, 0)} min · {text.generationLimit}: {numeric(job.limits.generationRequestLimit, 0)} · {text.outputBudget}: {numeric(job.limits.outputTokenUpperBound, 0)}</p><p className="subtle">{text.budgetHint}</p></>}
        </section>
      </Panel>

      {!active && <Panel title={text.result} className="tuning-result-summary">
        <div className="tuning-recommendation"><div><strong>{recommendedCandidate ? `${text.recommendation} · ${recommendedCandidate.id}` : job.state === 'completed' ? text.noRecommendation : text[job.state]}</strong>{recommendedCandidate?.evaluation && <p>{text[recommendedCandidate.evaluation.reason] ?? recommendedCandidate.evaluation.reason}</p>}</div>{recommendedCandidate?.evaluation?.gain != null && <div className="tuning-gain"><strong>{numeric(recommendedCandidate.evaluation.gain * 100, 1)}%</strong><span>{fullReport ? text.wallGain : text.gain}</span></div>}
          <div className="actions">{fullReport && job.state === 'completed' && recommendedCandidate?.evaluation?.accepted && <button className="primary" disabled={!canApply} onClick={() => void run(() => core.tuningApply(job.id, recommendedCandidate.id))}><Check size={14}/>{text.apply}</button>}{job.state === 'applied' && <button disabled={busy || streaming} onClick={() => void run(() => core.tuningRestore(job.id))}><RotateCcw size={15}/>{text.restore}</button>}</div>
        </div>
        {recommendedCandidate && <p className="tuning-recommended-parameters">{text.pcie}: {numeric(recommendedCandidate.pcieFrac)} · {text.mtp}: {numeric(recommendedCandidate.specMinP)}{recommendedCandidate.kind === 'restart' ? ` · ${restartDescription(recommendedCandidate.restart)}` : ''}</p>}
        {!!job.candidates.length && <GainDotPlot label={fullReport ? text.wallGain : text.gain} points={job.candidates.map(candidate => ({ id: candidate.id, gain: candidate.evaluation?.gain, recommended: candidate.id === job.recommendedCandidateId, accepted: candidate.evaluation?.accepted }))}/>}
        {!fullReport && <p className="subtle">{text.diagnosticOnly}</p>}
        {fullReport && recommendedCandidate && recommendedResources?.status !== 'checked' && <p className="notice error" role="alert">{recommendedResources?.status === 'insufficientHeadroom' ? text.resourceLowBlocked : text.resourceUnknownBlocked}</p>}
        {fullReport && recommendedCandidate?.kind === 'restart' && !recommendedCandidate.startupVerification?.parameters.length && <p className="notice" role="status">{text.startupUnverified}</p>}
      </Panel>}
      {fullReport && <Panel title={text.sceneResults} className="tuning-report" action={<small className="tuning-muted">{workloadMeasurements.length} {text.samples}{qualityFailures > 0 && <span> · {qualityFailures} {text.mismatch}</span>}</small>}>
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
      {!!job.candidates.length && <Panel title={text.comparisons} className="tuning-report" action={<small className="tuning-muted">{job.candidates.length} {text.candidates}</small>}>{fullReport && <p className="subtle">{text.gainTimingHint}</p>}
        <div className="table-wrap"><table className="st-table tuning-candidates"><thead><tr><th>{text.candidate}</th><th>{text.pcie}</th><th>{text.mtp}</th><th>{fullReport ? text.wallGain : text.gain}</th><th>{text.drift}</th><th>{text.result}</th></tr></thead><tbody>{job.candidates.map(candidate => <tr key={candidate.id}><td><strong>{candidate.id}</strong><small className="tuning-candidate-kind">{candidate.kind === 'restart' ? restartDescription(candidate.restart) : text.requestCandidate}</small>{candidate.startupVerification && <small className="tuning-candidate-kind" data-testid={`startup-verification-${candidate.id}`}><strong>{text.startupVerification}</strong>{candidate.startupVerification.parameters.map(parameter => <span key={parameter.name}>{parameterLabels[parameter.name] ?? parameter.name} · {text[parameter.status]}<br/>{text.requested}: {startupValue(parameter.name, parameter.requested)} · {text.observed}: {startupValue(parameter.name, parameter.observed)}</span>)}</small>}</td><td>{numeric(candidate.pcieFrac)}</td><td>{numeric(candidate.specMinP)}</td><td>{candidate.evaluation?.gain == null ? '—' : `${numeric(candidate.evaluation.gain * 100, 1)}%`}</td><td>{candidate.evaluation?.drift == null ? '—' : `${numeric(candidate.evaluation.drift * 100, 1)}%`}</td><td>{candidate.evaluation ? text[candidate.evaluation.reason] ?? candidate.evaluation.reason : '—'}{candidate.dimensions && <small className="tuning-candidate-kind">{Object.entries(candidate.dimensions).map(([kind, evaluation]) => <span key={kind}>{text[kind as TuningWorkloadKind]}: {evaluation?.gain == null ? text.notTested : `${numeric(evaluation.gain * 100, 1)}%`} · {evaluation?.accepted ? text.ok : text.mismatch}</span>)}</small>}</td></tr>)}</tbody></table></div>

      </Panel>}
      {fullReport && !!workloadMeasurements.length && <Panel title={text.workloadDetails} className="tuning-report" action={<small className="tuning-muted">{workloadMeasurements.length} {text.samples}</small>}><div className="table-wrap"><table className="st-table"><thead><tr><th>{text.scene}</th><th>{text.candidate}</th><th>{text.role}</th><th>{text.wall}</th><th>{text.ttft}</th><th>{text.visible}</th><th>{text.cachedTokens}</th><th>{text.contextMeasured}</th><th>{text.checks}</th></tr></thead><tbody>{workloadMeasurements.map(measurement => <tr key={measurement.id}><td>{text[measurement.kind]} · {measurement.round + 1}</td><td>{measurement.candidateId}</td><td>{text[measurement.position]}</td><td>{seconds(measurement.kind === 'fullAgent' ? measurement.result.fullAgentWallMs : measurement.result.wallMs)}</td><td>{seconds(measurement.result.firstTokenMs)}</td><td>{seconds(measurement.result.firstVisibleMs)}</td><td>{numeric(measurement.result.cachedTokens, 0)}</td><td>{numeric(measurement.result.actualContextTokens ?? measurement.result.inputTokens, 0)} / {numeric(measurement.result.targetInputTokens, 0)}</td><td><strong>{measurement.result.complete && measurement.result.qualityPassed ? text.ok : text.mismatch}</strong>{measurement.result.qualityReason && <small className="tuning-candidate-kind">{measurement.result.qualityDetail || measurement.result.qualityReason}</small>}</td></tr>)}</tbody></table></div></Panel>}
      {!!job.measurements.length && <Panel title={text.diagnosticDetails} className="tuning-report tuning-diagnostic-details"><p className="subtle">{text.explanation}</p><div className="table-wrap"><table className="st-table"><thead><tr><th>{text.scene}</th><th>{text.role}</th><th>{text.cache}</th><th>{text.ttft}</th><th>{text.visible}</th><th>{text.speed}</th><th>{text.output}</th><th>{text.quality}</th></tr></thead><tbody>{job.measurements.map(measurement => <tr key={measurement.id}><td>{text[measurement.scene]} · {measurement.round + 1}</td><td>{text[measurement.position]}</td><td>{text[measurement.cacheMode]}</td><td>{measurement.firstTokenMs == null ? '—' : `${numeric(measurement.firstTokenMs / 1000)} s`}</td><td>{measurement.firstVisibleMs == null ? '—' : `${numeric(measurement.firstVisibleMs / 1000)} s`}</td><td>{numeric(measurement.decodeTokS)} tok/s</td><td>{numeric(measurement.outputTokens, 0)}</td><td data-tooltip={measurement.error}>{measurement.complete && measurement.qualityPassed ? text.ok : text.mismatch}</td></tr>)}</tbody></table></div></Panel>}
    </>}
      </div>
    </details>
    {overwriteOpen && <Dialog title={cal.overwriteConfirm} onClose={() => setOverwriteOpen(false)}><div className="tuning-help-content"><p>{cal.overwriteBody}</p>{profile && <p className="tuning-muted">{profile.configPath}</p>}<div className="actions"><button onClick={() => setOverwriteOpen(false)}>{cal.cancel}</button><button className="primary" data-testid="calibration-overwrite-confirm" disabled={!canApplyCalibration} onClick={() => { setOverwriteOpen(false); void applyCalibration('overwrite'); }}><Check size={14}/>{cal.confirmOverwrite}</button></div></div></Dialog>}
    {driftPending && <Dialog title={cal.driftTitle} onClose={() => setDriftPending(null)}><div className="tuning-help-content" data-testid="calibration-drift"><p role="alert">{cal.driftBody}</p>{profile && <p className="tuning-muted">{profile.configPath}</p>}<div className="actions"><button onClick={() => setDriftPending(null)}>{cal.cancel}</button><button className="primary" data-testid="calibration-drift-confirm" disabled={!canApplyCalibration} onClick={() => { const pending = driftPending; setDriftPending(null); void applyCalibration(pending.target, true); }}><Check size={14}/>{cal.driftConfirm}</button></div></div></Dialog>}
    {helpOpen && <Dialog title={language === 'zh-CN' ? '调优测试说明' : 'Tuning test details'} onClose={() => setHelpOpen(false)}><div className="tuning-help-content"><p>{t('sbSubtitle')}</p><p>{t('sbStartHint')}</p><p>{t('sbUseCaseHint')}</p><p>{cal.quickRule}</p><p>{t('sbApplyHint')}</p><h3>{cal.fullMode}</h3><p>{text.scenarioScope}</p><p>{text.durationHint}</p>{<><h3>{text.contextLimit}</h3><p>{text.contextHint}</p><h3>{text.startupVerification}</h3><p>{text.startupHint}</p><h3>{text.result}</h3><p>{text.scopeExplanation}</p><p>{text.gainTimingHint}</p><h3>{text.resourceTitle}</h3><p>{text.resourceHint}</p><p>{text.resourceGateHint}</p></>}</div></Dialog>}
  </div>;
}
