// D2 lead visuals that sit above existing page content. They add information; they never replace controls.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import type { EnvironmentInfo, TaskStatus } from '@strata-manager/core';
import { D2Glyph, D2Ring, D2Ticks, D2Timeline, gib, type HardwareReading } from './D2Visuals';
import { catalogRequirement, fitState, toGB } from './d2Estimates';

const ratio = (used?: number, total?: number) => used !== undefined && total ? used / total * 100 : undefined;
const gbText = (gb?: number, digits = 0) => gb === undefined ? '–' : gb.toLocaleString(undefined, { maximumFractionDigits: digits });

export function machineMemoryGB(hardware: HardwareReading, environment?: EnvironmentInfo) {
  return toGB(hardware.ramTotal) ?? (environment?.totalMemory ? environment.totalMemory / 1024 ** 3 : undefined);
}

function VramRing({ hardware, size = 104 }: { hardware: HardwareReading; size?: number }) {
  const { t } = useTranslation();
  const value = ratio(hardware.vramUsed, hardware.vramTotal);
  const experts = ratio(hardware.expertBytes, hardware.vramTotal);
  const parts = value === undefined ? [] : experts !== undefined && experts <= value ? [{ value: experts, tone: 'expert' as const }, { value: value - experts, tone: 'model' as const }] : [{ value, tone: 'expert' as const }];
  return <D2Ring size={size} empty={value === undefined} parts={parts} value={value === undefined ? t('d2Unmeasured') : gib(hardware.vramUsed)} unit={value === undefined ? undefined : `/ ${gib(hardware.vramTotal, 0)} GB`} label={t('d2Vram')}/>;
}
function RamRing({ hardware, environment, size = 104 }: { hardware: HardwareReading; environment?: EnvironmentInfo; size?: number }) {
  const { t } = useTranslation();
  const total = hardware.ramTotal ?? environment?.totalMemory;
  const used = hardware.ramUsed ?? (environment ? environment.totalMemory - environment.availableMemory : undefined);
  const value = ratio(used, total);
  return <D2Ring size={size} empty={value === undefined} parts={value === undefined ? [] : [{ value, tone: 'ram' }]} value={value === undefined ? t('d2Unmeasured') : gib(used)} unit={value === undefined ? undefined : `/ ${gib(total, 0)} GB`} label={t('d2Ram')}/>;
}

/** 我的模型: capacity rings plus a facts strip. */
export function ModelsLead({ hardware, environment, models, configurations, current, online }: { hardware: HardwareReading; environment?: EnvironmentInfo; models: number; configurations: number; current?: string; online: boolean }) {
  const { t } = useTranslation();
  const ram = machineMemoryGB(hardware, environment);
  const free = hardware.ramTotal !== undefined && hardware.ramUsed !== undefined ? toGB(hardware.ramTotal - hardware.ramUsed) : environment ? environment.availableMemory / 1024 ** 3 : undefined;
  const gpu = hardware.gpuName ?? environment?.gpus[0];
  return <section className="d2-lead st-card" data-testid="d2-models-lead" aria-label={t('d2Capacity')}>
    <div className="d2-lead-rings"><VramRing hardware={hardware}/><RamRing hardware={hardware} environment={environment}/></div>
    <dl className="d2-facts">
      <div><dt>{t('d2Capacity')}</dt><dd>{gpu ? <>{gpu}{hardware.vramTotal ? ` · ${gib(hardware.vramTotal, 0)} GB` : ''}</> : t('d2Unmeasured')}</dd><dd className="d2-sub">{t('d2Ram')} {gbText(ram)} GB{free !== undefined ? ` · ${t('d2Free', { gb: gbText(free, 1) })}` : ''}</dd></div>
      <div><dt>{t('d2Local')}</dt><dd>{t('d2ModelsN', { count: models })}</dd><dd className="d2-sub">{t('d2ConfigsN', { count: configurations })}</dd></div>
      <div><dt>{t('d2Current')}</dt><dd className="d2-ellipsis" data-tooltip={current}>{current ?? '—'}</dd><dd className="d2-sub">{online ? t('d2Running') : t('ovStopped')}</dd></div>
    </dl>
    {!online && <p className="d2-lead-note">{t('d2NoLive')}</p>}
  </section>;
}

