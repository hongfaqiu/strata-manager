import { useId, useState } from 'react';
import { ChevronDown, Cpu, Gauge, MemoryStick } from 'lucide-react';
import { asObject, normalizeMetrics, runtimeSlots, type JsonObject } from '@strata-manager/core';
import './api-usage-live.css';

export interface ApiUsageLiveProps {
  language: 'zh-CN' | 'en';
  raw?: JsonObject;
  sampledAt?: number;
  stale?: boolean;
  stopped?: boolean;
  serviceId?: string;
}

const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const ratio = (used: unknown, total: unknown): number | null => {
  const a = numeric(used), b = numeric(total);
  return a !== null && b !== null && b > 0 ? Math.min(100, a / b * 100) : null;
};
const gib = (value: number | null) => value === null ? null : value / 2 ** 30;

/** The engine supplies short sample arrays, without timestamps. Keep gaps and sample order. */
function resourcePaths(samples: (number | null)[], fixedMax?: number | null) {
  const valid = samples.flatMap(value => value === null ? [] : [value]);
  const max = Math.max(fixedMax ?? 0, ...valid, 1);
  const segments: { x: number; y: number }[][] = [];
  let segment: { x: number; y: number }[] = [];
  samples.forEach((value, index) => {
    if (value === null) { if (segment.length) segments.push(segment); segment = []; return; }
    segment.push({ x: samples.length === 1 ? 300 : index / (samples.length - 1) * 300, y: 58 - value / max * 50 });
  });
  if (segment.length) segments.push(segment);
  return segments.map(points => {
    const line = points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join('');
    return { line, area: `${line}L${points.at(-1)!.x.toFixed(2)},60L${points[0]!.x.toFixed(2)},60Z`, points };
  });
}

