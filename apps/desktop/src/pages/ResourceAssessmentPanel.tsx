import type { AppLanguage } from "@strata-manager/core";
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleHelp, RefreshCw } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { ResourceAssessmentRequest, SetupDiskPreflight, SetupResourceAssessment } from '@strata-manager/core';
import { SetupDiskStatus } from './SetupDiskStatus';
import './resource-assessment.css';

export interface ResourceAssessmentPanelProps {
  request?: ResourceAssessmentRequest | null;
  language: AppLanguage;
  desktop?: boolean;
  compact?: boolean;
  /** One quiet line with the status; evidence opens on demand. */
  inline?: boolean;
  disk?: SetupDiskPreflight;
  diskPending?: boolean;
  diskError?: unknown;
  onRefreshDisk?: () => void;
  /** Invalid/raw drafts and custom modes do not reuse the saved configuration's estimate. */
  unavailableReason?: string;
  assess?: (request: ResourceAssessmentRequest) => Promise<SetupResourceAssessment>;
  loadHistory?: () => Promise<unknown[]>;
}

const loadHistoryDefault = () => core.loadStore<unknown[]>('benchmarkReportsV1', []);
export function ResourceAssessmentPanel({ request, language, desktop = core.isDesktop(), compact = false, inline = false, disk, diskPending = false, diskError, onRefreshDisk, unavailableReason, assess = core.assessSetupResources, loadHistory = loadHistoryDefault }: ResourceAssessmentPanelProps) {
  const zh = language === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en;
  const identity = request ? JSON.stringify(request) : '';
  const [settledIdentity, setSettledIdentity] = useState(identity);
  useEffect(() => { const timer = setTimeout(() => setSettledIdentity(identity), 350); return () => clearTimeout(timer); }, [identity]);
  const settled = useMemo<ResourceAssessmentRequest | undefined>(() => settledIdentity ? JSON.parse(settledIdentity) : undefined, [settledIdentity]);
  const current = settledIdentity === identity;
  const query = useQuery({
    queryKey: ['resource-assessment', settledIdentity],
    queryFn: () => assess(settled!),
    enabled: desktop && !!settled && current,
    staleTime: 30_000, retry: false, refetchOnWindowFocus: false,
  });
  const result = desktop && request && current && !query.error ? query.data : undefined;
  const history = useQuery({ queryKey: ['benchmark-resource-history'], queryFn: loadHistory, enabled: desktop && !!request && current && !!result, staleTime: 0, retry: false, refetchOnWindowFocus: false });
  const measurements = useMemo(() => result && request ? core.matchingResourceMeasurements(Array.isArray(history.data) ? history.data : [], request, result.hardware) : [], [result, request, history.data]);
  const pending = !!request && desktop && (!current || query.isPending && !query.error);
  const size = (value: number | null | undefined) => value == null ? t('未知', 'Unknown') : `${(value / 1024 ** 3).toLocaleString(language, { maximumFractionDigits: 2 })} GiB`;
  const modes: Record<string, string> = { normal: t('常规内存', 'Normal RAM'), resident: t('低内存驻留', 'Low-RAM resident'), mmap: t('文件映射', 'File mapped'), budget: t('RAM 预算', 'RAM budget'), unknown: t('未知', 'Unknown') };
  const status = result?.status === 'suggested' ? t('适合尝试', 'Suggested to try') : result?.status === 'risk' ? t('存在资源风险', 'Resource risk') : t('容量未核验', 'Capacity unverified');
  const unavailable = !desktop ? t('需要桌面后台读取本机资源。', 'The desktop backend is needed to read local resources.')
    : unavailableReason ?? t('当前草稿包含自定义资源设置，或尚未识别官方模型。保留原配置，容量预估显示为未知。', 'This draft has custom resource settings or no recognized official recipe. Configuration is preserved; capacity remains unknown.');
  const unavailableContent = !request || !desktop ? <p className="resource-assessment-empty">{unavailable}</p>
      : pending ? <p className="resource-assessment-empty">{t('只读检查本机内存和显存，不会启动模型。', 'Reading RAM and VRAM without starting a model.')}</p>
      : query.error ? <p className="resource-assessment-error" role="alert">{t('资源读取失败，容量保持未知。', 'Resource reading failed; capacity remains unknown.')} {core.normalizeError(query.error).message}</p>
      : !result ? <p className="resource-assessment-empty">{t('尚未取得本机资源数据，容量预估显示为未知。', 'Local resource data is unavailable; capacity remains unknown.')}</p> : null;
  const estimateComponents = result && <>
    <dl className="resource-assessment-facts">
      <div><dt>{t('专家权重规模', 'Expert arena')}</dt><dd>{size(result.ram.expertBytes)}</dd></div>
      <div><dt>{t('长上下文 RAM 建议阈值', 'Long-context RAM threshold')}</dt><dd>{size(result.ram.longContextBytes)}</dd></div>
      <div><dt>{t('KV streaming / RAM 分项', 'KV streaming / RAM component')}</dt><dd>{result.kv.streaming == null ? t('未知', 'Unknown') : result.kv.streaming ? t('开启', 'On') : t('关闭', 'Off')} / {size(result.kv.streamingRamBytes)}</dd></div>
      <div><dt>{t('单槽 / 批处理槽显存分项', 'Per-slot / batch-slot VRAM')}</dt><dd>{size(result.slots.perSlotVramBytes)} / {size(result.slots.totalVramBytes)}</dd></div>
    </dl>
    <p>{core.resourceAssessmentMessage('estimate_scope', zh)}</p><p>{t('硬件采样', 'Hardware sampled')}: {new Date(result.sampledAt).toLocaleTimeString(language)} · {t('处理器指令', 'CPU ISA')}: {result.hardware.cpuIsa}{result.hardware.wsl ? ' · WSL' : ''}</p>
    <a href={`https://github.com/Niko1221/Strata/blob/${result.sourceRevision}/setup.py`} target="_blank" rel="noreferrer">{t('Strata 0.1.44 安装器规则', 'Strata 0.1.44 setup rules')}</a>
  </>;
  const assessmentContent = result && !pending && <>
        <p className="resource-assessment-caption">{t('按当前选择的上下文与并发数估算；建议不会自动修改你的配置。', 'Estimates use the selected context and concurrency. Recommendations never change your configuration automatically.')}</p>
        <dl className="resource-assessment-facts">
          <div><dt>{t('本机 RAM / 当前可用', 'System RAM / available now')}</dt><dd>{size(result.hardware.totalMemoryBytes)} / {size(result.hardware.availableMemoryBytes)}</dd></div>
          <div><dt>{t('官方 RAM 建议阈值', 'Official RAM guidance threshold')}</dt><dd>{size(result.ram.baselineBytes)}</dd></div>
          <div><dt>{t('预计运行模式', 'Estimated mode')}</dt><dd>{modes[result.ram.mode]}</dd></div>
          <div><dt>{t('建议上下文 / 并发', 'Suggested context / concurrency')}</dt><dd>{result.recommendations.context == null ? t('未知', 'Unknown') : `${(result.recommendations.context / 1024).toLocaleString(language)}K`} / {result.recommendations.parallel ?? t('未知', 'Unknown')}</dd></div>
        </dl>
        <div className="resource-assessment-gpus">{result.hardware.gpus.length ? result.hardware.gpus.map(gpu => <p key={gpu.id}><strong>GPU {gpu.id} · {gpu.name}</strong><span>{t('总显存 / 当前可用', 'Total VRAM / available now')}: {size(gpu.totalBytes)} / {size(gpu.availableBytes)}</span></p>) : <p>{t('没有可靠的 GPU 容量数据。', 'Reliable GPU capacity data is unavailable.')}</p>}</div>
        <ul className="resource-assessment-notes">{result.reasons.filter(reason => reason.code !== 'estimate_scope').map(reason => <li key={reason.code} data-severity={reason.severity}>{core.resourceAssessmentMessage(reason.code, zh)}</li>)}{result.unknowns.map(code => <li key={`unknown-${code}`}>{core.resourceAssessmentMessage(code, zh)}</li>)}</ul>
        <div className="resource-assessment-history"><strong>{t('相同资源选择的历史实测', 'Measurements with matching resource selections')}</strong>
          {history.error ? <p>{t('历史报告读取失败，尚未确认匹配测量。', 'History could not be read; matching measurements are unconfirmed.')}</p>
            : history.isPending ? <p>{t('正在读取已有报告…', 'Reading existing reports…')}</p>
              : measurements.length ? <><div className="resource-assessment-history-table"><table><thead><tr><th>{t('测试时间', 'Measured at')}</th><th>{t('RAM 峰值', 'Peak RAM')}</th><th>{t('显存峰值', 'Peak VRAM')}</th></tr></thead><tbody>{measurements.map(measurement => <tr key={measurement.id}><td>{new Date(measurement.startedAt).toLocaleString(language)}</td><td>{size(measurement.ramPeakBytes)}</td><td>{size(measurement.vramPeakBytes)}</td></tr>)}</tbody></table></div><p>{t('只匹配已核验实际启动参数、同机硬件与全部资源选择的报告；权重身份仍为元数据级。峰值是整机／整卡采样，任务内容与其他程序会影响结果。', 'Reports match verified startup arguments, static hardware and every resource selection. Weight identity remains metadata-based. Peaks cover the whole host/GPU; tasks and other applications affect them.')}</p></>
                : <p>{t('暂无符合当前资源选择、已核验实际启动参数与本机硬件的报告。缺少证据的旧报告和不同资源选择不会作为匹配结果。', 'No report matches these resource selections, verified startup arguments and this hardware. Older reports without evidence or different resource selections are not treated as matches.')}</p>}
        </div>
        {compact ? estimateComponents : <details className="resource-assessment-details"><summary><CircleHelp size={13}/>{t('估算分项与依据', 'Estimate components and source')}</summary>{estimateComponents}</details>}
      </>;
  const diskStatus = !desktop ? 'unknown' : diskPending ? 'pending' : diskError ? 'error' : disk?.status ?? 'unchecked';
  const diskLabels = { unknown: t('未知', 'Unknown'), pending: t('检查中…', 'Checking…'), error: t('检查失败', 'Check failed'), ready: t('充足', 'Sufficient'), insufficient: t('不足', 'Insufficient'), unchecked: t('未检查', 'Not checked') };
  const mainRisk = result?.reasons.find(reason => reason.severity === 'risk' && reason.code !== 'estimate_scope');
  const refreshButton = <button type="button" className="st-btn st-btn--icon" aria-label={t('重新读取资源', 'Refresh resources')} data-tooltip={t('重新读取资源', 'Refresh resources')} disabled={!desktop || !request || !current || query.isFetching} onClick={() => void Promise.all([query.refetch(), history.refetch()])}><RefreshCw size={14}/></button>;
  if (inline && !compact) return <section className="resource-assessment resource-assessment--inline" aria-label={t('资源适配建议', 'Resource guidance')} data-testid="resource-assessment" data-status={result?.status ?? 'unknown'}>
    <div className="resource-assessment-heading"><div><strong>{t('资源适配建议', 'Resource guidance')}</strong><span className={`resource-assessment-status ${result?.status ?? 'unknown'}`} role="status">{pending ? t('正在更新预估…', 'Updating estimate…') : status}</span>{result?.status === 'risk' && mainRisk && <span className="resource-assessment-risk">{core.resourceAssessmentMessage(mainRisk.code, zh)}</span>}</div>{refreshButton}</div>
    {unavailableContent}
    {assessmentContent && <details className="resource-assessment-details resource-assessment-disclosure"><summary><CircleHelp size={13}/>{t('查看估算与依据', 'View estimate and evidence')}</summary>{assessmentContent}</details>}
  </section>;
  return <section className={`resource-assessment${compact ? ' resource-assessment--compact' : ''}`} aria-label={t('资源适配建议', 'Resource guidance')} data-testid="resource-assessment" data-status={result?.status ?? 'unknown'}>
    <div className="resource-assessment-heading"><div><strong>{compact ? t('当前选择的资源预估', 'Resource estimate for this selection') : t('资源适配建议', 'Resource guidance')}</strong><span className={`resource-assessment-status ${result?.status ?? 'unknown'}`} role="status">{pending ? t('正在更新预估…', 'Updating estimate…') : status}</span></div>{refreshButton}</div>
    {unavailableContent}
    {compact ? <>
      <dl className="resource-assessment-summary">
        <div><dt>{t('本机可用 RAM', 'Available system RAM')}</dt><dd>{size(result?.hardware.availableMemoryBytes)}</dd></div>
        <div><dt>{t('官方 RAM 建议阈值', 'Official RAM guidance threshold')}</dt><dd>{size(result?.ram.baselineBytes)}</dd></div>
        <div><dt>{t('磁盘空间', 'Disk space')}</dt><dd data-disk-status={diskStatus}>{diskLabels[diskStatus]}</dd></div>
      </dl>
      {result?.status === 'risk' && <p className="resource-assessment-risk" role="status">{mainRisk ? core.resourceAssessmentMessage(mainRisk.code, zh) : t('当前资源选择存在风险，请展开查看完整依据。', 'This selection has resource risks. Expand to inspect the evidence.')}</p>}
      <p className="resource-assessment-caption">{t('估算：参考值不等于运行保证，长上下文可能增加占用。', 'Estimates are guidance, not a guarantee. Longer contexts may use more resources.')}</p>
      <details className="resource-assessment-details resource-assessment-disclosure"><summary><CircleHelp size={14}/>{t('查看分项与依据', 'View details and evidence')}</summary>
        {assessmentContent}
        {!desktop ? <p>{t('需要桌面后台检查磁盘空间。', 'The desktop backend is needed to check disk space.')}</p>
          : <><SetupDiskStatus data={diskPending || diskError ? undefined : disk} pending={diskPending} error={diskError} onRefresh={onRefreshDisk ?? (() => {})}/>{diskStatus === 'unchecked' && <p>{t('磁盘空间尚未检查。', 'Disk space has not been checked yet.')}</p>}</>}
      </details>
    </> : assessmentContent}
  </section>;
}