/** Per configuration: catalog memory requirement as a tick meter against machine memory. */
export function RequirementMeter({ label, machineGB }: { label?: string; machineGB?: number }) {
  const { t } = useTranslation();
  const requirement = catalogRequirement(label);
  if (!requirement) return <p className="d2-req is-unknown">{t('d2ReqLabel')} <span>{t('d2Unmeasured')}</span></p>;
  const fit = fitState(requirement.ramGB, machineGB);
  return <p className={`d2-req is-${fit ?? 'unknown'}`}>
    <span>{t('d2NeedRam', { gb: requirement.ramGB })}</span>
    {machineGB ? <D2Ticks value={Math.min(100, requirement.ramGB / machineGB * 100)} label={t('d2NeedRam', { gb: requirement.ramGB })}/> : null}
    <small>{machineGB ? t('d2OfMachine', { gb: gbText(machineGB) }) : t('d2Unmeasured')} · {requirement.quant} · {t('d2Download', { gb: requirement.downloadGB })}</small>
  </p>;
}

/** 运行配置: resource estimate from catalog + live VRAM. Labelled as an estimate, never as a measurement. */
export function ConfigEstimate({ hardware, environment, label, online }: { hardware: HardwareReading; environment?: EnvironmentInfo; label?: string; online: boolean }) {
  const { t } = useTranslation();
  const machine = machineMemoryGB(hardware, environment);
  const requirement = catalogRequirement(label);
  const ramValue = requirement && machine ? requirement.ramGB / machine * 100 : undefined;
  const fit = requirement ? fitState(requirement.ramGB, machine) : undefined;
  return <section className="d2-lead st-card d2-estimate" data-testid="d2-config-estimate" aria-label={t('d2EstTitle')}>
    <div className="d2-lead-rings">
      <D2Ring empty={ramValue === undefined} parts={ramValue === undefined ? [] : [{ value: Math.min(100, ramValue), tone: fit === 'over' ? 'warn' : 'ram' }]} threshold={80} value={requirement ? `~${requirement.ramGB}` : t('d2Unmeasured')} unit={requirement ? `/ ${gbText(machine)} GB` : undefined} label={t('d2EstModel')}/>
      <VramRing hardware={hardware}/>
    </div>
    <div className="d2-estimate-text">
      <strong>{t('d2EstTitle')}</strong>
      <p>{requirement ? `${requirement.name} · ${requirement.quant}` : t('d2EstUnknown')}</p>
      {fit && <p className={`d2-fit is-${fit}`}>{t(`d2Fit_${fit}`)}</p>}
      <small>{t('d2EstHint')}{!online ? ` ${t('d2NoLive')}` : ''}</small>
    </div>
  </section>;
}