export function ApiUsageLive({ language, raw, sampledAt, stale = false, stopped = false, serviceId }: ApiUsageLiveProps) {
  const [expanded, setExpanded] = useState(true), contentId = useId();
  const t = (cn: string, en: string) => language === 'zh-CN' ? cn : en;
  const unavailable = stopped || stale || !raw || Object.keys(raw).length === 0;
  // Never present a cached snapshot as the current resource use of a stopped/offline service.
  const current = unavailable ? {} : raw!, metrics = normalizeMetrics(current), live = asObject(current.live);
  const slots = runtimeSlots(current), rawSlots = Array.isArray(live.slots) ? live.slots.map(asObject) : [];
  const fmt = (value: unknown, digits = 0) => { const n = numeric(value); return n === null ? '–' : n.toLocaleString(language, { maximumFractionDigits: digits }); };
  const states: Record<string, string> = {
    idle: t('空闲', 'Idle'), reading: t('处理输入', 'Prefill'), decoding: t('生成中', 'Generating'),
    generating: t('生成中', 'Generating'), unloaded: t('模型未加载', 'Model unloaded'), unknown: t('未知', 'Unknown'),
  };
  const status = stopped ? t('未启动', 'Not started') : unavailable ? t('不可用', 'Unavailable') : states[metrics.state] ?? t('实时采样', 'Live sample');
  const memory = (used: number | null, total: number | null) => total !== null && total > 0 ? `${fmt(gib(used), 1)} / ${fmt(gib(total), 1)} GiB` : `${fmt(gib(used), 1)} GiB`;
  const series = (name: string, bytes = false) => (metrics.history[name] ?? []).map(value => { const n = numeric(value); return bytes ? gib(n) : n; });
  const resources = [
    { key: 'cpu', label: t('CPU 使用率', 'CPU utilization'), value: `${fmt(metrics.cpuUtil, 1)}%`, samples: series('cpu'), max: 100, tone: 'green', icon: Cpu },
    { key: 'gpu', label: t('GPU 负载', 'GPU utilization'), value: `${fmt(metrics.gpuUtil, 1)}%`, samples: series('gpu_util'), max: 100, tone: 'blue', icon: Gauge },
    { key: 'ram', label: t('系统内存', 'System RAM'), value: memory(metrics.ramUsed, metrics.ramTotal), samples: series('ram_used', true), max: gib(metrics.ramTotal), tone: 'gold', icon: MemoryStick },
    { key: 'vram', label: t('GPU 显存', 'GPU memory'), value: memory(metrics.gpuMemoryUsed, metrics.gpuMemoryTotal), samples: series('gpu_mem_used', true), max: gib(metrics.gpuMemoryTotal), tone: 'violet', icon: MemoryStick },
  ];
  const prefill = (record: JsonObject) => {
    const percent = ratio(record.prompt_read, record.prompt_total);
    return percent === null ? null : { percent, read: numeric(record.prompt_read), total: numeric(record.prompt_total) };
  };
  const currentPrefill = metrics.state === 'reading' ? prefill(live) : null;
  const summaryLabel = stopped ? t('服务未启动，实时数据不可用。', 'The service is not started; live data is unavailable.')
    : stale ? t('上次采样已过期，实时数据不可用。', 'The last sample is stale; live data is unavailable.')
      : unavailable ? t('尚无当前服务的实时采样。', 'No live sample is available for this service.')
        : sampledAt && Number.isFinite(sampledAt) ? `${t('采样于', 'Sampled at')} ${new Date(sampledAt).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : t('采样时间未提供', 'Sample time unavailable');

  return <section className="api-live-resources" data-service-id={serviceId} aria-label={t('当前服务实时负载', 'Current service resources')}>
    <button type="button" className="api-live-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>
      <span className="api-live-heading"><strong>{t('实时资源与并行任务', 'Live resources and slots')}</strong><span>{t('当前服务的短时采样 · 独立于上方 API 历史时间范围', 'Short samples for this service · separate from the API history range')}</span></span>
      <span className={`api-live-state${unavailable ? ' unavailable' : ''}`}>{status}</span><ChevronDown size={15} className={expanded ? 'expanded' : ''} aria-hidden="true" />
    </button>
    {expanded && <div id={contentId} className="api-live-content">
      <div className="api-live-meta"><span role="status">{summaryLabel}</span>{!unavailable && <span>{t('处理中', 'Running')} {fmt(live.running)} · {t('等待中', 'Waiting')} {fmt(live.waiting ?? live.queued)}</span>}</div>
      <div className="api-live-grid">{resources.map(resource => {
        const paths = resourcePaths(resource.samples, resource.max), count = resource.samples.filter(value => value !== null).length;
        return <article key={resource.key} className={`api-live-resource ${resource.tone}`}>
          <div className="api-live-resource-head"><span><resource.icon size={13} aria-hidden="true" />{resource.label}</span><strong>{unavailable || resource.value.startsWith('–') ? '–' : resource.value}</strong></div>
          <div className="api-live-spark">{count ? <svg viewBox="0 0 300 64" preserveAspectRatio="none" role="img" aria-label={`${resource.label} · ${t('按采样顺序的短时趋势', 'short trend in sample order')}`}>
            <path className="api-live-spark-grid" d="M0 10H300M0 35H300M0 60H300" />
            {paths.map((path, index) => <g key={index}>{path.points.length > 1 ? <><path className="api-live-spark-area" d={path.area} /><path className="api-live-spark-line" d={path.line} /></> : <circle cx={path.points[0]!.x} cy={path.points[0]!.y} r={2} />}</g>)}
          </svg> : <span className="api-live-empty-trend">{unavailable ? t('不可用', 'Unavailable') : t('尚无短时趋势', 'No short trend yet')}</span>}</div>
          <div className="api-live-spark-axis"><span>{t('更早', 'Earlier')}</span><span>{count ? `${fmt(count)} ${t('个有效样本', 'valid samples')}` : '–'}</span><span>{t('最近', 'Latest')}</span></div>
        </article>;
      })}</div>
      <div className="api-live-slots">
        <div className="api-live-slots-head"><strong>{t('槽位输入处理与上下文', 'Slot prefill and context')}</strong><span>{t('缺失的逐槽进度显示为未提供', 'Missing per-slot progress is shown as unavailable')}</span></div>
        {unavailable ? <p className="api-live-slots-empty">{stopped ? t('未启动', 'Not started') : t('实时槽位数据不可用。', 'Live slot data is unavailable.')}</p>
          : slots && slots.length ? <div className="api-live-slot-scroll"><table><thead><tr><th>{t('槽位', 'Slot')}</th><th>{t('状态', 'State')}</th><th>{t('输入处理进度', 'Prefill progress')}</th><th>{t('上下文长度 / 容量', 'Context length / capacity')}</th><th>{t('生成速度', 'Generation speed')}</th></tr></thead><tbody>{slots.map(slot => {
            const source = rawSlots.find(record => record.slot === slot.id) ?? {}, progress = slot.state === 'reading' ? prefill(source) : null;
            const usedPercent = ratio(slot.usedContext, slot.context);
            return <tr key={slot.id}><td>{slot.id}</td><td><span className={`api-live-slot-state ${slot.state}`}>{states[slot.state] ?? slot.state}</span></td><td>{progress ? <><span>{fmt(progress.percent, 1)}% · {fmt(progress.read)} / {fmt(progress.total)}</span><div className="api-live-progress" role="progressbar" aria-label={`${t('槽位', 'Slot')} ${slot.id} ${t('输入处理进度', 'prefill')}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}><i style={{ width: `${progress.percent}%` }} /></div></> : slot.state === 'reading' ? t('未提供', 'Unavailable') : '–'}</td><td><span>{fmt(slot.usedContext)} / {fmt(slot.context)}</span>{usedPercent !== null && <div className="api-live-progress context" role="progressbar" aria-label={`${t('槽位', 'Slot')} ${slot.id} ${t('上下文占用', 'context usage')}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={usedPercent}><i style={{ width: `${usedPercent}%` }} /></div>}</td><td>{numeric(slot.tokS) === null ? '–' : `${fmt(slot.tokS, 1)} tok/s`}</td></tr>;
          })}</tbody></table></div>
            : <p className="api-live-slots-empty">{t('引擎尚未提供逐槽指标。', 'The engine has not supplied per-slot metrics.')}{currentPrefill && <span className="api-live-solo-prefill">{t('当前请求输入处理', 'Current request prefill')} {fmt(currentPrefill.percent, 1)}% · {fmt(currentPrefill.read)} / {fmt(currentPrefill.total)} tokens</span>}</p>}
      </div>
    </div>}
  </section>;
}