/** 运行环境: device strip with glyphs. */
export function EnvironmentDevices({ hardware, environment }: { hardware: HardwareReading; environment?: EnvironmentInfo }) {
  const { t } = useTranslation();
  const ram = machineMemoryGB(hardware, environment);
  const used = toGB(hardware.ramUsed) ?? (environment ? (environment.totalMemory - environment.availableMemory) / 1024 ** 3 : undefined);
  const gpus = environment?.gpus.length ? environment.gpus : hardware.gpuName ? [hardware.gpuName] : [];
  return <section className="d2-devices st-card" data-testid="d2-environment-devices" aria-label={t('d2Devices')}>
    <div><D2Glyph kind="cpu"/><span><small>{t('d2Cpu')}</small><strong>{environment?.cpuName || t('d2Unmeasured')}</strong><em>{environment ? `${environment.os} · ${environment.arch}` : ''}{hardware.cores ? ` · ${hardware.cores}C/${hardware.threads ?? '?'}T` : ''}</em></span></div>
    <div><D2Glyph kind="ram"/><span><small>{t('d2Ram')}</small><strong>{ram ? `${gbText(ram)} GB` : t('d2Unmeasured')}</strong><em>{used !== undefined ? t('d2Used', { gb: gbText(used, 1) }) : ''}</em></span></div>
    <span className="d2-bus" aria-hidden="true"><i/>{hardware.pcie && <small>{hardware.pcie}</small>}</span>
    <div><D2Glyph kind="gpu"/><span><small>{t('d2Gpu')}</small><strong>{gpus[0] ?? t('d2Unmeasured')}</strong><em>{hardware.vramTotal ? `${gib(hardware.vramTotal, 0)} GB` : ''}{gpus.length > 1 ? ` · +${gpus.length - 1}` : ''}</em></span></div>
  </section>;
}

/** 任务与日志: today's timeline. Clicking a dot selects that task's logs. */
export function TasksTimeline({ tasks, onSelect, selected, now = Date.now() }: { tasks: TaskStatus[]; onSelect: (task: TaskStatus) => void; selected?: string; now?: number }) {
  const { t } = useTranslation();
  const today = tasks.filter(task => Number(task.startedAt) >= now - 24 * 3600_000);
  const failed = today.filter(task => task.state === 'failed').length;
  const first = today.length ? Math.min(...today.map(task => Number(task.startedAt))) : now - 3600_000;
  const start = Math.min(first - 600_000, now - 3600_000);
  const fmt = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return <section className="d2-tasks-timeline" data-testid="d2-tasks-timeline" aria-label={t('d2TasksToday', { count: today.length, failed })}>
    <header><strong>{t('d2TasksToday', { count: today.length, failed })}</strong>{!today.length && <span>{t('d2NoTasksToday')}</span>}</header>
    <D2Timeline start={start} end={now} startLabel={fmt(start)} middleLabel={fmt((start + now) / 2)} endLabel={t('d2Now')} points={today.map(task => ({ at: Number(task.startedAt), tone: task.state === 'failed' ? 'bad' : task.state === 'running' ? 'run' : task.state === 'cancelled' ? 'off' : 'ok', label: `${fmt(Number(task.startedAt))} · ${task.message || task.kind}`, active: task.id === selected, onSelect: () => onSelect(task) }))}/>
  </section>;
}

/** 显存与会话: one VRAM bar (the only stacked bar kept in D2) with a reserve mark. */
export function VramReserveBar({ hardware, reserveGB }: { hardware: HardwareReading; reserveGB?: number }) {
  const { t } = useTranslation();
  const total = hardware.vramTotal;
  if (!total || hardware.vramUsed === undefined) return <section className="d2-vram st-card is-empty" data-testid="d2-vram-bar"><strong>{t('d2Vram')}</strong><span>{t('d2NoLive')}</span></section>;
  const experts = Math.min(hardware.expertBytes ?? 0, hardware.vramUsed);
  const reserveMark = reserveGB !== undefined ? Math.max(0, 100 - reserveGB * 1024 ** 3 / total * 100) : undefined;
  return <section className="d2-vram st-card" data-testid="d2-vram-bar" aria-label={t('d2Vram')}>
    <header><strong className="d2-num">{gib(hardware.vramUsed)} <small>/ {gib(total, 0)} GB</small></strong><span><i className="t-expert"/>{t('ovExperts')} {gib(experts)} GB</span><span><i className="t-model"/>{t('ovModelRuntime')} {gib(hardware.vramUsed - experts)} GB</span></header>
    <div className="d2-vram-bar"><i className="t-expert" style={{ width: `${experts / total * 100}%` }}/><i className="t-model" style={{ width: `${(hardware.vramUsed - experts) / total * 100}%` }}/>{reserveMark !== undefined && <span className="d2-vram-reserve" style={{ left: `${reserveMark}%` }}/>}</div>
    {reserveGB !== undefined && <small>{t('d2ReserveHint', { gb: reserveGB })}</small>}
  </section>;
}

/** API 与外部助手: the endpoint as the page's focal point, with copy. */
export function EndpointHero({ url, model, online }: { url?: string; model?: string; online: boolean }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const endpoint = url ? `${url.replace(/\/+$/, '')}/v1` : undefined;
  const copy = () => { if (!endpoint) return; void navigator.clipboard?.writeText(endpoint).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }).catch(() => undefined); };
  return <section className="d2-endpoint st-card" data-testid="d2-endpoint">
    <small>{t('d2Endpoint')}</small>
    <div><code className="d2-num">{endpoint ?? '—'}</code><button type="button" onClick={copy} disabled={!endpoint}>{copied ? <Check size={14}/> : <Copy size={14}/>}{copied ? t('ovCopied') : t('ovCopyApi')}</button></div>
    <p><span className={`d2-dot ${online ? 'is-on' : ''}`}/>{online ? t('d2EndpointOnline') : t('d2EndpointOffline')}{model ? ` · ${model}` : ''}</p>
  </section>;
}

/** 参数调优: candidate gains on one axis, zero = current parameters. */
export function GainDotPlot({ points, label }: { points: { id: string; gain?: number | null; recommended?: boolean; accepted?: boolean }[]; label: string }) {
  const { t } = useTranslation();
  const measured = points.filter(point => typeof point.gain === 'number') as { id: string; gain: number; recommended?: boolean; accepted?: boolean }[];
  if (!measured.length) return <p className="d2-gain is-empty">{label} · {t('d2Unmeasured')}</p>;
  const min = Math.min(-0.05, ...measured.map(point => point.gain)), max = Math.max(0.1, ...measured.map(point => point.gain));
  const x = (value: number) => (value - min) / (max - min) * 100;
  return <figure className="d2-gain" data-testid="d2-gain-plot" aria-label={label}>
    <figcaption>{label}</figcaption>
    <div className="d2-gain-axis"><span className="d2-gain-zero" style={{ left: `${x(0)}%` }}><small>{t('d2Baseline')}</small></span>
      {measured.map(point => <span key={point.id} className={`d2-gain-dot${point.recommended ? ' is-best' : ''}${point.accepted === false ? ' is-rejected' : ''}`} style={{ left: `${x(point.gain)}%` }} data-tooltip={`${point.id} · ${(point.gain * 100).toFixed(1)}%`}><i/><small>{point.id}</small></span>)}
    </div>
    <div className="d2-gain-scale"><span>{(min * 100).toFixed(0)}%</span><span>+{(max * 100).toFixed(0)}%</span></div>
  </figure>;
}

/** Benchmark: tiers on a log axis, selected tiers filled, model limit dashed. */
export function TierAxis({ tiers, selected, limit, name }: { tiers: number[]; selected: number[]; limit?: number; name: (tier: number) => string }) {
  const { t } = useTranslation();
  if (!tiers.length) return null;
  const lo = Math.log2(tiers[0]!), hi = Math.log2(Math.max(tiers.at(-1)!, limit ?? 0));
  const x = (value: number) => hi === lo ? 50 : (Math.log2(value) - lo) / (hi - lo) * 100;
  return <div className="d2-tier-axis" data-testid="d2-tier-axis" role="img" aria-label={t('d2TierAxis', { count: selected.length })}>
    <span className="d2-tier-line"/>
    {limit && <span className="d2-tier-limit" style={{ left: `${x(limit)}%` }}><small>{t('d2Limit')} {name(limit)}</small></span>}
    {tiers.map(tier => <span key={tier} className={`d2-tier${selected.includes(tier) ? ' is-on' : ''}`} style={{ left: `${x(tier)}%` }}><i/><small>{name(tier)}</small></span>)}
  </div>;
}
